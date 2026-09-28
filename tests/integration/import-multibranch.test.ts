// @vitest-environment node
/**
 * IMP-MULTIBRANCH (F-UAT-7) — a legitimate MULTI-BRANCH customer repeats the
 * SAME phone + CR on each of its branch rows (that is exactly how promote groups
 * branch rows by cust_code into one customer). The in-file duplicate-phone / CR
 * check must therefore key on cust_code and NOT quarantine a customer against
 * ITSELF — while STILL quarantining a genuine cross-customer collision (two
 * different cust_codes sharing a phone/CR).
 *
 * Before the fix, the medium synthetic master quarantined 324/499 rows: every
 * multi-branch customer was flagged "duplicate phone/CR in this file" against
 * its own branches. This test reproduces that in the small and pins the fix.
 *
 * Also, through upload AND promote, the import half of the auditor recheck of
 * 2026-09-27 (tests/unit/customer-import-service.test.ts proves each on a fake):
 *   - F21: a branch the load creates is scored (it stayed at 0: only the
 *     customer was rescored), and a re-import bumps version and moves updatedAt
 *     only on the branch it changes, while a stale score on a branch it does not
 *     change is fixed without touching either (lib/rescore.ts, raw SQL);
 *   - F16 (owner decision 1): a row that moves the customer to another channel
 *     clears a sub-channel of the old one and says so on the lead row; a
 *     sub-channel of the new channel, or any sub-channel when the channel does
 *     not change, is kept.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-multibranch.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';
import { promoteFully } from '../support/promote';
import { scoreBranch, scoreCustomer } from '@/lib/completeness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = [
  'cust_code', 'cust_name', 'branch_code', 'sales_region', 'region_code', 'route',
  'address', 'phone', 'alt_phone', 'contact_person', 'contact_role', 'cr_no',
  'payment_terms', 'credit_limit', 'payment_term_days', 'temix_code', 'channel',
  'sub_channel', 'day_of_visit', 'coolers', 'stands', 'empty_bottles',
  'gps_lat', 'gps_lng', 'customer_status', 'temix_sync_state',
] as const;

function row(over: Record<string, string | number>) {
  return {
    cust_code: '', cust_name: 'ZZ-SYN MB Co', branch_code: '', sales_region: 'Muscat',
    region_code: 'MCT', route: 'MCT-R01', address: 'Way 1, Muscat', phone: '', alt_phone: '',
    contact_person: 'ZZ-SYN C', contact_role: 'Owner', cr_no: '', payment_terms: 'CASH',
    credit_limit: '', payment_term_days: '', temix_code: '', channel: 'HORECA',
    sub_channel: 'Restaurants', day_of_visit: 'MON', coolers: 0, stands: 0, empty_bottles: 0,
    gps_lat: 23.6, gps_lng: 58.4, customer_status: 'ACTIVE', temix_sync_state: 'SYNCED', ...over,
  } as Record<string, string | number>;
}

async function buildXlsx(rows: Array<Record<string, string | number>>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(HEADERS as unknown as string[]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!ENABLED)('F-UAT-7: multi-branch customer must not self-quarantine on phone/CR', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const stewardId = 'ZZ-MB-' + randomUUID().slice(0, 8);
  const tag = randomUUID().slice(0, 6).toUpperCase();
  // unique per-run values so reruns never collide with residual master rows
  const sharedPhone = `+96890${String(700000 + (parseInt(tag, 36) % 90000)).slice(0, 6)}`;
  const sharedCr = String(9_800_000 + (parseInt(tag, 36) % 90000));
  const codeA = `ZZMB-A-${tag}`;
  const codeB = `ZZMB-B-${tag}`;
  const codeC = `ZZMB-C-${tag}`;
  let batchId: string;
  const extraBatchIds: string[] = [];

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await prisma.user.create({ data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ MB Steward', role: 'STEWARD' } });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    const allBatches = [batchId, ...extraBatchIds].filter(Boolean);
    if (allBatches.length) {
      await prisma.importRow.deleteMany({ where: { batchId: { in: allBatches } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: allBatches } } });
    }
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('keeps a 3-branch customer CLEAN while still quarantining a cross-customer collision', async () => {
    const rows = [
      // Customer A: 3 branches, SAME phone + CR across all three (legitimate).
      row({ cust_code: codeA, branch_code: `${codeA}-01`, phone: sharedPhone, cr_no: sharedCr }),
      row({ cust_code: codeA, branch_code: `${codeA}-02`, phone: sharedPhone, cr_no: sharedCr, address: 'Way 2, Muscat' }),
      row({ cust_code: codeA, branch_code: `${codeA}-03`, phone: sharedPhone, cr_no: sharedCr, address: 'Way 3, Muscat' }),
      // Customer B + C: DIFFERENT cust_codes but the SAME phone AND cr — a real
      // cross-customer collision that MUST still be quarantined on BOTH rows.
      row({ cust_code: codeB, branch_code: `${codeB}-01`, phone: `+96890111${tag.slice(0, 3)}`, cr_no: `${sharedCr}9` }),
      row({ cust_code: codeC, branch_code: `${codeC}-01`, phone: `+96890111${tag.slice(0, 3)}`, cr_no: `${sharedCr}9` }),
    ];
    const buf = await buildXlsx(rows);
    const fd = new FormData();
    fd.set('file', new File([buf], 'mb-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error('UPLOAD FAILED:', JSON.stringify(res));
    expect(res.ok).toBe(true);
    batchId = (res as { ok: true; data: { batchId: string } }).data.batchId;

    const staged = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    const fieldsOf = (n: number) =>
      ((staged.find((r) => r.rowNumber === n)!.issues as { field: string }[] | null) ?? []).map((i) => i.field);
    const stateOf = (n: number) => staged.find((r) => r.rowNumber === n)!.state;

    // rowNumber = sheet row = data index + 2 (header on row 1)
    // Customer A's three branch rows (sheet rows 2,3,4): all CLEAN — must NOT be
    // flagged for phone/CR dup against their own siblings.
    for (const n of [2, 3, 4]) {
      expect(fieldsOf(n)).not.toContain('phone');
      expect(fieldsOf(n)).not.toContain('cr_no');
      expect(stateOf(n)).toBe('CLEAN');
    }
    // Customer B and C (sheet rows 5,6): cross-customer phone+CR collision — both
    // QUARANTINED, and the phone/cr issues still name the OTHER row.
    for (const n of [5, 6]) {
      expect(stateOf(n)).toBe('QUARANTINED');
      expect(fieldsOf(n)).toContain('phone');
      expect(fieldsOf(n)).toContain('cr_no');
    }
  });

  // Scaled confirmation: the medium synthetic master (300 customers, ~40%
  // multi-branch, manifest = all-ACCEPTED) once lost 324/499 rows to bogus
  // in-file phone/CR dup quarantines. After the fix, ZERO rows may carry an
  // "in this file" phone/CR issue. (Rows may still be flagged for master-level
  // collisions if the synthetic band pre-exists on the branch — those are
  // legitimate and counted separately.)
  it('scaled: the full medium master produces ZERO in-file phone/CR dup quarantines', async () => {
    const fixture = path.join('qa', 'fixtures', 'medium-424242', 'master.xlsx');
    if (!existsSync(fixture)) {
      console.warn('medium fixture absent — run: npx tsx scripts/qa/generate-synthetic-master.ts --scale=medium --seed=424242');
      return;
    }
    const fd = new FormData();
    fd.set('file', new File([readFileSync(fixture)], 'medium-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error('UPLOAD FAILED:', JSON.stringify(res));
    expect(res.ok).toBe(true);
    const bId = (res as { ok: true; data: { batchId: string } }).data.batchId;
    extraBatchIds.push(bId);

    const staged = await prisma.importRow.findMany({ where: { batchId: bId }, select: { state: true, issues: true } });
    expect(staged.length).toBe(499);
    let inFileDup = 0, masterDup = 0;
    for (const r of staged) {
      const issues = (r.issues as { field: string; message: string }[] | null) ?? [];
      for (const iss of issues) {
        if ((iss.field === 'phone' || iss.field === 'cr_no') && /in this file/.test(iss.message)) inFileDup++;
        if ((iss.field === 'phone' || iss.field === 'cr_no') && /already exists in master/.test(iss.message)) masterDup++;
      }
    }
    const quarantined = staged.filter((r) => r.state === 'QUARANTINED').length;
    console.log(`\n=== MEDIUM MASTER (fixed importer) === rows=${staged.length} quarantined=${quarantined} inFileDupIssues=${inFileDup} masterDupIssues=${masterDup}`);
    // The fix's contract: no legitimate multi-branch customer is flagged against
    // its own branches. Pre-fix this was ~324.
    expect(inFileDup).toBe(0);
  });
});

describe.skipIf(!ENABLED)('F21 / F16: what the promote writes on a multi-branch customer', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const code = `ZZMBS-${tag}`;
  const REGION = `ZZMBS${tag}R`;
  const ROUTE = `ZZMBS${tag}-RT`;
  const stewardId = `ZZ-MBS-${tag}`;
  const batchIds: string[] = [];
  let regionId = '';
  let routeId = '';
  const horeca = { id: '', subId: '' };
  const general = { id: '', subId: '' };

  const at = (over: Record<string, string | number>) =>
    row({ cust_code: code, sales_region: REGION, route: ROUTE, channel: 'HORECA', ...over });
  const two = (over: Record<string, string | number> = {}) => [
    at({ branch_code: `${code}-01`, address: 'Way 1, Muscat', ...over }),
    at({ branch_code: `${code}-02`, address: 'Way 2, Muscat', ...over }),
  ];
  /** Upload and promote; every row must land. */
  const load = async (rows: Array<Record<string, string | number>>) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
    const fd = new FormData();
    fd.set(
      'file',
      new File([await buildXlsx(rows)], `${code}.xlsx`, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const id = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batchIds.push(id);
    expect(await promoteFully(imports, id)).toMatchObject({ promoted: rows.length, failed: 0 });
    return id;
  };
  const SCORED = {
    gpsLat: true,
    gpsLng: true,
    address: true,
    shopPhotoId: true,
    signboardPhotoId: true,
    dayOfVisit: true,
    coolersCount: true,
    standsCount: true,
    emptyBottlesCount: true,
    equipmentConfirmed: true,
    openingHours: true,
    deliveryWindow: true,
    status: true,
  } as const;
  const branchesOf = () =>
    prisma.branch.findMany({
      where: { customer: { nmwcCode: code }, deletedAt: null },
      orderBy: { branchCode: 'asc' },
      select: { id: true, completenessScore: true, version: true, updatedAt: true, ...SCORED },
    });
  const customerOf = () =>
    prisma.customer.findUniqueOrThrow({
      where: { nmwcCode: code },
      select: {
        completenessScore: true,
        channelId: true,
        subChannelId: true,
        primaryPhone: true,
        contactPerson: true,
        crNumber: true,
        crPhotoId: true,
        paymentTerms: true,
        notes: true,
      },
    });
  const laneNotes = async (batchId: string) =>
    (await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' }, select: { issues: true } })).map(
      (r) => ((r.issues as Array<{ field: string; message: string }> | null) ?? []).filter((i) => i.field === '_lane')
    );

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    regionId = (await prisma.region.create({ data: { code: REGION, name: `ZZ MBS ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: ROUTE, name: `ZZ MBS ${tag}`, regionId } })).id;
    await prisma.user.create({
      data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ MBS Steward', role: 'STEWARD' },
    });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
    // The seed's channels, which the import maps its channel cell to.
    for (const [key, into] of [
      ['HORECA', horeca],
      ['GENERAL_TRADE', general],
    ] as const) {
      const ch = await prisma.channel.findUniqueOrThrow({
        where: { key },
        include: { subChannels: { where: { isActive: true }, take: 1 } },
      });
      into.id = ch.id;
      into.subId = ch.subChannels[0]!.id;
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: code }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: stewardId } });
      await prisma.notification.deleteMany({ where: { userId: stewardId } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: stewardId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('F21: a first load scores every branch it creates, and the customer from them', async () => {
    await load(two());
    const bs = await branchesOf();
    expect(bs).toHaveLength(2);
    for (const b of bs) {
      expect(b.completenessScore).toBeGreaterThan(0);
      expect(b.completenessScore).toBe(scoreBranch(b));
    }
    const c = await customerOf();
    expect(c.completenessScore).toBe(scoreCustomer(c, bs));
  });

  it('F21: a re-import bumps only the branch it changes; a stale score elsewhere is fixed without touching that row', async () => {
    const [b1, b2] = await branchesOf();
    // A stale score as the go-live load left one, written behind Prisma's back
    // so that updatedAt stays put.
    await prisma.$executeRaw`UPDATE "Branch" SET "completenessScore" = 0 WHERE "id" = ${b2.id}`;

    await load([
      at({ branch_code: `${code}-01`, address: 'Way 1b, Muscat' }),
      at({ branch_code: `${code}-02`, address: 'Way 2, Muscat' }),
    ]);
    const [a1, a2] = await branchesOf();
    expect(a1.address).toBe('Way 1b, Muscat');
    expect(a1.version).toBe(b1.version + 1);
    expect(a1.updatedAt.getTime()).toBeGreaterThan(b1.updatedAt.getTime());
    expect(a1.completenessScore).toBe(scoreBranch(a1));

    expect(a2.version).toBe(b2.version);
    expect(a2.updatedAt.getTime()).toBe(b2.updatedAt.getTime());
    expect(a2.completenessScore).toBe(scoreBranch(a2));
    expect(a2.completenessScore).toBe(b2.completenessScore);
  });

  it('F16: a row moving the customer to another channel clears the old channel sub-channel, and the lead row says so', async () => {
    await prisma.customer.update({ where: { nmwcCode: code }, data: { subChannelId: horeca.subId } });
    const before = await customerOf();
    expect(before.channelId).toBe(horeca.id);

    const batchId = await load(two({ channel: 'GENERAL_TRADE' }));
    const c = await customerOf();
    expect(c.channelId).toBe(general.id);
    expect(c.subChannelId).toBeNull();
    // The clear costs the channel pair's 10 points; the stored score is rescored from it.
    const bs = await branchesOf();
    expect(c.completenessScore).toBe(scoreCustomer(c, bs));
    expect(scoreCustomer({ ...c, channelId: horeca.id, subChannelId: horeca.subId }, bs)).toBe(
      c.completenessScore + 10
    );

    const notes = await laneNotes(batchId);
    expect(notes[0]).toEqual([
      {
        field: '_lane',
        message:
          "the channel in this row (GENERAL_TRADE) replaces the customer's channel, so its sub-channel, which belongs to the old channel, was cleared — pick a sub-channel of the new channel on the customer page",
      },
    ]);
    expect(notes[1]).toEqual([]);
  });

  it('F16: the same channel keeps its sub-channel, and a sub-channel of the new channel is kept', async () => {
    await prisma.customer.update({ where: { nmwcCode: code }, data: { subChannelId: general.subId } });
    const same = await load(two({ channel: 'GENERAL_TRADE' }));
    expect(await customerOf()).toMatchObject({ channelId: general.id, subChannelId: general.subId });
    expect(await laneNotes(same)).toEqual([[], []]);

    // A mismatch already on file (the old import left it): the channel then
    // moves to the channel that sub-channel belongs to.
    await prisma.customer.update({ where: { nmwcCode: code }, data: { subChannelId: horeca.subId } });
    const back = await load(two({ channel: 'HORECA' }));
    expect(await customerOf()).toMatchObject({ channelId: horeca.id, subChannelId: horeca.subId });
    expect(await laneNotes(back)).toEqual([[], []]);
  });
});
