// @vitest-environment node
/**
 * Launch fix (2026-10-07): /import offers the import templates as downloads
 * (app/(app)/import/template/route.ts).
 *
 * What was wrong: the page listed the columns but offered no file, so a Steward
 * built each workbook by hand from the help text. The route serves the generated
 * templates that tests/unit/import-templates.test.ts checks against the
 * importer's parser, to a Steward only, as /import is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; username: string; mustChangePassword?: boolean },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/db', () => ({ prisma: { importBatch: { findMany: async () => [] } } }));
vi.mock('@/app/(app)/import/forms', () => ({ UploadAccountForm: () => null, UploadCustomerForm: () => null }));

import { renderToStaticMarkup } from 'react-dom/server';
import { GET } from '@/app/(app)/import/template/route';
import ImportPage from '@/app/(app)/import/page';

const call = (kind: string) => GET(new NextRequest(`https://example.test/import/template?kind=${kind}`));
const as = (role: string) => {
  h.user = { id: `u-${role}`, role, username: role.toLowerCase() };
};

beforeEach(() => {
  h.user = null;
});

describe('/import/template', () => {
  it.each([
    ['account', 'account-master-template.xlsx'],
    ['customer', 'customer-master-template.xlsx'],
  ])('a Steward downloads the %s master template, byte for byte the checked one', async (kind, file) => {
    as('STEWARD');
    const res = await call(kind);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${file}"`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(readFileSync(path.join('docs', 'import-templates', file)))).toBe(true);
  });

  it.each(['MANAGER', 'VIEWER', 'SALESMAN'])('a %s is refused, as /import refuses him', async (role) => {
    as(role);
    const res = await call('account');
    expect(res.status).toBe(403);
  });

  it('a signed-out caller is refused', async () => {
    expect((await call('account')).status).toBe(401);
  });

  it('the deployed function carries both files (next.config.ts outputFileTracingIncludes)', async () => {
    const { default: config } = await import('../../next.config');
    expect(config.outputFileTracingIncludes?.['/import/template']).toContain('./docs/import-templates/*.xlsx');
  });

  it('an unknown kind is not a path into the file system', async () => {
    as('STEWARD');
    for (const kind of ['../../.env', 'users', '']) {
      expect((await call(encodeURIComponent(kind))).status).toBe(404);
    }
  });
});

describe('/import', () => {
  it('links both templates', async () => {
    as('STEWARD');
    const html = renderToStaticMarkup(await ImportPage());
    expect(html).toContain('href="/import/template?kind=account"');
    expect(html).toContain('href="/import/template?kind=customer"');
  });
});
