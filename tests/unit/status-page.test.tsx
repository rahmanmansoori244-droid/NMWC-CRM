/**
 * Item 9: the Service status page — who gets in, that the menu offers it to
 * exactly those people, and that it states its verdicts in words.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { withoutErrorText, type ServiceStatus } from '@/lib/service-status';

const h = vi.hoisted(() => ({
  user: { id: 'u', role: 'STEWARD', username: 'u' } as { id: string; role: string; username: string } | null,
  load: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/status',
}));
vi.mock('@/lib/service-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/service-status')>()),
  loadServiceStatus: h.load,
}));

import StatusPage from '@/app/(app)/status/page';
import { NAV_BY_ROLE } from '@/components/nmwc/Sidebar';
import { STATUS_ROLES } from '@/lib/service-levels';

const NOW = new Date('2026-10-05T08:00:00Z');
const MANAGERS = Array.from({ length: 11 }, (_, i) => `m${i}`);
const ACCOUNTANTS = Array.from({ length: 7 }, (_, i) => `acc${i}`);

function status(over: Partial<ServiceStatus> = {}): ServiceStatus {
  const slot = { okSlots: 0, failedSlots: 0, silentSlots: 0 };
  return {
    now: NOW,
    availability: {
      good: 995, total: 1000, ratio: 0.995, budgetLeft: 0, status: 'at-risk',
      ...slot, okSlots: 995, silentSlots: 5, since: new Date('2026-09-28T03:00:00Z'), p95DbMs: 12,
    },
    slaSweep: { good: 0, total: 0, ratio: null, budgetLeft: null, status: 'no-data', ...slot, since: null },
    backup: { good: 7, total: 7, ratio: 1, budgetLeft: 1, status: 'met', since: null, missedDays: 0 },
    approvals: {
      good: 63, total: 80, ratio: 63 / 80, budgetLeft: -1.125, status: 'breached', since: null, untracked: 3,
      tiers: [
        { role: 'SUPERVISOR', decided: 43, tracked: 40, within: 30, p50Minutes: 95, p90Minutes: 610, people: MANAGERS },
        { role: 'GM', decided: 5, tracked: 5, within: 3, p50Minutes: 360, p90Minutes: 840, people: ['gm'] },
        { role: 'ACCOUNTANT', decided: 35, tracked: 35, within: 30, p50Minutes: 120, p90Minutes: 700, people: ACCOUNTANTS },
      ],
    },
    openApprovals: [
      { role: 'SUPERVISOR', open: 4, pastDue: 2, oldestWorkingMinutes: 700, holders: MANAGERS },
      { role: 'GM', open: 2, pastDue: 1, oldestWorkingMinutes: 660, holders: ['gm'] },
    ],
    temix: { status: 'met', waiting: 0, oldestWaitingSince: null, uploadedAwaitingTemix: 0 },
    imports: { status: 'breached', stuckPromotes: 1, stuckUploads: 0 },
    jobs: [
      {
        key: 'keep-warm', label: 'Keep-warm ping', severity: 'warning', state: 'failed', alarm: true,
        lastRunAt: '2026-10-05T07:56:00.000Z', lastOk: false, ageMinutes: 4,
        expectedEveryMinutes: 4, runs: 10, failures: 1, lastVercelRunAt: '2026-10-05T07:52:00.000Z',
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  h.load.mockReset().mockResolvedValue(status());
});
afterEach(() => cleanup());

describe('who gets in', () => {
  it.each(['SALESMAN', 'SUPERVISOR', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'VIEWER'])(
    '%s is sent home without anything being loaded',
    async (role) => {
      h.user = { id: 'x', role, username: 'x' };
      await expect(StatusPage()).rejects.toThrow('REDIRECT /home');
      expect(h.load).not.toHaveBeenCalled();
    }
  );

  it('signed out goes to /login', async () => {
    h.user = null;
    await expect(StatusPage()).rejects.toThrow('REDIRECT /login');
  });

  it.each(['STEWARD', 'MANAGER'])('%s sees the page', async (role) => {
    h.user = { id: 'x', role, username: 'x' };
    render(await StatusPage());
    expect(screen.getByRole('heading', { name: 'Service status' })).toBeTruthy();
  });
});

describe('the menu offers the page to exactly the roles the page admits', () => {
  it.each(Object.keys(NAV_BY_ROLE))('%s', (role) => {
    const offered = NAV_BY_ROLE[role as keyof typeof NAV_BY_ROLE].some((i) => i.href === '/status');
    expect(offered).toBe(STATUS_ROLES.includes(role));
  });
});

describe('what it says', () => {
  beforeEach(() => {
    h.user = { id: 'x', role: 'MANAGER', username: 'x' };
  });

  it('states every objective with its verdict in words', async () => {
    render(await StatusPage());
    for (const title of [
      'The app answers',
      'Approvals decided within their SLA',
      'The SLA escalation sweep runs',
      'A backup every night',
      'The ERP hand-off is current',
      'No import is stuck',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getAllByText('Missed').length).toBe(2); // approvals, imports
    expect(screen.getByText('At risk')).toBeTruthy();
    expect(screen.getByText('Not measured yet')).toBeTruthy();
  });

  it('says what it could not count instead of guessing', async () => {
    render(await StatusPage());
    expect(screen.getByText(/3 decisions made before the SLA was recorded/)).toBeTruthy();
    expect(screen.getByText(/5 with no probe at all/)).toBeTruthy();
    expect(screen.getByText(/Measuring since/)).toBeTruthy();
  });

  it('shows the open queue in working time', async () => {
    // For a Manager the one-person GM queue folds in with the Supervisor queue.
    render(await StatusPage());
    expect(screen.getByText('Other steps together')).toBeTruthy();
    expect(screen.getByText(/3 past due · oldest waiting 11 h 40 m of working time/)).toBeTruthy();
  });

  it('the Data Steward sees each queue on its own', async () => {
    h.user = { id: 'x', role: 'STEWARD', username: 'x' };
    render(await StatusPage());
    expect(screen.getByText(/2 past due · oldest waiting 11 h 40 m of working time/)).toBeTruthy();
    expect(screen.getByText(/1 past due · oldest waiting 11 h 0 m of working time/)).toBeTruthy();
  });

  it('a warning-tier alarm says it leaves the health check green, and Vercel’s last run is shown', async () => {
    render(await StatusPage());
    expect(screen.getByText('reported only: the health check stays green')).toBeTruthy();
    // The owner retires cron-job.org once Vercel is seen calling (OPERATIONS §5d).
    expect(screen.getByText(/Vercel last ran it 11:52/)).toBeTruthy();
  });

  it('a sliver over budget reads "Error budget spent", never "0% left" beside Missed', async () => {
    h.load.mockResolvedValue(
      status({
        approvals: {
          good: 188, total: 209, ratio: 188 / 209, budgetLeft: -0.0047, status: 'breached', since: null, untracked: 0,
          tiers: [{ role: 'SUPERVISOR', decided: 209, tracked: 209, within: 188, p50Minutes: 90, p90Minutes: 480, people: MANAGERS }],
        },
      })
    );
    render(await StatusPage());
    const card = screen.getByRole('heading', { name: 'Approvals decided within their SLA' }).closest('article')!;
    expect(card.textContent).toContain('Error budget spent');
    expect(card.textContent).not.toContain('0% of the error budget left');
  });
});

describe('one colleague’s decision speed is not shown to the Managers', () => {
  it('a Manager does not see the General Manager step on its own — it is folded in with the Accountants', async () => {
    h.user = { id: 'x', role: 'MANAGER', username: 'x' };
    const { container } = render(await StatusPage());
    const card = screen.getByRole('heading', { name: 'Approvals decided within their SLA' }).closest('article')!;
    expect(card.textContent).toContain('63 of 80 decisions on time');
    expect(card.textContent).toContain('Supervisor step: 30/40 on time');
    // GM (1 person) + the smallest shown step (7 accountants): 33/40, 8 people.
    expect(card.textContent).toContain('Other steps together: 33/40 on time');
    expect(card.textContent).not.toContain('General manager');
    expect(card.textContent).not.toContain('Accountant step');
    // Company-wide minus the lines shown is the "other steps" line — nothing smaller.
    expect(63 - 30).toBe(33);
    expect(container.textContent).not.toContain('General manager');
  });

  it('a Manager is not told "nothing is waiting" when only single-holder steps have requests waiting', async () => {
    h.user = { id: 'x', role: 'MANAGER', username: 'x' };
    h.load.mockResolvedValue(
      status({ openApprovals: [{ role: 'GM', open: 2, pastDue: 1, oldestWorkingMinutes: 660, holders: ['gm'] }] })
    );
    const { container } = render(await StatusPage());
    expect(container.textContent).not.toContain('Nothing is waiting for an approver');
    expect(container.textContent).toContain('Requests are waiting at steps that fewer than three people decide');
    // No count: with one hidden step it would be the GM's own queue.
    expect(container.textContent).not.toMatch(/General manager/);
  });

  it('"nothing is waiting" when nothing is', async () => {
    h.user = { id: 'x', role: 'MANAGER', username: 'x' };
    h.load.mockResolvedValue(status({ openApprovals: [] }));
    const { container } = render(await StatusPage());
    expect(container.textContent).toContain('Nothing is waiting for an approver');
  });

  it('the Data Steward sees every step', async () => {
    h.user = { id: 'x', role: 'STEWARD', username: 'x' };
    const { container } = render(await StatusPage());
    expect(container.textContent).toContain('General manager step: 3/5 on time');
    expect(container.textContent).toContain('Accountant step: 30/35 on time');
  });
});

describe('a job’s error text never reaches the page — it stays behind the monitor bearer', () => {
  it('the loader drops it', () => {
    const job = {
      key: 'photo-gc' as const,
      label: 'Photo garbage collection',
      severity: 'warning' as const,
      state: 'failed' as const,
      alarm: true,
      lastRunAt: null,
      lastOk: false,
      lastError: 'a scrubbed error',
      ageMinutes: null,
      expectedEveryMinutes: 1440,
      runs: 1,
      failures: 1,
    };
    expect(withoutErrorText(job)).not.toHaveProperty('lastError');
  });

  it('every job the loader returns goes through it, and nothing reads lastDetail', () => {
    const src = stripComments(readFileSync('lib/service-status.ts', 'utf8'), 'service-status.ts');
    expect(src).toMatch(/jobs: jobs\.map\(\(j\) => withoutErrorText\(j,/);
    expect(src).not.toMatch(/lastDetail/);
  });
});
