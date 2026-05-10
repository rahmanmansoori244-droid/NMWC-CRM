import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { r2, R2_BUCKET } from '@/lib/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * GAP-01 + B-12 (audit 2026-05-10): minimal-information health endpoint.
 *
 * The previous implementation returned `{ service, version, timestamp,
 * checks: { app, db, r2 } }` to any unauthenticated caller, confirming
 * the stack and giving an attacker a probe for when the DB or R2 is
 * stressed (the 503 status code itself was the leak). Now the public
 * response is ALWAYS `{ "status": "ok" }` with HTTP 200 — Vercel's
 * platform-level uptime monitor still sees 200, but external observers
 * cannot tell whether the DB is degraded.
 *
 * Set `HEALTH_BEARER` in Vercel env to expose the detailed payload,
 * including the actual `degraded` status and 503 status code, to
 * monitoring systems via `Authorization: Bearer <token>`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CheckStatus = 'ok' | 'fail' | 'pending';

export async function GET(req: Request) {
  // Cheap path for unauthenticated callers: skip the live DB/R2 probes
  // entirely so we don't leak degraded state via response timing either.
  const bearer = req.headers.get('authorization');
  const monitorToken = process.env.HEALTH_BEARER;
  const isMonitor =
    !!monitorToken && bearer === `Bearer ${monitorToken}` && monitorToken.length >= 20;

  if (!isMonitor) {
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  }

  const checks: Record<string, CheckStatus> = {
    app: 'ok',
    db: 'pending',
    r2: 'pending',
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch (err) {
    checks.db = 'fail';
    logger.warn({ err }, 'health.db.fail');
  }

  try {
    if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
      await r2().send(new HeadBucketCommand({ Bucket: R2_BUCKET }));
      checks.r2 = 'ok';
    }
  } catch (err) {
    checks.r2 = 'fail';
    logger.warn({ err: (err as Error).message }, 'health.r2.fail');
  }

  const allOk = Object.values(checks).every((v) => v === 'ok' || v === 'pending');

  return NextResponse.json(
    {
      status: allOk ? 'ok' : 'degraded',
      service: 'nmwc-cm',
      version: process.env.npm_package_version ?? 'unknown',
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
