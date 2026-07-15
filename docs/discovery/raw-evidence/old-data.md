# OLD (ICO Customer Portal) — Data Model & Data Dictionary (Section E)

System root: `C:\Users\abdulr\Desktop\ICO\customer-portal`
Schema file: `prisma/schema.prisma` (317 lines). Prisma client 5.16.1, `@prisma/client`. Datasource provider declared **postgresql** (`schema.prisma:5-8`).

## 0. CONFIRMED FACTS vs INFERENCES vs ASSUMPTIONS vs MISSING
- **CONFIRMED**: 12 models, 0 enums (all categorical values are `String`). Read directly from schema.
- **CONFIRMED**: `.env` committed to git; provider mismatch (schema=postgres, `.env` DATABASE_URL=`file:...` SQLite; `prisma/dev.db` present, 344 KB).
- **INFERENCE**: field meanings/purposes below inferred from code usage; tagged where inferred.
- **MISSING**: no `0_init` migration — base tables were created via `db push`, not migrations (cannot verify original DDL for base tables).

## 1. Models / Entities (12)

| Model | PK | Purpose (inferred) |
|---|---|---|
| Depot | `id` cuid | Distribution depot/branch. `code` @unique. `primaryAccountantId` @unique → routing target. |
| Route | `id` cuid | Sales route/territory. `code` @unique. FKs salesman/supervisor/accountant/depot/upload. |
| User | `id` cuid | All actors (SALESMAN/SUPERVISOR/ACCOUNTANT/ADMIN). `email` @unique. Self-rel `TeamHierarchy`. |
| CustomerMaster | `id` cuid | Master customer record (Temix master data). `temixCode` @unique. |
| MasterUpload | `id` cuid | Bulk upload batch (customers/routes). |
| RequestSequence | `year` (Int PK) | Per-year running counter for request numbers. |
| CustomerRequest | `id` cuid | Core workflow entity: new-customer / update requests. `requestNumber` @unique, `temixCode` @unique(partial). |
| RequestPhoto | `id` cuid | Attachments (fileUrl/fileKey) per request. |
| StatusHistory | `id` cuid | Audit trail of status transitions. |
| DuplicateMatch | `id` cuid | Dedupe match records per request. |
| Notification | `id` cuid | In-app notifications. |
| RateLimitAttempt | none (composite `@@unique([key,windowStart])`) | DB-backed login rate limiter. |
| AdminAuditLog | `id` cuid | Admin mutation audit (write-only, see finding). |

(That is 13 rows; RateLimitAttempt + AdminAuditLog are the two infra/audit tables added by later migrations.)

