// @vitest-environment node
/**
 * F1 (2026-10-05): a salesman's request tells his hierarchy, in the same commit
 * as the request — against a real Postgres, through the real services.
 *
 *   - An update request: his supervisor must act (EDIT_SUBMITTED, unchanged) and
 *     his region's Accountant is told for information (REQUEST_FYI).
 *   - A close-shop request (A1.7): his supervisor, if he can act on it, else the
 *     region's active Managers; the Accountant for information.
 *   - A reactivation request (A1.7): his supervisor if he is a Manager over the
 *     region, else the region's active Managers, as REACTIVATION_REQUESTED; the
 *     Accountant for information.
 *   - Never the GM, a Steward, a Viewer, another region's Accountant or the
 *     salesman himself.
 *   - A replay (answered from its receipt) and a refused insert (another request
 *     already open: P2002, rolled back whole) write no notification.
 *
 * Launch fixes (2026-10-07), through the real decisions:
 *   - an update request whose supervisor cannot act on it (disabled, none) tells
 *     the region's active Managers, as a close request does;
 *   - the salesman is told how his reactivation and close requests ended, and a
 *     refused close or a "Keep closed" is final (REJECTED, off his Needs
 *     correction lists), with his own reason kept beside the reviewer's;
 *   - a decision marks every other Manager's row about that request read, so it
 *     stops counting in their red bells; the Accountant's FYI row is left alone.
 *
 * GATED: RUN_NOTIFY_WRITERS=1. It needs the F1 migrations (the new kinds), so it
 * runs in CI's db-tests job, not against a database that has not had them. Writes
 * only rows it creates (prefix ZZNW-) and deletes them after. Never production.
 *
 *   RUN_NOTIFY_WRITERS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/notify-request-writers.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { editPayload } from '../support/edit-payload';
import { freshDecisionToken } from '../support/decision-token';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const ENABLED = process.env.RUN_NOTIFY_WRITERS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const tag = randomUUID().slice(0, 8);
const P = `ZZNW-${tag}`;
// Ids are cuid-shaped (a 'c', then no dash): the request actions validate the
// customer, branch and attachment ids they receive with zod's cuid() before any
// work, so a dashed fixture id is refused as VALIDATION_FAILED.
const cid = (name: string) => `cznw${tag}${name}`;
const ids = {
  region: cid('region'),
  otherRegion: cid('regiontwo'),
  route: cid('route'),
  sales: cid('sales'),
  mgrA: cid('mgra'),
  mgrB: cid('mgrb'),
  mgrOff: cid('mgroff'),
  sup: cid('sup'),
  acc: cid('acc'),
  accOther: cid('acctwo'),
  gm: cid('gm'),
  stw: cid('stw'),
  viewer: cid('viewer'),
  customer: cid('cust'),
  branch: cid('branchone'),
  shop: cid('shop'),
};
const USERS = [ids.sales, ids.mgrA, ids.mgrB, ids.mgrOff, ids.sup, ids.acc, ids.accOther, ids.gm, ids.stw, ids.viewer];
const NEVER = [ids.gm, ids.stw, ids.viewer, ids.accOther, ids.sales, ids.mgrOff];

const asSalesman = () => {
  current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe.skipIf(!ENABLED)('F1: a salesman request notifies his hierarchy, in its own commit', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    reacts = await import('@/services/reactivations');

    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.region.create({ data: { id: ids.otherRegion, code: `${P}-R2`, name: `${P} Region 2` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    const user = (id: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { id, username: id, passwordHash: 'x', fullName: `ZZ ${role}`, role: role as never, ...extra } });
    const inRegion = (r: string) => ({ managedRegions: { connect: { id: r } } });
    await user(ids.mgrA, 'MANAGER', inRegion(ids.region));
    await user(ids.mgrB, 'MANAGER', inRegion(ids.region));
    await user(ids.mgrOff, 'MANAGER', { ...inRegion(ids.region), isActive: false });
    await user(ids.sup, 'SUPERVISOR');
    await user(ids.acc, 'ACCOUNTANT', inRegion(ids.region));
    await user(ids.accOther, 'ACCOUNTANT', inRegion(ids.otherRegion));
    // Org-wide roles, given the region too: only their ROLE must keep them out.
    await user(ids.gm, 'GM', inRegion(ids.region));
    await user(ids.stw, 'STEWARD', inRegion(ids.region));
    await user(ids.viewer, 'VIEWER', inRegion(ids.region));
    await user(ids.sales, 'SALESMAN', { ownedRouteId: ids.route, supervisorId: ids.mgrA });

    const ch = await prisma.channel.findFirst({ where: { isActive: true } });
    if (!ch) throw new Error('No channel seeded.');
    await prisma.customer.create({
      data: {
        id: ids.customer,
        nmwcCode: `${P}-C`,
        legalName: `ZZ Notify Co ${tag}`,
        paymentTerms: 'CASH',
        channelId: ch.id,
        primaryPhone: '+96890000001',
        primaryPhoneNorm: '+96890000001',
        contactPerson: 'ZZ Contact',
        notes: 'Synthetic',
      },
    });
    await prisma.attachment.create({
      data: { id: ids.shop, kind: 'SHOP', r2Key: `${P}/shop.jpg`, mimeType: 'image/jpeg', bytes: 1, capturedById: ids.sales, capturedAt: new Date() },
    });
    await prisma.branch.create({
      data: {
        id: ids.branch,
        customerId: ids.customer,
        branchCode: `${P}-B-01`,
        branchName: 'Main',
        regionId: ids.region,
        routeId: ids.route,
        address: 'ZZ synthetic address',
        gpsLat: 23.6,
        gpsLng: 58.4,
        status: 'ACTIVE',
        shopPhotoId: ids.shop,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.customer }, select: { id: true } });
      const editIds = eds.map((e) => e.id);
      // Notification.userId is ON DELETE RESTRICT: every row these users hold
      // goes before the users do, whatever test left it.
      await prisma.notification.deleteMany({ where: { OR: [{ editId: { in: editIds } }, { userId: { in: USERS } }] } });
      if (editIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      }
      await purgeAuditLog(prisma, { where: { actorId: { in: USERS } } });
      await prisma.rateLimit.deleteMany({ where: { key: { in: USERS.flatMap((u) => [`edit:${u}`, `photo:${u}`]) } } });
      await prisma.branch.updateMany({ where: { customerId: ids.customer }, data: { shopPhotoId: null } });
      await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
      await prisma.branch.deleteMany({ where: { customerId: ids.customer } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.user.updateMany({ where: { id: { in: USERS } }, data: { ownedRouteId: null, supervisorId: null } });
      await prisma.user.deleteMany({ where: { id: { in: USERS } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.region, ids.otherRegion] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  /** A clean slate for each case: no open request on the customer, the branch open, his supervisor Manager A. */
  beforeEach(async () => {
    const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.customer }, select: { id: true } });
    const editIds = eds.map((e) => e.id);
    if (editIds.length) {
      await prisma.notification.deleteMany({ where: { editId: { in: editIds } } });
      await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
      await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    }
    await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.rateLimit.deleteMany({ where: { key: { in: USERS.map((u) => `edit:${u}`) } } });
    await prisma.branch.update({ where: { id: ids.branch }, data: { status: 'ACTIVE', lastStatusChangeAt: new Date(Date.now() - DAY) } });
    await prisma.user.update({ where: { id: ids.sales }, data: { supervisorId: ids.mgrA } });
  });

  /** Who holds a row about this request, by kind, sorted. */
  async function told(editId: string) {
    const rows = await prisma.notification.findMany({ where: { editId }, select: { userId: true, kind: true } });
    const by: Record<string, string[]> = {};
    for (const r of rows) (by[r.kind] ??= []).push(r.userId);
    for (const k of Object.keys(by)) by[k]!.sort();
    return by;
  }
  async function noneOfNever() {
    expect(await prisma.notification.count({ where: { userId: { in: NEVER } } })).toBe(0);
  }

  async function evidence(): Promise<string> {
    const a = await prisma.attachment.create({
      data: {
        kind: 'FREE',
        r2Key: `${P}/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1,
        capturedById: ids.sales,
        capturedAt: new Date(),
        branchExtraId: ids.branch,
      },
    });
    return a.id;
  }

  it('an update request: the supervisor must act, the region’s Accountant is told; a replay writes nothing more', async () => {
    asSalesman();
    const sid = randomUUID();
    const body = { ...(await editPayload(prisma, { customerId: ids.customer, isDraft: false, customer: { notes: `Note ${tag}` } })), submissionId: sid };
    const first = await edits.submitEditAction(body);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(await told(first.data.editId)).toEqual({ EDIT_SUBMITTED: [ids.mgrA], REQUEST_FYI: [ids.acc] });
    await noneOfNever();

    const before = await prisma.notification.count({ where: { userId: { in: USERS } } });
    const retry = await edits.submitEditAction(body);
    expect(retry.ok && retry.data.replayed).toBe(true);
    expect(await prisma.notification.count({ where: { userId: { in: USERS } } })).toBe(before);
  });

  it('a close request: his supervisor and the Accountant, in the commit; a replay and a refused second request write nothing', async () => {
    asSalesman();
    const photo = await evidence();
    const sid = randomUUID();
    const close = (s: string, reason = 'Shop shut, seen today.') =>
      reacts.markBranchClosedAction(form({ branchId: ids.branch, reason, attachmentId: photo, submissionId: s }));
    const first = await close(sid);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(await told(first.data.editId)).toEqual({ EDIT_SUBMITTED: [ids.mgrA], REQUEST_FYI: [ids.acc] });
    // The salesman's free-text reason never reaches a notification.
    expect(await prisma.notification.count({ where: { editId: first.data.editId, body: { contains: 'seen today' } } })).toBe(0);
    await noneOfNever();

    const before = await prisma.notification.count({ where: { userId: { in: USERS } } });
    const retry = await close(sid);
    expect(retry.ok && retry.data.replayed).toBe(true);
    // A different close while the first is open: refused by the one-open-request
    // index (P2002) inside the transaction, which rolls back with its rows.
    const second = await close(randomUUID(), 'Shop shut, shutters down.');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('OPEN_EDIT_EXISTS');
    expect(await prisma.notification.count({ where: { userId: { in: USERS } } })).toBe(before);
  });

  it('a close request whose supervisor cannot act falls back to the region’s active Managers', async () => {
    for (const supervisorId of [ids.mgrOff, null]) {
      const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.customer }, select: { id: true } });
      if (eds.length) {
        await prisma.notification.deleteMany({ where: { editId: { in: eds.map((e) => e.id) } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: eds.map((e) => e.id) } } });
      }
      await prisma.user.update({ where: { id: ids.sales }, data: { supervisorId } });
      asSalesman();
      const res = await reacts.markBranchClosedAction(
        form({ branchId: ids.branch, reason: 'Shop shut, seen today.', attachmentId: await evidence(), submissionId: randomUUID() })
      );
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      expect(await told(res.data.editId), String(supervisorId)).toEqual({
        EDIT_SUBMITTED: [ids.mgrA, ids.mgrB].sort(),
        REQUEST_FYI: [ids.acc],
      });
    }
    await noneOfNever();
  });

  it('a reactivation: REACTIVATION_REQUESTED to his Manager, linked to /reactivations; the Accountant told', async () => {
    await prisma.branch.update({ where: { id: ids.branch }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - DAY) } });
    asSalesman();
    const sid = randomUUID();
    const photo = await evidence();
    const fd = () => form({ branchId: ids.branch, reason: 'Open again, same owner.', attachmentId: photo, submissionId: sid });
    const first = await reacts.requestReactivationAction(fd());
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(await told(first.data.editId)).toEqual({ REACTIVATION_REQUESTED: [ids.mgrA], REQUEST_FYI: [ids.acc] });
    await noneOfNever();

    const row = await prisma.notification.findFirstOrThrow({
      where: { editId: first.data.editId, kind: 'REACTIVATION_REQUESTED' },
      select: { kind: true, editId: true, customerId: true, edit: { select: { isReactivation: true } } },
    });
    const { hrefFor } = await import('@/lib/notification-links');
    expect(hrefFor(row, 'MANAGER')).toBe('/reactivations');

    const before = await prisma.notification.count({ where: { userId: { in: USERS } } });
    const retry = await reacts.requestReactivationAction(fd());
    expect(retry.ok && retry.data.replayed).toBe(true);
    expect(await prisma.notification.count({ where: { userId: { in: USERS } } })).toBe(before);
  });

  it('a reactivation whose supervisor is not a Manager over the region goes to every active Manager of it', async () => {
    await prisma.user.update({ where: { id: ids.sales }, data: { supervisorId: ids.sup } });
    await prisma.branch.update({ where: { id: ids.branch }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - DAY) } });
    asSalesman();
    const res = await reacts.requestReactivationAction(
      form({ branchId: ids.branch, reason: 'Open again, same owner.', attachmentId: await evidence(), submissionId: randomUUID() })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(await told(res.data.editId)).toEqual({
      REACTIVATION_REQUESTED: [ids.mgrA, ids.mgrB].sort(),
      REQUEST_FYI: [ids.acc],
    });
    await noneOfNever();
  });

  // ── Launch fixes (2026-10-07) ──────────────────────────────────────────────

  /** Who still holds an UNREAD row about this request, by kind, sorted. */
  async function unread(editId: string) {
    const rows = await prisma.notification.findMany({ where: { editId, readAt: null }, select: { userId: true, kind: true } });
    const by: Record<string, string[]> = {};
    for (const r of rows) (by[r.kind] ??= []).push(r.userId);
    for (const k of Object.keys(by)) by[k]!.sort();
    return by;
  }
  const asManager = (id: string) => {
    current = { id, role: 'MANAGER', username: id };
  };
  /** What his Needs correction lists count (app/(app)/rejected, today, work). */
  const needsCorrection = () => prisma.customerEdit.count({ where: { submittedById: ids.sales, state: 'NEEDS_CORRECTION' } });

  it('an update request whose supervisor cannot act tells the region’s active Managers', async () => {
    for (const supervisorId of [ids.mgrOff, null]) {
      const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.customer }, select: { id: true } });
      if (eds.length) {
        await prisma.notification.deleteMany({ where: { editId: { in: eds.map((e) => e.id) } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: eds.map((e) => e.id) } } });
      }
      await prisma.user.update({ where: { id: ids.sales }, data: { supervisorId } });
      asSalesman();
      const body = {
        ...(await editPayload(prisma, { customerId: ids.customer, isDraft: false, customer: { notes: `Note ${randomUUID()}` } })),
        submissionId: randomUUID(),
      };
      const res = await edits.submitEditAction(body);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      // Before: the disabled Manager was told and nobody else; with none, nobody at all.
      expect(await told(res.data.editId), String(supervisorId)).toEqual({
        EDIT_SUBMITTED: [ids.mgrA, ids.mgrB].sort(),
        REQUEST_FYI: [ids.acc],
      });
    }
    await noneOfNever();
  });

  async function reactivationToBothManagers(): Promise<string> {
    // His supervisor is a Supervisor, so a reactivation goes to both Managers of the region.
    await prisma.user.update({ where: { id: ids.sales }, data: { supervisorId: ids.sup } });
    await prisma.branch.update({ where: { id: ids.branch }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - DAY) } });
    asSalesman();
    const res = await reacts.requestReactivationAction(
      form({ branchId: ids.branch, reason: 'Open again, same owner.', attachmentId: await evidence(), submissionId: randomUUID() })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error('reactivation not sent');
    expect(await unread(res.data.editId)).toEqual({ REACTIVATION_REQUESTED: [ids.mgrA, ids.mgrB].sort(), REQUEST_FYI: [ids.acc] });
    return res.data.editId;
  }

  it('a reactivation approved: the salesman is told, and the other Manager’s row stops counting', async () => {
    const editId = await reactivationToBothManagers();
    asManager(ids.mgrA);
    const res = await reacts.approveReactivationAction(form({ editId }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // Both Managers' rows are answered; the Accountant's information stays his to read.
    expect(await unread(editId)).toEqual({ REQUEST_FYI: [ids.acc], EDIT_APPROVED_FINAL: [ids.sales] });
    const outcome = await prisma.notification.findFirstOrThrow({ where: { editId, userId: ids.sales }, select: { title: true, customerId: true } });
    expect(outcome).toEqual({ title: 'Reactivation approved', customerId: ids.customer });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).status).toBe('ACTIVE');
    // His reason for asking is still the request's.
    expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } })).decisionReason).toBe('Open again, same owner.');
  });

  it('"Keep closed": final, off his Needs correction lists, both reasons kept, and he is told why', async () => {
    const before = await needsCorrection();
    const editId = await reactivationToBothManagers();
    asManager(ids.mgrB);
    const why = 'Still shut, I phoned the owner.';
    const res = await reacts.rejectReactivationAction(form({ editId, reason: why }));
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const row = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect(row).toMatchObject({ state: 'REJECTED', reviewedById: ids.mgrB, decisionReason: 'Open again, same owner.' });
    expect(await needsCorrection()).toBe(before);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: editId, action: 'REJECT' }, select: { reason: true } });
    expect(audit.reason).toBe(why);

    expect(await unread(editId)).toEqual({ REQUEST_FYI: [ids.acc], EDIT_NEEDS_CORRECTION: [ids.sales] });
    const outcome = await prisma.notification.findFirstOrThrow({ where: { editId, userId: ids.sales }, select: { title: true, body: true } });
    expect(outcome.title).toBe('Reactivation refused');
    expect(outcome.body).toContain(why);
    // The salesman's own free-text reason still never reaches a notification.
    expect(await prisma.notification.count({ where: { editId, body: { contains: 'same owner' } } })).toBe(0);
  });

  async function closeToSupervisor(): Promise<string> {
    asSalesman();
    const res = await reacts.markBranchClosedAction(
      form({ branchId: ids.branch, reason: 'Shop shut, seen today.', attachmentId: await evidence(), submissionId: randomUUID() })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error('close not sent');
    expect(await unread(res.data.editId)).toEqual({ EDIT_SUBMITTED: [ids.mgrA], REQUEST_FYI: [ids.acc] });
    return res.data.editId;
  }
  const decide = async (editId: string, extra: Record<string, string> = {}) =>
    form({ editId, decisionToken: await freshDecisionToken(prisma, editId), ...extra });

  it('a close refused by another Manager: final, both reasons kept, the supervisor’s row answered, the salesman told', async () => {
    const before = await needsCorrection();
    const editId = await closeToSupervisor();
    asManager(ids.mgrB);
    const why = 'Shutters were up at noon, it is open.';
    const res = await edits.rejectEditAction(await decide(editId, { reason: why, category: 'other' }));
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const row = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect(row).toMatchObject({ state: 'REJECTED', reviewedById: ids.mgrB, decisionReason: 'Shop shut, seen today.' });
    expect(await needsCorrection()).toBe(before);
    const step = await prisma.editApproval.findFirstOrThrow({ where: { editId }, select: { decision: true, reason: true } });
    expect(step).toEqual({ decision: 'REJECTED', reason: why });

    expect(await unread(editId)).toEqual({ REQUEST_FYI: [ids.acc], EDIT_NEEDS_CORRECTION: [ids.sales] });
    const outcome = await prisma.notification.findFirstOrThrow({ where: { editId, userId: ids.sales }, select: { title: true, body: true } });
    expect(outcome.title).toBe('Close-shop request refused');
    expect(outcome.body).toContain(why);
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).status).toBe('ACTIVE');
  });

  it('a close approved by another Manager: the supervisor’s row answered, the salesman told the branch is closed', async () => {
    const editId = await closeToSupervisor();
    asManager(ids.mgrB);
    const res = await edits.approveEditAction(await decide(editId));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await unread(editId)).toEqual({ REQUEST_FYI: [ids.acc], EDIT_APPROVED_FINAL: [ids.sales] });
    const outcome = await prisma.notification.findFirstOrThrow({ where: { editId, userId: ids.sales }, select: { title: true } });
    expect(outcome.title).toBe('Close-shop request approved');
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).status).toBe('CLOSED');
  });

  it('every new row waits in the e-mail outbox (emailedAt NULL); none is PRE_FEATURE', async () => {
    asSalesman();
    const res = await reacts.markBranchClosedAction(
      form({ branchId: ids.branch, reason: 'Shop shut, seen today.', attachmentId: await evidence(), submissionId: randomUUID() })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const rows = await prisma.notification.findMany({
      where: { editId: res.data.editId },
      select: { emailedAt: true, emailStatus: true, emailAttempts: true, emailLeaseUntil: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ emailedAt: null, emailStatus: null, emailAttempts: 0, emailLeaseUntil: null });
  });
});
