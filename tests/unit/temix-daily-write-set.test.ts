/**
 * The daily Temix import, stage 5: THE CLOSED WRITE SET of the apply, read
 * from its sources (structural, per CLAUDE.md: the defect would be "the apply
 * wrote something it must not"; comments are stripped first).
 *
 *  - lib/temix-daily-move.ts writes a Branch's routeId, regionId, version and
 *    lastEditedById only, one AuditLog row (writeAudit) and one TemixChange
 *    row; nothing else.
 *  - services/temix-daily-apply.ts writes TemixDailyFile (state, lease, who
 *    applied, the reversal tick, counts, discard) and TemixDailyRow (outcome,
 *    customer, shop, reasons, doneAt), named field by field; no Customer, no
 *    Branch but through the mover, no Notification, no Temix queue state, no
 *    raw write. Every transaction goes through withChangeContext; a customer's
 *    is dated the load day, and each row is named before it is written.
 *  - Every action is the Data Steward's, asked first.
 *  - Stage 6: finalize's notices (lib/temix-daily-notices.ts) are notice rows
 *    of the ledger (applied = false, no value) and "listed once" marks, written
 *    inside the transaction that makes the file LOADED, and nothing else; the
 *    drill-down's marks (services/temix-daily-review.ts) are TemixChangeReview
 *    rows only. Each ledger table has exactly these writers in the sources.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
const MOVER = read('lib/temix-daily-move.ts');
const APPLY = read('services/temix-daily-apply.ts');
const NOTICES = read('lib/temix-daily-notices.ts');
const REVIEW = read('services/temix-daily-review.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'node_modules' || e === '.next' || e === 'migrations' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

const WRITE = '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)';
const MODEL_WRITE_RE = new RegExp(`\\b(?:tx|prisma|db)\\s*\\.\\s*([a-zA-Z]+)\\s*\\.\\s*${WRITE}\\s*\\(`, 'g');
const models = (src: string) => [...src.matchAll(MODEL_WRITE_RE)].map((m) => `${m[1]}.${m[2]}`);

/** The text between the bracket at `open` and its partner (exclusive). */
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
  throw new Error(`unbalanced at ${open}`);
}

/** The top-level keys of every `data: { ... }` in the calls of `model` (spreads by name: `...x`). */
function dataKeys(src: string, model: string): string[][] {
  const out: string[][] = [];
  const call = new RegExp(`\\b${model}\\s*\\.\\s*${WRITE}\\s*\\(`, 'g');
  for (const m of src.matchAll(call)) {
    const args = balanced(src, m.index! + m[0].length - 1);
    const d = /\bdata\s*:\s*/.exec(args);
    if (!d) {
      out.push(['<no data>']);
      continue;
    }
    const at = d.index + d[0].length;
    if (args[at] !== '{') {
      // `data: until ? {...} : {...}` and the like: every object in it.
      const expr = args.slice(at).split(/\n\s*\}\)/)[0]!;
      out.push(topKeysOfAll(expr));
      continue;
    }
    out.push(topKeys(balanced(args, at)));
  }
  return out;
}

function topKeys(obj: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i]!;
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (depth === 0 && (c === ',' || i === obj.length - 1)) {
      const t = (c === ',' ? token : token + c).trim();
      const k = /^\.\.\.\(?\s*([\w$.]+)/.exec(t)?.[1] ?? /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(t)?.[1];
      if (k) keys.push(t.startsWith('...') ? `...${k}` : k);
      token = '';
      continue;
    }
    token += c;
  }
  return keys;
}

function topKeysOfAll(expr: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '{') {
      const inner = balanced(expr, i);
      keys.push(...topKeys(inner));
      i += inner.length + 1;
    }
  }
  return keys;
}

