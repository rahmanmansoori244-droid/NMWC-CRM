/**
 * Record Finance's zero credit limit as a zero, instead of leaving it blank.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/zero-credit-limits.ts \
 *     --expect-host ep-sweet-haze [--apply] [--actor <username>]
 *
 * WHAT THIS IS FOR. The Finance Manager sets a credit customer's limit to ZERO
 * when they stop buying: the account stays a credit account, it simply cannot
 * draw. Over half the dashboard's ar_aging table — 1,576 of 3,052 rows — is in
 * that state. The CRM has those customers as CREDIT with `creditLimit` NULL,
 * which is not the same statement: NULL means nobody recorded one.
 *
 * It matters at the boundary. lib/temix.ts writes
 *   credit_limit: isCredit && c.creditLimit != null ? Number(c.creditLimit) : ''
 * so NULL ships to the ERP as a BLANK CELL and 0 ships as 0. Blank is the
 * ambiguous one, and these customers are already queued for the first Temix
 * upload. Telling an ERP "credit customer, limit unspecified" is not what
 * Finance decided; "credit customer, limit zero" is.
 *
 * WHY IT IS NOT JUST "every CREDIT customer with no limit". That set is bigger
 * and contains a population this script must NOT touch: ~751 customers who are
 * CREDIT in the master with a real RoutePro limit, and are blank on production
 * only because the import's ordinary update lane never writes credit figures.
 * Zeroing those would destroy a live limit. The two are told apart by the
 * master: this script targets only customers the master calls CASH, which is
 * exactly the population whose RoutePro PAY_MODE reads "CASH Only" because a
 * zero-limit account cannot charge. Serving mode is not payment terms — reading
 * one for the other is what made the load reject 1,833 rows all day.
 *
 * NOTHING HERE CHANGES PAYMENT TERMS. It writes `creditLimit` and
 * `paymentTermDays` and nothing else. Terms are approval-owned, the import guard
 * that refused to move them was right, and this script is not a way around it.
 *
 * TARGETS PRODUCTION ON PURPOSE, with the same safety as
 * scripts/ops/requeue-untracked.ts, whose guards it imports rather than copies:
 * --expect-host is required for the dry run too, the dry run resolves the audit
 * actor so it rehearses every refusal --apply has, the write is chunked so an
 * interruption is partial rather than lost, and the ledger gets a STARTING row
 * before the first chunk and a COMPLETED row after the last.
 */
import { PrismaClient, PaymentTerms, type Prisma } from '@prisma/client';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { connectWaking, requireExpectedHost, resolveActor } from './requeue-untracked';

/**
 * The value Finance's decision takes in the CRM.
 *
 * ZERO, not NULL — that is the whole point of the script. And ONE day rather
 * than NULL because verify-load.ts fails a CREDIT customer that carries a limit
 * with no payment-term days ("a limit with no payment-term days is a
 * half-applied credit decision"), so writing the limit alone would turn a
 * passing gate red for 1,770 customers. One day is what the dashboard's
 * ar_aging carries for these rows, and it is what the owner confirmed on
 * 2026-09-23.
 */
const ZERO_LIMIT = 0;
const TERM_DAYS = 1;

/** Rows per UPDATE. Same reasoning as requeue-untracked.ts: the link is WAN-bound. */
const CHUNK = 250;

/**
 * Customers this script may touch, before the master is consulted.
 *
 * `creditLimit: null` is what makes it idempotent and makes it safe to re-run: a
 * row already carrying 0 no longer matches. It is also the clause that stops a
 * second run overwriting a REAL limit that someone granted through the credit
 * chain in between — that customer has a non-null limit and drops out.
 */
export const ZERO_CANDIDATE_WHERE = {
  deletedAt: null,
  paymentTerms: PaymentTerms.CREDIT,
  creditLimit: null,
} satisfies Prisma.CustomerWhereInput;

/**
 * The codes the master calls CASH — the half of the decision that cannot come
 * from the database, and the half that keeps the 751 safe.
 *
 * Read from the built customer master rather than from a dq/ CSV: the CSV is a
 * report of one moment, the workbook is the artefact the load was made from, and
 * this has to be re-derivable months later by someone who has only the repo.
 */
