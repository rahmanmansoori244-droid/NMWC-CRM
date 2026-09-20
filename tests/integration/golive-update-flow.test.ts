/**
 * GO-LIVE UPDATE FLOW — the Sunday-critical path, on the real org shape:
 *
 *   salesman (username = route code, supervised DIRECTLY by a regional MANAGER)
 *     → sees exactly the customers on their route, can search them
 *     → captures photos + GPS, fills the fields, submits an enrichment edit
 *   manager
 *     → sees it in the Supervisor-step queue (region fallback), approves/rejects
 *   owner
 *     → downloads the field-update report with the changed cells highlighted
 *
 * UAT-SAFE: creates its own region/route/users/customers under a unique
 * suffix and deletes them in afterAll. It never truncates anything, so it can
 * run against the live UAT branch while the real go-live load sits in it.
 *
 *   RUN_GOLIVE_FLOW=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/golive-update-flow.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
// Static, not the dynamic import used further down: the constant below is
// evaluated at module load and fullPayload() is synchronous.
import { omanDayOfWeek } from '@/lib/tz';

/**
 * The day of visit the salesman's edit PROPOSES. Derived, never a literal.
 *
 * Each branch is created with `dayOfVisit: omanDayOfWeek()` — the REAL weekday —
 * because the Today-screen assertions need it to be due today. A literal proposed
 * day therefore matches the stored one on one day in seven: the edit then contains
 * no change to day_of_visit, the field-update report correctly does not highlight
 * it, and two assertions fail.
 *
 * That day is Sunday — the day the go-live runbook targets. So this suite, which
 * exists to prove the salesman-to-manager flow, was red on exactly the day anyone
 * would want to trust it and green every other day, which reads as a flake and
 * gets re-run rather than read.
 *
 * Every assertion about the approved day must use THIS, not a literal.
 */
const PROPOSED_DAY: 'SUN' | 'MON' = omanDayOfWeek() === 'SUN' ? 'MON' : 'SUN';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ENABLED = process.env.RUN_GOLIVE_FLOW === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sfx = `qa${Date.now().toString(36)}`;
const testStart = new Date(Date.now() - 60_000);

