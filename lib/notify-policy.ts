/**
 * F1 (2026-10-05): every choice about who is notified of a salesman's request,
 * what is e-mailed and how fast — in ONE module, so a change of mind is a change
 * here and nowhere else.
 *
 * THESE ARE DEFAULTS, NOT OWNER DECISIONS. The owner asked for this: "whenever a
 * salesman does something (submits, uploads), his manager and the region's
 * accountant get BOTH an in-app alert and an e-mail, sent from the owner's Gmail,
 * so they know to approve, check or update; everyone in the hierarchy EXCEPT the
 * GM and the Data Steward". He chose his Gmail. Everything below that his words do
 * not settle was implemented as the default recorded in
 * docs/handover/04-PENDING-WORK.md (A1.11) and is listed there for him to confirm
 * or change. e-mail itself stays OFF until he sets NOTIFY_EMAIL_ENABLED=on
 * (lib/email/config.ts).
 *
 * Who must act (in-app EDIT_SUBMITTED / REACTIVATION_REQUESTED, and e-mail):
 *   UPDATE and CREATE  the salesman's supervisorId when that supervisor can act
 *                      on the request, as for a CLOSE (resolveStepAudience,
 *                      lib/notifications.ts); otherwise every active MANAGER of
 *                      the request's regions, and the gap is logged. Region
 *                      Managers who may also act are not told while he can
 *                      (launch fix 2026-10-07: a null, disabled or out-of-region
 *                      supervisorId used to alert nobody).
 *   CLOSE (new)        his supervisor when that supervisor can act on the request
 *                      (an active SUPERVISOR, or an active MANAGER who manages the
 *                      branch's region: canApproveSpecificEdit refuses a Manager
 *                      outside it); otherwise every active MANAGER of the region.
 *   REACTIVATION (new) his supervisor if he is an active MANAGER over the branch's
 *                      region; otherwise every active MANAGER of the region — the
 *                      decide gate of services/reactivations.ts. Kind
 *                      REACTIVATION_REQUESTED, linked to /reactivations.
 * Who is told for information (REQUEST_FYI): the active ACCOUNTANT(s) of the
 * salesman's region, on every salesman request, never the must-act people or the
 * submitter. The owner: "the accountant to be updated on whatever is done".
 * Region-wide Manager FYI is OFF: Muscat has several class Managers, and each
 * would be told of every Muscat salesman's request.
 *
 * Never e-mailed, whatever the kind: GM, STEWARD, VIEWER, SALESMAN, and any role
 * added later (EMAIL_ROLES is an allowlist). The GM and the Steward keep their
 * existing in-app rows: the GM must act on every CREDIT request, and the
 * Stewards drive the Temix hand-off.
 */
import { Role, type NotificationKind } from '@prisma/client';

/** The salesman actions that notify. */
export type SalesmanRequestEvent = 'UPDATE' | 'CREATE' | 'CLOSE' | 'REACTIVATION';

/** Who is told of a salesman's request beyond those who must act on it. */
export const FYI_POLICY: {
  /** The region's active Accountant(s), per event. */
  readonly accountants: Readonly<Record<SalesmanRequestEvent, boolean>>;
  /** Every active Manager of the region. OFF by default (Muscat's class Managers). */
  readonly regionManagers: boolean;
} = {
  accountants: { UPDATE: true, CREATE: true, CLOSE: true, REACTIVATION: true },
  regionManagers: false,
};

/**
 * Photo uploads notify nobody in v1. They are live writes, several per visit,
 * and the photos are on the request the approver opens anyway. Nothing in
 * services/photos.ts reads this yet; it is here so turning photo alerts on is a
 * recorded decision in this module and not a quiet change somewhere else.
 */
export const NOTIFY_PHOTO_UPLOADS = false;

/** Roles a supervisorId may point at and still be the one who must act. */
export const SUPERVISING_ROLES: readonly Role[] = [Role.MANAGER, Role.SUPERVISOR];

/**
 * Roles that may receive notification E-MAIL. An allowlist: GM, STEWARD, VIEWER,
 * SALESMAN and any future role fail closed. Re-checked against the recipient's
 * CURRENT role, active flag and address at send time (lib/email/drain.ts).
 */
export const EMAIL_ROLES: readonly Role[] = [
  Role.MANAGER,
  Role.SUPERVISOR,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
];

/**
 * SLA breaches are not e-mailed in v1: the escalation chain is still "[Open —
 * owner to confirm]" (lib/escalation.ts). Turning this on adds SLA_BREACH to
 * EMAIL_KINDS; the drain e-mails it only while the request is still open.
 */
export const EMAIL_SLA_BREACH = false;

/**
 * Kinds that are e-mailed. EDIT_STAGE_ADVANCED is sent only when its recipient
 * is the step that must act NOW (lib/email/eligibility.ts): the same kind also
 * tells the salesman "your request advanced", and tells a step its request was
 * returned to it.
 */
export const EMAIL_KINDS: readonly NotificationKind[] = [
  'EDIT_SUBMITTED',
  'EDIT_STAGE_ADVANCED',
  'REACTIVATION_REQUESTED',
  'REQUEST_FYI',
  ...(EMAIL_SLA_BREACH ? (['SLA_BREACH'] as const) : []),
];

/** Kinds that ask the recipient to act: skipped once the request has moved past him. */
export const MUST_ACT_KINDS: readonly NotificationKind[] = [
  'EDIT_SUBMITTED',
  'EDIT_STAGE_ADVANCED',
  'REACTIVATION_REQUESTED',
];

