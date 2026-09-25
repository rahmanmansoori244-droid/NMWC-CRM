/**
 * PhotoCaptureSlot's onBusyChange (item 22 review): the field forms hold Submit
 * while a photo is going up, because the document load after Submit aborts an
 * upload in flight. They count busy slots, so every true must be followed by
 * exactly one false — whether the photo attaches, fails, is retried, or the
 * slot goes away mid-upload — and the false must mean the upload has ended.
 * submit-forms.test.tsx mocks the slot and proves the forms count;
 * create-form-photo-slots.test.tsx runs the new-customer form with real slots;
 * this proves the real slot reports.
 *
 * The hold made a stalled upload hold Submit too, so every network step of the
 * chain now has a limit, and a stall ends in the ordinary "Retry upload" state.
 * And the forms lock their slots while a submit is on its way, so a locked slot
 * must start nothing — Retry upload and an open Remove confirm included.
 *
 * jsdom decodes no image and has no canvas, so each test says how far the
 * chain gets: the decode never ends, fails, is held for the test to end, or
 * succeeds into a stubbed canvas. The PUT is a fake XHR the test drives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

const photos = vi.hoisted(() => ({ attachPhotoAction: vi.fn(), detachPhotoAction: vi.fn() }));
vi.mock('@/services/photos', () => photos);

import {
  PhotoCaptureSlot,
  PHOTO_STEP_TIMEOUT_MS,
  UPLOAD_STALL_MS,
  type AttachTarget,
} from '@/components/nmwc/PhotoCaptureSlot';
import { ALREADY_ATTACHED_MESSAGE } from '@/lib/photo-attach';

let decode: 'never' | 'fail' | 'load' | 'held' = 'never';
let held: FakeImage[] = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 100;
  height = 100;
  set src(_url: string) {
    if (decode === 'load') setTimeout(() => this.onload?.(), 0);
    if (decode === 'fail') setTimeout(() => this.onerror?.(), 0);
    if (decode === 'held') held.push(this);
  }
}

/** The R2 PUT: nothing happens until the test says so. */
let xhrs: FakeXHR[] = [];
class FakeXHR {
  status = 0;
  aborted = false;
  upload: { onprogress: ((e: ProgressEvent) => void) | null; onload: (() => void) | null } = {
    onprogress: null,
    onload: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send() {
    xhrs.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(pct: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: pct, total: 100 } as ProgressEvent);
  }
  bodySent() {
    this.upload.onload?.();
  }
  answer(status = 200) {
    this.status = status;
    this.onload?.();
  }
}

/**
 * Presign and finalize, each answering by its plan. A stall ends only when the
 * request is aborted: before the headers, or — stallBody — after them, while
 * the reply is read. Ids follow the presign: k1 → att-1.
 */
type Step = 'answer' | 'stall' | 'stallBody' | 'refuse';
let presignPlan: Step[] = [];
let finalizePlan: Step[] = [];
let seen: string[] = [];
let signals: Array<AbortSignal | null | undefined> = [];
let presigned = 0;
const JSON_HEADERS = { 'content-type': 'application/json' };
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const serveChain = () =>
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    seen.push(url);
    signals.push(init.signal);
    const isPresign = url === '/api/photos/presign';
    const step = (isPresign ? presignPlan : finalizePlan).shift() ?? 'answer';
    const signal = init.signal;
    if (step === 'stall') {
      return new Promise<Response>((_, reject) =>
        signal?.addEventListener('abort', () => reject(abortError()))
      );
    }
    if (step === 'refuse') return new Response('{}', { status: 400, headers: JSON_HEADERS });
    let body: unknown;
    if (isPresign) {
      presigned += 1;
      body = { url: `/r2/${presigned}`, key: `k${presigned}`, headers: {} };
    } else {
      const { key } = JSON.parse(String(init.body)) as { key: string };
      body = { attachmentId: `att-${key.slice(1)}` };
    }
    if (step === 'stallBody') {
      const stream = new ReadableStream({
        start(c) {
          signal?.addEventListener('abort', () => c.error(abortError()));
        },
      });
      return new Response(stream, { status: 200, headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
  });
const count = (url: string) => seen.filter((u) => u === url).length;

beforeEach(() => {
  decode = 'never';
  held = [];
  xhrs = [];
  presignPlan = [];
  finalizePlan = [];
  seen = [];
  signals = [];
  presigned = 0;
  photos.attachPhotoAction.mockReset();
  photos.detachPhotoAction.mockReset();
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
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
const hashable = () =>
  vi.stubGlobal('crypto', { subtle: { digest: async () => new ArrayBuffer(32) } });
/** Everything up to the network works. */
const uploadable = () => {
  decode = 'load';
  compressible();
  hashable();
  serveChain();
};

const pick = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'shop.jpg', { type: 'image/jpeg' })] },
  });
};
const retryButton = () => screen.queryByRole('button', { name: /Retry upload/ });
const shopOfB1: AttachTarget = { kind: 'branch', branchId: 'b1', slot: 'SHOP' };

