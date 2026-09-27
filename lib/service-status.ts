/**
 * Item 9: everything the Service status page (app/(app)/status) shows, read in
 * one place. The verdicts come from lib/service-levels.ts, which is pure; this
 * file only reads.
 *
 * Not a server action (no 'use server'), so nothing here is callable from the
 * browser; the page gates the role before calling it.
 *
 * Every figure is a company-wide COUNT or duration — no customer, no person —
 * which is why a region-scoped Manager may see it (the same call as
 * /api/perf-probe, AUDITOR-BRIEF §5). The one field that could carry personal
 * data, a job's last error text, is not read: it is scrubbed, but it stays behind
 * the monitor bearer (lib/heartbeat.ts).
 *
 * Every query is bounded: CronRun by (key, at) and at most 30 days of one job; the
 * approval decisions by the EditApproval (at) index, aggregated in SQL to one row
 * per tier; the open queue by the SUBMITTED rows only.
 */
import { EditState, ImportBatchStatus } from '@prisma/client';
import { prisma } from './db';
import { loadHeartbeatReport, type HeartbeatReport } from './heartbeat';
import { TEMIX_QUEUE_WHERE } from './temix';
import { workingMinutesBetween } from './working-hours';
import {
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

/** A job as the page may show it: everything but the error text. */
export type JobState = Omit<HeartbeatReport, 'lastError'>;

/**
 * A failed job's error text is scrubbed, but it is served only to the monitor
 * bearer (lib/heartbeat.ts): this page is for Managers, and it is dropped here,
 * before anything renders.
 */
export function withoutErrorText(job: HeartbeatReport): JobState {
  const rest: Partial<HeartbeatReport> = { ...job };
  delete rest.lastError;
  return rest as JobState;
}

/** First stored run of each job: where each window starts measuring. */
async function firstRuns(): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<{ key: string; first: Date }[]>`
    SELECT "key", min("at") AS "first" FROM "CronRun" GROUP BY "key"`;
  return new Map(rows.map((r) => [r.key, r.first]));
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
 * are reported as untracked, never judged. Reactivations are decided outside the
 * step engine and write no EditApproval row; their change request keeps the due
 * time and the decision time, so they are read from there as the MANAGER tier.
 */
async function approvalTiers(from: Date): Promise<{ tiers: TierDecisions[]; firstTracked: Date | null }> {
  const steps = await prisma.$queryRaw<
    { role: string; decided: number; tracked: number; within: number; p50: number | null; p90: number | null }[]
  >`
    SELECT "role"::text AS "role",
           count(*)::int AS "decided",
           count(*) FILTER (WHERE "slaDueAt" IS NOT NULL)::int AS "tracked",
           count(*) FILTER (WHERE "slaDueAt" IS NOT NULL AND "at" <= "slaDueAt")::int AS "within",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "workingMinutes") AS "p50",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY "workingMinutes") AS "p90"
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
  }));

  const reactivations = await prisma.customerEdit.findMany({
    where: {
      isReactivation: true,
      reviewedAt: { gte: from },
      state: { in: [EditState.APPROVED, EditState.NEEDS_CORRECTION] },
    },
    select: { stageEnteredAt: true, submittedAt: true, slaDueAt: true, reviewedAt: true },
  });
  if (reactivations.length > 0) {
    const minutes: number[] = [];
    let tracked = 0;
    let within = 0;
    for (const r of reactivations) {
      if (!r.reviewedAt || !r.slaDueAt) continue;
      tracked += 1;
      if (r.reviewedAt.getTime() <= r.slaDueAt.getTime()) within += 1;
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
    });
  }
  return { tiers, firstTracked: first?.first ?? null };
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

async function openApprovals(now: Date): Promise<OpenTier[]> {
  const rows = await prisma.$queryRaw<{ role: string; open: number; pastDue: number; oldest: Date | null }[]>`
    SELECT COALESCE("pendingRole"::text, 'SUPERVISOR') AS "role",
           count(*)::int AS "open",
           count(*) FILTER (WHERE "slaDueAt" < ${now})::int AS "pastDue",
           min(COALESCE("stageEnteredAt", "submittedAt")) AS "oldest"
      FROM "CustomerEdit"
     WHERE "state" = 'SUBMITTED'
     GROUP BY 1`;
  return rows.map((r) => ({
    role: r.role,
    open: r.open,
    pastDue: r.pastDue,
    oldestWorkingMinutes: r.oldest ? workingMinutesBetween(r.oldest, now) : null,
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
  const [stuckPromotes, stuckUploads] = await Promise.all([
    // The Steward's Work list shows these the moment they happen; the objective
    // gives a live promote an hour to finish or be resumed. A released lease
    // (null) is an interrupted promote waiting for someone: stuck already.
    prisma.importBatch.count({
      where: {
        OR: [
          { status: ImportBatchStatus.FAILED },
          { status: ImportBatchStatus.PROMOTING, promoteLeaseUntil: null },
          { status: ImportBatchStatus.PROMOTING, promoteLeaseUntil: { lt: promoteCutoff } },
        ],
      },
    }),
    // An upload killed between creating its batch and finishing the read is
    // shown nowhere else.
    prisma.importBatch.count({
      where: { status: ImportBatchStatus.PARSING, uploadedAt: { lt: parsingCutoff } },
    }),
  ]);
  return { status: importsStatus(stuckPromotes, stuckUploads), stuckPromotes, stuckUploads };
}

export async function loadServiceStatus(now: Date = new Date()): Promise<ServiceStatus> {
  const first = await firstRuns();
  const availabilityFrom = windowStart(now, sloById('availability').windowDays!, first.get('keep-warm') ?? null);
  const sweepFrom = windowStart(now, sloById('sla-sweep').windowDays!, first.get('sla-escalate') ?? null);
  const backupFrom = windowStart(now, sloById('backup').windowDays!, first.get('db-backup') ?? null);
  const approvalsNominal = new Date(now.getTime() - sloById('approvals').windowDays! * DAY);

  // Runs are read from the start of the slot/day containing the window start, so
  // the first slot or day is judged on everything that ran in it.
  const [kwRuns, dbP95, sweepRuns, backupRuns, approvals, open, temixState, importState, jobs] = await Promise.all([
    availabilityFrom ? keepWarmSlots(floorTo(availabilityFrom, 4 * MIN)) : Promise.resolve([]),
    availabilityFrom ? p95DbMs(availabilityFrom) : Promise.resolve(null),
    sweepFrom ? runs('sla-escalate', floorTo(sweepFrom, 30 * MIN, 15 * MIN)) : Promise.resolve([]),
    backupFrom ? runs('db-backup', floorTo(backupFrom, DAY)) : Promise.resolve([]),
    approvalTiers(approvalsNominal),
    openApprovals(now),
    temix(now),
    imports(now),
    loadHeartbeatReport(now),
  ]);

  const approvalsVerdict = approvalsResult(approvals.tiers);
  const approvalsSince =
    approvals.firstTracked && approvals.firstTracked.getTime() > approvalsNominal.getTime()
      ? approvals.firstTracked
      : null;

  return {
    now,
    availability: { ...availabilityResult(kwRuns, availabilityFrom, now), since: availabilityFrom, p95DbMs: dbP95 },
    slaSweep: { ...slaSweepResult(sweepRuns, sweepFrom, now), since: sweepFrom },
    backup: { ...backupResult(backupRuns, backupFrom, now), since: backupFrom },
    approvals: { ...approvalsVerdict, since: approvalsSince, tiers: approvals.tiers },
    openApprovals: open,
    temix: temixState,
    imports: importState,
    jobs: jobs.map(withoutErrorText),
  };
}

function floorTo(d: Date, step: number, offset = 0): Date {
  return new Date(Math.floor((d.getTime() - offset) / step) * step + offset);
}

/** Exported for the integration test, which runs the real SQL. */
export const __internal = { keepWarmSlots, approvalTiers, openApprovals, firstRuns, p95DbMs };
