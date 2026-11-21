// @vitest-environment node
/**
 * The daily Temix import, stage 1: migration 20261114100000_temix_daily_tables
 * against lib/temix-daily-tables.ts, prisma/schema.prisma and CI.
 *
 *  - it creates exactly the six tables the list names, each a Prisma model;
 *  - it changes no existing table but PurgeSummary's rule CHECK (the customer
 *    import, Customer, Branch, the history and AuditLog are not touched);
 *  - the ledgers are INSERT-only exactly as AuditLog and the history are: the
 *    same nmwc_forbid_audit_mutation on UPDATE, DELETE and TRUNCATE, and the
 *    runtime role may insert and read only, with sequences it cannot set;
 *  - the triggers and functions are exactly the list's, each function pins its
 *    search_path and none has definer rights;
 *  - the CHECKs name exactly the list's kinds and actions, and STATUS_DIFFERS
 *    is not a "listed once" kind (the owner's question);
 *  - the partial indexes are named in CI's drift allowlist;
 *  - (review of stage 1) a staged row keeps its file, number and done outcome;
 *    a finished file never changes; the route map is written under READ
 *    COMMITTED only; and the nightly checks, the restore check and
 *    `app-role.ts verify` all watch the module's triggers and privileges.
 *
 * Structural, per CLAUDE.md: SQL comments are stripped first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrismaSchema, storedFields } from '@/lib/compliance/prisma-schema';
import {
  TEMIX_CHANGE_KINDS,
  TEMIX_DAILY_FUNCTIONS,
  TEMIX_DAILY_LEDGERS,
  TEMIX_DAILY_MIGRATION,
  TEMIX_DAILY_NO_DELETE,
  TEMIX_DAILY_PROTECTION_TRIGGERS,
  TEMIX_DAILY_RAW_INDEXES,
  TEMIX_DAILY_STAGING,
  TEMIX_DAILY_STAMPED,
  TEMIX_DAILY_TABLES,
  TEMIX_DAILY_TRIGGERS,
  TEMIX_NOTICE_SEEN_KINDS,
  TEMIX_ROUTE_MAP_ACTIONS,
} from '@/lib/temix-daily-tables';
import { APPEND_ONLY_APP_TABLES, HISTORY_TABLES, PROTECTION_TRIGGERS } from '@/lib/history-tables';
import { EXPECTED_FUNCTIONS, TRIGGER_BINDINGS } from '@/lib/integrity/expected';
import { functionShapes, migrationsInOrder, triggerBindings } from '../support/migration-sql';

/** `--` comments removed outside dollar-quoted bodies. */
function strip(sql: string): string {
  let out = '';
  let inBody = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inBody = !inBody;
      out += '$$';
      i += 1;
      continue;
    }
    if (!inBody && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl - 1;
      continue;
    }
    out += sql[i];
  }
  return out;
}

