# OLD System (ICO Customer Portal) — Business Rule Catalogue (Section G feed)

System root: `C:\Users\abdulr\Desktop\ICO\customer-portal`
Stack: Next.js 14 App Router, Prisma 5.16 (`provider = postgresql` in schema, but `.env` points to SQLite `file:./dev.db` — MISMATCH, see §Q), NextAuth (JWT credentials), Zod. All API routes server-side session-gated via `middleware.ts` + per-route `getServerSession`.

Confidence tags: [Confirmed]=read in code, [Highly likely], [Possible], [Unknown].

---

## A. REQUEST TYPES & MANDATORY / CONDITIONAL FIELDS

Request types: `NEW_MAIN`, `NEW_BRANCH`, `NO_CR`, `UPDATE_EXISTING` (`lib/constants.ts:190-218`; enum enforced `lib/validators/request.ts:14`).

**Base mandatory fields (Zod, both draft-save and submit)** — `lib/validators/request.ts:13-53` [Confirmed, Backend-enforced]:
- `customerName` min2/max200; `contactPerson` min2/max200; `primaryPhone` regex+min7; `channel` must be a key of CHANNELS; `subChannel` min1; `address` min3/max500; `dayOfVisit` must be in DAYS_OF_VISIT enum.
- All string inputs pass `stripHtml` preprocess (XSS strip) `request.ts:6-11`.

**Conditional / cross-field rules** (`superRefine` `request.ts:54-95`) [Confirmed, Backend]:
- CR number REQUIRED when `type !== NO_CR && type !== UPDATE_EXISTING` (i.e. NEW_MAIN, NEW_BRANCH) — `request.ts:56-62`.
- `parentTemixCode` REQUIRED for `NEW_BRANCH` — `request.ts:65-71`.
- `existingTemixCode` REQUIRED for `UPDATE_EXISTING` — `request.ts:74-80`.
- `subChannel` must belong to the selected `channel`'s allowed list — `request.ts:82-89` (channel→subchannel map `constants.ts:5-47`).

**NOTE — draft vs submit mandatory-field gap**: The same `createRequestSchema` is used for POST create (`app/api/requests/route.ts:111`) and PATCH edit (`app/api/requests/[id]/route.ts:88`). There is NO looser "draft" schema — so ALL base+conditional field rules are enforced even to save a DRAFT. GPS is the only field deferred to submit time (comment `request.ts:91-94`). [Confirmed]

**Request numbering**: `NMWC-{year}-{000000}` 6-digit zero-padded, per-year sequence via `RequestSequence` upsert inside a transaction — `lib/utils.ts:32-36`, `app/api/requests/route.ts:243-256`. [Confirmed]

---

## B. GPS RULES (format, bounds, capture) [Confirmed]

- Zod bounds: `gpsLat` [-90,90], `gpsLng` [-180,180] — `request.ts:39-40`. No Oman-specific geofence (any global coordinate accepted). [Confirmed]
- GPS presence required at SUBMIT, not at draft save: enforced in TWO places — `submitRequestSchema` refine `request.ts:99-105`, AND the submit route `app/api/requests/[id]/submit/route.ts:49-53`. [Confirmed, Backend]
- **GPS-must-be-device-captured ("cannot be typed manually") is FRONTEND-ONLY** — enforced only in the `GPSCapture` component via `navigator.geolocation` (`components/forms/GPSCapture.tsx:35-72`; UI copy line ~103). The API accepts any lat/lng/accuracy/capturedAt in the JSON body (`route.ts:207-210`) with no proof-of-capture. **Bypassable** — a client can POST arbitrary coordinates. [Confirmed — security-relevant]
- GPS relaxations for UPDATE_EXISTING: `PHOTOS_ONLY` skips GPS; `GPS_ONLY` requires GPS — `submit/route.ts:44-53`. [Confirmed]

---

## C. PHOTO / FILE-UPLOAD RULES [Confirmed]

Upload endpoint `app/api/requests/[id]/photos/route.ts`:
- Allowed photo types: `SHOP`, `SIGNBOARD`, `CR` (`route.ts:9`). Type must be one of these (`:100-104`).
- Max size 10 MB (`:10`, `:114-116`); zero-byte rejected (`:110-112`).
- Client MIME pre-check against `image/jpeg,jpg,png,webp,heic` (`:11`,`:119-121`), THEN **server-side magic-byte verification** `detectMimeType()` (`:23-63`, `:124-134`) — cannot trust `file.type`. [Confirmed, Backend — strong]
- No explicit max photo COUNT; each type upserts/replaces existing of same type (`:137-160`) → effectively 1 per type. [Confirmed]
- Photos only uploadable when status ∈ {DRAFT, RETURNED_BY_SUPERVISOR, RETURNED_BY_ACCOUNTANT} (`:88-91`) and only by the owning salesman or admin (`:83-85`). [Confirmed]

