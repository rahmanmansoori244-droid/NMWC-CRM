'use server';

import { prisma } from '@/lib/db';
import { EditProcess, EditState, Role, type Prisma } from '@prisma/client';
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
import { revalidatePath, revalidateTag } from 'next/cache';
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
import { getAuditEnvelope, writeAudit, type AuditEnvelope } from '@/lib/audit';
import {
  REGION_SCOPED_ROLES,
  SUPERVISED_ROLES,
  SUPERVISING_ROLES,
  accountEditAudit,
  changedFields,
  compareCodes,
  retiredUsername,
  revokesSessions,
  routeHandover,
  routeMoveNotes,
  routeSignInName,
  strandedCreatesIssue,
  supervisorCoverIssue,
  supervisorStepNotes,
  type AccountEditResult,
  type EditableAccount,
  type RouteHolder,
  type SupervisorCandidate,
} from '@/lib/account-edit';
import { countOpenReturned, openReturnedIds } from '@/lib/returned-work';
import { omanDateISO } from '@/lib/tz';

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
  // Launch fix: trimmed and lower-cased, as the F1 e-mail edit stores it
  // (contactAddressRule below). User.email's unique index is case-sensitive, so
  // "A.Name@x" and "a.name@x" were two accounts sharing one mailbox.
  email: z
    .string()
    .trim()
    .toLowerCase()
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
  // Owner decision 8: a new Manager or Accountant is created with his regions,
  // one `regionId` entry per ticked box.
  regionIds: z.array(z.string().cuid()).max(50),
});

/**
 * AUTH-03 / RBAC-05-006: a Manager may NOT create another MANAGER or
 * STEWARD via this UI. Admin-tier creation requires Steward (out-of-band).
 * AUTH-06: validate supervisorId actually points at an active SUPERVISOR.
 * AUTH-10: pre-check username uniqueness with friendly error.
 */
export async function createUserAction(
  formData: FormData
): SafeAction<{ notes: string[] } | undefined> {
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

/**
 * Owner decision 8: a supervisor as lib/account-edit.ts supervisorCoverIssue
 * judges him. `forId` is the account being given this supervisor: his own route
 * is not counted in the supervisor's team, so moving him does not vouch for itself.
 */
async function supervisorCandidate(
  id: string,
  forId: string | null
): Promise<(SupervisorCandidate & { username: string; fullName: string }) | null> {
  const s = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      fullName: true,
      role: true,
      isActive: true,
      managedRegions: { select: { id: true } },
      reports: { select: { id: true, ownedRoute: { select: { regionId: true } } } },
    },
  });
  if (!s) return null;
  return {
    id: s.id,
    username: s.username,
    fullName: s.fullName,
    role: s.role,
    isActive: s.isActive,
    managedRegionIds: (s.managedRegions ?? []).map((r) => r.id),
    teamRegionIds: [
      ...new Set(
        (s.reports ?? [])
          .filter((r) => r.id !== forId)
          .map((r) => r.ownedRoute?.regionId)
          .filter((r): r is string => !!r)
      ),
    ],
  };
}

/**
 * The route an account is being put on, with what the rules need of it. A
 * switched-off route is refused here, not only left out of the form's list: a
 * salesman on one cannot send anything (services/creates.ts, services/edits.ts).
 * `keeps` is the route the account works now, which it may keep either way.
 */
async function routeForAssignment(id: string, keeps: string | null = null) {
  const route = await prisma.route.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      regionId: true,
      isActive: true,
      region: { select: { code: true } },
    },
  });
  if (!route) throw new ValidationError({ ownedRouteId: 'Route not found.' });
  if (!route.isActive && route.id !== keeps) {
    throw new ValidationError({
      ownedRouteId: `Route ${route.code} is switched off. Switch it on in Routes first, or pick another route.`,
    });
  }
  return route;
}

/** Who holds a route now (User.ownedRouteId is unique: nobody or one account). */
async function routeHolder(routeId: string): Promise<RouteHolder> {
  return prisma.user.findUnique({
    where: { ownedRouteId: routeId },
    select: { id: true, username: true, fullName: true, isActive: true },
  });
}

/**
 * Owner decision 8: the regions a Manager or Accountant is given, sorted by
 * code (compareCodes, the order the edit's "before" uses too). At least one —
 * the account import refuses one that would manage none, because an empty
 * managedRegions sees nothing and clears no approval step — and none for any
 * other role. A switched-off region is refused unless the account has it
 * already (`held`): the form lists only those, and a crafted post is not trusted.
 */
