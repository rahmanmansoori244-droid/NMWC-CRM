/**
 * Does credentials.xlsx say what the owner decided it says?
 *
 * The owner's decision, restated 2026-09-20: every account starts on ONE shared
 * password and is forced to change it at first sign-in, and usernames are CODES —
 * a salesman's route code, a manager's class code.
 *
 * Nothing checked that. `build-masters.ts` writes the sheets and reports success,
 * and the sheets are the thing an operator reads aloud while handing out logins.
 * Three ways that goes wrong quietly:
 *
 *   - a row is issued with a password that is not the shared one, so one person
 *     cannot sign in on load day and nobody knows which;
 *   - a row is missing `must_change_password`, so a live account keeps the shared
 *     value forever — and the forced change is the ENTIRE control here, because
 *     the value is short, shared, and the usernames are printed on the journey
 *     plan;
 *   - a username drifts from its route code, so the slip an operator reads does
 *     not match the account that exists.
 *
 * This script reads the built files and answers those. It is READ-ONLY, touches no
 * database and needs no credentials.
 *
 * It never prints a password. It compares them and reports agreement, because a
 * verifier that echoes the value it is verifying has put the secret in the
 * terminal, the scrollback and any screenshot of either.
 *
 *   npx tsx scripts/golive/verify-credentials.ts [golive-data]
 *
 * Exit 0 when every check passes, 1 otherwise, so a runbook step can gate on it.
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDemoAccount } from '../../lib/demo-accounts';

const DIR = process.argv[2] ?? 'golive-data';
const CRED = path.join(DIR, 'credentials.xlsx');
const MASTER = path.join(DIR, 'account-master.xlsx');

/** The charset services/users.ts accepts. A username outside it imports and then fails at sign-in. */
const USERNAME_RULE = /^[a-z0-9._-]{1,50}$/;

type Row = Record<string, string>;
type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

/**
 * Read a sheet into objects keyed by HEADER NAME.
 *
 * By name and never by position, for the reason lib/ops/golive-accounts.ts gives:
 * the password column sits next to the username column, and a reordered sheet
 * must not silently make this read one as the other.
 */
async function readSheet(file: string, sheet: string): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheet);
  if (!ws) throw new Error(`${file} has no "${sheet}" sheet`);
  const header = (ws.getRow(1).values as unknown[]).map((h) =>
    typeof h === 'string' ? h.trim().toLowerCase() : ''
  );
  const rows: Row[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj: Row = {};
    for (let i = 1; i < header.length; i += 1) {
      const key = header[i];
      if (!key) continue;
      const v = row.getCell(i).value;
      obj[key] = v == null ? '' : String(typeof v === 'object' && 'text' in v ? v.text : v).trim();
    }
    if (Object.values(obj).some((x) => x !== '')) rows.push(obj);
  });
  return rows;
}

/** The shared initial password, read from the builder so the literal lives in exactly one file. */
function expectedPassword(): string {
  const src = readFileSync('scripts/golive/build-masters.ts', 'utf8');
  const m = src.match(/const INITIAL_PASSWORD = '([^']*)'/);
  if (!m) {
    throw new Error(
      'could not find INITIAL_PASSWORD in scripts/golive/build-masters.ts — if it was renamed, update this script rather than dropping the check'
    );
  }
  return m[1]!;
}

