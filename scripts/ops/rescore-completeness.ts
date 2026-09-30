/**
 * Bring every stored completeness score back to what lib/completeness.ts makes
 * of its row — once, after the deploy that fixed the import's scoring.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/rescore-completeness.ts \
 *     --expect-host <host marker> [--apply --actor <steward username>] [--chunk 200]
 *
 *   or: npm run ops:rescore-completeness -- --expect-host <host marker> [--apply --actor <username>]
 *
 * WHY. Auditor recheck 2026-09-27, F21 part 2. The customer import's promote
 * rescored only the Customer row: a branch it created kept the column default of
 * 0, and one whose address, visit day, status or route it changed kept its old
 * score, unless a later edit, photo or reactivation rescored that customer.
 * Branch.completenessScore is what the dashboard's region and route leaderboards
 * and the branch ring read, so the go-live load left them understated. The
 * promote now rescores every live branch of each customer it touches
 * (lib/rescore.ts); this repairs what the earlier loads left behind.
 * scripts/ops/apply-quarantined-visit-days.ts wrote Branch.dayOfVisit (+5) with
 * no rescore, and its branches are among the stale ones this repairs.
 *
 * WHAT IT WRITES. Customer.completenessScore and Branch.completenessScore, on
 * live customers and their live branches, and nothing else — "live" as it stands
 * once the page's locks are held, so a customer archived or merged away while
 * the page waited is left alone — through lib/rescore.ts, the same code the
 * promote runs: raw SQL that writes a row only when its score differs, so
 * updatedAt stays as it was (the master export's "updated since" filter reads the
 * customer's) and `version` is never bumped (a derived column must not make a
 * concurrent edit's versioned write fail). No Temix requeue, no lastEditedById.
 *
 * UNDER LOAD. Each page of customers is one transaction that first takes their
 * row locks in the one order lib/locks.ts gives (lockCustomersAndTemixCodeHolders,
 * as archive and merge take them), then reads and scores them. A writer of a
 * scored field that takes the same customer lock — an edit, a photo, a
 * reactivation, the import — is waited for, not skipped, and cannot interleave.
 * apply-quarantined-visit-days.ts takes no customer lock: do not run the two at
 * the same time.
 *
 * COUNTS ONLY. It prints, and its ledger rows carry, how many scores move and by
 * how much in aggregate — never a customer's name, code, phone or id.
 *
 * TARGETS ANY DATABASE, NAMED. The safety is requeue-untracked.ts's, whose
 * guards it imports: --expect-host is required for the dry run too, and the
 * connection is refused when its host does not contain the marker. --apply
 * requires --actor, a real active Steward, and a dry run given --actor resolves
 * it too, so the rehearsal meets the refusal --apply would. The ledger gets a
 * STARTING row before the first page and a COMPLETED row, with the counts
 * written, as soon as the last page commits; each page commits on its own, so
 * an interrupted run is re-run, and a second run reports nothing to do.
 *
 * THE CHECK. After COMPLETED it reads and scores every live customer again, as
 * the dry run does, and prints how many stored scores still differ; it is not
 * recorded, so a failure of the check cannot lose the ledger row or the counts.
 * --apply exits 0 when the check finds none; 1 when some differ again (most
 * likely something wrote a scored field without rescoring while this ran:
 * --apply again); 2 when the check failed (the scores are written: run the dry
 * run) or the run itself did.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { lockCustomersAndTemixCodeHolders } from '../../lib/locks';
import {
  planRescore,
  rescoreCustomerTx,
  RESCORE_CUSTOMER_SELECT,
  type RescorePlan,
} from '../../lib/rescore';
import { connectWaking, requireExpectedHost, resolveActor } from './requeue-untracked';
import { OperatorRefusal, operatorErrorLabel } from './error-label';

/** Customers per page: one read of them and their branches, one transaction each. */
export const DEFAULT_CHUNK = 200;
const MAX_CHUNK = 1_000;

export type RescoreOptions = { apply: boolean; actor: string; chunk: number };

