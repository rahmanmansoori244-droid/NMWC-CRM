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
