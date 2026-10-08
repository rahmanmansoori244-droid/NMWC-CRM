/**
 * Back-office helpers for tests/e2e/launch/backoffice.spec.ts (owner: the
 * back-office spec). Additive only: nothing here changes another support file.
 *
 *  - Import workbooks built in memory with ExcelJS (the importer's own parser
 *    reads them), handed to the page with setInputFiles({ buffer }) — never
 *    written to disk, so an account sheet's passwords stay in memory.
 *  - Downloaded workbooks read back with ExcelJS: cell text and cell fill.
 *  - The Steward's per-user import / Temix buckets (resetLimits covers login,
 *    edit and photo only).
 *  - The app's own Oman formatters and Temix queue rule, for expectations.
 */
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import { db } from './env';
import { FIXTURE_PASSWORD_SHAPE } from './secret-scan';
import type { FixtureUser } from './types';

export { omanDate, omanDateTime } from '../../../../lib/tz';
export { TEMIX_QUEUE_WHERE } from '../../../../lib/temix';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type Cell = string | number | null | undefined;
export type SheetSpec = { name: string; headers: readonly string[]; rows: ReadonlyArray<Record<string, Cell>> };

/** A workbook with the given sheets, header row first; null/undefined cells stay empty. */
export async function xlsxBuffer(sheets: readonly SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow([...s.headers]);
    for (const r of s.rows) ws.addRow(s.headers.map((h) => (r[h] === undefined || r[h] === null ? null : r[h])));
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export const ACCOUNT_HEADERS = {
  Regions: ['code', 'name'],
  Routes: ['code', 'name', 'region_code'],
  Users: [
    'username',
    'full_name',
    'role',
    'password',
    'must_change_password',
    'supervisor_username',
    'route_code',
    'region_codes',
    'change_role',
    'change_route',
    'change_name',
  ],
} as const;

export type AccountRows = {
  regions?: Array<Record<string, Cell>>;
  routes?: Array<Record<string, Cell>>;
  users?: Array<Record<string, Cell>>;
};

/** An account master (Regions, Routes, Users — only the sheets given). */
export function accountWorkbook(o: AccountRows): Promise<Buffer> {
  const sheets: SheetSpec[] = [];
  if (o.regions) sheets.push({ name: 'Regions', headers: ACCOUNT_HEADERS.Regions, rows: o.regions });
  if (o.routes) sheets.push({ name: 'Routes', headers: ACCOUNT_HEADERS.Routes, rows: o.routes });
  if (o.users) sheets.push({ name: 'Users', headers: ACCOUNT_HEADERS.Users, rows: o.users });
  return xlsxBuffer(sheets);
}

export const CUSTOMER_HEADERS = [
  'cust_code',
  'cust_name',
  'branch_code',
  'branch_name',
  'sales_region',
  'route',
  'address',
  'phone',
  'payment_terms',
  'day_of_visit',
  'customer_status',
  'temix_code',
] as const;

/** A customer master: one sheet, one row per branch. */
export function customerWorkbook(rows: Array<Record<string, Cell>>, headers: readonly string[] = CUSTOMER_HEADERS): Promise<Buffer> {
  return xlsxBuffer([{ name: 'Customers', headers, rows }]);
}

export type ReadSheet = {
  name: string;
  headers: string[];
  /** Cell text by header, one entry per data row. */
  rows: Array<Record<string, string>>;
  /** The solid fill (ARGB) of a data row's cell, or undefined. `row` is 0-based over `rows`. */
  fill(row: number, header: string): string | undefined;
};

/** Reads a downloaded workbook: every sheet, cell text by header, fills on demand. */
export async function readWorkbook(file: string | Buffer): Promise<ReadSheet[]> {
  const wb = new ExcelJS.Workbook();
  if (typeof file === 'string') await wb.xlsx.readFile(file);
  // exceljs's Buffer typing is narrower than Node's.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else await wb.xlsx.load(file as any);
  const out: ReadSheet[] = [];
  wb.eachSheet((ws) => {
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = cell.text.trim();
    });
    const rows: Array<Record<string, string>> = [];
    const rowNumbers: number[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) rec[h] = row.getCell(i + 1).text;
      });
      rows.push(rec);
      rowNumbers.push(n);
    });
    out.push({
      name: ws.name,
      headers: headers.filter(Boolean),
      rows,
      fill(r, header) {
        const col = headers.indexOf(header);
        const n = rowNumbers[r];
        if (col < 0 || n === undefined) return undefined;
        const f = ws.getRow(n).getCell(col + 1).fill as { type?: string; fgColor?: { argb?: string } } | undefined;
        return f?.type === 'pattern' ? f.fgColor?.argb : undefined;
      },
    });
  });
  return out;
}

