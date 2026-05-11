/**
 * F4 (2026-05-11) — measure per-query timing on the /customers page so the
 * operator can confirm the F1+F3 wins really landed (and spot regressions
 * later).
 *
 * Auth: STEWARD or MANAGER only. The endpoint exposes table-level row
 * counts and is not for anonymous use.
 *
 * Output: JSON with timings (ms) for each of the queries the /customers
 * page runs, plus the total. Hit it twice in a row — the second call is
 * the "warm" number; the first is "cold". If the cache is working, the
 * second call's reference-data timings should be near zero.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { customerCountFast } from '@/lib/customer-count';
import {
  getAllActiveChannels,
  getAllActiveRegions,
  getAllActiveRoutes,
  getAllActiveSubChannels,
  getAllHierarchyUsers,
} from '@/lib/reference-data';
import { Role } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function timed<T>(name: string, fn: () => Promise<T>): Promise<{ name: string; ms: number; sample?: number | string }> {
  const t = Date.now();
  try {
    const r = await fn();
    const elapsed = Date.now() - t;
    let sample: number | string | undefined;
    if (Array.isArray(r)) sample = r.length;
    else if (typeof r === 'object' && r !== null && 'total' in r) sample = (r as { total: number }).total;
    return { name, ms: elapsed, sample };
  } catch (err) {
    return { name, ms: Date.now() - t, sample: `ERROR: ${(err as Error).message.slice(0, 80)}` };
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  if (session.user.role !== Role.STEWARD && session.user.role !== Role.MANAGER) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const overallStart = Date.now();
  const where = { deletedAt: null };

  // Run each query independently so we get per-query timing.
  const timings = await Promise.all([
    timed('customerCountFast (unfiltered)', () => customerCountFast(where)),
    timed('customer.findMany (page 1, 50 rows)', () =>
      prisma.customer.findMany({
        where,
        orderBy: { legalName: 'asc' },
        take: 50,
        select: { id: true, nmwcCode: true, legalName: true, completenessScore: true },
      })
    ),
    timed('getAllActiveRegions', () => getAllActiveRegions()),
    timed('getAllActiveRoutes', () => getAllActiveRoutes()),
    timed('getAllActiveChannels', () => getAllActiveChannels()),
    timed('getAllActiveSubChannels', () => getAllActiveSubChannels()),
    timed('getAllHierarchyUsers', () => getAllHierarchyUsers()),
  ]);

  const total = Date.now() - overallStart;
  return NextResponse.json({
    runAt: new Date().toISOString(),
    totalMs: total,
    note: 'Hit this twice in a row. Second call should show reference-data timings near zero (cached).',
    queries: timings,
  });
}
