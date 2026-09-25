// @vitest-environment node
/**
 * lib/create-guards.ts, benchmark item 16 (owner decision 2026-09-25): at
 * create time, two names that differ only in whitespace are the same name, by
 * the same key the duplicate detector uses (lib/name-key.ts). Before this the
 * triple leg compared names in Postgres, case-insensitively and nothing more,
 * so "Al Noor  Shop" (a doubled space) or "Al Noor Shop" with a pasted no-break
 * space was created beside "Al Noor Shop" — and the lock key, a plain
 * toLowerCase, let the two requests race past each other.
 *
 * The real queries against Postgres are in
 * tests/integration/duplicate-detection.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assertNoExactCreateDuplicate,
  createIdentityLockKeys,
  lockCreateIdentity,
} from '@/lib/create-guards';
import { nameKey } from '@/lib/name-key';

const NBSP = String.fromCharCode(0xa0);
const PHONE = '+96891234567';
const base = { crNumberNorm: null, legalName: 'Al Noor Shop', primaryPhoneNorm: PHONE, regionIds: ['r1'] };

type Live = { nmwcCode: string; legalName: string; primaryPhoneNorm: string; regions: string[] };
type Open = { legalName: string; primaryPhoneNorm: string; regions: string[]; editId: string; submittedById: string };

/**
 * A transaction stand-in that answers the triple leg's two queries the way
 * Postgres would for the where clauses the guard sends — so the test fails if
 * the guard still filters names in SQL, or stops filtering by phone or region.
 */
function fakeTx(live: Live[], open: Open[] = []) {
  const customerFindMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const w = args.where as {
      primaryPhoneNorm: string;
      deletedAt: null;
      legalName?: unknown;
      branches: { some: { regionId: { in: string[] }; deletedAt: null } };
    };
    return live
      .filter((c) => c.primaryPhoneNorm === w.primaryPhoneNorm)
      .filter((c) => c.regions.some((r) => w.branches.some.regionId.in.includes(r)))
      .filter((c) => w.legalName === undefined || c.legalName.toLowerCase() === String((w.legalName as { equals: string }).equals).toLowerCase())
      .map((c) => ({ nmwcCode: c.nmwcCode, legalName: c.legalName }));
  });
  const draftFindMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const w = args.where as {
      primaryPhoneNorm: string;
      legalName?: unknown;
      edit: { branchDrafts: { some: { regionId: { in: string[] } } }; id?: { not: string } };
    };
    return open
      .filter((d) => d.primaryPhoneNorm === w.primaryPhoneNorm)
      .filter((d) => d.regions.some((r) => w.edit.branchDrafts.some.regionId.in.includes(r)))
      .filter((d) => !w.edit.id || d.editId !== w.edit.id.not)
      .map((d) => ({
        legalName: d.legalName,
        edit: { submittedById: d.submittedById, state: 'SUBMITTED', submittedAt: new Date(), updatedAt: new Date() },
      }));
  });
  const tx = {
    customer: { findFirst: vi.fn(async () => null), findMany: customerFindMany },
    editCustomerDraft: { findFirst: vi.fn(async () => null), findMany: draftFindMany },
  };
  return { tx: tx as never, customerFindMany, draftFindMany };
}

const shop = (legalName: string, over: Partial<Live> = {}): Live => ({
  nmwcCode: 'NMWC-2026-000001',
  legalName,
  primaryPhoneNorm: PHONE,
  regions: ['r1'],
  ...over,
});

describe('the name key', () => {
  it('collapses every whitespace run — doubled spaces, tabs, no-break spaces — trims, and folds case', () => {
    expect(nameKey('Al Noor Shop')).toBe('al noor shop');
    expect(nameKey('  AL  NOOR\tSHOP ')).toBe('al noor shop');
    expect(nameKey(`Al${NBSP}Noor${NBSP}${NBSP}Shop`)).toBe('al noor shop');
    expect(nameKey('Al Noor Shop\n')).toBe('al noor shop');
    // Only whitespace: letters and punctuation still count.
    expect(nameKey('AlNoor Shop')).not.toBe(nameKey('Al Noor Shop'));
    expect(nameKey('Al-Noor Shop')).not.toBe(nameKey('Al Noor Shop'));
  });
});

describe('the advisory lock key collapses the same way', () => {
  it('a doubled space, a no-break space, case and outer spaces all lock the same key', () => {
    const plain = createIdentityLockKeys(base);
    expect(plain).toEqual([`nmwc:triple:al noor shop|${PHONE}|r1`]);
    for (const legalName of ['Al Noor  Shop', `Al${NBSP}Noor Shop`, ' AL NOOR SHOP ', 'al\tnoor shop']) {
      expect(createIdentityLockKeys({ ...base, legalName })).toEqual(plain);
    }
    expect(createIdentityLockKeys({ ...base, legalName: 'Al Noor Shops' })).not.toEqual(plain);
  });

  it('one triple key per region, plus the CR key, sorted — and no triple key without a phone', () => {
    expect(createIdentityLockKeys({ ...base, crNumberNorm: '123', regionIds: ['r2', 'r1'] })).toEqual([
      'nmwc:cr:123',
      `nmwc:triple:al noor shop|${PHONE}|r1`,
      `nmwc:triple:al noor shop|${PHONE}|r2`,
    ]);
    expect(createIdentityLockKeys({ ...base, crNumberNorm: '123', primaryPhoneNorm: null })).toEqual(['nmwc:cr:123']);
  });

  it('lockCreateIdentity takes exactly those keys, in that order', async () => {
    const taken: unknown[] = [];
    const tx = { $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => taken.push(v[0])) };
    await lockCreateIdentity(tx as never, { ...base, legalName: `  AL${NBSP}NOOR  shop`, crNumberNorm: '9', regionIds: ['r2', 'r1'] });
    expect(taken).toEqual(createIdentityLockKeys({ ...base, crNumberNorm: '9', regionIds: ['r1', 'r2'] }));
  });
});

