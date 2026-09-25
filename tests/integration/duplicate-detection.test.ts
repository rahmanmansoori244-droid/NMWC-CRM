// @vitest-environment node
/**
 * Duplicate detection against real Postgres (benchmark item 16). The rules are
 * unit-tested in tests/unit/duplicate-pairing.test.ts; what only a database can
 * prove is here: that the detector's queries drop soft-deleted customers and
 * branches, read the stored normalized columns and every live branch's region,
 * that "Mark distinct", its undo and a merge change what the next scan shows,
 * and that the new-customer block refuses what the detector would pair.
 *
 * The owner's decisions of 2026-09-25 are pinned here end to end: any shared
 * region; names equal up to whitespace; Arabic-Indic digits and invisible
 * characters in CRs; dismissals that lapse when the match changes, and undo.
 *
 * It rides on RUN_MERGE_TESTS, which CI's db-tests job already sets, instead of
 * a new flag: a flag missing from ci.yml would make this suite skip in silence.
 *
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/duplicate-detection.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits } from '../support/audit';
import { normalizeCR } from '@/lib/cr';
import { normalizePhone } from '@/lib/phone';
import { signalHash, type DuplicateCandidate } from '@/lib/duplicate-pairing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_MERGE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => current && { user: current } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);
/** The same digits on an Arabic keyboard. */
const arabicDigits = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x660 + Number(d)));

