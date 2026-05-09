import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

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

  // R2: connectivity check deferred to M3 (avoids unnecessary cost on every probe).

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
