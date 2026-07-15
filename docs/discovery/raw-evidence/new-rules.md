# NMWC Customer Master — Business Rule Catalogue (Section G feed)

System root: `C:\Users\abdulr\Desktop\NMWC-CRM`
Stack: Next.js 15 (App Router, RSC + Server Actions), Prisma 6 / PostgreSQL (Neon), Auth.js v5 (JWT), Cloudflare R2, Zod. Discovery is READ-ONLY; all rules below were verified in code.
Paths are relative to the system root. Confidence tags: [Confirmed]=read in code, [Highly likely], [Possible], [Unknown].

Legend for implementation status: **Fully** / **Partial** / **Frontend-only (bypassable)** / **Backend-only** / **Mentioned-not-implemented** / **Operationally-questionable**.

---

## A. ROLES & GLOBAL SCOPE MODEL

Roles enum: `SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER` — `prisma/schema.prisma:15-21`. [Confirmed]

Scope model (per PRD §4), enforced in `lib/access.ts`:
- SALESMAN — only customers/branches on his single owned route (`User.ownedRouteId`, 1:1). `lib/access.ts:76-80,115-117`. [Confirmed]
- SUPERVISOR — customers on routes owned by his direct reports (`teamRouteIds`). `lib/access.ts:81-84,118-119`. [Confirmed]
- MANAGER — customers/branches in regions he manages (M:N `managedRegions`). **Fail-closed**: empty `managedRegionIds` ⇒ sees NOTHING (RBAC-05-012). `lib/access.ts:85-95,120-122`. [Confirmed]
- STEWARD, VIEWER — all rows (data-ops / read-only). `lib/access.ts:73-75,112-114`. [Confirmed]
- Scope helpers throw `NotFoundError` (not Forbidden) on mismatch to deny an ID-confirmation oracle. `lib/access.ts:12-15,131`. [Confirmed]
- `filterBranchesByScope` trims a visible multi-branch customer's branch array to only branches in caller scope (RBAC-05-001/002/022) so a salesman seeing one branch of Lulu/Carrefour cannot read the other regions' addresses/GPS/photos. `lib/access.ts:107-124`. **Fully**. [Confirmed]

### G-A1 — SCOPE DISCREPANCY (security-relevant) [Confirmed]
The `/customers` LIST page does NOT replicate the Manager fail-closed rule. `app/(app)/customers/page.tsx:77-88`: when a Manager has `managedRegions.length === 0`, `branchSomeBase` stays `undefined` and `baseWhere` remains `{ deletedAt: null }`, so **the customer list query is unscoped and returns every customer** (only the per-card branch subtitle is blanked via `branchInclude.where = { id: '__none__' }`). This contradicts `canSeeCustomer`/export fail-closed (`__none__`) behavior. **Partial / Operationally-questionable** — list scope leak for unscoped Managers. Verify by logging in as a Manager with no `managedRegions`.

---

## B. MANDATORY-FIELD RULES (create/submit completeness gate)

Enforced in `services/edits.ts` `collectMissingMandatory` (`edits.ts:98-187`) and re-run at approve (`edits.ts:739-760`). **Backend Fully**; also mirrored in Zod (`lib/validation/edit.ts`). [Confirmed]

Customer-level mandatory (salesman SUBMIT): `legalName`, `channelId`, `subChannelId`, `primaryPhone`, `contactPerson`, `crNumber`, `crPhotoId` (CR document photo). `edits.ts:139-161`. [Confirmed]
Branch-level mandatory: `address` (≥3 chars), `gpsLat`+`gpsLng`, `dayOfVisit`, `shopPhotoId`, `signboardPhotoId`. `edits.ts:163-184`. [Confirmed]

