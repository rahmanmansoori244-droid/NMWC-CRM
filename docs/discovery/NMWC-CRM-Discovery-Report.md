# NMWC CRM — Discovery & Understanding Report

**Prepared for:** National Mineral Water Company SAOG (NMWC)
**Phase:** 1 — Discovery, reverse-engineering and assessment (no integration, no code change)
**Date:** 2026-07-15
**Scope:** Two existing customer-management codebases, analysed read-only.
**Method:** Static source analysis of both repositories (no live database/credentials available; nothing was run). 17 independent deep-analysis passes across architecture, data, workflows, business rules, security and technical debt, cross-checked against a first-hand reading of both Prisma schemas, manifests, git histories and hand-off docs.

**Confidence legend (used throughout):** `[Confirmed]` = read directly in code · `[Highly likely]` · `[Possible]` · `[Unknown]`.
**Traceability:** significant findings cite `file:line`. Exhaustive per-dimension evidence is preserved in [`docs/discovery/raw-evidence/`](raw-evidence/) (17 files).
**Secret handling:** no secret value is reproduced; secrets are referenced by location only, masked after the first 3 characters.

---

## The two systems at a glance

| | **OLD — "ICO Customer Portal"** | **NEW — "NMWC Customer Master"** |
|---|---|---|
| Folder | `C:\Users\abdulr\Desktop\ICO\customer-portal` | `C:\Users\abdulr\Desktop\NMWC-CRM` |
| Purpose | New-customer **registration / approval workflow** | Existing-customer **master-data enrichment / cleanup** |
| Core entity | `CustomerRequest` (a request that a human will action in the ERP) | `Customer` + `Branch` (the editable master itself) |
| Customer key | `temixCode` | `nmwcCode` |
| Stack | Next 14.2.5, React 18, Prisma 5.16, NextAuth 4 | Next 15, React 19, Prisma 6.19, Auth.js 5 (beta) |
| DB | PostgreSQL declared / **SQLite in every env file** (mismatch) | PostgreSQL on Neon (clean) |
| Storage | Vercel Blob (+ broken S3 branch) | Cloudflare R2 (presigned, hash-dedupe) |
| Roles | Salesman, Supervisor, **Accountant**, Admin, RoutePro | Salesman, Supervisor, **Manager**, **Steward**, Viewer |
| Status | git HEAD `3d6217e`, last work ~2026-04-17, **stalled** | git HEAD `c612c79`, **live pilot** at `nmwc-cm.vercel.app` |

---

## Section A — Executive Summary

