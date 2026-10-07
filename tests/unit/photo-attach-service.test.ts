// @vitest-environment node
/**
 * services/photos.ts, reached the way the photo slot reaches it now: through
 * app/api/photos/attach and app/api/photos/detach (post-merge review of
 * 30ec23a). Prisma is mocked; the service, runAction and the access checks are
 * real. Moving the slot off server actions must not have dropped a check:
 * role, uploader, kind, route or region scope, and input validation all still
 * refuse here, before anything is written.
 *
 * And a re-sent attach (the first got no answer) is answered by what is true
 * on the server: the photo already on the requested slot is ok and writes
 * nothing; a photo on any OTHER slot is still refused. The slot used to read
 * that refusal as "the first one landed", and after a re-send answered "the
 * database did not respond", a photo that was on the slot showed as failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const s = vi.hoisted(() => ({
  user: { id: 'u1', role: 'SALESMAN', username: 'c4' } as { id: string; role: string; username: string },
  scope: {
    ownedRouteId: 'r1' as string | null,
    teamRouteIds: [] as string[],
    managedRegionIds: [] as string[],
  },
}));
const db = vi.hoisted(() => ({
  attachment: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  customer: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  branch: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  user: { findUniqueOrThrow: vi.fn() },
  customerEdit: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  // The customer row lock every photo transaction takes first.
  $queryRaw: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: s.user }) }));
vi.mock('@/lib/audit', () => audit);
vi.mock('@/lib/completeness', () => ({ scoreCustomer: () => 50, scoreBranch: () => 50 }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/access')>()),
  loadScope: async () => s.scope,
}));

import { POST as attachPOST } from '@/app/api/photos/attach/route';
import { POST as detachPOST } from '@/app/api/photos/detach/route';
import {
  ALREADY_ATTACHED_MESSAGE,
  PHOTO_CHANGED_MESSAGE,
  PHOTO_CONFLICT_MESSAGE,
  PHOTO_GONE_MESSAGE,
  PHOTO_TARGET_CHANGED_MESSAGE,
} from '@/lib/photo-attach';
import { CR_DOCUMENT_LOCKED_MESSAGE, PHOTO_WRITER_ROLES } from '@/lib/permissions';

const HOST = 'nmwc.example';
async function call(handler: (req: NextRequest) => Promise<Response>, name: string, body: unknown) {
  const res = await handler(
    new NextRequest(`https://${HOST}/api/photos/${name}`, {
      method: 'POST',
      headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; code?: string; message?: string; fields?: Record<string, string> };
}
const attach = (body: unknown) => call(attachPOST, 'attach', body);
const detach = (body: unknown) => call(detachPOST, 'detach', body);

// cuids, as the schemas require.
const ATT = 'ckattach000000000000000001';
const CUST = 'ckcustomer0000000000000001';
const B1 = 'ckbranch000000000000000001';
const B2 = 'ckbranch000000000000000002';

/** A photo fresh from finalize: captured by u1, on no slot. */
const photo = (over: Record<string, unknown> = {}) => ({
  id: ATT,
  kind: 'SHOP',
  capturedById: 'u1',
  customerId: null,
  branchId: null,
  branchExtraId: null,
  editId: null,
  deletedAt: null,
  ...over,
});
/** Branch B1 on route r1, region g1, of customer CUST. */
const branch = (over: Record<string, unknown> = {}) => ({
  id: B1,
  customerId: CUST,
  routeId: 'r1',
  regionId: 'g1',
  deletedAt: null,
  shopPhotoId: null,
  signboardPhotoId: null,
  customer: { id: CUST, branches: [{ id: B1, routeId: 'r1', regionId: 'g1', deletedAt: null }] },
  ...over,
});
const customer = (over: Record<string, unknown> = {}) => ({
  id: CUST,
  deletedAt: null,
  crPhotoId: null,
  branches: [{ id: B1, routeId: 'r1', regionId: 'g1', deletedAt: null }],
  ...over,
});

const wrote = () =>
  db.$transaction.mock.calls.length +
  db.attachment.update.mock.calls.length +
  db.attachment.updateMany.mock.calls.length +
  db.branch.update.mock.calls.length +
  db.customer.update.mock.calls.length +
  audit.writeAudit.mock.calls.length;

