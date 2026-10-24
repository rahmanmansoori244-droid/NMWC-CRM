/**
 * Gap 25 (data audit 2026-10-10): every clean-up the application runs, in one
 * list, with the period docs/compliance/DATA-RETENTION-SCHEDULE.md states.
 *
 * The periods are NOT changed here (the owner accepted them): the routes that
 * used to carry their own constants read them from this list, and
 * tests/unit/retention-rules-doc.test.ts holds each one to the schedule row that
 * names its rule id. What is new is that every rule writes one PurgeSummary row
 * with the batch it deletes (lib/purge-summary.ts): what, how many, the date
 * range, the cut-off and the rule, in the same statement as the deletion.
 *
 * Deletions outside the application cannot write a summary and are not here: the
 * R2 lifecycle expiry of gc-marked photos (the photo-gc summary and the photo's
 * AttachmentHistory DELETE row record the decision that leads to it), the 30-day
 * expiry of the database dumps, Neon's point-in-time window, and the Vercel and
 * Sentry logs.
 *
 * PURE: no imports.
 */

export type RetentionRuleId =
  | 'rate-limit-1d'
  | 'import-payload-90d'
  | 'notification-unread-180d'
  | 'cron-run-90d'
  | 'notification-read-90d'
  | 'photo-detached-30d'
  | 'password-history-last-5';

export type RetentionRule = {
  id: RetentionRuleId;
  /** The job that applies it: a cron route's key, or the password policy. */
  job: 'retention-sweep' | 'sla-escalate' | 'photo-gc' | 'password-policy';
  table: 'RateLimit' | 'ImportRow' | 'Notification' | 'CronRun' | 'Attachment' | 'PasswordHistory';
  /** DELETE removes the row; CLEAR_PAYLOAD empties the personal columns and keeps the row. */
  action: 'DELETE' | 'CLEAR_PAYLOAD';
  /** The age past which the rule applies, in days; null for a count rule. */
  days: number | null;
  /** A count rule: how many of a person's newest rows are kept. */
  keep?: number;
  /** The column the age is read from (the summary's date range is over it). */
  dateColumn: string;
  /** Why the data goes, in a phrase. */
  why: string;
};

export const RETENTION_RULES = {
  'rate-limit-1d': {
    id: 'rate-limit-1d',
    job: 'retention-sweep',
    table: 'RateLimit',
    action: 'DELETE',
    days: 1,
    dateColumn: 'updatedAt',
    why: 'a spent token bucket is only a log of which name was tried from which address',
  },
  'import-payload-90d': {
    id: 'import-payload-90d',
    job: 'retention-sweep',
    table: 'ImportRow',
    action: 'CLEAR_PAYLOAD',
    days: 90,
    dateColumn: 'createdAt',
    why: 'a finished import row keeps its outcome, not a verbatim copy of the customer data',
  },
  'notification-unread-180d': {
    id: 'notification-unread-180d',
    job: 'retention-sweep',
    table: 'Notification',
    action: 'DELETE',
    days: 180,
    dateColumn: 'createdAt',
    why: 'an inbox nobody opens must not keep customer names for ever',
  },
  'cron-run-90d': {
    id: 'cron-run-90d',
    job: 'retention-sweep',
    table: 'CronRun',
    action: 'DELETE',
    days: 90,
    dateColumn: 'at',
    why: 'three 30-day service-level windows; each day is kept in JobRunDay first',
  },
  'notification-read-90d': {
    id: 'notification-read-90d',
    job: 'sla-escalate',
    table: 'Notification',
    action: 'DELETE',
    days: 90,
    dateColumn: 'readAt',
    why: 'a notification read three months ago has done its work',
  },
  'photo-detached-30d': {
    id: 'photo-detached-30d',
    job: 'photo-gc',
    table: 'Attachment',
    action: 'DELETE',
    days: 30,
    dateColumn: 'deletedAt',
    why: 'a detached or replaced photo is kept 30 days for recovery, then its object is tagged for expiry',
  },
  'password-history-last-5': {
    id: 'password-history-last-5',
    job: 'password-policy',
    table: 'PasswordHistory',
    action: 'DELETE',
    days: null,
    keep: 5,
    dateColumn: 'createdAt',
    why: 'reuse is checked against the last five passwords only',
  },
} as const satisfies Record<RetentionRuleId, RetentionRule>;

export const RETENTION_RULE_IDS = Object.keys(RETENTION_RULES) as RetentionRuleId[];

/** The cut-off a day rule applies at `now`: rows older than this go. */
export function retentionCutoff(rule: { days: number }, now: Date): Date {
  return new Date(now.getTime() - rule.days * 24 * 60 * 60 * 1000);
}
