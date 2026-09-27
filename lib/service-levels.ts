/**
 * Item 9 (re-benchmark, 2026-09-24): "no SLOs, no dashboard — nobody can say
 * what 'working' means until a user complains".
 *
 * The service levels, their targets, and the arithmetic that turns stored runs and
 * decisions into a verdict. Pure: no database, no clock of its own (every function
 * takes `now`), so the numbers on the Service status page (app/(app)/status) are
 * pinned by unit tests, and docs/SERVICE-LEVELS.md is checked against SLOS by
 * tests/unit/service-levels.test.ts so the written targets cannot drift from the
 * ones the page measures against.
 *
 * Two kinds of objective:
 *   ratio    — a share of events over a rolling window, with an error budget:
 *              "99.5% of probe slots answered". Measured from rows that exist
 *              only since 2026-09-27 (CronRun, the EditApproval snapshot), so each
 *              window starts at the first measurement and says so.
 *   current  — a threshold on the state right now: "nothing waiting for the
 *              Temix upload longer than 7 days".
 */

export type SloId = 'availability' | 'approvals' | 'sla-sweep' | 'backup' | 'temix-backlog' | 'imports';

export type SloDefinition = {
  id: SloId;
  title: string;
  kind: 'ratio' | 'current';
  /** Ratio SLOs: the share that must be good. */
  target?: number;
  /** Ratio SLOs: the rolling window. */
  windowDays?: number;
  /** The target as a person reads it. */
  targetLabel: string;
  /** One sentence: what is measured, from what. */
  measures: string;
};

export const SLOS: readonly SloDefinition[] = [
  {
    id: 'availability',
    title: 'The app answers',
    kind: 'ratio',
    target: 0.995,
    windowDays: 30,
    targetLabel: '99.5% of slots, 30 days',
    measures:
      'Share of 4-minute slots between 07:00 and 19:00 Oman in which the keep-warm probe reached the app and its database.',
  },
  {
    id: 'approvals',
    title: 'Approvals decided within their SLA',
    kind: 'ratio',
    target: 0.9,
    windowDays: 30,
    targetLabel: '90% of decisions, 30 days',
    measures:
      'Share of approval steps approved or sent back before the step was due, on the Sun–Thu 08:00–17:00 working calendar.',
  },
  {
    id: 'sla-sweep',
    title: 'The SLA escalation sweep runs',
    kind: 'ratio',
    target: 0.95,
    windowDays: 30,
    targetLabel: '95% of half-hours, 30 days',
    measures: 'Share of half-hour slots between 07:15 and 18:45 Oman in which the sweep ran successfully.',
  },
  {
    id: 'backup',
    title: 'A backup every night',
    kind: 'ratio',
    target: 29 / 30,
    windowDays: 30,
    targetLabel: '29 of every 30 days',
    measures: 'Share of days (UTC) with a successful off-Neon database dump — at most one missed night in 30.',
  },
  {
    id: 'temix-backlog',
    title: 'The ERP hand-off is current',
    kind: 'current',
    targetLabel: 'Nothing waiting over 7 days',
    measures: 'Nothing waiting for the Temix upload for more than 7 days.',
  },
  {
    id: 'imports',
    title: 'No import is stuck',
    kind: 'current',
    targetLabel: 'Nothing stuck',
    measures:
      'No customer-master promote left interrupted for more than an hour, and no upload still being read after 10 minutes.',
  },
] as const;

/**
 * Who may open the Service status page: the Data Steward and the Managers. It
 * shows company-wide counts only (lib/service-status.ts), which is why a
 * region-scoped Manager may see it. The nav (components/nmwc/Sidebar.tsx) must
 * offer the page to exactly these roles; tests/unit/status-page.test.tsx pins it.
 */
export const STATUS_ROLES: readonly string[] = ['STEWARD', 'MANAGER'];

