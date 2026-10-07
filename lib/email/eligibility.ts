/**
 * F1 (2026-10-05): which claimed outbox rows are e-mailed, to whom, in which
 * digest — decided on the state of things NOW, not when the row was written.
 * Pure: the drain (lib/email/drain.ts) loads the rows, the recipients and the
 * requests, and this module decides.
 *
 * A row is e-mailed only when every one of these holds at send time:
 *   - it is younger than the maximum age (an evening's rows go out next morning;
 *     a week-old one never does);
 *   - its kind is e-mailed (EMAIL_KINDS) and its recipient's CURRENT role is on
 *     the allowlist (EMAIL_ROLES: never STEWARD, VIEWER or SALESMAN, and a role
 *     added later fails closed; the GM — owner decision 6 — only for a row that
 *     asks him to act or chase, EMAIL_ACT_ONLY_ROLES), the account is active, is
 *     not a seeded demo account (lib/demo-accounts.ts), and its address is an
 *     address;
 *   - it has not been read in the app;
 *   - its request still exists and, for a row that asks its recipient to act,
 *     still waits on HIM: open, with the request's recorded pending role on the
 *     step its pointer names, and HE can decide that step by the very rule the
 *     decision applies — `canActOnStep` with the inputs `approveEditCore` gives it
 *     (the request's scope regions: a new-customer request's draft routes,
 *     otherwise the customer's live branches; his managed regions; who decided
 *     the other steps this cycle), and for a reactivation the decide gate of
 *     services/reactivations.ts (a Manager of the branch's region). A request
 *     stays SUBMITTED through every step of a new-customer chain, so "still
 *     open" alone would e-mail a Supervisor "please review" about a request
 *     already at the GM (challenges, item 29). The same check tells
 *     EDIT_STAGE_ADVANCED's two meanings apart: "now at your step" is sent,
 *     "your request advanced" (to the salesman) never is. And it keeps the
 *     e-mail from a supervisor the in-app writer names but the page refuses: a
 *     Manager who does not manage the salesman's route region, or one the
 *     salesman was moved away from after he submitted (fixer review 2026-10-05);
 *   - for a late request (SLA_BREACH, owner decision 6), the request is still
 *     open and he is still someone the escalation tells about it
 *     (escalationReaches: lib/escalation.ts's plan, a Manager only over the
 *     request's regions) and can act on it: a late GM step's Managers are told
 *     in-app for visibility only, and not e-mailed.
 * One digest per recipient per run. The gap and the caps put work first: a
 * digest that asks him to act waits only for an earlier one that also did (an
 * information-only e-mail does not hold back his "please review"); when a cap
 * binds, digests with something to act on go first, oldest first, then the
 * information-only ones; and information-only digests may use only their share
 * of the rolling daily cap, so a busy day of FYI cannot spend the approvers' quota.
 */
import { Role } from '@prisma/client';
import { parseChain } from '../approval-chains';
import { canActOnStep } from '../permissions';
import { escalationPlan } from '../escalation';
import {
  EMAIL_ACT_ONLY_ROLES,
  EMAIL_DELIVERY,
  EMAIL_KINDS,
  EMAIL_ROLES,
  MUST_ACT_KINDS,
  type EmailDeliveryPolicy,
} from '../notify-policy';
import { isDemoAccount } from '../demo-accounts';
import { isEmailAddress } from './config';
import type { DigestItem, RequestType } from './digest';

/** How the outbox finished with a row (Notification.emailStatus). */
export type EmailStatus =
  | 'SENT'
  | 'FAILED'
  | 'SKIPPED_STALE'
  | 'SKIPPED_KIND'
  | 'SKIPPED_ROLE'
  | 'SKIPPED_DEMO'
  | 'SKIPPED_INACTIVE'
  | 'SKIPPED_NO_ADDRESS'
  | 'SKIPPED_READ'
  | 'SKIPPED_RESOLVED'
  | 'PRE_FEATURE';

export type SkipStatus = Extract<EmailStatus, `SKIPPED_${string}`>;

