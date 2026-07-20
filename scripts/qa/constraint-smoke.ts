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

// Invariants that MUST be present (verified against pg_catalog + migrations).
const REQUIRED_PARTIAL_UNIQUE = [
  'CustomerEdit_open_per_customer',
  'CustomerEdit_open_per_branch',
];
// Intentionally ABSENT: migration 20260510160000_p1_drop_phone_unique drops
// Customer_primaryPhoneNorm_active_unique (phone dups allowed at master level).
// Its presence would be a REGRESSION, so we assert it is NOT there.
const MUST_BE_ABSENT_PARTIAL_UNIQUE = ['Customer_primaryPhoneNorm_active_unique'];
// CHECK constraints + trigger that must exist (Phase-1 + live-Branch invariants).
const REQUIRED_CHECKS = [
  'Branch_gpsLat_range', 'Branch_gpsLng_range', 'Branch_address_minlength',
  'Attachment_capturedLat_range', 'Attachment_capturedLng_range',
  'EditBranchDraft_gpsLat_range', 'EditBranchDraft_gpsLng_range', 'EditBranchDraft_address_minlength',
  'Customer_creditLimit_nonneg', 'Customer_paymentTermDays_range',
  'CustomerEdit_reqCreditLimit_nonneg', 'CustomerEdit_reqPaymentTermDays_range',
];
const REQUIRED_TRIGGERS = [
  'branch_region_consistency_check', 'editbranchdraft_region_consistency_check',
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

  // 3) FK + unique counts + trigger NAMES
  const [fk] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public'`;
  const [uq] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint n FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%UNIQUE%'`;
  const trg = await prisma.$queryRaw<{ tgname: string }[]>`SELECT tg.tgname FROM pg_trigger tg JOIN pg_class t ON t.oid=tg.tgrelid JOIN pg_namespace nn ON nn.oid=t.relnamespace WHERE NOT tg.tgisinternal AND nn.nspname='public'`;
  const triggerNames = new Set(trg.map((t) => t.tgname));
  const checkNames = new Set(checks.map((c) => c.conname));
  console.log(`\nFK constraints: ${Number(fk.n)} | unique indexes: ${Number(uq.n)} | user triggers: ${trg.length}`);

  // ── ASSERTIONS: this script is a GATE (E3). Exit non-zero on any violation
  // so it can be automated on exit code, not just eyeballed. ──
  const failures: string[] = [];
  for (const n of REQUIRED_PARTIAL_UNIQUE) if (!partialNames.has(n)) failures.push(`missing partial-unique index: ${n}`);
  for (const n of MUST_BE_ABSENT_PARTIAL_UNIQUE) if (partialNames.has(n)) failures.push(`REGRESSION — index that must be absent is present: ${n}`);
  for (const n of REQUIRED_CHECKS) if (!checkNames.has(n)) failures.push(`missing CHECK constraint: ${n}`);
  for (const n of REQUIRED_TRIGGERS) if (!triggerNames.has(n)) failures.push(`missing trigger: ${n}`);

  console.log('\nVERDICT:', {
    requiredPartialUnique: `${REQUIRED_PARTIAL_UNIQUE.filter((n) => partialNames.has(n)).length}/${REQUIRED_PARTIAL_UNIQUE.length}`,
    requiredChecks: `${REQUIRED_CHECKS.filter((n) => checkNames.has(n)).length}/${REQUIRED_CHECKS.length}`,
    requiredTriggers: `${REQUIRED_TRIGGERS.filter((n) => triggerNames.has(n)).length}/${REQUIRED_TRIGGERS.length}`,
    pass: failures.length === 0,
  });
  if (failures.length) {
    console.error('\n❌ CONSTRAINT SMOKE FAILED — invariants missing/regressed:');
    for (const f of failures) console.error('   • ' + f);
    process.exit(3);
  }
  console.log('\n✅ CONSTRAINT SMOKE PASSED — all required DB invariants present.');
}
main().catch((e) => { console.error('SMOKE_ERROR:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
