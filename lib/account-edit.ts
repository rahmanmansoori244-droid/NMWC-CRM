/**
 * Owner decision 8 (2026-10-07): the Data Steward edits an existing account on
 * /users — a salesman's route and supervisor, a Manager's or Accountant's
 * regions, the role and the phone — and replaces the salesman of a route there:
 * disable the leaver, then create the joiner (or edit an existing account) onto
 * the route. The create form sets a new Manager's or Accountant's regions.
 *
 * The rules live here, not in services/users.ts, because a 'use server' module
 * may export only async actions, and each rule is proved on its own in
 * tests/unit/account-edit-rules.test.ts. Nothing here reads the database.
 *
 * How the rules fit the account import (services/imports.ts, lib/account-import.ts):
 *   - a Manager or Accountant manages at least one region, as the import refuses
 *     one that would manage none;
 *   - a supervisor is an active SUPERVISOR or MANAGER (the import's AUTH-06), and
 *     here also one who covers the route's region;
 *   - a route has one salesman (User.ownedRouteId is unique). The import takes a
 *     route from whoever holds it; the form takes it only from a DISABLED holder,
 *     the leaver, and refuses while the holder is active;
 *   - a salesman signs in with his route's code, lower-cased (Route.code in
 *     lib/compliance/pii-classification.ts; scripts/golive/build-masters.ts and
 *     verify-credentials.ts). The import keeps that by updating the account named
 *     by the code. The form keeps it by moving the code with the person: the
 *     leaver's sign-in name is retired when his route is handed on, and a moved
 *     salesman can take the new route's code as his sign-in name.
 */
import type { Role } from '@prisma/client';

/** How /users names each role (the create form and the Edit account dialog). */
export const ROLE_LABELS: Record<Role, string> = {
  SALESMAN: 'Salesman',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager',
  STEWARD: 'Data Steward',
  VIEWER: 'Read-only Viewer',
  ACCOUNTANT: 'Accountant',
  FINANCE_MANAGER: 'Finance Manager',
  GM: 'GM',
};

/** Roles whose data scope is the regions they manage (User.managedRegions). */
export const REGION_SCOPED_ROLES: readonly Role[] = ['MANAGER', 'ACCOUNTANT'];
/** Roles that report to someone in this CRM (the create form's Supervisor field). */
export const SUPERVISED_ROLES: readonly Role[] = ['SALESMAN', 'SUPERVISOR'];
/** Roles that can supervise: the import's and the create form's AUTH-06. */
export const SUPERVISING_ROLES: readonly Role[] = ['SUPERVISOR', 'MANAGER'];

/** The sign-in name of the salesman who works the route with this code. */
export function routeSignInName(routeCode: string): string {
  return routeCode.trim().toLowerCase();
}

/**
 * The sign-in name a leaver keeps once his route is handed on, so the route's
 * code is free for the joiner. Dated in Oman time; `attempt` > 1 adds a counter
 * for the rare second hand-over of the same name on the same day.
 */
export function retiredUsername(username: string, omanIsoDay: string, attempt = 1): string {
  const base = `${username}.left.${omanIsoDay.replace(/-/g, '')}`;
  return attempt > 1 ? `${base}.${attempt}` : base;
}

export type RouteHolder = {
  id: string;
  username: string;
  fullName: string;
  isActive: boolean;
} | null;

/**
 * May the route be given to `targetId`? A route has one salesman, so:
 *   - nobody holds it, or the target does already: it is free;
 *   - a disabled account holds it (the leaver): it is handed over, when the actor
 *     may hand routes over (the Steward);
 *   - an active account holds it: refused. The holder is disabled first if he has
 *     left, or moved to another route first.
 */
export function routeHandover(p: {
  routeCode: string;
  holder: RouteHolder;
  targetId: string | null;
  mayHandOver: boolean;
}):
  | { kind: 'free' }
  | { kind: 'handover'; from: NonNullable<RouteHolder> }
  | { kind: 'refused'; message: string } {
  const h = p.holder;
  if (!h || h.id === p.targetId) return { kind: 'free' };
  if (h.isActive) {
    return {
      kind: 'refused',
      message: `Route ${p.routeCode} is worked by ${h.fullName} (${h.username}), whose account is active. A route has one salesman: disable him first if he has left, or move him to another route first.`,
    };
  }
  if (!p.mayHandOver) {
    return { kind: 'refused', message: 'That route is already assigned to another salesman.' };
  }
  return { kind: 'handover', from: h };
}

export type SupervisorCandidate = {
  id: string;
  role: Role;
  isActive: boolean;
  /** The regions he manages (a MANAGER). */
  managedRegionIds: string[];
  /** The regions of the routes his OTHER reports work (a SUPERVISOR). */
  teamRegionIds: string[];
};

/**
 * Null when `supervisor` may supervise an account on a route in `routeRegionId`
 * (null when the account works no route). An active SUPERVISOR or MANAGER, never
 * the account itself, and one who covers the route's region: a Manager who
 * manages it, or a Supervisor whose team already works there or who has no team
 * yet. A supervisor outside the region is told of every request the salesman
 * sends and can decide none of them (lib/permissions.ts canApproveSpecificEdit).
 */
