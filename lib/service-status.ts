/**
 * Item 9: everything the Service status page (app/(app)/status) shows, read in
 * one place. The verdicts come from lib/service-levels.ts, which is pure; this
 * file only reads.
 *
 * Not a server action (no 'use server'), so nothing here is callable from the
 * browser; the page gates the role before calling it.
 *
 * Every figure is a company-wide count or duration: no customer is named and no
 * person is named. That is why a region-scoped Manager may see it (the same call
 * as /api/perf-probe, AUDITOR-BRIEF §5). Two things keep it that way:
 *   - a job's last error text is dropped here (withoutErrorText): it is scrubbed,
 *     but it stays behind the monitor bearer (lib/heartbeat.ts);
 *   - per-tier figures carry how many people stand behind them, and the page
 *     folds a tier with fewer than MIN_PEOPLE_FOR_TIER_DETAIL for a Manager — the
 *     General Manager and Finance Manager steps have one holder each, so their
 *     tier IS one colleague's decision speed (review, 2026-09-27).
 *
 * Bounded reads: CronRun by (key, at), at most 30 days of one job; approval
 * decisions by the EditApproval (at) index, aggregated in SQL to one row per tier;
 * the open queue by the SUBMITTED rows. One read is bounded only by history: the
 * reactivations decided in the window are found by scanning decided change
 * requests (no index on reviewedAt), the same shape as the dashboard's approvals
 * chart. Acceptable at this page's audience and this data's size; an index on
 * CustomerEdit(reviewedAt) would fix both if either grows.
 */
import { EditState, ImportBatchStatus, Role } from '@prisma/client';
import { prisma } from './db';
import { loadHeartbeatReport, type HeartbeatReport } from './heartbeat';
import { TEMIX_QUEUE_WHERE } from './temix';
import { workingMinutesBetween } from './working-hours';
import {
  PARSING_LOOKBACK_HOURS,
  PARSING_STUCK_AFTER_MIN,
  PROMOTE_STUCK_AFTER_MIN,
  approvalsResult,
  availabilityResult,
  backupResult,
  importsStatus,
  sloById,
  slaSweepResult,
  temixBacklogStatus,
  windowStart,
  type RatioResult,
  type RunSample,
  type SloStatus,
  type SlotResult,
  type TierDecisions,
} from './service-levels';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export type OpenTier = {
  role: string;
  open: number;
  pastDue: number;
  /** Working minutes the oldest open step has waited. */
  oldestWorkingMinutes: number | null;
  /** Active people who can decide this step (see MIN_PEOPLE_FOR_TIER_DETAIL). */
  holders: number;
};

export type ServiceStatus = {
  now: Date;
  availability: SlotResult & { since: Date | null; p95DbMs: number | null };
  slaSweep: SlotResult & { since: Date | null };
  backup: RatioResult & { since: Date | null; missedDays: number };
  approvals: RatioResult & { since: Date | null; untracked: number; tiers: TierDecisions[] };
  openApprovals: OpenTier[];
  temix: {
    status: SloStatus;
    waiting: number;
    oldestWaitingSince: Date | null;
    uploadedAwaitingTemix: number;
  };
  imports: { status: SloStatus; stuckPromotes: number; stuckUploads: number };
  jobs: JobState[];
};

/** A job as the page may show it: everything but the error text, plus Vercel's last successful run. */
export type JobState = Omit<HeartbeatReport, 'lastError'> & { lastVercelRunAt: string | null };

/**
 * A failed job's error text is scrubbed, but it is served only to the monitor
 * bearer (lib/heartbeat.ts): this page is for Managers, and it is dropped here,
 * before anything renders.
 */
export function withoutErrorText(job: HeartbeatReport, lastVercelRunAt: Date | null = null): JobState {
  const rest: Partial<HeartbeatReport> = { ...job };
  delete rest.lastError;
  return { ...(rest as Omit<HeartbeatReport, 'lastError'>), lastVercelRunAt: lastVercelRunAt?.toISOString() ?? null };
}

/**
 * "Measuring since …" only while the first measurement is inside the window.
 * Once the history is longer than the window, the window is full and the line
 * must go (review, 2026-09-27: it used to stay for ever, dated a month back).
 */
export function sinceFor(first: Date | null, nominalStart: Date): Date | null {
  return first && first.getTime() > nominalStart.getTime() ? first : null;
}

