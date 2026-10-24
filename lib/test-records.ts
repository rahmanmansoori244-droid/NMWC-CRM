/**
 * Gap 30 (data audit 2026-10-10): the test and synthetic records left in
 * production, and the one rule every figure, export and check applies to them.
 *
 * Customer, User, Route and Region carry an isTest flag (migration
 * 20261024120000_test_records). The migration marked ONLY the known production
 * test records, by exact identity (KNOWN_TEST_RECORDS below, pinned to the
 * migration by tests/unit/test-records.test.ts); nothing was deleted. After that
 * the flag moves only in the owner's maintenance window: a trigger refuses every
 * other writer (docs/OPERATIONS.md section 7 says how the owner flags a new one).
 *
 * The rule: test rows are LEFT OUT of the dashboards, the /status approval
 * figures, the exports, the Temix workbook, verify-load and the nightly data
 * checks, unless
 *   - the viewer's own account is a test account (a production walk with the
 *     zz.test.* actors still sees its own records), or
 *   - the Data Steward explicitly asks (the "Include test records" box on the
 *     export page and the /customers list).
 * The operational queues (/approvals, /work, /home, /reactivations, the
 * notifications) are not filtered, so a walk keeps working end to end.
 *
 * A shop is real when its customer, its route and its region are all real. A
 * request is real when its submitter is not a test account, its customer (if it
 * has one) is not a test customer, and a new-customer request has no draft shop
 * on a test route or in a test region.
 *
 * PURE: no next/* and no lib/db import, so scripts (verify-load) and the
 * integrity checks use the same rule. Aliases are checked against a fixed
 * pattern; nothing here is ever built from a request.
 */
import { Prisma, Role, type PrismaClient } from '@prisma/client';

/** The production test records the migration marked, by exact identity. */
export const KNOWN_TEST_RECORDS = {
  /** Accounts whose username starts with this (the launch e2e actors). */
  usernamePrefix: 'zz.test.',
  /** The test region. */
  regionCode: 'ZZTEST',
  /** The test route. */
  routeCode: 'ZZTEST-R1',
  /** The walk-through customer. */
  customerCode: 'NMWC-2026-000001',
} as const;

/** Prisma: a customer that is not a test record. */
export const REAL_CUSTOMER = { isTest: false } as const satisfies Prisma.CustomerWhereInput;

/** Prisma: a shop whose customer, route and region are all real. */
export const REAL_BRANCH = {
  customer: { isTest: false },
  route: { isTest: false },
  region: { isTest: false },
} as const satisfies Prisma.BranchWhereInput;

/** Prisma: an account that is not a test account. */
export const REAL_USER = { isTest: false } as const satisfies Prisma.UserWhereInput;

function alias(a: string): string {
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(a)) throw new Error(`bad SQL alias ${a}`);
  return a;
}

/** SQL: the shop aliased `b` has a real customer, route and region. */
export function realBranchSql(b: string): Prisma.Sql {
  const t = alias(b);
  return Prisma.raw(
    `(NOT EXISTS (SELECT 1 FROM "Customer" zt_c WHERE zt_c."id" = ${t}."customerId" AND zt_c."isTest")` +
      ` AND NOT EXISTS (SELECT 1 FROM "Route" zt_r WHERE zt_r."id" = ${t}."routeId" AND zt_r."isTest")` +
      ` AND NOT EXISTS (SELECT 1 FROM "Region" zt_g WHERE zt_g."id" = ${t}."regionId" AND zt_g."isTest"))`
  );
}

/**
 * SQL: a new-customer request's draft shop `d`, joined to its route `r`, is on a
 * real route, in a real region (the draft's own and the route's current one).
 */
export function realDraftSql(d: string, r: string): Prisma.Sql {
  const dd = alias(d);
  const rr = alias(r);
  return Prisma.raw(
    `(NOT ${rr}."isTest"` +
      ` AND NOT EXISTS (SELECT 1 FROM "Region" zt_g WHERE zt_g."id" IN (${dd}."regionId", ${rr}."regionId") AND zt_g."isTest"))`
  );
}

/** SQL: the request (CustomerEdit aliased `e`) is a real one (see the header). */
export function realRequestSql(e: string): Prisma.Sql {
  const t = alias(e);
  return Prisma.raw(
    `(NOT EXISTS (SELECT 1 FROM "User" zt_u WHERE zt_u."id" = ${t}."submittedById" AND zt_u."isTest")` +
      ` AND NOT EXISTS (SELECT 1 FROM "Customer" zt_c WHERE zt_c."id" = ${t}."customerId" AND zt_c."isTest")` +
      ` AND NOT EXISTS (SELECT 1 FROM "EditBranchDraft" zt_d JOIN "Route" zt_r ON zt_r."id" = zt_d."routeId"` +
      ` WHERE zt_d."editId" = ${t}."id"` +
      ` AND (zt_r."isTest" OR EXISTS (SELECT 1 FROM "Region" zt_g WHERE zt_g."id" IN (zt_d."regionId", zt_r."regionId") AND zt_g."isTest"))))`
  );
}

/**
 * Whether a view includes test rows: always for a test account's own view, and
 * for the Data Steward when he asks. Anyone else's request is ignored (and an
 * export records it as false).
 */
export function includeTestRows(input: { viewerIsTest: boolean; role: Role | string; requested: boolean }): boolean {
  if (input.viewerIsTest) return true;
  return input.requested && input.role === Role.STEWARD;
}

/** Whether the signed-in account is a test account. A missing account is not. */
export async function viewerIsTest(db: Pick<PrismaClient, 'user'>, userId: string): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { isTest: true } });
  return row?.isTest === true;
}
