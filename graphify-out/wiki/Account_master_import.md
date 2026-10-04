# Account master import

> 43 nodes · cohesion 0.11

## Key Concepts

- **imports.ts** (106 connections) — `services/imports.ts`
- **account-import.ts** (27 connections) — `lib/account-import.ts`
- **uploadAccountMasterCore()** (24 connections) — `services/imports.ts`
- **account-import-rules.test.ts** (14 connections) — `tests/unit/account-import-rules.test.ts`
- **isTransientDbError()** (10 connections) — `lib/db-errors.ts`
- **db-errors.ts** (8 connections) — `lib/db-errors.ts`
- **accountRowFailure()** (7 connections) — `lib/account-import.ts`
- **errorLogFields()** (6 connections) — `lib/account-import.ts`
- **unwrittenCustomerCells()** (6 connections) — `lib/import-row-fix.ts`
- **db-errors.test.ts** (6 connections) — `tests/unit/db-errors.test.ts`
- **accountUpdateAudit()** (5 connections) — `lib/account-import.ts`
- **reportableError()** (5 connections) — `lib/account-import.ts`
- **isDbConflict()** (5 connections) — `lib/db-errors.ts`
- **mayHaveCommitted()** (5 connections) — `lib/db-errors.ts`
- **accountCreateAudit()** (4 connections) — `lib/account-import.ts`
- **accountImportInterruptedMessage()** (4 connections) — `lib/account-import.ts`
- **inactiveRouteIssue()** (4 connections) — `lib/account-import.ts`
- **passwordReusedIssue()** (4 connections) — `lib/account-import.ts`
- **roleMismatchIssue()** (4 connections) — `lib/account-import.ts`
- **supervisorIssue()** (4 connections) — `lib/account-import.ts`
- **supervisorReportsIssue()** (4 connections) — `lib/account-import.ts`
- **AccountState** (3 connections) — `lib/account-import.ts`
- **same()** (3 connections) — `lib/account-import.ts`
- **refreshLaneBranches()** (3 connections) — `services/imports.ts`
- **reportAccountImportFault()** (3 connections) — `services/imports.ts`
- *... and 18 more nodes in this community*

## Relationships

- [[Import row fixing and promote]] (20 shared connections)
- [[CR normalisation and row checks]] (11 shared connections)
- [[errors area]] (10 shared connections)
- [[alert area]] (6 shared connections)
- [[runAction area]] (5 shared connections)
- [[Audit log writing]] (5 shared connections)
- [[excel area]] (5 shared connections)
- [[Edit service and channel pairs]] (3 shared connections)
- [[Create finalize and synthetic data]] (3 shared connections)
- [[session area]] (3 shared connections)
- [[rate-limit area]] (3 shared connections)
- [[Customer import service tests]] (3 shared connections)

## Source Files

- `lib/account-import.ts`
- `lib/db-errors.ts`
- `lib/import-row-fix.ts`
- `scripts/ops/apply-quarantined-visit-days.ts`
- `services/imports.ts`
- `tests/unit/account-import-rules.test.ts`
- `tests/unit/db-errors.test.ts`

## Audit Trail

- EXTRACTED: 289 (97%)
- INFERRED: 8 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*