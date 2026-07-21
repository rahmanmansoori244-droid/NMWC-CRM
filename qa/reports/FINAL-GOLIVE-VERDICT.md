# NMWC Unified CRM — FINAL go-live verdict (post exhaustive hunt)

**Date:** 2026-07-21 · **Branch:** `claude/nmwc-crm-consolidation-e10c1e`
**Scope:** the definitive pre-go-live pass the owner asked for — "make sure for sure there are no bugs before going live."

---

## 1. What this pass did
1. Ran a **third, definitive adversarial bug hunt** — 137 agents, 2 rounds × 9 lenses × 3-lens independent verification + a completeness critic + a regression critic (0 agent errors). **37 confirmed** (7 P1, 14 P2, 16 P3). Full record: [`qa/findings/final-golive-hunt.md`](../findings/final-golive-hunt.md).
2. Independently found + fixed **F-UAT-7** and **F-UAT-8** while building the credit-chain test.
3. Closed the **R17/R19/R26** automated-coverage gaps end-to-end.
4. Ran the **full regression suite** green on the isolated `uat-testing` branch (no P1 regression from any fix), a **production build**, and a **scaled** re-import proof.

## 2. Fixed this pass (all with fail-before/pass-after tests where DB-gated)

### P1 — go-live blockers (7/7 fixed)
| # | Finding | Fix (commit) | Test |
|---|---------|-------------|------|
| 0 | SR-USR-01 removed the ONLY in-app path to create ACCOUNTANT/FM/GM → every net-new CREATE stalls forever at the Accountant step | `requireUserAdmin` (Manager **or** Steward); allowlist applies only to Manager; approver tier added to account-import + pilot seed (`97efb00`) | `steward-provisioning.test.ts` |
| 1 | EL-04 approve-time mandatory re-check blocked **all** branch-CLOSE approvals for imported customers (NEEDS_REUPLOAD) | skip EL-04 for status-only edits (`6cc166e`) | `close-shop-imported.test.ts` |
| 2 | In-file phone/CR dup not scoped by cust_code (= **F-UAT-7**) | already fixed before the hunt returned (`382e9c5`) | `import-multibranch.test.ts` (+ scaled 499-row) |
| 3 | paymentTerms CASH↔CREDIT flip via ordinary UPDATE bypasses the SUP→FM→GM→ACC credit chain | reject any paymentTerms change in the edit flow (`e118623`) | `edit-paymentterms-guard.test.ts` |
| 4/5/6 | Non-refresh customer-master re-import force-overwrites CRM-owned fields (CREDIT→CASH, nulls phone/CR/contact) | presence-aware non-refresh update, mirroring the refresh lane (`b0f70b2`) | `promote-reconciliation.test.ts` (+1 case) |

### P2 (9 fixed)
- **#8** branch address fallback used `??` on a `''` join → empty address → whole group REJECTED at promote → switched to `||` (`85f5a0b`, covered by promote-reconciliation).
- **#9 / #19** CREDIT→CASH on absent payment_terms in the non-refresh lane — fixed with #4 cluster (`b0f70b2`).
- **#10 / #20** detachPhoto never recomputed completenessScore (stale-high) → now recomputes branch + customer (`85f5a0b`).
- **#11** photo-gc hard-deleted the DB row on a transient R2-tag failure → orphan; now deletes only when tagged-for-expiry or confirmed gone (`85f5a0b`).
- **#12** reactivation review showed stale on-file photos, not the fresh evidence → renders `attachmentChanges` evidence (`3eb001c`). *UI — spot-check in pilot UAT.*
- **#14** re-import upsert bypassed the B-05 optimistic lock → added `version:{increment:1}` (`b0f70b2`).
- **#16 / #24** reactivation/close-shop raw P2002 when a pending edit exists → friendly `OPEN_EDIT_EXISTS` (`fabccc6`).
- **#18** GUARANTEE credit docs were browser-cacheable (60s) → no-store extended to all confidential kinds (`85f5a0b`).

### P3 (fixed)
- **#32** UPDATE approve + step-advance transactions had no explicit timeout (default 5s tripped over the remote DB) → 30s, matching CREATE finalize (`6cc166e`).
- **#21/#26/#28/#33/#35** stale Sat-working/Fri-off workweek docstrings → corrected to Sun–Thu (`85f5a0b`).

