# NMWC Customer Master — Technical Specification (Phase 4 + 5)
**Version:** 1.0
**Date:** 2026-05-09
**Status:** For owner sign-off — covers architecture, schema, API, and build plan.

---

## 1. High-level Architecture

```
                       ┌─────────────────────────┐
                       │     Browser (mobile)    │
                       │   Next.js client (PWA)  │
                       │   IndexedDB drafts      │
                       └────────────┬────────────┘
                                    │ HTTPS
                                    ▼
        ┌──────────────────────────────────────────────┐
        │            Vercel — Next.js 15               │
        │  ┌────────────────┐  ┌──────────────────┐   │
        │  │  React Server  │  │   Server Actions │   │
        │  │   Components   │  │  + Route Handlers│   │
        │  └────────┬───────┘  └─────────┬────────┘   │
        │           ▼                    ▼             │
        │  ┌────────────────────────────────────────┐ │
        │  │  Service Layer (domain logic)          │ │
        │  │  ┌──────────┐ ┌────────┐ ┌──────────┐ │ │
        │  │  │customers │ │approvals│ │imports   │ │ │
        │  │  └──────────┘ └────────┘ └──────────┘ │ │
        │  └────────────────────────────────────────┘ │
        │           ▼                                  │
        │  ┌────────────────────────────────────────┐ │
        │  │  Repository Layer (Prisma)             │ │
        │  └────────────────────────────────────────┘ │
        └────────┬─────────────────┬───────────────────┘
                 │                 │
                 ▼                 ▼
       ┌─────────────────┐  ┌──────────────────┐
       │ Neon Postgres   │  │ Cloudflare R2    │
       │ (master DB)     │  │ (photos, exports)│
       └─────────────────┘  └──────────────────┘
                 │
                 ▼
       ┌─────────────────┐
       │ Sentry / Logs   │
       └─────────────────┘
```

**Key principles:**
- **Single deployable** for v1 (Next.js fullstack). API can be split out later if needed.
- **Service layer** is the source of truth for business logic. Routes/Server Actions are thin.
- **Repository layer** wraps Prisma; nothing else touches Prisma directly. Makes mocking trivial in tests.
- **Validation always at the API boundary** with Zod. Same Zod schema reused on the client for form validation.
- **Photos go direct to R2** via presigned PUT URLs; the server only stores metadata.
- **All writes wrapped in Prisma transactions** when they touch multiple tables.

---

## 2. Folder Structure

```
nmwc-cm/
├── app/                          ← Next.js App Router
│   ├── (auth)/
│   │   └── login/page.tsx
│   ├── (salesman)/
│   │   ├── today/page.tsx
│   │   ├── customers/[id]/...
│   │   ├── work/page.tsx
│   │   └── rejected/page.tsx
│   ├── (supervisor)/
│   │   ├── approvals/...
│   │   └── reassignments/page.tsx
│   ├── (manager)/
│   │   ├── dashboard/page.tsx
│   │   ├── reactivations/page.tsx
│   │   ├── users/page.tsx
│   │   ├── routes/page.tsx
│   │   └── audit/page.tsx
│   ├── (steward)/
│   │   ├── import/...
│   │   ├── duplicates/page.tsx
│   │   └── export/page.tsx
│   ├── api/                      ← Route handlers (only when needed)
│   │   ├── auth/[...nextauth]/route.ts
│   │   ├── photos/presign/route.ts
│   │   ├── exports/[id]/download/route.ts
│   │   └── health/route.ts
│   └── layout.tsx
├── components/
│   ├── ui/                       ← shadcn primitives (untouched)
│   ├── nmwc/                     ← custom components
│   │   ├── CompletenessRing.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── PaymentTermsPill.tsx
│   │   ├── PhotoCaptureSlot.tsx
│   │   ├── GpsCaptureButton.tsx
│   │   ├── DiffField.tsx
│   │   ├── EditableField.tsx
│   │   └── TopBar.tsx / BottomTabBar.tsx
│   └── forms/                    ← form components per entity
├── lib/
│   ├── db.ts                     ← Prisma client singleton
│   ├── auth.ts                   ← Auth.js config
│   ├── r2.ts                     ← R2 client + presign helpers
│   ├── validation/               ← Zod schemas (shared client+server)
│   │   ├── customer.ts
│   │   ├── branch.ts
│   │   ├── edit.ts
│   │   └── import.ts
│   ├── permissions.ts            ← role checks
│   ├── completeness.ts           ← scoring function (pure)
│   ├── phone.ts                  ← Oman phone normalization
│   ├── cr.ts                     ← CR normalization
│   ├── logger.ts                 ← pino instance
│   └── errors.ts                 ← error classes + handlers
├── services/                     ← business logic
│   ├── customers.ts
│   ├── branches.ts
│   ├── edits.ts                  ← submit/approve/reject
│   ├── imports.ts
│   ├── exports.ts
│   ├── duplicates.ts
│   ├── work-items.ts             ← computed inbox queries
│   └── audit.ts
├── repositories/                 ← Prisma access layer
│   ├── customer.repo.ts
│   ├── edit.repo.ts
│   ├── import.repo.ts
│   └── audit.repo.ts
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/                      ← Playwright
├── scripts/
│   ├── seed-channels.ts
│   └── backup-export.ts
├── .env.example
├── .github/workflows/ci.yml
└── package.json
```

