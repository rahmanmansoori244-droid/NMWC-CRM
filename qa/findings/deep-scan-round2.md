# Deep scan round 2 — confirmed findings

Workflow wf_aa0006af-294 · 7 finders × 3-lens verify + completeness & regression critics · 63 agents.
**16 confirmed**, 2 refuted. Regression critic: the 3 prior P1 fixes are individually correct, no new P1/P2 introduced.

## Fixed this round
- [P1] `lib/customer-filters.ts:274` — Filtered customer export: empty-scope Supervisor can dump any team's customers (fail-closed inverted to fail-open)
- [P2] `services/imports.ts:1084` — Import promote silently overwrites a branch when two rows in one customer group resolve to the same branchCode
- [P2] `services/imports.ts:190` — Account-master Users import reports wrong spreadsheet row numbers after role-sort
- [P2] `app/(app)/duplicates/MergeForm.tsx:30` — Cross-region merge is a permanent dead-end: MergeForm never sends confirmCrossRegion/reason
- [P2] `services/imports.ts:892` — Branch-code composition collides with generated positional codes → silent branch loss within one customer
- [P3] `services/imports.ts:633` — Phone 'invalid format' quarantine reads only row.phone while normalization reads PHONE / Primary Phone headers, so bad p
- [P3] `services/imports.ts:1016` — Customer-master promote never computes completenessScore, leaving all imported customers/branches at 0
- [P3] `services/imports.ts:382` — Account-master re-import silently unlinks a user's supervisor (and route) when the column is blank, with no audit
- [P3] `services/imports.ts:1205` — Promote batch: detail page never revalidated, stale READY view + live Promote button after success
- [P3] `services/imports.ts:872` — F-P02 fallback silently discards a valid region (no warning) when a branch row has a region code but no route code

## Carried (documented, not launch-blocking; fix in first patch window)
- [P2] `services/imports.ts:636` — Re-importing the customer-master export quarantines every multi-branch customer (in-file phone/CR dedup not keyed by cust_code)
- [P2] `services/imports.ts:386` — Password reset via account import does not revoke existing sessions (sessionsRevokedAt not bumped)
- [P3] `services/reactivations.ts:104` — CustomerEdit_open_per_customer partial-unique index makes reactivation / close edits collide with enrichment edits and with each o
- [P3] `app/api/cron/photo-gc/route.ts:62` — photo-gc hard-deletes the Attachment row even when R2 tagging fails, permanently orphaning the object
- [P3] `services/duplicates.ts:277` — Merge leaves the moved CR photo's Attachment.customerId pointing at the soft-deleted loser, breaking a later detach of that photo
- [P3] `app/(app)/reactivations/page.tsx:83` — Reactivation review shows the branch's old shop/signboard photos, never the mandatory fresh evidence

## Full detail (claim/evidence/scenario)

### [P1] Filtered customer export: empty-scope Supervisor can dump any team's customers (fail-closed inverted to fail-open)
**Where:** `lib/customer-filters.ts:274` · FIXED

**Claim:** mergeStringIn() treats an existing empty `{ in: [] }` branch-scope predicate as 'unconstrained' and replaces it with the user-supplied filter. In services/customer-export.ts a SUPERVISOR with zero team routes is scoped with the raw empty array `{ routeId: { in: [] } }` (no '__none__' sentinel, no baseWhere.id guard). Adding any route/supervisor/salesman URL filter therefore OVERRIDES the fail-closed empty scope and exports customers outside the supervisor's team — full PII (phone, contact person, CR number, address, GPS).

**Evidence:** lib/customer-filters.ts:262-277 mergeStringIn: `if (!existing) return { in: next };` then for an object predicate `const prevList = ...existing.in... ; if (prevList.length === 0) return { in: next };` — an empty existing `in` (which in Prisma matches NOTHING) is returned as `{ in: next }`, i.e. the intersection of the empty set with `next` is (wrongly) computed as `next`. Reached from services/customer-export.ts:123-128 SUPERVISOR branch: `const routeIds = meRow.reports.map(r=>r.ownedRouteId).filter(...); branchSomeBase = { routeId: { in: routeIds }, deletedAt: null };` where routeIds can be `[]` and there is NO `baseWhere.id='__none__'` guard (contrast the MANAGER-empty branch at customer-export.ts:134-142 which sets baseWhere.id='__none__', and services/exports.ts:58 which guards the identical Supervisor-empty case with `allowedRouteIds = ['__none__']`). applyCustomerFilters (customer-filters.ts:220-243) builds routeConstraints from filters.routeIds / supervisorId / salesmanId, then `branchSome.routeId = mergeStringIn(branchSome.routeId, intersected)` — with branchSome.routeId = `{ in: [] }` this returns `{ in: intersected }`, defeating scope. requireExportRole (customer-export.ts:41-48) explicitly permits SUPERVISOR.

