# Original PRD and UX spec

> 29 nodes · cohesion 0.09

## Key Concepts

- **NMWC Customer Master Cleanup PRD v0.2** (25 connections) — `docs/PRD-v0.1.md`
- **NMWC Customer Master UX Specification** (14 connections) — `docs/UX-SPEC.md`
- **Five roles: Salesman, Supervisor, Manager, Data Steward, Viewer** (4 connections) — `docs/PRD-v0.1.md`
- **One-step Supervisor approval workflow with NEEDS_CORRECTION loop** (3 connections) — `docs/PRD-v0.1.md`
- **Completeness scoring: 40 customer points + 60 branch points** (3 connections) — `docs/PRD-v0.1.md`
- **One open (SUBMITTED) edit per customer** (3 connections) — `docs/PRD-v0.1.md`
- **Field validation catalogue** (3 connections) — `docs/PRD-v0.1.md`
- **Enrichment form /customers/:id/edit** (3 connections) — `docs/UX-SPEC.md`
- **Mobile and desktop layout primitives (bottom tab bar for Salesman only)** (3 connections) — `docs/UX-SPEC.md`
- **EL-06: local draft restored over fresher server state without warning** (2 connections) — `docs/audit/02-edit-lifecycle.md`
- **Locked channel and sub-channel taxonomy (7 channels)** (2 connections) — `docs/PRD-v0.1.md`
- **Field-driven enrichment tool, v1 edit-only** (2 connections) — `docs/PRD-v0.1.md`
- **Permission matrix by role** (2 connections) — `docs/PRD-v0.1.md`
- **Work Items page replaces email notifications (O6)** (2 connections) — `docs/PRD-v0.1.md`
- **Two legacy systems: ICO Customer Portal and NMWC Customer Master** (2 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Migration 20260509150000_qa_remediation (open-edit and phone partial uniques, RateLimit)** (2 connections) — `docs/REMEDIATION-REPORT.md`
- **Non-salesman roles had no navigation on a phone** (2 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Completeness score pure function (lib/completeness.ts)** (2 connections) — `docs/TECH-SPEC.md`
- **Prisma schema v1 (five-role enum, Customer, Branch, CustomerEdit, Attachment, AuditLog)** (2 connections) — `docs/TECH-SPEC.md`
- **Call and Directions chips on customer rows** (2 connections) — `docs/UX-SPEC.md`
- **Custom NMWC components (CompletenessRing, PhotoCaptureSlot, GpsCaptureButton, DiffField)** (2 connections) — `docs/UX-SPEC.md`
- **Navigation map per role** (2 connections) — `docs/UX-SPEC.md`
- **/today Salesman home screen** (2 connections) — `docs/UX-SPEC.md`
- **/work Work Items inbox** (2 connections) — `docs/UX-SPEC.md`
- **Core entities: Customer, Branch, CustomerEdit, Attachment, AuditLog, ImportBatch** (1 connections) — `docs/PRD-v0.1.md`
- *... and 4 more nodes in this community*

## Relationships

- [[May 2026 audits and remediation]] (5 shared connections)
- [[Operations runbook]] (3 shared connections)
- [[Cross-domain and RBAC audits]] (3 shared connections)
- [[NMWC Customer Master Technical Specifica area]] (3 shared connections)
- [[Master session record and assessment]] (3 shared connections)
- [[Roadmap and service levels]] (3 shared connections)
- [[Phase 2 design notes]] (2 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (2 shared connections)
- [[NMWC Independent QA / Security / Reliabi area]] (1 shared connections)
- [[Session Handoff 2026-05-10 area]] (1 shared connections)

## Source Files

- `docs/PRD-v0.1.md`
- `docs/PROJECT-DESCRIPTION.md`
- `docs/REMEDIATION-REPORT.md`
- `docs/SESSION-MASTER-RECORD.md`
- `docs/TECH-SPEC.md`
- `docs/UX-SPEC.md`
- `docs/audit/02-edit-lifecycle.md`

## Audit Trail

- EXTRACTED: 79 (82%)
- INFERRED: 17 (18%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*