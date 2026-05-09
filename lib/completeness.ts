/**
 * Completeness scoring. Pure functions; no DB access. See PRD §10 for weights.
 *
 * Customer score has two parts:
 *   - Customer-level (40 points): identity, channel, contacts, CR
 *   - Branch portion (60 points): average across branches
 *
 * Branch score is computed independently for the dashboard / list views.
 */
import type { Customer, Branch } from '@prisma/client';

type CustomerForScore = Pick<
  Customer,
  | 'channelId'
  | 'subChannelId'
  | 'primaryPhone'
  | 'contactPerson'
  | 'crNumber'
  | 'crPhotoId'
  | 'paymentTerms'
  | 'notes'
>;

type BranchForScore = Pick<
  Branch,
  | 'gpsLat'
  | 'gpsLng'
  | 'address'
  | 'shopPhotoId'
  | 'signboardPhotoId'
  | 'dayOfVisit'
  | 'coolersCount'
  | 'standsCount'
  | 'emptyBottlesCount'
  | 'openingHours'
  | 'deliveryWindow'
  | 'status'
>;

export function scoreCustomerOnly(c: CustomerForScore): number {
  let s = 0;
  if (c.channelId && c.subChannelId) s += 10;
  if (c.primaryPhone) s += 5;
  if (c.contactPerson) s += 5;
  if (c.crNumber) s += 5;
  if (c.crPhotoId) s += 10;
  if (c.notes || c.paymentTerms) s += 5;
  return s; // out of 40
}

export function scoreBranch(b: BranchForScore): number {
  let s = 0;
  if (b.gpsLat != null && b.gpsLng != null) s += 15;
  if (b.address && b.address.length >= 10) s += 5;
  if (b.shopPhotoId) s += 10;
  if (b.signboardPhotoId) s += 10;
  if (b.dayOfVisit) s += 5;
  if (
    (b.coolersCount ?? 0) >= 0 &&
    (b.standsCount ?? 0) >= 0 &&
    (b.emptyBottlesCount ?? 0) >= 0 &&
    // Require at least one to be set explicitly via UI; default 0 alone shouldn't earn the point.
    ((b.coolersCount ?? 0) + (b.standsCount ?? 0) + (b.emptyBottlesCount ?? 0)) >= 0
  ) {
    // Equipment points: granted if at least one count > 0 OR salesman explicitly confirmed (we'll handle the explicit case in UI later)
    if ((b.coolersCount ?? 0) + (b.standsCount ?? 0) + (b.emptyBottlesCount ?? 0) > 0) s += 5;
  }
  if (b.openingHours || b.deliveryWindow) s += 5;
  if (b.status === 'ACTIVE') s += 5;
  return s; // out of 60
}

export function scoreCustomer(
  c: CustomerForScore,
  branches: BranchForScore[]
): number {
  const customerPart = scoreCustomerOnly(c);
  if (branches.length === 0) return customerPart;
  const branchPart = average(branches.map(scoreBranch));
  return Math.round(customerPart + branchPart);
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Returns 'high' | 'medium' | 'low' for badging.
 */
export function completenessBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}
