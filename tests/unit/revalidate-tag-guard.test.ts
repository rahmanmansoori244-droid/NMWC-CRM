/**
 * Next 16 upgrade (2026-11-21): every revalidateTag() call says `{ expire: 0 }`.
 *
 * The reference-data dropdowns (lib/reference-data.ts) are 5-minute caches that
 * the writers in services/ bust after a change, so a manager sees the route or
 * salesman they just created at once. Next 16 made the second argument required;
 * the old one-argument form meant `{ expire: 0 }` (the next read is fresh). The
 * docs recommend `'max'`, which would serve the stale list once more while it
 * refreshes: typecheck, lint and every unit test (they mock next/cache) would
 * pass, and the created route would be missing from the next dropdown. This
 * reads the source as TypeScript, so a comment cannot satisfy or fail it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

type Call = { at: string; ok: boolean; text: string };

function revalidateTagCalls(): Call[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p.replace(/\\/g, '/'));
    }
  };
  for (const d of ['app', 'components', 'lib', 'services']) walk(d);
  const calls: Call[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('revalidateTag')) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'revalidateTag') {
        const profile = n.arguments[1];
        const ok =
          n.arguments.length === 2 &&
          !!profile &&
          ts.isObjectLiteralExpression(profile) &&
          profile.properties.length === 1 &&
          profile.properties.every(
            (p) =>
              ts.isPropertyAssignment(p) &&
              p.name.getText(sf) === 'expire' &&
              ts.isNumericLiteral(p.initializer) &&
              p.initializer.text === '0'
          );
        calls.push({ at: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, ok, text: n.getText(sf) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return calls;
}

describe('revalidateTag keeps the one-argument behaviour (expire at once)', () => {
  const calls = revalidateTagCalls();

  it('finds the writers that bust the dropdown caches (non-vacuous)', () => {
    // services/imports.ts, routes.ts and users.ts: 11 calls on 2026-11-21.
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(new Set(calls.map((c) => c.at.split(':')[0]))).toEqual(
      new Set(['services/imports.ts', 'services/routes.ts', 'services/users.ts'])
    );
  });

  it("every call passes exactly { expire: 0 } (not 'max', not one argument)", () => {
    expect(calls.filter((c) => !c.ok).map((c) => `${c.at} ${c.text}`)).toEqual([]);
  });
});