---

## 3. Database Schema (Prisma)

Below is the full Prisma schema. PostgreSQL on Neon.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ── ENUMS ──────────────────────────────────────────────
enum Role {
  SALESMAN
  SUPERVISOR
  MANAGER
  STEWARD
  VIEWER
}

enum PaymentTerms { CASH CREDIT }
enum CustomerStatus { ACTIVE CLOSED SUSPENDED }
enum DayOfWeek { SAT SUN MON TUE WED THU FRI }
enum EditState { DRAFT SUBMITTED APPROVED REJECTED NEEDS_CORRECTION }
enum EditTarget { CUSTOMER BRANCH }
enum AttachmentKind { SHOP SIGNBOARD CR FREE }
enum ImportRowState { PENDING CLEAN QUARANTINED PROMOTED REJECTED }
enum AuditAction { CREATE UPDATE APPROVE REJECT IMPORT MERGE REASSIGN CLOSE REACTIVATE LOGIN LOGOUT FORCE_OVERRIDE }

// ── CORE ───────────────────────────────────────────────
model User {
  id            String   @id @default(cuid())
  username      String   @unique
  passwordHash  String
  fullName      String
  role          Role
  isActive      Boolean  @default(true)
  email         String?
  phone         String?
  // Hierarchy: salesman has supervisor; supervisor has manager
  supervisorId  String?
  supervisor    User?    @relation("UserHierarchy", fields: [supervisorId], references: [id])
  reports       User[]   @relation("UserHierarchy")
  // Salesman owns exactly one route
  ownedRouteId  String?  @unique
  ownedRoute    Route?   @relation("RouteOwner", fields: [ownedRouteId], references: [id])
  // Manager assigned regions (many-to-many)
  managedRegions Region[] @relation("ManagerRegions")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastLoginAt   DateTime?

  submittedEdits  CustomerEdit[] @relation("EditSubmitter")
  reviewedEdits   CustomerEdit[] @relation("EditReviewer")
  auditLogs       AuditLog[]

  @@index([role, isActive])
}

model Region {
  id        String  @id @default(cuid())
  name      String  @unique
  code      String  @unique
  routes    Route[]
  managers  User[]  @relation("ManagerRegions")
  branches  Branch[]
  createdAt DateTime @default(now())
}

model Route {
  id        String  @id @default(cuid())
  name      String
  code      String  @unique
  regionId  String
  region    Region  @relation(fields: [regionId], references: [id])
  owner     User?   @relation("RouteOwner")
  branches  Branch[]
  createdAt DateTime @default(now())

  @@unique([regionId, code])
  @@index([regionId])
}

model Channel {
  id          String       @id @default(cuid())
  key         String       @unique  // e.g. HORECA, MODERN_TRADE
  label       String
  displayOrder Int
  isActive    Boolean      @default(true)
  subChannels SubChannel[]
  customers   Customer[]
}

model SubChannel {
  id        String   @id @default(cuid())
  key       String
  label     String
  channelId String
  channel   Channel  @relation(fields: [channelId], references: [id])
  isActive  Boolean  @default(true)
  customers Customer[]

  @@unique([channelId, key])
}

