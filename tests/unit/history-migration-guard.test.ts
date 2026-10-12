// @vitest-environment node
/**
 * The history foundation's SQL (prisma/migrations/20261013100100_history_foundation)
 * against what the rest of the system believes about it.
 *
 *  - A new column on Customer, Branch, User, Route or Region fails here until
 *    someone decides whether its changes are history (watched) or not: the same
 *    control the personal-data inventory is (tests/unit/pii-classification.test.ts).
 *  - Each capture trigger's WHEN clause and its function's changedFields list
 *    name the same columns, so a watched column always says what changed.
 *  - No personal value is stored: the history tables have no column for one.
 *  - lib/history-tables.ts (read by app-role, restore-verify, /status, /api/health
 *    and the e2e clean-up) names exactly the triggers and functions created.
 *  - The baseline is written before the insert guards exist, under the
 *    migration's own source, for every table.
 *
 * Structural, per CLAUDE.md: SQL comments are stripped first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrismaSchema, storedFields } from '@/lib/compliance/prisma-schema';
import {
  CAPTURED_TABLES,
  HISTORY_DEFINER_FUNCTIONS,
  HISTORY_FUNCTIONS,
  HISTORY_TABLES,
  HISTORY_TRIGGERS,
} from '@/lib/history-tables';

const RAW = readFileSync(
  'prisma/migrations/20261013100100_history_foundation/migration.sql',
  'utf8'
);
const SQL = RAW.replace(/--[^\n]*/g, '');
const schema = parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'));
const columnsOf = (model: string) =>
  storedFields(schema)
    .filter((f) => f.model === model)
    .map((f) => f.name);

/** Watched: a change to it writes a history row. Personal ones are recorded by NAME only. */
const WATCHED: Record<(typeof CAPTURED_TABLES)[number], string[]> = {
  Customer: [
    'nmwcCode',
    'paymentTerms',
    'creditLimit',
    'paymentTermDays',
    'temixCode',
    'status',
    'channelId',
    'subChannelId',
    'crPhotoId',
    'deletedAt',
    'legalName',
    'crNumber',
    'primaryPhone',
    'altPhone',
    'contactPerson',
    'contactRole',
    'email',
    'notes',
  ],
  Branch: [
    'branchCode',
    'customerId',
    'routeId',
    'regionId',
    'dayOfVisit',
    'status',
    'deletedAt',
    'coolersCount',
    'standsCount',
    'emptyBottlesCount',
    'equipmentConfirmed',
    'shopPhotoId',
    'signboardPhotoId',
    'branchName',
    'address',
    'areaDescription',
    'gpsLat',
    'gpsLng',
    'gpsAccuracy',
    'gpsCapturedAt',
    'openingHours',
    'deliveryWindow',
  ],
  User: [
    'username',
    'role',
    'isActive',
    'supervisorId',
    'ownedRouteId',
    'fullName',
    'email',
    'phone',
  ],
  Route: ['code', 'name', 'regionId', 'isActive'],
  Region: ['code', 'name', 'isActive'],
};

/** Not watched, and why: derived, a counter, a timestamp, a credential, or queue state. */
const UNWATCHED: Record<(typeof CAPTURED_TABLES)[number], string[]> = {
  // Norms are derived from crNumber/primaryPhone; the score is derived; version and
  // the editor/creator stamps are bookkeeping; the Temix columns are the upload
  // queue (TemixSyncBatch.customerIds already says which batches carried whom, and
  // Generate flips thousands at once); import lineage never changes after create.
  Customer: [
    'id',
    'crNumberNorm',
    'primaryPhoneNorm',
    'completenessScore',
    'version',
    'importBatchId',
    'importRowId',
    'temixSyncState',
    'temixSyncPendingSince',
    'lastTemixUploadAt',
    'lastTemixUploadBatchId',
    'createdAt',
    'updatedAt',
    'createdById',
    'lastEditedById',
  ],
  // lastStatusChangeAt moves only with status, which is watched.
  Branch: [
    'id',
    'completenessScore',
    'lastStatusChangeAt',
    'version',
    'createdAt',
    'updatedAt',
    'createdById',
    'lastEditedById',
  ],
  // Credentials and sign-in bookkeeping; session cut-offs are part C's AuthEvent.
  User: [
    'id',
    'passwordHash',
    'createdAt',
    'updatedAt',
    'lastLoginAt',
    'sessionsRevokedAt',
    'mustChangePassword',
  ],
  Route: ['id', 'createdAt', 'updatedAt'],
  Region: ['id', 'createdAt', 'updatedAt'],
};

