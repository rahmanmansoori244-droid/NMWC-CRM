// @vitest-environment node
/**
 * services/duplicates.ts around the pure pairing (benchmark item 16): who may
 * run the detector, what it reads, and what "Mark distinct" writes. The rules
 * themselves are in duplicate-pairing.test.ts; the real queries against
 * Postgres are in tests/integration/duplicate-detection.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const h = vi.hoisted(() => ({
  user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } as { id: string; role: string; username: string } | null,
  customers: [] as Array<Record<string, unknown>>,
  pairRows: [] as Array<{ entityId: string }>,
  liveCount: 2,
  customerFindMany: vi.fn(),
  auditFindMany: vi.fn(),
  customerCount: vi.fn(),
  writeAudit: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: () => {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: '10.0.0.1', userAgent: 'ua' }),
  writeAudit: h.writeAudit,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customer: { findMany: h.customerFindMany, count: h.customerCount },
    auditLog: { findMany: h.auditFindMany },
  },
}));

import { findDuplicateCandidates, dismissDuplicateAction } from '@/services/duplicates';
import { ForbiddenError } from '@/lib/errors';

const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  nmwcCode: `N-${id}`,
  legalName: `Shop ${id}`,
  primaryPhone: null,
  primaryPhoneNorm: null,
  crNumber: '42',
  crNumberNorm: '42',
  completenessScore: 60,
  branches: [{ regionId: 'r1' }],
  _count: { branches: 2 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: 'stew', role: 'STEWARD', username: 'steward.x' };
  h.customers = [];
  h.pairRows = [];
  h.liveCount = 2;
  h.customerFindMany.mockImplementation(async () => h.customers);
  h.auditFindMany.mockImplementation(async () => h.pairRows);
  h.customerCount.mockImplementation(async () => h.liveCount);
});

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe('findDuplicateCandidates', () => {
  it.each([
    ['MANAGER'],
    ['SUPERVISOR'],
    ['SALESMAN'],
    ['VIEWER'],
    ['ACCOUNTANT'],
    ['FINANCE_MANAGER'],
    ['GM'],
  ])('refuses a %s, before reading anything', async (role) => {
    h.user = { id: 'u', role, username: 'u' };
    await expect(findDuplicateCandidates(50)).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.customerFindMany).not.toHaveBeenCalled();
    expect(h.auditFindMany).not.toHaveBeenCalled();
  });

  it('refuses no session', async () => {
    h.user = null;
    await expect(findDuplicateCandidates(50)).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.customerFindMany).not.toHaveBeenCalled();
  });

  it('reads live customers in code order, with the first live branch by code and a count of live branches', async () => {
    await findDuplicateCandidates(50);
    expect(h.customerFindMany).toHaveBeenCalledTimes(1);
    const args = h.customerFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.orderBy).toEqual({ nmwcCode: 'asc' });
    expect(args.select.branches).toEqual({
      where: { deletedAt: null },
      orderBy: { branchCode: 'asc' },
      select: { regionId: true },
      take: 1,
    });
    expect(args.select._count).toEqual({ select: { branches: { where: { deletedAt: null } } } });
    // The rules compare the stored normalized columns.
    expect(args.select).toMatchObject({ crNumberNorm: true, primaryPhoneNorm: true, legalName: true });
    expect(h.auditFindMany).toHaveBeenCalledWith({
      where: { entityType: 'CustomerPair' },
      select: { entityId: true },
    });
  });

  it('maps the rows the way the rules expect, and honours dismissals', async () => {
    h.customers = [customer('a'), customer('b'), customer('c', { branches: [], _count: { branches: 0 } })];
    h.pairRows = [{ entityId: 'b|a' }];
    const r = await findDuplicateCandidates(50);
    expect(r.total).toBe(2);
    expect(r.pairs.map((p) => `${p.a.id}${p.b.id}`)).toEqual(['ac', 'bc']);
    expect(r.pairs[0].a.branchCount).toBe(2);
    expect(r.pairs[0].b.branchCount).toBe(0);
  });

  it('passes the limit through', async () => {
    h.customers = ['a', 'b', 'c', 'd'].map((id) => customer(id));
    const r = await findDuplicateCandidates(2);
    expect(r.pairs).toHaveLength(2);
    expect(r.total).toBe(6);
  });

  it('uses the first branch it was given for the region', async () => {
    const same = { legalName: 'X', primaryPhoneNorm: '96899758980', crNumber: null, crNumberNorm: null };
    h.customers = [
      customer('a', { ...same, branches: [{ regionId: 'r1' }] }),
      customer('b', { ...same, branches: [{ regionId: 'r1' }] }),
      customer('c', { ...same, branches: [{ regionId: 'r2' }] }),
    ];
    const r = await findDuplicateCandidates(50);
    expect(r.pairs.map((p) => `${p.a.id}${p.b.id}:${p.reason}`)).toEqual(['ab:EXACT_TRIPLE']);
  });
});

describe('dismissDuplicateAction — "Mark distinct"', () => {
  it('writes exactly one CustomerPair row through writeAudit, then refreshes the page', async () => {
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res.ok).toBe(true);
    expect(h.customerCount).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, deletedAt: null },
    });
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledWith(
      null,
      { actorId: 'stew', ip: '10.0.0.1', userAgent: 'ua' },
      {
        action: 'UPDATE',
        entityType: 'CustomerPair',
        entityId: 'a|b',
        reason: 'Deemed distinct by steward',
      }
    );
    expect(h.revalidatePath).toHaveBeenCalledWith('/duplicates');
  });

  it.each([['MANAGER'], ['VIEWER'], ['SALESMAN'], ['GM']])('refuses a %s and writes nothing', async (role) => {
    h.user = { id: 'u', role, username: 'u' };
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing id', { aId: 'a' }],
    ['an empty id', { aId: '', bId: 'b' }],
    ['the same customer twice', { aId: 'a', bId: 'a' }],
    ['an id holding the separator', { aId: 'x|y', bId: 'z' }],
  ])('refuses %s and writes nothing', async (_label, entries) => {
    const res = await dismissDuplicateAction(fd(entries as Record<string, string>));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a pair where a customer is gone (merged or archived) and writes nothing', async () => {
    h.liveCount = 1;
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('what it writes is what the detector reads back as a dismissal', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    const written = h.writeAudit.mock.calls[0][2] as { entityType: string; entityId: string };
    h.customers = [customer('a'), customer('b')];
    h.pairRows = [{ entityId: written.entityId }];
    const r = await findDuplicateCandidates(50);
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
    expect(h.auditFindMany.mock.calls[0][0].where.entityType).toBe(written.entityType);
  });
});

describe('wiring (comment-stripped source)', () => {
  const svc = stripComments(readFileSync('services/duplicates.ts', 'utf8'));
  const body = (name: string) => {
    const at = svc.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const next = svc.indexOf('\nexport async function', at + 1);
    return svc.slice(at, next === -1 ? undefined : next);
  };

  it('the detector checks the role before its first query and hands the rows to the tested rules', () => {
    const b = body('findDuplicateCandidates');
    expect(b.indexOf('requireSteward(')).toBeGreaterThan(-1);
    expect(b.indexOf('requireSteward(')).toBeLessThan(b.indexOf('prisma.'));
    expect(b).toContain('pairCandidates(');
    expect(b).toContain('parseDismissed(');
  });

  it('the page asks before a permanent "Mark distinct", and no longer promises checks that do not exist', () => {
    const form = stripComments(readFileSync('app/(app)/duplicates/MergeForm.tsx', 'utf8'));
    const dismiss = form.slice(form.indexOf('function dismiss('), form.indexOf('return (', form.indexOf('function dismiss(')));
    expect(dismiss.indexOf('confirm(')).toBeGreaterThan(-1);
    expect(dismiss.indexOf('confirm(')).toBeLessThan(dismiss.indexOf('dismissDuplicateAction('));
    const page = stripComments(readFileSync('app/(app)/duplicates/page.tsx', 'utf8'));
    expect(page).not.toMatch(/fuzzy/i);
    expect(page).toContain('duplicatesSubtitle(');
  });
});
