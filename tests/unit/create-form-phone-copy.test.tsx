/**
 * Code review 2026-11-10, finding 4 — the new-customer form's copy on the phone.
 *
 * A credit request needs seven or more camera shots. If the page reloaded before
 * it was sent — Android discarding the tab while the camera is open, a pull down
 * at the top of the page, the Back gesture, a mis-tap on the bottom bar — the
 * form came back with its typed text only: shops, GPS points and every photo had
 * to be done again. After the first Save draft the copy was switched off for
 * good, so everything after that tap was lost too.
 *
 * Now, through the real form (jsdom). The photo slot and the GPS button are
 * passive stand-ins: like the real ones they show the photo or point they were
 * MOUNTED with, so a restore that did not remount them would show nothing, and
 * the test drives their onChange / onBusyChange / onCapture by hand.
 *   - the copy holds the boxes, each shop, each GPS point and the id of every
 *     photo, and a reload puts all of it back: the request saved after a reload
 *     is the one that would have been saved before it;
 *   - it is written at once when a photo or a point is in, and when the page is
 *     hidden, goes, or the form unmounts;
 *   - after Save draft the form goes on keeping what is added, under the saved
 *     request's own key, and puts it back only over the version it was added to;
 *   - never on open; never another salesman's or another request's; gone after a
 *     submit, a withdraw and Sign out; kept seven days;
 *   - leaving with unsent work asks first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';

type SlotProps = {
  kind: string;
  initial?: { attachmentId: string } | null;
  onChange?: (p: { attachmentId: string } | null) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
};
type Point = { lat: number; lng: number; accuracy?: number; capturedAt: Date; isManual?: boolean; manualReason?: string };
type GpsProps = { initial?: Point | null; onCapture: (g: Point) => void; disabled?: boolean };

const h = vi.hoisted(() => ({
  slots: new Map<string, unknown>(),
  points: new Map<string, unknown>(),
  n: 0,
}));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: (p: SlotProps) => {
    const id = useRef<string | null>(null);
    if (id.current === null) id.current = `slot-${++h.n}`;
    const mine = id.current;
    // What it was mounted with: the real slot reads `initial` once.
    const [shown] = useState(p.initial?.attachmentId ?? 'empty');
    h.slots.set(mine, p);
    useEffect(() => () => void h.slots.delete(mine), [mine]);
    return (
      <span data-testid="slot" data-kind={p.kind} data-id={mine} data-locked={p.disabled ? 'yes' : 'no'}>
        {shown}
      </span>
    );
  },
}));
vi.mock('@/components/nmwc/GpsCaptureButton', () => ({
  GpsCaptureButton: (p: GpsProps) => {
    const id = useRef<string | null>(null);
    if (id.current === null) id.current = `gps-${++h.n}`;
    const mine = id.current;
    const [shown] = useState(
      p.initial ? `${p.initial.lat}, ${p.initial.lng}${p.initial.isManual ? ` (manual: ${p.initial.manualReason})` : ''}` : 'no point'
    );
    h.points.set(mine, p);
    useEffect(() => () => void h.points.delete(mine), [mine]);
    return (
      <span data-testid="gps" data-id={mine}>
        {shown}
      </span>
    );
  },
}));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import {
  announceRequestClosed,
  announceSignOut,
  clearDeviceDrafts,
  countDeviceDrafts,
  signedFormDraftKey,
} from '@/lib/device-drafts';
import { LEAVE_FORM_LOST_QUESTION, LEAVE_FORM_QUESTION, NO_PULL_REFRESH_CLASS } from '@/lib/leave-guard';

const NOW = new Date('2026-11-10T08:00:00.000Z').getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NEW_KEY = 'nmwc:create:u1:new';
const keyOf = (editId: string) => `nmwc:create:u1:${editId}`;

type Sent = { url: string; method: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let replies: Array<() => Promise<Response>> = [];
const answer = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const noAnswer = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};
const saved = (editId: string, state = 'DRAFT', replayed = false) =>
  answer({ ok: true, data: { editId, state, submittedAt: null, replayed } });
const refused = () =>
  answer({ ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { 'customer.primaryPhone': 'Enter a valid Oman number.' } });

const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sent = [];
  replies = [];
  h.slots.clear();
  h.points.clear();
  nav.hardReplace.mockReset();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/customers/new');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {} });
    const next = replies.shift();
    if (!next) throw new Error(`no reply queued for ${url}`);
    return next();
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.className = '';
});

/* ── driving the form ── */

const tick = (ms = 600) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Lets a send's continuation run without firing the half-second autosave. */
const settleUntil = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  expect(done()).toBe(true);
};
const type = (label: string | RegExp, value: string, nth = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[nth]!, { target: { value } });
const box = (label: string | RegExp, nth = 0) => screen.getAllByLabelText(label)[nth] as HTMLInputElement;

/** The mounted photo slots of a kind, in page order, with what each shows and its props. */
const slots = (kind: string) =>
  screen
    .getAllByTestId('slot')
    .filter((e) => e.getAttribute('data-kind') === kind)
    .map((e) => ({ shows: e.textContent, props: h.slots.get(e.getAttribute('data-id')!) as SlotProps }));
const shows = (kind: string) => slots(kind).map((s) => s.shows);
/** A photo taken in a slot: busy, attached with its id, done. */
const take = (slot: { props: SlotProps }, id: string) =>
  act(() => {
    slot.props.onBusyChange?.(true);
    slot.props.onChange?.({ attachmentId: id });
    slot.props.onBusyChange?.(false);
  });
const gps = () =>
  screen.getAllByTestId('gps').map((e) => ({ shows: e.textContent, props: h.points.get(e.getAttribute('data-id')!) as GpsProps }));
const capture = (nth: number, point: Omit<Point, 'capturedAt'> & { capturedAt?: Date }) =>
  act(() => {
    gps()[nth]!.props.onCapture({ capturedAt: new Date(NOW), ...point });
  });

const stored = (key = NEW_KEY) => {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown> & { savedAt: number });
};
/** The copy on the phone, as if it had last changed `ms` ago. */
const age = (ms: number, key = NEW_KEY) =>
  window.localStorage.setItem(key, JSON.stringify({ ...stored(key)!, savedAt: Date.now() - ms }));
const createKeys = () => Object.keys(window.localStorage).filter((k) => k.startsWith('nmwc:create:')).sort();

const renderNew = (user = 'u1') => render(<CreateCustomerForm channels={channels} initial={null} sessionUserId={user} />);
const saveDraft = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
/**
 * A never-saved copy that comes back holds the form until he says it is this
 * shop (review of finding 4): "Continue …" lets him on with it.
 */
const chooseContinue = () => fireEvent.click(screen.getByRole('button', { name: /^Continue / }));
/** The never-saved form reopened over its copy, and continued. */
const reopenNew = (user = 'u1') => {
  const view = renderNew(user);
  chooseContinue();
  return view;
};
const restoredBanner = () =>
  screen.queryByText(/^Restored (the details you typed on this phone — shops|what you added on this phone after)/)?.parentElement ?? null;
/** What a send carried, without the id of that send. */
const payload = (s: Sent) => {
  const { submissionId: _id, ...rest } = s.body;
  return rest;
};

