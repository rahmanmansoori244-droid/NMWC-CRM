/**
 * UAT ONLY: remove dated history whose record no longer exists.
 *
 *   DIRECT_URL='<the UAT OWNER connection string>' npx tsx scripts/qa/purge-orphan-history.ts \
 *     --expect-host <uat host> [--apply]
 *
 * The dated history (prisma/migrations/20261013100100_history_foundation,
 * docs/HISTORY.md) is kept for ever, and a hard delete leaves a DELETE tombstone
 * by design. On UAT that means every integration suite that creates and deletes
 * fixtures leaves their history behind. The launch e2e harness purges its own
 * (tests/e2e/launch/support/cleanup.ts, step 10), and a converted suite calls
 * purgeHistory (tests/support/audit.ts); this removes what the rest leave: the
 * history of customers, shops, accounts, routes and regions that are gone.
 *
 * NEVER ON PRODUCTION. On production a record is never hard-deleted outside the
 * owner's maintenance window, and its history is the permanent record of it: this
 * refuses a production host outright, whatever the command line says.
 *
 * Dry run by default: counts only. --apply deletes, in one owner maintenance
 * transaction. Prints table names and counts — no ids, no values.
 */
import { PrismaClient } from '@prisma/client';
import { assertNotProduction, pointsAtProduction } from '../lib/assert-not-production';

/** Each history table, its key column and the live table that key names. */
export const ORPHAN_SCOPES = [
  { table: 'CustomerHistory', key: 'customerId', live: 'Customer' },
  { table: 'BranchHistory', key: 'branchId', live: 'Branch' },
  { table: 'UserHistory', key: 'userId', live: 'User' },
  { table: 'RouteOwnerHistory', key: 'routeId', live: 'Route' },
  { table: 'RouteHistory', key: 'routeId', live: 'Route' },
  { table: 'RegionHistory', key: 'regionId', live: 'Region' },
  // Lossless paths (20261014100000): a photo's history, a new-customer request's rounds.
  { table: 'AttachmentHistory', key: 'attachmentId', live: 'Attachment' },
  { table: 'EditRevision', key: 'editId', live: 'CustomerEdit' },
] as const;

/** The WHERE clause that finds a scope's orphans (no live row with that id). */
export function orphanWhere(s: (typeof ORPHAN_SCOPES)[number]): string {
  return `NOT EXISTS (SELECT 1 FROM "${s.live}" l WHERE l."id" = h."${s.key}")`;
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('set DIRECT_URL (the UAT owner connection string)');
    return 2;
  }
  if (pointsAtProduction(url)) {
    console.error(
      'refusing: this is the PRODUCTION database. History is never purged there. Nothing was read or written.'
    );
    return 2;
  }
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const prisma = new PrismaClient({ datasourceUrl: assertNotProduction(url, args) });
  try {
    const counts: Array<[string, number]> = [];
    for (const s of ORPHAN_SCOPES) {
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${s.table}" h WHERE ${orphanWhere(s)}`
      );
      counts.push([s.table, Number(n)]);
    }
    for (const [t, n] of counts)
      console.log(`  ${t.padEnd(18)} ${String(n).padStart(8)} orphan row(s)`);
    if (!apply) {
      console.log('\nDRY RUN — nothing was deleted. Add --apply to delete them.\n');
      return 0;
    }
    const deleted = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
        let total = 0;
        for (const s of ORPHAN_SCOPES) {
          total += await tx.$executeRawUnsafe(`DELETE FROM "${s.table}" h WHERE ${orphanWhere(s)}`);
        }
        return total;
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
    console.log(`\ndeleted ${deleted} orphan history row(s)\n`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (/purge-orphan-history\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(
        `\nPURGE FAILED: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'}\n`
      );
      process.exit(2);
    });
}
