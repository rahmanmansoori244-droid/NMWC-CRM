'use server';

/**
 * The daily Temix import, stage 5: APPLY the route moves of shops the CRM
 * already has (the merged plan, design B).
 *
 *  START (startTemixDailyApplyAction). The Data Steward, from the file's page.
 *  Refused, writing nothing, unless: the file is STAGED or CHECKED; none of its
 *  rows was emptied by the 90-day rule; no new-customer request waits at the
 *  Accountant (the pilot rule); no earlier file is unfinished and no later day
 *  is applied (the order rule, under the upload's lock, so a file cannot be
 *  staged or started past it meanwhile); the figures he saw (moves, moves into
 *  another region, moves that set back the previous file) are still the
 *  figures, and he ticked that he checked them; he ticked the reversal warning
 *  when there is a reversal, and the same-bytes warning when the file has the
 *  bytes of an earlier day's. No threshold figure is applied: the owner has
 *  given none. Then the file goes APPLYING under a lease, with who applied it,
 *  his reversal tick and one AuditLog row (counts and ticks).
 *
 *  SLICES (runTemixDailySliceAction, also Resume). Each slice takes the lease
 *  (compare-and-set: no lease, a lapsed one, or this run's own token), asks the
 *  pilot rule again (a stop releases the lease; the load stays APPLYING and is
 *  resumed later), then takes up to APPLY_SLICE_MAX_GROUPS customers with rows
 *  still PENDING, ONE TRANSACTION PER CUSTOMER:
 *    - the file is still APPLYING under this lease (FOR SHARE: a run that lost
 *      the lease can write nothing more);
 *    - the customers the code names are locked, the group's PENDING rows are
 *      locked, and the CRM is read (lib/temix-daily-apply-load.ts);
 *    - the Check is made from that (lib/temix-daily-check.ts), and each row is
 *      decided (lib/temix-daily-apply.ts decideRow);
 *    - per row, the change context names the row (src.temixDaily(file, row))
 *      and dates it the LOAD DAY (effectiveFrom), a move goes through
 *      moveShopToRoute (lib/temix-daily-move.ts: the shop, one AuditLog row, one
 *      ledger row), and the row is marked done in the same transaction.
 *  So a customer is either fully applied or untouched, and a slice killed
 *  half-way leaves only whole customers done: the next slice, or Resume after
 *  the lease lapses, takes the rest and nothing twice. A shop saved by someone
 *  else meanwhile fails its customer's transaction (VERSION_CONFLICT, recorded
 *  as a CONFLICT row); its rows stay PENDING for the next slice.
 *
 *  THE END. When no row is PENDING the file goes FINALIZING, then LOADED with
 *  its counts and one AuditLog row. Stage 6 hangs its finalize (notices,
 *  summary) on the FINALIZING step; this stage writes no notice.
 *
 *  DISCARD (discardTemixDailyFileAction). A STAGED or CHECKED file only, with a
 *  reason, audited. A part-applied file is resumed, never discarded.
 *
 * WRITES ONLY: TemixDailyFile (state, lease, counts, ticks), TemixDailyRow
 * (outcome, customer, shop, reasons, doneAt), and through moveShopToRoute the
 * Branch's route and region, one AuditLog and one TemixChange row per move;
 * one AuditLog row per start, end and discard. No Customer, no Notification, no
 * Temix queue (tests/unit/temix-daily-write-set.test.ts). Data Steward only.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { AuditAction, Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { ConflictError, ForbiddenError, RateLimitError, ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { checkLimit } from '@/lib/rate-limit';
import { getAuditEnvelope, writeAudit, type AuditEnvelope } from '@/lib/audit';
import { setChangeContext, src, withChangeContext } from '@/lib/change-context';
import { recordConflict } from '@/lib/conflict-record';
import { logger } from '@/lib/logger';
import { checkDailyFile, pilotGate } from '@/lib/temix-daily-check';
import { loadCheckInput, loadPilotWaiting } from '@/lib/temix-daily-check-load';
import { applyBlockedBy, dateColumnDay, overtakenBy, type DailyFileForOrder } from '@/lib/temix-daily-order';
import {
  APPLY_FIELDS,
  APPLY_HANDOFF_GRACE_MS,
  APPLY_LEASE_MS,
  APPLY_SLICE_BUDGET_MS,
  applyFigures,
  decideRow,
  discardRefusal,
  finalCounts,
  reversalsOf,
  seenFigures,
  sliceMaxGroups,
  startRefusal,
  storedReasons,
  type ApplyFigures,
  type OutcomeCounts,
} from '@/lib/temix-daily-apply';
import { lockGroupCustomers, loadGroupCrm, loadGroupRows, loadLastMoves, type GroupKey } from '@/lib/temix-daily-apply-load';
import { moveShopToRoute } from '@/lib/temix-daily-move';

export type TemixDailyStartResult = { fileId: string; leaseToken: string; figures: ApplyFigures };

export type TemixDailySliceResult = {
  fileId: string;
  state: 'APPLYING' | 'FINALIZING' | 'LOADED';
  /** This slice's rows, by what became of them. */
  applied: number;
  noChange: number;
  held: number;
  /** Customers whose transaction failed (their rows stay PENDING for the next slice). */
  conflicts: number;
  failed: number;
  remaining: number;
  done: boolean;
  /** Set when the pilot rule stopped the load: it is resumed once the request is decided. */
  stopped: 'PILOT' | null;
  /** Pass back on the next slice; absent once done or stopped. */
  leaseToken?: string;
};

