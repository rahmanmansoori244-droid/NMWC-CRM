// @vitest-environment node
/**
 * Owner request 2026-10-10: the customer search finds a customer by its Temix
 * code. A customer made in the CRM gets its Temix code from the Accountant at
 * its last approval (lib/temix-code.ts), and it differs from its NMWC code; only
 * the salesman's "New customer approved" alert named it, so once the alert was
 * gone he could not find the customer by the code Temix and the office use.
 *
 * What lib/customer-filters.ts must do, and what these tests hold it to:
 *   - the whole code and its start both find the customer, typed in lower case,
 *     with Arabic-Indic or Persian digits, or with the invisible characters
 *     copied Arabic text carries (folded as normalizeTemixCode folds a code);
 *   - a stored code is matched without regard to case (older imports);
 *   - `_` and `%` in what was typed are the characters, not LIKE wildcards;
 *   - the role scope still decides: a salesman never finds another route's
 *     customer by its Temix code, and the answer for a code held only outside
 *     his scope is the answer for a code nobody holds (nothing), so the search
 *     cannot tell him the code exists elsewhere.
 *
 * The `where` the page builds is run against a few customers by a small reader
 * of the Prisma filters it uses (`matches` below), so the scope tests check what
 * a viewer would get, not the shape of the object — they fail if the Temix arm
 * is ever OR-ed around the scope (the last test proves they can). Its LIKE
 * follows what Prisma sends (checked on UAT 2026-10-10): `startsWith` and
 * `contains` reach ILIKE as `value%` / `%value%`, unescaped, and Postgres reads
 * `\` as the escape.
 */
import { describe, it, expect } from 'vitest';
import { Prisma, Role } from '@prisma/client';
import {
  applyCustomerFilters,
  customerListBranchScope,
  parseCustomerFilters,
  temixCodeSearchPrefix,
} from '@/lib/customer-filters';

// ── a reader of the Prisma filters the customer search uses ─────────────────