const RAW = readFileSync(`prisma/migrations/${TEMIX_DAILY_MIGRATION}/migration.sql`, 'utf8').replace(/\r\n/g, '\n');
const SQL = strip(RAW);
const ONE = [{ name: TEMIX_DAILY_MIGRATION, sql: RAW }];
const schema = parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'));
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The quoted names in the IN (...) list of a named CHECK. */
const checkList = (name: string): string[] => {
  const at = SQL.indexOf(`"${name}"`);
  expect(at, name).toBeGreaterThan(-1);
  const stmt = SQL.slice(at, SQL.indexOf(';', at));
  return [...stmt.slice(stmt.indexOf(' IN (')).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
};

describe('the daily Temix tables: what the migration creates', () => {
  it('is the newest migration, and comes after the customer import’s last one', () => {
    const names = migrationsInOrder().map((m) => m.name);
    expect(names).toContain(TEMIX_DAILY_MIGRATION);
    expect(names.indexOf(TEMIX_DAILY_MIGRATION)).toBeGreaterThan(names.indexOf('20261111120000_import_shop_notice_ack'));
  });

  it('creates exactly the six tables of the list, each a Prisma model', () => {
    const created = [...SQL.matchAll(/CREATE TABLE "([A-Za-z]+)"/g)].map((m) => m[1]!);
    expect(created).toEqual([...TEMIX_DAILY_TABLES]);
    for (const t of TEMIX_DAILY_TABLES) expect(schema.models, t).toContain(t);
    expect(schema.enums).toEqual(expect.arrayContaining(['TemixDailyFileState', 'TemixDailyRowOutcome']));
  });

  it('changes no existing table but PurgeSummary’s rule CHECK', () => {
    const ours = new Set<string>(TEMIX_DAILY_TABLES);
    const touched = new Set<string>();
    for (const m of SQL.matchAll(/(?:ALTER TABLE|ON|INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?|REFERENCES|LOCK TABLE)\s+"([A-Za-z_]+)"/g))
      touched.add(m[1]!);
    const foreign = [...touched].filter((t) => !ours.has(t)).sort();
    // References into User and Route (both kept, unchanged); PurgeSummary's CHECK replaced.
    expect(foreign).toEqual(['PurgeSummary', 'Route', 'User']);
    const onPurge = [...SQL.matchAll(/ALTER TABLE "PurgeSummary"([^;]*);/g)].map((m) => ws(m[1]!));
    expect(onPurge).toHaveLength(2);
    expect(onPurge[0]).toBe('DROP CONSTRAINT "PurgeSummary_rule_check"');
    expect(onPurge[1]).toMatch(/^ADD CONSTRAINT "PurgeSummary_rule_check" CHECK \("rule" IN \(/);
    expect(SQL).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO)\s+"?(Customer|Branch|ImportBatch|ImportRow|AuditLog)\b/);
    expect(SQL).not.toMatch(/"(ImportBatch|ImportRow|Customer|Branch)"/);
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|TRIGGER|FUNCTION|TYPE)\b/i);
  });

  it('sets and resets its lock timeout', () => {
    expect(SQL.trimStart().startsWith("SET lock_timeout = '10s';")).toBe(true);
    expect(SQL.trimEnd().endsWith('RESET lock_timeout;')).toBe(true);
  });

  it('has no foreign key into Customer or Branch (ids are kept as values, as in the history)', () => {
    for (const t of ['TemixDailyRow', 'TemixChange', 'TemixNoticeSeen']) {
      const fields = storedFields(schema).filter((f) => f.model === t).map((f) => f.name);
      expect(fields, t).toContain('customerId');
    }
    expect(SQL).not.toMatch(/REFERENCES "(Customer|Branch)"/);
  });
});

describe('the ledgers are INSERT-only, like AuditLog and the history', () => {
  const bindings = triggerBindings(ONE);

  it('the triggers are exactly the list’s, each on its own table', () => {
    const want = Object.entries(TEMIX_DAILY_TRIGGERS).flatMap(([t, names]) => names.map((n) => [n, t] as const));
    expect(Object.keys(bindings).sort()).toEqual(want.map(([n]) => n).sort());
    for (const [n, t] of want) expect(bindings[n]!.table, n).toBe(t);
  });

  it.each([...TEMIX_DAILY_LEDGERS])('%s: UPDATE, DELETE and TRUNCATE go through nmwc_forbid_audit_mutation', (t) => {
    const l = t.toLowerCase();
    expect(SQL).toContain(`CREATE TRIGGER ${l}_append_only BEFORE UPDATE OR DELETE ON "${t}" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation()`);
    expect(SQL).toContain(`CREATE TRIGGER ${l}_no_truncate BEFORE TRUNCATE ON "${t}" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation()`);
    // A BIGSERIAL id, like the application's other ledgers.
    expect(SQL).toMatch(new RegExp(`CREATE TABLE "${t}" \\(\\s+"id" BIGSERIAL NOT NULL`));
  });

  it('the files are never deleted, by the same guard', () => {
    for (const t of TEMIX_DAILY_NO_DELETE) {
      const l = t.toLowerCase();
      expect(SQL).toContain(`CREATE TRIGGER ${l}_no_delete BEFORE DELETE ON "${t}" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation()`);
      expect(SQL).toContain(`CREATE TRIGGER ${l}_no_truncate BEFORE TRUNCATE ON "${t}" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation()`);
    }
    // The staging rows are not a ledger: their payload is emptied by the retention
    // rule, so no DELETE or TRUNCATE guard, only the row guard (insert, update).
    const onRow = [...SQL.matchAll(/CREATE TRIGGER ([a-z_]+)\s+BEFORE ([A-Z ]+?) ON "TemixDailyRow"/g)].map((m) => [m[1], m[2]]);
    expect(onRow).toEqual([['temixdailyrow_guard', 'INSERT OR UPDATE']]);
  });

  it('the stamped ones carry their writer’s source and transaction, as AuditLog does', () => {
    for (const t of TEMIX_DAILY_STAMPED) {
      expect(bindings[`${t.toLowerCase()}_stamp_context`], t).toEqual({ table: t, fn: 'nmwc_auditlog_stamp_context' });
      const cols = storedFields(schema).filter((f) => f.model === t).map((f) => f.name);
      expect(cols, t).toEqual(expect.arrayContaining(['source', 'txId']));
    }
  });

  it('the runtime role: insert and read on the ledgers, never update, delete or setval', () => {
    const block = ws(/DO \$\$\nBEGIN\n {2}IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'nmwc_app'\) THEN([\s\S]*?)END;\n\$\$;/.exec(SQL)?.[1] ?? '');
    const list = TEMIX_DAILY_LEDGERS.map((t) => `"${t}"`).join(', ');
    const seqs = TEMIX_DAILY_LEDGERS.map((t) => `"${t}_id_seq"`).join(', ');
    expect(block).toContain(`GRANT SELECT, INSERT ON ${list} TO nmwc_app;`);
    expect(block).toContain(`REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ${list} FROM nmwc_app;`);
    expect(block).toContain(`GRANT USAGE, SELECT ON SEQUENCE ${seqs} TO nmwc_app;`);
    expect(block).toContain(`REVOKE UPDATE ON SEQUENCE ${seqs} FROM nmwc_app;`);
    expect(block).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TemixDailyFile", "TemixDailyRow" FROM nmwc_app;');
  });

  it('app-role `grant` takes UPDATE and DELETE back on the ledgers after its blanket GRANT', () => {
    const src = readFileSync('scripts/ops/app-role.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const blanket = src.indexOf('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public');
    const revoke = src.indexOf('...temixLedgers.map((t) => `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "${t}" FROM "${ROLE}"`)');
    const seqs = src.indexOf('...temixLedgers.map((t) => `REVOKE UPDATE ON SEQUENCE "${t}_id_seq" FROM "${ROLE}"`)');
    expect(blanket).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(blanket);
    expect(seqs).toBeGreaterThan(blanket);
    expect(src).toMatch(/TEMIX_DAILY_LEDGERS/);
  });

  it('kept apart from the seal’s ledger list for now (a later step)', () => {
    for (const t of TEMIX_DAILY_TABLES) {
      expect(APPEND_ONLY_APP_TABLES as readonly string[]).not.toContain(t);
      expect(HISTORY_TABLES as readonly string[]).not.toContain(t);
    }
  });
});

