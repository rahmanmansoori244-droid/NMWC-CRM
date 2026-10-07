/**
 * Launch fix: the Today header prints the Oman date. It came from the server's
 * clock (UTC on Vercel), so between 00:00 and 03:59 Oman it said yesterday, while
 * the visit list under it (omanDayOfWeek) was already today's. The process runs
 * in UTC here, as on Vercel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ day: null as unknown }));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', role: 'SALESMAN', username: 's' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUniqueOrThrow: async () => ({ id: 'u1', fullName: 'Said Ali', ownedRouteId: 'r1' }) },
    customerEdit: { count: async () => 0 },
    // countOpenReturned (lib/returned-work.ts) counts the open sent-back requests in SQL.
    $queryRaw: async () => [{ n: 0 }],
    branch: {
      findMany: async () => [],
      // The visit day the list asks for, so the test can say header and list agree.
      count: async (args: { where?: { dayOfVisit?: unknown } }) => {
        if (typeof args.where?.dayOfVisit === 'string') h.day = args.where.dayOfVisit;
        return 0;
      },
    },
  },
}));

import TodayPage from '@/app/(app)/today/page';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('/today header date', () => {
  it('is the Oman date after Oman midnight, the same day the visit list reads', async () => {
    vi.stubEnv('TZ', 'UTC');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T21:30:00.000Z')); // 01:30 on Thursday 8 October in Oman
    render(await TodayPage({}));
    expect(screen.getByText('Thursday, 8 October 2026')).toBeTruthy();
    expect(screen.queryByText(/Wednesday/)).toBeNull();
    expect(h.day).toBe('THU');
  });
});
