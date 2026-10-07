// @vitest-environment node
/**
 * Phase 2 (auditor recheck 2026-09-27): the FINAL approval of a customer UPDATE,
 * with Prisma mocked. services/edits.ts approveEditCore, lib/edit-approval.ts,
 * lib/edit-scope.ts and lib/channel-pair.ts are real. The mocked `$transaction`
 * records whether its callback threw: a real one rolls back everything it wrote.
 *
 *   F06 — each stored change is judged against the customer as read under the
 *         lock. One whose field changed since it was sent (to anything but its
 *         own new value) refuses the whole approval: STALE_BEFORE, nothing
 *         written, the request still pending. One already live is left out; a
 *         request that is all live writes nothing to the customer (ruling 5).
 *   F05 — the mandatory-field re-check runs on the branches frozen at submit,
 *         whatever happened to the routes since.
 *   Owner decision 4 (2026-10-07) — of that set, only the branches the request
 *         changes, and the customer's fields only when it changes one.
 *   Owner decision 3 (2026-10-07) — a Manager decides a request only when he
 *         manages the region of every branch it is about.
 *   F16 — a sub-channel retired since submit is CHANNEL_PAIR_INVALID; a
 *         channel change stored with no sub-channel (the old form's shape)
 *         is refused in words that name the customer's current sub-channel.
 * Also the approval page's helper (ruling 8), which decides with the same plan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { decisionTokenFor, type DecisionRow } from '@/lib/decision-token';
import {
  CHANNEL_ONLY_PAIR_INVALID_MESSAGE,
  CHANNEL_PAIR_INVALID_MESSAGE,
  channelPairInvalidMessage,
  planApproval,
  sentByPreviousForm,
  staleBeforeMessage,
  staleFieldLabels,
  staleLabelsForPendingEdit,
  storedFieldChanges,
} from '@/lib/edit-approval';

const SALES = 'u-sales';
const SUP = 'u-sup';
const CUST = 'c1';
const B1 = 'b1'; // the submitter's own branch (route r1)
const B2 = 'b2'; // another salesman's branch (route r2)
const B3 = 'b3'; // created after the request was sent
const CH_A = 'ch-a';
const SUB_A = 'sub-a';
const PHOTO = 'p-close';

const h = vi.hoisted(() => ({
  user: { id: 'u-sup', role: 'SUPERVISOR', username: 'sup' } as { id: string; role: string; username: string },
  scope: { ownedRouteId: null as string | null, teamRouteIds: ['r1'], managedRegionIds: [] as string[] },
  rolledBack: false,
}));
const tx = vi.hoisted(() => ({
  customerEdit: { updateMany: vi.fn() },
  editApproval: { create: vi.fn() },
  attachment: { findMany: vi.fn() },
  customer: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  branch: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  channel: { findUnique: vi.fn() },
  subChannel: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}));
const db = vi.hoisted(() => ({
  customerEdit: { findUnique: vi.fn() },
  editApproval: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  customer: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));
const notify = vi.hoisted(() => ({ notifyUsers: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/audit', () => audit);
vi.mock('@/lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/access')>()),
  loadScope: async () => h.scope,
}));
vi.mock('@/lib/notifications', () => ({
  notifyUsers: notify.notifyUsers,
  resolveStepAudience: vi.fn(async () => []),
  resolveStewardAudience: vi.fn(async () => []),
  settleRequestAlerts: vi.fn(async () => 0),
}));
// F1: the services also write the hierarchy's rows (lib/notify-hierarchy.ts);
// mocked here like '@/lib/notifications', so these suites keep testing what they test.
vi.mock('@/lib/notify-hierarchy', () => ({
  notifySalesmanRequest: vi.fn(async () => ({ mustAct: [], fyi: [] })),
}));
vi.mock('@/lib/completeness', () => ({ scoreCustomer: () => 50, scoreBranch: () => 50 }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));

import { approveEditAction, bulkApproveEditsAction, rejectEditAction } from '@/services/edits';

type Row = Record<string, unknown>;
type Change = { field: string; before: unknown; after: unknown };

const branchRow = (over: Row = {}): Row => ({
  id: B1,
  branchCode: 'MCT-0001',
  routeId: 'r1',
  regionId: 'g1',
  status: 'ACTIVE',
  deletedAt: null,
  address: 'Way 1, Ruwi',
  gpsLat: 23.6,
  gpsLng: 58.4,
  gpsAccuracy: 8,
  gpsCapturedAt: new Date('2026-09-20T08:00:00.000Z'),
  dayOfVisit: 'SUN',
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  shopPhotoId: 'p-shop',
  signboardPhotoId: 'p-sign',
  ...over,
});
/** B2 is another route's and has nothing: no GPS, no photos. */
const foreignBranch = (over: Row = {}): Row =>
  branchRow({ id: B2, branchCode: 'MCT-0002', routeId: 'r2', gpsLat: null, gpsLng: null, shopPhotoId: null, ...over });
