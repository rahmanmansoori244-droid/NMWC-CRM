/**
 * Gap 29 (data audit 2026-10-10): one nightly run of the integrity watch
 * (app/api/cron/integrity-watch).
 *
 *   1. every query check (lib/integrity/checks.ts), each in its own short
 *      read-only transaction with a statement timeout, one after the other
 *      inside a budget; a check that throws, or is not started in time, is
 *      'error' (and fails the run's heartbeat — a check that could not run is
 *      not a check that passed);
 *   2. the day's seal (lib/seal/seal.ts), its off-site copy, and the recheck of
 *      the chain — the last seals and a rotating slice of the older ones — and of
 *      the copies: the last seals' read back, the whole of seals/ listed
 *      (lib/seal/verify.ts), reported as seal-written, seal-chain-intact and
 *      seal-offsite-copies. A seal finding is alerted once, the night it is new;
 *      while it stays it is information (its signature is in the result's `open`
 *      list, and a range mismatch whose seal is not rechecked tonight is carried
 *      there, never dropped to a pass);
 *   3. one transaction: every result appended to IntegrityCheckResult and, when
 *      an alerting check failed and the in-app alert is switched on
 *      (lib/integrity/policy.ts), ONE INTEGRITY_ALERT per active, non-test Data
 *      Steward per Oman day, linking to /status/integrity;
 *   4. after the commit, the operators' webhook (lib/alert.ts) with counts
 *      only, critical when the record-keeping itself is in doubt.
 *
 * Nothing personal leaves: the results hold ids and counts, the alert check
 * titles and counts, the webhook counts.
 *
 * PURE of lib/db: the client, the R2 store and the clock are passed in, so the
 * gated integration suite runs it against fakes for R2 and a test audience.
 */
import { NotificationKind, Prisma, Role, type PrismaClient } from '@prisma/client';
import { omanDayStart, src, withChangeContext } from '../change-context';
import { notifyUsers } from '../notifications';
import { sendAlert } from '@/lib/alert';
import { omanDateISO } from '../tz';
import { writeSeal, type SealOutcome } from '../seal/seal';
import { recheckSeals } from '../seal/verify';
import { ensureOffsite, type SealStore } from '../seal/store';
import { SEAL_KEY_PREFIX, expectedSealKey, listingFindings, mismatchSignature, offsiteRetryable, type Mismatch } from '../seal/chain';
import { CHECKS, CHECK_BY_ID, CRITICAL_CHECKS, type CheckContext, type PreviousResult } from './checks';
import { alertText, capSamples, checkStatus, type CheckStatus } from './classify';
import {
  CHECK_BUDGET_MS,
  CHECK_STATEMENT_TIMEOUT,
  CHECK_TX_TIMEOUT_MS,
  INTEGRITY_INAPP_ALERTS_ENABLED,
  RUN_DEADLINE_MS,
  SEAL_FULL_RECHECK_NIGHTS,
  SEAL_OFFSITE_RETRY_DAYS,
  SEAL_OPEN_LIMIT,
  SEAL_RECHECK_WINDOW,
  SEAL_ROTATION_STOP_MS,
  SEAL_TX_TIMEOUT_MS,
} from './policy';

type Db = Pick<PrismaClient, '$transaction' | '$queryRaw'>;
type Tx = Prisma.TransactionClient;

export const JOB = 'integrity-watch';
const CAUSE = { actorId: null, source: src.cron(JOB) } as const;

export type CheckResultRow = {
  checkId: string;
  version: number;
  status: CheckStatus;
  count: number | null;
  sampleIds: string[];
  detail: Record<string, unknown> | null;
  durationMs: number;
};

export type WatchSummary = {
  checks: number;
  failing: number;
  info: number;
  errors: number;
  r2Errors: number;
  seal: 'genesis' | 'sealed' | 'already' | 'deferred' | 'error';
  sealSeq: number | null;
  alerted: number;
  results: CheckResultRow[];
};

export type WatchDeps = {
  /** The off-site store for the seals (lib/seal/store.ts r2SealStore in production). */
  store: SealStore;
  now?: Date;
  /** Who gets the in-app alert; integrityAlertAudience by default. */
  audience?: (tx: Tx) => Promise<string[]>;
  /** The webhook; lib/alert.ts sendAlert by default. */
  alert?: typeof sendAlert;
  /** The in-app alert switch; lib/integrity/policy.ts by default. */
  inAppAlerts?: boolean;
  /** The seal's horizon reader, for tests (lib/seal/seal.ts). */
  horizon?: Parameters<typeof writeSeal>[1]['horizon'];
};

