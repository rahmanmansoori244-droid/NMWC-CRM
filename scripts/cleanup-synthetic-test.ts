/**
 * Cleanup after `synthetic-launch-test.ts`. Reads the JSON report it
 * produced and:
 *   1. Reverts the snapshotted customers to their pre-test state.
 *   2. Hard-deletes CustomerEdits + Attachments produced during the test.
 *   3. Deletes AuditLog rows produced during the test window from the
 *      synthetic users (c1, c4, ahmed.alndabi, pilot.manager).
 *   4. Writes a one-row AuditLog entry attributing the cleanup to
 *      pilot.steward so the trail is intact.
 *
 * Run:  npx tsx scripts/cleanup-synthetic-test.ts <report-path>
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

type Report = {
  startedAt: string;
  endedAt: string;
  snapshotPath: string;
  produced: {
    edits: Array<{ id: string }>;
    attachments: Array<{ id: string; r2Key: string }>;
    auditLogRowsCount: number;
  };
};

type Snapshot = {
  snapshotAt: string;
  customers: Array<{
    id: string;
    nmwcCode: string;
    legalName: string;
    primaryPhone: string | null;
    primaryPhoneNorm: string | null;
    contactPerson: string | null;
    notes: string | null;
    status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED';
    version: number;
    branchStatuses: Array<{ id: string; status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED'; lastStatusChangeAt: string | null }>;
  }>;
};

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: cleanup-synthetic-test.ts <report-path>');
    process.exit(1);
  }
  const report: Report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const snap: Snapshot = JSON.parse(readFileSync(report.snapshotPath, 'utf8'));

  console.log('Cleanup target:');
  console.log(`  Test window: ${report.startedAt} → ${report.endedAt}`);
  console.log(`  Edits to delete:        ${report.produced.edits.length}`);
  console.log(`  Attachments to delete:  ${report.produced.attachments.length}`);
  console.log(`  Customers to revert:    ${snap.customers.length}`);

  const steward = await prisma.user.findUniqueOrThrow({ where: { username: 'pilot.steward' } });
  const syntheticUsers = await prisma.user.findMany({
    where: {
      username: { in: ['c1-12345-nmwc', 'c4-12345-nmwc', 'ahmed.alndabi', 'pilot.manager'] },
    },
    select: { id: true, username: true },
  });
  const syntheticUserIds = syntheticUsers.map((u) => u.id);

  await prisma.$transaction(
    async (tx) => {
      // 1. Revert customers
      for (const c of snap.customers) {
        await tx.customer.update({
          where: { id: c.id },
          data: {
            legalName: c.legalName,
            primaryPhone: c.primaryPhone,
            primaryPhoneNorm: c.primaryPhoneNorm,
            contactPerson: c.contactPerson,
            notes: c.notes,
            status: c.status,
          },
        });
        // Revert branch statuses
        for (const b of c.branchStatuses) {
          await tx.branch.update({
            where: { id: b.id },
            data: {
              status: b.status,
              lastStatusChangeAt: b.lastStatusChangeAt ? new Date(b.lastStatusChangeAt) : null,
            },
          });
        }
      }

      // 2. Delete CustomerEdits + any audit rows referencing them
      const editIds = report.produced.edits.map((e) => e.id);
      if (editIds.length > 0) {
        await tx.auditLog.deleteMany({
          where: { entityType: 'CustomerEdit', entityId: { in: editIds } },
        });
        await tx.customerEdit.deleteMany({ where: { id: { in: editIds } } });
      }

      // 3. Detach + delete attachments
      const attIds = report.produced.attachments.map((a) => a.id);
      if (attIds.length > 0) {
        // Clear FK slots first
        await tx.customer.updateMany({
          where: { crPhotoId: { in: attIds } },
          data: { crPhotoId: null },
        });
        await tx.branch.updateMany({
          where: { shopPhotoId: { in: attIds } },
          data: { shopPhotoId: null },
        });
        await tx.branch.updateMany({
          where: { signboardPhotoId: { in: attIds } },
          data: { signboardPhotoId: null },
        });
        await tx.attachment.deleteMany({ where: { id: { in: attIds } } });
      }

      // 4. Delete audit-log rows from synthetic users in the test window.
      // Keep one summary row attributing the cleanup to the steward.
      await tx.auditLog.deleteMany({
        where: {
          actorId: { in: syntheticUserIds },
          at: { gte: new Date(report.startedAt), lte: new Date(report.endedAt) },
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: steward.id,
          action: 'DELETE',
          entityType: 'SyntheticTestData',
          entityId: report.startedAt,
          reason: 'Cleaned up synthetic load-test artifacts',
          after: {
            window: { from: report.startedAt, to: report.endedAt },
            editsDeleted: editIds.length,
            attachmentsDeleted: attIds.length,
            customersReverted: snap.customers.length,
          },
        },
      });
    },
    { timeout: 60_000 }
  );

  console.log('\nCleanup complete.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