async function cashCodesFromMaster(file: string): Promise<Set<string>> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Customers');
  if (!ws) throw new Error(`${path.basename(file)} has no "Customers" sheet`);
  const head = (ws.getRow(1).values as unknown[])
    .slice(1)
    .map((x) => String(x ?? '').trim());
  const iCode = head.indexOf('cust_code');
  const iTerms = head.indexOf('payment_terms');
  if (iCode < 0 || iTerms < 0) {
    throw new Error('customer master is missing cust_code or payment_terms');
  }
  const cash = new Set<string>();
  const credit = new Set<string>();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = (row.values as unknown[]).slice(1);
    const code = String(v[iCode] ?? '').trim().toUpperCase();
    const terms = String(v[iTerms] ?? '').trim().toUpperCase();
    if (!code) return;
    if (terms === 'CREDIT') credit.add(code);
    else if (terms === 'CASH') cash.add(code);
  });
  // A code appearing as both (multi-branch rows disagreeing) is ambiguous, and
  // the safe reading of ambiguity here is "do not zero it".
  for (const c of credit) cash.delete(c);
  return cash;
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);

  const apply = args.includes('--apply');
  const actorIdx = args.indexOf('--actor');
  const actorArg = actorIdx >= 0 ? (args[actorIdx + 1] ?? '') : '';
  if (actorIdx >= 0 && (!actorArg || actorArg.startsWith('--'))) {
    throw new Error('--actor was passed without a username');
  }

  const masterFile = path.join(
    process.env.GOLIVE_DIR ?? 'golive-data',
    'customer-master.xlsx'
  );
  if (!existsSync(masterFile)) {
    throw new Error(
      `cannot find ${masterFile}. This script needs the built customer master to\n` +
        '  tell a Finance-zeroed credit customer apart from one whose real RoutePro\n' +
        '  limit simply never landed. Rebuild with scripts/golive/build-masters.ts.'
    );
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log(
      apply
        ? 'Mode:   APPLY — rows WILL be written'
        : 'Mode:   DRY RUN — nothing will be written (pass --apply to write)'
    );
    console.log(`Master: ${path.basename(masterFile)}`);
    console.log('='.repeat(76));

    await connectWaking(prisma);

    const candidates = await prisma.customer.findMany({
      where: ZERO_CANDIDATE_WHERE,
      select: { id: true, nmwcCode: true },
      orderBy: { id: 'asc' },
    });
    console.log(`CREDIT customers with no limit recorded:   ${candidates.length}`);

    const cash = await cashCodesFromMaster(masterFile);
    const targets = candidates.filter((c) =>
      cash.has(String(c.nmwcCode ?? '').toUpperCase())
    );
    const skipped = candidates.length - targets.length;
    console.log(`   master says CASH  -> Finance zeroed:    ${targets.length}`);
    console.log(
      `   master says CREDIT -> LEFT ALONE:       ${skipped}   <- these are owed a REAL RoutePro limit, not a zero`
    );

    if (targets.length === 0) {
      console.log('\nNothing to do.');
      console.log('(This is what a second run looks like — the correction is idempotent.)\n');
      return 0;
    }

    console.log('');
    console.log(`Would write: creditLimit = ${ZERO_LIMIT}, paymentTermDays = ${TERM_DAYS}`);
    console.log('             paymentTerms is NOT touched — terms are approval-owned.');

    const actor = await resolveActor(prisma, actorArg);
    console.log(
      `Audit actor: ${actor.username}` + (actorArg ? ' (--actor)' : ' (the one active Steward)')
    );

    if (!apply) {
      console.log('='.repeat(76));
      console.log('DRY RUN — nothing was written. Re-run with --apply to make the change.\n');
      return 0;
    }

    // ONE timestamp for the run, so the ledger row names a set that can be
    // recovered afterwards. Unlike the requeue there is no durable marker on the
    // rows themselves — creditLimit 0 is indistinguishable from a 0 written any
    // other way — so the STARTING row carries the ids' count and the completion
    // row the achieved count, and the full id list goes in the audit payload.
    const at = new Date();
    const ids = targets.map((t) => t.id);
    console.log('='.repeat(76));
    console.log(`Applying as ${actor.username} at ${at.toISOString()}`);

    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'CreditLimitZeroing',
        entityId: at.toISOString(),
        reason:
          `operator script scripts/ops/zero-credit-limits.ts on ${host}: STARTING — about to ` +
          `record creditLimit = ${ZERO_LIMIT} and paymentTermDays = ${TERM_DAYS} on ` +
          `${targets.length} CREDIT customer(s) that the customer master calls CASH. These are ` +
          'accounts whose limit the Finance Manager set to zero because they stopped buying; ' +
          'the CRM held NULL, which the Temix export ships as a blank cell rather than a zero. ' +
          'Payment terms are NOT changed. Customers the master calls CREDIT are excluded — they ' +
          'are owed a real RoutePro limit. If no completion row carries this entityId the run ' +
          'was interrupted and the set is partial. Run outside any session, so ip and userAgent ' +
          'are null by construction.',
        after: {
          phase: 'started',
          intended: targets.length,
          creditLimit: ZERO_LIMIT,
          paymentTermDays: TERM_DAYS,
          leftAlone: skipped,
          host,
          customerIds: ids,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    let done = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const res = await prisma.customer.updateMany({
        // The candidate predicate again, not just the ids: a row that was granted
        // a real limit through the credit chain between the read above and this
        // statement must keep it rather than be zeroed on a stale read.
        where: { id: { in: slice }, ...ZERO_CANDIDATE_WHERE },
        data: {
          creditLimit: ZERO_LIMIT,
          paymentTermDays: TERM_DAYS,
          // `version` is deliberately NOT incremented, matching
          // requeue-untracked.ts: bumping it fails every edit form currently open
          // on one of these customers with a concurrent-edit conflict.
        },
      });
      done += res.count;
      console.log(`  written ${String(done).padStart(6)} of ${ids.length}`);
    }

    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'CreditLimitZeroing',
        entityId: at.toISOString(),
        reason:
          `operator script scripts/ops/zero-credit-limits.ts on ${host}: COMPLETED — ${done} ` +
          `CREDIT customer(s) now carry creditLimit = ${ZERO_LIMIT} and paymentTermDays = ` +
          `${TERM_DAYS}, recording the Finance Manager's zero as a zero rather than as a blank. ` +
          "Pairs with the STARTING row of the same entityId, whose payload holds every id. " +
          'Run outside any session, so ip and userAgent are null by construction.',
        after: {
          phase: 'completed',
          written: done,
          intended: targets.length,
          creditLimit: ZERO_LIMIT,
          paymentTermDays: TERM_DAYS,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const remaining = await prisma.customer.count({
      where: {
        ...ZERO_CANDIDATE_WHERE,
        nmwcCode: { in: targets.map((t) => t.nmwcCode) },
      },
    });
    console.log('='.repeat(76));
    console.log(`Wrote ${done} of ${targets.length}; ${remaining} still match (expected 0).`);
    console.log('');
    console.log('For the record — paste this into the go-live log:');
    console.log('');
    console.log(`  scripts/ops/zero-credit-limits.ts --apply   ${at.toISOString()}`);
    console.log(`  database        ${host}`);
    console.log(`  run as          ${actor.username}`);
    console.log(
      `  written         ${done} CREDIT customer(s): creditLimit ${ZERO_LIMIT}, paymentTermDays ${TERM_DAYS}`
    );
    console.log(`  left alone      ${skipped} CREDIT customer(s) the master gives a real limit`);
    console.log(`  terms           NOT changed`);
    console.log(
      `  audit rows      AuditLog entityType=CreditLimitZeroing entityId=${at.toISOString()} (STARTING + COMPLETED)`
    );
    console.log('');
    console.log('Next: npm run smoke, then npm run verify:load — "every CREDIT customer that');
    console.log('carries a limit also carries terms" must still pass.\n');
    return remaining === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

/** Run only when invoked as a command, so importing this in a test opens no connection. */
if (/zero-credit-limits\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`\nZEROING FAILED: ${e.message}\n`);
      process.exit(2);
    });
}
