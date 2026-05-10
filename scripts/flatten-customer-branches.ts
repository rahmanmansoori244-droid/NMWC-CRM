/**
 * P1.2 — flatten the customer master so every Customer has exactly one
 * Branch. This matches NMWC's real data model: each row in the source xlsx
 * is a unique customer, even when several rows share a "parent" code prefix.
 *
 * Today (post-synthetic-wipe):  3,239 customers, 3,308 branches.
 *   3,170 already have 1 branch (no-op for these).
 *      69 have 2 branches (created by an over-eager seed grouping).
 *
 * After this script:           3,308 customers, 3,308 branches (1:1).
 *
 * For each customer with N>1 branches:
 *   1. Keep the customer + the FIRST branch (alphabetical by branchCode).
 *   2. For branches 2..N, create a new Customer row that "inherits" from
 *      the parent (legalName, paymentTerms, channel, contactPerson, etc.)
 *      with `nmwcCode` set to that branch's branchCode (the unique
 *      identifier that came from the source xlsx).
 *   3. Reassign that branch's customerId to the new customer.
 *   4. Reassign any CustomerEdit / Attachment / customer-level photo slot
 *      that referenced (parent, that-branch) so the edit history follows
 *      the branch.
 *
 * Reversibility: the script writes a JSON map of (oldCustomerId, branchId,
 * newCustomerId, newNmwcCode) to docs/audit/flatten-map-<DATE>.json
 * BEFORE making any changes. If we need to undo, the map plus the original
 * Neon PITR (7 days) gets us back.
 *
 * Run:  npx tsx scripts/flatten-customer-branches.ts
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

type FlattenAction = {
  parentCustomerId: string;
  parentNmwcCode: string;
  branchId: string;
  branchCode: string;
  newCustomerId: string;
  newNmwcCode: string;
};

async function main() {
  console.log('=== P1.2 customer-branch flatten ===');

  // 1. Find customers with >1 branch.
  const groups = await prisma.$queryRaw<Array<{ customerId: string; branch_count: number }>>`
    SELECT "customerId", COUNT(*)::int AS branch_count
    FROM "Branch"
    WHERE "deletedAt" IS NULL
    GROUP BY "customerId"
    HAVING COUNT(*) > 1
    ORDER BY "customerId"
  `;
  console.log(`\nFound ${groups.length} customers with >1 branch.`);
  if (groups.length === 0) {
    console.log('Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  // 2. Plan the splits. For each multi-branch customer, fetch its branches
  // (sorted by branchCode) and build the action list.
  const plan: FlattenAction[] = [];
  for (const g of groups) {
    const cust = await prisma.customer.findUniqueOrThrow({
      where: { id: g.customerId },
      include: {
        branches: {
          where: { deletedAt: null },
          orderBy: { branchCode: 'asc' },
        },
      },
    });
    // Skip the first branch (it stays with the parent customer).
    for (let i = 1; i < cust.branches.length; i++) {
      const b = cust.branches[i];
      plan.push({
        parentCustomerId: cust.id,
        parentNmwcCode: cust.nmwcCode,
        branchId: b.id,
        branchCode: b.branchCode,
        newCustomerId: '', // filled in during execution
        newNmwcCode: b.branchCode, // use the branchCode as the unique key — already unique in DB
      });
    }
  }
  console.log(`Plan: ${plan.length} new customers will be created.`);

  // 3. Save the reversibility map.
  mkdirSync('docs/audit', { recursive: true });
  const mapPath = join(
    'docs/audit',
    `flatten-map-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  );
  writeFileSync(mapPath, JSON.stringify({ executedAt: new Date().toISOString(), plan }, null, 2));
  console.log(`Reversibility map saved: ${mapPath}`);

  // 4. Steward
  const steward = await prisma.user.findUniqueOrThrow({
    where: { username: 'pilot.steward' },
    select: { id: true },
  });

  // 5. Execute. Single transaction so partial failure rolls back.
  console.log('\nExecuting...');
  let createdCustomers = 0;
  let reassignedBranches = 0;
  let reassignedEdits = 0;
  let reassignedAttachments = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const action of plan) {
        // Read parent each time so latest data is used (in case of edits in flight)
        const parent = await tx.customer.findUniqueOrThrow({
          where: { id: action.parentCustomerId },
        });

        // Check for nmwcCode uniqueness (newNmwcCode = branchCode, which is
        // already unique on the Branch table — should never collide on Customer
        // unless we're re-running).
        const existing = await tx.customer.findUnique({
          where: { nmwcCode: action.newNmwcCode },
          select: { id: true },
        });
        if (existing) {
          // Already split — skip silently.
          continue;
        }

        // Create the new customer cloned from the parent.
        const newCust = await tx.customer.create({
          data: {
            nmwcCode: action.newNmwcCode,
            legalName: parent.legalName,
            paymentTerms: parent.paymentTerms,
            crNumber: parent.crNumber,
            crNumberNorm: parent.crNumberNorm,
            channelId: parent.channelId,
            subChannelId: parent.subChannelId,
            primaryPhone: parent.primaryPhone,
            primaryPhoneNorm: parent.primaryPhoneNorm,
            altPhone: parent.altPhone,
            contactPerson: parent.contactPerson,
            contactRole: parent.contactRole,
            status: parent.status,
            notes: parent.notes,
            completenessScore: parent.completenessScore,
            createdById: steward.id,
            lastEditedById: steward.id,
          },
        });
        action.newCustomerId = newCust.id;
        createdCustomers++;

        // Reassign the branch.
        await tx.branch.update({
          where: { id: action.branchId },
          data: { customerId: newCust.id, lastEditedById: steward.id },
        });
        reassignedBranches++;

        // Reassign any CustomerEdit that points at this specific branch.
        const editUpdate = await tx.customerEdit.updateMany({
          where: { branchId: action.branchId, customerId: action.parentCustomerId },
          data: { customerId: newCust.id },
        });
        reassignedEdits += editUpdate.count;

        // Reassign any Attachment that points at this specific branch.
        const attachUpdate = await tx.attachment.updateMany({
          where: {
            OR: [{ branchId: action.branchId }, { branchExtraId: action.branchId }],
            customerId: action.parentCustomerId,
          },
          data: { customerId: newCust.id },
        });
        reassignedAttachments += attachUpdate.count;
      }

      // One summary audit row.
      await tx.auditLog.create({
        data: {
          actorId: steward.id,
          action: 'UPDATE',
          entityType: 'CustomerMaster',
          entityId: 'P1.2-flatten-2026-05-10',
          reason: 'Flattened sub-branches into independent customers (1:1 with branches)',
          after: {
            createdCustomers,
            reassignedBranches,
            reassignedEdits,
            reassignedAttachments,
            reversibilityMap: mapPath,
          },
        },
      });
    },
    { timeout: 120_000 }
  );

  console.log(`\nFlatten complete:`);
  console.log(`  New customers created:     ${createdCustomers}`);
  console.log(`  Branches reassigned:       ${reassignedBranches}`);
  console.log(`  Edits reassigned:          ${reassignedEdits}`);
  console.log(`  Attachments reassigned:    ${reassignedAttachments}`);

  // Save the updated map (with newCustomerId now filled).
  writeFileSync(mapPath, JSON.stringify({ executedAt: new Date().toISOString(), plan }, null, 2));

  // Verify final state.
  const finalDist = await prisma.$queryRaw<Array<{ branch_count: number; num_customers: number }>>`
    SELECT branch_count, COUNT(*)::int AS num_customers
    FROM (SELECT "customerId", COUNT(*) AS branch_count
          FROM "Branch" WHERE "deletedAt" IS NULL GROUP BY "customerId") t
    GROUP BY branch_count ORDER BY branch_count
  `;
  const finalCust = await prisma.customer.count({ where: { deletedAt: null } });
  const finalBr = await prisma.branch.count({ where: { deletedAt: null } });
  console.log(`\nFinal state: ${finalCust} customers, ${finalBr} branches`);
  for (const r of finalDist) {
    console.log(`  ${r.branch_count} branch: ${r.num_customers} customer(s)`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Flatten failed:', err);
  process.exit(1);
});
