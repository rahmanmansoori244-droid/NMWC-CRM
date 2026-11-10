// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — lib/request-reasons.ts, the one
 * definition of "whose reason is this, and is it still current?".
 *
 * A request kept one reason line (CustomerEdit.decisionReason) for three things:
 * the salesman's own reason, the latest approver's, and a closure note. These are
 * the truth tables for reading them apart:
 *
 *   requestReasonOf   the requester's own words — never a reviewer's;
 *   roundSendBacks    every rejection of one round, oldest first;
 *   currentReason     what a reader must be told NOW (nothing, once a request
 *                     moves forward or is approved);
 *   the notification  the reason he was given, then the earlier ones.
 */
import { describe, expect, it } from 'vitest';
import {
  DECISION_TRAIL,
  MERGE_CLOSED_PREFIX,
  REQUEST_REASON_LEGACY_COPY,
  currentReason,
  earlierCountText,
  earlierInRoundText,
  mergeClosedReason,
  needsCorrectionBody,
  requestReasonOf,
  roundSendBacks,
  type DecisionRow,
  type ReasonEdit,
} from '@/lib/request-reasons';

const T = (min: number) => new Date(Date.UTC(2026, 10, 10, 6, min, 0));

const row = (over: Partial<DecisionRow> & Pick<DecisionRow, 'decision' | 'role'>): DecisionRow => ({
  cycle: 1,
  stepIndex: 0,
  reason: null,
  at: T(0),
  actor: { fullName: 'Someone' },
  ...over,
});
const approved = (role: string, stepIndex: number, min: number, cycle = 1) =>
  row({ decision: 'APPROVED', role, stepIndex, at: T(min), cycle });
const rejected = (role: string, stepIndex: number, min: number, reason: string, by: string, cycle = 1) =>
  row({ decision: 'REJECTED', role, stepIndex, at: T(min), reason, actor: { fullName: by }, cycle });

const edit = (over: Partial<ReasonEdit>): ReasonEdit => ({
  state: 'SUBMITTED',
  target: 'CUSTOMER',
  isReactivation: false,
  cycle: 1,
  requestReason: null,
  decisionReason: null,
  decisionCategory: null,
  reviewedAt: null,
  reviewedBy: null,
  ...over,
});

const A = 'CR number does not match the photo';
const B = 'Phone number format is incorrect';

describe('the rollback bridge and the merge sentence', () => {
  it('the legacy copy is ON: the build before this one reads a close reason from decisionReason', () => {
    // Turning it off is its own change (docs/handover/04-PENDING-WORK.md), with
    // the e2e and integration expectations that read the copy.
    expect(REQUEST_REASON_LEGACY_COPY).toBe(true);
  });

  it('the merge note is the sentence the merge has always written, and begins with its prefix', () => {
    expect(mergeClosedReason('NMWC-000007', 'NMWC-000003')).toBe(
      'Auto-closed: customer NMWC-000007 merged into NMWC-000003.'
    );
    expect(mergeClosedReason('a', 'b').startsWith(MERGE_CLOSED_PREFIX)).toBe(true);
  });

  it('the trail every screen reads is oldest first, with a tie broken the same way on every read', () => {
    expect(DECISION_TRAIL.orderBy).toEqual([{ at: 'asc' }, { id: 'asc' }]);
    expect(DECISION_TRAIL.select).toMatchObject({
      cycle: true,
      stepIndex: true,
      role: true,
      decision: true,
      reason: true,
      at: true,
      actor: { select: { fullName: true } },
    });
  });
});

