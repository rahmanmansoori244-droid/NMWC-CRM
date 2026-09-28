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
 *  - where `<holders>` is `await liveTemixCodeHolders(tx, <x>.temixCode, …)` in
 *    the same function,
 *  - read after `await lockCustomersAndTemixCodeHolders(tx, …)`, which also comes
 *    before the function's first in-transaction customer read, with the
 *    moved-code refusal (`… .temixCode !== … .temixCode`) between the lock and
 *    the holders read.
 * Asserted on comment-stripped source parsed by TypeScript, so a comment quoting
 * any of these can neither satisfy nor break it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';

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

      // 2. <holders> is the live-holder read, in the same function, before the call.
      const body = text.slice(fn.getStart(sf), call.getStart(sf));
      const read = body.search(
        new RegExp(`const ${holders} = await liveTemixCodeHolders\\(tx, \\w+\\.temixCode, [\\w.]+\\);`)
      );
      expect(read, `${holders} is not read by liveTemixCodeHolders`).toBeGreaterThan(-1);

      // 3. The holders lock comes first — before the in-transaction customer
      //    read and the holders read — with the moved-code refusal in between.
      const lock = body.search(/await lockCustomersAndTemixCodeHolders\(tx, \[[^\]]+\], \w+\.temixCode\);/);
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
