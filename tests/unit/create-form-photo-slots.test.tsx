/**
 * The new-customer form with REAL photo slots (item 22 review). Submit is held
 * while a slot is busy, and a slot used to report false as soon as it
 * unmounted. On this form a slot unmounted mid-upload because of a SIBLING: the
 * two "Other" slots were keyed by the photo they showed, and the empty
 * guarantee slot by the number of documents. So a sibling finishing or being
 * removed remounted a slot still uploading; Submit unlocked beside a running
 * upload, and the page load after the answer cut it off. The extra-photo
 * onChange also wrote back the list it rendered with, so the photo that
 * finished first was dropped. submit-forms.test mocks the slot and cannot see
 * either.
 *
 * jsdom has no image decoder, canvas or R2: each photo compresses to a blob of
 * its own size (1, 2, …), the presign is keyed by that size, and the test
 * finishes each PUT by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('@/components/nmwc/GpsCaptureButton', () => ({ GpsCaptureButton: () => <span>gps</span> }));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import { PHOTO_UPLOADING_MESSAGE } from '@/lib/submission';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 100;
  height = 100;
  set src(_url: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

type Put = { url: string; done: boolean; finish: () => void };
let puts: Put[] = [];
class FakeXHR {
  url = '';
  status = 0;
  upload: { onprogress: unknown; onload: unknown } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  abort() {}
  send() {
    const put: Put = {
      url: this.url,
      done: false,
      finish: () => {
        put.done = true;
        this.status = 200;
        this.onload?.();
      },
    };
    puts.push(put);
  }
}

/** A presign held open until the test lets it go, by photo (blob size). */
let presignHeld = new Map<number, () => void>();
let holdPresign = new Set<number>();
let formBodies: Array<Record<string, any>> = [];
let blobs = 0;

