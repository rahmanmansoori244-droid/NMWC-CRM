/**
 * The daily Temix import, stage 3: the Data Steward's file list (/temix-daily).
 * Rendered with a stubbed database: the Steward sees each file with its notes,
 * the same-bytes warning and the order rule; anyone else is sent home; the
 * Steward's menu links the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { id: 'stw-1', role: 'STEWARD' } as { id: string; role: string } | null,
  files: [] as unknown[],
  unfinished: [] as unknown[],
  applied: [] as unknown[],
  inLoad: [] as unknown[],
  waiting: [] as unknown[],
}));

vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/temix-daily',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/services/temix-daily', () => ({ uploadTemixDailyFileAction: async () => ({ ok: false, message: 'x' }) }));
vi.mock('@/lib/db', () => ({
  prisma: {
    temixDailyFile: {
      findMany: async (q: { take?: number; where?: { state?: { in?: string[]; notIn?: string[] } } }) => {
        if (q.where?.state?.notIn) return h.unfinished;
        if (q.where?.state?.in?.includes('LOADED')) return h.applied;
        // Stage 5: the load in progress or interrupted (APPLYING, FINALIZING).
        if (q.where?.state?.in) return h.inLoad;
        return h.files;
      },
    },
    // The list reads the notes counted at upload: it never scans the rows.
    temixDailyRow: {
      groupBy: async () => {
        throw new Error('the page scanned TemixDailyRow');
      },
      findMany: async () => {
        throw new Error('the page scanned TemixDailyRow');
      },
      count: async () => {
        throw new Error('the page scanned TemixDailyRow');
      },
    },
    $queryRaw: async () => {
      throw new Error('the page ran raw SQL');
    },
    // The pilot rule's banner (stage 4).
    customerEdit: { findMany: async () => h.waiting },
  },
}));

import TemixDailyPage from '@/app/(app)/temix-daily/page';
import { NAV_BY_ROLE } from '@/components/nmwc/Sidebar';

const SHA = 'a'.repeat(64);
const file = (id: string, loadDay: string, state: string, over: Record<string, unknown> = {}) => ({
  id,
  filename: `${id}.xlsx`,
  loadDay: new Date(`${loadDay}T00:00:00Z`),
  uploadedAt: new Date(`${loadDay}T06:00:00Z`),
  state,
  fileSha256: SHA,
  totalRows: 3200,
  headings: { kind: 'xlsx', sheet: 'Daily', read: {}, notRead: [], otherSheets: [], notesAtUpload: { rows: 0, byNote: {} } },
  uploadedBy: { fullName: 'ZZ Steward' },
  sameBytesAs: null,
  ...over,
});

beforeEach(() => {
  h.user = { id: 'stw-1', role: 'STEWARD' };
  const older = file('f-old', '2026-11-12', 'STAGED');
  const newer = file('f-new', '2026-11-14', 'STAGED', {
    sameBytesAs: { loadDay: new Date('2026-11-12T00:00:00Z'), filename: 'f-old.xlsx' },
    headings: { kind: 'xlsx', sheet: 'Daily', read: {}, notRead: [], otherSheets: [], notesAtUpload: { rows: 3, byNote: { SHOP_CODE_LOOKALIKE: 2, STATUS_NOT_A_OR_I: 1 } } },
  });
  h.files = [newer, older];
  h.unfinished = [older, newer];
  h.applied = [];
  h.inLoad = [];
  h.waiting = [];
});
afterEach(cleanup);

describe('/temix-daily', () => {
  it('lists each file with its notes, the same-bytes warning and what it waits for', async () => {
    render(await TemixDailyPage());
    expect(screen.getByText(/Upload stages the file only; open it to check it, then apply its route moves/i)).toBeTruthy();
    const row = screen.getByText('f-new.xlsx').closest('tr')!;
    expect(within(row).getByText(/Exactly the same file as 2026-11-12/)).toBeTruthy();
    expect(within(row).getByText(/Waits for the file of 2026-11-12/)).toBeTruthy();
    expect(within(row).getByText('3,200')).toBeTruthy();
    expect(within(row).getByText(/2: a shop code that looks like another/)).toBeTruthy();
    expect(within(row).getByText(/1: status is not A or I/)).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
    const old = screen.getByText('f-old.xlsx').closest('tr')!;
    expect(within(old).queryByText(/Waits for/)).toBeNull();
  });

  it('a file overtaken by a later day already applied says it can never be applied', async () => {
    h.applied = [file('f-later', '2026-11-13', 'LOADED')];
    render(await TemixDailyPage());
    const old = screen.getByText('f-old.xlsx').closest('tr')!;
    expect(within(old).getByText(/Can never be applied: the file of 2026-11-13 is already applied/)).toBeTruthy();
  });

  it('stage 5: a load interrupted or in progress is named, with a link to resume it', async () => {
    h.inLoad = [{ id: 'f-run', filename: 'f-run.xlsx', loadDay: new Date('2026-11-13T00:00:00Z'), applyLeaseUntil: null }];
    render(await TemixDailyPage());
    const banner = screen.getByText(/The file of 2026-11-13/);
    expect(banner.textContent).toMatch(/part-applied: the load was interrupted/);
    expect(within(banner).getByRole('link', { name: 'Open it to resume' }).getAttribute('href')).toBe('/temix-daily/f-run');
    cleanup();
    h.inLoad = [{ id: 'f-run', filename: 'f-run.xlsx', loadDay: new Date('2026-11-13T00:00:00Z'), applyLeaseUntil: new Date(Date.now() + 60_000) }];
    render(await TemixDailyPage());
    expect(screen.getByText(/The file of 2026-11-13/).textContent).toMatch(/is being applied now/);
  });

  it("stage 6: a loaded file's day links to the day's drill-down; an unfinished one's does not", async () => {
    h.files = [file('f-done', '2026-11-11', 'LOADED'), ...h.files];
    render(await TemixDailyPage());
    const done = screen.getByText('f-done.xlsx').closest('tr')!;
    expect(within(done).getByRole('link', { name: '2026-11-11' }).getAttribute('href')).toBe('/temix-daily/day/2026-11-11');
    const old = screen.getByText('f-old.xlsx').closest('tr')!;
    expect(within(old).queryByRole('link', { name: '2026-11-12' })).toBeNull();
  });

  it('is the Data Steward\'s only', async () => {
    for (const role of ['MANAGER', 'SALESMAN', 'ACCOUNTANT', 'GM', 'VIEWER']) {
      h.user = { id: 'u', role };
      await expect(TemixDailyPage(), role).rejects.toThrow('REDIRECT /home');
    }
    h.user = null;
    await expect(TemixDailyPage()).rejects.toThrow('REDIRECT /login');
  });

  it('only the Steward\'s menu links it', () => {
    for (const [role, items] of Object.entries(NAV_BY_ROLE)) {
      expect(items.some((i) => i.href === '/temix-daily'), role).toBe(role === 'STEWARD');
    }
  });
});