const customerRow = (over: Row = {}, branches: Row[] = [branchRow(), foreignBranch()]): Row => ({
  id: CUST,
  legalName: 'Al Noor Trading',
  nmwcCode: 'NMWC-000001',
  paymentTerms: 'CASH',
  status: 'ACTIVE',
  deletedAt: null,
  crNumber: '1234567',
  crPhotoId: 'p-cr',
  channelId: CH_A,
  subChannelId: SUB_A,
  primaryPhone: '+96891234567',
  altPhone: '+96899887766',
  contactPerson: 'Said',
  contactRole: 'Owner',
  notes: 'Old note',
  version: 3,
  branches,
  ...over,
});

const sentAt = new Date('2026-09-27T06:00:00.000Z');
/** A salesman's pending enrichment request, gated at submit on [B1]. */
function request(fieldChanges: Change[], over: Row = {}): Row {
  return {
    id: 'e1',
    process: 'UPDATE',
    target: 'CUSTOMER',
    state: 'SUBMITTED',
    isReactivation: false,
    customerId: CUST,
    branchId: null,
    submittedById: SALES,
    submittedBy: { id: SALES, supervisorId: SUP, fullName: 'Salesman One' },
    // What approveEditCore's pre-transaction read returns (authorization, EL-01).
    customer: customerRow(),
    customerDraft: null,
    branchDrafts: [],
    approvalChain: null,
    currentStepIndex: 0,
    cycle: 1,
    submittedAt: sentAt,
    stageEnteredAt: sentAt,
    slaDueAt: null,
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    fieldChanges,
    attachmentChanges: [],
    submitGate: { v: 1, branchIds: [B1] },
    ...over,
  };
}

/** The customer as the approval reads it under the lock. */
let now: Row | null = customerRow();

const approve = async () => {
  const loaded = (await db.customerEdit.findUnique()) as DecisionRow;
  const fd = new FormData();
  fd.set('editId', 'e1');
  fd.set('decisionToken', decisionTokenFor(loaded, []));
  return approveEditAction(fd);
};
type Fail = { ok: false; code: string; message: string };
const failed = (r: unknown) => {
  expect((r as { ok: boolean }).ok, JSON.stringify(r)).toBe(false);
  return r as Fail;
};
/** Anything written to the customer or its branches: the apply, the rescore, the Temix requeue. */
const masterWrites = () =>
  tx.customer.updateMany.mock.calls.length +
  tx.customer.update.mock.calls.length +
  tx.branch.updateMany.mock.calls.length +
  tx.branch.update.mock.calls.length;
/**
 * When a mock was first called. A mock never called throws: with a -1 fallback,
 * "the lock before the read" passed with the lock removed (phase-2 review,
 * finding 16), so every order assertion here also proves the call happened.
 */
const order = (f: { mock: { invocationCallOrder: number[] } }) => {
  const n = f.mock.invocationCallOrder[0];
  if (n === undefined) throw new Error('order(): this mock was never called');
  return n;
};

