// @vitest-environment node
/**
 * The field-update report at scale (benchmark item 28): its size ceiling (refuses
 * only above the measured 60,000 rows, before reading a single branch), and the
 * approved_by index that replaced a rows × changes scan, and its paging (bounded
 * pages by branch code, scoped every time, then ordered by route). The rest is
 * covered against a real database in tests/integration/golive-update-flow.test.ts
 * (section 7), which checks approved_by on a single-branch customer only.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ count: vi.fn(), findMany: vi.fn() }));
// lib/export-scope imports the session helper; the report is called with its user.
vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({
  prisma: {
    branch: { count: h.count, findMany: h.findMany.mockResolvedValue([]) },
    channel: { findMany: async () => [] },
    subChannel: { findMany: async () => [] },
    user: { findMany: async () => [] },
    attachment: { findMany: async () => [] },
    customerEdit: { findMany: async () => [] },
  },
}));

import { approvalIndex, approvedByFor, buildChangeReport, CHANGE_REPORT_ROW_CEILING } from '@/lib/change-report';
import { parseWorkbook } from '@/lib/excel';
import { matchesWhere } from '../support/where-eval';

describe('approved_by — who approved changes on a row', () => {
  const row = (cust_code: string, branch_code: string, decision: string, decided_by: string) => ({
    cust_code,
    branch_code,
    decision,
    decided_by,
  });
  const index = approvalIndex([
    row('C1', '', 'APPROVED', 'mgr.a'), // customer-level: every branch of C1
    row('C1', 'C1-01', 'APPROVED', 'mgr.b'),
    row('C1', 'C1-02', 'APPROVED', 'mgr.c'),
    row('C1', 'C1-01', 'APPROVED', 'mgr.b'), // a second change by the same approver
    row('C1', 'C1-02', 'PENDING', 'mgr.d'), // not decided: nobody approved it
    row('C1', 'C1-01', 'ADDED', ''), // a photo row carries no approver
    row('C2', '', 'APPROVED', 'mgr.e'),
  ]);

  it("names the customer-level approvers and the branch's own, once each, in first-seen order", () => {
    expect(approvedByFor(index, 'C1', 'C1-01')).toBe('mgr.a, mgr.b');
    expect(approvedByFor(index, 'C1', 'C1-02')).toBe('mgr.a, mgr.c');
  });

  it("never names another customer's approver or a pending proposal's submitter", () => {
    expect(approvedByFor(index, 'C2', 'C2-01')).toBe('mgr.e');
    expect(approvedByFor(index, 'C1', 'C1-02')).not.toContain('mgr.d');
    expect(approvedByFor(index, 'C9', 'C9-01')).toBe('');
  });
});

const steward = { id: 's1', role: 'STEWARD' as const, username: 'steward.x' };

describe('buildChangeReport — ceiling', () => {
  it('is 60,000, not the old 25,000', () => {
    expect(CHANGE_REPORT_ROW_CEILING).toBe(60_000);
  });

  it('refuses one row over it, before reading any branch', async () => {
    h.findMany.mockClear();
    h.count.mockResolvedValueOnce(60_001);
    await expect(buildChangeReport(steward, {})).rejects.toThrow(/60,000 rows/);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it('builds at exactly the ceiling — and does read the branches', async () => {
    h.findMany.mockClear();
    h.count.mockResolvedValueOnce(60_000);
    await buildChangeReport(steward, {});
    expect(h.findMany).toHaveBeenCalled();
  });

  it('builds at the old cap and above it', async () => {
    h.findMany.mockClear();
    h.count.mockResolvedValueOnce(25_001);
    const out = await buildChangeReport(steward, {});
    expect(h.findMany).toHaveBeenCalled();
    // No branches in this mock, so no rows — what matters is that it was not refused.
    expect(out.rowCount).toBe(0);
    expect(out.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe('buildChangeReport — reads a page at a time', () => {
  /** A branch as the report's page query returns it (customer, region, route included). */
  const reportBranch = (branchCode: string, route: string) => ({
    id: `b-${branchCode}`,
    customerId: `c-${branchCode}`,
    branchCode,
    branchName: `Branch ${branchCode}`,
    routeId: `r-${route}`,
    address: 'Way 1',
    areaDescription: null,
    gpsLat: null,
    gpsLng: null,
    gpsAccuracy: null,
    gpsCapturedAt: null,
    dayOfVisit: 'SUN',
    openingHours: null,
    deliveryWindow: null,
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    status: 'ACTIVE',
    shopPhotoId: null,
    signboardPhotoId: null,
    shopPhoto: null,
    signboardPhoto: null,
    region: { name: 'Muscat', code: 'MCT' },
    route: { id: `r-${route}`, code: route },
    customer: {
      nmwcCode: `C-${branchCode}`,
      legalName: 'Shop',
      paymentTerms: 'CASH',
      status: 'ACTIVE',
      channel: null,
      subChannel: null,
      primaryPhone: null,
      altPhone: null,
      contactPerson: null,
      contactRole: null,
      crNumber: null,
      crPhotoId: null,
      crPhoto: null,
      notes: null,
      completenessScore: 50,
    },
  });

  it('pages by branch code with the scope on every page, then orders by route', async () => {
    // Codes interleave the routes, as customer numbers do.
    const table = [
      reportBranch('0001-01', 'C5'),
      reportBranch('0002-01', 'C4'),
      reportBranch('0003-01', 'C5'),
      reportBranch('0004-01', 'C4'),
      reportBranch('0005-01', 'C4'),
    ];
    h.findMany.mockReset();
    h.findMany.mockImplementation(async (args: { take: number; where: { AND: Record<string, unknown>[] } }) => {
      if (h.findMany.mock.calls.length > 100) throw new Error('paging never ended');
      const after = args.where.AND[1];
      return table.filter((b) => !after || matchesWhere(b, after)).slice(0, args.take);
    });
    h.count.mockResolvedValueOnce(table.length);
    const out = await buildChangeReport(steward, {}, { pageSize: 2 });

    const calls = h.findMany.mock.calls.map((c) => c[0]);
    // Three pages of at most 2, each strictly after the last code read, each scoped.
    expect(calls).toHaveLength(3);
    for (const a of calls) {
      expect(a.take).toBe(2);
      expect(a.orderBy).toEqual({ branchCode: 'asc' });
      expect(a.where.customer).toEqual({ deletedAt: null });
      expect(a.where.AND[0]).toEqual(calls[0].where.AND[0]);
      expect(a.cursor).toBeUndefined();
      expect(a.skip).toBeUndefined();
    }
    expect(calls.map((a) => a.where.AND[1])).toEqual([
      undefined,
      { branchCode: { gt: '0002-01' } },
      { branchCode: { gt: '0004-01' } },
    ]);

    // Every branch once, grouped by route code, branch-code order kept within a route.
    expect(out.rowCount).toBe(5);
    const sheet = (await parseWorkbook(out.bytes)).find((s) => s.name === 'Customers')!;
    expect(sheet.rows.map((r) => `${r.route} ${r.branch_code}`)).toEqual([
      'C4 0002-01',
      'C4 0004-01',
      'C4 0005-01',
      'C5 0001-01',
      'C5 0003-01',
    ]);
  });
});
