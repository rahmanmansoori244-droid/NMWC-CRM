// @vitest-environment node
/**
 * The history migrations' SQL (prisma/migrations/20261013100100_history_foundation
 * and 20261014100000_lossless_paths) against what the rest of the system believes
 * about them.
 *
 *  - A new column on Customer, Branch, User, Route, Region or Attachment fails
 *    here until someone decides whether its changes are history (watched) or
 *    not: the same control the personal-data inventory is
 *    (tests/unit/pii-classification.test.ts).
 *  - Each capture trigger's WHEN clause and its function's changedFields list
 *    name the same columns, so a watched column always says what changed. When
 *    a later migration replaces a function or a trigger, its LAST definition is
 *    the one checked.
 *  - No personal value is stored: the history tables have no column for one.
 *  - lib/history-tables.ts (read by app-role, restore-verify, /status, /api/health
 *    and the e2e clean-up) names exactly the triggers and functions created.
 *  - The baseline is written before the insert guards exist, under its
 *    migration's own source, for every table.
 *  - Gap 19: every CustomerEdit column is either frozen once a request is sent
 *    (the evidence guard compares it) or deliberately left movable.
 *
 * Structural, per CLAUDE.md: SQL comments are stripped first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrismaSchema, storedFields } from '@/lib/compliance/prisma-schema';
import {
  APPEND_ONLY_APP_TABLES,
  CAPTURED_TABLES,
  EVIDENCE_TRIGGERS,
  GUARD_FUNCTIONS,
  HISTORY_DEFINER_FUNCTIONS,
  HISTORY_FUNCTIONS,
  HISTORY_MIGRATIONS,
  HISTORY_TABLES,
  HISTORY_TRIGGERS,
} from '@/lib/history-tables';

const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const MIGRATION_SQL: Record<string, string> = Object.fromEntries(
  HISTORY_MIGRATIONS.map((m) => [m, strip(readFileSync(`prisma/migrations/${m}/migration.sql`, 'utf8'))])
);
const [A, B] = HISTORY_MIGRATIONS;
/** Both migrations, in order: a later definition comes after an earlier one. */
const SQL = HISTORY_MIGRATIONS.map((m) => MIGRATION_SQL[m]!).join('\n');
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
    'mergedIntoId',
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
  // Where a photo is, what it is, whether it was removed, and its fingerprint.
  Attachment: ['kind', 'customerId', 'branchId', 'branchExtraId', 'editId', 'deletedAt', 'hash'],
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
  // Set once at upload and never changed (who and when are copied as values);
  // where the photo was taken is personal and never copied.
  Attachment: [
    'id',
    'r2Key',
    'mimeType',
    'bytes',
    'width',
    'height',
    'capturedById',
    'capturedAt',
    'capturedLat',
    'capturedLng',
    'createdAt',
  ],
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
  'capturedLat',
  'capturedLng',
];

/**
 * Gap 19 (lossless paths): what a request asked for, who sent it and when, and
 * what it was decided against. Frozen once it leaves DRAFT / NEEDS_CORRECTION.
 */
const FROZEN = [
  'fieldChanges',
  'attachmentChanges',
  'submittedById',
  'submittedAt',
  'process',
  'target',
  'submitGate',
  'isReactivation',
  'isWrongRoute',
  'newRouteId',
  'paymentTermsAtSubmit',
  'approvalChain',
  'requestedCreditLimit',
  'requestedPaymentTermDays',
  'cycle',
  'branchId',
  'submissionId',
];
/** What still moves after a request is sent: its state, decision, SLA clock and customer. */
const MOVABLE = [
  'id',
  'customerId',
  'originalCustomerId',
  'state',
  'reviewedById',
  'reviewedAt',
  'decisionReason',
  'decisionCategory',
  'currentStepIndex',
  'pendingRole',
  'stageEnteredAt',
  'slaDueAt',
  'slaBreachedAt',
  'escalationLevel',
  'lastEscalatedAt',
  'createdAt',
  'updatedAt',
];

