// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — migration 20261110110000_request_reason,
 * read as text (structural: comments stripped first, per CLAUDE.md).
 *
 * The migration must be ADDITIVE and must copy only what is unambiguous:
 *
 *  - one nullable column, and nothing else changed on any table;
 *  - three back-fill updates that write requestReason only, only where it is
 *    still NULL, only on close / reactivation requests, and never touch
 *    decisionReason — so every request in flight reads as it did;
 *  - the back-fill runs BEFORE the evidence guard is replaced (while the column is
 *    not yet frozen), and uses no maintenance bypass;
 *  - the evidence guard is its last definition plus ONE comparison line: every
 *    rule it had, it still has.
 *
 * The rows themselves are proven on Postgres by
 * tests/integration/request-reason-migration.test.ts (RUN_REQUEST_REASON_MIGRATION=1).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HISTORY_MIGRATIONS } from '@/lib/history-tables';
import { EXPECTED_FUNCTIONS } from '@/lib/integrity/expected';
import { MERGE_CLOSED_PREFIX } from '@/lib/request-reasons';
import { parsePrismaSchema, storedFields } from '@/lib/compliance/prisma-schema';
import { functionShapes } from '../support/migration-sql';

const NAME = '20261110110000_request_reason';
const PREVIOUS = '20261025090100_request_scope_at_submit';
const read = (m: string) => readFileSync(`prisma/migrations/${m}/migration.sql`, 'utf8').replace(/\r\n/g, '\n');

/** `--` comments removed, outside the dollar-quoted body only. */
function stripLineComments(sql: string): string {
  let out = '';
  let inBody = false;
  for (const line of sql.split('\n')) {
    let kept = line;
    if (!inBody) {
      const at = line.indexOf('--');
      if (at >= 0) kept = line.slice(0, at);
    }
    if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1) inBody = !inBody;
    out += `${kept}\n`;
  }
  return out;
}

const RAW = read(NAME);
const SQL = stripLineComments(RAW);
const FN = 'CREATE OR REPLACE FUNCTION nmwc_customeredit_evidence_guard()';

/** The function's body: the text between its dollar quotes. */
function guardBody(sql: string): string {
  const start = sql.lastIndexOf(FN);
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', start);
  return sql.slice(open + 2, sql.indexOf('$$', open + 2));
}

/** Everything before the function: the DDL and the back-fill. */
const BEFORE_FN = SQL.slice(0, SQL.indexOf(FN));
const statements = BEFORE_FN.split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean);
const updates = statements.filter((s) => s.startsWith('UPDATE '));