const NOT_OURS = 'TEMIX_DAILY_LEASE_LOST';

async function requireSteward() {
  const user = await requireActor();
  if (user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can apply the Temix daily file.');
  }
  return user;
}

async function limit(userId: string, what: 'start' | 'slice' | 'discard') {
  const lim =
    what === 'slice'
      ? await checkLimit(`temix-daily-slice:${userId}`, { capacity: 60, refillPerSec: 2 })
      : await checkLimit(`temix-daily-apply:${userId}`, { capacity: 10, refillPerSec: 0.1 });
  if (!lim.ok) throw new RateLimitError(`Wait ${lim.retryAfterSec}s and try again.`);
}

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

/** Every non-discarded file, for the order rule. */
async function orderFiles(db: Pick<Prisma.TransactionClient, 'temixDailyFile'>): Promise<DailyFileForOrder[]> {
  const files = await db.temixDailyFile.findMany({
    where: { state: { not: 'DISCARDED' } },
    select: { id: true, filename: true, loadDay: true, uploadedAt: true, state: true, fileSha256: true },
  });
  return files.map((f) => ({ ...f, loadDay: dateColumnDay(f.loadDay) }));
}

async function emptiedRows(db: Pick<Prisma.TransactionClient, 'temixDailyRow'>, fileId: string, pendingOnly: boolean) {
  return db.temixDailyRow.count({ where: { fileId, parsed: { equals: Prisma.DbNull }, ...(pendingOnly ? { outcome: 'PENDING' as const } : {}) } });
}

// ── Start ─────────────────────────────────────────────────────────────────

