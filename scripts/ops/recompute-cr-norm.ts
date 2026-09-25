/**
 * Recompute the stored normalized CR wherever it no longer matches lib/cr.ts.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/recompute-cr-norm.ts \
 *     --expect-host <host marker> [--apply] [--actor <username>]
 *
 *   or: npm run ops:recompute-cr-norm -- --expect-host <host marker> [--apply]
 *
 * WHY. Benchmark item 16 (owner decision 2026-09-25): normalizeCR now folds
 * Arabic-Indic and Persian digits to ASCII and strips invisible format
 * characters (zero-width spaces and joiners, bidi marks, the byte-order mark,
 * the soft hyphen). The duplicate detector and the create-time CR block both
 * compare the STORED norm and never recompute it, so a row written before the
 * change keeps its old norm, and a CR typed on an Arabic keyboard goes on never
 * matching its ASCII twin until the norm is recomputed. This does that, once.
 *
 * WHERE A NORMALIZED CR IS STORED — every place, found by searching the schema
 * and the code for crNumberNorm and normalizeCR on 2026-09-25:
 *   - Customer.crNumberNorm, which the detector and the create block read;
 *   - EditCustomerDraft.crNumberNorm, which the create block reads for other
 *     open new-customer requests, and which finalize copies onto the customer.
 * Nowhere else. ImportRow.parsed keeps the CR as typed (services/imports.ts
 * normalizes it at promote); CustomerEdit.fieldChanges carries crNumber and
 * services/edits.ts derives the norm when it applies the edit; no AuditLog row
 * has ever carried one. Both tables are covered whatever the row's state: an
 * archived customer can be restored, and a closed request's draft is the record
 * of what was asked for.
 *
 * WHAT IT WRITES. crNumberNorm, and nothing else, on exactly the rows where it
 * differs from normalizeCR(crNumber). Every write names the row as it was read —
 * its CR, its old norm and, for a customer, its updatedAt — so an edit that
 * lands between the read and the write wins and the row is skipped (a re-run
 * picks it up if it still differs). A customer's `version` is not bumped (the
 * B-05 optimistic lock: bumping it would fail every edit form open on that
 * customer, for a column no form shows) and its updatedAt is written back
 * unchanged, because the master export's "updated since" filter reads it and
 * these customers' data has not changed.
 *
 * COUNTS ONLY. It never prints a CR, and its ledger rows carry counts, never
 * values: a CR number in the append-only ledger would be kept forever.
 *
 * WHAT CHANGES FOR THE STEWARD. Folding can make two customers' CRs equal for the
 * first time, so /duplicates can gain CR pairs; the run reports how many it will
 * count before and after. An open new-customer request whose CR now equals a
 * live customer's will be refused at its final approval (lib/create-finalize.ts
 * re-checks the CR); the run counts those too.
 *
 * REVERSIBLE BY CONSTRUCTION: the old norm is what the previous normalizeCR made
 * of crNumber, and this script never touches crNumber.
 *
 * "MARK DISTINCT" SURVIVES IT. A dismissal on /duplicates stores a digest of the
 * CR norm the pair shared (lib/duplicate-pairing.ts) and lapses when the pair's
 * match changes. Re-folding a CR the two customers ALREADY shared changes the
 * digest but not the match, so without a hand every pair the Steward marked
 * distinct on such a CR came back reading "what they share has changed"
 * (post-merge review). The run counts those pairs, and --apply appends one
 * CustomerPair row per pair carrying the new digests, after the norm writes —
 * the dismissal then holds as it did. A pair whose CRs become equal only now is
 * a new match, and comes back, as the owner decided.
 *
 * TARGETS ANY DATABASE, NAMED. The safety is the one from requeue-untracked.ts,
 * whose guards it imports: --expect-host is required for the dry run too, the
 * dry run resolves the audit actor so it rehearses every refusal --apply has,
 * and the ledger gets a STARTING row before the first write and a COMPLETED row
 * after the last.
 */
import { PrismaClient, EditProcess, EditState, type Prisma } from '@prisma/client';
import { normalizeCR } from '../../lib/cr';
import {
  dismissalHides,
  matchSignals,
  pairKey,
  parseDismissals,
  type PairLogRow,
  type SignalRow,
} from '../../lib/duplicate-pairing';
import { connectWaking, requireExpectedHost, resolveActor } from './requeue-untracked';

export type NormRow = { id: string; crNumber: string | null; crNumberNorm: string | null };