/** A claimed row: ids, kind and times only. Never the title or the body. */
export type OutboxRow = {
  id: string;
  userId: string;
  kind: string;
  editId: string | null;
  createdAt: Date;
  readAt: Date | null;
};

export type Recipient = {
  id: string;
  role: Role;
  isActive: boolean;
  email: string | null;
  username: string;
  /** The regions he manages now (User.managedRegions): his scope as an approver. */
  managedRegionIds: string[];
};

/** The request as it stands now. */
export type RequestNow = {
  id: string;
  state: string;
  process: string;
  target: string;
  isReactivation: boolean;
  approvalChain: unknown;
  currentStepIndex: number;
  /** The role the request waits on, as the request records it (null once decided). */
  pendingRole: Role | null;
  submittedById: string;
  submitterSupervisorId: string | null;
  /** Who decided a step OTHER than the current one in the current cycle. */
  otherStepActorIds: string[];
  /**
   * The regions an approver must manage to act on it, read now, as the decision
   * reads them: a new-customer request's draft routes' regions; a reactivation's
   * branch region; otherwise the customer's live branches' regions.
   */
  scopeRegionIds: string[];
};

export function requestTypeOf(edit: Pick<RequestNow, 'process' | 'target' | 'isReactivation'>): RequestType {
  if (edit.process === 'CREATE') return 'CREATE';
  if (edit.isReactivation) return 'REACTIVATION';
  // Only close-shop and reactivation requests target a branch.
  if (edit.target === 'BRANCH') return 'CLOSE';
  return 'UPDATE';
}

/** Does this request wait on this recipient now — and can he act on it? */
export function waitsOn(recipient: Recipient, kind: string, edit: RequestNow): boolean {
  if (edit.state !== 'SUBMITTED') return false;
  if (recipient.id === edit.submittedById) return false;
  if (kind === 'REACTIVATION_REQUESTED') {
    // approveReactivationCore / rejectReactivationCore: a Manager whose managed
    // regions include the branch's region, never the submitter.
    return (
      edit.isReactivation &&
      recipient.role === Role.MANAGER &&
      edit.scopeRegionIds.some((r) => recipient.managedRegionIds.includes(r))
    );
  }
  // A reactivation is decided on /reactivations only; nothing else asks for one.
  if (edit.isReactivation) return false;
  const step = parseChain(edit.approvalChain)[edit.currentStepIndex];
  if (!step) return false;
  // The pointer and the recorded pending role must agree on the step: a request
  // whose pendingRole moved on is not waiting on this step, whatever the index says.
  if (edit.pendingRole && edit.pendingRole !== step.role) return false;
  // The decision's own rule, with the decision's own inputs (approveEditCore):
  // the supervisor or a Manager of the scope regions at the Supervisor step, the
  // step's role in scope at a region step, any holder at a global one — never
  // the submitter, never someone who decided another step this cycle.
  return canActOnStep(
    recipient,
    step,
    { id: edit.submittedById, supervisorId: edit.submitterSupervisorId },
    {
      customerBranches: edit.scopeRegionIds.map((regionId) => ({ regionId, deletedAt: null })),
      managedRegionIds: recipient.managedRegionIds,
      priorStepActorIds: edit.otherStepActorIds,
    }
  );
}

/**
 * Owner decision 6 (2026-10-07): is this recipient still someone the escalation
 * tells about this late request? The sweep (app/api/cron/sla-escalate) wrote the
 * row to its plan's people at the time; at send time the request must still be
 * open, and he must still hold a role the plan names for the step it waits on
 * (either level — the row itself says which level reached him): a region-scoped
 * role only over one of the request's regions (/approvals/[id] refuses a Manager
 * elsewhere), the GM also where he is the sweep's fallback for a region nobody
 * covers. Never the submitter. And only someone who can act: where the plan is
 * for visibility only (a late GM step: the region's Managers are told, but
 * nobody outranks the GM, so they can neither decide it nor chase it), the row
 * stays in-app, and only someone who can decide the late step himself is
 * e-mailed — the GM, where the sweep fell back to him for a region no Manager
 * covers.
 */