export async function startTemixDailyApplyAction(formData: FormData): SafeAction<TemixDailyStartResult> {
  return runAction(async () => {
    const me = await requireSteward();
    await limit(me.id, 'start');
    const fileId = str(formData.get(APPLY_FIELDS.fileId)).trim();
    if (!fileId) throw new ValidationError({ fileId: 'No file named.' });
    const file = await prisma.temixDailyFile.findUnique({
      where: { id: fileId },
      select: { id: true, filename: true, loadDay: true, uploadedAt: true, state: true, fileSha256: true, sameBytesAsFileId: true },
    });
    if (!file) throw new ValidationError({ fileId: 'No such daily file.' });
    const env = await getAuditEnvelope(me.id);

    // The plan as the Steward saw it on the page, made again now.
    const [{ input }, waiting, emptied] = await Promise.all([
      loadCheckInput(prisma, fileId),
      loadPilotWaiting(prisma),
      emptiedRows(prisma, fileId, false),
    ]);
    const plan = checkDailyFile(input);
    const moves = plan.rows.filter((p) => p.move);
    const last = await loadLastMoves(prisma, moves.map((p) => p.move!.branchId));
    const figures = applyFigures(plan, reversalsOf(plan.rows, last, fileId).length);
    const form = {
      confirmed: str(formData.get(APPLY_FIELDS.confirmed)) === '1',
      reversalTick: str(formData.get(APPLY_FIELDS.reversalTick)) === '1',
      sameBytesTick: str(formData.get(APPLY_FIELDS.sameBytesTick)) === '1',
      seen: seenFigures((k) => {
        const v = formData.get(k);
        return typeof v === 'string' ? v : null;
      }),
    };
    const base = {
      state: file.state,
      emptiedRows: emptied,
      pilotWaiting: pilotGate(waiting).waiting.length,
      sameBytes: !!file.sameBytesAsFileId,
      figures,
      form,
    };
    // Asked once here with the order as read, to refuse early; asked again
    // under the lock below, which is the answer that counts.
    const me0 = { ...file, loadDay: dateColumnDay(file.loadDay) };
    const early = await orderFiles(prisma);
    const refusedEarly = startRefusal({ ...base, waitsFor: applyBlockedBy(me0, early), overtakenBy: overtakenBy(me0, early) });
    if (refusedEarly) throw new ValidationError({ fileId: refusedEarly }, refusedEarly);

    const leaseToken = `${me.id}:${randomUUID()}`;
    try {
      await withChangeContext(prisma, { actorId: me.id, source: src.temixDailyStep(fileId, 'apply') }, async (tx) => {
        // The upload's lock: no file is staged, and no other file started,
        // while this one decides the order rule.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('nmwc:temix-daily:upload', 42))`;
        const order = await orderFiles(tx);
        const refused = startRefusal({ ...base, waitsFor: applyBlockedBy(me0, order), overtakenBy: overtakenBy(me0, order) });
        if (refused) throw new ValidationError({ fileId: refused }, refused);
        const now = new Date();
        const claimed = await tx.temixDailyFile.updateMany({
          where: { id: fileId, state: { in: ['STAGED', 'CHECKED'] }, applyLeaseBy: null },
          data: {
            state: 'APPLYING',
            applyStartedAt: now,
            appliedById: me.id,
            applyLeaseBy: leaseToken,
            applyLeaseUntil: new Date(now.getTime() + APPLY_LEASE_MS),
            ...(figures.reversals > 0 ? { reversalAckById: me.id, reversalAckAt: now } : {}),
          },
        });
        if (claimed.count === 0) throw new ValidationError({ fileId: 'This file changed just as Apply started. Open the page again.' });
        await writeAudit(tx, env, {
          action: AuditAction.UPDATE,
          entityType: 'TemixDailyFile',
          entityId: fileId,
          before: { state: file.state },
          after: {
            kind: 'TEMIX_DAILY_APPLY_START',
            state: 'APPLYING',
            loadDay: me0.loadDay,
            moves: figures.moves,
            crossRegion: figures.crossRegion,
            reversals: figures.reversals,
            held: figures.held,
            missing: figures.missing,
            figuresConfirmed: true,
            reversalTicked: figures.reversals > 0,
            sameBytesTicked: !!file.sameBytesAsFileId,
          },
        });
      });
    } catch (err) {
      // The database's one-load-at-a-time rule (TemixDailyFile_one_in_flight).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const why = 'Another daily file is being applied. Finish it first.';
        throw new ValidationError({ fileId: why }, why);
      }
      throw err;
    }
    revalidatePath('/temix-daily');
    revalidatePath(`/temix-daily/${fileId}`);
    return { fileId, leaseToken, figures };
  });
}

// ── Slices ────────────────────────────────────────────────────────────────

/** Puts the lease to `until` (null: released), only while this run holds it. */
async function setLease(fileId: string, actorId: string, token: string, until: Date | null) {
  await withChangeContext(prisma, { actorId, source: src.temixDailyStep(fileId, 'lease') }, (tx) =>
    tx.temixDailyFile.updateMany({
      where: { id: fileId, applyLeaseBy: token },
      data: until ? { applyLeaseUntil: until } : { applyLeaseBy: null, applyLeaseUntil: null },
    })
  );
}

/** The next customers of the file with rows still PENDING: by customer code, then the rows with none. */
async function nextGroups(fileId: string, max: number): Promise<GroupKey[]> {
  const keyed = await prisma.temixDailyRow.findMany({
    where: { fileId, outcome: 'PENDING', custCodeKey: { not: null } },
    distinct: ['custCodeKey'],
    orderBy: { custCodeKey: 'asc' },
    take: max,
    select: { custCodeKey: true },
  });
  const groups: GroupKey[] = keyed.map((r) => ({ custCodeKey: r.custCodeKey! }));
  if (groups.length < max) {
    const bare = await prisma.temixDailyRow.findMany({
      where: { fileId, outcome: 'PENDING', custCodeKey: null },
      orderBy: { rowNumber: 'asc' },
      take: max - groups.length,
      select: { id: true },
    });
    groups.push(...bare.map((r) => ({ rowId: r.id })));
  }
  return groups;
}