/** The rows whose stored norm is not what normalizeCR makes of their CR, each with the value it should hold. */
export function planCrNormFixes<T extends NormRow>(rows: T[]): Array<T & { next: string | null }> {
  const out: Array<T & { next: string | null }> = [];
  for (const r of rows) {
    const next = normalizeCR(r.crNumber);
    if (next !== r.crNumberNorm) out.push({ ...r, next });
  }
  return out;
}

/** How a fix changes the stored norm — for the counts, never the values. */
export function fixKind(f: { crNumberNorm: string | null; next: string | null }): 'changed' | 'cleared' | 'filled' {
  if (f.next === null) return 'cleared';
  if (f.crNumberNorm === null) return 'filled';
  return 'changed';
}

/**
 * The WHERE for one write: the row exactly as it was read. A concurrent edit to
 * the CR (which writes a fresh norm through services/edits.ts), to the norm, or
 * — for a customer — to anything at all (updatedAt moves) makes it match nothing,
 * so the edit is never overwritten with a value computed from a stale read.
 */
export function guardedWhere(r: NormRow & { updatedAt?: Date }) {
  return {
    id: r.id,
    crNumber: r.crNumber,
    crNumberNorm: r.crNumberNorm,
    ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
  };
}

/** How many CR pairs /duplicates counts among these norms: one per two customers sharing one. */
export function crPairCount(norms: Iterable<string | null>): number {
  const counts = new Map<string, number>();
  for (const n of norms) if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  let pairs = 0;
  for (const c of counts.values()) pairs += (c * (c - 1)) / 2;
  return pairs;
}

export type PairCustomer = SignalRow & { id: string; deletedAt: Date | null };

/**
 * The "Mark distinct" dismissals that hide a pair now, on a CR the two
 * customers already share, and that would stop hiding it only because that
 * shared CR's norm is re-folded: each with the signals to carry forward. A
 * dismissal from before signals were stored hides whatever the pair matches,
 * so it needs nothing. A pair that matches on anything the Steward did not
 * dismiss — a CR shared only after the re-fold, say — is left to come back.
 */
export function dismissalsToCarry(
  customers: PairCustomer[],
  pairLog: PairLogRow[],
  normAfter: ReadonlyMap<string, string | null>
): Array<{ entityId: string; signals: string[] }> {
  const live = new Map(customers.filter((c) => c.deletedAt === null).map((c) => [c.id, c]));
  const after = (c: PairCustomer): SignalRow => ({
    ...c,
    crNumberNorm: normAfter.has(c.id) ? normAfter.get(c.id)! : c.crNumberNorm,
  });
  const out: Array<{ entityId: string; signals: string[] }> = [];
  for (const [key, d] of parseDismissals(pairLog)) {
    if (d.signals === null) continue;
    const [aId, bId] = key.split('|');
    const a = live.get(aId);
    const b = live.get(bId);
    if (!a || !b) continue;
    const before = matchSignals(a, b);
    if (!before.some((x) => x.startsWith('cr:')) || !dismissalHides(d, before)) continue;
    const next = matchSignals(after(a), after(b));
    if (!next.some((x) => x.startsWith('cr:')) || dismissalHides(d, next)) continue;
    const stored = d.signals;
    if (!next.filter((x) => !x.startsWith('cr:')).every((x) => stored.has(x))) continue;
    out.push({ entityId: pairKey(aId, bId), signals: next });
  }
  return out;
}

const OPEN_STATES: EditState[] = [EditState.DRAFT, EditState.SUBMITTED, EditState.NEEDS_CORRECTION];
const HAS_CR = { OR: [{ crNumber: { not: null } }, { crNumberNorm: { not: null } }] };

