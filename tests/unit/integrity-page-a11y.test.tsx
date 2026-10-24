/**
 * /status/integrity for a screen reader (the back-office accessibility pass).
 *
 * Each check's last runs were coloured dots in a span carrying an aria-label —
 * ARIA does not allow a name on a plain span (axe aria-prohibited-attr, serious),
 * so a screen reader said nothing, and the dots said pass or fail by colour
 * alone. The trend is now an image named with every status, oldest first (the
 * order lib/integrity/report.ts builds it in), and each check is a heading under
 * "Last run". The page is rendered with its loader mocked, as status-page.test.tsx
 * mocks its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { IntegrityReport } from '@/lib/integrity/report';

const h = vi.hoisted(() => ({
  user: { id: 'u', role: 'STEWARD', username: 'u' } as { id: string; role: string; username: string } | null,
  load: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/integrity/report', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrity/report')>()),
  loadIntegrityReport: h.load,
}));

import IntegrityPage from '@/app/(app)/status/integrity/page';
import { CHECKS } from '@/lib/integrity/checks';

const RUN = new Date('2026-10-20T02:30:00Z');
const [FIRST, SECOND] = CHECKS;

function report(over: Partial<IntegrityReport> = {}): IntegrityReport {
  return {
    latestRunAt: RUN,
    latest: [
      { runAt: RUN, checkId: FIRST!.id, status: 'fail', count: 2, sampleIds: [], detail: null },
      { runAt: RUN, checkId: SECOND!.id, status: 'pass', count: 0, sampleIds: [], detail: null },
    ],
    trend: new Map([
      [FIRST!.id, ['pass', 'pass', 'fail']],
      [SECOND!.id, ['pass']],
    ]),
    seals: [{ seq: 1, day: '2026-10-19', hash: 'a'.repeat(64), r2Key: 'k', rows: 10, tables: 2 }],
    purges: [],
    customerOf: new Map(),
    ...over,
  };
}

beforeEach(() => {
  h.user = { id: 'u', role: 'STEWARD', username: 'u' };
  h.load.mockReset().mockResolvedValue(report());
});
afterEach(cleanup);

describe('/status/integrity, for a screen reader', () => {
  it("each check's trend is an image named with its statuses, oldest first, and the dots are not read one by one", async () => {
    render(await IntegrityPage());
    const first = screen.getByRole('img', { name: 'Last 3 runs, oldest first: pass, pass, fail' });
    expect(screen.getByRole('img', { name: 'Last 1 run, oldest first: pass' })).toBeTruthy();
    const dots = [...first.children];
    expect(dots).toHaveLength(3);
    for (const d of dots) expect(d.getAttribute('aria-hidden')).toBe('true');
  });

  it('a check with no runs yet has no empty image', async () => {
    h.load.mockResolvedValue(report({ trend: new Map() }));
    render(await IntegrityPage());
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('cr-number-shared (owner decision 2026-10-25): its samples are customer codes, and it links to /duplicates when it finds any', async () => {
    const cr = (count: number, sampleIds: string[]) =>
      report({
        latest: [{ runAt: RUN, checkId: 'cr-number-shared', status: 'info', count, sampleIds, detail: { crNumbers: 1, largest: 2, pairs: 1 } }],
        trend: new Map([['cr-number-shared', ['info']]]),
        customerOf: new Map([
          ['c1', { id: 'c1', code: 'NMWC-2026-000001' }],
          ['c2', { id: 'c2', code: 'NMWC-2026-000002' }],
        ]),
      });
    h.load.mockResolvedValue(cr(2, ['c1', 'c2']));
    render(await IntegrityPage());
    const heading = screen.getByRole('heading', { level: 3, name: /^Live customers sharing a CR number/ });
    const item = heading.closest('li')!;
    expect(within(item).getByRole('link', { name: 'NMWC-2026-000001' }).getAttribute('href')).toBe('/customers/c1');
    expect(within(item).getByRole('link', { name: 'NMWC-2026-000002' }).getAttribute('href')).toBe('/customers/c2');
    expect(within(item).getByRole('link', { name: 'Review them on the duplicates page' }).getAttribute('href')).toBe('/duplicates');
    cleanup();

    h.load.mockResolvedValue(cr(0, []));
    render(await IntegrityPage());
    const none = screen.getByRole('heading', { level: 3, name: /^Live customers sharing a CR number/ }).closest('li')!;
    expect(within(none).queryByRole('link')).toBeNull();
  });

  it('each check is a heading under "Last run", and the seal table names its columns', async () => {
    render(await IntegrityPage());
    const lastRun = screen.getByRole('heading', { level: 2, name: /^Last run/ });
    const section = lastRun.closest('section')!;
    const titles = within(section)
      .getAllByRole('heading', { level: 3 })
      .map((el) => el.textContent);
    expect(titles).toHaveLength(CHECKS.length);
    expect(titles[0]).toBe(`${FIRST!.title}2`);
    for (const th of screen.getAllByRole('columnheader')) expect(th.getAttribute('scope')).toBe('col');
  });
});
