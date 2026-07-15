# OLD (ICO Customer Portal) — Functional Reverse-Engineering & User Journeys

System root: `C:\Users\abdulr\Desktop\ICO\customer-portal`
Stack: Next.js 14.2.5 (App Router), NextAuth 4.24.7 (Credentials/JWT), Prisma 5.16.1, bcryptjs, Tailwind. Feeds Section C/D.

Confidence tags: [Confirmed]=read in code, [Highly likely], [Possible], [Unknown].

---

## 1. Access & Authentication

- **Login page**: `app/(auth)/login/page.tsx` — client form (react-hook-form + zod `loginSchema` email/password) calls `signIn('credentials', {redirect:false})` then routes to `callbackUrl` (default `/dashboard`). [Confirmed L11-49]
- **Auth callback / credential verification**: `lib/auth.ts` `authOptions.providers[CredentialsProvider].authorize` [Confirmed L41-98]:
  - lowercases+trims email; **rate-limits** via `takeRateLimitToken` — Bucket A `(ip:email)` 5/15min, Bucket B `ip` 30/15min (`lib/auth.ts:59-70`, DB-backed `RateLimitAttempt`).
  - `prisma.user.findUnique({email})`; rejects if `!user || !user.isActive`.
  - **Password hashing**: `bcrypt.compare(password, user.passwordHash)` — bcrypt, cost 12 on create (`app/api/admin/users/route.ts:109`). [Confirmed]
  - Generic error `'Invalid credentials.'` (no user enumeration). [Confirmed]
- **Session**: JWT strategy, `maxAge = 8h` (re-login daily). JWT + session callbacks copy `id, role, depotId, supervisorId` into the session. Secret = `process.env.NEXTAUTH_SECRET`. [Confirmed L100-127]
- **Route protection**: `middleware.ts` — no token → API returns JSON 401, pages redirect to `/login?callbackUrl=`. `/admin/*` requires `token.role === 'ADMIN'` else redirect `/dashboard`. Matcher covers dashboard/requests/customers/admin/notifications + most `/api/*`. [Confirmed]
  - **Gap [Confirmed]**: middleware matcher does NOT include `/api/auth`, `/api/health`, `/api/blob`, `/api/files`, `/api/cron`. Cron routes self-guard via `x-cron-secret`/`CRON_SECRET` (`app/api/cron/sla-check/route.ts:9-11`). Every API route ALSO re-checks `getServerSession` server-side, so middleware is defence-in-depth not sole gate.

## 2. Roles (5) & Permission Matrix

Role enum: `types/index.ts:1` = `SALESMAN | SUPERVISOR | ACCOUNTANT | ADMIN | ROUTEPRO`. Schema stores `User.role` as free `String` (`prisma/schema.prisma:55`) — **not a DB enum** [Confirmed]; enforced only in code/zod (`createUserSchema` `app/api/admin/users/route.ts:23`).

Helpers in `lib/permissions.ts` [Confirmed]:
| Capability | Rule (file:line) |
|---|---|
| Create request | SALESMAN or ADMIN only (`app/api/requests/route.ts:100`) |
| View request | ADMIN=all; SALESMAN=own `salesmanId`; SUPERVISOR=own `supervisorId`; ACCOUNTANT=own depot AND status ∈ ACCOUNTANT_VISIBLE_STATUSES (`canViewRequest` L46-67) |
| Edit draft | statuses DRAFT/RETURNED_BY_SUPERVISOR/RETURNED_BY_ACCOUNTANT; ADMIN or owning SALESMAN (`canEditDraft` L72-85) |
| Approve/Return/Reject (supervisor stage) | SUPERVISOR matching `supervisorId`, status PENDING_SUPERVISOR or WARNING_POSSIBLE_DUPLICATE; ADMIN always (`canSupervisorAct` L90-101) |
| Confirm-Temix/Return/Reject (accountant stage) | ACCOUNTANT, same depot, `accountantId===user.id` OR null (fallback), status PENDING_ACCOUNTANT; ADMIN always (`canAccountantAct` L111-120) |
| Activate RoutePro | ADMIN or ROUTEPRO, status PENDING_ROUTEPRO (`canActivateRoutePro` L126-132) |
| Cancel | ADMIN only, not if ACTIVE_IN_ROUTEPRO/CLOSED/CANCELLED (`canCancel` L137-145) |
| Upload master / manage users / activation-queue / escalate | ADMIN only (`canUploadMaster`,`canManageUsers`; `app/api/admin/*`) |
| List scoping | `buildRequestScopeFilter` L165-186; customer-master scoping `resolveCustomerScopeRouteCodes` L201-221 |

