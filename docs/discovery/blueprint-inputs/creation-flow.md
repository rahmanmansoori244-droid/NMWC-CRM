# Blueprint — NET-NEW Customer Creation (Field Onboarding)

**Design area:** the field-originated "create new customer" capability that NEW lacks entirely
(`new-functional.md` J2: no `customer.create` in app; import-only). Reimplemented natively on NEW's
stack (Next 15 RSC + server actions in `services/`), mirroring the enrichment/promote patterns.

**Scope base:** NEW system `C:\Users\abdulr\Desktop\NMWC-CRM`. All file:line anchors are to NEW unless
prefixed OLD. Confidence: **[Confirmed]** read in code · **[Proposed]** my design · **[Open]** needs a decision.

---

## 0. What exists today vs. what must be built

- **[Confirmed]** Real customer creation happens ONLY via Steward Excel import → promote:
  `promoteCustomerBatchCore` upserts `Customer` + `Branch` grouped by `custCode`
  (`services/imports.ts:700-923`, upsert at `:820-868`). `prisma.customer.create` otherwise appears only in
  `prisma/synthetic.ts:317` (seed) and `scripts/flatten-customer-branches.ts:137`.
- **[Confirmed]** There is NO `create` page/route. `app/(app)/customers/` has only `page.tsx` (list),
  `[id]/page.tsx` (read), `[id]/edit/page.tsx` + `EnrichmentForm.tsx` (enrich). No nav entry to create in
  `components/nmwc/Sidebar.tsx:29-34` (SALESMAN nav = Today / Customers / Work / Needs correction).
- **[Confirmed]** `lib/codes.ts:9-18` `formatCustomerCode(year, seq)` → `NMWC-YYYY-NNNNNN` is **defined but
  never called** in ingestion (import uses the raw sheet `cust_code` as `nmwcCode`, `imports.ts:820-833`;
  `new-rules.md` G note). `formatBranchCode(parent, n)` → `<PARENT>-NN` IS used at `imports.ts:806-807`.
- **[Confirmed]** No sequence/counter table exists for code allocation (checked schema `prisma/schema.prisma`;
  only `RequestSequence`-style tables exist in OLD, not NEW).
- **[Confirmed]** The OLD system HAD this: `POST /api/requests` create-draft with mandatory-field zod, routing
  resolution, ghost-draft guard, sequence-allocated request number, then submit → tiered approval
  (`old-functional.md` §4). But OLD code cannot be lifted (Prisma 5→6, NextAuth 4→5, Next 14→15 breaking —
  `x-integration.md` M.3.2). We re-implement the *requirements*, not the code.

**Design principle:** a net-new customer is authored as a **CreateRequest** that threads the same
approval engine the enrichment flow uses, and only on FINAL approval does it materialize a real
`Customer` + `Branch[]` (reusing the exact upsert/versioning patterns from `imports.ts` promote and
`edits.ts` `applyEditChanges`). This keeps "unapproved data" out of the live master until sign-off, matching
the locked workflow (CASH: SM→SUP→ACC; CREDIT: SM→SUP→FM→GM→ACC).

---

## 1. The chicken-and-egg photo problem (critical design constraint) [Confirmed]

The enrichment form wires photos to a slot **immediately** via `attachPhotoAction`, which requires an
already-existing `customerId`/`branchId` (`services/photos.ts:114-119` customer path, `:169-173` branch path;
`attachTo` prop in `EnrichmentForm.tsx:402,618,633`). A net-new customer has no id yet, so the enrichment
photo-attach path cannot be reused as-is at create time.

**[Confirmed] enabling fact:** the R2 pipeline is `presign → PUT → finalize → (optional) attach`. The
**finalize** step (`/api/photos/finalize`) creates a **standalone `Attachment` row** with `capturedById` set
and `customerId/branchId/branchExtraId` all NULL (attach only sets them later — `photos.ts:95-96` explicitly
rejects an attachment that already has any of the three set). So photos captured during create can be
finalized to produce **unbound `attachmentId`s**, carried in the CreateRequest payload, and **bound inside the
final materialization transaction** once the Customer/Branch exist.

