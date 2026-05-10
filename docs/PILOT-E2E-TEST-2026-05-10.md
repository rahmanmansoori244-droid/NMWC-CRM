# Pilot E2E test — 2026-05-10

Live test campaign run against https://nmwc-cm.vercel.app, exercising the
end-to-end workflows that earlier sessions had only code-verified. Two real
bugs surfaced and were fixed live + retested. All Tier 1 scenarios pass.

---

## Result summary

| Tier | Scenario | Result |
|---|---|---|
| **1** | salesman `c1-12345-nmwc` login + scoped `/customers` (360 of 3,334 — Route C1 only) | ✅ |
| **1** | cross-route IDOR — c1 deep-links MH01 customer | ✅ 404 |
| **1** | salesman opens edit form on incomplete customer | ✅ Mandatory banner with exact missing list |
| **1** | salesman submits via DB-injected SUBMITTED edit (mandatory-fields pre-populated) | ✅ |
| **1** | ahmed.alndabi `/approvals` — sees only own team's submissions | ✅ |
| **1** | ahmed approves edit → master.notes updated + completeness 90% + audit log diff | ✅ |
| **1** | ahmed rejects edit with reason+category → state NEEDS_CORRECTION + master untouched | ✅ |
| **1** | pilot.manager (Abdullah) login → dashboard scoped to Muscat (3,259 customers, 3,328 branches) | ✅ |
| **1** | manager.b deep-links a Muscat edit → 404 (RBAC-05-003) | ✅ |
| **1** | pilot.steward (Abdulrahman) login → /import + /duplicates accessible | ✅ |
| **1** | pilot.manager creates new VIEWER user via /users → mustChangePassword=true in DB | ✅ |
| **1** | new user logs in, navigates to /dashboard / /customers / /profile → all redirect to /profile/change-password | ✅ (after Bug #1 fix) |
| **1** | new user submits change-password form → mustChangePassword=false, old pw rejected, new pw works, sessionsRevokedAt bumped, redirected to /login | ✅ |
| **1** | EL-01 form-side: salesman edit form has NO customer-Status select | ✅ |
| **1** | EL-01 approve-side: DB-injected `customer.status: ACTIVE→CLOSED` edit gets approved by ahmed | ✅ blocked (after Bug #2 fix) — state stays SUBMITTED, master stays ACTIVE |
| **2** | viewer role: login → /dashboard, /approvals → /dashboard, /import → /dashboard, /customers → 3,334 read | ✅ |

---

## Bugs found + fixed during the campaign

### 🔴 Bug #1 — AUTH-09 forced password change was silently dead

**Discovered:** test.mustchange (newly-created user with `mustChangePassword=true` in DB) logged in successfully and navigated to `/dashboard`, `/customers` freely, with NO redirect to `/profile/change-password`.

**Root cause:** The middleware `authorized()` callback (in `auth.config.ts`, Edge runtime) reads `auth.user.mustChangePassword`. The session callback that bubbles `token.mustChangePassword → session.user.mustChangePassword` lived only in `lib/auth.ts` (Node runtime). The Edge middleware uses `authConfig` directly which had no session callback, so `auth.user.mustChangePassword` was always `undefined` in middleware.

**Fix:** added an Edge-safe session callback to `auth.config.ts` that bubbles the simple JWT fields (id, role, username, mustChangePassword) into `session.user`. The Node-side `lib/auth.ts` session callback spreads + overrides this so it keeps its heavier role-refresh logic.

**Commit:** `90ae392` — "Fix AUTH-09: middleware-side mustChangePassword redirect was silently dead"

**Verified live:** test.mustchange now redirects to `/profile/change-password` from any path, completes the change form, and is then forced back to `/login`. Old password rejected, new password works, `mustChangePassword` cleared, `sessionsRevokedAt` bumped. ✅

### 🟡 Bug #2 — EL-01 approve-time defense-in-depth gap

**Discovered:** Injected a SUBMITTED `CustomerEdit` row directly into the DB with `fieldChanges: [{field: "customer.status", before: "ACTIVE", after: "CLOSED"}]`. Logged in as ahmed, clicked Approve. **The customer's `status` flipped to CLOSED in the master, completely bypassing the close-and-reactivate workflow with photo evidence.**

**Risk profile:** The submit-time block in `submitEditAction` is the primary defense — it correctly rejects salesman/supervisor/steward/manager attempts to flip status via the form (the form-side Status select is also hidden for SALESMAN). So a normal user attack vector is closed. **But** any future bug, internal tampering, or DB injection that puts `customer.status` into `fieldChanges` would silently flip the customer at approve time with no photo evidence. Defense in depth was missing.

**Fix:** added a mirror EL-01 guard in `approveEditAction` that throws `ConflictError('STATUS_BYPASS', ...)` whenever `customerProposed.status` would change to/from CLOSED or SUSPENDED. Forces the close/reactivation actions to be the only path, regardless of how the edit was created.

**Commit:** `1432981` — "EL-01 (defense-in-depth): also reject status flips at approve time"

**Verified live:** injected the same bad edit again, approve click was blocked, edit state stayed SUBMITTED, customer status stayed ACTIVE. ✅

---

## Tier 2 follow-up (not blocking)

### ⚠️ ConflictError messages are lost across the server-action boundary

When `approveEditAction` throws `ConflictError('STATUS_BYPASS', friendlyMessage)`, the user sees the generic Next.js `"An error occurred in the Server Components render. The specific message is omitted in production builds..."` instead of the helpful message. Production-mode Next.js Server Action serialization strips custom error subclass info.

**Impact:** UX only — the protection works, the user just doesn't get a useful error. Same problem affects every action that throws ConflictError / ValidationError / ForbiddenError on a business-rule violation.

**Spawned task chip** to track this: switch the action contract from "throw on user-facing failures" to "return `{ ok: false, code, message }`" and update the forms to surface the message. ~2 hours of work.

---

## What's still untested live

- **Photo capture / GPS capture** — Chrome MCP can't trigger device camera or geolocation API. The full upload→presign→finalize→attach pipeline was code-verified only.
- **Branch close + reactivation flow** — needs photo evidence; same camera limitation.
- **Account-master import happy path** — the F-02 malicious test was tried yesterday and the action errored (separate UX bug spawned). A clean Steward upload with valid users+routes wasn't run today.
- **Customer-master import happy path** — bypassed today via direct DB seed scripts because the F-02 bug was unresolved.
- **Concurrent approval race** — code has the atomic claim (PROD-001 fix); not exercised live.
- **Phone-collision UX (cross-region scrubbed)** — code-verified only.
- **Rate-limit exhaustion + recovery** — code-verified only.

---

## Production state at end of session

- **Live build:** commit `1432981` deployed to https://nmwc-cm.vercel.app
- **Pilot accounts:** all 13 (1 manager + 1 steward + 1 supervisor + 10 salesmen) live and password-verified
- **Customer master:** 3,334 customers / 3,423 branches loaded, paymentTerms set from xlsx, channels left blank for salesmen to fill during enrichment
- **Demo accounts:** still active (`DEMO_ACCOUNTS_DISABLED=false`). Flip on go-live.
- **`admin` password:** still `ChangeMeNow!2026`. Rotate on go-live.

## Test artifacts left in DB (intentional, useful audit trail)

| editId | state | customer | what |
|---|---|---|---|
| `cmozhi31o0007tvjkn7nlrgce` | APPROVED | AQA0549-C1 | notes change approved by ahmed |
| `cmozhi5e4000ftvjkxfw5n5mk` | NEEDS_CORRECTION | CAA0367 | rejected by ahmed with reason "wrong info" |
| `cmozid8r30001tv70gabpelpo` | SUBMITTED | AQA0549-C1 | malicious status flip — currently still SUBMITTED, will be blocked at any future approve attempt |
| `test.mustchange` user | active | — | password successfully changed live; can be deleted any time |

The `cmozid8r30001tv70gabpelpo` edit can be deleted from `/work` or `/approvals` UI by ahmed. Or run `DELETE FROM "CustomerEdit" WHERE id = '...'` manually.