Rule modifiers:
- Gate applies **only when actor is SALESMAN and not a draft**. Steward/Manager direct-write bypass mandatory gate (may patch a single field on a legacy record). `edits.ts:403-415,738-739`. [Confirmed]
- **Lock-aware skips**: for a salesman, `legalName` is never required of them (always steward-owned) and `crNumber` is skipped when customer is CREDIT — so a salesman is never blocked by data he cannot edit. `edits.ts:127,135-141,154-156`. [Confirmed]
- DRAFT (`isDraft=true`) skips the mandatory gate entirely — partial work allowed. `edits.ts:403`. [Confirmed]
- Photos live OUTSIDE `fieldChanges`; EL-04 re-checks mandatory at APPROVE time against live customer so a salesman deleting a photo between submit and approve triggers `NEEDS_REUPLOAD`. `edits.ts:732-760`. **Fully**. [Confirmed]

---

## C. FIELD-LEVEL LOCKS & EDITING RESTRICTIONS

`lib/permissions.ts isFieldLocked` (`permissions.ts:70-80`). Applies to SALESMAN only; STEWARD bypasses; other non-salesman roles also bypass. [Confirmed]
- `legalName` — **ALWAYS locked for SALESMAN** (any payment terms). Set by Steward at import; salesman can never rename. `permissions.ts:77`. [Confirmed]
- `nmwcCode` — ALWAYS locked (also absent from `CUSTOMER_FIELDS`, so never writable via edit). `permissions.ts:77`; `edits.ts:56-68`. [Confirmed]
- `crNumber`/`crNumberNorm` — locked for SALESMAN **only when customer is on CREDIT**; CASH customers may field-collect a CR. `permissions.ts:78-79`. [Confirmed]
- Locks enforced server-side by deleting locked keys from the proposed patch at submit (`edits.ts:284-289`) and re-evaluated against CURRENT customer state at approve (QA-013: CASH→CREDIT flip between submit/approve drops the locked field). `edits.ts:677-692`. **Fully (backend)**. [Confirmed]
- Salesman may only edit branches on his own route even within a customer he can see (`edits.ts:357-359`). [Confirmed]

Role edit rights (`lib/access.ts canEditCustomer:138-156`): STEWARD & MANAGER edit anything in scope (direct-write); SALESMAN edits own-route branches; **SUPERVISOR & VIEWER cannot edit at all** (supervisor only approves). [Confirmed]

---

## D. APPROVAL WORKFLOW / TIERS / SEPARATION-OF-DUTY

Edit state machine `EditState`: `DRAFT, SUBMITTED, APPROVED, REJECTED, NEEDS_CORRECTION` — `schema.prisma:44-50`. Rejection sets state to `NEEDS_CORRECTION` (not REJECTED). `edits.ts:962`. [Confirmed]

- **Who submits**: SALESMAN (queued for approval) OR STEWARD/MANAGER (direct-write, auto-APPROVED, no queue). Any other role submitting throws. `edits.ts:259-264,420-451`. [Confirmed]
- **One open edit per customer**: blocked in app logic (`edits.ts:266-277`) AND enforced by partial unique index `CustomerEdit_open_per_customer` (`prisma/migrations/20260509150000_qa_remediation/migration.sql:10-14`); P2002 mapped to friendly `EDIT_LOCKED`. **Fully (DB + app)**. [Confirmed]
- **Who approves an enrichment edit** (`canApproveSpecificEdit`, `permissions.ts:125-145`):
  - SUPERVISOR: only if `submittedBy.supervisorId === approver.id` (their own report). [Confirmed]
  - MANAGER: requires region overlap — at least one non-deleted branch of the edited customer is in the Manager's `managedRegionIds`; empty scope ⇒ deny (RBAC-05-003, fail-closed). `permissions.ts:135-142`. [Confirmed]
  - **EL-15 self-approval block**: submitter can NEVER approve/reject own edit, any role. `permissions.ts:134`; also `reactivations.ts:250-253,336-338`. [Confirmed]