**Scenario:** A SUPERVISOR account whose reports own no routes (teamRouteIds = [] — a real cutover/hierarchy-setup state) invokes exportFilteredCustomersAction with urlParams='supervisor=<victimSupervisorId>' (or route=<victimRouteId> / salesman=<victimSalesmanId>). branchSomeBase.routeId = { in: [] } is replaced by { in: victimRoutes }, prisma.customer.count/findMany return the victim team's customers, and the action ships an xlsx of out-of-scope customer PII. The customers LIST page is unaffected because app/(app)/customers/page.tsx:74 short-circuits forceEmpty to baseWhere.id='__none__'; only this filtered-export path passes the raw empty `{ in: [] }`.

---

### [P2] Import promote silently overwrites a branch when two rows in one customer group resolve to the same branchCode
**Where:** `services/imports.ts:1084` · FIXED

**Claim:** Within a single custCode group the promote loop never de-duplicates the resolved branchCode, and neither does the parse step. A generated ordinal (custCode-<bi+1>) can equal an explicit composed code (custCode-<NN>) from another row in the same group, or two rows can carry the same explicit branch_code. The branch upsert is keyed on the globally-unique branchCode, so the second colliding row takes the UPDATE path and silently overwrites the first branch's branchName/region/route/address. Both source rows are still marked PROMOTED, so the Steward sees 'N promoted' while one physical branch was lost.

**Evidence:** Generation at services/imports.ts:889-893: `branchCode: rawBranchCode ? (rawBranchCode === ccUpper || rawBranchCode.startsWith(`${ccUpper}-`) ? rawBranchCode : `${ccUpper}-${rawBranchCode}`) : formatBranchCode(custCode, bi + 1)`. formatBranchCode pads to 2 digits (lib/codes.ts:17 `${parentCode}-${String(branchNum).padStart(2,'0')}`), so a blank-branch_code row at position 0 yields 'CUST-01' and a different row carrying explicit branch_code '01' also composes to 'CUST-01'. The branch-steal guard only fires for a DIFFERENT owner (services/imports.ts:1064 `if (branchOwner && branchOwner.customerId !== customerId)`), so a same-customer collision passes through to `await tx.branch.upsert({ where: { branchCode: r.branchCode }, update: {...} })` (services/imports.ts:1084) and the earlier branch's data is replaced. All rows in the group are then set PROMOTED at services/imports.ts:1107-1110. The parse step (services/imports.ts:617-729) builds in-file dup maps for phone and CR only — branch_code is never checked for in-group duplicates.

**Scenario:** A legacy customer sheet lists two distinct branches for custCode 'ACME': row A with an empty branch_code (auto-assigned 'ACME-01') and row B with branch_code '01' (composed to 'ACME-01'). Both parse CLEAN; on promote, row A creates the branch, row B's upsert UPDATEs the same branchCode, overwriting row A's address/region/route with row B's. The customer ends up with one branch instead of two, both rows report PROMOTED, no quarantine.

---

### [P2] Re-importing the customer-master export quarantines every multi-branch customer (in-file phone/CR dedup not keyed by cust_code)
**Where:** `services/imports.ts:636` · carried

**Claim:** The in-file duplicate-phone and duplicate-CR checks flag a row whenever the same normalized phone/CR appears on more than one row in the file, without excluding rows that belong to the SAME customer. Because the customer-master sheet is one-row-per-branch and each branch row repeats the customer-level phone and CR, every customer with 2+ branches has all of its rows quarantined as false-positive duplicates. This defeats the documented re-import round-trip and blocks promotion of legitimate multi-branch customers.

