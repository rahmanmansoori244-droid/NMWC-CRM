// @vitest-environment node
/**
 * services/imports.ts — the importer refuses a workbook over the import cap with
 * the same words the upload form uses in the browser (lib/import-file-size.ts).
 *
 * The cap used to be 5 MB, above the 4.5 MB request body Vercel lets through,
 * so on the live site its "Maximum is 5 MB" could never show, while the form
 * (app/(app)/import/forms.tsx) refused at a different number. Now one cap,
 * 4,300 KB (4.2 MB), and one message, for both importers. The form's side is in
 * tests/unit/import-upload-result.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {},
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true, retryAfterSec: 0 }) }));
vi.mock('@/lib/alert', () => ({ sendAlert: async () => {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
// Nothing past the size check may run: a database call would throw here.
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { uploadAccountMasterAction, uploadCustomerMasterAction } from '@/services/imports';
import { MAX_IMPORT_BYTES, importFileTooLarge } from '@/lib/import-file-size';

function upload(size: number) {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array(size)], 'master.xlsx'));
  return fd;
}

describe('a workbook over the import cap', () => {
  it('the cap is 4,300 KB (4.2 MB), under the 4.5 MB Vercel lets a request carry', () => {
    expect(MAX_IMPORT_BYTES).toBe(4300 * 1024);
    expect(MAX_IMPORT_BYTES).toBeLessThan(4_500_000);
    expect(importFileTooLarge(MAX_IMPORT_BYTES + 1024)).toBe(
      'File is too large (4301 KB). Maximum is 4.2 MB.'
    );
  });

  it.each([
    ['customer', uploadCustomerMasterAction],
    ['account', uploadAccountMasterAction],
  ] as const)('the %s importer refuses it in the same words as the form', async (_, action) => {
    const res = await action(upload(MAX_IMPORT_BYTES + 1024));
    expect(res).toMatchObject({
      ok: false,
      fields: { file: 'File is too large (4301 KB). Maximum is 4.2 MB.' },
    });
  });
});
