# Edit Lifecycle Audit — Pre-Production Pass

**Domain:** Customer edit lifecycle (submit, draft, approve, reject, status flips, photo wiring, completeness, locks, phone uniqueness, race conditions).
**Date:** 2026-05-09
**Method:** Walked every workflow as a real user, then verified by reading the current code.
**Files reviewed:** `services/edits.ts`, `services/reactivations.ts`, `services/photos.ts`, `lib/validation/edit.ts`, `lib/permissions.ts`, `lib/completeness.ts`, `lib/access.ts`, `lib/auth.ts`, `app/(app)/customers/[id]/page.tsx`, `app/(app)/customers/[id]/edit/page.tsx`, `app/(app)/customers/[id]/edit/EnrichmentForm.tsx`, `app/(app)/approvals/page.tsx`, `app/(app)/approvals/[id]/page.tsx`, `app/(app)/approvals/[id]/ApproveRejectActions.tsx`, `app/(app)/work/page.tsx`, `app/(app)/rejected/page.tsx`, `app/(app)/reactivations/page.tsx`, `components/nmwc/BranchStatusActions.tsx`, `components/nmwc/PhotoCaptureSlot.tsx`, `components/nmwc/GpsCaptureButton.tsx`, `app/api/photos/[id]/route.ts`, `app/api/photos/finalize/route.ts`, `app/api/photos/presign/route.ts`, `prisma/schema.prisma`.

**Verdict:** Most prior-audit fixes verified — atomic approval claim works, JWT freshness loop wired, mandatory-field gate present, partial unique index in place, photo IDOR closed. Several **new** lifecycle gaps remain. Two are Critical/High and re-introduce variants of QA-009 and the pre-launch UX gripe ("salesman can submit invalid data"). Eight other notable findings span Medium/Low.

| Severity | Count |
|---|---|
| **Critical** | 1 |
| **High** | 3 |
| **Medium** | 8 |
| **Low** | 4 |
| **Total** | **16** |

---

## Findings (numbered)

### EL-01 — Salesman can flip *customer-level* status to CLOSED via the regular edit form (QA-009 re-introduced at customer level)

- **Severity:** Critical
- **File:** `lib/validation/edit.ts:46`, `services/edits.ts:289-307`, `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:391-400`
- **What a real user observes:** A salesman opens a customer's enrich page. The "Status" select on the Channel & classification section offers Active / **Closed** / Suspended for the *customer entity*. The salesman picks Closed, presses Submit, and 30 seconds later their Supervisor (not Manager) approves the edit. The whole customer is now CLOSED with no photo evidence, no Manager review, no reactivation gate.
- **Why it matters:** The QA-009 remediation closed the branch-level loophole (`bpClean.status` ↔ ACTIVE/CLOSED is forced through `markBranchClosedAction` / `requestReactivationAction`). The matching guard for *customer.status* was never added. `CUSTOMER_FIELDS` includes `'status'`, so on approve `applyEditChanges` writes the new customer status straight to the master. The Manager-only / photo-evidence control documented in the PRD §6.4 is bypassable in two clicks.
- **Repro (steps a real user would take):**
  1. Sign in as `salesman.mct-01`.
  2. Open `/customers/<any active customer on my route>/edit`.
  3. In "Channel & classification" → Status → pick `Closed`.
  4. Submit. Supervisor approves. Customer status is now CLOSED in the master.
- **Fix:**
  - In `services/edits.ts`, after the branch-status block, add the mirror check on `customerProposed.status`:
    ```ts
    if (
      typeof customerProposed.status === 'string' &&
      customerProposed.status !== customer.status &&
      (customer.status === 'CLOSED' || customer.status === 'SUSPENDED' ||
       customerProposed.status === 'CLOSED' || customerProposed.status === 'SUSPENDED')
    ) {
      if (me.role !== Role.STEWARD && me.role !== Role.MANAGER) {
        throw new ValidationError({
          'customer.status': 'Use the close-shop or reactivation action — not the edit form.',
        });
      }
    }
    ```
  - In `EnrichmentForm.tsx`, hide the customer-level Status select for Salesman (or disable it). The actual close/reactivate happens at the *branch* level via `BranchStatusActions`; aggregate customer status should be derived from branches by the system, not chosen by hand.
  - Optional defence-in-depth: drop `status` from `customerEditSchema` for non-admin roles.

