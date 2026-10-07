/**
 * Owner decision 8 (2026-10-07): the Data Steward edits an existing account on
 * /users — a salesman's route and supervisor, a Manager's or Accountant's
 * regions, the role, the phone and the e-mail — and replaces the salesman of a
 * route there:
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
 *   - a route has one salesman (User.ownedRouteId is unique). Both take a route
 *     from a DISABLED holder, the leaver, and refuse while the holder is active;
 *     the import moves it off an active one only on a row that says
 *     change_route = yes, as it changes a role only on change_role = yes;
 *   - a supervisor covers the region of the route (supervisorCoverIssue), on
 *     both paths, judged when the supervisor, the route or the role changes;
 *   - a salesman signs in with his route's code, lower-cased (Route.code in
 *     lib/compliance/pii-classification.ts; scripts/golive/build-masters.ts and
 *     verify-credentials.ts). The import keys accounts by that name, so it will
 *     not put another full name on a salesman's account unless the row says
 *     change_name = yes (importNameIssue): after a hand-over on /users an older
 *     sheet would otherwise write the leaver's name, phone and supervisor onto
 *     the joiner. The form keeps the rule by moving the code with the person:
 *     the leaver's sign-in name is retired when the joiner takes the code, and a
 *     moved salesman can take the new route's code as his;
 *   - a salesman's new-customer requests that are not in review (drafts, or sent
 *     back to him) were started on his route, and services/creates.ts refuses
 *     to save or send one again from another route: he can only withdraw it. A
 *     route change is refused while he has any started on another route
 *     (strandedCreatesIssue); the form can withdraw them with the move instead,
 *     the import cannot.
 */
import type { Role } from '@prisma/client';
import { nameKey } from './name-key';

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

/**
 * The one order region codes are kept in, before and after an edit alike, so an
 * unchanged set never reads as a change (which would sign the person out and
 * write an audit row). By code unit, not by locale: localeCompare and a bare
 * sort() disagree on a code with "_" in it, which the region code rule allows.
 */
export function compareCodes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  /** Managed region codes, sorted with compareCodes. */
  regions: string[];
  phone: string | null;
  email: string | null;
};

/**
 * Written into the ledger as values: what the account may see and do, and the
 * name it signs in with — as the account import's audit does (VALUE_FIELDS).
 */
const VALUE_FIELDS = ['role', 'username', 'route', 'supervisor', 'regions'] as const;
/**
 * Named in the ledger, never copied into it: AuditLog is append-only, so a phone
 * number written there could never be erased (lib/account-import.ts
 * PERSONAL_FIELDS, docs/compliance/PDPL-ASSESSMENT.md Q4). The e-mail is named
 * the same way, as the separate e-mail edit names it (updateUserEmailAction).
 */
const PERSONAL_FIELDS = ['phone', 'email'] as const;

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
 * /approvals queue). He still sees them on Work and is told the decision. The
 * one approver that follows the salesman is a SUPERVISOR-role supervisor at the
 * first step (supervisorStepNotes). But a new-customer request among them that
 * is sent back after the move cannot be sent again from his new route
 * (services/creates.ts refuses it): he withdraws it, and the salesman of the
 * route it was started on adds the shop afresh (`inReviewCreates`). That route
 * is named from the requests themselves: a salesman moved twice can still have
 * some in review from the route before the one he now leaves.
 *
 * Updates SENT BACK to him stay his too. One on a customer of his old route can
 * no longer be sent again, since he cannot open that customer; he clears it on
 * Needs correction, and the route's new salesman sends a fresh one.
 *
 * New-customer requests that are not in review (drafts, or sent back) cannot
 * follow him: services/creates.ts refuses to send one again from another route.
 * The change is refused while he has any (strandedCreatesIssue) unless the
 * Steward withdraws them with it; `withdrawn` counts those, and `sentBack`
 * leaves them out.
 *
 * A leaver (disabled) sends nothing again; his drafts and sent-back requests no
 * longer hold the shop or the CR number for anyone (lib/create-guards.ts).
 */
