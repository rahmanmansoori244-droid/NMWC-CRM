// @vitest-environment node
/**
 * Account master: a salesman row takes its route from the current owner only if
 * the row itself lands (benchmark item 20, found while mapping the Steward's
 * fix paths).
 *
 * The defect: the route was taken off its owner, with a REASSIGN audit row
 * saying "reassigned to <new user>", BEFORE the row's remaining checks. A new
 * salesman row with no password, or one whose account write then failed (a
 * duplicate email), was skipped as an issue — and the route was left with no
 * salesman at all, behind an audit row naming an account that was never
 * created. Re-importing the account master is how routes get handed over, so
 * this is the path the Steward uses.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-route-handover.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const USERS_HEADERS = [
  'username',
  'full_name',
  'role',
  'password',
  'supervisor_username',
  'route_code',
  'region_codes',
  'email',
  'phone',
  'reset_password',
  'change_role',
  'must_change_password',
] as const;

async function accountMaster(rows: Array<Record<string, string>>): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.addRow([...USERS_HEADERS]);
  for (const r of rows) ws.addRow(USERS_HEADERS.map((h) => r[h] ?? ''));
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out));
  return bytes;
}

describe.skipIf(!ENABLED)('account master: a route changes hands only when the new row lands', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8);
  const stewardId = `ZZ-RHO-${tag}`;
  const routeCode = `ZZRHO-${tag}`.toUpperCase();
  const owner = `zz.rho.owner.${tag}`;
  const takenEmail = `zz.rho.${tag}@example.invalid`;
  const emailHolder = `zz.rho.mail.${tag}`;
  const newcomers: string[] = [];
  const batchIds: string[] = [];
  let regionId = '';
  let routeId = '';

  const upload = async (rows: Array<Record<string, string>>) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
    const fd = new FormData();
    fd.set('file', new File([await accountMaster(rows)], 'account-master.xlsx', { type: XLSX_MIME }));
    const res = await imports.uploadAccountMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = (res as { ok: true; data: { batchId: string; clean: number; issues: number } }).data;
    batchIds.push(data.batchId);
    const rowsOut = await prisma.importRow.findMany({ where: { batchId: data.batchId }, select: { issues: true } });
    const messages = rowsOut
      .flatMap((r) => (r.issues as { message: string }[] | null) ?? [])
      .map((i) => i.message);
    return { ...data, messages };
  };
  const routeOwner = async () =>
    (await prisma.user.findFirst({ where: { ownedRouteId: routeId }, select: { username: true } }))?.username ?? null;
  const reassignRows = () =>
    prisma.auditLog.findMany({
      where: { action: 'REASSIGN', actorId: stewardId },
      select: { entityId: true, reason: true, before: true, after: true },
    });
  const salesman = (username: string, over: Record<string, string> = {}) => ({
    username,
    full_name: `ZZ ${username}`,
    role: 'SALESMAN',
    password: '12345',
    route_code: routeCode,
    must_change_password: 'yes',
    ...over,
  });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    regionId = (await prisma.region.create({ data: { code: `ZZRHO-R-${tag}`, name: `ZZ RHO ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: routeCode, name: `ZZ RHO ${tag}`, regionId } })).id;
    await prisma.user.create({
      data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' },
    });
    await prisma.user.create({
      data: { username: owner, passwordHash: 'x', fullName: 'ZZ Owner', role: 'SALESMAN', ownedRouteId: routeId },
    });
    await prisma.user.create({
      data: { username: emailHolder, passwordHash: 'x', fullName: 'ZZ Mail', role: 'VIEWER', email: takenEmail },
    });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await purgeAuditLog(prisma, { where: { actorId: stewardId } });
      for (const id of batchIds) {
        await prisma.importRow.deleteMany({ where: { batchId: id } });
        await prisma.importBatch.deleteMany({ where: { id } });
      }
      await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
      await prisma.user.deleteMany({ where: { username: { in: [owner, emailHolder, ...newcomers] } } });
      await prisma.user.deleteMany({ where: { id: stewardId } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('a new salesman row with no password is skipped — and the route keeps its owner', async () => {
    const fresh = `zz.rho.nopw.${tag}`;
    newcomers.push(fresh);
    const res = await upload([salesman(fresh, { password: '' })]);
    expect(res.clean).toBe(0);
    expect(res.messages.join(' ')).toMatch(/new user needs a password/);
    expect(await routeOwner()).toBe(owner);
    expect(await reassignRows()).toEqual([]);
    expect(await prisma.user.findUnique({ where: { username: fresh } })).toBeNull();
  });

  it('a row whose account write fails (an email already in use) leaves the route with its owner', async () => {
    const fresh = `zz.rho.dupmail.${tag}`;
    newcomers.push(fresh);
    const res = await upload([salesman(fresh, { email: takenEmail })]);
    expect(res.clean).toBe(0);
    expect(res.issues).toBe(1);
    expect(await routeOwner()).toBe(owner);
    expect(await reassignRows()).toEqual([]);
    expect(await prisma.user.findUnique({ where: { username: fresh } })).toBeNull();
  });

  it('a row that lands takes the route, and the handover is audited', async () => {
    const fresh = `zz.rho.new.${tag}`;
    newcomers.push(fresh);
    const res = await upload([salesman(fresh)]);
    expect(res.clean).toBe(1);
    expect(await routeOwner()).toBe(fresh);
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { username: owner }, select: { id: true, ownedRouteId: true } });
    expect(ownerRow.ownedRouteId).toBeNull();
    expect(await reassignRows()).toEqual([
      {
        entityId: ownerRow.id,
        reason: `route ${routeCode} reassigned to ${fresh} via import`,
        before: { ownedRouteCode: routeCode },
        after: { ownedRouteCode: null },
      },
    ]);
  });
});
