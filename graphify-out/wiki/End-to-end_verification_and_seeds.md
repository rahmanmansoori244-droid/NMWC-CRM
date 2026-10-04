# End-to-end verification and seeds

> 31 nodes · cohesion 0.09

## Key Concepts

- **NMWC-CRM end-to-end production verification (2026-05-10)** (15 connections) — `docs/audit/E2E-VERIFICATION-2026-05-10.md`
- **seed-muscat-customers.ts** (12 connections) — `prisma/seed-muscat-customers.ts`
- **EL-01: Salesman can flip customer-level status to CLOSED via the edit form** (9 connections) — `docs/audit/02-edit-lifecycle.md`
- **DB invariants and workflow state-machine audit (2026-05-10)** (9 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **Server action error contract — PROD-006 (2026-05-10)** (7 connections) — `docs/audit/server-actions-error-contract.md`
- **approveReactivationAction()** (7 connections) — `services/reactivations.ts`
- **NEW-PHOTO-007 Reactivation evidence back-dated via client capturedAt** (4 connections) — `docs/audit/04-photos.md`
- **UXI-004 Double-tap fires two submits** (4 connections) — `docs/audit/06-ux-data-integrity.md`
- **CHAIN-07 Back-dated deleted photo used for a cross-region reactivation** (4 connections) — `docs/audit/07-cross-check.md`
- **CHAIN-10 Double-submit + back-nav + opaque P2002 = unclear submit outcome** (4 connections) — `docs/audit/07-cross-check.md`
- **DB-01 Seed-imported 2-character address bypasses the >=3 gate** (4 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **DB-02 CLOSED/SUSPENDED branches with null lastStatusChangeAt** (4 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **Reactivation freshness anchor Branch.lastStatusChangeAt (EL-11/EL-12)** (4 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **ActionResult / SafeAction discriminated-union error contract** (4 connections) — `docs/audit/server-actions-error-contract.md`
- **RBAC-05-008 Reactivation queue and approval not region-scoped** (3 connections) — `docs/audit/05-rbac-scope.md`
- **UXI-005 Back after submit shows a stale re-submittable form** (3 connections) — `docs/audit/06-ux-data-integrity.md`
- **DB-03 "Address pending" placeholder passes the mandatory gate** (3 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **Partial unique indexes: active primary phone, one open edit per customer** (3 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **Branch close -> supervisor approve -> reactivation request -> manager approve cycle** (3 connections) — `docs/audit/E2E-VERIFICATION-2026-05-10.md`
- **Prisma P2002 -> UNIQUE_CONSTRAINT safety-net translation** (3 connections) — `docs/audit/server-actions-error-contract.md`
- **main()** (3 connections) — `prisma/seed-muscat-customers.ts`
- **readRows()** (3 connections) — `prisma/seed-muscat-customers.ts`
- **CustomerEdit state machine (DRAFT, SUBMITTED, APPROVED, NEEDS_CORRECTION, REJECTED)** (2 connections) — `docs/audit/db-invariants-2026-05-10.md`
- **R2 forcePathStyle keeps presigned PUT URLs on the CSP-allowed host** (2 connections) — `docs/audit/E2E-VERIFICATION-2026-05-10.md`
- **B-14 Approve and Reactivate use window.confirm()** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- *... and 6 more nodes in this community*

## Relationships

- [[Cross-domain and RBAC audits]] (6 shared connections)
- [[Photo upload and R2]] (5 shared connections)
- [[runAction area]] (4 shared connections)
- [[Edit submit and approval engine]] (3 shared connections)
- [[Phase 2 design notes]] (3 shared connections)
- [[CR normalisation and row checks]] (3 shared connections)
- [[New-customer creation and phones]] (3 shared connections)
- [[May 2026 audits and remediation]] (2 shared connections)
- [[Enrichment form and patch v2]] (2 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (2 shared connections)
- [[errors area]] (2 shared connections)
- [[NMWC Customer Master Technical Specifica area]] (1 shared connections)

## Source Files

- `docs/audit/02-edit-lifecycle.md`
- `docs/audit/04-photos.md`
- `docs/audit/05-rbac-scope.md`
- `docs/audit/06-ux-data-integrity.md`
- `docs/audit/07-cross-check.md`
- `docs/audit/E2E-VERIFICATION-2026-05-10.md`
- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `docs/audit/db-invariants-2026-05-10.md`
- `docs/audit/server-actions-error-contract.md`
- `prisma/seed-muscat-customers.ts`
- `services/reactivations.ts`

## Audit Trail

- EXTRACTED: 112 (87%)
- INFERRED: 17 (13%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*