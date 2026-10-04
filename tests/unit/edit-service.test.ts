// @vitest-environment node
/**
 * Phase 2 (auditor recheck 2026-09-27): the customer edit SUBMIT, patch v2,
 * with Prisma mocked. services/edits.ts, runAction, the schema, the value rules
 * (lib/edit-values.ts), the gate's branch set (lib/edit-scope.ts) and the
 * channel-pair rule (lib/channel-pair.ts) are real.
 *
 *   F05 — a salesman is gated on the branches of his own route only, and that
 *         set is stored on his request for the approval.
 *   F06 — a sent field whose loaded value is no longer live is refused
 *         (STALE_FIELDS), never written over; a value already live is left out;
 *         a Steward/Manager direct write judges again under the customer lock.
 *   F16 — a channel change clears a sub-channel of the old channel; a pair that
 *         does not fit is refused.
 *   F19 — an invalid phone is refused, not dropped.
 *   F20 — null clears a clearable field; a required one cannot be removed.
 *   F21 — entering a count marks the equipment counted; only a Steward or a
 *         Manager can take that back.
 *   N02 — a tag-only name is refused on the direct write too.
 * The same flows against Postgres: tests/integration/golive-update-flow.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { editPayload, type EditPatch } from '../support/edit-payload';
import { FORM_OUTDATED_MESSAGE, STALE_FIELDS_MESSAGE } from '@/lib/errors';
import {
  STALE_EQUIPMENT_MESSAGE,
  STALE_FIELD_MESSAGE,
  STALE_LOCATION_MESSAGE,
} from '@/lib/edit-values';
import { EQUIPMENT_UNCONFIRM_MESSAGE } from '@/lib/validation/edit';
import {
  CHANNEL_INACTIVE_MESSAGE,
  SUB_CHANNEL_INACTIVE_MESSAGE,
  SUB_CHANNEL_MISMATCH_MESSAGE,
} from '@/lib/channel-pair';
import { INVALID_PHONE_MESSAGE } from '@/lib/phone';

const h = vi.hoisted(() => ({
  user: { id: 'u-sales', role: 'SALESMAN', username: 'mct01' } as { id: string; role: string; username: string },
  scope: { ownedRouteId: 'r1' as string | null, teamRouteIds: [] as string[], managedRegionIds: ['g1'] },
  rolledBack: false,
}));
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  customer: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  branch: { findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  customerEdit: { create: vi.fn() },
  channel: { findUnique: vi.fn() },
  subChannel: { findUnique: vi.fn() },
}));
const db = vi.hoisted(() => ({
  customer: { findUnique: vi.fn(), findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  customerEdit: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  channel: { findUnique: vi.fn() },
  subChannel: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/audit', () => audit);
vi.mock('@/lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/access')>()),
  loadScope: async () => h.scope,
}));
vi.mock('@/lib/notifications', () => ({
  notifyUsers: vi.fn(),
  resolveStepAudience: vi.fn(async () => []),
  resolveStewardAudience: vi.fn(async () => []),
}));
// F1: the services also write the hierarchy's rows (lib/notify-hierarchy.ts);
// mocked here like '@/lib/notifications', so these suites keep testing what they test.
vi.mock('@/lib/notify-hierarchy', () => ({
  notifySalesmanRequest: vi.fn(async () => ({ mustAct: [], fyi: [] })),
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true, retryAfterSec: 0 }), FORM_LIMIT: {} }));
vi.mock('@/lib/completeness', () => ({ scoreCustomer: () => 50, scoreBranch: () => 50 }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { submitEditAction } from '@/services/edits';

// cuids, as the schema requires.
const CUST = 'ckcustomer0000000000000001';
const B1 = 'ckbranch000000000000000001'; // on the salesman's route r1
const B2 = 'ckbranch000000000000000002'; // on another salesman's route r2
const CH_A = 'ckchannel00000000000000001';
const CH_B = 'ckchannel00000000000000002';
const CH_C = 'ckchannel00000000000000003';
const SUB_A = 'cksubchannel0000000000001';
const SUB_B = 'cksubchannel0000000000002';
const CAPTURED = new Date('2026-09-20T08:00:00.000Z');

type Row = Record<string, unknown>;
const branchRow = (over: Row = {}): Row => ({
  id: B1,
  customerId: CUST,
  branchCode: 'MCT-0001',
  branchName: 'Main',
  routeId: 'r1',
  regionId: 'g1',
  status: 'ACTIVE',
  deletedAt: null,
  address: 'Way 1, Ruwi',
  areaDescription: null,
  gpsLat: 23.6,
  gpsLng: 58.4,
  gpsAccuracy: 8,
  gpsCapturedAt: CAPTURED,
  dayOfVisit: 'SUN',
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  shopPhotoId: 'p-shop',
  signboardPhotoId: 'p-sign',
  version: 5,
  ...over,
});
/** The customer as the database holds it: complete on B1; B2 (another route) has no GPS and no photos. */
const customerRow = (over: Row = {}, branches?: Row[]): Row => ({
  id: CUST,
  nmwcCode: 'NMWC-000001',
  legalName: 'Al Noor Trading',
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
  branches: branches ?? [
    branchRow(),
    branchRow({
      id: B2,
      branchCode: 'MCT-0002',
      routeId: 'r2',
      gpsLat: null,
      gpsLng: null,
      gpsAccuracy: null,
      gpsCapturedAt: null,
      shopPhotoId: null,
      signboardPhotoId: null,
    }),
  ],
  ...over,
});