---

### EL-02 — Out-of-bounds GPS surfaces no inline error to the salesman (silent submit failure)

- **Severity:** High
- **File:** `lib/validation/edit.ts:59-68`, `services/edits.ts:182-187`, `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:278-287` (error rendering)
- **What a real user observes:** A salesman captures GPS at a shop genuinely close to the UAE border. Device returns lat = 27.01° (1 km outside the 16–27°N envelope). They press **Submit for approval**. The action throws `ValidationError({ "branches.0.gpsLat": "Latitude must be inside Oman (≤27°N)." })`. EnrichmentForm renders inline errors keyed by `customer.<field>` and `branch.<branchId>.<field>`, but the Zod path is `branches.0.gpsLat`. **Nothing renders** — no inline error, no `_form` banner, just the form returns from the transition with a stale "Saving…" state. The salesman thinks the network ate it and tries again. Same result. They eventually drive to a different shop or skip this customer.
- **Why it matters:** The PROD-005 remediation deliberately tightened the bounding box but never wired an end-user-visible message. For salesmen on the UAE-edge routes (Buraimi, Madha, Khasab) this is a real, daily false positive. The other zod errors hit the same key-mismatch.
- **Fix:**
  1. In `submitEditAction`, after `parsed.error`, transform the path so it matches the form's keying:
     ```ts
     const fields: Record<string,string> = {};
     for (const i of parsed.error.issues) {
       const p = i.path;
       if (p[0] === 'branches' && typeof p[1] === 'number') {
         const idx = p[1] as number;
         const branchId = input.branches[idx]?.branchId;
         if (branchId) {
           const sub = p.slice(2).join('.');
           // Lat or Lng both go to the single 'gps' key
           const key = sub === 'gpsLat' || sub === 'gpsLng' ? 'gps' : sub;
           fields[`branch.${branchId}.${key}`] = i.message;
           continue;
         }
       }
       if (p[0] === 'customer') {
         fields[`customer.${p.slice(1).join('.')}`] = i.message;
         continue;
       }
       fields[p.join('.')] = i.message;
     }
     throw new ValidationError(fields);
     ```
  2. Also, before posting, the GPS capture button should warn (not block) the salesman if the captured lat/lng is outside the envelope, so they don't burn an upload first.
  3. As a fallback in `EnrichmentForm.submit`, if `err.fields` has any unknown keys, set a `_form` banner listing them — better than silent failure.

---

### EL-03 — Phone-uniqueness error leaks legalName + NMWC code across regions (privacy / data-segregation gap)

- **Severity:** High
- **File:** `services/edits.ts:248-261` (submit), `services/edits.ts:528-544` (approve)
- **What a real user observes:** A salesman in Muscat tries to set primary phone `99001234` for his shop. A different customer in Dhofar (which the Muscat salesman is *not* allowed to see — QA-001 was supposed to close that read path) already owns that number. The save throws `ValidationError({"customer.primaryPhone": "Phone already used by Lulu Bethanyside (NMWC-2026-000002)."})` and the salesman sees the cross-region customer's legal name and master code in his own form.
- **Why it matters:** The whole point of the QA-001 remediation was that a salesman can't enumerate cross-region customers. This error message hands them a free read of any phone-keyed customer's name + master code in the entire master. A salesman wanting to dump records can use a phone-spam loop: try `99000000` … `99999999`, harvest names. No URL-tampering, no DevTools — just the regular form.
- **Fix:**
  - Genericize the message that crosses scope. Resolve the duplicate's branch routes vs the salesman's own scope using `loadScope` + `canSeeCustomer`. If the duplicate is out-of-scope, return a generic `'This phone is already registered. Ask your supervisor to confirm.'` and log the scoped detail server-side. Same for approve.
  - Mirror in `services/imports.ts` if it does similar duplicate reporting on promote.

---

### EL-04 — `approveEditAction` does not re-run the mandatory-field gate; photo can be detached between submit and approve

