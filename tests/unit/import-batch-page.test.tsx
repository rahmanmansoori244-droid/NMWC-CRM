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
  createdAt?: Date;
  excludedAt?: Date | null;
  excludedReason?: string | null;
  excludedBy?: { fullName: string } | null;
};

const h = vi.hoisted(() => ({
  user: { id: 's', role: 'STEWARD', username: 's' } as { id: string; role: string; username: string },
  rows: [] as Row[],
  findMany: vi.fn(),
  newer: [] as Array<{
    code: string;
    filename: string;
    rowNumber: number;
    state: string;
    excluded: boolean;
    branchCode?: string | null;
    fixedInApp?: boolean;
    refreshRow?: boolean;
  }>,
  /** Customers linked to Temix (a stored Temix code). */
  linked: [] as string[],
  kind: 'CUSTOMER' as 'CUSTOMER' | 'ACCOUNT',
  /** Code review 2026-11-10, finding 1: fields laid over the batch (status, the overwrite option). */
  batch: {} as Record<string, unknown>,
  /** The props the page hands the Promote button, when it renders one. */
  promote: null as Record<string, unknown> | null,
  /** Finding 23: the account upload's IMPORT summary row (its after), or none. */
  importSummary: null as Record<string, unknown> | null,
  /** Owner's answer 2026-11-11: shops on record, by composed code, with their customer and route. */
  shops: [] as Array<{ branchCode: string; nmwcCode: string; route: string }>,
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
vi.mock('@/app/(app)/import/[batchId]/PromoteButton', () => ({
  PromoteButton: (props: Record<string, unknown>) => {
    h.promote = props;
    return null;
  },
}));
vi.mock('@/services/import-fixes', () => ({
  recheckImportRowAction: vi.fn(),
  correctImportRowAction: vi.fn(),
  releaseImportRowPhoneAction: vi.fn(),
  excludeImportRowsAction: vi.fn(),
  includeImportRowAction: vi.fn(),
  withdrawImportRowFixAction: vi.fn(),
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
    if ('parsed' in where && (r.parsed as { fixedInApp?: boolean } | null)?.fixedInApp !== true) return false;
    return true;
  };
  return {
    prisma: {
      // lib/import-master-lookup newerUploadsCarrying: the rows of newer uploads carrying these customers.
      $queryRaw: async () => h.newer,
      auditLog: { findFirst: async () => (h.importSummary ? { after: h.importSummary } : null) },
      branch: {
        findMany: async ({ where }: { where: { branchCode: { in: string[] } } }) =>
          h.shops
            .filter((s) => where.branchCode.in.includes(s.branchCode))
            .map((s) => ({ branchCode: s.branchCode, customer: { nmwcCode: s.nmwcCode }, route: { code: s.route } })),
      },
      customer: {
        findMany: async ({ where }: { where: { nmwcCode: { in: string[] } } }) =>
          h.linked.filter((c) => where.nmwcCode.in.includes(c)).map((nmwcCode) => ({ nmwcCode })),
      },
      importBatch: {
        findUnique: async () => ({
          id: 'b1',
          filename: 'master.xlsx',
          kind: h.kind,
          totalRows: h.rows.length,
          status: 'PROMOTED',
          cleanRows: 0,
          quarantinedRows: h.rows.filter((r) => r.state === 'QUARANTINED').length,
          promotedRows: h.rows.filter((r) => r.state === 'PROMOTED').length,
          rejectedRows: h.rows.filter((r) => r.state === 'REJECTED').length,
          promoteLeaseUntil: null,
          // Within the age limit of a staged batch (code review 2026-11-10, finding 6).
          uploadedAt: new Date(Date.now() - 60 * 60 * 1000),
          uploadedBy: { fullName: 'S' },
          overwriteCrmFields: false,
          overwriteCrmFieldsAt: null,
          ...h.batch,
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
        // The batch's first row as uploaded: its keys are the sheet's headings.
        findFirst: async () => {
          const first = [...h.rows].sort((a, b) => a.rowNumber - b.rowNumber)[0];
          return first ? { raw: first.raw } : null;
        },
      },
    },
  };
});

import ImportBatchPage from '@/app/(app)/import/[batchId]/page';
import { ROUTE_NOT_APPLIED, SHOP_NOT_CHANGED_MEANING } from '@/lib/import-shop-notice';

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
  h.newer = [];
  h.linked = [];
  h.kind = 'CUSTOMER';
  h.batch = {};
  h.importSummary = null;
  h.shops = [];
  h.promote = null;
  h.findMany.mockReset();
  h.findMany.mockImplementation(async ({ where, skip, take }: { where: Record<string, unknown>; skip: number; take: number }) => {
    const st = where.state as string | { in: string[] } | undefined;
    const list = h.rows.filter((r) =>
      typeof st === 'string' ? r.state === st : st ? st.in.includes(r.state) : true
    );
    // A page asks with skip/take; lib/import-fix-blocks asks for every match.
    const page = skip === undefined ? list : list.slice(skip, skip + take);
    return page.map((r) => ({ createdAt: new Date(), ...r }));
  });
});
afterEach(cleanup);

const open = async (search: Record<string, string> = {}) =>
  render(await ImportBatchPage({ params: Promise.resolve({ batchId: 'b1' }), searchParams: Promise.resolve(search) }));

// Launch fix (2026-10-07): an account master's issue rows are stored under the
// row Excel shows (services/imports.ts), and with three sheets the number alone
// is ambiguous, so the Row column names the sheet.
describe('/import/[batchId] for an account master', () => {
  // Code review 2026-11-10, finding 23.
  it('an upload stopped at its time limit says what was done and which passwords were set', async () => {
    h.kind = 'ACCOUNT';
    h.importSummary = { kind: 'ACCOUNT', timeLimit: true, notProcessed: 2, done: 'Users rows 2–3', passwordsSet: 'Users row 3' };
    const issue = { sheet: 'Users', row: 4, message: 'not processed: this upload reached its time limit before this row.' };
    h.rows = [{ id: 'a9', rowNumber: 4, state: 'QUARANTINED', raw: issue, parsed: null, issues: [issue] }];
    await open();
    const note = screen.getByTestId('account-time-limit');
    expect(note.textContent).toContain('This upload stopped at its time limit. Done and saved: Users rows 2–3. Passwords set in this upload (new accounts and resets): Users row 3. 2 row(s) were not processed');
  });

  it('an upload that finished shows no such note', async () => {
    h.kind = 'ACCOUNT';
    h.importSummary = { kind: 'ACCOUNT', clean: 3, issues: 0 };
    await open();
    expect(screen.queryByTestId('account-time-limit')).toBeNull();
  });

  it('the Row column reads the sheet and the Excel row', async () => {
    h.kind = 'ACCOUNT';
    const issue = { sheet: 'Users', row: 7, message: 'salesman needs route_code' };
    h.rows = [{ id: 'a1', rowNumber: 7, state: 'QUARANTINED', raw: issue, parsed: null, issues: [issue] }];
    await open();
    const row = screen.getByText('Users sheet, row 7:').closest('tr')!;
    expect(row.querySelector('td')!.textContent).toBe('Users #7');
  });

  it('a batch stored before the fix reads its Excel row from the issue, not the issue index', async () => {
    h.kind = 'ACCOUNT';
    // The 2nd issue of the batch, about Excel row 9 of the Users sheet.
    const issue = { sheet: 'Users', row: 9, message: 'salesman needs route_code' };
    h.rows = [{ id: 'a2', rowNumber: 2, state: 'QUARANTINED', raw: issue, parsed: null, issues: [issue] }];
    await open();
    const row = screen.getByText('Users sheet, row 9:').closest('tr')!;
    expect(row.querySelector('td')!.textContent).toBe('Users #9');
  });

  it('rows are paged in a fixed order: sheets share row numbers, so the id breaks ties', async () => {
    h.kind = 'ACCOUNT';
    const issue = (sheet: string) => ({ sheet, row: 2, message: 'code and name required' });
    h.rows = ['Regions', 'Routes', 'Users'].map((s, i) => ({
      id: `t${i}`, rowNumber: 2, state: 'QUARANTINED', raw: issue(s), parsed: null, issues: [issue(s)],
    }));
    await open();
    const paged = h.findMany.mock.calls.map((c) => c[0]).find((a) => a.take !== undefined);
    expect(paged.orderBy).toEqual([{ rowNumber: 'asc' }, { id: 'asc' }]);
  });

  it('a customer master row keeps the bare number', async () => {
    h.rows = [rejected(4)];
    await open({ show: 'rejected' });
    const row = screen.getAllByText('C4')[0]!.closest('tr')!;
    expect(row.querySelector('td')!.textContent).toBe('#5');
  });
});

describe('/import/[batchId]', () => {
  it('reaches the 250th rejected row — the page used to stop at 200', async () => {
    h.rows = Array.from({ length: 250 }, (_, i) => rejected(i));
    await open({ show: 'rejected', page: '3' });
    expect(h.findMany).toHaveBeenCalledWith({
      where: { batchId: 'b1', state: 'REJECTED' },
      orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
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

  it('a row a newer upload superseded offers only Exclude, and says why', async () => {
    h.rows = [
      { id: 'q1', rowNumber: 2, state: 'QUARANTINED', raw: { cust_code: 'A', day_of_visit: 'XYZ' }, parsed: { custCode: 'A' }, issues: [{ field: 'day_of_visit', message: 'x' }] },
      { id: 'q2', rowNumber: 3, state: 'QUARANTINED', raw: { cust_code: 'B', day_of_visit: 'XYZ' }, parsed: { custCode: 'B' }, issues: [{ field: 'day_of_visit', message: 'x' }] },
    ];
    h.newer = [{ code: 'A', filename: 'later.xlsx', rowNumber: 9, state: 'PROMOTED', excluded: false }];
    await open({ show: 'all' });
    const rowOf = (code: string) => screen.getAllByText(code)[0].closest('tr')!;
    const buttons = (code: string) => within(rowOf(code)).queryAllByRole('button').map((b) => b.textContent);
    expect(buttons('A')).toEqual(['Exclude…']);
    expect(rowOf('A').textContent).toMatch(/was loaded again from a newer upload, "later\.xlsx" \(row 9\)/);
    expect(buttons('B')).toEqual(['Re-check', 'Correct…', 'Exclude…']);
  });

  it('a row fixed in the app, waiting to promote, offers Withdraw fix — and has its own view', async () => {
    h.rows = [
      { id: 'c1', rowNumber: 2, state: 'CLEAN', raw: { cust_code: 'F' }, parsed: { custCode: 'F', fixedInApp: true }, issues: null },
      { id: 'c2', rowNumber: 3, state: 'CLEAN', raw: { cust_code: 'G' }, parsed: { custCode: 'G' }, issues: null },
    ];
    await open({ show: 'all' });
    const rowOf = (code: string) => screen.getAllByText(code)[0].closest('tr')!;
    expect(within(rowOf('F')).getByRole('button', { name: 'Withdraw fix' })).toBeTruthy();
    expect(within(rowOf('G')).queryAllByRole('button')).toEqual([]); // a plain clean row: nothing to do
    const nav = screen.getByRole('navigation', { name: 'Which rows' });
    expect(within(nav).getByRole('link', { name: /Fixed, waiting to promote/ }).textContent).toBe('Fixed, waiting to promote1');
  });

  it('a row past the 90-day fix window offers only Exclude, in the words the server refuses with', async () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    h.rows = [
      { id: 'q1', rowNumber: 2, state: 'QUARANTINED', raw: { cust_code: 'A', phone: '99758980' }, parsed: { custCode: 'A' }, issues: [{ field: 'phone', message: 'phone already exists in master on customer H' }], createdAt: old },
      { id: 'q2', rowNumber: 3, state: 'QUARANTINED', raw: { cust_code: 'B', day_of_visit: 'XYZ' }, parsed: { custCode: 'B' }, issues: [{ field: 'day_of_visit', message: 'x' }] },
    ];
    await open({ show: 'all' });
    const rowOf = (code: string) => screen.getAllByText(code)[0].closest('tr')!;
    const buttons = (code: string) => within(rowOf(code)).queryAllByRole('button').map((b) => b.textContent);
    expect(buttons('A')).toEqual(['Exclude…']);
    expect(rowOf('A').textContent).toMatch(/Row 2 was uploaded more than 90 days ago.*Exclude it, or upload the corrected row again/);
    expect(buttons('B')).toEqual(['Re-check', 'Correct…', 'Exclude…']);
  });

  it('a fix waiting to promote that a newer upload overtook says promote will reject it, and still offers Withdraw fix', async () => {
    h.rows = [
      { id: 'c1', rowNumber: 2, state: 'CLEAN', raw: { cust_code: 'F' }, parsed: { custCode: 'F', fixedInApp: true }, issues: null },
    ];
    h.newer = [{ code: 'F', filename: 'later.xlsx', rowNumber: 4, state: 'PROMOTED', excluded: false }];
    await open({ show: 'all' });
    const row = screen.getAllByText('F')[0].closest('tr')!;
    expect(row.textContent).toMatch(/this fix will not load: promote rejects it/);
    expect(row.textContent).not.toMatch(/loads on the next promote/);
    expect(within(row).getByRole('button', { name: 'Withdraw fix' })).toBeTruthy();
  });

  it('for a customer linked to Temix only a newer row about the same branch rules a fix out — a plain refresh row never does', async () => {
    const heldBranch = (id: string, n: number, code: string, branch: string): Row => ({
      id,
      rowNumber: n,
      state: 'QUARANTINED',
      raw: { cust_code: code, branch_code: branch, day_of_visit: 'XYZ' },
      parsed: { custCode: code, branchCode: branch },
      issues: [{ field: 'day_of_visit', message: 'x' }],
    });
    h.rows = [heldBranch('a', 2, 'T1', '02'), heldBranch('b', 3, 'T2', '02'), heldBranch('c', 4, 'T3', '02')];
    h.linked = ['T1', 'T2', 'T3'];
    h.newer = [
      // The inbound Temix refresh carried T1's branch 02 as a plain row: it wrote no branch.
      { code: 'T1', filename: 'temix.xlsx', rowNumber: 7, state: 'PROMOTED', excluded: false, branchCode: 'T1-02', refreshRow: true },
      // A newer upload FIXED T2's branch 02 in the app: that one wrote it.
      { code: 'T2', filename: 'later.xlsx', rowNumber: 8, state: 'PROMOTED', excluded: false, branchCode: '02', fixedInApp: true, refreshRow: true },
      // A newer upload touched T3's OTHER branch only.
      { code: 'T3', filename: 'later.xlsx', rowNumber: 9, state: 'QUARANTINED', excluded: false, branchCode: 'T3-03' },
    ];
    await open({ show: 'all' });
    const rowOf = (code: string) => screen.getAllByText(code)[0].closest('tr')!;
    const buttons = (code: string) => within(rowOf(code)).queryAllByRole('button').map((b) => b.textContent);
    expect(buttons('T1')).toEqual(['Re-check', 'Correct…', 'Exclude…']);
    expect(buttons('T2')).toEqual(['Exclude…']);
    expect(rowOf('T2').textContent).toMatch(/was loaded again from a newer upload, "later\.xlsx" \(row 8\)/);
    expect(buttons('T3')).toEqual(['Re-check', 'Correct…', 'Exclude…']);
  });

  it('a row of a customer linked to Temix says, before a release or a customer-level correction, that only the branch loads', async () => {
    h.rows = [
      { id: 'q1', rowNumber: 2, state: 'QUARANTINED', raw: { cust_code: 'L', phone: '99758980' }, parsed: { custCode: 'L' }, issues: [{ field: 'phone', message: 'phone already exists in master on customer H' }] },
      { id: 'q2', rowNumber: 3, state: 'QUARANTINED', raw: { cust_code: 'M', day_of_visit: 'XYZ' }, parsed: { custCode: 'M' }, issues: [{ field: 'day_of_visit', message: 'x' }] },
      { id: 'q3', rowNumber: 4, state: 'QUARANTINED', raw: { cust_code: 'N', phone: '99758981' }, parsed: { custCode: 'N' }, issues: [{ field: 'phone', message: 'phone already exists in master on customer H' }] },
    ];
    h.linked = ['L', 'M'];
    await open({ show: 'all' });
    const rowOf = (code: string) => screen.getAllByText(code)[0].closest('tr')!;
    expect(rowOf('L').textContent).toMatch(/linked to Temix, so a fix here loads only this row.s branch/);
    // A visit day is the branch's own: nothing to warn about.
    expect(rowOf('M').textContent).not.toMatch(/linked to Temix/);
    // Not linked: the full lane writes the phone.
    expect(rowOf('N').textContent).not.toMatch(/linked to Temix/);
  });

  // Owner's answer 2026-11-11 ("A1 stop"): a held-back row, or a fix waiting to
  // load, that names a different route for a shop already in the CRM says, before
  // it is corrected and before it loads, that the route will NOT be applied.
  it('a row naming a different route for a shop already in the CRM says the route will not be applied', async () => {
    const held = (id: string, n: number, code: string, branch: string, route: string): Row => ({
      id,
      rowNumber: n,
      state: 'QUARANTINED',
      raw: { cust_code: code, branch_code: branch, route, day_of_visit: 'XYZ' },
      parsed: { custCode: code, branchCode: branch },
      issues: [{ field: 'day_of_visit', message: 'x' }],
    });
    h.rows = [
      held('a', 2, 'P', '01', 'R2'),
      // Same route as on record (codes compared without case): nothing to say.
      held('b', 3, 'Q', '01', 'r1'),
      // A new shop: it is created on the sheet's route.
      held('c', 4, 'S', '05', 'R2'),
      // The code is another customer's shop: not this rule (promote rejects it).
      held('d', 5, 'T', 'P-01', 'R2'),
      // A fix waiting to load says it too.
      { id: 'e', rowNumber: 6, state: 'CLEAN', raw: { cust_code: 'U', branch_code: 'U-02', route: 'R3' }, parsed: { custCode: 'U', fixedInApp: true }, issues: null },
    ];
    h.shops = [
      { branchCode: 'P-01', nmwcCode: 'P', route: 'R1' },
      { branchCode: 'Q-01', nmwcCode: 'Q', route: 'R1' },
      { branchCode: 'U-02', nmwcCode: 'U', route: 'R1' },
    ];
    await open({ show: 'all' });
    const rowOf = (n: string) => screen.getByText(n).closest('tr')!;
    const warning = (n: string) => within(rowOf(n)).queryByTestId('route-not-applied')?.textContent ?? null;
    expect(warning('#2')).toBe(
      'Shop P-01 is already in the CRM, on route R1. This row names route R2: when it loads, that route is NOT applied and the shop stays on route R1. The rest of the row loads as usual. The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.'
    );
    expect(warning('#3')).toBeNull();
    expect(warning('#4')).toBeNull();
    expect(warning('#5')).toBeNull();
    expect(warning('#6')).toContain('Shop U-02 is already in the CRM, on route R1. This row names route R3');
    // The row's own buttons stay as they were: the route alone holds nothing back.
    expect(within(rowOf('#2')).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Re-check', 'Correct…', 'Exclude…']);
  });

  // Pre-merge review: the server fixes a rejected row with its customer's other
  // rejected rows, so the page must ask about them too.
  it("a rejected row whose sibling a newer upload overtook offers only Exclude, naming that row", async () => {
    h.rows = [
      { id: 'a', rowNumber: 2, state: 'REJECTED', raw: { cust_code: 'L', branch_code: 'L-01' }, parsed: { custCode: 'L', branchCode: 'L-01' }, issues: [{ field: '_promote', message: 'the database refused this row: Branch_address_minlength — steward review' }] },
      { id: 'b', rowNumber: 3, state: 'REJECTED', raw: { cust_code: 'L', branch_code: 'L-02' }, parsed: { custCode: 'L', branchCode: 'L-02' }, issues: [{ field: '_promote', message: 'the database refused this row: Branch_address_minlength — steward review' }] },
    ];
    h.linked = ['L'];
    h.newer = [{ code: 'L', filename: 'later.xlsx', rowNumber: 9, state: 'PROMOTED', excluded: false, branchCode: 'L-02' }];
    await open({ show: 'all' });
    const rowOf = (n: string) => screen.getByText(n).closest('tr')!;
    const buttons = (n: string) => within(rowOf(n)).queryAllByRole('button').map((b) => b.textContent);
    expect(buttons('#2')).toEqual(['Exclude…']);
    expect(rowOf('#2').textContent).toMatch(/Row 3 of customer L, rejected together with this one, is also in a newer upload.*Exclude row 3 first, then fix this row\./);
    expect(buttons('#3')).toEqual(['Exclude…']);
  });

  it('a row a fix only brought back says which row it came back with, and that it will not load when the fix is overtaken', async () => {
    h.rows = [
      { id: 'f', rowNumber: 2, state: 'CLEAN', raw: { cust_code: 'F' }, parsed: { custCode: 'F', fixedInApp: true, fixedFrom: { state: 'REJECTED' }, fixGroup: 'f' }, issues: null },
      { id: 's', rowNumber: 3, state: 'CLEAN', raw: { cust_code: 'F' }, parsed: { custCode: 'F', fixedFrom: { state: 'REJECTED' }, fixGroup: 'f' }, issues: null },
    ];
    await open({ show: 'all' });
    const rowOf = (n: string) => screen.getByText(n).closest('tr')!;
    expect(rowOf('#3').textContent).toMatch(/Came back with the fix of row 2 and loads with it/);
    // It can take the fix back itself (pre-merge review of eb1a430).
    expect(within(rowOf('#3')).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Withdraw fix']);
    cleanup();
    h.newer = [{ code: 'F', filename: 'later.xlsx', rowNumber: 4, state: 'PROMOTED', excluded: false }];
    await open({ show: 'all' });
    expect(rowOf('#2').textContent).toMatch(/this fix will not load: promote rejects it/);
    expect(rowOf('#3').textContent).toMatch(/this fix will not load: promote rejects it/);
  });

  // Pre-merge review of eb1a430: the row a fix acted on can come back held back
  // while the rows it released wait CLEAN; they could be neither withdrawn nor
  // excluded, and loaded at the next promote.
  it('a fixed row come back held back, with rows it released waiting, offers Withdraw fix', async () => {
    h.rows = [
      { id: 'f', rowNumber: 2, state: 'QUARANTINED', raw: { cust_code: 'F', phone: '99758980' }, parsed: { custCode: 'F', fixedInApp: true, fixedFrom: { state: 'REJECTED' }, fixGroup: 'f' }, issues: [{ field: 'phone', message: 'phone already exists in master on customer H' }] },
      { id: 's', rowNumber: 3, state: 'CLEAN', raw: { cust_code: 'F' }, parsed: { custCode: 'F', fixedFrom: { state: 'REJECTED' }, fixGroup: 'f' }, issues: null },
      { id: 'q', rowNumber: 4, state: 'QUARANTINED', raw: { cust_code: 'G', phone: '99758981' }, parsed: { custCode: 'G', fixedInApp: true, fixedFrom: { state: 'QUARANTINED' }, fixGroup: 'q' }, issues: [{ field: 'phone', message: 'phone already exists in master on customer H' }] },
    ];
    await open({ show: 'all' });
    const rowOf = (n: string) => screen.getByText(n).closest('tr')!;
    const buttons = (n: string) => within(rowOf(n)).queryAllByRole('button').map((b) => b.textContent);
    expect(buttons('#2')).toContain('Withdraw fix');
    // Promote loads only CLEAN rows: this one would load without row 2, and says so.
    expect(rowOf('#3').textContent).toMatch(/Came back with the fix of row 2, which is held back again: this row loads without it unless you withdraw the fix/);
    // Nothing of its fix is waiting: a held-back row is fixed or excluded, not withdrawn.
    expect(buttons('#4')).not.toContain('Withdraw fix');
  });

  it('a fix waiting past the 90-day window says promote will reject it', async () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    h.rows = [
      { id: 'f', rowNumber: 2, state: 'CLEAN', raw: { cust_code: 'F' }, parsed: { custCode: 'F', fixedInApp: true, fixedFrom: { state: 'QUARANTINED' }, fixGroup: 'f' }, issues: null, createdAt: old },
    ];
    await open({ show: 'all' });
    const row = screen.getByText('#2').closest('tr')!;
    expect(row.textContent).toMatch(/Row 2 was uploaded more than 90 days ago, so this fix will not load: promote rejects it/);
    expect(within(row).getByRole('button', { name: 'Withdraw fix' })).toBeTruthy();
  });

  it('a Manager is sent home', async () => {
    h.user = { id: 'm', role: 'MANAGER', username: 'm' };
    await expect(open()).rejects.toThrow('REDIRECT /home');
    h.user = { id: 's', role: 'STEWARD', username: 's' };
  });
});

// Code review 2026-11-10, finding 1: the sheet's unread headings, and the
// batch's "Overwrite CRM fields from this sheet" option, are on the batch page.
describe('/import/[batchId]: what the sheet had that the import did not read, and the overwrite option', () => {
  const row = (raw: Record<string, unknown>, rowNumber = 2): Row => ({
    id: `h${rowNumber}`,
    rowNumber,
    state: 'CLEAN',
    raw,
    parsed: { custCode: 'C1', custName: 'Shop' },
    issues: null,
  });

  it('lists the headings the import did not read, in order, and none of the ones it read under another spelling', async () => {
    h.rows = [row({ 'Cust Code': 'C1', cust_name: 'Shop', 'Temix code': 'C1', status: 'ACTIVE', Limit: 5, 'CUST BRANCH': '01' })];
    await open({ show: 'all' });
    expect(
      screen.getByText(
        'Not read: 2 columns in this sheet are not used by the import and were ignored — Limit, status. If one of them should have been read, check its spelling against the template.'
      )
    ).toBeTruthy();
  });

  it('says nothing when every heading was read, or when the rows were emptied by the 90-day sweep', async () => {
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop', TEMIX_CODE: 'C1' })];
    await open({ show: 'all' });
    expect(screen.queryByText(/^Not read:/)).toBeNull();
    cleanup();
    h.rows = [row({})];
    await open({ show: 'all' });
    expect(screen.queryByText(/^Not read:/)).toBeNull();
  });

  it('an account master has no such list', async () => {
    h.kind = 'ACCOUNT';
    const issue = { sheet: 'Users', row: 7, message: 'salesman needs route_code' };
    h.rows = [{ id: 'a1', rowNumber: 7, state: 'QUARANTINED', raw: issue, parsed: null, issues: [issue] }];
    await open();
    expect(screen.queryByText(/^Not read:/)).toBeNull();
  });

  it('with the option ON, a red banner says what Promote will replace, and when it was switched on', async () => {
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' })];
    h.batch = { status: 'READY', overwriteCrmFields: true, overwriteCrmFieldsAt: new Date('2026-11-10T06:30:00Z') };
    await open({ show: 'all' });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(
      /^Overwrite CRM fields from this sheet is ON for this batch \(switched on .*2026.*\)\. Promote will replace the name, phone, CR number, contact person, channel, address, visit day and open\/closed status of customers and shops already in the CRM wherever this sheet gives a value\.$/
    );
    expect(banner.className).toContain('text-red-800');
    expect(screen.queryByText(/and is off again/)).toBeNull();
  });

  it('after it has been used and switched off again, a quiet line keeps the record; a batch that never had it shows neither', async () => {
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' })];
    h.batch = { overwriteCrmFields: false, overwriteCrmFieldsAt: new Date('2026-11-10T06:30:00Z') };
    await open({ show: 'all' });
    expect(
      screen.getByText(
        /Overwrite CRM fields from this sheet was switched on for this batch on .*2026.* and is off again\. Rows promoted while it was on replaced CRM values \(each change is in the audit log\); rows promoted from now on fill blanks only unless it is switched on again\./
      )
    ).toBeTruthy();
    expect(screen.queryByText(/is ON for this batch/)).toBeNull();
    cleanup();
    h.batch = {};
    await open({ show: 'all' });
    expect(screen.queryByText(/Overwrite CRM fields from this sheet/)).toBeNull();
  });

  it('the Promote button is told the option may change only while the batch is ready and nobody is promoting it', async () => {
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' })];
    h.batch = { status: 'READY' };
    await open({ show: 'all' });
    expect(h.promote).toMatchObject({ batchId: 'b1', resume: false, canSetOverwrite: true });
    cleanup();
    h.batch = { status: 'PROMOTING', promoteLeaseUntil: new Date(Date.now() + 60_000) };
    await open({ show: 'all' });
    expect(h.promote).toMatchObject({ resume: true, leaseHeld: true, canSetOverwrite: false });
    cleanup();
    // Interrupted (no live lease): it must be resumed under the option it started with.
    h.batch = { status: 'PROMOTING', promoteLeaseUntil: null };
    await open({ show: 'all' });
    expect(h.promote).toMatchObject({ resume: true, canSetOverwrite: false });
  });
});

// Code review 2026-11-10, finding 6.
describe('/import/[batchId]: an old or discarded batch', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const row = (raw: Record<string, unknown>, over: Partial<Row> = {}): Row => ({
    id: 'g2',
    rowNumber: 2,
    state: 'CLEAN',
    raw,
    parsed: { custCode: 'C1', custName: 'Shop' },
    issues: null,
    ...over,
  });

  it('a staged batch says when and by whom it was uploaded, and offers Discard beside Promote', async () => {
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' })];
    h.batch = { status: 'READY', uploadedAt: new Date(Date.now() - 2 * DAY - 60_000) };
    await open({ show: 'all' });
    expect(screen.getByTestId('batch-staged').textContent).toMatch(/^Uploaded .+ by S \(2 days ago\)\.$/);
    expect(screen.getByRole('button', { name: 'Discard batch' })).toBeTruthy();
    expect(h.promote).toMatchObject({ batchId: 'b1' });
  });

  it('older than 7 days: no Promote or Resume, no fixing, a red note — and Discard', async () => {
    for (const status of ['READY', 'PROMOTING']) {
      h.promote = null;
      h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' }, { state: 'QUARANTINED', issues: [{ field: 'phone', message: 'phone invalid' }] })];
      h.batch = { status, uploadedAt: new Date(Date.now() - 8 * DAY) };
      await open();
      expect(h.promote, status).toBeNull();
      expect(screen.getByTestId('batch-too-old').textContent).toMatch(/This batch was uploaded 8 days ago, and a staged batch older than 7 days can no longer be promoted/);
      expect(screen.queryByText('Promote interrupted.')).toBeNull();
      expect(screen.queryByRole('columnheader', { name: 'Fix' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Discard batch' })).toBeTruthy();
      cleanup();
    }
  });

  // Adversarial review of finding 6: a batch already PROMOTED keeps the 90-day
  // fix window for its held-back rows — the 7-day limit is on a staged batch.
  it('a promoted batch older than 7 days still offers Fix on its held-back row, and no too-old note', async () => {
    h.promote = null;
    h.rows = [
      row({ cust_code: 'C1', cust_name: 'Shop' }, { state: 'PROMOTED' }),
      row({ cust_code: 'C2', cust_name: 'Shop 2' }, { id: 'r2', rowNumber: 3, state: 'QUARANTINED', parsed: { custCode: 'C2', custName: 'Shop 2' }, issues: [{ field: 'phone', message: 'phone invalid' }] }),
    ];
    h.batch = { status: 'PROMOTED', uploadedAt: new Date(Date.now() - 30 * DAY) };
    await open();
    expect(screen.queryByTestId('batch-too-old')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Fix' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard batch' })).toBeNull();
  });

  it('discarded: says so, and offers nothing', async () => {
    h.promote = null;
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' })];
    h.batch = { status: 'DISCARDED' };
    await open({ show: 'all' });
    expect(screen.getByTestId('batch-discarded').textContent).toContain('This batch was discarded, so it can no longer be promoted or fixed.');
    expect(h.promote).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard batch' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Fix' })).toBeNull();
  });

  it('a live promote: no Discard', async () => {
    h.rows = [row({ cust_code: 'C1', cust_name: 'Shop' })];
    h.batch = { status: 'PROMOTING', promoteLeaseUntil: new Date(Date.now() + 60_000) };
    await open({ show: 'all' });
    expect(screen.queryByRole('button', { name: 'Discard batch' })).toBeNull();
  });
});

// Code review 2026-11-10, finding 28 (second round): the rows a promote loaded
// with their shop NOT changed are read from the batch, so the notice is on the
// page after the refresh that ends the load, after a reload and on a later
// visit, until the Data Steward acknowledges it.
describe('/import/[batchId]: rows loaded with their shop NOT changed', () => {
  const row = (): Row => ({
    id: 'g2',
    rowNumber: 2,
    state: 'PROMOTED',
    raw: { cust_code: 'C1', cust_name: 'Shop', temix_code: 'T1' },
    parsed: { custCode: 'C1', custName: 'Shop' },
    issues: null,
  });

  it('a finished batch with rows not yet acknowledged shows the notice, whenever it is opened', async () => {
    h.rows = [row()];
    h.batch = { status: 'PROMOTED', shopNotChangedRows: 2, shopNotChangedAckRows: 0 };
    for (let visit = 0; visit < 2; visit++) {
      await open();
      const note = screen.getByTestId('shops-not-changed');
      expect(note.textContent).toContain('2 row(s) were loaded, but not everything they say about their shop was applied.');
      expect(note.textContent).toContain(SHOP_NOT_CHANGED_MEANING);
      expect(note.textContent).toContain(ROUTE_NOT_APPLIED);
      expect(within(note).getByRole('button', { name: 'I have read this' })).toBeTruthy();
      cleanup();
    }
  });

  it('the Promote button stays mounted on a finished batch, told it is finished, so the result of the load survives', async () => {
    h.rows = [row()];
    h.batch = { status: 'PROMOTED' };
    await open();
    expect(h.promote).toMatchObject({ batchId: 'b1', finished: true });
    cleanup();
    h.batch = { status: 'READY' };
    await open();
    expect(h.promote).toMatchObject({ finished: false });
  });

  it('acknowledged: no notice; rows a later promote added: only those are counted', async () => {
    h.rows = [row()];
    h.batch = { status: 'PROMOTED', shopNotChangedRows: 2, shopNotChangedAckRows: 2 };
    await open();
    expect(screen.queryByTestId('shops-not-changed')).toBeNull();
    cleanup();
    h.batch = { status: 'PROMOTED', shopNotChangedRows: 5, shopNotChangedAckRows: 2 };
    await open();
    expect(screen.getByTestId('shops-not-changed').textContent).toContain('3 row(s) were loaded, but not everything they say about their shop was applied.');
  });

  it('none such, or a promote still running: no notice', async () => {
    h.rows = [row()];
    h.batch = { status: 'PROMOTED', shopNotChangedRows: 0, shopNotChangedAckRows: 0 };
    await open();
    expect(screen.queryByTestId('shops-not-changed')).toBeNull();
    cleanup();
    h.batch = { status: 'PROMOTING', promoteLeaseUntil: new Date(Date.now() + 60_000), shopNotChangedRows: 3, shopNotChangedAckRows: 0 };
    await open();
    expect(screen.queryByTestId('shops-not-changed')).toBeNull();
  });
});
