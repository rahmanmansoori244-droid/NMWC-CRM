// @vitest-environment node
/**
 * Gap 2 (data audit 2026-10-10): every photo view now writes a PHOTO_VIEW row.
 * Owner decision 2026-10-11 (c): only the Data Steward (Role.STEWARD) may see
 * those rows — no Manager, no other role, on any screen, export or dashboard.
 *
 * Two guards:
 *   1. the Manager's scope (lib/audit-scope.ts managerAuditScopeSql) leaves
 *      every Steward-only action out, as a bound value, before any other test;
 *   2. every reader of AuditLog in app/, lib/, services/ and components/ is on
 *      the list below, with the reason PHOTO_VIEW rows cannot reach a
 *      non-Steward through it. A new reader — a history panel, an export of
 *      audit rows, a dashboard figure — fails here until someone has decided
 *      that, and said how.
 * tests/unit/audit-page.test.tsx renders /audit for each role;
 * tests/integration/audit-manager-scope.test.ts holds the SQL to real Postgres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { AuditAction } from '@prisma/client';
import { MANAGER_AUDIT_ACTIONS, STEWARD_ONLY_AUDIT_ACTIONS, managerAuditScopeSql } from '@/lib/audit-scope';
import { listAuditRows } from '@/lib/audit-rows';
import { stripComments } from '../support/strip-comments';

describe('a Manager’s audit scope never holds a Steward-only action', () => {
  it('PHOTO_VIEW is the Steward-only action, and the Manager’s filter offers every other one', () => {
    expect(STEWARD_ONLY_AUDIT_ACTIONS).toEqual([AuditAction.PHOTO_VIEW]);
    expect([...MANAGER_AUDIT_ACTIONS, ...STEWARD_ONLY_AUDIT_ACTIONS].sort()).toEqual(Object.values(AuditAction).sort());
  });

  it('the exclusion wraps the whole scope, so no entity branch (Attachment included) can bring a photo view back', () => {
    const sql = managerAuditScopeSql({ regionIds: ['g1'], userIds: ['u1'] });
    expect(sql.text.startsWith('(a."action" NOT IN ($1::"AuditAction") AND (\n')).toBe(true);
    expect(sql.text.trimEnd().endsWith('))')).toBe(true);
    expect(sql.values[0]).toBe('PHOTO_VIEW');
    // The Attachment rows of his regions are still his (their other actions).
    expect(sql.text).toContain(`a."entityType" = 'Attachment'`);
  });
});

/** file → why a PHOTO_VIEW row cannot reach a non-Steward through its AuditLog reads. */
const READERS: Record<string, string> = {
  'app/(app)/audit/page.tsx':
    'the only screen that lists audit rows. MANAGER and STEWARD only (anyone else is redirected); the Steward reads every row (photo views when he picks that action or a customer code), a Manager only through managerAuditScopeSql',
  'lib/returned-work.ts': 'an EXISTS on CustomerEdit rows carrying the returned-cleared reason; returns request ids, never a row',
  'services/duplicates.ts': 'CustomerPair rows only (the Mark distinct ledger)',
  'services/imports.ts': 'one Customer CREATE row, to tell a finalize-born customer; returns only whether it exists',
  // Gap 29: the nightly sign-in-failures check counts LOGIN_FAIL rows; a count, never a row.
  'lib/integrity/checks.ts': 'a count of LOGIN_FAIL rows on User entities since the last run; returns a number by kind, never a row',
  // Code review 2026-11-10, finding 23.
  'app/(app)/import/[batchId]/page.tsx':
    'the IMPORT summary row of the account batch on screen (rows done and passwords set, as row numbers); a Steward-only page, ImportBatch entity only',
  // Code review 2026-11-10, finding 23 (adversarial review).
  'lib/account-import-repeat.ts':
    "one account's own password_reset_via_import row from an earlier upload of the same file; returns only its time, never a row",
  // Follow-up 1 (F1): the Steward's list, moved out of the page unchanged; the page calls it only for the Steward.
  'lib/audit-rows.ts':
    "/audit's Steward list (no customer filter): it builds its own where from the filters, photo views left out unless he picks that action; imported and called only on the Steward's path of app/(app)/audit/page.tsx (both pinned at the end of this file)",
  // Follow-up 1 (F2): the dashboard's comparisons read the clean start's moment.
  'lib/clean-start-record.ts':
    "the go-live clean start's own System row (id cleanstart-…, entityId clean-start); returns only its time, never a row",
  // Follow-up 1 (H1, bug hunt round 1, finding 1): the Steward's fix of a held-back row.
  'services/import-fixes.ts':
    "the Branch CREATE rows of one customer's shops, to tell which import row created each; returns only the shop code and that row's number, never a row; Steward-only action",
  // The daily Temix import, review 2026-11-15: how often one customer's transaction failed.
  'services/temix-daily-apply.ts':
    "a count of the file's own TEMIX_DAILY_GROUP_FAILED rows for one customer group; returns a number, never a row",
};

/** The entity type each listed non-page reader is held to, read from its query. */
const READ_ONLY_ENTITY: Record<string, string> = {
  'lib/returned-work.ts': 'CustomerEdit',
  'services/duplicates.ts': 'CustomerPair',
  'services/imports.ts': 'Customer',
  'lib/integrity/checks.ts': 'User',
  'app/(app)/import/[batchId]/page.tsx': 'ImportBatch',
  'lib/account-import-repeat.ts': 'User',
  'lib/clean-start-record.ts': 'System',
  'services/import-fixes.ts': 'Branch',
  'services/temix-daily-apply.ts': 'TemixDailyFile',
};

