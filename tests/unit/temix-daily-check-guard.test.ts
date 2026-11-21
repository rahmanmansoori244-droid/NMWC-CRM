/**
 * The daily Temix import, stage 4: the Check writes nothing, and the route map
 * has one writer. Structural, as the house rules ask: the defect would be "the
 * preview wrote something" or "something else wrote the route map", so this
 * reads the sources.
 *
 *  - The Check (lib/temix-daily-check.ts), its reads (lib/temix-daily-check-load.ts),
 *    the preview page, the route-map page and the pilot banner name no model
 *    write, no raw UPDATE, INSERT or DELETE, no change context and no audit
 *    write.
 *  - services/temix-daily-routes.ts writes TemixRouteMap only, each write in
 *    withChangeContext under src.temixRouteMap with one AuditLog row, and is the
 *    Data Steward's only. No other source writes TemixRouteMap, through Prisma
 *    or a raw INSERT.
 *  - The two pages are the Data Steward's only, checked before any read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

const WRITE = '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)';
const MODEL_WRITE_RE = new RegExp(`\\b(?:tx|prisma|db)\\s*\\.\\s*([a-zA-Z]+)\\s*\\.\\s*${WRITE}\\s*\\(`, 'g');
const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

const READ_ONLY = [
  'lib/temix-daily-check.ts',
  'lib/temix-daily-check-load.ts',
  'lib/temix-daily-route-map.ts',
  'app/(app)/temix-daily/[fileId]/page.tsx',
  'app/(app)/temix-daily/routes/page.tsx',
  'app/(app)/temix-daily/pilot-banner.tsx',
  // Stage 6: finalize's plan, the day's reads and the drill-down page.
  'lib/temix-daily-finalize.ts',
  'lib/temix-daily-day-load.ts',
  'app/(app)/temix-daily/day/[loadDay]/page.tsx',
];
const ROUTES_SERVICE = 'services/temix-daily-routes.ts';

/**
 * Raw SQL anywhere in a source (outside comments) that INSERTs INTO
 * TemixRouteMap: a $executeRaw or $queryRaw template, Prisma.sql, or a string
 * passed to an Unsafe call. The database refuses UPDATE, DELETE and TRUNCATE
 * of the table, but the app role may INSERT, so only the service may.
 */