/** Under fake timers, where waitFor cannot poll: let the chain's continuations run. */
const settleUntil = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  expect(done()).toBe(true);
};
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const withFakeTimers = async (body: () => Promise<void>) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
};

describe('PhotoCaptureSlot onBusyChange', () => {
  it('a slot that goes mid-upload reports false only when that upload has ended — the unmount does not stop it, so Submit must not go while it runs', async () => {
    uploadable();
    const calls: boolean[] = [];
    const onChange = vi.fn();
    const view = render(
      <PhotoCaptureSlot kind="SIGNBOARD" onChange={onChange} onBusyChange={(b) => calls.push(b)} />
    );
    expect(calls).toEqual([]); // an idle slot says nothing
    pick(view.container);
    await waitFor(() => expect(xhrs).toHaveLength(1));
    await waitFor(() => expect(calls).toEqual([true]));
    // A key change on the new-customer form did this while the PUT was open; the
    // cleanup said false at once, and Submit unlocked beside a running upload.
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(calls).toEqual([true]);
    act(() => xhrs[0]!.answer());
    await waitFor(() => expect(calls).toEqual([true, false]));
    // It really was still going: it finished, and said so to the form.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'att-1' }));
  });

  it('the same for an upload started by Retry upload', async () => {
    uploadable();
    presignPlan = ['refuse'];
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    pick(view.container);
    const retry = await screen.findByRole('button', { name: /Retry upload/ });
    await waitFor(() => expect(calls).toEqual([true, false]));
    fireEvent.click(retry);
    await waitFor(() => expect(xhrs).toHaveLength(1));
    await waitFor(() => expect(calls).toEqual([true, false, true]));
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(calls).toEqual([true, false, true]);
    act(() => xhrs[0]!.answer());
    await waitFor(() => expect(calls).toEqual([true, false, true, false]));
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
    hashable();
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
    // The slot reports from an effect, which React runs AFTER the render that
    // shows "Retry upload" — asserting at once raced it (red on CI, 2026-09-26).
    await waitFor(() => expect(calls).toEqual([true, false]));
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toEqual([true, false, true, false]));
  });

  it('a parent re-render with a new callback mid-upload reports nothing extra', async () => {
    decode = 'held';
    const calls: boolean[] = [];
    const view = render(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    pick(view.container);
    await waitFor(() => expect(calls).toEqual([true]));
    view.rerender(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    view.rerender(<PhotoCaptureSlot kind="FREE" onBusyChange={(b) => calls.push(b)} />);
    expect(calls).toEqual([true]);
    await act(async () => held[0]!.onerror?.());
    await waitFor(() => expect(calls).toEqual([true, false]));
  });
});

describe('a stalled step ends in Retry upload, so it cannot hold Submit', () => {
  it('a PUT that goes quiet is given up after UPLOAD_STALL_MS and retried on a fresh connection; three quiet tries end in Retry upload, and busy ends', () =>
    withFakeTimers(async () => {
      uploadable();
      const calls: boolean[] = [];
      const view = render(<PhotoCaptureSlot kind="SHOP" onBusyChange={(b) => calls.push(b)} />);
      pick(view.container);
      await settleUntil(() => xhrs.length === 1);
      await settleUntil(() => calls.length === 1);
      await advance(UPLOAD_STALL_MS - 1);
      expect(xhrs[0]!.aborted).toBe(false);
      await advance(1);
      expect(xhrs[0]!.aborted).toBe(true);
      await advance(500); // the retry's backoff
      await settleUntil(() => xhrs.length === 2);
      await advance(UPLOAD_STALL_MS);
      expect(xhrs[1]!.aborted).toBe(true);
      await advance(1500);
      await settleUntil(() => xhrs.length === 3);
      await advance(UPLOAD_STALL_MS);
      expect(xhrs[2]!.aborted).toBe(true);
      await settleUntil(() => retryButton() !== null);
      await settleUntil(() => calls.length === 2);
      expect(calls).toEqual([true, false]);
      expect(xhrs).toHaveLength(3);
    }));

  it('a PUT that keeps moving is never given up, however long it takes — the clock restarts on each progress event, and when the body has gone', () =>
    withFakeTimers(async () => {
      uploadable();
      const calls: boolean[] = [];
      const onChange = vi.fn();
      const view = render(
        <PhotoCaptureSlot kind="SHOP" onChange={onChange} onBusyChange={(b) => calls.push(b)} />
      );
      pick(view.container);
      await settleUntil(() => xhrs.length === 1);
      // Every gap is under the limit; together they are far past it.
      const gap = UPLOAD_STALL_MS - 1_000;
      for (let pct = 10; pct <= 100; pct += 10) {
        await advance(gap);
        act(() => xhrs[0]!.progress(pct));
      }
      await advance(gap);
      act(() => xhrs[0]!.bodySent());
      await advance(gap); // R2's answer
      act(() => xhrs[0]!.answer());
      await settleUntil(() => onChange.mock.calls.length === 1);
      await settleUntil(() => calls.length === 2);
      expect(calls).toEqual([true, false]);
      expect(xhrs).toHaveLength(1);
      expect(xhrs[0]!.aborted).toBe(false);
      expect(retryButton()).toBeNull();
    }));

  it('a presign or finalize with no answer is given up after PHOTO_STEP_TIMEOUT_MS — before the headers, or while the reply is read — and retried', () =>
    withFakeTimers(async () => {
      uploadable();
      presignPlan = ['stall'];
      finalizePlan = ['stallBody'];
      const calls: boolean[] = [];
      const onChange = vi.fn();
      const view = render(
        <PhotoCaptureSlot kind="SHOP" onChange={onChange} onBusyChange={(b) => calls.push(b)} />
      );
      pick(view.container);
      await settleUntil(() => count('/api/photos/presign') === 1);
      await advance(PHOTO_STEP_TIMEOUT_MS - 1);
      expect(signals[0]?.aborted).toBe(false);
      await advance(1);
      expect(signals[0]?.aborted).toBe(true);
      await advance(500);
      await settleUntil(() => count('/api/photos/presign') === 2);
      await settleUntil(() => xhrs.length === 1);
      act(() => xhrs[0]!.answer());
      await settleUntil(() => count('/api/photos/finalize') === 1);
      await advance(PHOTO_STEP_TIMEOUT_MS);
      await advance(500);
      await settleUntil(() => count('/api/photos/finalize') === 2);
      await settleUntil(() => onChange.mock.calls.length === 1);
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'att-1' }));
      await settleUntil(() => calls.length === 2);
      expect(calls).toEqual([true, false]);
      expect(retryButton()).toBeNull();
    }));

  it('an attach with no answer ends in Retry upload after PHOTO_STEP_TIMEOUT_MS; Retry sends the attach again — not the photo — and "already attached" then means the first one landed', () =>
    withFakeTimers(async () => {
      uploadable();
      photos.attachPhotoAction
        .mockImplementationOnce(() => new Promise(() => {})) // never answers
        .mockResolvedValueOnce({
          ok: false,
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          fields: { attachmentId: ALREADY_ATTACHED_MESSAGE },
        });
      const calls: boolean[] = [];
      const onChange = vi.fn();
      const view = render(
        <PhotoCaptureSlot
          kind="SHOP"
          attachTo={shopOfB1}
          onChange={onChange}
          onBusyChange={(b) => calls.push(b)}
        />
      );
      pick(view.container);
      await settleUntil(() => xhrs.length === 1);
      act(() => xhrs[0]!.answer());
      await settleUntil(() => photos.attachPhotoAction.mock.calls.length === 1);
      await advance(PHOTO_STEP_TIMEOUT_MS - 1);
      expect(retryButton()).toBeNull();
      await advance(1);
      await settleUntil(() => retryButton() !== null);
      await settleUntil(() => calls.length === 2);
      expect(calls).toEqual([true, false]);
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.click(retryButton()!);
      await settleUntil(() => calls.length === 4);
      expect(calls).toEqual([true, false, true, false]);
      expect(photos.attachPhotoAction.mock.calls[0]![0]).toEqual({
        attachmentId: 'att-1',
        branchId: 'b1',
        slot: 'SHOP',
      });
      expect(photos.attachPhotoAction.mock.calls[1]![0]).toEqual(
        photos.attachPhotoAction.mock.calls[0]![0]
      );
      // The photo was up already: no second upload over the same weak signal.
      expect(count('/api/photos/presign')).toBe(1);
      expect(xhrs).toHaveLength(1);
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'att-1' }));
      expect(retryButton()).toBeNull();
    }));

  it('once an attach IS answered, its refusal stands: the next Retry sends the photo again', () =>
    withFakeTimers(async () => {
      uploadable();
      photos.attachPhotoAction
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'Branch not on your route.' })
        .mockResolvedValueOnce({ ok: true, data: undefined });
      const onChange = vi.fn();
      const view = render(<PhotoCaptureSlot kind="SHOP" attachTo={shopOfB1} onChange={onChange} />);
      pick(view.container);
      await settleUntil(() => xhrs.length === 1);
      act(() => xhrs[0]!.answer());
      await settleUntil(() => photos.attachPhotoAction.mock.calls.length === 1);
      await advance(PHOTO_STEP_TIMEOUT_MS);
      await settleUntil(() => retryButton() !== null);
      fireEvent.click(retryButton()!);
      await settleUntil(() => screen.queryByText('Branch not on your route.') !== null);
      expect(xhrs).toHaveLength(1);
      fireEvent.click(retryButton()!);
      await settleUntil(() => xhrs.length === 2);
      act(() => xhrs[1]!.answer());
      await settleUntil(() => onChange.mock.calls.length === 1);
      expect(photos.attachPhotoAction.mock.calls[2]![0]).toMatchObject({ attachmentId: 'att-2' });
    }));

  it('"already attached" on an attach\'s FIRST try is a failure — that photo is on another slot', async () => {
    uploadable();
    photos.attachPhotoAction.mockResolvedValueOnce({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { attachmentId: ALREADY_ATTACHED_MESSAGE },
    });
    const onChange = vi.fn();
    const view = render(<PhotoCaptureSlot kind="SHOP" attachTo={shopOfB1} onChange={onChange} />);
    pick(view.container);
    await waitFor(() => expect(xhrs).toHaveLength(1));
    act(() => xhrs[0]!.answer());
    await screen.findByRole('button', { name: /Retry upload/ });
    expect(screen.getByText(ALREADY_ATTACHED_MESSAGE)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a new photo taken after an attach with no answer is uploaded and attached — the shortcut was for the old one', () =>
    withFakeTimers(async () => {
      uploadable();
      photos.attachPhotoAction
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ ok: true, data: undefined });
      const onChange = vi.fn();
      const view = render(<PhotoCaptureSlot kind="SHOP" attachTo={shopOfB1} onChange={onChange} />);
      pick(view.container);
      await settleUntil(() => xhrs.length === 1);
      act(() => xhrs[0]!.answer());
      await settleUntil(() => photos.attachPhotoAction.mock.calls.length === 1);
      await advance(PHOTO_STEP_TIMEOUT_MS);
      await settleUntil(() => retryButton() !== null);
      pick(view.container); // a retake instead of Retry
      await settleUntil(() => xhrs.length === 2);
      act(() => xhrs[1]!.answer());
      await settleUntil(() => onChange.mock.calls.length === 1);
      expect(photos.attachPhotoAction.mock.calls[1]![0]).toMatchObject({ attachmentId: 'att-2' });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'att-2' }));
    }));
});

