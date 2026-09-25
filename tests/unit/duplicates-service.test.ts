// @vitest-environment node
/**
 * services/duplicates.ts around the pure pairing (benchmark item 16): who may
 * run the detector, what it reads, what "Mark distinct" writes, and the undo
 * the owner decided on 2026-09-25. The rules themselves are in
 * duplicate-pairing.test.ts; the real queries against Postgres are in
 * tests/integration/duplicate-detection.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { signalHash } from '@/lib/duplicate-pairing';

type PairRow = { entityId: string; after: unknown; at: Date; actor?: { fullName: string; username: string } };

const h = vi.hoisted(() => ({
  user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } as { id: string; role: string; username: string } | null,
  customers: [] as Array<Record<string, unknown>>,
  pairRows: [] as Array<{ entityId: string; after: unknown; at: Date; actor?: { fullName: string; username: string } }>,
  customerFindMany: vi.fn(),
  auditFindMany: vi.fn(),
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
    customer: { findMany: h.customerFindMany },
    auditLog: { findMany: h.auditFindMany },
  },
}));

import {
  findDuplicateCandidates,
  dismissDuplicateAction,
  undoDismissDuplicateAction,
} from '@/services/duplicates';
import { ForbiddenError } from '@/lib/errors';

const PHONE = '+96899758980';
const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  nmwcCode: `N-${id}`,
  legalName: `Shop ${id}`,
  primaryPhone: null,
  primaryPhoneNorm: null,
  crNumber: '42',
  crNumberNorm: '42',
  completenessScore: 60,
  branches: [{ regionId: 'r1' }, { regionId: 'r1' }],
  ...over,
});

/** A tiny stand-in for the two queries, honouring the where clauses the service uses. */
function customersMatching(args: { where: { deletedAt?: null; id?: { in: string[] } } }) {
  const ids = args.where.id?.in;
  return h.customers.filter((c) => !ids || ids.includes(c.id as string));
}
function pairRowsMatching(args: { where: { entityType: string; entityId?: { in: string[] } } }): PairRow[] {
  const ids = args.where.entityId?.in;
  return h.pairRows.filter((r) => !ids || ids.includes(r.entityId));
}

