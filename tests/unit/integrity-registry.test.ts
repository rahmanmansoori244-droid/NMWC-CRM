// @vitest-environment node
/**
 * Gap 29: the registry of nightly checks (lib/integrity/checks.ts) keeps its own
 * rules.
 *
 *  - Ids are unique, versions start at 1, every check has a policy, a reason
 *    and a remedy; the seal checks are reported by the seal step, every other
 *    check has a query.
 *  - The data and behaviour checks leave the flagged test records out: their
 *    SQL names isTest (or the shared realBranchSql) for the master tables they
 *    read. The mechanism checks do NOT, because they test the recorder, and a
 *    mis-flag must not hide a defect (test-flags-changed reads the flag itself).
 *  - The checks the design names are all there, and the Steward's alert reaches
 *    the critical webhook only for the record-keeping ones.
 *  - The owner's decisions of 2026-10-24: test-scaffolding-mixed is information,
 *    and scheduled-jobs-on-time alerts only for the jobs listed as alerting (the
 *    SLA sweep, the backup and this watch); every other job, a new one included,
 *    is information.
 *  - The owner's decisions of 2026-10-25: Temix codes are unique and the
 *    database enforces it (temix-code-shared says so); CR numbers are not, and
 *    cr-number-shared lists the live customers sharing one, as information, on
 *    the key the duplicates detector pairs by, with a link to /duplicates.
 *
 * Structural, per CLAUDE.md: comments are stripped before the source is read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { CHECKS, CHECK_BY_ID, CRITICAL_CHECKS } from '@/lib/integrity/checks';
import { checkStatus } from '@/lib/integrity/classify';
import { ALERTING_JOBS } from '@/lib/integrity/policy';
import { HEARTBEAT_EXPECTATIONS } from '@/lib/heartbeat';

const src = stripComments(readFileSync('lib/integrity/checks.ts', 'utf8'), 'checks.ts');
/** Each check's own source, from its `id:` to the next check's. */
function block(id: string): string {
  const start = src.indexOf(`id: '${id}',`);
  expect(start, id).toBeGreaterThan(-1);
  const next = src.indexOf("\n    id: '", start + 10);
  return src.slice(start, next < 0 ? src.length : next);
}