ROUTEPRO scope: only PENDING_ROUTEPRO/ACTIVE_IN_ROUTEPRO (`buildRequestScopeFilter` L179-184). [Confirmed]

## 3. Status/State Machine (full)

17 statuses (`types/index.ts:9-26`, labels `lib/constants.ts:78`). Transitions traced to the exact route performing each:

| From | To | Route / file:line | Actor |
|---|---|---|---|
| — | DRAFT | `POST /api/requests` (route.ts:187,244) | Salesman/Admin |
| DRAFT / RETURNED_BY_SUPERVISOR / RETURNED_BY_ACCOUNTANT | PENDING_SUPERVISOR **or** WARNING_POSSIBLE_DUPLICATE **or** BLOCKED_EXACT_DUPLICATE | `POST /submit` (submit/route.ts:88-99) — chosen by dup risk | Salesman |
| DRAFT/RETURNED_* | (unchanged DRAFT) | `PATCH /api/requests/[id]` resets to DRAFT, `duplicateRisk=NONE` (route.ts:124-131) | Salesman edit |
| PENDING_SUPERVISOR / WARNING_POSSIBLE_DUPLICATE | PENDING_ACCOUNTANT (normal) **or** PENDING_ROUTEPRO (minor UPDATE_EXISTING) | `POST /approve` (approve/route.ts:52-57) | Supervisor |
| PENDING_SUPERVISOR / WARNING | RETURNED_BY_SUPERVISOR | `POST /return` (return/route.ts:62-64) | Supervisor |
| PENDING_SUPERVISOR / WARNING | REJECTED_BY_SUPERVISOR | `POST /reject` (reject/route.ts:62-64) | Supervisor |
| PENDING_ACCOUNTANT | PENDING_ROUTEPRO (+temixCode) | `POST /confirm-temix` (confirm-temix/route.ts:63) | Accountant |
| PENDING_ACCOUNTANT | RETURNED_BY_ACCOUNTANT | `POST /return` (return/route.ts:64) | Accountant |
| PENDING_ACCOUNTANT | REJECTED_BY_ACCOUNTANT | `POST /reject` (reject/route.ts:64) | Accountant |
| PENDING_ROUTEPRO | ACTIVE_IN_ROUTEPRO | `POST /activate-routepro` (activate-routepro/route.ts:62-63) | Admin/RoutePro |
| PENDING_SUPERVISOR/WARNING (SLA) | ESCALATED | cron `POST /api/cron/sla-check` (sla-check/route.ts:42) | System |
| ANY | any of 13 valid targets | `POST /api/admin/requests/[id]/escalate` (escalate/route.ts:78-84) | Admin force-transition |

- **All transitions use optimistic concurrency**: `updateMany({where:{id,status:currentStatus}})` + `count===0 ⇒ 409` (e.g. submit/route.ts:104-157, approve L60-88). [Confirmed]
- **Dead/legacy statuses**: `SUBMITTED`, `APPROVED_BY_SUPERVISOR`, `CREATED_IN_TEMIX` are defined & displayed but never SET by the current workflow (`lib/constants.ts:354 LEGACY_STATUSES`). Approve goes PENDING_SUPERVISOR→PENDING_ACCOUNTANT directly; confirm-temix goes PENDING_ACCOUNTANT→PENDING_ROUTEPRO directly (skips CREATED_IN_TEMIX). [Confirmed]
- **No terminal auto-CLOSE**: nothing sets CLOSED except admin escalate. ACTIVE_IN_ROUTEPRO is effective terminal. [Confirmed]

## 4. New-Customer Creation Journey (NEW_MAIN / NEW_BRANCH / NO_CR)