/** First stored run of each job: where each window starts measuring. */
async function firstRuns(): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<{ key: string; first: Date }[]>`
    SELECT "key", min("at") AS "first" FROM "CronRun" GROUP BY "key"`;
  return new Map(rows.map((r) => [r.key, r.first]));
}

/**
 * The last successful run each job had from Vercel's own cron, over the last
 * week. The owner retires cron-job.org once Vercel is seen calling
 * (OPERATIONS.md §5d); the objective cards count every scheduler, so they cannot
 * show that, and this can.
 */
async function lastVercelRuns(now: Date): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<{ key: string; last: Date }[]>`
    SELECT "key", max("at") AS "last"
      FROM "CronRun"
     WHERE "source" = 'vercel' AND "ok" AND "at" >= ${new Date(now.getTime() - 7 * DAY)}
     GROUP BY "key"`;
  return new Map(rows.map((r) => [r.key, r.last]));
}

/**
 * Keep-warm, one row per 4-minute slot with a run in it: several schedulers can
 * call the same slot, and a slot counts once (lib/service-levels.ts). date_bin's
 * origin is on the hour, the same grid slotStarts() walks.
 */
async function keepWarmSlots(from: Date): Promise<RunSample[]> {
  const rows = await prisma.$queryRaw<{ slot: Date; ok: boolean }[]>`
    SELECT date_bin('4 minutes', "at", TIMESTAMP '2000-01-01') AS "slot", bool_or("ok") AS "ok"
      FROM "CronRun"
     WHERE "key" = 'keep-warm' AND "at" >= ${from}
     GROUP BY 1`;
  return rows.map((r) => ({ at: r.slot, ok: r.ok }));
}

async function p95DbMs(from: Date): Promise<number | null> {
  const [row] = await prisma.$queryRaw<{ p95: number | null }[]>`
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY "dbMs") AS "p95"
      FROM "CronRun"
     WHERE "key" = 'keep-warm' AND "ok" AND "dbMs" IS NOT NULL AND "at" >= ${from}`;
  return row?.p95 === null || row?.p95 === undefined ? null : Math.round(Number(row.p95));
}

async function runs(key: string, from: Date): Promise<RunSample[]> {
  return prisma.cronRun.findMany({
    where: { key, at: { gte: from } },
    select: { at: true, ok: true },
  });
}

/**
 * Approval decisions in the window, one row per step role. `tracked` are the
 * decisions carrying the stage snapshot (made on or after 2026-09-27); the rest
 * are reported as untracked, never judged.
 *
 * Reactivations are decided outside the step engine and write no EditApproval
 * row. Their change request has kept its due time and its decision time since
 * July 2026, so they are read from there as the MANAGER tier, and counted from
 * those records rather than from the snapshot date; `firstCounted` says when the
 * earliest decision counted in the window was made.
 */
