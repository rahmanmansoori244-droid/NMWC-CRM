/**
 * Gap 29 and gap 28 (data audit 2026-10-10): the nightly integrity watch and the
 * ledger seal (lib/integrity/run.ts, lib/seal/*; docs/OPERATIONS.md section 5k).
 *
 * Daily via vercel.json at 02:30 UTC (06:30 Oman): after the Oman day has ended,
 * and before photo-gc (03:00) and the retention sweep (03:30) delete anything that
 * day, so the checks see the state before the purges. Authenticates by
 * `Authorization: Bearer ${CRON_SECRET}` like every cron route.
 *
 * A check that FAILS does not fail the run: it is recorded, shown on
 * /status/integrity, alerted to the Steward (in-app, when switched on) and to the
 * operators' webhook. A check that could not RUN, or an R2 write that failed,
 * does fail it — the heartbeat goes red and cron.failed alerts — because an
 * unanswered check is not a passed one.
 *
 * The response holds counts only; the heartbeat keeps it as its detail.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';
import { runIntegrityWatch } from '@/lib/integrity/run';
import { RUN_DEADLINE_MS } from '@/lib/integrity/policy';
import { r2SealStore } from '@/lib/seal/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  // Every R2 call stops at the run's deadline (the photo-gc pattern): a call R2
  // accepts and never answers must not hold the run until Vercel kills it.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), RUN_DEADLINE_MS);
  try {
    const s = await runIntegrityWatch(prisma, { store: r2SealStore(deadline.signal) });
    logger.info(
      { checks: s.checks, failing: s.failing, errors: s.errors, r2Errors: s.r2Errors, seal: s.seal, sealSeq: s.sealSeq },
      'cron.integrity_watch'
    );
    return NextResponse.json({
      checks: s.checks,
      failing: s.failing,
      info: s.info,
      errors: s.errors,
      r2Errors: s.r2Errors,
      seal: s.seal,
      sealSeq: s.sealSeq,
      alerted: s.alerted,
    });
  } finally {
    clearTimeout(timer);
  }
}

// B5: every finished run is a heartbeat (lib/heartbeat.ts). A check that could not
// run, or a failed R2 write, is a failed run; a check that found a problem is not.
// tests/unit/cron-heartbeat-guard.test.ts holds every *Errors key to this.
export const GET = withHeartbeat(
  'integrity-watch',
  handle,
  (body) => Number(body?.errors ?? 0) === 0 && Number(body?.r2Errors ?? 0) === 0
);
