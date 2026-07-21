# NMWC Unified CRM — Master Session Record (production-readiness programme)

**Purpose:** durable, self-contained record of everything done to take the NMWC CRM from "Phase-1 code" to "verified, online-UAT-tested, near-go-live." Written so any future session (or another engineer/AI) can pick up with full context.

**Branch:** `claude/nmwc-crm-consolidation-e10c1e` · **worktree:** same · **remote:** `github.com/rahmanmansoori244-droid/NMWC-CRM`
**Latest commit at writing:** `30447bb`.

---

## 1. What this system is
Enterprise customer-master CRM for National Mineral Water Company (NMWC SAOG, Oman) that **AIDS** the Temix ERP (does not replace it). Next.js 15.5.18 (App Router, RSC + Server Actions), React 19, TypeScript, Prisma 6.19 on Postgres/Neon, Auth.js v5 beta, Cloudflare R2, exceljs, Vitest, Playwright, Sentry. 8 roles: SALESMAN, SUPERVISOR, ACCOUNTANT, FINANCE_MANAGER, GM, MANAGER, STEWARD, VIEWER. Approval chains: **CASH create** SUP→ACC; **CREDIT create** SUP→FM→GM→ACC (GM always); **UPDATE** SUP (Manager fallback). Identity: customer=`custcode`→`nmwcCode`; branch=`custcode-branchcode`→globally-unique `branchCode`. SLA: Asia/Muscat UTC+4, **Sun–Thu workweek** (owner-confirmed), 08–17, working-minutes only.

## 2. Confirmed + FIXED defects (all have regression tests, fail-before/pass-after where DB-gated)

### Reactivation lane (commit d87cffb)
- **C11 (P1):** Supervisor could act on a Manager-only reactivation via the generic engine → `WRONG_LANE` guards in `services/edits.ts` approve/reject.
- **C12 (P2):** reactivation approve lacked atomic claim (double-approve) → top-of-tx guarded `updateMany`.
- **C13 (P1):** reject lacked `isReactivation`+state guards (cross-lane/corruption) → both guards + guarded update.

### Pre-launch deep review round 1 (3 P1s, commit a18ddf7)
- **SR-USR-01 (P1):** a Manager could create/reset/disable the credit approvers (FM/GM/Accountant) → **allowlist** `MANAGER_ADMINISTRABLE_ROLES=[SALESMAN,SUPERVISOR,VIEWER]` in `lib/permissions.ts` + `services/users.ts` (create/updateRole).
- **SR-M2 (P1):** region-less Manager read the whole master on `/customers` → shared fail-closed `customerListBranchScope` helper in `lib/customer-filters.ts`.
- **PROD-DUP-01 (P1):** concurrent reversed-pair merge archived BOTH customers → sorted `FOR UPDATE` lock + in-tx liveness recheck + 20s tx timeout in `services/duplicates.ts`.

### Promote-layer reconciliation (commit dbc7ea8)
- **F-P01 (P1):** silent cross-customer branch steal → bare-code composition to `custcode-branchcode` + in-tx owner guard.
- **F-P02 (P1):** F-17 UNASSIGNED fallback used route-id as region-id (poisoned groups via B-19 trigger) → trigger-consistent resolution.

### Deep review round 2 (commits 08230d2, fa81618, 0794995)
- **SR-EXP-01 (P1):** empty-team Supervisor filtered-export leaked another team's PII → `mergeStringIn` empty-set stays empty + export uses the shared helper.
- **QA P-03 (P2, regression of F-P01):** in-group branchCode collision dropped a branch → per-group dedup rejects to steward review.
- **SR-UI-01 (P2):** cross-region merge was impossible in the UI → `MergeForm` confirm+reason flow.
- Account-import (P2/P3): password reset now revokes sessions; blank supervisor column = keep; correct spreadsheet row numbers.
- Promote computes `completenessScore`; F-17 region-drop now warns; batch detail revalidated; phone format check reads all header variants.

### Ops hardening (commit 605d161) + plan errata + safety (commit 46e0aca)
- Build runs `prisma migrate deploy`; Vercel region `iad1` (co-located with us-east DB); `maxDuration` covers `.tsx`; `.env.example` documents all secrets; `lib/excel.ts` `MAX_TOTAL_ROWS=50k`.
- **E1:** `prisma/synthetic.ts` refuses a production endpoint before its unguarded TRUNCATE (was mislabeled "scoped").
- **E3:** `scripts/qa/constraint-smoke.ts` now asserts required invariants + exits non-zero (was warn-only).