### Also fixed (found independently)
- **F-UAT-8** (`ef24144`): the create-flow code allocator gave up after 5 tries when the `CodeSequence` counter fell behind pre-existing `NMWC-YYYY` codes (restore/migration/seed) → **permanently bricked** net-new customer creation. Now self-heals (fast-forwards past the highest code) + the synthetic seed syncs the counter. A clean import-populated production start was unaffected (promote uses custcode-based codes), but any counter desync was unrecoverable.

## 3. Remaining — documented follow-ups (NOT go-live blockers)
None are P0/P1. Each is triaged with a recommendation.

| # | Sev | Finding | Recommendation |
|---|-----|---------|----------------|
| 7/15 | P2 | RK-2: CREATE approval **visibility** scopes on the frozen `EditBranchDraft.regionId` while the approve gate/escalation/finalize scope on the route's **current** region — a route re-regioned mid-chain can wedge a request or show it to the wrong region's queue | Owner decision: make one region authoritative for the whole chain (recommend: re-derive visibility from the current route region, matching the gate). Edge case; low frequency in a stable route table. |
| 17 | P2 | Manager direct-write edit authorizes branch writes at customer level, not per-branch region — on a multi-region customer a Manager could edit a branch in a region they don't manage | Add a per-branch `managedRegionIds` check in the direct-write path (mirror `filterBranchesByScope`). |
| 13 | P2 | Branch completeness (0–60 scale) rendered as a 0–100% ring — branches/regions can't reach "green" | Normalize the ring to the branch's own max, or relabel. UI only. |
| 22 | P3 | EL-04 photo gate is read outside the approve tx (TOCTOU) | Re-assert inside the tx; small window. |
| 23 | P3 | Import promote can strand a batch in PROMOTING on early failure (no compensating release) | Folds into the **RK-3 chunked/resumable import** work (below). |
| 25 | P3 | routes.ts region/route mutations don't revalidate ref-data cache tags | Add `revalidateTag`. |
| 27/36 | P3 | NMWC code year from `getFullYear()` (UTC) not Oman wall-clock → prior-year prefix in the 00:00–03:59 Oman window on Dec 31/Jan 1 | Derive the year from the Oman-shifted clock. Once-a-year, 4-hour window. |
| 29 | P3 | CreateUserForm offers roles a Manager can't create (server now rejects clearly) | Filter the dropdown by the viewer's role. Cosmetic. |
| 30/34 | P3 | Dead completeness dimensions (`notes`, paymentTerms-always-true guard) | Tidy the scorer. |
| 31 | P3 | merge moves all loser edits to the winner → can violate open_per_customer | Dedupe/close loser edits during merge. |

## 4. Owner actions before go-live (unchanged from the master record)
1. **Rotate `neondb_owner`** — the Neon role password is shared across ALL branches incl. production and was exposed in UAT screenshots.
2. **RK-3 chunked/resumable import** — the real ~3,300 master times out in a single promote (175 rows = 11 min over the remote DB). Top remaining code task; subsumes #23.
3. Confirm the **D2 Temix credit-refresh direction** (does Temix ever author credit?).
4. **Vercel Pro** for sub-daily cron (Hobby = daily only).
5. Provide the **real Temix master + its header row**; remap the importer's header contract if it differs from the CRM proxy.
6. Rotate the seed/pilot passwords documented in `seed-muscat-pilot.ts`.

## 5. Verdict
- **No open P0. No open P1.** All 7 P1s from the definitive hunt are fixed with tests, plus F-UAT-7 and F-UAT-8.
- Automated coverage: **140 unit + the integration suites** (reactivation ×5, merge ×3, import-reconciliation, promote-reconciliation ×12, rate-limit ×4, import-multibranch ×2, credit-chain-e2e ×5, steward-provisioning ×3, edit-paymentterms-guard ×3, close-shop-imported ×1) — **all green on the isolated uat-testing branch**; production build passes.
- Remaining items are P2/P3 (edge-case, UX, hardening) with a written remediation plan, plus the owner actions above.

**Recommendation: GO for a supervised pilot** once the owner completes the §4 actions (secret rotation + real Temix master are the hard gates) — the RK-3 chunked import must land before the full 3,300-row load, but a smaller supervised pilot cohort can onboard on the current importer. No known correctness or security defect blocks the pilot.
