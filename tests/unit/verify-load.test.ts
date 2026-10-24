// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const files = vi.hoisted(() => ({
  exists: vi.fn(),
  read: vi.fn(),
}));
vi.mock('node:fs', () => ({ existsSync: files.exists, readFileSync: files.read }));

import { loadChecks, loadExpectations, runChecks } from '../../scripts/ops/verify-load';

const env = { GOLIVE_DIR: '/synthetic-fixture' };
beforeEach(() => {
  vi.clearAllMocks();
  files.exists.mockReturnValue(true);
  files.read.mockReturnValue(JSON.stringify({ branchRows: 500, branchesWithVisitDay: 200 }));
});
afterEach(() => vi.restoreAllMocks());

describe('verify-load expected counts', () => {
  it('uses the original manifest by default', () => {
    expect(loadExpectations([], env)).toEqual({ branches: 500, visitDays: 200 });
  });

  it('overrides the branch expectation while retaining the manifest visit-day expectation', () => {
    expect(loadExpectations(['--expected-branches', '400'], env)).toEqual({ branches: 400, visitDays: 200 });
  });

  it('accepts a changed visit-day expectation independently', () => {
    expect(loadExpectations(['--expected-visit-days', '250'], env)).toEqual({ branches: 500, visitDays: 250 });
  });

  it('needs no manifest access when both approved counts are supplied', () => {
    expect(loadExpectations(['--expected-branches', '400', '--expected-visit-days', '0'], env))
      .toEqual({ branches: 400, visitDays: 0 });
    expect(files.exists).not.toHaveBeenCalled();
    expect(files.read).not.toHaveBeenCalled();
  });

  it.each([
    ['--expected-branches'], ['--expected-branches', '-1'], ['--expected-branches', '1.5'],
    ['--expected-branches', '1e3'], ['--expected-branches', '9007199254740992'],
    ['--expected-branches', '0'], ['--expected-visit-days', '501'],
    ['--expected-branch', '400'], ['--expected-branches', '400', '--expected-branches', '400'],
  ])('refuses invalid arguments %j', (...args) => {
    expect(() => loadExpectations(args, env)).toThrow();
  });

  it('accepts --expect-host, which the production guard reads, anywhere and once', () => {
    // Data audit 2026-10-10: verify:load runs on production, and the shared guard
    // refuses production unless the command names it. Rejecting the flag as unknown
    // would have made the check impossible to run where it matters.
    expect(loadExpectations(['--expect-host', 'ep-sweet-haze'], env)).toEqual({ branches: 500, visitDays: 200 });
    expect(
      loadExpectations(['--expected-branches', '400', '--expect-host', 'ep-sweet-haze', '--expected-visit-days', '0'], env)
    ).toEqual({ branches: 400, visitDays: 0 });
  });

  it.each([
    [['--expect-host']],
    [['--expect-host', '--expected-branches', '400']],
    [['--expect-host', 'ep-sweet-haze', '--expect-host', 'ep-sweet-haze']],
  ])('refuses a malformed --expect-host %j', (args) => {
    expect(() => loadExpectations(args, env)).toThrow();
  });

  it('refuses a missing manifest instead of reporting an unverified pass', () => {
    files.exists.mockReturnValue(false);
    expect(() => loadExpectations([], env)).toThrow('supply both --expected-branches');
  });

  it.each(['{}', 'null', '{', '{"branchRows":"500","branchesWithVisitDay":200}',
    '{"branchRows":500,"branchesWithVisitDay":-1}'])('refuses unusable manifest %s', (manifest) => {
    files.read.mockReturnValue(manifest);
    expect(() => loadExpectations([], env)).toThrow();
  });
});

function countCheck(branches: number, visitDays: number, args: string[] = []) {
  const db = {
    branch: { count: vi.fn(async ({ where }: { where: { dayOfVisit?: unknown } }) => where.dayOfVisit ? visitDays : branches) },
    importBatch: { findFirst: vi.fn(async () => null) },
  };
  const check = loadChecks(db as unknown as PrismaClient, loadExpectations(args, env))
    .find((c) => c.name === 'live branch and visit-day counts match expectations')!;
  return { check, db };
}

