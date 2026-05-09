# Audit 05 — RBAC + Scope Enforcement

**Auditor:** Adversarial QA, pre-launch (day before pilot)
**Date:** 2026-05-09
**Scope:** Every page under `app/(app)/`, every server action under `services/*`, `lib/access.ts`, `lib/permissions.ts`, `middleware.ts`, `auth.config.ts`, photo HTTP routes.
**Stance:** I am here to find what slipped past the previous audit + remediation. I trust nothing.

---

## 0) Executive verdict

The remediation report says all Critical+High findings were closed. From a code-reading perspective, the previously-named exploits (QA-001, QA-002, QA-003, QA-004, QA-005, QA-007, QA-009) are indeed closed. **However, the remediation introduced and/or left behind a fresh crop of RBAC and scope-leak bugs that the previous audit's threat-model did not cover.** Most of these are about *cross-Manager* and *cross-region* leakage — i.e., the scope rules apply correctly to Salesman/Supervisor but Manager B can still see and act on Manager A's region in many places. There is also a clear PRD-violation cluster where the implementation gives Manager powers the PRD reserved for Steward (imports, duplicate merge), and gives Manager peer-Manager mutation powers the PRD does not mention (peer demote, peer password reset, last-Manager lockout).

A SALESMAN can no longer dump every customer in the system — but they CAN still see neighbouring branches of a multi-branch customer that has at least one branch on their route, including those branches' GPS / address / contact / photos. This is the "we patched the IDOR but the hot path still leaks" class of bug.

Counts: **3 Critical · 7 High · 9 Medium · 6 Low**.

The system is closer to ready than the original audit but **not** ready as the remediation report claims. RBAC-05-001 / RBAC-05-002 / RBAC-05-003 are stop-ship.

---

## 1) Role × Route matrix (what each role sees vs. what the PRD says)

Legend: ✅ = allowed (PRD-correct) · ❌ = denied (PRD-correct) · ⚠ = mismatch (page allows but PRD denies, or vice versa) · 🟡 = allowed but no scope filter applied · — = role redirects away.

| Route | SALESMAN | SUPERVISOR | MANAGER | STEWARD | VIEWER | Notes |
|---|---|---|---|---|---|---|
| `/today` | ✅ scoped to own route | — `/home` | — `/home` | — `/home` | — `/home` | day-of-week query is TZ-correct |
| `/customers` (list) | ✅ scoped (route) | ✅ scoped (team) | ✅ scoped (region) | ✅ all | ✅ all | List query is correct; **but card subtitle leaks neighbouring branch — see RBAC-05-002** |
| `/customers/:id` (profile) | scope-checked, but **shows all branches** of a multi-branch customer | scope-checked, same leak | scope-checked, same leak | ✅ all | ✅ all | RBAC-05-002 |
| `/customers/:id/edit` | route-scoped on Salesman only | 🟡 page lets Supervisor open the form (no role-block); server action then refuses on submit. UX bug + footgun | 🟡 Manager can open + submit edit on ANY customer globally; no region check; no override flag/reason required | 🟡 same | redirects to profile | RBAC-05-004, RBAC-05-005 |
| `/approvals` (list) | — `/home` | ✅ team-scoped | 🟡 sees ALL pending approvals globally — Manager A sees Manager B's region's queue | — `/home` | — `/home` | RBAC-05-003 |
| `/approvals/:id` (detail) | — `/home` | ✅ ownership check | 🟡 Manager has zero scope check; can approve any submitted edit anywhere | — `/home` | — `/home` | RBAC-05-003 |
| `/dashboard` | — `/home` | — `/home` | ✅ region-scoped (QA-007 fix verified) | — `/home` (note: STEWARD redirected away from dashboard) | ✅ global | OK; PRD says Steward gets "global" dashboard — code routes Steward to /import — minor PRD drift |
| `/team` | — `/home` | ✅ own team | — `/home` | — `/home` | — `/home` | OK |
| `/users` | — `/home` | — `/home` | ✅ Manager-only — but **no privilege guard between Managers** | — `/home` | — `/home` | RBAC-05-006 |
| `/routes` | — `/home` | — `/home` | ✅ Manager-only | 🟡 PRD says Steward also manages routes — implementation excludes Steward | — `/home` | RBAC-05-013 |
| `/audit` | — `/home` | — `/home` | ✅ Manager-only — but shows **global audit, no region scope** + Manager A reads Dhofar's actions | 🟡 PRD says Steward has global audit — implementation redirects Steward away | — `/home` | RBAC-05-007 |
| `/reactivations` | — `/home` | — `/home` | 🟡 Manager-only — but no region scope; Manager A approves Manager B's regions | — `/home` | — `/home` | RBAC-05-008 |
| `/duplicates` | — `/home` | — `/home` | 🟡 Manager allowed; PRD says STEWARD-only | ✅ allowed | — `/home` | RBAC-05-009 |
| `/import` | — `/home` | — `/home` | 🟡 Manager allowed; PRD says STEWARD-only | ✅ allowed | — `/home` | RBAC-05-009 |
| `/export` | — `/home` | ✅ team-scoped | ✅ region-scoped | ✅ all | ✅ all (read-only PRD-allowed) | OK |
| `/work` | ✅ own | ✅ team | 🟡 Manager sees ALL stale approvals globally; not region-scoped | ✅ own imports | empty list (no role branch) | RBAC-05-010 |
| `/rejected` | ✅ own | redirects to `/work` | redirects to `/work` | redirects to `/work` | redirects to `/work` | OK |

