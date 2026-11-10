/**
 * lib/device-drafts.ts — the form copies a phone keeps (code review 2026-11-10,
 * findings 4 and 5): how long one is kept, how its age reads, which ones Sign
 * out counts as unsent work, and the sweep of the ones past their keep time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_DRAFT_MAX_AGE_DAYS,
  DEVICE_DRAFT_PREFIXES,
  announceRequestClosed,
  clearDeviceDrafts,
  countDeviceDrafts,
  createDraftKey,
  deviceDraftExpired,
  draftAgeText,
  onRequestClosed,
  signedFormDraftKey,
  sweepExpiredDeviceDrafts,
} from '@/lib/device-drafts';
import { emptyCreateBranch, emptyCreateForm, serializeCreateCopy } from '@/lib/create-draft';
import { enrichmentBase } from '@/lib/enrichment-draft';
import { draftBranchStates, loadedFormState, type LoadedCustomer } from '@/lib/enrichment-patch';

const NOW = new Date('2026-11-10T08:00:00.000Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const loaded: LoadedCustomer = {
  legalName: 'Al Noor Trading',
  crNumber: '1234567',
  channelId: 'ch1',
  subChannelId: null,
  primaryPhone: '+96891234567',
  altPhone: null,
  contactPerson: 'Said',
  contactRole: null,
  status: 'ACTIVE',
  notes: null,
  branches: [
    {
      id: 'b1',
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
    },
  ],
};
/** The edit form's copy: the boxes as loaded, with `over` typed into them. */
const editCopy = (over: Record<string, unknown> = {}, savedAt: number = NOW - HOUR) => {
  const boxes = loadedFormState(loaded);
  const { status: _status, ...text } = boxes.customer;
  return JSON.stringify({
    ...text,
    branchStates: draftBranchStates(boxes.branches, loaded),
    savedAt,
    base: enrichmentBase(loaded),
    ...over,
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('how long a copy is kept', () => {
  it('seven days, as the salesman guide says', () => {
    expect(DEVICE_DRAFT_MAX_AGE_DAYS).toBe(7);
  });

  it('expired only once it is OLDER than that, by the save time and the phone clock', () => {
    expect(deviceDraftExpired(NOW - 7 * DAY, NOW)).toBe(false);
    expect(deviceDraftExpired(NOW - 7 * DAY - 1, NOW)).toBe(true);
    expect(deviceDraftExpired(NOW - 8 * DAY)).toBe(true);
    expect(deviceDraftExpired(NOW - DAY)).toBe(false);
    // A clock set back since: a save time in the future is not old.
    expect(deviceDraftExpired(NOW + DAY, NOW)).toBe(false);
  });

  it.each([undefined, null, '1730000000000', NaN, Infinity, {}])(
    'a copy with no readable save time (%s) has an unknown age: kept, and no age said',
    (savedAt) => {
      expect(deviceDraftExpired(savedAt, NOW)).toBe(false);
      expect(draftAgeText(savedAt, NOW)).toBeNull();
    }
  );
});

describe('a copy\'s age in words', () => {
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [MINUTE, '1 minute ago'],
    [5 * MINUTE + 30_000, '5 minutes ago'],
    [59 * MINUTE, '59 minutes ago'],
    [HOUR, '1 hour ago'],
    [2 * HOUR + 59 * MINUTE, '2 hours ago'],
    [23 * HOUR, '23 hours ago'],
    [DAY, '1 day ago'],
    [3 * DAY + 5 * HOUR, '3 days ago'],
    [40 * DAY, '40 days ago'],
  ])('%d ms → "%s"', (ms, words) => {
    expect(draftAgeText(NOW - ms, NOW)).toBe(words);
  });

  it('a save time ahead of the phone clock reads "just now", never a negative age', () => {
    expect(draftAgeText(NOW + HOUR, NOW)).toBe('just now');
  });
});

describe('Sign out counts only copies that hold unsent work', () => {
  it('an edit-form copy that changes something counts; one that only mirrors the customer does not', () => {
    window.localStorage.setItem('nmwc:draft:u1:changed', editCopy({ notes: 'Closed Fridays' }));
    window.localStorage.setItem('nmwc:draft:u1:mirror', editCopy());
    window.localStorage.setItem('nmwc:draft:u1:mirror-2', editCopy({ primaryPhone: '9123 4567' })); // the same number
    expect(countDeviceDrafts('u1')).toBe(1);
  });

  it('a branch change, a moved point and a status choice each count', () => {
    const boxes = draftBranchStates(loadedFormState(loaded).branches, loaded);
    window.localStorage.setItem(
      'nmwc:draft:u1:coolers',
      editCopy({ branchStates: { b1: { ...boxes.b1, coolers: 3 } } })
    );
    window.localStorage.setItem(
      'nmwc:draft:u1:gps',
      editCopy({ branchStates: { b1: { ...boxes.b1, gps: { lat: 24, lng: 59, accuracy: 3, capturedAt: '2026-11-09T08:00:00.000Z' } } } })
    );
    // A Manager's copy holds the status; a salesman's never does.
    window.localStorage.setItem('nmwc:draft:u1:status', editCopy({ status: 'SUSPENDED' }));
    window.localStorage.setItem('nmwc:draft:u1:status-same', editCopy({ status: 'ACTIVE' }));
    expect(countDeviceDrafts('u1')).toBe(3);
  });

  it('a copy past its keep time is not counted — the form removes it the next time it opens', () => {
    window.localStorage.setItem('nmwc:draft:u1:old', editCopy({ notes: 'Closed Fridays' }, NOW - 8 * DAY));
    window.localStorage.setItem('nmwc:create:u1:new', JSON.stringify({ legalName: 'Blue Sea Cafe', savedAt: NOW - 8 * DAY }));
    expect(countDeviceDrafts('u1')).toBe(0);
    // Sign out still deletes them.
    expect(clearDeviceDrafts('u1')).toBe(2);
  });

  it('a copy that cannot be read or judged is counted: asking once too often is the safe side', () => {
    window.localStorage.setItem('nmwc:draft:u1:no-base', JSON.stringify({ notes: 'Typed long ago' }));
    window.localStorage.setItem('nmwc:draft:u1:bad-base', JSON.stringify({ notes: 'x', base: '[1,2,3]' }));
    window.localStorage.setItem('nmwc:draft:u1:not-json', '{oops');
    window.localStorage.setItem('nmwc:draft:u1:not-an-object', '"text"');
    window.localStorage.setItem('nmwc:draft:u1:a-list', '[]');
    expect(countDeviceDrafts('u1')).toBe(5);
  });

  it('another user\'s copies, and a user id that only starts the same, are not his', () => {
    window.localStorage.setItem('nmwc:draft:u2:c1', editCopy({ notes: 'x' }));
    window.localStorage.setItem('nmwc:draft:u10:c1', editCopy({ notes: 'x' }));
    expect(countDeviceDrafts('u1')).toBe(0);
    expect(countDeviceDrafts('')).toBe(0);
  });
});

describe('sweepExpiredDeviceDrafts', () => {
  it('removes this user\'s copies past their keep time, of both forms, and nothing else', () => {
    const old = NOW - 8 * DAY;
    const keep: Record<string, string> = {
      'nmwc:draft:u1:fresh': editCopy({ notes: 'x' }, NOW - 6 * DAY),
      'nmwc:create:u1:edit-7': JSON.stringify({ legalName: 'Blue Sea Cafe', savedAt: NOW - HOUR }),
      'nmwc:draft:u1:no-age': JSON.stringify({ notes: 'x' }),
      'nmwc:draft:u1:not-json': '{oops',
      // Another user's old copy on a shared phone, and keys that are not form copies.
      'nmwc:draft:u2:old': editCopy({ notes: 'x' }, old),
      'nmwc:sidebar': JSON.stringify({ savedAt: old }),
    };
    for (const [k, v] of Object.entries(keep)) window.localStorage.setItem(k, v);
    window.localStorage.setItem('nmwc:draft:u1:old', editCopy({ notes: 'x' }, old));
    window.localStorage.setItem('nmwc:create:u1:new', JSON.stringify({ legalName: 'Old Cafe', savedAt: old }));

    expect(sweepExpiredDeviceDrafts('u1')).toBe(2);
    expect(Object.keys(window.localStorage).sort()).toEqual(Object.keys(keep).sort());
    for (const [k, v] of Object.entries(keep)) expect(window.localStorage.getItem(k)).toBe(v);
    expect(sweepExpiredDeviceDrafts('u1')).toBe(0);
  });

  it('a browser that refuses storage is left alone', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(sweepExpiredDeviceDrafts('u1')).toBe(0);
  });
});