/** The Data Stewards an integrity alert goes to: active, and not test accounts. */
export async function integrityAlertAudience(tx: Tx): Promise<string[]> {
  const rows = await tx.user.findMany({ where: { role: Role.STEWARD, isActive: true, isTest: false }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * The latest earlier result of every check that RAN: an 'error' result examined
 * nothing, so it never moves a "since the last run" window or a baseline (the
 * test flags, the code counters, the jobs' last checked day, the seals' open
 * findings and rotation). After an errored night the next run goes on from the
 * last good one.
 */
async function loadPrevious(db: Db): Promise<Map<string, PreviousResult>> {
  const rows = await db.$queryRaw<Array<{ checkId: string; runAt: Date; status: string; count: number | null; detail: Record<string, unknown> | null }>>(
    Prisma.sql`SELECT DISTINCT ON ("checkId") "checkId", "runAt", "status", "count", "detail"
                 FROM "IntegrityCheckResult" WHERE "status" IN ('pass', 'fail', 'info')
                ORDER BY "checkId", "runAt" DESC`
  );
  return new Map(rows.map((r) => [r.checkId, { runAt: r.runAt, status: r.status, count: r.count, detail: r.detail }]));
}

/** A read-only transaction with a statement timeout, under the job's cause. */
function readOnly<T>(db: Db, fn: (tx: Tx) => Promise<T>, timeoutMs: number, iso?: Prisma.TransactionIsolationLevel): Promise<T> {
  return withChangeContext(
    db,
    CAUSE,
    async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL transaction_read_only = on');
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${CHECK_STATEMENT_TIMEOUT}'`);
      return fn(tx);
    },
    { timeout: timeoutMs, maxWait: 10_000, ...(iso ? { isolationLevel: iso } : {}) }
  );
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 120);

const CHAIN_KINDS = new Set([
  'body-edited',
  'chain-broken',
  'rows-deleted',
  'rows-added',
  'rows-changed',
  'rows-deleted-before-seal',
  'rows-changed-before-seal',
]);
/** The mismatches found only when their seal's ranges are recomputed (the window or the rotation). */
const RANGE_KINDS = new Set(['rows-deleted', 'rows-added', 'rows-changed']);
/** An off-site finding that says one of the two copies was rewritten: critical. */
const OFFSITE_CRITICAL = new Set(['offsite-differs', 'offsite-unexpected', 'offsite-key-mismatch']);

/** One seal finding as a result remembers it: its signature and where it is (no row, no value). */
export type OpenFinding = { sig: string; kind: string; seq: number | null; table: string | null; totals: boolean };

export function openFinding(m: Pick<Mismatch, 'kind' | 'seq' | 'table' | 'totals' | 'delta' | 'key'>): OpenFinding {
  return { sig: mismatchSignature(m), kind: m.kind, seq: m.totals ? null : m.seq, table: m.table ?? null, totals: m.totals === true };
}

/** The open findings an earlier result recorded (its detail is data: read with care). */
export function openFindingsOf(detail: Record<string, unknown> | null | undefined): OpenFinding[] {
  const raw = detail?.open;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.sig !== 'string' || typeof o.kind !== 'string') return [];
    return [{ sig: o.sig, kind: o.kind, seq: typeof o.seq === 'number' ? o.seq : null, table: typeof o.table === 'string' ? o.table : null, totals: o.totals === true }];
  });
}

/**
 * Once per event: tonight's findings against the ones open at the last good run.
 * A finding not seen then is new (the check fails); one seen then is information.
 * An earlier finding not found tonight is carried (still open) when `carry` says
 * tonight could not have seen it; otherwise it is gone (resolved), and found
 * again later it is new again. `alreadyKnown` names a finding that is new in
 * form but not in substance (a deletion the totals already reported, found
 * again in its seal's range when the rotation reaches it).
 */
export function sealEvents(
  current: OpenFinding[],
  previousOpen: OpenFinding[],
  carry: (f: OpenFinding) => boolean,
  alreadyKnown: (f: OpenFinding) => boolean = () => false
) {
  const seen = new Set<string>();
  const now = current.filter((f) => (seen.has(f.sig) ? false : (seen.add(f.sig), true)));
  const carried = previousOpen.filter((f) => !seen.has(f.sig) && carry(f));
  const known = new Set(previousOpen.map((f) => f.sig));
  const fresh = now.filter((f) => !known.has(f.sig) && !alreadyKnown(f));
  const open = [...now, ...carried];
  const status: CheckStatus = open.length === 0 ? 'pass' : fresh.length > 0 ? 'fail' : 'info';
  return { open, fresh, carried, status };
}

