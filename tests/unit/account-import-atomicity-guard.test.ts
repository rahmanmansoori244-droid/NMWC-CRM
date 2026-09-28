/**
 * F07 / X-IMPORTS-1 / X-IMPORTS-3 — the account-master import's shape, pinned on
 * its source (services/imports.ts, uploadAccountMasterCore).
 *
 * The defects these stop coming back were each "a write that nothing held
 * together": the password and role audits written with `writeAudit(null, …)`
 * after the row's transaction had committed, the managed-region `set` as a
 * separate `prisma.user.update` after it, region and route upserts with no audit
 * row at all, and reads outside the row's try so one pool timeout escaped the
 * upload after earlier rows had committed. account-import-service.test.ts proves
 * the behaviour; this proves the next edit cannot quietly put a write back
 * outside its transaction, where no behavioural test would look.
 *
 * Comments are stripped first (CLAUDE.md): the comments in that function quote
 * `writeAudit(null` and `prisma.user.update` while explaining why they are gone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

/** The body of `async function <name>(`, up to its closing brace at column 0. */
function functionSource(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`end of ${name} not found`);
  return src.slice(start, end + 2);
}

/** [open, close] offsets of every `<token>` group, the bracket after it matched. */
function ranges(
  code: string,
  token: string,
  open: '(' | '{',
  close: ')' | '}'
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = code.indexOf(token); i >= 0; i = code.indexOf(token, i + token.length)) {
    let j = code.indexOf(open, i + token.length - 1);
    let depth = 0;
    for (; j < code.length; j++) {
      if (code[j] === open) depth++;
      else if (code[j] === close && --depth === 0) break;
    }
    out.push([i, j]);
  }
  return out;
}

const positions = (code: string, re: RegExp) =>
  [...code.matchAll(re)].map((m) => ({ at: m.index!, text: m[0] }));
const within = (at: number, rs: Array<[number, number]>) => rs.find(([a, b]) => at > a && at < b);

type Report = {
  auditNull: string[];
  directWrites: string[];
  unauditedTxWrites: string[];
  readsOutsideTry: string[];
};

