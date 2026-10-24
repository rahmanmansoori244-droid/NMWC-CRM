/**
 * Gap 29 (data audit 2026-10-10): the pure halves of the nightly checks
 * (lib/integrity/checks.ts runs the SQL and hands its rows here), so every rule
 * is unit-tested without a database (tests/unit/integrity-checks.test.ts).
 *
 * PURE: type imports and pure modules only.
 */
import { createHash } from 'node:crypto';
import type { CustomerStatus } from '@prisma/client';
import type { HeartbeatExpectation, HeartbeatReport } from '../heartbeat';
import { statusDrift } from '../customer-status-rule';
import { normalizeTemixCode, temixCodeProblem } from '../temix-code';
import { omanDateISO } from '../tz';
import { DEFAULT_THRESHOLD, KNOWN_LEGACY_SPACED_TEMIX_CODES, SAMPLE_LIMIT, ALERT_BODY_CHECKS } from './policy';

export type CheckStatus = 'pass' | 'fail' | 'info' | 'error';
export type CheckPolicy = 'alert' | 'info';

/** A check's status from its policy and count (an override wins: the check knows best). */
export function checkStatus(policy: CheckPolicy, count: number, override?: CheckStatus, threshold = DEFAULT_THRESHOLD): CheckStatus {
  if (override) return override;
  if (policy === 'info') return 'info';
  return count > threshold ? 'fail' : 'pass';
}

/** At most SAMPLE_LIMIT ids, as text (BigInt ids included), each once, in order. */
export function capSamples(ids: Iterable<unknown>, limit = SAMPLE_LIMIT): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const s = typeof id === 'bigint' ? id.toString() : String(id);
    if (!out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ── 2. customer-status-follows-shops ───────────────────────────────────────

export function statusDriftFindings(rows: Array<{ id: string; status: CustomerStatus | string; shops: Array<CustomerStatus | string> }>) {
  const detail = { close: 0, reopen: 0, review: 0 };
  const ids: string[] = [];
  for (const r of rows) {
    const d = statusDrift(r.status as CustomerStatus, r.shops as CustomerStatus[]);
    if (!d) continue;
    detail[d.kind] += 1;
    ids.push(r.id);
  }
  return { count: ids.length, sampleIds: capSamples(ids), detail };
}

// ── 4. temix-code-shape ────────────────────────────────────────────────────

export type TemixCodeRow = { id: string; code: string; nmwcCode: string };

/**
 * What is wrong with a stored Temix code: the rule the Accountant's box applies
 * (lib/temix-code.ts), and a stored spelling that is not the normalised one
 * (lower case, an outer space, an Arabic digit). Null when it is a good code.
 */
export function storedTemixCodeProblem(code: string): string | null {
  const n = normalizeTemixCode(code);
  if (n !== code) return 'not-normalised';
  const p = temixCodeProblem(n);
  if (!p) return null;
  if (/\s/.test(n)) return 'space';
  if (/^NMWC-\d{4}-\d/.test(n)) return 'crm-code';
  if (n.length < 3 || n.length > 30) return 'length';
  return 'shape';
}

/**
 * The migrated customers whose code is their own customer code with a space
 * inside, and otherwise good: information, up to KNOWN_LEGACY_SPACED_TEMIX_CODES.
 * Any further one, and every other problem, fails.
 */
export function classifyTemixCodes(rows: TemixCodeRow[], knownLegacy = KNOWN_LEGACY_SPACED_TEMIX_CODES) {
  const fail: string[] = [];
  const legacy: string[] = [];
  const byProblem: Record<string, number> = {};
  for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const problem = storedTemixCodeProblem(r.code);
    if (!problem) continue;
    const legacyShape =
      problem === 'space' && r.code === r.nmwcCode && temixCodeProblem(normalizeTemixCode(r.code).replace(/\s+/g, '')) === null;
    if (legacyShape && legacy.length < knownLegacy) {
      legacy.push(r.id);
      continue;
    }
    fail.push(r.id);
    const key = legacyShape ? 'legacy-space-beyond-known' : problem;
    byProblem[key] = (byProblem[key] ?? 0) + 1;
  }
  return { count: fail.length, sampleIds: capSamples(fail), detail: { byProblem, info: legacy } };
}

