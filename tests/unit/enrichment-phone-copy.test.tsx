/**
 * Code review 2026-11-10, finding 5 — the edit form's copy on the phone.
 *
 * The form wrote a copy half a second after it opened, changed or not, and never
 * expired it. So "Restored a local draft from your last visit" showed on almost
 * every re-open and meant nothing; a counter bumped by accident weeks ago came
 * back inside an unrelated edit and went out with it (for a Manager or the
 * Steward, straight to the master); a customer changed on the server meanwhile
 * read "your offline draft is older than the latest server changes" to someone
 * who had typed nothing; and Sign out counted every customer merely opened as an
 * unsent form.
 *
 * Now, through the real form (jsdom; the photo slot is mocked, the GPS button is
 * the real one):
 *   - a copy is written only while the boxes differ from what the page loaded,
 *     and removed when they no longer do — never on open;
 *   - a restored copy says which fields it changes and how old it is, and offers
 *     "Discard these changes";
 *   - a copy is kept for seven days from its last change;
 *   - one line above Submit names what is being changed, from the real diff;
 *   - a copy that changes nothing (what the old form left on every phone) is
 *     removed without a word, stale or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { Role } from '@prisma/client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <button>Photo fixture</button> }));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { returnedPrefill } from '@/app/(app)/customers/[id]/edit/returned';
import { enrichmentBase } from '@/lib/enrichment-draft';
import { draftBranchStates, loadedFormState } from '@/lib/enrichment-patch';
import { countDeviceDrafts } from '@/lib/device-drafts';

type Customer = ComponentProps<typeof EnrichmentForm>['customer'];

const NOW = new Date('2026-11-10T08:00:00.000Z').getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KEY = 'nmwc:draft:u1:c1';

const branch = (id: string, over: Partial<Customer['branches'][number]> = {}): Customer['branches'][number] => ({
  id,
  branchName: 'Main',
  address: 'Way 1, Ruwi',
  areaDescription: null,
  gpsLat: 23.5,
  gpsLng: 58.3,
  gpsAccuracy: 5,
  gpsCapturedAt: new Date('2026-10-01T08:00:00.000Z'),
  dayOfVisit: 'SUN',
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 2,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: true,
  status: 'ACTIVE',
  shopPhotoId: 'p-shop',
  signboardPhotoId: 'p-sign',
  region: { name: 'Muscat' },
  route: { code: 'MCT-01' },
  ...over,
});
const customer: Customer = {
  id: 'c1',
  nmwcCode: 'NMWC-000001',
  legalName: 'Al Noor Trading',
  paymentTerms: 'CASH',
  crNumber: '1234567',
  channelId: 'ch1',
  subChannelId: null,
  primaryPhone: '+96891234567',
  altPhone: null,
  contactPerson: 'Said',
  contactRole: null,
  status: 'ACTIVE',
  notes: null,
  crPhotoId: 'p-cr',
  branches: [branch('b1')],
};
const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [] }];

type Asked = { ok: PositionCallback };
let gps: Asked[];
let sent: Array<Record<string, unknown>>;
let reply: unknown;

function form(role: Role = 'SALESMAN', c: Customer = customer, extra: Partial<ComponentProps<typeof EnrichmentForm>> = {}) {
  return render(
    <EnrichmentForm
      customer={c}
      channels={channels}
      lockName={role === 'SALESMAN'}
      lockCr={false}
      userRole={role}
      canSubmit
      sessionUserId="u1"
      gate="CORE"
      {...extra}
    />
  );
}
const tick = (ms = 600) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const stored = () => {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown> & { savedAt: number });
};
/** The copy on the phone, as if it had last changed `ms` ago. */
const age = (ms: number) => {
  const copy = stored()!;
  window.localStorage.setItem(KEY, JSON.stringify({ ...copy, savedAt: Date.now() - ms }));
};
/** What the form before this fix left behind for a customer merely opened. */
const mirrorCopy = (c: Customer, role: Role, savedAt: number) => {
  const boxes = loadedFormState(c);
  const { status, ...text } = boxes.customer;
  return {
    ...text,
    ...(role === 'MANAGER' || role === 'STEWARD' ? { status } : {}),
    branchStates: draftBranchStates(boxes.branches, c),
    savedAt,
    base: enrichmentBase(c),
  };
};
const notes = () => screen.getByLabelText('Notes');
const phone = () => screen.getByLabelText('Primary phone *');
const contact = () => screen.getByLabelText('Contact person *');
const changingLine = () => screen.queryByText(/^You are changing:/)?.textContent ?? null;
const banner = () => screen.queryByText('Restored a local draft from your last visit.')?.parentElement ?? null;
const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  nav.hardReplace.mockReset();
  gps = [];
  sent = [];
  reply = { ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: null, replayed: false } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok: PositionCallback) => gps.push({ ok }) },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'geolocation');
});

