/**
 * The daily Temix import, stage 5: ONE ROUTE WRITER. Outside shop creation,
 * the only code that may change a shop's route (Branch.routeId) is
 * lib/temix-daily-move.ts moveShopToRoute, and its only caller is
 * services/temix-daily-apply.ts. Its own guard, beside the Import screen's
 * (tests/unit/import-shop-route-guard.test.ts, unchanged): that one keeps every
 * import file from moving a shop; this one reads EVERY source file, scripts and
 * seeds included, and fails if any but the mover writes a route on a shop that
 * exists.
 *
 * In every `branch.update(...)` and `branch.updateMany(...)` call, and the
 * `update:` half of every `branch.upsert(...)` (its `create:` half makes a new
 * shop, which is shop creation):
 *  - routeId, and a `route:` relation, appear only in lib/temix-daily-move.ts;
 *  - regionId, and a `region:` relation, appear only there too: a shop's region
 *    is its route's region (the database's branch_region_consistency_check), so
 *    the region follows the route and is written beside it. The Import screen's
 *    region repair goes through existingShopWrite (a spread its own guard reads);
 *  - every spread and every `data: <name>` is one of the named values below,
 *    each proven here to carry no route or region.
 * Raw SQL that UPDATEs "Branch" naming "routeId" or "regionId" appears only in
 * the mover (it has none). A nested relation write of shops from the other
 * side (route.update({ data: { branches: { connect } } }), region ... set,
 * customer ... update) appears nowhere (review 2026-11-15): it would move a
 * shop without a branch.* call. Moving moveShopToRoute, or adding a second
 * writer, needs a deliberate change to this test.
 *
 * Structural, per CLAUDE.md: comments stripped first, call arguments read by
 * balanced brackets.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import { BRANCH_EDIT_FIELDS } from '@/lib/edit-values';

const MOVER = 'lib/temix-daily-move.ts';
const CALLER = 'services/temix-daily-apply.ts';
const ROOTS = ['app', 'components', 'lib', 'services', 'scripts', 'prisma'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'node_modules' || e === '.next' || e === 'migrations' ? [] : walk(p);
    return /\.(ts|tsx|mts|cts)$/.test(e) && !/\.d\.ts$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

/** The text between the bracket at `open` and its partner (exclusive), skipping strings. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

type Write = { file: string; line: number; kind: string; text: string };

/** Every write on a Branch that may exist: update, updateMany, and the update half of upsert. */
export function branchWrites(file: string, src: string): Write[] {
  const out: Write[] = [];
  const call = /\bbranch\s*\.\s*(update|updateMany|upsert)\s*\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const line = src.slice(0, m.index).split('\n').length;
    const args = balanced(src, m.index + m[0].length - 1);
    if (m[1] === 'upsert') {
      const u = /\bupdate\s*:\s*\{/.exec(args);
      if (!u) throw new Error(`${file}:${line}: a branch.upsert with no update: half`);
      out.push({ file, line, kind: 'upsert.update', text: balanced(args, u.index + u[0].length - 1) });
    } else out.push({ file, line, kind: m[1]!, text: dataOf(args) ?? `<no data: read> ${args}` });
  }
  return out;
}

/** The `data:` of an update's arguments: its object's text, or `data: <name>`; null when there is none to read. */
function dataOf(args: string): string | null {
  const d = /\bdata\s*:\s*/.exec(args);
  if (!d) return null;
  const at = d.index + d[0].length;
  if (args[at] === '{') return balanced(args, at);
  const name = /^([A-Za-z_$][\w$]*)/.exec(args.slice(at));
  return name ? `data: ${name[1]}` : null;
}

/**
 * Values spread into, or passed as, a shop write, each proven below to carry
 * no route or region. `file:name`.
 */
const NAMED_VALUES = new Set([
  // A request's approved shop fields: built only from BRANCH_EDIT_FIELDS (below).
  'services/edits.ts:branchUpdate',
  // A photo bound to a shop: only the photo relations and the editor (below).
  'services/photos.ts:updateBranch',
  // The Import screen's write on a shop that exists (its own guard proves no route in it).
  'services/imports.ts:existingShopWrite',
  'services/imports.ts:shopWrite',
]);