beforeEach(() => {
  s.user = { id: 'u1', role: 'SALESMAN', username: 'c4' };
  s.scope = { ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: [] };
  for (const group of [db.attachment, db.customer, db.branch, db.user, db.customerEdit]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  db.$transaction.mockReset().mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockReset().mockResolvedValue([]);
  audit.writeAudit.mockReset();
  audit.getAuditEnvelope.mockReset().mockResolvedValue({});
  db.user.findUniqueOrThrow.mockResolvedValue({ ownedRouteId: 'r1' });
  // The guarded claim (attach) and soft-delete (Remove) take their one row.
  db.attachment.updateMany.mockResolvedValue({ count: 1 });
  db.branch.findFirst.mockResolvedValue(branch());
  db.branch.findUniqueOrThrow.mockResolvedValue(branch());
  db.customer.findFirst.mockResolvedValue(customer());
  db.customer.findUniqueOrThrow.mockResolvedValue(customer());
  // The attach's second read of its target, under the lock: still as read before it.
  db.branch.findUnique.mockResolvedValue(branch());
  db.customer.findUnique.mockResolvedValue(customer());
});

describe('attach, through the route: every check still refuses before a write', () => {
  it.each(['SUPERVISOR', 'VIEWER', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM'])('%s cannot attach', async (role) => {
    s.user = { ...s.user, role };
    db.attachment.findUnique.mockResolvedValue(photo());
    const res = await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' });
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Your role cannot attach photos.' });
    expect(wrote()).toBe(0);
  });

  it('refuses a malformed request with the fields to fix', async () => {
    const res = await attach({ attachmentId: 'not-a-cuid', branchId: B1, slot: 'SHOP' });
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(res.fields?.attachmentId).toBeTruthy();
    expect((await attach({ attachmentId: ATT, branchId: B1, slot: 'CR' })).code).toBe('VALIDATION_FAILED');
    expect(db.attachment.findUnique).not.toHaveBeenCalled();
    expect(wrote()).toBe(0);
  });

  it("a salesman cannot attach another salesman's photo, or one soft-deleted", async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ capturedById: 'someone-else' }));
    expect(await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    db.attachment.findUnique.mockResolvedValue(photo({ deletedAt: new Date() }));
    expect((await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).code).toBe('NOT_FOUND');
    expect(wrote()).toBe(0);
  });

  it('a salesman cannot attach to a branch off his route', async () => {
    db.attachment.findUnique.mockResolvedValue(photo());
    db.branch.findFirst.mockResolvedValue(branch({ routeId: 'r9' }));
    const res = await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' });
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Branch not on your route.' });
    expect(wrote()).toBe(0);
  });

  it('a manager cannot attach outside his regions — none at all is none', async () => {
    s.user = { ...s.user, role: 'MANAGER' };
    s.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g7'] };
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR' }));
    expect(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    s.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };
    db.attachment.findUnique.mockResolvedValue(photo());
    expect((await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).code).toBe('FORBIDDEN');
    expect(wrote()).toBe(0);
  });

  it('a photo of one kind does not go into a slot of another', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'SIGNBOARD' }));
    const res = await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' });
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(res.fields?.attachmentId).toMatch(/^Slot SHOP requires a SHOP photo/);
    expect(wrote()).toBe(0);
  });

  it('a fresh photo on his own branch is attached, with its audit row', async () => {
    db.attachment.findUnique.mockResolvedValue(photo());
    expect(await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).toEqual({ ok: true });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.attachment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: ATT }),
      data: { branchId: B1, kind: 'SHOP' },
    });
    expect(db.attachment.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
  });

  // Pre-merge review of 9edcbad: attaches from one phone now overlap, and each
  // recomputes the completeness score from what it reads — the later one wrote
  // a score that left out the other photo. The customer's row lock comes first.
  it.each([
    ['a branch photo', () => photo(), { branchId: B1, slot: 'SHOP' }],
    ['the CR photo', () => photo({ kind: 'CR' }), { customerId: CUST, slot: 'CR' }],
  ])('%s: the transaction locks the customer row before it reads or writes anything', async (_n, att, body) => {
    db.attachment.findUnique.mockResolvedValue(att());
    expect(await attach({ attachmentId: ATT, ...body })).toEqual({ ok: true });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, id] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/FROM "Customer" WHERE "id" = \? FOR UPDATE/);
    expect(id).toBe(CUST);
    const lockedAt = db.$queryRaw.mock.invocationCallOrder[0];
    for (const f of [db.attachment.update, db.attachment.updateMany, db.branch.update, db.customer.update, db.customer.findUniqueOrThrow, db.branch.findUniqueOrThrow, db.customer.findUnique, db.branch.findUnique]) {
      for (const order of f.mock.invocationCallOrder) expect(order).toBeGreaterThan(lockedAt);
    }
  });
});

describe('attach sent again for the slot it already landed on: ok, and nothing written', () => {
  it.each([
    ['the shop slot', photo({ branchId: B1 }), { branchId: B1, slot: 'SHOP' }, () => db.branch.findFirst.mockResolvedValue(branch({ shopPhotoId: ATT }))],
    [
      'the signboard slot',
      photo({ kind: 'SIGNBOARD', branchId: B1 }),
      { branchId: B1, slot: 'SIGNBOARD' },
      () => db.branch.findFirst.mockResolvedValue(branch({ signboardPhotoId: ATT })),
    ],
    ['the CR slot', photo({ kind: 'CR', customerId: CUST }), { customerId: CUST, slot: 'CR' }, () => db.customer.findFirst.mockResolvedValue(customer({ crPhotoId: ATT }))],
    ['an extra (FREE) photo of the branch', photo({ kind: 'FREE', branchId: B1, branchExtraId: B1 }), { branchId: B1, slot: 'FREE' }, () => {}],
  ] as const)('%s', async (_label, att, target, slotHoldsIt) => {
    db.attachment.findUnique.mockResolvedValue(att);
    slotHoldsIt();
    expect(await attach({ attachmentId: ATT, ...target })).toEqual({ ok: true });
    expect(wrote()).toBe(0);
  });

  it('still only for a caller who may attach there now — the scope checks run first', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ branchId: B1 }));
    db.branch.findFirst.mockResolvedValue(branch({ shopPhotoId: ATT, routeId: 'r9' }));
    expect(await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(wrote()).toBe(0);
  });
});

