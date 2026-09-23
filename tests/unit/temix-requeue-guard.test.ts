// @vitest-environment node
/**
 * The requeue script's selection rule, pinned without a database.
 *
 * scripts/ops/requeue-untracked.ts moves live customers that carry no Temix code
 * out of SYNCED and into PENDING_UPLOAD, because SYNCED-with-no-code means the ERP
 * never learns the customer exists. On the production set that is a few thousand
 * rows, and the blast radius of a predicate that is one clause too wide is every
 * customer in the master landing in one upload batch.
 *
 * So the predicate is what gets pinned, not the script's plumbing: it must not be
 * able to select a row that HAS a code, a soft-deleted row, or a row already
 * mid-flight through the batch protocol. All three are defects that would report
 * success — the script would print a bigger number and the operator would have no
 * reason to doubt it.
 *
 * The structural half matters as much as the behavioural half here. Several
 * defects on this project were a correct helper that nothing used; the assertions
 * below check that the script's own update really re-applies this predicate, that
 * the dry run really is the default, and that the duplicated batch cap still
 * matches the one services/temix.ts enforces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TemixSyncState } from '@prisma/client';
import { REQUEUE_WHERE, wouldRequeue } from '@/scripts/ops/requeue-untracked';

const SCRIPT = 'scripts/ops/requeue-untracked.ts';
const SERVICE = 'services/temix.ts';
const VERIFY = 'scripts/ops/verify-load.ts';

/**
 * Strip comments before asserting against source. This file's own explanations
 * quote the strings being matched, and so does the script's — a comment must never
 * be the thing that makes an assertion pass.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const code = strip(readFileSync(SCRIPT, 'utf8'));
const serviceCode = strip(readFileSync(SERVICE, 'utf8'));
const verifyCode = strip(readFileSync(VERIFY, 'utf8'));

/** A row of exactly the shape the May pilot seed left behind. */
const target = {
  deletedAt: null,
  temixCode: null,
  temixSyncState: TemixSyncState.SYNCED,
};

describe('the requeue predicate selects only the seeded, untracked, live rows', () => {
  it('selects the row the defect is about', () => {
    // If this were false everything below would pass vacuously.
    expect(wouldRequeue(target)).toBe(true);
  });

  it('cannot select a customer that already has a Temix code', () => {
    // The ERP already knows this one. Requeueing it sends Temix a row it does not
    // need, and — worse — takes a slot under the batch cap from one that does.
    expect(wouldRequeue({ ...target, temixCode: 'T-00412' })).toBe(false);
    expect(wouldRequeue({ ...target, temixCode: '' })).toBe(false);
  });

  it('cannot select a soft-deleted customer', () => {
    // Archived rows are resolveArchiveTemixState's business, and a deactivation row
    // for a customer that never had a code asks Temix to deactivate something it
    // has never heard of.
    expect(wouldRequeue({ ...target, deletedAt: new Date('2026-05-11T00:00:00.000Z') })).toBe(
      false
    );
  });

  it('cannot select a row in any other sync state', () => {
    // PENDING_UPLOAD is already queued; UPLOADED is in a batch the Steward is
    // carrying right now and must not be duplicated into the next one;
    // DEACTIVATE_PENDING is the other lane of the same queue.
    for (const state of [
      TemixSyncState.PENDING_UPLOAD,
      TemixSyncState.UPLOADED,
      TemixSyncState.DEACTIVATE_PENDING,
    ]) {
      expect(
        wouldRequeue({ ...target, temixSyncState: state }),
        `${state} must be left alone`
      ).toBe(false);
    }
  });

  it('has exactly the three clauses the evaluator knows about', () => {
    // wouldRequeue() reads its three values off REQUEUE_WHERE, so those cannot
    // drift. What it cannot see is a FOURTH clause added to the where — the script
    // would then select fewer rows than every test above claims, and nothing would
    // go red. This is that half.
    expect(Object.keys(REQUEUE_WHERE).sort()).toEqual(['deletedAt', 'temixCode', 'temixSyncState']);
    expect(REQUEUE_WHERE.deletedAt).toBeNull();
    expect(REQUEUE_WHERE.temixCode).toBeNull();
    expect(REQUEUE_WHERE.temixSyncState).toBe(TemixSyncState.SYNCED);
  });
});