async function approvalTiers(from: Date): Promise<{ tiers: TierDecisions[]; firstCounted: Date | null }> {
  const steps = await prisma.$queryRaw<
    {
      role: string;
      decided: number;
      tracked: number;
      within: number;
      p50: number | null;
      p90: number | null;
      people: number;
    }[]
  >`
    SELECT "role"::text AS "role",
           count(*)::int AS "decided",
           count(*) FILTER (WHERE "slaDueAt" IS NOT NULL)::int AS "tracked",
           count(*) FILTER (WHERE "slaDueAt" IS NOT NULL AND "at" <= "slaDueAt")::int AS "within",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "workingMinutes") AS "p50",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY "workingMinutes") AS "p90",
           count(DISTINCT "actorId")::int AS "people"
      FROM "EditApproval"
     WHERE "at" >= ${from}
     GROUP BY "role"`;
  const [first] = await prisma.$queryRaw<{ first: Date | null }[]>`
    SELECT min("at") AS "first" FROM "EditApproval" WHERE "slaDueAt" IS NOT NULL`;

  const tiers: TierDecisions[] = steps.map((s) => ({
    role: s.role,
    decided: s.decided,
    tracked: s.tracked,
    within: s.within,
    p50Minutes: s.p50 === null ? null : Math.round(Number(s.p50)),
    p90Minutes: s.p90 === null ? null : Math.round(Number(s.p90)),
    people: s.people,
  }));
  let firstCounted: Date | null = first?.first ?? null;

  const reactivations = await prisma.customerEdit.findMany({
    where: {
      isReactivation: true,
      reviewedAt: { gte: from },
      state: { in: [EditState.APPROVED, EditState.NEEDS_CORRECTION] },
    },
    select: { stageEnteredAt: true, submittedAt: true, slaDueAt: true, reviewedAt: true, reviewedById: true },
  });
  if (reactivations.length > 0) {
    const minutes: number[] = [];
    const people = new Set<string>();
    let tracked = 0;
    let within = 0;
    for (const r of reactivations) {
      if (r.reviewedById) people.add(r.reviewedById);
      if (!r.reviewedAt || !r.slaDueAt) continue;
      tracked += 1;
      if (r.reviewedAt.getTime() <= r.slaDueAt.getTime()) within += 1;
      if (!firstCounted || r.reviewedAt.getTime() < firstCounted.getTime()) firstCounted = r.reviewedAt;
      const entered = r.stageEnteredAt ?? r.submittedAt;
      if (entered) minutes.push(workingMinutesBetween(entered, r.reviewedAt));
    }
    tiers.push({
      role: 'MANAGER',
      decided: reactivations.length,
      tracked,
      within,
      p50Minutes: percentile(minutes, 0.5),
      p90Minutes: percentile(minutes, 0.9),
      people: people.size,
    });
  }
  return { tiers, firstCounted };
}

/** Linear-interpolated percentile, the same definition as percentile_cont. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (pos - lo));
}

/**
 * Who can decide each step: its role's active accounts. Managers also decide the
 * Supervisor step (the region fallback), and the MANAGER queue is reactivations.
 */
export function holdersByStep(activeByRole: Map<string, number>): (step: string) => number {
  return (step) =>
    step === Role.SUPERVISOR
      ? (activeByRole.get(Role.SUPERVISOR) ?? 0) + (activeByRole.get(Role.MANAGER) ?? 0)
      : (activeByRole.get(step) ?? 0);
}

async function openApprovals(now: Date): Promise<OpenTier[]> {
  const [rows, active] = await Promise.all([
    prisma.$queryRaw<{ role: string; open: number; pastDue: number; oldest: Date | null }[]>`
      SELECT COALESCE("pendingRole"::text, 'SUPERVISOR') AS "role",
             count(*)::int AS "open",
             count(*) FILTER (WHERE "slaDueAt" < ${now})::int AS "pastDue",
             min(COALESCE("stageEnteredAt", "submittedAt")) AS "oldest"
        FROM "CustomerEdit"
       WHERE "state" = 'SUBMITTED'
       GROUP BY 1`,
    prisma.user.groupBy({ by: ['role'], where: { isActive: true }, _count: { _all: true } }),
  ]);
  const holders = holdersByStep(new Map(active.map((a) => [a.role as string, a._count._all])));
  return rows.map((r) => ({
    role: r.role,
    open: r.open,
    pastDue: r.pastDue,
    oldestWorkingMinutes: r.oldest ? workingMinutesBetween(r.oldest, now) : null,
    holders: holders(r.role),
  }));
}

async function temix(now: Date): Promise<ServiceStatus['temix']> {
  const [waiting, oldest, uploadedAwaitingTemix] = await Promise.all([
    prisma.customer.count({ where: TEMIX_QUEUE_WHERE }),
    // The queue's own predicate, never "pendingSince is set": the timestamp is
    // not cleared when a row is uploaded or synced (lib/temix.ts).
    prisma.customer.aggregate({ where: TEMIX_QUEUE_WHERE, _min: { temixSyncPendingSince: true } }),
    prisma.customer.count({ where: { temixSyncState: 'UPLOADED' } }),
  ]);
  const oldestWaitingSince = oldest._min.temixSyncPendingSince ?? null;
  return { status: temixBacklogStatus(oldestWaitingSince, now), waiting, oldestWaitingSince, uploadedAwaitingTemix };
}

