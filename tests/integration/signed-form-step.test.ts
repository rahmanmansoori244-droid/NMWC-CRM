// @vitest-environment node
/**
 * Owner decisions 2026-10-11 — the signed-application step of the CREDIT chain,
 * against Postgres (services/signed-form.ts):
 *
 *   - two confirms of the same upload race (a double tap, a retry overlapping its
 *     first try): exactly one moves the request on; the other is answered as
 *     landed, and one FORM_UPLOADED row exists;
 *   - a Manager removes a credit document while the salesman's page is open: his
 *     confirm is refused STALE_VIEW and writes nothing; from a fresh page it lands;
 *   - the salesman withdraws a request the customer will not sign: it is closed,
 *     every alert about it settled, and a confirm afterwards lands on nothing;
 *   - review (2026-10-11): after a Finance Manager send-back, a page opened
 *     before it sends new pages: told to reload (STALE_VIEW), not "sent" from the
 *     earlier upload, and the new pages stay unclaimed;
 *   - review (2026-10-11, Q-signed-form-stranded): his Manager disables him while
 *     a request waits at his step: refused, then, told to withdraw it, the
 *     request is closed with its alerts answered and the account disabled.
 *
 * Who the SLA sweep tells of a late signed application (the salesman, the
 * region's Managers, then the GM and the Sales Director) is pinned with the
 * sweep's own code in tests/unit/sla-escalate-sweep.test.ts: the real sweep is
 * company-wide and would escalate every overdue UAT request, not only these.
 *
 * Needs the credit-flow migrations on the database (20261011120000, 20261011120100).
 *
 *   RUN_SIGNED_FORM=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/signed-form-step.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });
const ENABLED = process.env.RUN_SIGNED_FORM === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('the signed-application step on Postgres (owner decisions 2026-10-11)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let creates: typeof import('@/services/creates');
  let edits: typeof import('@/services/edits');
  let photos: typeof import('@/services/photos');
  let signedForm: typeof import('@/services/signed-form');
  let users: typeof import('@/services/users');

  const tag = randomUUID().slice(0, 8);
  const ids = {
    region: '',
    route: '',
    salesman: `ZZSF-sales-${tag}`,
    supervisor: `ZZSF-sup-${tag}`,
    manager: `ZZSF-mgr-${tag}`,
    sd: `ZZSF-sd-${tag}`,
    fm: `ZZSF-fm-${tag}`,
  };
  const people = () => [ids.salesman, ids.supervisor, ids.manager, ids.sd, ids.fm];
  const nameR = `ZZ-SYN Signed Form R ${tag}`;
  const nameW = `ZZ-SYN Signed Form W ${tag}`;
  const nameS = `ZZ-SYN Signed Form S ${tag}`;
  const nameD = `ZZ-SYN Signed Form D ${tag}`;
  let channelId = '';
  let subChannelId = '';
  const asUser = (u: string, role: string) => {
    current = { id: u, role, username: u };
  };
  const digits = (salt: number) => String(100000 + ((parseInt(tag, 16) + salt) % 900000));

  async function mkAtt(
    kind: 'CR' | 'SHOP' | 'SIGNBOARD' | 'GUARANTEE' | 'ID_CARD' | 'MEMBERSHIP_CERT' | 'VAT_CERT' | 'TAX_CARD' | 'CREDIT_FORM',
    editId?: string
  ) {
    const a = await prisma.attachment.create({
      data: {
        kind,
        r2Key: `uat/${kind.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById: ids.salesman,
        capturedAt: new Date(),
        ...(editId ? { editId } : {}),
      },
    });
    return a.id;
  }

  async function decide(kind: 'approve' | 'reject', editId: string) {
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', await freshDecisionToken(prisma, editId));
    if (kind === 'reject') {
      fd.set('reason', 'The company stamp is missing from the form.');
      fd.set('category', 'other');
    }
    return kind === 'approve' ? edits.approveEditAction(fd) : edits.rejectEditAction(fd);
  }

  /** A CREDIT request walked to the signed-application step, with its credit documents (an ID card among them). */
  async function atSignedForm(name: string, salt: number): Promise<{ editId: string; idCard: string }> {
    asUser(ids.salesman, 'SALESMAN');
    // Owner decisions 2026-10-11 (part B): sent with the e-mail and the four credit documents.
    const idCard = await mkAtt('ID_CARD');
    const res = await creates.submitCreateAction({
      isDraft: false,
      customer: {
        legalName: name,
        paymentTerms: 'CREDIT',
        channelId,
        subChannelId,
        primaryPhone: `+96896${digits(salt)}`,
        contactPerson: `ZZ Contact ${tag}`,
        crNumber: `92${digits(salt + 1)}`,
        crPhotoAttachmentId: await mkAtt('CR'),
        email: `zz.signed.${tag}@example.com`,
      },
      credit: { requestedCreditLimit: 600, requestedPaymentTermDays: 30 },
      guaranteeAttachmentIds: [await mkAtt('GUARANTEE')],
      creditDocuments: {
        ID_CARD: [idCard],
        MEMBERSHIP_CERT: [await mkAtt('MEMBERSHIP_CERT')],
        VAT_CERT: [await mkAtt('VAT_CERT')],
        TAX_CARD: [await mkAtt('TAX_CARD')],
      },
      branches: [
        {
          branchName: `ZZ Branch ${name}`,
          address: `ZZ Way ${salt}, ${tag}`,
          gpsLat: 23.66,
          gpsLng: 58.46,
          dayOfVisit: 'MON',
          coolersCount: 1,
          standsCount: 1,
          emptyBottlesCount: 5,
          shopPhotoAttachmentId: await mkAtt('SHOP'),
          signboardPhotoAttachmentId: await mkAtt('SIGNBOARD'),
        },
      ],
    });
    if (!res.ok) console.error('SIGNED FORM SUBMIT FAILED', JSON.stringify(res));
    expect(res.ok).toBe(true);
    const editId = (res as { ok: true; data: { editId: string } }).data.editId;
    asUser(ids.supervisor, 'SUPERVISOR');
    expect((await decide('approve', editId)).ok).toBe(true);
    asUser(ids.sd, 'SALES_DIRECTOR');
    expect((await decide('approve', editId)).ok).toBe(true);
    const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect([st.currentStepIndex, st.pendingRole]).toEqual([2, 'SALESMAN']);
    return { editId, idCard };
  }

  /** Everything a confirm writes: if none of it moved, it wrote nothing. */
  const footprint = async (editId: string) => ({
    row: await prisma.customerEdit.findUniqueOrThrow({
      where: { id: editId },
      select: { state: true, currentStepIndex: true, pendingRole: true, stageEnteredAt: true },
    }),
    decisions: await prisma.editApproval.count({ where: { editId } }),
    // A refused confirm records its lost race (gap 22, CONFLICT); it writes nothing else.
    audits: await prisma.auditLog.count({ where: { entityId: editId, action: { not: 'CONFLICT' } } }),
    pages: await prisma.attachment.count({ where: { editId, kind: 'CREDIT_FORM', deletedAt: null } }),
  });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    edits = await import('@/services/edits');
    photos = await import('@/services/photos');
    signedForm = await import('@/services/signed-form');
    users = await import('@/services/users');
    const region = await prisma.region.create({ data: { name: `ZZSF Region ${tag}`, code: `ZZSF-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZSF Route ${tag}`, code: `ZZSF-RT-${tag}`, regionId: region.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.supervisor, username: ids.supervisor, passwordHash: 'x', fullName: 'ZZ Sup', role: 'SUPERVISOR' } });
    await prisma.user.create({
      data: { id: ids.manager, username: ids.manager, passwordHash: 'x', fullName: 'ZZ Mgr', role: 'MANAGER', managedRegions: { connect: { id: region.id } } },
    });
    await prisma.user.create({ data: { id: ids.sd, username: ids.sd, passwordHash: 'x', fullName: 'ZZ SD', role: 'SALES_DIRECTOR' } });
    await prisma.user.create({ data: { id: ids.fm, username: ids.fm, passwordHash: 'x', fullName: 'ZZ FM', role: 'FINANCE_MANAGER' } });
    await prisma.user.create({
      data: { id: ids.salesman, username: ids.salesman, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: route.id, supervisorId: ids.supervisor },
    });
    const ch = await prisma.channel.findFirst({ include: { subChannels: { take: 1 } } });
    if (!ch || ch.subChannels.length === 0) throw new Error('No channel/subchannel seeded.');
    channelId = ch.id;
    subChannelId = ch.subChannels[0]!.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { submittedById: ids.salesman }, select: { id: true } });
      const edIds = eds.map((e) => e.id);
      if (edIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: edIds } } });
        await prisma.notification.deleteMany({ where: { editId: { in: edIds } } });
        await prisma.editBranchDraft.deleteMany({ where: { editId: { in: edIds } } });
        await prisma.editCustomerDraft.deleteMany({ where: { editId: { in: edIds } } });
        await prisma.attachment.updateMany({ where: { editId: { in: edIds } }, data: { editId: null } });
        await purgeCustomerEdits(prisma, { where: { id: { in: edIds } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: ids.salesman } });
      await purgeAuditLog(prisma, { where: { actorId: { in: people() } } });
      await prisma.notification.deleteMany({ where: { userId: { in: people() } } });
      await prisma.user.deleteMany({ where: { id: { in: people() } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  let editR = '';
  let idCardR = '';

  it('two confirms of the same upload at once: one moves it on, the other is answered as landed', async () => {
    ({ editId: editR, idCard: idCardR } = await atSignedForm(nameR, 81));
    asUser(ids.salesman, 'SALESMAN');
    const pages = [await mkAtt('CREDIT_FORM'), await mkAtt('CREDIT_FORM')];
    const token = await freshDecisionToken(prisma, editR);
    const send = () => signedForm.submitSignedFormAction({ editId: editR, attachmentIds: pages, decisionToken: token });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    const replays = [a, b].map((r) => (r as { ok: true; data: { replayed: boolean } }).data.replayed).sort();
    expect(replays).toEqual([false, true]);
    expect(await prisma.editApproval.count({ where: { editId: editR, decision: 'FORM_UPLOADED' } })).toBe(1);
    const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editR } });
    expect([st.currentStepIndex, st.pendingRole]).toEqual([3, 'FINANCE_MANAGER']);
    // The Finance Manager is told once.
    expect(await prisma.notification.count({ where: { editId: editR, userId: ids.fm, kind: 'EDIT_STAGE_ADVANCED' } })).toBe(1);
    // An UPDATE audit row, never a STEP_APPROVE by the salesman.
    expect(await prisma.auditLog.count({ where: { entityId: editR, actorId: ids.salesman, action: 'STEP_APPROVE' } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { entityId: editR, actorId: ids.salesman, reason: 'signed credit application uploaded by the salesman' } })
    ).toBe(1);
  });

  it('a Manager removes a credit document while the salesman’s page is open: his confirm decides nothing; a fresh page lands', async () => {
    // The Finance Manager sends it back for the signed application: a new visit to the step.
    asUser(ids.fm, 'FINANCE_MANAGER');
    expect((await decide('reject', editR)).ok).toBe(true);
    asUser(ids.salesman, 'SALESMAN');
    const page = await freshDecisionToken(prisma, editR);
    const newPage = await mkAtt('CREDIT_FORM');
    // While the request is with the approvers, the salesman cannot remove it himself.
    expect((await photos.detachPhotoAction({ attachmentId: idCardR })).ok).toBe(false);
    asUser(ids.manager, 'MANAGER');
    const removed = await photos.detachPhotoAction({ attachmentId: idCardR });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);

    asUser(ids.salesman, 'SALESMAN');
    const before = await footprint(editR);
    const stale = await signedForm.submitSignedFormAction({ editId: editR, attachmentIds: [newPage], decisionToken: page });
    expect(stale).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expect(await footprint(editR)).toEqual(before);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: newPage } })).editId).toBeNull();

    const ok = await signedForm.submitSignedFormAction({
      editId: editR,
      attachmentIds: [newPage],
      decisionToken: await freshDecisionToken(prisma, editR),
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    // The pages of the first upload, not sent again, are released.
    expect(await prisma.attachment.count({ where: { editId: editR, kind: 'CREDIT_FORM', deletedAt: null } })).toBe(1);
  });

  it('the customer will not sign: the salesman withdraws it, every alert about it is settled, and a confirm lands on nothing', async () => {
    const { editId } = await atSignedForm(nameW, 91);
    asUser(ids.salesman, 'SALESMAN');
    const token = await freshDecisionToken(prisma, editId);
    expect(await prisma.notification.count({ where: { editId, readAt: null, userId: { in: [ids.salesman, ids.supervisor] } } })).toBeGreaterThan(0);
    const res = await creates.withdrawCreateAction({ editId });
    expect(res, JSON.stringify(res)).toEqual({ ok: true, data: { editId } });
    const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect([st.state, st.pendingRole, st.slaDueAt]).toEqual(['REJECTED', null, null]);
    // His alert and the print row are answered.
    expect(
      await prisma.notification.count({
        where: { editId, readAt: null, kind: { in: ['SIGNED_FORM_REQUESTED', 'EDIT_STAGE_ADVANCED', 'SLA_BREACH'] }, userId: { not: ids.salesman } },
      })
    ).toBe(0);
    expect(await prisma.notification.count({ where: { editId, userId: ids.salesman, kind: 'SIGNED_FORM_REQUESTED', readAt: null } })).toBe(0);
    const late = await signedForm.submitSignedFormAction({
      editId,
      attachmentIds: [await mkAtt('CREDIT_FORM')],
      decisionToken: token,
    });
    expect(late).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });
  it('after a Finance Manager send-back, a page opened before it is told to reload — not "sent" from the earlier upload', async () => {
    const { editId } = await atSignedForm(nameS, 101);
    asUser(ids.salesman, 'SALESMAN');
    const before = await freshDecisionToken(prisma, editId);
    const first = await signedForm.submitSignedFormAction({ editId, attachmentIds: [await mkAtt('CREDIT_FORM')], decisionToken: before });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    asUser(ids.fm, 'FINANCE_MANAGER');
    expect((await decide('reject', editId)).ok).toBe(true);

    asUser(ids.salesman, 'SALESMAN');
    const newPage = await mkAtt('CREDIT_FORM');
    const was = await footprint(editId);
    const stale = await signedForm.submitSignedFormAction({ editId, attachmentIds: [newPage], decisionToken: before });
    expect(stale).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expect(await footprint(editId)).toEqual(was);
    expect(was.row).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 2, pendingRole: 'SALESMAN' });
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: newPage } })).editId).toBeNull();
    expect(await prisma.editApproval.count({ where: { editId, decision: 'FORM_UPLOADED' } })).toBe(1);
  });

  // Last: it disables the salesman.
  it('his Manager disables him while a request waits at his step: refused, then withdrawn with the disable', async () => {
    const { editId } = await atSignedForm(nameD, 111);
    asUser(ids.manager, 'MANAGER');
    const form = (withdraw: boolean) => {
      const fd = new FormData();
      fd.set('userId', ids.salesman);
      if (withdraw) fd.set('withdrawCreates', 'on');
      return fd;
    };
    const refused = await users.toggleUserActiveAction(form(false));
    expect(refused, JSON.stringify(refused)).toMatchObject({
      ok: false,
      fields: { withdrawCreates: expect.stringMatching(/credit request\(s\) waiting for him to upload the customer's signed credit application/) },
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.salesman } })).isActive).toBe(true);
    expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } })).state).toBe('SUBMITTED');

    const done = await users.toggleUserActiveAction(form(true));
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.salesman } })).isActive).toBe(false);
    expect(await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } })).toMatchObject({
      state: 'REJECTED',
      pendingRole: null,
      slaDueAt: null,
      decisionCategory: 'withdrawn',
      reviewedById: ids.manager,
    });
    // Nothing about it waits on anyone now. His own progress pings ("Request
    // advanced") are left alone, as on every decision and on his own withdraw
    // (lib/notify-policy.ts SETTLED_ON_DECISION_KINDS); his must-act alert and
    // any late-request alert are answered.
    expect(
      await prisma.notification.count({
        where: { editId, readAt: null, kind: { in: ['SIGNED_FORM_REQUESTED', 'EDIT_STAGE_ADVANCED', 'SLA_BREACH'] }, userId: { not: ids.salesman } },
      })
    ).toBe(0);
    const hisUnread = await prisma.notification.findMany({
      where: { editId, readAt: null, userId: ids.salesman, kind: { in: ['SIGNED_FORM_REQUESTED', 'EDIT_STAGE_ADVANCED', 'SLA_BREACH'] } },
      select: { kind: true, title: true },
    });
    expect(hisUnread.every((r) => r.kind === 'EDIT_STAGE_ADVANCED' && r.title === 'Request advanced'), JSON.stringify(hisUnread)).toBe(true);
    expect(
      await prisma.auditLog.count({ where: { entityId: editId, actorId: ids.manager, reason: 'withdrawn when the account was disabled' } })
    ).toBe(1);
    // No request of his is left at the step.
    expect(await prisma.customerEdit.count({ where: { submittedById: ids.salesman, state: 'SUBMITTED', pendingRole: 'SALESMAN' } })).toBe(0);
  });
});