export function routeMoveNotes(p: {
  who: string;
  fromRoute: string;
  inReview: number;
  /**
   * Of those, the new-customer requests started on another route than his new
   * one, and the codes of the routes they were started on.
   */
  inReviewCreates?: { count: number; routes: string[] };
  /** Sent back to him and still waiting on him, not counting withdrawn ones. */
  sentBack: number;
  /** New-customer requests withdrawn with this change. */
  withdrawn?: number;
  /** He sends nothing again: disabled (the leaver), or given a role with no route. */
  leaver?: boolean;
}): string[] {
  const notes: string[] = [];
  if (p.inReview > 0) {
    notes.push(
      `${p.who} has ${p.inReview} request(s) in review. They stay with the same approvers — the Managers and Accountant of each customer's region — and are decided as before.${
        p.inReviewCreates?.count && !p.leaver
          ? ` New-customer requests among them (${p.inReviewCreates.count}): if one is sent back to him, he cannot send it again from his new route — he withdraws it on Needs correction, and the salesman of ${p.inReviewCreates.routes.join(' or ') || 'its route'} adds the shop afresh.`
          : ''
      }`
    );
  }
  if (p.sentBack > 0) {
    notes.push(
      p.leaver
        ? `${p.who} has ${p.sentBack} request(s) sent back to him, which nobody will send again: the new salesman of ${p.fromRoute} sends fresh ones.`
        : `${p.who} has ${p.sentBack} request(s) sent back to him. One on a customer of route ${p.fromRoute} cannot be sent again from his new route: he clears it on Needs correction, and the salesman of ${p.fromRoute} sends a fresh one.`
    );
  }
  if (p.withdrawn) {
    notes.push(
      `${p.withdrawn} new-customer request(s) ${p.who} had started on route ${p.fromRoute} (drafts, or sent back to him) were withdrawn with this change. The salesman of ${p.fromRoute} adds those shops afresh.`
    );
  }
  return notes;
}

/**
 * Owner decision 8 (review): a change of route — or of role, to one with no
 * route — while the salesman has new-customer requests that are not in review
 * and were started on another route: drafts, or sent back to him.
 * services/creates.ts refuses to save or send one again from another route, so
 * after the move he could only withdraw them; with no route at all he can never
 * send them. Until they are closed they hold their shops and CR numbers for
 * every salesman (lib/create-guards.ts). Null when there are none, or the
 * Steward withdraws them with the change (`withdraw`).
 */
export function strandedCreatesIssue(p: {
  who: string;
  count: number;
  /** The codes of the routes they were started on. */
  fromRoutes: string[];
  /** The route he is given; null when the new role has none. */
  toRoute: string | null;
  withdraw: boolean;
}): string | null {
  if (p.count === 0 || p.withdraw) return null;
  const from = p.fromRoutes.length > 0 ? `route ${p.fromRoutes.join(', ')}` : 'his route';
  const why = p.toRoute
    ? `After the move he cannot send them again from route ${p.toRoute}, only withdraw them.`
    : 'Without a route he can never send them again, and until they are closed they hold their shops and CR numbers for every salesman.';
  return `${p.who} has ${p.count} new-customer request(s) started on ${from} that are not in review (drafts, or sent back to him). ${why} Ask him to send them first — in review they stay with the approvers of ${from}, but if one is sent back after the move he cannot send it again and withdraws it — or to withdraw them; or tick "Withdraw them with this change".`;
}

/** The import's words for strandedCreatesIssue: it has no tick box, so it points at /users. */
export function strandedCreatesImportIssue(username: string, count: number): string {
  return `"${username}" has ${count} new-customer request(s) that are not in review (drafts, or sent back to him), started on a route this row takes him off. Nothing was written. Afterwards he could not send them again from his new route, only withdraw them. Ask him to send or withdraw them first, or make this change on Users (Edit account), which can withdraw them with it.`;
}

/**
 * Owner decision 8 (review): the one approver that follows the salesman rather
 * than the customer. At the Supervisor step a SUPERVISOR-role account decides
 * the requests of whoever reports to him at the time he decides
 * (lib/permissions.ts canApproveSpecificEdit reads submittedBy.supervisorId, with
 * no region check), while a Manager decides by the customer's region. So a new
 * supervisor takes that step of the waiting requests from an old Supervisor, or
 * gives it to a new one. No Supervisor accounts exist at go-live.
 */