**[Proposed] create-time photo handling:**
- Reuse `PhotoCaptureSlot` (`components/nmwc/PhotoCaptureSlot.tsx`) but **without** `attachTo` — it already
  supports this: when `attachTo` is undefined it stops after finalize and calls `onChange(next)` with the
  `attachmentId` (`PhotoCaptureSlot.tsx:248,278`). The create form supplies `onChange` handlers that store
  the unbound `attachmentId` in form state (per-slot: CR on customer, SHOP/SIGNBOARD/FREE per branch-draft).
- The CreateRequest payload carries `crPhotoAttachmentId`, and per branch `shopPhotoAttachmentId`,
  `signboardPhotoAttachmentId`, `freePhotoAttachmentIds[]`.
- **[Proposed]** the create service re-validates each attachment inside the materialize tx exactly like
  `attachPhotoCore` does: exists, not soft-deleted (`photos.ts:86-88`), `capturedById === actor` for salesman
  (`:91-93`), kind matches slot (`:100-112`), and not already wired (`:95-96`). Then sets
  `attachment.{customerId|branchId}` + `kind` and the FK slot on the new row — same writes as `photos.ts:140-146,195-217`.
- **[Open]** Orphan attachments: if a salesman captures photos then abandons the draft, unbound `Attachment`
  rows accumulate. The existing `photo-gc` cron (`app/api/cron/photo-gc/route.ts`) GCs soft-deleted rows, not
  never-attached ones. Decision: extend photo-gc to sweep `Attachment` where `customerId IS NULL AND branchId
  IS NULL AND branchExtraId IS NULL AND createdAt < now()-N days` (and no CreateRequest references it), OR keep
  them (cheap). Recommend the sweep with N=7d.

---

## 2. Data model — the create-request entity [Proposed — RECONCILED with approval-engine blueprint]

**Cross-blueprint alignment (authoritative):** the approval-engine blueprint (`blueprint/approval-engine.md`
§3.2-3.4) defines the create-request as an **extension of `CustomerEdit`**: `process EditProcess @default(UPDATE)`
with `CREATE`, a `createPayload Json` (`{customer:{...}, branches:[{...}]}`), real columns for
`requestedCreditLimit / requestedPaymentTermDays / approvedCreditLimit / approvedPaymentTermDays`
(Decimal(14,3)/Int), a per-step `EditApproval` child table, frozen `approvalChain Json` +
`currentStepIndex`, and `Customer.temixSyncState` (`NONE/PENDING_UPLOAD/UPLOADED/DEACTIVATE_PENDING`).
**This design ADOPTS that entity** — one chain machine (atomic step-claim, SLA, notifications, EditApproval
audit) serves both the update and create lanes; a second parallel request model would duplicate the engine.

Feasibility check against the schema [Confirmed]: `CustomerEdit.customerId` is already nullable
(`schema.prisma:355`), and the `CustomerEdit_open_per_customer` partial unique only guards
`customerId IS NOT NULL` (`prisma/migrations/20260509150000_qa_remediation/migration.sql:12-14`), so CREATE
rows (customerId NULL until materialize) do not violate it. Duplicate-create protection therefore needs its own
guard: **one open (SUBMITTED/DRAFT) CREATE edit per submitter+normalized-legalName** enforced in-service, plus
the dedup gate in §6.

**Two additions the engine's DDL must absorb from this design:**
1. `CustomerEdit.provisionalCode String? @unique` — the NMWC-YYYY-NNNNNN code allocated at submit (§5), carried
   until materialize writes it to `Customer.nmwcCode`.
2. A `CodeSequence` counter model (§5).

`createPayload` carries the authored fields + **unbound attachment ids** (§1). Its canonical TypeScript/Zod
shape (`lib/validation/create.ts`, parsed server-side on every transition — never trust the stored Json blindly):

```ts
export const createBranchDraftSchema = branchEditSchema      // lib/validation/edit.ts:50-81
  .omit({ branchId: true, status: true })
  .extend({
    branchName: z.string().min(1).max(200).default('Main'),
    address: z.string().min(3).max(500),                     // required (DB CHECK parity)
    shopPhotoAttachmentId: z.string().cuid().optional(),
    signboardPhotoAttachmentId: z.string().cuid().optional(),
    freePhotoAttachmentIds: z.array(z.string().cuid()).max(10).default([]),
  });

export const createPayloadSchema = z.object({
  customer: customerEditSchema                               // lib/validation/edit.ts:16-48
    .omit({ status: true })
    .extend({
      legalName: z.string().min(2).max(200),                 // REQUIRED here (optional in edit schema)
      paymentTerms: z.nativeEnum(PaymentTerms),              // REQUIRED — drives the chain
      crPhotoAttachmentId: z.string().cuid().optional(),
      guaranteeDocAttachmentIds: z.array(z.string().cuid()).max(10).default([]), // CREDIT
    }),
  branches: z.array(createBranchDraftSchema).min(1).max(10),
});
```

