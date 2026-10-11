/**
 * Owner decision 3 (2026-10-07): a Manager's "Stale approval (>3 days)" list on
 * /work holds what he can decide — his /approvals queue (lib/manager-queue.ts,
 * the same `where`) and the reactivations of a branch in his regions — not every
 * request on a customer with a branch in his regions at any step. It listed a
 * request about another region's branch of a shared customer, and requests at
 * the Accountant's or the GM's step, which he cannot decide.
 * The queue's rows against Postgres: tests/integration/scope-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

const QUEUE = { __queue: 'the Manager’s /approvals where' };
const h = vi.hoisted(() => ({
  regions: ['g1'] as string[],
  rows: [] as Array<Record<string, unknown>>,
  /** Owner decisions 2026-10-11: credit applications to print (the query on pendingRole SALESMAN). */
  printRows: [] as Array<Record<string, unknown>>,
  role: 'MANAGER',
  findManyArgs: [] as Array<{ where: Record<string, unknown> }>,
  printArgs: [] as Array<{ where: Record<string, unknown> }>,
  queueCalls: [] as unknown[][],
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-mgr', role: h.role, username: 'mgr' } }) }));
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
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions }),
}));
vi.mock('@/lib/manager-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/manager-queue')>()),
  managerQueueWhere: vi.fn(async (...args: unknown[]) => {
    h.queueCalls.push(args);
    return QUEUE;
  }),
}));
// The salesman's sent-back list is not under test here.
vi.mock('@/lib/returned-work', () => ({ openReturnedIds: async () => [], inIdOrder: () => [] }));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        if (args.where.pendingRole === 'SALESMAN') {
          h.printArgs.push(args);
          return h.printRows;
        }
        h.findManyArgs.push(args);
        return h.rows;
      },
    },
  },
}));

import { SUPERVISOR_STEP_OR } from '@/lib/manager-queue';
import { prisma } from '@/lib/db';

const row = (over: Record<string, unknown>) => ({
  id: 'e1',
  state: 'SUBMITTED',
  isReactivation: false,
  submittedAt: new Date('2026-10-01T08:00:00Z'),
  customer: { id: 'c1', legalName: 'Al Noor Trading' },
  customerDraft: null,
  ...over,
});

async function renderWork() {
  const { default: WorkPage } = await import('@/app/(app)/work/page');
  render(await WorkPage());
}

beforeEach(() => {
  h.regions = ['g1'];
  h.rows = [];
  h.printRows = [];
  h.role = 'MANAGER';
  h.findManyArgs = [];
  h.printArgs = [];
  h.queueCalls = [];
});
afterEach(cleanup);

describe('Work, for a Manager: stale approvals', () => {
  it('are his /approvals queue and his reactivations, over three days old — nothing else', async () => {
    await renderWork();
    expect(h.queueCalls).toEqual([[prisma, ['g1'], SUPERVISOR_STEP_OR]]);
    expect(h.findManyArgs).toHaveLength(1);
    const where = h.findManyArgs[0]!.where as { submittedAt: { lt: Date }; OR: unknown[] };
    expect(Object.keys(where).sort()).toEqual(['OR', 'submittedAt']);
    expect(where.OR).toEqual([
      QUEUE,
      { state: 'SUBMITTED', isReactivation: true, branch: { regionId: { in: ['g1'] } } },
    ]);
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(Date.now() - threeDays - where.submittedAt.lt.getTime())).toBeLessThan(60_000);
  });

  it('a request opens its review page; a reactivation opens /reactivations, where he decides it', async () => {
    h.rows = [
      row({ id: 'e-upd' }),
      row({ id: 'e-react', isReactivation: true, customer: { id: 'c2', legalName: 'Bahja Stores' } }),
    ];
    await renderWork();
    expect(screen.getByText('Al Noor Trading').closest('a')!.getAttribute('href')).toBe('/approvals/e-upd');
    expect(screen.getByText('Bahja Stores').closest('a')!.getAttribute('href')).toBe('/reactivations');
  });

  it('no regions: nothing is read and nothing listed (fail-closed)', async () => {
    h.regions = [];
    await renderWork();
    expect(h.queueCalls).toEqual([]);
    expect(h.findManyArgs).toEqual([]);
    expect(h.printArgs).toEqual([]);
    expect(screen.getByText('All clear')).toBeTruthy();
  });
});

describe('owner decisions 2026-10-11: credit applications to print', () => {
  const printRow = (over: Record<string, unknown> = {}) => ({
    id: 'e-print',
    state: 'SUBMITTED',
    slaDueAt: new Date('2026-10-14T12:00:00Z'),
    customerDraft: { legalName: 'Sea View Trading' },
    submittedBy: { fullName: 'Salim Al Harthy' },
    ...over,
  });

  it('a Manager: requests from his regions waiting for the signed application, linked to their review page', async () => {
    h.printRows = [printRow()];
    await renderWork();
    expect(h.printArgs).toHaveLength(1);
    expect(h.printArgs[0]!.where).toEqual({
      branchDrafts: { some: { route: { regionId: { in: ['g1'] } } } },
      state: 'SUBMITTED',
      process: 'CREATE',
      pendingRole: 'SALESMAN',
    });
    const card = screen.getByText('Sea View Trading').closest('a')!;
    expect(card.getAttribute('href')).toBe('/approvals/e-print');
    expect(card.textContent).toContain('Credit application to print');
    expect(card.textContent).toContain('For Salim Al Harthy to have signed and stamped · due 14/10/2026, 16:00:00');
  });

  it('a Supervisor: his own reports’ requests', async () => {
    h.role = 'SUPERVISOR';
    h.printRows = [printRow()];
    await renderWork();
    expect(h.printArgs[0]!.where).toEqual({
      submittedBy: { supervisorId: 'u-mgr' },
      state: 'SUBMITTED',
      process: 'CREATE',
      pendingRole: 'SALESMAN',
    });
    expect(screen.getByText('Sea View Trading').closest('a')!.getAttribute('href')).toBe('/approvals/e-print');
  });

  it('the salesman sees it as his own work, with the due time, on his request’s page', async () => {
    h.role = 'SALESMAN';
    h.rows = [
      {
        id: 'e-mine',
        process: 'CREATE',
        state: 'SUBMITTED',
        pendingRole: 'SALESMAN',
        isReactivation: false,
        target: 'CUSTOMER',
        customerId: null,
        slaDueAt: new Date('2026-10-14T12:00:00Z'),
        submittedAt: new Date('2026-10-10T08:00:00Z'),
        customer: null,
        customerDraft: { legalName: 'Sea View Trading' },
      },
      {
        id: 'e-sd',
        process: 'CREATE',
        state: 'SUBMITTED',
        pendingRole: 'SALES_DIRECTOR',
        isReactivation: false,
        target: 'CUSTOMER',
        customerId: null,
        slaDueAt: null,
        submittedAt: new Date('2026-10-10T08:00:00Z'),
        customer: null,
        customerDraft: { legalName: 'Bahja Stores' },
      },
    ];
    const { default: WorkPage } = await import('@/app/(app)/work/page');
    render(await WorkPage());
    const mine = screen.getAllByText('Sea View Trading')[0]!.closest('a')!;
    expect(mine.getAttribute('href')).toBe('/customers/new?edit=e-mine');
    expect(mine.textContent).toContain('New customer — signed application needed');
    expect(mine.textContent).toContain('Have it signed and stamped, then upload it · due 14/10/2026, 16:00:00');
    const sd = screen.getAllByText('Bahja Stores')[0]!.closest('a')!;
    expect(sd.textContent).toContain('In review — current step: Sales Director');
  });
});