describe('verify-load count gate and exit status', () => {
  it('fails a partial load even when the visit-day total matches', async () => {
    const { check } = countCheck(400, 200);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runChecks([check])).toBe(1);
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('FAIL');
    expect(text).toContain('PARTIAL load: 400 live branches (expected 500); 200 carry a visit day (expected 200)');
  });

  it('passes an approved post-cleanup count and still compares visit days', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { check } = countCheck(400, 200, ['--expected-branches', '400']);
    expect(await runChecks([check])).toBe(0);
    const missingDay = countCheck(400, 199, ['--expected-branches', '400']);
    expect(await runChecks([missingDay.check])).toBe(1);
  });

  it('reports both mismatches for a partial load instead of skipping visit days', async () => {
    const { check, db } = countCheck(400, 190);
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('400 live branches (expected 500); 190 carry a visit day (expected 200)');
    expect(db.importBatch.findFirst).toHaveBeenCalledOnce();
  });

  it('fails excess live branches as an unexpected count', async () => {
    expect((await countCheck(501, 200).check.run()).ok).toBe(false);
  });

  it('fails excess visit days without describing a negative number as missing', async () => {
    const result = await countCheck(500, 201).check.run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('201 carry a visit day (expected 200)');
    expect(result.detail).not.toContain('went missing');
  });

  it('passes when the unchanged original manifest matches', async () => {
    expect((await countCheck(500, 200).check.run()).ok).toBe(true);
  });

  it('fails query errors without printing their raw message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { check, db } = countCheck(500, 200);
    db.branch.count.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_QUERY_DETAIL'), { code: 'P1001' }));
    expect(await runChecks([check])).toBe(1);
    const text = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls].flat().join('\n');
    expect(text).toContain('P1001');
    expect(text).not.toContain('PRIVATE_QUERY_DETAIL');
  });
});

describe('verify-load usable supervisor-step approvers (OCT-06)', () => {
  type Candidate = {
    id: string; username: string; role: string; isActive: boolean;
    managedRegions: { id: string }[];
  };
  const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
    id: 'approver', username: 'synthetic.approver', role: 'MANAGER', isActive: true,
    managedRegions: [{ id: 'region-a' }], ...overrides,
  });

  // Return only requested fields, like Prisma: omitting isActive from the
  // query must not be hidden by a fixture that returns extra fields.
  function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(select).map(([key, selection]) => {
      const value = row[key];
      if (selection === true || value == null) return [key, value];
      const nested = (selection as { select: Record<string, unknown> }).select;
      return [key, Array.isArray(value)
        ? value.map((item) => project(item, nested))
        : project(value as Record<string, unknown>, nested)];
    }));
  }

  async function coverage(supervisor: Candidate | null, managers: Candidate[] = [], hasRoute = true, empty = false) {
    const salesman = {
      id: 'salesman', username: 'synthetic.salesman', supervisorId: supervisor?.id ?? null,
      ownedRoute: hasRoute ? { code: 'SYNTHETIC', regionId: 'region-a' } : null,
      supervisor,
    };
    const db = { user: { findMany: vi.fn(async ({ where, select }: {
      where: { role: string; isActive?: boolean }; select: Record<string, unknown>;
    }) => {
      const rows = where.role === 'SALESMAN' ? (empty ? [] : [salesman])
        : managers.filter((m) => m.role === where.role && (where.isActive === undefined || m.isActive === where.isActive));
      return rows.map((row) => project(row, select));
    }) } };
    const check = loadChecks(db as unknown as PrismaClient, { branches: 500, visitDays: 200 })
      .find((c) => c.name === 'every salesman has an approver who can actually act')!;
    return check.run();
  }

  it.each(['MANAGER', 'SUPERVISOR'])('rejects an inactive assigned %s even with an active manager in another region', async (role) => {
    const assigned = candidate({ role, isActive: false });
    const elsewhere = candidate({ id: 'elsewhere', managedRegions: [{ id: 'region-b' }] });
    expect((await coverage(assigned, [elsewhere])).ok).toBe(false);
  });

  it.each(['ACCOUNTANT', 'STEWARD', 'SALESMAN'])('rejects assigned %s despite matching managed regions', async (role) => {
    expect((await coverage(candidate({ role }))).ok).toBe(false);
  });

  it('rejects a region without any eligible manager or assigned supervisor', async () => {
    const elsewhere = candidate({ managedRegions: [{ id: 'region-b' }] });
    expect((await coverage(elsewhere, [elsewhere])).ok).toBe(false);
  });

  it.each(['MANAGER', 'SUPERVISOR'])('accepts an active eligible assigned %s', async (role) => {
    expect((await coverage(candidate({ role }))).ok).toBe(true);
  });

  it.each([null, 'inactive', 'foreign'])('accepts the active regional Manager fallback when assignment is %s', async (assignment) => {
    const assigned = assignment === null ? null : candidate({
      id: 'assigned', isActive: assignment !== 'inactive', managedRegions: [{ id: 'region-b' }],
    });
    expect((await coverage(assigned, [candidate()])).ok).toBe(true);
  });

  it.each([
    candidate({ username: 'admin' }),
    candidate({ role: 'SUPERVISOR', username: 'supervisor.synthetic' }),
  ])('rejects an assigned demo-denied account $username', async (assigned) => {
    expect((await coverage(assigned)).ok).toBe(false);
  });

  it('does not use an inactive or demo-denied Manager fallback', async () => {
    expect((await coverage(null, [candidate({ isActive: false }), candidate({ username: 'admin' })])).ok).toBe(false);
  });

  it('fails closed for no active salesmen or no route for Manager coverage', async () => {
    expect((await coverage(null, [candidate()], true, true)).ok).toBe(false);
    expect((await coverage(candidate(), [candidate()], false)).ok).toBe(false);
  });
});

