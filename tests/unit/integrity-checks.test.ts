// @vitest-environment node
/**
 * Gap 29 (data audit 2026-10-10): the rules of the nightly checks, without a
 * database (lib/integrity/classify.ts; the SQL that feeds them is in
 * lib/integrity/checks.ts and runs on Postgres in
 * tests/integration/integrity-watch.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { HEARTBEAT_EXPECTATIONS, STALE_AFTER_INTERVALS } from '@/lib/heartbeat';
import {
  alertText,
  capSamples,
  checkStatus,
  classifyTemixCodes,
  codeSequenceFindings,
  daysBetween,
  functionFindings,
  missedRuns,
  statusDriftFindings,
  storedTemixCodeProblem,
  testFlagChanges,
  triggerFindings,
} from '@/lib/integrity/classify';
import { EXPECTED_FUNCTIONS, TRIGGER_BINDINGS } from '@/lib/integrity/expected';
import { CustomerStatus } from '@prisma/client';
import { customerStatusFollowing, statusEvents } from '@/lib/customer-status-rule';
import { KNOWN_LEGACY_SPACED_TEMIX_CODES, SAMPLE_LIMIT } from '@/lib/integrity/policy';

describe('status and samples', () => {
  it('an alert check fails on any record; an info check never; an override wins', () => {
    expect(checkStatus('alert', 0)).toBe('pass');
    expect(checkStatus('alert', 1)).toBe('fail');
    expect(checkStatus('info', 9)).toBe('info');
    expect(checkStatus('alert', 9, 'info')).toBe('info');
  });

  it('at most ten samples, each once, BigInt ids as text', () => {
    expect(capSamples(Array.from({ length: 25 }, (_, i) => `c${i}`))).toHaveLength(SAMPLE_LIMIT);
    expect(capSamples([1n, 1n, 'a', 2])).toEqual(['1', 'a', '2']);
  });
});

describe('customer-status-follows-shops (the customer-status rule)', () => {
  it('counts close and reopen; lists review as information; leaves a consistent or held customer alone', () => {
    const r = statusDriftFindings([
      { id: 'c', status: 'ACTIVE', shops: ['SUSPENDED', 'CLOSED'] }, // review
      { id: 'a', status: 'ACTIVE', shops: ['CLOSED', 'CLOSED'] }, // close
      { id: 'b', status: 'CLOSED', shops: ['ACTIVE', 'CLOSED'] }, // reopen
      { id: 'd', status: 'SUSPENDED', shops: ['ACTIVE'] }, // a hold a person set: not drift
      { id: 'e', status: 'ACTIVE', shops: ['ACTIVE'] },
    ]);
    expect(r).toEqual({ count: 2, sampleIds: ['a', 'b'], detail: { close: 1, reopen: 1, review: 1, info: ['c'] } });
  });

  it('the rule itself leaves "review": suspending the only open shop moves nothing, so the check must not fail on it', () => {
    // An ACTIVE customer, one ACTIVE shop and one CLOSED; the open shop is suspended.
    const events = statusEvents(CustomerStatus.ACTIVE, CustomerStatus.SUSPENDED);
    const after = customerStatusFollowing(CustomerStatus.ACTIVE, [CustomerStatus.SUSPENDED, CustomerStatus.CLOSED], events);
    expect(after).toBe(CustomerStatus.ACTIVE);
    const r = statusDriftFindings([{ id: 'x', status: after, shops: ['SUSPENDED', 'CLOSED'] }]);
    expect(r.count).toBe(0);
    expect(checkStatus('alert', r.count)).toBe('pass');
    expect(r.detail).toMatchObject({ review: 1, info: ['x'] });
  });
});

describe('temix-code-shape', () => {
  it('names what is wrong with a stored code', () => {
    expect(storedTemixCodeProblem('CAA0367')).toBeNull();
    expect(storedTemixCodeProblem('caa0367')).toBe('not-normalised');
    expect(storedTemixCodeProblem(' CAA0367')).toBe('not-normalised');
    expect(storedTemixCodeProblem('CAA 0367')).toBe('space');
    expect(storedTemixCodeProblem('NMWC-2026-000101')).toBe('crm-code');
    expect(storedTemixCodeProblem('AB')).toBe('length');
    expect(storedTemixCodeProblem('-AB1')).toBe('shape');
  });

  it('the three migrated codes with a space inside are information; the fourth fails, and so does everything else', () => {
    const legacy = (i: number) => ({ id: `L${i}`, code: `CAK 02${i}`, nmwcCode: `CAK 02${i}` });
    const rows = [legacy(1), legacy(2), legacy(3), legacy(4), { id: 'X', code: 'caa0367', nmwcCode: 'NMWC-2026-000001' }];
    const r = classifyTemixCodes(rows);
    expect(KNOWN_LEGACY_SPACED_TEMIX_CODES).toBe(3);
    expect(r.detail.info).toEqual(['L1', 'L2', 'L3']);
    expect(r.sampleIds).toEqual(['L4', 'X']);
    expect(r.detail.byProblem).toEqual({ 'legacy-space-beyond-known': 1, 'not-normalised': 1 });
  });

  it('a space that is not the customer’s own code, or that hides another fault, is never the legacy case', () => {
    const r = classifyTemixCodes([
      { id: 'A', code: 'CAA 0367', nmwcCode: 'NMWC-2026-000101' }, // not its own code
      { id: 'B', code: 'C 1', nmwcCode: 'C 1' }, // "C1" is too short even without the space
    ]);
    expect(r.detail.info).toEqual([]);
    expect(r.count).toBe(2);
  });
});

describe('customer-code-sequence', () => {
  it('a counter behind the highest code, or one that went back, is a finding; the first run records', () => {
    const first = codeSequenceFindings([{ scope: 'CUSTOMER-2026', next: 11, maxSeq: 10 }], null);
    expect(first).toMatchObject({ count: 0, detail: { scopes: { 'CUSTOMER-2026': 11 }, firstRun: true } });

    const behind = codeSequenceFindings([{ scope: 'CUSTOMER-2026', next: 10, maxSeq: 10 }], { 'CUSTOMER-2026': 9 });
    expect(behind).toMatchObject({ count: 1, sampleIds: ['CUSTOMER-2026'], detail: { byKind: { 'behind-codes': 1, 'went-back': 0 } } });

    const back = codeSequenceFindings([{ scope: 'CUSTOMER-2026', next: 8, maxSeq: 5 }], { 'CUSTOMER-2026': 12 });
    expect(back.detail.byKind).toEqual({ 'behind-codes': 0, 'went-back': 1 });

    const gone = codeSequenceFindings([], { 'CUSTOMER-2025': 4 });
    expect(gone).toMatchObject({ count: 1, sampleIds: ['CUSTOMER-2025'] });

    // No code of that year yet: nothing to be behind.
    expect(codeSequenceFindings([{ scope: 'CUSTOMER-2027', next: 1, maxSeq: null }], null).count).toBe(0);
  });
});

describe('scheduled-jobs-on-time (missedRuns)', () => {
  const day = '2026-10-23';
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 23, h, m));
  const ok = Object.keys(HEARTBEAT_EXPECTATIONS).map((key) => ({ key: key as never, state: 'ok' as const }));
  const base = { expectations: HEARTBEAT_EXPECTATIONS, days: [day], heartbeat: ok, selfKey: 'integrity-watch', selfHasEarlierRun: true, staleAfterIntervals: STALE_AFTER_INTERVALS };
  /** A full day of every job, on schedule. */
  function onSchedule() {
    const runs: Array<{ key: string; at: Date }> = [];
    for (let h = 3; h < 15; h++) {
      for (let m = 0; m < 60; m += 4) runs.push({ key: 'keep-warm', at: at(h, m) });
      for (let m = 0; m < 60; m += 10) runs.push({ key: 'email-drain', at: at(h, m) });
      runs.push({ key: 'sla-escalate', at: at(h, 15) }, { key: 'sla-escalate', at: at(h, 45) });
    }
    runs.push({ key: 'photo-gc', at: at(3) }, { key: 'retention-sweep', at: at(3, 30) }, { key: 'integrity-watch', at: at(2, 30) });
    return runs;
  }

  it('a day on schedule misses nothing', () => {
    expect(missedRuns({ ...base, runs: onSchedule() })).toEqual([]);
  });

  it('a windowed job: gaps in the middle, at the opening and at the close', () => {
    const runs = onSchedule().filter(
      (r) => !(r.key === 'sla-escalate' && (r.at < at(5) || (r.at >= at(9) && r.at < at(11)) || r.at >= at(13)))
    );
    // Opening gap (03:00 -> 05:15), a middle gap (08:45 -> 11:15), a closing gap (12:45 -> 15:00).
    expect(missedRuns({ ...base, runs })).toEqual([{ key: 'sla-escalate', kind: 'gap', day, gaps: 3 }]);
  });

  it('a daily job: no run that Oman day (a run at 23:30 Oman counts for that day)', () => {
    const runs = onSchedule().filter((r) => r.key !== 'photo-gc');
    expect(missedRuns({ ...base, runs })).toEqual([{ key: 'photo-gc', kind: 'no-run', day }]);
    const late = [...runs, { key: 'photo-gc', at: new Date('2026-10-23T19:30:00Z') }];
    expect(missedRuns({ ...base, runs: late })).toEqual([]);
    const nextDay = [...runs, { key: 'photo-gc', at: new Date('2026-10-23T20:30:00Z') }];
    expect(missedRuns({ ...base, runs: nextDay })).toEqual([{ key: 'photo-gc', kind: 'no-run', day }]);
  });

  it('the nightly dump is judged by its heartbeat (40 h), and never / stale jobs are reported now', () => {
    const heartbeat = ok.map((h) => (h.key === 'db-backup' ? { ...h, state: 'stale' as const } : h.key === 'photo-gc' ? { ...h, state: 'never' as const } : h));
    expect(missedRuns({ ...base, runs: onSchedule(), heartbeat })).toEqual([
      { key: 'photo-gc', kind: 'never' },
      { key: 'db-backup', kind: 'stale' },
    ]);
  });

  it('the check skips itself until it has run once before', () => {
    const runs = onSchedule().filter((r) => r.key !== 'integrity-watch');
    const heartbeat = ok.map((h) => (h.key === 'integrity-watch' ? { ...h, state: 'never' as const } : h));
    expect(missedRuns({ ...base, runs, heartbeat, selfHasEarlierRun: false })).toEqual([]);
    expect(missedRuns({ ...base, runs, heartbeat, selfHasEarlierRun: true }).map((m) => m.kind)).toEqual(['no-run', 'never']);
  });

  it('the days between the last checked day and yesterday', () => {
    expect(daysBetween('2026-10-20', '2026-10-23')).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(daysBetween('2026-10-23', '2026-10-23')).toEqual([]);
    expect(daysBetween('2026-01-01', '2026-12-31')).toHaveLength(31);
  });
});