describe.skipIf(!ENABLED)('GO-LIVE UPDATE FLOW (salesman → manager → report)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let edits: typeof import('@/services/edits');
  let photos: typeof import('@/services/photos');
  let filtersLib: typeof import('@/lib/customer-filters');
  let access: typeof import('@/lib/access');
  let report: typeof import('@/lib/change-report');

  const ids = {
    regionId: '',
    otherRegionId: '',
    routeId: '',
    routeCode: '',
    otherRouteId: '',
    managerId: '',
    otherManagerId: '',
    salesmanId: '',
    otherSalesmanId: '',
    customerIds: [] as string[],
    otherCustomerId: '',
    branchIds: {} as Record<string, string>,
    userIds: [] as string[],
    attachmentIds: [] as string[],
  };
  let subChannelId = '';
  let channelId = '';
  const asSalesman = () => {
    current = { id: ids.salesmanId, role: 'SALESMAN', username: ids.routeCode.toLowerCase() };
  };
  const asManager = () => {
    current = { id: ids.managerId, role: 'MANAGER', username: `qa.mgr.${sfx}` };
  };
  const asOtherManager = () => {
    current = { id: ids.otherManagerId, role: 'MANAGER', username: `qa.mgr2.${sfx}` };
  };
  const asOtherSalesman = () => {
    current = { id: ids.otherSalesmanId, role: 'SALESMAN', username: `qb${sfx}` };
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) {
      throw new Error('ABORT: production');
    }
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    photos = await import('@/services/photos');
    filtersLib = await import('@/lib/customer-filters');
    access = await import('@/lib/access');
    report = await import('@/lib/change-report');

    // Reference data from the live seed (the same channels the import maps to).
    const gt = await prisma.channel.findFirstOrThrow({
      where: { key: 'GENERAL_TRADE' },
      include: { subChannels: { where: { isActive: true }, take: 1 } },
    });
    channelId = gt.id;
    subChannelId = gt.subChannels[0]!.id;

    // Org: one region, two routes, a manager who supervises both salesmen directly.
    const region = await prisma.region.create({
      data: { code: `QAR${sfx}`.toUpperCase(), name: `QA Region ${sfx}` },
    });
    const otherRegion = await prisma.region.create({
      data: { code: `QAX${sfx}`.toUpperCase(), name: `QA Other Region ${sfx}` },
    });
    ids.regionId = region.id;
    ids.otherRegionId = otherRegion.id;
    ids.routeCode = `QA${sfx}`.toUpperCase();
    const route = await prisma.route.create({
      data: { code: ids.routeCode, name: `QA route ${sfx}`, regionId: region.id },
    });
    const otherRoute = await prisma.route.create({
      data: { code: `QB${sfx}`.toUpperCase(), name: `QB route ${sfx}`, regionId: region.id },
    });
    ids.routeId = route.id;
    ids.otherRouteId = otherRoute.id;
    const hash = await bcrypt.hash('12345', 12);
    const manager = await prisma.user.create({
      data: {
        username: `qa.mgr.${sfx}`,
        fullName: `QA Manager ${sfx}`,
        role: 'MANAGER',
        passwordHash: hash,
        mustChangePassword: true,
        managedRegions: { connect: { id: region.id } },
      },
    });
    const otherManager = await prisma.user.create({
      data: {
        username: `qa.mgr2.${sfx}`,
        fullName: `QA Other Manager ${sfx}`,
        role: 'MANAGER',
        passwordHash: hash,
        managedRegions: { connect: { id: otherRegion.id } },
      },
    });
    const salesman = await prisma.user.create({
      data: {
        username: ids.routeCode.toLowerCase(),
        fullName: `QA Salesman ${sfx}`,
        role: 'SALESMAN',
        passwordHash: hash,
        mustChangePassword: true,
        supervisorId: manager.id,
        ownedRouteId: route.id,
      },
    });
    const otherSalesman = await prisma.user.create({
      data: {
        username: `qb${sfx}`,
        fullName: `QB Salesman ${sfx}`,
        role: 'SALESMAN',
        passwordHash: hash,
        supervisorId: manager.id,
        ownedRouteId: otherRoute.id,
      },
    });
    ids.managerId = manager.id;
    ids.otherManagerId = otherManager.id;
    ids.salesmanId = salesman.id;
    ids.otherSalesmanId = otherSalesman.id;
    ids.userIds = [manager.id, otherManager.id, salesman.id, otherSalesman.id];

    // Customers exactly as the go-live import leaves them: no photos, no GPS,
    // no sub-channel; some with phone/contact, some without.
    const mk = async (
      code: string,
      name: string,
      routeId: string,
      extra: Partial<{
        paymentTerms: 'CASH' | 'CREDIT';
        primaryPhone: string;
        contactPerson: string;
        dayOfVisit: 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';
      }> = {}
    ) => {
      const { normalizePhone } = await import('@/lib/phone');
      const c = await prisma.customer.create({
        data: {
          nmwcCode: code,
          legalName: name,
          paymentTerms: extra.paymentTerms ?? 'CASH',
          primaryPhone: extra.primaryPhone,
          // the importer/edit paths keep this in step; phone search reads it
          primaryPhoneNorm: extra.primaryPhone ? normalizePhone(extra.primaryPhone) : undefined,
          contactPerson: extra.contactPerson,
          channelId,
          temixCode: code,
          branches: {
            create: {
              branchCode: `${code}-01`,
              branchName: `${name} (branch)`,
              regionId: region.id,
              routeId,
              address: 'Imported address, Muscat',
              dayOfVisit: extra.dayOfVisit,
            },
          },
        },
        include: { branches: true },
      });
      ids.branchIds[code] = c.branches[0]!.id;
      return c;
    };
    const { omanDayOfWeek } = await import('@/lib/tz');
    const today = omanDayOfWeek();
    const c1 = await mk(`${sfx}001`, `Al Noor Grocery ${sfx}`, route.id, {
      primaryPhone: '+968 9123 4567',
      dayOfVisit: today,
    });
    const c2 = await mk(`${sfx}002`, `Home delivery ${sfx}`, route.id); // individual: no phone/contact
    const c3 = await mk(`${sfx}003`, `Blue Sea Restaurant ${sfx}`, route.id, {
      paymentTerms: 'CREDIT',
      contactPerson: 'Mr Said',
    });
    const other = await mk(`${sfx}009`, `Other route shop ${sfx}`, otherRoute.id);
    ids.customerIds = [c1.id, c2.id, c3.id];
    ids.otherCustomerId = other.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const allCustomerIds = [...ids.customerIds, ids.otherCustomerId].filter(Boolean);
    const editRows = await prisma.customerEdit.findMany({
      where: { customerId: { in: allCustomerIds } },
      select: { id: true },
    });
    const editIds = editRows.map((e) => e.id);
    await prisma.notification.deleteMany({ where: { OR: [{ editId: { in: editIds } }, { userId: { in: ids.userIds } }] } });
    await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
    await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    await purgeAuditLog(prisma, { where: { actorId: { in: ids.userIds } } });
    await prisma.rateLimit.deleteMany({ where: { key: { in: ids.userIds.flatMap((u) => [`edit:${u}`, `photo:${u}`]) } } });
    // Photo slots reference attachments (and vice versa): clear the slots first.
    await prisma.customer.updateMany({ where: { id: { in: allCustomerIds } }, data: { crPhotoId: null } });
    await prisma.branch.updateMany({ where: { customerId: { in: allCustomerIds } }, data: { shopPhotoId: null, signboardPhotoId: null } });
    await prisma.attachment.deleteMany({ where: { OR: [{ capturedById: { in: ids.userIds } }, { customerId: { in: allCustomerIds } }] } });
    await prisma.branch.deleteMany({ where: { customerId: { in: allCustomerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: allCustomerIds } } });
    await prisma.user.updateMany({ where: { id: { in: ids.userIds } }, data: { ownedRouteId: null, supervisorId: null } });
    for (const id of [ids.managerId, ids.otherManagerId]) {
      await prisma.user.update({ where: { id }, data: { managedRegions: { set: [] } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } });
    await prisma.route.deleteMany({ where: { id: { in: [ids.routeId, ids.otherRouteId] } } });
    await prisma.region.deleteMany({ where: { id: { in: [ids.regionId, ids.otherRegionId] } } });
    await prisma.$disconnect();
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  /** Replicates the /customers list query for the current mock user. */
  async function listForCurrent(q = '') {
    const me = await prisma.user.findUniqueOrThrow({
      where: { id: current!.id },
      select: {
        role: true,
        ownedRouteId: true,
        reports: { where: { ownedRouteId: { not: null } }, select: { ownedRouteId: true } },
        managedRegions: { select: { id: true } },
      },
    });
    const scope = filtersLib.customerListBranchScope(me.role, {
      ownedRouteId: me.ownedRouteId,
      teamRouteIds: me.reports.map((r) => r.ownedRouteId!).filter(Boolean),
      managedRegionIds: me.managedRegions.map((r) => r.id),
    });
    const base: import('@prisma/client').Prisma.CustomerWhereInput = { deletedAt: null };
    if (scope.forceEmpty) base.id = '__none__';
    const where = filtersLib.applyCustomerFilters(
      base,
      scope.forceEmpty ? undefined : scope.branchSome,
      filtersLib.parseCustomerFilters({ q }),
      [],
      null
    );
    return prisma.customer.findMany({ where, select: { id: true, nmwcCode: true } });
  }

  /** Simulates /api/photos/finalize (the R2 part is not under test here). */
  async function finalizedPhoto(kind: 'SHOP' | 'SIGNBOARD' | 'CR' | 'FREE') {
    const att = await prisma.attachment.create({
      data: {
        kind,
        r2Key: `2026/09/10/${current!.id}/${kind}/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 123_456,
        width: 1600,
        height: 1200,
        capturedById: current!.id,
        capturedAt: new Date(),
        capturedLat: 23.588,
        capturedLng: 58.3829,
        hash: createHash('sha256').update(randomUUID()).digest('hex'),
      },
    });
    ids.attachmentIds.push(att.id);
    return att.id;
  }

  const fullPayload = (customerId: string, branchId: string, overrides: Record<string, unknown> = {}) => ({
    customerId,
    isDraft: false,
    customer: {
      channelId,
      subChannelId,
      primaryPhone: '+968 9876 5432',
      contactPerson: 'Abdullah (owner)',
      contactRole: 'Owner',
      crNumber: '1234567',
      ...(overrides.customer as object),
    },
    branches: [
      {
        branchId,
        address: 'Way 4412, Al Khuwair, Muscat — next to the mosque',
        gpsLat: 23.5880,
        gpsLng: 58.3829,
        gpsAccuracy: 8,
        // fixed: a re-submit must not diff on the capture timestamp alone
        gpsCapturedAt: new Date('2026-09-10T08:00:00.000Z'),
        dayOfVisit: PROPOSED_DAY,
        coolersCount: 2,
        standsCount: 1,
        emptyBottlesCount: 12,
        ...(overrides.branch as object),
      },
    ],
  });

  // ── 1. scope + search ─────────────────────────────────────────────────────
  it('salesman sees exactly the customers on their route, and can search them', async () => {
    asSalesman();
    const mine = await listForCurrent();
    expect(mine.map((c) => c.id).sort()).toEqual([...ids.customerIds].sort());
    expect(mine.some((c) => c.id === ids.otherCustomerId)).toBe(false);

    const byName = await listForCurrent('blue sea');
    expect(byName.map((c) => c.nmwcCode)).toEqual([`${sfx}003`]);
    const byCode = await listForCurrent(`${sfx}002`);
    expect(byCode.map((c) => c.nmwcCode)).toEqual([`${sfx}002`]);
    const byBranchCode = await listForCurrent(`${sfx}001-01`);
    expect(byBranchCode.map((c) => c.nmwcCode)).toEqual([`${sfx}001`]);
    const byPhone = await listForCurrent('91234567');
    expect(byPhone.map((c) => c.nmwcCode)).toEqual([`${sfx}001`]);
    // A search term matching only an out-of-scope customer returns nothing.
    const foreign = await listForCurrent(`Other route shop ${sfx}`);
    expect(foreign).toEqual([]);

    asOtherSalesman();
    const theirs = await listForCurrent();
    expect(theirs.map((c) => c.id)).toEqual([ids.otherCustomerId]);
  });

  it("today's visit list is the route's branches flagged for the Oman weekday", async () => {
    const { omanDayOfWeek } = await import('@/lib/tz');
    const today = omanDayOfWeek();
    const branches = await prisma.branch.findMany({
      where: { routeId: ids.routeId, deletedAt: null, dayOfVisit: today },
      select: { customerId: true },
    });
    expect(branches.map((b) => b.customerId)).toEqual([ids.customerIds[0]]);
  });

  it('the manager (direct supervisor, region owner) sees the whole region; a manager of another region sees nothing', async () => {
    asManager();
    const mine = await listForCurrent();
    expect(mine.map((c) => c.id).sort()).toEqual([...ids.customerIds, ids.otherCustomerId].sort());
    asOtherManager();
    expect(await listForCurrent()).toEqual([]);
  });

  // ── 2. the mandatory-field gate (documents current behaviour) ─────────────
  it('documents the submit gate (CORE, owner decision 2026-09-10): phone, contact, address, GPS and shop photo block a submit; CR / sub-channel / signboard / day do not', async () => {
    asSalesman();
    const customerId = ids.customerIds[1]!; // the individual: no phone, no contact, no CR
    const branchId = ids.branchIds[`${sfx}002`]!;
    const res = await edits.submitEditAction({
      customerId,
      isDraft: false,
      customer: { primaryPhone: '+968 9111 2222' },
      branches: [{ branchId }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const missing = Object.keys(res.fields ?? {});
    expect(missing).toEqual(
      expect.arrayContaining([
        'customer.contactPerson',
        `branch.${branchId}.gps`,
        `branch.${branchId}.shopPhoto`,
      ])
    );
    for (const notBlocking of [
      'customer.subChannelId',
      'customer.crNumber',
      'customer.crPhoto',
      `branch.${branchId}.dayOfVisit`,
      `branch.${branchId}.signboardPhoto`,
    ]) {
      expect(missing, `${notBlocking} must not block under CORE`).not.toContain(notBlocking);
    }
    // A draft is always allowed — the salesman can save partial work.
    const draft = await edits.submitEditAction({
      customerId,
      isDraft: true,
      customer: { primaryPhone: '+968 9111 2222' },
      branches: [{ branchId }],
    });
    expect(draft.ok).toBe(true);
  });

  // ── 3. photos ─────────────────────────────────────────────────────────────
  it('salesman attaches CR / shop / signboard photos to their own customer only', async () => {
    asSalesman();
    const customerId = ids.customerIds[0]!;
    const branchId = ids.branchIds[`${sfx}001`]!;
    const cr = await finalizedPhoto('CR');
    const shop = await finalizedPhoto('SHOP');
    const sign = await finalizedPhoto('SIGNBOARD');
    expect((await photos.attachPhotoAction({ attachmentId: cr, customerId, slot: 'CR' })).ok).toBe(true);
    expect((await photos.attachPhotoAction({ attachmentId: shop, branchId, slot: 'SHOP' })).ok).toBe(true);
    expect((await photos.attachPhotoAction({ attachmentId: sign, branchId, slot: 'SIGNBOARD' })).ok).toBe(true);
    const c = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      include: { branches: true },
    });
    expect(c.crPhotoId).toBe(cr);
    expect(c.branches[0]!.shopPhotoId).toBe(shop);
    expect(c.branches[0]!.signboardPhotoId).toBe(sign);
    expect(c.completenessScore).toBeGreaterThan(0);

    // Wrong kind into a slot is refused; another route's salesman is refused.
    const free = await finalizedPhoto('FREE');
    const wrongKind = await photos.attachPhotoAction({ attachmentId: free, branchId, slot: 'SHOP' });
    expect(wrongKind.ok).toBe(false);
    asOtherSalesman();
    const foreignShop = await finalizedPhoto('SHOP');
    const foreign = await photos.attachPhotoAction({ attachmentId: foreignShop, branchId, slot: 'SHOP' });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe('FORBIDDEN');

    // The manager can view the photo (scope), the other region's manager cannot.
    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: shop } });
    asManager();
    await expect(
      access.assertCanAccessAttachment(
        { id: ids.managerId, role: 'MANAGER', username: '' },
        att,
        await access.loadScope(ids.managerId)
      )
    ).resolves.toBeUndefined();
    await expect(
      access.assertCanAccessAttachment(
        { id: ids.otherManagerId, role: 'MANAGER', username: '' },
        att,
        await access.loadScope(ids.otherManagerId)
      )
    ).rejects.toThrow();
  });

  // ── 4. GPS validation ─────────────────────────────────────────────────────
  it('GPS outside Oman is rejected with a field-keyed error the form can show', async () => {
    asSalesman();
    const customerId = ids.customerIds[0]!;
    const branchId = ids.branchIds[`${sfx}001`]!;
    const res = await edits.submitEditAction(
      fullPayload(customerId, branchId, { branch: { gpsLat: 10.0, gpsLng: 58.0 } })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fields?.[`branch.${branchId}.gps`]).toMatch(/Oman/);
  });

  // ── 5. submit → queue → approve ───────────────────────────────────────────
  let approvedEditId = '';
  it('salesman submits a complete enrichment; it lands in the manager queue with a notification', async () => {
    asSalesman();
    const customerId = ids.customerIds[0]!;
    const branchId = ids.branchIds[`${sfx}001`]!;
    const res = await edits.submitEditAction(fullPayload(customerId, branchId));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.state).toBe('SUBMITTED');
    approvedEditId = res.data.editId;
    const edit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: approvedEditId } });
    expect(edit.pendingRole).toBe('SUPERVISOR');
    expect(edit.process).toBe('UPDATE');
    const notif = await prisma.notification.findFirst({
      where: { userId: ids.managerId, editId: approvedEditId, kind: 'EDIT_SUBMITTED' },
    });
    expect(notif).not.toBeNull();

    // One open edit per customer.
    const again = await edits.submitEditAction(
      fullPayload(customerId, branchId, { customer: { contactRole: 'Manager' } })
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('EDIT_LOCKED');

    // The customer itself is untouched until approval.
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(c.contactPerson).toBeNull();
  });

  it('the /approvals queue query shows it to the region manager and hides it from another region', async () => {
    const queueFor = async (managerId: string) => {
      const scope = await access.loadScope(managerId);
      if (scope.managedRegionIds.length === 0) return [];
      return prisma.customerEdit.findMany({
        where: {
          state: 'SUBMITTED',
          AND: [
            { OR: [{ pendingRole: 'SUPERVISOR' }, { pendingRole: null }] },
            {
              OR: [
                {
                  customer: {
                    branches: { some: { regionId: { in: scope.managedRegionIds }, deletedAt: null } },
                  },
                },
                { branchDrafts: { some: { route: { regionId: { in: scope.managedRegionIds } } } } },
              ],
            },
          ],
        },
        select: { id: true },
      });
    };
    expect((await queueFor(ids.managerId)).map((e) => e.id)).toContain(approvedEditId);
    expect((await queueFor(ids.otherManagerId)).map((e) => e.id)).not.toContain(approvedEditId);
  });

  it('the other-region manager cannot approve it; the region manager can, and the changes go live', async () => {
    const fd = new FormData();
    fd.set('editId', approvedEditId);
    asOtherManager();
    const denied = await edits.approveEditAction(fd);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('FORBIDDEN');

    // The salesman can never approve their own edit.
    asSalesman();
    const self = await edits.approveEditAction(fd);
    expect(self.ok).toBe(false);

    asManager();
    const ok = await edits.approveEditAction(fd);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);

    const edit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: approvedEditId } });
    expect(edit.state).toBe('APPROVED');
    expect(edit.reviewedById).toBe(ids.managerId);
    const c = await prisma.customer.findUniqueOrThrow({
      where: { id: ids.customerIds[0]! },
      include: { branches: true },
    });
    // phones are stored normalized (E.164-ish) by the submit path
    expect(c.primaryPhone).toBe('+96898765432');
    expect(c.primaryPhoneNorm).toBe('+96898765432');
    expect(c.contactPerson).toBe('Abdullah (owner)');
    expect(c.subChannelId).toBe(subChannelId);
    expect(c.crNumber).toBe('1234567');
    const b = c.branches[0]!;
    expect(b.gpsLat).toBeCloseTo(23.588, 3);
    expect(b.gpsLng).toBeCloseTo(58.3829, 3);
    expect(b.dayOfVisit).toBe(PROPOSED_DAY);
    expect(b.address).toContain('Al Khuwair');
    expect(b.coolersCount).toBe(2);
    expect(c.completenessScore).toBeGreaterThanOrEqual(90);

    const audit = await prisma.auditLog.findFirst({
      where: { actorId: ids.managerId, action: 'APPROVE', entityId: approvedEditId },
    });
    expect(audit).not.toBeNull();
    const notif = await prisma.notification.findFirst({
      where: { userId: ids.salesmanId, editId: approvedEditId, kind: 'EDIT_APPROVED_FINAL' },
    });
    expect(notif).not.toBeNull();
    const step = await prisma.editApproval.findFirst({ where: { editId: approvedEditId } });
    expect(step?.decision).toBe('APPROVED');
  });

  // ── 6. reject → needs correction → resubmit ───────────────────────────────
  it('manager rejects a second edit with a reason; the salesman sees it under Needs correction and can resubmit', async () => {
    asSalesman();
    const customerId = ids.customerIds[0]!;
    const branchId = ids.branchIds[`${sfx}001`]!;
    const res = await edits.submitEditAction(
      fullPayload(customerId, branchId, { customer: { contactRole: 'Partner' } })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const editId = res.data.editId;
    const edit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    // Only the delta vs. the now-live record is in the diff.
    const changes = edit.fieldChanges as Array<{ field: string }>;
    expect(changes.map((c) => c.field)).toEqual(['customer.contactRole']);

    asManager();
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('reason', 'Contact role looks wrong — please confirm with the shop.');
    fd.set('category', 'wrong_info');
    const rej = await edits.rejectEditAction(fd);
    expect(rej.ok, JSON.stringify(rej)).toBe(true);
    const after = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect(after.state).toBe('NEEDS_CORRECTION');
    expect(after.decisionReason).toContain('Contact role');
    const mine = await prisma.customerEdit.findMany({
      where: { submittedById: ids.salesmanId, state: 'NEEDS_CORRECTION' },
    });
    expect(mine.map((e) => e.id)).toContain(editId);
    const notif = await prisma.notification.findFirst({
      where: { userId: ids.salesmanId, editId, kind: 'EDIT_NEEDS_CORRECTION' },
    });
    expect(notif).not.toBeNull();
    const live = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(live.contactRole).toBe('Owner'); // rejected proposal never applied

    // Resubmit (a new edit) and approve.
    asSalesman();
    const res2 = await edits.submitEditAction(
      fullPayload(customerId, branchId, { customer: { contactRole: 'Owner / Partner' } })
    );
    expect(res2.ok, JSON.stringify(res2)).toBe(true);
    if (!res2.ok) return;
    asManager();
    const fd2 = new FormData();
    fd2.set('editId', res2.data.editId);
    expect((await edits.approveEditAction(fd2)).ok).toBe(true);
    const final = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(final.contactRole).toBe('Owner / Partner');
  });

  it('a salesman from another route cannot edit the customer at all', async () => {
    asOtherSalesman();
    const res = await edits.submitEditAction(
      fullPayload(ids.customerIds[0]!, ids.branchIds[`${sfx}001`]!)
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');
  });

  // ── 7. the field-update report ────────────────────────────────────────────
  it('the field-update report highlights exactly the changed cells (yellow), pending proposals (orange), and nothing else', async () => {
    // Leave one PENDING proposal on the CREDIT customer so the orange path is exercised.
    asSalesman();
    const c3 = ids.customerIds[2]!;
    const b3 = ids.branchIds[`${sfx}003`]!;
    const cr3 = await finalizedPhoto('CR');
    const shop3 = await finalizedPhoto('SHOP');
    const sign3 = await finalizedPhoto('SIGNBOARD');
    await photos.attachPhotoAction({ attachmentId: cr3, customerId: c3, slot: 'CR' });
    await photos.attachPhotoAction({ attachmentId: shop3, branchId: b3, slot: 'SHOP' });
    await photos.attachPhotoAction({ attachmentId: sign3, branchId: b3, slot: 'SIGNBOARD' });
    const pending = await edits.submitEditAction(
      fullPayload(c3, b3, { customer: { crNumber: undefined, primaryPhone: '+968 2444 5555' } })
    );
    expect(pending.ok, JSON.stringify(pending)).toBe(true);

    const out = await report.buildChangeReport(
      { id: ids.managerId, role: 'MANAGER', username: `qa.mgr.${sfx}` },
      { since: testStart, regionIds: [ids.regionId] }
    );
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(new Uint8Array(out.bytes).buffer as ArrayBuffer);
    const ws = wb.getWorksheet('Customers')!;
    const header: string[] = [];
    ws.getRow(1).eachCell((c, i) => {
      header[i] = String(c.value);
    });
    const col = (name: string) => header.indexOf(name);
    const rowOf = (code: string) => {
      let found: import('exceljs').Row | null = null;
      ws.eachRow((r, n) => {
        if (n > 1 && String(r.getCell(col('cust_code')).value) === code) found = r;
      });
      return found!;
    };
    const fillOf = (r: import('exceljs').Row, name: string) => {
      const f = r.getCell(col(name)).fill as { fgColor?: { argb?: string } } | undefined;
      return f?.fgColor?.argb ?? null;
    };
    const YELLOW = 'FFFFFF00';
    const ORANGE = 'FFFFC000';

    // All four customers of the region are present (one row per branch).
    expect(out.rowCount).toBe(4);
    expect(out.changedRows).toBe(2);

    const r1 = rowOf(`${sfx}001`);
    for (const changed of ['phone', 'contact_person', 'sub_channel', 'cr_no', 'address', 'gps_lat', 'gps_lng', 'gps_map', 'day_of_visit', 'coolers', 'stands', 'empty_bottles', 'contact_role', 'cr_photo', 'shop_photo', 'signboard_photo']) {
      expect(fillOf(r1, changed), `expected ${changed} highlighted`).toBe(YELLOW);
    }
    for (const untouched of ['cust_code', 'cust_name', 'branch_name', 'channel', 'alt_phone', 'opening_hours', 'delivery_window', 'notes', 'customer_status', 'branch_status', 'payment_terms']) {
      expect(fillOf(r1, untouched), `expected ${untouched} NOT highlighted`).toBeNull();
    }
    // a phone must come out exactly as stored — no formula-guard apostrophe
    expect(String(r1.getCell(col('phone')).value)).toBe('+96898765432');
    expect(String(r1.getCell(col('changed_by')).value)).toBe(ids.routeCode.toLowerCase());
    expect(String(r1.getCell(col('approved_by')).value)).toBe(`qa.mgr.${sfx}`);
    expect(String(r1.getCell(col('changed_fields')).value)).toContain('gps_lat');
    expect(r1.getCell(col('phone')).note).toBeTruthy();

    const r3 = rowOf(`${sfx}003`);
    expect(fillOf(r3, 'phone')).toBe(ORANGE); // pending proposal, current value shown
    expect(String(r3.getCell(col('phone')).value)).toBe(''); // not applied yet
    expect(String(r3.getCell(col('pending_by')).value)).toBe(ids.routeCode.toLowerCase());
    expect(fillOf(r3, 'shop_photo')).toBe(YELLOW); // photo added in the window

    const r2 = rowOf(`${sfx}002`);
    expect(fillOf(r2, 'phone')).toBeNull(); // only a DRAFT existed — never approved, never pending
    expect(String(r2.getCell(col('changed_fields')).value ?? '')).toBe('');
    const r9 = rowOf(`${sfx}009`);
    expect(String(r9.getCell(col('changed_fields')).value ?? '')).toBe('');

    // Changes sheet: before → after rows, incl. the rejected one? No — only approved + pending.
    const wc = wb.getWorksheet('Changes')!;
    const changeRows: string[][] = [];
    wc.eachRow((r, n) => {
      if (n > 1) changeRows.push(r.values as string[]);
    });
    const phoneRow = changeRows.find((r) => r.includes(`${sfx}001`) && r.includes('phone'));
    expect(phoneRow).toBeTruthy();
    expect(phoneRow!.join('|')).toContain('+96898765432');
    expect(phoneRow!.join('|')).toContain('APPROVED');
    const pendingRow = changeRows.find((r) => r.includes(`${sfx}003`) && r.includes('PENDING'));
    expect(pendingRow).toBeTruthy();
    // Sub-channel change shows the label, not the cuid.
    const subRow = changeRows.find((r) => r.includes(`${sfx}001`) && r.includes('sub_channel'));
    expect(subRow!.join('|')).not.toContain(subChannelId);

    // By salesman: our salesman updated 1 customer, captured GPS once, added photos.
    const wt = wb.getWorksheet('By salesman')!;
    const tallies: Record<string, unknown>[] = [];
    const th: string[] = [];
    wt.getRow(1).eachCell((c, i) => (th[i] = String(c.value)));
    wt.eachRow((r, n) => {
      if (n > 1) tallies.push(Object.fromEntries(th.map((h, i) => [h, r.getCell(i).value]).filter(([h]) => h)));
    });
    const mine = tallies.find((t) => t.salesman === ids.routeCode.toLowerCase());
    expect(mine).toBeTruthy();
    expect(Number(mine!.customers_updated)).toBe(1);
    expect(Number(mine!.gps_captured)).toBe(1);
    expect(Number(mine!.photos_added)).toBe(6);
    expect(Number(mine!.edits_pending)).toBe(1);

    // onlyChanged drops the untouched rows.
    const only = await report.buildChangeReport(
      { id: ids.managerId, role: 'MANAGER', username: `qa.mgr.${sfx}` },
      { since: testStart, regionIds: [ids.regionId], onlyChanged: true }
    );
    expect(only.rowCount).toBe(2);

    // Scope: the other region's manager gets nothing for this region.
    const none = await report.buildChangeReport(
      { id: ids.otherManagerId, role: 'MANAGER', username: `qa.mgr2.${sfx}` },
      { since: testStart, regionIds: [ids.regionId] }
    );
    expect(none.rowCount).toBe(0);
  });
});