### Final exhaustive pass (this session — commits 382e9c5, ef24144)
- **F-UAT-7 (P1-for-launch, importer):** the upload parser's in-file duplicate-phone/CR check keyed only on the value, ignoring `cust_code`. A legitimate multi-branch customer repeats the same phone+CR on each branch row (exactly how promote groups by `cust_code`), so every such row was quarantined "duplicate phone/CR in file" — the medium master lost **324/499 rows**; the real ~3,300 master would quarantine every multi-branch customer. Fix: flag an in-file dup only across a **different** `cust_code`, mirroring the master cross-check. Regression test `tests/integration/import-multibranch.test.ts` (fail-before/pass-after); reconciliation still 19/19.
- **F-UAT-8 (P2 robustness, create-flow):** `allocateCustomerCode` gave up after 5 `+1` steps, so whenever the `CodeSequence` counter fell **behind** pre-existing `NMWC-YYYY` codes (a restore, a migration backfill, or a seed writing formatted codes without advancing the counter) it threw `CODE_ALLOCATION_FAILED` **forever** — permanently bricking net-new customer creation. A clean import-populated production start is unaffected (promote uses custcode-based `nmwcCode`), but any desync was unrecoverable. Fix: on collision, **fast-forward** the counter past the highest existing code for the year (self-healing) + sync the counter in the synthetic seed. Uncovered while adding the credit-chain test (the live UAT missed it — the cash chain was only walked to step 1, never reaching finalize).
- **R17/R19/R26 coverage closed:** `tests/integration/credit-chain-e2e.test.ts` walks a real CREDIT CREATE SUP→FM→GM→ACC and proves: **R19** the customer materializes ONLY after the final (ACC) step (no Customer row at submit or after SUP/FM/GM); **R26** two concurrent final approvals → exactly one wins, the other `NOT_PENDING`, one materialization; **R17** the live customer carries the salesman's ORIGINAL creditLimit/termDays — the approve action takes only an `editId`, so FM/GM/ACC cannot amend the figures.

### Owner decisions applied (commit 4044182, e60545c)
- **Workweek = Sun–Thu (5-day):** `WORK_DAYS` default `0,1,2,3,4`; SLA fixtures recomputed.
- **Temix credit = OUTBOUND (CRM→Temix):** confirms current behavior; refutes the "stale outbound push" finding. **Open D2-note:** the inbound refresh still treats credit as Temix-authoritative — confirm with ERP team whether Temix ever modifies credit.
- Cron off GitHub Actions needs **Vercel Pro** (Hobby = daily only).

## 3. Three adversarial deep reviews (78 confirmed findings total)
Multi-agent Workflow pattern: N finder lenses → 3 independent refuters per finding (2/3 to confirm) → completeness critic. Records: `qa/findings/pre-launch-deep-review.md` (round 1, 25 confirmed), `qa/findings/deep-scan-round2.md` (round 2, 16 confirmed), **`qa/findings/final-golive-hunt.md` (round 3, definitive — 137 agents, 37 confirmed: 7 P1, 14 P2, 16 P3).**

### Round 3 (final, definitive) — 2026-07-21
The exhaustive pre-go-live hunt found **7 P1s** including one caused by this session's own SR-USR-01 fix. **All 7 P1s fixed with fail-before/pass-after tests**, plus 9 P2s and the P3 batch. See `qa/reports/FINAL-GOLIVE-VERDICT.md` for the full table. Highlights:
- **#0 (P1, self-inflicted):** the SR-USR-01 allowlist removed the ONLY in-app path to provision ACCOUNTANT/FM/GM, so every net-new CREATE stalled forever → restored the Steward provisioning path (`requireUserAdmin`) + pilot-seed approvers.
- **#1 (P1):** EL-04 blocked ALL branch-close approvals for imported customers → status-only edits skip the mandatory re-check.
- **#3 (P1):** paymentTerms CASH↔CREDIT flip via ordinary UPDATE bypassed the credit chain → blocked.
- **#4/5/6 (P1):** non-refresh re-import force-overwrote CRM data (CREDIT→CASH, nulled phone/CR/contact) → made presence-aware.
- **F-UAT-8 (found independently):** the create-flow code allocator permanently bricked when the `CodeSequence` counter fell behind → self-healing.

## 4. Online UAT — ACHIEVED
- **Isolated Neon branch `uat-testing`** (endpoint `ep-lucky-bar-aqbfutvr`, schema-only, **auto-delete Never**). NOTE **F-UAT-6:** the first UAT branch (`ep-raspy-term`) auto-deleted after 1 day mid-UAT — always set auto-delete Never for a multi-day UAT.
- **Vercel Preview-DB isolated:** `DATABASE_URL`+`DIRECT_URL` scoped Preview→uat-testing, Production+Development→production; `DATABASE_URL1` removed; migration history baselined so the Preview build's `migrate deploy` is a no-op.
- **Live Preview URL** (production build, isolated DB, `iad1`): `nmwc-cm-git-claude-nmwc-7e903d-…vercel.app`.
- **Verified live online:** login+auth; region scope (scoped manager 100 customers, unscoped 0, disabled-user rejected); the **CREATE flow** (4 real cash+credit requests via `submitCreateAction`); the **approval queue** (correct scope + 8h SLA); a **real approval** — Manager-fallback of the Supervisor step (R4) advanced a cash CREATE SUP→ACC.
- Org seeded: 59 users (all 8 roles + edge accounts: unscoped manager/accountant, disabled user), 7 regions, 38 routes, ~270 customers (95 seeded + 175 imported), 115 branches, 18 pending edits. Demo password `Demo!2026Demo`; steward/manager.a/manager.b/supervisor.1-7/salesman.<route>/accountant.a-b/fm.a-b/gm.a-b.

