'use server';

import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { canMutateUser, MANAGER_ADMINISTRABLE_ROLES } from '@/lib/permissions';
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
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.MANAGER && session.user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only Managers or Stewards can manage users.');
  }
  return session.user;
}

const usernameRule = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-z0-9._-]+$/, 'lowercase letters, digits, dot, underscore, hyphen only');

const passwordRule = z.string().min(12, 'Password must be at least 12 characters');

const createUserSchema = z.object({
  username: usernameRule,
  fullName: z.string().min(2).max(200),
  role: z.nativeEnum(Role),
  email: z.string().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().max(50).optional().or(z.literal('').transform(() => undefined)),
  password: passwordRule,
  supervisorId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),
  ownedRouteId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),
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

async function createUserCore(formData: FormData) {
  const me = await requireUserAdmin();
  const parsed = createUserSchema.safeParse({
    username: String(formData.get('username') ?? '').toLowerCase().trim(),
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
      role:
        'A Manager can only create Salesman/Supervisor/Viewer accounts — ask a Steward to provision approver or admin-tier accounts.',
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
  let user;
  try {
    user = await prisma.user.create({
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
  } catch (err) {
    // Race fallback: another Manager beat us to the username.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      throw new ValidationError({ username: 'Username already taken.' });
    }
    throw err;
  }

  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'CREATE',
    entityType: 'User',
    entityId: user.id,
    after: { username: user.username, role: user.role },
  });
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

  const newActive = !user.isActive;

  // AUTH-07: last-Manager lockout. Disabling the only active Manager would
  // require raw SQL to recover from. Refuse loudly.
  if (user.role === Role.MANAGER && user.isActive && !newActive) {
    const otherActiveManagers = await prisma.user.count({
      where: { role: Role.MANAGER, isActive: true, id: { not: userId } },
    });
    if (otherActiveManagers === 0) {
      throw new ValidationError({
        _form:
          'Cannot disable the only active Manager. Promote another user to Manager first.',
      });
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      isActive: newActive,
      // AUTH-12: bump revocation marker so existing JWTs are immediately
      // invalidated on the next freshness check (≤5 min). Bump on disable
      // OR re-enable so a re-enabled user still picks up role changes etc.
      sessionsRevokedAt: new Date(),
    },
  });

  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'UPDATE',
    entityType: 'User',
    entityId: userId,
    before: { isActive: user.isActive },
    after: { isActive: updated.isActive },
    reason: newActive ? 'enabled' : 'disabled',
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
  ownedRouteId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),
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

  // SR-USR-01: a MANAGER may only assign field-force roles. Promotion to an
  // approver (FINANCE_MANAGER/GM/ACCOUNTANT) or admin (MANAGER/STEWARD) tier is
  // Steward-only — this closes the "promote a puppet into the credit chain" path
  // alongside the create/reset/disable guards. A STEWARD may assign any role.
  if (me.role === Role.MANAGER && !MANAGER_ADMINISTRABLE_ROLES.includes(newRole)) {
    throw new ValidationError({
      newRole: 'A Manager can only assign Salesman/Supervisor/Viewer — approver and admin roles are Steward-provisioned.',
    });
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

  await prisma.user.update({
    where: { id: userId },
    data: {
      role: newRole,
      ownedRouteId: resolvedRouteId,
      sessionsRevokedAt: new Date(),
    },
  });
  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'UPDATE',
    entityType: 'User',
    entityId: userId,
    before: { role: target.role, ownedRouteId: target.ownedRouteId },
    after: { role: newRole, ownedRouteId: resolvedRouteId },
    reason: 'role_change',
  });
  revalidatePath('/users');
}

/**
 * AUTH-16: self-service password change. Validates the current password
 * then writes a new hash and clears `mustChangePassword`. Bumps
 * `sessionsRevokedAt` so any other open sessions for this user die.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordRule,
});

export async function changeOwnPasswordAction(formData: FormData): SafeAction<void> {
  return runAction(() => changeOwnPasswordCore(formData));
}

async function changeOwnPasswordCore(formData: FormData) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
  });
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const me = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  const ok = await bcrypt.compare(parsed.data.currentPassword, me.passwordHash);
  if (!ok) {
    // AUTH-19: same opaque message as a login failure so we don't leak whether
    // the current password was wrong vs. a server hiccup.
    throw new ValidationError({ currentPassword: 'Current password incorrect.' });
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    throw new ValidationError({ newPassword: 'New password must differ from current.' });
  }
  // B-15: also reject if the chosen new password matches any of the last
  // 5 hashes for this user. The current hash is checked above (current ===
  // new short-circuits earlier), so only history needs checking here.
  await assertPasswordNotReused(me.id, me.passwordHash, parsed.data.newPassword);

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const env = await getAuditEnvelope(me.id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: me.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        sessionsRevokedAt: new Date(),
      },
    });
    // B-15: stash the OLD hash in PasswordHistory and prune to 5 entries.
    await rotatePasswordHistory(tx, me.id, me.passwordHash);
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: me.id,
      reason: 'self_password_change',
    });
  });
  revalidatePath('/profile');
}

/**
 * B-15: Password reuse prevention.
 *
 * Walks the user's last 5 PasswordHistory rows AND the user's current hash,
 * comparing each against the proposed plaintext. We compare against current
 * as well as history because the current hash isn't moved into history
 * until after a successful change — without that check, a user could
 * "rotate" to the same password they already have.
 *
 * bcrypt.compare is intentionally serial (we await each one). Five
 * sequential bcrypt compares at cost-12 is ~250-500ms total — fine for an
 * interactive password-change form, and parallelising leaks little.
 */
async function assertPasswordNotReused(
  userId: string,
  currentHash: string,
  proposedPlain: string
): Promise<void> {
  if (await bcrypt.compare(proposedPlain, currentHash)) {
    throw new ValidationError({
      password: 'You cannot reuse one of your last 5 passwords.',
      newPassword: 'You cannot reuse one of your last 5 passwords.',
    });
  }
  const recent = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { hash: true },
  });
  for (const row of recent) {
    if (await bcrypt.compare(proposedPlain, row.hash)) {
      throw new ValidationError({
        password: 'You cannot reuse one of your last 5 passwords.',
        newPassword: 'You cannot reuse one of your last 5 passwords.',
      });
    }
  }
}

/**
 * B-15: Push the user's previous hash onto PasswordHistory and prune so
 * only the most recent 5 rows remain. Runs inside the same transaction
 * as the User.update so a partial failure doesn't desync.
 */
async function rotatePasswordHistory(
  tx: Prisma.TransactionClient,
  userId: string,
  oldHash: string
): Promise<void> {
  await tx.passwordHistory.create({
    data: { userId, hash: oldHash },
  });
  // Find the cutoff: the 6th-most-recent row (index 5). Anything
  // strictly older is pruned. Keeps the table at ≤5 rows per user.
  const keepers = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true },
  });
  if (keepers.length === 5) {
    await tx.passwordHistory.deleteMany({
      where: {
        userId,
        id: { notIn: keepers.map((k) => k.id) },
      },
    });
  }
}
