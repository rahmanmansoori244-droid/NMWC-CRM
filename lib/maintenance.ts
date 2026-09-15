/**
 * REL-02: a way to stop writes during a recovery.
 *
 * `docs/OPERATIONS.md` §6.8 said it plainly: "Nothing can stop 106 field users
 * writing during a recovery, and there is no channel to tell them." Every
 * recovery runbook opened with "stop the write source", which was only
 * actionable for an import batch — a salesman mid-visit had no idea anything
 * was happening and kept submitting.
 *
 * This is deliberately the smallest thing that works. It runs in the Edge
 * middleware, so it costs one environment-variable read per request and needs
 * no database — which matters, because the case it exists for is "the database
 * is being restored".
 *
 * What still gets through, and why:
 *   /api/health   — the probe must answer during an incident; that is the point
 *   /api/cron/    — the heartbeats keep recording, so the dead-man does not
 *                   start alarming about the maintenance you are performing
 *   /api/ops/     — the backup can still report its outcome
 *   /api/auth/    — so an operator with the bypass cookie can still sign in
 *
 * Turning it on needs a redeploy, because Vercel environment variables are read
 * at instance start. That is a real limitation and it is written down in
 * OPERATIONS rather than glossed: in a genuine emergency the faster lever is
 * Vercel's own deployment pause.
 */
import { NextResponse, type NextRequest } from 'next/server';

/** Paths that must keep working while the rest of the app is closed. */
export const MAINTENANCE_ALLOW = ['/api/health', '/api/cron/', '/api/ops/', '/api/auth/'];

/** Operators set this cookie to work on the app while it is closed to everyone else. */
export const MAINTENANCE_BYPASS_COOKIE = 'nmwc_maintenance_bypass';

function page(): string {
  // Self-contained: no CSS file, no font, no script. It has to render when the
  // rest of the application is deliberately unavailable.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NMWC Customer Master — temporarily closed</title>
<style>
  body{margin:0;background:#f4f6f5;color:#13201e;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  main{max-width:34rem}
  h1{font-size:1.5rem;margin:0 0 .75rem}
  p{margin:0 0 .75rem;color:#4a5b57}
  .ar{margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid #d3dcd9;direction:rtl;text-align:right}
</style></head>
<body><main>
  <h1>The customer master is temporarily closed</h1>
  <p>Planned maintenance is in progress. Nothing you submitted earlier has been lost.</p>
  <p>Please try again shortly. If it is still closed in an hour, contact your manager.</p>
  <div class="ar" lang="ar">
    <h1>سجل العملاء مغلق مؤقتاً</h1>
    <p>يجري العمل على صيانة مجدولة. لم يُفقد أي شيء أرسلته سابقاً.</p>
    <p>يرجى المحاولة بعد قليل. إذا استمر الإغلاق لأكثر من ساعة، تواصل مع مديرك.</p>
  </div>
</main></body></html>`;
}

/**
 * Returns a 503 when maintenance mode is on and this request should be held.
 * Returns null the rest of the time, which is every request on a normal day.
 */
export function maintenanceResponse(req: NextRequest): NextResponse | null {
  if (process.env.MAINTENANCE_MODE !== 'on') return null;

  const { pathname } = req.nextUrl;
  if (MAINTENANCE_ALLOW.some((p) => pathname === p || pathname.startsWith(p))) return null;
  // Next's own assets, so the bypass page and any cached shell still render.
  if (pathname.startsWith('/_next')) return null;

  const token = process.env.MAINTENANCE_BYPASS_TOKEN;
  if (token && req.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value === token) return null;

  return new NextResponse(page(), {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Tell well-behaved clients when to come back, and make sure no CDN or
      // browser caches the closed page past the maintenance itself.
      'retry-after': '900',
      'cache-control': 'no-store, must-revalidate',
    },
  });
}
