/**
 * Did the customer-master load actually land? Read-only, one command.
 *
 *   DIRECT_URL='<owner connection>' npx tsx scripts/ops/verify-load.ts
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
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { GOLIVE_REGION_CODES } from '../../lib/ops/golive-accounts';
import { isDemoAccount } from '../../lib/demo-accounts';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

type Result = { ok: boolean; detail: string; note?: string };
type Check = { name: string; why: string; run: () => Promise<Result> };

const n = (v: unknown) => Number(v ?? 0);

const checks: Check[] = [
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
    name: 'the load kept the visit days the master gave it',
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

      const manifestPath = path.join(process.env.GOLIVE_DIR ?? 'golive-data', 'load-manifest.json');
      if (!existsSync(manifestPath)) {
        return {
          ok: withDay > 0,
          detail: `${withDay} of ${branches} branches carry a visit day — no load-manifest.json, so the expected figure is unknown. Rebuild with scripts/golive/build-masters.ts to enable the exact comparison.`,
          note: withDay === 0 ? 'NO branch carries a visit day — the journey-plan step did not run' : undefined,
        };
      }

      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        branchRows?: number;
        branchesWithVisitDay?: number;
      };
      const expectedRows = m.branchRows ?? 0;
      const expectedDays = m.branchesWithVisitDay ?? 0;
      const complete = branches >= expectedRows && expectedRows > 0;

      if (!complete) {
        // A rehearsal inside a time box legitimately loads a subset.
        return {
          ok: true,
          detail: `PARTIAL load: ${branches} of ${expectedRows} branch rows present, ${withDay} carrying a visit day (the full master supplies ${expectedDays}). Not compared — finish the load, then re-run.`,
        };
      }

      if (withDay === expectedDays) {
        return {
          ok: true,
          detail: `${withDay} branches carry a visit day, exactly what the master supplied`,
        };
      }

      // WHY THIS NOTE CHANGED, 2026-09-23. It used to read "the refresh-lane
      // symptom: promoted, but the branch loop never ran", and that was simply
      // wrong — it named the cause the check had been WRITTEN for rather than
      // the one actually producing the number, and it sent the first person to
      // read it after the real load looking in the wrong file.
      //
      // Measured on production the day of the load, 813 missing days across 778
      // customers: 7 of those customers carried a Temix code, so at most 7 could
      // have taken the refresh lane. 736 of the 778 — 95% — had a row REJECTED
      // by the payment-terms guard below, and a rejected row writes nothing at
      // all: no customer update, no branches, no visit day. The branch loop did
      // not skip; it never got there.
      //
      // Both causes are real and the count alone cannot tell them apart, so the
      // note names both and says which one to rule out first rather than
      // asserting a single diagnosis. Whoever rewrites this: check it against
      // the rejected rows before you narrow it again.
      // The LATEST customer batch only. Counting every customer batch double-counts
      // a re-import: the 23 September load ran twice and rejected the same 1,833
      // rows each time, which this reported as 3,666 — a number that reads as 3,666
      // customers and is not one. What matters is the state the last promote left.
      const lastCustomerBatch = await prisma.importBatch.findFirst({
        where: { kind: 'CUSTOMER' },
        orderBy: { uploadedAt: 'desc' },
        select: { id: true },
      });
      const rejected = lastCustomerBatch
        ? await prisma.importRow.count({
            where: { state: 'REJECTED', batchId: lastCustomerBatch.id },
          })
        : 0;
      return {
        ok: false,
        detail: `${withDay} branches carry a visit day; the master supplied ${expectedDays} — ${expectedDays - withDay} went missing in the load`,
        note:
          rejected > 0
            ? `the last customer batch REJECTED ${rejected} row(s), which wrote nothing at all — that is where most of these go, so read the rejections first, not the refresh lane`
            : 'no rejected rows in the last customer batch, so this is the refresh-lane symptom: promoted, but the branch loop never ran',
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
      // this reports routes with NO owner, which is the reachable half.
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Route" r
        WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."ownedRouteId" = r.id AND u."isActive")`;
      const orphanRoutes = n(rows[0]?.n);
      return {
        ok: noRoute === 0,
        detail: `${noRoute} active salesman without a route; ${orphanRoutes} route(s) with no active owner`,
        note: orphanRoutes > 0 ? 'routes with no owner are expected for parked/inactive routes' : undefined,
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
    why: 'the supervisor step is the first step of every chain; a manager clears it only if they manage the region the salesman route sits in, so a correct-looking supervisor assignment with the wrong regions stalls that team silently',
    run: async () => {
      const salesmen = await prisma.user.findMany({
        where: { role: 'SALESMAN', isActive: true },
        select: {
          username: true,
          ownedRoute: { select: { code: true, regionId: true } },
          supervisor: {
            select: { username: true, role: true, managedRegions: { select: { id: true } } },
          },
        },
      });
      const stranded = salesmen
        .filter((s) => {
          if (!s.supervisor) return true;
          // A real SUPERVISOR clears the step by the direct relationship, which
          // this salesman already has by virtue of supervisorId pointing at them.
          if (s.supervisor.role === 'SUPERVISOR') return false;
          if (!s.ownedRoute) return true;
          return !s.supervisor.managedRegions.some((r) => r.id === s.ownedRoute!.regionId);
        })
        .map((s) =>
          !s.supervisor
            ? `${s.username} (no supervisor)`
            : !s.ownedRoute
              ? `${s.username} (no route)`
              : `${s.username} → ${s.supervisor.username} (does not manage the ${s.ownedRoute.code} region)`
        );
      return {
        ok: stranded.length === 0 && salesmen.length > 0,
        detail:
          stranded.length > 0
            ? `cannot be approved: ${stranded.join('; ')}`
            : salesmen.length > 0
              ? `${salesmen.length} salesmen, each with an approver whose regions cover their route`
              : 'no active salesmen at all',
      };
    },
  },
  {
    name: 'every region has an active accountant',
    why: 'the CASH and CREDIT chains both end at the accountant who manages the request region; a region without one strands every new customer submitted there, and the symptom is an empty queue, which looks like a quiet day',
    run: async () => {
      const regions = await prisma.region.findMany({
        where: { code: { not: 'UNASSIGNED' } },
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

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  console.log(`\nLoad verification — ${host}`);
  console.log('='.repeat(76));

  let failed = 0;
  for (const c of checks) {
    let r: Result;
    try {
      r = await c.run();
    } catch (err) {
      r = { ok: false, detail: `query failed: ${(err as Error).message}` };
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

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`\nverify-load failed: ${(err as Error).message}\n`);
    await prisma.$disconnect();
    process.exit(2);
  });