// Code review 2026-11-10, finding 4.
describe('the keys: each names the user and the form it belongs to', () => {
  it('the new-customer form: one slot for the never-saved form, one per saved request', () => {
    expect(createDraftKey('u1', null)).toBe('nmwc:create:u1:new');
    expect(createDraftKey('u1', 'ckedit1')).toBe('nmwc:create:u1:ckedit1');
    expect(createDraftKey('u2', 'ckedit1')).not.toBe(createDraftKey('u1', 'ckedit1'));
  });

  it('the signed-application pages: per request, and never the request form\'s own key', () => {
    expect(signedFormDraftKey('u1', 'ckedit1')).toBe('nmwc:create:u1:signed:ckedit1');
    expect(signedFormDraftKey('u1', 'ckedit1')).not.toBe(createDraftKey('u1', 'ckedit1'));
    expect(signedFormDraftKey('u1', 'ckedit2')).not.toBe(signedFormDraftKey('u1', 'ckedit1'));
  });

  it('all under the prefixes Sign out clears', () => {
    for (const k of [createDraftKey('u1', null), createDraftKey('u1', 'e'), signedFormDraftKey('u1', 'e')]) {
      expect(DEVICE_DRAFT_PREFIXES.some((p) => k.startsWith(`${p}u1:`)), k).toBe(true);
    }
  });
});

