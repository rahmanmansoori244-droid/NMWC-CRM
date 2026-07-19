/**
 * SVC-REACT regression — reactivation lane authorization + concurrency (QA C11/C12/C13).
 *
 * These are the fail-before / pass-after proofs for three CONFIRMED defects:
 *   C11 (P1): the generic approveEditAction/rejectEditAction must REFUSE
 *             reactivation edits (they are Manager-only, decided via the
 *             reactivation actions) — before the fix a Supervisor could approve.
 *   C12 (P2): approveReactivationCore must claim the edit atomically — two
 *             concurrent approvals must yield exactly ONE REACTIVATE audit row.
 *   C13 (P1): rejectReactivationCore must refuse a non-reactivation edit and a
 *             non-SUBMITTED edit.
 *
 * GATED like tests/integration/rate-limit-pg.test.ts — the default `npm test`
 * run (no Postgres) skips this cleanly. It writes ONLY unique synthetic rows
 * (prefix 'ZZ-REACT-') and deletes them in afterAll, so it is safe against the
 * branch's cloned data (never production).
 *
 *   RUN_REACTIVATION_TESTS=1 DATABASE_URL="postgres://…" \
 *     npx vitest run tests/integration/reactivation-authz.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const ENABLED = process.env.RUN_REACTIVATION_TESTS === '1' && !!process.env.DATABASE_URL;

// Mutable session the auth() mock returns; each test sets the acting user.
type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => (current ? { user: current } : null),
}));

const P = 'ZZ-REACT-' + randomUUID().slice(0, 8);
const ids = {
  region: `${P}-region`, route: `${P}-route`, salesman: `${P}-salesman`,
  supervisor: `${P}-supervisor`, manager: `${P}-manager`, customer: `${P}-customer`,
  branch: `${P}-branch`, photo: `${P}-photo`,
};

describe.skipIf(!ENABLED)('reactivation lane authz + concurrency (C11/C12/C13)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let reacts: typeof import('@/services/reactivations');
  let edits: typeof import('@/services/edits');

  beforeAll(async () => {
    ({ prisma } = await import('@/lib/db'));
    reacts = await import('@/services/reactivations');
    edits = await import('@/services/edits');

    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    await prisma.user.create({ data: { id: ids.supervisor, username: ids.supervisor, passwordHash: 'x', fullName: 'ZZ Sup', role: 'SUPERVISOR' } });
    await prisma.user.create({ data: { id: ids.salesman, username: ids.salesman, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: ids.route, supervisorId: ids.supervisor } });
    await prisma.user.create({ data: { id: ids.manager, username: ids.manager, passwordHash: 'x', fullName: 'ZZ Mgr', role: 'MANAGER', managedRegions: { connect: { id: ids.region } } } });
    await prisma.customer.create({ data: { id: ids.customer, nmwcCode: `${P}-C`, legalName: 'ZZ Cust', status: 'CLOSED' } });
    await prisma.branch.create({ data: { id: ids.branch, customerId: ids.customer, branchCode: `${P}-B-01`, branchName: 'Main', regionId: ids.region, routeId: ids.route, address: 'ZZ synthetic address', status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) } });
    await prisma.attachment.create({ data: { id: ids.photo, kind: 'SHOP', r2Key: `${P}/photo.jpg`, mimeType: 'image/jpeg', bytes: 1, capturedById: ids.salesman, capturedAt: new Date(), branchId: ids.branch } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.salesman, ids.supervisor, ids.manager] } } });
    await prisma.customerEdit.deleteMany({ where: { submittedById: ids.salesman } });
    await prisma.attachment.deleteMany({ where: { id: ids.photo } });
    await prisma.branch.deleteMany({ where: { id: ids.branch } });
    await prisma.customer.deleteMany({ where: { id: ids.customer } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.salesman, ids.supervisor, ids.manager] } } });
    await prisma.route.deleteMany({ where: { id: ids.route } });
    await prisma.region.deleteMany({ where: { id: ids.region } });
    await prisma.$disconnect();
  });

  async function newReactivation(): Promise<string> {
    // reset branch to CLOSED + a fresh photo after each consuming test
    await prisma.branch.update({ where: { id: ids.branch }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) } });
    await prisma.attachment.update({ where: { id: ids.photo }, data: { capturedAt: new Date() } });
    current = { id: ids.salesman, role: 'SALESMAN', username: ids.salesman };
    const fd = new FormData();
    fd.set('branchId', ids.branch); fd.set('reason', 'shop reopened for real'); fd.set('attachmentId', ids.photo);
    const res = await reacts.requestReactivationAction(fd);
    expect(res.ok).toBe(true);
    return (res as { ok: true; data: { editId: string } }).data.editId;
  }

  it('C11: Supervisor CANNOT approve a reactivation via the generic engine (WRONG_LANE)', async () => {
    const editId = await newReactivation();
    current = { id: ids.supervisor, role: 'SUPERVISOR', username: ids.supervisor };
    const fd = new FormData(); fd.set('editId', editId);
    const res = await edits.approveEditAction(fd);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; code: string }).code).toBe('WRONG_LANE');
    const branch = await prisma.branch.findUnique({ where: { id: ids.branch } });
    expect(branch?.status).toBe('CLOSED'); // NOT reactivated
  });

  it('C11: Supervisor CANNOT reject a reactivation via the generic engine', async () => {
    const editId = await newReactivation();
    current = { id: ids.supervisor, role: 'SUPERVISOR', username: ids.supervisor };
    const fd = new FormData(); fd.set('editId', editId); fd.set('reason', 'nope'); fd.set('category', 'other');
    const res = await edits.rejectEditAction(fd);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; code: string }).code).toBe('WRONG_LANE');
  });

  it('C12: two concurrent Manager approvals yield exactly ONE REACTIVATE audit row', async () => {
    const editId = await newReactivation();
    current = { id: ids.manager, role: 'MANAGER', username: ids.manager };
    const fd1 = new FormData(); fd1.set('editId', editId);
    const fd2 = new FormData(); fd2.set('editId', editId);
    const [r1, r2] = await Promise.all([reacts.approveReactivationAction(fd1), reacts.approveReactivationAction(fd2)]);
    const oks = [r1, r2].filter((r) => r.ok).length;
    expect(oks).toBe(1); // exactly one winner; the loser sees NOT_PENDING
    const audits = await prisma.auditLog.count({ where: { action: 'REACTIVATE', entityId: ids.branch } });
    expect(audits).toBe(1);
  });

  it('C13: cannot reject an already-APPROVED reactivation (state guard)', async () => {
    const editId = await newReactivation();
    current = { id: ids.manager, role: 'MANAGER', username: ids.manager };
    const approve = new FormData(); approve.set('editId', editId);
    expect((await reacts.approveReactivationAction(approve)).ok).toBe(true);
    const reject = new FormData(); reject.set('editId', editId); reject.set('reason', 'changed my mind');
    const res = await reacts.rejectReactivationAction(reject);
    expect(res.ok).toBe(false); // was APPROVED, cannot reject
    const branch = await prisma.branch.findUnique({ where: { id: ids.branch } });
    expect(branch?.status).toBe('ACTIVE'); // stays reactivated, not corrupted
  });

  it('C13: cannot reject a NON-reactivation branch edit via the reactivation action', async () => {
    // A plain SUBMITTED branch edit (isReactivation=false) in the manager's region.
    const plain = await prisma.customerEdit.create({ data: {
      target: 'BRANCH', branchId: ids.branch, customerId: ids.customer, state: 'SUBMITTED',
      submittedById: ids.salesman, submittedAt: new Date(), pendingRole: 'SUPERVISOR',
      fieldChanges: [], attachmentChanges: [], isReactivation: false,
    } });
    current = { id: ids.manager, role: 'MANAGER', username: ids.manager };
    const fd = new FormData(); fd.set('editId', plain.id); fd.set('reason', 'not mine to reject');
    const res = await reacts.rejectReactivationAction(fd);
    expect(res.ok).toBe(false); // 'Not a reactivation.'
    const after = await prisma.customerEdit.findUnique({ where: { id: plain.id } });
    expect(after?.state).toBe('SUBMITTED'); // untouched
  });
});