describe('the registry', () => {
  it('names the checks of the design, each once', () => {
    expect(CHECKS.map((c) => c.id)).toEqual([
      'shop-region-matches-route',
      'customer-status-follows-shops',
      'temix-code-shared',
      'temix-code-shape',
      'cr-number-shared',
      'test-scaffolding-mixed',
      'history-open-interval',
      'history-matches-master',
      'history-unattributed-since-last-run',
      'protection-triggers',
      'protection-functions',
      'runtime-role-privileges',
      'app-login-is-runtime-role',
      'customer-code-sequence',
      'scheduled-jobs-on-time',
      'test-flags-changed',
      'db-rules-older-rows',
      'seal-written',
      'seal-chain-intact',
      'seal-offsite-copies',
      'exports-since-last-run',
      'sign-in-failures-since-last-run',
    ]);
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });

  it.each(CHECKS.map((c) => [c.id, c] as const))('%s: version, policy, reason and remedy', (_id, c) => {
    expect(c.version).toBeGreaterThanOrEqual(1);
    expect(['alert', 'info']).toContain(c.policy);
    expect(c.title.length).toBeGreaterThan(10);
    expect(c.why.length).toBeGreaterThan(30);
    expect(c.remedy.length).toBeGreaterThan(20);
    expect(c.id).toMatch(/^[a-z][a-z0-9-]+$/);
    if (c.id.startsWith('seal-')) expect(c.run).toBeUndefined();
    else expect(typeof c.run).toBe('function');
  });

  it('every check alerts but the six that are information (test-scaffolding-mixed and cr-number-shared by the owner’s decisions of 2026-10-24 and 2026-10-25)', () => {
    expect(CHECKS.filter((c) => c.policy === 'info').map((c) => c.id)).toEqual([
      // Owner decision 2026-10-25: CR numbers are not unique, but every shared one is flagged.
      'cr-number-shared',
      'test-scaffolding-mixed',
      'app-login-is-runtime-role',
      // Gap 31: the older rows the NOT VALID rules would refuse — information until 0, then VALIDATE.
      'db-rules-older-rows',
      'exports-since-last-run',
      'sign-in-failures-since-last-run',
    ]);
    expect([...CRITICAL_CHECKS]).toEqual(['seal-chain-intact', 'protection-triggers', 'protection-functions']);
  });

  it('test-scaffolding-mixed never fails, whatever it finds', () => {
    const c = CHECK_BY_ID.get('test-scaffolding-mixed')!;
    expect(checkStatus(c.policy, 0)).toBe('info');
    expect(checkStatus(c.policy, 12)).toBe('info');
  });

  it('scheduled-jobs-on-time alerts only for the jobs listed as alerting; every other job is information', () => {
    expect(CHECK_BY_ID.get('scheduled-jobs-on-time')!.policy).toBe('alert');
    expect([...ALERTING_JOBS]).toEqual(['sla-escalate', 'db-backup', 'integrity-watch']);
    // Every listed job is a job the schedule knows.
    for (const key of ALERTING_JOBS) expect(Object.keys(HEARTBEAT_EXPECTATIONS)).toContain(key);
    // The housekeeping and courtesy jobs are not listed: their missed runs are information.
    for (const key of ['keep-warm', 'email-drain', 'photo-gc', 'retention-sweep']) {
      expect(Object.keys(HEARTBEAT_EXPECTATIONS)).toContain(key);
      expect(ALERTING_JOBS).not.toContain(key);
    }
    // The check reads the list through scheduledJobFindings, not missedRuns' raw count.
    expect(block('scheduled-jobs-on-time')).toMatch(/scheduledJobFindings\(missed\)/);
    expect(block('scheduled-jobs-on-time')).not.toMatch(/count: missed\.length/);
  });
});

describe('test records: left out of the data, never out of the recorder', () => {
  const MASTERS = ['Customer', 'Branch', 'Route', 'Region', 'User'];

  it.each(CHECKS.filter((c) => c.group !== 'mechanism').map((c) => [c.id, c] as const))(
    '%s leaves the test records out of every master table it reads',
    (id, c) => {
      expect(c.excludesTest).toBe(true);
      const b = block(id);
      for (const t of MASTERS) {
        if (!b.includes(`"${t}"`) && !(t === 'Branch' && b.includes('realBranchSql'))) continue;
        expect(b, `${id} reads "${t}"`).toMatch(/isTest|realBranchSql/);
      }
      // And a data check that reads a shop reads it through the shared rule, or names all three flags.
      if (b.includes('"Branch" b') && !b.includes('test-scaffolding')) expect(b).toMatch(/realBranchSql\('b'\)|"isTest"/);
    }
  );

  it.each(CHECKS.filter((c) => c.group === 'mechanism' && c.id !== 'test-flags-changed').map((c) => [c.id, c] as const))(
    '%s does not filter the test records',
    (id, c) => {
      expect(c.excludesTest).toBe(false);
      expect(block(id)).not.toMatch(/isTest|realBranchSql/);
    }
  );

  it('the data checks that read a shop exclude it by its customer, route and region', () => {
    for (const id of ['shop-region-matches-route', 'customer-status-follows-shops']) {
      expect(block(id)).toContain("realBranchSql('b')");
    }
  });
});

