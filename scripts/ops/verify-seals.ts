/**
 * Gap 28 (data audit 2026-10-10): recompute the ledgers' seal chain and report
 * the FIRST seal that no longer matches (docs/OPERATIONS.md section 5k).
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/verify-seals.ts \
 *     --expect-host <host> [--from-seq N] [--to-seq N] [--no-offsite] [--all]
 *
 * For each seal, in order: its hash is the SHA-256 of its body and the body
 * agrees with its columns; it links to the seal before; it sealed at least the
 * rows the seal before saw of its range; each table's range is recomputed from
 * the ledger with that seal's own format version; and its R2 copy is read back
 * at the key the chain gives it (unless --no-offsite). Then the whole of seals/
 * is listed — one object per seal, nothing else — and, per table, every row at
 * or below the last sealed key is counted against the sum of the seals' counts.
 *
 * A mismatch is one of: body edited / chain link broken / rows deleted (count
 * lower) / rows added into a sealed range / rows changed (same count, digest
 * differs) / rows deleted or changed before they were sealed / off-site copy
 * missing / off-site copy differs / an off-site object that is no seal of this
 * chain / a seal naming another off-site key. Only the first is printed unless
 * --all.
 *
 * Read-only: one REPEATABLE READ, READ ONLY transaction. Prints seq, day, table,
 * counts and hash prefixes — never a row's content. Exit 0 when everything
 * matches, 1 on a mismatch, 2 when it could not run. Run it before and after a
 * maintenance window (OPERATIONS.md section 5e), and on a restored dump as a
 * restore check.
 *
 * On UAT the chain breaks after any integration run (their clean-ups delete
 * ledger rows by design) and the crons do not run there: this is meaningful on
 * production and on a restore.
 *
 * Imports only the pure lib/seal modules and lib/r2, never lib/db
 * (tests/unit/scripts-production-guard.test.ts).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { connectWaking, requireExpectedHost } from './requeue-untracked';
import { OperatorRefusal, operatorErrorLabel } from './error-label';
import { MISMATCH_LABEL, type Mismatch } from '../../lib/seal/chain';
import { recheckSeals } from '../../lib/seal/verify';
import { r2SealStore } from '../../lib/seal/store';

export type VerifySealsArgs = {
  fromSeq?: number;
  toSeq?: number;
  offsite: boolean;
  all: boolean;
};

function seqArg(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 0 || n > 2_147_483_647) {
    throw new OperatorRefusal(`${flag} takes a seal number (0 or more).`);
  }
  return n;
}

/** The command line, checked. --expect-host itself is read by requireExpectedHost. */
export function parseVerifySealsArgs(args: string[]): VerifySealsArgs {
  const known = new Set(['--expect-host', '--from-seq', '--to-seq', '--no-offsite', '--all']);
  for (const [i, a] of args.entries()) {
    if (a.startsWith('--') && !known.has(a)) throw new OperatorRefusal(`unknown option ${a}`);
    if (!a.startsWith('--') && !['--expect-host', '--from-seq', '--to-seq'].includes(args[i - 1] ?? '')) {
      throw new OperatorRefusal(`unexpected argument ${a}`);
    }
  }
  const out: VerifySealsArgs = {
    fromSeq: seqArg(args, '--from-seq'),
    toSeq: seqArg(args, '--to-seq'),
    offsite: !args.includes('--no-offsite'),
    all: args.includes('--all'),
  };
  if (out.fromSeq !== undefined && out.toSeq !== undefined && out.fromSeq > out.toSeq) {
    throw new OperatorRefusal('--from-seq is after --to-seq.');
  }
  return out;
}

/** One line per mismatch: seq, day, table, kind, counts and hash prefixes. Never a row. */
export function mismatchLine(m: Mismatch): string {
  return `  seal ${String(m.seq).padStart(6)}  ${m.day}  ${(m.table ?? '-').padEnd(18)} ${MISMATCH_LABEL[m.kind]}${m.detail ? `: ${m.detail}` : ''}`;
}

/** The report, as lines; the exit code is 0 when there is no mismatch. */
export function report(
  result: { seals: number; windowSeqs: number[]; rangesRecomputed: number; mismatches: Mismatch[] },
  opts: VerifySealsArgs
): { lines: string[]; code: 0 | 1 } {
  const lines = [
    `Seals: ${result.seals}; recomputed ${result.rangesRecomputed} range(s) over seal(s) ${
      result.windowSeqs.length ? `${result.windowSeqs[0]}..${result.windowSeqs.at(-1)}` : 'none'
    }; off-site copies ${opts.offsite ? 'read' : 'not read (--no-offsite)'}`,
  ];
  if (result.seals === 0) lines.push('No seal has been written yet (the nightly integrity-watch writes the genesis).');
  if (result.mismatches.length === 0) {
    lines.push('Every seal matches.');
    return { lines, code: 0 };
  }
  const shown = opts.all ? result.mismatches : result.mismatches.slice(0, 1);
  lines.push(opts.all ? `${result.mismatches.length} mismatch(es):` : 'FIRST mismatch (run with --all for every one):');
  lines.push(...shown.map(mismatchLine));
  return { lines, code: 1 };
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new OperatorRefusal('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);
  const opts = parseVerifySealsArgs(args);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log('='.repeat(76));
    await connectWaking(prisma);
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return recheckSeals(tx, {
          window: 'all',
          fromSeq: opts.fromSeq,
          toSeq: opts.toSeq,
          offsite: opts.offsite ? r2SealStore() : null,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10 * 60_000, maxWait: 30_000 }
    );
    const out = report(
      { seals: result.seals.length, windowSeqs: result.windowSeqs, rangesRecomputed: result.rangesRecomputed, mismatches: result.mismatches },
      opts
    );
    for (const l of out.lines) console.log(l);
    console.log('');
    return out.code;
  } finally {
    await prisma.$disconnect();
  }
}

if (/verify-seals\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nVERIFY SEALS FAILED: ${operatorErrorLabel(e)}\n`);
      process.exit(2);
    });
}
