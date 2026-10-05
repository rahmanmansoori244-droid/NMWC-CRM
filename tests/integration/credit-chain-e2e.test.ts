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
 *        only an editId and the decision token — no amount field; the token
 *        binds the figures on screen but cannot change them — so the
 *        materialized customer's creditLimit / paymentTermDays equal the
 *        salesman's ORIGINAL request.
 *   R26  Concurrency: two approvals of the SAME final step race — exactly one
 *        succeeds (atomic claim), the other is refused NOT_PENDING. No double
 *        materialization.
 *   N01  A decision is bound to the request as the reviewer's page showed it
 *        (lib/decision-token.ts). A page kept open across a step-back or a
 *        correction round is refused STALE_VIEW — approve, reject and bulk,
 *        mid-chain and at the final step — and writes nothing. So is one kept
 *        open while the salesman removed a guarantee document, including a
 *        removal still in flight when the decision reads them (FOR SHARE).
 *
 *   RUN_CREDIT_CHAIN=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/credit-chain-e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { guaranteeDigest, parseDecisionToken } from '@/lib/decision-token';
import { CREDIT_BULK_REFUSED_MESSAGE } from '@/lib/bulk-run';
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
  let photos: typeof import('@/services/photos');

  const tag = randomUUID().slice(0, 8);
  const ids = {
    region: '', route: '',
    salesman: `ZZCC-sales-${tag}`, supervisor: `ZZCC-sup-${tag}`,
    fm: `ZZCC-fm-${tag}`, gm: `ZZCC-gm-${tag}`, acc: `ZZCC-acc-${tag}`,
  };
  const legalName = `ZZ-SYN Credit Chain ${tag}`;
  // N01's two requests: A (CREDIT, corrected mid-chain) and B (CASH).
  const nameA = `ZZ-SYN Credit Chain N01-A ${tag}`;
  const nameB = `ZZ-SYN Credit Chain N01-B ${tag}`;
  // And D (CREDIT, two guarantee documents), whose salesman removes them while pages are open.
  const nameD = `ZZ-SYN Credit Chain N01-D ${tag}`;
  const allNames = [legalName, nameA, nameB, nameD];
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
    photos = await import('@/services/photos');

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
      const eds = await prisma.customerEdit.findMany({ where: { OR: [{ submittedById: ids.salesman }, { customerDraft: { legalName: { in: allNames } } }] }, select: { id: true, customerId: true } });
      const edIds = eds.map((e) => e.id);
      const custIds = eds.map((e) => e.customerId).filter((x): x is string => !!x);
      if (edIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: edIds } } });
        await prisma.editBranchDraft.deleteMany({ where: { editId: { in: edIds } } });
        await prisma.editCustomerDraft.deleteMany({ where: { editId: { in: edIds } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: edIds } } });
      }
      const allCust = [...custIds, ...(await prisma.customer.findMany({ where: { legalName: { in: allNames } }, select: { id: true } })).map((c) => c.id)];
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

  /** Approve from a freshly opened review page: its decision token is the row now (N01). */
  async function approve(editId: string) {
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', await freshDecisionToken(prisma, editId));
    return edits.approveEditAction(fd);
  }
  const editState = () => prisma.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true, currentStepIndex: true, pendingRole: true, customerId: true, stageEnteredAt: true, slaDueAt: true } });
  // Item 9: the stage each step was decided in, as the change request held it
  // BEFORE that decision — what the step's EditApproval snapshot must record.
  const stageBefore: { stageEnteredAt: Date | null; slaDueAt: Date | null }[] = [];
  const keepStage = (st: { stageEnteredAt: Date | null; slaDueAt: Date | null }) =>
    stageBefore.push({ stageEnteredAt: st.stageEnteredAt, slaDueAt: st.slaDueAt });
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
    keepStage(st);
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
    keepStage(st);
  });

  it('R19: FINANCE_MANAGER approve advances to GM — still no customer', async () => {
    asUser(ids.fm, 'FINANCE_MANAGER');
    const res = await approve(editId);
    expect(res.ok).toBe(true);
    const st = await editState();
    expect(st.currentStepIndex).toBe(2);
    expect(st.pendingRole).toBe('GM');
    expect(await customerCount()).toBe(0);
    keepStage(st);
  });

  it('R19: GM approve advances to ACCOUNTANT — still no customer', async () => {
    asUser(ids.gm, 'GM');
    const res = await approve(editId);
    expect(res.ok).toBe(true);
    const st = await editState();
    expect(st.currentStepIndex).toBe(3);
    expect(st.pendingRole).toBe('ACCOUNTANT');
    expect(await customerCount()).toBe(0);
    keepStage(st);
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

  it('item 9: every step decision records the stage it decided — entered, due, working minutes', async () => {
    // The change request keeps SLA state for its CURRENT stage only; this ledger
    // row is the only lasting record of whether each stage met its SLA.
    const steps = await prisma.editApproval.findMany({ where: { editId }, orderBy: { stepIndex: 'asc' } });
    expect(steps.map((s) => s.role)).toEqual(['SUPERVISOR', 'FINANCE_MANAGER', 'GM', 'ACCOUNTANT']);
    expect(stageBefore).toHaveLength(4);
    for (const [i, s] of steps.entries()) {
      // Exactly the stage that was decided — not the one it advanced to, which
      // would read as "decided in 0 minutes, on time" for every step.
      expect(s.stageEnteredAt, s.role).toEqual(stageBefore[i]!.stageEnteredAt);
      expect(s.slaDueAt, s.role).toEqual(stageBefore[i]!.slaDueAt);
      // Equal is not enough: null on both sides would pass, and every decision
      // would then count as untracked (review of f05752e).
      expect(s.stageEnteredAt, s.role).not.toBeNull();
      expect(s.slaDueAt, s.role).not.toBeNull();
      expect(s.slaDueAt!.getTime(), s.role).toBeGreaterThan(s.stageEnteredAt!.getTime());
      expect(s.workingMinutes, s.role).not.toBeNull();
      expect(s.workingMinutes!, s.role).toBeGreaterThanOrEqual(0);
    }
    // And the stage after each advance began when that advance was made, so no
    // two steps share a stage.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.stageEnteredAt!.getTime()).toBeGreaterThan(steps[i - 1]!.stageEnteredAt!.getTime());
    }
  });

  // ── N01 (auditor recheck, 2026-09-27) ──────────────────────────────────────
  // Approve and reject used to send only the id; the server reloaded the row and
  // claimed on what it found, so a tab opened on cycle 1 approved a corrected
  // cycle 2 it had never shown. A (CREDIT) goes through a step-back and a
  // correction round while tokens taken earlier are kept, the way an open tab
  // keeps them; B (CASH) shares A's bulk call at the final step.
  describe('N01: every decision is bound to the request as the reviewer saw it', () => {
    let editA = '';
    let editB = '';
    const attA = { cr: '', guarantee: '', shop: '', signboard: '' };
    // Pages kept open while the request changed underneath them.
    const kept = { supCycle1: '', fmVisit1: '', fmCycle1Visit2: '', accVisit1: '' };
    const digits = (salt: number) => String(100000 + ((parseInt(tag, 16) + salt) % 900000));

    const submitA = (credit: { requestedCreditLimit: number; requestedPaymentTermDays: number }) =>
      creates.submitCreateAction({
        ...(editA ? { editId: editA } : {}),
        isDraft: false,
        customer: {
          legalName: nameA, paymentTerms: 'CREDIT', channelId, subChannelId,
          primaryPhone: `+96891${digits(11)}`, contactPerson: `ZZ Contact A ${tag}`,
          crNumber: `97${digits(12)}`, crPhotoAttachmentId: attA.cr,
        },
        credit,
        guaranteeAttachmentIds: [attA.guarantee],
        branches: [{
          branchName: `ZZ Branch A ${tag}`, address: `ZZ Way 2, ${tag}`, gpsLat: 23.61, gpsLng: 58.41,
          dayOfVisit: 'MON', coolersCount: 1, standsCount: 1, emptyBottlesCount: 5,
          shopPhotoAttachmentId: attA.shop, signboardPhotoAttachmentId: attA.signboard,
        }],
      });

    const decide = (kind: 'approve' | 'reject', id: string, token: string) => {
      const fd = new FormData();
      fd.set('editId', id);
      fd.set('decisionToken', token);
      if (kind === 'reject') {
        fd.set('reason', 'Please re-check the credit figures with the shop.');
        fd.set('category', 'wrong_info');
      }
      return kind === 'approve' ? edits.approveEditAction(fd) : edits.rejectEditAction(fd);
    };
    const fresh = (id: string) => freshDecisionToken(prisma, id);

    /** Everything a decision writes: if none of it moved, the decision wrote nothing. */
    const footprint = async (id: string, name: string) => ({
      row: await prisma.customerEdit.findUniqueOrThrow({
        where: { id },
        select: { state: true, cycle: true, currentStepIndex: true, pendingRole: true, stageEnteredAt: true, slaDueAt: true, reviewedAt: true },
      }),
      decisions: await prisma.editApproval.count({ where: { editId: id } }),
      audits: await prisma.auditLog.count({ where: { entityId: id } }),
      notifications: await prisma.notification.count({ where: { editId: id } }),
      customers: await prisma.customer.count({ where: { legalName: name } }),
    });
    const expectStale = (res: { ok: boolean }) => {
      expect(res.ok, JSON.stringify(res)).toBe(false);
      expect((res as { ok: false; code: string }).code).toBe('STALE_VIEW');
    };

    it('A is submitted at OMR 400 / 30 days, B as a CASH request; both wait on the Supervisor', async () => {
      asUser(ids.salesman, 'SALESMAN');
      attA.cr = await mkAtt('CR');
      attA.guarantee = await mkAtt('GUARANTEE');
      attA.shop = await mkAtt('SHOP');
      attA.signboard = await mkAtt('SIGNBOARD');
      const a = await submitA({ requestedCreditLimit: 400, requestedPaymentTermDays: 30 });
      if (!a.ok) console.error('N01 SUBMIT A FAILED', JSON.stringify(a));
      expect(a.ok).toBe(true);
      editA = (a as { ok: true; data: { editId: string } }).data.editId;

      const b = await creates.submitCreateAction({
        isDraft: false,
        customer: {
          legalName: nameB, paymentTerms: 'CASH', channelId, subChannelId,
          primaryPhone: `+96892${digits(21)}`, contactPerson: `ZZ Contact B ${tag}`,
          crNumber: `96${digits(22)}`, crPhotoAttachmentId: await mkAtt('CR'),
        },
        branches: [{
          branchName: `ZZ Branch B ${tag}`, address: `ZZ Way 3, ${tag}`, gpsLat: 23.62, gpsLng: 58.42,
          dayOfVisit: 'TUE', coolersCount: 1, standsCount: 1, emptyBottlesCount: 5,
          shopPhotoAttachmentId: await mkAtt('SHOP'), signboardPhotoAttachmentId: await mkAtt('SIGNBOARD'),
        }],
      });
      if (!b.ok) console.error('N01 SUBMIT B FAILED', JSON.stringify(b));
      expect(b.ok).toBe(true);
      editB = (b as { ok: true; data: { editId: string } }).data.editId;

      kept.supCycle1 = await fresh(editA);
      expect(parseDecisionToken(kept.supCycle1)).toMatchObject({ cycle: 1, stepIndex: 0, creditLimit: '400.000', paymentTermDays: 30 });
    });

    it('the Supervisor sends A on; the Finance Manager opens it (visit 1) and steps it back', async () => {
      asUser(ids.supervisor, 'SUPERVISOR');
      expect((await decide('approve', editA, await fresh(editA))).ok).toBe(true);
      asUser(ids.fm, 'FINANCE_MANAGER');
      kept.fmVisit1 = await fresh(editA);
      expect(parseDecisionToken(kept.fmVisit1)).toMatchObject({ cycle: 1, stepIndex: 1 });
      // The Finance Manager's first send-back in a cycle returns it one step.
      expect((await decide('reject', editA, kept.fmVisit1)).ok).toBe(true);
      const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editA } });
      expect([st.state, st.cycle, st.currentStepIndex]).toEqual(['SUBMITTED', 1, 0]);
    });

    it('same cycle, same step, a later visit: the visit-1 page cannot approve, and nothing is written', async () => {
      asUser(ids.supervisor, 'SUPERVISOR');
      expect((await decide('approve', editA, await fresh(editA))).ok).toBe(true);
      asUser(ids.fm, 'FINANCE_MANAGER');
      const before = await footprint(editA, nameA);
      expect([before.row.cycle, before.row.currentStepIndex]).toEqual([1, 1]); // FM again, visit 2
      expectStale(await decide('approve', editA, kept.fmVisit1));
      expect(await footprint(editA, nameA)).toEqual(before);
      kept.fmCycle1Visit2 = await fresh(editA);
    });

    it('correction round: the second send-back goes to the salesman, who corrects A to OMR 10,000 / 90 days', async () => {
      asUser(ids.fm, 'FINANCE_MANAGER');
      // A second send-back from the same step in one cycle goes to the salesman.
      expect((await decide('reject', editA, await fresh(editA))).ok).toBe(true);
      expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: editA } })).state).toBe('NEEDS_CORRECTION');
      asUser(ids.salesman, 'SALESMAN');
      const res = await submitA({ requestedCreditLimit: 10_000, requestedPaymentTermDays: 90 });
      if (!res.ok) console.error('N01 RESUBMIT A FAILED', JSON.stringify(res));
      expect(res.ok).toBe(true);
      const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editA } });
      expect([st.state, st.cycle, st.currentStepIndex]).toEqual(['SUBMITTED', 2, 0]);
      expect(Number(st.requestedCreditLimit)).toBe(10_000);
    });

    it('a Supervisor page from cycle 1 cannot reject cycle 2 — not even the decision row that precedes the claim is written', async () => {
      asUser(ids.supervisor, 'SUPERVISOR');
      const before = await footprint(editA, nameA);
      expectStale(await decide('reject', editA, kept.supCycle1));
      expect(await footprint(editA, nameA)).toEqual(before);
      // From a fresh page the Supervisor sends cycle 2 on.
      expect((await decide('approve', editA, await fresh(editA))).ok).toBe(true);
    });

    it("the auditor's case: the Finance Manager's cycle-1 page (OMR 400 / 30) cannot approve cycle 2 (OMR 10,000 / 90)", async () => {
      asUser(ids.fm, 'FINANCE_MANAGER');
      const before = await footprint(editA, nameA);
      expect([before.row.cycle, before.row.currentStepIndex]).toEqual([2, 1]);
      expectStale(await decide('approve', editA, kept.fmCycle1Visit2));
      expect(await footprint(editA, nameA)).toEqual(before);
      // The same approval from a page showing cycle 2 goes through.
      const token = await fresh(editA);
      expect(parseDecisionToken(token)).toMatchObject({ cycle: 2, stepIndex: 1, creditLimit: '10000.000', paymentTermDays: 90 });
      const ok = await decide('approve', editA, token);
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editA } });
      expect([st.cycle, st.currentStepIndex, st.pendingRole]).toEqual([2, 2, 'GM']);
      expect(await prisma.editApproval.count({ where: { editId: editA, cycle: 2, stepIndex: 1, decision: 'APPROVED' } })).toBe(1);
    });

    it('A reaches the Accountant, is stepped back to the GM and re-advanced; B is sent on to the Accountant', async () => {
      asUser(ids.gm, 'GM');
      expect((await decide('approve', editA, await fresh(editA))).ok).toBe(true);
      asUser(ids.acc, 'ACCOUNTANT');
      kept.accVisit1 = await fresh(editA);
      expect(parseDecisionToken(kept.accVisit1)).toMatchObject({ cycle: 2, stepIndex: 3 });
      expect((await decide('reject', editA, kept.accVisit1)).ok).toBe(true);
      asUser(ids.gm, 'GM');
      expect((await decide('approve', editA, await fresh(editA))).ok).toBe(true);
      const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editA } });
      expect([st.state, st.cycle, st.currentStepIndex]).toEqual(['SUBMITTED', 2, 3]);

      asUser(ids.supervisor, 'SUPERVISOR');
      expect((await decide('approve', editB, await fresh(editB))).ok).toBe(true);
      expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: editB } })).pendingRole).toBe('ACCOUNTANT');
    });

    it('bulk at the final step: B (cash) is created; A (credit) is refused in a bulk run and creates no customer', async () => {
      asUser(ids.acc, 'ACCOUNTANT');
      const before = await footprint(editA, nameA);
      const fd = new FormData();
      fd.set('decisions', JSON.stringify([
        { editId: editA, decisionToken: kept.accVisit1 },
        { editId: editB, decisionToken: await fresh(editB) },
      ]));
      const res = await edits.bulkApproveEditsAction(fd);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      expect(res.data.successes).toEqual([editB]);
      // Owner decision 2026-10-05 (X-APPR-1(a): no): A is a credit application, so a
      // bulk approve refuses it before its card is compared, stale or fresh.
      expect(res.data.failures.map((f) => [f.editId, f.code, f.message])).toEqual([
        [editA, 'VALIDATION_FAILED', CREDIT_BULK_REFUSED_MESSAGE],
      ]);
      expect(await prisma.customer.count({ where: { legalName: nameB } })).toBe(1);
      expect(await footprint(editA, nameA)).toEqual(before);
      expect(before.customers).toBe(0);

      // A fresh card changes nothing: credit is never approved in bulk.
      const again = new FormData();
      again.set('decisions', JSON.stringify([{ editId: editA, decisionToken: await fresh(editA) }]));
      const res2 = await edits.bulkApproveEditsAction(again);
      expect(res2.ok, JSON.stringify(res2)).toBe(true);
      if (!res2.ok) return;
      expect(res2.data.failures.map((f) => [f.editId, f.code])).toEqual([[editA, 'VALIDATION_FAILED']]);
      expect(await footprint(editA, nameA)).toEqual(before);
    });

    it('from a fresh page the Accountant creates A, with the figures that page showed', async () => {
      asUser(ids.acc, 'ACCOUNTANT');
      const ok = await decide('approve', editA, await fresh(editA));
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      const st = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editA } });
      expect(st.state).toBe('APPROVED');
      const cust = await prisma.customer.findUniqueOrThrow({ where: { id: st.customerId! }, select: { legalName: true, creditLimit: true, paymentTermDays: true } });
      expect(cust.legalName).toBe(nameA);
      expect(Number(cust.creditLimit)).toBe(10_000);
      expect(cust.paymentTermDays).toBe(90);
    });

    // Guarantee documents are attachments, not columns: the salesman can Remove
    // one while the request is SUBMITTED, and neither the cycle nor the row moves.
    let editD = '';
    const gD = { one: '', two: '' };

    it('D is submitted with two guarantee documents; a page opened now binds both', async () => {
      asUser(ids.salesman, 'SALESMAN');
      gD.one = await mkAtt('GUARANTEE');
      gD.two = await mkAtt('GUARANTEE');
      const res = await creates.submitCreateAction({
        isDraft: false,
        customer: {
          legalName: nameD, paymentTerms: 'CREDIT', channelId, subChannelId,
          primaryPhone: `+96893${digits(31)}`, contactPerson: `ZZ Contact D ${tag}`,
          crNumber: `95${digits(32)}`, crPhotoAttachmentId: await mkAtt('CR'),
        },
        credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
        guaranteeAttachmentIds: [gD.one, gD.two],
        branches: [{
          branchName: `ZZ Branch D ${tag}`, address: `ZZ Way 4, ${tag}`, gpsLat: 23.63, gpsLng: 58.43,
          dayOfVisit: 'WED', coolersCount: 1, standsCount: 1, emptyBottlesCount: 5,
          shopPhotoAttachmentId: await mkAtt('SHOP'), signboardPhotoAttachmentId: await mkAtt('SIGNBOARD'),
        }],
      });
      if (!res.ok) console.error('N01 SUBMIT D FAILED', JSON.stringify(res));
      expect(res.ok).toBe(true);
      editD = (res as { ok: true; data: { editId: string } }).data.editId;
      expect(parseDecisionToken(await fresh(editD))!.guarantees).toBe(guaranteeDigest([gD.one, gD.two]));
    });

    it('the salesman removes one while the Supervisor’s page is open: that page can neither approve nor reject, and nothing is written', async () => {
      asUser(ids.supervisor, 'SUPERVISOR');
      const page = await fresh(editD);
      asUser(ids.salesman, 'SALESMAN');
      const removed = await photos.detachPhotoAction({ attachmentId: gD.two });
      expect(removed.ok, JSON.stringify(removed)).toBe(true);

      asUser(ids.supervisor, 'SUPERVISOR');
      const before = await footprint(editD, nameD);
      expectStale(await decide('approve', editD, page));
      expectStale(await decide('reject', editD, page));
      expect(await footprint(editD, nameD)).toEqual(before);
      // A page loaded now lists the one left, and approves.
      const ok = await decide('approve', editD, await fresh(editD));
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
    });

    it('a Remove still in flight when the decision reads the guarantees is waited for, then seen', async () => {
      asUser(ids.fm, 'FINANCE_MANAGER');
      const page = await fresh(editD); // lists gD.one
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Connection A: a Remove's soft-delete of gD.one, written and not yet committed.
      const holder = prisma.$transaction(
        async (t) => {
          await t.$executeRaw`UPDATE "Attachment" SET "deletedAt" = now(), "hash" = NULL WHERE "id" = ${gD.one}`;
          locked();
          await gate;
        },
        { timeout: 60_000, maxWait: 10_000 }
      );
      await isLocked;
      const before = await footprint(editD, nameD);
      // Connection B: the Finance Manager's approval, from the page that lists gD.one.
      // A plain read would see gD.one still live and approve; FOR SHARE must wait.
      const deciding = decide('approve', editD, page);
      let waited = false;
      for (let i = 0; i < 200 && !waited; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
        waited = (rows[0]?.n ?? 0) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 50));
      }
      release();
      await holder;
      const res = await deciding;

      expect(waited, 'the decision queued behind the removal').toBe(true);
      expectStale(res);
      // Rolled back whole: the claim, the decision row, the audit row, the notifications.
      expect(await footprint(editD, nameD)).toEqual(before);
    });
  });
});
