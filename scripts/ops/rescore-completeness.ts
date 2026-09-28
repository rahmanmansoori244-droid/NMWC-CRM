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
 * live customers and their live branches, and nothing else — through
 * lib/rescore.ts, the same code the promote runs: raw SQL that writes a row only
 * when its score differs, so updatedAt stays as it was (the master export's
 * "updated since" filter reads it) and `version` is never bumped (a derived
 * column must not fail an edit form open on the customer). No Temix requeue, no
 * lastEditedById.
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
 * STARTING row before the first page and a COMPLETED row after the last; each
 * page commits on its own, so an interrupted run is re-run, and a second run
 * reports nothing to do.
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
    throw new Error('--actor was passed without a username');
  }
  if (apply && !actor) {
    throw new Error(
      '--apply needs --actor <steward username>: the ledger rows name the Steward\n' +
        '  accountable for the change, and there is no system user to default to.'
    );
  }
  const chunkIdx = args.indexOf('--chunk');
  let chunk = DEFAULT_CHUNK;
  if (chunkIdx >= 0) {
    const raw = args[chunkIdx + 1] ?? '';
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MAX_CHUNK) {
      throw new Error(`--chunk needs a whole number from 1 to ${MAX_CHUNK}, e.g. --chunk 200`);
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
  if (!url) throw new Error('set DIRECT_URL (preferred) or DATABASE_URL');
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
        return rescoreCustomerTx(tx, ids);
      },
      { timeout: 20_000, maxWait: 10_000 }
    );
    written.customers += res.written.customers;
    written.branches += res.written.branches;
    pages += 1;
    if (pages % 10 === 0) log(`  pages ${String(pages).padStart(5)} done`);
    if (ids.length < opts.chunk) break;
    pageAfter = ids[ids.length - 1];
  }

  const after = await survey(prisma, opts.chunk);
  const remaining = scoresToChange(after);

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: 'UPDATE',
      entityType: 'CompletenessRescore',
      entityId: at.toISOString(),
      reason:
        `operator script scripts/ops/rescore-completeness.ts on ${host}: COMPLETED — ` +
        `${written.customers} customer score(s) and ${written.branches} branch score(s) rewritten; ` +
        `${remaining} still differ (expected 0). Pairs with the STARTING row of the same ` +
        'entityId. Run outside any session, so ip and userAgent are null by construction.',
      after: {
        phase: 'completed',
        customersWritten: written.customers,
        branchesWritten: written.branches,
        pages,
        remaining,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  log('='.repeat(76));
  log(
    `Wrote ${written.customers} customer score(s) and ${written.branches} branch score(s) ` +
      `in ${pages} page(s); ${remaining} still differ (expected 0).`
  );
  log('');
  log('For the record — paste this into the go-live log:');
  log('');
  log(`  scripts/ops/rescore-completeness.ts --apply   ${at.toISOString()}`);
  log(`  database        ${host}`);
  log(`  run as          ${actor.username}`);
  log(`  customers       ${written.customers} score(s) rewritten`);
  log(`  branches        ${written.branches} score(s) rewritten`);
  log(`  still differ    ${remaining}`);
  log(
    `  audit rows      AuditLog entityType=CompletenessRescore entityId=${at.toISOString()} (STARTING + COMPLETED)`
  );
  log('');
  log('Next: a dry run again (expect "Nothing to do"), then npm run smoke.\n');
  return remaining === 0 ? 0 : 1;
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
    .catch((e: Error) => {
      console.error(`\nCOMPLETENESS RESCORE FAILED: ${e.message}\n`);
      process.exit(2);
    });
}