- **Atomic claim** on approve: SUBMITTED→APPROVED via `updateMany` guarded by state; loser of a race gets `NOT_PENDING` (PROD-001). `edits.ts:767-780`. [Confirmed]
- **Reject** requires reason 5–1000 chars + category. `edits.ts:925-927`. [Confirmed]
- **Bulk approve/reject**: hard cap 50 edits/call, isolated transactions, per-edit success/failure reporting. `edits.ts:818-913`. [Confirmed]
- Approve writes full `fieldChanges` diff into AuditLog (EL-05) and drops branches deleted/reassigned since submit (QA-039/EL-10). `edits.ts:710-730,785-798`. [Confirmed]

---

## E. STATUS TRANSITIONS (close / reactivate) & PHOTO-EVIDENCE RULES

Customer/Branch status enum: `ACTIVE, CLOSED, SUSPENDED` — `schema.prisma:28-32`. [Confirmed]

- **EL-01 (Critical)**: CLOSED/SUSPENDED transitions are FORBIDDEN through the regular edit form for ALL roles (even Steward/Manager for customer-level). Blocked at submit (`edits.ts:297-311`) and defense-in-depth at approve (`STATUS_BYPASS`, `edits.ts:663-675`). Branch-level status flip through edit form blocked for non-admins only (Steward/Manager may direct-flip branch status). `edits.ts:369-387`. [Confirmed]
- **Mark branch CLOSED** (`markBranchClosedAction`): SALESMAN-only; reason ≥5 chars; requires an attachment that (1) exists & not soft-deleted, (2) captured by this salesman, (3) ≤24h old, (4) captured AFTER `branch.lastStatusChangeAt`, (5) attached to this branch. Creates a SUBMITTED CustomerEdit → Supervisor approves. `services/reactivations.ts:129-215`. [Confirmed]
- **Request reactivation** (`requestReactivationAction`): SALESMAN-only; branch must currently be CLOSED; same 5-part fresh-photo evidence rule; on his route. `reactivations.ts:34-123`. [Confirmed]
- **Approve reactivation**: **MANAGER-only** (`canManageReactivation`, `permissions.ts:52-54`; enforced `reactivations.ts:225`). Manager must manage the branch's region (RBAC-05-008, fail-closed) and cannot approve own request. Branch→ACTIVE, customer→ACTIVE only if ALL its branches active; stamps `lastStatusChangeAt`. `reactivations.ts:224-307`. [Confirmed]
- **Anti-replay**: EL-11/EL-12 photo-freshness anchored to `Branch.lastStatusChangeAt` so a pre-closure photo can't "prove" a reopening. `schema.prisma:322-325`; `reactivations.ts:85-93,178-186`. [Confirmed]
- **NEW-PHOTO-007**: `capturedAt` is taken from R2 `HeadObject.LastModified`, NOT client input, so the 24h freshness gate can't be spoofed. `app/api/photos/finalize/route.ts:74-78,123-124`. **Fully**. [Confirmed]

---

## F. DUPLICATE-DETECTION RULES

`services/duplicates.ts findDuplicateCandidates` (`duplicates.ts:57-159`). STEWARD-only (`requireSteward:20-27`). [Confirmed]
- **No fuzzy matching.** Only two EXACT rules survive (fuzzy name / n-gram / Jaccard removed; phone-only removed as legitimate). `duplicates.ts:36-56,183-184`. [Confirmed]
  1. **CR exact**: same `crNumberNorm` across different live customers, similarity 1.0, ranked first. `duplicates.ts:116-131`. [Confirmed]
  2. **EXACT_TRIPLE**: same `lower(legalName)` + same `primaryPhoneNorm` + same first-branch `regionId`, similarity 1.0. `duplicates.ts:133-150`. [Confirmed]