1. **Create draft** `POST /api/requests` (route.ts:93-259). Server zod `createRequestSchema` (`lib/validators/request.ts:13-95`). **Mandatory fields**: type, customerName(≥2), contactPerson(≥2), primaryPhone(regex 7-20), channel∈CHANNELS, subChannel (must belong to channel via superRefine L82-89), address(≥3), dayOfVisit∈DAYS_OF_VISIT. Conditional: `crNumber` required unless NO_CR/UPDATE_EXISTING (L56-62); `parentTemixCode` required for NEW_BRANCH (L65-71). HTML-stripped via `stripHtml` preprocess. [Confirmed]
2. **Routing resolution at create** (route.ts:118-185): finds salesman's active Route → supervisor/accountant/depot; falls back to `user.supervisorId`/`user.depotId`. Accountant chosen deterministically: route.accountantId → `Depot.primaryAccountantId` → oldest active depot accountant (L143-167). Verifies supervisor still active (L134-141). **Rejects (422)** if non-UPDATE request can't resolve supervisor+depot+accountant (L173-179). [Confirmed]
3. **Ghost-draft guard**: reuses a DRAFT with same salesman+name+phone created <15s ago (route.ts:227-241). RequestNumber via `RequestSequence` upsert in a transaction (L243-256). [Confirmed]
4. **Photos** uploaded separately `POST /api/requests/[id]/photos` (types SHOP/SIGNBOARD/CR).
5. **Submit** `POST /api/requests/[id]/submit`. Server enforces (submit/route.ts:47-73): GPS lat/lng present (except PHOTOS_ONLY update); SHOP+SIGNBOARD photos (except GPS_ONLY); CR photo for non-NO_CR non-update; supervisor assigned. Then `checkDuplicates` → sets BLOCKED_EXACT_DUPLICATE / WARNING_POSSIBLE_DUPLICATE / PENDING_SUPERVISOR; writes StatusHistory + DuplicateMatch rows; notifies supervisor (only if not blocked). [Confirmed]
6. **Supervisor** approve → PENDING_ACCOUNTANT (must pass `supervisorOverrideDuplicate` if risk POSSIBLE; cannot approve EXACT — approve/route.ts:33-49). [Confirmed]
7. **Accountant** confirm-temix: enters `temixCode` + `MAIN|BRANCH` → PENDING_ROUTEPRO; unique-index race → 409 (confirm-temix/route.ts:83-91). Notifies all admins. [Confirmed]
8. **Admin/RoutePro** activate-routepro → ACTIVE_IN_ROUTEPRO; notifies salesman. [Confirmed]

### CRITICAL FINDING — portal never writes the customer record
`CustomerMaster` is mutated ONLY by master-file upload (`app/api/master/upload/route.ts:111,118`) and seed. **No approval/confirm-temix/activate step creates or updates a `CustomerMaster` row** (grep of `customerMaster.(create|update|upsert)` returns only upload+seed). Temix & RoutePro are EXTERNAL systems; the portal only *records* that an accountant manually created the customer in Temix (stores `temixCode` on the request) and that admin activated it. The customer master reappears in the portal only on the next master upload (which flips all rows `isActive=false` then re-upserts — upload/route.ts:111). [Confirmed] — This is the core architecture: the portal is a *workflow/approval tracker*, not the master-data system of record.

## 5. Existing-Customer Modification Journey (UPDATE_EXISTING)

- Requires `existingTemixCode` (validators L74-79). `updateCategory` drives approval path via `UPDATE_CATEGORIES` (`lib/constants.ts:292-364`).
- **Two paths**: `SUPERVISOR_ONLY` categories (`CONTACT_INFO, LOCATION_ADDRESS, GPS_ONLY, PHOTOS_ONLY`) bypass accountant → supervisor approve jumps straight to PENDING_ROUTEPRO and stamps `accountantActedAt` (approve/route.ts:52-70). `FULL` categories (`CHANNEL_ROUTE, EQUIPMENT, FULL_CORRECTION`) take normal accountant path. [Confirmed]
- Duplicate check is **skipped** for UPDATE_EXISTING (`lib/duplicate-check.ts:21-24`). GPS/photo submit rules relaxed per category (submit/route.ts:42-66). `changesSummary` = JSON of field diffs (schema comment L190-191). Activate-routepro reads temix code from `existingTemixCode` fallback (activate-routepro/route.ts:39-43). [Confirmed]
- **Absent**: no actual write-back of the changed fields to `CustomerMaster`; the change is only described in `changesSummary`/`temixNote` for a human to apply in Temix. [Confirmed]

## 6. Journey Presence Classification

