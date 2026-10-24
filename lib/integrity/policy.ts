/**
 * Gap 29 (data audit 2026-10-10): the nightly integrity watch's levers.
 *
 * Every number here is a safe default awaiting the owner (docs/OPERATIONS.md
 * section 5k lists the open questions): which checks alert, at what count, how
 * often the Steward is told.
 *
 * PURE: no imports.
 */

/**
 * The Data Steward's in-app alert (NotificationKind INTEGRITY_ALERT). OFF in the
 * build that ships the enum value: an older Prisma client throws on a kind it
 * does not know, so the build that READS the value must be production's
 * rollback target before any build WRITES it (migration
 * 20261024120300_notification_integrity_alert). A one-line follow-up commit
 * turns it on once this deployment has served production and passed smoke.
 * Until then a failing check reaches the operators' webhook and
 * /status/integrity only.
 */
export const INTEGRITY_INAPP_ALERTS_ENABLED = false;

/** At most this many sample ids per check result. */
export const SAMPLE_LIMIT = 10;

/**
 * The migrated customers whose Temix code (= their own customer code) has a
 * space inside (production check of 2026-10-09). Listed as information, not
 * failure; recognised by rule, never by literal (the repository is public).
 * A fourth such code fails.
 */
export const KNOWN_LEGACY_SPACED_TEMIX_CODES = 3;

/** A check fails when its count is above this; every check today: any record at all. */
export const DEFAULT_THRESHOLD = 0;

/** The whole run of checks gets this long; a check not started in time is an error. */
export const CHECK_BUDGET_MS = 22_000;
/** Each check's own statements. */
export const CHECK_STATEMENT_TIMEOUT = '10s';
export const CHECK_TX_TIMEOUT_MS = 15_000;
/** The seal's transaction (lib/seal/seal.ts). */
export const SEAL_TX_TIMEOUT_MS = 15_000;
/** Every R2 call and the chain recheck stop here, counted from the run's start (the photo-gc pattern). */
export const RUN_DEADLINE_MS = 50_000;
/** The nightly recheck reads the ranges and copies of this many recent seals. */
export const SEAL_RECHECK_WINDOW = 7;
/**
 * And re-digests a rotating slice of the older seals, so that every sealed range
 * is recomputed at least once in this many nights (lib/seal/verify.ts), while the
 * run's budget holds. verify-seals --all checks everything at once.
 */
export const SEAL_FULL_RECHECK_NIGHTS = 28;
/** No older seal of the rotation is started after this, counted from the run's start. */
export const SEAL_ROTATION_STOP_MS = 38_000;
/** At most this many open seal findings are carried from one night to the next. */
export const SEAL_OPEN_LIMIT = 500;
/** A missing copy of a seal this young is written again (a failed upload), not a failure. */
export const SEAL_OFFSITE_RETRY_DAYS = 2;

/** The day's alert names at most this many checks, then "+N more". */
export const ALERT_BODY_CHECKS = 5;