- **Phone duplicates are ALLOWED** (P1.3): one owner runs many shops on one phone. Partial-unique index on `primaryPhoneNorm` was DROPPED (`prisma/migrations/20260510160000_p1_drop_phone_unique/migration.sql`). Edit/approve only log a soft note on phone collision, never block. `edits.ts:324-341,694-708`. [Confirmed]
- Steward "deemed distinct" dismissal writes AuditLog `entityType='CustomerPair'`, `entityId='aId|bId'`; detector filters dismissed pairs (bidirectional). `duplicates.ts:84-98,296-317`. [Confirmed]
- **Merge** (`mergeCustomersAction`): STEWARD-only (RBAC-05-009 — Manager removed). Steward picks winner; loser's branches + CustomerEdit history reassigned; loser soft-deleted; winner inherits CR photo only if it had none; completeness recomputed. **Cross-region merge requires explicit `confirmCrossRegion=yes` token + reason ≥5 chars** (QA-018). `duplicates.ts:193-294`. [Confirmed]

---

## G. VALIDATION / FORMAT RULES

- **Phone**: canonical `+968XXXXXXXX`; accepts 8 local digits, `968`+8, `00968`+8; converts Arabic-Indic digits; rejects anything else (returns null → validator error, no best-effort junk). `lib/phone.ts:29-64`. Zod regex on edit form: `/^[\d\s\-+()]{7,20}$/`. `lib/validation/edit.ts:12`. [Confirmed]
- **CR number**: normalized = strip whitespace + uppercase ONLY (hyphens/slashes preserved to avoid false dedupe). Max 50 chars. `lib/cr.ts:15-19`; `edit.ts:20-25`. [Confirmed]
- **GPS bounds (PROD-005)**: latitude 16–27, longitude 51–61 (Oman envelope + slack); `gpsAccuracy` 0–10000. `edit.ts:59-69`. [Confirmed]
- **Equipment counts**: coolers 0–100, stands 0–100, empty bottles 0–1000. `edit.ts:76-78`. [Confirmed]
- **Text limits + XSS**: `stripHtml` on all free-text (legalName 2–200, contactPerson 2–200, address 3–500, notes ≤5000). `edit.ts:14,18,42-47`; import stripHtml `services/imports.ts:43-47`. [Confirmed]
- **Formula-injection defense (F-05)**: import rejects cells beginning `= + - @ \t \r` in cust_name/address/contact_person/notes. `imports.ts:54-57,652-657`. [Confirmed]
- **Customer code format**: `NMWC-YYYY-NNNNNN`; branch code `<PARENT>-NN`. `lib/codes.ts:9-18`. [Confirmed] (Note: `formatCustomerCode` never called in customer-master import — import uses the raw `cust_code` from the sheet as `nmwcCode`; the generator is effectively unused for ingestion. `imports.ts:820-833`.) **Operationally-questionable / Mentioned-not-used.**
- **Username**: `^[a-z0-9._-]+$`, 3–50; lowercased. `services/users.ts:29-33`; login canonicalizes lowercase. [Confirmed]
- **Password policy**: min 12 chars (create/reset/self-change/import). `users.ts:35,225`; `imports.ts:225`. No complexity rule beyond length. [Confirmed]

---

## H. FILE-UPLOAD RESTRICTIONS

