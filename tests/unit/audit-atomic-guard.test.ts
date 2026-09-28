/**
 * F13 (external deep recheck, 2026-09-27): a change and its audit row commit
 * together, or neither does.
 *
 * `writeAudit(tx, …)` writes the row inside the caller's transaction.
 * `writeAudit(null, …)` writes it on its own, so a change made before it can be
 * saved while its audit row is lost, and the action can answer "Nothing was
 * saved" about a change that was saved. That is what the recheck found in
 * reactivation reject, user and route administration and the account import;
 * each now writes its audit row with the transaction that makes the change.
 * lib/audit.ts also accepts the top-level `prisma`, or no client at all, for a
 * stand-alone write: the same split, spelled differently.
 *
 * What is left writing on its own is listed below, each with the reason it is
 * written apart. A new writeAudit whose first argument is anything but `tx`,
 * anywhere under app/, lib/, services/ or components/, fails here until it is
 * either moved into its transaction or added to this list with a reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../support/strip-comments';

const ROOTS = ['app', 'lib', 'services', 'components'];

/** file → how many stand-alone writeAudit calls it may hold, and why each is written apart. */
const EVENT_ONLY: Record<string, { count: number; why: string }> = {
  'lib/auth.ts': {
    count: 2,
    why: 'LOGIN_FAIL: the failed sign-in is the event, nothing else is written. LOGIN follows the lastLoginAt write and is deliberately best-effort: a lost row is logged and never blocks the sign-in, so lastLoginAt can stand without it',
  },
  'app/actions/auth.ts': {
    count: 1,
    why: 'LOGOUT: bumps sessionsRevokedAt, then records the sign-out; the row is swallowed on purpose so signing out always works (B-04)',
  },
  'services/exports.ts': { count: 1, why: 'EXPORT: records a read, and fails closed before the file is returned' },
  'services/customer-export.ts': { count: 1, why: 'EXPORT: records a read, fails closed before the file is returned' },
  'app/api/exports/changes/route.ts': { count: 1, why: 'EXPORT: records a read, fails closed before the file is returned' },
  'services/temix.ts': { count: 1, why: 'EXPORT of a Temix batch re-download (X-TEMIX-2): records a read' },
  'services/duplicates.ts': {
    count: 2,
    why: 'Mark distinct and its undo: the audit row IS the record (an append-only ledger read by the detector); there is no other write',
  },
  'services/imports.ts': {
    count: 2,
    why: 'the per-batch IMPORT summaries. Account import: each applied row committed with its own audit row already. Customer import: there is no per-row audit row; each ImportRow state (PROMOTED/REJECTED) and the ImportBatch counters are the per-row record. Both summaries follow committed work and are deliberately swallowed and logged (DG-06/07)',
  },
};

/**
 * A writeAudit call whose first argument is not `tx`: null, the top-level
 * prisma, any other client, or none. Not the declaration in lib/audit.ts.
 */
const STANDALONE_AUDIT = /(?<!\bfunction\s+)\bwriteAudit\s*\((?!\s*tx\b)/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join('/');

function standaloneAuditCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = stripComments(readFileSync(file, 'utf8'), file);
      const n = (src.match(STANDALONE_AUDIT) ?? []).length;
      if (n > 0) counts[rel(file)] = n;
    }
  }
  return counts;
}

describe('a change and its audit row commit together (F13)', () => {
  it('a writeAudit without tx appears only where the list says, for the reason it gives', () => {
    const found = standaloneAuditCounts();
    const allowed = Object.fromEntries(Object.entries(EVENT_ONLY).map(([f, v]) => [f, v.count]));
    expect(found).toEqual(allowed);
  }, 30_000);

  it('the list names real files, each with a reason', () => {
    for (const [file, { count, why }] of Object.entries(EVENT_ONLY)) {
      expect(statSync(file).isFile(), file).toBe(true);
      expect(count, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });

  it('counts every spelling of a stand-alone write lib/audit.ts accepts, and not the transaction or the declaration', () => {
    const count = (code: string) => (code.match(STANDALONE_AUDIT) ?? []).length;
    // Stand-alone: null, the top-level client lib/audit.ts recommends for it, any
    // other client, no client at all.
    expect(count('await writeAudit(null, env, {});')).toBe(1);
    expect(count('await prisma.region.update(u);\n  await writeAudit(prisma, env, {});')).toBe(1);
    expect(count('await writeAudit(\n    db,\n    env,\n    {}\n  );')).toBe(1);
    expect(count('await writeAudit(txClient, env, {});')).toBe(1);
    expect(count('await writeAudit();')).toBe(1);
    // With the transaction, on any line; and the function's own declaration.
    expect(count('await writeAudit(tx, env, {});')).toBe(0);
    expect(count('await writeAudit(\n      tx,\n      env,\n      {}\n    );')).toBe(0);
    expect(count('export async function writeAudit(\n  client: AuditWriter | null | undefined,\n) {}')).toBe(0);
  });

  it('the paths the recheck named now pass the transaction', () => {
    const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
    const standalone = new RegExp(STANDALONE_AUDIT.source);
    // Reactivation reject, user and route administration: no audit row on its own.
    for (const f of ['services/reactivations.ts', 'services/users.ts', 'services/routes.ts']) {
      expect(src(f), f).not.toMatch(standalone);
      expect(src(f), f).toMatch(/\bwriteAudit\s*\(\s*tx\b/);
    }
  }, 30_000);
});
