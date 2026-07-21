# NMWC CRM — QA Defect Register

Method: each candidate was investigated by a grounded code-trace, then handed to **two
independent refuter agents** (Opus 4.8) told to break the finding. Only 2/2-confirmed
findings are recorded as defects.

**DB-level execution is now COMPLETE** (isolation proven — `qa/evidence/00-isolation-gate.json`).
The reactivation regression (`tests/integration/reactivation-authz.test.ts`) ran against the
isolated QA branch with a **fail-before / pass-after** proof: with the fix reverted all 5
tests FAIL (each catches its defect); with the fix restored all 5 PASS. See the
**Execution results** section at the bottom for the fail-before/pass-after detail, the C11
accuracy refinement, the import reconciliation, the C1 refutation, and the db-push finding.

---

## F-C11 — Supervisor can approve a Manager-only reactivation via the generic engine

| Field | Value |
|---|---|
| **Severity** | **P1** (authorization bypass of a business rule) |
| **Status** | CONFIRMED (2/2 refuters) → **FIXED** (regression test authored, DB-execution pending) |
| **Component** | Reactivation lane / approval engine |
| **Requirement violated** | Reactivation must be MANAGER-only (region-scoped, photo-evidence gated) |
| **Evidence** | `services/reactivations.ts:103-129` (reactivation edit created with **no** `approvalChain`/`process` → schema defaults process=UPDATE, approvalChain=null, currentStepIndex=0) → `lib/approval-chains.ts:122-127` (`parseChain(null)` = single SUPERVISOR step) → `services/edits.ts` `approveEditCore` had **no** `isReactivation` guard → `lib/permissions.ts:184-193` `canActOnStep` passes for the submitter's Supervisor → `applyEditChanges` flips `branch.status CLOSED→ACTIVE`. `approveEditAction` is a public server action with no role gate. |
| **Reproduction** | Salesman requests reactivation of a CLOSED branch → editId E. As the salesman's **Supervisor** (not a Manager), call `approveEditAction({editId:E})` directly. |
| **Expected** | Refused — reactivations are Manager-only (`approveReactivationAction`). |
| **Actual (pre-fix)** | `approveEditCore` authorizes the Supervisor, flips branch to ACTIVE, writes `APPROVE`/`CustomerEdit` audit (wrong action + wrong entity), skips region scope, EL-15, and the customer roll-up. |
| **Business impact** | A Supervisor (or any region-overlapping Manager, via the wrong path) reactivates a shop that only a Manager may authorize; region scope + photo-evidence governance bypassed; audit trail mislabels the event. |
| **Root cause** | Reactivation edits ride the generic step engine because they carry no frozen chain, and the engine never distinguished `isReactivation`. |
| **Refutation** | 2/2 independent refuters CONFIRMED (P1); every candidate guard (status-bypass check, region scope, approve-time mandatory re-check) verified NOT to block the branch-status flip. |
| **Fix** | `services/edits.ts` approveEditCore + rejectEditCore now throw `ConflictError('WRONG_LANE', …)` when `edit.isReactivation` — reactivations are handled exclusively by the Manager-only reactivation actions. Minimal; does not touch the legitimate close-shop (Supervisor) flow. |
| **Test added** | `tests/integration/reactivation-authz.test.ts` (C11 approve + reject cases). |
| **Residual risk** | Low. Defense-in-depth (a branch-status approve-time guard) was deliberately NOT added — it would over-block the legitimate close-shop approval which flips branch status via the same generic path. |

## F-C12 — `approveReactivationCore` lacks an atomic claim (double-approve)