**Photo-required-at-submit rules** (`submit/route.ts:56-70`) [Confirmed, Backend]:
- SHOP + SIGNBOARD required for all except `GPS_ONLY` updates (`:57-64`).
- CR photo required when `!UPDATE_EXISTING && type !== NO_CR` (`:67-70`).
- Frontend duplicates these checks (`app/(dashboard)/requests/new/page.tsx:352-356,404-415`) — redundant, backend is authoritative.

**Master-file upload** (`app/api/master/upload/route.ts`): admin-only (`:24-26`); max 20 MB (`:17`,`:44`); XLSX/XLS/CSV only (`parseFile` `:270-300`); column validation per type (`lib/validators/master.ts`). [Confirmed]
**Bulk user upload** (`app/api/admin/users/bulk/route.ts`): admin-only; MAX_ROWS 200 (`:14`,`:73-75`). [Confirmed]

---

## D. DUPLICATE-CHECK ALGORITHM (`lib/duplicate-check.ts`) [Confirmed — read in full]

Thresholds (`:7-8`): `EXACT_NAME_THRESHOLD = 0.85`, `POSSIBLE_NAME_THRESHOLD = 0.70`.
Name similarity = **Levenshtein-based**: `1 - dist/maxLen` on normalized names (`lib/utils.ts:79-87`); `normalizeName` lowercases, strips non-`\p{L}\p{N}\s` (Unicode-aware, Arabic-safe), collapses spaces (`utils.ts:42-50`). Phone normalize strips separators (`:52-54`); CR normalize uppercases+strips spaces (`:93-96`).

Checked against BOTH `CustomerMaster` (Temix export) and pending `CustomerRequest`s (`pendingStatuses` list `:152-162`). Logic:
- `UPDATE_EXISTING` → checks SKIPPED entirely, returns NONE (`:21-24`). [Confirmed]
- **CR + name ≥0.85** in master → EXACT for NEW_MAIN/NO_CR (blocks); but NEW_BRANCH → only POSSIBLE ("intentional branch", warns) (`:47-72`). [Confirmed]
- Same CR, name <0.85 → POSSIBLE ("may be different channel") (`:73-85`).
- Name ≥0.70 without CR → POSSIBLE; candidate prefetch uses **first-4-chars prefix filter** `normalizedName contains substring(0,4)`, take 50 (`:91-101`) — **fuzzy-match recall gap**: names differing in first 4 chars (typos, Arabic/EN variants) are never compared. [Confirmed — operationally-questionable]
- Phone match = **last-8-digits `contains`** in master (`:122-146`) and exact last-8 equality in pending (`:233-250`) → POSSIBLE. [Confirmed]
- Pending-request CR match: EXACT only if name≥0.85 AND `type===NEW_MAIN` (`:186-200`).
- Result sorted EXACT-first then similarity desc, capped 20 (`:255-261`).

Submit maps risk→status (`submit/route.ts:88-99`): EXACT→`BLOCKED_EXACT_DUPLICATE`, POSSIBLE→`WARNING_POSSIBLE_DUPLICATE`, NONE→`PENDING_SUPERVISOR`. [Confirmed]
On-demand check endpoint `app/api/requests/duplicate-check/route.ts`: SALESMAN/ADMIN only (`:23-25`), rate-limited 60/min/user (`:28-36`). [Confirmed]

---

## E. APPROVAL WORKFLOW / TIERS / STATUS TRANSITIONS [Confirmed]

Statuses defined `constants.ts:78-184` (17 statuses). Two-tier approval: Supervisor → Accountant → RoutePro activation.

