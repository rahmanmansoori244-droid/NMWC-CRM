/**
 * The branch address minimum lives in TWO places and must not drift.
 *
 * `Branch_address_minlength` — CHECK (length(btrim(address)) >= 3) — is created
 * in raw migration SQL and does NOT appear in schema.prisma, so nothing in the
 * TypeScript world can see it. services/imports.ts therefore carries the number
 * as `BRANCH_ADDRESS_MIN`, and a duplicated constant with a comment asking the
 * next person to keep it in step is not a guard. This is the guard.
 *
 * WHAT IT COST, which is why the number is worth pinning. The importer's address
 * fallback handled an EMPTY address (final-hunt #8) and let a 1-2 character one
 * through. 26 customers carried a one- or two-letter area abbreviation from the
 * source sheet; Postgres refused every one of them, and because a CHECK violation
 * reaches Prisma as PrismaClientUnknownRequestError — which has no `code` at all —
 * the Steward was told only "promote failed (UNKNOWN)". Those 26 failed all three
 * customer loads of 2026-09-23 with that message.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'prisma/migrations';

/** Every migration's SQL, comments stripped — a commented-out CHECK is not one. */
function migrationSql(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((d) => /^\d/.test(d))
    .map((d) => ({ file: join(MIGRATIONS, d, 'migration.sql'), dir: d }))
    .filter((m) => {
      try {
        readFileSync(m.file, 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .map((m) => ({
      file: m.file,
      sql: readFileSync(m.file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, ''),
    }));
}

describe('Branch_address_minlength', () => {
  it('is created by a migration, and the importer uses the same number', () => {
    const hits = migrationSql()
      .map((m) => ({
        file: m.file,
        // length(btrim("address")) >= N — quoting and spacing vary between the
        // hand-written DO-blocks in this repo, so match loosely on the shape and
        // strictly on the number.
        match: /length\s*\(\s*btrim\s*\(\s*"?address"?\s*\)\s*\)\s*>=\s*(\d+)/i.exec(m.sql),
      }))
      .filter((h) => h.match);

    expect(hits.length, 'no migration creates the address minimum any more').toBeGreaterThan(0);

    const fromMigration = Number(hits[hits.length - 1].match![1]);
    const service = readFileSync('services/imports.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const declared = /const BRANCH_ADDRESS_MIN\s*=\s*(\d+)/.exec(service);

    expect(declared, 'services/imports.ts no longer declares BRANCH_ADDRESS_MIN').not.toBeNull();
    expect(
      Number(declared![1]),
      `the migration requires ${fromMigration} characters and services/imports.ts assumes ` +
        `${declared![1]}. The import will send addresses the database refuses, and a CHECK ` +
        'violation surfaces with NO Prisma error code — the Steward sees only "promote failed ' +
        '(UNKNOWN)".'
    ).toBe(fromMigration);
  });

  it('the fallback chain applies that minimum rather than only rejecting empty', () => {
    // The defect was not the constant, it was `||` falling through '' but not 'X'.
    // Pin the shape: the address expression must go through usableBranchAddress,
    // and that helper must compare against the constant.
    const src = readFileSync('services/imports.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(src).toMatch(/function usableBranchAddress\([\s\S]{0,300}BRANCH_ADDRESS_MIN/);
    // The branch payload's address must be built by the helper, not by a bare `||`
    // chain on the raw value.
    expect(src).toMatch(/address:\s*\n?\s*usableBranchAddress\(/);
    expect(
      src,
      'the old `p.address ||` fallback is back; it accepts a 1-2 character address ' +
        'that the database will refuse'
    ).not.toMatch(/address:\s*\n?\s*p\.address\s*\|\|/);
  });
});