## 5. Evidence + reports (in `qa/`)
- `qa/reports/`: PRODUCTION-READINESS-VERDICT.md, LAUNCH-CHECKLIST.md, OWNER-DECISIONS.md, EXEC-RECORD.md, execution-tracker.md.
- `qa/findings/`: register.md, pre-launch-deep-review.md, deep-scan-round2.md.
- `qa/evidence/`: 00-isolation-gate.json, uat-live-run.md, baseline-*.
- `qa/scripts` / `scripts/qa/`: probe-db.ts, constraint-smoke.ts (asserting gate), generate-synthetic-master.ts, run-with-env.mjs.
- Plans: `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md` (+ ERRATA), `docs/OPUS-QA-EXECUTION-PLAN.md`, `docs/PROJECT-DESCRIPTION.md`.
- Tests (all gated integration via `RUN_*=1 node scripts/qa/run-with-env.mjs vitest run <path>`): reactivation-authz, promote-reconciliation, import-reconciliation, merge-concurrency, uat-load, build-chain-data; unit: user-admin-authz, customer-list-scope, working-hours, approval-engine, +others. **160 automated tests pass.**

### Performance pass (2026-07-21, commit 8778811) — "very responsive" mandate
Owner reported >1s per interaction on the online Preview. Measured baseline: **550–800ms per warm authenticated navigation** (149ms bom1→iad1 network floor + ~400–600ms server) + cold starts + first-visit CDN misses. An 8-lens perf audit (43 findings) drove the fixes: the **broken JWT freshness throttle** (the 5-min window never persisted on the RSC path → a User query on EVERY `auth()` call after minute 5, 2–3× per navigation) now backed by a per-lambda 30s cache + `auth()` memoized per request; every hot page's query waterfall parallelized (dashboard 4 waves→1 + SQL aggregates; customers/work/today); approvals queue + customers list select-narrowed; **approve/reject = ONE round trip** (redirect inside the action); `staleTimes` client router cache; **12 loading.tsx skeletons** (instant click feedback); customers pagination `<a>`→`<Link>` (was a full document reload); photos immutable-cached 1h + ETag/304 + in-memory rate limit; Prisma cold-start warmup; exceljs lazy-loaded; keep-warm can ping the Preview (`KEEP_WARM_PREVIEW_URL` repo var); `trustHost:true` fixes the preview login redirect bouncing to the production domain (F-UAT-3).
**NEW OWNER ACTIONS:** (1) scope the `AUTH_URL`/`NEXTAUTH_URL` Vercel env var to Production ONLY (it overrides trustHost on previews); (2) optionally set the `KEEP_WARM_PREVIEW_URL` GitHub repo variable to the preview URL so UAT stays warm.

## 6. Open items before UNCONDITIONAL go-live
1. **RK-3 chunked/resumable import** — the real ~3,300 master times out in one promote (175 customers = 11 min over remote DB). TOP remaining code task.
2. ~~F-UAT-7~~ **FIXED** (real importer bug, not a fixture artifact) — see §2 final pass.
3. ~~R17/R19/R26 coverage~~ **CLOSED** via `credit-chain-e2e.test.ts`. R14 frozen-chain is exercised by that E2E walk + the `parseChain` unit test; the RK-2 "frozen-chain vs current-role authz drift" edge (route re-regioned mid-chain) remains a documented risk, not a confirmed defect.
4. **Owner:** rotate `neondb_owner` password (shared across all Neon branches incl. production; exposed in UAT screenshots); confirm the D2 Temix credit-refresh direction; Vercel Pro for sub-daily cron; real Temix master + its header row (use the CRM's header contract in OWNER-DECISIONS.md).
5. Findings from the third (final) bug hunt — triage/fix on completion.

**Automated test count (this session):** 140 unit + integration suites (reactivation ×5, merge ×3, import-reconciliation, promote-reconciliation ×11, rate-limit ×4, import-multibranch, credit-chain-e2e ×5, + gated uat-load) — **all green on the isolated uat-testing branch.**

## 7. Go-live gate + final verdict
Gate (from PRODUCTION-READINESS-VERDICT.md §24): no open P0; no open P1 in authz/approval/data-integrity/Temix-loss; migration succeeds from clean AND from a prod-schema snapshot; import+export reconcile; concurrency+code-allocation+dedup+archive+SLA proven; rollback tested; production isolation maintained; owner decisions documented; secrets rotated; **real Temix master obtained**; owner approves.

**Final verdict (2026-07-21, after the round-3 hunt — `qa/reports/FINAL-GOLIVE-VERDICT.md`): NO open P0, NO open P1.** All 7 round-3 P1s fixed with tests, plus F-UAT-7/F-UAT-8, plus 9 P2s and the P3 batch. Full automated suite green on `uat-testing`; production build passes. Remaining items are P2/P3 (edge-case/UX/hardening) with a written remediation plan. **GO for a supervised pilot** once the owner completes: rotate `neondb_owner`, obtain the real Temix master, land RK-3 chunked import before the full 3,300-row load, Vercel Pro for sub-daily cron, confirm the D2 Temix credit direction.