type GroupResult = { applied: number; noChange: number; held: number };

/** One customer's rows, in one transaction dated the load day. */
async function applyGroup(
  me: { id: string },
  env: AuditEnvelope,
  file: { id: string; loadDay: string; reversalAcked: boolean },
  token: string,
  key: GroupKey
): Promise<GroupResult> {
  const out: GroupResult = { applied: 0, noChange: 0, held: 0 };
  const opening = 'custCodeKey' in key ? `${key.custCodeKey}` : key.rowId;
  await withChangeContext(
    prisma,
    { actorId: me.id, source: src.temixDaily(file.id, opening), effectiveFrom: file.loadDay },
    async (tx) => {
      const [f] = await tx.$queryRaw<Array<{ state: string; leaseBy: string | null }>>`
        SELECT "state"::text AS "state", "applyLeaseBy" AS "leaseBy" FROM "TemixDailyFile" WHERE "id" = ${file.id} FOR SHARE`;
      if (!f || f.state !== 'APPLYING' || f.leaseBy !== token) throw new Error(NOT_OURS);
      const customerIds = await lockGroupCustomers(tx, key);
      const { rows, emptied } = await loadGroupRows(tx, file.id, key);
      if (emptied > 0) throw new ValidationError({ fileId: 'Some rows of this file were cleared by the 90-day rule.' });
      if (rows.length === 0) return;
      const crm = await loadGroupCrm(tx, customerIds, rows);
      const plan = checkDailyFile({ rows, ...crm.input });
      const last = await loadLastMoves(
        tx,
        plan.rows.flatMap((p) => (p.move ? [p.move.branchId] : []))
      );
      const notesOf = new Map(rows.map((r) => [r.id, r.notes]));
      const doneAt = new Date();
      for (const p of plan.rows) {
        await setChangeContext(tx, { actorId: me.id, source: src.temixDaily(file.id, p.rowNumber), effectiveFrom: file.loadDay });
        const d = decideRow(p, { reversalAcked: file.reversalAcked, last: p.move ? last.get(p.move.branchId) : undefined, fileId: file.id });
        if (d.outcome === 'APPLIED') {
          const version = crm.versions.get(d.move.branchId);
          if (version === undefined) throw new Error('temix-daily: a planned shop was not read');
          await moveShopToRoute(
            tx,
            env,
            { id: d.move.branchId, customerId: p.customerId!, version, routeId: d.move.fromRouteId, regionId: d.move.fromRegionId },
            { routeId: d.move.toRouteId, regionId: d.move.toRegionId },
            { fileId: file.id, rowId: p.rowId, rowNumber: p.rowNumber, loadDay: file.loadDay, via: d.via, routeMapEntryId: d.routeMapEntryId }
          );
          out.applied++;
        } else if (d.outcome === 'NO_CHANGE') out.noChange++;
        else out.held++;
        const marked = await tx.temixDailyRow.updateMany({
          where: { id: p.rowId, fileId: file.id, outcome: 'PENDING' },
          data: {
            outcome: d.outcome,
            customerId: p.customerId,
            branchId: p.branchId,
            holdReasons: storedReasons(notesOf.get(p.rowId) ?? [], d),
            doneAt,
          },
        });
        if (marked.count !== 1) throw new Error(NOT_OURS);
      }
    },
    { timeout: 20_000, maxWait: 10_000 }
  );
  return out;
}

