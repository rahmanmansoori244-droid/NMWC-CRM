/**
 * Launch fix (2026-10-09): components/nmwc/RouteSlot.tsx.
 *
 * The final launch run saw React error #418 (args[]=HTML) on full loads of
 * /approvals, /work, /users, /dashboard, /export and /today, followed by dozens of
 * "Cannot read properties of null (reading 'parentNode')". A debug hook in the
 * production build caught every one in the same place: completing the (app)
 * layout's <div class="flex-1"> with no child fibre, the hydration cursor on the
 * loading skeleton's <!--$?--> marker INSIDE that div. That is Next's React
 * (19.2.0-canary-0bdb9206-20250818) replaying a host element that suspended on a
 * lazy child: the replay claims a DOM node again from where the cursor now stands
 * (its own first child). The lazy child is the page slot, which Next's data reader
 * holds back while app/(app)/error.tsx's script is still loading. React 19.3
 * puts the cursor back before the replay; Next 15.5 does not ship it.
 *
 * Here, on the very builds the browser runs (next/dist/compiled, production):
 *   - the failure: <body><div>{slot}</div></body> with a slot that is ready one
 *     task after React first asks for it -> #418, and React throws away the
 *     server's page (the same <span> is no longer in the document);
 *   - the fix: the same with RouteSlot between the <div> and the slot -> no error,
 *     the server's DOM is kept;
 *   - <body> itself is safe (app/layout.tsx puts the slot straight in <body>):
 *     a singleton's replay claims nothing new;
 *   - and the layouts: the (app) slot sits in RouteSlot, and no layout puts
 *     {children} straight inside a host element other than <body>.
 *
 * The slot stand-in behaves like Next's data reader's placeholder: a lazy node
 * whose payload is a thenable with a `status`, fulfilled one microtask after
 * React first reads it (the client script arriving just then), which is what
 * makes React replay instead of unwinding.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/app/actions/auth', () => ({ logoutAction: async () => {} }));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', role: 'MANAGER', username: 'm.one', name: 'M One' } }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/approvals',
}));
vi.mock('next/headers', () => ({ headers: async () => new Map([['x-nonce', 'n0nce']]) }));
vi.mock('@/lib/db', () => ({ prisma: { notification: { groupBy: async () => [] } } }));

import { RouteSlot } from '@/components/nmwc/RouteSlot';
import AppLayout from '@/app/(app)/layout';
import RootLayout from '@/app/layout';

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
async function hydrateDocument(
  { React, Client }: { React: Reactish; Client: Clientish },
  shape: 'div > slot' | 'div > RouteSlot > slot' | 'body > slot'
) {
  const doc = document.implementation.createHTMLDocument('t');
  doc.documentElement.innerHTML =
    shape === 'body > slot'
      ? '<head></head><body><span>page</span></body>'
      : '<head></head><body><div class="flex-1"><span>page</span></div></body>';
  const serverSpan = doc.querySelector('span');
  const slot = slotLoadingScript(React.createElement('span', null, 'page'));
  const inBody =
    shape === 'body > slot'
      ? slot
      : React.createElement('div', { className: 'flex-1' }, shape === 'div > slot' ? slot : React.createElement(RouteSlot, null, slot));
  const errors: string[] = [];
  React.startTransition(() => {
    Client.hydrateRoot(doc, React.createElement('html', null, React.createElement('body', null, inBody)), {
      onRecoverableError: (e: unknown) => errors.push(String((e as Error)?.message ?? e)),
    });
  });
  await settle();
  return { errors, keptServerDom: doc.querySelector('span') === serverSpan, text: doc.body.textContent };
}

describe("Next's React replays a host element that suspended on its slot", () => {
  const next = nextsReact();

  it('runs on the vendored canary the browser gets', () => {
    expect(next.React.version).toBe('19.2.0-canary-0bdb9206-20250818');
  });

  it('<div>{slot}</div>: #418 (HTML), and the server page is thrown away — the launch failure', async () => {
    // If this ever passes cleanly, Next ships a React with the replay fix (19.3+):
    // RouteSlot can stay (it is harmless) — change this expectation and its comment.
    const r = await hydrateDocument(next, 'div > slot');
    expect(r.errors).toEqual([expect.stringMatching(/Minified React error #418;.*args\[\]=HTML/)]);
    expect(r.keptServerDom).toBe(false);
    expect(r.text).toBe('page');
  });

  it('<div><RouteSlot>{slot}</RouteSlot></div>: no error, the server page is kept', async () => {
    const r = await hydrateDocument(next, 'div > RouteSlot > slot');
    expect(r.errors).toEqual([]);
    expect(r.keptServerDom).toBe(true);
    expect(r.text).toBe('page');
  });

  it('<body>{slot}</body> is safe: a replayed <body> claims nothing new (app/layout.tsx)', async () => {
    const r = await hydrateDocument(next, 'body > slot');
    expect(r.errors).toEqual([]);
    expect(r.keptServerDom).toBe(true);
  });

  it("React 19.3 (node_modules) replays the bare <div> correctly: the bug is the vendored copy's", async () => {
    const React = req('react') as Reactish;
    const Client = req('react-dom/client') as Clientish;
    expect(React.version).toBe('19.3.0');
    const r = await hydrateDocument({ React, Client }, 'div > slot');
    expect(r.errors).toEqual([]);
    expect(r.keptServerDom).toBe(true);
  });
});

/** The element whose direct child is `target`, and that child's position, or null. */
function parentOf(node: ReactNode, target: unknown, parent: ReactElement | null = null): ReactElement | null {
  if (node === target) return parent;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = parentOf(n, target, parent);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    return parentOf(el.props.children, target, el);
  }
  return null;
}