let clock = 0;
beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  h.user = { id: 'stew', role: 'STEWARD', username: 'steward.x' };
  h.customers = [];
  h.pairRows = [];
  h.customerFindMany.mockImplementation(async (args) => customersMatching(args));
  h.auditFindMany.mockImplementation(async (args) => pairRowsMatching(args));
  // What writeAudit writes is what the next read sees, in order — the ledger.
  h.writeAudit.mockImplementation(async (_tx, env, p: { entityId: string; after?: unknown }) => {
    h.pairRows.push({
      entityId: p.entityId,
      after: p.after ?? null,
      at: new Date(Date.UTC(2026, 8, 25, 8, 0, clock++)),
      actor: { fullName: `Name of ${env.actorId}`, username: env.actorId },
    });
  });
});

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const scanKeys = async () =>
  (await findDuplicateCandidates(50)).pairs.map((p) => `${p.a.id}${p.b.id}:${p.reason}`);

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

  it('reads live customers in code order with EVERY live branch region, and the pair history in written order', async () => {
    await findDuplicateCandidates(50);
    expect(h.customerFindMany).toHaveBeenCalledTimes(1);
    const args = h.customerFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.orderBy).toEqual({ nmwcCode: 'asc' });
    // No `take`: the triple matches on any shared region, not the first branch's.
    expect(args.select.branches).toEqual({ where: { deletedAt: null }, select: { regionId: true } });
    // The rules compare the stored normalized columns.
    expect(args.select).toMatchObject({ crNumberNorm: true, primaryPhoneNorm: true, legalName: true });
    expect(h.auditFindMany).toHaveBeenCalledWith({
      where: { entityType: 'CustomerPair' },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      select: {
        entityId: true,
        after: true,
        at: true,
        actor: { select: { fullName: true, username: true } },
      },
    });
  });

  it('maps the rows the way the rules expect: branch count and every region', async () => {
    h.customers = [
      customer('a'),
      customer('b', { branches: [{ regionId: 'r2' }, { regionId: 'r1' }, { regionId: 'r2' }] }),
      customer('c', { branches: [] }),
    ];
    const r = await findDuplicateCandidates(50);
    expect(r.total).toBe(3);
    const ab = r.pairs.find((p) => p.a.id === 'a' && p.b.id === 'b')!;
    expect(ab.a.branchCount).toBe(2);
    expect(ab.b.branchCount).toBe(3);
    expect(r.pairs.find((p) => p.b.id === 'c')!.b.branchCount).toBe(0);
  });

  it('pairs a multi-branch twin through its second region', async () => {
    const same = { legalName: 'X', primaryPhoneNorm: PHONE, crNumber: null, crNumberNorm: null };
    h.customers = [
      customer('a', { ...same, branches: [{ regionId: 'r2' }, { regionId: 'r1' }] }),
      customer('b', { ...same, branches: [{ regionId: 'r1' }] }),
      customer('c', { ...same, branches: [{ regionId: 'r3' }] }),
    ];
    expect(await scanKeys()).toEqual(['ab:EXACT_TRIPLE']);
  });

  it('passes the limit through', async () => {
    h.customers = ['a', 'b', 'c', 'd'].map((id) => customer(id));
    const r = await findDuplicateCandidates(2);
    expect(r.pairs).toHaveLength(2);
    expect(r.total).toBe(6);
  });

  it('honours dismissals, legacy rows included, and names who marked the pair', async () => {
    h.customers = [customer('a'), customer('b'), customer('c')];
    const at = new Date('2026-09-01T06:00:00Z');
    h.pairRows = [{ entityId: 'b|a', after: null, at, actor: { fullName: 'Aisha B', username: 'aisha' } }];
    const r = await findDuplicateCandidates(50);
    expect(r.total).toBe(2);
    expect(r.pairs.map((p) => `${p.a.id}${p.b.id}`)).toEqual(['ac', 'bc']);
    expect(r.markedDistinct).toEqual([
      expect.objectContaining({ at, by: 'Aisha B', a: expect.objectContaining({ id: 'a' }), b: expect.objectContaining({ id: 'b' }) }),
    ]);
  });
});

describe('dismissDuplicateAction — "Mark distinct"', () => {
  beforeEach(() => {
    h.customers = [
      customer('a', { crNumberNorm: 'CR-7', legalName: 'Al Noor', primaryPhoneNorm: PHONE }),
      customer('b', { crNumberNorm: 'CR-7', legalName: 'AL  NOOR', primaryPhoneNorm: PHONE }),
    ];
  });

  it("writes exactly one CustomerPair row, with the pair's current match signals as digests", async () => {
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res.ok).toBe(true);
    expect(h.customerFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, deletedAt: null },
      select: {
        id: true,
        legalName: true,
        primaryPhoneNorm: true,
        crNumberNorm: true,
        branches: { where: { deletedAt: null }, select: { regionId: true } },
      },
    });
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledWith(
      null,
      { actorId: 'stew', ip: '10.0.0.1', userAgent: 'ua' },
      {
        action: 'UPDATE',
        entityType: 'CustomerPair',
        entityId: 'a|b',
        after: { signals: [`cr:${signalHash('CR-7')}`, `triple:${signalHash(`al noor|${PHONE}`)}`] },
        reason: 'Deemed distinct by steward',
      }
    );
    expect(h.revalidatePath).toHaveBeenCalledWith('/duplicates');
  });

  it('keeps the CR, the phone and the name out of the append-only ledger', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    const written = JSON.stringify(h.writeAudit.mock.calls[0][2]);
    expect(written).not.toContain('CR-7');
    expect(written).not.toContain('99758980');
    expect(written.toLowerCase()).not.toContain('noor');
  });

  it('refuses a pair that matches no rule now, and writes nothing', async () => {
    h.customers = [customer('a', { crNumberNorm: '1' }), customer('b', { crNumberNorm: '2' })];
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res)).toMatch(/not a suspected pair/);
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([['MANAGER'], ['VIEWER'], ['SALESMAN'], ['GM']])('refuses a %s and writes nothing', async (role) => {
    h.user = { id: 'u', role, username: 'u' };
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.customerFindMany).not.toHaveBeenCalled();
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
    h.customers = [h.customers[0]];
    const res = await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('what it writes is what the detector reads back as a dismissal', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    const r = await findDuplicateCandidates(50);
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.markedDistinct.map((m) => [m.a.id, m.b.id, m.by])).toEqual([['a', 'b', 'Name of stew']]);
    expect(h.auditFindMany.mock.calls[0][0].where.entityType).toBe(
      (h.writeAudit.mock.calls[0][2] as { entityType: string }).entityType
    );
  });

  it('the pair returns when the CR changes to another shared value — and not when only the display fields change', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    h.customers = h.customers.map((c) => ({ ...c, completenessScore: 99, primaryPhone: '9975 8980' }));
    expect(await scanKeys()).toEqual([]);
    h.customers = h.customers.map((c) => ({ ...c, crNumberNorm: 'CR-8' }));
    expect(await scanKeys()).toEqual(['ab:CR']);
    // Marked distinct again on the new match, it is hidden again.
    expect((await dismissDuplicateAction(fd({ aId: 'b', bId: 'a' }))).ok).toBe(true);
    expect(await scanKeys()).toEqual([]);
  });
});