async function main() {
  for (const f of [CRED, MASTER]) {
    if (!existsSync(f)) {
      console.error(`${f} not found. Run: npx tsx scripts/golive/build-masters.ts`);
      process.exit(1);
    }
  }

  const first = await readSheet(CRED, 'Create in app FIRST');
  const imported = await readSheet(CRED, 'Created by import');
  const users = await readSheet(MASTER, 'Users');
  const slips = [...first, ...imported];

  // ── passwords ─────────────────────────────────────────────────────────────
  const want = expectedPassword();
  const values = slips.map((r) => r.password ?? '');
  const blank = slips.filter((r) => !r.password).map((r) => r.username);
  check(
    'every credential row carries a password',
    blank.length === 0,
    blank.length === 0 ? `${slips.length} rows` : `blank for: ${blank.join(', ')}`
  );

  const distinct = new Set(values.filter(Boolean));
  check(
    'all of them are the SAME password',
    distinct.size === 1,
    // The count, never the values — this is the one place it would be easy to leak.
    `${distinct.size} distinct value(s) across ${values.length} rows`
  );
  check(
    'and it is the shared initial password the builder issues',
    distinct.size === 1 && distinct.has(want),
    distinct.size === 1 && distinct.has(want)
      ? `matches INITIAL_PASSWORD (${want.length} characters; value not printed)`
      : 'does NOT match build-masters.ts INITIAL_PASSWORD'
  );

  // ── the forced change, which is the actual control ────────────────────────
  const notForced = users
    .filter((r) => (r.must_change_password ?? '').toLowerCase() !== 'yes')
    .map((r) => r.username);
  check(
    'every imported account is forced to change it at first sign-in',
    notForced.length === 0,
    notForced.length === 0
      ? `${users.length} rows carry must_change_password=yes`
      : `NOT forced: ${notForced.join(', ')}`
  );
  check(
    'the shared value is short enough that the change is unavoidable',
    want.length < 12,
    want.length < 12
      ? `${want.length} chars, under the 12-character rule the change-password screen enforces`
      : `${want.length} chars — long enough to survive as a permanent password`
  );

  // ── usernames ─────────────────────────────────────────────────────────────
  const bad = slips.filter((r) => !USERNAME_RULE.test(r.username ?? '')).map((r) => r.username);
  check(
    'every username is one the application will accept',
    bad.length === 0,
    bad.length === 0 ? `${slips.length} usernames match [a-z0-9._-]{1,50}` : `rejected: ${bad.join(', ')}`
  );

  const denied = slips.filter((r) => isDemoAccount(r.username ?? '')).map((r) => r.username);
  check(
    'none collides with the demo denylist production enforces',
    denied.length === 0,
    denied.length === 0 ? 'clear' : `BLOCKED AT SIGN-IN: ${denied.join(', ')}`
  );

  const seen = new Map<string, number>();
  for (const r of slips) seen.set(r.username, (seen.get(r.username) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([u]) => u);
  check(
    'no username appears on two slips',
    dupes.length === 0,
    dupes.length === 0 ? `${seen.size} unique` : `duplicated: ${dupes.join(', ')}`
  );

  // ── "by code": a salesman's username IS their route code ──────────────────
  const salesmen = users.filter((r) => r.role === 'SALESMAN');
  const mismatched = salesmen
    .filter((r) => r.route_code && r.username !== r.route_code.toLowerCase())
    .map((r) => `${r.username} (route ${r.route_code})`);
  check(
    'every salesman signs in with their route code',
    mismatched.length === 0,
    mismatched.length === 0
      ? `${salesmen.length} salesmen, username === route_code`
      : `differs: ${mismatched.join(', ')}`
  );

  // ── the two files agree ───────────────────────────────────────────────────
  const slipNames = new Set(slips.map((r) => r.username));
  const masterNames = new Set(users.map((r) => r.username));
  const noSlip = [...masterNames].filter((u) => !slipNames.has(u));
  check(
    'every account the import creates has a credential slip',
    noSlip.length === 0,
    noSlip.length === 0 ? `${masterNames.size} accounts` : `no slip for: ${noSlip.join(', ')}`
  );

  // The reverse is NOT an error: the steward and the managers are on a slip and
  // are created in the app before the import runs, so they are deliberately
  // absent from the Users sheet.
  const slipOnly = [...slipNames].filter((u) => !masterNames.has(u));
  const firstNames = new Set(first.map((r) => r.username));
  const unexplained = slipOnly.filter((u) => !firstNames.has(u));
  check(
    'every slip is either imported or created in the app first',
    unexplained.length === 0,
    unexplained.length === 0
      ? `${slipOnly.length} created in the app first, ${masterNames.size} imported`
      : `on a slip but created by nothing: ${unexplained.join(', ')}`
  );

  // ── report ────────────────────────────────────────────────────────────────
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log(`\nCredential check — ${CRED}`);
  console.log('='.repeat(width + 56));
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  console.log('='.repeat(width + 56));

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`${failed.length} of ${checks.length} checks FAILED\n`);
    process.exit(1);
  }
  console.log(`all ${checks.length} checks passed\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
