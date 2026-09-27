// @vitest-environment node
/**
 * Item 10 (re-benchmark, 2026-09-24): "no log search". With the Pro plan, Vercel
 * keeps 30 days of runtime logs and can search them. Three things had to be true
 * for that to help:
 *
 *   1. Errors are filed as errors. Vercel decides a line's level by its STREAM;
 *      pino wrote everything to stdout, so every logger.error was "info".
 *   2. The Reference a user reads off the error screen is in the logs as itself.
 *      The phone scrubber redacted it (a digest is a 7–12 digit run).
 *   3. Every server error writes that reference, with the route it happened on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { callArguments, sourceFiles } from '../support/call-args';
import { stripComments } from '../support/strip-comments';

describe('1. warnings and errors go to stderr, everything else to stdout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes by level, once each', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    vi.resetModules();
    const { logger } = await import('@/lib/logger');
    logger.info('probe-info');
    logger.warn('probe-warn');
    logger.error('probe-error');
    const o = out.join('');
    const e = err.join('');
    expect(o).toContain('probe-info');
    expect(o).not.toContain('probe-warn');
    expect(o).not.toContain('probe-error');
    expect(e).toContain('probe-warn');
    expect(e).toContain('probe-error');
    expect(e).not.toContain('probe-info');
    // Levels as words, so a line reads and searches as what it is.
    expect(e).toContain('"level":"error"');
  });
});

describe('2. the reference survives the scrubber, and only under its own key', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a digest, still redacts the same digits anywhere else', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    vi.resetModules();
    const { logger } = await import('@/lib/logger');
    logger.error({ digest: '2847590223', note: 'ref 2847590223', phone: '91234567' }, 'x');
    const line = JSON.parse(err.join('').trim().split('\n').at(-1)!);
    expect(line.digest).toBe('2847590223');
    expect(line.note).toBe('ref [phone]');
    expect(line.phone).toBe('[phone]');
  });

  it('a value that is not digest-shaped under that key is still scrubbed', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    vi.resetModules();
    const { logger } = await import('@/lib/logger');
    logger.error({ digest: 'call 91234567 now' }, 'x');
    const line = JSON.parse(err.join('').trim().split('\n').at(-1)!);
    expect(line.digest).toBe('call [phone] now');
  });

  it('a `digest` nested inside a logged object is scrubbed: the exemption is top level only', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    vi.resetModules();
    const { logger } = await import('@/lib/logger');
    logger.error({ ctx: { digest: '91234567' } }, 'x');
    const line = JSON.parse(err.join('').trim().split('\n').at(-1)!);
    expect(line.ctx.digest).toBe('[phone]');
  });

  it('a Reference carrying Next’s error code is kept whole', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    vi.resetModules();
    const { logger } = await import('@/lib/logger');
    logger.error({ digest: '2847590223@E394' }, 'x');
    const line = JSON.parse(err.join('').trim().split('\n').at(-1)!);
    expect(line.digest).toBe('2847590223@E394');
  });

  it('`digest` is reserved for an error’s digest: every logger call is checked, shorthand included', () => {
    // The exemption is keyed on the name, so the name is the control. Every call's
    // whole argument text (balanced-bracket scan, comments stripped); any property
    // named digest — written out, or shorthand — must read an error's .digest.
    const files = [...sourceFiles(['app', 'lib', 'services', 'components']), 'instrumentation.ts'];
    let seen = 0;
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'), f);
      for (const args of callArguments(src, /\blogger\.(?:trace|debug|info|warn|error|fatal|child)\b/)) {
        // A property named digest: not a member access (.digest / ?.digest).
        for (const m of args.matchAll(/(?<![.\w])digest\b(?!\s*\()/g)) {
          seen += 1;
          const rest = args.slice(m.index!);
          // The whole value is an error's digest — `e?.digest ?? phone` is not.
          expect(rest, `${f}: ${rest.slice(0, 60)}`).toMatch(/^digest\s*:\s*(?:error|err|e)\??\.digest\s*(?:,|\}|$)/);
        }
        // A computed key could put anything under the exempt name.
        expect(args, `${f}: a computed key in a logger call`).not.toMatch(/\[\s*(DIGEST_KEY|['"`]digest['"`])\s*\]/);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3); // app/error.tsx, app/(app)/error.tsx, instrumentation.ts
  });
});

describe('3. every server error logs its reference and route', () => {
  it('onRequestError writes request.error with the digest and the route TEMPLATE, then reports to Sentry', async () => {
    vi.resetModules();
    const error = vi.fn();
    const capture = vi.fn();
    vi.doMock('@/lib/logger', () => ({ logger: { error } }));
    vi.doMock('./lib/logger', () => ({ logger: { error } }));
    vi.doMock('@sentry/nextjs', () => ({ captureRequestError: capture }));
    const prev = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'nodejs';
    try {
      const { onRequestError } = await import('@/instrumentation');
      const err = Object.assign(new Error('boom'), { digest: '2847590223' });
      const request = { path: '/customers?q=Al%20Nahda', method: 'GET', headers: {} };
      const context = { routerKind: 'App Router', routePath: '/customers', routeType: 'render', renderSource: 'react-server-components', revalidateReason: undefined, renderType: 'dynamic' };
      await onRequestError(err, request, context as never);
      expect(error).toHaveBeenCalledTimes(1);
      const [fields, msg] = error.mock.calls[0]!;
      expect(msg).toBe('request.error');
      expect(fields).toMatchObject({ digest: '2847590223', method: 'GET', route: '/customers', routeType: 'render' });
      // Never the real path: it carries the search term.
      expect(JSON.stringify(fields)).not.toContain('Nahda');
      expect(capture).toHaveBeenCalledWith(err, request, context);
    } finally {
      process.env.NEXT_RUNTIME = prev;
      vi.doUnmock('@/lib/logger');
      vi.doUnmock('./lib/logger');
      vi.doUnmock('@sentry/nextjs');
    }
  });

  it('a logging failure never costs the Sentry report', async () => {
    vi.resetModules();
    const capture = vi.fn();
    vi.doMock('@/lib/logger', () => ({ logger: { error: () => { throw new Error('stdout closed'); } } }));
    vi.doMock('./lib/logger', () => ({ logger: { error: () => { throw new Error('stdout closed'); } } }));
    vi.doMock('@sentry/nextjs', () => ({ captureRequestError: capture }));
    const prev = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'nodejs';
    try {
      const { onRequestError } = await import('@/instrumentation');
      await onRequestError(new Error('x'), { path: '/', method: 'GET', headers: {} }, { routePath: '/', routeType: 'render' } as never);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NEXT_RUNTIME = prev;
      vi.doUnmock('@/lib/logger');
      vi.doUnmock('./lib/logger');
      vi.doUnmock('@sentry/nextjs');
    }
  });
});