The cells marked 🟡 are the substantive findings. Cells marked ⚠ in the original PRD comparison reduce to two themes:

1. **Manager has no inter-region scope check anywhere except dashboard and export.** (Approvals, audit, reactivations, work, peer-Manager mutation, customer profile / edit when crossing regions.)
2. **PRD reserves several actions to Steward that the code grants to Manager too** (imports, duplicate merge, route management for Steward).

---

## 2) Findings — numbered

### RBAC-05-001 — Salesman sees full neighbour-branch data on multi-branch customers

**Severity:** Critical · **Confidence:** Confirmed (code review)

**File:** `app/(app)/customers/[id]/page.tsx:25-50` (the `findFirst` query) and `:120-167` (the rendering loop).

**What the user sees:**
A SALESMAN on Route MCT-01 visits a customer like "Lulu Hypermarket" that has a branch on MCT-01 *and* a branch in Dhofar. `canSeeCustomer` correctly returns `true` (one branch is on their route — that's the rule). The profile page then renders **every non-deleted branch on the customer**, including the Dhofar branch's address, GPS coordinates, opening hours, contact role, equipment counts, shop photo, signboard photo. The salesman never set foot in Dhofar but now has its address and pictures.

**Why it matters:**
Same blast-radius as the original QA-001 IDOR for any customer that happens to be multi-branch. NMWC's master is full of Lulu / Carrefour / Al Fair / Sultan Center / fuel-station chains that span multiple regions. The "salesman → only own route" PRD invariant is broken for those records. A disgruntled or curious salesman can harvest competitor branch GPS, hours, signboard — exactly the kind of competitive intelligence the controls were supposed to prevent. A privacy/regulator complaint would land in the legal team's lap.

The same leak exists on `/customers/[id]/edit` (`app/(app)/customers/[id]/edit/page.tsx:39-65`) — every branch of the customer is loaded into the edit form's initial state and rendered as editable inputs.

**Fix:**
Filter `customer.branches` by the user's scope before rendering. In the page, after `loadScope`:

```ts
if (sessionUser.role === Role.SALESMAN) {
  customer.branches = customer.branches.filter(b => b.routeId === scope.ownedRouteId);
} else if (sessionUser.role === Role.SUPERVISOR) {
  customer.branches = customer.branches.filter(b => scope.teamRouteIds.includes(b.routeId));
} else if (sessionUser.role === Role.MANAGER && scope.managedRegionIds.length > 0) {
  customer.branches = customer.branches.filter(b => scope.managedRegionIds.includes(b.regionId));
}
```

Then the `Recent activity` panel and any per-branch-id query (photos, edits) must also drop in-scope-only.

---

### RBAC-05-002 — `/customers` list card primary-branch leaks across-route info

**Severity:** High · **Confidence:** Confirmed (code review)

**File:** `app/(app)/customers/page.tsx:65-76`. The list query filters `customer.branches: { some: { routeId: ownedRouteId } }` (good) but the eager-load at line 73 is `branches: { take: 1, orderBy: { createdAt: 'asc' } }` — it picks the **oldest** branch, regardless of whether that branch is on the salesman's route.

**What the user sees:**
For a Carrefour-style multi-branch customer where the oldest record happens to be in another region, the salesman's customer list shows the Dhofar address as the primary subtitle line. The salesman's own MCT-01 branch never appears in the list view.

**Why it matters:**
Same data-leak class as RBAC-05-001 but on the LIST page (more harvestable — one scroll → 50 customers' competing-region addresses).

**Fix:** Add `where: { routeId: me.ownedRouteId }` (and analogous for Supervisor/Manager) on the include's `branches`. Also reorder by `routeId === ownedRouteId DESC, createdAt asc` if you keep `take: 1`.

---

### RBAC-05-003 — Manager can approve any edit globally, no region scope

**Severity:** Critical · **Confidence:** Confirmed (code review)

**Files:**
- `app/(app)/approvals/page.tsx:19-23` — for MANAGER, `where = { state: SUBMITTED }` (no region filter at all).
- `app/(app)/approvals/[id]/page.tsx:36-41` — only Supervisor gets the "is it your team?" check; Manager has zero scope check.
- `lib/permissions.ts:103-110` — `canApproveSpecificEdit` returns `true` for `MANAGER` regardless of which region the submitter operates in.
- `services/edits.ts:483, 612` — both `approveEditAction` and `rejectEditAction` rely on `canApproveSpecificEdit`.

**What the user sees:**
Manager A (managedRegions = [Muscat, Batinah]) opens `/approvals` and sees the entire global queue including a salesman in Dhofar (Manager B's region). They click Approve. The edit lands in the live master. PRD §4 says "Approve / reject submission: Manager ⚠ override only" — that suggests an override path, not a default approve-anywhere primitive, and certainly not without a written reason or audit flag.

**Why it matters:**
Two-Manager separation of duty is broken. Manager A can rubber-stamp Manager B's region's edits without a paper trail describing why a cross-region override happened. Combined with the "no peer-Manager protection" finding, one rogue Manager can affect the entire master.

**Fix:**
- `/approvals` list: scope to `customer.branches.some(regionId IN scope.managedRegionIds)` for Manager.
- `/approvals/:id`: load the edit's customer's branches, check region overlap with this Manager's regions; if no overlap, redirect or 404.
- `canApproveSpecificEdit`: take a `branches` argument and require region overlap for Manager. Mark Manager approval as "override" in the audit row (different action label) and require a `reason` field.

---

### RBAC-05-004 — Manager can direct-write any customer globally with no region check

**Severity:** High · **Confidence:** Confirmed (code review)

**File:** `services/edits.ts:204-209, 336-366`. The submit action allows `Role.MANAGER` to bypass the salesman-scope check (line 207 only throws if role is not STEWARD/MANAGER/SALESMAN). It then enters the `isDirectWrite` path, applying the changes immediately and writing audit. There is no `loadScope`, no region check, no override-reason requirement, no `MANAGER_OVERRIDE` audit-action distinction.

**What the user sees:**
A Manager in Muscat opens any customer in Dhofar via the direct URL, edits the form, hits "Submit" — change applied. The audit row says `action: UPDATE` with no indicator that this was an out-of-region override.

**Why it matters:**
PRD §4 says Manager edit is "❌" except for "override only — every override is audit-logged with mandatory reason". Both halves of that contract are missing — there is no override flag distinguishing a normal edit, and there is no reason input.

**Fix:** In `submitEditAction`, when role is MANAGER, require `formData.reason` (≥10 chars), require region overlap, and write audit with `action: 'OVERRIDE'`. Or simpler — block Manager from this path entirely and route any override through a separate `managerOverrideAction` server action that has its own UI.

---

### RBAC-05-005 — `/customers/:id/edit` page renders form for Supervisor (server later refuses)

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `app/(app)/customers/[id]/edit/page.tsx:69-79`. The page only redirects SALESMAN-out-of-route and VIEWER. SUPERVISOR is allowed to open the form. They can fill it in. They click "Submit" and the server action throws `ForbiddenError('Role SUPERVISOR cannot submit edits.')` (`services/edits.ts:208`). The user gets a thrown-error page after losing all their typing.

**What the user sees:**
Supervisor sees a "Enrich" link on the profile (the page suppresses it for SUPERVISOR via `canEdit` — but a direct URL `…/edit` still works). Or a Manager with stale page state. They edit fields, hit submit, get a server error and lose unsaved data.

**Why it matters:**
Predictable footgun. Worse, an attacker who got a Supervisor account could be lulled by the form's success-looking UI into thinking their changes went through. Also bad for a viewer / read-only auditor watching demos.

**Fix:** In the page, redirect SUPERVISOR away the same way VIEWER is redirected.

---

### RBAC-05-006 — Manager can demote / disable / reset password of peer Manager (and Steward)

**Severity:** High · **Confidence:** Confirmed (code review)

**Files:**
- `services/users.ts:103-124` — `toggleUserActiveAction` has no check that the *target* user's role is below the actor. Manager A can disable Manager B, the Steward, themselves, or the only active Manager (last-Manager lockout). No "must keep at least one active MANAGER" guard.
- `services/users.ts:126-146` — `resetPasswordAction` has no peer / target-role guard. Manager A can rotate Manager B's password and immediately log in as them.
- `services/users.ts:42-101` — `createUserAction` does NOT validate the role being created (so Manager can create another MANAGER or a STEWARD), nor does it validate that `supervisorId` actually points at a SUPERVISOR.

**What the user sees:**
On `/users` Manager A clicks the row-actions for Manager B and gets the same Disable / Reset Password buttons that work for any salesman. There is no UX or server-side guard distinguishing peer-mutation from subordinate-mutation.

**Why it matters:**
Account takeover within the management tier in seconds. The audit row says "actor=Manager A, target=Manager B, action=UPDATE password_reset" — but by the time anyone reviews it, Manager A is already logged in as Manager B with a JWT they minted. Combined with PROD-002/003 (stale role/active in JWT), even if you re-disable A their session keeps working for hours.

**Fix:**
- Disallow `toggleUserActiveAction` and `resetPasswordAction` when `target.role !== SALESMAN && target.role !== SUPERVISOR && target.role !== VIEWER`. STEWARD and MANAGER should be mutated only by another STEWARD or by an out-of-band process.
- Add "last active MANAGER" guard.
- `createUserAction` should reject `role IN [MANAGER, STEWARD]` (only Steward, via direct DB ops or a special protected page, should mint other admins).

---

### RBAC-05-007 — `/audit` shows global log to any Manager; PRD says regional + excludes Steward who needs it most

**Severity:** High · **Confidence:** Confirmed (code review)

**File:** `app/(app)/audit/page.tsx:9-20`.

**What the user sees:**
Manager A opens `/audit`. Sees the last 100 global events including Manager B disabling a user in Dhofar, Steward running an import, a Salesman in another region updating a customer. Steward (the data ops role who SHOULD have audit access per PRD §4) is redirected to `/home` instead — they have no audit view at all.

**Why it matters:**
PRD §4 says Manager audit is "regional", Steward audit is "global". Both are inverted in the implementation: Manager sees global, Steward sees nothing. The same audit row also includes `before`/`after` JSON which can carry phone numbers, CR numbers, GPS — Manager A reading other regions' rows is a privacy concern.

**Fix:**
- Add STEWARD to the gate.
- For Manager, filter logs by entity scope: actor's region overlaps OR target customer/branch in managed regions. Easiest path: a dedicated query that joins through `Customer.branches` for `entityType='Customer'` rows, and similar for Branch / CustomerEdit.

---

### RBAC-05-008 — `/reactivations` shows global queue + Manager A approves Manager B's region

**Severity:** High · **Confidence:** Confirmed (code review)

**Files:**
- `app/(app)/reactivations/page.tsx:11-32` — Manager-only gate (correct), but query has no region filter.
- `services/reactivations.ts:174-238` — `approveReactivationAction` does role check (`Role.MANAGER`) but no region overlap check.

**What the user sees:**
Manager A opens `/reactivations`, sees a Dhofar reactivation request, approves it. The CLOSED branch in Dhofar is now ACTIVE. Manager B (whose region it actually is) had no chance to review. The audit row lists Manager A as the actor — Manager B might think Manager A is freelancing in their territory.

**Why it matters:**
This is exactly the cross-region segregation-of-duty violation the PRD's two-Manager design was meant to prevent. The reactivation flow was the showcase use case for "Manager-only" review per PRD v0.2 §6.5 — it should be the strictest scope-check in the app.

**Fix:** Filter the queue and assert in `approveReactivationAction` that the branch's region is in `actor.managedRegions` (or require an explicit `crossRegion=yes + reason` like the merge path now does).

---

### RBAC-05-009 — Imports + duplicate merge open to Manager (PRD says Steward-only)

**Severity:** Medium · **Confidence:** Confirmed (code review)

**Files:**
- `services/imports.ts:15-22` — `requireSteward` actually accepts STEWARD or MANAGER.
- `services/duplicates.ts:11-18` — same.
- `app/(app)/import/page.tsx:13-15` and `app/(app)/duplicates/page.tsx:14-17` — same.

PRD §4 explicitly says: "Import Excel master: Manager ❌"; "Resolve duplicates / merge: Manager ❌". The rationale is separation of duty — Manager controls users + dashboards; Steward controls master-data ingestion. Conflating the two means a Manager can self-promote via import (closed in QA-011 only because the `change_role=yes` opt-in was added, not because Manager was removed from the import path).

**Why it matters:**
PRD violation. Also, Manager B running an unsanctioned customer-master import or merging customers across regions becomes the same problem class as RBAC-05-006 (peer-admin power).

**Fix:** Tighten both gates to STEWARD only. Keep the merge cross-region "Manager-confirm" semantics but spelled out as "Steward initiates, Manager(s) of affected region(s) confirm" — a different design.

---

### RBAC-05-010 — `/work` shows Manager all stale approvals globally

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `app/(app)/work/page.tsx:82-98`. Manager `stale` query has no region filter.

**What the user sees:**
The Work Items inbox is supposed to be "things requiring my attention". A Manager's inbox should be their region's stale items. Instead Manager A sees Dhofar's stale items and can click into them (then RBAC-05-003 lets them approve).

**Fix:** Same pattern — region scope filter on the query.

---

### RBAC-05-011 — Supervisor / Manager can attach photos via `attachPhotoAction` despite PRD saying Manager/Supervisor cannot capture/replace photos

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `services/photos.ts:35-171`.

**What the user sees:**
The flow has no UI exposure for Supervisor/Manager today, but a direct server-action invocation (RSC payload) works. PRD §4: "Capture / replace photos: Supervisor ❌, Manager ❌" — only Salesman + Steward. Code at line 50 explicitly waives the `capturedById` check for STEWARD or MANAGER. SUPERVISOR isn't mentioned in any branch — no role gate at all once you reach line 59 (the Salesman branch is the only one that requires owned-route, all other roles fall through with no scope/role check).

**Why it matters:**
A Supervisor can re-point a Salesman's freshly-uploaded photo to a different customer/branch within their team's scope. A Manager can do the same anywhere. Both contradict PRD. Audit-trail of "captured-by" is preserved (which is good) but the "wired-to" mutation is silent.

**Fix:**
- Add `assertRole(user, [SALESMAN, STEWARD])` at the top.
- Drop the `isAdmin` shortcut at line 50 — even Steward should only attach attachments they uploaded themselves OR have a dedicated "wire someone else's upload" action with audit.

---

### RBAC-05-012 — `canSeeCustomer` returns `true` for Manager with empty `managedRegionIds`

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `lib/access.ts:74-79`.

```ts
case Role.MANAGER:
  if (scope.managedRegionIds.length === 0) return true;  // <— "see everything"
  return customer.branches.some(...);
```

**What the user sees:**
A Manager whose `managedRegions` join row was deleted (e.g., during a migration, or because their last managed region was deactivated) silently becomes a global-access Manager. Same is true for a freshly-created Manager whose regions have not been wired yet — they get the keys to the kingdom.

The dashboard has the same "no regions = global" semantics (`app/(app)/dashboard/page.tsx:23` `isScoped = regionIds.length > 0`).

**Why it matters:**
"Fail-open" default. The safe default is fail-closed: an unscoped Manager sees nothing until a Steward assigns regions.

**Fix:** Flip to fail-closed. `if (scope.managedRegionIds.length === 0) return false;`. Add a banner on `/dashboard` that says "No regions assigned — contact Steward".

---

### RBAC-05-013 — Steward redirected away from `/routes` and `/dashboard`

**Severity:** Low · **Confidence:** Confirmed (code review)

**Files:**
- `app/(app)/routes/page.tsx:13-14` — Manager-only.
- `app/(app)/dashboard/page.tsx:11-12` — Manager + Viewer only; Steward gets `/home` → `/import`.

**Why it matters:**
PRD §4: "Manage routes / regions: Manager ✅, Data Steward ✅"; "View dashboards: Data Steward → global". Steward is denied both. It's a low-blast-radius mismatch — Steward owns master-data ingestion, so giving them route management makes sense; the dashboard exclusion is just inconvenient. Both contradict PRD.

**Fix:** Add STEWARD to both gates. Steward dashboard is the same "global" view a Viewer sees today.

---

### RBAC-05-014 — `assertCanAccessAttachment` lets uploader bypass scope after wiring

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `lib/access.ts:130-168`. Line 138:

```ts
if (attachment.capturedById === user.id) return;  // unconditional bypass
```

**What the user sees:**
Salesman A captures a photo on customer X (their route), photo is wired to X. Months later A's route is reassigned (their `ownedRouteId` flipped to a different route). They can still GET `/api/photos/<old-photo-id>` because `capturedById === me.id` short-circuits the scope check. Same applies if A is reassigned to a different region (no longer their route's region) or if customer X is merged into a customer whose branches have all moved out of A's scope.

**Why it matters:**
The intent (per the comment on line 137) was to handle "freshly uploaded, not yet wired" photos. The implementation also covers the wired-and-old case, leaking historical access permanently.

**Fix:** Only bypass when `attachment.customerId === null && attachment.branchId === null && attachment.branchExtraId === null`. After wiring, scope-check via the customer.

---

### RBAC-05-015 — Soft-deleted attachments still served (or 502'd, leaking ID validity)

**Severity:** Low · **Confidence:** Confirmed (code review)

**File:** `app/api/photos/[id]/route.ts:25-26`. The route does `findUnique` with no filter on the soft-delete sentinel (`r2Key` starts with `__deleted__/`). It then proceeds to `assertCanAccessAttachment` (which still returns OK because `capturedById` short-circuits — see RBAC-05-014). The R2 fetch fails because the key was renamed → 502.

**Why it matters:**
- Pre-deletion, status was 200 with the body.
- Post-deletion, the same URL returns 502 (a different code than "404 Not Found").
- Combined with the `capturedById` bypass, the attacker can confirm "this attachment ID exists, it was deleted recently" — useful for sniping audit-trail timing.

**Fix:** Treat soft-deleted attachments as 404. Test: `if (att.r2Key.startsWith('__deleted__/')) return 404`.

---

### RBAC-05-016 — Salesman with no `ownedRouteId` sees zero customers (correct) but the edit form lets them through

**Severity:** Low · **Confidence:** Confirmed (code review)

**Files:**
- `app/(app)/customers/page.tsx:41` — `where.id = '__none__'` (correct, fail-closed).
- `app/(app)/customers/[id]/edit/page.tsx:75` — `onMyRoute = customer.branches.some(b => b.routeId === me.ownedRouteId)` returns `false` because `ownedRouteId` is null and no branch has null routeId, so the redirect fires. ✅ Correct — false alarm, leaving in the report as a positive verification.

(Logged as Low to acknowledge the explicit verification but no fix needed.)

---

### RBAC-05-017 — `submitEditAction` checks role first then ownedRouteId — Salesman without route still hits "scope" branch

**Severity:** Low · **Confidence:** Confirmed (code review)

**File:** `services/edits.ts:200-209`. If `me.role === SALESMAN` and `me.ownedRouteId === null`, line 205's `customer.branches.some(b => b.routeId === me.ownedRouteId)` is `customer.branches.some(b => b.routeId === null)` — always false. So submit is correctly rejected with a generic "not on your route" error message instead of "you have no route assigned". Minor UX bug, not a security issue.

---

### RBAC-05-018 — `Customer.lastEditedById` and edit-flow paths trust session role without re-checking active flag

**Severity:** High · **Confidence:** Confirmed (code review) — feeds PROD-002/003 already documented but worth re-flagging in the RBAC context.

**File:** `services/edits.ts:336` (`isDirectWrite = !isDraft && (me.role === Role.STEWARD || me.role === Role.MANAGER)`). The `me.role` is read from `prisma.user.findUniqueOrThrow` (line 200) — that's good. **However the rate-limiter / approve / reject / reactivation paths only consult `session.user.role` from the JWT** (`services/edits.ts:483, 612`; `services/reactivations.ts:174, 240`). A user who was demoted from MANAGER to SALESMAN keeps a JWT claiming MANAGER for up to 8 hours and continues to approve edits, run reactivations, etc.

**Fix:** Tied to PROD-002/003 fix. Pull `role` from `prisma.user.findUnique` in every privileged action.

---

### RBAC-05-019 — Missing `User.supervisorId` integrity check — Salesman whose supervisor pointer is corrupt has unapprovable edits

**Severity:** Low · **Confidence:** Confirmed (code review)

**File:** `lib/permissions.ts:103-110`, `services/edits.ts:483`. `canApproveSpecificEdit` returns `submittedBy.supervisorId === user.id`. If `supervisorId` somehow points at another SALESMAN (data corruption via Excel re-upload), no SUPERVISOR will ever match → the edit can only be approved by a MANAGER (which is the wrong tier per PRD). If `supervisorId` is `null`, same outcome.

**Why it matters:**
The Excel-import path (`uploadAccountMasterAction`) does not validate that `supervisor_username` resolves to a user whose role is SUPERVISOR or MANAGER. A typo silently creates an orphan.

**Fix:** Validate role in the import. Add a periodic integrity job that flags `User.supervisorId` chains that don't terminate at a Manager.

---

### RBAC-05-020 — `Sidebar`/menu rendering trusts `session.user.role` (stale-JWT dependent)

**Severity:** Low · **Confidence:** Inferred from `app/(app)/layout.tsx:11-22` (passes role from session to the Sidebar component).

If PROD-002/003 are not yet fixed, a demoted user sees the sidebar of their old role until they log out. They can click through to those pages — server then enforces the gate (in most cases) — but UX is misleading and gives them a list of actions to try.

**Fix:** Same JWT-refresh fix as PROD-002/003.

---

### RBAC-05-021 — Salesman edit-status to/from CLOSED/SUSPENDED is now correctly blocked, but Steward / Manager bypass is silent

**Severity:** Low · **Confidence:** Confirmed (code review)

**File:** `services/edits.ts:289-307`. The QA-009 fix correctly throws for SALESMAN. But STEWARD / MANAGER can still flip CLOSED↔ACTIVE via the regular edit form, with no audit-action distinguishing it from a normal field change. PRD says CLOSED→ACTIVE requires Manager review with photo evidence even for Manager themselves (per O5 in the PRD changelog).

**Fix:** Force all status flips to/from CLOSED/SUSPENDED through the dedicated reactivation flow regardless of role; if a Manager truly needs an exception, require a separate `OVERRIDE_REACTIVATION` action with reason.

---

### RBAC-05-022 — `EnrichmentForm` initial values include other-route branches' photo IDs

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `app/(app)/customers/[id]/edit/page.tsx:39-65`. Same root cause as RBAC-05-001 but on the edit surface — the form ships `shopPhotoId`, `signboardPhotoId`, `gpsLat/Lng`, `address`, `routeId` for every branch of the customer, including the other-region one. A salesman can then capture a new photo and (via the photo-attach flow) wire it to a branch they shouldn't even know exists. The server-side `submitEditAction` does check `branch.routeId === me.ownedRouteId` for branches *included in the payload* (line 277) — but the Salesman has the IDs they need to forge a request.

**Why it matters:**
Defence-in-depth gap. The current submit gate is correct; the failure is informational (knowing the other branch's IDs lets an attacker target them via `attachPhotoAction` etc., where the gate is weaker — see RBAC-05-011).

**Fix:** Same as RBAC-05-001 — drop out-of-scope branches before passing to the form.

---

### RBAC-05-023 — `/users` lists every user with phone/email globally — Manager A sees Manager B's contact PII

**Severity:** Medium · **Confidence:** Confirmed (code review)

**File:** `app/(app)/users/page.tsx:16-23` — no filter on `prisma.user.findMany`.

**What the user sees:**
Manager A opens /users, sees `manager.b`'s `email`, `phone`, `lastLoginAt`, `supervisor.fullName`. PRD does not explicitly prohibit this, but the data-minimisation principle behind region scoping suggests Manager A doesn't need Manager B's phone number.

**Fix:** Show admin tier (MANAGER, STEWARD) without phone/email; show same-region salesmen + supervisors with full detail. Or split into two tabs.

---

### RBAC-05-024 — `Sidebar` exposes `/audit`, `/users`, `/routes` to Viewer? (verify)

**Severity:** Low · **Confidence:** Likely safe — checked via `app/(app)/audit/page.tsx`, `users/page.tsx`, `routes/page.tsx` — all redirect non-Manager away. But the sidebar may show the link, leading to a redirect-and-bounce loop in the UX. Worth reviewing the Sidebar component.

(Did not deep-dive Sidebar in this audit; flagged as a follow-up.)

---

### RBAC-05-025 — `/work` for VIEWER falls through to empty list (no role branch)

**Severity:** Low · **Confidence:** Confirmed (code review)

**File:** `app/(app)/work/page.tsx:30-113`. Only SALESMAN, SUPERVISOR, MANAGER, STEWARD have branches. VIEWER falls through with `items = []`. They see the page header "Work items · Things that need your attention" with no items. Confusing UX but correct (read-only role has no work). Documented for completeness.

---

## 3) Severity rollup

| Severity | Count |
|---|---|
| Critical | **2** (RBAC-05-001, RBAC-05-003) |
| High | **5** (RBAC-05-002, RBAC-05-004, RBAC-05-006, RBAC-05-007, RBAC-05-008, RBAC-05-018) |
| Medium | **9** (RBAC-05-005, RBAC-05-009, RBAC-05-010, RBAC-05-011, RBAC-05-012, RBAC-05-014, RBAC-05-022, RBAC-05-023, RBAC-05-025-adjacent) |
| Low | **9** (RBAC-05-013, RBAC-05-015, RBAC-05-016, RBAC-05-017, RBAC-05-019, RBAC-05-020, RBAC-05-021, RBAC-05-024, RBAC-05-025) |

(Note: I count High at 6 if RBAC-05-018 is double-counted under PROD-002/003 — listing once here.)

---

## 4) Recommended priority order

1. **Stop-ship**:
   - RBAC-05-001 — branch filter on customer profile + edit page (fixes the Salesman-sees-Dhofar leak class).
   - RBAC-05-003 — Manager region scope on approvals.
   - RBAC-05-006 — peer-Manager protection on user mutation.
2. **Pre-pilot day**:
   - RBAC-05-002, RBAC-05-007, RBAC-05-008, RBAC-05-022 — ride along with the same scope-filter PR.
   - RBAC-05-004 — Manager direct-write override path with mandatory reason.
   - RBAC-05-018 — JWT freshness (covers PROD-002/003 too).
3. **First pilot week**:
   - RBAC-05-005, RBAC-05-009 (PRD-alignment), RBAC-05-010, RBAC-05-011, RBAC-05-012 (fail-closed default), RBAC-05-014 (uploader bypass), RBAC-05-023 (PII).
4. **Backlog**:
   - RBAC-05-013, RBAC-05-015, RBAC-05-016, RBAC-05-017, RBAC-05-019, RBAC-05-020, RBAC-05-021, RBAC-05-024, RBAC-05-025.

---

## 5) Tests that should land with the fix

The remediation report claims 38 tests — none of these scenarios are covered. At minimum:

1. `tests/integration/rbac.profile.test.ts` — Salesman fetches `/customers/<multi-branch>` → branches array contains only their route's branch.
2. `tests/integration/rbac.approvals.test.ts` — Manager A POSTs `approveEditAction` for an edit submitted in Manager B's region → throws ForbiddenError.
3. `tests/integration/rbac.users.test.ts` — Manager A POSTs `toggleUserActiveAction` with Manager B's userId → throws.
4. `tests/integration/rbac.users.test.ts` — Manager A creates a MANAGER → throws.
5. `tests/integration/rbac.last-manager.test.ts` — Disable the only active Manager → throws.
6. `tests/integration/rbac.audit.test.ts` — Manager A reads `/audit` → no rows from Manager B's region.
7. `tests/integration/rbac.attach-photo.test.ts` — Supervisor calls `attachPhotoAction` → throws.
8. `tests/integration/rbac.fail-closed.test.ts` — Manager with `managedRegions=[]` → sees zero customers, not all of them.
9. `tests/integration/rbac.list.test.ts` — Salesman list page card subtitle === their route's branch.
10. `tests/integration/rbac.attachment-bypass.test.ts` — Salesman who lost their route still cannot fetch their old photo.

Without these, every fix in this audit is one accidental refactor away from regression.

— Adversarial QA, RBAC + scope chapter, 2026-05-09
