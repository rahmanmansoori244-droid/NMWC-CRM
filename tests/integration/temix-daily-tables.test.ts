// @vitest-environment node
/**
 * The daily Temix import, stage 1, on Postgres: migration
 * 20261114100000_temix_daily_tables does what lib/temix-daily-tables.ts says.
 *
 *  - The ledgers (TemixChange, TemixChangeReview, TemixNoticeSeen,
 *    TemixRouteMap) refuse UPDATE, DELETE and TRUNCATE outside the owner's
 *    maintenance window, as AuditLog and the history do; the runtime role
 *    (when NMWC_APP_URL is set) holds no UPDATE, DELETE or TRUNCATE on them.
 *  - A ledger row is stamped with its writer's source and transaction, carries
 *    its file's load day, and names only a row of its own file.
 *  - A file: never deleted, never dated in the future, its identity fixed, its
 *    end states final; the same bytes once per load day (a discarded file frees
 *    its day); one file mid-load at a time.
 *  - The route map: added and retired by new rows, one live entry per code.
 *  - The CHECKs refuse what the list does not name (a kind, a hold reason that
 *    is not a code word, STATUS_DIFFERS as a "listed once" kind).
 *  - The retention rule temix-daily-payload-90d empties raw and parsed of a
 *    LOADED or DISCARDED file's rows past the cut-off, with its summary.
 *
 * Synthetic data only (buildWorld's zz accounts and route); everything it makes
 * is removed in the owner's maintenance window afterwards.
 *
 *   RUN_TEMIX_DAILY=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/temix-daily-tables.test.ts
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { src, withChangeContext } from '@/lib/change-context';
import { TEMIX_DAILY_LEDGERS } from '@/lib/temix-daily-tables';
import { runPurge, temixDailyPayloadPurgeSql } from '@/lib/purge-summary';
import { withAuditMaintenance } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_TEMIX_DAILY === '1' && !!process.env.DATABASE_URL;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** The Oman calendar day of `d` (YYYY-MM-DD). */
const omanDay = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const DAY_MS = 86_400_000;

