// @vitest-environment node
/**
 * Follow-up 1 (F1, F2): the go-live clean start's own AuditLog record, as
 * scripts/ops/clean-start/reset.sql writes it, read by the Audit page (the
 * removed and kept counts) and by the dashboard (the moment).
 *
 * The record's shape is taken from reset.sql itself and from tables.json, so a
 * change to the SQL that moves a mark or a list fails here before it reaches a
 * screen. On Postgres, tests/integration/clean-start.test.ts runs the real reset
 * and reads the row through the Audit page's data layer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLEAN_START_KIND_LABELS,
  CLEAN_START_RECORD,
  cleanStartCounts,
  isCleanStartRecord,
} from '@/lib/clean-start-record';

const RESET = readFileSync('scripts/ops/clean-start/reset.sql', 'utf8');
const TABLES = JSON.parse(readFileSync('scripts/ops/clean-start/tables.json', 'utf8')) as {
  EMPTY: string[];
  PARTIAL: Record<string, string>;
  KEEP: string[];
};

/** The table lists reset.sql's `removed` (NOT IN) and `kept` (IN) aggregates are built from. */
function sqlLists(): { notRemoved: string[]; keptNamed: string[] } {
  const insert = RESET.slice(RESET.indexOf('INSERT INTO public."AuditLog"'), RESET.indexOf('-- BEGIN BASELINE'));
  const list = (re: RegExp) => {
    const m = re.exec(insert);
    if (!m) throw new Error(`not found: ${re}`);
    return [...m[1]!.matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]!);
  };
  return {
    notRemoved: list(/'removed'[\s\S]*?b\.name NOT IN \(([^)]*)\)/),
    keptNamed: list(/'kept'[\s\S]*?b\.name IN \(([^)]*)\)/),
  };
}

/** An `after` with the shape reset.sql writes, with made-up counts. */
function realShape() {
  const { notRemoved, keptNamed } = sqlLists();
  const all = [...TABLES.EMPTY, ...Object.keys(TABLES.PARTIAL), ...TABLES.KEEP];
  const removedKinds = all.filter((t) => !notRemoved.includes(t)).sort();
  const keptKinds = keptNamed.slice().sort();
  const n = (t: string, salt: number) => (t.length * 37 + salt) % 500;
  return {
    runId: '123456789',
    commit: 'abcdef1',
    planId: 'a'.repeat(64),
    backup: { key: 'db/2026-11-18.sql.gz.age', sha256: 'b'.repeat(64) },
    photoKeysSha256: 'c'.repeat(64),
    sealsSha256: 'd'.repeat(64),
    oldChain: { chain: 'e'.repeat(16), lastSeq: 40, lastDay: '2026-11-17', lastHash: 'f'.repeat(64) },
    sealArchivePrefix: 'cleanstart/123456789/seals/',
    safetyBranch: 'pre-clean-start',
    removed: Object.fromEntries(removedKinds.map((t) => [t, n(t, 1)])),
    kept: Object.fromEntries(keptKinds.map((t) => [t, n(t, 2)])),
  };
}

const RECORD = {
  id: 'cleanstart-123456789',
  action: 'DELETE',
  entityType: 'System',
  entityId: 'clean-start',
  source: 'script:clean-start:123456789',
};

describe('the record is found by every mark reset.sql gives it', () => {
  it('the marks are the ones in reset.sql', () => {
    expect(RESET).toContain(
      `VALUES ('${CLEAN_START_RECORD.idPrefix}' || :'run_id', current_setting('nmwc.actor'), '${CLEAN_START_RECORD.action}', '${CLEAN_START_RECORD.entityType}', '${CLEAN_START_RECORD.entityId}',`
    );
    expect(RESET).toContain(`set_config('nmwc.source', '${CLEAN_START_RECORD.sourcePrefix}' || :'run_id', true)`);
  });

  it('the clean start’s row is it; a row that lacks any one mark is not', () => {
    expect(isCleanStartRecord(RECORD)).toBe(true);
    expect(isCleanStartRecord({ ...RECORD, id: 'ckxyz0000000000000000000' })).toBe(false);
    expect(isCleanStartRecord({ ...RECORD, action: 'UPDATE' })).toBe(false);
    expect(isCleanStartRecord({ ...RECORD, entityType: 'Customer' })).toBe(false);
    expect(isCleanStartRecord({ ...RECORD, entityId: 'app-role-verify' })).toBe(false);
    expect(isCleanStartRecord({ ...RECORD, source: null })).toBe(false);
    expect(isCleanStartRecord({ ...RECORD, source: 'web:/import' })).toBe(false);
  });
});