export function escalationReaches(recipient: Recipient, edit: RequestNow): boolean {
  if (edit.state !== 'SUBMITTED') return false;
  if (recipient.id === edit.submittedById) return false;
  const plan = escalationPlan(edit.pendingRole, 2);
  if (plan.visibilityOnly) return waitsOn(recipient, 'EDIT_STAGE_ADVANCED', edit);
  if (plan.globalRoles.includes(recipient.role)) return true;
  if (plan.regionScopedRoles.includes(recipient.role)) {
    return edit.scopeRegionIds.some((r) => recipient.managedRegionIds.includes(r));
  }
  return plan.regionScopedRoles.length > 0 && recipient.role === Role.GM;
}

export type Verdict = { send: true; item: DigestItem } | { send: false; status: SkipStatus };

export function rowVerdict(
  row: OutboxRow,
  recipient: Recipient | undefined,
  edit: RequestNow | undefined,
  now: Date,
  policy: { maxAgeMs: number } = EMAIL_DELIVERY
): Verdict {
  if (now.getTime() - row.createdAt.getTime() > policy.maxAgeMs) return { send: false, status: 'SKIPPED_STALE' };
  if (!(EMAIL_KINDS as readonly string[]).includes(row.kind)) return { send: false, status: 'SKIPPED_KIND' };
  if (!recipient) return { send: false, status: 'SKIPPED_INACTIVE' };
  if (!EMAIL_ROLES.includes(recipient.role)) return { send: false, status: 'SKIPPED_ROLE' };
  // Owner decision 6: the GM is e-mailed work waiting on him, never information.
  if (EMAIL_ACT_ONLY_ROLES.includes(recipient.role) && isInformationKind(row.kind)) {
    return { send: false, status: 'SKIPPED_ROLE' };
  }
  if (!recipient.isActive) return { send: false, status: 'SKIPPED_INACTIVE' };
  // A seeded demo or test account (lib/demo-accounts.ts) is never a real person's
  // inbox, and production refuses its sign-in, so a link would lead nowhere.
  if (isDemoAccount(recipient.username)) return { send: false, status: 'SKIPPED_DEMO' };
  if (!isEmailAddress(recipient.email?.trim())) return { send: false, status: 'SKIPPED_NO_ADDRESS' };
  if (row.readAt) return { send: false, status: 'SKIPPED_READ' };
  if (!edit || !row.editId) return { send: false, status: 'SKIPPED_RESOLVED' };
  // "Resolved" for him: decided, moved past his step, or a step he cannot act on.
  if ((MUST_ACT_KINDS as readonly string[]).includes(row.kind) && !waitsOn(recipient, row.kind, edit)) {
    return { send: false, status: 'SKIPPED_RESOLVED' };
  }
  // A late request: still open, and he is still one the escalation tells.
  if (row.kind === 'SLA_BREACH' && !escalationReaches(recipient, edit)) return { send: false, status: 'SKIPPED_RESOLVED' };
  return {
    send: true,
    item: { kind: row.kind as DigestItem['kind'], editId: row.editId, requestType: requestTypeOf(edit) },
  };
}

export type PlannedDigest = {
  userId: string;
  role: Role;
  /** The recipient's own address (the drain sends to the redirect inbox instead, when set). */
  address: string;
  rowIds: string[];
  items: DigestItem[];
  /** Every line only informs (REQUEST_FYI): nothing in it asks him to act. */
  informationOnly: boolean;
};

export type RunPlan = {
  digests: PlannedDigest[];
  skips: Array<{ id: string; status: SkipStatus }>;
  /** Rows to hand back unsent this run (gap, caps): their claim is released. */
  deferred: string[];
  capped: boolean;
};

const MUST_ACT_FIRST: Record<string, number> = {
  REACTIVATION_REQUESTED: 0,
  EDIT_SUBMITTED: 0,
  EDIT_STAGE_ADVANCED: 0,
  SLA_BREACH: 1,
  REQUEST_FYI: 2,
};

/** A line that only informs: nothing in it asks the recipient to do anything. */
export function isInformationKind(kind: string): boolean {
  return kind === 'REQUEST_FYI';
}

