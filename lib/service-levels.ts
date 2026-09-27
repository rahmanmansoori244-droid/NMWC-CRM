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
      'No customer-master promote interrupted and waiting to be resumed, none stalled for more than an hour, and no upload in the last day still being read after 10 minutes.',
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
/** A promote whose lease ran out without being released: given this long before it counts. */
export const PROMOTE_STUCK_AFTER_MIN = 60;
export const PARSING_STUCK_AFTER_MIN = 10;
/**
 * A dead upload (a batch left PARSING when its request died) has no in-app way
 * out: nothing reads it, and re-uploading creates a new batch. It is counted for a
 * day, long enough to be seen and re-uploaded, and then stops counting, so one
 * timeout cannot hold the objective at Missed for ever (review, 2026-09-27).
 */
export const PARSING_LOOKBACK_HOURS = 24;

/** Keep-warm slots in a day (every 4 minutes, 03:00–14:59 UTC) and sweep half-hours. */
export const PROBE_SLOTS_PER_DAY = 180;
export const SWEEP_SLOTS_PER_DAY = 24;

/**
 * Per-tier detail (on-time share, median, open queue) is shown to a Manager only
 * for a tier at least this many people decide or hold. The General Manager and
 * the Finance Manager steps each have one holder, so their tier figures ARE one
 * named colleague's decision speed (PII-INVENTORY: EditApproval.workingMinutes is
 * "how long this named person took"). A Manager sees those folded into "other
 * steps"; the Data Steward sees every tier (review, 2026-09-27).
 */
export const MIN_PEOPLE_FOR_TIER_DETAIL = 3;

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

/**
 * `fullWindowTotal`: how many events a full window holds, when that is known in
 * advance (slots, days). The budget is the allowance of the WHOLE window: while
 * fewer than 30 days have been measured, a miss is judged against what the
 * written objective allows in 30 days ("at most one missed night in 30"), not
 * against a budget shrunk to the days seen so far, which turned one early miss
 * into weeks of "Missed" (review, 2026-09-27). Approvals have no fixed count and
 * are judged on the decisions made.
 */
export function ratioVerdict(good: number, total: number, target: number, fullWindowTotal = 0): RatioResult {
  if (total <= 0) return { good, total, ratio: null, budgetLeft: null, status: 'no-data' };
  const ratio = good / total;
  // Rounded once, and used for both the verdict and the budget: (1 - 0.9) × 40 is
  // 3.999…, which made exactly 90% read "At risk" beside "Error budget spent"
  // (review of f05752e); (1 - 0.995) × 5400 errs the other way, 27.000…025.
  const allowedBad = Math.round((1 - target) * Math.max(total, fullWindowTotal) * 1e9) / 1e9;
  const bad = total - good;
  // A 100% target has no budget: any bad event spends all of it.
  const budgetLeft = allowedBad > 0 ? 1 - bad / allowedBad : bad === 0 ? 1 : -Infinity;
  const status: SloStatus = bad > allowedBad ? 'breached' : budgetLeft < AT_RISK_BUDGET_LEFT ? 'at-risk' : 'met';
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
  target: number,
  fullWindowTotal = 0
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
  return { ...ratioVerdict(okSlots, slots.length, target, fullWindowTotal), okSlots, failedSlots, silentSlots };
}

/** Keep-warm: every 4 minutes, 03:00–14:59 UTC (07:00–18:59 Oman). */
export function availabilityResult(runs: RunSample[], from: Date | null, now: Date): SlotResult {
  const { target, windowDays } = sloById('availability');
  if (!from) return { ...ratioVerdict(0, 0, target!), okSlots: 0, failedSlots: 0, silentSlots: 0 };
  return slotAttainment(runs, slotStarts(from, now, 4, [3, 15]), 4, target!, PROBE_SLOTS_PER_DAY * windowDays!);
}

/** The SLA sweep: at :15 and :45, 03:15–14:45 UTC — one half-hour slot each. */
export function slaSweepResult(runs: RunSample[], from: Date | null, now: Date): SlotResult {
  const { target, windowDays } = sloById('sla-sweep');
  if (!from) return { ...ratioVerdict(0, 0, target!), okSlots: 0, failedSlots: 0, silentSlots: 0 };
  return slotAttainment(runs, slotStarts(from, now, 30, [3, 15], 15), 30, target!, SWEEP_SLOTS_PER_DAY * windowDays!);
}

