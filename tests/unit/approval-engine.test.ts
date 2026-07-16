/**
 * Phase 1b: approval-chain matrix + step-authorization unit tests.
 */
import { describe, it, expect } from 'vitest';
import { Role, PaymentTerms, EditProcess } from '@prisma/client';
import {
  resolveChain,
  isFinalStep,
  resolveRejectTarget,
  parseChain,
  stepDeadline,
} from '@/lib/approval-chains';
import { canActOnStep } from '@/lib/permissions';

describe('resolveChain', () => {
  it('UPDATE → single Supervisor step', () => {
    const c = resolveChain(EditProcess.UPDATE, PaymentTerms.CASH);
    expect(c.map((s) => s.role)).toEqual([Role.SUPERVISOR]);
    expect(c.find((s) => s.role === Role.SUPERVISOR)?.scope).toBe('SUPERVISOR_OF_SUBMITTER');
  });

  it('CREATE + CASH → Supervisor → Accountant (Accountant region-scoped)', () => {
    const c = resolveChain(EditProcess.CREATE, PaymentTerms.CASH);
    expect(c.map((s) => s.role)).toEqual([Role.SUPERVISOR, Role.ACCOUNTANT]);
    expect(c.find((s) => s.role === Role.ACCOUNTANT)?.scope).toBe('REGION_OVERLAP');
  });

  it('CREATE + CREDIT → Supervisor → Finance Manager → GM → Accountant', () => {
    const c = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
    expect(c.map((s) => s.role)).toEqual([
      Role.SUPERVISOR,
      Role.FINANCE_MANAGER,
      Role.GM,
      Role.ACCOUNTANT,
    ]);
    // Owner-confirmed: FM + GM are org-wide; Accountant is region-scoped.
    expect(c.find((s) => s.role === Role.FINANCE_MANAGER)?.scope).toBe('GLOBAL');
    expect(c.find((s) => s.role === Role.GM)?.scope).toBe('GLOBAL');
    expect(c.find((s) => s.role === Role.ACCOUNTANT)?.scope).toBe('REGION_OVERLAP');
  });

  it('GM is always present on the credit chain (no threshold skip)', () => {
    const c = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
    expect(c.some((s) => s.role === Role.GM)).toBe(true);
  });
});

describe('canActOnStep', () => {
  const submitter = { id: 'sub', supervisorId: 'sup' };
  const su = (id: string, role: Role) => ({ id, role, username: id });

  it('rejects a role that does not match the step', () => {
    const step = { role: Role.ACCOUNTANT, scope: 'GLOBAL' as const };
    expect(canActOnStep(su('x', Role.FINANCE_MANAGER), step, submitter)).toBe(false);
  });

  it('blocks the submitter from acting on any step (self-approval)', () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    // Even if the submitter holds the step role AND is their own supervisor.
    expect(
      canActOnStep(su('sub', Role.SUPERVISOR), step, { id: 'sub', supervisorId: 'sub' })
    ).toBe(false);
  });

  it('blocks a user who already acted on a DIFFERENT step of the same edit', () => {
    const step = { role: Role.GM, scope: 'GLOBAL' as const };
    expect(canActOnStep(su('u1', Role.GM), step, submitter, { priorStepActorIds: ['u1'] })).toBe(
      false
    );
  });

  it('SUPERVISOR_OF_SUBMITTER: only the submitter own supervisor may act', () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    expect(canActOnStep(su('sup', Role.SUPERVISOR), step, submitter)).toBe(true);
    expect(canActOnStep(su('other', Role.SUPERVISOR), step, submitter)).toBe(false);
  });

  it('SUPERVISOR_OF_SUBMITTER: a region-overlapping Manager may act (RBAC-05-003 fallback)', () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    const branches = [{ regionId: 'r1', deletedAt: null }];
    // Manager whose managed regions overlap a customer branch → allowed.
    expect(
      canActOnStep(su('m', Role.MANAGER), step, submitter, {
        customerBranches: branches,
        managedRegionIds: ['r1'],
      })
    ).toBe(true);
    // Empty managed regions → fail-closed.
    expect(
      canActOnStep(su('m', Role.MANAGER), step, submitter, {
        customerBranches: branches,
        managedRegionIds: [],
      })
    ).toBe(false);
    // Disjoint region → denied.
    expect(
      canActOnStep(su('m', Role.MANAGER), step, submitter, {
        customerBranches: branches,
        managedRegionIds: ['r9'],
      })
    ).toBe(false);
  });

  it('SUPERVISOR_OF_SUBMITTER: a finance role (Accountant) cannot stand in for the Supervisor step', () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    const branches = [{ regionId: 'r1', deletedAt: null }];
    expect(
      canActOnStep(su('a', Role.ACCOUNTANT), step, submitter, {
        customerBranches: branches,
        managedRegionIds: ['r1'],
      })
    ).toBe(false);
  });

  it('REGION_OVERLAP (Accountant): fail-closed on empty regions; requires overlap', () => {
    const step = { role: Role.ACCOUNTANT, scope: 'REGION_OVERLAP' as const };
    const branches = [{ regionId: 'r1', deletedAt: null }];
    expect(
      canActOnStep(su('a', Role.ACCOUNTANT), step, submitter, {
        customerBranches: branches,
        managedRegionIds: [],
      })
    ).toBe(false); // empty scope → denied
    expect(
      canActOnStep(su('a', Role.ACCOUNTANT), step, submitter, {
        customerBranches: branches,
        managedRegionIds: ['r1'],
      })
    ).toBe(true); // overlap → allowed
    expect(
      canActOnStep(su('a', Role.ACCOUNTANT), step, submitter, {
        customerBranches: branches,
        managedRegionIds: ['r9'],
      })
    ).toBe(false); // disjoint → denied
  });

  it('GLOBAL (Finance Manager / GM): any holder of the role may act', () => {
    const fm = { role: Role.FINANCE_MANAGER, scope: 'GLOBAL' as const };
    const gm = { role: Role.GM, scope: 'GLOBAL' as const };
    expect(canActOnStep(su('fm', Role.FINANCE_MANAGER), fm, submitter)).toBe(true);
    expect(canActOnStep(su('gm', Role.GM), gm, submitter)).toBe(true);
  });
});