describe('a photo on ANY other slot is still refused as already attached, and nothing is written', () => {
  const refused = async (att: ReturnType<typeof photo>, target: Record<string, string>) => {
    db.attachment.findUnique.mockResolvedValue(att);
    const res = await attach({ attachmentId: ATT, ...target });
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(res.fields?.attachmentId).toBe(ALREADY_ATTACHED_MESSAGE);
    expect(wrote()).toBe(0);
  };

  it("another branch's shop slot", () => refused(photo({ branchId: B2 }), { branchId: B1, slot: 'SHOP' }));
  it('the same branch, as an extra photo, sent for its shop slot', () =>
    refused(photo({ kind: 'FREE', branchId: B1, branchExtraId: B1 }), { branchId: B1, slot: 'SHOP' }));
  it('the same branch, its signboard, sent for the extra photos', () =>
    refused(photo({ kind: 'SIGNBOARD', branchId: B1 }), { branchId: B1, slot: 'FREE' }));
  it("a customer's CR slot, sent for a branch", () =>
    refused(photo({ kind: 'CR', customerId: CUST }), { branchId: B1, slot: 'SHOP' }));
  it('claimed by a new-customer request', () => refused(photo({ editId: 'e1' }), { branchId: B1, slot: 'SHOP' }));
  it('wired to this shop slot, but the slot holds another photo now', async () => {
    db.branch.findFirst.mockResolvedValue(branch({ shopPhotoId: 'ckother0000000000000000001' }));
    await refused(photo({ branchId: B1 }), { branchId: B1, slot: 'SHOP' });
  });
  it("wired to this customer, but its CR slot is empty", () =>
    refused(photo({ kind: 'CR', customerId: CUST }), { customerId: CUST, slot: 'CR' }));
});

describe('detach, through the route', () => {
  it('a read-only role cannot remove a photo', async () => {
    s.user = { ...s.user, id: 'v1', role: 'VIEWER' };
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1 }));
    expect(await detach({ attachmentId: ATT })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(wrote()).toBe(0);
  });

  // Owner decision 2026-09-27 (pre-merge review): only the roles that can
  // attach a photo may remove one. The rule refused VIEWER alone, so these four
  // could remove any photo they could see.
  it.each(['SUPERVISOR', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM'])(
    '%s cannot remove a photo, even one it can see',
    async (role) => {
      s.user = { id: 'x1', role, username: 'x1' };
      s.scope = { ownedRouteId: null as unknown as string, teamRouteIds: ['r1'], managedRegionIds: ['g1'] };
      db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1 }));
      db.branch.findUnique.mockResolvedValue({ customerId: CUST });
      db.customer.findFirst.mockResolvedValue(customer());
      const res = await detach({ attachmentId: ATT });
      expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      if (role === 'FINANCE_MANAGER' || role === 'GM') {
        // Org-wide readers: past the scope check, refused by the role.
        expect(res.message).toBe('Your role cannot remove photos.');
      }
      expect(wrote()).toBe(0);
    }
  );

  it.each(['STEWARD', 'MANAGER'])('%s can still remove a photo in scope', async (role) => {
    s.user = { id: 'x2', role, username: 'x2' };
    s.scope = { ownedRouteId: null as unknown as string, teamRouteIds: [], managedRegionIds: ['g1'] };
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1, capturedById: 'someone-else' }));
    db.branch.findUnique.mockResolvedValue(branch());
    db.customer.findFirst.mockResolvedValue(customer());
    db.customer.findUnique.mockResolvedValue(customer());
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: true });
  });

  it('a salesman removes only photos he captured, on his own route', async () => {
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1, capturedById: 'someone-else' }));
    db.branch.findUnique.mockResolvedValue({ customerId: CUST });
    db.customer.findFirst.mockResolvedValue(customer());
    expect(await detach({ attachmentId: ATT })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: 'You can only remove photos you captured.',
    });
    db.customer.findFirst.mockResolvedValue(customer({ branches: [{ routeId: 'r9', regionId: 'g1', deletedAt: null }] }));
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1 }));
    expect((await detach({ attachmentId: ATT })).code).toBe('NOT_FOUND');
    expect(wrote()).toBe(0);
  });

  it('refuses an id that is not one — a filter object must never reach the query', async () => {
    for (const attachmentId of [{ not: 'x' }, 42, null, 'not-a-cuid']) {
      const res = await detach({ attachmentId });
      expect(res, JSON.stringify(attachmentId)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect((await detach({})).code).toBe('VALIDATION_FAILED');
    expect(db.attachment.findFirst).not.toHaveBeenCalled();
    expect(wrote()).toBe(0);
  });

  it('his own photo is removed, with its audit row', async () => {
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1 }));
    db.branch.findUnique.mockResolvedValue(branch());
    db.customer.findFirst.mockResolvedValue(customer());
    db.customer.findUnique.mockResolvedValue(customer());
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: true });
    // Read removed or not first (a removed one is PHOTO_GONE, after the checks); live, under the lock.
    expect(db.attachment.findFirst.mock.calls).toEqual([[{ where: { id: ATT } }], [{ where: { id: ATT, deletedAt: null } }]]);
    // X-PHOTO-1: removed only where the checks found it — guarded on its wiring.
    expect(db.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: ATT, deletedAt: null, customerId: null, branchId: B1, branchExtraId: null, editId: null },
      data: { deletedAt: expect.any(Date), hash: null },
    });
    expect(db.attachment.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    // The branch's customer is locked first, as on attach.
    const [, id] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(id).toBe(CUST);
    for (const order of db.attachment.updateMany.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(db.$queryRaw.mock.invocationCallOrder[0]);
    }
  });
});