describe('requestReasonOf: the requester’s own reason, never a reviewer’s', () => {
  it('a row written by this build: requestReason, whatever else the row says', () => {
    for (const state of ['SUBMITTED', 'APPROVED', 'REJECTED', 'NEEDS_CORRECTION']) {
      expect(
        requestReasonOf(edit({ target: 'BRANCH', state, requestReason: 'Shop shut for good', decisionReason: 'something else' }))
      ).toBe('Shop shut for good');
    }
    // A merge closed it: the note is the merge's, the reason is still his.
    expect(
      requestReasonOf(
        edit({ target: 'BRANCH', state: 'REJECTED', requestReason: 'Shop shut for good', decisionReason: mergeClosedReason('x', 'y') })
      )
    ).toBe('Shop shut for good');
  });

  it('blank is none', () => {
    expect(requestReasonOf(edit({ target: 'BRANCH', requestReason: '   ' }))).toBeNull();
    expect(requestReasonOf(edit({ target: 'BRANCH', requestReason: '', decisionReason: '  ' }))).toBeNull();
  });

  it('an older close or reactivation row, waiting or approved: decisionReason was only ever his', () => {
    for (const state of ['SUBMITTED', 'APPROVED']) {
      expect(requestReasonOf(edit({ target: 'BRANCH', state, decisionReason: 'Owner left the country' }))).toBe(
        'Owner left the country'
      );
      expect(
        requestReasonOf(edit({ target: 'BRANCH', isReactivation: true, state, decisionReason: 'Open again' }))
      ).toBe('Open again');
    }
    // A fixture that says only "it is a reactivation" is read the same way.
    expect(requestReasonOf({ state: 'SUBMITTED', target: '', isReactivation: true, decisionReason: 'Open again' })).toBe(
      'Open again'
    );
  });

  it('an older row refused by a reviewer (its own REJECTED decision row): still his', () => {
    const e = edit({ target: 'BRANCH', state: 'REJECTED', decisionReason: 'Owner left the country' });
    expect(requestReasonOf(e, [{ decision: 'REJECTED' }])).toBe('Owner left the country');
  });

  it('an older row whose text cannot be told apart from a reviewer’s or a merge’s: null', () => {
    // Refused before 2026-10-07: the reviewer's words replaced his.
    expect(
      requestReasonOf(edit({ target: 'BRANCH', state: 'NEEDS_CORRECTION', decisionReason: 'Photo is blurry' }), [
        { decision: 'REJECTED' },
      ])
    ).toBeNull();
    // REJECTED with no decision row: a merge, or a reactivation kept closed before decisions were recorded.
    const closed = edit({ target: 'BRANCH', state: 'REJECTED', decisionReason: 'Owner left the country' });
    expect(requestReasonOf(closed)).toBeNull();
    expect(requestReasonOf(closed, [])).toBeNull();
    expect(requestReasonOf(closed, [{ decision: 'APPROVED' }])).toBeNull();
    // The merge's own sentence is never his, decision row or not.
    expect(
      requestReasonOf(edit({ target: 'BRANCH', state: 'REJECTED', decisionReason: mergeClosedReason('x', 'y') }), [
        { decision: 'REJECTED' },
      ])
    ).toBeNull();
  });

  it('an update or a new-customer request has no request-level reason: decisionReason is a reviewer’s', () => {
    for (const state of ['SUBMITTED', 'APPROVED', 'REJECTED', 'NEEDS_CORRECTION', 'DRAFT']) {
      expect(requestReasonOf(edit({ target: 'CUSTOMER', state, decisionReason: A }), [{ decision: 'REJECTED' }])).toBeNull();
    }
  });
});

describe('roundSendBacks: every rejection of one round, oldest first', () => {
  const trail = [
    rejected('SUPERVISOR', 0, 50, B, 'Mgr One'),
    approved('SUPERVISOR', 0, 10),
    rejected('ACCOUNTANT', 1, 30, A, 'Acc One'),
    rejected('ACCOUNTANT', 1, 5, 'from another round', 'Acc One', 2),
  ];

  it('sorts by time, keeps the round, names the step in words and the person', () => {
    expect(roundSendBacks(1, trail)).toEqual([
      { step: 'Accountant', stepIndex: 1, by: 'Acc One', at: T(30), reason: A },
      { step: 'Supervisor', stepIndex: 0, by: 'Mgr One', at: T(50), reason: B },
    ]);
    expect(roundSendBacks(2, trail).map((s) => s.reason)).toEqual(['from another round']);
    expect(roundSendBacks(3, trail)).toEqual([]);
  });

  it('no decisions read is no send-backs', () => {
    expect(roundSendBacks(1, null)).toEqual([]);
    expect(roundSendBacks(1, undefined)).toEqual([]);
  });

  it('a step name is never the enum, and a row read without its actor has no name', () => {
    const [fm] = roundSendBacks(1, [
      { cycle: 1, stepIndex: 4, role: 'FINANCE_MANAGER', decision: 'REJECTED', reason: '  Stamp missing  ', at: T(1) },
    ]);
    expect(fm).toEqual({ step: 'Finance Manager', stepIndex: 4, by: null, at: T(1), reason: 'Stamp missing' });
  });
});

