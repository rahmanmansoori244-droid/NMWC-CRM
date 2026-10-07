// @vitest-environment node
/**
 * F1 (2026-10-05): the e-mail outbox drain against a real Postgres
 * (lib/email/outbox-store.ts + lib/email/drain.ts), with a fake transport — no
 * mail leaves the test.
 *
 *   - Only allowlisted, active recipients with an address are e-mailed; every
 *     other row is marked with why (SKIPPED_ROLE for the Steward and a Viewer,
 *     SKIPPED_INACTIVE, SKIPPED_NO_ADDRESS, SKIPPED_STALE, SKIPPED_RESOLVED —
 *     the GM's row about a request not at his step).
 *   - Owner decision 6 (2026-10-07): the GM is e-mailed a credit request at his
 *     step, and a late request (SLA_BREACH) reaches the region's Managers and the
 *     GM — each in one digest per run — and never a Manager of another region.
 *   - A PRE_FEATURE row (what the migration made of every historical row) is never
 *     touched.
 *   - Two drains at once claim disjoint rows (FOR UPDATE SKIP LOCKED + lease):
 *     every row is sent exactly once.
 *   - A recipient e-mailed within the gap waits, and his rows go back unspent.
 *   - A must-act row reaches only someone who can act on the request now: the
 *     region is read from the request's draft routes and the recipient's managed
 *     regions, as the decision reads them (a supervisor outside it is skipped).
 *   - Rows that can never be sent are marked before the claim, so a small claim
 *     limit is not spent on them (the raw SQL of markIneligible, on Postgres).
 *
 * GATED: RUN_EMAIL_DRAIN=1. It needs the F1 migrations (the outbox columns), so it
 * runs in CI's db-tests job. Every statement is scoped to the suite's own
 * synthetic users (prefix ZZED-), so it never touches a row it did not create;
 * they are deleted after. Never production.
 *
 *   RUN_EMAIL_DRAIN=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/email-drain.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EditProcess, PaymentTerms } from '@prisma/client';
import { purgeCustomerEdits } from '../support/audit';
import type { MailTransport, OutgoingMail, SendResult } from '@/lib/email/transport';
import { EMAIL_DELIVERY } from '@/lib/notify-policy';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const ENABLED = process.env.RUN_EMAIL_DRAIN === '1' && !!process.env.DATABASE_URL;

const tag = randomUUID().slice(0, 8);
const P = `ZZED-${tag}`;
const ids = {
  region: `${P}-region`,
  otherRegion: `${P}-region2`,
  route: `${P}-route`,
  sales: `${P}-sales`,
  mgr: `${P}-mgr`,
  mgr2: `${P}-mgr2`,
  mgr3: `${P}-mgr3`,
  far: `${P}-far`,
  farSales: `${P}-farsales`,
  acc: `${P}-acc`,
  acc2: `${P}-acc2`,
  gm: `${P}-gm`,
  stw: `${P}-stw`,
  viewer: `${P}-viewer`,
  mgr4: `${P}-mgr4`,
  off: `${P}-off`,
  nomail: `${P}-nomail`,
};
const USERS = Object.entries(ids)
  .filter(([k]) => !['region', 'otherRegion', 'route'].includes(k))
  .map(([, v]) => v);
const addr = (id: string) => `${id.toLowerCase()}@example.test`;

class FakeTransport implements MailTransport {
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail): Promise<SendResult> {
    this.sent.push(mail);
    return { ok: true };
  }
  close() {}
}

describe.skipIf(!ENABLED)('F1: the e-mail drain on Postgres', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let drain: typeof import('@/lib/email/drain');
  let chain: unknown;
  let storeOf: typeof import('@/lib/email/outbox-store');
  const editIds: string[] = [];
  const CONFIG = { linkOrigin: 'https://crm.example.test', redirectTo: null, subjectPrefix: '' };

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    drain = await import('@/lib/email/drain');
    storeOf = await import('@/lib/email/outbox-store');
    const { resolveChain } = await import('@/lib/approval-chains');
    chain = resolveChain(EditProcess.CREATE, PaymentTerms.CASH);
    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.region.create({ data: { id: ids.otherRegion, code: `${P}-R2`, name: `${P} Region 2` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    const user = (id: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({
        data: { id, username: id, passwordHash: 'x', fullName: `ZZ ${role}`, role: role as never, email: addr(id), ...extra },
      });
    // Approvers manage the request's region, as the decision requires of them.
    const inRegion = (r: string) => ({ managedRegions: { connect: { id: r } } });
    await user(ids.mgr, 'MANAGER', inRegion(ids.region));
    await user(ids.mgr2, 'MANAGER', inRegion(ids.region));
    await user(ids.mgr3, 'MANAGER', inRegion(ids.region));
    await user(ids.mgr4, 'MANAGER', inRegion(ids.region));
    // A supervisor who does not manage the route's region: the page refuses him.
    await user(ids.far, 'MANAGER', inRegion(ids.otherRegion));
    await user(ids.acc, 'ACCOUNTANT', inRegion(ids.region));
    await user(ids.acc2, 'ACCOUNTANT', inRegion(ids.region));
    await user(ids.gm, 'GM');
    await user(ids.stw, 'STEWARD');
    await user(ids.viewer, 'VIEWER');
    await user(ids.off, 'MANAGER', { ...inRegion(ids.region), isActive: false });
    await user(ids.nomail, 'MANAGER', { ...inRegion(ids.region), email: null });
    await user(ids.sales, 'SALESMAN', { supervisorId: ids.mgr });
    await user(ids.farSales, 'SALESMAN', { supervisorId: ids.far });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
      if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      await prisma.user.updateMany({ where: { id: { in: USERS } }, data: { supervisorId: null } });
      await prisma.user.deleteMany({ where: { id: { in: USERS } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.region, ids.otherRegion] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  /**
   * A new-customer request at the Supervisor step, submitted by the suite's
   * salesman, with one draft branch on a route of the suite's region: the region
   * the decision (and so the drain) scopes it by.
   */
  async function request(over: Record<string, unknown> = {}) {
    const e = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER',
        process: EditProcess.CREATE,
        state: 'SUBMITTED',
        submittedById: ids.sales,
        submittedAt: new Date(),
        approvalChain: chain as never,
        currentStepIndex: 0,
        pendingRole: 'SUPERVISOR',
        fieldChanges: [],
        attachmentChanges: [],
        branchDrafts: {
          create: [{ branchName: 'ZZ Main', regionId: ids.region, routeId: ids.route, address: 'ZZ synthetic address' }],
        },
        ...over,
      },
    });
    editIds.push(e.id);
    return e.id;
  }

  async function notify(userId: string, kind: string, editId: string | null, over: Record<string, unknown> = {}) {
    const n = await prisma.notification.create({
      data: {
        userId,
        kind: kind as never,
        title: 'ZZ Customer Legal Name LLC',
        body: 'ZZ Customer Legal Name LLC (NMWC-ZZ) — synthetic.',
        editId,
        ...over,
      },
    });
    return n.id;
  }
  const status = async (id: string) =>
    prisma.notification.findUniqueOrThrow({
      where: { id },
      select: { emailStatus: true, emailedAt: true, emailAttempts: true, emailLeaseUntil: true },
    });
  const run = (transport: MailTransport) =>
    drain.runEmailDrain({ store: storeOf.prismaOutboxStore(prisma, { userIds: USERS }), transport, config: CONFIG });

  it('sends to the allowed, active, addressed recipients only, and says why it skipped the rest', async () => {
    const e1 = await request();
    const decided = await request({ state: 'APPROVED', pendingRole: null });
    const rows = {
      mgr: await notify(ids.mgr, 'EDIT_SUBMITTED', e1),
      acc: await notify(ids.acc, 'REQUEST_FYI', e1),
      gm: await notify(ids.gm, 'EDIT_STAGE_ADVANCED', e1),
      stw: await notify(ids.stw, 'REQUEST_FYI', e1),
      off: await notify(ids.off, 'EDIT_SUBMITTED', e1),
      nomail: await notify(ids.nomail, 'EDIT_SUBMITTED', e1),
      stale: await notify(ids.mgr2, 'EDIT_SUBMITTED', e1, { createdAt: new Date(Date.now() - 48 * 3600_000) }),
      resolved: await notify(ids.mgr2, 'EDIT_SUBMITTED', decided),
      pre: await notify(ids.acc2, 'REQUEST_FYI', e1, { emailStatus: 'PRE_FEATURE', emailedAt: new Date(Date.now() - 3600_000) }),
    };
    const t = new FakeTransport();
    const r = await run(t);
    expect(t.sent.map((m) => m.to).sort()).toEqual([addr(ids.acc), addr(ids.mgr)].sort());
    for (const m of t.sent) expect(`${m.subject}\n${m.text}`).not.toContain('ZZ Customer Legal Name');
    expect(r).toMatchObject({ sent: 2, sendErrors: 0, authErrors: 0 });
    expect((await status(rows.mgr)).emailStatus).toBe('SENT');
    expect((await status(rows.acc)).emailStatus).toBe('SENT');
    // Owner decision 6: the GM is on the allowlist now, but this request is at
    // the Supervisor step, not his.
    expect((await status(rows.gm)).emailStatus).toBe('SKIPPED_RESOLVED');
    expect((await status(rows.stw)).emailStatus).toBe('SKIPPED_ROLE');
    expect((await status(rows.off)).emailStatus).toBe('SKIPPED_INACTIVE');
    expect((await status(rows.nomail)).emailStatus).toBe('SKIPPED_NO_ADDRESS');
    expect((await status(rows.stale)).emailStatus).toBe('SKIPPED_STALE');
    expect((await status(rows.resolved)).emailStatus).toBe('SKIPPED_RESOLVED');
    const pre = await status(rows.pre);
    expect(pre).toMatchObject({ emailStatus: 'PRE_FEATURE', emailAttempts: 0 });
    for (const id of Object.values(rows)) expect((await status(id)).emailLeaseUntil, id).toBeNull();
  });

  it('two drains at once: every row sent exactly once', async () => {
    const e = await request();
    const fresh = [
      await notify(ids.acc2, 'REQUEST_FYI', e),
      await notify(ids.mgr2, 'REQUEST_FYI', e),
    ];
    const a = new FakeTransport();
    const b = new FakeTransport();
    const [ra, rb] = await Promise.all([run(a), run(b)]);
    const all = [...a.sent, ...b.sent].map((m) => m.to).sort();
    expect(all).toEqual([addr(ids.acc2), addr(ids.mgr2)].sort());
    expect(ra.sent + rb.sent).toBe(2);
    for (const id of fresh) expect((await status(id)).emailStatus).toBe('SENT');
  });

  it('a recipient e-mailed within the gap waits; his row goes back unspent', async () => {
    const e = await request();
    const again = await notify(ids.mgr, 'REQUEST_FYI', e);
    const t = new FakeTransport();
    const r = await run(t);
    expect(t.sent).toEqual([]);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    expect(await status(again)).toMatchObject({ emailStatus: null, emailedAt: null, emailAttempts: 0, emailLeaseUntil: null });
  });

  it('a supervisor who does not manage the request’s region is not e-mailed "please review"', async () => {
    const e = await request({ submittedById: ids.farSales });
    const far = await notify(ids.far, 'EDIT_SUBMITTED', e);
    const t = new FakeTransport();
    await run(t);
    expect(t.sent.map((m) => m.to)).not.toContain(addr(ids.far));
    expect((await status(far)).emailStatus).toBe('SKIPPED_RESOLVED');
  });

  it('rows that can never be sent are marked before the claim: a small claim limit still reaches the approver', async () => {
    // Scoped to users with no open rows left, so the claim sees exactly these.
    const scope = { userIds: [ids.viewer, ids.stw, ids.sales, ids.mgr3] };
    const e = await request();
    const at = (min: number) => ({ createdAt: new Date(Date.now() - min * 60_000) });
    const never = [
      await notify(ids.sales, 'EDIT_STAGE_ADVANCED', e, at(9)),
      await notify(ids.viewer, 'EDIT_STAGE_ADVANCED', e, at(8)),
      await notify(ids.stw, 'TEMIX_UPLOAD_READY', e, at(7)),
    ];
    const act = await notify(ids.mgr3, 'EDIT_SUBMITTED', e, at(1));
    const t = new FakeTransport();
    const r = await drain.runEmailDrain({
      store: storeOf.prismaOutboxStore(prisma, scope),
      transport: t,
      config: CONFIG,
      policy: { ...EMAIL_DELIVERY, claimLimit: 2 },
    });
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(t.sent.map((m) => m.to)).toEqual([addr(ids.mgr3)]);
    expect((await status(act)).emailStatus).toBe('SENT');
    expect((await status(never[0]!)).emailStatus).toBe('SKIPPED_ROLE');
    expect((await status(never[1]!)).emailStatus).toBe('SKIPPED_ROLE');
    expect((await status(never[2]!)).emailStatus).toBe('SKIPPED_KIND');
  });

  it('owner decision 6: the GM gets a credit request at his step and a late request in ONE e-mail; a late request reaches the region’s Managers, not another region’s', async () => {
    const { resolveChain } = await import('@/lib/approval-chains');
    const credit = await request({
      approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT) as never,
      currentStepIndex: 2,
      pendingRole: 'GM',
    });
    const late = await request();
    const rows = {
      gmStep: await notify(ids.gm, 'EDIT_STAGE_ADVANCED', credit),
      gmLate: await notify(ids.gm, 'SLA_BREACH', late),
      mgrLate: await notify(ids.mgr4, 'SLA_BREACH', late),
      farLate: await notify(ids.far, 'SLA_BREACH', late),
    };
    const t = new FakeTransport();
    const r = await drain.runEmailDrain({
      store: storeOf.prismaOutboxStore(prisma, { userIds: [ids.gm, ids.mgr4, ids.far] }),
      transport: t,
      config: CONFIG,
    });
    expect(r).toMatchObject({ sent: 2, failed: 0 });
    expect(t.sent.map((m) => m.to).sort()).toEqual([addr(ids.gm), addr(ids.mgr4)].sort());
    const gmMail = t.sent.find((m) => m.to === addr(ids.gm))!;
    expect(gmMail.subject).toBe('NMWC CRM: 2 requests waiting for you');
    expect(gmMail.text).toContain('Now at your approval step: a new-customer request');
    expect(gmMail.text).toContain('Overdue: a new-customer request');
    for (const m of t.sent) expect(`${m.subject}\n${m.text}`).not.toContain('ZZ Customer Legal Name');
    for (const id of [rows.gmStep, rows.gmLate, rows.mgrLate]) expect((await status(id)).emailStatus).toBe('SENT');
    expect((await status(rows.farLate)).emailStatus).toBe('SKIPPED_RESOLVED');
  });

  it('a claim is a lease: a second claim while it holds gets none of its rows', async () => {
    const e = await request();
    await notify(ids.acc, 'REQUEST_FYI', e);
    const store = storeOf.prismaOutboxStore(prisma, { userIds: USERS });
    const now = new Date();
    const args = { now, cutoff: new Date(now.getTime() - 3600_000), leaseUntil: new Date(now.getTime() + 300_000), limit: 50, maxAttempts: 5 };
    const [first, second] = await Promise.all([store.claim(args), store.claim(args)]);
    const ids1 = first.map((r) => r.id);
    const ids2 = second.map((r) => r.id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    expect(ids1.length + ids2.length).toBeGreaterThanOrEqual(1);
    // The claimed rows carry ids, kind and times only.
    for (const row of [...first, ...second]) expect(Object.keys(row).sort()).toEqual(['createdAt', 'editId', 'id', 'kind', 'readAt', 'userId']);
    await store.release([...ids1, ...ids2]);
  });
});
