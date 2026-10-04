# Photos and completeness scoring

> 33 nodes · cohesion 0.13

## Key Concepts

- **photos.ts** (43 connections) — `services/photos.ts`
- **completeness.ts** (32 connections) — `lib/completeness.ts`
- **scoreCustomer()** (26 connections) — `lib/completeness.ts`
- **scoreBranch()** (24 connections) — `lib/completeness.ts`
- **applyEditChanges()** (17 connections) — `services/edits.ts`
- **CompletenessRing.tsx** (13 connections) — `components/nmwc/CompletenessRing.tsx`
- **attachPhotoCore()** (13 connections) — `services/photos.ts`
- **detachPhotoCore()** (12 connections) — `services/photos.ts`
- **approveReactivationCore()** (11 connections) — `services/reactivations.ts`
- **lockCustomerRow()** (10 connections) — `lib/locks.ts`
- **rescore-completeness.test.ts** (9 connections) — `tests/integration/rescore-completeness.test.ts`
- **CompletenessRing()** (8 connections) — `components/nmwc/CompletenessRing.tsx`
- **Manager/Steward direct write under the customer row lock** (8 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **completeness.test.ts** (8 connections) — `tests/unit/completeness.test.ts`
- **[13] P2 Branch completeness (0-60) rendered as a 0-100% ring** (6 connections) — `qa/findings/final-golive-hunt.md`
- **[22] P3 EL-04 approve-time photo gate is a TOCTOU** (5 connections) — `qa/findings/final-golive-hunt.md`
- **#5 P2 attachPhoto/detachPhoto race leaves dangling photo-slot pointers** (5 connections) — `qa/findings/pre-launch-deep-review.md`
- **completenessBand()** (5 connections) — `lib/completeness.ts`
- **completenessPct()** (5 connections) — `lib/completeness.ts`
- **CompletenessRing max prop and completenessPct (branches out of 60)** (5 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **[10/20] P2 detachPhoto never recomputes completenessScore** (4 connections) — `qa/findings/final-golive-hunt.md`
- **BranchForScore** (4 connections) — `lib/completeness.ts`
- **scoreCustomerOnly()** (4 connections) — `lib/completeness.ts`
- **Risk: direct writes wait behind a photo attach or import on the same customer** (3 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **wiredTo()** (3 connections) — `services/photos.ts`
- *... and 8 more nodes in this community*

## Relationships

- [[Completeness rescore]] (17 shared connections)
- [[Create finalize and synthetic data]] (14 shared connections)
- [[Edit submit and approval engine]] (12 shared connections)
- [[Audit log writing]] (10 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (9 shared connections)
- [[Duplicates, archive and Temix codes]] (9 shared connections)
- [[reactivations area]] (7 shared connections)
- [[Customer edit pages and badges]] (6 shared connections)
- [[F21: verified-zero equipment plus import area]] (5 shared connections)
- [[Customer import service tests]] (5 shared connections)
- [[errors area]] (5 shared connections)
- [[session area]] (5 shared connections)

## Source Files

- `components/nmwc/CompletenessRing.tsx`
- `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- `docs/design/phase2-edit-semantics/spec-summary.txt`
- `lib/completeness.ts`
- `lib/locks.ts`
- `qa/findings/final-golive-hunt.md`
- `qa/findings/pre-launch-deep-review.md`
- `qa/reports/FINAL-GOLIVE-VERDICT.md`
- `services/edits.ts`
- `services/photos.ts`
- `services/reactivations.ts`
- `tests/integration/rescore-completeness.test.ts`
- `tests/unit/completeness.test.ts`

## Audit Trail

- EXTRACTED: 286 (98%)
- INFERRED: 7 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*