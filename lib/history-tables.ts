/**
 * The dated history (prisma/migrations/20261013100100_history_foundation,
 * 20261014100000_lossless_paths and part C's 20261015100000 / 20261015100100,
 * docs/HISTORY.md): its tables, the triggers that write and protect them, and
 * the functions behind them. One list, read by the
 * operator scripts that check the database (scripts/ops/app-role.ts,
 * restore-verify.ts, history-report.ts), the /status card, /api/health and the
 * e2e clean-up, so a table added to the history is added everywhere at once.
 * tests/unit/history-migration-guard.test.ts pins it against the migrations' SQL.
 *
 * PURE: no imports, so scripts can use it.
 */

/** The migrations that create the objects named here, oldest first. */
export const HISTORY_MIGRATIONS = [
  '20261013100100_history_foundation',
  '20261014100000_lossless_paths',
  // Part C: approval authority, job days, sign-in events (gaps 11, 21, 23) and
  // the rule that a route never changes region (gap 16).
  '20261015100000_authority_jobs_auth_events',
  '20261015100100_route_region_fixed',
  // Watch and prove (gap 30): the test-record flag and its owner-only guard.
  '20261024120000_test_records',
  // Watch and prove (gap 25): every purge writes a summary.
  '20261024120100_purge_summaries',
  // Watch and prove (gap 28): the ledgers' keys and the daily seal.
  '20261024120200_ledger_seals',
] as const;

/** INSERT-only tables written by the capture triggers, never by the application. */
export const HISTORY_TABLES = [
  'CustomerHistory',
  'BranchHistory',
  'UserHistory',
  'RouteOwnerHistory',
  'RouteHistory',
  'RegionHistory',
  // Gap 15 (lossless paths): every photo and document row.
  'AttachmentHistory',
] as const;
export type HistoryTable = (typeof HISTORY_TABLES)[number];

/** The master tables whose changes are captured, and the trigger names on each. */
export const CAPTURED_TABLES = ['Customer', 'Branch', 'User', 'Route', 'Region', 'Attachment'] as const;

/**
 * Append-only tables the APPLICATION writes (lossless paths, gaps 12 and 14; part
 * C, gaps 21 and 23): the runtime role may insert, never update or delete, and a
 * trigger refuses both outside the owner's maintenance window.
 */
export const APPEND_ONLY_APP_TABLES = [
  'EditRevision',
  'ExportJob',
  'JobRunDay',
  'AuthEvent',
  // Watch and prove (gap 25): the summary every retention rule writes as it deletes.
  'PurgeSummary',
  // Watch and prove (gap 28): the daily seal of the ledgers.
  'SealRecord',
] as const;

/**
 * The ones with a BIGSERIAL id: the runtime role draws ids from the sequence
 * (nextval on insert) but may not set it (setval would make inserts collide).
 * ExportJob's id is a cuid.
 */
export const LEDGER_SEQUENCE_TABLES = ['EditRevision', 'JobRunDay', 'AuthEvent', 'PurgeSummary', 'SealRecord'] as const;

/**
 * Gap 28 (20261024120200_ledger_seals): the sequences behind the seq key of the
 * three ledgers whose id is a cuid. The runtime role draws from them on every
 * insert (USAGE) and may never set them (setval would move a sealed range).
 */
export const LEDGER_SEQ_SEQUENCES = ['AuditLog_seq_seq', 'EditApproval_seq_seq', 'ExportJob_seq_seq'] as const;

/**
 * The four triggers that made AuditLog and EditApproval append-only, from the
 * migrations before the history (20260914150000 and 20260914160000). Not created
 * by the history migrations, so not in HISTORY_TRIGGERS; the nightly integrity
 * check (lib/integrity) expects them with the rest (PROTECTION_TRIGGERS).
 */
export const LEDGER_TRIGGERS = [
  'auditlog_append_only',
  'auditlog_no_truncate',
  'editapproval_append_only',
  'editapproval_no_truncate',
] as const;

/**
 * Gap 19 (lossless paths): a request, once sent, is evidence. Its original
 * customer is set once, what was sent cannot change, and it cannot be deleted.
 */
export const EVIDENCE_TRIGGERS = [
  'customeredit_original_customer',
  'customeredit_evidence_guard',
  'customeredit_no_delete',
  'customeredit_no_truncate',
  ...APPEND_ONLY_APP_TABLES.flatMap((t) => [
    `${t.toLowerCase()}_append_only`,
    `${t.toLowerCase()}_no_truncate`,
  ]),
] as const;

/**
 * Gap 30 (20261024120000_test_records): the tables carrying the isTest flag. Only
 * the owner, inside the maintenance window, may set or clear it
 * (nmwc_is_test_guard), on insert or update.
 */