/**
 * The nightly dump, by UTC day. GitHub starts the 02:00 UTC schedule anywhere up
 * to 13:00 UTC (lib/heartbeat.ts), always inside the same UTC day, so "a
 * successful dump that day" is the honest unit. Today is excluded: its dump may
 * not have started yet.
 */
export function backupResult(runs: RunSample[], from: Date | null, now: Date): RatioResult & { missedDays: number } {
  const { target: t, windowDays } = sloById('backup');
  const target = t!;
  if (!from) return { ...ratioVerdict(0, 0, target), missedDays: 0 };
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const days: number[] = [];
  for (let d = Math.floor(from.getTime() / DAY) * DAY; d < today; d += DAY) days.push(d);
  const okDays = new Set(runs.filter((r) => r.ok).map((r) => Math.floor(r.at.getTime() / DAY) * DAY));
  const good = days.filter((d) => okDays.has(d)).length;
  return { ...ratioVerdict(good, days.length, target, windowDays!), missedDays: days.length - good };
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
  /**
   * The people who made the tracked decisions — the ones the figures above come
   * from (user ids, distinct). Used only to decide what a Manager may see
   * (tiersForViewer); never rendered.
   */
  people: string[];
};

/**
 * What a viewer may see per tier. The Data Steward sees every tier.
 *
 * For a Manager every line shown must stand for at least
 * MIN_PEOPLE_FOR_TIER_DETAIL distinct people, and so must anything a Manager can
 * work out from the lines shown. The company-wide figure sits above the tier
 * lines, so the tiers not shown are exactly "the company-wide figure minus the
 * shown lines" — dropping a small tier hides nothing (review of f05752e,
 * 2026-09-27). So the small tiers are folded into one "other steps" line, and
 * while that group still stands for fewer than MIN people the smallest shown tier
 * is folded in too (complementary suppression). If even everything together is
 * fewer than MIN people, no tier line is shown at all.
 *
 * People are counted as a set, not a sum: a Manager who decides both the
 * Supervisor step and reactivations is one person, not two.
 */
export function tiersForViewer<T extends { role: string }>(
  tiers: T[],
  peopleOf: (t: T) => readonly string[],
  viewerRole: string,
  fold: (hidden: T[]) => T
): T[] {
  if (viewerRole === 'STEWARD') return tiers;
  const size = (group: T[]) => new Set(group.flatMap(peopleOf)).size;
  const hidden = tiers.filter((t) => size([t]) < MIN_PEOPLE_FOR_TIER_DETAIL);
  if (hidden.length === 0) return tiers;
  const shown = tiers.filter((t) => size([t]) >= MIN_PEOPLE_FOR_TIER_DETAIL);
  const bySize = [...shown].sort((a, b) => size([a]) - size([b]));
  while (size(hidden) < MIN_PEOPLE_FOR_TIER_DETAIL && bySize.length > 0) hidden.push(bySize.shift()!);
  if (size(hidden) < MIN_PEOPLE_FOR_TIER_DETAIL) return [];
  const kept = shown.filter((t) => bySize.includes(t));
  return [...kept, fold(hidden)];
}

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

/**
 * Truncated, never rounded up: 99.4987% must not print as the 99.50% target
 * beside a "Missed" chip (review, 2026-09-27). The epsilon keeps an exact 0.995
 * from flooring to 99.49 through float error.
 */
export function formatPct(ratio: number | null, digits = 1): string {
  if (ratio === null) return '—';
  const scale = 10 ** digits;
  return `${(Math.floor(ratio * 100 * scale + 1e-6) / scale).toFixed(digits)}%`;
}

/** The error-budget line, decided by the sign of the raw value, so -0.3% never reads "0% left". */
export function formatBudget(left: number | null): string | null {
  if (left === null) return null;
  if (left < 0) return 'Error budget spent';
  return `${Math.floor(left * 100)}% of the error budget left`;
}
