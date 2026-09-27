/**
 * F2 (2026-05-11) — pre-warm the production Vercel function so cold starts
 * don't bite users during Oman business hours.
 *
 * Vercel functions go cold after ~5 min of idle. First hit after cold-start
 * costs ~2-3 s on this stack (Prisma init + Auth.js + middleware bundle).
 * For a salesman who opens the app once an hour, every page load is a cold
 * start. Hitting this endpoint every 4 min keeps the function warm during
 * the window people actually use it.
 *
 * Schedule: every 4 minutes during 03:00-15:00 UTC (= 07:00-19:00 Oman).
 *   vercel.json `crons` since the Pro plan (2026-09-27); cron-job.org and the
 *   GitHub workflow call it too until they are retired (OPERATIONS.md §5d).
 *
 * What it does:
 *   - Authenticates via CRON_SECRET (same secret photo-gc uses).
 *   - Runs one cheap SELECT 1 so the Neon pool stays open.
 *   - Pre-fetches the reference-data caches so they're warm too.
 *   - Returns a tiny JSON ack.
 *
 * Cost: 1 function invocation × 180/day × 30 days = 5,400/month per scheduler.
 * Each call is <200 ms function time.
 *
 * Item 9: each run is also the availability probe. Its CronRun rows are what
 * lib/service-levels.ts turns into "share of 4-minute slots the app answered".
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  getAllActiveChannels,
  getAllActiveRegions,
  getAllActiveRoutes,
  getAllActiveSubChannels,
  getAllHierarchyUsers,
} from '@/lib/reference-data';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// B-16 constant-time bearer comparison — shared with photo-gc + sla-escalate.
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const started = Date.now();
  let dbOk = false;
  let refsOk = false;
  // Item 9: the database round trip on its own, stored per run (CronRun.dbMs) —
  // elapsedMs below also includes the reference-data loads.
  let dbMs: number | null = null;
  try {
    const dbStarted = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbMs = Date.now() - dbStarted;
    dbOk = true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'keep-warm.db_fail');
  }
  try {
    await Promise.all([
      getAllActiveRegions(),
      getAllActiveRoutes(),
      getAllActiveChannels(),
      getAllActiveSubChannels(),
      getAllHierarchyUsers(),
    ]);
    refsOk = true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'keep-warm.refs_fail');
  }
  const elapsedMs = Date.now() - started;
  // B5: a failed database probe is reported as 503 so the scheduler's log (and
  // the heartbeat) show the failure instead of a green 200 with `db:false`.
  return NextResponse.json(
    {
      warm: dbOk && refsOk,
      db: dbOk,
      refs: refsOk,
      elapsedMs,
      ...(dbMs === null ? {} : { dbMs }),
    },
    { status: dbOk ? 200 : 503 }
  );
}

export const GET = withHeartbeat('keep-warm', handle, (body) => body?.warm === true);
