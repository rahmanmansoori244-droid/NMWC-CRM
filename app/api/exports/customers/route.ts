import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { buildCustomerExport, type ExportFilters } from '@/services/exports';
import { ForbiddenError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const filterSchema = z.object({
  regionIds: z.array(z.string()).optional(),
  routeIds: z.array(z.string()).optional(),
  statuses: z.array(z.enum(['ACTIVE', 'CLOSED', 'SUSPENDED'])).optional(),
  paymentTerms: z.array(z.enum(['CASH', 'CREDIT'])).optional(),
  minCompleteness: z.coerce.number().min(0).max(100).optional(),
  maxCompleteness: z.coerce.number().min(0).max(100).optional(),
  updatedSince: z.coerce.date().optional(),
});

export async function GET(req: NextRequest) {
  // F-21: auth FIRST. Previously the Zod parse ran before the session check, so
  // an unauthenticated attacker could probe the schema (`?minCompleteness=999`)
  // and read the validation error structure for free.
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  let filters: ExportFilters;
  try {
    filters = filterSchema.parse({
      regionIds: req.nextUrl.searchParams.getAll('regionId').length
        ? req.nextUrl.searchParams.getAll('regionId')
        : undefined,
      routeIds: req.nextUrl.searchParams.getAll('routeId').length
        ? req.nextUrl.searchParams.getAll('routeId')
        : undefined,
      statuses: req.nextUrl.searchParams.getAll('status').length
        ? (req.nextUrl.searchParams.getAll('status') as ExportFilters['statuses'])
        : undefined,
      paymentTerms: req.nextUrl.searchParams.getAll('paymentTerms').length
        ? (req.nextUrl.searchParams.getAll('paymentTerms') as ExportFilters['paymentTerms'])
        : undefined,
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
