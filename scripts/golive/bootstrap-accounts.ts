/**
 * One-time bootstrap of the accounts that can NEVER come from a spreadsheet: the
 * first Data Steward and the Managers.
 *
 * Why: the seed creates `admin` as a MANAGER, a MANAGER may only create field roles
 * (SR-USR-01), and the account import refuses to create STEWARD or MANAGER accounts
 * (no administrator can be minted from a spreadsheet). So a fresh production
 * database has no in-app path to its first Steward, and the Managers must exist
 * before the account import can assign their regions.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/golive/bootstrap-accounts.ts [golive-data/managers.json]
 *
 * Reads the steward + managers (username, full name, initial password) from
 * managers.json (written by build-masters.ts). Every account is created with
 * mustChangePassword=true (AUTH-09): the initial password works exactly once.
 *
 * Idempotent and conservative: an existing username is left untouched and reported;
 * a Steward is created only if NO active Steward exists; nothing else is written.
 * Regions are NOT set here — the account import's `region_codes` column does that.
 */
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';

type Cfg = {
  steward: { username: string; fullName: string; password: string };
  managers: Array<{ username: string; fullName: string; regions: string[]; password: string }>;
};

async function main() {
  // ONE resolution, used for both the connection and the banner.
  //
  // Prefer DIRECT_URL, like every other operator script here: this mints the first
  // Data Steward — the role that imports, merges and bypasses every field lock —
  // so it belongs on the owner connection rather than on whatever DATABASE_URL
  // happens to hold. After the B4 rollout that variable points at the
  // least-privilege runtime role, and "the production URL" stops being an
  // unambiguous instruction.
  //
  // They must be resolved together. Reading one for the client and the other for
  // the banner meant the single line of evidence the operator gets about WHICH
  // database just received the Steward and the eleven Managers could name a
  // different host from the one that was written to — and the guard would also
  // refuse the invocation the runbook documents.
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('set DIRECT_URL (preferred) or DATABASE_URL');
  const file = process.argv[2] ?? 'golive-data/managers.json';
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as Cfg;
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  const prisma = new PrismaClient({ datasourceUrl: url });
  const created: string[] = [];
  const skipped: string[] = [];

  const make = async (
    u: { username: string; fullName: string; password: string },
    role: Role,
    reason: string
  ) => {
    const username = u.username.toLowerCase().trim();
    if (!/^[a-z0-9._-]{1,50}$/.test(username)) throw new Error(`bad username "${u.username}"`);
    if ((u.password ?? '').length < 4) throw new Error(`password for ${username} is too short`);
    const clash = await prisma.user.findUnique({ where: { username }, select: { role: true } });
    if (clash) {
      skipped.push(`${username} (exists as ${clash.role})`);
      return;
    }
    const user = await prisma.user.create({
      data: {
        username,
        fullName: u.fullName,
        role,
        passwordHash: await bcrypt.hash(u.password, 12),
        mustChangePassword: true,
      },
      select: { id: true },
    });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        after: { username, role, bootstrap: true, mustChangePassword: true },
        reason,
      },
    });
    created.push(`${username} (${role})`);
  };

  try {
    // Before anything is written, not after. This is the operator's only evidence
    // of which database is about to receive the first Data Steward, and evidence
    // that arrives after the fact is a receipt.
    console.log(`Target: ${host}`);
    const stewards = await prisma.user.findMany({
      where: { role: Role.STEWARD, isActive: true },
      select: { username: true },
    });
    if (stewards.length > 0) {
      skipped.push(`steward — one already exists: ${stewards.map((s) => s.username).join(', ')}`);
    } else {
      await make(
        cfg.steward,
        Role.STEWARD,
        'go-live bootstrap: first Data Steward (no in-app path exists before one)'
      );
    }
    for (const m of cfg.managers) {
      await make(
        m,
        Role.MANAGER,
        'go-live bootstrap: Manager (the import cannot create admin-tier roles)'
      );
    }
    console.log(`Created (${created.length}): ${created.join(', ') || '—'}`);
    console.log(`Skipped (${skipped.length}): ${skipped.join('; ') || '—'}`);
    console.log('Every created account must change its password at first login.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('BOOTSTRAP FAILED:', e.message);
  process.exit(1);
});
