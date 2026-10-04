// @vitest-environment node
/**
 * F1 (2026-10-05): the e-mail outbox drain against a real Postgres
 * (lib/email/outbox-store.ts + lib/email/drain.ts), with a fake transport — no
 * mail leaves the test.
 *
 *   - Only allowlisted, active recipients with an address are e-mailed; every
 *     other row is marked with why (SKIPPED_ROLE for the GM and the Steward,
 *     SKIPPED_INACTIVE, SKIPPED_NO_ADDRESS, SKIPPED_STALE, SKIPPED_RESOLVED).
 *   - A PRE_FEATURE row (what the migration made of every historical row) is never
 *     touched.
 *   - Two drains at once claim disjoint rows (FOR UPDATE SKIP LOCKED + lease):
 *     every row is sent exactly once.
 *   - A recipient e-mailed within the gap waits, and his rows go back unspent.
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

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const ENABLED = process.env.RUN_EMAIL_DRAIN === '1' && !!process.env.DATABASE_URL;

const tag = randomUUID().slice(0, 8);
const P = `ZZED-${tag}`;
const ids = {
  region: `${P}-region`,
  sales: `${P}-sales`,
  mgr: `${P}-mgr`,
  mgr2: `${P}-mgr2`,
  acc: `${P}-acc`,
  acc2: `${P}-acc2`,
  gm: `${P}-gm`,
  stw: `${P}-stw`,
  off: `${P}-off`,
  nomail: `${P}-nomail`,
};
const USERS = Object.entries(ids)
  .filter(([k]) => k !== 'region')
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
    const user = (id: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({
        data: { id, username: id, passwordHash: 'x', fullName: `ZZ ${role}`, role: role as never, email: addr(id), ...extra },
      });
    await user(ids.mgr, 'MANAGER');
    await user(ids.mgr2, 'MANAGER');
    await user(ids.acc, 'ACCOUNTANT');
    await user(ids.acc2, 'ACCOUNTANT');
    await user(ids.gm, 'GM');
    await user(ids.stw, 'STEWARD');
    await user(ids.off, 'MANAGER', { isActive: false });
    await user(ids.nomail, 'MANAGER', { email: null });
    await user(ids.sales, 'SALESMAN', { supervisorId: ids.mgr });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
      if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      await prisma.user.updateMany({ where: { id: { in: USERS } }, data: { supervisorId: null } });
      await prisma.user.deleteMany({ where: { id: { in: USERS } } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  /** A new-customer request at the Supervisor step, submitted by the suite's salesman. */
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
    expect((await status(rows.gm)).emailStatus).toBe('SKIPPED_ROLE');
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