- **Photos**: MIME whitelist `image/jpeg|png|webp`; max **3 MB** (NEW-PHOTO-005). Enforced at presign (`app/api/photos/presign/route.ts:13-22`) AND at finalize via R2 HeadObject ContentLength (`finalize/route.ts:38-40,103-110`) since a client can re-PUT a different size. Presigned URL expires 600s. **Fully**. [Confirmed]
- **Key binding (QA-005)**: finalize rejects keys not matching the caller's presign prefix `YYYY/MM/DD/<userId>/` (today or yesterday UTC). `finalize/route.ts:17-26,80-85`. [Confirmed]
- **Kind binding (NEW-PHOTO-001)**: `kind` segment parsed from the key path must equal body `kind`; and at attach time slot must match `attachment.kind` (CR/SHOP/SIGNBOARD; FREE accepts any). Prevents sliding a SHOP photo into the CR slot. `finalize/route.ts:33-36,88-92`; `services/photos.ts:98-112`. [Confirmed]
- **Dedupe** by sha256 hash is scoped to the SAME uploader only (cross-user dedupe removed as an oracle). `finalize/route.ts:112-121`. [Confirmed]
- **Excel import**: `.xlsx`, max **5 MB** (MAX_IMPORT_BYTES, zip-bomb defense). `imports.ts:78,97-101,530-534`. [Confirmed]
- **Who attaches photos**: SALESMAN + STEWARD only by design; MANAGER retains a bypass but every Manager attach is audited as `FORCE_OVERRIDE`; SUPERVISOR/VIEWER blocked. `services/photos.ts:73-83,158-159`. [Confirmed]
- **Who detaches**: VIEWER blocked; SALESMAN only own-captured photos; scope-checked via `assertCanAccessAttachment`. `photos.ts:285-291`. [Confirmed]

---

## I. IMPORT RULES (Steward-only master ingestion)

Both imports STEWARD-only (RBAC-05-009; Manager removed to block CHAIN-09). `imports.ts:27-34`. Rate-limited 3/import bucket per steward. [Confirmed]

Account master (Regions/Routes/Users sheets):
- Role whitelist validated; unknown role quarantined. `imports.ts:68,217-224`. [Confirmed]
- **QA-010** password only set on new user OR when `reset_password=yes` col present (+password provided); else existing hash kept. `imports.ts:195-198,347-375`. [Confirmed]
- **QA-011** role change only when `change_role=yes`. `imports.ts:199-202,386`. [Confirmed]
- **F-02 (Critical) privilege-escalation blocks**: (a) cannot change own role via import (id-based self check); (b) cannot CREATE a MANAGER/STEWARD via import; (c) cannot promote/demote any existing MANAGER/STEWARD via import — must use `/users` UI. `imports.ts:232-286`. [Confirmed]
- Password from sheet must be ≥12 chars. `imports.ts:225-228`. [Confirmed]
- Salesman rows require `route_code`; displaced route owners detached + audited REASSIGN (F-18). `imports.ts:301-341`. [Confirmed]

Customer master (single sheet, parse→review→promote):
- Row = one branch; rows sharing `cust_code` → one parent + many branches. `imports.ts:496-509`. [Confirmed]
- **F-04 collision flags**: in-file duplicate phone/CR and master-collision flagged → row QUARANTINED for /duplicates review (not silently promoted). `imports.ts:558-642`. [Confirmed]
- **F-12** payment_terms strict whitelist CASH/CREDIT; unknown value quarantines row (no silent default). `imports.ts:643-651`. [Confirmed]
- **F-17** unknown region/route codes are NOT auto-created — fall back to `UNASSIGNED` route/region with a warning in row issues (blocks phantom-region CHAIN-09). `imports.ts:751-816,875-890`. [Confirmed]
- **F-07** promote claims the batch atomically (READY→PROMOTING via updateMany); per-customer transaction; per-row failures marked REJECTED with safe code (no PII in logs, F-15). `imports.ts:709-923`. [Confirmed]
- Import row states: `PENDING, CLEAN, QUARANTINED, PROMOTED, REJECTED`. `schema.prisma:64-70`. [Confirmed]

---

## J. AUTH / SESSION / ACCOUNT RULES

