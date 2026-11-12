/**
 * lib/import-shop-route.ts — the customer import never changes the route of a
 * shop that already exists (owner's answer of 2026-11-11, "A1 stop").
 */
import { describe, it, expect } from 'vitest';
import { existingShopWrite, holdShopRoute, routeNotAppliedNote, type RouteById } from '@/lib/import-shop-route';
import { ROUTE_NOT_APPLIED } from '@/lib/import-shop-notice';

const routes: RouteById = new Map([
  ['rt1', { regionId: 'rg1', code: 'R1' }],
  ['rt2', { regionId: 'rg2', code: 'R2' }],
]);
const row = (over: Partial<{ routeResolved: boolean; routeId: string; regionId: string }> = {}) => ({
  routeResolved: true,
  routeId: 'rt2',
  regionId: 'rg2',
  nameGiven: true,
  branchName: 'Seeb',
  sheetAddress: 'Way 1, Muscat',
  dayOfVisit: 'MON',
  status: 'ACTIVE',
  ...over,
});

describe('holdShopRoute', () => {
  it('a different route: the row keeps the shop’s own route and that route’s region, and says which route was not applied', () => {
    const held = holdShopRoute(row(), { routeId: 'rt1' }, routes);
    expect(held.row).toMatchObject({ routeId: 'rt1', regionId: 'rg1', routeResolved: true });
    expect(held.notApplied).toEqual({ sheetRoute: 'R2', keptRoute: 'R1' });
    // Everything else of the row is untouched.
    expect(held.row).toMatchObject({ branchName: 'Seeb', sheetAddress: 'Way 1, Muscat', dayOfVisit: 'MON' });
  });

  it('the same route: nothing to say; its region is its own route’s', () => {
    const held = holdShopRoute(row({ routeId: 'rt1', regionId: 'rg1' }), { routeId: 'rt1' }, routes);
    expect(held.notApplied).toBeNull();
    expect(held.row).toMatchObject({ routeId: 'rt1', regionId: 'rg1', routeResolved: true });
  });

  it('a row that names no route says nothing and writes no region (a blank cell keeps the stored value)', () => {
    const held = holdShopRoute(row({ routeResolved: false, routeId: 'rtU', regionId: 'rgU' }), { routeId: 'rt1' }, routes);
    expect(held.notApplied).toBeNull();
    expect(held.row.routeResolved).toBe(false);
    expect(existingShopWrite(held.row).regionId).toBeUndefined();
  });

  it('a shop on a route the import does not know: no region is written, and the note names its id', () => {
    const held = holdShopRoute(row(), { routeId: 'rt-gone' }, routes);
    expect(held.row.routeResolved).toBe(false);
    expect(existingShopWrite(held.row).regionId).toBeUndefined();
    expect(held.notApplied).toEqual({ sheetRoute: 'R2', keptRoute: 'rt-gone' });
  });
});

describe('existingShopWrite', () => {
  it('has no route in it, whatever the row holds', () => {
    const w = existingShopWrite({ ...row(), routeId: 'rt2' } as Parameters<typeof existingShopWrite>[0]);
    expect(w).not.toHaveProperty('routeId');
    expect(Object.keys(w).sort()).toEqual(['address', 'branchName', 'dayOfVisit', 'regionId', 'status']);
  });

  it('writes the region only when the row names a route, and blanks as undefined', () => {
    expect(existingShopWrite(row())).toEqual({
      branchName: 'Seeb',
      regionId: 'rg2',
      address: 'Way 1, Muscat',
      dayOfVisit: 'MON',
      status: 'ACTIVE',
    });
    expect(
      existingShopWrite({ ...row({ routeResolved: false }), nameGiven: false, sheetAddress: null, dayOfVisit: null, status: null })
    ).toEqual({ branchName: undefined, regionId: undefined, address: undefined, dayOfVisit: undefined, status: undefined });
  });
});

describe('routeNotAppliedNote', () => {
  it('names the shop, the route on the sheet and the route kept, then the sentence exactly', () => {
    expect(routeNotAppliedNote('C1-01', { sheetRoute: 'R2', keptRoute: 'R1' })).toBe(
      `shop C1-01: the sheet names route R2; the shop is on route R1. ${ROUTE_NOT_APPLIED}`
    );
    expect(ROUTE_NOT_APPLIED).toBe(
      'The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.'
    );
  });
});