**1. What each system does.**
The OLD system (**ICO Customer Portal**) is a **new-customer onboarding pipeline**. A salesman drafts a customer request; it passes a duplicate check, then flows Salesman → Supervisor → **Accountant** (who records the ERP "Temix" code) → Admin/**RoutePro** (final activation). Crucially, the portal **never writes the customer master itself** — `customerMaster.create/update/upsert` appears only in the bulk file-upload path and seed (`app/api/master/upload/route.ts:111,118`) `[Confirmed]`. Temix and RoutePro are external systems; the portal is an **approval ledger** that records that a human performed those steps elsewhere.

The NEW system (**NMWC Customer Master**) is a **field-driven master-data cleanup tool** over a pre-loaded ~3,000-record master. It **is** the system of record for enrichment: approved edits write directly to `Customer`/`Branch` with optimistic locking (`services/edits.ts:503-572`) `[Confirmed]`. It has **no manual customer-creation path** — `prisma.customer.create` appears only in seed/migration; real creation is Steward Excel import → promote (`services/imports.ts:700`) `[Confirmed]`.

**2. The single most important finding.** These are **not two versions of one product; they are two halves of the customer lifecycle.** OLD onboards customers into an external ERP but never persists the master. NEW maintains the master but cannot onboard a net-new customer from the field. **Neither system alone covers the full lifecycle**, and "newer = better" is therefore the wrong lens — the correct question is which system is the stronger *foundation* and what must be ported onto it.

**3. How complete each system is.** NEW is a hardened, deployed pilot: real Postgres enums, replayable migrations, DB CHECK constraints and triggers, immutable audit, session revocation, R2 photo integrity, Sentry + structured logging, and a documented remediation trail (a 63-finding QA audit and a 25-bug senior audit, largely closed — `docs/QA-AUDIT-REPORT.md`, `docs/audit/`). OLD is a competent MVP that reached a "pre-launch hardened" state and then **stalled ~3 months ago**; it is **not cleanly deployable as-is** because its schema declares PostgreSQL while every env file points at SQLite, and its migration history is non-replayable.

**4. Most serious risks (headlines).**
- **Two committed-secret exposures, both live-system, both CRITICAL.** OLD commits `.env` to git with a live `NEXTAUTH_SECRET` (JWT signing key → full session/admin forgery) and `CRON_SECRET` (`old-security.md` J-C1) `[Confirmed]`. NEW commits **plaintext shared weak passwords for all 13 pilot users — including the highest-privilege STEWARD role** — in `docs/PILOT-MUSCAT-CREDENTIALS.md` and `scripts/bulk-reset-credentials.ts`, with forced-rotation disabled (`new-security.md` C-1) `[Confirmed]`. Both must be treated as permanently burned and rotated regardless of the consolidation decision.
- **Both flagship rate-limiters are non-functional in production.** OLD's fails **open** on any DB error and breaks on its committed SQLite target. NEW's Postgres path **always returns "granted"** — `granted` is derived from a token count clamped at ≥0, so it can never deny (`lib/rate-limit.ts:102-104`, BUG-1) `[Confirmed]`. Brute-force protection is effectively off in both — acute given NEW's weak shared passwords.
- **One live authorization hole in NEW:** Manager "direct-write" edits are **not region-scoped** — a Manager can edit a customer outside their regions (BOLA, `services/edits.ts:259-264`, H-1) `[Confirmed]`.
- **Neither system integrates with the ERP (Temix/RoutePro).** Both rely on manual, human re-keying. This is the central architectural gap for any "master-data platform."

**5. Is either system suitable as the foundation?** **Yes — the NEW system, decisively, on evidence (not recency).** It is the actual system of record, has real data-integrity controls, deploys cleanly, is already live, and is the cheaper target to migrate *into*. OLD is disqualified as a base by its no-write-back architecture, broken migration history, and Postgres/SQLite deployment contradiction — but it holds **requirements NEW lacks** (field-originated creation, a finance/Accountant tier, SLA/escalation, notifications) that must be consciously re-scoped, not assumed away.

**6. Is consolidation feasible?** **Technically yes** — both are the same Next.js/Prisma/Vercel family, so the target architecture is coherent. **But it is a transform, not a merge.** The two schemas share no customer identifier, differ in 3 of 5 roles, model branches and status differently, and OLD code cannot be lifted into NEW (Prisma 5→6, NextAuth 4→5, Next 14→15, React 18→19 are all breaking). Consolidation = **keep NEW as the base + ETL the current master state from OLD + rebuild the genuinely-missing OLD capabilities natively on NEW.**

**7. Preliminary recommended direction (for confirmation, not action).**
1. Adopt **NEW as the go-forward system of record**; `nmwcCode` as the canonical key; retain `temixCode` as a legacy ERP cross-reference.
2. **Immediately, independent of consolidation:** rotate/purge both secret exposures; fix NEW's rate-limiter (BUG-1) and Manager scope hole (H-1); verify OLD's *real* production database.
3. Take a set of **blocking business decisions** (Section N) before any migration: is field-originated new-customer creation required? does credit onboarding need an Accountant tier? role crosswalk (fate of Accountant/RoutePro)? branch cardinality (1:1 vs 1:N)? SLA/notifications in scope?
4. Only then design the ETL + net-new build.

**No material business contradiction has been resolved in this report.** Each is logged in Section H with a named decision owner.

---

## Section B — Repository & Architecture Map

### B.1 OLD — ICO Customer Portal `[Confirmed]`
- **Stack:** Next.js 14.2.5 (App Router), React 18.3.1, TypeScript 5.5.3 (strict), Prisma 5.16.1, NextAuth 4.24.7 (Credentials + JWT, 8h), bcryptjs (cost 12), Tailwind 3.4, zod, react-hook-form. Parsing/export via `papaparse` + `xlsx@0.18.5`; charts via `recharts`. **No structured logging (bare `console.*`), no Sentry/APM.**
- **Entry points:** `middleware.ts` (JWT gate; API→401 JSON, pages→login redirect; `/admin/*` page requires ADMIN); NextAuth at `app/api/auth/[...nextauth]`; Prisma singleton `lib/db.ts`. No custom server, no `instrumentation.ts`.
- **Layout:** `app/(auth)/login`, `app/(dashboard)/*` (dashboard, admin, customers/[temixCode], requests/[id]|new|update); `app/api/*` = **34 routes**; domain logic in `lib/*` (`permissions`, `duplicate-check`, `sla`, `notifications`, `storage`, `email`, `audit-log`, `rate-limit`, `validators/`).
- **Database:** Prisma-only access except one raw query. **Provider contradiction (CRITICAL):** `schema.prisma:6` and `migration_lock.toml` declare `postgresql`, migration SQL and `lib/rate-limit.ts` use Postgres-only syntax (`ON CONFLICT`, `NOW()`, `ALTER TYPE`), yet `.env`, `.env.example`, `docker-compose.yml`, and README all set `DATABASE_URL="file:./dev.db"` (SQLite), and a 344 KB `prisma/dev.db` exists. The declared schema is incompatible with the configured URL. `[Confirmed]`
- **Hosting:** Vercel (`vercel.json` with two crons) + a Docker/compose alternative that assumes SQLite. CI (`.github/workflows/ci.yml`) lints/tests/builds; **no CD**.
- **Integrations:** Vercel Blob (public objects behind an auth proxy) + a **broken** optional S3/R2 branch (`@aws-sdk/client-s3` dynamically imported but **absent from `package.json`**); SMTP via nodemailer (unconfigured). **Temix and RoutePro are workflow fields/stages only — no live ERP API.** `[Confirmed]`
- **Maturity:** functional MVP, 10 commits, single author, last work **2026-04-17**, hardened through audit cycles but stalled with unresolved deployment-config debt.

### B.2 NEW — NMWC Customer Master `[Confirmed]`
- **Stack:** Next.js 15 (App Router, RSC + Server Actions), React 19, TypeScript 5.6, Prisma 6.19 / **PostgreSQL on Neon** (pooled `DATABASE_URL` + `DIRECT_URL`), Auth.js v5 (`next-auth ^5.0.0-beta.31`), bcryptjs (cost 12), Cloudflare **R2** via AWS S3 SDK, zod, `exceljs`, **Sentry + pino** (PII-redacting).
- **Entry points:** `app/layout.tsx` (propagates CSP nonce), Edge-safe `auth.config.ts` (consumed by `middleware.ts`), Node `lib/auth.ts` (Credentials + JWT callbacks), `instrumentation.ts` (Sentry). Route handlers: `api/auth`, `api/health`, `api/photos/{presign,finalize,[id]}`, `api/exports/customers`, `api/cron/{photo-gc,keep-warm}`. Business logic in `services/*.ts` (`'use server'`).
- **Layout:** `app/(app)/*` (13 feature areas: customers, approvals, reactivations, rejected, duplicates, import, export, routes, team, users, dashboard, today, audit); `components/nmwc/*`; `lib/*` (pure helpers: `permissions`, `access`, `completeness`, `errors`, `rate-limit`, `audit`, `r2`, `phone`, `cr`, `tz`); `services/*` (edits, imports, duplicates, reactivations, exports, users, routes, photos, saved-views).
- **Database:** 16 models + 11 enums; **9 replayable migrations** whose hand-written SQL carries invariants *beyond* `schema.prisma` — pg_trgm/GIN + partial B-tree indexes, GPS range CHECKs, address minlength, a `branch_region_consistency_check` trigger, partial-unique on `crNumberNorm`, and a deliberate **drop of phone-uniqueness**. Optimistic locking via `version` on Customer/Branch. `[Confirmed]`
- **Hosting:** Vercel (region `fra1`, `photo-gc` daily cron) + **GitHub-Actions off-platform crons**: `keep-warm` (Oman-hours warmups) and `db-backup` (daily `pg_dump`→R2 + restore-drill into a Neon branch). Live at `https://nmwc-cm.vercel.app`.
- **Integrations:** Neon, R2 (photos + backups), Sentry, Vercel, GitHub Actions. **No ERP/Temix/RoutePro integration** (grep-negative) — sync is Excel-in/Excel-out by the Steward. `[Confirmed]`
- **Maturity:** operational pilot (GT-MUSCAT), heavily hardened (hundreds of tagged fixes: `B-`, `AUTH-`, `QA-`, `RBAC-05-`, `EL-`, `F-`, `PROD-`), CI + 10 unit specs + Playwright e2e + loadtest. **Caveat:** a **beta** auth dependency in production. `[Confirmed]`

### B.3 Deployment architecture (both)
Both are serverless Next.js on Vercel with Prisma/Postgres and object storage. **Two separate Vercel projects and datastores** — consolidation means decommissioning one project, a DNS/URL cutover, and a login-scheme change (OLD logs in by **email**, NEW by **username**).

---

## Section C — OLD System Functional Map

**Access & auth.** Login by **email + password** (`app/(auth)/login`), verified in `lib/auth.ts:41-98`: dual DB-backed login rate-limit → `bcrypt.compare` → reject inactive → generic "Invalid credentials". JWT, 8h. **Weakness:** `isActive`/role are checked only at login; the JWT is never re-validated against the DB, so a fired/demoted user keeps access for up to 8h (J-H1). `[Confirmed]`

**Roles (5):** SALESMAN, SUPERVISOR, ACCOUNTANT, ADMIN, ROUTEPRO — stored as a free `String` (`schema.prisma:55`), enforced only by Zod. Central authz in `lib/permissions.ts` is **request-workflow-centric** (`canSupervisorAct`, `canAccountantAct`, `canActivateRoutePro`, `canViewRequest`, `buildRequestScopeFilter`). Scope is by **Depot + Route**.

**Status machine (17 statuses, hand-coded per route, all optimistic-concurrency-guarded):**
```
DRAFT ─submit→ (dup check) ─┬─ BLOCKED_EXACT_DUPLICATE   (cannot proceed)
                            ├─ WARNING_POSSIBLE_DUPLICATE (→ supervisor, must ack)
                            └─ PENDING_SUPERVISOR
PENDING_SUPERVISOR ─approve→ PENDING_ACCOUNTANT   (or → PENDING_ROUTEPRO for minor updates)
                   ─return→  RETURNED_BY_SUPERVISOR   ─reject→ REJECTED_BY_SUPERVISOR
PENDING_ACCOUNTANT ─confirm-temix(+temixCode)→ PENDING_ROUTEPRO
                   ─return/reject→ RETURNED_/REJECTED_BY_ACCOUNTANT
PENDING_ROUTEPRO ─activate→ ACTIVE_IN_ROUTEPRO   (effective terminal)
(SLA breach) ─cron→ ESCALATED     (admin can force any of 13 targets)
```
Legacy/dead statuses `SUBMITTED`, `APPROVED_BY_SUPERVISOR`, `CREATED_IN_TEMIX` are defined but never set. `[Confirmed]` (`old-functional.md` §3)

**Journeys present/partial/absent:**
- **New creation** (NEW_MAIN/NEW_BRANCH/NO_CR) — **Present**, full 4-stage.
- **Existing modification** (UPDATE_EXISTING) — **Present**; `updateCategory` routes minor categories straight past the accountant. **But** the change is only recorded as `changesSummary` JSON — **no write-back** to the master.
- **Cash** — **Partial/implicit** (modeled as the `NO_CR` type, not a payment-terms flag).
- **Credit** — **Absent** (no `paymentTerms`/credit fields anywhere).
- **Branches** — **Present** as `NEW_BRANCH` requests linked by `parentTemixCode` string (no FK).
- **Individual vs corporate** — **Absent**.
- **Suspended/temporary** — **Partial** (`CustomerMaster.isActive`/`pendingUpdate` only).

**CRITICAL finding:** on approval/activation the portal **does not create or update the customer master**; GPS/photos/contact live on the `CustomerRequest` and are read back by JOINing `status=ACTIVE_IN_ROUTEPRO` (`app/api/customers/[temixCode]/route.ts:60-90`). The master reappears only on the next bulk upload. `[Confirmed]`

**Notifications/SLA:** in-app `Notification` rows on every transition; **email is dead code** and the **SLA cron never fires in production** (see Section I). Audit via `StatusHistory` (per-transition) + a **write-only** `AdminAuditLog`.

---

## Section D — NEW System Functional Map

**Access & auth.** Login by **username + password** via a server action (`app/actions/auth.ts`), verified in `lib/auth.ts:236-330`: zod → rate-limit → `bcrypt.compare` against a **constant-time dummy hash** for unknown users → `LOGIN`/`LOGIN_FAIL` audit. JWT 8h **but re-read from DB every 5 min**, honouring `isActive`, role change, and `sessionsRevokedAt` hard-revocation; `__Secure-` cookies; `mustChangePassword` gate; password-reuse history. Materially stronger than OLD. `[Confirmed]`

**Roles (5, DB enum):** SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER. Authz split across `lib/permissions.ts` (RBAC) + `lib/access.ts` (data scope). Scope: SALESMAN → own route (1:1 `ownedRouteId`); SUPERVISOR → team's routes; MANAGER → managed regions (M:N, **fail-closed** when empty); STEWARD/VIEWER → all. Field locks (`isFieldLocked`): for a salesman `legalName` + `nmwcCode` are always locked, `crNumber` locked only on CREDIT customers. Self-approval blocked for all roles. `[Confirmed]`

**State machines.**
- **Edit approval** (`EditState`): `DRAFT → SUBMITTED → APPROVED | NEEDS_CORRECTION → (resubmit)`. Steward/Manager get **direct-write** (auto-APPROVED, no queue). One open edit per customer enforced by app check **and** a DB partial-unique index. `REJECTED` is a **dead enum value** — rejection always writes `NEEDS_CORRECTION`.
- **Customer/Branch status** (`ACTIVE/CLOSED/SUSPENDED`): salesman marks a branch CLOSED with a fresh photo → Supervisor approves; reactivation needs a fresh photo → **Manager** approves; anti-replay anchored to `Branch.lastStatusChangeAt`. **Gaps:** `SUSPENDED` is a **dead-end** (no in-app entry/exit); branch-CLOSED never cascades to `Customer.status`; customer-level CLOSED has **no writer**.
- **Import** (`ImportRowState`/`ImportBatchStatus`): parse → CLEAN/QUARANTINED → promote (atomic `READY→PROMOTING` claim).

**Journeys present/partial/absent:**
- **Enrichment** (the core salesman flow) — **Present**: `/customers/[id]/edit` → `submitEditAction` → mandatory-field gate → `CustomerEdit` → supervisor `/approvals` → `applyEditChanges` (optimistic-locked, re-checks locks + mandatory + photos, writes audit diff).
- **New creation** — **Absent as a manual flow**; only Steward Excel import → promote.
- **Cash vs Credit** — **Partial**: `PaymentTerms` enum exists but its only effect is the CR field-lock; no credit/AR logic.
- **Branches** — **Present** (first-class `Branch`, per-branch scope filtering) — **but production data was flattened to 1:1** (P1.2; 3308 customers = 3308 branches) and some code now assumes `branches[0]`.
- **Duplicate merge** — **Present** (Steward-only, exact rules, cross-region confirmation).
- **User provisioning** — **Present** (`/users`, Manager-only, cannot mint Manager/Steward, forces `mustChangePassword`).
- **Individual/corporate, suspended lifecycle, notifications, SLA** — **Absent**.

**Notifications/SLA:** **none** — reviewers discover work via `/approvals`, `/work`, `/today` queue pages refreshed by `revalidatePath`. Audit via a single immutable `AuditLog` (19 actions, before/after JSON). `[Confirmed]`

---

## Section E — Data Model & Data Dictionary

### E.1 OLD — 13 models, **zero enums** (all categorical values are `String`)
| Entity | Key | Role |
|---|---|---|
| `Depot` | `code` unique | Distribution depot; `primaryAccountantId` for routing |
| `Route` | `code` unique | Sales route; holds salesman/supervisor/accountant/depot FKs |
| `User` | `email` unique | All actors; `role` is a free String; self-relation `TeamHierarchy` |
| `CustomerMaster` | **`temixCode` unique** | The master record (from bulk upload); flat `channel/address/contact/...` |
| `MasterUpload` | id | Bulk upload batch |
| `RequestSequence` | `year` | Per-year request-number counter |
| `CustomerRequest` | `requestNumber` unique | **Core workflow entity** — all customer fields inline + workflow state |
| `RequestPhoto` | id | Photos (`fileUrl`/`fileKey`), 1 per type |
| `StatusHistory` | id | Per-transition audit |
| `DuplicateMatch` | id | Dedupe matches (review columns **unused**) |
| `Notification` | id | In-app notifications |
| `RateLimitAttempt` | (key,windowStart) | DB rate limiter |
| `AdminAuditLog` | id | Admin-action audit (**write-only, no read UI**) |

**Problems `[Confirmed]`:** no DB enums (integrity only in TS/Zod); **no init migration** + a migration that `ALTER TYPE`s a non-existent enum → `migrate deploy` fails; Postgres-schema/SQLite-env mismatch; denormalized no-FK strings (`parentTemixCode`, `existingTemixCode`, `routeCode`, `salesmanName`); nullable assignment FKs; no `createdBy/modifiedBy` on `CustomerRequest`/`CustomerMaster`; `DuplicateMatch.reviewedById/reviewedAt/resolution` never written; **no `paymentTerms`/credit fields at all**.

### E.2 NEW — 16 models + 11 enums
| Entity | Key | Role |
|---|---|---|
| `Region` / `Route` | `code` unique | Org hierarchy (Region → Route; Route `owner` = 1:1 salesman) |
| `User` | `username` unique | Actors; `role` **enum**; `sessionsRevokedAt`, `mustChangePassword`, `ownedRouteId` |
| `PasswordHistory` | id | Reuse prevention (last 5) |
| `SavedView` | id | Per-user `/customers` filter snapshots |
| `Channel` / `SubChannel` | `key` unique | **Locked taxonomy** (FK from Customer) |
| `Customer` | **`nmwcCode` unique** | Master legal entity; `paymentTerms`, `crNumber(+Norm)`, `primaryPhone(+Norm)`, `completenessScore`, `version`, soft-delete |
| `Branch` | `branchCode` unique | Outlet under a Customer; address/GPS/equipment counts/photos/status/`version` |
| `CustomerEdit` | id | Diff-based change request (`fieldChanges`/`attachmentChanges` Json) |
| `Attachment` | `r2Key` unique | R2 photo/doc; sha256 `hash` dedupe; soft-delete |
| `ImportBatch` / `ImportRow` | id | Staged import (quarantine → promote) |
| `RateLimit` | `key` | Durable token bucket |
| `ExportJob` | id | Async xlsx export |
| `AuditLog` | id | **Immutable** audit (19 actions, before/after) |

**Strengths:** real enums, CHECK constraints + triggers, optimistic `version` locks, soft-delete everywhere, immutable audit, normalized channel taxonomy, dedupe-normalized fields.
**Problems `[Confirmed]`:** dead fields `CustomerEdit.newRouteId` + `isWrongRoute` (wrong-route reassignment never wired); write-only `decisionCategory`; `Attachment.customerId/branchId`, `Customer.importBatchId`, `createdById/lastEditedById` are **loose scalars with no FK**; `ImportBatch.kind` is a magic String; **phone-uniqueness deliberately dropped**; `EditState.REJECTED` unused; DB invariants live in migration SQL (invisible in `schema.prisma`).

### E.3 PII / sensitive inventory
Both hold: customer/contact names, phones, addresses, GPS, CR numbers, `passwordHash`. NEW adds `Attachment.capturedLat/Lng` (person location at capture) and `paymentTerms` (commercially sensitive). Re-classify on any migration.

---

## Section F — Feature Comparison Matrix

Verdict legend: only-OLD · only-NEW · both-different-impl · both-conflict · both-one-stronger · missing-both. **"Stronger" is judged against the unified NMWC target, not recency.**

| # | Feature | Verdict | Stronger | Evidence / note |
|---|---|---|---|---|
| 1 | User management | both-one-stronger | **NEW** | NEW peer-tier protection, last-Manager guard, reuse history; OLD `role` is free String |
| 2 | Authentication | both-one-stronger | **NEW** | NEW 5-min freshness + `sessionsRevokedAt`; OLD 8h stale sessions (J-H1) |
| 3 | Authorization / RBAC | both-one-stronger | **NEW** | NEW scope+locks+fail-closed; **but** one live hole (H-1) |
| 4 | Customer **creation** | both-different-impl (conflict) | **OLD** | OLD full 4-stage; NEW import-only, no manual create |
| 5 | Customer **updates/enrichment** | both-one-stronger | **NEW** | NEW writes master on approve (version-locked); OLD only records JSON, no write-back |
| 6 | Customer search | both-different-impl | **NEW** | NEW pg_trgm + partial indexes + saved views; OLD unanchored `LIKE` can't use index |
| 7 | Duplicate prevention | **both-conflict** | depends | OLD fuzzy+phone blocks at entry; NEW fuzzy removed, phone-unique dropped, advisory merge — opposite philosophies |
| 8 | Forms & fields | both-different-impl | **NEW** | NEW Oman-geofenced GPS + Arabic-digit phone; OLD accepts any global coord |
| 9 | Validation | both-one-stronger | **NEW** | NEW min-12 pw, formula-injection block, geofence; OLD min-8, none |
| 10 | Cash workflow | both-different-impl (weak) | ~tie | OLD `NO_CR` type; NEW `PaymentTerms` enum → CR-lock only |
| 11 | Credit workflow | **missing-both** | — | Neither has credit-limit/AR/terms-approval |
| 12 | Approval workflow | both-different-impl | depends | OLD 3-tier + activation; NEW 1-tier + reactivation; both concurrency-guarded |
| 13 | Document / photo handling | both-one-stronger | **NEW** | NEW presigned R2 + finalize verification + anti-spoof capturedAt; OLD Blob public-behind-proxy |
| 14 | Audit trail | both-one-stronger | **NEW** | NEW immutable AuditLog; OLD `AdminAuditLog` write-only/unread |
| 15 | Notifications | only-OLD (both weak) | OLD (nominal) | OLD in-app rows but email dead + cron dead; NEW none |
| 16 | Database structure | both-one-stronger | **NEW** | NEW enums/migrations/CHECKs/version; OLD String-typed, migrate-deploy broken |
| 17 | Reporting / dashboards | both-different-impl | **NEW** | NEW completeness dashboards; OLD recharts but summary email broken; both in-memory aggregation |
| 18 | Deployment | both-one-stronger | **NEW** | NEW live + backup/restore-drill; OLD Postgres/SQLite mismatch, crons dead |
| 19 | Error handling | both-one-stronger | **NEW** | NEW `SafeAction` + Sentry + pino; OLD bare console |
| 20 | Security (overall) | both-one-stronger | **NEW** | Both have committed-secret failures; OLD's (signing key) is the worse class |
| 21 | UX | both-different-impl | **NEW** `[Highly likely]` | NEW field-mobile-first capture components |
| 22 | Mobile responsiveness | both-different-impl | **NEW** `[Highly likely]` | NEW GPS/photo capture, keep-warm for edge networks |
| 23 | Administration | both-one-stronger | **NEW** | NEW steward/manager tooling, saved views, audit page |
| 24 | Maintainability | both-one-stronger | **NEW** | NEW typed enums (but `Json` blobs/`as any`); OLD String-typed + doc drift |
| 25 | Rate limiting | **both-conflict (both broken)** | neither | OLD fails-open; NEW always-grants (BUG-1) — must-fix regardless |
| 26 | Branch model | both-different-impl | **NEW** | NEW first-class Branch (flattened 1:1 in pilot); OLD string parent link |
| 27 | Lifecycle (close/suspend/reactivate) | both-partial | **NEW** | NEW photo-evidenced flows but SUSPENDED dead-end; OLD none |
| 28 | ERP integration (Temix/RoutePro) | **missing-both** | — | Neither has an API; both manual |
| 29 | SLA / escalation | only-OLD (broken) | OLD (design) | OLD cron never fires; NEW none |
| 30 | Optimistic concurrency | both-consistent | tie | Both guard transitions; NEW adds `version` cols |

**Rolled-up recommendation:** **Keep NEW as the foundation; port OLD's genuinely-missing capabilities onto it** — (a) field-originated new-customer creation, (b) an optional finance/Accountant approval tier if credit onboarding is in scope, (c) SLA/escalation (implemented correctly), (d) working notifications. **Do not carry over from OLD:** committed `.env`/secrets, String-typed schema, broken migration history, POST-only crons, dead email code, the no-write-back architecture. `[Confirmed]` (`x-comparison.md`)

---

## Section G — Business Rule Catalogue (selected; full detail in raw-evidence)

**Implementation status legend:** Fully / Partial / Frontend-only (bypassable) / Backend-only / Mentioned-not-implemented / Operationally-questionable.

### OLD
- **Mandatory fields** (`lib/validators/request.ts:13-53`) — Backend, Fully. Same schema used for draft-save and submit (no looser draft schema) except GPS deferred to submit.
- **Conditional** — CR required unless NO_CR/UPDATE; `parentTemixCode` for NEW_BRANCH; `existingTemixCode` for UPDATE; subChannel must belong to channel. Backend.
- **GPS** — bounds only, **no Oman geofence**; device-capture is **Frontend-only → spoofable** (`components/forms/GPSCapture.tsx`; API accepts any lat/lng). `[Confirmed, security-relevant]`
- **Photos** — server **magic-byte** MIME check, 10 MB, status/ownership gated. Backend, strong.
- **Duplicate check** (`lib/duplicate-check.ts`) — Levenshtein name (EXACT ≥0.85 / POSSIBLE ≥0.70) + CR + last-8-digit phone, against master + pending; **first-4-char prefix prefetch = recall gap**; skipped for UPDATE.
- **Approval tiers** — Supervisor → Accountant → RoutePro; EXACT dup un-approvable; POSSIBLE needs override reason; minor update categories bypass accountant.
- **SLA** — supervisor 8h / accountant 9h working hours, env-driven calendar; **cron never fires** (Section I).
- **Cash/Credit / credit-limit / VAT** — **absent / not modelled.**
- **Field locks** — none (coarse: whole record editable only in draft/returned).

### NEW
- **Mandatory-field gate** (`services/edits.ts:98-187`) — Backend, Fully; re-run at approve; lock-aware (never blocks a salesman on data they can't edit); skipped for drafts and for Steward/Manager direct-write.
- **Field locks** (`lib/permissions.ts:70-80`) — `legalName`+`nmwcCode` always locked for salesman; `crNumber` locked on CREDIT; re-evaluated at approve against current terms. Backend, Fully.
- **Approval** — single-tier; one-open-edit-per-customer (app + DB unique index); atomic claim; self-approval blocked; bulk cap 50.
- **Status/reactivation** — CLOSED/SUSPENDED blocked in the edit form for all roles; close (Supervisor) / reactivate (**Manager**) via fresh-photo evidence; capturedAt from R2 `LastModified` (anti-spoof). Fully.
- **Duplicate detection** — **no fuzzy**; CR-exact + EXACT_TRIPLE(legalName+phoneNorm+regionId); **phone dups allowed by design**; Steward merge with cross-region confirmation.
- **Validation** — phone canonical `+968`, CR normalize, **Oman GPS envelope (lat 16–27, lng 51–61)**, equipment caps, stripHtml, formula-injection defence, min-12 passwords.
- **Uploads** — photos MIME-whitelist + 3 MB + key/kind binding + size re-check; import `.xlsx` 5 MB.
- **Completeness scoring** (`lib/completeness.ts`) — customer/40 + branch/60, bands ≥80/≥50; **two scoring bugs** (Section I BUG-4/5).
- **Notifications / SLA** — **none** (queue pages only).
- **Known rule discrepancy (G-A1, Operationally-questionable):** the `/customers` **list** page does not replicate the Manager fail-closed rule — a Manager with no managed regions gets an **unscoped** customer list (`app/(app)/customers/page.tsx:77-88`). `[Confirmed via static trace]`

---

## Section H — Contradiction & Decision Register

**20 material contradictions.** None is silently resolved; each carries a recommended direction and a required business decision. (Full 14-field entries per item in [`raw-evidence/x-contradictions.md`](raw-evidence/x-contradictions.md).)

| ID | Area | OLD | NEW | Recommended direction | Decision owner must confirm | Blocks? |
|---|---|---|---|---|---|---|
| **H-01** | Customer identity key | `temixCode` | `nmwcCode` | Adopt `nmwcCode`; keep `temixCode` as legacy xref | Canonical key + who owns temix↔nmwc crosswalk | **YES** |
| **H-02** | System of record | workflow tracker (no write-back) | master-data store | Standardize on NEW as SoR | Which system is SoR; must Temix creation stay tracked? | **YES** |
| **H-03** | New-customer creation | present | absent (import-only) | Build governed create-flow in NEW **if** field origination required | Is field-originated creation required? | **YES** |
| **H-04** | Data model / schema | request-centric, 0 enums | customer/branch, 11 enums | NEW schema as target; ETL w/ quarantine | Approve NEW schema + ETL approach | **YES** |
| **H-05** | Role set | Salesman/Sup/**Accountant**/Admin/**RoutePro** | Salesman/Sup/**Manager**/**Steward**/Viewer | Adopt NEW roles + explicit crosswalk | Fate of Accountant/RoutePro; who becomes Steward/Manager | **YES** |
| **H-06** | Approval tiers | 3-tier + activation | 1-tier + direct-write | NEW engine; add finance tier only if needed | Approval chain; keep direct-write bypass? | **YES** |
| **H-07** | Cash/Credit | none (NO_CR type) | `PaymentTerms` + CR-lock | Source terms from ERP, don't infer | Payment-terms source of truth for migrated rows | **YES** |
| **H-08** | Duplicate logic | fuzzy + phone block | 2 exact rules, phone allowed | Keep NEW; optional fuzzy *advisory* | Confirm shared-phone reality; want fuzzy advisory? | Partial |
| **H-09** | Customer↔Branch | string parent link | Branch model (flattened 1:1) | Decide cardinality; fix `branches[0]` if 1:N | Can a customer have multiple branches? | **YES** |
| **H-10** | Status model | 17 request statuses | ACTIVE/CLOSED/SUSPENDED | NEW enum; fix SUSPENDED/cascade | Required lifecycle states + SUSPENDED semantics | Partial |
| **H-11** | Auth generation | NextAuth 4, 8h static | Auth.js 5, freshness+revocation | Adopt NEW; plan beta→stable | Accept beta-auth risk (with upgrade plan) | No |
| **H-12** | Storage | Vercel Blob | Cloudflare R2 | Standardize on R2; migrate photos | Approve R2 + photo migration | No |
| **H-13** | Deploy/DB integrity (OLD) | Postgres-schema/SQLite-env | clean Neon | Verify OLD's real prod DB before extract | Disclose live OLD datasource | N/A (source) |
| **H-14** | Secret hygiene (both) | committed `.env` secrets | committed pilot passwords | Rotate + purge history, both | Approve rotation window + history rewrite | No (do now) |
| **H-15** | Branding | ICO/NMWC mixed | NMWC | Standardize on NMWC | Official product name/brand/domain | No |
| **H-16** | Enum enforcement | String columns | DB enums | Keep NEW enums; normalize on ETL | Approve normalization maps | No |
| **H-17** | Notifications & SLA | in-app + SLA (broken) | none | Decide scope; build in NEW if required | Are SLA/notifications in-scope? | **YES** if required |
| **H-18** | GPS geofence/capture | global, spoofable | Oman envelope, server-derived | Keep NEW; quarantine OOB OLD GPS | Confirm envelope covers all outlets | No |
| **H-19** | Migration workflow | db push (non-replayable) | replayable migrations | Adopt NEW discipline | — (engineering standard) | No |
| **H-20** | Rate-limiter correctness | fails-open | always-grants (BUG-1) | Fix NEW; add PG integration test | — (bug fix, go/no-go blocker) | No (fix now) |