const ROOTS = ['app', 'lib', 'services', 'components'];
// Case-insensitive, and with or without the schema: Postgres takes `from "AuditLog"`
// and `FROM public."AuditLog"` alike, and a reader written either way would
// otherwise pass unseen (review of gap 2, 2026-10-11).
const READ =
  /\.auditLog\s*\.\s*(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|groupBy|aggregate)\s*\(|\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"AuditLog"|\bauditLogs\s*:/gi;

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

function readers(): Map<string, Array<{ index: number; src: string }>> {
  const found = new Map<string, Array<{ index: number; src: string }>>();
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = stripComments(readFileSync(file, 'utf8'), file);
      const hits = [...src.matchAll(READ)].map((m) => ({ index: m.index!, src }));
      if (hits.length > 0) found.set(rel(file), hits);
    }
  }
  return found;
}

describe('every reader of the audit log keeps photo views from anyone but the Steward', () => {
  it('the reader pattern sees a read however its SQL is cased or qualified', () => {
    for (const read of [
      'SELECT count(*) FROM "AuditLog" a',
      'select a.id from "AuditLog" a',
      'SELECT 1 FROM public."AuditLog" a',
      'left join "public"."AuditLog" l on true',
      'tx.auditLog.findMany(',
      'include: { auditLogs: true }',
    ]) {
      expect([...read.matchAll(READ)], read).toHaveLength(1);
    }
  });

  it('reads AuditLog only where the list says, for the reason it gives', () => {
    const found = readers();
    expect([...found.keys()].sort()).toEqual(Object.keys(READERS).sort());
    for (const [file, why] of Object.entries(READERS)) expect(why.length, file).toBeGreaterThan(20);
  }, 30_000);

  it('each reader other than /audit is held to one entity type that is not Attachment', () => {
    const found = readers();
    for (const [file, entity] of Object.entries(READ_ONLY_ENTITY)) {
      expect(entity).not.toBe('Attachment');
      expect(found.get(file)?.length, file).toBeGreaterThan(0);
      for (const { index, src } of found.get(file) ?? []) {
        // The query's own entity test, within the statement that reads.
        const window = src.slice(index, index + 400);
        const m = /entityType"?\s*[:=]\s*'([A-Za-z]+)'/.exec(window);
        expect(m?.[1], `${file} @${index}`).toBe(entity);
      }
    }
  }, 30_000);

  it('the /audit page lets in only the Manager and the Steward, and reads a Manager’s rows through his scope', () => {
    const src = stripComments(readFileSync('app/(app)/audit/page.tsx', 'utf8'), 'page.tsx');
    expect(src).toMatch(/session\.user\.role !== Role\.MANAGER && session\.user\.role !== Role\.STEWARD\)\s*\{\s*redirect\('\/home'\)/);
    expect(src).toMatch(/managerAuditScopeSql\(/);
    // Every Manager read is built on that scope: the count and the page of ids share one WHERE.
    expect(src.match(/FROM "AuditLog" a WHERE \$\{whereSql\}/g)).toHaveLength(2);
    // Owner decisions 2026-10-11: the customer filter, which reads photo views, is the
    // Steward's alone — a Manager's address cannot turn it on, and his raw reads start
    // from his scope.
    expect(src).toMatch(/const customerCode = isManager \? null : /);
    expect(src).toMatch(/if \(isManager\) \{[\s\S]*?rawConds = \[managerAuditScopeSql\(/);
  });
});

// Review of follow-up 1: lib/audit-rows.ts reads rows of any entity, so its
// place on the list above is made true here. It builds its own `where` from the
// filters (no caller can skip the photo-view exclusion), and only the Steward's
// path of /audit calls it.
describe('lib/audit-rows.ts lists photo views only when the Steward asks for them', () => {
  function fakeDb() {
    const wheres: unknown[] = [];
    const db = {
      auditLog: {
        count: async (a: { where: unknown }) => (wheres.push(a.where), 0),
        findMany: async (a: { where: unknown }) => (wheres.push(a.where), []),
      },
    };
    return { db: db as unknown as Parameters<typeof listAuditRows>[0], wheres };
  }

  it('with no action picked, the count and the page both leave photo views out', async () => {
    const { db, wheres } = fakeDb();
    await listAuditRows(db, { action: null, q: null }, 1);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) expect(w).toEqual({ action: { notIn: [AuditAction.PHOTO_VIEW] } });
  });

  it('photo views only when that action is picked; the other filters as given', async () => {
    const { db, wheres } = fakeDb();
    await listAuditRows(db, { action: AuditAction.PHOTO_VIEW, actor: 'u1', entityType: 'Attachment', q: 'x' }, 2);
    for (const w of wheres) {
      expect(w).toEqual({ action: AuditAction.PHOTO_VIEW, actorId: 'u1', entityType: 'Attachment', entityId: { contains: 'x' } });
    }
  });

  it('only app/(app)/audit/page.tsx imports it, and calls it once, on the Steward’s path without a customer filter', () => {
    const importers: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = stripComments(readFileSync(file, 'utf8'), file);
        if (/from\s+['"](?:@\/lib|\.{1,2}(?:\/[\w.-]+)*)\/audit-rows['"]/.test(src)) importers.push(rel(file));
      }
    }
    expect(importers).toEqual(['app/(app)/audit/page.tsx']);
    const src = stripComments(readFileSync('app/(app)/audit/page.tsx', 'utf8'), 'page.tsx');
    expect(src.match(/listAuditRows\(/g)).toHaveLength(1);
    expect(src).toMatch(/if \(isManager\) \{[\s\S]*?\} else if \(customerCode\) \{[\s\S]*?\} else \{\s*\(\{ total, logs \} = await listAuditRows\(/);
  }, 30_000);
});
