import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import {
  isFieldLocked,
  canApproveSpecificEdit,
  canManageUsers,
  canImport,
  canExport,
  requestScopeBranches,
} from '@/lib/permissions';

describe('lib/permissions — Salesman field locks', () => {
  const credit = { paymentTerms: 'CREDIT' as const };
  const cash = { paymentTerms: 'CASH' as const };
  const salesman = { id: 'u1', role: Role.SALESMAN, username: 's' };
  const steward = { id: 'u2', role: Role.STEWARD, username: 'st' };
  const supervisor = { id: 'u3', role: Role.SUPERVISOR, username: 'sup' };

  it('Salesman cannot edit legalName on Credit customers', () => {
    expect(isFieldLocked('legalName', salesman, credit)).toBe(true);
  });

  it('Salesman cannot edit legalName on Cash customers either (2026-05-11)', () => {
    expect(isFieldLocked('legalName', salesman, cash)).toBe(true);
  });

  it('Salesman cannot edit nmwcCode on any customer (always locked)', () => {
    expect(isFieldLocked('nmwcCode', salesman, cash)).toBe(true);
    expect(isFieldLocked('nmwcCode', salesman, credit)).toBe(true);
  });

  it('Salesman cannot edit crNumber on Credit customers', () => {
    expect(isFieldLocked('crNumber', salesman, credit)).toBe(true);
    expect(isFieldLocked('crNumberNorm', salesman, credit)).toBe(true);
  });

  it('Salesman CAN edit crNumber on Cash customers (may field-collect)', () => {
    expect(isFieldLocked('crNumber', salesman, cash)).toBe(false);
    expect(isFieldLocked('crNumberNorm', salesman, cash)).toBe(false);
  });

  it('Steward bypasses every lock', () => {
    expect(isFieldLocked('legalName', steward, credit)).toBe(false);
    expect(isFieldLocked('nmwcCode', steward, cash)).toBe(false);
    expect(isFieldLocked('crNumber', steward, credit)).toBe(false);
  });

  it('Other roles see no lock (they edit through different flows)', () => {
    expect(isFieldLocked('legalName', supervisor, credit)).toBe(false);
    expect(isFieldLocked('crNumber', supervisor, credit)).toBe(false);
  });

  it('owner decision 2 (2026-10-07): the CR document follows the CR number — a salesman, on CREDIT only', () => {
    expect(isFieldLocked('crPhoto', salesman, credit)).toBe(true);
    expect(isFieldLocked('crPhoto', salesman, cash)).toBe(false);
    expect(isFieldLocked('crPhoto', steward, credit)).toBe(false);
    expect(isFieldLocked('crPhoto', { id: 'm', role: Role.MANAGER, username: 'm' }, credit)).toBe(false);
  });
});

describe('lib/permissions — approval scope', () => {
  it('owner decision 3: a Manager must manage the region of EVERY branch of the request’s scope', () => {
    // A request about branches in regions [r1, r2]; Manager managing [r1]. It
    // was enough that one branch overlapped.
    const twoRegions = {
      customerBranches: [
        { regionId: 'r1', deletedAt: null },
        { regionId: 'r2', deletedAt: null },
      ],
    };
    const m1 = { id: 'm1', role: Role.MANAGER, username: 'm' };
    const submitter = { id: 'submitter', supervisorId: 'someoneelse' };
    expect(canApproveSpecificEdit(m1, submitter, { ...twoRegions, managedRegionIds: ['r1'] })).toBe(false);
    expect(canApproveSpecificEdit(m1, submitter, { ...twoRegions, managedRegionIds: ['r1', 'r2'] })).toBe(true);
    // A deleted branch is not in the scope.
    expect(
      canApproveSpecificEdit(m1, submitter, {
        customerBranches: [
          { regionId: 'r1', deletedAt: null },
          { regionId: 'r2', deletedAt: new Date() },
        ],
        managedRegionIds: ['r1'],
      })
    ).toBe(true);
  });
  it('Manager cannot approve out-of-region edits (RBAC-05-003)', () => {
    expect(
      canApproveSpecificEdit(
        { id: 'm1', role: Role.MANAGER, username: 'm' },
        { id: 'submitter', supervisorId: 'someoneelse' },
        {
          customerBranches: [{ regionId: 'r2', deletedAt: null }],
          managedRegionIds: ['r1'],
        }
      )
    ).toBe(false);
  });
  it('Manager with no managed regions cannot approve (fail-closed)', () => {
    expect(
      canApproveSpecificEdit(
        { id: 'm1', role: Role.MANAGER, username: 'm' },
        { id: 'submitter', supervisorId: null },
        { customerBranches: [{ regionId: 'r1', deletedAt: null }], managedRegionIds: [] }
      )
    ).toBe(false);
  });
  it('No one can self-approve (EL-15)', () => {
    expect(
      canApproveSpecificEdit(
        { id: 'm1', role: Role.MANAGER, username: 'm' },
        { id: 'm1', supervisorId: null },
        {
          customerBranches: [{ regionId: 'r1', deletedAt: null }],
          managedRegionIds: ['r1'],
        }
      )
    ).toBe(false);
  });
  it('Supervisor can approve only their own team\'s edits', () => {
    expect(
      canApproveSpecificEdit(
        { id: 'sup1', role: Role.SUPERVISOR, username: 's' },
        { id: 'sub1', supervisorId: 'sup1' }
      )
    ).toBe(true);
    expect(
      canApproveSpecificEdit(
        { id: 'sup1', role: Role.SUPERVISOR, username: 's' },
        { id: 'sub1', supervisorId: 'sup2' }
      )
    ).toBe(false);
  });
  it('Salesman / Steward / Viewer cannot approve', () => {
    for (const r of [Role.SALESMAN, Role.STEWARD, Role.VIEWER]) {
      expect(
        canApproveSpecificEdit(
          { id: 'x', role: r, username: 'x' },
          { id: 'sub1', supervisorId: null }
        )
      ).toBe(false);
    }
  });
});

