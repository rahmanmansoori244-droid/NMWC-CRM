// @vitest-environment node
/**
 * Launch fix (lib/create-finalize.ts): what the approver at the last step of a
 * new-customer request reads when a photo or the guarantee was removed after it
 * was sent. It said "Reject it: it goes back down the chain to the salesman",
 * but a reject steps back one approver (lib/approval-chains.ts
 * resolveRejectTarget), so the Accountant's reject lands with the step before
 * him, not with the salesman.
 *
 * Owner decisions 2026-10-11: which documents a CREDIT request must still have
 * is read from the chain frozen on it. A request frozen with the 4-step chain
 * needs its guarantee, in the words it always had; one frozen with the new chain
 * needs the four credit documents and the signed credit application, each named
 * when it is missing, and never a guarantee.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EditBranchDraft, EditCustomerDraft } from '@prisma/client';

vi.mock('@/lib/create-guards', () => ({
  lockCreateIdentity: vi.fn(async () => {}),
  assertNoExactCreateDuplicate: vi.fn(async () => {}),
}));

import { documentRemovedMessage, finalizeCreateInTx, type FinalizableEdit } from '@/lib/create-finalize';
import { resolveChain } from '@/lib/approval-chains';
import { CREDIT_DOCUMENT_KINDS, DECISION_BOUND_KINDS, type DecisionBoundKind } from '@/lib/credit-documents';
import { LEGACY_CREDIT_CHAIN } from '../support/legacy-chain';

const env = { actorId: 'u-acc', ip: null, userAgent: null } as never;

function edit(paymentTerms: 'CASH' | 'CREDIT', chain: unknown = resolveChain('CREATE', paymentTerms)): FinalizableEdit {
  return {
    id: 'e1',
    submittedById: 'u-sales',
    cycle: 1,
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    approvalChain: chain as never,
    customerDraft: {
      legalName: 'Al Noor Trading',
      paymentTerms,
      crNumberNorm: '1234567',
      primaryPhoneNorm: null,
      crPhotoAttachmentId: 'p-cr',
    } as unknown as EditCustomerDraft,
    branchDrafts: [
      {
        routeId: 'r1',
        shopPhotoAttachmentId: 'p-shop',
        signboardPhotoAttachmentId: null,
        extraPhotoAttachmentIds: [],
      } as unknown as EditBranchDraft,
    ],
  };
}

type Doc = { id: string; kind: DecisionBoundKind };
let docsQuery: unknown = null;
/**
 * A transaction in which the route stands, the given photos are still on file,
 * and the request's live decision-bound documents are `docs`. Anything past the
 * document checks (the Temix lock) is not here: a request that passes them
 * fails on it, which the tests below tell apart from a refusal.
 */
function tx(live: string[], docs: Doc[] = []) {
  return {
    route: { findMany: async () => [{ id: 'r1', regionId: 'g1' }] },
    attachment: {
      findMany: async (a: { where: { kind?: unknown } }) => {
        if (a.where.kind) {
          docsQuery = a;
          return docs;
        }
        return live.map((id) => ({ id }));
      },
    },
  } as never;
}
const allNewChainDocs = (): Doc[] => [
  ...CREDIT_DOCUMENT_KINDS.map((kind, i) => ({ id: `doc-${i}`, kind })),
  { id: 'form-1', kind: 'CREDIT_FORM' },
];
const finalize = (t: never, e: FinalizableEdit) => finalizeCreateInTx(t, e, env, new Date(), 'CAA0367').catch((err) => err);

describe('a removed photo or guarantee at the last step', () => {
  it('a photo: cannot be approved, and a reject steps back one approver at a time', async () => {
    const err = await finalize(tx(['p-cr']), edit('CASH'));
    expect(err).toMatchObject({ code: 'NEEDS_REUPLOAD' });
    expect(err.message).toBe(
      'A required photo on this request was removed after it was sent, so it cannot be approved. Reject it and say which photo is missing. It goes back one approver at a time; once it reaches the salesman, he can take the photo again.'
    );
    expect(err.message).not.toMatch(/down the chain/);
  });

  it('the guarantee of a request frozen with the 4-step chain: the same, for the document', async () => {
    const err = await finalize(tx(['p-cr', 'p-shop'], []), edit('CREDIT', LEGACY_CREDIT_CHAIN));
    expect(err).toMatchObject({ code: 'NEEDS_REUPLOAD' });
    expect(err.message).toBe(
      'The guarantee document was removed after it was sent, so it cannot be approved. Reject it and say the guarantee is missing. It goes back one approver at a time; once it reaches the salesman, he can attach it again.'
    );
    expect(err.message).toBe(documentRemovedMessage('GUARANTEE'));
  });

  it('the documents are read by every decision-bound kind, live, of this request', async () => {
    await finalize(tx(['p-cr', 'p-shop'], []), edit('CREDIT', LEGACY_CREDIT_CHAIN));
    expect(docsQuery).toMatchObject({
      where: { editId: 'e1', kind: { in: [...DECISION_BOUND_KINDS] }, deletedAt: null },
    });
  });
});

describe('owner decisions 2026-10-11: a request frozen with the new credit chain', () => {
  it.each([
    [
      'ID_CARD',
      "The owner's ID card was removed after it was sent, so it cannot be approved. Reject it and say the owner's ID card is missing. It goes back one approver at a time; once it is returned to the salesman for correction, he can attach it again.",
    ],
    [
      'MEMBERSHIP_CERT',
      'The membership certificate was removed after it was sent, so it cannot be approved. Reject it and say the membership certificate is missing. It goes back one approver at a time; once it is returned to the salesman for correction, he can attach it again.',
    ],
    [
      'VAT_CERT',
      'The VAT registration certificate was removed after it was sent, so it cannot be approved. Reject it and say the VAT registration certificate is missing. It goes back one approver at a time; once it is returned to the salesman for correction, he can attach it again.',
    ],
    [
      'TAX_CARD',
      'The tax card was removed after it was sent, so it cannot be approved. Reject it and say the tax card is missing. It goes back one approver at a time; once it is returned to the salesman for correction, he can attach it again.',
    ],
    [
      'CREDIT_FORM',
      "The signed credit application was removed after it was sent, so it cannot be approved. Reject it and say the signed credit application is missing. It goes back one approver at a time; once it reaches the salesman's signed-application step, he uploads it again.",
    ],
  ] as const)('without its %s it cannot be approved, and the document is named', async (kind, message) => {
    const docs = allNewChainDocs().filter((d) => d.kind !== kind);
    const err = await finalize(tx(['p-cr', 'p-shop'], docs), edit('CREDIT'));
    expect(err).toMatchObject({ code: 'NEEDS_REUPLOAD', message });
    expect(documentRemovedMessage(kind)).toBe(message);
  });

  it('a guarantee is never required: with the five documents and none, it passes the document checks', async () => {
    const err = await finalize(tx(['p-cr', 'p-shop'], allNewChainDocs()), edit('CREDIT'));
    // It got as far as the Temix code's lock, which this transaction does not have.
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toMatchObject({ code: 'NEEDS_REUPLOAD' });
  });

  it('a request frozen with the 4-step chain is not asked for the new documents', async () => {
    const err = await finalize(tx(['p-cr', 'p-shop'], [{ id: 'g1', kind: 'GUARANTEE' }]), edit('CREDIT', LEGACY_CREDIT_CHAIN));
    expect(err).toBeInstanceOf(TypeError);
  });

  it('a cash request is asked for none of them', async () => {
    const err = await finalize(tx(['p-cr', 'p-shop'], []), edit('CASH'));
    expect(err).toBeInstanceOf(TypeError);
  });
});
