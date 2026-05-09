import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCustomerExport, type ExportFilters } from '@/services/exports';
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
  const sp = req.nextUrl.searchParams;
  const filters: ExportFilters = filterSchema.parse({
    regionIds: sp.getAll('regionId').length ? sp.getAll('regionId') : undefined,
    routeIds: sp.getAll('routeId').length ? sp.getAll('routeId') : undefined,
    statuses: sp.getAll('status').length
      ? (sp.getAll('status') as ExportFilters['statuses'])
      : undefined,
    paymentTerms: sp.getAll('paymentTerms').length
      ? (sp.getAll('paymentTerms') as ExportFilters['paymentTerms'])
      : undefined,
    minCompleteness: sp.get('minCompleteness') ?? undefined,
    maxCompleteness: sp.get('maxCompleteness') ?? undefined,
    updatedSince: sp.get('updatedSince') ?? undefined,
  });

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
    logger.error({ err: (err as Error).message }, 'export.fail');
    const status = (err as Error).message.includes('signed in') ? 401 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