**Evidence:** In-file maps are keyed only by phoneNorm/crNorm across ALL rows (imports.ts:565-583): `phonesInFile.get(phoneNorm)...a.push(i+2)` / `crsInFile.get(crNorm)...a.push(i+2)` — no cust_code. The checks (imports.ts:636-643): `if (phone && phonesInFile.get(phone)!.length > 1) { issues.push({ field: 'phone', message: 'duplicate phone in this file ...' }) }` and the identical CR check. Contrast the master cross-check directly below, which WAS fixed to exclude same-customer rows (imports.ts:639 `(masterPhones.get(phone) ?? []).some((code) => code !== custCode)`, imports.ts:645 same for CR), with the comment at imports.ts:585-589 'Keyed by the OWNING nmwcCode so a row that updates its own customer ... does not self-collide'. The export that produces the re-importable file emits one row per branch with the customer phone/CR repeated: services/exports.ts:118 'We export one row per branch (mirrors import shape)', line 147 `phone: b.customer.primaryPhone ?? ''`, line 138 `cr_no: b.customer.crNumber ?? ''`. Quarantined rows are excluded from promote (promoteCustomerBatchCore reads only `state: ImportRowState.CLEAN`, imports.ts:768-770).

**Scenario:** Steward exports the customer master (exports.ts, ~3k customers at ~1.7 branches each) and re-imports the file. Every customer with ≥2 branches has all its rows marked QUARANTINED with 'duplicate phone in this file' / 'duplicate CR in this file'; promote skips them, so a large fraction of the master silently fails to import and the Steward must manually clear thousands of rows.

---

### [P2] Password reset via account import does not revoke existing sessions (sessionsRevokedAt not bumped)
**Where:** `services/imports.ts:386` · carried

**Claim:** The account-import upsert rotates the password hash when reset_password=yes but never bumps `sessionsRevokedAt` (nor sets `mustChangePassword`). Session revocation in this app is driven exclusively by the `sessionsRevokedAt` marker; the JWT freshness loop compares password state via nothing else. So a password reset performed through the import keeps the target's existing JWT sessions alive until the full 8h TTL, unlike the in-app reset which revokes immediately.

**Evidence:** Import reset path: imports.ts:386 `if (wantsReset) update.passwordHash = passwordHash;` then imports.ts:401-405 `prisma.user.upsert({ where:{username}, update, create:data })` — `update` never includes `sessionsRevokedAt` or `mustChangePassword`. In-app reset does both: services/users.ts:272-279 sets `passwordHash, mustChangePassword: true, sessionsRevokedAt: new Date()`. The only session-kill mechanism after a password change is the marker: lib/auth.ts:190-199 `if (fresh.sessionsRevokedAt && (token.iatMs ?? 0) < fresh.sessionsRevokedAt.getTime()) return null;` — the freshness read (lib/auth.ts:168-208) never compares the password/hash, so without a marker bump the old session persists. (Role changes via import are still reflected because lib/auth.ts:200-206 re-syncs `token.role`; only the password-reset revocation is missing.)

**Scenario:** A user's session is compromised. An admin resets that user's password via the account import (reset_password=yes) to lock the attacker out. Because sessionsRevokedAt is not bumped, the attacker's existing session remains valid for up to 8 hours, and the target is not forced to change the imported password on next login.

---

### [P2] Account-master Users import reports wrong spreadsheet row numbers after role-sort
**Where:** `services/imports.ts:190` · FIXED

**Claim:** The Users sheet is re-sorted by role into `sortedRows` for the two-pass dependency ordering, but the per-row issue messages compute the reported spreadsheet row as `i + 2` where `i` is the index into the SORTED array — not the physical sheet row. Every quarantine/reject message for a Users row therefore points the Steward at the wrong line. (Regions and Routes iterate their unsorted `.rows` so only the Users sheet is affected.)

**Evidence:** Line 184: `const sortedRows = [...usersSheet.rows].sort((a, b) => { ... order.indexOf(ra) - order.indexOf(rb); });` then line 190: `for (const [i, row] of sortedRows.entries()) {` and every issue push uses the sorted index, e.g. line 213 `row: i + 2`, line 221 `row: i + 2`, line 227/257/263/292/305/311/etc. Because the sheet is sorted MANAGER→STEWARD→SUPERVISOR→SALESMAN→VIEWER, the row physically at sheet line 6 can become `sortedRows[0]` and be reported as "row 2". The messages carry no username (e.g. line 214 'username, full_name, role required', line 305 'salesman needs route_code'), so the (wrong) row number is the Steward's only locator. Contrast Regions (line 128 `regionsSheet.rows.entries()`) and Routes (line 151 `routesSheet.rows.entries()`) which iterate the original order and report correctly.