async function regionsFor(
  role: Role,
  regionIds: string[],
  held: string[] = []
): Promise<{ id: string; code: string }[]> {
  if (!REGION_SCOPED_ROLES.includes(role)) {
    if (regionIds.length > 0) {
      throw new ValidationError({
        regionIds: 'Only Managers and Accountants have regions. Untick them for this role.',
      });
    }
    return [];
  }
  const ids = [...new Set(regionIds)];
  if (ids.length === 0) {
    throw new ValidationError({
      regionIds:
        'A Manager or Accountant must manage at least one region, or he sees nothing and can approve nothing.',
    });
  }
  const found = await prisma.region.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, isActive: true },
  });
  if (found.length !== ids.length) {
    throw new ValidationError({
      regionIds: 'A region was not found. Reload the page and try again.',
    });
  }
  const off = found.filter((r) => !r.isActive && !held.includes(r.id)).map((r) => r.code);
  if (off.length > 0) {
    throw new ValidationError({
      regionIds: `Region ${off.sort(compareCodes).join(', ')} is switched off. Switch it on in Routes first, or untick it.`,
    });
  }
  return found
    .map((r) => ({ id: r.id, code: r.code }))
    .sort((a, b) => compareCodes(a.code, b.code));
}

/**
 * The sign-in name a leaver keeps once his route is handed on
 * (lib/account-edit.ts retiredUsername), the first one nobody holds.
 */
async function freeRetiredUsername(username: string): Promise<string> {
  const day = omanDateISO();
  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = retiredUsername(username, day, attempt);
    const taken = await prisma.user.findUnique({ where: { username: name }, select: { id: true } });
    if (!taken) return name;
  }
  throw new ValidationError({
    ownedRouteId: `No free name was found to retire ${username}'s sign-in name. Try again tomorrow, or ask the owner.`,
  });
}

/**
 * Owner decision 8 (leaver/joiner): take the route off its disabled holder, in
 * the caller's transaction, with a REASSIGN row on him as the account import
 * writes one (F-18). When his sign-in name is the route's code it is retired
 * (`retired`), so the code is free for whoever works the route next.
 *
 * The holder is read again here: enabled again, or given another route, since
 * the checks outside the transaction, he keeps what he has and nothing is saved.
 */
async function handOverRoute(
  tx: Prisma.TransactionClient,
  env: AuditEnvelope,
  p: {
    from: { id: string; username: string };
    routeId: string;
    routeCode: string;
    retired: string | null;
    toUsername: string;
  }
): Promise<void> {
  const now = await tx.user.findUnique({
    where: { id: p.from.id },
    select: { isActive: true, ownedRouteId: true },
  });
  if (!now || now.isActive || now.ownedRouteId !== p.routeId) {
    throw new ValidationError({
      ownedRouteId: `Route ${p.routeCode} changed hands while this was being saved. Nothing was saved — reload the page and try again.`,
    });
  }
  await tx.user.update({
    where: { id: p.from.id },
    data: { ownedRouteId: null, ...(p.retired ? { username: p.retired } : {}) },
  });
  await writeAudit(tx, env, {
    action: 'REASSIGN',
    entityType: 'User',
    entityId: p.from.id,
    before: { ownedRouteCode: p.routeCode, ...(p.retired ? { username: p.from.username } : {}) },
    after: { ownedRouteCode: null, ...(p.retired ? { username: p.retired } : {}) },
    reason: `route ${p.routeCode} handed to ${p.toUsername} on /users`,
  });
}

