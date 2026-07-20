# NMWC CRM — Master-Plan Execution Record (honest tracker)

**Date:** 2026-07-20 · **Commit at start:** `a94b58a` · **Node** v24.14.1 / **npm** 11.11.0
**Executor:** Fable 5 · **Controlling doc:** `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md` (+ its ERRATA)

This records what was **actually executed** vs what is **blocked**, with no fabricated results. It is deliberately explicit about the boundary between agent-autonomous work (Environment A) and the human-provisioned online UAT (Environment B) / production (Environment C).

## Verdict on THIS execution attempt

**Partial — the automated / isolated-DB slice is complete and green; the online-UAT spine is blocked on human-provisioned infrastructure and owner authorization, and was NOT faked.** The codebase itself is in strong shape (every P1/P2 from two prior adversarial deep scans is fixed and regression-tested; 160 automated tests pass). The full production-readiness *programme* is **not** complete because its core (a live UAT deployment + at-scale/browser/security testing on it) cannot be stood up by an agent unattended (plan ERRATA E5). **No production deployment was performed** (correct per plan §17 + safety).

## Tracker

| Phase | Task | Status | Evidence | Notes |
|---|---|---|---|---|
| 1 | git/versions baseline | ✅ | this file | branch `claude/nmwc-crm-consolidation-e10c1e` @ a94b58a |
| 1 | typecheck | ✅ PASS | `tsc --noEmit` exit 0 | clean |
| 1 | lint | ✅ PASS | `next lint` | No ESLint warnings or errors |
| 1 | unit tests | ✅ PASS | vitest | **140 passed** (15 files) |
| 1 | production build | ✅ compiles | `next build` | ⚠ full `npm run build` couples `migrate deploy` — fails on a `db push`-provisioned branch (needs a `migrate deploy` DB); ran `next build` directly to prove compilation |
| 2 | isolation proof | ✅ PASS | `probe-db.ts` | endpoint `ep-raspy-term-aqwjf17b` (NOT prod `ep-sweet-haze`); Customer/Branch/User = 0; only benign UNASSIGNED Region/Route present; endpoint-guarded |
| 2 | constraint smoke | ✅ PASS | `constraint-smoke.ts` (now asserting) | 2/2 partial-unique, 12/12 CHECK, 2/2 trigger, exit 0 |
| — | migrate to simulated previous schema | ⏸ deferred | — | needs a prod-schema snapshot (Stage 13 / owner) |
| fix | E1 seed-truncate prod guard | ✅ | `prisma/synthetic.ts` | aborts on `ep-sweet-haze` before any DB connect |
| fix | E3 constraint-smoke as a real gate | ✅ | `scripts/qa/constraint-smoke.ts` | exit 3 on missing invariants |
| trace | correct traceability vs existing tests (E4) | ✅ | below | approval + SLA far better covered than the plan's matrix stated |
| all | full automated suite (all gates) | ✅ PASS | vitest | **160 passed / 4 skipped / 0 failed** |
| 3 | synthetic org + workbook at 360+ scale | 🔜 partial-built | `scripts/qa/generate-synthetic-master.ts` (dirty/tiny/medium/prod/stress) | the 10-sheet ground-truth workbook + adversarial variants are scoped but not fully generated this turn |
| 5 | **online UAT deployment** | ⛔ BLOCKED | — | no scriptable Neon-branch/Vercel-project/R2-bucket provisioning (ERRATA E5); requires human infra + secrets |
| 6–10 | browser role UAT / what-if matrix / at-scale perf / live security | ⛔ BLOCKED | — | depend on the online UAT above; cannot be run or faked |
| 17 | production deployment | ⛔ NOT DONE (correct) | — | §17 + safety: owner-gated, never auto |

## E4 traceability correction (verified against the existing test files)

The plan's Deliverable-2 matrix under-credited coverage. Verified in `tests/unit/approval-engine.test.ts` + `tests/unit/working-hours.test.ts`:

| Req | Plan said | Actually | Existing test |
|---|---|---|---|
| R2 CASH chain | ~ | ✅ | resolveChain CASH → SUP→ACC |
| R3 CREDIT chain + GM always | ~ | ✅ | resolveChain CREDIT + "GM always present" |
| R4 UPDATE + Manager fallback | ~ | ✅ | resolveChain UPDATE + canActOnStep region-overlap Manager |
| R9 FM/GM org-wide | ~ | ✅ | canActOnStep GLOBAL |
| R12 submitter can't approve | ~ | ✅ | canActOnStep "blocks the submitter" |
| **R13 one person ≠ two steps** | **✗** | **✅** | canActOnStep "user who already acted on a DIFFERENT step" |
| R15 reject cascade / first→salesman | ~ | ✅ | resolveRejectTarget middle + first-step |
| **R16 loop guard** | **✗** | **✅** | resolveRejectTarget "rejecting twice in one cycle → salesman" |
| **R30 SLA (Fri-skip, overnight, multi-day)** | **✗** | **✅** | working-hours full suite incl "skips Friday", escalationPlan |

**Genuinely thin gaps that remain** (smaller than the plan claimed): R17 (FM/GM cannot amend credit figures at the service layer), R19 (finalize only after final approval — service-level, not just `isFinalStep`), R26 (optimistic `VERSION_CONFLICT`), R14 (frozen-chain vs current-role authz drift — the RK-2 mid-chain-reregion wedge). These are the correct net-new tests to add next; do **not** rebuild R13/R16/R30.

## What remains before this programme could give a real go-live verdict

1. **Human-provisioned Env B** (Neon UAT branch + R2 test bucket + Vercel UAT project + UAT secrets) — the blocking dependency for Stages 5–10.
2. **RK-3 chunked/resumable import** — the ~3,300-customer real master will time out in one promote; top code deliverable, buildable + testable in Env A independently of the deployment.
3. **E2 real-Temix header guard** — obtain the real export's header row; the CREATE import lane defaults absent/renamed payment-terms to CASH (`imports.ts:676`), which no synthetic test catches. Owner input required.
4. The R17/R19/R26/R14 tests above.
5. Owner decisions (workweek confirm, cron infra RK-12, Temix credit-direction, C16/C19) + secret rotation (RK-11).

## Honesty note (kept verbatim from the plan)
The synthetic dataset validates application behavior, data controls, reconciliation logic and error handling. **Final compatibility with the real Temix master cannot be confirmed** until NMWC provides the genuine export and confirms its headers, worksheet structure, field ownership, historic anomalies and deactivation semantics (RK-10). No amount of green synthetic testing removes that ceiling.
