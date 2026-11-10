// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — on Postgres, through the real services:
 * a request's own reason and every decision's reason are kept apart, and nothing
 * overwrites anything.
 *
 * A request kept one "reason" line (CustomerEdit.decisionReason). The salesman's
 * reason, each approver's and each closure note all went to it, so each writer
 * replaced the one before. What these walks prove, row by row:
 *
 *  (1) a full round trip of a new-customer request with a typed GPS point —
 *      submit, the Accountant's send-back (A), the Supervisor's relay to the
 *      salesman (B), resubmit, approve, approve: the salesman's alert carries
 *      both reasons, his page's source (currentReason) names who sent it back
 *      and at which step with A as the earlier one, the approved request
 *      carries no reason, the decision rows and audit rows of round 1 still
 *      hold A and B, and the GPS reason is on the request at every step;
 *  (2) a step-back answered by a re-approval leaves no reason on the request;
 *  (3) a close-shop request keeps the salesman's reason through its refusal,
 *      and the database refuses a change to it;
 *  (4) a reactivation's REACTIVATE audit row carries the salesman's reason and
 *      the Manager's note, each under its own key; "Keep closed" replaces neither;
 *  (5) a merge that auto-closes a pending close request no longer destroys the
 *      salesman's reason;
 *  (6) requests in flight from the build before this one (the reason in
 *      decisionReason only) are still approved, shown and audited as before.
 *
 * GATED: writes only rows it creates (prefix ZZRR-) and deletes them after.
 * Never production.
 *
 *   RUN_REQUEST_REASONS=1 DATABASE_URL=… DIRECT_URL=… \
 *     npx vitest run tests/integration/request-reasons.test.ts
 */
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  purgeAuditLog,
  purgeCustomerEdits,
  purgeEditApprovals,
  purgeHistory,
  withAuditMaintenance,
} from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { manualGpsReasonForPoint } from '@/lib/gps-manual';
import {
  DECISION_TRAIL,
  REQUEST_REASON_LEGACY_COPY,
  currentReason,
  mergeClosedReason,
  requestReasonOf,
} from '@/lib/request-reasons';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_REQUEST_REASONS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const tag = randomUUID().slice(0, 8);
const P = `ZZRR-${tag}`;
const ids = {
  region: `${P}-region`,
  route: `${P}-route`,
  sup: `${P}-sup`,
  sales: `${P}-sales`,
  acc: `${P}-acc`,
  mgr: `${P}-mgr`,
  steward: `${P}-stew`,
  // The customer the close and reactivation requests are about, and its shop.
  customer: `${P}-cust`,
  b1: `${P}-b1`,
  // A second shop, for the requests the older build sent.
  b2: `${P}-b2`,
  // The pair a merge joins: the loser has a pending close request.
  winner: `${P}-win`,
  loser: `${P}-lose`,
  wb: `${P}-wb`,
  lb: `${P}-lb`,
};
const people = [ids.sup, ids.sales, ids.acc, ids.mgr, ids.steward];
const NAMES = { trip: `ZZ-SYN Reason Round Trip ${tag}`, back: `ZZ-SYN Reason Step Back ${tag}` };
const digits = (salt: number) => String(100000 + ((parseInt(tag, 16) + salt) % 900000));

const A = 'CR number does not match the photo';
const B = 'Phone number format is incorrect';
const GPS_REASON = 'GPS would not lock inside the mall';
const GPS = { lat: 23.6123, lng: 58.4456 };