describe('undoDismissDuplicateAction — undo "Mark distinct"', () => {
  beforeEach(() => {
    h.customers = [customer('a'), customer('b'), customer('c')];
  });

  it('writes one undo row through writeAudit and the pair is back', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(await scanKeys()).toEqual(['ac:CR', 'bc:CR']);
    h.writeAudit.mockClear();

    const res = await undoDismissDuplicateAction(fd({ aId: 'b', bId: 'a' }));
    expect(res.ok).toBe(true);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledWith(
      null,
      { actorId: 'stew', ip: '10.0.0.1', userAgent: 'ua' },
      {
        action: 'UPDATE',
        entityType: 'CustomerPair',
        entityId: 'b|a',
        after: { undo: true },
        reason: 'Steward undid "Mark distinct": the pair is a suspected duplicate again',
      }
    );
    expect(h.revalidatePath).toHaveBeenCalledWith('/duplicates');
    expect(await scanKeys()).toEqual(['ab:CR', 'ac:CR', 'bc:CR']);
  });

  it("reads only this pair's history, in both orders, in written order", async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    h.auditFindMany.mockClear();
    await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(h.auditFindMany).toHaveBeenCalledWith({
      where: { entityType: 'CustomerPair', entityId: { in: ['a|b', 'b|a'] } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      select: { entityId: true, after: true, at: true },
    });
  });

  it('then "Mark distinct" again hides it again — the latest row wins', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    await dismissDuplicateAction(fd({ aId: 'b', bId: 'a' }));
    expect(await scanKeys()).toEqual(['ac:CR', 'bc:CR']);
  });

  it('undoes a legacy dismissal (written before signals were stored)', async () => {
    h.pairRows = [{ entityId: 'a|b', after: null, at: new Date('2026-06-01T00:00:00Z') }];
    const res = await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res.ok).toBe(true);
    expect(await scanKeys()).toEqual(['ab:CR', 'ac:CR', 'bc:CR']);
  });

  it.each([
    ['never dismissed', async () => {}],
    [
      'already undone',
      async () => {
        await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
        await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
      },
    ],
    [
      'dismissed, but the dismissal has lapsed (the CR changed to another shared value)',
      async () => {
        await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
        h.customers = h.customers.map((c) => ({ ...c, crNumberNorm: '43' }));
      },
    ],
    [
      'dismissed, but the pair matches nothing now',
      async () => {
        await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
        h.customers = h.customers.map((c) => ({ ...c, crNumberNorm: `${c.id}-own` }));
      },
    ],
    [
      'only malformed rows',
      async () => {
        h.pairRows = [{ entityId: 'a|b', after: { signals: 'x' }, at: new Date() }];
      },
    ],
  ])('refuses when the pair is not currently dismissed (%s), and writes nothing', async (_label, setup) => {
    await setup();
    const before = h.writeAudit.mock.calls.length;
    const res = await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res)).toMatch(/not marked distinct/);
    expect(h.writeAudit.mock.calls.length).toBe(before);
  });

  it.each([['MANAGER'], ['VIEWER'], ['SALESMAN'], ['GM'], ['SUPERVISOR']])(
    'refuses a %s before reading anything, and writes nothing',
    async (role) => {
      h.user = { id: 'u', role, username: 'u' };
      const res = await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
      expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(h.customerFindMany).not.toHaveBeenCalled();
      expect(h.auditFindMany).not.toHaveBeenCalled();
      expect(h.writeAudit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a missing id', { aId: 'a' }],
    ['the same customer twice', { aId: 'a', bId: 'a' }],
    ['an id holding the separator', { aId: 'a|b', bId: 'c' }],
  ])('refuses %s and writes nothing', async (_label, entries) => {
    const res = await undoDismissDuplicateAction(fd(entries as Record<string, string>));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses a pair where a customer is gone, and writes nothing', async () => {
    await dismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    h.customers = h.customers.filter((c) => c.id !== 'b');
    const before = h.writeAudit.mock.calls.length;
    const res = await undoDismissDuplicateAction(fd({ aId: 'a', bId: 'b' }));
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.writeAudit.mock.calls.length).toBe(before);
  });
});

