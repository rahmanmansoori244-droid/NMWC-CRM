# NMWC Customer Master — Data Model & Data Dictionary (Section E)

System root: `C:\Users\abdulr\Desktop\NMWC-CRM`
Primary source: `prisma/schema.prisma` (508 lines) + `prisma/migrations/*` (8 migrations, migrations ARE used — see `prisma/migrations/migration_lock.toml`). DB = PostgreSQL. Prisma client generator.

Evidence tags: [Confirmed]=read in code; [Highly likely]; [Possible]; [Unknown].

---

## 1. Inventory: 16 models + 11 enums [Confirmed]

**Enums** (`schema.prisma:15-106`): `Role`(SALESMAN/SUPERVISOR/MANAGER/STEWARD/VIEWER), `PaymentTerms`(CASH/CREDIT), `CustomerStatus`(ACTIVE/CLOSED/SUSPENDED), `DayOfWeek`(SAT..FRI), `EditState`(DRAFT/SUBMITTED/APPROVED/REJECTED/NEEDS_CORRECTION), `EditTarget`(CUSTOMER/BRANCH), `AttachmentKind`(SHOP/SIGNBOARD/CR/FREE), `ImportRowState`(PENDING/CLEAN/QUARANTINED/PROMOTED/REJECTED), `AuditAction`(19 values incl. LOGIN_FAIL/SESSION_REVOKE/DELETE/SOFT_DELETE/PHOTO_VIEW), `ImportBatchStatus`, `ExportJobStatus`.

**Models**: Region, Route, User, PasswordHistory, SavedView, Channel, SubChannel, Customer, Branch, CustomerEdit, Attachment, ImportBatch, ImportRow, RateLimit, ExportJob, AuditLog. Plus implicit M:N join `_ManagerRegions` (User↔Region, `migration.sql init:_ManagerRegions`).

---

## 2. Preliminary Data Dictionary (entity → key fields → purpose)

### Customer (`schema.prisma:244-292`) — the master legal entity [Confirmed]
| Field | Type | Notes |
|---|---|---|
| `id` | cuid PK | |
| `nmwcCode` | String @unique | **PRIMARY CUSTOMER IDENTIFIER** (business key) |
| `legalName` | String, @@index (btree partial on deletedAt IS NULL, `perf_btree_legalname` + trgm idx) | PII/commercial |
| `paymentTerms` | enum CASH/CREDIT @default(CASH), @@index | **credit/financial field** |
| `crNumber` / `crNumberNorm` | String? | Commercial Registration #; norm for dedupe (`services/duplicates.ts:119`, `edits.ts:521`) |
| `channelId`/`subChannelId` | FK? SET NULL | taxonomy |
| `primaryPhone`/`primaryPhoneNorm` | String? | PII; norm used for dup detection (`duplicates.ts:138`, `edits.ts:332`) |
| `altPhone` | String? | PII; displayed `customers/[id]/page.tsx:116` |
| `contactPerson`/`contactRole` | String? | PII; edit form `EnrichmentForm.tsx:497` |
| `status` | enum @default(ACTIVE), @@index([status,deletedAt]) | |
| `notes` | Text? | |
| `completenessScore` | Int @default(0) | data-quality metric (39 refs) |
| `version` | Int @default(0) | **optimistic lock (B-05)** incremented on UPDATE |
| `importBatchId` | String? | lineage — **loose scalar, NO @relation FK** |
| `importRowId` | String? @unique | 1:1 lineage to ImportRow |
| `crPhotoId` | String? @unique | 1:1 CR photo slot |
| `createdAt/updatedAt` | @default(now)/@updatedAt | |
| `createdById`/`lastEditedById` | String? | **created-by/modified-by, loose scalars, NO @relation FK** |
| `deletedAt` | DateTime? | **soft-delete** |

### Branch (`schema.prisma:294-349`) — physical outlet under a Customer [Confirmed]
Identifiers: `branchCode` @unique (**branch business key**), `customerId` FK RESTRICT. Territory: `regionId` FK, `routeId` FK (both RESTRICT). Address: `address` Text (CHECK minlength, B-20), `areaDescription` Text?. GPS: `gpsLat/gpsLng/gpsAccuracy/gpsCapturedAt` (lat/lng CHECK range ±90/±180, `senior_audit_remediation`). Ops: `dayOfVisit` enum, `openingHours`, `deliveryWindow`, `coolersCount/standsCount/emptyBottlesCount` Int@0 (equipment/asset counts). Photo slots (all @unique 1:1): `shopPhotoId`, `signboardPhotoId`. `status`, `completenessScore`, `lastStatusChangeAt` (EL-11/12 reactivation guard). `version` optimistic lock. Audit: createdAt/updatedAt/`createdById`/`lastEditedById` (loose)/`deletedAt` soft-delete. **DB trigger `branch_region_consistency_check`** enforces Branch.regionId == Route.regionId (`senior_audit_remediation`).