export function supervisorStepNotes(p: {
  who: string;
  /** His requests in review waiting at the Supervisor step. */
  waiting: number;
  from: { name: string; role: Role } | null;
  to: { name: string; role: Role } | null;
}): string[] {
  const loses = p.from?.role === 'SUPERVISOR';
  const gains = p.to?.role === 'SUPERVISOR';
  if (p.waiting === 0 || (!loses && !gains)) return [];
  return [
    [
      `${p.waiting} of ${p.who}'s requests wait at the Supervisor step, which a Supervisor decides for whoever reports to him at the time.`,
      ...(loses ? [`${p.from!.name} can no longer decide them.`] : []),
      ...(gains ? [`${p.to!.name} now can, wherever the customer is.`] : []),
      'The Managers of each customer’s region can decide them either way.',
    ].join(' '),
  ];
}

/**
 * The account import (services/imports.ts) finds an account by its sign-in name,
 * and a salesman's sign-in name is his route's code. After a hand-over on /users
 * the code belongs to the joiner, so a sheet made before it names the leaver on
 * the joiner's row: applied, it wrote the leaver's full name, phone and
 * supervisor onto the joiner's account. A row for a stored SALESMAN whose
 * full_name is not his (compared as nameKey compares names: spaces and case do
 * not count) is therefore held back unless it says change_name = yes, the way a
 * role changes only on change_role = yes. `retired` is the sign-in name the
 * previous salesman was given when the code was handed on, when there is one.
 * Null when the row may go ahead.
 */
export function importNameIssue(p: {
  username: string;
  storedRole: Role;
  storedName: string;
  rowName: string;
  wantsNameChange: boolean;
  retired: string | null;
}): string | null {
  if (p.storedRole !== 'SALESMAN' || p.wantsNameChange) return null;
  if (nameKey(p.storedName) === nameKey(p.rowName)) return null;
  const fix = 'If it is the same person and the name is being corrected, set change_name to yes.';
  return p.retired
    ? `"${p.username}" was handed to a new salesman on Users (the previous one now signs in as "${p.retired}"), and this row's full_name is not his. Nothing was written. The sheet is older than the hand-over: take this row out. ${fix}`
    : `this row's full_name is not the name of the salesman who signs in as "${p.username}". Nothing was written. A route is handed to a new salesman on Users (disable the leaver, then create the joiner), not by renaming the leaver's account here. ${fix}`;
}

/**
 * supervisorCoverIssue as the account import applies it, in its words: the
 * supervisor a salesman row leaves him with (the one it names, or the one he
 * keeps when the cell is blank) covers the region of his route. The caller
 * judges it, as the form does, only when the supervisor, the route or the role
 * changes. Null when he covers it.
 */
export function importSupervisorCoverIssue(p: {
  username: string;
  supervisorUsername: string;
  supervisor: SupervisorCandidate | null;
  targetId: string | null;
  routeCode: string;
  routeRegionId: string;
  regionCode: string;
}): string | null {
  const s = p.supervisor;
  if (
    !supervisorCoverIssue({
      supervisor: s,
      targetId: p.targetId,
      routeRegionId: p.routeRegionId,
    })
  ) {
    return null;
  }
  const sup = `supervisor "${p.supervisorUsername}"`;
  const why =
    !s || !s.isActive
      ? `${sup} is deactivated or missing`
      : !SUPERVISING_ROLES.includes(s.role)
        ? `${sup} is ${s.role}, and only a SUPERVISOR or MANAGER can supervise`
        : s.id === p.targetId
          ? 'an account cannot report to itself'
          : `${sup} does not cover region ${p.regionCode}, where route ${p.routeCode} is: a MANAGER must manage the region, and a SUPERVISOR's team must work in it`;
  return `${why}. Nothing was written for "${p.username}". Name a supervisor who covers region ${p.regionCode} in supervisor_username.`;
}

/**
 * The account import's words when a row would take a route from a salesman
 * whose account is active, and does not say change_route = yes. Null when it may.
 */
export function importRouteHolderIssue(p: {
  username: string;
  routeCode: string;
  holder: { username: string; isActive: boolean } | null;
  wantsRouteChange: boolean;
}): string | null {
  const h = p.holder;
  if (!h || h.username === p.username || !h.isActive || p.wantsRouteChange) return null;
  return `route ${p.routeCode} is worked by "${h.username}", whose account is active. Nothing was written for "${p.username}". A route has one salesman: disable "${h.username}" on Users first if he has left, or set change_route to yes to move the route to "${p.username}" (then "${h.username}" has no route unless his own row gives him one).`;
}