**Blocking decisions before any migration:** H-01, H-02, H-03, H-04, H-05, H-06, H-09; H-07 and H-17 if credit/SLA in scope.
**Fix immediately, in parallel, regardless of direction:** H-14 (secrets), H-20 (rate limiter), H-13 (verify OLD DB).

---

## Section I — Bugs & Defects

### Confirmed — OLD
| ID | Sev | Defect | Evidence |
|---|---|---|---|
| OLD-BUG-01 | **Critical** | Schema=Postgres vs env=SQLite; `migrate deploy` fails; case-insensitive search & rate-limit break on SQLite | `schema.prisma:6`, `.env`, `migrations/20260405…` |
| OLD-BUG-02 | **Critical** | `.env` committed with live `NEXTAUTH_SECRET`/`CRON_SECRET` | `git ls-files`, `.env` |
| OLD-BUG-03 | **High** | **Vercel crons never fire** — routes are POST-only, Vercel Cron sends GET → 405. SLA escalation + daily summary never run | `vercel.json` vs `app/api/cron/*/route.ts:7-8` |
| OLD-BUG-04 | **High** | Notification **emails are dead code** — `sendNotificationEmail` never called; only the (broken-cron) daily summary sends mail | `lib/email.ts:26`, `lib/notifications.ts` |
| OLD-BUG-06 | **High** | Master ROUTE_SALESMAN import: **N+1 full-user scan per row** + mega-transaction → timeout risk | `app/api/master/upload/route.ts:206` |
| OLD-BUG-05 | Medium | SLA escalation asymmetric (supervisor breach force-`ESCALATED` via unguarded update; accountant breach only flags) | `app/api/cron/sla-check/route.ts:40-95` |
| OLD-BUG-07 | Medium | Hardcoded default admin password in `prisma/seed-production.ts:42` | as cited |

