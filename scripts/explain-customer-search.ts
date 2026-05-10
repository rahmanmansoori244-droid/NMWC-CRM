/**
 * P3.1 — Verify pg_trgm GIN-index acceleration on Customer search.
 *
 * The senior-audit B-10 migration created three GIN indexes on Customer:
 *   - Customer_legalName_trgm_idx       on legalName
 *   - Customer_nmwcCode_trgm_idx        on nmwcCode
 *   - Customer_primaryPhoneNorm_trgm_idx (partial) on primaryPhoneNorm
 *
 * The /customers page issues
 *   WHERE deletedAt IS NULL
 *     AND ( legalName ILIKE '%q%' OR nmwcCode ILIKE '%q%' OR primaryPhone ILIKE '%q%' )
 *
 * With gin_trgm_ops the planner CAN choose a Bitmap Index Scan for ILIKE
 * patterns of >=3 chars. This script issues representative EXPLAIN ANALYZE
 * queries against the live DB and prints which plan node was chosen
 * (Index Scan / Bitmap Index Scan / Seq Scan) plus the total time.
 *
 * Run:  npx tsx scripts/explain-customer-search.ts
 *
 * Reads DIRECT_URL (or DATABASE_URL fallback) from .env via dotenv.
 */
import { config as dotenv } from 'dotenv';
dotenv({ path: '.env' });
dotenv({ path: '.env.local', override: true });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  log: ['error'],
});

interface ExplainRow {
  'QUERY PLAN': string;
}

const QUERIES: { label: string; sql: string; params: unknown[] }[] = [
  {
    label: "legalName ILIKE '%lulu%'",
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT id, "legalName" FROM "Customer" WHERE "deletedAt" IS NULL AND "legalName" ILIKE $1 LIMIT 50`,
    params: ['%lulu%'],
  },
  {
    label: "legalName ILIKE '%abu%'",
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT id, "legalName" FROM "Customer" WHERE "deletedAt" IS NULL AND "legalName" ILIKE $1 LIMIT 50`,
    params: ['%abu%'],
  },
  {
    label: "primaryPhone ILIKE '%+96891234567%'",
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT id, "legalName" FROM "Customer" WHERE "deletedAt" IS NULL AND "primaryPhone" ILIKE $1 LIMIT 50`,
    params: ['%+96891234567%'],
  },
  {
    label: "nmwcCode ILIKE '%CCA0367%'",
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT id, "legalName" FROM "Customer" WHERE "deletedAt" IS NULL AND "nmwcCode" ILIKE $1 LIMIT 50`,
    params: ['%CCA0367%'],
  },
  {
    label:
      "OR (legalName | nmwcCode | primaryPhone) ILIKE '%lulu%' (the production /customers query)",
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT id, "legalName" FROM "Customer" WHERE "deletedAt" IS NULL AND ("legalName" ILIKE $1 OR "nmwcCode" ILIKE $1 OR "primaryPhone" ILIKE $1) LIMIT 50`,
    params: ['%lulu%'],
  },
];

function detectPlan(text: string): string {
  // Look for the topmost interesting node
  if (/Bitmap Index Scan on "Customer_\w+_trgm_idx"/.test(text)) return 'Bitmap Index Scan (GIN trgm)';
  if (/Bitmap Index Scan on "Customer_legalName_idx"/.test(text)) return 'Bitmap Index Scan (B-tree legalName)';
  if (/Index Scan using "Customer_\w+_trgm_idx"/.test(text)) return 'Index Scan (GIN trgm)';
  if (/Bitmap Heap Scan on "Customer".*\n\s+->\s+Bitmap Index Scan/.test(text)) return 'Bitmap Heap Scan (some index)';
  if (/Seq Scan on "Customer"/.test(text)) return 'Seq Scan (no index used)';
  return 'unknown plan';
}

function totalTime(text: string): string {
  const m = text.match(/Execution Time:\s*([0-9.]+)\s*ms/);
  return m ? `${m[1]} ms` : 'unknown';
}

function planningTime(text: string): string {
  const m = text.match(/Planning Time:\s*([0-9.]+)\s*ms/);
  return m ? `${m[1]} ms` : 'unknown';
}

async function main() {
  console.log('P3.1 — EXPLAIN ANALYZE for Customer search queries\n');
  console.log(`DB: ${(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '').replace(/:[^:@]+@/, ':***@')}\n`);
  for (const q of QUERIES) {
    console.log('────────────────────────────────────────────────────────────');
    console.log(`Query: ${q.label}`);
    try {
      const rows = (await prisma.$queryRawUnsafe(q.sql, ...q.params)) as ExplainRow[];
      const text = rows.map((r) => r['QUERY PLAN']).join('\n');
      console.log(text);
      console.log(`\n  → Plan: ${detectPlan(text)}`);
      console.log(`  → Planning time: ${planningTime(text)}`);
      console.log(`  → Execution time: ${totalTime(text)}\n`);
    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}\n`);
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
