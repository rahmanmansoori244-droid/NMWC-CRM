// @vitest-environment node
/**
 * Duplicate detection against real Postgres (benchmark item 16). The rules are
 * unit-tested in tests/unit/duplicate-pairing.test.ts; what only a database can
 * prove is here: that the detector's queries drop soft-deleted customers and
 * branches, read the stored normalized columns, pick the first live branch by
 * code, and that "Mark distinct" and a merge change what the next scan shows.
 *
 * It rides on RUN_MERGE_TESTS, which CI's db-tests job already sets, instead of
 * a new flag: a flag missing from ci.yml would make this suite skip in silence.
 *
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/duplicate-detection.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog } from '../support/audit';
import { normalizeCR } from '@/lib/cr';
import { normalizePhone } from '@/lib/phone';
import type { DuplicateCandidate } from '@/lib/duplicate-pairing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_MERGE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => current && { user: current } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('duplicate detection against Postgres (item 16)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let dupes: typeof import('@/services/duplicates');
  const tag = randomUUID().slice(0, 8);
  const P = `ZZDUP-${tag}`;
  // Eight digits, unique to this run, so leftovers elsewhere cannot pair with them.
  const digits = String(parseInt(tag.slice(0, 7), 16) % 10_000_000).padStart(7, '0');
  const phone = (n: number) => `9${String((Number(digits) + n) % 10_000_000).padStart(7, '0')}`;

  const users = {
    steward: `${P}-stew`,
    manager: `${P}-mgr`,
    viewer: `${P}-view`,
    sales: `${P}-sales`,
  };
  const r = { r1: '', r2: '', rt1: '', rt2: '' };
  const c: Record<string, string> = {};
  let branchSeq = 0;

  async function mk(
    key: string,
    o: {
      name?: string;
      phone?: string;
      cr?: string;
      deleted?: boolean;
      branches?: Array<{ region: 'r1' | 'r2'; deleted?: boolean; code?: string }>;
    }
  ) {
    const cust = await prisma.customer.create({
      data: {
        nmwcCode: `${P}-${key}`,
        legalName: o.name ?? `ZZ Dup ${key} ${tag}`,
        paymentTerms: 'CASH',
        createdById: users.steward,
        // Stored the way every write path stores them: through the real normalizers.
        primaryPhone: o.phone ?? null,
        primaryPhoneNorm: normalizePhone(o.phone ?? null),
        crNumber: o.cr ?? null,
        crNumberNorm: normalizeCR(o.cr ?? null),
        deletedAt: o.deleted ? new Date() : null,
      },
    });
    for (const b of o.branches ?? [{ region: 'r1' }]) {
      await prisma.branch.create({
        data: {
          customerId: cust.id,
          branchCode: b.code ?? `${P}-${key}-${String(++branchSeq).padStart(3, '0')}`,
          branchName: key,
          address: 'ZZ Way 1',
          regionId: b.region === 'r1' ? r.r1 : r.r2,
          routeId: b.region === 'r1' ? r.rt1 : r.rt2,
          status: 'ACTIVE',
          deletedAt: b.deleted ? new Date() : null,
        },
      });
    }
    c[key] = cust.id;
    return cust.id;
  }

  const ours = () => new Set(Object.values(c));
  /** The scan, reduced to this suite's customers, as sorted "keyA|keyB:REASON" strings. */
  async function scan(): Promise<{ keys: string[]; pairs: DuplicateCandidate[] }> {
    const { pairs } = await dupes.findDuplicateCandidates(1_000_000);
    const mine = ours();
    const byId = new Map(Object.entries(c).map(([k, id]) => [id, k]));
    const hits = pairs.filter((p) => mine.has(p.a.id) || mine.has(p.b.id));
    const keys = hits
      .map((p) => {
        const [x, y] = [byId.get(p.a.id) ?? p.a.id, byId.get(p.b.id) ?? p.b.id].sort();
        return `${x}|${y}:${p.reason}`;
      })
      .sort();
    return { keys, pairs: hits };
  }
  const as = (role: keyof typeof users) => {
    current = { id: users[role], role: role === 'sales' ? 'SALESMAN' : role.toUpperCase(), username: users[role] };
  };
  const fd = (aId: string, bId: string) => {
    const f = new FormData();
    f.set('aId', aId);
    f.set('bId', bId);
    return f;
  };
  const pairRows = () =>
    prisma.auditLog.findMany({
      where: { entityType: 'CustomerPair', actorId: { in: Object.values(users) } },
      select: { action: true, entityId: true, actorId: true, reason: true },
      orderBy: { at: 'asc' },
    });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    dupes = await import('@/services/duplicates');

    r.r1 = (await prisma.region.create({ data: { code: `${P}-R1`, name: `ZZ Dup R1 ${tag}` } })).id;
    r.r2 = (await prisma.region.create({ data: { code: `${P}-R2`, name: `ZZ Dup R2 ${tag}` } })).id;
    r.rt1 = (await prisma.route.create({ data: { code: `${P}-RT1`, name: `ZZ Dup Rt1 ${tag}`, regionId: r.r1 } })).id;
    r.rt2 = (await prisma.route.create({ data: { code: `${P}-RT2`, name: `ZZ Dup Rt2 ${tag}`, regionId: r.r2 } })).id;
    await prisma.user.create({ data: { id: users.steward, username: users.steward, passwordHash: 'x', fullName: 'ZZ Dup Steward', role: 'STEWARD' } });
    await prisma.user.create({ data: { id: users.manager, username: users.manager, passwordHash: 'x', fullName: 'ZZ Dup Manager', role: 'MANAGER' } });
    await prisma.user.create({ data: { id: users.viewer, username: users.viewer, passwordHash: 'x', fullName: 'ZZ Dup Viewer', role: 'VIEWER' } });
    await prisma.user.create({ data: { id: users.sales, username: users.sales, passwordHash: 'x', fullName: 'ZZ Dup Sales', role: 'SALESMAN', ownedRouteId: r.rt1 } });

    const CR1 = `zz ${tag}-1`; // stored as "ZZ<TAG>-1" by the real normalizer
    // CR across regions; a third, soft-deleted customer with the same CR.
    await mk('crA', { cr: CR1, branches: [{ region: 'r1' }, { region: 'r1' }, { region: 'r1', deleted: true }] });
    await mk('crB', { cr: CR1.toUpperCase().replace(' ', ''), branches: [{ region: 'r2' }] });
    await mk('crGone', { cr: CR1, deleted: true });
    // A live customer whose only branch is deleted still pairs on CR.
    await mk('crNoBranch', { cr: `${tag}-2`, branches: [{ region: 'r1', deleted: true }] });
    await mk('crLive', { cr: `${tag}-2` });

    // Name + phone + region, with the raw phone typed two ways (the norm decides).
    await mk('t1', { name: `ZZ Dup Shop ${tag}`, phone: '+968 ' + phone(1) });
    await mk('t2', { name: `  zz dup shop ${tag.toUpperCase()} `, phone: phone(1).replace(/(\d{4})/, '$1 ') });
    // Same name + phone, other region: no pair.
    await mk('t3', { name: `ZZ Dup Shop ${tag}`, phone: phone(1), branches: [{ region: 'r2' }] });
    // No live branch: no triple.
    await mk('t4', { name: `ZZ Dup Shop ${tag}`, phone: phone(1), branches: [{ region: 'r1', deleted: true }] });

    // First live branch by code: u1's lowest code is a DELETED r1 branch, so its
    // region is r2 — it pairs with u2 (r2), not with u3 (r1).
    await mk('u1', {
      name: `ZZ Dup Two ${tag}`,
      phone: phone(2),
      branches: [
        { region: 'r1', deleted: true, code: `${P}-u1-A` },
        { region: 'r2', code: `${P}-u1-B` },
      ],
    });
    await mk('u2', { name: `ZZ Dup Two ${tag}`, phone: phone(2), branches: [{ region: 'r2' }] });
    await mk('u3', { name: `ZZ Dup Two ${tag}`, phone: phone(2), branches: [{ region: 'r1' }] });

    // OPEN (owner): a customer whose FIRST live branch (by code) is in r2 and whose
    // second is in r1 does not pair with an r1 twin today.
    await mk('m1', {
      name: `ZZ Dup Multi ${tag}`,
      phone: phone(3),
      // Created in the other order, so neither insertion order nor id order is code order.
      branches: [
        { region: 'r1', code: `${P}-m1-B` },
        { region: 'r2', code: `${P}-m1-A` },
      ],
    });
    await mk('m2', { name: `ZZ Dup Multi ${tag}`, phone: phone(3), branches: [{ region: 'r1' }] });

    // A three-way CR group for the dismiss / merge round trip.
    for (const k of ['x', 'y', 'z']) await mk(k, { cr: `${tag}-3` });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custIds = Object.values(c);
      await purgeAuditLog(prisma, { where: { actorId: { in: Object.values(users) } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: custIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
      await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
      await prisma.route.deleteMany({ where: { id: { in: [r.rt1, r.rt2] } } });
      await prisma.region.deleteMany({ where: { id: { in: [r.r1, r.r2] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('finds exactly the pairs the rules describe — and none through a deleted customer or branch', async () => {
    as('steward');
    const { keys, pairs } = await scan();
    expect(keys).toEqual([
      'crA|crB:CR',
      'crLive|crNoBranch:CR',
      't1|t2:EXACT_TRIPLE',
      'u1|u2:EXACT_TRIPLE',
      'x|y:CR',
      'x|z:CR',
      'y|z:CR',
    ]);
    // Deleted branches are not counted either.
    const crPair = pairs.find((p) => p.reason === 'CR' && [p.a.id, p.b.id].includes(c.crA))!;
    const a = crPair.a.id === c.crA ? crPair.a : crPair.b;
    expect(a.branchCount).toBe(2);
  });

  it('OPEN (owner): the multi-branch twin is not found today — only the first branch region counts', async () => {
    as('steward');
    const { keys } = await scan();
    expect(keys.some((k) => k.startsWith('m1|m2'))).toBe(false);
  });

  it('only the Data Steward may scan or mark a pair distinct', async () => {
    for (const role of ['manager', 'viewer', 'sales'] as const) {
      as(role);
      await expect(dupes.findDuplicateCandidates(10)).rejects.toThrow(/Data Steward/);
      const res = await dupes.dismissDuplicateAction(fd(c.x, c.y));
      expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    current = null;
    await expect(dupes.findDuplicateCandidates(10)).rejects.toThrow(/Not signed in/);
    expect(await pairRows()).toEqual([]);
  });

  it('"Mark distinct" hides the pair in both orders; a merge removes the loser; a gone customer cannot be dismissed', async () => {
    as('steward');
    const first = await dupes.dismissDuplicateAction(fd(c.x, c.y));
    expect(first.ok).toBe(true);
    expect(await pairRows()).toEqual([
      { action: 'UPDATE', entityId: `${c.x}|${c.y}`, actorId: users.steward, reason: 'Deemed distinct by steward' },
    ]);
    let keys = (await scan()).keys.filter((k) => /^[xyz]\|/.test(k));
    expect(keys).toEqual(['x|z:CR', 'y|z:CR']);

    // Merge y into x: y is archived, so no pair through y remains.
    const merge = new FormData();
    merge.set('winnerId', c.x);
    merge.set('loserId', c.y);
    const merged = await dupes.mergeCustomersAction(merge);
    expect(merged.ok).toBe(true);
    keys = (await scan()).keys.filter((k) => /^[xyz]\|/.test(k));
    expect(keys).toEqual(['x|z:CR']);

    // Dismissed the other way round, the last pair goes too.
    const reversed = await dupes.dismissDuplicateAction(fd(c.z, c.x));
    expect(reversed.ok).toBe(true);
    keys = (await scan()).keys.filter((k) => /^[xyz]\|/.test(k));
    expect(keys).toEqual([]);

    // y is gone: dismissing a pair through it is refused and writes nothing.
    const before = (await pairRows()).length;
    const gone = await dupes.dismissDuplicateAction(fd(c.y, c.z));
    expect(gone).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await pairRows()).toHaveLength(before);
  });
});