Trade-off accepted: branch drafts as Json lose the DB-level CHECKs (GPS envelope, address minlength,
region==route trigger) until materialize — Zod enforces the same bounds at every write
(`edit.ts:59-68` GPS, `:53` address), and materialize hits the real constraints as a final backstop (§8).

**Alternative (documented, NOT recommended): dedicated `CustomerCreateRequest` + `CustomerCreateBranch` models**
— cleaner relational typing for branch drafts, but requires re-implementing the whole chain surface
(step claim, EditApproval, SLA timers, notification hooks, /work and /approvals queue queries) against a second
entity. Original sketch preserved below for reference if the orchestrator overrules:

```prisma
// NEW enum values (see approval-engine blueprint for the shared ApprovalState;
// shown here standalone for the create lane).
enum CreateRequestState {
  DRAFT
  SUBMITTED          // in the approval chain
  NEEDS_CORRECTION   // returned to salesman (mirror of edits' NEEDS_CORRECTION)
  APPROVED           // fully signed off, materialized
  REJECTED           // terminal hard-reject (optional; see Open Qs)
}

enum PaymentTerms { CASH CREDIT }   // existing, schema.prisma:23-26

model CustomerCreateRequest {
  id            String              @id @default(cuid())
  state         CreateRequestState  @default(DRAFT)
  paymentTerms  PaymentTerms        // drives CASH vs CREDIT chain

  // ── Authored customer master fields (mirror Customer, but nullable until submit) ──
  legalName     String
  crNumber      String?
  crNumberNorm  String?             // normalized for create-time dedup (lib/cr.ts:15-19)
  channelId     String?
  subChannelId  String?
  primaryPhone  String?
  primaryPhoneNorm String?
  altPhone      String?
  contactPerson String?
  contactRole   String?
  notes         String?             @db.Text
  crPhotoAttachmentId String?       // unbound Attachment captured pre-create

  // ── Credit-tier data the FM/GM approve (LOCKED requirement) ──
  requestedCreditLimit  Decimal?    @db.Decimal(14,3)   // OMR, 3-decimal (baisa)
  paymentTermDays       Int?                             // net terms
  guaranteeDocIds       Json?                            // Attachment ids of guarantee/security docs

  // ── Branch drafts (1:N) authored inline ──
  branches      CustomerCreateBranch[]

  // ── Chain / audit ──
  submittedById String
  submittedAt   DateTime?
  currentTier   String?             // e.g. SUPERVISOR|FINANCE_MANAGER|GM|ACCOUNTANT (approval engine)
  reviewedById  String?
  reviewedAt    DateTime?
  decisionReason String?            @db.Text
  decisionCategory String?

  // ── Materialization result ──
  createdCustomerId String?  @unique   // set on APPROVED; links to the real Customer
  provisionalCode   String   @unique   // NMWC-YYYY-NNNNNN allocated at submit (see §5)

  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?

  submittedBy   User      @relation("CreateSubmitter", fields: [submittedById], references: [id])
  reviewedBy    User?     @relation("CreateReviewer", fields: [reviewedById], references: [id])
  createdCustomer Customer? @relation("CreatedFromRequest", fields: [createdCustomerId], references: [id])

  @@index([state, submittedAt])
  @@index([submittedById, state])
}

model CustomerCreateBranch {
  id              String  @id @default(cuid())
  requestId       String
  branchName      String
  regionId        String
  routeId         String
  address         String  @db.Text
  areaDescription String? @db.Text
  gpsLat          Float?
  gpsLng          Float?
  gpsAccuracy     Float?
  gpsCapturedAt   DateTime?
  dayOfVisit      DayOfWeek?
  openingHours    String?
  deliveryWindow  String?
  coolersCount    Int @default(0)
  standsCount     Int @default(0)
  emptyBottlesCount Int @default(0)
  shopPhotoAttachmentId      String?
  signboardPhotoAttachmentId String?
  freePhotoAttachmentIds     Json?

  request  CustomerCreateRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  region   Region @relation(fields: [regionId], references: [id])
  route    Route  @relation(fields: [routeId], references: [id])

  @@index([requestId])
}
```