**Scenario:** A 40-user onboarding sheet has an invalid `route_code` for the salesman on physical sheet row 30. After the role-sort that row lands at sortedRows index 25, so the quarantine issue reports "Users row 27". The Steward edits the user on sheet row 27 (a different, valid user), re-imports, and the real row-30 error persists — misdirected remediation on the org-provisioning import.

---

### [P2] Cross-region merge is a permanent dead-end: MergeForm never sends confirmCrossRegion/reason
**Where:** `app/(app)/duplicates/MergeForm.tsx:30` · FIXED

**Claim:** The duplicate-merge UI can never complete a cross-region merge. The CR-number duplicate detector (services/duplicates.ts) groups purely by crNumberNorm with no region constraint, so two customers holding the same CR in different regions ARE surfaced on /duplicates. When the Steward clicks 'Keep ←/→', mergeCustomersCore detects the region mismatch and throws a ValidationError demanding confirmCrossRegion=yes + a reason — but MergeForm's merge() only ever puts winnerId and loserId into the FormData, and the page only passes aId/bId/labels. There is no UI field for the confirmation or reason, so the Steward is stuck on an error that names a parameter (confirmCrossRegion=yes) they cannot supply. Cross-region duplicate customers can never be resolved through the app and continue to propagate to Temix.

**Evidence:** MergeForm.tsx:30-32 builds the FormData with only winner/loser: `const fd = new FormData(); fd.set('winnerId', winnerId); fd.set('loserId', loserId);` — no confirmCrossRegion/reason ever set. duplicates page.tsx:61-66 renders `<MergeForm aId={c.a.id} bId={c.b.id} aLabel=... bLabel=... />` (no reason/confirm inputs). services/duplicates.ts:205 `const confirmCrossRegion = String(formData.get('confirmCrossRegion') ?? '') === 'yes';` (always false). services/duplicates.ts:226-234 `const isCrossRegion = [...loserRegions].some((r) => !winnerRegions.has(r)) || [...winnerRegions].some((r) => !loserRegions.has(r)); if (isCrossRegion && !confirmCrossRegion) throw new ValidationError({ _form: 'Cross-region merge requires explicit confirmation (confirmCrossRegion=yes) and a reason.' });`. services/duplicates.ts:117-132 CR grouping is region-agnostic (`byCr.get(c.crNumberNorm)`), and a single multi-branch customer spanning two regions also trips isCrossRegion.

**Scenario:** Two customers with the same CR number in regions MUSCAT and DHOFAR (or one multi-region customer + a single-region one) appear as a CR-match pair on /duplicates → Steward clicks 'Keep ←' → mergeCustomersAction returns ok:false with 'Cross-region merge requires explicit confirmation (confirmCrossRegion=yes) and a reason.' → MergeForm shows that text via setMsg → Steward has no field to set it → merge is impossible; the duplicate persists forever.

---

### [P2] Branch-code composition collides with generated positional codes → silent branch loss within one customer
**Where:** `services/imports.ts:892` · FIXED

**Claim:** The F-P01 fix composes a bare sheet branch code into `${custCode}-${code}` (imports.ts:889-892), which now shares the SAME globally-unique branchCode namespace as `formatBranchCode(custCode, position)` used for codeless rows (imports.ts:893 -> lib/codes.ts:17 `${parentCode}-${padded2}`). For a single customer whose master rows mix an explicit bare 2-digit code (e.g. '03') with codeless rows, the composed code `X-03` can equal the positional code `X-03` produced for a codeless row at ordinal position 3. The two resolvedBranches entries then upsert the same branchCode: the first CREATEs the branch, the second finds it (same customerId, so the cross-customer steal guard at imports.ts:1064 does NOT fire) and UPDATEs/overwrites it (imports.ts:1084-1104). Net: two distinct sheet branches collapse into one row, silently dropping one branch's address/region/route. branchCode is @unique (schema.prisma:354) and there is no in-group dedup before the upsert loop. Before this fix a bare '03' stayed bare ('03') and did not collide with 'X-03', so the fix widened the collision surface from pre-composed sheet codes to bare codes.

