// @vitest-environment node
/**
 * Gap 11 (data audit 2026-10-10), on Postgres: every decision row says who
 * decided as what, and why he could, beside the step's role.
 *
 *   - the salesman's own Supervisor approves: SUPERVISOR_OF_SUBMITTER;
 *   - a Manager of the request's region decides the Supervisor step instead
 *     (the fallback): REGION_MANAGER, his own role MANAGER beside the step's
 *     SUPERVISOR — on approve and on reject;
 *   - a Manager's reactivation decision is in the same ledger now (stepIndex 0,
 *     the MANAGER step, REGION_MANAGER), approve and "Keep closed" alike, and the
 *     /status figures still count it once;
 *   - the database refuses a basis outside the five the code writes.
 *
 *   RUN_ACCOUNTABILITY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/approval-authority.test.ts
 *
 * Synthetic rows only, removed again (history and sign-in events included).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { freshDecisionToken } from '../support/decision-token';
import { assertNotProductionEnv, buildWorld, submittedUpdate, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_ACCOUNTABILITY === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('gap 11: the decider’s own role and why he could decide', () => {
  let prisma: PrismaClient;
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');
  let w: World;
  const as = (id: string, role: string) => {
    current = { id, role, username: id };
  };
  const decide = async (kind: 'approve' | 'reject', editId: string) => {
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', await freshDecisionToken(prisma, editId));
    if (kind === 'reject') {
      fd.set('reason', 'Synthetic send-back for the authority test');
      fd.set('category', 'wrong_info');
      return edits.rejectEditAction(fd);
    }
    return edits.approveEditAction(fd);
  };
  const rows = (editId: string) =>
    prisma.editApproval.findMany({
      where: { editId },
      orderBy: { at: 'asc' },
      select: { stepIndex: true, role: true, decision: true, actorId: true, actorRole: true, authorityBasis: true, scopeRegionIds: true, submitterRouteId: true },
    });

  beforeAll(async () => {
    assertNotProductionEnv();
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    reacts = await import('@/services/reactivations');
    w = await buildWorld(prisma, 'authority');
  });

  afterAll(async () => {
    if (prisma && w) await tearDownWorld(prisma, w);
    await prisma?.$disconnect();
  });

  it('his own Supervisor approves: SUPERVISOR_OF_SUBMITTER, the request’s region, the salesman’s route', async () => {
    const id = await submittedUpdate(prisma, w, '07:00-21:00');
    as(w.sup, 'SUPERVISOR');
    const res = await decide('approve', id);
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(await rows(id)).toEqual([
      {
        stepIndex: 0,
        role: 'SUPERVISOR',
        decision: 'APPROVED',
        actorId: w.sup,
        actorRole: 'SUPERVISOR',
        authorityBasis: 'SUPERVISOR_OF_SUBMITTER',
        scopeRegionIds: [w.regionA],
        submitterRouteId: w.route,
      },
    ]);
  });

  it('a Manager of the region decides the Supervisor step: REGION_MANAGER, as MANAGER, on approve and on reject', async () => {
    const approved = await submittedUpdate(prisma, w, '07:30-21:00');
    as(w.manager, 'MANAGER');
    expect(await decide('approve', approved)).toMatchObject({ ok: true });
    expect(await rows(approved)).toMatchObject([
      { role: 'SUPERVISOR', decision: 'APPROVED', actorRole: 'MANAGER', authorityBasis: 'REGION_MANAGER', scopeRegionIds: [w.regionA] },
    ]);

    const rejected = await submittedUpdate(prisma, w, '08:00-21:00');
    expect(await decide('reject', rejected)).toMatchObject({ ok: true });
    expect(await rows(rejected)).toMatchObject([
      { role: 'SUPERVISOR', decision: 'REJECTED', actorRole: 'MANAGER', authorityBasis: 'REGION_MANAGER', submitterRouteId: w.route },
    ]);
  });

  it('a reactivation decision is a MANAGER-step row too, approve and Keep closed', async () => {
    const reopen = async (): Promise<string> => {
      await prisma.branch.update({
        where: { id: w.branch },
        data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) },
      });
      const photo = await prisma.attachment.create({
        data: {
          kind: 'SHOP', r2Key: `synthetic/${w.sfx}/${Date.now()}.jpg`, mimeType: 'image/jpeg', bytes: 1,
          capturedById: w.salesman, capturedAt: new Date(), branchId: w.branch,
        },
      });
      w.attachments.push(photo.id);
      await prisma.rateLimit.deleteMany({ where: { key: { contains: w.salesman } } });
      as(w.salesman, 'SALESMAN');
      const fd = new FormData();
      fd.set('branchId', w.branch);
      fd.set('reason', 'The shop is open again (synthetic)');
      fd.set('attachmentId', photo.id);
      const res = await reacts.requestReactivationAction(fd);
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
      return (res as { ok: true; data: { editId: string } }).data.editId;
    };

    const approved = await reopen();
    as(w.manager, 'MANAGER');
    const ok = new FormData();
    ok.set('editId', approved);
    expect(await reacts.approveReactivationAction(ok)).toMatchObject({ ok: true });
    expect(await rows(approved)).toEqual([
      {
        stepIndex: 0,
        role: 'MANAGER',
        decision: 'APPROVED',
        actorId: w.manager,
        actorRole: 'MANAGER',
        authorityBasis: 'REGION_MANAGER',
        scopeRegionIds: [w.regionA],
        submitterRouteId: w.route,
      },
    ]);

    const kept = await reopen();
    as(w.manager, 'MANAGER');
    const no = new FormData();
    no.set('editId', kept);
    no.set('reason', 'Still closed when visited (synthetic)');
    expect(await reacts.rejectReactivationAction(no)).toMatchObject({ ok: true });
    const keptRows = await prisma.editApproval.findMany({ where: { editId: kept } });
    expect(keptRows.map((r) => [r.decision, r.reason, r.authorityBasis])).toEqual([
      ['REJECTED', 'Still closed when visited (synthetic)', 'REGION_MANAGER'],
    ]);
  });

  it('/status counts a reactivation once: no second MANAGER tier from its decision row', async () => {
    const svc = await import('@/lib/service-status');
    const company = await svc.__internal.approvalTiers(new Date(Date.now() - 60 * 60 * 1000), 'company');
    expect(company.tiers.filter((t) => t.role === 'MANAGER').length).toBeLessThanOrEqual(1);
  });

  it('the database refuses a basis the code never writes', async () => {
    const id = (await prisma.editApproval.findFirstOrThrow({ where: { actorId: w.sup } })).editId;
    await expect(
      prisma.editApproval.create({
        data: { editId: id, cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', actorId: w.sup, authorityBasis: 'FRIEND_OF_THE_MANAGER' },
      })
    ).rejects.toThrow(/EditApproval_authorityBasis_check/);
  });
});