let live: Row = customerRow();
/** What the database holds once the direct write has the customer's lock. */
let locked: Row | null = null;

/** The body the v2 form sends, each key's base read from `live` (tests/support/edit-payload.ts). */
const body = (patch: Omit<EditPatch, 'customerId'>) =>
  editPayload({ customer: { findUniqueOrThrow: async () => live } } as unknown as PrismaClient, {
    customerId: CUST,
    isDraft: false,
    ...patch,
  });
const submit = async (patch: Omit<EditPatch, 'customerId'>) => submitEditAction(await body(patch));

type Fail = { ok: false; code: string; message: string; fields?: Record<string, string>; current?: Record<string, unknown> };
const failed = (r: unknown) => {
  expect((r as { ok: boolean }).ok, JSON.stringify(r)).toBe(false);
  return r as Fail;
};
/** The fieldChanges of the one request written outside a transaction (salesman submit, draft). */
const storedChanges = () => {
  expect(db.customerEdit.create).toHaveBeenCalledTimes(1);
  return db.customerEdit.create.mock.calls[0]![0].data.fieldChanges as Array<Row>;
};
const nothingWritten = () => {
  expect(db.customerEdit.create).not.toHaveBeenCalled();
  expect(tx.customerEdit.create).not.toHaveBeenCalled();
  expect(tx.customer.updateMany).not.toHaveBeenCalled();
  expect(tx.branch.updateMany).not.toHaveBeenCalled();
  expect(audit.writeAudit).not.toHaveBeenCalled();
};
const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0] ?? -1;

const asSalesman = () => {
  h.user = { id: 'u-sales', role: 'SALESMAN', username: 'mct01' };
  db.user.findUniqueOrThrow.mockResolvedValue({ id: 'u-sales', role: 'SALESMAN', ownedRouteId: 'r1', supervisorId: 'u-sup' });
};
const asStaff = (role: 'STEWARD' | 'MANAGER') => {
  h.user = { id: 'u-staff', role, username: role.toLowerCase() };
  db.user.findUniqueOrThrow.mockResolvedValue({ id: 'u-staff', role, ownedRouteId: null, supervisorId: null });
};