*(End of preserved alternative sketch. The ADOPTED entity is the approval-engine's
`CustomerEdit.process=CREATE` + `createPayload` — see the reconciliation at the top of this section.
Wherever the rest of this document says "CreateRequest", read: the CREATE-process `CustomerEdit` row;
"request.branches" = `createPayload.branches`; request state = `EditState` + `currentStepIndex`.)*

---

## 3. Mandatory fields — CASH vs CREDIT at creation [Proposed, grounded in edits.ts:98-187]

Reuse the `collectMissingMandatory` shape (`services/edits.ts:98-187`) but **without lock-skips** — at
creation the salesman IS authoring `legalName` and (for CASH) the CR, so nothing is "Steward-owned yet."

**Customer-level, both CASH and CREDIT (all required to SUBMIT):**
`legalName` (2–200, `edit.ts:18`), `channelId`, `subChannelId`, `primaryPhone`, `contactPerson`,
`crPhotoAttachmentId` (CR document) — mirrors `edits.ts:139-161`.

**CASH-specific:** `crNumber` **required** (CASH customers field-collect a CR; `permissions.ts:66,78-79`
confirms CASH CR is editable/collectable). `requestedCreditLimit` / `paymentTermDays` / guarantee docs =
N/A (must be null).

**CREDIT-specific [LOCKED business decision]:** the CRM captures what FM/GM approve —
`requestedCreditLimit` (amount, > 0), `paymentTermDays` (int ≥ 0), and ≥1 `guaranteeDocIds` (guarantee/security
document photo). `crNumber` still required (a credit customer is a legal entity with a CR). These three are
**mandatory to enter the CREDIT chain** but are surfaced/edited by the salesman at authoring and
**approved (not authored)** by FM then GM.

**Per branch (≥1 branch required):** `address` (≥3), `gpsLat`+`gpsLng` (Oman envelope), `dayOfVisit`,
`shopPhotoAttachmentId`, `signboardPhotoAttachmentId` — mirrors `edits.ts:163-184`.

**[Proposed]** `collectMissingMandatoryForCreate(request, actorIsSalesman)` in a new `services/creates.ts`,
returning the same `Record<path, message>` map so the client (`CreateCustomerForm`) can render inline errors
exactly like `EnrichmentForm.tsx:151-176`. DRAFT skips the gate (mirror `edits.ts:403`); SUBMIT enforces it.

**[Resolved by approval-engine blueprint]** requested-vs-approved is modeled as four real columns on the
CREATE edit (`requestedCreditLimit/requestedPaymentTermDays` authored by the salesman;
`approvedCreditLimit/approvedPaymentTermDays` set by FM/GM at their step, each decision recorded on
`EditApproval.creditLimitSet/paymentTermDaysSet`). Materialize writes the **approved** values onto
`Customer.creditLimit/paymentTermDays`. Remaining [Open]: may FM/GM grant MORE than requested, and may GM
silently override FM's figure or must FM re-review? (Recommend: ≤ requested without re-loop; GM override allowed
but visibly audited on its EditApproval row.)

---

## 4. UI / routes [Proposed]

New pages under `app/(app)/customers/`, mirroring the enrichment form component structure:

- `app/(app)/customers/new/page.tsx` — RSC entry. Guards: `session.user.role === SALESMAN` (or STEWARD/MANAGER
  for admin-authored creates — see Open Qs). Loads `channels` (same query as `edit/page.tsx:111-115`) and the
  salesman's owned route + region (`User.ownedRouteId`, `lib/access.ts loadScope`) to pre-fill/lock the
  branch's region/route to the salesman's own route (a salesman can only create on his route — mirrors the
  branch-scope rule `edits.ts:357-359`). `export const dynamic = 'force-dynamic'` (mirror `edit/page.tsx:16`).
