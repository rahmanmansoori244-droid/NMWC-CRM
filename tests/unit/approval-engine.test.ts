/**
 * Phase 1b: approval-chain matrix + step-authorization unit tests.
 */
import { describe, it, expect } from 'vitest';
import { Role, PaymentTerms, EditProcess } from '@prisma/client';
import {
  CHAIN_VERSION,
  DECISION_FORM_UPLOADED,
  resolveChain,
  isFinalStep,
  isSignedFormStep,
  hasSignedFormStep,
  signedFormStepIndex,
  resolveRejectTarget,
  parseChain,
  stepDeadline,
  stepName,
} from '@/lib/approval-chains';
import { STAGE_SLA_MINUTES } from '@/lib/working-hours';
import { canActOnStep } from '@/lib/permissions';
import { LEGACY_CREDIT_CHAIN } from '../support/legacy-chain';

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

  it('CREATE + CREDIT → Supervisor → Sales Director → signed application → Finance Manager → GM → Accountant (owner decisions 2026-10-11)', () => {
    const c = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
    expect(c.map((s) => [s.role, s.scope])).toEqual([
      [Role.SUPERVISOR, 'SUPERVISOR_OF_SUBMITTER'],
      [Role.SALES_DIRECTOR, 'GLOBAL'],
      [Role.SALESMAN, 'SUBMITTER'],
      [Role.FINANCE_MANAGER, 'GLOBAL'],
      [Role.GM, 'GLOBAL'],
      [Role.ACCOUNTANT, 'REGION_OVERLAP'],
    ]);
    // The budgets frozen on the request: the signed application's is 3 working
    // days (owner-confirmed), the Sales Director's a placeholder like the FM's.
    expect(c[2]!.slaHours * 60).toBe(STAGE_SLA_MINUTES[Role.SALESMAN]);
    expect(c[1]!.slaHours * 60).toBe(STAGE_SLA_MINUTES[Role.SALES_DIRECTOR]);
    expect(CHAIN_VERSION).toBe(2);
  });

  it('CASH and UPDATE chains are unchanged by the credit decisions', () => {
    expect(resolveChain(EditProcess.CREATE, PaymentTerms.CASH).map((s) => s.scope)).toEqual([
      'SUPERVISOR_OF_SUBMITTER',
      'REGION_OVERLAP',
    ]);
    expect(hasSignedFormStep(resolveChain(EditProcess.CREATE, PaymentTerms.CASH))).toBe(false);
    expect(hasSignedFormStep(resolveChain(EditProcess.UPDATE, PaymentTerms.CREDIT))).toBe(false);
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

  it('GLOBAL (Sales Director): any Sales Director, no region needed; nobody else (owner decisions 2026-10-11)', () => {
    const sd = { role: Role.SALES_DIRECTOR, scope: 'GLOBAL' as const };
    expect(canActOnStep(su('sd', Role.SALES_DIRECTOR), sd, submitter)).toBe(true);
    expect(canActOnStep(su('sd', Role.SALES_DIRECTOR), sd, submitter, { managedRegionIds: [] })).toBe(true);
    for (const role of [Role.GM, Role.FINANCE_MANAGER, Role.MANAGER, Role.SUPERVISOR, Role.STEWARD]) {
      expect(canActOnStep(su('x', role), sd, submitter, { managedRegionIds: ['g1'] }), role).toBe(false);
    }
    // Separation of duty: the Sales Director who approved cannot then act as the FM, and so on.
    const fm = { role: Role.FINANCE_MANAGER, scope: 'GLOBAL' as const };
    expect(canActOnStep(su('fm', Role.FINANCE_MANAGER), fm, submitter, { priorStepActorIds: ['fm'] })).toBe(false);
  });

  it('SUBMITTER (the signed application): nobody acts on it — not the salesman, not any approver', () => {
    const step = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT)[2]!;
    expect(step.scope).toBe('SUBMITTER');
    // The submitter never approves; every other role is refused too.
    expect(canActOnStep(su('sub', Role.SALESMAN), step, submitter)).toBe(false);
    for (const role of Object.values(Role)) {
      expect(
        canActOnStep(su(`u-${role}`, role), step, submitter, {
          customerBranches: [{ regionId: 'g1', deletedAt: null }],
          managedRegionIds: ['g1'],
        }),
        role
      ).toBe(false);
    }
    // The submitter's own supervisor, the region's Manager: still no.
    expect(canActOnStep(su('sup', Role.SUPERVISOR), step, submitter)).toBe(false);
  });
});

describe('the signed-application step helpers (owner decisions 2026-10-11)', () => {
  const credit = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
  it('finds the step by its scope, on the new chain only', () => {
    expect(signedFormStepIndex(credit)).toBe(2);
    expect(isSignedFormStep(credit[2])).toBe(true);
    expect(credit.filter((s) => isSignedFormStep(s))).toHaveLength(1);
    expect(isSignedFormStep(undefined)).toBe(false);
    // A credit request frozen before the decisions has no such step.
    expect(signedFormStepIndex(LEGACY_CREDIT_CHAIN)).toBe(-1);
    expect(hasSignedFormStep(parseChain(LEGACY_CREDIT_CHAIN))).toBe(false);
  });

  it('names every step in words, never the enum', () => {
    expect(credit.map((s) => stepName(s))).toEqual([
      'Supervisor',
      'Sales Director',
      'Signed application',
      'Finance Manager',
      'GM',
      'Accountant',
    ]);
    // A bare pendingRole reads as the step it holds; null is a deploy-gap Supervisor row.
    expect(stepName('SALESMAN')).toBe('Signed application');
    expect(stepName(null)).toBe('Supervisor');
    expect(stepName('MANAGER')).toBe('Manager');
    expect(DECISION_FORM_UPLOADED).toBe('FORM_UPLOADED');
  });
});

describe('isFinalStep', () => {
  const credit = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT); // 6 steps
  it('is true only for the last approver step', () => {
    expect(isFinalStep(credit, 0)).toBe(false);
    expect(isFinalStep(credit, 2)).toBe(false); // the signed application
    expect(isFinalStep(credit, 4)).toBe(false); // GM
    expect(isFinalStep(credit, 5)).toBe(true); // Accountant = final
    // A request frozen with the 4-step chain keeps its own final step.
    expect(isFinalStep(LEGACY_CREDIT_CHAIN, 3)).toBe(true);
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
  it('the owner’s credit cascade (2026-10-11) falls out of the index rule', () => {
    const credit = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
    const back = (i: number) => {
      const t = resolveRejectTarget(i, 0);
      return t.kind === 'STEP_BACK' ? stepName(credit[t.toStepIndex]) : 'salesman (Needs correction)';
    };
    expect(back(0)).toBe('salesman (Needs correction)'); // Supervisor
    expect(back(1)).toBe('Supervisor'); // Sales Director
    expect(back(3)).toBe('Signed application'); // Finance Manager: he uploads it again
    expect(back(4)).toBe('Finance Manager'); // GM
    expect(back(5)).toBe('GM'); // Accountant
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
  it('adds slaHours of WORKING time (Asia/Muscat calendar, Fri+Sat off)', () => {
    // 2026-07-16T08:00Z = Thursday 12:00 Oman. 8 working hours = 5h left
    // Thursday (12:00→17:00) + Fri+Sat OFF + 3h Sunday → Sun 11:00 Oman
    // (07:00 UTC). Deep coverage lives in tests/unit/working-hours.test.ts.
    const from = new Date('2026-07-16T08:00:00.000Z');
    expect(stepDeadline(from, 8).toISOString()).toBe('2026-07-19T07:00:00.000Z');
  });
});
