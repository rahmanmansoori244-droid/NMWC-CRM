'use server';

import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { requireActor } from '@/lib/session';
import { assertPasswordNotReused, passwordRule, rotatePasswordHistory } from '@/lib/password-policy';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import {
  canMutateUser,
  MANAGER_ADMINISTRABLE_ROLES,
  managerCanAdministerUser,
  managerCanAssignRoute,
  managerCanAssignSupervisor,
  type UserRegionFootprint,
} from '@/lib/permissions';
import { loadScope } from '@/lib/access';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

// User administration is a MANAGER or STEWARD action. A MANAGER is capped at the
// field force (MANAGER_ADMINISTRABLE_ROLES); a STEWARD is the org data-admin and
// is the ONLY role that may provision the approver tier (ACCOUNTANT/FINANCE_MANAGER/
// GM) and peer admins — which is exactly the SR-USR-01 separation-of-duty split.
// Before this, `requireManager` blocked STEWARD too, so the approver tier the
// create-approval chains REQUIRE had NO in-app provisioning path and every net-new
// customer CREATE stalled forever at the Accountant step. The per-actor allowlist
// lives in canMutateUser + the create/role-change guards below.
async function requireUserAdmin() {
  const user = await requireActor(); // F15: refuses a session that must change its password
  if (user.role !== Role.MANAGER && user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only Managers or Stewards can manage users.');
  }
  return user;
}

// Go-live: salesmen sign in with their ROUTE CODE, and codes like "C4" or "W" are
// shorter than three characters. Trimmed first, in step with the two sign-in
// schemas (app/actions/auth.ts, lib/auth.ts): a stored username never carries
// the spaces a sign-in strips.
const usernameRule = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9._-]+$/, 'lowercase letters, digits, dot, underscore, hyphen only');

const createUserSchema = z.object({
  username: usernameRule,
  fullName: z.string().min(2).max(200),
  role: z.nativeEnum(Role),
  email: z
    .string()
    .email()
    .max(200)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  phone: z
    .string()
    .max(50)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  password: passwordRule,
  supervisorId: z
    .string()
    .cuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  ownedRouteId: z
    .string()
    .cuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/**
 * AUTH-03 / RBAC-05-006: a Manager may NOT create another MANAGER or
 * STEWARD via this UI. Admin-tier creation requires Steward (out-of-band).
 * AUTH-06: validate supervisorId actually points at an active SUPERVISOR.
 * AUTH-10: pre-check username uniqueness with friendly error.
 */
export async function createUserAction(formData: FormData): SafeAction<void> {
  return runAction(() => createUserCore(formData));
}

/**
 * B2 / SEC-02: the regional anchor of a user, for Manager-scoped administration
 * (see lib/permissions.ts managerCanAdministerUser).
 */
async function footprintOf(userId: string): Promise<UserRegionFootprint | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      supervisorId: true,
      ownedRoute: { select: { regionId: true } },
      reports: { select: { ownedRoute: { select: { regionId: true } } } },
      managedRegions: { select: { id: true } },
    },
  });
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    supervisorId: u.supervisorId,
    ownedRouteRegionId: u.ownedRoute?.regionId ?? null,
    teamRegionIds: [
      ...new Set(
        u.reports.map((r) => r.ownedRoute?.regionId).filter((r): r is string => !!r)
      ),
    ],
    managedRegionIds: u.managedRegions.map((r) => r.id),
  };
}

/**
 * B2 / SEC-02: a MANAGER may only administer accounts anchored inside the
 * regions they manage (fail-closed on no regions). STEWARD is org-wide.
 */
async function assertManagerScopeOverTarget(
  me: { id: string; role: Role },
  targetId: string
): Promise<void> {
  if (me.role !== Role.MANAGER) return;
  const [scope, target] = await Promise.all([loadScope(me.id), footprintOf(targetId)]);
  if (!target) throw new NotFoundError('User not found.');
  const verdict = managerCanAdministerUser(scope.managedRegionIds, target, me.id);
  if (!verdict.ok) throw new ForbiddenError(verdict.reason);
}

