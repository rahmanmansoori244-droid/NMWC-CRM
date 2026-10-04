/**
 * B5 (enterprise assessment, 2026-09-14): dead-man heartbeats for scheduled jobs.
 *
 * The SLA escalation sweep, the keep-warm ping and the photo GC are driven by
 * external schedulers (GitHub Actions cron on the default branch, one Vercel
 * daily cron). GitHub's scheduler is best-effort — it delivered 2–4 runs a day
 * of a job configured for ~180 — and nothing noticed. Every cron route now
 * records a heartbeat when it finishes (success OR failure), and the bearer
 * /api/health probe turns those rows into a state per job so an external
 * monitor can alarm on "stale" or "never ran".
 *
 * Expectations are the SCHEDULES, not the code: change the cron, change these.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { logger } from './logger';
import { scrubAndTruncate } from './scrub';
import { sendAlert } from './alert';

export type HeartbeatKey =
  | 'sla-escalate'
  | 'keep-warm'
  | 'photo-gc'
  | 'db-backup'
  | 'retention-sweep'
  | 'email-drain';

/**
 * Item 11 (re-benchmark, 2026-09-24): "health goes red for minor things".
 *
 * Every alarm used to turn the whole bearer probe 503, so the monitor paged for a
 * keep-warm ping that failed once — a cold start costs a salesman two seconds —
 * exactly as loudly as for the SLA sweep being dead or a night without a backup.
 * A monitor that pages for both gets muted, and then it pages for neither.
 *
 *   critical — a business process or the data's safety stops: the probe answers
 *              503 and a failed run alerts as `critical`.
 *   warning  — a courtesy or housekeeping job: still reported (the probe's
 *              `warnings`, smoke's `warn=[…]`), and a failed run alerts as
 *              `warn`, but the probe stays 200. lib/health.ts draws the line.
 */
export type HeartbeatSeverity = 'critical' | 'warning';

export type HeartbeatExpectation = {
  label: string;
  severity: HeartbeatSeverity;
  /** Scheduled interval in minutes. */
  everyMinutes: number;
  /** UTC hour window [start, end) during which the job is expected to run. */
  activeHoursUtc?: [number, number];
  /**
   * Override the staleness allowance (default: everyMinutes × STALE_AFTER_INTERVALS).
   * A daily job whose absence matters the same day — the backup — cannot wait
   * three days to alarm.
   */
  staleAfterMinutes?: number;
};

export const HEARTBEAT_EXPECTATIONS: Record<HeartbeatKey, HeartbeatExpectation> = {
  // vercel.json crons (Pro, 2026-09-27) + backups: '15,45 3-14 * * *'
  // Approvals that stall are never escalated: critical.
  'sla-escalate': { label: 'SLA escalation sweep', severity: 'critical', everyMinutes: 30, activeHoursUtc: [3, 15] },
  // vercel.json crons (Pro, 2026-09-27) + backups: '*/4 3-14 * * *'
  // Only speed: a missed ping costs the next user one cold start.
  'keep-warm': { label: 'Keep-warm ping', severity: 'warning', everyMinutes: 4, activeHoursUtc: [3, 15] },
  // vercel.json crons: daily. Housekeeping: a missed night keeps orphaned uploads a day longer.
  'photo-gc': { label: 'Photo garbage collection', severity: 'warning', everyMinutes: 24 * 60 },
  // vercel.json crons: daily. B6 — enforces docs/compliance/DATA-RETENTION-SCHEDULE.md.
  // Its periods are counted in days and the next run catches up: warning.
  'retention-sweep': { label: 'Personal-data retention sweep', severity: 'warning', everyMinutes: 24 * 60 },
  // vercel.json crons: '*/10 3-14 * * *' (F1, 2026-10-05). The in-app rows are
  // the notification; the e-mail is a courtesy copy that a missed run delays, not
  // loses (the next run sends it inside the 24-hour maximum age): warning. A run
  // with e-mail switched off is a healthy run, so this alarms on the schedule.
  'email-drain': { label: 'Notification e-mail drain', severity: 'warning', everyMinutes: 10, activeHoursUtc: [3, 15] },
  // .github/workflows/db-backup.yml: '0 2 * * *' — reported by the workflow
  // itself (POST /api/ops/backup-report), not by a route in this app. B3: a
  // rotated database password or an expired R2 token used to break the nightly
  // dump silently.
  //
  // The allowance is 40 h rather than the 24 h the schedule implies, because
  // GitHub delivers this cron late and unevenly. Measured over 127 scheduled
  // runs: only 12 started in hour 02 UTC, 44 started in hour 06, 64 of the 126
  // gaps between consecutive dumps exceeded 24 h, and the worst was 33.2 h. A
  // tighter threshold would page someone most weeks and be ignored inside a
  // month; 40 h still catches a genuinely missed night.
  //
  // The only copy of the data outside Neon: critical.
  'db-backup': {
    label: 'Nightly off-Neon database dump',
    severity: 'critical',
    everyMinutes: 24 * 60,
    staleAfterMinutes: 40 * 60,
  },
};

