/**
 * NEW-CUSTOMER REQUESTS AND THEIR APPROVAL CHAINS — the launch build, from the
 * salesman's form through both chains to the customer it mints.
 *
 *   CASH    Salesman → Supervisor step (his supervisor, or any Manager of the
 *           region) → Accountant of the region, who creates the customer.
 *   CREDIT  Salesman → Supervisor step → Finance Manager → GM → Accountant; the
 *           requested figures are approved or rejected, never amended, and never
 *           in a bulk approve.
 *
 * What the launch build changed here, and what these tests hold it to:
 *   - wave 1: the Accountant stays on the request and sees the code he created;
 *     a request in review keeps its GPS controls off; a removed photo reads as
 *     removed, and the last-step refusals say "reject it"; a phone-only match is
 *     shown to the approver; an abandoned draft can be withdrawn and a departed
 *     salesman's draft no longer blocks; duplicate refusals at submit name only
 *     a customer the salesman can open; Recent activity reads "requested this new
 *     customer"; a salesman's progress pings are information, not red; a decision
 *     settles the other approvers' alerts; Arabic digits in the credit figures.
 *   - wave 2 (owner decisions of 7 Oct): new-customer requests keep their region
 *     rule at the Supervisor step (any Manager of the draft's region); the GM's
 *     row at his step is an e-mail outbox row (e-mail itself stays off in the
 *     suite: the drain's own verdict is asked, nothing is sent); the CR document
 *     of a CREDIT customer is locked for the salesman once the customer exists.
 *   - critic corrections: the Steward's row at finalize is EDIT_APPROVED_FINAL
 *     "Ready for Temix upload" linking to the new customer (the /temix ping is
 *     the SLA sweep's, an exclusive-phase job); a stale view is refused only when
 *     the reviewer can still act on the current step — otherwise he is told he
 *     is not authorized.
 *   - owner decision of 8 Oct (Temix code at approval): the Accountant creates
 *     the customer in Temix first and types its code in "Temix code *" before
 *     Approve and create — required, checked in the page (shape, never an NMWC
 *     code) and on the server (no other customer, live or archived, nor a live
 *     branch, holds it; refused under the box, naming the holder, nothing
 *     written); the customer is created with it (upper case, Western digits); the
 *     salesman's and the Steward's messages and the request page name both
 *     codes; a new customer at the Accountant's step is never bulk-approved (a
 *     lock, as for credit). Every test that creates a customer types a code of
 *     its own (temixCodeFor).
 *   - owner request of 10 Oct (the Temix code visible): the customer page
 *     shows "Temix code" beside the NMWC code; the salesman finds the customer
 *     by its Temix code typed in lower case, or by its start, and its card
 *     names the code; a salesman of another route or region finds nothing for
 *     it, as for a code nobody holds.
 *   - launch fixes: after Approve and create the page shows the code IN PLACE —
 *     no reload stands in for it (it stalled on "Created — loading…", fixed by
 *     the TransitionWatchdog, 8e47bc6); a salesman cannot remove a photo of his
 *     request while it is with the approvers (628e541).
 *
 * Each describe builds its own world (one tag each: the salesman's form on the
 * phone project; the multi-role chains on the desktop project with explicit
 * devices — the salesman always on a 412 px phone, FM/GM/ACC on a phone once).
 * Finalize advances CodeSequence: codes are asserted in order, consecutive when
 * nothing else finalized in between (a parallel suite may), strictly increasing
 * otherwise. Real UAT FMs, GMs and Stewards receive the org-wide rows too: those
 * audiences are asserted with "contains", and cleanup removes them by editId.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts create-chains --project=phone --project=desktop
 */
import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import {
  OMAN_TODAY,
  auditFor,
  captureServerAction,
  contextAs,
  createWorld,
  db,
  expectNoSideScroll,
  fetchAs,
  hasR2,
  installLaunchHooks,
  notRunHere,
  notificationsFor,
  omanYearNow,
  postJson,
  replayServerAction,
  requireLaunchEnv,
  resetLimits,
  seedUpdateEdit,
  shownInPlace,
  snapshot,
  submitCreateViaApi,
  TEMIX_CODE_BULK_REFUSED_MESSAGE,
  TEMIX_CODE_CRM_MESSAGE,
  TEMIX_CODE_REQUIRED_MESSAGE,
  TEMIX_LOCK_LABEL,
  TEMIX_LOCK_NOTE,
  normalizeTemixCode,
  temixCodeBox,
  temixCodeFor,
  temixCodeHolderMessage,
  temixCodeTakenMessage,
  trackRequests,
  typeTemixCode,
  uniquePng,
  type CustomerSpec,
  type DeviceKind,
  type FixtureUser,
  type UserSpec,
  type World,
} from './support';
import {
  adoptStrayPhotos,
  codeSeq,
  codeSequenceNext,
  decisionTokenNow,
  emailVerdictFor,
  fastForwardCreate,
  generalTrade,
  parseChain,
  rewriteActionForm,
  seedCreateRequest,
  stepDeadline,
  submitCreateRequestViaApi,
  uniqueCr,
  uploadCreatePhotos,
  type SeededCreate,
} from './support/create-chains-helpers';

// ── the app's words (read from the code, never paraphrased) ─────────────────

const NOT_AUTHORIZED = 'You are not authorized to act on this step.';
const STALE_VIEW = 'This request changed since you opened it. Reload the page and review it again.';
const MISSING_TOKEN = 'This page is out of date. Reload it and review the request again.';
const CREDIT_ONE_AT_A_TIME =
  'Credit applications are approved one at a time: open it, check the documents and the figures, then approve it there.';
const CREDIT_QUEUE_NOTE = 'Credit applications are approved one at a time: open each card marked with a lock.';
const CREDIT_LOCK = 'Credit application: open it to decide';
const PHOTO_REMOVED_AT_FINAL =
  'A required photo on this request was removed after it was sent, so it cannot be approved. Reject it and say which photo is missing. It goes back one approver at a time; once it reaches the salesman, he can take the photo again.';
const RETURNED_PREFIX = 'Returned for correction:';
const FIX_FIELDS = 'Not sent — fix what is marked in red, then submit again.';
const INVALID_PHONE = 'Enter a valid Oman number (8 digits, or +968 XXXXXXXX).';
const CR_LOCKED = 'The CR document of a credit customer is changed by your manager or the Data Steward.';
const DECIDED_ELSEWHERE = /This request was just decided by another reviewer\. Refresh to see the current state\.|Edit is in state APPROVED\./;
const ADDRESS = 'Way 3012, Al Ghubra North, Muscat — opposite the bakery';

const codeRe = () => new RegExp(`^NMWC-${omanYearNow()}-\\d{6}$`);

// ── worlds ───────────────────────────────────────────────────────────────────

/**
 * R1: M1 (SA's supervisor), M2 (SA2's) and M3 share it, with ACC1. R2: M5 (SB's
 * supervisor), ACC2. Org-wide: FM1, FM2, GM1, STW. Routes A, A2 in R1; B, B2 in R2.
 */
const CHAIN_USERS: UserSpec[] = [
  { key: 'M1', role: 'MANAGER', regions: ['R1'] },
  { key: 'M2', role: 'MANAGER', regions: ['R1'] },
  { key: 'M3', role: 'MANAGER', regions: ['R1'] },
  { key: 'M5', role: 'MANAGER', regions: ['R2'] },
  { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
  { key: 'SA2', role: 'SALESMAN', route: 'A2', supervisor: 'M2' },
  { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
  { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
  { key: 'ACC2', role: 'ACCOUNTANT', regions: ['R2'] },
  { key: 'FM1', role: 'FINANCE_MANAGER' },
  { key: 'FM2', role: 'FINANCE_MANAGER' },
  { key: 'GM1', role: 'GM' },
  { key: 'STW', role: 'STEWARD' },
];

function chainWorld(tag: string, extra: { users?: UserSpec[]; customers?: CustomerSpec[] } = {}): Promise<World> {
  return createWorld(tag, {
    regions: [{ key: 'R1' }, { key: 'R2' }],
    routes: [
      { key: 'A', region: 'R1' },
      { key: 'A2', region: 'R1' },
      { key: 'B', region: 'R2' },
      { key: 'B2', region: 'R2' },
    ],
    users: [...CHAIN_USERS, ...(extra.users ?? [])],
    customers: extra.customers ?? [],
  });
}

async function pageAs(browser: Browser, u: FixtureUser, device: DeviceKind): Promise<Page> {
  return (await contextAs(browser, u, { device })).newPage();
}

// ── the new-customer form ────────────────────────────────────────────────────

/** A FormSection (a <details>) by its heading. */
function formSection(page: Page, title: string | RegExp): Locator {
  return page.locator('details').filter({ has: page.locator('summary h3').filter({ hasText: title }) });
}

/** A PhotoCaptureSlot by its label ('CR document', 'Shop front', 'Signboard', 'Guarantee doc', 'Other'). */
function photoSlot(scope: Locator, label: string): Locator {
  return scope.locator('div.isolate').filter({ hasText: label });
}

/** A camera capture: a unique PNG through the slot's file input, compressed and uploaded by the page. */
async function takePhoto(slot: Locator): Promise<void> {
  await slot.locator('input[type="file"]').setInputFiles({ name: 'camera.png', mimeType: 'image/png', buffer: uniquePng() });
  await expect(slot.locator('label[aria-label="Retake photo"]'), 'photo uploaded (presign → R2 PUT → finalize)').toBeVisible({
    timeout: 90_000,
  });
}

function missingList(page: Page): Locator {
  return page.getByText('Cannot submit yet — missing:', { exact: true }).locator('xpath=..');
}

function submitButton(page: Page): Locator {
  return page.getByRole('button', { name: /Submit for approval/ });
}

async function fillIdentity(page: Page, o: { name: string; cr: string; phone: string; contact?: string }): Promise<void> {
  const ch = await generalTrade();
  await page.getByLabel('Legal name *', { exact: true }).fill(o.name);
  await page.getByLabel('CR number *', { exact: true }).fill(o.cr);
  await takePhoto(photoSlot(formSection(page, 'Identity'), 'CR document'));
  await page.getByLabel('Channel *', { exact: true }).selectOption(ch.channelId);
  await page.getByLabel('Sub-channel *', { exact: true }).selectOption(ch.subChannelId);
  await page.getByLabel('Primary phone *', { exact: true }).fill(o.phone);
  await page.getByLabel('Contact person *', { exact: true }).fill(o.contact ?? 'Salim Al Habsi');
}

async function fillBranch(branch: Locator, o: { day?: typeof OMAN_TODAY; photos?: string[] } = {}): Promise<void> {
  await branch.getByLabel('Address *', { exact: true }).fill(ADDRESS);
  await branch.getByRole('button', { name: /^Capture GPS/ }).click();
  await expect(branch.getByText('23.588100, 58.382900')).toBeVisible();
  await branch.getByLabel('Day of visit *', { exact: true }).selectOption(o.day ?? OMAN_TODAY);
  for (const p of o.photos ?? ['Shop front', 'Signboard']) await takePhoto(photoSlot(branch, p));
}

type FormAnswer = {
  ok: boolean;
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  data?: { editId: string; state: string; replayed: boolean };
};

/**
 * Clicks Submit or Save draft and returns the /api/forms/customer-create answer.
 * A successful submit navigates to /work at once, and the browser then drops the
 * response body (waitForResponse + json() races it). So the page's POST is held,
 * sent once and unchanged (its own headers, cookie and body) with Node's fetch, and
 * the answer is read here before the page gets it. Node's fetch, not route.fetch: a
 * failed route.fetch prints the request headers — the session cookie — into the
 * report (the secret scan then deletes the report and fails the run).
 */
async function sendForm(page: Page, click: () => Promise<void>): Promise<FormAnswer> {
  const pattern = '**/api/forms/customer-create';
  let settle!: { resolve: (a: FormAnswer) => void; reject: (e: unknown) => void };
  const answered = new Promise<FormAnswer>((resolve, reject) => (settle = { resolve, reject }));
  const HOP = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'keep-alive', 'transfer-encoding']);
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(await req.allHeaders())) if (!k.startsWith(':') && !HOP.has(k.toLowerCase())) headers[k] = v;
      const res = await fetch(req.url(), {
        method: 'POST',
        headers,
        body: new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0)),
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'].includes(k)) out[k] = v;
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies.join('\n');
      await route.fulfill({ status: res.status, headers: out, body });
      settle.resolve(JSON.parse(body.toString('utf8')) as FormAnswer);
    } catch (err) {
      // The kind of failure only: never the request (its headers carry the session cookie).
      settle.reject(new Error(`the customer-create POST got no answer (${(err as Error)?.name ?? 'error'})`));
      await route.abort('failed').catch(() => undefined);
    }
  };
  await page.route(pattern, handler);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await click();
    return await Promise.race([
      answered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no /api/forms/customer-create answer within 130 s')), 130_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await page.unroute(pattern, handler);
  }
}

// ── the approval pages ───────────────────────────────────────────────────────

function queueCard(page: Page, name: string): Locator {
  return page.locator('ul > li').filter({ hasText: name });
}

async function pendingCount(page: Page): Promise<number> {
  const text = (await page.getByText(/^\d+ pending/).first().textContent()) ?? '';
  return Number(/^(\d+)/.exec(text)?.[1] ?? Number.NaN);
}

