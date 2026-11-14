/**
 * The daily Temix-to-CRM import, stage 1: its tables (migration
 * 20261114100000_temix_daily_tables) and what protects them, in one list.
 *
 * The daily file is a module of its own, apart from the Import screen: it does
 * not touch ImportBatch or ImportRow, so the Import screen's rule that no import
 * file moves an existing shop to another route stays exactly as it is
 * (tests/unit/import-shop-route-guard.test.ts). Nothing writes these tables yet;
 * the upload, check, apply and finalize stages come later. Every rule the owner
 * has not decided (which row is the main account, the A/I status mapping,
 * creating customers and shops from the file, route-code variants, thresholds,
 * the end of the pilot rule) is deliberately absent here and in the migration.
 *
 * tests/unit/temix-daily-tables.test.ts holds these lists to the migration's SQL
 * and to prisma/schema.prisma; scripts/ops/app-role.ts reads TEMIX_DAILY_LEDGERS
 * to keep the ledgers insert-only for the runtime role after its blanket GRANT.
 *
 * PURE: no imports, so scripts can use it.
 */

/** The migration that creates every table named here. */
export const TEMIX_DAILY_MIGRATION = '20261114100000_temix_daily_tables';

/** Every table of the module, in the order the migration creates them. */
export const TEMIX_DAILY_TABLES = [
  'TemixDailyFile',
  'TemixDailyRow',
  'TemixChange',
  'TemixChangeReview',
  'TemixNoticeSeen',
  'TemixRouteMap',
] as const;
export type TemixDailyTable = (typeof TEMIX_DAILY_TABLES)[number];

/**
 * The INSERT-only ones: UPDATE, DELETE and TRUNCATE are refused by
 * nmwc_forbid_audit_mutation (only the table owner, inside the maintenance
 * window, gets through), exactly as on AuditLog and the dated history; the
 * runtime role may insert and read only, and draw ids from the BIGSERIAL
 * sequence without setting it.
 *
 * Not (yet) in lib/history-tables.ts APPEND_ONLY_APP_TABLES: that list also
 * puts a table under the daily seal, which changes the seal format; that is a
 * later, separate step. The nightly checks watch them all the same: their
 * triggers and functions (TEMIX_DAILY_PROTECTION_TRIGGERS) and the runtime
 * role's privileges on them (lib/integrity/checks.ts runtime-role-privileges).
 */
export const TEMIX_DAILY_LEDGERS = ['TemixChange', 'TemixChangeReview', 'TemixNoticeSeen', 'TemixRouteMap'] as const;

/** The files are never deleted (a DELETE or TRUNCATE guard), but their state moves. */
export const TEMIX_DAILY_NO_DELETE = ['TemixDailyFile'] as const;

/** The ledgers whose rows carry their writer's source and transaction (nmwc_auditlog_stamp_context). */
export const TEMIX_DAILY_STAMPED = ['TemixChange', 'TemixChangeReview', 'TemixRouteMap'] as const;

/** Every trigger the migration creates, by table. */
export const TEMIX_DAILY_TRIGGERS: Record<TemixDailyTable, readonly string[]> = {
  TemixDailyFile: ['temixdailyfile_identity_guard', 'temixdailyfile_no_delete', 'temixdailyfile_no_truncate'],
  TemixDailyRow: ['temixdailyrow_guard'],
  TemixChange: [
    'temixchange_stamp_context',
    'temixchange_insert_guard',
    'temixchange_append_only',
    'temixchange_no_truncate',
  ],
  TemixChangeReview: ['temixchangereview_stamp_context', 'temixchangereview_append_only', 'temixchangereview_no_truncate'],
  TemixNoticeSeen: ['temixnoticeseen_append_only', 'temixnoticeseen_no_truncate'],
  TemixRouteMap: [
    'temixroutemap_stamp_context',
    'temixroutemap_live_guard',
    'temixroutemap_append_only',
    'temixroutemap_no_truncate',
  ],
};