- JWT strategy, 8h TTL; **freshness re-read every 5 min** reconciles role/disable/revocation. `lib/auth.ts:83,148-218`; `auth.config.ts:14`. [Confirmed]
- **Session revocation (AUTH-12)**: `User.sessionsRevokedAt` bumped on logout/disable/role-change/password-reset; any JWT with `iatMs < sessionsRevokedAt` killed at next freshness check. `auth.ts:190-199`; `users.ts`, `app/actions/auth.ts:77-84`. [Confirmed]
- **Login rate-limit**: per-username AND per-IP token bucket, capacity 5, refill 5/60s (LOGIN_LIMIT). Enforced in BOTH server action and Auth.js `authorize`. Username canonicalized lowercase (AUTH-11) to stop case-variant bucket evasion. `lib/rate-limit.ts:114`; `auth.ts:239-266`; `app/actions/auth.ts:40-55`. [Confirmed]
- **Fail-closed rate-limit backend**: on DB-unreachable, security-critical keys (`login:`, `passwordreset:`) fail CLOSED (deny), non-critical fall back to in-memory. `rate-limit.ts:38-53`. [Confirmed]
- **Timing-equalization (QA-024)**: dummy bcrypt compare on unknown/inactive user; opaque failure reason. `auth.ts:39-40,286-299`. [Confirmed]
- **mustChangePassword (AUTH-09)**: new/reset users forced to `/profile/change-password`; middleware redirects everywhere else. `users.ts:148-149,272-276`; `auth.config.ts:74-85`. [Confirmed]
- **Password reuse (B-15)**: rejects new password matching current or last 5 history hashes; history pruned to 5. `users.ts:264-265,449,487-543`. [Confirmed]
- **User admin guards** (`canMutateUser`, `permissions.ts:152-172`): only MANAGER/STEWARD mutate users; no self-mutation (use /profile); a MANAGER cannot disable/reset/demote another MANAGER or any STEWARD (peer-tier). `users.ts` uses it for toggle/reset/role. [Confirmed]
- **Last-active-Manager guard (AUTH-07)**: cannot disable or demote the only active Manager. `users.ts:200-212,347-359`. [Confirmed]
- **Create user (Manager UI)**: cannot create MANAGER/STEWARD; SALESMAN requires route; route 1:1 uniqueness; supervisorId must be active SUPERVISOR/MANAGER. `users.ts:79-132`. [Confirmed]
- **Role management**: routes/regions Manager-only (`services/routes.ts:17-24`). Duplicate merge/import Steward-only. Export allowed for MANAGER/STEWARD/VIEWER/SUPERVISOR (`services/exports.ts:10-22`, `lib/permissions.ts:39-46`). [Confirmed]

---

## K. EXPORT SCOPING & CRON RULES

- **Export scope (F-01 Critical)**: role scope is INTERSECTED with user filters, never replaced. SUPERVISOR limited to team routes (fail-closed `__none__` if no reports); MANAGER limited to managed regions (fail-closed); STEWARD/VIEWER unrestricted. Row cap 10000. `services/exports.ts:38-116`. [Confirmed]
- Export API authenticates BEFORE parsing (F-21) to avoid schema-probe oracle. `app/api/exports/customers/route.ts:21-51`. [Confirmed]
- **Photo GET**: auth + full scope check (`assertCanAccessAttachment`), soft-deleted→404, per-user rate-limit 60 cap/1-per-sec (NEW-PHOTO-010), CR photos `no-store` (PII). `app/api/photos/[id]/route.ts:21-83`. [Confirmed]
- **Cron auth (photo-gc, keep-warm)**: `Authorization: Bearer $CRON_SECRET`, constant-time compare (B-16). GC tags R2 objects for 30-day lifecycle then deletes DB rows. `app/api/cron/photo-gc/route.ts:30-86`. [Confirmed]

---

## L. COMPLETENESS SCORING (drives dashboards / "mandatory" UI, not a hard gate)

`lib/completeness.ts`. Customer part /40: channel+subChannel 10, primaryPhone 5, contactPerson 5, crNumber 5, crPhoto 10, notes||paymentTerms 5. Branch part /60: GPS 15, address≥10 5, shopPhoto 10, signboardPhoto 10, dayOfVisit 5, any equipment count>0 5, openingHours||deliveryWindow 5, status ACTIVE 5. Customer score = customerPart + avg(branchScores), rounded. Bands: high ≥80, medium ≥50, else low. `completeness.ts:40-95`. [Confirmed]
Note: scoring weights differ from the hard mandatory list in §B (e.g. subChannel is mandatory in §B but shares a bucket in scoring; `notes||paymentTerms` earns points but neither is mandatory). **Operationally-questionable** consistency, not a bug.

