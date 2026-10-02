import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CustomerStatus, Role } from '@prisma/client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <button>Photo fixture</button> }));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { GpsCaptureButton } from '@/components/nmwc/GpsCaptureButton';
import { SUBMIT_TIMEOUT_MS } from '@/lib/submit-client';
import { enrichmentBase } from '@/lib/enrichment-draft';

const customer = {
  id: 'synthetic-customer', nmwcCode: 'SYNTHETIC', legalName: 'Synthetic customer',
  paymentTerms: 'CASH' as const, crNumber: null, channelId: null, subChannelId: null,
  primaryPhone: '+96890000000', altPhone: null, contactPerson: 'Synthetic contact', contactRole: null,
  status: 'ACTIVE' as const, notes: null, crPhotoId: null,
  branches: [{
    id: 'synthetic-branch', branchName: 'Synthetic branch', address: 'Synthetic address', areaDescription: null,
    gpsLat: 23.5, gpsLng: 58.3, gpsAccuracy: 5, gpsCapturedAt: new Date('2026-01-01T00:00:00Z'),
    dayOfVisit: 'SUN' as const, openingHours: null, deliveryWindow: null,
    coolersCount: 0, standsCount: 0, emptyBottlesCount: 0, equipmentConfirmed: false,
    status: 'ACTIVE' as const, shopPhotoId: 'synthetic-photo', signboardPhotoId: null,
    region: { name: 'Synthetic region' }, route: { code: 'SYNTHETIC' },
  }],
};
const draftKey = 'nmwc:draft:synthetic-user:synthetic-customer';
const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const receipt = (state: string, replayed = false) => ({ ok: true, data: { id: 'receipt', state, replayed } });
type Asked = { ok: PositionCallback; fail: PositionErrorCallback };
let gps: Asked[];
let sent: Array<Record<string, unknown>>;
let finish: (body: unknown) => void;
let abortRequest: () => void;

function form(role: Role = 'MANAGER', status: CustomerStatus = 'ACTIVE') {
  return render(<EnrichmentForm customer={{ ...customer, status }} channels={[]} lockName={false}
    lockCr={false} userRole={role} canSubmit sessionUserId="synthetic-user" gate="CORE" />);
}
const notes = () => screen.getByLabelText(/Notes/);
const submit = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
const save = () => screen.getByRole('button', { name: 'Save draft' });
const tick = (ms = 500) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const answer = (body: unknown) => act(async () => { finish(body); });
const changeNotes = (value: string) => fireEvent.change(notes(), { target: { value } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
  gps = [];
  sent = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve, reject) => {
      finish = (body) => resolve(response(body));
      abortRequest = () => reject(new DOMException('Synthetic abort', 'AbortError'));
      init.signal?.addEventListener('abort', abortRequest, { once: true });
    });
  }));
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) => gps.push({ ok, fail }),
  } });
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'geolocation');
});

describe('OCT-02: the submitted snapshot stays fixed until its outcome', () => {
  it.each(['success', 'refusal', 'timeout', 'replay'])('locks controls during a slow %s and handles later edits', async (outcome) => {
    form();
    changeNotes('First snapshot');
    await tick();
    fireEvent.click(submit());
    expect(sent).toHaveLength(1);
    // Native fieldset disabling covers nested text, branch, photo, GPS and status controls.
    for (const control of document.querySelectorAll('input, textarea, select, button')) expect(control).toBeDisabled();
    fireEvent.change(notes(), { target: { value: 'Attempted while sending' } });
    expect(notes()).toHaveValue('First snapshot');
    if (outcome === 'timeout') await tick(SUBMIT_TIMEOUT_MS);
    else await answer(outcome === 'refusal'
      ? { ok: false, code: 'FORBIDDEN', message: 'Synthetic refusal' }
      : receipt('APPROVED', outcome === 'replay'));
    if (outcome === 'success' || outcome === 'replay') {
      expect(notes()).toBeDisabled();
      expect(window.localStorage.getItem(draftKey)).toBeNull();
      await tick();
      expect(window.localStorage.getItem(draftKey)).toBeNull();
      expect(nav.hardReplace).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    } else {
      expect(notes()).toBeEnabled();
      changeNotes('Later local edit');
      await tick();
      expect(JSON.parse(window.localStorage.getItem(draftKey)!).notes).toBe('Later local edit');
      fireEvent.click(submit());
      expect(sent[1].submissionId).not.toBe(sent[0].submissionId);
      expect((sent[1].customer as Record<string, unknown>).notes).toBe('Later local edit');
      await answer(receipt('APPROVED'));
    }
  });

  it('drops an in-flight GPS fix delivered during submit or after arrival', async () => {
    form();
    changeNotes('Snapshot');
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    fireEvent.click(submit());
    await act(async () => { gps[0].ok({ coords: { latitude: 24, longitude: 59, accuracy: 3 } } as GeolocationPosition); });
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    await answer(receipt('APPROVED'));
    await act(async () => { gps[0].ok({ coords: { latitude: 25, longitude: 59, accuracy: 3 } } as GeolocationPosition); });
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    await tick();
    expect(window.localStorage.getItem(draftKey)).toBeNull();
  });

  it('locks conflict choices during draft save and re-enables them afterward', async () => {
    form();
    changeNotes('Local value');
    fireEvent.click(submit());
    await answer({ ok: false, code: 'STALE_FIELDS', message: 'Changed',
      fields: { 'customer.notes': 'Changed' }, current: { 'customer.notes': 'Server value' } });
    const mine = screen.getByRole('button', { name: 'Keep mine' });
    fireEvent.click(save());
    expect(mine).toBeDisabled();
    fireEvent.click(mine);
    await answer(receipt('DRAFT'));
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeEnabled();
    expect(notes()).toHaveValue('Local value');
  });
});

