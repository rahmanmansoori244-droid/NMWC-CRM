// @vitest-environment node
/**
 * Owner decisions 2026-10-11 — the new-customer submit (services/creates.ts)
 * for the credit flow:
 *   - a CREDIT request carries the customer's e-mail (trimmed, lower-cased) and
 *     the four credit documents; it is held without them, beside each one, and
 *     no longer for a guarantee;
 *   - a CASH request stores no e-mail, even one sent;
 *   - the documents' pages are claimed with the other photos, and a refused page
 *     is said beside its document;
 *   - the claim-and-release is unchanged: anything the request held that this
 *     payload does not name is released — the credit documents of a request
 *     switched to cash, and the pages of a signed credit application on a
 *     request sent back for correction (the new round uploads it afresh).
 *
 * Prisma is mocked (the transaction runs its callback on a recording client);
 * the service, its schema and runAction are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ME = 'u-sales';
const EDIT = 'ckeditedit0000editediteditt';
const id = (tag: string) => `ck${tag.padEnd(8, 'x')}0000${'y'.repeat(14)}`;
const P = {
  cr: id('cr'),
  shop: id('shop'),
  sign: id('sign'),
  idCard: id('idcard'),
  idBack: id('idback'),
  mem: id('mem'),
  vat: id('vat'),
  tax: id('tax'),
  guarantee: id('guar'),
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
  existing: null as unknown,
  writes: [] as Array<{ op: string; args: Record<string, unknown> }>,
  txCalls: 0,
}));

function recordingTx() {
  const rec =
    (op: string, value: unknown = {}) =>
    async (args: Record<string, unknown>) => {
      h.writes.push({ op, args });
      return typeof value === 'function' ? (value as (a: unknown) => unknown)(args) : value;
    };
  return {
    // Gap 24: the change context each transaction sets first (lib/change-context.ts).
    $executeRaw: async () => 1,
    customerEdit: {
      create: rec('customerEdit.create', { id: EDIT, cycle: 1, submittedAt: new Date() }),
      updateMany: rec('customerEdit.updateMany', { count: 1 }),
      findUniqueOrThrow: rec('customerEdit.findUniqueOrThrow', { id: EDIT, cycle: 2, submittedAt: new Date() }),
    },
    editCustomerDraft: { create: rec('editCustomerDraft.create'), upsert: rec('editCustomerDraft.upsert') },
    editBranchDraft: { createMany: rec('editBranchDraft.createMany'), deleteMany: rec('editBranchDraft.deleteMany') },
    attachment: {
      updateMany: rec('attachment.updateMany', (a: { where: { id?: { in?: string[] } } }) => ({
        count: a.where.id?.in?.length ?? 0,
      })),
    },
  };
}

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
    customer: { findFirst: async () => null },
    subChannel: { findUnique: async () => ({ channelId: 'ckchannel00000000000000001', isActive: true }) },
    customerEdit: { findUnique: async () => h.existing },
    $transaction: async (fn: (tx: unknown) => unknown) => {
      h.txCalls += 1;
      return fn(recordingTx());
    },
  },
}));
vi.mock('@/lib/session', () => ({
  requireActor: async () => ({ id: ME, role: 'SALESMAN', username: 'mct01' }),
}));
vi.mock('@/lib/submission-replay', () => ({
  findReceipt: async () => null,
  answerIfLanded: (fn: () => unknown) => fn(),
  shownTime: () => new Date('2026-10-11T06:00:00Z'),
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }), FORM_LIMIT: {} }));
vi.mock('@/lib/audit', () => ({ getAuditEnvelope: async () => ({}), writeAudit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/create-guards', () => ({
  lockCreateIdentity: vi.fn(async () => {}),
  assertNoExactCreateDuplicate: vi.fn(async () => {}),
}));
vi.mock('@/lib/notifications', () => ({
  resolveStepAudience: vi.fn(async () => ['u-mgr']),
  notifyUsers: vi.fn(async () => {}),
  settleRequestAlerts: vi.fn(async () => {}),
}));
vi.mock('@/lib/notify-hierarchy', () => ({ notifySalesmanRequest: vi.fn(async () => ({ mustAct: [], fyi: [] })) }));

import { submitCreateAction } from '@/services/creates';
import { creditDocumentMissingMessage, INVALID_CUSTOMER_EMAIL_MESSAGE } from '@/lib/validation/create';

const att = (attId: string, kind: string, o: Partial<Att> = {}): Att => ({
  id: attId,
  kind,
  deletedAt: null,
  capturedById: ME,
  customerId: null,
  branchId: null,
  branchExtraId: null,
  editId: null,
  ...o,
});
const fresh = () => [
  att(P.cr, 'CR'),
  att(P.shop, 'SHOP'),
  att(P.sign, 'SIGNBOARD'),
  att(P.idCard, 'ID_CARD'),
  att(P.idBack, 'ID_CARD'),
  att(P.mem, 'MEMBERSHIP_CERT'),
  att(P.vat, 'VAT_CERT'),
  att(P.tax, 'TAX_CARD'),
  att(P.guarantee, 'GUARANTEE'),
];
const DOCS = { ID_CARD: [P.idCard, P.idBack], MEMBERSHIP_CERT: [P.mem], VAT_CERT: [P.vat], TAX_CARD: [P.tax] };

function body(o: { terms?: 'CASH' | 'CREDIT'; email?: unknown; docs?: Record<string, string[]>; editId?: string; guarantees?: string[] } = {}) {
  const terms = o.terms ?? 'CREDIT';
  return {
    ...(o.editId ? { editId: o.editId } : {}),
    isDraft: false,
    customer: {
      legalName: 'Al Noor Trading',
      paymentTerms: terms,
      crNumber: '1234567',
      channelId: 'ckchannel00000000000000001',
      subChannelId: 'cksubchan00000000000000001',
      primaryPhone: '+968 9123 4567',
      contactPerson: 'Said',
      crPhotoAttachmentId: P.cr,
      ...('email' in o ? { email: o.email } : { email: '  Accounts@AlNoor.OM ' }),
    },
    ...(terms === 'CREDIT' ? { credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 } } : {}),
    guaranteeAttachmentIds: o.guarantees ?? [],
    creditDocuments: o.docs ?? (terms === 'CREDIT' ? DOCS : {}),
    branches: [
      {
        branchName: 'Main',
        address: 'Way 123, Al Khuwair',
        gpsLat: 23.6,
        gpsLng: 58.5,
        dayOfVisit: 'MON',
        shopPhotoAttachmentId: P.shop,
        signboardPhotoAttachmentId: P.sign,
      },
    ],
  } as unknown as Parameters<typeof submitCreateAction>[0];
}

const written = (op: string) => h.writes.filter((w) => w.op === op).map((w) => w.args);
type Fail = { ok: false; code: string; message: string; fields?: Record<string, string> };

beforeEach(() => {
  h.atts = fresh();
  h.existing = null;
  h.writes = [];
  h.txCalls = 0;
});

describe('a CREDIT request', () => {
  it("is sent with the customer's e-mail, trimmed and lower-cased, and no guarantee", async () => {
    const res = await submitCreateAction(body());
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { state: 'SUBMITTED' } });
    expect(written('editCustomerDraft.create')[0]!.data).toMatchObject({ paymentTerms: 'CREDIT', email: 'accounts@alnoor.om' });
    // The six-step chain is frozen at submit.
    const chain = (written('customerEdit.create')[0]!.data as { approvalChain: Array<{ role: string }> }).approvalChain;
    expect(chain.map((s) => s.role)).toEqual(['SUPERVISOR', 'SALES_DIRECTOR', 'SALESMAN', 'FINANCE_MANAGER', 'GM', 'ACCOUNTANT']);
  });

  it('claims every page of the four documents with the other photos, his own, on no record', async () => {
    await submitCreateAction(body());
    const [claim, release] = written('attachment.updateMany') as Array<{ where: Record<string, unknown>; data: unknown }>;
    expect((claim!.where.id as { in: string[] }).in.sort()).toEqual(
      [P.cr, P.shop, P.sign, P.idCard, P.idBack, P.mem, P.vat, P.tax].sort()
    );
    expect(claim!.where).toMatchObject({ capturedById: ME, deletedAt: null, customerId: null, branchId: null });
    expect(claim!.data).toEqual({ editId: EDIT });
    // …and releases what the request held that this payload does not name.
    expect(release!.where).toMatchObject({ editId: EDIT, deletedAt: null });
  });

  it('is held without its e-mail or any document, each said beside it, and nothing is written', async () => {
    const res = (await submitCreateAction(body({ email: '', docs: { ...DOCS, VAT_CERT: [] } }))) as Fail;
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(res.fields).toEqual({
      'customer.email': "The customer's e-mail is required for credit.",
      'creditDoc.VAT_CERT': creditDocumentMissingMessage('VAT_CERT'),
    });
    expect(h.txCalls).toBe(0);
  });

  it('an e-mail that is not one is refused beside the field', async () => {
    const res = (await submitCreateAction(body({ email: 'accounts at alnoor' }))) as Fail;
    expect(res.fields).toEqual({ 'customer.email': INVALID_CUSTOMER_EMAIL_MESSAGE });
    expect(h.txCalls).toBe(0);
  });

  it.each([
    ['taken for another document', P.mem, { kind: 'VAT_CERT' }, "The membership certificate photo was taken for a different slot. Take it again here."],
    ['removed since', P.tax, { deletedAt: new Date() }, 'The tax card photo was removed. Take it again.'],
    ["on another customer's record", P.idBack, { customerId: 'c1' }, "This owner's ID card photo is already on another customer's record. Take it again."],
  ] as const)('a page %s is refused beside its document', async (_label, pageId, changed, message) => {
    h.atts = fresh().map((a) => (a.id === pageId ? { ...a, ...changed } : a));
    const res = (await submitCreateAction(body())) as Fail;
    const field = `creditDoc.${fresh().find((a) => a.id === pageId)!.kind}`;
    expect(res.fields).toEqual({ [field]: message });
    expect(h.txCalls).toBe(0);
  });

  it('a signed-application page is no credit document: refused as taken for a different slot', async () => {
    const page = id('formpg');
    h.atts = [...fresh(), att(page, 'CREDIT_FORM')];
    const res = (await submitCreateAction(body({ docs: { ...DOCS, TAX_CARD: [page] } }))) as Fail;
    expect(res.fields).toEqual({ 'creditDoc.TAX_CARD': 'The tax card photo was taken for a different slot. Take it again here.' });
  });

  it('the same page twice is refused, naming the document', async () => {
    const res = (await submitCreateAction(body({ docs: { ...DOCS, MEMBERSHIP_CERT: [P.mem, P.mem] } }))) as Fail;
    expect(res.fields).toEqual({
      _form: 'The same membership certificate photo is in two places on this form. Take a different photo for one of them.',
    });
  });

  it('a guarantee it still carries is claimed with it (a returned request keeps its evidence)', async () => {
    await submitCreateAction(body({ guarantees: [P.guarantee] }));
    const [claim] = written('attachment.updateMany') as Array<{ where: { id: { in: string[] } } }>;
    expect(claim!.where.id.in).toContain(P.guarantee);
  });
});

describe('a CASH request', () => {
  it('stores no e-mail, even one sent, and needs no document', async () => {
    const res = await submitCreateAction(body({ terms: 'CASH', email: 'typed.before@switching.om', docs: {} }));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(written('editCustomerDraft.create')[0]!.data).toMatchObject({ paymentTerms: 'CASH', email: null });
  });
});

describe('a request sent back for correction, sent again', () => {
  beforeEach(() => {
    h.existing = {
      id: EDIT,
      process: 'CREATE',
      state: 'NEEDS_CORRECTION',
      submittedById: ME,
      cycle: 1,
      submittedAt: new Date('2026-10-10T06:00:00Z'),
      branchDrafts: [{ routeId: 'r1', route: { code: 'MCT-01' } }],
    };
    // His documents are already on the request.
    h.atts = fresh().map((a) => ({ ...a, editId: EDIT }));
  });

  it('releases everything it held that this payload does not name — the old signed-application pages among them', async () => {
    const res = await submitCreateAction(body({ editId: EDIT, guarantees: [P.guarantee] }));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { state: 'SUBMITTED' } });
    const [, release] = written('attachment.updateMany') as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
    // The CREDIT_FORM pages are in no payload, so they are not in the kept list.
    expect(release!.where).toEqual({
      editId: EDIT,
      deletedAt: null,
      id: { notIn: expect.arrayContaining([P.cr, P.idCard, P.idBack, P.mem, P.vat, P.tax, P.guarantee]) },
    });
    expect(release!.data).toMatchObject({ hash: null });
    expect(written('editCustomerDraft.upsert')[0]!.update).toMatchObject({ email: 'accounts@alnoor.om' });
  });

  it('switched to cash: the credit documents are released and the e-mail is not kept', async () => {
    const res = await submitCreateAction(body({ editId: EDIT, terms: 'CASH', docs: {} }));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    const [claim, release] = written('attachment.updateMany') as Array<{ where: Record<string, unknown> }>;
    expect((claim!.where.id as { in: string[] }).in.sort()).toEqual([P.cr, P.shop, P.sign].sort());
    expect((release!.where.id as { notIn: string[] }).notIn).not.toContain(P.idCard);
    expect(written('editCustomerDraft.upsert')[0]!.update).toMatchObject({ email: null });
  });
});