beforeEach(() => {
  live = customerRow();
  locked = null;
  h.rolledBack = false;
  h.scope = { ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: ['g1'] };
  for (const group of [tx.customer, tx.branch, tx.customerEdit, tx.channel, tx.subChannel]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  for (const group of [db.customer, db.user, db.customerEdit, db.channel, db.subChannel]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  tx.$queryRaw.mockReset().mockResolvedValue([]);
  db.$transaction.mockReset().mockImplementation(async (fn: (t: typeof tx) => unknown) => {
    try {
      return await fn(tx);
    } catch (err) {
      h.rolledBack = true;
      throw err;
    }
  });
  audit.writeAudit.mockReset().mockResolvedValue(undefined);
  audit.getAuditEnvelope.mockReset().mockResolvedValue({ actorId: 'x', ip: null, userAgent: null });

  db.customer.findUnique.mockImplementation(async () => live);
  db.customer.findFirst.mockResolvedValue(null);
  db.customerEdit.findFirst.mockResolvedValue(null);
  db.customerEdit.findUnique.mockResolvedValue(null);
  db.customerEdit.create.mockImplementation(async (a: { data: Row }) => ({
    id: 'e-new',
    state: a.data.state,
    submittedAt: a.data.submittedAt ?? null,
  }));
  // The direct write's read under the lock: the same row, unless a test moved it.
  tx.customer.findUnique.mockImplementation(async () => locked ?? live);
  tx.customerEdit.create.mockImplementation(async (a: { data: Row }) => ({
    id: 'e-direct',
    state: a.data.state,
    submittedAt: a.data.submittedAt,
  }));
  tx.customer.findUniqueOrThrow.mockImplementation(async () => ({ ...(locked ?? live) }));
  tx.customer.updateMany.mockResolvedValue({ count: 1 });
  tx.branch.findUniqueOrThrow.mockResolvedValue({ version: 5, status: 'ACTIVE' });
  tx.branch.updateMany.mockResolvedValue({ count: 1 });
  // Channels as seeded: both active; each sub-channel belongs to its channel.
  const channel = async (a: { where: { id: string } }) =>
    [CH_A, CH_B].includes(a.where.id) ? { isActive: true } : null;
  const sub = async (a: { where: { id: string } }) =>
    ({ [SUB_A]: { channelId: CH_A, isActive: true }, [SUB_B]: { channelId: CH_B, isActive: true } })[a.where.id] ?? null;
  for (const c of [db.channel, tx.channel]) c.findUnique.mockImplementation(channel);
  for (const s of [db.subChannel, tx.subChannel]) s.findUnique.mockImplementation(sub);
  asSalesman();
});

describe('the body: this build’s format, or nothing is read', () => {
  it('a body from the previous form (no v) is FORM_OUTDATED, with the words at the top of the form', async () => {
    const res = failed(
      await submitEditAction({
        customerId: CUST,
        isDraft: false,
        customer: { notes: 'New note' },
        branches: [],
      } as unknown as Parameters<typeof submitEditAction>[0])
    );
    expect(res).toMatchObject({ code: 'FORM_OUTDATED', message: FORM_OUTDATED_MESSAGE, fields: { _form: FORM_OUTDATED_MESSAGE } });
    expect(db.customer.findUnique).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a sent key without the value it was loaded with is FORM_OUTDATED — it cannot be told from a stale one', async () => {
    const b = await body({ customer: { notes: 'New note', contactRole: 'Partner' } });
    delete (b.customerBase as Row).notes;
    expect(failed(await submitEditAction(b)).code).toBe('FORM_OUTDATED');
    const withBranch = await body({ branches: [{ branchId: B1, openingHours: '08:00-20:00' }] });
    withBranch.branches[0]!.base = {};
    expect(failed(await submitEditAction(withBranch)).code).toBe('FORM_OUTDATED');
    nothingWritten();
  });

  it('a retry of a submit that landed before the update is answered from its receipt, before the format is read', async () => {
    db.customerEdit.findUnique.mockResolvedValue({
      id: 'e-old',
      state: 'SUBMITTED',
      process: 'UPDATE',
      target: 'CUSTOMER',
      customerId: CUST,
      branchId: null,
      isReactivation: false,
      submittedAt: CAPTURED,
      updatedAt: CAPTURED,
    });
    const res = await submitEditAction({
      customerId: CUST,
      isDraft: false,
      customer: { notes: 'x' },
      branches: [],
      submissionId: '3f2c1a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60',
    } as unknown as Parameters<typeof submitEditAction>[0]);
    expect(res).toEqual({
      ok: true,
      data: { editId: 'e-old', state: 'SUBMITTED', submittedAt: CAPTURED.toISOString(), replayed: true },
    });
  });

  it('schema errors land in the form’s slots: the location and the equipment block are one slot each', async () => {
    const res = failed(
      await submit({
        branches: [{ branchId: B1, gpsLat: 10, gpsLng: 58.4, gpsAccuracy: 5, gpsCapturedAt: CAPTURED.toISOString(), coolersCount: -1 }],
      })
    );
    expect(Object.keys(res.fields!).sort()).toEqual([`branch.${B1}.equipment`, `branch.${B1}.gps`]);
  });
});

describe('F05 — a salesman is gated on his own route’s branches, and the set is stored', () => {
  it('another route’s incomplete branch no longer blocks him; his request stores [his branch]', async () => {
    const res = await submit({ customer: { notes: 'Closed on Fridays' } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = db.customerEdit.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ state: 'SUBMITTED', submitGate: { v: 1, branchIds: [B1] } });
    expect(storedChanges()).toEqual([{ field: 'customer.notes', before: 'Old note', after: 'Closed on Fridays' }]);
  });

  it('his own incomplete branch still blocks, under its own key — and only his', async () => {
    live = customerRow({}, [
      branchRow({ shopPhotoId: null }),
      branchRow({ id: B2, branchCode: 'MCT-0002', routeId: 'r2', gpsLat: null, gpsLng: null, shopPhotoId: null }),
    ]);
    const res = failed(await submit({ customer: { notes: 'Closed on Fridays' } }));
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.fields!)).toEqual([`branch.${B1}.shopPhoto`]);
    nothingWritten();
  });

  it('a missing customer-level field still blocks', async () => {
    live = customerRow({ contactPerson: null });
    const res = failed(await submit({ customer: { notes: 'Closed on Fridays' } }));
    expect(res.fields).toHaveProperty(['customer.contactPerson']);
  });

  it('a draft stores no gate, and a Steward’s direct write none either', async () => {
    expect((await submit({ isDraft: true, customer: { notes: 'Half done' } })).ok).toBe(true);
    expect(db.customerEdit.create.mock.calls[0]![0].data).not.toHaveProperty('submitGate');
    expect(db.customerEdit.create.mock.calls[0]![0].data.state).toBe('DRAFT');
    asStaff('STEWARD');
    expect((await submit({ customer: { notes: 'Steward note' } })).ok).toBe(true);
    expect(tx.customerEdit.create.mock.calls[0]![0].data).not.toHaveProperty('submitGate');
  });
});