describe('the route writer writes the shop\'s route and region, one audit row and one ledger row', () => {
  it('its writes are the Branch and the ledger only', () => {
    expect(models(MOVER)).toEqual(['branch.updateMany', 'temixChange.create']);
    expect([...MOVER.matchAll(/\bwriteAudit\(/g)]).toHaveLength(1);
    expect(MOVER).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it('the Branch write: routeId, regionId, version and lastEditedById, nothing else', () => {
    expect(dataKeys(MOVER, 'branch')).toEqual([['routeId', 'regionId', 'version', 'lastEditedById']]);
    // Optimistic: only the shop as read (its version, its route, live).
    expect(MOVER).toMatch(/where: \{ id: shop\.id, version: shop\.version, routeId: shop\.routeId, deletedAt: null \}/);
    expect(MOVER).toMatch(/if \(written\.count === 0\) \{\s*throw new ConflictError\(\s*'VERSION_CONFLICT'/);
  });

  it('the ledger row is the applied ROUTE_MOVE, with codes and ids only', () => {
    expect(dataKeys(MOVER, 'temixChange')).toEqual([
      ['fileId', 'rowId', 'loadDay', 'kind', 'applied', 'customerId', 'branchId', 'field', 'fromValue', 'toValue', 'detailCode'],
    ]);
    expect(MOVER).toMatch(/kind: 'ROUTE_MOVE',\s*applied: true/);
  });

  it('names no customer, no notification and no Temix queue', () => {
    for (const s of [MOVER, APPLY]) {
      expect(s).not.toMatch(/\bcustomer\s*\.\s*(update|updateMany|upsert|create|delete)/);
      expect(s).not.toMatch(/notifyUsers|notification\s*\.|temixSyncState|PENDING_UPLOAD|dayOfVisit/);
    }
  });
});

describe('the apply writes the file and its rows, field by field, and nothing else of its own', () => {
  it('its model writes are TemixDailyFile and TemixDailyRow only', () => {
    expect([...new Set(models(APPLY).map((m) => m.split('.')[0]))].sort()).toEqual(['temixDailyFile', 'temixDailyRow']);
  });

  it('a row is written its outcome, customer, shop, reasons and time; nothing of the file\'s payload', () => {
    expect(dataKeys(APPLY, 'temixDailyRow')).toEqual([
      ['outcome', 'customerId', 'branchId', 'holdReasons', 'doneAt'],
      // A customer that kept failing (review 2026-11-15): its rows HELD APPLY_FAILED, nothing else.
      ['outcome', 'holdReasons', 'doneAt'],
    ]);
    // Only a row still PENDING of this file.
    expect(APPLY).toMatch(/temixDailyRow\.updateMany\(\{\s*where: \{ id: p\.rowId, fileId: file\.id, outcome: 'PENDING' \}/);
    expect(APPLY).toMatch(
      /temixDailyRow\.updateMany\(\{\s*where: \{ id: r\.id, fileId, outcome: 'PENDING' \},\s*data: \{ outcome: 'HELD', holdReasons: storedReasons\(r\.holdReasons, \{ outcome: 'HELD', holds: \[APPLY_FAILED\] \}\), doneAt \}/
    );
    // Held only after the limit, counted from the file's own audit rows, under the lease.
    const at = APPLY.indexOf('async function recordGroupFailure(');
    const body = APPLY.slice(at, APPLY.indexOf('\n}\n', at));
    expect(body).toMatch(/FOR SHARE/);
    expect(body).toMatch(/if \(failures < APPLY_GROUP_MAX_FAILURES\) return 0;/);
    expect(body.indexOf('writeAudit(')).toBeLessThan(body.indexOf('temixDailyRow.updateMany('));
  });

  it('a file is written its state, lease, ticks, counts and discard only', () => {
    const allowed = new Set([
      'state',
      'applyStartedAt',
      'appliedById',
      'applyLeaseBy',
      'applyLeaseUntil',
      '...(figures.reversals > 0 ? { reversalAckById: me.id, reversalAckAt: now } : {})',
      'loadedAt',
      '...c',
      'discardedById',
      'discardedAt',
      'discardReason',
    ]);
    const seen = dataKeys(APPLY, 'temixDailyFile').flat();
    expect(seen.length).toBeGreaterThan(8);
    for (const k of seen) expect(allowed.has(k) || k === '...figures.reversals' || k === '...c', k).toBe(true);
    // `...c` is finalCounts: the five counters.
    expect(read('lib/temix-daily-apply.ts')).toMatch(
      /return \{\s*appliedRows: [^,]+,\s*noChangeRows: [^,]+,\s*heldRows: [^,]+,\s*rejectedRows: [^,]+,\s*noticeRows: notices,\s*\};/
    );
  });

  it('no raw write: its raw SQL is the order lock and FOR SHARE / FOR UPDATE reads', () => {
    expect(APPLY).not.toMatch(/\$executeRaw(Unsafe)?`\s*(UPDATE|INSERT|DELETE)/i);
    // A row lock (FOR UPDATE, FOR SHARE) is a read; any other UPDATE is a write.
    const writes = (s: string) => [...s.matchAll(/\$queryRaw(?:Unsafe)?[^`]*`([^`]*)`/g)].filter((m) => /(?<!FOR )\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i.test(m[1]!));
    expect(writes(APPLY)).toEqual([]);
    expect([...APPLY.matchAll(/\$executeRaw`([^`]*)`/g)].map((m) => m[1])).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended('nmwc:temix-daily:upload', 42))",
    ]);
    expect(read('lib/temix-daily-apply-load.ts')).not.toMatch(/(?<!FOR )\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/);
    expect(read('lib/temix-daily-apply-load.ts')).not.toMatch(/\$executeRaw|\.(create|update|upsert|delete)(Many)?\(/);
  });

  it('every transaction goes through withChangeContext; none asks for an isolation level', () => {
    expect(APPLY).not.toMatch(/\.\s*\$transaction\s*\(/);
    expect(APPLY).not.toMatch(/isolationLevel/);
  });

  it('a customer\'s transaction is dated the load day, and names each row before it writes it', () => {
    const at = APPLY.indexOf('async function applyGroup(');
    const body = APPLY.slice(at, APPLY.indexOf('\n}\n', at));
    expect(body).toMatch(/withChangeContext\(\s*prisma,\s*\{ actorId: me\.id, source: src\.temixDaily\(file\.id, opening\), effectiveFrom: file\.loadDay \}/);
    const name = body.indexOf('await setChangeContext(tx, { actorId: me.id, source: src.temixDaily(file.id, p.rowNumber), effectiveFrom: file.loadDay });');
    const move = body.indexOf('await moveShopToRoute(');
    const mark = body.indexOf('tx.temixDailyRow.updateMany(');
    expect(name).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(name);
    expect(mark).toBeGreaterThan(move);
    // The customers are locked and the rows read under the lock before the plan is made.
    const lock = body.indexOf('lockGroupCustomers(tx, key)');
    const plan = body.indexOf('checkDailyFile(');
    expect(lock).toBeGreaterThan(0);
    expect(plan).toBeGreaterThan(lock);
    expect(body).toMatch(/FOR SHARE/);
  });

  it('each action is the Data Steward\'s, asked first', () => {
    expect(APPLY).toMatch(/if \(user\.role !== Role\.STEWARD\)\s*\{\s*throw new ForbiddenError/);
    for (const fn of ['startTemixDailyApplyAction', 'runTemixDailySliceAction', 'discardTemixDailyFileAction']) {
      expect(APPLY).toMatch(new RegExp(`export async function ${fn}[\\s\\S]*?runAction\\(async \\(\\) => \\{\\s*const me = await requireSteward\\(\\);`));
    }
  });
});

describe("stage 6: finalize's notices, the review marks, and who writes the ledger", () => {
  it('the notices writer writes notice rows and listed-once marks only', () => {
    expect(models(NOTICES)).toEqual(['temixChange.createMany', 'temixNoticeSeen.createMany']);
    // Each row written is the object the chunk is mapped to.
    const mapped = (model: string) => {
      const at = NOTICES.indexOf(`${model}.createMany(`);
      const obj = NOTICES.indexOf('=> ({', at) + '=> ('.length;
      return topKeys(balanced(NOTICES, obj));
    };
    expect(mapped('temixChange')).toEqual(['fileId', 'rowId', 'loadDay', 'kind', 'applied', 'customerId', 'branchId', 'field', 'fromValue', 'toValue', 'detailCode']);
    expect(mapped('temixNoticeSeen')).toEqual(['customerId', 'kind', 'valueHash', 'firstFileId']);
    // A notice: applied false, no shop, no "from" value.
    expect(NOTICES).toMatch(/kind: n\.kind,\s*applied: false,\s*customerId: n\.customerId,\s*branchId: null,\s*field: n\.field,\s*fromValue: null,/);
    expect(NOTICES).toMatch(/kind: 'NAME_DIFFERS', valueHash: s\.valueHash, firstFileId: file\.id/);
    // Its only raw SQL that is not a read is its lock.
    expect([...NOTICES.matchAll(/\$executeRaw`([^`]*)`/g)].map((m) => m[1])).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended('nmwc:temix-daily:finalize', 42))",
    ]);
    expect([...NOTICES.matchAll(/\$queryRaw(?:Unsafe)?[^`]*`([^`]*)`/g)].filter((m) => /(?<!FOR )\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i.test(m[1]!))).toEqual([]);
    expect(NOTICES).not.toMatch(/notifyUsers|notification\s*\.|temixSyncState|withChangeContext|setChangeContext|writeAudit/);
    // Only for a file FINALIZING with no row PENDING: a half-loaded file lists no one.
    const body = NOTICES.slice(NOTICES.indexOf('export async function writeFinalizeNotices('));
    expect(body.indexOf("f.state !== 'FINALIZING'")).toBeGreaterThan(0);
    expect(body.indexOf('if (pending > 0) throw')).toBeGreaterThan(0);
    expect(body.indexOf('if (pending > 0) throw')).toBeLessThan(body.indexOf('temixChange.createMany('));
  });

  it('finalize writes the notices in the transaction that makes the file LOADED, after its lock and before LOADED', () => {
    expect([...APPLY.matchAll(/\bwriteFinalizeNotices\(/g)]).toHaveLength(1);
    const at = APPLY.indexOf('async function finalize(');
    const body = APPLY.slice(at, APPLY.indexOf('\n}\n', at));
    const lock = body.indexOf('FOR UPDATE');
    const check = body.indexOf("if (!f || f.state !== 'FINALIZING' || f.leaseBy !== token) return false;");
    const notices = body.indexOf('await writeFinalizeNotices(tx, file)');
    const loaded = body.indexOf("state: 'LOADED'");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(notices).toBeGreaterThan(check);
    expect(loaded).toBeGreaterThan(notices);
  });

  it('the review marks: TemixChangeReview rows only, with one audit row per file, the Steward first', () => {
    expect(models(REVIEW)).toEqual(['temixChangeReview.createMany']);
    expect(REVIEW).toMatch(/data: ids\.slice\(i, i \+ CHUNK\)\.map\(\(changeId\) => \(\{ changeId, reviewedById: me\.id, note: REVIEW_NOTE \}\)\)/);
    expect([...REVIEW.matchAll(/\bwriteAudit\(tx,/g)]).toHaveLength(1);
    expect(REVIEW).not.toMatch(/\$executeRaw(Unsafe)?`\s*(UPDATE|INSERT|DELETE)/i);
    expect(REVIEW).not.toMatch(/notifyUsers|\bcustomer\s*\.|\bbranch\s*\./);
    expect(REVIEW).toMatch(/if \(user\.role !== Role\.STEWARD\)\s*\{\s*throw new ForbiddenError/);
    expect(REVIEW).toMatch(/export async function reviewTemixChangesAction[\s\S]*?runAction\(async \(\) => \{\s*const me = await requireSteward\(\);/);
  });

  it('each ledger table has exactly its writers in the sources, through Prisma or a raw INSERT', () => {
    const WRITERS: Record<string, string[]> = {
      temixChange: ['lib/temix-daily-move.ts', 'lib/temix-daily-notices.ts'],
      temixNoticeSeen: ['lib/temix-daily-notices.ts'],
      temixChangeReview: ['services/temix-daily-review.ts'],
    };
    const found: Record<string, string[]> = { temixChange: [], temixNoticeSeen: [], temixChangeReview: [] };
    const raw: string[] = [];
    for (const file of ['app', 'components', 'lib', 'services', 'scripts', 'prisma'].flatMap(walk)) {
      const src = read(file);
      for (const m of src.matchAll(MODEL_WRITE_RE)) if (m[1]! in found && !found[m[1]!]!.includes(file)) found[m[1]!]!.push(file);
      for (const t of ['TemixChange', 'TemixNoticeSeen', 'TemixChangeReview'])
        if (new RegExp(`\\bINSERT\\s+INTO\\s+(?:"?public"?\\.)?"?${t}"?(?![A-Za-z0-9_])`, 'i').test(src)) raw.push(`${file}: ${t}`);
    }
    for (const k of Object.keys(WRITERS)) expect(found[k]!.sort(), k).toEqual(WRITERS[k]!.sort());
    expect(raw).toEqual([]);
  });
});