/** What is wrong with one write in `file`, or null. */
export function writeProblem(w: Write): string | null {
  const t = w.text;
  const mover = w.file === MOVER;
  if (t.startsWith('<no data: read>')) return 'a shop write whose data this guard cannot read';
  if (!mover && /\brouteId\b/.test(t)) return 'writes routeId';
  if (!mover && /\broute\s*:/.test(t)) return 'writes a route relation';
  if (!mover && /\bregionId\b/.test(t)) return 'writes regionId';
  if (!mover && /\bregion\s*:/.test(t)) return 'writes a region relation';
  for (const s of t.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (!NAMED_VALUES.has(`${w.file}:${s[1]}`)) return `spreads ${s[1]}, which this guard has not proven route-free`;
  }
  const data = /^data: ([A-Za-z_$][\w$]*)$/.exec(t);
  if (data && !NAMED_VALUES.has(`${w.file}:${data[1]}`)) return `writes data ${data[1]}, which this guard has not proven route-free`;
  return null;
}

/**
 * Raw SQL (a template or a quoted string) that UPDATEs "Branch" and SETs its
 * route or region. A route named in the WHERE (a guard on the row) is no write.
 */
export function rawRouteWrites(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/`[^`]*`|'[^'\n]*'/g)) {
    const sql = m[0];
    const set = /\bUPDATE\s+(?:"?public"?\.)?"?Branch"?(?![A-Za-z0-9_])[^;]*?\bSET\b([\s\S]*?)(?:\bFROM\b|\bWHERE\b|\bRETURNING\b|$)/i.exec(sql);
    if (set && /\b(routeId|regionId)\b/.test(set[1]!)) out.push(sql.slice(0, 80));
  }
  return out;
}

/**
 * Nested writes of shops through another model's write: a `branches: { ... }`
 * holding connect, connectOrCreate, set, disconnect, update, updateMany or
 * upsert. `create`/`createMany` there make new shops (shop creation), and a
 * read's `branches: { some | every | none }` is no write. Returns the start of
 * each, for the message.
 */
export function nestedShopWrites(src: string): string[] {
  const out: string[] = [];
  const key = /\bbranches\s*:\s*\{/g;
  for (let m = key.exec(src); m; m = key.exec(src)) {
    const inner = balanced(src, m.index + m[0].length - 1);
    if (/\b(connect|connectOrCreate|set|disconnect|update|updateMany|upsert)\s*:/.test(inner)) out.push(src.slice(m.index, m.index + 80));
  }
  return out;
}

const files = ROOTS.flatMap(walk);
const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

describe('one route writer: lib/temix-daily-move.ts', () => {
  it('the detectors still catch what they are for', () => {
    const bad = [
      "await tx.branch.update({ where: { id }, data: { routeId: r, address } });",
      "await tx.branch.updateMany({ where: { id }, data: { route: { connect: { id: x } } } });",
      "await db.branch.upsert({ where: { branchCode }, update: { regionId: g }, create: { routeId: r } });",
      "await tx.branch.update({ where: { id }, data: { region: { connect: { id: g } } } });",
      "const w = { routeId: 'x' }; await tx.branch.update({ where: { id }, data: { ...w } });",
      "const w = { routeId: 'x' }; await prisma.branch.update({ where: { id }, data: w });",
      'await prisma.branch.update({ where: { id }, data });',
    ];
    for (const src of bad) {
      const [w] = branchWrites('lib/x.ts', src);
      expect(writeProblem(w!), src).not.toBeNull();
    }
    const fine = [
      "await tx.branch.update({ where: { id }, data: { completenessScore: 3 } });",
      "await tx.branch.upsert({ where: { branchCode }, update: { address }, create: { routeId: r, regionId: g } });",
      "await tx.branch.create({ data: { routeId: r, regionId: g } });",
      'await tx.branch.updateMany({ where: { id: { in: [...ids] }, routeId: r }, data: { updatedAt: at } });',
    ];
    for (const src of fine) for (const w of branchWrites('lib/x.ts', src)) expect(writeProblem(w), src).toBeNull();
    expect(rawRouteWrites('await tx.$executeRaw`UPDATE "Branch" SET "routeId" = ${r} WHERE "id" = ${id}`')).toHaveLength(1);
    expect(rawRouteWrites("await db.$executeRawUnsafe('update public.\"Branch\" set \"regionId\" = 1')")).toHaveLength(1);
    expect(rawRouteWrites('await tx.$executeRaw`UPDATE "Branch" SET "completenessScore" = 1`')).toEqual([]);
    expect(rawRouteWrites('await tx.$executeRaw`UPDATE "BranchHistory" SET "routeId" = 1`')).toEqual([]);
    expect(rawRouteWrites('await tx.$queryRaw`UPDATE "Branch" AS b SET "dayOfVisit" = v.day FROM v WHERE b."routeId" = v."routeId"`')).toEqual([]);
    expect(rawRouteWrites('await tx.$queryRaw`UPDATE "Branch" AS b\n SET "dayOfVisit" = v.day, "regionId" = v.r FROM v WHERE b."id" = v.id`')).toHaveLength(1);
    for (const src of [
      'await tx.route.update({ where: { id: r }, data: { branches: { connect: [{ id: b }] } } });',
      'await tx.region.update({ where: { id: g }, data: { branches: { set: [{ id: b }] } } });',
      'await tx.customer.update({ where: { id }, data: { branches: { update: { where: { id: b }, data: { routeId: r } } } } });',
      'await tx.route.upsert({ where: { code }, update: { branches: { connectOrCreate: x } }, create: { code } });',
      'await tx.customer.update({ where: { id }, data: { branches: { updateMany: { where: {}, data: { regionId: g } } } } });',
      'await tx.route.update({ where: { id }, data: { branches: { disconnect: [{ id: b }] } } });',
      'await tx.customer.update({ where: { id }, data: { branches: { upsert: { where: { id: b }, update: {}, create: x } } } });',
    ])
      expect(nestedShopWrites(src), src).toHaveLength(1);
    for (const src of [
      'await tx.customer.create({ data: { nmwcCode, branches: { create: [{ routeId: r, regionId: g }] } } });',
      'await tx.customer.findMany({ where: { branches: { some: { routeId: r } } } });',
      'await tx.customer.count({ where: { branches: { none: {} } } });',
    ])
      expect(nestedShopWrites(src), src).toEqual([]);
  });

  it('walks every source root, scripts and seeds included, and finds the mover', () => {
    expect(files).toContain(MOVER);
    expect(files).toContain('services/imports.ts');
    expect(files).toContain('prisma/seed.ts');
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);
    // The mover makes exactly one shop write, of routeId and regionId.
    const writes = branchWrites(MOVER, read(MOVER));
    expect(writes.map((w) => w.kind)).toEqual(['updateMany']);
    expect(writes[0]!.text.trim()).toBe('routeId: to.routeId, regionId: to.regionId, version: { increment: 1 }, lastEditedById: actorId');
  });

  it.each(files.filter((f) => f !== MOVER))('%s writes no route on a shop that exists', (file) => {
    const src = read(file);
    for (const w of branchWrites(file, src)) expect(writeProblem(w), `${file}:${w.line} (${w.kind})`).toBeNull();
    expect(rawRouteWrites(src), file).toEqual([]);
    expect(nestedShopWrites(src), file).toEqual([]);
  });

  it('moveShopToRoute is called from the apply only', () => {
    const callers = files.filter((f) => f !== MOVER && /\bmoveShopToRoute\s*\(/.test(read(f)));
    expect(callers).toEqual([CALLER]);
  });

  it('the named values carry no route or region', () => {
    // A request's shop fields: the list it is built from has neither.
    expect(BRANCH_EDIT_FIELDS as readonly string[]).not.toContain('routeId');
    expect(BRANCH_EDIT_FIELDS as readonly string[]).not.toContain('regionId');
    const edits = read('services/edits.ts');
    expect(edits).toMatch(/const branchUpdate: Record<string, unknown> = \{\};\s*for \(const f of BRANCH_EDIT_FIELDS\)/);
    for (const m of edits.matchAll(/\bbranchUpdate(?:\.(\w+)|\[(\w+)\])\s*=(?!=)/g)) {
      expect(['lastEditedById', 'lastStatusChangeAt', 'f'], m[0]).toContain(m[1] ?? m[2]);
    }
    // A photo's shop write: the photo relations and the editor only.
    const photos = read('services/photos.ts');
    expect(photos).toMatch(/const updateBranch: Prisma\.BranchUpdateInput = \{ lastEditedBy: \{ connect: \{ id: session\.user\.id \} \} \};/);
    for (const m of photos.matchAll(/\bupdateBranch\.(\w+)\s*=(?!=)/g)) expect(['shopPhoto', 'signboardPhoto'], m[0]).toContain(m[1]);
    // The Import screen's: its own guard reads existingShopWrite (unchanged).
    expect(readFileSync('tests/unit/import-shop-route-guard.test.ts', 'utf8')).toMatch(/existingShopWrite/);
  });
});