### User (`schema.prisma:140-185`) [Confirmed]
`id`, `username` @unique (**user identifier**), `passwordHash` (**SENSITIVE**), `fullName`, `role`, `isActive`, `email` String? @unique (PII), `phone` String? (PII), `lastLoginAt`, `sessionsRevokedAt` (AUTH-12 JWT freshness/revocation), `mustChangePassword` (AUTH-09). Hierarchy self-relation `supervisorId`→reports. `ownedRouteId` String? @unique (**salesman 1:1 route ownership**). M:N `managedRegions`. @@index([role,isActive]).

### CustomerEdit (`schema.prisma:352-381`) — approval workflow / change request [Confirmed]
`target` enum, `customerId?`/`branchId?`, `state` enum @default(DRAFT), `submittedById` FK, `reviewedById?` FK, `submittedAt/reviewedAt`, `decisionReason` Text?, `decisionCategory` String?, `fieldChanges` Json, `attachmentChanges` Json, `isReactivation`, `isWrongRoute`, `newRouteId`. Partial unique `CustomerEdit_open_per_customer` (one SUBMITTED per customer, `qa_remediation:12`).

### Attachment (`schema.prisma:384-421`) — photo/document records [Confirmed]
`kind` enum, **denormalized `customerId`/`branchId`/`branchExtraId`**, `r2Key` @unique (R2/S3 object key), `mimeType`, `bytes`, `width?`/`height?`, `capturedById` FK, `capturedAt`, `capturedLat/Lng` (CHECK range), `hash` (sha256 dedup, `Attachment_hash_idx`), `deletedAt` soft-delete (UXI-008, replaced `__deleted__/` sentinel — backfilled in `pre_launch_hardening:28`).

### Support tables [Confirmed]
- **PasswordHistory** (`190-199`): reuse prevention (B-15), `onDelete: Cascade`.
- **SavedView** (`204-214`): per-user `/customers` filter snapshots (`urlParams` Text), Cascade.
- **Channel/SubChannel** (`217-241`): locked taxonomy from PRD Appendix A.
- **ImportBatch/ImportRow** (`424-459`): bulk import. `ImportBatch.kind` = loose String default "CUSTOMER" ("ACCOUNT" also written `services/imports.ts:114,479`). `ImportRow.raw/parsed/issues` Json.
- **RateLimit** (`465-470`): durable token-bucket, key PK; used via raw SQL `lib/rate-limit.ts:85`.
- **ExportJob** (`473-486`): async xlsx export jobs.
- **AuditLog** (`489-507`): immutable audit; `before/after` Json, `ip`/`userAgent`, actor FK RESTRICT, 3 indexes.

---