/**
 * Launch fix (2026-10-07): the rows a decision settles. When anyone decides a
 * request (a step approved or rejected, a reactivation approved or kept closed),
 * every unread row of these kinds about it, held by anyone but its submitter, is
 * marked read in the same transaction (lib/notifications.ts settleRequestAlerts):
 * the step they asked for has been taken, so they no longer count in a red bell.
 * Before, only the recipient's own click marked a row read, so with four Managers
 * sharing a region a supervisor's bell counted requests a colleague had already
 * decided. The submitter's own rows are his progress pings and are left alone.
 */
export const SETTLED_ON_DECISION_KINDS: readonly NotificationKind[] = [...MUST_ACT_KINDS, 'SLA_BREACH'];

/**
 * The in-app bell (app/(app)/layout.tsx, components/nmwc/TopBar.tsx) is the only
 * in-app alert, and its red count means "something waits on you". These kinds
 * are counted apart from it, in a muted second count: since F1 the region's
 * Accountant gets a REQUEST_FYI row for every salesman request in his region,
 * and counted in the red badge they would hold it at "9+" all day. Clearing
 * that with "Mark all read" would also mark his unread must-act rows read, and
 * a read row is never e-mailed (SKIPPED_READ); /notifications offers "Mark
 * information read" for these kinds alone. A default (fixer review 2026-10-05),
 * listed in 04-PENDING A1.11: an empty list puts every unread row back in the
 * red count.
 */
export const BELL_INFORMATION_KINDS: readonly NotificationKind[] = ['REQUEST_FYI'];

/**
 * Launch fix (2026-10-07): a SALESMAN's rows are about his own requests, and only
 * one kind asks him to act — EDIT_NEEDS_CORRECTION, a request returned or refused,
 * whose reason he must read. These only tell him how a request went: "advanced"
 * and "approved" (the same kinds ask an approver or a Steward to act, so the split
 * is by role), Temix's acknowledgement, and FYI. Counted in his red badge they
 * read as work he did not have.
 */
export const SALESMAN_BELL_INFORMATION_KINDS: readonly NotificationKind[] = [
  ...BELL_INFORMATION_KINDS,
  'EDIT_STAGE_ADVANCED',
  'EDIT_APPROVED_FINAL',
  'TEMIX_SYNC_ACKED',
];

/** The kinds counted apart from `role`'s red bell (lib/notification-bell.ts). */
export function bellInformationKinds(role: Role): readonly NotificationKind[] {
  return role === Role.SALESMAN ? SALESMAN_BELL_INFORMATION_KINDS : BELL_INFORMATION_KINDS;
}

/**
 * Delivery. The drain (app/api/cron/email-drain, lib/email/drain.ts) runs every
 * 10 minutes 03:00–14:59 UTC (07:00–18:59 Oman), the window of the other jobs:
 * vercel.json `crons`, pinned to this module by tests/unit/email-structure-guard.test.ts.
 */
export type EmailDeliveryPolicy = {
  schedule: string;
  maxAgeMs: number;
  recipientGapMs: number;
  perRunCap: number;
  dailyCap: number;
  informationDailyCap: number;
  maxItemsPerDigest: number;
  claimLimit: number;
  leaseMs: number;
  maxAttempts: number;
  sendBudgetMs: number;
  hardStopMs: number;
};

export const EMAIL_DELIVERY: Readonly<EmailDeliveryPolicy> = {
  /** vercel.json schedule, stated here so the guard can hold the two together. */
  schedule: '*/10 3-14 * * *',
  /** A row older than this is never e-mailed (SKIPPED_STALE): no backlog flood. */
  maxAgeMs: 24 * 60 * 60_000,
  /**
   * At most one digest per recipient in this window — per class: a digest that
   * only informs waits for any earlier one; a digest that asks him to act waits
   * only for an earlier one that also did, so an FYI e-mail never delays his
   * "please review" (lib/email/eligibility.ts planRun).
   */
  recipientGapMs: 30 * 60_000,
  /** Digests per run. When it binds, digests with something to act on go first. */
  perRunCap: 40,
  /** Digests per rolling 24 hours, under consumer Gmail's ~500 recipients a day. */
  dailyCap: 400,
  /**
   * Of the daily cap, what information-only digests may use: the rest is kept
   * for digests that ask someone to act, so a heavy day of FYI to Accountants
   * cannot spend the Managers' quota (fixer review 2026-10-05).
   */
  informationDailyCap: 300,
  /** Lines in one digest; the rest are "and N more" with a link to the inbox. */
  maxItemsPerDigest: 20,
  /** Rows one run claims. */
  claimLimit: 200,
  /** A claim's lease: longer than the 60 s function limit, so overlapping runs never share a row. */
  leaseMs: 5 * 60_000,
  /** Claims before a row that was never sent becomes FAILED. */
  maxAttempts: 5,
  /** No new send starts after this much of the run (maxDuration is 60 s). */
  sendBudgetMs: 40_000,
  /**
   * No send may still be waiting this long after the run started: one that is
   * counts as a transient timeout and the run stops, leaving 10 s for the marks,
   * the heartbeat and its alert (the photo-gc precedent). The SMTP timeouts alone
   * would let a send started at 39 s run past the limit.
   */
  hardStopMs: 50_000,
};
