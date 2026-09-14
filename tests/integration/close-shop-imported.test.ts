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
  const ids = { region: '', route: '', sup: `ZZCS-sup-${tag}`, sales: `ZZCS-sales-${tag}`, cust: '', branch: '' };

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
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: route.id, supervisorId: ids.sup } });
    // Imported/legacy customer: NO crPhoto, NO channel, minimal — exactly what a
    // master-import row lands as; its branch has no shop/signboard photo either.
    const cust = await prisma.customer.create({ data: { nmwcCode: `ZZCS-C-${tag}`, legalName: 'ZZ Imported Co', paymentTerms: 'CASH', createdById: ids.sales } });
    ids.cust = cust.id;
    const branch = await prisma.branch.create({ data: { customerId: cust.id, branchCode: `ZZCS-C-${tag}-01`, branchName: 'ZZ Imported Branch', address: 'ZZ Way 1, Muscat', routeId: route.id, regionId: region.id, status: 'ACTIVE' } });
    ids.branch = branch.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.cust }, select: { id: true } });
      if (eds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: eds.map((e) => e.id) } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: eds.map((e) => e.id) } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
      await purgeAuditLog(prisma, { where: { actorId: { in: [ids.sales, ids.sup] } } });
      await prisma.notification.deleteMany({ where: { userId: { in: [ids.sales, ids.sup] } } });
      await prisma.branch.deleteMany({ where: { customerId: ids.cust } });
      await prisma.customer.deleteMany({ where: { id: ids.cust } });
      await prisma.user.deleteMany({ where: { id: { in: [ids.sales, ids.sup] } } });
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
    const app = await edits.approveEditAction(appFd);
    if (!app.ok) console.error('CLOSE APPROVE FAILED', JSON.stringify(app));
    expect(app.ok).toBe(true);

    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch }, select: { status: true } });
    expect(branch.status).toBe('CLOSED');
  });
});
