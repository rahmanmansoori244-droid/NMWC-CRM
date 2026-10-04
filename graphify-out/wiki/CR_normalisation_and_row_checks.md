# CR normalisation and row checks

> 29 nodes · cohesion 0.14

## Key Concepts

- **import-row-check.ts** (30 connections) — `lib/import-row-check.ts`
- **normalizeCR()** (26 connections) — `lib/cr.ts`
- **checkCustomerRow()** (17 connections) — `lib/import-row-check.ts`
- **cr.ts** (14 connections) — `lib/cr.ts`
- **import-row-check.test.ts** (11 connections) — `tests/unit/import-row-check.test.ts`
- **uploadCustomerMasterCore()** (10 connections) — `services/imports.ts`
- **recheck()** (9 connections) — `services/import-fixes.ts`
- **fileCollisions()** (7 connections) — `lib/import-row-check.ts`
- **rowCustCode()** (7 connections) — `lib/import-row-check.ts`
- **rowCrNorm()** (6 connections) — `lib/import-row-check.ts`
- **rowPhoneNorm()** (6 connections) — `lib/import-row-check.ts`
- **stripHtml()** (6 connections) — `lib/import-row-check.ts`
- **masterCollisionMaps()** (5 connections) — `lib/import-master-lookup.ts`
- **rowBranchCode()** (5 connections) — `lib/import-row-check.ts`
- **SheetRow** (5 connections) — `lib/import-row-check.ts`
- **requireSteward()** (5 connections) — `services/imports.ts`
- **heldBackBy()** (3 connections) — `lib/import-row-check.ts`
- **isFormulaPayload()** (3 connections) — `lib/import-row-check.ts`
- **FileDup** (2 connections) — `lib/import-row-check.ts`
- **RowCheckContext** (2 connections) — `lib/import-row-check.ts`
- **uc()** (2 connections) — `lib/import-row-check.ts`
- **fields()** (2 connections) — `tests/unit/import-row-check.test.ts`
- **DAY_CODES** (1 connections) — `lib/import-row-check.ts`
- **ParsedCustomerRow** (1 connections) — `lib/import-row-check.ts`
- **RowCheckOptions** (1 connections) — `lib/import-row-check.ts`
- *... and 4 more nodes in this community*

## Relationships

- [[New-customer creation and phones]] (14 shared connections)
- [[import-fixes area]] (14 shared connections)
- [[Account master import]] (11 shared connections)
- [[Import row fixing and promote]] (9 shared connections)
- [[recompute-cr-norm area]] (5 shared connections)
- [[End-to-end verification and seeds]] (3 shared connections)
- [[Create finalize and synthetic data]] (3 shared connections)
- [[submit-body-bounds.test area]] (3 shared connections)
- [[Edit submit and approval engine]] (2 shared connections)
- [[duplicate-pairing area]] (2 shared connections)
- [[excel area]] (2 shared connections)
- [[F21: verified-zero equipment plus import area]] (2 shared connections)

## Source Files

- `lib/cr.ts`
- `lib/import-master-lookup.ts`
- `lib/import-row-check.ts`
- `services/import-fixes.ts`
- `services/imports.ts`
- `tests/unit/import-row-check.test.ts`

## Audit Trail

- EXTRACTED: 188 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*