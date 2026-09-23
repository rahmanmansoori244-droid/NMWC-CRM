'use server';

/**
 * Temix (ERP) batch sync — Steward-only actions (Phase 1 Temix increment).
 *
 * Outbound protocol (Blueprint §8.3 + data-model §8, owner-locked framing):
 *  1. generateTemixBatchAction — snapshot the queue (PENDING_UPLOAD live rows
 *     + DEACTIVATE_PENDING soft-deleted rows), create a TemixSyncBatch, flip
 *     the rows to UPLOADED in the same transaction, and hand the Steward an
 *     xlsx (base64 — same transport as the filtered customer export).
 *  2. downloadTemixBatchAction — regenerate any batch's workbook from its
 *     customerIds snapshot (no state changes). At-least-once-with-dedup:
 *     Temix upserts on the code, so a regenerated row that has since changed
 *     is fine, and re-sending an unchanged row is a no-op.
 *  3. markTemixBatchLoadedAction — records the Steward's "loaded into Temix"
 *     confirmation (markedLoadedAt) and settles the batch's DEACTIVATE-lane
 *     rows to SYNCED: Temix never echoes deactivated customers back in a
 *     master export, so the inbound refresh can't flip them. Live rows stay
 *     UPLOADED until the inbound refresh delivers their temix_code
 *     (services/imports.ts).
 */
import { prisma } from '@/lib/db';
import { Role, TemixSyncState, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { checkLimit } from '@/lib/rate-limit';
import { buildWorkbook } from '@/lib/excel';
import { buildTemixRows, TEMIX_QUEUE_WHERE, type TemixExportCustomer } from '@/lib/temix';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

const BATCH_ROW_CAP = 5000;

async function requireSteward() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Steward manages Temix sync.');
  }
  return session.user;
}

const CUSTOMER_SELECT = {
  id: true,
  nmwcCode: true,
  temixCode: true,
  legalName: true,
  paymentTerms: true,
  creditLimit: true,
  paymentTermDays: true,
  crNumber: true,
  primaryPhone: true,
  altPhone: true,
  contactPerson: true,
  deletedAt: true,
  channel: { select: { label: true } },
  subChannel: { select: { label: true } },
  branches: {
    select: {
      branchCode: true,
      branchName: true,
      address: true,
      dayOfVisit: true,
      gpsLat: true,
      gpsLng: true,
      deletedAt: true,
      region: { select: { name: true, code: true } },
      route: { select: { code: true } },
    },
  },
} satisfies Prisma.CustomerSelect;

type LoadedCustomer = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;

/** Attach live guarantee-doc counts (credit evidence can't ride an Excel row — counted instead). */
async function withGuaranteeCounts(
  customers: LoadedCustomer[]
): Promise<TemixExportCustomer[]> {
  const creditIds = customers
    .filter((c) => c.paymentTerms === 'CREDIT')
    .map((c) => c.id);
  const counts = creditIds.length
    ? await prisma.attachment.groupBy({
        by: ['customerId'],
        where: { customerId: { in: creditIds }, kind: 'GUARANTEE', deletedAt: null },
        _count: { _all: true },
      })
    : [];
  const countById = new Map(counts.map((c) => [c.customerId!, c._count._all]));
  return customers.map((c) => ({ ...c, guaranteeDocs: countById.get(c.id) ?? 0 }));
}

async function buildBatchWorkbook(
  customers: TemixExportCustomer[],
  batchId: string
): Promise<{ base64: string; filename: string; rowCount: number }> {
  const rows = buildTemixRows(customers, batchId);
  const wb = await buildWorkbook(rows, 'Temix Upload');
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    base64: Buffer.from(new Uint8Array(buf)).toString('base64'),
    filename: `temix-upload-${stamp}-${batchId.slice(-6)}.xlsx`,
    rowCount: rows.length,
  };
}

export type TemixBatchResult = {
  batchId: string;
  base64: string;
  filename: string;
  rowCount: number;
  customerCount: number;
};

export async function generateTemixBatchAction(): SafeAction<TemixBatchResult> {
  return runAction(() => generateTemixBatchCore());
}