/** The body of the LAST `CREATE OR REPLACE FUNCTION <name>()`, up to its closing `$$`. */
function functionBody(name: string): string {
  const starts = [...SQL.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(`, 'g'))];
  expect(starts.length, name).toBeGreaterThan(0);
  const start = starts.at(-1)!.index!;
  const open = SQL.indexOf('$$', start);
  return SQL.slice(open + 2, SQL.indexOf('$$', open + 2));
}

/** The WHEN (...) of the LAST `CREATE TRIGGER <name>`. */
function whenClause(trigger: string): string {
  const start = SQL.lastIndexOf(`CREATE TRIGGER ${trigger}\n`);
  expect(start, trigger).toBeGreaterThan(-1);
  return SQL.slice(SQL.indexOf('WHEN', start), SQL.indexOf('EXECUTE FUNCTION', start));
}

const quoted = (text: string, prefix: string) =>
  new Set([...text.matchAll(new RegExp(`\\b${prefix}\\."([A-Za-z]+)"`, 'g'))].map((m) => m[1]!));

/** The migration that creates a table. */
const creatorOf = (table: string) =>
  HISTORY_MIGRATIONS.find((m) => MIGRATION_SQL[m]!.includes(`CREATE TABLE "${table}"`))!;

describe('history: every captured column is decided', () => {
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

  it('a replaced capture function writes every column its table has (Customer gained mergedIntoId)', () => {
    const body = functionBody('nmwc_history_customer');
    const insertCols = body.slice(body.indexOf('INSERT INTO public."CustomerHistory"'), body.indexOf('VALUES'));
    const written = [...insertCols.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!).filter((c) => c !== 'CustomerHistory');
    expect([...written].sort()).toEqual(columnsOf('CustomerHistory').filter((c) => c !== 'id').sort());
  });
});

describe('history: no personal value is stored', () => {
  it.each(HISTORY_TABLES)('%s has no column for one, in the migrations or the schema', (table) => {
    const ddl = SQL.slice(
      SQL.indexOf(`CREATE TABLE "${table}"`),
      SQL.indexOf(');', SQL.indexOf(`CREATE TABLE "${table}"`))
    );
    expect(ddl.length).toBeGreaterThan(100);
    const added = [
      ...SQL.matchAll(new RegExp(`ALTER TABLE "${table}" ADD COLUMN\\s+"([A-Za-z]+)"`, 'g')),
    ].map((m) => m[1]!);
    const sqlCols = [...[...ddl.matchAll(/^\s+"([A-Za-z]+)"/gm)].map((m) => m[1]!), ...added];
    expect(sqlCols.filter((c) => PERSONAL.includes(c))).toEqual([]);
    expect(columnsOf(table).filter((c) => PERSONAL.includes(c))).toEqual([]);
    // The table in the migrations is the table in schema.prisma, column for column.
    expect([...sqlCols].sort()).toEqual([...columnsOf(table)].sort());
  });
});

describe('history: lib/history-tables.ts is the migrations', () => {
  it('names exactly the triggers they create', () => {
    const created = new Set(
      [...SQL.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_]+)/g)].map((m) => m[1]!)
    );
    expect([...created].sort()).toEqual([...new Set(HISTORY_TRIGGERS)].sort());
    expect(HISTORY_TRIGGERS.length, 'no trigger named twice').toBe(new Set(HISTORY_TRIGGERS).size);
  });

  it('a trigger created twice was dropped in between (a replacement, not a duplicate)', () => {
    for (const name of HISTORY_TRIGGERS) {
      const creates = [...SQL.matchAll(new RegExp(`CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+${name}\\b`, 'g'))];
      const drops = [...SQL.matchAll(new RegExp(`DROP TRIGGER (?:IF EXISTS )?${name}\\b`, 'g'))];
      expect(creates.length - drops.length, name).toBe(1);
    }
  });

  it('names exactly the functions they create', () => {
    const created = new Set([...SQL.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]!));
    expect([...created].sort()).toEqual([...HISTORY_FUNCTIONS].sort());
    const definers = new Set(
      [...SQL.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\([^$]*?SECURITY DEFINER/g)].map((m) => m[1]!)
    );
    expect([...definers].sort()).toEqual([...HISTORY_DEFINER_FUNCTIONS].sort());
  });

  it('revokes EXECUTE from PUBLIC on every definer-rights and guard function', () => {
    for (const f of [...HISTORY_DEFINER_FUNCTIONS, ...GUARD_FUNCTIONS]) {
      expect(SQL, f).toContain(`REVOKE EXECUTE ON FUNCTION ${f}() FROM PUBLIC`);
    }
  });

  it('takes INSERT, UPDATE and every sequence privilege of every history table from the runtime role', () => {
    const blocks = [...SQL.matchAll(/DO \$\$([\s\S]*?)END;\n\$\$;/g)].map((m) => m[1]!).join('\n');
    for (const t of HISTORY_TABLES) {
      expect(blocks, t).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\\s\\S]*?"${t}"`));
      expect(blocks, t).toContain(`"${t}_id_seq"`);
    }
  });

  it('the application ledgers are insert-only for the runtime role', () => {
    const block = MIGRATION_SQL[B]!.slice(MIGRATION_SQL[B]!.indexOf('DO $$\nBEGIN\n  IF EXISTS'));
    for (const t of APPEND_ONLY_APP_TABLES) {
      expect(block, t).toMatch(new RegExp(`REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON [^;]*"${t}"`));
    }
    expect(block).toContain('REVOKE UPDATE ON SEQUENCE "EditRevision_id_seq" FROM nmwc_app');
  });
});

