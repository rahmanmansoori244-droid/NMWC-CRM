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

/**
 * Interactive-transaction limits for suites that run against UAT from Oman. A
 * round trip there is about 0.3 s, so Prisma's defaults (5 s to finish, 2 s to get
 * a connection) are used up by a dozen statements or a cold connect, and the
 * transaction is closed under the test. Generous on purpose: a real lock wait
 * still fails on its own lock_timeout.
 */
export const REMOTE_TX = { timeout: 60_000, maxWait: 15_000 } as const;

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
    }, REMOTE_TX);
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

/**
 * Export records (lossless paths, gap 14): ExportJob is append-only, and its rows
 * name the user who exported (RESTRICT), so a suite that exports purges them
 * before deleting that user.
 */
export function purgeExportJobs(prisma: PrismaClient, args: Prisma.ExportJobDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.exportJob.deleteMany(args));
}

/** The world ids whose dated history a suite's teardown removes (gap 6, docs/HISTORY.md). */
export type HistoryIds = {
  customerIds?: string[];
  branchIds?: string[];
  userIds?: string[];
  routeIds?: string[];
  regionIds?: string[];
  /** Lossless paths: photo history (gap 15) and new-customer request rounds (gap 12). */
  attachmentIds?: string[];
  editIds?: string[];
};

/**
 * Remove the dated history of a suite's own fixtures, in the owner's maintenance
 * window (the history refuses DELETE otherwise, like AuditLog). Call it LAST in a
 * teardown: deleting the fixtures themselves writes DELETE tombstones. Only ids the
 * suite created — the history of anything else is that record's permanent record.
 */
export function purgeHistory(prisma: PrismaClient, ids: HistoryIds) {
  const inList = (xs: string[] | undefined) => ({ in: xs ?? [] });
  return withAuditMaintenance(prisma, async (tx) => ({
    customer: (await tx.customerHistory.deleteMany({ where: { customerId: inList(ids.customerIds) } })).count,
    branch: (await tx.branchHistory.deleteMany({ where: { branchId: inList(ids.branchIds) } })).count,
    user: (await tx.userHistory.deleteMany({ where: { userId: inList(ids.userIds) } })).count,
    routeOwner: (await tx.routeOwnerHistory.deleteMany({ where: { routeId: inList(ids.routeIds) } })).count,
    route: (await tx.routeHistory.deleteMany({ where: { routeId: inList(ids.routeIds) } })).count,
    region: (await tx.regionHistory.deleteMany({ where: { regionId: inList(ids.regionIds) } })).count,
    attachment: (await tx.attachmentHistory.deleteMany({ where: { attachmentId: inList(ids.attachmentIds) } })).count,
    revision: (await tx.editRevision.deleteMany({ where: { editId: inList(ids.editIds) } })).count,
    // Part C (gap 23): the suite's accounts' sign-in events and session cut-offs.
    authEvent: (await tx.authEvent.deleteMany({ where: { userId: inList(ids.userIds) } })).count,
  }));
}

/**
 * Part C (gap 23): sign-in events a suite caused that name no account (a failure
 * on a name nobody has, a throttle refusal), found by the name's fingerprint.
 */
export function purgeAuthEvents(prisma: PrismaClient, args: Prisma.AuthEventDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.authEvent.deleteMany(args));
}

/** Part C (gap 21): the day rows a suite's own scheduled-job runs were summarised into. */
export function purgeJobRunDays(prisma: PrismaClient, args: Prisma.JobRunDayDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.jobRunDay.deleteMany(args));
}

/** Gap 25: the purge summaries a suite's own synthetic purges wrote. */
export function purgePurgeSummaries(prisma: PrismaClient, args: Prisma.PurgeSummaryDeleteManyArgs) {
  return withAuditMaintenance(prisma, (tx) => tx.purgeSummary.deleteMany(args));
}