describe('protection-triggers and protection-functions', () => {
  const all = Object.entries(TRIGGER_BINDINGS).map(([name, b]) => ({ name, enabled: 'O', table: b.table, fn: b.fn }));

  it('every binding present and on: nothing', () => {
    expect(triggerFindings(all, TRIGGER_BINDINGS)).toEqual([]);
    // 'A' (always) fires in a normal session too.
    expect(triggerFindings(all.map((t) => ({ ...t, enabled: 'A' })), TRIGGER_BINDINGS)).toEqual([]);
  });

  it('missing, disabled, replica-only and re-pointed are each named', () => {
    const rows = all
      .filter((t) => t.name !== 'auditlog_append_only')
      .map((t) =>
        t.name === 'customer_history_capture'
          ? { ...t, enabled: 'D' }
          : t.name === 'branch_history_capture'
            ? { ...t, enabled: 'R' }
            : t.name === 'sealrecord_link_guard'
              ? { ...t, fn: 'nmwc_noop' }
              : t
      );
    expect(triggerFindings(rows, TRIGGER_BINDINGS).sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
      { name: 'auditlog_append_only', kind: 'missing' },
      { name: 'branch_history_capture', kind: 'replica-only' },
      { name: 'customer_history_capture', kind: 'disabled' },
      { name: 'sealrecord_link_guard', kind: 'rebound' },
    ]);
  });

  it('a function body replaced, its rights or search path changed, or gone, is named', () => {
    const rows = Object.entries(EXPECTED_FUNCTIONS).map(([name, f]) => ({
      name,
      md5: f.md5,
      securityDefiner: f.securityDefiner,
      config: [`search_path=${f.searchPath}`],
    }));
    expect(functionFindings(rows, EXPECTED_FUNCTIONS)).toEqual([]);
    const broken = rows
      .filter((r) => r.name !== 'nmwc_is_test_guard')
      .map((r) =>
        r.name === 'nmwc_forbid_audit_mutation'
          ? { ...r, md5: '0'.repeat(32) }
          : r.name === 'nmwc_history_customer'
            ? { ...r, securityDefiner: false }
            : r.name === 'nmwc_seal_link_guard'
              ? { ...r, config: null }
              : r
      );
    expect(functionFindings(broken, EXPECTED_FUNCTIONS).sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
      { name: 'nmwc_forbid_audit_mutation', kind: 'body-changed' },
      { name: 'nmwc_history_customer', kind: 'rights-changed' },
      { name: 'nmwc_is_test_guard', kind: 'missing' },
      { name: 'nmwc_seal_link_guard', kind: 'search-path-changed' },
    ]);
  });
});

