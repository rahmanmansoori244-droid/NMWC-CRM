// @vitest-environment node
/**
 * IMP-REGION — an unresolvable `region_codes` value must QUARANTINE the row, not
 * silently clear the user's regions.
 *
 * The defect this pins: the Users sheet resolved region codes with
 * `findMany({ where: { code: { in: codes } } })` and wrote
 * `managedRegions: { set: <whatever matched> }` with no check that everything
 * matched and no issue raised. One typo therefore wrote `set: []`.
 *
 * An empty managedRegions is fail-closed everywhere for MANAGER and ACCOUNTANT —
 * lib/access.ts canSeeCustomer, lib/permissions.ts canActOnStep (REGION_OVERLAP),
 * lib/customer-filters.ts, and the approvals page, which substitutes
 * `id: '__none__'`. So the account signed in normally and saw an empty approval
 * queue for good, while `cleanCount++` told the Steward the row was clean.
 *
 * It became load-stopping on 2026-09-20, when the single all-regions `accountant`
 * became seven single-region ones. One all-regions account loses a seventh of its
 * coverage to a bad code; a single-region account loses all of it, taking that
 * region's CASH and CREDIT chains offline — reported as a clean import.
 *
 * The Routes sheet in the same function already quarantines the same mistake
 * (`region "X" not found`). These tests assert the Users sheet now does too, in
 * both directions: a bad code quarantines AND leaves existing regions untouched,
 * and a good code still applies.
 *
 * GATED like the other integration suites; the default `npm test` skips cleanly.
 * Writes only ZZ-prefixed rows, cleaned up in afterAll. Never production.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-region-codes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const USERS_HEADERS = [
  'username',
  'full_name',
  'role',
  'password',
  'supervisor_username',
  'route_code',
  'region_codes',
  'email',
  'phone',
  'reset_password',
  'change_role',
  'must_change_password',
] as const;

/** A one-sheet account master carrying just the Users rows a case needs. */
async function accountMaster(rows: Array<Record<string, string>>): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.addRow([...USERS_HEADERS]);
  for (const r of rows) ws.addRow(USERS_HEADERS.map((h) => r[h] ?? ''));
  // exceljs returns its own Buffer type, not node Buffer — normalise for File().
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out));
  return bytes;
}