const findingSample = (f: OpenFinding) => `${f.totals ? 'totals' : (f.seq ?? '-')}:${f.table ?? f.kind}`;

export async function runIntegrityWatch(db: Db, deps: WatchDeps): Promise<WatchSummary> {
  const now = deps.now ?? new Date();
  const started = Date.now();
  const runAt = now;
  const day = omanDateISO(now);
  const previous = await loadPrevious(db);
  const ctx: CheckContext = { now, previous };
  const results: CheckResultRow[] = [];
  const add = (r: CheckResultRow) => results.push({ ...r, sampleIds: capSamples(r.sampleIds) });

  // ── 1. the query checks ──
  for (const check of CHECKS) {
    if (!check.run) continue;
    const t0 = Date.now();
    if (t0 - started > CHECK_BUDGET_MS) {
      add({ checkId: check.id, version: check.version, status: 'error', count: null, sampleIds: [], detail: { error: 'not started: the run’s check budget was spent' }, durationMs: 0 });
      continue;
    }
    try {
      const out = await readOnly(db, (tx) => check.run!(tx, ctx), CHECK_TX_TIMEOUT_MS);
      add({
        checkId: check.id,
        version: check.version,
        status: checkStatus(check.policy, out.count, out.status),
        count: out.count,
        sampleIds: out.sampleIds,
        detail: out.detail ?? null,
        durationMs: Date.now() - t0,
      });
    } catch (e) {
      add({ checkId: check.id, version: check.version, status: 'error', count: null, sampleIds: [], detail: { error: errorText(e) }, durationMs: Date.now() - t0 });
    }
  }

  // ── 2. the seal ──
  let r2Errors = 0;
  let seal: WatchSummary['seal'] = 'error';
  let sealSeq: number | null = null;
  let t0 = Date.now();
  let outcome: SealOutcome | null = null;
  try {
    outcome = await writeSeal(db, { now, job: JOB, timeoutMs: SEAL_TX_TIMEOUT_MS, horizon: deps.horizon });
    seal = outcome.status;
    if (outcome.status === 'deferred') {
      sealSeq = outcome.lastSeq;
      add({ checkId: 'seal-written', version: 1, status: 'fail', count: 1, sampleIds: [], detail: { result: 'deferred', reason: outcome.reason }, durationMs: Date.now() - t0 });
    } else {
      sealSeq = outcome.seal.seq;
      let offsite: string = 'not written';
      try {
        offsite = await ensureOffsite(deps.store, outcome.seal);
      } catch (e) {
        r2Errors += 1;
        offsite = `error: ${errorText(e)}`;
      }
      add({
        checkId: 'seal-written',
        version: 1,
        status: outcome.status === 'genesis' ? 'info' : 'pass',
        count: 0,
        sampleIds: [String(outcome.seal.seq)],
        detail: { result: outcome.status, seq: outcome.seal.seq, hash: outcome.seal.hash.slice(0, 16), offsite },
        durationMs: Date.now() - t0,
      });
    }
  } catch (e) {
    add({ checkId: 'seal-written', version: 1, status: 'error', count: null, sampleIds: [], detail: { error: errorText(e) }, durationMs: Date.now() - t0 });
  }

  // The chain, from the database alone (no R2 call inside a transaction): the
  // last seals' ranges, then a rotating slice of the older ones, continuing from
  // where the last good run stopped.
  t0 = Date.now();
  const deadline = started + RUN_DEADLINE_MS;
  const prevChain = previous.get('seal-chain-intact');
  const cursor = typeof prevChain?.detail?.rotationCursor === 'number' ? (prevChain.detail.rotationCursor as number) : null;
  let recheck: Awaited<ReturnType<typeof recheckSeals>> | null = null;
  try {
    recheck = await readOnly(
      db,
      (tx) =>
        recheckSeals(tx, {
          window: SEAL_RECHECK_WINDOW,
          offsite: null,
          onStep: () => {
            if (Date.now() > deadline) throw new Error('the run’s deadline passed during the recheck');
          },
          rotation: { cursor, nights: SEAL_FULL_RECHECK_NIGHTS, stop: () => Date.now() > started + SEAL_ROTATION_STOP_MS },
        }),
      Math.max(5_000, deadline - Date.now()),
      Prisma.TransactionIsolationLevel.RepeatableRead
    );
    const chain = recheck.mismatches.filter((m) => CHAIN_KINDS.has(m.kind));
    // A range mismatch is found only when its seal is recomputed: carried while it is not.
    const rechecked = new Set([...recheck.windowSeqs, ...recheck.rotatedSeqs]);
    const prevOpen = openFindingsOf(prevChain?.detail);
    // Rows deleted (or slipped in) are reported by the totals the next night; when the
    // rotation later finds them in their seal's range, that is the same event, not a new
    // one. Another deletion changes the totals' count, and so is new there.
    const totalsOpen = new Set(prevOpen.filter((f) => f.totals).map((f) => `${f.kind}|${f.table}`));
    const ev = sealEvents(
      chain.map(openFinding),
      prevOpen,
      (f) => RANGE_KINDS.has(f.kind) && !f.totals && f.seq !== null && !rechecked.has(f.seq),
      (f) => !f.totals && (f.kind === 'rows-deleted' || f.kind === 'rows-added') && totalsOpen.has(`${f.kind}|${f.table}`)
    );
    add({
      checkId: 'seal-chain-intact',
      version: 1,
      // Alerted once per event; the same mismatches the next night are information.
      status: ev.status,
      count: ev.open.length,
      sampleIds: ev.open.map(findingSample),
      detail: {
        seals: recheck.seals.length,
        window: recheck.windowSeqs,
        rotated: recheck.rotatedSeqs,
        rotationCursor: recheck.rotationCursor,
        olderSeals: recheck.olderSeals,
        new: ev.fresh.length,
        carried: ev.carried.length,
        open: ev.open.slice(0, SEAL_OPEN_LIMIT),
        mismatches: chain.slice(0, 20).map((m) => ({ kind: m.kind, seq: m.seq, table: m.table ?? null })),
      },
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    add({ checkId: 'seal-chain-intact', version: 1, status: 'error', count: null, sampleIds: [], detail: { error: errorText(e) }, durationMs: Date.now() - t0 });
  }

  // The copies: the last seals' read back from R2 one by one, at the key the
  // chain gives each (never the key a seal row names). A missing one up to two
  // days old is written again (a failed upload): information. Older and missing,
  // or different: a finding. Then the whole of seals/ is listed: every older
  // seal's copy must be there, and nothing else — a copy for a seq after the last
  // seal, in another chain's folder, or a seal row naming another key is a sign
  // that the database's seals were rewritten (critical when new). An R2 call that
  // fails is an R2 error.
  t0 = Date.now();
  if (!recheck) {
    add({ checkId: 'seal-offsite-copies', version: 1, status: 'error', count: null, sampleIds: [], detail: { error: 'the seals could not be read' }, durationMs: 0 });
  } else {
    const found: Mismatch[] = [];
    let rewritten = 0;
    let unread = 0;
    for (const seq of recheck.windowSeqs) {
      const sealRow = recheck.seals.find((x) => x.seq === seq);
      if (!sealRow) continue;
      if (Date.now() > deadline) {
        unread += 1;
        continue;
      }
      const key = expectedSealKey(recheck.seals, sealRow);
      let copy: string | null;
      try {
        copy = await deps.store.get(key);
      } catch {
        r2Errors += 1;
        unread += 1;
        continue;
      }
      if (copy === sealRow.bodyText) continue;
      if (copy === null && offsiteRetryable(sealRow, now, SEAL_OFFSITE_RETRY_DAYS)) {
        try {
          await deps.store.put(key, sealRow.bodyText, sealRow.hash);
          rewritten += 1;
          continue;
        } catch {
          r2Errors += 1;
        }
      }
      found.push({ kind: copy === null ? 'offsite-missing' : 'offsite-differs', seq, day: sealRow.day, key });
    }
    let objects: number | null = null;
    if (Date.now() <= deadline) {
      try {
        const keys = await deps.store.list(SEAL_KEY_PREFIX);
        objects = keys.length;
        for (const f of listingFindings(recheck.seals, keys, new Set(recheck.windowSeqs))) {
          found.push({ kind: f.kind, seq: f.seq ?? -1, day: '-', key: f.key });
        }
      } catch {
        r2Errors += 1;
      }
    }
    const listed = objects !== null;
    const prevCopies = previous.get('seal-offsite-copies');
    // Every copy is read or listed every night: nothing is carried.
    const ev = sealEvents(found.map(openFinding), openFindingsOf(prevCopies?.detail), () => false);
    const kinds = (k: string) => found.filter((m) => m.kind === k).length;
    add({
      checkId: 'seal-offsite-copies',
      version: 1,
      status: ev.fresh.length > 0 ? 'fail' : unread > 0 || !listed ? 'error' : ev.open.length > 0 || rewritten > 0 ? 'info' : 'pass',
      count: (unread > 0 || !listed) && ev.open.length === 0 ? null : ev.open.length,
      sampleIds: ev.open.map((f) => (f.seq !== null && f.seq >= 0 ? String(f.seq) : f.kind)),
      detail: {
        checked: recheck.windowSeqs.length - unread,
        unread,
        rewritten,
        listed,
        objects,
        missing: kinds('offsite-missing'),
        differs: kinds('offsite-differs'),
        unexpected: kinds('offsite-unexpected'),
        keyMismatch: kinds('offsite-key-mismatch'),
        new: ev.fresh.length,
        open: ev.open.slice(0, SEAL_OPEN_LIMIT),
        // A new sign that a copy or the seal table was rewritten is critical (run.ts step 4).
        critical: ev.fresh.some((f) => OFFSITE_CRITICAL.has(f.kind)),
      },
      durationMs: Date.now() - t0,
    });
  }

  // ── 3. the results, and the Steward's alert ──
  const failing = results.filter((r) => r.status === 'fail' && CHECK_BY_ID.get(r.checkId)?.policy === 'alert');
  const inApp = deps.inAppAlerts ?? INTEGRITY_INAPP_ALERTS_ENABLED;
  const alerted = await withChangeContext(
    db,
    CAUSE,
    async (tx) => {
      await tx.integrityCheckResult.createMany({
        data: results.map((r) => ({
          runAt,
          day: new Date(`${day}T00:00:00.000Z`),
          checkId: r.checkId,
          version: r.version,
          status: r.status,
          count: r.count,
          sampleIds: r.sampleIds,
          detail: (r.detail ?? undefined) as Prisma.InputJsonValue | undefined,
          durationMs: Math.min(Math.max(0, Math.round(r.durationMs)), 2_147_483_647),
        })),
      });
      if (!inApp || failing.length === 0) return 0;
      const { title, body } = alertText(failing.map((r) => ({ title: CHECK_BY_ID.get(r.checkId)!.title, count: r.count })));
      const dayStart = omanDayStart(day)!;
      const audience = await (deps.audience ?? integrityAlertAudience)(tx);
      let n = 0;
      for (const userId of audience) {
        // One a day per Steward, whatever runs overlap.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nmwc:integrity-alert:${userId}`}, 42))`;
        const already = await tx.notification.findFirst({
          where: { userId, kind: NotificationKind.INTEGRITY_ALERT, createdAt: { gte: dayStart } },
          select: { id: true },
        });
        if (already) continue;
        await notifyUsers(tx, [userId], { kind: NotificationKind.INTEGRITY_ALERT, title, body });
        n += 1;
      }
      return n;
    },
    { timeout: 20_000, maxWait: 10_000 }
  );

  // ── 4. the operators' webhook, counts only ──
  const errors = results.filter((r) => r.status === 'error').length;
  if (failing.length > 0) {
    // The record-keeping itself in doubt: the seal chain, the protection, or a new sign
    // that an off-site copy or the seal table was rewritten (seal-offsite-copies).
    const critical = failing.some((r) => (CRITICAL_CHECKS as readonly string[]).includes(r.checkId) || r.detail?.critical === true);
    const input: Parameters<typeof sendAlert>[0] = {
      severity: critical ? 'critical' : 'warn',
      event: 'integrity.failed',
      message: 'The nightly integrity check found problems. Open Service status, Integrity.',
      counts: { failing: failing.length, errors },
    };
    // Awaited: Vercel does not promise to finish work after the response, and
    // sendAlert cannot throw (lib/alert.ts).
    if (deps.alert) await deps.alert(input);
    else await sendAlert(input);
  }

  return {
    checks: results.length,
    failing: failing.length,
    info: results.filter((r) => r.status === 'info').length,
    errors,
    r2Errors,
    seal,
    sealSeq,
    alerted,
    results,
  };
}