/** Every row is done: FINALIZING, then LOADED with the counts. Idempotent: a second call finds the file LOADED. */
async function finalize(me: { id: string }, env: AuditEnvelope, fileId: string, token: string): Promise<boolean> {
  await withChangeContext(prisma, { actorId: me.id, source: src.temixDailyStep(fileId, 'finalize') }, async (tx) => {
    const pending = await tx.temixDailyRow.count({ where: { fileId, outcome: 'PENDING' } });
    if (pending > 0) return;
    await tx.temixDailyFile.updateMany({ where: { id: fileId, state: 'APPLYING', applyLeaseBy: token }, data: { state: 'FINALIZING' } });
  });
  // Stage 6 adds its notices and summary here, between FINALIZING and LOADED.
  return withChangeContext(prisma, { actorId: me.id, source: src.temixDailyStep(fileId, 'finalize') }, async (tx) => {
    const [f] = await tx.$queryRaw<Array<{ state: string; leaseBy: string | null }>>`
      SELECT "state"::text AS "state", "applyLeaseBy" AS "leaseBy" FROM "TemixDailyFile" WHERE "id" = ${fileId} FOR UPDATE`;
    if (!f || f.state !== 'FINALIZING' || f.leaseBy !== token) return false;
    const grouped = await tx.temixDailyRow.groupBy({ by: ['outcome'], where: { fileId }, _count: { _all: true } });
    const counts: OutcomeCounts = Object.fromEntries(grouped.map((g) => [g.outcome, g._count._all]));
    const notices = await tx.temixChange.count({ where: { fileId, applied: false } });
    const moved = await tx.temixChange.count({ where: { fileId, applied: true, kind: 'ROUTE_MOVE' } });
    const c = finalCounts(counts, notices);
    const loadedAt = new Date();
    await tx.temixDailyFile.update({
      where: { id: fileId },
      data: { state: 'LOADED', loadedAt, applyLeaseBy: null, applyLeaseUntil: null, ...c },
    });
    await writeAudit(tx, env, {
      action: AuditAction.UPDATE,
      entityType: 'TemixDailyFile',
      entityId: fileId,
      before: { state: 'FINALIZING' },
      after: { kind: 'TEMIX_DAILY_LOADED', state: 'LOADED', ...c, routeMoves: moved },
    });
    return true;
  });
}

export async function runTemixDailySliceAction(formData: FormData): SafeAction<TemixDailySliceResult> {
  return runAction(async () => {
    const me = await requireSteward();
    await limit(me.id, 'slice');
    const fileId = str(formData.get(APPLY_FIELDS.fileId)).trim();
    if (!fileId) throw new ValidationError({ fileId: 'No file named.' });
    const priorToken = str(formData.get(APPLY_FIELDS.leaseToken));
    const env = await getAuditEnvelope(me.id);
    const file = await prisma.temixDailyFile.findUnique({
      where: { id: fileId },
      select: { id: true, state: true, loadDay: true, reversalAckAt: true },
    });
    if (!file) throw new ValidationError({ fileId: 'No such daily file.' });
    const result = (over: Partial<TemixDailySliceResult>): TemixDailySliceResult => ({
      fileId,
      state: 'APPLYING',
      applied: 0,
      noChange: 0,
      held: 0,
      conflicts: 0,
      failed: 0,
      remaining: 0,
      done: false,
      stopped: null,
      ...over,
    });
    if (file.state === 'LOADED') return result({ state: 'LOADED', done: true });
    if (file.state !== 'APPLYING' && file.state !== 'FINALIZING') {
      throw new ValidationError({ fileId: 'This file is not being applied. Start it with Apply.' });
    }

    // The lease: free, lapsed, or this run's own.
    const token = `${me.id}:${randomUUID()}`;
    const now = new Date();
    const claim = await withChangeContext(prisma, { actorId: me.id, source: src.temixDailyStep(fileId, 'lease') }, (tx) =>
      tx.temixDailyFile.updateMany({
        where: {
          id: fileId,
          state: { in: ['APPLYING', 'FINALIZING'] },
          OR: [{ applyLeaseUntil: null }, { applyLeaseUntil: { lt: now } }, ...(priorToken ? [{ applyLeaseBy: priorToken }] : [])],
        },
        data: { applyLeaseBy: token, applyLeaseUntil: new Date(now.getTime() + APPLY_LEASE_MS) },
      })
    );
    if (claim.count === 0) {
      const why = 'This file is being applied right now (another tab or another Steward). Wait for it, then Resume.';
      throw new ValidationError({ fileId: why }, why);
    }

    try {
      // The pilot rule, before every slice.
      const waiting = await loadPilotWaiting(prisma);
      if (pilotGate(waiting).stopped) {
        await setLease(fileId, me.id, token, null);
        return result({ state: file.state, stopped: 'PILOT', remaining: await prisma.temixDailyRow.count({ where: { fileId, outcome: 'PENDING' } }) });
      }
      const fileInfo = { id: fileId, loadDay: dateColumnDay(file.loadDay), reversalAcked: file.reversalAckAt !== null };
      const tally = { applied: 0, noChange: 0, held: 0, conflicts: 0, failed: 0 };
      if (file.state === 'APPLYING') {
        if ((await emptiedRows(prisma, fileId, true)) > 0) {
          await setLease(fileId, me.id, token, null);
          const why = 'Rows of this file still waiting were cleared by the 90-day rule; it cannot be applied further.';
          throw new ValidationError({ fileId: why }, why);
        }
        const started = Date.now();
        const groups = await nextGroups(fileId, sliceMaxGroups(process.env.TEMIX_DAILY_SLICE_MAX_GROUPS));
        for (const g of groups) {
          if (Date.now() - started > APPLY_SLICE_BUDGET_MS) break;
          try {
            const r = await applyGroup(me, env, fileInfo, token, g);
            tally.applied += r.applied;
            tally.noChange += r.noChange;
            tally.held += r.held;
          } catch (err) {
            if (err instanceof Error && err.message === NOT_OURS) {
              const why = 'This load was taken over by another tab or Steward.';
              throw new ValidationError({ fileId: why }, why);
            }
            if (err instanceof ConflictError && err.conflict) {
              tally.conflicts++;
              await recordConflict(err as ConflictError & { conflict: NonNullable<ConflictError['conflict']> });
              continue;
            }
            if (err instanceof ValidationError) throw err;
            tally.failed++;
            logger.warn({ fileId, err: (err as Error)?.message?.slice(0, 120) }, 'temix-daily.apply.group_failed');
          }
        }
      }
      const remaining = await prisma.temixDailyRow.count({ where: { fileId, outcome: 'PENDING' } });
      if (remaining === 0) {
        const loaded = await finalize(me, env, fileId, token);
        revalidatePath('/temix-daily');
        revalidatePath(`/temix-daily/${fileId}`);
        if (loaded) return result({ ...tally, state: 'LOADED', done: true });
      }
      await setLease(fileId, me.id, token, new Date(Date.now() + APPLY_HANDOFF_GRACE_MS));
      return result({ ...tally, state: 'APPLYING', remaining, leaseToken: token });
    } catch (err) {
      // Never leave the file under a lease nobody holds: it stays APPLYING, resumable.
      await setLease(fileId, me.id, token, null).catch(() => undefined);
      throw err;
    }
  });
}

