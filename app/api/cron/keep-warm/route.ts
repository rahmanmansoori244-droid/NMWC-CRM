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
 *   See vercel.json `crons` entry.
 *
 * What it does:
 *   - Authenticates via CRON_SECRET (same secret photo-gc uses).
 *   - Runs one cheap SELECT 1 so the Neon pool stays open.
 *   - Pre-fetches the reference-data caches so they're warm too.
 *   - Returns a tiny JSON ack.
 *
 * Cost: 1 function invocation × 180/day × 30 days = 5,400/month. Each call
 * is <200 ms function time. Well within the free tier.
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
  try {
    await prisma.$queryRaw`SELECT 1`;
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
    },
    { status: dbOk ? 200 : 503 }
  );
}

export const GET = withHeartbeat('keep-warm', handle, (body) => body?.warm === true);
