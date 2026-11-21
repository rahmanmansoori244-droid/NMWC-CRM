/**
 * Next 16 upgrade (2026-11-21): the two launch workarounds for bugs in the React
 * copy Next 15.5 shipped (19.2.0-canary-0bdb9206-20250818) are removed, because
 * the copy Next 16.4 ships has both fixes. This file proves it on the very builds
 * the browser is served (next/dist/compiled, production), so a later Next that
 * ships a React without them fails here instead of in the field.
 *
 * 1. The navigation hang (2026-10-08; components/nmwc/TransitionWatchdog.tsx,
 *    commit 8e47bc6, removed). A tap that changes only the query string, and
 *    router.refresh(), re-render the page inside the Suspense boundaries already
 *    on screen. When a piece of the RSC answer arrived while React's render was
 *    "suspended with delay", the "data is here" ping fired synchronously inside
 *    the render and that React dropped it: pingSuspendedRoot did nothing in the
 *    render phase. The transition stayed parked for good ("Filtering…" forever,
 *    "Created — loading…"). The fixed React records the ping
 *    (`workInProgressRootPingedLanes |= pingedLanes`). The watchdog stood in by
 *    reading React's private root fields twice a second. The browser-level proof
 *    is the launch suite: tests/e2e/launch/support/in-place.ts fails any in-place
 *    result that is not shown 15 s after the server finished (NAV_HANG).
 *
 * 2. The hydration replay (2026-10-09; components/nmwc/RouteSlot.tsx, removed).
 *    A host element whose child is the page slot (a lazy node while
 *    app/(app)/error.tsx's script loads) was replayed with the hydration cursor
 *    left inside it, so React threw #418 (args[]=HTML), threw away the server's
 *    page and the later streamed $RS scripts failed on parentNode. Fixed React
 *    puts the cursor back before the replay. Below: the exact launch failure
 *    shape, hydrated on Next's React, keeps the server's DOM with no error.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const req = createRequire(import.meta.url);

type Reactish = {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
  startTransition: (fn: () => void) => void;
  version: string;
};
type Clientish = { hydrateRoot: (c: Document | Element, el: unknown, o: object) => unknown };

/** Next's own React and react-dom client, production builds — what the browser is served. */
function nextsReact(): { React: Reactish; Client: Clientish } {
  // next/dist/compiled/react picks its build by NODE_ENV when first required; the
  // react-dom client below requires the same module, so both share one React.
  vi.stubEnv('NODE_ENV', 'production');
  try {
    return {
      React: req('next/dist/compiled/react') as Reactish,
      Client: req('next/dist/compiled/react-dom/cjs/react-dom-client.production.js') as Clientish,
    };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** Next's vendored react-dom client build and the version it carries (its package.json has none). */
function vendoredReactDom() {
  const at = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'react-dom');
  const src = readFileSync(join(at, 'cjs', 'react-dom-client.production.js'), 'utf8');
  return { src, version: /reconcilerVersion:\s*"([^"]+)"/.exec(src)?.[1] ?? '' };
}

/** The body of pingSuspendedRoot in a react-dom build. */
function pingSuspendedRoot(src: string): string {
  const start = src.indexOf('function pingSuspendedRoot(');
  expect(start, 'react-dom has no pingSuspendedRoot: investigate the new shape').toBeGreaterThan(-1);
  const end = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, end < 0 ? undefined : end);
}

// In the render-phase branch (a render "suspended with delay" pinged from inside the render):
//   BUGGY (Next 15.5's 19.2 canary) does nothing there:
//     `? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)`
//   FIXED (React 19.3) records the ping there:
//     `? 0 === (executionContext & 2) ? prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes) : …`
const BUGGY_PING =
  /\?\s*0 === \(executionContext & 2\) && prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;
const FIXED_PING =
  /0 === \(executionContext & 2\)\s*\?\s*prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;