describe.skipIf(!ENABLED)('the daily Temix tables on Postgres', () => {
  let prisma: PrismaClient;
  let w: World;
  const fileIds: string[] = [];
  const cause = { actorId: null, source: src.test('temix-daily-tables') };
  const today = omanDay(new Date());
  const yesterday = omanDay(new Date(Date.now() - DAY_MS));

  /** The Postgres error message of a refused statement ('' when it succeeded); Prisma's escaped quotes undone. */
  async function refusal(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return '';
    } catch (e) {
      return (e as Error).message.replace(/\\+"/g, '"');
    }
  }

  async function newFile(over: Partial<Prisma.TemixDailyFileUncheckedCreateInput> = {}) {
    const f = await prisma.temixDailyFile.create({
      data: {
        filename: `${w.sfx}-daily.csv`,
        loadDay: asDate(today),
        uploadedById: w.steward,
        fileSha256: sha(`${w.sfx}-${fileIds.length}-${Math.random()}`),
        fileBytes: 1234,
        headings: ['cust_code', 'branch_code', 'route'],
        ...over,
      },
    });
    fileIds.push(f.id);
    return f;
  }

  beforeAll(async () => {
    assertNotProductionEnv();
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    w = await buildWorld(prisma, 'temixdaily');
  });

  afterAll(async () => {
    if (!prisma) return;
    await withAuditMaintenance(prisma, async (tx) => {
      const files = { in: fileIds };
      await tx.temixChangeReview.deleteMany({ where: { change: { fileId: files } } });
      await tx.temixChange.deleteMany({ where: { fileId: files } });
      await tx.temixNoticeSeen.deleteMany({ where: { firstFileId: files } });
      // A RETIRE row points at its ADD (RESTRICT): retirements first.
      await tx.temixRouteMap.deleteMany({ where: { byId: w.steward, action: 'RETIRE' } });
      await tx.temixRouteMap.deleteMany({ where: { byId: w.steward } });
      await tx.temixDailyRow.deleteMany({ where: { fileId: files } });
      await tx.temixDailyFile.updateMany({ where: { id: files }, data: { sameBytesAsFileId: null } });
      await tx.temixDailyFile.deleteMany({ where: { id: files } });
    });
    if (w) await tearDownWorld(prisma, w);
    await prisma.$disconnect();
  });

  describe('a file', () => {
    it('is never dated in the future (the Oman day of the database clock)', async () => {
      const tomorrow = omanDay(new Date(Date.now() + DAY_MS));
      expect(await refusal(() => newFile({ loadDay: asDate(tomorrow) }))).toMatch(/load day .* is in the future/);
      const f = await newFile({ loadDay: asDate(yesterday) });
      expect(f.loadDay.toISOString().slice(0, 10)).toBe(yesterday);
    });

    it('keeps its name, hash, size, load day and uploader', async () => {
      const f = await newFile();
      for (const data of [
        { filename: 'other.csv' },
        { fileSha256: sha('other') },
        { fileBytes: 1 },
        { loadDay: asDate(yesterday) },
        { uploadedById: w.manager },
        { uploadedAt: new Date('2026-01-01T00:00:00Z') },
      ]) {
        expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: f.id }, data })), JSON.stringify(Object.keys(data))).toMatch(
          /name, hash, size, load day and uploader never change/
        );
      }
      // Its state and counters move.
      await prisma.temixDailyFile.update({ where: { id: f.id }, data: { state: 'CHECKED', totalRows: 3 } });
    });

    it('LOADED and DISCARDED are final; a discard needs who and why', async () => {
      const a = await newFile();
      expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'LOADED' } }))).toMatch(
        /TemixDailyFile_loaded_check/
      );
      await prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'LOADED', loadedAt: new Date() } });
      expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'APPLYING' } }))).toMatch(
        /a LOADED file stays LOADED/
      );
      const b = await newFile();
      expect(
        await refusal(() =>
          prisma.temixDailyFile.update({ where: { id: b.id }, data: { state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: '  ' } })
        )
      ).toMatch(/TemixDailyFile_discard_check/);
      await prisma.temixDailyFile.update({
        where: { id: b.id },
        data: { state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: 'wrong file' },
      });
      expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: b.id }, data: { state: 'STAGED' } }))).toMatch(
        /a DISCARDED file stays DISCARDED/
      );
    });

    it('the same bytes once per load day; a discarded file frees its day; another day may stage them', async () => {
      const bytes = sha(`${w.sfx}-same`);
      const first = await newFile({ fileSha256: bytes });
      expect(await refusal(() => newFile({ fileSha256: bytes }))).toMatch(/Unique constraint|TemixDailyFile_sha_day_live_unique/);
      const other = await newFile({ fileSha256: bytes, loadDay: asDate(yesterday) });
      expect(other.id).not.toBe(first.id);
      await prisma.temixDailyFile.update({
        where: { id: first.id },
        data: { state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: 'staged twice' },
      });
      const again = await newFile({ fileSha256: bytes, sameBytesAsFileId: other.id });
      expect(again.sameBytesAsFileId).toBe(other.id);
    });

    it('one file mid-load at a time', async () => {
      const a = await newFile();
      const b = await newFile();
      await prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'APPLYING' } });
      expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: b.id }, data: { state: 'FINALIZING' } }))).toMatch(
        /Unique constraint|TemixDailyFile_one_in_flight/
      );
      await prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'LOADED', loadedAt: new Date() } });
      await prisma.temixDailyFile.update({ where: { id: b.id }, data: { state: 'APPLYING' } });
      await prisma.temixDailyFile.update({ where: { id: b.id }, data: { state: 'LOADED', loadedAt: new Date() } });
    });

    it('is never deleted or truncated outside the owner’s window', async () => {
      const f = await newFile();
      expect(await refusal(() => prisma.temixDailyFile.delete({ where: { id: f.id } }))).toMatch(/B4: DELETE on "TemixDailyFile" is forbidden/);
      expect(await refusal(() => prisma.$executeRawUnsafe('TRUNCATE "TemixDailyFile" CASCADE'))).toMatch(
        /B4: TRUNCATE on "Temix[A-Za-z]+" is forbidden/
      );
      expect(await prisma.temixDailyFile.count({ where: { id: f.id } })).toBe(1);
    });
  });

  describe('the ledger', () => {
    let file: Awaited<ReturnType<typeof newFile>>;
    let rowId = '';
    let changeId = 0n;

    beforeAll(async () => {
      file = await newFile();
      const row = await prisma.temixDailyRow.create({
        data: { fileId: file.id, rowNumber: 1, raw: { cust_code: 'zz1' }, custCodeKey: 'ZZ1', holdReasons: ['ROUTE_NOT_MATCHED'] },
      });
      rowId = row.id;
    });

    it('is stamped with its writer’s source and transaction', async () => {
      const { c, tx } = await withChangeContext(prisma, cause, async (t) => {
        const c = await t.temixChange.create({
          data: { fileId: file.id, rowId, loadDay: file.loadDay, kind: 'ROUTE_MOVE', applied: true, branchId: w.branch, field: 'routeId', fromValue: 'R1', toValue: 'R2' },
        });
        const [{ tx }] = await t.$queryRaw<Array<{ tx: bigint }>>`SELECT txid_current() AS tx`;
        return { c, tx };
      });
      changeId = c.id;
      expect(c.source).toBe(cause.source);
      expect(c.txId).toBe(tx);
    });

    it('carries its file’s load day and names only a row of its own file', async () => {
      expect(
        await refusal(() =>
          prisma.temixChange.create({ data: { fileId: file.id, loadDay: asDate(yesterday), kind: 'MISSING_FROM_FILE', applied: false } })
        )
      ).toMatch(/is not the load day of file/);
      const other = await newFile();
      expect(
        await refusal(() => prisma.temixChange.create({ data: { fileId: other.id, rowId, loadDay: other.loadDay, kind: 'NAME_DIFFERS', applied: false } }))
      ).toMatch(/is not a row of file/);
    });

    it('refuses a kind the list does not name, and free text in its value columns', async () => {
      const base = { fileId: file.id, loadDay: file.loadDay, applied: false };
      expect(await refusal(() => prisma.temixChange.create({ data: { ...base, kind: 'SOMETHING_ELSE' } }))).toMatch(/TemixChange_kind_check/);
      expect(await refusal(() => prisma.temixChange.create({ data: { ...base, kind: 'NAME_DIFFERS', field: 'legal name' } }))).toMatch(
        /TemixChange_values_check/
      );
      expect(await refusal(() => prisma.temixChange.create({ data: { ...base, kind: 'NAME_DIFFERS', toValue: 'x'.repeat(101) } }))).toMatch(
        /TemixChange_values_check/
      );
    });

    it('a review mark is a new row, a code word, stamped', async () => {
      const r = await withChangeContext(prisma, cause, (t) => t.temixChangeReview.create({ data: { changeId, reviewedById: w.steward, note: 'HANDLED' } }));
      expect(r.source).toBe(cause.source);
      expect(await refusal(() => prisma.temixChangeReview.create({ data: { changeId, reviewedById: w.steward, note: 'called the shop owner' } }))).toMatch(
        /TemixChangeReview_note_check/
      );
    });

    it('"listed once": a hash per customer and kind, NAME_DIFFERS only', async () => {
      const h = sha(`${w.sfx}-name`);
      await prisma.temixNoticeSeen.create({ data: { customerId: w.customer, kind: 'NAME_DIFFERS', valueHash: h, firstFileId: file.id } });
      expect(
        await refusal(() => prisma.temixNoticeSeen.create({ data: { customerId: w.customer, kind: 'NAME_DIFFERS', valueHash: h, firstFileId: file.id } }))
      ).toMatch(/Unique constraint/);
      expect(
        await refusal(() => prisma.temixNoticeSeen.create({ data: { customerId: w.customer, kind: 'STATUS_DIFFERS', valueHash: h, firstFileId: file.id } }))
      ).toMatch(/TemixNoticeSeen_kind_check/);
    });

    it('a staged row holds codes only outside its payload', async () => {
      expect(
        await refusal(() => prisma.temixDailyRow.create({ data: { fileId: file.id, rowNumber: 2, raw: {}, holdReasons: ['route not matched'] } }))
      ).toMatch(/TemixDailyRow_hold_reasons_check/);
      expect(await refusal(() => prisma.temixDailyRow.create({ data: { fileId: file.id, rowNumber: 2, raw: {}, custCodeKey: ' zz1' } }))).toMatch(
        /TemixDailyRow_keys_check/
      );
      // The staging row is not a ledger: its outcome moves and its payload can be emptied.
      await prisma.temixDailyRow.update({ where: { id: rowId }, data: { outcome: 'HELD', raw: {}, parsed: Prisma.DbNull } });
    });

    it.each([...TEMIX_DAILY_LEDGERS])('%s: UPDATE, DELETE and TRUNCATE are refused outside the owner’s window', async (table) => {
      // One row of each ledger exists by now (the route map gets its own below).
      if (table === 'TemixRouteMap') {
        await prisma.temixRouteMap.create({ data: { temixRouteCode: `${w.sfx.toUpperCase()}-L`, action: 'ADD', routeId: w.route, reason: 'ledger probe', byId: w.steward } });
      }
      const set = table === 'TemixNoticeSeen' ? '"kind" = "kind"' : '"source" = "source"';
      expect(await refusal(() => prisma.$executeRawUnsafe(`UPDATE "${table}" SET ${set}`))).toMatch(new RegExp(`B4: UPDATE on "${table}" is forbidden`));
      expect(await refusal(() => prisma.$executeRawUnsafe(`DELETE FROM "${table}"`))).toMatch(new RegExp(`B4: DELETE on "${table}" is forbidden`));
      // CASCADE takes the tables that point at it too; the first guard reached refuses.
      expect(await refusal(() => prisma.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`))).toMatch(/B4: TRUNCATE on "Temix[A-Za-z]+" is forbidden/);
      // Nothing was removed (the runtime role's refusals are the next test).
      const n = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}"`);
      expect(Number(n[0]!.n)).toBeGreaterThan(0);
    });

    it('the runtime role may insert and read the ledgers, never change them', async () => {
      const appUrl = process.env.NMWC_APP_URL;
      if (!appUrl) return; // set up by app-role.ts in CI and in the local run
      if (pointsAtProduction(appUrl)) throw new Error('ABORT: production');
      const app = new PrismaClient({ datasourceUrl: appUrl });
      try {
        const privs = await app.$queryRaw<Array<{ t: string; p: string }>>`
          SELECT l.t, q.p FROM unnest(${[...TEMIX_DAILY_LEDGERS]}::text[]) AS l(t)
          CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS q(p)
          WHERE has_table_privilege(current_user, format('public.%I', l.t), q.p)`;
        expect(privs).toEqual([]);
        const seqs = await app.$queryRaw<Array<{ s: string }>>`
          SELECT s FROM unnest(${TEMIX_DAILY_LEDGERS.map((t) => `${t}_id_seq`)}::text[]) AS s
          WHERE has_sequence_privilege(current_user, format('public.%I', s), 'UPDATE')`;
        expect(seqs).toEqual([]);
        const files = await app.$queryRaw<Array<{ p: string }>>`
          SELECT p FROM unnest(ARRAY['DELETE', 'TRUNCATE']) AS p
          WHERE has_table_privilege(current_user, 'public."TemixDailyFile"', p) OR has_table_privilege(current_user, 'public."TemixDailyRow"', p)`;
        expect(files).toEqual([]);
        // It inserts, and the maintenance window does not open for it.
        const c = await app.temixChange.create({ data: { fileId: file.id, loadDay: file.loadDay, kind: 'MISSING_FROM_FILE', applied: false } });
        const msg = await refusal(() =>
          app.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
            await tx.$executeRawUnsafe(`UPDATE "TemixChange" SET "detailCode" = 'X' WHERE "id" = ${c.id}`);
          })
        );
        expect(msg).toMatch(/permission denied|B4: UPDATE on "TemixChange" is forbidden/);
      } finally {
        await app.$disconnect();
      }
    });
  });

  describe('the retention rule temix-daily-payload-90d', () => {
    // Rows dated long before the application existed, purged with a `now` whose
    // cut-off is 1 January 2025, so the statement can only ever reach these.
    const CUTOFF = new Date('2025-01-01T00:00:00.000Z');
    const OLD = new Date('2024-12-01T08:00:00.000Z');
    const NEWER = new Date('2025-01-15T08:00:00.000Z');
    const now = new Date(CUTOFF.getTime() + 90 * DAY_MS);
    const runId = `test-temix-daily:${new Date().toISOString()}`;

    afterAll(async () => {
      if (prisma) await withAuditMaintenance(prisma, (tx) => tx.purgeSummary.deleteMany({ where: { runId } }));
    });

    it('empties raw and parsed of a finished file’s old rows only, and writes its summary in the same statement', async () => {
      const loaded = await newFile({ state: 'LOADED', loadedAt: new Date() });
      const discarded = await newFile({ state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: 'zz' });
      const staged = await newFile();
      const payload = { raw: { cust_code: 'zz', name: 'ZZ Customer' }, parsed: { custCode: 'ZZ' } };
      const mk = (fileId: string, rowNumber: number, createdAt: Date, outcome: 'APPLIED' | 'HELD' | 'PENDING') =>
        prisma.temixDailyRow.create({ data: { fileId, rowNumber, createdAt, outcome, custCodeKey: 'ZZ', holdReasons: outcome === 'HELD' ? ['ROUTE_NOT_MATCHED'] : [], ...payload } });
      const a = await mk(loaded.id, 1, OLD, 'APPLIED');
      const b = await mk(discarded.id, 1, OLD, 'HELD');
      const keptNew = await mk(loaded.id, 2, NEWER, 'APPLIED');
      const keptStaged = await mk(staged.id, 1, OLD, 'PENDING');

      const cleared = await withChangeContext(prisma, cause, (tx) =>
        runPurge(tx, 'temix-daily-payload-90d', temixDailyPayloadPurgeSql(now, 2000, { runId }))
      );
      expect(cleared).toBe(2);
      for (const id of [a.id, b.id]) {
        const r = await prisma.temixDailyRow.findUniqueOrThrow({ where: { id } });
        expect(r.raw).toEqual({});
        expect(r.parsed).toBeNull();
        // The codes, hold reasons and outcome stay.
        expect(r.custCodeKey).toBe('ZZ');
      }
      expect((await prisma.temixDailyRow.findUniqueOrThrow({ where: { id: b.id } })).holdReasons).toEqual(['ROUTE_NOT_MATCHED']);
      for (const id of [keptNew.id, keptStaged.id]) {
        const r = await prisma.temixDailyRow.findUniqueOrThrow({ where: { id } });
        expect(r.raw).toEqual(payload.raw);
        expect(r.parsed).toEqual(payload.parsed);
      }
      const [s, ...more] = await prisma.purgeSummary.findMany({ where: { runId } });
      expect(more).toEqual([]);
      expect(s).toMatchObject({
        job: 'retention-sweep',
        rule: 'temix-daily-payload-90d',
        tableName: 'TemixDailyRow',
        action: 'CLEAR_PAYLOAD',
        rows: 2,
        retentionDays: 90,
        dateColumn: 'createdAt',
        source: cause.source,
      });
      expect(s!.oldestAt!.toISOString()).toBe(OLD.toISOString());
      expect(s!.detail).toEqual({ byFile: { [loaded.id]: { APPLIED: 1 }, [discarded.id]: { HELD: 1 } } });
      expect(JSON.stringify(s!.detail)).not.toContain('ZZ Customer');

      // Run again: nothing left to empty, and no empty summary.
      expect(
        await withChangeContext(prisma, cause, (tx) => runPurge(tx, 'temix-daily-payload-90d', temixDailyPayloadPurgeSql(now, 2000, { runId })))
      ).toBe(0);
      expect(await prisma.purgeSummary.count({ where: { runId } })).toBe(1);
    });

    it('the sweep reads the rows that still hold a payload through the partial index', async () => {
      const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT r."id" FROM "TemixDailyRow" r WHERE r."createdAt" < now() AND (r."raw" <> '{}'::jsonb OR r."parsed" IS NOT NULL) ORDER BY r."createdAt" LIMIT 10`
      );
      // On a small table the planner may still choose a sequential scan; the index
      // must at least be usable for this predicate (a forced plan uses it).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const forced = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT r."id" FROM "TemixDailyRow" r WHERE r."createdAt" < now() AND (r."raw" <> '{}'::jsonb OR r."parsed" IS NOT NULL) ORDER BY r."createdAt" LIMIT 10`
        );
        expect(forced.map((p) => p['QUERY PLAN']).join('\n')).toContain('TemixDailyRow_payload_createdAt_idx');
      });
      expect(plan.length).toBeGreaterThan(0);
    });
  });

  describe('the route map', () => {
    const code = () => `${w.sfx.toUpperCase()}-C10MA`;

    it('one live entry per code; retired by a new row; then a new entry may follow', async () => {
      const add = await prisma.temixRouteMap.create({ data: { temixRouteCode: code(), action: 'ADD', routeId: w.route, reason: 'route master row', byId: w.steward } });
      expect(
        await refusal(() => prisma.temixRouteMap.create({ data: { temixRouteCode: code(), action: 'ADD', routeId: w.route, reason: 'again', byId: w.steward } }))
      ).toMatch(/already has a live entry/);
      await prisma.temixRouteMap.create({ data: { temixRouteCode: code(), action: 'RETIRE', retiresId: add.id, reason: 'wrong route', byId: w.steward } });
      expect(
        await refusal(() => prisma.temixRouteMap.create({ data: { temixRouteCode: code(), action: 'RETIRE', retiresId: add.id, reason: 'twice', byId: w.steward } }))
      ).toMatch(/Unique constraint/);
      const again = await prisma.temixRouteMap.create({ data: { temixRouteCode: code(), action: 'ADD', routeId: w.route, reason: 'corrected', byId: w.steward } });
      expect(again.id > add.id).toBe(true);
    });

    it('a RETIRE names an entry of the same code; the shapes and the code form are checked', async () => {
      const add = await prisma.temixRouteMap.create({ data: { temixRouteCode: `${code()}X`, action: 'ADD', routeId: w.route, reason: 'x', byId: w.steward } });
      expect(
        await refusal(() => prisma.temixRouteMap.create({ data: { temixRouteCode: code(), action: 'RETIRE', retiresId: add.id, reason: 'x', byId: w.steward } }))
      ).toMatch(/must name an entry of the same code/);
      expect(
        await refusal(() => prisma.temixRouteMap.create({ data: { temixRouteCode: `${code()}Y`, action: 'ADD', reason: 'no route', byId: w.steward } }))
      ).toMatch(/TemixRouteMap_shape_check/);
      expect(
        await refusal(() => prisma.temixRouteMap.create({ data: { temixRouteCode: 'c10ma', action: 'ADD', routeId: w.route, reason: 'x', byId: w.steward } }))
      ).toMatch(/TemixRouteMap_code_check/);
      expect(
        await refusal(() => prisma.temixRouteMap.create({ data: { temixRouteCode: `${code()}Z`, action: 'ADD', routeId: w.route, reason: ' ', byId: w.steward } }))
      ).toMatch(/TemixRouteMap_reason_check/);
    });

    it('two writers adding the same code at once: exactly one wins', async () => {
      const c = `${code()}-RACE`;
      const a = new PrismaClient();
      const b = new PrismaClient();
      try {
        const results = await Promise.allSettled(
          [a, b].map((cl) =>
            cl.$transaction(async (tx) => {
              await tx.temixRouteMap.create({ data: { temixRouteCode: c, action: 'ADD', routeId: w.route, reason: 'race', byId: w.steward } });
              await tx.$executeRawUnsafe('SELECT pg_sleep(0.3)');
            })
          )
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await prisma.temixRouteMap.count({ where: { temixRouteCode: c } })).toBe(1);
      } finally {
        await a.$disconnect();
        await b.$disconnect();
      }
    });
  });
});
