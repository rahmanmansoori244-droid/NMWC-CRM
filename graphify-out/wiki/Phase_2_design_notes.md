# Phase 2 design notes

> 46 nodes · cohesion 0.09

## Key Concepts

- **UX, mobile and data-integrity audit (2026-05-09)** (20 connections) — `docs/audit/06-ux-data-integrity.md`
- **Lead's corrections overriding the Phase 2 spec (2026-09-29)** (16 connections) — `docs/design/phase2-edit-semantics/CORRECTIONS.md`
- **Phase 2 design notes — edit-form semantics (design record behind ab6d998)** (15 connections) — `docs/design/phase2-edit-semantics/README.md`
- **Spec: approval behaviour for the final UPDATE step** (11 connections) — `docs/design/phase2-edit-semantics/spec-approval_behaviour.txt`
- **Three Phase 2 design angles: minimal, correctness-first, operator-first** (10 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **Edit patch v2: send touched fields with their loaded base; omitted=keep, null=clear, value=set** (9 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **F21 Equipment "Counted" scoring and import rescore** (8 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **Critique of the Phase 2 spec (15 items and cuts)** (8 connections) — `docs/design/phase2-edit-semantics/critique.txt`
- **Spec: phone draft compatibility across the Phase 2 deploy** (8 connections) — `docs/design/phase2-edit-semantics/spec-draft_compatibility.txt`
- **F06 Lost update: silent overwrite of values changed after the form opened** (7 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **F05 Salesman mandatory gate limited to branches his page shows (frozen submitGate)** (6 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **F16 Channel / sub-channel pair validated on edit and import** (6 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **F19 Phones normalised then validated (Arabic-Indic and Persian digits)** (6 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **STALE_FIELDS field-level submit refusal carrying the live value** (6 connections) — `docs/design/phase2-edit-semantics/angles.txt`
- **Cross-cutting integrity invariants verification matrix** (5 connections) — `docs/audit/06-ux-data-integrity.md`
- **UXI-007 Equipment sub-score cannot credit a confirmed-empty shop** (5 connections) — `docs/audit/06-ux-data-integrity.md`
- **UXI-003 Stale draft silently reverts newer server changes** (4 connections) — `docs/audit/06-ux-data-integrity.md`
- **UXI-006 Phone normalization drops Arabic-Indic digits, accepts bad lengths** (4 connections) — `docs/audit/06-ux-data-integrity.md`
- **UXI-008 Attachment soft-delete via r2Key sentinel not filtered on lookups** (4 connections) — `docs/audit/06-ux-data-integrity.md`
- **UXI-021 Sub-channel not validated against channel server-side** (4 connections) — `docs/audit/06-ux-data-integrity.md`
- **Owner decisions 2026-09-29: sub-channel cleared on import channel change, CR clearable, equipment Counted rules, no backfill** (4 connections) — `docs/design/phase2-edit-semantics/CORRECTIONS.md`
- **Critique 1: automatic rebase after STALE_FIELDS hides a one-tap overwrite** (4 connections) — `docs/design/phase2-edit-semantics/critique.txt`
- **STALE_BEFORE: whole approval refused if a stored before no longer matches live** (4 connections) — `docs/design/phase2-edit-semantics/spec-approval_behaviour.txt`
- **draftIsStale: drafts without a base (pre-item-22) are dropped** (4 connections) — `docs/design/phase2-edit-semantics/spec-draft_compatibility.txt`
- **UXI-002 Offline draft keyed only by customer leaks between users** (3 connections) — `docs/audit/06-ux-data-integrity.md`
- *... and 21 more nodes in this community*

## Relationships

- [[Cross-domain and RBAC audits]] (7 shared connections)
- [[Photos and completeness scoring]] (4 shared connections)
- [[End-to-end verification and seeds]] (3 shared connections)
- [[Edit submit and approval engine]] (3 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (2 shared connections)
- [[Enrichment form and patch v2]] (2 shared connections)
- [[New-customer creation and phones]] (2 shared connections)
- [[Original PRD and UX spec]] (2 shared connections)
- [[Access scope and submit gate]] (2 shared connections)
- [[Sentry PII scrubbing]] (2 shared connections)
- [[Handover and go-live runbook]] (2 shared connections)
- [[Phone drafts and form reliability]] (2 shared connections)

## Source Files

- `docs/audit/06-ux-data-integrity.md`
- `docs/audit/07-cross-check.md`
- `docs/design/phase2-edit-semantics/CORRECTIONS.md`
- `docs/design/phase2-edit-semantics/README.md`
- `docs/design/phase2-edit-semantics/angles.txt`
- `docs/design/phase2-edit-semantics/critique.txt`
- `docs/design/phase2-edit-semantics/spec-approval_behaviour.txt`
- `docs/design/phase2-edit-semantics/spec-draft_compatibility.txt`

## Audit Trail

- EXTRACTED: 197 (88%)
- INFERRED: 28 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*