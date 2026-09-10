/**
 * One-time bootstrap of the FIRST Data Steward on a database that has none.
 *
 * Why this exists: the seed creates `admin` as a MANAGER, a MANAGER may only create
 * field roles (SR-USR-01), and the account import refuses to create a STEWARD (no
 * administrator can be minted from a spreadsheet). So a fresh production database has
 * no in-app path to its first Steward — and without a Steward nothing can be imported.
 *
 *   STEWARD_PASSWORD='<12+ chars>' DATABASE_URL='<target>' npx tsx scripts/golive/bootstrap-steward.ts
 *
 * Guarantees: refuses to run if ANY active STEWARD already exists (prints who);
 * touches no other user; the new account must change its password on first login;
 * writes an audit row. Username defaults to `steward` (STEWARD_USERNAME to override).
 */
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is not set');
  const password = process.env.STEWARD_PASSWORD ?? '';
  if (password.length < 12) throw new Error('STEWARD_PASSWORD must be at least 12 characters');
  const username = (process.env.STEWARD_USERNAME ?? 'steward').toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,50}$/.test(username))
    throw new Error('STEWARD_USERNAME must be lowercase a-z 0-9 . _ - (3–50)');

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findMany({
      where: { role: Role.STEWARD, isActive: true },
      select: { username: true },
    });
    if (existing.length > 0) {
      console.log(
        `A Steward already exists: ${existing.map((u) => u.username).join(', ')} — nothing to do.`
      );
      return;
    }
    const clash = await prisma.user.findUnique({ where: { username } });
    if (clash) throw new Error(`username "${username}" already exists with role ${clash.role}`);

    const user = await prisma.user.create({
      data: {
        username,
        fullName: 'Data Steward',
        role: Role.STEWARD,
        passwordHash: await bcrypt.hash(password, 12),
        mustChangePassword: true,
      },
      select: { id: true, username: true },
    });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        after: { username, role: 'STEWARD', bootstrap: true },
        reason: 'go-live bootstrap: first Data Steward (no in-app path exists before one)',
      },
    });
    const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
    console.log(
      `Created STEWARD "${username}" on ${host}. They must change the password on first login.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('BOOTSTRAP FAILED:', e.message);
  process.exit(1);
});
