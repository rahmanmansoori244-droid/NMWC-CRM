import { describe, it, expect } from 'vitest';
import {
  scoreCustomerOnly,
  scoreBranch,
  completenessBand,
  scoreCustomer,
  type BranchForScore,
} from '@/lib/completeness';

describe('lib/completeness — customer scoring', () => {
  it('zero on empty record', () => {
    expect(
      scoreCustomerOnly({
        channelId: null,
        subChannelId: null,
        primaryPhone: null,
        contactPerson: null,
        crNumber: null,
        crPhotoId: null,
        paymentTerms: 'CASH',
        notes: null,
      } as never)
    ).toBe(0); // final-hunt #30/#34: an empty record scores 0 (notes is the only
    // optional dimension here and it's absent; paymentTerms no longer earns a free point)
  });

  it('notes is a live dimension — +5 only when notes present', () => {
    const base = {
      channelId: null, subChannelId: null, primaryPhone: null, contactPerson: null,
      crNumber: null, crPhotoId: null, paymentTerms: 'CASH' as const,
    };
    expect(scoreCustomerOnly({ ...base, notes: null } as never)).toBe(0);
    expect(scoreCustomerOnly({ ...base, notes: 'has notes' } as never)).toBe(5);
  });

  it('full = 40', () => {
    expect(
      scoreCustomerOnly({
        channelId: 'c1',
        subChannelId: 's1',
        primaryPhone: '+96812345678',
        contactPerson: 'Ali',
        crNumber: '1234567',
        crPhotoId: 'a1',
        paymentTerms: 'CASH',
        notes: 'foo',
      } as never)
    ).toBe(40);
  });
});

describe('lib/completeness — branch scoring', () => {
  it('full enrichment hits 60', () => {
    expect(
      scoreBranch({
        gpsLat: 23.5,
        gpsLng: 58.4,
        address: 'Some long enough address',
        shopPhotoId: 'a1',
        signboardPhotoId: 'a2',
        dayOfVisit: 'SAT',
        coolersCount: 1,
        standsCount: 1,
        emptyBottlesCount: 5,
        equipmentConfirmed: false,
        openingHours: '08:00-22:00',
        deliveryWindow: '10:00-14:00',
        status: 'ACTIVE',
      } as never)
    ).toBe(60);
  });
  it('completely empty branch is 0 except status default', () => {
    const score = scoreBranch({
      gpsLat: null,
      gpsLng: null,
      address: '',
      shopPhotoId: null,
      signboardPhotoId: null,
      dayOfVisit: null,
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      equipmentConfirmed: false,
      openingHours: null,
      deliveryWindow: null,
      status: 'ACTIVE',
    } as never);
    expect(score).toBe(5); // ACTIVE status = 5
  });

  // F21 (auditor recheck 2026-09-27): a shop that really has no cooler, stand or
  // empty bottle could never earn the equipment points, because 0 is also the
  // column default. Branch.equipmentConfirmed says the counts were taken at the
  // shop, so a confirmed zero is a real zero. Typed without `as never`, so the
  // fixture cannot drift from BranchForScore.
  describe('equipment (F21)', () => {
    const complete: BranchForScore = {
      gpsLat: 23.5,
      gpsLng: 58.4,
      address: 'Some long enough address',
      shopPhotoId: 'a1',
      signboardPhotoId: 'a2',
      dayOfVisit: 'SAT',
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      equipmentConfirmed: false,
      openingHours: '08:00-22:00',
      deliveryWindow: '10:00-14:00',
      status: 'ACTIVE',
    };

    it('zero counts, not confirmed, earn nothing: 55', () => {
      expect(scoreBranch(complete)).toBe(55);
    });
    it('zero counts, confirmed at the shop, earn the 5: 60', () => {
      expect(scoreBranch({ ...complete, equipmentConfirmed: true })).toBe(60);
    });
    it('any count above zero earns the 5 without the flag, as before: 60', () => {
      expect(scoreBranch({ ...complete, coolersCount: 1 })).toBe(60);
      expect(scoreBranch({ ...complete, emptyBottlesCount: 3 })).toBe(60);
      // …and never twice.
      expect(scoreBranch({ ...complete, standsCount: 2, equipmentConfirmed: true })).toBe(60);
    });
    it('an otherwise empty branch stays 5, or 10 once its zero counts are confirmed', () => {
      const empty: BranchForScore = {
        ...complete,
        gpsLat: null,
        gpsLng: null,
        address: '',
        shopPhotoId: null,
        signboardPhotoId: null,
        dayOfVisit: null,
        openingHours: null,
        deliveryWindow: null,
      };
      expect(scoreBranch(empty)).toBe(5);
      expect(scoreBranch({ ...empty, equipmentConfirmed: true })).toBe(10);
    });
  });
});

describe('lib/completeness — customer score with branches', () => {
  it('combines customer + branch portion', () => {
    const c = {
      channelId: 'c',
      subChannelId: 's',
      primaryPhone: '+1',
      contactPerson: 'x',
      crNumber: 'x',
      crPhotoId: 'x',
      paymentTerms: 'CASH',
      notes: null,
    };
    const score = scoreCustomer(c as never, [
      {
        gpsLat: null,
        gpsLng: null,
        address: '',
        shopPhotoId: null,
        signboardPhotoId: null,
        dayOfVisit: null,
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        equipmentConfirmed: false,
        openingHours: null,
        deliveryWindow: null,
        status: 'ACTIVE',
      } as never,
    ]);
    // customer: 10+5+5+5+10 = 35 (notes:null ⇒ no notes point), branch portion 5 → total 40
    expect(score).toBe(40);
  });
});

describe('lib/completeness — band thresholds', () => {
  it('high >=80, medium >=50, low <50', () => {
    expect(completenessBand(95)).toBe('high');
    expect(completenessBand(80)).toBe('high');
    expect(completenessBand(79)).toBe('medium');
    expect(completenessBand(50)).toBe('medium');
    expect(completenessBand(49)).toBe('low');
    expect(completenessBand(0)).toBe('low');
  });
});
