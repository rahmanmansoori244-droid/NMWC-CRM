/**
 * X-TEMIX-2 — every workbook the app hands out leaves an EXPORT row in the ledger.
 *
 * The Temix batch re-download rebuilt a workbook of names, phones, CR numbers,
 * addresses and credit limits and wrote nothing but a log line, while every
 * other export (the master, the filtered list, the change report, Generate)
 * writes an EXPORT audit row that fails closed. The defect was "nobody called
 * it", so this is a structural guard: every function in services/ or app/ that
 * obtains workbook bytes must itself call writeAudit(…, { action: 'EXPORT' … }).
 *
 * "Obtains the bytes" means it calls a workbook builder — lib/excel's, or a lib
 * builder registered below — or a helper in its own file that does and is only
 * a helper (not exported, no audit of its own, called from elsewhere in the
 * file, like services/temix.ts buildBatchWorkbook). The function holding the
 * bytes is the one that must write the row.
 *
 * Asserted on comment-stripped source parsed by TypeScript, so a comment quoting
 * `action: 'EXPORT'` can neither satisfy nor break it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';

const EXCEL_BUILDERS = ['buildWorkbook', 'buildWorkbookStreamed', 'openStreamedWorkbook'];

/**
 * lib/ files that build a workbook for a caller elsewhere, and the functions
 * they export for it. A new one must be added here, which puts its callers
 * under the rule.
 */
const LIB_BUILDERS: Record<string, string[]> = {
  'lib/change-report.ts': ['buildChangeReport'],
};

type Fn = { name: string; exported: boolean; calls: Set<string>; audits: boolean };

const EXPORT_AUDIT = /writeAudit\(\s*[^,]+,\s*[^,]+,\s*\{\s*action:\s*'EXPORT'/;

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f).split(path.sep).join('/'))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
}

function functionsOf(file: string): Fn[] {
  const text = stripComments(readFileSync(file, 'utf8'), file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Fn[] = [];
  const exported = (n: ts.Node) =>
    (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false;
  const describe = (name: string, isExported: boolean, body: ts.Node) => {
    const calls = new Set<string>();
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.add(n.expression.text);
      ts.forEachChild(n, walk);
    };
    walk(body);
    out.push({ name, exported: isExported, calls, audits: EXPORT_AUDIT.test(body.getText(sf)) });
  };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) describe(s.name.text, exported(s), s.body);
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          describe(d.name.text, exported(s), init.body);
        }
      }
    }
  }
  return out;
}

/** Every function that must write the EXPORT row, as `file#name`, with whether it does. */
function obligations(): Map<string, boolean> {
  const builders = new Set([...EXCEL_BUILDERS, ...Object.values(LIB_BUILDERS).flat()]);
  const out = new Map<string, boolean>();
  for (const file of [...sourceFiles('services'), ...sourceFiles('app')]) {
    const fns = functionsOf(file);
    const direct = fns.filter((f) => [...f.calls].some((c) => builders.has(c)));
    const calledHere = (name: string) => fns.some((f) => f.name !== name && f.calls.has(name));
    const helpers = new Set(
      direct.filter((f) => !f.exported && !f.audits && calledHere(f.name)).map((f) => f.name)
    );
    for (const f of fns) {
      if (helpers.has(f.name)) continue;
      const builds = [...f.calls].some((c) => builders.has(c) || helpers.has(c));
      if (builds) out.set(`${file}#${f.name}`, f.audits);
    }
  }
  return out;
}

describe('X-TEMIX-2: every workbook export writes an EXPORT audit row', () => {
  it('the lib builders are the registered ones — a new one must be registered to be guarded', () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles('lib')) {
      if (file === 'lib/excel.ts') continue;
      const fns = functionsOf(file).filter((f) => [...f.calls].some((c) => EXCEL_BUILDERS.includes(c)));
      const exportedBuilders = fns.filter((f) => f.exported).map((f) => f.name);
      if (fns.length) found[file] = exportedBuilders;
    }
    expect(found).toEqual(LIB_BUILDERS);
  });

  it('every function holding workbook bytes in services/ and app/ writes the row itself', () => {
    const all = obligations();
    // Not vacuous: the exports this rule exists for are all found.
    expect([...all.keys()].sort()).toEqual(
      expect.arrayContaining([
        'app/api/exports/changes/route.ts#GET',
        'services/customer-export.ts#exportFilteredCustomersCore',
        'services/exports.ts#buildCustomerExport',
        'services/temix.ts#downloadTemixBatchAction',
        'services/temix.ts#generateTemixBatchCore',
      ])
    );
    const missing = [...all].filter(([, audits]) => !audits).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