/** A job is "stale" once this many scheduled intervals have passed without a run. */
export const STALE_AFTER_INTERVALS = 3;

export type HeartbeatRow = {
  key: string;
  lastRunAt: Date;
  lastOk: boolean;
  lastError: string | null;
  runs: number;
  failures: number;
};

export type HeartbeatState = 'ok' | 'failed' | 'stale' | 'never' | 'outside-window';

export type HeartbeatReport = {
  key: HeartbeatKey;
  label: string;
  state: HeartbeatState;
  /** True when the job is not running as its schedule says (never / failed / stale). */
  alarm: boolean;
  /** Whether an alarm on this job pages (critical) or is only reported (warning). */
  severity: HeartbeatSeverity;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  ageMinutes: number | null;
  expectedEveryMinutes: number;
  runs: number;
  failures: number;
};

/**
 * Tell a human that a scheduled job just failed.
 *
 * The error text is deliberately NOT sent. `recordHeartbeat` scrubs it before
 * storing because a Prisma constraint message quotes the colliding value — a
 * phone number or a CR number — and even scrubbed it is served only to a
 * HEALTH_BEARER holder. A webhook is a third party, so the text stays behind
 * authentication and the alert carries the job's label and nothing else, which is
 * enough to know what to open.
 */
async function alertJobFailed(key: HeartbeatKey): Promise<void> {
  await sendAlert({
    // Item 11: a failed keep-warm ping is not a 3am page.
    severity: HEARTBEAT_EXPECTATIONS[key].severity === 'critical' ? 'critical' : 'warn',
    event: 'cron.failed',
    // Per job: one bucket shared across jobs would let a dead photo-GC silence
    // the SLA sweep's outage an hour later, which is worse than no limiter.
    scope: key,
    message: `${HEARTBEAT_EXPECTATIONS[key].label} reported a FAILED run. Check /api/health with the monitor bearer.`,
  });
}

/**
 * Record the outcome of a cron run. Never throws — a heartbeat failure must not
 * fail the job.
 *
 * GAP-2 (2026-09-24) — why the outbound alert hangs off THIS function, and not
 * off /api/health.
 *
 * The obvious place was the health route: it already computes an `allOk` across
 * the database, R2 and every heartbeat. It is the wrong place twice over. It is
 * PULLED, so an owner who has not configured a monitor yet would get a route that
 * alerts beautifully and is never called — the same silence GAP-2 is about. And
 * where a monitor IS configured it already alerts on a non-200 (OPERATIONS.md
 * §5d), so an alert from inside would only double it. Worse, `scripts/ops/smoke.ts`
 * calls /api/health with the monitor bearer and CLAUDE.md requires `npm run smoke`
 * before and after every production change — so alerting there would page the
 * owner for running a smoke test.
 *
 * This function is the opposite on every count: PUSHED, reached on the failing run
 * itself, and the single point every scheduled outcome in the system already flows
 * through — the four `withHeartbeat` routes AND the nightly dump, which reports
 * itself from GitHub Actions through /api/ops/backup-report and so never passes
 * through the wrapper. Wiring the wrapper instead would have left the backup, the
 * one job whose silence costs the most, still unable to reach anybody.
 *
 * The alert sits OUTSIDE the try below, deliberately: when the database is what
 * failed, the upsert throws, is swallowed, and the alert is then the only thing
 * that gets out at all.
 */
