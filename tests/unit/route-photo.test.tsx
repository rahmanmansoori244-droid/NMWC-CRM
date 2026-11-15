/**
 * Large-customer photos, part B: RoutePhoto and PhotoQueueStatus
 * (components/nmwc/RoutePhoto.tsx, PhotoQueueStatus.tsx).
 *
 * 'direct' must leave a small page's server HTML exactly as it was: the
 * markup is compared, as a string, with the <img> each screen rendered before
 * (the profile tile, the profile's CR pill, the approval thumbnail), and the
 * hydration of that markup must log nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';

vi.mock('@/components/nmwc/photo-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/nmwc/photo-queue')>();
  return {
    ...real,
    reportFirstLoadFailure: vi.fn(real.reportFirstLoadFailure),
    retryFailed: vi.fn(real.retryFailed),
  };
});

import { RoutePhoto } from '@/components/nmwc/RoutePhoto';
import { PhotoQueueStatus } from '@/components/nmwc/PhotoQueueStatus';
import * as queue from '@/components/nmwc/photo-queue';

const ID = 'c0ffee00-0000-4000-8000-000000000001';
const SRC = `/api/photos/${ID}`;

/** The three <img> the pages rendered before part B, prop for prop. */
const TODAY = [
  { name: 'profile tile', alt: 'Shop', className: 'absolute inset-0 h-full w-full object-cover' },
  { name: 'profile CR pill', alt: 'CR document', className: 'h-10 w-10 rounded object-cover ring-1 ring-emerald-200' },
  { name: 'approval thumbnail', alt: 'Photos', className: 'h-20 w-20 rounded-md object-cover ring-1 ring-slate-200' },
] as const;

let root: Root | null = null;
let container: HTMLDivElement;
const restore: (() => void)[] = [];

function stubImage(prop: 'complete' | 'naturalWidth', value: unknown) {
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, prop)!;
  Object.defineProperty(HTMLImageElement.prototype, prop, { configurable: true, get: () => value });
  restore.push(() => Object.defineProperty(HTMLImageElement.prototype, prop, d));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queue.resetPhotoQueueForTests();
  vi.mocked(queue.reportFirstLoadFailure).mockClear();
  vi.mocked(queue.retryFailed).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  while (restore.length) restore.pop()!();
  queue.resetPhotoQueueForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(el: React.ReactElement) {
  act(() => {
    root = createRoot(container);
    root.render(el);
  });
}
const imgs = () => [...container.querySelectorAll('img')];
const fire = (el: Element, type: 'load' | 'error') => act(() => void el.dispatchEvent(new Event(type)));

describe("RoutePhoto 'direct'", () => {
  for (const t of TODAY) {
    it(`server markup equals today's <img> for the ${t.name}, and hydration logs nothing`, async () => {
      const today = renderToString(
        // eslint-disable-next-line @next/next/no-img-element
        <img src={SRC} alt={t.alt} className={t.className} />
      );
      const el = <RoutePhoto id={ID} alt={t.alt} className={t.className} mode="direct" />;
      const html = renderToString(el);
      expect(html).toBe(today);
      expect(html).not.toContain('data-photo-state');
      expect(html).toContain(`<img src="${SRC}" alt="${t.alt}" class="${t.className}"/>`);

      const logged: unknown[] = [];
      for (const level of ['error', 'warn'] as const)
        vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a));
      const errors: unknown[] = [];
      container.innerHTML = html;
      const before = container.querySelector('img');
      await act(async () => {
        root = hydrateRoot(container, el, { onRecoverableError: (e) => errors.push(e) });
      });
      expect(errors).toEqual([]);
      expect(logged).toEqual([]);
      // The same node, untouched.
      expect(container.querySelector('img')).toBe(before);
      expect(container.querySelector('img')!.outerHTML).toBe(`<img src="${SRC}" alt="${t.alt}" class="${t.className}">`);
    });
  }

  it('at mount, an <img> already complete with naturalWidth 0 (failed before hydration) is reported and asked for again', () => {
    vi.useFakeTimers();
    const html = renderToString(<RoutePhoto id={ID} alt="Shop" className="x" mode="direct" />);
    container.innerHTML = html;
    const first = container.querySelector('img')!;
    stubImage('complete', true);
    stubImage('naturalWidth', 0);
    act(() => {
      root = hydrateRoot(container, <RoutePhoto id={ID} alt="Shop" className="x" mode="direct" />);
    });
    expect(queue.reportFirstLoadFailure).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().paced).toBe(true);
    const again = container.querySelector('img')!;
    expect(again).not.toBe(first);
    expect(again.getAttribute('src')).toBe(SRC);
    expect(again.getAttribute('data-photo-state')).toBe('loading');
  });

  it('at mount, an <img> already loaded counts as loaded and is left alone', () => {
    const html = renderToString(<RoutePhoto id={ID} alt="Shop" className="x" mode="direct" />);
    container.innerHTML = html;
    const first = container.querySelector('img')!;
    stubImage('complete', true);
    stubImage('naturalWidth', 640);
    act(() => {
      root = hydrateRoot(container, <RoutePhoto id={ID} alt="Shop" className="x" mode="direct" />);
    });
    expect(queue.reportFirstLoadFailure).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBe(first);
    expect(queue.getSnapshot()).toMatchObject({ total: 1, loaded: 1, paced: false });
  });

  it('a first load that fails after hydration (onError) is reported once and retried as a new <img>', () => {
    mount(<RoutePhoto id={ID} alt="Shop" className="x" mode="direct" />);
    const first = imgs()[0]!;
    expect(first.hasAttribute('data-photo-state')).toBe(false);
    fire(first, 'error');
    fire(first, 'error');
    expect(queue.reportFirstLoadFailure).toHaveBeenCalledTimes(1);
    const again = imgs()[0]!;
    expect(again).not.toBe(first);
    expect(again.getAttribute('src')).toBe(SRC);
    fire(again, 'load');
    expect(imgs()[0]!.getAttribute('data-photo-state')).toBe('loaded');
  });

  it('a first load that succeeds is counted, with no data-photo-state', () => {
    mount(<RoutePhoto id={ID} alt="Shop" className="x" mode="direct" />);
    fire(imgs()[0]!, 'load');
    expect(queue.getSnapshot()).toMatchObject({ total: 1, loaded: 1 });
    expect(imgs()[0]!.hasAttribute('data-photo-state')).toBe(false);
  });
});

