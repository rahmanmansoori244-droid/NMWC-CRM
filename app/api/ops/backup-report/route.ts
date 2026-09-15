/**
 * B3 (enterprise assessment, 2026-09-14): the nightly dump reports itself.
 *
 * The backup runs in GitHub Actions, not in this app, so `withHeartbeat` cannot
 * wrap it. Its failure modes were therefore SILENT to everyone who was not
 * watching the Actions tab: a rotated `neondb_owner` password, an expired R2
 * token, a Neon host change — each breaks the dump while the application stays
 * perfectly healthy. `.github/workflows/db-backup.yml` now POSTs the outcome of
 * every run here (`if: always()`), success or failure, and the bearer
 * `/api/health` probe alarms when the last report is older than 40 hours (lib/heartbeat.ts, sized from the real GitHub cron drift) or
 * reported a failure (lib/heartbeat.ts, key `db-backup`).
 *
 * Auth: the same `CRON_SECRET` bearer as the cron routes. The body is
 * operational metadata only — never a connection string, never a credential;
 * the workflow sends the object key, the byte size and the duration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { recordHeartbeat } from '@/lib/heartbeat';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Keep anything that looks like a credential out of the stored detail. */
function clean(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[connection-string]').slice(0, max);
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const ok = body.ok === true || body.ok === 'true';
  const bytes = Number(body.bytes);
  const durationMs = Number(body.durationMs);
  const detail = {
    objectKey: clean(body.objectKey),
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : null,
    encrypted: body.encrypted === true || body.encrypted === 'true',
    runUrl: clean(body.runUrl, 300),
  };

  await recordHeartbeat('db-backup', {
    ok,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
    error: ok ? undefined : (clean(body.error, 500) ?? 'backup workflow reported failure'),
    detail,
  });

  logger.info({ ok, objectKey: detail.objectKey, bytes: detail.bytes }, 'ops.backup_reported');
  return NextResponse.json({ recorded: true, ok });
}

/** A GET is not a report — refuse it so a browser visit cannot mark a backup healthy. */
export function GET() {
  return NextResponse.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
}
