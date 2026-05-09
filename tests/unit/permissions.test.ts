import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import {
  isFieldLocked,
  canApproveSpecificEdit,
  canManageUsers,
  canImport,
  canExport,
} from '@/lib/permissions';

describe('lib/permissions — Cash/Credit field lock', () => {
  const credit = { paymentTerms: 'CREDIT' as const };
  const cash = { paymentTerms: 'CASH' as const };

  it('Salesman cannot edit name/CR on Credit customers', () => {
    expect(
      isFieldLocked(
        'legalName',
        { id: 'u1', role: Role.SALESMAN, username: 's' },
        credit
      )
    ).toBe(true);
    expect(
      isFieldLocked(
        'crNumber',
        { id: 'u1', role: Role.SALESMAN, username: 's' },
        credit
      )
    ).toBe(true);
  });

  it('Salesman CAN edit on Cash customers', () => {
    expect(
      isFieldLocked(
        'legalName',
        { id: 'u1', role: Role.SALESMAN, username: 's' },
        cash
      )
    ).toBe(false);
  });

  it('Steward bypasses the lock', () => {
    expect(
      isFieldLocked(
        'legalName',
        { id: 'u1', role: Role.STEWARD, username: 's' },
        credit
      )
    ).toBe(false);
  });

  it('Other roles see no lock (they don\'t edit anyway, gated elsewhere)', () => {
    expect(
      isFieldLocked(
        'legalName',
        { id: 'u1', role: Role.SUPERVISOR, username: 's' },
        credit
      )
    ).toBe(false);
  });
});

describe('lib/permissions — approval scope', () => {
  it('Manager can approve any edit', () => {
    expect(
      canApproveSpecificEdit(
        { id: 'm1', role: Role.MANAGER, username: 'm' },
        { supervisorId: 'someoneelse' }
      )
    ).toBe(true);
  });
  it('Supervisor can approve only their own team\'s edits', () => {
    expect(
      canApproveSpecificEdit(
        { id: 'sup1', role: Role.SUPERVISOR, username: 's' },
        { supervisorId: 'sup1' }
      )
    ).toBe(true);
    expect(
      canApproveSpecificEdit(
        { id: 'sup1', role: Role.SUPERVISOR, username: 's' },
        { supervisorId: 'sup2' }
      )
    ).toBe(false);
  });
  it('Salesman / Steward / Viewer cannot approve', () => {
    for (const r of [Role.SALESMAN, Role.STEWARD, Role.VIEWER]) {
      expect(
        canApproveSpecificEdit({ id: 'x', role: r, username: 'x' }, { supervisorId: null })
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