describe('5(a): a copy is written only while the form differs from what the page loaded', () => {
  it.each(['SALESMAN', 'MANAGER', 'STEWARD'] as const)('a form merely opened writes nothing, as %s', async (role) => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    form(role);
    await tick();
    await tick(5_000);
    expect(setItem).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(changingLine()).toBeNull();
    // …and Sign out has no "unsent form" to ask about.
    expect(countDeviceDrafts('u1')).toBe(0);
  });

  it('a photo alone (which saves itself) writes nothing either', async () => {
    form();
    fireEvent.click(screen.getAllByRole('button', { name: 'Photo fixture' })[0]!);
    await tick();
    expect(stored()).toBeNull();
  });

  it('a change is written after the pause, and removed when it is undone', async () => {
    form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    await tick();
    expect(stored()).toMatchObject({ notes: 'Closed Fridays', savedAt: NOW + 500, base: enrichmentBase(customer) });
    expect(countDeviceDrafts('u1')).toBe(1);

    fireEvent.change(notes(), { target: { value: '' } });
    await tick();
    expect(stored()).toBeNull();
    expect(countDeviceDrafts('u1')).toBe(0);

    // A branch box, and back.
    fireEvent.change(screen.getByLabelText(/^Day of visit/), { target: { value: 'MON' } });
    await tick();
    expect((stored()!.branchStates as Record<string, { dayOfVisit: string }>).b1!.dayOfVisit).toBe('MON');
    fireEvent.change(screen.getByLabelText(/^Day of visit/), { target: { value: 'SUN' } });
    await tick();
    expect(stored()).toBeNull();
  });

  it('the same phone number typed another way is no change, so no copy', async () => {
    form();
    fireEvent.change(phone(), { target: { value: '9123 4567' } });
    await tick();
    expect(stored()).toBeNull();
    expect(changingLine()).toBeNull();
  });

  it('a Save draft with nothing changed leaves no copy behind', async () => {
    reply = { ok: false, code: 'VALIDATION_FAILED', message: 'No changes to submit.', fields: { _form: 'No changes to submit.' } };
    form();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await tick();
    expect(stored()).toBeNull();
  });
});

