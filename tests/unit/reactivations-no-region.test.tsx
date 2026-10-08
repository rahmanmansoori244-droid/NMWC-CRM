/**
 * Launch browser suite (2026-10-07): a Manager whose account has no region is
 * told so on /reactivations, as on /approvals, instead of an empty queue.
 *
 * What was wrong: the reactivation queue is Manager-only and fail-closed on no
 * managed regions (RBAC-05-008: `id: '__none__'`), and the page then showed
 * "No reactivation requests" — which reads as a quiet day, while in truth no
 * request can reach the account until the Data Steward assigns it a region.
 *
 * The header line keeps reading "0 closed shops requesting reactivation" (true,
 * and read by the launch suite's region-less Manager check in
 * access-control.spec.ts); the notice replaces only the empty state. Its words
 * are matched by /no (managed )?regions/i there, so that is pinned here too.
 *
 * The page is rendered with its session, scope and database mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ regions: [] as string[] }));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u-mgr', role: 'MANAGER', username: 'mgr' } }),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findMany: async () => [] },
    attachment: { findMany: async () => [] },
  },
}));
vi.mock('@/app/(app)/reactivations/ReactivationDecisionForm', () => ({
  ReactivationDecisionForm: () => null,
}));

import ReactivationsPage from '@/app/(app)/reactivations/page';

const NOTICE =
  /No regions are assigned to this account, so no reactivation requests can reach it\. Ask the Data Steward to assign one/;

beforeEach(() => {
  h.regions = [];
});
afterEach(cleanup);

describe('/reactivations for a Manager with no region', () => {
  it('is told why, and how to get one — not "No reactivation requests"', async () => {
    render(await ReactivationsPage());
    expect(screen.getByRole('heading', { name: 'Reactivation queue' })).toBeTruthy();
    expect(screen.getAllByText(/no region/i)).toHaveLength(1);
    const notice = screen.getByText(NOTICE);
    expect(notice.textContent).toMatch(/no (managed )?regions/i);
    expect(screen.getByText('0 closed shops requesting reactivation')).toBeTruthy();
    expect(screen.queryByText('No reactivation requests')).toBeNull();
  });

  it('a Manager with a region and nothing waiting keeps "No reactivation requests"', async () => {
    h.regions = ['r-north'];
    render(await ReactivationsPage());
    expect(screen.getByText('No reactivation requests')).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
