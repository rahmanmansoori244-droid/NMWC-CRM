/**
 * Follow-up 1, H16 (bug hunt round 1, finding 9): /notifications shows the
 * newest 100 rows, but the bell counts every unread row. The page worked out
 * "unread", its subtitle and its bulk buttons from the 100 rows it shows, so an
 * Accountant who opened the newest ones one by one was told "All caught up",
 * with no "Mark all read", while the bell still showed the older unread rows
 * and nothing on the page could clear them. The page now counts as the bell
 * does, over every unread row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  unread: [] as Array<{ kind: string; _count: { _all: number } }>,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'acc-1', role: 'ACCOUNTANT', username: 'acc' } }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/services/notifications-actions', () => ({
  markNotificationReadAction: vi.fn(),
  markAllNotificationsReadAction: vi.fn(),
  markInformationReadAction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      findMany: async () => h.rows,
      groupBy: async () => h.unread,
    },
  },
}));

import NotificationsPage from '@/app/(app)/notifications/page';

/** The newest 100, every one already read. */
const hundredRead = Array.from({ length: 100 }, (_, i) => ({
  id: `n${i}`,
  kind: 'EDIT_STAGE_ADVANCED',
  title: `Approval waiting on you ${i}`,
  body: 'Shop',
  editId: null,
  customerId: null,
  readAt: new Date('2026-11-14T08:00:00Z'),
  createdAt: new Date(Date.UTC(2026, 10, 14, 7, 0, 0) - i * 60_000),
  edit: null,
}));

afterEach(cleanup);

describe('/notifications counts every unread row, as the bell does', () => {
  it('older unread rows past the newest 100: not "All caught up", and "Mark all read" is offered', async () => {
    h.rows = hundredRead;
    h.unread = [
      { kind: 'EDIT_STAGE_ADVANCED', _count: { _all: 3 } },
      { kind: 'REQUEST_FYI', _count: { _all: 40 } },
    ];
    render(await NotificationsPage());
    expect(screen.queryByText('All caught up')).toBeNull();
    expect(screen.getByText('3 unread · 40 for information')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark information read' })).toBeTruthy();
  });

  it('nothing unread anywhere: "All caught up" and no bulk button, as before', async () => {
    h.rows = hundredRead;
    h.unread = [];
    render(await NotificationsPage());
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });
});
