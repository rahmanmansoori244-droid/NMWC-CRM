/**
 * Gap 29 (data audit 2026-10-10): what the database's protection should be, for
 * the nightly checks protection-triggers and protection-functions
 * (lib/integrity/checks.ts).
 *
 * TRIGGER_BINDINGS: each protecting trigger's table and function, by its LAST
 * CREATE in the migrations, so a trigger re-pointed at another function (a
 * no-op, say) or moved to another table is caught, not only one dropped or
 * disabled. EXPECTED_FUNCTIONS: each of those functions' body (MD5 of
 * pg_proc.prosrc, the text between the dollar quotes of its LAST definition),
 * definer rights and search_path, so a body replaced with a no-op is caught.
 *
 * GENERATED from the migrations and held to them by
 * tests/unit/protection-functions-guard.test.ts (tests/support/migration-sql.ts
 * reads them). A migration that changes a trigger or one of these functions
 * changes this file in the same commit, or that test fails.
 *
 * PURE: no imports.
 */

export type TriggerBinding = { table: string; fn: string };

export const TRIGGER_BINDINGS: Record<string, TriggerBinding> = {
  attachment_history_capture: { table: 'Attachment', fn: 'nmwc_history_attachment' },
  attachment_history_capture_upd: { table: 'Attachment', fn: 'nmwc_history_attachment' },
  attachmenthistory_append_only: { table: 'AttachmentHistory', fn: 'nmwc_forbid_audit_mutation' },
  attachmenthistory_insert_guard: { table: 'AttachmentHistory', fn: 'nmwc_history_insert_guard' },
  attachmenthistory_no_truncate: { table: 'AttachmentHistory', fn: 'nmwc_forbid_audit_mutation' },
  auditlog_append_only: { table: 'AuditLog', fn: 'nmwc_forbid_audit_mutation' },
  auditlog_no_truncate: { table: 'AuditLog', fn: 'nmwc_forbid_audit_mutation' },
  auditlog_stamp_context: { table: 'AuditLog', fn: 'nmwc_auditlog_stamp_context' },
  authevent_append_only: { table: 'AuthEvent', fn: 'nmwc_forbid_audit_mutation' },
  authevent_no_truncate: { table: 'AuthEvent', fn: 'nmwc_forbid_audit_mutation' },
  authevent_stamp_context: { table: 'AuthEvent', fn: 'nmwc_auditlog_stamp_context' },
  branch_history_capture: { table: 'Branch', fn: 'nmwc_history_branch' },
  branch_history_capture_upd: { table: 'Branch', fn: 'nmwc_history_branch' },
  branchhistory_append_only: { table: 'BranchHistory', fn: 'nmwc_forbid_audit_mutation' },
  branchhistory_insert_guard: { table: 'BranchHistory', fn: 'nmwc_history_insert_guard' },
  branchhistory_no_truncate: { table: 'BranchHistory', fn: 'nmwc_forbid_audit_mutation' },
  customer_history_capture: { table: 'Customer', fn: 'nmwc_history_customer' },
  customer_history_capture_upd: { table: 'Customer', fn: 'nmwc_history_customer' },
  customer_is_test_guard_ins: { table: 'Customer', fn: 'nmwc_is_test_guard' },
  customer_is_test_guard_upd: { table: 'Customer', fn: 'nmwc_is_test_guard' },
  customeredit_evidence_guard: { table: 'CustomerEdit', fn: 'nmwc_customeredit_evidence_guard' },
  customeredit_no_delete: { table: 'CustomerEdit', fn: 'nmwc_forbid_audit_mutation' },
  customeredit_no_truncate: { table: 'CustomerEdit', fn: 'nmwc_forbid_audit_mutation' },
  customeredit_original_customer: { table: 'CustomerEdit', fn: 'nmwc_customeredit_original_customer' },
  customerhistory_append_only: { table: 'CustomerHistory', fn: 'nmwc_forbid_audit_mutation' },
  customerhistory_insert_guard: { table: 'CustomerHistory', fn: 'nmwc_history_insert_guard' },
  customerhistory_no_truncate: { table: 'CustomerHistory', fn: 'nmwc_forbid_audit_mutation' },
  editapproval_append_only: { table: 'EditApproval', fn: 'nmwc_forbid_audit_mutation' },
  editapproval_no_truncate: { table: 'EditApproval', fn: 'nmwc_forbid_audit_mutation' },
  editrevision_append_only: { table: 'EditRevision', fn: 'nmwc_forbid_audit_mutation' },
  editrevision_no_truncate: { table: 'EditRevision', fn: 'nmwc_forbid_audit_mutation' },
  exportjob_append_only: { table: 'ExportJob', fn: 'nmwc_forbid_audit_mutation' },
  exportjob_no_truncate: { table: 'ExportJob', fn: 'nmwc_forbid_audit_mutation' },
  integritycheckresult_append_only: { table: 'IntegrityCheckResult', fn: 'nmwc_forbid_audit_mutation' },
  integritycheckresult_no_truncate: { table: 'IntegrityCheckResult', fn: 'nmwc_forbid_audit_mutation' },
  integritycheckresult_stamp_context: { table: 'IntegrityCheckResult', fn: 'nmwc_auditlog_stamp_context' },
  jobrunday_append_only: { table: 'JobRunDay', fn: 'nmwc_forbid_audit_mutation' },
  jobrunday_no_truncate: { table: 'JobRunDay', fn: 'nmwc_forbid_audit_mutation' },
  managerregions_history_capture: { table: '_ManagerRegions', fn: 'nmwc_history_manager_regions' },
  purgesummary_append_only: { table: 'PurgeSummary', fn: 'nmwc_forbid_audit_mutation' },
  purgesummary_no_truncate: { table: 'PurgeSummary', fn: 'nmwc_forbid_audit_mutation' },
  purgesummary_stamp_context: { table: 'PurgeSummary', fn: 'nmwc_auditlog_stamp_context' },
  region_history_capture: { table: 'Region', fn: 'nmwc_history_region' },
  region_history_capture_upd: { table: 'Region', fn: 'nmwc_history_region' },
  region_is_test_guard_ins: { table: 'Region', fn: 'nmwc_is_test_guard' },
  region_is_test_guard_upd: { table: 'Region', fn: 'nmwc_is_test_guard' },
  regionhistory_append_only: { table: 'RegionHistory', fn: 'nmwc_forbid_audit_mutation' },
  regionhistory_insert_guard: { table: 'RegionHistory', fn: 'nmwc_history_insert_guard' },
  regionhistory_no_truncate: { table: 'RegionHistory', fn: 'nmwc_forbid_audit_mutation' },
  route_history_capture: { table: 'Route', fn: 'nmwc_history_route' },
  route_history_capture_upd: { table: 'Route', fn: 'nmwc_history_route' },
  route_is_test_guard_ins: { table: 'Route', fn: 'nmwc_is_test_guard' },
  route_is_test_guard_upd: { table: 'Route', fn: 'nmwc_is_test_guard' },
  route_region_fixed: { table: 'Route', fn: 'nmwc_route_region_fixed' },
  routehistory_append_only: { table: 'RouteHistory', fn: 'nmwc_forbid_audit_mutation' },
  routehistory_insert_guard: { table: 'RouteHistory', fn: 'nmwc_history_insert_guard' },
  routehistory_no_truncate: { table: 'RouteHistory', fn: 'nmwc_forbid_audit_mutation' },
  routeownerhistory_append_only: { table: 'RouteOwnerHistory', fn: 'nmwc_forbid_audit_mutation' },
  routeownerhistory_insert_guard: { table: 'RouteOwnerHistory', fn: 'nmwc_history_insert_guard' },
  routeownerhistory_no_truncate: { table: 'RouteOwnerHistory', fn: 'nmwc_forbid_audit_mutation' },
  sealrecord_append_only: { table: 'SealRecord', fn: 'nmwc_forbid_audit_mutation' },
  sealrecord_link_guard: { table: 'SealRecord', fn: 'nmwc_seal_link_guard' },
  sealrecord_no_truncate: { table: 'SealRecord', fn: 'nmwc_forbid_audit_mutation' },
  sealrecord_stamp_context: { table: 'SealRecord', fn: 'nmwc_auditlog_stamp_context' },
  user_history_capture: { table: 'User', fn: 'nmwc_history_user' },
  user_history_capture_upd: { table: 'User', fn: 'nmwc_history_user' },
  user_is_test_guard_ins: { table: 'User', fn: 'nmwc_is_test_guard' },
  user_is_test_guard_upd: { table: 'User', fn: 'nmwc_is_test_guard' },
  user_session_revoke_capture: { table: 'User', fn: 'nmwc_user_session_revoke' },
  userhistory_append_only: { table: 'UserHistory', fn: 'nmwc_forbid_audit_mutation' },
  userhistory_insert_guard: { table: 'UserHistory', fn: 'nmwc_history_insert_guard' },
  userhistory_no_truncate: { table: 'UserHistory', fn: 'nmwc_forbid_audit_mutation' },
};

