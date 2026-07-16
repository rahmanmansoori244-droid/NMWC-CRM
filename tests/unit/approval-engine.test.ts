/**
 * Phase 1b: approval-chain matrix + step-authorization unit tests.
 */
import { describe, it, expect } from 'vitest';
import { Role, PaymentTerms, EditProcess } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
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
