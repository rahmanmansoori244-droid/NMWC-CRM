// @vitest-environment node
/**
 * The customer master export (services/exports.ts + lib/customer-master-rows.ts),
 * benchmark item 28: no longer capped at 25,000 rows. Until now NOTHING exercised
 * this export's behaviour — so besides the new paging and ceiling, its role scope
 * (F-01: intersected with the user's filters, fail-closed) is pinned here too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { matchesWhere } from '../support/where-eval';

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
  regionId: 'r1',
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

/** The value predicate the export adds for every page after the first, or undefined. */
const afterOf = (where: { AND?: unknown[] }) => where.AND?.[1] as Record<string, unknown> | undefined;

/**
 * findMany behaving like the page query: the page predicate evaluated as written,
 * in (region, code) order. A predicate that never ends is stopped, not left to hang.
 */
function servePages() {
  h.findMany.mockImplementation(async (args: { take: number; where: { AND?: unknown[] } }) => {
    if (h.findMany.mock.calls.length > 1_000) throw new Error('paging never ended');
    const after = afterOf(args.where);
    return h.rows
      .filter((r) => r.live !== false)
      .filter((r) => !after || matchesWhere(r, after))
      .sort((x, y) => (`${x.regionId}|${x.branchCode}` < `${y.regionId}|${y.branchCode}` ? -1 : 1))
      .slice(0, args.take)
      .map((r) => ({ ...r }));
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
    // The first page is the scope as given; every later one is the scope AND "after
    // the last row read", by value — no Prisma cursor, no offset.
    expect(calls[0].where).toBe(where);
    expect(calls.slice(1).map((a) => a.where.AND[0])).toEqual([where, where]);
    // After (r1, B-00002): a later region, or the SAME region and a later code. The
    // second arm without its region loops forever once codes interleave across regions.
    expect(calls.slice(1).map((a) => afterOf(a.where))).toEqual(
      ['B-00002', 'B-00004'].map((code) => ({
        OR: [{ regionId: { gt: 'r1' } }, { regionId: 'r1', branchCode: { gt: code } }],
      }))
    );
    for (const a of calls) {
      expect(a.cursor).toBeUndefined();
      expect(a.skip).toBeUndefined();
      expect(a.take).toBe(2);
      expect(a.orderBy).toEqual([{ regionId: 'asc' }, { branchCode: 'asc' }]);
    }
    // Every one of the 33 columns, from the field it should come from.
    expect(out[0]).toEqual({
      cust_code: 'NMWC-1',
      cust_name: '=Shop 1',
      payment_terms: 'CASH',
      cr_no: '',
      cr_photo: '',
      branch_code: 'B-00001',
      branch_name: 'Branch 1',
      sales_region: 'Muscat',
      region_code: 'MCT',
      route: 'C4',
      address: 'Way 1',
      area_description: '',
      phone: '+96895551234',
      alt_phone: '',
      contact_person: '',
      contact_role: '',
      channel: 'Retail',
      sub_channel: '',
      day_of_visit: 'SUN',
      opening_hours: '',
      delivery_window: '',
      gps_lat: 23.5,
      gps_lng: 58.3,
      gps_captured_at: '2026-09-24T08:00:00.000Z',
      coolers: 1,
      stands: 0,
      empty_bottles: 2,
      shop_photo: 'yes',
      signboard_photo: '',
      customer_status: 'ACTIVE',
      branch_status: 'ACTIVE',
      completeness_pct: 70,
      last_edited_at: '2026-09-24T08:00:00.000Z',
    });
  });

  it('reads every row once when branch codes interleave across regions, as ERP numbers do', async () => {
    const codes: Record<string, number[]> = { r1: [3, 6, 9], r2: [1, 4, 7, 10] };
    h.rows = Object.entries(codes).flatMap(([regionId, ns]) => ns.map((i) => ({ ...branch(i), regionId })));
    const out: string[] = [];
    for await (const r of customerMasterRows({}, 2)) out.push(String(r.branch_code));
    const expected = ['B-00003', 'B-00006', 'B-00009', 'B-00001', 'B-00004', 'B-00007', 'B-00010'];
    expect(out).toEqual(expected);
  });

  it("a page's last row archived before the next page costs only itself", async () => {
    h.rows = [1, 2, 3, 4, 5].map(branch) as Array<Record<string, unknown>>;
    const out: string[] = [];
    for await (const r of customerMasterRows({}, 2)) {
      out.push(String(r.branch_code));
      if (r.branch_code === 'B-00002') h.rows[1]!.live = false; // archived mid-export
    }
    expect(out).toEqual(['B-00001', 'B-00002', 'B-00003', 'B-00004', 'B-00005']);
  });

  it('a page\'s last row moved to a later region does not skip the regions in between', async () => {
    h.rows = [1, 2, 3, 4, 5].map((i) => ({ ...branch(i), regionId: i <= 2 ? 'r1' : 'r2' })) as Array<Record<string, unknown>>;
    const out: string[] = [];
    for await (const r of customerMasterRows({}, 2)) {
      out.push(String(r.branch_code));
      if (r.branch_code === 'B-00002') h.rows[1]!.regionId = 'r9'; // re-regioned by an import
    }
    for (const code of ['B-00001', 'B-00003', 'B-00004', 'B-00005']) expect(out, code).toContain(code);
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

  it('builds at exactly the ceiling', async () => {
    h.count_.mockResolvedValue(60_000);
    const out = await buildCustomerExport({});
    expect(out.rowCount).toBe(0);
    expect(h.findMany).toHaveBeenCalled();
  });

  it('a database failure mid-way is an error with NO ledger row, never a partial file', async () => {
    h.rows = Array.from({ length: 5_000 }, (_, i) => branch(i));
    h.count_.mockResolvedValue(h.rows.length);
    let n = 0;
    h.findMany.mockImplementation(async (args: { take: number }) => {
      if (++n === 2) throw new Error('connection reset');
      return h.rows.slice(0, args.take);
    });
    await expect(buildCustomerExport({})).rejects.toThrow('connection reset');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

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
    // The rows are read with exactly the scope that was counted.
    expect(h.findMany.mock.calls[0]![0].where).toBe(h.count_.mock.calls[0]![0].where);
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

  it('builds through the streaming writer, not the in-memory one the ceiling was measured without', () => {
    const src = stripComments(readFileSync('services/exports.ts', 'utf8'), 'services/exports.ts');
    expect(src).toMatch(/buildWorkbookStreamed\(/);
    expect(src).not.toMatch(/\bbuildWorkbook\(/);
  });

  it('refuses a role that cannot export', async () => {
    h.user = { id: 'x', role: 'SALESMAN', username: 'c4' };
    await expect(buildCustomerExport({})).rejects.toThrow(/cannot export/);
  });
});