export type ExpectedFunction = { md5: string; securityDefiner: boolean; searchPath: string };

export const EXPECTED_FUNCTIONS: Record<string, ExpectedFunction> = {
  nmwc_auditlog_stamp_context: { md5: '2661ca65dd20769076b7c03099f3151a', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_change_ctx: { md5: '3475a813555986410bf0f50174b54922', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_customeredit_evidence_guard: { md5: 'c1413cbbd5d0fde4f7d784a88cd09af7', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_customeredit_original_customer: { md5: '26dc698497068561d475a44cb8eebc65', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_forbid_audit_mutation: { md5: '8324ddcaab94e45548d3e512045dfbd8', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_attachment: { md5: '7705a94a832b7d25197eb7bd7147c4dd', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_branch: { md5: '9cfe33401d17064de4110d3128f38ef3', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_customer: { md5: '773bc2b61c26feb6481eb9da2bb686d4', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_insert_guard: { md5: '20ae04a65303f0ca12d6dbface09b0e2', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_manager_regions: { md5: '1a80d1fa65ef1be4da32e25da6e48ace', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_region: { md5: 'fb522fea5ec7914266ba4f4355ec8e16', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_route: { md5: '21f2c7dd70ed20aa2d3c11075939e5b4', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_history_user: { md5: '86ebf19db6f72cd59bf8ae0c8ce7fc78', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_is_test_guard: { md5: '0442bceee43ab7f7bf190f32c155c549', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_route_region_fixed: { md5: 'a9a4fd4aae18cae3bbf13e603d8dd589', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_seal_link_guard: { md5: '7fb2e3eccda3f9ca9a5df53dc04be0e0', securityDefiner: false, searchPath: 'pg_catalog, public, pg_temp' },
  nmwc_user_session_revoke: { md5: '66ec5043ce2d7841596e616ad861b0ec', securityDefiner: true, searchPath: 'pg_catalog, public, pg_temp' },
};