function rawRouteMapWrites(src: string): string[] {
  return [...src.matchAll(/\bINSERT\s+INTO\s+(?:"?public"?\.)?"?TemixRouteMap"?(?![A-Za-z0-9_])/gi)].map((m) => m[0]);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'node_modules' || e === '.next' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

describe('the Check writes nothing', () => {
  it('the detector still matches the shape it exists to catch', () => {
    const hits = (s: string) => [...s.matchAll(new RegExp(MODEL_WRITE_RE.source, 'g'))].map((m) => m[1]);
    expect(hits('await db.branch.update({})')).toEqual(['branch']);
    expect(hits('await tx\n  .temixRouteMap\n  .create({})')).toEqual(['temixRouteMap']);
    expect(hits('await db.branch.findMany({})')).toEqual([]);
  });

  for (const file of READ_ONLY) {
    it(`${file}: no write of any kind`, () => {
      const code = read(file);
      expect([...code.matchAll(MODEL_WRITE_RE)].map((m) => m[0])).toEqual([]);
      expect(code).not.toMatch(/\$executeRaw/);
      expect(code).not.toMatch(/\$queryRaw(Unsafe)?[^`]*`[^`]*\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
      expect(code).not.toMatch(/withChangeContext|setChangeContext|writeAudit|notifyUsers|pg_advisory/);
    });
  }

  it('the reads select no name, phone, address or CR number of a staged row or a customer', () => {
    const load = read('lib/temix-daily-check-load.ts');
    expect(load).not.toMatch(/custName|'phone'|'address'|crNo|legalName|primaryPhone|contactPerson|crNumber/);
    expect(load).not.toMatch(/"raw"/);
  });
});

describe('the route map has one writer', () => {
  const code = read(ROUTES_SERVICE);

  it('it writes TemixRouteMap only, in a change context of its own, with one audit row per write', () => {
    expect([...new Set([...code.matchAll(MODEL_WRITE_RE)].map((m) => m[1]))]).toEqual(['temixRouteMap']);
    expect([...code.matchAll(/withChangeContext\(prisma, \{ actorId: me\.id, source: src\.temixRouteMap\('(add|retire)'/g)].map((m) => m[1])).toEqual([
      'add',
      'retire',
    ]);
    expect([...code.matchAll(/\bwriteAudit\(tx,/g)]).toHaveLength(2);
    expect([...code.matchAll(/entityType: 'TemixRouteMap'/g)]).toHaveLength(2);
    expect(code).not.toMatch(/\$executeRaw(Unsafe)?`\s*(UPDATE|INSERT|DELETE)/i);
    for (const t of ['"Customer"', '"Branch"', '"Route"', '"TemixDailyRow"', '"TemixDailyFile"', '"TemixChange"']) expect(code, t).not.toContain(t);
    // No isolation level is asked for: the database's guard needs READ COMMITTED.
    expect(code).not.toMatch(/isolationLevel/);
  });

  it('it is the Data Steward\'s only, asked first in each action', () => {
    expect(code).toMatch(/if \(user\.role !== Role\.STEWARD\)\s*\{\s*throw new ForbiddenError/);
    for (const fn of ['addTemixRouteMapAction', 'retireTemixRouteMapAction']) {
      expect(code).toMatch(new RegExp(`export async function ${fn}[\\s\\S]*?runAction\\(async \\(\\) => \\{\\s*const me = await requireSteward\\(\\);`));
    }
  });

  it('the raw-SQL detector still matches the shape it exists to catch', () => {
    expect(rawRouteMapWrites('await tx.$executeRaw`INSERT INTO "TemixRouteMap" ("x") VALUES (1)`')).toHaveLength(1);
    expect(rawRouteMapWrites("await db.$executeRawUnsafe('insert into \"TemixRouteMap\" values (1)')")).toHaveLength(1);
    expect(rawRouteMapWrites('await db.$queryRaw`\n  INSERT INTO\n public."TemixRouteMap" (a) VALUES (1) RETURNING id`')).toHaveLength(1);
    expect(rawRouteMapWrites('Prisma.sql`INSERT INTO TemixRouteMap (a) VALUES (1)`')).toHaveLength(1);
    expect(rawRouteMapWrites('await db.$queryRaw`SELECT * FROM "TemixRouteMap"`')).toEqual([]);
    expect(rawRouteMapWrites('await db.$executeRaw`INSERT INTO "TemixRouteMapX" (a) VALUES (1)`')).toEqual([]);
    expect(rawRouteMapWrites('await db.$executeRaw`INSERT INTO "TemixChange" (a) VALUES (1)`')).toEqual([]);
  });

  it('no other source writes the route map, through Prisma or raw SQL', () => {
    const found: string[] = [];
    for (const file of ['app', 'components', 'lib', 'services', 'scripts', 'prisma'].flatMap(walk)) {
      if (file === ROUTES_SERVICE) continue;
      const src = read(file);
      for (const m of src.matchAll(MODEL_WRITE_RE)) if (m[1] === 'temixRouteMap') found.push(`${file}: ${m[0]}`);
      for (const w of rawRouteMapWrites(src)) found.push(`${file}: ${w}`);
    }
    expect(found).toEqual([]);
  });
});

describe('the pages are the Data Steward\'s only', () => {
  for (const [file, firstRead] of [
    ['app/(app)/temix-daily/[fileId]/page.tsx', 'prisma.temixDailyFile.findUnique'],
    ['app/(app)/temix-daily/routes/page.tsx', 'loadRoutes(prisma)'],
    ['app/(app)/temix-daily/day/[loadDay]/page.tsx', 'prisma.temixDailyFile.findMany'],
  ] as const) {
    it(file, () => {
      const page = read(file);
      expect(page).toMatch(/if \(session\.user\.role !== Role\.STEWARD\) redirect\('\/home'\);/);
      expect(page.indexOf("redirect('/home')")).toBeGreaterThan(0);
      expect(page.indexOf("redirect('/home')")).toBeLessThan(page.indexOf(firstRead));
    });
  }
});