/** A credit request for two shops: every kind of thing the form holds. */
async function fillACreditRequest() {
  type('Legal name *', 'Blue Sea Cafe');
  type('CR number *', '7654321');
  type('Primary phone *', '9123 4567');
  type('Contact person *', 'Said');
  type('Notes', 'Closed Fridays');
  fireEvent.click(screen.getByRole('radio', { name: 'Credit' }));
  type('E-mail *', 'accounts@bluesea.om');
  type('Requested credit limit (OMR) *', '500');
  type('Requested payment term (days) *', '30');
  take(slots('CR')[0]!, 'att-cr');
  // Two pages of the ID card, one of the tax card.
  take(slots('ID_CARD').at(-1)!, 'att-id1');
  take(slots('ID_CARD').at(-1)!, 'att-id2');
  take(slots('TAX_CARD').at(-1)!, 'att-tax');
  // The first shop.
  type('Address *', 'Way 1, Ruwi');
  capture(0, { lat: 23.5881, lng: 58.3829, accuracy: 9 });
  fireEvent.change(screen.getAllByLabelText('Day of visit *')[0]!, { target: { value: 'SUN' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Increase Coolers' })[0]!);
  take(slots('SHOP')[0]!, 'att-shop');
  take(slots('SIGNBOARD')[0]!, 'att-sign');
  take(slots('FREE')[1]!, 'att-extra'); // the SECOND "other" slot: kept by position
  // A second shop, its point typed in by hand.
  fireEvent.click(screen.getByRole('button', { name: '+ Add another branch' }));
  type('Branch name *', 'Seeb', 1);
  type('Address *', 'Way 2, Seeb', 1);
  capture(1, { lat: 23.67, lng: 58.19, isManual: true, manualReason: 'No fix inside the mall' });
  take(slots('SHOP')[1]!, 'att-shop2');
}

const draftOnFile = (over: Partial<CreateFormInitial> = {}): CreateFormInitial => ({
  editId: 'd7',
  version: 'v-on-file',
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
    email: '',
  },
  credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
  guaranteeAttachmentIds: [],
  creditDocuments: { ID_CARD: [], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: [] },
  branches: [
    {
      branchName: 'Main',
      address: 'Way 1, Ruwi',
      areaDescription: '',
      gpsLat: 23.5,
      gpsLng: 58.3,
      gpsAccuracy: 5,
      gpsCapturedAt: '2026-11-09T08:00:00.000Z',
      gpsManualReason: null,
      dayOfVisit: 'SUN',
      openingHours: '',
      deliveryWindow: '',
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      shopPhotoAttachmentId: 'att-shop',
      signboardPhotoAttachmentId: null,
      extraPhotoAttachmentIds: [],
    },
  ],
  ...over,
});
const renderSaved = (initial: CreateFormInitial = draftOnFile(), props: { signedFormOpen?: boolean } = {}) =>
  render(<CreateCustomerForm channels={channels} initial={initial} sessionUserId="u1" {...props} />);

/* ─────────────────────────────────────────────────────────────────────────── */

describe('4(a): a reload brings back the shops, the GPS points and the photos', () => {
  it('a never-saved credit request for two shops comes back whole, and saves as the same request', async () => {
    const before = renderNew();
    await fillACreditRequest();
    // What Save draft sends now (the server refuses it: nothing is saved, nothing to ask about later).
    replies.push(refused());
    saveDraft();
    await settleUntil(() => screen.queryByText('Enter a valid Oman number.') !== null);
    await tick();
    before.unmount(); // the tab is gone

    reopenNew(); // …and reopened
    // The boxes.
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    expect(box('CR number *')).toHaveValue('7654321');
    expect(box('Primary phone *')).toHaveValue('9123 4567');
    expect(box('Notes')).toHaveValue('Closed Fridays');
    expect(screen.getByRole('radio', { name: 'Credit' })).toBeChecked();
    expect(box('E-mail *')).toHaveValue('accounts@bluesea.om');
    expect(box('Requested credit limit (OMR) *')).toHaveValue('500');
    // Both shops, each with its boxes.
    expect(screen.getAllByLabelText('Address *').map((e) => (e as HTMLInputElement).value)).toEqual(['Way 1, Ruwi', 'Way 2, Seeb']);
    expect(box('Branch name *', 1)).toHaveValue('Seeb');
    expect(screen.getAllByLabelText('Day of visit *')[0]).toHaveValue('SUN');
    expect(screen.getAllByRole('spinbutton', { name: 'Coolers' })[0]).toHaveValue('1');
    // Both points, the typed-in one with its reason — on chips that mounted with them.
    expect(gps().map((g) => g.shows)).toEqual(['23.5881, 58.3829', '23.67, 58.19 (manual: No fix inside the mall)']);
    // Every photo, on the slot it was taken in.
    expect(shows('CR')).toEqual(['att-cr']);
    expect(shows('ID_CARD')).toEqual(['att-id1', 'att-id2', 'empty']);
    expect(shows('TAX_CARD')).toEqual(['att-tax', 'empty']);
    expect(shows('VAT_CERT')).toEqual(['empty']);
    expect(shows('SHOP')).toEqual(['att-shop', 'att-shop2']);
    expect(shows('SIGNBOARD')).toEqual(['att-sign', 'empty']);
    expect(shows('FREE')).toEqual(['empty', 'att-extra', 'empty', 'empty']);

    // Said, with what the copy holds: CR 1 + documents 3 + shop 2 + signboard 1 + other 1 = 8.
    const banner = restoredBanner()!;
    expect(banner.getAttribute('role')).toBe('status');
    expect(
      within(banner).getByText('Restored the details you typed on this phone — shops, GPS points and photos included.')
    ).toBeTruthy();
    expect(
      within(banner).getByText('Saved on this phone just now: “Blue Sea Cafe” — 2 shops, 2 GPS points, 8 photos.')
    ).toBeTruthy();
    // The old words, which told him to do it all again, are gone.
    expect(screen.queryByText(/are not kept on the phone/)).toBeNull();

    // The request it saves is the one it would have saved before the reload.
    replies.push(saved('d7'));
    saveDraft();
    await settleUntil(() => sent.length === 2);
    expect(payload(sent[1]!)).toEqual(payload(sent[0]!));
    expect(sent[1]!.body).toMatchObject({
      customer: { crPhotoAttachmentId: 'att-cr' },
      creditDocuments: { ID_CARD: ['att-id1', 'att-id2'], TAX_CARD: ['att-tax'] },
      branches: [
        {
          gpsLat: 23.5881,
          gpsLng: 58.3829,
          gpsAccuracy: 9,
          shopPhotoAttachmentId: 'att-shop',
          signboardPhotoAttachmentId: 'att-sign',
          extraPhotoAttachmentIds: ['att-extra'],
        },
        { branchName: 'Seeb', gpsLat: 23.67, gpsManualReason: 'No fix inside the mall', shopPhotoAttachmentId: 'att-shop2' },
      ],
    });
  });

  it('the copy holds only ids for the photos — and nothing the form does not', async () => {
    renderNew();
    await fillACreditRequest();
    const copy = stored()!;
    expect(copy).toMatchObject({
      v: 2,
      legalName: 'Blue Sea Cafe',
      paymentTerms: 'CREDIT',
      crPhotoId: 'att-cr',
      creditDocs: { ID_CARD: ['att-id1', 'att-id2'], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: ['att-tax'] },
      unanswered: [],
    });
    expect((copy.branches as unknown[]).length).toBe(2);
    // A never-saved form's copy names no draft version.
    expect(copy).not.toHaveProperty('base');
    expect(JSON.stringify(copy)).not.toMatch(/blob:|data:image/);
    expect(countDeviceDrafts('u1')).toBe(1);
  });

  it('a second reload brings the same form back again', async () => {
    const first = renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    take(slots('SHOP')[0]!, 'att-shop');
    first.unmount();
    const second = reopenNew();
    expect(shows('SHOP')).toEqual(['att-shop']);
    await tick();
    second.unmount();
    reopenNew();
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    expect(shows('SHOP')).toEqual(['att-shop']);
  });
});

describe('4(b): the copy is written when it matters, not half a second too late', () => {
  it('at once when a photo is in, and at once when a GPS point is in — with the text typed just before', () => {
    renderNew();
    type('Legal name *', 'Blue Sea Cafe'); // the half-second timer is armed, not fired
    expect(stored()).toBeNull();
    take(slots('SHOP')[0]!, 'att-shop');
    expect(stored()).toMatchObject({ legalName: 'Blue Sea Cafe' });
    expect((stored()!.branches as Array<{ shopPhotoId: string }>)[0]!.shopPhotoId).toBe('att-shop');

    type('Address *', 'Way 1, Ruwi');
    capture(0, { lat: 23.5881, lng: 58.3829, accuracy: 9 });
    expect((stored()!.branches as Array<{ address: string; gps: { lat: number } }>)[0]).toMatchObject({
      address: 'Way 1, Ruwi',
      gps: { lat: 23.5881, lng: 58.3829, accuracy: 9, capturedAt: new Date(NOW).toISOString() },
    });
  });

  it('a photo finished, then the tab gone within the half second: it is in the copy', () => {
    const view = renderNew();
    take(slots('CR')[0]!, 'att-cr');
    view.unmount();
    expect(stored()).toMatchObject({ crPhotoId: 'att-cr' });
    reopenNew();
    expect(shows('CR')).toEqual(['att-cr']);
  });

  it('text typed, then the form gone before the timer (a tap on a link): written as it unmounts', () => {
    const view = renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    expect(stored()).toBeNull();
    view.unmount();
    expect(stored()).toMatchObject({ legalName: 'Blue Sea Cafe' });
  });

  it('…and when the page is hidden (the camera opens, another app) or goes (a reload, Back)', () => {
    renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    // Becoming visible again writes nothing by itself.
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stored()).toBeNull();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stored()).toMatchObject({ legalName: 'Blue Sea Cafe' });

    type('Legal name *', 'Blue Sea Cafe LLC');
    window.dispatchEvent(new Event('pagehide'));
    expect(stored()).toMatchObject({ legalName: 'Blue Sea Cafe LLC' });
  });

  it('typing alone is written after the half-second pause, as before', async () => {
    renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    await tick(499);
    expect(stored()).toBeNull();
    await tick(1);
    expect(stored()).toMatchObject({ legalName: 'Blue Sea Cafe', savedAt: NOW + 500 });
  });

  it('nothing is written for a form merely opened — blank, or on a saved draft', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const blank = renderNew();
    await tick(5_000);
    blank.unmount();
    renderSaved();
    await tick(5_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(setItem).not.toHaveBeenCalled();
    expect(createKeys()).toEqual([]);
    expect(countDeviceDrafts('u1')).toBe(0);
  });

  it('a change undone leaves no copy', async () => {
    renderNew();
    take(slots('SHOP')[0]!, 'att-shop');
    expect(stored()).not.toBeNull();
    act(() => slots('SHOP')[0]!.props.onChange?.(null)); // Remove photo
    expect(stored()).toBeNull();
    type('Legal name *', 'Blue Sea Cafe');
    await tick();
    type('Legal name *', '  ');
    await tick();
    expect(stored()).toBeNull();
  });
});

