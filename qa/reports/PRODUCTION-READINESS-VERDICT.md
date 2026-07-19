# NMWC CRM — Production-Readiness Verdict

**Date:** 2026-07-19 · **Environment:** isolated Neon branch `qa-synthetic-testing`
(`ep-raspy-term-aqwjf17b`, schema-only, PII-free, auto-expiring) · **Scope:** the Phase-1
increments (net-new CREATE, Temix batch sync, SLA/notifications) + the reactivation lane +
customer-master import, executed against a real Postgres for the first time.

## Verdict: **CONDITIONALLY READY** for the controlled pilot

The confirmed authorization/concurrency defects in the reactivation lane are **fixed and
DB-verified** (fail-before / pass-after). The customer-master upload layer is **proven against
a ground-truth manifest** (19/19). Auth exposure (C1) is **refuted** — the app has layered,
patched auth. Remaining items before *unconditional* go-live are owner actions and two
deploy-env/promote-layer verifications, none of which block a supervised pilot.

## What was proven this session

| Area | Result | Evidence |
|---|---|---|
| DB isolation | **PASS** — isolated, empty, endpoint-guarded, auto-expiring | `qa/evidence/00-isolation-gate.json` |
| Reactivation C11/C12/C13 fixes | **PASS** — 5/5 fail-before → 5/5 pass-after | `tests/integration/reactivation-authz.test.ts`, register Execution results |
| Customer-master upload | **PASS** — 19/19 rows reconcile vs manifest, 0 divergences | `tests/integration/import-reconciliation.test.ts` |
| DB invariants (FK/unique/CHECK/partial-unique/trigger) | **PASS** — enumerated & present | `scripts/qa/constraint-smoke.ts` |
| C1 unauthenticated access | **REFUTED** — layered auth, Next 15.5.18 patched (CVE-2025-29927) | register C1 |
| Full test suite | **PASS** — 128 passed, 4 skipped, 0 failed | full `vitest run` |

## Confirmed defects — all FIXED + regression-guarded

- **C11 (P1→ nuanced)** Supervisor could act on a Manager-only reactivation via the generic
  engine. The clean bypass is the **reject** path and **C13**; the approve path is milder
  (blocked pre-fix by a photo-reupload guard, so no clean branch-flip). Fixed with a
  `WRONG_LANE` guard in `approveEditCore`/`rejectEditCore`.
- **C12 (P2)** `approveReactivationCore` lacked an atomic claim → double-approve. Fixed with a
  top-of-transaction guarded `updateMany` (PROD-001 pattern).
- **C13 (P1)** `rejectReactivationCore` lacked `isReactivation` + state guards → cross-lane
  rejection / state corruption. Fixed with both guards + a guarded `updateMany`.

## Must-do before UNCONDITIONAL go-live (not pilot blockers)

1. **Owner — rotate & set production secrets** (DB password, `AUTH_SECRET`, `CRON_SECRET`,
   Sentry DSN, R2 creds). Committed pilot creds (C2) must be dead in prod.
2. **Deploy provisioning rule — use `prisma migrate deploy`, NEVER `prisma db push`.** db push
   silently drops migration-only partial-unique indexes + CHECK constraints (proven this
   session). The repo's `db:deploy` script is correct; ensure CI/Vercel uses it.
3. **Promote-layer reconciliation test (follow-up).** The upload layer is silent by design on
   (a) Temix crosswalk conflict, (b) route/region mismatch, (c) >3dp credit rounding. Add a
   test that drives `promoteCustomerBatchAction` and proves the crosswalk-conflict + route/region
   enforcement actually fire at promote. **Recommended before importing the real master.**
4. **C7/C8 large-promote timeout** — verify on Vercel that promoting ~3,300 customers does not
   exceed `maxDuration`; if it can, batch/stream the promote. Deploy-env verification.
5. **R2 write-path tests** — deferred (R2_BUCKET is the prod bucket). Run against a test bucket
   or mock before trusting photo/attachment GC (C20).

## Owner decisions still open (design, not defects)
C16 (PII in NEEDS_CORRECTION notification text — sanitize?), C19 (audit rows for region/route
mutations — add?). These are policy calls for the owner, listed for traceability.

## How to re-run the DB-gated QA
```
# .env already points at the isolated branch (endpoint-guarded).
npx tsx scripts/qa/probe-db.ts                 # prove isolation (aggregate counts only)
npx tsx scripts/qa/constraint-smoke.ts         # enumerate DB invariants
RUN_REACTIVATION_TESTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/reactivation-authz.test.ts
RUN_IMPORT_TESTS=1       node scripts/qa/run-with-env.mjs vitest run tests/integration/import-reconciliation.test.ts
```
Note: the QA branch auto-deletes after 1 day; recreate a schema-only branch and re-provision
(`prisma db push` + `scripts/qa` invariant patch, or `migrate deploy` on a fresh empty DB) to
re-run later.
