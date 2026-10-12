/**
 * The dated history (prisma/migrations/20261013100100_history_foundation,
 * docs/HISTORY.md): its tables, the triggers that write and protect them, and the
 * functions behind them. One list, read by the operator scripts that check the
 * database (scripts/ops/app-role.ts, restore-verify.ts, history-report.ts), the
 * /status card and the e2e clean-up, so a table added to the history is added
 * everywhere at once. tests/unit/history-migration-guard.test.ts pins it against
 * the migration's SQL.
 *
 * PURE: no imports, so scripts can use it.
 */

/** INSERT-only tables written by the capture triggers, never by the application. */
export const HISTORY_TABLES = [
  'CustomerHistory',
  'BranchHistory',
  'UserHistory',
  'RouteOwnerHistory',
  'RouteHistory',
  'RegionHistory',
] as const;
export type HistoryTable = (typeof HISTORY_TABLES)[number];

/** The master tables whose changes are captured, and the trigger names on each. */
export const CAPTURED_TABLES = ['Customer', 'Branch', 'User', 'Route', 'Region'] as const;

/** Every trigger the history foundation creates. */
export const HISTORY_TRIGGERS: readonly string[] = [
  ...CAPTURED_TABLES.flatMap((t) => [
    `${t.toLowerCase()}_history_capture`,
    `${t.toLowerCase()}_history_capture_upd`,
  ]),
  // A manager's regions: one row per user at commit (a deferred constraint trigger).
  'managerregions_history_capture',
  // AuditLog rows carry the writer's source and the transaction id.
  'auditlog_stamp_context',
  ...HISTORY_TABLES.flatMap((t) => [
    `${t.toLowerCase()}_append_only`,
    `${t.toLowerCase()}_no_truncate`,
    `${t.toLowerCase()}_insert_guard`,
  ]),
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
  'nmwc_auditlog_stamp_context',
  'nmwc_history_insert_guard',
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
] as const;

/** The SECURITY DEFINER capture functions: EXECUTE revoked from PUBLIC. */
export const HISTORY_DEFINER_FUNCTIONS = [
  'nmwc_history_customer',
  'nmwc_history_branch',
  'nmwc_history_user',
  'nmwc_history_route',
  'nmwc_history_region',
  'nmwc_history_manager_regions',
] as const;

/** The sequence behind each table's BIGSERIAL id (Prisma's naming). */
export const historySequence = (t: HistoryTable | string) => `${t}_id_seq`;

/** The source a write with no change context is recorded under. */
export const UNATTRIBUTED_SOURCE = 'sql';
