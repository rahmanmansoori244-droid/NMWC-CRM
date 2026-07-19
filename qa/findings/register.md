# NMWC CRM — QA Defect Register

Method: each candidate was investigated by a grounded code-trace, then handed to **two
independent refuter agents** (Opus 4.8) told to break the finding. Only 2/2-confirmed
findings are recorded as defects. DB-level fail/pass execution is **pending the DB
credential** (isolation blocker, `qa/evidence/00-isolation-gate.json`); the regression
tests (`tests/integration/reactivation-authz.test.ts`) are authored + gated to run then.

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

## Candidate findings carried forward (NOT yet confirmed — need DB or deploy env)
- **C1** middleware does not block unauthenticated traffic (next-auth beta wrapped-middleware) — needs the per-route unauthenticated probe (server + any DB). Protection currently rests on per-page `requireSession()`; a single unguarded page = exposure. **High priority when DB returns.**
- **C7/C8** serverless timeout: `maxDuration:30` misses server actions; promote of ~3,300 = 20-35k sequential round trips → stuck `PROMOTING`. Needs DB + deploy env.
- **C2** committed pilot credentials in ≥4 files — verify rejected in prod (rotation).
- **C16** NEEDS_CORRECTION notification passes free-text reason (PII) — sanitizer decision.
- **C19** `services/routes.ts` region/route mutations write no audit rows.
- **C20** photo-gc deletes DB row even when R2 tag fails → permanent orphan.