Transition map (from action routes):
1. **Submit** (salesman/admin, from DRAFT/RETURNED_*) → duplicate-gated to BLOCKED / WARNING / PENDING_SUPERVISOR (`submit/route.ts:34-99`).
2. **Approve** (supervisor) `approve/route.ts`: from PENDING_SUPERVISOR or WARNING_POSSIBLE_DUPLICATE → PENDING_ACCOUNTANT; **EXCEPT** minor UPDATE_EXISTING categories → straight to PENDING_ROUTEPRO (accountant bypassed) (`:56-63`).
   - EXACT duplicate cannot be approved (`:33-35`, 422).
   - POSSIBLE duplicate requires `supervisorOverrideDuplicate=true` else 422 (`:47-49`). Override reason stored (`approveRequestSchema` `request.ts:107-111`). [Confirmed]
3. **Confirm-Temix** (accountant) `confirm-temix/route.ts`: PENDING_ACCOUNTANT → PENDING_ROUTEPRO; records `temixCode`+`temixCreationType` (MAIN|BRANCH) (`request.ts:122-128`); temixCode unique → P2002 caught as 409 (`:60-97`). [Confirmed]
4. **Activate-RoutePro** (ADMIN or ROUTEPRO role) `activate-routepro/route.ts`: PENDING_ROUTEPRO → ACTIVE_IN_ROUTEPRO. Requires effective temix code (`temixCode ?? existingTemixCode`) (`:44-46`). [Confirmed]
5. **Reject** `reject/route.ts`: stage decided by STATUS not role (`:64-68`) → REJECTED_BY_SUPERVISOR or REJECTED_BY_ACCOUNTANT. Reason min10/max1000 (`request.ts:113-115`). Terminal (no re-open path except admin escalate). [Confirmed]
6. **Return** `return/route.ts`: → RETURNED_BY_SUPERVISOR / RETURNED_BY_ACCOUNTANT; salesman edits & resubmits. Reason min10 (`request.ts:117-120`). [Confirmed]

**Update-category approval routing** (`constants.ts:292-364`) [Confirmed]:
- `approvalPath` per category. SUPERVISOR_ONLY (bypass accountant): `CONTACT_INFO`, `LOCATION_ADDRESS`, `GPS_ONLY`, `PHOTOS_ONLY`. FULL (needs accountant): `CHANNEL_ROUTE`, `EQUIPMENT`, `FULL_CORRECTION`. Authoritative list derived `SUPERVISOR_ONLY_CATEGORIES` `constants.ts:361-364`, imported by approve route (fixes ISSUE-009 hardcode).

**Correction count**: PATCH increments `correctionCount` when editing from a RETURNED_* status (`[id]/route.ts:120-135`); resets duplicate flags to NONE on edit. No max-corrections cap enforced. [Confirmed]

**Concurrency**: every transition uses `updateMany({where:{id,status:currentStatus}})` optimistic guard → `count===0` yields 409 "already acted on" (e.g. `submit/route.ts:157-159`, `approve:83-85`). [Confirmed — good]

---

## F. RECORD OWNERSHIP, EDITING RESTRICTIONS, FIELD LOCKS [Confirmed]

