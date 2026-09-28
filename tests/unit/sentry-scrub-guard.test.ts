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

/** Comment-stripped source, read once: two tests below walk every app file. */
const strippedCache = new Map<string, string>();
function stripped(file: string): string {
  let src = strippedCache.get(file);
  if (src === undefined) {
    src = stripComments(readFileSync(file, 'utf8'), file);
    strippedCache.set(file, src);
  }
  return src;
}

function parse(file: string): ts.SourceFile {
  const src = stripped(file);
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

/** The object literal passed to the file's one init call. */
function initOptions(file: string): { sf: ts.SourceFile; props: ts.NodeArray<ts.ObjectLiteralElementLike> } {
  const sf = parse(file);
  const arg = sentryInitCalls(sf)[0]?.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error(`${file}: init takes no object literal`);
  return { sf, props: arg.properties };
}

/** The source text of `key`'s value in an options literal, or undefined when absent. */
function optionText(sf: ts.SourceFile, props: ts.NodeArray<ts.ObjectLiteralElementLike>, key: string): string | undefined {
  const p = props.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === key);
  if (!p) return undefined;
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
  return ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : '<not a plain property>';
}

/** Which module each of `names` is imported from, as a named import. */
function importedFrom(sf: ts.SourceFile, names: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of names) {
    out[name] = sf.statements
      .filter(ts.isImportDeclaration)
      .filter((d) => {
        const b = d.importClause?.namedBindings;
        return b && ts.isNamedImports(b) && b.elements.some((e) => e.name.text === name && !e.propertyName);
      })
      .map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
  }
  return out;
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

  it.each(INIT_SITES)('%s passes scrubEvent to beforeSend AND beforeSendTransaction, scrubSpan to beforeSendSpan, and never sendDefaultPii', (file) => {
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
    // Post-merge review (2026-09-29): a span sent on its own (the browser's INP
    // web vital) reaches neither hook above. This is the only one it reaches, and
    // inside a transaction it runs on every span before the transaction hook.
    expect(value('beforeSendSpan')).toBe('scrubSpan');
    expect(importedFrom(sf, ['scrubSpan'])).toEqual({ scrubSpan: ['@/lib/sentry-scrub'] });
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

  it('the server passes serverIntegrations(), which the envelope test proves records no request body', () => {
    // Review of the recheck fixes (2026-09-28): the SDK's default HTTP integration
    // kept every incoming body. tests/unit/sentry-envelope.test.ts posts a password
    // through a real server with serverIntegrations(); this pins that production
    // initialises with that same function and nothing else in its place.
    const file = 'sentry.server.config.ts';
    const sf = parse(file);
    const arg = sentryInitCalls(sf)[0]!.arguments[0] as ts.ObjectLiteralExpression;
    const p = arg.properties.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === 'integrations');
    expect(p && ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : undefined).toBe('serverIntegrations()');
    const from = sf.statements.filter(ts.isImportDeclaration).filter((d) => {
      const b = d.importClause?.namedBindings;
      return b && ts.isNamedImports(b) && b.elements.some((e) => e.name.text === 'serverIntegrations' && !e.propertyName);
    });
    expect(from.map((d) => (d.moduleSpecifier as ts.StringLiteral).text)).toEqual(['@/lib/sentry-server-integrations']);
  });

  it('the browser scrubs each breadcrumb as it is recorded, and sends no INP span', () => {
    // Post-merge review (2026-09-29). A click's breadcrumb and the INP span are
    // both named after the clicked element, aria-label included ("Select edit for
    // <legal name>"). The INP span goes out on its own, and when it starts its own
    // trace the SDK writes its name into the envelope HEADER before beforeSendSpan
    // runs, so no hook can clean it: it has to be off. Replacing the default
    // tracing integration by name is how the SDK takes an option for it.
    const file = 'instrumentation-client.ts';
    const { sf, props } = initOptions(file);
    expect(optionText(sf, props, 'beforeBreadcrumb')).toBe('scrubBreadcrumb');
    expect(importedFrom(sf, ['scrubBreadcrumb'])).toEqual({ scrubBreadcrumb: ['@/lib/sentry-scrub'] });

    const nextjs = new Set(
      sf.statements
        .filter(ts.isImportDeclaration)
        .filter((d) => (d.moduleSpecifier as ts.StringLiteral).text === '@sentry/nextjs')
        .map((d) => d.importClause?.namedBindings)
        .filter((b): b is ts.NamespaceImport => !!b && ts.isNamespaceImport(b))
        .map((b) => b.name.text)
    );
    const p = props.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === 'integrations');
    const list = p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
    expect(list && ts.isArrayLiteralExpression(list), 'integrations is an array literal this guard can read').toBe(true);
    // Exactly one entry: a second tracing instance later in the list (a named
    // import, say) would replace this one by name and bring INP back.
    expect((list as ts.ArrayLiteralExpression).elements, 'integrations holds only the tracing integration').toHaveLength(1);
    const tracing = (list as ts.ArrayLiteralExpression).elements.filter(
      (e): e is ts.CallExpression =>
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === 'browserTracingIntegration' &&
        ts.isIdentifier(e.expression.expression) &&
        // @sentry/nextjs's own, which adds the App Router instrumentation.
        nextjs.has(e.expression.expression.text)
    );
    expect(tracing, 'one browserTracingIntegration from @sentry/nextjs').toHaveLength(1);
    const opts = tracing[0]!.arguments[0];
    expect(opts && ts.isObjectLiteralExpression(opts), 'its options are an object literal').toBe(true);
    const optProps = (opts as ts.ObjectLiteralExpression).properties;
    expect(optProps.some((q) => ts.isSpreadAssignment(q)), 'no spread in its options').toBe(false);
    expect(optionText(sf, optProps, 'enableInp')).toBe('false');
    // CLS and LCP are sent on their own only through these experiments, off by
    // default in @sentry/browser 10.x; turning one on would bring the leak back.
    expect(optionText(sf, optProps, '_experiments')).toBeUndefined();
  });

  it('nothing else adds a tracing or web-vitals integration, or turns a standalone web vital on', () => {
    // An integration added after init, or a second tracing instance, would start
    // what the options above turned off. Span streaming (traceLifecycle 'stream'
    // or spanStreamingIntegration) sends LCP/CLS spans named after elements
    // without the plain beforeSendSpan. Counted per occurrence, so a second
    // tracing call in the client config fails too.
    const roots = readdirSync('.').filter((n) => /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n));
    const files = [...roots, ...['app', 'components', 'lib', 'services'].flatMap(tsFiles)];
    const words = [
      'browserTracingIntegration',
      'webVitalsIntegration',
      'addIntegration',
      'lazyLoadIntegration',
      'enableStandalone',
      'enableInteractions',
      'traceLifecycle',
      'spanStreamingIntegration',
    ];
    const hits: string[] = [];
    for (const f of files) {
      const src = stripped(f);
      for (const word of words) {
        const n = src.split(word).length - 1;
        if (n) hits.push(`${f.replace(/\\/g, '/')}: ${word} x${n}`);
      }
    }
    expect(hits).toEqual(['instrumentation-client.ts: browserTracingIntegration x1']);
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
