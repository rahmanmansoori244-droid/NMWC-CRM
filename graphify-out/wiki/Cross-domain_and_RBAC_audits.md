# Cross-domain and RBAC audits

> 39 nodes · cohesion 0.08

## Key Concepts

- **Audit 07 — Cross-domain chains, contradictions, gaps and launch readiness (2026-05-09)** (27 connections) — `docs/audit/07-cross-check.md`
- **Audit 05 — RBAC and scope enforcement (2026-05-09)** (20 connections) — `docs/audit/05-rbac-scope.md`
- **F-01: export scope filter overwritten by user query parameters** (8 connections) — `docs/audit/03-imports-exports.md`
- **Option A — read-only field mode with Steward-driven import** (8 connections) — `docs/audit/07-cross-check.md`
- **RBAC-05-003 Manager can approve any edit globally** (6 connections) — `docs/audit/05-rbac-scope.md`
- **EL-04: approve does not re-run the mandatory-field gate** (5 connections) — `docs/audit/02-edit-lifecycle.md`
- **NEW-PHOTO-009 Private photo cache survives access revocation** (5 connections) — `docs/audit/04-photos.md`
- **RBAC-05-015 Soft-deleted attachments return 502, leaking ID validity** (5 connections) — `docs/audit/05-rbac-scope.md`
- **CHAIN-02 Photo detached after submit, edit approved cross-region without CR photo** (5 connections) — `docs/audit/07-cross-check.md`
- **GAP-02 Sentry did not scrub URLs, bodies or exception values** (5 connections) — `docs/audit/07-cross-check.md`
- **Option B — two-route pilot with a single Manager** (5 connections) — `docs/audit/07-cross-check.md`
- **AUTH-12: logout does not invalidate the JWT (cookie replay)** (4 connections) — `docs/audit/01-auth-session.md`
- **EL-03: phone-uniqueness error leaks another region's customer name and code** (4 connections) — `docs/audit/02-edit-lifecycle.md`
- **NEW-PHOTO-002 Cross-user hash dedupe acts as a confirmation oracle** (4 connections) — `docs/audit/04-photos.md`
- **RBAC-05-001 Salesman sees neighbour-branch data of multi-branch customers** (4 connections) — `docs/audit/05-rbac-scope.md`
- **RBAC-05-007 /audit is global for Manager and denied to Steward** (4 connections) — `docs/audit/05-rbac-scope.md`
- **RBAC-05-012 canSeeCustomer fails open for a Manager with no regions** (4 connections) — `docs/audit/05-rbac-scope.md`
- **RBAC-05-014 Uploader bypass in assertCanAccessAttachment after wiring** (4 connections) — `docs/audit/05-rbac-scope.md`
- **RBAC-05-018 Privileged actions trust a stale JWT role** (4 connections) — `docs/audit/05-rbac-scope.md`
- **Role model: SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER** (4 connections) — `docs/audit/05-rbac-scope.md`
- **UXI-001 Photo trash button removes a mandatory photo with no confirm** (4 connections) — `docs/audit/06-ux-data-integrity.md`
- **CHAIN-01 Import-minted Manager approves cross-region edits** (4 connections) — `docs/audit/07-cross-check.md`
- **CHAIN-03 Logout keeps JWT valid + photo cache + uploader bypass** (4 connections) — `docs/audit/07-cross-check.md`
- **CHAIN-05 Phone-collision leak + global audit/users PII = directory harvest** (4 connections) — `docs/audit/07-cross-check.md`
- **CHAIN-06 Export scope bypass + soft-deleted 502 + unscrubbed Sentry URLs** (4 connections) — `docs/audit/07-cross-check.md`
- *... and 14 more nodes in this community*

## Relationships

- [[May 2026 audits and remediation]] (14 shared connections)
- [[Phase 2 design notes]] (7 shared connections)
- [[Photo upload and R2]] (6 shared connections)
- [[End-to-end verification and seeds]] (6 shared connections)
- [[runAction area]] (4 shared connections)
- [[NMWC Independent QA / Security / Reliabi area]] (3 shared connections)
- [[route area]] (3 shared connections)
- [[Original PRD and UX spec]] (3 shared connections)
- [[Access scope and submit gate]] (3 shared connections)
- [[Approval service and supervisor guides]] (3 shared connections)
- [[Sentry PII scrubbing]] (3 shared connections)
- [[Photo attach routes]] (2 shared connections)

## Source Files

- `docs/QA-AUDIT-REPORT.md`
- `docs/SESSION-MASTER-RECORD.md`
- `docs/audit/01-auth-session.md`
- `docs/audit/02-edit-lifecycle.md`
- `docs/audit/03-imports-exports.md`
- `docs/audit/04-photos.md`
- `docs/audit/05-rbac-scope.md`
- `docs/audit/06-ux-data-integrity.md`
- `docs/audit/07-cross-check.md`
- `docs/audit/db-invariants-2026-05-10.md`

## Audit Trail

- EXTRACTED: 167 (91%)
- INFERRED: 17 (9%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*