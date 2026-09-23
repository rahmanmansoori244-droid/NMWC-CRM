/**
 * Requeue the live customers the ERP was never told about.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/requeue-untracked.ts \
 *     --expect-host ep-sweet-haze [--apply] [--actor <username>] [--limit <n>]
 *
 * THE DEFECT. The May pilot seed created customers with `temixSyncState` left at
 * its schema default of SYNCED while `temixCode` was null. SYNCED-with-no-code is
 * a claim that Temix already knows the customer, and nothing in the application
 * ever re-examines it: lib/temix.ts TEMIX_QUEUE_WHERE selects only PENDING_UPLOAD
 * and DEACTIVATE_PENDING, so such a row is never drawn into an upload batch, never
 * appears on /temix, and the ERP never learns it exists — which means it cannot be
 * invoiced, however complete and correct it looks in the CRM.
 *
 * services/imports.ts already gets this right for rows it CREATES (`temixSyncState:
 * first.temixCode ? 'SYNCED' : 'PENDING_UPLOAD'`). Only the pre-existing seed is
 * wrong, so this is a one-off correction rather than a missing feature.
 * scripts/ops/verify-load.ts fails on exactly this shape ("customers with no Temix
 * code are queued for upload"), and this script is what turns that check green.
 *
 * TARGETS PRODUCTION ON PURPOSE. app-role.ts, restore-verify.ts and
 * prisma/synthetic.ts all refuse an endpoint containing 'ep-sweet-haze'; this one
 * is the opposite — production is where the wrong rows are. The safety is
 * therefore the one from scripts/golive/bootstrap-accounts.ts: the operator must
 * NAME the database with --expect-host and the script refuses if the resolved
 * connection disagrees, saying which host it actually got.
 *
 * --expect-host is required for the DRY RUN too, not just for --apply. A dry run
 * pointed at the wrong database reports "nothing to do" and reads as "already
 * fixed" — the same false success the bootstrap's guard exists to prevent.
 *
 * DRY RUN BY DEFAULT: without --apply this only counts and prints — including
 * resolving the audit actor, so the dry run rehearses every refusal --apply has.
 *
 * Idempotent: a second run finds nothing matching and says so.
 *
 * RECOVERABLE IF IT DIES HALFWAY: the chunks each commit on their own, so the
 * ledger gets a STARTING row naming this run's temixSyncPendingSince BEFORE the
 * first chunk and a COMPLETED row after the last. A STARTING with no COMPLETED
 * beside it is an interrupted run, and that marker recovers exactly the rows it
 * changed — which is the only way back, since /temix offers no un-queue action.
 */