describe('verify-load: the org-wide approvers and the regions it counts (launch fix 2026-10-07)', () => {
  type Holder = { username: string; role: string; isActive: boolean; mustChangePassword: boolean };
  const holder = (role: string, overrides: Partial<Holder> = {}): Holder => ({
    username: `synthetic.${role.toLowerCase()}`, role, isActive: true, mustChangePassword: false, ...overrides,
  });

  function check(name: string, users: Holder[]) {
    const db = { user: { findMany: vi.fn(async ({ where, select }: {
      where: { role: string; isActive: boolean }; select: Record<string, unknown>;
    }) => users
      .filter((u) => u.role === where.role && u.isActive === where.isActive)
      .map((u) => Object.fromEntries(Object.keys(select).map((k) => [k, u[k as keyof Holder]])))) } };
    const c = loadChecks(db as unknown as PrismaClient, { branches: 500, visitDays: 200 }).find((x) => x.name === name);
    expect(c, name).toBeDefined();
    return c!.run();
  }
  const FM = 'an active Finance Manager past the password change';
  const SD = 'an active Sales Director past the password change';
  const GM = 'an active GM past the password change';

  it('passes with one active Finance Manager and one GM who have changed the hand-out password', async () => {
    const org = [holder('FINANCE_MANAGER'), holder('GM')];
    expect((await check(FM, org)).ok).toBe(true);
    expect((await check(GM, org)).ok).toBe(true);
  });

  it('fails with none, with only disabled ones, and with only demo-denied ones', async () => {
    for (const org of [[], [holder('FINANCE_MANAGER', { isActive: false }), holder('GM', { isActive: false })],
      [holder('FINANCE_MANAGER', { username: 'admin' }), holder('GM', { username: 'admin' })]]) {
      const fm = await check(FM, org);
      expect(fm.ok).toBe(false);
      expect(fm.detail).toContain('no active FINANCE_MANAGER');
      expect((await check(GM, org)).ok).toBe(false);
    }
  });

  it('checks the Sales Director like the GM: every CREDIT request has his GLOBAL step (owner decisions 2026-10-11)', async () => {
    expect((await check(SD, [holder('SALES_DIRECTOR')])).ok).toBe(true);
    const none = await check(SD, [holder('GM'), holder('FINANCE_MANAGER')]);
    expect(none.ok).toBe(false);
    expect(none.detail).toContain('no active SALES_DIRECTOR');
    expect((await check(SD, [holder('SALES_DIRECTOR', { isActive: false })])).ok).toBe(false);
    expect((await check(SD, [holder('SALES_DIRECTOR', { username: 'admin' })])).ok).toBe(false);
    const handOut = await check(SD, [holder('SALES_DIRECTOR', { mustChangePassword: true })]);
    expect(handOut.ok).toBe(false);
    expect(handOut.detail).toContain('none has changed the hand-out password');
  });

  it('fails, and says why, while the only one still has the hand-out password', async () => {
    const r = await check(GM, [holder('GM', { mustChangePassword: true })]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('none has changed the hand-out password');
    expect(r.note).toMatch(/signed in and changed the password/);
  });

  it('counts accountant coverage over active regions only: an inactive test region is not reported', async () => {
    const regions = [
      ...['MCT', 'KHB', 'NZW', 'SLL', 'AWF', 'DQM', 'BRK'].map((code) => ({ code, isActive: true, managers: [{ username: `acc.${code}` }] })),
      { code: 'ZZTEST', isActive: false, managers: [] },
    ];
    const db = { region: { findMany: vi.fn(async ({ where }: { where: { code: { not: string }; isActive?: boolean } }) =>
      regions.filter((r) => r.code !== where.code.not && (where.isActive === undefined || r.isActive === where.isActive))
        .map(({ code, managers }) => ({ code, managers }))) } };
    const c = loadChecks(db as unknown as PrismaClient, { branches: 500, visitDays: 200 })
      .find((x) => x.name === 'every region has an active accountant')!;
    const r = await c.run();
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).not.toContain('ZZTEST');
  });

  it('counts unowned routes among active routes of active regions only (the ZZTEST route is neither)', async () => {
    const sql: string[] = [];
    const db = {
      user: { count: vi.fn(async () => 0) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        sql.push(strings.join('?').replace(/\s+/g, ' '));
        return [{ n: 0n }];
      }),
    };
    const c = loadChecks(db as unknown as PrismaClient, { branches: 500, visitDays: 200 })
      .find((x) => x.name === 'every salesman owns a route, and no route has two owners')!;
    const r = await c.run();
    expect(r.ok).toBe(true);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('JOIN "Region" g ON g.id = r."regionId" AND g."isActive"');
    // Gap 30: and never a flagged test route or region.
    expect(sql[0]).toContain('AND g."isActive" AND NOT g."isTest"');
    expect(sql[0]).toMatch(/WHERE r\."isActive" AND NOT r\."isTest" AND NOT EXISTS/);
  });
});