- `app/(app)/customers/new/CreateCustomerForm.tsx` — client component, a close cousin of `EnrichmentForm.tsx`.
  Differences:
  - **Payment-terms selector first** (CASH/CREDIT) — drives which sections render. On CREDIT, show a
    "Credit terms" `FormSection` (requested limit, term days, guarantee-doc `PhotoCaptureSlot kind=FREE`).
  - `legalName` + `crNumber` are **editable** (no `lockName`/`lockCr` — those locks are for editing an
    existing Steward-owned record, `permissions.ts:70-80`; at create the salesman authors them).
  - Photo slots use `PhotoCaptureSlot` **without `attachTo`**, capturing unbound `attachmentId`s via `onChange`
    (§1). CR slot mirrors `EnrichmentForm.tsx:394-404` minus `attachTo`.
  - **Multi-branch** repeater: an "Add branch" button appends a branch-draft card (each = the branch block
    from `EnrichmentForm.tsx:501-650`). Branch region/route default to the salesman's route, locked for SALESMAN.
  - Sticky submit bar (mirror `EnrichmentForm.tsx:659-677`): "Submit for approval" + "Save draft", same
    client-side mandatory gate + `submitLockRef` double-tap guard (`EnrichmentForm.tsx:91,268-269`).
- Add nav entry: `components/nmwc/Sidebar.tsx:29-34` SALESMAN nav → `{ href: '/customers/new', label: 'New
  customer', icon: PlusCircle }`. Also a primary CTA on `/today` and `/customers` list header.

Client action call: `createCustomerRequestAction(input)` returning the `SafeAction` shape
(`lib/errors.ts:157`) so the form renders `result.fields` inline exactly like `EnrichmentForm.tsx:319-326`.

---

## 5. Provisional code generation [Proposed — resolves the unused formatCustomerCode]

**[Confirmed]** `nmwcCode` is `@unique` and is the business key (`schema.prisma:246`). Import uses the raw ERP
`cust_code` as `nmwcCode` (`imports.ts:820-833`), i.e. for imported customers `nmwcCode` == Temix code. A
net-new customer has **no Temix code yet** (Temix assigns it on the batch upload — this app is an *aid* to
Temix, `x-integration.md` M.8). So a net-new customer needs a **provisional code** until Temix returns the real
one.

**[Proposed]** Finally wire up `formatCustomerCode` (`lib/codes.ts:9-18`):
- Allocate `provisionalCode = NMWC-<year>-<seq>` at **SUBMIT** (not DRAFT — avoids burning codes on abandoned
  drafts). Atomic sequence via a new `CodeSequence` counter row (`{ scope: 'CUSTOMER-2026', next: Int }`) in the
  submit transaction — pattern parallels OLD's `RequestSequence` upsert (`old-functional.md` §4 step 3) but on
  NEW's stack:
  ```ts
  const row = await tx.codeSequence.upsert({
    where: { scope: `CUSTOMER-${year}` },
    create: { scope: `CUSTOMER-${year}`, next: 2 },
    update: { next: { increment: 1 } },
    select: { next: true },
  });
  const provisionalCode = formatCustomerCode(year, row.next - 1); // NMWC-2026-000001
  ```
  The `NMWC-` prefix visibly distinguishes app-minted provisional codes from imported ERP `cust_code`s
  (e.g. `10023` style). This lets the Steward's Temix export flag "these N customers need ERP codes assigned."
- On materialize (final approve), the real `Customer.nmwcCode` = the `provisionalCode`. It stays provisional
  until a later Steward import round-trips the Temix code back.

**[Open]** Two sub-decisions:
1. **Reconciliation:** when Temix assigns the real code, does the Steward *rename* `nmwcCode` (breaks it as a
   stable key + orphans `importRowId` lineage) or store the Temix code in a **new `temixCode` column** and keep
   `nmwcCode` = provisional forever? Recommend adding `Customer.temixCode String? @unique` (also solves the
   `temixCode↔nmwcCode` crosswalk gap flagged in `x-integration.md` M.1.1) and never mutating `nmwcCode`.
2. **Prefix collision:** confirm no existing imported customer already uses an `NMWC-YYYY-NNNNNN` code (grep of
   prod data). If clean, the prefix is a safe namespace for app-minted codes.

---

## 6. Duplicate check at creation time [Proposed — decision required, new-rules.md F]

