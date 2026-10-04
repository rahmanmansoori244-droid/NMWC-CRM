/**
 * F1 fixer review (2026-10-05): the bell keeps meaning "something waits on you".
 *
 * Since F1 the region's Accountant gets a REQUEST_FYI row for every salesman
 * request in his region. Counted in the red badge they held it at "9+" all day,
 * and the only way to clear it — "Mark all read" — also marked his unread
 * must-act rows read, which the e-mail drain then never sends (SKIPPED_READ).
 * Pinned here: information rows are a muted second count, never the red one;
 * "Mark information read" marks those rows and nothing else, for the caller only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

type Row = { id: string; userId: string; kind: string; readAt: Date | null };
const h = vi.hoisted(() => ({
  rows: [] as Row[],
  me: { id: 'acc', role: 'ACCOUNTANT', username: 'accounts.north' },
}));

vi.mock('@/app/actions/auth', () => ({ logoutAction: async () => {} }));
vi.mock('@/components/nmwc/Sidebar', () => ({ MobileNavDrawer: () => null, Sidebar: () => null, MobileTabBar: () => null }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { ...h.me, name: 'Accounts North' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/session', () => ({ requireActor: async () => h.me }));
vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      // The layout's one grouped count: unread rows of the caller, by kind.
      groupBy: async ({ by, where }: { by: string[]; where: { userId: string; readAt: null } }) => {
        expect(by).toEqual(['kind']);
        const counts = new Map<string, number>();
        for (const r of h.rows) if (r.userId === where.userId && r.readAt === null) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
        return [...counts].map(([kind, n]) => ({ kind, _count: { _all: n } }));
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; readAt: null; kind?: { in: string[] }; id?: string };
        data: { readAt: Date };
      }) => {
        const hit = h.rows.filter(
          (r) =>
            r.userId === where.userId &&
            r.readAt === null &&
            (where.kind === undefined || where.kind.in.includes(r.kind)) &&
            (where.id === undefined || r.id === where.id)
        );
        for (const r of hit) r.readAt = data.readAt;
        return { count: hit.length };
      },
    },
  },
}));

import { bellLabel, splitBellCounts } from '@/lib/notification-bell';
import { BELL_INFORMATION_KINDS } from '@/lib/notify-policy';
import { TopBar } from '@/components/nmwc/TopBar';
import { markAllNotificationsReadAction, markInformationReadAction } from '@/services/notifications-actions';
import AppLayout from '@/app/(app)/layout';

const USER = { fullName: 'Accounts North', username: 'accounts.north', role: 'ACCOUNTANT' as const };

beforeEach(() => {
  h.rows = [
    { id: 'f1', userId: 'acc', kind: 'REQUEST_FYI', readAt: null },
    { id: 'f2', userId: 'acc', kind: 'REQUEST_FYI', readAt: null },
    { id: 'act', userId: 'acc', kind: 'EDIT_STAGE_ADVANCED', readAt: null },
    { id: 'sla', userId: 'acc', kind: 'SLA_BREACH', readAt: null },
    { id: 'other', userId: 'mgr', kind: 'REQUEST_FYI', readAt: null },
  ];
});
afterEach(cleanup);

describe('what the bell counts', () => {
  it('information-only kinds are counted apart; everything else is the red count', () => {
    expect([...BELL_INFORMATION_KINDS]).toEqual(['REQUEST_FYI']);
    expect(
      splitBellCounts([
        { kind: 'REQUEST_FYI', count: 12 },
        { kind: 'EDIT_STAGE_ADVANCED', count: 1 },
        { kind: 'SLA_BREACH', count: 2 },
        { kind: 'EDIT_SUBMITTED', count: 3 },
      ])
    ).toEqual({ action: 6, information: 12 });
    expect(splitBellCounts([])).toEqual({ action: 0, information: 0 });
  });

  it('says both counts in words', () => {
    expect(bellLabel({ action: 0, information: 0 })).toBe('Notifications');
    expect(bellLabel({ action: 2, information: 0 })).toBe('Notifications (2 unread)');
    expect(bellLabel({ action: 0, information: 14 })).toBe('Notifications (14 for information)');
    expect(bellLabel({ action: 1, information: 3 })).toBe('Notifications (1 unread, 3 for information)');
  });

  it('a busy region’s information never turns the badge red', () => {
    const { container } = render(<TopBar user={USER} unreadCount={0} infoCount={14} />);
    const link = container.querySelector('a[href="/notifications"]')!;
    expect(link.getAttribute('aria-label')).toBe('Notifications (14 for information)');
    expect(container.querySelector('.bg-red-500')).toBeNull();
    expect(container.querySelector('[data-bell="information"]')?.textContent).toBe('9+');
  });

  it('a row that waits on him is red, whatever the information count', () => {
    const { container } = render(<TopBar user={USER} unreadCount={1} infoCount={30} />);
    expect(container.querySelector('.bg-red-500')?.textContent).toBe('1');
    expect(container.querySelector('[data-bell="information"]')).toBeNull();
    expect(container.querySelector('a[href="/notifications"]')!.getAttribute('aria-label')).toBe(
      'Notifications (1 unread, 30 for information)'
    );
  });

  it('nothing unread: no badge', () => {
    const { container } = render(<TopBar user={USER} />);
    expect(container.querySelector('.bg-red-500')).toBeNull();
    expect(container.querySelector('[data-bell="information"]')).toBeNull();
  });
});

describe('the layout feeds the bell', () => {
  it('his unread information is the muted count; his unread work is the red one', async () => {
    const { container } = render(await AppLayout({ children: null }));
    expect(container.querySelector('a[href="/notifications"]')!.getAttribute('aria-label')).toBe(
      'Notifications (2 unread, 2 for information)'
    );
    expect(container.querySelector('.bg-red-500')?.textContent).toBe('2');
  });

  it('information alone never turns the badge red', async () => {
    h.rows = h.rows.filter((r) => r.kind === 'REQUEST_FYI');
    const { container } = render(await AppLayout({ children: null }));
    expect(container.querySelector('.bg-red-500')).toBeNull();
    expect(container.querySelector('[data-bell="information"]')?.textContent).toBe('2');
  });
});

describe('Mark information read', () => {
  it('marks only his information rows; the rows that ask him to act stay unread, so their e-mail still goes', async () => {
    const res = await markInformationReadAction();
    expect(res).toEqual({ ok: true, data: { marked: 2 } });
    const unread = h.rows.filter((r) => r.readAt === null).map((r) => r.id);
    expect(unread.sort()).toEqual(['act', 'other', 'sla']);
  });

  it('Mark all read still marks everything of his, and nobody else’s', async () => {
    await markAllNotificationsReadAction();
    expect(h.rows.filter((r) => r.readAt === null).map((r) => r.id)).toEqual(['other']);
  });
});
