/**
 * RACES — two people, or two taps, at the same instant, through the real UI.
 *
 * Every race here is fired by the barrier in support/races-helpers.ts: each
 * racer's page is opened, filled and brought to the very last click in its own
 * browser context; every control is proved on screen, enabled and hydrated;
 * then all of them are clicked at one wall-clock instant (they fire within a
 * few milliseconds — the spread is measured and capped), and the POSTs they
 * send are proved to have been in flight together. Only then is the outcome
 * read back from the database.
 *
 *   approvers (@desktop; one Manager on a phone)
 *     (a) two Managers of one region press Approve together; Approve against
 *         Reject, three rounds — one decision, one audit row, the salesman told
 *         once, the other told it was already decided;
 *     (d) two Accountants, and one Accountant in two tabs, press Approve and
 *         create together; one presses it twice and keeps tapping — one
 *         customer, one NMWC code;
 *     (e) a bulk approve and a colleague's single approve of one of its
 *         requests — decided once, reported once.
 *   the salesman (@phone; the Steward on a desktop)
 *     (b) a double tap in one instant; the same customer sent from two phones;
 *         a slow answer, tapped again, with the same send arriving twice;
 *     (c) resubmitting a returned request while "Nothing to send again — clear
 *         this" is pressed;
 *     (f) the Steward moves him to another route (Edit account) while he sends.
 *
 * Where the order of a race decides what each person sees, both orders are
 * accepted and asserted in full; which one happened is noted on the test.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts races --project=phone --project=desktop
 */
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  auditFor,
  contextAs,
  createWorld,
  db,
  installLaunchHooks,
  notificationsFor,
  omanYearNow,
  postJson,
  requireLaunchEnv,
  resetLimits,
  seedUpdateEdit,
  type DeviceKind,
  type World,
} from './support';
import {
  approvableCustomer,
  changedTo,
  clickTogether,
  customerNow,
  expectOverlap,
  resendAlongside,
  seedCreateRequest,
  sleep,
  slowAnswers,
  tapRepeatedly,
  trackPosts,
  waitHydrated,
} from './support/races-helpers';

// ── the app's words (read from the code under test) ──────────────────────────

/** services/edits.ts: a decision on a request somebody decided a moment before (the state check, or the lost claim). */
const DECIDED =
  /^(Edit is in state (APPROVED|NEEDS_CORRECTION|REJECTED)\.|This (edit|request|step) was just decided by another reviewer\. Refresh to see the current state\.)$/;
/** app/(app)/customers/[id]/edit/EnrichmentForm.tsx: the Submit button in each of its states. */
const SUBMIT = 'Submit for approval ▶';
const ANY_SUBMIT = /^(Submit for approval ▶|Submitting…|Sent ✓)$/;
const SUBMITTED = '✓ Submitted for approval. It arrived — nothing more to do.';
/** lib/submission.ts alreadyReceivedMessage (same Oman day). */
const ALREADY_RECEIVED = /^✓ Already received at \d{2}:\d{2} — it is waiting for approval\. Nothing more to do\.$/;
/** lib/submission-replay.ts ownPendingBanner. */
const PENDING_BANNER = /^Your changes sent at \d{2}:\d{2} arrived and are waiting for approval\. You cannot submit again until they are decided\.$/;
/** services/edits.ts: the one-open-request rule, by the index or by the check before it (ownOpenRequestMessage). */
const LOST_TO_OTHER_PHONE =
  /^(Another submission for this customer was just made\. Refresh to see it\.|Your changes sent at \d{2}:\d{2} already arrived and are waiting for approval\. Anything you changed since was not sent — send it once they are decided\.)$/;
/** services/edits.ts submitEditOnce: the salesman's route check. */
const NOT_ON_ROUTE = 'This customer is not on your route.';
/** lib/returned-work.ts RETURNED_CLEARED_REASON, and services/edits.ts's trail on a request a resubmit answers. */
const CLEARED = 'cleared by the salesman: nothing to send again';
const ANSWERED = 'resubmitted: answered by a new request';

// ── small helpers ────────────────────────────────────────────────────────────

async function pageAs(browser: Browser, w: World, key: string, device?: DeviceKind): Promise<Page> {
  const ctx = await contextAs(browser, w.user(key), device ? { device } : {});
  return ctx.newPage();
}

/** /approvals/<id>, ✓ Approve, the confirmation open: returns its confirm button (not yet pressed). */
async function approveDialog(page: Page, id: string, title: string, confirm: string): Promise<Locator> {
  await page.goto(`/approvals/${id}`);
  const approve = page.getByRole('button', { name: '✓ Approve', exact: true });
  await waitHydrated(approve);
  await approve.click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  return dialog.getByRole('button', { name: confirm, exact: true });
}

/** /approvals/<id>, ✗ Reject, a reason typed: returns the form's send-back button (not yet pressed). */
async function rejectForm(page: Page, id: string, reason: string): Promise<Locator> {
  await page.goto(`/approvals/${id}`);
  const reject = page.getByRole('button', { name: '✗ Reject', exact: true });
  await waitHydrated(reject);
  await reject.click();
  await page.locator('textarea[name="reason"]').fill(reason);
  return page.getByRole('button', { name: '✗ Send back to salesman', exact: true });
}

