// @vitest-environment node
/**
 * STEWARD-PROVISIONING (final-hunt finding [0]) — the SR-USR-01 allowlist blocked
 * MANAGER from minting the approver tier (ACCOUNTANT/FINANCE_MANAGER/GM), but
 * `requireManager` also blocked STEWARD, so there was NO in-app path to create the
 * approvers the CREATE chains require — every net-new customer stalled forever.
 * This pins the fix: a STEWARD may provision approvers (create + promote); a
 * MANAGER still may not.
 *
 *   RUN_USER_PROVISION=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/steward-provisioning.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_USER_PROVISION === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('Steward may provision the approver tier; Manager may not', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let users: typeof import('@/services/users');
  const tag = randomUUID().slice(0, 8);
  const stewardId = `ZZUP-stew-${tag}`;
  const managerId = `ZZUP-mgr-${tag}`;
  const created: string[] = [];

  const asUser = (id: string, role: string) => { current = { id, role, username: id }; };
  function fd(entries: Record<string, string>) {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  }

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    users = await import('@/services/users');
    await prisma.user.create({ data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' } });
    await prisma.user.create({ data: { id: managerId, username: managerId, passwordHash: 'x', fullName: 'ZZ Manager', role: 'MANAGER' } });
  });

  afterAll(async () => {
    if (!prisma) return;
    const names = [...created, `zzup-acc-${tag}`, `zzup-fm-${tag}`, `zzup-gm-${tag}`, `zzup-mgracc-${tag}`, `zzup-sales-${tag}`];
    const targets = await prisma.user.findMany({ where: { username: { in: names } }, select: { id: true } });
    const allIds = [stewardId, managerId, ...targets.map((t) => t.id)];
    // createUserCore/updateUserRoleCore write AuditLog rows (actorId FK to User);
    // clear them before deleting the actors.
    await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: allIds } }, { entityId: { in: allIds } }] } });
    await prisma.user.deleteMany({ where: { username: { in: names } } });
    await prisma.user.deleteMany({ where: { id: { in: [stewardId, managerId] } } });
    await prisma.$disconnect();
  });

  it('STEWARD creates an ACCOUNTANT (and FM, GM)', async () => {
    asUser(stewardId, 'STEWARD');
    for (const [role, uname] of [['ACCOUNTANT', `zzup-acc-${tag}`], ['FINANCE_MANAGER', `zzup-fm-${tag}`], ['GM', `zzup-gm-${tag}`]] as const) {
      const res = await users.createUserAction(fd({ username: uname, fullName: `ZZ ${role}`, role, password: 'Provision-2026-xy' }));
      if (!res.ok) console.error(`create ${role} failed`, JSON.stringify(res));
      expect(res.ok).toBe(true);
      created.push(uname);
      const row = await prisma.user.findUnique({ where: { username: uname }, select: { role: true } });
      expect(row?.role).toBe(role);
    }
  });

  it('MANAGER is REJECTED creating an ACCOUNTANT', async () => {
    asUser(managerId, 'MANAGER');
    const res = await users.createUserAction(fd({ username: `zzup-mgracc-${tag}`, fullName: 'ZZ Blocked', role: 'ACCOUNTANT', password: 'Provision-2026-xy' }));
    expect(res.ok).toBe(false);
    expect((res as { ok: false; fields?: Record<string, string> }).fields?.role).toBeTruthy();
    const row = await prisma.user.findUnique({ where: { username: `zzup-mgracc-${tag}` } });
    expect(row).toBeNull(); // never created
  });

  it('STEWARD promotes a SALESMAN to ACCOUNTANT; MANAGER cannot', async () => {
    // seed a salesman (no route needed for the role-change test)
    const sales = await prisma.user.create({ data: { username: `zzup-sales-${tag}`, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN' } });
    // Manager blocked
    asUser(managerId, 'MANAGER');
    const blocked = await users.updateUserRoleAction(fd({ userId: sales.id, newRole: 'ACCOUNTANT' }));
    expect(blocked.ok).toBe(false);
    // Steward allowed
    asUser(stewardId, 'STEWARD');
    const ok = await users.updateUserRoleAction(fd({ userId: sales.id, newRole: 'ACCOUNTANT' }));
    if (!ok.ok) console.error('steward promote failed', JSON.stringify(ok));
    expect(ok.ok).toBe(true);
    const row = await prisma.user.findUnique({ where: { id: sales.id }, select: { role: true } });
    expect(row?.role).toBe('ACCOUNTANT');
  });
});