describe('assertNoExactCreateDuplicate — the name + phone + region leg', () => {
  it.each([
    ['a doubled inner space', 'Al Noor  Shop'],
    ['a no-break space', `Al${NBSP}Noor Shop`],
    ['different case and outer spaces', '  al noor SHOP '],
    ['a tab', 'Al\tNoor Shop'],
  ])('blocks %s against a live customer with the plain name', async (_label, legalName) => {
    const { tx } = fakeTx([shop('Al Noor Shop')]);
    await expect(assertNoExactCreateDuplicate(tx, { ...base, legalName, includeOpenRequests: true })).rejects.toMatchObject({
      code: 'DUPLICATE_CUSTOMER',
      message: 'This shop already exists: NMWC-2026-000001 — Al Noor Shop (same name, phone and region).',
    });
  });

  it('and the other way round: a live customer stored with a doubled space blocks the plain name', async () => {
    const { tx } = fakeTx([shop(`Al Noor${NBSP} Shop`)]);
    await expect(assertNoExactCreateDuplicate(tx, { ...base, includeOpenRequests: false })).rejects.toMatchObject({
      code: 'DUPLICATE_CUSTOMER',
    });
  });

  it('narrows in SQL by phone and region only, and compares the name with the shared key', async () => {
    const { tx, customerFindMany, draftFindMany } = fakeTx([]);
    await assertNoExactCreateDuplicate(tx, { ...base, regionIds: ['r1', 'r2'], excludeEditId: 'e1', includeOpenRequests: true });
    expect(customerFindMany).toHaveBeenCalledWith({
      where: {
        primaryPhoneNorm: PHONE,
        deletedAt: null,
        branches: { some: { regionId: { in: ['r1', 'r2'] }, deletedAt: null } },
      },
      orderBy: { nmwcCode: 'asc' },
      select: { nmwcCode: true, legalName: true },
    });
    const draftWhere = draftFindMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(draftWhere).not.toHaveProperty('legalName');
    expect(draftWhere).toEqual({
      primaryPhoneNorm: PHONE,
      edit: {
        state: { in: ['DRAFT', 'SUBMITTED', 'NEEDS_CORRECTION'] },
        process: 'CREATE',
        branchDrafts: { some: { regionId: { in: ['r1', 'r2'] } } },
        id: { not: 'e1' },
      },
    });
  });

  it('still lets through a different name on the same phone, and the same name on another phone or in another region', async () => {
    const { tx } = fakeTx([
      shop('Al Noor Shops'),
      shop('Al Noor Shop', { primaryPhoneNorm: '+96899999999' }),
      shop('Al Noor Shop', { regions: ['r9'] }),
    ]);
    await expect(assertNoExactCreateDuplicate(tx, { ...base, includeOpenRequests: false })).resolves.toBeUndefined();
  });

  it('any shared region blocks: the live customer has branches in r2 and r1', async () => {
    const { tx } = fakeTx([shop('Al Noor Shop', { regions: ['r2', 'r1'] })]);
    await expect(assertNoExactCreateDuplicate(tx, { ...base, includeOpenRequests: false })).rejects.toMatchObject({
      code: 'DUPLICATE_CUSTOMER',
    });
  });

  it.each([
    ['a doubled inner space', 'Al Noor  Shop'],
    ['a no-break space', `Al${NBSP}Noor Shop`],
  ])('blocks %s against another open new-customer request', async (_label, legalName) => {
    const { tx } = fakeTx([], [{ legalName: 'Al Noor Shop', primaryPhoneNorm: PHONE, regions: ['r1'], editId: 'e9', submittedById: 'other' }]);
    await expect(
      assertNoExactCreateDuplicate(tx, { ...base, legalName, includeOpenRequests: true, callerId: 'me' })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_CUSTOMER',
      message: 'Another new-customer request for this shop (same name, phone and region) is already in progress.',
    });
  });

  it("the caller's own open request still says it is his, and his own edit is still excluded", async () => {
    const own = { legalName: 'Al Noor Shop', primaryPhoneNorm: PHONE, regions: ['r1'], editId: 'mine', submittedById: 'me' };
    const { tx } = fakeTx([], [own]);
    await expect(
      assertNoExactCreateDuplicate(tx, { ...base, legalName: 'Al Noor  Shop', includeOpenRequests: true, callerId: 'me' })
    ).rejects.toMatchObject({ message: expect.stringMatching(/^Your own new-customer request for this shop/) });
    const again = fakeTx([], [own]);
    await expect(
      assertNoExactCreateDuplicate(again.tx, { ...base, legalName: 'Al Noor  Shop', includeOpenRequests: true, callerId: 'me', excludeEditId: 'mine' })
    ).resolves.toBeUndefined();
  });

  it('at finalize (includeOpenRequests false) open requests are not read', async () => {
    const { tx, draftFindMany } = fakeTx([], [{ legalName: 'Al Noor Shop', primaryPhoneNorm: PHONE, regions: ['r1'], editId: 'e9', submittedById: 'x' }]);
    await expect(assertNoExactCreateDuplicate(tx, { ...base, includeOpenRequests: false })).resolves.toBeUndefined();
    expect(draftFindMany).not.toHaveBeenCalled();
  });
});
