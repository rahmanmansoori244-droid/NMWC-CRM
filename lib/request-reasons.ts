/**
 * Code review 2026-11-10, finding 18: a request kept only one "reason" line.
 *
 * CustomerEdit.decisionReason held three unrelated things — the salesman's own
 * reason on a close or reactivation request, the LATEST approver's reason on a
 * new-customer or update request (every rejection overwrote the one before, and
 * nothing cleared it on the way forward), and the note on a request closed
 * without a decision. So the salesman read only the last approver's words, an
 * approved request could show an old send-back reason, and a merge's auto-close
 * replaced the salesman's reason with its own sentence.
 *
 * Three sources now, each read where it belongs:
 *
 *   CustomerEdit.requestReason   the REQUESTER's own words, written once with the
 *                                request and frozen by the evidence guard once it
 *                                is sent (migration 20261110110000). Today only a
 *                                close or reactivation request has one.
 *   EditApproval.reason          every approver DECISION's reason, append-only.
 *                                THE source for every screen and notification
 *                                that says why a request came back or was refused.
 *   CustomerEdit.decisionReason  the note on a request closed with no approver's
 *                                decision (withdrawn, merged, archived, account
 *                                change), and a copy of the latest send-back while
 *                                the request stands sent back or stepped back.
 *                                Cleared whenever the request moves forward. Read
 *                                here only as a fallback for rows that have no
 *                                decision rows (older rows, seeded fixtures).
 *
 * A typed GPS point's reason is neither: it lives inside fieldChanges
 * (lib/gps-manual.ts), is frozen with it, and every approver is shown it.
 *
 * PURE: no database, no clock. tests/unit/request-reasons.test.ts holds the truth
 * tables; tests/unit/request-reason-guard.test.ts holds the writers and the
 * screens to these rules.
 */
import type { Prisma } from '@prisma/client';
import { DECISION_REJECTED, stepName } from '@/lib/approval-chains';

/**
 * Rollback bridge. Every build before this one reads a close or reactivation
 * request's reason from decisionReason (the Reactivations queue, the approver's
 * page, the REACTIVATE audit row). While this is on, a submit writes the
 * requester's reason to requestReason AND, as before, to decisionReason, so an
 * Instant Rollback to the previous build still shows it. Nothing in this build
 * reads that copy when requestReason is set (requestReasonOf).
 *
 * A one-line follow-up turns it off once this build is production's rollback
 * floor (docs/handover/04-PENDING-WORK.md); the launch e2e and integration
 * expectations on decisionReason for close / reactivation rows change with it.
 * The house pattern: CHAIN_OBJECT_FORM_ENABLED (lib/approval-chains.ts).
 */
export const REQUEST_REASON_LEGACY_COPY = true;

/** How the note of a request auto-closed by a merge begins (it sets no decisionCategory). */
export const MERGE_CLOSED_PREFIX = 'Auto-closed: customer ';

/** The note a merge leaves on the loser's pending requests (services/duplicates.ts). */
export function mergeClosedReason(loserCode: string, winnerCode: string): string {
  return `${MERGE_CLOSED_PREFIX}${loserCode} merged into ${winnerCode}.`;
}

/** decisionCategory of a request closed by, or for, its sender — never an approver's decision. */
const WITHDRAWN_CATEGORY = 'withdrawn';

/**
 * A request's decisions as the screens read them: `include: { steps: DECISION_TRAIL }`.
 * Oldest first; the id breaks a tie so the order is the same on every read.
 */
export const DECISION_TRAIL = {
  orderBy: [{ at: 'asc' }, { id: 'asc' }],
  select: {
    id: true,
    cycle: true,
    stepIndex: true,
    role: true,
    decision: true,
    reason: true,
    at: true,
    actor: { select: { fullName: true } },
  },
} satisfies Prisma.CustomerEdit$stepsArgs;

/** One EditApproval row, as far as a reason needs it. */
export type DecisionRow = {
  cycle: number;
  stepIndex: number;
  role: string;
  decision: string;
  reason: string | null;
  at: Date;
  actor?: { fullName: string } | null;
};

/** One send-back (or refusal): who, at which step, when, and why. Null where not on record. */
export type SendBack = {
  /** The step's name in words (lib/approval-chains.ts stepName), never the enum. */
  step: string | null;
  stepIndex: number | null;
  by: string | null;
  at: Date | null;
  reason: string | null;
};