async function generateTemixBatchCore(): Promise<TemixBatchResult> {
  const me = await requireSteward();
  const lim = await checkLimit(`temix:${me.id}`, { capacity: 3, refillPerSec: 0.05 });
  if (!lim.ok) throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another batch.`);

  // Build the audit envelope BEFORE opening the transaction. Two practical
  // reasons: one header read per action instead of one per write, and no
  // avoidable work inside an open interactive transaction on a WAN-bound link —
  // the delay class that produced this codebase's P2028 failures.
  const env = await getAuditEnvelope(me.id);

  // THE BUDGET BELOW IS SIZED FOR THE POST-REQUEUE QUEUE, NOT THE PILOT'S HANDFUL,
  // AND IS CAPPED BY THE PLATFORM RATHER THAN BY THE WORK.
  // On 2026-09-23 scripts/ops/requeue-untracked.ts put ~3,300 customers and ~4,200
  // branches into this snapshot, and the owner's next action after that script is
  // Generate batch. The flip row-locks the whole queue and holds those locks
  // through the findMany, which CUSTOMER_SELECT expands into several statements
  // over the WAN-bound link — no relationJoins, so branches, region, route,
  // channel and subChannel are separate round trips, one of them ~4,200 rows.
  // 20s was never measured against that shape, so this carries 30s.
  //
  // It does NOT carry more, and that ceiling is the whole point: vercel.json gives
  // app/**/*.ts(x) maxDuration 60, and this action still has to run
  // withGuaranteeCounts and build a ~4,200-row workbook AFTER the commit. A budget
  // at or above 60s cannot fire — the platform kills the invocation first, and
  // what the Steward sees is a dead request rather than a Prisma error naming the
  // timeout. Keep transaction + maxWait comfortably below maxDuration minus the
  // workbook build. If 30s ever proves too short, the answer is a SMALLER QUEUE,
  // not a larger window: the transaction rolls back untouched on timeout, so
  // `requeue-untracked.ts --limit` can drain the backlog in tranches and each
  // batch generates well inside the budget. Pinned by
  // tests/unit/temix-requeue-guard.test.ts, which asserts both bounds.
  const { batch, customers } = await prisma.$transaction(async (tx) => {
    // Soft cap pre-check (updateMany cannot `take`; a handful of rows racing
    // in over the cap between count and flip is harmless).
    const pending = await tx.customer.count({ where: TEMIX_QUEUE_WHERE });
    if (pending === 0) {
      throw new ValidationError({ _form: 'Nothing is pending for Temix upload.' });
    }
    if (pending > BATCH_ROW_CAP) {
      throw new ValidationError({
        _form: `Queue exceeds ${BATCH_ROW_CAP} customers — contact support to split the batch.`,
      });
    }
    const now = new Date();
    const b = await tx.temixSyncBatch.create({
      data: {
        createdById: me.id,
        rowCount: 0,
        customerIds: [] as unknown as Prisma.InputJsonValue,
        status: 'RUNNING',
      },
    });
    // FLIP FIRST, SNAPSHOT AFTER (adversarial-review CONFIRMED fix): the flip
    // is the single authoritative claim — it row-locks everything it touches
    // and stamps this batch's id. The snapshot below then re-reads exactly the
    // claimed rows, so the workbook always carries the data as-of (or newer
    // than) the claim. Interleavings: an edit-apply committing BEFORE the
    // flip lands its new data in this batch; one committing AFTER blocks on
    // the row lock, then re-queues the row PENDING_UPLOAD for the next batch
    // (applyEditChanges guard includes UPLOADED). An archive racing either
    // way ends as a DEACTIVATE row here or DEACTIVATE_PENDING for the next
    // batch. No window loses a correction. A concurrent second generate
    // finds the queue empty (flip count 0) and rolls back its batch row.
    const flipped = await tx.customer.updateMany({
      where: TEMIX_QUEUE_WHERE,
      data: {
        temixSyncState: TemixSyncState.UPLOADED,
        lastTemixUploadAt: now,
        lastTemixUploadBatchId: b.id,
      },
    });
    if (flipped.count === 0) {
      throw new ValidationError({ _form: 'Nothing is pending for Temix upload.' });
    }
    const queued = await tx.customer.findMany({
      where: { lastTemixUploadBatchId: b.id, temixSyncState: TemixSyncState.UPLOADED },
      select: CUSTOMER_SELECT,
      orderBy: { nmwcCode: 'asc' },
    });
    const ids = queued.map((c) => c.id);
    await tx.temixSyncBatch.update({
      where: { id: b.id },
      data: {
        rowCount: ids.length,
        customerIds: ids as unknown as Prisma.InputJsonValue,
        // Generation is synchronous — the workbook is built from this same
        // snapshot immediately after commit, and any batch is regenerable
        // from customerIds (r2Key unused by design; the codebase convention
        // is base64-through-the-action, not R2, for exports).
        status: 'DONE',
      },
    });
    await writeAudit(tx, env, {
      action: 'EXPORT',
      entityType: 'TemixSyncBatch',
      entityId: b.id,
      after: {
        customers: ids.length,
        deactivations: queued.filter((c) => c.deletedAt).length,
      } as unknown as Prisma.InputJsonValue,
    });
    return { batch: b, customers: queued };
  }, { timeout: 30_000, maxWait: 5_000 });

  const enriched = await withGuaranteeCounts(customers);
  const wb = await buildBatchWorkbook(enriched, batch.id);
  logger.info(
    { batchId: batch.id, customers: customers.length, rows: wb.rowCount, by: me.id },
    'temix.batch.generate'
  );
  revalidatePath('/temix');
  return {
    batchId: batch.id,
    ...wb,
    customerCount: customers.length,
  };
}

export async function downloadTemixBatchAction(
  formData: FormData
): SafeAction<TemixBatchResult> {
  return runAction(async () => {
    const me = await requireSteward();
    const batchId = String(formData.get('batchId') ?? '');
    if (!batchId) throw new ValidationError({ batchId: 'required' });
    const batch = await prisma.temixSyncBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundError('Batch not found.');
    const ids = Array.isArray(batch.customerIds) ? (batch.customerIds as string[]) : [];
    // Regenerated from the snapshot ids with CURRENT data — see module
    // docstring for why that is safe (Temix upserts on the code).
    const customers = await prisma.customer.findMany({
      where: { id: { in: ids } },
      select: CUSTOMER_SELECT,
      orderBy: { nmwcCode: 'asc' },
    });
    const enriched = await withGuaranteeCounts(customers);
    const wb = await buildBatchWorkbook(enriched, batch.id);
    logger.info({ batchId, by: me.id }, 'temix.batch.redownload');
    return { batchId: batch.id, ...wb, customerCount: customers.length };
  });
}

export async function markTemixBatchLoadedAction(formData: FormData): SafeAction<void> {
  return runAction(async () => {
    const me = await requireSteward();
    const batchId = String(formData.get('batchId') ?? '');
    if (!batchId) throw new ValidationError({ batchId: 'required' });
    const now = new Date();
    // Envelope before the transaction — see generateTemixBatchCore.
    const env = await getAuditEnvelope(me.id);
    // One transaction for claim + settle + audit: a crash between the claim
    // and the settle would otherwise strand deactivate-lane rows in UPLOADED
    // forever (the idempotency guard rejects a second confirm).
    const settledCount = await prisma.$transaction(async (tx) => {
      // Idempotent claim: only the first confirm writes.
      const claim = await tx.temixSyncBatch.updateMany({
        where: { id: batchId, markedLoadedAt: null },
        data: { markedLoadedAt: now },
      });
      if (claim.count === 0) {
        const exists = await tx.temixSyncBatch.findUnique({
          where: { id: batchId },
          select: { markedLoadedAt: true },
        });
        if (!exists) throw new NotFoundError('Batch not found.');
        throw new ValidationError({ _form: 'This batch is already marked as loaded.' });
      }
      const batch = await tx.temixSyncBatch.findUniqueOrThrow({ where: { id: batchId } });
      const ids = Array.isArray(batch.customerIds) ? (batch.customerIds as string[]) : [];
      // Settle the DEACTIVATE lane: Temix never echoes deactivated customers
      // back in a master export, so the inbound refresh can't flip them —
      // the Steward's confirmation is their terminal sync signal. Live rows
      // stay UPLOADED until the refresh returns their code.
      // (Design-review note: the blueprint pins the UPLOADED→SYNCED flip on
      // the inbound refresh but leaves the deactivate lane's settling
      // unspecified; this is the conservative reading.)
      const settled = await tx.customer.updateMany({
        where: {
          id: { in: ids },
          deletedAt: { not: null },
          temixSyncState: TemixSyncState.UPLOADED,
          // Only rows whose LAST upload was THIS batch: a customer archived
          // after this batch rides a LATER batch's deactivation lane, and
          // confirming the old batch must not settle it early.
          lastTemixUploadBatchId: batchId,
        },
        data: { temixSyncState: TemixSyncState.SYNCED },
      });
      await writeAudit(tx, env, {
        action: 'UPDATE',
        entityType: 'TemixSyncBatch',
        entityId: batchId,
        after: {
          markedLoadedAt: now.toISOString(),
          deactivationsSettled: settled.count,
        } as unknown as Prisma.InputJsonValue,
      });
      return settled.count;
    });
    logger.info({ batchId, settled: settledCount, by: me.id }, 'temix.batch.mark_loaded');
    revalidatePath('/temix');
  });
}
