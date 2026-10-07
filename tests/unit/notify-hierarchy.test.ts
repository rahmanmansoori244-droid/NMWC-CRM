// @vitest-environment node
/**
 * F1 (2026-10-05): who in the salesman's hierarchy is told of his request
 * (lib/notify-hierarchy.ts, policy in lib/notify-policy.ts).
 *
 * The database is an in-memory stand-in that answers the two queries the module
 * makes (user.findMany by role + active + managed region; user.findUnique with
 * managedRegions) the way Postgres would, so each case states who is told, not
 * how the module asked.
 */
import { describe, it, expect, vi } from 'vitest';
import { Role, type Prisma } from '@prisma/client';

const written = vi.hoisted(() => [] as Array<{ ids: string[]; kind: string; title: string; body: string; editId?: string; customerId?: string }>);
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));
// The real module, but for its one writer: supervisorWhoCanAct reads the fake db.
vi.mock('@/lib/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notifications')>()),
  notifyUsers: vi.fn(async (_db: unknown, ids: string[], data: { kind: string; title: string; body: string; editId?: string; customerId?: string }) => {
    if (ids.length) written.push({ ids, ...data });
  }),
}));

import {
  eligibleSupervisor,
  notifySalesmanRequest,
  regionAccountants,
  regionManagers,
  resolveRequestAudience,
} from '@/lib/notify-hierarchy';
import { FYI_POLICY } from '@/lib/notify-policy';

type U = { id: string; role: Role; isActive: boolean; regions: string[] };
const u = (id: string, role: Role, regions: string[] = [], isActive = true): U => ({ id, role, isActive, regions });

function fakeDb(users: U[]): Prisma.TransactionClient {
  return {
    user: {
      findMany: async ({ where }: { where: { role: Role; isActive: boolean; managedRegions: { some: { id: string } } } }) =>
        users
          .filter(
            (x) =>
              x.role === where.role &&
              x.isActive === where.isActive &&
              x.regions.includes(where.managedRegions.some.id)
          )
          .map((x) => ({ id: x.id })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const x = users.find((y) => y.id === where.id);
        return x ? { id: x.id, role: x.role, isActive: x.isActive, managedRegions: x.regions.map((id) => ({ id })) } : null;
      },
    },
  } as unknown as Prisma.TransactionClient;
}

// Region g1 (Muscat-like: two class Managers) and g2; one Accountant each; the
// org-wide roles hold every region on purpose, to prove role filters, not
// region filters, keep them out.
const ORG: U[] = [
  u('mgr-a', Role.MANAGER, ['g1']),
  u('mgr-b', Role.MANAGER, ['g1']),
  u('mgr-c', Role.MANAGER, ['g2']),
  u('mgr-off', Role.MANAGER, ['g1'], false),
  u('sup-1', Role.SUPERVISOR),
  u('sup-off', Role.SUPERVISOR, [], false),
  u('acc-1', Role.ACCOUNTANT, ['g1']),
  u('acc-2', Role.ACCOUNTANT, ['g2']),
  u('acc-off', Role.ACCOUNTANT, ['g1'], false),
  u('fm', Role.FINANCE_MANAGER, ['g1', 'g2']),
  u('gm', Role.GM, ['g1', 'g2']),
  u('stw', Role.STEWARD, ['g1', 'g2']),
  u('vw', Role.VIEWER, ['g1', 'g2']),
  u('sal-1', Role.SALESMAN, ['g1']),
  u('sal-2', Role.SALESMAN, ['g1']),
];
const db = fakeDb(ORG);
const NEVER = ['gm', 'stw', 'vw', 'sal-1', 'sal-2', 'fm'];

describe('region lookups', () => {
  it('select only active holders of the one role, in the one region', async () => {
    expect((await regionManagers(db, 'g1')).sort()).toEqual(['mgr-a', 'mgr-b']);
    expect(await regionAccountants(db, 'g1')).toEqual(['acc-1']);
    expect(await regionAccountants(db, 'g2')).toEqual(['acc-2']);
  });

  it('fail closed: no region means nobody', async () => {
    expect(await regionManagers(db, null)).toEqual([]);
    expect(await regionAccountants(db, '')).toEqual([]);
  });
});

