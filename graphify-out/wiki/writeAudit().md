# writeAudit()

> God node · 61 connections · `lib/audit.ts`

**Community:** [[Audit log writing]]

## Connections by Relation

### calls
- [[approveEditCore()]] `EXTRACTED`
- [[promoteCustomerBatchCore()]] `EXTRACTED`
- [[submitEditOnce()]] `EXTRACTED`
- [[uploadAccountMasterCore()]] `EXTRACTED`
- [[submitCreateOnce()]] `EXTRACTED`
- [[mergeCustomersCore()]] `EXTRACTED`
- [[finalizeCreateInTx()]] `EXTRACTED`
- [[rejectEditCore()]] `EXTRACTED`
- [[attachPhotoCore()]] `EXTRACTED`
- [[detachPhotoCore()]] `EXTRACTED`
- [[approveReactivationCore()]] `EXTRACTED`
- [[archiveCustomerCore()]] `EXTRACTED`
- [[undoDismissDuplicateCore()]] `EXTRACTED`
- [[GET()]] `EXTRACTED`
- [[exportFilteredCustomersCore()]] `EXTRACTED`
- [[createUserCore()]] `EXTRACTED`
- [[buildCustomerExport()]] `EXTRACTED`
- [[generateTemixBatchCore()]] `EXTRACTED`
- [[resetPasswordCore()]] `EXTRACTED`
- [[dismissDuplicateCore()]] `EXTRACTED`

### conceptually_related_to
- [[Append-only ledger: AuditLog and EditApproval immutable at the database]] `INFERRED`
- [[CompletenessRescore STARTING / COMPLETED ledger rows]] `EXTRACTED`

### contains
- [[audit.ts]] `EXTRACTED`

### imports
- [[edits.ts]] `EXTRACTED`
- [[imports.ts]] `EXTRACTED`
- [[import-fixes.ts]] `EXTRACTED`
- [[creates.ts]] `EXTRACTED`
- [[auth.ts]] `EXTRACTED`
- [[reactivations.ts]] `EXTRACTED`
- [[duplicates.ts]] `EXTRACTED`
- [[temix.ts]] `EXTRACTED`
- [[photos.ts]] `EXTRACTED`
- [[users.ts]] `EXTRACTED`
- [[route.ts]] `EXTRACTED`
- [[customer-export.ts]] `EXTRACTED`
- [[routes.ts]] `EXTRACTED`
- [[customers.ts]] `EXTRACTED`
- [[create-finalize.ts]] `EXTRACTED`
- [[exports.ts]] `EXTRACTED`
- [[auth.ts]] `EXTRACTED`
- [[route.ts]] `EXTRACTED`

### references
- [[Records of processing activities (draft, 2026-09-14)]] `EXTRACTED`
- [[Lead's corrections overriding the Phase 2 spec (2026-09-29)]] `EXTRACTED`
- [[Manager/Steward direct write under the customer row lock]] `EXTRACTED`
- [[audit-guard.test.ts]] `EXTRACTED`
- [[B-03 AuditLog ip and userAgent never populated]] `EXTRACTED`
- [[Operator maintenance scripts write AuditLog with null ip/userAgent by construction]] `EXTRACTED`
- [[Completeness critic: AuditLog has no retention or archival]] `EXTRACTED`
- [[DG-06/07 all audit writers routed through writeAudit (lint-guarded)]] `EXTRACTED`

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*