async function imports(now: Date): Promise<ServiceStatus['imports']> {
  const promoteCutoff = new Date(now.getTime() - PROMOTE_STUCK_AFTER_MIN * MIN);
  const parsingCutoff = new Date(now.getTime() - PARSING_STUCK_AFTER_MIN * MIN);
  const parsingLookback = new Date(now.getTime() - PARSING_LOOKBACK_HOURS * 60 * MIN);
  const [stuckPromotes, stuckUploads] = await Promise.all([
    // Exactly what the Steward's Work list shows as interrupted: a promote whose
    // lease was released (an error, or a second promote refused while another
    // ran) is waiting for someone to resume it and counts at once, since nothing
    // records when it was released. Only a lease that simply ran out, with the
    // run that held it gone, gets the hour.
    prisma.importBatch.count({
      where: {
        OR: [
          { status: ImportBatchStatus.FAILED },
          { status: ImportBatchStatus.PROMOTING, promoteLeaseUntil: null },
          { status: ImportBatchStatus.PROMOTING, promoteLeaseUntil: { lt: promoteCutoff } },
        ],
      },
    }),
    // An upload whose request died between creating its batch and finishing the
    // read. It has no in-app way out (re-uploading makes a new batch), so it
    // counts for a day and then drops off (PARSING_LOOKBACK_HOURS).
    prisma.importBatch.count({
      where: { status: ImportBatchStatus.PARSING, uploadedAt: { lt: parsingCutoff, gte: parsingLookback } },
    }),
  ]);
  return { status: importsStatus(stuckPromotes, stuckUploads), stuckPromotes, stuckUploads };
}

export async function loadServiceStatus(now: Date = new Date()): Promise<ServiceStatus> {
  const nominal = (days: number) => new Date(now.getTime() - days * DAY);
  const first = await firstRuns();
  const kwFirst = first.get('keep-warm') ?? null;
  const sweepFirst = first.get('sla-escalate') ?? null;
  const backupFirst = first.get('db-backup') ?? null;
  const availabilityDays = sloById('availability').windowDays!;
  const sweepDays = sloById('sla-sweep').windowDays!;
  const backupDays = sloById('backup').windowDays!;
  const availabilityFrom = windowStart(now, availabilityDays, kwFirst);
  const sweepFrom = windowStart(now, sweepDays, sweepFirst);
  const backupFrom = windowStart(now, backupDays, backupFirst);
  const approvalsNominal = nominal(sloById('approvals').windowDays!);

  // Runs are read from the start of the slot/day containing the window start, so
  // the first slot or day is judged on everything that ran in it.
  const [kwRuns, dbP95, sweepRuns, backupRuns, approvals, open, temixState, importState, jobs, vercelRuns] =
    await Promise.all([
      availabilityFrom ? keepWarmSlots(floorTo(availabilityFrom, 4 * MIN)) : Promise.resolve([]),
      availabilityFrom ? p95DbMs(availabilityFrom) : Promise.resolve(null),
      sweepFrom ? runs('sla-escalate', floorTo(sweepFrom, 30 * MIN, 15 * MIN)) : Promise.resolve([]),
      backupFrom ? runs('db-backup', floorTo(backupFrom, DAY)) : Promise.resolve([]),
      approvalTiers(approvalsNominal),
      openApprovals(now),
      temix(now),
      imports(now),
      loadHeartbeatReport(now),
      lastVercelRuns(now),
    ]);

  return {
    now,
    availability: {
      ...availabilityResult(kwRuns, availabilityFrom, now),
      since: sinceFor(kwFirst, nominal(availabilityDays)),
      p95DbMs: dbP95,
    },
    slaSweep: { ...slaSweepResult(sweepRuns, sweepFrom, now), since: sinceFor(sweepFirst, nominal(sweepDays)) },
    backup: { ...backupResult(backupRuns, backupFrom, now), since: sinceFor(backupFirst, nominal(backupDays)) },
    approvals: {
      ...approvalsResult(approvals.tiers),
      since: sinceFor(approvals.firstCounted, approvalsNominal),
      tiers: approvals.tiers,
    },
    openApprovals: open,
    temix: temixState,
    imports: importState,
    jobs: jobs.map((j) => withoutErrorText(j, vercelRuns.get(j.key) ?? null)),
  };
}

function floorTo(d: Date, step: number, offset = 0): Date {
  return new Date(Math.floor((d.getTime() - offset) / step) * step + offset);
}

/** Exported for the integration test, which runs the real SQL. */
export const __internal = { keepWarmSlots, approvalTiers, openApprovals, firstRuns, p95DbMs, lastVercelRuns };