describe('eligibleSupervisor: the one who can act on the Supervisor step', () => {
  it('an active Supervisor, or an active Manager over the region', async () => {
    expect(await eligibleSupervisor(db, 'sup-1', 'g1')).toBe('sup-1');
    expect(await eligibleSupervisor(db, 'mgr-a', 'g1')).toBe('mgr-a');
  });

  it('drops a disabled account, a wrong role, a Manager outside the region, and no supervisor', async () => {
    expect(await eligibleSupervisor(db, 'mgr-off', 'g1')).toBeNull();
    expect(await eligibleSupervisor(db, 'sup-off', 'g1')).toBeNull();
    expect(await eligibleSupervisor(db, 'mgr-c', 'g1')).toBeNull();
    for (const id of NEVER) expect(await eligibleSupervisor(db, id, 'g1'), id).toBeNull();
    expect(await eligibleSupervisor(db, null, 'g1')).toBeNull();
    expect(await eligibleSupervisor(db, 'ghost', 'g1')).toBeNull();
    expect(await eligibleSupervisor(db, 'mgr-a', null)).toBeNull();
  });

  it('a reactivation wants a Manager: a Supervisor is not one', async () => {
    expect(await eligibleSupervisor(db, 'sup-1', 'g1', { managerOnly: true })).toBeNull();
    expect(await eligibleSupervisor(db, 'mgr-a', 'g1', { managerOnly: true })).toBe('mgr-a');
  });
});

describe('resolveRequestAudience', () => {
  const sal = (supervisorId: string | null) => ({ id: 'sal-1', supervisorId });

  it('UPDATE and CREATE: nobody new must act (the caller told the supervisor); the Accountant is told for information', async () => {
    for (const event of ['UPDATE', 'CREATE'] as const) {
      const a = await resolveRequestAudience(db, { event, submitter: sal('mgr-a'), regionId: 'g1', alreadyTold: ['mgr-a'] });
      expect(a, event).toEqual({ mustAct: [], fyi: ['acc-1'] });
    }
  });

  it('CLOSE: the supervisor who can act; else every active Manager of the region', async () => {
    expect(await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal('mgr-a'), regionId: 'g1' })).toEqual({
      mustAct: ['mgr-a'],
      fyi: ['acc-1'],
    });
    expect(await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal('sup-1'), regionId: 'g1' })).toEqual({
      mustAct: ['sup-1'],
      fyi: ['acc-1'],
    });
    for (const sup of [null, 'mgr-off', 'mgr-c', 'gm', 'stw']) {
      const a = await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal(sup), regionId: 'g1' });
      expect(a.mustAct.sort(), String(sup)).toEqual(['mgr-a', 'mgr-b']);
    }
  });

  it('REACTIVATION: the supervisor only if he is a Manager over the region; else the region’s Managers', async () => {
    expect((await resolveRequestAudience(db, { event: 'REACTIVATION', submitter: sal('mgr-b'), regionId: 'g1' })).mustAct).toEqual(['mgr-b']);
    expect(
      (await resolveRequestAudience(db, { event: 'REACTIVATION', submitter: sal('sup-1'), regionId: 'g1' })).mustAct.sort()
    ).toEqual(['mgr-a', 'mgr-b']);
    expect(
      (await resolveRequestAudience(db, { event: 'REACTIVATION', submitter: sal('mgr-c'), regionId: 'g1' })).mustAct.sort()
    ).toEqual(['mgr-a', 'mgr-b']);
  });

  it('never selects the GM, a Steward, a Viewer, the Finance Manager or a salesman, for any event', async () => {
    for (const event of ['UPDATE', 'CREATE', 'CLOSE', 'REACTIVATION'] as const) {
      for (const sup of [null, 'gm', 'stw', 'vw', 'sal-2', 'fm', 'mgr-a']) {
        const a = await resolveRequestAudience(db, { event, submitter: sal(sup), regionId: 'g1' });
        for (const id of [...a.mustAct, ...a.fyi]) expect(NEVER, `${event}/${sup}: ${id}`).not.toContain(id);
      }
    }
  });

  it('nobody gets both an action and an FYI, and the submitter gets neither', async () => {
    // An Accountant who is somehow also told to act is not told for information too.
    const a = await resolveRequestAudience(db, { event: 'UPDATE', submitter: sal('mgr-a'), regionId: 'g1', alreadyTold: ['acc-1'] });
    expect(a.fyi).toEqual([]);
    // A Manager who also holds the submitting account is never asked to act on his own request.
    const self = await resolveRequestAudience(db, { event: 'CLOSE', submitter: { id: 'mgr-a', supervisorId: 'mgr-a' }, regionId: 'g1' });
    expect(self.mustAct).not.toContain('mgr-a');
  });

  it('fails closed with no region: no fallback Managers, no Accountant', async () => {
    expect(await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal(null), regionId: null })).toEqual({ mustAct: [], fyi: [] });
    // His supervisor is still a SUPERVISOR who can act without a region.
    expect(await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal('sup-1'), regionId: null })).toEqual({ mustAct: ['sup-1'], fyi: [] });
  });

  it('the defaults: Accountant FYI on every event, region-wide Manager FYI off', () => {
    expect(FYI_POLICY.accountants).toEqual({ UPDATE: true, CREATE: true, CLOSE: true, REACTIVATION: true });
    expect(FYI_POLICY.regionManagers).toBe(false);
  });
});