describe('4(b): after Save draft the form goes on keeping what is added', () => {
  /** A never-saved form, typed and saved as d7. Returns the id that save carried. */
  const saveAsD7 = async () => {
    type('Legal name *', 'Blue Sea Cafe');
    take(slots('CR')[0]!, 'att-cr');
    replies.push(saved('d7'));
    saveDraft();
    await settleUntil(() => screen.queryByText('✓ Draft saved. Finish and submit when ready.') !== null);
    return sent[0]!.body.submissionId as string;
  };
  /** The draft as that save left it on the server, for the page that loads it. */
  const d7OnFile = (version: string, over: Partial<CreateFormInitial> = {}) =>
    draftOnFile({
      version,
      customer: { ...draftOnFile().customer, crNumber: '', channelId: '', subChannelId: '', primaryPhone: '', contactPerson: '' },
      branches: [
        {
          ...draftOnFile().branches[0]!,
          address: '',
          gpsLat: null,
          gpsLng: null,
          gpsAccuracy: null,
          gpsCapturedAt: null,
          dayOfVisit: null,
          shopPhotoAttachmentId: null,
        },
      ],
      ...over,
    });

  it('the never-saved copy goes; nothing is kept while nothing is added; a later photo is kept under the request\'s own key', async () => {
    renderNew();
    const id = await saveAsD7();
    expect(stored(NEW_KEY), 'the next new customer does not open on this shop').toBeNull();
    expect(createKeys()).toEqual([]);
    expect(window.location.search).toBe('?edit=d7');
    await tick(5_000);
    expect(createKeys(), 'saved, and nothing added since').toEqual([]);

    // The finding: everything after the first Save draft used to be lost on a reload.
    take(slots('SHOP')[0]!, 'att-shop');
    expect(createKeys()).toEqual([keyOf('d7')]);
    expect(stored(keyOf('d7'))).toMatchObject({ v: 2, legalName: 'Blue Sea Cafe', crPhotoId: 'att-cr', base: id });
    type('Contact person *', 'Said');
    await tick();
    expect(stored(keyOf('d7'))).toMatchObject({ contactPerson: 'Said', base: id });
    expect(stored(NEW_KEY)).toBeNull();
  });

  it('a reload of the saved draft puts back what was added after it, and says it is not on the server yet', async () => {
    const first = renderNew();
    const id = await saveAsD7();
    take(slots('SHOP')[0]!, 'att-shop');
    type('Contact person *', 'Said');
    capture(0, { lat: 23.5881, lng: 58.3829, accuracy: 9 });
    await tick();
    first.unmount();
    age(20 * MINUTE, keyOf('d7'));

    // The page loads the draft as the server has it: without the shop photo, contact and point.
    renderSaved(d7OnFile(id));
    expect(shows('SHOP')).toEqual(['att-shop']);
    expect(box('Contact person *')).toHaveValue('Said');
    expect(gps()[0]!.shows).toBe('23.5881, 58.3829');
    expect(shows('CR')).toEqual(['att-cr']);
    const banner = restoredBanner()!;
    expect(within(banner).getByText('Restored what you added on this phone after your last Save draft.')).toBeTruthy();
    expect(
      within(banner).getByText('Saved on this phone 20 minutes ago. It is not on the server yet — tap Save draft to keep it.')
    ).toBeTruthy();

    // Save draft sends it, to the same request; then nothing is left to keep.
    replies.push(saved('d7'));
    saveDraft();
    await settleUntil(() => sent.length === 2);
    expect(sent[1]!.body).toMatchObject({
      editId: 'd7',
      customer: { contactPerson: 'Said' },
      branches: [{ shopPhotoAttachmentId: 'att-shop', gpsLat: 23.5881 }],
    });
    await settleUntil(() => restoredBanner() === null);
    await tick();
    expect(createKeys()).toEqual([]);
  });

  it('a draft saved again since, from another phone or tab, is the truth: the copy is dropped, and said', async () => {
    const first = renderNew();
    await saveAsD7();
    take(slots('SHOP')[0]!, 'att-shop');
    first.unmount();

    renderSaved(d7OnFile('saved-from-the-other-phone', { customer: { ...d7OnFile('x').customer, notes: 'Typed on the other phone' } }));
    expect(shows('SHOP'), 'not put over the newer draft').toEqual(['empty']);
    expect(box('Notes')).toHaveValue('Typed on the other phone');
    expect(restoredBanner()).toBeNull();
    expect(
      screen.getByText(
        'What you had added on this phone was not restored, because this draft was saved again since (from another phone or tab). The form shows what is saved now — check it and add anything that is missing.'
      )
    ).toBeTruthy();
    expect(createKeys()).toEqual([]);
  });

  it('a Save draft of his own that got no answer but landed: the draft is still the one this copy grew on', async () => {
    const first = renderNew();
    const id = await saveAsD7();
    take(slots('SHOP')[0]!, 'att-shop');
    replies.push(noAnswer);
    saveDraft();
    await settleUntil(() => screen.queryByRole('button', { name: 'Try again' }) !== null);
    const lost = sent[1]!.body.submissionId as string;
    expect(stored(keyOf('d7'))).toMatchObject({ base: id, sent: [lost] });
    // He adds a signboard photo, and the tab reloads.
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    first.unmount();

    // It had landed: the draft's version is that send's id, and it holds the shop photo.
    renderSaved(d7OnFile(lost, { branches: [{ ...d7OnFile('x').branches[0]!, shopPhotoAttachmentId: 'att-shop' }] }));
    expect(shows('SIGNBOARD')).toEqual(['att-sign']);
    expect(restoredBanner()).not.toBeNull();
  });

  it('…and one that did not land: the draft is still at the version before it', async () => {
    const first = renderNew();
    const id = await saveAsD7();
    take(slots('SHOP')[0]!, 'att-shop');
    replies.push(noAnswer);
    saveDraft();
    await settleUntil(() => screen.queryByRole('button', { name: 'Try again' }) !== null);
    first.unmount();
    renderSaved(d7OnFile(id));
    expect(shows('SHOP')).toEqual(['att-shop']);
  });

  it('a refused Save draft of a saved form is not kept as a version it might be', async () => {
    renderNew();
    const id = await saveAsD7();
    take(slots('SHOP')[0]!, 'att-shop');
    replies.push(refused());
    saveDraft();
    await settleUntil(() => screen.queryByText('Enter a valid Oman number.') !== null);
    expect(stored(keyOf('d7'))).toMatchObject({ base: id });
    expect(stored(keyOf('d7'))).not.toHaveProperty('sent');
  });

  it('typed while the save was on its way: kept under the request\'s key the moment the answer comes, never in the never-saved slot', async () => {
    renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    let reply!: (r: Response) => void;
    replies.push(() => new Promise<Response>((resolve) => (reply = resolve)));
    saveDraft();
    await settleUntil(() => sent.length === 1);
    type('Notes', 'Typed while saving'); // arms the half-second write
    await act(async () => {
      reply(await saved('d7')());
    });
    await settleUntil(() => screen.queryByRole('button', { name: 'Save draft' }) !== null && !box('Notes').disabled);
    await settleUntil(() => stored(keyOf('d7')) !== null);
    expect(stored(keyOf('d7'))).toMatchObject({ notes: 'Typed while saving', base: sent[0]!.body.submissionId });
    await tick(5_000);
    expect(stored(NEW_KEY)).toBeNull();
    expect(createKeys()).toEqual([keyOf('d7')]);
  });

  it('a copy that holds nothing the saved draft does not is removed without a word', () => {
    // As the form writes it: the draft's own boxes, nothing added.
    const first = renderSaved();
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    const copy = stored(keyOf('d7'))!;
    first.unmount();
    // …and the page now loads the draft WITH that photo (it was saved from this phone, the answer lost).
    window.localStorage.setItem(keyOf('d7'), JSON.stringify(copy));
    renderSaved(draftOnFile({ branches: [{ ...draftOnFile().branches[0]!, signboardPhotoAttachmentId: 'att-sign' }] }));
    expect(restoredBanner()).toBeNull();
    expect(screen.queryByText(/was not restored/)).toBeNull();
    expect(createKeys()).toEqual([]);
  });
});