/** What the Steward is told about the leaver whose route was handed on. */
async function handOverNotes(
  from: { id: string; username: string; fullName: string },
  routeCode: string,
  retired: string | null
): Promise<string[]> {
  const [inReview, sentBack] = await Promise.all([
    prisma.customerEdit.count({ where: { submittedById: from.id, state: EditState.SUBMITTED } }),
    countOpenReturned(prisma, from.id),
  ]);
  return [
    `Route ${routeCode} was taken from ${from.fullName}'s disabled account${
      retired ? `, whose sign-in name is now ${retired}` : ''
    }.`,
    ...routeMoveNotes({
      who: from.fullName,
      fromRoute: routeCode,
      inReview,
      sentBack,
      leaver: true,
    }),
  ];
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
    regionIds: formData.getAll('regionId').map(String).filter(Boolean),
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path[0] === 'regionIds' ? 'regionIds' : issue.path.join('.')] = issue.message;
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
  const route = data.ownedRouteId ? await routeForAssignment(data.ownedRouteId) : null;
  if (managerScope && route) {
    if (!managerCanAssignRoute(managerScope.managedRegionIds, route.regionId)) {
      throw new ValidationError({
        ownedRouteId: 'That route is not in a region you manage.',
      });
    }
  }

  // Owner decision 8: a new Manager or Accountant is created with his regions.
  const regions = await regionsFor(data.role, data.regionIds);

  // AUTH-06: supervisorId must resolve to an active SUPERVISOR (or MANAGER
  // for Salesman who reports up the management ladder); the UI dropdown
  // already filters this but a hand-crafted form post can submit anything.
  let supervisorUsername: string | null = null;
  if (data.supervisorId) {
    const sup = await supervisorCandidate(data.supervisorId, null);
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
    // Owner decision 8: and one who covers the region of the salesman's route.
    const cover = supervisorCoverIssue({
      supervisor: sup,
      targetId: null,
      routeRegionId: route?.regionId ?? null,
      routeRegionCode: route?.region?.code,
    });
    if (cover) throw new ValidationError({ supervisorId: cover });
    supervisorUsername = sup.username;
  }

  // Route uniqueness (1 salesman per route). Owner decision 8 (leaver/joiner):
  // the Steward may take a route from a DISABLED holder, the leaver; never from
  // an active one. A Manager still gets only a route nobody holds.
  let handover: NonNullable<RouteHolder> | null = null;
  let retired: string | null = null;
  if (route) {
    const verdict = routeHandover({
      routeCode: route.code,
      holder: await routeHolder(route.id),
      targetId: null,
      mayHandOver: me.role === Role.STEWARD,
    });
    if (verdict.kind === 'refused') throw new ValidationError({ ownedRouteId: verdict.message });
    if (verdict.kind === 'handover') {
      handover = verdict.from;
      // The leaver's sign-in name is the route's code (lib/account-edit.ts):
      // retired with the route when the joiner takes the code as his. A joiner
      // with a name of his own leaves the leaver his, rather than free a code
      // nobody then signs in with (this app has no other way to rename one).
      if (
        handover.username === routeSignInName(route.code) &&
        data.username === handover.username
      ) {
        retired = await freeRetiredUsername(handover.username);
      }
    }
  }

  // AUTH-10: friendly username uniqueness pre-check. The one name it lets
  // through is the leaver's, which the hand-over above retires.
  const dup = await prisma.user.findUnique({
    where: { username: data.username },
    select: { id: true },
  });
  if (dup && !(retired && dup.id === handover?.id)) {
    throw new ValidationError({ username: 'Username already taken.' });
  }

  // Launch fix: the unique index cannot see a clash in another letter case, so
  // it is checked here ignoring case, as updateUserEmailCore does. An address
  // stored before this rule, in capitals, is still found.
  if (data.email) {
    const clash = await prisma.user.findFirst({
      where: { email: { equals: data.email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError({ email: 'That e-mail is already used by another account.' });
    }
  }

  // Read before the write: a failed read after the commit would answer "Nothing
  // was saved" about an account that was created.
  const notes = handover && route ? await handOverNotes(handover, route.code, retired) : null;

  const passwordHash = await bcrypt.hash(data.password, 12);
  // F13: the account and its audit row commit together, or neither does — the
  // audit row is the only record of who created it. The envelope is read first
  // so the transaction holds only the two writes (four with a hand-over).
  const env = await getAuditEnvelope(me.id);
  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      if (handover && route) {
        await handOverRoute(tx, env, {
          from: handover,
          routeId: route.id,
          routeCode: route.code,
          retired,
          toUsername: data.username,
        });
      }
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
          ...(regions.length > 0
            ? { managedRegions: { connect: regions.map((r) => ({ id: r.id })) } }
            : {}),
          // AUTH-09: every newly-created account must change its password on
          // first login so the Manager-typed password isn't a permanent one.
          mustChangePassword: true,
        },
      });
      // What the account may reach, as the account import's CREATE row holds it
      // (lib/account-import.ts accountCreateAudit); never a name or contact value.
      await writeAudit(tx, env, {
        action: 'CREATE',
        entityType: 'User',
        entityId: created.id,
        after: {
          username: created.username,
          role: created.role,
          route: route?.code ?? null,
          supervisor: supervisorUsername,
          regions: regions.map((r) => r.code),
        },
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
  logger.info(
    { actorId: me.id, userId: user.id, role: user.role, handover: !!handover },
    'user.create'
  );

  revalidatePath('/users');
  // Launch fix: the /customers filters read the people from a 5-minute cache
  // (lib/reference-data.ts getAllHierarchyUsers); without this a new salesman
  // was missing from them for up to five minutes.
  revalidateTag('ref:users');
  if (notes) revalidatePath('/routes');
  return notes ? { notes } : undefined;
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
  revalidateTag('ref:users'); // the cached list holds active accounts only
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
  revalidateTag('ref:users'); // role and route are both in the cached list
}

/**
 * Owner decision 8 (2026-10-07): the Data Steward's "Edit account" on /users —
 * the role, a salesman's route, a salesman's or supervisor's supervisor, a
 * Manager's or Accountant's regions, the phone and the e-mail. It is the
 * leaver/joiner tool too: a route held by a DISABLED account (the leaver) is
 * handed to the account being edited. STEWARD only; a Manager keeps the actions
 * he had (create, disable, reset password, and the role action above).
 *
 * The rules are lib/account-edit.ts, shared with the create:
 *   - a salesman has a route, and a route has one salesman: never taken from an
 *     active holder, taken from a disabled one with a REASSIGN row on him; never
 *     a switched-off route or region, unless the account has it already;
 *   - a salesman signs in with his route's code: `routeSignIn` gives the moved
 *     account the new route's code as his sign-in name, and the leaver's is
 *     retired when the account takes it;
 *   - a supervisor is an active SUPERVISOR or MANAGER who covers the route's
 *     region — judged when the supervisor, the route or the role changes, so a
 *     phone edit is not held back by an older assignment. Only salesmen and
 *     Supervisors report to someone here; any other account keeps what it has
 *     (an import may have set one) unless its role changes;
 *   - a Manager or Accountant manages at least one region; a Manager keeps every
 *     region where an active salesman reporting to him works, and an active
 *     region keeps at least one active Accountant;
 *   - an account anyone reports to stays a Supervisor or a Manager, and the only
 *     active Manager stays one (AUTH-07);
 *   - a change of role or regions ends the account's sessions;
 *   - one audit row with the before and after of what changed, the phone and the
 *     e-mail named and never copied (accountEditAudit), in the transaction that
 *     saves it.
 *
 * His open requests (routeMoveNotes), when his route changes:
 *   - those in review (SUBMITTED) stay his and stay with the same approvers,
 *     because every step's approver is found from the customer's region — a new
 *     customer's from its branch drafts, which keep the route they were sent
 *     from — or org-wide, never from the salesman's route. The one exception is
 *     a SUPERVISOR-role supervisor, whose Supervisor step follows the salesman's
 *     current supervisorId (supervisorStepNotes), with the region's Managers
 *     able to decide it either way. A new-customer request among them that is
 *     sent back after the move cannot be sent again from his new route
 *     (services/creates.ts refuses it): he withdraws it, and the Steward is
 *     told so (inReviewCreates);
 *   - sent-back updates stay his; one on a customer he can no longer open he
 *     clears on Needs correction;
 *   - new-customer requests not in review (drafts, or sent back) cannot be sent
 *     again from his NEW route (services/creates.ts refuses one started on
 *     another route). So the change is refused while he has any started on
 *     another route (strandedCreatesIssue), unless the Steward ticks
 *     `withdrawCreates`: they are then withdrawn in the same transaction, as he
 *     could withdraw them himself (withdrawCreateAction).
 */
const editAccountSchema = z.object({
  userId: z.string().cuid(),
  role: z.nativeEnum(Role),
  ownedRouteId: z
    .string()
    .cuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  supervisorId: z
    .string()
    .cuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  regionIds: z.array(z.string().cuid()).max(50),
  // An empty box keeps the stored number; clearPhone removes it. The stored
  // number never reaches the page (RBAC-05-023).
  phone: z.string().trim().max(50),
  clearPhone: z.boolean(),
  // The e-mail, the same way, under the name the e-mail edit uses (an `email`
  // field invites the browser's autofill: users-autofill-guard).
  contactAddress: z.string().trim().max(200),
  clearContactAddress: z.boolean(),
  routeSignIn: z.boolean(),
  withdrawCreates: z.boolean(),
});

export async function updateUserAccountAction(formData: FormData): SafeAction<AccountEditResult> {
  return runAction(() => updateUserAccountCore(formData));
}

async function updateUserAccountCore(formData: FormData): Promise<AccountEditResult> {
  const me = await requireUserAdmin();
  if (me.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can edit an account.');
  }
  const parsed = editAccountSchema.safeParse({
    userId: formData.get('userId'),
    role: formData.get('role'),
    ownedRouteId: formData.get('ownedRouteId') ?? undefined,
    supervisorId: formData.get('supervisorId') ?? undefined,
    regionIds: formData.getAll('regionId').map(String).filter(Boolean),
    phone: String(formData.get('phone') ?? ''),
    clearPhone: formData.get('clearPhone') === 'on',
    contactAddress: String(formData.get('contactAddress') ?? ''),
    clearContactAddress: formData.get('clearContactAddress') === 'on',
    routeSignIn: formData.get('routeSignIn') === 'on',
    withdrawCreates: formData.get('withdrawCreates') === 'on',
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path[0] === 'regionIds' ? 'regionIds' : issue.path.join('.')] = issue.message;
    }
    throw new ValidationError(fields);
  }
  const d = parsed.data;

  const target = await prisma.user.findUnique({
    where: { id: d.userId },
    select: {
      id: true,
      username: true,
      fullName: true,
      role: true,
      isActive: true,
      phone: true,
      email: true,
      ownedRoute: { select: { id: true, code: true, regionId: true } },
      supervisor: { select: { id: true, username: true, fullName: true, role: true } },
      managedRegions: { select: { id: true, code: true, isActive: true } },
      reports: {
        select: {
          id: true,
          isActive: true,
          ownedRoute: { select: { regionId: true, region: { select: { code: true } } } },
        },
      },
    },
  });
  if (!target) throw new NotFoundError('User not found.');
  const guard = canMutateUser(
    { id: me.id, role: me.role, username: me.username },
    { id: target.id, role: target.role }
  );
  if (!guard.ok) throw new ForbiddenError(guard.reason);

  const role = d.role;
  const before: EditableAccount = {
    role: target.role,
    username: target.username,
    route: target.ownedRoute?.code ?? null,
    supervisor: target.supervisor?.username ?? null,
    regions: target.managedRegions.map((r) => r.code).sort(compareCodes),
    phone: target.phone ?? null,
    email: target.email ?? null,
  };

  // The role. AUTH-07: the only active Manager stays one. An account somebody
  // reports to stays someone who can supervise — for a Supervisor this is
  // updateUserRoleCore's rule, and a go-live Manager supervises his salesmen too.
  if (role !== target.role) {
    if (target.role === Role.MANAGER && target.isActive) {
      const otherActiveManagers = await prisma.user.count({
        where: { role: Role.MANAGER, isActive: true, id: { not: target.id } },
      });
      if (otherActiveManagers === 0) {
        throw new ValidationError({ role: 'Cannot change the role of the only active Manager.' });
      }
    }
    if (target.reports.length > 0 && !SUPERVISING_ROLES.includes(role)) {
      throw new ValidationError({
        role: `${target.reports.length} account(s) report to ${target.fullName}. Give them another supervisor before changing this role.`,
      });
    }
  }

  // The route.
  let route: Awaited<ReturnType<typeof routeForAssignment>> | null = null;
  let handover: NonNullable<RouteHolder> | null = null;
  // A salesman who already has none (a leaver whose route was handed on, or one
  // an import moved off his route) can still be edited without one.
  const keepsNoRoute = role === target.role && !target.ownedRoute && !d.ownedRouteId;
  if (role === Role.SALESMAN && !keepsNoRoute) {
    if (!d.ownedRouteId) {
      throw new ValidationError({ ownedRouteId: 'A salesman must be assigned to a route.' });
    }
    route = await routeForAssignment(d.ownedRouteId, target.ownedRoute?.id ?? null);
    if (route.id !== target.ownedRoute?.id) {
      // X-IMPORTS-2, as the account import applies it: a route is never parked
      // on an account that cannot sign in.
      if (!target.isActive) {
        throw new ValidationError({
          ownedRouteId: `${target.fullName}'s account is disabled, so route ${route.code} is not given to it. Enable the account first.`,
        });
      }
      const verdict = routeHandover({
        routeCode: route.code,
        holder: await routeHolder(route.id),
        targetId: target.id,
        mayHandOver: true,
      });
      if (verdict.kind === 'refused') throw new ValidationError({ ownedRouteId: verdict.message });
      if (verdict.kind === 'handover') handover = verdict.from;
    }
  } else if (d.ownedRouteId) {
    throw new ValidationError({
      ownedRouteId: 'Only salesmen own a route. Clear this field for other roles.',
    });
  }
  const routeChanged = (route?.id ?? null) !== (target.ownedRoute?.id ?? null);

  // His new-customer requests that are not in review and were started on
  // another route than the one he now gets (none, for a role with no route):
  // services/creates.ts would refuse to send them again, so he could only
  // withdraw them. Refused, unless the Steward withdraws them with this
  // change. A disabled account sends nothing again, and its drafts hold no
  // shop (lib/create-guards.ts), so his are left as they are.
  const strandedCreates =
    target.isActive && routeChanged
      ? await prisma.customerEdit.findMany({
          where: {
            submittedById: target.id,
            process: EditProcess.CREATE,
            state: { in: [EditState.DRAFT, EditState.NEEDS_CORRECTION] },
            ...(route ? { branchDrafts: { some: { routeId: { not: route.id } } } } : {}),
          },
          select: {
            id: true,
            state: true,
            cycle: true,
            branchDrafts: { select: { route: { select: { code: true } } } },
          },
        })
      : [];
  const strandedFrom = [
    ...new Set(strandedCreates.flatMap((e) => e.branchDrafts.map((b) => b.route.code))),
  ].sort(compareCodes);
  const strandedIssue = strandedCreatesIssue({
    who: target.fullName,
    count: strandedCreates.length,
    fromRoutes: strandedFrom,
    toRoute: route?.code ?? null,
    withdraw: d.withdrawCreates,
  });
  if (strandedIssue) throw new ValidationError({ withdrawCreates: strandedIssue });

  // The supervisor: only salesmen and supervisors report to someone here. Any
  // other account keeps the one it has (an import may have set it), unless its
  // role changes: a phone edit of a Manager does not quietly unlink him.
  const keepsSupervisor = !SUPERVISED_ROLES.includes(role) && role === target.role;
  let supervisor: { id: string; username: string; fullName: string; role: Role } | null =
    keepsSupervisor ? (target.supervisor ?? null) : null;
  if (SUPERVISED_ROLES.includes(role) && d.supervisorId) {
    const sup = await supervisorCandidate(d.supervisorId, target.id);
    const unchanged =
      d.supervisorId === target.supervisor?.id && !routeChanged && role === target.role;
    if (!unchanged) {
      const issue = supervisorCoverIssue({
        supervisor: sup,
        targetId: target.id,
        routeRegionId: route?.regionId ?? null,
        routeRegionCode: route?.region?.code,
      });
      if (issue) throw new ValidationError({ supervisorId: issue });
    }
    if (!sup) throw new ValidationError({ supervisorId: 'Supervisor must exist and be active.' });
    supervisor = { id: sup.id, username: sup.username, fullName: sup.fullName, role: sup.role };
  }

  // The regions. A Manager keeps every region where an active salesman who
  // reports to him works: otherwise he is told of their requests and can decide
  // none of them.
  const regions = await regionsFor(
    role,
    d.regionIds,
    target.managedRegions.map((r) => r.id)
  );
  if (role === Role.MANAGER) {
    const kept = new Set(regions.map((r) => r.id));
    const stranded = target.reports.filter(
      (r) => r.isActive && r.ownedRoute && !kept.has(r.ownedRoute.regionId)
    );
    if (stranded.length > 0) {
      const codes = [...new Set(stranded.map((r) => r.ownedRoute!.region.code))]
        .sort(compareCodes)
        .join(', ');
      throw new ValidationError({
        regionIds: `${stranded.length} active salesman/salesmen reporting to ${target.fullName} work in ${codes}. Keep the region, or give them another supervisor first.`,
      });
    }
  }
  // An active region keeps an active Accountant: the last step of every
  // new-customer and credit request there is his (lib/permissions.ts
  // canActOnStep, REGION_OVERLAP), and without one they wait for nobody.
  if (target.isActive && target.role === Role.ACCOUNTANT) {
    const keeps = new Set(role === Role.ACCOUNTANT ? regions.map((r) => r.id) : []);
    const lost = target.managedRegions.filter((r) => r.isActive && !keeps.has(r.id));
    if (lost.length > 0) {
      const covered = await prisma.region.findMany({
        where: {
          id: { in: lost.map((r) => r.id) },
          managers: { some: { role: Role.ACCOUNTANT, isActive: true, id: { not: target.id } } },
        },
        select: { id: true },
      });
      const alone = lost
        .filter((r) => !covered.some((c) => c.id === r.id))
        .map((r) => r.code)
        .sort(compareCodes);
      if (alone.length > 0) {
        throw new ValidationError({
          [role === Role.ACCOUNTANT ? 'regionIds' : 'role']:
            `${target.fullName} is the only active Accountant of ${alone.join(', ')}. Give the region to another Accountant first, or its new-customer and credit requests wait at the Accountant step with nobody to decide them.`,
        });
      }
    }
  }

  // The phone: an empty box keeps it.
  const phone = d.clearPhone ? null : d.phone !== '' ? d.phone : (target.phone ?? null);

  // The e-mail, the same way, by updateUserEmailCore's rules: trimmed and
  // lower-cased, and no other account may hold it in any letter case.
  let email = target.email ?? null;
  if (d.clearContactAddress) email = null;
  else if (d.contactAddress !== '') {
    const typed = contactAddressRule.safeParse(d.contactAddress);
    if (!typed.success) {
      throw new ValidationError({
        contactAddress:
          'Enter a valid e-mail address, or leave the box empty to keep the one on file.',
      });
    }
    email = typed.data;
  }
  if (email && email !== (target.email ?? null)) {
    const clash = await prisma.user.findFirst({
      where: { id: { not: target.id }, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError({
        contactAddress: 'That e-mail is already used by another account.',
      });
    }
  }

  // The sign-in name. A salesman signs in with his route's code
  // (lib/account-edit.ts); routeSignIn moves the moved account onto the new code.
  let username = target.username;
  if (route && d.routeSignIn) {
    const wanted = routeSignInName(route.code);
    if (!usernameRule.safeParse(wanted).success) {
      throw new ValidationError({
        routeSignIn: `Route code ${route.code} cannot be a sign-in name. Untick it to keep ${target.username}.`,
      });
    }
    if (wanted !== target.username) {
      const holder = await prisma.user.findUnique({
        where: { username: wanted },
        select: { id: true, fullName: true },
      });
      // The leaver of this very route gives the name up below.
      if (holder && holder.id !== handover?.id) {
        throw new ValidationError({
          routeSignIn: `The sign-in name ${wanted} belongs to ${holder.fullName}'s account. Untick it to keep ${target.username}.`,
        });
      }
      username = wanted;
    }
  }
  // The leaver's sign-in name is retired only when this account takes it: kept
  // otherwise, rather than free a code nobody then signs in with.
  const retired =
    handover &&
    route &&
    handover.username === routeSignInName(route.code) &&
    username === handover.username
      ? await freeRetiredUsername(handover.username)
      : null;

  const after: EditableAccount = {
    role,
    username,
    route: route?.code ?? null,
    supervisor: supervisor?.username ?? null,
    regions: regions.map((r) => r.code),
    phone,
    email,
  };
  const audit = accountEditAudit(before, after);
  // Nothing to change, nothing to record.
  if (!audit) return { changed: [], username, notes: [] };

  const notes: string[] = [];
  if (handover && route) notes.push(...(await handOverNotes(handover, route.code, retired)));
  if (routeChanged && (target.ownedRoute || strandedCreates.length > 0)) {
    const withdrawn = new Set(strandedCreates.map((e) => e.id));
    const [inReview, inReviewCreates, sentBackIds] = await Promise.all([
      prisma.customerEdit.count({
        where: { submittedById: target.id, state: EditState.SUBMITTED },
      }),
      // Security review: in review, a new customer stays with its route's
      // approvers; sent back after the move, he cannot send it again. The
      // routes they were started on are named: not always the one he leaves.
      route
        ? prisma.customerEdit.findMany({
            where: {
              submittedById: target.id,
              process: EditProcess.CREATE,
              state: EditState.SUBMITTED,
              branchDrafts: { some: { routeId: { not: route.id } } },
            },
            select: {
              branchDrafts: {
                where: { routeId: { not: route.id } },
                select: { route: { select: { code: true } } },
              },
            },
          })
        : [],
      openReturnedIds(prisma, target.id),
    ]);
    notes.push(
      ...routeMoveNotes({
        who: target.fullName,
        fromRoute: target.ownedRoute?.code ?? strandedFrom.join(', '),
        inReview,
        inReviewCreates: {
          count: inReviewCreates.length,
          routes: [
            ...new Set(inReviewCreates.flatMap((e) => e.branchDrafts.map((b) => b.route.code))),
          ].sort(compareCodes),
        },
        sentBack: sentBackIds.filter((id) => !withdrawn.has(id)).length,
        withdrawn: withdrawn.size,
        withdrawnRoutes: strandedFrom,
        leaver: !route,
      })
    );
  }
  if (before.supervisor !== after.supervisor && target.isActive) {
    const from = target.supervisor
      ? { name: target.supervisor.fullName, role: target.supervisor.role }
      : null;
    const to = supervisor ? { name: supervisor.fullName, role: supervisor.role } : null;
    const waiting =
      from?.role === Role.SUPERVISOR || to?.role === Role.SUPERVISOR
        ? await prisma.customerEdit.count({
            where: {
              submittedById: target.id,
              state: EditState.SUBMITTED,
              OR: [{ pendingRole: Role.SUPERVISOR }, { pendingRole: null }],
            },
          })
        : 0;
    notes.push(...supervisorStepNotes({ who: target.fullName, waiting, from, to }));
  }
  if (username !== target.username) {
    notes.push(`${target.fullName} now signs in as ${username}.`);
  }

  const revoke = revokesSessions(before, after);
  const env = await getAuditEnvelope(me.id);
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      if (handover && route) {
        await handOverRoute(tx, env, {
          from: handover,
          routeId: route.id,
          routeCode: route.code,
          retired,
          toUsername: username,
        });
      }
      // His new-customer requests the change would strand, withdrawn as
      // withdrawCreateCore (services/creates.ts) withdraws one: closed for good
      // (REJECTED), the clock stopped, the decision fields saying who and why.
      // Claimed on the state and cycle read above: one he sent or changed since
      // is not withdrawn, and nothing is saved.
      for (const e of strandedCreates) {
        const claim = await tx.customerEdit.updateMany({
          where: { id: e.id, state: e.state, cycle: e.cycle, submittedById: target.id },
          data: {
            state: EditState.REJECTED,
            pendingRole: null,
            slaDueAt: null,
            slaBreachedAt: null,
            lastEscalatedAt: null,
            escalationLevel: 0,
            reviewedById: me.id,
            reviewedAt: now,
            decisionReason: route
              ? `Withdrawn by the Data Steward when your route changed to ${route.code}: it could not be sent again from that route. The salesman of the shop's route adds it afresh.`
              : 'Withdrawn by the Data Steward when your role changed: it can no longer be sent. The salesman of the shop’s route adds it afresh.',
            decisionCategory: 'withdrawn',
          },
        });
        if (claim.count === 0) {
          throw new ValidationError({
            withdrawCreates: `One of ${target.fullName}'s new-customer requests changed while this was being saved. Nothing was saved — reload the page and try again.`,
          });
        }
        await writeAudit(tx, env, {
          action: 'UPDATE',
          entityType: 'CustomerEdit',
          entityId: e.id,
          reason: 'withdrawn with an account edit',
          after: {
            process: 'CREATE',
            state: EditState.REJECTED,
            from: e.state,
            cycle: e.cycle,
            route: route?.code ?? null,
          } as unknown as Prisma.InputJsonValue,
        });
      }
      await tx.user.update({
        where: { id: target.id },
        data: {
          role,
          username,
          phone,
          email,
          ownedRouteId: route?.id ?? null,
          supervisorId: supervisor?.id ?? null,
          managedRegions: { set: regions.map((r) => ({ id: r.id })) },
          // Owner decision 8, with the revocation disable and reset use (AUTH-12).
          ...(revoke ? { sessionsRevokedAt: now } : {}),
        },
      });
      await writeAudit(tx, env, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: target.id,
        before: audit.before,
        after: audit.after,
        reason: 'account_edit',
      });
    });
  } catch (err) {
    // Another save took the route, the name or the e-mail between the checks
    // and this one.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      const fields = createClashFields(err);
      if (fields.username) {
        throw new ValidationError({
          routeSignIn: 'That sign-in name was taken meanwhile. Nothing was saved.',
        });
      }
      if (fields.ownedRouteId) {
        throw new ValidationError({
          ownedRouteId: 'That route was given to someone else meanwhile. Nothing was saved.',
        });
      }
      if (fields.email) throw new ValidationError({ contactAddress: fields.email });
      throw new ValidationError(fields);
    }
    throw err;
  }
  logger.info(
    {
      actorId: me.id,
      userId: target.id,
      changed: changedFields(before, after),
      revoked: revoke,
      handover: !!handover,
      withdrawnCreates: strandedCreates.length,
    },
    'user.account_edit'
  );

  revalidatePath('/users');
  revalidatePath('/routes');
  revalidateTag('ref:users'); // role, route and supervisor are all in the cached list
  if (strandedCreates.length > 0) {
    revalidatePath('/work');
    revalidatePath('/today');
    revalidatePath('/rejected');
  }
  return { changed: changedFields(before, after), username, notes };
}