// ── CUSTOMER & BRANCH ─────────────────────────────────
model Customer {
  id              String          @id @default(cuid())
  nmwcCode        String          @unique
  legalName       String
  paymentTerms    PaymentTerms
  crNumber        String?
  crNumberNorm    String?         // normalized for dedupe
  crPhotoId       String?         @unique
  crPhoto         Attachment?     @relation("CrPhoto", fields: [crPhotoId], references: [id])
  channelId       String?
  channel         Channel?        @relation(fields: [channelId], references: [id])
  subChannelId   String?
  subChannel      SubChannel?     @relation(fields: [subChannelId], references: [id])
  primaryPhone    String?
  primaryPhoneNorm String?         // normalized; used in unique partial index
  altPhone        String?
  contactPerson   String?
  contactRole     String?
  status          CustomerStatus  @default(ACTIVE)
  notes           String?         @db.Text
  completenessScore Int           @default(0)
  // Lineage
  importBatchId   String?
  importRowId     String?         @unique
  importRow       ImportRow?      @relation(fields: [importRowId], references: [id])
  // Audit fields
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  createdById     String?
  lastEditedById  String?
  deletedAt       DateTime?

  branches        Branch[]
  edits           CustomerEdit[]

  @@index([status, deletedAt])
  @@index([channelId])
  @@index([legalName])
}

model Branch {
  id              String          @id @default(cuid())
  customerId      String
  customer        Customer        @relation(fields: [customerId], references: [id])
  branchCode      String          @unique
  branchName      String
  regionId        String
  region          Region          @relation(fields: [regionId], references: [id])
  routeId         String
  route           Route           @relation(fields: [routeId], references: [id])
  address         String          @db.Text
  areaDescription String?         @db.Text
  gpsLat          Float?
  gpsLng          Float?
  gpsAccuracy     Float?
  gpsCapturedAt   DateTime?
  dayOfVisit      DayOfWeek?
  openingHours    String?
  deliveryWindow  String?
  coolersCount    Int             @default(0)
  standsCount     Int             @default(0)
  emptyBottlesCount Int           @default(0)
  shopPhotoId     String?         @unique
  signboardPhotoId String?        @unique
  shopPhoto       Attachment?     @relation("ShopPhoto", fields: [shopPhotoId], references: [id])
  signboardPhoto  Attachment?     @relation("SignboardPhoto", fields: [signboardPhotoId], references: [id])
  status          CustomerStatus  @default(ACTIVE)
  completenessScore Int           @default(0)
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  createdById     String?
  lastEditedById  String?
  deletedAt       DateTime?

  extraPhotos     Attachment[]    @relation("BranchExtraPhotos")
  edits           CustomerEdit[]

  @@index([routeId, status, deletedAt])
  @@index([customerId])
}

// ── EDITS / APPROVAL ─────────────────────────────────
model CustomerEdit {
  id              String      @id @default(cuid())
  target          EditTarget
  customerId      String?
  customer        Customer?   @relation(fields: [customerId], references: [id])
  branchId        String?
  branch          Branch?     @relation(fields: [branchId], references: [id])
  state           EditState   @default(DRAFT)
  submittedById   String
  submittedBy     User        @relation("EditSubmitter", fields: [submittedById], references: [id])
  submittedAt     DateTime?
  reviewedById    String?
  reviewedBy      User?       @relation("EditReviewer", fields: [reviewedById], references: [id])
  reviewedAt      DateTime?
  decisionReason  String?     @db.Text
  decisionCategory String?    // bad_photo|wrong_gps|missing_field|wrong_info|other
  fieldChanges    Json        // [{field, before, after}]
  attachmentChanges Json      // [{kind, action: ADD|REPLACE|DELETE, attachmentId}]
  isReactivation  Boolean     @default(false)
  isWrongRoute    Boolean     @default(false)
  newRouteId      String?     // for wrong-route flag
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  @@index([state, submittedAt])
  @@index([submittedById, state])
  @@index([customerId, state])
  @@index([branchId, state])
}

// ── ATTACHMENTS ──────────────────────────────────────
model Attachment {
  id            String          @id @default(cuid())
  kind          AttachmentKind
  customerId    String?         // for CR photos on Customer
  branchId      String?
  branchExtra   Branch?         @relation("BranchExtraPhotos", fields: [branchExtraId], references: [id])
  branchExtraId String?
  r2Key         String          @unique
  mimeType      String
  bytes         Int
  width         Int?
  height        Int?
  capturedById  String
  capturedAt    DateTime
  capturedLat   Float?
  capturedLng   Float?
  hash          String?         // sha256, for dedupe
  createdAt     DateTime        @default(now())

  customerCrPhoto Customer? @relation("CrPhoto")
  branchShopPhoto Branch?   @relation("ShopPhoto")
  branchSignboardPhoto Branch? @relation("SignboardPhoto")

  @@index([branchId])
  @@index([customerId])
}

