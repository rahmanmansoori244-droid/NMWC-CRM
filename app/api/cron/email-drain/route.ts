/**
 * F1 (2026-10-05): the e-mail outbox drain. Every 10 minutes, 03:00–14:59 UTC
 * (07:00–18:59 Oman), the window of the other jobs (vercel.json `crons`;
 * lib/notify-policy.ts EMAIL_DELIVERY.schedule).
 *
 * The only place e-mail is sent from (tests/unit/email-structure-guard.test.ts):
 * the Notification rows it reads were committed with the change that caused
 * them, so a rolled-back, replayed or lost-race change is never e-mailed, and no
 * request or approval waits on an SMTP server.
 *
 * Off until the owner turns it on (NOTIFY_EMAIL_ENABLED=on, lib/email/config.ts):
 * until then, during maintenance, and off production without EMAIL_REDIRECT_TO, a
 * run reads nothing and answers `{ enabled: false, reason }` — a healthy run, so
 * the warning-tier alarm means "the schedule stopped", not "e-mail is off". Switched
 * ON but unusable (a Gmail setting missing, a redirect or link origin that is not
 * one), it still sends nothing, and the run is recorded as failed (configErrors),
 * so the switch being on is never silently a no-op.
 *
 * The JSON is counts only: it is stored as the heartbeat's last detail and served
 * to the monitor. A run with a send or login failure is recorded as failed and
 * raises the warning-tier `cron.failed` alert (lib/heartbeat.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';
import { readEmailConfig } from '@/lib/email/config';
import { createGmailTransport } from '@/lib/email/transport';
import { prismaOutboxStore } from '@/lib/email/outbox-store';
import { runEmailDrain } from '@/lib/email/drain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const config = readEmailConfig();
  if (!config.send) {
    const misconfigured =
      config.reason === 'unconfigured' || config.reason === 'bad-redirect' || config.reason === 'bad-link-origin';
    return NextResponse.json({ enabled: false, reason: config.reason, configErrors: misconfigured ? 1 : 0 });
  }
  const r = await runEmailDrain({
    store: prismaOutboxStore(prisma),
    transport: createGmailTransport(config),
    config,
  });
  logger.info(
    {
      claimed: r.claimed,
      sent: r.sent,
      skipped: r.skipped,
      failed: r.failed,
      deferred: r.deferred,
      capped: r.capped,
      sendErrors: r.sendErrors,
      authErrors: r.authErrors,
    },
    'email.drain'
  );
  return NextResponse.json({
    enabled: true,
    redirected: config.redirectTo !== null,
    claimed: r.claimed,
    sent: r.sent,
    skipped: r.skipped,
    skippedBy: r.skippedBy,
    failed: r.failed,
    deferred: r.deferred,
    capped: r.capped,
    staleMarked: r.staleMarked,
    exhaustedMarked: r.exhaustedMarked,
    budgetStopped: r.budgetStopped,
    errorLabels: r.errorLabels,
    sendErrors: r.sendErrors,
    authErrors: r.authErrors,
  });
}

export const GET = withHeartbeat(
  'email-drain',
  handle,
  (body) =>
    Number(body?.sendErrors ?? 0) === 0 &&
    Number(body?.authErrors ?? 0) === 0 &&
    Number(body?.configErrors ?? 0) === 0
);