/**
 * F1 / X-IMPORTS-4 (the e-mail half): the Steward sets or clears an account's
 * e-mail address on /users.
 *
 * The address is where the notification e-mail (lib/email/drain.ts) goes, and
 * before this nothing in the app could change one after the account existed: it
 * was typed at creation or written by the account import, which can overwrite a
 * value but never clear one. Every Manager, Accountant and Finance Manager
 * address therefore has to be entered by a Steward, because canMutateUser lets a
 * Manager administer only the field force and nobody edit their own account
 * here (self-service is /profile, which shows the address read-only).
 *
 * STEWARD only, deliberately narrower than the other user actions: a wrong
 * address sends work alerts to someone else's mailbox, and the approver tier is
 * Steward-provisioned already (SR-USR-01).
 *
 * The value is trimmed and lower-cased before it is checked, and '' clears it.
 * User.email is unique but case-sensitive, so the clash check here ignores case:
 * two accounts holding one mailbox in different cases would each be mailed.
 * The audit row names the field, never the value (AuditLog is append-only, so a
 * value written there cannot be erased: lib/account-import.ts PERSONAL_FIELDS).
 * The form field is called contactAddress, not email: a browser's password
 * manager keys its autofill off names like that (users-autofill-guard).
 */
const contactAddressRule = z.string().toLowerCase().email().max(200);