describe('F06 — every sent field is judged against the customer as it is now', () => {
  it('only what was sent is recorded: a contact changed on the server meanwhile is not put back', async () => {
    const b = await body({ customer: { notes: 'New note' } });
    live = customerRow({ contactPerson: 'Hamad (changed by an import)' });
    expect((await submitEditAction(b)).ok).toBe(true);
    expect(storedChanges().map((c) => c.field)).toEqual(['customer.notes']);
  });

  it('a field whose loaded value is no longer live is STALE_FIELDS: its slot, the value now, nothing written', async () => {
    const b = await body({ customer: { contactPerson: 'Ali', notes: 'New note' } });
    live = customerRow({ contactPerson: 'Hamad' });
    const res = failed(await submitEditAction(b));
    expect(res).toMatchObject({
      code: 'STALE_FIELDS',
      message: STALE_FIELDS_MESSAGE,
      fields: { 'customer.contactPerson': STALE_FIELD_MESSAGE },
      current: { 'customer.contactPerson': 'Hamad' },
    });
    // Neutral about who changed it (ruling 14).
    expect(`${res.message} ${STALE_FIELD_MESSAGE}`).not.toMatch(/someone else/i);
    expect(db.$transaction).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a stale field that already holds the new value is left out: nothing else sent is "No changes"', async () => {
    const b = await body({ customer: { contactPerson: 'Hamad' } });
    live = customerRow({ contactPerson: 'Hamad' });
    expect(failed(await submitEditAction(b))).toMatchObject({ code: 'VALIDATION_FAILED', fields: { _form: 'No changes to submit.' } });
  });

  it('a location conflict names the gps slot and hands back all four columns', async () => {
    live = customerRow({}, [branchRow({ gpsLat: 23.61, gpsLng: 58.41 })]);
    const b = await body({
      branches: [{ branchId: B1, gpsLat: 23.7, gpsLng: 58.5, gpsAccuracy: 4, gpsCapturedAt: '2026-09-28T08:00:00.000Z' }],
    });
    b.branches[0]!.base = { gpsLat: 23.6, gpsLng: 58.4 };
    const res = failed(await submitEditAction(b));
    expect(res.fields).toEqual({ [`branch.${B1}.gps`]: STALE_LOCATION_MESSAGE });
    expect(res.current).toEqual({
      [`branch.${B1}.gpsLat`]: 23.61,
      [`branch.${B1}.gpsLng`]: 58.41,
      [`branch.${B1}.gpsAccuracy`]: 8,
      [`branch.${B1}.gpsCapturedAt`]: CAPTURED.toISOString(),
    });
  });

  it('an equipment conflict names the equipment slot and hands back the block', async () => {
    live = customerRow({}, [branchRow({ coolersCount: 3, equipmentConfirmed: true })]);
    const b = await body({ branches: [{ branchId: B1, coolersCount: 2 }] });
    b.branches[0]!.base = { coolersCount: 1 };
    const res = failed(await submitEditAction(b));
    expect(res.fields).toEqual({ [`branch.${B1}.equipment`]: STALE_EQUIPMENT_MESSAGE });
    expect(res.current).toMatchObject({ [`branch.${B1}.coolersCount`]: 3, [`branch.${B1}.equipmentConfirmed`]: true });
  });

  it('"Keep mine" (ruling 1): the base moved to the live value, the change is recorded and says what it replaced', async () => {
    live = customerRow({ contactPerson: 'Hamad' });
    const res = await submit({ customer: { contactPerson: 'Ali' }, customerOverrides: ['contactPerson'] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(storedChanges()).toEqual([
      { field: 'customer.contactPerson', before: 'Hamad', after: 'Ali', overrodeLive: 'Hamad' },
    ]);
  });

  it('a draft skips the stale check (ruling 1): drafts are never read back, so nothing is written over', async () => {
    const b = await body({ isDraft: true, customer: { contactPerson: 'Ali' } });
    live = customerRow({ contactPerson: 'Hamad' });
    expect((await submitEditAction(b)).ok).toBe(true);
    expect(storedChanges()).toEqual([{ field: 'customer.contactPerson', before: 'Hamad', after: 'Ali' }]);
  });
});

describe('F06 — the Steward/Manager direct write judges again under the customer’s lock', () => {
  beforeEach(() => asStaff('MANAGER'));

  it('lock, then the fresh read, then the request row, then the write — and the version is read under the lock', async () => {
    const res = await submit({ customer: { contactPerson: 'Ali' } });
    expect(res).toMatchObject({ ok: true, data: { editId: 'e-direct', state: 'APPROVED' } });
    const [sql, id] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/FROM "Customer" WHERE "id" = \? FOR UPDATE/);
    expect(id).toBe(CUST);
    expect(order(tx.$queryRaw)).toBeLessThan(order(tx.customer.findUnique));
    expect(order(tx.customer.findUnique)).toBeLessThan(order(tx.customerEdit.create));
    expect(order(tx.customerEdit.create)).toBeLessThan(order(tx.customer.updateMany));
    expect(tx.customer.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: CUST, version: 3 },
      data: { contactPerson: 'Ali', version: { increment: 1 } },
    });
    expect(tx.customerEdit.create.mock.calls[0]![0].data.fieldChanges).toEqual([
      { field: 'customer.contactPerson', before: 'Said', after: 'Ali' },
    ]);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({ action: 'UPDATE', after: { contactPerson: 'Ali' } })
    );
  });

  it('a value that moved between the read and the lock is STALE_FIELDS — rolled back before the request row', async () => {
    locked = customerRow({ contactPerson: 'Hamad' });
    const res = failed(await submit({ customer: { contactPerson: 'Ali' } }));
    expect(res).toMatchObject({ code: 'STALE_FIELDS', current: { 'customer.contactPerson': 'Hamad' } });
    expect(h.rolledBack).toBe(true);
    nothingWritten();
  });

  it('a version bumped by a writer that skipped the lock is VERSION_CONFLICT, rolled back', async () => {
    tx.customer.updateMany.mockResolvedValue({ count: 0 });
    expect(failed(await submit({ customer: { contactPerson: 'Ali' } })).code).toBe('VERSION_CONFLICT');
    expect(h.rolledBack).toBe(true);
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('an overlapping retry finds its value already live and is answered with the first attempt’s receipt', async () => {
    locked = customerRow({ contactPerson: 'Ali' });
    db.customerEdit.findUnique
      .mockResolvedValueOnce(null) // the replay lookup before the work
      .mockResolvedValue({
        id: 'e-first',
        state: 'APPROVED',
        process: 'UPDATE',
        target: 'CUSTOMER',
        customerId: CUST,
        branchId: null,
        isReactivation: false,
        submittedAt: CAPTURED,
        updatedAt: CAPTURED,
      });
    const res = await submit({ customer: { contactPerson: 'Ali' }, submissionId: '3f2c1a9e-8b7d-4c6e-9f0a-1b2c3d4e5f61' });
    expect(res).toMatchObject({ ok: true, data: { editId: 'e-first', replayed: true } });
    nothingWritten();
  });

  it('F20: clears write null — the CR number’s normalized copy with it', async () => {
    const res = await submit({ customer: { notes: null, altPhone: null, crNumber: null } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(tx.customer.updateMany.mock.calls[0]![0].data).toMatchObject({
      notes: null,
      altPhone: null,
      crNumber: null,
      crNumberNorm: null,
    });
    expect(tx.customerEdit.create.mock.calls[0]![0].data.fieldChanges).toEqual([
      { field: 'customer.crNumber', before: '1234567', after: null },
      { field: 'customer.altPhone', before: '+96899887766', after: null },
      { field: 'customer.notes', before: 'Old note', after: null },
    ]);
  });

  it('F20: a required field cannot be removed, by a Manager either', async () => {
    const res = failed(await submit({ customer: { primaryPhone: null, contactPerson: '' } }));
    expect(res.fields).toMatchObject({
      'customer.primaryPhone': 'Primary phone cannot be removed — enter the correct number.',
      'customer.contactPerson': 'Contact person must be at least 2 characters.',
    });
    nothingWritten();
  });

  it('F20: an empty string on file against a clear is no change', async () => {
    live = customerRow({ contactRole: '' });
    expect(failed(await submit({ customer: { contactRole: null } })).fields).toEqual({ _form: 'No changes to submit.' });
  });

  it('F19: an invalid phone is refused with the notes beside it — nothing is dropped and nothing written', async () => {
    const res = failed(await submit({ customer: { primaryPhone: '1234567', notes: 'New note' } }));
    expect(res.fields).toEqual({ 'customer.primaryPhone': INVALID_PHONE_MESSAGE });
    nothingWritten();
  });

  it('N02: a legal name that is only markup is refused on the direct write', async () => {
    asStaff('STEWARD');
    const res = failed(await submit({ customer: { legalName: '<shop>' } }));
    expect(res.fields).toEqual({ 'customer.legalName': 'Legal name must be at least 2 characters.' });
    nothingWritten();
  });

  it('F21: a Manager may mark the equipment not counted', async () => {
    live = customerRow({}, [branchRow({ equipmentConfirmed: true })]);
    const res = await submit({ branches: [{ branchId: B1, equipmentConfirmed: false }] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(tx.branch.updateMany.mock.calls[0]![0].data).toMatchObject({ equipmentConfirmed: false });
  });
});

describe('F20 / F19 — what a salesman’s request records', () => {
  it('a clear is recorded as after: null', async () => {
    expect((await submit({ customer: { notes: '<b></b>', altPhone: '' } })).ok).toBe(true);
    expect(storedChanges()).toEqual([
      { field: 'customer.altPhone', before: '+96899887766', after: null },
      { field: 'customer.notes', before: 'Old note', after: null },
    ]);
  });

  it('Persian and Arabic-Indic digits are recorded normalized', async () => {
    expect((await submit({ customer: { primaryPhone: '۹۸۷۶ ۵۴۳۲', altPhone: '٩٩٨٨٧٧٦٦' } })).ok).toBe(true);
    // The alt phone is the one on file already: nothing to record for it.
    expect(storedChanges()).toEqual([{ field: 'customer.primaryPhone', before: '+96891234567', after: '+96898765432' }]);
  });
});

describe('F16 — the channel pair', () => {
  it('a channel change clears a sub-channel of the old channel, as a change of its own', async () => {
    expect((await submit({ customer: { channelId: CH_B } })).ok).toBe(true);
    expect(storedChanges()).toEqual([
      { field: 'customer.channelId', before: CH_A, after: CH_B },
      { field: 'customer.subChannelId', before: SUB_A, after: null },
    ]);
  });

  it('a sub-channel that belongs to the new channel is kept', async () => {
    live = customerRow({ subChannelId: SUB_B });
    expect((await submit({ customer: { channelId: CH_B } })).ok).toBe(true);
    expect(storedChanges()).toEqual([{ field: 'customer.channelId', before: CH_A, after: CH_B }]);
  });

  it('a foreign or retired sub-channel, or a retired channel, is a field error and nothing is written', async () => {
    expect(failed(await submit({ customer: { subChannelId: SUB_B } })).fields).toEqual({
      'customer.subChannelId': SUB_CHANNEL_MISMATCH_MESSAGE,
    });
    db.subChannel.findUnique.mockResolvedValue({ channelId: CH_A, isActive: false });
    const retiredSub = 'cksubchannel0000000000009';
    expect(failed(await submit({ customer: { subChannelId: retiredSub } })).fields).toEqual({
      'customer.subChannelId': SUB_CHANNEL_INACTIVE_MESSAGE,
    });
    db.channel.findUnique.mockResolvedValue({ isActive: false });
    expect(failed(await submit({ customer: { channelId: CH_B, subChannelId: null } })).fields).toEqual({
      'customer.channelId': CHANNEL_INACTIVE_MESSAGE,
    });
    nothingWritten();
  });

  it('a mismatched pair already on file does not block an unrelated edit', async () => {
    live = customerRow({ subChannelId: SUB_B });
    expect((await submit({ customer: { notes: 'New note' } })).ok).toBe(true);
    expect(db.channel.findUnique).not.toHaveBeenCalled();
    expect(db.subChannel.findUnique).not.toHaveBeenCalled();
  });

  // Post-merge review of phase 2, finding 2: loaded A / SUB_A, an import moved
  // the customer to B and cleared the sub-channel, and he picked C, which
  // empties the sub-channel box.
  const pickedC = () =>
    body({
      customer: { channelId: CH_C, subChannelId: null },
      customerBase: { channelId: CH_A, subChannelId: SUB_A },
    });

  it('a stale channel hands back the sub-channel saved with it, without naming it when it converged', async () => {
    const b = await pickedC();
    live = customerRow({ channelId: CH_B, subChannelId: null });
    const res = failed(await submitEditAction(b));
    expect(res.code).toBe('STALE_FIELDS');
    expect(res.fields).toEqual({ 'customer.channelId': STALE_FIELD_MESSAGE });
    expect(res.current).toEqual({ 'customer.channelId': CH_B, 'customer.subChannelId': null });
    nothingWritten();
  });

  it('a stale channel beside a stale sub-channel: both named, the saved pair handed back', async () => {
    const b = await pickedC();
    live = customerRow({ channelId: CH_B, subChannelId: SUB_B });
    const res = failed(await submitEditAction(b));
    expect(res.fields).toEqual({
      'customer.channelId': STALE_FIELD_MESSAGE,
      'customer.subChannelId': STALE_FIELD_MESSAGE,
    });
    expect(res.current).toEqual({ 'customer.channelId': CH_B, 'customer.subChannelId': SUB_B });
  });

  it('the direct write’s re-check under the lock hands back the saved sub-channel beside a stale channel too', async () => {
    asStaff('MANAGER');
    // Read: A / SUB_A, so B with no sub-channel is a change of both. Under the
    // lock: C with none — the channel moved, the sub-channel already empty.
    locked = customerRow({ channelId: CH_C, subChannelId: null });
    const res = failed(await submit({ customer: { channelId: CH_B, subChannelId: null } }));
    expect(res.fields).toEqual({ 'customer.channelId': STALE_FIELD_MESSAGE });
    expect(res.current).toEqual({ 'customer.channelId': CH_C, 'customer.subChannelId': null });
    expect(h.rolledBack).toBe(true);
    nothingWritten();
  });
});

describe('F21 — equipment counted', () => {
  it('entering a count marks the counts confirmed', async () => {
    expect((await submit({ branches: [{ branchId: B1, coolersCount: 2 }] })).ok).toBe(true);
    expect(storedChanges()).toEqual([
      { field: `branch.${B1}.coolersCount`, before: 0, after: 2 },
      { field: `branch.${B1}.equipmentConfirmed`, before: false, after: true },
    ]);
  });

  it('a tick with every count unchanged is recorded — a zero counted is a real zero', async () => {
    expect((await submit({ branches: [{ branchId: B1, equipmentConfirmed: true, coolersCount: 0 }] })).ok).toBe(true);
    expect(storedChanges()).toEqual([{ field: `branch.${B1}.equipmentConfirmed`, before: false, after: true }]);
  });

  it('counts already confirmed are not confirmed again', async () => {
    live = customerRow({}, [branchRow({ equipmentConfirmed: true, coolersCount: 1 })]);
    expect((await submit({ branches: [{ branchId: B1, coolersCount: 2 }] })).ok).toBe(true);
    expect(storedChanges()).toEqual([{ field: `branch.${B1}.coolersCount`, before: 1, after: 2 }]);
  });

  it('a salesman cannot take it back (owner decision 3)', async () => {
    live = customerRow({}, [branchRow({ equipmentConfirmed: true })]);
    const res = failed(await submit({ branches: [{ branchId: B1, equipmentConfirmed: false }] }));
    expect(res.fields).toEqual({ [`branch.${B1}.equipment`]: EQUIPMENT_UNCONFIRM_MESSAGE });
    nothingWritten();
  });
});

describe('ruling 7 — the capture time and accuracy travel with the point', () => {
  it('a moved point records its accuracy and capture time with it', async () => {
    const at = '2026-09-28T08:00:00.000Z';
    expect((await submit({ branches: [{ branchId: B1, gpsLat: 23.7, gpsLng: 58.4, gpsAccuracy: 4, gpsCapturedAt: at }] })).ok).toBe(true);
    const stored = storedChanges();
    expect(stored.map((c) => c.field)).toEqual([
      `branch.${B1}.gpsLat`,
      `branch.${B1}.gpsLng`,
      `branch.${B1}.gpsAccuracy`,
      `branch.${B1}.gpsCapturedAt`,
    ]);
    expect(stored[3]!.after).toEqual(new Date(at));
  });

  it('the same point with a new capture time is no change at all', async () => {
    const res = failed(
      await submit({ branches: [{ branchId: B1, gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 3, gpsCapturedAt: '2026-09-28T08:00:00.000Z' }] })
    );
    expect(res.fields).toEqual({ _form: 'No changes to submit.' });
  });
});

describe('the point is one value (phase-2 review, finding 2)', () => {
  const at = '2026-09-28T08:00:00.000Z';
  const lat = `branch.${B1}.gpsLat`;
  const lng = `branch.${B1}.gpsLng`;
  /** The branch holds (23.6, 58.4); each of these corrects one coordinate of it. */
  const fix = { branchId: B1, gpsAccuracy: 4, gpsCapturedAt: at };
  const latitudeOnly = { ...fix, gpsLat: 23.7, gpsLng: 58.4 };
  const longitudeOnly = { ...fix, gpsLat: 23.6, gpsLng: 58.5 };

  it('a salesman’s one-coordinate correction records the whole point, so its approval can judge it whole', async () => {
    expect((await submit({ branches: [latitudeOnly] })).ok).toBe(true);
    expect(storedChanges().slice(0, 2)).toEqual([
      { field: lat, before: 23.6, after: 23.7 },
      { field: lng, before: 58.4, after: 58.4 },
    ]);
  });

  it('the ordinary direct-write correction still lands: the whole point, with its accuracy and capture time', async () => {
    asStaff('MANAGER');
    const res = await submit({ branches: [latitudeOnly] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(tx.branch.updateMany.mock.calls[0]![0].data).toMatchObject({
      gpsLat: 23.7,
      gpsLng: 58.4,
      gpsAccuracy: 4,
      gpsCapturedAt: new Date(at),
    });
    expect(tx.customerEdit.create.mock.calls[0]![0].data.fieldChanges).toEqual([
      { field: lat, before: 23.6, after: 23.7 },
      { field: lng, before: 58.4, after: 58.4 },
      { field: `branch.${B1}.gpsAccuracy`, before: 8, after: 4 },
      { field: `branch.${B1}.gpsCapturedAt`, before: CAPTURED, after: new Date(at) },
    ]);
  });

  it('two direct writes on complementary coordinates: the second is STALE_FIELDS, never a point mixing the two', async () => {
    asStaff('MANAGER');
    // Another Manager's latitude-only correction commits between this write's
    // read and its lock.
    locked = customerRow({}, [branchRow({ gpsLat: 23.7, gpsAccuracy: 3 })]);
    const res = failed(await submit({ branches: [longitudeOnly] }));
    expect(res).toMatchObject({
      code: 'STALE_FIELDS',
      fields: { [`branch.${B1}.gps`]: STALE_LOCATION_MESSAGE },
      current: { [lat]: 23.7, [lng]: 58.4, [`branch.${B1}.gpsAccuracy`]: 3 },
    });
    expect(h.rolledBack).toBe(true);
    nothingWritten();
  });

  it('an approval of the other coordinate landing between a direct write’s read and its lock: STALE_FIELDS too', async () => {
    asStaff('STEWARD');
    // A salesman's approved longitude-only correction, with its own capture time.
    const approved = { gpsLng: 58.5, gpsAccuracy: null, gpsCapturedAt: new Date(at) };
    locked = customerRow({}, [branchRow(approved)]);
    const res = failed(await submit({ branches: [latitudeOnly] }));
    expect(res).toMatchObject({ code: 'STALE_FIELDS', current: { [lat]: 23.6, [lng]: 58.5 } });
    expect(h.rolledBack).toBe(true);
    nothingWritten();
  });

  it('at submit, the other coordinate already moved is STALE_FIELDS on the location, as before', async () => {
    const b = await body({ branches: [latitudeOnly] }); // loaded (23.6, 58.4)
    live = customerRow({}, [branchRow({ gpsLng: 58.5 })]);
    const res = failed(await submitEditAction(b));
    expect(res).toMatchObject({
      code: 'STALE_FIELDS',
      fields: { [`branch.${B1}.gps`]: STALE_LOCATION_MESSAGE },
    });
    nothingWritten();
  });
});

describe('owner decision 2026-10-05: the ±100 m GPS standard at a salesman’s submit', () => {
  const point = (accuracy: number | null, extra: Record<string, unknown> = {}) => ({
    branchId: B1,
    gpsLat: 23.61,
    gpsLng: 58.41,
    gpsAccuracy: accuracy,
    gpsCapturedAt: CAPTURED.toISOString(),
    ...extra,
  });

  it('a captured point worse than ±100 m is refused in the branch’s location slot; nothing is written', async () => {
    const res = failed(await submit({ branches: [point(150)] }));
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(res.fields![`branch.${B1}.gps`]).toMatch(/±150 m, over the 100 m limit/);
    nothingWritten();
  });

  it('±100 m goes through', async () => {
    const res = await submit({ branches: [point(100)] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it('a point typed in with a reason is not held to it: the manager judges it', async () => {
    const res = await submit({ branches: [point(null, { gpsManualReason: 'GPS not working inside the mall' })] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it('a draft may hold a poor fix; only the submit is gated', async () => {
    const res = await submit({ isDraft: true, branches: [point(150)] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });
});

describe('F1 — a salesman’s submit tells his region’s Accountant, for information', () => {
  const hierarchy = async () => vi.mocked((await import('@/lib/notify-hierarchy')).notifySalesmanRequest);
  const steps = async () => vi.mocked((await import('@/lib/notifications')).resolveStepAudience);

  beforeEach(async () => {
    (await hierarchy()).mockReset().mockResolvedValue({ mustAct: [], fyi: [] });
    (await steps()).mockReset().mockResolvedValue(['u-sup']);
  });

  it('hands the hierarchy HIS branch’s region and the supervisor already told', async () => {
    // B2 of the same customer is on another route in another region: not his.
    live = customerRow({}, [branchRow(), branchRow({ id: B2, branchCode: 'MCT-0002', routeId: 'r2', regionId: 'g2' })]);
    expect((await submit({ customer: { notes: 'Closed on Fridays' } })).ok).toBe(true);
    const notify = await hierarchy();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toEqual({
      event: 'UPDATE',
      submitter: { id: 'u-sales', supervisorId: 'u-sup' },
      regionId: 'g1',
      editId: 'e-new',
      customerId: CUST,
      subject: { legalName: 'Al Noor Trading', nmwcCode: 'NMWC-000001' },
      alreadyTold: ['u-sup'],
    });
  });

  it('a draft tells nobody, and neither does a Steward’s or a Manager’s direct write', async () => {
    expect((await submit({ isDraft: true, customer: { notes: 'Half done' } })).ok).toBe(true);
    asStaff('STEWARD');
    expect((await submit({ customer: { notes: 'Steward note' } })).ok).toBe(true);
    asStaff('MANAGER');
    expect((await submit({ customer: { notes: 'Manager note' } })).ok).toBe(true);
    expect(await hierarchy()).not.toHaveBeenCalled();
  });

  it('a failure in the hierarchy write does not undo or fail the submit that already landed', async () => {
    (await hierarchy()).mockRejectedValueOnce(new Error('pool timeout'));
    const res = await submit({ customer: { notes: 'Closed on Fridays' } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(db.customerEdit.create).toHaveBeenCalledTimes(1);
  });
});
