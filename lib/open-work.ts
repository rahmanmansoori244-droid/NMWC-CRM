/**
 * Gap 37: read a person's open work for the hand-over record (lib/account-edit.ts
 * openWorkRecord), inside the caller's transaction, after any withdrawals it
 * made, so the record says what was left as the change committed.
 *
 * Server only: it reads through the caller's transaction.
 */
import { EditState, type Prisma } from '@prisma/client';
import { openWorkRecord, type OpenWork } from './account-edit';
import { openReturnedIds } from './returned-work';

export async function loadOpenWork(tx: Prisma.TransactionClient, userId: string, withdrawn: readonly string[] = []): Promise<OpenWork> {
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const inReview = ids(await tx.customerEdit.findMany({ where: { submittedById: userId, state: EditState.SUBMITTED }, select: { id: true } }));
  const drafts = ids(await tx.customerEdit.findMany({ where: { submittedById: userId, state: EditState.DRAFT }, select: { id: true } }));
  const sentBack = await openReturnedIds(tx, userId);
  // Photos he took that sit on no customer, shop, extra slot or request.
  const unattachedPhotos = await tx.attachment.count({
    where: { capturedById: userId, deletedAt: null, customerId: null, branchId: null, branchExtraId: null, editId: null },
  });
  return openWorkRecord({ inReview, drafts, sentBack, withdrawn, unattachedPhotos });
}