beforeEach(() => {
  h.rolledBack = false;
  h.user = { id: SUP, role: 'SUPERVISOR', username: 'sup' };
  now = customerRow();
  for (const group of [tx.customerEdit, tx.editApproval, tx.attachment, tx.customer, tx.branch, tx.channel, tx.subChannel]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  for (const group of [db.customerEdit, db.editApproval, db.user, db.customer]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  for (const f of [audit.writeAudit, notify.notifyUsers, log.info, log.warn]) f.mockReset();
  audit.getAuditEnvelope.mockReset().mockResolvedValue({ actorId: SUP, ip: null, userAgent: null });
  tx.$queryRaw.mockReset().mockResolvedValue([]);
  db.$transaction.mockReset().mockImplementation(async (fn: (t: typeof tx) => unknown) => {
    try {
      return await fn(tx);
    } catch (err) {
      h.rolledBack = true;
      throw err;
    }
  });
  db.editApproval.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({ role: 'SALESMAN', ownedRouteId: 'r1' });
  db.customer.findFirst.mockResolvedValue(null);
  tx.customerEdit.updateMany.mockResolvedValue({ count: 1 });
  tx.customer.findUnique.mockImplementation(async () => now);
  tx.customer.findUniqueOrThrow.mockImplementation(async () => ({ ...now }));
  tx.customer.updateMany.mockResolvedValue({ count: 1 });
  tx.branch.findUniqueOrThrow.mockResolvedValue({ version: 5, status: 'ACTIVE' });
  tx.branch.updateMany.mockResolvedValue({ count: 1 });
  tx.channel.findUnique.mockResolvedValue({ isActive: true });
  tx.subChannel.findUnique.mockResolvedValue({ channelId: CH_A, isActive: true });
});

describe('F06 — STALE_BEFORE: a field changed since the request was sent refuses the approval', () => {
  it('rolled back whole: no write, no audit, no notification, the request still pending', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([
        { field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' },
        { field: 'customer.contactPerson', before: 'Said', after: 'Ali' },
      ])
    );
    now = customerRow({ contactPerson: 'Hamad (import)' });
    const res = failed(await approve());
    expect(res.code).toBe('STALE_BEFORE');
    expect(res.message).toBe(staleBeforeMessage(['Contact person']));
    expect(res.message).not.toContain('Hamad');
    expect(h.rolledBack).toBe(true);
    expect(masterWrites()).toBe(0);
    expect(audit.writeAudit).not.toHaveBeenCalled();
    expect(notify.notifyUsers).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { editId: 'e1', fields: ['customer.contactPerson'] },
      'edit.approve.stale_before'
    );
  });

  it('decided under the lock: the lock, then the read, then the write', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' }])
    );
    expect((await approve()).ok).toBe(true);
    // The first raw statement is the customer's row lock (lib/locks.ts) — on
    // this customer, not merely some statement that happened to run first.
    const [sql, id] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/FROM "Customer" WHERE "id" = \? FOR UPDATE/);
    expect(id).toBe(CUST);
    expect(order(tx.$queryRaw)).toBeLessThan(order(tx.customer.findUnique));
    expect(order(tx.customer.findUnique)).toBeLessThan(order(tx.customer.updateMany));
    expect(tx.customer.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: CUST, version: 3 },
      data: { notes: 'Closed Fridays' },
    });
  });

  it('a field already holding the new value is left out of the write', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([
        { field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' },
        { field: 'customer.contactPerson', before: 'Said', after: 'Ali' },
      ])
    );
    now = customerRow({ contactPerson: 'Ali' });
    expect((await approve()).ok).toBe(true);
    const data = tx.customer.updateMany.mock.calls[0]![0].data;
    expect(data).toMatchObject({ notes: 'Closed Fridays' });
    expect(data).not.toHaveProperty('contactPerson');
    // The audit keeps the request exactly as it was sent.
    expect(audit.writeAudit).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({ action: 'APPROVE', after: expect.objectContaining({ changes: 2 }) })
    );
  });

  it('ruling 5: a request that is all live writes nothing to the customer — and is still approved', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.contactPerson', before: 'Said', after: 'Ali' }])
    );
    now = customerRow({ contactPerson: 'Ali' });
    expect(await approve()).toEqual({ ok: true, data: undefined });
    expect(masterWrites()).toBe(0);
    expect(tx.editApproval.create).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ action: 'APPROVE' }));
    expect(notify.notifyUsers).toHaveBeenCalledTimes(1);
  });

  it('a clear (after: null) is written as null', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.altPhone', before: '+96899887766', after: null }])
    );
    expect((await approve()).ok).toBe(true);
    expect(tx.customer.updateMany.mock.calls[0]![0].data).toMatchObject({ altPhone: null });
  });

  it('ruling 7: the point already live leaves the new capture time and accuracy unwritten; a moved point takes them', async () => {
    const at = '2026-09-26T08:00:00.000Z';
    const point = (lat: number): Change[] => [
      { field: `branch.${B1}.gpsLat`, before: 23.6, after: lat },
      { field: `branch.${B1}.gpsAccuracy`, before: 8, after: 3 },
      { field: `branch.${B1}.gpsCapturedAt`, before: '2026-09-20T08:00:00.000Z', after: at },
    ];
    db.customerEdit.findUnique.mockResolvedValue(request(point(23.7)));
    now = customerRow({}, [branchRow({ gpsLat: 23.7 }), foreignBranch()]);
    expect((await approve()).ok).toBe(true);
    expect(tx.branch.updateMany).not.toHaveBeenCalled();

    db.customerEdit.findUnique.mockResolvedValue(request(point(23.8)));
    now = customerRow();
    expect((await approve()).ok).toBe(true);
    expect(tx.branch.updateMany.mock.calls[0]![0].data).toMatchObject({ gpsLat: 23.8, gpsAccuracy: 3, gpsCapturedAt: at });
  });

  it('QA-013: a salesman’s CR number on a customer now on CREDIT is dropped, stale or not', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([
        { field: 'customer.crNumber', before: '1234567', after: '7654321' },
        { field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' },
      ])
    );
    now = customerRow({ paymentTerms: 'CREDIT', crNumber: '9999999' });
    expect((await approve()).ok).toBe(true);
    expect(tx.customer.updateMany.mock.calls[0]![0].data).not.toHaveProperty('crNumber');
  });

  it('a customer archived before the lock is refused inside the transaction', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.notes', before: 'Old note', after: 'x' }])
    );
    now = customerRow({ deletedAt: new Date() });
    expect(failed(await approve())).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Customer no longer exists (may have been merged or deleted).',
    });
    expect(h.rolledBack).toBe(true);
    expect(masterWrites()).toBe(0);
  });

  it('bulk approve: the stale item fails alone, with its message', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.contactPerson', before: 'Said', after: 'Ali' }])
    );
    now = customerRow({ contactPerson: 'Hamad' });
    const loaded = (await db.customerEdit.findUnique()) as DecisionRow;
    const fd = new FormData();
    fd.set('decisions', JSON.stringify([{ editId: 'e1', decisionToken: decisionTokenFor(loaded, []) }]));
    const res = await bulkApproveEditsAction(fd);
    expect(res).toMatchObject({
      ok: true,
      data: { successes: [], failures: [{ editId: 'e1', code: 'STALE_BEFORE' }] },
    });
  });
});