describe.skipIf(!ENABLED)('duplicate detection against Postgres (item 16)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let dupes: typeof import('@/services/duplicates');
  let guards: typeof import('@/lib/create-guards');
  const tag = randomUUID().slice(0, 8);
  const P = `ZZDUP-${tag}`;
  // Seven digits unique to this run, so leftovers elsewhere cannot pair with them.
  const digits = String(parseInt(tag.slice(0, 7), 16) % 10_000_000).padStart(7, '0');
  const phone = (n: number) => `9${String((Number(digits) + n) % 10_000_000).padStart(7, '0')}`;
  // An all-digit CR unique to this run, so its Arabic-keyboard twin exists.
  const DIGIT_CR = `8${digits}`;

  const users = {
    steward: `${P}-stew`,
    manager: `${P}-mgr`,
    viewer: `${P}-view`,
    sales: `${P}-sales`,
  };
  const r = { r1: '', r2: '', rt1: '', rt2: '' };
  const c: Record<string, string> = {};
  const edits: string[] = [];
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
    for (const b of o.branches ?? [{ region: 'r1' }]) await addBranch(cust.id, key, b);
    c[key] = cust.id;
    return cust.id;
  }
  async function addBranch(customerId: string, key: string, b: { region: 'r1' | 'r2'; deleted?: boolean; code?: string }) {
    await prisma.branch.create({
      data: {
        customerId,
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
  /** Change a customer the way an approved edit does: the norm with the value. */
  const setCr = (key: string, cr: string) =>
    prisma.customer.update({ where: { id: c[key] }, data: { crNumber: cr, crNumberNorm: normalizeCR(cr) } });

  const ours = () => new Set(Object.values(c));
  const keyOf = () => new Map(Object.entries(c).map(([k, id]) => [id, k]));
  /** The scan, reduced to this suite's customers, as sorted "keyA|keyB:REASON" strings. */
  async function scan(): Promise<{ keys: string[]; pairs: DuplicateCandidate[]; marked: string[] }> {
    const { pairs, markedDistinct } = await dupes.findDuplicateCandidates(1_000_000);
    const mine = ours();
    const byId = keyOf();
    const name = (a: string, b: string) => [byId.get(a) ?? a, byId.get(b) ?? b].sort().join('|');
    const hits = pairs.filter((p) => mine.has(p.a.id) || mine.has(p.b.id));
    const keys = hits.map((p) => `${name(p.a.id, p.b.id)}:${p.reason}`).sort();
    const marked = markedDistinct
      .filter((m) => mine.has(m.a.id) || mine.has(m.b.id))
      .map((m) => name(m.a.id, m.b.id))
      .sort();
    return { keys, pairs: hits, marked };
  }
  /** Only the pairs among the named customers. */
  const among = (keys: string[], ...names: string[]) =>
    keys.filter((k) => k.split(':')[0].split('|').every((n) => names.includes(n)));
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
      select: { action: true, entityId: true, actorId: true, reason: true, after: true },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    dupes = await import('@/services/duplicates');
    guards = await import('@/lib/create-guards');

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

    // The same all-digit CR typed three ways: ASCII, on an Arabic keyboard, and
    // pasted with a zero-width space inside (owner decision: one CR).
    await mk('ar1', { cr: DIGIT_CR });
    await mk('ar2', { cr: arabicDigits(DIGIT_CR) });
    await mk('ar3', { cr: `${DIGIT_CR.slice(0, 3)}${ZWSP}${DIGIT_CR.slice(3)}` });

    // Name + phone + region, with the raw phone typed two ways (the norm decides).
    await mk('t1', { name: `ZZ Dup Shop ${tag}`, phone: '+968 ' + phone(1) });
    await mk('t2', { name: `  zz dup shop ${tag.toUpperCase()} `, phone: phone(1).replace(/(\d{4})/, '$1 ') });
    // Same name + phone, other region: no pair.
    await mk('t3', { name: `ZZ Dup Shop ${tag}`, phone: phone(1), branches: [{ region: 'r2' }] });
    // No live branch: no triple.
    await mk('t4', { name: `ZZ Dup Shop ${tag}`, phone: phone(1), branches: [{ region: 'r1', deleted: true }] });

    // Deleted branches do not count toward a shared region: u1's r1 branch is
    // deleted, so it pairs with u2 (r2), not with u3 (r1).
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

    // A multi-branch customer whose FIRST branch by code is in r2 and whose second
    // is in r1, and an r1 twin: found through the second region (owner decision).
    await mk('m1', {
      name: `ZZ Dup Multi ${tag}`,
      phone: phone(3),
      branches: [
        { region: 'r1', code: `${P}-m1-B` },
        { region: 'r2', code: `${P}-m1-A` },
      ],
    });
    await mk('m2', { name: `ZZ Dup Multi ${tag}`, phone: phone(3), branches: [{ region: 'r1' }] });

    // Names that differ only in whitespace: a doubled space, a no-break space.
    await mk('n1', { name: `ZZ Dup Space ${tag}`, phone: phone(4) });
    await mk('n2', { name: `ZZ Dup  Space ${tag}`, phone: phone(4) });
    await mk('n3', { name: `ZZ Dup${NBSP}Space ${tag}`, phone: phone(4) });
    // A different name on the same phone: no pair.
    await mk('n4', { name: `ZZ Dup Spaces ${tag}`, phone: phone(4) });

    // A three-way CR group for the dismiss / merge round trip.
    for (const k of ['x', 'y', 'z']) await mk(k, { cr: `${tag}-3` });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custIds = Object.values(c);
      await purgeAuditLog(prisma, { where: { actorId: { in: Object.values(users) } } });
      if (edits.length) await purgeCustomerEdits(prisma, { where: { id: { in: edits } } });
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
      'ar1|ar2:CR',
      'ar1|ar3:CR',
      'ar2|ar3:CR',
      'crA|crB:CR',
      'crLive|crNoBranch:CR',
      'm1|m2:EXACT_TRIPLE',
      'n1|n2:EXACT_TRIPLE',
      'n1|n3:EXACT_TRIPLE',
      'n2|n3:EXACT_TRIPLE',
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

  it('stored through normalizeCR, the Arabic-keyboard and zero-width CRs hold their ASCII twin', async () => {
    const stored = await prisma.customer.findMany({
      where: { id: { in: [c.ar1, c.ar2, c.ar3] } },
      select: { crNumber: true, crNumberNorm: true },
    });
    expect(new Set(stored.map((s) => s.crNumberNorm))).toEqual(new Set([DIGIT_CR]));
    // The CR as typed is kept as typed; only the norm folds.
    expect(stored.map((s) => s.crNumber).sort()).toEqual(
      [DIGIT_CR, arabicDigits(DIGIT_CR), `${DIGIT_CR.slice(0, 3)}${ZWSP}${DIGIT_CR.slice(3)}`].sort()
    );
  });

  it('only the Data Steward may scan, mark a pair distinct, or undo it', async () => {
    for (const role of ['manager', 'viewer', 'sales'] as const) {
      as(role);
      await expect(dupes.findDuplicateCandidates(10)).rejects.toThrow(/Data Steward/);
      const res = await dupes.dismissDuplicateAction(fd(c.x, c.y));
      expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      const undo = await dupes.undoDismissDuplicateAction(fd(c.x, c.y));
      expect(undo).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    current = null;
    await expect(dupes.findDuplicateCandidates(10)).rejects.toThrow(/Not signed in/);
    expect(await pairRows()).toEqual([]);
  });

  it('"Mark distinct" stores digests and hides the pair in both orders; a merge removes the loser; a gone customer cannot be dismissed', async () => {
    as('steward');
    const first = await dupes.dismissDuplicateAction(fd(c.x, c.y));
    expect(first.ok).toBe(true);
    expect(await pairRows()).toEqual([
      {
        action: 'UPDATE',
        entityId: `${c.x}|${c.y}`,
        actorId: users.steward,
        reason: 'Deemed distinct by steward',
        after: { signals: [`cr:${signalHash(normalizeCR(`${tag}-3`)!)}`] },
      },
    ]);
    expect(JSON.stringify(await pairRows())).not.toContain(normalizeCR(`${tag}-3`)!);
    let keys = (await scan()).keys.filter((k) => /^[xyz]\|/.test(k));
    expect(keys).toEqual(['x|z:CR', 'y|z:CR']);
    expect((await scan()).marked).toContain('x|y');

    // Merge y into x: y is archived, so no pair through y remains.
    const merge = new FormData();
    merge.set('winnerId', c.x);
    merge.set('loserId', c.y);
    const merged = await dupes.mergeCustomersAction(merge);
    expect(merged.ok).toBe(true);
    const after = await scan();
    expect(after.keys.filter((k) => /^[xyz]\|/.test(k))).toEqual(['x|z:CR']);
    // A pair through a merged-away customer is not listed as marked distinct either.
    expect(after.marked).not.toContain('x|y');

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

  it('refuses to mark distinct a pair no rule matches, and writes nothing', async () => {
    as('steward');
    const before = (await pairRows()).length;
    const res = await dupes.dismissDuplicateAction(fd(c.t1, c.crA));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await pairRows()).toHaveLength(before);
  });

  describe('dismissals lapse when the match changes, and can be undone (owner decision 2026-09-25)', () => {
    beforeAll(async () => {
      await mk('l1', { cr: `${tag}-5` });
      await mk('l2', { cr: `${tag}-5` });
      await mk('k1', { name: `ZZ Dup Keep ${tag}`, phone: phone(5), cr: `${tag}-6` });
      await mk('k2', { name: `ZZ Dup Other ${tag}`, phone: phone(5), cr: `${tag}-6` });
      await mk('s1', { name: `ZZ Dup Same ${tag}`, phone: phone(6), cr: `${tag}-7` });
      await mk('s2', { name: `ZZ Dup Same ${tag}`, phone: phone(6), cr: `${tag}-7` });
      await mk('g1', { cr: `${tag}-8` });
      await mk('g2', { cr: `${tag}-8` });
    });

    it('a dismissed CR pair returns when the CR changes to another shared value, noting it was marked distinct', async () => {
      as('steward');
      expect((await dupes.dismissDuplicateAction(fd(c.l1, c.l2))).ok).toBe(true);
      expect(among((await scan()).keys, 'l1', 'l2')).toEqual([]);

      await setCr('l1', `${tag}-9`);
      await setCr('l2', ` ${tag}-9 `);
      const { keys, pairs, marked } = await scan();
      expect(among(keys, 'l1', 'l2')).toEqual(['l1|l2:CR']);
      const back = pairs.find((p) => [p.a.id, p.b.id].includes(c.l1))!;
      expect(back.markedDistinctBefore).toMatchObject({ by: 'ZZ Dup Steward' });
      expect(back.markedDistinctBefore!.at).toBeInstanceOf(Date);
      expect(marked).not.toContain('l1|l2');
      // Nothing to undo: it is back already.
      const undo = await dupes.undoDismissDuplicateAction(fd(c.l1, c.l2));
      expect(undo).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      // Marked distinct again, on the new CR, it is hidden again: the latest row wins.
      expect((await dupes.dismissDuplicateAction(fd(c.l2, c.l1))).ok).toBe(true);
      const again = await scan();
      expect(among(again.keys, 'l1', 'l2')).toEqual([]);
      expect(again.marked).toContain('l1|l2');
    });

    it('a dismissed CR pair returns when it newly matches the name + phone + region rule', async () => {
      as('steward');
      expect((await dupes.dismissDuplicateAction(fd(c.k2, c.k1))).ok).toBe(true);
      expect(among((await scan()).keys, 'k1', 'k2')).toEqual([]);
      // k2 is renamed to k1's name, typed with a doubled space: the triple now matches too.
      await prisma.customer.update({ where: { id: c.k2 }, data: { legalName: `ZZ Dup  Keep ${tag}` } });
      expect(among((await scan()).keys, 'k1', 'k2')).toEqual(['k1|k2:CR']);
    });

    it('a dismissed pair stays hidden when only unrelated fields change — a new branch in another region included', async () => {
      as('steward');
      expect((await dupes.dismissDuplicateAction(fd(c.s1, c.s2))).ok).toBe(true);
      await prisma.customer.update({
        where: { id: c.s1 },
        data: { completenessScore: 97, contactPerson: 'ZZ Someone', primaryPhone: `+968 ${phone(6)}`, crNumber: ` ${tag}-7 ` },
      });
      await prisma.customer.update({ where: { id: c.s2 }, data: { legalName: `  ZZ DUP SAME ${tag}` } });
      await addBranch(c.s2, 's2', { region: 'r2' });
      const { keys, marked } = await scan();
      expect(among(keys, 's1', 's2')).toEqual([]);
      expect(marked).toContain('s1|s2');
    });

    it('undo puts the pair back; a second undo is refused; marking it again hides it again', async () => {
      as('steward');
      const undo = await dupes.undoDismissDuplicateAction(fd(c.s2, c.s1));
      expect(undo.ok).toBe(true);
      const rows = await pairRows();
      expect(rows[rows.length - 1]).toEqual({
        action: 'UPDATE',
        entityId: `${c.s2}|${c.s1}`,
        actorId: users.steward,
        reason: 'Steward undid "Mark distinct": the pair is a suspected duplicate again',
        after: { undo: true },
      });
      let s = await scan();
      expect(among(s.keys, 's1', 's2')).toEqual(['s1|s2:CR']);
      expect(s.marked).not.toContain('s1|s2');

      const again = await dupes.undoDismissDuplicateAction(fd(c.s1, c.s2));
      expect(again).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      expect(await pairRows()).toHaveLength(rows.length);

      expect((await dupes.dismissDuplicateAction(fd(c.s1, c.s2))).ok).toBe(true);
      s = await scan();
      expect(among(s.keys, 's1', 's2')).toEqual([]);
      expect(s.marked).toContain('s1|s2');
    });

    it('a row written before signals were stored still hides its pair, whatever it matches — and can be undone', async () => {
      as('steward');
      // The shape every dismissal had until this change: no `after`.
      await prisma.auditLog.create({
        data: {
          actorId: users.steward,
          action: 'UPDATE',
          entityType: 'CustomerPair',
          entityId: `${c.g1}|${c.g2}`,
          reason: 'Deemed distinct by steward',
        },
      });
      expect(among((await scan()).keys, 'g1', 'g2')).toEqual([]);
      await setCr('g1', `${tag}-10`);
      await setCr('g2', `${tag}-10`);
      const { keys, marked } = await scan();
      expect(among(keys, 'g1', 'g2')).toEqual([]);
      expect(marked).toContain('g1|g2');

      expect((await dupes.undoDismissDuplicateAction(fd(c.g1, c.g2))).ok).toBe(true);
      expect(among((await scan()).keys, 'g1', 'g2')).toEqual(['g1|g2:CR']);
    });
  });

  describe('the new-customer block refuses what the detector pairs', () => {
    const check = (a: {
      legalName: string;
      phone?: string;
      cr?: string;
      regionIds: string[];
      includeOpenRequests?: boolean;
      callerId?: string;
      excludeEditId?: string;
    }) =>
      prisma.$transaction(async (tx) => {
        const args = {
          crNumberNorm: normalizeCR(a.cr ?? null),
          legalName: a.legalName,
          primaryPhoneNorm: normalizePhone(a.phone ?? null),
          regionIds: a.regionIds,
        };
        await guards.lockCreateIdentity(tx, args);
        await guards.assertNoExactCreateDuplicate(tx, {
          ...args,
          includeOpenRequests: a.includeOpenRequests ?? true,
          callerId: a.callerId,
          excludeEditId: a.excludeEditId,
        });
      });

    it('a doubled space, a no-break space, or case and outer spaces: the same shop as a live customer', async () => {
      for (const legalName of [`ZZ Dup  Shop ${tag}`, `ZZ Dup${NBSP}Shop ${tag}`, `  zz DUP shop ${tag} `]) {
        await expect(check({ legalName, phone: phone(1), regionIds: [r.r1] })).rejects.toMatchObject({
          code: 'DUPLICATE_CUSTOMER',
          message: expect.stringContaining(`${P}-t1`),
        });
      }
      // A different name on the same phone and region is a different shop.
      await expect(check({ legalName: `ZZ Dup Shops ${tag}`, phone: phone(1), regionIds: [r.r1] })).resolves.toBeUndefined();
    });

    it('any shared region: the multi-branch customer blocks a request in its second region', async () => {
      await expect(
        check({ legalName: `ZZ Dup  Multi ${tag}`, phone: phone(3), regionIds: [r.r2] })
      ).rejects.toMatchObject({ code: 'DUPLICATE_CUSTOMER', message: expect.stringContaining(`${P}-m1`) });
    });

    it('an Arabic-keyboard CR is refused as the live ASCII CR', async () => {
      await expect(
        check({ legalName: `ZZ Dup New ${tag}`, cr: arabicDigits(DIGIT_CR), regionIds: [r.r1] })
      ).rejects.toMatchObject({ code: 'DUPLICATE_CR' });
    });

    it('another open new-customer request, by the same name up to whitespace', async () => {
      const edit = await prisma.customerEdit.create({
        data: {
          target: 'CUSTOMER',
          process: 'CREATE',
          state: 'SUBMITTED',
          submittedAt: new Date(),
          submittedById: users.sales,
          fieldChanges: {},
          attachmentChanges: {},
          customerDraft: {
            create: {
              legalName: `ZZ Dup Open ${tag}`,
              paymentTerms: 'CASH',
              primaryPhone: phone(7),
              primaryPhoneNorm: normalizePhone(phone(7)),
            },
          },
          branchDrafts: {
            create: [{ branchName: 'ZZ', regionId: r.r1, routeId: r.rt1, address: 'ZZ Way 1' }],
          },
        },
      });
      edits.push(edit.id);
      const twin = { legalName: `ZZ Dup${NBSP}Open  ${tag}`, phone: phone(7), regionIds: [r.r1] };
      await expect(check(twin)).rejects.toMatchObject({
        code: 'DUPLICATE_CUSTOMER',
        message: 'Another new-customer request for this shop (same name, phone and region) is already in progress.',
      });
      await expect(check({ ...twin, callerId: users.sales })).rejects.toMatchObject({
        message: expect.stringMatching(/^Your own new-customer request for this shop/),
      });
      // Its own edit is not a duplicate of itself; and finalize does not read open requests.
      await expect(check({ ...twin, excludeEditId: edit.id })).resolves.toBeUndefined();
      await expect(check({ ...twin, includeOpenRequests: false })).resolves.toBeUndefined();
    });
  });
});