export function sloById(id: SloId): SloDefinition {
  const s = SLOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown SLO ${id}`);
  return s;
}

/** Current-state thresholds, named once. */
export const TEMIX_BACKLOG_MAX_DAYS = 7;
export const PROMOTE_STUCK_AFTER_MIN = 60;
export const PARSING_STUCK_AFTER_MIN = 10;

// ── Verdicts ──────────────────────────────────────────────────────────────

export type SloStatus = 'met' | 'at-risk' | 'breached' | 'no-data';

/** Below this share of the error budget left, a met objective is "at risk". */
export const AT_RISK_BUDGET_LEFT = 0.25;

export type RatioResult = {
  good: number;
  total: number;
  /** good / total, or null with no events. */
  ratio: number | null;
  /** Share of the error budget still unspent (can go negative), or null with no events. */
  budgetLeft: number | null;
  status: SloStatus;
};

export function ratioVerdict(good: number, total: number, target: number): RatioResult {
  if (total <= 0) return { good, total, ratio: null, budgetLeft: null, status: 'no-data' };
  const ratio = good / total;
  const allowedBad = (1 - target) * total;
  const bad = total - good;
  // A 100% target has no budget: any bad event spends all of it.
  const budgetLeft = allowedBad > 0 ? 1 - bad / allowedBad : bad === 0 ? 1 : -Infinity;
  const status: SloStatus =
    ratio < target ? 'breached' : budgetLeft < AT_RISK_BUDGET_LEFT ? 'at-risk' : 'met';
  return { good, total, ratio, budgetLeft, status };
}

// ── Windows ───────────────────────────────────────────────────────────────

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * The measured window: the last `windowDays`, but never earlier than the first
 * stored measurement — slots before the table existed are not outages.
 */
export function windowStart(now: Date, windowDays: number, firstMeasuredAt: Date | null): Date | null {
  if (!firstMeasuredAt) return null;
  const nominal = now.getTime() - windowDays * DAY;
  return new Date(Math.max(nominal, firstMeasuredAt.getTime()));
}

/**
 * Slot starts of `stepMin` minutes whose UTC hour lies in [fromHour, toHour),
 * aligned to the hour, covering [from, now) — the slot in progress is excluded,
 * because its probe may simply not have run yet. Slots are included only when
 * they START at or after `from` rounded down to the slot, so the first partial
 * slot counts.
 */
export function slotStarts(
  from: Date,
  now: Date,
  stepMin: number,
  hoursUtc: [number, number],
  offsetMin = 0
): number[] {
  const step = stepMin * MIN;
  const offset = offsetMin * MIN;
  const out: number[] = [];
  // Align to the step grid anchored at the hour (+ offset).
  let t = Math.floor((from.getTime() - offset) / step) * step + offset;
  const lastComplete = now.getTime() - step;
  for (; t <= lastComplete; t += step) {
    const h = new Date(t).getUTCHours();
    if (h >= hoursUtc[0] && h < hoursUtc[1]) out.push(t);
  }
  return out;
}

export type RunSample = { at: Date; ok: boolean };

export type SlotResult = RatioResult & {
  /** Slots with a successful run. */
  okSlots: number;
  /** Slots with runs, none successful. */
  failedSlots: number;
  /** Slots with no run at all: the app was down, or no scheduler called. */
  silentSlots: number;
};

/**
 * Each expected slot is good when at least one run STARTED inside it succeeded.
 * A slot with no run counts against the objective: when the app or its database
 * is down, the probe cannot write a row, so an outage looks exactly like
 * silence. Several schedulers calling the same slot count once.
 */
export function slotAttainment(
  runs: RunSample[],
  slots: number[],
  stepMin: number,
  target: number
): SlotResult {
  const step = stepMin * MIN;
  const index = new Map<number, 'ok' | 'failed'>();
  const first = slots[0];
  for (const r of runs) {
    if (first === undefined) break;
    const t = r.at.getTime();
    const slot = first + Math.floor((t - first) / step) * step;
    if (index.get(slot) === 'ok') continue;
    index.set(slot, r.ok ? 'ok' : 'failed');
  }
  let okSlots = 0;
  let failedSlots = 0;
  for (const s of slots) {
    const v = index.get(s);
    if (v === 'ok') okSlots += 1;
    else if (v === 'failed') failedSlots += 1;
  }
  const silentSlots = slots.length - okSlots - failedSlots;
  return { ...ratioVerdict(okSlots, slots.length, target), okSlots, failedSlots, silentSlots };
}

/** Keep-warm: every 4 minutes, 03:00–14:59 UTC (07:00–18:59 Oman). */
export function availabilityResult(runs: RunSample[], from: Date | null, now: Date): SlotResult {
  const target = sloById('availability').target!;
  if (!from) return { ...ratioVerdict(0, 0, target), okSlots: 0, failedSlots: 0, silentSlots: 0 };
  return slotAttainment(runs, slotStarts(from, now, 4, [3, 15]), 4, target);
}

/** The SLA sweep: at :15 and :45, 03:15–14:45 UTC — one half-hour slot each. */
export function slaSweepResult(runs: RunSample[], from: Date | null, now: Date): SlotResult {
  const target = sloById('sla-sweep').target!;
  if (!from) return { ...ratioVerdict(0, 0, target), okSlots: 0, failedSlots: 0, silentSlots: 0 };
  return slotAttainment(runs, slotStarts(from, now, 30, [3, 15], 15), 30, target);
}

/**
 * The nightly dump, by UTC day. GitHub starts the 02:00 UTC schedule anywhere up
 * to 13:00 UTC (lib/heartbeat.ts), always inside the same UTC day, so "a
 * successful dump that day" is the honest unit. Today is excluded: its dump may
 * not have started yet.
 */
export function backupResult(runs: RunSample[], from: Date | null, now: Date): RatioResult & { missedDays: number } {
  const target = sloById('backup').target!;
  if (!from) return { ...ratioVerdict(0, 0, target), missedDays: 0 };
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const days: number[] = [];
  for (let d = Math.floor(from.getTime() / DAY) * DAY; d < today; d += DAY) days.push(d);
  const okDays = new Set(runs.filter((r) => r.ok).map((r) => Math.floor(r.at.getTime() / DAY) * DAY));
  const good = days.filter((d) => okDays.has(d)).length;
  return { ...ratioVerdict(good, days.length, target), missedDays: days.length - good };
}

// ── Approvals ─────────────────────────────────────────────────────────────

export type TierDecisions = {
  /** The step's role (EditApproval.role), or MANAGER for reactivations. */
  role: string;
  /** Decisions in the window. */
  decided: number;
  /** Of those, how many carry the snapshot (decided on or after 2026-09-27). */
  tracked: number;
  /** Of the tracked, decided at or before the step's due time. */
  within: number;
  p50Minutes: number | null;
  p90Minutes: number | null;
};

export function approvalsResult(tiers: TierDecisions[]): RatioResult & { untracked: number } {
  const target = sloById('approvals').target!;
  const tracked = tiers.reduce((n, t) => n + t.tracked, 0);
  const within = tiers.reduce((n, t) => n + t.within, 0);
  const decided = tiers.reduce((n, t) => n + t.decided, 0);
  return { ...ratioVerdict(within, tracked, target), untracked: decided - tracked };
}

// ── Current-state objectives ──────────────────────────────────────────────

export function temixBacklogStatus(oldestWaitingSince: Date | null, now: Date): SloStatus {
  if (!oldestWaitingSince) return 'met';
  return now.getTime() - oldestWaitingSince.getTime() > TEMIX_BACKLOG_MAX_DAYS * DAY ? 'breached' : 'met';
}

export function importsStatus(stuckPromotes: number, stuckUploads: number): SloStatus {
  return stuckPromotes + stuckUploads > 0 ? 'breached' : 'met';
}

/** "3 h 20 m" / "45 m" / "2 d 4 h" — ages on the page. */
export function formatAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Working minutes as the approvals queue shows them: "5 h 10 m" of working time. */
export function formatWorkingMinutes(min: number | null): string {
  if (min === null) return '—';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

export function formatPct(ratio: number | null, digits = 1): string {
  if (ratio === null) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}