/**
 * The form field a unique clash on create belongs to, from the P2002's
 * `meta.target` (the column names, or on some engines the constraint's name, such
 * as User_email_key). Three User columns are unique:
 *   - username: another admin's create raced this one past the pre-check;
 *   - email: nothing pre-checks it, and the users listing hides e-mails, so the
 *     Email field is the only place the admin can learn which value to change;
 *   - ownedRouteId: two creates raced for one route past its pre-check.
 * Every clash used to be reported as "Username already taken.", under a username
 * nobody held, and every other username then failed the same way.
 *
 * Not a server action: this module's exports are, so it is not exported.
 */
function createClashFields(err: unknown): Record<string, string> {
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const names = (Array.isArray(target) ? target : [target]).filter(
    (t): t is string => typeof t === 'string'
  );
  const hit = (column: string) => names.some((n) => n === column || n.includes(`_${column}_`));
  if (hit('email')) return { email: 'That e-mail is already used by another account.' };
  if (hit('ownedRouteId')) {
    return { ownedRouteId: 'That route is already assigned to another salesman.' };
  }
  if (hit('username')) return { username: 'Username already taken.' };
  return {
    _form: 'Another account already has this username, e-mail or route. Change it and try again.',
  };
}

async function createUserCore(formData: FormData) {
  const me = await requireUserAdmin();
  const parsed = createUserSchema.safeParse({
    username: String(formData.get('username') ?? '')
      .toLowerCase()
      .trim(),
    fullName: formData.get('fullName'),
    role: formData.get('role'),
    email: formData.get('email') ?? undefined,
    phone: formData.get('phone') ?? undefined,
    password: formData.get('password'),
    supervisorId: formData.get('supervisorId') ?? undefined,
    ownedRouteId: formData.get('ownedRouteId') ?? undefined,
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError(fields);
  }
  const data = parsed.data;

  // AUTH-03 / RBAC-05-006 / SR-USR-01: cap MANAGER-driven creation at the field
  // force so a Manager cannot mint an approver and seize the credit chain
  // (separation-of-duty bypass). A STEWARD is the org data-admin and IS the
  // Steward path this rule always assumed — it may create any role, including the
  // approver tier (FINANCE_MANAGER/GM/ACCOUNTANT) the create chains require.
  if (me.role === Role.MANAGER && !MANAGER_ADMINISTRABLE_ROLES.includes(data.role)) {
    throw new ValidationError({
      role: 'A Manager can only create Salesman/Supervisor accounts — ask a Steward to provision Viewer, approver or admin-tier accounts.',
    });
  }

  if (data.role === Role.SALESMAN && !data.ownedRouteId) {
    throw new ValidationError({ ownedRouteId: 'A salesman must be assigned to a route.' });
  }
  if (data.role !== Role.SALESMAN && data.ownedRouteId) {
    throw new ValidationError({
      ownedRouteId: 'Only salesmen own a route. Clear this field for other roles.',
    });
  }

  // B2 / SEC-02: a Manager creates accounts INSIDE their regions only — the
  // route must be in a managed region and the supervisor must be themself, a
  // peer Manager sharing a region, or a Supervisor whose team sits in their
  // regions. Fail-closed when the Manager has no regions. (A Steward is
  // org-wide.) The UI narrows the dropdowns to the same sets; this is the
  // server-side truth a hand-crafted form post cannot bypass.
  const managerScope = me.role === Role.MANAGER ? await loadScope(me.id) : null;
  if (managerScope && managerScope.managedRegionIds.length === 0) {
    throw new ForbiddenError('You have no managed regions assigned — ask a Steward.');
  }
  if (managerScope && data.ownedRouteId) {
    const route = await prisma.route.findUnique({
      where: { id: data.ownedRouteId },
      select: { regionId: true },
    });
    if (!route || !managerCanAssignRoute(managerScope.managedRegionIds, route.regionId)) {
      throw new ValidationError({
        ownedRouteId: 'That route is not in a region you manage.',
      });
    }
  }

  // AUTH-06: supervisorId must resolve to an active SUPERVISOR (or MANAGER
  // for Salesman who reports up the management ladder); the UI dropdown
  // already filters this but a hand-crafted form post can submit anything.
  if (data.supervisorId) {
    const sup = await prisma.user.findUnique({
      where: { id: data.supervisorId },
      select: { role: true, isActive: true },
    });
    if (!sup || !sup.isActive) {
      throw new ValidationError({ supervisorId: 'Supervisor must exist and be active.' });
    }
    if (sup.role !== Role.SUPERVISOR && sup.role !== Role.MANAGER) {
      throw new ValidationError({
        supervisorId: 'supervisorId must point at a SUPERVISOR or MANAGER.',
      });
    }
    if (managerScope) {
      const supFootprint = await footprintOf(data.supervisorId);
      if (
        !supFootprint ||
        !managerCanAssignSupervisor(me.id, managerScope.managedRegionIds, supFootprint)
      ) {
        throw new ValidationError({
          supervisorId: 'That supervisor is outside the regions you manage.',
        });
      }
    }
  }

  // AUTH-10: friendly username uniqueness pre-check.
  const dup = await prisma.user.findUnique({
    where: { username: data.username },
    select: { id: true },
  });
  if (dup) {
    throw new ValidationError({ username: 'Username already taken.' });
  }

  // Route uniqueness (1 salesman per route)
  if (data.ownedRouteId) {
    const existing = await prisma.user.findUnique({ where: { ownedRouteId: data.ownedRouteId } });
    if (existing) {
      throw new ValidationError({
        ownedRouteId: 'That route is already assigned to another salesman.',
      });
    }
  }

  const passwordHash = await bcrypt.hash(data.password, 12);
  // F13: the account and its audit row commit together, or neither does — the
  // audit row is the only record of who created it. The envelope is read first
  // so the transaction holds only the two writes.
  const env = await getAuditEnvelope(me.id);
  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username: data.username,
          passwordHash,
          fullName: data.fullName,
          role: data.role,
          email: data.email ?? null,
          phone: data.phone ?? null,
          supervisorId: data.supervisorId ?? null,
          ownedRouteId: data.ownedRouteId ?? null,
          // AUTH-09: every newly-created account must change its password on
          // first login so the Manager-typed password isn't a permanent one.
          mustChangePassword: true,
        },
      });
      await writeAudit(tx, env, {
        action: 'CREATE',
        entityType: 'User',
        entityId: created.id,
        after: { username: created.username, role: created.role },
      });
      return created;
    });
  } catch (err) {
    // A unique value another account already holds. Mapped outside the
    // transaction: a P2002 aborts it, and it rolls back before we get here.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') throw new ValidationError(createClashFields(err));
    throw err;
  }
  logger.info({ actorId: me.id, userId: user.id, role: user.role }, 'user.create');

  revalidatePath('/users');
}

