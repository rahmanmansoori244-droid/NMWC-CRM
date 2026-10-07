// @vitest-environment node
/**
 * Security review (launch candidate): a new-customer request started on one
 * route is never re-filed on another. A request in review when its salesman was
 * moved (Edit account, a role change, or an account import with change_route)
 * could be sent back to him; resaved or sent again, submitCreateOnce deleted its
 * branch drafts and rebuilt them on his NEW route, so the other region's
 * approvers decided it and finalize put the shop on the wrong route.
 *
 * Now a draft or sent-back request whose branch drafts are on another route than
 * his own is refused before anything is written; he withdraws it instead
 * (withdrawCreateAction checks no route).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const EDIT_ID = 'ckzzzzzzzz0000zzzzzzzzzzzz';

const h = vi.hoisted(() => ({
  existing: null as unknown,
  tx: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUniqueOrThrow: async () => ({
        id: 'u-sales',
        supervisorId: 'u-mgr',
        ownedRoute: { id: 'r-new', code: 'BTN-02', regionId: 'g-btn', isActive: true },
      }),
    },
    customerEdit: { findUnique: async () => h.existing },
    $transaction: h.tx,
  },
}));
vi.mock('@/lib/session', () => ({
  requireActor: async () => ({ id: 'u-sales', role: 'SALESMAN', username: 'btn02' }),
}));
vi.mock('@/lib/submission-replay', () => ({
  findReceipt: async () => null,
  answerIfLanded: (fn: () => unknown) => fn(),
  shownTime: () => new Date(),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async () => ({ ok: true }),
  FORM_LIMIT: {},
}));
vi.mock('@/lib/audit', () => ({ getAuditEnvelope: async () => ({}), writeAudit: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { submitCreateAction } from '@/services/creates';

const body = (isDraft: boolean) =>
  ({
    editId: EDIT_ID,
    isDraft,
    customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
    branches: [{ branchName: 'Main' }],
  }) as Parameters<typeof submitCreateAction>[0];

const existing = (state: 'DRAFT' | 'NEEDS_CORRECTION', routeId: string, code: string) => ({
  id: EDIT_ID,
  process: 'CREATE',
  state,
  submittedById: 'u-sales',
  cycle: 2,
  submittedAt: null,
  branchDrafts: [{ routeId, route: { code } }],
});

beforeEach(() => {
  // The transaction's work is not under test: it answers with the saved row.
  h.tx.mockReset().mockResolvedValue({ id: EDIT_ID, cycle: 2, submittedAt: null });
});

describe('a new-customer request started on another route is not re-filed on his new one', () => {
  it.each([
    ['NEEDS_CORRECTION', false],
    ['NEEDS_CORRECTION', true],
    ['DRAFT', true],
    ['DRAFT', false],
  ] as const)('%s, isDraft=%s: refused, and nothing is written', async (state, isDraft) => {
    h.existing = existing(state, 'r-old', 'MCT-01');
    const res = await submitCreateAction(body(isDraft));
    expect(res).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
    const message = res.ok ? '' : res.message;
    expect(message).toMatch(/started on route MCT-01/);
    expect(message).toMatch(/you now work route BTN-02/);
    expect(message).toMatch(/Withdraw it/);
    expect(message).toMatch(/salesman of route MCT-01 adds the shop afresh/);
    expect(h.tx).not.toHaveBeenCalled();
  });

  it('one started on his own route is saved as before', async () => {
    h.existing = existing('DRAFT', 'r-new', 'BTN-02');
    expect(await submitCreateAction(body(true))).toMatchObject({
      ok: true,
      data: { editId: EDIT_ID, state: 'DRAFT' },
    });
    expect(h.tx).toHaveBeenCalledTimes(1);
  });
});
