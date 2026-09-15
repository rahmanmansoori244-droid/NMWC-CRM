/**
 * Which accounts will still be able to sign in the morning after go-live?
 *
 * The go-live load does not answer that question, and every step of it is
 * deliberately additive:
 *   - `bootstrap-accounts.ts` "skips any username that already exists and touches
 *     nothing else" — by design, so a re-run is safe.
 *   - the account-master import creates and updates the rows in the sheet. It
 *     never deactivates a user who is absent from it.
 *
 * So every account that predates the load survives it, silently. On this database
 * that is not hypothetical: `prisma/seed-muscat-pilot.ts` creates `pilot.steward`
 * (STEWARD), `pilot.manager` (MANAGER), `ahmed.alndabi` (SUPERVISOR) and ten
 * SALESMAN accounts, and the passwords they were issued with are recoverable from
 * this repository's git history — `docs/PILOT-MUSCAT-CREDENTIALS.md` was removed
 * from the tree in 821b02b but remains in the history of `main`, and the history
 * scrub in SR-C2 step 4 (docs/discovery/blueprint-inputs/security-remediation.md)
 * has not been done. The repository is private with one collaborator, so nothing
 * has leaked; but "a STEWARD account whose password is written down in a file
 * anybody with repo access can read" is not a state to launch in, and STEWARD is
 * the role that imports, merges and bypasses every field lock.
 *
 * This script only reports. It makes no writes of any kind — it selects seven
 * non-secret columns and prints them — so it is safe to point at production, which
 * is the only place the answer is interesting. Deciding what to do with a leftover
 * account is the owner's: deactivate it from Users, or reset it from Users → Reset
 * password, which also revokes its live sessions.
 *
 *   DATABASE_URL='<production URL>' npx tsx scripts/golive/audit-accounts.ts \
 *     [golive-data/account-master.xlsx] [golive-data/managers.json]
 *
 * Exit 1 if any account can sign in that the go-live master does not name, so the
 * runbook step can gate on it. Exit 0 when the live account list and the master
 * agree.
 */
import { PrismaClient, type Role } from '@prisma/client';
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const ACCOUNT_MASTER = process.argv[2] ?? 'golive-data/account-master.xlsx';
const MANAGERS_JSON = process.argv[3] ?? 'golive-data/managers.json';

/**
 * Report order. Not a permission model — `lib/permissions.ts` owns that — just the
 * order in which a leftover account should worry the reader. STEWARD first because
 * it imports, merges and bypasses every field lock; VIEWER is above SALESMAN
 * because it is org-wide and can export the master and read CR documents.
 */
const SEVERITY: Record<Role, number> = {
  STEWARD: 0,
  GM: 1,
  FINANCE_MANAGER: 2,
  MANAGER: 3,
  ACCOUNTANT: 4,
  SUPERVISOR: 5,
  VIEWER: 6,
  SALESMAN: 7,
};

/** Usernames the go-live master intends to exist, lower-cased. */
async function expectedUsernames(): Promise<Set<string>> {
  const expected = new Set<string>();

  if (!existsSync(MANAGERS_JSON)) {
    throw new Error(
      `${MANAGERS_JSON} not found. Run scripts/golive/build-masters.ts first — without the master this script cannot tell a leftover account from an intended one.`
    );
  }
  // Only usernames are read. managers.json also carries each account's initial
  // password; nothing here touches that field, and no password is ever printed.
  const managers = JSON.parse(readFileSync(MANAGERS_JSON, 'utf8')) as {
    steward?: { username?: string };
    managers?: Array<{ username?: string }>;
  };
  if (managers.steward?.username) expected.add(managers.steward.username.toLowerCase());
  for (const m of managers.managers ?? []) {
    if (m.username) expected.add(m.username.toLowerCase());
  }

  if (!existsSync(ACCOUNT_MASTER)) {
    throw new Error(`${ACCOUNT_MASTER} not found. Run scripts/golive/build-masters.ts first.`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ACCOUNT_MASTER);
  const ws = wb.getWorksheet('Users');
  if (!ws) throw new Error(`${ACCOUNT_MASTER} has no "Users" sheet.`);
  // Header on row 1 (scripts/golive/build-masters.ts addSheet). Find the username
  // column by name rather than by position, so a reordered sheet cannot make this
  // silently read the password column instead.
  const header = ws.getRow(1).values as unknown[];
  const usernameCol = header.findIndex(
    (h) => typeof h === 'string' && h.trim().toLowerCase() === 'username'
  );
  if (usernameCol < 1) throw new Error(`${ACCOUNT_MASTER} "Users" sheet has no username column.`);
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.getCell(usernameCol).value;
    const name = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    if (name) expected.add(name.toLowerCase());
  });

  return expected;
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : 'never';
}

async function main() {
  const expected = await expectedUsernames();

  // Seven non-secret columns, named explicitly: `passwordHash` is not selected, so
  // it never leaves the database.
  const users = await prisma.user.findMany({
    select: {
      username: true,
      fullName: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
      createdAt: true,
    },
    orderBy: { username: 'asc' },
  });

  const live = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const leftovers = users
    .filter((u) => !expected.has(u.username.toLowerCase()))
    .sort((a, b) => SEVERITY[a.role] - SEVERITY[b.role] || a.username.localeCompare(b.username));
  const missing = [...expected].filter((n) => !live.has(n)).sort();

  const activeLeftovers = leftovers.filter((u) => u.isActive);
  const disabledLeftovers = leftovers.filter((u) => !u.isActive);

  console.log(`\nAccounts in the database: ${users.length}`);
  console.log(`Named by the go-live master: ${expected.size}`);
  console.log(`Not named by it: ${leftovers.length} (${activeLeftovers.length} can still sign in)`);

  if (missing.length > 0) {
    console.log(`\n--- Named by the master but NOT in the database (${missing.length})`);
    console.log('    Expected before the account-master import runs; a problem afterwards.');
    for (const n of missing) console.log(`    ${n}`);
  }

  if (activeLeftovers.length > 0) {
    console.log(`\n--- CAN SIGN IN, and the go-live master does not name them (${activeLeftovers.length})`);
    console.log('    Most severe role first. Deactivate or reset each one from Users before launch.');
    console.log('    Any account seeded before go-live may hold a password recoverable from git history.\n');
    console.log('    role             username                 last login   created      must change pw');
    for (const u of activeLeftovers) {
      console.log(
        `    ${u.role.padEnd(16)} ${u.username.padEnd(24)} ${fmtDate(u.lastLoginAt).padEnd(12)} ${fmtDate(u.createdAt).padEnd(12)} ${u.mustChangePassword ? 'yes' : 'NO'}`
      );
    }
  }

  if (disabledLeftovers.length > 0) {
    console.log(`\n--- Not named by the master, already deactivated (${disabledLeftovers.length})`);
    console.log('    These cannot sign in. Listed so the count above reconciles.');
    for (const u of disabledLeftovers) console.log(`    ${u.role.padEnd(16)} ${u.username}`);
  }

  if (activeLeftovers.length === 0) {
    console.log('\nOK — every account that can sign in is one the go-live master names.\n');
    return 0;
  }
  console.log(
    `\nFAIL — ${activeLeftovers.length} account(s) can sign in that the go-live master does not name.\n`
  );
  return 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`\naudit-accounts failed: ${(err as Error).message}\n`);
    await prisma.$disconnect();
    process.exit(2);
  });
