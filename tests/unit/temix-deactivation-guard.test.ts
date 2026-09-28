/**
 * F11 — no path queues a Temix deactivation for a code a live customer still holds.
 *
 * The first fix covered the merge only: archiveCustomerAction still asked
 * resolveArchiveTemixState alone, which answers DEACTIVATE_PENDING for any coded
 * customer, so archiving one of two live customers sharing a code queued a
 * deactivation that Generate then held back on every run, for good. The defect
 * was a caller that did not ask, so this guard is structural: EVERY call of
 * resolveArchiveTemixState in app/, lib/, services/ and scripts/ must
 *  - be the fallback of `<holders>.length > 0 ? TemixSyncState.SYNCED : …`,
 *  - where `<holders>` is `await liveTemixCodeHolders(tx,
 *    archiveDeactivationCode(<x>), …)` in the same function, `<x>` read under
 *    the lock: the code the customer's deactivation would take, its customer code
 *    when it has no Temix code. Asked about `<x>.temixCode` alone, an uncoded
 *    customer known to Temix was queued for a deactivation Generate holds back
 *    for good (review of 8cb2509);
 *  - read after `await lockCustomersAndTemixCodeHolders(tx, …, deactivationCode(…))`,
 *    which also comes before the function's first in-transaction customer read,
 *    with the moved-code refusal (`… .temixCode !== … .temixCode`) between the
 *    lock and the holders read.
 * Asserted on comment-stripped source parsed by TypeScript, so a comment quoting
 * any of these can neither satisfy nor break it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';
import { TEMIX_QUEUE_WHERE } from '@/lib/temix';

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f).split(path.sep).join('/'))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
}

type Call = { file: string; call: ts.CallExpression; fn: ts.FunctionLikeDeclaration; sf: ts.SourceFile; text: string };

function callsOf(file: string): Call[] {
  const text = stripComments(readFileSync(file, 'utf8'), file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Call[] = [];
  const walk = (n: ts.Node, fn: ts.FunctionLikeDeclaration | null) => {
    const inFn = ts.isFunctionLike(n) && 'body' in n && n.body ? (n as ts.FunctionLikeDeclaration) : fn;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'resolveArchiveTemixState' &&
      inFn
    ) {
      out.push({ file, call: n, fn: inFn, sf, text });
    }
    ts.forEachChild(n, (c) => walk(c, inFn));
  };
  walk(sf, null);
  return out;
}

const calls = ['app', 'lib', 'services', 'scripts'].flatMap(sourceFiles).flatMap(callsOf);

describe('every resolveArchiveTemixState caller asks who else holds the Temix code first', () => {
  it('finds the known callers (archive and merge), so the rule is not vacuous', () => {
    const files = new Set(calls.map((c) => c.file));
    expect(files).toContain('services/customers.ts');
    expect(files).toContain('services/duplicates.ts');
  });

  it.each(calls.map((c) => [`${c.file}:${c.sf.getLineAndCharacterOfPosition(c.call.getStart()).line + 1}`, c]))(
    '%s parks SYNCED when a live holder exists, decided under the holders lock',
    (_where, c) => {
      const { call, fn, sf, text } = c as Call;
      // 1. The call is the fallback of `<holders>.length > 0 ? TemixSyncState.SYNCED : …`.
      const cond = call.parent;
      expect(ts.isConditionalExpression(cond)).toBe(true);
      const ce = cond as ts.ConditionalExpression;
      expect(ce.whenFalse).toBe(call);
      expect(ce.whenTrue.getText(sf)).toBe('TemixSyncState.SYNCED');
      const m = /^(\w+)\.length > 0$/.exec(ce.condition.getText(sf));
      expect(m, ce.condition.getText(sf)).not.toBeNull();
      const holders = m![1];

      // 2. <holders> is the live-holder read of the code the deactivation would
      //    take, in the same function, before the call.
      const body = text.slice(fn.getStart(sf), call.getStart(sf));
      const readRe = new RegExp(
        `const ${holders} = await liveTemixCodeHolders\\(tx, archiveDeactivationCode\\((\\w+)\\), [\\w.]+\\);`
      );
      const read = body.search(readRe);
      expect(read, `${holders} is not read by liveTemixCodeHolders(tx, archiveDeactivationCode(…))`).toBeGreaterThan(-1);
      const asked = readRe.exec(body)![1];

      // 3. The holders lock comes first — before the in-transaction customer
      //    read and the holders read — with the moved-code refusal in between,
      //    and the customer asked about is one read under that lock.
      const lock = body.search(/await lockCustomersAndTemixCodeHolders\(tx, \[[^\]]+\], deactivationCode\(\w+\)\);/);
      const askedRead = body
        .slice(Math.max(lock, 0))
        .search(new RegExp(`const (${asked}|\\[[^\\]]*\\b${asked}\\b[^\\]]*\\]) = await `));
      expect(askedRead, `${asked} is not read after the holders lock`).toBeGreaterThan(-1);
      const firstRead = body.search(/await tx\.customer\.findUnique(OrThrow)?\(/);
      const moved = body.search(/if \(\w+\.temixCode !== \w+\.temixCode\)/);
      expect(lock).toBeGreaterThan(-1);
      expect(firstRead).toBeGreaterThan(-1);
      expect(moved).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(firstRead);
      expect(lock).toBeLessThan(moved);
      expect(moved).toBeLessThan(read);
    }
  );
});

describe('the holders lock', () => {
  const locks = stripComments(readFileSync('lib/locks.ts', 'utf8'), 'lib/locks.ts');
  const fn = locks.slice(locks.indexOf('export async function lockCustomersAndTemixCodeHolders'));

  it('locks the live holders of the code with the named customers, in byte order, in one statement', () => {
    expect(fn).toMatch(
      /WHERE "id" IN \(\$\{ids\}\) OR \("temixCode" = \$\{temixCode\} AND "deletedAt" IS NULL\) ORDER BY "id" COLLATE "C" FOR UPDATE/
    );
    expect(fn).toMatch(/WHERE "id" IN \(\$\{ids\}\) ORDER BY "id" COLLATE "C" FOR UPDATE/);
  });
});

/**
 * Generate against archive and merge (review of 023173c): Generate's claim is one
 * UPDATE, which locks the queue in scan order, while archive and merge lock a
 * customer and the live holders of its code in id order — each could hold one of
 * a pair and wait for the other. Generate now locks the queue in the same order
 * first and claims only what it locked. The lock is raw SQL, so its predicate is
 * pinned to TEMIX_QUEUE_WHERE here: the unit fakes cannot read SQL.
 */