describe('5(b): a restored copy says which fields it changes and how old it is, and can be discarded', () => {
  /** A visit that changed the contact person and bumped a counter, then left. */
  const leaveUnsent = async (role: Role = 'SALESMAN') => {
    const visit = form(role);
    fireEvent.change(contact(), { target: { value: 'Said Al Harthy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Increase Coolers' }));
    await tick();
    visit.unmount();
  };

  it('a reload puts the changes back, names them and says when they were saved', async () => {
    await leaveUnsent();
    age(3 * DAY);
    form();
    expect(contact()).toHaveValue('Said Al Harthy');
    expect(screen.getByRole('spinbutton', { name: 'Coolers' })).toHaveValue('3');
    const box = banner()!;
    expect(box).not.toBeNull();
    expect(box.getAttribute('role')).toBe('status');
    expect(within(box).getByText('Saved on this phone 3 days ago. It changes: Contact person, Coolers.')).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Discard these changes' })).toBeEnabled();
    // The line above Submit says the same, from the boxes as they are.
    expect(changingLine()).toBe('You are changing: Contact person, Coolers.');
  });

  it.each([
    [30_000, 'just now'],
    [5 * MINUTE, '5 minutes ago'],
    [MINUTE, '1 minute ago'],
    [2 * 60 * MINUTE, '2 hours ago'],
    [DAY, '1 day ago'],
  ])('a copy last changed %d ms ago reads "%s"', async (ms, words) => {
    await leaveUnsent();
    age(ms);
    form();
    expect(within(banner()!).getByText(`Saved on this phone ${words}. It changes: Contact person, Coolers.`)).toBeTruthy();
  });

  it('with more than one branch on the page, a branch field says which branch', async () => {
    const two = { ...customer, branches: [branch('b1'), branch('b2', { branchName: 'Seeb', address: 'Way 2, Seeb' })] };
    const visit = form('SALESMAN', two);
    fireEvent.change(screen.getAllByLabelText(/^Day of visit/)[1]!, { target: { value: 'TUE' } });
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    await tick();
    visit.unmount();
    form('SALESMAN', two);
    expect(within(banner()!).getByText('Saved on this phone just now. It changes: Notes, Branch 2: Day of visit.')).toBeTruthy();
    expect(changingLine()).toBe('You are changing: Notes, Branch 2: Day of visit.');
  });

  it('"Discard these changes" asks, then puts the boxes back and removes the copy', async () => {
    await leaveUnsent();
    form();
    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    expect(screen.getByText('Discard them? The form goes back to the customer as saved.')).toBeTruthy();
    // "Keep them" changes nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(contact()).toHaveValue('Said Al Harthy');
    expect(stored()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
    expect(contact()).toHaveValue('Said');
    expect(screen.getByRole('spinbutton', { name: 'Coolers' })).toHaveValue('2');
    expect(banner()).toBeNull();
    expect(changingLine()).toBeNull();
    expect(stored()).toBeNull();
    // …and the autosave already due does not write it back.
    await tick(5_000);
    expect(stored()).toBeNull();
    expect(countDeviceDrafts('u1')).toBe(0);
  });

  it('a discarded GPS point: the chip goes back to the saved location, and the point is not sent', async () => {
    const visit = form();
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await act(async () => {
      gps[0]!.ok({ coords: { latitude: 24, longitude: 59, accuracy: 3 } } as GeolocationPosition);
    });
    await tick();
    visit.unmount();

    form();
    expect(screen.getByText('24.000000, 59.000000')).toBeTruthy();
    expect(within(banner()!).getByText('Saved on this phone just now. It changes: Location.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    expect(screen.queryByText('24.000000, 59.000000')).toBeNull();

    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    fireEvent.click(submitBtn());
    await tick(0);
    expect(sent[0]).toMatchObject({ customer: { notes: 'Closed Fridays' }, branches: [] });
  });

  it('the banner is off while a submit is on its way, and goes once the server has the changes', async () => {
    await leaveUnsent();
    form();
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByRole('button', { name: 'Discard these changes' })).toBeDisabled();
    await act(async () => {
      answer(
        new Response(JSON.stringify({ ok: true, data: { editId: 'd1', state: 'DRAFT', submittedAt: null, replayed: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    });
    await tick(0);
    expect(banner()).toBeNull();
    // Owner decision (item 22): a saved draft stays on the phone.
    expect(stored()).toMatchObject({ contactPerson: 'Said Al Harthy' });
  });

  it('the banner goes when he undoes the restored changes by hand', async () => {
    const visit = form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    await tick();
    visit.unmount();
    form();
    expect(banner()).not.toBeNull();
    fireEvent.change(notes(), { target: { value: '' } });
    expect(banner()).toBeNull();
    await tick();
    expect(stored()).toBeNull();
  });

  it("the review's case: an old counter bump is listed, discarded, and a phone-only submit then sends only the phone", async () => {
    // Two weeks… no: five days ago he bumped Coolers while scrolling, and left.
    const first = form();
    fireEvent.click(screen.getByRole('button', { name: 'Increase Coolers' }));
    await tick();
    first.unmount();
    age(5 * DAY);

    // Today he opens the customer to fix the phone number.
    form();
    expect(within(banner()!).getByText('Saved on this phone 5 days ago. It changes: Coolers.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
    fireEvent.change(phone(), { target: { value: '+96899887766' } });
    expect(changingLine()).toBe('You are changing: Primary phone.');
    fireEvent.click(submitBtn());
    await tick(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.customer).toEqual({ primaryPhone: '+96899887766' });
    expect(sent[0]!.branches).toEqual([]);
  });

  it('left in, the old change is named above Submit before it goes — also for a Manager, whose submit is written at once', async () => {
    const first = form('MANAGER');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'SUSPENDED' } });
    await tick();
    first.unmount();
    age(2 * DAY);

    form('MANAGER');
    expect(within(banner()!).getByText('Saved on this phone 2 days ago. It changes: Status.')).toBeTruthy();
    fireEvent.change(phone(), { target: { value: '+96899887766' } });
    expect(changingLine()).toBe('You are changing: Primary phone, Status.');
  });
});

describe('5(c): a copy is kept for seven days from its last change', () => {
  const leaveNote = async () => {
    const visit = form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    await tick();
    visit.unmount();
  };

  it('an eight-day-old copy is not restored: it is removed, with what it had changed', async () => {
    await leaveNote();
    age(8 * DAY);
    form();
    expect(notes()).toHaveValue('');
    expect(banner()).toBeNull();
    expect(
      screen.getByText(
        'An unsent draft saved on this phone 8 days ago was removed: drafts are kept for 7 days. It had changed: Notes.'
      )
    ).toBeTruthy();
    expect(stored()).toBeNull();
    expect(changingLine()).toBeNull();
  });

  it('seven days less a minute is still restored; seven days and a minute is not', async () => {
    await leaveNote();
    age(7 * DAY - MINUTE);
    const kept = form();
    expect(notes()).toHaveValue('Closed Fridays');
    kept.unmount();
    age(7 * DAY + MINUTE);
    form();
    expect(notes()).toHaveValue('');
    expect(stored()).toBeNull();
  });

  it('opening the form again does not make the copy younger; a change to it does', async () => {
    await leaveNote();
    age(6 * DAY);
    const savedAt = stored()!.savedAt;
    const again = form();
    await tick(5_000);
    expect(stored()!.savedAt).toBe(savedAt);
    again.unmount();
    // The next day it is past seven days, although he looked at it yesterday.
    vi.setSystemTime(NOW + 2 * DAY);
    const late = form();
    expect(screen.getByText(/was removed: drafts are kept for 7 days/)).toBeTruthy();
    late.unmount();

    // A copy he goes on working on stays young.
    vi.setSystemTime(NOW);
    await leaveNote();
    age(6 * DAY);
    form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays and Saturdays' } });
    await tick();
    expect(Date.now() - stored()!.savedAt).toBeLessThan(1_000);
  });

  it('the expired copies of other customers leave the phone when a form opens; another user\'s stay', async () => {
    const old = JSON.stringify({ notes: 'x', savedAt: NOW - 9 * DAY, base: enrichmentBase(customer) });
    const fresh = JSON.stringify({ notes: 'x', savedAt: NOW - DAY, base: enrichmentBase(customer) });
    window.localStorage.setItem('nmwc:draft:u1:other-old', old);
    window.localStorage.setItem('nmwc:draft:u1:other-fresh', fresh);
    window.localStorage.setItem('nmwc:draft:u2:c1', old);
    form();
    expect(window.localStorage.getItem('nmwc:draft:u1:other-old')).toBeNull();
    expect(window.localStorage.getItem('nmwc:draft:u1:other-fresh')).toBe(fresh);
    expect(window.localStorage.getItem('nmwc:draft:u2:c1')).toBe(old);
  });
});

describe('5(d): one line above Submit says what is being changed', () => {
  it('follows the boxes as they are, and is absent when nothing differs', async () => {
    form();
    expect(changingLine()).toBeNull();
    fireEvent.change(phone(), { target: { value: '+96899887766' } });
    expect(changingLine()).toBe('You are changing: Primary phone.');
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    expect(changingLine()).toBe('You are changing: Primary phone, Notes.');
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await act(async () => {
      gps[0]!.ok({ coords: { latitude: 24, longitude: 59, accuracy: 3 } } as GeolocationPosition);
    });
    // The point is one box: its coordinates, accuracy and capture time are "Location", once.
    expect(changingLine()).toBe('You are changing: Primary phone, Notes, Location.');
    fireEvent.change(phone(), { target: { value: '+96891234567' } });
    expect(changingLine()).toBe('You are changing: Notes, Location.');
  });

  it('it sits in the Submit bar, above the buttons', () => {
    form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    const line = screen.getByText(/^You are changing:/);
    const bar = submitBtn().closest('.sticky')!;
    expect(bar.contains(line)).toBe(true);
    expect(line.compareDocumentPosition(submitBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a count entered says "Equipment counted" too, when the branch was not counted before', () => {
    form('SALESMAN', { ...customer, branches: [branch('b1', { equipmentConfirmed: false })] });
    fireEvent.click(screen.getByRole('button', { name: 'Increase Coolers' }));
    expect(changingLine()).toBe('You are changing: Coolers, Equipment counted.');
  });

  it('is gone once the submit arrived', async () => {
    form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    fireEvent.click(submitBtn());
    await tick(0);
    expect(nav.hardReplace).toHaveBeenCalled();
    expect(changingLine()).toBeNull();
  });
});

describe('5(e): no false "Restored", no false "older than the server", no inflated count', () => {
  it.each(['SALESMAN', 'MANAGER'] as const)(
    'a copy that only mirrors the customer (left by the old form) is removed without a word, as %s',
    async (role) => {
      window.localStorage.setItem(KEY, JSON.stringify(mirrorCopy(customer, role, NOW - 20 * DAY)));
      // Sign out no longer counts it as an unsent form.
      expect(countDeviceDrafts('u1')).toBe(0);
      form(role);
      expect(banner()).toBeNull();
      expect(screen.queryByText(/older than the latest server changes/)).toBeNull();
      expect(screen.queryByText(/was removed/)).toBeNull();
      expect(stored()).toBeNull();
    }
  );

  it('a mirror copy of the customer as it WAS says nothing either — he typed nothing, so he lost nothing', () => {
    // He opened the customer (old form: a copy). Then an import changed the contact.
    window.localStorage.setItem(KEY, JSON.stringify(mirrorCopy(customer, 'SALESMAN', NOW - DAY)));
    expect(countDeviceDrafts('u1')).toBe(0);
    form('SALESMAN', { ...customer, contactPerson: 'Omar', branches: [branch('b1', { coolersCount: 4 })] });
    expect(screen.queryByText(/older than the latest server changes/)).toBeNull();
    expect(banner()).toBeNull();
    expect(contact()).toHaveValue('Omar');
    expect(stored()).toBeNull();
  });

  it('a copy that held a real change, on a customer changed since, still says so — with what it had changed and when', async () => {
    const visit = form();
    fireEvent.change(notes(), { target: { value: 'Closed Fridays' } });
    fireEvent.change(screen.getByLabelText(/^Day of visit/), { target: { value: 'MON' } });
    await tick();
    visit.unmount();
    age(2 * 60 * MINUTE);
    expect(countDeviceDrafts('u1')).toBe(1);
    form('SALESMAN', { ...customer, contactPerson: 'Omar' });
    expect(
      screen.getByText(
        'Your offline draft is older than the latest server changes. The form has been refreshed — re-enter anything you still need. It was saved 2 hours ago and had changed: Notes, Day of visit.'
      )
    ).toBeTruthy();
    expect(notes()).toHaveValue('');
    expect(stored()).toBeNull();
  });

  it('a copy with no starting values at all (before item 22) is dropped with the plain warning, as before', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ notes: 'Typed long ago', savedAt: NOW - DAY }));
    // Nothing says it holds no change: it is counted, and said.
    expect(countDeviceDrafts('u1')).toBe(1);
    form();
    expect(
      screen.getByText(
        'Your offline draft is older than the latest server changes. The form has been refreshed — re-enter anything you still need.'
      )
    ).toBeTruthy();
    expect(stored()).toBeNull();
  });
});

describe('opened on a sent-back update (what he sent, filled in)', () => {
  const sentBack = [
    { field: 'customer.contactRole', before: null, after: 'Partner' },
    { field: 'branch.b1.dayOfVisit', before: 'SUN', after: 'MON' },
  ];
  const returned = () => ({
    returned: { id: 'e9', prefill: returnedPrefill(customer, sentBack, { lockName: true, lockCr: false }).state },
  });

  it('the copy of what he sent is not announced as a restore each time he opens it; only what he added on the phone is', async () => {
    const first = form('SALESMAN', customer, returned());
    await tick();
    // What he sent differs from the customer: it is unsent work, kept (and tagged).
    expect(stored()).toMatchObject({ returnedId: 'e9', contactRole: 'Partner' });
    first.unmount();

    const second = form('SALESMAN', customer, returned());
    expect(banner()).toBeNull();
    expect(changingLine()).toBe('You are changing: Contact role, Day of visit.');
    await tick();
    expect(stored()).toMatchObject({ returnedId: 'e9', contactRole: 'Partner' });
    fireEvent.change(notes(), { target: { value: 'Asked for by the supervisor' } });
    await tick();
    second.unmount();

    form('SALESMAN', customer, returned());
    expect(within(banner()!).getByText('Saved on this phone just now. It changes: Notes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard these changes' }));
    expect(screen.getByText('Discard them? The form goes back to what you sent.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
    expect(notes()).toHaveValue('');
    expect(screen.getByLabelText('Contact role')).toHaveValue('Partner');
    expect(changingLine()).toBe('You are changing: Contact role, Day of visit.');
  });
});
