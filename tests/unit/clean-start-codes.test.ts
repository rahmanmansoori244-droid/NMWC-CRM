// @vitest-environment node
/**
 * Go-live clean start: every refusal code the SQL documents is still RAISED, once,
 * in the documented order, and the plan id still covers every part of the
 * fingerprint (review 2026-11-11, destructive-core minor 1). A later edit that
 * deletes a guard's DO block, a self-check or a verify check, or a line of the
 * fingerprint, keeps every other suite green; these rules do not.
 *
 * The integration suite (tests/integration/clean-start.test.ts) makes a set of
 * these codes actually fire against a database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const DIR = 'scripts/ops/clean-start';
const read = (f: string) => readFileSync(`${DIR}/${f}`, 'utf8');
const strip = (s: string) => s.replace(/--[^\n]*/g, '');
/** The codes a file RAISEs (ERRCODE = 'CSnnn'), in file order. */
const raised = (f: string) => [...strip(read(f)).matchAll(/ERRCODE = 'CS(\d{3})'/g)].map((m) => `CS${m[1]}`);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `CS${String(from + i).padStart(3, '0')}`);

describe('every documented refusal code is raised, once, in order', () => {
  it('guards.sql: CS001-CS012', () => {
    expect(raised('guards.sql')).toEqual(range(1, 12));
  });
  it('selfcheck.sql: CS101-CS113 (CS112 next to CS101, CS113 next to CS105, as the file groups them)', () => {
    const got = raised('selfcheck.sql');
    expect([...got].sort()).toEqual(range(101, 113));
    expect(new Set(got).size).toBe(got.length);
  });
  it('verify.sql: CS301-CS307, CS301 first (it settles the COMMIT)', () => {
    expect(raised('verify.sql')).toEqual(range(301, 307));
  });
  it('reset.sql: CS020, CS021 before the locks; CS013 after the fingerprint; plan.sql CS022; photos-record CS401-CS402', () => {
    const r = strip(read('reset.sql'));
    expect(raised('reset.sql')).toEqual(['CS020', 'CS021', 'CS013']);
    expect(r.indexOf("'CS021'")).toBeLessThan(r.indexOf('LOCK TABLE'));
    expect(r.indexOf('\\ir fingerprint.sql')).toBeLessThan(r.indexOf("'CS013'"));
    expect(raised('plan.sql')).toEqual(['CS022']);
    expect(raised('photos-record.sql')).toEqual(['CS401', 'CS402']);
  });
  it('each raise sits in an IF whose condition is not empty, and CS104/CS304 compare a record with its history (both sides)', () => {
    for (const f of ['guards.sql', 'selfcheck.sql', 'verify.sql']) {
      const s = strip(read(f));
      const conds = [...s.matchAll(/IF ([\s\S]*?) THEN\s+RAISE EXCEPTION/g)].map((m) => m[1]!.trim());
      expect(conds.length, f).toBe(raised(f).length);
      for (const c of conds) {
        // a real test of something (the shortest is selfcheck's "n <> 0"), never a constant
        expect(c, f).toMatch(/<>|<|>|=|EXISTS|IS DISTINCT FROM|NOT |~/);
        expect(c, f).not.toMatch(/^(true|false|1\s*=\s*1|NOT false)$/i);
      }
    }
    for (const [f, code] of [
      ['selfcheck.sql', 'CS104'],
      ['verify.sql', 'CS304'],
    ] as const) {
      const s = strip(read(f));
      const block = s.slice(s.lastIndexOf('DO $cs$', s.indexOf(`'${code}'`)), s.indexOf(`'${code}'`));
      // the master's side and the history's side of each ROW comparison
      expect(block, `${f} ${code}`).toMatch(/ROW\(m\."username", m\."role"/);
      expect(block, `${f} ${code}`).toMatch(/ROW\(l\."username", l\."role"/);
      expect(block, `${f} ${code}`).toMatch(/ROW\(m\."code", m\."name", m\."regionId", m\."isActive"\)/);
      expect(block, `${f} ${code}`).toMatch(/ROW\(m\."code", m\."name", m\."isActive"\) IS DISTINCT FROM ROW\(l\."code", l\."name", l\."isActive"\)/);
    }
  });
  it('CS106-CS108 compare AFTER with BEFORE, never a value with itself', () => {
    const s = strip(read('selfcheck.sql'));
    for (const part of ['keep_md5', 'triggers_md5', 'functions_md5'])
      expect(s).toMatch(new RegExp(`current_setting\\('cs\\.after_${part}'\\) IS DISTINCT FROM current_setting\\('cs\\.before_${part}'\\)`));
  });
});

const PARTS = [
  /SELECT 'migrations', \(SELECT sha \|\| ':' \|\| state FROM migrations\)/,
  /UNION ALL SELECT name, value FROM keep_fp/,
  /UNION ALL SELECT name, value FROM empty_fp/,
  /UNION ALL SELECT 'codesequence', \(SELECT rows FROM codeseq\)/,
  /UNION ALL SELECT 'photo-keys', \(SELECT sha FROM photo_keys\)/,
  /UNION ALL SELECT 'seals', \(SELECT sha FROM seals\)/,
  /UNION ALL SELECT 'triggers', \(SELECT md5 FROM triggers_stable\)/,
  /UNION ALL SELECT 'functions', \(SELECT md5 FROM functions\)/,
];
/** The lines CTE of a fingerprint text, or '' when it is not there. */
const linesCte = (s: string) => s.slice(s.indexOf('lines(name, value) AS ('), s.indexOf('doc AS ('));
/** True when the lines CTE names exactly the eight parts (the rule below). */
const allEight = (s: string) => {
  const lines = linesCte(strip(s));
  return (
    PARTS.every((p) => p.test(lines)) &&
    // eight parts: the first SELECT plus seven UNION ALL arms (sub-selects inside an arm do not count)
    (lines.match(/^\s*(UNION ALL )?SELECT\b/gm) ?? []).length === 8 &&
    (lines.match(/\bUNION ALL\b/g) ?? []).length === 7
  );
};

describe('the plan id covers every part of the fingerprint (design section 2)', () => {
  it('the rule fails when any one part is removed, or a ninth part is added', () => {
    const fp = read('fingerprint.sql');
    for (const drop of ["  UNION ALL SELECT 'photo-keys', (SELECT sha FROM photo_keys)\n", "  UNION ALL SELECT name, value FROM empty_fp\n", "  UNION ALL SELECT 'seals', (SELECT sha FROM seals)\n"]) {
      expect(fp).toContain(drop);
      expect(allEight(fp.replace(drop, '')), drop).toBe(false);
    }
    expect(allEight(fp.replace("  UNION ALL SELECT 'functions'", "  UNION ALL SELECT 'x', 'y'\n  UNION ALL SELECT 'functions'"))).toBe(false);
  });
  it('the lines CTE names all eight parts', () => {
    const s = strip(read('fingerprint.sql'));
    const lines = linesCte(s);
    for (const part of PARTS) expect(lines).toMatch(part);
    expect(allEight(read('fingerprint.sql'))).toBe(true);
    // and the plan id is the sha256 of ALL the lines
    expect(s).toMatch(/encode\(sha256\(convert_to\(d\.text, 'UTF8'\)\), 'hex'\) AS plan_id/);
    expect(s).toMatch(/string_agg\(name \|\| '=' \|\| COALESCE\(value, 'NULL'\), E'\\n' ORDER BY name COLLATE "C"\) AS text/);
  });
});

describe('verify.sql finish scope skips only the state checks', () => {
  it('CS302, CS303 and CS306 are inside \\if :cs_finish_scope \\else; CS301, CS304, CS305, CS307 are not', () => {
    const s = read('verify.sql');
    const skipped = [...s.matchAll(/\\if :cs_finish_scope\n\\else\n([\s\S]*?)\\endif/g)].map((m) => m[1]!);
    expect(skipped).toHaveLength(3);
    expect(skipped.map((b) => /ERRCODE = '(CS\d{3})'/.exec(b)![1])).toEqual(['CS302', 'CS303', 'CS306']);
    for (const keep of ['CS301', 'CS304', 'CS305', 'CS307']) expect(skipped.join('\n')).not.toContain(keep);
    expect(s).toMatch(/SELECT :'scope' = 'finish' AS cs_finish_scope/);
  });
});

describe('rehearse-watch night 2 is the next real scheduled run (02:30 UTC)', () => {
  it('evening before midnight Oman, after midnight Oman, and before 02:30 UTC', async () => {
    const { nextOmanMorning } = await import('../../scripts/ops/clean-start/rehearse-watch');
    const at = (s: string) => nextOmanMorning(new Date(s)).toISOString();
    // a reset-day evening run (Oman 19:30-23:59): the next morning
    expect(at('2026-11-20T15:30:00Z')).toBe('2026-11-21T02:30:00.000Z');
    expect(at('2026-11-20T19:59:00Z')).toBe('2026-11-21T02:30:00.000Z');
    // after 20:00 UTC it is already the next day in Oman, but the next run is still the
    // coming 02:30 UTC, NOT one day further (the old rule gave 2026-11-22)
    expect(at('2026-11-20T20:30:00Z')).toBe('2026-11-21T02:30:00.000Z');
    expect(at('2026-11-20T23:59:00Z')).toBe('2026-11-21T02:30:00.000Z');
    // before / at 02:30 UTC
    expect(at('2026-11-21T01:00:00Z')).toBe('2026-11-21T02:30:00.000Z');
    expect(at('2026-11-21T02:30:00Z')).toBe('2026-11-22T02:30:00.000Z');
    // month end
    expect(at('2026-11-30T21:00:00Z')).toBe('2026-12-01T02:30:00.000Z');
  });
});