describe('lib/permissions — role gates', () => {
  it('canManageUsers: only Manager', () => {
    for (const r of [Role.SALESMAN, Role.SUPERVISOR, Role.STEWARD, Role.VIEWER]) {
      expect(canManageUsers({ id: 'x', role: r, username: 'x' })).toBe(false);
    }
    expect(canManageUsers({ id: 'x', role: Role.MANAGER, username: 'x' })).toBe(true);
  });
  it('canImport: only Steward', () => {
    expect(canImport({ id: 'x', role: Role.STEWARD, username: 'x' })).toBe(true);
    expect(canImport({ id: 'x', role: Role.MANAGER, username: 'x' })).toBe(false);
  });
  it('canExport: Manager / Steward / Viewer / Supervisor', () => {
    expect(canExport({ id: 'x', role: Role.SALESMAN, username: 'x' })).toBe(false);
    expect(canExport({ id: 'x', role: Role.SUPERVISOR, username: 'x' })).toBe(true);
    expect(canExport({ id: 'x', role: Role.MANAGER, username: 'x' })).toBe(true);
    expect(canExport({ id: 'x', role: Role.STEWARD, username: 'x' })).toBe(true);
    expect(canExport({ id: 'x', role: Role.VIEWER, username: 'x' })).toBe(true);
  });
});

describe('lib/permissions — requestScopeBranches (owner decision 3, 2026-10-07)', () => {
  // A customer with B1 (route t1, region r1, the submitter's), B2 (route t2,
  // region r2) and B0 (route t2, region r2: the lowest id).
  const b = (id: string, routeId: string, regionId: string, deletedAt: Date | null = null) => ({ id, routeId, regionId, deletedAt });
  const branches = [b('b1', 't1', 'r1'), b('b2', 't2', 'r2'), b('b0', 't2', 'r2')];
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
  const change = (field: string) => ({ field, before: null, after: 'x' });

  it('a branch-only request: the branches it changes, nothing else', () => {
    expect(ids(requestScopeBranches({ branches, fieldChanges: [change('branch.b2.openingHours')], homeBranchIds: ['b1'] }))).toEqual(['b2']);
  });

  it('a customer-level change adds its home: the submitter’s branch frozen at submit', () => {
    expect(ids(requestScopeBranches({ branches, fieldChanges: [change('customer.notes')], homeBranchIds: ['b1'] }))).toEqual(['b1']);
    expect(
      ids(requestScopeBranches({ branches, fieldChanges: [change('customer.notes'), change('branch.b2.address')], homeBranchIds: ['b1'] }))
    ).toEqual(['b2', 'b1']);
  });

  it('a close request is about its own branch', () => {
    expect(ids(requestScopeBranches({ branches, fieldChanges: [change('branch.b2.status')], branchId: 'b2', homeBranchIds: null }))).toEqual(['b2']);
  });

  it('no usable record: the submitter’s route now, else the customer’s first branch by id — one home, never two regions', () => {
    const notes = [change('customer.notes')];
    expect(ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: ['gone'], submitterRouteId: 't1' }))).toEqual(['b1']);
    expect(ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: null, submitterRouteId: 't9' }))).toEqual(['b0']);
    // The frozen home is one branch even when he had several.
    expect(ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: ['b2', 'b0'] }))).toEqual(['b0']);
  });

  it('no usable record and a salesman moved to a route with no branch of it: his route’s region now, not the first branch', () => {
    // Moved to route t7 in region r1: the customer's first branch by id (b0) is
    // in r2, but the change belongs to r1, where he works now.
    const notes = [change('customer.notes')];
    expect(
      ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: null, submitterRouteId: 't7', submitterRegionId: 'r1' }))
    ).toEqual(['b1']);
    // A frozen home, or a branch on his route now, still comes first.
    expect(
      ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: ['b2'], submitterRouteId: 't7', submitterRegionId: 'r1' }))
    ).toEqual(['b2']);
    expect(
      ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: null, submitterRouteId: 't2', submitterRegionId: 'r1' }))
    ).toEqual(['b0']);
    // A region with no branch of this customer: the first branch, so the request can still be decided.
    expect(
      ids(requestScopeBranches({ branches, fieldChanges: notes, homeBranchIds: null, submitterRouteId: 't7', submitterRegionId: 'r8' }))
    ).toEqual(['b0']);
  });

  it('a changed branch deleted since is not in it; a request naming no live branch takes its home', () => {
    const withDeleted = [...branches, b('b9', 't1', 'r9', new Date())];
    expect(ids(requestScopeBranches({ branches: withDeleted, fieldChanges: [change('branch.b9.address')], homeBranchIds: ['b1'] }))).toEqual(['b1']);
  });

  it('a customer with no live branch has no scope (and so no Manager decides it)', () => {
    expect(requestScopeBranches({ branches: [b('b1', 't1', 'r1', new Date())], fieldChanges: [change('customer.notes')] })).toEqual([]);
  });
});