describe("the navigation hang: Next's React records a ping that fires during the render", () => {
  const { src, version } = vendoredReactDom();

  it('runs on a 19.3 React (the release line with the fix)', () => {
    // Next 15.5.28's copy was 19.2.0-canary-0bdb9206-20250818: this, the ping check
    // and the #418 check below all fail on it (contrast run, 2026-11-21).
    expect(version, `Next's vendored react-dom is ${version || 'unversioned'}, older than 19.3`).toMatch(/^19\.(3|[4-9])\.|^(2\d)\./);
  });

  it('pingSuspendedRoot records a render-phase ping instead of dropping it', () => {
    const ping = pingSuspendedRoot(src);
    expect(BUGGY_PING.test(ping), `Next's vendored react-dom ${version} drops a render-phase ping again`).toBe(false);
    expect(FIXED_PING.test(ping), `Next's vendored react-dom ${version}: the fixed form is not there`).toBe(true);
  });

  it('the patterns tell the two forms apart (so the check above can fail)', () => {
    const buggy = 'function pingSuspendedRoot(root, wakeable, pingedLanes) { x ? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes); }';
    expect(BUGGY_PING.test(buggy)).toBe(true);
    expect(FIXED_PING.test(buggy)).toBe(false);
    expect(BUGGY_PING.test(pingSuspendedRoot(src))).toBe(false);
  });

  it('nothing in the app reads React’s private fields any more (the watchdog did)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e) && /__reactContainer\$|__reactFiber\$|_reactInternals/.test(readFileSync(p, 'utf8'))) {
          hits.push(p.replace(/\\/g, '/'));
        }
      }
    };
    for (const d of ['app', 'components', 'lib']) walk(d);
    expect(hits).toEqual([]);
  });
});

/** A lazy node like the one Next's data reader hands over while a client script loads. */
function slotLoadingScript(value: unknown) {
  type Chunk = { status: string; value: unknown; waiting: Array<(v: unknown) => void>; then(f: (v: unknown) => void): void };
  const chunk: Chunk = {
    status: 'pending',
    value: undefined,
    waiting: [],
    then(f) {
      if (this.status === 'fulfilled') f(this.value);
      else this.waiting.push(f);
    },
  };
  let asked = false;
  return {
    $$typeof: Symbol.for('react.lazy'),
    _payload: chunk,
    _init(c: Chunk) {
      if (c.status === 'fulfilled') return c.value;
      if (!asked) {
        asked = true;
        queueMicrotask(() => {
          c.status = 'fulfilled';
          c.value = value;
          for (const f of c.waiting) f(value);
        });
      }
      throw c;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 10));
};

/**
 * Hydrates a document whose server HTML is <body><div class="flex-1"><span>page</span></div></body>,
 * as Next does (inside startTransition), and reports React's recoverable errors
 * and whether the server's <span> survived.
 */
async function hydrateDocument({ React, Client }: { React: Reactish; Client: Clientish }, shape: 'div > slot' | 'body > slot') {
  const doc = document.implementation.createHTMLDocument('t');
  doc.documentElement.innerHTML =
    shape === 'body > slot'
      ? '<head></head><body><span>page</span></body>'
      : '<head></head><body><div class="flex-1"><span>page</span></div></body>';
  const serverSpan = doc.querySelector('span');
  const slot = slotLoadingScript(React.createElement('span', null, 'page'));
  const inBody = shape === 'body > slot' ? slot : React.createElement('div', { className: 'flex-1' }, slot);
  const errors: string[] = [];
  React.startTransition(() => {
    Client.hydrateRoot(doc, React.createElement('html', null, React.createElement('body', null, inBody)), {
      onRecoverableError: (e: unknown) => errors.push(String((e as Error)?.message ?? e)),
    });
  });
  await settle();
  return { errors, keptServerDom: doc.querySelector('span') === serverSpan, text: doc.body.textContent };
}

describe("the hydration replay: Next's React replays a host element that suspended on its slot correctly", () => {
  const next = nextsReact();

  it('runs on the vendored copy the browser gets', () => {
    expect(next.React.version).toBe(vendoredReactDom().version);
  });

  it('<div>{slot}</div> (the launch failure shape): no #418, the server page is kept', async () => {
    const r = await hydrateDocument(next, 'div > slot');
    expect(r.errors).toEqual([]);
    expect(r.keptServerDom).toBe(true);
    expect(r.text).toBe('page');
  });

  it('<body>{slot}</body> stays safe', async () => {
    const r = await hydrateDocument(next, 'body > slot');
    expect(r.errors).toEqual([]);
    expect(r.keptServerDom).toBe(true);
  });
});
