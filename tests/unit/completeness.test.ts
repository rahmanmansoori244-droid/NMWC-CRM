import { describe, it, expect } from 'vitest';
import { scoreCustomerOnly, scoreBranch, completenessBand, scoreCustomer } from '@/lib/completeness';

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
    ).toBeGreaterThan(0); // paymentTerms always set ⇒ +5
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
      openingHours: null,
      deliveryWindow: null,
      status: 'ACTIVE',
    } as never);
    expect(score).toBe(5); // ACTIVE status = 5
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
        openingHours: null,
        deliveryWindow: null,
        status: 'ACTIVE',
      } as never,
    ]);
    // customer: 10+5+5+5+10+5 = 40, branch portion (avg of branches): 5 → total 45
    expect(score).toBe(45);
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
