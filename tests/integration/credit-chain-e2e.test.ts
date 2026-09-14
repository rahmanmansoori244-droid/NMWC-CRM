// @vitest-environment node
/**
 * CREDIT-CHAIN E2E — walks a real CREDIT CREATE request through its full frozen
 * chain SUPERVISOR → FINANCE_MANAGER → GM → ACCOUNTANT against the isolated UAT
 * branch, pinning three requirements the pure unit tests can't reach:
 *
 *   R19  Materialize ONLY after the final approval. After every NON-final step
 *        the customer must NOT exist yet (no Customer row, edit still SUBMITTED).
 *        Only the ACCOUNTANT (final) step creates the customer.
 *   R17  FM/GM/ACC cannot amend the credit figures. The approve action accepts
 *        only an editId — no amount field — so the materialized customer's
 *        creditLimit / paymentTermDays equal the salesman's ORIGINAL request.
 *   R26  Concurrency: two approvals of the SAME final step race — exactly one
 *        succeeds (atomic claim), the other is refused NOT_PENDING. No double
 *        materialization.
 *
 *   RUN_CREDIT_CHAIN=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/credit-chain-e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });
const ENABLED = process.env.RUN_CREDIT_CHAIN === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('CREDIT create chain SUP→FM→GM→ACC (R19/R17/R26)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let creates: typeof import('@/services/creates');
  let edits: typeof import('@/services/edits');

  const tag = randomUUID().slice(0, 8);
  const ids = {
    region: '', route: '',
    salesman: `ZZCC-sales-${tag}`, supervisor: `ZZCC-sup-${tag}`,
    fm: `ZZCC-fm-${tag}`, gm: `ZZCC-gm-${tag}`, acc: `ZZCC-acc-${tag}`,
  };
  const legalName = `ZZ-SYN Credit Chain ${tag}`;
  const REQUESTED_LIMIT = 7777;
  const REQUESTED_DAYS = 45;
  let channelId = '', subChannelId = '';
  let editId = '';

  const asUser = (u: string, role: string) => { current = { id: u, role, username: u }; };

  async function mkAtt(kind: 'CR' | 'SHOP' | 'SIGNBOARD' | 'GUARANTEE') {
    const a = await prisma.attachment.create({
      data: {
        kind, r2Key: `uat/${kind.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}.jpg`,
        mimeType: kind === 'GUARANTEE' ? 'application/pdf' : 'image/jpeg',
        bytes: 1000, capturedById: ids.salesman, capturedAt: new Date(),
      },
    });
    return a.id;
  }

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    edits = await import('@/services/edits');

    const region = await prisma.region.create({ data: { name: `ZZCC Region ${tag}`, code: `ZZCC-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZCC Route ${tag}`, code: `ZZCC-RT-${tag}`, regionId: region.id } });
    ids.route = route.id;

    // Approvers first (supervisor referenced by salesman).
    await prisma.user.create({ data: { id: ids.supervisor, username: ids.supervisor, passwordHash: 'x', fullName: 'ZZ Sup', role: 'SUPERVISOR' } });
    await prisma.user.create({ data: { id: ids.fm, username: ids.fm, passwordHash: 'x', fullName: 'ZZ FM', role: 'FINANCE_MANAGER' } });
    await prisma.user.create({ data: { id: ids.gm, username: ids.gm, passwordHash: 'x', fullName: 'ZZ GM', role: 'GM' } });
    // Accountant is region-scoped: manage exactly this region so REGION_OVERLAP passes.
    await prisma.user.create({ data: { id: ids.acc, username: ids.acc, passwordHash: 'x', fullName: 'ZZ Acc', role: 'ACCOUNTANT', managedRegions: { connect: { id: region.id } } } });
    // Salesman owns the route + reports to the supervisor.
    await prisma.user.create({ data: { id: ids.salesman, username: ids.salesman, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: route.id, supervisorId: ids.supervisor } });

    const ch = await prisma.channel.findFirst({ include: { subChannels: { take: 1 } } });
    if (!ch || ch.subChannels.length === 0) throw new Error('No channel/subchannel seeded.');
    channelId = ch.id; subChannelId = ch.subChannels[0].id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { OR: [{ submittedById: ids.salesman }, { customerDraft: { legalName } }] }, select: { id: true, customerId: true } });
      const edIds = eds.map((e) => e.id);
      const custIds = eds.map((e) => e.customerId).filter((x): x is string => !!x);
      if (edIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: edIds } } });
        await prisma.editBranchDraft.deleteMany({ where: { editId: { in: edIds } } });
        await prisma.editCustomerDraft.deleteMany({ where: { editId: { in: edIds } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: edIds } } });
      }
      const allCust = [...custIds, ...(await prisma.customer.findMany({ where: { legalName }, select: { id: true } })).map((c) => c.id)];
      if (allCust.length) {
        await prisma.branch.deleteMany({ where: { customerId: { in: allCust } } });
        await prisma.customer.deleteMany({ where: { id: { in: allCust } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: ids.salesman } });
      await purgeAuditLog(prisma, { where: { actorId: { in: [ids.salesman, ids.supervisor, ids.fm, ids.gm, ids.acc] } } });
      await prisma.notification.deleteMany({ where: { userId: { in: [ids.salesman, ids.supervisor, ids.fm, ids.gm, ids.acc] } } });
      await prisma.user.deleteMany({ where: { id: { in: [ids.salesman, ids.supervisor, ids.fm, ids.gm, ids.acc] } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) { console.error('cleanup', e); }
    await prisma.$disconnect();
  });

  async function approve(editId: string) {
    const fd = new FormData();
    fd.set('editId', editId);
    return edits.approveEditAction(fd);
  }
  const editState = () => prisma.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true, currentStepIndex: true, pendingRole: true, customerId: true } });
  const customerCount = () => prisma.customer.count({ where: { legalName } });

  it('submits the CREDIT request and freezes the 4-step chain', async () => {
    asUser(ids.salesman, 'SALESMAN');
    const res = await creates.submitCreateAction({
      isDraft: false,
      customer: {
        legalName, paymentTerms: 'CREDIT', channelId, subChannelId,
        primaryPhone: `+96890${String(400000 + (parseInt(tag, 16) % 90000)).slice(0, 6)}`,
        contactPerson: `ZZ Contact ${tag}`, crNumber: `98${String(parseInt(tag, 16) % 900000).padStart(6, '0')}`,
        crPhotoAttachmentId: await mkAtt('CR'),
      },
      credit: { requestedCreditLimit: REQUESTED_LIMIT, requestedPaymentTermDays: REQUESTED_DAYS },
      guaranteeAttachmentIds: [await mkAtt('GUARANTEE')],
      branches: [{
        branchName: `ZZ Branch ${tag}`, address: `ZZ Way 1, ${tag}`, gpsLat: 23.6, gpsLng: 58.4,
        dayOfVisit: 'MON', coolersCount: 1, standsCount: 1, emptyBottlesCount: 5,
        shopPhotoAttachmentId: await mkAtt('SHOP'), signboardPhotoAttachmentId: await mkAtt('SIGNBOARD'),
      }],
    });
    if (!res.ok) console.error('SUBMIT FAILED', JSON.stringify(res));
    expect(res.ok).toBe(true);
    editId = (res as { ok: true; data: { editId: string } }).data.editId;
    const st = await editState();
    expect(st.state).toBe('SUBMITTED');
    expect(st.currentStepIndex).toBe(0);
    expect(st.pendingRole).toBe('SUPERVISOR');
    expect(st.customerId).toBeNull();
    expect(await customerCount()).toBe(0); // R19: nothing materialized at submit
  });

  it('R19: SUPERVISOR approve advances to FM — still no customer', async () => {
    asUser(ids.supervisor, 'SUPERVISOR');
    const res = await approve(editId);
    expect(res.ok).toBe(true);
    const st = await editState();
    expect(st.state).toBe('SUBMITTED');
    expect(st.currentStepIndex).toBe(1);
    expect(st.pendingRole).toBe('FINANCE_MANAGER');
    expect(await customerCount()).toBe(0);
  });

  it('R19: FINANCE_MANAGER approve advances to GM — still no customer', async () => {
    asUser(ids.fm, 'FINANCE_MANAGER');
    const res = await approve(editId);
    expect(res.ok).toBe(true);
    const st = await editState();
    expect(st.currentStepIndex).toBe(2);
    expect(st.pendingRole).toBe('GM');
    expect(await customerCount()).toBe(0);
  });

  it('R19: GM approve advances to ACCOUNTANT — still no customer', async () => {
    asUser(ids.gm, 'GM');
    const res = await approve(editId);
    expect(res.ok).toBe(true);
    const st = await editState();
    expect(st.currentStepIndex).toBe(3);
    expect(st.pendingRole).toBe('ACCOUNTANT');
    expect(await customerCount()).toBe(0);
  });

  it('R26 + R19 + R17: two concurrent ACCOUNTANT approvals — exactly one wins, customer materializes once with the ORIGINAL figures', async () => {
    asUser(ids.acc, 'ACCOUNTANT');
    const [a, b] = await Promise.all([approve(editId), approve(editId)]);
    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    // R26: atomic claim — exactly one approval succeeds.
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { ok: false; code?: string }).code).toBe('NOT_PENDING');

    // R19: materialized exactly once, now.
    expect(await customerCount()).toBe(1);
    const st = await editState();
    expect(st.state).toBe('APPROVED');
    expect(st.customerId).not.toBeNull();

    // R17: approvers never amended — the live customer carries the salesman's
    // originally requested credit figures verbatim.
    const cust = await prisma.customer.findUniqueOrThrow({ where: { id: st.customerId! }, select: { creditLimit: true, paymentTermDays: true, paymentTerms: true } });
    expect(cust.paymentTerms).toBe('CREDIT');
    expect(Number(cust.creditLimit)).toBe(REQUESTED_LIMIT);
    expect(cust.paymentTermDays).toBe(REQUESTED_DAYS);
  });
});
