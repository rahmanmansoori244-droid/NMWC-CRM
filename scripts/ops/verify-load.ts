/**
 * Did the customer-master load actually land? Read-only, one command.
 *
 *   DIRECT_URL='<owner connection>' npx tsx scripts/ops/verify-load.ts
 *   Optional: --expected-branches N --expected-visit-days N
 *   Defaults come from load-manifest.json. Reconcile its counts with the recorded
 *   pre-load baseline and approved cleanup/journey-plan changes (runbook §6a);
 *   both flags avoid manifest IO. Expectations cover all live branches, not just the load.
 *
 * The in-app reconcile at runbook step 6 proves the BATCH balanced — left to
 * promote is zero, and promoted plus rejected plus quarantined equals the total.
 * That is a statement about the import batch, not about the database. A row can
 * be counted as PROMOTED and still have landed wrong: the narrow ERP refresh lane
 * used to write only credit fields and skip the entire branch loop, so thousands
 * of customers could have been "promoted" with no route, no region and no visit
 * day, and the reconcile would still have balanced.
 *
 * This asks the database instead. Every check is a thing a salesman or a manager
 * would notice the next morning, expressed as a query.
 *
 * WRITES NOTHING. Counts and ids only; no customer names, phone numbers or CR
 * numbers are printed, so the output is safe to paste into a report.
 *
 * Exit 0 when everything passes, 1 when anything fails, 2 on an error.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { GOLIVE_REGION_CODES } from '../../lib/ops/golive-accounts';
import { isDemoAccount } from '../../lib/demo-accounts';
import { canApproveSpecificEdit } from '../../lib/permissions';
import { OperatorRefusal, operatorErrorLabel } from './error-label';

type LoadExpectations = { branches: number; visitDays: number };

const expectationSource =
  'Derive totals from load-manifest.json, or the manifest adjusted by recorded approved changes ' +
  '(cleanup ledger rows, journey-plan fills). Reconcile the recorded pre-load baseline with the ' +
  'underlying master: include retained live branches outside it and their expected visit days; count branches ' +
  'matched by the load only once, including any retained visit day. The quarantine visit-day fill restores ' +
  'days already counted in branchesWithVisitDay, so the expectation does not change. Only an approved ' +
  'no-day -> day change on a branch whose day is not already counted in the expectation adds 1. See GO-LIVE-RUNBOOK §6a. ' +
  'Never copy observed totals merely to pass.';

/** Explicit counts override the corresponding manifest field after an approved cleanup. */
export function loadExpectations(
  args: string[],
  env: { GOLIVE_DIR?: string } = { GOLIVE_DIR: process.env.GOLIVE_DIR }
): LoadExpectations {
  const overrides = new Map<string, number>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--expected-branches', '--expected-visit-days'].includes(flag) || overrides.has(flag)) {
      throw new OperatorRefusal('Use --expected-branches N and/or --expected-visit-days N, once each. ' + expectationSource);
    }
    const value = args[i + 1];
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new OperatorRefusal(`${flag} requires a non-negative integer count. ${expectationSource}`);
    }
    overrides.set(flag, Number(value));
  }

  let manifest: { branchRows?: unknown; branchesWithVisitDay?: unknown } = {};
  if (overrides.size < 2) {
    const manifestPath = path.join(env.GOLIVE_DIR ?? 'golive-data', 'load-manifest.json');
    if (!existsSync(manifestPath)) {
      throw new OperatorRefusal('No load-manifest.json: supply both --expected-branches N and --expected-visit-days N. ' + expectationSource);
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      manifest = parsed;
    } catch {
      throw new OperatorRefusal('Cannot read a valid load-manifest.json; check the manifest or supply both expected counts. ' + expectationSource);
    }
  }
  const branches = overrides.get('--expected-branches') ?? manifest.branchRows;
  const visitDays = overrides.get('--expected-visit-days') ?? manifest.branchesWithVisitDay;
  if (typeof branches !== 'number' || !Number.isSafeInteger(branches) || branches <= 0) {
    throw new OperatorRefusal('Expected branches must be a positive integer (manifest branchRows or --expected-branches). ' + expectationSource);
  }
  if (typeof visitDays !== 'number' || !Number.isSafeInteger(visitDays) || visitDays < 0 || visitDays > branches) {
    throw new OperatorRefusal('Expected visit days must be an integer from 0 to expected branches (manifest branchesWithVisitDay or --expected-visit-days). ' + expectationSource);
  }
  return { branches, visitDays };
}