/** A decision page after its click: moved on to the queue, told it was decided, or still working. */
async function decisionVerdict(page: Page): Promise<'won' | 'told' | 'waiting'> {
  if (new URL(page.url()).pathname === '/approvals') return 'won';
  return (await page.getByText(DECIDED).count()) > 0 ? 'told' : 'waiting';
}

/** One decision on an UPDATE request, by `by`: one step row, one audit row, the salesman told once. */
async function expectOneDecision(w: World, id: string, by: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const steps = await db.editApproval.findMany({ where: { editId: id }, select: { actorId: true, decision: true } });
  expect(steps, 'one step decision, the winner’s').toEqual([{ actorId: w.user(by).id, decision }]);
  const audit = (await auditFor({ entityId: id })).filter((a) => a.action === 'APPROVE' || a.action === 'REJECT');
  expect(
    audit.map((a) => ({ action: a.action, actorId: a.actorId })),
    'one audit row of the decision'
  ).toEqual([{ action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT', actorId: w.user(by).id }]);
  const told = (await notificationsFor({ editId: id, userId: w.user('SA').id })).map((n) => n.kind);
  expect(told, 'the salesman is told once').toEqual([decision === 'APPROVED' ? 'EDIT_APPROVED_FINAL' : 'EDIT_NEEDS_CORRECTION']);
}

/** The enrich form of a customer, hydrated. Returns its Submit button (any state). */
async function openEnrich(page: Page, customerId: string, query = ''): Promise<Locator> {
  await page.goto(`/customers/${customerId}/edit${query}`);
  await waitHydrated(page.locator('fieldset').first());
  const submit = page.getByRole('button', { name: ANY_SUBMIT });
  await expect(submit).toHaveText(SUBMIT);
  return submit;
}

function contactBox(page: Page): Locator {
  return page.getByLabel('Contact person *', { exact: true });
}

/** A salesman's form after Submit: it arrived (and is leaving), it was refused (`refusal` shown), or it is still working. */
async function sendVerdict(page: Page, customerId: string, refusal: Locator): Promise<'sent' | 'refused' | 'waiting'> {
  if (new URL(page.url()).pathname === `/customers/${customerId}`) return 'sent';
  if ((await page.getByText(SUBMITTED, { exact: true }).count()) > 0) return 'sent';
  return (await refusal.count()) > 0 ? 'refused' : 'waiting';
}

/** The request's notifications: written, and nobody told twice of the same thing; the region's Manager among them. */
async function expectToldOnce(w: World, editId: string): Promise<void> {
  await expect.poll(async () => (await notificationsFor({ editId })).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await sleep(1_000);
  const rows = await notificationsFor({ editId });
  const seen = new Map<string, number>();
  for (const n of rows) seen.set(`${n.userId} ${n.kind}`, (seen.get(`${n.userId} ${n.kind}`) ?? 0) + 1);
  expect([...seen].filter(([, n]) => n > 1), 'nobody is told twice').toEqual([]);
  expect(rows.map((n) => n.userId), 'the region’s Manager is told').toContain(w.user('M1').id);
}

// ═════════════════════════════════════════════════════════════════════════════
// The approvers: Managers, Accountants, the bulk queue.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('races: approvers deciding the same request at the same instant', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  /** R1: M1 (SA's supervisor) and M2 share it, with two Accountants. Every customer is SA's, on route A. */
  let w: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('rca', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M2', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'ACC2', role: 'ACCOUNTANT', regions: ['R1'] },
      ],
      customers: ['AA', 'AR1', 'AR2', 'AR3', 'BK1', 'BK2', 'BK3', 'BKEEP'].map((k) => approvableCustomer(k, 'A')),
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  // ── (a) two Managers ───────────────────────────────────────────────────────

  test('two Managers press Approve within milliseconds: one decision, applied once, one audit row, the salesman told once; the other is told it was decided', async ({ browser }) => {
    const want = w.name('Race contact');
    const cust = w.customer('AA');
    const before = await customerNow(cust.id);
    const { id } = await seedUpdateEdit(w, { customer: 'AA', submitter: 'SA', patch: { customer: { contactPerson: want } } });
    // One Manager at his desk, the other on his phone.
    const pages = { M1: await pageAs(browser, w, 'M1', 'desktop'), M2: await pageAs(browser, w, 'M2', 'phone') };
    const confirm = {
      M1: await approveDialog(pages.M1, id, 'Approve this edit?', 'Approve'),
      M2: await approveDialog(pages.M2, id, 'Approve this edit?', 'Approve'),
    };
    const posts = [trackPosts(pages.M1, 'M1', `/approvals/${id}`), trackPosts(pages.M2, 'M2', `/approvals/${id}`)];
    await clickTogether([
      { name: 'M1', target: confirm.M1 },
      { name: 'M2', target: confirm.M2 },
    ]);
    await expectOverlap(posts);
    await expect
      .poll(async () => [await decisionVerdict(pages.M1), await decisionVerdict(pages.M2)].sort().join(','), { timeout: 60_000 })
      .toBe('told,won');
    const winner = (await decisionVerdict(pages.M1)) === 'won' ? 'M1' : 'M2';
    const loser = winner === 'M1' ? 'M2' : 'M1';
    test.info().annotations.push({ type: 'race', description: `${winner} decided; ${loser} was told` });

    expect(await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true, reviewedById: true } })).toEqual({
      state: 'APPROVED',
      reviewedById: w.user(winner).id,
    });
    await expectOneDecision(w, id, winner, 'APPROVED');
    expect(await customerNow(cust.id), 'the change applied exactly once').toEqual({ contactPerson: want, version: before.version + 1 });

    // The other stays on the request, told; reloaded, it reads as decided by the winner, with nothing left to press.
    await expect(pages[loser]).toHaveURL(new RegExp(`/approvals/${id}$`));
    await pages[loser].reload();
    await expect(pages[loser].getByText(`Decision: APPROVED by ${w.user(winner).fullName}`)).toBeVisible();
    await expect(pages[loser].getByRole('button', { name: '✓ Approve', exact: true })).toHaveCount(0);
  });

  test('Approve and Reject pressed at the same instant, three rounds: each request ends one way only — never applied and returned', async ({ browser }) => {
    test.setTimeout(360_000);
    const ctx = { M1: await contextAs(browser, w.user('M1')), M2: await contextAs(browser, w.user('M2')) };
    const outcomes: string[] = [];
    for (const [i, key] of ['AR1', 'AR2', 'AR3'].entries()) {
      // The two Managers swap roles each round.
      const approver = i % 2 === 0 ? 'M1' : 'M2';
      const rejecter = approver === 'M1' ? 'M2' : 'M1';
      const want = w.name(`Race ${key}`);
      const why = w.name(`Returned in race ${key}`);
      const cust = w.customer(key);
      const before = await customerNow(cust.id);
      const { id } = await seedUpdateEdit(w, { customer: key, submitter: 'SA', patch: { customer: { contactPerson: want } } });
      const a = await ctx[approver].newPage();
      const r = await ctx[rejecter].newPage();
      const approve = await approveDialog(a, id, 'Approve this edit?', 'Approve');
      const reject = await rejectForm(r, id, why);
      const posts = [trackPosts(a, `${approver} approves`, `/approvals/${id}`), trackPosts(r, `${rejecter} returns`, `/approvals/${id}`)];
      await clickTogether([
        { name: `${approver} approves`, target: approve },
        { name: `${rejecter} returns`, target: reject },
      ]);
      await expectOverlap(posts);
      await expect
        .poll(async () => [await decisionVerdict(a), await decisionVerdict(r)].sort().join(','), { timeout: 60_000 })
        .toBe('told,won');

      const row = await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true, reviewedById: true, decisionReason: true } });
      if (row.state === 'APPROVED') {
        expect(await decisionVerdict(a), `${key}: the approver moved on`).toBe('won');
        expect(row.reviewedById).toBe(w.user(approver).id);
        // The rejection writes its step row before its claim: the lost claim rolled it back (one row, the approval).
        await expectOneDecision(w, id, approver, 'APPROVED');
        expect(await customerNow(cust.id), `${key}: approved, so applied once`).toEqual({ contactPerson: want, version: before.version + 1 });
        outcomes.push(`${key}: ${approver} approved`);
      } else {
        expect(row, `${key}: returned to the salesman`).toEqual({ state: 'NEEDS_CORRECTION', reviewedById: w.user(rejecter).id, decisionReason: why });
        expect(await decisionVerdict(r), `${key}: the returning Manager moved on`).toBe('won');
        await expectOneDecision(w, id, rejecter, 'REJECTED');
        expect(await customerNow(cust.id), `${key}: returned, so the customer is untouched`).toEqual(before);
        outcomes.push(`${key}: ${rejecter} returned it`);
      }
      await a.close();
      await r.close();
    }
    test.info().annotations.push({ type: 'race', description: outcomes.join('; ') });
  });

  // ── (d) the Accountant's final step ───────────────────────────────────────

  /**
   * Fires "Approve and create" on every page at once and checks that exactly one
   * customer, with one NMWC code, came of it. `who` names each page's user key.
   */
  async function createRace(r: { id: string; legalName: string; crNumberNorm: string }, pages: Record<string, Page>, who: Record<string, string>): Promise<void> {
    const names = Object.keys(pages);
    const confirms: Record<string, Locator> = {};
    for (const n of names) confirms[n] = await approveDialog(pages[n]!, r.id, 'Create this customer?', 'Approve and create');
    const posts = names.map((n) => trackPosts(pages[n]!, n, `/approvals/${r.id}`));
    await clickTogether(names.map((n) => ({ name: n, target: confirms[n]! })));
    await expectOverlap(posts);
    const verdict = async (p: Page) =>
      (await p.getByText(/^Created as customer NMWC-/).count()) > 0 ? 'won' : (await p.getByText(DECIDED).count()) > 0 ? 'told' : 'waiting';
    await expect
      .poll(async () => (await Promise.all(names.map((n) => verdict(pages[n]!)))).sort().join(','), { timeout: 90_000 })
      .toBe('told,won');
    const winner = (await verdict(pages[names[0]!]!)) === 'won' ? names[0]! : names[1]!;
    const loser = names.find((n) => n !== winner)!;
    test.info().annotations.push({ type: 'race', description: `${winner} created it; ${loser} was told` });

    const made = await db.customer.findMany({ where: { legalName: r.legalName }, select: { id: true, nmwcCode: true } });
    for (const c of made) w.adopt.customer(c.id);
    expect(made.length, 'exactly one customer').toBe(1);
    const { id: customerId, nmwcCode: code } = made[0]!;
    expect(code).toMatch(new RegExp(`^NMWC-${omanYearNow()}-\\d{6}$`));
    expect(await db.customer.count({ where: { crNumberNorm: r.crNumberNorm } }), 'one customer holds the CR number').toBe(1);
    const acc = w.user(who[winner]!);
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: r.id }, select: { state: true, customerId: true, reviewedById: true } })).toEqual({
      state: 'APPROVED',
      customerId,
      reviewedById: acc.id,
    });
    const steps = await db.editApproval.findMany({ where: { editId: r.id, stepIndex: 1 }, select: { actorId: true, decision: true } });
    expect(steps, 'one decision at the Accountant step').toEqual([{ actorId: acc.id, decision: 'APPROVED' }]);
    expect((await auditFor({ entityId: r.id, action: 'FINALIZE' })).map((a) => a.actorId), 'one FINALIZE').toEqual([acc.id]);
    expect((await auditFor({ entityId: customerId, action: 'CREATE' })).length, 'one CREATE of the customer').toBe(1);
    const told = (await notificationsFor({ editId: r.id, userId: w.user('SA').id })).filter((n) => n.kind === 'EDIT_APPROVED_FINAL');
    expect(told.map((n) => n.body), 'the salesman is told once, with the code').toEqual([`${r.legalName} is now live as ${code}.`]);

    await expect(pages[winner]!.getByText(`Created as customer ${code}.`)).toBeVisible();
    // The other was told on the page; reloaded, it shows the same, single customer.
    await expect(pages[loser]!).toHaveURL(new RegExp(`/approvals/${r.id}$`));
    await pages[loser]!.reload();
    await expect(pages[loser]!.getByText(`Created as customer ${code}.`)).toBeVisible();
    await expect(pages[loser]!.getByRole('button', { name: '✓ Approve', exact: true })).toHaveCount(0);
  }

  test('two Accountants of the region press Approve and create at the same instant: exactly one customer, one NMWC code', async ({ browser }) => {
    const r = await seedCreateRequest(w, { submitter: 'SA', step: 'ACCOUNTANT', priorApprovers: ['M1'] });
    await createRace(r, { ACC1: await pageAs(browser, w, 'ACC1'), ACC2: await pageAs(browser, w, 'ACC2') }, { ACC1: 'ACC1', ACC2: 'ACC2' });
  });

  test('one Accountant in two tabs presses Approve and create in both at once: exactly one customer, one NMWC code', async ({ browser }) => {
    const r = await seedCreateRequest(w, { submitter: 'SA', step: 'ACCOUNTANT', priorApprovers: ['M1'] });
    const ctx = await contextAs(browser, w.user('ACC1'));
    await createRace(r, { 'tab 1': await ctx.newPage(), 'tab 2': await ctx.newPage() }, { 'tab 1': 'ACC1', 'tab 2': 'ACC1' });
  });

  test('the Accountant presses Approve and create twice and keeps tapping Approve while it works: one send, one customer, no "already decided"', async ({ browser }) => {
    const r = await seedCreateRequest(w, { submitter: 'SA', step: 'ACCOUNTANT', priorApprovers: ['M1'] });
    const page = await pageAs(browser, w, 'ACC1');
    const posts = trackPosts(page, 'ACC1', `/approvals/${r.id}`);
    await page.goto(`/approvals/${r.id}`);
    const approve = page.getByRole('button', { name: '✓ Approve', exact: true });
    await waitHydrated(approve);
    const thumb = (await approve.elementHandle())!;
    await approve.click();
    const dialog = page.getByRole('dialog', { name: 'Create this customer?' });
    await expect(dialog.getByRole('button', { name: 'Approve and create', exact: true })).toBeFocused();
    // Enter twice on the confirmation (each a key press of its own), then the
    // thumb on Approve while "Working…" and "Created — loading…" hold it.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await tapRepeatedly(thumb, { taps: 12, gapMs: 150 });
    await expect(page.getByText(/^Created as customer NMWC-/)).toBeVisible({ timeout: 60_000 });
    // A second, queued action would leave now.
    await sleep(3_000);
    expect(posts.calls.length, 'one Approve and create left the page').toBe(1);
    await expect(page.getByText(DECIDED), 'no "already decided" after a successful create').toHaveCount(0);
    await expect(dialog).toHaveCount(0);

    const made = await db.customer.findMany({ where: { legalName: r.legalName }, select: { id: true, nmwcCode: true } });
    for (const c of made) w.adopt.customer(c.id);
    expect(made.length, 'exactly one customer').toBe(1);
    await expect(page.getByText(`Created as customer ${made[0]!.nmwcCode}.`)).toBeVisible();
    expect(await db.editApproval.count({ where: { editId: r.id, stepIndex: 1 } })).toBe(1);
    expect((await auditFor({ entityId: r.id, action: 'FINALIZE' })).length).toBe(1);
  });

  // ── (e) bulk against single ───────────────────────────────────────────────

  test('a bulk approve and a colleague’s single approve of one of its requests at the same instant: that request is decided once and reported once, the others go through', async ({ browser }) => {
    test.setTimeout(240_000);
    const keys = ['BK1', 'BK2', 'BK3'] as const;
    const want = (k: string) => w.name(`Bulk ${k}`);
    const soon = (h: number) => new Date(Date.now() + h * 3_600_000);
    const before: Record<string, { contactPerson: string | null; version: number }> = {};
    const ids: Record<string, string> = {};
    // BK1 is the most urgent card, so it is the FIRST item the bulk decides —
    // at the very moment M2 decides it on its own page.
    for (const [i, k] of keys.entries()) {
      before[k] = await customerNow(w.customer(k).id);
      ids[k] = (await seedUpdateEdit(w, { customer: k, submitter: 'SA', patch: { customer: { contactPerson: want(k) } }, slaDueAt: soon(2 + i) })).id;
    }
    // Not ticked: keeps the queue, and its outcome banner, on screen after the refresh.
    await seedUpdateEdit(w, { customer: 'BKEEP', submitter: 'SA', patch: { customer: { contactPerson: want('BKEEP') } }, slaDueAt: soon(9) });

    const m1 = await pageAs(browser, w, 'M1');
    await m1.goto('/approvals');
    const names = (await m1.getByRole('main').getByRole('listitem').getByRole('heading', { level: 3 }).allInnerTexts()).map((t) => t.trim());
    const at = keys.map((k) => names.indexOf(w.customer(k).legalName));
    expect(at.every((x) => x >= 0) && at[0]! < at[1]! && at[1]! < at[2]!, `BK1 is decided first (queue order: ${at.join(', ')})`).toBe(true);
    for (const k of keys) {
      const box = m1.getByRole('checkbox', { name: `Select edit for ${w.customer(k).legalName}`, exact: true });
      await waitHydrated(box);
      await box.check();
    }
    await m1.getByRole('button', { name: '✓ Approve 3', exact: true }).click();
    const bulk = m1.getByRole('dialog', { name: 'Approve 3 edits?' }).getByRole('button', { name: 'Approve 3', exact: true });

    const m2 = await pageAs(browser, w, 'M2');
    const single = await approveDialog(m2, ids.BK1!, 'Approve this edit?', 'Approve');
    const posts = [trackPosts(m1, 'M1 bulk', '/approvals'), trackPosts(m2, 'M2 single', `/approvals/${ids.BK1}`)];
    await clickTogether([
      { name: 'M1 bulk', target: bulk },
      { name: 'M2 single', target: single },
    ]);
    await expectOverlap(posts);
    const banner = m1.getByText(/^\d+ processed(, \d+ failed)?\.$/);
    await expect(banner).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => decisionVerdict(m2), { timeout: 60_000 }).not.toBe('waiting');

    const rows = await db.customerEdit.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true, state: true, reviewedById: true } });
    expect(rows.map((r) => r.state), 'all three are approved').toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
    const m2Won = rows.find((r) => r.id === ids.BK1)!.reviewedById === w.user('M2').id;
    test.info().annotations.push({ type: 'race', description: m2Won ? 'M2 decided BK1; the bulk reported it failed' : 'the bulk decided BK1; M2 was told' });
    for (const k of keys) {
      const by = k === 'BK1' && m2Won ? 'M2' : 'M1';
      expect(rows.find((r) => r.id === ids[k])!.reviewedById, `${k}: decided by ${by}`).toBe(w.user(by).id);
      await expectOneDecision(w, ids[k]!, by, 'APPROVED');
      expect(await customerNow(w.customer(k).id), `${k}: applied once`).toEqual({ contactPerson: want(k), version: before[k]!.version + 1 });
    }
    // The banner says exactly what the database holds.
    await expect(banner).toHaveText(m2Won ? '2 processed, 1 failed.' : '3 processed.');
    if (m2Won) {
      await expect(
        m1.getByText(new RegExp(`^${ids.BK1!.slice(-8)}: (Edit is in state APPROVED\\.|This edit was just decided by another reviewer\\. Refresh to see the current state\\.)$`))
      ).toBeVisible();
      expect(await decisionVerdict(m2)).toBe('won');
    } else {
      expect(await decisionVerdict(m2), 'M2 is told the bulk decided it').toBe('told');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The salesman on his phone (and the Steward at her desk).
// ═════════════════════════════════════════════════════════════════════════════

test.describe('races: the salesman’s sends', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  /** R1: M1 decides; SA on route A; SMV on route MV, the one the Steward moves to FREE. */
  let w: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('rcs', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'MV', region: 'R1' },
        { key: 'FREE', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SMV', role: 'SALESMAN', route: 'MV', supervisor: 'M1' },
        { key: 'STW', role: 'STEWARD' },
      ],
      customers: [
        ...['DBL', 'TWO', 'SLOW', 'RET'].map((k) => approvableCustomer(k, 'A')),
        approvableCustomer('MOVE', 'MV'),
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  // ── (b) double sends ──────────────────────────────────────────────────────

  test('a double tap in one instant, and more taps while it sends: one request leaves the phone, one is written, nobody told twice', async ({ browser }) => {
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const cust = w.customer('DBL');
    const page = await pageAs(browser, w, 'SA', 'phone');
    const posts = trackPosts(page, 'SA', '/api/forms/customer-edit');
    const submit = await openEnrich(page, cust.id);
    const want = w.name('Double tap contact');
    await contactBox(page).fill(want);
    await expect(submit).toBeEnabled();
    const thumb = (await submit.elementHandle())!;
    // The answer comes back slowly, so the later taps land while "Submitting…" is up.
    await slowAnswers(page, '/api/forms/customer-edit', 3_000);
    // Two clicks in ONE task: faster than any re-render, so only the form's own lock stands between them.
    await clickTogether([{ name: 'double tap', target: submit, taps: 2 }]);
    await expect(submit).toHaveText('Submitting…');
    await expect(submit).toBeDisabled();
    await tapRepeatedly(thumb, { taps: 5, gapMs: 120 });
    await expect(page).toHaveURL(new RegExp(`/customers/${cust.id}$`), { timeout: 60_000 });

    expect(posts.calls.length, 'one submit left the phone').toBe(1);
    const edits = await db.customerEdit.findMany({ where: { customerId: cust.id, submittedById: sa.id }, select: { id: true, state: true, fieldChanges: true } });
    edits.forEach((e) => w.adopt.edit(e.id));
    expect(edits.map((e) => e.state)).toEqual(['SUBMITTED']);
    expect(changedTo(edits[0]!.fieldChanges, 'customer.contactPerson')).toBe(want);
    await expectToldOnce(w, edits[0]!.id);
    await page.goto(`/customers/${cust.id}/edit`);
    await expect(page.getByText(PENDING_BANNER)).toBeVisible();
    await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toBeDisabled();
  });

  test('the same salesman sends one customer from two phones at the same instant: one request, the other phone told nothing was sent', async ({ browser }) => {
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const cust = w.customer('TWO');
    const phones = { A: await pageAs(browser, w, 'SA', 'phone'), B: await pageAs(browser, w, 'SA', 'phone') };
    const typed = { A: w.name('Phone A contact'), B: w.name('Phone B contact') };
    const posts = [trackPosts(phones.A, 'phone A', '/api/forms/customer-edit'), trackPosts(phones.B, 'phone B', '/api/forms/customer-edit')];
    const submits: Partial<Record<'A' | 'B', Locator>> = {};
    for (const k of ['A', 'B'] as const) {
      submits[k] = await openEnrich(phones[k], cust.id);
      await contactBox(phones[k]).fill(typed[k]);
      await expect(submits[k]!).toBeEnabled();
    }
    await clickTogether([
      { name: 'phone A', target: submits.A! },
      { name: 'phone B', target: submits.B! },
    ]);
    await expectOverlap(posts);
    const verdict = (k: 'A' | 'B') => sendVerdict(phones[k], cust.id, phones[k].getByText(LOST_TO_OTHER_PHONE));
    await expect.poll(async () => [await verdict('A'), await verdict('B')].sort().join(','), { timeout: 60_000 }).toBe('refused,sent');
    const winner = (await verdict('A')) === 'sent' ? 'A' : 'B';
    const loser = winner === 'A' ? 'B' : 'A';
    test.info().annotations.push({ type: 'race', description: `phone ${winner} sent it; phone ${loser} was refused` });

    const edits = await db.customerEdit.findMany({ where: { customerId: cust.id, submittedById: sa.id }, select: { id: true, state: true, fieldChanges: true } });
    edits.forEach((e) => w.adopt.edit(e.id));
    expect(edits.map((e) => e.state), 'one request').toEqual(['SUBMITTED']);
    expect(changedTo(edits[0]!.fieldChanges, 'customer.contactPerson'), 'the winning phone’s value').toBe(typed[winner]);
    await expectToldOnce(w, edits[0]!.id);
    // The other phone keeps what was typed and stays; reloaded, it says what is waiting.
    await expect(contactBox(phones[loser])).toHaveValue(typed[loser]);
    expect(new URL(phones[loser].url()).pathname).toBe(`/customers/${cust.id}/edit`);
    await phones[loser].reload();
    await expect(phones[loser].getByText(PENDING_BANNER)).toBeVisible();
    await expect(phones[loser].getByRole('button', { name: SUBMIT, exact: true })).toBeDisabled();
  });

  test('a slow answer: taps while it hangs do nothing, the same send reaching the server twice at once is written once, and a later resend says "already received"', async ({ browser }) => {
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const cust = w.customer('SLOW');
    const page = await pageAs(browser, w, 'SA', 'phone');
    const posts = trackPosts(page, 'SA', '/api/forms/customer-edit');
    const submit = await openEnrich(page, cust.id);
    await contactBox(page).fill(w.name('Slow answer contact'));
    await expect(submit).toBeEnabled();
    const thumb = (await submit.elementHandle())!;
    const twice = await resendAlongside(page, '/api/forms/customer-edit', 5_000);
    await submit.click();
    await expect(submit).toHaveText('Submitting…');
    await expect(submit).toBeDisabled();
    await expect(page.getByRole('button', { name: /^(Save draft|Saving…)$/ })).toBeDisabled();
    await tapRepeatedly(thumb, { taps: 6, gapMs: 200 });
    await expect.poll(() => twice.done, { timeout: 60_000 }).toBe(true);
    expect(twice.error, 'the doubled send went through').toBeNull();

    // Both copies are answered as landed: one written, the other its receipt.
    const sid = String(twice.body?.submissionId ?? '');
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    const mine = twice.page?.data as { editId?: string; replayed?: boolean } | undefined;
    const copy = twice.copy?.data as { editId?: string; replayed?: boolean } | undefined;
    expect({ page: twice.page?.ok, copy: twice.copy?.ok, copyStatus: twice.copyStatus }).toEqual({ page: true, copy: true, copyStatus: 200 });
    expect(copy?.editId, 'the same request').toBe(mine?.editId);
    expect([mine?.replayed, copy?.replayed].sort(), 'one written, one answered from it').toEqual([false, true]);
    const editId = mine!.editId!;
    w.adopt.edit(editId);
    test.info().annotations.push({ type: 'race', description: mine?.replayed ? 'the copy was written first' : 'the phone’s own send was written first' });

    if (mine?.replayed) {
      // It had arrived already: said so, and nothing more to send — more taps do nothing.
      await expect(page.getByText(ALREADY_RECEIVED)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sent ✓', exact: true })).toBeDisabled();
      await tapRepeatedly(thumb, { taps: 3, gapMs: 150 });
      expect(new URL(page.url()).pathname).toBe(`/customers/${cust.id}/edit`);
    } else {
      await expect(page).toHaveURL(new RegExp(`/customers/${cust.id}$`), { timeout: 30_000 });
    }
    expect(posts.calls.length, 'one submit left the phone').toBe(1);
    expect(await db.customerEdit.count({ where: { submissionId: sid } }), 'written once').toBe(1);
    expect(await db.customerEdit.count({ where: { customerId: cust.id, state: 'SUBMITTED' } })).toBe(1);

    // Later, the same send once more (a Try again after a lost answer): its receipt, nothing new.
    const again = await postJson(page, '/api/forms/customer-edit', twice.body);
    expect(await again.json()).toMatchObject({ ok: true, data: { editId, replayed: true } });
    expect(await db.customerEdit.count({ where: { customerId: cust.id } })).toBe(1);
    // Reopened, the form says it is waiting and offers nothing to send.
    await page.goto(`/customers/${cust.id}/edit`);
    await expect(page.getByText(PENDING_BANNER)).toBeVisible();
    await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toBeDisabled();
    await expectToldOnce(w, editId);
  });

  // ── (c) returned work ─────────────────────────────────────────────────────

  test('resubmitting a returned request while "Nothing to send again — clear this" is pressed: the new request lands once, the returned one leaves the list, its record untouched', async ({ browser }) => {
    const sa = w.user('SA');
    await resetLimits({ users: [sa] });
    const cust = w.customer('RET');
    const reason = w.name('Check the contact name');
    const { id: back } = await seedUpdateEdit(w, {
      customer: 'RET',
      submitter: 'SA',
      patch: { customer: { contactPerson: w.name('First try') } },
      state: 'NEEDS_CORRECTION',
      decision: { by: 'M1', reason },
    });
    // His phone, two tabs: the returned request open on the edit form, and Needs correction.
    const ctx = await contextAs(browser, sa, { device: 'phone' });
    const form = await ctx.newPage();
    const list = await ctx.newPage();
    const sends = trackPosts(form, 'resubmit', '/api/forms/customer-edit');
    const clears = trackPosts(list, 'clear', '/rejected');
    const submit = await openEnrich(form, cust.id, `?returned=${back}`);
    const want = w.name('Corrected contact');
    await contactBox(form).fill(want);
    await expect(submit).toBeEnabled();
    await list.goto('/rejected');
    const card = list.locator('main li').filter({ hasText: cust.legalName });
    await expect(card).toContainText(reason);
    const clear = card.getByRole('button', { name: 'Nothing to send again — clear this', exact: true });
    await waitHydrated(clear);
    await clear.click();
    const clearIt = list.getByRole('dialog', { name: 'Clear this from Needs correction?' }).getByRole('button', { name: 'Clear it', exact: true });

    await clickTogether([
      { name: 'resubmit', target: submit },
      { name: 'clear', target: clearIt },
    ]);
    await expectOverlap([sends, clears]);
    // The resubmit is never lost to the clear …
    await expect(form).toHaveURL(new RegExp(`/customers/${cust.id}$`), { timeout: 60_000 });
    // … and the clear answers yes whatever came first: the list reloads without it.
    await expect(card).toHaveCount(0, { timeout: 60_000 });

    const mine = await db.customerEdit.findMany({
      where: { customerId: cust.id, submittedById: sa.id },
      select: { id: true, state: true, decisionReason: true, fieldChanges: true },
    });
    mine.forEach((e) => w.adopt.edit(e.id));
    const fresh = mine.filter((e) => e.id !== back);
    expect(fresh.map((e) => e.state), 'the resubmit landed once').toEqual(['SUBMITTED']);
    expect(changedTo(fresh[0]!.fieldChanges, 'customer.contactPerson')).toBe(want);
    expect(mine.find((e) => e.id === back), 'the returned request stays the record of the decision').toMatchObject({
      state: 'NEEDS_CORRECTION',
      decisionReason: reason,
    });
    const trail = (await auditFor({ entityId: back, entityType: 'CustomerEdit' })).map((a) => a.reason);
    const cleared = trail.filter((r) => r === CLEARED).length;
    const answered = trail.filter((r) => r === ANSWERED).length;
    expect(cleared, 'cleared at most once').toBeLessThanOrEqual(1);
    expect(answered, 'answered at most once').toBeLessThanOrEqual(1);
    expect(cleared + answered, 'its trail says why it left the list').toBeGreaterThanOrEqual(1);
    test.info().annotations.push({ type: 'race', description: `trail on the returned request: ${cleared} cleared, ${answered} answered` });

    // Off Needs correction for good, and the new request waits for the Manager.
    await list.goto('/rejected');
    await expect(list.locator('main li').filter({ hasText: cust.legalName })).toHaveCount(0);
    await expectToldOnce(w, fresh[0]!.id);
  });

  // ── (f) the Steward moves him while he sends ──────────────────────────────

  test('the Steward moves a salesman to another route (Edit account) while he sends: the move holds, and his request either lands whole on his old route’s approvers or is refused with nothing written', async ({ browser }) => {
    test.setTimeout(240_000);
    const smv = w.user('SMV');
    const stw = w.user('STW');
    const free = w.route('FREE');
    const cust = w.customer('MOVE');
    await resetLimits({ users: [smv, stw] });
    const was = await db.user.findUniqueOrThrow({ where: { id: smv.id }, select: { sessionsRevokedAt: true } });

    const phone = await pageAs(browser, w, 'SMV', 'phone');
    const sends = trackPosts(phone, 'salesman sends', '/api/forms/customer-edit');
    const submit = await openEnrich(phone, cust.id);
    const want = w.name('Moved salesman contact');
    await contactBox(phone).fill(want);
    await expect(submit).toBeEnabled();

    const desk = await pageAs(browser, w, 'STW', 'desktop');
    const saves = trackPosts(desk, 'Steward saves', '/users');
    await desk.goto('/users');
    const edit = desk.getByRole('row').filter({ has: desk.getByRole('cell', { name: smv.username, exact: true }) }).getByRole('button', { name: 'Edit', exact: true });
    await waitHydrated(edit);
    await edit.click();
    const dialog = desk.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toContainText(smv.username);
    await dialog.getByLabel('Route', { exact: true }).selectOption(free.id);
    // He keeps his sign-in name: only the route moves.
    const takeCode = dialog.getByRole('checkbox', { name: /Sign in with the route code/ });
    if (await takeCode.isChecked()) await takeCode.uncheck();
    const save = dialog.getByRole('button', { name: 'Save', exact: true });

    await clickTogether([
      { name: 'salesman sends', target: submit },
      { name: 'Steward saves', target: save },
    ]);
    await expectOverlap([sends, saves]);

    // The move holds whatever came first, and signs nobody out.
    await expect(desk.locator('main div[role="status"]').first()).toContainText(`Saved "${smv.username}": route.`, { timeout: 60_000 });
    expect(await db.user.findUniqueOrThrow({ where: { id: smv.id }, select: { ownedRouteId: true, username: true, supervisorId: true, sessionsRevokedAt: true } })).toEqual({
      ownedRouteId: free.id,
      username: smv.username,
      supervisorId: w.user('M1').id,
      sessionsRevokedAt: was.sessionsRevokedAt,
    });
    const audit = (await auditFor({ entityId: smv.id, action: 'UPDATE' })).filter((a) => a.reason === 'account_edit');
    expect(audit.map((a) => a.actorId), 'one account edit, the Steward’s').toEqual([stw.id]);

    const refusal = phone.getByText(NOT_ON_ROUTE, { exact: true });
    await expect.poll(() => sendVerdict(phone, cust.id, refusal), { timeout: 60_000 }).not.toBe('waiting');
    const landed = (await sendVerdict(phone, cust.id, refusal)) === 'sent';
    test.info().annotations.push({ type: 'race', description: landed ? 'the request landed before the move' : 'the move came first; the send was refused' });
    const edits = await db.customerEdit.findMany({
      where: { customerId: cust.id },
      select: { id: true, state: true, submittedById: true, pendingRole: true, submitGate: true, fieldChanges: true },
    });
    edits.forEach((e) => w.adopt.edit(e.id));
    if (!landed) {
      expect(edits, 'refused: nothing written').toEqual([]);
      await expect(contactBox(phone), 'and nothing typed is lost').toHaveValue(want);
      return;
    }
    // Landed: whole, gated on the shop of the route he sent it from …
    expect(edits.length, 'one request').toBe(1);
    const e = edits[0]!;
    expect({ state: e.state, submittedById: e.submittedById, pendingRole: e.pendingRole }).toEqual({
      state: 'SUBMITTED',
      submittedById: smv.id,
      pendingRole: 'SUPERVISOR',
    });
    expect((e.submitGate as { branchIds?: string[] } | null)?.branchIds, 'gated on the shop of his old route').toEqual([cust.branch.id]);
    expect(changedTo(e.fieldChanges, 'customer.contactPerson')).toBe(want);
    // … and it stays with the same approvers: the region's Manager decides it as before.
    const m1 = await pageAs(browser, w, 'M1', 'desktop');
    await (await approveDialog(m1, e.id, 'Approve this edit?', 'Approve')).click();
    await expect(m1).toHaveURL(/\/approvals(\?|$)/);
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: e.id }, select: { state: true, reviewedById: true } })).toEqual({
      state: 'APPROVED',
      reviewedById: w.user('M1').id,
    });
    expect((await customerNow(cust.id)).contactPerson).toBe(want);
  });
});
