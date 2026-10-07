/**
 * Launch browser suite (2026-10-07): an Accountant whose account has no region
 * is told so on /approvals, instead of an empty queue.
 *
 * What was wrong: the queue of a region-scoped approver (MANAGER on the
 * Supervisor step, ACCOUNTANT on his own) is fail-closed on no managed regions
 * (lib/permissions.ts canActOnStep), and the page then showed the generic
 * "Nothing pending" — which reads as a quiet day, while in truth no request can
 * ever reach the account until the Data Steward assigns it a region.
 *
 * Only where it is true: FINANCE_MANAGER and GM are org-wide (scope GLOBAL), hold
 * no region by design (lib/ops/golive-accounts.ts) and keep "Nothing pending";
 * so does an Accountant who has a region and nothing waiting.
 *
 * The page is rendered with its session, scope and database mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  role: 'ACCOUNTANT',
  regions: [] as string[],
  scopeReads: 0,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u', role: h.role, username: 'u' } }),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => {
    h.scopeReads += 1;
    return { ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions };
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findMany: async () => [], count: async () => 0 },
    attachment: { findMany: async () => [] },
  },
}));
vi.mock('@/app/(app)/approvals/BulkApprovalQueue', () => ({ BulkApprovalQueue: () => null }));

import ApprovalsPage from '@/app/(app)/approvals/page';

const NOTICE =
  /No region is assigned to this account, so no approval requests can reach it\. Ask the Data Steward to assign one/;

beforeEach(() => {
  h.role = 'ACCOUNTANT';
  h.regions = [];
  h.scopeReads = 0;
});
afterEach(cleanup);

describe('/approvals for an approver with no region', () => {
  it.each(['ACCOUNTANT', 'MANAGER'])(
    '%s with no region: told why, and how to get one — not "Nothing pending"',
    async (role) => {
      h.role = role;
      render(await ApprovalsPage());
      expect(screen.getByRole('heading', { name: 'Approval queue' })).toBeTruthy();
      // Once on the page: the header line names no region, so a reader (or a
      // browser test) finding the sentence finds the one notice.
      expect(screen.getAllByText(/no region/i)).toHaveLength(1);
      expect(screen.getByText(NOTICE)).toBeTruthy();
      expect(screen.getByText('Waiting for a region')).toBeTruthy();
      expect(screen.queryByText('Nothing pending')).toBeNull();
      expect(screen.queryByText('0 pending')).toBeNull();
    }
  );

  it('an ACCOUNTANT with a region and nothing waiting keeps "Nothing pending"', async () => {
    h.regions = ['r-north'];
    render(await ApprovalsPage());
    expect(screen.getByText('Nothing pending')).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it.each(['FINANCE_MANAGER', 'GM'])(
    '%s is org-wide: no region is read, and no notice',
    async (role) => {
      h.role = role;
      render(await ApprovalsPage());
      expect(h.scopeReads).toBe(0);
      expect(screen.getByText('Nothing pending')).toBeTruthy();
      expect(screen.queryByText(NOTICE)).toBeNull();
    }
  );
});