// ── 13. customer-code-sequence ─────────────────────────────────────────────

export type CodeScopeRow = { scope: string; next: number; maxSeq: number | null };

/**
 * A scope's counter is behind its codes (next - 1 below the highest NMWC-<year>-
 * code, so the next allocation collides and has to skip), or went back since
 * the last run.
 */
export function codeSequenceFindings(rows: CodeScopeRow[], previous: Record<string, number> | null) {
  const findings: Array<{ scope: string; kind: 'behind-codes' | 'went-back' }> = [];
  const scopes: Record<string, number> = {};
  for (const r of rows) {
    scopes[r.scope] = r.next;
    if (r.maxSeq !== null && r.next - 1 < r.maxSeq) findings.push({ scope: r.scope, kind: 'behind-codes' });
    const before = previous?.[r.scope];
    if (before !== undefined && r.next < before) findings.push({ scope: r.scope, kind: 'went-back' });
  }
  // A scope that disappeared since the last run went back too.
  for (const scope of Object.keys(previous ?? {})) {
    if (!(scope in scopes)) findings.push({ scope, kind: 'went-back' });
  }
  const byKind = { 'behind-codes': 0, 'went-back': 0 };
  for (const f of findings) byKind[f.kind] += 1;
  return { count: findings.length, sampleIds: capSamples(findings.map((f) => f.scope)), detail: { byKind, scopes, firstRun: previous === null } };
}

// ── 14. scheduled-jobs-on-time ─────────────────────────────────────────────

export type MissedRun = { key: string; kind: 'gap' | 'no-run' | 'never' | 'stale'; day?: string; gaps?: number };

const omanDay = (d: Date) => omanDateISO(d);

/**
 * The scheduled runs that did not happen, over complete Oman days:
 *   - a windowed job: every gap longer than its staleness allowance between the
 *     window's opening, its runs and the window's close (the windows are UTC
 *     hours inside the Oman day);
 *   - a daily job: no run that day;
 *   - and now: any job the heartbeat calls never-run or stale (the nightly dump
 *     is judged here only: 40 h, as the heartbeat does).
 * The integrity watch itself is skipped until it has run once before.
 */
export function missedRuns(input: {
  expectations: Record<string, HeartbeatExpectation>;
  runs: Array<{ key: string; at: Date }>;
  days: string[];
  heartbeat: Pick<HeartbeatReport, 'key' | 'state'>[];
  selfKey: string;
  selfHasEarlierRun: boolean;
  staleAfterIntervals: number;
}): MissedRun[] {
  const out: MissedRun[] = [];
  const skip = (key: string) => key === input.selfKey && !input.selfHasEarlierRun;
  for (const [key, exp] of Object.entries(input.expectations)) {
    if (skip(key) || key === 'db-backup') continue;
    const allowed = (exp.staleAfterMinutes ?? exp.everyMinutes * input.staleAfterIntervals) * 60_000;
    const mine = input.runs.filter((r) => r.key === key).map((r) => r.at.getTime());
    for (const day of input.days) {
      if (exp.activeHoursUtc) {
        const [y, m, d] = day.split('-').map(Number) as [number, number, number];
        const open = Date.UTC(y, m - 1, d, exp.activeHoursUtc[0]);
        const close = Date.UTC(y, m - 1, d, exp.activeHoursUtc[1]);
        const points = [open, ...mine.filter((t) => t >= open && t < close).sort((a, b) => a - b), close];
        let gaps = 0;
        for (let i = 1; i < points.length; i++) if (points[i]! - points[i - 1]! > allowed) gaps += 1;
        if (gaps > 0) out.push({ key, kind: 'gap', day, gaps });
      } else if (!mine.some((t) => omanDay(new Date(t)) === day)) {
        out.push({ key, kind: 'no-run', day });
      }
    }
  }
  for (const h of input.heartbeat) {
    if (skip(h.key)) continue;
    if (h.state === 'never' || h.state === 'stale') out.push({ key: h.key, kind: h.state });
  }
  return out;
}