describe('Sign out counts the new-customer copies that hold unsent work', () => {
  const copyOf = (form = emptyCreateForm(), over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...serializeCreateCopy({ form, savedAt: NOW - HOUR, unanswered: [] }), ...over });

  it('a never-saved form with something on it; not a blank one', () => {
    window.localStorage.setItem(createDraftKey('u1', null), copyOf());
    expect(countDeviceDrafts('u1')).toBe(0);
    window.localStorage.setItem(createDraftKey('u1', null), copyOf({ ...emptyCreateForm(), legalName: 'Blue Sea Cafe' }));
    expect(countDeviceDrafts('u1')).toBe(1);
    // A photo or a GPS point alone is unsent work too.
    window.localStorage.setItem(
      createDraftKey('u1', null),
      copyOf({ ...emptyCreateForm(), branches: [{ ...emptyCreateBranch(), shopPhotoId: 'att-shop' }] })
    );
    expect(countDeviceDrafts('u1')).toBe(1);
  });

  it('a blank form whose send still has to be asked about', () => {
    window.localStorage.setItem(
      createDraftKey('u1', null),
      copyOf(emptyCreateForm(), { unanswered: ['3f1c1d2e-7a4b-4c5d-9e8f-0a1b2c3d4e5f'] })
    );
    expect(countDeviceDrafts('u1')).toBe(1);
  });

  it('what was added to a saved draft, and signed-application pages — each its own unsent form', () => {
    window.localStorage.setItem(createDraftKey('u1', 'e1'), copyOf({ ...emptyCreateForm(), legalName: 'Blue Sea Cafe' }, { base: 'v1' }));
    window.localStorage.setItem(signedFormDraftKey('u1', 'e1'), JSON.stringify({ v: 1, savedAt: NOW - HOUR, token: 't', ids: ['p1'] }));
    window.localStorage.setItem(signedFormDraftKey('u1', 'e2'), JSON.stringify({ v: 1, savedAt: NOW - 8 * DAY, token: 't', ids: ['p1'] }));
    expect(countDeviceDrafts('u1'), 'the one past its keep time is not counted').toBe(2);
  });
});

describe('a withdrawn request is announced to the forms that keep a copy of it', () => {
  it('only the forms of that request hear it, and only while they listen', () => {
    const e1 = vi.fn();
    const e2 = vi.fn();
    const none = vi.fn();
    const offE1 = onRequestClosed('e1', e1);
    const offE2 = onRequestClosed('e2', e2);
    // A never-saved form has no request to be withdrawn.
    const offNone = onRequestClosed(null, none);
    announceRequestClosed('e1');
    expect(e1).toHaveBeenCalledTimes(1);
    expect(e2).not.toHaveBeenCalled();
    expect(none).not.toHaveBeenCalled();
    offE1();
    announceRequestClosed('e1');
    expect(e1).toHaveBeenCalledTimes(1);
    offE2();
    offNone();
  });
});
