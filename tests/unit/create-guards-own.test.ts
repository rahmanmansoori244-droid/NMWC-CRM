// @vitest-environment node
/**
 * lib/create-guards.ts, item 22: when the open new-customer request in the way
 * is the caller's OWN — a send whose reply was lost, then a reload and a
 * rebuild — the refusal says so, and when it was sent, instead of "another
 * request", which reads as someone else's (post-merge review of b7d9041).
 */
import { describe, it, expect, vi } from 'vitest';
import { assertNoExactCreateDuplicate } from '@/lib/create-guards';
import { omanWhen } from '@/lib/submission';

const sentAt = new Date('2026-09-25T06:42:00.000Z');
const tx = (openEdit: Record<string, unknown> | null, which: 'cr' | 'triple') =>
  ({
    customer: { findFirst: vi.fn(async () => null) },
    editCustomerDraft: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
        openEdit && ((which === 'cr') === 'crNumberNorm' in args.where) ? { edit: openEdit } : null
      ),
    },
  }) as never;
const args = {
  crNumberNorm: '1234567',
  legalName: 'Al Noor',
  primaryPhoneNorm: '+96891234567',
  regionIds: ['r1'],
  includeOpenRequests: true,
};
const own = { submittedById: 'me', state: 'SUBMITTED', submittedAt: sentAt, updatedAt: sentAt };

describe('assertNoExactCreateDuplicate — whose request is in the way', () => {
  it("the caller's own request with this CR: says it is his, and when it was sent", async () => {
    await expect(assertNoExactCreateDuplicate(tx(own, 'cr'), { ...args, callerId: 'me' })).rejects.toMatchObject({
      code: 'DUPLICATE_CR',
      message: `Your own new-customer request with this CR number, sent at ${omanWhen(sentAt)}, is already in progress — see Work.`,
    });
  });

  it('his own saved draft says "saved as a draft"', async () => {
    const draft = { ...own, state: 'DRAFT', submittedAt: null };
    await expect(assertNoExactCreateDuplicate(tx(draft, 'cr'), { ...args, callerId: 'me' })).rejects.toMatchObject({
      message: expect.stringMatching(/^Your own new-customer request with this CR number, saved as a draft at /),
    });
  });

  it('the same shop by name, phone and region: also his own', async () => {
    await expect(
      assertNoExactCreateDuplicate(tx(own, 'triple'), { ...args, crNumberNorm: null, callerId: 'me' })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_CUSTOMER',
      message: expect.stringMatching(/^Your own new-customer request for this shop \(same name, phone and region\), sent at /),
    });
  });

  it("someone else's request, or no caller given: the message names nobody, as before", async () => {
    for (const callerId of ['someone-else', undefined]) {
      await expect(assertNoExactCreateDuplicate(tx(own, 'cr'), { ...args, callerId })).rejects.toMatchObject({
        message: 'Another new-customer request with this CR number is already in progress.',
      });
    }
  });
});
