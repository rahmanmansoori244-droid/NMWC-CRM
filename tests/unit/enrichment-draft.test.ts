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
});

describe('draftIsStale', () => {
  const base = enrichmentBase(customer());
  const updatedAt = new Date('2026-09-25T09:00:00.000Z').getTime();

  it('a draft typed BEFORE a photo was taken is restored (the item-22 loss)', () => {
    const savedBeforePhoto = updatedAt - 60_000;
    expect(draftIsStale({ base, savedAt: savedBeforePhoto }, base, updatedAt)).toBe(false);
  });

  it('a draft whose server values changed since is stale, whatever the clocks say', () => {
    const changed = enrichmentBase(customer({ contactPerson: 'Mr Said' }));
    expect(draftIsStale({ base, savedAt: updatedAt + 60_000 }, changed, updatedAt)).toBe(true);
  });

  it('a draft written before item 22 keeps the old clock rule', () => {
    expect(draftIsStale({ savedAt: updatedAt - 1 }, base, updatedAt)).toBe(true);
    expect(draftIsStale({ savedAt: updatedAt + 1 }, base, updatedAt)).toBe(false);
    expect(draftIsStale({}, base, updatedAt)).toBe(false);
  });
});
