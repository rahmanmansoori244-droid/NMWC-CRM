# NMWC CRM — QA Execution Tracker

Baseline commit: `06867e4` (Phase 1e). **DB blocker RESOLVED 2026-07-19** — isolated
schema-only Neon branch provisioned; DB-gated QA executed. Final verdict:
`qa/reports/PRODUCTION-READINESS-VERDICT.md`.

| Phase | Task | Status | Evidence | Notes |
|---|---|---|---|---|
| A | Baseline: typecheck / lint / unit tests | ✅ DONE | `qa/evidence/baseline-*.txt` | typecheck clean · lint clean |
| A | Baseline: production build | ⏸ deferred | — | DB-independent; green at commit |
| B | Email isolation | ✅ PASS | `00-isolation-gate.json` | no mailer wired |
| B | Sentry isolation | ✅ PASS | `00-isolation-gate.json` | server DSN disabled |
| B | R2 isolation | ⏸ DEFERRED | `00-isolation-gate.json` | prod bucket; import path is R2-free & isolated, photo write-path deferred |
| B | **DB isolation proof** | ✅ **PASS** | `00-isolation-gate.json`, `scripts/qa/probe-db.ts` | isolated empty branch `ep-raspy-term-aqwjf17b`, endpoint-guarded |
| C | Synthetic master generator | ✅ DONE | `scripts/qa/generate-synthetic-master.ts`, `qa/fixtures/*` | deterministic; fixture phone-uniqueness bug fixed |
| C | Provision QA schema | ✅ DONE | `00-isolation-gate.json` | db push + idempotent invariant patch (`scripts/qa/restore` DDL) |
| D | DB constraint smoke | ✅ DONE | `scripts/qa/constraint-smoke.ts` | 40 FK · 43 unique · 12 CHECK · 2 partial-unique |
| E | Reactivation regression (C11/C12/C13) | ✅ DONE | `tests/integration/reactivation-authz.test.ts` | fail-before 5/5 → pass-after 5/5 |
| F | Customer-master import reconciliation | ✅ DONE | `tests/integration/import-reconciliation.test.ts` | 19/19 dirty rows reconcile, 0 divergences |
| G | C1 unauthenticated-route audit | ✅ REFUTED | register C1 | layered auth; Next 15.5.18 patched |
| — | Full test suite | ✅ PASS | — | 128 passed / 4 skipped / 0 failed |
| H | Promote-layer reconciliation | 🔜 FOLLOW-UP | — | prove crosswalk-conflict + route/region fire at promote |
| I | Large-promote timeout (C7/C8) | 🔜 FOLLOW-UP | — | deploy-env (Vercel) verification |
| J | R2 photo write-path / GC (C20) | ⏸ DEFERRED | — | needs test bucket or mock |

## Blocker history
DB isolation was BLOCKED (rotated/stale credentials). Resolved by creating a fresh
**schema-only** Neon branch (no PII), placing its credential in `.env` without exposing the
password, and proving isolation (distinct endpoint + zero data rows + endpoint guard).

## Defects: CONFIRMED + FIXED + DB-verified
- C11 (P1, nuance-refined) · C12 (P2) · C13 (P1) — reactivation lane. See `qa/findings/register.md`.

## Refuted / owner / carried
- C1 REFUTED (no unauth exposure). C2/C16/C19 owner decisions. C7/C8/C20 carried (deploy-env / R2).
