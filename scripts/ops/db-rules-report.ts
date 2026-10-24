/**
 * Gap 31: how many older rows break each database rule added NOT VALID
 * (lib/db-rules.ts), and whether each rule is present and validated — the count
 * to read on production before the rules merge, and before any VALIDATE
 * (docs/OPERATIONS.md section 5l).
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/db-rules-report.ts \
 *     --expect-host <host>
 *
 * A NOT VALID CHECK refuses every later save of an older row that breaks it,
 * by any path (an edit, a merge, an archive, the Temix refresh); a NOT VALID
 * foreign key is checked only when its link changes. So a rule with rows here
 * means saves of those rows will be refused once the rules are live, until the
 * rows are corrected — and the rule cannot be validated until it reads 0.
 *
 * A multi-row statement fails WHOLE on one row that breaks a CHECK (review of
 * gap 31, 2026-10-25). So the Customer rules are also counted where the Temix
 * batch paths write many customers in one statement: the queue Generate claims
 * (it now holds a breaker back and names it, so the rest still go out) and the
 * archived rows of a batch not yet marked loaded (Mark loaded refuses that batch,
 * naming them, until they are corrected). The second column is the deploy
 * precondition: it must read 0, or the batches be marked loaded, before the
 * rules go live (docs/OPERATIONS.md section 5l).
 *
 * Read-only: one SELECT over the same SQL the nightly check runs
 * (db-rules-older-rows), the Temix-path count, and a catalog read, inside a
 * READ ONLY transaction with a statement timeout. Prints rule names and counts
 * only — no id, no customer, no value. The nightly check's samples
 * (/status/integrity) name the rows.
 * Exit 0 when every rule is present and no row breaks one, 1 when something
 * needs a look, 2 when it could not run.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { connectWaking, requireExpectedHost } from './requeue-untracked';
import { OperatorRefusal, operatorErrorLabel } from './error-label';
import { DB_RULES, DB_RULE_NAMES, checkRulesOf, dbRulesCountSql } from '../../lib/db-rules';

/** The Temix queue Generate claims, as lib/locks.ts lockTemixQueue selects it (TEMIX_QUEUE_WHERE). */
export const TEMIX_QUEUE_SQL = `((t."temixSyncState" = 'PENDING_UPLOAD' AND t."deletedAt" IS NULL) OR t."temixSyncState" = 'DEACTIVATE_PENDING') AND NOT t."isTest"`;

/** The archived rows Mark loaded settles: uploaded in a batch not yet marked loaded. */
export const AWAITING_MARK_LOADED_SQL =
  `t."deletedAt" IS NOT NULL AND t."temixSyncState" = 'UPLOADED' AND EXISTS ` +
  `(SELECT 1 FROM "TemixSyncBatch" b WHERE b."id" = t."lastTemixUploadBatchId" AND b."markedLoadedAt" IS NULL)`;

/** Per Customer CHECK: how many queued rows break it, and how many rows awaiting Mark loaded. */
export function temixPathCountSql(): string {
  return checkRulesOf('Customer')
    .map(
      (r) =>
        `SELECT '${r.name.replace(/'/g, "''")}'::text AS rule, ` +
        `(count(*) FILTER (WHERE ${TEMIX_QUEUE_SQL}))::int AS queued, ` +
        `(count(*) FILTER (WHERE ${AWAITING_MARK_LOADED_SQL}))::int AS settling ` +
        `FROM "Customer" t WHERE NOT COALESCE((${r.sql}), TRUE)`
    )
    .join('\nUNION ALL\n');
}

/** One line per Customer CHECK: the queued rows Generate holds back, and the rows that stop a Mark loaded. */
export function temixPathLines(counts: Array<{ rule: string; queued: number; settling: number }>): {
  lines: string[];
  queued: number;
  settling: number;
} {
  const by = new Map(counts.map((c) => [c.rule, c]));
  let queued = 0;
  let settling = 0;
  const lines = checkRulesOf('Customer').map((r) => {
    const q = Number(by.get(r.name)?.queued ?? 0);
    const s = Number(by.get(r.name)?.settling ?? 0);
    queued += q;
    settling += s;
    return `  ${r.name.padEnd(48)} ${String(q).padStart(7)} ${String(s).padStart(9)}`;
  });
  return { lines, queued, settling };
}