/** Personal values: never stored in the history, only named in changedFields. */
const PERSONAL = [
  'legalName',
  'crNumber',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'email',
  'notes',
  'branchName',
  'address',
  'areaDescription',
  'gpsLat',
  'gpsLng',
  'gpsAccuracy',
  'gpsCapturedAt',
  'openingHours',
  'deliveryWindow',
  'fullName',
  'phone',
  'crNumberNorm',
  'primaryPhoneNorm',
  'passwordHash',
];

/** The body of `CREATE OR REPLACE FUNCTION <name>()`, up to its closing `$$;`. */
function functionBody(name: string): string {
  const start = SQL.search(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(`));
  expect(start, name).toBeGreaterThan(-1);
  const open = SQL.indexOf('$$', start);
  return SQL.slice(open + 2, SQL.indexOf('$$', open + 2));
}

/** The WHEN (...) of `CREATE TRIGGER <name>`. */
function whenClause(trigger: string): string {
  const start = SQL.indexOf(`CREATE TRIGGER ${trigger}\n`);
  expect(start, trigger).toBeGreaterThan(-1);
  return SQL.slice(SQL.indexOf('WHEN', start), SQL.indexOf('EXECUTE FUNCTION', start));
}

const quoted = (text: string, prefix: string) =>
  new Set([...text.matchAll(new RegExp(`\\b${prefix}\\."([A-Za-z]+)"`, 'g'))].map((m) => m[1]!));

describe('history foundation: every master column is decided', () => {
  it.each(CAPTURED_TABLES)('%s: each stored column is watched or deliberately not', (model) => {
    const cols = columnsOf(model);
    const decided = new Set([...WATCHED[model], ...UNWATCHED[model]]);
    expect(
      cols.filter((c) => !decided.has(c)),
      `decide each new ${model} column in this test and in the migration`
    ).toEqual([]);
    expect(
      [...decided].filter((c) => !cols.includes(c)),
      'columns that no longer exist'
    ).toEqual([]);
  });

  it.each(CAPTURED_TABLES)(
    '%s: the UPDATE trigger fires on exactly the watched columns, OLD and NEW alike',
    (model) => {
      const when = whenClause(`${model.toLowerCase()}_history_capture_upd`);
      expect([...quoted(when, 'OLD')].sort()).toEqual([...WATCHED[model]].sort());
      expect([...quoted(when, 'NEW')].sort()).toEqual([...WATCHED[model]].sort());
    }
  );

  it.each(CAPTURED_TABLES)(
    '%s: its function names every watched column it compares in changedFields',
    (model) => {
      const body = functionBody(`nmwc_history_${model.toLowerCase()}`);
      // Only the compared columns (o."x" IS DISTINCT FROM ...), not the INSERT's r."x".
      const compared = new Set(
        [...body.matchAll(/IF \(?o\."([A-Za-z]+)"/g)]
          .map((m) => m[1]!)
          .concat(
            // Branch's GPS: four columns compared as one row, recorded as 'gps'.
            [
              ...body.matchAll(
                /IF \(o\."gpsLat", o\."gpsLng", o\."gpsAccuracy", o\."gpsCapturedAt"\)/g
              ),
            ].flatMap(() => ['gpsLat', 'gpsLng', 'gpsAccuracy', 'gpsCapturedAt'])
          )
      );
      expect([...compared].sort()).toEqual([...WATCHED[model]].sort());
    }
  );
});

describe('history foundation: no personal value is stored', () => {
  it.each(HISTORY_TABLES)('%s has no column for one, in the migration or the schema', (table) => {
    const ddl = SQL.slice(
      SQL.indexOf(`CREATE TABLE "${table}"`),
      SQL.indexOf(');', SQL.indexOf(`CREATE TABLE "${table}"`))
    );
    expect(ddl.length).toBeGreaterThan(100);
    const sqlCols = [...ddl.matchAll(/^\s+"([A-Za-z]+)"/gm)].map((m) => m[1]!);
    expect(sqlCols.filter((c) => PERSONAL.includes(c))).toEqual([]);
    expect(columnsOf(table).filter((c) => PERSONAL.includes(c))).toEqual([]);
    // The table in the migration is the table in schema.prisma, column for column.
    expect([...sqlCols].sort()).toEqual([...columnsOf(table)].sort());
  });
});

describe('history foundation: lib/history-tables.ts is the migration', () => {
  it('names exactly the triggers it creates', () => {
    const created = [...SQL.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_]+)/g)].map(
      (m) => m[1]!
    );
    expect([...created].sort()).toEqual([...HISTORY_TRIGGERS].sort());
  });

  it('names exactly the functions it creates', () => {
    const created = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]!);
    expect([...created].sort()).toEqual([...HISTORY_FUNCTIONS].sort());
    const definers = [
      ...SQL.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\([^$]*?SECURITY DEFINER/g),
    ].map((m) => m[1]!);
    expect([...definers].sort()).toEqual([...HISTORY_DEFINER_FUNCTIONS].sort());
  });

  it('takes INSERT, UPDATE and every sequence privilege of every history table from the runtime role', () => {
    const revoke = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('END;\n$$;', SQL.indexOf('DO $$')));
    for (const t of HISTORY_TABLES) {
      expect(revoke, t).toContain(`"${t}"`);
      expect(revoke, t).toContain(`"${t}_id_seq"`);
    }
    expect(revoke).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER/);
  });
});

describe('history foundation: the first page', () => {
  it.each(HISTORY_TABLES)(
    '%s gets a BASELINE under the migration’s own source, before its insert guard exists',
    (table) => {
      const baseline = SQL.indexOf(`INSERT INTO "${table}"`);
      const guard = SQL.indexOf(`CREATE TRIGGER ${table.toLowerCase()}_insert_guard`);
      expect(baseline, 'baseline insert').toBeGreaterThan(-1);
      expect(guard, 'insert guard').toBeGreaterThan(baseline);
      const stmt = SQL.slice(baseline, SQL.indexOf(';', baseline));
      expect(stmt).toContain("'BASELINE'");
      expect(stmt).toContain("'migration:20261013100100_history_foundation'");
    }
  );

  it('locks the master tables first, and the capture triggers come after every baseline row', () => {
    const lock = SQL.indexOf(
      'LOCK TABLE "Customer", "Branch", "User", "Route", "Region", "_ManagerRegions" IN SHARE ROW EXCLUSIVE MODE'
    );
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(SQL.indexOf('CREATE TABLE'));
    const lastBaseline = Math.max(...HISTORY_TABLES.map((t) => SQL.indexOf(`INSERT INTO "${t}"`)));
    expect(SQL.indexOf('CREATE TRIGGER customer_history_capture')).toBeGreaterThan(lastBaseline);
    expect(SQL.trimEnd().endsWith('RESET lock_timeout;')).toBe(true);
  });
});

describe('history foundation: the operator checks know about it', () => {
  const strip = (f: string) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('app-role `grant` takes the history back from the runtime role AFTER its blanket GRANT', () => {
    const src = strip('scripts/ops/app-role.ts');
    const blanket = src.indexOf('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public');
    const sequences = src.indexOf('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public');
    const tables = src.indexOf(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "${t}"'
    );
    const seqs = src.indexOf('REVOKE ALL ON SEQUENCE "${historySequence(t)}"');
    const exec = src.indexOf('REVOKE EXECUTE ON FUNCTION ${f}() FROM PUBLIC');
    for (const [label, at] of Object.entries({ blanket, sequences, tables, seqs, exec }))
      expect(at, label).toBeGreaterThan(-1);
    expect(tables).toBeGreaterThan(blanket);
    expect(seqs).toBeGreaterThan(sequences);
    // Probed by `verify` and reported by `status`.
    expect(src).toMatch(/history capture: expected/);
    expect(src).toMatch(/history tables: read-only for/);
  });

  it('restore-verify expects every history trigger, and the runtime role to hold SELECT only on the history', () => {
    const src = strip('scripts/ops/restore-verify.ts');
    expect(src).toMatch(/\.\.\.HISTORY_TRIGGERS,/);
    expect(src).toMatch(/HISTORY_TABLES\.map\(\(t\) => \[t, \['SELECT'\]\]\)/);
    expect(src).toMatch(/'F-03'/);
    expect(src).toMatch(/'F-04'/);
  });
});
