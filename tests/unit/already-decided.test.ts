// @vitest-environment node
/**
 * Code review 2026-11-10, finding 21: the words of a decision's refusal when the
 * step the page showed was already decided (lib/already-decided.ts).
 *
 *   - his own decision: "Your decision already arrived", whoever he is now;
 *   - a colleague's: "Already decided by a colleague", naming who and what, but
 *     only to a viewer who could have decided that step himself;
 *   - nobody's, or a viewer who could not have decided it: null, so the refusal
 *     that was coming stands (FORBIDDEN stays FORBIDDEN);
 *   - a request no longer waiting is described in words, never by its enum.
 *
 * The services' side (approve, reject, bulk, reactivations) is proven on
 * Postgres in tests/integration/approval-answers.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { EditState } from '@prisma/client';
import {
  ALREADY_DECIDED_CODE,
  CLOSE_REQUEST_DECISION_WORDS,
  REACTIVATION_DECISION_WORDS,
  REQUEST_DECISION_WORDS,
  alreadyDecidedRefusal,
  colleagueDecidedMessage,
  notPendingMessage,
  yourDecisionArrivedMessage,
} from '@/lib/already-decided';
import { ConflictError } from '@/lib/errors';
import { freezeChain, reactivationChain, resolveChain } from '@/lib/approval-chains';

const CHAIN = freezeChain(resolveChain('CREATE', 'CASH'));
const STAGE = new Date('2026-11-10T08:00:00.000Z');
const LOST = { actorId: 'm2', entityType: 'CustomerEdit', entityId: 'e1', path: 'edit.approve' };

type Row = {
  cycle: number;
  stepIndex: number;
  role: string;
  decision: string;
  actorId: string;
  actorRole: string | null;
  actor: { fullName: string; role: string };
};
const decision = (over: Partial<Row> = {}): Row => ({
  cycle: 1,
  stepIndex: 0,
  role: 'SUPERVISOR',
  decision: 'APPROVED',
  actorId: 'm1',
  actorRole: 'MANAGER',
  actor: { fullName: 'Manager One', role: 'MANAGER' },
  ...over,
});

function dbWith(latest: Row | null, others: Array<{ actorId: string }> = []) {
  const findMany = vi.fn(async (args: { take?: number; where?: unknown }) => (args.take === 1 ? (latest ? [latest] : []) : others));
  return { db: { editApproval: { findMany } } as never, findMany };
}

const base = (over: Partial<Parameters<typeof alreadyDecidedRefusal>[1]> = {}) => ({
  editId: 'e1',
  viewerId: 'm2',
  visit: { cycle: 1, stepIndex: 0, stageEnteredAt: STAGE },
  approvalChain: CHAIN,
  words: REQUEST_DECISION_WORDS,
  couldDecide: () => true,
  lost: LOST,
  ...over,
});

describe('alreadyDecidedRefusal', () => {
  it('his own decision for the visit his page showed: "Your decision already arrived", not a lost race', async () => {
    const { db } = dbWith(decision({ actorId: 'm1' }));
    const err = await alreadyDecidedRefusal(db, base({ viewerId: 'm1', couldDecide: () => false }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err!.code).toBe(ALREADY_DECIDED_CODE);
    expect(err!.message).toBe(
      'Your decision already arrived: you approved this request at the Supervisor step. Nothing more was saved. Reload to see where it is now.'
    );
    // Told to him even when he could not decide that step now (his own approval
    // counts as "another step" by now): it reveals only what he did himself.
    expect(err!.conflict).toBeUndefined();
  });

  it('it asks for the exact visit: the round, the step and the time the step was entered', async () => {
    const { db, findMany } = dbWith(null);
    await alreadyDecidedRefusal(db, base());
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { editId: 'e1', cycle: 1, stepIndex: 0, stageEnteredAt: STAGE },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 1,
    });
  });

  it('a token from before the stage columns (no entry time) asks for the step of the round', async () => {
    const { db, findMany } = dbWith(null);
    await alreadyDecidedRefusal(db, base({ visit: { cycle: 2, stepIndex: 1, stageEnteredAt: null } }));
    expect(findMany.mock.calls[0]![0].where).toEqual({ editId: 'e1', cycle: 2, stepIndex: 1 });
  });

  it('no visit (a reactivation): the request’s latest decision', async () => {
    const { db, findMany } = dbWith(null);
    await alreadyDecidedRefusal(db, base({ visit: null }));
    expect(findMany.mock.calls[0]![0].where).toEqual({ editId: 'e1' });
  });

  it('nothing decided for that visit: null, the coming refusal stands', async () => {
    const { db } = dbWith(null);
    expect(await alreadyDecidedRefusal(db, base())).toBeNull();
  });

  it('a colleague’s decision, to a viewer who could have made it: named, with his role and what he did — a lost race, recorded', async () => {
    const { db, findMany } = dbWith(decision(), [{ actorId: 'acc' }]);
    const couldDecide = vi.fn(() => true);
    const err = await alreadyDecidedRefusal(db, base({ couldDecide }));
    expect(err!.code).toBe('NOT_PENDING');
    expect(err!.message).toBe(
      'Already decided by a colleague: Manager One (Manager) approved this request at the Supervisor step. Nothing more was saved. Reload to see where it is now.'
    );
    expect(err!.conflict).toEqual(LOST);
    // The gate's rule on the DECIDED step, with the round's other steps' actors.
    expect(couldDecide).toHaveBeenCalledWith(expect.objectContaining({ role: 'SUPERVISOR' }), ['acc']);
    expect(findMany.mock.calls[1]![0].where).toEqual({ editId: 'e1', cycle: 1, stepIndex: { not: 0 } });
  });

  it('a colleague’s decision, to a viewer who could not have made it: null — he is not told who', async () => {
    const { db } = dbWith(decision());
    expect(await alreadyDecidedRefusal(db, base({ couldDecide: async () => false }))).toBeNull();
  });

  it('a send-back, a refused close request and the signed application have their own words', async () => {
    let { db } = dbWith(decision({ decision: 'REJECTED', actorId: 'm2' }));
    expect((await alreadyDecidedRefusal(db, base()))!.message).toMatch(/^Your decision already arrived: you sent this request back at the Supervisor step\./);
    ({ db } = dbWith(decision({ decision: 'REJECTED', actorId: 'm2' })));
    expect((await alreadyDecidedRefusal(db, base({ words: CLOSE_REQUEST_DECISION_WORDS })))!.message).toMatch(
      /^Your decision already arrived: you refused this request at the Supervisor step\./
    );
    ({ db } = dbWith(decision({ decision: 'FORM_UPLOADED', role: 'SALESMAN', actorId: 'm2' })));
    expect((await alreadyDecidedRefusal(db, base()))!.message).toMatch(
      /^Your decision already arrived: you sent the signed application for this request at the Signed application step\./
    );
  });

  it('a reactivation’s answers in its own words', async () => {
    const { db } = dbWith(decision({ decision: 'REJECTED', role: 'MANAGER' }));
    const err = await alreadyDecidedRefusal(db, base({ visit: null, approvalChain: freezeChain(reactivationChain()), words: REACTIVATION_DECISION_WORDS }));
    expect(err!.message).toBe(
      'Already decided by a colleague: Manager One (Manager) kept this shop closed at the Manager step. Nothing more was saved. Reload to see where it is now.'
    );
  });

  it('a decision it has no words for, or a chain it cannot read: null', async () => {
    let { db } = dbWith(decision({ decision: 'SOMETHING_ELSE' }));
    expect(await alreadyDecidedRefusal(db, base())).toBeNull();
    ({ db } = dbWith(decision()));
    expect(await alreadyDecidedRefusal(db, base({ approvalChain: { not: 'a chain' } }))).toBeNull();
  });

  it('the role recorded when he decided wins over his role now', async () => {
    const { db } = dbWith(decision({ actorRole: 'SUPERVISOR', actor: { fullName: 'Sup One', role: 'MANAGER' } }));
    expect((await alreadyDecidedRefusal(db, base()))!.message).toContain('Sup One (Supervisor) approved');
  });
});

describe('notPendingMessage: where a request stands, never its enum', () => {
  it.each(Object.values(EditState))('%s', (state) => {
    const m = notPendingMessage(state);
    expect(m).toMatch(/^This request is no longer waiting for a decision: .+\. Reload to see where it is now\.$/);
    expect(m).not.toContain(state);
    expect(m).not.toMatch(/Edit is in state/);
  });

  it('says what happened in each case', () => {
    expect(notPendingMessage('APPROVED')).toContain('it has already been approved');
    expect(notPendingMessage('NEEDS_CORRECTION')).toContain('sent back to the salesman to correct');
    expect(notPendingMessage('REJECTED')).toContain('turned down or closed');
    expect(notPendingMessage('SOMETHING_NEW')).toContain('it is not waiting for a decision');
  });
});

describe('the sentences', () => {
  it('name the step by its screen name, and the colleague by name and role', () => {
    expect(yourDecisionArrivedMessage('approved this request', 'FINANCE_MANAGER')).toContain('at the Finance Manager step');
    expect(colleagueDecidedMessage('approved this request', 'ACCOUNTANT', { fullName: 'A. N. Other', role: 'ACCOUNTANT' })).toBe(
      'Already decided by a colleague: A. N. Other (Accountant) approved this request at the Accountant step. Nothing more was saved. Reload to see where it is now.'
    );
    expect(colleagueDecidedMessage('approved this request', 'SUPERVISOR', { fullName: 'X', role: null })).toContain('X approved');
  });
});
