// @vitest-environment node
/**
 * Production walk 2026-10-09: a salesman who picked a photo he had sent before
 * could not submit his new-customer request. Finalize handed the picture back
 * as its old row, and the submit refused it at the top of the form with
 * nothing he could do: "A referenced photo is already wired to a customer.",
 * "A referenced photo belongs to another request." (his own withdrawn one),
 * "Photo kind mismatch: expected SHOP, got SIGNBOARD.".
 *
 * Finalize no longer hands such a photo back (photo-finalize-dedupe.test.ts).
 * These checks stay as the safety net, and each refusal now says, beside the
 * photo's slot, which photo and what to do. Nothing is written on any of them.
 * The ownership check is unchanged: another uploader's photo is still refused
 * as forbidden.
 *
 * Prisma is mocked; the service, its schema and runAction are real. Drafts are
 * sent, so the mandatory-field gate stays out of the way: the photo checks run
 * on a draft save too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ME = 'u-sales';
const ids = {
  cr: 'ckcrcrcrcr0000crcrcrcrcrcr',
  shop: 'ckshopshop0000shopshopshop',
  sign: 'cksignsign0000signsignsign',
  extra: 'ckextraxtr0000extraxtraxtr',
};

type Att = {
  id: string;
  kind: string;
  deletedAt: Date | null;
  capturedById: string;
  customerId: string | null;
  branchId: string | null;
  branchExtraId: string | null;
  editId: string | null;
};

const h = vi.hoisted(() => ({
  atts: [] as Att[],
  other: null as null | { submittedById: string; state: string; submittedAt: Date | null; updatedAt: Date },
  tx: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUniqueOrThrow: async () => ({
        id: ME,
        supervisorId: 'u-mgr',
        ownedRoute: { id: 'r1', code: 'MCT-01', regionId: 'g1', isActive: true },
      }),
    },
    attachment: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => h.atts.filter((a) => where.id.in.includes(a.id)),
    },
    // Only photoClaimedConflict reads a request here (no editId is sent).
    customerEdit: { findUnique: async () => h.other },
    $transaction: h.tx,
  },
}));
vi.mock('@/lib/session', () => ({
  requireActor: async () => ({ id: ME, role: 'SALESMAN', username: 'mct01' }),
}));
vi.mock('@/lib/submission-replay', () => ({
  findReceipt: async () => null,
  answerIfLanded: (fn: () => unknown) => fn(),
  shownTime: () => new Date('2026-10-09T06:00:00Z'),
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }), FORM_LIMIT: {} }));
vi.mock('@/lib/audit', () => ({ getAuditEnvelope: async () => ({}), writeAudit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { submitCreateAction } from '@/services/creates';

/** His own live photo on no slot, of the kind its slot takes — unless said otherwise. */
const att = (id: string, kind: string, o: Partial<Att> = {}): Att => ({
  id,
  kind,
  deletedAt: null,
  capturedById: ME,
  customerId: null,
  branchId: null,
  branchExtraId: null,
  editId: null,
  ...o,
});

const fresh = () => [att(ids.cr, 'CR'), att(ids.shop, 'SHOP'), att(ids.sign, 'SIGNBOARD'), att(ids.extra, 'FREE')];

function draft(o: { extra?: string[]; branches?: Array<{ shop?: string; sign?: string }> } = {}) {
  const branches = o.branches ?? [{ shop: ids.shop, sign: ids.sign }];
  return {
    isDraft: true,
    customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH', crPhotoAttachmentId: ids.cr },
    branches: branches.map((b, i) => ({
      branchName: i === 0 ? 'Main' : `Branch ${i + 1}`,
      shopPhotoAttachmentId: b.shop,
      signboardPhotoAttachmentId: b.sign,
      extraPhotoAttachmentIds: i === 0 ? (o.extra ?? [ids.extra]) : [],
    })),
  } as Parameters<typeof submitCreateAction>[0];
}

/** Sends the draft with `id` replaced by `changed`; the refusal's fields. */
async function refusedWith(id: string, changed: Partial<Att>, body = draft()) {
  h.atts = fresh().map((a) => (a.id === id ? { ...a, ...changed } : a));
  const res = await submitCreateAction(body);
  expect(res.ok, JSON.stringify(res)).toBe(false);
  expect(h.tx, 'nothing is written').not.toHaveBeenCalled();
  return res as { ok: false; code: string; message: string; fields?: Record<string, string> };
}