describe('Generate takes the queue locks in the holders lock order, before it writes', () => {
  const locks = stripComments(readFileSync('lib/locks.ts', 'utf8'), 'lib/locks.ts');
  const lockFn = locks.slice(locks.indexOf('export async function lockTemixQueue'));
  const temix = stripComments(readFileSync('services/temix.ts', 'utf8'), 'services/temix.ts');
  const generate = temix.slice(
    temix.indexOf('async function generateTemixBatchCore'),
    temix.indexOf('export async function downloadTemixBatchAction')
  );

  it('locks exactly the queue, in byte id order, in one statement', () => {
    const sql = /\$queryRaw<[^`]*>`([^`]*)`/.exec(lockFn)?.[1] ?? '';
    expect(sql).toBe(
      `SELECT "id" FROM "Customer" WHERE ("temixSyncState" = 'PENDING_UPLOAD' AND "deletedAt" IS NULL) OR "temixSyncState" = 'DEACTIVATE_PENDING' ORDER BY "id" COLLATE "C" FOR UPDATE`
    );
    // The same two lanes as the queue predicate: change one, change both.
    expect(TEMIX_QUEUE_WHERE).toEqual({
      OR: [{ temixSyncState: 'PENDING_UPLOAD', deletedAt: null }, { temixSyncState: 'DEACTIVATE_PENDING' }],
    });
  });

  it('is Generate’s first lock, and its flip claims only the rows it locked', () => {
    const lock = generate.search(/const (\w+) = await lockTemixQueue\(tx\);/);
    const locked = /const (\w+) = await lockTemixQueue\(tx\);/.exec(generate)?.[1];
    expect(lock, 'Generate does not call lockTemixQueue(tx)').toBeGreaterThan(-1);
    for (const write of ['tx.temixSyncBatch.create(', 'tx.customer.updateMany(']) {
      expect(generate.indexOf(write), write).toBeGreaterThan(lock);
    }
    expect(generate.indexOf('$queryRaw')).toBe(-1);
    const claim = /const (\w+) = (\w+)\.filter\(/.exec(generate.slice(lock));
    expect(claim?.[2]).toBe(locked);
    const flip = generate.slice(generate.indexOf('tx.customer.updateMany('));
    expect(flip.slice(0, 200)).toMatch(
      new RegExp(`where: \\{ AND: \\[TEMIX_QUEUE_WHERE, \\{ id: \\{ in: ${claim?.[1]} \\} \\}\\] \\}`)
    );
  });
});
