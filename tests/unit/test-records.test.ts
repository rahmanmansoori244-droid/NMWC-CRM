// @vitest-environment node
/**
 * Gap 30 (data audit 2026-10-10): the test and synthetic records left in
 * production are flagged (migration 20261024120000_test_records) and left out of
 * the figures, the exports, the Temix workbook, verify-load and the nightly data
 * checks by default (lib/test-records.ts).
 *
 *  - The migration marks EXACTLY the known identities, and nothing is deleted.
 *  - Only the owner, inside the maintenance window, can move the flag after that:
 *    every table has an insert and an update guard, created after the marking.
 *  - Who sees the test rows: a test account always, the Steward when he asks,
 *    nobody else whatever the URL says.
 *  - The master export, the field-update report and the filtered list export
 *    apply that rule and record what they applied.
 *
 * Structural parts strip SQL comments first (CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Role } from '@prisma/client';
import {
  KNOWN_TEST_RECORDS,
  REAL_BRANCH,
  REAL_CUSTOMER,
  includeTestRows,
  realBranchSql,
  realDraftSql,
  realRequestSql,
} from '@/lib/test-records';
import { TEST_FLAG_TABLES, HISTORY_TRIGGERS } from '@/lib/history-tables';
import { applyCustomerFilters, parseCustomerFilters, testRecordsRequested } from '@/lib/customer-filters';
import { TEMIX_QUEUE_WHERE } from '@/lib/temix';

const h = vi.hoisted(() => ({
  user: { id: 'u1', role: 'STEWARD', username: 'steward.x' } as { id: string; role: string; username: string },
  viewerIsTest: false,
  count: vi.fn(async () => 0),
  record: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/session', () => ({ requireActor: async () => h.user }));
vi.mock('@/lib/audit', () => ({ getAuditEnvelope: async () => ({ actorId: h.user.id, ip: null, userAgent: null }) }));
vi.mock('@/lib/export-record', () => ({ recordExport: h.record }));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: async () => ({ isTest: h.viewerIsTest }), findMany: async () => [] },
    region: { findMany: async () => [] },
    branch: { count: h.count, findMany: async () => [] },
  },
}));

import { buildCustomerExport } from '@/services/exports';

const SQL = readFileSync('prisma/migrations/20261024120000_test_records/migration.sql', 'utf8').replace(/--[^\n]*/g, '');

