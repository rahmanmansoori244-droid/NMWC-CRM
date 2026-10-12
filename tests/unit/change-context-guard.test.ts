import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

/**
 * Gap 24 (data audit 2026-10-10): every write transaction in the request-serving
 * tree names who made it and why (lib/change-context.ts). The dated history is
 * written by database triggers whatever the code does, so a path that forgets
 * its context is not lost — it is recorded under source 'sql', which reads as
 * "somebody typed SQL" and is reported on /status. That makes a forgotten context
 * a bug with a visible symptom, and this guard is what stops one reaching main.
 *
 * Structural, per CLAUDE.md: the defect is "nobody called it". Comments are
 * stripped first, so prose quoting a banned shape neither passes nor fails it.
 */

const ROOTS = ['app', 'components', 'lib', 'services'];

/** May open a transaction directly: the helper itself, and a read-only reporter. */
const TRANSACTION_ALLOWED = new Set([
  'lib/change-context.ts',
  'lib/db.ts',
  // Read-only: SET LOCAL statement_timeout around SELECTs for the insights page.
  'lib/insights/load.ts',
]);

/**
 * The tables a history trigger watches (part A), and Attachment, whose history
 * part B adds. Not CustomerEdit: a request row is its own record (no history
 * table watches it), and the salesman's submit stays one autocommitted insert.
 */
const MASTER = '(customer|branch|user|route|region|attachment)';
const WRITE = '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)';

/** `.$transaction(` on any client, however Prettier wraps the chain. */
const TRANSACTION_RE = /\.\s*\$transaction\s*\(/g;
/** A master write on the top-level pooled client, outside any transaction. */
const BARE_WRITE_RE = new RegExp(`\\bprisma\\s*\\.\\s*${MASTER}\\s*\\.\\s*${WRITE}\\s*\\(`, 'g');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'node_modules' || e === '.next' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

function sources(): Array<{ file: string; code: string }> {
  return ROOTS.flatMap(walk).map((file) => ({
    file,
    code: stripComments(readFileSync(file, 'utf8'), file),
  }));
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

describe('gap 24: every write transaction names its cause', () => {
  it('the detectors still match the shapes they exist to catch (a broken regex fails open)', () => {
    const hits = (re: RegExp, s: string) => [...s.matchAll(new RegExp(re.source, 'g'))].length;
    expect(hits(TRANSACTION_RE, 'await prisma.$transaction(async (tx) => {})')).toBe(1);
    expect(hits(TRANSACTION_RE, 'await prisma\n  .$transaction(\n  async (tx) => {})')).toBe(1);
    expect(hits(TRANSACTION_RE, 'await this.db.$transaction([a, b])')).toBe(1);
    expect(hits(TRANSACTION_RE, 'await withChangeContext(prisma, ctx, async (tx) => {})')).toBe(0);
    expect(hits(BARE_WRITE_RE, 'await prisma.customer.update({ where })')).toBe(1);
    expect(hits(BARE_WRITE_RE, 'await prisma\n  .branch\n  .upsert({})')).toBe(1);
    expect(hits(BARE_WRITE_RE, 'await prisma.attachment.create({ data })')).toBe(1);
    expect(hits(BARE_WRITE_RE, 'await tx.customer.update({ where })')).toBe(0);
    expect(hits(BARE_WRITE_RE, 'await prisma.customer.findMany({})')).toBe(0);
    expect(hits(BARE_WRITE_RE, 'await prisma.notification.create({})')).toBe(0);
  });

  it('no file in app/, components/, lib/ or services/ opens a transaction except through withChangeContext', () => {
    const found: string[] = [];
    for (const { file, code } of sources()) {
      if (TRANSACTION_ALLOWED.has(file)) continue;
      for (const m of code.matchAll(TRANSACTION_RE))
        found.push(`${file}:${lineOf(code, m.index ?? 0)}`);
    }
    expect(
      found,
      'open the transaction with withChangeContext(prisma, { actorId, source: src.<kind>(...) }, fn, opts) ' +
        'from lib/change-context.ts, so the history triggers record who and why'
    ).toEqual([]);
  });

  it('no master table is written on the bare pooled client — only the sign-in stamp, which no history watches', () => {
    const found: string[] = [];
    for (const { file, code } of sources()) {
      for (const m of code.matchAll(BARE_WRITE_RE)) {
        const at = m.index ?? 0;
        // lib/auth.ts: lastLoginAt on a successful sign-in. Not a watched column,
        // so it writes no history, and a transaction per sign-in buys nothing.
        if (
          file === 'lib/auth.ts' &&
          /^prisma\.user\.update\(\{\s*where:\s*\{\s*id:\s*user\.id\s*\},\s*data:\s*\{\s*lastLoginAt:\s*new Date\(\)\s*\},?\s*\}\)/.test(
            code.slice(at)
          )
        ) {
          continue;
        }
        found.push(`${file}:${lineOf(code, at)}`);
      }
    }
    expect(found, 'write it on the transaction client of a withChangeContext(...) call').toEqual(
      []
    );
  });

  it('the one allowed bare write is still there and still writes only lastLoginAt (the allowance cannot outlive it)', () => {
    const code = stripComments(readFileSync('lib/auth.ts', 'utf8'), 'lib/auth.ts');
    const writes = [...code.matchAll(BARE_WRITE_RE)];
    expect(writes).toHaveLength(1);
    expect(code.slice(writes[0]!.index ?? 0)).toMatch(
      /^prisma\.user\.update\(\{\s*where:\s*\{\s*id:\s*user\.id\s*\},\s*data:\s*\{\s*lastLoginAt:/
    );
  });

  it('every service that opens a transaction names a cause with a src.* builder', () => {
    // Non-vacuity: the guard above passes trivially if nothing writes at all.
    const users = sources().filter(({ code }) => /\bwithChangeContext\s*\(/.test(code));
    expect(users.length).toBeGreaterThanOrEqual(15);
    for (const { file, code } of users) {
      if (file === 'lib/change-context.ts') continue;
      expect(code, `${file} calls withChangeContext without a src.* source`).toMatch(
        /\bsrc\.[a-zA-Z]+\(/
      );
    }
  });
});
