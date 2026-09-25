// @vitest-environment node
/**
 * The field-update report at scale (benchmark item 28): its size ceiling (refuses
 * only above the measured 60,000 rows, before reading a single branch), and the
 * approved_by index that replaced a rows × changes scan. The rest of the report is
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