---

## M. NOTIFICATION / ESCALATION / SLA RULES

- **No notification subsystem** (no email/SMS/push/in-app-notification model or send calls) found. Reviewers discover work via queue pages (`/approvals`, `/reactivations`, `/work`, `/today`) refreshed by `revalidatePath`. **Mentioned-but-not-implemented / absent.** [Confirmed — by absence: no Notification model in schema; no mailer dependency in package.json.]
- **No SLA / escalation timers** (no due-date, aging-escalation, or auto-reassign logic). `CustomerEdit` has `submittedAt`/`reviewedAt` timestamps only, used for ordering, not SLA. `schema.prisma:352-381`. **Absent.** [Confirmed]
- Keep-warm cron exists purely for cold-start perf, not business notifications. [Confirmed]

---

## N. CONCURRENCY / INTEGRITY RULES (support business rules)

- **Optimistic locking (B-05)**: `Customer.version` / `Branch.version` incremented via versioned `updateMany`; `VERSION_CONFLICT` on mismatch (guards Manager direct-write vs Supervisor approve race). `schema.prisma:264,329`; `edits.ts:503-572`. [Confirmed]
- **Soft delete** everywhere via `deletedAt`; all lookups filter `deletedAt: null`. Attachments use real `deletedAt` column (UXI-008), replacing the old r2Key-rename sentinel. `schema.prisma:278,335,402-406`. [Confirmed]
- **Audit immutability**: `AuditLog` append-only; actions incl. LOGIN/LOGIN_FAIL/LOGOUT/SESSION_REVOKE/FORCE_OVERRIDE/MERGE/REASSIGN/DELETE/PHOTO_VIEW. `schema.prisma:72-91,489-507`. Note: there is **no `EXPORT` audit action** — exports logged under `IMPORT` action with `entityType='Export'` (`exports.ts:179`). **Operationally-questionable** taxonomy. [Confirmed]

---

## O. SECRETS / GIT HYGIENE

- `.env`, `.env.local`, `.env.*.local` are git-ignored; only `.env.example` is tracked (`git ls-files` confirms). No secret values committed. [Confirmed]
- Referenced secret variable names (values NOT read/output): `DATABASE_URL`, `DIRECT_URL` (`schema.prisma:10-11`), `AUTH_SECRET`/`NEXTAUTH_SECRET` (`lib/auth.ts:19`), `R2_ACCOUNT_ID` (`middleware.ts:28`), `CRON_SECRET` (`photo-gc/route.ts:41`), plus R2 access keys in `lib/r2.ts` (not opened). Remediation: keep `.env*` untracked (already), rotate any secret ever pasted into chat, ensure `AUTH_SECRET` passes the entropy guard (`auth.ts:17-32`). No exposure found in tracked files. [Confirmed for git-tracking; R2 key var names not enumerated — verify `lib/r2.ts` if a full secret inventory is needed.]

---

## CONFIRMED FACTS vs INFERENCES vs GAPS

CONFIRMED (read in code): every rule cited above with file:line.
REASONABLE INFERENCES: (1) `/customers` list Manager-empty-region leak (G-A1) reads code paths but not runtime-verified — high confidence from static trace. (2) `formatCustomerCode` unused in ingestion — grep shows only re-export; high confidence.
UNVERIFIED ASSUMPTIONS: none material — all rules traced to enforcing code, not comments/docs.
MISSING INFORMATION: (a) `lib/r2.ts` not opened (R2 secret var names, any client-side region/endpoint rules). (b) PRD documents in `docs/` not cross-checked against code (out of scope; code is source of truth here). (c) Runtime confirmation of the G-A1 scope leak requires a Manager with empty `managedRegions`.