/** The flags, checked before anything connects. */
export function parseRescoreArgs(args: readonly string[]): RescoreOptions {
  const apply = args.includes('--apply');
  const actorIdx = args.indexOf('--actor');
  const actor = actorIdx >= 0 ? (args[actorIdx + 1] ?? '') : '';
  if (actorIdx >= 0 && (!actor || actor.startsWith('--'))) {
    throw new OperatorRefusal('--actor was passed without a username');
  }
  if (apply && !actor) {
    throw new OperatorRefusal(
      '--apply needs --actor <steward username>: the ledger rows name the Steward\n' +
        '  accountable for the change, and there is no system user to default to.'
    );
  }
  const chunkIdx = args.indexOf('--chunk');
  let chunk = DEFAULT_CHUNK;
  if (chunkIdx >= 0) {
    const raw = args[chunkIdx + 1] ?? '';
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MAX_CHUNK) {
      throw new OperatorRefusal(`--chunk needs a whole number from 1 to ${MAX_CHUNK}, e.g. --chunk 200`);
    }
    chunk = Number(raw);
  }
  return { apply, actor, chunk };
}

/**
 * The connection and the flags, from the command line and the environment,
 * refused before any client exists: the owner URL (DIRECT_URL, as every
 * operator script uses; DATABASE_URL only as the fallback they share), and the
 * host marker it must match. The URL itself is never printed, only its host.
 */
export function prepare(
  args: readonly string[],
  env: Record<string, string | undefined>
): { url: string; host: string; opts: RescoreOptions } {
  const url = env.DIRECT_URL ?? env.DATABASE_URL ?? '';
  if (!url) throw new OperatorRefusal('set DIRECT_URL (preferred) or DATABASE_URL');
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost([...args], url, host);
  return { url, host, opts: parseRescoreArgs(args) };
}

/** What a run found, as counts. */
export type RescoreTally = {
  customersScanned: number;
  branchesScanned: number;
  customersUp: number;
  customersDown: number;
  customerPointsUp: number;
  customerPointsDown: number;
  branchesUp: number;
  branchesDown: number;
  branchPointsUp: number;
  branchPointsDown: number;
  /** Branch scores to change that are stored as 0: mostly branches the import created. */
  branchesFromZero: number;
};

export function emptyTally(): RescoreTally {
  return {
    customersScanned: 0,
    branchesScanned: 0,
    customersUp: 0,
    customersDown: 0,
    customerPointsUp: 0,
    customerPointsDown: 0,
    branchesUp: 0,
    branchesDown: 0,
    branchPointsUp: 0,
    branchPointsDown: 0,
    branchesFromZero: 0,
  };
}

/** Adds one page's plan to the tally. Only counts are kept — no id leaves the plan. */
export function addToTally(t: RescoreTally, plan: RescorePlan): RescoreTally {
  t.customersScanned += plan.customersScanned;
  t.branchesScanned += plan.branchesScanned;
  for (const m of plan.customers) {
    if (m.to > m.from) {
      t.customersUp += 1;
      t.customerPointsUp += m.to - m.from;
    } else {
      t.customersDown += 1;
      t.customerPointsDown += m.from - m.to;
    }
  }
  for (const m of plan.branches) {
    if (m.to > m.from) {
      t.branchesUp += 1;
      t.branchPointsUp += m.to - m.from;
    } else {
      t.branchesDown += 1;
      t.branchPointsDown += m.from - m.to;
    }
    if (m.from === 0) t.branchesFromZero += 1;
  }
  return t;
}

/** How many stored scores the tally would change. */
export function scoresToChange(t: RescoreTally): number {
  return t.customersUp + t.customersDown + t.branchesUp + t.branchesDown;
}

/** The dry run's report: counts only. */
export function formatTally(t: RescoreTally): string[] {
  const moves = (n: number, up: number, down: number, pUp: number, pDown: number) =>
    `${n} (${up} up, ${down} down; +${pUp} / -${pDown} points)`;
  return [
    `Live customers scanned:           ${t.customersScanned}`,
    `  scores to change:               ${moves(
      t.customersUp + t.customersDown,
      t.customersUp,
      t.customersDown,
      t.customerPointsUp,
      t.customerPointsDown
    )}`,
    `Live branches scanned:            ${t.branchesScanned}`,
    `  scores to change:               ${moves(
      t.branchesUp + t.branchesDown,
      t.branchesUp,
      t.branchesDown,
      t.branchPointsUp,
      t.branchPointsDown
    )}`,
    `    of which stored as 0:         ${t.branchesFromZero}`,
  ];
}