/** Saves a Playwright download and reads it back. */
export async function readDownload(d: Download): Promise<{ name: string; sheets: ReadSheet[] }> {
  const p = await d.path();
  if (!p) throw new Error(`download ${d.suggestedFilename()} failed: ${await d.failure()}`);
  return { name: d.suggestedFilename(), sheets: await readWorkbook(p) };
}

/** A password of the shape the secret scan looks for (12+ characters, never logged). */
export function newSecretPassword(): string {
  const pw = `E2e-${randomBytes(12).toString('base64url')}-9a`;
  if (!FIXTURE_PASSWORD_SHAPE.test(pw)) throw new Error('newSecretPassword: shape drifted from secret-scan.ts');
  return pw;
}

/**
 * Full import / Temix buckets for a fixture Steward: import:<id> (both masters,
 * 3 per minute), temix:<id> (Generate) and temix-download:<id>. Fixture user
 * ids only — the cleanup deletes the same keys.
 */
export async function resetStewardLimits(u: FixtureUser): Promise<void> {
  if (!/^c[0-9a-z]{24}$/.test(u.id)) throw new Error(`resetStewardLimits: ${u.key} has no fixture id`);
  await db.rateLimit.deleteMany({ where: { key: { in: [`import:${u.id}`, `temix:${u.id}`, `temix-download:${u.id}`] } } });
}

/** Empties a fixture Steward's import bucket now (the next upload is told to wait). */
export async function drainStewardImports(u: FixtureUser): Promise<void> {
  if (!/^c[0-9a-z]{24}$/.test(u.id)) throw new Error(`drainStewardImports: ${u.key} has no fixture id`);
  const key = `import:${u.id}`;
  await db.rateLimit.upsert({
    where: { key },
    create: { key, tokens: 0, lastRefill: new Date() },
    update: { tokens: 0, lastRefill: new Date() },
  });
}

/** Customer import batches anyone holds a live promote lease on (org-wide; a promote refuses while one exists). */
export async function liveCustomerPromotes(exceptIds: string[] = []): Promise<number> {
  return db.importBatch.count({
    where: { kind: 'CUSTOMER', status: 'PROMOTING', promoteLeaseUntil: { gt: new Date() }, id: { notIn: exceptIds } },
  });
}

/** The value tile above a label (import batch Stat: value div, then label div). */
export function statValue(page: Page, label: string): Locator {
  return page.locator(`xpath=//div[normalize-space(text())="${label}"]/preceding-sibling::div[1]`).first();
}

/** The figure of a dashboard KPI tile (label div, then value div). */
export function kpiValue(page: Page, label: string): Locator {
  return page.locator(`xpath=//div[normalize-space(text())="${label}"]/following-sibling::div[1]`).first();
}

/** The figure of a /temix stat tile (label p, then value p). */
export function temixTile(page: Page, label: string): Locator {
  return page.locator(`xpath=//p[normalize-space(text())="${label}"]/following-sibling::p[1]`).first();
}

