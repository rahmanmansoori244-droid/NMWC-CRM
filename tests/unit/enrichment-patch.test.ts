// @vitest-environment node
/**
 * Phase 2 (F06, F20, F21, ruling 1): what the enrichment form sends
 * (lib/enrichment-patch.ts). Only the fields touched since the page loaded,
 * each with the value it loaded; an emptied box as null; the location only
 * when its coordinates moved; "counted" when ticked or when a count moved.
 * Every body built here is also parsed with the server's own schema, so a
 * shape the builder produces and the schema refuses fails here, not in a shop.
 */
import { describe, it, expect } from 'vitest';
import { submitEditSchema, keysWithoutBase } from '@/lib/validation/edit';
import {
  buildEnrichmentPatch,
  conflictsFrom,
  countedNow,
  loadedFormState,
  openConflicts,
  resolveConflict,
  restoreBranchStates,
  restoreKept,
  sentPaths,
  type EnrichmentPatch,
  type FormBranch,
  type FormCustomer,
  type FormState,
  type LoadedBranch,
  type LoadedCustomer,
  type PatchOptions,
} from '@/lib/enrichment-patch';

const CUST = 'ckcustomeraaaaaaaaaaaaaaa';
const B1 = 'ckbranchoneaaaaaaaaaaaaaa';
const B2 = 'ckbranchtwoaaaaaaaaaaaaaa';
const CH_A = 'ckchannelaaaaaaaaaaaaaaaa';
const CH_B = 'ckchannelbbbbbbbbbbbbbbbb';
const SUB_A = 'cksubchannelaaaaaaaaaaaaa';
const SUB_B = 'cksubchannelbbbbbbbbbbbbb';
const CAPTURED = '2026-09-24T08:00:00.000Z';

const SALESMAN: PatchOptions = { role: 'SALESMAN', lockName: true, lockCr: false };
const MANAGER: PatchOptions = { role: 'MANAGER', lockName: false, lockCr: false };

const branch = (id: string, over: Partial<LoadedBranch> = {}): LoadedBranch => ({
  id,
  address: 'Way 1, Ruwi',
  areaDescription: null,
  gpsLat: 23.5,
  gpsLng: 58.3,
  gpsAccuracy: 5,
  gpsCapturedAt: new Date(CAPTURED),
  dayOfVisit: 'SUN',
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 1,
  standsCount: 2,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  ...over,
});

const loaded = (over: Partial<LoadedCustomer> = {}): LoadedCustomer => ({
  legalName: 'Al Noor Trading',
  crNumber: '1234567',
  channelId: CH_A,
  subChannelId: SUB_A,
  primaryPhone: '+96891234567',
  altPhone: '+96899887766',
  contactPerson: 'Said',
  contactRole: null,
  status: 'ACTIVE',
  notes: null,
  branches: [
    branch(B1),
    branch(B2, { gpsLat: null, gpsLng: null, gpsAccuracy: null, gpsCapturedAt: null }),
  ],
  ...over,
});

/** The boxes as loaded, then changed. */
function stateOf(
  l: LoadedCustomer,
  customer: Partial<FormCustomer> = {},
  branches: Record<string, Partial<FormBranch>> = {}
): FormState {
  const s = loadedFormState(l);
  return {
    customer: { ...s.customer, ...customer },
    branches: Object.fromEntries(
      Object.entries(s.branches).map(([id, b]) => [id, { ...b, ...branches[id] }])
    ),
  };
}

