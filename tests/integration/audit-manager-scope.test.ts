// @vitest-environment node
/**
 * Launch fix (2026-10-07): a Manager's /audit, against real Postgres
 * (lib/audit-scope.ts managerAuditScopeSql and managerAuditUserIds).
 *
 * What was wrong: his filter was region-scoped Customer and Branch rows OR every
 * User and ImportBatch row. Every request decision (CustomerEdit) and every
 * Region and Route row of his regions was hidden from him, and every user-admin
 * and import event in the company was shown.
 *
 * Fixtures: two synthetic regions (his, and another), a route, a salesman, a
 * customer, a new-customer request and an attachment in each, and an audit row
 * about each — plus an import batch and two exports. The query runs over this
 * suite's own audit rows only, so other suites' rows cannot change the answer.
 *
 *   RUN_AUDIT_SCOPE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/audit-manager-scope.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AuditAction } from '@prisma/client';
import { purgeAuditLog, purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_AUDIT_SCOPE === '1' && !!process.env.DATABASE_URL;
const sfx = `aud${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('a Manager’s audit log: his regions’ events and his people, nothing else', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let Prisma: typeof import('@prisma/client').Prisma;
  let lib: typeof import('@/lib/audit-scope');

  const ids = {
    regMine: '', regOther: '', rtMine: '', rtOther: '',
    manager: '', steward: '', smMine: '', smOther: '', viewer: '',
    custMine: '', custOther: '', custArchived: '', brMine: '', brOther: '', brArchived: '',
    editMine: '', editOther: '', createMine: '', createOther: '', attMine: '', attOther: '',
  };
  const editIds: string[] = [];
  /** audit row id → what it is about */
  const rows = new Map<string, string>();

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    ({ Prisma } = await import('@prisma/client'));
    lib = await import('@/lib/audit-scope');

    ids.regMine = (await prisma.region.create({ data: { name: `Audit Mine ${sfx}`, code: `${sfx}-M` } })).id;
    ids.regOther = (await prisma.region.create({ data: { name: `Audit Other ${sfx}`, code: `${sfx}-O` } })).id;
    ids.rtMine = (await prisma.route.create({ data: { name: 'Audit mine', code: `${sfx}-RM`, regionId: ids.regMine } })).id;
    ids.rtOther = (await prisma.route.create({ data: { name: 'Audit other', code: `${sfx}-RO`, regionId: ids.regOther } })).id;

    const user = async (key: string, data: Record<string, unknown>) =>
      (await prisma.user.create({
        data: { username: `${sfx}.${key}`, fullName: `Audit ${key}`, passwordHash: 'x', ...data } as never,
      })).id;
    ids.steward = await user('stw', { role: 'STEWARD' });
    ids.manager = await user('mgr', { role: 'MANAGER', managedRegions: { connect: [{ id: ids.regMine }] } });
    ids.smMine = await user('smm', { role: 'SALESMAN', ownedRouteId: ids.rtMine, supervisorId: ids.manager });
    ids.smOther = await user('smo', { role: 'SALESMAN', ownedRouteId: ids.rtOther });
    ids.viewer = await user('vw', { role: 'VIEWER' });

    const customer = async (key: string, regionId: string, routeId: string, deleted = false) => {
      const c = await prisma.customer.create({
        data: { nmwcCode: `${sfx}-${key}`, legalName: `Audit ${key}`, createdById: ids.steward },
      });
      const b = await prisma.branch.create({
        data: {
          customerId: c.id, branchCode: `${sfx}-${key}-0`, branchName: `Audit ${key}`, address: 'Synthetic Way 1',
          regionId, routeId, deletedAt: deleted ? new Date() : null,
        },
      });
      return [c.id, b.id] as const;
    };
    [ids.custMine, ids.brMine] = await customer('mine', ids.regMine, ids.rtMine);
    [ids.custOther, ids.brOther] = await customer('other', ids.regOther, ids.rtOther);
    // Archived since: its history is still his.
    [ids.custArchived, ids.brArchived] = await customer('arch', ids.regMine, ids.rtMine, true);

    const edit = async (data: Record<string, unknown>) => {
      const e = await prisma.customerEdit.create({
        data: { target: 'CUSTOMER', submittedById: ids.smMine, fieldChanges: [], attachmentChanges: [], state: 'APPROVED', ...data } as never,
      });
      editIds.push(e.id);
      return e.id;
    };
    ids.editMine = await edit({ customerId: ids.custMine });
    ids.editOther = await edit({ customerId: ids.custOther, submittedById: ids.smOther });
    const create = (routeId: string, regionId: string) => ({
      process: 'CREATE', customerId: null,
      branchDrafts: { create: [{ branchName: 'Synthetic draft', regionId, routeId, address: 'Synthetic Way 2' }] },
    });
    ids.createMine = await edit(create(ids.rtMine, ids.regMine));
    ids.createOther = await edit({ ...create(ids.rtOther, ids.regOther), submittedById: ids.smOther });

    const attachment = async (key: string, branchId: string) =>
      (await prisma.attachment.create({
        data: {
          kind: 'SHOP', branchId, r2Key: `${sfx}/${key}.jpg`, mimeType: 'image/jpeg', bytes: 1,
          capturedById: ids.smMine, capturedAt: new Date(), deletedAt: new Date(),
        },
      })).id;
    ids.attMine = await attachment('mine', ids.brMine);
    ids.attOther = await attachment('other', ids.brOther);

    const audit = async (label: string, entityType: string, entityId: string, action: AuditAction = 'UPDATE', actorId = ids.steward) => {
      const a = await prisma.auditLog.create({ data: { actorId, action, entityType, entityId, reason: `${sfx} ${label}` } });
      rows.set(a.id, label);
    };
    await audit('customer mine', 'Customer', ids.custMine);
    await audit('customer other', 'Customer', ids.custOther);
    await audit('customer archived', 'Customer', ids.custArchived, 'SOFT_DELETE');
    await audit('branch mine', 'Branch', ids.brMine, 'REACTIVATE');
    await audit('branch other', 'Branch', ids.brOther);
    await audit('decision mine', 'CustomerEdit', ids.editMine, 'APPROVE', ids.manager);
    await audit('decision other', 'CustomerEdit', ids.editOther, 'REJECT');
    await audit('create mine', 'CustomerEdit', ids.createMine, 'STEP_APPROVE');
    await audit('create other', 'CustomerEdit', ids.createOther, 'ESCALATE');
    await audit('photo mine', 'Attachment', ids.attMine);
    await audit('photo other', 'Attachment', ids.attOther);
    await audit('region mine', 'Region', ids.regMine);
    await audit('region other', 'Region', ids.regOther);
    await audit('route mine', 'Route', ids.rtMine);
    await audit('route other', 'Route', ids.rtOther);
    await audit('reset of my salesman', 'User', ids.smMine);
    await audit('reset of another region’s salesman', 'User', ids.smOther, 'UPDATE', ids.manager);
    await audit('a viewer created', 'User', ids.viewer, 'CREATE');
    await audit('my own sign-in', 'User', ids.manager, 'LOGIN', ids.manager);
    await audit('an import', 'ImportBatch', `${sfx}-batch`, 'IMPORT');
    await audit('my export', 'Export', `${sfx}-x1`, 'EXPORT', ids.manager);
    await audit('the steward’s export', 'Export', `${sfx}-x2`, 'EXPORT');
    await audit('a duplicate pair', 'CustomerPair', `${ids.custMine}|${ids.custOther}`);
  });

  afterAll(async () => {
    if (!prisma) return;
    await purgeAuditLog(prisma, { where: { id: { in: [...rows.keys()] } } });
    if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    await prisma.attachment.deleteMany({ where: { id: { in: [ids.attMine, ids.attOther].filter(Boolean) } } });
    const custs = [ids.custMine, ids.custOther, ids.custArchived].filter(Boolean);
    await prisma.branch.deleteMany({ where: { customerId: { in: custs } } });
    await prisma.customer.deleteMany({ where: { id: { in: custs } } });
    const people = [ids.smMine, ids.smOther, ids.viewer, ids.manager, ids.steward].filter(Boolean);
    await prisma.user.updateMany({ where: { id: { in: people } }, data: { ownedRouteId: null, supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.route.deleteMany({ where: { id: { in: [ids.rtMine, ids.rtOther].filter(Boolean) } } });
    await prisma.region.deleteMany({ where: { id: { in: [ids.regMine, ids.regOther].filter(Boolean) } } });
    await prisma.$disconnect();
  });

  it('his people are his own account and the salesman of his region, not the other region’s or a Viewer', async () => {
    const userIds = await lib.managerAuditUserIds(prisma, ids.manager, [ids.regMine]);
    expect(userIds).toContain(ids.manager);
    expect(userIds).toContain(ids.smMine);
    expect(userIds).not.toContain(ids.smOther);
    expect(userIds).not.toContain(ids.viewer);
    expect(userIds).not.toContain(ids.steward);
  });

  it('shows his regions’ decisions, places and people, and hides everyone else’s', async () => {
    const userIds = await lib.managerAuditUserIds(prisma, ids.manager, [ids.regMine]);
    const seen = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a."id" FROM "AuditLog" a
       WHERE a."id" = ANY(${[...rows.keys()]}::text[])
         AND ${lib.managerAuditScopeSql({ regionIds: [ids.regMine], userIds })}`);
    expect(seen.map((r) => rows.get(r.id)).sort()).toEqual(
      [
        'customer mine',
        'customer archived',
        'branch mine',
        'decision mine',
        'create mine',
        'photo mine',
        'region mine',
        'route mine',
        'reset of my salesman',
        'my own sign-in',
        'my export',
      ].sort()
    );
  });

  it('the other region’s Manager sees the mirror image of the places, and none of the first one’s people', async () => {
    const seen = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a."id" FROM "AuditLog" a
       WHERE a."id" = ANY(${[...rows.keys()]}::text[])
         AND ${lib.managerAuditScopeSql({ regionIds: [ids.regOther], userIds: [ids.smOther] })}`);
    expect(seen.map((r) => rows.get(r.id)).sort()).toEqual(
      [
        'customer other',
        'branch other',
        'decision other',
        'create other',
        'photo other',
        'region other',
        'route other',
        'reset of another region’s salesman',
      ].sort()
    );
  });
});