// N06: the checks above read the photo before any lock. In the gap a Remove
// could soft-delete it, a new-customer request claim it, or another attach wire
// it elsewhere, and an unconditional update then put a deleted photo on a live
// slot, or one photo on two. The transaction now claims it with a guarded write
// first, and writes nothing else unless that took exactly the one row.
describe('N06: attach claims the photo under the lock, before anything else is written', () => {
  const PREV = 'ckprevious0000000000000001';
  const EDIT = 'ckedit00000000000000000001';
  const TARGETS = [
    ['the shop slot', () => photo(), { branchId: B1, slot: 'SHOP' }],
    ['the signboard slot', () => photo({ kind: 'SIGNBOARD' }), { branchId: B1, slot: 'SIGNBOARD' }],
    ['the CR slot', () => photo({ kind: 'CR' }), { customerId: CUST, slot: 'CR' }],
    ['the extra photos', () => photo(), { branchId: B1, slot: 'FREE' }],
  ] as const;

  beforeEach(() => {
    // Every slot already holds an earlier photo: a refused claim that still
    // replaced it would show as a soft-delete of PREV.
    db.branch.findUniqueOrThrow.mockResolvedValue(branch({ shopPhotoId: PREV, signboardPhotoId: PREV }));
    db.customer.findUniqueOrThrow.mockResolvedValue(customer({ crPhotoId: PREV }));
  });

  const nothingElseWritten = () => {
    expect(db.attachment.updateMany).toHaveBeenCalledTimes(1);
    expect(db.attachment.update).not.toHaveBeenCalled();
    expect(db.branch.update).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  };

  it.each(TARGETS)(
    '%s: the claim re-asserts live, on no slot, unclaimed, his own capture and the kind — after the lock, before any other write',
    async (_n, att, target) => {
      db.attachment.findUnique.mockResolvedValue(att());
      expect(await attach({ attachmentId: ATT, ...target })).toEqual({ ok: true });
      expect(db.attachment.updateMany).toHaveBeenCalledTimes(1);
      const [{ where }] = db.attachment.updateMany.mock.calls[0] as [{ where: unknown }];
      expect(where).toEqual({
        id: ATT,
        deletedAt: null,
        customerId: null,
        branchId: null,
        branchExtraId: null,
        editId: null,
        capturedById: 'u1',
        ...(target.slot === 'FREE' ? {} : { kind: target.slot }),
      });
      const claimAt = db.attachment.updateMany.mock.invocationCallOrder[0];
      expect(claimAt).toBeGreaterThan(db.$queryRaw.mock.invocationCallOrder[0]);
      for (const f of [db.attachment.update, db.branch.update, db.customer.update, audit.writeAudit]) {
        for (const order of f.mock.invocationCallOrder) expect(order).toBeGreaterThan(claimAt);
      }
      if (target.slot !== 'FREE') {
        // The photo it replaces is still soft-deleted — after the claim.
        expect(db.attachment.update).toHaveBeenCalledWith({
          where: { id: PREV },
          data: { deletedAt: expect.any(Date), hash: null },
        });
      }
    }
  );

  it("a Steward's claim takes anyone's capture, and is still audited as FORCE_OVERRIDE", async () => {
    s.user = { id: 'st1', role: 'STEWARD', username: 'st1' };
    db.attachment.findUnique.mockResolvedValue(photo({ capturedById: 'u1' }));
    expect(await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).toEqual({ ok: true });
    const [{ where }] = db.attachment.updateMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(where).not.toHaveProperty('capturedById');
    expect(where).toMatchObject({ id: ATT, deletedAt: null, branchId: null, editId: null, kind: 'SHOP' });
    expect(audit.writeAudit.mock.calls[0][2]).toMatchObject({ action: 'FORCE_OVERRIDE' });
  });

  describe.each([
    ['removed by a Remove in the gap', (p: ReturnType<typeof photo>) => ({ ...p, deletedAt: new Date() })],
    ['put on another branch in the gap', (p: ReturnType<typeof photo>) => ({ ...p, branchId: B2 })],
    ['claimed by a new-customer request in the gap', (p: ReturnType<typeof photo>) => ({ ...p, editId: EDIT })],
    ['gone altogether', () => null],
  ])('%s', (_label, after) => {
    it.each(TARGETS)('%s: refused — the earlier photo, the slot and the score untouched, no audit row', async (_n, att, target) => {
      db.attachment.findUnique.mockResolvedValueOnce(att()).mockResolvedValueOnce(after(att()));
      db.attachment.updateMany.mockResolvedValue({ count: 0 });
      const res = await attach({ attachmentId: ATT, ...target });
      expect(res).toEqual({ ok: false, code: 'PHOTO_CONFLICT', message: PHOTO_CONFLICT_MESSAGE });
      nothingElseWritten();
    });
  });

  it.each([
    [
      'the shop slot',
      () => photo(),
      () => photo({ branchId: B1 }),
      { branchId: B1, slot: 'SHOP' },
      () => db.branch.findUnique.mockResolvedValue(branch({ shopPhotoId: ATT })),
    ],
    [
      'the signboard slot',
      () => photo({ kind: 'SIGNBOARD' }),
      () => photo({ kind: 'SIGNBOARD', branchId: B1 }),
      { branchId: B1, slot: 'SIGNBOARD' },
      () => db.branch.findUnique.mockResolvedValue(branch({ signboardPhotoId: ATT })),
    ],
    [
      'the CR slot',
      () => photo({ kind: 'CR' }),
      () => photo({ kind: 'CR', customerId: CUST }),
      { customerId: CUST, slot: 'CR' },
      () => db.customer.findUnique.mockResolvedValue(customer({ crPhotoId: ATT })),
    ],
    [
      'the extra photos',
      () => photo(),
      () => photo({ kind: 'FREE', branchId: B1, branchExtraId: B1 }),
      { branchId: B1, slot: 'FREE' },
      () => {},
    ],
  ] as const)(
    '%s: an earlier send of this attach landed while it waited for the lock — ok, and nothing else written',
    async (_n, before, now, target, slotHoldsIt) => {
      db.attachment.findUnique.mockResolvedValueOnce(before()).mockResolvedValueOnce(now());
      db.attachment.updateMany.mockResolvedValue({ count: 0 });
      slotHoldsIt();
      expect(await attach({ attachmentId: ATT, ...target })).toEqual({ ok: true });
      nothingElseWritten();
    }
  );

  it('its own columns name this slot, but the slot holds another photo: refused', async () => {
    db.attachment.findUnique.mockResolvedValueOnce(photo()).mockResolvedValueOnce(photo({ branchId: B1 }));
    db.attachment.updateMany.mockResolvedValue({ count: 0 });
    db.branch.findUnique.mockResolvedValue(branch({ shopPhotoId: PREV }));
    expect(await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).toMatchObject({ code: 'PHOTO_CONFLICT' });
    nothingElseWritten();
  });
});