export async function recordHeartbeat(
  key: HeartbeatKey,
  result: {
    ok: boolean;
    durationMs: number;
    error?: string;
    detail?: Record<string, unknown>;
    /** When the run began. Defaults to now minus durationMs. */
    startedAt?: Date;
    source?: RunSource;
    /** Keep-warm's database round trip on its own. */
    dbMs?: number;
  }
): Promise<void> {
  const now = new Date();
  // B6: a cron error can embed a phone number or an e-mail (a Prisma constraint
  // message quotes the colliding value), and this row is served verbatim to any
  // HEALTH_BEARER holder. Scrub BEFORE truncating — the other order can cut a
  // number in half and defeat the pattern.
  const lastError = result.error ? scrubAndTruncate(result.error, 500) : null;
  try {
    await prisma.cronHeartbeat.upsert({
      where: { key },
      create: {
        key,
        lastRunAt: now,
        lastOk: result.ok,
        lastDurationMs: result.durationMs,
        lastError,
        lastDetail: (result.detail as Prisma.InputJsonValue | undefined) ?? undefined,
        runs: 1,
        failures: result.ok ? 0 : 1,
      },
      update: {
        lastRunAt: now,
        lastOk: result.ok,
        lastDurationMs: result.durationMs,
        lastError,
        lastDetail: (result.detail as Prisma.InputJsonValue | undefined) ?? undefined,
        runs: { increment: 1 },
        ...(result.ok ? {} : { failures: { increment: 1 } }),
      },
    });
  } catch (err) {
    logger.warn({ key, err: (err as Error).message }, 'heartbeat.record_failed');
  }
  // Item 9: the run's history row, in a try of its own. The heartbeat above is
  // what the monitor alarms on and must never be lost to this write failing — a
  // preview database without the table, say. No error text and no detail here:
  // both can quote a customer's phone, and this table keeps 90 days of rows.
  try {
    await prisma.cronRun.create({
      data: {
        key,
        at: result.startedAt ?? new Date(now.getTime() - Math.max(0, result.durationMs)),
        ok: result.ok,
        durationMs: toInt4(result.durationMs),
        dbMs: result.dbMs === undefined ? null : toInt4(result.dbMs),
        source: result.source ?? null,
      },
    });
  } catch (err) {
    logger.warn({ key, err: (err as Error).message }, 'heartbeat.run_record_failed');
  }
  if (!result.ok) await alertJobFailed(key);
}

/** A Postgres INTEGER, whatever a caller reports: a reported duration is not trusted to fit. */
function toInt4(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), 2_147_483_647);
}

/** Which scheduler called a cron route — never the raw User-Agent, which is not ours to keep. */
export type RunSource = 'vercel' | 'cron-job.org' | 'github' | 'other';