/** What the request row itself says, as far as a reason needs it. */
export type ReasonEdit = {
  state: string;
  target: string;
  isReactivation?: boolean | null;
  cycle: number;
  requestReason?: string | null;
  decisionReason?: string | null;
  decisionCategory?: string | null;
  reviewedAt?: Date | null;
  reviewedBy?: { fullName: string } | null;
};

const text = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' ? null : t;
};

/** This round's decisions, oldest first (a stable sort: equal times keep the order read). */
function roundDecisions(cycle: number, decisions: readonly DecisionRow[] | null | undefined): DecisionRow[] {
  return (decisions ?? [])
    .filter((d) => d.cycle === cycle)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.at.getTime() - b.d.at.getTime() || a.i - b.i)
    .map((x) => x.d);
}

function sendBackOf(d: DecisionRow): SendBack {
  return {
    step: stepName(d.role),
    stepIndex: d.stepIndex,
    by: d.actor?.fullName ?? null,
    at: d.at,
    reason: text(d.reason),
  };
}

/** A send-back read off the request row alone: rows with no decision rows (older rows, seeded fixtures). */
function sendBackFromRow(edit: Pick<ReasonEdit, 'reviewedAt' | 'reviewedBy'>, reason: string | null): SendBack {
  return {
    step: null,
    stepIndex: null,
    by: edit.reviewedBy?.fullName ?? null,
    at: edit.reviewedAt ?? null,
    reason,
  };
}

const isStatusRequest = (edit: Pick<ReasonEdit, 'target' | 'isReactivation'>) =>
  edit.target === 'BRANCH' || edit.isReactivation === true;

/**
 * The REQUESTER's own reason: why he asked. Never a reviewer's words.
 *
 * requestReason when the row has one. A close or reactivation request sent by a
 * build before this one has it in decisionReason instead, and is read exactly as
 * the migration's back-fill reads it (2b / 2c): while it waits or once approved
 * (the only writer of the column on such a row was its own submit), or refused
 * with its own REJECTED decision row (the path that keeps the salesman's reason)
 * and not a merge's note. Anything else is not known to be his, and is null.
 */
export function requestReasonOf(
  edit: Pick<ReasonEdit, 'state' | 'target' | 'isReactivation' | 'requestReason' | 'decisionReason'>,
  decisions?: readonly Pick<DecisionRow, 'decision'>[] | null
): string | null {
  const own = text(edit.requestReason);
  if (own) return own;
  if (!isStatusRequest(edit)) return null;
  const legacy = text(edit.decisionReason);
  if (!legacy) return null;
  if (edit.state === 'SUBMITTED' || edit.state === 'APPROVED') return legacy;
  if (
    edit.state === 'REJECTED' &&
    !legacy.startsWith(MERGE_CLOSED_PREFIX) &&
    (decisions ?? []).some((d) => d.decision === DECISION_REJECTED)
  ) {
    return legacy;
  }
  return null;
}

/** Every rejection of one round, oldest first. */
export function roundSendBacks(cycle: number, decisions: readonly DecisionRow[] | null | undefined): SendBack[] {
  return roundDecisions(cycle, decisions)
    .filter((d) => d.decision === DECISION_REJECTED)
    .map(sendBackOf);
}

/**
 * The send-back of a request that STANDS sent back to its salesman: the latest
 * one of its round with who, where and when, and the ones before it.
 *
 * For a row the caller already knows is sent back — the lists and banners fed
 * by lib/returned-work.ts read only NEEDS_CORRECTION rows. In that state the
 * row's own decisionReason is that same latest send-back's reason, so it stands
 * in when the decision row carries none, and a row with no decision rows at all
 * (an older row, a seeded fixture) is read off the request itself.
 */
export function sentBackTrail(
  edit: Pick<ReasonEdit, 'cycle' | 'decisionReason' | 'reviewedAt' | 'reviewedBy'>,
  decisions: readonly DecisionRow[] | null | undefined
): { latest: SendBack; earlier: SendBack[] } {
  const sendBacks = roundSendBacks(edit.cycle, decisions);
  const note = text(edit.decisionReason);
  const latest = sendBacks.at(-1);
  if (!latest) return { latest: sendBackFromRow(edit, note), earlier: [] };
  return { latest: { ...latest, reason: latest.reason ?? note }, earlier: sendBacks.slice(0, -1) };
}