/**
 * AUTH-07 / RBAC-05-006 — disable / re-enable. Adds:
 *   • Peer-Manager protection — Manager cannot disable another Manager or
 *     Steward.
 *   • "Last active Manager" guard — cannot disable the only remaining
 *     active MANAGER.
 *   • AUTH-12 — bumps `sessionsRevokedAt` on disable so the JWT freshness
 *     loop in lib/auth.ts kicks the disabled user out at the next request.
 */
export async function toggleUserActiveAction(formData: FormData): SafeAction<void> {
  return runAction(() => toggleUserActiveCore(formData));
}

async function toggleUserActiveCore(formData: FormData) {
  const me = await requireUserAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new ValidationError({ userId: 'required' });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User not found.');

  const guard = canMutateUser(
    { id: me.id, role: me.role, username: me.username },
    { id: user.id, role: user.role }
  );
  if (!guard.ok) throw new ForbiddenError(guard.reason);
  await assertManagerScopeOverTarget(me, user.id); // B2 / SEC-02

  const newActive = !user.isActive;

  // AUTH-07: last-Manager lockout. Disabling the only active Manager would
  // require raw SQL to recover from. Refuse loudly.
  if (user.role === Role.MANAGER && user.isActive && !newActive) {
    const otherActiveManagers = await prisma.user.count({
      where: { role: Role.MANAGER, isActive: true, id: { not: userId } },
    });
    if (otherActiveManagers === 0) {
      throw new ValidationError({
        _form: 'Cannot disable the only active Manager. Promote another user to Manager first.',
      });
    }
  }

  // F13: the change and its audit row in one transaction (see createUserCore).
  const env = await getAuditEnvelope(me.id);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        isActive: newActive,
        // AUTH-12: bump revocation marker so existing JWTs are immediately
        // invalidated on the next freshness check (≤5 min). Bump on disable
        // OR re-enable so a re-enabled user still picks up role changes etc.
        sessionsRevokedAt: new Date(),
      },
    });

    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: userId,
      before: { isActive: user.isActive },
      after: { isActive: updated.isActive },
      reason: newActive ? 'enabled' : 'disabled',
    });
  });
  revalidatePath('/users');
}

