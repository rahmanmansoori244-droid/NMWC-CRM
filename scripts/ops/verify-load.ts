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
    name: 'branches on a worked route have a day of visit',
    why: 'no visit day means the customer never appears on Today, for anyone, ever',
    run: async () => {
      // Scoped to routes that have an active owner, deliberately. Roughly 2,472
      // customers are parked on routes with no recent sales and no salesman (see
      // the runbook, step 0.4); those legitimately carry no visit day and would
      // otherwise drown this check in expected noise. A branch on a route someone
      // actually works and with no day is the reportable case — and it is the
      // symptom the ERP refresh lane used to produce, where a row was counted as
      // promoted while the entire branch loop was skipped.
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Branch" b
        JOIN "Route" r ON r.id = b."routeId"
        WHERE b."deletedAt" IS NULL AND b."dayOfVisit" IS NULL
          AND EXISTS (SELECT 1 FROM "User" u WHERE u."ownedRouteId" = r.id AND u."isActive")`;
      const bad = n(rows[0]?.n);
      const parked = await prisma.branch.count({ where: { deletedAt: null, dayOfVisit: null } });
      return {
        ok: bad === 0,
        detail: `${bad} on a worked route (${parked} overall, parked routes included)`,
        note: bad > 0 ? 'the refresh-lane symptom: promoted, but the branch loop never ran' : undefined,
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
