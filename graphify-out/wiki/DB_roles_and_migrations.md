# DB roles and migrations

> 32 nodes · cohesion 0.08

## Key Concepts

- **app-role.ts** (12 connections) — `scripts/ops/app-role.ts`
- **Phase 2 edit semantics spec: summary** (7 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **Phase 2 spec: test plan** (7 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- **Phase 2 spec: migration 20260929120000_edit_submit_gate_equipment_confirmed** (5 connections) — `docs/design/phase2-edit-semantics/spec-migration.txt`
- **Staleness judged by values, not versions** (5 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **ownerUrl()** (4 connections) — `scripts/ops/app-role.ts`
- **prisma migrate deploy runs before next build (deploy hazard)** (4 connections) — `docs/design/phase2-edit-semantics/spec-migration.txt`
- **CI integration env flags RUN_EDIT_PATCH and RUN_RESCORE** (4 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- **Integration suite: edit-patch-concurrency (two connections, barriers)** (4 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- **create()** (3 connections) — `scripts/ops/app-role.ts`
- **Additive migration safe to apply before the build that uses it** (3 connections) — `docs/design/phase2-edit-semantics/spec-migration.txt`
- **PII inventory regeneration (build-pii-inventory, CI --check)** (3 connections) — `docs/design/phase2-edit-semantics/spec-migration.txt`
- **Edit patch v2** (3 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **N01 decision token (unchanged by phase 2)** (3 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **z.coerce null hazards (date becomes 1970, count becomes 0)** (3 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **Integration suite: edit-gate-scope (two-route customer)** (3 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- **grant()** (2 connections) — `scripts/ops/app-role.ts`
- **q()** (2 connections) — `scripts/ops/app-role.ts`
- **status()** (2 connections) — `scripts/ops/app-role.ts`
- **Left out: partial approval of non-conflicting fields (needs a decision token v3)** (2 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **Minimal-design base with grafts from the operator and correctness designs** (2 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **Field errors with no render slot in lib/form-errors.ts** (2 connections) — `docs/design/phase2-edit-semantics/spec-summary.txt`
- **Update AUDITOR-BRIEF rows (F05, F06, F16, F19, F20, F21, N02), test counts and CHANGELOG** (2 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- **Rules for every new test (comment-stripped guards, no clock literals, DB suites refuse production)** (2 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- **Pre-push gates: typecheck, lint and unit suite (not bare tsc), then CI next build and integration** (2 connections) — `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- *... and 7 more nodes in this community*

## Relationships

- [[Access scope and submit gate]] (3 shared connections)
- [[Photos and completeness scoring]] (3 shared connections)
- [[Edit service and channel pairs]] (2 shared connections)
- [[Phase 2 spec contract]] (2 shared connections)
- [[Enrichment form and patch v2]] (2 shared connections)
- [[Enterprise readiness assessment]] (1 shared connections)
- [[F21: verified-zero equipment plus import area]] (1 shared connections)
- [[pii-classification area]] (1 shared connections)
- [[form-errors area]] (1 shared connections)
- [[Account master import]] (1 shared connections)
- [[reactivations area]] (1 shared connections)
- [[Edit value model]] (1 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-migration.txt`
- `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- `docs/design/phase2-edit-semantics/spec-summary.txt`
- `docs/design/phase2-edit-semantics/spec-test_plan.txt`
- `docs/discovery/raw-evidence/new-data.md`
- `scripts/ops/app-role.ts`

## Audit Trail

- EXTRACTED: 93 (94%)
- INFERRED: 6 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*