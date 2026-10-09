// @vitest-environment node
/**
 * CLOSE-SHOP-IMPORTED (final-hunt #1) — a salesman must be able to close a branch
 * of an IMPORTED/legacy customer that has no field-captured photos. The close is a
 * salesman-submitted status-only UPDATE gated by its own fresh-photo evidence; it
 * rides approveEditCore, whose EL-04 re-check used to re-run the WHOLE-customer
 * mandatory-field gate and fail (NEEDS_REUPLOAD) because the imported customer lacks
 * a CR/shop/signboard photo — so the shop could never be closed. This pins the fix:
 * a status-only close skips EL-04 and the Supervisor approval CLOSES the branch.
 *
 *   RUN_CLOSE_SHOP=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/close-shop-imported.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_CLOSE_SHOP === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('imported customer branch can be closed (final-hunt #1)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let react: typeof import('@/services/reactivations');
  let edits: typeof import('@/services/edits');
  const tag = randomUUID().slice(0, 8);
  const ids = { region: '', route: '', sup: `ZZCS-sup-${tag}`, mgr: `ZZCS-mgr-${tag}`, sales: `ZZCS-sales-${tag}`, cust: '', branch: '', cust2: '', branch2: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    react = await import('@/services/reactivations');
    edits = await import('@/services/edits');
    const region = await prisma.region.create({ data: { name: `ZZCS Region ${tag}`, code: `ZZCS-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZCS Route ${tag}`, code: `ZZCS-RT-${tag}`, regionId: region.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.sup, username: ids.sup, passwordHash: 'x', fullName: 'ZZ Sup', role: 'SUPERVISOR' } });
    // Decides the reactivation at the end (a Manager of this region).
    await prisma.user.create({ data: { id: ids.mgr, username: ids.mgr, passwordHash: 'x', fullName: 'ZZ Mgr', role: 'MANAGER', managedRegions: { connect: { id: region.id } } } });
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: route.id, supervisorId: ids.sup } });
    // Imported/legacy customer: NO crPhoto, NO channel, minimal — exactly what a
    // master-import row lands as; its branch has no shop/signboard photo either.
    const cust = await prisma.customer.create({ data: { nmwcCode: `ZZCS-C-${tag}`, legalName: 'ZZ Imported Co', paymentTerms: 'CASH', createdById: ids.sales } });
    ids.cust = cust.id;
    const branch = await prisma.branch.create({ data: { customerId: cust.id, branchCode: `ZZCS-C-${tag}-01`, branchName: 'ZZ Imported Branch', address: 'ZZ Way 1, Muscat', routeId: route.id, regionId: region.id, status: 'ACTIVE' } });
    ids.branch = branch.id;
    // A second shop for the evidence-wiring cases below, so they do not depend
    // on the close above.
    const cust2 = await prisma.customer.create({ data: { nmwcCode: `ZZCS-D-${tag}`, legalName: 'ZZ Second Co', paymentTerms: 'CASH', createdById: ids.sales } });
    ids.cust2 = cust2.id;
    const branch2 = await prisma.branch.create({ data: { customerId: cust2.id, branchCode: `ZZCS-D-${tag}-01`, branchName: 'ZZ Second Branch', address: 'ZZ Way 2, Muscat', routeId: route.id, regionId: region.id, status: 'ACTIVE' } });
    ids.branch2 = branch2.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      // The salesman's new-customer request (the claimed-photo case) has no customer.
      const eds = await prisma.customerEdit.findMany({ where: { OR: [{ customerId: { in: [ids.cust, ids.cust2] } }, { submittedById: ids.sales }] }, select: { id: true } });
      if (eds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: eds.map((e) => e.id) } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: eds.map((e) => e.id) } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
      await purgeAuditLog(prisma, { where: { actorId: { in: [ids.sales, ids.sup, ids.mgr] } } });
      await prisma.notification.deleteMany({ where: { userId: { in: [ids.sales, ids.sup, ids.mgr] } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: [ids.cust, ids.cust2] } } });
      await prisma.customer.deleteMany({ where: { id: { in: [ids.cust, ids.cust2] } } });
      await prisma.user.deleteMany({ where: { id: { in: [ids.sales, ids.sup, ids.mgr] } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) { console.error('cleanup', e); }
    await prisma.$disconnect();
  });

  it('salesman closes the shop and the supervisor approval CLOSES the branch (no NEEDS_REUPLOAD)', async () => {
    // fresh evidence photo captured by the salesman, attached to the branch
    const att = await prisma.attachment.create({ data: { kind: 'SHOP', r2Key: `uat/close-${tag}.jpg`, mimeType: 'image/jpeg', bytes: 1000, capturedById: ids.sales, capturedAt: new Date(), branchId: ids.branch } });

    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    const submitFd = new FormData();
    submitFd.set('branchId', ids.branch);
    submitFd.set('reason', 'Shop shut permanently — verified on visit today.');
    submitFd.set('attachmentId', att.id);
    const sub = await react.markBranchClosedAction(submitFd);
    if (!sub.ok) console.error('CLOSE SUBMIT FAILED', JSON.stringify(sub));
    expect(sub.ok).toBe(true);
    const editId = (sub as { ok: true; data: { editId: string } }).data.editId;

    // supervisor approves — must NOT hit EL-04 NEEDS_REUPLOAD
    current = { id: ids.sup, role: 'SUPERVISOR', username: ids.sup };
    const appFd = new FormData();
    appFd.set('editId', editId);
    appFd.set('decisionToken', await freshDecisionToken(prisma, editId));
    const app = await edits.approveEditAction(appFd);
    if (!app.ok) console.error('CLOSE APPROVE FAILED', JSON.stringify(app));
    expect(app.ok).toBe(true);

    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch }, select: { status: true } });
    expect(branch.status).toBe('CLOSED');
  });

  // Launch review: the form attached the evidence photo to the LIVE branch at
  // upload, so a Cancel or a refused submit left it there. It now sends the
  // photo on no slot, and the service wires it inside the request's transaction.
  const unwiredPhoto = (n: string) =>
    prisma.attachment.create({ data: { kind: 'FREE', r2Key: `uat/close-${tag}-${n}.jpg`, mimeType: 'image/jpeg', bytes: 1000, capturedById: ids.sales, capturedAt: new Date() } });
  const closeWith = (branchId: string, attachmentId: string) => {
    const fd = new FormData();
    fd.set('branchId', branchId);
    fd.set('reason', 'Shop shut permanently — verified on visit today.');
    fd.set('attachmentId', attachmentId);
    return react.markBranchClosedAction(fd);
  };
  const wiring = (id: string) =>
    prisma.attachment.findUniqueOrThrow({ where: { id }, select: { branchId: true, branchExtraId: true, customerId: true, kind: true } });

  // The open close on the second shop, whose photo was wired with it; decided
  // after the refusals below, which need it still open.
  let wiredCloseId = '';

  it('a photo on no slot goes onto the branch with the accepted close, audit row included', async () => {
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    const att = await unwiredPhoto('wired');
    const res = await closeWith(ids.branch2, att.id);
    if (!res.ok) console.error('CLOSE SUBMIT FAILED', JSON.stringify(res));
    expect(res.ok).toBe(true);
    wiredCloseId = (res as { ok: true; data: { editId: string } }).data.editId;
    expect(await wiring(att.id)).toEqual({ branchId: ids.branch2, branchExtraId: ids.branch2, customerId: null, kind: 'FREE' });
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: ids.sales, entityType: 'Branch', entityId: ids.branch2, reason: 'photo attached' },
      select: { after: true },
    });
    expect(audit?.after).toEqual({ slot: 'FREE', attachmentId: att.id });
  });

  it('a refused close leaves its photo on no slot — nothing reaches the live branch, no audit row, no notification', async () => {
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    // The close above is still open: this one is refused at the insert, after
    // the photo was claimed in the same transaction — so the claim rolls back,
    // and with it the claim's audit row and the request's notifications.
    const told = () => prisma.notification.count({ where: { userId: { in: [ids.sup, ids.mgr] } } });
    const before = await told();
    const att = await unwiredPhoto('refused');
    const res = await closeWith(ids.branch2, att.id);
    expect(res).toMatchObject({ ok: false, code: 'OPEN_EDIT_EXISTS' });
    expect(await wiring(att.id)).toEqual({ branchId: null, branchExtraId: null, customerId: null, kind: 'FREE' });
    const attached = await prisma.auditLog.findMany({
      where: { actorId: ids.sales, entityType: 'Branch', reason: 'photo attached' },
      select: { after: true },
    });
    expect(attached.filter((a) => (a.after as { attachmentId?: string } | null)?.attachmentId === att.id)).toEqual([]);
    expect(await told()).toBe(before);
  });

  it('a photo on another branch is still refused', async () => {
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    const att = await prisma.attachment.create({ data: { kind: 'FREE', r2Key: `uat/close-${tag}-other.jpg`, mimeType: 'image/jpeg', bytes: 1000, capturedById: ids.sales, capturedAt: new Date(), branchId: ids.branch, branchExtraId: ids.branch } });
    const res = await closeWith(ids.branch2, att.id);
    expect(res).toMatchObject({ ok: false, fields: { attachmentId: 'This photo is already used elsewhere. Take a new photo of the shop.' } });
    expect(await wiring(att.id)).toMatchObject({ branchId: ids.branch, branchExtraId: ids.branch });
  });

  it('a photo on no slot but claimed by a new-customer request is refused, and stays with that request', async () => {
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    const create = await prisma.customerEdit.create({ data: { target: 'CUSTOMER', process: 'CREATE', state: 'DRAFT', submittedById: ids.sales, fieldChanges: [], attachmentChanges: [] } });
    const att = await prisma.attachment.create({ data: { kind: 'SHOP', r2Key: `uat/close-${tag}-claimed.jpg`, mimeType: 'image/jpeg', bytes: 1000, capturedById: ids.sales, capturedAt: new Date(), editId: create.id } });
    const res = await closeWith(ids.branch2, att.id);
    expect(res).toMatchObject({ ok: false, fields: { attachmentId: 'This photo is already used elsewhere. Take a new photo of the shop.' } });
    expect(
      await prisma.attachment.findUniqueOrThrow({ where: { id: att.id }, select: { branchId: true, branchExtraId: true, editId: true, kind: true } })
    ).toEqual({ branchId: null, branchExtraId: null, editId: create.id, kind: 'SHOP' });
  });

  it('the supervisor approves the close whose photo was wired with it: the photo stands as evidence, and the branch is CLOSED', async () => {
    expect(wiredCloseId).not.toBe('');
    current = { id: ids.sup, role: 'SUPERVISOR', username: ids.sup };
    const fd = new FormData();
    fd.set('editId', wiredCloseId);
    fd.set('decisionToken', await freshDecisionToken(prisma, wiredCloseId));
    const app = await edits.approveEditAction(fd);
    if (!app.ok) console.error('CLOSE APPROVE FAILED', JSON.stringify(app));
    expect(app.ok).toBe(true);
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch2 }, select: { status: true } });
    expect(branch.status).toBe('CLOSED');
  });

  it('a reactivation wires its photo the same way (the branch closed by the first test), and the Manager approves it', async () => {
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    // Captured after the close was approved (lastStatusChangeAt), as at the shop.
    const att = await prisma.attachment.create({ data: { kind: 'FREE', r2Key: `uat/close-${tag}-react.jpg`, mimeType: 'image/jpeg', bytes: 1000, capturedById: ids.sales, capturedAt: new Date(Date.now() + 1000) } });
    const fd = new FormData();
    fd.set('branchId', ids.branch);
    fd.set('reason', 'Reopened under the same owner.');
    fd.set('attachmentId', att.id);
    const res = await react.requestReactivationAction(fd);
    if (!res.ok) console.error('REACTIVATION SUBMIT FAILED', JSON.stringify(res));
    expect(res.ok).toBe(true);
    expect(await wiring(att.id)).toMatchObject({ branchId: ids.branch, branchExtraId: ids.branch, kind: 'FREE' });

    // The decision asks again whether the photo stands (lib/status-evidence.ts).
    current = { id: ids.mgr, role: 'MANAGER', username: ids.mgr };
    const approve = new FormData();
    approve.set('editId', (res as { ok: true; data: { editId: string } }).data.editId);
    const app = await react.approveReactivationAction(approve);
    if (!app.ok) console.error('REACTIVATION APPROVE FAILED', JSON.stringify(app));
    expect(app.ok).toBe(true);
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch }, select: { status: true } });
    expect(branch.status).toBe('ACTIVE');
  });
});
