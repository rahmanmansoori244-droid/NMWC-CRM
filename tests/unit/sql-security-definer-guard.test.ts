// @vitest-environment node
/**
 * Every SECURITY DEFINER function a migration creates pins its search_path.
 *
 * A definer-rights function runs with its owner's privileges. Without its own
 * search_path it resolves names through the CALLER's, and pg_temp is searched
 * ahead of pg_catalog for tables: the caller can shadow pg_class or a public
 * table with a temp table of its own and decide what the function reads — the
 * hole 20260915120000_trigger_search_path closed in the audit guard, with the
 * owner's rights on top. The history capture functions (20261013100100) are
 * definer-rights so the runtime role can write the master tables without any
 * privilege on the history; each must pin its path.
 *
 * Structural, per CLAUDE.md: SQL comments are stripped first, so prose naming
 * SECURITY DEFINER neither passes nor fails it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

type FnDef = { migration: string; name: string; attributes: string };

/** `--` comments removed (dollar-quoted bodies are cut out separately). */
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** Every CREATE [OR REPLACE] FUNCTION, with the text around its body (the attributes). */
function functionDefs(migration: string, sql: string): FnDef[] {
  const out: FnDef[] = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const start = m.index;
    const bodyOpen = sql.indexOf('$$', start);
    const bodyClose = bodyOpen < 0 ? -1 : sql.indexOf('$$', bodyOpen + 2);
    const end = bodyClose < 0 ? -1 : sql.indexOf(';', bodyClose + 2);
    if (bodyOpen < 0 || bodyClose < 0 || end < 0)
      throw new Error(`${migration}: cannot read function ${m[1]}`);
    out.push({
      migration,
      name: m[1]!,
      attributes: stripSqlComments(
        sql.slice(start, bodyOpen) + ' ' + sql.slice(bodyClose + 2, end)
      ),
    });
    re.lastIndex = end;
  }
  return out;
}

const MIGRATIONS = readdirSync('prisma/migrations', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const DEFS = MIGRATIONS.flatMap((m) =>
  functionDefs(m, stripSqlComments(readFileSync(`prisma/migrations/${m}/migration.sql`, 'utf8')))
);

const isDefiner = (d: FnDef) => /\bSECURITY\s+DEFINER\b/i.test(d.attributes);
const pinsPath = (d: FnDef) =>
  /\bSET\s+search_path\s*(=|TO)\s*pg_catalog\s*,\s*public\s*,\s*pg_temp\b/i.test(d.attributes);

describe('SECURITY DEFINER functions pin their search_path', () => {
  it('the reader still finds the shapes it exists to check (a broken parser fails open)', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION a() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
      CREATE FUNCTION b() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      -- CREATE FUNCTION c() in a comment is not a function
      CREATE OR REPLACE FUNCTION d() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp;`;
    const defs = functionDefs('fixture', sql.replace(/--[^\n]*/g, ''));
    expect(defs.map((d) => [d.name, isDefiner(d), pinsPath(d)])).toEqual([
      ['a', true, true],
      ['b', true, false],
      ['d', false, true],
    ]);
  });

  it('finds the definer-rights functions the history foundation creates (non-vacuous)', () => {
    const definers = DEFS.filter(isDefiner).map((d) => d.name);
    for (const f of [
      'nmwc_history_customer',
      'nmwc_history_branch',
      'nmwc_history_user',
      'nmwc_history_manager_regions',
    ]) {
      expect(definers).toContain(f);
    }
  });

  it('every one, in every migration, sets search_path = pg_catalog, public, pg_temp', () => {
    const unpinned = DEFS.filter((d) => isDefiner(d) && !pinsPath(d)).map(
      (d) => `${d.migration}: ${d.name}`
    );
    expect(unpinned).toEqual([]);
  });

  it('and has EXECUTE revoked from PUBLIC in the migration that creates it', () => {
    const missing: string[] = [];
    for (const m of MIGRATIONS) {
      const sql = stripSqlComments(readFileSync(`prisma/migrations/${m}/migration.sql`, 'utf8'));
      for (const d of functionDefs(m, sql).filter(isDefiner)) {
        const revoke = new RegExp(
          `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${d.name}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`,
          'i'
        );
        if (!revoke.test(sql)) missing.push(`${m}: ${d.name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