### Suspected — OLD
`xlsx@0.18.5` known-vuln (BUG-09); S3 storage branch unbuildable (BUG-10); `PATCH /requests/[id]` unguarded + can change `type` without re-routing (BUG-11); production CSP keeps `script-src 'unsafe-inline'` (BUG-12); submit notification failure returns 500 after commit (BUG-08).

### Confirmed — NEW
| ID | Sev | Defect | Evidence |
|---|---|---|---|
| NEW-BUG-1 | **Critical** | **Postgres rate limiter never denies** — `granted` derived from a token count clamped ≥0; production login/brute-force protection off; only in-memory path (tests) works | `lib/rate-limit.ts:102-104` |
| NEW-H-1 | **High (authz)** | **Manager direct-write not region-scoped** (BOLA) — a Manager can edit a customer outside their regions, written straight to master, `reviewedById=self` | `services/edits.ts:259-264,421-451`; `customers/[id]/edit/page.tsx:83-97` |
| NEW-BUG-2 | **High** | Region-less import fallback writes a **Route id into `Branch.regionId`** → FK violation → whole customer group silently REJECTED (core migration path) | `services/imports.ts:751-762,802-803` |
| NEW-C-1 | **Critical (sec)** | Plaintext shared weak passwords for all 13 users (incl. STEWARD) committed | `docs/PILOT-MUSCAT-CREDENTIALS.md`, `scripts/bulk-reset-credentials.ts` |
| NEW-BUG-3 | Medium | Approve-time lock **silently drops a CASH customer's salesman-collected CR number** (approve re-implements lock as "legalName locked ⇒ also drop crNumber") | `services/edits.ts:682-692` vs `284-289` |
| NEW-G-A1 | Medium | `/customers` list not fail-closed for a Manager with no regions → unscoped list | `app/(app)/customers/page.tsx:77-88` |
| NEW-BUG-4/5 | Low | Completeness always grants the `notes\|\|paymentTerms` +5 (paymentTerms always set); tautological equipment branch | `lib/completeness.ts:47,58-67` |

