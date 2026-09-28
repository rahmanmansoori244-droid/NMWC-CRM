// @vitest-environment node
/**
 * N07 / SEC-14d / B6: the scrubber only protects the events it is WIRED to.
 *
 * Each past defect here was wiring, not logic: the Edge runtime had no
 * `beforeSend` at all (B6), all three runtimes lacked `beforeSendTransaction`
 * (SEC-14d), and the browser SDK never initialised (DO-04). No behavioural test
 * can see a hook that is missing — tests/unit/sentry-envelope.test.ts wires the
 * function itself — so this reads the real init calls, comments stripped, through
 * the TypeScript parser.
 *
 * It also pins that the scrubber can RUN everywhere it is wired: the same module
 * is bundled into the browser and the Edge runtime, where a Node API is a crash
 * inside `beforeSend` — and a crashing hook means the event is sent unscrubbed or
 * not at all, depending on the SDK version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';

const INIT_SITES = ['sentry.server.config.ts', 'sentry.edge.config.ts', 'instrumentation-client.ts'];

function parse(file: string): ts.SourceFile {
  const src = stripComments(readFileSync(file, 'utf8'), file);
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** Every `<x>.init(...)` whose receiver is a namespace imported from a Sentry package. */
function sentryInitCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const namespaces = new Set<string>();
  const named = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!st.moduleSpecifier.text.startsWith('@sentry/')) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    if (b && ts.isNamedImports(b)) for (const e of b.elements) if ((e.propertyName ?? e.name).text === 'init') named.add(e.name.text);
  }
  const calls: ts.CallExpression[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const c = n.expression;
    if (ts.isPropertyAccessExpression(c) && c.name.text === 'init' && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text)) calls.push(n);
    if (ts.isIdentifier(c) && named.has(c.text)) calls.push(n);
  });
  return calls;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n.startsWith('.') ? [] : tsFiles(p);
    return /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
  });
}

describe('every Sentry runtime is initialised with the scrubber on both hooks', () => {
  it('the three configs are the only places the SDK is initialised', () => {
    // A fourth init — a second client config, a worker — would start a client
    // this guard does not read. Everything the app is built from is searched.
    const roots = readdirSync('.').filter((n) => /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n));
    const files = [...roots, ...['app', 'components', 'lib', 'services'].flatMap(tsFiles)];
    const sites = files.filter((f) => sentryInitCalls(parse(f)).length > 0).map((f) => f.replace(/\\/g, '/'));
    expect(sites.sort()).toEqual([...INIT_SITES].sort());
  });

  it.each(INIT_SITES)('%s passes scrubEvent to beforeSend AND beforeSendTransaction, and never sendDefaultPii', (file) => {
    const sf = parse(file);
    const calls = sentryInitCalls(sf);
    expect(calls, 'exactly one init').toHaveLength(1);
    const arg = calls[0]!.arguments[0];
    expect(arg && ts.isObjectLiteralExpression(arg), 'init takes an object literal this guard can read').toBe(true);
    const props = (arg as ts.ObjectLiteralExpression).properties;
    // A spread could bring in any key, including a second beforeSend after ours.
    expect(props.some((p) => ts.isSpreadAssignment(p)), 'no spread in the init options').toBe(false);
    const value = (key: string) => {
      const p = props.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === key);
      if (!p) return undefined;
      if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
      return ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : '<not a plain property>';
    };
    expect(value('beforeSend')).toBe('scrubEvent');
    expect(value('beforeSendTransaction')).toBe('scrubEvent');
    // Off by default; `true` makes the SDK attach IP addresses, cookies and the
    // user — the very things the scrubber is removing.
    expect(['false', undefined]).toContain(value('sendDefaultPii'));
    // And `scrubEvent` really is the app's scrubber, not a local of the same name.
    const imports = sf.statements.filter(ts.isImportDeclaration).filter((d) => {
      const b = d.importClause?.namedBindings;
      return b && ts.isNamedImports(b) && b.elements.some((e) => e.name.text === 'scrubEvent');
    });
    expect(imports.map((d) => (d.moduleSpecifier as ts.StringLiteral).text)).toEqual(['@/lib/sentry-scrub']);
  });
});

describe('the scrubber runs in the browser and on the Edge', () => {
  // lib/sentry-scrub.ts and the one module it imports at runtime, lib/scrub.ts.
  const MODULES = ['lib/sentry-scrub.ts', 'lib/scrub.ts'];

  it.each(MODULES)('%s imports nothing at runtime but lib/scrub', (file) => {
    const sf = parse(file);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      const from = (st.moduleSpecifier as ts.StringLiteral).text;
      // A type-only import is erased at build time; anything else is bundled.
      if (st.importClause?.isTypeOnly) continue;
      expect(from, `${file} imports ${from} at runtime`).toBe('./scrub');
    }
  });

  it.each(MODULES)('%s touches no Node global except behind a typeof guard', (file) => {
    const sf = parse(file);
    const found: string[] = [];
    walk(sf, (n) => {
      if (!ts.isIdentifier(n)) return;
      if (['require', 'Buffer', '__dirname', '__filename', 'global'].includes(n.text)) found.push(n.text);
      if (n.text !== 'process') return;
      // Allowed only as `typeof process !== 'undefined' ? process.env?.X : undefined`,
      // the one read of the alert webhook, which is absent off the server.
      let p: ts.Node | undefined = n.parent;
      let guarded = false;
      while (p && !guarded) {
        if (ts.isConditionalExpression(p) && /typeof process !== 'undefined'/.test(p.condition.getText(sf))) guarded = true;
        p = p.parent;
      }
      if (!guarded) found.push(`process at ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    });
    expect(found).toEqual([]);
  });
});
