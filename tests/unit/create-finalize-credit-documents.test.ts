// @vitest-environment node
/**
 * Owner decisions 2026-10-11 (lib/create-finalize.ts): when the Accountant
 * creates a CREDIT customer,
 *   - every live decision-bound document of the request is bound to the customer
 *     (Attachment.customerId), as the guarantees always were: the four credit
 *     documents, the signed credit application, and a guarantee when the request
 *     has one;
 *   - the customer's e-mail is copied for CREDIT, and never for CASH;
 *   - the documents it must still have are read from the chain frozen on the
 *     request, not from today's switches: switching the guarantee back on
 *     (GUARANTEE_REQUIRED_FOR_CREDIT) never refuses a request already in flight
 *     on the new chain, and a request on the 4-step chain still needs its
 *     guarantee and nothing else;
 *   - a missing document refuses it before the Temix code is locked or a
 *     customer code is spent.
 * The wording of each refusal: create-finalize-wording.test.ts. Against
 * Postgres: tests/integration/credit-chain-e2e.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EditBranchDraft, EditCustomerDraft } from '@prisma/client';

const h = vi.hoisted(() => ({ writeAudit: vi.fn(), guaranteeOn: false }));
vi.mock('@/lib/create-guards', () => ({
  lockCreateIdentity: vi.fn(async () => {}),
  assertNoExactCreateDuplicate: vi.fn(async () => {}),
}));
vi.mock('@/lib/audit', () => ({ writeAudit: h.writeAudit }));
// The switch, as the owner may turn it back on: read where it is used.
vi.mock('@/lib/credit-documents', async (orig) => {
  const real = await orig<typeof import('@/lib/credit-documents')>();
  return {
    ...real,
    get GUARANTEE_REQUIRED_FOR_CREDIT() {
      return h.guaranteeOn;
    },
  };
});

import { finalizeCreateInTx, type FinalizableEdit } from '@/lib/create-finalize';
import { resolveChain } from '@/lib/approval-chains';
import { LEGACY_CREDIT_CHAIN } from '../support/legacy-chain';

const env = { actorId: 'u-acc', ip: null, userAgent: null } as never;
const AT = new Date('2026-10-11T06:00:00.000Z');

type Doc = { id: string; kind: string };
const NEW_CHAIN_DOCS: Doc[] = [
  { id: 'id-1', kind: 'ID_CARD' },
  { id: 'id-2', kind: 'ID_CARD' },
  { id: 'mem-1', kind: 'MEMBERSHIP_CERT' },
  { id: 'vat-1', kind: 'VAT_CERT' },
  { id: 'tax-1', kind: 'TAX_CARD' },
  { id: 'form-1', kind: 'CREDIT_FORM' },
  { id: 'form-2', kind: 'CREDIT_FORM' },
];

function edit(o: { terms: 'CASH' | 'CREDIT'; chain?: unknown; email?: string | null }): FinalizableEdit {
  return {
    id: 'e1',
    submittedById: 'u-sales',
    cycle: 1,
    requestedCreditLimit: null,
    requestedPaymentTermDays: o.terms === 'CREDIT' ? 30 : null,
    approvalChain: (o.chain ?? resolveChain('CREATE', o.terms)) as never,
    customerDraft: {
      legalName: 'Al Noor Trading',
      paymentTerms: o.terms,
      crNumberNorm: '1234567',
      primaryPhoneNorm: null,
      crPhotoAttachmentId: 'p-cr',
      email: o.email === undefined ? 'accounts@alnoor.om' : o.email,
    } as unknown as EditCustomerDraft,
    branchDrafts: [
      {
        routeId: 'r1',
        branchName: 'Main',
        shopPhotoAttachmentId: 'p-shop',
        signboardPhotoAttachmentId: null,
        extraPhotoAttachmentIds: [],
      } as unknown as EditBranchDraft,
    ],
  };
}

let docs: Doc[];
let calls: string[];
let binds: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
let created: Record<string, unknown> | null;
let tx: Record<string, unknown>;

beforeEach(() => {
  h.guaranteeOn = false;
  h.writeAudit.mockReset().mockResolvedValue(undefined);
  docs = [];
  calls = [];
  binds = [];
  created = null;
  tx = {
    route: { findMany: async () => [{ id: 'r1', regionId: 'g1' }] },
    attachment: {
      findMany: async (a: { where: { kind?: unknown } }) => {
        calls.push(a.where.kind ? 'docs.read' : 'photos.read');
        return a.where.kind ? docs : [{ id: 'p-cr' }, { id: 'p-shop' }];
      },
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        binds.push(a);
        return { count: 1 };
      },
    },
    $executeRaw: async () => {
      calls.push('temix.lock');
      return 1;
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (/UPPER\(c\."temixCode"\)/.test(q)) return [];
      if (/INSERT INTO "CodeSequence"/.test(q)) {
        calls.push('code.allocate');
        return [{ next: 124 }];
      }
      throw new Error(`unexpected query: ${q}`);
    },
    customer: {
      findUnique: async () => null,
      create: async (a: { data: Record<string, unknown> }) => {
        created = a.data;
        return { id: 'c-new' };
      },
      update: async () => ({}),
    },
    branch: { create: async () => ({ id: 'b-new' }), update: async () => ({}) },
    customerEdit: { update: async () => ({}) },
  };
});

const finalize = (e: FinalizableEdit) => finalizeCreateInTx(tx as never, e, env, AT, 'CAA0367');
/** The documents bound to the new customer (not the CR, which also takes customerId). */
const boundDocs = () =>
  binds.filter((b) => b.data.customerId === 'c-new' && b.where.id !== 'p-cr').map((b) => b.where.id);