/**
 * What a request's reader must be told NOW about a decision against it — or
 * null when nothing is current (it is moving forward, or it was approved).
 */
export type CurrentReason =
  /** Back with the salesman to correct: NEEDS_CORRECTION, or a draft saved since. */
  | { kind: 'SENT_BACK'; latest: SendBack; earlier: SendBack[] }
  /** Still in review, returned one step by the round's last decision. */
  | { kind: 'RETURNED_TO_STEP'; latest: SendBack; earlier: SendBack[] }
  /** Refused for good by a reviewer (a close refused, a shop kept closed). */
  | { kind: 'REFUSED'; latest: SendBack }
  /** Closed with no approver's decision: withdrawn, merged, archived, account change. */
  | { kind: 'CLOSED'; note: string }
  | null;

export function currentReason(edit: ReasonEdit, decisions: readonly DecisionRow[] | null | undefined): CurrentReason {
  const round = roundDecisions(edit.cycle, decisions);
  const sendBacks = round.filter((d) => d.decision === DECISION_REJECTED).map(sendBackOf);
  const lastIsRejection = round.at(-1)?.decision === DECISION_REJECTED;
  const note = text(edit.decisionReason);
  const latest = sendBacks.at(-1);
  const earlier = sendBacks.slice(0, -1);

  switch (edit.state) {
    case 'APPROVED':
      // Whatever was said on the way, nothing is current: the trail keeps it.
      return null;
    case 'SUBMITTED':
      // Only from the decisions: an older row can still carry the reason of a
      // step-back that a later approval answered.
      return lastIsRejection && latest ? { kind: 'RETURNED_TO_STEP', latest, earlier } : null;
    case 'NEEDS_CORRECTION':
      return { kind: 'SENT_BACK', ...sentBackTrail(edit, decisions) };
    case 'DRAFT':
      // A sent-back request saved as a draft since: the round is the same, and
      // he still has to read why. A draft never sent has no decisions and no note.
      if (lastIsRejection || (round.length === 0 && note && edit.decisionCategory !== WITHDRAWN_CATEGORY)) {
        return { kind: 'SENT_BACK', ...sentBackTrail(edit, decisions) };
      }
      return null;
    case 'REJECTED':
      // Closed without a decision FIRST: a sent-back request its salesman then
      // withdrew still has a rejection in its round, and was not "refused".
      if (edit.decisionCategory === WITHDRAWN_CATEGORY || note?.startsWith(MERGE_CLOSED_PREFIX)) {
        return note ? { kind: 'CLOSED', note } : null;
      }
      if (lastIsRejection && latest) return { kind: 'REFUSED', latest };
      // No decision row. On a close or reactivation the row's text is the
      // SALESMAN's reason (or nothing) — never shown as the reviewer's.
      if (isStatusRequest(edit)) return { kind: 'REFUSED', latest: sendBackFromRow(edit, null) };
      return note ? { kind: 'CLOSED', note } : null;
    default:
      return null;
  }
}

/** A reason inside a notification's bracket is kept short; the page shows it whole. */
const EARLIER_REASON_MAX = 280;
const clip = (s: string) => (s.length > EARLIER_REASON_MAX ? `${s.slice(0, EARLIER_REASON_MAX - 1)}…` : s);

/**
 * The earlier send-backs of the round, for a notification: '' when there are
 * none, else ' (Earlier in this round — Accountant step: …; GM step: …)'. Steps,
 * not people's names, as every notification says them.
 */
export function earlierInRoundText(earlier: readonly SendBack[]): string {
  if (earlier.length === 0) return '';
  const parts = earlier.map((e) => `${e.step ?? 'Earlier'} step: ${e.reason ? clip(e.reason) : 'no reason on record'}`);
  return ` (Earlier in this round — ${parts.join('; ')})`;
}

/** The salesman's "Needs correction" notification: the reason he was given, then the ones before it. */
export function needsCorrectionBody(name: string, latestReason: string, earlier: readonly SendBack[]): string {
  return `${name} — returned to you: ${latestReason}${earlierInRoundText(earlier)}`;
}

/** "and 1 earlier reason in this round" / "and 3 earlier reasons in this round" — a list row's short form. */
export function earlierCountText(n: number): string {
  return n <= 0 ? '' : `and ${n} earlier ${n === 1 ? 'reason' : 'reasons'} in this round`;
}