**[Confirmed]** NEW dedup is exact-only + Steward-driven, and runs OFFLINE (not at write time):
`findDuplicateCandidates` (`services/duplicates.ts:57-159`) surfaces (1) exact `crNumberNorm` match and (2)
EXACT_TRIPLE = `lower(legalName)` + `primaryPhoneNorm` + first-branch `regionId`. Phone-only is legitimate and
**never blocks** (P1.3, `edits.ts:324-341`; phone unique index was dropped, `20260510160000_p1_drop_phone_unique`).
The enrichment path only *logs* phone collisions, never blocks (`edits.ts:329-341`).

The OLD system, by contrast, ran a duplicate check at submit and could hard-BLOCK
(`BLOCKED_EXACT_DUPLICATE`) or WARN (`WARNING_POSSIBLE_DUPLICATE`) — `old-functional.md` §4 step 5.

**[Proposed] onboarding dedup policy (blends both):**
- **HARD BLOCK at SUBMIT on exact CR match:** if `crNumberNorm` matches any live `Customer` OR any other
  SUBMITTED `CustomerCreateRequest`, block with a `ConflictError('DUPLICATE_CR', …)` (reuse
  `duplicates.ts:116-131` matching logic). A CR is a legal-registration key — a true exact CR collision is
  almost always the same entity. This mirrors OLD's `BLOCKED_EXACT_DUPLICATE` and prevents minting a duplicate
  master row that the Steward would later have to merge.
- **HARD BLOCK on EXACT_TRIPLE:** same `lower(legalName)` + `primaryPhoneNorm` + branch `regionId` as an
  existing live customer → block (reuse `duplicates.ts:133-150`).
- **ADVISORY (non-blocking) on phone-only match:** show the salesman "This phone is already on customer X — is
  this a new shop for the same owner? [Continue] / [Cancel]" and log it (mirror `edits.ts:336-340`
  `edit.phone_shared_with_other_customer`). Phone sharing is legitimate (`new-rules.md` F).
- **NO fuzzy matching at create** — consistent with NEW's deliberate removal of Levenshtein/n-gram
  (`duplicates.ts:36-56`, `new-rules.md` F). Fuzzy stays a Steward offline review concern.
- Also run the in-request dedup the import lane already does (F-04: in-file duplicate phone/CR flagged,
  `imports.ts:558-642`) — here, dedup the branch-drafts within one request (two branches same branchCode).

**[Open]** Should the exact-CR block be a hard stop or a "route to Steward for merge-or-approve" soft gate? OLD
allowed a supervisor to override POSSIBLE but never EXACT (`old-functional.md` §6). Recommend: hard block for
the salesman; if legitimately distinct, Steward creates via import (their lane already handles collisions).

---

## 7. Threading the multi-tier approval chain [Proposed — links to approval-engine blueprint]

The approval engine (separate blueprint) owns the generic tier machine. The create lane binds to it thus:

- **CASH chain:** SALESMAN submit → SUPERVISOR approve → ACCOUNTANT approve → **materialize + queue Temix upload**.
- **CREDIT chain:** SALESMAN submit → SUPERVISOR → FINANCE_MANAGER → GM → ACCOUNTANT → **materialize + queue
  Temix upload**. FM and GM see/act on the credit-terms fields (`requestedCreditLimit`, `paymentTermDays`,
  guarantee docs); FM/GM can enter an approved amount (§3 Open).
- **Reuse the atomic-claim pattern** from approve (`edits.ts:767-780` `updateMany` guarded by current state) so
  two approvers at the same tier can't double-advance — the create lane advances `state`/`currentTier`
  atomically per tier.
- **Separation of duty:** reuse the self-approval block (`permissions.ts:134`) — submitter can never approve;
  extend to "no approver may act on a tier they already acted on."
- **Return-for-correction:** any tier can return → `NEEDS_CORRECTION` back to the salesman with a reason
  (mirror `rejectEditCore` reason 5–1000 chars + category, `edits.ts:925-927`); salesman edits the draft and
  re-submits (no new provisional code — reuse the one allocated on first submit).
- **Notifications + SLA (v1 in scope, `new-rules.md` M = absent today):** each tier transition enqueues an
  in-app + email notification to the next approver and starts an SLA timer; on breach, escalate. This is the
  approval-engine/notification blueprint's job; the create lane just emits the same events the edit lane will.

---

## 8. Final materialization — producing real Customer + Branch[] + queuing Temix upload [Proposed]