describe('a credit request on the new chain', () => {
  it('binds the four credit documents and the signed application to the customer, every page, guarded like every bind', async () => {
    docs = NEW_CHAIN_DOCS;
    await finalize(edit({ terms: 'CREDIT' }));
    expect(boundDocs()).toEqual(NEW_CHAIN_DOCS.map((d) => d.id));
    for (const b of binds.filter((x) => x.data.customerId === 'c-new')) {
      // Live, on no slot, claimed by this request: a page removed in between fails the approval.
      expect(b.where).toMatchObject({ editId: 'e1', deletedAt: null, customerId: null, branchId: null });
    }
  });

  it('binds a guarantee it carries too, without needing one', async () => {
    docs = [...NEW_CHAIN_DOCS, { id: 'g-1', kind: 'GUARANTEE' }];
    await finalize(edit({ terms: 'CREDIT' }));
    expect(boundDocs()).toContain('g-1');
  });

  it("copies the customer's e-mail", async () => {
    docs = NEW_CHAIN_DOCS;
    await finalize(edit({ terms: 'CREDIT' }));
    expect(created).toMatchObject({ email: 'accounts@alnoor.om', paymentTerms: 'CREDIT' });
  });

  it('the guarantee switched back on does not refuse it: the frozen chain decides', async () => {
    h.guaranteeOn = true;
    docs = NEW_CHAIN_DOCS;
    await expect(finalize(edit({ terms: 'CREDIT' }))).resolves.toMatchObject({ customerId: 'c-new' });
  });

  it('a missing document refuses it before the Temix code is locked or a customer code is spent; nothing is bound', async () => {
    docs = NEW_CHAIN_DOCS.filter((d) => d.kind !== 'TAX_CARD');
    await expect(finalize(edit({ terms: 'CREDIT' }))).rejects.toMatchObject({ code: 'NEEDS_REUPLOAD' });
    expect(calls).not.toContain('temix.lock');
    expect(calls).not.toContain('code.allocate');
    expect(created).toBeNull();
    expect(binds).toEqual([]);
  });
});

describe('a credit request frozen with the 4-step chain', () => {
  it('needs its guarantee only, and binds it', async () => {
    docs = [{ id: 'g-1', kind: 'GUARANTEE' }];
    await finalize(edit({ terms: 'CREDIT', chain: LEGACY_CREDIT_CHAIN }));
    expect(boundDocs()).toEqual(['g-1']);
  });

  it('without it, it cannot be approved', async () => {
    docs = [];
    await expect(finalize(edit({ terms: 'CREDIT', chain: LEGACY_CREDIT_CHAIN }))).rejects.toMatchObject({
      code: 'NEEDS_REUPLOAD',
      message: expect.stringMatching(/^The guarantee document was removed/),
    });
  });
});

describe('a cash request', () => {
  it('stores no e-mail, whatever its draft holds, and needs no document', async () => {
    docs = [];
    await finalize(edit({ terms: 'CASH', email: 'typed.before@switching.om' }));
    expect(created).toMatchObject({ email: null, paymentTerms: 'CASH' });
    expect(boundDocs()).toEqual([]);
  });
});
