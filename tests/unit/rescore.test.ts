// @vitest-environment node
/**
 * lib/rescore.ts (auditor recheck 2026-09-27, F21 part 2): the one rescore the
 * import's promote and scripts/ops/rescore-completeness.ts share.
 *
 *  - planRescore is lib/completeness.ts applied to the rows as read: it returns
 *    exactly the stored scores that differ, and an archived branch neither is
 *    scored nor counts towards its customer's average;
 *  - the write is raw SQL, one statement per table, that sets the score only
 *    where it still differs — so updatedAt (set by the Prisma client, never by
 *    the database) and version stay as they were on every row — proved here
 *    against an in-memory table that applies the statement's own rows;
 *  - the module stays importable by an operator script: no lib/db, no lib/audit.
 * Against Postgres: tests/integration/rescore-completeness.test.ts and
 * tests/integration/import-multibranch.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { stripComments } from '../support/strip-comments';
import {
  planRescore,
  writeRescore,
  rescoreCustomerTx,
  RESCORE_CUSTOMER_SELECT,
  type RescoreBranch,
  type RescoreCustomer,
} from '@/lib/rescore';
import { scoreBranch, scoreCustomer } from '@/lib/completeness';

const branch = (id: string, over: Partial<RescoreBranch> = {}): RescoreBranch => ({
  id,
  completenessScore: 0,
  deletedAt: null,
  gpsLat: null,
  gpsLng: null,
  address: 'Way 12, Muscat',
  shopPhotoId: null,
  signboardPhotoId: null,
  dayOfVisit: 'SUN',
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  openingHours: null,
  deliveryWindow: null,
  status: 'ACTIVE',
  ...over,
});

const customer = (
  id: string,
  branches: RescoreBranch[],
  over: Partial<RescoreCustomer> = {}
): RescoreCustomer => ({
  id,
  completenessScore: 0,
  channelId: 'ch-1',
  subChannelId: 'sub-1',
  primaryPhone: '+96891234567',
  contactPerson: 'Someone',
  crNumber: null,
  crPhotoId: null,
  paymentTerms: 'CASH',
  notes: null,
  branches,
  ...over,
});

/** Stored as lib/completeness.ts would make it: nothing to change. */
const right = <T extends RescoreBranch>(b: T): T => ({ ...b, completenessScore: scoreBranch(b) });

describe('planRescore', () => {
  it('returns exactly the stored scores that differ, customer and branch, with what they become', () => {
    const created = branch('b-created'); // the import created it: stored at the default 0
    const updated = branch('b-updated', { completenessScore: 10, gpsLat: 23.6, gpsLng: 58.4 }); // stale
    const fine = right(branch('b-fine', { shopPhotoId: 'p1' }));
    const c = customer('c-1', [created, updated, fine], { completenessScore: 3 });
    const plan = planRescore([c]);
    expect(plan.customersScanned).toBe(1);
    expect(plan.branchesScanned).toBe(3);
    expect(plan.branches).toEqual([
      { id: 'b-created', from: 0, to: scoreBranch(created) },
      { id: 'b-updated', from: 10, to: scoreBranch(updated) },
    ]);
    expect(plan.customers).toEqual([
      { id: 'c-1', from: 3, to: scoreCustomer(c, [created, updated, fine]) },
    ]);
  });

  it('a customer whose scores are all right is scanned and left alone', () => {
    const b = right(branch('b-1'));
    const c = customer('c-1', [b]);
    const plan = planRescore([{ ...c, completenessScore: scoreCustomer(c, [b]) }]);
    expect(plan).toEqual({ customersScanned: 1, branchesScanned: 1, customers: [], branches: [] });
  });

  it('ignores an archived branch: not scored, not counted, not in its customer average', () => {
    const liveOne = right(branch('b-live', { gpsLat: 23.6, gpsLng: 58.4, shopPhotoId: 'p' }));
    const archived = branch('b-archived', {
      deletedAt: new Date('2026-09-01T00:00:00Z'),
      completenessScore: 99,
    });
    const c = customer('c-1', [liveOne, archived]);
    const plan = planRescore([c]);
    expect(plan.branchesScanned).toBe(1);
    expect(plan.branches).toEqual([]);
    expect(plan.customers).toEqual([{ id: 'c-1', from: 0, to: scoreCustomer(c, [liveOne]) }]);
    expect(scoreCustomer(c, [liveOne])).not.toBe(scoreCustomer(c, [liveOne, archived]));
  });

  it('a customer with no live branch scores on its own fields only', () => {
    const c = customer('c-1', []);
    expect(planRescore([c]).customers).toEqual([{ id: 'c-1', from: 0, to: scoreCustomer(c, []) }]);
  });
});

