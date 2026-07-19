/**
 * SR-USR-01 regression — a MANAGER must not be able to administer credit
 * approvers (FINANCE_MANAGER / GM / ACCOUNTANT) or peer admins (MANAGER /
 * STEWARD). Before the fix, canMutateUser only shielded MANAGER/STEWARD, so a
 * Manager could reset/disable/demote/mint an approver and seize the SUP→FM→GM→ACC
 * credit chain (separation-of-duty bypass) or DoS credit onboarding.
 *
 * Pure functions — no DB. canMutateUser gates toggleActive/resetPassword/
 * updateRole; MANAGER_ADMINISTRABLE_ROLES gates create + role assignment.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { canMutateUser, MANAGER_ADMINISTRABLE_ROLES } from '@/lib/permissions';

const manager = { id: 'mgr-1', role: Role.MANAGER, username: 'mgr' };
const steward = { id: 'stw-1', role: Role.STEWARD, username: 'stw' };
const tgt = (role: Role, id = 'tgt-1') => ({ id, role });

const APPROVERS = [Role.FINANCE_MANAGER, Role.GM, Role.ACCOUNTANT];
const ADMINS = [Role.MANAGER, Role.STEWARD];
const FIELD_FORCE = [Role.SALESMAN, Role.SUPERVISOR, Role.VIEWER];

describe('SR-USR-01: Manager cannot administer approvers or admins', () => {
  it('canMutateUser: MANAGER is DENIED on every credit approver', () => {
    for (const role of APPROVERS) {
      const r = canMutateUser(manager, tgt(role));
      expect(r.ok, `manager should not mutate ${role}`).toBe(false);
    }
  });

  it('canMutateUser: MANAGER is DENIED on peer MANAGER/STEWARD', () => {
    for (const role of ADMINS) {
      expect(canMutateUser(manager, tgt(role)).ok).toBe(false);
    }
  });

  it('canMutateUser: MANAGER is ALLOWED on field-force roles', () => {
    for (const role of FIELD_FORCE) {
      expect(canMutateUser(manager, tgt(role)).ok, `manager should manage ${role}`).toBe(true);
    }
  });

  it('canMutateUser: MANAGER still cannot mutate itself', () => {
    expect(canMutateUser(manager, { id: manager.id, role: Role.MANAGER }).ok).toBe(false);
  });

  it('canMutateUser: STEWARD may administer approvers (the intended provisioning tier)', () => {
    for (const role of APPROVERS) {
      expect(canMutateUser(steward, tgt(role)).ok).toBe(true);
    }
  });

  it('MANAGER_ADMINISTRABLE_ROLES is an allowlist that excludes approvers + admins', () => {
    for (const role of [...APPROVERS, ...ADMINS]) {
      expect(MANAGER_ADMINISTRABLE_ROLES).not.toContain(role);
    }
    for (const role of FIELD_FORCE) {
      expect(MANAGER_ADMINISTRABLE_ROLES).toContain(role);
    }
  });

  it('every Role is classified — a new Role added to the enum must be triaged, not defaulted open', () => {
    // If this fails, a Role was added to the schema; decide whether a Manager may
    // administer it and add it to MANAGER_ADMINISTRABLE_ROLES (or leave it protected).
    const known = new Set([...FIELD_FORCE, ...APPROVERS, ...ADMINS]);
    for (const role of Object.values(Role)) {
      expect(known.has(role as Role), `unclassified Role ${role}`).toBe(true);
    }
  });
});