**Evidence:** imports.ts:889-893 `branchCode: rawBranchCode ? rawBranchCode === ccUpper || rawBranchCode.startsWith(`${ccUpper}-`) ? rawBranchCode : `${ccUpper}-${rawBranchCode}` : formatBranchCode(custCode, bi + 1)`; lib/codes.ts:16-18 `return `${parentCode}-${String(branchNum).padStart(2, '0')}``; imports.ts:1060-1068 owner guard only throws when `branchOwner.customerId !== customerId` (same-customer collision passes through); imports.ts:1084-1104 `tx.branch.upsert({ where: { branchCode: r.branchCode }, update: {...}, create: {...} })`; prisma/schema.prisma:354 `branchCode String @unique`.

**Scenario:** Customer X master rows: Row1 branch_code='03' (bare), Row2 blank, Row3 blank. Composition: Row1->'X-03'; Row2 (bi=1)->formatBranchCode(X,2)='X-02'; Row3 (bi=2)->formatBranchCode(X,3)='X-03'. Row1 and Row3 both resolve to 'X-03'. Loop upserts 'X-03' (create, Row1 data) then upserts 'X-03' again (update, Row3 data overwrites Row1). Customer X ends with 2 branches instead of 3; Row1's location is silently lost. No error, row marked PROMOTED.

---

### [P3] CustomerEdit_open_per_customer partial-unique index makes reactivation / close edits collide with enrichment edits and with each other (all share customerId + state=SUBMITTED); the reactivation/close paths create without translating P2002, so a legitimate second branch action returns a misleading "refresh and try again" that no refresh fixes
**Where:** `services/reactivations.ts:104` · carried

**Claim:** The partial unique index `CustomerEdit_open_per_customer` covers ALL SUBMITTED CustomerEdit rows with a non-null customerId — enrichment UPDATE edits, reactivation edits, and close edits all qualify (reactivation/close set customerId=branch.customerId and state=SUBMITTED). So a customer can have at most ONE open edit of ANY type. requestReactivationCore and markBranchClosedCore call prisma.customerEdit.create(...) directly with no P2002 try/catch (unlike submitEditCore which translates it to a friendly EDIT_LOCKED at edits.ts:522-538). A collision therefore falls through to runAction's generic P2002 handler (lib/errors.ts:140-147) and surfaces "This value conflicts with an existing record. Refresh and try again." — misleading, because the conflict is a different branch's or a different-lane edit and refreshing never clears it. This blocks reactivating two branches of one multi-branch customer concurrently, and blocks a branch close/reactivation while any enrichment edit is pending (and vice versa).

**Evidence:** prisma/migrations/20260509150000_qa_remediation/migration.sql:12-15:
  CREATE UNIQUE INDEX "CustomerEdit_open_per_customer"
    ON "CustomerEdit"("customerId")
    WHERE "state" = 'SUBMITTED' AND "customerId" IS NOT NULL;
services/reactivations.ts:104-130 creates a SUBMITTED edit with `customerId: branch.customerId` (line 108) and no P2002 handling; markBranchClosedCore does the same at 208-231. Contrast submitEditCore's create wrapped in try/catch translating P2002→ConflictError('EDIT_LOCKED', ...) (edits.ts:522-538). runAction converts untranslated P2002 to code 'UNIQUE_CONSTRAINT' / "conflicts with an existing record. Refresh and try again." (lib/errors.ts:140-147).

**Scenario:** A retail chain reopens two outlets of one customer. Salesman submits reactivation for branch B1 (SUBMITTED, customerId=C). Salesman then submits reactivation for branch B2 of the same customer C: the create violates CustomerEdit_open_per_customer (both rows customerId=C, state=SUBMITTED) → P2002 → user sees "conflicts with an existing record, refresh and try again", which never resolves until B1's reactivation is fully decided.

---

### [P3] Phone 'invalid format' quarantine reads only row.phone while normalization reads PHONE / Primary Phone headers, so bad phones under those headers are silently dropped
**Where:** `services/imports.ts:633` · FIXED

**Claim:** In the customer-master import the format-validation gate tests `phoneRaw` derived from `row.phone` alone, but the value actually normalized and stored is derived from `row.phone ?? row.PHONE ?? row['Primary Phone']`. When the sheet uses the 'PHONE' or 'Primary Phone' header, `phoneRaw` is empty so the `isValidPhoneFormat` check is skipped; a malformed phone under that header then normalizes to null and is stored as null with the row marked CLEAN — the source phone is silently lost with no quarantine flag. (Conversely, a valid but dot-separated phone under the `phone` header is falsely quarantined, since PHONE_REGEX in lib/phone.ts:56 omits '.' while normalizePhone strips it.)

