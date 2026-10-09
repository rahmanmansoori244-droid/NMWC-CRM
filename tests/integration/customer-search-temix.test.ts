// @vitest-environment node
/**
 * Owner request 2026-10-10, against real Postgres: in the customer search's
 * Temix code arm a typed `_` or `%` is that character, not a LIKE wildcard.
 *
 * lib/customer-filters.ts temixCodeSearchPrefix escapes `\`, `%` and `_`
 * because Prisma passes a `startsWith` value to ILIKE unescaped (Prisma 6.19.3,
 * checked by hand on UAT). Prisma does not document that, and the unit suite of
 * the same name reads LIKE the way the code assumes, so it would still pass if a
 * Prisma upgrade began escaping the value itself: the escape would be doubled,
 * `cad_` would look for a backslash, and a salesman typing a code with a `_` in
 * it would find nothing. Here the page's `where` goes through Prisma to
 * Postgres. It rides RUN_EXPORT_TESTS (the same `where` builds the filtered
 * export), so CI runs it on every push, a Prisma upgrade included.
 *
 *   RUN_EXPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/customer-search-temix.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Role, type Prisma } from '@prisma/client';
import {
  applyCustomerFilters,
  customerListBranchScope,
  parseCustomerFilters,
} from '@/lib/customer-filters';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_EXPORT_TESTS === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('the Temix code search on Postgres: `_` and `%` typed are the characters', () => {
  let prisma: import('@prisma/client').PrismaClient;
  // Letters only: eight digits in the search text would make it a phone number
  // (normalizePhone), and the phone arm would then search every customer's phone.
  const tag = randomUUID()
    .replace(/-/g, '')
    .slice(0, 8)
    .replace(/[0-9a-f]/g, (h) => String.fromCharCode(65 + parseInt(h, 16)));
  const P = `ZZTXS-${tag}`;
  // No NMWC code, name or branch code here holds "TXQ", so only the Temix arm
  // can match these codes.
  const T = `TXQ${tag}`;
  const t = T.toLowerCase();
  const ids = new Map<string, string>();
  let regionId = '';
  let routeA = '';
  let routeB = '';

  /** What /customers lists for a viewer and a search (the `where` of app/(app)/customers/page.tsx). */
  const search = async (role: Role, ownedRouteId: string | null, q: string) => {
    const s = customerListBranchScope(role, { ownedRouteId, teamRouteIds: [], managedRegionIds: [] });
    const base: Prisma.CustomerWhereInput = { deletedAt: null };
    if (s.forceEmpty) base.id = '__none__';
    const where = applyCustomerFilters(
      base,
      s.forceEmpty ? undefined : s.branchSome,
      parseCustomerFilters({ q }),
      [],
      null
    );
    const rows = await prisma.customer.findMany({ where, select: { id: true } });
    const name = new Map([...ids].map(([k, v]) => [v, k]));
    return rows.map((r) => name.get(r.id) ?? `not ours: ${r.id}`).sort();
  };
  const steward = (q: string) => search(Role.STEWARD, null, q);
  const salesmanA = (q: string) => search(Role.SALESMAN, routeA, q);

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    regionId = (await prisma.region.create({ data: { code: `${P}R`, name: `ZZ TXS ${tag}` } })).id;
    routeA = (await prisma.route.create({ data: { code: `${P}-RA`, name: 'ZZ TXS A', regionId } })).id;
    routeB = (await prisma.route.create({ data: { code: `${P}-RB`, name: 'ZZ TXS B', regionId } })).id;
    const customer = async (key: string, temixCode: string, routeId: string) => {
      const c = await prisma.customer.create({
        data: { nmwcCode: `${P}-${key}`, legalName: `ZZ TXS ${tag} ${key}`, temixCode },
      });
      await prisma.branch.create({
        data: {
          customerId: c.id,
          branchCode: `${P}-${key}-01`,
          branchName: `ZZ ${key}`,
          address: `Way ${key}, ZZ`,
          regionId,
          routeId,
        },
      });
      ids.set(key, c.id);
    };
    await customer('underscore', `${T}_01`, routeA);
    // Stored in lower case, as an older import may have stored a code.
    await customer('lower', `${t}_02`, routeA);
    // The code an unescaped `_` (any one character) would also match.
    await customer('no-underscore', `${T}X01`, routeA);
    await customer('other-route', `${T}_09`, routeB);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const custIds = custs.map((c) => c.id);
      await prisma.branch.deleteMany({ where: { customerId: { in: custIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
      await prisma.route.deleteMany({ where: { id: { in: [routeA, routeB].filter(Boolean) } } });
      if (regionId) await prisma.region.deleteMany({ where: { id: regionId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('a `_` typed finds the codes with a `_` there, in either case, and not one with another character', async () => {
    // Escaped twice (by Prisma as well) this finds nothing; not escaped, it also
    // finds the X01 code.
    expect(await steward(`${t}_`), 'escaped once: neither nothing nor the X01 code').toEqual([
      'lower',
      'other-route',
      'underscore',
    ]);
    expect(await steward(`${T}X`)).toEqual(['no-underscore']);
  });

  it('the whole code with a `_`, typed in lower case, finds exactly that customer', async () => {
    expect(await salesmanA(`${t}_01`)).toEqual(['underscore']);
    expect(await salesmanA(`${T}_02`)).toEqual(['lower']);
  });

  it('a `%` typed is no wildcard: no code holds one, so nothing is found', async () => {
    expect(await steward(`${T}%`)).toEqual([]);
    expect(await steward(`${t}%1`)).toEqual([]);
  });

  it('the role scope still decides in SQL: his route’s codes only', async () => {
    expect(await salesmanA(`${t}_`)).toEqual(['lower', 'underscore']);
    expect(await salesmanA(`${T}_09`)).toEqual([]);
    expect(await steward(`${T}_09`)).toEqual(['other-route']);
  });
});
