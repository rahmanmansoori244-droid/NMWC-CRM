// @vitest-environment node
/**
 * lib/create-guards.ts, launch fixes: who reads a duplicate refusal.
 *
 *   - At submit the salesman reads it. A live customer is named only when he can
 *     open it (a live branch on his route); trying CR numbers used to read out
 *     the code and legal name of customers on other routes, and told him to
 *     "open that customer", which he could not.
 *   - Someone else's open request is named by whose it is and where it stands
 *     ("in progress" alone left him nobody to ask); his own says he can withdraw
 *     it, unless it is in review.
 *   - At finalize (no caller) the approver at the last step reads it, and is
 *     told to reject — not to "open that customer instead".
 */
import { describe, it, expect, vi } from 'vitest';
import { assertNoExactCreateDuplicate } from '@/lib/create-guards';

type LiveRow = { nmwcCode: string; legalName: string; routeIds: string[] };
type OpenRow = { state: string; submittedById: string; fullName: string };

/**
 * A transaction stand-in that honours the guard's `select`: the matching
 * customer's branches on the asked route come back only when the guard asks.
 */
function fakeTx(live: LiveRow | null, open: OpenRow | null = null) {
  const shape = (c: LiveRow, select: Record<string, unknown>) => {
    const asked = select.branches as { where: { routeId: string } } | undefined;
    return {
      nmwcCode: c.nmwcCode,
      legalName: c.legalName,
      ...(asked ? { branches: c.routeIds.filter((r) => r === asked.where.routeId).map((id) => ({ id })) } : {}),
    };
  };
  const edit = open && {
    submittedById: open.submittedById,
    state: open.state,
    submittedAt: new Date('2026-10-01T06:00:00Z'),
    updatedAt: new Date('2026-10-01T06:00:00Z'),
    submittedBy: { fullName: open.fullName },
  };
  return {
    customer: {
      findFirst: vi.fn(async (a: { select: Record<string, unknown> }) => (live ? shape(live, a.select) : null)),
      findMany: vi.fn(async (a: { select: Record<string, unknown> }) => (live ? [shape(live, a.select)] : [])),
    },
    editCustomerDraft: {
      findFirst: vi.fn(async () => (edit ? { edit } : null)),
      findMany: vi.fn(async () => (edit ? [{ legalName: 'Al Noor Shop', edit }] : [])),
    },
  } as never;
}

const cr = { crNumberNorm: '1234567', legalName: 'Al Noor Shop', primaryPhoneNorm: null, regionIds: ['r1'] };
const triple = { crNumberNorm: null, legalName: 'Al Noor Shop', primaryPhoneNorm: '+96891234567', regionIds: ['r1'] };
const salesman = { callerId: 'me', callerRouteId: 'route-mine', includeOpenRequests: true };
const shop: LiveRow = { nmwcCode: 'NMWC-2026-000009', legalName: 'Al Noor Shop', routeIds: ['route-other'] };

describe('a live duplicate, read by the salesman at submit', () => {
  it('on another route: not named, and he is told whom to ask', async () => {
    for (const [args, code] of [
      [cr, 'DUPLICATE_CR'],
      [triple, 'DUPLICATE_CUSTOMER'],
    ] as const) {
      const err = await assertNoExactCreateDuplicate(fakeTx(shop), { ...args, ...salesman }).catch((e) => e);
      expect(err).toMatchObject({ code });
      expect(err.message).not.toContain('NMWC-2026-000009');
      expect(err.message).not.toContain('Al Noor Shop');
      expect(err.message).toMatch(/on another route, so it cannot be added again\. If .* on your route, tell your supervisor\.$/);
    }
  });

  it('on his own route: named, and he is told to open it', async () => {
    const mine = { ...shop, routeIds: ['route-other', 'route-mine'] };
    await expect(assertNoExactCreateDuplicate(fakeTx(mine), { ...cr, ...salesman })).rejects.toMatchObject({
      code: 'DUPLICATE_CR',
      message:
        'A customer with this CR number already exists: NMWC-2026-000009 — Al Noor Shop. Open it from your customers instead of creating a new one.',
    });
    await expect(assertNoExactCreateDuplicate(fakeTx(mine), { ...triple, ...salesman })).rejects.toMatchObject({
      code: 'DUPLICATE_CUSTOMER',
      message:
        'This shop already exists: NMWC-2026-000009 — Al Noor Shop (same name, phone and region). Open it from your customers instead of creating a new one.',
    });
  });
});

describe('a live duplicate at finalize: the approver is told to reject, with the customer named', () => {
  it('names it and does not tell him to open it', async () => {
    const err = await assertNoExactCreateDuplicate(fakeTx(shop), { ...cr, includeOpenRequests: false }).catch((e) => e);
    expect(err.message).toBe(
      'A customer with this CR number already exists: NMWC-2026-000009 — Al Noor Shop. It cannot be created twice: reject this request and give that as the reason.'
    );
  });
});

describe('an open request in the way', () => {
  it("someone else's: whose, and where it stands", async () => {
    const cases = [
      ['DRAFT', 'saved as a draft'],
      ['SUBMITTED', 'in review'],
      ['NEEDS_CORRECTION', 'sent back to them for correction'],
    ] as const;
    for (const [state, where] of cases) {
      const tx = fakeTx(null, { state, submittedById: 'u-huda', fullName: 'Huda Al Balushi' });
      await expect(assertNoExactCreateDuplicate(tx, { ...cr, ...salesman })).rejects.toMatchObject({
        code: 'DUPLICATE_CR',
        message: `Huda Al Balushi's new-customer request with this CR number is already in progress (${where}). Ask them, or your supervisor, before adding it again.`,
      });
    }
  });

  it('his own draft or sent-back request: he can carry on or withdraw it; one in review he cannot', async () => {
    for (const state of ['DRAFT', 'NEEDS_CORRECTION']) {
      const tx = fakeTx(null, { state, submittedById: 'me', fullName: 'Me' });
      await expect(assertNoExactCreateDuplicate(tx, { ...triple, ...salesman })).rejects.toMatchObject({
        message: expect.stringMatching(/open it from Work to carry on, or to withdraw it if it is no longer needed\.$/),
      });
    }
    const inReview = fakeTx(null, { state: 'SUBMITTED', submittedById: 'me', fullName: 'Me' });
    await expect(assertNoExactCreateDuplicate(inReview, { ...triple, ...salesman })).rejects.toMatchObject({
      message: expect.stringMatching(/is already in progress — see Work\.$/),
    });
  });
});