describe('a locked slot starts nothing (a submit is on its way)', () => {
  it('keeps its failure in view but offers no Retry upload; unlocked, Retry is back', async () => {
    uploadable();
    presignPlan = ['refuse']; // a 4xx: no retries, straight to the failure
    const view = render(<PhotoCaptureSlot kind="SHOP" />);
    pick(view.container);
    await screen.findByRole('button', { name: /Retry upload/ });
    // Tapped during "Submitting…", it started an upload that the page load after
    // the answer cut off, beside "It arrived — nothing more to do".
    view.rerender(<PhotoCaptureSlot kind="SHOP" disabled />);
    expect(retryButton()).toBeNull();
    expect(screen.getByText('Could not get upload URL.')).toBeTruthy();
    view.rerender(<PhotoCaptureSlot kind="SHOP" />);
    expect(retryButton()).not.toBeNull();
  });

  it('a Remove confirm left open closes when the lock starts — and stays closed when it lifts', async () => {
    const photo = { attachmentId: 'att-9', remoteUrl: '/api/photos/att-9' };
    const view = render(<PhotoCaptureSlot kind="SHOP" initial={photo} attachTo={shopOfB1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    view.rerender(<PhotoCaptureSlot kind="SHOP" initial={photo} attachTo={shopOfB1} disabled />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
    view.rerender(<PhotoCaptureSlot kind="SHOP" initial={photo} attachTo={shopOfB1} />);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeTruthy();
    expect(photos.detachPhotoAction).not.toHaveBeenCalled();
  });
});
