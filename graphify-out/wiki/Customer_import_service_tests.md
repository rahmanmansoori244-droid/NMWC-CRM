# Customer import service tests

> 35 nodes · cohesion 0.07

## Key Concepts

- **customer-import-service.test.ts** (30 connections) — `tests/unit/customer-import-service.test.ts`
- **customer-master-export.test.ts** (14 connections) — `tests/unit/customer-master-export.test.ts`
- **Completeness critic: Server Action 1 MB body cap defeats the import upload** (6 connections) — `qa/findings/final-golive-hunt.md`
- **promoteCustomerBatchAction()** (6 connections) — `services/imports.ts`
- **matchesWhere()** (6 connections) — `tests/support/where-eval.ts`
- **customer-master-rows.ts** (5 connections) — `lib/customer-master-rows.ts`
- **uploadCustomerMasterAction()** (5 connections) — `services/imports.ts`
- **where-eval.ts** (5 connections) — `tests/support/where-eval.ts`
- **xlsx decompression bomb / unbounded parse memory (C22)** (4 connections) — `qa/findings/pre-launch-deep-review.md`
- **CustomerForScore** (3 connections) — `lib/completeness.ts`
- **CUSTOMER_MASTER_COLUMNS** (3 connections) — `lib/customer-master-rows.ts`
- **[P3] Promote detail page not revalidated (stale READY view)** (2 connections) — `qa/findings/deep-scan-round2.md`
- **promote()** (2 connections) — `tests/unit/customer-import-service.test.ts`
- **setup()** (2 connections) — `tests/unit/customer-import-service.test.ts`
- **servePages()** (2 connections) — `tests/unit/customer-master-export.test.ts`
- **Where** (1 connections) — `tests/support/where-eval.ts`
- **branchUpserts()** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **CHANNELS** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **Fn** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **groupWarnings()** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **h** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **live()** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **notesWritten()** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **Other** (1 connections) — `tests/unit/customer-import-service.test.ts`
- **Parsed** (1 connections) — `tests/unit/customer-import-service.test.ts`
- *... and 10 more nodes in this community*

## Relationships

- [[excel area]] (6 shared connections)
- [[Photos and completeness scoring]] (5 shared connections)
- [[Exports and export scope]] (4 shared connections)
- [[Account master import]] (3 shared connections)
- [[runAction area]] (2 shared connections)
- [[change-report area]] (2 shared connections)
- [[stripComments area]] (2 shared connections)
- [[reactivations area]] (1 shared connections)
- [[Middleware, CSP and maintenance]] (1 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (1 shared connections)
- [[vercel.json area]] (1 shared connections)
- [[Production-readiness verification]] (1 shared connections)

## Source Files

- `lib/completeness.ts`
- `lib/customer-master-rows.ts`
- `qa/findings/deep-scan-round2.md`
- `qa/findings/final-golive-hunt.md`
- `qa/findings/pre-launch-deep-review.md`
- `services/imports.ts`
- `tests/support/where-eval.ts`
- `tests/unit/customer-import-service.test.ts`
- `tests/unit/customer-master-export.test.ts`

## Audit Trail

- EXTRACTED: 112 (97%)
- INFERRED: 3 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*