type Result = { ok: boolean; detail: string; note?: string };
type Check = { name: string; why: string; run: () => Promise<Result> };

const n = (v: unknown) => Number(v ?? 0);

export const loadChecks = (prisma: PrismaClient, expected: LoadExpectations): Check[] => [
  {
    name: 'customers exist',
    why: 'the load either ran or it did not',
    run: async () => {
      const total = await prisma.customer.count({ where: { deletedAt: null } });
      return { ok: total > 0, detail: `${total} live customers` };
    },
  },
  {
    name: 'every live customer has at least one branch',
    why: 'a customer with no branch appears on nobody route and can never be visited',
    run: async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Customer" c
        WHERE c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "Branch" b WHERE b."customerId" = c.id AND b."deletedAt" IS NULL)`;
      const bad = n(rows[0]?.n);
      return {
        ok: bad === 0,
        detail: `${bad} customer(s) with no live branch`,
        note: bad > 0 ? 'the refresh-lane symptom: promoted, but the branch loop never ran' : undefined,
      };
    },
  },
  {
    name: 'every live branch has a route and a region',
    why: 'a branch with no route is invisible to the salesman Today screen',
    run: async () => {
      const rows = await prisma.$queryRaw<{ noroute: bigint; noregion: bigint }[]>`
        SELECT
          count(*) FILTER (WHERE "routeId" IS NULL)  AS noroute,
          count(*) FILTER (WHERE "regionId" IS NULL) AS noregion
        FROM "Branch" WHERE "deletedAt" IS NULL`;
      const noRoute = n(rows[0]?.noroute);
      const noRegion = n(rows[0]?.noregion);
      return { ok: noRoute === 0 && noRegion === 0, detail: `${noRoute} without a route, ${noRegion} without a region` };
    },
  },
  {
    name: 'branch region matches its route region',
    why: 'the B-19 invariant every region-scoped permission check depends on',
    run: async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Branch" b
        JOIN "Route" r ON r.id = b."routeId"
        WHERE b."deletedAt" IS NULL AND b."regionId" <> r."regionId"`;
      const bad = n(rows[0]?.n);
      return { ok: bad === 0, detail: `${bad} mismatched` };
    },
  },
  {
    name: 'live branch and visit-day counts match expectations',
    why: 'no visit day means the customer never appears on Today, for anyone, ever — but only the branches the journey plan actually covers are supposed to have one',
    run: async () => {
      // This replaced "every branch on a worked route has a day of visit", which
      // the source data cannot satisfy: the journey plan covers 6,528 of 20,195
      // branch rows, and 11,204 of the remainder sit on routes that DO have a
      // salesman. That assertion reported a five-figure number on every run and
      // could never go green — and a permanently red gate is one the operator
      // learns to skim past, which is where the real failures are.
      //
      // The refresh-lane symptom it was written for is a customer counted as
      // promoted while its branch loop was skipped. That shows up as days going
      // MISSING against what the master supplied, which is what this asks.
      const withDay = await prisma.branch.count({
        where: { deletedAt: null, dayOfVisit: { not: null } },
      });
      const branches = await prisma.branch.count({ where: { deletedAt: null } });

      // There is deliberately no "a day but no route" check here: Branch.routeId
      // and Branch.regionId are non-nullable in the schema, so the database
      // refuses that row outright. A check for it would pass for the wrong reason
      // — which is the failure mode this whole pass is about.

      const { branches: expectedRows, visitDays: expectedDays } = expected;
      const detail = `${branches < expectedRows ? 'PARTIAL load: ' : ''}${branches} live branches (expected ${expectedRows}); ${withDay} carry a visit day (expected ${expectedDays})`;

      if (withDay === expectedDays) {
        return {
          ok: branches === expectedRows,
          detail,
          note: branches !== expectedRows
            ? 'Branch count mismatch: reconcile the load before re-running. ' + expectationSource
            : undefined,
        };
      }
      if (withDay > expectedDays) {
        return {
          ok: false,
          detail,
          note: 'More branches carry visit days than expected. ' + expectationSource,
        };
      }

      // THIS NOTE STOPS DIAGNOSING, BECAUSE IT CANNOT.
      //
      // It has been wrong twice in one day, both times because it asserted a
      // single cause from a number that cannot identify one:
      //   - it read "the refresh-lane symptom" on 2026-09-23 for a gap of 813
      //     days across 778 customers, of which SEVEN could possibly have taken
      //     the refresh lane; 736 were rows REJECTED by the payment-terms guard,
      //     and a rejected row writes nothing at all.
      //   - rewritten to blame the rejections, it then read "no rejected rows, so
      //     this is the refresh lane" once they were cleared — while the true
      //     cause of the remaining 47 was a QUARANTINE nobody had thought of: 69
      //     rows held for a duplicate phone, 51 of them carrying a visit day.
      //
      // The reason it keeps being wrong is structural, not a wording problem.
      // This check compares two TOTALS — how many branches carry a day, against
      // how many the manifest or explicit expectation says should exist. It never learns WHICH
      // branches are short, because it does not read the master. A number that
      // cannot name a row cannot attribute a cause, and every attempt to make it
      // do so has sent the next reader to the wrong file.
      //
      // So it reports the gap and lists the mechanisms that withhold a day, with
      // their live counts, as LEADS. These do not add up to the gap and are not
      // meant to: a held row whose branch got its day from a sibling row costs
      // nothing, and one held row can account for several days. To attribute
      // properly, line the master up against production per customer — the
      // scratch script that did it on 2026-09-24 is described in
      // docs/OPERATIONS.md §7.
      const lastCustomerBatch = await prisma.importBatch.findFirst({
        where: { kind: 'CUSTOMER' },
        orderBy: { uploadedAt: 'desc' },
        select: { id: true, filename: true, uploadedAt: true },
      });

      // The LATEST batch only. Counting every customer batch double-counts a
      // re-import: the 23 September load ran three times and rejected the same
      // 1,833 rows each time, which this once reported as 3,666 — a number that
      // reads as 3,666 customers and is not one.
      // ONLY COUNTS THAT ARE EXACT AND BOUNDED GO IN. A lead has to narrow the
      // search; a population count widens it. The first draft of this reported
      // "15,395 customers carry a Temix code" against a gap of 14 days, which is
      // not a lead, it is noise wearing a number. The refresh lane is named as a
      // mechanism with NO count for exactly that reason: whether a promoted row
      // took it cannot be derived from these totals, and inventing a figure for it
      // is how this note went wrong the first two times.
      const leads: string[] = [];
      if (lastCustomerBatch) {
        const [rejected, quarantinedWithDay] = await Promise.all([
          prisma.importRow.count({
            where: { state: 'REJECTED', batchId: lastCustomerBatch.id },
          }),
          // A quarantined row is held for review and never promoted, so a day on
          // it never reaches its branch. Count only those CARRYING a day — the
          // rest cannot be responsible for a missing one.
          //
          // Prisma.JsonNull, NOT Prisma.DbNull: DbNull means the `parsed` COLUMN
          // is null, JsonNull means the key inside the JSON is null. The first
          // draft used DbNull and matched all 69 quarantined rows instead of the
          // 51 that carry a day — a filter that looked right and counted the
          // wrong thing, in a note whose whole purpose is not to mislead.
          prisma.importRow.count({
            where: {
              state: 'QUARANTINED',
              batchId: lastCustomerBatch.id,
              NOT: { parsed: { path: ['dayOfVisit'], equals: Prisma.JsonNull } },
            },
          }),
        ]);
        if (rejected > 0) {
          leads.push(`${rejected} row(s) REJECTED — a rejected row writes nothing, branches included`);
        }
        if (quarantinedWithDay > 0) {
          leads.push(
            `${quarantinedWithDay} row(s) QUARANTINED while carrying a visit day — held for review, never promoted`
          );
        }
      }
      leads.push(
        'and a refresh row for a customer that already carries a Temix code skips the branch loop entirely — no count for this one, it cannot be derived from these totals'
      );

      return {
        ok: false,
        detail,
        // No empty-leads branch: the refresh-lane line is always pushed, so one
        // would be unreachable. An unreachable arm of a ternary reads as a handled
        // case and is not one.
        note:
          expectationSource + ' ' +
          'This count cannot say WHICH branches or why — it compares two totals and never reads the master. ' +
          `Places a day gets withheld, as leads rather than an accounting: ${leads.join('; ')}. ` +
          'To attribute it properly, line the master up against production per customer (docs/OPERATIONS.md §7).',
      };
    },
  },
  {
    name: 'no duplicate customer codes among live rows',
    why: 'a case difference between the master and the seed once created a second customer under the same code',
    run: async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM (
          SELECT lower("nmwcCode") k FROM "Customer" WHERE "deletedAt" IS NULL
          GROUP BY lower("nmwcCode") HAVING count(*) > 1
        ) d`;
      const bad = n(rows[0]?.n);
      return { ok: bad === 0, detail: `${bad} duplicated code(s), case-insensitively` };
    },
  },
  {
    name: 'every salesman owns a route, and no route has two owners',
    why: 'a salesman with no route sees nothing; a route with two owners splits the audit trail',
    run: async () => {
      const noRoute = await prisma.user.count({
        where: { role: 'SALESMAN', isActive: true, ownedRouteId: null },
      });
      // ownedRouteId is unique in the schema, so a double-owner cannot exist;
      // this reports routes with NO owner, which is the reachable half. Active
      // routes of active regions only: the ZZTEST route left switched off by the
      // 2026-10-05 production walk, whose test salesman is disabled, is not one.
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Route" r
        JOIN "Region" g ON g.id = r."regionId" AND g."isActive"
        WHERE r."isActive"
          AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."ownedRouteId" = r.id AND u."isActive")`;
      const orphanRoutes = n(rows[0]?.n);
      return {
        ok: noRoute === 0,
        detail: `${noRoute} active salesman without a route; ${orphanRoutes} active route(s) with no active owner`,
        note: orphanRoutes > 0 ? 'an active route with no owner is expected only while it is parked' : undefined,
      };
    },
  },
  {
    name: 'every CREDIT customer that carries a limit also carries terms',
    why: 'a limit with no payment-term days is a half-applied credit decision',
    run: async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Customer"
        WHERE "deletedAt" IS NULL AND "paymentTerms" = 'CREDIT'
          AND "creditLimit" IS NOT NULL AND "paymentTermDays" IS NULL`;
      const bad = n(rows[0]?.n);
      return { ok: bad === 0, detail: `${bad} with a limit but no term days` };
    },
  },
  {
    name: 'no CASH customer is carrying a live credit limit',
    why: 'the Temix export suppresses a CASH customer limit, so the CRM and the ERP would disagree silently',
    run: async () => {
      const bad = await prisma.customer.count({
        where: { deletedAt: null, paymentTerms: 'CASH', creditLimit: { not: null } },
      });
      return { ok: bad === 0, detail: `${bad} CASH customer(s) with a credit limit` };
    },
  },
  {
    name: 'customers with no Temix code are queued for upload',
    why: 'born SYNCED with no code means the ERP never learns the customer exists and cannot invoice it',
    run: async () => {
      const bad = await prisma.customer.count({
        where: { deletedAt: null, temixCode: null, temixSyncState: 'SYNCED' },
      });
      return {
        ok: bad === 0,
        detail: `${bad} customer(s) with no code but marked SYNCED`,
        note: bad > 0 ? 'these will never appear in a Temix batch' : undefined,
      };
    },
  },
  {
    name: 'no account can sign in without having changed its initial password',
    why: 'the forced change is the entire mitigation for a shared or printed initial password',
    run: async () => {
      const stale = await prisma.user.count({
        where: { isActive: true, mustChangePassword: true, lastLoginAt: { not: null } },
      });
      const never = await prisma.user.count({
        where: { isActive: true, mustChangePassword: true, lastLoginAt: null },
      });
      return {
        ok: stale === 0,
        detail: `${never} not yet signed in (expected on load day), ${stale} signed in but still flagged`,
        note: stale > 0 ? 'a re-import can re-arm this flag on people who already changed it' : undefined,
      };
    },
  },
  {
    name: 'no manager is blind',
    why: 'a MANAGER approves the supervisor step by REGION OVERLAP alone — lib/permissions.ts ignores supervisorId for managers and is fail-closed on empty managedRegions — so a manager with no regions cannot clear step 1 for anyone, and step 1 is the first step of every chain',
    run: async () => {
      // Exclude accounts the demo denylist refuses at sign-in. `admin` is seeded
      // with role MANAGER and no regions, and production sets
      // DEMO_ACCOUNTS_DISABLED, so it cannot sign in and cannot be expected to
      // approve anything. Reporting it here would put noise in the one report the
      // operator reads on load day; leftover accounts are audit-accounts.ts's job.
      const blind = (
        await prisma.user.findMany({
          where: { role: 'MANAGER', isActive: true, managedRegions: { none: {} } },
          select: { username: true },
        })
      ).filter((u) => !isDemoAccount(u.username));
      const usable = (
        await prisma.user.findMany({
          where: { role: 'MANAGER', isActive: true },
          select: { username: true },
        })
      ).filter((u) => !isDemoAccount(u.username));
      const total = usable.length;
      return {
        ok: blind.length === 0 && total > 0,
        detail:
          blind.length > 0
            ? `manages NO region: ${blind.map((u) => u.username).join(', ')}`
            : total > 0
              ? `${total} active managers that can sign in, each managing at least one region`
              : 'no active managers that can sign in — was the bootstrap run?',
      };
    },
  },
  {
    name: 'every salesman has an approver who can actually act',
    why: 'the supervisor step needs an active, sign-in-eligible assigned Supervisor or a Manager covering the route region; an unusable assignment without that fallback strands the team',
    run: async () => {
      const approverSelect = {
        id: true, username: true, role: true, isActive: true,
        managedRegions: { select: { id: true } },
      } as const;
      const salesmen = await prisma.user.findMany({
        where: { role: 'SALESMAN', isActive: true },
        select: {
          id: true,
          username: true,
          supervisorId: true,
          ownedRoute: { select: { code: true, regionId: true } },
          supervisor: { select: approverSelect },
        },
      });
      const managers = await prisma.user.findMany({
        where: { role: 'MANAGER', isActive: true },
        select: approverSelect,
      });
      const stranded = salesmen
        .filter((s) => {
          const candidates = s.supervisor ? [s.supervisor, ...managers] : managers;
          // Use the application's actual supervisor-step rule, including its
          // unassigned regional Manager fallback. Readiness already excludes
          // demo-denied accounts; a password-change flag is not ineligibility.
          return !candidates.some((actor) => actor.isActive && !isDemoAccount(actor.username) &&
            canApproveSpecificEdit(actor, s, {
              customerBranches: s.ownedRoute ? [{ regionId: s.ownedRoute.regionId, deletedAt: null }] : [],
              managedRegionIds: actor.managedRegions.map((r) => r.id),
            }));
        })
        .map((s) => `${s.username} (no eligible assigned Supervisor or regional Manager${s.ownedRoute ? ` for ${s.ownedRoute.code}` : '; no route'})`);
      return {
        ok: stranded.length === 0 && salesmen.length > 0,
        detail:
          stranded.length > 0
            ? `cannot be approved: ${stranded.join('; ')}`
            : salesmen.length > 0
              ? `${salesmen.length} salesmen, each with an eligible assigned Supervisor or regional Manager`
              : 'no active salesmen at all',
      };
    },
  },
  {
    name: 'every region has an active accountant',
    why: 'the CASH and CREDIT chains both end at the accountant who manages the request region; a region without one strands every new customer submitted there, and the symptom is an empty queue, which looks like a quiet day',
    run: async () => {
      // Active regions only: a switched-off region takes no requests, and the
      // ZZTEST region left inactive by the 2026-10-05 production walk was
      // reported here as a region with no accountant on every run.
      const regions = await prisma.region.findMany({
        where: { code: { not: 'UNASSIGNED' }, isActive: true },
        select: { code: true, managers: { where: { isActive: true, role: 'ACCOUNTANT' }, select: { username: true } } },
      });
      const uncovered = regions.filter((r) => r.managers.length === 0).map((r) => r.code);
      // Assert the COUNT too. With no regions loaded there are no uncovered
      // regions, so the check would pass on an empty database — satisfied by the
      // absence of the thing it is checking.
      const expected = GOLIVE_REGION_CODES.length;
      const ok = uncovered.length === 0 && regions.length === expected;
      return {
        ok,
        detail:
          uncovered.length > 0
            ? `NO ACTIVE ACCOUNTANT for: ${uncovered.join(', ')}`
            : regions.length === expected
              ? `${regions.length} regions, each with at least one active accountant`
              : `${regions.length} regions found, expected ${expected} — was the Regions sheet imported?`,
      };
    },
  },
  {
    name: 'no accountant is blind',
    why: 'an ACCOUNTANT with no managed region is fail-closed everywhere — it signs in normally and sees an empty approval queue for good, which is exactly what a silently dropped region_code produces',
    run: async () => {
      const blind = await prisma.user.findMany({
        where: { role: 'ACCOUNTANT', isActive: true, managedRegions: { none: {} } },
        select: { username: true },
      });
      // Zero accountants would mean none is blind, so require at least one. NOT
      // an exact count: the go-live issues one per region, but a second added
      // later for cover is legitimate and must not turn this red. Whether every
      // region is actually covered is the check above.
      const total = await prisma.user.count({ where: { role: 'ACCOUNTANT', isActive: true } });
      const expected = GOLIVE_REGION_CODES.length;
      return {
        ok: blind.length === 0 && total > 0,
        detail:
          blind.length > 0
            ? `manages NO region: ${blind.map((u) => u.username).join(', ')}`
            : total === 0
              ? `no active accountants at all — expected ${expected}, one per region`
              : `${total} active accountant(s), each managing at least one region${total === expected ? '' : ` (the go-live issues ${expected}, one per region)`}`,
      };
    },
  },
  ...(['FINANCE_MANAGER', 'GM'] as const).map(
    (role): Check => ({
      name: `an active ${role === 'GM' ? 'GM' : 'Finance Manager'} past the password change`,
      why: `every CREDIT request has a GLOBAL ${role} step, told to every active ${role} (lib/notifications.ts); with none, or none who can get past the forced password change, each one waits on nobody and the queue just looks quiet`,
      run: async () => {
        // Demo-denied accounts cannot sign in where production runs
        // (lib/demo-accounts.ts), so they do not count, as for the managers above.
        const holders = (
          await prisma.user.findMany({
            where: { role, isActive: true },
            select: { username: true, mustChangePassword: true },
          })
        ).filter((u) => !isDemoAccount(u.username));
        const ready = holders.filter((u) => !u.mustChangePassword);
        return {
          ok: ready.length > 0,
          detail:
            ready.length > 0
              ? `${ready.length} active ${role} account(s) past the forced password change`
              : holders.length > 0
                ? `${holders.length} active ${role} account(s), none has changed the hand-out password yet`
                : `no active ${role} account at all`,
          note:
            ready.length === 0 && holders.length > 0
              ? 'expected before the first sign-in: re-run once that person has signed in and changed the password'
              : undefined,
        };
      },
    })
  ),
  {
    name: 'the append-only ledger is not empty',
    why: 'a load that wrote no audit rows means the trail everything else depends on was not recorded',
    run: async () => {
      const rows = await prisma.$queryRaw<{ n: bigint; latest: Date | null }[]>`
        SELECT count(*) AS n, max("at") AS latest FROM "AuditLog"`;
      const total = n(rows[0]?.n);
      const latest = rows[0]?.latest;
      return {
        ok: total > 0,
        detail: `${total} audit rows, newest ${latest ? latest.toISOString().slice(0, 10) : 'none'}`,
      };
    },
  },
];

export async function runChecks(checks: Check[]): Promise<number> {
  let failed = 0;
  for (const c of checks) {
    let r: Result;
    try {
      r = await c.run();
    } catch (err) {
      r = { ok: false, detail: `query failed: ${operatorErrorLabel(err)}` };
    }
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(52)} ${r.detail}`);
    if (r.note) console.log(`      note: ${r.note}`);
    if (!r.ok) console.log(`      why it matters: ${c.why}`);
  }

  console.log('='.repeat(76));
  if (failed === 0) {
    console.log(`all ${checks.length} checks passed\n`);
    return 0;
  }
  console.log(`${failed} of ${checks.length} FAILED — do not hand out logins until these are understood\n`);
  return 1;
}

async function main(): Promise<number> {
  const expected = loadExpectations(process.argv.slice(2));
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  let host = '?';
  try { host = new URL(url ?? '').hostname; } catch { /* The client reports invalid configuration. */ }
  const prisma = new PrismaClient({
    datasourceUrl: url,
  });
  try {
    console.log(`\nLoad verification — ${host}`);
    console.log(`Expected: ${expected.branches} live branches, ${expected.visitDays} with a visit day`);
    console.log('='.repeat(76));
    return await runChecks(loadChecks(prisma, expected));
  } finally {
    await prisma.$disconnect();
  }
}

// Importing for unit tests must neither read a private manifest nor connect to a database.
if (/verify-load\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`\nverify-load failed: ${operatorErrorLabel(err)}\n`);
      process.exit(2);
    });
}
