/**
 * Large-customer photos, part B: a form photo slot whose attached photo does
 * not load (components/nmwc/PhotoCaptureSlot.tsx through RoutePhoto).
 *
 * The slot stays filled — 'filled' comes from the attachment id, not from the
 * image (owner question, as built) — reports nothing new to the form, and says
 * "Photo did not load. It is still attached." A blob: preview (a photo just
 * taken) is a plain <img> and never touches the photo queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

vi.mock('@/components/nmwc/photo-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/nmwc/photo-queue')>();
  return { ...real, register: vi.fn(real.register) };
});

import { PhotoCaptureSlot, REMOTE_PHOTO_FAILED_MESSAGE } from '@/components/nmwc/PhotoCaptureSlot';
import * as queue from '@/components/nmwc/photo-queue';

const ID = 'c0ffee00-0000-4000-8000-0000000000aa';
const remote = (photoMode?: 'direct' | 'queued') => ({
  attachmentId: ID,
  remoteUrl: `/api/photos/${ID}`,
  ...(photoMode ? { photoMode } : {}),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queue.resetPhotoQueueForTests();
  vi.mocked(queue.register).mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  queue.resetPhotoQueueForTests();
  vi.useRealTimers();
});

const fire = (el: Element, type: 'load' | 'error') => act(() => void el.dispatchEvent(new Event(type)));

/** Fails the slot's photo at every try until the queue gives it up. */
function failFourTimes(container: HTMLElement) {
  for (let i = 0; i < 4; i++) {
    const img = container.querySelector('img');
    expect(img, `try ${i + 1}`).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`/api/photos/${ID}`);
    fire(img!, 'error');
    act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS));
  }
}

describe('a form photo slot whose photo does not load', () => {
  for (const mode of ['direct', 'queued'] as const) {
    it(`${mode}: after 4 failed loads it stays filled, reports nothing, and says the photo is still attached`, () => {
      const onChange = vi.fn();
      const { container, getByText, queryByText } = render(
        <PhotoCaptureSlot kind="SHOP" required initial={remote(mode)} onChange={onChange} />
      );
      expect(queryByText(REMOTE_PHOTO_FAILED_MESSAGE)).toBeNull();
      failFourTimes(container);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('[data-photo-state="failed"]')).not.toBeNull();
      expect(getByText('Photo did not load. It is still attached.')).toBeTruthy();
      // Still filled: the check icon, the label without the required star, the
      // filled colours, and Retake / Remove offered as for any attached photo.
      expect(container.querySelector('svg.lucide-check')).not.toBeNull();
      expect(getByText('Shop front').textContent).toBe('Shop front');
      expect(container.textContent).not.toContain('Shop front *');
      expect((container.firstElementChild as HTMLElement).className).toContain('border-emerald-300');
      expect(container.querySelector('[aria-label="Retake photo"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Remove photo"]')).not.toBeNull();
      // No button to load it: nothing but Retake and Remove.
      expect([...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Remove photo']);
      expect(onChange).not.toHaveBeenCalled();
    });
  }

  it('a photo that loads on a later try clears the message (the queue retries it)', () => {
    const { container, queryByText } = render(<PhotoCaptureSlot kind="SIGNBOARD" initial={remote()} />);
    fire(container.querySelector('img')!, 'error');
    act(() => void vi.advanceTimersByTime(queue.PACE_MAX_MS));
    fire(container.querySelector('img')!, 'load');
    expect(container.querySelector('img')!.getAttribute('data-photo-state')).toBe('loaded');
    expect(queryByText(REMOTE_PHOTO_FAILED_MESSAGE)).toBeNull();
  });

  it("direct (the default): the server markup is today's <img>", () => {
    const html = renderToString(<PhotoCaptureSlot kind="SHOP" required initial={remote()} />);
    expect(html).toContain(`<img src="/api/photos/${ID}" alt="Shop front" class="absolute inset-0 h-full w-full object-cover"/>`);
    expect(html).not.toContain('data-photo-state');
  });

  it('a blob: preview is a plain <img> and never registers with the queue', () => {
    const { container } = render(
      <PhotoCaptureSlot kind="SHOP" initial={{ attachmentId: ID, previewUrl: 'blob:http://localhost/abc', remoteUrl: `/api/photos/${ID}` }} />
    );
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:http://localhost/abc');
    fire(img, 'error');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(container.querySelector('img')).toBe(img);
    expect(queue.register).not.toHaveBeenCalled();
    expect(queue.getSnapshot().total).toBe(0);
    expect(container.textContent).not.toContain(REMOTE_PHOTO_FAILED_MESSAGE);
  });
});
