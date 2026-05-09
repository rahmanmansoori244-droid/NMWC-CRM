import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { r2, R2_BUCKET } from '@/lib/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * GAP-01: minimal-information health endpoint.
 *
 * The previous implementation returned `{ service, version, timestamp,
 * checks: { app, db, r2 } }` to any unauthenticated caller, confirming the
 * stack (Postgres + R2) and giving an attacker a probe for when the DB is
 * stressed. Now the public response is just `{ status }` and 200/503.
 *
 * Set `HEALTH_BEARER` in Vercel env to expose the detailed payload to
 * monitoring systems via `Authorization: Bearer <token>`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CheckStatus = 'ok' | 'fail' | 'pending';

export async function GET(req: Request) {
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

  // Authenticated monitoring (e.g. Better Stack, internal pingdom) gets the
  // full detail via shared bearer. Public callers only see status.
  const bearer = req.headers.get('authorization');
  const monitorToken = process.env.HEALTH_BEARER;
  const isMonitor =
    monitorToken && bearer === `Bearer ${monitorToken}` && monitorToken.length >= 20;

  if (isMonitor) {
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

  return NextResponse.json({ status: allOk ? 'ok' : 'degraded' }, { status: allOk ? 200 : 503 });
}