describe('history: the first page', () => {
  it.each(HISTORY_TABLES)(
    '%s gets a BASELINE under its migration’s own source, before its insert guard exists',
    (table) => {
      const m = creatorOf(table);
      const sql = MIGRATION_SQL[m]!;
      const baseline = sql.indexOf(`INSERT INTO "${table}"`);
      const guard = sql.indexOf(`CREATE TRIGGER ${table.toLowerCase()}_insert_guard`);
      expect(baseline, 'baseline insert').toBeGreaterThan(-1);
      expect(guard, 'insert guard').toBeGreaterThan(baseline);
      const stmt = sql.slice(baseline, sql.indexOf(';', baseline));
      expect(stmt).toContain("'BASELINE'");
      expect(stmt).toContain(`'migration:${m}'`);
    }
  );

  it('part A locks the master tables first, and its capture triggers come after every baseline row', () => {
    const sql = MIGRATION_SQL[A]!;
    const lock = sql.indexOf(
      'LOCK TABLE "Customer", "Branch", "User", "Route", "Region", "_ManagerRegions" IN SHARE ROW EXCLUSIVE MODE'
    );
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sql.indexOf('CREATE TABLE'));
    const own = HISTORY_TABLES.filter((t) => creatorOf(t) === A);
    const lastBaseline = Math.max(...own.map((t) => sql.indexOf(`INSERT INTO "${t}"`)));
    expect(sql.indexOf('CREATE TRIGGER customer_history_capture')).toBeGreaterThan(lastBaseline);
    expect(sql.trimEnd().endsWith('RESET lock_timeout;')).toBe(true);
  });

  it('part B locks Attachment before its baseline, and creates its capture triggers after it', () => {
    const sql = MIGRATION_SQL[B]!;
    const lock = sql.indexOf('LOCK TABLE "Attachment" IN SHARE ROW EXCLUSIVE MODE');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.indexOf('CREATE TRIGGER attachment_history_capture')).toBeGreaterThan(
      sql.indexOf('INSERT INTO "AttachmentHistory"')
    );
    expect(sql.trimEnd().endsWith('RESET lock_timeout;')).toBe(true);
  });

  it('part B fills mergedIntoId only after the replaced trigger can see it, under its own source', () => {
    const sql = MIGRATION_SQL[B]!;
    const trigger = sql.indexOf('CREATE TRIGGER customer_history_capture_upd');
    const backfill = sql.indexOf('SET "mergedIntoId" = m.winner_id');
    expect(trigger).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(trigger);
    const block = sql.slice(sql.lastIndexOf('DO $$', backfill), backfill);
    expect(block).toContain("set_config('nmwc.source', 'migration:20261014100000_lossless_paths', true)");
    expect(block).toContain("set_config('nmwc.effective_from'");
  });
});

