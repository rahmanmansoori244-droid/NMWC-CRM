/**
 * Export the payment terms the CRM currently holds, for the master builder.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/export-crm-terms.ts \
 *     --expect-host ep-sweet-haze
 *
 * WHY THIS EXISTS. Payment terms are approval-owned. services/imports.ts says so
 * twice over: the update lane deliberately does not write `paymentTerms` for an
 * existing customer, and the guard above it REJECTS any row whose terms disagree
 * with what is stored, because a spreadsheet must not grant or withdraw credit
 * standing.
 *
 * The 23 September load showed what that costs when the master disagrees anyway.
 * 1,833 rows were rejected on that guard, and a rejected row writes NOTHING — so
 * those customers also lost their branch updates and their journey-plan visit
 * days, which is 95% of the 816 days the load was missing. The terms were never
 * going to change either way; the rejection threw away everything else in the row
 * as collateral.
 *
 * The disagreement is not a data error the sources can settle. Those customers
 * are credit accounts whose limit the Finance Manager set to zero because they
 * stopped buying; RoutePro's PAY_MODE reads "CASH Only" for them because a
 * zero-limit account cannot charge, which is serving mode, not terms. Nothing
 * available locally distinguishes the two: the dashboard's ar_aging holds only
 * 138 of the 1,770, the Temix master has no terms column at all, and the
 * Code-Branch sheet's `Max Credit Amount Lc` is blank on all 10,410 of its rows.
 *
 * So the builder stops guessing for customers the CRM already knows, and takes
 * the CRM's answer. That is not a fudge to make the import pass — it is the same
 * rule the guard enforces, applied one step earlier, where it costs nothing
 * instead of costing a whole row.
 *
 * Read-only. Writes one CSV of codes and terms; no PII, no figures, no limits.
 */
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectWaking, requireExpectedHost } from './requeue-untracked';

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);

  const out = path.join(process.env.GOLIVE_DIR ?? 'golive-data', 'crm-payment-terms.csv');
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log('='.repeat(76));
    await connectWaking(prisma);

    // Live rows only. A soft-deleted customer is not one the import will meet,
    // and carrying its terms forward would resurrect a decision about an account
    // somebody archived.
    const rows = await prisma.customer.findMany({
      where: { deletedAt: null },
      select: { nmwcCode: true, paymentTerms: true },
      orderBy: { nmwcCode: 'asc' },
    });

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.paymentTerms, (counts.get(r.paymentTerms) ?? 0) + 1);

    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(
      out,
      'cust_code,payment_terms\n' +
        rows.map((r) => `"${r.nmwcCode}","${r.paymentTerms}"`).join('\n') +
        '\n',
      'utf8'
    );

    console.log(`live customers exported: ${rows.length}`);
    for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
    console.log(`\nwritten: ${out}`);
    console.log('\nNext: rebuild with scripts/golive/build-masters.ts — it reads this file');
    console.log('and reports every code where it overrode what the sources derived.\n');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (/export-crm-terms\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`\nEXPORT FAILED: ${e.message}\n`);
      process.exit(2);
    });
}
