/**
 * Launch fix (2026-10-07): the /customers filter bar offers only the people and
 * places the viewer may see.
 *
 * What was wrong: the Salesman list was narrowed for a SUPERVISOR only, so a
 * MANAGER or an ACCOUNTANT — both region-scoped (lib/customer-filters.ts
 * customerListBranchScope) — was offered every salesman in the company, and an
 * ACCOUNTANT every region. Picking one outside his regions returned nothing.
 * The Supervisor list was company-wide for a MANAGER too, and the first cut of
 * the Salesman list read the ACTIVE routes, so it dropped a salesman whose route
 * was switched off although his customers still list.
 *
 * The page is rendered with its session, database and cached reference lists
 * mocked; the filter bar is replaced by a probe that records the lists the
 * server hands it, which is exactly what reaches the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

type Probe = {
  regions: Array<{ id: string }>;
  salesmen: Array<{ id: string }>;
  supervisors: Array<{ id: string }>;
  routes: Array<{ id: string }>;
};
const h = vi.hoisted(() => ({
  me: null as null | Record<string, unknown>,
  probe: null as null | Probe,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: h.me!.id, role: h.me!.role, username: 'u' } }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUniqueOrThrow: async () => h.me,
      findMany: async () => [],
      findUnique: async () => null,
    },
    customer: { findMany: async () => [] },
  },
}));
vi.mock('@/lib/customer-count', () => ({ customerCountFast: async () => ({ total: 0, isApprox: false }) }));
vi.mock('@/services/saved-views', () => ({ listSavedViewsForCurrentUser: async () => [] }));
vi.mock('@/lib/reference-data', () => ({
  getAllActiveRegions: async () => [
    { id: 'g-mct', name: 'Muscat', code: 'MCT' },
    { id: 'g-dho', name: 'Dhofar', code: 'DHO' },
  ],
  getAllActiveRoutes: async () => [
    { id: 'r-mct', code: 'MCT-01', name: 'Muscat 1', regionId: 'g-mct' },
    { id: 'r-dho', code: 'DHO-01', name: 'Dhofar 1', regionId: 'g-dho' },
  ],
  getAllActiveChannels: async () => [],
  getAllActiveSubChannels: async () => [],
  // r-mct-off is a switched-off Muscat route: getAllActiveRoutes leaves it out.
  getAllHierarchyUsers: async () => [
    { id: 's-mct', fullName: 'Muscat Salesman', username: 'MCT-01', role: 'SALESMAN', ownedRouteId: 'r-mct', ownedRouteRegionId: 'g-mct', supervisorId: 'm-mct' },
    { id: 's-mct-off', fullName: 'Muscat Off Salesman', username: 'MCT-09', role: 'SALESMAN', ownedRouteId: 'r-mct-off', ownedRouteRegionId: 'g-mct', supervisorId: 'v-mct' },
    { id: 's-dho', fullName: 'Dhofar Salesman', username: 'DHO-01', role: 'SALESMAN', ownedRouteId: 'r-dho', ownedRouteRegionId: 'g-dho', supervisorId: 'v-dho' },
    { id: 's-none', fullName: 'Routeless Salesman', username: 'loose', role: 'SALESMAN', ownedRouteId: null, ownedRouteRegionId: null, supervisorId: 'v-idle' },
    { id: 'v-mct', fullName: 'Muscat Supervisor', username: 'sup.mct', role: 'SUPERVISOR', ownedRouteId: null, ownedRouteRegionId: null, supervisorId: 'm-mct' },
    { id: 'v-dho', fullName: 'Dhofar Supervisor', username: 'sup.dho', role: 'SUPERVISOR', ownedRouteId: null, ownedRouteRegionId: null, supervisorId: null },
    { id: 'v-idle', fullName: 'Idle Supervisor', username: 'sup.idle', role: 'SUPERVISOR', ownedRouteId: null, ownedRouteRegionId: null, supervisorId: null },
    { id: 'm-mct', fullName: 'Muscat Manager', username: 'mgr.mct', role: 'MANAGER', ownedRouteId: null, ownedRouteRegionId: null, supervisorId: null },
  ],
}));
vi.mock('@/app/(app)/customers/CustomerFiltersClient', () => ({
  CustomerFiltersClient: (props: Probe) => {
    h.probe = props;
    return null;
  },
}));

import CustomersPage from '@/app/(app)/customers/page';

function me(role: string, managedRegionIds: string[] = []) {
  h.me = {
    id: `me-${role}`,
    role,
    ownedRouteId: null,
    reports: [],
    managedRegions: managedRegionIds.map((id) => ({ id })),
  };
}
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();

beforeEach(() => {
  h.probe = null;
});
afterEach(cleanup);

describe('/customers filter lists are cut to the viewer’s scope', () => {
  it.each(['MANAGER', 'ACCOUNTANT'])('a %s is offered only the salesmen and regions of his regions', async (role) => {
    me(role, ['g-mct']);
    render(await CustomersPage({ searchParams: Promise.resolve({}) }));
    // s-mct-off's route is switched off, but his customers still list.
    expect(ids(h.probe!.salesmen)).toEqual(['s-mct', 's-mct-off']);
    expect(ids(h.probe!.regions)).toEqual(['g-mct']);
  });

  it('a MANAGER is offered only the supervisors with a report on a route in his regions', async () => {
    me('MANAGER', ['g-mct']);
    render(await CustomersPage({ searchParams: Promise.resolve({}) }));
    expect(ids(h.probe!.supervisors)).toEqual(['v-mct']);
  });

  it('a region-less MANAGER is offered no salesman', async () => {
    me('MANAGER');
    render(await CustomersPage({ searchParams: Promise.resolve({}) }));
    expect(h.probe!.salesmen).toEqual([]);
  });

  it.each(['STEWARD', 'VIEWER', 'FINANCE_MANAGER', 'GM'])('an org-wide %s keeps every salesman', async (role) => {
    me(role);
    render(await CustomersPage({ searchParams: Promise.resolve({}) }));
    expect(ids(h.probe!.salesmen)).toEqual(['s-dho', 's-mct', 's-mct-off', 's-none']);
  });

  it.each(['STEWARD', 'VIEWER'])('an org-wide %s keeps every supervisor', async (role) => {
    me(role);
    render(await CustomersPage({ searchParams: Promise.resolve({}) }));
    expect(ids(h.probe!.supervisors)).toEqual(['v-dho', 'v-idle', 'v-mct']);
  });
});
