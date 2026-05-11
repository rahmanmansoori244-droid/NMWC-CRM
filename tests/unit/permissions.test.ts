import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import {
  isFieldLocked,
  canApproveSpecificEdit,
  canManageUsers,
  canImport,
  canExport,
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
});

describe('lib/permissions — approval scope', () => {
  it('Manager can approve only edits whose customer overlaps their managed regions', () => {
    // Customer with branches in regions [r1, r2]; Manager managing [r1].
    expect(
      canApproveSpecificEdit(
        { id: 'm1', role: Role.MANAGER, username: 'm' },
        { id: 'submitter', supervisorId: 'someoneelse' },
        {
          customerBranches: [
            { regionId: 'r1', deletedAt: null },
            { regionId: 'r2', deletedAt: null },
          ],
          managedRegionIds: ['r1'],
        }
      )
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