/** Who was e-mailed within the gap: anything at all, and a digest with something to act on. */
export type RecentSends = { any: Set<string>; action: Set<string> };

/**
 * Pure: one run's plan. Rows the verdict refuses are skipped for good; the rest
 * become one digest per recipient, one line per request (an FYI and an action
 * row about one request are one line, the action), within the gap and the caps.
 */
export function planRun(input: {
  rows: OutboxRow[];
  recipients: Map<string, Recipient>;
  edits: Map<string, RequestNow>;
  now: Date;
  /** Recipients sent a digest within the gap, and those whose digest asked them to act. */
  recentlySent: RecentSends;
  /** Digests sent in the last 24 hours. */
  sentLast24h: number;
  /** Of those, the digests that carried information only. */
  informationSentLast24h: number;
  policy?: Pick<EmailDeliveryPolicy, 'maxAgeMs' | 'perRunCap' | 'dailyCap' | 'informationDailyCap'>;
}): RunPlan {
  const policy = input.policy ?? EMAIL_DELIVERY;
  const skips: RunPlan['skips'] = [];
  const byUser = new Map<string, { rows: OutboxRow[]; items: Map<string, DigestItem> }>();
  for (const row of input.rows) {
    const recipient = input.recipients.get(row.userId);
    const edit = row.editId ? input.edits.get(row.editId) : undefined;
    const v = rowVerdict(row, recipient, edit, input.now, policy);
    if (!v.send) {
      skips.push({ id: row.id, status: v.status });
      continue;
    }
    const entry = byUser.get(row.userId) ?? { rows: [] as OutboxRow[], items: new Map<string, DigestItem>() };
    entry.rows.push(row);
    const prev = entry.items.get(v.item.editId);
    if (!prev || MUST_ACT_FIRST[v.item.kind]! < MUST_ACT_FIRST[prev.kind]!) entry.items.set(v.item.editId, v.item);
    byUser.set(row.userId, entry);
  }

  // Work first, then oldest waiting first: when a cap binds it holds back
  // information before it holds back a "please review", and the newest before
  // the same people again.
  const informationOnly = (e: { items: Map<string, DigestItem> }) =>
    [...e.items.values()].every((i) => isInformationKind(i.kind));
  const oldest = (e: { rows: OutboxRow[] }) => Math.min(...e.rows.map((r) => r.createdAt.getTime()));
  const queue = [...byUser.entries()].sort(
    ([, a], [, b]) => Number(informationOnly(a)) - Number(informationOnly(b)) || oldest(a) - oldest(b)
  );
  const allowed = Math.max(0, Math.min(policy.perRunCap, policy.dailyCap - input.sentLast24h));
  // Information-only digests stop at their share of the day, keeping the rest of
  // the daily cap for digests that ask someone to act.
  const informationAllowed = Math.max(0, policy.informationDailyCap - input.informationSentLast24h);
  const digests: PlannedDigest[] = [];
  const deferred: string[] = [];
  let capped = false;
  let informationPlanned = 0;
  for (const [userId, entry] of queue) {
    const info = informationOnly(entry);
    // The gap, per class: an e-mail that only informed does not hold back one
    // that asks him to act; an e-mail that asked him to act holds back both.
    if (input.recentlySent.action.has(userId) || (info && input.recentlySent.any.has(userId))) {
      deferred.push(...entry.rows.map((r) => r.id));
      continue;
    }
    if (digests.length >= allowed || (info && informationPlanned >= informationAllowed)) {
      capped = true;
      deferred.push(...entry.rows.map((r) => r.id));
      continue;
    }
    if (info) informationPlanned += 1;
    const recipient = input.recipients.get(userId)!;
    digests.push({
      userId,
      role: recipient.role,
      address: recipient.email!.trim(),
      rowIds: entry.rows.map((r) => r.id),
      items: [...entry.items.values()].sort((a, b) => MUST_ACT_FIRST[a.kind]! - MUST_ACT_FIRST[b.kind]!),
      informationOnly: info,
    });
  }
  return { digests, skips, deferred, capped };
}