describe('the migration marks exactly the known production test records', () => {
  const updates = [...SQL.matchAll(/UPDATE "(\w+)"\s+SET "isTest" = true WHERE ([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]);

  it('one UPDATE per table, by exact identity, and nothing else is written or deleted', () => {
    expect(updates).toEqual([
      ['User', `starts_with("username", '${KNOWN_TEST_RECORDS.usernamePrefix}')`],
      ['Region', `"code" = '${KNOWN_TEST_RECORDS.regionCode}'`],
      ['Route', `"code" = '${KNOWN_TEST_RECORDS.routeCode}'`],
      ['Customer', `"nmwcCode" = '${KNOWN_TEST_RECORDS.customerCode}'`],
    ]);
    // starts_with, never LIKE: '_' and '%' are never wildcards.
    expect(SQL).not.toMatch(/\bLIKE\b/i);
    expect(SQL).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bINSERT INTO\b/i);
    expect(SQL.match(/\bUPDATE "/g)).toHaveLength(4);
    // The counts reach the deploy log.
    expect(SQL).toMatch(/RAISE NOTICE 'test_records: marked % users, % regions, % routes, % customers'/);
  });

  it('adds the flag with a constant default on the four tables, exactly as Prisma writes it', () => {
    for (const t of TEST_FLAG_TABLES) {
      expect(SQL).toContain(`ALTER TABLE "${t}" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;`);
    }
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    for (const t of TEST_FLAG_TABLES) {
      const model = schema.slice(schema.indexOf(`model ${t} {`), schema.indexOf('\n}', schema.indexOf(`model ${t} {`)));
      expect(model, t).toMatch(/\n\s+isTest\s+Boolean\s+@default\(false\)/);
    }
  });

  it('guards the flag on insert and update of every table, created AFTER the marking', () => {
    const lastMark = SQL.lastIndexOf('SET "isTest" = true');
    for (const t of TEST_FLAG_TABLES) {
      const lower = t.toLowerCase();
      const ins = SQL.indexOf(`CREATE TRIGGER ${lower}_is_test_guard_ins`);
      const upd = SQL.indexOf(`CREATE TRIGGER ${lower}_is_test_guard_upd`);
      expect(ins, t).toBeGreaterThan(lastMark);
      expect(upd, t).toBeGreaterThan(lastMark);
      expect(SQL.slice(ins, SQL.indexOf(';', ins))).toMatch(
        new RegExp(`BEFORE INSERT ON "${t}"\\s+FOR EACH ROW\\s+WHEN \\(NEW\\."isTest"\\)\\s+EXECUTE FUNCTION nmwc_is_test_guard\\(\\)`)
      );
      expect(SQL.slice(upd, SQL.indexOf(';', upd))).toMatch(
        new RegExp(
          `BEFORE UPDATE OF "isTest" ON "${t}"\\s+FOR EACH ROW\\s+WHEN \\(NEW\\."isTest" IS DISTINCT FROM OLD\\."isTest"\\)\\s+EXECUTE FUNCTION nmwc_is_test_guard\\(\\)`
        )
      );
      expect(HISTORY_TRIGGERS).toContain(`${lower}_is_test_guard_ins`);
      expect(HISTORY_TRIGGERS).toContain(`${lower}_is_test_guard_upd`);
    }
  });

  it('the guard lets only the table owner through, inside the maintenance window', () => {
    const at = SQL.indexOf('CREATE OR REPLACE FUNCTION nmwc_is_test_guard()');
    const body = SQL.slice(SQL.indexOf('$$', at) + 2, SQL.indexOf('$$', SQL.indexOf('$$', at) + 2));
    expect(body).toMatch(/current_setting\('nmwc\.audit_maintenance', true\) = 'on'/);
    expect(body).toMatch(/IF session_user = owner_name THEN\s+RETURN NEW;/);
    expect(body).toMatch(/USING ERRCODE = 'insufficient_privilege'/);
    expect(SQL.slice(at, SQL.indexOf('AS $$', at))).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(SQL.slice(at, SQL.indexOf('AS $$', at))).not.toContain('SECURITY DEFINER');
    expect(SQL).toContain('REVOKE EXECUTE ON FUNCTION nmwc_is_test_guard() FROM PUBLIC');
  });
});

describe('who sees the test rows', () => {
  it('a test account always; the Steward when he asks; anyone else never', () => {
    for (const role of Object.values(Role)) {
      expect(includeTestRows({ viewerIsTest: true, role, requested: false }), role).toBe(true);
      expect(includeTestRows({ viewerIsTest: false, role, requested: false }), role).toBe(false);
      expect(includeTestRows({ viewerIsTest: false, role, requested: true }), role).toBe(role === Role.STEWARD);
    }
  });

  it('the /customers list: a URL alone never turns it on, and off means isTest false', () => {
    expect(parseCustomerFilters({ test: '1' }).includeTest).toBe(false);
    expect(testRecordsRequested({ test: '1' })).toBe(true);
    expect(testRecordsRequested({ test: 'yes' })).toBe(false);
    const off = parseCustomerFilters({});
    expect(applyCustomerFilters({ deletedAt: null }, undefined, off, [], null)).toMatchObject({ isTest: false });
    const on = { ...off, includeTest: true };
    expect(applyCustomerFilters({ deletedAt: null }, undefined, on, [], null)).not.toHaveProperty('isTest');
  });

  it('the Temix workbook never takes a test customer, on either lane', () => {
    for (const lane of TEMIX_QUEUE_WHERE.OR!) expect(lane).toMatchObject({ isTest: false });
  });

  it('the Prisma fragments and the SQL twins name the shop’s customer, route and region, and the request’s parts', () => {
    expect(REAL_CUSTOMER).toEqual({ isTest: false });
    expect(REAL_BRANCH).toEqual({ customer: { isTest: false }, route: { isTest: false }, region: { isTest: false } });
    const b = realBranchSql('b').sql;
    for (const part of ['b."customerId"', 'b."routeId"', 'b."regionId"']) expect(b).toContain(part);
    const d = realDraftSql('d', 'r').sql;
    expect(d).toContain('NOT r."isTest"');
    expect(d).toContain('IN (d."regionId", r."regionId")');
    const e = realRequestSql('e').sql;
    for (const part of ['e."submittedById"', 'e."customerId"', 'zt_d."editId" = e."id"']) expect(e).toContain(part);
    // Bound to nothing: no value is ever spliced in, and the aliases are checked.
    expect(realBranchSql('b').values).toEqual([]);
    for (const f of [() => realBranchSql('x"'), () => realDraftSql('d', 'r;'), () => realRequestSql('E')]) {
      expect(f).toThrow('bad SQL alias');
    }
  });
});

describe('the master export applies the rule and records it', () => {
  beforeEach(() => {
    h.count.mockClear();
    h.record.mockClear();
    h.viewerIsTest = false;
  });

  const lastWhere = () => (h.count.mock.calls.at(-1) as unknown as [{ where: Record<string, unknown> }])[0].where;

  it('by default the test customers, routes and regions are left out', async () => {
    h.user = { id: 'v1', role: 'VIEWER', username: 'viewer.x' };
    await buildCustomerExport({});
    expect(lastWhere()).toMatchObject({ route: { isTest: false }, region: { isTest: false }, customer: { isTest: false } });
  });

  it('the Steward who asks gets them, and the record says so', async () => {
    h.user = { id: 's1', role: 'STEWARD', username: 'steward.x' };
    await buildCustomerExport({ includeTest: true });
    expect(lastWhere()).not.toHaveProperty('route');
    expect((lastWhere().customer as Record<string, unknown>).isTest).toBeUndefined();
    const recorded = (h.record.mock.calls.at(-1) as unknown as [unknown, { filters: { includeTest: boolean } }])[1];
    expect(recorded.filters.includeTest).toBe(true);
  });

  it('anyone else who asks is ignored, and recorded as false', async () => {
    h.user = { id: 'm1', role: 'MANAGER', username: 'mgr' };
    await buildCustomerExport({ includeTest: true });
    expect(lastWhere()).toMatchObject({ route: { isTest: false }, customer: { isTest: false } });
    const recorded = (h.record.mock.calls.at(-1) as unknown as [unknown, { filters: { includeTest: boolean } }])[1];
    expect(recorded.filters.includeTest).toBe(false);
  });

  it('a test account’s own export keeps its records (a production walk)', async () => {
    h.user = { id: 't1', role: 'VIEWER', username: 'zz.test.viewer' };
    h.viewerIsTest = true;
    await buildCustomerExport({});
    expect(lastWhere()).not.toHaveProperty('route');
  });
});

describe('every surface that must leave them out says so in its source', () => {
  const src = (f: string) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  it.each([
    ['lib/insights/sql.ts', /realBranchSql[\s\S]*realDraftSql[\s\S]*realRequestSql/],
    ['lib/service-status.ts', /realRequestSql\('e'\)/],
    ['lib/change-report.ts', /includeTestRows\(/],
    ['services/customer-export.ts', /filters\.includeTest = includeTestRows\(/],
    ['app/(app)/customers/page.tsx', /filters\.includeTest = includeTestRows\(/],
    ['scripts/ops/verify-load.ts', /testRecordsCheck\(prisma\)/],
  ])('%s', (file, pattern) => {
    expect(src(file)).toMatch(pattern);
  });
});