/** A TypeScript source with its comments removed. */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('watched although not sealed (review of stage 1)', () => {
  it('every trigger of the module is a protection trigger the nightly check expects, with its function’s body', () => {
    expect([...TEMIX_DAILY_PROTECTION_TRIGGERS].sort()).toEqual(Object.values(TEMIX_DAILY_TRIGGERS).flat().sort());
    for (const t of TEMIX_DAILY_PROTECTION_TRIGGERS) {
      expect(PROTECTION_TRIGGERS, t).toContain(t);
      expect(TRIGGER_BINDINGS[t], t).toBeDefined();
    }
    for (const f of TEMIX_DAILY_FUNCTIONS) expect(EXPECTED_FUNCTIONS[f], f).toBeDefined();
  });

  it('the nightly runtime-role check counts the ledgers, their sequences and the files’ DELETE', () => {
    const src = code('lib/integrity/checks.ts');
    const at = src.indexOf(`id: 'runtime-role-privileges'`);
    const check = src.slice(at, src.indexOf(`id: 'app-login-is-runtime-role'`));
    expect(check).toMatch(/const ledgers = \[[^\]]*\.\.\.TEMIX_DAILY_LEDGERS\]/);
    expect(check).toContain(`...TEMIX_DAILY_STAGING.flatMap((t) => ['DELETE', 'TRUNCATE']`);
    expect(check).toMatch(/const sequences = \[[^\]]*\.\.\.TEMIX_DAILY_LEDGERS\]\.map\(historySequence\)/);
    expect([...TEMIX_DAILY_STAGING]).toEqual(['TemixDailyFile', 'TemixDailyRow']);
  });

  it('the restore check knows the triggers (its self-check) and the privilege matrix (R-02)', () => {
    const src = code('scripts/ops/restore-verify.ts');
    const start = src.indexOf('const EXPECTED_TRIGGERS = [');
    const list = src.slice(start, src.indexOf('];', start));
    expect(list).toContain('...TEMIX_DAILY_PROTECTION_TRIGGERS,');
    expect(src).toContain(`...Object.fromEntries(TEMIX_DAILY_LEDGERS.map((t) => [t, ['SELECT', 'INSERT']])),`);
    expect(src).toContain(`...Object.fromEntries(TEMIX_DAILY_STAGING.map((t) => [t, ['SELECT', 'INSERT', 'UPDATE']])),`);
  });

  it('app-role verify probes them: no UPDATE or DELETE on a ledger, no setval, no DELETE on a file or row', () => {
    const src = code('scripts/ops/app-role.ts');
    const verify = src.slice(src.indexOf('async function verify()'));
    expect(verify).toContain('const temixLedgers = await temixLedgersPresent(app);');
    for (const probe of [
      '`${t} UPDATE by ACL (zero rows)`, () =>\n                tx.$executeRawUnsafe(`UPDATE "${t}" SET "id" = "id" WHERE false`)',
      '`${t} sequence setval`, () =>\n                tx.$queryRawUnsafe(`SELECT setval(\'"${t}_id_seq"\', 1)::text AS v`)',
      'for (const t of TEMIX_DAILY_STAGING) {',
    ]) {
      expect(verify, probe).toContain(probe);
    }
  });
});