async function openApproval(page: Page, id: string): Promise<void> {
  await page.goto(`/approvals/${id}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Approval chain' })).toBeVisible();
}

/** ✓ Approve, then the confirmation's own words. */
async function approveHere(page: Page, title: string, confirm: string): Promise<void> {
  await page.getByRole('button', { name: '✓ Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
}

/**
 * Was an APP BUG found by this file (2026-10-08), FIXED by 8e47bc6 (TransitionWatchdog):
 * after "Approve and create" the action answered ok and the customer existed, but about
 * half the time the page stayed on "Created — loading…" and never showed the code until
 * a reload (ApproveRejectActions' router.refresh() after approveEditAction was parked by
 * the React that Next 15.5 ships). A page stuck like that now FAILS the test.
 */
const STUCK_AFTER_CREATE = 'finalize page stuck on "Created — loading…" without the code (ApproveRejectActions router.refresh after approveEditAction)';

/**
 * The Accountant's last step (owner decision 2026-10-08): types `temixCode` in the
 * "Temix code *" box, ✓ Approve → "Approve and create"; returns the NMWC code. The
 * page must show the code in place, without a reload, IN_PLACE_MS after the server
 * finished: the request first read APPROVED in the database (polled from the tap)
 * and the page's own calls — the action, then its refresh — were answered
 * (support/in-place.ts). The server gets SERVER_WORK_MS.
 */
async function createHere(page: Page, editId: string, temixCode: string): Promise<string> {
  // Before the tap: the page's own calls say when the server answered it.
  trackRequests(page);
  await typeTemixCode(page, temixCode);
  await approveHere(page, 'Create this customer?', 'Approve and create');
  await shownInPlace(
    page,
    `Approve and create: the code on the page, in place (${STUCK_AFTER_CREATE} was fixed)`,
    (timeout) => expect(page.getByText(/^Created as customer NMWC-/)).toBeVisible({ timeout }),
    async () => (await db.customerEdit.findUnique({ where: { id: editId }, select: { state: true } }))?.state === 'APPROVED'
  );
  const row = await db.customerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: { customer: { select: { nmwcCode: true, temixCode: true } } },
  });
  expect(row.customer!.temixCode, 'created under the Temix code he typed, as Temix writes it').toBe(normalizeTemixCode(temixCode));
  await expect(page.getByText(`Temix code ${row.customer!.temixCode}.`, { exact: true }), 'the Temix code on the page').toBeVisible();
  return row.customer!.nmwcCode;
}

/** The Temix code box's own refusal (role=alert under the box). */
function temixCodeError(page: Page): Locator {
  return page.locator('#temix-code-error');
}

/** ✗ Reject with the form's own words for where it goes. */
async function rejectHere(
  page: Page,
  o: { label: string; button: string; category?: string; quick?: string; reason?: string }
): Promise<void> {
  await page.getByRole('button', { name: '✗ Reject', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reject this submission' })).toBeVisible();
  await expect(page.getByText(o.label, { exact: true })).toBeVisible();
  if (o.category) await page.locator('select[name="category"]').selectOption(o.category);
  if (o.quick) await page.getByRole('button', { name: o.quick, exact: true }).click();
  if (o.reason) await page.locator('textarea[name="reason"]').fill(o.reason);
  await page.getByRole('button', { name: o.button, exact: true }).click();
}

/** A labelled value on the customer page ("NMWC code", "Temix code", …): the <dd> beside its <dt>. */
function customerRow(page: Page, label: string): Locator {
  return page.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
}

async function expect404(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: '404' }), `${url} is not found for this account`).toBeVisible();
}

/** The scope-checked photo route, as the tile's own src fetches it. */
async function expectPhotoServed(page: Page, id: string, confidential: boolean): Promise<void> {
  const r = await fetchAs(page, `/api/photos/${id}`);
  expect(r.status, `photo ${id}`).toBe(200);
  expect(r.headers['content-type']).toBe('image/jpeg');
  if (confidential) {
    expect(r.headers['cache-control'], 'a CR or guarantee document is never cached').toBe('private, no-store, no-cache, must-revalidate');
    expect(r.headers['etag']).toBeUndefined();
  } else {
    expect(r.headers['cache-control']).toBe('private, max-age=3600, immutable');
    expect(r.headers['etag']).toBe(`"p-${id}"`);
  }
}

/** Every photo tile on the page decodes. Returns how many there are. */
async function expectTilesDecode(page: Page): Promise<string[]> {
  const imgs = page.locator('main img[src^="/api/photos/"]');
  const srcs = await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
  for (let i = 0; i < srcs.length; i++) {
    const img = imgs.nth(i);
    await img.scrollIntoViewIfNeeded();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { message: `tile ${srcs[i]} decodes` })
      .toBeGreaterThan(0);
  }
  return srcs;
}

// ── database read-backs ──────────────────────────────────────────────────────

async function rowIds(editId: string): Promise<Set<string>> {
  return new Set((await notificationsFor({ editId })).map((n) => n.id));
}

async function newRows(editId: string, before: Set<string>) {
  return (await notificationsFor({ editId })).filter((n) => !before.has(n.id));
}

const recipients = (rows: Array<{ userId: string }>) => [...new Set(rows.map((r) => r.userId))].sort();

/** E-mail is off in the suite: nothing is ever SENT; a row the drain has not seen is still in the outbox. */
function expectNothingEmailed(rows: Array<{ emailedAt: Date | null; emailStatus: string | null }>): void {
  for (const r of rows) {
    expect(r.emailStatus).not.toBe('SENT');
    if (r.emailedAt) expect(r.emailStatus ?? '').toMatch(/^SKIPPED_/);
  }
}

/** Bodies carry the legal name and the code only — never the phone or the CR number. */
function expectNoPii(rows: Array<{ title: string; body: string }>, secrets: Array<string | null | undefined>): void {
  for (const r of rows) {
    for (const s of secrets.filter((x): x is string => !!x)) {
      expect(`${r.title} ${r.body}`).not.toContain(s);
      expect(`${r.title} ${r.body}`.replace(/\s/g, '')).not.toContain(s.replace(/^\+968/, ''));
    }
  }
}

type StageRow = {
  approvalChain: unknown;
  currentStepIndex: number;
  stageEnteredAt: Date | null;
  slaDueAt: Date | null;
  escalationLevel: number;
  slaBreachedAt: Date | null;
};

/** A stage entered by the move just made: now, its own frozen budget in working hours, no escalation carried over. */
function expectFreshStage(row: StageRow, t0: number, hours: number): void {
  expect(row.stageEnteredAt, 'stageEnteredAt').not.toBeNull();
  expect(row.stageEnteredAt!.getTime()).toBeGreaterThanOrEqual(t0 - 2_000);
  expect(row.stageEnteredAt!.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
  const step = parseChain(row.approvalChain)[row.currentStepIndex]!;
  expect(step.slaHours, `${step.role} step budget`).toBe(hours);
  expect(row.slaDueAt?.getTime(), 'slaDueAt = stepDeadline(stageEnteredAt, working hours)').toBe(
    stepDeadline(row.stageEnteredAt!, hours).getTime()
  );
  expect(row.escalationLevel).toBe(0);
  expect(row.slaBreachedAt).toBeNull();
}

function stageOf(id: string) {
  return db.customerEdit.findUniqueOrThrow({
    where: { id },
    select: {
      state: true,
      pendingRole: true,
      currentStepIndex: true,
      cycle: true,
      approvalChain: true,
      stageEnteredAt: true,
      slaDueAt: true,
      escalationLevel: true,
      slaBreachedAt: true,
      decisionReason: true,
      decisionCategory: true,
      reviewedById: true,
      customerId: true,
    },
  });
}

/** Codes in finalize order: consecutive when nothing else finalized meanwhile, strictly increasing otherwise. */
function expectCodesInOrder(codes: string[], seqBefore: number, seqAfter: number): void {
  for (const c of codes) expect(c).toMatch(codeRe());
  const seqs = codes.map(codeSeq);
  for (let i = 1; i < seqs.length; i++) expect(seqs[i], `code ${codes[i]} after ${codes[i - 1]}`).toBeGreaterThan(seqs[i - 1]!);
  if (seqAfter - seqBefore === codes.length) {
    expect(seqs[0], 'the first code is the counter as it stood').toBe(seqBefore);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
  } else {
    test.info().annotations.push({
      type: 'code-sequence',
      description: `another finalize interleaved (${seqAfter - seqBefore} codes handed out for ${codes.length}): asserted strictly increasing only`,
    });
  }
}

/**
 * How many of the codes the counter handed out between two reads of it
 * (seqBefore … seqAfter − 1) a customer other than ours holds: a parallel
 * finalize. Counted by the code itself, not by createdAt: a time window opened a
 * minute before seqBefore also caught the codes this describe's own previous test
 * had minted just before the counter was read (8 Oct: the counter moved 0, and
 * "2 minted by others" were the last two finalizes of the in-place test).
 */
async function codesMintedByOthers(seqBefore: number, seqAfter: number, ours: string[]): Promise<number> {
  if (seqAfter <= seqBefore) return 0;
  const year = omanYearNow();
  const handedOut = Array.from({ length: seqAfter - seqBefore }, (_, i) => `NMWC-${year}-${String(seqBefore + i).padStart(6, '0')}`);
  return db.customer.count({ where: { nmwcCode: { in: handedOut }, legalName: { notIn: ours } } });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. CASH, end to end
// ═════════════════════════════════════════════════════════════════════════════

test.describe('new CASH customer, end to end', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  const A = { id: '', name: '', cr: '', phone: '', customerId: '', code: '', temix: '' };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('cca');
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test('the salesman sends a CASH customer from his phone: the form gate, Work, the frozen chain, who is told', async ({ browser }) => {
    notRunHere(!hasR2, 'the form uploads its photos to R2');
    test.setTimeout(360_000);
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/today');
    await page.getByRole('main').getByRole('link', { name: 'New customer' }).click();
    await expect(page).toHaveURL(/\/customers\/new$/);
    await expect(page.getByText(`Register a new shop on your route (${w.region('R1').name} · ${w.route('A').code})`)).toBeVisible();

    // Cash is preselected, and says its chain.
    await expect(page.getByRole('radio', { name: 'Cash' })).toBeChecked();
    await expect(page.getByText('Cash: approval chain is Supervisor → Accountant.', { exact: true })).toBeVisible();
    const submit = submitButton(page);
    await expect(submit).toBeDisabled();
    await expect(missingList(page)).toContainText('Legal name, Channel, Sub-channel, Primary phone, Contact person, CR number, CR document photo');

    A.name = w.name('Cash Corner');
    A.cr = uniqueCr(w);
    A.phone = (await w.allocPhones(1))[0]!;
    await fillIdentity(page, { name: A.name, cr: A.cr, phone: A.phone });
    const branch = formSection(page, /^Branch 1\b/);
    await expect(branch.getByLabel('Branch name *', { exact: true })).toHaveValue('Main');
    await fillBranch(branch, { day: OMAN_TODAY, photos: ['Shop front'] });
    await expect(branch.getByText('±9m')).toBeVisible();
    // Submit stays off until the missing list is empty.
    await expect(submit).toBeDisabled();
    await expect(missingList(page)).toContainText('missing: Branch 1 signboard photo.');
    await takePhoto(photoSlot(branch, 'Signboard'));
    await expect(page.getByText('Cannot submit yet — missing:', { exact: true })).toHaveCount(0);
    await expect(submit).toBeEnabled();

    const answer = await sendForm(page, () => submit.click());
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true, data: { state: 'SUBMITTED', replayed: false } });
    A.id = answer.data!.editId;
    w.adopt.edit(A.id);
    await expect(page).toHaveURL(/\/work$/);
    const item = page.getByRole('link').filter({ hasText: A.name });
    await expect(item).toContainText('New customer — in approval');
    await expect(item).toContainText('In review — current step: SUPERVISOR');

    // The request row: CREATE, no customer yet, the CASH chain frozen, drafts on his route, photos claimed.
    const ch = await generalTrade();
    const edit = await db.customerEdit.findUniqueOrThrow({
      where: { id: A.id },
      include: { customerDraft: true, branchDrafts: true, attachments: true },
    });
    expect(edit).toMatchObject({
      process: 'CREATE',
      target: 'CUSTOMER',
      customerId: null,
      state: 'SUBMITTED',
      pendingRole: 'SUPERVISOR',
      currentStepIndex: 0,
      cycle: 1,
      paymentTermsAtSubmit: 'CASH',
      submittedById: sa.id,
      requestedCreditLimit: null,
      escalationLevel: 0,
    });
    expect(parseChain(edit.approvalChain).map((s) => s.role)).toEqual(['SUPERVISOR', 'ACCOUNTANT']);
    expectFreshStage(edit, edit.submittedAt!.getTime(), 8);
    expect(edit.customerDraft).toMatchObject({
      legalName: A.name,
      paymentTerms: 'CASH',
      crNumber: A.cr,
      primaryPhoneNorm: A.phone,
      channelId: ch.channelId,
      subChannelId: ch.subChannelId,
      contactPerson: 'Salim Al Habsi',
    });
    expect(edit.branchDrafts).toHaveLength(1);
    expect(edit.branchDrafts[0]).toMatchObject({
      branchName: 'Main',
      routeId: w.route('A').id,
      regionId: w.region('R1').id,
      dayOfVisit: OMAN_TODAY,
      gpsAccuracy: 9,
      address: ADDRESS,
    });
    expect(edit.branchDrafts[0]!.gpsLat).toBeCloseTo(23.5881, 4);
    const live = edit.attachments.filter((a) => !a.deletedAt);
    expect(live.map((a) => a.kind).sort()).toEqual(['CR', 'SHOP', 'SIGNBOARD']);
    for (const a of live) expect(a, `${a.kind} claimed by the request, not wired yet`).toMatchObject({ editId: A.id, customerId: null, branchId: null, capturedById: sa.id });
    expect(edit.customerDraft!.crPhotoAttachmentId).toBe(live.find((a) => a.kind === 'CR')!.id);

    // Who is told: his supervisor must act; the region's Accountant for information; nobody else.
    const rows = await notificationsFor({ editId: A.id });
    expect(rows.map((r) => `${r.kind}:${r.userId}`).sort()).toEqual(
      [`EDIT_SUBMITTED:${w.user('M1').id}`, `REQUEST_FYI:${w.user('ACC1').id}`].sort()
    );
    expect(rows.find((r) => r.kind === 'EDIT_SUBMITTED')).toMatchObject({
      title: 'New customer request',
      body: `${A.name} — new CASH customer request awaiting your review.`,
      readAt: null,
    });
    expect(rows.find((r) => r.kind === 'REQUEST_FYI')).toMatchObject({
      title: 'For your information: a salesman request',
      body: `${A.name} — new customer request submitted.`,
    });
    expectNothingEmailed(rows);
    expectNoPii(rows, [A.phone, A.cr]);
  });

  test('M2, a Manager of the region but not the supervisor, sends it on to the Accountant; no customer yet', async ({ browser }) => {
    test.skip(!A.id, 'needs the request the salesman sent');
    const m1 = await pageAs(browser, w.user('M1'), 'desktop');
    await m1.goto('/approvals');
    await expect(queueCard(m1, A.name)).toBeVisible();
    const m1Pending = await pendingCount(m1);

    const m2 = await pageAs(browser, w.user('M2'), 'desktop');
    await m2.goto('/approvals');
    const card = queueCard(m2, A.name);
    await expect(card).toContainText('New');
    await expect(card).toContainText('New CASH customer request');
    await expect(card).toContainText(`Submitted by ${w.user('SA').fullName}`);
    await card.getByRole('link').click();
    await expect(m2).toHaveURL(new RegExp(`/approvals/${A.id}$`));
    await expect(m2.getByRole('heading', { level: 1, name: A.name })).toBeVisible();
    await expect(m2.getByRole('link', { name: 'Open profile' }), 'no profile while it is pending').toHaveCount(0);
    await expect(m2.getByRole('heading', { level: 2, name: 'New CASH customer' })).toBeVisible();
    await expect(
      m2.getByRole('heading', { level: 2, name: `Branch 1: Main (${w.region('R1').name} · ${w.route('A').code})` })
    ).toBeVisible();
    const srcs = await expectTilesDecode(m2);
    expect(srcs).toHaveLength(3);
    for (const src of srcs) expect((await fetchAs(m2, src)).status, src).toBe(200);
    await expect(m2.getByRole('link', { name: 'Open in Maps' })).toBeVisible();
    await expect(temixCodeBox(m2), 'the Temix code box is the Accountant’s alone, at the last step').toHaveCount(0);

    const before = await rowIds(A.id);
    const t0 = Date.now();
    await approveHere(m2, 'Send on to Accountant?', 'Approve and send on');
    await expect(m2).toHaveURL(/\/approvals$/);
    await expect(queueCard(m2, A.name)).toHaveCount(0);
    for (const k of ['M1', 'M3']) {
      const p = k === 'M1' ? m1 : await pageAs(browser, w.user(k), 'desktop');
      await p.goto('/approvals');
      await expect(queueCard(p, A.name), `${k}'s queue`).toHaveCount(0);
    }
    expect(await pendingCount(m1), "M1's queue count drops by one").toBe(m1Pending - 1);

    const row = await db.customerEdit.findUniqueOrThrow({ where: { id: A.id } });
    expect(row).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 1, pendingRole: 'ACCOUNTANT', customerId: null });
    expectFreshStage(row, t0, 9);
    const steps = await db.editApproval.findMany({ where: { editId: A.id } });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', actorId: w.user('M2').id });
    expect(steps[0]!.workingMinutes, 'the stage snapshot').not.toBeNull();
    expect((await auditFor({ entityId: A.id, action: 'STEP_APPROVE' })).map((a) => a.actorId)).toEqual([w.user('M2').id]);
    expect(await db.customer.count({ where: { legalName: A.name } }), 'nothing on the master until the last step').toBe(0);

    // The Accountant must act now; the salesman is told it moved. M1's row is settled (read).
    const fresh = await newRows(A.id, before);
    expect(fresh.map((r) => `${r.kind}:${r.userId}`).sort()).toEqual(
      [`EDIT_STAGE_ADVANCED:${w.user('ACC1').id}`, `EDIT_STAGE_ADVANCED:${w.user('SA').id}`].sort()
    );
    expect(fresh.find((r) => r.userId === w.user('ACC1').id)).toMatchObject({
      title: 'Approval waiting on you',
      body: `${A.name} — request advanced to the ACCOUNTANT step.`,
    });
    expect(fresh.find((r) => r.userId === w.user('SA').id)).toMatchObject({
      title: 'Request advanced',
      body: `${A.name} — approved at the SUPERVISOR step; now with ACCOUNTANT.`,
    });
    const all = await notificationsFor({ editId: A.id });
    expect(all.find((r) => r.kind === 'EDIT_SUBMITTED')!.readAt, "M1's review row is settled by M2's decision").not.toBeNull();
    expect(all.find((r) => r.kind === 'REQUEST_FYI')!.readAt, 'the FYI is information, not settled').toBeNull();
    expectNothingEmailed(all);
    expectNoPii(all, [A.phone, A.cr]);
  });

  test('the Accountant on his phone: the FYI is muted in the bell, and Mark information read leaves the request waiting on him', async ({ browser }) => {
    test.skip(!A.id, 'needs the request the salesman sent');
    const acc1 = w.user('ACC1');
    const page = await pageAs(browser, acc1, 'phone');
    await page.goto('/approvals');
    await expect(page.getByRole('link', { name: /^Notifications/ })).toHaveAttribute('aria-label', 'Notifications (1 unread, 1 for information)');
    await page.goto('/notifications');
    await expect(page.getByText('1 unread · 1 for information', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mark information read' }).click();
    await expect(page.getByText('1 unread', { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await notificationsFor({ editId: A.id })).filter((n) => n.userId === acc1.id).map((n) => `${n.kind}:${n.readAt ? 'read' : 'unread'}`).sort())
      .toEqual(['EDIT_STAGE_ADVANCED:unread', 'REQUEST_FYI:read']);
    // The must-act row opens the request itself.
    const row = page.getByRole('link').filter({ hasText: 'Approval waiting on you' }).filter({ hasText: A.name });
    await expect(row).toHaveAttribute('href', `/approvals/${A.id}`);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${A.id}$`));
  });

  test('the Accountant creates it on his phone: the code on his page, the customer, its branch, its photos, its audit trail', async ({ browser }) => {
    test.skip(!A.id, 'needs the request the salesman sent');
    const acc1 = w.user('ACC1');
    const page = await pageAs(browser, acc1, 'phone');
    await page.goto('/approvals');
    const card = queueCard(page, A.name);
    const pill = card.locator('span').filter({ hasText: /^due in \d+h$/ });
    await expect(pill, 'a green working-hours pill').toBeVisible();
    await expect(pill).toHaveClass(/bg-emerald-50/);
    await card.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${A.id}$`));

    const before = await rowIds(A.id);
    const seqBefore = await codeSequenceNext();
    // Owner decision 8 Oct: the last step asks for the Temix code, and only there.
    await expect(temixCodeBox(page), 'a labelled, required box').toHaveAttribute('aria-required', 'true');
    await expect(page.getByText('Create the customer in Temix first, then type the code Temix gave it.', { exact: true })).toBeVisible();
    // Wave 1: he stays on the request, which shows the code he created (see createHere).
    A.temix = temixCodeFor(w);
    await createHere(page, A.id, A.temix);
    await expect(page).toHaveURL(new RegExp(`/approvals/${A.id}$`));
    await expect(temixCodeBox(page), 'no box once it is decided').toHaveCount(0);
    const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: A.id } });
    expect(edit).toMatchObject({ state: 'APPROVED', pendingRole: null, reviewedById: acc1.id });
    expect(edit.customerId).not.toBeNull();
    const customer = await db.customer.findUniqueOrThrow({ where: { id: edit.customerId! }, include: { branches: true } });
    A.customerId = customer.id;
    A.code = customer.nmwcCode;
    await expect(page.getByText(`Created as customer ${A.code}.`)).toBeVisible();
    await expect(page.getByText(`New customer ${A.code} · submitted by ${w.user('SA').fullName}`, { exact: false })).toBeVisible();
    await expect(page.getByText(`Decision: APPROVED by ${acc1.fullName}`, { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open profile' })).toHaveAttribute('href', `/customers/${A.customerId}`);
    expectCodesInOrder([A.code], seqBefore, await codeSequenceNext());

    expect(customer).toMatchObject({
      legalName: A.name,
      paymentTerms: 'CASH',
      creditLimit: null,
      paymentTermDays: null,
      status: 'ACTIVE',
      // Owner decision 8 Oct: created under the Temix code typed at the last step, and still queued for the
      // next Temix workbook (an UPSERT of the record the Accountant made).
      temixSyncState: 'PENDING_UPLOAD',
      temixCode: A.temix,
      createdById: w.user('SA').id,
      lastEditedById: acc1.id,
      crNumber: A.cr,
      primaryPhoneNorm: A.phone,
    });
    expect(customer.temixSyncPendingSince).not.toBeNull();
    expect(customer.crPhotoId).not.toBeNull();
    expect(customer.completenessScore).toBeGreaterThan(0);
    expect(customer.branches).toHaveLength(1);
    const branch = customer.branches[0]!;
    expect(branch).toMatchObject({ branchCode: `${A.code}-01`, routeId: w.route('A').id, regionId: w.region('R1').id, status: 'ACTIVE' });
    expect(branch.shopPhotoId).not.toBeNull();
    expect(branch.signboardPhotoId).not.toBeNull();
    // The photos are wired to their slots and keep their request (provenance).
    const atts = await db.attachment.findMany({ where: { editId: A.id, deletedAt: null } });
    expect(atts.find((a) => a.kind === 'CR')).toMatchObject({ id: customer.crPhotoId, customerId: customer.id });
    expect(atts.find((a) => a.kind === 'SHOP')).toMatchObject({ id: branch.shopPhotoId, branchId: branch.id });
    expect(atts.find((a) => a.kind === 'SIGNBOARD')).toMatchObject({ id: branch.signboardPhotoId, branchId: branch.id });
    const finalize = await auditFor({ entityId: A.id, action: 'FINALIZE' });
    expect(finalize.map((a) => a.actorId)).toEqual([acc1.id]);
    expect(finalize[0]!.after, 'the FINALIZE row records both codes').toMatchObject({ nmwcCode: A.code, temixCode: A.temix });
    const created = await auditFor({ entityId: customer.id, action: 'CREATE' });
    expect(created.map((a) => a.actorId)).toEqual([acc1.id]);
    expect(created[0]!.after).toMatchObject({ nmwcCode: A.code, temixCode: A.temix });
    const steps = await db.editApproval.findMany({ where: { editId: A.id }, orderBy: { at: 'asc' } });
    expect(steps.map((s) => [s.stepIndex, s.role, s.decision])).toEqual([
      [0, 'SUPERVISOR', 'APPROVED'],
      [1, 'ACCOUNTANT', 'APPROVED'],
    ]);

    // The salesman: approved, linked to the new customer. Every active Steward: ready for Temix.
    const fresh = await newRows(A.id, before);
    const toSa = fresh.filter((r) => r.userId === w.user('SA').id);
    expect(toSa.map((r) => [r.kind, r.title, r.body, r.customerId])).toEqual([
      ['EDIT_APPROVED_FINAL', 'New customer approved', `${A.name} is now live as ${A.code}, Temix code ${A.temix}.`, customer.id],
    ]);
    const toStw = fresh.filter((r) => r.userId === w.user('STW').id);
    expect(toStw.map((r) => [r.kind, r.title, r.body, r.customerId])).toEqual([
      [
        'EDIT_APPROVED_FINAL',
        'Ready for Temix upload',
        `${A.name} (${A.code}, Temix code ${A.temix}) was approved and is queued for the next Temix batch.`,
        customer.id,
      ],
    ]);
    for (const k of ['M1', 'M2', 'M3', 'ACC2', 'FM1', 'GM1']) expect(recipients(fresh), `${k} is not told`).not.toContain(w.user(k).id);
    const accRows = (await notificationsFor({ editId: A.id })).filter((r) => r.userId === acc1.id && r.kind === 'EDIT_STAGE_ADVANCED');
    expect(accRows.every((r) => r.readAt), "the Accountant's own must-act row is settled").toBe(true);
    expectNoPii(fresh, [A.phone, A.cr]);
  });

  test('the salesman sees it live: muted bell, the approval opens the customer, its Temix code on its page and in search, Today, Recent activity; the Steward is linked to it', async ({ browser }) => {
    test.skip(!A.customerId, 'needs the customer the Accountant created');
    const sa = w.user('SA');
    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/today');
    // Wave 1: "advanced" and "approved" only inform a salesman — no red count.
    await expect(page.getByRole('link', { name: /^Notifications/ })).toHaveAttribute('aria-label', 'Notifications (2 for information)');
    await expect(page.getByRole('heading', { level: 3, name: A.name, exact: true }), 'on Today: its day is today').toBeVisible();

    await page.goto('/notifications');
    await expect(page.getByText('2 for information', { exact: true })).toBeVisible();
    const approved = page.getByRole('link').filter({ hasText: 'New customer approved' }).filter({ hasText: A.name });
    await expect(approved).toHaveAttribute('href', `/customers/${A.customerId}`);
    // Owner decision 8 Oct: he is told both codes.
    await expect(approved).toContainText(`${A.name} is now live as ${A.code}, Temix code ${A.temix}.`);
    // Written while there was no customer yet: it opens Work.
    await expect(page.getByRole('link').filter({ hasText: 'Request advanced' }).filter({ hasText: A.name })).toHaveAttribute('href', '/work');
    await approved.click();
    await expect(page).toHaveURL(new RegExp(`/customers/${A.customerId}$`));
    await expect(page.getByRole('heading', { level: 1, name: A.name })).toBeVisible();
    await expect(page.getByText(A.code, { exact: true }).first()).toBeVisible();
    // Owner request 10 Oct: the Temix code is on the customer page too, labelled, beside the NMWC code — not
    // only in the alert, which is gone once read.
    await expect(customerRow(page, 'NMWC code')).toHaveText(A.code);
    await expect(customerRow(page, 'Temix code'), 'Temix code <code> on the customer page').toHaveText(A.temix);
    // Critic / wave 1: a chain-created customer reads "requested this new customer", never "submitted 0 change(s)".
    await expect(page.getByText(`${sa.fullName} requested this new customer`, { exact: true })).toBeVisible();
    await expect(page.getByText(/submitted 0 change/)).toHaveCount(0);

    await page.goto(`/customers?q=${encodeURIComponent(A.name)}`);
    await expect(page.getByRole('link', { name: new RegExp(A.name) }).first()).toBeVisible();

    // Owner request 10 Oct: he finds it by its Temix code, typed into the search box as a phone keyboard types it
    // (lower case), and by the start of it. Neither its name nor its NMWC code holds the code: the Temix code finds it.
    expect(A.name.toUpperCase(), 'the name alone cannot match the Temix code').not.toContain(A.temix);
    expect(A.code, 'nor can the NMWC code').not.toContain(A.temix);
    // Typed over a search that finds nothing (the code with more after it is no start of it): A is the only
    // customer on his route, so an unfiltered or not-yet-updated list would show the same card.
    await page.goto(`/customers?q=${encodeURIComponent(`${A.temix}ZZ`)}`);
    await expect(page.getByText('No customers match', { exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search customers' }).fill(A.temix.toLowerCase());
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('q'), 'searched the typed code').toBe(A.temix.toLowerCase());
    const found = page.locator('main article').filter({ has: page.getByRole('heading', { level: 3, name: A.name, exact: true }) });
    await expect(found, 'found by its Temix code').toHaveCount(1);
    // The card says which code found it: it differs from the NMWC code.
    await expect(found.getByText(`Temix code ${A.temix}`, { exact: true })).toBeVisible();
    await expect(found.getByRole('link').first()).toHaveAttribute('aria-label', `${A.name} · ${A.code} · Temix code ${A.temix}`);
    await page.goto(`/customers?q=${encodeURIComponent(A.temix.slice(0, -1))}`);
    await expect(
      page.locator('main article').filter({ has: page.getByRole('heading', { level: 3, name: A.name, exact: true }) }),
      'found by the start of its Temix code'
    ).toHaveCount(1);

    // The Steward's row: EDIT_APPROVED_FINAL with the customer, so it opens the customer (red bell, not /temix).
    const stw = await pageAs(browser, w.user('STW'), 'desktop');
    await stw.goto('/notifications');
    const ready = stw.getByRole('link').filter({ hasText: 'Ready for Temix upload' }).filter({ hasText: A.name });
    await expect(ready).toHaveAttribute('href', `/customers/${A.customerId}`);
    await expect(stw.getByRole('link', { name: /^Notifications/ })).toHaveAttribute('aria-label', /\d+ unread/);
  });

  test('a salesman of another route searching its Temix code finds nothing, as for a code nobody holds', async ({ browser }) => {
    test.skip(!A.customerId, 'needs the customer the Accountant created');
    // Owner request 10 Oct: the Temix code is searched INSIDE the role scope. SA2 is on another route of the
    // same region, SB in the other region: the code must neither show them the customer nor tell them it exists.
    for (const key of ['SA2', 'SB']) {
      const page = await pageAs(browser, w.user(key), 'phone');
      for (const q of [A.temix, `${A.temix}ZZ`]) {
        await page.goto(`/customers?q=${encodeURIComponent(q)}`);
        await expect(page.getByRole('searchbox', { name: 'Search customers' }), `${key} searched ${q}`).toHaveValue(q);
        await expect(page.getByText('No customers match', { exact: true }), `${key}: nothing for ${q}`).toBeVisible();
        await expect(page.getByText('0 total', { exact: true })).toBeVisible();
        await expect(page.locator('main article')).toHaveCount(0);
      }
      await expect404(page, `/customers/${A.customerId}`);
      await page.context().close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CREDIT, through all four steps
// ═════════════════════════════════════════════════════════════════════════════

test.describe('new CREDIT customer, through all four steps', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  const K = { id: '', name: '', cr: '', phone: '', customerId: '' };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccr');
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test('the salesman applies for credit on his phone: the credit block, figures that count as missing, Arabic digits, a fresh guarantee slot', async ({ browser }) => {
    notRunHere(!hasR2, 'the form uploads its photos to R2');
    test.setTimeout(360_000);
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/customers/new');
    await expect(formSection(page, 'Credit application')).toHaveCount(0);
    await page.locator('label').filter({ hasText: /^Credit$/ }).click();
    await expect(page.getByRole('radio', { name: 'Credit' })).toBeChecked();
    const credit = formSection(page, 'Credit application');
    await expect(credit).toBeVisible();
    await expect(
      page.getByText('Credit: approval chain is Supervisor → Finance Manager → GM → Accountant, and a credit application is required below.', {
        exact: true,
      })
    ).toBeVisible();
    await expect(missingList(page)).toContainText('Credit limit, Payment term days, Guarantee document');

    const limit = page.getByLabel('Requested credit limit (OMR) *', { exact: true });
    const days = page.getByLabel('Requested payment term (days) *', { exact: true });
    await limit.fill('12,5');
    await days.fill('0');
    await expect(missingList(page), "a comma decimal is no number: '12,5' counts as missing").toContainText('Credit limit');
    await expect(missingList(page), "'0' days is no term").toContainText('Payment term days');
    // Wave 1: Arabic-Indic digits and the Arabic decimal mark are read as typed.
    await limit.fill('١٢٣٤٫٥');
    await days.fill('45');
    await expect(missingList(page)).not.toContainText('Credit limit');
    await expect(missingList(page)).not.toContainText('Payment term days');
    const guarantees = photoSlot(credit, 'Guarantee doc');
    await expect(guarantees).toHaveCount(1);
    await takePhoto(guarantees.first());
    await expect(guarantees, 'a fresh slot appears for the next document').toHaveCount(2);
    await expect(missingList(page)).not.toContainText('Guarantee document');

    K.name = w.name('Credit House');
    K.cr = uniqueCr(w);
    K.phone = (await w.allocPhones(1))[0]!;
    await fillIdentity(page, { name: K.name, cr: K.cr, phone: K.phone });
    await fillBranch(formSection(page, /^Branch 1\b/));
    await expect(submitButton(page)).toBeEnabled();
    const answer = await sendForm(page, () => submitButton(page).click());
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true, data: { state: 'SUBMITTED' } });
    K.id = answer.data!.editId;
    w.adopt.edit(K.id);
    await expect(page).toHaveURL(/\/work$/);

    const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: K.id }, include: { attachments: true } });
    expect(edit).toMatchObject({ state: 'SUBMITTED', pendingRole: 'SUPERVISOR', currentStepIndex: 0, paymentTermsAtSubmit: 'CREDIT' });
    expect(Number(edit.requestedCreditLimit)).toBe(1234.5);
    expect(edit.requestedPaymentTermDays).toBe(45);
    expect(parseChain(edit.approvalChain).map((s) => [s.role, s.slaHours])).toEqual([
      ['SUPERVISOR', 8],
      ['FINANCE_MANAGER', 16],
      ['GM', 24],
      ['ACCOUNTANT', 9],
    ]);
    expectFreshStage(edit, edit.submittedAt!.getTime(), 8);
    expect(edit.attachments.filter((a) => a.kind === 'GUARANTEE' && !a.deletedAt)).toHaveLength(1);

    const rows = await notificationsFor({ editId: K.id });
    expect(rows.map((r) => `${r.kind}:${r.userId}`).sort()).toEqual(
      [`EDIT_SUBMITTED:${w.user('M1').id}`, `REQUEST_FYI:${w.user('ACC1').id}`].sort()
    );
    expect(rows.find((r) => r.kind === 'EDIT_SUBMITTED')!.body).toBe(`${K.name} — new CREDIT customer request awaiting your review.`);
    expectNothingEmailed(rows);

    // The server holds the same line: a term of 0 days is refused before anything is written.
    const refused = await submitCreateViaApi(page, {
      customer: { legalName: w.name('Zero Term'), paymentTerms: 'CREDIT' },
      credit: { requestedCreditLimit: 100, requestedPaymentTermDays: 0 },
      branches: [{ branchName: 'Main' }],
    });
    expect(refused).toMatchObject({ ok: false, fields: { 'credit.requestedPaymentTermDays': 'Payment term must be at least 1 day.' } });
    expect(await db.editCustomerDraft.count({ where: { legalName: w.name('Zero Term') } })).toBe(0);
  });

  test('the supervisor sends it to the Finance Managers; the card shows the figures and a lock instead of a tick box', async ({ browser }) => {
    test.skip(!K.id, 'needs the credit request');
    const m1 = await pageAs(browser, w.user('M1'), 'desktop');
    await m1.goto('/approvals');
    const card = queueCard(m1, K.name);
    await expect(card).toContainText('New CREDIT customer request');
    await expect(card).toContainText('Requested credit: OMR 1234.500 · 45 days');
    await expect(card.getByRole('img', { name: CREDIT_LOCK })).toBeVisible();
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await openApproval(m1, K.id);
    await expect(temixCodeBox(m1), 'the Temix code box is the Accountant’s alone, at the last step').toHaveCount(0);
    const before = await rowIds(K.id);
    const t0 = Date.now();
    await approveHere(m1, 'Send on to Finance Manager?', 'Approve and send on');
    await expect(m1).toHaveURL(/\/approvals$/);
    const row = await stageOf(K.id);
    expect(row).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 1, pendingRole: 'FINANCE_MANAGER', customerId: null });
    expectFreshStage(row, t0, 16);
    const fresh = await newRows(K.id, before);
    // Every active Finance Manager (real UAT ones too) must act; the salesman is told.
    expect(recipients(fresh)).toEqual(expect.arrayContaining([w.user('FM1').id, w.user('FM2').id, w.user('SA').id]));
    for (const k of ['M1', 'M2', 'M3', 'M5', 'ACC1', 'ACC2', 'GM1', 'STW']) {
      expect(recipients(fresh), `${k} is not told at this step`).not.toContain(w.user(k).id);
    }
    expect(fresh.find((r) => r.userId === w.user('FM1').id)).toMatchObject({
      kind: 'EDIT_STAGE_ADVANCED',
      title: 'Approval waiting on you',
      body: `${K.name} — request advanced to the FINANCE_MANAGER step.`,
    });
    expect(fresh.find((r) => r.userId === w.user('SA').id)).toMatchObject({ title: 'Request advanced' });
    expect(await db.customer.count({ where: { legalName: K.name } })).toBe(0);
  });

  test('a Finance Manager on his phone decides it alone, on its own page; the other FM, whose page went stale, is refused', async ({ browser }) => {
    test.skip(!K.id, 'needs the credit request');
    // FM2 opens it first, then leaves the tab open.
    const fm2 = await pageAs(browser, w.user('FM2'), 'desktop');
    await openApproval(fm2, K.id);

    const fm1 = await pageAs(browser, w.user('FM1'), 'phone');
    await fm1.goto('/approvals');
    await expect(fm1.getByText(CREDIT_QUEUE_NOTE, { exact: true })).toBeVisible();
    // Every card at the FM step, org-wide, is a credit application: no Select all.
    await expect(fm1.getByText('Select all', { exact: true })).toHaveCount(0);
    const card = queueCard(fm1, K.name);
    await expect(card.getByRole('img', { name: CREDIT_LOCK })).toBeVisible();
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await expect(card).toContainText('Requested credit: OMR 1234.500 · 45 days');
    await card.getByRole('link').click();
    await expect(fm1.getByRole('heading', { level: 2, name: 'Credit application (requested — approve or reject, no amendment)' })).toBeVisible();
    await expect(fm1.getByText('OMR 1234.500', { exact: true })).toBeVisible();
    await expect(fm1.getByText('45 days', { exact: true })).toBeVisible();
    await expect(fm1.getByText('Guarantee documents (1)', { exact: true })).toBeVisible();
    const g = await db.attachment.findFirstOrThrow({ where: { editId: K.id, kind: 'GUARANTEE', deletedAt: null } });
    await expectPhotoServed(fm1, g.id, true);
    await expect(fm1.locator('main input, main textarea, main select'), 'nothing on the page can change the figures').toHaveCount(0);
    await expect(temixCodeBox(fm1), 'the Temix code box is the Accountant’s alone, at the last step').toHaveCount(0);

    const before = await rowIds(K.id);
    const steps = await db.editApproval.count({ where: { editId: K.id } });
    const t0 = Date.now();
    await approveHere(fm1, 'Send on to GM?', 'Approve and send on');
    await expect(fm1).toHaveURL(/\/approvals$/);
    const row = await stageOf(K.id);
    expect(row).toMatchObject({ currentStepIndex: 2, pendingRole: 'GM' });
    expectFreshStage(row, t0, 24);
    expect(await db.editApproval.count({ where: { editId: K.id } })).toBe(steps + 1);

    // FIN-16: FM2's page still shows the FM step. The request has moved to a step he cannot decide: refused, nothing written.
    const frozen = await snapshot(['CustomerEdit'], { id: K.id });
    await approveHere(fm2, 'Send on to GM?', 'Approve and send on');
    await expect(fm2.getByText(new RegExp(`${escapeRe(NOT_AUTHORIZED)}|${escapeRe(STALE_VIEW)}`))).toBeVisible();
    expect(await snapshot(['CustomerEdit'], { id: K.id })).toBe(frozen);
    expect(await db.editApproval.count({ where: { editId: K.id } })).toBe(steps + 1);
    await fm2.reload();
    await expect(fm2.getByRole('note')).toContainText('For your information: this request is waiting at the GM step, which you cannot decide.');
    await fm2.goto('/approvals');
    await expect(queueCard(fm2, K.name), "FM2's queue drops it").toHaveCount(0);

    // Every active GM must act now. Wave 2: the GM's row at his step is e-mailed (an outbox row the drain would send).
    const fresh = await newRows(K.id, before);
    expect(recipients(fresh)).toEqual(expect.arrayContaining([w.user('GM1').id, w.user('SA').id]));
    expect(recipients(fresh)).not.toContain(w.user('FM1').id);
    const toGm = fresh.find((r) => r.userId === w.user('GM1').id)!;
    expect(toGm).toMatchObject({ kind: 'EDIT_STAGE_ADVANCED', title: 'Approval waiting on you', body: `${K.name} — request advanced to the GM step.` });
    expect(await emailVerdictFor(toGm.id), 'the GM is e-mailed work waiting on him').toEqual({ send: true, status: null });
    const fmRows = (await notificationsFor({ editId: K.id })).filter((r) => r.userId === w.user('FM1').id || r.userId === w.user('FM2').id);
    expect(fmRows.every((r) => r.readAt), "both FMs' rows are settled by FM1's decision").toBe(true);
  });

  test('the GM on his phone sends it on to the region Accountant only', async ({ browser }) => {
    test.skip(!K.id, 'needs the credit request');
    const gm = await pageAs(browser, w.user('GM1'), 'phone');
    await gm.goto('/approvals');
    await expect(queueCard(gm, K.name).getByRole('img', { name: CREDIT_LOCK })).toBeVisible();
    await openApproval(gm, K.id);
    await expect(temixCodeBox(gm), 'the Temix code box is the Accountant’s alone, at the last step').toHaveCount(0);
    const before = await rowIds(K.id);
    const t0 = Date.now();
    await approveHere(gm, 'Send on to Accountant?', 'Approve and send on');
    await expect(gm).toHaveURL(/\/approvals$/);
    const row = await stageOf(K.id);
    expect(row).toMatchObject({ currentStepIndex: 3, pendingRole: 'ACCOUNTANT' });
    expectFreshStage(row, t0, 9);
    const fresh = await newRows(K.id, before);
    expect(recipients(fresh)).toEqual([w.user('ACC1').id, w.user('SA').id].sort());
    const gmRow = (await notificationsFor({ editId: K.id })).find((r) => r.userId === w.user('GM1').id)!;
    expect(gmRow.readAt, "the GM's own row is settled").not.toBeNull();
    expect((await emailVerdictFor(gmRow.id)).send, 'a settled row is never e-mailed').toBe(false);
    expect(await db.customer.count({ where: { legalName: K.name } })).toBe(0);
  });

  test('the Accountant creates the CREDIT customer with the requested figures; the CR document is then locked for the salesman', async ({ browser }) => {
    test.skip(!K.id, 'needs the credit request');
    const acc1 = w.user('ACC1');
    const page = await pageAs(browser, acc1, 'desktop');
    await openApproval(page, K.id);
    const before = await rowIds(K.id);
    const temix = temixCodeFor(w);
    await createHere(page, K.id, temix);
    const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: K.id } });
    expect(edit).toMatchObject({ state: 'APPROVED', pendingRole: null });
    const customer = await db.customer.findUniqueOrThrow({ where: { id: edit.customerId! } });
    K.customerId = customer.id;
    expect(customer.nmwcCode).toMatch(codeRe());
    expect(customer).toMatchObject({ paymentTerms: 'CREDIT', paymentTermDays: 45, temixSyncState: 'PENDING_UPLOAD', temixCode: temix });
    expect(Number(customer.creditLimit), 'exactly as requested, never amended').toBe(1234.5);
    const g = await db.attachment.findFirstOrThrow({ where: { editId: K.id, kind: 'GUARANTEE' } });
    expect(g.customerId, 'the guarantee is bound to the customer').toBe(customer.id);
    const steps = await db.editApproval.findMany({ where: { editId: K.id }, orderBy: { at: 'asc' } });
    expect(steps.map((s) => [s.stepIndex, s.role, s.decision, s.actorId])).toEqual([
      [0, 'SUPERVISOR', 'APPROVED', w.user('M1').id],
      [1, 'FINANCE_MANAGER', 'APPROVED', w.user('FM1').id],
      [2, 'GM', 'APPROVED', w.user('GM1').id],
      [3, 'ACCOUNTANT', 'APPROVED', acc1.id],
    ]);
    expect(new Set(steps.map((s) => s.actorId)).size, 'four different people').toBe(4);
    const fresh = await newRows(K.id, before);
    expect(fresh.find((r) => r.userId === w.user('SA').id)).toMatchObject({
      kind: 'EDIT_APPROVED_FINAL',
      title: 'New customer approved',
      body: `${K.name} is now live as ${customer.nmwcCode}, Temix code ${temix}.`,
    });
    expect(fresh.find((r) => r.userId === w.user('STW').id)).toMatchObject({ kind: 'EDIT_APPROVED_FINAL', title: 'Ready for Temix upload' });
    expectNoPii(await notificationsFor({ editId: K.id }), [K.phone, K.cr]);

    for (const k of ['FM1', 'FM2', 'GM1']) {
      const p = await pageAs(browser, w.user(k), 'desktop');
      await p.goto('/approvals');
      await expect(queueCard(p, K.name), `${k}'s queue`).toHaveCount(0);
    }

    // Wave 2 (owner decision 2): the CR document of a CREDIT customer is the manager's or the Steward's to change.
    const sa = await pageAs(browser, w.user('SA'), 'phone');
    await sa.goto(`/customers/${K.customerId}`);
    const res = await postJson(sa, '/api/photos/detach', { attachmentId: customer.crPhotoId });
    const out = (await res.json()) as { ok: boolean; message?: string };
    expect(out).toMatchObject({ ok: false, message: CR_LOCKED });
    const cr = await db.attachment.findUniqueOrThrow({ where: { id: customer.crPhotoId! } });
    expect(cr.deletedAt).toBeNull();
    expect((await db.customer.findUniqueOrThrow({ where: { id: K.customerId } })).crPhotoId).toBe(customer.crPhotoId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Region scope of the Accountant (and the Manager)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('an Accountant sees and decides only his own region', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let w: World;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccs');
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test("another region's request never reaches ACC1, before or after it is created; ACC2 creates it; M5 is gated the same way", async ({ browser }) => {
    notRunHere(!hasR2, 'the requests carry R2 photos');
    test.setTimeout(300_000);
    const sb = await pageAs(browser, w.user('SB'), 'phone');
    await sb.goto('/today');
    const nameB = w.name('Bawshar Retail');
    const sent = await submitCreateRequestViaApi(sb, w, { legalName: nameB });
    expect(sent.answer, JSON.stringify(sent.answer)).toMatchObject({ ok: true });
    const idB = sent.editId!;
    const shopB = sent.photos.branches[0]!.shop!;
    const r1 = await seedCreateRequest(w, { submitter: 'SA' });

    // M5 decides his region's request; an R1 request is not his to see.
    const m5 = await pageAs(browser, w.user('M5'), 'desktop');
    await m5.goto('/approvals');
    await expect(queueCard(m5, nameB)).toBeVisible();
    await expect(queueCard(m5, r1.legalName)).toHaveCount(0);
    await openApproval(m5, idB);
    await approveHere(m5, 'Send on to Accountant?', 'Approve and send on');
    await expect(m5).toHaveURL(/\/approvals$/);
    await expect404(m5, `/approvals/${r1.id}`);

    const acc1 = await pageAs(browser, w.user('ACC1'), 'desktop');
    await acc1.goto('/approvals');
    await expect(acc1.getByText('Nothing pending', { exact: true })).toBeVisible();
    expect(await pendingCount(acc1)).toBe(0);
    await acc1.goto('/work');
    await expect(acc1.getByText(nameB)).toHaveCount(0);
    await expect404(acc1, `/approvals/${idB}`);
    expect((await fetchAs(acc1, `/api/photos/${shopB}`)).status, "the other region's shop photo").toBe(404);
    expect((await notificationsFor({ editId: idB })).map((n) => n.userId)).not.toContain(w.user('ACC1').id);

    const acc2 = await pageAs(browser, w.user('ACC2'), 'desktop');
    await acc2.goto('/approvals');
    await queueCard(acc2, nameB).getByRole('link').click();
    await expect(acc2).toHaveURL(new RegExp(`/approvals/${idB}$`));
    await createHere(acc2, idB, temixCodeFor(w));
    const customerB = await db.customer.findFirstOrThrow({ where: { legalName: nameB }, include: { branches: true } });
    expect(customerB.branches.map((b) => b.regionId)).toEqual([w.region('R2').id]);

    await acc1.goto(`/customers?q=${encodeURIComponent(nameB)}`);
    await expect(acc1.getByText('No customers match', { exact: true })).toBeVisible();
    await expect(acc1.getByText('0 total', { exact: true })).toBeVisible();
    // The search chip echoes the typed name ("Search: …"); no row or link names the customer.
    await expect(acc1.locator(`a[href^="/customers/${customerB.id}"]`)).toHaveCount(0);
    await expect(acc1.getByRole('main').getByRole('link').filter({ hasText: nameB })).toHaveCount(0);
    await expect404(acc1, `/customers/${customerB.id}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Credit, and a new customer at the Accountant step, is never bulk-approved
// ═════════════════════════════════════════════════════════════════════════════

test.describe('a credit application, and a new customer at its last step, is never bulk-approved', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  const S: Record<string, SeededCreate> = {};

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccb');
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test("Select all leaves the credit card out; a crafted bulk approve carrying a credit id is refused at every step", async ({ browser }) => {
    notRunHere(!hasR2, 'the seeded requests carry R2 photos');
    test.setTimeout(420_000);
    // At the Accountant: two cash, one credit. At the FM, the GM: one credit each. At the Supervisor: one credit, two cash.
    S.c1 = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name('Bulk Cash One') });
    S.c2 = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name('Bulk Cash Two') });
    S.k1 = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 3, approvedBy: ['M1', 'FM1', 'GM1'], legalName: w.name('Credit At Acc') });
    S.k2 = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 1, approvedBy: ['M1'], legalName: w.name('Credit At Fm') });
    S.k3 = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 2, approvedBy: ['M1', 'FM2'], legalName: w.name('Credit At Gm') });
    S.k4 = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', legalName: w.name('Credit At Sup') });
    S.c3 = await seedCreateRequest(w, { submitter: 'SA', legalName: w.name('Sup Cash Three') });
    S.c4 = await seedCreateRequest(w, { submitter: 'SA', legalName: w.name('Sup Cash Four') });

    const m1 = await pageAs(browser, w.user('M1'), 'desktop');
    await m1.goto('/approvals');
    const k4 = queueCard(m1, S.k4.legalName);
    await expect(k4.getByRole('img', { name: CREDIT_LOCK })).toBeVisible();
    await expect(k4.getByRole('checkbox')).toHaveCount(0);
    await expect(m1.getByText(CREDIT_QUEUE_NOTE, { exact: true })).toBeVisible();
    await m1.getByLabel('Select up to 50 on this page').check();
    await expect(m1.getByText('2 selected', { exact: true }).first()).toBeVisible();
    for (const k of ['c3', 'c4']) await expect(m1.getByRole('checkbox', { name: `Select edit for ${S[k]!.legalName}` })).toBeChecked();

    // M1's bulk approve, captured (aborted in the browser: it never ran).
    await m1.getByRole('button', { name: '✓ Approve 2' }).click();
    const dialog = m1.getByRole('dialog', { name: 'Approve 2 edits?' });
    const action = await captureServerAction(m1, () => dialog.getByRole('button', { name: 'Approve 2', exact: true }).click());
    await m1.close();

    // Replayed with ONE credit id and its fresh token, by the approver of its step.
    const ids = Object.values(S).map((s) => s.id);
    const untouched = await snapshot(['CustomerEdit'], { id: { in: ids } });
    const ledger = await db.editApproval.count({ where: { editId: { in: ids } } });
    for (const [key, user] of [
      ['k4', 'M1'],
      ['k2', 'FM1'],
      ['k3', 'GM1'],
      ['k1', 'ACC1'],
    ] as const) {
      const id = S[key]!.id;
      const decisions = JSON.stringify([{ editId: id, decisionToken: await decisionTokenNow(id) }]);
      const ctx = await contextAs(browser, w.user(user), { device: 'desktop' });
      const r = await replayServerAction(ctx.request, action, {
        mutateBody: (b) => rewriteActionForm(b, action.headers['content-type'] ?? '', { set: { decisions } }),
      });
      expect(r.notFound, r.text.slice(0, 300)).toBe(false);
      expect(r.text, `${user} at ${key}'s step`).toContain(CREDIT_ONE_AT_A_TIME);
    }
    expect(await snapshot(['CustomerEdit'], { id: { in: ids } }), 'no state changed').toBe(untouched);
    expect(await db.editApproval.count({ where: { editId: { in: ids } } }), 'no decision row').toBe(ledger);
    expect(await db.customer.count({ where: { legalName: { in: Object.values(S).map((s) => s.legalName) } } }), 'no customer').toBe(0);
  });

  test('the Finance Manager and the GM: a lock on the credit card, no tick box, no Select all', async ({ browser }) => {
    test.skip(!S.k2, 'needs the seeded requests');
    for (const [user, key] of [
      ['FM1', 'k2'],
      ['GM1', 'k3'],
    ] as const) {
      const p = await pageAs(browser, w.user(user), 'phone');
      await p.goto('/approvals');
      const card = queueCard(p, S[key]!.legalName);
      await expect(card.getByRole('img', { name: CREDIT_LOCK })).toBeVisible();
      await expect(card.getByRole('checkbox')).toHaveCount(0);
      await expect(p.getByText('Select all', { exact: true }), `${user}: every card at this step is credit`).toHaveCount(0);
      await expect(p.getByText(CREDIT_QUEUE_NOTE, { exact: true })).toBeVisible();
    }
  });

  test('the supervisor reopening a credit now at the FM step reads it but cannot decide it', async ({ browser }) => {
    test.skip(!S.k2, 'needs the seeded requests');
    const m1 = await pageAs(browser, w.user('M1'), 'desktop');
    await openApproval(m1, S.k2!.id);
    await expect(m1.getByRole('note')).toContainText(
      'For your information: this request is waiting at the FINANCE MANAGER step, which you cannot decide.'
    );
    const frozen = await snapshot(['CustomerEdit'], { id: S.k2!.id });
    await approveHere(m1, 'Send on to GM?', 'Approve and send on');
    await expect(m1.getByText(NOT_AUTHORIZED, { exact: true })).toBeVisible();
    expect(await snapshot(['CustomerEdit'], { id: S.k2!.id })).toBe(frozen);
  });

  test('owner decision 8 Oct: the Accountant cannot bulk-approve the two cash requests either — a lock on each, a crafted bulk approve is refused; each is created from its own page with its own Temix code, codes in order; the credit stays at his step', async ({ browser }) => {
    test.skip(!S.k1, 'needs the seeded requests');
    test.setTimeout(300_000);
    const acc1 = await pageAs(browser, w.user('ACC1'), 'desktop');
    await acc1.goto('/approvals');
    await expect(queueCard(acc1, S.k1!.legalName).getByRole('img', { name: CREDIT_LOCK })).toBeVisible();
    for (const k of ['c1', 'c2']) {
      const card = queueCard(acc1, S[k]!.legalName);
      const lock = card.getByRole('img', { name: TEMIX_LOCK_LABEL });
      await expect(lock, `${k}: a lock instead of a tick box`).toBeVisible();
      await expect(lock).toHaveAttribute('title', TEMIX_CODE_BULK_REFUSED_MESSAGE);
      await expect(card.getByRole('checkbox')).toHaveCount(0);
    }
    await expect(acc1.getByText(TEMIX_LOCK_NOTE, { exact: true })).toBeVisible();
    await expect(acc1.getByLabel('Select up to 50 on this page'), 'every card at his step is locked: no Select all').toHaveCount(0);

    // A bulk approve captured from M1's queue (two cash requests at the Supervisor step; aborted in the browser),
    // replayed by ACC1 with ONE cash id at his step and its fresh token: refused, nothing written.
    const m1 = await pageAs(browser, w.user('M1'), 'desktop');
    await m1.goto('/approvals');
    await m1.getByLabel('Select up to 50 on this page').check();
    await m1.getByRole('button', { name: '✓ Approve 2' }).click();
    const action = await captureServerAction(m1, () =>
      m1.getByRole('dialog', { name: 'Approve 2 edits?' }).getByRole('button', { name: 'Approve 2', exact: true }).click()
    );
    await m1.close();
    const ids = Object.values(S).map((s) => s.id);
    const untouched = await snapshot(['CustomerEdit'], { id: { in: ids } });
    const ledger = await db.editApproval.count({ where: { editId: { in: ids } } });
    const decisions = JSON.stringify([{ editId: S.c1!.id, decisionToken: await decisionTokenNow(S.c1!.id) }]);
    const ctx = await contextAs(browser, w.user('ACC1'), { device: 'desktop' });
    const r = await replayServerAction(ctx.request, action, {
      mutateBody: (b) => rewriteActionForm(b, action.headers['content-type'] ?? '', { set: { decisions } }),
    });
    expect(r.notFound, r.text.slice(0, 300)).toBe(false);
    expect(r.text, 'ACC1 at c1’s step').toContain(TEMIX_CODE_BULK_REFUSED_MESSAGE);
    expect(await snapshot(['CustomerEdit'], { id: { in: ids } }), 'no state changed').toBe(untouched);
    expect(await db.editApproval.count({ where: { editId: { in: ids } } }), 'no decision row').toBe(ledger);
    expect(await db.customer.count({ where: { legalName: { in: [S.c1!.legalName, S.c2!.legalName] } } }), 'no customer').toBe(0);

    // One at a time, each from its own page with its own Temix code.
    const seqBefore = await codeSequenceNext();
    const codes: string[] = [];
    for (const k of ['c1', 'c2']) {
      await acc1.goto('/approvals');
      await queueCard(acc1, S[k]!.legalName).getByRole('link').click();
      await expect(acc1).toHaveURL(new RegExp(`/approvals/${S[k]!.id}$`));
      codes.push(await createHere(acc1, S[k]!.id, temixCodeFor(w)));
    }
    expectCodesInOrder(codes, seqBefore, await codeSequenceNext());
    expect(await stageOf(S.k1!.id)).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 3, pendingRole: 'ACCOUNTANT', customerId: null });
    await acc1.goto('/approvals');
    await expect(queueCard(acc1, S.k1!.legalName)).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Rejections: one approver back at a time, the loop guard, the correction round
// ═════════════════════════════════════════════════════════════════════════════

test.describe('rejections step back one approver at a time', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let w: World;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccj');
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test('cash: the Accountant sends it back to the Supervisor step, then to the salesman; he corrects the same request; a page from the old round is refused', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    test.setTimeout(600_000);
    const [sa, m1, m3, acc1] = [w.user('SA'), w.user('M1'), w.user('M3'), w.user('ACC1')];
    // At the Accountant, approved by M2, with an escalation from a stage long gone (the next move must reset it).
    const X = await seedCreateRequest(w, {
      submitter: 'SA',
      step: 1,
      approvedBy: ['M2'],
      legalName: w.name('Stepback Stores'),
      stageEnteredAt: new Date(Date.now() - 3 * 86_400_000),
      escalationLevel: 1,
      slaBreachedAt: new Date(Date.now() - 86_400_000),
    });
    const accCtx = await contextAs(browser, acc1, { device: 'desktop' });
    const stale = await accCtx.newPage();
    await openApproval(stale, X.id); // kept open from the first round

    await test.step('ACC1 sends it back to the Supervisor step: a fresh clock, only the direct supervisor told', async () => {
      const page = await accCtx.newPage();
      await openApproval(page, X.id);
      const before = await rowIds(X.id);
      const t0 = Date.now();
      await rejectHere(page, {
        label: 'Reason for the Supervisor *',
        button: '✗ Send back to Supervisor',
        category: 'wrong_info',
        quick: 'CR number does not match the photo',
      });
      await expect(page).toHaveURL(/\/approvals$/);
      const row = await stageOf(X.id);
      expect(row).toMatchObject({
        state: 'SUBMITTED',
        currentStepIndex: 0,
        pendingRole: 'SUPERVISOR',
        decisionReason: 'CR number does not match the photo',
        decisionCategory: 'wrong_info',
        reviewedById: acc1.id,
        customerId: null,
      });
      expectFreshStage(row, t0, 8);
      const rejected = await db.editApproval.findFirstOrThrow({ where: { editId: X.id, decision: 'REJECTED' } });
      expect(rejected).toMatchObject({ stepIndex: 1, role: 'ACCOUNTANT', actorId: acc1.id, reason: 'CR number does not match the photo' });
      const fresh = await newRows(X.id, before);
      expect(fresh.map((r) => [r.userId, r.title]).sort()).toEqual(
        [
          [m1.id, 'Request returned to your step'],
          [sa.id, 'Request stepped back'],
        ].sort()
      );
      expect(fresh.find((r) => r.userId === m1.id)!.body).toBe(
        `${X.legalName} — rejected at the ACCOUNTANT step and returned to SUPERVISOR for re-review.`
      );
      expect(fresh.find((r) => r.userId === sa.id)!.body).toBe(`${X.legalName} — sent back one step for re-review (not returned to you).`);
      for (const k of ['M1', 'M2', 'M3']) {
        const p = await pageAs(browser, w.user(k), 'desktop');
        await p.goto('/approvals');
        await expect(queueCard(p, X.legalName), `back in ${k}'s queue`).toBeVisible();
      }
    });

    await test.step('M3 reads why, re-approves; the Accountant’s second rejection in the round goes to the salesman', async () => {
      const page = await pageAs(browser, m3, 'desktop');
      await openApproval(page, X.id);
      await expect(page.locator('li').filter({ hasText: 'REJECTED at ACCOUNTANT step' })).toContainText(
        `REJECTED at ACCOUNTANT step by ${acc1.fullName} — “CR number does not match the photo”`
      );
      await expect(page.locator('li').filter({ hasText: 'APPROVED at SUPERVISOR step' })).toContainText(`by ${w.user('M2').fullName}`);
      // At the first step a rejection goes to the salesman.
      await page.getByRole('button', { name: '✗ Reject', exact: true }).click();
      await expect(page.getByText('Reason for the salesman *', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '✗ Send back to salesman', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await approveHere(page, 'Send on to Accountant?', 'Approve and send on');
      await expect(page).toHaveURL(/\/approvals$/);

      const acc = await accCtx.newPage();
      await openApproval(acc, X.id);
      const before = await rowIds(X.id);
      await rejectHere(acc, {
        label: 'Reason for the salesman *',
        button: '✗ Send back to salesman',
        category: 'wrong_info',
        quick: 'Phone number format is incorrect',
      });
      await expect(acc).toHaveURL(/\/approvals$/);
      const row = await stageOf(X.id);
      expect(row).toMatchObject({
        state: 'NEEDS_CORRECTION',
        pendingRole: null,
        slaDueAt: null,
        currentStepIndex: 0,
        decisionReason: 'Phone number format is incorrect',
        reviewedById: acc1.id,
      });
      const fresh = await newRows(X.id, before);
      expect(fresh.map((r) => [r.userId, r.kind, r.title, r.body])).toEqual([
        [sa.id, 'EDIT_NEEDS_CORRECTION', 'Needs correction', `${X.legalName} — returned to you: Phone number format is incorrect`],
      ]);
    });

    await test.step('the salesman opens it from his bell, corrects it, sends the SAME request again', async () => {
      const page = await pageAs(browser, sa, 'phone');
      // The Today tile (the sidebar holds a /rejected link too).
      const needsCorrection = page.locator('main a[href="/rejected"]').filter({ hasText: 'Needs correction' });
      await page.goto('/today');
      await expect(needsCorrection, "Today's Needs-correction tile counts it").toHaveText(/^\s*1\s*Needs correction\s*$/);
      await page.goto('/notifications');
      const row = page.getByRole('link').filter({ hasText: 'Needs correction' }).filter({ hasText: X.legalName });
      await expect(row).toHaveAttribute('href', '/work');
      await row.click();
      await expect(page).toHaveURL(/\/work$/);
      const item = page.getByRole('link').filter({ hasText: X.legalName });
      await expect(item).toContainText('New customer — needs correction');
      await expect(item).toContainText('Phone number format is incorrect');
      await item.click();
      await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${X.id}$`));
      await expect(page.getByText(RETURNED_PREFIX, { exact: true }).locator('xpath=..')).toContainText(
        `${RETURNED_PREFIX} Phone number format is incorrect`
      );
      await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(X.legalName);
      await expect(photoSlot(formSection(page, 'Identity'), 'CR document').locator('label[aria-label="Retake photo"]')).toBeVisible();
      const branch = formSection(page, /^Branch 1\b/);
      for (const p of ['Shop front', 'Signboard']) await expect(photoSlot(branch, p).locator('label[aria-label="Retake photo"]')).toBeVisible();
      await page.getByLabel('Contact person *', { exact: true }).fill('Khalid Al Rawahi');
      const fyiBefore = (await notificationsFor({ editId: X.id })).filter((n) => n.kind === 'REQUEST_FYI').length;
      const answer = await sendForm(page, () => submitButton(page).click());
      expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true, data: { editId: X.id, state: 'SUBMITTED' } });
      await expect(page).toHaveURL(/\/work$/);
      const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: X.id }, include: { customerDraft: true } });
      expect(edit).toMatchObject({
        state: 'SUBMITTED',
        cycle: 2,
        currentStepIndex: 0,
        pendingRole: 'SUPERVISOR',
        decisionReason: null,
        decisionCategory: null,
        reviewedById: null,
        reviewedAt: null,
        escalationLevel: 0,
      });
      expect(parseChain(edit.approvalChain).map((s) => s.role)).toEqual(['SUPERVISOR', 'ACCOUNTANT']);
      expect(edit.customerDraft!.contactPerson).toBe('Khalid Al Rawahi');
      const fyiAfter = (await notificationsFor({ editId: X.id })).filter((n) => n.kind === 'REQUEST_FYI' && n.userId === acc1.id).length;
      expect(fyiAfter, 'a new FYI to the Accountant').toBe(fyiBefore + 1);
      await page.goto('/today');
      await expect(needsCorrection, 'answered: it leaves the tile').toHaveText(/^\s*0\s*Needs correction\s*$/);
    });

    await test.step('M1 approves round 2; the Accountant’s tab from round 1 is refused; a captured approve without its token is refused', async () => {
      const page = await pageAs(browser, m1, 'desktop');
      await openApproval(page, X.id);
      await approveHere(page, 'Send on to Accountant?', 'Approve and send on');
      await expect(page).toHaveURL(/\/approvals$/);
      expect(await stageOf(X.id)).toMatchObject({ cycle: 2, currentStepIndex: 1, pendingRole: 'ACCOUNTANT' });

      const frozen = await snapshot(['CustomerEdit'], { id: X.id });
      const ledger = await db.editApproval.count({ where: { editId: X.id } });
      // The round-1 page, with a valid Temix code typed: still refused as stale, nothing written.
      await typeTemixCode(stale, temixCodeFor(w));
      await approveHere(stale, 'Create this customer?', 'Approve and create');
      await expect(stale.getByText(STALE_VIEW, { exact: true })).toBeVisible();
      expect(await snapshot(['CustomerEdit'], { id: X.id })).toBe(frozen);
      expect(await db.editApproval.count({ where: { editId: X.id } })).toBe(ledger);

      const capture = await accCtx.newPage();
      await openApproval(capture, X.id);
      await typeTemixCode(capture, temixCodeFor(w));
      await capture.getByRole('button', { name: '✓ Approve', exact: true }).click();
      const dialog = capture.getByRole('dialog', { name: 'Create this customer?' });
      const action = await captureServerAction(capture, () => dialog.getByRole('button', { name: 'Approve and create', exact: true }).click());
      await capture.close();
      const r = await replayServerAction(accCtx.request, action, {
        mutateBody: (b) => rewriteActionForm(b, action.headers['content-type'] ?? '', { drop: ['decisionToken'] }),
      });
      expect(r, r.text.slice(0, 300)).toMatchObject({ refused: true, notFound: false, message: MISSING_TOKEN });
      expect(await snapshot(['CustomerEdit'], { id: X.id })).toBe(frozen);

      const fresh = await accCtx.newPage();
      await openApproval(fresh, X.id);
      await createHere(fresh, X.id, temixCodeFor(w));
      expect(await stageOf(X.id)).toMatchObject({ state: 'APPROVED' });
    });
  });

  test('credit: each rejection moves it back exactly one step on a fresh clock; a stale FM page is refused; the GM’s second rejection goes to the salesman', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    test.setTimeout(600_000);
    const [m1, fm1, gm1] = [w.user('M1'), w.user('FM1'), w.user('GM1')];
    const Y = await seedCreateRequest(w, {
      submitter: 'SA',
      paymentTerms: 'CREDIT',
      step: 1,
      approvedBy: ['M1'],
      legalName: w.name('Cascade Credit'),
      stageEnteredAt: new Date(Date.now() - 4 * 86_400_000),
      escalationLevel: 2,
      slaBreachedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const fm2 = await pageAs(browser, w.user('FM2'), 'desktop');
    await openApproval(fm2, Y.id); // FM step, first visit

    await test.step('FM1 rejects at the FM step: back to the Supervisor step', async () => {
      const page = await pageAs(browser, fm1, 'desktop');
      await openApproval(page, Y.id);
      const before = await rowIds(Y.id);
      const t0 = Date.now();
      await rejectHere(page, { label: 'Reason for the Supervisor *', button: '✗ Send back to Supervisor', reason: 'Guarantee amount does not cover the limit' });
      await expect(page).toHaveURL(/\/approvals$/);
      const row = await stageOf(Y.id);
      expect(row).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 0, pendingRole: 'SUPERVISOR' });
      expectFreshStage(row, t0, 8);
      const fresh = await newRows(Y.id, before);
      expect(fresh.filter((r) => r.title === 'Request returned to your step').map((r) => r.userId)).toEqual([m1.id]);
    });

    await test.step('M1 approves again: back at the FM step, and FM2’s page from the first visit is refused', async () => {
      const page = await pageAs(browser, m1, 'desktop');
      await openApproval(page, Y.id);
      const t0 = Date.now();
      await approveHere(page, 'Send on to Finance Manager?', 'Approve and send on');
      await expect(page).toHaveURL(/\/approvals$/);
      const row = await stageOf(Y.id);
      expect(row).toMatchObject({ currentStepIndex: 1, pendingRole: 'FINANCE_MANAGER' });
      expectFreshStage(row, t0, 16);
      const frozen = await snapshot(['CustomerEdit'], { id: Y.id });
      await approveHere(fm2, 'Send on to GM?', 'Approve and send on');
      await expect(fm2.getByText(STALE_VIEW, { exact: true }), 'FIN-16: a stale view, nothing written').toBeVisible();
      expect(await snapshot(['CustomerEdit'], { id: Y.id })).toBe(frozen);
    });

    await test.step('FM1 approves; the GM sends it back to the Finance Managers', async () => {
      const page = await pageAs(browser, fm1, 'desktop');
      await openApproval(page, Y.id);
      let t0 = Date.now();
      await approveHere(page, 'Send on to GM?', 'Approve and send on');
      await expect(page).toHaveURL(/\/approvals$/);
      expectFreshStage(await stageOf(Y.id), t0, 24);

      const gm = await pageAs(browser, gm1, 'desktop');
      await openApproval(gm, Y.id);
      const before = await rowIds(Y.id);
      t0 = Date.now();
      await rejectHere(gm, {
        label: 'Reason for the Finance Manager *',
        button: '✗ Send back to Finance Manager',
        reason: 'Recheck the payment history first',
      });
      await expect(gm).toHaveURL(/\/approvals$/);
      const row = await stageOf(Y.id);
      expect(row).toMatchObject({ currentStepIndex: 1, pendingRole: 'FINANCE_MANAGER' });
      expectFreshStage(row, t0, 16);
      const back = (await newRows(Y.id, before)).filter((r) => r.title === 'Request returned to your step').map((r) => r.userId);
      expect(back, 'every active Finance Manager is asked again').toEqual(expect.arrayContaining([fm1.id, w.user('FM2').id]));
    });

    await test.step('FM1 approves again; the GM’s second rejection in the round goes to the salesman; no customer ever', async () => {
      const page = await pageAs(browser, fm1, 'desktop');
      await openApproval(page, Y.id);
      await approveHere(page, 'Send on to GM?', 'Approve and send on');
      await expect(page).toHaveURL(/\/approvals$/);
      const gm = await pageAs(browser, gm1, 'phone');
      await openApproval(gm, Y.id);
      await rejectHere(gm, { label: 'Reason for the salesman *', button: '✗ Send back to salesman', reason: 'Limit too high for a new shop' });
      await expect(gm).toHaveURL(/\/approvals$/);
      expect(await stageOf(Y.id)).toMatchObject({ state: 'NEEDS_CORRECTION', pendingRole: null, slaDueAt: null, customerId: null });
      const history = await db.editApproval.findMany({ where: { editId: Y.id }, orderBy: { at: 'asc' } });
      expect(history.map((h) => [h.stepIndex, h.role, h.decision])).toEqual([
        [0, 'SUPERVISOR', 'APPROVED'],
        [1, 'FINANCE_MANAGER', 'REJECTED'],
        [0, 'SUPERVISOR', 'APPROVED'],
        [1, 'FINANCE_MANAGER', 'APPROVED'],
        [2, 'GM', 'REJECTED'],
        [1, 'FINANCE_MANAGER', 'APPROVED'],
        [2, 'GM', 'REJECTED'],
      ]);
      expect(history.filter((h) => h.decision === 'REJECTED').every((h) => !!h.reason)).toBe(true);
      expect(await db.customer.count({ where: { legalName: Y.legalName } })).toBe(0);
    });
  });

  test('credit at the Accountant: his rejection returns it to the GM step on a fresh clock', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    const Z = await seedCreateRequest(w, {
      submitter: 'SA',
      paymentTerms: 'CREDIT',
      step: 3,
      approvedBy: ['M1', 'FM1', 'GM1'],
      legalName: w.name('Credit Back To Gm'),
    });
    const page = await pageAs(browser, w.user('ACC1'), 'desktop');
    await openApproval(page, Z.id);
    const t0 = Date.now();
    await rejectHere(page, { label: 'Reason for the GM *', button: '✗ Send back to GM', reason: 'The guarantee is not signed' });
    await expect(page).toHaveURL(/\/approvals$/);
    const row = await stageOf(Z.id);
    expect(row).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 2, pendingRole: 'GM' });
    expectFreshStage(row, t0, 24);
    const toGm = (await notificationsFor({ editId: Z.id })).filter((r) => r.title === 'Request returned to your step').map((r) => r.userId);
    expect(toGm).toContain(w.user('GM1').id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The last step: codes, branches, the Temix queue, and the duplicate re-check
// ═════════════════════════════════════════════════════════════════════════════

test.describe('the last step mints the code and re-checks duplicates', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let w: World;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccf');
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test('two finalizes back to back: codes in order, branch codes in form order, the Temix queue, who can open it', async ({ browser }) => {
    notRunHere(!hasR2, 'the requests carry R2 photos');
    test.setTimeout(300_000);
    const f1 = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name('Final One') });
    const f2 = await seedCreateRequest(w, {
      submitter: 'SA',
      step: 1,
      approvedBy: ['M1'],
      legalName: w.name('Final Two'),
      branches: [{ name: w.name('Main') }, { name: w.name('Souq Branch') }],
    });
    const acc1 = w.user('ACC1');
    const page = await pageAs(browser, acc1, 'desktop');
    const seqBefore = await codeSequenceNext();
    const codes: string[] = [];
    const temix: string[] = [];
    for (const f of [f1, f2]) {
      await openApproval(page, f.id);
      await expect(page.getByText(/^New customer request · submitted by/)).toBeVisible();
      // Wave 1: the Accountant sees the code he has just created (see createHere); each with its own Temix code.
      temix.push(temixCodeFor(w));
      const code = await createHere(page, f.id, temix.at(-1)!);
      codes.push(code);
      await expect(page.getByText(`New customer ${code} · submitted by`, { exact: false })).toBeVisible();
      await expect(page.getByText(`Created as customer ${code}.`, { exact: true })).toBeVisible();
    }
    expectCodesInOrder(codes, seqBefore, await codeSequenceNext());

    const c2 = await db.customer.findFirstOrThrow({
      where: { legalName: f2.legalName },
      include: { branches: { orderBy: { branchCode: 'asc' } } },
    });
    expect(c2.branches.map((b) => [b.branchCode, b.branchName, b.routeId, b.regionId])).toEqual([
      [`${codes[1]}-01`, w.name('Main'), w.route('A').id, w.region('R1').id],
      [`${codes[1]}-02`, w.name('Souq Branch'), w.route('A').id, w.region('R1').id],
    ]);
    expect(c2.completenessScore).toBeGreaterThan(0);
    for (const b of c2.branches) expect(b.completenessScore).toBeGreaterThan(0);
    expect(c2.temixSyncState).toBe('PENDING_UPLOAD');
    expect(c2.temixCode, 'its own Temix code').toBe(temix[1]);
    expect(c2.temixSyncPendingSince).not.toBeNull();
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: f2.id } })).customerId).toBe(c2.id);

    for (const k of ['ACC1', 'FM1', 'GM1']) {
      const p = await pageAs(browser, w.user(k), 'desktop');
      await p.goto(`/customers/${c2.id}`);
      await expect(p.getByRole('heading', { level: 1, name: f2.legalName }), `${k} can open it`).toBeVisible();
    }
  });

  test('wave 1: the code shows on the page itself after Approve and create, without a reload', async ({ browser }) => {
    // Was an APP BUG (found 2026-10-08), fixed by 8e47bc6 — STUCK_AFTER_CREATE: after the action answered, the page's
    // router.refresh() was often parked by React and the page stayed on "Created — loading…" (no code until a
    // reload), about half of all finalizes here. Eight finalizes in a row must each show the code in place.
    notRunHere(!hasR2, 'the requests carry R2 photos');
    test.setTimeout(600_000);
    const page = await pageAs(browser, w.user('ACC1'), 'desktop');
    for (let i = 1; i <= 8; i++) {
      const r = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name(`In Place ${i}`) });
      // As the Accountant works: the queue, the card, the request.
      await page.goto('/approvals');
      await queueCard(page, r.legalName).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/approvals/${r.id}$`));
      // createHere fails when the code is not shown in place (IN_PLACE_MS after the server finished).
      await test.step(`finalize ${i}`, () => createHere(page, r.id, temixCodeFor(w)));
    }
  });

  test('owner decision 8 Oct, the Temix code: required, its shape, never an NMWC code; one another customer (live or archived) or a live branch holds is refused under the box, naming it, with nothing written; one typed in lower case with Arabic digits is stored as Temix writes it', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    test.setTimeout(300_000);
    const d = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name('Temix Code Shop') });
    const liveCode = temixCodeFor(w);
    const live = await w.addCustomer({ key: 'TXLIVE', phone: true, temixCode: liveCode, branches: [{ key: 'S', route: 'B' }] });
    const archivedCode = temixCodeFor(w);
    const archived = await w.addCustomer({ key: 'TXARCH', phone: true, archived: true, temixCode: archivedCode, branches: [{ key: 'S', route: 'B' }] });
    const frozen = await snapshot(['CustomerEdit'], { id: d.id });
    const ledger = await db.editApproval.count({ where: { editId: d.id } });
    const notes = await rowIds(d.id);
    const seqBefore = await codeSequenceNext();
    const page = await pageAs(browser, w.user('ACC1'), 'desktop');
    await openApproval(page, d.id);
    const approve = page.getByRole('button', { name: '✓ Approve', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Create this customer?' });

    // In the page: no code, or an NMWC code, and the confirmation never opens.
    await approve.click();
    await expect(temixCodeError(page)).toHaveText(TEMIX_CODE_REQUIRED_MESSAGE);
    await expect(temixCodeError(page)).toHaveAttribute('role', 'alert');
    await expect(temixCodeBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog).toHaveCount(0);
    await typeTemixCode(page, 'nmwc-2026-000123');
    await approve.click();
    await expect(temixCodeError(page)).toHaveText(TEMIX_CODE_CRM_MESSAGE);
    await expect(dialog).toHaveCount(0);

    // On the server: a code someone already holds is refused under the box, naming the holder; nothing is written.
    const refusals: Array<[string, string]> = [
      // Typed in lower case: compared as stored.
      [liveCode.toLowerCase(), temixCodeTakenMessage(liveCode, live.code)],
      [archivedCode, temixCodeHolderMessage(archivedCode, { nmwcCode: archived.code, archived: true, branchCode: null })],
      [live.branch.code, temixCodeHolderMessage(live.branch.code, { nmwcCode: live.code, archived: false, branchCode: live.branch.code })],
    ];
    for (const [typed, refusal] of refusals) {
      await typeTemixCode(page, typed);
      await approve.click();
      await expect(dialog).toContainText(`with Temix code ${typed.toUpperCase()}`);
      await dialog.getByRole('button', { name: 'Approve and create', exact: true }).click();
      await expect(temixCodeError(page), typed).toHaveText(refusal, { timeout: 60_000 });
      await expect(page).toHaveURL(new RegExp(`/approvals/${d.id}$`));
    }
    expect(await snapshot(['CustomerEdit'], { id: d.id }), 'the request is unchanged').toBe(frozen);
    expect(await db.editApproval.count({ where: { editId: d.id } })).toBe(ledger);
    expect(await rowIds(d.id), 'nobody was told anything').toEqual(notes);
    expect(await db.customer.count({ where: { legalName: d.legalName } })).toBe(0);
    const seqAfter = await codeSequenceNext();
    expect(seqAfter - seqBefore, 'no NMWC code handed out (rolled back)').toBe(await codesMintedByOthers(seqBefore, seqAfter, [d.legalName]));

    // A fresh code, typed in lower case with Arabic-Indic digits: created under it as Temix writes it.
    const fresh = temixCodeFor(w);
    const arabic = fresh.toLowerCase().replace(/\d/g, (c) => String.fromCharCode(0x0660 + Number(c)));
    const code = await createHere(page, d.id, arabic);
    expect((await db.customer.findFirstOrThrow({ where: { legalName: d.legalName }, select: { temixCode: true } })).temixCode).toBe(fresh);
    const told = (await notificationsFor({ editId: d.id, userId: w.user('SA').id })).filter((n) => n.kind === 'EDIT_APPROVED_FINAL');
    expect(told.map((n) => n.body), 'the salesman is told both codes').toEqual([`${d.legalName} is now live as ${code}, Temix code ${fresh}.`]);
  });

  test('a customer with the same CR that went live mid-chain blocks the last step; nothing is written', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    const d = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name('Dup By Cr') });
    // As if an import promoted it while the request was in the chain — in another region.
    const live = await w.addCustomer({ key: 'LIVECR', crNumber: d.crNumber, phone: true, branches: [{ key: 'S', route: 'B' }] });
    const frozen = await snapshot(['CustomerEdit'], { id: d.id });
    const ledger = await db.editApproval.count({ where: { editId: d.id } });
    const notes = await rowIds(d.id);
    const page = await pageAs(browser, w.user('ACC1'), 'desktop');
    await openApproval(page, d.id);
    // A valid Temix code no one holds: the duplicate is refused for itself.
    await typeTemixCode(page, temixCodeFor(w));
    await approveHere(page, 'Create this customer?', 'Approve and create');
    await expect(
      page.getByText(
        `A customer with this CR number already exists: ${live.code} — ${live.legalName}. It cannot be created twice: reject this request and give that as the reason.`,
        { exact: true }
      )
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/approvals/${d.id}$`));
    expect(await snapshot(['CustomerEdit'], { id: d.id }), 'the request is unchanged').toBe(frozen);
    expect(await db.editApproval.count({ where: { editId: d.id } })).toBe(ledger);
    expect(await rowIds(d.id)).toEqual(notes);
    expect(await db.customer.count({ where: { legalName: d.legalName } })).toBe(0);
  });

  test('the same shop (name with another case and a doubled space, same phone, same region) blocks it too; Reject returns it to the Supervisor step', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    const name = w.name('Al Noor Shop');
    const d = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: name });
    const live = await w.addCustomer({
      key: 'LIVETRI',
      legalName: `AL NOOR  SHOP ${w.SFX}`,
      phone: d.phone!,
      crNumber: null,
      branches: [{ key: 'S', route: 'A2' }],
    });
    const frozen = await snapshot(['CustomerEdit'], { id: d.id });
    const seqBefore = await codeSequenceNext();
    const page = await pageAs(browser, w.user('ACC1'), 'desktop');
    await openApproval(page, d.id);
    await typeTemixCode(page, temixCodeFor(w));
    await approveHere(page, 'Create this customer?', 'Approve and create');
    await expect(
      page.getByText(
        `This shop already exists: ${live.code} — ${live.legalName} (same name, phone and region). It cannot be created twice: reject this request and give that as the reason.`,
        { exact: true }
      )
    ).toBeVisible();
    expect(await snapshot(['CustomerEdit'], { id: d.id })).toBe(frozen);
    expect(await db.customer.count({ where: { legalName: name } })).toBe(0);
    const seqAfter = await codeSequenceNext();
    expect(seqAfter - seqBefore, 'no code handed out (rolled back)').toBe(await codesMintedByOthers(seqBefore, seqAfter, [name]));

    await page.reload();
    await rejectHere(page, { label: 'Reason for the Supervisor *', button: '✗ Send back to Supervisor', reason: `Same shop as ${live.code}` });
    await expect(page).toHaveURL(/\/approvals$/);
    expect(await stageOf(d.id)).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 0, pendingRole: 'SUPERVISOR' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The salesman's form: drafts, validation, duplicates at submit, read-only
// ═════════════════════════════════════════════════════════════════════════════

test.describe("the salesman's new-customer form", { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let w: World;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccg', {
      users: [
        { key: 'SX', role: 'SALESMAN', route: 'B2', supervisor: 'M5' },
      ],
      customers: [
        { key: 'LIVEA', crNumber: true, phone: true, contact: 'Ahmed Al Lawati', branches: [{ key: 'S', route: 'A' }] },
        { key: 'LIVEB', crNumber: true, phone: true, branches: [{ key: 'S', route: 'B' }] },
        { key: 'TRIP', phone: true, branches: [{ key: 'S', route: 'A' }] },
      ],
    });
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test('a draft is saved, comes back whole after a reload and from Work, and is sent as the same request', async ({ browser }) => {
    notRunHere(!hasR2, 'the form uploads its photos to R2');
    test.setTimeout(420_000);
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/customers/new');
    const name = w.name('Draft Mart');
    const [phone] = await w.allocPhones(1);
    await page.getByLabel('Legal name *', { exact: true }).fill(name);
    await page.getByLabel('Primary phone *', { exact: true }).fill(phone!);
    const branch = formSection(page, /^Branch 1\b/);
    await branch.getByRole('button', { name: /^Capture GPS/ }).click();
    await expect(branch.getByText('23.588100, 58.382900')).toBeVisible();
    await takePhoto(photoSlot(branch, 'Shop front'));
    const saved = await sendForm(page, () => page.getByRole('button', { name: 'Save draft', exact: true }).click());
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, data: { state: 'DRAFT' } });
    const id = saved.data!.editId;
    w.adopt.edit(id);
    await expect(page.getByText('✓ Draft saved. Finish and submit when ready.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${id}$`));
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'DRAFT', submittedAt: null, process: 'CREATE' });

    // A reload restores the fields, the GPS chip and the photo from the server.
    await page.reload();
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Primary phone *', { exact: true })).toHaveValue(phone!);
    const again = formSection(page, /^Branch 1\b/);
    await expect(again.getByText('23.588100, 58.382900')).toBeVisible();
    await expect(photoSlot(again, 'Shop front').locator('label[aria-label="Retake photo"]')).toBeVisible();

    // Work lists it; it opens the same request.
    await page.goto('/work');
    const item = page.getByRole('link').filter({ hasText: name });
    await expect(item).toContainText('New customer — draft');
    await expect(item).toContainText('Unfinished create request — tap to continue');
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${id}$`));

    await page.getByLabel('CR number *', { exact: true }).fill(uniqueCr(w));
    await takePhoto(photoSlot(formSection(page, 'Identity'), 'CR document'));
    const ch = await generalTrade();
    await page.getByLabel('Channel *', { exact: true }).selectOption(ch.channelId);
    await page.getByLabel('Sub-channel *', { exact: true }).selectOption(ch.subChannelId);
    await page.getByLabel('Contact person *', { exact: true }).fill('Said Al Busaidi');
    const b = formSection(page, /^Branch 1\b/);
    await b.getByLabel('Address *', { exact: true }).fill(ADDRESS);
    await b.getByLabel('Day of visit *', { exact: true }).selectOption(OMAN_TODAY);
    await takePhoto(photoSlot(b, 'Signboard'));
    const sent = await sendForm(page, () => submitButton(page).click());
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, data: { editId: id, state: 'SUBMITTED' } });
    await expect(page).toHaveURL(/\/work$/);
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'SUBMITTED', cycle: 1, pendingRole: 'SUPERVISOR' });
    expect(await db.customerEdit.count({ where: { customerDraft: { is: { legalName: name } } } }), 'the same row, not a second one').toBe(1);
  });

  test('a form never saved keeps only the typed text on the phone, and says so after a reload', async ({ browser }) => {
    const page = await pageAs(browser, w.user('SA'), 'phone');
    await page.goto('/customers/new');
    const name = w.name('Never Saved');
    await page.getByLabel('Legal name *', { exact: true }).fill(name);
    await page.getByLabel('Primary phone *', { exact: true }).fill('+968 9123 4567');
    await expect
      .poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('nmwc:create:') && k.endsWith(':new'))))
      .toBe(true);
    await page.reload();
    await expect(
      page.getByText(
        'Restored the details you typed on this phone. Branch details, GPS points and photos are not kept on the phone — add them again, then tap Save draft to keep everything.',
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Primary phone *', { exact: true })).toHaveValue('+968 9123 4567');
    expect(await db.editCustomerDraft.count({ where: { legalName: name } }), 'nothing on the server').toBe(0);
  });

  test('validation: a bad phone even for a draft, ten branches at most, removing one keeps the others’ photos and GPS, a typed latitude outside Oman', async ({ browser }) => {
    notRunHere(!hasR2, 'the branches carry R2 photos');
    test.setTimeout(420_000);
    const sa = w.user('SA');
    const since = new Date(Date.now() - 10 * 60_000);
    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/customers/new');
    const name = w.name('Validation Store');
    await page.getByLabel('Legal name *', { exact: true }).fill(name);
    await page.getByLabel('Primary phone *', { exact: true }).fill('12345');
    const refused = await sendForm(page, () => page.getByRole('button', { name: 'Save draft', exact: true }).click());
    expect(refused).toMatchObject({ ok: false, fields: { 'customer.primaryPhone': INVALID_PHONE } });
    await expect(page.getByText(INVALID_PHONE, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: FIX_FIELDS })).toBeVisible();
    expect(await db.editCustomerDraft.count({ where: { legalName: name } }), 'no row, not even a draft').toBe(0);
    await page.getByLabel('Primary phone *', { exact: true }).fill((await w.allocPhones(1))[0]!);

    // Branch 1 and branch 3 get a point and a shop photo.
    const addBranch = page.getByRole('button', { name: '+ Add another branch' });
    for (const n of [1, 3]) {
      if (n === 3) {
        await addBranch.click();
        await addBranch.click();
      }
      const b = formSection(page, new RegExp(`^Branch ${n}\\b`));
      await b.getByRole('button', { name: /^Capture GPS/ }).click();
      await expect(b.getByText('23.588100, 58.382900')).toBeVisible();
      await takePhoto(photoSlot(b, 'Shop front'));
    }
    // Ten at most.
    for (let i = 4; i <= 10; i++) await addBranch.click();
    await expect(formSection(page, /^Branch 10\b/)).toBeVisible();
    await expect(addBranch, 'no eleventh branch').toHaveCount(0);

    // Removing branch 2 keeps the others whole.
    await page.getByRole('button', { name: 'Remove branch 2', exact: true }).click();
    await expect(formSection(page, /^Branch 10\b/)).toHaveCount(0);
    await expect(addBranch).toBeVisible();
    for (const n of [1, 2]) {
      const b = formSection(page, new RegExp(`^Branch ${n}\\b`));
      await expect(b.getByText('23.588100, 58.382900'), `branch ${n} keeps its point`).toBeVisible();
      await expect(photoSlot(b, 'Shop front').locator('label[aria-label="Retake photo"]'), `branch ${n} keeps its photo`).toBeVisible();
    }
    await expect(photoSlot(formSection(page, /^Branch 3\b/), 'Shop front').locator('label[aria-label="Retake photo"]')).toHaveCount(0);

    // A latitude typed outside Oman: warned on the phone, refused by the server in the branch's GPS slot.
    const b1 = formSection(page, /^Branch 1\b/);
    await b1.getByRole('button', { name: 'Enter coordinates manually' }).click();
    await b1.getByLabel('Latitude (16–27 in Oman)').fill('15');
    await b1.getByLabel('Longitude (51–60 in Oman)').fill('58.3829');
    await b1.getByLabel("Why didn't GPS work? *").fill('GPS chip broken on this phone');
    await b1.getByRole('button', { name: 'Save manual location' }).click();
    await expect(b1.getByText('Saved, but the coordinates fall outside Oman. Double-check before submitting.', { exact: true })).toBeVisible();
    const outside = await sendForm(page, () => page.getByRole('button', { name: 'Save draft', exact: true }).click());
    expect(outside).toMatchObject({ ok: false, fields: { 'branch.0.gps': 'Latitude must be inside Oman (≥16°N).' } });
    await expect(b1.getByText('Latitude must be inside Oman (≥16°N).', { exact: true })).toBeVisible();
    expect(await db.editCustomerDraft.count({ where: { legalName: name } })).toBe(0);
    // The photos of a form never saved are this test's to remove.
    expect(await adoptStrayPhotos(w, 'SA', since)).toBeGreaterThanOrEqual(2);
  });

  test('duplicates at submit: a live CR on his route is named, another salesman’s open request blocks, the same shop is named; a phone-only match goes through and the approver is told', async ({ browser }) => {
    notRunHere(!hasR2, 'the form uploads its photos to R2');
    test.setTimeout(480_000);
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const liveA = w.customer('LIVEA');
    const trip = w.customer('TRIP');
    const inReview = await seedCreateRequest(w, { submitter: 'SA2', legalName: w.name('Other Salesman Shop') });
    const sxDraft = await seedCreateRequest(w, { submitter: 'SX', state: 'DRAFT', legalName: w.name('Abandoned Draft') });
    const sa2 = w.user('SA2');
    const sx = w.user('SX');

    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/customers/new');
    const name = w.name('Fresh Grocery');
    await fillIdentity(page, { name, cr: liveA.crNumber!, phone: (await w.allocPhones(1))[0]! });
    await fillBranch(formSection(page, /^Branch 1\b/));
    const cr = page.getByLabel('CR number *', { exact: true });
    const mine = () => db.customerEdit.count({ where: { submittedById: sa.id, process: 'CREATE' } });
    const before = await mine();
    const tryOnce = async (expected: string) => {
      const answer = await sendForm(page, () => submitButton(page).click());
      expect(answer, JSON.stringify(answer)).toMatchObject({ ok: false, message: expected });
      await expect(page.getByRole('alert').filter({ hasText: expected }), 'said beside the button').toBeVisible();
      expect(await mine(), 'no row written').toBe(before);
    };
    // The CR of a live customer on his own route: named, with what to do.
    await tryOnce(`A customer with this CR number already exists: ${liveA.code} — ${liveA.legalName}. Open it from your customers instead of creating a new one.`);
    // Another salesman's request in review.
    await cr.fill(inReview.crNumber!);
    await tryOnce(`${sa2.fullName}'s new-customer request with this CR number is already in review. Ask your supervisor before adding it again.`);
    // Another salesman's DRAFT (recorded for the owner: it blocks while he is active).
    await cr.fill(sxDraft.crNumber!);
    await tryOnce(
      `${sx.fullName}'s new-customer request with this CR number is already in progress (saved as a draft). Ask them, or your supervisor, before adding it again.`
    );
    // The same shop: name in another case with a doubled space, same phone, same region, no CR on it.
    await cr.fill(uniqueCr(w));
    await page.getByLabel('Legal name *', { exact: true }).fill(trip.legalName.toUpperCase().replace(' ', '  '));
    await page.getByLabel('Primary phone *', { exact: true }).fill(trip.phone!);
    await tryOnce(
      `This shop already exists: ${trip.code} — ${trip.legalName} (same name, phone and region). Open it from your customers instead of creating a new one.`
    );
    // A phone-only match (another name) goes through.
    await page.getByLabel('Legal name *', { exact: true }).fill(name);
    await page.getByLabel('Primary phone *', { exact: true }).fill(liveA.phone!);
    const ok = await sendForm(page, () => submitButton(page).click());
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, data: { state: 'SUBMITTED' } });
    w.adopt.edit(ok.data!.editId);
    await expect(page).toHaveURL(/\/work$/);

    // Wave 1: the approver now sees the shared phone, linked to the customer he can open.
    const m1 = await pageAs(browser, w.user('M1'), 'desktop');
    await openApproval(m1, ok.data!.editId);
    const warning = m1.getByText('This phone is already on another customer:', { exact: true }).locator('xpath=..');
    await expect(warning).toContainText(
      `${liveA.code} — ${liveA.legalName}. One owner can run several shops on one number, so it is allowed — check this is a different shop before approving.`
    );
    await expect(warning.getByRole('link', { name: `${liveA.code} — ${liveA.legalName}` })).toHaveAttribute('href', `/customers/${liveA.id}`);
  });

  test('the duplicate refusal never names a customer on another route; a withdrawn draft and a departed salesman’s draft stop blocking', async ({ browser }) => {
    notRunHere(!hasR2, 'the requests carry R2 photos');
    test.setTimeout(420_000);
    const liveB = w.customer('LIVEB');
    const withdrawMe = await seedCreateRequest(w, { submitter: 'SX', state: 'DRAFT', legalName: w.name('Withdraw Me') });
    const departed = await seedCreateRequest(w, { submitter: 'SB', state: 'DRAFT', legalName: w.name('Departed Draft') });
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const page = await pageAs(browser, sa, 'phone');
    await page.goto('/today');
    const photos = await uploadCreatePhotos(page, w, { branches: [{}] });
    const off = await submitCreateRequestViaApi(page, w, { legalName: w.name('Other Route Cr'), crNumber: liveB.crNumber, reuse: photos });
    expect(off.answer).toMatchObject({
      ok: false,
      message:
        'A customer with this CR number is already in the customer master, on another route, so it cannot be added again. If the shop is on your route, tell your supervisor.',
    });
    expect(off.answer.message).not.toContain(liveB.code);
    expect(off.answer.message).not.toContain(liveB.legalName);

    // SX withdraws his draft from his own form: closed for good, and its CR is free.
    const sxPage = await pageAs(browser, w.user('SX'), 'phone');
    await sxPage.goto(`/customers/new?edit=${withdrawMe.id}`);
    await sxPage.getByRole('button', { name: 'Discard this draft', exact: true }).click();
    await sxPage.getByRole('dialog', { name: 'Discard this draft?' }).getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(sxPage).toHaveURL(/\/work$/);
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: withdrawMe.id } })).toMatchObject({
      state: 'REJECTED',
      decisionCategory: 'withdrawn',
      reviewedById: w.user('SX').id,
    });
    const free = await submitCreateRequestViaApi(page, w, { legalName: w.name('After Withdraw'), crNumber: withdrawMe.crNumber, reuse: photos });
    expect(free.answer, JSON.stringify(free.answer)).toMatchObject({ ok: true });

    // SB's draft blocks while he is active; once his account is disabled it no longer does.
    const blocked = await submitCreateRequestViaApi(page, w, { legalName: w.name('Behind Departed'), crNumber: departed.crNumber });
    expect(blocked.answer.message).toContain("new-customer request with this CR number is already in progress (saved as a draft)");
    await db.user.update({ where: { id: w.user('SB').id }, data: { isActive: false } });
    const passes = await submitCreateRequestViaApi(page, w, { legalName: w.name('Behind Departed'), crNumber: departed.crNumber, reuse: blocked.photos });
    expect(passes.answer, JSON.stringify(passes.answer)).toMatchObject({ ok: true });
  });

  test('a salesman whose route is switched off is told so on the form, and the server refuses his request', async ({ browser }) => {
    await w.addRoute({ key: 'OFF', region: 'R1', isActive: false });
    const soff = await w.addUser({ key: 'SOFF', role: 'SALESMAN', route: 'OFF', supervisor: 'M1' });
    const page = await pageAs(browser, soff, 'phone');
    await page.goto('/customers/new');
    await expect(page.getByText('Your route is inactive — ask your supervisor before registering new customers.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Legal name *', { exact: true }), 'no form to fill').toHaveCount(0);
    const name = w.name('Off Route Shop');
    const refused = await submitCreateViaApi(page, {
      isDraft: true,
      customer: { legalName: name, paymentTerms: 'CASH' },
      branches: [{ branchName: 'Main' }],
    });
    expect(refused).toMatchObject({ ok: false, message: 'Your route is inactive — ask your supervisor.' });
    expect(await db.editCustomerDraft.count({ where: { legalName: name } }), 'nothing written').toBe(0);
  });

  test('a request in review opens read-only from Work, its GPS controls off too', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    const r = await seedCreateRequest(w, { submitter: 'SA', legalName: w.name('In Review Shop') });
    const page = await pageAs(browser, w.user('SA'), 'phone');
    await page.goto('/work');
    const item = page.getByRole('link').filter({ hasText: r.legalName });
    await expect(item).toContainText('In review — current step: SUPERVISOR');
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${r.id}$`));
    await expect(page.getByText(/^This request is in review — current step:/)).toContainText(
      'This request is in review — current step: SUPERVISOR. You will be notified when it is decided.'
    );
    await expect(page.getByLabel('Legal name *', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Primary phone *', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Channel *', { exact: true })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Credit' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Submit for approval/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ Add another branch' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Withdraw this request' }), 'one in review cannot be withdrawn').toHaveCount(0);
    await expect(page.locator('label[aria-label="Retake photo"], label[aria-label="Capture photo"]')).toHaveCount(0);
    // Wave 1: the GPS controls are off as well.
    const b = formSection(page, /^Branch 1\b/);
    await expect(b.getByRole('button', { name: /Recapture GPS/ })).toBeDisabled();
    await expect(b.getByRole('button', { name: 'Enter coordinates manually' })).toBeDisabled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. The review page: documents for every approver, the read-only lane, races, removed photos
// ═════════════════════════════════════════════════════════════════════════════

test.describe('the review page of a new-customer request', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let w: World;
  const R = { id: '', name: '', cr: '', guarantee: '', others: [] as string[] };
  const TYPED_REASON = 'Phone GPS chip broken; coordinates from Google Maps.';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('cch', { customers: [{ key: 'UPD', phone: true, contact: 'Hamed Al Siyabi', branches: [{ key: 'S', route: 'A' }] }] });
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test('documents load for the Manager, the Finance Manager, the GM and the Accountant, on a desktop and at 412 px', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    test.setTimeout(420_000);
    const sa = await pageAs(browser, w.user('SA'), 'phone');
    await sa.goto('/today');
    R.name = w.name('Documents Depot');
    const sent = await submitCreateRequestViaApi(sa, w, {
      legalName: R.name,
      paymentTerms: 'CREDIT',
      credit: { limit: 750, days: 30 },
      branches: [
        { gps: { lat: 23.5881, lng: 58.3829, accuracy: 12 }, extras: 1 },
        { name: w.name('Typed Point'), gps: { lat: 23.6, lng: 58.4 }, manualReason: TYPED_REASON },
      ],
    });
    expect(sent.answer, JSON.stringify(sent.answer)).toMatchObject({ ok: true });
    R.id = sent.editId!;
    R.cr = sent.photos.cr!;
    R.guarantee = sent.photos.guarantees[0]!;
    R.others = sent.photos.branches.flatMap((b) => [b.shop!, b.signboard!, ...b.extras]);

    // The queue card says the point was typed in, before any bulk decision.
    const m1q = await pageAs(browser, w.user('M1'), 'desktop');
    await m1q.goto('/approvals');
    await expect(queueCard(m1q, R.name)).toContainText('Typed GPS');

    let poppedOnce = false;
    for (const k of ['M1', 'FM1', 'GM1', 'ACC1']) {
      for (const device of ['desktop', 'phone'] as const) {
        const page = await pageAs(browser, w.user(k), device);
        await openApproval(page, R.id);
        const srcs = await expectTilesDecode(page);
        expect(srcs.sort(), `${k} on ${device}: every tile`).toEqual([R.cr, R.guarantee, ...R.others].map((id) => `/api/photos/${id}`).sort());
        await expectPhotoServed(page, R.cr, true);
        await expectPhotoServed(page, R.guarantee, true);
        for (const id of R.others) await expectPhotoServed(page, id, false);
        // The captured point: coordinates, accuracy, its band, map links. The typed one: the salesman's reason.
        const b1 = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: /^Branch 1: / }) });
        await expect(b1.getByText('23.58810, 58.38290 (±12m)', { exact: true })).toBeVisible();
        await expect(b1.getByText('±12 m: within the 30 m target', { exact: true })).toBeVisible();
        await expect(b1.getByRole('link', { name: 'Open in Maps' })).toBeVisible();
        await expect(b1.getByRole('link', { name: 'Directions' })).toBeVisible();
        const b2 = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: /^Branch 2: / }) });
        await expect(b2.getByText('Location typed in by hand.', { exact: true }).locator('xpath=..')).toContainText(
          `Location typed in by hand. GPS did not work: “${TYPED_REASON}”`
        );
        await expect(page.getByRole('button', { name: '✓ Approve', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '✗ Reject', exact: true })).toBeVisible();
        if (device === 'phone') await expectNoSideScroll(page);
        if (!poppedOnce) {
          // A tile opens the full image in a new tab.
          const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator(`main a[href="/api/photos/${R.others[0]}"]`).click()]);
          await expect(popup).toHaveURL(new RegExp(`/api/photos/${R.others[0]}$`));
          await popup.close();
          poppedOnce = true;
        }
        await page.context().close();
      }
    }
  });

  test('the read-only lane: a viewer who cannot decide the current step is told so, and his Approve and Reject are refused', async ({ browser }) => {
    test.skip(!R.id, 'needs the request of the documents test');
    test.setTimeout(300_000);
    const atGm = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 2, approvedBy: ['M1', 'FM2'], legalName: w.name('Waits At Gm') });
    const atFm = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 1, approvedBy: ['M1'], legalName: w.name('Waits At Fm') });
    const update = await seedUpdateEdit(w, { customer: 'UPD', submitter: 'SA', patch: { customer: { contactPerson: w.name('New contact') } } });

    // The Accountant opens his FYI for the request still at the Supervisor step.
    const acc1 = await pageAs(browser, w.user('ACC1'), 'desktop');
    await acc1.goto('/notifications');
    await acc1.getByRole('link').filter({ hasText: 'For your information: a salesman request' }).filter({ hasText: R.name }).click();
    await expect(acc1).toHaveURL(new RegExp(`/approvals/${R.id}$`));

    const cases: Array<{ page: Page; id: string; step: string; approve: [string, string] }> = [
      { page: acc1, id: R.id, step: 'SUPERVISOR', approve: ['Send on to Finance Manager?', 'Approve and send on'] },
      { page: await pageAs(browser, w.user('FM1'), 'desktop'), id: atGm.id, step: 'GM', approve: ['Send on to Accountant?', 'Approve and send on'] },
      { page: await pageAs(browser, w.user('GM1'), 'desktop'), id: atFm.id, step: 'FINANCE MANAGER', approve: ['Send on to GM?', 'Approve and send on'] },
      { page: await pageAs(browser, w.user('ACC1'), 'desktop'), id: update.id, step: 'SUPERVISOR', approve: ['Approve this edit?', 'Approve'] },
    ];
    for (const c of cases) {
      if (c.page.url().indexOf(c.id) < 0) await openApproval(c.page, c.id);
      await expect(c.page.getByRole('note')).toContainText(
        `For your information: this request is waiting at the ${c.step} step, which you cannot decide.`
      );
      const frozen = await snapshot(['CustomerEdit'], { id: c.id });
      const ledger = await db.editApproval.count({ where: { editId: c.id } });
      const notes = await rowIds(c.id);
      await approveHere(c.page, c.approve[0], c.approve[1]);
      await expect(c.page.getByText(NOT_AUTHORIZED, { exact: true })).toBeVisible();
      await c.page.reload();
      await c.page.getByRole('button', { name: '✗ Reject', exact: true }).click();
      await c.page.locator('textarea[name="reason"]').fill('Not mine to decide, testing the lane');
      await c.page.locator('form').getByRole('button', { name: /^✗ Send back to / }).click();
      await expect(c.page.getByText(NOT_AUTHORIZED, { exact: true })).toBeVisible();
      expect(await snapshot(['CustomerEdit'], { id: c.id }), 'nothing written').toBe(frozen);
      expect(await db.editApproval.count({ where: { editId: c.id } })).toBe(ledger);
      expect(await rowIds(c.id)).toEqual(notes);
    }
  });

  test('two tabs of the Accountant create it at the same moment: exactly one customer', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    const r = await seedCreateRequest(w, { submitter: 'SA', step: 1, approvedBy: ['M1'], legalName: w.name('Race Shop') });
    const ctx = await contextAs(browser, w.user('ACC1'), { device: 'desktop' });
    const [t1, t2] = [await ctx.newPage(), await ctx.newPage()];
    // The same Temix code in both tabs, as the one Accountant would type it twice.
    const temix = temixCodeFor(w);
    for (const t of [t1, t2]) {
      await openApproval(t, r.id);
      await typeTemixCode(t, temix);
      await t.getByRole('button', { name: '✓ Approve', exact: true }).click();
      await expect(t.getByRole('dialog', { name: 'Create this customer?' })).toBeVisible();
    }
    await Promise.all(
      [t1, t2].map((t) => t.getByRole('dialog', { name: 'Create this customer?' }).getByRole('button', { name: 'Approve and create', exact: true }).click())
    );
    // The winner's page shows the code in place (no "Created — loading…" stand-in any more: STUCK_AFTER_CREATE
    // was fixed); the other is told it was decided.
    await expect
      .poll(async () => {
        const won = await Promise.all([t1, t2].map((t) => t.getByText(/^Created as customer NMWC-/).count()));
        const lost = await Promise.all([t1, t2].map((t) => t.getByText(DECIDED_ELSEWHERE).count()));
        return `${won.reduce((a, b) => a + b, 0)} won, ${lost.reduce((a, b) => a + b, 0)} told`;
      }, { timeout: 60_000 })
      .toBe('1 won, 1 told');
    const made = await db.customer.findMany({ where: { legalName: r.legalName }, select: { temixCode: true } });
    expect(made, 'exactly one customer, with the Temix code').toEqual([{ temixCode: temix }]);
    expect(await db.editApproval.count({ where: { editId: r.id, stepIndex: 1 } })).toBe(1);
  });

  test('a photo removed mid-chain reads as removed at every step, and the last step refuses it; Reject steps back to the GM', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    test.setTimeout(300_000);
    const r = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 1, approvedBy: ['M1'], legalName: w.name('Missing Photo Co') });
    // A shop photo gone after the request was sent (written in the database: a salesman can no longer remove one
    // from a request in review, 628e541 — asserted below — but a request sent before that fix, or a Steward's
    // clean-up, can still leave one missing).
    await db.attachment.update({ where: { id: r.photos.branches[0]!.shop!.id }, data: { deletedAt: new Date(), hash: null } });
    const early = '1 photo was removed since the request was sent — it will be refused at the last step; reject it and say which photo is missing.';
    const fm = await pageAs(browser, w.user('FM1'), 'desktop');
    await openApproval(fm, r.id);
    await expect(fm.getByText(early, { exact: true })).toBeVisible();
    await fastForwardCreate(w, r.id, 2, ['FM1']);
    const gm = await pageAs(browser, w.user('GM1'), 'desktop');
    await openApproval(gm, r.id);
    await expect(gm.getByText(early, { exact: true })).toBeVisible();
    await fastForwardCreate(w, r.id, 3, ['GM1']);

    const acc = await pageAs(browser, w.user('ACC1'), 'desktop');
    await openApproval(acc, r.id);
    await expect(
      acc.getByText('1 photo was removed since the request was sent — it cannot be approved; reject it and say which photo is missing.', { exact: true })
    ).toBeVisible();
    const frozen = await snapshot(['CustomerEdit'], { id: r.id });
    const ledger = await db.editApproval.count({ where: { editId: r.id } });
    // With a valid Temix code: the photo check runs first and still refuses it.
    await typeTemixCode(acc, temixCodeFor(w));
    await approveHere(acc, 'Create this customer?', 'Approve and create');
    await expect(acc.getByText(PHOTO_REMOVED_AT_FINAL, { exact: true })).toBeVisible();
    expect(await snapshot(['CustomerEdit'], { id: r.id })).toBe(frozen);
    expect(await db.editApproval.count({ where: { editId: r.id } })).toBe(ledger);
    expect(await db.customer.count({ where: { legalName: r.legalName } })).toBe(0);
    await acc.reload();
    await rejectHere(acc, { label: 'Reason for the GM *', button: '✗ Send back to GM', reason: 'The shop photo is missing' });
    await expect(acc).toHaveURL(/\/approvals$/);
    expect(await stageOf(r.id)).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 2, pendingRole: 'GM' });
  });

  test('a guarantee removed while the Accountant’s page is open makes it stale; reloaded, it says none is on file; Reject steps back to the GM', async ({ browser }) => {
    notRunHere(!hasR2, 'the request carries R2 photos');
    const r = await seedCreateRequest(w, {
      submitter: 'SA',
      paymentTerms: 'CREDIT',
      step: 3,
      approvedBy: ['M1', 'FM1', 'GM1'],
      legalName: w.name('Missing Guarantee Co'),
    });
    const acc = await pageAs(browser, w.user('ACC1'), 'desktop');
    await openApproval(acc, r.id);
    await expect(acc.getByText('Guarantee documents (1)', { exact: true })).toBeVisible();
    await db.attachment.update({ where: { id: r.photos.guarantees[0]!.id }, data: { deletedAt: new Date(), hash: null } });
    const frozen = await snapshot(['CustomerEdit'], { id: r.id });
    await typeTemixCode(acc, temixCodeFor(w));
    await approveHere(acc, 'Create this customer?', 'Approve and create');
    await expect(acc.getByText(STALE_VIEW, { exact: true })).toBeVisible();
    expect(await snapshot(['CustomerEdit'], { id: r.id })).toBe(frozen);
    await acc.reload();
    await expect(acc.getByText('Guarantee documents (0)', { exact: true })).toBeVisible();
    await expect(
      acc.getByText('None on file: removed since the request was sent. It cannot be approved — reject it and say the guarantee is missing.', {
        exact: true,
      })
    ).toBeVisible();
    await rejectHere(acc, { label: 'Reason for the GM *', button: '✗ Send back to GM', reason: 'The guarantee is missing' });
    await expect(acc).toHaveURL(/\/approvals$/);
    expect(await stageOf(r.id)).toMatchObject({ currentStepIndex: 2, pendingRole: 'GM' });
  });

  test('a salesman cannot remove a photo of his request while it is in review', async ({ browser }) => {
    // Was a P2 (wave-1 not_fixed, bug 28 root cause), fixed by 628e541: services/photos.ts detachPhotoCore let the
    // submitter soft-delete a photo claimed by his SUBMITTED new-customer request. It is REFUSED now, in words.
    notRunHere(!hasR2, 'the request carries R2 photos');
    const r = await seedCreateRequest(w, { submitter: 'SA', legalName: w.name('Keep My Photo') });
    const page = await pageAs(browser, w.user('SA'), 'phone');
    await page.goto('/work');
    const res = await postJson(page, '/api/photos/detach', { attachmentId: r.photos.branches[0]!.shop!.id });
    const out = (await res.json()) as { ok: boolean; code?: string; message?: string };
    expect(out, 'refused while the request is in review').toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message:
        'This photo is on your new-customer request, which is with the approvers, so it cannot be removed now. If it must change, ask them to send the request back.',
    });
    expect((await db.attachment.findUniqueOrThrow({ where: { id: r.photos.branches[0]!.shop!.id } })).deletedAt).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Twelve cash customers: bulk at the Supervisor step inside the time budget,
//    then one Temix code each at the Accountant (owner decision 8 Oct: no bulk
//    approve of a new customer at its last step)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('twelve cash customers, from Select all at the Supervisor step to twelve codes', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let w: World;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await chainWorld('ccq');
  });
  test.afterAll(async () => {
    test.setTimeout(600_000);
    await w?.cleanup();
  });

  test('Select all, Approve 12 at the Supervisor step inside the function budget; the Accountant cannot bulk-approve them, and creates each from its own page with its own Temix code: unique codes in order, every salesman told both codes', async ({ browser }) => {
    notRunHere(!hasR2, 'the requests carry R2 photos');
    test.setTimeout(1_200_000);
    const seeded: SeededCreate[] = [];
    for (let i = 1; i <= 12; i++) {
      seeded.push(
        await seedCreateRequest(w, {
          submitter: i % 2 ? 'SA' : 'SA2',
          legalName: w.name(`Bulk Twelve ${String(i).padStart(2, '0')}`),
        })
      );
    }
    // M3 — a Manager of the region who supervises neither salesman — sends all twelve on at once.
    const m3 = await pageAs(browser, w.user('M3'), 'desktop');
    await m3.goto('/approvals');
    expect(await pendingCount(m3)).toBe(12);
    let left = 12;
    let runs = 0;
    // Each run stops at the 40 s budget and says how many it did not attempt. Every run must make progress.
    while (left > 0 && runs < 8) {
      runs++;
      await m3.getByLabel('Select up to 50 on this page').check();
      await expect(m3.getByText(`${left} selected`, { exact: true }).first()).toBeVisible();
      await m3.getByRole('button', { name: `✓ Approve ${left}` }).click();
      const started = Date.now();
      // The dialog's own words: "Approve 1 edit?" for a single one left by the budget.
      await m3
        .getByRole('dialog', { name: `Approve ${left} edit${left === 1 ? '' : 's'}?` })
        .getByRole('button', { name: `Approve ${left}`, exact: true })
        .click();
      const banner = m3.getByText(/^\d+ processed.*\.$/);
      await expect(banner).toBeVisible({ timeout: 120_000 });
      const ms = Date.now() - started;
      test.info().annotations.push({ type: 'bulk-wall-time', description: `run ${runs}: ${ms} ms for ${left} (Vercel caps a function at 60 s)` });
      // The app stops a run at its 40 s budget; from the click to the banner it must stay clear of Vercel's 60 s cap.
      expect(ms, `run ${runs}: inside the function budget (under 55 s, Vercel caps a function at 60 s)`).toBeLessThan(55_000);
      const text = (await banner.textContent()) ?? '';
      const m = /^(\d+) processed(?:, (\d+) not attempted)?/.exec(text)!;
      expect(Number(m[1]) + Number(m[2] ?? 0), text).toBe(left);
      expect(text, 'nothing failed').not.toContain('failed');
      expect(Number(m[1]), `run ${runs} sent at least one on`).toBeGreaterThan(0);
      left = Number(m[2] ?? 0);
      if (left > 0) await m3.reload();
    }
    expect(left, 'all twelve sent on, re-running what the budget left').toBe(0);
    for (const s of seeded) expect(await stageOf(s.id)).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 1, pendingRole: 'ACCOUNTANT', customerId: null });

    // At the Accountant: twelve locks, no Select all.
    const acc1 = await pageAs(browser, w.user('ACC1'), 'desktop');
    await acc1.goto('/approvals');
    expect(await pendingCount(acc1)).toBe(12);
    await expect(acc1.getByRole('img', { name: TEMIX_LOCK_LABEL })).toHaveCount(12);
    await expect(acc1.getByLabel('Select up to 50 on this page')).toHaveCount(0);

    // One at a time, in queue order, each with its own Temix code.
    const seqBefore = await codeSequenceNext();
    const temix = new Map<string, string>();
    for (const s of seeded) {
      await openApproval(acc1, s.id);
      temix.set(s.id, temixCodeFor(w));
      const started = Date.now();
      await createHere(acc1, s.id, temix.get(s.id)!);
      test.info().annotations.push({ type: 'finalize-wall-time', description: `${s.legalName}: ${Date.now() - started} ms` });
    }
    const done = await db.customerEdit.findMany({
      where: { id: { in: seeded.map((s) => s.id) } },
      select: { id: true, state: true, reviewedAt: true, submittedById: true, customer: { select: { nmwcCode: true, temixCode: true, legalName: true } } },
      orderBy: { reviewedAt: 'asc' },
    });
    expect(done.every((d) => d.state === 'APPROVED' && d.customer)).toBe(true);
    const codes = done.map((d) => d.customer!.nmwcCode);
    expect(new Set(codes).size, 'twelve different codes').toBe(12);
    expectCodesInOrder(codes, seqBefore, await codeSequenceNext());
    for (const d of done) {
      expect(d.customer!.temixCode, 'its own Temix code').toBe(temix.get(d.id));
      const final = (await notificationsFor({ editId: d.id })).filter((n) => n.userId === d.submittedById && n.kind === 'EDIT_APPROVED_FINAL');
      expect(final.map((n) => n.body), 'the salesman of each is told both codes').toEqual([
        `${d.customer!.legalName} is now live as ${d.customer!.nmwcCode}, Temix code ${temix.get(d.id)}.`,
      ]);
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
