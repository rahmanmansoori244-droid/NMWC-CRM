/**
 * One-off seed for the GT-MUSCAT pilot, 2026-05-10.
 *
 * Creates:
 *   - Abdullah (MANAGER, pilot.manager) — managedRegions = [Muscat]
 *   - Abdulrahman (STEWARD, pilot.steward)
 *   - Ahmed Al Nadabi (SUPERVISOR, ahmed.alndabi) — reports to pilot.manager
 *   - 10 new routes under Muscat: C1 / C4 / C6 / C7 / C12 / C13 / C14 / C15 /
 *     MH01 / MH02
 *   - 10 SALESMAN accounts, one per route, all reporting to ahmed.alndabi.
 *     Username = `<route>-12345-nmwc` (lowercase per username regex).
 *     Password = `<ROUTE>-12345-NMWC` (route preserved uppercase).
 *
 * Why direct DB and not the Account-master import?
 * The F-02 fix in services/imports.ts deliberately blocks STEWARDs from
 * minting MANAGER or STEWARD accounts via import. The documented
 * out-of-band path for admin-tier provisioning is a seed script — exactly
 * this. The salesman + supervisor + route rows could go via import; we
 * keep everything in one transaction here for atomicity and audit
 * cleanliness.
 *
 * Idempotent on re-run: every write is an upsert keyed on `username` /
 * `code`. Re-running will refresh names/passwords but won't duplicate
 * rows or create extra audit entries (we check existence first).
 *
 * Run with:
 *   npx tsx prisma/seed-muscat-pilot.ts
 */
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const ROUTE_CODES = ['C1', 'C4', 'C6', 'C7', 'C12', 'C13', 'C14', 'C15', 'MH01', 'MH02'];

async function main() {
  console.log('Pilot seed — GT-MUSCAT — start');

  // Resolve the existing Muscat region (must already exist from the main seed).
  const muscat = await prisma.region.findUnique({ where: { code: 'MUSCAT' } });
  if (!muscat) {
    throw new Error(
      'Region "MUSCAT" not found. Run `npm run db:seed` first to create the base regions.'
    );
  }

  // Resolve the seed `admin` user as audit actor (we attribute these
  // creations to the system seed account, not to a real Manager).
  const admin = await prisma.user.findUnique({ where: { username: 'admin' } });
  const actorId = admin?.id;

  // ── 1. MANAGER: Abdullah (pilot.manager) ─────────────────────────────────
  const managerPasswordHash = await bcrypt.hash('Manager-NMWC-2026!', 12);
  const manager = await prisma.user.upsert({
    where: { username: 'pilot.manager' },
    update: { fullName: 'Abdullah', isActive: true },
    create: {
      username: 'pilot.manager',
      fullName: 'Abdullah',
      role: Role.MANAGER,
      passwordHash: managerPasswordHash,
      managedRegions: { connect: [{ id: muscat.id }] },
    },
  });
  // Always wire the region (in case the row pre-existed without it)
  await prisma.user.update({
    where: { id: manager.id },
    data: { managedRegions: { set: [{ id: muscat.id }] } },
  });
  console.log(`  MANAGER  pilot.manager  (Abdullah)            id=${manager.id}`);

  // ── 2. STEWARD: Abdulrahman (pilot.steward) ──────────────────────────────
  const stewardPasswordHash = await bcrypt.hash('Steward-NMWC-2026!', 12);
  const steward = await prisma.user.upsert({
    where: { username: 'pilot.steward' },
    update: { fullName: 'Abdulrahman', isActive: true },
    create: {
      username: 'pilot.steward',
      fullName: 'Abdulrahman',
      role: Role.STEWARD,
      passwordHash: stewardPasswordHash,
    },
  });
  console.log(`  STEWARD  pilot.steward  (Abdulrahman)         id=${steward.id}`);

  // ── 3. SUPERVISOR: Ahmed Al Nadabi (ahmed.alndabi) ───────────────────────
  const ahmedPasswordHash = await bcrypt.hash('Ahmed-NMWC-2026!', 12);
  const ahmed = await prisma.user.upsert({
    where: { username: 'ahmed.alndabi' },
    update: { fullName: 'Ahmed Al Nadabi', isActive: true, supervisorId: manager.id },
    create: {
      username: 'ahmed.alndabi',
      fullName: 'Ahmed Al Nadabi',
      role: Role.SUPERVISOR,
      passwordHash: ahmedPasswordHash,
      supervisorId: manager.id,
    },
  });
  console.log(`  SUPER    ahmed.alndabi  (Ahmed Al Nadabi)     id=${ahmed.id}`);

  // ── 4. Routes (10) under Muscat ──────────────────────────────────────────
  for (const code of ROUTE_CODES) {
    const route = await prisma.route.upsert({
      where: { code },
      update: { name: code, regionId: muscat.id, isActive: true },
      create: { code, name: code, regionId: muscat.id, isActive: true },
    });
    console.log(`  ROUTE    ${code.padEnd(8)}                            id=${route.id}`);
  }

  // ── 5. Salesmen (10), one per route, reporting to Ahmed ──────────────────
  for (const code of ROUTE_CODES) {
    const route = await prisma.route.findUniqueOrThrow({ where: { code } });
    const username = `${code.toLowerCase()}-12345-nmwc`;
    const password = `${code}-12345-NMWC`;
    const passwordHash = await bcrypt.hash(password, 12);

    // Detach previous owner if route has one and it's not this user
    const currentOwner = await prisma.user.findUnique({
      where: { ownedRouteId: route.id },
    });
    if (currentOwner && currentOwner.username !== username) {
      await prisma.user.update({
        where: { id: currentOwner.id },
        data: { ownedRouteId: null },
      });
    }

    const salesman = await prisma.user.upsert({
      where: { username },
      update: {
        fullName: `Salesman ${code}`,
        isActive: true,
        supervisorId: ahmed.id,
        ownedRouteId: route.id,
      },
      create: {
        username,
        fullName: `Salesman ${code}`,
        role: Role.SALESMAN,
        passwordHash,
        supervisorId: ahmed.id,
        ownedRouteId: route.id,
      },
    });
    console.log(`  SALES    ${username.padEnd(20)} → ${code.padEnd(5)}    id=${salesman.id}`);
  }

  // ── 6. Audit log entries ────────────────────────────────────────────────
  if (actorId) {
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'CREATE',
        entityType: 'User',
        entityId: manager.id,
        after: {
          username: 'pilot.manager',
          role: 'MANAGER',
          regions: ['MUSCAT'],
          via: 'seed-muscat-pilot',
        },
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'CREATE',
        entityType: 'User',
        entityId: steward.id,
        after: { username: 'pilot.steward', role: 'STEWARD', via: 'seed-muscat-pilot' },
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'CREATE',
        entityType: 'User',
        entityId: ahmed.id,
        after: {
          username: 'ahmed.alndabi',
          role: 'SUPERVISOR',
          supervisorId: manager.id,
          via: 'seed-muscat-pilot',
        },
      },
    });
  }

  console.log('\nPilot seed — GT-MUSCAT — done.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