describe('test-flags-changed', () => {
  it('the first run records; a set that changes is named; order does not matter', () => {
    const now = { Customer: ['c2', 'c1'], User: ['u1'], Route: [], Region: ['g1'] };
    const first = testFlagChanges(now, null);
    expect(first).toMatchObject({ firstRun: true, changed: [] });
    expect(testFlagChanges({ ...now, Customer: ['c1', 'c2'] }, first.hashes).changed).toEqual([]);
    expect(testFlagChanges({ ...now, Customer: ['c1'] }, first.hashes).changed).toEqual(['Customer']);
    expect(testFlagChanges({ ...now, Route: ['r9'] }, first.hashes).changed).toEqual(['Route']);
  });
});

describe('the day’s alert words', () => {
  it('titles and counts only, at most five, then "+N more"', () => {
    const fails = Array.from({ length: 7 }, (_, i) => ({ title: `Check ${i}`, count: i + 1 }));
    const t = alertText(fails);
    expect(t.title).toBe('Nightly data check: 7 problems');
    expect(t.body).toBe('Check 0: 1; Check 1: 2; Check 2: 3; Check 3: 4; Check 4: 5 +2 more. Open Service status, Integrity, for what each means and what to do.');
    expect(alertText([{ title: 'One', count: null }]).title).toBe('Nightly data check: 1 problem');
  });
});
