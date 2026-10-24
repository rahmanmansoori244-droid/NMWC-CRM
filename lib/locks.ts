/**
 * One lock order for a customer and its branches: the Customer row first.
 *
 * Photo attach and Remove take the customer's row lock before they touch a
 * branch (services/photos.ts), so two photos landing together from one phone
 * cannot save a completeness score that leaves one of them out. Any other
 * transaction that writes a branch and then its customer — approving an edit,
 * approving a reactivation, a branch-only import — takes the same lock first,
 * or the two orders deadlock on the same branch (pre-merge review of eb1a430).
 */
import { Prisma } from '@prisma/client';
import { NotFoundError } from './errors';

export async function lockCustomerRow(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
}

/**
 * The same lock, for a caller that knows the customer by its code (the import
 * promote). Returns the locked customer's id, or null when no customer has the
 * code. Archived customers are locked too: the caller has to see them.
 */
export async function lockCustomerRowByCode(
  tx: Prisma.TransactionClient,
  nmwcCode: string
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Customer" WHERE "nmwcCode" = ${nmwcCode} FOR UPDATE`;
  return rows[0]?.id ?? null;
}

/**
 * F11: lock `customerIds` together with every LIVE customer that holds
 * `temixCode`, in one id order (byte order, the order a JS sort gives, so a
 * caller that also locks by a sorted loop cannot cross it).
 *
 * Archive and merge take this before they decide whether a customer leaving the
 * master takes its Temix code with it (lib/temix.ts liveTemixCodeHolders). With
 * the holders locked, two customers sharing one code cannot both leave at once
 * each believing the other still holds it — which would drop the deactivation
 * for good — and a holder archived meanwhile is seen as archived. A holder that
 * was archived while this waited drops out of the lock, as it should.
 * `temixCode` is the code the customer leaving would deactivate, from what the
 * caller read before its transaction (lib/temix.ts deactivationCode: its customer
 * code when it has no Temix code): the caller re-reads the customer under this
 * lock and refuses if its Temix code has moved since.
 */
export async function lockCustomersAndTemixCodeHolders(
  tx: Prisma.TransactionClient,
  customerIds: string[],
  temixCode: string | null
): Promise<void> {
  const ids = Prisma.join([...new Set(customerIds)].sort());
  if (temixCode) {
    await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" IN (${ids}) OR ("temixCode" = ${temixCode} AND "deletedAt" IS NULL) ORDER BY "id" COLLATE "C" FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" IN (${ids}) ORDER BY "id" COLLATE "C" FOR UPDATE`;
  }
}

/**
 * The Temix queue (lib/temix.ts TEMIX_QUEUE_WHERE, the same two lanes), locked in
 * the id order lockCustomersAndTemixCodeHolders uses, before Generate claims it.
 * Generate's claim is one UPDATE, which locks rows in whatever order its scan
 * meets them: an archive or merge locking a customer and a queued live holder of
 * its code could then hold one of the pair while waiting for the other, and
 * Postgres aborts one side as a deadlock (review of 023173c). Returns the ids
 * locked; Generate claims only those, so no customer lock of its own is taken out
 * of this order, and a customer that joins the queue after this statement waits
 * for the next batch. A test customer is never in the queue (gap 30).
 */
export async function lockTemixQueue(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Customer" WHERE (("temixSyncState" = 'PENDING_UPLOAD' AND "deletedAt" IS NULL) OR "temixSyncState" = 'DEACTIVATE_PENDING') AND NOT "isTest" ORDER BY "id" COLLATE "C" FOR UPDATE`;
  return rows.map((r) => r.id);
}

/** What a request sent on a customer archived a moment earlier is told (gap 37). */
export const CUSTOMER_ARCHIVED_MESSAGE = 'This customer was archived while this was being sent, so nothing was sent.';

/**
 * Gap 37: the customer's row lock (above), then its deletedAt read again under
 * it. Every transaction that writes a request on a customer takes this before
 * its insert; the archive takes the same lock before it checks for a request in
 * review (services/customers.ts), so the two serialise: an archive that
 * committed while this waited refuses the request, and a request that committed
 * first makes the archive refuse.
 */
export async function lockLiveCustomer(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await lockCustomerRow(tx, customerId);
  const now = await tx.customer.findUnique({ where: { id: customerId }, select: { deletedAt: true } });
  if (!now || now.deletedAt) throw new NotFoundError(CUSTOMER_ARCHIVED_MESSAGE);
}
