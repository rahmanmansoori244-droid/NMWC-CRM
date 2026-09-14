/**
 * B4: "AuditLog" and "EditApproval" are append-only at the database (a trigger
 * refuses UPDATE / DELETE / TRUNCATE — prisma/migrations/20260914150000_audit_immutability).
 * Test clean-up legitimately removes the rows its fixtures created, so it opens
 * a maintenance transaction: `SET LOCAL nmwc.audit_maintenance = 'on'` scoped to
 * that transaction only. The production runtime role has no DELETE privilege on
 * these tables, so this bypass is only ever available to the owner credential
 * the suites run under.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Run `fn` inside a transaction that may mutate the append-only audit tables. */
export async function withAuditMaintenance<T>(
  prisma: PrismaClient,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
    return fn(tx);
  });
}

export function purgeAuditLog(prisma: PrismaClient, args: Prisma.AuditLogDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.auditLog.deleteMany(args));
}

export function purgeEditApprovals(prisma: PrismaClient, args: Prisma.EditApprovalDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.editApproval.deleteMany(args));
}

/** Delete edits together with their step ledger (the FK cascade fires the trigger otherwise). */
export function purgeCustomerEdits(prisma: PrismaClient, args: Prisma.CustomerEditDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.customerEdit.deleteMany(args));
}