/** Built, then read by the server's schema exactly as the route reads a body. */
function build(
  l: LoadedCustomer,
  s: FormState,
  opts: PatchOptions = MANAGER,
  kept?: Parameters<typeof buildEnrichmentPatch>[2]['kept']
) {
  const patch = buildEnrichmentPatch(l, s, { ...opts, kept });
  const parsed = submitEditSchema.safeParse({
    v: 2,
    customerId: CUST,
    isDraft: false,
    ...JSON.parse(JSON.stringify(patch)),
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(keysWithoutBase(parsed.data!)).toEqual([]);
  return patch;
}

const branchOf = (patch: EnrichmentPatch, id: string) =>
  patch.branches.find((b) => b.branchId === id);

describe('buildEnrichmentPatch — only what was touched', () => {
  it('an untouched form sends nothing, for every role', () => {
    for (const opts of [SALESMAN, MANAGER]) {
      expect(build(loaded(), stateOf(loaded()), opts)).toEqual({
        customer: {},
        customerBase: {},
        branches: [],
      });
    }
  });

  it('the notes alone: that field, with the value the page loaded', () => {
    expect(build(loaded(), stateOf(loaded(), { notes: 'Closed Fridays' }))).toEqual({
      customer: { notes: 'Closed Fridays' },
      customerBase: { notes: null },
      branches: [],
    });
  });

  it('F20: emptying a field that had a value sends null; emptying an empty one sends nothing', () => {
    const l = loaded({ notes: 'Old note', contactRole: null });
    const patch = build(l, stateOf(l, { notes: '   ', contactRole: '' }));
    expect(patch.customer).toEqual({ notes: null });
    expect(patch.customerBase).toEqual({ notes: 'Old note' });
    expect(build(l, stateOf(l, { altPhone: '' })).customer).toEqual({ altPhone: null });
  });

  it('F20: an emptied required field is sent as null too — the server refuses it with its own words', () => {
    const s = stateOf(loaded(), { contactPerson: '' }, { [B1]: { address: '', dayOfVisit: '' } });
    const patch = buildEnrichmentPatch(loaded(), s, MANAGER);
    expect(patch.customer).toEqual({ contactPerson: null });
    expect(branchOf(patch, B1)).toMatchObject({
      address: null,
      dayOfVisit: null,
      base: { address: 'Way 1, Ruwi', dayOfVisit: 'SUN' },
    });
    const parsed = submitEditSchema.safeParse({ v: 2, customerId: CUST, ...patch });
    expect(parsed.error?.issues.map((i) => i.message).sort()).toEqual([
      'Address cannot be removed — correct it instead.',
      'Contact person cannot be removed.',
      'Day of visit cannot be removed once set — pick the right day.',
    ]);
  });

  it('the same phone typed another way is no change; another number is sent as typed', () => {
    for (const same of ['9123 4567', '+968 9123 4567', '0096891234567', '٩١٢٣٤٥٦٧', '۹۱۲۳۴۵۶۷']) {
      expect(build(loaded(), stateOf(loaded(), { primaryPhone: same })).customer, same).toEqual({});
    }
    const patch = build(loaded(), stateOf(loaded(), { primaryPhone: ' 9555 1234 ' }));
    expect(patch.customer).toEqual({ primaryPhone: '9555 1234' });
    expect(patch.customerBase).toEqual({ primaryPhone: '+96891234567' });
  });

  it('F16: a new channel carries the sub-channel it leaves — null, or the one picked for it', () => {
    const cleared = build(loaded(), stateOf(loaded(), { channelId: CH_B, subChannelId: '' }));
    expect(cleared.customer).toEqual({ channelId: CH_B, subChannelId: null });
    expect(cleared.customerBase).toEqual({ channelId: CH_A, subChannelId: SUB_A });
    const picked = build(loaded(), stateOf(loaded(), { channelId: CH_B, subChannelId: SUB_B }));
    expect(picked.customer).toEqual({ channelId: CH_B, subChannelId: SUB_B });
    // Even when there was none on file: the new channel says it has none.
    const none = loaded({ subChannelId: null });
    expect(build(none, stateOf(none, { channelId: CH_B })).customer).toEqual({
      channelId: CH_B,
      subChannelId: null,
    });
  });

  it('locked fields are never sent, and a salesman never sends a status (EL-01)', () => {
    const typed = stateOf(loaded(), { legalName: 'Something Else', status: 'CLOSED' });
    expect(build(loaded(), typed, SALESMAN).customer).toEqual({});
    expect(
      build(loaded(), stateOf(loaded(), { crNumber: '999' }), { ...SALESMAN, lockCr: true })
        .customer
    ).toEqual({});
    expect(build(loaded(), typed, MANAGER).customer).toEqual({
      legalName: 'Something Else',
      status: 'CLOSED',
    });
  });

  it('a branch the page does not show is never sent, whatever the state holds', () => {
    const s = stateOf(loaded());
    const withForeign: FormState = {
      ...s,
      branches: {
        ...s.branches,
        ckforeignaaaaaaaaaaaaaaaa: { ...s.branches[B1]!, address: 'Somewhere else' },
      },
    };
    expect(build(loaded(), withForeign).branches).toEqual([]);
  });

  it('a branch state from an old draft, without "confirmed", keeps the loaded value and does not crash', () => {
    const s = stateOf(loaded());
    const old: FormBranch = { ...s.branches[B1]! };
    delete old.confirmed;
    const patch = build(loaded(), { ...s, branches: { ...s.branches, [B1]: old } });
    expect(patch.branches).toEqual([]);
    expect(countedNow(branch(B1, { equipmentConfirmed: true }), old)).toBe(true);
  });
});

describe('buildEnrichmentPatch — the location', () => {
  it('a new point sends its four columns, with base = the coordinates loaded', () => {
    const at = new Date('2026-09-29T07:00:00.000Z');
    const patch = build(
      loaded(),
      stateOf(
        loaded(),
        {},
        { [B1]: { gps: { lat: 23.6, lng: 58.4, accuracy: 8, capturedAt: at } } }
      )
    );
    expect(branchOf(patch, B1)).toEqual({
      branchId: B1,
      gpsLat: 23.6,
      gpsLng: 58.4,
      gpsAccuracy: 8,
      gpsCapturedAt: at.toISOString(),
      base: { gpsLat: 23.5, gpsLng: 58.3 },
    });
  });

  it('a first point on a branch that had none, with no reported accuracy: null, base null', () => {
    const patch = build(
      loaded(),
      stateOf(loaded(), {}, { [B2]: { gps: { lat: 23.6, lng: 58.4, capturedAt: CAPTURED } } })
    );
    expect(branchOf(patch, B2)).toMatchObject({
      gpsAccuracy: null,
      gpsCapturedAt: CAPTURED,
      base: { gpsLat: null, gpsLng: null },
    });
  });

  it('a re-capture on the same spot is no change — the capture time alone never counts', () => {
    const s = stateOf(
      loaded(),
      {},
      { [B1]: { gps: { lat: 23.5, lng: 58.3, accuracy: 3, capturedAt: new Date() } } }
    );
    expect(build(loaded(), s).branches).toEqual([]);
  });

  it('a point restored from a phone draft carries its time as the string it was saved as', () => {
    const s = stateOf(
      loaded(),
      {},
      { [B1]: { gps: { lat: 23.61, lng: 58.41, capturedAt: '2026-09-28T06:30:00.000Z' } } }
    );
    expect(branchOf(build(loaded(), s), B1)!.gpsCapturedAt).toBe('2026-09-28T06:30:00.000Z');
  });

  it('item 41: a typed-in point says so, with its reason; a device fix does not', () => {
    const REASON = 'Phone GPS broken; read the point off Google Maps.';
    const typed = {
      lat: 23.6,
      lng: 58.4,
      capturedAt: CAPTURED,
      isManual: true,
      manualReason: REASON,
    };
    expect(
      branchOf(build(loaded(), stateOf(loaded(), {}, { [B1]: { gps: typed } })), B1)!
        .gpsManualReason
    ).toBe(REASON);
    const device = { lat: 23.6, lng: 58.4, accuracy: 6, capturedAt: CAPTURED };
    expect(
      branchOf(build(loaded(), stateOf(loaded(), {}, { [B1]: { gps: device } })), B1)
    ).not.toHaveProperty('gpsManualReason');
  });
});

describe('buildEnrichmentPatch — equipment and "Counted" (F21)', () => {
  it('a count that moved is sent with its base, and marks the equipment counted', () => {
    const patch = build(loaded(), stateOf(loaded(), {}, { [B1]: { coolers: 3 } }));
    expect(branchOf(patch, B1)).toEqual({
      branchId: B1,
      coolersCount: 3,
      equipmentConfirmed: true,
      base: { coolersCount: 1, equipmentConfirmed: false },
    });
  });

  it('ticking "Counted" with the counts unchanged: equipmentConfirmed true, base false', () => {
    const patch = build(loaded(), stateOf(loaded(), {}, { [B1]: { confirmed: true } }), SALESMAN);
    expect(branchOf(patch, B1)).toEqual({
      branchId: B1,
      equipmentConfirmed: true,
      base: { equipmentConfirmed: false },
    });
  });

  it('owner decision 3: only a Steward or a Manager sends it back to false; a salesman never does', () => {
    const counted = loaded({ branches: [branch(B1, { equipmentConfirmed: true })] });
    const unticked = stateOf(counted, {}, { [B1]: { confirmed: false } });
    expect(build(counted, unticked, SALESMAN).branches).toEqual([]);
    expect(branchOf(build(counted, unticked, MANAGER), B1)).toEqual({
      branchId: B1,
      equipmentConfirmed: false,
      base: { equipmentConfirmed: true },
    });
    expect(build(counted, unticked, { ...MANAGER, role: 'STEWARD' }).branches).toHaveLength(1);
  });

  it('already counted on file: a count change sends the count alone', () => {
    const counted = loaded({ branches: [branch(B1, { equipmentConfirmed: true })] });
    expect(branchOf(build(counted, stateOf(counted, {}, { [B1]: { bottles: 12 } })), B1)).toEqual({
      branchId: B1,
      emptyBottlesCount: 12,
      base: { emptyBottlesCount: 0 },
    });
  });
});

describe('ruling 1 — a conflict, and his choice', () => {
  const FIELD_MSG = 'This was changed after you opened this form.';

  it('STALE_FIELDS: the live values, grouped by the slot the server named', () => {
    const conflicts = conflictsFrom(
      { 'customer.contactPerson': FIELD_MSG, [`branch.${B1}.gps`]: FIELD_MSG },
      {
        'customer.contactPerson': 'Omar',
        [`branch.${B1}.gpsLat`]: 23.7,
        [`branch.${B1}.gpsLng`]: 58.5,
        [`branch.${B1}.gpsAccuracy`]: null,
        [`branch.${B1}.gpsCapturedAt`]: '2026-09-28T06:00:00.000Z',
        'customer.notes': 'not named in fields',
      }
    );
    expect(conflicts).toEqual({
      'customer.contactPerson': { 'customer.contactPerson': 'Omar' },
      [`branch.${B1}.gps`]: {
        [`branch.${B1}.gpsLat`]: 23.7,
        [`branch.${B1}.gpsLng`]: 58.5,
        [`branch.${B1}.gpsAccuracy`]: null,
        [`branch.${B1}.gpsCapturedAt`]: '2026-09-28T06:00:00.000Z',
      },
    });
  });

  it('a conflict on a field no longer sent is moot; one still sent is open', () => {
    const conflicts = { 'customer.contactPerson': { 'customer.contactPerson': 'Omar' } };
    const typed = buildEnrichmentPatch(
      loaded(),
      stateOf(loaded(), { contactPerson: 'Ali' }),
      MANAGER
    );
    expect(openConflicts(conflicts, typed)).toEqual(['customer.contactPerson']);
    const reverted = buildEnrichmentPatch(loaded(), stateOf(loaded()), MANAGER);
    expect(openConflicts(conflicts, reverted)).toEqual([]);
  });

  const live = { 'customer.contactPerson': 'Omar' };
  const typed = stateOf(loaded(), { contactPerson: 'Ali' });

  it('"Use this value": the box takes the value saved now, and the field is no longer sent', () => {
    const r = resolveConflict(
      'theirs',
      live,
      loaded(),
      typed,
      { customer: [], branches: {} },
      MANAGER
    );
    expect(r.state.customer.contactPerson).toBe('Omar');
    expect(r.loaded.contactPerson).toBe('Omar');
    expect(build(r.loaded, r.state, MANAGER, r.kept)).toEqual({
      customer: {},
      customerBase: {},
      branches: [],
    });
  });

  it('"Keep mine": his value stays, its base becomes the value saved now, and the patch says it overrides it', () => {
    const r = resolveConflict(
      'mine',
      live,
      loaded(),
      typed,
      { customer: [], branches: {} },
      MANAGER
    );
    expect(r.state.customer.contactPerson).toBe('Ali');
    expect(r.kept.customer).toEqual(['contactPerson']);
    expect(build(r.loaded, r.state, MANAGER, r.kept)).toEqual({
      customer: { contactPerson: 'Ali' },
      customerBase: { contactPerson: 'Omar' },
      customerOverrides: ['contactPerson'],
      branches: [],
    });
    // The page's loaded values are never changed in place.
    expect(loaded().contactPerson).toBe('Said');
  });

  it('"Use this value" after "Keep mine" takes the keep back', () => {
    const mine = resolveConflict(
      'mine',
      live,
      loaded(),
      typed,
      { customer: [], branches: {} },
      MANAGER
    );
    const theirs = resolveConflict('theirs', live, mine.loaded, mine.state, mine.kept, MANAGER);
    expect(theirs.kept.customer).toEqual([]);
  });

  it('the location: "Keep mine" keeps his point over the live one; "Use this value" takes the live point', () => {
    const s = stateOf(
      loaded(),
      {},
      { [B1]: { gps: { lat: 23.6, lng: 58.4, accuracy: 4, capturedAt: CAPTURED } } }
    );
    const gpsLive = {
      [`branch.${B1}.gpsLat`]: 23.7,
      [`branch.${B1}.gpsLng`]: 58.5,
      [`branch.${B1}.gpsAccuracy`]: 12,
      [`branch.${B1}.gpsCapturedAt`]: '2026-09-28T06:00:00.000Z',
    };
    const mine = resolveConflict(
      'mine',
      gpsLive,
      loaded(),
      s,
      { customer: [], branches: {} },
      MANAGER
    );
    expect(branchOf(build(mine.loaded, mine.state, MANAGER, mine.kept), B1)).toMatchObject({
      gpsLat: 23.6,
      gpsLng: 58.4,
      base: { gpsLat: 23.7, gpsLng: 58.5 },
      overrides: ['gpsLat', 'gpsLng'],
    });
    const theirs = resolveConflict(
      'theirs',
      gpsLive,
      loaded(),
      s,
      { customer: [], branches: {} },
      MANAGER
    );
    expect(theirs.state.branches[B1]!.gps).toMatchObject({ lat: 23.7, lng: 58.5, accuracy: 12 });
    expect(build(theirs.loaded, theirs.state, MANAGER, theirs.kept).branches).toEqual([]);
  });

  it('equipment: "Keep mine" keeps the counts he entered, and takes the ones he did not touch from the value saved now', () => {
    // He counted 3 coolers; meanwhile someone saved 4 coolers and 5 stands, counted.
    const s = stateOf(loaded(), {}, { [B1]: { coolers: 3, confirmed: true } });
    const eqLive = {
      [`branch.${B1}.coolersCount`]: 4,
      [`branch.${B1}.standsCount`]: 5,
      [`branch.${B1}.emptyBottlesCount`]: 0,
      [`branch.${B1}.equipmentConfirmed`]: true,
    };
    const mine = resolveConflict(
      'mine',
      eqLive,
      loaded(),
      s,
      { customer: [], branches: {} },
      SALESMAN
    );
    expect(mine.state.branches[B1]).toMatchObject({ coolers: 3, stands: 5, bottles: 0 });
    expect(branchOf(build(mine.loaded, mine.state, SALESMAN, mine.kept), B1)).toEqual({
      branchId: B1,
      coolersCount: 3,
      base: { coolersCount: 4 },
      overrides: ['coolersCount'],
    });
    const theirs = resolveConflict(
      'theirs',
      eqLive,
      loaded(),
      s,
      { customer: [], branches: {} },
      SALESMAN
    );
    expect(theirs.state.branches[B1]).toMatchObject({
      coolers: 4,
      stands: 5,
      bottles: 0,
      confirmed: true,
    });
    expect(build(theirs.loaded, theirs.state, SALESMAN, theirs.kept).branches).toEqual([]);
  });

  it('"Use this value" on the channel puts back the sub-channel the channel select had emptied', () => {
    const s = stateOf(loaded(), { channelId: CH_B, subChannelId: '' });
    const r = resolveConflict(
      'theirs',
      { 'customer.channelId': CH_B },
      loaded(),
      s,
      { customer: [], branches: {} },
      MANAGER
    );
    expect(r.state.customer).toMatchObject({ channelId: CH_B, subChannelId: SUB_A });
    expect(sentPaths(build(r.loaded, r.state, MANAGER, r.kept))).toEqual([]);
  });
});

describe('a phone draft, restored', () => {
  const prev = () => loadedFormState(loaded()).branches;

  it('only the branches the page shows; a branch handed to another route since is ignored', () => {
    const next = restoreBranchStates(
      prev(),
      { [B1]: { address: 'Way 9' }, ckforeignaaaaaaaaaaaaaaaa: { address: 'x' } },
      [{ id: B1 }, { id: B2 }]
    );
    expect(Object.keys(next).sort()).toEqual([B1, B2].sort());
    expect(next[B1]!.address).toBe('Way 9');
  });

  it('a key the draft lacks, or holds with the wrong type, keeps what the page loaded', () => {
    const next = restoreBranchStates(
      prev(),
      { [B1]: { coolers: '7', address: null, gps: { lat: 'x' } } },
      [{ id: B1 }]
    );
    expect(next[B1]).toEqual(prev()[B1]);
  });

  it('a restored point keeps its saved time and its typed-in reason', () => {
    const saved = {
      [B1]: {
        gps: {
          lat: 23.6,
          lng: 58.4,
          capturedAt: '2026-09-28T06:30:00.000Z',
          isManual: true,
          manualReason: 'No fix',
        },
      },
    };
    expect(restoreBranchStates(prev(), saved, [{ id: B1 }])[B1]!.gps).toEqual({
      lat: 23.6,
      lng: 58.4,
      accuracy: undefined,
      capturedAt: '2026-09-28T06:30:00.000Z',
      isManual: true,
      manualReason: 'No fix',
    });
  });

  it('a tick is restored, never an untick: "counted" is not in the draft\'s starting values', () => {
    const counted = loadedFormState(
      loaded({ branches: [branch(B1, { equipmentConfirmed: true })] })
    ).branches;
    expect(
      restoreBranchStates(counted, { [B1]: { confirmed: false } }, [{ id: B1 }])[B1]!.confirmed
    ).toBe(true);
    expect(
      restoreBranchStates(prev(), { [B1]: { confirmed: true } }, [{ id: B1 }])[B1]!.confirmed
    ).toBe(true);
  });

  it('"Keep mine" choices come back for fields and branches this page knows only', () => {
    expect(
      restoreKept(
        {
          customer: ['contactPerson', 'nonsense'],
          branches: { [B1]: ['gpsLat', 'gpsLng', 'x'], other: ['address'] },
        },
        [{ id: B1 }]
      )
    ).toEqual({ customer: ['contactPerson'], branches: { [B1]: ['gpsLat', 'gpsLng'] } });
    expect(restoreKept('junk', [{ id: B1 }])).toEqual({ customer: [], branches: {} });
  });
});