describe('currentReason: what a reader must be told now', () => {
  const relay = [
    approved('SUPERVISOR', 0, 10),
    rejected('ACCOUNTANT', 1, 30, A, 'Acc One'),
    rejected('SUPERVISOR', 0, 50, B, 'Mgr One'),
  ];

  it('APPROVED: nothing — not a rejection in its trail, not a stale decisionReason', () => {
    expect(currentReason(edit({ state: 'APPROVED', decisionReason: A }), [...relay, approved('SUPERVISOR', 0, 60, 2)])).toBeNull();
    expect(currentReason(edit({ state: 'APPROVED', decisionReason: A }), relay)).toBeNull();
    expect(currentReason(edit({ state: 'APPROVED', target: 'BRANCH', decisionReason: 'Shop shut' }), [])).toBeNull();
  });

  it('SUBMITTED, moving forward: nothing — even with a stale decisionReason and a later approval', () => {
    const forward = [approved('SUPERVISOR', 0, 10), rejected('ACCOUNTANT', 1, 30, A, 'Acc One'), approved('SUPERVISOR', 0, 40)];
    expect(currentReason(edit({ state: 'SUBMITTED', decisionReason: A }), forward)).toBeNull();
    // Never from the row alone: an older row can carry an answered step-back's reason.
    expect(currentReason(edit({ state: 'SUBMITTED', decisionReason: A }), [])).toBeNull();
    expect(currentReason(edit({ state: 'SUBMITTED', decisionReason: A }), null)).toBeNull();
    // A new round: last round's rejections are not this round's.
    expect(currentReason(edit({ state: 'SUBMITTED', cycle: 2 }), relay)).toBeNull();
    // The salesman's signed-form upload answered the Finance Manager's send-back.
    expect(
      currentReason(edit({ state: 'SUBMITTED' }), [
        rejected('FINANCE_MANAGER', 4, 30, 'Stamp missing', 'FM One'),
        row({ decision: 'FORM_UPLOADED', role: 'SALESMAN', stepIndex: 3, at: T(45) }),
      ])
    ).toBeNull();
  });

  it('SUBMITTED, returned one step by the round’s last decision: that send-back, and the ones before it', () => {
    expect(currentReason(edit({ state: 'SUBMITTED', decisionReason: A }), relay.slice(0, 2))).toEqual({
      kind: 'RETURNED_TO_STEP',
      latest: { step: 'Accountant', stepIndex: 1, by: 'Acc One', at: T(30), reason: A },
      earlier: [],
    });
    // GM -> Finance Manager -> the salesman's signed-application step.
    const credit = [
      rejected('GM', 5, 20, 'Limit too high for a new shop', 'GM One'),
      rejected('FINANCE_MANAGER', 4, 40, 'Ask the customer to sign for the lower limit', 'FM One'),
    ];
    expect(currentReason(edit({ state: 'SUBMITTED' }), credit)).toEqual({
      kind: 'RETURNED_TO_STEP',
      latest: { step: 'Finance Manager', stepIndex: 4, by: 'FM One', at: T(40), reason: 'Ask the customer to sign for the lower limit' },
      earlier: [{ step: 'GM', stepIndex: 5, by: 'GM One', at: T(20), reason: 'Limit too high for a new shop' }],
    });
  });

  it('NEEDS_CORRECTION: the latest send-back with who and where, earlier ones in order', () => {
    expect(currentReason(edit({ state: 'NEEDS_CORRECTION', decisionReason: B }), relay)).toEqual({
      kind: 'SENT_BACK',
      latest: { step: 'Supervisor', stepIndex: 0, by: 'Mgr One', at: T(50), reason: B },
      earlier: [{ step: 'Accountant', stepIndex: 1, by: 'Acc One', at: T(30), reason: A }],
    });
  });

  it('NEEDS_CORRECTION with no decision rows (an older row, a seeded fixture): read off the request itself', () => {
    const at = T(55);
    expect(
      currentReason(edit({ state: 'NEEDS_CORRECTION', decisionReason: B, reviewedAt: at, reviewedBy: { fullName: 'Mgr One' } }), [])
    ).toEqual({ kind: 'SENT_BACK', latest: { step: null, stepIndex: null, by: 'Mgr One', at, reason: B }, earlier: [] });
    // Nothing on record at all: still sent back, with no reason to print.
    expect(currentReason(edit({ state: 'NEEDS_CORRECTION' }), undefined)).toEqual({
      kind: 'SENT_BACK',
      latest: { step: null, stepIndex: null, by: null, at: null, reason: null },
      earlier: [],
    });
  });

  it('NEEDS_CORRECTION whose decision row carries no reason: the row’s own copy of that send-back stands in', () => {
    const got = currentReason(edit({ state: 'NEEDS_CORRECTION', decisionReason: B }), [
      row({ decision: 'REJECTED', role: 'SUPERVISOR', at: T(50), reason: null, actor: { fullName: 'Mgr One' } }),
    ]);
    expect(got).toMatchObject({ kind: 'SENT_BACK', latest: { step: 'Supervisor', by: 'Mgr One', reason: B } });
  });

  it('a DRAFT saved after a send-back still says why; a draft never sent says nothing', () => {
    expect(currentReason(edit({ state: 'DRAFT', decisionReason: B }), relay)).toMatchObject({
      kind: 'SENT_BACK',
      latest: { step: 'Supervisor', by: 'Mgr One', reason: B },
      earlier: [{ step: 'Accountant', reason: A }],
    });
    // An older row: no decision rows, the reason on the request.
    expect(currentReason(edit({ state: 'DRAFT', decisionReason: B }), [])).toMatchObject({
      kind: 'SENT_BACK',
      latest: { step: null, reason: B },
    });
    expect(currentReason(edit({ state: 'DRAFT' }), [])).toBeNull();
    expect(currentReason(edit({ state: 'DRAFT', decisionReason: 'x', decisionCategory: 'withdrawn' }), [])).toBeNull();
    // Another round's rejection is not this draft's.
    expect(currentReason(edit({ state: 'DRAFT', cycle: 2 }), relay)).toBeNull();
  });

  it('REJECTED by a reviewer (a close refused, a shop kept closed): his decision, never the salesman’s words', () => {
    const refused = [rejected('SUPERVISOR', 0, 20, 'Shop is open, I passed it today', 'Mgr One')];
    expect(
      currentReason(edit({ state: 'REJECTED', target: 'BRANCH', requestReason: 'Shop shut', decisionReason: 'Shop shut' }), refused)
    ).toEqual({
      kind: 'REFUSED',
      latest: { step: 'Supervisor', stepIndex: 0, by: 'Mgr One', at: T(20), reason: 'Shop is open, I passed it today' },
    });
    // Kept closed before decisions were recorded: the row's text is the salesman's — not shown as the reviewer's.
    const at = T(25);
    expect(
      currentReason(
        edit({ state: 'REJECTED', target: 'BRANCH', isReactivation: true, decisionReason: 'Open again', reviewedAt: at, reviewedBy: { fullName: 'Mgr One' } }),
        []
      )
    ).toEqual({ kind: 'REFUSED', latest: { step: null, stepIndex: null, by: 'Mgr One', at, reason: null } });
  });

  it('REJECTED with no approver’s decision: the closure note — checked before any rejection in its round', () => {
    // Sent back, then withdrawn by its salesman: closed, not "refused".
    expect(
      currentReason(
        edit({ state: 'REJECTED', decisionReason: 'Withdrawn by the salesman who sent it.', decisionCategory: 'withdrawn' }),
        relay
      )
    ).toEqual({ kind: 'CLOSED', note: 'Withdrawn by the salesman who sent it.' });
    // A merge's auto-close sets no category: known by its sentence, on a close request too.
    const merged = mergeClosedReason('NMWC-000007', 'NMWC-000003');
    expect(currentReason(edit({ state: 'REJECTED', target: 'BRANCH', requestReason: 'Shop shut', decisionReason: merged }), [])).toEqual({
      kind: 'CLOSED',
      note: merged,
    });
    expect(currentReason(edit({ state: 'REJECTED', decisionReason: merged }), [])).toEqual({ kind: 'CLOSED', note: merged });
    // An update closed some other way keeps whatever note is there; with none, nothing.
    expect(currentReason(edit({ state: 'REJECTED', decisionReason: 'Closed by an operator' }), [])).toEqual({
      kind: 'CLOSED',
      note: 'Closed by an operator',
    });
    expect(currentReason(edit({ state: 'REJECTED' }), [])).toBeNull();
    expect(currentReason(edit({ state: 'REJECTED', decisionCategory: 'withdrawn' }), relay)).toBeNull();
  });

  it('an unknown state says nothing', () => {
    expect(currentReason(edit({ state: 'SOMETHING_NEW', decisionReason: A }), relay)).toBeNull();
  });
});