describe('verify-load: gap 30, the test records are left out of every count', () => {
  it('says how many it left out, as information that never fails', async () => {
    const count = vi.fn(async () => 1);
    const db = { customer: { count }, branch: { count }, user: { count }, route: { count }, region: { count } };
    const c = loadChecks(db as unknown as PrismaClient, { branches: 500, visitDays: 200 })[0]!;
    expect(c.name).toBe('test records left out of these counts');
    const r = await c.run();
    expect(r).toMatchObject({ ok: true, detail: '1 customer(s), 1 branch(es), 1 account(s), 1 route(s), 1 region(s)' });
  });

  it('every customer, branch and account count names the flag', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const src = real.readFileSync('scripts/ops/verify-load.ts', 'utf8');
    const checks = src.slice(src.indexOf('export const loadChecks'));
    const plain = [...checks.matchAll(/prisma\.(customer|user)\.(count|findMany)\(\{\s*where: \{([^}]*)/g)];
    expect(plain.length).toBeGreaterThan(10);
    for (const m of plain) expect(m[3], m[0]).toContain('isTest: false');
    // The whole where, nested braces and all: up to the call's closing `})`.
    const shops = [...checks.matchAll(/prisma\.branch\.count\(\{\s*where: \{([\s\S]*?)\},?\s*\}\)/g)];
    expect(shops.length).toBe(2);
    for (const m of shops) expect(m[1], m[0]).toContain('...REAL_BRANCH');
    const raw = [...checks.matchAll(/FROM "(Customer|Branch)"[^`]*`/g)];
    expect(raw.length).toBeGreaterThan(3);
    for (const m of raw) expect(m[0], m[0]).toMatch(/isTest|REAL_B/);
  });
});