/** Live customers by id, one page at a time (keyset, so a page never shifts under a write). */
async function livePage(
  prisma: PrismaClient,
  after: string | null,
  take: number
): Promise<string[]> {
  const rows = await prisma.customer.findMany({
    where: { deletedAt: null, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' },
    take,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** The same page, with what scoring reads. */
function scoredPage(prisma: PrismaClient, after: string | null, take: number) {
  return prisma.customer.findMany({
    where: { deletedAt: null, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' },
    take,
    select: RESCORE_CUSTOMER_SELECT,
  });
}

/** Reads every live customer's scores and tallies what a rescore would change. Writes nothing. */
async function survey(prisma: PrismaClient, chunk: number): Promise<RescoreTally> {
  const tally = emptyTally();
  let after: string | null = null;
  for (;;) {
    const page = await scoredPage(prisma, after, chunk);
    if (page.length === 0) break;
    addToTally(tally, planRescore(page));
    if (page.length < chunk) break;
    after = page[page.length - 1].id;
  }
  return tally;
}

/**
 * The run, with the client handed in, so tests/unit/rescore-completeness.test.ts
 * can drive it without a database. Returns the process exit code.
 */
export async function run(
  opts: RescoreOptions,
  prisma: PrismaClient,
  host: string,
  log: (line: string) => void = console.log
): Promise<number> {
  log(`\nTarget: ${host}`);
  log(
    opts.apply
      ? 'Mode:   APPLY — scores WILL be written'
      : 'Mode:   DRY RUN — nothing will be written (pass --apply --actor <steward> to write)'
  );
  log('='.repeat(76));
  await connectWaking(prisma);

  const before = await survey(prisma, opts.chunk);
  for (const line of formatTally(before)) log(line);

  if (scoresToChange(before) === 0) {
    log('\nNothing to do: every stored score is what lib/completeness.ts makes of its row.');
    log('(This is what a second run looks like — the rescore is idempotent.)\n');
    return 0;
  }

  // Resolved before the dry run returns when it is named, so the rehearsal
  // meets the refusal --apply would (requeue-untracked.ts explains why).
  const actor = opts.actor ? await resolveActor(prisma, opts.actor) : null;
  if (actor) log(`Audit actor:                      ${actor.username} (--actor)`);

  if (!opts.apply || !actor) {
    log('='.repeat(76));
    log(
      'DRY RUN — nothing was written. Re-run with --apply --actor <steward> to make the change.\n'
    );
    return 0;
  }

  const at = new Date();
  log('='.repeat(76));
  log(`Applying as ${actor.username} at ${at.toISOString()}`);

  // The claim row first, so a run that dies halfway is still in the ledger.
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: 'UPDATE',
      entityType: 'CompletenessRescore',
      entityId: at.toISOString(),
      reason:
        `operator script scripts/ops/rescore-completeness.ts on ${host}: STARTING — about to ` +
        `rewrite completenessScore on ${before.customersUp + before.customersDown} customer(s) ` +
        `and ${before.branchesUp + before.branchesDown} branch(es) whose stored score is not what ` +
        'lib/completeness.ts makes of the row (auditor recheck F21: the import had rescored only ' +
        'the customer). Only the score column is written; updatedAt and version are left as they ' +
        'were, and a later re-run recomputes the same values from the rows. Counts only. Run ' +
        'outside any session, so ip and userAgent are null by construction.',
      after: { phase: 'started', ...before, host } as unknown as Prisma.InputJsonValue,
    },
  });

  let pageAfter: string | null = null;
  let pages = 0;
  const written = { customers: 0, branches: 0 };
  for (;;) {
    const ids = await livePage(prisma, pageAfter, opts.chunk);
    if (ids.length === 0) break;
    const res = await prisma.$transaction(
      async (tx) => {
        await lockCustomersAndTemixCodeHolders(tx, ids, null);
        // The page was read before the lock. A customer archived, or merged
        // away, while the page waited for it is locked all the same (the lock
        // matches on id), and lib/rescore.ts does not filter archived ones —
        // it would have scored it with no live branches and written that onto
        // the archived row (review of phase 2). Only the ids still live now.
        const live = (
          await tx.customer.findMany({
            where: { id: { in: ids }, deletedAt: null },
            select: { id: true },
          })
        ).map((r) => r.id);
        return rescoreCustomerTx(tx, live);
      },
      { timeout: 20_000, maxWait: 10_000 }
    );
    written.customers += res.written.customers;
    written.branches += res.written.branches;
    pages += 1;
    if (pages % 10 === 0) log(`  pages ${String(pages).padStart(5)} done`);
    // Paged on the ids as read, not the live ones: the cursor does not move
    // because a customer of this page was archived meanwhile.
    if (ids.length < opts.chunk) break;
    pageAfter = ids[ids.length - 1];
  }

  // Preserve committed counts even if the COMPLETED insert fails.
  log('='.repeat(76));
  log(
    `Wrote ${written.customers} customer score(s) and ${written.branches} branch score(s) ` +
      `in ${pages} page(s).`
  );

  // COMPLETED as soon as the last page has committed, with the counts it
  // wrote, and BEFORE the check below re-reads every live customer (tens of
  // seconds over the WAN). Written after that check, a failure there lost the
  // row and the counts with it, and a re-run, finding nothing to do, writes no
  // ledger row at all, so the ledger showed the run as interrupted for good
  // (post-merge review of phase 2, finding 7). requeue-untracked.ts and
  // zero-credit-limits.ts write theirs first too. What the check finds is
  // printed for the go-live log, not recorded.
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: 'UPDATE',
      entityType: 'CompletenessRescore',
      entityId: at.toISOString(),
      reason:
        `operator script scripts/ops/rescore-completeness.ts on ${host}: COMPLETED — ` +
        `${written.customers} customer score(s) and ${written.branches} branch score(s) rewritten ` +
        `in ${pages} page(s). Written before the script re-reads every score to check, so a ` +
        'failure of that check cannot lose this row; the check is printed for the go-live log. ' +
        'Pairs with the STARTING row of the same entityId. Run outside any session, so ip and ' +
        'userAgent are null by construction.',
      after: {
        phase: 'completed',
        customersWritten: written.customers,
        branchesWritten: written.branches,
        pages,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  log('The COMPLETED ledger row is written.');
  log('Checking every stored score again ...');

  // The check: every live customer read and scored again, as the dry run does.
  // null when it failed — the scores the pages wrote stay written either way.
  let checked: Awaited<ReturnType<typeof survey>> | null = null;
  try {
    checked = await survey(prisma, opts.chunk);
  } catch (e) {
    log(`The check after the last page FAILED: ${operatorErrorLabel(e)}`);
  }
  const remaining = checked === null ? null : scoresToChange(checked);

  log('='.repeat(76));
  log(
    remaining === null
      ? 'Not checked: the scores above are written and the ledger has its COMPLETED row, but the ' +
          'check that re-reads them failed.'
      : `Checked: ${remaining} stored score(s) still differ (expected 0).`
  );
  log('');
  log('For the record — paste this into the go-live log:');
  log('');
  log(`  scripts/ops/rescore-completeness.ts --apply   ${at.toISOString()}`);
  log(`  database        ${host}`);
  log(`  run as          ${actor.username}`);
  log(`  customers       ${written.customers} score(s) rewritten`);
  log(`  branches        ${written.branches} score(s) rewritten`);
  log(`  still differ    ${remaining === null ? 'not checked (the check failed)' : remaining}`);
  log(
    `  audit rows      AuditLog entityType=CompletenessRescore entityId=${at.toISOString()} (STARTING + COMPLETED)`
  );
  log('');
  if (remaining === null) {
    log('Next: run a dry run; if it finds work, re-run --apply, then a dry run: "Nothing to do".');
    log('Then npm run smoke.\n');
    return 2;
  }
  if (remaining > 0) {
    log(
      `${remaining} score(s) differ again after their page was written: most likely ` +
        'something changed a scored field without rescoring while this ran — ops:visit-days, ' +
        'which must never run beside it, is one such writer.'
    );
    log('Next: --apply again (it rewrites only what differs), then a dry run: "Nothing to do".');
    log('If a second --apply still leaves some, stop and find that writer before a third.');
    log('Then npm run smoke.\n');
    return 1;
  }
  log('Next: a dry run again (expect "Nothing to do"), then npm run smoke.\n');
  return 0;
}

async function main(): Promise<number> {
  const { url, host, opts } = prepare(process.argv.slice(2), process.env);
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    return await run(opts, prisma, host);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Run only when invoked as a command: tests/unit/rescore-completeness.test.ts
 * imports this module, and a top-level main() would have `npm test` open a
 * database connection — against whatever .env holds.
 */
if (/rescore-completeness\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nCOMPLETENESS RESCORE FAILED: ${operatorErrorLabel(e)}\n`);
      process.exit(2);
    });
}