describe('migration 20261110110000_request_reason is additive', () => {
  it('adds exactly one nullable column, and changes no other table', () => {
    const ddl = statements.filter((s) => /^(ALTER|CREATE|DROP|TRUNCATE|DELETE|INSERT|GRANT)\b/.test(s));
    expect(ddl).toEqual(['ALTER TABLE "CustomerEdit" ADD COLUMN "requestReason" TEXT']);
    expect(SQL).not.toMatch(/\bNOT NULL\b/);
    expect(SQL).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
  });

  it('is in step with schema.prisma (CI’s drift gate): a nullable text column on CustomerEdit', () => {
    const field = storedFields(parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'))).find(
      (f) => f.model === 'CustomerEdit' && f.name === 'requestReason'
    );
    expect(field).toBeDefined();
    expect(readFileSync('prisma/schema.prisma', 'utf8')).toMatch(/^\s*requestReason\s+String\?\s+@db\.Text\s*$/m);
  });

  it('waits at most ten seconds for a lock, and puts the setting back', () => {
    expect(statements[0]).toBe("SET lock_timeout = '10s'");
    expect(SQL.trimEnd().endsWith('RESET lock_timeout;')).toBe(true);
  });

  it('has LF line endings (the body’s MD5 is taken as Postgres stores it)', () => {
    expect(readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8')).not.toContain('\r');
  });
});

describe('the back-fill copies only what is unambiguous', () => {
  it('is three updates, after the column and before the guard is replaced', () => {
    expect(updates).toHaveLength(3);
    const column = SQL.indexOf('ADD COLUMN "requestReason" TEXT');
    const first = SQL.indexOf('UPDATE "CustomerEdit"');
    const last = SQL.lastIndexOf('UPDATE "CustomerEdit"');
    expect(column).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(column);
    expect(last).toBeLessThan(SQL.indexOf(FN));
    // Nothing is updated after the guard: the column is frozen from there on.
    expect(SQL.slice(SQL.indexOf(FN))).not.toMatch(/\bUPDATE\s+"/);
  });

  it.each([0, 1, 2])('update %i writes requestReason only, where it is still NULL, on close / reactivation requests', (i) => {
    const u = updates[i]!;
    expect(u).toMatch(/^UPDATE "CustomerEdit"( e)? SET "requestReason" = /);
    // One SET target: requestReason. decisionReason is read (the right-hand side), never written.
    const set = u.slice(u.indexOf(' SET ') + 5, / (FROM|WHERE) /.exec(u)!.index);
    expect(set).toMatch(/^"requestReason" = (s\.reason|"decisionReason"|e\."decisionReason")$/);
    expect(u.match(/ SET /g)).toHaveLength(1);
    expect(u).toMatch(/"requestReason" IS NULL/);
    expect(u).toMatch(/"target" = 'BRANCH'/);
  });

  it('2a: from the sealed CREATE row in the ledger — its first one, a non-blank string', () => {
    const u = updates[0]!;
    expect(u).toContain('FROM "AuditLog" a');
    expect(u).toContain(`a."entityType" = 'CustomerEdit'`);
    expect(u).toContain(`a."action" = 'CREATE'`);
    expect(u).toContain(`jsonb_typeof(a."after"->'requestReason') = 'string'`);
    expect(u).toContain(`btrim(a."after"->>'requestReason') <> ''`);
    expect(u).toContain('SELECT DISTINCT ON (a."entityId")');
    expect(u).toContain('ORDER BY a."entityId", a."at", a."id"');
  });

  it('2b: still waiting, or approved — the states no overwriting writer leaves a row in', () => {
    const u = updates[1]!;
    expect(u).toContain(`"state" IN ('SUBMITTED', 'APPROVED')`);
    expect(u).toContain(`btrim(coalesce("decisionReason", '')) <> ''`);
    expect(u).not.toContain('NEEDS_CORRECTION');
  });

  it('2c: refused with its own REJECTED decision row, and never a merge’s sentence', () => {
    const u = updates[2]!;
    expect(u).toContain(`e."state" = 'REJECTED'`);
    expect(u).toMatch(/EXISTS \( SELECT 1 FROM "EditApproval" d WHERE d\."editId" = e\."id" AND d\."decision" = 'REJECTED'\)/);
    // The sentence the application knows a merge's note by (lib/request-reasons.ts).
    expect(u).toContain(`e."decisionReason" NOT LIKE '${MERGE_CLOSED_PREFIX}%'`);
  });

  it('no update reaches a NEEDS_CORRECTION row, an update or a new-customer request', () => {
    for (const u of updates) {
      expect(u).not.toContain('NEEDS_CORRECTION');
      expect(u).not.toContain(`'CUSTOMER'`);
      // The request's kind is told by its target, never widened by process or state.
      expect(u).not.toContain('"process"');
      expect(u).not.toContain(`'DRAFT'`);
    }
  });

  it('uses no maintenance bypass: the column is not frozen until the guard below', () => {
    expect(BEFORE_FN).not.toContain('audit_maintenance');
    expect(BEFORE_FN).not.toContain('set_config');
    expect(BEFORE_FN).not.toMatch(/DISABLE\s+TRIGGER|session_replication_role/i);
  });
});

describe('the evidence guard is its last definition plus one line', () => {
  const ADDED = `    IF NEW."requestReason" IS DISTINCT FROM OLD."requestReason" THEN changed := changed || 'requestReason'::text; END IF;\n`;

  it('old body + the requestReason comparison = new body', () => {
    const before = guardBody(read(PREVIOUS));
    const after = guardBody(RAW);
    expect(after.split(ADDED)).toHaveLength(2);
    expect(after.replace(ADDED, '')).toBe(before);
    // And it sits with the other "where it was raised" columns, inside the frozen branch.
    const anchor = `    IF NEW."regionIdsAtSubmit" IS DISTINCT FROM OLD."regionIdsAtSubmit" THEN changed := changed || 'regionIdsAtSubmit'::text; END IF;\n`;
    expect(after).toContain(anchor + ADDED);
  });

  it('keeps its language, its pinned search_path and its revoked EXECUTE', () => {
    const fn = SQL.slice(SQL.indexOf(FN));
    expect(fn).toMatch(/RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = pg_catalog, public, pg_temp\s+AS \$\$/);
    expect(fn).toContain('REVOKE EXECUTE ON FUNCTION nmwc_customeredit_evidence_guard() FROM PUBLIC;');
    expect(fn).not.toMatch(/SECURITY\s+DEFINER/i);
    // Defined once here; no trigger is created, dropped or re-pointed.
    expect(SQL.split(FN)).toHaveLength(2);
    expect(SQL).not.toMatch(/CREATE\s+TRIGGER|DROP\s+TRIGGER|ALTER\s+TRIGGER/i);
  });

  it('the nightly integrity check expects exactly this body', () => {
    const shape = functionShapes(['nmwc_customeredit_evidence_guard']).nmwc_customeredit_evidence_guard!;
    expect(EXPECTED_FUNCTIONS.nmwc_customeredit_evidence_guard).toEqual(shape);
    expect(shape.searchPath).toBe('pg_catalog, public, pg_temp');
  });

  it('is the last history migration (lib/history-tables.ts), so every reader of the guard reads this one', () => {
    expect(HISTORY_MIGRATIONS.at(-1)).toBe(NAME);
    expect(HISTORY_MIGRATIONS.at(-2)).toBe(PREVIOUS);
  });
});
