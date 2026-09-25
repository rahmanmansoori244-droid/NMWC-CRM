// @vitest-environment node
/**
 * The customer master export (services/exports.ts + lib/customer-master-rows.ts),
 * benchmark item 28: no longer capped at 25,000 rows. Until now NOTHING exercised
 * this export's behaviour — so besides the new paging and ceiling, its role scope
 * (F-01: intersected with the user's filters, fail-closed) is pinned here too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: { id: 'u1', role: 'STEWARD', username: 'steward.x' } as { id: string; role: string; username: string },
  count: 0,
  rows: [] as Array<Record<string, unknown>>,
  teamRoutes: [] as string[],
  managedRegions: [] as string[],
  findMany: vi.fn(),
  count_: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async () => ({ actorId: h.user.id, ip: null, userAgent: null }),
  writeAudit: h.writeAudit,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findMany: async () => h.teamRoutes.map((r) => ({ ownedRouteId: r })) },
    region: { findMany: async () => h.managedRegions.map((id) => ({ id })) },
    branch: { count: h.count_, findMany: h.findMany },
  },
}));

import { buildCustomerExport } from '@/services/exports';
import { CUSTOMER_MASTER_COLUMNS, customerMasterRows } from '@/lib/customer-master-rows';
import { parseWorkbook } from '@/lib/excel';

/** A branch row as the export's `select` returns it. */
const branch = (i: number) => ({
  branchCode: `B-${String(i).padStart(5, '0')}`,
  branchName: `Branch ${i}`,
  address: `Way ${i}`,
  areaDescription: null,
  dayOfVisit: 'SUN',
  openingHours: null,
  deliveryWindow: null,
  gpsLat: 23.5,
  gpsLng: 58.3,
  gpsCapturedAt: new Date('2026-09-24T08:00:00.000Z'),
  coolersCount: 1,
  standsCount: 0,
  emptyBottlesCount: 2,
  status: 'ACTIVE',
  updatedAt: new Date('2026-09-24T08:00:00.000Z'),
  shopPhotoId: i % 2 ? 'att' : null,
  signboardPhotoId: null,
  region: { name: 'Muscat', code: 'MCT' },
  route: { code: 'C4' },
  customer: {
    nmwcCode: `NMWC-${i}`,
    legalName: `=Shop ${i}`,
    paymentTerms: 'CASH',
    crNumber: null,
    crPhotoId: null,
    primaryPhone: '+96895551234',
    altPhone: null,
    contactPerson: null,
    contactRole: null,
    status: 'ACTIVE',
    completenessScore: 70,
    channel: { label: 'Retail' },
    subChannel: null,
  },
});

/** findMany behaving like Prisma's keyset paging over h.rows. */
function servePages() {
  h.findMany.mockImplementation(async (args: { take: number; cursor?: { branchCode: string }; skip?: number }) => {
    const from = args.cursor ? h.rows.findIndex((r) => r.branchCode === args.cursor!.branchCode) + (args.skip ?? 0) : 0;
    return h.rows.slice(from, from + args.take);
  });
}

beforeEach(() => {
  h.user = { id: 'u1', role: 'STEWARD', username: 'steward.x' };
  h.teamRoutes = [];
  h.managedRegions = [];
  h.findMany.mockReset();
  h.count_.mockReset();
  h.writeAudit.mockReset();
  h.rows = [];
  servePages();
});

describe('customerMasterRows — a page at a time', () => {
  it('pages by branch code, passes the scope through, and maps every column', async () => {
    h.rows = [1, 2, 3, 4, 5].map(branch);
    const where = { deletedAt: null, regionId: { in: ['r1'] } };
    const out: Array<Record<string, unknown>> = [];
    for await (const r of customerMasterRows(where, 2)) out.push(r);

    expect(out.map((r) => r.branch_code)).toEqual(h.rows.map((r) => r.branchCode));
    const calls = h.findMany.mock.calls.map((c) => c[0]);
    expect(calls.map((a) => a.cursor?.branchCode)).toEqual([undefined, 'B-00002', 'B-00004']);
    for (const a of calls) {
      expect(a.where).toBe(where);
      expect(a.take).toBe(2);
      expect(a.orderBy).toEqual([{ regionId: 'asc' }, { branchCode: 'asc' }]);
    }
    expect(Object.keys(out[0]!).sort()).toEqual([...CUSTOMER_MASTER_COLUMNS].sort());
    expect(out[0]).toMatchObject({ cust_code: 'NMWC-1', sales_region: 'Muscat', region_code: 'MCT', shop_photo: 'yes', phone: '+96895551234' });
  });
});

describe('buildCustomerExport', () => {
  it('builds past the old 25,000-row cap and audits the exact row count', async () => {
    h.rows = Array.from({ length: 25_100 }, (_, i) => branch(i));
    h.count_.mockResolvedValue(h.rows.length);
    const out = await buildCustomerExport({});
    expect(out.rowCount).toBe(25_100);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0]![2]).toMatchObject({ action: 'EXPORT', reason: 'customers 25100' });
    const [sheet] = await parseWorkbook(out.bytes);
    expect(sheet!.headers).toEqual([...CUSTOMER_MASTER_COLUMNS]);
    expect(sheet!.rows).toHaveLength(25_100);
    // Still formula-escaped.
    expect(sheet!.rows[0]!.cust_name).toBe(`'=Shop 0`);
  }, 60_000);

  it('refuses above the measured ceiling BEFORE reading a row or writing an audit row', async () => {
    h.count_.mockResolvedValue(60_001);
    await expect(buildCustomerExport({})).rejects.toThrow(/60,000 rows/);
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('F-01: a Supervisor filtering outside their team gets nothing, not the route asked for', async () => {
    h.user = { id: 's1', role: 'SUPERVISOR', username: 'sup' };
    h.teamRoutes = ['route-team'];
    h.count_.mockResolvedValue(0);
    await buildCustomerExport({ routeIds: ['route-other'] });
    expect(h.count_.mock.calls[0]![0].where.routeId).toEqual({ in: ['__none__'] });
  });

  it('F-01: fail-closed for a Manager with no regions and a Supervisor with no team', async () => {
    h.user = { id: 'm1', role: 'MANAGER', username: 'mgr' };
    h.count_.mockResolvedValue(0);
    await buildCustomerExport({});
    expect(h.count_.mock.calls[0]![0].where.regionId).toEqual({ in: ['__none__'] });
    h.user = { id: 's1', role: 'SUPERVISOR', username: 'sup' };
    await buildCustomerExport({});
    expect(h.count_.mock.calls[1]![0].where.routeId).toEqual({ in: ['__none__'] });
  });

  it('refuses a role that cannot export', async () => {
    h.user = { id: 'x', role: 'SALESMAN', username: 'c4' };
    await expect(buildCustomerExport({})).rejects.toThrow(/cannot export/);
  });
});
