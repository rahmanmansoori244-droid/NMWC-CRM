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

export type CustomerForScore = Pick<
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

export type BranchForScore = Pick<
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
  // F21: required, so typecheck names every caller that builds this by hand.
  | 'equipmentConfirmed'
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
  // final-hunt #30/#34: paymentTerms is a required non-null enum (default CASH),
  // so `|| c.paymentTerms` made this guard unconditionally true — the +5 was free
  // and `notes` never affected the score. Measure the actually-optional field.
  if (c.notes) s += 5;
  return s; // out of 40
}

export function scoreBranch(b: BranchForScore): number {
  let s = 0;
  if (b.gpsLat != null && b.gpsLng != null) s += 15;
  if (b.address && b.address.length >= 10) s += 5;
  if (b.shopPhotoId) s += 10;
  if (b.signboardPhotoId) s += 10;
  if (b.dayOfVisit) s += 5;
  // Equipment (F21, PRD §10 / UXI-007): the counts were confirmed at the shop, or
  // at least one is above zero. A stored 0 alone cannot be told from "never
  // counted" (0 is the column default), so an unconfirmed zero earns nothing —
  // and a shop that really has none earned nothing either until the flag existed.
  const counted = (b.coolersCount ?? 0) + (b.standsCount ?? 0) + (b.emptyBottlesCount ?? 0) > 0;
  if (b.equipmentConfirmed || counted) s += 5;
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
 * Returns 'high' | 'medium' | 'low' for badging. Takes a 0-100 PERCENTAGE, so
 * callers scoring a branch (0-60) must normalize via completenessPct first.
 */
export function completenessBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

// Scale ceilings: a customer score is 0-100, a branch score is 0-60. final-hunt
// #13: rendering a 0-60 branch score as a 0-100% ring meant branches/regions could
// never reach 'high'/green. Normalize to a percentage against the correct max.
export const CUSTOMER_MAX_SCORE = 100;
export const BRANCH_MAX_SCORE = 60;

/** Normalize a raw completeness score to a 0-100 percentage against its scale max. */
export function completenessPct(score: number, max: number = CUSTOMER_MAX_SCORE): number {
  if (max <= 0) return 0;
  return Math.round((Math.max(0, Math.min(max, score)) / max) * 100);
}
