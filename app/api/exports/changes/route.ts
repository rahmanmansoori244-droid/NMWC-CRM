import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireExportUser } from '@/lib/export-scope';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { buildChangeReport } from '@/lib/change-report';
import { ForbiddenError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The go-live master is ~20k branch rows; styling every changed cell in
// exceljs takes a few seconds, so give the function the full Hobby budget.
export const maxDuration = 60;

/** `until=2026-09-13` means the whole of that Oman day (inclusive). */
function endOfOmanDay(d: Date): Date {
  // Oman is UTC+4 with no DST: local midnight of the NEXT day is 20:00 UTC of this day.
  const local = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  return new Date(local.getTime() + 24 * 3600_000 - 4 * 3600_000 - 1);
}
function startOfOmanDay(d: Date): Date {
  const local = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  return new Date(local.getTime() - 4 * 3600_000);
}

const schema = z.object({
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  regionIds: z.array(z.string()).optional(),
  routeIds: z.array(z.string()).optional(),
  onlyChanged: z.enum(['1', 'true', '0', 'false']).optional(),
  includePending: z.enum(['1', 'true', '0', 'false']).optional(),
});

export async function GET(req: NextRequest) {
  // Auth FIRST (F-21 posture): never let an anonymous caller probe the schema.
  let me;
  try {
    me = await requireExportUser();
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.message.includes('signed in') ? 401 : 403 }
      );
    }
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const parsed = schema.safeParse({
    since: sp.get('since') || undefined,
    until: sp.get('until') || undefined,
    regionIds: sp.getAll('regionId').length ? sp.getAll('regionId') : undefined,
    routeIds: sp.getAll('routeId').length ? sp.getAll('routeId') : undefined,
    onlyChanged: sp.get('onlyChanged') || undefined,
    includePending: sp.get('includePending') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid filter parameters' }, { status: 400 });
  }
  const f = parsed.data;
  const truthy = (v: string | undefined) => v === '1' || v === 'true';

  try {
    const out = await buildChangeReport(
      { id: me.id, role: me.role, username: me.username },
      {
        since: f.since ? startOfOmanDay(f.since) : undefined,
        until: f.until ? endOfOmanDay(f.until) : undefined,
        regionIds: f.regionIds,
        routeIds: f.routeIds,
        onlyChanged: truthy(f.onlyChanged),
        includePending: f.includePending == null ? true : truthy(f.includePending),
      }
    );
    // DG-06/07: no longer best-effort (same convention as the master export).
    // This sits before the NextResponse carrying the bytes, and the enclosing
    // catch turns a failure into a logged 500 — so the change report, which
    // carries addresses, phones and contact names, cannot be delivered without
    // a ledger row naming who took it.
    await writeAudit(null, await getAuditEnvelope(me.id), {
      action: 'EXPORT',
      entityType: 'Export',
      entityId: `field-updates-${new Date().toISOString().slice(0, 10)}`,
      reason: `field-updates ${out.rowCount} rows / ${out.changedRows} changed / ${out.changeCount} changes`,
    });
    return new NextResponse(out.bytes, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(out.rowCount),
        'X-Changed-Rows': String(out.changedRows),
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'export.change_report.fail');
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