describe('isFinalStep', () => {
  const credit = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT); // 4 steps
  it('is true only for the last approver step', () => {
    expect(isFinalStep(credit, 0)).toBe(false);
    expect(isFinalStep(credit, 2)).toBe(false);
    expect(isFinalStep(credit, 3)).toBe(true); // Accountant = final
  });
  it('single-step UPDATE: step 0 is final', () => {
    const upd = resolveChain(EditProcess.UPDATE, PaymentTerms.CASH);
    expect(isFinalStep(upd, 0)).toBe(true);
  });
});

describe('resolveRejectTarget (step-back cascade + loop guard)', () => {
  it('rejection at a middle step goes back one step', () => {
    expect(resolveRejectTarget(3, 0)).toEqual({ kind: 'STEP_BACK', toStepIndex: 2 }); // ACC → GM
    expect(resolveRejectTarget(2, 0)).toEqual({ kind: 'STEP_BACK', toStepIndex: 1 }); // GM → FM
    expect(resolveRejectTarget(1, 0)).toEqual({ kind: 'STEP_BACK', toStepIndex: 0 }); // FM → SUP
  });
  it('rejection at the first step returns to the salesman', () => {
    expect(resolveRejectTarget(0, 0)).toEqual({ kind: 'TO_SALESMAN' });
  });
  it('loop guard: a step rejecting twice in one cycle returns to the salesman', () => {
    // e.g. GM (step 2) rejected once already this cycle → 2nd reject bails out.
    expect(resolveRejectTarget(2, 1)).toEqual({ kind: 'TO_SALESMAN' });
    expect(resolveRejectTarget(3, 2)).toEqual({ kind: 'TO_SALESMAN' });
  });
});

describe('parseChain', () => {
  it('returns a frozen chain when present', () => {
    const chain = resolveChain(EditProcess.CREATE, PaymentTerms.CASH);
    expect(parseChain(chain)).toEqual(chain);
  });
  it('falls back to a single Supervisor step for null/empty (legacy rows)', () => {
    expect(parseChain(null).map((s) => s.role)).toEqual([Role.SUPERVISOR]);
    expect(parseChain([]).map((s) => s.role)).toEqual([Role.SUPERVISOR]);
  });
});

describe('stepDeadline', () => {
  it('adds slaHours to the anchor time', () => {
    const from = new Date('2026-07-16T08:00:00.000Z');
    expect(stepDeadline(from, 8).toISOString()).toBe('2026-07-16T16:00:00.000Z');
  });
});
