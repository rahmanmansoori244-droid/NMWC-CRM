import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkActor } from '@/lib/session';
import { buildCustomerExport, type ExportFilters } from '@/services/exports';
import { ForbiddenError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { readExportFilterLists } from '@/lib/export-filter-lists';
import { startOfOmanDay } from '@/lib/tz';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const filterSchema = z.object({
  regionIds: z.array(z.string()).optional(),
  routeIds: z.array(z.string()).optional(),
  statuses: z.array(z.enum(['ACTIVE', 'CLOSED', 'SUSPENDED'])).optional(),
  paymentTerms: z.array(z.enum(['CASH', 'CREDIT'])).optional(),
  minCompleteness: z.coerce.number().min(0).max(100).optional(),
  maxCompleteness: z.coerce.number().min(0).max(100).optional(),
  // `updatedSince=2026-09-30` means from the start of that OMAN day, as the
  // field-update report reads its window. A bare date parses as UTC midnight,
  // 04:00 in Oman, which left out a customer updated before 04:00 that day.
  updatedSince: z.coerce.date().transform(startOfOmanDay).optional(),
});

export async function GET(req: NextRequest) {
  // F-21: auth FIRST. Previously the Zod parse ran before the session check, so
  // an unauthenticated attacker could probe the schema (`?minCompleteness=999`)
  // and read the validation error structure for free.
  // F15: a session that must change its password gets 403.
  const who = await checkActor();
  if (!who.ok) {
    return NextResponse.json(
      { error: who.status === 401 ? 'Not signed in' : who.message },
      { status: who.status }
    );
  }

  let filters: ExportFilters;
  try {
    const lists = readExportFilterLists(req.nextUrl.searchParams, true);
    if (!lists) {
      return NextResponse.json({ error: 'Invalid filter parameters' }, { status: 400 });
    }
    filters = filterSchema.parse({
      ...lists,
      minCompleteness: req.nextUrl.searchParams.get('minCompleteness') ?? undefined,
      maxCompleteness: req.nextUrl.searchParams.get('maxCompleteness') ?? undefined,
      updatedSince: req.nextUrl.searchParams.get('updatedSince') ?? undefined,
    });
  } catch {
    return NextResponse.json({ error: 'Invalid filter parameters' }, { status: 400 });
  }

  try {
    const { bytes, filename } = await buildCustomerExport(filters);
    return new NextResponse(bytes, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    // F-22: distinguish 401/403/500 by error class, not by message substring.
    logger.error({ err: (err as Error).message }, 'export.fail');
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.message.includes('signed in') ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
