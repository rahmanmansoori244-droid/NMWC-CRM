/**
 * Synthetic-user load test: simulate a real day's activity against production
 * to catch any pre-launch issues NOT visible from code review.
 *
 * Three Playwright workers run concurrently against https://nmwc-cm.vercel.app:
 *   1. Salesman c1: enriches 2 customers + marks 1 branch closed.
 *   2. Salesman c4: enriches 2 customers (one with shared phone — tests P1.3).
 *   3. Supervisor ahmed: approves a batch via bulk-approve.
 *
 * Plus one solo agent (manager pilot.manager) that opens dashboard + approves
 * the reactivation that c1 will request.
 *
 * SAFETY:
 *   - Before any agent runs, snapshot the 6 test customers' state into
 *     `docs/audit/synthetic-test-snapshot-<DATE>.json`.
 *   - Each agent records what it created via console logs, and the report
 *     lists what the run produced.
 *   - There is NO clean-up script in the repository any more. Its pair,
 *     scripts/cleanup-synthetic-test.ts, reverted the customers and deleted
 *     audit rows under the maintenance switch; the owner deleted it on
 *     2026-10-11 (data audit 2026-10-10, gap 3; git history keeps it). What a
 *     run leaves behind is listed in the report and stays until someone decides
 *     what to do with it.
 *
 * Output: docs/audit/synthetic-test-report-<DATE>.json with timings, errors,
 * and what the run produced.
 *
 * Run:  npx tsx scripts/synthetic-launch-test.ts --expect-host ep-sweet-haze
 *
 * THE BROWSER PART ALWAYS ACTS ON PRODUCTION. BASE below is the live site,
 * whatever database this process was given: each of the four sign-ins writes a
 * LOGIN audit row there, and the "Mark closed" step uploads a photo through the
 * live form. So the script refuses to start unless the command line names
 * production with --expect-host ep-sweet-haze, and the shared guard
 * (scripts/lib/assert-not-production.ts) then refuses unless the database it
 * snapshots is production too. Before review of d02cb27 a UAT .env passed the
 * guard and the browser still signed in to production (data audit 2026-10-10,
 * gap 3). It is not a scripts/ops/ script, so docs/OPERATIONS.md §5j rule 1 does
 * not cover running it on production; whether it may run there, or stays in the
 * repository at all, is an open owner question (2026-10-11).
 */
import { chromium, type Page, type BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PRODUCTION_HOST_PREFIX, assertNotProduction, expectHostArg } from './lib/assert-not-production';

// Before the client and before Chromium: nothing is read or signed in to unless
// the operator has named production, because that is where BASE always points.
const named = expectHostArg(process.argv.slice(2));
if (named === null || !named.toLowerCase().startsWith(PRODUCTION_HOST_PREFIX)) {
  console.error(
    '[synthetic] refusing: this script signs in to the PRODUCTION site and uploads a photo there,\n' +
      '  whatever database it is given. Run it only on purpose, with\n' +
      `  --expect-host ${PRODUCTION_HOST_PREFIX} and a production DIRECT_URL. Nothing was read or written.`
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  datasourceUrl: assertNotProduction(process.env.DIRECT_URL ?? process.env.DATABASE_URL),
});

const BASE = 'https://nmwc-cm.vercel.app';
const STARTED_AT = new Date();
const STARTED_AT_ISO = STARTED_AT.toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Test targets — 6 customers + branches on c1 and c4 routes.
const TARGETS = {
  c1: [
    { custId: 'cmozfdiur00jotvfkreapvu8d', branchId: 'cmozfdj1q00jqtvfkcjuh1qta', nmwcCode: 'AQA0549-C1' },
    { custId: 'cmozfay5m0003tvfkupla658l', branchId: 'cmozfayck0005tvfk1oqws6bb', nmwcCode: 'CAA0367' },
    { custId: 'cmozfayqj0008tvfkey689ccc', branchId: 'cmozfayxi000atvfkc8r6h1eg', nmwcCode: 'CAA0389' },
  ],
  c4: [
    { custId: 'cmozfij9o01l9tvfkhp94fft5', nmwcCode: 'AQA0549-MISFA' },
    { custId: 'cmozff00b00uztvfkezhcot6c', nmwcCode: 'CAA0738' },
    { custId: 'cmozfg6d7013ytvfku8jjie4t', nmwcCode: 'CAA1313' },
  ],
};

