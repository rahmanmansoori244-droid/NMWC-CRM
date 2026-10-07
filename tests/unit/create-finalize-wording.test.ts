// @vitest-environment node
/**
 * Launch fix (lib/create-finalize.ts): what the approver at the last step of a
 * new-customer request reads when a photo or the guarantee was removed after it
 * was sent. It said "Reject it: it goes back down the chain to the salesman",
 * but a reject steps back one approver (lib/approval-chains.ts
 * resolveRejectTarget), so the Accountant's reject lands with the step before
 * him, not with the salesman.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EditBranchDraft, EditCustomerDraft } from '@prisma/client';

vi.mock('@/lib/create-guards', () => ({
  lockCreateIdentity: vi.fn(async () => {}),
  assertNoExactCreateDuplicate: vi.fn(async () => {}),
}));

import { finalizeCreateInTx, type FinalizableEdit } from '@/lib/create-finalize';

const env = { actorId: 'u-acc', ip: null, userAgent: null } as never;

function edit(paymentTerms: 'CASH' | 'CREDIT'): FinalizableEdit {
  return {
    id: 'e1',
    submittedById: 'u-sales',
    cycle: 1,
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
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

/** A transaction in which the route stands and the given photos are still on file. */
function tx(live: string[], guarantees: string[] = []) {
  return {
    route: { findMany: async () => [{ id: 'r1', regionId: 'g1' }] },
    attachment: {
      findMany: async (a: { where: { kind?: string } }) =>
        (a.where.kind === 'GUARANTEE' ? guarantees : live).map((id) => ({ id })),
    },
  } as never;
}

describe('a removed photo or guarantee at the last step', () => {
  it('a photo: cannot be approved, and a reject steps back one approver at a time', async () => {
    const err = await finalizeCreateInTx(tx(['p-cr']), edit('CASH'), env, new Date()).catch((e) => e);
    expect(err).toMatchObject({ code: 'NEEDS_REUPLOAD' });
    expect(err.message).toBe(
      'A required photo on this request was removed after it was sent, so it cannot be approved. Reject it and say which photo is missing. It goes back one approver at a time; once it reaches the salesman, he can take the photo again.'
    );
    expect(err.message).not.toMatch(/down the chain/);
  });

  it('the guarantee: the same, for the document', async () => {
    const err = await finalizeCreateInTx(tx(['p-cr', 'p-shop'], []), edit('CREDIT'), env, new Date()).catch((e) => e);
    expect(err).toMatchObject({ code: 'NEEDS_REUPLOAD' });
    expect(err.message).toBe(
      'The guarantee document was removed after it was sent, so it cannot be approved. Reject it and say the guarantee is missing. It goes back one approver at a time; once it reaches the salesman, he can attach it again.'
    );
  });
});
