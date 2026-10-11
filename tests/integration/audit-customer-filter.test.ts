// @vitest-environment node
/**
 * Owner decisions 2026-10-11: the Data Steward's /audit customer filter — "who
 * viewed this customer's documents" — against real Postgres (lib/audit-scope.ts
 * auditCustomersByCode, customerDocumentIds and photoViewsOfDocumentsSql, put
 * together as app/(app)/audit/page.tsx puts them).
 *
 * The photo route copies the photo's own wiring into each PHOTO_VIEW row's `after`
 * (app/api/photos/[id]/route.ts), so only a CR or guarantee view carries a
 * customer id: a shop, signboard or extra photo carries its branch, and a photo of
 * a new-customer request viewed before the final approval carries only the
 * request. The rows below are written that way, and each must still be found by
 * the customer's NMWC code or Temix code, typed in any case.
 *
 * Fixtures: customer C (a branch, a CR, a shop photo, an extra photo, and the
 * photo of the new-customer request that made it), customer D (a shop photo), and
 * customer L, archived by a merge into C: its CR now sits on C, and the view taken
 * before the merge still names L. The query runs over this suite's own audit rows
 * only, so other suites' rows cannot change the answer.
 *
 *   RUN_AUDIT_SCOPE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/audit-customer-filter.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AuditAction, Prisma as PrismaNS } from '@prisma/client';
import { purgeAuditLog, purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_AUDIT_SCOPE === '1' && !!process.env.DATABASE_URL;
const sfx = `acf${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('the Steward’s customer filter finds every view of a customer’s documents', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let Prisma: typeof import('@prisma/client').Prisma;
  let lib: typeof import('@/lib/audit-scope');

  const ids = {
    region: '', route: '', steward: '', salesman: '',
    custC: '', custD: '', custL: '', brC: '', brD: '', request: '',
    crC: '', shopC: '', freeC: '', requestPhoto: '', crMoved: '', shopD: '',
  };
  /** audit row id → what it is about */
  const rows = new Map<string, string>();
  const temixC = `${sfx.toUpperCase()}T`;

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    ({ Prisma } = await import('@prisma/client'));
    lib = await import('@/lib/audit-scope');

    ids.region = (await prisma.region.create({ data: { name: `Audit Filter ${sfx}`, code: `${sfx}-R` } })).id;
    ids.route = (await prisma.route.create({ data: { name: 'Audit filter', code: `${sfx}-RT`, regionId: ids.region } })).id;
    const user = async (key: string, data: Record<string, unknown>) =>
      (await prisma.user.create({
        data: { username: `${sfx}.${key}`, fullName: `Audit ${key}`, passwordHash: 'x', isActive: false, ...data } as never,
      })).id;
    ids.steward = await user('stw', { role: 'STEWARD' });
    ids.salesman = await user('sm', { role: 'SALESMAN', ownedRouteId: ids.route });

    const customer = async (key: string, data: Record<string, unknown> = {}) =>
      (await prisma.customer.create({
        data: { nmwcCode: `${sfx}-${key}`, legalName: `Audit ${key}`, createdById: ids.steward, ...data } as never,
      })).id;
    const branch = async (key: string, customerId: string) =>
      (await prisma.branch.create({
        data: {
          customerId, branchCode: `${sfx}-${key}-0`, branchName: `Audit ${key}`, address: 'Synthetic Way 1',
          regionId: ids.region, routeId: ids.route,
        },
      })).id;
    ids.custC = await customer('c', { temixCode: temixC });
    ids.custD = await customer('d');
    ids.custL = await customer('l', { deletedAt: new Date() });
    ids.brC = await branch('c', ids.custC);
    ids.brD = await branch('d', ids.custD);

    // The new-customer request that made C: the final approval names C on it
    // (lib/create-finalize.ts) and keeps the editId on its photos.
    ids.request = (await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', process: 'CREATE', customerId: ids.custC, submittedById: ids.salesman,
        fieldChanges: [], attachmentChanges: [], state: 'APPROVED',
        branchDrafts: { create: [{ branchName: 'Synthetic draft', regionId: ids.region, routeId: ids.route, address: 'Synthetic Way 2' }] },
      } as never,
    })).id;

    const attachment = async (key: string, kind: string, wiring: Record<string, string>) =>
      (await prisma.attachment.create({
        data: {
          kind, r2Key: `${sfx}/${key}.jpg`, mimeType: 'image/jpeg', bytes: 1,
          capturedById: ids.salesman, capturedAt: new Date(), ...wiring,
        } as never,
      })).id;
    ids.crC = await attachment('cr-c', 'CR', { customerId: ids.custC });
    ids.shopC = await attachment('shop-c', 'SHOP', { branchId: ids.brC });
    ids.freeC = await attachment('free-c', 'FREE', { branchExtraId: ids.brC });
    ids.requestPhoto = await attachment('request-c', 'SHOP', { editId: ids.request });
    // L's CR, moved onto C by the merge (services/duplicates.ts).
    ids.crMoved = await attachment('cr-l', 'CR', { customerId: ids.custC });
    ids.shopD = await attachment('shop-d', 'SHOP', { branchId: ids.brD });

    // Written as the photo route writes them: `after` is the photo's wiring at the time.
    const wiring = (w: Partial<Record<'customerId' | 'branchId' | 'branchExtraId' | 'editId', string>>, kind: string) => ({
      kind,
      customerId: w.customerId ?? null,
      branchId: w.branchId ?? null,
      branchExtraId: w.branchExtraId ?? null,
      editId: w.editId ?? null,
    });
    const audit = async (label: string, entityId: string, after: PrismaNS.InputJsonValue, action: AuditAction = 'PHOTO_VIEW') => {
      const a = await prisma.auditLog.create({
        data: { actorId: ids.steward, action, entityType: 'Attachment', entityId, after, reason: `${sfx} ${label}` },
      });
      rows.set(a.id, label);
    };
    await audit('view of C’s CR', ids.crC, wiring({ customerId: ids.custC }, 'CR'));
    await audit('view of C’s shop photo', ids.shopC, wiring({ branchId: ids.brC }, 'SHOP'));
    await audit('view of C’s extra photo', ids.freeC, wiring({ branchExtraId: ids.brC }, 'FREE'));
    await audit('view of C’s request photo, before the approval', ids.requestPhoto, wiring({ editId: ids.request }, 'SHOP'));
    await audit('view of L’s CR, before the merge', ids.crMoved, wiring({ customerId: ids.custL }, 'CR'));
    await audit('view of D’s shop photo', ids.shopD, wiring({ branchId: ids.brD }, 'SHOP'));
    await audit('an update of C’s CR, not a view', ids.crC, { kind: 'CR' }, 'UPDATE');
  });

  afterAll(async () => {
    if (!prisma) return;
    await purgeAuditLog(prisma, { where: { id: { in: [...rows.keys()] } } });
    const attachments = [ids.crC, ids.shopC, ids.freeC, ids.requestPhoto, ids.crMoved, ids.shopD].filter(Boolean);
    await prisma.attachment.deleteMany({ where: { id: { in: attachments } } });
    if (ids.request) await purgeCustomerEdits(prisma, { where: { id: { in: [ids.request] } } });
    const custs = [ids.custC, ids.custD, ids.custL].filter(Boolean);
    await prisma.branch.deleteMany({ where: { customerId: { in: custs } } });
    await prisma.customer.deleteMany({ where: { id: { in: custs } } });
    const people = [ids.salesman, ids.steward].filter(Boolean);
    await prisma.user.updateMany({ where: { id: { in: people } }, data: { ownedRouteId: null, isActive: false } });
    await prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    if (ids.route) await prisma.route.deleteMany({ where: { id: ids.route } });
    if (ids.region) await prisma.region.deleteMany({ where: { id: ids.region } });
    await prisma.$disconnect();
  });

  /** What the page shows for a typed code, over this suite's rows. */
  async function viewsFor(code: string): Promise<string[]> {
    const customers = await lib.auditCustomersByCode(prisma, code);
    const documents = await lib.customerDocumentIds(prisma, customers.map((c) => c.id));
    const archived = customers.filter((c) => c.archived).map((c) => c.id);
    const seen = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a."id" FROM "AuditLog" a
       WHERE a."id" = ANY(${[...rows.keys()]}::text[])
         AND ${lib.photoViewsOfDocumentsSql(documents, archived)}`);
    return seen.map((r) => rows.get(r.id)!).sort();
  }

  const OF_C = [
    'view of C’s CR',
    'view of C’s shop photo',
    'view of C’s extra photo',
    'view of C’s request photo, before the approval',
    // The merge made L’s documents C’s: the view is found under C’s code too.
    'view of L’s CR, before the merge',
  ].sort();

  it('by NMWC code, in any case: every document of the customer — branch and request photos included', async () => {
    expect(await viewsFor(`${sfx}-c`)).toEqual(OF_C);
    expect(await viewsFor(`  ${sfx.toUpperCase()}-C `)).toEqual(OF_C);
  });

  it('by Temix code, in any case: the same views', async () => {
    const found = await lib.auditCustomersByCode(prisma, temixC.toLowerCase());
    expect(found.map((c) => [c.id, c.archived])).toEqual([[ids.custC, false]]);
    expect(await viewsFor(temixC.toLowerCase())).toEqual(OF_C);
  });

  it('another customer’s code finds only his views', async () => {
    expect(await viewsFor(`${sfx}-d`)).toEqual(['view of D’s shop photo']);
  });

  it('a merged-away (archived) customer’s code finds the views that name him', async () => {
    const found = await lib.auditCustomersByCode(prisma, `${sfx}-l`);
    expect(found.map((c) => [c.id, c.archived])).toEqual([[ids.custL, true]]);
    expect(await viewsFor(`${sfx}-l`)).toEqual(['view of L’s CR, before the merge']);
  });

  it('a code no customer has finds nothing', async () => {
    expect(await lib.auditCustomersByCode(prisma, `${sfx}-none`)).toEqual([]);
    expect(await viewsFor(`${sfx}-none`)).toEqual([]);
  });
});