export function classifyRunSource(userAgent: string | null | undefined): RunSource {
  const ua = userAgent ?? '';
  if (/vercel-cron/i.test(ua)) return 'vercel';
  if (/cron-job\.org/i.test(ua)) return 'cron-job.org';
  // The GitHub workflows call with curl.
  if (/^curl\//i.test(ua) || /github/i.test(ua)) return 'github';
  return 'other';
}

function inWindow(now: Date, window?: [number, number]): boolean {
  if (!window) return true;
  const h = now.getUTCHours();
  return h >= window[0] && h < window[1];
}

/**
 * How old the last run may be right now before the job counts as silent.
 *
 * A windowed job is not expected to run between its window's close and the
 * next open, so at 03:15 UTC the freshest possible run is still yesterday's
 * last one. The allowance therefore always starts from the moment the job
 * last had an opportunity to run:
 *
 *   inside the window, past the opening grace  → staleAfter
 *   inside the window, during the opening grace → idle gap + minutes since open + staleAfter
 *   outside the window                          → minutes since the last close + staleAfter
 *
 * Both branches are anchored on the previous close, so a job that died days
 * ago is stale at 03:15 (the old "grace" ignored the age entirely) and a job
 * that died mid-morning stays stale after 15:00 (the old outside-window rule
 * reset the alarm at every close and only re-armed after 24 h).
 */
function allowedAgeMinutes(now: Date, exp: HeartbeatExpectation): number {
  const staleAfter = exp.staleAfterMinutes ?? exp.everyMinutes * STALE_AFTER_INTERVALS;
  const window = exp.activeHoursUtc;
  if (!window) return staleAfter;
  const [openHour, closeHour] = window;
  const open = new Date(now);
  open.setUTCHours(openHour, 0, 0, 0);
  const close = new Date(now);
  close.setUTCHours(closeHour, 0, 0, 0);
  const windowMinutes = (closeHour - openHour) * 60;
  const idleGap = 24 * 60 - windowMinutes;
  if (inWindow(now, window)) {
    const sinceOpen = (now.getTime() - open.getTime()) / 60_000;
    return sinceOpen < staleAfter ? idleGap + sinceOpen + staleAfter : staleAfter;
  }
  // Outside the window: the most recent close is today's if it has passed, else yesterday's.
  const lastClose = now.getTime() >= close.getTime() ? close : new Date(close.getTime() - 24 * 60 * 60_000);
  const sinceClose = (now.getTime() - lastClose.getTime()) / 60_000;
  return sinceClose + staleAfter;
}

/**
 * Pure: turn the stored rows into a per-job report.
 *
 *   never          — no run recorded at all (alarm)
 *   failed         — last run reported failure (alarm)
 *   stale          — the last run is older than allowedAgeMinutes() (alarm)
 *   outside-window — the job is not expected right now and its last run is
 *                    as recent as the schedule allows (no alarm)
 *   ok             — otherwise
 */
export function heartbeatReport(rows: HeartbeatRow[], now: Date = new Date()): HeartbeatReport[] {
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  return (Object.keys(HEARTBEAT_EXPECTATIONS) as HeartbeatKey[]).map((key) => {
    const exp = HEARTBEAT_EXPECTATIONS[key];
    const row = byKey.get(key);
    const base = {
      key,
      label: exp.label,
      severity: exp.severity,
      expectedEveryMinutes: exp.everyMinutes,
      lastRunAt: row ? row.lastRunAt.toISOString() : null,
      lastOk: row ? row.lastOk : null,
      lastError: row?.lastError ?? null,
      runs: row?.runs ?? 0,
      failures: row?.failures ?? 0,
    };
    if (!row) return { ...base, state: 'never', alarm: true, ageMinutes: null };
    const ageMinutes = (now.getTime() - row.lastRunAt.getTime()) / 60_000;
    if (!row.lastOk) return { ...base, state: 'failed', alarm: true, ageMinutes };
    if (ageMinutes > allowedAgeMinutes(now, exp)) return { ...base, state: 'stale', alarm: true, ageMinutes };
    if (!inWindow(now, exp.activeHoursUtc)) return { ...base, state: 'outside-window', alarm: false, ageMinutes };
    return { ...base, state: 'ok', alarm: false, ageMinutes };
  });
}

/** Load the rows and build the report. */
export async function loadHeartbeatReport(now: Date = new Date()): Promise<HeartbeatReport[]> {
  const rows = await prisma.cronHeartbeat.findMany();
  return heartbeatReport(rows, now);
}

type RouteHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Wrap a cron route handler so every finished run is recorded. A 401 (bad or
 * missing bearer) is not a run and records nothing. A thrown error records a
 * failed run and becomes a 500. `okFrom` inspects the JSON body to decide
 * whether a completed run counts as healthy (e.g. zero sweep errors).
 *
 * A run recorded as not-ok also raises an outbound alert — see `recordHeartbeat`,
 * which is where that hangs so the nightly dump (which never passes through this
 * wrapper) is covered by the same code.
 */
export function withHeartbeat(
  key: HeartbeatKey,
  handler: RouteHandler,
  okFrom: (body: Record<string, unknown> | null, status: number) => boolean = (_b, status) =>
    status < 500
): RouteHandler {
  return async (req) => {
    const started = Date.now();
    const startedAt = new Date(started);
    const source = classifyRunSource(req.headers.get('user-agent'));
    try {
      const res = await handler(req);
      if (res.status === 401) return res;
      let body: Record<string, unknown> | null = null;
      try {
        body = (await res.clone().json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      await recordHeartbeat(key, {
        ok: okFrom(body, res.status),
        durationMs: Date.now() - started,
        detail: body ?? undefined,
        startedAt,
        source,
        dbMs: typeof body?.dbMs === 'number' ? body.dbMs : undefined,
      });
      return res;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      logger.error({ key, err: message }, 'cron.run_failed');
      await recordHeartbeat(key, {
        ok: false,
        durationMs: Date.now() - started,
        error: message,
        startedAt,
        source,
      });
      return NextResponse.json({ error: 'CRON_FAILED', key }, { status: 500 });
    }
  };
}