## 3. PII & commercially-sensitive fields [Confirmed]
- **PII**: Customer.legalName, primaryPhone/altPhone/*Norm, contactPerson/contactRole; User.fullName/email/phone; Branch.address/gps*; Attachment.capturedLat/Lng (person location at capture).
- **Commercial-sensitive**: Customer.paymentTerms (CASH/CREDIT = credit terms), crNumber, notes, completenessScore; Branch equipment counts (coolers/stands/emptyBottles = asset placement).
- **Secrets**: User.passwordHash, PasswordHistory.hash — hashes only (not plaintext), acceptable. See §6.

---

## 4. Problems / risks

### 4.1 Fields COLLECTED BUT NOT USED (schema/DB only, never in app logic) [Confirmed]
- **`CustomerEdit.newRouteId`** (`schema.prisma:368`): defined in schema + DDL (`add_customer...:102`) but **zero reads/writes** in `app/`, `lib/`, `services/`. Only appears in migration DDL. DEAD FIELD — wrong-route reassignment target never wired up.
- **`CustomerEdit.isWrongRoute`** (`schema.prisma:367`): only in schema, DDL, and dev scripts (`prisma/inspect-pending-edit.ts`, seed) — **never in application services/UI**. DEAD FLAG.
- **`CustomerEdit.decisionCategory`** (`schema.prisma:363`): **write-only** — set at `services/edits.ts:966` and seeded, but **never displayed** in any `app/` or `components/` view (grep = 0 UI hits). Collected, not surfaced.

### 4.2 Referential-integrity gaps [Confirmed]
- **`Attachment.customerId` and `Attachment.branchId` are loose scalar columns with NO `@relation`/FK** (`schema.prisma:387-388`; only `branchExtraId`→Branch, `capturedById`→User, and inverse single-photo relations exist). Denormalized by design (`lib/access.ts:169` comment) but DB cannot guarantee these point at live rows → orphan risk.
- **`Customer.importBatchId`** (`schema.prisma:267`): loose scalar, no relation (ImportBatch relation absent; only `importRowId` has FK).
- **`Customer.createdById/lastEditedById`, `Branch.createdById/lastEditedById`**: loose Strings, **no FK to User** (`schema.prisma:276-277,333-334`) — created/modified-by not referentially enforced; user deletion won't null them.

### 4.3 Weak / conflicting identifiers & naming [Confirmed / Possible]
- **`ImportBatch.kind`** is an untyped `String` default "CUSTOMER" (`schema.prisma:427`) while sibling status fields were hardened to enums (B-18). Values "CUSTOMER"/"ACCOUNT" are magic strings.
- **`Attachment` triple-denormalization** (`customerId`/`branchId`/`branchExtraId`) is confusing: `branchExtraId` AND `branchId` are both set for FREE photos (`services/photos.ts:217`), overlapping semantics.
- `CustomerStatus` enum is reused for BOTH Customer.status and Branch.status (`schema.prisma:258,320`) — SUSPENDED semantics may differ per entity (unclear/[Possible]).

### 4.4 Migration / data-loss risks [Confirmed]
- **Phone uniqueness reversed**: `Customer_primaryPhoneNorm_active_unique` UNIQUE created in `qa_remediation` (`:18`) then **DROPPED** in `p1_drop_phone_unique` (`20260510160000`), replaced with non-unique index. Phone is no longer a unique key anywhere — dedupe is now advisory only (`services/duplicates.ts`). Intentional but weakens identifier.
- Partial unique `CustomerEdit_open_per_customer` guards only `customerId IS NOT NULL` (`qa_remediation:14`) — **no equivalent DB guard for branch-target open edits** (branchId). Concurrent duplicate branch edits possible at DB level.
- Attachment soft-delete migrated from `r2Key='__deleted__/...'` sentinel to `deletedAt` column with backfill (`pre_launch_hardening:28`); both mechanisms coexist → dual-path complexity ([Possible] stale sentinel rows).

### 4.5 Missing relationships [Confirmed]
- `ImportRow.promotedCustomer Customer?` (`schema.prisma:456`) is the back-relation of `Customer.importRowId`; fine. But there is **no relation from Customer→ImportBatch** despite `importBatchId` being stored.

---

## 5. Migrations vs db push [Confirmed]
8 timestamped migrations present under `prisma/migrations/` with `migration_lock.toml` (postgresql) → **migration-based workflow**, not `db push`. Several later migrations are hand-written idempotent SQL (DO-blocks, `IF NOT EXISTS`, triggers, trigram/btree/partial indexes, CHECK constraints) that go **beyond what schema.prisma expresses** — e.g. GPS range CHECKs, address minlength, `branch_region_consistency_check` trigger, pg_trgm indexes, partial unique indexes. **These DB invariants are invisible if you read only schema.prisma.**

---

## 6. Secrets check [Confirmed]
- No `.env` tracked in git — `git ls-files` shows only `.env.example`; `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`. Good.
- DB creds via `env("DATABASE_URL")` / `env("DIRECT_URL")` (`schema.prisma:10-11`) — not hardcoded.
- `.env.example` present (1.7 KB) — placeholders only (not opened in full; recommend confirming it holds no real values). No secret VALUES surfaced in schema/migrations.

---

## 7. Confirmed facts vs inference
- **Confirmed**: all field/type/index/FK/enum listings; dead fields newRouteId/isWrongRoute; write-only decisionCategory; Attachment loose FKs; phone-unique add-then-drop; migration workflow; no committed .env.
- **Reasonable inference**: nmwcCode = primary business identifier; completenessScore = data-quality %; ImportBatch.kind ACCOUNT = financial/AR import lane.
- **Unverified assumption**: exact semantic difference of SUSPENDED between Customer vs Branch; whether stale `__deleted__/` sentinel Attachment rows still exist in prod (verify via DB query `SELECT count(*) WHERE r2Key LIKE '__deleted__/%' AND deletedAt IS NULL`).
- **Missing info**: `.env.example` full contents not exhaustively read; runtime cardinality of orphaned Attachments (needs DB access).
