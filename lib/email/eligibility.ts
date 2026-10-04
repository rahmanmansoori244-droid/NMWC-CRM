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
 *     the allowlist (EMAIL_ROLES: never GM, STEWARD, VIEWER or SALESMAN, and a
 *     role added later fails closed), the account is active, is not a seeded
 *     demo account (lib/demo-accounts.ts), and its address is an address;
 *   - it has not been read in the app;
 *   - its request still exists and, for a row that asks its recipient to act,
 *     still waits on HIM: open, at a step he can decide, by role and by who the
 *     submitter's supervisor is, with the request's recorded pending role on that
 *     same step, and he has not decided another step of it in this cycle. A request stays SUBMITTED through every step of a new-customer
 *     chain, so "still open" alone would e-mail a Supervisor "please review"
 *     about a request already at the GM (challenges, item 29). The same check
 *     tells EDIT_STAGE_ADVANCED's two meanings apart: "now at your step" is sent,
 *     "your request advanced" (to the salesman) never is.
 * One digest per recipient per run; a recipient e-mailed within the gap waits;
 * the per-run and rolling daily caps hold back whole digests, oldest first.
 */
import { Role } from '@prisma/client';
import { parseChain } from '../approval-chains';
import { EMAIL_DELIVERY, EMAIL_KINDS, EMAIL_ROLES, MUST_ACT_KINDS, type EmailDeliveryPolicy } from '../notify-policy';
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

export type Recipient = { id: string; role: Role; isActive: boolean; email: string | null; username: string };

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
};

export function requestTypeOf(edit: Pick<RequestNow, 'process' | 'target' | 'isReactivation'>): RequestType {
  if (edit.process === 'CREATE') return 'CREATE';
  if (edit.isReactivation) return 'REACTIVATION';
  // Only close-shop and reactivation requests target a branch.
  if (edit.target === 'BRANCH') return 'CLOSE';
  return 'UPDATE';
}

/** Does this request wait on this recipient now? */
export function waitsOn(recipient: Recipient, kind: string, edit: RequestNow): boolean {
  if (edit.state !== 'SUBMITTED') return false;
  if (recipient.id === edit.submittedById) return false;
  if (kind === 'REACTIVATION_REQUESTED') return edit.isReactivation && recipient.role === Role.MANAGER;
  // A reactivation is decided on /reactivations only; nothing else asks for one.
  if (edit.isReactivation) return false;
  const step = parseChain(edit.approvalChain)[edit.currentStepIndex];
  if (!step) return false;
  // The pointer and the recorded pending role must agree on the step: a request
  // whose pendingRole moved on is not waiting on this step, whatever the index says.
  if (edit.pendingRole && edit.pendingRole !== step.role) return false;
  if (edit.otherStepActorIds.includes(recipient.id)) return false;
  switch (step.scope) {
    case 'SUPERVISOR_OF_SUBMITTER':
      // His supervisor, or a region Manager (a close request's fallback audience;
      // the region was checked when the row was written).
      return recipient.id === edit.submitterSupervisorId || recipient.role === Role.MANAGER;
    case 'REGION_OVERLAP':
    case 'GLOBAL':
      return recipient.role === step.role;
  }
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
  if (!recipient.isActive) return { send: false, status: 'SKIPPED_INACTIVE' };
  // A seeded demo or test account (lib/demo-accounts.ts) is never a real person's
  // inbox, and production refuses its sign-in, so a link would lead nowhere.
  if (isDemoAccount(recipient.username)) return { send: false, status: 'SKIPPED_DEMO' };
  if (!isEmailAddress(recipient.email?.trim())) return { send: false, status: 'SKIPPED_NO_ADDRESS' };
  if (row.readAt) return { send: false, status: 'SKIPPED_READ' };
  if (!edit || !row.editId) return { send: false, status: 'SKIPPED_RESOLVED' };
  if ((MUST_ACT_KINDS as readonly string[]).includes(row.kind) && !waitsOn(recipient, row.kind, edit)) {
    return { send: false, status: 'SKIPPED_RESOLVED' };
  }
  if (row.kind === 'SLA_BREACH' && edit.state !== 'SUBMITTED') return { send: false, status: 'SKIPPED_RESOLVED' };
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
  /** Recipients sent a digest within the gap. */
  recentlySent: Set<string>;
  /** Digests sent in the last 24 hours. */
  sentLast24h: number;
  policy?: Pick<EmailDeliveryPolicy, 'maxAgeMs' | 'perRunCap' | 'dailyCap'>;
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

  // Oldest waiting first, so a cap holds back the newest, not the same people.
  const queue = [...byUser.entries()].sort(
    ([, a], [, b]) =>
      Math.min(...a.rows.map((r) => r.createdAt.getTime())) - Math.min(...b.rows.map((r) => r.createdAt.getTime()))
  );
  const allowed = Math.max(0, Math.min(policy.perRunCap, policy.dailyCap - input.sentLast24h));
  const digests: PlannedDigest[] = [];
  const deferred: string[] = [];
  let capped = false;
  for (const [userId, entry] of queue) {
    if (input.recentlySent.has(userId)) {
      deferred.push(...entry.rows.map((r) => r.id));
      continue;
    }
    if (digests.length >= allowed) {
      capped = true;
      deferred.push(...entry.rows.map((r) => r.id));
      continue;
    }
    const recipient = input.recipients.get(userId)!;
    digests.push({
      userId,
      role: recipient.role,
      address: recipient.email!.trim(),
      rowIds: entry.rows.map((r) => r.id),
      items: [...entry.items.values()].sort((a, b) => MUST_ACT_FIRST[a.kind]! - MUST_ACT_FIRST[b.kind]!),
    });
  }
  return { digests, skips, deferred, capped };
}