const CREDS = {
  c1: { username: 'c1-12345-nmwc', password: 'C1-12345-NMWC' },
  c4: { username: 'c4-12345-nmwc', password: 'C4-12345-NMWC' },
  sup: { username: 'ahmed.alndabi', password: 'Ahmed-NMWC-2026!' },
  mgr: { username: 'pilot.manager', password: 'Manager-NMWC-2026!' },
};

type SnapEntry = {
  id: string;
  nmwcCode: string;
  legalName: string;
  primaryPhone: string | null;
  primaryPhoneNorm: string | null;
  contactPerson: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED';
  version: number;
  branchStatuses: Array<{ id: string; status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED'; lastStatusChangeAt: string | null }>;
};

async function snapshot(): Promise<SnapEntry[]> {
  const ids = [
    ...TARGETS.c1.map((t) => t.custId),
    ...TARGETS.c4.map((t) => t.custId),
  ];
  const customers = await prisma.customer.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      nmwcCode: true,
      legalName: true,
      primaryPhone: true,
      primaryPhoneNorm: true,
      contactPerson: true,
      notes: true,
      status: true,
      version: true,
      branches: { select: { id: true, status: true, lastStatusChangeAt: true } },
    },
  });
  return customers.map((c) => ({
    id: c.id,
    nmwcCode: c.nmwcCode,
    legalName: c.legalName,
    primaryPhone: c.primaryPhone,
    primaryPhoneNorm: c.primaryPhoneNorm,
    contactPerson: c.contactPerson,
    notes: c.notes,
    status: c.status,
    version: c.version,
    branchStatuses: c.branches.map((b) => ({
      id: b.id,
      status: b.status,
      lastStatusChangeAt: b.lastStatusChangeAt?.toISOString() ?? null,
    })),
  }));
}

async function login(page: Page, c: { username: string; password: string }) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  if (!page.url().endsWith('/login')) await page.context().clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name=username]', c.username);
  await page.fill('input[name=password]', c.password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 20000 }).catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** Inject a tiny test JPEG into the file input (proven flow from prior testing). */
async function injectPhoto(page: Page, fileInputIndex = 0) {
  return page.evaluate((idx) => {
    return new Promise<{ ok: boolean }>((resolve) => {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 200;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#9ad';
      ctx.fillRect(0, 0, 200, 200);
      ctx.fillStyle = '#fff';
      ctx.font = '16px sans-serif';
      ctx.fillText(`TEST ${Date.now()}`, 10, 100);
      c.toBlob((blob) => {
        if (!blob) {
          resolve({ ok: false });
          return;
        }
        const file = new File([blob], `synth-${Date.now()}.jpg`, { type: 'image/jpeg' });
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        const input = inputs[idx] as HTMLInputElement | undefined;
        if (!input) {
          resolve({ ok: false });
          return;
        }
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        resolve({ ok: true });
      }, 'image/jpeg', 0.9);
    });
  }, fileInputIndex);
}

type WorkerResult = {
  name: string;
  steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }>;
  errors: string[];
};