### Suspected — NEW
Reactivation approve lacks optimistic version locking (SUS-1); duplicate detector + dashboard do full-table in-memory scans (SUS-2/3); `PROD-004` timezone status not re-verified this pass.

---

## Section J — Security Assessment

**Overall:** both codebases are *above-average* for their class and carry genuine, verified hardening histories. Residual risk concentrates in **secret/credential management** and a small number of specific defects. No secret value is reproduced below.

### Critical
- **J-C1 (OLD):** `.env` committed to git with a live **`NEXTAUTH_SECRET`** (masked `hjT…`) — disclosure = **forge any session token, including ADMIN** — and **`CRON_SECRET`** (masked `b04…`). Rotate both, `git rm --cached .env`, purge history. `[Confirmed]`
- **C-1 (NEW):** plaintext **shared, weak (8-char numeric) pilot passwords for all 13 users — including the highest-privilege STEWARD** — committed in a tracked doc + reset script, with `mustChangePassword=false`. Anyone with repo/URL access can authenticate as Steward (import/merge/lock-bypass). Rotate to unique high-entropy, re-enable forced change, purge history, add a secret scanner. `[Confirmed]`

### High
- **NEW-H-1:** Manager direct-write not region-scoped (BOLA) — see Section I. `[Confirmed]`
- **OLD J-H1:** account deactivation / role change **not enforced until JWT expiry (≤8h)** — the JWT callback never re-reads the DB. `[Confirmed]`
- **Both rate limiters non-functional** (OLD fails-open; NEW always-grants) — brute-force protection is effectively off in production. `[Confirmed]`