`lib/permissions.ts`:
- Ownership/VIEW (`canViewRequest` `:46-67`): ADMIN=all; SALESMAN=own (`salesmanId===user.id`); SUPERVISOR=assigned (`supervisorId===user.id`); ACCOUNTANT=depot-scoped AND status ∈ ACCOUNTANT_VISIBLE_STATUSES (`:4-12`).
- EDIT draft (`canEditDraft` `:72-85`): only status ∈ {DRAFT,RETURNED_BY_SUPERVISOR,RETURNED_BY_ACCOUNTANT}, and only owning SALESMAN or ADMIN. Enforced in PATCH (`[id]/route.ts:82-84`) and photo upload. [Confirmed]
- Supervisor act (`canSupervisorAct` `:90-101`): role SUPERVISOR + `supervisorId===user.id` + status PENDING_SUPERVISOR/WARNING.
- Accountant act (`canAccountantAct` `:111-120`): role ACCOUNTANT + depot match + (`accountantId===user.id` OR unassigned) + status PENDING_ACCOUNTANT. L3 fix closes first-click-wins race.
- RoutePro activate (`canActivateRoutePro` `:126-132`): ADMIN or ROUTEPRO + PENDING_ROUTEPRO.
- Cancel (`canCancel` `:137-145`): ADMIN only; not if ACTIVE/CLOSED/CANCELLED. **No API route wires this** — cancel appears unimplemented server-side (only admin escalate can set CANCELLED). [Highly likely gap]
- **No explicit field-level lock list** in OLD (unlike NEW's legalName lock). Locking is coarse: whole record editable only in draft/returned states. [Confirmed]

---

## G. USER-ROLE RESTRICTIONS & DEPOT/ROUTE SCOPING [Confirmed]

Roles: SALESMAN, SUPERVISOR, ACCOUNTANT, ADMIN, ROUTEPRO (`createUserSchema` `admin/users/route.ts:23`). Role is free-string in DB (`schema.prisma:55`), validated only at write-time.

- Only SALESMAN/ADMIN create requests (`app/api/requests/route.ts:100-102`). [Confirmed]
- List scoping `buildRequestScopeFilter` (`permissions.ts:165-186`): SALESMAN=own; SUPERVISOR=supervised; ACCOUNTANT=depot+assigned/unassigned+visible-status; ROUTEPRO=PENDING/ACTIVE_ROUTEPRO only; unknown role → `__NO_ACCESS__`. User-supplied filters AND-merged so they can't widen scope (`requests/route.ts:33-55`). [Confirmed — good]
- Customer-master scoping `resolveCustomerScopeRouteCodes` (`permissions.ts:201-221`): ADMIN=all; SALESMAN=own route codes; SUPERVISOR/ACCOUNTANT=depot route codes; other=none. Applied in `/api/customers`, `/api/customers/[temixCode]`, `/api/customer-master/lookup`. [Confirmed]
- Middleware (`middleware.ts`): unauth → 401 (API) / login redirect (pages); `/admin/*` pages require role ADMIN (`:22-24`). API admin routes independently re-check `isAdmin` (defense-in-depth). [Confirmed]
- **Depot/accountant routing** on request create (`requests/route.ts:118-185`): resolves supervisor/depot/accountant from active Route → user fields → Depot.primaryAccountantId → oldest active depot accountant. Rejects create (422) if NEW_* lacks supervisor/depot/accountant; UPDATE_EXISTING needs only supervisor+depot (`:169-185`). [Confirmed]

---

## H. CASH-vs-CREDIT / CREDIT-LIMIT / REQUIRED DOCS

- **No cash-vs-credit field, no credit-limit logic, no payment-terms anywhere.** Grep of schema/lib/api shows none. The only "cash" reference is descriptive text for NO_CR type ("Valid cash customer without CR", `constants.ts:208-210`). [Confirmed — MISSING / not modelled]
- Required documentation per type is expressed only as photo requirements (§C): CR photo for NEW_MAIN/NEW_BRANCH; SHOP+SIGNBOARD for all on-site. No trade-license/VAT/bank-doc concepts. [Confirmed]
- No tax/VAT number field or validation. CR number is the only regulatory identifier; validated only as `max(50)` string + normalize (no CR format/checksum). [Confirmed]

---

## I. VALIDATION FORMATS [Confirmed]

- Phone: regex `/^[\d\s\-\+\(\)]{7,20}$/` (`request.ts:4`) — 7–20 chars of digits/space/-/+/(); no country-code/Oman-specific check. Alternate phone optional. [Confirmed]
- Email (users): `z.string().email()` (`admin/users/route.ts:14`). [Confirmed]
- Password: min8 + regex `(?=.*[a-z])(?=.*[A-Z])(?=.*\d)` (upper+lower+digit) — enforced on POST/PATCH/bulk user (`admin/users/route.ts:17-22`, `[id]/route.ts:16-24`, `bulk/route.ts:18`). Hash bcrypt cost 12. [Confirmed]
- CR: `max(50)` only + normalize uppercase/strip-space. No format validation. [Confirmed]
- Dates: `dayOfVisit` restricted to Sat–Fri enum (`constants.ts:64-72`); `gpsCapturedAt` accepted as arbitrary string→Date. [Confirmed]
- No GPS geofence to Oman bounds (see §B). [Confirmed]

---

## J. SLA / ESCALATION RULES [Confirmed]

- Supervisor SLA = 8 working hours; Accountant SLA = 9 working hours (`constants.ts:225-227`). [Confirmed]
- Working calendar: WORK_DAYS default `0,1,2,3,4,6` (Sun–Thu + Sat, **Friday excluded**), hours 08:00–17:00, all env-overridable (`lib/sla.ts:4-10`). Working-hour math in `advanceOneWorkingHour`/`slaDeadline`/`isSlaBreached` (`sla.ts:28-127`). [Confirmed]
- SLA check is a **cron endpoint** `app/api/cron/sla-check/route.ts` (POST, hourly) protected by `x-cron-secret`/Bearer == `CRON_SECRET` (`:9-12`). [Confirmed]
- Supervisor breach → sets `supervisorSlaBreached=true` AND force-status `ESCALATED` + admin notification (`sla-check:47-73`). Accountant breach → sets `accountantSlaBreached=true` + notify, but does NOT change status (`:98-119`). Asymmetry. [Confirmed]
- Admin manual escalate/force-transition `app/api/admin/requests/[id]/escalate/route.ts`: ADMIN-only; can force any of 13 target statuses; reason min10; audited (`REQUEST_FORCE_TRANSITION`). [Confirmed]

---

## K. NOTIFICATION RULES [Confirmed]

- All workflow notifications are **in-app DB rows only** (`lib/notifications.ts:14-24` → `prisma.notification.create`). notify* wrappers: submitted→supervisor; approved→salesman; returned/rejected→salesman; pending-review→accountant; temix-created→all admins (`getAdminIds` `:166`); routepro-activated→salesman; sla-escalation→admins. [Confirmed]
- **Email NOT wired to workflow**: `lib/email.ts` (nodemailer) exists but `notifications.ts` never imports/calls it. SMTP_USER/PASS blank in env. → Email notifications = Mentioned-but-not-implemented for the request lifecycle. [Confirmed]
- Notification read endpoints: `/api/notifications`, `/[id]/read`, `/read-all`. [Confirmed]

---

## L. CUSTOMER-MASTER WRITE-BACK (operational gap) [Highly likely]

On approval/activation the portal **does not update the `CustomerMaster` row** with new GPS/contact/photos. `CustomerMaster.pendingUpdate`/`lastPortalUpdateAt` fields exist (`schema.prisma:104-105`) but no route sets them; GPS/photos for a customer are read back by JOINing `CustomerRequest` where status=ACTIVE_IN_ROUTEPRO (`app/api/customers/[temixCode]/route.ts:60-90`). So "Temix" and "RoutePro" updates are **manual/out-of-band** — the portal only records that the accountant/admin should perform them (temixNote text `constants.ts`). [Confirmed the code path; Temix/RoutePro are external systems — no integration.]

---

## M. SECURITY-RELEVANT / BYPASSABLE

1. **Committed secrets**: `.env` is git-TRACKED (`git ls-files` shows `.env`; `.gitignore` only ignores `.env.local`). Contains real-looking values:
   - `NEXTAUTH_SECRET="hjT..."` (redact: `hjT…`)
   - `CRON_SECRET="b04..."` (redact: `b04…`)
   Remediation: `git rm --cached .env`, add `.env` to `.gitignore`, rotate both secrets. [Confirmed — HIGH]
2. **GPS device-capture is frontend-only** → spoofable coordinates (§B). [Confirmed]
3. **DB provider mismatch** (§Q) — rate-limiter uses Postgres `ON CONFLICT` raw SQL (`lib/rate-limit.ts:31-40`) which fails on SQLite and **fails OPEN** (`:52-56`) → login/dupcheck rate limits silently disabled if run on the SQLite dev.db. [Confirmed — operationally-questionable]
4. Frontend-only field requiredness (CR `*`, GPS `*`, photo `required`) all have backend equivalents — not bypassable for those. [Confirmed]

---

## N. CONFIRMED vs INFERENCE vs MISSING

- CONFIRMED (read in code): all rules cited above with file:line.
- REASONABLE INFERENCE: cancel flow unimplemented (canCancel has no route); email deliberately deferred.
- MISSING/NOT MODELLED: cash-vs-credit, credit limits, payment terms, tax/VAT numbers, CR format validation, GPS geofence, per-field lock lists, max-correction cap, Temix/RoutePro system integration (all manual).
- UNVERIFIED: whether cron is actually scheduled (Vercel cron config in `vercel.json`/`.github` not opened this pass) — verify by reading `vercel.json`.

## Q. Environment note
`prisma/schema.prisma:6` declares `provider = "postgresql"` but `.env`/`.env.local` set `DATABASE_URL="file:./dev.db"` (SQLite) and `prisma/dev.db` exists. Postgres-specific features used: `mode:'insensitive'` search, `ON CONFLICT` raw SQL. This mismatch means either prod uses a real Postgres (env overridden at deploy) or the app is mis-wired; several rules (rate limit, case-insensitive search/dedupe) degrade on SQLite. Verify the deployed `DATABASE_URL`.
