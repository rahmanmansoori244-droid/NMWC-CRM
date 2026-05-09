/**
 * Synthetic test data generator — builds a realistic but fake NMWC dataset
 * for development and testing. Idempotent (truncates demo data first).
 *
 * Scenarios covered (so the UI can be tested for every state):
 * 1. Customers with full data (high completeness)
 * 2. Customers with only basic fields (low completeness, partial)
 * 3. Customers with NO enrichment yet (just imported skeleton — score = 0)
 * 4. Multi-branch customers spanning multiple routes/regions
 * 5. Cash vs Credit (Credit has name/CR locked for salesman)
 * 6. CLOSED shops (with photo evidence simulated via attachment)
 * 7. SUSPENDED customers
 * 8. Customers with pending CustomerEdit (SUBMITTED) waiting for supervisor
 * 9. Customers with REJECTED edit (in salesman's "Needs correction")
 * 10. Customers with APPROVED edit history
 * 11. Customers across all 7 channels with valid sub-channel pairing
 * 12. Customers across all 7 regions
 * 13. Customers without GPS, without photos, without CR (mixed gaps)
 * 14. Same parent customer with same phone on multiple branches (allowed)
 *
 * Run with:  npm run db:synthetic
 */
import { PrismaClient, Role, PaymentTerms, CustomerStatus, DayOfWeek, EditState, EditTarget } from '@prisma/client';
import { faker } from '@faker-js/faker';
import bcrypt from 'bcryptjs';
import { normalizePhone } from '../lib/phone';
import { normalizeCR } from '../lib/cr';
import { scoreCustomer, scoreBranch } from '../lib/completeness';
import { formatCustomerCode, formatBranchCode } from '../lib/codes';

