/**
 * F2: the dashboard's loader (lib/insights/load.ts) with the database mocked.
 *
 *   - one failing statement degrades only its own section; the rest still load,
 *     and the log gets the card and the error's class, never its message;
 *   - the rows are shaped as the cards read them (lib/insights/shape.ts): the
 *     GROUPING masks, the gap-filled series, the direct-write split;
 *   - the SQL text keeps the raw-SQL rules: counts ::int, averages ::float8, the
 *     grain a whitelisted literal and never a bound parameter, fieldChanges read
 *     only as a JSON array, ids bound and never spliced, no Customer.updatedAt,
 *     and the six statements in one wave.
 * The SQL itself runs against Postgres in tests/integration/insights.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma, Role } from '@prisma/client';
import { stripComments } from '../support/strip-comments';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: h.queryRaw } }));
vi.mock('@/lib/logger', () => ({ logger: { error: h.logError, warn: vi.fn(), info: vi.fn() } }));

import { loadInsights, cellDegFor, __sql } from '@/lib/insights/load';
import { parsePeriod } from '@/lib/insights/period';
import { resolveInsightScope, type InsightScope } from '@/lib/insights/scope';
import { MAP } from '@/lib/insights/policy';
import {
  changePct,
  pct,
  shapeCreated,
  shapeHeat,
  shapePipeline,
  shapeState,
  shapeUpdated,
  type StateRow,
} from '@/lib/insights/shape';

const NOW = new Date('2026-10-05T08:00:00Z');
const PERIOD = parsePeriod({ period: '7d' }, NOW);
const none = { regionIds: [] as string[], routeIds: [] as string[], rejected: false };
const empty = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };
const active = (s: InsightScope) => {
  if (s.kind === 'none') throw new Error('none');
  return s;
};
const MANAGER = active(resolveInsightScope(Role.MANAGER, { ...empty, managedRegionIds: ['r-a', 'r-b'] }, none));
const ONE_REGION = active(resolveInsightScope(Role.MANAGER, { ...empty, managedRegionIds: ['r-a'] }, none));
const STEWARD = active(resolveInsightScope(Role.STEWARD, empty, none));

function marker(q: Prisma.Sql): string {
  return /\/\* insights:(\w+) \*\//.exec(q.sql)?.[1] ?? 'unknown';
}

const stateRow = (over: Partial<StateRow>): StateRow => ({
  regionId: null, routeId: null, g: 3, branches: 0, customers: 0, open: 0, closed: 0, closedInPeriod: 0,
  openWithGps: 0, openNoDay: 0, openNoShop: 0, openNoSign: 0, openNoEquipment: 0, customersNoCr: 0, imported: 0,
  avgScore: null, regionName: null, regionCode: null, routeCode: null, routeName: null, routeRegionId: null,
  routeRegionName: null, routeHasOwner: null, ...over,
});

beforeEach(() => {
  h.queryRaw.mockReset().mockResolvedValue([]);
  h.logError.mockReset();
});

describe('one failing query degrades only its card', () => {
  it('runs six statements in one wave and loads every section', async () => {
    const data = await loadInsights(MANAGER, PERIOD);
    expect(h.queryRaw).toHaveBeenCalledTimes(6);
    expect(h.queryRaw.mock.calls.map((c) => marker(c[0] as Prisma.Sql)).sort()).toEqual(
      ['created', 'heat', 'requests', 'state', 'status', 'updated']
    );
    for (const s of Object.values(data)) expect(s.ok).toBe(true);
  });

  it.each(['state', 'created', 'updated', 'status', 'requests', 'heat'])('%s fails: that section only', async (card) => {
    h.queryRaw.mockImplementation(async (q: Prisma.Sql) => {
      if (marker(q) === card) {
        const err = Object.assign(new Error('relation "secret detail" does not exist'), { name: 'PrismaClientKnownRequestError', code: 'P2010' });
        throw err;
      }
      return [];
    });
    const data = await loadInsights(MANAGER, PERIOD);
    const key = { status: 'statusChanges', requests: 'pipeline' }[card] ?? card;
    for (const [k, s] of Object.entries(data)) expect(s.ok, k).toBe(k !== key);
    expect(h.logError).toHaveBeenCalledTimes(1);
    const [fields, msg] = h.logError.mock.calls[0]!;
    expect(msg).toBe('insights.card_failed');
    expect(fields).toEqual({ card, errorClass: 'PrismaClientKnownRequestError', code: 'P2010' });
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain('secret detail');
  });

  it('a statement that throws before it is even sent fails its section, not the wave', async () => {
    h.queryRaw.mockImplementation((q: Prisma.Sql) => {
      if (marker(q) === 'updated') throw new TypeError('synchronous');
      return Promise.resolve([]);
    });
    const data = await loadInsights(MANAGER, PERIOD);
    expect(data.updated.ok).toBe(false);
    expect(data.created.ok).toBe(true);
    expect(data.heat.ok).toBe(true);
  });

  it('rows that cannot be shaped fail their section, not the page', async () => {
    h.queryRaw.mockImplementation(async (q: Prisma.Sql) => (marker(q) === 'heat' ? null : []));
    const data = await loadInsights(MANAGER, PERIOD);
    expect(data.heat.ok).toBe(false);
    expect(data.state.ok).toBe(true);
  });
});

describe('shaping', () => {
  it('state: the GROUPING masks pick total, regions and routes; branch scores become a percentage', () => {
    const s = shapeState([
      stateRow({ g: 3, customers: 10, branches: 12, open: 11, openWithGps: 4, avgScore: 30 }),
      stateRow({ g: 1, regionId: 'r-b', regionName: 'Beta', customers: 4 }),
      stateRow({ g: 1, regionId: 'r-a', regionName: 'Alpha', customers: 6 }),
      stateRow({ g: 2, routeId: 'rt-2', routeCode: 'B2', routeName: 'B2', routeHasOwner: false, customers: 3 }),
      stateRow({ g: 2, routeId: 'rt-1', routeCode: 'A1', routeName: 'Alpha one', routeHasOwner: true, customers: 7 }),
    ]);
    expect(s.total).toMatchObject({ customers: 10, branches: 12, open: 11, openWithGps: 4, completenessPct: 50 });
    expect(s.regions.map((r) => r.region.name)).toEqual(['Alpha', 'Beta']);
    expect(s.routes.map((r) => [r.route.code, r.route.hasOwner])).toEqual([
      ['A1', true],
      ['B2', false],
    ]);
  });

  it('state: an empty view is zeros, never a failure', () => {
    expect(shapeState([]).total).toMatchObject({ customers: 0, completenessPct: null });
  });

  it('new customers: every bucket of the window, cash and credit apart, and nothing outside it', () => {
    const c = shapeCreated(
      [
        { g: 6, bucket: PERIOD.buckets[1]!, terms: 'CASH', n: 2, prev: 0 },
        { g: 6, bucket: PERIOD.buckets[1]!, terms: 'CREDIT', n: 1, prev: 0 },
        { g: 6, bucket: '1999-01-01', terms: 'CASH', n: 9, prev: 0 },
        { g: 6, bucket: null, terms: 'CASH', n: 0, prev: 4 },
        { g: 14, terms: 'CASH', n: 2, prev: 3 },
        { g: 14, terms: 'CREDIT', n: 1, prev: 1 },
        { g: 15, n: 3, prev: 4 },
        { g: 11, regionId: 'r-a', regionName: 'Alpha', n: 3, prev: 0 },
        { g: 13, routeId: 'rt-1', routeCode: 'A1', routeName: 'A1', n: 3, prev: 0 },
      ].map((r) => ({ bucket: null, regionId: null, routeId: null, terms: null, regionName: null, regionCode: null, routeCode: null, routeName: null, ...r })),
      PERIOD
    );
    expect(c.series).toHaveLength(PERIOD.buckets.length);
    expect(c.series[1]).toEqual({ bucket: PERIOD.buckets[1], cash: 2, credit: 1, other: 0 });
    expect(c.series.reduce((s, b) => s + b.cash + b.credit + b.other, 0)).toBe(3);
    expect([c.total, c.prevTotal, c.cash, c.credit]).toEqual([3, 4, 2, 1]);
    expect(c.regions).toHaveLength(1);
    expect(c.routes[0]!.route.code).toBe('A1');
  });

  it('customers updated: a bar is customers through a salesman’s request plus customers changed only by direct write', () => {
    const blank = { regionId: null, routeId: null, byDirect: 0, changes: 0, prev: 0, gps: 0, phone: 0, address: 0, visitDay: 0, channel: 0, equipment: 0, contact: 0, regionName: null, regionCode: null, routeCode: null, routeName: null };
    const u = shapeUpdated(
      [
        { ...blank, g: 3, bucket: PERIOD.buckets[0]!, customers: 5, byRequest: 3, byDirect: 3 },
        { ...blank, g: 7, bucket: null, customers: 9, byRequest: 6, byDirect: 4, changes: 12, prev: 7, gps: 2 },
      ],
      PERIOD
    );
    expect(u.series[0]).toEqual({ bucket: PERIOD.buckets[0], byRequest: 3, directOnly: 2 });
    expect(u).toMatchObject({ customers: 9, byRequest: 6, directOnly: 3, changes: 12, prevCustomers: 7 });
    expect(u.families.gps).toBe(2);
  });

  it('requests: unknown kinds and states are ignored, not invented', () => {
    const p = shapePipeline([
      { kind: 'create', state: 'SUBMITTED', submitted: 2, waiting: 5, waitingFirstStep: 3 },
      { kind: 'update', state: 'NEEDS_CORRECTION', submitted: 4, waiting: 0, waitingFirstStep: 0 },
      { kind: 'mystery', state: 'SUBMITTED', submitted: 9, waiting: 9, waitingFirstStep: 9 },
      { kind: 'close', state: 'DRAFT', submitted: 1, waiting: 0, waitingFirstStep: 0 },
    ]);
    expect(p.submitted.create.SUBMITTED).toBe(2);
    expect(p.submitted.update.NEEDS_CORRECTION).toBe(4);
    expect(p.waitingAnyStep).toEqual({ create: 5, update: 0, close: 0, reactivation: 0 });
    expect(p.waitingFirstStep).toEqual({ create: 3, update: 0, close: 0, reactivation: 0 });
  });

  it('heat: cell corners from integer grid indices; totals from their own rows', () => {
    const hd = shapeHeat(
      [
        { kind: 'cell', cy: 472, cx: 1168, n: 3, m: 0 },
        { kind: 'total', cy: null, cx: null, n: 10, m: 6 },
        { kind: 'cells', cy: null, cx: null, n: 1, m: 3 },
      ],
      0.05
    );
    expect(hd.cells).toEqual([{ lat: 23.6, lng: 58.4, n: 3 }]);
    expect([hd.openBranches, hd.openWithGps, hd.totalCells, hd.located]).toEqual([10, 6, 1, 3]);
  });

  it('shares and changes are whole percentages, and nothing to divide by is null', () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(1, 0)).toBeNull();
    expect(changePct(12, 10)).toBe(20);
    expect(changePct(5, 0)).toBeNull();
  });
});

describe('the map’s cells', () => {
  it('are finer when exactly one region is in view', () => {
    expect(cellDegFor(ONE_REGION)).toBe(MAP.cellDegRegion);
    expect(cellDegFor(MANAGER)).toBe(MAP.cellDegCountry);
    expect(cellDegFor(STEWARD)).toBe(MAP.cellDegCountry);
  });
});

describe('the SQL text', () => {
  const statements = (scope: Exclude<InsightScope, { kind: 'none' }>) => ({
    state: __sql.stateSql(scope, PERIOD),
    created: __sql.createdSql(scope, PERIOD),
    updated: __sql.updatedSql(scope, PERIOD),
    status: __sql.statusSql(scope, PERIOD),
    requests: __sql.requestsSql(scope, PERIOD),
    heat: __sql.heatSql(scope, cellDegFor(scope)),
  });

  /** Each aggregate call's text up to its closing parenthesis, plus a FILTER clause if one follows. */
  function aggregates(sql: string, fn: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`\\b${fn}\\(`, 'g');
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (depth > 0 && i < sql.length) {
        if (sql[i] === '(') depth++;
        if (sql[i] === ')') depth--;
        i++;
      }
      let rest = sql.slice(i);
      const filter = /^\s*FILTER\s*\(/.exec(rest);
      if (filter) {
        let j = filter[0].length;
        let d = 1;
        while (d > 0 && j < rest.length) {
          if (rest[j] === '(') d++;
          if (rest[j] === ')') d--;
          j++;
        }
        rest = rest.slice(j);
      }
      out.push(rest.slice(0, 12));
    }
    return out;
  }

  it.each(['state', 'created', 'updated', 'status', 'requests', 'heat'] as const)('%s: every count is ::int and every average ::float8', (name) => {
    const q = statements(MANAGER)[name];
    expect(aggregates(q.sql, 'count').length).toBeGreaterThan(0);
    for (const after of aggregates(q.sql, 'count')) expect(after.startsWith('::int')).toBe(true);
    for (const after of aggregates(q.sql, 'avg')) expect(after.replace(/^\)/, '').startsWith('::float8')).toBe(true);
    expect(q.sql).not.toMatch(/updatedAt/);
  });

  it.each(['day', 'week', 'month'] as const)('the %s grain is a literal in the text, never a bound value', (grain) => {
    const p = { ...PERIOD, grain };
    for (const q of [__sql.createdSql(MANAGER, p), __sql.updatedSql(MANAGER, p), __sql.statusSql(MANAGER, p)]) {
      expect(q.sql).toContain(`date_trunc('${grain}',`);
      expect(q.values).not.toContain(grain);
      expect(q.sql).toContain(`interval '4 hours'`);
    }
  });

  it('time buckets are grouped by name, never by a repeated expression', () => {
    for (const q of Object.values(statements(MANAGER))) {
      const groupBy = q.sql.slice(q.sql.lastIndexOf('GROUP BY'));
      expect(groupBy).not.toMatch(/date_trunc/);
    }
  });

  it('fieldChanges is read only as a JSON array, element by element as objects', () => {
    const q = __sql.updatedSql(MANAGER, PERIOD).sql;
    expect(q).toContain(`CASE WHEN jsonb_typeof(e."fieldChanges") = 'array' THEN e."fieldChanges" ELSE '[]'::jsonb END`);
    expect(q).toContain(`jsonb_typeof(el) = 'object'`);
  });

  it('a Manager’s region ids are bound into every statement, never spliced into its text', () => {
    for (const [name, q] of Object.entries(statements(MANAGER))) {
      expect(q.sql, name).not.toContain('r-a');
      expect(JSON.stringify(q.values), name).toContain('r-a');
    }
  });

  it('the unfiltered organisation has no region test at all, not an empty one', () => {
    for (const q of Object.values(statements(STEWARD))) expect(JSON.stringify(q.values)).not.toContain('__none__');
  });

  it('updates exclude reactivations and close-shop requests; closures read the branch', () => {
    const u = __sql.updatedSql(MANAGER, PERIOD).sql;
    expect(u).toContain(`e."process" = 'UPDATE' AND e."target" = 'CUSTOMER' AND e."state" = 'APPROVED'`);
    expect(u).toContain('NOT e."isReactivation"');
    const s = __sql.statusSql(MANAGER, PERIOD).sql;
    expect(s).toContain(`JOIN "Branch" b ON b."id" = e."branchId"`);
  });

  it('new customers are CREATE requests approved in the window, dated by the decision', () => {
    const c = __sql.createdSql(MANAGER, PERIOD).sql;
    expect(c).toContain(`e."process" = 'CREATE' AND e."state" = 'APPROVED'`);
    expect(c).toContain('e."reviewedAt" >=');
    expect(c).not.toMatch(/"createdAt"/);
  });

  it('the map is capped and bins points — no coordinate leaves the database unbinned', () => {
    const q = __sql.heatSql(MANAGER, 0.05);
    expect(q.sql).toContain('floor("lat" *');
    expect(q.values).toContain(MAP.maxCells);
    // Only binned indices are selected from the points.
    expect(q.sql).not.toMatch(/SELECT 'cell'::text AS "kind", "lat"/);
    expect(q.sql).not.toMatch(/capturedLat|capturedLng/);
  });
});