describe('the script applies the predicate it exports', () => {
  it('re-applies the full predicate inside the update, not just the ids', () => {
    // A chunked update selects ids, then writes them. Writing on the strength of
    // that stale read would clobber a row someone corrected or archived in between.
    //
    // The update spreads `scope`, not REQUEUE_WHERE directly — --limit needs a
    // definite subset, so scope is REQUEUE_WHERE plus an optional `id: { lte }`
    // cutoff. That still satisfies what this test is for, but only while scope is
    // DERIVED from the predicate and only ever narrows it, so both halves are
    // pinned: the update spreads scope, and scope is built by spreading
    // REQUEUE_WHERE. Rebuilding scope from literals instead would make the update
    // spread something this file has never checked.
    const update = code.slice(code.indexOf('updateMany('));
    expect(update.slice(0, 400)).toMatch(/where:\s*\{\s*id:\s*\{\s*in:\s*ids\s*\},\s*\.\.\.scope/);
    expect(code).toMatch(
      /const scope:\s*Prisma\.CustomerWhereInput\s*=\s*\{\s*\.\.\.REQUEUE_WHERE\s*\}/
    );
    // And it may only ADD an id bound. Any other key would silently widen or
    // re-aim the set the chunk loop walks.
    const scopeBlock = code.slice(code.indexOf('const scope:'), code.indexOf('const queueBefore'));
    const assignedKeys = [...scopeBlock.matchAll(/scope\.(\w+)\s*=/g)].map((m) => m[1]);
    expect(assignedKeys).toEqual(['id']);
  });

  it('writes only PENDING_UPLOAD and the pending timestamp', () => {
    const update = code.slice(code.indexOf('updateMany('));
    expect(update.slice(0, 600)).toMatch(/temixSyncState:\s*TemixSyncState\.PENDING_UPLOAD/);
    expect(update.slice(0, 600)).toMatch(/temixSyncPendingSince:\s*pendingSince/);
  });

  it('is a dry run unless --apply is passed', () => {
    // Ordering, not presence. The guard has to return BEFORE the first write, which
    // is the shape of the --expect-commit defect in scripts/ops/smoke.ts: a check
    // declared after the thing it guards is unreachable in exactly the case it
    // exists for.
    const iDryRun = code.indexOf('if (!apply)');
    const iWrite = code.indexOf('updateMany(');
    expect(iDryRun, 'the dry-run guard must exist').toBeGreaterThan(-1);
    expect(iWrite, 'the update must exist').toBeGreaterThan(-1);
    expect(iDryRun).toBeLessThan(iWrite);
    expect(code).toMatch(/const apply = args\.includes\('--apply'\)/);
  });

  it('names the database before it opens a connection to it', () => {
    // --expect-host is required for the dry run too: a dry run against the wrong
    // database reports "nothing to do", which reads as "already fixed".
    //
    // ANCHORED ON THE CALL, ARGUMENTS AND ALL. The first version of this test
    // searched for `requireExpectedHost(args`, which matches the FUNCTION
    // DECLARATION a hundred lines above the call site — so it compared the
    // declaration's offset against `new PrismaClient(` and stayed green with the
    // call moved below the client, or deleted outright. That is the same defect
    // this file exists to catch, in the test that catches it: the only guard
    // standing between this script and the wrong production database, unpinned.
    // tests/unit/smoke-expect-commit-guard.test.ts anchors its ordering assertion
    // on an expression that occurs exactly once, for exactly this reason, so the
    // count is asserted here rather than assumed.
    const CALL = /requireExpectedHost\(\s*args\s*,\s*url\s*,\s*host\s*\)\s*;/;
    const calls = code.match(new RegExp(CALL, 'g')) ?? [];
    expect(calls, 'the host guard must be CALLED, not merely declared').toHaveLength(1);
    const iGuard = code.search(CALL);
    const iClient = code.indexOf('new PrismaClient(');
    const iFirstRead = code.indexOf('prisma.customer.count(');
    expect(iClient, 'the client must exist').toBeGreaterThan(-1);
    expect(iFirstRead, 'the first read must exist').toBeGreaterThan(-1);
    expect(iGuard, 'the guard must run before the client is constructed').toBeLessThan(iClient);
    // And before anything is read, which is what the script's own comment claims:
    // evidence of which database is about to change that arrives afterwards is a
    // receipt, not a guard.
    expect(iGuard, 'the guard must run before the first query').toBeLessThan(iFirstRead);
    expect(code).toMatch(/refusing to run without --expect-host/);
  });

  it('resolves the audit actor before the dry run returns, not after', () => {
    // The dry run's job is to rehearse every way --apply can refuse. Resolved
    // after the `if (!apply)` return, the likeliest refusal on this database —
    // AuditLog.actorId is a required FK and production has more than one active
    // Steward — was invisible to the rehearsal and surfaced only once the
    // operator had committed to --apply. Ordering, not presence: the call exists
    // either way.
    const iActor = code.indexOf('resolveActor(prisma, actorArg)');
    const iDryRun = code.indexOf('if (!apply)');
    expect(iActor, 'the actor must be resolved').toBeGreaterThan(-1);
    expect(iDryRun, 'the dry-run guard must exist').toBeGreaterThan(-1);
    expect(iActor).toBeLessThan(iDryRun);
  });

  it('refuses an --actor who could not have done this', () => {
    // --actor is reached exactly when the script has just printed a list of
    // steward usernames for the operator to copy from. It used to accept any
    // username that existed — a SALESMAN, a leaver, or `steward`, which
    // production refuses at sign-in — putting an account nobody can act as on
    // the only record of a few thousand rows changing state.
    expect(code).toMatch(/isDemoAccount\(u\.username\)/);
    expect(code).toMatch(/u\.role !== Role\.STEWARD/);
    expect(code).toMatch(/if \(!u\.isActive\)/);
    // Applied on BOTH ways in, not just the explicit flag: the auto-resolved
    // single Steward can be a denylisted one too.
    expect(code.match(/assertUsableActor\(/g) ?? []).toHaveLength(3);
  });

  it('claims the run in the ledger before the first chunk commits', () => {
    // Each chunk commits on its own, so a run that dies at chunk 6 of 14 leaves
    // ~1,500 rows changed. With only a summary row after the loop that change had
    // no ledger row at all, and a re-run stamped a fresh marker on the remainder
    // — so the audit row that finally landed named a fraction of what moved, and
    // /temix has no un-queue action. The claim is written first, carrying the
    // marker, so the set is recoverable whatever happens next. Ordering again:
    // a claim written after the loop claims nothing.
    const iClaim = code.indexOf("phase: 'started'");
    const iWrite = code.indexOf('updateMany(');
    const iDone = code.indexOf("phase: 'completed'");
    expect(iClaim, 'the STARTING row must exist').toBeGreaterThan(-1);
    expect(iDone, 'the COMPLETED row must exist').toBeGreaterThan(-1);
    expect(iClaim).toBeLessThan(iWrite);
    expect(iWrite).toBeLessThan(iDone);
    // Both rows carry the marker as entityId, which is what pairs them.
    expect(code.match(/entityId: pendingSince\.toISOString\(\)/g) ?? []).toHaveLength(2);
  });

  it('runs as the owner, not as the pooled runtime role', () => {
    expect(code).toMatch(/process\.env\.DIRECT_URL \?\? process\.env\.DATABASE_URL/);
  });

  it('does not connect to anything merely by being imported', () => {
    // This test file imports the module. A top-level main() would have `npm test`
    // open a connection to whatever .env happens to hold.
    expect(code).toMatch(/if \(\/requeue-untracked\\\.ts\$\/\.test\(process\.argv\[1\]/);
  });
});

describe('the duplicated batch cap still matches the one the app enforces', () => {
  const capIn = (src: string, where: string) => {
    const m = /const BATCH_ROW_CAP = (\d+);/.exec(src);
    expect(m, `BATCH_ROW_CAP must still be a literal in ${where}`).not.toBeNull();
    return Number(m![1]);
  };

  it('carries the same number as services/temix.ts', () => {
    // The script refuses to requeue when the resulting queue would exceed the cap,
    // so that the owner does not discover it at /temix with the queue already full.
    // That refusal is worthless if the two numbers drift.
    expect(capIn(code, SCRIPT)).toBe(capIn(serviceCode, SERVICE));
  });

  it('records WHY the number is duplicated rather than imported', () => {
    // services/temix.ts is a server-action module, and Next permits only async
    // function exports from one — so the constant cannot be exported from there.
    // If someone moves it somewhere importable, this goes red and the next person
    // deletes the copy instead of maintaining it.
    expect(serviceCode.trimStart().startsWith("'use server'")).toBe(true);
    expect(serviceCode).not.toMatch(/export const BATCH_ROW_CAP/);
  });

  it('sizes the workbook against the whole queue, not just the rows it adds', () => {
    // The cap is the customer count; the workbook figure beside it is the row
    // count, and it is what the operator pastes into the go-live log and what
    // lands in the ledger. It used to count only the requeued customers' branches,
    // so every row already in the queue — an approved correction goes straight to
    // PENDING_UPLOAD while the operator reads the output — was missing from a
    // number labelled "next batch", and the sheet the Steward carried to Temix did
    // not match either artefact.
    expect(code).toMatch(
      /const alreadyQueuedRows =\s*queuedBranchRows \+ queuedNoLiveBranch \+ queuedDeactivations/
    );
    expect(code).toMatch(/const workbookRows = requeuedRows \+ alreadyQueuedRows/);
    // The deactivate lane is one row per CUSTOMER and is soft-deleted by
    // definition, so it is counted by customer and not filtered on deletedAt.
    expect(code).toMatch(
      /queuedDeactivations = await prisma\.customer\.count\(\{\s*where: \{ temixSyncState: TemixSyncState\.DEACTIVATE_PENDING \}/
    );
  });

  it('enforces the cap against the customer count, as the application does', () => {
    // Despite the name, generateTemixBatchCore compares BATCH_ROW_CAP against the
    // queue's CUSTOMER count, not the workbook's row count. A script that checked
    // the larger number would refuse runs the application would have allowed.
    expect(serviceCode).toMatch(/pending > BATCH_ROW_CAP/);
    expect(code).toMatch(/queueAfter > BATCH_ROW_CAP/);
    expect(code).toMatch(/const queueAfter = queueBefore \+ targets/);
  });
});

describe('the batch this script feeds is sized for the queue it creates', () => {
  it('generate carries its own transaction budget, above the default and below the function limit', () => {
    // The owner's next action after this script is /temix → Generate batch, and
    // that is when the queue this script fills is snapshotted: the flip row-locks
    // every queued customer and holds those locks through a findMany that
    // CUSTOMER_SELECT expands into ~6 statements over a WAN-bound link. At pilot
    // size the client-wide default in lib/db.ts covered it; at a few thousand
    // customers it was never measured, and a P2028 there rolls the whole batch
    // back with the queue still full and no in-app way to shrink it. Assert it is
    // ABOVE the default rather than equal to a literal, so that someone raising
    // the default cannot silently make this line a no-op — and so the number here
    // can still be tuned.
    const generateTx = serviceCode.slice(serviceCode.indexOf('prisma.$transaction('));
    const num = (src: string, key: string) => {
      const m = new RegExp(`${key}:\\s*(\\d[\\d_]*)`).exec(src);
      expect(m, `${key} must be set`).not.toBeNull();
      return Number(m![1].replace(/_/g, ''));
    };
    const clientDefault = num(strip(readFileSync('lib/db.ts', 'utf8')), 'timeout');
    const timeout = num(generateTx, 'timeout');
    const maxWait = num(generateTx, 'maxWait');
    expect(timeout).toBeGreaterThan(clientDefault);

    // AND BELOW THE PLATFORM CEILING. A lower bound on its own blesses any value
    // at all, which is how this line came to permit 60_000 — exactly the
    // maxDuration vercel.json gives app/**/*.ts(x). At or above that, Prisma's
    // abort can never fire: the invocation is killed first and the Steward gets a
    // dead request instead of an error naming the timeout. Read the real ceiling
    // out of vercel.json rather than repeating it, and leave room for the
    // ~4,200-row workbook this action still has to build after the commit.
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      functions: Record<string, { maxDuration: number }>;
    };
    const maxDuration = Math.min(
      ...Object.values(vercel.functions).map((f) => f.maxDuration)
    );
    expect(maxDuration).toBeGreaterThan(0);
    const POST_COMMIT_BUDGET_MS = 15_000;
    expect(timeout + maxWait).toBeLessThanOrEqual(maxDuration * 1000 - POST_COMMIT_BUDGET_MS);

    // And long enough to get a pooled connection while the field team is in the
    // app — the value every other heavy path here uses.
    expect(maxWait).toBeGreaterThanOrEqual(5_000);
  });
});

describe('the script fixes exactly what the load gate fails on', () => {
  it('verify-load.ts is still checking this shape', () => {
    // The two predicates have to agree. If verify-load's check is reworded or
    // widened and this is not, a successful run leaves the gate red and there is
    // nothing in either file to say which of them is wrong.
    const check = verifyCode.slice(verifyCode.indexOf('customers with no Temix code'));
    expect(check.slice(0, 700)).toMatch(/deletedAt:\s*null/);
    expect(check.slice(0, 700)).toMatch(/temixCode:\s*null/);
    expect(check.slice(0, 700)).toMatch(/temixSyncState:\s*'SYNCED'/);
  });
});
