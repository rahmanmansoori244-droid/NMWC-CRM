# NMWC CRM — QA Execution Tracker (interim)

Baseline commit: `06867e4` (Phase 1e). Working tree: clean except QA docs/scripts/fixtures.

| Phase | Task | Status | Evidence | Notes |
|---|---|---|---|---|
| A | Baseline: typecheck / lint / unit tests | ✅ DONE | `qa/evidence/baseline-*.txt` | typecheck clean · 122 unit tests pass · lint clean |
| A | Baseline: production build | ⏸ deferred | — | build is DB-independent; not re-run this session (was green at commit) |
| B | Email isolation | ✅ PASS | `00-isolation-gate.json` | no mailer wired — cannot send |
| B | Sentry isolation | ✅ PASS | `00-isolation-gate.json` | server DSN disabled |
| B | R2 isolation | ❌ FAIL | `00-isolation-gate.json` | R2_BUCKET is the PROD bucket — attachment tests deferred/mock-required |
| B | **DB isolation proof** | 🔴 **BLOCKED** | `00-isolation-gate.json` | **auth failure — credentials in .env no longer valid (likely rotated)** |
| C | Synthetic master generator | ✅ DONE | `scripts/qa/generate-synthetic-master.ts`, `qa/fixtures/*`, `qa/evidence/fixtures-checksums.txt` | deterministic (dataSha256/manifestSha256 stable); tiny/medium/prod/dirty + parameterized stress |
| C | Load fixtures into DB | 🔴 BLOCKED | — | requires DB |
| D–Q | All DB/service/API/concurrency/perf/e2e/reconciliation | 🔴 BLOCKED | — | require a reachable isolated DB |

## STOP condition active
Isolation cannot be proven (cannot connect to the QA DB). Per the mandatory safety
rule, all DB-dependent execution is halted pending a valid isolated-DB credential.
No workaround, alternate credential, or production access was attempted.

## Candidate defects carried forward (from Fable 5 plan §2 — awaiting DB repro before confirm/fix)
- C11 (P1?) reactivation approvable by Supervisor (Manager-only bypass) — `services/reactivations.ts:103-129` + `services/edits.ts:705-766`
- C12 (P1?) reactivation approve lacks atomic claim — double-approve → 2 audit rows
- C13 (P1?) `rejectReactivationAction` lacks isReactivation + state guards
- C1 middleware does not block unauth traffic — needs per-route probe (server up + DB)
- C8/C7 promote + serverless timeout at scale — needs DB + deploy env
These require deterministic DB reproduction (plan §8) before any fix; not confirmed yet.
