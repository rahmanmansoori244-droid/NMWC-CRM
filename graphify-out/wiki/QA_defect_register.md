# QA defect register

> 38 nodes · cohesion 0.08

## Key Concepts

- **QA Defect Register** (27 connections) — `qa/findings/register.md`
- **Production-Readiness Verdict (2026-07-19)** (9 connections) — `qa/reports/PRODUCTION-READINESS-VERDICT.md`
- **F-P02 F-17 UNASSIGNED fallback broken (route id used as region id)** (8 connections) — `qa/findings/register.md`
- **QA Execution Tracker** (7 connections) — `qa/reports/execution-tracker.md`
- **F-C12 approveReactivationCore lacks an atomic claim (double-approve, P2)** (6 connections) — `qa/findings/register.md`
- **F-C13 rejectReactivationCore missing isReactivation and state guards (P1)** (6 connections) — `qa/findings/register.md`
- **F-P01 silent cross-customer branch steal on promote (P1)** (6 connections) — `qa/findings/register.md`
- **import-reconciliation.test.ts** (6 connections) — `tests/integration/import-reconciliation.test.ts`
- **QA phases A-J (baseline, isolation, synthetic master, constraint smoke, reactivation, import, promote, R2)** (6 connections) — `qa/reports/execution-tracker.md`
- **Re-running DB-gated QA (probe-db, constraint-smoke, run-with-env gates)** (6 connections) — `qa/reports/PRODUCTION-READINESS-VERDICT.md`
- **probe-db.ts** (5 connections) — `scripts/qa/probe-db.ts`
- **[P2] Branch-code composition collides with positional branch codes** (4 connections) — `qa/findings/deep-scan-round2.md`
- **Verdict-accuracy audit (CONDITIONALLY READY scope caveat)** (4 connections) — `qa/findings/pre-launch-deep-review.md`
- **Customer-master upload reconciliation vs ground-truth manifest (19/19)** (4 connections) — `qa/findings/register.md`
- **Isolated schema-only QA Neon branch (isolation gate)** (4 connections) — `qa/findings/register.md`
- **Promote-time obligations: crosswalk conflict, route/region resolution, credit_limit rounding** (4 connections) — `qa/findings/register.md`
- **run-with-env.mjs** (4 connections) — `scripts/qa/run-with-env.mjs`
- **CONDITIONALLY READY for the controlled pilot (later NO-GO until owner items)** (4 connections) — `qa/reports/PRODUCTION-READINESS-VERDICT.md`
- **PROD-001 atomic-claim invariant (guarded updateMany, count 0 means conflict)** (3 connections) — `qa/findings/register.md`
- **C20 photo-gc deletes DB row when R2 tagging fails (carried)** (3 connections) — `qa/findings/register.md`
- **Real-master data contract: sales_region codes vs names, bare vs composed branch_code** (3 connections) — `qa/findings/register.md`
- **Use region/route CODES, not names, in sales_region and route** (3 connections) — `docs/import-templates/README.md`
- **Baseline unit-test evidence (13 files, 122 tests passed)** (2 connections) — `qa/evidence/baseline-unit-tests.txt`
- **[P3] F-P02 fallback silently discards a valid region when route is blank** (2 connections) — `qa/findings/deep-scan-round2.md`
- **C16 NEEDS_CORRECTION notification free-text PII (owner decision)** (2 connections) — `qa/findings/register.md`
- *... and 13 more nodes in this community*

## Relationships

- [[Pre-launch review (July)]] (8 shared connections)
- [[Master-Plan Execution Record (2026-07-20 area]] (5 shared connections)
- [[Audit immutability tests]] (4 shared connections)
- [[Approval chains and detail page]] (3 shared connections)
- [[generate-synthetic-master area]] (3 shared connections)
- [[Create finalize and synthetic data]] (2 shared connections)
- [[reactivations area]] (2 shared connections)
- [[Import row fixing and promote]] (2 shared connections)
- [[Middleware, CSP and maintenance]] (2 shared connections)
- [[NMWC go-live import templates README area]] (2 shared connections)
- [[Audit log writing]] (2 shared connections)
- [[promote-reconciliation.test area]] (2 shared connections)

## Source Files

- `docs/import-templates/README.md`
- `qa/evidence/baseline-lint.txt`
- `qa/evidence/baseline-typecheck.txt`
- `qa/evidence/baseline-unit-tests.txt`
- `qa/findings/deep-scan-round2.md`
- `qa/findings/pre-launch-deep-review.md`
- `qa/findings/register.md`
- `qa/reports/PRODUCTION-READINESS-VERDICT.md`
- `qa/reports/execution-tracker.md`
- `scripts/qa/probe-db.ts`
- `scripts/qa/run-with-env.mjs`
- `tests/integration/import-reconciliation.test.ts`

## Audit Trail

- EXTRACTED: 137 (89%)
- INFERRED: 17 (11%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*