describe('the point is one value at approval (phase-2 review, finding 2)', () => {
  const at = '2026-09-28T08:00:00.000Z';
  /** A typed latitude-only correction as the submit records it: the longitude beside it, unmoved. */
  const latitudeOnly: Change[] = [
    { field: `branch.${B1}.gpsLat`, before: 23.6, after: 23.7 },
    { field: `branch.${B1}.gpsLng`, before: 58.4, after: 58.4 },
    { field: `branch.${B1}.gpsAccuracy`, before: 8, after: null },
    { field: `branch.${B1}.gpsCapturedAt`, before: '2026-09-20T08:00:00.000Z', after: at },
  ];

  it('the ordinary one-coordinate correction approves, and the whole point is written with its capture time', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(latitudeOnly));
    expect((await approve()).ok).toBe(true);
    expect(tx.branch.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.branch.updateMany.mock.calls[0]![0].data).toMatchObject({
      gpsLat: 23.7,
      gpsLng: 58.4,
      gpsAccuracy: null,
      gpsCapturedAt: at,
    });
  });

  it('a direct write that corrected the other coordinate while it was pending: STALE_BEFORE, never a mixed point', async () => {
    // A Steward's longitude-only correction passed its open-request check just
    // before this request was inserted, and committed after it.
    db.customerEdit.findUnique.mockResolvedValue(request(latitudeOnly));
    now = customerRow({}, [branchRow({ gpsLng: 58.5, gpsAccuracy: 5 }), foreignBranch()]);
    const res = failed(await approve());
    expect(res).toMatchObject({ code: 'STALE_BEFORE', message: staleBeforeMessage(['Location']) });
    expect(h.rolledBack).toBe(true);
    expect(masterWrites()).toBe(0);
    expect(audit.writeAudit).not.toHaveBeenCalled();
    // The approval page warns about the same row before anyone clicks (ruling 8).
    const page = {
      customer: { findUnique: vi.fn(async () => now) },
      user: { findUnique: vi.fn(async () => ({ role: 'SALESMAN' })) },
    };
    expect(
      await staleLabelsForPendingEdit(page as unknown as PrismaClient, {
        customerId: CUST,
        submittedById: SALES,
        fieldChanges: latitudeOnly,
      })
    ).toEqual(['Location']);
  });
});