describe('wiring (comment-stripped source)', () => {
  const svc = stripComments(readFileSync('services/duplicates.ts', 'utf8'));
  const body = (name: string) => {
    const at = svc.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const next = svc.indexOf('\nexport async function', at + 1);
    const nextCore = svc.indexOf('\nasync function', at + 1);
    const ends = [next, nextCore].filter((i) => i > -1);
    return svc.slice(at, ends.length ? Math.min(...ends) : undefined);
  };

  it('the detector checks the role before its first query and hands the rows to the tested rules', () => {
    const b = body('findDuplicateCandidates');
    expect(b.indexOf('requireSteward(')).toBeGreaterThan(-1);
    expect(b.indexOf('requireSteward(')).toBeLessThan(b.indexOf('prisma.'));
    expect(b).toContain('pairCandidates(');
    expect(b).toContain('parseDismissals(');
  });

  it.each(['dismissDuplicateCore', 'undoDismissDuplicateCore'])(
    '%s checks the role first, computes the signals on the server, and writes through writeAudit',
    (name) => {
      const b = body(name);
      expect(b.indexOf('requireSteward(')).toBeGreaterThan(-1);
      expect(b.indexOf('requireSteward(')).toBeLessThan(b.indexOf('readLivePair('));
      expect(b).toContain('matchSignals(');
      expect(b).toMatch(/\bwriteAudit\(/);
      expect(b).not.toMatch(/auditLog\s*\.\s*create/);
    }
  );

  it('the page asks before "Mark distinct" and before an undo, and no longer promises checks that do not exist', () => {
    const form = stripComments(readFileSync('app/(app)/duplicates/MergeForm.tsx', 'utf8'));
    const dismiss = form.slice(form.indexOf('function dismiss('), form.indexOf('return (', form.indexOf('function dismiss(')));
    expect(dismiss.indexOf('confirm(')).toBeGreaterThan(-1);
    expect(dismiss.indexOf('confirm(')).toBeLessThan(dismiss.indexOf('dismissDuplicateAction('));
    const undo = stripComments(readFileSync('app/(app)/duplicates/UndoDistinct.tsx', 'utf8'));
    const fn = undo.slice(undo.indexOf('function undo('), undo.indexOf('return (', undo.indexOf('function undo(')));
    expect(fn.indexOf('confirm(')).toBeGreaterThan(-1);
    expect(fn.indexOf('confirm(')).toBeLessThan(fn.indexOf('undoDismissDuplicateAction('));
    const page = stripComments(readFileSync('app/(app)/duplicates/page.tsx', 'utf8'));
    expect(page).not.toMatch(/fuzzy/i);
    expect(page).toContain('duplicatesSubtitle(');
  });
});
