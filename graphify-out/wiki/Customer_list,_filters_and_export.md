# Customer list, filters and export

> 52 nodes · cohesion 0.09

## Key Concepts

- **db.ts** (64 connections) — `lib/db.ts`
- **page.tsx** (33 connections) — `app/(app)/customers/page.tsx`
- **customer-export.ts** (32 connections) — `services/customer-export.ts`
- **route.ts** (18 connections) — `app/api/cron/keep-warm/route.ts`
- **customer-filters.ts** (18 connections) — `lib/customer-filters.ts`
- **reference-data.ts** (16 connections) — `lib/reference-data.ts`
- **CustomersPage()** (13 connections) — `app/(app)/customers/page.tsx`
- **route.ts** (13 connections) — `app/api/perf-probe/route.ts`
- **applyCustomerFilters()** (9 connections) — `lib/customer-filters.ts`
- **parseCustomerFilters()** (9 connections) — `lib/customer-filters.ts`
- **exportFilteredCustomersCore()** (9 connections) — `services/customer-export.ts`
- **customerBranchPredicate()** (8 connections) — `lib/customer-filters.ts`
- **#2 P1 Empty-region Manager reads the whole master on /customers (SR-M2 sibling)** (7 connections) — `qa/findings/pre-launch-deep-review.md`
- **handle()** (7 connections) — `app/api/cron/keep-warm/route.ts`
- **customerListBranchScope()** (7 connections) — `lib/customer-filters.ts`
- **customer-list-scope.test.ts** (7 connections) — `tests/unit/customer-list-scope.test.ts`
- **customer-count.ts** (6 connections) — `lib/customer-count.ts`
- **getAllActiveChannels** (6 connections) — `lib/reference-data.ts`
- **getAllActiveRegions** (6 connections) — `lib/reference-data.ts`
- **getAllActiveRoutes** (6 connections) — `lib/reference-data.ts`
- **getAllActiveSubChannels** (6 connections) — `lib/reference-data.ts`
- **getAllHierarchyUsers** (6 connections) — `lib/reference-data.ts`
- **[P1] Empty-scope Supervisor filtered export leaks other teams' customer PII** (5 connections) — `qa/findings/deep-scan-round2.md`
- **customerCountFast()** (5 connections) — `lib/customer-count.ts`
- **listSavedViewsForCurrentUser()** (4 connections) — `services/saved-views.ts`
- *... and 27 more nodes in this community*

## Relationships

- [[Auth and page scope loading]] (13 shared connections)
- [[session area]] (10 shared connections)
- [[Audit log writing]] (8 shared connections)
- [[page area]] (7 shared connections)
- [[route area]] (7 shared connections)
- [[logger area]] (7 shared connections)
- [[PageHeader area]] (4 shared connections)
- [[Pre-launch review (July)]] (4 shared connections)
- [[New-customer creation and phones]] (4 shared connections)
- [[Customer filter bar]] (3 shared connections)
- [[Cron heartbeats]] (3 shared connections)
- [[Photo attach routes]] (3 shared connections)

## Source Files

- `app/(app)/customers/page.tsx`
- `app/api/cron/keep-warm/route.ts`
- `app/api/perf-probe/route.ts`
- `lib/customer-count.ts`
- `lib/customer-filters.ts`
- `lib/db.ts`
- `lib/reference-data.ts`
- `qa/evidence/uat-live-run.md`
- `qa/findings/deep-scan-round2.md`
- `qa/findings/pre-launch-deep-review.md`
- `services/customer-export.ts`
- `services/saved-views.ts`
- `tests/unit/customer-list-scope.test.ts`

## Audit Trail

- EXTRACTED: 360 (99%)
- INFERRED: 4 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*