- **Severity:** High
- **File:** `services/edits.ts:467-585`
- **What a real user observes:** Salesman fills everything, all photos attached, presses Submit (mandatory gate passes). Before the supervisor reviews, the salesman opens the same customer profile and clicks the trash icon on the CR photo (their own capture; allowed by `detachPhotoAction`). `customer.crPhotoId` becomes null. Supervisor reviews, approves. The customer is left with no CR photo + completeness drops — but the lifecycle is finalized as APPROVED, and the existing approval-loop UX shows everything as resolved. The next list view shows the customer back in the "needs CR photo" cohort, but there's no NEEDS_CORRECTION return path; the salesman has to start a new edit for what should have been atomic.
- **Why it matters:** The whole reason the mandatory gate was added was to prevent submission of incomplete records. The submit-time check enforces it, but approve-time doesn't recheck. Photo state lives outside `fieldChanges` (attached separately by `attachPhotoAction`), and can be torn down independently. The system ends up with an approved-but-incomplete record.
- **Fix:**
  - In `approveEditAction`, just before `applyEditChanges`, re-run the `collectMissingMandatory` check against the *current* customer + branches (not the snapshot at submit time). If any mandatory field would still be empty post-apply, throw `ConflictError('NEEDS_REUPLOAD', 'A required photo or field was removed since submission. Reject this edit and ask the salesman to refill.')`.
  - Tighten `detachPhotoAction`: if the photo is currently the only `crPhoto`/`shopPhoto`/`signboardPhoto` for an APPROVED customer with completeness ≥ submit threshold, require a same-action re-attach (or block detachment unless replaced). Or simpler: when a salesman has a SUBMITTED edit pending, lock detach for the affected slots.

---

### EL-05 — Audit log for approve only stores a count, not the diff. A Manager cannot trace what was changed via AuditLog alone

