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
import type { Prisma } from '@prisma/client';

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
