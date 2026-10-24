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
 *      the chain and the last seals' copies (lib/seal/verify.ts), reported as
 *      seal-written, seal-chain-intact and seal-offsite-copies;
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
import { createHash } from 'node:crypto';
import { NotificationKind, Prisma, Role, type PrismaClient } from '@prisma/client';
import { omanDayStart, src, withChangeContext } from '../change-context';
import { notifyUsers } from '../notifications';
import { sendAlert } from '@/lib/alert';
import { omanDateISO } from '../tz';
import { writeSeal, type SealOutcome } from '../seal/seal';
import { recheckSeals } from '../seal/verify';
import { ensureOffsite, type SealStore } from '../seal/store';
import { offsiteRetryable, type Mismatch } from '../seal/chain';
import { CHECKS, CHECK_BY_ID, CRITICAL_CHECKS, type CheckContext, type PreviousResult } from './checks';
import { alertText, capSamples, checkStatus, type CheckStatus } from './classify';
import {
  CHECK_BUDGET_MS,
  CHECK_STATEMENT_TIMEOUT,
  CHECK_TX_TIMEOUT_MS,
  INTEGRITY_INAPP_ALERTS_ENABLED,
  RUN_DEADLINE_MS,
  SEAL_OFFSITE_RETRY_DAYS,
  SEAL_RECHECK_WINDOW,
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

/** The latest earlier result of every check. */
async function loadPrevious(db: Db): Promise<Map<string, PreviousResult>> {
  const rows = await db.$queryRaw<Array<{ checkId: string; runAt: Date; status: string; count: number | null; detail: Record<string, unknown> | null }>>(
    Prisma.sql`SELECT DISTINCT ON ("checkId") "checkId", "runAt", "status", "count", "detail"
                 FROM "IntegrityCheckResult" ORDER BY "checkId", "runAt" DESC`
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

/** A signature of a set of mismatches, so the same event is alerted once, not every night. */
function signature(ms: Mismatch[]): string {
  return createHash('sha256')
    .update(ms.map((m) => `${m.kind}:${m.seq}:${m.table ?? ''}`).sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

const CHAIN_KINDS = new Set(['body-edited', 'chain-broken', 'rows-deleted', 'rows-added', 'rows-changed']);

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

  // The chain and the copies.
  t0 = Date.now();
  try {
    const deadline = started + RUN_DEADLINE_MS;
    const recheck = await readOnly(
      db,
      (tx) =>
        recheckSeals(tx, {
          window: SEAL_RECHECK_WINDOW,
          offsite: deps.store,
          onStep: () => {
            if (Date.now() > deadline) throw new Error('the run’s deadline passed during the recheck');
          },
        }),
      Math.max(5_000, deadline - Date.now()),
      Prisma.TransactionIsolationLevel.RepeatableRead
    );
    const chain = recheck.mismatches.filter((m) => CHAIN_KINDS.has(m.kind));
    const sig = signature(chain);
    const prevChain = previous.get('seal-chain-intact');
    const known = chain.length > 0 && prevChain?.detail?.signature === sig;
    add({
      checkId: 'seal-chain-intact',
      version: 1,
      // Alerted once per event; the same mismatches the next night are information.
      status: chain.length === 0 ? 'pass' : known ? 'info' : 'fail',
      count: chain.length,
      sampleIds: chain.map((m) => `${m.seq}:${m.table ?? m.kind}`),
      detail: {
        seals: recheck.seals.length,
        window: recheck.windowSeqs,
        signature: chain.length ? sig : null,
        known,
        mismatches: chain.slice(0, 20).map((m) => ({ kind: m.kind, seq: m.seq, table: m.table ?? null })),
      },
      durationMs: Date.now() - t0,
    });

    // Copies: a missing one up to two days old is written again (a failed upload).
    t0 = Date.now();
    const copies = recheck.mismatches.filter((m) => m.kind === 'offsite-missing' || m.kind === 'offsite-differs');
    const failed: Mismatch[] = [];
    let rewritten = 0;
    for (const m of copies) {
      const s = recheck.seals.find((x) => x.seq === m.seq)!;
      if (m.kind === 'offsite-missing' && offsiteRetryable(s, now, SEAL_OFFSITE_RETRY_DAYS)) {
        try {
          await deps.store.put(s.r2Key, s.bodyText, s.hash);
          rewritten += 1;
          continue;
        } catch {
          r2Errors += 1;
        }
      }
      failed.push(m);
    }
    add({
      checkId: 'seal-offsite-copies',
      version: 1,
      status: failed.length > 0 ? 'fail' : rewritten > 0 ? 'info' : 'pass',
      count: failed.length,
      sampleIds: failed.map((m) => String(m.seq)),
      detail: { checked: recheck.windowSeqs.length, rewritten, missing: failed.filter((m) => m.kind === 'offsite-missing').length, differs: failed.filter((m) => m.kind === 'offsite-differs').length },
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const detail = { error: errorText(e) };
    // An R2 failure while reading the copies is an R2 error too.
    if (/R2|r2|S3|aborted|ECONN|ENOTFOUND|timeout/i.test(detail.error)) r2Errors += 1;
    add({ checkId: 'seal-chain-intact', version: 1, status: 'error', count: null, sampleIds: [], detail, durationMs: Date.now() - t0 });
    add({ checkId: 'seal-offsite-copies', version: 1, status: 'error', count: null, sampleIds: [], detail, durationMs: 0 });
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
    const critical = failing.some((r) => (CRITICAL_CHECKS as readonly string[]).includes(r.checkId));
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
