/**
 * P1.1 — wipe the synthetic test data that lingered in production after
 * the Muscat-only pilot seed was added.
 *
 * What's synthetic:
 *   - 6 regions: BATINAH_N, BATINAH_S, DAKHILIYAH, SHARQIYAH, DHAHIRAH, DHOFAR
 *   - All routes inside those regions (~30 routes: BTN-*, BTS-*, DKH-*, SHQ-*,
 *     DHR-*, DHF-*, plus MCT-* which were synthetic Muscat routes — NOT the
 *     real C1/C4/C6/C7/C12/C13/C14/C15/MH01/MH02 pilot routes)
 *   - All branches in those routes (~95)
 *   - All Customer rows whose ONLY branches are in those routes
 *   - All synthetic salesman.<route> users
 *
 * Real pilot data we keep (Muscat region only):
 *   - Region: MUSCAT
 *   - Routes: C1, C4, C6, C7, C12, C13, C14, C15, MH01, MH02
 *   - 3,334 customers, 3,328 Muscat branches
 *   - Users: pilot.manager, pilot.steward, ahmed.alndabi, c1..c15..mh02 salesmen
 *
 * Order of deletion (FK-safe):
 *   1. AuditLog rows authored by synthetic users
 *   2. CustomerEdit rows authored by synthetic users (where branchId/customerId in scope)
 *   3. Attachment rows captured by synthetic users
 *   4. Branch rows in synthetic routes
 *   5. Customer rows whose only branches were synthetic (now have zero branches)
 *   6. Synthetic User rows
 *   7. Synthetic Route rows
 *   8. Synthetic Region rows
 *
 * Writes ONE summary AuditLog row at the end attributing the cleanup to
 * pilot.steward.
 *
 * Run:  npx tsx scripts/wipe-synthetic-data.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const SYNTHETIC_REGION_CODES = [
  'BATINAH_N',
  'BATINAH_S',
  'DAKHILIYAH',
  'SHARQIYAH',
  'DHAHIRAH',
  'DHOFAR',
];

// MCT-* routes were synthetic — the REAL Muscat pilot uses C* and MH* codes.
const SYNTHETIC_MUSCAT_ROUTE_PREFIXES = ['MCT-'];

async function main() {
  console.log('=== P1.1 synthetic data wipe ===');

  // 1. Resolve scope
  const synthRegions = await prisma.region.findMany({
    where: { code: { in: SYNTHETIC_REGION_CODES } },
    select: { id: true, code: true },
  });
  const synthRegionIds = synthRegions.map((r) => r.id);

  // Synthetic Muscat routes — these live in the MUSCAT region but are not
  // part of the pilot. Match by code prefix.
  const muscatRegion = await prisma.region.findUniqueOrThrow({
    where: { code: 'MUSCAT' },
    select: { id: true },
  });
  const synthMuscatRoutes = await prisma.route.findMany({
    where: {
      regionId: muscatRegion.id,
      OR: SYNTHETIC_MUSCAT_ROUTE_PREFIXES.map((p) => ({ code: { startsWith: p } })),
    },
    select: { id: true, code: true },
  });

  // All routes in synthetic regions + synthetic Muscat routes
  const allSynthRoutes = await prisma.route.findMany({
    where: { OR: [{ regionId: { in: synthRegionIds } }, { id: { in: synthMuscatRoutes.map((r) => r.id) } }] },
    select: { id: true, code: true, regionId: true },
  });
  const synthRouteIds = allSynthRoutes.map((r) => r.id);

  // Synthetic users — match by username pattern (salesman.<lowercase-route>)
  const synthUsers = await prisma.user.findMany({
    where: { username: { startsWith: 'salesman.' } },
    select: { id: true, username: true, ownedRouteId: true },
  });
  const synthUserIds = synthUsers.map((u) => u.id);

  // Branches in synthetic routes
  const synthBranches = await prisma.branch.findMany({
    where: { routeId: { in: synthRouteIds } },
    select: { id: true, customerId: true, branchCode: true },
  });
  const synthBranchIds = synthBranches.map((b) => b.id);
  const candidateCustomerIds = [...new Set(synthBranches.map((b) => b.customerId))];

  // Customers that have ONLY synthetic branches (i.e. no Muscat-pilot branches)
  const customersToDelete: string[] = [];
  if (candidateCustomerIds.length > 0) {
    const realBranchCounts = await prisma.branch.groupBy({
      by: ['customerId'],
      where: {
        customerId: { in: candidateCustomerIds },
        routeId: { notIn: synthRouteIds },
        deletedAt: null,
      },
      _count: { _all: true },
    });
    const customersWithRealBranches = new Set(realBranchCounts.map((r) => r.customerId));
    for (const cid of candidateCustomerIds) {
      if (!customersWithRealBranches.has(cid)) customersToDelete.push(cid);
    }
  }

  console.log('\nScope of wipe:');
  console.log(`  Regions:         ${synthRegions.length}  (${synthRegions.map((r) => r.code).join(', ')})`);
  console.log(`  Routes:          ${allSynthRoutes.length}  (${allSynthRoutes.map((r) => r.code).slice(0, 8).join(', ')}${allSynthRoutes.length > 8 ? ', …' : ''})`);
  console.log(`  Branches:        ${synthBranchIds.length}`);
  console.log(`  Customers:       ${customersToDelete.length}  (those with only synthetic branches)`);
  console.log(`  Synthetic users: ${synthUserIds.length}`);

  if (
    synthRegions.length === 0 &&
    allSynthRoutes.length === 0 &&
    synthBranchIds.length === 0 &&
    synthUserIds.length === 0
  ) {
    console.log('\nNo synthetic data found. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  // 2. Steward
  const steward = await prisma.user.findUniqueOrThrow({
    where: { username: 'pilot.steward' },
    select: { id: true },
  });

  // 3. Execute in a single transaction so partial failure rolls back.
  console.log('\nExecuting (one transaction, increased timeout)...');
  const summary = await prisma.$transaction(
    async (tx) => {
      let auditLogsDeleted = 0;
      let editsDeleted = 0;
      let attachmentsDeleted = 0;
      let attachmentSlotsCleared = 0;

      // 3a. Audit logs by synthetic users
      if (synthUserIds.length > 0) {
        const r = await tx.auditLog.deleteMany({ where: { actorId: { in: synthUserIds } } });
        auditLogsDeleted = r.count;
      }

      // 3b. Customer edits by synthetic users + edits referencing synthetic branches/customers
      if (synthUserIds.length > 0 || synthBranchIds.length > 0 || customersToDelete.length > 0) {
        const r = await tx.customerEdit.deleteMany({
          where: {
            OR: [
              { submittedById: { in: synthUserIds } },
              { reviewedById: { in: synthUserIds } },
              { branchId: { in: synthBranchIds } },
              { customerId: { in: customersToDelete } },
            ],
          },
        });
        editsDeleted = r.count;
      }

      // 3c. Clear attachment foreign keys on customers/branches we're about to delete
      // so we don't violate FK constraints.
      if (customersToDelete.length > 0) {
        const cu = await tx.customer.updateMany({
          where: { id: { in: customersToDelete }, crPhotoId: { not: null } },
          data: { crPhotoId: null },
        });
        attachmentSlotsCleared += cu.count;
      }
      if (synthBranchIds.length > 0) {
        const bsh = await tx.branch.updateMany({
          where: { id: { in: synthBranchIds }, shopPhotoId: { not: null } },
          data: { shopPhotoId: null },
        });
        const bsg = await tx.branch.updateMany({
          where: { id: { in: synthBranchIds }, signboardPhotoId: { not: null } },
          data: { signboardPhotoId: null },
        });
        attachmentSlotsCleared += bsh.count + bsg.count;
      }

      // 3d. Delete attachments captured by synthetic users + attachments tied to synthetic branches
      if (synthUserIds.length > 0 || synthBranchIds.length > 0) {
        const r = await tx.attachment.deleteMany({
          where: {
            OR: [
              { capturedById: { in: synthUserIds } },
              { branchId: { in: synthBranchIds } },
              { branchExtraId: { in: synthBranchIds } },
              { customerId: { in: customersToDelete } },
            ],
          },
        });
        attachmentsDeleted = r.count;
      }

      // 3e. Branches
      let branchesDeleted = 0;
      if (synthBranchIds.length > 0) {
        const r = await tx.branch.deleteMany({ where: { id: { in: synthBranchIds } } });
        branchesDeleted = r.count;
      }

      // 3f. Customers (now that their branches are gone)
      let customersDeleted = 0;
      if (customersToDelete.length > 0) {
        const r = await tx.customer.deleteMany({ where: { id: { in: customersToDelete } } });
        customersDeleted = r.count;
      }

      // 3g. Users — clear ownedRouteId first so route delete doesn't violate
      if (synthUserIds.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: synthUserIds } },
          data: { ownedRouteId: null },
        });
      }
      let usersDeleted = 0;
      if (synthUserIds.length > 0) {
        const r = await tx.user.deleteMany({ where: { id: { in: synthUserIds } } });
        usersDeleted = r.count;
      }

      // 3h. Routes
      let routesDeleted = 0;
      if (synthRouteIds.length > 0) {
        const r = await tx.route.deleteMany({ where: { id: { in: synthRouteIds } } });
        routesDeleted = r.count;
      }

      // 3i. Regions (only the synthetic ones — leave MUSCAT alone)
      let regionsDeleted = 0;
      if (synthRegionIds.length > 0) {
        const r = await tx.region.deleteMany({ where: { id: { in: synthRegionIds } } });
        regionsDeleted = r.count;
      }

      // 3j. One summary audit log row
      await tx.auditLog.create({
        data: {
          actorId: steward.id,
          action: 'DELETE',
          entityType: 'SyntheticData',
          entityId: 'P1.1-2026-05-10',
          reason: 'Wiped synthetic test data ahead of pilot rollout',
          after: {
            regionsDeleted,
            routesDeleted,
            branchesDeleted,
            customersDeleted,
            usersDeleted,
            attachmentsDeleted,
            attachmentSlotsCleared,
            editsDeleted,
            auditLogsDeleted,
            regionCodes: synthRegions.map((r) => r.code),
            routeCodes: allSynthRoutes.map((r) => r.code),
            usernames: synthUsers.map((u) => u.username),
          },
        },
      });

      return {
        regionsDeleted,
        routesDeleted,
        branchesDeleted,
        customersDeleted,
        usersDeleted,
        attachmentsDeleted,
        attachmentSlotsCleared,
        editsDeleted,
        auditLogsDeleted,
      };
    },
    { timeout: 60_000 }
  );

  console.log('\nWipe complete:');
  console.log(`  Regions:        ${summary.regionsDeleted}`);
  console.log(`  Routes:         ${summary.routesDeleted}`);
  console.log(`  Branches:       ${summary.branchesDeleted}`);
  console.log(`  Customers:      ${summary.customersDeleted}`);
  console.log(`  Users:          ${summary.usersDeleted}`);
  console.log(`  Attachments:    ${summary.attachmentsDeleted} (+ ${summary.attachmentSlotsCleared} slots cleared)`);
  console.log(`  Edits:          ${summary.editsDeleted}`);
  console.log(`  Audit log rows: ${summary.auditLogsDeleted}`);

  // Verify
  const finalCustomers = await prisma.customer.count({ where: { deletedAt: null } });
  const finalBranches = await prisma.branch.count({ where: { deletedAt: null } });
  const finalRegions = await prisma.region.count();
  const finalRoutes = await prisma.route.count();
  console.log(`\nFinal state:  ${finalCustomers} customers, ${finalBranches} branches, ${finalRegions} regions, ${finalRoutes} routes.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Wipe failed:', err);
  process.exit(1);
});