describe('owner decisions 2026-10-25: Temix codes unique, CR numbers flagged', () => {
  it('temix-code-shared still alerts, and says the database now enforces it and which index to check', () => {
    const c = CHECK_BY_ID.get('temix-code-shared')!;
    expect(c).toMatchObject({ group: 'data', policy: 'alert', excludesTest: true, version: 1 });
    expect(c.why).toContain('The database now enforces it');
    expect(c.why).toContain('should always find none');
    expect(c.remedy).toContain('Customer_temixCode_live_unique');
    expect(c.remedy).toContain('OPERATIONS.md section 5l');
    // The same key as the index: upper case, the ends trimmed, live customers.
    expect(block('temix-code-shared')).toContain('upper(btrim(c."temixCode"))');
  });

  it('cr-number-shared is information on the live real customers sharing a normalised CR, linking to /duplicates', () => {
    const c = CHECK_BY_ID.get('cr-number-shared')!;
    expect(c).toMatchObject({ group: 'data', policy: 'info', excludesTest: true, version: 1 });
    expect(c.link).toEqual({ href: '/duplicates', label: 'Review them on the duplicates page' });
    expect(c.remedy).toContain('it never alerts');
    expect(checkStatus(c.policy, 0)).toBe('info');
    expect(checkStatus(c.policy, 4_000)).toBe('info');
    const b = block('cr-number-shared');
    // The duplicates detector's CR key (lib/duplicate-pairing.ts crKey): crNumberNorm, never blank.
    expect(b).toContain('GROUP BY c."crNumberNorm" HAVING count(*) > 1');
    expect(b).toContain('c."deletedAt" IS NULL AND NOT c."isTest"');
    expect(b).toContain(`c."crNumberNorm" <> ''`);
    // Ids and counts only: the CR number groups the rows, it is never selected.
    expect(b).toContain('SELECT array_agg(c."id" ORDER BY c."id") AS ids FROM "Customer" c');
    expect(b).toContain('return sharedCrFindings(rows)');
  });

  it('only cr-number-shared links elsewhere, and its samples are shown as customer codes', async () => {
    expect(CHECKS.filter((c) => c.link).map((c) => c.id)).toEqual(['cr-number-shared']);
    const { CUSTOMER_SAMPLES } = await import('@/lib/integrity/report');
    expect(CUSTOMER_SAMPLES.has('cr-number-shared')).toBe(true);
  });
});

describe('db-rules-older-rows (gap 31)', () => {
  it('counts every row the rules of lib/db-rules.ts would refuse, test rows included, and reads the catalog', () => {
    const c = CHECK_BY_ID.get('db-rules-older-rows')!;
    expect(c).toMatchObject({ group: 'mechanism', policy: 'info', excludesTest: false, version: 1 });
    expect(c.title).toBe('Older rows that break the newer database rules');
    expect(c.remedy).toContain('OPERATIONS.md section 5l');
    const b = block('db-rules-older-rows');
    // One statement from the shared builder, the catalog by name, the pure classifier.
    expect(b).toContain('Prisma.raw(dbRulesCountSql())');
    expect(b).toContain('pg_catalog.pg_constraint');
    expect(b).toContain('convalidated');
    expect(b).toContain('return dbRuleFindings(rows, catalog)');
    expect(checkStatus(c.policy, 232)).toBe('info');
  });
});

describe('what a result may hold', () => {
  it('ids and counts only: no check reads a personal column into its result', () => {
    for (const c of CHECKS) {
      const b = block(c.id);
      expect(b, c.id).not.toMatch(/"legalName"|"primaryPhone"|"crNumber"|"contactPerson"|"fullName"|"email"|"phone"|"address"|"gpsLat" AS|"usernameHmac"|"ip"/);
    }
    // The Temix codes are read to classify, never returned: the result is ids and counts.
    expect(block('temix-code-shape')).toMatch(/return \{ count: r\.count, sampleIds: r\.sampleIds, detail: r\.detail \}/);
    expect(block('temix-code-shared')).toMatch(/detail: \{ codes: rows\.length \}/);
  });

  it('every SQL statement is a read', () => {
    // (The privilege NAMES UPDATE, DELETE and TRUNCATE are read by has_table_privilege, not run.)
    expect(src).not.toMatch(/\b(INSERT INTO "|UPDATE "|DELETE FROM "|TRUNCATE "|ALTER TABLE|DROP (TABLE|TRIGGER|FUNCTION))/);
  });
});