// ── IMPORT ──────────────────────────────────────────
model ImportBatch {
  id          String       @id @default(cuid())
  filename    String
  uploadedById String
  uploadedAt  DateTime     @default(now())
  status      String       // PARSING / READY / PROMOTED / FAILED
  totalRows   Int
  cleanRows   Int
  quarantinedRows Int
  promotedRows Int          @default(0)
  rejectedRows Int          @default(0)
  rows        ImportRow[]
}

model ImportRow {
  id            String          @id @default(cuid())
  batchId       String
  batch         ImportBatch     @relation(fields: [batchId], references: [id])
  rowNumber     Int
  raw           Json            // original Excel row
  parsed        Json?           // typed values after validation
  state         ImportRowState  @default(PENDING)
  issues        Json?           // [{field, code, message}]
  promotedCustomerId String?
  promotedCustomer Customer? @relation
  reviewedById  String?
  reviewedAt    DateTime?
  createdAt     DateTime        @default(now())

  @@index([batchId, state])
}

// ── AUDIT ──────────────────────────────────────────
model AuditLog {
  id          String       @id @default(cuid())
  actorId     String
  actor       User         @relation(fields: [actorId], references: [id])
  action      AuditAction
  entityType  String       // "Customer", "Branch", "User", "Route", etc.
  entityId    String
  before      Json?
  after       Json?
  reason      String?
  ip          String?
  userAgent   String?
  at          DateTime     @default(now())

  @@index([entityType, entityId, at(sort: Desc)])
  @@index([actorId, at(sort: Desc)])
  @@index([action, at(sort: Desc)])
}

// ── EXPORT ──────────────────────────────────────────
model ExportJob {
  id            String   @id @default(cuid())
  requestedById String
  filters       Json
  status        String   // PENDING / RUNNING / DONE / FAILED
  r2Key         String?
  rowCount      Int?
  startedAt     DateTime @default(now())
  completedAt   DateTime?
  errorMessage  String?
}
```

### 3.1 Critical indexes (added beyond Prisma defaults)

```sql
-- Phone uniqueness across DIFFERENT customers (not branches of same customer)
CREATE UNIQUE INDEX ux_customer_phone_norm
  ON "Customer" ("primaryPhoneNorm")
  WHERE "primaryPhoneNorm" IS NOT NULL AND "deletedAt" IS NULL;

