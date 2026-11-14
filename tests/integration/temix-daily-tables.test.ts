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
 *  - A file: never deleted, never dated in the future, born STAGED, its identity
 *    fixed, LOADED only from FINALIZING, its end states final and a finished
 *    file never changed at all; a reversal tick once given never changes; the
 *    same bytes once per load day (a discarded file frees its day); one file
 *    mid-load at a time.
 *  - A staged row: added only to a STAGED file; its file, number and creation
 *    time fixed; its payload never rewritten, only emptied, never refilled; a
 *    done row (APPLIED, NO_CHANGE, REJECTED) stays done.
 *  - The route map: added and retired by new rows, one live entry per code, and
 *    written under READ COMMITTED only (where the advisory lock serialises).
 *  - The CHECKs refuse what the list does not name (a kind, a hold reason that
 *    is not a code word, STATUS_DIFFERS as a "listed once" kind).
 *  - The retention rule temix-daily-payload-90d empties raw and parsed of a
 *    file's rows past the cut-off, finished or left unfinished, except under a
 *    live lease, with its summary.
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

  /** Take a staged file to LOADED the way the guard allows (through FINALIZING). */
  async function load(id: string, over: Partial<Prisma.TemixDailyFileUncheckedUpdateInput> = {}) {
    await prisma.temixDailyFile.update({ where: { id }, data: { state: 'FINALIZING' } });
    return prisma.temixDailyFile.update({ where: { id }, data: { state: 'LOADED', loadedAt: new Date(), ...over } });
  }

  async function discard(id: string) {
    return prisma.temixDailyFile.update({
      where: { id },
      data: { state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: 'zz' },
    });
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
      await tx.temixDailyFile.updateMany({ where: { id: files, sameBytesAsFileId: { not: null } }, data: { sameBytesAsFileId: null } });
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

    it('is born STAGED', async () => {
      for (const state of ['CHECKED', 'APPLYING', 'FINALIZING'] as const) {
        expect(await refusal(() => newFile({ state })), state).toMatch(/a file is staged first/);
      }
      expect(await refusal(() => newFile({ state: 'LOADED', loadedAt: new Date() }))).toMatch(/a file is staged first/);
      expect(
        await refusal(() => newFile({ state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: 'zz' }))
      ).toMatch(/a file is staged first/);
    });

    it('keeps its name, hash, size, headings, load day and uploader (loadDay fixed when staged)', async () => {
      const f = await newFile();
      for (const data of [
        { headings: ['other'] },
        { filename: 'other.csv' },
        { fileSha256: sha('other') },
        { fileBytes: 1 },
        { loadDay: asDate(yesterday) },
        { uploadedById: w.manager },
        { uploadedAt: new Date('2026-01-01T00:00:00Z') },
      ]) {
        expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: f.id }, data })), JSON.stringify(Object.keys(data))).toMatch(
          /name, hash, size, headings, load day and uploader never change/
        );
      }
      // Its state and counters move.
      await prisma.temixDailyFile.update({ where: { id: f.id }, data: { state: 'CHECKED', totalRows: 3 } });
    });

    it('LOADED only from FINALIZING; LOADED and DISCARDED are final; a discard needs who and why', async () => {
      const a = await newFile();
      for (const from of ['STAGED', 'CHECKED', 'APPLYING'] as const) {
        await prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: from } });
        expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'LOADED', loadedAt: new Date() } })), from).toMatch(
          new RegExp(`LOADED only from FINALIZING \\(not ${from}\\)`)
        );
      }
      await prisma.temixDailyFile.update({ where: { id: a.id }, data: { state: 'FINALIZING' } });
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

    it('a finished file never changes: who and why, when, the counts, the lease, the reversal tick', async () => {
      const loaded = await newFile({ reversalAckById: w.steward, reversalAckAt: new Date() });
      await load(loaded.id, { appliedById: w.steward, totalRows: 2, appliedRows: 2 });
      const discarded = await newFile();
      await discard(discarded.id);
      const later = new Date(Date.now() + 60_000);
      const probes: Array<[string, Prisma.TemixDailyFileUncheckedUpdateInput]> = [
        [loaded.id, { loadedAt: later }],
        [loaded.id, { appliedById: w.manager }],
        [loaded.id, { appliedById: null }],
        [loaded.id, { totalRows: 3 }],
        [loaded.id, { appliedRows: 1 }],
        [loaded.id, { noChangeRows: 1 }],
        [loaded.id, { heldRows: 1 }],
        [loaded.id, { rejectedRows: 1 }],
        [loaded.id, { noticeRows: 1 }],
        [loaded.id, { applyLeaseBy: 'zz', applyLeaseUntil: later }],
        [loaded.id, { applyStartedAt: later }],
        [loaded.id, { sameBytesAsFileId: discarded.id }],
        [discarded.id, { discardReason: 'another reason' }],
        [discarded.id, { discardedById: w.manager }],
        [discarded.id, { discardedAt: later }],
        [discarded.id, { reversalAckById: w.steward, reversalAckAt: later }],
      ];
      for (const [id, data] of probes) {
        expect(await refusal(() => prisma.temixDailyFile.update({ where: { id }, data })), JSON.stringify(Object.keys(data))).toMatch(
          /file is final; nothing about it changes|reversal tick, once given, never changes/
        );
      }
      // A no-op update of a finished file changes nothing, so it passes.
      await prisma.$executeRaw`UPDATE "TemixDailyFile" SET "state" = "state" WHERE "id" = ${loaded.id}`;
      const after = await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: loaded.id } });
      expect(after).toMatchObject({ appliedById: w.steward, totalRows: 2, appliedRows: 2, reversalAckById: w.steward });
    });

    it('a reversal tick, once given, never changes or is taken back', async () => {
      const f = await newFile();
      await prisma.temixDailyFile.update({ where: { id: f.id }, data: { reversalAckById: w.steward, reversalAckAt: new Date() } });
      for (const data of [
        { reversalAckById: null, reversalAckAt: null },
        { reversalAckById: w.manager },
        { reversalAckAt: new Date(Date.now() + 60_000) },
      ]) {
        expect(await refusal(() => prisma.temixDailyFile.update({ where: { id: f.id }, data })), JSON.stringify(data)).toMatch(
          /reversal tick, once given, never changes/
        );
      }
      // The file itself still moves.
      await prisma.temixDailyFile.update({ where: { id: f.id }, data: { state: 'CHECKED' } });
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
      await load(a.id);
      await prisma.temixDailyFile.update({ where: { id: b.id }, data: { state: 'APPLYING' } });
      await load(b.id);
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

    it('a row is added only to a STAGED file', async () => {
      const f = await newFile();
      await prisma.temixDailyFile.update({ where: { id: f.id }, data: { state: 'CHECKED' } });
      expect(await refusal(() => prisma.temixDailyRow.create({ data: { fileId: f.id, rowNumber: 1, raw: {} } }))).toMatch(
        /rows are added only to a STAGED file \(file .* is CHECKED\)/
      );
      const done = await newFile();
      await load(done.id);
      expect(await refusal(() => prisma.temixDailyRow.create({ data: { fileId: done.id, rowNumber: 1, raw: {} } }))).toMatch(
        /rows are added only to a STAGED file \(file .* is LOADED\)/
      );
      const gone = await newFile();
      await discard(gone.id);
      expect(await refusal(() => prisma.temixDailyRow.create({ data: { fileId: gone.id, rowNumber: 1, raw: {} } }))).toMatch(
        /rows are added only to a STAGED file \(file .* is DISCARDED\)/
      );
    });

    it('a row keeps its file, number and creation time; its payload is only ever emptied', async () => {
      const other = await newFile();
      const r = await prisma.temixDailyRow.create({
        data: { fileId: file.id, rowNumber: 10, raw: { cust_code: 'zz10' }, parsed: { custCode: 'ZZ10' } },
      });
      for (const data of [{ fileId: other.id }, { rowNumber: 11 }, { createdAt: new Date('2024-01-01T00:00:00Z') }]) {
        expect(await refusal(() => prisma.temixDailyRow.update({ where: { id: r.id }, data })), JSON.stringify(Object.keys(data))).toMatch(
          /file, number and creation time never change/
        );
      }
      expect(await refusal(() => prisma.temixDailyRow.update({ where: { id: r.id }, data: { raw: { cust_code: 'zz-other' } } }))).toMatch(
        /the row as sent is never rewritten, only emptied/
      );
      // Its parse may be redone while the payload is there; emptied, it is never filled again.
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { parsed: { custCode: 'ZZ10', note: 'rechecked' } } });
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { raw: {}, parsed: Prisma.DbNull } });
      expect(await refusal(() => prisma.temixDailyRow.update({ where: { id: r.id }, data: { parsed: { custCode: 'ZZ10' } } }))).toMatch(
        /an emptied payload is never filled again/
      );
      expect(await refusal(() => prisma.temixDailyRow.update({ where: { id: r.id }, data: { raw: { cust_code: 'zz10' } } }))).toMatch(
        /the row as sent is never rewritten, only emptied/
      );
    });

    it.each(['APPLIED', 'NO_CHANGE', 'REJECTED'] as const)('a %s row is done: it stays, only its payload may be emptied', async (outcome) => {
      const n = 20 + ['APPLIED', 'NO_CHANGE', 'REJECTED'].indexOf(outcome);
      const r = await prisma.temixDailyRow.create({
        data: { fileId: file.id, rowNumber: n, raw: { cust_code: 'zz' }, parsed: { custCode: 'ZZ' }, custCodeKey: 'ZZ', customerId: w.customer },
      });
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { outcome, doneAt: new Date() } });
      for (const data of [
        { outcome: 'PENDING' as const },
        { outcome: 'HELD' as const },
        { customerId: 'someone-else' },
        { branchId: w.branch },
        { custCodeKey: 'ZZ2' },
        { branchCodeKey: 'B1' },
        { isMainRow: true },
        { holdReasons: ['ROUTE_NOT_MATCHED'] },
        { doneAt: null },
        { parsed: { custCode: 'ZZ3' } },
      ]) {
        expect(await refusal(() => prisma.temixDailyRow.update({ where: { id: r.id }, data })), JSON.stringify(data)).toMatch(
          new RegExp(`a ${outcome} row is done; only its payload may be emptied`)
        );
      }
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { raw: {}, parsed: Prisma.DbNull } });
      const after = await prisma.temixDailyRow.findUniqueOrThrow({ where: { id: r.id } });
      expect(after).toMatchObject({ outcome, raw: {}, parsed: null, customerId: w.customer, custCodeKey: 'ZZ' });
    });

    it('a row not yet done still moves (held, re-checked, applied)', async () => {
      const r = await prisma.temixDailyRow.create({ data: { fileId: file.id, rowNumber: 30, raw: { cust_code: 'zz' } } });
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { outcome: 'HELD', holdReasons: ['ROUTE_NOT_MATCHED'] } });
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { outcome: 'PARTLY_APPLIED', holdReasons: [] } });
      await prisma.temixDailyRow.update({ where: { id: r.id }, data: { outcome: 'APPLIED', doneAt: new Date() } });
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

    const payload = { raw: { cust_code: 'zz', name: 'ZZ Customer' }, parsed: { custCode: 'ZZ' } };
    const mk = (fileId: string, rowNumber: number, createdAt: Date, outcome: 'APPLIED' | 'HELD' | 'PENDING') =>
      prisma.temixDailyRow.create({ data: { fileId, rowNumber, createdAt, outcome, custCodeKey: 'ZZ', holdReasons: outcome === 'HELD' ? ['ROUTE_NOT_MATCHED'] : [], ...payload } });
    const sweep = () => withChangeContext(prisma, cause, (tx) => runPurge(tx, 'temix-daily-payload-90d', temixDailyPayloadPurgeSql(now, 2000, { runId })));
    const payloadOf = async (id: string) => {
      const r = await prisma.temixDailyRow.findUniqueOrThrow({ where: { id } });
      return { raw: r.raw, parsed: r.parsed };
    };

    it('empties raw and parsed of a finished file’s old rows, and writes its summary in the same statement', async () => {
      const loaded = await newFile();
      const discarded = await newFile();
      // Staged now: a row dated before the cut-off in a file uploaded after it is
      // not reached (the file's own upload time is the test for an unfinished file).
      const staged = await newFile();
      const a = await mk(loaded.id, 1, OLD, 'APPLIED');
      const b = await mk(discarded.id, 1, OLD, 'HELD');
      const keptNew = await mk(loaded.id, 2, NEWER, 'APPLIED');
      const keptStaged = await mk(staged.id, 1, OLD, 'PENDING');
      await load(loaded.id);
      await discard(discarded.id);

      const cleared = await sweep();
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
      expect(await sweep()).toBe(0);
      expect(await prisma.purgeSummary.count({ where: { runId } })).toBe(1);
    });

    it('also empties the rows of a file left unfinished before the cut-off; only a live lease keeps them', async () => {
      // Review of stage 1: as the import rule's never-loaded batch. A STAGED and a
      // CHECKED file uploaded before the cut-off, and one stopped APPLYING.
      const staged = await newFile({ uploadedAt: OLD });
      const checked = await newFile({ uploadedAt: OLD });
      const applying = await newFile({ uploadedAt: OLD });
      const s1 = await mk(staged.id, 1, OLD, 'PENDING');
      const c1 = await mk(checked.id, 1, OLD, 'HELD');
      const p1 = await mk(applying.id, 1, OLD, 'PENDING');
      const p2 = await mk(applying.id, 2, OLD, 'APPLIED');
      await prisma.temixDailyFile.update({ where: { id: checked.id }, data: { state: 'CHECKED' } });
      // A load running on it at `now`: a live lease keeps every row's payload.
      await prisma.temixDailyFile.update({
        where: { id: applying.id },
        data: { state: 'APPLYING', applyLeaseBy: 'zz-worker', applyLeaseUntil: new Date(now.getTime() + 60_000) },
      });
      expect(await sweep()).toBe(2);
      for (const id of [s1.id, c1.id]) expect(await payloadOf(id), id).toEqual({ raw: {}, parsed: null });
      for (const id of [p1.id, p2.id]) expect(await payloadOf(id), id).toEqual(payload);
      // The lease lapses (the load stopped): the next run empties them too.
      await prisma.temixDailyFile.update({ where: { id: applying.id }, data: { applyLeaseUntil: new Date(now.getTime() - 60_000) } });
      expect(await sweep()).toBe(2);
      for (const id of [p1.id, p2.id]) expect(await payloadOf(id), id).toEqual({ raw: {}, parsed: null });
      await discard(applying.id);
      // Stopped FINALIZING with no lease written down at all: the same.
      const finalizing = await newFile({ uploadedAt: OLD });
      const f1 = await mk(finalizing.id, 1, OLD, 'APPLIED');
      await prisma.temixDailyFile.update({ where: { id: finalizing.id }, data: { state: 'FINALIZING' } });
      expect(await sweep()).toBe(1);
      expect(await payloadOf(f1.id)).toEqual({ raw: {}, parsed: null });
      // The outcome and codes stay; only the payload went.
      expect(await prisma.temixDailyRow.findUniqueOrThrow({ where: { id: p1.id } })).toMatchObject({ outcome: 'PENDING', custCodeKey: 'ZZ' });
      const sums = await prisma.purgeSummary.findMany({ where: { runId }, orderBy: { id: 'asc' } });
      expect(sums.slice(-3).map((x) => x.detail)).toEqual([
        { byFile: { [staged.id]: { PENDING: 1 }, [checked.id]: { HELD: 1 } } },
        { byFile: { [applying.id]: { PENDING: 1, APPLIED: 1 } } },
        { byFile: { [finalizing.id]: { APPLIED: 1 } } },
      ]);
      // Release the one-in-flight slot for the rest of the suite.
      await discard(finalizing.id);
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

    it.each([Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable])(
      'a route-map row is refused under %s (the lock serialises only under READ COMMITTED)',
      async (isolationLevel) => {
        const c = `${code()}-I${isolationLevel === Prisma.TransactionIsolationLevel.Serializable ? 'SZ' : 'RR'}`;
        expect(
          await refusal(() =>
            prisma.$transaction((tx) => tx.temixRouteMap.create({ data: { temixRouteCode: c, action: 'ADD', routeId: w.route, reason: 'iso', byId: w.steward } }), {
              isolationLevel,
            })
          )
        ).toMatch(/written under READ COMMITTED only/);
        // Through the change context too, which takes the same option.
        expect(
          await refusal(() =>
            withChangeContext(prisma, cause, (tx) => tx.temixRouteMap.create({ data: { temixRouteCode: c, action: 'ADD', routeId: w.route, reason: 'iso', byId: w.steward } }), {
              isolationLevel,
            })
          )
        ).toMatch(/written under READ COMMITTED only/);
        expect(await prisma.temixRouteMap.count({ where: { temixRouteCode: c } })).toBe(0);
        // READ COMMITTED (the default) writes it.
        await withChangeContext(prisma, cause, (tx) => tx.temixRouteMap.create({ data: { temixRouteCode: c, action: 'ADD', routeId: w.route, reason: 'iso', byId: w.steward } }));
        const add = await prisma.temixRouteMap.findFirstOrThrow({ where: { temixRouteCode: c, action: 'ADD' } });
        await prisma.temixRouteMap.create({ data: { temixRouteCode: c, action: 'RETIRE', retiresId: add.id, reason: 'iso done', byId: w.steward } });
      }
    );

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