On the FINAL tier approval (ACCOUNTANT for both chains), `materializeCreateRequest(tx, requestId, actorId)` runs
in **one transaction**, reusing the promote/apply patterns:

1. **Re-run the mandatory gate** against the request (mirror the approve-time re-check `edits.ts:739-760`, which
   catches a photo detached post-submit → `NEEDS_REUPLOAD`). If a captured `Attachment` was since soft-deleted,
   fail with `NEEDS_REUPLOAD`.
2. **Re-run the exact-CR / EXACT_TRIPLE dedup** (§6) against live customers — a colliding customer may have been
   created/imported during the approval window. On collision → block, return to Steward.
3. **Create the `Customer`** — same field set as the import create (`imports.ts:832-844`) plus credit fields:
   `nmwcCode = request.provisionalCode`, `legalName`, `paymentTerms`, `crNumber`+`crNumberNorm`
   (`normalizeCR`, `lib/cr.ts`), `primaryPhone`+`primaryPhoneNorm`, `contactPerson`, `contactRole`, `altPhone`,
   `channelId`, `subChannelId`, `notes`, credit fields (`approvedCreditLimit`, `paymentTermDays`),
   `createdById = request.submittedById`, `lastEditedById = actorId`, `status = ACTIVE`.
4. **Create each `Branch`** (`imports.ts:846-868` shape): `branchCode = formatBranchCode(provisionalCode, i+1)`
   (`lib/codes.ts:16`), `branchName`, `regionId`, `routeId`, `address`, GPS, `dayOfVisit`, equipment counts,
   `createdById`. The `branch_region_consistency_check` trigger (`new-data.md` §5) enforces region==route.
5. **Bind the pre-captured photos** — for CR: set `attachment.customerId` + `kind=CR`, set `customer.crPhotoId`
   (mirror `photos.ts:140-146`). Per branch: bind shop/signboard/free (mirror `photos.ts:195-217`). Each with
   the same validation from §1.
6. **Compute completeness** — `scoreCustomer` / `scoreBranch` (`lib/completeness.ts`, as `edits.ts:574-584`).
7. **Set `request.state=APPROVED`, `request.createdCustomerId`, `reviewedById`, `reviewedAt`.**
8. **Write audit** — `AuditLog` `action=CREATE` (the enum value exists, `schema.prisma:73`), `entityType=Customer`,
   `entityId`, `after` = full snapshot (mirror the create-audit gap; enrichment writes UPDATE, `edits.ts:440-449`).