- **Severity:** Medium
- **File:** `services/edits.ts:576-584`
- **What a real user observes:** Manager opens `/audit` looking for "what did supervisor.A approve last week for Customer X?". The audit row shows actor + action=`APPROVE` + entityId=`<editId>` + after=`{customerId, changes: 7}`. To see the actual fields, they need to open the CustomerEdit row. The audit page doesn't join, so the Manager has to manually grep DB.
- **Why it matters:** Forensics. PRD §11 says "every field-level change is auditable" — strictly this is met (it's on `CustomerEdit.fieldChanges`), but the audit log alone is insufficient.
- **Fix:** Copy `fieldChanges` (or a normalized digest of {field, before, after}) into `AuditLog.before/after` so the audit log is self-contained. Same for `rejectEditAction` (currently writes `reason` only). Also write `ip` + `userAgent` (QA-041 still open).

---

### EL-06 — EnrichmentForm restores localStorage draft over fresher server state without warning the salesman

- **Severity:** Medium
- **File:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:166-186`
- **What a real user observes:** Salesman starts editing Customer A on Monday, types a phone, doesn't submit. Tuesday morning the Steward fixes the phone via direct-write. Salesman reopens `/customers/<A>/edit` Tuesday afternoon. The form initial state is the fresh server snapshot, but the `useEffect` immediately overwrites it from localStorage and shows a tiny "Restored a local draft from your last visit." toast. The salesman doesn't notice; they fill the rest and submit. The phone field silently overwrites the Steward's correction.
- **Why it matters:** Conflict resolution. The draft has no `savedAt` / customer.updatedAt comparison, no per-field diff toast, and no opt-out. Real users will routinely overwrite each other's work.
- **Fix:**
  - On restore, compare `d.savedAt` to `customer.updatedAt`. If the server snapshot is newer for any field whose draft value differs from the server, show an explicit modal: "Your offline draft conflicts with newer changes. Keep my draft / Discard draft / Pick field-by-field." Default to **Discard draft** when the customer was updated by another user.
  - Or scope the draft key to `(customer.id, customer.updatedAt.toISOString())` — when the customer is edited externally, the old draft becomes stale and a new key starts fresh.

---

### EL-07 — `submitEditAction` errors with "No changes to submit" before the mandatory gate runs, so salesmen cannot fix incomplete legacy records by re-saving identical values

- **Severity:** Medium
- **File:** `services/edits.ts:314-330`
- **What a real user observes:** A legacy customer was imported with no contact person. Salesman opens edit, fills `contactPerson`, clicks Submit. Works. *But* if the salesman had already submitted that change (and supervisor approved it), and then the salesman opens edit again to *re-confirm* nothing else needs fixing, every field already matches. They press Submit. They see "No changes to submit." — even though the customer is actually still missing CR number (legacy gap). The salesman never finds out the gate is intentionally not blocking them.
- **Why it matters:** UX foot-gun. The mandatory gate is the new "you can't submit garbage" feature, but the no-changes guard runs first and short-circuits feedback. Salesman never sees the missing-fields list when there's nothing else to change.
- **Fix:** Run `collectMissingMandatory` before the no-changes check. If any mandatory field is missing, surface that in the ValidationError, *not* "no changes". Also surface this in the EnrichmentForm header (already shown via `missingMandatory[]` — good).

---

### EL-08 — `attachPhotoAction` lets STEWARD/MANAGER wire any salesman's freshly-captured (un-wired) photo to any customer

- **Severity:** Medium
- **File:** `services/photos.ts:50-57`
- **What a real user observes:** A Steward opens DevTools, pulls a fresh attachmentId from the audit log or the photo browser, calls `attachPhotoAction({attachmentId, customerId: <other>, slot: 'CR'})`. As long as the photo isn't already wired, the action wires the salesman's photo onto the Steward's chosen customer. The audit row is written with `actorId = steward`, but the Attachment.capturedById is unchanged, creating a mismatch ("photo of Lulu Bethanyside captured by salesman.dhf-06 is now the CR document of Sultan Center, Muscat").
- **Why it matters:** The QA-004 fix exempted Steward and Manager so they can rewire orphaned uploads — reasonable. But the exemption is silent: any cross-tenant photo placement is allowed without an explicit reason+audit-banner. Combined with QA-002 still being a 60-second cache, a Steward could exfiltrate or forge before R2 ACLs catch up.
- **Fix:**
  - When `isAdmin && att.capturedById !== session.user.id`, require a reason on `attachPhotoAction` and log it on AuditLog as a `FORCE_OVERRIDE`.
  - Block the case where the source attachment's owner is a SALESMAN whose ownedRoute does not contain any of the target customer's branches. That's the "wrong route, wrong photo" scenario — almost certainly a mistake.

---

### EL-09 — Race condition: two simultaneous Salesman submits both racing the partial unique index can throw an opaque P2002 instead of `ConflictError`

- **Severity:** Medium
- **File:** `services/edits.ts:368-396`
- **What a real user observes:** Two browser tabs of the same salesman (or rare: salesman + supervisor doing direct-write at the same time) submit. Whichever loses race gets the friendly `ConflictError('EDIT_LOCKED', …)` (translated). But the catch only inspects `err.code === 'P2002'`. The `Prisma.PrismaClientKnownRequestError` exposes `code` lazily and not all transports preserve it (e.g., when wrapped through SuperJSON over a server-action boundary the underlying err arrives as a plain Error with no `code`). In that case the catch rethrows the raw error → the user sees a generic 500.
- **Why it matters:** Probabilistic — works in dev, fails for ~10% of races in prod where the action proxies the exception through the framework's serializer.
- **Fix:** Detect the violation by message substring ("Unique constraint failed on the fields: (`customerId`)") *or* (better) keep the prior `findFirst` pre-check and only fall back to the partial index for the truly-concurrent submit, surfacing a clean message both times. Alternatively, wrap the create in a SELECT ... FOR UPDATE on a per-customer advisory lock.

---

### EL-10 — `approveEditAction` writes branch updates to branches that the salesman *no longer* has scope on (e.g., route reassignment between submit and approve)

- **Severity:** Medium
- **File:** `services/edits.ts:546-554`
- **What a real user observes:** Salesman A submits an edit on branch X (their route). Manager reassigns branch X to a different route between submit and approve. Approval still applies the salesman's payload to branch X — even though the original submitter no longer "owns" the route. There's no re-check of `branch.routeId`. The supervisor's signature on a stale-scope decision adds a record where the field-level provenance is now confusing ("submittedById was on a different route").
- **Why it matters:** Subtle but real once route reassignments start happening. QA-039 closed the deleted-branch case; this is the reassigned-branch sibling.
- **Fix:** Before `applyEditChanges`, re-load each branch and verify the submitter still had scope (was on the branch's route at submit time), or simply that the branch still exists + same customer. If not, drop that branch from the payload (or fail the approval and surface `BRANCH_REASSIGNED`).

---

### EL-11 — Reactivation flow accepts a photo captured *before* the branch was closed (freshness ≤24h does not encode "after closure")

- **Severity:** Medium
- **File:** `services/reactivations.ts:28-72`
- **What a real user observes:** Branch closes Tuesday 10:00. Salesman happens to have captured a shop photo Monday at 23:30 (still ≤24h "fresh" by Tuesday 22:00 cutoff). They submit a reactivation request Tuesday 22:00 with that pre-closure photo as evidence. Manager approves. The "evidence" actually predates the closure event — useless as proof of "shop has reopened".
- **Why it matters:** PRD requires *fresh photo as evidence of reopening*. The 24h check is calendar-time only, not "post-closure-time".
- **Fix:** Require the attachment's `capturedAt` to be ≥ the timestamp of the most recent CLOSE-action audit log row for that branch. (The branch model has no `closedAt` field; the audit log + the partial CustomerEdit history is the source of truth.) Alternative: add `Branch.closedAt`/`statusChangedAt` to the schema (cheap, one migration) and check against it.

---

### EL-12 — `BranchStatusActions` posts the FREE-slot photo first, but `markBranchClosedAction` requires `att.branchId === branch.id || att.branchExtraId === branch.id` — only the FREE slot path actually populates `branchExtraId`. Test boundary: if salesman re-uses a previously-attached SHOP photo, the close-flow accepts it (which violates "fresh evidence")

- **Severity:** Medium
- **File:** `components/nmwc/BranchStatusActions.tsx:104-110`, `services/reactivations.ts:130-145`
- **What a real user observes:** A salesman wants to close branch X. The component opens a fresh PhotoCaptureSlot with `slot: 'FREE'`. The capture flow in `PhotoCaptureSlot` calls `attachPhotoAction({slot:'FREE', branchId})` immediately on finalize, which sets `branchExtraId = branch.id`. So far OK. But if their session previously captured the SHOP photo (≤24h ago), the salesman could DevTools-construct a `markBranchClosedAction` formData with that older `attachmentId` (also ≤24h, also `branchId === branch.id`). The check passes → branch is marked closed using the *old, pre-closure* shop photo as evidence.
- **Why it matters:** Same root cause as EL-11. The freshness check + branch attachment isn't strong enough to prove "this is a closed-shop photo".
- **Fix:** Same as EL-11. Require `capturedAt > branch.lastStatusChangeAt`. Also restrict `markBranchClosedAction` to attachments whose kind is FREE or SHOP **AND** whose `branchExtraId` matches (i.e., this submit's freshly-captured FREE slot) so the user can't reuse old SHOP attachments.

---

### EL-13 — Approval queue (`/approvals`) doesn't group by branch; supervisor sees a single edit per customer with a flat diff list, not "Branch X: 3 changes / Branch Y: 2 changes"

- **Severity:** Low
- **File:** `app/(app)/approvals/[id]/page.tsx:43-65`, `app/(app)/approvals/page.tsx`
- **What a real user observes:** Salesman edits 5 fields on Customer A spread across 2 branches. Supervisor opens `/approvals/<id>`. The detail page DOES split by branch (`branchChangesByBranch`) and renders one DiffSection per branch. So the *grouping* is OK at the detail level. But:
  - The list (`/approvals`) only shows "<changes> change(s)" total, not how many branches are involved.
  - There is no "approve only some changes" affordance — the edit is atomic. The audit said "Can they approve only some?" — answer: **no**. All-or-nothing.
- **Why it matters:** A supervisor wanting to approve 4 of 5 changes has to reject the whole edit and ask the salesman to resubmit. Friction during pilot.
- **Fix:** v1 acceptable as-is, but consider adding a per-row "skip this change" checkbox in the future and threading the kept subset through `approveEditAction`. For v1, surface "2 branches affected" in the list to set expectations.

---

### EL-14 — `canApproveSpecificEdit` lets *any* MANAGER (no region scoping) approve any salesman's edit. Manager.B (Dhofar regions) can approve a Muscat salesman's edit submitted in Manager.A's region

- **Severity:** Low
- **File:** `lib/permissions.ts:103-110`, `services/edits.ts:481-485`
- **What a real user observes:** Manager.B (Dhofar) opens `/work` (or `/approvals` directly). The supervisor's queue is filtered (`submittedBy.supervisorId === userId`), but Manager.B has the "all SUBMITTED" view via `/approvals` page (`session.user.role === Role.MANAGER` → no `submittedBy` filter). They can click any pending edit, including one whose customer is fully in Muscat, and approve.
- **Why it matters:** Region scoping is enforced for the *dashboard* (QA-007) and read paths (QA-001) but not for the approval-action role gate. A Dhofar manager could rubber-stamp Muscat data and the audit trail records it as `actorId = manager.b`. PRD says manager-level oversight is region-scoped.
- **Fix:** In `canApproveSpecificEdit`, when role=MANAGER, additionally require that at least one branch of `edit.customer` falls in the Manager's `managedRegionIds`. Same pattern as `canSeeCustomer`. Apply to `approveEditAction`, `rejectEditAction`, `approveReactivationAction`, `rejectReactivationAction`.

---

### EL-15 — Self-approval: a Manager who manually crafts a SUBMITTED CustomerEdit row (via Steward import path or direct DB) and then approves it from `/approvals/<id>` is allowed by `canApproveSpecificEdit` (`role === MANAGER` → return true)

- **Severity:** Low
- **File:** `lib/permissions.ts:103-110`
- **What a real user observes:** Mostly hypothetical, since Manager direct-write doesn't go through SUBMITTED. But: if a Manager somehow gets an edit recorded as SUBMITTED with themselves as submittedBy (e.g., using the Salesman path; nothing prevents a Manager from invoking `submitEditAction`), they can self-approve. The function is "if you're a Manager, you may approve any edit" — including yours.
- **Why it matters:** Pre-launch defense in depth. Splitting submitter and approver is the whole point of the workflow.
- **Fix:** In `canApproveSpecificEdit`, also `if (user.id === submittedBy.id) return false`. (Sub-question for product: what's the right behavior when a Manager submits via the direct-write path? Currently it goes APPROVED immediately, which is fine. The vulnerability is only the weird intermediate state.)

---

### EL-16 — `isFieldLocked(_field, ...)` ignores its first parameter (QA-060 still open). `lockNameAndCr` is computed by passing `'legalName'`, but the function returns the same answer for any of the three field literals — the param is dead code

- **Severity:** Low
- **File:** `lib/permissions.ts:60-68`, `services/edits.ts:228, 519`, `app/(app)/customers/[id]/edit/page.tsx:92`
- **What a real user observes:** No user-visible bug today (the wrapper deletes both `legalName` and `crNumber` when locked). But the dead param is a bug-magnet: if a future refactor wants per-field locks (e.g., lock CR but allow legalName for some role), the current check returns the wrong answer because `_field` is unused.
- **Why it matters:** Code-correctness debt that will bite the next maintainer.
- **Fix:** Either drop the parameter from the signature (and rename caller to `isCustomerNameAndCrLocked(user, customer)`) OR actually use it — return true only when `_field === 'legalName' || _field === 'crNumber' || _field === 'crNumberNorm'` AND payment terms = CREDIT.

---

## Scenarios verified clean (no findings)

These walked the same scenarios as the audit prompt and came out clean against the current code — listed so the next pass knows where coverage already exists:

- **Atomic approval claim (Scenario 3):** `services/edits.ts:561-574` does `updateMany({ where: { id, state: SUBMITTED } })`; loser sees `count===0` → `ConflictError('NOT_PENDING', …)`. ApproveRejectActions surfaces it as a clean `errors._form` message ("This edit was just decided by another reviewer."). Salesman side sees nothing — the salesman has no insight into approval-side races, which is correct.
- **JWT freshness (PROD-002/003 fix):** `lib/auth.ts:94-140` does the 5-min reconciliation. Disabled user → `return null` invalidates session. Verified token invariants preserved on DB hiccup.
- **Customer-merged-during-submit (Scenario 5):** `services/edits.ts:191-197` rejects with `NotFoundError` when `customer.deletedAt` is set; approval also rejects (`:487-489`).
- **Two salesmen on overlapping routes (Scenario 6):** `services/edits.ts:204-209` enforces `branch.routeId === me.ownedRouteId` per-branch; routes are 1:1 with users so no overlap is structurally possible. The check is per-branch in the same submit, so a multi-branch customer's branches on different routes are correctly each gated to their own salesman.
- **Mandatory-field gate runs (Scenario 12):** `services/edits.ts:323-330` runs for SALESMAN non-draft submits. Photos are read from live customer (`customer.crPhotoId`, etc.), so the partial-photo-upload case (presign OK, attach failed) is caught — `crPhotoId` stays null, gate fails with a clear field key. Verified in `EnrichmentForm`'s mirror at `:136-157`.
- **Field locks at submit (Scenario 13):** Submit and approve both call `isFieldLocked` against current `customer.paymentTerms`. The submit-time check uses the pre-edit value; if the salesman's same submit flips paymentTerms CASH→CREDIT *and* changes legalName, the lock check sees `customer.paymentTerms === 'CASH'` (live) and lets legalName through — which is the right answer (the customer was CASH at submit time). Approval then re-checks; if Steward flipped to CREDIT in the meantime, the legalName change is dropped at approve time. Coverage is good.
- **Phone uniqueness boundary (Scenario 16, but see EL-03 for the leak):** correctly checks `id: { not: customer.id }` so the salesman's own phone isn't a self-collision. Approve re-checks (QA-014 confirmed in code).
- **completenessScore vs mandatory gate (Scenario 17):** `scoreCustomerOnly` weights match the gate fields (legalName, channel/sub-channel, primaryPhone, contactPerson, crNumber, crPhoto). `scoreBranch` weights match (gpsLat/Lng, address≥10, shopPhoto, signboard, dayOfVisit, status). A customer at 100% completeness will pass the mandatory gate. *Note:* the gate requires address ≥ 3 chars but the score requires ≥ 10 chars — a customer at 99% (address length 4) still passes the gate. This is intentional (gate is a hard floor, score adds quality) but worth flagging.
- **Draft key includes customer.id (Scenario 18):** `nmwc:draft:${customer.id}` — confirmed at EnrichmentForm:166. No leak across customers.
- **Multi-branch deleted-branch handling (Scenario 19):** Submit-time `branchById.get` works on live (deletedAt: null) branches. Approve-time `liveBranchIds` filter (services/edits.ts:546-554) drops deleted branches.
- **Phone uniqueness DB-level (post-remediation):** Partial unique index on `Customer.primaryPhoneNorm WHERE deletedAt IS NULL` is in the migration (per remediation report); race collisions hit the DB index.

---

## Recommended priority

**Block launch:**
- EL-01 (customer-level CLOSED bypass) — Critical.
- EL-02 (silent GPS error) — High, will produce 1-day pilot tickets per UAE-edge route.
- EL-03 (cross-region phone leak) — High, undermines the QA-001 segregation work.
- EL-04 (approve-time mandatory gate missing) — High, the very gripe that triggered this audit.

**Fix in week 1 of pilot:**
- EL-05 (audit-log diff missing), EL-06 (draft conflicts), EL-07 (no-changes vs missing-fields), EL-08 (admin photo-rewire), EL-09 (P2002 detection), EL-10 (route-reassign during approval), EL-11/12 (closure-photo freshness vs closure event).

**Backlog:**
- EL-13 (per-branch grouping in queue list), EL-14 (manager region-scope on approval), EL-15 (self-approval), EL-16 (`isFieldLocked` dead param).