/**
 * AUTH-08 / RBAC-05-006: Manager cannot reset another Manager's or Steward's
 * password from this UI. AUTH-09: forces a change-on-first-login flag.
 * AUTH-12: bumps `sessionsRevokedAt` so the target's old session dies.
 */
export async function resetPasswordAction(formData: FormData): SafeAction<void> {
  return runAction(() => resetPasswordCore(formData));
}

async function resetPasswordCore(formData: FormData) {
  const me = await requireUserAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new ValidationError({ userId: 'required' });
  const newPassword = String(formData.get('password') ?? '');
  const parsed = passwordRule.safeParse(newPassword);
  if (!parsed.success) {
    throw new ValidationError({ password: parsed.error.issues[0]?.message ?? 'Invalid password' });
  }
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) throw new NotFoundError('User not found.');

  const guard = canMutateUser(
    { id: me.id, role: me.role, username: me.username },
    { id: target.id, role: target.role }
  );
  if (!guard.ok) throw new ForbiddenError(guard.reason);
  await assertManagerScopeOverTarget(me, target.id); // B2 / SEC-02

  // B-15: refuse reuse against the target's last 5 historical hashes AND
  // their current hash (the current hash is not yet in history).
  await assertPasswordNotReused(userId, target.passwordHash, parsed.data);

  const passwordHash = await bcrypt.hash(parsed.data, 12);
  const env = await getAuditEnvelope(me.id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: true,
        sessionsRevokedAt: new Date(),
      },
    });
    // B-15: stash the OLD hash in PasswordHistory and prune to 5 entries.
    await rotatePasswordHistory(tx, userId, target.passwordHash);
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: userId,
      reason: 'password_reset',
    });
  });
  revalidatePath('/users');
}

/**
 * AUTH-04 / AUTH-05: in-app role-change action. Required because the only
 * previous path was Excel re-import which silently leaves `ownedRouteId`
 * pointing at a route the new role can't own.
 *
 * Rules:
 *   • Manager-driven calls cannot promote anyone to MANAGER or STEWARD,
 *     and cannot demote a peer admin (canMutateUser).
 *   • Old role SALESMAN ⇒ ownedRouteId is cleared on promotion (AUTH-05).
 *   • New role SALESMAN ⇒ caller must supply ownedRouteId.
 *   • Old role SUPERVISOR ⇒ refuse if any salesman still reports to them
 *     (caller must reassign first).
 *   • AUTH-12 — bumps sessionsRevokedAt so the role change takes effect at
 *     the next freshness check, not 8h later.
 */
