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

**Post-deploy measurement (deployment `8778811`, Ready in 1m26s):** heavier pages improved (customers 793→741ms median raw-RSC, work 608→551, approvals 598→553); client-cache verified live (a repeat navigation fired ZERO network requests — impossible pre-deploy with staleTime 0); page renders verified intact. **Decisive isolation test:** edge floor 47–55ms, but the BARE login page (no auth, no DB) costs the same ~520–540ms as a fully-loaded authenticated page — i.e. app code is now at the infrastructure floor; the residual latency is Vercel function overhead + the bom1(edge)→iad1(function) hop, not queries. **THE remaining structural lever (owner, at go-live): relocate function + DB near the users** — for Oman, Vercel `fra1` + a Neon eu-central-1 project would cut the per-request floor from ~500ms to ~200ms. iad1/us-east was inherited from the existing DB region; a region move is a data-migration decision for the production cutover, not a code change.

### RK-3 chunked + resumable promote (2026-09-10) — the last blocking code task
The real ~3,300-row master could never have been loaded: promote ran as ONE request against `maxDuration: 60`, while the work is ~1,000 per-customer transactions — minutes, not seconds. Three defects, all fixed together:

1. **No chunking.** `promoteCustomerBatchCore` now promotes only what fits in a **time slice** (`PROMOTE_SLICE_BUDGET_MS`, default 15s, checked *between* customers so a slice always makes progress) and returns `{promoted, failed, remaining, done}`. The Promote button drives the slices and shows live progress; the batch is resumed until no CLEAN rows remain. `remaining` is the live **CLEAN row count**, which is what makes resume idempotent — a replayed slice simply finds nothing to do.
2. **No safe way to resume.** Added a **lease** (`ImportBatch.promoteLeaseBy/promoteLeaseUntil`, migration `20260910120000_promote_chunked_lease`). The claim is a single compare-and-set covering both the first slice (READY→PROMOTING) and every resume (PROMOTING **and** no live lease), so F-07's no-double-promote guarantee survives chunking. The lease **expires** (90s > maxDuration), so a killed worker can never strand a batch. **#23 revised:** an abort now releases the lease and leaves the batch PROMOTING = "interrupted, resumable" — marking it FAILED would discard a half-finished load. The `kind !== CUSTOMER` guard moved *before* the claim so an account batch is never dragged into PROMOTING.
3. **P2028 — the transaction timeout (found by this work, a latent data-loss bug).** The per-customer `$transaction` makes ~9 sequential round trips but had **no options**, so it inherited Prisma's 5s default and customers were being rejected with P2028 purely because the link was slow — on the real master that would have silently dropped good rows. Now `{ timeout: 20_000, maxWait: 10_000 }`, the same fix as final-hunt #32 in `edits.ts`, which had never been applied here. This was reproduced on the UAT branch (ZZPRO-C1/ZZPRO-BA rejected) and three previously-green tests started failing until it was fixed.

Two further defects found by **running** it rather than reasoning about it:

4. **Counters drifted after a crash.** An interrupted UAT load reported `promotedRows = 294` while **299** rows were actually PROMOTED — the killed slice had committed its rows but died before its `increment`. Counters are now **derived** from the real row states via a single `groupBy` (which also supplies `remaining`), so they self-heal on the next slice instead of permanently understating a load the operator has to trust.
5. **An interrupted batch was invisible in the Steward's work queue.** `app/(app)/work/page.tsx` surfaced imports needing attention with `status: 'FAILED'` — which promote no longer writes at all. A half-finished load would have sat unnoticed. It now also matches PROMOTING-with-no-live-lease and labels it **"Import to resume — Promote interrupted, N of M rows loaded"**.

Also: reference data (regions/routes) is now read **once per slice** into maps instead of a `findUnique` for the region *and* the route **on every row** (~6,600 sequential queries on a 3,300-row master); `raw` is no longer selected when promoting; and only the FINAL slice calls `revalidatePath` (an intermediate one would re-render the batch page after every pass). The steward-facing page gained a **"Promote interrupted / Resume promote"** banner, a live **"Left to promote"** stat, and a stall guard that stops if a slice fails to reduce the outstanding count.

**Adversarial review of the change (6 lenses → 3 refuters each → completeness critic, 55 agents).** 20 findings, 16 verified, 1 confirmed by 2-of-3 — and that one ("a healthy load between slices is indistinguishable from an interrupted one") was already fixed by the grace lease before the refuters ran. The review's real value was two things the lenses found and the critic found:

6. **P1 — the lease was released without an ownership check.** A slow worker finishing after its lease had been taken over would clear the NEW owner's lease, breaking mutual exclusion. Every lease write is now guarded by a per-**slice** token (not a user id — one steward in two tabs must not pass for the other), which the client hands back to continue its own run. A run that has lost the batch is told so and stops.
7. **Critic — an infrastructure hiccup was permanently converted into a rejected customer.** The per-group catch treated `P2028`/`P2024`/`P1017` exactly like a `CROSSWALK` conflict or a `P2002` duplicate: mark the rows REJECTED. Since a REJECTED row leaves CLEAN, no later slice retries it and no screen requeues it — so a Neon compute resume mid-load would have silently dropped good customers while the batch still finished PROMOTED. Transient DB errors now leave the group **CLEAN and deferred**, retried by the next slice; if the failure is permanent the caller's stall guard stops the run loudly. Pinned by `promote-transient-defer.test.ts`, which injects a real `P2028` inside a per-customer transaction.
8. **Critic — the losses were invisible anyway.** The batch page had no **Rejected** tile (a load could read "3,300 clean / 3,180 promoted" with the missing 120 nowhere on screen), and the row table showed only the first 200 rows *by row number*, so a rejection at row 1,900 was unreachable in the app. Added the tile plus a warning line, and rows needing a decision (REJECTED/QUARANTINED) are now fetched first and always shown.
9. **Critic — `FAILED` batches had a claim branch but no button.** The claim accepts FAILED so a batch left by the old single-pass promote can be recovered; the page only rendered the button for READY/PROMOTING, so that path was dead from the UI. Now reachable.
10. **Critic — the lease serializes a BATCH, not the master.** Two *different* batches could promote concurrently, which reopens the read-then-upsert window the QA P-01 branch-steal guard explicitly assumes is closed ("serialized by the atomic claim") — and RK-3 stretched that window from one request to minutes while inviting the exact sequence (upload a corrected sheet while the first batch is still resumable). A second concurrent customer promote is now refused with a clear message.

Also: `vitest.config.ts` now disables **file parallelism whenever any `RUN_*` gate is set** — the gated suites share ONE database branch, and running their files concurrently made them race (the new cross-batch guard surfaced this by correctly refusing the concurrent promotes). Unit-only runs stay parallel.

**Measured on the UAT branch:** a 499-row / 300-customer master was promoted across **42 slices**, interrupted mid-load (the engine was disturbed by a concurrent `prisma generate`), left correctly in PROMOTING with an expired lease and 299/499 rows committed, and then **resumed to completion** — the exact operator scenario. Note these wall-clock numbers are **WAN-bound** (Windows → Neon pooler from Oman); production runs the function in `iad1` co-located with Neon `us-east`, where the same ~9 round trips per customer cost milliseconds rather than seconds.

Tests: `promote-chunked-resume.test.ts` (multi-slice completion with nothing lost or repeated; multi-branch customers never split across a slice; accumulated counters; live lease blocks a concurrent promote, expired lease does not) and a rewritten `promote-release-on-abort.test.ts` (abort releases the lease → next call resumes; account batch never claimed). `tests/support/promote.ts` drives slices for every other promote test.

## 6. Open items before UNCONDITIONAL go-live
1. ~~**RK-3 chunked/resumable import**~~ **DONE** (2026-09-10) — see the section above.
2. ~~F-UAT-7~~ **FIXED** (real importer bug, not a fixture artifact) — see §2 final pass.
3. ~~R17/R19/R26 coverage~~ **CLOSED** via `credit-chain-e2e.test.ts`. R14 frozen-chain is exercised by that E2E walk + the `parseChain` unit test; the RK-2 "frozen-chain vs current-role authz drift" edge (route re-regioned mid-chain) remains a documented risk, not a confirmed defect.
4. **Owner:** rotate `neondb_owner` password (shared across all Neon branches incl. production; exposed in UAT screenshots); confirm the D2 Temix credit-refresh direction; Vercel Pro for sub-daily cron; real Temix master + its header row (use the CRM's header contract in OWNER-DECISIONS.md).
5. Findings from the third (final) bug hunt — triage/fix on completion.

**Automated test count (this session):** 140 unit + integration suites (reactivation ×5, merge ×3, import-reconciliation, promote-reconciliation ×11, rate-limit ×4, import-multibranch, credit-chain-e2e ×5, + gated uat-load) — **all green on the isolated uat-testing branch.**

## 7. Go-live gate + final verdict
Gate (from PRODUCTION-READINESS-VERDICT.md §24): no open P0; no open P1 in authz/approval/data-integrity/Temix-loss; migration succeeds from clean AND from a prod-schema snapshot; import+export reconcile; concurrency+code-allocation+dedup+archive+SLA proven; rollback tested; production isolation maintained; owner decisions documented; secrets rotated; **real Temix master obtained**; owner approves.

**Final verdict (2026-07-21, after the round-3 hunt — `qa/reports/FINAL-GOLIVE-VERDICT.md`): NO open P0, NO open P1.** All 7 round-3 P1s fixed with tests, plus F-UAT-7/F-UAT-8, plus 9 P2s and the P3 batch. Full automated suite green on `uat-testing`; production build passes. Remaining items are P2/P3 (edge-case/UX/hardening) with a written remediation plan. **GO for a supervised pilot** once the owner completes: rotate `neondb_owner`, obtain the real Temix master, land RK-3 chunked import before the full 3,300-row load, Vercel Pro for sub-daily cron, confirm the D2 Temix credit direction.
