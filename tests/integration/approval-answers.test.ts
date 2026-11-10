// @vitest-environment node
/**
 * Code review 2026-11-10, finding 21 — on Postgres, through the real services:
 * an approver who taps again after a lost reply, or whose colleague decided
 * first, is told so; everyone else is refused exactly as before.
 *
 *  (1) a new-customer request at the Supervisor step, approved by Manager One:
 *      his second tap on the same page (approve, reject, and inside a bulk
 *      approve) answers "Your decision already arrived"; Manager Two of the
 *      same region, on a page from before, is told Manager One approved it;
 *      a Manager of another region and the salesman are still FORBIDDEN; a
 *      fresh page of the next step's approver still decides; nothing is
 *      written by any of the refused taps;
 *  (2) a close-shop request: approved, then tapped again — his own answer, a
 *      colleague who could have decided it is told who, and a Manager of
 *      another region reads where it stands in words, not "Edit is in state
 *      APPROVED."; a refused one says "refused";
 *  (3) a reactivation: the same three answers, in its own words;
 *  (4) second round: two of the same approver's requests in flight together
 *      (a double tap, a batch re-sent after "No answer"). Both pass the checks
 *      and wait at the claim, held there by a row lock this suite takes; the
 *      loser reads "Your decision already arrived", for an approve, a refusal
 *      and a reactivation, not a recorded lost race. Two different approvers racing the
 *      same way still read "just decided by another reviewer", recorded;
 *  (5) second round: a bulk card whose request came back to the approver in a
 *      new round (a colleague sent it back, the salesman sent it again) is
 *      answered "This request changed since you opened it", as on its own
 *      page, not "Already decided by a colleague"; a Manager elsewhere is
 *      still FORBIDDEN.
 *
 * GATED: writes only rows it creates (prefix ZZAA-) and deletes them after.
 * Never production.
 *
 *   RUN_APPROVAL_ANSWERS=1 DATABASE_URL=… DIRECT_URL=… \
 *     npx vitest run tests/integration/approval-answers.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals, purgeHistory } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { ALREADY_DECIDED_CODE } from '@/lib/already-decided';
import { STALE_VIEW_CODE, STALE_VIEW_MESSAGE } from '@/lib/decision-token';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_APPROVAL_ANSWERS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const tag = randomUUID().slice(0, 8);
const P = `ZZAA-${tag}`;
const ids = {
  region: `${P}-region`,
  other: `${P}-other`,
  route: `${P}-route`,
  otherRoute: `${P}-oroute`,
  sup: `${P}-sup`,
  sales: `${P}-sales`,
  acc: `${P}-acc`,
  m1: `${P}-m1`,
  m2: `${P}-m2`,
  mx: `${P}-mx`,
  customer: `${P}-cust`,
  b1: `${P}-b1`,
  b2: `${P}-b2`,
};
const people = [ids.sup, ids.sales, ids.acc, ids.m1, ids.m2, ids.mx];
const NAME = `ZZ-SYN Answer New ${tag}`;
const digits = (salt: number) => String(100000 + ((parseInt(tag, 16) + salt) % 900000));

const as = (id: string, role: string) => {
  current = { id, role, username: id };
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
type Result = {
  ok: boolean;
  code?: string;
  message?: string;
  data?: { editId?: string; successes?: string[]; failures?: Array<{ editId: string; code: string; message: string }> };
};
const ARRIVED = (did: string, step: string) =>
  `Your decision already arrived: you ${did} at the ${step} step. Nothing more was saved. Reload to see where it is now.`;
const COLLEAGUE = (who: string, did: string, step: string) =>
  `Already decided by a colleague: ${who} ${did} at the ${step} step. Nothing more was saved. Reload to see where it is now.`;

describe.skipIf(!ENABLED)('finding 21: a decision already made is answered as one', () => {
  let prisma: PrismaClient;
  let creates: typeof import('@/services/creates');
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');
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

    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.region.create({ data: { id: ids.other, code: `${P}-O`, name: `${P} Other` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    await prisma.route.create({ data: { id: ids.otherRoute, code: `${P}-ORT`, name: `${P} Other Route`, regionId: ids.other } });
    await prisma.user.create({ data: { id: ids.sup, username: ids.sup, passwordHash: 'x', fullName: 'ZZ Supervisor Sami', role: 'SUPERVISOR' } });
    await prisma.user.create({
      data: { id: ids.acc, username: ids.acc, passwordHash: 'x', fullName: 'ZZ Accountant Amal', role: 'ACCOUNTANT', managedRegions: { connect: { id: ids.region } } },
    });
    for (const [id, name, region] of [
      [ids.m1, 'ZZ Manager One', ids.region],
      [ids.m2, 'ZZ Manager Two', ids.region],
      [ids.mx, 'ZZ Manager Elsewhere', ids.other],
    ] as const) {
      await prisma.user.create({
        data: { id, username: id, passwordHash: 'x', fullName: name, role: 'MANAGER', managedRegions: { connect: { id: region } } },
      });
    }
    await prisma.user.create({
      data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Salesman Saif', role: 'SALESMAN', ownedRouteId: ids.route, supervisorId: ids.sup },
    });
    const ch = await prisma.channel.findFirst({ include: { subChannels: { take: 1 } } });
    if (!ch || ch.subChannels.length === 0) throw new Error('No channel/subchannel seeded.');
    channelId = ch.id;
    subChannelId = ch.subChannels[0]!.id;

    await prisma.customer.create({ data: { id: ids.customer, nmwcCode: `${P}-C`, legalName: 'ZZ Answer Co', paymentTerms: 'CASH' } });
    for (const [id, n] of [
      [ids.b1, '01'],
      [ids.b2, '02'],
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
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { submittedById: ids.sales }, select: { id: true } });
      const editIds = eds.map((e) => e.id);
      const created = (await prisma.customer.findMany({ where: { legalName: NAME }, select: { id: true } })).map((c) => c.id);
      const customers = [ids.customer, ...created];
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
      await prisma.route.deleteMany({ where: { id: { in: [ids.route, ids.otherRoute] } } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.region, ids.other] } } });
      await prisma.rateLimit.deleteMany({ where: { OR: people.map((u) => ({ key: { contains: u } })) } });
      await purgeHistory(prisma, {
        customerIds: customers,
        branchIds,
        userIds: people,
        routeIds: [ids.route, ids.otherRoute],
        regionIds: [ids.region, ids.other],
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
  /** `again`: the salesman sends a request that came back to him; `salt`: another request, its own CR and phone. */
  async function submitCreate(opts: { again?: string; salt?: number } = {}): Promise<string> {
    const salt = opts.salt ?? 0;
    as(ids.sales, 'SALESMAN');
    const res = (await creates.submitCreateAction({
      isDraft: false,
      ...(opts.again ? { editId: opts.again } : {}),
      customer: {
        legalName: NAME,
        paymentTerms: 'CASH',
        channelId,
        subChannelId,
        primaryPhone: `+96893${digits(1 + salt)}`,
        contactPerson: `ZZ Contact ${tag}`,
        crNumber: `92${digits(2 + salt)}`,
        crPhotoAttachmentId: await att('CR'),
      },
      branches: [
        {
          branchName: `ZZ New Shop ${tag}${salt ? ` ${salt}` : ''}`,
          address: `ZZ Way ${9 + salt}, ${tag}`,
          gpsLat: 23.61,
          gpsLng: 58.44,
          gpsManualReason: 'GPS would not lock inside the mall',
          dayOfVisit: 'MON',
          coolersCount: 1,
          standsCount: 1,
          emptyBottlesCount: 5,
          shopPhotoAttachmentId: await att('SHOP'),
          signboardPhotoAttachmentId: await att('SIGNBOARD'),
        },
      ],
    } as Parameters<typeof creates.submitCreateAction>[0])) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId!;
  }
  const approveWith = async (by: [string, string], editId: string, token: string) => {
    as(...by);
    return (await edits.approveEditAction(form({ editId, decisionToken: token }))) as Result;
  };
  const rejectWith = async (by: [string, string], editId: string, token: string) => {
    as(...by);
    return (await edits.rejectEditAction(form({ editId, decisionToken: token, reason: 'Please check again.', category: 'other' }))) as Result;
  };
  /** Everything a decision writes about a request: the row, its decisions, its audit rows, its alerts. */
  const footprint = async (editId: string) => ({
    row: await prisma.customerEdit.findUniqueOrThrow({
      where: { id: editId },
      select: { state: true, currentStepIndex: true, cycle: true, stageEnteredAt: true, reviewedById: true },
    }),
    decisions: await prisma.editApproval.count({ where: { editId } }),
    audit: await prisma.auditLog.count({ where: { entityType: 'CustomerEdit', entityId: editId } }),
    alerts: await prisma.notification.count({ where: { editId } }),
  });
  const M1: [string, string] = [ids.m1, 'MANAGER'];
  const M2: [string, string] = [ids.m2, 'MANAGER'];
  const MX: [string, string] = [ids.mx, 'MANAGER'];
  const SUP: [string, string] = [ids.sup, 'SUPERVISOR'];
  const SALES: [string, string] = [ids.sales, 'SALESMAN'];

  // ── (1) a new-customer request ─────────────────────────────────────────────
  describe('(1) a new-customer request approved at the Supervisor step by Manager One', () => {
    let id = '';
    let page = '';

    it('Manager One approves it; it moves to the Accountant', async () => {
      id = await submitCreate();
      page = await freshDecisionToken(prisma, id);
      const res = await approveWith(M1, id, page);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect((await footprint(id)).row).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 1 });
    });

    it('his second tap from the same page (the reply was lost): "Your decision already arrived", and nothing is written', async () => {
      const before = await footprint(id);
      const res = await approveWith(M1, id, page);
      expect(res).toMatchObject({ ok: false, code: ALREADY_DECIDED_CODE, message: ARRIVED('approved this request', 'Supervisor') });
      expect(res.message).not.toMatch(/not authorized/);
      // Send back from the same stale page: the same answer.
      const back = await rejectWith(M1, id, page);
      expect(back).toMatchObject({ ok: false, code: ALREADY_DECIDED_CODE, message: ARRIVED('approved this request', 'Supervisor') });
      expect(await footprint(id)).toEqual(before);
    });

    it('inside a bulk approve too: the item fails alone with that answer', async () => {
      as(...M1);
      const res = (await edits.bulkApproveEditsAction(form({ decisions: JSON.stringify([{ editId: id, decisionToken: page }]) }))) as Result;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(res.data!.successes).toEqual([]);
      // Third round: with the decision that stands, so the queue can tell it from the one the batch sent.
      expect(res.data!.failures).toEqual([
        { editId: id, code: ALREADY_DECIDED_CODE, message: ARRIVED('approved this request', 'Supervisor'), decided: 'APPROVED' },
      ]);
    });

    it('Manager Two of the same region, on a page from before: told Manager One approved it — a lost race, recorded', async () => {
      const before = await footprint(id);
      const res = await approveWith(M2, id, page);
      expect(res).toMatchObject({ ok: false, code: 'NOT_PENDING', message: COLLEAGUE('ZZ Manager One (Manager)', 'approved this request', 'Supervisor') });
      const conflict = await prisma.auditLog.findFirst({
        where: { action: 'CONFLICT', actorId: ids.m2, entityId: id },
        orderBy: { at: 'desc' },
      });
      expect(conflict, 'the lost race is recorded as before').not.toBeNull();
      expect((await footprint(id)).row).toEqual(before.row);
      expect((await footprint(id)).decisions).toBe(before.decisions);
    });

    it('a Manager of another region and the salesman are refused exactly as before: FORBIDDEN, nobody named', async () => {
      for (const who of [MX, SALES]) {
        const res = await approveWith(who, id, page);
        expect(res, who[0]).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'You are not authorized to act on this step.' });
        const back = await rejectWith(who, id, page);
        expect(back, who[0]).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      }
    });

    it('a token that does not match the visit is no key: Manager Two with a made-up stage is still FORBIDDEN', async () => {
      const made = JSON.parse(page) as Record<string, unknown>;
      made.stage = 1;
      const res = await approveWith(M2, id, JSON.stringify(made));
      expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    });

    it('the Accountant, on a fresh page, still decides: the answers changed no rule', async () => {
      const res = await approveWith([ids.acc, 'ACCOUNTANT'], id, await freshDecisionToken(prisma, id));
      // The last step asks for the Temix code; without one it is refused for that reason only.
      expect(res.ok).toBe(false);
      expect(res.message).not.toMatch(/already|not authorized/i);
    });
  });

  // ── (2) a close-shop request ───────────────────────────────────────────────
  async function sendClose(branchId: string): Promise<string> {
    as(...SALES);
    const res = (await reacts.markBranchClosedAction(
      form({ branchId, reason: 'The owner has left.', attachmentId: await evidence(branchId) })
    )) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId!;
  }

  describe('(2) a close-shop request', () => {
    it('approved by the Supervisor: his second tap, a colleague Manager, and a Manager elsewhere each get their answer', async () => {
      const id = await sendClose(ids.b1);
      const page = await freshDecisionToken(prisma, id);
      const ok = await approveWith(SUP, id, page);
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      expect((await footprint(id)).row.state).toBe('APPROVED');
      const before = await footprint(id);

      expect(await approveWith(SUP, id, page)).toMatchObject({ code: ALREADY_DECIDED_CODE, message: ARRIVED('approved this request', 'Supervisor') });
      expect(await approveWith(M2, id, page)).toMatchObject({
        code: 'NOT_PENDING',
        message: COLLEAGUE('ZZ Supervisor Sami (Supervisor)', 'approved this request', 'Supervisor'),
      });
      const elsewhere = await approveWith(MX, id, page);
      expect(elsewhere).toMatchObject({
        code: 'NOT_PENDING',
        message: 'This request is no longer waiting for a decision: it has already been approved. Reload to see where it is now.',
      });
      expect(elsewhere.message).not.toMatch(/state|APPROVED/);
      expect((await footprint(id)).row).toEqual(before.row);
      expect((await footprint(id)).decisions).toBe(before.decisions);
      // Open the shop again for the walk below.
      await prisma.branch.update({ where: { id: ids.b1 }, data: { status: 'ACTIVE' } });
      await prisma.customer.update({ where: { id: ids.customer }, data: { status: 'ACTIVE' } });
    });

    it('refused by the Supervisor: his second tap reads "refused", not a state name', async () => {
      const id = await sendClose(ids.b2);
      const page = await freshDecisionToken(prisma, id);
      const no = await rejectWith(SUP, id, page);
      expect(no.ok, JSON.stringify(no)).toBe(true);
      expect(await rejectWith(SUP, id, page)).toMatchObject({ code: ALREADY_DECIDED_CODE, message: ARRIVED('refused this request', 'Supervisor') });
      // Third round: a bulk APPROVE of the request he had refused says the refusal
      // stands (decided REJECTED), so the queue does not show it as done.
      as(...SUP);
      const bulk = (await edits.bulkApproveEditsAction(form({ decisions: JSON.stringify([{ editId: id, decisionToken: page }]) }))) as Result;
      expect(bulk.ok, JSON.stringify(bulk)).toBe(true);
      expect(bulk.data!.failures).toEqual([
        { editId: id, code: ALREADY_DECIDED_CODE, message: ARRIVED('refused this request', 'Supervisor'), decided: 'REJECTED' },
      ]);
      expect(await rejectWith(MX, id, page)).toMatchObject({
        message: 'This request is no longer waiting for a decision: it has already been turned down or closed. Reload to see where it is now.',
      });
    });
  });

  // ── (3) a reactivation ─────────────────────────────────────────────────────
  describe('(3) a reactivation', () => {
    it('approved by Manager One: his second tap, Manager Two, and the Manager elsewhere', async () => {
      await prisma.branch.update({ where: { id: ids.b1 }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 2 * DAY) } });
      as(...SALES);
      const sent = (await reacts.requestReactivationAction(
        form({ branchId: ids.b1, reason: 'Open again.', attachmentId: await evidence(ids.b1) })
      )) as Result;
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      const id = sent.data!.editId!;
      as(...M1);
      const ok = (await reacts.approveReactivationAction(form({ editId: id }))) as Result;
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      const before = await footprint(id);

      as(...M1);
      expect(await reacts.approveReactivationAction(form({ editId: id }))).toMatchObject({
        ok: false,
        code: ALREADY_DECIDED_CODE,
        message: ARRIVED('approved this reopening', 'Manager'),
      });
      as(...M2);
      expect(await reacts.rejectReactivationAction(form({ editId: id, reason: 'Still shut.' }))).toMatchObject({
        ok: false,
        code: 'NOT_PENDING',
        message: COLLEAGUE('ZZ Manager One (Manager)', 'approved this reopening', 'Manager'),
      });
      as(...MX);
      const elsewhere = (await reacts.approveReactivationAction(form({ editId: id }))) as Result & { fields?: Record<string, string> };
      expect(elsewhere).toMatchObject({
        ok: false,
        message: 'This request is no longer waiting for a decision: it has already been approved. Reload to see where it is now.',
      });
      expect(JSON.stringify(elsewhere)).not.toMatch(/ZZ Manager One|in state/);
      expect((await footprint(id)).row).toEqual(before.row);
      expect((await footprint(id)).decisions).toBe(before.decisions);
    });
  });
  // ── (4) second round: the same approver's two requests in flight together ──
  /**
   * Runs `work` while this suite holds the request's row lock, until `waiters`
   * other transactions wait for it — each decision has passed every check and
   * reached its claim — then lets them go. The first to get the row claims it;
   * the other's claim then matches nothing.
   */
  async function atTheClaimTogether<T>(editId: string, waiters: number, work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CustomerEdit" WHERE id = ${editId} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 90_000, maxWait: 10_000 }
    );
    await isLocked;
    const running = work();
    try {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (n >= waiters) break;
        if (Date.now() > deadline) throw new Error(`only ${n} of ${waiters} decisions reached the claim`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      release();
      await holder;
    }
    return running;
  }
  const lostRaceRows = (actorId: string, editId: string) =>
    prisma.auditLog.count({ where: { action: 'CONFLICT', actorId, entityId: editId } });
  const ANOTHER = 'This edit was just decided by another reviewer. Refresh to see the current state.';

  describe('(4) second round: a claim lost to the approver himself', () => {
    // Each case closes the second shop again: open it first, whatever the case before did.
    beforeEach(async () => {
      await prisma.branch.update({ where: { id: ids.b2 }, data: { status: 'ACTIVE' } });
      await prisma.customer.update({ where: { id: ids.customer }, data: { status: 'ACTIVE' } });
    });

    it('two approvals of a close request by the Supervisor at once: one approves, the other reads "Your decision already arrived"', async () => {
      const id = await sendClose(ids.b2);
      const page = await freshDecisionToken(prisma, id);
      const results = await atTheClaimTogether(id, 2, () =>
        Promise.all([approveWith(SUP, id, page), approveWith(SUP, id, page)])
      );
      const won = results.filter((r) => r.ok);
      const lost = results.filter((r) => !r.ok);
      expect(won, JSON.stringify(results)).toHaveLength(1);
      expect(lost[0]).toMatchObject({ ok: false, code: ALREADY_DECIDED_CODE, message: ARRIVED('approved this request', 'Supervisor') });
      expect(lost[0]!.message).not.toMatch(/another reviewer/);
      // His own decision is not a lost race: no CONFLICT row. One decision, once.
      expect(await lostRaceRows(ids.sup, id)).toBe(0);
      expect(await prisma.editApproval.count({ where: { editId: id } })).toBe(1);
      expect((await footprint(id)).row.state).toBe('APPROVED');
    });

    it('two refusals at once: the other reads "Your decision already arrived: you refused this request"', async () => {
      const id = await sendClose(ids.b2);
      const page = await freshDecisionToken(prisma, id);
      const results = await atTheClaimTogether(id, 2, () =>
        Promise.all([rejectWith(SUP, id, page), rejectWith(SUP, id, page)])
      );
      expect(results.filter((r) => r.ok), JSON.stringify(results)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: ALREADY_DECIDED_CODE, message: ARRIVED('refused this request', 'Supervisor') });
      expect(await lostRaceRows(ids.sup, id)).toBe(0);
      expect(await prisma.editApproval.count({ where: { editId: id } })).toBe(1);
    });

    it('a reactivation approved twice at once by Manager One: the other reads "Your decision already arrived"', async () => {
      await prisma.branch.update({ where: { id: ids.b1 }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 2 * DAY) } });
      as(...SALES);
      const sent = (await reacts.requestReactivationAction(
        form({ branchId: ids.b1, reason: 'Open again.', attachmentId: await evidence(ids.b1) })
      )) as Result;
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      const id = sent.data!.editId!;
      const results = (await atTheClaimTogether(id, 2, () => {
        as(...M1);
        return Promise.all([reacts.approveReactivationAction(form({ editId: id })), reacts.approveReactivationAction(form({ editId: id }))]);
      })) as Result[];
      expect(results.filter((r) => r.ok), JSON.stringify(results)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: ALREADY_DECIDED_CODE, message: ARRIVED('approved this reopening', 'Manager') });
      expect(await lostRaceRows(ids.m1, id)).toBe(0);
      expect(await prisma.editApproval.count({ where: { editId: id } })).toBe(1);
    });

    it('two different approvers at once: the loser still reads "just decided by another reviewer", recorded as a lost race', async () => {
      const id = await sendClose(ids.b2);
      const page = await freshDecisionToken(prisma, id);
      const [sup, m2] = await atTheClaimTogether(id, 2, () =>
        Promise.all([approveWith(SUP, id, page), approveWith(M2, id, page)])
      );
      const loser = sup!.ok ? { res: m2!, id: ids.m2 } : { res: sup!, id: ids.sup };
      expect(sup!.ok !== m2!.ok, JSON.stringify([sup, m2])).toBe(true);
      expect(loser.res).toMatchObject({ ok: false, code: 'NOT_PENDING', message: ANOTHER });
      expect(await lostRaceRows(loser.id, id)).toBe(1);
      expect(await prisma.editApproval.count({ where: { editId: id } })).toBe(1);
    });
  });
  // ── (5) second round: a bulk card that came back to the approver ─────────────
  describe('(5) second round: a bulk card whose request came back to the approver in a new round', () => {
    it('Manager One sends it back, the salesman sends it again: Manager Two’s and Manager One’s old cards read STALE_VIEW', async () => {
      const id = await submitCreate({ salt: 50 });
      const page = await freshDecisionToken(prisma, id);
      const back = await rejectWith(M1, id, page);
      expect(back.ok, JSON.stringify(back)).toBe(true);
      expect((await footprint(id)).row.state).toBe('NEEDS_CORRECTION');
      expect(await submitCreate({ again: id, salt: 50 })).toBe(id);
      const live = (await footprint(id)).row;
      expect(live).toMatchObject({ state: 'SUBMITTED', currentStepIndex: 0 });
      expect(live.cycle).toBeGreaterThan(JSON.parse(page).cycle as number);
      const before = await footprint(id);

      const bulk = async (by: [string, string]) => {
        as(...by);
        return (await edits.bulkApproveEditsAction(form({ decisions: JSON.stringify([{ editId: id, decisionToken: page }]) }))) as Result;
      };
      for (const who of [M2, M1]) {
        const res = await bulk(who);
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.data!.successes).toEqual([]);
        expect(res.data!.failures, who[0]).toEqual([{ editId: id, code: STALE_VIEW_CODE, message: STALE_VIEW_MESSAGE }]);
      }
      // Someone who cannot decide it now is refused as before, nobody named.
      const elsewhere = await bulk(MX);
      expect(elsewhere.data!.failures).toEqual([{ editId: id, code: 'FORBIDDEN', message: 'You are not authorized to act on this step.' }]);
      expect((await footprint(id)).row).toEqual(before.row);
      expect((await footprint(id)).decisions).toBe(before.decisions);
      // And from a fresh page Manager Two still decides it: no rule changed.
      const fresh = await approveWith(M2, id, await freshDecisionToken(prisma, id));
      expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    });
  });
});