/** The PageHeader subtitle under the h1. */
export function pageSubtitle(page: Page): Locator {
  return page.locator('h1').first().locator('xpath=following-sibling::p[1]');
}

// ── Known app bugs this spec meets (open in the build under test) ────────────

/**
 * APP BUG, open in this build (found by the salesman-phone run of 8 Oct; a fix is
 * being made on claude/fix-nav-hang, components/nmwc/TransitionWatchdog.tsx, not
 * merged): a client transition that re-renders the page in place — router.refresh()
 * after a server action (import row Correct / Release / Exclude, Mark distinct,
 * Mark loaded), the revalidated answer of a server action (Create region / route,
 * Disable / Enable), a link or button that changes only the query string (Clear
 * filters, a period button, Next →) — is often parked by React and never shown:
 * the old screen stays, its buttons stay disabled, until a reload.
 */
export const NAV_HANG =
  'A page re-rendered in place (router.refresh after an action, a revalidated action answer, a link that changes only the query string) is often never shown until a reload';

/**
 * APP BUG, open in this build (found by access-control.spec.ts on 7 Oct; fixed on
 * claude/launch-candidate by 81c936e, which is not in this branch): lib/excel.ts
 * openStreamedWorkbook reads `PassThrough` from `await import('node:stream')`; the
 * webpack server build gives that import a namespace with only `default`, so every
 * streamed export — the customer master (/api/exports/customers) and the
 * field-update report (/api/exports/changes) — answers 500, "b is not a constructor".
 */
export const STREAMED_EXPORT_BUG =
  'Every streamed export (customer master, field-update report) answers 500: PassThrough lost by lib/excel.ts openStreamedWorkbook';

/** How long a page may take to show an action's result in place before the hang is assumed. */
export const IN_PLACE_MS = 15_000;

/**
 * An action's result that must show on the page: `check(timeout)` is the
 * assertion. When it is not shown in place within IN_PLACE_MS (NAV_HANG), the
 * server must have done the work (`serverDid`, read from the database), the hang
 * is recorded as an annotation, and the same assertion must then hold on a
 * reload — the test goes on to what it is about. The in-place display itself is
 * pinned by its own test.fail test.
 */
export async function shownOrReload(
  page: Page,
  what: string,
  check: (timeout: number) => Promise<unknown>,
  serverDid?: () => Promise<boolean>
): Promise<void> {
  const inPlace = await check(IN_PLACE_MS).then(
    () => true,
    () => false
  );
  if (inPlace) return;
  if (serverDid) await expect.poll(serverDid, { message: `${what}: the server did it`, timeout: 15_000 }).toBe(true);
  test.info().annotations.push({
    type: 'navigation hang (app bug)',
    description: `${what}: not shown in place after ${IN_PLACE_MS / 1000} s — reloaded`,
  });
  await page.reload();
  await check(20_000);
}

/**
 * A tap that must land on `url`. When the page has not moved within IN_PLACE_MS
 * (NAV_HANG), the server must have done the work (`serverDid`), the hang is
 * recorded, and `href` — what the tap asked for — is loaded, as the user would
 * by reloading.
 */
export async function landsOrGo(
  page: Page,
  url: RegExp,
  href: string,
  what: string,
  serverDid?: () => Promise<boolean>
): Promise<void> {
  const landed = await page.waitForURL(url, { timeout: IN_PLACE_MS, waitUntil: 'commit' }).then(
    () => true,
    () => false
  );
  if (landed) return;
  if (serverDid) await expect.poll(serverDid, { message: `${what}: the server did it`, timeout: 15_000 }).toBe(true);
  test.info().annotations.push({
    type: 'navigation hang (app bug)',
    description: `${what}: still at ${new URL(page.url()).pathname}${new URL(page.url()).search} after ${IN_PLACE_MS / 1000} s — loaded ${href}`,
  });
  await page.goto(href);
  await expect(page).toHaveURL(url);
}