-- Trigram for fuzzy name search (dedupe + search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_customer_name_trgm ON "Customer" USING gin (legal_name gin_trgm_ops);

-- Hot path: salesman fetches his route's branches
CREATE INDEX ix_branch_route_status ON "Branch" (route_id, status) WHERE deleted_at IS NULL;

-- Approval queue
CREATE INDEX ix_edit_pending ON "CustomerEdit" (submitted_at) WHERE state = 'SUBMITTED';
```

### 3.2 Soft-delete strategy
- `deletedAt` nullable timestamp on `Customer`, `Branch`, `Attachment`.
- All queries filter `WHERE "deletedAt" IS NULL` via Prisma middleware in `lib/db.ts`.
- Hard delete only via Steward + audit log + reason.

### 3.3 Transactions
- Approval: `prisma.$transaction([applyChanges, writeAudit, updateEditState])` — atomic.
- Import promotion: per-row transaction; batch-level metadata updated separately.

---

## 4. Authentication & Authorization

### 4.1 Auth.js configuration
- Provider: `Credentials` (username + password)
- Session: JWT, 8-hour TTL during work hours; refresh on activity
- Password storage: `bcrypt` cost 12
- Session cookie: `Secure`, `HttpOnly`, `SameSite=Lax`
- `auth()` helper used in every server action / route handler

### 4.2 RBAC strategy
- `lib/permissions.ts` exports pure functions like `canApproveEdit(user, edit)`, `canEditCustomer(user, customer)`, `canSeeRoute(user, routeId)`.
- Every service-layer function takes a `User` and asserts permission as the first step.
- Throws `ForbiddenError` (mapped to 403) if denied.
- Server actions use a `withAuth(role[])` HOF for the common case.

### 4.3 Field-level locks
- Defined in `lib/permissions.ts`: e.g., `isFieldLocked(field, user, customer)` returns `true` for name/CR on Credit customers when user is Salesman.
- UI mirrors these by calling the same function via a server-fetched `lockedFields` array on the form page.

---

## 5. API Surface

We use **Next.js Server Actions** for most mutations (form submissions) and **Route Handlers** only where browsers need raw HTTP (file uploads, downloads, health). All inputs validated with Zod.

### 5.1 Server Actions (form-bound)

| Action | Module | Purpose | Inputs (Zod) |
|---|---|---|---|
| `signIn` | auth | Credentials login | `{ username, password }` |
| `signOut` | auth | End session | — |
| `submitCustomerEdit` | edits | Salesman submits an edit (or saves draft) | `EditPayloadSchema` |
| `approveEdit` | edits | Supervisor approves | `{ editId }` |
| `rejectEdit` | edits | Supervisor rejects | `{ editId, reason, category }` |
| `flagWrongRoute` | edits | Salesman flags wrong-route customer | `{ customerId, reason }` |
| `reassignRoute` | edits | Supervisor picks new route | `{ editId, newRouteId }` |
| `markCustomerClosed` | edits | Salesman closes shop with photo | `{ branchId, reason, photoId }` |
| `requestReactivation` | edits | Salesman re-opens closed shop | `{ branchId, photoId }` |
| `manageReactivation` | edits | Manager approves/denies | `{ editId, decision, reason }` |
| `forceOverride` | edits | Manager bypass | `{ editId, reason }` |
| `createUser` / `disableUser` / `resetPassword` | users | Manager user mgmt | per shape |
| `createRoute` / `updateRoute` / `assignRoute` | routes | Manager route mgmt | per shape |
| `uploadImportBatch` | imports | Steward starts import | `FormData (file)` |
| `promoteImportRows` | imports | Bulk-promote clean rows | `{ batchId, rowIds[] }` |
| `mergeDuplicate` | imports | Merge import row into existing customer | `{ rowId, targetCustomerId, mode }` |
| `requestExport` | exports | Steward generates export | `ExportFiltersSchema` |

### 5.2 Route Handlers

| Path | Method | Purpose |
|---|---|---|
| `/api/auth/[...nextauth]` | * | Auth.js session endpoints |
| `/api/photos/presign` | POST | Get presigned R2 PUT URL; body: `{ kind, mimeType, bytes }` |
| `/api/photos/finalize` | POST | After client uploads, server stores Attachment row and computes hash |
| `/api/exports/:id/download` | GET | Stream Excel from R2 with auth check |
| `/api/health` | GET | Returns `{ status: "ok", db: "ok", r2: "ok" }` for monitoring |

### 5.3 Standard error shape

```ts
type ApiError = {
  code: string            // e.g. "VALIDATION_FAILED", "FORBIDDEN", "DUPLICATE_PHONE"
  message: string         // user-safe message
  fields?: Record<string, string>  // field-level errors for forms
  requestId: string
}
```

### 5.4 Idempotency
- Mutating Server Actions accept an `idempotencyKey` in the form payload (uuid generated client-side); server stores recent keys per user (Redis later, in-memory LRU for v1) and short-circuits replays.

---

## 6. Photo Upload Flow

```
Client                            Server                       R2
  │                                  │                          │
  │ Tap photo slot, select image     │                          │
  ├─ compress + hash ───────────────▶│                          │
  │ POST /api/photos/presign         │                          │
  │   {kind, mime, bytes}            │                          │
  │                                  │ presign PUT ────────────▶│
  │◀─ {url, key, fields} ────────────│                          │
  │                                  │                          │
  │ PUT to R2 with progress ─────────────────────────────────▶  │
  │                                  │                          │
  │ POST /api/photos/finalize        │                          │
  │   {key, hash}                    │                          │
  │                                  │ verify object exists ───▶│
  │                                  │ create Attachment row    │
  │◀─ {attachmentId} ────────────────│                          │
```

Server-side guards on finalize:
- `HEAD` the R2 object to confirm bytes match payload claim
- Reject if hash matches an existing attachment (dedupe)
- Reject if mime is not `image/jpeg|png|webp`

---

## 7. Validation Strategy

- Single source: `lib/validation/*.ts` exports Zod schemas reused by client (`react-hook-form` + `@hookform/resolvers/zod`) and server.
- Server runs `schema.parse(input)` at entry; failures throw structured errors.
- Conditional fields handled via `superRefine` (e.g., sub-channel must belong to channel).
- Phone normalization runs in a Zod `.transform()` before storage.

Example (truncated):
```ts
export const SubmitEditSchema = z.object({
  target: z.enum(['CUSTOMER','BRANCH']),
  customerId: z.string().cuid().optional(),
  branchId:   z.string().cuid().optional(),
  fieldChanges: z.array(z.object({
    field: z.string(),
    before: z.unknown(),
    after: z.unknown(),
  })),
  attachmentChanges: z.array(z.object({
    kind: z.enum(['SHOP','SIGNBOARD','CR','FREE']),
    action: z.enum(['ADD','REPLACE','DELETE']),
    attachmentId: z.string().cuid(),
  })),
}).superRefine((val, ctx) => {
  if (val.target === 'CUSTOMER' && !val.customerId)
    ctx.addIssue({ code: 'custom', message: 'customerId required for CUSTOMER target' });
});
```

---

## 8. Completeness Score

Pure function in `lib/completeness.ts`:

```ts
export function scoreCustomer(c: CustomerWithBranches): number {
  let s = 0;
  if (c.channelId && c.subChannelId) s += 10;
  if (c.primaryPhone) s += 5;
  if (c.contactPerson) s += 5;
  if (c.crNumber) s += 5;
  if (c.crPhotoId) s += 10;
  if (c.notes || c.paymentTerms) s += 5;
  // branch portion: average of branch scores * 0.6
  const bScore = avg(c.branches.map(scoreBranch));
  return Math.round(s + bScore * 0.6);
}
```

Recomputed on every approve. Stored on `Customer.completenessScore` for fast dashboards.

---

## 9. Logging, Observability, Errors

- **Logger:** `pino` with redaction of `password`, `passwordHash`, `phone` fields.
- **Request ID:** middleware generates `x-request-id` per request, attached to logs and Sentry.
- **Sentry:** browser + server SDKs; PII scrubbing config; release tagging via `VERCEL_GIT_COMMIT_SHA`.
- **Health check:** `/api/health` pings DB (1ms query) and R2 (HEAD on a known marker file).
- **Metrics (v1.1):** Vercel Analytics for traffic; defer Grafana to v1.1.

### 9.1 Error taxonomy
- `ValidationError` → 400 with field map
- `ForbiddenError` → 403
- `NotFoundError` → 404
- `ConflictError` (duplicate, lock) → 409
- `RateLimitError` → 429
- Anything else → 500, logged with full context, generic message to client

---

## 10. Environment & Secrets

`.env` keys (all stored in Vercel project settings):

```
DATABASE_URL=                  # Neon connection string
DIRECT_URL=                    # Neon direct (for migrations)
NEXTAUTH_SECRET=               # 32+ random bytes
NEXTAUTH_URL=                  # https://nmwc-cm.vercel.app
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=nmwc-photos
R2_PUBLIC_BASE=                # only if we serve via R2 public
SENTRY_DSN=
NODE_ENV=
```

No secret ever committed. `.env.example` lists keys without values.

---

## 11. CI/CD

GitHub Actions:

```yaml
# .github/workflows/ci.yml (sketch)
on: [push, pull_request]
jobs:
  lint-test:
    steps:
      - checkout
      - setup node 20
      - pnpm install --frozen-lockfile
      - pnpm typecheck
      - pnpm lint
      - pnpm test:unit
      - pnpm test:integration  # against ephemeral Neon branch
      - pnpm playwright install
      - pnpm test:e2e
  deploy-preview:
    if: github.event_name == 'pull_request'
    needs: lint-test
    steps:
      - vercel deploy --prebuilt
```

- **Branching:** trunk-based — `main` is always deployable. Feature branches → PR → preview deploy → review → merge.
- **Migrations:** `prisma migrate deploy` runs as a Vercel build step.
- **Staging:** a Neon branch + a Vercel preview environment continuously tracking `main`.
- **Production:** manual promote from staging (Vercel UI) once owner approves.

---

## 12. Testing Strategy

| Layer | Tool | What it covers | Target |
|---|---|---|---|
| Unit | Vitest | Pure functions: completeness, phone normalization, permissions, Zod schemas | ≥ 80% line coverage on `lib/` and `services/` |
| Integration | Vitest + supertest-style helper | Service ↔ repository ↔ DB; uses Neon test branch | All happy paths + RBAC denials |
| E2E | Playwright | Critical user flows on real browser | 8 flows (see below) |
| RBAC tests | Vitest | Each role × each action — denies as expected | All cells of the §4 PRD matrix |

E2E flows:
1. Salesman login → enrich a customer → submit
2. Supervisor login → approve a submission
3. Supervisor rejects → salesman sees in /work and resubmits
4. Manager creates a user → user logs in
5. Steward imports Excel → promotes clean rows
6. Closed-shop → reactivation request → manager approves
7. Wrong-route flag → supervisor reassigns
8. Excel export with filters → download

---

## 13. Performance

| Concern | Strategy |
|---|---|
| Customer list on mobile | Server-rendered with React Server Components; max 200 rows; paginate beyond |
| Form save | Optimistic UI for drafts; server save async with toast |
| Photo upload | Compress on device (max 1920px / ≤2 MB JPEG q=0.85); presigned direct-to-R2 |
| Dashboard aggregations | Postgres `MATERIALIZED VIEW` refreshed every 5 min for completeness rollups |
| Cold start | Vercel Pro keeps fns warm; expect <300ms TTFB |
| DB connections | PgBouncer (Neon manages); Prisma Data Proxy not needed at our scale |

---

## 14. Backup, Recovery, Rollback

- **DB:** Neon point-in-time recovery (PITR) enabled for 7 days; daily logical dump exported to R2 cold storage with 30-day retention.
- **Photos:** R2 has 11 9's durability; we keep originals; never delete on user delete (soft delete sets `deletedAt` and a daily GC job removes from R2 only after 30 days + audit retention).
- **Code:** all releases tagged in Git; Vercel one-click rollback to any prior deployment.
- **Migrations:** every `down` migration written and tested in staging before prod promotion.

---

## 15. Security Checklist

- [x] TLS-only via Vercel
- [x] CSRF protection on Server Actions (Next.js built-in token)
- [x] HttpOnly + Secure cookies
- [x] bcrypt 12 password hashing
- [x] Rate limiting on login (5/min/IP) and form submits (60/hr/user) via in-memory token bucket (Upstash Redis later)
- [x] HTML stripping + Zod parsing on all text inputs
- [x] CSP headers (strict; no inline scripts in production)
- [x] Sentry PII scrubbing
- [x] Audit log immutable — enforced since 2026-09-14 by the `nmwc_forbid_audit_mutation` trigger on AuditLog + EditApproval (migration 20260914150000) and by the runtime role `nmwc_app` having no UPDATE/DELETE/TRUNCATE privilege on them (scripts/ops/app-role.ts); before that date this box was ticked without a control behind it.
- [x] Photo content-type re-verified server-side
- [x] No `dangerouslySetInnerHTML` anywhere
- [x] Dependencies pinned + Renovate (or Dependabot) on weekly cadence
- [x] No production credentials in dev `.env`

---

## 16. Build Plan (Phase 5)

8 milestones. Each ends with a tagged release and a demo to the owner. Estimate: ~10–14 weeks calendar time for one engineer (me) with owner reviewing weekly.

### M0 — Foundation (1 week)
- Repo init, Next.js 15, TS, Tailwind, shadcn, ESLint, Prettier, Vitest, Playwright
- Auth.js skeleton with credentials provider
- Neon DB created (dev + staging branches)
- R2 bucket created
- Sentry project, env wiring
- `/api/health`
- GitHub Actions CI green
- Deploy `nmwc-cm.vercel.app` with login screen
- **Demo:** owner logs in to staging.

### M1 — Auth + Users + Routes/Regions (1.5 weeks)
- Full Prisma schema (excluding edits/imports for now)
- Seed: 7 regions, sample routes, 1 user per role
- `/users`, `/routes` admin pages
- Manager can create/disable users
- Audit log table + middleware
- RBAC permission tests
- **Demo:** owner creates a salesman, salesman logs in to empty `/today`.

### M2 — Customer & Branch Read-only (1 week)
- Schema for Customer/Branch/Channel/SubChannel/Attachment
- Seed channels (the 7 + sub-channels)
- Hand-craft a few seed customers for testing
- Salesman `/today`, `/customers`, `/customers/:id` (read view)
- `<CompletenessRing />`, `<StatusBadge />`, `<PaymentTermsPill />`
- **Demo:** salesman browses sample customers on his phone.

### M3 — Photo Capture + R2 (1 week)
- `<PhotoCaptureSlot />` with compression
- `/api/photos/presign` + `/api/photos/finalize`
- Attachment storage with hash dedupe
- **Demo:** salesman captures shop photos, sees them in profile.

### M4 — Enrichment Form + GPS + Drafts (2 weeks)
- `/customers/:id/edit` full form
- `<GpsCaptureButton />`, `<EditableField />` with locks
- IndexedDB drafts + retry queue
- Zod validation client + server
- **Demo:** salesman enriches a sample customer end-to-end (saves draft, then submits — even though approval not built, edit row is created in SUBMITTED).

### M5 — Approval Workflow + Work Items (2 weeks)
- `CustomerEdit` model + service
- Submit → atomic apply on approve → audit log
- Supervisor `/approvals` queue + diff view
- Reject flow → salesman `/rejected` & `/work`
- Wrong-route flag + reassignment
- Closed-shop submit + reactivation request
- Manager `/reactivations` queue
- **Demo:** salesman submits, supervisor approves, customer changes go live; one rejection round-trip; one closed-shop reactivation.

### M6 — Dashboards + Completeness + Audit (1.5 weeks)
- `lib/completeness.ts` + recompute on edit-apply
- Salesman home stats strip
- Supervisor dashboard
- Manager `/dashboard` with charts (recharts)
- Audit log viewer with filters
- **Demo:** owner sees real-time completeness % moving as test data changes.

### M7 — Import + Export + Duplicates (2 weeks)
- Steward `/import` upload + parse + quarantine
- Per-row review, bulk promote
- Duplicate detection rules (exact + fuzzy)
- Merge tool (basic version; advanced merge can slip to v1.1)
- `/export` with filters + background job + R2 download link
- **Demo:** owner uploads a real Excel, reviews quarantine, promotes clean rows, exports a fresh master.

### M8 — Hardening, Pilot, Production (1 week)
- Sentry breadcrumbs everywhere
- Rate limits on login + form submits
- CSP + security headers audit
- Performance pass: Lighthouse mobile ≥ 90
- Accessibility pass: axe clean
- Backup/restore drill in staging
- Runbook documentation
- Pilot rollout: 2 routes for 1 week
- Bug triage from pilot
- Promote to prod
- **Demo:** real salesmen use it on real customers.

### v1.1 (post-launch)
- Configurable approval rules
- Better duplicate-merge UX
- Photo compression on device side (further optimizations)
- Bulk re-export presets

---

## 17. Risk Register (active)

| # | Risk | Owner | Mitigation | Trigger |
|---|---|---|---|---|
| R1 | Field UX too slow → adoption fails | me | <2 min/customer target; pilot before rollout | Avg time-to-submit > 3 min in pilot |
| R2 | R2 storage cost overrun | me | Compress + hash dedupe + cap per branch | >50 GB |
| R3 | Steward bottleneck on dedupe | owner | M7 ships UX that's actually fast | Backlog > 50 |
| R4 | Real Excel master deviates wildly from sample | both | Defer M7 import details until real data lands | After O1 resolved |
| R5 | Pilot route reveals mandatory field is wrong | both | v1.1 fast-follow ready; field rules via DB seeds, not hardcoded | Field-edit feedback |

---

## 18. Definition of Done — milestone checklist

A milestone is done only when:
- [ ] All planned features merged into `main`
- [ ] Unit + integration tests for the milestone's services
- [ ] At least one E2E test covering the milestone's headline flow
- [ ] RBAC tests cover all new endpoints
- [ ] Mobile smoke-test on a real Android phone
- [ ] Sentry shows no unhandled errors during smoke
- [ ] Owner has demoed and approved
- [ ] Any new env vars added to `.env.example` and Vercel
- [ ] CHANGELOG.md updated

---

**End of TECH-SPEC v1.0.**
**Owner — please review and respond with: APPROVE | CHANGES | QUESTIONS.**
**On APPROVE, M0 implementation begins.**
