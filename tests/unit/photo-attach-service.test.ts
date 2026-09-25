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

const s = vi.hoisted(() => ({
  user: { id: 'u1', role: 'SALESMAN', username: 'c4' } as { id: string; role: string; username: string },
  scope: {
    ownedRouteId: 'r1' as string | null,
    teamRouteIds: [] as string[],
    managedRegionIds: [] as string[],
  },
}));
const db = vi.hoisted(() => ({
  attachment: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
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
  $transaction: vi.fn(),
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
import { ALREADY_ATTACHED_MESSAGE } from '@/lib/photo-attach';

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
  db.branch.update.mock.calls.length +
  db.customer.update.mock.calls.length +
  audit.writeAudit.mock.calls.length;

beforeEach(() => {
  s.user = { id: 'u1', role: 'SALESMAN', username: 'c4' };
  s.scope = { ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: [] };
  for (const group of [db.attachment, db.customer, db.branch, db.user]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  db.$transaction.mockReset().mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  audit.writeAudit.mockReset();
  audit.getAuditEnvelope.mockReset().mockResolvedValue({});
  db.user.findUniqueOrThrow.mockResolvedValue({ ownedRouteId: 'r1' });
  db.branch.findFirst.mockResolvedValue(branch());
  db.branch.findUniqueOrThrow.mockResolvedValue(branch());
  db.customer.findFirst.mockResolvedValue(customer());
  db.customer.findUniqueOrThrow.mockResolvedValue(customer());
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
    expect(db.attachment.update).toHaveBeenCalledWith({
      where: { id: ATT },
      data: { branchId: B1, kind: 'SHOP' },
    });
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
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
    expect(db.attachment.findFirst).toHaveBeenCalledWith({ where: { id: ATT, deletedAt: null } });
    expect(db.attachment.update).toHaveBeenCalledWith({
      where: { id: ATT },
      data: { deletedAt: expect.any(Date), hash: null },
    });
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
  });
});
