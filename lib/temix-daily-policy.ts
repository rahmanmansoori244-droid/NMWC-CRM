/**
 * The daily Temix import's levers.
 *
 * PURE: no imports.
 */

/**
 * The Data Steward's daily summary (NotificationKind TEMIX_DAILY_SUMMARY). OFF
 * in the build that ships the enum value (migration
 * 20261114110000_notification_temix_daily_summary): an older Prisma client
 * throws on a kind it does not know, so the build that READS the value must be
 * production's rollback target before any build WRITES it, exactly as
 * INTEGRITY_ALERT was rolled out (lib/integrity/policy.ts). The plan's stage 7
 * is the one-line follow-up commit that turns it on, deployed on its own after
 * this build has served production and passed smoke. Until then
 * lib/temix-daily-summary.ts writes nothing.
 */
export const TEMIX_DAILY_SUMMARY_ENABLED = false;

/** Where the summary links: the daily file list (the drill-down comes in stage 6). */
export const TEMIX_DAILY_HREF = '/temix-daily';
