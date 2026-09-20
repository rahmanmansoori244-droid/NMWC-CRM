// @vitest-environment node
/**
 * GO-LIVE REHEARSAL — loads the REAL go-live master files (built by
 * scripts/golive/build-masters.ts into golive-data/) through the real import
 * actions against the isolated UAT branch, exactly as the Steward will on
 * go-live day, and writes a reconciliation the owner can read.
 *
 * What it proves: the account master applies cleanly; the customer master
 * stages with a known quarantine picture; promotion works on the real data and
 * the counters reconcile. Promotion is TIME-BOXED (REHEARSAL_PROMOTE_MINUTES,
 * default 20): from this machine every customer costs seconds of WAN latency,
 * whereas production runs co-located with the database. The chunked/resumable
 * promote was already proven end-to-end at scale (RK-3), so the sample here is
 * about DATA, not throughput.
 *
 * Run AFTER clearing the UAT branch so the rehearsal starts from empty:
 *   node scripts/qa/run-with-env.mjs tsx prisma/synthetic.ts --clear-only
 *   RUN_GOLIVE_REHEARSAL=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/golive-rehearsal.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

vi.setConfig({ testTimeout: 3_600_000, hookTimeout: 300_000 });
const DIR = path.resolve(process.env.GOLIVE_DIR ?? 'golive-data');
const ENABLED =
  process.env.RUN_GOLIVE_REHEARSAL === '1' &&
  !!process.env.DATABASE_URL &&
  existsSync(path.join(DIR, 'managers.json'));

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe.skipIf(!ENABLED)('GO-LIVE REHEARSAL on the UAT branch with the real master files', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const report: string[] = [];
  const say = (s: string) => {
    console.log(s);
    report.push(s);
  };
  let stewardId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze'))
      throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    const cfg = JSON.parse(readFileSync(path.join(DIR, 'managers.json'), 'utf8')) as {
      steward: { username: string; fullName: string; password: string };
      managers: Array<{ username: string; fullName: string; regions: string[]; password: string }>;
    };
    // Step 1 of the SOP: the Steward and the Managers are created IN THE APP, never by
    // import. The rehearsal does what the Users screen does.
    const steward = await prisma.user.upsert({
      where: { username: cfg.steward.username },
      update: {},
      create: {
        username: cfg.steward.username,
        fullName: cfg.steward.fullName,
        role: 'STEWARD',
        passwordHash: await bcrypt.hash(cfg.steward.password, 12),
        mustChangePassword: true,
      },
    });
    stewardId = steward.id;
    for (const m of cfg.managers) {
      await prisma.user.upsert({
        where: { username: m.username },
        update: {},
        create: {
          username: m.username,
          fullName: m.fullName,
          role: 'MANAGER',
          passwordHash: await bcrypt.hash(m.password, 12),
          mustChangePassword: true,
        },
      });
    }
    say(`Provisioned in-app: steward + ${cfg.managers.length} managers`);
    current = { id: stewardId, role: 'STEWARD', username: cfg.steward.username };
  });

  afterAll(async () => {
    writeFileSync(
      path.join(DIR, 'REHEARSAL-RESULT.md'),
      `# Go-live rehearsal — ${new Date().toISOString()}\n\n` +
        report.map((l) => `- ${l}`).join('\n') +
        '\n',
      'utf8'
    );
    if (prisma) await prisma.$disconnect();
  });

  it('account master applies: regions, routes, supervisors, salesmen, manager regions', async () => {
    const buf = readFileSync(path.join(DIR, 'account-master.xlsx'));
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(buf)], 'account-master.xlsx', { type: XLSX_MIME }));
    const t0 = Date.now();
    const res = await imports.uploadAccountMasterAction(fd);
    if (!res.ok) console.error(JSON.stringify(res));
    expect(res.ok).toBe(true);
    const data = (res as { ok: true; data: { batchId: string; clean: number; issues: number } })
      .data;
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: data.batchId } });
    const rows = await prisma.importRow.findMany({
      where: { batchId: data.batchId },
      select: { issues: true, rowNumber: true },
    });
    const issues = rows.flatMap(
      (r) => (r.issues as { sheet: string; row: number; message: string }[] | null) ?? []
    );
    say(
      `ACCOUNT MASTER: clean=${data.clean} issues=${data.issues} in ${Math.round((Date.now() - t0) / 1000)}s (batch ${batch.status})`
    );
    for (const i of issues.slice(0, 40)) say(`  issue: ${i.sheet} row ${i.row}: ${i.message}`);
    const [regions, routes, users] = await Promise.all([
      prisma.region.count(),
      prisma.route.count(),
      prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    ]);
    say(
      `  now in DB: regions=${regions} routes=${routes} users=${users.map((u) => `${u.role}:${u._count._all}`).join(' ')}`
    );
    const mgrs = await prisma.user.findMany({
      where: { role: 'MANAGER' },
      select: { username: true, managedRegions: { select: { code: true } } },
    });
    say(
      `  manager regions: ${mgrs.map((m) => `${m.username}→${m.managedRegions.map((r) => r.code).join('/') || 'NONE'}`).join(' ; ')}`
    );
    // A say() above is not a check — assert it. An empty managedRegions is
    // fail-closed for both region-scoped roles (lib/access.ts, lib/permissions.ts,
    // lib/customer-filters.ts), so a blind account signs in normally and sees an
    // empty queue for good. That is the failure this rehearsal exists to catch,
    // and it printed the evidence without ever looking at it.
    const blindManagers = mgrs.filter((m) => m.managedRegions.length === 0);
    expect(
      blindManagers.map((m) => m.username),
      'no region-scoped account may land blind'
    ).toEqual([]);

    // One ACCOUNTANT per region (owner decision 2026-09-20). The CASH and CREDIT
    // chains both end at the accountant managing the request region, so a region
    // without one strands every new customer submitted there.
    const accountants = await prisma.user.findMany({
      where: { role: 'ACCOUNTANT' },
      select: { username: true, managedRegions: { select: { code: true } } },
    });
    say(
      `  accountant regions: ${accountants.map((a) => `${a.username}→${a.managedRegions.map((r) => r.code).join('/') || 'NONE'}`).join(' ; ')}`
    );
    expect(
      accountants.filter((a) => a.managedRegions.length === 0).map((a) => a.username),
      'an accountant with no region can clear no approval step'
    ).toEqual([]);

    const realRegions = await prisma.region.findMany({
      where: { code: { not: 'UNASSIGNED' } },
      select: { code: true },
    });
    const covered = new Set(accountants.flatMap((a) => a.managedRegions.map((r) => r.code)));
    expect(
      realRegions.map((r) => r.code).filter((c) => !covered.has(c)),
      'every region needs an accountant'
    ).toEqual([]);
    expect(accountants).toHaveLength(realRegions.length);
    for (const a of accountants) {
      expect(a.managedRegions, `${a.username} should cover exactly one region`).toHaveLength(1);
      expect(a.username).toBe(`accountant.${a.managedRegions[0]!.code.toLowerCase()}`);
    }

    const orphanSalesmen = await prisma.user.count({
      where: { role: 'SALESMAN', supervisorId: null },
    });
    say(`  salesmen without supervisor: ${orphanSalesmen}`);
    // Credential policy: login = route code, and the initial password works once.
    const sm = await prisma.user.findMany({
      where: { role: 'SALESMAN' },
      select: { username: true, mustChangePassword: true, ownedRoute: { select: { code: true } } },
    });
    const wrongLogin = sm.filter((u) => u.username !== (u.ownedRoute?.code ?? '').toLowerCase());
    say(
      `  salesman login = route code: ${sm.length - wrongLogin.length}/${sm.length}; forced password change: ${sm.filter((u) => u.mustChangePassword).length}/${sm.length}`
    );
    expect(wrongLogin.length).toBe(0);
    expect(sm.every((u) => u.mustChangePassword)).toBe(true);
    expect(regions).toBeGreaterThanOrEqual(7);
    expect(orphanSalesmen).toBe(0);
  });

  it('customer master stages with a reviewable quarantine picture', async () => {
    const buf = readFileSync(path.join(DIR, 'customer-master.xlsx'));
    say(`customer-master.xlsx is ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(buf)], 'customer-master.xlsx', { type: XLSX_MIME }));
    const t0 = Date.now();
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error(JSON.stringify(res));
    expect(res.ok).toBe(true);
    const data = (
      res as { ok: true; data: { batchId: string; clean: number; quarantined: number } }
    ).data;
    say(
      `CUSTOMER MASTER staged: clean=${data.clean} quarantined=${data.quarantined} in ${Math.round((Date.now() - t0) / 1000)}s (batch ${data.batchId})`
    );
    const q = await prisma.importRow.findMany({
      where: { batchId: data.batchId, state: 'QUARANTINED' },
      select: { rowNumber: true, issues: true, parsed: true },
    });
    const byField = new Map<string, number>();
    for (const r of q)
      for (const i of (r.issues as { field: string; message: string }[] | null) ?? [])
        byField.set(
          `${i.field}: ${i.message.replace(/\d+/g, 'N').slice(0, 60)}`,
          (byField.get(`${i.field}: ${i.message.replace(/\d+/g, 'N').slice(0, 60)}`) ?? 0) + 1
        );
    say(
      `  quarantine reasons: ${[...byField]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v}× ${k}`)
        .join(' | ')}`
    );
    writeFileSync(
      path.join(DIR, 'dq', 'rehearsal-quarantined-rows.csv'),
      'row,cust_code,issues\n' +
        q
          .map(
            (r) =>
              `${r.rowNumber},${(r.parsed as { custCode?: string })?.custCode ?? ''},"${JSON.stringify(r.issues).replace(/"/g, '""')}"`
          )
          .join('\n') +
        '\n',
      'utf8'
    );
    process.env.REHEARSAL_BATCH_ID = data.batchId;
  });

  it('promotion runs on the real data (time-boxed) and the counters reconcile', async () => {
    const batchId = process.env.REHEARSAL_BATCH_ID!;
    const minutes = Number(process.env.REHEARSAL_PROMOTE_MINUTES ?? 20);
    const deadline = Date.now() + minutes * 60_000;
    let token = '';
    let slices = 0;
    let promoted = 0;
    let failed = 0;
    let deferred = 0;
    let lastRemaining = Number.POSITIVE_INFINITY;
    let done = false;
    const t0 = Date.now();
    while (Date.now() < deadline) {
      const fd = new FormData();
      fd.set('batchId', batchId);
      if (token) fd.set('leaseToken', token);
      const res = await imports.promoteCustomerBatchAction(fd);
      if (!res.ok) {
        say(`  promote refused: ${JSON.stringify(res).slice(0, 200)}`);
        break;
      }
      slices++;
      promoted += res.data.promoted;
      failed += res.data.failed;
      deferred += res.data.deferred;
      if (res.data.done) {
        done = true;
        break;
      }
      if (res.data.remaining >= lastRemaining) {
        say(`  STALLED with ${res.data.remaining} remaining`);
        break;
      }
      lastRemaining = res.data.remaining;
      token = res.data.leaseToken ?? '';
      if (!token) break;
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const counts = await prisma.importRow.groupBy({
      by: ['state'],
      where: { batchId },
      _count: { _all: true },
    });
    const c = Object.fromEntries(counts.map((x) => [x.state, x._count._all]));
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    say(
      `PROMOTE (${minutes} min box): ${slices} slices, ${promoted} rows promoted, ${failed} customers failed, ${deferred} deferred, done=${done}, ${secs}s → ${(promoted / Math.max(secs, 1)).toFixed(2)} rows/s over WAN`
    );
    say(
      `  rows now: ${JSON.stringify(c)} | batch: status=${batch.status} promotedRows=${batch.promotedRows} rejectedRows=${batch.rejectedRows}`
    );
    const rejected = await prisma.importRow.findMany({
      where: { batchId, state: 'REJECTED' },
      select: { rowNumber: true, issues: true, parsed: true },
      take: 500,
    });
    const reasons = new Map<string, number>();
    for (const r of rejected)
      for (const i of (r.issues as { message: string }[] | null) ?? [])
        reasons.set(
          i.message.replace(/[A-Z0-9-]{6,}/g, 'X').slice(0, 80),
          (reasons.get(i.message.replace(/[A-Z0-9-]{6,}/g, 'X').slice(0, 80)) ?? 0) + 1
        );
    say(
      `  rejection reasons: ${
        [...reasons]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${v}× ${k}`)
          .join(' | ') || 'none'
      }`
    );
    writeFileSync(
      path.join(DIR, 'dq', 'rehearsal-rejected-rows.csv'),
      'row,cust_code,issues\n' +
        rejected
          .map(
            (r) =>
              `${r.rowNumber},${(r.parsed as { custCode?: string })?.custCode ?? ''},"${JSON.stringify(r.issues).replace(/"/g, '""')}"`
          )
          .join('\n') +
        '\n',
      'utf8'
    );
    // The SOP §8.4 reconciliation identity.
    expect((c.PROMOTED ?? 0) + (c.REJECTED ?? 0) + (c.QUARANTINED ?? 0) + (c.CLEAN ?? 0)).toBe(
      batch.totalRows
    );
    expect(batch.promotedRows).toBe(c.PROMOTED ?? 0);
    // Spot-check what landed.
    const sample = await prisma.customer.findMany({
      take: 5,
      orderBy: { nmwcCode: 'asc' },
      include: {
        branches: {
          select: {
            branchCode: true,
            dayOfVisit: true,
            status: true,
            route: { select: { code: true } },
            region: { select: { code: true } },
          },
        },
        channel: { select: { key: true } },
      },
    });
    for (const s of sample)
      say(
        `  e.g. ${s.nmwcCode} "${s.legalName}" ${s.paymentTerms} ${s.status} ch=${s.channel?.key ?? '-'} temix=${s.temixCode} → ${s.branches.map((b) => `${b.branchCode}@${b.route.code}/${b.region.code} ${b.dayOfVisit ?? '-'} ${b.status}`).join(', ')}`
      );
    const withDay = await prisma.branch.count({ where: { dayOfVisit: { not: null } } });
    const closed = await prisma.branch.count({ where: { status: 'CLOSED' } });
    say(`  branches with a visit day: ${withDay} · closed branches: ${closed}`);
    expect(promoted).toBeGreaterThan(0);
  });
});