/** A table in memory that applies the statement's own (id, score) rows and its WHERE. */
function fakeDb(
  rows: Record<
    string,
    Record<string, { completenessScore: number; version: number; updatedAt: Date }>
  >
) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const $executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...values);
    statements.push({ sql: q.sql, values: q.values });
    const table = /^UPDATE "(\w+)"/.exec(q.sql)![1];
    let changed = 0;
    for (let i = 0; i < q.values.length; i += 2) {
      const row = rows[table][q.values[i] as string];
      const score = q.values[i + 1] as number;
      // WHERE b."id" = v.id AND b."completenessScore" <> v.score
      if (row && row.completenessScore !== score) {
        row.completenessScore = score;
        changed += 1;
      }
    }
    return changed;
  });
  return { tx: { $executeRaw } as unknown as Prisma.TransactionClient, statements, $executeRaw };
}

describe('writeRescore', () => {
  const stamp = new Date('2026-09-20T08:00:00Z');
  const tables = () => ({
    Branch: {
      'b-1': { completenessScore: 0, version: 4, updatedAt: stamp },
      'b-2': { completenessScore: 0, version: 1, updatedAt: stamp },
    },
    Customer: { 'c-1': { completenessScore: 12, version: 7, updatedAt: stamp } },
  });

  it('one statement per table, only the score column, only where it still differs', async () => {
    const rows = tables();
    const { tx, statements } = fakeDb(rows);
    const written = await writeRescore(tx, {
      branches: [
        { id: 'b-1', from: 0, to: 40 },
        { id: 'b-2', from: 0, to: 35 },
      ],
      customers: [{ id: 'c-1', from: 12, to: 60 }],
    });
    expect(written).toEqual({ customers: 1, branches: 2 });
    expect(statements.map((s) => s.values)).toEqual([
      ['b-1', 40, 'b-2', 35],
      ['c-1', 60],
    ]);
    expect(statements[0].sql).toBe(
      'UPDATE "Branch" AS b SET "completenessScore" = v.score FROM (VALUES (?::text, ?::int),(?::text, ?::int)) AS v(id, score) WHERE b."id" = v.id AND b."completenessScore" <> v.score'
    );
    expect(statements[1].sql).toBe(
      'UPDATE "Customer" AS c SET "completenessScore" = v.score FROM (VALUES (?::text, ?::int)) AS v(id, score) WHERE c."id" = v.id AND c."completenessScore" <> v.score'
    );
    // version and updatedAt are never named, so nothing moves them.
    expect(rows.Branch['b-1']).toEqual({ completenessScore: 40, version: 4, updatedAt: stamp });
    expect(rows.Customer['c-1']).toEqual({ completenessScore: 60, version: 7, updatedAt: stamp });
  });

  it('writes nothing for an empty side, and nothing at all for an empty plan', async () => {
    const { tx, statements } = fakeDb(tables());
    expect(
      await writeRescore(tx, { branches: [], customers: [{ id: 'c-1', from: 12, to: 60 }] })
    ).toEqual({
      customers: 1,
      branches: 0,
    });
    expect(statements.map((s) => s.sql.slice(0, 17))).toEqual(['UPDATE "Customer"']);
    const empty = fakeDb(tables());
    expect(await writeRescore(empty.tx, { branches: [], customers: [] })).toEqual({
      customers: 0,
      branches: 0,
    });
    expect(empty.statements).toEqual([]);
  });

  it('a score that moved meanwhile to the planned value is not counted as written', async () => {
    const rows = tables();
    rows.Branch['b-1'].completenessScore = 40;
    const { tx } = fakeDb(rows);
    expect(
      await writeRescore(tx, { branches: [{ id: 'b-1', from: 0, to: 40 }], customers: [] })
    ).toEqual({
      customers: 0,
      branches: 0,
    });
  });

  it('splits a plan over 5,000 rows into statements Postgres can bind (65,535 parameters)', async () => {
    const many = Array.from({ length: 5_001 }, (_, i) => ({ id: `b-${i}`, from: 0, to: 5 }));
    const { tx, statements } = fakeDb({ Branch: {}, Customer: {} });
    await writeRescore(tx, { branches: many, customers: [] });
    expect(statements.map((s) => s.values.length)).toEqual([10_000, 2]);
  });
});

