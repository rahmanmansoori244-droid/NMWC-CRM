/**
 * Which usernames the go-live master intends to exist.
 *
 * Split out of `scripts/golive/audit-accounts.ts` so it can be tested without a
 * database. The part worth testing is small but security-relevant: the Users
 * sheet carries a `password` column next to `username`, and this finds the
 * username column by NAME rather than by position. A reordered sheet must never
 * make this read passwords into a set of "expected usernames" that then gets
 * printed.
 *
 * Only usernames are read here. `managers.json` also holds each account's initial
 * password; nothing in this module touches that field, and no caller prints a
 * value from either file.
 */
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';

/**
 * @param accountMaster path to account-master.xlsx (sheet "Users", header row 1)
 * @param managersJson  path to managers.json (the Steward and the managers)
 * @returns lower-cased usernames, deduplicated
 */
export async function expectedUsernames(
  accountMaster: string,
  managersJson: string
): Promise<Set<string>> {
  const expected = new Set<string>();

  if (!existsSync(managersJson)) {
    throw new Error(
      `${managersJson} not found. Run scripts/golive/build-masters.ts first — without the master this script cannot tell a leftover account from an intended one.`
    );
  }
  const managers = JSON.parse(readFileSync(managersJson, 'utf8')) as {
    steward?: { username?: string };
    managers?: Array<{ username?: string }>;
  };
  if (managers.steward?.username) expected.add(managers.steward.username.toLowerCase());
  for (const m of managers.managers ?? []) {
    if (m.username) expected.add(m.username.toLowerCase());
  }

  if (!existsSync(accountMaster)) {
    throw new Error(`${accountMaster} not found. Run scripts/golive/build-masters.ts first.`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(accountMaster);
  const ws = wb.getWorksheet('Users');
  if (!ws) throw new Error(`${accountMaster} has no "Users" sheet.`);

  // By name, never by position — the neighbouring column holds passwords.
  const header = ws.getRow(1).values as unknown[];
  const usernameCol = header.findIndex(
    (h) => typeof h === 'string' && h.trim().toLowerCase() === 'username'
  );
  if (usernameCol < 1) throw new Error(`${accountMaster} "Users" sheet has no username column.`);

  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.getCell(usernameCol).value;
    const name = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    if (name) expected.add(name.toLowerCase());
  });

  return expected;
}

/**
 * The go-live region codes, in the order the builder writes them.
 *
 * Duplicated nowhere: scripts/golive/build-masters.ts asserts its own REGIONS
 * constant against this list, so the two cannot drift apart silently.
 */
export const GOLIVE_REGION_CODES = ['MCT', 'KHB', 'NZW', 'SLL', 'AWF', 'DQM', 'BRK'] as const;

/**
 * The ACCOUNTANT account that covers one region.
 *
 * Lower-cased because services/imports.ts and lib/auth.ts both lower-case a
 * username on the way in; an upper-case value would put a name on a credential
 * slip that does not match the account in the database.
 */
export const accountantUsername = (regionCode: string): string =>
  `accountant.${regionCode.toLowerCase()}`;

/**
 * Every generic approver account the go-live builder creates: one ACCOUNTANT per
 * region, plus the two org-wide approvers, whose steps are GLOBAL and who
 * therefore hold no region.
 *
 * None of these may be caught by lib/demo-accounts.ts. Note particularly that an
 * 'accountant.' PREFIX must never be added to that denylist to catch the
 * synthetic 'accountant.a' / 'accountant.b' — it would block all seven of these
 * real accounts at sign-in, which is precisely how the 'steward' username nearly
 * stopped the load.
 */
export const APPROVER_USERNAMES: string[] = [
  ...GOLIVE_REGION_CODES.map(accountantUsername),
  'finance.manager',
  'gm.nmwc',
];