describe('the removed and kept counts, from the record only', () => {
  it('the SQL lists are the ones tables.json names (the PARTIAL tables in both)', () => {
    const { notRemoved, keptNamed } = sqlLists();
    expect(notRemoved.sort()).toEqual([...TABLES.KEEP].sort());
    expect(keptNamed.sort()).toEqual([...TABLES.KEEP, ...Object.keys(TABLES.PARTIAL)].sort());
  });

  it('every kind the record can name has plain words, and no word list entry is stale', () => {
    const named = [...TABLES.EMPTY, ...Object.keys(TABLES.PARTIAL), ...TABLES.KEEP].sort();
    expect(Object.keys(CLEAN_START_KIND_LABELS).sort()).toEqual(named);
    for (const label of Object.values(CLEAN_START_KIND_LABELS)) {
      expect(label).toMatch(/^[A-Z][A-Za-z–() -]+$/);
      expect(label).not.toMatch(/[a-z][A-Z]/); // no table names run together
    }
  });

  it('the real shape: each kind once, its figures exactly as recorded, a dash (null) where the record holds none', () => {
    const after = realShape();
    const rows = cleanStartCounts(after)!;
    expect(rows.map((r) => r.kind).sort()).toEqual(
      [...TABLES.EMPTY, ...Object.keys(TABLES.PARTIAL), ...TABLES.KEEP].sort()
    );
    for (const r of rows) {
      expect(r.removed).toBe(after.removed[r.kind] ?? null);
      expect(r.kept).toBe(after.kept[r.kind] ?? null);
      expect(r.label).toBe(CLEAN_START_KIND_LABELS[r.kind]);
    }
    // An emptied table: removed only. A kept one: kept only. A partial one: both.
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(by.Customer).toMatchObject({ label: 'Customers', removed: after.removed.Customer, kept: null });
    expect(by.User).toMatchObject({ label: 'Accounts', removed: null, kept: after.kept.User });
    expect(by.CronRun).toMatchObject({ removed: after.removed.CronRun, kept: after.kept.CronRun });
    // Listed in the page's order: customers first, the kept kinds last.
    expect(rows[0]!.kind).toBe('Customer');
    expect(rows.at(-1)!.kind).toBe('CronHeartbeat');
  });

  it('a count of 0 is a figure, and is shown as 0', () => {
    const rows = cleanStartCounts({ removed: { Customer: 0 }, kept: { User: 0 } })!;
    expect(rows).toEqual([
      { kind: 'Customer', label: 'Customers', removed: 0, kept: null },
      { kind: 'User', label: 'Accounts', removed: null, kept: 0 },
    ]);
  });

  it('a figure that is not a whole number of records is not shown as one', () => {
    const rows = cleanStartCounts({
      removed: { Customer: '12', Branch: -1, Attachment: 1.5, CustomerEdit: null, Notification: 7 },
    })!;
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.removed]))).toEqual({
      Customer: null,
      Branch: null,
      Attachment: null,
      CustomerEdit: null,
      Notification: 7,
    });
  });

  it('only one list recorded: the other column holds no figure', () => {
    expect(cleanStartCounts({ removed: { Customer: 3 } })).toEqual([
      { kind: 'Customer', label: 'Customers', removed: 3, kept: null },
    ]);
    expect(cleanStartCounts({ kept: { Route: 4 } })).toEqual([{ kind: 'Route', label: 'Routes', removed: null, kept: 4 }]);
  });

  it('a kind added after this list is shown by its own name, after the known ones', () => {
    const rows = cleanStartCounts({ removed: { ZetaThing: 2, Customer: 1, AlphaThing: 5 } })!;
    expect(rows.map((r) => r.label)).toEqual(['Customers', 'AlphaThing', 'ZetaThing']);
  });

  it('no list at all (or no record body): nothing to show, and nothing invented', () => {
    expect(cleanStartCounts(null)).toBeNull();
    expect(cleanStartCounts('removed')).toBeNull();
    expect(cleanStartCounts([])).toBeNull();
    expect(cleanStartCounts({ runId: '1' })).toBeNull();
    expect(cleanStartCounts({ removed: null, kept: [1, 2] })).toBeNull();
    // jsonb_object_agg over no rows writes null: an empty object is a list with no kinds.
    expect(cleanStartCounts({ removed: {}, kept: {} })).toEqual([]);
  });

  it('a key a prototype owns is not read as a count', () => {
    const rows = cleanStartCounts({ removed: { Customer: 1 }, kept: {} })!;
    expect(rows).toEqual([{ kind: 'Customer', label: 'Customers', removed: 1, kept: null }]);
    const odd = cleanStartCounts(JSON.parse('{"removed":{"toString":3,"__proto__":4}}'))!;
    expect(odd.map((r) => [r.label, r.removed])).toEqual([
      ['__proto__', 4],
      ['toString', 3],
    ]);
  });
});
