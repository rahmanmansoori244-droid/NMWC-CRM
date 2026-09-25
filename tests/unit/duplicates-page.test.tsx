/**
 * The /duplicates page (benchmark item 16): the subtitle says how many pairs
 * there are, not how many fit on the page; the empty state describes the two
 * checks that exist, not the phone and fuzzy-name checks removed in May; the
 * pairs a dismissal hides are listed with an Undo, and a pair whose dismissal
 * lapsed says it was marked distinct before (owner decision 2026-09-25); and
 * only the Data Steward gets in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { DuplicateCandidate, DuplicateScan } from '@/lib/duplicate-pairing';
import { omanDateISO } from '@/lib/tz';

const h = vi.hoisted(() => ({
  user: { id: 's', role: 'STEWARD', username: 's' } as { id: string; role: string; username: string } | null,
  scan: { pairs: [], total: 0, markedDistinct: [] } as DuplicateScan,
  find: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock('@/services/duplicates', () => ({
  findDuplicateCandidates: h.find,
  mergeCustomersAction: vi.fn(),
  dismissDuplicateAction: vi.fn(),
  undoDismissDuplicateAction: vi.fn(),
}));

import DuplicatesPage from '@/app/(app)/duplicates/page';

const side = (id: string) => ({
  id,
  nmwcCode: `N-${id}`,
  legalName: `Shop ${id}`,
  primaryPhone: null,
  crNumber: '7',
  completenessScore: 50,
  branchCount: 1,
});
const pair = (a: string, b: string, over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  reason: 'CR',
  similarity: 1,
  a: side(a),
  b: side(b),
  ...over,
});

beforeEach(() => {
  h.user = { id: 's', role: 'STEWARD', username: 's' };
  h.scan = { pairs: [], total: 0, markedDistinct: [] };
  h.find.mockReset();
  h.find.mockImplementation(async () => h.scan);
});
afterEach(cleanup);

describe('/duplicates', () => {
  it('says the real count when the page shows only part of it', async () => {
    h.scan = { pairs: [pair('a', 'b')], total: 1234, markedDistinct: [] };
    render(await DuplicatesPage());
    expect(screen.getByText('1,234 suspected pairs · showing the first 1')).toBeTruthy();
    expect(h.find).toHaveBeenCalledWith(50);
  });

  it('with nothing to review, describes the checks that actually run — and that a dismissal can lapse', async () => {
    render(await DuplicatesPage());
    expect(screen.getByText('No suspected pairs')).toBeTruthy();
    expect(screen.getByText('No suspected duplicates')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/share a CR number, or share the exact name and phone with a branch in the same region/);
    expect(body).toMatch(/stays hidden until the two come to share a different CR number, name or phone/);
    expect(body).not.toMatch(/fuzzy/i);
    expect(body).not.toMatch(/not shown again/);
    // Nothing marked distinct: no empty section.
    expect(screen.queryByText(/^Marked distinct \(/)).toBeNull();
  });

  it('lists the pairs marked distinct with names, codes, when and by whom, each with an Undo', async () => {
    const at = new Date('2026-09-20T21:30:00Z'); // 21 Sep in Oman
    h.scan = {
      pairs: [],
      total: 0,
      markedDistinct: [
        { a: side('a'), b: side('b'), at, by: 'Aisha Al Balushi' },
        { a: side('c'), b: side('d'), at: null, by: null },
      ],
    };
    render(await DuplicatesPage());
    expect(screen.getByText('Marked distinct (2)')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(rows[0].textContent).toContain('Shop a');
    expect(rows[0].textContent).toContain('N-a');
    expect(rows[0].textContent).toContain('Shop b');
    expect(rows[0].textContent).toContain('N-b');
    expect(first.getByText(`Marked distinct ${omanDateISO(at)} by Aisha Al Balushi`)).toBeTruthy();
    expect(omanDateISO(at)).toBe('2026-09-21');
    expect(first.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(within(rows[1]).getByText('Marked distinct earlier')).toBeTruthy();
    expect(within(rows[1]).getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('a pair whose dismissal lapsed says it was marked distinct before; a new pair says nothing of the kind', async () => {
    const at = new Date('2026-09-01T06:00:00Z');
    h.scan = {
      pairs: [pair('a', 'b', { markedDistinctBefore: { at, by: 'Aisha' } }), pair('c', 'd')],
      total: 2,
      markedDistinct: [],
    };
    render(await DuplicatesPage());
    const cards = screen.getAllByRole('listitem');
    expect(cards[0].textContent).toContain('Marked distinct 2026-09-01 by Aisha; back because what they share has changed since.');
    expect(cards[1].textContent).not.toMatch(/Marked distinct/);
  });

  it.each([['MANAGER'], ['VIEWER'], ['SALESMAN']])('sends a %s home without scanning', async (role) => {
    h.user = { id: 'u', role, username: 'u' };
    await expect(DuplicatesPage()).rejects.toThrow('REDIRECT /home');
    expect(h.find).not.toHaveBeenCalled();
  });
});