**Evidence:** services/imports.ts:625 `const phoneRaw = String(row.phone ?? '').trim();` then services/imports.ts:626-628 `const phone = normalizePhone(String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null);` and the gate at services/imports.ts:633 `if (phoneRaw && !isValidPhoneFormat(phoneRaw)) { issues.push({ field: 'phone', message: 'invalid format' }); }`. Because the gate keys on phoneRaw (row.phone only), an invalid value present solely under `PHONE`/`Primary Phone` bypasses the quarantine and falls through to a null store.

**Scenario:** A steward uploads a master workbook whose header is 'Primary Phone'. A row has a mistyped 6-digit phone. row.phone is undefined so phoneRaw='' and the invalid-format check is skipped; normalizePhone('123456') returns null (lib/phone.ts:53), so the customer is imported CLEAN with primaryPhone = null and the steward is never told the phone was rejected.

---

### [P3] photo-gc hard-deletes the Attachment row even when R2 tagging fails, permanently orphaning the object
**Where:** `app/api/cron/photo-gc/route.ts:62` · carried

**Claim:** The GC tags the R2 object for lifecycle expiry and then unconditionally hard-deletes the DB row, even when the tagging call threw. On a transient R2 failure (network/5xx, not a real 404) the object is never tagged — so the lifecycle rule never expires it — yet the DB row (and its r2Key) is deleted, so the object can never be reclaimed. This is an unbounded storage leak on any transient R2 error, not just already-missing objects.

