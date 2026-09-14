/**
 * B4: "AuditLog" and "EditApproval" are append-only at the database (a trigger
 * refuses UPDATE / DELETE / TRUNCATE — prisma/migrations/20260914150000_audit_immutability,
 * hardened by 20260914160000_audit_maintenance_owner_only so that ONLY a session
 * logged in as the table owner may open a maintenance window with
 * `SET LOCAL nmwc.audit_maintenance = 'on'`).
 *
 * Test clean-up legitimately removes the rows its fixtures created, so it runs
 * that maintenance transaction on the OWNER credential (`DIRECT_URL`) — not on
 * the client the suite passes in, which after the role rollout is the
 * least-privilege `nmwc_app` (`DATABASE_URL`) and can neither delete the rows
 * nor use the override. A fresh owner client is opened per call and closed
 * afterwards, so nothing leaks past the purge; when `DIRECT_URL` is not set the
 * passed client is used (local set-ups that still run everything as the owner).
 */
import { PrismaClient, type Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const PROD_MARKER = 'ep-sweet-haze';

function ownerUrl(): string | null {
  const url = process.env.DIRECT_URL;
  if (!url) return null;
  if (url.includes(PROD_MARKER)) throw new Error('ABORT: DIRECT_URL points at production');
  return url;
}

/** Run `fn` inside a transaction that may mutate the append-only audit tables. */
export async function withAuditMaintenance<T>(
  prisma: PrismaClient,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  const url = ownerUrl();
  const run = (client: PrismaClient) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
      return fn(tx);
    });
  if (!url) return run(prisma);
  const owner = new PrismaClient({ datasourceUrl: url });
  try {
    return await run(owner);
  } finally {
    await owner.$disconnect();
  }
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