beforeEach(() => {
  h.atts = fresh();
  h.other = null;
  h.tx.mockReset().mockResolvedValue({ id: 'ckeditedit0000editediteditt', cycle: 1, submittedAt: null });
});

describe("a photo already on a customer's record is refused beside its slot, with what to do", () => {
  it.each([
    ['the CR document', ids.cr, { customerId: 'c1' }, 'customer.crPhoto', 'CR document'],
    ['the shop front', ids.shop, { branchId: 'b1' }, 'branch.0.shopPhoto', 'shop front'],
    ['the signboard', ids.sign, { branchId: 'b1' }, 'branch.0.signboardPhoto', 'signboard'],
    ['an extra photo (no slot of its own on the form)', ids.extra, { branchId: 'b1', branchExtraId: 'b1' }, '_form', 'extra'],
  ] as const)('%s', async (_label, id, wired, field, label) => {
    const res = await refusedWith(id, wired);
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(res.fields).toEqual({ [field]: `This ${label} photo is already on another customer's record. Take it again.` });
  });
});

describe('a photo on another request of his is refused beside its slot, by what became of that request', () => {
  const claimed = (state: string) => {
    h.other = { submittedById: ME, state, submittedAt: new Date('2026-10-08T06:00:00Z'), updatedAt: new Date('2026-10-08T06:00:00Z') };
    return refusedWith(ids.shop, { editId: 'ckotherreq0000otherreqothe' });
  };

  it('withdrawn: it says so, and to take the photo again', async () => {
    const res = await claimed('REJECTED');
    expect(res.fields).toEqual({ 'branch.0.shopPhoto': 'This shop front photo is on a request you withdrew. Take it again.' });
  });

  it("approved: the photo is on that customer's record now", async () => {
    const res = await claimed('APPROVED');
    expect(res.fields).toEqual({ 'branch.0.shopPhoto': "This shop front photo is already on another customer's record. Take it again." });
  });

  // Item 22, unchanged: a retry whose first reply was lost finds its photos in
  // the request that landed, and is told where his work went.
  it('a draft of his: "already in your draft", as before', async () => {
    const res = await claimed('DRAFT');
    expect(res.code).toBe('REQUEST_ALREADY_SENT');
    expect(res.message).toMatch(/^These photos are already in your draft saved at /);
  });

  it('in review: "already arrived", as before', async () => {
    const res = await claimed('SUBMITTED');
    expect(res.code).toBe('REQUEST_ALREADY_SENT');
    expect(res.message).toMatch(/^This request already arrived at /);
  });

  it("another salesman's request: said beside the slot", async () => {
    h.other = { submittedById: 'u-else', state: 'SUBMITTED', submittedAt: null, updatedAt: new Date() };
    const res = await refusedWith(ids.sign, { editId: 'ckotherreq0000otherreqothe' });
    expect(res.fields).toEqual({ 'branch.0.signboardPhoto': 'This signboard photo is on another request. Take it again.' });
  });
});

describe('the other photo refusals say which photo and what to do', () => {
  it('a photo taken for another slot', async () => {
    const res = await refusedWith(ids.shop, { kind: 'SIGNBOARD' });
    expect(res.fields).toEqual({ 'branch.0.shopPhoto': 'The shop front photo was taken for a different slot. Take it again here.' });
  });

  it('a photo removed since it was taken', async () => {
    const res = await refusedWith(ids.cr, { deletedAt: new Date() });
    expect(res.fields).toEqual({ 'customer.crPhoto': 'The CR document photo was removed. Take it again.' });
  });

  it('the same picture in two slots of one kind (finalize hands both the one free photo)', async () => {
    h.atts = fresh();
    const res = await submitCreateAction(draft({ branches: [{ shop: ids.shop, sign: ids.sign }, { shop: ids.shop }] }));
    expect(res).toMatchObject({
      ok: false,
      fields: { _form: 'The same shop front photo is in two places on this form. Take a different photo for one of them.' },
    });
    expect(h.tx).not.toHaveBeenCalled();
  });

  it('the ownership check is unchanged: another uploader’s photo is forbidden', async () => {
    const res = await refusedWith(ids.shop, { capturedById: 'u-else' });
    expect(res).toMatchObject({ code: 'FORBIDDEN', message: 'You can only use photos you captured yourself.' });
  });
});

it('photos he can use are saved as before', async () => {
  const res = await submitCreateAction(draft());
  expect(res).toMatchObject({ ok: true, data: { state: 'DRAFT' } });
  expect(h.tx).toHaveBeenCalledTimes(1);
});
