// @vitest-environment node
/**
 * lib/enrichment-draft.ts (benchmark item 22): the enrichment form's draft on
 * the phone is stale only when the server values it started from have changed —
 * not whenever a photo was taken after the last typed change, which is the
 * usual order in a shop and used to throw the draft away on reload.
 */
import { describe, it, expect } from 'vitest';
import { draftIsStale, enrichmentBase } from '@/lib/enrichment-draft';

const branch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  address: 'Way 1',
  areaDescription: null,
  gpsLat: 23.5,
  gpsLng: 58.3,
  dayOfVisit: 'SUN',
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 1,
  standsCount: 0,
  emptyBottlesCount: 2,
  shopPhotoId: null as string | null,
  ...over,
});
const customer = (over: Record<string, unknown> = {}, branches = [branch('b1'), branch('b2')]) => ({
  legalName: 'Al Noor',
  crNumber: null,
  channelId: 'ch',
  subChannelId: null,
  primaryPhone: null,
  altPhone: null,
  contactPerson: null,
  contactRole: null,
  status: 'ACTIVE',
  notes: null,
  crPhotoId: null as string | null,
  updatedAt: new Date('2026-09-25T06:00:00.000Z'),
  branches,
  ...over,
});

describe('enrichmentBase', () => {
  it('ignores photos and updatedAt — a photo is saved the moment it is taken', () => {
    const before = enrichmentBase(customer());
    const photographed = customer(
      { crPhotoId: 'att-1', updatedAt: new Date('2026-09-25T09:00:00.000Z') },
      [branch('b1', { shopPhotoId: 'att-2' }), branch('b2')]
    );
    expect(enrichmentBase(photographed)).toBe(before);
  });

  it('changes when any value the form edits changes on the server', () => {
    const before = enrichmentBase(customer());
    expect(enrichmentBase(customer({ primaryPhone: '+96891234567' }))).not.toBe(before);
    expect(enrichmentBase(customer({ status: 'CLOSED' }))).not.toBe(before);
    expect(enrichmentBase(customer({}, [branch('b1', { address: 'Way 9' }), branch('b2')]))).not.toBe(before);
    expect(enrichmentBase(customer({}, [branch('b1', { gpsLat: 23.6 }), branch('b2')]))).not.toBe(before);
    expect(enrichmentBase(customer({}, [branch('b1'), branch('b2', { coolersCount: 3 })]))).not.toBe(before);
  });

  it('does not depend on the order the branches arrive in', () => {
    expect(enrichmentBase(customer({}, [branch('b2'), branch('b1')]))).toBe(enrichmentBase(customer()));
  });

  // Phase 2: a changed output would silently drop every draft on every phone at
  // the deploy. The literal was captured from the function before phase 2, with
  // the phase-2 fields (equipmentConfirmed, the GPS companions, status) present
  // in the input — they must stay out of it.
  it('its output is unchanged since before phase 2, byte for byte', () => {
    const fixture = {
      legalName: 'Al Noor Trading <LLC>',
      crNumber: '1234567',
      channelId: 'ckchannel00000000000000001',
      subChannelId: null,
      primaryPhone: '+96891234567',
      altPhone: null,
      contactPerson: 'سعيد',
      contactRole: '',
      status: 'ACTIVE',
      notes: 'Closed Fridays, back door',
      crPhotoId: 'att-cr',
      updatedAt: new Date('2026-09-25T06:00:00.000Z'),
      branches: [
        {
          id: 'b2',
          address: 'Way 2, Seeb',
          areaDescription: null,
          gpsLat: null,
          gpsLng: null,
          gpsAccuracy: null,
          gpsCapturedAt: null,
          dayOfVisit: null,
          openingHours: '08:00 – 22:00',
          deliveryWindow: null,
          coolersCount: 0,
          standsCount: 0,
          emptyBottlesCount: 0,
          equipmentConfirmed: true,
          status: 'ACTIVE',
          shopPhotoId: null,
        },
        {
          id: 'b1',
          address: 'Way 1, Ruwi',
          areaDescription: 'Opposite the bakery',
          gpsLat: 23.588123,
          gpsLng: 58.3829,
          gpsAccuracy: 7.5,
          gpsCapturedAt: new Date('2026-09-24T08:00:00.000Z'),
          dayOfVisit: 'SUN',
          openingHours: null,
          deliveryWindow: '10:00 – 14:00',
          coolersCount: 2,
          standsCount: 1,
          emptyBottlesCount: 40,
          equipmentConfirmed: false,
          status: 'CLOSED',
          shopPhotoId: 'att-shop',
        },
      ],
    };
    expect(enrichmentBase(fixture)).toBe(
      '["Al Noor Trading <LLC>","1234567","ckchannel00000000000000001",null,"+96891234567",null,"سعيد","","ACTIVE","Closed Fridays, back door",[["b1","Way 1, Ruwi","Opposite the bakery",23.588123,58.3829,"SUN",null,"10:00 – 14:00",2,1,40],["b2","Way 2, Seeb",null,null,null,null,"08:00 – 22:00",null,0,0,0]]]'
    );
    // "Counted" and the GPS companions changing on the server do not drop a draft.
    const moved = {
      ...fixture,
      branches: fixture.branches.map((b) => ({ ...b, equipmentConfirmed: !b.equipmentConfirmed, gpsAccuracy: 99 })),
    };
    expect(enrichmentBase(moved)).toBe(enrichmentBase(fixture));
  });
});

describe('draftIsStale', () => {
  const base = enrichmentBase(customer());
  const updatedAt = new Date('2026-09-25T09:00:00.000Z').getTime();

  it('a draft typed BEFORE a photo was taken is restored (the item-22 loss)', () => {
    const savedBeforePhoto = updatedAt - 60_000;
    expect(draftIsStale({ base, savedAt: savedBeforePhoto }, base)).toBe(false);
  });

  it('a draft whose server values changed since is stale, whatever the clocks say', () => {
    const changed = enrichmentBase(customer({ contactPerson: 'Mr Said' }));
    expect(draftIsStale({ base, savedAt: updatedAt + 60_000 }, changed)).toBe(true);
  });

  // Phase 2 replaced the old clock rule: nothing in a draft with no base says
  // which values were typed, and every value that differs is now sent as a change.
  it('a draft without a base (saved before item 22) is stale, however recent', () => {
    expect(draftIsStale({ savedAt: updatedAt + 60_000 }, base)).toBe(true);
    expect(draftIsStale({}, base)).toBe(true);
    expect(draftIsStale({ base: 42 }, base)).toBe(true);
  });
});