| Journey | Presence | Evidence |
|---|---|---|
| NEW customer creation | **Exists** (full 4-stage workflow) | routes §4 |
| EXISTING modification | **Exists** (tiered 2-path) | §5, constants UPDATE_CATEGORIES |
| CASH customer | **Partial** — modeled as `NO_CR` type (no CR, stricter GPS/photo, CR photo skipped) not an explicit "cash/credit" flag | `REQUEST_TYPE_CONFIG.NO_CR` constants.ts:206-211; submit L63 |
| CREDIT customer | **Absent/Implicit** — no `paymentTerms`/credit-limit field anywhere in schema; "credit" only implied by having a CR. No credit approval logic | schema `CustomerRequest` has no credit field [Confirmed] |
| Individual vs Corporate | **Absent** — no legal-type/entity-type field; only `channel/subChannel` classification | schema; constants CHANNELS |
| Customer branches | **Exists** — `NEW_BRANCH` type + `parentTemixCode` | constants.ts:200-205; validators L65-71; dup-check branch handling L48-59 |
| Temporary/Inactive customer | **Partial** — `CustomerMaster.isActive` + `pendingUpdate` flags exist; no request-level "temporary customer" journey | schema.prisma:103-104 |
| Rejected/Suspended | **Partial** — REJECTED_BY_SUPERVISOR/ACCOUNTANT terminal statuses exist (no re-open path except admin escalate); no "suspended customer" concept | reject routes; escalate |

## 7. Notifications & Audit

- In-app `Notification` rows only (`lib/notifications.ts`): submitted→supervisor; approved→salesman/accountant; returned/rejected→salesman; temix-created→all admins; routepro-activated→salesman; SLA breach→admins. Email (`lib/email.ts` + nodemailer) present but SMTP unconfigured in env. [Confirmed]
- **Workflow audit** = `StatusHistory` rows on every transition (fromStatus,toStatus,changedById,reason,notes). **Admin audit** = `AdminAuditLog` for user create/update/deactivate, master upload, escalate, force-transition (`lib/audit-log.ts`, schema L300-316). [Confirmed]
- **SLA**: supervisor 8 working-h, accountant 9 working-h (`lib/constants.ts:225-227`); hourly cron flags `*SlaBreached` and auto-ESCALATES supervisor breaches (sla-check/route.ts). [Confirmed]

## 8. Error Handling
- Validation errors → `apiError` 400 with joined zod messages. AuthZ → 403. Not found → 404. Concurrency → 409. Unroutable account → 422. Notification failures are caught & logged, never block the transition (e.g. approve/route.ts:101). [Confirmed]

## 9. SECURITY FINDINGS
- **`.env` is COMMITTED to git** with REAL secrets. `git ls-files` lists `.env` (only `.env*.local` is git-ignored — `.gitignore`). First committed in `3761c02`. Contains:
  - `NEXTAUTH_SECRET` = `hjT…` (len 43, redacted) — **live session-signing secret leaked**.
  - `CRON_SECRET` = `b04…` (len 64 hex, redacted) — **cron auth secret leaked** (protects `/api/cron/*`).
  - `DATABASE_URL` = `fil…` (`file:./dev.db`, SQLite).
  - **Remediation**: rotate NEXTAUTH_SECRET & CRON_SECRET immediately; `git rm --cached .env`; add `.env` to `.gitignore`; purge from history (git-filter-repo/BFG); move secrets to a secret manager/Vercel env.
- **Schema/env mismatch [Confirmed]**: `schema.prisma:6` datasource is `postgresql` but `.env DATABASE_URL="file:./dev.db"` (SQLite) and `prisma/dev.db` exists — dev runs SQLite while schema targets Postgres. Verify prod actually uses Postgres; SQLite-specific behavior (e.g. `mode:'insensitive'` unsupported on SQLite) may differ.
- `User.role` is an unconstrained `String` (no DB enum) — integrity depends entirely on the zod allow-list; a raw DB write could inject an arbitrary role. [Confirmed]

## 10. Facts vs Inference vs Missing
- **CONFIRMED FACTS**: everything cited with file:line above (auth, permission helpers, all state transitions, validators, the no-CustomerMaster-write architecture, committed `.env`).
- **REASONABLE INFERENCES**: "cash"=NO_CR and "credit"=has-CR (semantic, not a stored flag); middleware is defence-in-depth because every route re-authorizes.
- **UNVERIFIED ASSUMPTIONS**: production DB is Postgres (env says SQLite); email actually delivers (SMTP blank); RoutePro/Temix integrations are 100% manual (no API client found — grep only shows manual code entry).
- **MISSING INFORMATION**: no automated tests read here for behavioral confirmation of edge transitions; frontend field-level required markers not audited line-by-line (server zod is authoritative and was read); whether prod `.env` differs from committed one.
