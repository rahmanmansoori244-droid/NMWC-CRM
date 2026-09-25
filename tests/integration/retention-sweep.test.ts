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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';

// The setup writes some thirty rows one round trip at a time, over a WAN link
// to the test database; the 10 s default hook timeout is not enough for that.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
  // Item 20: held-back rows — excluded long ago, excluded lately, not excluded.
  const heldExcludedOld = `${sfx}-qx-old`;
  const heldExcludedNew = `${sfx}-qx-new`;
  const heldOpen = `${sfx}-q-open`;
  // …and one excluded long ago in a batch that never left READY (a wrong file, excluded whole).
  const heldExcludedStaged = `${sfx}-qx-staged`;
  let stagedBatchId = '';
  // Post-merge review: a promoted batch a fix set back to READY, and one being
  // promoted right now — each with a PROMOTED, a REJECTED and a CLEAN row.
  let reopenedBatchId = '';
  let promotingBatchId = '';
  const reopened = (s: string) => `${sfx}-ro-${s}`;
  const promoting = (s: string) => `${sfx}-pg-${s}`;

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
          // Cells the Steward corrected in the app are the same customer data.
          corrections: { cells: { phone: PERSONAL.phone, cust_name: PERSONAL.legal_name } },
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`,
        daysAgo(age),
        id
      );
    }

    for (const [id, excludedDaysAgo, n] of [
      [heldExcludedOld, 120, 10],
      [heldExcludedNew, 3, 11],
      [heldOpen, null, 12],
    ] as const) {
      await prisma.importRow.create({
        data: {
          id,
          batchId,
          rowNumber: n,
          raw: PERSONAL,
          parsed: PERSONAL,
          issues: [{ field: 'phone', message: 'phone already exists in master on customer X' }],
          corrections: { cells: { phone: PERSONAL.phone } },
          state: 'QUARANTINED',
          ...(excludedDaysAgo === null
            ? {}
            : { excludedAt: daysAgo(excludedDaysAgo), excludedById: userId, excludedReason: 'stays out' }),
        },
      });
      await prisma.$executeRawUnsafe(`UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`, daysAgo(200), id);
    }

    await prisma.importRow.create({
      data: {
        id: heldExcludedStaged,
        batchId: stagedBatchId,
        rowNumber: 2,
        raw: PERSONAL,
        parsed: PERSONAL,
        issues: [{ field: 'cust_code', message: 'required' }],
        state: 'QUARANTINED',
        excludedAt: daysAgo(120),
        excludedById: userId,
        excludedReason: 'wrong file',
      },
    });
    await prisma.$executeRawUnsafe(`UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`, daysAgo(200), heldExcludedStaged);

    for (const [status, rowId] of [
      ['READY', reopened],
      ['PROMOTING', promoting],
    ] as const) {
      const b = await prisma.importBatch.create({
        data: { filename: `${sfx}-${status}.xlsx`, kind: 'CUSTOMER', status, uploadedById: userId },
      });
      if (status === 'READY') reopenedBatchId = b.id;
      else promotingBatchId = b.id;
      for (const [n, state] of [
        [1, 'PROMOTED'],
        [2, 'REJECTED'],
        [3, 'CLEAN'],
      ] as const) {
        await prisma.importRow.create({
          data: { id: rowId(state), batchId: b.id, rowNumber: n, raw: PERSONAL, parsed: PERSONAL, state },
        });
        await prisma.$executeRawUnsafe(`UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`, daysAgo(120), rowId(state));
      }
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
    const ours = [batchId, stagedBatchId, reopenedBatchId, promotingBatchId].filter(Boolean);
    await prisma.importRow.deleteMany({ where: { batchId: { in: ours } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: ours } } });
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

  it('item 20: a held-back row accepted as excluded 90+ days ago is cleared like a rejected one, corrections included', async () => {
    const gone = await prisma.importRow.findUniqueOrThrow({ where: { id: heldExcludedOld } });
    expect([gone.raw, gone.parsed, gone.issues, gone.corrections]).toEqual([{}, null, null, null]);
    // The exclusion itself is the record, and outlives the payload.
    expect(gone.excludedAt).not.toBeNull();
    expect(gone.state).toBe('QUARANTINED');
  });

  it('item 20: an excluded held-back row is cleared even in a batch that never left READY — nothing reads it', async () => {
    const gone = await prisma.importRow.findUniqueOrThrow({ where: { id: heldExcludedStaged } });
    expect([gone.raw, gone.parsed, gone.issues]).toEqual([{}, null, null]);
    // The staged batch's CLEAN row is still untouched (the P0 below).
  });

  it('item 20: a held-back row excluded lately, or not excluded at all, keeps its payload', async () => {
    for (const id of [heldExcludedNew, heldOpen]) {
      const kept = await prisma.importRow.findUniqueOrThrow({ where: { id } });
      expect(JSON.stringify(kept.raw)).toContain(PERSONAL.phone);
      expect(kept.corrections).not.toBeNull();
    }
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

  it('a promoted batch a fix set back to READY: its finished rows are cleared, the CLEAN row promote still needs is not', async () => {
    // Its rows used to be kept for ever once the fix was withdrawn and nothing
    // was left to promote (post-merge review).
    for (const state of ['PROMOTED', 'REJECTED'] as const) {
      const gone = await prisma.importRow.findUniqueOrThrow({ where: { id: reopened(state) } });
      expect([gone.raw, gone.parsed]).toEqual([{}, null]);
    }
    const kept = await prisma.importRow.findUniqueOrThrow({ where: { id: reopened('CLEAN') } });
    expect(JSON.stringify(kept.parsed)).toContain(PERSONAL.phone);
  });

  it('a batch being promoted right now is left alone', async () => {
    for (const state of ['PROMOTED', 'REJECTED', 'CLEAN'] as const) {
      const kept = await prisma.importRow.findUniqueOrThrow({ where: { id: promoting(state) } });
      expect(JSON.stringify(kept.raw)).toContain(PERSONAL.phone);
    }
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
