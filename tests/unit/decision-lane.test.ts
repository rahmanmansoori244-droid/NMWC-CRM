// @vitest-environment node
/**
 * F1 (2026-10-05): the review page says when its viewer cannot decide the
 * request (lib/decision-lane.ts), by the same rule approveEditCore applies.
 *
 * Challenges note: "an FYI Accountant opening a CREATE or UPDATE that is still
 * at the Supervisor step sees decision buttons that are refused on click"; and
 * "no recipient of [a reactivation's SLA breach] has a working page". The page
 * now carries a banner in both cases; these cases pin when.
 */
import { describe, it, expect } from 'vitest';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { decisionLaneFor } from '@/lib/decision-lane';

const SALES = { id: 's1', supervisorId: 'm1' };
const viewer = (id: string, role: Role) => ({ id, role, username: id });
const branchIn = (regionId: string) => [{ regionId, deletedAt: null }];

function edit(over: Partial<Parameters<typeof decisionLaneFor>[1]> = {}) {
  return {
    state: 'SUBMITTED',
    isReactivation: false,
    approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CASH),
    currentStepIndex: 0,
    cycle: 1,
    submittedBy: SALES,
    steps: [],
    ...over,
  };
}

describe('decisionLaneFor', () => {
  it('the supervisor can decide the Supervisor step', () => {
    const lane = decisionLaneFor(viewer('m1', Role.MANAGER), edit(), {
      branches: branchIn('g1'),
      managedRegionIds: ['g1'],
    });
    expect(lane).toEqual({ kind: 'decide' });
  });

  it('an Accountant told for information while the request is at the Supervisor step only reads it', () => {
    const lane = decisionLaneFor(viewer('a1', Role.ACCOUNTANT), edit(), {
      branches: branchIn('g1'),
      managedRegionIds: ['g1'],
    });
    expect(lane).toEqual({ kind: 'inform', waitingOn: Role.SUPERVISOR });
  });

  it('the same Accountant decides once the request reaches his step', () => {
    const lane = decisionLaneFor(viewer('a1', Role.ACCOUNTANT), edit({ currentStepIndex: 1 }), {
      branches: branchIn('g1'),
      managedRegionIds: ['g1'],
    });
    expect(lane).toEqual({ kind: 'decide' });
  });

  it('separation of duty: an actor of another step in this cycle only reads it', () => {
    const lane = decisionLaneFor(
      viewer('a1', Role.ACCOUNTANT),
      edit({ currentStepIndex: 1, steps: [{ cycle: 1, stepIndex: 0, actorId: 'a1' }] }),
      { branches: branchIn('g1'), managedRegionIds: ['g1'] }
    );
    expect(lane.kind).toBe('inform');
  });

  it('a decision in an earlier cycle does not count against him', () => {
    const lane = decisionLaneFor(
      viewer('a1', Role.ACCOUNTANT),
      edit({ currentStepIndex: 1, cycle: 2, steps: [{ cycle: 1, stepIndex: 0, actorId: 'a1' }] }),
      { branches: branchIn('g1'), managedRegionIds: ['g1'] }
    );
    expect(lane.kind).toBe('decide');
  });

  it('a region-overlap Manager may decide the Supervisor step (RBAC-05-003 fallback)', () => {
    const lane = decisionLaneFor(viewer('m2', Role.MANAGER), edit(), {
      branches: branchIn('g1'),
      managedRegionIds: ['g1'],
    });
    expect(lane.kind).toBe('decide');
  });

  it('a GM looking at a CASH request reads it; at his own CREDIT step he decides', () => {
    expect(
      decisionLaneFor(viewer('gm', Role.GM), edit({ currentStepIndex: 1 }), { branches: branchIn('g1'), managedRegionIds: [] })
    ).toEqual({ kind: 'inform', waitingOn: Role.ACCOUNTANT });
    // The 6-step credit chain (owner decisions 2026-10-11): the GM is step 4.
    const credit = edit({ approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT), currentStepIndex: 4 });
    expect(decisionLaneFor(viewer('gm', Role.GM), credit, { branches: branchIn('g1'), managedRegionIds: [] })).toEqual({
      kind: 'decide',
    });
  });

  it('owner decisions 2026-10-11: the Sales Director decides his step, and only his', () => {
    const atSd = edit({ approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT), currentStepIndex: 1 });
    expect(decisionLaneFor(viewer('sd', Role.SALES_DIRECTOR), atSd, { branches: branchIn('g1'), managedRegionIds: [] })).toEqual({
      kind: 'decide',
    });
    expect(decisionLaneFor(viewer('gm', Role.GM), atSd, { branches: branchIn('g1'), managedRegionIds: [] })).toEqual({
      kind: 'inform',
      waitingOn: Role.SALES_DIRECTOR,
    });
  });

  it('owner decisions 2026-10-11: at the signed-application step nobody decides — the lane says so for everyone', () => {
    const atForm = edit({ approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT), currentStepIndex: 2 });
    for (const v of [
      viewer('m1', Role.MANAGER),
      viewer('sup', Role.SUPERVISOR),
      viewer('sd', Role.SALES_DIRECTOR),
      viewer('fm', Role.FINANCE_MANAGER),
      viewer('gm', Role.GM),
      viewer('a1', Role.ACCOUNTANT),
    ]) {
      expect(decisionLaneFor(v, atForm, { branches: branchIn('g1'), managedRegionIds: ['g1'] }), v.role).toEqual({
        kind: 'signedForm',
      });
    }
  });

  it('a reactivation is never decided here, whoever looks', () => {
    for (const v of [viewer('m1', Role.MANAGER), viewer('gm', Role.GM), viewer('a1', Role.ACCOUNTANT)]) {
      expect(
        decisionLaneFor(v, edit({ isReactivation: true, approvalChain: null }), {
          branches: branchIn('g1'),
          managedRegionIds: ['g1'],
        })
      ).toEqual({ kind: 'reactivation' });
    }
  });

  it('a decided request says nothing here: the page shows the decision', () => {
    expect(
      decisionLaneFor(viewer('a1', Role.ACCOUNTANT), edit({ state: 'APPROVED' }), {
        branches: branchIn('g1'),
        managedRegionIds: ['g1'],
      })
    ).toEqual({ kind: 'closed' });
  });

  it('a close-shop request (no frozen chain) is the Supervisor step', () => {
    const lane = decisionLaneFor(
      viewer('a1', Role.ACCOUNTANT),
      edit({ approvalChain: null }),
      { branches: branchIn('g1'), managedRegionIds: ['g1'] }
    );
    expect(lane).toEqual({ kind: 'inform', waitingOn: Role.SUPERVISOR });
  });
});