describe('rescoreCustomerTx', () => {
  it('reads the customers once, with their live branches, and writes what differs; a second pass writes nothing', async () => {
    const b = branch('b-1', { gpsLat: 23.6, gpsLng: 58.4 });
    const stored = customer('c-1', [b]);
    const rows = {
      Branch: { 'b-1': { completenessScore: 0, version: 2, updatedAt: new Date(0) } },
      Customer: { 'c-1': { completenessScore: 0, version: 5, updatedAt: new Date(0) } },
    };
    const { tx, $executeRaw } = fakeDb(rows);
    const findMany = vi.fn(async () => [
      {
        ...stored,
        completenessScore: rows.Customer['c-1'].completenessScore,
        branches: [{ ...b, completenessScore: rows.Branch['b-1'].completenessScore }],
      },
    ]);
    Object.assign(tx, { customer: { findMany } });

    const first = await rescoreCustomerTx(tx, ['c-1', 'c-1']);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-1'] } },
      select: RESCORE_CUSTOMER_SELECT,
    });
    expect(first.written).toEqual({ customers: 1, branches: 1 });
    expect(rows.Branch['b-1']).toMatchObject({ completenessScore: scoreBranch(b), version: 2 });
    expect(rows.Customer['c-1']).toMatchObject({
      completenessScore: scoreCustomer(stored, [b]),
      version: 5,
    });

    $executeRaw.mockClear();
    const second = await rescoreCustomerTx(tx, ['c-1']);
    expect(second.plan.customers).toEqual([]);
    expect(second.plan.branches).toEqual([]);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it('no customers: no read, no write', async () => {
    const findMany = vi.fn();
    const { tx, $executeRaw } = fakeDb({ Branch: {}, Customer: {} });
    Object.assign(tx, { customer: { findMany } });
    const res = await rescoreCustomerTx(tx, []);
    expect(res.written).toEqual({ customers: 0, branches: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it('selects live branches only, and every column lib/completeness.ts scores', () => {
    expect(RESCORE_CUSTOMER_SELECT.branches.where).toEqual({ deletedAt: null });
    const src = stripComments(readFileSync('lib/completeness.ts', 'utf8'), 'x.ts');
    // The columns the scoring functions read off `c.` and `b.`.
    const read = (v: string) =>
      [...new Set([...src.matchAll(new RegExp(`\\b${v}\\.(\\w+)`, 'g'))].map((m) => m[1]))].sort();
    expect(read('c').every((k) => k in RESCORE_CUSTOMER_SELECT)).toBe(true);
    expect(read('b').every((k) => k in RESCORE_CUSTOMER_SELECT.branches.select)).toBe(true);
    expect(read('b')).toContain('equipmentConfirmed');
  });
});

describe('lib/rescore.ts stays importable by an operator script', () => {
  it('imports only @prisma/client and lib/completeness — no lib/db, no lib/audit', () => {
    const src = stripComments(readFileSync('lib/rescore.ts', 'utf8'), 'x.ts');
    const froms = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(froms).toEqual(['./completeness', '@prisma/client']);
  });
});
