/**
 * The import batch page (app/(app)/import/[batchId]/page.tsx), benchmark item
 * 20: every problem row is reachable, a page says which rows it shows out of
 * how many, and a row reads as it was uploaded, with its issues in words.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

type Row = {
  id: string;
  rowNumber: number;
  state: string;
  raw: unknown;
  parsed: unknown;
  issues: unknown;
  corrections?: unknown;
  excludedAt?: Date | null;
  excludedReason?: string | null;
  excludedBy?: { fullName: string } | null;
};

const h = vi.hoisted(() => ({
  user: { id: 's', role: 'STEWARD', username: 's' } as { id: string; role: string; username: string },
  rows: [] as Row[],
  findMany: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/app/(app)/import/[batchId]/PromoteButton', () => ({ PromoteButton: () => null }));
vi.mock('@/services/import-fixes', () => ({
  recheckImportRowAction: vi.fn(),
  correctImportRowAction: vi.fn(),
  releaseImportRowPhoneAction: vi.fn(),
  excludeImportRowsAction: vi.fn(),
  includeImportRowAction: vi.fn(),
}));
vi.mock('@/lib/db', () => {
  const matches = (r: Row, where: Record<string, unknown>) => {
    const st = where.state as string | { in: string[] } | undefined;
    if (typeof st === 'string' && r.state !== st) return false;
    if (st && typeof st === 'object' && !st.in.includes(r.state)) return false;
    if ('issues' in where && r.issues == null) return false;
    if ('excludedAt' in where) {
      const want = where.excludedAt;
      if (want === null && r.excludedAt) return false;
      if (want !== null && !r.excludedAt) return false;
    }
    return true;
  };
  return {
    prisma: {
      importBatch: {
        findUnique: async () => ({
          id: 'b1',
          filename: 'master.xlsx',
          kind: 'CUSTOMER',
          totalRows: h.rows.length,
          status: 'PROMOTED',
          cleanRows: 0,
          quarantinedRows: h.rows.filter((r) => r.state === 'QUARANTINED').length,
          promotedRows: h.rows.filter((r) => r.state === 'PROMOTED').length,
          rejectedRows: h.rows.filter((r) => r.state === 'REJECTED').length,
          promoteLeaseUntil: null,
          uploadedBy: { fullName: 'S' },
        }),
      },
      importRow: {
        groupBy: async () => {
          const by = new Map<string, number>();
          for (const r of h.rows) by.set(r.state, (by.get(r.state) ?? 0) + 1);
          return [...by].map(([state, n]) => ({ state, _count: { _all: n } }));
        },
        count: async ({ where }: { where: Record<string, unknown> }) => h.rows.filter((r) => matches(r, where)).length,
        findMany: h.findMany,
      },
    },
  };
});

import ImportBatchPage from '@/app/(app)/import/[batchId]/page';

const rejected = (n: number): Row => ({
  id: `r${n}`,
  rowNumber: n + 1,
  state: 'REJECTED',
  raw: { cust_code: `C${n}`, cust_name: `Shop ${n}`, payment_terms: 'CASH' },
  parsed: { custCode: `C${n}`, custName: `Shop ${n}`, branchCode: `C${n}-01`, routeCode: 'R1' },
  issues: [{ field: '_promote', message: `the database refused this row: Branch_address_minlength — steward review` }],
});

beforeEach(() => {
  h.rows = [];
  h.findMany.mockReset();
  h.findMany.mockImplementation(async ({ where, skip, take }: { where: Record<string, unknown>; skip: number; take: number }) => {
    const st = where.state as string | { in: string[] } | undefined;
    const list = h.rows.filter((r) =>
      typeof st === 'string' ? r.state === st : st ? st.in.includes(r.state) : true
    );
    return list.slice(skip, skip + take);
  });
});
afterEach(cleanup);

const open = async (search: Record<string, string> = {}) =>
  render(await ImportBatchPage({ params: Promise.resolve({ batchId: 'b1' }), searchParams: Promise.resolve(search) }));

describe('/import/[batchId]', () => {
  it('reaches the 250th rejected row — the page used to stop at 200', async () => {
    h.rows = Array.from({ length: 250 }, (_, i) => rejected(i));
    await open({ show: 'rejected', page: '3' });
    expect(h.findMany).toHaveBeenCalledWith({
      where: { batchId: 'b1', state: 'REJECTED' },
      orderBy: { rowNumber: 'asc' },
      skip: 200,
      take: 100,
      include: { excludedBy: { select: { fullName: true } } },
    });
    expect(screen.getByText('Rows 201–250 of 250')).toBeTruthy();
    expect(screen.getAllByText('C249').length).toBeGreaterThan(0);
    expect(screen.getAllByText('C200').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('C199')).toEqual([]);
    expect(screen.getByRole('link', { name: /Next/ }).getAttribute('aria-disabled')).toBe('true');
  });

  it('a page past the end shows the last page instead of nothing', async () => {
    h.rows = Array.from({ length: 150 }, (_, i) => rejected(i));
    await open({ show: 'rejected', page: '99' });
    expect(h.findMany.mock.calls[0][0].skip).toBe(100);
    expect(screen.getByText('Rows 101–150 of 150')).toBeTruthy();
  });

  it('each view is a link that says how many rows it holds', async () => {
    h.rows = [
      ...Array.from({ length: 3 }, (_, i) => rejected(i)),
      { id: 'q', rowNumber: 50, state: 'QUARANTINED', raw: { cust_code: 'Q1' }, parsed: null, issues: [{ field: 'phone', message: 'invalid format' }] },
      { id: 'w', rowNumber: 51, state: 'PROMOTED', raw: {}, parsed: { custCode: 'W1' }, issues: [{ field: '_resolve', message: 'route "R9" not found — branch parked in UNASSIGNED' }] },
      { id: 'p', rowNumber: 52, state: 'PROMOTED', raw: {}, parsed: { custCode: 'P1' }, issues: null },
    ];
    await open();
    const nav = screen.getByRole('navigation', { name: 'Which rows' });
    const label = (name: RegExp) => within(nav).getByRole('link', { name }).textContent;
    expect(label(/Needs attention/)).toBe('Needs attention4');
    expect(label(/^Rejected/)).toBe('Rejected3');
    expect(label(/Quarantined/)).toBe('Quarantined1');
    expect(label(/warning/)).toBe('Loaded with a warning1');
    expect(label(/All rows/)).toBe('All rows6');
    expect(within(nav).getByRole('link', { name: /Needs attention/ }).getAttribute('aria-current')).toBe('page');
  });

  it('a row reads as uploaded, with its issue in words', async () => {
    h.rows = [
      {
        id: 'q',
        rowNumber: 7,
        state: 'QUARANTINED',
        raw: { cust_code: 'X1', cust_name: 'Al Noor', payment_terms: 'Crdit' },
        parsed: { custCode: 'X1', custName: 'Al Noor', paymentTerms: 'CASH' },
        issues: [{ field: 'payment_terms', message: 'expected CASH or CREDIT, got "Crdit"' }],
      },
    ];
    await open();
    expect(screen.getByText('Payment terms:')).toBeTruthy();
    expect(screen.getByText('Crdit')).toBeTruthy();
    // The parser's fallback is not shown as if it were the data.
    expect(document.body.textContent).not.toMatch(/"paymentTerms":"CASH"/);
  });

  it('each problem row offers what its problem allows; a loaded row offers nothing', async () => {
    h.rows = [
      { id: 'q1', rowNumber: 2, state: 'QUARANTINED', raw: { cust_code: 'A', day_of_visit: 'XYZ' }, parsed: {}, issues: [{ field: 'day_of_visit', message: 'expected SAT/SUN/MON/TUE/WED/THU/FRI, got "XYZ"' }] },
      { id: 'q2', rowNumber: 3, state: 'QUARANTINED', raw: { cust_code: 'B', phone: '99758980' }, parsed: {}, issues: [{ field: 'phone', message: 'phone already exists in master on customer H' }] },
      { id: 'r1', rowNumber: 4, state: 'REJECTED', raw: { cust_code: 'C' }, parsed: {}, issues: [{ field: '_promote', message: 'payment_terms disagrees with the terms already recorded for this customer' }] },
      { id: 'p1', rowNumber: 5, state: 'PROMOTED', raw: { cust_code: 'D' }, parsed: {}, issues: null },
    ];
    await open({ show: 'all' });
    const rowOf = (code: string) => screen.getAllByText(code)[0].closest('tr')!;
    const buttons = (code: string) => within(rowOf(code)).queryAllByRole('button').map((b) => b.textContent);
    expect(buttons('A')).toEqual(['Re-check', 'Correct…', 'Exclude…']);
    expect(buttons('B')).toEqual(['Re-check', 'Correct…', 'Release shared phone…', 'Exclude…']);
    // A payment-terms rejection names no cell: re-check or exclude, nothing to edit.
    expect(buttons('C')).toEqual(['Re-check', 'Exclude…']);
    expect(buttons('D')).toEqual([]);
  });

  it('an excluded row says who excluded it and why; a swept row can only be excluded', async () => {
    h.rows = [
      { id: 'x1', rowNumber: 2, state: 'QUARANTINED', raw: { cust_code: 'X' }, parsed: {}, issues: [{ field: 'cust_name', message: 'required' }], excludedAt: new Date(), excludedReason: 'closed shop', excludedBy: { fullName: 'Sara' } },
      { id: 's1', rowNumber: 3, state: 'REJECTED', raw: {}, parsed: null, issues: null },
    ];
    await open({ show: 'all' });
    expect(screen.getByText(/Excluded by Sara/)).toBeTruthy();
    expect(screen.getByText('closed shop')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Include again' })).toBeTruthy();
    expect(screen.getByText(/cleared by the 90-day retention sweep/)).toBeTruthy();
    const swept = screen.getByText(/cleared by the 90-day retention sweep/).closest('td')!;
    expect(within(swept).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Exclude…']);
  });

  it('a Manager is sent home', async () => {
    h.user = { id: 'm', role: 'MANAGER', username: 'm' };
    await expect(open()).rejects.toThrow('REDIRECT /home');
    h.user = { id: 's', role: 'STEWARD', username: 's' };
  });
});
