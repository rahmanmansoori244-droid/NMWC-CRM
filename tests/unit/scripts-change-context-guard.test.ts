import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

/**
 * Gap 24 (data audit 2026-10-10): an operator script, a seed or a probe that
 * writes the customer, branch, user, route or region tables names its run as the
 * cause (src.script / src.seed / src.verify from lib/change-context.ts), so the
 * dated history says "script zero-credit-limits, run <id>, operator <Steward>"
 * instead of 'sql' (somebody typed SQL).
 *
 * Derived, not listed: tests/unit/audit-guard.test.ts learned that a list of the
 * scripts that write fails OPEN when a new one appears. This walks scripts/ and
 * prisma/*.ts for anything that writes a master table and asks each one.
 */

const MASTER_WRITE = new RegExp(
  [
    '\\.\\s*(customer|branch|user|route|region|attachment|customerEdit)\\s*\\.\\s*' +
      '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\\s*\\(',
    '(UPDATE|INSERT INTO|DELETE FROM)\\s+(public\\.)?"(Customer|Branch|User|Route|Region|Attachment|_ManagerRegions)"',
  ].join('|')
);
const IMPORTS_CONTEXT =
  /import\s*\{[^}]*\b(setChangeContext|changeContextStatement|contextClient|withChangeContext)\b[^}]*\}\s*from\s*'(\.\.\/)+lib\/change-context'/;
const NAMES_RUN = /\bsrc\.(script|seed|verify)\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|mts|cts)$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

function writers(): string[] {
  const files = [
    ...walk('scripts'),
    ...readdirSync('prisma')
      .filter((f) => /\.ts$/.test(f))
      .map((f) => `prisma/${f}`),
  ];
  return files.filter((f) => MASTER_WRITE.test(stripComments(readFileSync(f, 'utf8'), f))).sort();
}

describe('gap 24: operator scripts, seeds and probes name their run', () => {
  it('the detector still matches the write shapes scripts use (a broken regex fails open)', () => {
    for (const s of [
      'await prisma.customer.updateMany({ where })',
      'await tx.branch.update({})',
      'await prisma\n  .user\n  .create({})',
      'await tx.$executeRawUnsafe(`UPDATE "Branch" SET x = 1`)',
      'tx.$queryRaw`UPDATE "Branch" AS b SET`',
      'INSERT INTO "Region" ("id") VALUES (\'x\')',
    ]) {
      expect(MASTER_WRITE.test(s), s).toBe(true);
    }
    expect(MASTER_WRITE.test('await prisma.customer.findMany({})')).toBe(false);
    expect(MASTER_WRITE.test('await prisma.auditLog.create({})')).toBe(false);
  });

  it('finds the known writers (non-vacuous)', () => {
    const found = writers();
    for (const f of [
      'scripts/ops/zero-credit-limits.ts',
      'scripts/ops/visitdays-from-sheets.ts',
      'scripts/golive/bootstrap-accounts.ts',
      'prisma/seed.ts',
      'prisma/synthetic.ts',
    ]) {
      expect(found, f).toContain(f);
    }
  });

  it('every one imports the change context and names its run with src.script, src.seed or src.verify', () => {
    const missing: string[] = [];
    for (const f of writers()) {
      const code = stripComments(readFileSync(f, 'utf8'), f);
      if (!IMPORTS_CONTEXT.test(code) || !NAMES_RUN.test(code)) missing.push(f);
    }
    expect(
      missing,
      'set the change context in each write transaction: setChangeContext(tx, { actorId, source: src.script(name, runId) }),\n' +
        'or prisma.$transaction([changeContextStatement(prisma, ctx), write]) for a single statement'
    ).toEqual([]);
  });
});