describe('the notification: the reason he was given, then the earlier ones', () => {
  const acc = { step: 'Accountant', stepIndex: 1, by: 'Acc One', at: T(30), reason: A };
  const gm = { step: 'GM', stepIndex: 5, by: 'GM One', at: T(20), reason: 'Limit too high' };

  it('one send-back in the round: the sentence as it has always been', () => {
    expect(earlierInRoundText([])).toBe('');
    expect(needsCorrectionBody('Al Noor Trading', B, [])).toBe(`Al Noor Trading — returned to you: ${B}`);
  });

  it('a relayed send-back carries the earlier reason, by step and not by name', () => {
    expect(needsCorrectionBody('Al Noor Trading', B, [acc])).toBe(
      `Al Noor Trading — returned to you: ${B} (Earlier in this round — Accountant step: ${A})`
    );
    expect(earlierInRoundText([gm, acc])).toBe(` (Earlier in this round — GM step: Limit too high; Accountant step: ${A})`);
    expect(earlierInRoundText([acc])).not.toContain('Acc One');
  });

  it('a long earlier reason is clipped at 280 characters; the latest is never clipped', () => {
    const long = 'x'.repeat(1000);
    const body = needsCorrectionBody('Shop', long, [{ ...acc, reason: long }]);
    expect(body.startsWith(`Shop — returned to you: ${long} (Earlier in this round — Accountant step: `)).toBe(true);
    const bracket = body.slice(body.indexOf('Accountant step: ') + 'Accountant step: '.length, -1);
    expect(bracket).toHaveLength(280);
    expect(bracket.endsWith('…')).toBe(true);
    // Exactly 280 is kept whole.
    expect(earlierInRoundText([{ ...acc, reason: 'y'.repeat(280) }])).toContain('y'.repeat(280) + ')');
  });

  it('an earlier send-back with nothing recorded says so', () => {
    expect(earlierInRoundText([{ ...acc, reason: null }])).toBe(' (Earlier in this round — Accountant step: no reason on record)');
  });

  it('a list row counts the earlier ones in words', () => {
    expect(earlierCountText(0)).toBe('');
    expect(earlierCountText(1)).toBe('and 1 earlier reason in this round');
    expect(earlierCountText(3)).toBe('and 3 earlier reasons in this round');
  });
});