describe.skipIf(!ENABLED)('account master: region_codes that do not resolve', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const stewardId = 'ZZ-RGN-' + randomUUID().slice(0, 8);
  const acct = ('zz.acct.' + randomUUID().slice(0, 8)).toLowerCase();
  const batchIds: string[] = [];
  let realCode = '';

  /**
   * Drop this steward's import-limiter bucket.
   *
   * F-07 rate-limits the account master to one upload per ~30s, and this suite
   * uploads five times. Sleeping through it would add two and a half minutes to
   * CI for no signal — the limiter has its own test (rate-limit-pg). Scoped by
   * key to the ZZ steward so nothing else's bucket is disturbed.
   */
  const clearLimiter = async () => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
  };

  const upload = async (rows: Array<Record<string, string>>) => {
    await clearLimiter();
    const buf = await accountMaster(rows);
    const fd = new FormData();
    fd.set('file', new File([buf], 'account-master.xlsx', { type: XLSX_MIME }));
    const res = await imports.uploadAccountMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = (res as { ok: true; data: { batchId: string; clean: number; issues: number } })
      .data;
    batchIds.push(data.batchId);
    const importRows = await prisma.importRow.findMany({
      where: { batchId: data.batchId },
      select: { issues: true },
    });
    const messages = importRows
      .flatMap((r) => (r.issues as { sheet: string; row: number; message: string }[] | null) ?? [])
      .map((i) => i.message);
    return { ...data, messages };
  };

  /**
   * Remove a test account, or deactivate it if the audit trail pins it.
   *
   * An actor that has written an AuditLog row cannot be deleted —
   * AuditLog_actorId_fkey, and the trail is append-only by design. Deactivating
   * achieves what the cleanup is for: the account cannot sign in. Its
   * passwordHash is not a valid bcrypt hash either, so it never could.
   */
  const retire = async (where: { id?: string; username?: string }) => {
    try {
      await prisma.user.deleteMany({ where });
    } catch {
      await prisma.user.updateMany({ where, data: { isActive: false } });
    }
  };

  const regionsOf = async (username: string) => {
    const u = await prisma.user.findUnique({
      where: { username },
      select: { managedRegions: { select: { code: true } } },
    });
    return (u?.managedRegions ?? []).map((r) => r.code).sort();
  };

  beforeAll(async () => {
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    // Use a region that actually exists in this database rather than assuming
    // the go-live codes have been loaded — the suite must not depend on order.
    const region = await prisma.region.findFirst({
      where: { code: { not: 'UNASSIGNED' } },
      select: { code: true },
    });
    if (!region) throw new Error('no regions in this database — import the Regions sheet first');
    realCode = region.code;
    await prisma.user.create({
      data: {
        id: stewardId,
        username: stewardId,
        passwordHash: 'x',
        fullName: 'ZZ Steward',
        role: 'STEWARD',
      },
    });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of batchIds) {
      await prisma.importRow.deleteMany({ where: { batchId: id } });
      await prisma.importBatch.deleteMany({ where: { id } });
    }
    await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
    await retire({ username: acct });
    await retire({ id: stewardId });
    await prisma.$disconnect();
  });

  it('applies a region code that resolves', async () => {
    const res = await upload([
      {
        username: acct,
        full_name: 'ZZ Accountant',
        role: 'ACCOUNTANT',
        password: '12345',
        region_codes: realCode,
        must_change_password: 'yes',
      },
    ]);
    expect(res.clean).toBe(1);
    expect(await regionsOf(acct)).toEqual([realCode]);
  });

  it('quarantines an unknown code instead of clearing the regions', async () => {
    // The whole point: the account already has a region from the test above. A
    // later import with a typo must not take it away.
    const res = await upload([
      {
        username: acct,
        full_name: 'ZZ Accountant',
        role: 'ACCOUNTANT',
        password: '12345',
        region_codes: 'NOSUCHREGION',
        must_change_password: 'yes',
      },
    ]);
    expect(res.clean).toBe(0);
    expect(res.issues).toBeGreaterThan(0);
    expect(res.messages.join(' ')).toMatch(/NOSUCHREGION/);
    expect(await regionsOf(acct), 'the existing region must survive').toEqual([realCode]);
  });

  it('quarantines a PARTIAL match rather than silently dropping the bad half', async () => {
    // The subtler half of the defect: `set:` replaces the whole relation, so
    // writing only what resolved would quietly shrink the account's coverage.
    const res = await upload([
      {
        username: acct,
        full_name: 'ZZ Accountant',
        role: 'ACCOUNTANT',
        password: '12345',
        region_codes: `${realCode},NOSUCHREGION`,
        must_change_password: 'yes',
      },
    ]);
    expect(res.clean).toBe(0);
    expect(res.messages.join(' ')).toMatch(/NOSUCHREGION/);
    expect(await regionsOf(acct)).toEqual([realCode]);
  });

  it('refuses to create a NEW region-scoped account with no regions at all', async () => {
    // Fail-closed means empty is blind, not unrestricted. The import template
    // documented region_codes as required for ACCOUNTANT and nothing enforced it.
    const fresh = ('zz.blind.' + randomUUID().slice(0, 8)).toLowerCase();
    const res = await upload([
      {
        username: fresh,
        full_name: 'ZZ Blind Accountant',
        role: 'ACCOUNTANT',
        password: '12345',
        region_codes: '',
        must_change_password: 'yes',
      },
    ]);
    expect(res.clean).toBe(0);
    expect(res.messages.join(' ')).toMatch(/region_codes/);
    await retire({ username: fresh });
  });

  it('leaves an EXISTING account alone when the cell is blank', async () => {
    // Blank means "keep what you had" for an existing row, mirroring the password
    // and supervisor rules. Only a NEW account is refused, because only there
    // does blank mean zero.
    const res = await upload([
      {
        username: acct,
        full_name: 'ZZ Accountant',
        role: 'ACCOUNTANT',
        password: '',
        region_codes: '',
        must_change_password: 'yes',
      },
    ]);
    expect(res.clean).toBe(1);
    expect(await regionsOf(acct)).toEqual([realCode]);
  });
});