describe('gap 19: a request, once sent, is evidence', () => {
  it('every CustomerEdit column is frozen or deliberately movable', () => {
    const cols = columnsOf('CustomerEdit');
    const decided = new Set([...FROZEN, ...MOVABLE]);
    expect(cols.filter((c) => !decided.has(c)), 'decide each new CustomerEdit column here and in the guard').toEqual([]);
    expect([...decided].filter((c) => !cols.includes(c)), 'columns that no longer exist').toEqual([]);
  });

  it('the evidence guard compares exactly the frozen columns', () => {
    const body = functionBody('nmwc_customeredit_evidence_guard');
    const compared = new Set([...body.matchAll(/NEW\."([A-Za-z]+)" IS DISTINCT FROM OLD\."\1"/g)].map((m) => m[1]!));
    expect([...compared].sort()).toEqual([...FROZEN].sort());
    // Open states stay editable; the owner's maintenance window is the only way past.
    expect(body).toContain(`IF OLD."state" IN ('DRAFT', 'NEEDS_CORRECTION') THEN`);
    expect(body).toMatch(/nmwc\.audit_maintenance[\s\S]*session_user = owner_name/);
  });

  it('runs on every update, and deletes and truncates go through the ledger guard', () => {
    const sql = MIGRATION_SQL[B]!;
    expect(sql).toMatch(/CREATE TRIGGER customeredit_evidence_guard\s+BEFORE UPDATE ON "CustomerEdit"\s+FOR EACH ROW/);
    expect(sql).toMatch(/CREATE TRIGGER customeredit_no_delete BEFORE DELETE ON "CustomerEdit" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation\(\)/);
    expect(sql).toMatch(/CREATE TRIGGER customeredit_no_truncate BEFORE TRUNCATE ON "CustomerEdit" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation\(\)/);
    for (const t of APPEND_ONLY_APP_TABLES) {
      expect(sql).toContain(`CREATE TRIGGER ${t.toLowerCase()}_append_only BEFORE UPDATE OR DELETE ON "${t}" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation()`);
    }
    expect(EVIDENCE_TRIGGERS.every((t) => HISTORY_TRIGGERS.includes(t))).toBe(true);
  });
});

describe('history: the operator checks know about it', () => {
  const stripTs = (f: string) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('app-role `grant` takes the history back from the runtime role AFTER its blanket GRANT', () => {
    const src = stripTs('scripts/ops/app-role.ts');
    const blanket = src.indexOf('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public');
    const sequences = src.indexOf('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public');
    const tables = src.indexOf(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "${t}"'
    );
    const seqs = src.indexOf('REVOKE ALL ON SEQUENCE "${historySequence(t)}"');
    const exec = src.indexOf('REVOKE EXECUTE ON FUNCTION ${f}() FROM PUBLIC');
    const ledgers = src.indexOf('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "${t}"');
    for (const [label, at] of Object.entries({ blanket, sequences, tables, seqs, exec, ledgers }))
      expect(at, label).toBeGreaterThan(-1);
    expect(tables).toBeGreaterThan(blanket);
    expect(seqs).toBeGreaterThan(sequences);
    expect(ledgers).toBeGreaterThan(blanket);
    // Probed by `verify` and reported by `status`.
    expect(src).toMatch(/history capture: expected/);
    expect(src).toMatch(/history tables: read-only for/);
    expect(src).toMatch(/insert-only ledgers/);
  });

  it('restore-verify expects every history trigger, and the runtime role to hold SELECT only on the history', () => {
    const src = stripTs('scripts/ops/restore-verify.ts');
    expect(src).toMatch(/\.\.\.HISTORY_TRIGGERS,/);
    expect(src).toMatch(/HISTORY_TABLES\.map\(\(t\) => \[t, \['SELECT'\]\]\)/);
    expect(src).toMatch(/APPEND_ONLY_APP_TABLES\.map\(\(t\) => \[t, \['SELECT', 'INSERT'\]\]\)/);
    expect(src).toMatch(/'F-03'/);
    expect(src).toMatch(/'F-04'/);
  });
});