**Evidence:** photo-gc/route.ts:43-60 tags in a try/catch that only increments `r2Errors` and logs on failure ('R2 may already be missing — that's fine'). Then photo-gc/route.ts:61-66 runs `await prisma.attachment.delete({ where: { id: c.id } })` regardless of whether the tag succeeded. The tag is not a delete — the object relies on the `gc-marked` tag + a lifecycle rule to expire (comment line 42 'tagged for R2 lifecycle expiry instead of hard-delete'); if the tag was never written, the object is immortal and now untracked.

**Scenario:** R2 returns a transient 500/timeout for one PutObjectTaggingCommand during the nightly sweep. r2Errors is incremented, the DB row is still deleted, and that object stays in R2 forever with no DB reference and no lifecycle tag — accumulating on every such failure.

---

### [P3] Merge leaves the moved CR photo's Attachment.customerId pointing at the soft-deleted loser, breaking a later detach of that photo
**Where:** `services/duplicates.ts:277` · carried

**Claim:** When the winner has no CR photo, the merge moves the loser's crPhotoId onto the winner but never updates that Attachment's own `customerId` field (still = loser). detachPhotoCore clears the slot by matching `customer.id = att.customerId AND crPhotoId = att.id`; since att.customerId is the loser (whose crPhotoId was nulled during merge), the clear matches 0 rows. The photo is soft-deleted but winner.crPhotoId is left dangling, over-counting completeness by +10 until the 30-day GC hard-delete (FK SetNull) eventually self-heals it.

**Evidence:** duplicates.ts:277-283 moves only the pointer: `if (!winner.crPhotoId && loser.crPhotoId) { tx.customer.update({winner, crPhotoId: loser.crPhotoId}); tx.customer.update({loser, crPhotoId: null}); }` — Attachment.customerId is not updated. detachPhotoCore keys the slot-clear on the attachment's own customerId: services/photos.ts:326-331 `if (att.customerId) { tx.customer.updateMany({ where: { id: att.customerId, crPhotoId: att.id }, data: { crPhotoId: null } }) }`. After merge att.customerId=loser and loser.crPhotoId=null, so this updates 0 rows and photos.ts:344 still soft-deletes the attachment. scoreCustomerOnly adds 10 whenever crPhotoId is non-null (lib/completeness.ts:46) regardless of the attachment's deletedAt.

**Scenario:** Steward merges customer B (has CR photo) into A (no CR photo); A.crPhotoId now points at B's photo whose customerId is still B. A Steward later detaches that CR photo from A: the photo is soft-deleted but A.crPhotoId is not cleared, so A shows a filled-but-dead CR slot and an inflated completeness score for up to 30 days.

---

### [P3] Customer-master promote never computes completenessScore, leaving all imported customers/branches at 0
**Where:** `services/imports.ts:1016` · FIXED

**Claim:** The promote transaction upserts customers and branches but never calls scoreCustomer/scoreBranch, so every imported (or refreshed) customer and branch keeps completenessScore = 0 (the schema default) even when the imported data would score higher. The stored score is what the minScore/maxScore filters, exports, and completeness dashboards read, so the whole imported dataset reports 0% until each row is individually edited (edits/merge/reactivation are the only paths that recompute).

**Evidence:** A grep of services/imports.ts for scoreCustomer/scoreBranch/completenessScore returns no matches; the promote customer upsert (imports.ts:1017-1047) and branch upsert (imports.ts:1084-1104) set no completenessScore. Every other write path recomputes: applyEditChanges (edits.ts:661-671), merge (duplicates.ts:319-328), reactivation (reactivations.ts:317-330), finalize (create-finalize.ts:296-335). The stored column drives filters/exports: exports.ts:91-102 uses `customerWhere.completenessScore` for min/maxCompleteness, and lib/completeness.completenessBand keys off the stored value.

**Scenario:** Steward imports the initial master (or a Temix refresh). A customer whose imported data would score ~15 (phone + contact + CR) is stored at 0; a minScore=10 filter excludes it and the data-quality dashboard reports it as 0% until a salesman's first edit triggers a recompute.

---

### [P3] Account-master re-import silently unlinks a user's supervisor (and route) when the column is blank, with no audit
**Where:** `services/imports.ts:382` · FIXED

**Claim:** On an existing-user upsert the `update` payload unconditionally sets `supervisor`/`ownedRoute` to `{ disconnect: true }` whenever the row's `supervisor_username`/`route_code` cell is blank. Password and role are explicitly protected from silent overwrite (QA-010 `wantsReset`, QA-011 `wantsRoleChange`) but the supervisor link — which drives approval routing — is not, and no AuditLog row is written for the change. A partial re-import that omits `supervisor_username` therefore silently severs `submittedBy.supervisorId`.

**Evidence:** Lines 382-383: `supervisor: supervisorId ? { connect: { id: supervisorId } } : { disconnect: true }, ownedRoute: ownedRouteId ? { connect: { id: ownedRouteId } } : { disconnect: true },`. `supervisorId` is null whenever `supUsername` (line 204) is empty. The audit block (lines 407-430) only writes rows for `existing && wantsReset` and `existing && wantsRoleChange` — never for a supervisor/route change, so the unlink is unaudited. Downstream impact: `resolveStepAudience` SUPERVISOR_OF_SUBMITTER returns `[]` for a null supervisorId (lib/notifications.ts:38-39) and `canApproveSpecificEdit`'s SUPERVISOR branch is `submittedBy.supervisorId === user.id` (lib/permissions.ts:147) which is false once null — so the salesman's UPDATE edits can no longer be approved/notified via their supervisor, only via the region-Manager fallback.

**Scenario:** Steward re-imports a corrected Users sheet to fix a few phone numbers; the sheet's `supervisor_username` column is left blank for the untouched salesmen. Every such salesman is silently detached from their supervisor with no audit trail, and their pending enrichment edits stop appearing in / notifying that supervisor's queue.

---

### [P3] Promote batch: detail page never revalidated, stale READY view + live Promote button after success
**Where:** `services/imports.ts:1205` · FIXED

**Claim:** promoteCustomerBatchAction runs on /import/[batchId] (where PromoteButton lives) but only calls revalidatePath('/import') — the list route, not the current detail route — and PromoteButton does no router.refresh() on success. After a successful promote the detail page keeps rendering status READY and the 'Promote N clean rows' button (which the page gates on batch.status === 'READY'), even though the batch is now PROMOTED. The client only appends a '✓ Promoted N rows' message. No data corruption occurs (the F-07 atomic READY→PROMOTING claim rejects a second click), but the stale UI invites a confusing re-click and misrepresents batch state until a hard navigation.

**Evidence:** services/imports.ts:1205 `revalidatePath('/import');` is the only revalidation in promoteCustomerBatchCore (no `/import/${batchId}`). PromoteButton.tsx:25-34 on `res.ok` only does `setMsg('✓ Promoted ...')` — no router.refresh()/replace. import/[batchId]/page.tsx:42-43 renders the button only when `batch.kind === 'CUSTOMER' && batch.status === 'READY'`, so a revalidated detail page WOULD correctly hide it — but that route is never invalidated.

**Scenario:** Steward opens /import/<id> (status READY) → clicks Promote → action promotes rows, sets batch PROMOTED, revalidates only /import → button shows '✓ Promoted 42 rows' but the READY subtitle and Promote button remain → Steward clicks again → action re-reads batch (now PROMOTING/PROMOTED), F-07 claim count=0, returns 'Batch is in state PROMOTED — only READY batches can be promoted.'

---

### [P3] Reactivation review shows the branch's old shop/signboard photos, never the mandatory fresh evidence
**Where:** `app/(app)/reactivations/page.tsx:83` · carried

**Claim:** QA-008 forces a salesman to capture a fresh (<=24h, post-status-change, on-branch) photo to request reactivation, and the server records it in edit.attachmentChanges as a FREE/extra attachment (branchExtraId) — it does NOT touch branch.shopPhotoId/signboardPhotoId. But the Manager's review page renders e.branch.shopPhotoId and e.branch.signboardPhotoId, i.e. the branch's PRE-existing photos, and never reads the evidence attachment from attachmentChanges. So the manager approving the reactivation never sees the fresh proof the shop reopened. For the common case of import-created customers (no branch photos captured), both <img> conditionals are false and the review shows ZERO photo evidence, defeating the human-review purpose of the evidence control (only the automated freshness/location checks remain).

**Evidence:** reactivations page.tsx:83-98 renders `{e.branch?.shopPhotoId && <img src={`/api/photos/${e.branch.shopPhotoId}`} .../>}` and the same for signboardPhotoId — the branch select (lines 35-43) fetches shopPhotoId/signboardPhotoId but not attachmentChanges. services/reactivations.ts:126-128 stores the evidence as `attachmentChanges: [{ kind: att.kind, attachmentId: att.id, action: 'EVIDENCE' }]`. BranchStatusActions.tsx:110-114 captures it via `<PhotoCaptureSlot kind='FREE' ... attachTo={{ kind: 'branch', branchId, slot: 'FREE' }} />`, and photos.ts:239-244 wires a FREE slot to branchExtraId/branchId with kind FREE, leaving branch.shopPhotoId untouched.

**Scenario:** An imported customer's branch (branch.shopPhotoId = null) is marked closed, then a salesman submits a reactivation with a fresh storefront photo → the photo is stored as a FREE attachment on the edit → Manager opens /reactivations → both <img> conditionals are null → the manager sees the reason text but no photo at all → approves 'blind' to the evidence the workflow required.

---

### [P3] F-P02 fallback silently discards a valid region (no warning) when a branch row has a region code but no route code
**Where:** `services/imports.ts:872` · FIXED

**Claim:** The F-P02 rewrite resolves region strictly from the route: when `route` is null it forces both to the UNASSIGNED pair (imports.ts:872-875). If a branch row carries a VALID regionCode but an ABSENT routeCode, `region` is found (so no 'region not found' warning at imports.ts:846), `route` is null but no 'route not found' warning fires because `p.routeCode` is falsy (imports.ts:852 guard is `p.routeCode && !route`). The else-branch then assigns the branch to the UNASSIGNED region+route, silently discarding the valid region, and groupResolveErrors stays empty so the row surfaces NO warning to the Steward (the warning block at imports.ts:1113-1130 only runs when groupResolveErrors is non-empty). Before the fix this same input set regionId=<valid> + routeId=UNASSIGNED, which the B-19 region==route trigger would reject and abort the group (loud). The fix trades a loud abort for a silent region downgrade with no audit flag.

**Evidence:** imports.ts:843-854 `const region = p.regionCode ? await ... : null; if (p.regionCode && !region) push('region not found'); const route = p.routeCode ? await ... : null; if (p.routeCode && !route) push('route not found');`; imports.ts:864-875 `if (route) {...} else { effectiveRouteId = unassignedRoute!.id; effectiveRegionId = unassignedRoute!.regionId; }`; imports.ts:1113 `if (groupResolveErrors.length > 0 && !refreshedRow)` gates the only Steward-visible warning.

**Scenario:** Branch row: region_code='DHOFAR' (valid), route_code blank. region resolves, route is null, no error pushed. Branch is created in the UNASSIGNED region/route; the valid DHOFAR assignment is dropped with no warning in the import row issues, so the Steward has no signal to re-assign it.

---

