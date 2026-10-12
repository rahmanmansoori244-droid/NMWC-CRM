// @vitest-environment node
/**
 * Gap 22 (data audit 2026-10-10): the losing side of two people saving at once
 * is recorded — but only when the throw site says who lost and on what
 * (lib/errors.ts ConflictMeta). A refusal thrown without it is answered exactly
 * as before and leaves no CONFLICT row, which nobody would notice: the defect is
 * "nobody passed it". So this reads every `new ConflictError(<code>` of a
 * recorded code, and every `new StaleFieldsError(`, in app/, lib/ and services/,
 * and fails on one without its third argument. A code named by a constant is
 * read from that constant's definition in the same file.
 *
 * lib/decision-token.ts throws STALE_VIEW with the meta its CALLER passes, so
 * every call of assertDecisionView / assertGuaranteesAsViewed must pass one.
 *
 * Structural, per CLAUDE.md: comments stripped first, arguments read by
 * balanced-bracket scanning (tests/support/call-args.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RECORDED_CONFLICT_CODES } from '@/lib/errors';
import { stripComments } from '../support/strip-comments';
import { callArguments, sourceFiles } from '../support/call-args';

/** The top-level, comma-separated arguments of a call's argument text. */
function topLevelArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      cur += c;
      for (i++; i < text.length && text[i] !== q; i++) {
        if (text[i] === '\\') cur += text[i++];
        cur += text[i];
      }
      cur += q;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const FILES = sourceFiles(['app', 'lib', 'services']);

type Site = { file: string; code: string; args: string[] };

/** A code literal, or a constant defined in the same file as `const NAME = 'CODE'`. */
function codeOf(arg: string | undefined, src: string): string {
  const literal = /^'([A-Z_]+)'$/.exec(arg ?? '');
  if (literal) return literal[1]!;
  const ident = /^[A-Z][A-Z0-9_]*$/.exec(arg ?? '');
  if (ident) {
    const def = new RegExp(`const ${ident[0]} = '([A-Z_]+)'`).exec(src);
    if (def) return def[1]!;
  }
  return '<dynamic>';
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of FILES) {
    const src = stripComments(readFileSync(file, 'utf8'), file);
    for (const text of callArguments(src, /new ConflictError/)) {
      const args = topLevelArgs(text);
      out.push({ file, code: codeOf(args[0], src), args });
    }
    for (const text of callArguments(src, /new StaleFieldsError/)) {
      out.push({ file, code: 'STALE_FIELDS', args: topLevelArgs(text) });
    }
  }
  return out;
}

const hasMeta = (args: string[], at: number) => args.length > at && !/^(undefined|null)$/.test(args[at]!);

describe('gap 22: every lost race says who lost and on what', () => {
  const all = sites();

  it('finds the throw sites (the scan is not reading nothing)', () => {
    expect(all.filter((s) => s.code === 'NOT_PENDING').length).toBeGreaterThanOrEqual(10);
    expect(all.some((s) => s.code === 'STALE_FIELDS')).toBe(true);
    expect(all.some((s) => s.code === 'VERSION_CONFLICT')).toBe(true);
    expect(all.filter((s) => s.code === 'STALE_VIEW').length).toBe(3);
  });

  it('a ConflictError is never built with a code the scan cannot read', () => {
    const dynamic = all.filter((s) => s.code === '<dynamic>').map((s) => `${s.file}: ${s.args[0]}`);
    expect(dynamic).toEqual([]);
  });

  it('every recorded code is thrown with its ConflictMeta', () => {
    const recorded = new Set<string>(RECORDED_CONFLICT_CODES);
    const missing = all
      .filter((s) => recorded.has(s.code))
      .filter((s) => !hasMeta(s.args, 2))
      .map((s) => `${s.file}: ${s.code}`);
    expect(missing, 'pass a ConflictMeta (lib/errors.ts) as the third argument').toEqual([]);
  });

  it('every decision-view check is told who decides and on what', () => {
    const missing: string[] = [];
    let calls = 0;
    for (const file of FILES.filter((f) => !/decision-token\.ts$/.test(f))) {
      const src = stripComments(readFileSync(file, 'utf8'), file);
      for (const text of callArguments(src, /\bassertDecisionView/)) {
        calls++;
        if (!hasMeta(topLevelArgs(text), 2)) missing.push(`${file}: assertDecisionView`);
      }
      for (const text of callArguments(src, /\bassertGuaranteesAsViewed/)) {
        calls++;
        if (!hasMeta(topLevelArgs(text), 3)) missing.push(`${file}: assertGuaranteesAsViewed`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(missing).toEqual([]);
  });

  it('runAction records before it answers, and the database module registers the recorder', () => {
    const errors = stripComments(readFileSync('lib/errors.ts', 'utf8'), 'errors.ts');
    const run = errors.slice(errors.indexOf('export async function runAction'));
    expect(run.indexOf('await recordLostRace(err)')).toBeGreaterThan(-1);
    expect(run.indexOf('await recordLostRace(err)')).toBeLessThan(run.indexOf('code: err.code'));
    const db = stripComments(readFileSync('lib/db.ts', 'utf8'), 'db.ts');
    expect(db).toMatch(/registerConflictRecorder\(async \(err\) => \{[\s\S]*import\('\.\/conflict-record'\)[\s\S]*recordConflict\(err\)/);
    // lib/errors.ts is imported by client components: it must not reach the database.
    expect(errors).not.toMatch(/from '\.\/db'|from '@\/lib\/db'|import\('\.\/conflict-record'\)/);
  });
});
