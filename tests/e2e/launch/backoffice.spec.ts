/**
 * BACK OFFICE — the Data Steward's data work and the read-only reporting, on the
 * launch build (production main + the four features + the wave-1 launch fixes +
 * the owner decisions of 7 Oct):
 *
 *   - account master import: create, an identical re-import that locks nobody
 *     out, held-back rows in words (red when nothing loaded), and the owner
 *     decision 8 rules the import now shares with Users (change_route,
 *     change_name, a supervisor who covers the route's region);
 *   - customer master import: stage, promote, fix / release / exclude in the
 *     app, rows rejected at promote, an interrupted promote resumed, a
 *     customer's status following its shops (owner decision 7), refused files;
 *     only one promote at a time (@exclusive: it holds a live lease);
 *   - routes and regions: create, refuse duplicates, switch off and on; region
 *     on/off is the Steward's alone, and a Manager switches a route only in a
 *     region he manages alone (owner decision 5);
 *   - Temix: generate, re-download, mark loaded, the inbound refresh, refusals
 *     in words (@exclusive: Generate takes the whole org-wide queue);
 *   - exports for every export role, with the refusals staying in the app;
 *   - duplicates: mark distinct, undo, merge (a CLOSED winner reopens — owner
 *     decision 7), cross-region merge with a reason;
 *   - the audit log for the Steward (every entity type) and a Manager (his
 *     regions only, Oman time);
 *   - dashboards (organisation, a fixture region, a Manager's hand-made URLs),
 *     service status, and the Steward's Work items.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts backoffice --project=desktop
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts backoffice --project=exclusive --workers=1
 */
import { expect, request as pwRequest, test, type Browser, type Locator, type Page } from '@playwright/test';
import type { Prisma } from '@prisma/client';
import {
  INITIAL_PASSWORD,
  MUSCAT,
  OMAN_TODAY,
  BASE_URL,
  auditFor,
  captureServerAction,
  changePasswordViaUi,
  contextAs,
  createWorld,
  db,
  expectNoDataLeak,
  expectNoSideScroll,
  fetchAs,
  hasR2,
  installLaunchHooks,
  newId,
  notificationsFor,
  omanDateISO,
  replayServerAction,
  requireLaunchEnv,
  seedUpdateEdit,
  signInViaUi,
  snapshot,
  type FixtureUser,
  type World,
} from './support';
import {
  IN_PLACE_MS,
  NAV_HANG,
  STREAMED_EXPORT_BUG,
  TEMIX_QUEUE_WHERE,
  XLSX_MIME,
  accountWorkbook,
  customerWorkbook,
  drainStewardImports,
  kpiValue,
  landsOrGo,
  liveCustomerPromotes,
  newSecretPassword,
  omanDate,
  omanDateTime,
  pageSubtitle,
  readDownload,
  resetStewardLimits,
  shownOrReload,
  statValue,
  temixTile,
  xlsxBuffer,
  type AccountRows,
  type Cell,
} from './support/backoffice-helpers';

// ── shared page helpers ──────────────────────────────────────────────────────

/** Native confirm() / alert() are accepted (Promote, route toggles, merges, mark distinct). */
function acceptDialogs(page: Page): void {
  page.on('dialog', (d) => void d.accept().catch(() => undefined));
}

/**
 * Resolves once the page has SHOWN the text, even for a frame: several
 * messages ("✓ Done …", "Marked as distinct.", "✓ Merged.") are replaced by
 * the refreshed page a moment later. Start it before the click, await it after.
 */
function seeText(page: Page, text: string | RegExp, timeout = 120_000): Promise<unknown> {
  const arg = typeof text === 'string' ? { s: text, r: '', f: '' } : { s: '', r: text.source, f: text.flags };
  return page.waitForFunction(
    (t) => {
      const body = document.body?.innerText ?? '';
      return t.r ? new RegExp(t.r, t.f).test(body) : body.includes(t.s);
    },
    arg,
    { polling: 'raf', timeout }
  );
}

async function openAs(browser: Browser, u: FixtureUser, path: string, device?: 'phone' | 'desktop'): Promise<Page> {
  const page = await (await contextAs(browser, u, device ? { device } : {})).newPage();
  acceptDialogs(page);
  await page.goto(path);
  return page;
}

/**
 * Uploads a workbook through one of the two /import panels, on a fresh page
 * load (so the message read is this upload's), and returns the result line.
 */
async function upload(
  page: Page,
  panel: 'Account master' | 'Customer master',
  file: { name: string; buffer: Buffer }
): Promise<Locator> {
  await page.goto('/import');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: panel, exact: true }) });
  await section.locator('input[type="file"]').setInputFiles({ name: file.name, mimeType: XLSX_MIME, buffer: file.buffer });
  await section.getByRole('button', { name: panel === 'Account master' ? 'Upload account master' : 'Upload customer master' }).click();
  const msg = section.locator('form p[role="status"], form p[role="alert"]');
  await expect(msg).toBeVisible({ timeout: 90_000 });
  return msg;
}