async function main(): Promise<number> {
  // DIRECT_URL, like every other operator script: DATABASE_URL is the pooled
  // least-privilege role, and maintenance runs as the owner. One resolution,
  // used for both the connection and the banner.
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

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log(
      apply
        ? 'Mode:   APPLY — rows WILL be written'
        : 'Mode:   DRY RUN — nothing will be written (pass --apply to write)'
    );
    console.log('='.repeat(76));
    await connectWaking(prisma);

    const read = async () => {
      const customers = (
        await prisma.customer.findMany({
          where: HAS_CR,
          select: {
            id: true,
            crNumber: true,
            crNumberNorm: true,
            deletedAt: true,
            updatedAt: true,
            // What a pair's match signals are computed from (lib/duplicate-pairing.ts).
            legalName: true,
            primaryPhoneNorm: true,
            branches: { where: { deletedAt: null }, select: { regionId: true } },
          },
        })
      ).map(({ branches, ...c }) => ({ ...c, regionIds: [...new Set(branches.map((x) => x.regionId))] }));
      const drafts = await prisma.editCustomerDraft.findMany({
        where: HAS_CR,
        select: {
          id: true,
          crNumber: true,
          crNumberNorm: true,
          edit: { select: { state: true, process: true } },
        },
      });
      // The Steward's "Mark distinct" history, in the order it was written.
      const pairLog = await prisma.auditLog.findMany({
        where: { entityType: 'CustomerPair' },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
        select: { entityId: true, after: true, at: true },
      });
      return { customers, drafts, pairLog };
    };
    const { customers, drafts, pairLog } = await read();
    const custFixes = planCrNormFixes(customers);
    const draftFixes = planCrNormFixes(drafts);
    const isOpen = (d: (typeof drafts)[number]) =>
      d.edit.process === EditProcess.CREATE && OPEN_STATES.includes(d.edit.state);

    const kinds = (fixes: Array<{ crNumberNorm: string | null; next: string | null }>) => {
      const k = { changed: 0, cleared: 0, filled: 0 };
      for (const f of fixes) k[fixKind(f)] += 1;
      return `${k.changed} to another value, ${k.cleared} cleared, ${k.filled} filled`;
    };

    // What the Steward will see move: CR pairs among live customers, before and after.
    const live = customers.filter((c) => c.deletedAt === null);
    const nextOf = new Map(custFixes.map((f) => [f.id, f.next]));
    const pairsBefore = crPairCount(live.map((c) => c.crNumberNorm));
    const liveAfter = live.map((c) => (nextOf.has(c.id) ? nextOf.get(c.id)! : c.crNumberNorm));
    const pairsAfter = crPairCount(liveAfter);
    // Open requests whose CR, after this run, equals a live customer's: their
    // final approval will be refused as a duplicate CR.
    const liveNormsAfter = new Set(liveAfter.filter((n): n is string => !!n));
    const draftNextOf = new Map(draftFixes.map((f) => [f.id, f.next]));
    const openColliding = drafts.filter((d) => {
      if (!isOpen(d)) return false;
      const n = draftNextOf.has(d.id) ? draftNextOf.get(d.id)! : d.crNumberNorm;
      return !!n && liveNormsAfter.has(n);
    }).length;

    const carryPlanned = dismissalsToCarry(customers, pairLog, nextOf);

    const liveFixes = custFixes.filter((f) => f.deletedAt === null).length;
    const openFixes = draftFixes.filter(isOpen).length;
    console.log(`Customers with a CR:              ${customers.length}`);
    console.log(
      `  norm to recompute:              ${custFixes.length}` +
        ` (${liveFixes} live, ${custFixes.length - liveFixes} archived)`
    );
    if (custFixes.length > 0) console.log(`                                  ${kinds(custFixes)}`);
    console.log(`New-customer drafts with a CR:    ${drafts.length}`);
    console.log(
      `  norm to recompute:              ${draftFixes.length}` +
        ` (${openFixes} open, ${draftFixes.length - openFixes} closed)`
    );
    if (draftFixes.length > 0) console.log(`                                  ${kinds(draftFixes)}`);
    console.log(`CR pairs on /duplicates:          ${pairsBefore} now, ${pairsAfter} after`);
    console.log(`Open requests whose CR will equal a live customer's: ${openColliding}`);
    console.log(
      `Pairs marked distinct on a CR this re-folds: ${carryPlanned.length}` +
        (carryPlanned.length > 0 ? ' (kept marked distinct by --apply)' : '')
    );

    if (custFixes.length + draftFixes.length === 0) {
      console.log('\nNothing to do: every stored norm is what normalizeCR makes of its CR.');
      console.log('(This is what a second run looks like — the recompute is idempotent.)\n');
      return 0;
    }

    // Resolved before the dry run returns, so the rehearsal meets the refusal
    // --apply would (requeue-untracked.ts explains why).
    const actor = await resolveActor(prisma, actorArg);
    console.log(
      `Audit actor:                      ${actor.username}` +
        (actorArg ? ' (--actor)' : ' (the one active Steward)')
    );

    if (!apply) {
      console.log('='.repeat(76));
      console.log('DRY RUN — nothing was written. Re-run with --apply to make the change.\n');
      return 0;
    }

    const at = new Date();
    console.log('='.repeat(76));
    console.log(`Applying as ${actor.username} at ${at.toISOString()}`);

    // The claim row first, so a run that dies halfway is still in the ledger.
    // Counts only: a CR value in the append-only ledger would be kept forever.
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'CrNormRecompute',
        entityId: at.toISOString(),
        reason:
          `operator script scripts/ops/recompute-cr-norm.ts on ${host}: STARTING — about to ` +
          `recompute the stored normalized CR on ${custFixes.length} customer(s) and ` +
          `${draftFixes.length} new-customer draft(s), after lib/cr.ts normalizeCR began folding ` +
          'Arabic-Indic and Persian digits and stripping invisible characters (item 16). Only ' +
          'crNumberNorm is written; crNumber is untouched, so the old value is recoverable by ' +
          'recomputing it the old way. No CR value is recorded here. Run outside any session, ' +
          'so ip and userAgent are null by construction.',
        after: {
          phase: 'started',
          customers: custFixes.length,
          drafts: draftFixes.length,
          crPairsBefore: pairsBefore,
          crPairsAfter: pairsAfter,
          dismissalsToCarry: carryPlanned.length,
          host,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    let custWritten = 0;
    let custSkipped = 0;
    for (const f of custFixes) {
      const res = await prisma.customer.updateMany({
        where: guardedWhere(f),
        data: { crNumberNorm: f.next, updatedAt: f.updatedAt },
      });
      if (res.count === 1) custWritten += 1;
      else custSkipped += 1;
      if ((custWritten + custSkipped) % 100 === 0) {
        console.log(`  customers ${String(custWritten + custSkipped).padStart(6)} of ${custFixes.length}`);
      }
    }
    let draftWritten = 0;
    let draftSkipped = 0;
    for (const f of draftFixes) {
      const res = await prisma.editCustomerDraft.updateMany({
        where: guardedWhere(f),
        data: { crNumberNorm: f.next },
      });
      if (res.count === 1) draftWritten += 1;
      else draftSkipped += 1;
    }

    // Carried forward from the norms as they now stand, so a row this run
    // skipped (changed while it read) decides nothing. Digests only, as the
    // Steward's own rows hold.
    const now = await read();
    const carry = dismissalsToCarry(
      customers,
      pairLog,
      new Map(now.customers.map((c) => [c.id, c.crNumberNorm]))
    );
    for (const c of carry) {
      await prisma.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'UPDATE',
          entityType: 'CustomerPair',
          entityId: c.entityId,
          after: { signals: c.signals } as unknown as Prisma.InputJsonValue,
          reason:
            'Kept marked distinct by scripts/ops/recompute-cr-norm.ts: the CR these customers ' +
            'share was only re-normalized (item 16), so the Steward\'s "Mark distinct" still applies.',
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'CrNormRecompute',
        entityId: at.toISOString(),
        reason:
          `operator script scripts/ops/recompute-cr-norm.ts on ${host}: COMPLETED — ` +
          `${custWritten} customer(s) and ${draftWritten} new-customer draft(s) now store the ` +
          `normalized CR that lib/cr.ts computes; ${custSkipped + draftSkipped} row(s) changed ` +
          'while the run was reading and were left to that change. Pairs with the STARTING row ' +
          'of the same entityId. Run outside any session, so ip and userAgent are null by ' +
          'construction.',
        after: {
          phase: 'completed',
          customersWritten: custWritten,
          customersSkipped: custSkipped,
          draftsWritten: draftWritten,
          draftsSkipped: draftSkipped,
          dismissalsCarried: carry.length,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const remaining = planCrNormFixes(now.customers).length + planCrNormFixes(now.drafts).length;
    console.log('='.repeat(76));
    console.log(
      `Wrote ${custWritten} customer(s) and ${draftWritten} draft(s); ` +
        `${custSkipped + draftSkipped} skipped; ${remaining} still differ (expected 0).`
    );
    console.log('');
    console.log('For the record — paste this into the go-live log:');
    console.log('');
    console.log(`  scripts/ops/recompute-cr-norm.ts --apply   ${at.toISOString()}`);
    console.log(`  database        ${host}`);
    console.log(`  run as          ${actor.username}`);
    console.log(`  customers       ${custWritten} written, ${custSkipped} skipped`);
    console.log(`  drafts          ${draftWritten} written, ${draftSkipped} skipped`);
    console.log(`  CR pairs        ${pairsBefore} -> ${pairsAfter} on /duplicates`);
    console.log(`  marked distinct ${carry.length} pair(s) kept marked`);
    console.log(
      `  audit rows      AuditLog entityType=CrNormRecompute entityId=${at.toISOString()} (STARTING + COMPLETED)`
    );
    console.log('');
    return remaining === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Run only when invoked as a command: tests/unit/recompute-cr-norm.test.ts
 * imports this module for its pure helpers, and a top-level main() would have
 * `npm test` open a database connection — against whatever .env holds.
 */
if (/recompute-cr-norm\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`\nCR NORM RECOMPUTE FAILED: ${e.message}\n`);
      process.exit(2);
    });
}