type Row = { [k: string]: unknown; branches?: Row[] };
type Where = Record<string, unknown>;

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SQL LIKE / ILIKE: `\` escapes the next character, `%` is any run, `_` any one character. */
function like(value: string, pattern: string, insensitive: boolean): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) re += escapeRe(pattern[++i]!);
    else if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, insensitive ? 'i' : '').test(value);
}

function scalar(value: unknown, cond: unknown, key: string): boolean {
  if (cond === null || typeof cond !== 'object') return value === cond;
  const { mode, ...ops } = cond as Record<string, unknown>;
  const ci = mode === 'insensitive';
  return Object.entries(ops).every(([op, arg]) => {
    switch (op) {
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'contains':
        // SQL: a NULL column matches no LIKE.
        return typeof value === 'string' && like(value, `%${arg as string}%`, ci);
      case 'startsWith':
        return typeof value === 'string' && like(value, `${arg as string}%`, ci);
      default:
        // Never pass silently on a filter this reader does not understand.
        throw new Error(`unsupported filter ${key}.${op}`);
    }
  });
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w as Where));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'branches') {
      const { some, ...rest } = cond as { some?: Where };
      if (Object.keys(rest).length > 0) throw new Error(`unsupported relation filter ${Object.keys(rest).join()}`);
      return (row.branches ?? []).some((b) => matches(b, some ?? {}));
    }
    if (key === 'NOT') throw new Error('unsupported filter NOT');
    return scalar(row[key], cond, key);
  });
}

// ── customers: route A (the salesman's) and A2 in region G1, route B in G2 ──

const branch = (routeId: string, regionId: string, code: string): Row => ({
  routeId,
  regionId,
  deletedAt: null,
  branchName: 'Main',
  branchCode: `${code}-01`,
});
const customer = (id: string, nmwcCode: string, temixCode: string | null, b: Row, extra: Row = {}): Row => ({
  id,
  nmwcCode,
  temixCode,
  legalName: `Shop ${id}`,
  primaryPhoneNorm: null,
  deletedAt: null,
  branches: [b],
  ...extra,
});
const CUSTOMERS: Row[] = [
  // Made in the CRM: its Temix code differs from its NMWC code.
  customer('mine', 'NMWC-2026-000101', 'CAA0367', branch('rA', 'g1', 'NMWC-2026-000101')),
  // Same region, another route; its code shares the start CAA036.
  customer('other-route', 'NMWC-2026-000102', 'CAA0368', branch('rA2', 'g1', 'NMWC-2026-000102')),
  // Another region.
  customer('other-region', 'NMWC-2026-000103', 'CAA0369', branch('rB', 'g2', 'NMWC-2026-000103')),
  // Migrated: its NMWC code IS its Temix code.
  customer('migrated', 'CAB0100', 'CAB0100', branch('rA', 'g1', 'CAB0100')),
  // Stored in lower case by an older import.
  customer('lower', 'NMWC-2026-000104', 'cac0001', branch('rA', 'g1', 'NMWC-2026-000104')),
  // `_` inside a code, and a code a wildcard `_` would also match.
  customer('underscore', 'NMWC-2026-000105', 'CAD_01', branch('rA', 'g1', 'NMWC-2026-000105')),
  customer('no-underscore', 'NMWC-2026-000106', 'CADX01', branch('rA', 'g1', 'NMWC-2026-000106')),
  // No Temix code on record.
  customer('uncoded', 'NMWC-2026-000107', null, branch('rA', 'g1', 'NMWC-2026-000107')),
  // Archived, on his route: never listed.
  customer('archived', 'NMWC-2026-000108', 'CAA0370', branch('rA', 'g1', 'NMWC-2026-000108'), { deletedAt: new Date('2026-09-01') }),
];

type Viewer = [Role, { ownedRouteId: string | null; teamRouteIds: string[]; managedRegionIds: string[] }];
const SALESMAN_A: Viewer = [Role.SALESMAN, { ownedRouteId: 'rA', teamRouteIds: [], managedRegionIds: [] }];
const SUPERVISOR_A2: Viewer = [Role.SUPERVISOR, { ownedRouteId: null, teamRouteIds: ['rA2'], managedRegionIds: [] }];
const MANAGER_G1: Viewer = [Role.MANAGER, { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] }];
const ACCOUNTANT_G2: Viewer = [Role.ACCOUNTANT, { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g2'] }];
const STEWARD: Viewer = [Role.STEWARD, { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] }];
const ROUTELESS_SALESMAN: Viewer = [Role.SALESMAN, { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] }];

/** The `where` /customers builds (app/(app)/customers/page.tsx), for a viewer and a search. */
function listWhere([role, scope]: Viewer, q: string): Prisma.CustomerWhereInput {
  const s = customerListBranchScope(role, scope);
  const base: Prisma.CustomerWhereInput = { deletedAt: null };
  if (s.forceEmpty) base.id = '__none__';
  return applyCustomerFilters(base, s.forceEmpty ? undefined : s.branchSome, parseCustomerFilters({ q }), [], null);
}
const run = (where: Prisma.CustomerWhereInput) =>
  CUSTOMERS.filter((c) => matches(c, where as Where))
    .map((c) => c.id as string)
    .sort();
const search = (viewer: Viewer, q: string) => run(listWhere(viewer, q));

// ── the tests ────────────────────────────────────────────────────────────────

describe('temixCodeSearchPrefix: the typed text as the start of a Temix code', () => {
  it.each([
    ['CAA0367', 'CAA0367'],
    ['caa0367', 'CAA0367'],
    ['  caa03 ', 'CAA03'],
    // Arabic-Indic and Persian digits, as an Arabic keyboard types them.
    ['CAA٠٣٦٧', 'CAA0367'],
    ['caa۰۳۶', 'CAA036'],
    // A right-to-left mark and a zero-width space, as copied Arabic text carries them.
    ['‏CAA​0367', 'CAA0367'],
    // LIKE's wildcards and its escape are the characters typed.
    ['cad_01', 'CAD\\_01'],
    ['CAA%', 'CAA\\%'],
    ['CA\\A', 'CA\\\\A'],
  ])('%j → %j', (typed, prefix) => {
    expect(temixCodeSearchPrefix(typed)).toBe(prefix);
  });

  it.each([[''], ['   '], ['‏'], ['Al Noor'], ['+968 9123 4567']])(
    '%j cannot start a Temix code (no spaces in one): no Temix arm',
    (typed) => {
      expect(temixCodeSearchPrefix(typed)).toBe('');
    }
  );

  it('adds the arm to the search, folded, matched without regard to case', () => {
    const where = listWhere(STEWARD, 'caa٠٣');
    expect(where.OR).toContainEqual({ temixCode: { startsWith: 'CAA03', mode: 'insensitive' } });
  });

  it('adds nothing for a search with a space in it', () => {
    expect(JSON.stringify(listWhere(STEWARD, 'Al Noor'))).not.toContain('temixCode');
  });
});

describe('the search finds a customer by its Temix code', () => {
  it.each([
    ['the whole code', 'CAA0367'],
    ['its start', 'CAA036'],
    ['in lower case', 'caa0367'],
    ['in Arabic-Indic digits', 'CAA٠٣٦٧'],
    ['in Persian digits, lower case, a prefix', 'caa۰۳۶'],
  ])('%s (%s)', (_what, q) => {
    expect(search(SALESMAN_A, q)).toEqual(['mine']);
  });

  it('a migrated customer, whose NMWC code IS its Temix code', () => {
    expect(search(SALESMAN_A, 'cab01')).toEqual(['migrated']);
  });

  it('a code an older import stored in lower case', () => {
    expect(search(SALESMAN_A, 'CAC0001')).toEqual(['lower']);
  });

  it('a `_` typed is a `_`, not any character', () => {
    expect(search(SALESMAN_A, 'cad_')).toEqual(['underscore']);
    expect(search(SALESMAN_A, 'CADX')).toEqual(['no-underscore']);
  });

  it('never an archived customer', () => {
    expect(search(SALESMAN_A, 'CAA0370')).toEqual([]);
  });

  it('an org-wide viewer finds every live customer whose code starts so', () => {
    expect(search(STEWARD, 'CAA036')).toEqual(['mine', 'other-region', 'other-route']);
  });
});

describe('the role scope still decides', () => {
  it('a salesman never finds another route’s customer by its Temix code', () => {
    expect(search(SALESMAN_A, 'CAA0368')).toEqual([]);
    expect(search(SALESMAN_A, 'CAA0369')).toEqual([]);
    // The start shared with them finds his own customer only.
    expect(search(SALESMAN_A, 'caa036')).toEqual(['mine']);
  });

  it('a code held only outside his scope answers as a code nobody holds', () => {
    expect(search(SALESMAN_A, 'CAA0368')).toEqual(search(SALESMAN_A, 'CAA9999'));
  });

  it('a supervisor, a manager and an accountant see their own routes and regions only', () => {
    expect(search(SUPERVISOR_A2, 'CAA036')).toEqual(['other-route']);
    expect(search(MANAGER_G1, 'CAA036')).toEqual(['mine', 'other-route']);
    expect(search(ACCOUNTANT_G2, 'CAA036')).toEqual(['other-region']);
  });

  it('a salesman with no route finds nothing, even by an exact code', () => {
    expect(search(ROUTELESS_SALESMAN, 'CAA0367')).toEqual([]);
  });

  it('the Temix arm sits inside the search OR, beside the scope', () => {
    const where = listWhere(SALESMAN_A, 'CAA0367');
    expect(where.branches).toEqual({ some: { routeId: 'rA', deletedAt: null } });
    expect(where.OR).toContainEqual({ temixCode: { startsWith: 'CAA0367', mode: 'insensitive' } });
    expect(where.deletedAt).toBeNull();
  });

  it('these checks fail when the arm is OR-ed around the scope', () => {
    // The mistake they exist for: the Temix match added as an alternative to the
    // whole scoped `where` instead of inside its search OR.
    const leaky: Prisma.CustomerWhereInput = {
      OR: [listWhere(SALESMAN_A, 'CAA0368'), { temixCode: { startsWith: 'CAA0368', mode: 'insensitive' } }],
    };
    expect(run(leaky)).toEqual(['other-route']);
  });
});