describe('F06 — a close request', () => {
  const close = (over: Row = {}) =>
    request([{ field: `branch.${B1}.status`, before: 'ACTIVE', after: 'CLOSED' }], {
      target: 'BRANCH',
      branchId: B1,
      submitGate: null,
      attachmentChanges: [{ kind: 'FREE', attachmentId: PHOTO, action: 'EVIDENCE' }],
      ...over,
    });
  beforeEach(() => {
    tx.attachment.findMany.mockResolvedValue([
      { id: PHOTO, deletedAt: null, capturedById: SALES, branchId: B1, branchExtraId: B1 },
    ]);
  });

  it('on a branch already closed approves, writing nothing', async () => {
    db.customerEdit.findUnique.mockResolvedValue(close());
    now = customerRow({}, [branchRow({ status: 'CLOSED' })]);
    expect((await approve()).ok).toBe(true);
    expect(tx.branch.updateMany).not.toHaveBeenCalled();
  });

  it('on a branch moved to a third status is STALE_BEFORE', async () => {
    db.customerEdit.findUnique.mockResolvedValue(close());
    now = customerRow({}, [branchRow({ status: 'SUSPENDED' })]);
    expect(failed(await approve()).code).toBe('STALE_BEFORE');
  });
});

describe('F05 — the mandatory re-check runs on the branches frozen at submit', () => {
  const notes: Change[] = [{ field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' }];
  // Owner decision 4: the re-check runs on a frozen branch only when the request changes it.
  const onB1: Change[] = [{ field: `branch.${B1}.openingHours`, before: null, after: '08:00-20:00' }];

  it('another route’s incomplete branch, and one created since, do not fail it', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(notes));
    now = customerRow({}, [branchRow(), foreignBranch(), branchRow({ id: B3, branchCode: 'MCT-0003', shopPhotoId: null, gpsLat: null })]);
    expect((await approve()).ok).toBe(true);
  });

  it('his own shop photo removed since submit does — NEEDS_REUPLOAD, rolled back', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(onB1));
    now = customerRow({}, [branchRow({ shopPhotoId: null }), foreignBranch()]);
    const res = failed(await approve());
    expect(res.code).toBe('NEEDS_REUPLOAD');
    expect(res.message).toContain('MCT-0001');
    expect(res.message).not.toContain('MCT-0002');
    expect(masterWrites()).toBe(0);
  });

  it('a route handover since submit changes neither answer', async () => {
    db.user.findUnique.mockResolvedValue({ role: 'SALESMAN', ownedRouteId: 'r2' });
    db.customerEdit.findUnique.mockResolvedValue(request(onB1));
    expect((await approve()).ok).toBe(true);
    now = customerRow({}, [branchRow({ shopPhotoId: null }), foreignBranch()]);
    expect(failed(await approve()).code).toBe('NEEDS_REUPLOAD');
  });

  it('a request sent before the set was stored: the branches it names plus his route now', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(notes, { submitGate: null }));
    expect((await approve()).ok).toBe(true); // B2 is neither named nor on r1
    db.customerEdit.findUnique.mockResolvedValue(
      request([...notes, { field: `branch.${B2}.address`, before: 'Way 1, Ruwi', after: 'Way 2, Ruwi' }], { submitGate: null })
    );
    expect(failed(await approve()).code).toBe('NEEDS_REUPLOAD'); // B2 named: gated
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), 'edit.approve.submit_gate_unreadable');
  });

  it('an unreadable set is logged and takes the same fallback', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(notes, { submitGate: { v: 9, gate: 'FULL' } }));
    expect((await approve()).ok).toBe(true);
    expect(log.warn).toHaveBeenCalledWith({ editId: 'e1' }, 'edit.approve.submit_gate_unreadable');
  });

  it('a request by someone who is not a salesman now, sent before the set was stored, is not gated', async () => {
    db.user.findUnique.mockResolvedValue({ role: 'SUPERVISOR', ownedRouteId: null });
    db.customerEdit.findUnique.mockResolvedValue(request(notes, { submitGate: null }));
    now = customerRow({}, [branchRow({ shopPhotoId: null })]);
    expect((await approve()).ok).toBe(true);
  });
});