/** The batch id from the result line's "Open the batch" link. */
async function batchIdOf(msg: Locator): Promise<string> {
  const href = await msg.getByRole('link', { name: 'Open the batch' }).getAttribute('href');
  const id = /^\/import\/([^/?#]+)$/.exec(href ?? '')?.[1];
  if (!id) throw new Error(`no batch link in the upload result (href ${href})`);
  return id;
}

/** A row of the import batch table by its Row cell ("#5", "Users #3"). */
function batchRow(page: Page, label: string): Locator {
  return page.locator('tbody tr').filter({ has: page.getByText(label, { exact: true }) });
}

/** The Steward's Work entry for a batch. */
function workItem(page: Page, batchId: string): Locator {
  return page.locator(`a[href="/import/${batchId}"]`);
}

/**
 * Clicks a download control on /export and returns the file — or fails at once
 * with the words the page showed instead (a refusal is shown in the form's
 * alert, launch fix exportRawJson), rather than waiting a minute for a download
 * that will not come.
 */
async function downloadOrRefusal(page: Page, click: () => Promise<void>): Promise<Awaited<ReturnType<typeof readDownload>>> {
  const alert = page.locator('form p[role="alert"]');
  const dl = page.waitForEvent('download', { timeout: 90_000 });
  await click();
  const first = await Promise.race([
    dl.then((d) => ({ d, refusal: null as string | null })),
    alert.waitFor({ timeout: 90_000 }).then(async () => ({ d: null, refusal: (await alert.textContent()) ?? '' })),
  ]);
  dl.catch(() => undefined);
  expect(first.refusal, 'the export page answered with a refusal instead of a file').toBeNull();
  return readDownload(first.d!);
}

const ADDRESS = 'Way 2741, Al Khuwair, Muscat';

// ═════════════════════════════════════════════════════════════════════════════
// 1–2. Account and customer master imports (SV-ACCT-*, SV-CUST-IMPORT-*,
//      SV-IMPORT-FILE-GUARDS, UPLOAD-RATE-AND-IMPORT-SIZE, SV-WORK-ITEMS-STEWARD)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: account and customer master imports', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let stw: FixtureUser;
  /** The account sheet: values fixed once, so the re-import is byte-for-byte the same sheet. */
  const acct = {
    regionCode: '',
    regionName: '',
    routeCode: '',
    routeName: '',
    salesman: '',
    salesmanName: '',
    accountant: '',
    accountantPw: '',
    viewer: '',
    viewerPw: '',
  };
  let accountCreateBatch = '';
  let importedSalesman: FixtureUser | undefined;
  let accountCreated = false;

  // Customer batches and their customer codes.
  const code = { NEWA: '', NEWB: '', SHARE: '', BADPT: '', BADDAY: '', NEWC: '', NEWD: '', NEWE: '', NEWF: '' };
  const phones: string[] = [];
  let b1 = ''; // stage → promote → fix
  let b1Promoted = false;
  let b2 = ''; // rejected at promote
  let b3 = ''; // interrupted promote
  const RELEASE_REASON = 'Same owner, a second shop on one number';
  const EXCLUDE_REASON = 'Payment terms to be confirmed with the owner';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bki', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
        { key: 'FREE', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M2', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SA2', role: 'SALESMAN', route: 'A2', supervisor: 'M2' },
      ],
      customers: [
        { key: 'HOLD', phone: true, contact: 'Hamed Al Siyabi', branches: [{ key: 'S', route: 'A' }] },
        { key: 'ARCH', phone: true, archived: true, branches: [{ key: 'S', route: 'A' }] },
        { key: 'STC', phone: true, contact: 'Said Al Amri', branches: [{ key: 'S', route: 'A' }] },
      ],
    });
    stw = w.user('STW');
    Object.assign(acct, {
      regionCode: `E2R${w.SFX}I`,
      regionName: w.name('Import Region'),
      routeCode: `E2${w.SFX}I`,
      routeName: w.name('Import Route'),
      salesman: `e2${w.sfx}i`,
      salesmanName: w.name('Zahir Import'),
      accountant: `e2e.acc9.${w.sfx}`,
      accountantPw: newSecretPassword(),
      viewer: `e2e.vw9.${w.sfx}`,
      viewerPw: newSecretPassword(),
    });
    for (const k of Object.keys(code) as (keyof typeof code)[]) code[k] = `E2E${w.SFX}-${k}`;
    phones.push(...(await w.allocPhones(10)));
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  const createSheet = (): AccountRows => ({
    regions: [{ code: acct.regionCode, name: acct.regionName }],
    routes: [{ code: acct.routeCode, name: acct.routeName, region_code: w.region('R1').code }],
    users: [
      {
        username: acct.salesman,
        full_name: acct.salesmanName,
        role: 'SALESMAN',
        password: INITIAL_PASSWORD,
        must_change_password: 'yes',
        supervisor_username: w.user('M1').username,
        route_code: acct.routeCode,
      },
      { username: acct.accountant, full_name: w.name('Amal Import'), role: 'ACCOUNTANT', password: acct.accountantPw, region_codes: acct.regionCode },
      { username: acct.viewer, full_name: w.name('Vera Import'), role: 'VIEWER', password: acct.viewerPw },
    ],
  });

  /** A branch row of the customer master, region R1 / route A unless the extra says otherwise. */
  const row = (cust: string, name: string, extra: Record<string, Cell> = {}): Record<string, Cell> => ({
    cust_code: cust,
    cust_name: name,
    branch_code: `${cust}-01`,
    branch_name: `${name} shop`,
    sales_region: w.region('R1').code,
    route: w.route('A').code,
    address: ADDRESS,
    payment_terms: 'CASH',
    day_of_visit: OMAN_TODAY,
    ...extra,
  });

  // ── 1. Account master ──────────────────────────────────────────────────────

  test('account master: a region, a route, a salesman, an accountant and a viewer are created; the salesman claims his account on a phone', async ({ browser }) => {
    test.setTimeout(300_000);
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const file = { name: `${w.sfx}-accounts.xlsx`, buffer: await accountWorkbook(createSheet()) };
    const msg = await upload(page, 'Account master', file);
    await expect(msg).toHaveText(/^Uploaded — 5 clean · 0 issues/);
    await expect(msg).toHaveAttribute('role', 'status');
    await expect(msg).toHaveClass(/text-emerald-700/);
    accountCreateBatch = await batchIdOf(msg);
    w.adopt.importBatch(accountCreateBatch);
    // Every account the sheet made carries the suffix; registered by value as well.
    w.adopt.regionCode(acct.regionCode);
    w.adopt.routeCode(acct.routeCode);
    for (const u of [acct.salesman, acct.accountant, acct.viewer]) w.adopt.user(u);

    // Recent batches: ACCOUNT, PROMOTED, Clean 5, Quarantined 0.
    await page.reload();
    const recent = page.locator('tbody tr').filter({ hasText: file.name });
    await expect(recent).toHaveCount(1);
    await expect(recent.locator('td').nth(2)).toHaveText('ACCOUNT');
    await expect(recent.locator('td').nth(4)).toHaveText('PROMOTED');
    await expect(recent.locator('td').nth(6)).toHaveText('5');
    await expect(recent.locator('td').nth(7)).toHaveText('0');

    // The database: region, route in R1, the salesman on it under M1 and forced to change.
    const region = await db.region.findUniqueOrThrow({ where: { code: acct.regionCode } });
    const route = await db.route.findUniqueOrThrow({ where: { code: acct.routeCode } });
    expect(route.regionId).toBe(w.region('R1').id);
    const sm = await db.user.findUniqueOrThrow({ where: { username: acct.salesman } });
    expect(sm).toMatchObject({ role: 'SALESMAN', ownedRouteId: route.id, supervisorId: w.user('M1').id, mustChangePassword: true, isActive: true });
    const acc = await db.user.findUniqueOrThrow({ where: { username: acct.accountant }, include: { managedRegions: { select: { code: true } } } });
    expect(acc.role).toBe('ACCOUNTANT');
    expect(acc.managedRegions.map((r) => r.code)).toEqual([acct.regionCode]);
    expect((await db.user.findUniqueOrThrow({ where: { username: acct.viewer } })).role).toBe('VIEWER');
    accountCreated = true;

    // The ledger: a CREATE per region, route and account (reason account_import, the batch named) and one IMPORT.
    const vw = await db.user.findUniqueOrThrow({ where: { username: acct.viewer } });
    for (const [entityType, entityId] of [
      ['Region', region.id],
      ['Route', route.id],
      ['User', sm.id],
      ['User', acc.id],
      ['User', vw.id],
    ] as const) {
      const rows = await auditFor({ entityId, action: 'CREATE' });
      expect(rows, `${entityType} ${entityId}`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entityType, reason: 'account_import', actorId: stw.id });
      expect((rows[0]!.after as { batchId?: string } | null)?.batchId).toBe(accountCreateBatch);
    }
    const imp = await auditFor({ entityId: accountCreateBatch, action: 'IMPORT' });
    expect(imp.map((a) => a.reason)).toEqual(['account_master_upload']);

    // /users: the new accounts are listed; the salesman has not claimed his yet.
    await page.goto('/users');
    await expect(page.locator('tbody tr').filter({ hasText: acct.salesman })).toContainText('Not signed in yet');
    for (const u of [acct.accountant, acct.viewer]) await expect(page.locator('tbody tr').filter({ hasText: u })).toHaveCount(1);

    // The salesman signs in on a phone with the hand-out password, must change it, then lands on Today.
    importedSalesman = {
      key: 'IMPS',
      id: sm.id,
      username: acct.salesman,
      fullName: acct.salesmanName,
      role: 'SALESMAN',
      password: INITIAL_PASSWORD,
      regionIds: [],
      routeId: route.id,
      routeCode: acct.routeCode,
      supervisorId: w.user('M1').id,
      mustChangePassword: true,
    };
    const phone = await (await contextAs(browser, null, { device: 'phone' })).newPage();
    await signInViaUi(phone, acct.salesman, INITIAL_PASSWORD, { ip: w.ip(1) });
    await expect(phone).toHaveURL(/\/profile\/change-password(\?|$)/);
    await changePasswordViaUi(phone, importedSalesman, newSecretPassword());
    await expect(phone).toHaveURL(/\/today(\?|$)/, { timeout: 30_000 });
    await expect(phone.getByRole('heading', { level: 1, name: 'Good day, Zahir' })).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: sm.id } })).mustChangePassword).toBe(false);
  });

  test('account master: re-importing the identical sheet changes nobody and locks nobody out', async ({ browser }) => {
    test.skip(!accountCreated || !importedSalesman || importedSalesman.mustChangePassword, 'needs the claimed account from the test before');
    test.setTimeout(240_000);
    const sm = importedSalesman!;
    // His own session on the phone, after he chose his password.
    const phone = await openAs(browser, sm, '/today', 'phone');
    await expect(phone).toHaveURL(/\/today(\?|$)/);
    const before = await db.user.findUniqueOrThrow({
      where: { id: sm.id },
      select: { passwordHash: true, sessionsRevokedAt: true, mustChangePassword: true, ownedRouteId: true, supervisorId: true, fullName: true },
    });
    const t0 = new Date();

    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const msg = await upload(page, 'Account master', { name: `${w.sfx}-accounts-again.xlsx`, buffer: await accountWorkbook(createSheet()) });
    await expect(msg).toHaveText(/^Uploaded — 5 clean · 0 issues/);
    const again = await batchIdOf(msg);
    w.adopt.importBatch(again);

    // Nothing re-armed: the same hash, the same revocation stamp, no forced change, nothing moved.
    const after = await db.user.findUniqueOrThrow({
      where: { id: sm.id },
      select: { passwordHash: true, sessionsRevokedAt: true, mustChangePassword: true, ownedRouteId: true, supervisorId: true, fullName: true },
    });
    expect(after).toEqual(before);
    expect(after.mustChangePassword).toBe(false);
    // No UPDATE rows for unchanged accounts, regions or routes; one new IMPORT summary.
    const updates = await db.auditLog.count({ where: { actorId: stw.id, action: 'UPDATE', reason: 'account_import', at: { gte: t0 } } });
    expect(updates).toBe(0);
    expect((await auditFor({ entityId: again, action: 'IMPORT' })).map((a) => a.reason)).toEqual(['account_master_upload']);

    // His session keeps working: no bounce to the change screen.
    await phone.reload();
    await expect(phone).toHaveURL(/\/today(\?|$)/);
    await phone.goto('/customers');
    await expect(phone).toHaveURL(/\/customers(\?|$)/);
    await expect(phone).not.toHaveURL(/change-password/);
  });

  test('account master: bad rows are held back in words, the result is red, and nothing is half-written', async ({ browser }) => {
    test.setTimeout(240_000);
    const sa = w.user('SA');
    const bad = {
      route: `E2${w.SFX}Q`,
      noRoute: `e2e.noroute.${w.sfx}`,
      newMgr: `e2e.newmgr.${w.sfx}`,
      shortPw: `e2e.shortpw.${w.sfx}`,
      noRegion: `e2e.noreg.${w.sfx}`,
      boss: `e2e.boss.${w.sfx}`,
    };
    const saBefore = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
    const t0 = new Date();
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const sheet: AccountRows = {
      routes: [{ code: bad.route, name: w.name('Orphan Route'), region_code: `NOPE${w.SFX}` }],
      users: [
        { username: bad.noRoute, full_name: w.name('No Route'), role: 'SALESMAN', password: INITIAL_PASSWORD, must_change_password: 'yes' },
        { username: bad.newMgr, full_name: w.name('New Manager'), role: 'MANAGER', password: newSecretPassword(), region_codes: w.region('R1').code },
        { username: bad.shortPw, full_name: w.name('Short Password'), role: 'VIEWER', password: 'abcdef' },
        { username: bad.noRegion, full_name: w.name('No Region'), role: 'ACCOUNTANT', password: newSecretPassword() },
        { username: bad.boss, full_name: w.name('The Boss'), role: 'BOSS', password: newSecretPassword() },
        { username: sa.username, full_name: sa.fullName, role: 'VIEWER' },
      ],
    };
    const msg = await upload(page, 'Account master', { name: `${w.sfx}-accounts-bad.xlsx`, buffer: await accountWorkbook(sheet) });
    // Launch fix (wave 1): nothing loaded is a red failure that links the batch.
    await expect(msg).toHaveText(/^Nothing was loaded: every row was held back \(0 clean · 7 issues\)\. Open the batch to see why\./);
    await expect(msg).toHaveAttribute('role', 'alert');
    await expect(msg).toHaveClass(/text-red-600/);
    const batchId = await batchIdOf(msg);
    w.adopt.importBatch(batchId);

    await page.goto(`/import/${batchId}`);
    await expect(page.getByRole('link', { name: /^Needs attention\s*7$/ })).toBeVisible();
    const expected: Array<[string, string, string]> = [
      ['Routes #2', 'Routes sheet, row 2', `region "NOPE${w.SFX}" not found`],
      ['Users #2', 'Users sheet, row 2', 'salesman needs route_code'],
      ['Users #3', 'Users sheet, row 3', 'creating MANAGER or STEWARD via import is not permitted — use the Users UI'],
      ['Users #4', 'Users sheet, row 4', 'password must be 12+ chars (or set must_change_password=yes)'],
      ['Users #5', 'Users sheet, row 5', `ACCOUNTANT "${bad.noRegion}" manages no region, so it can see nothing and clear no approval step. Set region_codes and re-import. Nothing was written.`],
      ['Users #6', 'Users sheet, row 6', 'role "BOSS" not one of SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER, ACCOUNTANT, FINANCE_MANAGER, GM'],
      ['Users #7', 'Users sheet, row 7', `"${sa.username}" is SALESMAN in the CRM but VIEWER in this row. Nothing was written. Correct the role cell, or set change_role to yes to change the role.`],
    ];
    for (const [rowLabel, line, message] of expected) {
      const r = batchRow(page, rowLabel);
      await expect(r, rowLabel).toHaveCount(1);
      await expect(r).toContainText(`${line}: ${message}`);
    }
    // Account batches are re-uploaded, not fixed: no Fix column, no Correct buttons.
    await expect(page.getByRole('columnheader', { name: 'Fix' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Correct…' })).toHaveCount(0);
    // The ImportRow rows carry the Excel row (N05 / launch fix), not the issue's index.
    const rows = await db.importRow.findMany({ where: { batchId }, select: { rowNumber: true, raw: true } });
    expect(rows.map((r) => `${(r.raw as { sheet: string }).sheet}#${r.rowNumber}`).sort()).toEqual(
      ['Routes#2', 'Users#2', 'Users#3', 'Users#4', 'Users#5', 'Users#6', 'Users#7'].sort()
    );

    // Nothing half-written.
    expect(await db.user.count({ where: { username: { in: Object.values(bad) } } })).toBe(0);
    expect(await db.route.count({ where: { code: bad.route } })).toBe(0);
    const saAfter = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
    expect({ role: saAfter.role, ownedRouteId: saAfter.ownedRouteId, passwordHash: saAfter.passwordHash }).toEqual({
      role: saBefore.role,
      ownedRouteId: saBefore.ownedRouteId,
      passwordHash: saBefore.passwordHash,
    });
    expect(await db.auditLog.count({ where: { actorId: stw.id, action: 'REASSIGN', at: { gte: t0 } } })).toBe(0);
  });

  test('account master (owner decision 8): a route leaves an active salesman only on change_route, a name changes only on change_name, and the supervisor must cover the region', async ({ browser }) => {
    test.setTimeout(240_000);
    const sa = w.user('SA');
    const sa2 = w.user('SA2');
    const A2 = w.route('A2');
    const FREE = w.route('FREE');
    const R1 = w.region('R1');
    const joiner = `e2e.join.${w.sfx}`;
    const coverless = `e2e.cov.${w.sfx}`;
    const joinerRow = (extra: Record<string, Cell> = {}) => ({
      username: joiner,
      full_name: w.name('Jamal Joiner'),
      role: 'SALESMAN',
      password: INITIAL_PASSWORD,
      must_change_password: 'yes',
      supervisor_username: w.user('M1').username,
      route_code: A2.code,
      ...extra,
    });

    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const first = await upload(page, 'Account master', {
      name: `${w.sfx}-accounts-handover.xlsx`,
      buffer: await accountWorkbook({
        users: [
          joinerRow(),
          { username: sa.username, full_name: w.name('Somebody Else'), role: 'SALESMAN', route_code: w.route('A').code },
          {
            username: coverless,
            full_name: w.name('Coverless'),
            role: 'SALESMAN',
            password: INITIAL_PASSWORD,
            must_change_password: 'yes',
            supervisor_username: w.user('M5').username,
            route_code: FREE.code,
          },
        ],
      }),
    });
    await expect(first).toHaveText(/^Nothing was loaded: every row was held back \(0 clean · 3 issues\)/);
    const firstBatch = await batchIdOf(first);
    w.adopt.importBatch(firstBatch);
    await page.goto(`/import/${firstBatch}`);
    await expect(batchRow(page, 'Users #2')).toContainText(
      `route ${A2.code} is worked by "${sa2.username}", whose account is active. Nothing was written for "${joiner}".`
    );
    await expect(batchRow(page, 'Users #3')).toContainText(
      `this row's full_name is not the name of the salesman who signs in as "${sa.username}". Nothing was written.`
    );
    await expect(batchRow(page, 'Users #4')).toContainText(
      `supervisor "${w.user('M5').username}" does not cover region ${R1.code}, where route ${FREE.code} is`
    );
    expect(await db.user.count({ where: { username: { in: [joiner, coverless] } } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: sa.id } })).fullName).toBe(sa.fullName);
    expect((await db.user.findUniqueOrThrow({ where: { id: sa2.id } })).ownedRouteId).toBe(A2.id);

    // change_route = yes: the route moves to the joiner, and the hand-over is audited on the holder.
    await resetStewardLimits(stw);
    const second = await upload(page, 'Account master', {
      name: `${w.sfx}-accounts-handover2.xlsx`,
      buffer: await accountWorkbook({ users: [joinerRow({ change_route: 'yes' })] }),
    });
    await expect(second).toHaveText(/^Uploaded — 1 clean · 0 issues/);
    w.adopt.importBatch(await batchIdOf(second));
    w.adopt.user(joiner);
    const j = await db.user.findUniqueOrThrow({ where: { username: joiner } });
    expect(j).toMatchObject({ ownedRouteId: A2.id, supervisorId: w.user('M1').id, mustChangePassword: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: sa2.id }, select: { ownedRouteId: true, isActive: true } })).toEqual({
      ownedRouteId: null,
      isActive: true,
    });
    const reassign = await auditFor({ entityId: sa2.id, action: 'REASSIGN' });
    expect(reassign.map((a) => a.reason)).toEqual([`route ${A2.code} reassigned to ${joiner} via import`]);
  });

  // ── 2. Customer master ─────────────────────────────────────────────────────

  test('customer master: rows are staged; a shared phone and bad cells are held back with the value as uploaded', async ({ browser }) => {
    test.setTimeout(240_000);
    const hold = w.customer('HOLD');
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const name = (k: string) => w.name(`Imported ${k}`);
    const rows = [
      row(code.NEWA, name('NEWA'), { phone: phones[0] }),
      row(code.NEWA, name('NEWA'), { phone: phones[0], branch_code: `${code.NEWA}-02`, branch_name: `${name('NEWA')} shop 2` }),
      row(code.NEWB, name('NEWB'), { phone: phones[1] }),
      row(code.SHARE, name('SHARE'), { phone: hold.phone }),
      row(code.BADPT, name('BADPT'), { phone: phones[2], payment_terms: 'Crdit' }),
      row(code.BADDAY, name('BADDAY'), { phone: phones[3], day_of_visit: 'Mnday' }),
    ];
    const file = { name: `${w.sfx}-customers-1.xlsx`, buffer: await customerWorkbook(rows) };
    const msg = await upload(page, 'Customer master', file);
    // Launch fix (wave 1): some rows held back is an amber warning that links the batch.
    await expect(msg).toHaveText(/^Uploaded — 3 clean · 3 quarantined\. Some rows were held back: open the batch to see why\./);
    await expect(msg).toHaveClass(/text-amber-700/);
    b1 = await batchIdOf(msg);
    w.adopt.importBatch(b1);

    await page.goto(`/import/${b1}`);
    await expect(page.getByRole('heading', { level: 1, name: file.name })).toBeVisible();
    await expect(pageSubtitle(page)).toHaveText('CUSTOMER import · 6 rows · READY');
    for (const [label, value] of [
      ['Total', '6'],
      ['Clean', '3'],
      ['Quarantined', '3'],
      ['Promoted', '0'],
      ['Rejected', '0'],
      ['Left to promote', '3'],
    ] as const) {
      await expect(statValue(page, label), label).toHaveText(value);
    }
    await expect(page.getByRole('button', { name: 'Promote 3 clean rows' })).toBeEnabled();
    await expect(page.getByRole('link', { name: /^Needs attention\s*3$/ })).toBeVisible();
    // Each problem in words: the phone names the customer holding it.
    await expect(batchRow(page, '#5')).toContainText(`Phone: phone already exists in master on customer ${hold.code}`);
    await expect(batchRow(page, '#6')).toContainText('Payment terms: expected CASH or CREDIT, got "CRDIT"');
    await expect(batchRow(page, '#7')).toContainText('Visit day: expected SAT/SUN/MON/TUE/WED/THU/FRI, got "MNDAY"');
    // "As uploaded" is the sheet's own value, not the parser's fallback.
    const asUploaded = batchRow(page, '#6').locator('details');
    await asUploaded.locator('summary').click();
    await expect(asUploaded.locator('dt', { hasText: 'payment_terms' }).locator('xpath=following-sibling::dd[1]')).toHaveText('Crdit');

    // rowNumber is the Excel row; nothing is in the master yet.
    const stored = await db.importRow.findMany({ where: { batchId: b1 }, orderBy: { rowNumber: 'asc' }, select: { rowNumber: true, state: true } });
    expect(stored.map((r) => `${r.rowNumber}:${r.state}`)).toEqual(['2:CLEAN', '3:CLEAN', '4:CLEAN', '5:QUARANTINED', '6:QUARANTINED', '7:QUARANTINED']);
    expect(await db.customer.count({ where: { nmwcCode: { in: Object.values(code) } } })).toBe(0);
  });

  test('customer master: Promote loads the clean rows, and the salesman finds them on Today and in search', async ({ browser }) => {
    test.skip(!b1, 'needs the staged batch from the test before');
    const live = await liveCustomerPromotes();
    test.skip(live > 0, `another customer import holds a live promote lease (${live}) — only one promote runs at a time`);
    test.setTimeout(300_000);
    const page = await openAs(browser, stw, `/import/${b1}`);
    const running = seeText(page, 'Promoting…');
    const done = seeText(page, '✓ Done — 3 rows promoted in this run.');
    await page.getByRole('button', { name: 'Promote 3 clean rows' }).click();
    await running;
    await done;
    b1Promoted = true;

    await page.reload();
    await expect(pageSubtitle(page)).toHaveText('CUSTOMER import · 6 rows · PROMOTED');
    await expect(statValue(page, 'Promoted')).toHaveText('3');
    await expect(statValue(page, 'Left to promote')).toHaveText('0');
    await expect(page.getByRole('button', { name: /^Promote / })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Needs attention\s*3$/ })).toBeVisible();

    // The master: two customers, three branches on route A / region R1, today's visit day, queued for Temix, scored.
    const custs = await db.customer.findMany({
      where: { nmwcCode: { in: [code.NEWA, code.NEWB] } },
      include: { branches: { where: { deletedAt: null } } },
    });
    custs.forEach((c) => w.adopt.customer(c.id));
    expect(custs.map((c) => c.nmwcCode).sort()).toEqual([code.NEWA, code.NEWB].sort());
    for (const c of custs) {
      expect(c).toMatchObject({ importBatchId: b1, temixSyncState: 'PENDING_UPLOAD', temixCode: null, status: 'ACTIVE' });
      expect(c.completenessScore, `${c.nmwcCode} is scored`).toBeGreaterThan(0);
      for (const b of c.branches) {
        expect(b).toMatchObject({ routeId: w.route('A').id, regionId: w.region('R1').id, dayOfVisit: OMAN_TODAY });
      }
    }
    expect(custs.flatMap((c) => c.branches)).toHaveLength(3);
    const promoteAudit = await auditFor({ entityId: b1, action: 'IMPORT' });
    expect(promoteAudit.map((a) => a.reason)).toContain('customer_master_promote');

    // The salesman of route A, on his phone.
    const sa = await openAs(browser, w.user('SA'), '/today', 'phone');
    for (const c of custs) {
      await expect(sa.getByRole('heading', { level: 3, name: c.legalName, exact: true }).first()).toBeVisible();
    }
    const newa = custs.find((c) => c.nmwcCode === code.NEWA)!;
    await sa.goto(`/customers?q=${encodeURIComponent(newa.legalName)}`);
    await expect(sa.getByText(newa.legalName).first()).toBeVisible();

    // Work: the batch still has three problem rows.
    const work = await openAs(browser, stw, '/work');
    await expect(workItem(work, b1)).toContainText('Import to review');
    await expect(workItem(work, b1)).toContainText('3 rows held back or rejected, not yet fixed or excluded');
  });

  test('customer master: a held-back row is corrected, a shared phone released, a row excluded and included again; the batch promotes again and leaves Work', async ({ browser }) => {
    test.skip(!b1Promoted, 'needs the promoted batch from the test before');
    test.setTimeout(300_000);
    const rows = await db.importRow.findMany({ where: { batchId: b1 }, select: { id: true, rowNumber: true } });
    const idOf = (n: number) => rows.find((r) => r.rowNumber === n)!.id;
    const stored = (n: number) =>
      db.importRow.findUniqueOrThrow({ where: { id: idOf(n) }, select: { state: true, excludedAt: true } });
    const page = await openAs(browser, stw, `/import/${b1}?show=all`);

    // 1. Correct the visit day the problem names (payment terms are never editable here).
    await expect(batchRow(page, '#6').getByRole('button', { name: 'Correct…' })).toHaveCount(0);
    await batchRow(page, '#7').getByRole('button', { name: 'Correct…' }).click();
    await page.locator(`#fix-${idOf(7)}-day_of_visit`).fill(OMAN_TODAY);
    await batchRow(page, '#7').getByRole('button', { name: 'Save and re-check' }).click();
    // The row's own result line (the action's answer, shown before the page refreshes).
    await expect(batchRow(page, '#7')).toContainText('Ready to promote (1 row). Promote the batch to load it.');
    // On "All rows" the row stays after the refresh, marked fixed; a promoted batch with a fixed row is promotable again.
    await shownOrReload(
      page,
      'Correct… on row #7',
      async (timeout) => {
        await expect(batchRow(page, '#7')).toContainText('Fixed in the app — loads on the next promote.', { timeout });
        await expect(pageSubtitle(page)).toHaveText(/· READY$/, { timeout });
      },
      async () => (await stored(7)).state === 'CLEAN'
    );

    // 2. Release the shared phone, with a reason.
    await batchRow(page, '#5').getByRole('button', { name: 'Release shared phone…' }).click();
    await page.locator(`#release-${idOf(5)}`).fill(RELEASE_REASON);
    await batchRow(page, '#5').getByRole('button', { name: 'Release and re-check' }).click();
    await expect(batchRow(page, '#5')).toContainText('Ready to promote (1 row). Promote the batch to load it.');
    await shownOrReload(
      page,
      'Release shared phone… on row #5',
      async (timeout) => {
        await expect(batchRow(page, '#5')).toContainText(`Shared phone released: ${RELEASE_REASON}`, { timeout });
        await expect(page.getByRole('link', { name: /^Fixed, waiting to promote\s*2$/ })).toBeVisible({ timeout });
      },
      async () => (await stored(5)).state === 'CLEAN'
    );

    // 3. Exclude the payment-terms row, then include it again.
    await batchRow(page, '#6').getByRole('button', { name: 'Exclude…' }).click();
    await page.locator(`#exclude-${idOf(6)}`).fill('Waiting for the owner to confirm');
    await batchRow(page, '#6').getByRole('button', { name: 'Exclude this row' }).click();
    await shownOrReload(
      page,
      'Exclude… on row #6',
      async (timeout) => {
        await expect(batchRow(page, '#6')).toContainText(`Excluded by ${stw.fullName}: Waiting for the owner to confirm`, { timeout });
        await expect(page.getByRole('link', { name: /^Needs attention\s*0$/ })).toBeVisible({ timeout });
      },
      async () => (await stored(6)).excludedAt !== null
    );
    await batchRow(page, '#6').getByRole('button', { name: 'Include again' }).click();
    await shownOrReload(
      page,
      'Include again on row #6',
      async (timeout) => {
        await expect(batchRow(page, '#6').getByRole('button', { name: 'Exclude…' })).toBeVisible({ timeout });
        await expect(page.getByRole('link', { name: /^Needs attention\s*1$/ })).toBeVisible({ timeout });
      },
      async () => (await stored(6)).excludedAt === null
    );

    // Work: an open problem row → "Import to review".
    const work = await openAs(browser, stw, '/work');
    await expect(workItem(work, b1)).toContainText('Import to review');

    // Exclude it for good: only fixed rows are left → "Import to promote".
    await page.reload();
    await batchRow(page, '#6').getByRole('button', { name: 'Exclude…' }).click();
    await page.locator(`#exclude-${idOf(6)}`).fill(EXCLUDE_REASON);
    await batchRow(page, '#6').getByRole('button', { name: 'Exclude this row' }).click();
    await shownOrReload(
      page,
      'Exclude… on row #6, for good',
      (timeout) => expect(batchRow(page, '#6')).toContainText(`Excluded by ${stw.fullName}: ${EXCLUDE_REASON}`, { timeout }),
      async () => (await stored(6)).excludedAt !== null
    );
    await work.reload();
    await expect(workItem(work, b1)).toContainText('Import to promote');
    await expect(workItem(work, b1)).toContainText('Rows fixed in the app are waiting to be promoted');

    // 4. Promote again.
    const live = await liveCustomerPromotes();
    test.skip(live > 0, `another customer import holds a live promote lease (${live})`);
    const done = seeText(page, '✓ Done — 2 rows promoted in this run.');
    await page.getByRole('button', { name: 'Promote 2 clean rows' }).click();
    await done;
    await page.reload();
    await expect(pageSubtitle(page)).toHaveText(/· PROMOTED$/);
    await expect(batchRow(page, '#5')).toContainText(`Shared phone released: ${RELEASE_REASON}`);
    const loaded = await db.customer.findMany({ where: { nmwcCode: { in: [code.SHARE, code.BADDAY] } }, select: { id: true, nmwcCode: true } });
    loaded.forEach((c) => w.adopt.customer(c.id));
    expect(loaded.map((c) => c.nmwcCode).sort()).toEqual([code.BADDAY, code.SHARE].sort());
    expect(await db.customer.count({ where: { nmwcCode: code.BADPT } })).toBe(0);

    // 5. Work: nothing left open → the batch is gone from the list.
    await work.reload();
    await expect(workItem(work, b1)).toHaveCount(0);

    // Every action is in the ledger.
    expect((await auditFor({ entityId: idOf(7), action: 'UPDATE' })).map((a) => a.reason)).toContain('Import row corrected by the Data Steward');
    expect((await auditFor({ entityId: idOf(5), action: 'FORCE_OVERRIDE' })).map((a) => a.reason)).toEqual([
      `Shared phone released by the Data Steward: ${RELEASE_REASON}`,
    ]);
    expect((await auditFor({ entityId: idOf(6), action: 'UPDATE' })).map((a) => a.reason)).toContain('Import row included again by the Data Steward');
    const excluded = (await auditFor({ entityId: b1, action: 'UPDATE' })).map((a) => a.reason);
    expect(excluded).toEqual(
      expect.arrayContaining([
        'Import rows accepted as excluded: Waiting for the owner to confirm',
        `Import rows accepted as excluded: ${EXCLUDE_REASON}`,
      ])
    );
  });

  test('customer master: a row rejected at promote is counted, explained and listed on Work', async ({ browser }) => {
    test.setTimeout(300_000);
    const arch = w.customer('ARCH');
    const archBefore = await snapshot(['Customer', 'Branch'], { Customer: { id: arch.id }, Branch: { customerId: arch.id } });
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const msg = await upload(page, 'Customer master', {
      name: `${w.sfx}-customers-2.xlsx`,
      buffer: await customerWorkbook([
        row(arch.code, arch.legalName, { branch_code: arch.branch.code, payment_terms: null, day_of_visit: null }),
        row(code.NEWC, w.name('Imported NEWC'), { phone: phones[4] }),
      ]),
    });
    await expect(msg).toHaveText(/^Uploaded — 2 clean · 0 quarantined/);
    b2 = await batchIdOf(msg);
    w.adopt.importBatch(b2);

    const live = await liveCustomerPromotes();
    test.skip(live > 0, `another customer import holds a live promote lease (${live})`);
    await page.goto(`/import/${b2}`);
    const done = seeText(page, '✓ Done — 1 rows promoted in this run · 1 customer(s) failed.');
    await page.getByRole('button', { name: 'Promote 2 clean rows' }).click();
    await done;
    const newc = await db.customer.findUnique({ where: { nmwcCode: code.NEWC }, select: { id: true } });
    if (newc) w.adopt.customer(newc.id);
    expect(newc, 'the clean row loaded').not.toBeNull();

    await page.reload();
    await expect(statValue(page, 'Rejected')).toHaveText('1');
    await expect(page.getByText('1 row(s) were rejected and are not in the master.')).toBeVisible();
    await page.getByRole('link', { name: 'See them with the reason' }).click();
    await landsOrGo(page, /\?show=rejected$/, `/import/${b2}?show=rejected`, 'See them with the reason');
    await expect(batchRow(page, '#2')).toContainText(
      'Not loaded: customer is archived in the CRM, and an import does not bring an archived customer back — exclude the row; steward review'
    );
    // The archived customer is untouched (no live branch, no new name).
    expect(await snapshot(['Customer', 'Branch'], { Customer: { id: arch.id }, Branch: { customerId: arch.id } })).toBe(archBefore);

    const work = await openAs(browser, stw, '/work');
    await expect(workItem(work, b2)).toContainText('Import to review');
    await expect(workItem(work, b2)).toContainText('1 row held back or rejected, not yet fixed or excluded');
    // ALERT_WEBHOOK_URL is empty on this server: importRejectionAlert decides, sendAlert posts nowhere.
  });

  test('customer master: an interrupted promote shows a Resume button and a Work entry, and resumes to the end', async ({ browser }) => {
    test.setTimeout(300_000);
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const msg = await upload(page, 'Customer master', {
      name: `${w.sfx}-customers-3.xlsx`,
      buffer: await customerWorkbook([
        row(code.NEWD, w.name('Imported NEWD'), { phone: phones[5] }),
        row(code.NEWE, w.name('Imported NEWE'), { phone: phones[6] }),
        row(code.NEWF, w.name('Imported NEWF'), { phone: phones[7] }),
      ]),
    });
    await expect(msg).toHaveText(/^Uploaded — 3 clean · 0 quarantined/);
    b3 = await batchIdOf(msg);
    w.adopt.importBatch(b3);
    // A run that stopped: PROMOTING, its lease long expired.
    await db.importBatch.update({
      where: { id: b3 },
      data: { status: 'PROMOTING', promoteLeaseBy: `e2e-expired-${w.sfx}`, promoteLeaseUntil: new Date(Date.now() - 10 * 60_000) },
    });

    await page.goto(`/import/${b3}`);
    await expect(page.getByText('Promote interrupted.')).toBeVisible();
    const resume = page.getByRole('button', { name: 'Resume promote (3 rows left)' });
    await expect(resume).toBeEnabled();
    const work = await openAs(browser, stw, '/work');
    await expect(workItem(work, b3)).toContainText('Import to resume');
    await expect(workItem(work, b3)).toContainText('Promote interrupted — 0 of 3 rows loaded');

    const live = await liveCustomerPromotes();
    test.skip(live > 0, `another customer import holds a live promote lease (${live})`);
    const done = seeText(page, '✓ Done — 3 rows promoted in this run.');
    await resume.click();
    await done;
    await page.reload();
    await expect(pageSubtitle(page)).toHaveText('CUSTOMER import · 3 rows · PROMOTED');
    const loaded = await db.customer.findMany({ where: { importBatchId: b3 }, select: { id: true } });
    loaded.forEach((c) => w.adopt.customer(c.id));
    expect(loaded).toHaveLength(3);
    await work.reload();
    await expect(workItem(work, b3)).toHaveCount(0);
  });

  test('customer master (owner decision 7): a file that closes a customer’s last open shop closes the customer, and one that reopens it makes it ACTIVE again', async ({ browser }) => {
    test.setTimeout(300_000);
    const stc = w.customer('STC');
    const stcRow = (status: 'CLOSED' | 'ACTIVE') =>
      row(stc.code, stc.legalName, {
        branch_code: stc.branch.code,
        branch_name: stc.branch.name,
        address: 'Way 3012, Al Ghubra North, Muscat',
        payment_terms: null,
        day_of_visit: null,
        customer_status: status,
      });
    const page = await openAs(browser, stw, '/import');
    for (const [status, file] of [
      ['CLOSED', `${w.sfx}-customers-close.xlsx`],
      ['ACTIVE', `${w.sfx}-customers-reopen.xlsx`],
    ] as const) {
      await resetStewardLimits(stw);
      const msg = await upload(page, 'Customer master', { name: file, buffer: await customerWorkbook([stcRow(status)]) });
      await expect(msg).toHaveText(/^Uploaded — 1 clean · 0 quarantined/);
      const id = await batchIdOf(msg);
      w.adopt.importBatch(id);
      const live = await liveCustomerPromotes();
      test.skip(live > 0, `another customer import holds a live promote lease (${live})`);
      await page.goto(`/import/${id}`);
      const done = seeText(page, '✓ Done — 1 rows promoted in this run.');
      await page.getByRole('button', { name: 'Promote 1 clean rows' }).click();
      await done;
      const now = await db.customer.findUniqueOrThrow({
        where: { id: stc.id },
        select: { status: true, branches: { select: { status: true } } },
      });
      expect(now, `after the ${status} file`).toEqual({ status, branches: [{ status }] });
    }
    // Each move of the customer is audited on the customer, from the status before the load.
    const close = await auditFor({ entityId: stc.id, action: 'CLOSE' });
    const reopen = await auditFor({ entityId: stc.id, action: 'REACTIVATE' });
    expect(close).toHaveLength(1);
    expect(reopen).toHaveLength(1);
    expect(close[0]!.actorId).toBe(stw.id);
  });

  test('refused files: unreadable, too large, empty, a repeated heading, a fourth upload in a minute — each in red, and no batch', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await openAs(browser, stw, '/import');
    const names: string[] = [];
    const attempt = async (name: string, buffer: Buffer, reset = true) => {
      names.push(name);
      if (reset) await resetStewardLimits(stw);
      const msg = await upload(page, 'Customer master', { name, buffer });
      await expect(msg).toHaveAttribute('role', 'alert');
      await expect(msg).toHaveClass(/text-red-600/);
      return msg;
    };

    await expect(await attempt(`${w.sfx}-not-a-workbook.xlsx`, Buffer.from('this is a text file renamed to .xlsx\n'))).toHaveText(
      /^Could not read \.xlsx: \S/
    );
    await expect(await attempt(`${w.sfx}-six-mb.xlsx`, Buffer.alloc(6 * 1024 * 1024, 0x41))).toHaveText(
      'File is too large (6144 KB). Maximum is 5 MB.'
    );
    await expect(await attempt(`${w.sfx}-headers-only.xlsx`, await customerWorkbook([]))).toHaveText('Workbook is empty.');
    const twice = await xlsxBuffer([
      { name: 'Customers', headers: ['cust_code', 'cust_name', 'phone', 'phone'], rows: [{ cust_code: `E2E${w.SFX}-TWICE`, cust_name: w.name('Twice') }] },
    ]);
    await expect(await attempt(`${w.sfx}-repeated-heading.xlsx`, twice)).toHaveText(
      'Could not read .xlsx: Sheet "Customers": the heading "phone" is in more than one column (C and D). Keep one, or rename the other.'
    );

    // Three uploads spend the per-Steward bucket (3, one back every 20 s; a refused file counts too)
    // and the fourth is told to wait. The bucket is then held at empty, so a slow machine's page
    // loads between the four cannot refill a token and turn this into a timing test.
    await resetStewardLimits(stw);
    for (let i = 1; i <= 3; i++) await attempt(`${w.sfx}-burst-${i}.xlsx`, await customerWorkbook([]), false);
    await drainStewardImports(stw);
    await expect(await attempt(`${w.sfx}-burst-4.xlsx`, await customerWorkbook([]), false)).toHaveText(/^Wait \d+s before another import\.$/);

    // 8.5 MB is over Next's 8 MB server-action body limit: refused before the app's own 5 MB check.
    const big = await attempt(`${w.sfx}-eight-mb.xlsx`, Buffer.alloc(Math.round(8.5 * 1024 * 1024), 0x41));
    const bigText = (await big.textContent()) ?? '';
    test.info().annotations.push({ type: 'recorded', description: `8.5 MB upload answer: ${bigText.slice(0, 200)}` });
    expect(bigText).not.toMatch(/^Uploaded/);

    expect(await db.importBatch.count({ where: { filename: { in: names } } }), 'no batch for a refused file').toBe(0);
    await resetStewardLimits(stw);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2b. Only one customer promote at a time (SV-CUST-IMPORT-RESUME-SINGLE-RUN) —
//     exclusive: the test holds a LIVE promote lease, which stops every other
//     customer promote in the organisation for a minute.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: only one customer promote runs at a time', { tag: ['@exclusive'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  /** The batch refused while the other held the lease. */
  let refusedBatch = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bkx', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('a second batch is refused in words while another holds a live lease, holds no lease and loads nothing', async ({ browser }) => {
    const live = await liveCustomerPromotes();
    test.skip(live > 0, `a real customer import holds a live promote lease (${live})`);
    test.setTimeout(300_000);
    const stw = w.user('STW');
    const [p1, p2] = await w.allocPhones(2);
    const sheet = (k: string, phone: string) =>
      customerWorkbook([
        {
          cust_code: `E2E${w.SFX}-${k}`,
          cust_name: w.name(`Single run ${k}`),
          branch_code: `E2E${w.SFX}-${k}-01`,
          branch_name: w.name(`Single run ${k} shop`),
          sales_region: w.region('R1').code,
          route: w.route('A').code,
          address: ADDRESS,
          phone,
        },
      ]);
    const page = await openAs(browser, stw, '/import');
    const ids: string[] = [];
    const files: string[] = [];
    for (const [k, phone] of [
      ['ONE', p1!],
      ['TWO', p2!],
    ] as const) {
      await resetStewardLimits(stw);
      const name = `${w.sfx}-single-${k}.xlsx`;
      const msg = await upload(page, 'Customer master', { name, buffer: await sheet(k, phone) });
      const id = await batchIdOf(msg);
      w.adopt.importBatch(id);
      ids.push(id);
      files.push(name);
    }
    const [first, second] = ids as [string, string];
    try {
      await db.importBatch.update({
        where: { id: first },
        data: { status: 'PROMOTING', promoteLeaseBy: `e2e-live-${w.sfx}`, promoteLeaseUntil: new Date(Date.now() + 60_000) },
      });
      await page.goto(`/import/${first}`);
      await expect(page.getByText('Another promote is running — wait for it to finish.')).toBeVisible();

      await page.goto(`/import/${second}`);
      await page.getByRole('button', { name: 'Promote 1 clean rows' }).click();
      await expect(
        page.getByText(
          `Another customer import ("${files[0]}") is being promoted right now. Only one may run at a time — wait for it to finish, then resume this one.`
        )
      ).toBeVisible({ timeout: 60_000 });
      refusedBatch = second;
      expect(await db.importBatch.findUniqueOrThrow({ where: { id: second }, select: { promoteLeaseBy: true, promoteLeaseUntil: true } })).toEqual({
        promoteLeaseBy: null,
        promoteLeaseUntil: null,
      });
      expect(await db.customer.count({ where: { importBatchId: second } })).toBe(0);
      expect(await db.importRow.count({ where: { batchId: second, state: 'CLEAN' } })).toBe(1);
    } finally {
      // Hand the lease back at once: it blocks every customer promote in the organisation.
      await db.importBatch.update({ where: { id: first }, data: { status: 'READY', promoteLeaseBy: null, promoteLeaseUntil: null } });
    }
  });

  test('the refused batch is left READY, not looking like an interrupted promote', async ({ browser }) => {
    // APP BUG (found authoring this spec): promoteCustomerBatchCore claims the batch (READY →
    // PROMOTING) BEFORE it checks for another live promote, and on that refusal releases only the
    // lease — so the refused batch stays PROMOTING with no lease: its page shows "Promote
    // interrupted." with a Resume button, and Work lists it under "Import to resume".
    test.fail(true, 'A promote refused for another live promote leaves its batch PROMOTING, shown as interrupted (services/imports.ts otherLive release)');
    test.skip(!refusedBatch, 'needs the refused batch from the test before');
    expect((await db.importBatch.findUniqueOrThrow({ where: { id: refusedBatch }, select: { status: true } })).status).toBe('READY');
    const page = await openAs(browser, w.user('STW'), `/import/${refusedBatch}`);
    await expect(page.getByText('Promote interrupted.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Promote 1 clean rows' })).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Routes and regions (SV-ROUTES-REGIONS, MGR-ROUTES-REGION, owner decision 5)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: routes and regions', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let regionCode = '';
  let regionId = '';
  let routeCode = '';
  let routeId = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bkr', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M2', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
    });
    regionCode = `E2R${w.SFX}N`;
    routeCode = `E2${w.SFX}N`;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  const regionForm = (page: Page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create region' }) });
  const routeForm = (page: Page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create route' }) });
  const routeRow = (page: Page, code: string) => page.locator('tbody tr').filter({ has: page.getByRole('cell', { name: code, exact: true }) });
  const regionHeader = (page: Page, code: string) => page.locator('header').filter({ hasText: code });

  /** Whether /users offers the route in the create form's route list (the Steward's). */
  async function usersOffers(page: Page, id: string): Promise<boolean> {
    await page.goto('/users');
    await page.locator('select[name="role"]').selectOption('SALESMAN');
    return (await page.locator(`select[name="ownedRouteId"] option[value="${id}"]`).count()) === 1;
  }

  /** Whether /export lists the route code. */
  async function exportOffers(page: Page, code: string): Promise<boolean> {
    await page.goto('/export');
    return (await page.locator('label').filter({ has: page.getByText(code, { exact: true }) }).count()) === 1;
  }

  test('the Steward creates a region and a route; a duplicate code and a one-character code are refused', async ({ browser }) => {
    const stw = w.user('STW');
    const page = await openAs(browser, stw, '/routes');

    // A region typed in lower case is stored in upper case, and audited.
    await regionForm(page).locator('input[name="code"]').fill(regionCode.toLowerCase());
    await regionForm(page).locator('input[name="name"]').fill(w.name('Steward Region'));
    await regionForm(page).getByRole('button', { name: 'Create region' }).click();
    await shownOrReload(
      page,
      'Create region',
      (timeout) => expect(page.getByRole('heading', { level: 2, name: new RegExp(regionCode) })).toBeVisible({ timeout }),
      async () => (await db.region.count({ where: { code: regionCode } })) === 1
    );
    const region = await db.region.findUniqueOrThrow({ where: { code: regionCode } });
    regionId = region.id;
    w.adopt.regionId(region.id);
    expect((await auditFor({ entityId: region.id, action: 'CREATE' })).map((a) => [a.entityType, a.actorId])).toEqual([['Region', stw.id]]);

    // A route in it: unassigned, active, audited, offered on /users.
    await routeForm(page).locator('input[name="code"]').fill(routeCode);
    await routeForm(page).locator('input[name="name"]').fill(w.name('Steward Route'));
    await routeForm(page).locator('select[name="regionId"]').selectOption(region.id);
    await routeForm(page).getByRole('button', { name: 'Create route' }).click();
    const r = routeRow(page, routeCode);
    await shownOrReload(
      page,
      'Create route',
      async (timeout) => {
        await expect(r).toContainText('— unassigned —', { timeout });
        await expect(r).toContainText('Active', { timeout });
      },
      async () => (await db.route.count({ where: { code: routeCode } })) === 1
    );
    const route = await db.route.findUniqueOrThrow({ where: { code: routeCode } });
    routeId = route.id;
    w.adopt.routeId(route.id);
    expect(route.regionId).toBe(region.id);
    expect((await auditFor({ entityId: route.id, action: 'CREATE' })).map((a) => a.entityType)).toEqual(['Route']);

    // The same code again: a red conflict and no second row.
    await routeForm(page).locator('input[name="code"]').fill(routeCode);
    await routeForm(page).locator('input[name="name"]').fill(w.name('Steward Route again'));
    await routeForm(page).locator('select[name="regionId"]').selectOption(region.id);
    await routeForm(page).getByRole('button', { name: 'Create route' }).click();
    await expect(routeForm(page).getByText('This value conflicts with an existing record. Refresh and try again.')).toBeVisible();
    expect(await db.route.count({ where: { code: routeCode } })).toBe(1);

    // One character is too short (route codes are 2+).
    await routeForm(page).locator('input[name="code"]').fill('Y');
    await routeForm(page).locator('input[name="name"]').fill(w.name('One letter'));
    await routeForm(page).locator('select[name="regionId"]').selectOption(region.id);
    await routeForm(page).getByRole('button', { name: 'Create route' }).click();
    await expect(routeForm(page).getByText('String must contain at least 2 character(s)')).toBeVisible();

    const users = await openAs(browser, stw, '/users');
    expect(await usersOffers(users, route.id), '/users offers the new route').toBe(true);
  });

  test('the Steward disables a route (gone from Users and Export, audited) and enables it again', async ({ browser }) => {
    test.skip(!routeId, 'needs the route from the test before');
    const stw = w.user('STW');
    const page = await openAs(browser, stw, '/routes');
    const other = await openAs(browser, stw, '/users');

    const routeActive = async () => (await db.route.findUniqueOrThrow({ where: { id: routeId } })).isActive;
    await routeRow(page, routeCode).getByRole('button', { name: 'Disable' }).click();
    await shownOrReload(
      page,
      'Disable route',
      (timeout) => expect(routeRow(page, routeCode)).toContainText('Disabled', { timeout }),
      async () => !(await routeActive())
    );
    expect(await routeActive()).toBe(false);
    expect((await auditFor({ entityId: routeId, action: 'UPDATE' })).map((a) => a.reason)).toEqual(['disabled']);
    expect(await usersOffers(other, routeId), '/users stops offering a switched-off route').toBe(false);
    expect(await exportOffers(other, routeCode), '/export stops listing a switched-off route').toBe(false);

    await page.reload();
    await routeRow(page, routeCode).getByRole('button', { name: 'Enable' }).click();
    await shownOrReload(
      page,
      'Enable route',
      (timeout) => expect(routeRow(page, routeCode)).toContainText('Active', { timeout }),
      routeActive
    );
    expect((await auditFor({ entityId: routeId, action: 'UPDATE' })).map((a) => a.reason)).toEqual(['disabled', 'enabled']);
    expect(await usersOffers(other, routeId)).toBe(true);
    expect(await exportOffers(other, routeCode)).toBe(true);
  });

  test('owner decision 5: the Steward switches a region off and on', async ({ browser }) => {
    test.skip(!regionId, 'needs the region from the first test');
    const page = await openAs(browser, w.user('STW'), '/routes');
    const regionActive = async () => (await db.region.findUniqueOrThrow({ where: { id: regionId } })).isActive;
    await regionHeader(page, regionCode).getByRole('button', { name: 'Disable' }).click();
    await shownOrReload(
      page,
      'Disable region',
      (timeout) => expect(regionHeader(page, regionCode).getByRole('button', { name: 'Enable' })).toBeVisible({ timeout }),
      async () => !(await regionActive())
    );
    expect(await regionActive()).toBe(false);
    await regionHeader(page, regionCode).getByRole('button', { name: 'Enable' }).click();
    await shownOrReload(
      page,
      'Enable region',
      (timeout) => expect(regionHeader(page, regionCode).getByRole('button', { name: 'Disable' })).toBeVisible({ timeout }),
      regionActive
    );
    expect(await regionActive()).toBe(true);
    expect((await auditFor({ entityId: regionId, action: 'UPDATE' })).map((a) => a.reason)).toEqual(['disabled', 'enabled']);
  });

  test('a Manager sees only his regions, creates no region, and switches no region; in a shared region he switches no route either', async ({ browser }) => {
    const R1 = w.region('R1');
    const R2 = w.region('R2');
    const page = await openAs(browser, w.user('M1'), '/routes');
    await expect(pageSubtitle(page)).toHaveText('1 region you manage');
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(R1.code) })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(R2.code) })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'New region' })).toHaveCount(0);
    const options = await routeForm(page).locator('select[name="regionId"] option').allTextContents();
    expect(options).toEqual(['— Pick a region —', `${R1.code} · ${R1.name}`]);
    // Owner decision 5: no region switch for a Manager; R1 is shared with M2, so no route switch either.
    await expect(regionHeader(page, R1.code).getByRole('button')).toHaveCount(0);
    await expect(page.getByText('Only the Data Steward switches a region off or on, and a route in a region you share with another Manager. Ask the Steward.')).toBeVisible();
    await expect(routeRow(page, w.route('A').code).getByRole('button')).toHaveCount(0);
  });

  test('server side: a Manager is refused another region’s route, a shared region’s route and any region switch; the sole Manager of a region switches its route', async ({ browser }) => {
    test.setTimeout(240_000);
    const A = w.route('A');
    const B = w.route('B');
    const R2 = w.region('R2');

    // Capture M5's route switch on B (aborted in the browser: it never runs).
    const m5Page = await openAs(browser, w.user('M5'), '/routes');
    const toggleB = await captureServerAction(m5Page, () => routeRow(m5Page, B.code).getByRole('button', { name: 'Disable' }).click());
    await m5Page.close();
    const m1 = await contextAs(browser, w.user('M1'));

    // M1 does not manage R2.
    const outOfScope = await replayServerAction(m1.request, toggleB);
    expect(outOfScope, outOfScope.text.slice(0, 300)).toMatchObject({ refused: true, message: 'That region is not one you manage.' });
    // The same action on route A: R1 has two active Managers, so only the Steward may.
    const shared = await replayServerAction(m1.request, toggleB, {
      mutateBody: (b) => Buffer.from(b.toString('latin1').split(B.id).join(A.id), 'latin1'),
    });
    expect(shared, shared.text.slice(0, 300)).toMatchObject({
      refused: true,
      message: 'Other Managers share this route’s region, so only the Data Steward can switch the route off or on.',
    });
    expect(await db.route.findMany({ where: { id: { in: [A.id, B.id] } }, select: { isActive: true } })).toEqual([
      { isActive: true },
      { isActive: true },
    ]);

    // A region switch, captured from the Steward's page, replayed by a Manager: refused.
    const stwPage = await openAs(browser, w.user('STW'), '/routes');
    const toggleR2 = await captureServerAction(stwPage, () => regionHeader(stwPage, R2.code).getByRole('button', { name: 'Disable' }).click());
    await stwPage.close();
    const m5 = await contextAs(browser, w.user('M5'));
    const region = await replayServerAction(m5.request, toggleR2);
    expect(region, region.text.slice(0, 300)).toMatchObject({ refused: true, message: 'Only the Data Steward can switch a region off or on.' });
    expect((await db.region.findUniqueOrThrow({ where: { id: R2.id } })).isActive).toBe(true);

    // M5 manages R2 alone: he switches route B off and on through the page.
    const bActive = async () => (await db.route.findUniqueOrThrow({ where: { id: B.id } })).isActive;
    const page = await openAs(browser, w.user('M5'), '/routes');
    await routeRow(page, B.code).getByRole('button', { name: 'Disable' }).click();
    await shownOrReload(
      page,
      'Manager disables route B',
      (timeout) => expect(routeRow(page, B.code)).toContainText('Disabled', { timeout }),
      async () => !(await bActive())
    );
    await page.reload();
    await routeRow(page, B.code).getByRole('button', { name: 'Enable' }).click();
    await shownOrReload(
      page,
      'Manager enables route B',
      (timeout) => expect(routeRow(page, B.code)).toContainText('Active', { timeout }),
      bActive
    );
    const audit = await auditFor({ entityId: B.id, action: 'UPDATE' });
    expect(audit.map((a) => [a.reason, a.actorId])).toEqual([
      ['disabled', w.user('M5').id],
      ['enabled', w.user('M5').id],
    ]);
  });

  // Last in this serial describe: an unexpected pass would skip nothing after it.
  test('a Steward action’s result shows in place, without a reload: route A2 switched off and on three times', async ({ browser }) => {
    // APP BUG (NAV_HANG, open in this build; fix in progress on claude/fix-nav-hang): the
    // revalidated answer of the Disable / Enable action is often parked by React — the row keeps
    // its old status and the button stays disabled until a reload. Six switches make it certain.
    test.fail(true, NAV_HANG);
    test.setTimeout(240_000);
    const A2 = w.route('A2');
    const page = await openAs(browser, w.user('STW'), '/routes');
    for (let i = 1; i <= 3; i++) {
      for (const [button, shows] of [
        ['Disable', 'Disabled'],
        ['Enable', 'Active'],
      ] as const) {
        await routeRow(page, A2.code).getByRole('button', { name: button }).click();
        await expect(routeRow(page, A2.code), `switch ${i}: ${button} shows ${shows} in place`).toContainText(shows, { timeout: IN_PLACE_MS });
        await expect(routeRow(page, A2.code).getByRole('button')).toBeEnabled({ timeout: IN_PLACE_MS });
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Temix (SV-TEMIX-GENERATE-DOWNLOAD-MARK, SV-TEMIX-INBOUND-REFRESH,
//    SV-TEMIX-ERRORS-AND-HELD-BACK) — exclusive: Generate takes the WHOLE queue.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: Temix upload batches', { tag: ['@exclusive'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World | undefined;
  /** Real UAT rows already queued for Temix: Generate would take them, so the describe skips. */
  let queuedBefore = 0;
  let batch1 = '';
  let marked = false;
  let refreshed = false;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    queuedBefore = await db.customer.count({ where: TEMIX_QUEUE_WHERE });
    if (queuedBefore > 0) return;
    const world = await createWorld('bkt', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
    });
    w = world;
    await world.addCustomer({ key: 'A', phone: true, contact: 'Ali Al Abri', branches: [{ key: 'S', route: 'A' }] });
    await world.addCustomer({ key: 'B', phone: true, archived: true, temixSyncState: 'DEACTIVATE_PENDING', branches: [{ key: 'S', route: 'A' }] });
    // C: created by the CASH chain (its salesman), sent in an earlier batch, no Temix code yet.
    await world.addCustomer({ key: 'C', phone: true, temixCode: null, temixSyncState: 'UPLOADED', branches: [{ key: 'S', route: 'A' }] });
    await db.customer.update({ where: { id: world.customer('C').id }, data: { createdById: world.user('SA').id } });
    // A: linked to Temix as T<SFX>, re-queued by an approved correction.
    await db.customer.update({
      where: { id: world.customer('A').id },
      data: { temixCode: `T${world.SFX}`, temixSyncState: 'PENDING_UPLOAD', temixSyncPendingSince: new Date() },
    });
  });

  test.beforeEach(() => {
    test.skip(
      queuedBefore > 0,
      `${queuedBefore} real customer(s) are already queued for Temix on this database: Generate would take them. Run this on a Neon branch of UAT.`
    );
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  const batchRowOf = (page: Page, id: string) => page.locator('tbody tr').filter({ hasText: `…${id.slice(-6)}` });

  test('Generate snapshots the queue into a batch and a workbook; Download repeats it; Mark loaded settles the deactivations', async ({ browser }) => {
    test.setTimeout(300_000);
    const world = w!;
    const stw = world.user('STW');
    const A = world.customer('A');
    const B = world.customer('B');
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/temix');
    await expect(temixTile(page, 'Pending upload')).toHaveText('1');
    await expect(temixTile(page, 'Pending deactivation')).toHaveText('1');
    const uploadedBefore = Number(await temixTile(page, 'Uploaded — awaiting Temix').textContent());

    await page.getByRole('button', { name: /Generate upload file/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Generate Temix upload batch?');
    const dl = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Generate & download' }).click();
    const file = await readDownload(await dl);
    const made = await db.temixSyncBatch.findFirstOrThrow({ where: { createdById: stw.id }, orderBy: { createdAt: 'desc' } });
    batch1 = made.id;
    world.adopt.temixBatch(made.id);

    expect(file.name).toBe(`temix-upload-${omanDateISO()}-${made.id.slice(-6)}.xlsx`);
    const sheet = file.sheets.find((s) => s.name === 'Temix Upload');
    expect(sheet, 'sheet "Temix Upload"').toBeTruthy();
    const mine = sheet!.rows.filter((r) => [A.code, B.code].includes(r.cust_code!));
    expect(mine).toHaveLength(2);
    const up = mine.find((r) => r.cust_code === A.code)!;
    const de = mine.find((r) => r.cust_code === B.code)!;
    expect(up).toMatchObject({ sync_action: 'UPSERT', temix_code: `T${world.SFX}`, branch_code: A.branch.code, sync_batch_id: made.id });
    expect(de).toMatchObject({ sync_action: 'DEACTIVATE', sync_batch_id: made.id });
    expect(sheet!.rows).toHaveLength(2);

    const r = batchRowOf(page, made.id);
    await shownOrReload(page, 'Generate upload file', async (timeout) => {
      await expect(temixTile(page, 'Pending upload')).toHaveText('0', { timeout });
      await expect(temixTile(page, 'Pending deactivation')).toHaveText('0', { timeout });
      await expect(temixTile(page, 'Uploaded — awaiting Temix')).toHaveText(String(uploadedBefore + 2), { timeout });
      await expect(r).toContainText('awaiting confirm', { timeout });
    });
    await expect(r.locator('td').nth(2)).toHaveText('2');
    const states = await db.customer.findMany({
      where: { id: { in: [A.id, B.id] } },
      select: { id: true, temixSyncState: true, lastTemixUploadBatchId: true },
    });
    for (const s of states) expect(s).toMatchObject({ temixSyncState: 'UPLOADED', lastTemixUploadBatchId: made.id });
    expect((await auditFor({ entityId: made.id, action: 'EXPORT' })).map((a) => a.entityType)).toEqual(['TemixSyncBatch']);

    // Download again: the same rows, and its own ledger row.
    const again = page.waitForEvent('download');
    await r.getByRole('button', { name: 'Download' }).click();
    const second = await readDownload(await again);
    expect(second.sheets.find((s) => s.name === 'Temix Upload')!.rows.map((x) => `${x.sync_action}:${x.cust_code}`).sort()).toEqual(
      [`DEACTIVATE:${B.code}`, `UPSERT:${A.code}`].sort()
    );
    await expect.poll(async () => (await auditFor({ entityId: made.id, action: 'EXPORT' })).map((a) => a.reason)).toContain(
      'redownload 2 rows / 2 customers'
    );

    // Mark loaded, with a second tab still showing the button.
    const stale = await openAs(browser, stw, '/temix');
    await r.getByRole('button', { name: 'Mark loaded' }).click();
    await expect(page.getByRole('dialog')).toContainText('Confirm this batch is loaded into Temix?');
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, it is loaded' }).click();
    await shownOrReload(
      page,
      'Mark loaded',
      async (timeout) => {
        await expect(r).toContainText(`✓ ${omanDate(new Date())}`, { timeout });
        await expect(r.getByRole('button', { name: 'Mark loaded' })).toHaveCount(0, { timeout });
      },
      async () => (await db.temixSyncBatch.findUniqueOrThrow({ where: { id: made.id } })).markedLoadedAt !== null
    );
    marked = true;
    expect((await db.customer.findUniqueOrThrow({ where: { id: B.id } })).temixSyncState).toBe('SYNCED');
    expect((await db.customer.findUniqueOrThrow({ where: { id: A.id } })).temixSyncState).toBe('UPLOADED');
    const confirm = (await auditFor({ entityId: made.id, action: 'UPDATE' })).at(-1);
    expect((confirm?.after as { deactivationsSettled?: number } | null)?.deactivationsSettled).toBe(1);

    // Launch fix (wave 1): the refusal says what happened, not "Validation failed".
    const staleRow = batchRowOf(stale, made.id);
    await staleRow.getByRole('button', { name: 'Mark loaded' }).click();
    await stale.getByRole('dialog').getByRole('button', { name: 'Yes, it is loaded' }).click();
    await expect(staleRow).toContainText('This batch is already marked as loaded.');
  });

  test('the inbound Temix refresh settles an uploaded customer that carries its code, and changes none of its branches', async ({ browser }) => {
    test.skip(!marked, 'needs the batch from the test before');
    test.setTimeout(300_000);
    const world = w!;
    const stw = world.user('STW');
    const A = world.customer('A');
    const C = world.customer('C');
    const branchesBefore = await snapshot(['Branch'], { Branch: { customerId: { in: [A.id, C.id] } } });
    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/import');
    const msg = await upload(page, 'Customer master', {
      name: `${world.sfx}-temix-refresh.xlsx`,
      buffer: await customerWorkbook(
        [
          { cust_code: A.code, cust_name: A.legalName, temix_code: `T${world.SFX}` },
          { cust_code: C.code, cust_name: C.legalName, temix_code: `TC${world.SFX}` },
        ],
        ['cust_code', 'cust_name', 'temix_code']
      ),
    });
    await expect(msg).toHaveText(/^Uploaded — 2 clean · 0 quarantined/);
    const id = await batchIdOf(msg);
    world.adopt.importBatch(id);
    await page.goto(`/import/${id}`);
    const done = seeText(page, /✓ Done — \d+ rows promoted in this run/);
    await page.getByRole('button', { name: 'Promote 2 clean rows' }).click();
    await done;
    refreshed = true;

    expect(await db.customer.findUniqueOrThrow({ where: { id: A.id }, select: { temixSyncState: true, temixCode: true } })).toEqual({
      temixSyncState: 'SYNCED',
      temixCode: `T${world.SFX}`,
    });
    expect(await snapshot(['Branch'], { Branch: { customerId: { in: [A.id, C.id] } } }), 'no branch changed').toBe(branchesBefore);
  });

  test('the inbound refresh back-fills the Temix code of a chain-created customer and tells its salesman', async () => {
    // APP BUG (found authoring this spec): the refresh lane needs a Temix code ALREADY on record
    // (services/imports.ts isRefresh requires existing.temixCode), so a customer created by the
    // approval chain — which has none until Temix answers — never gets its code: the row takes the
    // full lane (rejected without a branch_code) and TEMIX_SYNC_ACKED is unreachable code.
    test.fail(true, 'Inbound refresh never records the Temix code of a customer that has none (services/imports.ts isRefresh)');
    test.skip(!refreshed, 'needs the refresh upload from the test before');
    const world = w!;
    const C = world.customer('C');
    expect(await db.customer.findUniqueOrThrow({ where: { id: C.id }, select: { temixSyncState: true, temixCode: true } })).toEqual({
      temixSyncState: 'SYNCED',
      temixCode: `TC${world.SFX}`,
    });
    const acked = (await notificationsFor({ userId: world.user('SA').id })).filter((n) => n.kind === 'TEMIX_SYNC_ACKED');
    expect(acked.map((n) => n.title)).toEqual(['Customer landed in Temix']);
  });

  test('refusals in words: a held-back deactivation alone is not sent; with other rows the file goes out without it; a fourth download in a minute waits', async ({ browser }) => {
    test.skip(!batch1, 'needs the batch from the first test');
    test.setTimeout(300_000);
    const world = w!;
    const stw = world.user('STW');
    // D: archived, never coded — its deactivation goes out under its customer code, which live E holds.
    const D = await world.addCustomer({ key: 'D', phone: true, archived: true, temixCode: null, temixSyncState: 'DEACTIVATE_PENDING', branches: [{ key: 'S', route: 'A' }] });
    await world.addCustomer({ key: 'E', phone: true, temixCode: D.code, branches: [{ key: 'S', route: 'A' }] });
    const otherQueued = await db.customer.count({ where: { AND: [TEMIX_QUEUE_WHERE, { id: { not: D.id } }] } });
    test.skip(otherQueued > 0, `${otherQueued} other customer(s) joined the Temix queue meanwhile`);
    const batches = () => db.temixSyncBatch.count({ where: { createdById: stw.id } });
    const before = await batches();

    await resetStewardLimits(stw);
    const page = await openAs(browser, stw, '/temix');
    await page.getByRole('button', { name: /Generate upload file/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Generate & download' }).click();
    await expect(page.getByText(`Nothing can go to Temix yet. Held back for review: ${D.code}.`)).toBeVisible({ timeout: 60_000 });
    expect(await batches()).toBe(before);
    expect((await db.customer.findUniqueOrThrow({ where: { id: D.id } })).temixSyncState).toBe('DEACTIVATE_PENDING');

    // With another customer queued, the file goes out and names what it left behind.
    const F = await world.addCustomer({ key: 'F', phone: true, temixSyncState: 'PENDING_UPLOAD', branches: [{ key: 'S', route: 'A' }] });
    await page.reload();
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /Generate upload file/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Generate & download' }).click();
    const file = await readDownload(await dl);
    const made = await db.temixSyncBatch.findFirstOrThrow({ where: { createdById: stw.id }, orderBy: { createdAt: 'desc' } });
    world.adopt.temixBatch(made.id);
    expect(file.sheets[0]!.rows.map((r) => r.cust_code)).toEqual([F.code]);
    await expect(page.getByText(`Not in this file, still queued: ${D.code}.`, { exact: false })).toBeVisible();
    expect((await db.customer.findUniqueOrThrow({ where: { id: D.id } })).temixSyncState).toBe('DEACTIVATE_PENDING');

    // Downloads: three a minute, then the fourth waits.
    await resetStewardLimits(stw);
    await page.reload();
    const row = batchRowOf(page, made.id);
    for (let i = 0; i < 3; i++) {
      const d = page.waitForEvent('download');
      await row.getByRole('button', { name: 'Download' }).click();
      await d;
      await expect(row.getByRole('button', { name: 'Download' })).toBeEnabled();
    }
    await row.getByRole('button', { name: 'Download' }).click();
    await expect(row).toContainText(/Wait \d+s before downloading again\./);
    await resetStewardLimits(stw);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Exports (SV-EXPORT-STEWARD, SV-VIEWER-EXPORT, XLSX-DOWNLOADS, XLSX-ERROR-UX)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: Excel exports', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let newContact = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bke', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'VW', role: 'VIEWER' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
      customers: [
        {
          key: 'EX1',
          phone: true,
          contact: 'Old Contact',
          crNumber: true,
          crPhoto: true,
          branches: [{ key: 'S', route: 'A', gps: MUSCAT, photos: ['SHOP', 'SIGNBOARD'] }],
        },
        { key: 'EX2', phone: true, contact: 'Badr Al Hinai', branches: [{ key: 'S', route: 'A' }] },
        { key: 'EXB', phone: true, contact: 'Bilal Al Rashdi', branches: [{ key: 'S', route: 'B' }] },
      ],
    });
    // A field change approved today on EX1, as the decision page leaves it: the edit APPROVED and applied.
    newContact = w.name('New Contact');
    const { id } = await seedUpdateEdit(w, { customer: 'EX1', submitter: 'SA', patch: { customer: { contactPerson: newContact } } });
    await db.customerEdit.update({
      where: { id },
      data: { state: 'APPROVED', pendingRole: null, reviewedById: w.user('M1').id, reviewedAt: new Date(), slaDueAt: null },
    });
    await db.customer.update({ where: { id: w.customer('EX1').id }, data: { contactPerson: newContact } });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  const regionBox = (page: Page) => page.getByRole('checkbox', { name: w.region('R1').name, exact: true });

  test('the Steward downloads the master for a region: one row per branch, names not ids, photos as yes/blank, audited', async ({ browser }) => {
    // APP BUG (STREAMED_EXPORT_BUG, blocker, open in this build — fixed on claude/launch-candidate by
    // 81c936e): /api/exports/customers answers 500, so the page says "The export failed on the server".
    test.fail(true, STREAMED_EXPORT_BUG);
    test.setTimeout(240_000);
    const stw = w.user('STW');
    const page = await openAs(browser, stw, '/export');
    await regionBox(page).check();
    const t0 = Date.now();
    const file = await downloadOrRefusal(page, () => page.getByRole('button', { name: 'Download .xlsx' }).click());
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'timing', description: `region master export: ${ms} ms` });
    expect(ms, 'inside the 60 s function budget').toBeLessThan(60_000);

    expect(file.name).toBe(`nmwc-customer-master-${omanDateISO()}.xlsx`);
    const sheet = file.sheets[0]!;
    expect(sheet.name).toBe('Customer Master');
    const live = await db.branch.findMany({
      where: { deletedAt: null, regionId: w.region('R1').id, customer: { deletedAt: null } },
      include: { region: true, customer: { include: { channel: true } } },
      orderBy: { branchCode: 'asc' },
    });
    expect(sheet.rows.map((r) => r.branch_code).sort()).toEqual(live.map((b) => b.branchCode).sort());
    for (const b of live) {
      const r = sheet.rows.find((x) => x.branch_code === b.branchCode)!;
      expect(r).toMatchObject({
        cust_code: b.customer.nmwcCode,
        sales_region: b.region.name,
        region_code: b.region.code,
        channel: b.customer.channel?.label ?? '',
        shop_photo: b.shopPhotoId ? 'yes' : '',
        signboard_photo: b.signboardPhotoId ? 'yes' : '',
        cr_photo: b.customer.crPhotoId ? 'yes' : '',
      });
    }
    expect(sheet.rows.map((r) => r.cust_code)).not.toContain(w.customer('EXB').code);
    if (hasR2) expect(sheet.rows.find((r) => r.cust_code === w.customer('EX1').code)!.shop_photo).toBe('yes');
    const audit = (await auditFor({ actorId: stw.id, action: 'EXPORT' })).filter((a) => a.entityType === 'Export');
    expect(audit.map((a) => [a.entityId, a.reason])).toContainEqual([omanDateISO(), `customers ${live.length}`]);
  });

  test('the Steward downloads the field-update report: the approved change is highlighted, with every sheet and the count headers', async ({ browser }) => {
    // APP BUG (STREAMED_EXPORT_BUG, open in this build — fixed on claude/launch-candidate by 81c936e):
    // /api/exports/changes answers 500 ("b is not a constructor").
    test.fail(true, STREAMED_EXPORT_BUG);
    test.setTimeout(240_000);
    const stw = w.user('STW');
    const page = await openAs(browser, stw, '/export');
    await regionBox(page).check();
    await page.getByRole('checkbox', { name: 'Only customers with changes' }).check();
    await expect(page.locator('#changes-until')).toHaveValue(omanDateISO());
    const resp = page.waitForResponse((r) => r.url().includes('/api/exports/changes'));
    const file = await downloadOrRefusal(page, () => page.getByRole('button', { name: 'Download field-update report' }).click());
    const headers = (await resp).headers();
    expect(file.name).toBe(`nmwc-field-updates-${omanDateISO()}.xlsx`);
    expect(file.sheets.map((s) => s.name)).toEqual(['Customers', 'Changes', 'By salesman', 'Legend']);
    expect(headers['x-row-count']).toBe('1');
    expect(headers['x-changed-rows']).toBe('1');
    const customers = file.sheets[0]!;
    const i = customers.rows.findIndex((r) => r.cust_code === w.customer('EX1').code);
    expect(i, 'EX1 is in the report').toBeGreaterThanOrEqual(0);
    expect(customers.rows[i]!.contact_person).toBe(newContact);
    expect(customers.fill(i, 'contact_person'), 'the changed cell is yellow').toBe('FFFFFF00');
    expect(file.sheets[1]!.rows.some((r) => Object.values(r).includes(newContact))).toBe(true);
    const audit = (await auditFor({ actorId: stw.id, action: 'EXPORT' })).filter((a) => a.entityId === `field-updates-${omanDateISO()}`);
    expect(audit.length).toBeGreaterThan(0);
  });

  test('a Manager exports the filtered customer list — his region only — on a desktop and on a phone', async ({ browser }) => {
    test.setTimeout(240_000);
    const m1 = w.user('M1');
    for (const [device, path] of [
      ['desktop', `/customers?region=${w.region('R1').id}`],
      ['phone', '/customers'],
    ] as const) {
      const page = await openAs(browser, m1, path, device);
      const dl = page.waitForEvent('download', { timeout: 60_000 });
      await page.getByRole('button', { name: 'Export filtered' }).click();
      const file = await readDownload(await dl);
      expect(file.name, device).toBe(`customers-${omanDateISO()}.xlsx`);
      const sheet = file.sheets[0]!;
      expect(sheet.name).toBe('Customers');
      const codes = sheet.rows.map((r) => r['NMWC code']);
      expect(codes, device).toEqual(expect.arrayContaining([w.customer('EX1').code, w.customer('EX2').code]));
      expect(codes, `${device}: never another region`).not.toContain(w.customer('EXB').code);
      for (const r of sheet.rows) expect(r.Region, device).toBe(w.region('R1').name);
    }
    const audit = (await auditFor({ actorId: m1.id, action: 'EXPORT' })).filter((a) => a.entityId === `customers-${omanDateISO()}`);
    expect(audit).toHaveLength(2);
  });

  test('the Viewer has Export in his menu and exports the filtered /customers list of a region, audited', async ({ browser }) => {
    test.setTimeout(240_000);
    const vw = w.user('VW');
    const page = await openAs(browser, vw, `/customers?region=${w.region('R1').id}`);
    // Launch fix (wave 1): Export is in the Viewer's menu.
    await expect(page.locator('a[href="/export"]').first()).toBeAttached();
    const dl1 = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export filtered' }).click();
    const list = await readDownload(await dl1);
    expect(list.name).toBe(`customers-${omanDateISO()}.xlsx`);
    const codes = list.sheets[0]!.rows.map((r) => r['NMWC code']);
    expect(codes).toEqual(expect.arrayContaining([w.customer('EX1').code, w.customer('EX2').code]));
    expect(codes).not.toContain(w.customer('EXB').code);
    const audit = (await auditFor({ actorId: vw.id, action: 'EXPORT' })).map((a) => a.entityId);
    expect(audit).toContain(`customers-${omanDateISO()}`);

    await page.goto('/export');
    await expect(page.getByRole('heading', { level: 1, name: 'Export to Excel' })).toBeVisible();
  });

  test('the Viewer downloads the master and the field-update report from /export, every download audited', async ({ browser }) => {
    // APP BUG (STREAMED_EXPORT_BUG, open in this build — fixed on claude/launch-candidate by 81c936e).
    test.fail(true, STREAMED_EXPORT_BUG);
    test.setTimeout(240_000);
    const vw = w.user('VW');
    const page = await openAs(browser, vw, '/export');
    await regionBox(page).check();
    const master = await downloadOrRefusal(page, () => page.getByRole('button', { name: 'Download .xlsx' }).click());
    expect(master.sheets[0]!.rows.map((r) => r.cust_code)).toEqual(expect.arrayContaining([w.customer('EX1').code]));
    expect(master.sheets[0]!.rows.map((r) => r.cust_code)).not.toContain(w.customer('EXB').code);

    const report = await fetchAs(page, `/api/exports/changes?regionId=${w.region('R1').id}&onlyChanged=1`);
    expect(report.status).toBe(200);
    expect(report.headers['x-row-count']).toMatch(/^\d+$/);
    const audit = (await auditFor({ actorId: vw.id, action: 'EXPORT' })).map((a) => a.entityId);
    expect(audit).toEqual(expect.arrayContaining([omanDateISO(), `field-updates-${omanDateISO()}`]));
  });

  test('refusals: a salesman gets 403, a signed-out caller 401, and a refused download keeps the user on /export with words', async ({ browser }) => {
    const sa = await openAs(browser, w.user('SA'), '/today');
    expect((await fetchAs(sa, '/api/exports/customers')).status).toBe(403);
    const anon = await pwRequest.newContext({ baseURL: BASE_URL });
    expect((await anon.get('/api/exports/changes')).status()).toBe(401);
    await anon.dispose();

    // Launch fix (wave 1): the download is fetched, so a refusal is shown on the page, not as raw JSON.
    const ctx = await contextAs(browser, w.user('VW'));
    const page = await ctx.newPage();
    await page.goto('/export');
    await expect(page.getByRole('button', { name: 'Download .xlsx' })).toBeEnabled();
    // The session ends while the page is open. Every answer re-issues the session cookie
    // (Auth.js), so the page's own link prefetches must be over before it is cleared, or a
    // late one sets it again and the download goes out signed in.
    await page.waitForLoadState('networkidle');
    await ctx.clearCookies();
    expect(await ctx.cookies(), 'signed out before the download').toEqual([]);
    await page.getByRole('button', { name: 'Download .xlsx' }).click();
    await expect(page.locator('form p[role="alert"]')).toHaveText('Your session has ended. Sign in again, then download.');
    await expect(page).toHaveURL(/\/export$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Export to Excel' })).toBeVisible();
  });

  test('a /customers export over 5,000 rows asks for narrower filters', async ({ browser }) => {
    const live = await db.customer.count({ where: { deletedAt: null } });
    test.skip(live <= 5000, `UAT holds ${live} live customers: no filter matches more than 5,000`);
    const page = await openAs(browser, w.user('STW'), '/customers');
    await page.getByRole('button', { name: 'Export filtered' }).click();
    await expect(page.locator('span[role="alert"]').filter({ hasText: /^Result is \d+ rows/ })).toHaveText(
      /^Result is \d+ rows\. Narrow filters to 5000 or fewer before exporting\.$/
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Duplicates (SV-DUPLICATES-MERGE-DISMISS, owner decision 7 on a merge)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: duplicate review', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let yEdit = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bku', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
      ],
    });
    const cr = (n: number) => `CR${w.SFX}D${n}`;
    // Created in this order, so X's code sorts before Y's (X is the left side of its pair).
    await w.addCustomer({ key: 'X', phone: true, contact: 'Xalid Al Abri', crNumber: cr(1), branches: [{ key: 'S', route: 'A', status: 'CLOSED' }] });
    await w.addCustomer({ key: 'Y', phone: true, contact: 'Yaqoob Al Abri', crNumber: cr(1), crPhoto: true, branches: [{ key: 'S', route: 'A' }] });
    await w.addCustomer({ key: 'P', phone: true, crNumber: cr(2), branches: [{ key: 'S', route: 'A' }] });
    await w.addCustomer({ key: 'Q', phone: true, crNumber: cr(2), branches: [{ key: 'S', route: 'A' }] });
    await w.addCustomer({ key: 'U', phone: true, crNumber: cr(3), branches: [{ key: 'S', route: 'A' }] });
    await w.addCustomer({ key: 'V', phone: true, crNumber: cr(3), branches: [{ key: 'S', route: 'B' }] });
    // X has only a closed shop: owner decision 7 makes such a customer CLOSED.
    await db.customer.update({ where: { id: w.customer('X').id }, data: { status: 'CLOSED' } });
    // An open request on Y, which the merge closes.
    yEdit = (await seedUpdateEdit(w, { customer: 'Y', submitter: 'SA', patch: { customer: { contactPerson: w.name('Pending contact') } } })).id;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  /** A suspected pair on the list (it has Mark distinct; a marked-distinct row has Undo). */
  const pair = (page: Page, a: string, b: string) =>
    page.locator('li').filter({ hasText: w.customer(a).legalName }).filter({ hasText: w.customer(b).legalName }).filter({
      has: page.getByRole('button', { name: 'Mark distinct' }),
    });
  const keepLeft = (k: string) => `Keep ← ${w.customer(k).legalName.slice(0, 24)}`;

  test('the pairs sharing a CR number are listed as CR-number matches', async ({ browser }) => {
    const page = await openAs(browser, w.user('STW'), '/duplicates');
    for (const [a, b] of [
      ['X', 'Y'],
      ['P', 'Q'],
      ['U', 'V'],
    ] as const) {
      await expect(pair(page, a, b), `${a}/${b}`).toHaveCount(1);
      await expect(pair(page, a, b)).toContainText('CR-number match');
    }
  });

  test('Mark distinct hides a pair under "Marked distinct" with the Oman date and the Steward; Undo brings it back', async ({ browser }) => {
    const stw = w.user('STW');
    const P = w.customer('P');
    const Q = w.customer('Q');
    const page = await openAs(browser, stw, '/duplicates');
    const pairAudit = () =>
      db.auditLog.findMany({
        where: { entityType: 'CustomerPair', AND: [{ entityId: { contains: P.id } }, { entityId: { contains: Q.id } }] },
        orderBy: { at: 'asc' },
      });
    const marked = seeText(page, 'Marked as distinct.');
    await pair(page, 'P', 'Q').getByRole('button', { name: 'Mark distinct' }).click();
    await marked;
    await shownOrReload(
      page,
      'Mark distinct',
      (timeout) => expect(pair(page, 'P', 'Q')).toHaveCount(0, { timeout }),
      async () => (await pairAudit()).length === 1
    );
    await page.reload();
    await page.locator('summary', { hasText: /^Marked distinct \(\d+\)$/ }).click();
    const row = page.locator('li').filter({ hasText: P.legalName }).filter({ hasText: Q.legalName }).filter({ has: page.getByRole('button', { name: 'Undo' }) });
    await expect(row).toContainText(`Marked distinct ${omanDateISO()} by ${stw.fullName}`);
    expect((await pairAudit()).map((a) => a.reason)).toEqual(['Deemed distinct by steward']);

    const back = seeText(page, 'Back on the list.');
    await row.getByRole('button', { name: 'Undo' }).click();
    await back;
    await page.reload();
    await expect(pair(page, 'P', 'Q')).toHaveCount(1);
    expect((await pairAudit()).map((a) => a.reason)).toEqual([
      'Deemed distinct by steward',
      'Steward undid "Mark distinct": the pair is a suspected duplicate again',
    ]);
  });

  test('a merge keeps X: Y is archived, its shops, request and documents move to X, X reopens and is re-queued for Temix, and the salesman is told', async ({ browser }) => {
    test.setTimeout(240_000);
    const stw = w.user('STW');
    const X = w.customer('X');
    const Y = w.customer('Y');
    const page = await openAs(browser, stw, '/duplicates');
    const merged = seeText(page, '✓ Merged.');
    await pair(page, 'X', 'Y').getByRole('button', { name: keepLeft('X') }).click();
    await merged;
    await page.reload();
    await expect(pair(page, 'X', 'Y')).toHaveCount(0);

    const y = await db.customer.findUniqueOrThrow({ where: { id: Y.id }, select: { deletedAt: true } });
    expect(y.deletedAt).not.toBeNull();
    expect((await db.branch.findUniqueOrThrow({ where: { id: Y.branch.id } })).customerId).toBe(X.id);
    const x = await db.customer.findUniqueOrThrow({ where: { id: X.id }, select: { status: true, temixSyncState: true } });
    // Owner decision 7: an open shop moving onto a CLOSED winner reopens it; the winner is re-queued for Temix.
    expect(x).toEqual({ status: 'ACTIVE', temixSyncState: 'PENDING_UPLOAD' });
    const e = await db.customerEdit.findUniqueOrThrow({ where: { id: yEdit }, select: { state: true, customerId: true, decisionReason: true } });
    expect(e).toEqual({ state: 'REJECTED', customerId: X.id, decisionReason: `Auto-closed: customer ${Y.code} merged into ${X.code}.` });
    const told = (await notificationsFor({ editId: yEdit })).filter((n) => n.userId === w.user('SA').id);
    expect(told.map((n) => [n.title, n.customerId])).toContainEqual(['Request closed by a merge', X.id]);
    if (hasR2) {
      expect(await db.attachment.count({ where: { customerId: Y.id, deletedAt: null } }), 'no live document left on the loser').toBe(0);
      expect(await db.attachment.count({ where: { customerId: X.id, deletedAt: null, kind: 'CR' } })).toBeGreaterThan(0);
    }
    expect((await auditFor({ entityId: X.id, action: 'MERGE' })).map((a) => a.reason)).toEqual([`Merged ${Y.code} into ${X.code}`]);
    expect((await auditFor({ entityId: X.id, action: 'REACTIVATE' })).length).toBe(1);
  });

  test('a cross-region merge asks for a reason of five characters or more, then merges with the reason audited', async ({ browser }) => {
    const U = w.customer('U');
    const V = w.customer('V');
    const page = await openAs(browser, w.user('STW'), '/duplicates');
    await pair(page, 'U', 'V').getByRole('button', { name: keepLeft('U') }).click();
    const li = pair(page, 'U', 'V');
    await expect(li).toContainText('This is a cross-region merge. Enter a reason and confirm below.');
    const reason = li.getByPlaceholder('Reason for cross-region merge (5+ chars)');
    const confirmBtn = li.getByRole('button', { name: 'Confirm cross-region merge' });
    await reason.fill('abc');
    await expect(confirmBtn).toBeDisabled();
    const why = 'Same CR, the shop moved across the region border';
    await reason.fill(why);
    await expect(confirmBtn).toBeEnabled();
    const merged = seeText(page, '✓ Merged.');
    await confirmBtn.click();
    await merged;
    expect((await db.customer.findUniqueOrThrow({ where: { id: V.id } })).deletedAt).not.toBeNull();
    expect((await auditFor({ entityId: U.id, action: 'MERGE' })).map((a) => a.reason)).toEqual([`Cross-region merge: ${V.code} -> ${U.code}. ${why}`]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Audit (SV-AUDIT-FILTERS, MGR-AUDIT-SCOPE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: audit log', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  const e = { E1: '', E2: '', E3: '' };
  let importBatch = '';
  /** Yesterday 21:30 UTC — already today in Oman: the When column must show the Oman day. */
  const lateEvening = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 2.5 * 3_600_000);

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bka', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
      ],
      customers: [
        { key: 'C1', phone: true, contact: 'Camal Al Amri', branches: [{ key: 'S', route: 'A' }] },
        { key: 'C2', phone: true, contact: 'Cyrus Al Amri', branches: [{ key: 'S', route: 'A' }] },
        { key: 'CB', phone: true, contact: 'Badr Al Amri', branches: [{ key: 'S', route: 'B' }] },
      ],
    });
    const patch = (k: string) => ({ customer: { contactPerson: w.name(`Audit ${k}`) } });
    e.E1 = (await seedUpdateEdit(w, { customer: 'C1', submitter: 'SA', patch: patch('E1') })).id;
    e.E2 = (await seedUpdateEdit(w, { customer: 'C2', submitter: 'SA', patch: patch('E2') })).id;
    e.E3 = (await seedUpdateEdit(w, { customer: 'CB', submitter: 'SB', patch: patch('E3') })).id;
    for (const [id, by] of [
      [e.E2, 'M1'],
      [e.E3, 'M5'],
    ] as const) {
      await db.customerEdit.update({ where: { id }, data: { state: 'APPROVED', pendingRole: null, reviewedById: w.user(by).id, reviewedAt: new Date(), slaDueAt: null } });
    }
    importBatch = newId();
    w.adopt.importBatch(importBatch);
    await db.importBatch.create({ data: { id: importBatch, filename: `${w.sfx}-audit.xlsx`, kind: 'CUSTOMER', uploadedById: w.user('STW').id, status: 'PROMOTED' } });

    // The decisions and admin events the page must scope (written as the app's writers write them).
    const u = (k: string) => w.user(k).id;
    const rows: Prisma.AuditLogCreateManyInput[] = [
      { actorId: u('M1'), action: 'APPROVE', entityType: 'CustomerEdit', entityId: e.E2, reason: 'e2e approve in R1' },
      { actorId: u('M1'), action: 'STEP_APPROVE', entityType: 'CustomerEdit', entityId: e.E2, reason: 'e2e step in R1', at: lateEvening },
      { actorId: u('M1'), action: 'REACTIVATE', entityType: 'Branch', entityId: w.branch('C2').id, reason: 'e2e reactivate in R1' },
      { actorId: u('M1'), action: 'UPDATE', entityType: 'User', entityId: u('SA'), reason: 'password_reset' },
      { actorId: u('M5'), action: 'UPDATE', entityType: 'User', entityId: u('SB'), reason: 'password_reset' },
      { actorId: u('M5'), action: 'APPROVE', entityType: 'CustomerEdit', entityId: e.E3, reason: 'e2e approve in R2' },
      { actorId: u('STW'), action: 'UPDATE', entityType: 'Route', entityId: w.route('A').id, reason: 'disabled' },
      { actorId: u('STW'), action: 'IMPORT', entityType: 'ImportBatch', entityId: importBatch, reason: 'customer_master_promote' },
      { actorId: u('STW'), action: 'CREATE', entityType: 'User', entityId: u('SA'), reason: 'e2e user created' },
      // 51 rows on one customer, for paging.
      ...Array.from({ length: 51 }, (_, i) => ({
        actorId: u('STW'),
        action: 'UPDATE' as const,
        entityType: 'Customer',
        entityId: w.customer('C1').id,
        reason: `e2e paging ${i + 1}`,
      })),
    ];
    await db.auditLog.createMany({ data: rows });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  const entity = (type: string, id: string) => `${type}/${id.slice(0, 8)}…`;
  const logRow = (page: Page, type: string, id: string) => page.locator('tbody tr').filter({ hasText: entity(type, id) });

  test('the Steward filters by action, entity and entity id — with the actor named and every entity type on offer', async ({ browser }) => {
    const stw = w.user('STW');
    const sa = w.user('SA');
    const page = await openAs(browser, stw, '/audit');
    await page.locator('input[name="q"]').fill(sa.id.slice(0, 10));
    await page.locator('select[name="action"]').selectOption('CREATE');
    await page.locator('select[name="entityType"]').selectOption('User');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/[?&]action=CREATE/);
    await expect(page).toHaveURL(/[?&]entityType=User/);
    const created = logRow(page, 'User', sa.id).filter({ hasText: 'e2e user created' });
    await expect(created).toHaveCount(1);
    await expect(created).toContainText(stw.fullName);
    await expect(created).toContainText('CREATE');

    // Launch fix (wave 1): Region, Route, TemixSyncBatch and CustomerPair can be filtered.
    for (const t of ['Region', 'Route', 'TemixSyncBatch', 'CustomerPair', 'ImportBatch']) {
      await expect(page.locator(`select[name="entityType"] option[value="${t}"]`), t).toHaveCount(1);
    }
    await page.goto(`/audit?entityType=Route&q=${w.route('A').id}`);
    await expect(logRow(page, 'Route', w.route('A').id)).toContainText('disabled');
    await page.goto(`/audit?entityType=ImportBatch&q=${importBatch}`);
    await expect(logRow(page, 'ImportBatch', importBatch)).toContainText('IMPORT');

    // An EXPORT the Steward really makes (the /customers list of one region: the streamed
    // /export downloads answer 500 in this build, STREAMED_EXPORT_BUG), then his actions only.
    await page.goto(`/customers?region=${w.region('R1').id}`);
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export filtered' }).click();
    expect((await dl).suggestedFilename()).toBe(`customers-${omanDateISO()}.xlsx`);
    await page.goto(`/audit?action=EXPORT&actor=${stw.id}`);
    await expect(page.getByText(`Showing what ${stw.fullName} did.`)).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: 'Export/customer' }).first()).toContainText(stw.fullName);

    // Times are Oman time (launch fix, wave 1).
    await page.goto(`/audit?action=STEP_APPROVE&q=${e.E2}`);
    await expect(logRow(page, 'CustomerEdit', e.E2).locator('td').first()).toHaveText(omanDateTime(lateEvening));
  });

  test('Next keeps the filters while paging', async ({ browser }) => {
    const c1 = w.customer('C1').id;
    const page = await openAs(browser, w.user('STW'), `/audit?action=UPDATE&q=${c1}`);
    await expect(pageSubtitle(page)).toHaveText('51 matching events');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    const next = page.getByRole('link', { name: 'Next →' });
    const href = (await next.getAttribute('href')) ?? '';
    await next.click();
    await landsOrGo(page, /[?&]page=2/, href.startsWith('/') ? href : `/audit${href}`, 'Next →');
    await expect(page).toHaveURL(new RegExp(`[?&]q=${c1}`));
    await expect(page).toHaveURL(/[?&]action=UPDATE/);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
  });

  test('a Manager sees his regions’ decisions, Route rows and people, in Oman time — and nothing of another region, imports included', async ({ browser }) => {
    test.setTimeout(240_000);
    const m1 = w.user('M1');
    // A real decision: M1 sends E1 back through the decision page.
    const page = await openAs(browser, m1, `/approvals/${e.E1}`);
    await page.getByRole('button', { name: /✗ Reject/ }).click();
    await page.locator('textarea[name="reason"]').fill('The contact name is spelt differently on the CR.');
    await page.getByRole('button', { name: '✗ Send back to salesman' }).click();
    await landsOrGo(page, /\/approvals(\?|$)/, '/approvals', 'Send back to salesman', async () => {
      const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: e.E1 }, select: { state: true } });
      return edit.state !== 'SUBMITTED';
    });

    // Fixture ids minted in the same instant share the 8 characters the Entity column shows,
    // so each row is looked up by its full id (q, "Entity ID contains"), not by that prefix.
    const NONE = 'No audit entries match these filters.';
    await page.goto(`/audit?action=REJECT&q=${e.E1}`);
    await expect(logRow(page, 'CustomerEdit', e.E1)).toContainText(m1.fullName);
    await page.goto(`/audit?action=APPROVE&q=${e.E2}`);
    await expect(logRow(page, 'CustomerEdit', e.E2)).toContainText('e2e approve in R1');
    await page.goto(`/audit?action=APPROVE&q=${e.E3}`);
    await expect(page.getByText(NONE), 'M5’s approval in R2').toBeVisible();
    await page.goto(`/audit?action=STEP_APPROVE&q=${e.E2}`);
    const step = logRow(page, 'CustomerEdit', e.E2);
    await expect(step).toContainText('e2e step in R1');
    await expect(step.locator('td').first()).toHaveText(omanDateTime(lateEvening));
    await page.goto(`/audit?entityType=CustomerEdit&q=${e.E1}`);
    await expect(logRow(page, 'CustomerEdit', e.E1).first()).toBeVisible();
    await page.goto(`/audit?entityType=CustomerEdit&q=${e.E3}`);
    await expect(page.getByText(NONE), 'a request in R2').toBeVisible();
    await page.goto(`/audit?entityType=User&q=${w.user('SA').id}`);
    await expect(logRow(page, 'User', w.user('SA').id).filter({ hasText: 'password_reset' })).toHaveCount(1);
    await page.goto(`/audit?entityType=User&q=${w.user('SB').id}`);
    await expect(page.getByText(NONE), 'M5’s reset of SB, in R2').toBeVisible();
    await page.goto(`/audit?entityType=Branch&action=REACTIVATE&q=${w.branch('C2').id}`);
    await expect(logRow(page, 'Branch', w.branch('C2').id)).toContainText('e2e reactivate in R1');
    await page.goto(`/audit?entityType=Route&q=${w.route('A').id}`);
    await expect(logRow(page, 'Route', w.route('A').id)).toContainText('disabled');

    // No imports for a Manager: not offered, and not shown by a hand-made URL either.
    await expect(page.locator('select[name="entityType"] option[value="ImportBatch"]')).toHaveCount(0);
    await page.goto(`/audit?entityType=ImportBatch&q=${importBatch}`);
    await expect(page.getByText('No audit entries match these filters.')).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Dashboards and service status (SV-DASHBOARD-ORG, MGR-DASH-SCOPE, SV-STATUS-PAGE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('back office: dashboards and service status', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('bkd', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'VW', role: 'VIEWER' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'MNONE', role: 'MANAGER' },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
      ],
      customers: [
        { key: 'UPD', phone: true, contact: 'Umar Al Lawati', branches: [{ key: 'S', route: 'A', gps: MUSCAT }] },
        { key: 'PEND', phone: true, contact: 'Pervez Al Lawati', branches: [{ key: 'S', route: 'A' }] },
        { key: 'CLOS', phone: true, branches: [{ key: 'S', route: 'A', status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 3_600_000) }] },
        { key: 'NEWC', phone: true, contact: 'Nabil Al Lawati', branches: [{ key: 'S', route: 'A' }] },
        { key: 'BONLY', phone: true, contact: 'Basim Al Lawati', branches: [{ key: 'S', route: 'B' }] },
      ],
    });
    // In region R1, inside the last 7 days: one new customer (an approved CREATE), one approved
    // update, one approved closure, and one request waiting — and nothing else.
    const hour = 3_600_000;
    const now = Date.now();
    const created = newId();
    const updated = newId();
    const closed = newId();
    for (const id of [created, updated, closed]) w.adopt.edit(id);
    await db.customerEdit.create({
      data: {
        id: created,
        target: 'CUSTOMER',
        process: 'CREATE',
        customerId: w.customer('NEWC').id,
        state: 'APPROVED',
        submittedById: w.user('SA').id,
        submittedAt: new Date(now - 3 * hour),
        reviewedById: w.user('M1').id,
        reviewedAt: new Date(now - hour),
        paymentTermsAtSubmit: 'CASH',
        fieldChanges: [],
        attachmentChanges: [],
        branchDrafts: {
          create: [{ branchName: w.name('Dash new shop'), regionId: w.region('R1').id, routeId: w.route('A').id, address: ADDRESS }],
        },
      },
    });
    await db.customerEdit.create({
      data: {
        id: updated,
        target: 'CUSTOMER',
        process: 'UPDATE',
        customerId: w.customer('UPD').id,
        state: 'APPROVED',
        submittedById: w.user('SA').id,
        submittedAt: new Date(now - 3 * hour),
        reviewedById: w.user('M1').id,
        reviewedAt: new Date(now - hour),
        paymentTermsAtSubmit: 'CASH',
        fieldChanges: [{ field: 'customer.contactPerson', before: 'Umar', after: 'Umar Al Lawati' }],
        attachmentChanges: [],
      },
    });
    await db.customerEdit.create({
      data: {
        id: closed,
        target: 'BRANCH',
        process: 'UPDATE',
        customerId: w.customer('CLOS').id,
        branchId: w.branch('CLOS').id,
        state: 'APPROVED',
        submittedById: w.user('SA').id,
        submittedAt: new Date(now - 3 * hour),
        reviewedById: w.user('M1').id,
        reviewedAt: new Date(now - hour),
        fieldChanges: [{ field: `branch.${w.branch('CLOS').id}.status`, before: 'ACTIVE', after: 'CLOSED' }],
        attachmentChanges: [],
        decisionReason: 'The shop closed for good',
      },
    });
    await seedUpdateEdit(w, { customer: 'PEND', submitter: 'SA', patch: { customer: { contactPerson: w.name('Pending contact') } } });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  const NO_FAILURE = async (page: Page) => {
    await expect(page.getByText('This card could not be loaded just now', { exact: false })).toHaveCount(0);
    await expect(page.getByText('Not available just now', { exact: true })).toHaveCount(0);
  };

  test('the Steward: the whole organisation, then region R1 with exactly its own figures, then Clear', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await openAs(browser, w.user('STW'), '/dashboard?period=7d');
    await expect(pageSubtitle(page)).toHaveText(/^Whole organisation · .+ – .+, Oman days$/, { timeout: 20_000 });
    await expect(page.getByText(/^Figures as of .+ Oman time$/)).toBeVisible();
    await NO_FAILURE(page);
    await expect(page.locator('a[href="/status"]').first()).toBeAttached();

    const R1 = w.region('R1');
    await page.goto(`/dashboard?period=7d&region=${R1.id}`);
    // The region's name comes from the 5-minute reference-data cache (lib/reference-data.ts), which
    // a fixture region inserted straight into the database does not bust: until it refreshes the
    // subtitle reads "Filtered view" (README: dropdowns can lag fixtures by 5 minutes).
    const r1Name = R1.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(pageSubtitle(page)).toHaveText(new RegExp(`^(Filtered: ${r1Name}|Filtered view) · `));
    await NO_FAILURE(page);
    for (const [label, value] of [
      ['New customers', '1'],
      ['Customers updated', '1'],
      ['Pending approval', '1'],
      ['Branches closed', '1'],
      ['Customers in view', '4'],
    ] as const) {
      await expect(kpiValue(page, label), label).toHaveText(value);
    }
    // The map shows cells, never a shop's exact position.
    await expectNoDataLeak(page, [String(MUSCAT.lat), String(MUSCAT.lng)]);

    const clear = page.getByRole('link', { name: 'Clear filters' });
    await expect(clear).toHaveAttribute('href', '/dashboard?period=7d');
    await clear.click();
    await landsOrGo(page, /\/dashboard\?period=7d$/, '/dashboard?period=7d', 'Clear filters');
    await expect(pageSubtitle(page)).toHaveText(/^Whole organisation · /);
  });

  test('the Viewer: the same organisation and region figures, and no link to approvals or service status', async ({ browser }) => {
    const page = await openAs(browser, w.user('VW'), '/dashboard?period=7d');
    await expect(pageSubtitle(page)).toHaveText(/^Whole organisation · /, { timeout: 20_000 });
    await NO_FAILURE(page);
    await page.goto(`/dashboard?period=7d&region=${w.region('R1').id}`);
    await expect(kpiValue(page, 'New customers')).toHaveText('1');
    await expect(kpiValue(page, 'Customers in view')).toHaveText('4');
    await expect(page.locator('a[href="/approvals"]')).toHaveCount(0);
    await expect(page.locator('a[href="/status"]')).toHaveCount(0);
  });

  test('on a 412 px phone the dashboard does not scroll sideways, and the period buttons update the address', async ({ browser }) => {
    const page = await openAs(browser, w.user('STW'), '/dashboard?period=7d', 'phone');
    await expect(pageSubtitle(page)).toHaveText(/^Whole organisation · /, { timeout: 20_000 });
    await expectNoSideScroll(page);
    await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: '90 days' }).click();
    await landsOrGo(page, /[?&]period=90d/, '/dashboard?period=90d', 'the 90 days button');
    await expect(pageSubtitle(page)).toHaveText(/^Whole organisation · /);
    await expectNoSideScroll(page);
  });

  test('a Manager never sees another region’s figures through hand-made addresses; long periods and filters are explained', async ({ browser }) => {
    test.setTimeout(240_000);
    const R1 = w.region('R1');
    const R2 = w.region('R2');
    const page = await openAs(browser, w.user('M5'), '/dashboard?period=7d');
    await expect(pageSubtitle(page)).toHaveText(/^Your regions/, { timeout: 20_000 });
    for (const q of [`region=${R1.id}`, `route=${w.route('A').id}`]) {
      await page.goto(`/dashboard?period=7d&${q}`);
      await expect(pageSubtitle(page), q).toHaveText(/\(filtered\) · /);
      await expect(kpiValue(page, 'Customers in view'), q).toHaveText('0');
      await expect(kpiValue(page, 'New customers'), q).toHaveText('0');
    }
    await page.goto(`/dashboard?period=7d&region=${R1.id}&region=${R2.id}`);
    await expect(kpiValue(page, 'Customers in view')).toHaveText('1');
    // The filter lists offer nothing of R1.
    await expectNoDataLeak(page, [R1.name, w.route('A').code]);

    await page.goto('/dashboard?period=custom&from=2020-01-01&to=2030-12-31');
    await expect(page.getByText(/This period starts before go-live/)).toBeVisible();
    await page.goto(`/dashboard?region=${'x'.repeat(200)}`);
    await expect(page.getByText('A filter in the address was too long to read, so it matches nothing. Clear the filters.')).toBeVisible();

    const none = await openAs(browser, w.user('MNONE'), '/dashboard');
    await expect(pageSubtitle(none)).toHaveText('No regions assigned');
    await expect(none.getByText('Customers in view', { exact: true })).toHaveCount(0);
  });

  test('service status: six service levels with a verdict in words, measured in Oman time, no customer named; a Manager’s approvals are his regions’', async ({ browser }) => {
    const page = await openAs(browser, w.user('STW'), '/status');
    const cards = page.locator('section[aria-labelledby="slo-heading"] article');
    await expect(cards).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      await expect(cards.nth(i).locator('span').filter({ hasText: /^(Met|At risk|Missed|Not measured yet)$/ })).toHaveCount(1);
    }
    await expect(page.getByText(/^Measured at .+ Oman time$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Approvals waiting right now' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Scheduled jobs' })).toBeVisible();
    await expectNoDataLeak(page, w.customers().map((c) => c.legalName));

    const mgr = await openAs(browser, w.user('M5'), '/status');
    await expect(pageSubtitle(mgr)).toContainText('Approvals count the Supervisor step in your regions');
    await expect(mgr.getByRole('heading', { name: 'Approvals waiting in your regions' })).toBeVisible();
  });
});
