# Blueprint — Target Data Model & Schema Changes

**Design area:** Prisma schema + migrations for the unified NMWC Customer Master (consolidation base = NEW, `C:\Users\abdulr\Desktop\NMWC-CRM`).
**Baseline:** `prisma/schema.prisma` (508 lines, 16 models, 11 enums) + 8 timestamped migrations under `prisma/migrations/` (migration-based workflow, `migration_lock.toml` = postgresql) — [Confirmed `new-data.md §5`].
**Confidence tags:** `[Confirmed]` = read in code · `[Proposed]` = my design · `[Open]` = needs a business decision.

**Cross-blueprint reconciliation note:** three sibling blueprints (`approval-engine.md`, `creation-flow.md`, `sla-notif-sync.md`) each sketched partial schema. This document is the authoritative data model; where they diverged I decided and recorded the divergence:
1. **Create-request entity:** approval-engine proposed `CustomerEdit.createPayload Json`; creation-flow proposed a separate `CustomerCreateRequest` + `CustomerCreateBranch`. **Decision: extend `CustomerEdit` as the single approval spine, with TYPED draft child tables** (`EditCustomerDraft`, `EditBranchDraft`) instead of either raw JSON or a parallel request table (§4).
2. **`temixCode` uniqueness:** sla-notif-sync proposed `@unique`; the locked H-01 requirement says nullable, **non-unique**. Non-unique wins for v1 (§8, Open Q7).
3. **SLA stage enum:** sla-notif-sync proposed a separate `EditStage` enum; dropped as redundant — `pendingRole` (a `Role`) + `currentStepIndex` carry the same information without a duplicate taxonomy (§6).
4. **`TemixSyncState` values:** harmonized to `SYNCED / PENDING_UPLOAD / UPLOADED / DEACTIVATE_PENDING` (approval-engine's `NONE` renamed `SYNCED`, which is the true semantic for migrated rows) (§8).

---

## 1. Change-set overview

| # | Change | Current state | Migration |
|---|---|---|---|
| C1 | `Role` + ACCOUNTANT, FINANCE_MANAGER, GM (8 roles) | 5 values, `schema.prisma:15-21` [Confirmed] | `ALTER TYPE ADD VALUE IF NOT EXISTS` (pattern precedent: `20260510120000_senior_audit_remediation/migration.sql:29-33,83`) |
| C2 | Credit data: `Customer.creditLimit`, `Customer.paymentTermDays`; requested/approved pairs on `CustomerEdit`; `AttachmentKind.GUARANTEE` | None exist [Confirmed: no credit fields in `schema.prisma:244-292`; `AttachmentKind` = SHOP/SIGNBOARD/CR/FREE `:57-62`] | ADD COLUMN + enum value |
| C3 | Creation-request capability on `CustomerEdit` (`process`, typed drafts) | `customer.create` only in Steward import (`services/imports.ts:820-868`) + seed/scripts [Confirmed] | New columns + 2 new tables |
| C4 | Multi-step approval data: `approvalChain`, `currentStepIndex`, `pendingRole`, `EditApproval` child | Single-tier: one `reviewedById/reviewedAt` pair, `schema.prisma:360-361` [Confirmed] | New columns + 1 new table + backfill |
| C5 | SLA columns on `CustomerEdit` + `Notification` model | Neither exists — only `submittedAt` ordering (`schema.prisma:377`, `app/(app)/approvals/page.tsx:59,67-69`); no Notification model, no mailer (`new-rules.md §M`) [Confirmed] | New columns + 1 new table |
| C6 | Restore safe 1:N branches | Schema is ALREADY 1:N (`Branch.customerId`, `schema.prisma:294-349`); the pilot flattened **data** to 1:1 (`scripts/flatten-customer-branches.ts:1-29`) and 3 code paths assume `branches[0]` [Confirmed §7] | Code edits only (no DDL) + optional data re-merge |
| C7 | `Customer.temixCode` crosswalk + `TemixSyncState` queue + `TemixSyncBatch` | No temix/erp identifier anywhere [Confirmed grep-negative; `x-integration.md §M.1.1`] | ADD COLUMN + enum + 1 new table |
| C8 | Soft-delete: confirm coverage + Temix-deactivation signal | `deletedAt` on Customer/Branch/Attachment (`schema.prisma:278,335,406`); `AuditAction.SOFT_DELETE` (`:89`) [Confirmed] | Signal = C7's `DEACTIVATE_PENDING`; no new columns |
| C9 | `nmwcCode` allocation: `CodeSequence` counter | `formatCustomerCode` defined but never called (`lib/codes.ts:9-18`; import uses raw `cust_code`, `imports.ts:820-833`) [Confirmed] | 1 new table |
| C10 | DB guard: one open edit per **branch** | Partial unique exists only per customer (`20260509150000_qa_remediation/migration.sql:12-14`); branch equivalent missing (`new-data.md §4.4`) [Confirmed] | Partial unique index |

---

## 2. C1 — Role enum: 5 → 8

**Current [Confirmed `schema.prisma:15-21`]:** `Role { SALESMAN SUPERVISOR MANAGER STEWARD VIEWER }`.

**Note:** the locked decision text says "adds FINANCE_MANAGER + GM to the current 5-role enum", but the locked 8-role list also contains **ACCOUNTANT**, which is absent today. All three must be added (5 + 3 = 8). [Confirmed count mismatch; addition is Proposed]

```prisma
enum Role {
  SALESMAN
  SUPERVISOR
  ACCOUNTANT        // NEW — final approver on both create chains
  FINANCE_MANAGER   // NEW — credit-chain approver
  GM                // NEW — credit-chain approver
  MANAGER
  STEWARD
  VIEWER
}
```

**Migration (own file, before any migration that references the values — Postgres forbids using a value added by `ALTER TYPE ... ADD VALUE` inside the same transaction):**
```sql
-- 20260716000000_roles_and_enums/migration.sql (part 1)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FINANCE_MANAGER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'GM';
```
This is the exact pattern already used at `prisma/migrations/20260510120000_senior_audit_remediation/migration.sql:29-33` (`AuditAction` values) and `:83` (`ImportBatchStatus ... BEFORE 'PROMOTED'`). [Confirmed pattern / Proposed application]

**Code fan-out to audit after the enum change (not exhaustive — owned by the roles/permissions agent):** every `switch`/record over `Role` must gain the 3 new arms, notably `lib/permissions.ts`, `lib/access.ts:59-…` (`loadScope`), `components/nmwc/Sidebar.tsx` nav map, seed scripts. New roles behave like VIEWER (read-only global) until the approval engine wires their step permissions — fail-closed default. [Proposed]

---

## 3. C2 — Credit onboarding data

**Current [Confirmed]:** the only credit-ish field is `Customer.paymentTerms` enum CASH/CREDIT (`schema.prisma:248`). No limit, no term-days, no guarantee documents. `AttachmentKind` = `SHOP SIGNBOARD CR FREE` (`schema.prisma:57-62`).

### 3.1 Where credit data lives — split across request vs master [Proposed]

- **On `CustomerEdit`** (the request): `requestedCreditLimit / requestedPaymentTermDays` (authored by the salesman at submit) and `approvedCreditLimit / approvedPaymentTermDays` (set by FINANCE_MANAGER, confirmable/amendable by GM at their steps). This captures *what the Finance Manager/GM approve* — the locked requirement — and also serves a future "credit-limit change" UPDATE request without schema change.
- **On `Customer`** (the master): the final `creditLimit` + `paymentTermDays`, written once at finalize (`approved ?? requested`). For **migrated** customers these columns are populated **from Temix at migration** (locked decision) via the Steward import lane — a mapping addition in `services/imports.ts` promote (columns `credit_limit`, `payment_term_days` on the inbound sheet; exact headers [Open Q10]).

```prisma
// additions to model Customer (schema.prisma:244-292)
  creditLimit     Decimal? @db.Decimal(14, 3)  // OMR, 3 dp (baisa); null for CASH
  paymentTermDays Int?                          // null for CASH

// additions to model CustomerEdit (schema.prisma:352-381)
  requestedCreditLimit     Decimal? @db.Decimal(14, 3)
  requestedPaymentTermDays Int?
  approvedCreditLimit      Decimal? @db.Decimal(14, 3)
  approvedPaymentTermDays  Int?
```

`Decimal(14,3)` because OMR subdivides to 3 decimal places; `Float` is unacceptable for money. Consistent across all three sibling blueprints. [Proposed]

**DB CHECKs** (hand-written SQL, same convention as GPS/address CHECKs in `20260510120000_senior_audit_remediation`):
```sql
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_creditLimit_nonneg"
  CHECK ("creditLimit" IS NULL OR "creditLimit" >= 0);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_paymentTermDays_range"
  CHECK ("paymentTermDays" IS NULL OR ("paymentTermDays" BETWEEN 0 AND 365));
-- mirror both on "CustomerEdit" requested/approved columns
```

### 3.2 Guarantee / security documents [Proposed]

```prisma
enum AttachmentKind {
  SHOP
  SIGNBOARD
  CR
  GUARANTEE   // NEW — credit guarantee / security document
  FREE
}
```
```sql
ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'GUARANTEE';
```

- Guarantee docs are **1:N per customer** (unlike the 1:1 photo slots `crPhotoId`/`shopPhotoId`/`signboardPhotoId`, `schema.prisma:271,317-318`), so **no new slot column** — they are plain `Attachment` rows with `kind=GUARANTEE` + `customerId` set (post-finalize) or `editId` set (during the chain, §4.4). Query: `attachment.findMany({ where: { customerId, kind: 'GUARANTEE', deletedAt: null } })`.
- Mandatory-gate rule (enforced in services, engine agent's area): a CREDIT create cannot pass submit without ≥1 GUARANTEE attachment + `requestedCreditLimit > 0` + `requestedPaymentTermDays > 0`.
- **[Open Q1]** Additional kinds `SECURITY` (distinct from GUARANTEE?) and `TRADE_LICENSE`: one `GUARANTEE` bucket is my default; add distinct values only if Finance needs to *require* each separately.
- **[Open Q2]** Guarantee docs are likely **PDFs**; the upload pipeline is image-only today (`image/jpeg|png|webp` — `new-rules.md §H`). The Attachment model needs no change (`mimeType String` is already generic, `schema.prisma:392`), but the presign/finalize validation must gain a PDF allowance for `kind=GUARANTEE`.

---

## 4. C3 — Customer-CREATION request: extend `CustomerEdit`, typed drafts (DECISION)

### 4.1 Current state [Confirmed]
- No salesman-facing create exists. `prisma.customer.create` appears only in `services/imports.ts` promote (`:820-868`), `prisma/synthetic.ts:317` (seed) and `scripts/flatten-customer-branches.ts:137`.
- `CustomerEdit.customerId` is **already nullable** (`String?`, `schema.prisma:355`).
- The one-open-edit partial unique fires only `WHERE state='SUBMITTED' AND "customerId" IS NOT NULL` (`prisma/migrations/20260509150000_qa_remediation/migration.sql:12-14`) — CREATE rows (null customerId) pass through it untouched.
- `EditTarget` = `CUSTOMER | BRANCH` (`schema.prisma:52-55`); `fieldChanges Json` diffs against a live record (`:364`).

### 4.2 Decision: ONE approval spine (`CustomerEdit`) + TYPED draft children [Proposed]

Rejecting both extremes from the sibling blueprints:

- **Against a separate `CustomerCreateRequest` model** (creation-flow Option A): every workflow subsystem would need to exist twice. The SLA columns, escalation sweep, `Notification.editId` deep-link, `EditApproval` per-step audit, the approvals-queue query (`approvals/page.tsx:59`), bulk approve, and the atomic-claim engine all bind to `CustomerEdit`. A second request table doubles that surface and forces a polymorphic engine for zero data benefit — the two objections creation-flow raised against `CustomerEdit` (non-null `customerId` assumptions at `edits.ts:246,267-277`; flat `fieldChanges` shape) are both solved below without a new spine.
- **Against `createPayload Json`** (approval-engine §3.2): a CREDIT chain is 4 approver steps and can live for days. A JSON payload holds `regionId/routeId/channelId` as dead strings — a route deleted or a region deactivated mid-chain is undetectable until finalize explodes. JSON also cannot carry the DB CHECKs (GPS Oman envelope, address minlength) or the `branch_region_consistency_check` trigger logic that the live tables enforce (`20260510120000_senior_audit_remediation`), so the highest-stakes writes (net-new masters) would get the *weakest* validation.

**Therefore:** `CustomerEdit` gains a `process` discriminator; a CREATE edit has `customerId = NULL`, `target = CUSTOMER`, and its proposed payload lives in two typed child tables with real FKs and the same CHECKs/trigger as the live tables. On final approval, `finalizeEdit` (engine agent, approval-engine §8) copies draft → real `Customer`/`Branch[]` and stamps `customerId` back onto the edit.

### 4.3 Schema [Proposed]

```prisma
enum EditProcess {
  UPDATE
  CREATE
}

model CustomerEdit {
  // ...existing fields (schema.prisma:352-381) unchanged...
  process        EditProcess @default(UPDATE)   // NEW — discriminator
  // §5 chain fields, §3.1 credit fields, §6 SLA fields also land here

  customerDraft  EditCustomerDraft?             // NEW — CREATE only, 1:1
  branchDrafts   EditBranchDraft[]              // NEW — CREATE only, 1:N (multi-branch from day one)
  steps          EditApproval[]                 // NEW — §5
  notifications  Notification[]                 // NEW — §6
  attachments    Attachment[] @relation("EditAttachments") // NEW — §4.4
}

// Proposed master fields for a not-yet-existing Customer. Mirrors Customer
// (schema.prisma:244-292) minus system fields (nmwcCode/status/version/lineage).
model EditCustomerDraft {
  id               String       @id @default(cuid())
  editId           String       @unique
  legalName        String
  paymentTerms     PaymentTerms // routing key: CASH vs CREDIT chain
  crNumber         String?
  crNumberNorm     String?      // create-time dedup (reuse duplicates.ts:116-131 logic)
  channelId        String?
  subChannelId     String?
  primaryPhone     String?
  primaryPhoneNorm String?
  altPhone         String?
  contactPerson    String?
  contactRole      String?
  notes            String?      @db.Text
  crPhotoAttachmentId String?   @unique   // unbound Attachment (creation-flow §1)

  edit       CustomerEdit @relation(fields: [editId], references: [id], onDelete: Cascade)
  channel    Channel?     @relation("DraftChannel", fields: [channelId], references: [id])
  subChannel SubChannel?  @relation("DraftSubChannel", fields: [subChannelId], references: [id])

  @@index([crNumberNorm])
  @@index([primaryPhoneNorm])
}

// Proposed branch rows under a CREATE request. Mirrors Branch (schema.prisma:294-349)
// minus branchCode (allocated at finalize) and photo-slot FKs (unbound attachment ids instead).
model EditBranchDraft {
  id                String     @id @default(cuid())
  editId            String
  branchName        String
  regionId          String
  routeId           String
  address           String     @db.Text
  areaDescription   String?    @db.Text
  gpsLat            Float?
  gpsLng            Float?
  gpsAccuracy       Float?
  gpsCapturedAt     DateTime?
  dayOfVisit        DayOfWeek?
  openingHours      String?
  deliveryWindow    String?
  coolersCount      Int        @default(0)
  standsCount       Int        @default(0)
  emptyBottlesCount Int        @default(0)
  shopPhotoAttachmentId      String? @unique
  signboardPhotoAttachmentId String? @unique
  extraPhotoAttachmentIds    Json?    // string[] of unbound Attachment ids

  edit   CustomerEdit @relation(fields: [editId], references: [id], onDelete: Cascade)
  region Region       @relation("DraftRegion", fields: [regionId], references: [id])
  route  Route        @relation("DraftRoute", fields: [routeId], references: [id])

  @@index([editId])
}
```
Back-relations required: `Channel.drafts`, `SubChannel.drafts`, `Region.branchDrafts`, `Route.branchDrafts` (named relations as above). [Proposed]

**Replicated DB invariants (migration SQL, same convention as `senior_audit_remediation`):**
```sql
ALTER TABLE "EditBranchDraft" ADD CONSTRAINT "EditBranchDraft_gps_range"
  CHECK (("gpsLat" IS NULL OR ("gpsLat" BETWEEN 16 AND 27))
     AND ("gpsLng" IS NULL OR ("gpsLng" BETWEEN 51 AND 61)));
ALTER TABLE "EditBranchDraft" ADD CONSTRAINT "EditBranchDraft_address_minlen"
  CHECK (char_length(btrim("address")) >= 3);
-- replicate the branch_region_consistency_check trigger body against EditBranchDraft
-- (Route.regionId must equal EditBranchDraft.regionId) so a bad pairing fails at DRAFT.
```
(Exact envelope numbers must be copied verbatim from `20260510120000_senior_audit_remediation/migration.sql` — cited by `creation-flow.md §2`; verify against that file when writing the migration.)

**Duplicate-CREATE guard (replaces creation-flow's "ghost-draft window"):** a partial unique on the draft's identity key blocks two simultaneous open CREATEs for the same entity at the DB level — stronger than a time-window heuristic:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS "EditCustomerDraft_open_cr_unique"
  ON "EditCustomerDraft" ("crNumberNorm")
  WHERE "crNumberNorm" IS NOT NULL;   -- drafts are deleted/archived when the edit terminates
```
[Open Q3] whether the index should scope only to edits in `SUBMITTED` state (needs a denormalized `state` copy on the draft or an app-level check instead; app-level check + this simple index is my default).

### 4.4 Photos captured before the customer exists [Proposed]

[Confirmed enabling fact — creation-flow §1]: `/api/photos/finalize` creates a standalone `Attachment` with `customerId/branchId/branchExtraId` all NULL; `attachPhotoCore` rejects re-binding (`services/photos.ts:95-96`). So create-time photos are finalized unbound, referenced by id from the drafts, and wired to the real slots inside the finalize transaction.

Add the edit linkage so orphans are traceable and GC-able:
```prisma
// addition to model Attachment (schema.prisma:384-421)
  editId String?
  edit   CustomerEdit? @relation("EditAttachments", fields: [editId], references: [id])
  @@index([editId])
```
This resolves approval-engine Open Q6. The photo-gc cron (`app/api/cron/photo-gc/route.ts`) gains a sweep for `customerId IS NULL AND branchId IS NULL AND branchExtraId IS NULL AND editId IS NULL AND createdAt < now() - interval '7 days'` [Open Q4: retention window].

### 4.5 `nmwcCode` allocation — `CodeSequence` at FINALIZE [Proposed]

[Confirmed]: `formatCustomerCode(year, seq)` → `NMWC-YYYY-NNNNNN` exists unused (`lib/codes.ts:9-18`); import uses raw sheet `cust_code` as `nmwcCode` (`imports.ts:820-833`); no counter table exists.

```prisma
model CodeSequence {
  scope String @id   // e.g. "CUSTOMER-2026"
  next  Int    @default(1)
}
```
Allocated inside the finalize transaction (`tx.codeSequence.upsert` with `next: { increment: 1 }` — creation-flow §5 shows the exact upsert). **Decision: allocate at FINALIZE, not submit** (approval-engine §5 position) — no codes burned on rejected/abandoned requests; the edit's cuid is the in-chain reference. [Open Q5] if approvers need a human-readable reference number during the chain, allocate at submit instead (creation-flow §5 position) — pick one before UI build. Branch codes at finalize reuse `formatBranchCode(parentCode, n)` exactly as import does (`imports.ts:806-807`), with `n` = count of ALL branches ever created for the customer (including soft-deleted) + 1, to avoid suffix reuse.

---

## 5. C4 — Multi-step approval data (chain, step pointer, per-step audit)

**Current [Confirmed]:** single-tier — one `reviewedById/reviewedAt/decisionReason/decisionCategory` set (`schema.prisma:360-363`), atomic claim on `state='SUBMITTED'` (`services/edits.ts:767-780`), `EditState { DRAFT SUBMITTED APPROVED REJECTED NEEDS_CORRECTION }` (`schema.prisma:44-50`).

**Adopted from approval-engine §§2-4 (their design; my data-model endorsement + the fields the engine needs):**

```prisma
// additions to model CustomerEdit
  paymentTermsAtSubmit PaymentTerms?           // routing-key snapshot (CREATE: from draft; UPDATE: from customer)
  approvalChain        Json?                    // frozen ApprovalStep[] resolved at submit — immutable per edit
  currentStepIndex     Int  @default(0)         // 0-based pointer into approvalChain
  pendingRole          Role?                    // DENORMALIZED = approvalChain[currentStepIndex].role while SUBMITTED, else NULL

  @@index([pendingRole, state])                 // "my role's queue" filter (SLA blueprint §1.3)
```

```prisma
// NEW model — one row per step decision (per-step audit trail)
model EditApproval {
  id                 String   @id @default(cuid())
  editId             String
  stepIndex          Int
  role               Role
  decision           String   // 'APPROVED' | 'REJECTED'
  actorId            String
  reason             String?  @db.Text
  creditLimitSet     Decimal? @db.Decimal(14, 3)  // FM/GM amendment capture
  paymentTermDaysSet Int?
  at                 DateTime @default(now())

  edit  CustomerEdit @relation(fields: [editId], references: [id])
  actor User         @relation("StepActor", fields: [actorId], references: [id])

  @@unique([editId, stepIndex])   // DB-level double-decision guard; also SoD lookup
  @@index([actorId])
}
```
(+ back-relation `stepDecisions EditApproval[] @relation("StepActor")` on `User`.)

**Why this shape:**
- `approvalChain` as **frozen JSON** (not FK rows to a config table): the chain must be immutable per in-flight edit even if the matrix changes — same snapshot philosophy as `fieldChanges` (`edits.ts:435,461`). JSON is safe here because the chain is written once, never queried relationally; the *queryable* denormalization is `pendingRole`.
- `pendingRole` maintained (not derived) so the queue page, SLA sweep, and notification fan-out are single-index queries — set at submit and every step transition, nulled on terminal states. Divergence from the SLA blueprint: **no separate `EditStage` enum** — it duplicated `Role` values.
- Chain lengths: UPDATE = `[SUPERVISOR]` (1); CASH CREATE = `[SUPERVISOR, ACCOUNTANT]` (2 approver steps); CREDIT CREATE = `[SUPERVISOR, FINANCE_MANAGER, GM, ACCOUNTANT]` (4). (The locked "3/5-step" counts include the salesman's submit as step 0.)
- Reject at any step ⇒ `state='NEEDS_CORRECTION'`, `currentStepIndex=0`, chain restarts on resubmit (approval-engine §9 default; [Open Q6] return-to-previous-step deferred).
- `AuditAction` additions for step-level events: `STEP_APPROVE`, `FINALIZE`, `ESCALATE` (`ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS ...` ×3 — merges approval-engine §3.1 and sla-notif §1.6 asks).

**Backfill for existing rows (same migration):**
```sql
-- All existing edits are single-step supervisor updates.
UPDATE "CustomerEdit"
SET "process" = 'UPDATE',
    "approvalChain" = '[{"role":"SUPERVISOR","scope":"SUPERVISOR_OF_SUBMITTER","label":"Supervisor"}]'::jsonb,
    "currentStepIndex" = 0,
    "pendingRole" = CASE WHEN "state" = 'SUBMITTED' THEN 'SUPERVISOR'::"Role" ELSE NULL END;
```

**C10 while we're here — missing branch-side open-edit guard [Confirmed gap, `new-data.md §4.4`]:**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerEdit_open_per_branch"
  ON "CustomerEdit" ("branchId")
  WHERE "state" = 'SUBMITTED' AND "branchId" IS NOT NULL;
```
Mirrors `CustomerEdit_open_per_customer` (`20260509150000_qa_remediation/migration.sql:12-14`). Requires the same P2002→`EDIT_LOCKED` friendly-error mapping as `edits.ts:465-481`.

---

## 6. C5 — SLA + Notification tables

**Current [Confirmed]:** nothing. Queue age is wall-clock math at render (`app/(app)/approvals/page.tsx:67-69`); no due date, no escalation, no Notification model, no mailer in `package.json` (`new-rules.md §M`; sla-notif-sync §1.1/§2.2 grep-negative).

### 6.1 SLA columns on `CustomerEdit` [Proposed — harmonized with sla-notif-sync §1.3]
```prisma
// additions to model CustomerEdit
  stageEnteredAt  DateTime?              // SLA clock start for the current step; reset on every step transition
  slaDueAt        DateTime?              // working-hours deadline (Asia/Muscat calendar, lib/sla.ts port)
  slaBreachedAt   DateTime?              // set once by the sweep; idempotency guard per level
  escalationLevel Int       @default(0)  // 0=none, 1=role-manager, 2=GM/MANAGER
  lastEscalatedAt DateTime?

  @@index([state, slaDueAt])             // sweep query + breached-first queue sort
```
No separate SLA table: SLA state is 1:1 with the *current step* of one edit; history of past steps' timing is reconstructable from `EditApproval.at` deltas. Budgets/calendar are code+env (`lib/sla-config.ts`), not DB [Proposed]. [Open Q8] per-role budgets (OLD used SUPERVISOR 8h / ACCOUNTANT 9h working hours — `ICO/.../lib/constants.ts:225,227`) + FM/GM budgets need owner sign-off.

### 6.2 `Notification` model [Proposed — adopted from sla-notif-sync §2.1, plus explicit channel enum]
```prisma
enum NotificationKind {
  EDIT_SUBMITTED        // to first approver
  EDIT_STAGE_ADVANCED   // to next approver in the chain
  EDIT_APPROVED_FINAL   // to submitter + STEWARDs (ready for Temix upload)
  EDIT_NEEDS_CORRECTION // to submitter (carries decisionReason)
  SLA_BREACH            // to escalation target
}

model Notification {
  id         String           @id @default(cuid())
  userId     String           // recipient
  kind       NotificationKind
  title      String
  body       String           @db.Text   // PII-safe: legalName + nmwcCode + deep link ONLY (sla-notif §2.4)
  editId     String?
  customerId String?
  readAt     DateTime?        // in-app read state
  emailedAt  DateTime?        // email delivery state; NULL = pending/disabled — the batch-drain queue key
  createdAt  DateTime         @default(now())

  user User          @relation("UserNotifications", fields: [userId], references: [id])
  edit CustomerEdit? @relation(fields: [editId], references: [id])

  @@index([userId, readAt])            // bell unread-count + inbox
  @@index([emailedAt, createdAt])      // email batch-drain: WHERE emailedAt IS NULL
  @@index([editId])
}
```
(+ `notifications Notification[] @relation("UserNotifications")` on `User`.)
Delivery-channel representation: **two timestamps, not a channel enum** — every notification is in-app (row exists ⇒ visible), email is an additional delivery marked by `emailedAt`. A `channel` column would force duplicate rows per channel and complicate the unread count. Escalation notifications are ordinary rows with `kind=SLA_BREACH`; who receives them is the sweep's logic, not schema. [Proposed]

---

## 7. C6 — Restore safe 1:N branches (code changes; schema already 1:N)

**Key fact [Confirmed]:** the *schema* never lost 1:N — `Branch.customerId` is a plain FK with `branches Branch[]` on Customer (`schema.prisma:285,294-349`), and the Steward import creates N branches per `custCode` group (`services/imports.ts:700-923`, branch code suffixing at `:806-807`). The pilot flattened the *data* via `scripts/flatten-customer-branches.ts` (P1.2: 3,239→3,308 customers so every customer has exactly 1 branch; header comment `:1-29`). What must change is the code that has since grown `branches[0]` assumptions:

| # | File:line [Confirmed] | Assumption | Required change [Proposed] |
|---|---|---|---|
| 1 | `services/duplicates.ts:73-77` | `branches: { take: 1 }` in the candidate query | Remove `take: 1` — select ALL live branches' `regionId` |
| 2 | `services/duplicates.ts:137-138` | EXACT_TRIPLE key uses `c.branches[0].regionId` only — a duplicate whose matching branch isn't the first is MISSED | Insert the customer into `byTriple` once per **distinct** branch `regionId` (`for (const r of new Set(c.branches.map(b => b.regionId)))`); pair-dedup via the existing `seen` set (`duplicates.ts:110-112`) already prevents double-reporting |
| 3 | `services/customer-export.ts:182-192` (`take: 1`) + `:195` (`const b = c.branches[0]`) | Filtered xlsx export emits ONE row per customer with the first scoped branch — silently drops branches 2..N | `flatMap`: one row per scoped branch (add a `Branch code` column); mirrors how the main export is already per-branch (`services/exports.ts:134-168` — one row per branch, [Confirmed via sla-notif §3.1]). Note `EXPORT_ROW_CAP` semantics shift from customers to rows |
| 4 | `app/(app)/customers/page.tsx:59-62` (`take: 1`) + `:315` (`primaryBranch={c.branches[0]}`) | List card shows an arbitrary "oldest" branch | KEEP `take: 1` (a list card wants one subtitle) but: (a) apply the scoped `where` fix from audit RBAC-05-002 (`docs/audit/05-rbac-scope.md:90-98`) so the shown branch is on the viewer's route/region; (b) surface `_count.branches` as a badge so multi-branch is visible |
| 5 | `scripts/flatten-customer-branches.ts` | The flattener itself | RETIRE — must never re-run post-consolidation. Move to `scripts/retired/` or delete; its reversal map lives at `docs/audit/flatten-map-<DATE>.json` (`script:23-26`) |
| 6 | `prisma/inject-test-edits.ts:30,73`, `prisma/synthetic.ts:429,468` | Dev/seed scripts pick `branches[0]` | Low priority; update seeds to generate multi-branch customers so tests exercise 1:N |

**Already multi-branch-safe [Confirmed — no change]:**
- Completeness: `scoreCustomer` averages the branch part across ALL branches (`lib/completeness.ts:73-86`); recompute reads all live branches (`services/edits.ts:577-584`). (Perf caveat for 50-branch chains noted at `docs/audit/07-cross-check.md:158` — acceptable.)
- The edit engine iterates branches throughout (`edits.ts:163,543,581,710-728`), scope checks use `.some()` over branches (`edits.ts:260`), reject-path region check loads all (`edits.ts:934`).
- Merge keeps N branches (reassigns all loser branches, `duplicates.ts:241`).

**[Open Q9]** Should the 69 customers split by the flatten (2-branch → 2 customers, map on disk) be **re-merged** into true multi-branch customers at consolidation, or left as-is with 1:N applying only to new data? Data-ops decision for the Steward + owner; the map file makes re-merge scriptable.

---

## 8. C7 — Temix crosswalk + sync queue

**Current [Confirmed]:** no `temixCode` column; no sync-state anywhere (grep-negative for temix/erp/sync in `app|lib|services` — sla-notif §3.1). `nmwcCode` for imported rows IS the raw ERP `cust_code` (`imports.ts:820-833`).

```prisma
enum TemixSyncState {
  SYNCED             // matches Temix as of last upload/refresh (default: migrated rows)
  PENDING_UPLOAD     // approved create/correction not yet exported
  UPLOADED           // in an exported batch; awaiting Steward "loaded" confirm / inbound refresh
  DEACTIVATE_PENDING // soft-deleted: flag for deactivation in Temix on next upload
}

// additions to model Customer
  temixCode              String?        // H-01 crosswalk — nullable, NON-unique per locked requirement
  temixSyncState         TemixSyncState @default(SYNCED)
  temixSyncPendingSince  DateTime?
  lastTemixUploadAt      DateTime?
  lastTemixUploadBatchId String?

  @@index([temixCode])
  @@index([temixSyncState])   // the outbound-queue query
```

```prisma
// NEW — modeled on ExportJob (schema.prisma:473-486); snapshot of one Temix upload
model TemixSyncBatch {
  id             String          @id @default(cuid())
  createdById    String
  createdAt      DateTime        @default(now())
  rowCount       Int             @default(0)
  customerIds    Json            // snapshot of included customer ids
  status         ExportJobStatus // reuse PENDING/RUNNING/DONE/FAILED
  r2Key          String?
  markedLoadedAt DateTime?       // Steward confirms "loaded into Temix"

  createdBy User @relation("TemixBatchCreator", fields: [createdById], references: [id])
}
```
(+ back-relation on `User`.)

- **Migration default = `SYNCED`** — every existing row came from a Temix export, so the backfill is the column default (no UPDATE needed). New creates/corrections/soft-deletes set `PENDING_UPLOAD` / `DEACTIVATE_PENDING` in service code (hook points: finalize txn; soft-delete action).
- **`temixCode` non-unique [locked H-01]** — divergence from sla-notif §3.2 which proposed `@unique`. Rationale for non-unique at migration: crosswalk data quality is unproven; a unique constraint would block the migration load on the first ERP-side duplicate. **[Open Q7]** add `CREATE UNIQUE INDEX ... WHERE "temixCode" IS NOT NULL AND "deletedAt" IS NULL` after the Steward verifies cleanliness — recommended end-state.
- **[Open Q10]** Whether `nmwcCode == temixCode` for migrated rows (if yes, backfill is `UPDATE "Customer" SET "temixCode" = "nmwcCode" WHERE "importRowId" IS NOT NULL`); plus the exact upload sheet headers — the single highest-leverage unknown (`x-integration.md §M.1.1`).

---

## 9. C8 — Soft-delete: confirmation + gap

**Confirmed coverage:**
- Columns: `Customer.deletedAt` (`schema.prisma:278`), `Branch.deletedAt` (`:335`), `Attachment.deletedAt` (`:406`); every service query filters `deletedAt: null` (e.g. `edits.ts:249,252`, `duplicates.ts:63`, `customer-export.ts:109`).
- Audit vocabulary exists: `AuditAction.SOFT_DELETE` (`schema.prisma:89`).
- **No hard delete of Customer/Branch exists anywhere in services** — the only `deletedAt: new Date()` writer on Customer is the merge loser (`services/duplicates.ts:260`); photos soft-delete via `photos.ts:137,192,205,317`.

**Gap [Confirmed]:** there is **no user-facing archive/close-customer action** — soft-delete is currently reachable only through Steward merge. The unified system needs a `softDeleteCustomerAction` (workflow agent's area). **Data model needs NOTHING new for it**: `deletedAt` + `AuditLog` (actor/reason, `schema.prisma:489-507`) + the C7 signal `temixSyncState='DEACTIVATE_PENDING'` fully cover "retained for audit + flagged for deactivation in Temix on next upload". Explicitly NOT adding `deletedById/deleteReason` columns — `AuditLog.before/after/reason` already captures both, and duplicating them invites drift. [Proposed]

Note: soft-deleted rows must remain visible to the Temix export query (`WHERE temixSyncState = 'DEACTIVATE_PENDING'` ignores `deletedAt`) — one deliberate exception to the blanket `deletedAt: null` filter convention; document it in the export service.

---

## 10. Migration plan (4 ordered files, existing conventions)

All hand-written idempotent SQL (`IF NOT EXISTS` / DO-blocks), matching the house style of `20260510120000_senior_audit_remediation`. Enum additions are isolated in the FIRST file because Postgres cannot use an `ALTER TYPE ... ADD VALUE` value in the same transaction that added it — precedent: `senior_audit_remediation` added enum values and only later migrations/columns reference them.

1. **`20260716000000_roles_and_enums`** — `ALTER TYPE` adds: `Role` ×3, `AttachmentKind` +GUARANTEE, `AuditAction` +STEP_APPROVE/FINALIZE/ESCALATE; `CREATE TYPE "EditProcess"`, `"TemixSyncState"`, `"NotificationKind"`.
2. **`20260716000001_credit_and_temix`** — `Customer` ADD `creditLimit`, `paymentTermDays`, `temixCode`, `temixSyncState`, `temixSyncPendingSince`, `lastTemixUploadAt`, `lastTemixUploadBatchId` + CHECKs + 2 indexes; `TemixSyncBatch` table.
3. **`20260716000002_create_request_spine`** — `CustomerEdit` ADD `process`, `paymentTermsAtSubmit`, `approvalChain`, `currentStepIndex`, `pendingRole`, 4 credit columns + CHECKs; backfill UPDATE (§5); `EditApproval`, `EditCustomerDraft`, `EditBranchDraft`, `CodeSequence` tables + draft CHECKs + region-consistency trigger clone; `Attachment` ADD `editId` + index; `CustomerEdit_open_per_branch` + `EditCustomerDraft_open_cr_unique` partial uniques; `@@index([pendingRole, state])`.
4. **`20260716000003_sla_notifications`** — `CustomerEdit` ADD `stageEnteredAt`, `slaDueAt`, `slaBreachedAt`, `escalationLevel`, `lastEscalatedAt` + `@@index([state, slaDueAt])`; `Notification` table + 3 indexes.

Deploy notes: all columns nullable-or-defaulted ⇒ zero-downtime `prisma migrate deploy`; no table rewrites (Postgres adds NULL/default columns without rewrite on PG 11+). The §7 multi-branch code edits ship in the same release but require no DDL.

---

## 11. Consolidated OPEN QUESTIONS

| # | Question | Blocks |
|---|---|---|
| Q1 | Split `GUARANTEE` into GUARANTEE / SECURITY / TRADE_LICENSE kinds, or one bucket? | Migration 1 (cheap to add later — additive enum) |
| Q2 | PDF MIME allowance for guarantee docs (pipeline is image-only today, `new-rules.md §H`) | Upload validation, not schema |
| Q3 | DB-level vs app-level scoping of the open-CREATE CR uniqueness to SUBMITTED state | Migration 3 detail |
| Q4 | Orphan-attachment GC retention window (default 7d) | photo-gc change |
| Q5 | `nmwcCode` allocation at FINALIZE (my default, no burned codes) vs SUBMIT (human reference during chain) | Finalize service + UI |
| Q6 | Reject = full reset to salesman (default) vs return-to-previous-step | Engine, not schema (schema supports both) |
| Q7 | Partial-unique `temixCode` once Steward confirms crosswalk cleanliness (start non-unique per locked H-01) | Post-migration hardening |
| Q8 | Per-role SLA budgets (OLD: SUP 8h / ACC 9h) + FM/GM budgets + Oman calendar confirm | `lib/sla-config.ts` values |
| Q9 | Re-merge the 69 flatten-split customers using `docs/audit/flatten-map-*.json`? | Data-ops task, optional |
| Q10 | `nmwcCode == temixCode`? + exact Temix sheet headers (incl. `credit_limit`/`payment_term_days` inbound columns for migrated payment terms) | temixCode backfill + import mapping |
| Q11 | GM step always required for CREDIT vs only above a credit-limit threshold (approval-engine Q4) | Matrix config; schema unaffected |
| Q12 | Can FM/GM amend requested credit values (schema supports via `approved*` + `EditApproval.creditLimitSet`)? Does an amendment re-trigger prior steps? | Engine policy |