describe('the layouts keep the page slot out of host elements', () => {
  // Any node will do: found by identity.
  const SLOT: ReactNode = <i data-marker="page slot" />;

  it('app/(app)/layout.tsx: the slot is the child of RouteSlot', async () => {
    const tree = await AppLayout({ children: SLOT });
    const parent = parentOf(tree, SLOT);
    expect(parent, 'the slot is rendered').not.toBeNull();
    expect(parent!.type).toBe(RouteSlot);
    // RouteSlot sits in the flex-1 column, so the page keeps its place.
    const column = parentOf(tree, parent);
    expect(column?.type).toBe('div');
    expect(String((column?.props as { className?: string }).className)).toMatch(/^flex-1 /);
  });

  it("RouteSlot stays a client component: without 'use client' RSC inlines it and the bug is back", () => {
    const src = readFileSync(join(process.cwd(), 'components/nmwc/RouteSlot.tsx'), 'utf8');
    expect(src.trimStart().startsWith("'use client'"), 'keep the first line of RouteSlot.tsx').toBe(true);
  });

  it('RouteSlot renders the slot and nothing else', () => {
    expect(RouteSlot({ children: SLOT })).toBe(SLOT);
  });

  it('app/layout.tsx: the slot is a direct child of <body> (a singleton: safe)', async () => {
    const tree = await RootLayout({ children: SLOT });
    expect(parentOf(tree, SLOT)?.type).toBe('body');
  });

  it('no layout or template puts {children} straight inside a host element other than <body>', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/^(layout|template)\.tsx$/.test(e)) files.push(p.replace(/\\/g, '/'));
      }
    };
    walk('app');
    expect(files).toEqual(expect.arrayContaining(['app/layout.tsx', 'app/(app)/layout.tsx']));
    const bad: string[] = [];
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node): void => {
        if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression) && n.expression.text === 'children') {
          const el = n.parent;
          if (ts.isJsxElement(el)) {
            const tag = el.openingElement.tagName.getText(sf);
            if (/^[a-z]/.test(tag) && tag !== 'body') {
              bad.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} <${tag}>{children}`);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bad, 'wrap the slot in <RouteSlot> (components/nmwc/RouteSlot.tsx)').toEqual([]);
  });
});