import { PrismaClient, Role, TemixSyncState, type Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { TEMIX_QUEUE_WHERE } from '../../lib/temix';
import { isDemoAccount } from '../../lib/demo-accounts';

/**
 * The rows to correct, and the whole of the safety argument, in one object.
 *
 * `temixSyncState: SYNCED` is what excludes rows already PENDING_UPLOAD, UPLOADED
 * or DEACTIVATE_PENDING: a row mid-flight through the batch protocol has a state
 * that services/temix.ts is responsible for, and moving it backwards would either
 * duplicate it into a second batch or strand a batch that has already been
 * generated.
 *
 * `temixCode: null` — not "empty or null" — deliberately mirrors the verify-load
 * check this script exists to turn green. If one of them ever treats '' as
 * untracked and the other does not, the gate goes red after a successful run and
 * the operator is left with no way to tell which of the two is wrong.
 *
 * `deletedAt: null` leaves soft-deleted rows alone. They are NOT made
 * DEACTIVATE_PENDING here, and that is a decision rather than an oversight:
 *   - lib/temix.ts resolveArchiveTemixState already decided each archived row's
 *     state at the moment it was archived. Second-guessing that from a script
 *     would overwrite a decision the application made with the customer's real
 *     history in hand;
 *   - a deactivation row carries a blank `temix_code` (buildTemixRows), so
 *     queueing one for a customer that never had a code asks Temix to deactivate
 *     something it has never heard of;
 *   - the deactivate lane counts against the batch cap like any other row, so it
 *     would eat headroom in the very first batch — whose job is the opposite, to
 *     tell Temix that 3,000-odd live customers exist;
 *   - a soft-deleted customer cannot be invoiced either way, so it is not the
 *     defect being fixed.
 * Production has zero rows of that shape today, so the clause changes nothing now;
 * it is what keeps a re-run after someone archives one of these from quietly
 * shipping a deactivation.
 *
 * Correcting the live rows also fixes their FUTURE archive path. Before this runs,
 * resolveArchiveTemixState treats SYNCED as "known to Temix", so archiving one of
 * these would have produced exactly the bogus DEACTIVATE_PENDING described above.
 * After it, the row is PENDING_UPLOAD with no code and no lastTemixUploadAt, and
 * archiving parks it back at SYNCED — it simply leaves the queue, which is right.
 */
export const REQUEUE_WHERE = {
  deletedAt: null,
  temixCode: null,
  temixSyncState: TemixSyncState.SYNCED,
} satisfies Prisma.CustomerWhereInput;

export type RequeueCandidate = {
  deletedAt: Date | null;
  temixCode: string | null;
  temixSyncState: TemixSyncState;
};

/**
 * The same decision as REQUEUE_WHERE, evaluated in memory so it can be tested
 * without a database — and DERIVED from that object rather than re-spelled, so
 * the two cannot drift. tests/unit/temix-requeue-guard.test.ts also pins the
 * object's key set, which is the half this function cannot check: a fourth
 * narrowing clause added to the where and not to this evaluator would otherwise
 * make the test pass while the script selected fewer rows than it claimed.
 */
export function wouldRequeue(row: RequeueCandidate): boolean {
  return (
    row.deletedAt === REQUEUE_WHERE.deletedAt &&
    row.temixCode === REQUEUE_WHERE.temixCode &&
    row.temixSyncState === REQUEUE_WHERE.temixSyncState
  );
}

/**
 * services/temix.ts keeps BATCH_ROW_CAP module-private and CANNOT export it: that
 * file is `'use server'`, and Next permits only async function exports from a
 * server-action module, so `export const BATCH_ROW_CAP` there fails the build.
 * Hence the number lives twice. tests/unit/temix-requeue-guard.test.ts reads the
 * constant back out of services/temix.ts and asserts the two agree, because a
 * comment asking the next person to keep them in step is not a guard.
 *
 * Note what it actually caps, despite the name: generateTemixBatchCore compares it
 * against the CUSTOMER count of the queue, not against the workbook's row count.
 * The workbook is one row per live branch, which is larger — so both figures are
 * printed below and only the customer one is enforced, exactly as the application
 * enforces it.
 */
const BATCH_ROW_CAP = 5000;

/**
 * Rows per UPDATE statement. The link to Neon is WAN-bound and this codebase has
 * already been bitten by assuming otherwise: the promote transaction in
 * services/imports.ts was rejecting good customers with P2028 ("transaction
 * closed") purely because ~9 sequential round trips did not fit Prisma's 5s
 * default. One updateMany over 3,000-plus rows is the same bet on a single
 * statement finishing in time, and it would hold write locks on every one of them
 * while an operator watches a blank terminal. Small statements instead, each
 * committed on its own, so an interrupted run is a partial run rather than a lost
 * one — and re-running picks up exactly where it stopped.
 */
const CHUNK = 250;

/** The operator must NAME the database they mean; this refuses if the URL disagrees. */
function requireExpectedHost(args: string[], url: string, host: string): void {
  const expectIdx = args.indexOf('--expect-host');
  const expectHost = expectIdx >= 0 ? (args[expectIdx + 1] ?? '') : '';
  if (!expectHost || expectHost.startsWith('--')) {
    throw new Error(
      'refusing to run without --expect-host.\n' +
        `  This connects to ${host}.\n` +
        '  Name the database you intend, so a variable that did not take cannot\n' +
        '  send this at the wrong database — or report "nothing to do" from one.\n' +
        '  For the go-live:\n' +
        '    --expect-host ep-sweet-haze\n' +
        '  (that string is also the PROD_DB_HOST_MARKER repository variable).'
    );
  }
  if (host.includes(expectHost)) return;

  // Name this trap specifically when it is what happened: a DIRECT_URL that did
  // not reach this process does not fail, because Prisma has already merged the
  // repository .env into process.env — so the run silently addresses the
  // development database and prints a success.
  let viaDotenv = false;
  try {
    const envText = readFileSync('.env', 'utf8');
    // BOTH keys, not the first match: DATABASE_URL is listed first in this
    // repository while this script resolves DIRECT_URL, so matching only the
    // first one compares the wrong value and never fires.
    const fromEnv = ['DIRECT_URL', 'DATABASE_URL']
      .map((k) => new RegExp(`^${k}=(.*)`, 'm').exec(envText)?.[1])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
    viaDotenv = fromEnv.includes(url);
  } catch {
    /* no .env here; nothing to attribute */
  }
  throw new Error(
    `refusing: you asked for "${expectHost}" but this connection points at ${host}.\n` +
      (viaDotenv
        ? '  That URL is the one in this repository .env — so your variable never\n' +
          '  reached this process and it fell back to the development database.\n' +
          '  Set the variable in the SAME shell that runs this command.\n'
        : '  Check the connection string you exported.\n') +
      '  Nothing has been read or written.'
  );
}

/**
 * The same bar for both ways in, because --actor is reached exactly when the
 * operator has just been handed a list of steward usernames to copy from under
 * time pressure — and until this existed it accepted ANY username that existed:
 * a SALESMAN, a deactivated leaver, or `steward`, which lib/demo-accounts.ts
 * refuses at sign-in whenever DEMO_ACCOUNTS_DISABLED is set (production sets it).
 * The ledger's only record of a few thousand rows changing state would then name
 * an account nobody can sign in as, contradicting the docstring above it.
 *
 * This does NOT relax the denylist to make an account work — it refuses, and the
 * fix is to rename the account, which is the standing rule.
 */
function assertUsableActor(u: { username: string; role: Role; isActive: boolean }): void {
  if (!u.isActive) {
    throw new Error(
      `--actor "${u.username}" is deactivated. The ledger row for this change has to\n` +
        '  name someone who is actually accountable for it today.'
    );
  }
  if (u.role !== Role.STEWARD) {
    throw new Error(
      `--actor "${u.username}" is a ${u.role}, not a STEWARD. The Steward owns the Temix\n` +
        '  lane and is who will generate the batch these rows land in; attributing the\n' +
        '  change to anyone else puts the wrong name on the only record of it.'
    );
  }
  if (isDemoAccount(u.username)) {
    throw new Error(
      `"${u.username}" is on the demo-account denylist (lib/demo-accounts.ts), which\n` +
        '  production enforces at sign-in via DEMO_ACCOUNTS_DISABLED — so the ledger would\n' +
        '  name an account that cannot sign in. Do not relax the denylist: rename the\n' +
        '  account (scripts/golive/bootstrap-accounts.ts issues the real one), or pass\n' +
        '  --actor <a real Steward username>.'
    );
  }
}

/**
 * AuditLog.actorId is a non-null FK to User, so an operator-initiated change still
 * has to name a real accountable person. The Steward is the right default: they
 * own the Temix lane and they are who will generate the batch these rows land in.
 * Ambiguity is refused rather than guessed at — a ledger row pointing at the wrong
 * person is worse than a run that asks one more question.
 */
async function resolveActor(
  prisma: PrismaClient,
  username: string
): Promise<{ id: string; username: string }> {
  if (username) {
    const u = await prisma.user.findUnique({
      where: { username: username.toLowerCase().trim() },
      select: { id: true, username: true, role: true, isActive: true },
    });
    if (!u) throw new Error(`--actor "${username}" is not an account on this database`);
    assertUsableActor(u);
    return { id: u.id, username: u.username };
  }
  const stewards = await prisma.user.findMany({
    where: { role: Role.STEWARD, isActive: true },
    select: { id: true, username: true, role: true, isActive: true },
    orderBy: { username: 'asc' },
  });
  if (stewards.length === 1) {
    // The query already guarantees role and isActive; this is here for the denylist
    // case, where the single active Steward is one production refuses at sign-in.
    assertUsableActor(stewards[0]!);
    return { id: stewards[0]!.id, username: stewards[0]!.username };
  }
  if (stewards.length === 0) {
    throw new Error(
      'no active Steward to attribute this to — pass --actor <username>.\n' +
        '  (AuditLog.actorId is a required foreign key; there is no system user.)'
    );
  }
  throw new Error(
    `more than one active Steward (${stewards.map((s) => s.username).join(', ')}) — ` +
      'pass --actor <username> to say which one is running this.'
  );
}

async function main(): Promise<number> {
  // ONE resolution, used for both the connection and the banner — reading one
  // variable for the client and another for the message is how bootstrap-accounts
  // could have named a different host from the one it wrote to.
  //
  // DIRECT_URL, like every other operator script here: after the B4 rollout
  // DATABASE_URL is the pooled least-privilege role, and maintenance runs as the
  // owner.
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

  // --limit <n> — requeue at most n customers, so the queue can be drained in
  // tranches.
  //
  // Two different ceilings want this, and they are not the same number. The one
  // this script already refuses on is BATCH_ROW_CAP: services/temix.ts will not
  // generate a batch above 5,000 queued CUSTOMERS. The other is the one nobody
  // sees until they press the button — generateTemixBatchCore() snapshots the
  // whole queue inside a single interactive transaction budgeted at 30s, and that
  // budget cannot be raised past the 60s Vercel gives the function. If a queue of
  // this size ever fails to generate, the fix is a smaller queue, and without this
  // flag there is no way to make one: /temix has no un-queue action, and the
  // predicate this script uses stops matching the moment a row is requeued, so
  // there is no way back either. The timeout rolls the transaction back untouched,
  // so nothing is lost by finding out — but the operator needs a lever in their
  // hand when they do.
  const limitIdx = args.indexOf('--limit');
  let limit: number | null = null;
  if (limitIdx >= 0) {
    const raw = args[limitIdx + 1] ?? '';
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error('--limit needs a positive whole number, e.g. --limit 1000');
    }
    limit = Number(raw);
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    // Before anything is read or written, not after. This is the operator's only
    // evidence of which database is about to be changed, and evidence that arrives
    // afterwards is a receipt.
    console.log(`\nTarget: ${host}`);
    console.log(
      apply
        ? 'Mode:   APPLY — rows WILL be written'
        : 'Mode:   DRY RUN — nothing will be written (pass --apply to write)'
    );
    console.log('='.repeat(76));

    const matching = await prisma.customer.count({ where: REQUEUE_WHERE });
    // Everything downstream — the cap arithmetic, the banner, both ledger rows and
    // the loop's stop condition — reads `targets`, so the limit is applied once,
    // here, rather than remembered in five places.
    const targets = limit === null ? matching : Math.min(matching, limit);
    if (matching === 0) {
      console.log('Nothing to do: no live customer is marked SYNCED without a Temix code.');
      console.log('(This is what a second run looks like — the correction is idempotent.)\n');
      return 0;
    }

    // WHICH rows this run covers, decided once and reused by every count below
    // and by the loop.
    //
    // Without --limit this is the whole predicate. With it, the run has to cover a
    // DEFINITE subset, not just "stop after n" — otherwise the branch counts and
    // the workbook estimate printed above describe all 3,308 while the loop
    // touches 1,000 of them, and the operator reconciles the Temix upload against
    // a number that was never going to be true. Take the first `targets` ids in
    // the same order the loop walks them and pin the upper bound; the loop then
    // cannot wander past it even as concurrent work changes what matches.
    const scope: Prisma.CustomerWhereInput = { ...REQUEUE_WHERE };
    if (limit !== null && targets < matching) {
      const edge = await prisma.customer.findMany({
        where: REQUEUE_WHERE,
        select: { id: true },
        orderBy: { id: 'asc' },
        skip: targets - 1,
        take: 1,
      });
      // A row can be corrected by someone else between the count and this read.
      // Falling back to the unbounded predicate would silently requeue everything,
      // which is the one outcome --limit exists to prevent.
      if (edge.length === 0) throw new Error('could not resolve the --limit cutoff; re-run');
      scope.id = { lte: edge[0].id };
    }

    // Every figure below is re-derived here rather than carried in from the
    // investigation that found the defect: the numbers established by hand were
    // true at one moment on one day, and the load is still moving.
    const queueBefore = await prisma.customer.count({ where: TEMIX_QUEUE_WHERE });
    const branchRows = await prisma.branch.count({
      where: { deletedAt: null, customer: { ...scope } },
    });
    // buildTemixRows emits a master row for a live customer with no live branch,
    // so the workbook is not simply the branch count. verify-load.ts asserts this
    // is zero; count it rather than assume it.
    const noLiveBranch = await prisma.customer.count({
      where: { ...scope, branches: { none: { deletedAt: null } } },
    });
    // What the predicate deliberately walks past — reported so that "we left these
    // alone" is a stated decision in the run's output rather than an omission the
    // operator has to notice.
    const archivedUntracked = await prisma.customer.count({
      where: {
        deletedAt: { not: null },
        temixCode: null,
        temixSyncState: TemixSyncState.SYNCED,
      },
    });
    // The rows THIS RUN adds to the workbook.
    const requeuedRows = branchRows + noLiveBranch;
    // And the rows that are in it already. The workbook the Steward downloads
    // covers the whole of TEMIX_QUEUE_WHERE, not just what this run touched, so
    // counting only the requeued set under-reports the moment the queue is not
    // empty — and it will not be: an approved correction or create goes straight
    // to PENDING_UPLOAD (services/edits.ts, lib/create-finalize.ts) while the
    // operator is reading this output. The figure is pasted into the go-live log
    // and stored in the ledger, and whoever reconciles the Temix upload against
    // it has nothing in either artefact to explain a discrepancy.
    //
    // Same shape as above, over the already-queued lanes: one row per live branch
    // of a live queued customer, a master row for a live queued customer with no
    // live branch, and one row per DEACTIVATE_PENDING customer (buildTemixRows
    // emits those with blank branch fields, and they are soft-deleted by
    // definition, so they are counted by customer rather than by branch).
    const queuedLive = { deletedAt: null, temixSyncState: TemixSyncState.PENDING_UPLOAD };
    const queuedBranchRows = await prisma.branch.count({
      where: { deletedAt: null, customer: { ...queuedLive } },
    });
    const queuedNoLiveBranch = await prisma.customer.count({
      where: { ...queuedLive, branches: { none: { deletedAt: null } } },
    });
    const queuedDeactivations = await prisma.customer.count({
      where: { temixSyncState: TemixSyncState.DEACTIVATE_PENDING },
    });
    const alreadyQueuedRows = queuedBranchRows + queuedNoLiveBranch + queuedDeactivations;
    const workbookRows = requeuedRows + alreadyQueuedRows;
    const queueAfter = queueBefore + targets;

    console.log(
      `To requeue:        ${targets} live customer(s), SYNCED with no Temix code` +
        (limit !== null
          ? `\n                   (--limit ${limit} of ${matching} matching; ` +
            `${matching - targets} left for a later run)`
          : '')
    );
    console.log(`Temix queue now:   ${queueBefore} customer(s)`);
    console.log(`Temix queue after: ${queueAfter} customer(s)  (cap ${BATCH_ROW_CAP})`);
    console.log(
      `Workbook would be: ${workbookRows} row(s) — ${requeuedRows} from this run` +
        ` (${branchRows} live branch row(s)` +
        `${noLiveBranch > 0 ? ` + ${noLiveBranch} customer(s) with no live branch` : ''})` +
        `${alreadyQueuedRows > 0 ? ` + ${alreadyQueuedRows} already queued` : ''}`
    );
    console.log(
      `Left alone:        ${archivedUntracked} soft-deleted customer(s) of the same shape` +
        ' (deactivation is resolveArchiveTemixState’s decision, not this script’s)'
    );

    // Refuse BEFORE writing, not after. The failure this prevents is the owner
    // discovering the cap at /temix, with the queue already full and no in-app way
    // to take rows back out of it.
    if (queueAfter > BATCH_ROW_CAP) {
      console.log('='.repeat(76));
      console.log(
        `REFUSING: the queue would reach ${queueAfter} customers and services/temix.ts\n` +
          `  refuses to generate a batch above ${BATCH_ROW_CAP} ("Queue exceeds ... contact\n` +
          '  support to split the batch"). Requeueing now would jam /temix for everyone:\n' +
          '  the Steward could generate nothing at all, including the batch that would\n' +
          '  have drained it.\n' +
          '  Drain first — have the Steward generate the current batch, load it into\n' +
          '  Temix and mark it loaded — then re-run this. Nothing has been written.\n'
      );
      return 1;
    }

    // Resolve the actor BEFORE the dry run returns, not after it. The dry run
    // exists to discover what --apply will refuse, and on this database the
    // likeliest refusal is this one: AuditLog.actorId is a required foreign key,
    // there is no system user, and production carries 63 active accounts
    // including leftovers, so "more than one active Steward — pass --actor" is a
    // real outcome. Resolved after the return, a dry run printed all its counts
    // and ended with "nothing was written", which reads as a clean bill of
    // health, and the operator met the refusal only after committing to --apply.
    // That is the same argument this file's header makes for requiring
    // --expect-host on the dry run: a rehearsal that cannot reach a check is not
    // a rehearsal of it. One extra query.
    const actor = await resolveActor(prisma, actorArg);
    console.log(
      `Audit actor:       ${actor.username}` +
        (actorArg ? ' (--actor)' : ' (the one active Steward)')
    );

    if (!apply) {
      console.log('='.repeat(76));
      console.log('DRY RUN — nothing was written. Re-run with --apply to make the change.\n');
      return 0;
    }

    // ONE timestamp for the whole run, captured before the first chunk.
    //
    // WHY NOW, AND NOT THE ROW'S createdAt: temixSyncPendingSince answers "how
    // long has this been waiting for the Steward to carry it to Temix". These rows
    // were never waiting — they were wrongly marked as already synced, so nobody
    // was ever going to pick them up. Backdating to the May seed would open the
    // whole set four months overdue the instant it was queued, which is a number
    // no one can act on. They start waiting now, because now is when they entered
    // the queue.
    //
    // WHY ONE VALUE AND NOT new Date() PER CHUNK: it makes the run identifiable
    // afterwards — every row this touched carries the same instant, so
    // `temixSyncPendingSince = <that value>` recovers the exact set, which is also
    // what the audit rows below name. lib/create-finalize.ts (finalizedAt) and
    // services/customers.ts (archivedAt) capture the instant once for the same
    // reason.
    const pendingSince = new Date();
    console.log('='.repeat(76));
    console.log(
      `Applying as ${actor.username}; temixSyncPendingSince = ${pendingSince.toISOString()}`
    );

    // A CLAIM ROW, BEFORE THE FIRST CHUNK — the recovery half of that marker.
    //
    // Each chunk's updateMany commits on its own, so a run that dies at chunk 6 of
    // 14 (Ctrl-C, a closed laptop, the contention throw below) leaves ~1,500 rows
    // in PENDING_UPLOAD and, with only a summary row written after the loop, NO
    // ledger row at all. Worse, it breaks the marker this script advertises as its
    // undo key: a re-run stamps a fresh instant on the remainder, so the audit row
    // that finally lands names a set that is a fraction of what changed, and the
    // rest is identifiable only from a terminal scrollback. /temix has no un-queue
    // action, so there is no other way back.
    //
    // Of the three ways to close that — a row per chunk, a pre-flight claim, or a
    // durable marker on the rows — this is the pre-flight claim, and the rows
    // already carry the marker. A row per chunk would put fourteen rows in the
    // ledger for one operator action and still leave the last partial chunk
    // unrecorded. A claim written first is one extra row and makes the guarantee
    // unconditional: whatever happens next, the instant stamped on every row this
    // run touches is already in the ledger, with the host and the actor beside it.
    // It cannot be amended into the completion row afterwards — AuditLog is
    // append-only at the database (docs/OPERATIONS.md §5e), which is why this is
    // two rows and not one row updated. Over-reporting is the failure direction it
    // chooses: dying between this row and the first chunk records an intent that
    // achieved nothing, which the wording below says plainly, and which is
    // recoverable by reading. The reverse — rows changed with no record — is not.
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'TemixRequeue',
        entityId: pendingSince.toISOString(),
        reason:
          `operator script scripts/ops/requeue-untracked.ts on ${host}: STARTING — about to ` +
          `requeue ${targets} live customer(s) carrying no Temix code from SYNCED to ` +
          'PENDING_UPLOAD, in chunks that each commit on their own. Every row this run ' +
          `touches is stamped temixSyncPendingSince = ${pendingSince.toISOString()}, so that ` +
          'value recovers the exact set even if the run does not reach its completion row. ' +
          'If no completion row carries this entityId, the run was interrupted and the set ' +
          'is partial — count it with that marker rather than trusting the number above. ' +
          'Run outside any session, so ip and userAgent are null by construction.',
        after: {
          phase: 'started',
          intended: targets,
          temixSyncPendingSince: pendingSince.toISOString(),
          queueBefore,
          host,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    let done = 0;
    for (;;) {
      // Re-select each time instead of paging with a cursor: an updated row no
      // longer matches REQUEUE_WHERE, so the predicate itself advances. That is
      // also what makes an interrupted run resumable with no bookkeeping.
      const page = await prisma.customer.findMany({
        where: scope,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: CHUNK,
      });
      if (page.length === 0) break;
      const ids = page.map((c) => c.id);
      const res = await prisma.customer.updateMany({
        // The full predicate again, not just the ids: a row that was corrected or
        // archived by someone else between this select and this update must be
        // left to whatever did that, not clobbered on the strength of a stale read.
        where: { id: { in: ids }, ...scope },
        data: {
          temixSyncState: TemixSyncState.PENDING_UPLOAD,
          temixSyncPendingSince: pendingSince,
          // `version` is deliberately NOT incremented. It is the optimistic lock
          // the services include in their WHERE clauses (B-05), so bumping it
          // would make every edit form currently open on one of these customers
          // fail with a concurrent-edit conflict — for a change that alters no
          // field any of those forms can see.
        },
      });
      if (res.count === 0) {
        throw new Error(
          `selected ${ids.length} rows and updated none — something else is writing to\n` +
            `  these customers. ${done} of ${targets} were requeued before this point and\n` +
            '  are correct; re-running is safe and will pick up the remainder.\n' +
            `  Those ${done} carry temixSyncPendingSince = ${pendingSince.toISOString()}, and\n` +
            '  the STARTING row written before the first chunk names that value — so this\n' +
            '  partial run is in the ledger whether or not this message is ever read.'
        );
      }
      done += res.count;
      console.log(`  requeued ${String(done).padStart(6)} of ~${targets}`);
    }

    // The completion row, carrying the count actually achieved — the same shape
    // as scripts/bulk-reset-credentials.ts, and the pair to the STARTING row
    // above: same entityType and same entityId, so the two are one run in the
    // ledger and a STARTING with no COMPLETED beside it is an interrupted one.
    // Operator scripts sit
    // outside the writeAudit() ESLint rule on purpose (they have no request, so
    // both forensic columns are null whichever writer fills them, and importing
    // lib/audit.ts would drag next/headers and the pooled client into a script
    // that must run as the owner). The blank ip/userAgent on this row is the
    // documented class in docs/compliance/RECORDS-OF-PROCESSING.md A6. No
    // eslint-disable directive here on purpose: the rule's `files` list stops at
    // the request-serving tree, so a directive would be an unused one — and
    // ESLint 9 reports those, which is noise that reads like a suppressed error.
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'TemixRequeue',
        entityId: pendingSince.toISOString(),
        reason:
          `operator script scripts/ops/requeue-untracked.ts on ${host}: COMPLETED — ${done} live ` +
          'customer(s) carrying no Temix code were marked SYNCED by the May pilot seed, so they ' +
          'could never enter an upload batch and the ERP could never invoice them. Requeued to ' +
          `PENDING_UPLOAD, all stamped temixSyncPendingSince = ${pendingSince.toISOString()}, ` +
          "which is also this row's entityId and that of the STARTING row for the same run. " +
          'Run outside any session, so ip and userAgent are null by construction.',
        after: {
          phase: 'completed',
          requeued: done,
          intended: targets,
          temixSyncPendingSince: pendingSince.toISOString(),
          queueBefore,
          queueAfter: queueBefore + done,
          // The whole next batch, not just this run's share — see the count above.
          workbookRows,
          workbookRowsFromThisRun: requeuedRows,
          archivedLeftAlone: archivedUntracked,
          host,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const remaining = await prisma.customer.count({ where: REQUEUE_WHERE });
    console.log('='.repeat(76));
    console.log(`Requeued ${done} customer(s); ${remaining} still match (expected 0).`);
    console.log('');
    console.log('For the record — paste this into the go-live log:');
    console.log('');
    console.log(`  scripts/ops/requeue-untracked.ts --apply   ${pendingSince.toISOString()}`);
    console.log(`  database        ${host}`);
    console.log(`  run as          ${actor.username}`);
    console.log(
      `  requeued        ${done} customer(s) SYNCED with no Temix code -> PENDING_UPLOAD`
    );
    console.log(
      `  Temix queue     ${queueBefore} -> ${queueBefore + done} customer(s) (cap ${BATCH_ROW_CAP})`
    );
    console.log(
      `  next batch      ~${workbookRows} workbook row(s)` +
        ` (${requeuedRows} from this run + ${alreadyQueuedRows} already queued)`
    );
    console.log(
      `  left alone      ${archivedUntracked} soft-deleted customer(s) of the same shape`
    );
    console.log(
      `  audit rows      AuditLog entityType=TemixRequeue entityId=${pendingSince.toISOString()}` +
        ' (STARTING + COMPLETED)'
    );
    console.log('');
    console.log('Next: npm run smoke, then npm run verify:load should pass "customers with no');
    console.log('Temix code are queued for upload", and /temix should offer a batch to');
    console.log('generate.\n');
    return remaining === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Run only when invoked as a command. tests/unit/temix-requeue-guard.test.ts
 * imports this module for REQUEUE_WHERE and wouldRequeue, and a top-level main()
 * would have `npm test` open a database connection — against whatever .env
 * happens to hold.
 */
if (/requeue-untracked\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`\nREQUEUE FAILED: ${e.message}\n`);
      process.exit(2);
    });
}
