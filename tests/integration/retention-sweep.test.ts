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
import { Prisma } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeJobRunDays } from '../support/audit';

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
  // Code review 2026-11-10, second round: batches that can never load their
  // rows — discarded, or staged and expired without being loaded — and two that
  // keep theirs (a discarded batch inside the 90 days; an old batch a load touched).
  const dead = (key: string, state: string) => `${sfx}-dead-${key}-${state}`;
  const deadBatches: Record<string, string> = {};

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const PERSONAL = {
    legal_name: 'Al Baraq Trading',
    phone: '96891234567',
    contact_person: 'Ali Said',
    address: 'Way 4021, Al Khuwair',
  };

  beforeAll(async () => {
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
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

    for (const [key, status, leaseUntil, states, age] of [
      ['dis', 'DISCARDED', null, ['CLEAN', 'QUARANTINED', 'PROMOTED'], 120],
      ['exp', 'READY', null, ['CLEAN', 'QUARANTINED'], 120],
      ['int', 'PROMOTING', daysAgo(100), ['CLEAN'], 120],
      ['ldd', 'READY', null, ['PROMOTED', 'CLEAN'], 120],
      ['new', 'DISCARDED', null, ['CLEAN'], 3],
    ] as const) {
      const b = await prisma.importBatch.create({
        data: {
          filename: `${sfx}-dead-${key}.xlsx`,
          kind: 'CUSTOMER',
          status,
          uploadedById: userId,
          uploadedAt: daysAgo(age),
          ...(leaseUntil ? { promoteLeaseBy: 'gone:tab', promoteLeaseUntil: leaseUntil } : {}),
        },
      });
      deadBatches[key] = b.id;
      for (const [n, state] of states.entries()) {
        await prisma.importRow.create({
          data: {
            id: dead(key, state),
            batchId: b.id,
            rowNumber: n + 2,
            raw: PERSONAL,
            parsed: PERSONAL,
            issues: [{ field: 'phone', message: 'needs review' }],
            corrections: { cells: { phone: PERSONAL.phone } },
            state,
          },
        });
        await prisma.$executeRawUnsafe(`UPDATE "ImportRow" SET "createdAt" = $1 WHERE "id" = $2`, daysAgo(age), dead(key, state));
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

    // Item 9: scheduled-run history past its 90 days, and a run inside them.
    await prisma.cronRun.create({ data: { id: `${sfx}-run-old`, key: `${sfx}-job`, at: daysAgo(91), ok: true, durationMs: 1 } });
    await prisma.cronRun.create({ data: { id: `${sfx}-run-new`, key: `${sfx}-job`, at: daysAgo(89), ok: true, durationMs: 1 } });
  });

  afterAll(async () => {
    if (!prisma) return;
    const ours = [batchId, stagedBatchId, reopenedBatchId, promotingBatchId, ...Object.values(deadBatches)].filter(Boolean);
    await prisma.importRow.deleteMany({ where: { batchId: { in: ours } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: ours } } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: `login:user:${sfx}` } } });
    await prisma.cronRun.deleteMany({ where: { key: `${sfx}-job` } });
    // Gap 21: the days the sweep wrote for this suite's job (append-only: owner window).
    await purgeJobRunDays(prisma, { where: { key: `${sfx}-job` } });
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

  // Code review 2026-11-10, second round: the owner accepted 90 days for upload
  // details. A discarded batch, and a staged batch that expired without being
  // loaded, can never load their rows; they used to keep the customer's details
  // for ever (only finished rows were emptied).
  it('every row of a discarded batch, and of a staged batch that expired unloaded, is emptied after 90 days', async () => {
    for (const [key, states] of [
      ['dis', ['CLEAN', 'QUARANTINED', 'PROMOTED']],
      ['exp', ['CLEAN', 'QUARANTINED']],
      ['int', ['CLEAN']],
    ] as const) {
      for (const state of states) {
        const gone = await prisma.importRow.findUniqueOrThrow({ where: { id: dead(key, state) } });
        expect([gone.raw, gone.parsed, gone.issues, gone.corrections], `${key} ${state}`).toEqual([{}, null, null, null]);
        // The row and its outcome are kept.
        expect(gone.state).toBe(state);
      }
    }
    // The same purge summary as any finished row: by batch and state, no personal value.
    const summaries = await prisma.purgeSummary.findMany({ where: { rule: 'import-payload-90d', tableName: 'ImportRow' } });
    const byBatch = (id: string) => {
      const n: Record<string, number> = {};
      for (const s of summaries) {
        const states = (s.detail as { byBatch?: Record<string, Record<string, number>> } | null)?.byBatch?.[id] ?? {};
        for (const [k, v] of Object.entries(states)) n[k] = (n[k] ?? 0) + v;
      }
      return n;
    };
    expect(byBatch(deadBatches.dis!)).toEqual({ CLEAN: 1, QUARANTINED: 1, PROMOTED: 1 });
    expect(byBatch(deadBatches.exp!)).toEqual({ CLEAN: 1, QUARANTINED: 1 });
    expect(byBatch(deadBatches.int!)).toEqual({ CLEAN: 1 });
    for (const s of summaries) expect(JSON.stringify(s.detail)).not.toContain(PERSONAL.phone);
  });

  it('kept: a discarded batch inside the 90 days, and the CLEAN row of an old batch a load has touched', async () => {
    const fresh = await prisma.importRow.findUniqueOrThrow({ where: { id: dead('new', 'CLEAN') } });
    expect(JSON.stringify(fresh.parsed)).toContain(PERSONAL.phone);
    // A batch a promote has touched may hold fixed rows still to load: its CLEAN row keeps its payload.
    const waiting = await prisma.importRow.findUniqueOrThrow({ where: { id: dead('ldd', 'CLEAN') } });
    expect(JSON.stringify(waiting.parsed)).toContain(PERSONAL.phone);
    const loaded = await prisma.importRow.findUniqueOrThrow({ where: { id: dead('ldd', 'PROMOTED') } });
    expect([loaded.raw, loaded.parsed]).toEqual([{}, null]);
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

  it('item 9: prunes scheduled-run history past 90 days and keeps the rest', async () => {
    const left = await prisma.cronRun.findMany({ where: { key: `${sfx}-job` }, select: { id: true } });
    expect(left.map((r) => r.id)).toEqual([`${sfx}-run-new`]);
  });

  it('gap 21: both days are kept as JobRunDay rows, the pruned one included', async () => {
    const days = await prisma.jobRunDay.findMany({ where: { key: `${sfx}-job` }, orderBy: { day: 'asc' } });
    expect(days).toHaveLength(2);
    expect(days.map((d) => [d.runs, d.failures, d.maxDurationMs])).toEqual([
      [1, 0, 1],
      [1, 0, 1],
    ]);
  });

  it('deletes long-unread notifications and leaves read ones to the SLA sweep', async () => {
    const left = await prisma.notification.findMany({ where: { userId }, select: { title: true, readAt: true } });
    expect(left.map((n) => n.title)).toEqual([`${sfx} new`]);
    expect(left[0]!.readAt).not.toBeNull();
  });
});

/**
 * Code review 2026-11-10, second round (adversarial review): the "never loaded"
 * test of a dead batch sat inside the OR of the row predicate, where PostgreSQL
 * cannot make a correlated NOT EXISTS an anti-join. It ran once per candidate
 * row, and for an abandoned READY master (uploaded, re-uploaded corrected, never
 * discarded) each run read every row of the batch — some 2 x 2,000 x N row
 * visits per 2,000-row statement, enough to run past the transaction timeout
 * every night and sweep nothing. The dead batches are now worked out once per
 * statement.
 *
 * Measured on a throwaway PostgreSQL 17 (2026-11-11): while the planner can hash
 * that subquery it reads ImportRow once per statement, but it hashes only while
 * the rows a load touched fit in work_mem. Past that (many promoted rows; forced
 * here with the smallest work_mem) the old statement ran a correlated SubPlan per
 * row: over 120 s for 2,000 rows of a 6,000-row never-loaded master, against
 * some 0.3 s now. Here: such a master next to a batch with thousands of loaded
 * rows, one statement under the route's own default transaction (20 s, lib/db.ts) with the
 * smallest work_mem, the rows the "never loaded" test reads (from the executed
 * plan), and the sweep itself, inside its budget.
 */
describe.skipIf(!ENABLED)('second round: a large never-loaded batch is swept inside the budget', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let GET: (req: Request) => Promise<Response>;
  let userId = '';
  let abandonedId = '';
  let loadedId = '';
  const ROWS = 6000;
  const WAITING = 1000;
  const ssfx = `${sfx}big`;

  beforeAll(async () => {
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    process.env.CRON_SECRET = SECRET;
    ({ prisma } = await import('@/lib/db'));
    ({ GET } = (await import('@/app/api/cron/retention-sweep/route')) as unknown as {
      GET: (req: Request) => Promise<Response>;
    });
    const u = await prisma.user.create({
      data: { username: `${ssfx}.op`, fullName: 'Retention Operator Big', role: 'STEWARD', passwordHash: 'x' },
    });
    userId = u.id;
    const old = new Date(Date.now() - 120 * 86_400_000);
    // The abandoned master: READY, uploaded 120 days ago, no row ever loaded.
    // And a batch of the same size a load stopped part-way through: thousands of
    // PROMOTED rows (what keeps the planner from hashing the "loaded" test) and
    // CLEAN rows still to load, which are kept.
    for (const [key, loadedUpTo] of [
      ['abandoned', 0],
      ['loaded', ROWS - WAITING],
    ] as const) {
      const b = await prisma.importBatch.create({
        data: { filename: `${ssfx}-${key}.xlsx`, kind: 'CUSTOMER', status: 'READY', uploadedById: userId, uploadedAt: old },
      });
      if (key === 'abandoned') abandonedId = b.id;
      else loadedId = b.id;
      // One set-based insert: thousands of rows one round trip at a time would be slow.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ImportRow" ("id", "batchId", "rowNumber", "raw", "parsed", "issues", "state", "createdAt")
         SELECT $1 || '-' || g, $2, g,
                jsonb_build_object('legal_name', 'Synthetic Trading ' || g, 'phone', '9689' || lpad(g::text, 7, '0')),
                jsonb_build_object('legal_name', 'Synthetic Trading ' || g, 'phone', '9689' || lpad(g::text, 7, '0'),
                                   'note', repeat('x', 400)),
                jsonb_build_array(jsonb_build_object('field', 'phone', 'message', 'needs review')),
                (CASE WHEN g <= $4 THEN 'PROMOTED' ELSE 'CLEAN' END)::"ImportRowState", $5
           FROM generate_series(1, $3::int) g`,
        `${ssfx}-${key}`,
        b.id,
        ROWS,
        loadedUpTo,
        old
      );
    }
    await prisma.$executeRawUnsafe(`ANALYZE "ImportRow"`);
    await prisma.$executeRawUnsafe(`ANALYZE "ImportBatch"`);
  });

  afterAll(async () => {
    if (!prisma) return;
    const ours = [abandonedId, loadedId].filter(Boolean);
    await prisma.importRow.deleteMany({ where: { batchId: { in: ours } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: ours } } });
    await purgeAuditLog(prisma, { where: { actorId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('the "never loaded" test reads each batch once per statement, not once per row, inside the default transaction timeout', async () => {
    const { importPayloadPurgeSql, purgeRunId } = await import('@/lib/purge-summary');
    const { withChangeContext, src } = await import('@/lib/change-context');
    const now = new Date();
    const stmt = importPayloadPurgeSql(now, 2000, { runId: purgeRunId('retention-sweep-explain', now) });
    let plan: unknown;
    const ROLLBACK = new Error('rollback');
    // No transaction options: the route's own default (20 s, lib/db.ts transactionOptions), as it runs each statement.
    await withChangeContext(prisma, { actorId: null, source: src.cron('retention-sweep') }, async (tx) => {
      // The smallest work_mem: the loaded rows no longer fit a hash, as on a large table.
      await tx.$executeRawUnsafe(`SET LOCAL work_mem = '64kB'`);
      const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${stmt}`);
      plan = rows[0]!['QUERY PLAN'];
      throw ROLLBACK; // EXPLAIN ANALYZE runs the statement: undo it.
    }).catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
    // Every ImportRow row the "never loaded" test (alias lr) visited, over all its loops.
    let visited = 0;
    const walk = (n: Record<string, unknown>) => {
      if (n['Alias'] === 'lr') {
        const loops = Number(n['Actual Loops'] ?? 1);
        visited += (Number(n['Actual Rows'] ?? 0) + Number(n['Rows Removed by Filter'] ?? 0) + Number(n['Rows Removed by Index Recheck'] ?? 0)) * loops;
      }
      for (const c of (n['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk((plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
    // Once per batch: the two batches here (plus the few small ones the database
    // may hold). Per candidate row it was in the tens of millions.
    expect(plan).toBeDefined();
    expect(visited).toBeLessThan(4 * ROWS);
  });

  it('the sweep empties the abandoned master, keeps the CLEAN rows of the batch a load touched, and stays inside its budget', async () => {
    const started = Date.now();
    const res = await GET(
      new Request('https://example.test/api/cron/retention-sweep', { headers: { authorization: `Bearer ${SECRET}` } })
    );
    const took = Date.now() - started;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors: number; swept: Record<string, number> };
    expect(body.errors).toBe(0);
    expect(body.swept.importRowPayloads).toBeGreaterThanOrEqual(2 * ROWS - WAITING);
    expect(body.swept.importRowPayloadsBehind).toBeUndefined();
    expect(took).toBeLessThan(30_000);
    const left = await prisma.importRow.count({ where: { batchId: abandonedId, NOT: { parsed: { equals: Prisma.DbNull } } } });
    expect(left).toBe(0);
    const kept = await prisma.importRow.count({ where: { batchId: loadedId, state: 'CLEAN', NOT: { parsed: { equals: Prisma.DbNull } } } });
    expect(kept).toBe(WAITING);
  });
});
