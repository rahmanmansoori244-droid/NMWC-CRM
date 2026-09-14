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

export type HeartbeatKey = 'sla-escalate' | 'keep-warm' | 'photo-gc';

export type HeartbeatExpectation = {
  label: string;
  /** Scheduled interval in minutes. */
  everyMinutes: number;
  /** UTC hour window [start, end) during which the job is expected to run. */
  activeHoursUtc?: [number, number];
};

export const HEARTBEAT_EXPECTATIONS: Record<HeartbeatKey, HeartbeatExpectation> = {
  // .github/workflows/sla-escalate.yml: '15,45 3-14 * * *'
  'sla-escalate': { label: 'SLA escalation sweep', everyMinutes: 30, activeHoursUtc: [3, 15] },
  // .github/workflows/keep-warm.yml: '*/4 3-14 * * *'
  'keep-warm': { label: 'Keep-warm ping', everyMinutes: 4, activeHoursUtc: [3, 15] },
  // vercel.json crons: daily
  'photo-gc': { label: 'Photo garbage collection', everyMinutes: 24 * 60 },
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
  /** True when this state should page someone. */
  alarm: boolean;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  ageMinutes: number | null;
  expectedEveryMinutes: number;
  runs: number;
  failures: number;
};

/** Record the outcome of a cron run. Never throws — a heartbeat failure must not fail the job. */
export async function recordHeartbeat(
  key: HeartbeatKey,
  result: { ok: boolean; durationMs: number; error?: string; detail?: Record<string, unknown> }
): Promise<void> {
  const now = new Date();
  const lastError = result.error ? result.error.slice(0, 500) : null;
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
}

function inWindow(now: Date, window?: [number, number]): boolean {
  if (!window) return true;
  const h = now.getUTCHours();
  return h >= window[0] && h < window[1];
}

/** Minutes elapsed since the start of today's active window (0 when there is no window). */
function minutesIntoWindow(now: Date, window?: [number, number]): number {
  if (!window) return Number.POSITIVE_INFINITY;
  const start = new Date(now);
  start.setUTCHours(window[0], 0, 0, 0);
  return Math.max(0, (now.getTime() - start.getTime()) / 60_000);
}

/**
 * Pure: turn the stored rows into a per-job report.
 *
 *   never          — no run recorded at all (alarm)
 *   failed         — last run reported failure (alarm)
 *   stale          — inside the active window and no run for > STALE_AFTER_INTERVALS × interval,
 *                    with a grace period of the same length at the start of the window (alarm)
 *   outside-window — the job is not expected right now and last ran within a day (no alarm)
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
      expectedEveryMinutes: exp.everyMinutes,
      lastRunAt: row ? row.lastRunAt.toISOString() : null,
      lastOk: row ? row.lastOk : null,
      lastError: row?.lastError ?? null,
      runs: row?.runs ?? 0,
      failures: row?.failures ?? 0,
    };
    if (!row) return { ...base, state: 'never', alarm: true, ageMinutes: null };
    const ageMinutes = (now.getTime() - row.lastRunAt.getTime()) / 60_000;
    const staleAfter = exp.everyMinutes * STALE_AFTER_INTERVALS;
    if (!row.lastOk) return { ...base, state: 'failed', alarm: true, ageMinutes };
    if (!inWindow(now, exp.activeHoursUtc)) {
      // Not expected right now; alarm only if it has not run for a full day.
      const state: HeartbeatState = ageMinutes > 24 * 60 + staleAfter ? 'stale' : 'outside-window';
      return { ...base, state, alarm: state === 'stale', ageMinutes };
    }
    const graceLeft = minutesIntoWindow(now, exp.activeHoursUtc) < staleAfter;
    if (ageMinutes > staleAfter && !graceLeft) {
      return { ...base, state: 'stale', alarm: true, ageMinutes };
    }
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
 */
export function withHeartbeat(
  key: HeartbeatKey,
  handler: RouteHandler,
  okFrom: (body: Record<string, unknown> | null, status: number) => boolean = (_b, status) =>
    status < 500
): RouteHandler {
  return async (req) => {
    const started = Date.now();
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
      });
      return res;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      logger.error({ key, err: message }, 'cron.run_failed');
      await recordHeartbeat(key, { ok: false, durationMs: Date.now() - started, error: message });
      return NextResponse.json({ error: 'CRON_FAILED', key }, { status: 500 });
    }
  };
}