| Field | Value |
|---|---|
| **Severity** | **P2** (integrity: duplicate audit rows, reviewer misattribution; no master-data loss) |
| **Status** | CONFIRMED (2/2) → **FIXED** |
| **Component** | Reactivation approve |
| **Requirement violated** | One approval decision per request (PROD-001 atomic-claim invariant) |
| **Evidence** | `services/reactivations.ts` pre-tx state check at :255-257 then plain `tx.customerEdit.update({where:{id}})` at :309-312 (no state/count guard), vs `services/edits.ts:1077-1096` guarded `updateMany` + `count===0` conflict. |
| **Reproduction** | Two Managers of the branch's region (or one double-click) call `approveReactivationAction` on the same SUBMITTED reactivation concurrently. |
| **Expected** | One winner; the other gets NOT_PENDING; exactly 1 REACTIVATE audit row. |
| **Actual (pre-fix)** | Both commit → 2 REACTIVATE audit rows; `reviewedById` = last committer; branch double-stamped. |
| **Root cause** | Reactivation lane didn't adopt the engine's atomic-claim pattern. |
| **Refutation** | 2/2 CONFIRMED (P2). |
| **Fix** | Claim moved to the TOP of the tx as a guarded `updateMany({where:{id, state:SUBMITTED, isReactivation:true}})` with `count===0 → ConflictError`; the trailing plain update removed; `pendingRole` nulled. |
| **Test added** | `tests/integration/reactivation-authz.test.ts` (C12 concurrent case). |
| **Residual risk** | Low. |

## F-C13 — `rejectReactivationCore` missing `isReactivation` + state guards