// Post-merge review (2026-09-29): attach read its target before any lock and
// never again. A Steward's merge holding the customer's lock while the attach
// waited had tombstoned the customer (or moved the branch to the winner) by the
// time the lock was the attach's: the photo was claimed onto the tombstone and
// answered ok, or the tombstone was rescored instead of the branch's new owner.
// Now the target is read again under the lock, before the claim.
describe('attach reads its target again under the lock, before the claim', () => {
  const WINNER = 'ckcustomer0000000000000009';
  const customerSelect = { deletedAt: true, branches: { where: { deletedAt: null }, select: { routeId: true, regionId: true, deletedAt: true } } };
  const refusedBeforeTheClaim = (res: Awaited<ReturnType<typeof attach>>) => {
    expect(res).toEqual({ ok: false, code: 'PHOTO_CHANGED', message: PHOTO_TARGET_CHANGED_MESSAGE });
    expect(db.attachment.updateMany).not.toHaveBeenCalled();
    expect(db.attachment.update).not.toHaveBeenCalled();
    expect(db.branch.update).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  };

  it('the CR slot: the customer was tombstoned (merged away) between the read and the lock — refused, nothing written', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR' }));
    db.customer.findUnique.mockResolvedValue(customer({ deletedAt: new Date() }));
    refusedBeforeTheClaim(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' }));
    // Owner decision 2: with the terms, which the CR document's lock reads under the lock too.
    expect(db.customer.findUnique).toHaveBeenCalledWith({
      where: { id: CUST },
      select: { ...customerSelect, paymentTerms: true },
    });
  });

  it('the CR slot: the customer row is gone altogether — refused', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR' }));
    db.customer.findUnique.mockResolvedValue(null);
    refusedBeforeTheClaim(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' }));
  });

  const BRANCH_TARGETS = [
    ['the shop slot', () => photo(), { branchId: B1, slot: 'SHOP' }],
    ['the signboard slot', () => photo({ kind: 'SIGNBOARD' }), { branchId: B1, slot: 'SIGNBOARD' }],
    ['the extra photos', () => photo(), { branchId: B1, slot: 'FREE' }],
  ] as const;

  describe.each([
    ['its branch moved to another customer (a merge)', () => db.branch.findUnique.mockResolvedValue(branch({ customerId: WINNER }))],
    ['its branch was soft-deleted', () => db.branch.findUnique.mockResolvedValue(branch({ deletedAt: new Date() }))],
    ['its branch row is gone altogether', () => db.branch.findUnique.mockResolvedValue(null)],
    ["the branch's customer was tombstoned", () => db.customer.findUnique.mockResolvedValue(customer({ deletedAt: new Date() }))],
  ])('%s between the read and the lock', (_label, changed) => {
    it.each(BRANCH_TARGETS)('%s: refused, nothing written', async (_n, att, target) => {
      db.attachment.findUnique.mockResolvedValue(att());
      changed();
      refusedBeforeTheClaim(await attach({ attachmentId: ATT, ...target }));
      // Read on the transaction, as they stand now: the branch, and the customer that was locked.
      expect(db.branch.findUnique).toHaveBeenCalledWith({ where: { id: B1 }, select: { customerId: true, deletedAt: true, routeId: true } });
      expect(db.customer.findUnique).toHaveBeenCalledWith({ where: { id: CUST }, select: customerSelect });
    });
  });

  it.each([
    ['the CR slot', () => photo({ kind: 'CR' }), { customerId: CUST, slot: 'CR' }, [db.customer.findUnique]],
    ['a branch slot', () => photo(), { branchId: B1, slot: 'SHOP' }, [db.branch.findUnique, db.customer.findUnique]],
  ] as const)('%s: the second read is after the lock and before the claim', async (_n, att, target, reads) => {
    db.attachment.findUnique.mockResolvedValue(att());
    expect(await attach({ attachmentId: ATT, ...target })).toEqual({ ok: true });
    const lockedAt = db.$queryRaw.mock.invocationCallOrder[0]!;
    const claimAt = db.attachment.updateMany.mock.invocationCallOrder[0]!;
    for (const read of reads) {
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.invocationCallOrder[0]).toBeGreaterThan(lockedAt);
      expect(read.mock.invocationCallOrder[0]).toBeLessThan(claimAt);
    }
  });
});

