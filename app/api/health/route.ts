import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { r2, R2_BUCKET } from '@/lib/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { bearerMatches } from '@/lib/cron-auth';
import { loadHeartbeatReport } from '@/lib/heartbeat';

/**
 * GAP-01 + B-12 (audit 2026-05-10): minimal-information health endpoint.
 *
 * The public response stays minimal — `{ "status": "ok" }` — but it is no
 * longer unconditionally 200: B5 (enterprise assessment, 2026-09-14) found the
 * anonymous probe returned 200 with the database down, so an uptime monitor
 * pointed at it could never see an outage. It now runs one `SELECT 1` and
 * answers 503 `{ "status": "degraded" }` when that fails. Nothing else is
 * disclosed to anonymous callers.
 *
 * With `Authorization: Bearer <HEALTH_BEARER>` (an external monitor) the
 * detailed payload is returned: DB and R2 checks plus the per-job cron
 * heartbeats (lib/heartbeat.ts) — "stale" / "never ran" / "failed" are the
 * dead-man alarms for the SLA sweep, keep-warm and photo GC. The status code
 * is 503 whenever anything alarms, so the monitor needs no body parsing.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CheckStatus = 'ok' | 'fail' | 'pending';

async function dbOk(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'health.db.fail');
    return false;
  }
}

export async function GET(req: Request) {
  const bearer = req.headers.get('authorization');
  const monitorToken = process.env.HEALTH_BEARER;
  // B-16 posture: constant-time compare, and a short token never unlocks details.
  const isMonitor = !!monitorToken && monitorToken.length >= 20 && bearerMatches(bearer, monitorToken);

  if (!isMonitor) {
    const ok = await dbOk();
    return NextResponse.json({ status: ok ? 'ok' : 'degraded' }, { status: ok ? 200 : 503 });
  }

  const checks: Record<string, CheckStatus> = {
    app: 'ok',
    db: 'pending',
    r2: 'pending',
  };

  checks.db = (await dbOk()) ? 'ok' : 'fail';

  try {
    if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
      await r2().send(new HeadBucketCommand({ Bucket: R2_BUCKET }));
      checks.r2 = 'ok';
    }
  } catch (err) {
    checks.r2 = 'fail';
    logger.warn({ err: (err as Error).message }, 'health.r2.fail');
  }

  // Heartbeats need the database; when it is down they are reported as unknown
  // rather than masking the DB failure behind a second error.
  let heartbeats: Awaited<ReturnType<typeof loadHeartbeatReport>> | null = null;
  if (checks.db === 'ok') {
    try {
      heartbeats = await loadHeartbeatReport();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'health.heartbeats.fail');
    }
  }
  const cronAlarms = (heartbeats ?? []).filter((h) => h.alarm).map((h) => h.key);

  const allOk =
    Object.values(checks).every((v) => v === 'ok' || v === 'pending') && cronAlarms.length === 0;

  return NextResponse.json(
    {
      status: allOk ? 'ok' : 'degraded',
      service: 'nmwc-cm',
      version: process.env.npm_package_version ?? 'unknown',
      timestamp: new Date().toISOString(),
      checks,
      cron: {
        alarms: cronAlarms,
        jobs: heartbeats,
      },
    },
    { status: allOk ? 200 : 503 }
  );
}