export async function updateUserEmailAction(formData: FormData): SafeAction<void> {
  return runAction(() => updateUserEmailCore(formData));
}

async function updateUserEmailCore(formData: FormData) {
  const me = await requireUserAdmin();
  if (me.role !== Role.STEWARD) {
    throw new ForbiddenError('Only a Steward can change an account’s e-mail address.');
  }
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new ValidationError({ userId: 'required' });
  const raw = String(formData.get('contactAddress') ?? '').trim();
  let email: string | null = null;
  if (raw !== '') {
    const parsed = contactAddressRule.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError({
        contactAddress: 'Enter a valid e-mail address, or leave the box empty to clear it.',
      });
    }
    email = parsed.data;
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, email: true },
  });
  if (!target) throw new NotFoundError('User not found.');
  const guard = canMutateUser(
    { id: me.id, role: me.role, username: me.username },
    { id: target.id, role: target.role }
  );
  if (!guard.ok) throw new ForbiddenError(guard.reason);
  // Nothing to change, nothing to record.
  if ((target.email ?? null) === email) return;

  if (email) {
    const clash = await prisma.user.findFirst({
      where: { id: { not: userId }, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError({ contactAddress: 'That e-mail is already used by another account.' });
    }
  }

  const env = await getAuditEnvelope(me.id);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { email } });
      await writeAudit(tx, env, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        after: { changed: ['email'] },
        reason: email ? 'email_set' : 'email_cleared',
      });
    });
  } catch (err) {
    // Another account took the address between the check above and this write.
    // Mapped outside the transaction, as on create.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      const fields = createClashFields(err);
      throw new ValidationError(
        fields.email ? { contactAddress: fields.email } : { contactAddress: 'That e-mail is already used by another account.' }
      );
    }
    throw err;
  }
  logger.info({ actorId: me.id, userId, cleared: email === null }, 'user.email_update');
  revalidatePath('/users');
}

// A user's own password change (AUTH-16) is services/password.ts, and the reuse
// and history rules both paths share are lib/password-policy.ts (X-AUTH-1).
