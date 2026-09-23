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
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/golive/bootstrap-accounts.ts \
 *     [golive-data/managers.json] --expect-host ep-sweet-haze
 *
 * --expect-host is REQUIRED. Without it this refuses, because a DIRECT_URL that
 * silently did not take falls through to the repository .env and mints the first
 * Data Steward into the development database while reporting success.
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
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--')) ?? 'golive-data/managers.json';
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as Cfg;
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';

  // The operator must NAME the database they mean; this refuses if the URL
  // disagrees.
  //
  // Printing the target was not enough. On 2026-09-23, with DIRECT_URL and
  // DATABASE_URL both explicitly removed from the environment, this script
  // still connected — to the development database — because Prisma had already
  // merged the repository .env into process.env. A variable that does not take
  // therefore does not fail: it mints the first Data Steward somewhere else and
  // prints "Created (12)".
  const expectIdx = args.indexOf('--expect-host');
  const expectHost = expectIdx >= 0 ? (args[expectIdx + 1] ?? '') : '';
  if (!expectHost || expectHost.startsWith('--')) {
    throw new Error(
      'refusing to run without --expect-host.\n' +
        `  This connects to ${host}.\n` +
        '  Name the database you intend, so a variable that did not take cannot\n' +
        '  silently send the first Data Steward somewhere else. For the go-live:\n' +
        '    --expect-host ep-sweet-haze\n' +
        '  (that string is also the PROD_DB_HOST_MARKER repository variable).'
    );
  }
  if (!host.includes(expectHost)) {
    // Name this trap specifically when it is what happened.
    let viaDotenv = false;
    try {
      const envText = readFileSync('.env', 'utf8');
      // BOTH keys, not the first match: DATABASE_URL is listed first in this
      // repository while the script resolves DIRECT_URL, so matching only the
      // first one compares the wrong value and never fires.
      const fromEnv = ['DIRECT_URL', 'DATABASE_URL']
        .map((k) => new RegExp(`^${k}=(.*)`, 'm').exec(envText)?.[1])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
      viaDotenv = fromEnv.includes(url);
    } catch {
      /* no .env here; nothing to attribute */
    }
    throw new Error(
      `refusing: you asked for "${expectHost}" but this connection points at ${host}.\n` +
        (viaDotenv
          ? '  That URL is the one in this repository .env — so your variable never\n' +
            '  reached this process and it fell back to the development database.\n' +
            '  Set the variable in the SAME shell that runs this command.\n'
          : '  Check the connection string you exported.\n') +
        '  Nothing has been written.'
    );
  }
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
