/**
 * The daily Temix import, stage 6 (review 2026-11-15): THE ONE WRITER OF A
 * TEMIX CODE CONFIRMED BY THE DAILY FILE (the merged plan, finalize item 2).
 *
 * A customer made in the CRM carries the Temix code the Accountant typed at
 * its final approval (lib/create-finalize.ts). When a row of a daily file that
 * the apply found as this customer carries that code (lib/temix-daily-finalize.ts
 * planFinalize, `confirms`), Temix has the customer. For each such customer,
 * inside finalize's transaction (services/temix-daily-apply.ts), after the
 * notices and before the file is LOADED:
 *
 *  1. Customer.temixSyncState UPLOADED to SYNCED, and nothing else, as the
 *     Import screen's refresh lane does (services/imports.ts). Guarded: only a
 *     customer still UPLOADED, live, not a test customer, and still holding
 *     the very code the row confirmed. A correction approved after the last
 *     batch (PENDING_UPLOAD) keeps its place in the queue; a customer already
 *     SYNCED is not confirmed twice; nothing is put back in the Temix queue.
 *  2. Only when it flipped: one AuditLog UPDATE row on the Customer (the state
 *     before and after, with the file's lineage), one applied ledger row
 *     (TemixChange TEMIX_CODE_CONFIRMED, the states from and to), and
 *     TEMIX_SYNC_ACKED to the salesman who sent the request (createdById), as
 *     the plan asks. The refresh lane sends it only when the CRM had no Temix
 *     code before, so for an Accountant-typed code it never would: whether the
 *     owner wants it in this case too is listed for him (docs/OPERATIONS.md §7).
 *
 * Each customer is written under its row's change context
 * (src.temixDaily(file, row), dated the load day); the caller sets its own
 * context back afterwards. Running it again writes nothing: the customer is
 * SYNCED.
 */
import { AuditAction, type Prisma } from '@prisma/client';
import { writeAudit, type AuditEnvelope } from './audit';
import { setChangeContext, src } from './change-context';
import { notifyUsers } from './notifications';
import type { Confirm } from './temix-daily-finalize';

type Tx = Prisma.TransactionClient;

/** The reason of every confirmation's audit row: 'temix-daily <file> row <n>'. */
export function confirmAuditReason(fileId: string, rowNumber: number): string {
  return `temix-daily ${fileId} row ${rowNumber}`;
}

/** Writes the confirmations of one file; returns how many customers went UPLOADED to SYNCED. */
export async function confirmAccountantCodes(
  tx: Tx,
  env: AuditEnvelope,
  file: { id: string; loadDay: string },
  confirms: readonly Confirm[]
): Promise<number> {
  if (confirms.length === 0) return 0;
  // Read first: only the customers still waiting for Temix's word are written.
  const waiting = await tx.customer.findMany({
    where: { id: { in: confirms.map((c) => c.customerId) }, temixSyncState: 'UPLOADED', deletedAt: null, mergedIntoId: null, isTest: false },
    select: { id: true, nmwcCode: true, legalName: true, temixCode: true, createdById: true },
  });
  const byId = new Map(waiting.map((c) => [c.id, c]));
  let flipped = 0;
  for (const k of confirms) {
    const c = byId.get(k.customerId);
    if (!c || c.temixCode !== k.temixCode) continue;
    await setChangeContext(tx, { actorId: env.actorId, source: src.temixDaily(file.id, k.rowNumber), effectiveFrom: file.loadDay });
    const written = await tx.customer.updateMany({
      where: { id: c.id, temixSyncState: 'UPLOADED', temixCode: k.temixCode, deletedAt: null, mergedIntoId: null, isTest: false },
      data: { temixSyncState: 'SYNCED' },
    });
    if (written.count !== 1) continue;
    flipped++;
    await writeAudit(tx, env, {
      action: AuditAction.UPDATE,
      entityType: 'Customer',
      entityId: c.id,
      before: { temixSyncState: 'UPLOADED' },
      after: { temixSyncState: 'SYNCED', lineage: { fileId: file.id, rowId: k.rowId, rowNumber: k.rowNumber, loadDay: file.loadDay } },
      reason: confirmAuditReason(file.id, k.rowNumber),
    });
    await tx.temixChange.create({
      data: {
        fileId: file.id,
        rowId: k.rowId,
        loadDay: new Date(`${file.loadDay}T00:00:00Z`),
        kind: 'TEMIX_CODE_CONFIRMED',
        applied: true,
        customerId: c.id,
        branchId: null,
        field: 'temixSyncState',
        fromValue: 'UPLOADED',
        toValue: 'SYNCED',
        detailCode: null,
      },
    });
    if (c.createdById) {
      await notifyUsers(tx, [c.createdById], {
        kind: 'TEMIX_SYNC_ACKED',
        title: 'Customer landed in Temix',
        body: `${c.legalName} (${c.nmwcCode}) is now in Temix as ${k.temixCode}.`,
        customerId: c.id,
      });
    }
  }
  return flipped;
}
