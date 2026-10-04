# New-customer creation and phones

> 56 nodes · cohesion 0.07

## Key Concepts

- **creates.ts** (63 connections) — `services/creates.ts`
- **normalizePhone()** (26 connections) — `lib/phone.ts`
- **create.ts** (25 connections) — `lib/validation/create.ts`
- **fields.ts** (25 connections) — `lib/validation/fields.ts`
- **phone.ts** (19 connections) — `lib/phone.ts`
- **submitCreateOnce()** (18 connections) — `services/creates.ts`
- **duplicate-detection.test.ts** (17 connections) — `tests/integration/duplicate-detection.test.ts`
- **notifications.ts** (15 connections) — `lib/notifications.ts`
- **Phase 2 spec: per-finding designs** (13 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **notifyUsers()** (12 connections) — `lib/notifications.ts`
- **findReceipt()** (11 connections) — `lib/submission-replay.ts`
- **F19: phone fold and normalise before validate (Persian digits accepted)** (11 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **isValidPhoneFormat()** (10 connections) — `lib/phone.ts`
- **create-flow.test.ts** (10 connections) — `tests/unit/create-flow.test.ts`
- **N02: strip HTML before the length check** (9 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **resolveStepAudience()** (8 connections) — `lib/notifications.ts`
- **shownTime()** (6 connections) — `lib/submission-replay.ts`
- **Risk: more refusals where there was silent success (intended)** (6 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **phone.test.ts** (6 connections) — `tests/unit/phone.test.ts`
- **reportedIssues()** (6 connections) — `lib/validation/fields.ts`
- **requiredText / clearableText / requiredPhone / clearablePhone zod helpers** (5 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **submitCreateSchema** (5 connections) — `lib/validation/create.ts`
- **mk()** (4 connections) — `tests/integration/duplicate-detection.test.ts`
- **photoClaimedConflict()** (4 connections) — `services/creates.ts`
- **submitCreateCore()** (4 connections) — `services/creates.ts`
- *... and 31 more nodes in this community*

## Relationships

- [[CR normalisation and row checks]] (14 shared connections)
- [[Edit submit and approval engine]] (13 shared connections)
- [[Edit value model]] (10 shared connections)
- [[Approval chains and detail page]] (9 shared connections)
- [[Submission receipts and replay]] (9 shared connections)
- [[reactivations area]] (8 shared connections)
- [[Edit service and channel pairs]] (8 shared connections)
- [[gps-manual area]] (8 shared connections)
- [[submit-body-bounds.test area]] (8 shared connections)
- [[create-guards area]] (6 shared connections)
- [[errors area]] (6 shared connections)
- [[Enrichment form and patch v2]] (5 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- `lib/enrichment-patch.ts`
- `lib/notifications.ts`
- `lib/phone.ts`
- `lib/submission-replay.ts`
- `lib/validation/create.ts`
- `lib/validation/fields.ts`
- `services/creates.ts`
- `tests/integration/duplicate-detection.test.ts`
- `tests/unit/create-flow.test.ts`
- `tests/unit/phone.test.ts`

## Audit Trail

- EXTRACTED: 400 (99%)
- INFERRED: 3 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*