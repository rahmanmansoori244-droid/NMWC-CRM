/**
 * Owner's answer of 2026-11-11 ("A1 stop"): no path of the customer import may
 * change the route of a shop that already exists. lib/import-shop-route.ts is the
 * one place that rule lives; this test reads every import source file and fails
 * if any of them writes a route (or a region other than through that file's
 * existingShopWrite) on a Branch that exists:
 *
 *  - every `branch.update(...)` / `branch.updateMany(...)` call, whole;
 *  - the `update:` half of every `branch.upsert(...)` call (its `create:` half
 *    makes a NEW shop, which is created on the sheet's route as before);
 *  - any raw SQL that names "Branch" and "routeId" together.
 *
 * In those writes the words routeId, regionId and route (as a key) must not
 * appear, and every spread must be of existingShopWrite(...) or of a value made
 * by it. A future lane that forgets the rule fails here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every source file of the customer import (and the account import, which shares services/imports.ts). */
function importSources(): string[] {
  const lib = readdirSync('lib')
    .filter((f) => /^(import-|account-import).*\.tsx?$/.test(f))
    .map((f) => join('lib', f));
  const services = readdirSync('services')
    .filter((f) => /^import.*\.tsx?$/.test(f))
    .map((f) => join('services', f));
  return [...services, ...lib];
}

/** The text between the bracket at `open` and its partner (exclusive), skipping strings and comments. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return src.slice(open + 1, i);
    }
    i += 1;
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

/** Strips comments, so a word in a comment is not read as a write. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

type Write = { file: string; at: number; kind: string; text: string };

/** Every write the import makes on a Branch that may exist. */
export function existingBranchWrites(file: string, src: string): Write[] {
  const out: Write[] = [];
  const call = /\bbranch\s*\.\s*(update|updateMany|upsert)\s*\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const args = balanced(src, m.index + m[0].length - 1);
    if (m[1] === 'upsert') {
      const u = /\bupdate\s*:\s*\{/.exec(args);
      if (!u) throw new Error(`${file}: a branch.upsert with no update: half`);
      out.push({ file, at: m.index, kind: 'upsert.update', text: balanced(args, u.index + u[0].length - 1) });
    } else {
      out.push({ file, at: m.index, kind: m[1]!, text: args });
    }
  }
  return out;
}

/** What is wrong with one write, or null. `made` are names bound to existingShopWrite(...). */
export function routeProblem(w: Write, made: Set<string>): string | null {
  const t = code(w.text);
  if (/\brouteId\b/.test(t)) return 'writes routeId';
  if (/\bregionId\b/.test(t)) return 'writes regionId outside existingShopWrite';
  if (/\broute\s*:/.test(t)) return 'writes a route relation';
  for (const s of t.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*(\()?/g)) {
    const name = s[1]!;
    if (name === 'existingShopWrite' && s[2]) continue;
    if (made.has(name)) continue;
    return `spreads ${name}, which is not made by existingShopWrite`;
  }
  return null;
}

/** Names bound to an existingShopWrite(...) result in a file. */
export function madeByExistingShopWrite(src: string): Set<string> {
  const made = new Set<string>();
  const bind = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*existingShopWrite\s*\(/g;
  for (let m = bind.exec(src); m; m = bind.exec(src)) made.add(m[1]!);
  // A name bound to one of those (`const branchWrite = shopWrite;`).
  for (const n of [...made]) {
    const alias = new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*${n}\\s*;`, 'g');
    for (let m = alias.exec(src); m; m = alias.exec(src)) made.add(m[1]!);
  }
  return made;
}

describe('no import code writes a route on a shop that exists', () => {
  const files = importSources();

  it('finds the import sources, and the two writes the promote makes on a shop that exists', () => {
    expect(files).toContain(join('services', 'imports.ts'));
    expect(files).toContain(join('services', 'import-fixes.ts'));
    expect(files).toContain(join('lib', 'import-shop-route.ts'));
    const writes = existingBranchWrites('services/imports.ts', readFileSync('services/imports.ts', 'utf8'));
    // The fixed lane's update and the full lane's upsert.
    expect(writes.map((w) => w.kind).sort()).toEqual(['update', 'upsert.update']);
  });

  it.each(importSources())('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    const made = madeByExistingShopWrite(src);
    for (const w of existingBranchWrites(file, src)) {
      const line = src.slice(0, w.at).split('\n').length;
      expect(routeProblem(w, made), `${file}:${line} (${w.kind})`).toBeNull();
    }
    // No raw SQL of the import names a Branch's route.
    for (const m of code(src).matchAll(/\$(?:executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)\s*(?:`[^`]*`|\([^)]*\))/g)) {
      const sql = m[0];
      expect(/"Branch"/.test(sql) && /UPDATE/i.test(sql) && /"routeId"/.test(sql), `${file}: ${sql.slice(0, 80)}`).toBe(false);
    }
  });

  // The guard itself: it must catch what it is for.
  it('catches a route written directly, a region written outside the helper, and a foreign spread', () => {
    const bad = [
      "await tx.branch.update({ where: { id }, data: { routeId: r.routeId, address } });",
      "await tx.branch.upsert({ where: { branchCode }, update: { regionId: r.regionId }, create: { routeId: r.routeId } });",
      "await tx.branch.updateMany({ where: { id }, data: { route: { connect: { id: x } } } });",
      "const w = { routeId: 'x' }; await tx.branch.update({ where: { id }, data: { ...w } });",
    ];
    for (const src of bad) {
      const [w] = existingBranchWrites('t.ts', src);
      expect(routeProblem(w!, madeByExistingShopWrite(src)), src).not.toBeNull();
    }
    const good = [
      'const shopWrite = existingShopWrite(r); await tx.branch.upsert({ where: { branchCode }, update: { ...shopWrite, version: { increment: 1 } }, create: { routeId: r.routeId, regionId: r.regionId } });',
      'await tx.branch.update({ where: { id }, data: { ...existingShopWrite(w), lastEditedById: me } });',
    ];
    for (const src of good) {
      const [w] = existingBranchWrites('t.ts', src);
      expect(routeProblem(w!, madeByExistingShopWrite(src)), src).toBeNull();
    }
  });
});

// Review of A1 (2026-11-11): the handover pack still said route moves go through
// the Steward's imports, which the owner's "A1 stop" made untrue. No written
// guide may say an import (or the Steward) moves a shop to another route.
describe('the docs never say an import moves a shop to another route', () => {
  /** Every Markdown file under docs/, plus the auditor brief. */
  function docs(dir = 'docs'): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return docs(p);
      return p.endsWith('.md') ? [p] : [];
    });
  }

  it('no doc says route moves go through the Steward’s imports', () => {
    const claim = /route (?:and customer )?moves?\s+go(?:es)?\s+through\s+the\s+Steward/i;
    const offending = [...docs(), 'AUDITOR-BRIEF.md'].filter((f) => claim.test(readFileSync(f, 'utf8')));
    expect(offending).toEqual([]);
    expect(claim.test("Route and customer moves go through the Steward's imports")).toBe(true);
  });
});
