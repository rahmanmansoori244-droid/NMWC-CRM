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
 *   UPDATE and CREATE  unchanged: the salesman's supervisorId (resolveStepAudience,
 *                      lib/notifications.ts). Region Managers who may also act
 *                      are deliberately not told (lib/notifications.ts).
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
 * Delivery. The drain (app/api/cron/email-drain, lib/email/drain.ts) runs every
 * 10 minutes 03:00–14:59 UTC (07:00–18:59 Oman), the window of the other jobs:
 * vercel.json `crons`, pinned to this module by tests/unit/email-structure-guard.test.ts.
 */
export const EMAIL_DELIVERY = {
  /** vercel.json schedule, stated here so the guard can hold the two together. */
  schedule: '*/10 3-14 * * *',
  /** A row older than this is never e-mailed (SKIPPED_STALE): no backlog flood. */
  maxAgeMs: 24 * 60 * 60_000,
  /** At most one digest per recipient in this window. */
  recipientGapMs: 30 * 60_000,
  /** Digests per run. */
  perRunCap: 40,
  /** Digests per rolling 24 hours, under consumer Gmail's ~500 recipients a day. */
  dailyCap: 400,
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
} as const;
