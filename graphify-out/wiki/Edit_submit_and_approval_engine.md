# Edit submit and approval engine

> 46 nodes · cohesion 0.09

## Key Concepts

- **edits.ts** (137 connections) — `services/edits.ts`
- **approveEditCore()** (44 connections) — `services/edits.ts`
- **submitEditOnce()** (34 connections) — `services/edits.ts`
- **edit-approval.ts** (22 connections) — `lib/edit-approval.ts`
- **collectMissingMandatory()** (12 connections) — `services/edits.ts`
- **classifyChanges()** (10 connections) — `lib/edit-values.ts`
- **isFieldLocked()** (10 connections) — `lib/permissions.ts`
- **planApproval()** (9 connections) — `lib/edit-approval.ts`
- **toBaseValue()** (9 connections) — `lib/edit-values.ts`
- **evidenceIds()** (8 connections) — `lib/status-evidence.ts`
- **submit-gate.ts** (8 connections) — `lib/submit-gate.ts`
- **staleFieldsError()** (8 connections) — `services/edits.ts`
- **[1] P1 EL-04 re-check blocks branch-CLOSE approvals for imported customers** (7 connections) — `qa/findings/final-golive-hunt.md`
- **fieldSlotKey()** (7 connections) — `lib/edit-values.ts`
- **assertStatusEvidence()** (7 connections) — `lib/status-evidence.ts`
- **staleLabelsForPendingEdit()** (6 connections) — `lib/edit-approval.ts`
- **classifyPointAgainstLive()** (6 connections) — `lib/edit-values.ts`
- **liveSnapshotOf()** (6 connections) — `lib/edit-values.ts`
- **submitEditCore()** (6 connections) — `services/edits.ts`
- **staleFieldLabels()** (5 connections) — `lib/edit-approval.ts`
- **storedFieldChanges()** (5 connections) — `lib/edit-approval.ts`
- **requireUser()** (5 connections) — `services/edits.ts`
- **EL-04 approve-time mandatory-field re-check** (4 connections) — `qa/findings/final-golive-hunt.md`
- **channelPairInvalidMessage()** (4 connections) — `lib/edit-approval.ts`
- **sentByPreviousForm()** (4 connections) — `lib/edit-approval.ts`
- *... and 21 more nodes in this community*

## Relationships

- [[Edit value model]] (42 shared connections)
- [[Approval chains and detail page]] (25 shared connections)
- [[Access scope and submit gate]] (19 shared connections)
- [[Approval service and supervisor guides]] (14 shared connections)
- [[New-customer creation and phones]] (13 shared connections)
- [[Photos and completeness scoring]] (12 shared connections)
- [[Enrichment form and patch v2]] (9 shared connections)
- [[gps-manual area]] (8 shared connections)
- [[Edit service and channel pairs]] (8 shared connections)
- [[Approval decision UI and bulk]] (8 shared connections)
- [[errors area]] (8 shared connections)
- [[reactivations area]] (7 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- `docs/discovery/raw-evidence/new-docs.md`
- `lib/create-finalize.ts`
- `lib/edit-approval.ts`
- `lib/edit-scope.ts`
- `lib/edit-values.ts`
- `lib/notifications.ts`
- `lib/permissions.ts`
- `lib/status-evidence.ts`
- `lib/submit-gate.ts`
- `lib/validation/edit.ts`
- `qa/findings/final-golive-hunt.md`
- `qa/findings/pre-launch-deep-review.md`
- `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- `services/edits.ts`

## Audit Trail

- EXTRACTED: 434 (98%)
- INFERRED: 11 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*