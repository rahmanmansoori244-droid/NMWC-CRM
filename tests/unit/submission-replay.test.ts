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
  pendingReplacesDraft,
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

describe('pendingReplacesDraft — whether approving what is pending throws away a draft saved meanwhile', () => {
  // The draft is dropped when the server values it started from change, and
  // the customer's status is one of them (lib/enrichment-draft.ts).
  it('a pending update does, whatever the status', () => {
    for (const st of ['ACTIVE', 'CLOSED', 'SUSPENDED'] as const) expect(pendingReplacesDraft('update', st)).toBe(true);
  });

  it('a pending close does not: it changes only its branch, which is not in the draft base', () => {
    for (const st of ['ACTIVE', 'CLOSED', 'SUSPENDED'] as const) expect(pendingReplacesDraft('close', st)).toBe(false);
  });

  it('a reactivation does when it turns the customer ACTIVE — never when it already is (item 22 review)', () => {
    expect(pendingReplacesDraft('reactivate', 'ACTIVE')).toBe(false);
    expect(pendingReplacesDraft('reactivate', 'CLOSED')).toBe(true);
    expect(pendingReplacesDraft('reactivate', 'SUSPENDED')).toBe(true);
  });

  it('nothing pending: nothing replaces it', () => {
    expect(pendingReplacesDraft(null, 'CLOSED')).toBe(false);
  });
});

describe('the words for his own open request', () => {
  // CLAUDE.md: a fixture that reads the real clock is never asserted against a
  // literal. The helpers take `now`; every call here passes this one. (The first
  // version read the real clock and went red at 00:00 Muscat the day it merged.)
  const now = new Date('2026-09-25T10:00:00.000Z'); // 14:00 Muscat, 25 Sep
  const at = new Date('2026-09-25T06:42:00.000Z'); // 10:42 Muscat, same day
  const update = { target: 'CUSTOMER' as const, isReactivation: false, branchId: null, submittedAt: at };
  const close = (branchId: string) => ({ target: 'BRANCH' as const, isReactivation: false, branchId, submittedAt: at });
  const reactivate = { target: 'BRANCH' as const, isReactivation: true, branchId: 'b1', submittedAt: at };

  it('the same request: it arrived', () => {
    expect(ownOpenRequestMessage(update, { kind: 'update' }, now)).toMatch(/^Your changes sent at 10:42 already arrived/);
    expect(ownOpenRequestMessage(close('b1'), { kind: 'close', branchId: 'b1' }, now)).toMatch(
      /^Your request to mark a branch closed, sent at 10:42, already arrived/
    );
  });

  it('a different request: names what is waiting, and that THIS was not sent', () => {
    expect(ownOpenRequestMessage(close('b1'), { kind: 'update' }, now)).toBe(
      'Your request to mark a branch closed, sent at 10:42, is still waiting for review, so these changes were NOT sent. Send them once that is decided.'
    );
    expect(ownOpenRequestMessage(update, { kind: 'close', branchId: 'b1' }, now)).toBe(
      'Your changes to this customer, sent at 10:42, are still waiting for approval, so this request was NOT sent. Send it once that is decided.'
    );
    // Same kind, another branch: not "it arrived".
    expect(ownOpenRequestMessage(close('b2'), { kind: 'close', branchId: 'b1' }, now)).toMatch(/NOT sent/);
    expect(ownOpenRequestMessage(reactivate, { kind: 'close', branchId: 'b1' }, now)).toMatch(
      /^Your request to reactivate a branch, sent at 10:42, is still waiting/
    );
  });

  it('on another day it names the day — so the clock it reads is the one it is given', () => {
    const nextDay = new Date('2026-09-26T05:00:00.000Z');
    expect(ownOpenRequestMessage(update, { kind: 'update' }, nextDay)).toMatch(/^Your changes sent at 25 Sept, 10:42/);
    expect(ownPendingBanner(update, nextDay)).toMatch(/^Your changes sent at 25 Sept, 10:42/);
  });

  it('never names an approver: a reactivation is a Manager’s, not "your supervisor’s"', () => {
    for (const m of [
      ownOpenRequestMessage(update, { kind: 'update' }, now),
      ownOpenRequestMessage(reactivate, { kind: 'reactivate', branchId: 'b1' }, now),
      ownPendingBanner(update, now),
      ownPendingBanner(reactivate, now),
    ]) {
      expect(m).not.toMatch(/supervisor|manager/i);
    }
  });

  it('the edit page banner names what is waiting — and does not invite a draft its approval would replace', () => {
    expect(ownPendingBanner(update, now)).toBe(
      'Your changes sent at 10:42 arrived and are waiting for approval. You cannot submit again until they are decided.'
    );
    expect(ownPendingBanner(close('b1'), now)).toBe(
      'Your request to mark a branch closed, sent at 10:42, is waiting for review. You cannot submit changes until it is decided.'
    );
  });
});