describe('owner decision 4 — the re-check holds what the request changes', () => {
  const notes: Change[] = [{ field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' }];
  const onB1: Change[] = [{ field: `branch.${B1}.dayOfVisit`, before: 'SUN', after: 'MON' }];

  it('a customer-level change is not failed by his branch that lost its shop photo since', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(notes));
    now = customerRow({}, [branchRow({ shopPhotoId: null, gpsLat: null }), foreignBranch()]);
    expect((await approve()).ok).toBe(true);
  });

  it('a change to one branch is not failed by a customer-level field missing since', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(onB1));
    now = customerRow({ contactPerson: null });
    expect((await approve()).ok).toBe(true);
  });

  it('a customer-level change still is — NEEDS_REUPLOAD, rolled back', async () => {
    db.customerEdit.findUnique.mockResolvedValue(request(notes));
    now = customerRow({ contactPerson: null });
    const res = failed(await approve());
    expect(res.code).toBe('NEEDS_REUPLOAD');
    expect(res.message).toContain('Contact person');
    expect(masterWrites()).toBe(0);
  });

  it('a stored gate of every branch he had (a request sent before the rule) is narrowed to the ones it changes', async () => {
    const B4 = 'b4';
    db.customerEdit.findUnique.mockResolvedValue(request(onB1, { submitGate: { v: 1, branchIds: [B1, B4] } }));
    now = customerRow({}, [branchRow(), branchRow({ id: B4, branchCode: 'MCT-0004', shopPhotoId: null }), foreignBranch()]);
    expect((await approve()).ok).toBe(true);
  });
});

describe('owner decision 3 — a Manager decides only a request whose branches are all in his regions', () => {
  // B1 is in g1 (route r1, the submitter's); B2 is in g2 (route r2). Both complete.
  const twoRegions = () =>
    customerRow({}, [branchRow(), foreignBranch({ regionId: 'g2', gpsLat: 23.7, gpsLng: 58.5, shopPhotoId: 'p-shop2' })]);
  const asManagerOf = (...regions: string[]) => {
    h.user = { id: 'u-mgr', role: 'MANAGER', username: 'mgr' };
    h.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: regions };
  };
  const onB1: Change[] = [{ field: `branch.${B1}.openingHours`, before: null, after: '08:00-20:00' }];
  const onB2: Change[] = [{ field: `branch.${B2}.openingHours`, before: null, after: '08:00-20:00' }];
  const notes: Change[] = [{ field: 'customer.notes', before: 'Old note', after: 'Closed Fridays' }];
  const pending = (changes: Change[], over: Row = {}) => {
    now = twoRegions();
    db.customerEdit.findUnique.mockResolvedValue(request(changes, { customer: twoRegions(), ...over }));
  };
  const forbidden = async () => {
    const res = failed(await approve());
    expect(res.code).toBe('FORBIDDEN');
    expect(masterWrites()).toBe(0);
    expect(tx.customerEdit.updateMany).not.toHaveBeenCalled();
  };
  afterEach(() => {
    h.scope = { ownedRouteId: null, teamRouteIds: ['r1'], managedRegionIds: [] };
  });

  it('the Manager of the changed branch’s region approves it', async () => {
    asManagerOf('g1');
    pending(onB1);
    expect((await approve()).ok).toBe(true);
  });

  it('the Manager of the customer’s OTHER region cannot (any-branch overlap let him)', async () => {
    asManagerOf('g2');
    pending(onB1);
    await forbidden();
  });

  it('a change to the other region’s branch is not the first region’s Manager’s', async () => {
    asManagerOf('g1');
    pending(onB2, { submitGate: { v: 1, branchIds: [B2] } });
    await forbidden();
  });

  it('customer-level fields belong to the request’s home: the submitter’s branch frozen at submit', async () => {
    asManagerOf('g2');
    pending(notes);
    await forbidden();
    asManagerOf('g1');
    expect((await approve()).ok).toBe(true);
  });

  it('a request on branches of two regions needs a Manager of both', async () => {
    const both = [...onB1, ...onB2];
    asManagerOf('g1');
    pending(both, { submitGate: null });
    await forbidden();
    asManagerOf('g1', 'g2');
    expect((await approve()).ok).toBe(true);
  });

  it('the Managers who share a region all decide it (the four of MCT)', async () => {
    for (const id of ['u-mgr-a', 'u-mgr-b']) {
      h.user = { id, role: 'MANAGER', username: id };
      h.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] };
      pending(onB1);
      expect((await approve()).ok).toBe(true);
    }
  });

  it('reject takes the same rule', async () => {
    asManagerOf('g2');
    pending(onB1);
    const loaded = (await db.customerEdit.findUnique()) as DecisionRow;
    const fd = new FormData();
    fd.set('editId', 'e1');
    fd.set('decisionToken', decisionTokenFor(loaded, []));
    fd.set('reason', 'Wrong opening hours');
    const res = failed(await rejectEditAction(fd));
    expect(res.code).toBe('FORBIDDEN');
    expect(tx.editApproval.create).not.toHaveBeenCalled();
  });
});