// ── Discard ───────────────────────────────────────────────────────────────

export async function discardTemixDailyFileAction(formData: FormData): SafeAction<{ fileId: string }> {
  return runAction(async () => {
    const me = await requireSteward();
    await limit(me.id, 'discard');
    const fileId = str(formData.get(APPLY_FIELDS.fileId)).trim();
    const reason = str(formData.get(APPLY_FIELDS.reason)).trim();
    if (!fileId) throw new ValidationError({ fileId: 'No file named.' });
    const file = await prisma.temixDailyFile.findUnique({ where: { id: fileId }, select: { state: true } });
    if (!file) throw new ValidationError({ fileId: 'No such daily file.' });
    const refused = discardRefusal(file.state, reason);
    if (refused) throw new ValidationError({ reason: refused }, refused);
    const env = await getAuditEnvelope(me.id);
    await withChangeContext(prisma, { actorId: me.id, source: src.temixDailyStep(fileId, 'discard') }, async (tx) => {
      const done = await tx.temixDailyFile.updateMany({
        where: { id: fileId, state: { in: ['STAGED', 'CHECKED'] }, applyLeaseBy: null },
        data: { state: 'DISCARDED', discardedById: me.id, discardedAt: new Date(), discardReason: reason },
      });
      if (done.count === 0) throw new ValidationError({ fileId: 'This file changed meanwhile. Open the page again.' });
      // The reason is free text and stays on the file; the audit row carries the step.
      await writeAudit(tx, env, {
        action: AuditAction.UPDATE,
        entityType: 'TemixDailyFile',
        entityId: fileId,
        before: { state: file.state },
        after: { kind: 'TEMIX_DAILY_DISCARD', state: 'DISCARDED' },
      });
    });
    revalidatePath('/temix-daily');
    revalidatePath(`/temix-daily/${fileId}`);
    return { fileId };
  });
}