function inspect(fn: string): Report {
  const txRanges = ranges(fn, '$transaction(', '(', ')');
  const tryRanges = ranges(fn, 'try {', '{', '}');
  const auditNull = positions(fn, /writeAudit\(null\b/g).map(({ at }) => {
    const call = fn.slice(at, fn.indexOf('});', at));
    return /entityType: 'ImportBatch'/.test(call) ? 'summary' : `writeAudit(null at ${at}`;
  });
  const directWrites = positions(
    fn,
    /\bprisma\.(user|region|route|auditLog)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g
  ).map((p) => p.text);
  const unauditedTxWrites = positions(
    fn,
    /\btx\.(user|region|route)\.(create|createMany|update|updateMany|upsert)\(/g
  )
    .filter(({ at }) => {
      const r = within(at, txRanges);
      return !r || !fn.slice(r[0], r[1]).includes('writeAudit(tx');
    })
    .map((p) => p.text);
  // Every database call a row makes sits in a try. The one exception is the batch
  // itself, created before any row: a failure there has written nothing, so
  // runAction's "Nothing was saved" is true.
  const readsOutsideTry = positions(fn, /\bprisma\.(\$transaction|[a-zA-Z]+\.[a-zA-Z]+)\(/g)
    .filter(({ text }) => text !== 'prisma.importBatch.create(')
    .filter(({ at }) => !within(at, tryRanges))
    .map((p) => p.text);
  return { auditNull, directWrites, unauditedTxWrites, readsOutsideTry };
}

const SRC = stripComments(readFileSync('services/imports.ts', 'utf8'), 'services/imports.ts');
const CORE = functionSource(SRC, 'uploadAccountMasterCore');

describe('uploadAccountMasterCore keeps every write with its audit row', () => {
  it('writes no audit row outside a transaction except the batch summary', () => {
    expect(inspect(CORE).auditNull).toEqual(['summary']);
  });

  it('never writes a user, region or route through the top-level client', () => {
    expect(inspect(CORE).directWrites).toEqual([]);
  });

  it('writes users, regions and routes only in a transaction that also writes an audit row', () => {
    const { unauditedTxWrites } = inspect(CORE);
    expect(unauditedTxWrites).toEqual([]);
    // And there is something to check: the guard is not vacuously green.
    expect(CORE).toMatch(/tx\.user\.upsert\(/);
    expect(CORE).toMatch(/tx\.region\.create\(/);
    expect(CORE).toMatch(/tx\.route\.update\(/);
  });

  it('makes every database call a row needs inside a try, so a fault costs the row and not the upload', () => {
    expect(inspect(CORE).readsOutsideTry).toEqual([]);
  });

  // Post-merge review (2026-09-29): the reset's two password-history steps were a
  // correct helper nothing in the import called.
  it('checks a reset password for reuse before the write, and rotates the history inside the row transaction', () => {
    const txRanges = ranges(CORE, '$transaction(', '(', ')');
    const tryRanges = ranges(CORE, 'try {', '{', '}');
    const reuse = positions(CORE, /\bassertPasswordNotReused\(/g);
    const rotate = positions(CORE, /\brotatePasswordHistory\(tx,/g);
    expect(reuse).toHaveLength(1);
    expect(within(reuse[0].at, tryRanges)).toBeTruthy();
    expect(within(reuse[0].at, txRanges)).toBeUndefined();
    expect(rotate).toHaveLength(1);
    expect(within(rotate[0].at, txRanges)).toBeTruthy();
  });
});

describe('the guard fires on the shapes it exists to stop', () => {
  const wrap = (body: string) =>
    functionSource(
      `async function uploadAccountMasterCore() {\n${body}\n}\n`,
      'uploadAccountMasterCore'
    );

  it('an audit written after the commit', () => {
    const fn = wrap(`
      try {
        await prisma.$transaction(async (tx) => { await tx.user.upsert({}); await writeAudit(tx, env, {}); });
        await writeAudit(null, env, { action: 'UPDATE', entityType: 'User', reason: 'role_change_via_import' });
      } catch {}
      await writeAudit(null, env, { action: 'IMPORT', entityType: 'ImportBatch' });`);
    expect(inspect(fn).auditNull).toEqual([
      expect.stringMatching(/^writeAudit\(null at /),
      'summary',
    ]);
  });

  it('a region set as a separate update after the transaction', () => {
    const fn = wrap(
      `try { await prisma.user.update({ data: { managedRegions: { set: [] } } }); } catch {}`
    );
    expect(inspect(fn).directWrites).toEqual(['prisma.user.update(']);
  });

  it('a write in a transaction with no audit row', () => {
    const fn = wrap(
      `try { await prisma.$transaction(async (tx) => { await tx.route.update({}); }); } catch {}`
    );
    expect(inspect(fn).unauditedTxWrites).toEqual(['tx.route.update(']);
  });

  it('a read outside the row try', () => {
    const fn = wrap(`
      const region = await prisma.region.findUnique({ where: { code } });
      try { await prisma.$transaction(async (tx) => { await tx.route.create({}); await writeAudit(tx, env, {}); }); } catch {}`);
    expect(inspect(fn).readsOutsideTry).toEqual(['prisma.region.findUnique(']);
  });

  it('is not fooled by a comment', () => {
    const fn = wrap(
      stripComments(`
      // await prisma.user.update(...) and writeAudit(null, ...) used to live here
      try { await prisma.$transaction(async (tx) => { await tx.user.upsert({}); await writeAudit(tx, env, {}); }); } catch {}`)
    );
    expect(inspect(fn)).toEqual({
      auditNull: [],
      directWrites: [],
      unauditedTxWrites: [],
      readsOutsideTry: [],
    });
  });
});
