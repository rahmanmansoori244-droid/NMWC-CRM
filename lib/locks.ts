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
 * `temixCode` is what the caller read before its transaction: the caller re-reads
 * the customer under this lock and refuses if the code has moved since.
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
