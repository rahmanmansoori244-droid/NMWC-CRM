# Phase 2 spec contract

> 34 nodes · cohesion 0.09

## Key Concepts

- **Phase 2 spec: risks and deliberately left out** (16 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **Phase 2 spec: errors and messages** (13 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **Phase 2 spec: payload contract** (11 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **STALE_BEFORE approval refusal (ConflictError, 409)** (9 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **STALE_FIELDS error (StaleFieldsError, 409)** (9 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **SubmitEditInput v2 payload (EDIT_PAYLOAD_VERSION = 2)** (7 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **Approval-page stale banner with approveBlockedReason (Approve disabled)** (6 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **PII-lean notification content (codes and names, never phones or CR numbers)** (5 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Messages carry field labels, never values** (4 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **"Use this value" button (rebase a stale field to live)** (4 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **GPS companions (gpsAccuracy, gpsCapturedAt)** (4 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **F12: Temix lifecycle (owner item, no new requeue)** (4 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **Q-temix-headers: exact Temix upload / refresh sheet schema** (3 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **FORM_OUTDATED error (FormOutdatedError, 409)** (3 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **PII-free log events (import.promote.subchannel_cleared, edit.approve.stale_before, edit.approve.submit_gate_unreadable)** (3 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **ActionResult.current: live values per raw path on STALE_FIELDS** (3 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **BaseValue: the value the form loaded for a touched field** (3 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **BranchPatchInput (strict, GPS group rules, per-key base)** (3 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **FIELD_LABEL map** (3 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **StoredFieldChange (fieldChanges entry: before = live, after = value or null)** (3 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **Risk: false conflicts from value representation** (3 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **Left out: folding the other rescoring writers into one helper** (3 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **"Cleared" display for explicit clears on the approval page** (2 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **VERSION_CONFLICT refusal (unchanged)** (2 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **CustomerPatchInput (key present = touched, absent = keep)** (2 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- *... and 9 more nodes in this community*

## Relationships

- [[Edit value model]] (7 shared connections)
- [[Edit service and channel pairs]] (5 shared connections)
- [[Enrichment form and patch v2]] (5 shared connections)
- [[New-customer creation and phones]] (4 shared connections)
- [[Design: SLA / escalation, notifications  area]] (3 shared connections)
- [[errors area]] (3 shared connections)
- [[NMWC Unified CRM: target operating model area]] (2 shared connections)
- [[Access scope and submit gate]] (2 shared connections)
- [[Submission receipts and replay]] (2 shared connections)
- [[DB roles and migrations]] (2 shared connections)
- [[Photos and completeness scoring]] (2 shared connections)
- [[logger area]] (1 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- `docs/discovery/blueprint-inputs/sla-notif-sync.md`

## Audit Trail

- EXTRACTED: 137 (96%)
- INFERRED: 6 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*