describe("RoutePhoto 'queued'", () => {
  it('the server renders a placeholder: no <img>, no src', () => {
    const html = renderToString(<RoutePhoto id={ID} alt="Shop" className="h-20 w-20" mode="queued" />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('/api/photos/');
    expect(html).toBe(
      '<span role="img" aria-label="Shop: loading" data-photo-state="waiting" class="h-20 w-20 inline-block bg-slate-200 motion-safe:animate-pulse"></span>'
    );
  });

  it('after a start: an <img> with src exactly /api/photos/<id>; after an error and a restart: a new node, same src', () => {
    vi.useFakeTimers();
    mount(<RoutePhoto id={ID} alt="Shop" className="x" mode="queued" />);
    const a = imgs();
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute('src')).toBe(SRC);
    expect(a[0]!.getAttribute('loading')).toBe('eager');
    expect(a[0]!.getAttribute('decoding')).toBe('async');
    expect(a[0]!.getAttribute('data-photo-state')).toBe('loading');
    fire(a[0]!, 'error');
    expect(imgs()).toHaveLength(0);
    expect(container.querySelector('[data-photo-state="waiting"]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(queue.PACE_MS));
    const b = imgs();
    expect(b).toHaveLength(1);
    expect(b[0]).not.toBe(a[0]);
    expect(b[0]!.getAttribute('src')).toBe(SRC);
    expect(b[0]!.getAttribute('src')).not.toContain('?');
    fire(b[0]!, 'load');
    expect(container.querySelector('img')!.getAttribute('data-photo-state')).toBe('loaded');
    expect(container.querySelector('img')).toBe(b[0]);
  });

  it('a retry that starts at once, in the same turn as the error, is still a new <img> node', () => {
    vi.useFakeTimers();
    mount(<RoutePhoto id={ID} alt="Shop" className="x" mode="queued" />);
    const a = imgs()[0]!;
    fire(a, 'error');
    // Paced now. The second try waits the pace; its failure comes after more
    // than the pace has passed, so the third try starts in the same turn.
    act(() => void vi.advanceTimersByTime(queue.PACE_MS));
    const b = imgs()[0]!;
    expect(b).not.toBe(a);
    act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS + 1));
    fire(b, 'error');
    const c = imgs()[0]!;
    expect(container.querySelector('[data-photo-state="waiting"]')).toBeNull();
    expect(c).not.toBe(b);
    expect(c.getAttribute('src')).toBe(SRC);
  });

  it('no <img> ever has its src changed while it loads (MutationObserver)', async () => {
    vi.useFakeTimers();
    const changes: MutationRecord[] = [];
    const mo = new MutationObserver((r) => changes.push(...r));
    mo.observe(container, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['src'] });
    const ids = Array.from({ length: 10 }, (_, i) => `${ID.slice(0, -2)}${String(i).padStart(2, '0')}`);
    mount(
      <div>
        {ids.map((id) => (
          <RoutePhoto key={id} id={id} alt="Shop" className="x" mode="queued" />
        ))}
      </div>
    );
    for (let round = 0; round < 30; round++) {
      for (const img of imgs()) {
        if (img.getAttribute('data-photo-state') !== 'loading') continue;
        fire(img, round % 3 === 0 ? 'error' : 'load');
      }
      act(() => void vi.advanceTimersByTime(1000));
    }
    await Promise.resolve();
    mo.disconnect();
    // React itself assigns src once more right after it inserts a new <img>
    // (react-dom commitMount, so the load event fires after its listener is
    // on), with the same value. That is the only src write it may see: the
    // value of a node never changes and is never removed.
    const perNode = new Map<Node, number>();
    for (const c of changes) {
      const el = c.target as HTMLImageElement;
      expect(c.oldValue).toBe(el.getAttribute('src'));
      expect(el.getAttribute('src')).toMatch(/^\/api\/photos\/[0-9a-f-]+$/);
      perNode.set(el, (perNode.get(el) ?? 0) + 1);
    }
    expect(Math.max(0, ...perNode.values())).toBeLessThanOrEqual(1);
    expect(imgs().every((i) => i.getAttribute('data-photo-state') === 'loaded')).toBe(true);
    expect(imgs().map((i) => i.getAttribute('src')).sort()).toEqual(ids.map((id) => `/api/photos/${id}`).sort());
  });

  it("after 4 failures: 'Not loaded'", () => {
    vi.useFakeTimers();
    mount(<RoutePhoto id={ID} alt="Signboard" className="x" mode="queued" />);
    for (let i = 0; i < 4; i++) {
      act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS));
      fire(imgs()[0]!, 'error');
    }
    const failed = container.querySelector('[data-photo-state="failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.getAttribute('role')).toBe('img');
    expect(failed.getAttribute('aria-label')).toBe('Signboard: not loaded');
    expect(failed.textContent).toBe('Not loaded');
    expect(failed.className).not.toContain('animate-pulse');
    expect(imgs()).toHaveLength(0);
  });

  it('unmounting frees its place in the queue', () => {
    mount(<RoutePhoto id={ID} alt="Shop" className="x" mode="queued" />);
    expect(queue.getSnapshot().total).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(queue.getSnapshot().total).toBe(0);
    expect(queue.photoQueueInternalsForTests().inFlight).toBe(0);
  });
});