beforeEach(() => {
  puts = [];
  presignHeld = new Map();
  holdPresign = new Set();
  formBodies = [];
  blobs = 0;
  nav.hardReplace.mockReset();
  window.localStorage.clear();
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  let objectUrls = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:${++objectUrls}` });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
    const n = ++blobs;
    cb({ size: n, type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(n) } as unknown as Blob);
  });
  const randomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { subtle: { digest: async () => new ArrayBuffer(32) }, randomUUID });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === '/api/photos/presign') {
      const n = body.bytes as number;
      if (holdPresign.has(n)) await new Promise<void>((r) => presignHeld.set(n, r));
      return json({ url: `/r2/${n}`, key: `k${n}`, headers: {} });
    }
    if (url === '/api/photos/finalize') return json({ attachmentId: `att-${String(body.key).slice(1)}` });
    if (url.startsWith('/api/forms/')) {
      formBodies.push(body);
      return json({
        ok: true,
        data: { editId: 'd7', state: body.isDraft ? 'DRAFT' : 'SUBMITTED', submittedAt: null, replayed: false },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  // No upload may outlive its test: a held presign is let go (its slot is gone by then).
  for (const release of presignHeld.values()) release();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];
const complete = (over: Partial<CreateFormInitial> = {}, extras: string[] = []): CreateFormInitial => ({
  editId: 'd7',
  state: 'DRAFT',
  decisionReason: null,
  pendingRole: null,
  customer: {
    legalName: 'Blue Sea Cafe',
    paymentTerms: 'CASH',
    crNumber: '7654321',
    channelId: 'ch1',
    subChannelId: 'sc1',
    primaryPhone: '+96891234567',
    altPhone: '',
    contactPerson: 'Said',
    contactRole: '',
    notes: '',
    crPhotoAttachmentId: 'att-cr',
  },
  credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
  guaranteeAttachmentIds: [],
  branches: [
    {
      branchName: 'Main',
      address: 'Way 1, Ruwi',
      areaDescription: '',
      gpsLat: 23.5,
      gpsLng: 58.3,
      gpsAccuracy: 5,
      gpsCapturedAt: '2026-09-24T08:00:00.000Z',
      gpsManualReason: null,
      dayOfVisit: 'SUN',
      openingHours: '',
      deliveryWindow: '',
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      shopPhotoAttachmentId: 'att-shop',
      signboardPhotoAttachmentId: 'att-sign',
      extraPhotoAttachmentIds: extras,
    },
  ],
  ...over,
});

const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
const held = () => screen.queryByText(PHOTO_UPLOADING_MESSAGE) !== null;
const slotInputs = (label: string) =>
  [...document.querySelectorAll('input[type="file"]')].filter((i) =>
    i.parentElement!.textContent!.includes(label)
  );
const pick = (input: Element) =>
  fireEvent.change(input, { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
const removePhoto = (input: Element) => {
  fireEvent.click(input.parentElement!.querySelector('[aria-label="Remove photo"]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
};
const putFor = (n: number) => puts.find((p) => p.url === `/r2/${n}`);
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
/** Save draft, and wait until it is done: while it is on its way the slots are locked. */
const saveDraft = async () => {
  const before = formBodies.length;
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(formBodies).toHaveLength(before + 1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled());
  return formBodies[before]!;
};

describe('the new-customer form, with real photo slots', () => {
  it('two Other photos at once, the second finishing first: Submit stays held until the first is up, and both are sent', async () => {
    render(<CreateCustomerForm channels={channels} initial={complete()} sessionUserId="u1" />);
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    pick(slotInputs('Other')[0]!); // A: blob 1
    await waitFor(() => expect(putFor(1)).toBeDefined());
    pick(slotInputs('Other')[1]!); // B: blob 2
    await waitFor(() => expect(putFor(2)).toBeDefined());
    await act(async () => putFor(2)!.finish());
    await flush();
    // B's success used to re-key A's slot: it unmounted, said "not busy", and
    // Submit unlocked while A's PUT was still open.
    expect(putFor(1)!.done).toBe(false);
    expect(held()).toBe(true);
    expect(submitBtn()).toBeDisabled();
    expect(screen.getAllByText(/^Uploading…/)).toHaveLength(1);

    await act(async () => putFor(1)!.finish());
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    expect(held()).toBe(false);
    fireEvent.click(submitBtn());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
    expect(formBodies[0]!.branches[0].extraPhotoAttachmentIds).toEqual(['att-1', 'att-2']);
  });

  it('two Other photos at once, the first finishing first: both are sent — the later onChange no longer writes back the list it rendered with', async () => {
    render(<CreateCustomerForm channels={channels} initial={complete()} sessionUserId="u1" />);
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    pick(slotInputs('Other')[0]!);
    await waitFor(() => expect(putFor(1)).toBeDefined());
    pick(slotInputs('Other')[1]!);
    await waitFor(() => expect(putFor(2)).toBeDefined());
    await act(async () => putFor(1)!.finish());
    await flush();
    await act(async () => putFor(2)!.finish());
    await waitFor(() => expect(held()).toBe(false));
    const body = await saveDraft();
    expect(body.branches[0].extraPhotoAttachmentIds).toEqual(['att-1', 'att-2']);
  });

  it('a removed Other photo leaves its slot empty in place: an empty slot sends nothing, and a new photo there is sent beside the one that stayed', async () => {
    render(<CreateCustomerForm channels={channels} initial={complete({}, ['att-x', 'att-z'])} sessionUserId="u1" />);
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    removePhoto(slotInputs('Other')[0]!);
    await flush();
    // Slot 1 still shows Z, and slot 0 is empty — not Z moved into slot 0.
    expect(slotInputs('Other')[0]!.parentElement!.querySelector('img')).toBeNull();
    expect(slotInputs('Other')[1]!.parentElement!.querySelector('img')!.getAttribute('src')).toBe('/api/photos/att-z');
    const draft = await saveDraft();
    expect(draft.branches[0].extraPhotoAttachmentIds).toEqual(['att-z']);

    pick(slotInputs('Other')[0]!);
    await waitFor(() => expect(putFor(1)).toBeDefined());
    await act(async () => putFor(1)!.finish());
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    fireEvent.click(submitBtn());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
    expect(formBodies[1]!.branches[0].extraPhotoAttachmentIds).toEqual(['att-1', 'att-z']);
  });

  it('removing a guarantee document while the next one uploads keeps Submit held, and the new one is sent', async () => {
    const credit = complete({
      customer: { ...complete().customer, paymentTerms: 'CREDIT' },
      credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
      guaranteeAttachmentIds: ['g1', 'g2'],
    });
    render(<CreateCustomerForm channels={channels} initial={credit} sessionUserId="u1" />);
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    const guarantees = () => slotInputs('Guarantee doc');
    expect(guarantees()).toHaveLength(3); // g1, g2 and the empty slot for the next
    holdPresign.add(1);
    pick(guarantees()[2]!);
    await waitFor(() => expect(presignHeld.has(1)).toBe(true));
    removePhoto(guarantees()[1]!); // g2
    await flush();
    // The empty slot was keyed by the number of documents: removing g2 re-keyed
    // it, and Submit unlocked while g3's presign was still open. Remounted, it
    // also showed a blank slot where g3 was going up.
    expect(held()).toBe(true);
    expect(submitBtn()).toBeDisabled();
    expect(screen.getAllByText(/^Uploading…/)).toHaveLength(1);

    await act(async () => presignHeld.get(1)!());
    await waitFor(() => expect(putFor(1)).toBeDefined());
    await act(async () => putFor(1)!.finish());
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    fireEvent.click(submitBtn());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
    expect(formBodies[0]!.guaranteeAttachmentIds).toEqual(['g1', 'att-1']);
  });

  it('a retaken guarantee document replaces the old one in the request, in place', async () => {
    // Its onChange handled only a removal: the screen showed the new document
    // while the request still sent the old id.
    const credit = complete({
      customer: { ...complete().customer, paymentTerms: 'CREDIT' },
      credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
      guaranteeAttachmentIds: ['g1', 'g2'],
    });
    render(<CreateCustomerForm channels={channels} initial={credit} sessionUserId="u1" />);
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    pick(slotInputs('Guarantee doc')[0]!); // retake g1
    await waitFor(() => expect(putFor(1)).toBeDefined());
    await act(async () => putFor(1)!.finish());
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    const body = await saveDraft();
    expect(body.guaranteeAttachmentIds).toEqual(['att-1', 'g2']);
  });

  it('a guarantee document finished in the empty slot makes way for a fresh empty slot', async () => {
    const credit = complete({
      customer: { ...complete().customer, paymentTerms: 'CREDIT' },
      credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
      guaranteeAttachmentIds: [],
    });
    render(<CreateCustomerForm channels={channels} initial={credit} sessionUserId="u1" />);
    await waitFor(() => expect(slotInputs('Guarantee doc')).toHaveLength(1));
    pick(slotInputs('Guarantee doc')[0]!);
    await waitFor(() => expect(putFor(1)).toBeDefined());
    await act(async () => putFor(1)!.finish());
    await waitFor(() => expect(slotInputs('Guarantee doc')).toHaveLength(2));
    const [done, fresh] = slotInputs('Guarantee doc');
    expect(done!.parentElement!.querySelector('img')!.getAttribute('src')).toBe('/api/photos/att-1');
    expect(fresh!.parentElement!.querySelector('img')).toBeNull();
    await waitFor(() => expect(submitBtn()).toBeEnabled());
  });
});