async function workerSalesmanC1(ctx: BrowserContext): Promise<WorkerResult> {
  const r: WorkerResult = { name: 'salesman-c1', steps: [], errors: [] };
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    const t0 = Date.now();
    await login(page, CREDS.c1);
    r.steps.push({ step: 'login', ok: true, ms: Date.now() - t0 });

    // Open customer profile + try the enrichment form (don't submit — just verify the page loads + the form renders).
    const target = TARGETS.c1[0];
    const t1 = Date.now();
    await page.goto(`${BASE}/customers/${target.custId}`, { waitUntil: 'networkidle' });
    const ok1 = (await page.locator('h1').count()) > 0;
    r.steps.push({ step: 'open customer profile', ok: ok1, ms: Date.now() - t1, detail: target.nmwcCode });

    const t2 = Date.now();
    await page.goto(`${BASE}/customers/${target.custId}/edit`, { waitUntil: 'networkidle' });
    const formCount = await page.locator('form').count();
    r.steps.push({ step: 'open enrichment form', ok: formCount > 0, ms: Date.now() - t2 });

    // Test branch close UI on customer #2 — load form, inject photo, fill reason, but DO NOT submit
    // (we don't want to actually close a branch for live customers).
    const closeTarget = TARGETS.c1[1];
    const t3 = Date.now();
    await page.goto(`${BASE}/customers/${closeTarget.custId}`, { waitUntil: 'networkidle' });
    const markClosedBtn = page.locator('button:has-text("Mark closed")').first();
    if ((await markClosedBtn.count()) > 0) {
      await markClosedBtn.click();
      await page.waitForTimeout(500);
      await injectPhoto(page);
      await page.waitForTimeout(2500);
      const photoFilled = (await page.locator('.border-emerald-300').count()) > 0;
      r.steps.push({ step: 'branch-close: photo upload', ok: photoFilled, ms: Date.now() - t3 });
    } else {
      r.steps.push({ step: 'branch-close: photo upload', ok: false, ms: Date.now() - t3, detail: 'Mark closed button not found' });
    }
  } catch (err) {
    r.errors.push((err as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

async function workerSalesmanC4(ctx: BrowserContext): Promise<WorkerResult> {
  const r: WorkerResult = { name: 'salesman-c4', steps: [], errors: [] };
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    const t0 = Date.now();
    await login(page, CREDS.c4);
    r.steps.push({ step: 'login', ok: true, ms: Date.now() - t0 });

    const target = TARGETS.c4[0];
    const t1 = Date.now();
    await page.goto(`${BASE}/customers/${target.custId}`, { waitUntil: 'networkidle' });
    const ok1 = (await page.locator('h1').count()) > 0;
    r.steps.push({ step: 'open customer profile', ok: ok1, ms: Date.now() - t1, detail: target.nmwcCode });

    // Visit /today and /customers list — performance probe
    const t2 = Date.now();
    await page.goto(`${BASE}/today`, { waitUntil: 'networkidle' });
    r.steps.push({ step: 'open /today', ok: true, ms: Date.now() - t2 });

    const t3 = Date.now();
    await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
    const hasCards = (await page.locator('a[href^="/customers/"]').count()) > 0;
    r.steps.push({ step: 'open /customers list', ok: hasCards, ms: Date.now() - t3 });
  } catch (err) {
    r.errors.push((err as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

async function workerSupervisor(ctx: BrowserContext): Promise<WorkerResult> {
  const r: WorkerResult = { name: 'supervisor', steps: [], errors: [] };
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    const t0 = Date.now();
    await login(page, CREDS.sup);
    r.steps.push({ step: 'login', ok: true, ms: Date.now() - t0 });

    const t1 = Date.now();
    await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle' });
    const pendingCount = await page.locator('a[href^="/approvals/"]').count();
    r.steps.push({ step: 'open approvals queue', ok: true, ms: Date.now() - t1, detail: `${pendingCount} pending links` });

    // Take a look at the diff page if a pending edit exists
    const firstHref = await page
      .evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href^="/approvals/"]')).find(
          (el) => /^\/approvals\/[a-z0-9]+$/.test((el as HTMLAnchorElement).getAttribute('href') ?? '')
        );
        return a ? (a as HTMLAnchorElement).getAttribute('href') : null;
      })
      .catch(() => null);
    if (firstHref) {
      const t2 = Date.now();
      await page.goto(`${BASE}${firstHref}`, { waitUntil: 'networkidle' });
      const hasApproveBtn = (await page.locator('button:has-text("Approve")').count()) > 0;
      r.steps.push({ step: 'open approval diff', ok: hasApproveBtn, ms: Date.now() - t2 });
    }
  } catch (err) {
    r.errors.push((err as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

async function workerManager(ctx: BrowserContext): Promise<WorkerResult> {
  const r: WorkerResult = { name: 'manager', steps: [], errors: [] };
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    const t0 = Date.now();
    await login(page, CREDS.mgr);
    r.steps.push({ step: 'login', ok: true, ms: Date.now() - t0 });

    const t1 = Date.now();
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
    r.steps.push({ step: 'open /dashboard', ok: true, ms: Date.now() - t1 });

    const t2 = Date.now();
    await page.goto(`${BASE}/reactivations`, { waitUntil: 'networkidle' });
    const count = await page.locator('h3').count();
    r.steps.push({ step: 'open /reactivations', ok: true, ms: Date.now() - t2, detail: `${count} requests` });

    const t3 = Date.now();
    await page.goto(`${BASE}/users`, { waitUntil: 'networkidle' });
    const rowCount = await page.locator('tr').count();
    r.steps.push({ step: 'open /users', ok: rowCount > 1, ms: Date.now() - t3, detail: `${rowCount} rows incl header` });
  } catch (err) {
    r.errors.push((err as Error).message);
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

async function main() {
  console.log(`=== Synthetic load test — started ${STARTED_AT.toISOString()} ===`);
  mkdirSync('docs/audit', { recursive: true });

  // Snapshot
  console.log('\n[1/4] Snapshot test customers…');
  const snap = await snapshot();
  const snapPath = join('docs/audit', `synthetic-test-snapshot-${STARTED_AT_ISO}.json`);
  writeFileSync(snapPath, JSON.stringify({ snapshotAt: STARTED_AT.toISOString(), customers: snap }, null, 2));
  console.log(`  Saved ${snap.length} customers to ${snapPath}`);

  // Launch
  console.log('\n[2/4] Run 4 workers concurrently against production…');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // mobile
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const results = await Promise.all([
    workerSalesmanC1(ctx),
    workerSalesmanC4(ctx),
    workerSupervisor(ctx),
    workerManager(ctx),
  ]);

  await browser.close();

  // Summarize
  console.log('\n[3/4] Results:');
  for (const r of results) {
    console.log(`\n  ${r.name}:`);
    for (const s of r.steps) {
      const tick = s.ok ? '✓' : '✗';
      console.log(`    ${tick} ${s.step.padEnd(32)} ${s.ms}ms${s.detail ? '  (' + s.detail + ')' : ''}`);
    }
    for (const e of r.errors) console.log(`    ERROR: ${e.slice(0, 200)}`);
  }

  // Identify any rows produced during the test, for the report
  const editsCreated = await prisma.customerEdit.findMany({
    where: { createdAt: { gte: STARTED_AT } },
    select: { id: true, customerId: true, branchId: true, state: true, submittedBy: { select: { username: true } } },
  });
  const attachmentsCreated = await prisma.attachment.findMany({
    where: { createdAt: { gte: STARTED_AT } },
    select: { id: true, r2Key: true, capturedBy: { select: { username: true } } },
  });
  const auditCreated = await prisma.auditLog.count({
    where: { at: { gte: STARTED_AT } },
  });

  console.log(`\n[4/4] Produced during test:`);
  console.log(`  CustomerEdits: ${editsCreated.length}`);
  console.log(`  Attachments:   ${attachmentsCreated.length}`);
  console.log(`  AuditLog rows: ${auditCreated}`);

  const reportPath = join('docs/audit', `synthetic-test-report-${STARTED_AT_ISO}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        startedAt: STARTED_AT.toISOString(),
        endedAt: new Date().toISOString(),
        snapshotPath: snapPath,
        results,
        produced: {
          edits: editsCreated,
          attachments: attachmentsCreated,
          auditLogRowsCount: auditCreated,
        },
      },
      null,
      2
    )
  );
  console.log(`\nReport saved: ${reportPath}`);
  // The clean-up script this used to name was deleted on 2026-10-11 (owner decision).
  console.log('\nNext: review the report. There is no clean-up script in the repository;');
  console.log('what this run produced stays until someone decides what to do with it.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