/** The functions the migration creates (each pins its search_path). */
export const TEMIX_DAILY_FUNCTIONS = [
  'nmwc_temix_daily_file_guard',
  'nmwc_temix_daily_row_guard',
  'nmwc_temix_change_guard',
  'nmwc_temix_route_map_guard',
] as const;

/**
 * Every trigger of the module, which the nightly checks protection-triggers and
 * protection-functions watch (lib/history-tables.ts PROTECTION_TRIGGERS, then
 * lib/integrity/expected.ts) and the restore check expects
 * (scripts/ops/restore-verify.ts). Watching them is not sealing them: the
 * ledgers are still outside the daily seal (see TEMIX_DAILY_LEDGERS).
 */
export const TEMIX_DAILY_PROTECTION_TRIGGERS: readonly string[] = TEMIX_DAILY_TABLES.flatMap((t) => TEMIX_DAILY_TRIGGERS[t]);

/**
 * The tables the runtime role may never DELETE from or TRUNCATE (the files and
 * their rows: read, insert and update only), and the ledgers it may never
 * UPDATE either. Read by the nightly check runtime-role-privileges, the restore
 * check's privilege matrix (R-02) and `app-role.ts verify`.
 */
export const TEMIX_DAILY_STAGING = ['TemixDailyFile', 'TemixDailyRow'] as const;

/**
 * The raw-SQL indexes Prisma cannot express (partial). CI's drift gate names
 * them as kept on purpose (.github/workflows/ci.yml, ALLOWED); Prisma 6.19
 * leaves partial indexes out of its diff, so today they do not appear there.
 */
export const TEMIX_DAILY_RAW_INDEXES = [
  // The same bytes are staged once per load day; a discarded file frees its day.
  'TemixDailyFile_sha_day_live_unique',
  // At most one file is mid-load (APPLYING or FINALIZING) at any time.
  'TemixDailyFile_one_in_flight',
  // The retention sweep finds rows that still hold a payload, oldest first.
  'TemixDailyRow_payload_createdAt_idx',
] as const;

/**
 * What a ledger row may record (CHECK TemixChange_kind_check). Listing a kind
 * decides nothing: each is written only by the stage that implements it, and
 * the ones that wait for the owner (credit and terms from the main row, the
 * status comparison, creating customers and shops) have no writer until he has
 * answered.
 */
export const TEMIX_CHANGE_KINDS = [
  // Applied to the CRM (applied = true).
  'ROUTE_MOVE',
  'TERMS_CHANGED',
  'CREDIT_LIMIT_CHANGED',
  'CREDIT_DAYS_CHANGED',
  'CUSTOMER_CREATED',
  'SHOP_CREATED',
  'TEMIX_CODE_CONFIRMED',
  // Notices for the Steward (applied = false).
  'STATUS_DIFFERS',
  'NAME_DIFFERS',
  'ROUTE_NOT_MATCHED',
  'ROUTE_INACTIVE',
  'SHOP_CODE_LOOKALIKE',
  'SHOP_NOT_LINKED',
  'DUPLICATE_SUSPECT',
  'CODE_HELD_BY_OTHER',
  'MISSING_FROM_FILE',
  'ACCOUNTANT_CODE_NOT_SEEN',
  'DAUGHTER_TERMS_IGNORED',
] as const;
export type TemixChangeKind = (typeof TEMIX_CHANGE_KINDS)[number];

/**
 * "Listed once" kinds (CHECK TemixNoticeSeen_kind_check). Only the name: whether
 * a status difference is listed once or every day it lasts is the owner's
 * question, so STATUS_DIFFERS is not here.
 */
export const TEMIX_NOTICE_SEEN_KINDS = ['NAME_DIFFERS'] as const;

/** A route-map row adds an entry or retires one (CHECK TemixRouteMap_action_check). */
export const TEMIX_ROUTE_MAP_ACTIONS = ['ADD', 'RETIRE'] as const;
