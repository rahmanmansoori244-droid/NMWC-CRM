/**
 * PhotoCaptureSlot's onBusyChange (item 22 review): the field forms hold Submit
 * while a photo is going up, because the document load after Submit aborts an
 * upload in flight. They count busy slots, so every true must be followed by
 * exactly one false — whether the photo attaches, fails, is retried, or the
 * slot goes away mid-upload. submit-forms.test.tsx mocks the slot and proves
 * the forms count; this proves the real slot reports.
 *
 * jsdom decodes no image and has no canvas, so each test says how far the
 * chain gets: the decode never ends, fails, or succeeds into a stubbed canvas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/services/photos', () => ({ attachPhotoAction: vi.fn(), detachPhotoAction: vi.fn() }));

import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';

let decode: 'never' | 'fail' | 'load' = 'never';
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 100;
  height = 100;
  set src(_url: string) {
    if (decode === 'load') setTimeout(() => this.onload?.(), 0);
    if (decode === 'fail') setTimeout(() => this.onerror?.(), 0);
  }
}

beforeEach(() => {
  decode = 'never';
  vi.stubGlobal('Image', FakeImage);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:photo' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A canvas that draws, and a JPEG the hash step can read. */
const compressible = () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
    cb({
      size: 1,
      type: 'image/jpeg',
      arrayBuffer: async () => new ArrayBuffer(1),
    } as unknown as Blob)
  );
};

const pick = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'shop.jpg', { type: 'image/jpeg' })] },
  });
};

describe('PhotoCaptureSlot onBusyChange', () => {
  it('reports true when a photo starts, and false when the slot goes mid-upload — a counting form never drifts', async () => {
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="SIGNBOARD" onBusyChange={(b) => calls.push(b)} />);
    expect(calls).toEqual([]); // an idle slot says nothing
    pick(view.container);
    await waitFor(() => expect(calls).toEqual([true]));
    view.unmount();
    expect(calls).toEqual([true, false]);
  });

  it('a failed decode ends it', async () => {
    decode = 'fail';
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="SHOP" onBusyChange={(b) => calls.push(b)} />);
    pick(view.container);
    await waitFor(() => expect(calls).toEqual([true, false]));
    expect(screen.queryByText('Compressing…')).toBeNull();
  });

  it('a failed hash ends it too — it used to leave the slot "Compressing…" for good', async () => {
    decode = 'load';
    compressible();
    vi.stubGlobal('crypto', {
      subtle: { digest: () => Promise.reject(new Error('Hashing failed.')) },
    });
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="SHOP" onBusyChange={(b) => calls.push(b)} />);
    pick(view.container);
    await waitFor(() => expect(calls).toEqual([true, false]));
    expect(screen.queryByText('Compressing…')).toBeNull();
  });

  it('compress then upload is ONE busy stretch; a failed upload ends it, and Retry upload starts another', async () => {
    decode = 'load';
    compressible();
    vi.stubGlobal('crypto', { subtle: { digest: async () => new ArrayBuffer(32) } });
    // A 4xx is not retried: the chain fails at once.
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })
    );
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="SHOP" onBusyChange={(b) => calls.push(b)} />);
    pick(view.container);
    const retry = await screen.findByRole('button', { name: /Retry upload/ });
    expect(calls).toEqual([true, false]);
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toEqual([true, false, true, false]));
  });

  it('a parent re-render with a new callback mid-upload reports nothing extra', async () => {
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    pick(view.container);
    await waitFor(() => expect(calls).toEqual([true]));
    view.rerender(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    view.rerender(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    expect(calls).toEqual([true]);
    view.unmount();
    expect(calls).toEqual([true, false]);
  });
});