const prisma = new PrismaClient({
  // Long-running seed: use the DIRECT (unpooled) URL to avoid pgBouncer idle timeouts.
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

// Stable seed so re-runs produce same data
faker.seed(20260509);

const REGIONS = [
  { code: 'MUSCAT', name: 'Muscat' },
  { code: 'BATINAH_N', name: 'Batinah North' },
  { code: 'BATINAH_S', name: 'Batinah South' },
  { code: 'DAKHILIYAH', name: 'Dakhiliyah' },
  { code: 'SHARQIYAH', name: 'Sharqiyah' },
  { code: 'DHAHIRAH', name: 'Dhahirah' },
  { code: 'DHOFAR', name: 'Dhofar' },
];

// 38 routes spread across 7 regions
const ROUTES_PER_REGION: Record<string, string[]> = {
  MUSCAT: ['MCT-01', 'MCT-02', 'MCT-03', 'MCT-04', 'MCT-05', 'MCT-06', 'MCT-07', 'MCT-08'],
  BATINAH_N: ['BTN-01', 'BTN-02', 'BTN-03', 'BTN-04', 'BTN-05'],
  BATINAH_S: ['BTS-01', 'BTS-02', 'BTS-03', 'BTS-04', 'BTS-05'],
  DAKHILIYAH: ['DKH-01', 'DKH-02', 'DKH-03', 'DKH-04', 'DKH-05'],
  SHARQIYAH: ['SHQ-01', 'SHQ-02', 'SHQ-03', 'SHQ-04', 'SHQ-05'],
  DHAHIRAH: ['DHR-01', 'DHR-02', 'DHR-03', 'DHR-04'],
  DHOFAR: ['DHF-01', 'DHF-02', 'DHF-03', 'DHF-04', 'DHF-05', 'DHF-06'],
};

// Approximate Oman city coordinates per region (used as base for branch GPS)
const REGION_GPS_BASE: Record<string, [number, number]> = {
  MUSCAT: [23.588, 58.408],
  BATINAH_N: [24.346, 56.732],
  BATINAH_S: [23.785, 57.894],
  DAKHILIYAH: [22.918, 57.532],
  SHARQIYAH: [22.563, 59.532],
  DHAHIRAH: [23.227, 56.520],
  DHOFAR: [17.019, 54.092],
};

const DAYS: DayOfWeek[] = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'];

async function clearSyntheticData() {
  // CASCADE truncate: simpler than juggling FK orders. Keeps schema, drops all rows
  // in the listed tables, then we restore the admin user.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "CustomerEdit",
      "ImportRow",
      "ImportBatch",
      "ExportJob",
      "Attachment",
      "Branch",
      "Customer",
      "Route",
      "Region",
      "User"
    RESTART IDENTITY CASCADE;
  `);

  // Re-create the admin user (it was wiped above)
  const passwordHash = await bcrypt.hash(
    process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeNow!2026',
    12
  );
  await prisma.user.create({
    data: {
      username: 'admin',
      passwordHash,
      fullName: 'NMWC Administrator',
      role: Role.MANAGER,
    },
  });
}

async function seedRegionsAndRoutes() {
  console.log('▸ Seeding regions and routes…');
  for (const r of REGIONS) {
    await prisma.region.upsert({
      where: { code: r.code },
      update: { name: r.name },
      create: { code: r.code, name: r.name },
    });
  }
  for (const region of REGIONS) {
    const regionRow = await prisma.region.findUnique({ where: { code: region.code } });
    if (!regionRow) continue;
    for (const code of ROUTES_PER_REGION[region.code] ?? []) {
      await prisma.route.upsert({
        where: { code },
        update: {},
        create: {
          code,
          name: `${region.name} ${code}`,
          regionId: regionRow.id,
        },
      });
    }
  }
}

async function seedUsers() {
  console.log('▸ Seeding users…');
  const password = await bcrypt.hash('Demo!2026Demo', 12);

  // 2 Managers
  const m1 = await prisma.user.upsert({
    where: { username: 'manager.a' },
    update: {},
    create: {
      username: 'manager.a',
      passwordHash: password,
      fullName: 'Manager Alpha',
      role: Role.MANAGER,
    },
  });
  const m2 = await prisma.user.upsert({
    where: { username: 'manager.b' },
    update: {},
    create: {
      username: 'manager.b',
      passwordHash: password,
      fullName: 'Manager Beta',
      role: Role.MANAGER,
    },
  });

  // Manager region assignments
  const muscatRegions = await prisma.region.findMany({
    where: { code: { in: ['MUSCAT', 'BATINAH_N', 'BATINAH_S', 'DAKHILIYAH'] } },
  });
  const otherRegions = await prisma.region.findMany({
    where: { code: { in: ['SHARQIYAH', 'DHAHIRAH', 'DHOFAR'] } },
  });
  await prisma.user.update({
    where: { id: m1.id },
    data: { managedRegions: { set: muscatRegions.map((r) => ({ id: r.id })) } },
  });
  await prisma.user.update({
    where: { id: m2.id },
    data: { managedRegions: { set: otherRegions.map((r) => ({ id: r.id })) } },
  });

  // 1 Steward
  await prisma.user.upsert({
    where: { username: 'steward' },
    update: {},
    create: {
      username: 'steward',
      passwordHash: password,
      fullName: 'Data Steward',
      role: Role.STEWARD,
    },
  });

  // 1 Viewer
  await prisma.user.upsert({
    where: { username: 'viewer' },
    update: {},
    create: {
      username: 'viewer',
      passwordHash: password,
      fullName: 'Read-Only Viewer',
      role: Role.VIEWER,
    },
  });

  // ~7 Supervisors
  const supervisors = [];
  for (let i = 1; i <= 7; i++) {
    const sup = await prisma.user.upsert({
      where: { username: `supervisor.${i}` },
      update: {},
      create: {
        username: `supervisor.${i}`,
        passwordHash: password,
        fullName: `Supervisor ${i}`,
        role: Role.SUPERVISOR,
        supervisorId: i <= 4 ? m1.id : m2.id,
      },
    });
    supervisors.push(sup);
  }

  // 38 Salesmen — one per route
  const allRoutes = await prisma.route.findMany({});
  for (let i = 0; i < allRoutes.length; i++) {
    const route = allRoutes[i];
    const supervisor = supervisors[i % supervisors.length];
    const username = `salesman.${route.code.toLowerCase()}`;
    const sm = await prisma.user.upsert({
      where: { username },
      update: {},
      create: {
        username,
        passwordHash: password,
        fullName: `Salesman ${route.code}`,
        role: Role.SALESMAN,
        supervisorId: supervisor.id,
      },
    });
    // Assign route ownership (1:1)
    await prisma.user.update({
      where: { id: sm.id },
      data: { ownedRouteId: route.id },
    });
  }
  return { m1, m2, supervisors };
}

type SeedScenario =
  | 'fully_enriched'
  | 'partial'
  | 'skeleton'
  | 'closed'
  | 'suspended'
  | 'pending_approval'
  | 'rejected'
  | 'multi_branch';

async function makeAttachment(
  capturedById: string,
  kind: 'SHOP' | 'SIGNBOARD' | 'CR' | 'FREE',
  refIds: { customerId?: string; branchId?: string; branchExtraId?: string }
) {
  const r2Key = `synthetic/${faker.string.alphanumeric(16)}.jpg`;
  return prisma.attachment.create({
    data: {
      kind,
      r2Key,
      mimeType: 'image/jpeg',
      bytes: faker.number.int({ min: 200_000, max: 2_000_000 }),
      width: 1920,
      height: 1080,
      capturedById,
      capturedAt: faker.date.recent({ days: 30 }),
      capturedLat: faker.number.float({ min: 17, max: 27, fractionDigits: 6 }),
      capturedLng: faker.number.float({ min: 52, max: 60, fractionDigits: 6 }),
      hash: faker.string.hexadecimal({ length: 64, prefix: '' }),
      customerId: refIds.customerId ?? null,
      branchId: refIds.branchId ?? null,
      branchExtraId: refIds.branchExtraId ?? null,
    },
  });
}

async function seedCustomers() {
  console.log('▸ Seeding customers…');
  const channels = await prisma.channel.findMany({ include: { subChannels: true } });
  const allRoutes = await prisma.route.findMany({ include: { region: true, owner: true } });
  const stewards = await prisma.user.findMany({ where: { role: Role.STEWARD } });
  const stewardId = stewards[0]?.id ?? (await prisma.user.findFirstOrThrow({ where: { role: Role.MANAGER } })).id;

  // Distribution of scenarios — kept compact so the full seed completes inside one
  // Neon connection window (~2 min on free tier). Increase if you have a warmer DB.
  const scenarios: SeedScenario[] = [
    ...Array(20).fill('fully_enriched'),
    ...Array(25).fill('partial'),
    ...Array(20).fill('skeleton'),
    ...Array(4).fill('closed'),
    ...Array(2).fill('suspended'),
    ...Array(8).fill('pending_approval'),
    ...Array(6).fill('rejected'),
    ...Array(10).fill('multi_branch'),
  ];

  let seq = 1;
  const year = 2026;

  for (const scenario of scenarios) {
    const route = faker.helpers.arrayElement(allRoutes);
    const channel = faker.helpers.arrayElement(channels);
    const subChannel = faker.helpers.arrayElement(channel.subChannels);
    const isCredit = faker.datatype.boolean({ probability: 0.3 });
    const code = formatCustomerCode(year, seq++);

    const baseName = pickShopName(channel.key);
    const phone = normalizePhone(`9${faker.string.numeric(7)}`);
    const cr = isCredit || scenario === 'fully_enriched'
      ? `${faker.string.numeric({ length: 7, allowLeadingZeros: false })}`
      : null;

    const isFullyEnriched = scenario === 'fully_enriched';
    const isSkeleton = scenario === 'skeleton';

    const customer = await prisma.customer.create({
      data: {
        nmwcCode: code,
        legalName: baseName,
        paymentTerms: isCredit ? PaymentTerms.CREDIT : PaymentTerms.CASH,
        crNumber: cr,
        crNumberNorm: normalizeCR(cr),
        channelId: isSkeleton ? null : channel.id,
        subChannelId: isSkeleton ? null : subChannel.id,
        primaryPhone: isSkeleton ? null : phone,
        primaryPhoneNorm: isSkeleton ? null : phone,
        altPhone: isFullyEnriched ? normalizePhone(`7${faker.string.numeric(7)}`) : null,
        contactPerson: isSkeleton ? null : faker.person.fullName(),
        contactRole: isFullyEnriched ? faker.helpers.arrayElement(['Owner', 'Manager', 'Cashier', 'Purchaser']) : null,
        status: scenario === 'closed' ? CustomerStatus.CLOSED : scenario === 'suspended' ? CustomerStatus.SUSPENDED : CustomerStatus.ACTIVE,
        notes: isFullyEnriched ? faker.lorem.sentence({ min: 4, max: 12 }) : null,
        createdById: stewardId,
        lastEditedById: stewardId,
      },
    });

    // CR photo for fully enriched
    if (isFullyEnriched && cr) {
      const att = await makeAttachment(stewardId, 'CR', { customerId: customer.id });
      await prisma.customer.update({
        where: { id: customer.id },
        data: { crPhotoId: att.id },
      });
    }

    // Branches
    const branchCount = scenario === 'multi_branch' ? faker.number.int({ min: 2, max: 4 }) : 1;
    const branchRoutes: typeof allRoutes = [route];
    if (branchCount > 1) {
      // Spread additional branches across other routes (potentially other regions)
      while (branchRoutes.length < branchCount) {
        const r = faker.helpers.arrayElement(allRoutes);
        if (!branchRoutes.find((br) => br.id === r.id)) branchRoutes.push(r);
      }
    }

    for (let bi = 0; bi < branchCount; bi++) {
      const br = branchRoutes[bi];
      const [baseLat, baseLng] = REGION_GPS_BASE[br.region.code] ?? [23.588, 58.408];
      const branchHasGps = !isSkeleton && (isFullyEnriched || faker.datatype.boolean({ probability: 0.5 }));
      const branchHasPhotos = isFullyEnriched || (!isSkeleton && faker.datatype.boolean({ probability: 0.4 }));

      const address = isSkeleton
        ? `${br.region.name}` // legacy thin address
        : `${faker.location.streetAddress()}, ${br.region.name}`;

      const branch = await prisma.branch.create({
        data: {
          customerId: customer.id,
          branchCode: formatBranchCode(code, bi + 1),
          branchName: branchCount > 1 ? `${baseName} – Branch ${bi + 1}` : 'Main',
          regionId: br.region.id,
          routeId: br.id,
          address,
          areaDescription: isFullyEnriched ? `Near ${faker.location.secondaryAddress()}` : null,
          gpsLat: branchHasGps ? Number((baseLat + (Math.random() - 0.5) * 0.2).toFixed(6)) : null,
          gpsLng: branchHasGps ? Number((baseLng + (Math.random() - 0.5) * 0.2).toFixed(6)) : null,
          gpsAccuracy: branchHasGps ? faker.number.float({ min: 5, max: 25, fractionDigits: 1 }) : null,
          gpsCapturedAt: branchHasGps ? faker.date.recent({ days: 14 }) : null,
          dayOfVisit: !isSkeleton ? faker.helpers.arrayElement(DAYS) : null,
          openingHours: isFullyEnriched ? '08:00 – 22:00' : null,
          deliveryWindow: isFullyEnriched ? '10:00 – 14:00' : null,
          coolersCount: isFullyEnriched ? faker.number.int({ min: 0, max: 3 }) : 0,
          standsCount: isFullyEnriched ? faker.number.int({ min: 0, max: 2 }) : 0,
          emptyBottlesCount: isFullyEnriched ? faker.number.int({ min: 0, max: 30 }) : 0,
          status: scenario === 'closed' ? CustomerStatus.CLOSED : scenario === 'suspended' ? CustomerStatus.SUSPENDED : CustomerStatus.ACTIVE,
          createdById: stewardId,
          lastEditedById: stewardId,
        },
      });

      if (branchHasPhotos) {
        const shop = await makeAttachment(stewardId, 'SHOP', { branchId: branch.id });
        const sign = await makeAttachment(stewardId, 'SIGNBOARD', { branchId: branch.id });
        await prisma.branch.update({
          where: { id: branch.id },
          data: { shopPhotoId: shop.id, signboardPhotoId: sign.id },
        });
      }

      // Closed scenario: must have a fresh shop photo as evidence (already created above if branchHasPhotos)
      if (scenario === 'closed' && !branchHasPhotos) {
        const shop = await makeAttachment(stewardId, 'SHOP', { branchId: branch.id });
        await prisma.branch.update({
          where: { id: branch.id },
          data: { shopPhotoId: shop.id },
        });
      }

      // Compute branch completeness
      const fresh = await prisma.branch.findUniqueOrThrow({ where: { id: branch.id } });
      const bScore = scoreBranch(fresh);
      await prisma.branch.update({ where: { id: branch.id }, data: { completenessScore: bScore } });
    }

    // Customer-level completeness from fresh data
    const cFresh = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      include: { branches: true },
    });
    const cScore = scoreCustomer(cFresh, cFresh.branches);
    await prisma.customer.update({ where: { id: customer.id }, data: { completenessScore: cScore } });

    // Edit-state scenarios
    if (scenario === 'pending_approval' || scenario === 'rejected') {
      const salesman = route.owner;
      if (salesman) {
        const branchForEdit = cFresh.branches[0];
        const editState: EditState = scenario === 'pending_approval' ? EditState.SUBMITTED : EditState.NEEDS_CORRECTION;
        const reviewedAt = scenario === 'rejected' ? faker.date.recent({ days: 3 }) : null;
        const reviewer = await prisma.user.findFirst({
          where: { id: salesman.supervisorId ?? undefined, role: Role.SUPERVISOR },
        });
        await prisma.customerEdit.create({
          data: {
            target: EditTarget.BRANCH,
            customerId: customer.id,
            branchId: branchForEdit.id,
            state: editState,
            submittedById: salesman.id,
            submittedAt: faker.date.recent({ days: 4 }),
            reviewedById: scenario === 'rejected' ? reviewer?.id ?? null : null,
            reviewedAt,
            decisionReason: scenario === 'rejected' ? 'Shop photo unclear — please re-capture during the day' : null,
            decisionCategory: scenario === 'rejected' ? 'bad_photo' : null,
            fieldChanges: [
              { field: 'primaryPhone', before: null, after: '+96891234567' },
              { field: 'address', before: branchForEdit.address, after: `${branchForEdit.address}, near landmark` },
            ],
            attachmentChanges: [],
          },
        });
      }
    }

    // Approved edit history (audit-style) for ~30% of fully enriched
    if (isFullyEnriched && faker.datatype.boolean({ probability: 0.3 })) {
      const salesman = route.owner;
      const reviewer = salesman?.supervisorId
        ? await prisma.user.findFirst({ where: { id: salesman.supervisorId } })
        : null;
      if (salesman && reviewer) {
        await prisma.customerEdit.create({
          data: {
            target: EditTarget.BRANCH,
            customerId: customer.id,
            branchId: cFresh.branches[0].id,
            state: EditState.APPROVED,
            submittedById: salesman.id,
            submittedAt: faker.date.recent({ days: 30 }),
            reviewedById: reviewer.id,
            reviewedAt: faker.date.recent({ days: 28 }),
            decisionReason: null,
            fieldChanges: [{ field: 'contactPerson', before: null, after: customer.contactPerson }],
            attachmentChanges: [],
          },
        });
      }
    }
  }
}

function pickShopName(channelKey: string): string {
  const base = faker.company.name();
  switch (channelKey) {
    case 'HORECA':
      return `${base} ${faker.helpers.arrayElement(['Restaurant', 'Cafe', 'Hotel', 'Resort'])}`;
    case 'MODERN_TRADE':
      return `${faker.helpers.arrayElement(['Lulu', 'Carrefour', 'Spar', 'City Centre'])} ${faker.location.city()}`;
    case 'GENERAL_TRADE':
      return `${base} ${faker.helpers.arrayElement(['Grocery', 'Mini-Market', 'Pharmacy'])}`;
    case 'CONVENIENCE_AND_GAS':
      return `${faker.helpers.arrayElement(['OOMCO', 'Shell', 'Al Maha', 'Oman Oil'])} ${faker.location.city()}`;
    case 'ECOMMERCE':
      return `${base} Online Order`;
    case 'HOME_OFFICE_DELIVERY':
      return `${base} Office`;
    case 'INSTITUTIONS':
      return `${faker.helpers.arrayElement(['Ministry of', 'School of', 'University of', 'Hospital of'])} ${faker.location.city()}`;
    default:
      return base;
  }
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--reset') {
    console.log('▸ Resetting synthetic data…');
    await clearSyntheticData();
  } else if (arg === '--clear-only') {
    console.log('▸ Clearing only — no re-seed.');
    await clearSyntheticData();
    console.log('✓ Cleared.');
    return;
  } else {
    console.log('▸ Building synthetic dataset on top of existing seed data.');
    console.log('  (Use --reset to wipe non-admin data first.)');
  }

  await seedRegionsAndRoutes();
  await seedUsers();
  await seedCustomers();

  const counts = await Promise.all([
    prisma.user.count(),
    prisma.region.count(),
    prisma.route.count(),
    prisma.customer.count(),
    prisma.branch.count(),
    prisma.attachment.count(),
    prisma.customerEdit.count(),
  ]);

  console.log('\n✓ Synthetic data seeded:');
  console.log(`  Users:     ${counts[0]}`);
  console.log(`  Regions:   ${counts[1]}`);
  console.log(`  Routes:    ${counts[2]}`);
  console.log(`  Customers: ${counts[3]}`);
  console.log(`  Branches:  ${counts[4]}`);
  console.log(`  Photos:    ${counts[5]} (synthetic refs only — R2 has no objects yet)`);
  console.log(`  Edits:     ${counts[6]}`);
  console.log('\n  Demo credentials (all passwords: Demo!2026Demo):');
  console.log('   admin             MANAGER  (existing)');
  console.log('   manager.a         MANAGER  — Muscat + Batinah + Dakhiliyah');
  console.log('   manager.b         MANAGER  — Sharqiyah + Dhahirah + Dhofar');
  console.log('   steward           STEWARD  — runs imports/exports');
  console.log('   viewer            VIEWER   — read-only');
  console.log('   supervisor.1..7   SUPERVISOR');
  console.log('   salesman.<route>  SALESMAN — e.g. salesman.mct-01');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
