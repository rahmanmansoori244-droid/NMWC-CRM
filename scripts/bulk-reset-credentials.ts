/**
 * Bulk credential reset for the Muscat pilot launch.
 *
 * EXPLICIT OPERATIONAL TRADE-OFF accepted by the owner on 2026-05-11:
 *   - Salesmen passwords become "12345678" (8 chars).
 *   - All other staff passwords become "97246316" (8 chars).
 *   - mustChangePassword is set to FALSE for everyone (no forced rotation).
 * The owner has explicitly weighed this against the field-team's tech
 * literacy and chosen simplicity over per-user secrets. Recorded loudly
 * in the audit log + docs/OPERATIONS.md so the decision is reversible.
 *
 * What this script does:
 *   1. Disables leftover demo accounts (admin, manager.a/b, steward,
 *      supervisor.1..7, test.mustchange, viewer). They stay in DB
 *      (their audit history is preserved) but `isActive=false` so
 *      no one can log in as them.
 *   2. Renames every SALESMAN from "<route>-12345-nmwc" to "<route>-nmwc".
 *   3. Sets every active SALESMAN's password to "12345678".
 *   4. Sets ahmed.alndabi, pilot.manager, pilot.steward password to
 *      "97246316".
 *   5. Clears mustChangePassword for everyone.
 *   6. Wipes the PasswordHistory rows for resetters so the reuse-check
 *      doesn't block a future change-back.
 *   7. Bumps sessionsRevokedAt on every modified user so existing JWTs
 *      become instantly invalid — next request lands them at /login.
 *   8. Writes ONE AuditLog summary row attributing the bulk reset to
 *      pilot.steward.
 *
 * Run:  npx tsx scripts/bulk-reset-credentials.ts
 */
import { PrismaClient, Role, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const SALESMAN_PASSWORD = '12345678';
const STAFF_PASSWORD = '97246316';

const DEMO_USERNAMES_TO_DISABLE = [
  'admin',
  'manager.a',
  'manager.b',
  'steward',
  'supervisor.1',
  'supervisor.2',
  'supervisor.3',
  'supervisor.4',
  'supervisor.5',
  'supervisor.6',
  'supervisor.7',
  'test.mustchange',
  'viewer',
];

const STAFF_USERNAMES = ['ahmed.alndabi', 'pilot.manager', 'pilot.steward'];

async function main() {
  console.log('=== Bulk credential reset (Muscat pilot) ===\n');

  const steward = await prisma.user.findUniqueOrThrow({
    where: { username: 'pilot.steward' },
    select: { id: true },
  });

  // 1. Hash both passwords once (bcrypt cost 12 — same as the seed).
  console.log('Hashing passwords…');
  const [salesmanHash, staffHash] = await Promise.all([
    bcrypt.hash(SALESMAN_PASSWORD, 12),
    bcrypt.hash(STAFF_PASSWORD, 12),
  ]);

  // Resolve target users
  const salesmen = await prisma.user.findMany({
    where: { role: Role.SALESMAN, isActive: true },
    select: { id: true, username: true, ownedRoute: { select: { code: true } } },
  });
  const staff = await prisma.user.findMany({
    where: { username: { in: STAFF_USERNAMES } },
    select: { id: true, username: true, role: true },
  });
  const demos = await prisma.user.findMany({
    where: { username: { in: DEMO_USERNAMES_TO_DISABLE } },
    select: { id: true, username: true, role: true, isActive: true },
  });

  console.log(`Salesmen to rename + reset: ${salesmen.length}`);
  for (const s of salesmen) {
    const newName = s.ownedRoute ? `${s.ownedRoute.code.toLowerCase()}-nmwc` : null;
    console.log(`  ${s.username.padEnd(22)} → ${newName ?? '(no route — skipping)'}`);
  }
  console.log(`\nStaff to reset: ${staff.length}`);
  for (const s of staff) console.log(`  ${s.username.padEnd(22)} (${s.role})`);
  console.log(`\nDemo accounts to disable: ${demos.length}`);
  for (const d of demos) console.log(`  ${d.username.padEnd(22)} (${d.role}, isActive=${d.isActive})`);

  // 2. Execute everything in one transaction.
  const now = new Date();
  const allModifiedIds: string[] = [];
  const renames: Array<{ id: string; from: string; to: string }> = [];

  await prisma.$transaction(
    async (tx) => {
      // Salesmen: rename, password, mustChangePassword=false, revoke sessions
      for (const s of salesmen) {
        if (!s.ownedRoute) {
          console.log(`  WARN: ${s.username} has no owned route — skipping`);
          continue;
        }
        const newUsername = `${s.ownedRoute.code.toLowerCase()}-nmwc`;
        if (newUsername !== s.username) {
          // Check for collision (shouldn't happen but be safe)
          const collision = await tx.user.findUnique({
            where: { username: newUsername },
            select: { id: true },
          });
          if (collision && collision.id !== s.id) {
            console.log(`  WARN: username ${newUsername} already in use by another user — skipping rename for ${s.username}`);
            continue;
          }
          renames.push({ id: s.id, from: s.username, to: newUsername });
        }
        await tx.user.update({
          where: { id: s.id },
          data: {
            username: newUsername,
            passwordHash: salesmanHash,
            mustChangePassword: false,
            sessionsRevokedAt: now,
          },
        });
        allModifiedIds.push(s.id);
      }

      // Staff: password, mustChangePassword=false, revoke sessions (username unchanged)
      for (const s of staff) {
        await tx.user.update({
          where: { id: s.id },
          data: {
            passwordHash: staffHash,
            mustChangePassword: false,
            sessionsRevokedAt: now,
          },
        });
        allModifiedIds.push(s.id);
      }

      // Clear PasswordHistory for everyone we just touched so the reuse-check
      // doesn't fire if the operator later picks one of these passwords again.
      if (allModifiedIds.length > 0) {
        await tx.passwordHistory.deleteMany({
          where: { userId: { in: allModifiedIds } },
        });
      }

      // Demos: just disable (preserve audit history)
      const demoIds = demos.map((d) => d.id);
      if (demoIds.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: demoIds } },
          data: { isActive: false, sessionsRevokedAt: now },
        });
      }

      // One summary audit row attributing to the steward.
      await tx.auditLog.create({
        data: {
          actorId: steward.id,
          action: 'UPDATE',
          entityType: 'CredentialBulkReset',
          entityId: now.toISOString(),
          reason:
            'Pre-launch bulk credential reset for Muscat pilot. Owner accepted shared-password trade-off explicitly (12345678 for salesmen, 97246316 for staff). See docs/OPERATIONS.md.',
          after: {
            salesmenResetCount: salesmen.filter((s) => s.ownedRoute).length,
            staffResetCount: staff.length,
            demosDisabledCount: demos.length,
            renames,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 60_000 }
  );

  // 3. Verify + final report
  const finalActiveUsers = await prisma.user.findMany({
    where: { isActive: true },
    orderBy: { username: 'asc' },
    select: { username: true, role: true, mustChangePassword: true },
  });
  console.log('\n=== Final active users ===');
  for (const u of finalActiveUsers) {
    console.log(`  ${u.role.padEnd(10)} ${u.username.padEnd(20)} mustChange=${u.mustChangePassword}`);
  }
  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
