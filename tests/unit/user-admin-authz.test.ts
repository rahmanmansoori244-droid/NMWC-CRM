/**
 * SR-USR-01 regression — a MANAGER must not be able to administer credit
 * approvers (FINANCE_MANAGER / GM / ACCOUNTANT) or peer admins (MANAGER /
 * STEWARD). Before the fix, canMutateUser only shielded MANAGER/STEWARD, so a
 * Manager could reset/disable/demote/mint an approver and seize the SUP→FM→GM→ACC
 * credit chain (separation-of-duty bypass) or DoS credit onboarding.
 *
 * B2 / SEC-02 (enterprise assessment, 2026-09-14) — VIEWER is an ORG-WIDE read +
 * export role, so a region-scoped Manager minting one was a two-click escalation
 * out of their region. VIEWER is Steward-only now, and every Manager admin action
 * is region-scoped through the pure helpers tested below.
 *
 * Pure functions — no DB. canMutateUser gates toggleActive/resetPassword/
 * updateRole; MANAGER_ADMINISTRABLE_ROLES gates create + role assignment;
 * managerCanAdministerUser / managerCanAssignRoute / managerCanAssignSupervisor
 * gate the regional scope of each.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import {
  canMutateUser,
  MANAGER_ADMINISTRABLE_ROLES,
  managerCanAdministerUser,
  managerCanAssignRoute,
  managerCanAssignSupervisor,
  userRegionIds,
  type UserRegionFootprint,
} from '@/lib/permissions';

const manager = { id: 'mgr-1', role: Role.MANAGER, username: 'mgr' };
const steward = { id: 'stw-1', role: Role.STEWARD, username: 'stw' };
const tgt = (role: Role, id = 'tgt-1') => ({ id, role });

const APPROVERS = [Role.FINANCE_MANAGER, Role.GM, Role.ACCOUNTANT];
const ADMINS = [Role.MANAGER, Role.STEWARD];
const ORG_WIDE_READ = [Role.VIEWER];
const FIELD_FORCE = [Role.SALESMAN, Role.SUPERVISOR];

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

  it('canMutateUser: MANAGER is DENIED on the org-wide VIEWER (B2 / SEC-02)', () => {
    for (const role of ORG_WIDE_READ) {
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

  it('canMutateUser: STEWARD may administer approvers and viewers (the intended provisioning tier)', () => {
    for (const role of [...APPROVERS, ...ORG_WIDE_READ]) {
      expect(canMutateUser(steward, tgt(role)).ok).toBe(true);
    }
  });

  it('MANAGER_ADMINISTRABLE_ROLES is an allowlist of REGIONAL roles only', () => {
    for (const role of [...APPROVERS, ...ADMINS, ...ORG_WIDE_READ]) {
      expect(MANAGER_ADMINISTRABLE_ROLES).not.toContain(role);
    }
    for (const role of FIELD_FORCE) {
      expect(MANAGER_ADMINISTRABLE_ROLES).toContain(role);
    }
  });

  it('every Role is classified — a new Role added to the enum must be triaged, not defaulted open', () => {
    // If this fails, a Role was added to the schema; decide whether a Manager may
    // administer it and add it to MANAGER_ADMINISTRABLE_ROLES (or leave it protected).
    const known = new Set([...FIELD_FORCE, ...APPROVERS, ...ADMINS, ...ORG_WIDE_READ]);
    for (const role of Object.values(Role)) {
      expect(known.has(role as Role), `unclassified Role ${role}`).toBe(true);
    }
  });
});

const fp = (over: Partial<UserRegionFootprint>): UserRegionFootprint => ({
  id: 'u',
  role: Role.SALESMAN,
  ownedRouteRegionId: null,
  teamRegionIds: [],
  managedRegionIds: [],
  ...over,
});

describe('B2 / SEC-02: Manager administration is region-scoped', () => {
  const MCT = 'region-mct';
  const SLL = 'region-sll';

  it('userRegionIds unions route, team and managed regions', () => {
    expect(
      userRegionIds(
        fp({ ownedRouteRegionId: MCT, teamRegionIds: [MCT, SLL], managedRegionIds: [SLL] })
      ).sort()
    ).toEqual([MCT, SLL].sort());
  });

  it('a salesman on a route in MY region is administrable; one in another region is not', () => {
    expect(managerCanAdministerUser([MCT], fp({ ownedRouteRegionId: MCT })).ok).toBe(true);
    const denied = managerCanAdministerUser([MCT], fp({ ownedRouteRegionId: SLL }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/region you do not manage/);
  });

  it('a supervisor is administrable only when EVERY region their team covers is mine', () => {
    expect(
      managerCanAdministerUser([MCT], fp({ role: Role.SUPERVISOR, teamRegionIds: [MCT] })).ok
    ).toBe(true);
    expect(
      managerCanAdministerUser([MCT], fp({ role: Role.SUPERVISOR, teamRegionIds: [MCT, SLL] })).ok
    ).toBe(false);
  });

  it('an account with no regional anchor yet is administrable ONLY by the Manager it reports to', () => {
    // A team-less supervisor or a route-less salesman has no region; without
    // this rule ANY Manager could reset its password and sign in as it.
    const unanchored = fp({ role: Role.SUPERVISOR, supervisorId: 'mgr-1' });
    expect(managerCanAdministerUser([MCT], unanchored, 'mgr-1').ok).toBe(true);
    const other = managerCanAdministerUser([MCT], unanchored, 'mgr-2');
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toMatch(/does not report to you/);
    // no supervisor at all → Steward only
    expect(managerCanAdministerUser([MCT], fp({ role: Role.SUPERVISOR }), 'mgr-1').ok).toBe(false);
    expect(managerCanAdministerUser([MCT], fp({ role: Role.SALESMAN, supervisorId: 'mgr-1' }), 'mgr-1').ok).toBe(true);
  });

  it('fails closed: a Manager with no regions administers nobody', () => {
    const r = managerCanAdministerUser([], fp({ ownedRouteRegionId: MCT }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no managed regions/);
  });

  it('never administers VIEWER / approver / admin roles regardless of region', () => {
    for (const role of [...ORG_WIDE_READ, ...APPROVERS, ...ADMINS]) {
      expect(managerCanAdministerUser([MCT], fp({ role, ownedRouteRegionId: MCT })).ok).toBe(false);
    }
  });

  it('routes: only routes in a managed region can be assigned', () => {
    expect(managerCanAssignRoute([MCT], MCT)).toBe(true);
    expect(managerCanAssignRoute([MCT], SLL)).toBe(false);
    expect(managerCanAssignRoute([], MCT)).toBe(false);
  });

  it('supervisors: self always; peer Manager only with a shared region; Supervisor only inside my regions', () => {
    const me = 'mgr-1';
    expect(managerCanAssignSupervisor(me, [MCT], fp({ id: me, role: Role.MANAGER }))).toBe(true);
    expect(
      managerCanAssignSupervisor(me, [MCT], fp({ id: 'mgr-2', role: Role.MANAGER, managedRegionIds: [MCT, SLL] }))
    ).toBe(true);
    expect(
      managerCanAssignSupervisor(me, [MCT], fp({ id: 'mgr-3', role: Role.MANAGER, managedRegionIds: [SLL] }))
    ).toBe(false);
    expect(
      managerCanAssignSupervisor(me, [MCT], fp({ id: 'sup-1', role: Role.SUPERVISOR, teamRegionIds: [MCT] }))
    ).toBe(true);
    expect(
      managerCanAssignSupervisor(me, [MCT], fp({ id: 'sup-2', role: Role.SUPERVISOR, teamRegionIds: [SLL] }))
    ).toBe(false);
    // a salesman or viewer can never be a supervisor
    expect(managerCanAssignSupervisor(me, [MCT], fp({ id: 'x', role: Role.SALESMAN }))).toBe(false);
    // self is allowed even before regions are assigned; anyone else is not
    expect(managerCanAssignSupervisor(me, [], fp({ id: me, role: Role.MANAGER }))).toBe(true);
    expect(managerCanAssignSupervisor(me, [], fp({ id: 'sup-1', role: Role.SUPERVISOR }))).toBe(false);
  });
});