describe('F16 — the channel pair at approval', () => {
  it('a sub-channel retired since submit is CHANNEL_PAIR_INVALID, rolled back', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.subChannelId', before: null, after: SUB_A }])
    );
    now = customerRow({ subChannelId: null });
    tx.subChannel.findUnique.mockResolvedValue({ channelId: CH_A, isActive: false });
    expect(failed(await approve())).toMatchObject({ code: 'CHANNEL_PAIR_INVALID', message: CHANNEL_PAIR_INVALID_MESSAGE });
    expect(masterWrites()).toBe(0);
  });

  describe('the refusal says which case it is (post-merge review, finding 3)', () => {
    const CH_B = 'ch-b';
    const SUB_B = 'sub-b';
    const channelOnly: Change[] = [{ field: 'customer.channelId', before: CH_A, after: CH_B }];

    it('a channel change with no sub-channel, as the old form stored it: the customer’s current sub-channel is named, not the request’s', async () => {
      // The form before patch v2 emptied the sub-channel select on a channel
      // change and sent nothing for it; SUB_A, of the old channel, stays live.
      db.customerEdit.findUnique.mockResolvedValue(request(channelOnly, { submitGate: null }));
      const res = failed(await approve());
      expect(res).toMatchObject({ code: 'CHANNEL_PAIR_INVALID', message: CHANNEL_ONLY_PAIR_INVALID_MESSAGE });
      expect(res.message).not.toContain('in this request no longer fits');
      expect(h.rolledBack).toBe(true);
      expect(masterWrites()).toBe(0);
      expect(audit.writeAudit).not.toHaveBeenCalled();

      // The same change as this build stores it — the clear recorded beside it — approves.
      db.customerEdit.findUnique.mockResolvedValue(
        request([...channelOnly, { field: 'customer.subChannelId', before: SUB_A, after: null }])
      );
      expect((await approve()).ok).toBe(true);
      expect(tx.customer.updateMany.mock.calls[0]![0].data).toMatchObject({ channelId: CH_B, subChannelId: null });
    });

    it('a request that names a sub-channel keeps the first message, even when that change is already live', async () => {
      // Channel A→B with SUB_B; a Steward already set SUB_B, which has since been
      // retired. The sub-channel change is left out of the write as already
      // live, but it is the request's own sub-channel that no longer fits.
      db.customerEdit.findUnique.mockResolvedValue(
        request([...channelOnly, { field: 'customer.subChannelId', before: SUB_A, after: SUB_B }])
      );
      now = customerRow({ subChannelId: SUB_B });
      tx.subChannel.findUnique.mockResolvedValue({ channelId: CH_B, isActive: false });
      expect(failed(await approve())).toMatchObject({ code: 'CHANNEL_PAIR_INVALID', message: CHANNEL_PAIR_INVALID_MESSAGE });
      expect(masterWrites()).toBe(0);
    });

    it('channelPairInvalidMessage: the channel-only wording only for a refused sub-channel the request does not name', () => {
      const sub = [{ field: 'customer.subChannelId' }];
      const ch = [{ field: 'customer.channelId' }];
      expect(channelPairInvalidMessage('customer.subChannelId', ch)).toBe(CHANNEL_ONLY_PAIR_INVALID_MESSAGE);
      expect(channelPairInvalidMessage('customer.subChannelId', [...ch, ...sub])).toBe(CHANNEL_PAIR_INVALID_MESSAGE);
      expect(channelPairInvalidMessage('customer.subChannelId', sub)).toBe(CHANNEL_PAIR_INVALID_MESSAGE);
      expect(channelPairInvalidMessage('customer.channelId', ch)).toBe(CHANNEL_PAIR_INVALID_MESSAGE);
    });
  });

  it('a request that does not touch the pair never reads it', async () => {
    db.customerEdit.findUnique.mockResolvedValue(
      request([{ field: 'customer.notes', before: 'Old note', after: 'x' }])
    );
    expect((await approve()).ok).toBe(true);
    expect(tx.subChannel.findUnique).not.toHaveBeenCalled();
    expect(tx.channel.findUnique).not.toHaveBeenCalled();
  });
});