9. **Queue the Temix upload** — **[Resolved by approval-engine blueprint]**: `Customer.temixSyncState`
   enum (`NONE/PENDING_UPLOAD/UPLOADED/DEACTIVATE_PENDING`) + `temixSyncQueuedAt`, indexed for the Steward
   export lane (approval-engine.md §3.4). Materialization sets `temixSyncState = 'PENDING_UPLOAD'` +
   `temixSyncQueuedAt = now()`; the Steward's export (`services/exports.ts`) filters `PENDING_UPLOAD` as the
   "needs ERP code" sheet, and the next Steward import round-trips the assigned Temix code (which lands in
   `Customer.temixCode` per §5 Open 1) and flips `UPLOADED`. Audit action `FINALIZE` (engine's new enum value)
   is written alongside `CREATE`.

Wrap in `runAction` (`lib/errors.ts:157`); `revalidatePath('/customers', '/work', '/today')`.

---

## 9. Multi-branch at creation [Proposed]

- **[LOCKED requirement]** 1:N Customer→Branch must be restored; the pilot flattened to 1:1 and some code assumes
  `branches[0]`. The create form's branch repeater authors ≥1 `CustomerCreateBranch` rows; materialization
  creates all of them. This is the cleanest place to *re-establish* true multi-branch since it's net-new code.
- **[Open]** Can a salesman create multiple branches in ONE request, or must branch #2+ come as a separate
  "add branch" request against an existing customer (OLD's `NEW_BRANCH` type, `old-functional.md` §6)? A
  salesman's scope is a single route (`User.ownedRouteId` 1:1); a multi-branch customer may span routes/regions
  he doesn't own. Recommend: **v1 allows N branches but all must be on the salesman's own route**; cross-route
  branches are added later by the branch owner or a Manager. This matches the existing scope rule
  (`edits.ts:357-359`) and avoids a scope-leak.
- Branch `regionId` must equal its `route.regionId` (trigger + `x-integration.md` M.1.5); since the branch is
  locked to the salesman's route, region is derived, not free-entered.

---

## 10. Security / must-fix interactions [Confirmed]

- The create action must be **region/route-scoped fail-closed** for the salesman (own route only), avoiding the
  Manager BOLA class flagged for the edit path (`new-security.md` H-1; `x-integration.md` M.6 item 3).
- Rate-limit the create submit (reuse `checkLimit('create:<userId>', FORM_LIMIT)`, `edits.ts:209`) — but note
  the live rate-limiter Postgres path always-grants (BUG-1, `lib/rate-limit.ts`) must be fixed first
  (`x-integration.md` M.6 item 3).
- Formula-injection defense on authored text (`legalName`/`address`/`contactPerson`/`notes`) — reuse the import
  guard (`imports.ts:54-57`) and `stripHtml` (`edit.ts:14`).

---

## 11. OPEN QUESTIONS (business decisions)

1. **Provisional-code reconciliation (§5 Open 1):** add `Customer.temixCode @unique` and keep `nmwcCode`
   provisional forever, or rename `nmwcCode` when Temix assigns? (Recommend: add `temixCode`.)
2. **Credit limit amendment authority (§3, narrowed):** requested-vs-approved fields are settled
   (approval-engine columns). Still open: may FM/GM grant MORE than requested; may GM override FM's figure
   without a re-loop? (Recommend: ≤ requested; GM override allowed, audited on EditApproval.)
3. **Multi-branch in one request (§9 Open):** allow N branches per create request (all on salesman's route), or
   one branch at create + separate add-branch requests? (Recommend: N on own route.)
4. **Exact-CR collision handling (§6 Open):** hard-block the salesman, or soft-route to Steward for
   merge-or-approve? (Recommend: hard-block; Steward uses import lane.)
5. **Who else can create (§4):** SALESMAN only, or also STEWARD/MANAGER direct-write (bypassing the chain, as
   they do for edits, `edits.ts:421-451`)? A Steward already creates via import; a Manager direct-create would
   bypass finance approval for credit — likely disallow Manager credit-create.
6. ~~Temix upload queue mechanism~~ **RESOLVED**: `Customer.temixSyncState` + `temixSyncQueuedAt` per the
   approval-engine blueprint §3.4 (§8 step 9).
7. **Orphan-attachment GC (§1 Open):** extend `photo-gc` to sweep never-bound attachments from abandoned drafts?
8. **Draft retention:** how long do DRAFT create requests live before auto-archive? (No `CustomerEdit` DRAFT TTL
   exists today.)
9. **CASH→CREDIT switch mid-draft:** if a salesman flips payment terms after entering data, must credit fields
   be (re)collected before submit? (Client gate handles it; confirm no partial-credit submits.)

---

## Key file:line anchors (for implementers)
- Promote/upsert pattern to mirror at materialize: `services/imports.ts:700-923` (upsert `:820-868`).
- Mandatory-field gate to fork: `services/edits.ts:98-187`; approve-time re-check `:739-760`.
- Apply/versioning pattern: `services/edits.ts:496-585`.
- Photo pipeline (unbound-attachment enabler): `components/nmwc/PhotoCaptureSlot.tsx:197-283`;
  attach/validate `services/photos.ts:62-239`; finalize `app/api/photos/finalize/route.ts`.
- Code generators (wire up): `lib/codes.ts:9-18`.
- Dedup logic to reuse: `services/duplicates.ts:57-159` (CR `:116-131`, triple `:133-150`).
- Enrichment form to clone: `app/(app)/customers/[id]/edit/EnrichmentForm.tsx` (+ `page.tsx` guards).
- Validation schemas to fork: `lib/validation/edit.ts:16-92`.
- Field locks (why create differs): `lib/permissions.ts:70-80`.
- Action result shape: `lib/errors.ts:157`; scope loader `lib/access.ts`.
- Sidebar nav to extend: `components/nmwc/Sidebar.tsx:29-34`.
- Schema anchors: Customer `schema.prisma:244-292`, Branch `:294-349`, CustomerEdit `:352-381`,
  enums `:15-106` (AuditAction.CREATE `:73`, EditTarget `:52-55`).