### Medium
- NEW shared passwords defeat per-user auditability/revocation (M-1); OLD middleware doesn't enforce role on `/api/admin/*` (relies on per-route checks — fragile); OLD `xlsx@0.18.5` prototype-pollution/ReDoS; OLD timing-unsafe CRON compare + bcrypt user-enumeration oracle; both keep some `'unsafe-inline'` in CSP (OLD scripts; NEW styles).

### Verified-good controls (mostly NEW)
No SQL injection (parameterized raw queries; `$queryRawUnsafe` in NEW uses no user input); no `dangerouslySetInnerHTML`/`eval`; formula-injection defence on Excel in+out (NEW); strong upload controls (magic-byte / presign+finalize verification); bcrypt cost 12; NEW session revocation, timing-safe cron compare, IDOR 404-not-403, PII log redaction, fail-closed export/read scope (except the G-A1 list path).

**Remediation priority:** (1) rotate+purge both secret exposures; (2) fix NEW rate limiter (BUG-1) + Manager scope (H-1); (3) OLD session-staleness + `/api/admin/*` backstop; (4) dependency + CSP hardening. **Runtime items to verify:** real production `DATABASE_URL` (OLD), whether committed secrets equal live values, R2 bucket privacy, Neon backup/retention, whether pilot passwords were rotated after 2026-05-11.