export const TEST_FLAG_TABLES = ['Customer', 'User', 'Route', 'Region'] as const;

/** Every trigger the history migrations create. */
export const HISTORY_TRIGGERS: readonly string[] = [
  ...CAPTURED_TABLES.flatMap((t) => [
    `${t.toLowerCase()}_history_capture`,
    `${t.toLowerCase()}_history_capture_upd`,
  ]),
  // A manager's regions: one row per user at commit (a deferred constraint trigger).
  'managerregions_history_capture',
  // AuditLog rows carry the writer's source and the transaction id.
  'auditlog_stamp_context',
  // Part C (gap 23): every session cut-off, written by the database, and the
  // sign-in events the application inserts carry the same cause and transaction.
  'user_session_revoke_capture',
  'authevent_stamp_context',
  // Gap 25: a purge summary carries its writer's cause and transaction.
  'purgesummary_stamp_context',
  // Gap 28: a seal carries its writer's cause, and links to the last one.
  'sealrecord_stamp_context',
  'sealrecord_link_guard',
  // Part C (gap 16): a route never changes region.
  'route_region_fixed',
  ...HISTORY_TABLES.flatMap((t) => [
    `${t.toLowerCase()}_append_only`,
    `${t.toLowerCase()}_no_truncate`,
    `${t.toLowerCase()}_insert_guard`,
  ]),
  ...EVIDENCE_TRIGGERS,
  // Gap 30: the test flag moves only in the owner's maintenance window.
  ...TEST_FLAG_TABLES.flatMap((t) => [`${t.toLowerCase()}_is_test_guard_ins`, `${t.toLowerCase()}_is_test_guard_upd`]),
];

/** The functions behind them, and the as-of / report functions (docs/HISTORY.md). */
export const HISTORY_FUNCTIONS = [
  'nmwc_change_ctx',
  'nmwc_history_customer',
  'nmwc_history_branch',
  'nmwc_history_user',
  'nmwc_history_route',
  'nmwc_history_region',
  'nmwc_history_manager_regions',
  'nmwc_history_attachment',
  'nmwc_auditlog_stamp_context',
  'nmwc_history_insert_guard',
  'nmwc_customeredit_original_customer',
  'nmwc_customeredit_evidence_guard',
  'nmwc_user_session_revoke',
  'nmwc_route_region_fixed',
  'nmwc_day_end',
  'nmwc_branches_at',
  'nmwc_branches_on',
  'nmwc_customers_at',
  'nmwc_customers_on',
  'nmwc_users_at',
  'nmwc_users_on',
  'nmwc_routes_at',
  'nmwc_route_owners_at',
  'nmwc_route_owners_on',
  'nmwc_customer_service_on',
  'nmwc_customer_terms_on',
  'nmwc_route_owner_on',
  'nmwc_user_on',
  'nmwc_branch_intervals',
  'nmwc_customer_intervals',
  'nmwc_user_intervals',
  'nmwc_route_owner_intervals',
  'nmwc_customer_route_intervals',
  'nmwc_history_unattributed',
  'nmwc_is_test_guard',
  'nmwc_seal_link_guard',
] as const;

/** The SECURITY DEFINER capture functions: EXECUTE revoked from PUBLIC. */
export const HISTORY_DEFINER_FUNCTIONS = [
  'nmwc_history_customer',
  'nmwc_history_branch',
  'nmwc_history_user',
  'nmwc_history_route',
  'nmwc_history_region',
  'nmwc_history_manager_regions',
  'nmwc_history_attachment',
  // Part C (gap 23): the session cut-off capture.
  'nmwc_user_session_revoke',
] as const;

/** Trigger functions that are not definer-rights but whose EXECUTE is revoked from PUBLIC too. */
export const GUARD_FUNCTIONS = [
  'nmwc_history_insert_guard',
  'nmwc_customeredit_original_customer',
  'nmwc_customeredit_evidence_guard',
  'nmwc_route_region_fixed',
  'nmwc_is_test_guard',
  'nmwc_seal_link_guard',
] as const;

/** Every trigger that protects the ledgers and the history, checked nightly (lib/integrity). */
export const PROTECTION_TRIGGERS: readonly string[] = [...HISTORY_TRIGGERS, ...LEDGER_TRIGGERS];

/** The sequence behind each table's BIGSERIAL id (Prisma's naming). */
export const historySequence = (t: HistoryTable | string) => `${t}_id_seq`;

/** The source a write with no change context is recorded under. */
export const UNATTRIBUTED_SOURCE = 'sql';