describe('the functions', () => {
  it('are exactly the list’s; each pins its search_path and none has definer rights', () => {
    const created = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION ([a-z0-9_]+)\(/g)].map((m) => m[1]!);
    expect(created.sort()).toEqual([...TEMIX_DAILY_FUNCTIONS].sort());
    const shapes = functionShapes([...TEMIX_DAILY_FUNCTIONS], ONE);
    for (const f of TEMIX_DAILY_FUNCTIONS) {
      expect(shapes[f], f).toMatchObject({ securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' });
    }
  });

  it('the file guard: no future load day, born STAGED, a fixed identity, a finished file never changes', () => {
    const body = /FUNCTION nmwc_temix_daily_file_guard\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL)![1]!;
    const b = ws(body);
    expect(body).toContain(`NEW."loadDay" > (clock_timestamp() AT TIME ZONE 'Asia/Muscat')::date`);
    expect(b).toContain(`IF TG_OP = 'INSERT' THEN IF NEW."state" <> 'STAGED' THEN`);
    const identity = body.slice(body.indexOf('IF NEW."id" IS DISTINCT'), body.indexOf('OLD."state" IN'));
    const fixed = [...identity.matchAll(/NEW\."([A-Za-z0-9]+)" IS DISTINCT FROM OLD\."\1"/g)].map((m) => m[1]!).sort();
    // loadDay among them: it is fixed when the file is staged (the plan's data model).
    expect(fixed).toEqual(['fileBytes', 'fileSha256', 'filename', 'headings', 'id', 'loadDay', 'uploadedAt', 'uploadedById']);
    // A finished file: its state stays, and then the whole row stays (who
    // discarded it and why, loadedAt, appliedBy, the counts, the reversal tick).
    expect(b).toContain(
      `IF OLD."state" IN ('LOADED', 'DISCARDED') THEN IF NEW."state" IS DISTINCT FROM OLD."state" THEN RAISE EXCEPTION 'TemixDailyFile: a % file stays %'`
    );
    expect(b).toContain(`IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'TemixDailyFile: a % file is final; nothing about it changes'`);
    expect(b).toContain(`IF NEW."state" = 'LOADED' AND OLD."state" IS DISTINCT FROM 'LOADED' AND OLD."state" <> 'FINALIZING' THEN`);
    expect(b).toContain(
      `IF OLD."reversalAckAt" IS NOT NULL AND (NEW."reversalAckAt" IS DISTINCT FROM OLD."reversalAckAt" OR NEW."reversalAckById" IS DISTINCT FROM OLD."reversalAckById") THEN`
    );
    expect(SQL).toMatch(/CREATE TRIGGER temixdailyfile_identity_guard\s+BEFORE INSERT OR UPDATE ON "TemixDailyFile"/);
  });

  it('the row guard: added only to a STAGED file; file, number and creation time fixed; a done row stays done', () => {
    const body = /FUNCTION nmwc_temix_daily_row_guard\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL)![1]!;
    const b = ws(body);
    expect(b).toContain(
      `SELECT f."state"::text INTO file_state FROM public."TemixDailyFile" f WHERE f."id" = NEW."fileId"; IF file_state IS DISTINCT FROM 'STAGED' THEN`
    );
    const idAt = body.indexOf('IF NEW."id" IS DISTINCT');
    const identity = body.slice(idAt, body.indexOf('THEN', idAt));
    const fixed = [...identity.matchAll(/NEW\."([A-Za-z0-9]+)" IS DISTINCT FROM OLD\."\1"/g)].map((m) => m[1]!).sort();
    expect(fixed).toEqual(['createdAt', 'fileId', 'id', 'rowNumber']);
    expect(b).toContain(`IF NEW."raw" IS DISTINCT FROM OLD."raw" AND NEW."raw" <> '{}'::jsonb THEN`);
    expect(b).toContain(`IF OLD."raw" = '{}'::jsonb AND OLD."parsed" IS NULL AND NEW."parsed" IS NOT NULL THEN`);
    const doneAt = body.indexOf(`IF OLD."outcome" IN`);
    const done = body.slice(doneAt, body.indexOf('RAISE', doneAt));
    expect(ws(done)).toMatch(/^IF OLD\."outcome" IN \('APPLIED', 'NO_CHANGE', 'REJECTED'\)/);
    // Every column but the payload is frozen on a done row (raw may only be emptied, above).
    const frozen = [...done.matchAll(/NEW\."([A-Za-z0-9]+)" IS DISTINCT FROM OLD\."\1"/g)].map((m) => m[1]!).sort();
    const cols = storedFields(schema).filter((f) => f.model === 'TemixDailyRow').map((f) => f.name);
    expect(frozen).toEqual(cols.filter((c) => !['id', 'fileId', 'rowNumber', 'createdAt', 'raw'].includes(c)).sort());
    expect(SQL).toMatch(/CREATE TRIGGER temixdailyrow_guard\s+BEFORE INSERT OR UPDATE ON "TemixDailyRow"/);
  });

  it('the route-map guard serialises writers of one code before it checks', () => {
    const body = /FUNCTION nmwc_temix_route_map_guard\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL)![1]!;
    const lock = body.indexOf('pg_advisory_xact_lock(');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(body.indexOf('IF NEW."action"'));
    // Review of stage 1: the lock serialises only under READ COMMITTED (a later
    // snapshot per statement), so any other isolation level is refused first.
    const iso = body.indexOf(`IF current_setting('transaction_isolation') <> 'read committed' THEN`);
    expect(iso).toBeGreaterThan(-1);
    expect(iso).toBeLessThan(lock);
  });
});

