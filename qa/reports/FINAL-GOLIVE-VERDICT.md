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

## 3. Remaining P2/P3 follow-ups — NOW ALL FIXED (2026-07-21, second pass)
Every P2 and P3 from the round-3 hunt has since been fixed and (where DB-gated) tested. A parallel verification workflow re-confirmed each against current code + produced a precise fix spec before implementation.

| # | Sev | Fix (commit) | Test |
|---|-----|-------------|------|
| 7/15 | P2 | RK-2 scope drift: all 5 CREATE-visibility surfaces (approvals queue + detail, both work queues, attachment access) now resolve region through the draft's CURRENT `route.regionId`, so visibility == the approve gate (`3e78fcc`) | `create-region-wedge.test.ts` |
| 17 | P2 | Manager direct-write now has a per-branch `managedRegionIds` guard — can't edit a branch in an unmanaged region of a multi-region customer (`3e78fcc`) | `manager-branch-region-authz.test.ts` |
| 13 | P2 | CompletenessRing takes a `max` prop + `completenessPct()`; branch ring uses `/60` so branches can reach green (`b98a6ff`) | in `completeness.test.ts` |
| 22 | P3 | EL-04 mandatory re-check moved INSIDE the apply tx (`tx.customer`) — closes the detach TOCTOU (`3e78fcc`) | — (relocation of an existing, tested check) |
| 23 | P3 | promote wraps the post-claim body — an abort releases the batch to FAILED, never stranded in PROMOTING (`3e78fcc`) | `promote-release-on-abort.test.ts` |
| 25 | P3 | routes.ts mutations now `revalidateTag('ref:regions'/'ref:routes')` (`b98a6ff`) | — |
| 27/36 | P3 | customer-code year from the Oman wall-clock (`omanYear`), not raw UTC (`b98a6ff`) | — |
| 29 | P3 | role dropdown filtered by `administrableRolesFor(viewerRole)` + `/users` now admits STEWARD (also completes #0's reachability) (`b98a6ff`) | `steward-provisioning.test.ts` covers the server rule |
| 30/34 | P3 | dead `notes` completeness dimension corrected (`b98a6ff`) | `completeness.test.ts` (+1 case) |
| 31 | P3 | merge auto-rejects the loser's SUBMITTED edit before reparenting — no more `open_per_customer` P2002 (`3e78fcc`) | `merge-open-edit-collision.test.ts` |
| 21/26/28/33/35 | P3 | stale Sun–Thu workweek docstrings corrected (`85f5a0b`) | — |

**Net: 0 open findings from any of the three reviews.** The only remaining pre-go-live items are the OWNER actions in §4 (not code defects).

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
