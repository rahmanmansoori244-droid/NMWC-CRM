// @vitest-environment node
/**
 * Launch fix: a new-customer "Save draft" spends its own rate-limit bucket.
 * Every save spent one of the 60 an hour that submits share (FORM_LIMIT), so a
 * salesman who saved often was told "Slow down" when he came to submit. The
 * update form's saves are proven the same way in tests/unit/edit-service.test.ts.
 *
 * The limiter answers "no" here, so nothing past it runs: the key it was asked
 * with is the whole of what is under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/session', () => ({
  requireActor: async () => ({ id: 'u-sales', role: 'SALESMAN', username: 'mct01' }),
}));
vi.mock('@/lib/submission-replay', () => ({
  findReceipt: async () => null,
  answerIfLanded: (fn: () => unknown) => fn(),
  shownTime: () => new Date(),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async (key: string) => {
    h.keys.push(key);
    return { ok: false, retryAfterSec: 9 };
  },
  FORM_LIMIT: {},
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { submitCreateAction } from '@/services/creates';

const body = (isDraft: boolean) =>
  ({
    isDraft,
    customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
    branches: [{ branchName: 'Main' }],
  }) as Parameters<typeof submitCreateAction>[0];

beforeEach(() => {
  h.keys = [];
});

describe('a new-customer draft save and a submit draw on different buckets', () => {
  it('Save draft: edit-draft:<user>; Submit: edit:<user>', async () => {
    expect(await submitCreateAction(body(true))).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(await submitCreateAction(body(false))).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(h.keys).toEqual(['edit-draft:u-sales', 'edit:u-sales']);
  });
});