describe('lib/edit-approval.ts — what the approval page shows (ruling 8)', () => {
  it('storedFieldChanges keeps entries with a field, from any JSON', () => {
    expect(storedFieldChanges([{ field: 'customer.notes', before: 1, after: 2 }, null, 'x', { before: 1 }])).toEqual([
      { field: 'customer.notes', before: 1, after: 2 },
    ]);
    for (const junk of [null, undefined, {}, 'x']) expect(storedFieldChanges(junk)).toEqual([]);
  });

  it('labels each stale field once, and the message lists three', () => {
    const stale = [
      { field: `branch.${B1}.gpsLat` },
      { field: `branch.${B1}.gpsLng` },
      { field: 'customer.contactPerson' },
    ];
    expect(staleFieldLabels(stale)).toEqual(['Location', 'Contact person']);
    expect(staleBeforeMessage(['Contact person', 'Location', 'Notes', 'Alt phone'])).toMatch(
      /^Changed on the customer after this request was sent: contact person, location, notes …\. .*Reject it/
    );
  });

  it('planApproval applies QA-013 first, then classifies against the live row', () => {
    const plan = planApproval({
      fieldChanges: [
        { field: 'customer.legalName', before: 'A', after: 'B' },
        { field: 'customer.notes', before: 'Old note', after: 'N' },
      ],
      submitterRole: 'SALESMAN',
      customer: customerRow({ legalName: 'Z' }) as never,
      liveBranches: [branchRow() as { id: string }],
    });
    expect(plan.considered.map((c) => c.field)).toEqual(['customer.notes']);
    expect(plan.classified.stale).toEqual([]);
    expect(plan.classified.apply.map((c) => c.field)).toEqual(['customer.notes']);
  });

  it('staleLabelsForPendingEdit reads the customer and the submitter the way the approval does', async () => {
    const fake = {
      customer: { findUnique: vi.fn(async () => customerRow({ contactPerson: 'Hamad', legalName: 'Z' })) },
      user: { findUnique: vi.fn(async () => ({ role: 'SALESMAN' })) },
    };
    const labels = await staleLabelsForPendingEdit(fake as unknown as PrismaClient, {
      customerId: CUST,
      submittedById: SALES,
      fieldChanges: [
        { field: 'customer.contactPerson', before: 'Said', after: 'Ali' },
        // Dropped by QA-013 for a salesman, so never "stale" on the page either.
        { field: 'customer.legalName', before: 'A', after: 'B' },
      ],
    });
    expect(labels).toEqual(['Contact person']);
    expect(await staleLabelsForPendingEdit(fake as unknown as PrismaClient, { customerId: null, submittedById: SALES, fieldChanges: [] })).toEqual([]);
  });

  it('sentByPreviousForm: a salesman’s enrichment request with no stored gate (ruling 2)', () => {
    const e = { process: 'UPDATE', target: 'CUSTOMER', isReactivation: false, submitGate: null } as const;
    expect(sentByPreviousForm(e, 'SALESMAN')).toBe(true);
    expect(sentByPreviousForm({ ...e, submitGate: { v: 1, branchIds: [] } }, 'SALESMAN')).toBe(false);
    expect(sentByPreviousForm({ ...e, target: 'BRANCH' }, 'SALESMAN')).toBe(false);
    expect(sentByPreviousForm(e, 'MANAGER')).toBe(false);
    expect(sentByPreviousForm({ ...e, process: 'CREATE' }, 'SALESMAN')).toBe(false);
  });
});
