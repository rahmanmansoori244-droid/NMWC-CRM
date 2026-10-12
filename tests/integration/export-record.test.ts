// @vitest-environment node
/**
 * Gap 14 (data audit 2026-10-10, lossless paths) on Postgres: every export is
 * recorded with which customers it held and the SHA-256 of the exact bytes sent.
 *
 *   - the customer master and the filtered list each write an ExportJob row
 *     (filters and role scope, customers, file name, SHA-256 of the bytes they
 *     return) and an EXPORT audit row keyed by it, in one transaction, before
 *     the bytes are returned;
 *   - ExportJob refuses an update and a delete outside the owner's maintenance
 *     window (it is append-only now).
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/export-record.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { src, withChangeContext } from '@/lib/change-context';
import { purgeAuditLog, purgeExportJobs, purgeHistory } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzex${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();
const REFUSED = /append-only|insufficient_privilege|permission denied/;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('every export is recorded with its customers and its fingerprint (gap 14)', () => {
  let db: PrismaClient;
  const ids = {
    region: `${sfx}-g`,
    route: `${sfx}-r`,
    steward: `${sfx}-st`,
    c1: `${sfx}-c1`,
    c2: `${sfx}-c2`,
    b1: `${sfx}-b1`,
    b2: `${sfx}-b2`,
    b3: `${sfx}-b3`,
  };
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const write = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withChangeContext(db, { actorId: ids.steward, source: src.test('export-record') }, fn);

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD)) throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
    await write(async (tx) => {
      await tx.region.create({ data: { id: ids.region, code: `G${SFX}`, name: `Export G ${sfx}` } });
      await tx.route.create({ data: { id: ids.route, code: `R${SFX}`, name: `Export R ${sfx}`, regionId: ids.region } });
      await tx.user.create({
        data: { id: ids.steward, username: `st.${sfx}`, fullName: `Export Steward ${sfx}`, role: 'STEWARD', passwordHash: 'x' },
      });
      await tx.customer.createMany({
        data: [
          { id: ids.c1, nmwcCode: `C1${SFX}`, legalName: `Export one ${sfx}` },
          { id: ids.c2, nmwcCode: `C2${SFX}`, legalName: `Export two ${sfx}` },
        ],
      });
      await tx.branch.createMany({
        data: [
          [ids.b1, ids.c1, '01'],
          [ids.b2, ids.c1, '02'],
          [ids.b3, ids.c2, '01'],
        ].map(([id, customerId, n]) => ({
          id: id!,
          customerId: customerId!,
          branchCode: `${customerId === ids.c1 ? 'C1' : 'C2'}${SFX}-${n}`,
          branchName: 'Main',
          regionId: ids.region,
          routeId: ids.route,
          address: 'Export probe address',
        })),
      });
    });
    current = { id: ids.steward, role: 'STEWARD', username: `st.${sfx}` };
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await purgeAuditLog(db, { where: { actorId: ids.steward } });
      await purgeExportJobs(db, { where: { requestedById: ids.steward } });
      await write(async (tx) => {
        await tx.branch.deleteMany({ where: { id: { in: [ids.b1, ids.b2, ids.b3] } } });
        await tx.customer.deleteMany({ where: { id: { in: [ids.c1, ids.c2] } } });
        await tx.user.deleteMany({ where: { id: ids.steward } });
        await tx.route.deleteMany({ where: { id: ids.route } });
        await tx.region.deleteMany({ where: { id: ids.region } });
      });
      await purgeHistory(db, {
        customerIds: [ids.c1, ids.c2],
        branchIds: [ids.b1, ids.b2, ids.b3],
        userIds: [ids.steward],
        routeIds: [ids.route],
        regionIds: [ids.region],
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('the customer master: its ExportJob names the customers, the file and the SHA-256 of the bytes returned', async () => {
    const exportsSvc = await import('@/services/exports');
    const out = await exportsSvc.buildCustomerExport({ regionIds: [ids.region] });
    expect(out.rowCount).toBe(3);
    const job = await db.exportJob.findFirstOrThrow({
      where: { requestedById: ids.steward, kind: 'customer-master' },
      orderBy: { startedAt: 'desc' },
    });
    expect(job).toMatchObject({
      status: 'DONE',
      rowCount: 3,
      filename: out.filename,
      fileSha256: sha(out.bytes),
    });
    expect([...job.customerIds].sort()).toEqual([ids.c1, ids.c2].sort());
    expect(job.filters).toMatchObject({ regionIds: [ids.region], scope: { role: 'STEWARD' } });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'EXPORT', entityId: job.id } });
    expect(audit).toMatchObject({ actorId: ids.steward, entityType: 'Export', reason: 'customers 3' });
    expect(audit.after).toMatchObject({ exportJobId: job.id, fileSha256: job.fileSha256, customers: 2 });
    // Same transaction as the job (gap 24's txId), and named by the export.
    expect(audit.source).toBe('export:customer-master');
  });

  it('the filtered list: the same record, with the search it was filtered by', async () => {
    const svc = await import('@/services/customer-export');
    const fd = new FormData();
    fd.set('urlParams', `q=C1${SFX}`);
    const res = await svc.exportFilteredCustomersAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const bytes = Buffer.from(res.data.base64, 'base64');
    const job = await db.exportJob.findFirstOrThrow({
      where: { requestedById: ids.steward, kind: 'customers-filtered' },
      orderBy: { startedAt: 'desc' },
    });
    expect(job).toMatchObject({ filename: res.data.filename, fileSha256: sha(bytes), rowCount: 1, customerIds: [ids.c1] });
    expect(job.filters).toMatchObject({ urlParams: `q=C1${SFX}`, scope: { role: 'STEWARD' } });
  });

  it('an export record cannot be changed or removed outside the owner’s maintenance window', async () => {
    const job = await db.exportJob.findFirstOrThrow({ where: { requestedById: ids.steward } });
    await expect(db.exportJob.update({ where: { id: job.id }, data: { rowCount: 0 } })).rejects.toThrow(REFUSED);
    await expect(db.exportJob.delete({ where: { id: job.id } })).rejects.toThrow(REFUSED);
  });
});