| Field | Value |
|---|---|
| **Severity** | **P1** (state corruption + cross-lane rejection) |
| **Status** | CONFIRMED (2/2) → **FIXED** |
| **Component** | Reactivation reject |
| **Requirement violated** | A Manager may only reject a still-pending reactivation (not decided edits, not other lanes' edits) |
| **Evidence** | `services/reactivations.ts:342-368` — `findUnique` by id only; guards were role/branch/region/self **only**; no `isReactivation`, no state check; plain unguarded update to NEEDS_CORRECTION. |
| **Reproduction** | (a) Approve a reactivation, then `rejectReactivationAction` on the same id. (b) Pass the id of an unrelated SUBMITTED branch edit in the Manager's region. |
| **Expected** | Both refused. |
| **Actual (pre-fix)** | (a) APPROVED→NEEDS_CORRECTION while branch stays ACTIVE (state/branch divergence + contradictory audit); (b) a Supervisor-lane branch edit flipped to NEEDS_CORRECTION mid-chain with stale `pendingRole/currentStepIndex`, stranding it (no reviewer can act, state!==SUBMITTED). |
| **Root cause** | Reject path was not made symmetric with approve. |
| **Refutation** | 2/2 CONFIRMED (P1). |
| **Fix** | Added `if (!edit.isReactivation) throw` + `if (edit.state !== SUBMITTED) throw`, and converted the update to a guarded `updateMany` with `count===0 → ConflictError`. |
| **Test added** | `tests/integration/reactivation-authz.test.ts` (C13 two cases). |
| **Residual risk** | Low. |

---

## Candidate findings — updated after DB execution
- **C1 — REFUTED (no defect).** The premise ("middleware does not block unauthenticated traffic; protection rests on per-page `requireSession()`") is false. Auth is layered: (1) Auth.js v5 middleware `authorized` callback returns `false` for every non-public path (`auth.config.ts:69-70`), matcher `/((?!_next/static|_next/image|favicon.ico).*)` covers all routes; **Next.js 15.5.18 is patched against CVE-2025-29927** (the `x-middleware-subrequest` bypass). (2) `app/(app)/layout.tsx` guards the whole app group (`auth()` + `redirect('/login')`). (3) Individual pages re-check `auth()` and scope data by role/region via `loadScope`. (4) Every server action calls `auth()`/`require*()` independently. (5) The only unguarded API route is `app/api/auth/[...nextauth]` — correctly public. No unauthenticated exposure found. Static audit: 26 pages, all under the guarded group; API routes all carry auth/CRON_SECRET guards.
- **C7/C8** serverless timeout on large promote — still needs a deploy env (Vercel) to confirm; DB present but the `maxDuration` behavior is platform-level. Carried.
- **C2** committed pilot credentials in ≥4 files — owner will rotate before go-live (owner action, not a code defect).
- **C16** NEEDS_CORRECTION notification passes free-text reason (PII) — sanitizer decision (owner).
- **C19** `services/routes.ts` region/route mutations write no audit rows — carried (code-trace only).
- **C20** photo-gc deletes DB row even when R2 tag fails → permanent orphan — carried (R2 write-path deferred; not isolated).

---

## Execution results (DB-proven, isolated QA branch — 2026-07-19)

### Reactivation regression — fail-before / pass-after
`RUN_REACTIVATION_TESTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/reactivation-authz.test.ts`

| Case | Fix reverted (fail-before) | Fix restored (pass-after) |
|---|---|---|
| C11 approve via generic engine | ✗ returns `NEEDS_REUPLOAD` (not `WRONG_LANE`) | ✓ `WRONG_LANE`, branch stays CLOSED |
| C11 reject via generic engine | ✗ **`ok:true` — Supervisor DID reject** | ✓ `WRONG_LANE` |
| C12 two concurrent Manager approvals | ✗ not exactly 1 audit row | ✓ exactly 1 winner, 1 REACTIVATE row |
| C13 reject already-APPROVED | ✗ **`ok:true` — corrupts state** | ✓ refused, branch stays ACTIVE |
| C13 reject non-reactivation edit | ✗ **`ok:true` — cross-lane** | ✓ refused, edit untouched |

**C11 accuracy refinement (execution-driven):** pre-fix, the generic **approve** path returns
`NEEDS_REUPLOAD` — it does NOT cleanly flip the branch to ACTIVE (an unrelated photo-reupload
guard in `approveEditCore` blocks it). So the earlier "Supervisor flips branch to ACTIVE via
approve" impact is **milder than the code-trace claimed**; the cleanly-exploitable bypasses are
the **reject** path (C11b, `ok:true` pre-fix) and **C13** (both, `ok:true` pre-fix). The
`WRONG_LANE` fix is still correct and warranted (reactivations must never ride the generic
engine — audit mislabel + lane confusion). C12 remains a valid concurrency defect. Net: fixes
CONFIRMED and DB-verified; C11 severity nuance recorded for honesty.

### Import reconciliation — customer-master upload vs ground-truth manifest
`RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/import-reconciliation.test.ts` → **19/19 rows reconcile, 0 divergences.** The upload/parse layer correctly quarantines: missing mandatory (cust_code/cust_name), invalid format (payment_terms, phone, credit_limit, payment_term_days), formula payloads (F-05), and in-file CR/phone duplicates (BOTH occurrences). It correctly passes HTML-sanitized and clean rows.
- **Layer-boundary finding (not a defect, but a promote-time obligation):** three checks are silent at UPLOAD and MUST be enforced at PROMOTE — (a) Temix crosswalk conflict (`temix_code` owned by another customer), (b) route/region mismatch resolution, (c) credit_limit >3dp is **rounded, not rejected**. Rows ZZXW-B, ZZDIRTY-0019, ZZDIRTY-0014 pass the upload gate CLEAN by design. **Follow-up: add a promote-layer reconciliation test to prove the crosswalk-conflict + route/region enforcement actually fires.**
- **Fixture bug found & fixed:** the dirty generator hard-coded one phone for all base rows, tripping the (correct) in-file phone-dup check on every row. Fixed to unique-per-row phones; ZZPH-A/ZZPH-B expectation corrected to STEWARD_REVIEW (an in-file dup flags both). Demonstrates the reconciliation catches fixture defects, not just product defects.

### Promote-layer reconciliation (2026-07-19, second pass) — 2 NEW defects, FIXED

`RUN_PROMOTE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/promote-reconciliation.test.ts` — 10 cases; fail-before 4 failed → pass-after **10/10**.

**F-P01 (P1) — silent cross-customer branch steal on promote.**
`promoteCustomerBatchCore` upserted branches by globally-unique `branchCode` with `customerId` in the update payload. Proven: two customers with bare-suffix `branch_code` '01' → the later customer silently STOLE the earlier one's branch (first customer left with zero branches); likewise a row claiming another customer's composed code silently re-parented it. With a real master carrying bare suffixes, the last customer in file order would own every '01'. **Fix:** (a) bare sheet codes are composed under the owning custCode (`custcode-branchcode` identity model; already-composed codes pass through); (b) in-tx ownership guard — a final OR raw sheet code owned by a different customer throws a PII-safe `CROSSWALK:branch_code … already belongs to …` steward-review rejection, never a silent re-parent.

**F-P02 (P1-for-launch) — F-17 UNASSIGNED fallback never worked; unknown region/route poisoned the whole group.**
`services/imports.ts` (old line 854) used the UNASSIGNED **route** id as a **region** id, so every fallback write violated the B-19 region-consistency trigger → the customer group was REJECTED with a cryptic promote-failed error instead of landing in UNASSIGNED with a warning. Proven fail-before: unknown-region and unknown-route groups both rejected (customer never created). **Fix:** trigger-consistent resolution — known route ⇒ route + `route.regionId` (region/route disagreement warned + overridden by the route); unknown route ⇒ the consistent UNASSIGNED region+route pair. Both cases now PROMOTED with the `_resolve` warning as F-17 documented.

Also **proven working** at promote (pass on first run): temix crosswalk conflict rejection (owner named, PII-free), refresh semantics (absent `payment_terms` preserved, credit figures updated, CRM `legalName` untouched, `UPLOADED→SYNCED`), quarantined-row exclusion, atomic double-promote refusal.

**Data-contract note for the real master:** the region resolver matches `Region.code` against the sheet's `sales_region` column — if the real sheet carries region NAMES (e.g. "Muscat") rather than codes ("MCT"), every row will warn + fall back to the route's region. Verify the real sheet's column semantics (or the reference data) before the production import.

### DB constraint smoke — `scripts/qa/constraint-smoke.ts`
40 FK constraints, 43 unique indexes, 12 CHECK constraints, 2 expected partial-unique indexes (`open_per_customer`, `open_per_branch`) verified present. Surfaced the **db-push-drops-invariants** operational finding (see isolation gate) — production is safe (deploys via `migrate deploy`).

### Final exhaustive pass (2026-07-21) — 2 NEW defects, FIXED; R17/R19/R26 covered

**F-UAT-7 (P1-for-launch, importer) — multi-branch customer self-quarantines on in-file phone/CR dup.**
`uploadCustomerMasterCore` built `phonesInFile`/`crsInFile` as `value → row[]` with no `cust_code` grouping, then flagged any value on `>1` row as an in-file duplicate. A legitimate multi-branch customer repeats the SAME phone + CR on each branch row (that is exactly how promote groups branch rows by `cust_code` into one customer), so every branch row was quarantined "duplicate phone/CR in this file." Reproduced: the **medium** synthetic master quarantined **324/499** rows; the real ~3,300 master would quarantine every multi-branch customer. The master cross-check right beside it already excluded the same customer (`code !== custCode`); the in-file check never got that exclusion. **Fix (commit 382e9c5):** track the owning `cust_code` per occurrence; flag an in-file dup only across a DIFFERENT `cust_code`. Regression `tests/integration/import-multibranch.test.ts` — 3-branch customer CLEAN, cross-customer collision QUARANTINED on both rows; fail-before/pass-after; `import-reconciliation` still 19/19.

**F-UAT-8 (P2 robustness, create-flow) — code allocator permanently bricks creation when the counter falls behind.**
`allocateCustomerCode` bumps a `CodeSequence` counter, formats `NMWC-YYYY-NNNNNN`, and retries 5× on collision. If the counter is BEHIND pre-existing `NMWC-YYYY` codes (a DB restore, a migration backfill, a manual insert, or a seed that wrote formatted codes without advancing the counter), five `+1` steps never catch up → `CODE_ALLOCATION_FAILED` on EVERY net-new finalize, forever (each failed tx rolls back the bump, so it never self-corrects). Confirmed on `uat-testing`: `CodeSequence['CUSTOMER-2026']` row absent while 95 customers occupy `NMWC-2026-000001..95`. A clean import-populated **production** start is unaffected (promote assigns custcode-based `nmwcCode`, not `NMWC-YYYY`), but any desync was unrecoverable. This was invisible to the live UAT because the cash chain was only walked to step 1 — finalize was never reached. **Fix (commit ef24144):** on collision, fast-forward the counter past the highest existing code for the year (`GREATEST()` monotonic under concurrent bumps) then retry — self-healing; plus a counter sync at the end of the synthetic seed.

**R17/R19/R26 coverage closed — `tests/integration/credit-chain-e2e.test.ts`.**
Walks a real CREDIT CREATE through SUP→FM→GM→ACC on the isolated branch: **R19** no Customer row exists at submit or after any of the SUP/FM/GM steps — materialization happens ONLY at the final ACC step; **R26** two concurrent final approvals → exactly one succeeds, the other `NOT_PENDING`, one materialization (atomic claim); **R17** the live customer carries the salesman's ORIGINAL `creditLimit`/`paymentTermDays` (the approve action accepts only an `editId` — no amendment path). 5/5 pass.
