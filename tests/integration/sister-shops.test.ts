// @vitest-environment node
/**
 * Code review 2026-11-10, finding 27 — on Postgres, through the real services:
 * approving a change to one shop leaves its sister shops alone.
 *
 * A customer with three shops: B1, the one the requests are about; B2, a sister
 * whose stored score is right; B3, a sister whose stored score is wrong (as an
 * older load could leave it). Approving B1's close request, and then its
 * reactivation:
 *   - B1 is written, and its updatedAt moves;
 *   - B2 is not written: its updatedAt (the export's last_edited_at), version
 *     and score stay, and no history row is added for it;
 *   - B3's score is corrected and nothing else: its updatedAt and version stay,
 *     and no history row is added for it;
 *   - the customer's updatedAt moves, so an "updated since" export still finds
 *     the change to B1, while its version stays (none of its own fields changed).
 *
 * Second round (the refusal Postgres itself gives): B2 is made to break a
 * database rule (a location outside Oman), as an older row can — the rule is
 * NOT VALID, so the row is written with the rule set aside for one transaction
 * and put back NOT VALID in the same one, unseen by any other session:
 *   - with its stored score right, B2 no longer blocks an approval of another
 *     shop (B1's close request is approved; B2 is not written);
 *   - with its stored score wrong, the approval of a change to another shop
 *     (B3's close request) is refused by Postgres on B2's score write, and the
 *     refusal names B2 by its code (DATA_RULE); nothing is written.
 *
 * GATED: writes only rows it creates (prefix ZZSS-) and deletes them after.
 * Never production.
 *
 *   RUN_SISTER_SHOPS=1 DATABASE_URL=… DIRECT_URL=… \
 *     npx vitest run tests/integration/sister-shops.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals, purgeHistory } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { rescoreCustomerTx } from '@/lib/rescore';
import { scoreBranch } from '@/lib/completeness';
import { DB_RULE_BY_NAME } from '@/lib/db-rules';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_SISTER_SHOPS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const tag = randomUUID().slice(0, 8);
const P = `ZZSS-${tag}`;
const ids = {
  region: `${P}-region`,
  route: `${P}-route`,
  sup: `${P}-sup`,
  sales: `${P}-sales`,
  mgr: `${P}-mgr`,
  customer: `${P}-cust`,
  b1: `${P}-b1`,
  b2: `${P}-b2`,
  b3: `${P}-b3`,
};
const people = [ids.sup, ids.sales, ids.mgr];
const STALE = 99;

const as = (id: string, role: string) => {
  current = { id, role, username: id };
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
type Result = { ok: boolean; code?: string; message?: string; data?: { editId: string } };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ENABLED)('finding 27: approving a change to one shop leaves its sister shops alone', () => {
  let prisma: PrismaClient;
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');

  beforeAll(async () => {
    for (const url of [process.env.DATABASE_URL, process.env.DIRECT_URL]) {
      if (pointsAtProduction(url ?? '')) throw new Error('ABORT: production');
    }
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    reacts = await import('@/services/reactivations');

    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    await prisma.user.create({ data: { id: ids.sup, username: ids.sup, passwordHash: 'x', fullName: 'ZZ Supervisor', role: 'SUPERVISOR' } });
    await prisma.user.create({
      data: { id: ids.mgr, username: ids.mgr, passwordHash: 'x', fullName: 'ZZ Manager', role: 'MANAGER', managedRegions: { connect: { id: ids.region } } },
    });
    await prisma.user.create({
      data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Salesman', role: 'SALESMAN', ownedRouteId: ids.route, supervisorId: ids.sup },
    });
    await prisma.customer.create({ data: { id: ids.customer, nmwcCode: `${P}-C`, legalName: 'ZZ Sister Co', paymentTerms: 'CASH' } });
    for (const [id, n, over] of [
      [ids.b1, '01', {}],
      [ids.b2, '02', { gpsLat: 23.6, gpsLng: 58.4, coolersCount: 2 }],
      [ids.b3, '03', { dayOfVisit: 'TUE' as const }],
    ] as const) {
      await prisma.branch.create({
        data: {
          id,
          customerId: ids.customer,
          branchCode: `${P}-B-${n}`,
          branchName: `ZZ Branch ${n}`,
          regionId: ids.region,
          routeId: ids.route,
          address: 'ZZ Way 1, Muscat',
          status: 'ACTIVE',
          lastStatusChangeAt: new Date(Date.now() - 2 * DAY),
          ...over,
        },
      });
    }
    // Every stored score right, then B3's made wrong the way an older load
    // could leave it: raw SQL, so nothing else about it moves.
    await prisma.$transaction((tx) => rescoreCustomerTx(tx, [ids.customer]));
    await prisma.$executeRaw`UPDATE "Branch" SET "completenessScore" = ${STALE} WHERE "id" = ${ids.b3}`;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { submittedById: ids.sales }, select: { id: true } });
      const editIds = eds.map((e) => e.id);
      const branchIds = [ids.b1, ids.b2, ids.b3];
      const attachmentIds = (await prisma.attachment.findMany({ where: { capturedById: { in: people } }, select: { id: true } })).map((a) => a.id);
      await prisma.notification.deleteMany({
        where: { OR: [{ editId: { in: editIds } }, { userId: { in: people } }, { customerId: ids.customer }] },
      });
      if (editIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: { in: people } } });
      await prisma.branch.deleteMany({ where: { customerId: ids.customer } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await purgeAuditLog(prisma, { where: { actorId: { in: people } } });
      await prisma.user.deleteMany({ where: { id: { in: people } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
      await prisma.rateLimit.deleteMany({ where: { OR: people.map((u) => ({ key: { contains: u } })) } });
      await purgeHistory(prisma, {
        customerIds: [ids.customer],
        branchIds,
        userIds: people,
        routeIds: [ids.route],
        regionIds: [ids.region],
        attachmentIds,
        editIds,
      });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  async function evidence(branchId: string) {
    const a = await prisma.attachment.create({
      data: {
        kind: 'FREE',
        r2Key: `zz/${P}/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById: ids.sales,
        capturedAt: new Date(),
        branchId,
        branchExtraId: branchId,
      },
    });
    return a.id;
  }
  const shop = (id: string) =>
    prisma.branch.findUniqueOrThrow({ where: { id }, select: { updatedAt: true, version: true, completenessScore: true, status: true } });
  const historyOf = (branchId: string) => prisma.branchHistory.count({ where: { branchId } });
  const customerNow = () => prisma.customer.findUniqueOrThrow({ where: { id: ids.customer }, select: { updatedAt: true, version: true, status: true } });

  /** The sisters as they stand, to compare after the approval. */
  const snapshot = async () => ({
    b1: await shop(ids.b1),
    b2: await shop(ids.b2),
    b3: await shop(ids.b3),
    h2: await historyOf(ids.b2),
    h3: await historyOf(ids.b3),
    customer: await customerNow(),
  });

  async function expectSistersUntouched(before: Awaited<ReturnType<typeof snapshot>>, t0: Date) {
    const b2 = await shop(ids.b2);
    expect(b2, 'B2: not written at all').toEqual(before.b2);
    expect(await historyOf(ids.b2), 'B2: no history row').toBe(before.h2);

    const b3 = await shop(ids.b3);
    expect(b3.updatedAt, 'B3: its last-edited date stays').toEqual(before.b3.updatedAt);
    expect(b3.version, 'B3: its version stays').toBe(before.b3.version);
    expect(await historyOf(ids.b3), 'B3: no history row').toBe(before.h3);

    // The customer reads as changed for an "updated since" export, without a
    // version bump: none of its own fields changed.
    const c = await customerNow();
    expect(c.updatedAt.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(c.version).toBe(before.customer.version);
    const since = await prisma.customer.count({ where: { id: ids.customer, updatedAt: { gte: t0 } } });
    expect(since, 'an "updated since" export still finds the change').toBe(1);
  }

  it('approving the close request of B1 writes B1 only; B3’s wrong score is corrected and nothing else', async () => {
    as(ids.sales, 'SALESMAN');
    const sent = (await reacts.markBranchClosedAction(
      form({ branchId: ids.b1, reason: 'The owner has left.', attachmentId: await evidence(ids.b1) })
    )) as Result;
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const editId = sent.data!.editId;

    const before = await snapshot();
    expect(before.b3.completenessScore).toBe(STALE);
    await pause(30);
    const t0 = new Date();
    as(ids.sup, 'SUPERVISOR');
    const res = (await edits.approveEditAction(form({ editId, decisionToken: await freshDecisionToken(prisma, editId) }))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const b1 = await shop(ids.b1);
    expect(b1.status).toBe('CLOSED');
    expect(b1.updatedAt.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    await expectSistersUntouched(before, t0);
    const b3 = await prisma.branch.findUniqueOrThrow({ where: { id: ids.b3 } });
    expect(b3.completenessScore).toBe(scoreBranch(b3));
    expect(b3.completenessScore).not.toBe(STALE);
    expect((await customerNow()).status).toBe('ACTIVE');
  });

  it('approving the reactivation of B1 writes B1 only, too', async () => {
    await prisma.branch.update({ where: { id: ids.b1 }, data: { lastStatusChangeAt: new Date(Date.now() - 2 * DAY) } });
    // B3 wrong again, to prove the reactivation path corrects it the same way.
    await prisma.$executeRaw`UPDATE "Branch" SET "completenessScore" = ${STALE} WHERE "id" = ${ids.b3}`;
    as(ids.sales, 'SALESMAN');
    const sent = (await reacts.requestReactivationAction(
      form({ branchId: ids.b1, reason: 'Open again.', attachmentId: await evidence(ids.b1) })
    )) as Result;
    expect(sent.ok, JSON.stringify(sent)).toBe(true);

    const before = await snapshot();
    await pause(30);
    const t0 = new Date();
    as(ids.mgr, 'MANAGER');
    const res = (await reacts.approveReactivationAction(form({ editId: sent.data!.editId }))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);

    expect((await shop(ids.b1)).status).toBe('ACTIVE');
    await expectSistersUntouched(before, t0);
    expect((await shop(ids.b3)).completenessScore).not.toBe(STALE);
  });
  // ── Second round: Postgres itself refuses a sister shop's bad record ─────────
  const RULE = 'Branch_gps_in_oman';
  /**
   * Makes a shop break RULE the way an older row can, in ONE transaction: the
   * rule is set aside, the row written, the score set, and the rule put back
   * exactly as it was (NOT VALID), so no other session ever sees it missing.
   * `score`: 'right' stores the score the row deserves, a number stores that.
   */
  async function breakShop(branchId: string, score: 'right' | number) {
    await prisma.$transaction(async (tx) => {
      const [c] = await tx.$queryRaw<Array<{ def: string; validated: boolean }>>`
        SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
        FROM pg_constraint WHERE conname = ${RULE} AND conrelid = '"Branch"'::regclass`;
      if (!c) throw new Error(`${RULE} is missing`);
      // A validated rule means Postgres holds no such row: this proof is for the NOT VALID rules.
      if (c.validated) throw new Error(`${RULE} is validated; pick a NOT VALID rule for this proof`);
      await tx.$executeRawUnsafe(`ALTER TABLE "Branch" DROP CONSTRAINT "${RULE}"`);
      await tx.$executeRaw`UPDATE "Branch" SET "gpsLat" = 30, "gpsLng" = 58 WHERE "id" = ${branchId}`;
      const row = await tx.branch.findUniqueOrThrow({ where: { id: branchId } });
      const value = score === 'right' ? scoreBranch(row) : score;
      await tx.$executeRaw`UPDATE "Branch" SET "completenessScore" = ${value} WHERE "id" = ${branchId}`;
      await tx.$executeRawUnsafe(`ALTER TABLE "Branch" ADD CONSTRAINT "${RULE}" ${c.def.replace(/\s+NOT VALID$/, '')} NOT VALID`);
    });
    const [after] = await prisma.$queryRaw<Array<{ validated: boolean }>>`
      SELECT convalidated AS validated FROM pg_constraint WHERE conname = ${RULE} AND conrelid = '"Branch"'::regclass`;
    expect(after, 'the rule is back, NOT VALID as before').toEqual({ validated: false });
  }
  /** B2's fields as they are, to prove it was not written. */
  const b2Now = () =>
    prisma.branch.findUniqueOrThrow({
      where: { id: ids.b2 },
      select: { updatedAt: true, version: true, completenessScore: true, gpsLat: true, gpsLng: true, status: true },
    });

  it('second round: B2 breaks a rule but its score is right — approving B1’s close request is not blocked by it', async () => {
    await breakShop(ids.b2, 'right');
    // Postgres itself refuses any write of B2 now (the rule is checked on every update).
    await expect(prisma.branch.update({ where: { id: ids.b2 }, data: { address: 'ZZ Way 2, Muscat' } })).rejects.toThrow(new RegExp(RULE));
    const before = await b2Now();
    expect(before.gpsLat?.toString()).toBe('30');

    as(ids.sales, 'SALESMAN');
    const sent = (await reacts.markBranchClosedAction(
      form({ branchId: ids.b1, reason: 'The owner has left again.', attachmentId: await evidence(ids.b1) })
    )) as Result;
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    as(ids.sup, 'SUPERVISOR');
    const res = (await edits.approveEditAction(
      form({ editId: sent.data!.editId, decisionToken: await freshDecisionToken(prisma, sent.data!.editId) })
    )) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect((await shop(ids.b1)).status).toBe('CLOSED');
    expect(await b2Now(), 'B2: not written').toEqual(before);
  });

  it('second round: B2 breaks a rule and its score is wrong — Postgres refuses the approval of B3’s close request, naming B2', async () => {
    await breakShop(ids.b2, STALE);
    as(ids.sales, 'SALESMAN');
    const sent = (await reacts.markBranchClosedAction(
      form({ branchId: ids.b3, reason: 'The owner has left.', attachmentId: await evidence(ids.b3) })
    )) as Result;
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const editId = sent.data!.editId;
    const before = { b2: await b2Now(), b3: await shop(ids.b3), customer: await customerNow(), decisions: await prisma.editApproval.count({ where: { editId } }) };

    as(ids.sup, 'SUPERVISOR');
    const res = (await edits.approveEditAction(form({ editId, decisionToken: await freshDecisionToken(prisma, editId) }))) as Result;
    const rule = DB_RULE_BY_NAME.get(RULE)!;
    expect(res).toMatchObject({
      ok: false,
      code: 'DATA_RULE',
      message: `Shop ${P}-B-02's${rule.refusal.slice("This shop's".length)}`,
    });
    expect(res.message).toContain('a location outside Oman');
    // Nothing written: the request still waits, B3 still open, B2 and the customer as they were.
    expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } })).state).toBe('SUBMITTED');
    expect(await prisma.editApproval.count({ where: { editId } })).toBe(before.decisions);
    expect(await shop(ids.b3)).toEqual(before.b3);
    expect(await b2Now()).toEqual(before.b2);
    expect(await customerNow()).toEqual(before.customer);
  });
});