describe('PhotoQueueStatus', () => {
  it('renders nothing on the server', () => {
    expect(renderToString(<PhotoQueueStatus />)).toBe('');
  });

  it('says the exact sentences, and its Try again calls retryFailed', () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 8 }, (_, i) => `${ID.slice(0, -2)}${String(i).padStart(2, '0')}`);
    mount(
      <div>
        <PhotoQueueStatus />
        {ids.map((id) => (
          <RoutePhoto key={id} id={id} alt="Shop" className="x" mode="queued" />
        ))}
      </div>
    );
    const text = () => container.textContent ?? '';
    expect(text()).not.toContain('Showing');
    // The first refusal paces the queue.
    fire(imgs()[0]!, 'error');
    fire(imgs()[0]!, 'load');
    expect(text()).toContain('Showing 1 of 8 photos. The rest load one by one, about one a second.');
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe('Photos are loading one by one.');
    // Everything else loads but one, which fails 4 times.
    for (let round = 0; round < 60; round++) {
      act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS));
      for (const img of imgs()) {
        if (img.getAttribute('data-photo-state') !== 'loading') continue;
        fire(img, img.getAttribute('src') === `/api/photos/${ids[0]}` ? 'error' : 'load');
      }
    }
    expect(text()).not.toContain('Showing');
    expect(text()).toContain('1 photo did not load.');
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe('1 photo did not load.');
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('min-h-11');
    act(() => button.click());
    expect(queue.retryFailed).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS));
    fire(container.querySelector('img[data-photo-state="loading"]')!, 'load');
    expect(text()).not.toContain('did not load');
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe('All photos are shown.');
  });

  it('counts several failures in the plural', () => {
    vi.useFakeTimers();
    const ids = [`${ID.slice(0, -2)}11`, `${ID.slice(0, -2)}12`];
    mount(
      <div>
        <PhotoQueueStatus />
        {ids.map((id) => (
          <RoutePhoto key={id} id={id} alt="Shop" className="x" mode="queued" />
        ))}
      </div>
    );
    for (let round = 0; round < 20; round++) {
      for (const img of imgs()) if (img.getAttribute('data-photo-state') === 'loading') fire(img, 'error');
      act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS));
    }
    expect(container.textContent).toContain('2 photos did not load.');
  });
});
