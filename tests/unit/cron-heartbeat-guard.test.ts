// @vitest-environment node
/**
 * N09 (auditor recheck, 2026-09-27): an error a cron route COUNTS is an error
 * only if its heartbeat predicate READS the count.
 *
 * The photo GC counted R2 failures and wired them to its heartbeat; the database
 * delete that follows had no counter at all, and a run in which every delete
 * failed recorded success and alerted nobody. The next counter someone adds —
 * `dbErrors`, `sweepErrors`, anything ending in `Errors` — is the same defect
 * waiting to happen: present in the JSON, absent from `withHeartbeat`'s
 * predicate, and green for ever. No behavioural test can see a predicate that
 * does not read a field, so this reads every cron route: each `…Errors` /
 * `errors` key a route puts in its response must be read by the predicate it
 * passes to `withHeartbeat`. Comments are stripped first.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';

const DIR = 'app/api/cron';
const ROUTES = readdirSync(DIR)
  .map((d) => join(DIR, d, 'route.ts').replace(/\\/g, '/'))
  .filter((f) => existsSync(f));

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

type Parsed = { errorKeys: string[]; predicate: string | null; wrapped: boolean };

function parse(file: string): Parsed {
  const src = stripComments(readFileSync(file, 'utf8'), file);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      objects.set(n.name.text, n.initializer);
    }
  });
  const keys = new Set<string>();
  let predicate: string | null = null;
  let wrapped = false;
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression.getText(sf);
    if (callee === 'NextResponse.json' && n.arguments[0]) {
      const a = n.arguments[0];
      const obj = ts.isObjectLiteralExpression(a) ? a : ts.isIdentifier(a) ? objects.get(a.text) : undefined;
      for (const p of obj?.properties ?? []) {
        const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        if (name && /(^e|E)rrors$/.test(name)) keys.add(name);
      }
    }
    if (callee === 'withHeartbeat') {
      wrapped = true;
      predicate = n.arguments[2] ? n.arguments[2].getText(sf) : null;
    }
  });
  return { errorKeys: [...keys].sort(), predicate, wrapped };
}

describe('every error count a cron route reports is read by its heartbeat', () => {
  it('finds the routes and their counters at all', () => {
    // Not vacuous: the four routes, and the counters this guard exists for.
    expect(ROUTES.length).toBeGreaterThanOrEqual(4);
    expect(parse(`${DIR}/photo-gc/route.ts`).errorKeys).toEqual(['dbErrors', 'r2Errors']);
    expect(parse(`${DIR}/retention-sweep/route.ts`).errorKeys).toEqual(['errors']);
  });

  it.each(ROUTES)('%s', (file) => {
    const { errorKeys, predicate, wrapped } = parse(file);
    expect(wrapped, 'every cron route reports through withHeartbeat').toBe(true);
    if (errorKeys.length === 0) return;
    // The default predicate reads only the status code, which a counted error never changes.
    expect(predicate, `${file} counts ${errorKeys.join(', ')} but passes withHeartbeat no predicate`).not.toBeNull();
    for (const k of errorKeys) {
      expect(predicate, `${file}: the heartbeat predicate never reads ${k}`).toMatch(new RegExp(`\\bbody\\??\\.${k}\\b`));
    }
  });
});
