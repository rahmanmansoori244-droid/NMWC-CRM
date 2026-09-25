// @vitest-environment node
/**
 * lib/submission-replay.ts (benchmark item 22), the parts that need no database:
 * when a failed submit is answered from its receipt, which receipt is refused,
 * the time a receipt shows, and the words for a customer whose one open request
 * is the salesman's own. The Postgres behaviour is golive-update-flow section 12.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  answerIfLanded,
  findReceipt,
  ownOpenRequestMessage,
  ownPendingBanner,
  shownTime,
} from '@/lib/submission-replay';
import type { SubmitReceipt } from '@/lib/submission';

const receipt: SubmitReceipt = { editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: true };

describe('answerIfLanded', () => {
  it('returns the work when it succeeds, without asking for a receipt', async () => {
    const fresh = { ...receipt, replayed: false };
    const ask = vi.fn();
    expect(await answerIfLanded(async () => fresh, ask)).toBe(fresh);
    expect(ask).not.toHaveBeenCalled();
  });

  it('a failure after its own id landed is answered with the receipt', async () => {
    const out = await answerIfLanded(
      async () => {
        throw new Error('EDIT_LOCKED');
      },
      async () => receipt
    );
    expect(out).toBe(receipt);
  });

  it('a failure with no landed id stands', async () => {
    await expect(
      answerIfLanded(
        async () => {
          throw new Error('No changes to submit.');
        },
        async () => null
      )
    ).rejects.toThrow('No changes to submit.');
  });

  it('a lookup that fails too (the database still down) leaves the ORIGINAL error standing', async () => {
    await expect(
      answerIfLanded(
        async () => {
          throw new Error('P1001 unreachable');
        },
        async () => {
          throw new Error('lookup failed');
        }
      )
    ).rejects.toThrow('P1001 unreachable');
  });
});

describe('findReceipt', () => {
  const row = {
    id: 'e1',
    state: 'SUBMITTED' as const,
    process: 'UPDATE' as const,
    target: 'CUSTOMER' as const,
    customerId: 'c1',
    branchId: null,
    isReactivation: false,
    submittedAt: new Date('2026-09-25T06:42:00.000Z'),
    updatedAt: new Date('2026-09-25T07:00:00.000Z'),
  };
  const db = (found: unknown) => ({ customerEdit: { findUnique: vi.fn(async () => found) } });

  it('no id: no lookup at all', async () => {
    const d = db(row);
    expect(await findReceipt(d as never, 'u1', undefined, { process: 'UPDATE' })).toBeNull();
    expect(d.customerEdit.findUnique).not.toHaveBeenCalled();
  });

  it("looks the id up among the submitter's OWN requests only", async () => {
    const d = db(null);
    await findReceipt(d as never, 'u1', 'sid', { process: 'UPDATE' });
    expect(d.customerEdit.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { submittedById_submissionId: { submittedById: 'u1', submissionId: 'sid' } } })
    );
  });

  it('answers the request as it stands now', async () => {
    expect(
      await findReceipt(db(row) as never, 'u1', 'sid', { process: 'UPDATE', target: 'CUSTOMER', customerId: 'c1' })
    ).toEqual({ editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: true });
  });

  it.each([
    ['another customer', { process: 'UPDATE', customerId: 'c2' }],
    ['another form', { process: 'CREATE' }],
    ['a close for a reactivation', { process: 'UPDATE', isReactivation: true }],
    ['another resumed request', { process: 'UPDATE', editId: 'e9' }],
  ] as const)('refuses the same id for %s rather than hand back the wrong receipt', async (_l, expectation) => {
    await expect(findReceipt(db(row) as never, 'u1', 'sid', expectation)).rejects.toMatchObject({
      code: 'SUBMISSION_ID_REUSED',
    });
  });
});

describe('shownTime', () => {
  const submittedAt = new Date('2026-09-20T06:00:00.000Z');
  const updatedAt = new Date('2026-09-25T06:42:00.000Z');
  it('a draft shows when it was saved — not a previous round’s submit', () => {
    expect(shownTime({ state: 'DRAFT', submittedAt, updatedAt })).toBe(updatedAt);
  });
  it('anything else shows when it was sent', () => {
    expect(shownTime({ state: 'SUBMITTED', submittedAt, updatedAt })).toBe(submittedAt);
    expect(shownTime({ state: 'SUBMITTED', submittedAt: null, updatedAt })).toBe(updatedAt);
  });
});

describe('the words for his own open request', () => {
  const at = new Date('2026-09-25T06:42:00.000Z'); // 10:42 Muscat
  const update = { target: 'CUSTOMER' as const, isReactivation: false, branchId: null, submittedAt: at };
  const close = (branchId: string) => ({ target: 'BRANCH' as const, isReactivation: false, branchId, submittedAt: at });
  const reactivate = { target: 'BRANCH' as const, isReactivation: true, branchId: 'b1', submittedAt: at };

  it('the same request: it arrived', () => {
    expect(ownOpenRequestMessage(update, { kind: 'update' })).toMatch(/^Your changes sent at 10:42 already arrived/);
    expect(ownOpenRequestMessage(close('b1'), { kind: 'close', branchId: 'b1' })).toMatch(
      /^Your request to mark a branch closed, sent at 10:42, already arrived/
    );
  });

  it('a different request: names what is waiting, and that THIS was not sent', () => {
    expect(ownOpenRequestMessage(close('b1'), { kind: 'update' })).toBe(
      'Your request to mark a branch closed, sent at 10:42, is still waiting for review, so these changes were NOT sent. Send them once that is decided.'
    );
    expect(ownOpenRequestMessage(update, { kind: 'close', branchId: 'b1' })).toBe(
      'Your changes to this customer, sent at 10:42, are still waiting for approval, so this request was NOT sent. Send it once that is decided.'
    );
    // Same kind, another branch: not "it arrived".
    expect(ownOpenRequestMessage(close('b2'), { kind: 'close', branchId: 'b1' })).toMatch(/NOT sent/);
    expect(ownOpenRequestMessage(reactivate, { kind: 'close', branchId: 'b1' })).toMatch(
      /^Your request to reactivate a branch, sent at 10:42, is still waiting/
    );
  });

  it('never names an approver: a reactivation is a Manager’s, not "your supervisor’s"', () => {
    for (const m of [
      ownOpenRequestMessage(update, { kind: 'update' }),
      ownOpenRequestMessage(reactivate, { kind: 'reactivate', branchId: 'b1' }),
      ownPendingBanner(update),
      ownPendingBanner(reactivate),
    ]) {
      expect(m).not.toMatch(/supervisor|manager/i);
    }
  });

  it('the edit page banner names what is waiting', () => {
    expect(ownPendingBanner(update)).toMatch(/^Your changes sent at 10:42 arrived and are waiting for approval/);
    expect(ownPendingBanner(close('b1'))).toMatch(/^Your request to mark a branch closed, sent at 10:42, is waiting for review/);
  });
});
