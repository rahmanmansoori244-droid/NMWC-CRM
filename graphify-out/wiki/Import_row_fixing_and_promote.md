# Import row fixing and promote

> 47 nodes · cohesion 0.09

## Key Concepts

- **import-row-fix.ts** (43 connections) — `lib/import-row-fix.ts`
- **promoteCustomerBatchCore()** (42 connections) — `services/imports.ts`
- **import-fix-blocks.ts** (18 connections) — `lib/import-fix-blocks.ts`
- **import-row-fix.test.ts** (17 connections) — `tests/unit/import-row-fix.test.ts`
- **import-master-lookup.ts** (12 connections) — `lib/import-master-lookup.ts`
- **newerUploadsCarrying()** (9 connections) — `lib/import-master-lookup.ts`
- **fixBlocks** (8 connections) — `lib/import-fix-blocks.ts`
- **fixWindowClosed()** (8 connections) — `lib/import-row-fix.ts`
- **fixWindowMessage()** (8 connections) — `lib/import-row-fix.ts`
- **refuseIfNewerUpload()** (8 connections) — `services/import-fixes.ts`
- **fixTarget** (7 connections) — `lib/import-master-lookup.ts`
- **composeBranchCode()** (7 connections) — `lib/import-row-fix.ts`
- **newerUploadMessage()** (7 connections) — `lib/import-row-fix.ts`
- **editableColumns()** (5 connections) — `lib/import-row-fix.ts`
- **fixUnitOf()** (5 connections) — `lib/import-row-fix.ts`
- **[P2] In-group branchCode collision silently overwrites a branch on promote** (4 connections) — `qa/findings/deep-scan-round2.md`
- **branchOnlyNote()** (4 connections) — `lib/import-row-fix.ts`
- **siblingSupersededMessage()** (4 connections) — `lib/import-row-fix.ts`
- **supersedingUpload()** (4 connections) — `lib/import-row-fix.ts`
- **[30] P3 In-group branch dedup rejects Temix-refresh groups** (3 connections) — `qa/findings/final-golive-hunt.md`
- **[8] P2 'Address pending' fallback unreachable (?? on empty join)** (3 connections) — `qa/findings/final-golive-hunt.md`
- **P** (3 connections) — `lib/import-fix-blocks.ts`
- **cellValue()** (3 connections) — `lib/import-row-fix.ts`
- **fixExpiredMessage()** (3 connections) — `lib/import-row-fix.ts`
- **issuesOf()** (3 connections) — `lib/import-row-fix.ts`
- *... and 22 more nodes in this community*

## Relationships

- [[import-fixes area]] (25 shared connections)
- [[Account master import]] (20 shared connections)
- [[CR normalisation and row checks]] (9 shared connections)
- [[Import batch review page]] (6 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (4 shared connections)
- [[vercel.json area]] (3 shared connections)
- [[QA defect register]] (2 shared connections)
- [[runAction area]] (2 shared connections)
- [[Duplicates, archive and Temix codes]] (2 shared connections)
- [[alert area]] (2 shared connections)
- [[Audit log writing]] (2 shared connections)
- [[Create finalize and synthetic data]] (2 shared connections)

## Source Files

- `lib/import-fix-blocks.ts`
- `lib/import-master-lookup.ts`
- `lib/import-row-fix.ts`
- `lib/locks.ts`
- `lib/temix.ts`
- `qa/findings/deep-scan-round2.md`
- `qa/findings/final-golive-hunt.md`
- `services/import-fixes.ts`
- `services/imports.ts`
- `tests/unit/import-row-fix.test.ts`

## Audit Trail

- EXTRACTED: 265 (95%)
- INFERRED: 13 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*