const as = (id: string, role: string) => {
  current = { id, role, username: id };
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
type Result = { ok: boolean; code?: string; message?: string; data?: { editId: string } };

describe.skipIf(!ENABLED)('finding 18: a request’s reasons are kept apart, and nothing is overwritten', () => {
  let prisma: PrismaClient;
  let creates: typeof import('@/services/creates');
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');
  let dupes: typeof import('@/services/duplicates');
  let channelId = '';
  let subChannelId = '';

  beforeAll(async () => {
    for (const url of [process.env.DATABASE_URL, process.env.DIRECT_URL]) {
      if (pointsAtProduction(url ?? '')) throw new Error('ABORT: production');
    }
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    edits = await import('@/services/edits');
    reacts = await import('@/services/reactivations');
    dupes = await import('@/services/duplicates');

    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    await prisma.user.create({ data: { id: ids.sup, username: ids.sup, passwordHash: 'x', fullName: 'ZZ Supervisor Salim', role: 'SUPERVISOR' } });
    await prisma.user.create({
      data: { id: ids.acc, username: ids.acc, passwordHash: 'x', fullName: 'ZZ Accountant Aisha', role: 'ACCOUNTANT', managedRegions: { connect: { id: ids.region } } },
    });
    await prisma.user.create({
      data: { id: ids.mgr, username: ids.mgr, passwordHash: 'x', fullName: 'ZZ Manager Muna', role: 'MANAGER', managedRegions: { connect: { id: ids.region } } },
    });
    await prisma.user.create({ data: { id: ids.steward, username: ids.steward, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' } });
    await prisma.user.create({
      data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Salesman Said', role: 'SALESMAN', ownedRouteId: ids.route, supervisorId: ids.sup },
    });
    const ch = await prisma.channel.findFirst({ include: { subChannels: { take: 1 } } });
    if (!ch || ch.subChannels.length === 0) throw new Error('No channel/subchannel seeded.');
    channelId = ch.id;
    subChannelId = ch.subChannels[0]!.id;

    await prisma.customer.create({ data: { id: ids.customer, nmwcCode: `${P}-C`, legalName: 'ZZ Reason Co', paymentTerms: 'CASH' } });
    await prisma.customer.create({ data: { id: ids.winner, nmwcCode: `${P}-W`, legalName: 'ZZ Reason Winner', paymentTerms: 'CASH' } });
    await prisma.customer.create({ data: { id: ids.loser, nmwcCode: `${P}-L`, legalName: 'ZZ Reason Loser', paymentTerms: 'CASH' } });
    for (const [id, customerId, n] of [
      [ids.b1, ids.customer, '01'],
      [ids.b2, ids.customer, '02'],
      [ids.wb, ids.winner, '03'],
      [ids.lb, ids.loser, '04'],
    ] as const) {
      await prisma.branch.create({
        data: {
          id,
          customerId,
          branchCode: `${P}-B-${n}`,
          branchName: `ZZ Branch ${n}`,
          regionId: ids.region,
          routeId: ids.route,
          address: 'ZZ Way 1, Muscat',
          status: 'ACTIVE',
          lastStatusChangeAt: new Date(Date.now() - 2 * DAY),
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { submittedById: ids.sales }, select: { id: true, customerId: true } });
      const editIds = eds.map((e) => e.id);
      const created = (await prisma.customer.findMany({ where: { legalName: { in: Object.values(NAMES) } }, select: { id: true } })).map((c) => c.id);
      const customers = [ids.customer, ids.winner, ids.loser, ...created];
      const branchIds = (await prisma.branch.findMany({ where: { customerId: { in: customers } }, select: { id: true } })).map((b) => b.id);
      const attachmentIds = (await prisma.attachment.findMany({ where: { capturedById: { in: people } }, select: { id: true } })).map((a) => a.id);
      await prisma.notification.deleteMany({
        where: { OR: [{ editId: { in: editIds } }, { userId: { in: people } }, { customerId: { in: customers } }] },
      });
      if (editIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
        await prisma.editBranchDraft.deleteMany({ where: { editId: { in: editIds } } });
        await prisma.editCustomerDraft.deleteMany({ where: { editId: { in: editIds } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: { in: people } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: customers } } });
      await prisma.customer.deleteMany({ where: { id: { in: customers } } });
      await purgeAuditLog(prisma, { where: { actorId: { in: people } } });
      await prisma.user.deleteMany({ where: { id: { in: people } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
      await prisma.rateLimit.deleteMany({ where: { OR: people.map((u) => ({ key: { contains: u } })) } });
      await purgeHistory(prisma, {
        customerIds: customers,
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

  // ── helpers ────────────────────────────────────────────────────────────────
  async function att(kind: 'CR' | 'SHOP' | 'SIGNBOARD') {
    const a = await prisma.attachment.create({
      data: { kind, r2Key: `zz/${P}/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 1000, capturedById: ids.sales, capturedAt: new Date() },
    });
    return a.id;
  }
  /** An evidence photo as the FREE slot leaves it: on the branch as an extra, captured now. */
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
  /** The body the new-customer form sends: one shop whose point was typed in by hand. */
  type CreatePhotos = { cr: string; shop: string; signboard: string };
  const createBody = (legalName: string, salt: number, photos: CreatePhotos, editId?: string) => ({
    ...(editId ? { editId } : {}),
    isDraft: false,
    customer: {
      legalName,
      paymentTerms: 'CASH' as const,
      channelId,
      subChannelId,
      primaryPhone: `+96892${digits(salt)}`,
      contactPerson: `ZZ Contact ${tag}`,
      crNumber: `91${digits(salt + 1)}`,
      crPhotoAttachmentId: photos.cr,
    },
    branches: [
      {
        branchName: `ZZ Branch ${tag}-${salt}`,
        address: `ZZ Way ${salt}, ${tag}`,
        gpsLat: GPS.lat,
        gpsLng: GPS.lng,
        gpsManualReason: GPS_REASON,
        dayOfVisit: 'MON' as const,
        coolersCount: 1,
        standsCount: 1,
        emptyBottlesCount: 5,
        shopPhotoAttachmentId: photos.shop,
        signboardPhotoAttachmentId: photos.signboard,
      },
    ],
  });
  async function submitCreate(legalName: string, salt: number, photos: CreatePhotos, editId?: string): Promise<string> {
    as(ids.sales, 'SALESMAN');
    const res = (await creates.submitCreateAction(createBody(legalName, salt, photos, editId))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId;
  }
  async function approve(by: [string, string], editId: string, temixCode?: string) {
    as(...by);
    const fd = form({ editId, decisionToken: await freshDecisionToken(prisma, editId) });
    if (temixCode) fd.set('temixCode', temixCode);
    const res = (await edits.approveEditAction(fd)) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
  }
  async function reject(by: [string, string], editId: string, reason: string, category = 'wrong_info') {
    as(...by);
    const res = (await edits.rejectEditAction(
      form({ editId, decisionToken: await freshDecisionToken(prisma, editId), reason, category })
    )) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
  }
  const SUP: [string, string] = [ids.sup, 'SUPERVISOR'];
  const ACC: [string, string] = [ids.acc, 'ACCOUNTANT'];

  /** The request as every screen reads it: the row, its reviewer, and its decisions through the one trail. */
  const read = (id: string) =>
    prisma.customerEdit.findUniqueOrThrow({
      where: { id },
      include: { steps: DECISION_TRAIL, reviewedBy: { select: { fullName: true } } },
    });
  const gpsReasonOn = async (id: string) =>
    manualGpsReasonForPoint((await prisma.customerEdit.findUniqueOrThrow({ where: { id }, select: { fieldChanges: true } })).fieldChanges, GPS.lat, GPS.lng);
  const decisionRows = (id: string) =>
    prisma.editApproval.findMany({
      where: { editId: id },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      select: { cycle: true, stepIndex: true, role: true, decision: true, reason: true, actorId: true },
    });
  const auditReasons = async (id: string, action: 'REJECT' | 'CREATE') =>
    (await prisma.auditLog.findMany({ where: { entityType: 'CustomerEdit', entityId: id, action }, orderBy: { at: 'asc' }, select: { reason: true } })).map((r) => r.reason);
  const alerts = (id: string, kind: 'EDIT_NEEDS_CORRECTION' | 'EDIT_APPROVED_FINAL') =>
    prisma.notification.findMany({ where: { editId: id, userId: ids.sales, kind }, orderBy: { createdAt: 'asc' }, select: { title: true, body: true } });

  async function sendClose(branchId: string, reason: string): Promise<string> {
    as(ids.sales, 'SALESMAN');
    const res = (await reacts.markBranchClosedAction(form({ branchId, reason, attachmentId: await evidence(branchId) }))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId;
  }
  async function sendReactivation(branchId: string, reason: string): Promise<string> {
    await prisma.branch.update({ where: { id: branchId }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 2 * DAY) } });
    as(ids.sales, 'SALESMAN');
    const res = (await reacts.requestReactivationAction(form({ branchId, reason, attachmentId: await evidence(branchId) }))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId;
  }
  /**
   * A request as the build BEFORE this one left it: the salesman's reason in
   * decisionReason only. What was sent is evidence, so the fixture rewrites the
   * row in the owner's maintenance window (as credit-chain-e2e does for a chain).
   */
  const asOlderBuildSentIt = (id: string) =>
    withAuditMaintenance(prisma, (tx) => tx.customerEdit.update({ where: { id }, data: { requestReason: null } }));

  // ── (1) the full round trip ────────────────────────────────────────────────
  describe('(1) submit → send back (Accountant) → relay (Supervisor) → resubmit → approve → approve', () => {
    let id = '';
    let photos: CreatePhotos;

    it('submitted with a typed GPS point: its reason is on the request, and there is no request-level reason', async () => {
      photos = { cr: await att('CR'), shop: await att('SHOP'), signboard: await att('SIGNBOARD') };
      id = await submitCreate(NAMES.trip, 10, photos);
      const row = await read(id);
      expect([row.state, row.cycle, row.currentStepIndex]).toEqual(['SUBMITTED', 1, 0]);
      expect(await gpsReasonOn(id)).toBe(GPS_REASON);
      expect(row.requestReason).toBeNull();
      expect(row.decisionReason).toBeNull();
      expect(currentReason(row, row.steps)).toBeNull();
    });

    it('the Accountant sends it back one step with A: A is on his decision row, and current on the request', async () => {
      await approve(SUP, id);
      await reject(ACC, id, A);
      const row = await read(id);
      expect([row.state, row.currentStepIndex, row.pendingRole]).toEqual(['SUBMITTED', 0, 'SUPERVISOR']);
      expect(row.decisionReason).toBe(A);
      expect(await decisionRows(id)).toEqual([
        { cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', reason: null, actorId: ids.sup },
        { cycle: 1, stepIndex: 1, role: 'ACCOUNTANT', decision: 'REJECTED', reason: A, actorId: ids.acc },
      ]);
      expect(currentReason(row, row.steps)).toMatchObject({ kind: 'RETURNED_TO_STEP', latest: { step: 'Accountant', by: 'ZZ Accountant Aisha', reason: A }, earlier: [] });
      // It has not come back to the salesman: his ping names no reason.
      expect(await alerts(id, 'EDIT_NEEDS_CORRECTION')).toEqual([]);
      expect(await gpsReasonOn(id)).toBe(GPS_REASON);
    });

    it('the Supervisor relays it to the salesman with B: his alert carries B and A, and his page’s source names who, where and both', async () => {
      await reject(SUP, id, B, 'other');
      const row = await read(id);
      expect([row.state, row.cycle]).toEqual(['NEEDS_CORRECTION', 1]);
      // The row's own copy is the LATEST send-back; A is not lost with it.
      expect(row.decisionReason).toBe(B);
      expect(await alerts(id, 'EDIT_NEEDS_CORRECTION')).toEqual([
        { title: 'Needs correction', body: `${NAMES.trip} — returned to you: ${B} (Earlier in this round — Accountant step: ${A})` },
      ]);
      const now = currentReason(row, row.steps);
      expect(now).toMatchObject({
        kind: 'SENT_BACK',
        latest: { step: 'Supervisor', stepIndex: 0, by: 'ZZ Supervisor Salim', reason: B },
        earlier: [{ step: 'Accountant', stepIndex: 1, by: 'ZZ Accountant Aisha', reason: A }],
      });
      expect(await auditReasons(id, 'REJECT')).toEqual([A, B]);
      expect(await gpsReasonOn(id)).toBe(GPS_REASON);
    });

    it('the salesman sends it again: a new round, with no reason on the request and nothing current', async () => {
      const again = await submitCreate(NAMES.trip, 10, photos, id);
      expect(again).toBe(id);
      const row = await read(id);
      expect([row.state, row.cycle, row.currentStepIndex]).toEqual(['SUBMITTED', 2, 0]);
      expect(row.decisionReason).toBeNull();
      expect(row.decisionCategory).toBeNull();
      expect(currentReason(row, row.steps)).toBeNull();
      // His typed-GPS reason travels with what he sent again.
      expect(await gpsReasonOn(id)).toBe(GPS_REASON);
    });

    it('approved twice, with a Temix code: the approved request carries no reason, and round 1’s trail still holds A and B', async () => {
      await approve(SUP, id);
      let row = await read(id);
      expect([row.state, row.currentStepIndex, row.decisionReason]).toEqual(['SUBMITTED', 1, null]);
      await approve(ACC, id, `ZRR${tag}`.toUpperCase());
      row = await read(id);
      expect(row.state).toBe('APPROVED');
      expect(row.customerId).not.toBeNull();
      expect(row.decisionReason).toBeNull();
      expect(row.decisionCategory).toBeNull();
      expect(currentReason(row, row.steps)).toBeNull();
      // Nothing was overwritten: every decision of both rounds, in order, each with its own reason.
      expect(await decisionRows(id)).toEqual([
        { cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', reason: null, actorId: ids.sup },
        { cycle: 1, stepIndex: 1, role: 'ACCOUNTANT', decision: 'REJECTED', reason: A, actorId: ids.acc },
        { cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'REJECTED', reason: B, actorId: ids.sup },
        { cycle: 2, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', reason: null, actorId: ids.sup },
        { cycle: 2, stepIndex: 1, role: 'ACCOUNTANT', decision: 'APPROVED', reason: null, actorId: ids.acc },
      ]);
      expect(await auditReasons(id, 'REJECT')).toEqual([A, B]);
      expect(await gpsReasonOn(id)).toBe(GPS_REASON);
      // He was told once why it came back, and once that it is live.
      expect(await alerts(id, 'EDIT_NEEDS_CORRECTION')).toHaveLength(1);
      expect(await alerts(id, 'EDIT_APPROVED_FINAL')).toHaveLength(1);
    });
  });

  // ── (2) step back, then forward ────────────────────────────────────────────
  it('(2) a step-back answered by a re-approval leaves no reason on the request, pending or approved', async () => {
    const photos = { cr: await att('CR'), shop: await att('SHOP'), signboard: await att('SIGNBOARD') };
    const id = await submitCreate(NAMES.back, 30, photos);
    await approve(SUP, id);
    await reject(ACC, id, A);
    expect((await read(id)).decisionReason).toBe(A);
    // The Supervisor checks, and sends it on again.
    await approve(SUP, id);
    let row = await read(id);
    expect([row.state, row.currentStepIndex, row.pendingRole]).toEqual(['SUBMITTED', 1, 'ACCOUNTANT']);
    expect(row.decisionReason).toBeNull();
    expect(row.decisionCategory).toBeNull();
    expect(currentReason(row, row.steps)).toBeNull();
    await approve(ACC, id, `ZRS${tag}`.toUpperCase());
    row = await read(id);
    expect([row.state, row.decisionReason, row.decisionCategory]).toEqual(['APPROVED', null, null]);
    expect(currentReason(row, row.steps)).toBeNull();
    // The rejection is still in the trail, with its reason.
    expect((await decisionRows(id)).filter((d) => d.decision === 'REJECTED')).toEqual([
      { cycle: 1, stepIndex: 1, role: 'ACCOUNTANT', decision: 'REJECTED', reason: A, actorId: ids.acc },
    ]);
    // The salesman was never told a reason he could not act on.
    expect(await alerts(id, 'EDIT_NEEDS_CORRECTION')).toEqual([]);
  });

  // ── (3) a close request ────────────────────────────────────────────────────
  it('(3) a close-shop request keeps the salesman’s reason through its refusal, and the database refuses a change to it', async () => {
    const R = 'The owner has left the country.';
    const X = 'The shop is open, I passed it today.';
    const id = await sendClose(ids.b1, `  ${R}  `);
    let row = await read(id);
    expect(row.requestReason).toBe(R);
    // The rollback bridge: the build before this one reads it here.
    expect(REQUEST_REASON_LEGACY_COPY).toBe(true);
    expect(row.decisionReason).toBe(R);
    expect(requestReasonOf(row, row.steps)).toBe(R);
    expect(currentReason(row, row.steps)).toBeNull();
    const sealed = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CustomerEdit', entityId: id, action: 'CREATE' } });
    expect((sealed.after as { requestReason?: string }).requestReason).toBe(R);

    await reject(SUP, id, X, 'other');
    row = await read(id);
    expect(row.state).toBe('REJECTED');
    expect(row.requestReason).toBe(R);
    expect(row.decisionReason).toBe(R);
    expect(await decisionRows(id)).toEqual([
      { cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'REJECTED', reason: X, actorId: ids.sup },
    ]);
    expect(await auditReasons(id, 'REJECT')).toEqual([X]);
    expect(await alerts(id, 'EDIT_NEEDS_CORRECTION')).toEqual([
      { title: 'Close-shop request refused', body: `ZZ Reason Co — your close-shop request was refused, so the branch is not closed: ${X}` },
    ]);
    // Each reason under its own name, on the screens' own source.
    expect(requestReasonOf(row, row.steps)).toBe(R);
    expect(currentReason(row, row.steps)).toMatchObject({ kind: 'REFUSED', latest: { step: 'Supervisor', by: 'ZZ Supervisor Salim', reason: X } });

    // The application's own client cannot rewrite it: what was sent is evidence.
    await expect(prisma.customerEdit.update({ where: { id }, data: { requestReason: X } })).rejects.toThrow(
      /requestReason cannot change once the request was sent/
    );
    await expect(prisma.customerEdit.update({ where: { id }, data: { requestReason: null } })).rejects.toThrow(
      /requestReason cannot change once the request was sent/
    );
    expect((await read(id)).requestReason).toBe(R);
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).status).toBe('ACTIVE');
  });

  // ── (4) a reactivation ─────────────────────────────────────────────────────
  it('(4) a reactivation: the REACTIVATE row carries the salesman’s reason and the Manager’s note, each under its own key', async () => {
    const R = 'Open again under a new owner.';
    const N = 'Seen open on my visit.';
    const id = await sendReactivation(ids.b1, R);
    let row = await read(id);
    expect([row.requestReason, row.isReactivation, row.state]).toEqual([R, true, 'SUBMITTED']);
    expect((await auditReasons(id, 'CREATE'))[0]).toBe('reactivation requested');

    as(ids.mgr, 'MANAGER');
    const res = (await reacts.approveReactivationAction(form({ editId: id, reason: N }))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    row = await read(id);
    expect([row.state, row.requestReason]).toEqual(['APPROVED', R]);
    const reopened = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REACTIVATE', entityType: 'Branch', entityId: ids.b1 }, orderBy: { at: 'desc' } });
    expect(reopened.reason).toBe(R);
    expect(reopened.after).toMatchObject({ editId: id, requestReason: R, managerReason: N });
    // The Manager's note is his decision's.
    expect(await decisionRows(id)).toEqual([
      { cycle: 1, stepIndex: 0, role: 'MANAGER', decision: 'APPROVED', reason: N, actorId: ids.mgr },
    ]);
    expect(currentReason(row, row.steps)).toBeNull();
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).status).toBe('ACTIVE');
  });

  it('(4) "Keep closed": the Manager’s reason is his decision’s; the salesman’s is not replaced', async () => {
    const R = 'The shutters are up again.';
    const X = 'Still shut — I checked this morning.';
    const id = await sendReactivation(ids.b1, R);
    as(ids.mgr, 'MANAGER');
    const res = (await reacts.rejectReactivationAction(form({ editId: id, reason: X }))) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const row = await read(id);
    expect([row.state, row.requestReason, row.decisionReason]).toEqual(['REJECTED', R, R]);
    expect(await decisionRows(id)).toEqual([
      { cycle: 1, stepIndex: 0, role: 'MANAGER', decision: 'REJECTED', reason: X, actorId: ids.mgr },
    ]);
    expect(requestReasonOf(row, row.steps)).toBe(R);
    expect(currentReason(row, row.steps)).toMatchObject({ kind: 'REFUSED', latest: { step: 'Manager', by: 'ZZ Manager Muna', reason: X } });
    expect((await alerts(id, 'EDIT_NEEDS_CORRECTION'))[0]!.body).toContain(X);
    // Leave the shop open for the walks below.
    await prisma.branch.update({ where: { id: ids.b1 }, data: { status: 'ACTIVE' } });
  });

  // ── (5) a merge ────────────────────────────────────────────────────────────
  it('(5) a merge auto-closes the loser’s pending close request without destroying the salesman’s reason', async () => {
    const R = 'Shop closed after the fire.';
    const id = await sendClose(ids.lb, R);
    as(ids.steward, 'STEWARD');
    const res = await dupes.mergeCustomersAction(form({ winnerId: ids.winner, loserId: ids.loser, reason: 'Same shop entered twice — merging.' }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const row = await read(id);
    const note = mergeClosedReason(`${P}-L`, `${P}-W`);
    expect([row.state, row.customerId]).toEqual(['REJECTED', ids.winner]);
    // The closure note is the merge's — and the salesman's reason is still his.
    expect(row.decisionReason).toBe(note);
    expect(row.requestReason).toBe(R);
    expect(requestReasonOf(row, row.steps)).toBe(R);
    expect(currentReason(row, row.steps)).toEqual({ kind: 'CLOSED', note });
    expect(await auditReasons(id, 'REJECT')).toEqual([note]);
    expect(await decisionRows(id)).toEqual([]);
  });

  // ── (6) requests in flight from the build before this one ──────────────────
  describe('(6) a request the build before this one sent (the reason in decisionReason only) keeps working', () => {
    it('a pending close: shown as the salesman’s, approved, and its reason left where that build reads it', async () => {
      const R = 'Lease ended, the shop is empty.';
      const id = await sendClose(ids.b2, R);
      await asOlderBuildSentIt(id);
      let row = await read(id);
      expect([row.requestReason, row.decisionReason]).toEqual([null, R]);
      // The approver's page and the Reactivations queue read it the same way.
      expect(requestReasonOf(row, row.steps)).toBe(R);
      await approve(SUP, id);
      row = await read(id);
      expect(row.state).toBe('APPROVED');
      // Not cleared by the final approval: an Instant Rollback still shows it.
      expect(row.decisionReason).toBe(R);
      expect(row.requestReason).toBeNull();
      expect(requestReasonOf(row, row.steps)).toBe(R);
      expect(currentReason(row, row.steps)).toBeNull();
      expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b2 } })).status).toBe('CLOSED');
    });

    it('a pending reactivation: approved, with the salesman’s reason on the REACTIVATE row as before', async () => {
      const R = 'A new tenant has opened it again.';
      // b2 was closed by the walk above.
      const id = await sendReactivation(ids.b2, R);
      await asOlderBuildSentIt(id);
      expect(requestReasonOf(await read(id))).toBe(R);
      as(ids.mgr, 'MANAGER');
      const res = (await reacts.approveReactivationAction(form({ editId: id }))) as Result;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const reopened = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REACTIVATE', entityType: 'Branch', entityId: ids.b2 }, orderBy: { at: 'desc' } });
      expect(reopened.reason).toBe(R);
      expect(reopened.after).toMatchObject({ editId: id, requestReason: R, managerReason: null });
      const row = await read(id);
      expect([row.state, row.decisionReason, row.requestReason]).toEqual(['APPROVED', R, null]);
    });

    it('a refused close: the salesman’s reason is still told apart from the reviewer’s', async () => {
      const R = 'Owner retired.';
      const X = 'Open as usual this week.';
      const id = await sendClose(ids.b1, R);
      await asOlderBuildSentIt(id);
      await reject(SUP, id, X, 'other');
      const row = await read(id);
      expect([row.state, row.requestReason, row.decisionReason]).toEqual(['REJECTED', null, R]);
      expect(requestReasonOf(row, row.steps)).toBe(R);
      expect(currentReason(row, row.steps)).toMatchObject({ kind: 'REFUSED', latest: { reason: X } });
    });
  });
});