export function supervisorCoverIssue(p: {
  supervisor: SupervisorCandidate | null;
  targetId: string | null;
  routeRegionId: string | null;
  routeRegionCode?: string | null;
}): string | null {
  const s = p.supervisor;
  if (!s || !s.isActive) return 'Supervisor must exist and be active.';
  if (!SUPERVISING_ROLES.includes(s.role))
    return 'The supervisor must be a Supervisor or a Manager.';
  if (p.targetId && s.id === p.targetId) return 'An account cannot report to itself.';
  if (!p.routeRegionId) return null;
  const where = p.routeRegionCode ?? 'the route’s region';
  if (s.role === 'MANAGER') {
    return s.managedRegionIds.includes(p.routeRegionId)
      ? null
      : `That Manager does not manage ${where}, where this route is. Choose one who does.`;
  }
  return s.teamRegionIds.length === 0 || s.teamRegionIds.includes(p.routeRegionId)
    ? null
    : `That Supervisor’s team works outside ${where}, where this route is. Choose one who covers it.`;
}

/** What services/users.ts updateUserAccountAction answers on success. */
export type AccountEditResult = {
  /** The fields that changed (changedFields); empty when the save changed nothing. */
  changed: string[];
  /** The account's sign-in name after the save. */
  username: string;
  /** Sentences for the Steward: a hand-over, a retired sign-in name, open requests. */
  notes: string[];
};

/** What the account edit compares, before and after. Never the password. */
export type EditableAccount = {
  role: Role;
  username: string;
  /** The owned route's code. */
  route: string | null;
  /** The supervisor's username. */
  supervisor: string | null;
  /** Managed region codes, sorted. */
  regions: string[];
  phone: string | null;
};

/**
 * Written into the ledger as values: what the account may see and do, and the
 * name it signs in with — as the account import's audit does (VALUE_FIELDS).
 */
const VALUE_FIELDS = ['role', 'username', 'route', 'supervisor', 'regions'] as const;
/**
 * Named in the ledger, never copied into it: AuditLog is append-only, so a phone
 * number written there could never be erased (lib/account-import.ts
 * PERSONAL_FIELDS, docs/compliance/PDPL-ASSESSMENT.md Q4).
 */
const PERSONAL_FIELDS = ['phone'] as const;

type Json = Record<string, string | string[] | null>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields that changed, value fields first. Empty when nothing did. */
export function changedFields(before: EditableAccount, after: EditableAccount): string[] {
  return [...VALUE_FIELDS, ...PERSONAL_FIELDS].filter((f) => !same(before[f], after[f]));
}

/**
 * The before/after of the edit's audit row, with only the fields that changed —
 * or null when nothing did, so a save that changes nothing records nothing.
 */
export function accountEditAudit(
  before: EditableAccount,
  after: EditableAccount
): { before: Json; after: Json } | null {
  const b: Json = {};
  const a: Json = {};
  for (const f of VALUE_FIELDS) {
    if (same(before[f], after[f])) continue;
    b[f] = before[f];
    a[f] = after[f];
  }
  const named = PERSONAL_FIELDS.filter((f) => before[f] !== after[f]);
  if (Object.keys(a).length === 0 && named.length === 0) return null;
  if (named.length > 0) a.changed = [...named];
  return { before: b, after: a };
}

/**
 * Owner decision 8: a change of role or regions ends the account's sessions, as
 * a disable or a password reset does, so it takes effect at once rather than
 * when the person next signs in.
 */
export function revokesSessions(before: EditableAccount, after: EditableAccount): boolean {
  return before.role !== after.role || !same(before.regions, after.regions);
}

/**
 * What the Steward is told about a salesman's open work when he leaves a route.
 *
 * Requests IN REVIEW stay his and stay with the same approvers: the Supervisor
 * step is decided by a Manager of the customer's region (a new customer's: the
 * region of the route it was sent from), the Accountant step by that region's
 * Accountant, and the Finance Manager and GM steps org-wide — none of which
 * depends on the salesman's route (lib/permissions.ts canActOnStep, the
 * /approvals queue). He still sees them on Work and is told the decision.
 *
 * Requests SENT BACK to him stay his too. One on a customer of his old route can
 * no longer be sent again, since he cannot open that customer; he clears it on
 * Needs correction, and the route's new salesman sends a fresh one. A leaver
 * (disabled) sends nothing again; his drafts and sent-back new-customer requests
 * no longer hold the shop for anyone (lib/create-guards.ts). Nor does someone
 * who is no longer a salesman at all.
 */
export function routeMoveNotes(p: {
  who: string;
  fromRoute: string;
  inReview: number;
  sentBack: number;
  /** He sends nothing again: disabled (the leaver), or given a role with no route. */
  leaver?: boolean;
}): string[] {
  const notes: string[] = [];
  if (p.inReview > 0) {
    notes.push(
      `${p.who} has ${p.inReview} request(s) in review. They stay with the same approvers — the Managers and Accountant of each customer's region — and are decided as before.`
    );
  }
  if (p.sentBack > 0) {
    notes.push(
      p.leaver
        ? `${p.who} has ${p.sentBack} request(s) sent back to him, which nobody will send again: the new salesman of ${p.fromRoute} sends fresh ones.`
        : `${p.who} has ${p.sentBack} request(s) sent back to him. One on a customer of route ${p.fromRoute} cannot be sent again from his new route: he clears it on Needs correction, and the salesman of ${p.fromRoute} sends a fresh one.`
    );
  }
  return notes;
}