describe('OCT-03: explicit manual location wins over an older device request', () => {
  it.each(['success', 'error'])('preserves the point, Manual badge and reason after a late %s', async (late) => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter coordinates manually' }));
    fireEvent.change(screen.getByLabelText(/Latitude/), { target: { value: '23.6' } });
    fireEvent.change(screen.getByLabelText(/Longitude/), { target: { value: '58.4' } });
    fireEvent.change(screen.getByLabelText(/Why didn't GPS work/), { target: { value: 'Synthetic manual reason' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual location' }));
    await act(async () => {
      if (late === 'success') gps[0].ok({ coords: { latitude: 24, longitude: 59, accuracy: 3 } } as GeolocationPosition);
      else gps[0].fail({ code: 3, TIMEOUT: 3, message: 'Synthetic timeout' } as GeolocationPositionError);
    });
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture.mock.calls[0][0]).toMatchObject({ lat: 23.6, lng: 58.4, isManual: true, manualReason: 'Synthetic manual reason' });
    expect(screen.getByText('23.600000, 58.400000')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.queryByLabelText(/Latitude/)).toBeNull();
    expect(screen.queryByText(/Location took too long/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeEnabled();
  });
});

describe('OCT-04: explicit draft success means the phone copy is already durable', () => {
  it.each([false, true])('persists before a quick leave/remount, including replay=%s', async (replayed) => {
    const view = form();
    changeNotes('Typed immediately before save');
    fireEvent.click(save());
    await answer(receipt('DRAFT', replayed));
    // No debounce timer has elapsed; unmount cancels it.
    view.unmount();
    expect(window.localStorage.getItem(draftKey)).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(draftKey)!).notes).toBe('Typed immediately before save');
    form();
    expect(notes()).toHaveValue('Typed immediately before save');
  });

  it.each(['QuotaExceededError', 'SecurityError'])('reports phone failure instead of success for %s', async (name) => {
    form();
    changeNotes('Unsaved phone value');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Synthetic storage refusal', name); });
    fireEvent.click(save());
    await answer(receipt('DRAFT'));
    expect(screen.getByText(/could not save.*phone/i)).toBeTruthy();
    expect(screen.queryByText(/✓ Draft saved/)).toBeNull();
    expect(notes()).toHaveValue('Unsaved phone value');
    await tick();
    expect(screen.getByText(/could not save.*phone/i)).toBeTruthy();
  });

  it('handles blocked storage reads without crashing or claiming restoration', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Synthetic storage refusal', 'SecurityError'); });
    expect(() => form()).not.toThrow();
    expect(screen.getByText(/could not read.*phone/i)).toBeTruthy();
  });
});

describe('OCT-05: permitted status choices survive the phone draft', () => {
  it.each(['ACTIVE', 'CLOSED', 'SUSPENDED'] as const)('round-trips %s after explicit save', async (status) => {
    const initial = status === 'ACTIVE' ? 'CLOSED' : 'ACTIVE';
    const view = form('MANAGER', initial);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: status } });
    fireEvent.click(save());
    await answer(receipt('DRAFT'));
    // Let autosave finish so this isolates omitted status from OCT-04's flush.
    await tick();
    view.unmount();
    form('MANAGER', initial);
    expect(screen.getByLabelText('Status')).toHaveValue(status);
    fireEvent.click(save());
    expect((sent[1].customer as Record<string, unknown>).status).toBe(status);
    await answer(receipt('DRAFT'));
  });

  it('persists status through the debounced autosave for a Steward too', async () => {
    const view = form('STEWARD');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'SUSPENDED' } });
    await tick();
    view.unmount();
    form('STEWARD');
    expect(screen.getByLabelText('Status')).toHaveValue('SUSPENDED');
  });

  it.each(['SALESMAN', 'MANAGER'] as const)('ignores unauthorized or malformed saved status for %s', async (role) => {
    window.localStorage.setItem(draftKey, JSON.stringify({ base: enrichmentBase(customer), status: role === 'SALESMAN' ? 'CLOSED' : 'INVALID' }));
    form(role);
    if (role === 'SALESMAN') expect(screen.queryByLabelText('Status')).toBeNull();
    else expect(screen.getByLabelText('Status')).toHaveValue('ACTIVE');
    fireEvent.click(save());
    expect((sent[0].customer as Record<string, unknown>).status).toBeUndefined();
    await answer(receipt('DRAFT'));
  });

  it('retains the stale-base guard for status restoration', () => {
    window.localStorage.setItem(draftKey, JSON.stringify({ base: enrichmentBase(customer), status: 'SUSPENDED' }));
    form('MANAGER', 'CLOSED');
    expect(screen.getByLabelText('Status')).toHaveValue('CLOSED');
    expect(screen.getByText(/offline draft is older/)).toBeTruthy();
  });
});