---

## Section K — Technical-Debt Register

### OLD
- **Critical:** DB provider/config + docs drift (BUG-01); committed secrets (BUG-02).
- **High:** crons dead (BUG-03); no emails (BUG-04); master-import N+1/timeout (BUG-06); no structured logging/APM.
- **Medium:** asymmetric/unguarded SLA update; `xlsx` vuln; duplicate-check unindexed `LIKE` scan; missing `updatedAt` index for the default sort; migration history non-replayable.
- **Low:** dead code (`canCancel`, `LEGACY_STATUSES`); committed `tsconfig.tsbuildinfo`; unguarded `PATCH`.
- **Strengths:** clean layering, centralized authz, optimistic-concurrency guards, pinned deps.

### NEW
| ID | Sev | Item |
|---|---|---|
| TD-1 | **Critical** | Rate limiter non-functional in prod (BUG-1) |
| TD-2 | **High** | Region-less imports fail (BUG-2) — core migration path |
| TD-3 | **High** | Login p95 ~3s: two sequential PG rate-limit txns + bcrypt + user find/update every login |
| TD-4 | Medium | **No service-layer test coverage** — approval/import/merge/photo logic untested (only pure `lib/*` + 1 e2e) |
| TD-5 | Medium | Audit misuse: no `EXPORT` action (logged as IMPORT); dismissed dup-pairs stored as AuditLog rows |
| TD-6 | Medium | Type erosion: `fieldChanges`/`attachmentChanges` untyped `Json` reconstructed by string-prefix parsing; relational `EditFieldChange` (B-22) **deferred** |
| TD-7 | Medium | No single typed config module; `NEXTAUTH_SECRET`/`AUTH_SECRET` dual-read; ad-hoc `process.env` |
| TD-8..12 | Low | Dynamic `await import` in hot paths; in-memory dup/dashboard aggregation won't scale past ~10k; completeness bugs; list/export scope logic duplicated; no connection-pool tuning |
- **Strengths:** disciplined error contract (`runAction`/`SafeAction`), centralized fail-closed authz, optimistic locking, immutable audit, backup/restore-drill, observability.

**Classification driver:** OLD's Critical debt is *deployment/config*; NEW's Critical debt is a *single one-line logic bug* (rate limiter) — a telling contrast in remediation cost.

---

## Section L — Missing Enterprise Capabilities

Absent from **both** (classification: **[E]** essential-first-release · **[I]** important-later · **[O]** optional · **[N]** not-recommended-unless-confirmed):

**Essential [E]**
- **ERP system-of-record strategy & sync (Temix/RoutePro).** Neither closes the loop automatically; NEW exports Excel a human re-keys. Even a documented batch-Excel contract with conflict rules is a *decision* that must be made before rollout. `[Confirmed]`
- **Coherent, operable customer lifecycle.** SUSPENDED dead-ends, un-closable customers, import-only creation → the master can't represent real-world states end-to-end. `[Confirmed]`

**Important [I]**
- **Arabic / i18n / RTL** — both hardcode `lang="en"`; for Arabic-speaking field staff this is the top *adoption* risk beyond a hand-picked pilot (arguably [E] for adoption). `[Confirmed]`
- **Notifications + SLA + escalation + delegation** (bundle) — the approval loop relies on polling and **stalls when an approver is absent** (no deputy/delegation). `[Confirmed]`
- **First-class version history + data-quality monitoring** — NEW deferred the relational field-history table (B-22) and has only completeness scoring; no queryable "who changed X→Y when," no DQ rule engine/trends. `[Confirmed]`
- Also: VAT/tax/trade-license document management + expiry/renewal reminders; configurable approval matrices; data-ownership (FK-backed) and stewardship accountability; customer-level closure + operable blocking; wire the **dead** wrong-route reassignment; reference-data admin UI; a public/integration API layer (prerequisite for ERP sync); bulk-update governance with preview/rollback.

**Optional [O]:** offline/PWA (real for low-connectivity Omani routes, but complex); native mobile; full WCAG; territory realignment analytics; in-app training; support console.

**Do NOT build (avoid feature inflation) [N]:** cash/credit approval separation, credit-limit/risk/AR — these belong in the **ERP (Temix)**, not a master-data cleanup tool, **unless NMWC explicitly reassigns credit onboarding to the CRM.** `[Confirmed]`

**Already strong in NEW (not gaps):** dedup governance, Steward stewardship, immutable audit, backup/DR, Sentry/pino monitoring, completeness scoring, import/export controls.

---

## Section M — Integration & Consolidation Risks

**Verdict: NEW is the only viable consolidation base** (system of record, current stack, deployable, live). Choosing it **costs** the entire OLD ERP-creation workflow (Accountant/RoutePro stages + roles), SLA/escalation, field-originated intake, and email scaffolding — all of which become **net-new build on NEW**, because OLD code **cannot be lifted** across the version gaps.