// X-PHOTO-1: the mirror of N06 on Remove. The checks, the owner and the slots to
// clear came from a read taken before any lock (and for a photo on no slot, no
// lock at all): an attach landing in the gap left its slot on the photo removed
// here. The photo is read again inside the transaction and removed only if it
// still sits where that read put it; otherwise nothing is written.
describe('X-PHOTO-1: Remove reads the photo again under the lock', () => {
  const EDIT = 'ckedit00000000000000000001';
  const WINNER = 'ckcustomer0000000000000009';
  beforeEach(() => {
    db.branch.findUnique.mockResolvedValue(branch());
    db.customer.findFirst.mockResolvedValue(customer());
    db.customer.findUnique.mockResolvedValue(customer());
  });
  const nothingWritten = () => {
    expect(db.attachment.update).not.toHaveBeenCalled();
    expect(db.branch.updateMany).not.toHaveBeenCalled();
    expect(db.customer.updateMany).not.toHaveBeenCalled();
    expect(db.branch.update).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  };

  it.each([
    ['wired to a shop slot', photo({ branchId: B1 })],
    ['wired as an extra photo', photo({ kind: 'FREE', branchId: B1, branchExtraId: B1 })],
    ['claimed by a new-customer request', photo({ editId: EDIT })],
  ])('on no slot when read, %s by the time it is removed: refused, nothing written', async (_n, now) => {
    db.attachment.findFirst.mockResolvedValueOnce(photo()).mockResolvedValueOnce(now);
    const res = await detach({ attachmentId: ATT });
    expect(res).toEqual({ ok: false, code: 'PHOTO_CHANGED', message: PHOTO_CHANGED_MESSAGE });
    expect(db.attachment.updateMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('its branch moved to another customer (a merge) in between: refused, nothing written', async () => {
    s.user = { id: 'st1', role: 'STEWARD', username: 'st1' };
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1 }));
    // Read before the lock, then under it.
    db.branch.findUnique.mockResolvedValueOnce(branch()).mockResolvedValueOnce(branch({ customerId: WINNER }));
    const res = await detach({ attachmentId: ATT });
    expect(res).toMatchObject({ ok: false, code: 'PHOTO_CHANGED' });
    expect(db.attachment.updateMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('already removed by the time it is read again: PHOTO_GONE, and nothing written', async () => {
    db.attachment.findFirst.mockResolvedValueOnce(photo({ branchId: B1 })).mockResolvedValueOnce(null);
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: false, code: 'PHOTO_GONE', message: PHOTO_GONE_MESSAGE });
    expect(db.attachment.updateMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('claimed after the read under the lock (no lock covers a photo on no slot): the guarded soft-delete misses, refused', async () => {
    db.attachment.findFirst.mockResolvedValue(photo());
    db.attachment.updateMany.mockResolvedValue({ count: 0 });
    const res = await detach({ attachmentId: ATT });
    expect(res).toMatchObject({ ok: false, code: 'PHOTO_CHANGED' });
    expect(db.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: ATT, deletedAt: null, customerId: null, branchId: null, branchExtraId: null, editId: null },
      data: { deletedAt: expect.any(Date), hash: null },
    });
    nothingWritten();
  });

  it('the second read is inside the transaction, after the lock, and before every write', async () => {
    db.attachment.findFirst.mockResolvedValue(photo({ kind: 'CR', customerId: CUST }));
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: true });
    expect(db.attachment.findFirst).toHaveBeenCalledTimes(2);
    const reread = db.attachment.findFirst.mock.invocationCallOrder[1];
    expect(reread).toBeGreaterThan(db.$queryRaw.mock.invocationCallOrder[0]);
    for (const f of [db.attachment.updateMany, db.customer.updateMany, db.customer.update, audit.writeAudit]) {
      expect(f).toHaveBeenCalled();
      for (const order of f.mock.invocationCallOrder) expect(order).toBeGreaterThan(reread);
    }
    expect(db.customer.updateMany).toHaveBeenCalledWith({ where: { id: CUST, crPhotoId: ATT }, data: { crPhotoId: null } });
  });
});

// Post-merge review (2026-09-29): the photo slot cleared on NOT_FOUND, taking it
// to mean "removed already", but the scope check answers NOT_FOUND too — a route
// reassigned or a customer archived while the form was open — and the slot then
// showed a photo removed that the server kept. Removed already is PHOTO_GONE now,
// and only for a caller who passes every check a Remove of it makes: the scope's
// NOT_FOUND still says nothing about whether the id exists.
describe('Remove of a photo removed already: PHOTO_GONE, after every check', () => {
  const gone = (over: Record<string, unknown> = {}) => photo({ branchId: B1, deletedAt: new Date(), ...over });
  beforeEach(() => {
    db.branch.findUnique.mockResolvedValue({ customerId: CUST });
    db.customer.findFirst.mockResolvedValue(customer());
  });

  it('his own photo, in scope: PHOTO_GONE — no transaction, nothing written', async () => {
    db.attachment.findFirst.mockResolvedValue(gone());
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: false, code: 'PHOTO_GONE', message: PHOTO_GONE_MESSAGE });
    expect(db.attachment.findFirst).toHaveBeenCalledTimes(1);
    expect(wrote()).toBe(0);
  });

  it('a Steward, anyone’s photo: PHOTO_GONE', async () => {
    s.user = { id: 'st1', role: 'STEWARD', username: 'st1' };
    db.attachment.findFirst.mockResolvedValue(gone({ capturedById: 'someone-else' }));
    expect((await detach({ attachmentId: ATT })).code).toBe('PHOTO_GONE');
    expect(wrote()).toBe(0);
  });

  it.each([
    [
      'its customer no longer on his route (the scope check)',
      () => db.customer.findFirst.mockResolvedValue(customer({ branches: [{ routeId: 'r9', regionId: 'g1', deletedAt: null }] })),
      { code: 'NOT_FOUND', message: 'Customer not found.' },
    ],
    ['its customer archived (the scope check)', () => db.customer.findFirst.mockResolvedValue(null), { code: 'NOT_FOUND', message: 'Attachment not found.' }],
    [
      'captured by another salesman',
      () => db.attachment.findFirst.mockResolvedValue(gone({ capturedById: 'someone-else' })),
      { code: 'FORBIDDEN', message: 'You can only remove photos you captured.' },
    ],
    [
      'a role that cannot remove photos',
      () => {
        s.user = { id: 'x1', role: 'GM', username: 'x1' };
      },
      { code: 'FORBIDDEN', message: 'Your role cannot remove photos.' },
    ],
    ['no such photo at all', () => db.attachment.findFirst.mockResolvedValue(null), { code: 'NOT_FOUND', message: 'Attachment not found.' }],
  ])('%s: that refusal, not PHOTO_GONE', async (_n, arrange, refusal) => {
    db.attachment.findFirst.mockResolvedValue(gone());
    arrange();
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: false, ...refusal });
    expect(wrote()).toBe(0);
  });

  it('a live photo whose scope check fails is NOT_FOUND, not PHOTO_GONE: the server kept it', async () => {
    db.attachment.findFirst.mockResolvedValue(photo({ branchId: B1 }));
    db.customer.findFirst.mockResolvedValue(customer({ branches: [{ routeId: 'r9', regionId: 'g1', deletedAt: null }] }));
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Customer not found.' });
    expect(wrote()).toBe(0);
  });
});

