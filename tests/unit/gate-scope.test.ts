/**
 * Owner decision 4 (2026-10-07): lib/validation/gate-scope.ts, the one reading
 * of "what this request changes" that the submit gate, its approval re-check and
 * the form's missing list all take.
 */
import { describe, it, expect } from 'vitest';
import { gateScopeOf } from '@/lib/validation/gate-scope';

describe('gateScopeOf', () => {
  it('a customer-level change: the customer, no branch', () => {
    const s = gateScopeOf(['customer.primaryPhone']);
    expect(s.customer).toBe(true);
    expect([...s.branchIds]).toEqual([]);
  });

  it('branch changes: each branch once, and not the customer', () => {
    const s = gateScopeOf(['branch.b1.dayOfVisit', 'branch.b1.gpsLat', 'branch.b1.gpsAccuracy', 'branch.b2.address']);
    expect(s.customer).toBe(false);
    expect([...s.branchIds]).toEqual(['b1', 'b2']);
  });

  it('both', () => {
    const s = gateScopeOf(['customer.notes', 'branch.b2.openingHours']);
    expect(s.customer).toBe(true);
    expect([...s.branchIds]).toEqual(['b2']);
  });

  it('a path that names no edit field is no change', () => {
    const s = gateScopeOf(['customer.crPhotoId', 'branch.b3.shopPhotoId', 'branch.', 'nonsense']);
    expect(s.customer).toBe(false);
    expect([...s.branchIds]).toEqual([]);
  });
});