describe('the restored copy can be given up', () => {
  it('"Start a blank form": asks, then empties every box and slot and removes the copy', async () => {
    const first = renderNew();
    await fillACreditRequest();
    first.unmount();
    reopenNew();
    fireEvent.click(screen.getByRole('button', { name: 'Start a blank form' }));
    expect(screen.getByText('Discard this unsent form? Its photos will have to be taken again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    expect(stored()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Start a blank form' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, start blank' }));
    expect(box('Legal name *')).toHaveValue('');
    expect(box('Notes')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Cash' })).toBeChecked();
    expect(screen.getAllByLabelText('Address *')).toHaveLength(1);
    expect(box('Address *')).toHaveValue('');
    expect(gps().map((g) => g.shows)).toEqual(['no point']);
    expect(shows('CR')).toEqual(['empty']);
    expect(shows('SHOP')).toEqual(['empty']);
    expect(shows('FREE')).toEqual(['empty', 'empty']);
    expect(restoredBanner()).toBeNull();
    // Gone with that render, not half a second later — and it stays gone.
    expect(stored()).toBeNull();
    await tick(5_000);
    expect(createKeys()).toEqual([]);
    // The next shop's request carries nothing of the last one.
    type('Legal name *', 'Next Shop');
    replies.push(saved('d8'));
    saveDraft();
    await settleUntil(() => sent.length === 1);
    expect(sent[0]!.body).toMatchObject({ customer: { legalName: 'Next Shop', paymentTerms: 'CASH' }, creditDocuments: {} });
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/att-|Blue Sea|Seeb|23\.5881/);
  });

  it('"Discard these changes": the form goes back to the draft as it was last saved', async () => {
    const first = renderSaved();
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    type('Notes', 'Added on the phone');
    capture(0, { lat: 24, lng: 59, accuracy: 3 });
    await tick();
    first.unmount();

    renderSaved();
    expect(shows('SIGNBOARD')).toEqual(['att-sign']);
    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    expect(screen.getByText('Go back to the draft as it was last saved? What you added since will be lost.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(box('Notes')).toHaveValue('Added on the phone');
    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
    expect(box('Notes')).toHaveValue('');
    expect(shows('SIGNBOARD')).toEqual(['empty']);
    expect(shows('SHOP')).toEqual(['att-shop']);
    expect(shows('CR')).toEqual(['att-cr']);
    expect(gps()[0]!.shows).toBe('23.5, 58.3');
    expect(restoredBanner()).toBeNull();
    expect(createKeys()).toEqual([]);
    await tick(5_000);
    expect(createKeys()).toEqual([]);
  });

  it('the way out is off while a photo is going up or a send is on its way', async () => {
    const first = renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    first.unmount();
    reopenNew();
    const out = () => screen.getByRole('button', { name: 'Start a blank form' });
    expect(out()).toBeEnabled();
    act(() => slots('SHOP')[0]!.props.onBusyChange?.(true));
    expect(out()).toBeDisabled();
    act(() => slots('SHOP')[0]!.props.onBusyChange?.(false));
    expect(out()).toBeEnabled();

    let reply!: (r: Response) => void;
    replies.push(() => new Promise<Response>((resolve) => (reply = resolve)));
    saveDraft();
    await settleUntil(() => sent.length === 1);
    expect(out()).toBeDisabled();
    await act(async () => {
      reply(await refused()());
    });
  });

  it('the banner goes when he empties the form by hand, and with it the copy', async () => {
    const first = renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    first.unmount();
    reopenNew();
    expect(restoredBanner()).not.toBeNull();
    type('Legal name *', '');
    expect(restoredBanner()).toBeNull();
    await tick();
    expect(stored()).toBeNull();
  });
});

describe('4(e): never another salesman\'s copy, nor another request\'s', () => {
  it('a second salesman on the same phone gets a blank form, and the first one\'s copy is left alone', async () => {
    const first = renderNew('u1');
    type('Legal name *', 'Blue Sea Cafe');
    take(slots('SHOP')[0]!, 'att-shop');
    first.unmount();
    const his = window.localStorage.getItem(NEW_KEY);

    const other = renderNew('u2');
    expect(box('Legal name *')).toHaveValue('');
    expect(shows('SHOP')).toEqual(['empty']);
    expect(restoredBanner()).toBeNull();
    type('Legal name *', 'Typed by the second salesman');
    await tick();
    other.unmount();
    expect(window.localStorage.getItem(NEW_KEY), 'untouched').toBe(his);
    expect(JSON.parse(window.localStorage.getItem('nmwc:create:u2:new')!).legalName).toBe('Typed by the second salesman');

    // …and the first one still finds his own.
    reopenNew('u1');
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    expect(shows('SHOP')).toEqual(['att-shop']);
  });

  it('what was added to one saved draft is not shown on another, nor on a new form — and the other way round', () => {
    const d7 = renderSaved();
    take(slots('SIGNBOARD')[0]!, 'att-sign-of-d7');
    d7.unmount();
    const fresh = renderNew();
    type('Legal name *', 'A never-saved form');
    fresh.unmount();
    expect(createKeys()).toEqual([keyOf('d7'), NEW_KEY].sort());

    const d8 = renderSaved(draftOnFile({ editId: 'd8' }));
    expect(shows('SIGNBOARD')).toEqual(['empty']);
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    expect(restoredBanner()).toBeNull();
    d8.unmount();
    const again = reopenNew();
    expect(shows('SIGNBOARD')).toEqual(['empty']);
    expect(box('Legal name *')).toHaveValue('A never-saved form');
    again.unmount();
    // Both copies are still there, each for its own form.
    expect(createKeys()).toEqual([keyOf('d7'), NEW_KEY].sort());
    renderSaved();
    expect(shows('SIGNBOARD')).toEqual(['att-sign-of-d7']);
  });

  it('the banner of a never-saved form names the shop it holds, so the next shop\'s form is not filled with it unseen', () => {
    const first = renderNew();
    type('Legal name *', 'Shop A');
    take(slots('SHOP')[0]!, 'att-shop-a');
    capture(0, { lat: 23.5881, lng: 58.3829, accuracy: 9 });
    first.unmount();
    age(2 * DAY);
    reopenNew();
    expect(
      within(restoredBanner()!).getByText('Saved on this phone 2 days ago: “Shop A” — 1 shop, 1 GPS point, 1 photo.')
    ).toBeTruthy();
    expect(within(restoredBanner()!).getByRole('button', { name: 'Start a blank form' })).toBeEnabled();
    // A reminder to check, not a success: amber, not green.
    expect(restoredBanner()!.className).toMatch(/amber/);
    expect(restoredBanner()!.className).not.toMatch(/emerald/);
  });
});

/*
 * Review of finding 4 (code review 2026-11-10): the never-saved form has ONE slot
 * per salesman, and its copy carries the shop's GPS point and every photo id. A
 * salesman who left shop A unsaved and tapped New customer at shop B days later
 * found the form filled with A, its point and photos counted as present: typed
 * over with B's name and phones, it went out with A's point and photos, behind a
 * green banner only. Now the form is held until he says which shop it is.
 */
describe('review of finding 4: a never-saved copy is not used until he says it is this shop', () => {
  /** Shop A, complete enough to submit, left unsaved two days ago. */
  const leaveShopA = () => {
    const first = renderNew();
    type('Legal name *', 'Shop A');
    type('CR number *', '1111111');
    take(slots('CR')[0]!, 'att-cr-a');
    fireEvent.change(screen.getByLabelText('Channel *'), { target: { value: 'ch1' } });
    fireEvent.change(screen.getByLabelText('Sub-channel *'), { target: { value: 'sc1' } });
    type('Primary phone *', '9111 1111');
    type('Contact person *', 'Ali');
    type('Address *', 'Way 1, Ruwi');
    capture(0, { lat: 23.5881, lng: 58.3829, accuracy: 9 });
    fireEvent.change(screen.getAllByLabelText('Day of visit *')[0]!, { target: { value: 'SUN' } });
    take(slots('SHOP')[0]!, 'att-shop-a');
    take(slots('SIGNBOARD')[0]!, 'att-sign-a');
    // Complete: Submit is on offer before it is left.
    expect(screen.getByRole('button', { name: 'Submit for approval ▶' })).toBeEnabled();
    first.unmount();
    age(2 * DAY);
  };
  /** The question, when it is on screen (SubmitNoticeBox keeps an empty alert region of its own). */
  const held = () =>
    (screen.queryByRole('heading', { name: 'You have a new customer on this phone that was never saved' })?.closest('section') ??
      null) as HTMLElement | null;

  it('reopened, the form is held: nothing of it can be changed, saved or submitted, and it says which shop it holds and how old it is', async () => {
    leaveShopA();
    const copyBefore = window.localStorage.getItem(NEW_KEY);
    renderNew();
    const panel = held()!;
    expect(panel).not.toBeNull();
    expect(panel.className).toMatch(/amber/);
    expect(within(panel).getByText('You have a new customer on this phone that was never saved')).toBeTruthy();
    expect(within(panel).getByText('“Shop A” — 1 shop, 1 GPS point, 3 photos. Saved on this phone 2 days ago.')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Continue “Shop A” (saved 2 days ago)' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Start a new customer' })).toBeTruthy();
    // Not one box, photo slot, GPS button, Save draft or Submit is there to use.
    expect(screen.queryAllByLabelText('Legal name *')).toEqual([]);
    expect(screen.queryAllByTestId('slot')).toEqual([]);
    expect(screen.queryAllByTestId('gps')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for approval ▶' })).toBeNull();
    // Waiting on the question changes nothing on the phone and sends nothing.
    await tick(5_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(window.localStorage.getItem(NEW_KEY)).toBe(copyBefore);
    expect(sent).toEqual([]);
  });

  it('"Continue": the form opens as it was left, and can then be submitted', async () => {
    leaveShopA();
    renderNew();
    fireEvent.click(screen.getByRole('button', { name: 'Continue “Shop A” (saved 2 days ago)' }));
    expect(held()).toBeNull();
    expect(box('Legal name *')).toHaveValue('Shop A');
    expect(shows('SHOP')).toEqual(['att-shop-a']);
    expect(gps()[0]!.shows).toBe('23.5881, 58.3829');
    const submitButton = screen.getByRole('button', { name: 'Submit for approval ▶' });
    expect(submitButton).toBeEnabled();
    replies.push(saved('e1', 'SUBMITTED'));
    fireEvent.click(submitButton);
    await settleUntil(() => sent.length === 1);
    expect(sent[0]!.body).toMatchObject({ isDraft: false, customer: { legalName: 'Shop A' } });
  });

  it('"Start a new customer": asks, then a blank form — and nothing of shop A goes with the next shop', async () => {
    leaveShopA();
    renderNew();
    fireEvent.click(screen.getByRole('button', { name: 'Start a new customer' }));
    expect(
      screen.getByText('Discard “Shop A”? It was never saved: its photos and GPS point will have to be taken again.')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Continue “Shop A” (saved 2 days ago)' })).toBeTruthy();
    expect(stored()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Start a new customer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard it' }));
    expect(held()).toBeNull();
    expect(restoredBanner()).toBeNull();
    expect(box('Legal name *')).toHaveValue('');
    expect(gps().map((g) => g.shows)).toEqual(['no point']);
    expect(shows('CR')).toEqual(['empty']);
    expect(shows('SHOP')).toEqual(['empty']);
    expect(shows('SIGNBOARD')).toEqual(['empty']);
    expect(stored()).toBeNull();
    expect(screen.getByRole('button', { name: 'Submit for approval ▶' })).toBeDisabled();

    type('Legal name *', 'Shop B');
    replies.push(saved('d8'));
    saveDraft();
    await settleUntil(() => sent.length === 1);
    expect(sent[0]!.body).toMatchObject({ customer: { legalName: 'Shop B' } });
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/att-|Shop A|1111111|23\.5881/);
  });

  it('asked on every reopen until he chooses; a form without a name is named as unsaved', () => {
    const first = renderNew();
    take(slots('SHOP')[0]!, 'att-shop');
    first.unmount();
    const again = renderNew();
    expect(screen.getByRole('button', { name: 'Continue the unsaved form (saved just now)' })).toBeTruthy();
    expect(within(held()!).getByText('“no name yet” — 1 shop, 0 GPS points, 1 photo. Saved on this phone just now.')).toBeTruthy();
    again.unmount();
    renderNew();
    expect(held()).not.toBeNull();
  });

  it('not asked over a blank form, another salesman\'s slot, or a saved draft (its copy is under its own key)', () => {
    const blank = renderNew();
    expect(held()).toBeNull();
    type('Legal name *', 'Shop A');
    blank.unmount();
    const other = renderNew('u2');
    expect(held()).toBeNull();
    other.unmount();
    const d7 = renderSaved();
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    d7.unmount();
    renderSaved();
    expect(held()).toBeNull();
    expect(shows('SIGNBOARD')).toEqual(['att-sign']);
  });

  it('the old text-only copy is held the same way: it carries the last shop\'s name and CR number', () => {
    window.localStorage.setItem(NEW_KEY, JSON.stringify({ legalName: 'Shop A', crNumber: '1111111', savedAt: NOW - DAY, unanswered: [] }));
    renderNew();
    expect(screen.getByRole('button', { name: 'Continue “Shop A” (saved 1 day ago)' })).toBeTruthy();
    expect(screen.queryAllByLabelText('Legal name *')).toEqual([]);
  });

  it('a send of it found already submitted (the reload check) is said, with the form locked — no question', async () => {
    const first = renderNew();
    type('Legal name *', 'Shop A');
    take(slots('SHOP')[0]!, 'att-shop');
    replies.push(noAnswer);
    saveDraft();
    await settleUntil(() => screen.queryByRole('button', { name: 'Try again' }) !== null);
    first.unmount();
    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-11-10T07:42:00.000Z', replayed: true } }));
    renderNew();
    expect(held()).not.toBeNull();
    await settleUntil(() => screen.queryByText(/^Your last send arrived after all\./) !== null);
    expect(held()).toBeNull();
    expect(screen.getByRole('button', { name: 'Sent ✓' })).toBeTruthy();
  });

  it('a form with photos but no name yet says so', () => {
    const first = renderNew();
    take(slots('SHOP')[0]!, 'att-shop');
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    first.unmount();
    reopenNew();
    expect(
      within(restoredBanner()!).getByText('Saved on this phone just now: “no name yet” — 1 shop, 0 GPS points, 2 photos.')
    ).toBeTruthy();
  });
});

describe('4(e): the copy is cleared on a submit, a withdraw and Sign out — and nothing writes it back', () => {
  const complete = () =>
    draftOnFile({ branches: [{ ...draftOnFile().branches[0]!, signboardPhotoAttachmentId: 'att-sign' }] });

  it('Submit', async () => {
    renderSaved(complete());
    take(slots('FREE')[0]!, 'att-extra');
    expect(stored(keyOf('d7'))).not.toBeNull();
    replies.push(saved('d7', 'SUBMITTED'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await settleUntil(() => nav.hardReplace.mock.calls.length > 0);
    expect(nav.hardReplace).toHaveBeenCalledWith('/work');
    expect(createKeys()).toEqual([]);
    // The form is still on screen until Work loads: nothing it does brings the copy back.
    type('Notes', 'Typed while Work loads');
    window.dispatchEvent(new Event('pagehide'));
    await tick(5_000);
    expect(createKeys()).toEqual([]);
  });

  it('a withdraw of this request (WithdrawRequest, beside the form)', async () => {
    renderSaved();
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    expect(stored(keyOf('d7'))).not.toBeNull();
    // Another request's withdraw is not this one's.
    act(() => announceRequestClosed('d8'));
    expect(stored(keyOf('d7'))).not.toBeNull();
    act(() => announceRequestClosed('d7'));
    expect(createKeys()).toEqual([]);
    take(slots('FREE')[0]!, 'att-extra');
    type('Notes', 'Typed while Work loads');
    await tick(5_000);
    expect(createKeys()).toEqual([]);
  });

  it('Sign out', async () => {
    const view = renderNew();
    take(slots('SHOP')[0]!, 'att-shop');
    expect(stored()).not.toBeNull();
    act(() => {
      announceSignOut();
      clearDeviceDrafts('u1');
    });
    expect(createKeys()).toEqual([]);
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    type('Legal name *', 'Typed while signing out');
    await tick(5_000);
    view.unmount();
    expect(createKeys()).toEqual([]);
  });

  it('a request in review keeps no copy: a leftover of it, and of its signed-application pages, is removed', () => {
    const signedKey = signedFormDraftKey('u1', 'd7');
    const leftover = () => {
      window.localStorage.setItem(keyOf('d7'), JSON.stringify({ v: 2, legalName: 'Old', branches: [], savedAt: NOW, base: 'x' }));
      window.localStorage.setItem(signedKey, JSON.stringify({ v: 1, savedAt: NOW, token: 't', ids: ['p1'] }));
    };
    leftover();
    const review = renderSaved(draftOnFile({ state: 'SUBMITTED', pendingRole: 'Sales Director' }));
    expect(createKeys()).toEqual([]);
    review.unmount();

    // At his signed-application step the pages he has added are kept (SignedFormUpload's).
    leftover();
    renderSaved(draftOnFile({ state: 'SUBMITTED', pendingRole: 'Signed application' }), { signedFormOpen: true });
    expect(createKeys()).toEqual([signedKey]);
  });
});

describe('5(c) for this form: a copy is kept seven days from its last change', () => {
  const leave = () => {
    const view = renderNew();
    type('Legal name *', 'Blue Sea Cafe');
    take(slots('SHOP')[0]!, 'att-shop');
    view.unmount();
  };

  it('an eight-day-old copy is removed, and said; the form opens blank', () => {
    leave();
    age(8 * DAY);
    renderNew();
    expect(box('Legal name *')).toHaveValue('');
    expect(shows('SHOP')).toEqual(['empty']);
    expect(restoredBanner()).toBeNull();
    expect(
      screen.getByText(
        'An unsent copy of this form saved on this phone 8 days ago was removed: unsent work is kept on the phone for 7 days.'
      )
    ).toBeTruthy();
    expect(createKeys()).toEqual([]);
  });

  it('six days: restored. Opening it does not make it younger; a change to it does', async () => {
    leave();
    age(6 * DAY);
    const savedAt = stored()!.savedAt;
    const again = reopenNew();
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    await tick(5_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(stored()!.savedAt, 're-opened, not changed').toBe(savedAt);
    again.unmount();
    expect(stored()!.savedAt).toBe(savedAt);

    reopenNew();
    type('Notes', 'Still working on it');
    await tick();
    expect(Date.now() - stored()!.savedAt).toBeLessThan(1_000);
  });

  it('an expired copy over a saved draft is removed the same way', () => {
    const first = renderSaved();
    take(slots('SIGNBOARD')[0]!, 'att-sign');
    first.unmount();
    age(9 * DAY, keyOf('d7'));
    renderSaved();
    expect(shows('SIGNBOARD')).toEqual(['empty']);
    expect(screen.getByText(/saved on this phone 9 days ago was removed: unsent work is kept on the phone for 7 days\.$/)).toBeTruthy();
    expect(createKeys()).toEqual([]);
  });
});

describe('a send that got no answer, then a reload (item 22), with the whole form on the phone', () => {
  /** Typed, photographed, sent with no answer. Returns the id of that send. */
  const sendUnanswered = async () => {
    type('Legal name *', 'Blue Sea Cafe');
    take(slots('SHOP')[0]!, 'att-shop');
    replies.push(noAnswer);
    saveDraft();
    await settleUntil(() => screen.queryByRole('button', { name: 'Try again' }) !== null);
    return sent[0]!.body.submissionId as string;
  };
  const receipt = (data: unknown) => answer({ ok: true, data });

  it('it landed as a draft, and nothing was added since: the copy goes and the draft opens', async () => {
    const first = renderNew();
    const id = await sendUnanswered();
    expect(stored()).toMatchObject({ unanswered: [id], lastSent: { id } });
    first.unmount();

    replies.push(receipt({ editId: 'd9', state: 'DRAFT', submittedAt: null, replayed: true }));
    renderNew();
    expect(screen.getByText('Your last send got no answer — checking whether it arrived…')).toBeTruthy();
    await settleUntil(() => nav.hardReplace.mock.calls.length > 0);
    expect(sent[1]!.url).toBe(`/api/forms/customer-create?submissionId=${id}`);
    expect(nav.hardReplace).toHaveBeenCalledWith('/customers/new?edit=d9');
    expect(createKeys(), 'the draft on the server holds everything').toEqual([]);
    await tick(5_000);
    expect(createKeys()).toEqual([]);
  });

  it('it landed as a draft, and he had added a photo since: the copy moves under the draft, as grown on that send', async () => {
    const first = renderNew();
    const id = await sendUnanswered();
    take(slots('SIGNBOARD')[0]!, 'att-sign'); // after the send that got no answer
    first.unmount();

    replies.push(receipt({ editId: 'd9', state: 'DRAFT', submittedAt: null, replayed: true }));
    const reloaded = renderNew();
    await settleUntil(() => nav.hardReplace.mock.calls.length > 0);
    expect(nav.hardReplace).toHaveBeenCalledWith('/customers/new?edit=d9');
    expect(createKeys()).toEqual([keyOf('d9')]);
    expect(stored(keyOf('d9'))).toMatchObject({ legalName: 'Blue Sea Cafe', base: id, unanswered: [] });
    await tick(5_000);
    expect(stored(NEW_KEY), 'nothing refills the never-saved slot').toBeNull();
    reloaded.unmount();

    // The draft's page (it holds what that send carried) puts the signboard photo back.
    renderSaved(
      draftOnFile({
        editId: 'd9',
        version: id,
        customer: { ...draftOnFile().customer, crNumber: '', channelId: '', subChannelId: '', primaryPhone: '', contactPerson: '', crPhotoAttachmentId: null },
        branches: [{ ...draftOnFile().branches[0]!, address: '', gpsLat: null, gpsLng: null, gpsAccuracy: null, gpsCapturedAt: null, dayOfVisit: null }],
      })
    );
    expect(shows('SHOP')).toEqual(['att-shop']);
    expect(shows('SIGNBOARD')).toEqual(['att-sign']);
    expect(within(restoredBanner()!).getByText('Restored what you added on this phone after your last Save draft.')).toBeTruthy();
  });

  it('it did not land: the form is all there is, and it is all there', async () => {
    const first = renderNew();
    await sendUnanswered();
    first.unmount();
    replies.push(receipt(null));
    renderNew();
    await settleUntil(() => screen.queryByText(/checking whether it arrived/) === null);
    chooseContinue();
    expect(shows('SHOP')).toEqual(['att-shop']);
    expect(restoredBanner()).not.toBeNull();
    expect(screen.queryByText(/Your last send/)).toBeNull();
    await tick();
    expect(stored()).toMatchObject({ unanswered: [] });
  });

  it('no signal to ask: says the send may have arrived, in words that no longer tell him to take the photos again', async () => {
    const first = renderNew();
    const id = await sendUnanswered();
    first.unmount();
    replies.push(noAnswer);
    renderNew();
    await settleUntil(
      () =>
        screen.queryByText(
          'Your last send got no answer and may have arrived — when you have signal, check Work before you send this form again.'
        ) !== null
    );
    chooseContinue();
    expect(shows('SHOP')).toEqual(['att-shop']);
    expect(stored()).toMatchObject({ unanswered: [id] });
  });

  it('it had been submitted: the copy goes, the banner too, and the form is locked', async () => {
    const first = renderNew();
    await sendUnanswered();
    first.unmount();
    replies.push(receipt({ editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-11-10T07:42:00.000Z', replayed: true }));
    renderNew();
    await settleUntil(() => screen.queryByText(/^Your last send arrived after all\. ✓ Already received at/) !== null);
    expect(restoredBanner()).toBeNull();
    expect(createKeys()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Sent ✓' })).toBeTruthy();
  });

  it('"Start a blank form" keeps the send that still has to be asked about', async () => {
    const first = renderNew();
    const id = await sendUnanswered();
    first.unmount();
    replies.push(noAnswer);
    renderNew();
    await settleUntil(() => screen.queryByText(/may have arrived/) !== null);
    chooseContinue();
    fireEvent.click(screen.getByRole('button', { name: 'Start a blank form' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, start blank' }));
    expect(box('Legal name *')).toHaveValue('');
    expect(stored()).toMatchObject({ legalName: '', unanswered: [id] });
  });
});

describe('a copy the old form wrote (typed text only) still comes back, in the words it always had', () => {
  it('its text is restored; it becomes a whole-form copy with the next change, keeping its age until then', async () => {
    window.localStorage.setItem(NEW_KEY, JSON.stringify({ legalName: 'Blue Sea Cafe', crNumber: '7654321', savedAt: NOW - DAY, unanswered: [] }));
    reopenNew();
    expect(box('Legal name *')).toHaveValue('Blue Sea Cafe');
    expect(
      screen.getByText(
        'Restored the details you typed on this phone. Branch details, GPS points and photos are not kept on the phone — add them again, then tap Save draft to keep everything.'
      )
    ).toBeTruthy();
    expect(restoredBanner()).toBeNull();
    await tick();
    expect(stored()).toMatchObject({ v: 2, legalName: 'Blue Sea Cafe', savedAt: NOW - DAY });
    take(slots('SHOP')[0]!, 'att-shop');
    expect((stored()!.branches as Array<{ shopPhotoId: string }>)[0]!.shopPhotoId).toBe('att-shop');
    expect(stored()!.savedAt).toBeGreaterThan(NOW - DAY);
  });
});

describe('4(d): leaving with unsent work asks first', () => {
  const confirmSpy = () => vi.spyOn(window, 'confirm').mockReturnValue(false);
  /** The form beside a link of the app, as the bottom bar's are. */
  const withLink = (form: React.ReactNode) =>
    render(
      <>
        <a href="/today" onClick={(e) => e.preventDefault()}>
          Today
        </a>
        {form}
      </>
    );
  const unloadIsHeld = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const tapToday = () => fireEvent.click(screen.getByRole('link', { name: 'Today' }));

  it('a blank form, and a saved draft with nothing added, are left without a question', () => {
    const confirm = confirmSpy();
    const blank = withLink(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    tapToday();
    expect(unloadIsHeld()).toBe(false);
    blank.unmount();
    withLink(<CreateCustomerForm channels={channels} initial={draftOnFile()} sessionUserId="u1" />);
    tapToday();
    expect(unloadIsHeld()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('typed text or a photo: a tap on the bottom bar asks, and a reload asks', () => {
    const confirm = confirmSpy();
    withLink(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    type('Legal name *', 'Blue Sea Cafe');
    tapToday();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(LEAVE_FORM_QUESTION);
    expect(unloadIsHeld()).toBe(true);
  });

  it('a photo still going up asks too, on a form with nothing else unsent', () => {
    const confirm = confirmSpy();
    withLink(<CreateCustomerForm channels={channels} initial={draftOnFile()} sessionUserId="u1" />);
    act(() => slots('SIGNBOARD')[0]!.props.onBusyChange?.(true));
    tapToday();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(unloadIsHeld()).toBe(true);
    act(() => slots('SIGNBOARD')[0]!.props.onBusyChange?.(false));
    expect(unloadIsHeld()).toBe(false);
  });

  it('once Save draft has it, leaving is free again — until the next thing he adds', async () => {
    const confirm = confirmSpy();
    withLink(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    type('Legal name *', 'Blue Sea Cafe');
    expect(unloadIsHeld()).toBe(true);
    replies.push(saved('d7'));
    saveDraft();
    await settleUntil(() => screen.queryByText('✓ Draft saved. Finish and submit when ready.') !== null);
    expect(unloadIsHeld()).toBe(false);
    tapToday();
    expect(confirm).not.toHaveBeenCalled();
    take(slots('SHOP')[0]!, 'att-shop');
    expect(unloadIsHeld()).toBe(true);
  });

  it('a submitted form, and one in review, never ask', async () => {
    const confirm = confirmSpy();
    const sentForm = withLink(
      <CreateCustomerForm
        channels={channels}
        initial={draftOnFile({ branches: [{ ...draftOnFile().branches[0]!, signboardPhotoAttachmentId: 'att-sign' }] })}
        sessionUserId="u1"
      />
    );
    type('Notes', 'A last note');
    replies.push(saved('d7', 'SUBMITTED'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await settleUntil(() => nav.hardReplace.mock.calls.length > 0);
    expect(unloadIsHeld()).toBe(false);
    sentForm.unmount();
    withLink(<CreateCustomerForm channels={channels} initial={draftOnFile({ state: 'SUBMITTED' })} sessionUserId="u1" />);
    tapToday();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('when the phone cannot keep the copy, the form says so and the question says what leaving costs', async () => {
    const confirm = confirmSpy();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic storage refusal', 'QuotaExceededError');
    });
    withLink(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    const line = 'This phone could not keep a copy of this form. Keep this page open, and tap Save draft often.';
    expect(screen.queryByText(line)).toBeNull();
    type('Legal name *', 'Blue Sea Cafe');
    await tick();
    expect(screen.getByText(line)).toBeTruthy();
    tapToday();
    expect(confirm).toHaveBeenCalledWith(LEAVE_FORM_LOST_QUESTION);
    // Storage works again (he freed some space): the next write clears the line.
    vi.mocked(Storage.prototype.setItem).mockRestore();
    type('Legal name *', 'Blue Sea Cafe LLC');
    await tick();
    expect(screen.queryByText(line)).toBeNull();
    expect(stored()).toMatchObject({ legalName: 'Blue Sea Cafe LLC' });
  });

  it('pull-to-refresh is off while the form can be worked on, and back on a request in review', () => {
    const on = () => document.documentElement.classList.contains(NO_PULL_REFRESH_CLASS);
    const open = renderNew();
    expect(on()).toBe(true);
    open.unmount();
    expect(on()).toBe(false);
    renderSaved(draftOnFile({ state: 'SUBMITTED' }));
    expect(on()).toBe(false);
  });
});