// Owner decision 2026-09-27: the roles that remove a photo are the roles that
// attach one and submit an edit. The edit form, and the Enrich button that
// leads to it, used to be open to Accountant, Finance Manager and GM, where
// nothing could be saved; the same three roles gate all of them now.
describe('who edits, attaches and removes: one set of roles', () => {
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
  const THREE = /role !== Role\.SALESMAN &&\s*session\.user\.role !== Role\.STEWARD &&\s*session\.user\.role !== Role\.MANAGER/;
  // ENH-3: attach and detach (and presign and finalize, photo-upload-roles.test.ts)
  // read one constant; the pages still spell the same three roles out.
  const GATE = /if \(!PHOTO_WRITER_ROLES\.includes\(session\.user\.role\)\) \{\s*throw new ForbiddenError\(/;
  it('the one constant is those three roles', () => {
    expect([...PHOTO_WRITER_ROLES].sort()).toEqual(['MANAGER', 'SALESMAN', 'STEWARD']);
  });
  it('the attach and detach refusals, the edit page redirect and the Enrich button agree', () => {
    const photos = src('services/photos.ts');
    const detachAt = photos.indexOf('async function detachPhotoCore');
    const attachCore = photos.slice(photos.indexOf('async function attachPhotoCore'), detachAt);
    const detach = photos.slice(detachAt);
    expect(attachCore).toMatch(GATE);
    expect(attachCore).toMatch(/Your role cannot attach photos\./);
    expect(detach).toMatch(GATE);
    expect(detach).toMatch(/Your role cannot remove photos\./);
    expect(photos).not.toMatch(/role !== Role\.(SALESMAN|STEWARD|MANAGER)/);
    expect(src('app/(app)/customers/[id]/edit/page.tsx')).toMatch(THREE);
    expect(src('app/(app)/customers/[id]/page.tsx')).toMatch(
      /const canEdit =\s*session\.user\.role === Role\.SALESMAN \|\|\s*session\.user\.role === Role\.STEWARD \|\|\s*session\.user\.role === Role\.MANAGER;/
    );
  });
});

// Pre-merge review of eb1a430: photo attach and Remove lock the customer row
// before a branch; any transaction writing a branch and then its customer must
// take that lock first too, or the two orders deadlock on the same branch.
describe('one lock order: the customer row before its branches', () => {
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
  const before = (text: string, lock: RegExp, write: RegExp) => {
    const l = text.search(lock);
    const w = text.search(write);
    expect(l).toBeGreaterThan(-1);
    expect(w).toBeGreaterThan(-1);
    expect(l).toBeLessThan(w);
  };
  it('approving an edit locks the customer before applyEditChanges writes its branches', () => {
    const edits = src('services/edits.ts');
    const approve = edits.slice(edits.indexOf('async function approveEditCore'));
    before(approve, /await lockCustomerRow\(tx, edit\.customerId!\)/, /await applyEditChanges\(tx,/);
  });
  it('approving a reactivation locks the customer before the branch write', () => {
    const r = src('services/reactivations.ts');
    before(r, /await lockCustomerRow\(tx, edit\.customerId!\)/, /await tx\.branch\.update\(\{\s*where: \{ id: edit\.branchId! \}/);
  });
  // N03: every lane of the promote now takes it, by the customer's code, before
  // it even reads the customer — so before any customer or branch write too.
  it('the import promote locks the customer before it reads it and before every write', () => {
    const i = src('services/imports.ts');
    const promote = i.slice(i.indexOf('async function promoteCustomerBatchCore'));
    const lock = /const lockedId = await lockCustomerRowByCode\(tx, custCode\);/;
    expect(promote.match(new RegExp(lock, 'g'))).toHaveLength(1);
    before(promote, lock, /const existing = lockedId\s*\?\s*await tx\.customer\.findUnique\(\{\s*where: \{ id: lockedId \}/);
    before(promote, lock, /await refreshLaneBranches\(tx,/);
    before(promote, lock, /await tx\.customer\.upsert\(/);
    before(promote, lock, /await tx\.branch\.upsert\(/);
    expect(src('lib/locks.ts')).toMatch(/WHERE "nmwcCode" = \$\{nmwcCode\} FOR UPDATE/);
  });
  it('photo attach and Remove take it first', () => {
    const photos = src('services/photos.ts');
    expect(photos.match(/await lockCustomer\(tx,/g)?.length).toBe(3);
    expect(photos).toMatch(/const lockCustomer = lockCustomerRow;/);
  });
});

describe('Remove of CREATE-draft photos preserves its existing scope and no-customer-lock behavior', () => {
  it.each([
    { role: 'SALESMAN', own: true, inScope: false, code: null },
    { role: 'MANAGER', own: true, inScope: false, code: null },
    { role: 'MANAGER', own: false, inScope: true, code: null },
    { role: 'MANAGER', own: false, inScope: false, code: 'NOT_FOUND' },
    { role: 'SALESMAN', own: false, inScope: true, code: 'FORBIDDEN' },
    { role: 'STEWARD', own: false, inScope: false, code: null },
  ])('$role own=$own inScope=$inScope', async ({ role, own, inScope, code }) => {
    s.user = { id: 'u1', username: 'synthetic', role };
    s.scope = { ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: ['g1'] };
    db.attachment.findFirst.mockResolvedValue(photo({ editId: 'ckedit00000000000000000001', capturedById: own ? 'u1' : 'someone-else' }));
    db.customerEdit.findUnique.mockResolvedValue({ customerId: null, branchDrafts: [
      { routeId: inScope ? 'r1' : 'r9', route: { regionId: inScope ? 'g1' : 'g9' } },
    ] });
    const result = await detach({ attachmentId: ATT });
    if (code) {
      expect(result).toMatchObject({ ok: false, code });
      expect(db.attachment.updateMany).not.toHaveBeenCalled();
      expect(audit.writeAudit).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ ok: true });
      expect(db.attachment.updateMany).toHaveBeenCalledOnce();
      expect(audit.writeAudit).toHaveBeenCalledOnce();
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });
});

// Owner decision 2 (2026-10-07): the CR document of a CREDIT customer follows
// its finance-locked CR number. An attach goes live at once and an update
// request cannot carry a photo for approval, so a salesman can neither put one
// in that slot nor remove the one there; a Manager or the Steward can. A CASH
// customer's is unchanged.
describe('owner decision 2: the CR document of a credit customer', () => {
  const refused = (res: Awaited<ReturnType<typeof attach>>) => {
    expect(res).toEqual({ ok: false, code: 'FORBIDDEN', message: CR_DOCUMENT_LOCKED_MESSAGE });
    expect(db.attachment.updateMany).not.toHaveBeenCalled();
    expect(db.attachment.update).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.customer.updateMany).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  };

  it('a salesman cannot attach it — refused before the transaction', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR' }));
    db.customer.findFirst.mockResolvedValue(customer({ paymentTerms: 'CREDIT', crPhotoId: 'ckprevious0000000000000001' }));
    refused(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' }));
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('…nor when the customer turned CREDIT while the attach waited for the lock', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR' }));
    db.customer.findFirst.mockResolvedValue(customer({ paymentTerms: 'CASH' }));
    db.customer.findUnique.mockResolvedValue(customer({ paymentTerms: 'CREDIT' }));
    refused(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' }));
  });

  it('a CASH customer’s, as before', async () => {
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR' }));
    db.customer.findFirst.mockResolvedValue(customer({ paymentTerms: 'CASH' }));
    db.customer.findUnique.mockResolvedValue(customer({ paymentTerms: 'CASH' }));
    expect(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' })).toEqual({ ok: true });
  });

  it.each(['MANAGER', 'STEWARD'])('a %s replaces it', async (role) => {
    s.user = { id: 'x2', role, username: 'x2' };
    s.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] };
    db.attachment.findUnique.mockResolvedValue(photo({ kind: 'CR', capturedById: 'x2' }));
    db.customer.findFirst.mockResolvedValue(customer({ paymentTerms: 'CREDIT' }));
    db.customer.findUnique.mockResolvedValue(customer({ paymentTerms: 'CREDIT' }));
    expect(await attach({ attachmentId: ATT, customerId: CUST, slot: 'CR' })).toEqual({ ok: true });
    expect(db.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ crPhotoId: ATT }) })
    );
  });

  it('his shop photo of the same credit customer still goes in', async () => {
    db.attachment.findUnique.mockResolvedValue(photo());
    db.customer.findFirst.mockResolvedValue(customer({ paymentTerms: 'CREDIT' }));
    expect(await attach({ attachmentId: ATT, branchId: B1, slot: 'SHOP' })).toEqual({ ok: true });
  });

  it('a salesman cannot remove it, even one he took — before and under the lock', async () => {
    db.attachment.findFirst.mockResolvedValue(photo({ kind: 'CR', customerId: CUST }));
    db.customer.findFirst.mockResolvedValue(customer());
    db.customer.findUnique.mockResolvedValue(customer({ paymentTerms: 'CREDIT' }));
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: false, code: 'FORBIDDEN', message: CR_DOCUMENT_LOCKED_MESSAGE });
    expect(db.$transaction).not.toHaveBeenCalled();
    // CASH when read first, CREDIT under the lock: refused there, nothing removed.
    db.customer.findUnique.mockResolvedValueOnce(customer({ paymentTerms: 'CASH' }));
    expect((await detach({ attachmentId: ATT })).message).toBe(CR_DOCUMENT_LOCKED_MESSAGE);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.attachment.updateMany).not.toHaveBeenCalled();
    expect(db.customer.updateMany).not.toHaveBeenCalled();
  });

  it('a Manager can remove it; a salesman his CASH customer’s', async () => {
    db.attachment.findFirst.mockResolvedValue(photo({ kind: 'CR', customerId: CUST }));
    db.customer.findFirst.mockResolvedValue(customer());
    db.customer.findUnique.mockResolvedValue(customer({ paymentTerms: 'CASH' }));
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: true });
    s.user = { id: 'x2', role: 'MANAGER', username: 'x2' };
    s.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] };
    db.customer.findUnique.mockResolvedValue(customer({ paymentTerms: 'CREDIT' }));
    expect(await detach({ attachmentId: ATT })).toEqual({ ok: true });
  });
});