const updateRoleSchema = z.object({
  userId: z.string().cuid(),
  newRole: z.nativeEnum(Role),
  ownedRouteId: z
    .string()
    .cuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

export async function updateUserRoleAction(formData: FormData): SafeAction<void> {
  return runAction(() => updateUserRoleCore(formData));
}

async function updateUserRoleCore(formData: FormData) {
  const me = await requireUserAdmin();
  const parsed = updateRoleSchema.safeParse({
    userId: formData.get('userId'),
    newRole: formData.get('newRole'),
    ownedRouteId: formData.get('ownedRouteId') ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const { userId, newRole, ownedRouteId } = parsed.data;

  const target = await prisma.user.findUnique({
    where: { id: userId },
    include: { reports: { select: { id: true } } },
  });
  if (!target) throw new NotFoundError('User not found.');

  const guard = canMutateUser(
    { id: me.id, role: me.role, username: me.username },
    { id: target.id, role: target.role }
  );
  if (!guard.ok) throw new ForbiddenError(guard.reason);
  await assertManagerScopeOverTarget(me, target.id); // B2 / SEC-02

  // SR-USR-01: a MANAGER may only assign field-force roles. Promotion to an
  // approver (FINANCE_MANAGER/GM/ACCOUNTANT) or admin (MANAGER/STEWARD) tier is
  // Steward-only — this closes the "promote a puppet into the credit chain" path
  // alongside the create/reset/disable guards. A STEWARD may assign any role.
  if (me.role === Role.MANAGER && !MANAGER_ADMINISTRABLE_ROLES.includes(newRole)) {
    throw new ValidationError({
      newRole:
        'A Manager can only assign Salesman/Supervisor — Viewer, approver and admin roles are Steward-provisioned.',
    });
  }
  // B2 / SEC-02: a Manager may only place a salesman on a route in their regions.
  if (me.role === Role.MANAGER && newRole === Role.SALESMAN && ownedRouteId) {
    const [scope, route] = await Promise.all([
      loadScope(me.id),
      prisma.route.findUnique({ where: { id: ownedRouteId }, select: { regionId: true } }),
    ]);
    if (!route || !managerCanAssignRoute(scope.managedRegionIds, route.regionId)) {
      throw new ValidationError({ ownedRouteId: 'That route is not in a region you manage.' });
    }
  }

  // AUTH-07 last-Manager guard for demotion of an active Manager. (Note:
  // newRole has already been narrowed to non-MANAGER above; the demote check
  // is the relevant one here.)
  if (target.role === Role.MANAGER && target.isActive) {
    const otherActiveManagers = await prisma.user.count({
      where: { role: Role.MANAGER, isActive: true, id: { not: userId } },
    });
    if (otherActiveManagers === 0) {
      throw new ValidationError({
        _form: 'Cannot demote the only active Manager.',
      });
    }
  }

  // SUPERVISOR demotion requires no active reports.
  if (target.role === Role.SUPERVISOR && newRole !== Role.SUPERVISOR && target.reports.length > 0) {
    throw new ValidationError({
      _form: `Reassign ${target.reports.length} salesman/supervisor report(s) before demoting this Supervisor.`,
    });
  }

  // SALESMAN role specifics.
  let resolvedRouteId: string | null = target.ownedRouteId;
  if (target.role === Role.SALESMAN && newRole !== Role.SALESMAN) {
    // AUTH-05: clear ownedRoute on promote. The route is now reassignable.
    resolvedRouteId = null;
  }
  if (newRole === Role.SALESMAN) {
    if (!ownedRouteId) {
      throw new ValidationError({ ownedRouteId: 'Salesman must own a route.' });
    }
    const conflicting = await prisma.user.findUnique({
      where: { ownedRouteId },
      select: { id: true },
    });
    if (conflicting && conflicting.id !== userId) {
      throw new ValidationError({
        ownedRouteId: 'Route is already owned by another user — reassign that user first.',
      });
    }
    resolvedRouteId = ownedRouteId;
  }

  // F13: the change and its audit row in one transaction (see createUserCore).
  const env = await getAuditEnvelope(me.id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        role: newRole,
        ownedRouteId: resolvedRouteId,
        sessionsRevokedAt: new Date(),
      },
    });
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: userId,
      before: { role: target.role, ownedRouteId: target.ownedRouteId },
      after: { role: newRole, ownedRouteId: resolvedRouteId },
      reason: 'role_change',
    });
  });
  revalidatePath('/users');
}

// A user's own password change (AUTH-16) is services/password.ts, and the reuse
// and history rules both paths share are lib/password-policy.ts (X-AUTH-1).