/** One line per rule: its name, its table, how many rows break it, and its state. */
export function reportLines(
  counts: Array<{ rule: string; n: number }>,
  catalog: Array<{ name: string; validated: boolean }>
): { lines: string[]; violations: number; missing: number; ready: string[] } {
  const n = new Map(counts.map((c) => [c.rule, Number(c.n)]));
  const v = new Map(catalog.map((c) => [c.name, c.validated]));
  const lines: string[] = [];
  const ready: string[] = [];
  let violations = 0;
  let missing = 0;
  for (const r of DB_RULES) {
    const k = n.get(r.name) ?? 0;
    const state = !v.has(r.name) ? 'MISSING' : v.get(r.name) ? 'validated' : 'not valid';
    violations += k;
    if (!v.has(r.name)) missing += 1;
    if (k === 0 && v.get(r.name) === false) ready.push(r.name);
    lines.push(`  ${r.name.padEnd(48)} ${r.kind.padEnd(5)} ${String(k).padStart(7)}   ${state}`);
  }
  return { lines, violations, missing, ready };
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new OperatorRefusal('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log('='.repeat(76));
    await connectWaking(prisma);
    const { counts, temix, catalog } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '60s'`);
        return {
          counts: await tx.$queryRaw<Array<{ rule: string; n: number }>>(
            Prisma.sql`SELECT x.rule, x.n FROM (${Prisma.raw(dbRulesCountSql(DB_RULES, 0))}) x`
          ),
          temix: await tx.$queryRaw<Array<{ rule: string; queued: number; settling: number }>>(
            Prisma.sql`SELECT x.rule, x.queued, x.settling FROM (${Prisma.raw(temixPathCountSql())}) x`
          ),
          catalog: await tx.$queryRaw<Array<{ name: string; validated: boolean }>>(
            Prisma.sql`SELECT c.conname::text AS name, c.convalidated AS validated FROM pg_catalog.pg_constraint c
                        WHERE c.connamespace = 'public'::regnamespace AND c.conname = ANY(${[...DB_RULE_NAMES]}::text[])`
          ),
        };
      },
      { timeout: 90_000 }
    );
    const r = reportLines(counts, catalog);
    console.log(`  ${'rule'.padEnd(48)} ${'kind'.padEnd(5)} ${'rows'.padStart(7)}   state`);
    for (const line of r.lines) console.log(line);
    console.log('');
    console.log(`Rows that break a rule: ${r.violations}   rules missing: ${r.missing}`);
    console.log(
      r.ready.length
        ? `Ready for a VALIDATE migration (0 here; check UAT too): ${r.ready.length} rule(s)`
        : 'No rule is ready for a VALIDATE migration yet.'
    );
    const t = temixPathLines(temix);
    console.log('');
    console.log('The Temix batch paths (one statement over many customers fails whole on one such row):');
    console.log(`  ${'rule'.padEnd(48)} ${'queued'.padStart(7)} ${'settling'.padStart(9)}`);
    for (const line of t.lines) console.log(line);
    console.log(
      `  queued: Generate holds these back, named, until corrected (${t.queued}). ` +
        `settling: archived rows of a batch not yet marked loaded; Mark loaded refuses that batch until they are corrected (${t.settling}).`
    );
    if (t.settling > 0) {
      console.log('  DEPLOY PRECONDITION: finish those batches (loaded into Temix, then Mark loaded) before the rules go live, or correct the rows.');
    }
    console.log('What each rule refuses and how to correct a row: docs/OPERATIONS.md section 5l.\n');
    return r.violations === 0 && r.missing === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (/db-rules-report\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nDB RULES REPORT FAILED: ${operatorErrorLabel(e)}\n`);
      process.exit(2);
    });
}
