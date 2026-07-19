/**
 * QA constraint smoke — enumerates the DB invariants that live in migration SQL
 * (partial unique indexes, CHECK constraints) to confirm they are PRESENT in the
 * QA branch. `prisma db push` syncs to schema.prisma and may drop invariants that
 * schema.prisma cannot express, so this verifies which survived. Read-only.
 * Run: npx tsx scripts/qa/constraint-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) {
  console.error('ABORT: production endpoint'); process.exit(2);
}
const prisma = new PrismaClient();

// Invariants we expect (name -> where it is defined). Verified against pg_catalog.
const EXPECTED_PARTIAL_UNIQUE = [
  'CustomerEdit_open_per_customer',
  'CustomerEdit_open_per_branch',
  'Customer_primaryPhoneNorm_active_unique',
];

async function main() {
  // 1) all partial indexes (indexes WITH a WHERE clause)
  const partial = await prisma.$queryRaw<{ indexname: string; tablename: string; indexdef: string }[]>`
    SELECT indexname, tablename, indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexdef ILIKE '%WHERE%'
    ORDER BY tablename, indexname`;
  const partialNames = new Set(partial.map((p) => p.indexname));
  console.log(`partial indexes present: ${partial.length}`);
  for (const p of partial) console.log('  •', p.indexname, '→', p.indexdef.replace(/^CREATE/, '').slice(0, 120));

  // 2) CHECK constraints
  const checks = await prisma.$queryRaw<{ conname: string; rel: string; def: string }[]>`
    SELECT c.conname, t.relname AS rel, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='c' AND n.nspname='public'
    ORDER BY t.relname, c.conname`;
  console.log(`\nCHECK constraints present: ${checks.length}`);
  for (const c of checks) console.log('  •', c.rel + '.' + c.conname, '→', c.def.slice(0, 90));

  // 3) FK + unique + trigger counts
  const [fk] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public'`;
  const [uq] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint n FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%UNIQUE%'`;
  const [trg] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint n FROM pg_trigger tg JOIN pg_class t ON t.oid=tg.tgrelid JOIN pg_namespace nn ON nn.oid=t.relnamespace WHERE NOT tg.tgisinternal AND nn.nspname='public'`;
  console.log(`\nFK constraints: ${Number(fk.n)} | unique indexes: ${Number(uq.n)} | user triggers: ${Number(trg.n)}`);

  const missing = EXPECTED_PARTIAL_UNIQUE.filter((n) => !partialNames.has(n));
  console.log('\nVERDICT:', {
    expectedPartialUnique: EXPECTED_PARTIAL_UNIQUE.length,
    presentPartialUnique: EXPECTED_PARTIAL_UNIQUE.filter((n) => partialNames.has(n)),
    MISSING_partialUnique: missing,
    checkConstraintCount: checks.length,
  });
  if (missing.length) console.log('\n⚠ MISSING invariants — db push dropped migration-only indexes; provisioning must apply them.');
}
main().catch((e) => { console.error('SMOKE_ERROR:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
