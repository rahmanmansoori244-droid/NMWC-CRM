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
