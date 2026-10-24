// @vitest-environment node
/**
 * Gap 29: the nightly checks protection-triggers and protection-functions
 * compare the live catalog with constants (lib/integrity/expected.ts). This
 * holds those constants to the migrations themselves, so a migration that
 * changes a protecting trigger or one of its functions cannot leave the check
 * comparing against yesterday's body — and so a body replaced in the database
 * with a no-op is caught by an MD5 that only the migrations decide.
 *
 *  - TRIGGER_BINDINGS: every protecting trigger (lib/history-tables.ts
 *    PROTECTION_TRIGGERS, the four original ledger triggers included), with the
 *    table and function of its LAST CREATE in the migrations.
 *  - EXPECTED_FUNCTIONS: every function those triggers call, and the change
 *    context they read, with the MD5 of the body between the dollar quotes of
 *    its LAST definition (as pg_proc.prosrc stores it), its definer rights and
 *    its pinned search_path.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { functionShapes, triggerBindings } from '../support/migration-sql';
import { EXPECTED_FUNCTIONS, TRIGGER_BINDINGS } from '@/lib/integrity/expected';
import { PROTECTION_TRIGGERS, LEDGER_TRIGGERS, HISTORY_DEFINER_FUNCTIONS } from '@/lib/history-tables';

describe('the protection the nightly check expects is the migrations’', () => {
  const bindings = triggerBindings();

  it('every protecting trigger, with its table and function', () => {
    expect(Object.keys(TRIGGER_BINDINGS).sort()).toEqual([...PROTECTION_TRIGGERS].sort());
    for (const name of PROTECTION_TRIGGERS) {
      expect(TRIGGER_BINDINGS[name], name).toEqual({ table: bindings[name]!.table, fn: bindings[name]!.fn });
    }
    // The original ledger triggers are there too (not created by the history migrations).
    for (const t of LEDGER_TRIGGERS) expect(TRIGGER_BINDINGS[t]!.fn).toBe('nmwc_forbid_audit_mutation');
  });

  it('every function they call, and the change context, by the MD5 of its last body', () => {
    const fns = [...new Set([...Object.values(TRIGGER_BINDINGS).map((b) => b.fn), 'nmwc_change_ctx'])].sort();
    expect(Object.keys(EXPECTED_FUNCTIONS).sort()).toEqual(fns);
    const shapes = functionShapes(fns);
    for (const f of fns) {
      expect(EXPECTED_FUNCTIONS[f], f).toEqual(shapes[f]);
    }
  });

  it('the definer-rights capture functions are the ones the history says, and every one pins its search_path', () => {
    for (const f of HISTORY_DEFINER_FUNCTIONS) expect(EXPECTED_FUNCTIONS[f]!.securityDefiner, f).toBe(true);
    for (const [f, e] of Object.entries(EXPECTED_FUNCTIONS)) {
      expect(e.searchPath, f).toBe('pg_catalog, public, pg_temp');
      expect(e.md5, f).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('reads the dollar-quoted body exactly (a comment line naming a function is not a definition)', () => {
    const fake = [
      {
        name: '20990101000000_x',
        sql: "-- CREATE OR REPLACE FUNCTION f() is described here\nCREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql\nSET search_path = pg_catalog, public, pg_temp;\n",
      },
    ];
    const s = functionShapes(['f'], fake);
    expect(s.f).toMatchObject({ securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' });
    expect(s.f!.md5).toBe(createHash('md5').update('\nBEGIN\n  RETURN NEW;\nEND;\n').digest('hex'));
  });
});