describe('the gap is logged (launch fix 2026-10-07)', () => {
  const sal = (supervisorId: string | null) => ({ id: 'sal-1', supervisorId });
  const gaps =() => warn.mock.calls.filter((c) => c[1] === 'notify.request.supervisor_cannot_act').map((c) => c[0]);
  it('a close or reactivation whose supervisor is missing or unusable is logged, ids and counts only', async () => {
    warn.mockClear();
    await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal(null), regionId: 'g1' });
    await resolveRequestAudience(db, { event: 'REACTIVATION', submitter: sal('mgr-off'), regionId: 'g1' });
    expect(gaps()).toEqual([
      { event: 'CLOSE', supervisorId: null, managersTold: 2 },
      { event: 'REACTIVATION', supervisorId: 'mgr-off', managersTold: 2 },
    ]);
  });

  it('a Supervisor on a reactivation is the design, not a gap; a supervisor who can act is not either', async () => {
    warn.mockClear();
    await resolveRequestAudience(db, { event: 'REACTIVATION', submitter: sal('sup-1'), regionId: 'g1' });
    await resolveRequestAudience(db, { event: 'CLOSE', submitter: sal('sup-1'), regionId: 'g1' });
    expect(gaps()).toEqual([]);
  });
});

describe('notifySalesmanRequest writes the rows', () => {
  const subject = { legalName: 'Al Noor Trading', nmwcCode: 'NMWC-000001' };

  it('a reactivation: REACTIVATION_REQUESTED to the Managers, REQUEST_FYI to the Accountant', async () => {
    written.length = 0;
    await notifySalesmanRequest(db, {
      event: 'REACTIVATION',
      submitter: { id: 'sal-1', supervisorId: 'sup-1' },
      regionId: 'g1',
      editId: 'e1',
      customerId: 'c1',
      subject,
    });
    expect(written.map((w) => [w.kind, [...w.ids].sort()])).toEqual([
      ['REACTIVATION_REQUESTED', ['mgr-a', 'mgr-b']],
      ['REQUEST_FYI', ['acc-1']],
    ]);
    for (const w of written) expect(w).toMatchObject({ editId: 'e1', customerId: 'c1' });
  });

  it('a close: EDIT_SUBMITTED to the supervisor; the text is the name and code only', async () => {
    written.length = 0;
    await notifySalesmanRequest(db, {
      event: 'CLOSE',
      submitter: { id: 'sal-1', supervisorId: 'mgr-a' },
      regionId: 'g1',
      editId: 'e2',
      customerId: 'c1',
      subject,
    });
    expect(written[0]).toMatchObject({ kind: 'EDIT_SUBMITTED', ids: ['mgr-a'] });
    expect(written[0]!.body).toBe('Al Noor Trading (NMWC-000001) — a salesman asked to close a branch.');
    expect(written[1]).toMatchObject({ kind: 'REQUEST_FYI', ids: ['acc-1'] });
  });

  it('a new-customer request has no code yet, and writes no must-act row of its own', async () => {
    written.length = 0;
    await notifySalesmanRequest(db, {
      event: 'CREATE',
      submitter: { id: 'sal-1', supervisorId: 'mgr-a' },
      regionId: 'g2',
      editId: 'e3',
      subject: { legalName: 'Bright Shop', nmwcCode: null },
      alreadyTold: ['mgr-a'],
    });
    expect(written).toEqual([
      {
        ids: ['acc-2'],
        kind: 'REQUEST_FYI',
        title: 'For your information: a salesman request',
        body: 'Bright Shop — new customer request submitted.',
        editId: 'e3',
        customerId: undefined,
      },
    ]);
  });
});
