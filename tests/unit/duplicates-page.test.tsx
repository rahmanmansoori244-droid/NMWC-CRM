/**
 * The /duplicates page (benchmark item 16): the subtitle says how many pairs
 * there are, not how many fit on the page; the empty state describes the two
 * checks that exist, not the phone and fuzzy-name checks removed in May; and
 * only the Data Steward gets in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { DuplicateCandidate } from '@/lib/duplicate-pairing';

const h = vi.hoisted(() => ({
  user: { id: 's', role: 'STEWARD', username: 's' } as { id: string; role: string; username: string } | null,
  scan: { pairs: [] as DuplicateCandidate[], total: 0 },
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

beforeEach(() => {
  h.user = { id: 's', role: 'STEWARD', username: 's' };
  h.find.mockReset();
  h.find.mockImplementation(async () => h.scan);
});
afterEach(cleanup);

describe('/duplicates', () => {
  it('says the real count when the page shows only part of it', async () => {
    h.scan = { pairs: [{ reason: 'CR', similarity: 1, a: side('a'), b: side('b') }], total: 1234 };
    render(await DuplicatesPage());
    expect(screen.getByText('1,234 suspected pairs · showing the first 1')).toBeTruthy();
    expect(h.find).toHaveBeenCalledWith(50);
  });

  it('with nothing to review, describes the checks that actually run', async () => {
    h.scan = { pairs: [], total: 0 };
    render(await DuplicatesPage());
    expect(screen.getByText('No suspected pairs')).toBeTruthy();
    expect(screen.getByText('No suspected duplicates')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/share a CR number, or share the exact name, phone and region/);
    expect(body).not.toMatch(/fuzzy/i);
  });

  it.each([['MANAGER'], ['VIEWER'], ['SALESMAN']])('sends a %s home without scanning', async (role) => {
    h.user = { id: 'u', role, username: 'u' };
    await expect(DuplicatesPage()).rejects.toThrow('REDIRECT /home');
    expect(h.find).not.toHaveBeenCalled();
  });
});