| Risk | Likelihood / Impact | Note |
|---|---|---|
| **No shared identifier** (`temixCode` vs `nmwcCode`) | certain / **Critical** | Build a crosswalk out-of-band. **Highest-leverage unknown: does NEW's `nmwcCode` (= import `cust_code`) already equal OLD's `temixCode`?** If yes, reconciliation is a join; if no, a manual data project. |
| **Shape conflict** (flat OLD vs Customer+Branch+taxonomy) | certain / High | Decompose each OLD customer; remap free-string channel → locked taxonomy (unmapped → silently NULL unless fail-loud). **OLD's real enrichment lives on `CustomerRequest`, not `CustomerMaster`** — a naive master copy loses it. |
| **Enum-vs-String** | certain / Med-High | Every OLD categorical value must be whitelisted/normalized or Postgres rejects the insert. |
| **NEW DB invariants** (GPS geofence, address minlength, branch/region trigger) | high / Med | OLD data (no geofence) will **hard-fail** inserts → needs a quarantine dry-run against a Neon branch. |
| **Incompatible history** (17-status requests vs 5-state edits) | certain / High (compliance) | **Freeze OLD read-only as an archive; migrate current master state only**, not the workflow history. |
| **Two Vercel projects/datastores + version deltas** | high / High | Decommission one; DNS cutover; OLD code un-liftable (breaking major versions). |
| **Secret cross-contamination** | high / Critical | Start consolidated repo from clean history (squash); never `git merge` OLD wholesale; rotate everything. |
| **Photo re-hosting** (Blob/disk → R2, re-key) | certain / High | Bulk object movement + scripted load (won't fit the 5 MB Steward import UI). |
| **ERP drift** | high / High | Post-cutover, NEW↔Temix drift is steady-state until sync is defined. |
| **Operational interruption** | high / High | Maintenance window: freeze OLD, ETL w/ quarantine on a Neon branch, re-provision users (email→username), redirect. |
| **Rollback** | — | Leverage NEW's `pg_dump`→R2 + Neon-branch restore-drill; keep OLD live-but-read-only for ≥1 reconciliation cycle. Do **not** hard-delete OLD until NEW is validated. |

---

## Section N — Questions Requiring Business Input

Only questions that **cannot** be answered from the code. Prioritized: **[Blocking]** stops migration design · **[Important]** · **[Non-blocking]**.

**Business process / system-of-record**
- **[Blocking]** Is the consolidated CRM the **system of record for customer master data**, with Temix owning financial/transactional data? (H-02)
- **[Blocking]** Must the field force **create net-new customers** in the app, or is creation centralized via ERP/import? (H-03)
- **[Important]** What is the sanctioned **ERP sync mechanism** (batch-Excel now; API later)? Who owns conflict resolution when NEW and Temix disagree? (M.8)

**Customer data**
- **[Blocking]** Confirm **`nmwcCode`** as the enterprise key and **`temixCode`** as retained legacy xref; who produces the crosswalk? (H-01)
- **[Blocking]** Can a customer have **multiple branches** going forward (restore 1:N), or is 1:1 the model? (H-09)
- **[Important]** Should the CRM store **VAT number / trade-license** and **CR/license expiry** with renewal reminders? (L #4/#17)
- **[Important]** Required **customer lifecycle states** and the meaning of SUSPENDED vs CLOSED? (H-10)

**Cash / credit policy**
- **[Blocking-if-in-scope]** Is **credit onboarding / an Accountant (finance) approval tier** in scope, or does credit stay entirely in Temix? (H-06, H-07, L #5)
- **[Important]** Authoritative **source of `paymentTerms`** for migrated customers (do not infer from `NO_CR`)? (H-07)

**Approval authority / user roles**
- **[Blocking]** Approve the **role crosswalk** — fate of OLD **Accountant** and **RoutePro**; who becomes **Steward/Manager**; is **Steward/Manager direct-write** (no second-person review) acceptable? (H-05, H-06)
- **[Important]** Is **delegation of authority** (approver-on-leave → deputy) required for multi-depot rollout? (L #8)

**ERP integration**
- **[Blocking]** Disclose the **real OLD production database** (env says SQLite, schema says Postgres) and whether `dev.db` is real or seed data. (H-13)
- **[Important]** Does an automated **Temix API** exist out-of-repo, or is integration genuinely manual today?

**Reporting / notifications**
- **[Important]** Are **SLA tracking + approver notifications** (email/SMS/push) in scope? Both are net-new in NEW. (H-17)
- **[Non-blocking]** Required management reports / scheduled exports / exec KPIs?

**Deployment / branding**
- **[Important]** Official **product name, brand, and domain** (retire "ICO"?). (H-15)
- **[Non-blocking]** Target **depot/region count post-pilot** (drives approval-matrix + delegation urgency).

**Security / data migration**
- **[Blocking-operational]** Approve an immediate **secret/credential rotation + git-history purge** window for **both** repos, and per-user credentials before non-pilot rollout. (H-14)
- **[Important]** **Data-retention / audit** obligations that constrain how long OLD's frozen archive must be kept.
- **[Important]** Is **Arabic UI + RTL** required for field-staff adoption at rollout? (L #31)
- **[Important]** Is **offline capture** a real constraint on NMWC routes? (L #30)

---

## Section O — Understanding Confirmation

To demonstrate — not merely assert — understanding:

**Purpose of each system.** The OLD **ICO Customer Portal** is a *new-customer registration and approval-workflow tracker*: it captures field requests and routes them Salesman → Supervisor → Accountant → RoutePro, recording that a human created/activated the customer in the external **Temix/RoutePro ERP**. It is deliberately **not** the master-data store — it never writes `CustomerMaster` from the workflow. The NEW **NMWC Customer Master** is a *field-driven enrichment/cleanup tool* over a pre-loaded ~3,000-record master that **it owns**: approved edits write directly to `Customer`/`Branch`, but it has **no way to create a customer from the field** (import-only). They are complementary halves of one lifecycle, not competing versions.

**Architectures.** Both are Next.js/Prisma/Vercel serverless apps. OLD: Next 14 / NextAuth 4 / Prisma 5, request-centric schema (13 tables, **no enums**), Vercel Blob, no observability, and a blocking **Postgres-schema/SQLite-env** contradiction plus a non-replayable migration history. NEW: Next 15 / Auth.js 5 (beta) / Prisma 6, customer+branch schema (16 models, **11 enums**, DB CHECKs/triggers, optimistic locking, soft-delete, immutable audit), Cloudflare R2, Sentry + pino, replayable migrations, backup + restore-drill — and it is the one actually **live in a Muscat pilot**.

**Workflows.** OLD = a 17-status request lifecycle with 3-tier approval (+ ERP activation), duplicate-gated submission, and an SLA/escalation design **that never runs in production** (POST-only crons). NEW = a 5-state `CustomerEdit` engine with single-tier approval, Steward/Manager direct-write, and separate photo-evidenced close/reactivate flows — **no notifications and no SLA at all**.

**Data structures.** Different customer keys (`temixCode` vs `nmwcCode`), different org units (Depot vs Region), different branch modeling (parent-code string vs first-class Branch, currently flattened 1:1), booleans-vs-counts for equipment, String-vs-enum typing, and **cash/credit exists only in NEW** (and only as a field-lock signal).

**Major contradictions & weaknesses.** 20 logged in Section H — the load-bearing ones are identity key, system-of-record, presence of creation, role set, approval tiers, and cash/credit. The most serious weaknesses are the **two committed-secret exposures** (OLD's signing key; NEW's shared pilot passwords), the **two non-functional rate limiters**, NEW's **Manager scope hole**, OLD's **dead crons / dead email / broken deployment config**, and the **absence of any ERP integration in either**.

**Reusable elements.** From NEW (the recommended base): the normalized master + branch model, enum/migration discipline, RBAC + scope + field locks, immutable audit, R2 photo-integrity pipeline, import/export/steward tooling, backup automation, and observability. From OLD (to port as net-new onto NEW): the **field-originated new-customer creation workflow**, an **optional finance/Accountant approval tier**, and the **SLA/escalation + notification** concepts (rebuilt correctly).

**Information still required.** The blocking business decisions in Section N — above all whether field-originated creation is required, the role crosswalk, branch cardinality, and the ERP system-of-record contract — plus three runtime facts to verify against live infrastructure: OLD's real production database; whether `nmwcCode` already equals `temixCode`; and whether the committed secrets/passwords match live values (so rotation can be prioritized).

---

*End of Discovery Report. This phase is assessment only — no integration, migration, schema change, or deployment has been performed or is recommended without the Section N confirmations. Full per-dimension evidence with `file:line` citations is in [`docs/discovery/raw-evidence/`](raw-evidence/).*