## 2. Customer identifiers (weak identifier risk)
- **`CustomerMaster.temixCode`** `String @unique` (`schema.prisma:87`) — the canonical customer key. Used 9× via `prisma.customerMaster`.
- **`CustomerRequest.temixCode`** `String? @unique` partial index (`schema.prisma:185`, migration `20260409...`). Also `parentTemixCode`, `existingTemixCode` (`schema.prisma:177-178`) for split/update linkage — **plain strings, NO FK** to CustomerMaster ⇒ referential-integrity gap (a request's temix references are not enforced against `CustomerMaster.temixCode`). [Confirmed]
- **`crNumber`** (Commercial Registration) on both CustomerMaster (`:90`) and CustomerRequest (`:171`), `String?`, indexed. Used in dup-check. PII/commercially-sensitive.
- **`routeCode`** (CustomerMaster `:91`) is a **denormalized string**, not FK to `Route.code`. Scoping queries filter `routeCode { in: scopeCodes }` (`app/api/customers/route.ts:51,75`). Duplicate of Route.code concept → confusing/weak. [Confirmed]

## 3. Field-level data dictionary — CustomerRequest (largest, `schema.prisma:137-219`)
Key groups (all inferred meaning unless noted):
- Contact/PII: `customerName, contactPerson, primaryPhone, alternatePhone?, address, areaDescription?` — **PII**.
- Classification: `channel, subChannel, dayOfVisit, openingHours?, deliveryWindow?`.
- GPS: `gpsLat?, gpsLng?, gpsAccuracy?, gpsCapturedAt?` (Float/DateTime) — all used (write `app/api/requests/route.ts:209`, read `requests/[id]/page.tsx:339`). Location PII.
- Equipment: `coolerRequired, standRequired, emptyBottlesRequired` Boolean default false.
- Dedupe: `duplicateRisk @default("NONE"), duplicateNotes?, supervisorOverrideDuplicate, supervisorOverrideReason?`.
- Update flow: `updateCategory?, changesSummary?` (JSON-as-String — **untyped JSON in a String col**, `:190-191`), `correctionCount @default(0)`.
- Workflow timestamps: `submittedAt, supervisorActedAt, accountantActedAt, temixCreatedAt, routeproActivatedAt, closedAt, escalatedAt` (all `DateTime?`).
- SLA: `supervisorSlaBreached, accountantSlaBreached` Boolean; used in `lib/sla.ts`, cron.
- Status: `status String @default("DRAFT")` (`:141`) — **String, no enum/DB constraint**.
- Indexes: salesmanId, supervisorId, accountantId, depotId, status, crNumber, submittedAt (`:212-218`).

## 4. Status / timestamps / created-by / soft-delete / audit
- **Timestamps**: every core model has `createdAt @default(now())`; mutable models have `updatedAt @updatedAt`. RequestPhoto/StatusHistory/DuplicateMatch/Notification/AdminAuditLog have `createdAt`-only (append-only). [Confirmed]
- **Created-by / modified-by**: `MasterUpload.uploadedById`, `RequestPhoto.uploadedById?`, `StatusHistory.changedById`, `DuplicateMatch.reviewedById?`, `AdminAuditLog.actorId`. There is **no createdBy/modifiedBy on CustomerRequest or CustomerMaster** — provenance is reconstructed only via `salesmanId` + StatusHistory. [Confirmed]
- **Soft-delete/archival**: implemented as `isActive Boolean @default(true)` on Depot/Route/User/CustomerMaster. **CustomerRequest has NO isActive/soft-delete** — no archival flag for requests. `CustomerMaster.pendingUpdate` + `lastPortalUpdateAt` track in-flight portal edits (used `:104-105`). [Confirmed]
- **Audit/history tables**: `StatusHistory` (used 11×, read+write) and `AdminAuditLog`.

## 5. FINDINGS / PROBLEMS

### 5.1 Collected-but-UNUSED fields (verified by grep across app/lib/components)
- **`DuplicateMatch.reviewedById`, `reviewedAt`, `resolution`** (`schema.prisma:258-261`) — **never written anywhere** (grep of `reviewedById|reviewedAt|resolution:` in app/lib = 0 hits). The `reviewedBy` User relation + `duplicateReviews` back-relation (`User:76`) are dead. Dedupe resolution is instead stored on CustomerRequest (`supervisorOverrideDuplicate/Reason`, `duplicateNotes`). ⇒ orphan review-workflow columns. [Confirmed]
- **`AdminAuditLog`** is **write-only**: only `prisma.adminAuditLog.create` in `lib/audit-log.ts:21`; no findMany/read, no UI. Audit data captured but never surfaced. [Confirmed — Possible that intended read UI is missing]
- `escalatedAt` written in exactly one place (`app/api/admin/requests/[id]/escalate/route.ts:83`), never read for display. [Confirmed] — low-value but not dead.

### 5.2 Enum flattening / weak typing (major)
- Schema declares **zero enums**; `status`, `type`, `role`, `duplicateRisk`, `channel`, `matchType`, `updateCategory`, `temixCreationType` are all bare `String`. Type-safety exists only in TS: `RequestType`/`Role` are TS union types (`types/index.ts:3`, `lib/auth.ts` casts `user.role as Role`). ⇒ **no DB-level constraint**; any string can be persisted. [Confirmed]
- **Migration/schema drift**: migration `20260405000000_add_update_existing_type/migration.sql` runs `ALTER TYPE "RequestType" ADD VALUE 'UPDATE_EXISTING'` — references a **Postgres enum `RequestType` that does not exist in the current schema** (schema uses String). Base tables also have no init migration. ⇒ `prisma migrate deploy` on a clean DB would **fail**; current DB was provisioned by `db push` (`package.json` `db:push`, `db:reset --force-reset`). Migration history is inconsistent/non-replayable. [Confirmed — high migration/data-loss risk]

### 5.3 Provider / environment mismatch (deployment risk)
- `schema.prisma:6` + `prisma/migrations/migration_lock.toml` = **postgresql**, but committed `.env` `DATABASE_URL="file:..."` (SQLite) and `prisma/dev.db` (SQLite, 344 KB) exist. Raw SQL in `lib/rate-limit.ts:33-36` uses Postgres `INSERT ... ON CONFLICT ... DO UPDATE` and `$queryRaw` (also `app/api/cron/daily-summary/route.ts:74`) ⇒ app is Postgres-targeted; the SQLite `.env` would break rate-limiting/raw queries. The committed `.env` is stale/dev and inconsistent with production target. [Confirmed]

### 5.4 Referential integrity gaps / denormalization
- `CustomerRequest.parentTemixCode / existingTemixCode / temixCode` and `CustomerMaster.routeCode / salesmanName` are **denormalized strings with no FK**. `salesmanName` (`:92`) duplicates `User.name`; `routeCode` duplicates `Route.code`. Risk of drift. [Confirmed]
- `CustomerRequest` FKs (route/supervisor/accountant/depot) are **all nullable** (`:145-152`) ⇒ requests can exist unassigned; integrity relies on app logic only.

### 5.5 PII / commercially-sensitive inventory
- **PII**: customerName, contactPerson, primaryPhone, alternatePhone, address, areaDescription, GPS lat/lng/accuracy, User.email, User.name. `AdminAuditLog.ipAddress/userAgent` (`:309-310`).
- **Commercially-sensitive**: crNumber (CR), temixCode, channel/subChannel, routeCode, salesman assignments, depot structure, credit/equipment flags.
- **Credentials**: `User.passwordHash` (`:54`) bcrypt.
- Note: schema has **no explicit financial/credit-limit fields** (no creditLimit/balance/paymentTerms) — credit data is out-of-scope of this portal. [Confirmed]

## 6. SECURITY (redacted)
- **`.env` is committed to git** (`git ls-files` shows `.env`; `.gitignore` ignores only `.env.local`, not `.env`). File `C:\Users\abdulr\Desktop\ICO\customer-portal\.env` contains secrets:
  - `DATABASE_URL="fil…"` (redacted) — remediation: rotate DB creds, remove from git history, gitignore `.env`.
  - `NEXTAUTH_SECRET="hj…"` — rotate; app-session forging risk.
  - `CRON_SECRET="b0…"` — rotate; protects cron endpoints.
  - `SMTP_USER` / `SMTP_PASS` (empty in this copy but present as keys).
- Remediation: purge `.env` from history (git filter-repo/BFG), rotate ALL of the above, add `.env` to `.gitignore`, use deployment secret store.

## 7. MISSING INFORMATION / how to verify
- Exact original DDL of base tables (no init migration) — verify via `prisma migrate diff` against a fresh DB or inspect `prisma/dev.db` schema.
- Whether production actually runs Postgres — verify Vercel/host env `DATABASE_URL` (not in repo).
- Allowed value sets for String-typed status/channel/etc — enforced only in `types/index.ts` + Zod (verify `lib/validation*`).