/**
 * The calendar days after `after` up to and including `through` (both
 * YYYY-MM-DD, already Oman days): date arithmetic on the calendar, no instant
 * is cut to a date.
 */
export function daysBetween(after: string, through: string, max = 31): string[] {
  const out: string[] = [];
  const [y, m, d] = after.split('-').map(Number) as [number, number, number];
  for (let i = 1; out.length < max; i++) {
    const c = new Date(Date.UTC(y, m - 1, d + i));
    const day = `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
    if (day > through) break;
    out.push(day);
  }
  return out;
}

// ── 9. protection-triggers / 10. protection-functions ──────────────────────

export type TriggerRow = { name: string; enabled: string; table: string; fn: string };
export type TriggerFinding = { name: string; kind: 'missing' | 'disabled' | 'replica-only' | 'rebound' };

/**
 * Every protecting trigger must be there and fire in normal sessions ('O', or
 * 'A' always), on its own table and function. 'D' is disabled; 'R' fires only
 * under session_replication_role = replica, which means NOT in a normal session.
 */
export function triggerFindings(rows: TriggerRow[], expected: Record<string, { table: string; fn: string }>): TriggerFinding[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out: TriggerFinding[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const r = byName.get(name);
    if (!r) out.push({ name, kind: 'missing' });
    else if (r.enabled === 'D') out.push({ name, kind: 'disabled' });
    else if (r.enabled === 'R') out.push({ name, kind: 'replica-only' });
    else if (r.table !== want.table || r.fn !== want.fn) out.push({ name, kind: 'rebound' });
  }
  return out;
}

export type FunctionRow = { name: string; md5: string; securityDefiner: boolean; config: string[] | null };
export type FunctionFinding = { name: string; kind: 'missing' | 'body-changed' | 'rights-changed' | 'search-path-changed' };

export function functionFindings(
  rows: FunctionRow[],
  expected: Record<string, { md5: string; securityDefiner: boolean; searchPath: string }>
): FunctionFinding[] {
  const out: FunctionFinding[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const versions = rows.filter((r) => r.name === name);
    if (versions.length === 0) {
      out.push({ name, kind: 'missing' });
      continue;
    }
    // An overload with the same name would be a second function: every version must match.
    for (const r of versions) {
      if (r.md5 !== want.md5) out.push({ name, kind: 'body-changed' });
      else if (r.securityDefiner !== want.securityDefiner) out.push({ name, kind: 'rights-changed' });
      else if (!(r.config ?? []).includes(`search_path=${want.searchPath}`)) out.push({ name, kind: 'search-path-changed' });
    }
  }
  return out;
}

// ── 15. test-flags-changed ─────────────────────────────────────────────────

/** Per table, the SHA-256 of the sorted ids of its flagged rows, and which tables changed since `previous`. */
export function testFlagChanges(current: Record<string, string[]>, previous: Record<string, string> | null) {
  const hashes: Record<string, string> = {};
  for (const [t, ids] of Object.entries(current)) {
    hashes[t] = createHash('sha256').update([...ids].sort().join('\n'), 'utf8').digest('hex');
  }
  const changed = previous ? Object.keys(hashes).filter((t) => previous[t] !== hashes[t]) : [];
  return { hashes, changed, firstRun: previous === null };
}

// ── The day's alert ────────────────────────────────────────────────────────

/** The in-app alert's words: check titles and counts only — never an id, a name or a value. */
export function alertText(failures: Array<{ title: string; count: number | null }>): { title: string; body: string } {
  const n = failures.length;
  const shown = failures.slice(0, ALERT_BODY_CHECKS).map((f) => (f.count === null ? f.title : `${f.title}: ${f.count}`));
  const more = n > ALERT_BODY_CHECKS ? ` +${n - ALERT_BODY_CHECKS} more` : '';
  return {
    title: `Nightly data check: ${n} problem${n === 1 ? '' : 's'}`,
    body: `${shown.join('; ')}${more}. Open Service status, Integrity, for what each means and what to do.`,
  };
}
