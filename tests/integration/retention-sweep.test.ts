/**
 * B6: the retention sweep must actually clear what it claims to clear.
 *
 * Written because the first version did not. It used
 * `data: { raw: {}, parsed: undefined, issues: undefined }`, and Prisma reads
 * `undefined` as "leave this column alone" — so only `raw` was emptied while
 * `parsed` kept the customer's name, address, phone, contact person and CR
 * number, and the `raw = {}` progress marker then excluded the row from every
 * later sweep. Type-checking cannot catch that; only a row in a real database
 * can. Hence an integration test rather than a unit test.
 *
 *   RUN_RETENTION_SWEEP=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/retention-sweep.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { purgeAuditLog } from '../support/audit';

const ENABLED = process.env.RUN_RETENTION_SWEEP === '1' && !!process.env.DATABASE_URL;
const sfx = `ret${Date.now().toString(36)}`;
const SECRET = 'retention-sweep-test-secret-value';

describe.skipIf(!ENABLED)('B6: the retention sweep clears the payloads it says it clears', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let GET: (req: Request) => Promise<Response>;
  let userId = '';
  let batchId = '';
  const oldRowId = `${sfx}-old`;
  const freshRowId = `${sfx}-fresh`;
  const stagedRowId = `${sfx}-staged`;
  let stagedBatchId = '';

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const PERSONAL = {
    legal_name: 'Al Baraq Trading',
    phone: '96891234567',
    contact_person: 'Ali Said',
    address: 'Way 4021, Al Khuwair',
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    process.env.CRON_SECRET = SECRET;
    ({ prisma } = await import('@/lib/db'));
    ({ GET } = (await import('@/app/api/cron/retention-sweep/route')) as unknown as {
      GET: (req: Request) => Promise<Response>;
    });

    const u = await prisma.user.create({
      data: { username: `${sfx}.op`, fullName: 'Retention Operator', role: 'STEWARD', passwordHash: 'x' },
    });
    userId = u.id;
    const batch = await prisma.importBatch.create({
      data: { filename: `${sfx}.xlsx`, kind: 'CUSTOMER', status: 'PROMOTED', uploadedById: userId },
    });
    batchId = batch.id;
    // A batch that was uploaded long ago and never promoted. Its rows are old
    // enough for the retention cutoff but the work is not finished.
    const staged = await prisma.importBatch.create({
      data: { filename: `${sfx}-staged.xlsx`, kind: 'CUSTOMER', status: 'READY', uploadedById: userId },
    });
    stagedBatchId = staged.id;
    await prisma.importRow.create({
      data: {
        id: stagedRowId,
        batchId: stagedBatchId,
        rowNumber: 1,
        raw: PERSONAL,
        parsed: PERSONAL,
        issues: [{ field: 'phone', message: 'needs review' }],
        state: 'CLEAN',
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`,
      daysAgo(200),
      stagedRowId
    );

    // One row past the retention horizon, one inside it.
    for (const [id, age] of [
      [oldRowId, 120],
      [freshRowId, 3],
    ] as const) {
      await prisma.importRow.create({
        data: {
          id,
          batchId,
          rowNumber: id === oldRowId ? 1 : 2,
          raw: PERSONAL,
          parsed: PERSONAL,
          issues: [{ field: 'phone', message: `duplicate of ${PERSONAL.phone}` }],
          state: 'PROMOTED',
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`,
        daysAgo(age),
        id
      );
    }

    // A spent rate-limit bucket keyed on a username, and a fresh one.
    await prisma.rateLimit.create({ data: { key: `login:user:${sfx}.old`, tokens: 4 } });
    await prisma.rateLimit.create({ data: { key: `login:user:${sfx}.new`, tokens: 4 } });
    await prisma.$executeRawUnsafe(
      `UPDATE "RateLimit" SET "updatedAt" = $1 WHERE "key" = $2`,
      daysAgo(5),
      `login:user:${sfx}.old`
    );

    // An unread notification past the horizon, and a read one inside it.
    const n1 = await prisma.notification.create({
      data: { userId, kind: 'SLA_BREACH', title: `${sfx} old`, body: 'Al Baraq Trading needs review' },
    });
    const n2 = await prisma.notification.create({
      data: { userId, kind: 'SLA_BREACH', title: `${sfx} new`, body: 'recent' },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Notification" SET "createdAt" = $1 WHERE "id" = $2`,
      daysAgo(400),
      n1.id
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "Notification" SET "createdAt" = $1 WHERE "id" = $2`,
      daysAgo(400),
      n2.id
    );
    await prisma.notification.update({ where: { id: n2.id }, data: { readAt: new Date() } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.importRow.deleteMany({ where: { batchId: { in: [batchId, stagedBatchId] } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: [batchId, stagedBatchId] } } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: `login:user:${sfx}` } } });
    await purgeAuditLog(prisma, { where: { actorId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const run = () =>
    GET(
      new Request('https://example.test/api/cron/retention-sweep', {
        headers: { authorization: `Bearer ${SECRET}` },
      })
    );

  it('refuses without the cron bearer', async () => {
    const res = await GET(new Request('https://example.test/api/cron/retention-sweep'));
    expect(res.status).toBe(401);
  });

  it('empties every personal-data column on an aged import row, not just raw', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors: number; swept: Record<string, number> };
    expect(body.errors).toBe(0);
    expect(body.swept.importRowPayloads).toBeGreaterThanOrEqual(1);

    const old = await prisma.importRow.findUniqueOrThrow({ where: { id: oldRowId } });
    expect(old.raw).toEqual({});
    // The bug this test exists for: `parsed` and `issues` used to survive.
    expect(old.parsed).toBeNull();
    expect(old.issues).toBeNull();
    // The row itself and its outcome are kept — we drop the payload, not the record.
    expect(old.state).toBe('PROMOTED');
    expect(old.rowNumber).toBe(1);
    // Nothing of the customer is left anywhere in the row.
    expect(JSON.stringify(old)).not.toContain(PERSONAL.phone);
    expect(JSON.stringify(old)).not.toContain(PERSONAL.contact_person);
  });

  it('leaves rows inside the retention window untouched', async () => {
    const fresh = await prisma.importRow.findUniqueOrThrow({ where: { id: freshRowId } });
    expect(fresh.parsed).not.toBeNull();
    expect(JSON.stringify(fresh.raw)).toContain(PERSONAL.phone);
  });

  it('does NOT disarm a batch that is still staged, however old its rows are', async () => {
    // The P0 this guard exists for: services/imports.ts promotes a row by
    // reading row.parsed. Clearing it on a row whose batch has not been
    // promoted or failed would leave the batch permanently unpromotable, and
    // no rollback can bring the payload back.
    const staged = await prisma.importRow.findUniqueOrThrow({ where: { id: stagedRowId } });
    expect(staged.parsed).not.toBeNull();
    expect(JSON.stringify(staged.raw)).toContain(PERSONAL.phone);
    expect(staged.issues).not.toBeNull();
  });

  it('is idempotent and makes progress — a second run re-clears nothing', async () => {
    const res = await run();
    const body = (await res.json()) as { swept: Record<string, number> };
    expect(body.swept.importRowPayloads).toBe(0);
  });

  it('deletes spent rate-limit buckets and keeps live ones', async () => {
    expect(await prisma.rateLimit.findUnique({ where: { key: `login:user:${sfx}.old` } })).toBeNull();
    expect(await prisma.rateLimit.findUnique({ where: { key: `login:user:${sfx}.new` } })).not.toBeNull();
  });

  it('deletes long-unread notifications and leaves read ones to the SLA sweep', async () => {
    const left = await prisma.notification.findMany({ where: { userId }, select: { title: true, readAt: true } });
    expect(left.map((n) => n.title)).toEqual([`${sfx} new`]);
    expect(left[0]!.readAt).not.toBeNull();
  });
});