describe('source rules for lib/insights', () => {
  const files = ['scope', 'sql', 'period', 'policy', 'load', 'shape', 'url', 'highlights'].map((f) => `lib/insights/${f}.ts`);
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

  it.each(files)('%s: no cache, no server action, no session, no Customer.updatedAt, no row reads', (f) => {
    const s = src(f);
    expect(s).not.toMatch(/unstable_cache|revalidate|'use server'|"use server"/);
    expect(s).not.toMatch(/from ['"](@\/lib\/auth|\.\.\/auth|\.\/auth)['"]/);
    expect(s).not.toMatch(/\bauth\s*\(/);
    expect(s).not.toMatch(/updatedAt/);
    expect(s).not.toMatch(/\.findMany\s*\(/);
  });

  it('the loader runs exactly six statements, all in one Promise.allSettled', () => {
    const s = src('lib/insights/load.ts');
    expect(s.match(/\$queryRaw\b/g)).toHaveLength(6);
    expect(s.match(/Promise\.allSettled\(/g)).toHaveLength(1);
    expect(s).not.toMatch(/Promise\.all\(/);
  });

  it('the pure modules import no database client', () => {
    for (const f of ['scope', 'period', 'policy', 'shape', 'url', 'highlights']) {
      expect(src(`lib/insights/${f}.ts`)).not.toMatch(/from ['"](\.\.\/db|@\/lib\/db|\.\.\/service-status)['"]/);
    }
  });
});
