/**
 * The dated history's record-keeping report (gap 24; docs/HISTORY.md): changes
 * recorded with no cause, and whether every history trigger is present and on.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/history-report.ts \
 *     --expect-host <host> [--days 30]
 *
 * Every write path names its cause (lib/change-context.ts); the database records
 * a write that did not as source 'sql'. Zero is expected. A row written by the
 * runtime role (nmwc_app) is an application path missing its change context, a
 * defect to fix; a row written by any other login is SQL typed by hand, or a
 * script that does not name its run. The same figures as the Steward's card on
 * /status and the /api/health warnings (lib/history-report.ts).
 *
 * Read-only: SELECTs only, inside a READ ONLY transaction. Prints table names,
 * Oman days, logins, counts and history row ids — no customer and no person.
 * Exit 0 when nothing is unattributed and every trigger is present and enabled,
 * 1 when something needs a look, 2 when it could not run.
 */
import { PrismaClient } from '@prisma/client';
import { connectWaking, requireExpectedHost } from './requeue-untracked';
import { OperatorRefusal, operatorErrorLabel } from './error-label';
import {
  RUNTIME_ROLE,
  loadHistoryHealth,
  loadUnattributed,
  summarize,
} from '../../lib/history-report';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `--days N`, 1 to 3650 (default 30). */
export function parseDays(args: string[]): number {
  const i = args.indexOf('--days');
  if (i < 0) return 30;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new OperatorRefusal('--days takes a whole number of days from 1 to 3650.');
  }
  return n;
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new OperatorRefusal('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);
  const days = parseDays(args);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log('='.repeat(76));
    await connectWaking(prisma);
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const { rows, warnings } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return {
          rows: await loadUnattributed(tx, since),
          warnings: await loadHistoryHealth(tx, now),
        };
      },
      { timeout: 60_000 }
    );
    const report = summarize(since, rows);
    console.log(
      `Changes with no recorded cause, last ${days} day(s): ${report.fromApp + report.fromOther}`
    );
    console.log(
      `  by the application (${RUNTIME_ROLE}):  ${report.fromApp}   <- a path missing its change context: a defect`
    );
    console.log(
      `  by any other login:         ${report.fromOther}   <- SQL typed by hand, or a script that does not name its run`
    );
    for (const r of rows) {
      console.log(
        `    ${r.day}  ${r.table.padEnd(18)} ${r.dbUser.padEnd(14)} ${String(r.n).padStart(6)}  rows ${r.sampleIds.join(', ')}`
      );
    }
    console.log(
      warnings.length
        ? `Health warnings: ${warnings.join(', ')}`
        : 'History triggers: all present and enabled'
    );
    console.log('');
    return report.fromApp + report.fromOther === 0 && warnings.length === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (/history-report\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nHISTORY REPORT FAILED: ${operatorErrorLabel(e)}\n`);
      process.exit(2);
    });
}