describe('the CHECKs name exactly the list’s values', () => {
  it('ledger kinds, listed-once kinds and route-map actions', () => {
    expect(checkList('TemixChange_kind_check')).toEqual([...TEMIX_CHANGE_KINDS]);
    expect(new Set(TEMIX_CHANGE_KINDS).size).toBe(TEMIX_CHANGE_KINDS.length);
    expect(checkList('TemixNoticeSeen_kind_check')).toEqual([...TEMIX_NOTICE_SEEN_KINDS]);
    expect(TEMIX_NOTICE_SEEN_KINDS as readonly string[]).not.toContain('STATUS_DIFFERS');
    expect(checkList('TemixRouteMap_action_check')).toEqual([...TEMIX_ROUTE_MAP_ACTIONS]);
  });

  it('the file states and row outcomes are the plan’s', () => {
    const block = (name: string) => /\{([^}]*)\}/.exec(readFileSync('prisma/schema.prisma', 'utf8').split(`enum ${name} `)[1]!)![1]!.trim().split(/\s+/);
    expect(block('TemixDailyFileState')).toEqual(['STAGED', 'CHECKED', 'APPLYING', 'FINALIZING', 'LOADED', 'DISCARDED']);
    expect(block('TemixDailyRowOutcome')).toEqual(['PENDING', 'NO_CHANGE', 'APPLIED', 'PARTLY_APPLIED', 'HELD', 'REJECTED']);
  });
});

describe('the partial indexes', () => {
  it('are created here and named in CI’s drift allowlist', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const allowed = /ALLOWED='([^']*)'/.exec(ci)![1]!.split('|');
    for (const name of TEMIX_DAILY_RAW_INDEXES) {
      expect(SQL, name).toMatch(new RegExp(`CREATE (UNIQUE )?INDEX "${name}"`));
      expect(allowed, name).toContain(name);
    }
    expect(ws(SQL)).toContain(`CREATE UNIQUE INDEX "TemixDailyFile_sha_day_live_unique" ON "TemixDailyFile" ("fileSha256", "loadDay") WHERE "state" <> 'DISCARDED';`);
    expect(ws(SQL)).toContain(`CREATE UNIQUE INDEX "TemixDailyFile_one_in_flight" ON "TemixDailyFile" ((true)) WHERE "state" IN ('APPLYING', 'FINALIZING');`);
  });
});
