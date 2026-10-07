/**
 * Launch fix (2026-10-07): the import templates, downloadable from /import.
 *
 * The page listed the columns but offered no file, so a Steward built the
 * workbook by hand from the help text, sheet names and all. These are the
 * generated templates (scripts/build-import-templates.ts) that
 * tests/unit/import-templates.test.ts checks against the importer's own parser,
 * the files docs/import-templates hands out — served to a Steward only, as /import is.
 *
 * Each path is a literal under process.cwd(), and next.config.ts lists both
 * files in outputFileTracingIncludes, so the deployed function carries them.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { checkActor } from '@/lib/session';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const TEMPLATES = {
  account: {
    filename: 'account-master-template.xlsx',
    read: () => readFile(path.join(process.cwd(), 'docs', 'import-templates', 'account-master-template.xlsx')),
  },
  customer: {
    filename: 'customer-master-template.xlsx',
    read: () => readFile(path.join(process.cwd(), 'docs', 'import-templates', 'customer-master-template.xlsx')),
  },
} as const;

export async function GET(req: NextRequest) {
  const who = await checkActor();
  if (!who.ok) return NextResponse.json({ error: who.message }, { status: who.status });
  if (who.user.role !== Role.STEWARD) {
    return NextResponse.json({ error: 'Only a Steward can import.' }, { status: 403 });
  }
  const kind = req.nextUrl.searchParams.get('kind');
  const template = kind === 'account' || kind === 'customer' ? TEMPLATES[kind] : null;
  if (!template) return NextResponse.json({ error: 'No such template.' }, { status: 404 });
  let body: Buffer;
  try {
    body = await template.read();
  } catch (err) {
    logger.error({ err: (err as Error).message, kind }, 'import.template_missing');
    return NextResponse.json({ error: 'The template is missing from this deployment.' }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': XLSX,
      'Content-Disposition': `attachment; filename="${template.filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
