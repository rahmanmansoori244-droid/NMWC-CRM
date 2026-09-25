// @vitest-environment node
/**
 * scripts/ops/recompute-cr-norm.ts (benchmark item 16): after normalizeCR
 * began folding Arabic-Indic digits and stripping invisible characters, the
 * stored norms written before it are recomputed. These pin which rows it
 * rewrites, that each write names the row as it was read, and the operator
 * conventions every ops script here keeps. The run itself is exercised against
 * the UAT database, never here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import {
  planCrNormFixes,
  fixKind,
  guardedWhere,
  crPairCount,
} from '../../scripts/ops/recompute-cr-norm';
import { normalizeCR } from '@/lib/cr';

const ARABIC = String.fromCharCode(0x661, 0x662, 0x663, 0x664, 0x665, 0x666, 0x667);
const ZW = String.fromCharCode(0x200b);

describe('planCrNormFixes', () => {
  it('rewrites exactly the rows whose stored norm is not what normalizeCR makes of their CR', () => {
    const rows = [
      { id: 'ascii', crNumber: '1234567', crNumberNorm: '1234567' }, // already right
      { id: 'arabic', crNumber: ARABIC, crNumberNorm: ARABIC }, // stored before the fold
      { id: 'zw', crNumber: `123${ZW}4567`, crNumberNorm: `123${ZW}4567` }, // stored before the strip
      { id: 'blank', crNumber: '   ', crNumberNorm: null }, // already right: no CR
      { id: 'orphan', crNumber: null, crNumberNorm: 'X' }, // a norm with no CR behind it
      { id: 'missing', crNumber: 'cr-9', crNumberNorm: null }, // a CR never normalized
    ];
    const fixes = planCrNormFixes(rows);
    expect(fixes.map((f) => [f.id, f.next])).toEqual([
      ['arabic', '1234567'],
      ['zw', '1234567'],
      ['orphan', null],
      ['missing', 'CR-9'],
    ]);
    // Every planned value is normalizeCR's, so the two can never disagree.
    for (const f of fixes) expect(f.next).toBe(normalizeCR(f.crNumber));
    // And the rows carry through whatever else was read (the guard needs it).
    expect(planCrNormFixes([{ id: 'a', crNumber: ARABIC, crNumberNorm: ARABIC, updatedAt: new Date(0) }])[0]).toMatchObject({
      updatedAt: new Date(0),
    });
  });

  it('is idempotent: a second plan over the fixed rows is empty', () => {
    const rows = [
      { id: 'a', crNumber: ARABIC, crNumberNorm: ARABIC },
      { id: 'b', crNumber: `x${ZW}y`, crNumberNorm: null },
    ];
    const fixed = planCrNormFixes(rows).map((f) => ({ id: f.id, crNumber: f.crNumber, crNumberNorm: f.next }));
    expect(planCrNormFixes(fixed)).toEqual([]);
  });

  it('classifies each fix for the counts', () => {
    expect(fixKind({ crNumberNorm: 'A', next: 'B' })).toBe('changed');
    expect(fixKind({ crNumberNorm: 'A', next: null })).toBe('cleared');
    expect(fixKind({ crNumberNorm: null, next: 'B' })).toBe('filled');
  });
});

describe('guardedWhere — a concurrent edit is never overwritten', () => {
  it('names the row by id, its CR as read and its norm as read', () => {
    expect(guardedWhere({ id: 'd1', crNumber: ARABIC, crNumberNorm: ARABIC })).toEqual({
      id: 'd1',
      crNumber: ARABIC,
      crNumberNorm: ARABIC,
    });
  });

  it("and a customer's updatedAt as read, so any edit since the read makes it match nothing", () => {
    const updatedAt = new Date('2026-09-01T00:00:00Z');
    expect(guardedWhere({ id: 'c1', crNumber: null, crNumberNorm: 'X', updatedAt })).toEqual({
      id: 'c1',
      crNumber: null,
      crNumberNorm: 'X',
      updatedAt,
    });
  });
});

describe('crPairCount', () => {
  it('counts one pair per two customers sharing a norm, and none for a blank', () => {
    expect(crPairCount([])).toBe(0);
    expect(crPairCount(['A', 'B', null, null, ''])).toBe(0);
    expect(crPairCount(['A', 'A', 'A', 'B', 'B'])).toBe(4);
  });
});

describe('the script keeps the operator conventions (comment-stripped source)', () => {
  const src = stripComments(readFileSync('scripts/ops/recompute-cr-norm.ts', 'utf8'), 'x.ts');
  const main = src.slice(src.indexOf('async function main('));

  it('owner connection, its own client, --expect-host before any read, dry run unless --apply', () => {
    expect(main).toMatch(/process\.env\.DIRECT_URL \?\? process\.env\.DATABASE_URL/);
    expect(main).toMatch(/new PrismaClient\(\{ datasourceUrl: url \}\)/);
    expect(main.indexOf('requireExpectedHost(')).toBeGreaterThan(-1);
    expect(main.indexOf('requireExpectedHost(')).toBeLessThan(main.indexOf('new PrismaClient('));
    expect(main).toMatch(/const apply = args\.includes\('--apply'\)/);
    // Every write sits after the dry run's return.
    const dryReturn = main.indexOf('if (!apply)');
    expect(dryReturn).toBeGreaterThan(-1);
    for (const w of ['.updateMany(', 'auditLog.create(']) {
      expect(main.indexOf(w)).toBeGreaterThan(dryReturn);
    }
  });

  it('every row write is guarded on the row as read, and writes the norm only', () => {
    const writes = [...main.matchAll(/\.updateMany\(\{\s*where: ([^,]+),\s*data: \{([^}]*)\}/g)];
    expect(writes).toHaveLength(2);
    for (const [, where, data] of writes) {
      expect(where.trim()).toBe('guardedWhere(f)');
      expect(data).toMatch(/crNumberNorm: f\.next/);
      expect(data).not.toMatch(/crNumber:|version/);
    }
    // The customer write puts updatedAt back as it was read: the master export's
    // "updated since" filter reads it, and the customer's data has not changed.
    const customerWrite = main.slice(main.indexOf('prisma.customer.updateMany('));
    expect(customerWrite.slice(0, customerWrite.indexOf('});'))).toMatch(/updatedAt: f\.updatedAt/);
  });

  it('prints and records counts only — no CR value reaches the console or the ledger', () => {
    // Every console line and every ledger payload is built from counts, the host
    // and the actor; nothing that reads a row's crNumber or norm is interpolated.
    for (const m of main.matchAll(/console\.log\(([\s\S]*?)\);/g)) {
      expect(m[1]).not.toMatch(/\.crNumber|\.next\b|crNumberNorm/);
    }
    for (const m of main.matchAll(/auditLog\.create\(([\s\S]*?)\n {4}\}\);/g)) {
      expect(m[1]).not.toMatch(/\.crNumber|\.next\b|f\.crNumberNorm/);
    }
  });

  it('runs main() only as a command, so importing it for these tests opens no connection', () => {
    expect(src).toMatch(/if \(\/recompute-cr-norm\\\.ts\$\/\.test\(process\.argv\[1\] \?\? ''\)\)/);
  });

  it('is an npm script beside the other operator scripts', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ops:recompute-cr-norm']).toBe('tsx scripts/ops/recompute-cr-norm.ts');
  });
});
