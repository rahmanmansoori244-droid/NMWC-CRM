import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { r2, R2_BUCKET } from '@/lib/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CheckStatus = 'ok' | 'fail' | 'pending';

export async function GET() {
  const checks: Record<string, CheckStatus> = {
    app: 'ok',
    db: 'pending',
    r2: 'pending',
  };

  // DB ping (cheap query)
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch (err) {
    checks.db = 'fail';
    logger.warn({ err }, 'health.db.fail');
  }

  // R2: a HEAD on the bucket is a tiny, free operation
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
