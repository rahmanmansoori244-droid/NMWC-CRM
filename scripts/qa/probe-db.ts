/**
 * QA isolation probe — proves the DB in .env is an ISOLATED, EMPTY (schema-only)
 * branch, NOT production. Prints only aggregate counts + non-secret metadata.
 * Run: npx tsx scripts/qa/probe-db.ts
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// self-load .env (no dependency) so PrismaClient sees DATABASE_URL/DIRECT_URL
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// hard safety gate: refuse to run against the known production endpoint
const url = process.env.DATABASE_URL ?? '';
if (url.includes('ep-sweet-haze')) {
  console.error('ABORT: DATABASE_URL points at the production endpoint (ep-sweet-haze).');
  process.exit(2);
}
const host = /@([^/]+)\//.exec(url)?.[1] ?? '?';

const prisma = new PrismaClient();

async function main() {
  const now = await prisma.$queryRaw<{ db: string; usr: string; now: Date }[]>`
    SELECT current_database() AS db, current_user AS usr, now() AS now`;
  console.log('connected:', { host, db: now[0].db, user: now[0].usr });

  // table inventory (public schema)
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name`;
  console.log('public tables:', tables.length);

  // aggregate row counts only — never any row content (PII-safe)
  const counts: Record<string, number> = {};
  for (const t of ['Customer', 'Branch', 'User', 'CustomerEdit', 'AuditLog', 'Attachment', 'Region', 'Route']) {
    try {
      const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}"`);
      counts[t] = Number(r[0].n);
    } catch {
      counts[t] = -1; // table missing
    }
  }
  console.log('row counts:', counts);

  // migration fingerprint
  try {
    const mig = await prisma.$queryRaw<{ n: bigint; last: string | null }[]>`
      SELECT count(*)::bigint AS n, max(migration_name) AS last FROM "_prisma_migrations"`;
    console.log('_prisma_migrations:', { applied: Number(mig[0].n), last: mig[0].last });
  } catch {
    console.log('_prisma_migrations: <absent>');
  }

  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0).map(([t]) => t);
  const missing = Object.entries(counts).filter(([, n]) => n < 0).map(([t]) => t);
  console.log('VERDICT:', {
    isolated_endpoint: !url.includes('ep-sweet-haze'),
    schema_present: missing.length === 0,
    data_empty: nonEmpty.length === 0,
    nonEmptyTables: nonEmpty,
    missingTables: missing,
  });
}

main().catch((e) => { console.error('PROBE_ERROR:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
