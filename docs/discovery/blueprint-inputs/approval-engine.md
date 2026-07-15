# Design: Multi-Tier, Payment-Terms-Conditional Approval Engine

**Design area:** evolve NEW's single-tier edit approval (`services/edits.ts`, `lib/permissions.ts`, `lib/access.ts`) into a sequential multi-step engine covering UPDATE (1 approver), CREATE-CASH (Supervisor→Accountant), CREATE-CREDIT (Supervisor→Finance Manager→GM→Accountant), routed by `paymentTerms`.
**Base repo:** `C:\Users\abdulr\Desktop\NMWC-CRM` (all paths below relative to it unless noted).
Confidence tags: **[Confirmed]** = read in code, **[Proposed]** = this design, **[Open]** = needs business decision.

---

## 1. Current state (what exists today) — [Confirmed]

| Behavior | Where |
|---|---|
| Edit state machine `DRAFT, SUBMITTED, APPROVED, REJECTED, NEEDS_CORRECTION` | `prisma/schema.prisma:44-50` |
| `CustomerEdit` model: single `reviewedById/reviewedAt`, no step concept; `customerId` already nullable | `prisma/schema.prisma:352-381` |
| Role enum: 5 roles only (`SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER`) | `prisma/schema.prisma:15-21`, mirrored `lib/permissions.ts:15-21` |
| Submit: SALESMAN (route-scoped) queues; STEWARD/MANAGER direct-write; everyone else 403 | `services/edits.ts:259-264` (role gate), `edits.ts:421` (`isDirectWrite`), `edits.ts:424-451` (auto-APPROVED + apply + audit in one tx) |
| **H-1 hole**: the MANAGER/STEWARD branch at `edits.ts:262-264` never checks region scope — a Manager can direct-write ANY customer nationwide. `assertCanEditCustomer` exists (`lib/access.ts:158-164`) and is fail-closed for empty-region Managers (`lib/access.ts:85-95,143-146`) but is not called in `submitEditCore` | `services/edits.ts:259-264`, `lib/access.ts:138-164` |
| One open edit per customer: app check `edits.ts:266-277` + partial unique index `CustomerEdit_open_per_customer` (`WHERE state='SUBMITTED' AND customerId IS NOT NULL`) | `prisma/migrations/20260509150000_qa_remediation/migration.sql:10-14`; P2002 mapped at `edits.ts:465-481` |
| Approver check `canApproveSpecificEdit`: self-approval block (EL-15, `permissions.ts:134`), SUPERVISOR = direct report only (`permissions.ts:143`), MANAGER = region overlap fail-closed (RBAC-05-003, `permissions.ts:135-142`) | `lib/permissions.ts:125-145`; called at `edits.ts:628`, `edits.ts:947` |
| Atomic claim on approve: `updateMany({where:{id, state:SUBMITTED}})`, loser gets `NOT_PENDING` (PROD-001) | `services/edits.ts:767-780` |
| Apply-with-optimistic-lock: versioned `updateMany` on `Customer.version` / `Branch.version`, `VERSION_CONFLICT` on miss (B-05) | `services/edits.ts:496-585` (customer 526-540, branch 552-572) |
| Approve-time re-checks: STATUS_BYPASS guard (`edits.ts:663-675`), lock re-eval QA-013 (`edits.ts:677-692`), mandatory-gate re-run EL-04 (`edits.ts:739-760`), dropped-branch handling QA-039 (`edits.ts:714-730`) | `services/edits.ts` |
| Reject: reason 5–1000 chars + category, sets `NEEDS_CORRECTION` (the `REJECTED` enum value is never set today) | `services/edits.ts:919-983` (state write at 959-968) |
| Audit per decision: APPROVE writes full `fieldChanges` diff (EL-05) | `services/edits.ts:785-798`; REJECT at 969-977 |
| Bulk approve/reject loops per-edit isolated transactions, cap 50 | `services/edits.ts:818-913` |
| Queues query `state:'SUBMITTED'` + supervisor relation directly | `app/(app)/approvals/page.tsx:26-35`, `app/(app)/work/page.tsx:38,65,92`, `app/(app)/dashboard/page.tsx:82` |
| **No customer-creation flow exists in app code** — `prisma.customer.create` appears only in seed/scripts (`prisma/synthetic.ts:317`, `scripts/flatten-customer-branches.ts:137`); production Customers are created only by Steward import promote (`services/imports.ts:709-923`). CREATE-CASH/CREATE-CREDIT are net-new build | grep-verified |
| No notification/SLA subsystem (discovery `new-rules.md` §M) | absent from schema + package.json |
| OLD system precedent for multi-stage + return-vs-reject: `RETURNED_BY_SUPERVISOR`/`RETURNED_BY_ACCOUNTANT` → back to salesman-editable; `REJECTED_*` terminal; optimistic `updateMany` on `{id,status}`; SLA 8h/9h with escalation cron | ICO `customer-portal` (discovery `old-functional.md` lines 30-55, 100-105) |

---

## 2. Chain definition: config-in-code matrix with per-request snapshot — [Proposed]

**Recommendation: a versioned TypeScript approval-matrix constant (`lib/approval-chains.ts`), keyed by `processType` (which already encodes the paymentTerms condition), with the resolved chain SNAPSHOTTED onto each request row at submit time.** Not a DB-table-driven config, and not scattered `if (create && credit)` branching.

Justification:
1. There are exactly **three chains** and they are **owner-locked business decisions** — churn is near zero. A DB config table buys nothing but costs an admin UI, validation (cycles, unknown roles, empty chains), migration seeding, and a new privilege surface ("who edits the matrix?" — a question the owner has not asked to answer).
2. The NEW codebase's whole style is **compile-time-checked pure functions in `lib/`** (`lib/permissions.ts:1-5`: "Pure functions, no DB access"). A code matrix gets exhaustive `Role`-enum type-checking and unit tests (`tests/unit/permissions.test.ts` pattern) for free; the OLD system shows what hardcoded per-transition route files degenerate into (17 statuses, dead legacy states — `old-functional.md` line 61).
3. The **snapshot** (`chainSnapshot Json` on the request) gives the one real benefit DB-config would have offered: in-flight requests are deterministic even if a future release changes the matrix. Advancement always reads the snapshot, never the live constant. This mirrors how `fieldChanges` is already snapshotted at submit (`edits.ts:435,461`).

```ts
// lib/approval-chains.ts  [Proposed — new file]
import { Role, PaymentTerms, ApprovalProcess } from '@prisma/client';

export const CHAIN_VERSION = 1;

export type ChainStep = { role: Role; slaHours: number };

/** Approver steps only — the submitting Salesman is "step -1" (the submit itself). */
export const APPROVAL_CHAINS: Record<ApprovalProcess, readonly ChainStep[]> = {
  UPDATE: [{ role: Role.SUPERVISOR, slaHours: 8 }],
  CREATE_CASH: [
    { role: Role.SUPERVISOR, slaHours: 8 },
    { role: Role.ACCOUNTANT, slaHours: 9 },
  ],
  CREATE_CREDIT: [
    { role: Role.SUPERVISOR, slaHours: 8 },
    { role: Role.FINANCE_MANAGER, slaHours: 16 },
    { role: Role.GM, slaHours: 24 },
    { role: Role.ACCOUNTANT, slaHours: 9 },
  ],
} as const;

export function resolveProcess(
  kind: 'CREATE' | 'UPDATE',
  paymentTerms: PaymentTerms
): ApprovalProcess {
  if (kind === 'UPDATE') return ApprovalProcess.UPDATE;
  return paymentTerms === PaymentTerms.CREDIT
    ? ApprovalProcess.CREATE_CREDIT
    : ApprovalProcess.CREATE_CASH;
}
```

(SLA hours: supervisor 8h / accountant 9h mirror OLD's proven values, `old-functional.md` line 102; FM/GM values are placeholders — **[Open] O-8**.)

Note on step counting: the owner's "3 approvals" for CASH counts the Salesman's submit; in engine terms CASH has **2 approver steps** and CREDIT has **4 approver steps**. The matrix encodes approver steps only.

---

## 3. Schema changes (Prisma + migration SQL) — [Proposed]

### 3.1 Enums

```prisma
enum Role {
  SALESMAN
  SUPERVISOR
  ACCOUNTANT        // NEW
  FINANCE_MANAGER   // NEW
  GM                // NEW
  MANAGER
  STEWARD
  VIEWER
}

enum ApprovalProcess {
  UPDATE
  CREATE_CASH
  CREATE_CREDIT
}

enum EditState {
  DRAFT
  SUBMITTED          // pending at SOME step; currentStep says which
  APPROVED           // final step approved; changes applied / customer created
  REJECTED           // terminal — the enum value finally gets used (see §7)
  NEEDS_CORRECTION   // returned to salesman; resubmittable
}

enum StepDecision {
  APPROVED
  RETURNED
  REJECTED
}

enum TemixSyncState {
  NOT_SYNCED
  PENDING_UPLOAD
  UPLOADED
  PENDING_DEACTIVATION
}
```

Postgres migration (enum-value adds are additive-safe):

```sql
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FINANCE_MANAGER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'GM';
CREATE TYPE "ApprovalProcess" AS ENUM ('UPDATE','CREATE_CASH','CREATE_CREDIT');
CREATE TYPE "StepDecision" AS ENUM ('APPROVED','RETURNED','REJECTED');
CREATE TYPE "TemixSyncState" AS ENUM ('NOT_SYNCED','PENDING_UPLOAD','UPLOADED','PENDING_DEACTIVATION');
```

### 3.2 `CustomerEdit` — generalize to a chain-carrying request

Extend the existing model (`schema.prisma:352-381`) rather than adding a parallel "CustomerRequest" model: the queue pages, the partial-unique lock, audit trail and bulk actions already hang off `CustomerEdit`, and `customerId` is already nullable (`schema.prisma:355`), which is exactly what CREATE needs.

```prisma
model CustomerEdit {
  // ... existing fields unchanged ...

  // ── Multi-tier chain (NEW) ──
  processType          ApprovalProcess @default(UPDATE)
  chainVersion         Int             @default(1)
  chainSnapshot        Json            // [{"role":"SUPERVISOR","slaHours":8}, ...]
  currentStep          Int             @default(0)   // index into chainSnapshot while SUBMITTED
  currentStepRole      Role?           // denormalized for queue queries; null when not SUBMITTED
  currentStepEnteredAt DateTime?       // SLA anchor, reset on every advance + resubmit
  cycle                Int             @default(1)   // bumped on each resubmit after NEEDS_CORRECTION

  // ── CREATE payload (NEW; null for UPDATE) ──
  proposedCustomer     Json?           // full customer draft: legalName, paymentTerms, channel, phones, ...
  proposedBranches     Json?           // ARRAY of branch drafts (multi-branch, per locked decision)
  createdCustomerId    String?         // set at final approval — the Customer this request produced

  // ── CREDIT data captured for FM/GM (NEW; null unless credit chain) ──
  requestedCreditLimit Decimal?        @db.Decimal(12, 3)   // OMR, 3 dp
  approvedCreditLimit  Decimal?        @db.Decimal(12, 3)   // FM/GM may adjust; final value applied
  paymentTermDays      Int?

  decisions            ApprovalStepDecision[]

  @@index([currentStepRole, state, submittedAt])   // "my queue" for FM / GM / Accountant
  @@index([state, currentStepEnteredAt])           // SLA scanner
}
```

`reviewedById/reviewedAt` (`schema.prisma:360-361`) are kept but redefined as "**final** decider" — backward compatible with every existing read.

### 3.3 `ApprovalStepDecision` — audit-per-transition as first-class rows

`AuditLog` (`schema.prisma:489-507`) remains the immutable forensic trail, but queue UIs and the SLA/notification engine need a queryable per-step record (who approved step 2, when, with what credit amendment):

```prisma
model ApprovalStepDecision {
  id          String       @id @default(cuid())
  editId      String
  cycle       Int
  stepIndex   Int
  stepRole    Role
  decision    StepDecision
  decidedById String
  decidedAt   DateTime     @default(now())
  reason      String?      @db.Text   // required for RETURNED/REJECTED (5–1000, reuse edits.ts:925-927 rule)
  category    String?
  // FM/GM credit amendments recorded at the step that made them:
  creditLimitAtDecision     Decimal? @db.Decimal(12, 3)
  paymentTermDaysAtDecision Int?

  edit      CustomerEdit @relation(fields: [editId], references: [id])
  decidedBy User         @relation("StepDecider", fields: [decidedById], references: [id])

  @@unique([editId, cycle, stepIndex])   // one decision per step per cycle — DB-level idempotency
  @@index([decidedById, decidedAt(sort: Desc)])
}
```

The `@@unique([editId, cycle, stepIndex])` is the multi-step generalization of the PROD-001 idea: even if the `updateMany` claim (§6) somehow raced, the decision insert would P2002.

### 3.4 Customer — credit + Temix sync fields

```prisma
model Customer {
  // ... existing ...
  creditLimit     Decimal?       @db.Decimal(12, 3)
  paymentTermDays Int?           // MIGRATED customers: loaded FROM TEMIX at migration (locked decision)
  temixCode       String?        @unique          // crosswalk key (x-integration M.1.1)
  temixSyncState  TemixSyncState @default(NOT_SYNCED)
  temixSyncedAt   DateTime?
}
```

(Temix batch-upload queue mechanics belong to the integration design area; this design only defines the **hook** in §8.)

### 3.5 Locks / indexes

- Keep `CustomerEdit_open_per_customer` (`migrations/20260509150000_qa_remediation/migration.sql:12-14`) unchanged — it only covers `customerId IS NOT NULL`, so UPDATE requests keep their one-open-edit invariant and CREATE requests (customerId null) are unaffected. [Confirmed it already excludes null.]
- **[Proposed]** duplicate open-CREATE handling: at submit, run the existing exact-dup rules from `services/duplicates.ts:116-150` (CR-exact + name+phone+region triple) against live customers AND open CREATE requests; soft-warn to approvers rather than hard-block. Hard block? **[Open] O-6**.

### 3.6 Backfill migration for existing rows

```sql
UPDATE "CustomerEdit"
SET "processType" = 'UPDATE',
    "chainVersion" = 1,
    "chainSnapshot" = '[{"role":"SUPERVISOR","slaHours":8}]'::jsonb,
    "currentStep" = 0,
    "currentStepRole" = CASE WHEN "state" = 'SUBMITTED' THEN 'SUPERVISOR'::"Role" ELSE NULL END,
    "currentStepEnteredAt" = CASE WHEN "state" = 'SUBMITTED' THEN "submittedAt" ELSE NULL END,
    "cycle" = 1;
```

Historical APPROVED rows get a synthesized `ApprovalStepDecision(stepIndex 0, decision APPROVED, decidedById = reviewedById, decidedAt = reviewedAt)` in the same migration so per-step history is total.

---

## 4. State machine and step advancement — [Proposed]

```
DRAFT ──submit──▶ SUBMITTED(step 0) ──approve──▶ SUBMITTED(step 1) ──…──▶ approve @ last step
                        │                                                        │
                        │ return (any step)                                      ▼
                        ▼                                              APPROVED ──▶ apply changes /
                 NEEDS_CORRECTION ──resubmit (cycle+1, step 0)──▶ SUBMITTED         create Customer+Branches
                        │                                                           + queue Temix upload
                 reject (any step)
                        ▼
                    REJECTED (terminal)
```

- **`SUBMITTED` remains the single "pending" state** — `currentStep`/`currentStepRole` locate it in the chain. This keeps every existing query valid (`approvals/page.tsx:26`, `work/page.tsx:38,65,92`, `dashboard/page.tsx:82`, `customers/[id]/edit/page.tsx:125`); they add a `currentStepRole` filter, not a state rework, and the partial unique index needs no change.
- **Changes are applied ONLY at final approval.** Intermediate approvals mutate nothing on `Customer`/`Branch` — they only advance the pointer and write an `ApprovalStepDecision` + `AuditLog`. This preserves the all-or-nothing semantics the optimistic-lock design comment assumes (`edits.ts:503-513`).
- Submit routing in `submitEditCore` (`edits.ts:207`): after zod parse, compute `processType = resolveProcess(kind, paymentTerms)`; snapshot `APPROVAL_CHAINS[processType]`; set `currentStep=0`, `currentStepRole=chain[0].role`, `currentStepEnteredAt=now`.
- **Resubmit after NEEDS_CORRECTION**: new action `resubmitEditAction` flips the SAME row `NEEDS_CORRECTION→SUBMITTED`, `cycle+1`, `currentStep=0`, refreshed payload/diff. Same-row reuse is required for CREATE (the row owns `proposedCustomer`, attachments, credit data). Today's UPDATE flow creates a brand-new `CustomerEdit` per submission (`edits.ts:454-464`); that remains acceptable for UPDATE, but CREATE must reuse the row. **Chain always restarts at step 0 on resubmit** (see §7 rationale).

### 4.1 paymentTerms mid-flight and the CASH→CREDIT conversion hole

- QA-013 today re-evaluates locks when paymentTerms changed between submit and approve (`edits.ts:677-692`) — proof the codebase already treats paymentTerms as mutable in-flight.
- **[Proposed]** the chain is resolved ONCE at submit from the snapshot and never re-routed mid-flight; a paymentTerms change on the underlying customer during flight does not mutate the chain (deterministic, auditable).
- **[Proposed]** an UPDATE whose `fieldChanges` include `customer.paymentTerms: CASH→CREDIT` must NOT ride the single-step UPDATE chain — that would grant credit with only Supervisor sign-off, bypassing FM/GM entirely. Route it onto the CREATE_CREDIT chain (a "credit conversion" request carrying `requestedCreditLimit` + `paymentTermDays` + guarantee docs; `target` stays CUSTOMER, `customerId` set). Implementation: in `submitEditCore` after diff building (`edits.ts:343-348`), if the diff moves `paymentTerms` toward CREDIT, force the credit chain — for ALL roles, mirroring how EL-01 already denies even admins the customer-status shortcut (`edits.ts:297-311`). CREDIT→CASH downgrade routing: **[Open] O-2**.

### 4.2 Guarantee/security documents

Add `AttachmentKind.GUARANTEE` (`schema.prisma:57-62`) and allow multiple guarantee docs per request via `attachmentChanges` (already Json, `schema.prisma:365`). The kind-binding defense extends with the new kind (`app/api/photos/finalize/route.ts:33-36,88-92`; `services/photos.ts:98-112`). FM step UI surfaces them; final apply wires them to the created Customer.

---

## 5. Who can act at each step — extend `lib/permissions.ts` — [Proposed]

Replace `canApproveSpecificEdit` (`permissions.ts:125-145`) with a step-aware check (keep the old name as a thin wrapper for the UPDATE chain so `edits.ts:628,947` and `tests/unit/permissions.test.ts:57-120` migrate incrementally):

```ts
// lib/permissions.ts  [Proposed]
export function canActOnStep(
  user: SessionUser,
  step: { role: Role; index: number },
  submittedBy: Pick<User, 'id' | 'supervisorId'>,
  context: {
    customerBranches?: Pick<Branch, 'regionId' | 'deletedAt'>[]; // live OR proposed-branch regions for CREATE
    managedRegionIds?: string[];
    priorDeciderIds?: string[];   // decidedById of this cycle's earlier steps
  } = {}
): boolean {
  // EL-15 generalized: submitter can never act at ANY step (permissions.ts:134 today)
  if (user.id === submittedBy.id) return false;
  // Separation of duty across steps: one human may decide at most one step per cycle
  if ((context.priorDeciderIds ?? []).includes(user.id)) return false;

  switch (step.role) {
    case Role.SUPERVISOR:
      // exact current rule (permissions.ts:143) — the submitter's own supervisor
      if (user.role === Role.SUPERVISOR) return submittedBy.supervisorId === user.id;
      // MANAGER region-overlap override retained ONLY for the SUPERVISOR step
      // (today's RBAC-05-003 behavior, permissions.ts:135-142) — fail-closed
      if (user.role === Role.MANAGER) {
        const branches = (context.customerBranches ?? []).filter((b) => !b.deletedAt);
        const managed = context.managedRegionIds ?? [];
        return managed.length > 0 && branches.length > 0 &&
          branches.some((b) => managed.includes(b.regionId));
      }
      return false;
    case Role.FINANCE_MANAGER:
    case Role.GM:
    case Role.ACCOUNTANT:
      // org-wide roles: exact role match, no geographic scope (few holders)
      return user.role === step.role;
    default:
      return false;
  }
}
```

Notes:
- For CREATE requests, `customerBranches` is derived from `proposedBranches[].regionId` so the MANAGER override still fails closed correctly; whether the Manager may substitute for the Supervisor at all is **[Open] O-3**.
- FM/GM/ACCOUNTANT are modeled as **global (no region/depot scope)**. OLD scoped accountants by depot with deterministic assignment (`old-functional.md` lines 33, 67); NEW has no depot concept. Any holder of the role may claim the step. **[Open] O-4**.
- `canApproveEdit` (`permissions.ts:48-50`, SUPERVISOR-only, used for UI gating) becomes `canSeeApprovalQueue(user)` = role ∈ {SUPERVISOR, MANAGER, FINANCE_MANAGER, GM, ACCOUNTANT}.
- New roles must be added to every exhaustive switch in `lib/access.ts` (`canSeeCustomer:67-97`, `filterBranchesByScope:107-124`, `canEditCustomer:138-156`). **[Proposed]**: FINANCE_MANAGER/GM/ACCOUNTANT read all customers like VIEWER (they must review anything in their queue regardless of geography); `canEditCustomer` returns false for all three; they cannot submit edits (fall into the `else` throw at `edits.ts:262-264`).

---

## 6. Atomic claim generalized to "claim THIS step" — [Proposed]

Today's claim (`edits.ts:767-780`) guards `{id, state:SUBMITTED}`. Multi-step pins the step AND cycle so two approvers at different times can't double-fire and a stale tab can't approve a step that already advanced:

```ts
// inside decideStepCore (evolution of approveEditCore, edits.ts:600)
const chain = edit.chainSnapshot as ChainStep[];
const step = edit.currentStep;
const isFinal = step === chain.length - 1;

await prisma.$transaction(async (tx) => {
  const claim = await tx.customerEdit.updateMany({
    where: { id: editId, state: EditState.SUBMITTED, currentStep: step, cycle: edit.cycle }, // ← step+cycle pinned
    data: isFinal
      ? { state: EditState.APPROVED, currentStepRole: null, currentStepEnteredAt: null,
          reviewedById: session.id, reviewedAt: new Date() }        // reviewedBy = FINAL decider (back-compat)
      : { currentStep: step + 1, currentStepRole: chain[step + 1].role,
          currentStepEnteredAt: new Date() },
  });
  if (claim.count === 0) {
    throw new ConflictError('NOT_PENDING',
      'This step was just decided by another reviewer. Refresh to see the current state.');
  }

  await tx.approvalStepDecision.create({ data: {
    editId, cycle: edit.cycle, stepIndex: step, stepRole: chain[step].role,
    decision: 'APPROVED', decidedById: session.id,
    creditLimitAtDecision: amendedLimit ?? undefined,
    paymentTermDaysAtDecision: amendedDays ?? undefined,
  }});
  // @@unique([editId, cycle, stepIndex]) backstops the claim at the DB level.

  if (isFinal) {
    if (edit.processType === 'UPDATE') {
      await applyEditChanges(tx, edit.customerId!, customerProposed, branchesPayload, session.id); // unchanged, edits.ts:496-585
    } else {
      await applyCreateApproval(tx, edit, session.id);  // §8
    }
  }
  await tx.auditLog.create({ data: { actorId: session.id, action: 'APPROVE',
    entityType: 'CustomerEdit', entityId: editId,
    after: { step, stepRole: chain[step].role, cycle: edit.cycle, isFinal,
             fieldChanges, approvedCreditLimit } as unknown as Prisma.InputJsonValue } }); // EL-05 preserved per step
});
```

Preserved invariants, relocated:
- **STATUS_BYPASS** re-check (`edits.ts:663-675`) runs at EVERY step (cheap, defense-in-depth).
- **QA-013 lock re-eval** (`edits.ts:677-692`), **EL-04 mandatory re-gate** (`edits.ts:739-760`), **QA-039 dropped-branch filter** (`edits.ts:714-730`) run at the FINAL step (they validate live data that only matters at apply time); EL-04 additionally runs at step 0 to give the Supervisor an early NEEDS_REUPLOAD signal.
- **Optimistic locking** untouched: `applyEditChanges`'s versioned-updateMany semantics (`edits.ts:526-540, 552-572`) execute exactly once, inside the final-step transaction.
- **Bulk approve/reject** (`edits.ts:818-913`) needs no structural change — each loop iteration calls the step-aware action; a mixed-step/mixed-role selection fails individual items with FORBIDDEN/NOT_PENDING, reported per-edit as today.
- Credit amendment rule: FINANCE_MANAGER may amend `approvedCreditLimit`/`paymentTermDays` at their step (values recorded on their decision row); GM approves the amended figure (may further amend? **[Open] O-5**); ACCOUNTANT cannot amend — approve/return/reject only.

---

## 7. Reject / return semantics per step — [Proposed]

Two distinct actions at every step (adopting OLD's proven RETURNED-vs-REJECTED split, `old-functional.md` lines 48-55, over NEW's current single reject → NEEDS_CORRECTION at `edits.ts:959-968`):

| Action | Effect | Who fixes | Chain position after resubmit |
|---|---|---|---|
| **RETURN** (reason 5–1000 + category, reuse `edits.ts:925-927` validation) | `state → NEEDS_CORRECTION`, `currentStepRole → null` | Salesman edits & resubmits (`cycle+1`) | **Step 0 — full chain restart** |
| **REJECT** | `state → REJECTED` (terminal) | Nobody — a new request is required | n/a |

**A return/reject at step 4 goes back to the SALESMAN, not to step 3, and resubmission restarts the whole chain.** Rationale: every approval is a signature over a specific `fieldChanges`/`proposedCustomer` payload; once the salesman touches the payload, prior signatures are stale — silently replaying them would let a salesman change the credit limit after the GM signed. Full restart is what the `@@unique([editId, cycle, stepIndex])` model makes natural (new cycle = fresh decision rows) and matches OLD's behavior (RETURNED_* → salesman-editable draft, `old-functional.md` line 31). A "return to previous step" (GM kicks back to FM without salesman involvement) is deliberately NOT in v1 — **[Open] O-1**.

Both actions use the same atomic claim shape as §6 (`updateMany` pinned on `{id, state:SUBMITTED, currentStep, cycle}`) and write `ApprovalStepDecision` + `AuditLog(action:'REJECT', after:{step, decision})`.

---

## 8. Final approval hook: create Customer/Branches + queue Temix upload — [Proposed]

New `applyCreateApproval(tx, edit, actorId)` in `services/edits.ts` (sibling of `applyEditChanges`, `edits.ts:496`), executed inside the final-step transaction of §6:

1. Re-run the exact-duplicate rules (`services/duplicates.ts:116-150` logic) against live customers; on hit throw `ConflictError('DUPLICATE_AT_APPROVAL', …)` so the Accountant returns the request rather than minting a dup.
2. Generate `nmwcCode` via `lib/codes.ts:9-18` (`NMWC-YYYY-NNNNNN` — currently dead code per discovery `new-rules.md` §G; this flow becomes its first real consumer) and branch codes `<PARENT>-NN`.
3. `tx.customer.create` from `proposedCustomer`; for the credit chain also persist `creditLimit = approvedCreditLimit ?? requestedCreditLimit` and `paymentTermDays`. `createdById = edit.submittedById`, `lastEditedById = actorId`, `version = 0`.
4. `tx.branch.create` per `proposedBranches[]` entry (**multi-branch from day one — never assume `branches[0]`**, per locked decision), each with `regionId`/`routeId` resolved at submit and re-validated live here (route deactivated in-flight → `ConflictError('ROUTE_GONE')`).
5. Rewire attachments: CR photo → `customer.crPhotoId`, shop/signboard → branch slots, GUARANTEE docs → customer, using the slot/kind checks of `services/photos.ts:98-112`.
6. Compute completeness (`lib/completeness.ts` scorers, mirroring `edits.ts:574-585`).
7. Set `edit.createdCustomerId`, and **queue Temix**: `customer.temixSyncState = 'PENDING_UPLOAD'`. The Steward's Temix batch export (integration design area) selects `temixSyncState='PENDING_UPLOAD'`; on export it flips to `UPLOADED` + `temixSyncedAt`; the assigned `temixCode` is written back by the next Temix import (crosswalk per `x-integration.md` M.1.1). Soft-deleted customers flip to `PENDING_DEACTIVATION` for the same export to carry (locked decision: soft-delete is flagged for Temix removal).
8. `tx.auditLog.create({action:'CREATE', entityType:'Customer', entityId:newId, after:{fromEditId: edit.id}})`.

UPDATE final approval also sets `temixSyncState='PENDING_UPLOAD'` on the touched customer so approved master corrections flow to Temix on the next batch. [Proposed]

---

## 9. H-1 fix: MANAGER direct-write scope — [Proposed]

Exact edit in `submitEditCore` (`services/edits.ts:259-264`):

```ts
if (me.role === Role.SALESMAN) {
  const onMyRoute = customer.branches.some((b) => b.routeId === me.ownedRouteId);
  if (!onMyRoute) throw new ForbiddenError('This customer is not on your route.');
} else if (me.role === Role.STEWARD || me.role === Role.MANAGER) {
  // H-1 fix: Manager direct-write must be region-scoped, fail-closed.
  const { loadScope, assertCanEditCustomer } = await import('@/lib/access');
  const scope = await loadScope(me.id);
  assertCanEditCustomer({ id: me.id, role: me.role, username: '' }, customer, scope);
  // STEWARD passes trivially (canEditCustomer → canSeeCustomer STEWARD:true, access.ts:73-75,144-146);
  // MANAGER with empty managedRegions is denied (access.ts:85-95 — RBAC-05-012 fail-closed).
} else {
  throw new ForbiddenError(`Role ${me.role} cannot submit edits.`);
}
```

Additionally in the new design: `isDirectWrite` (`edits.ts:421`) is valid **only for `processType==='UPDATE'`**. STEWARD/MANAGER can never direct-write a CREATE (customer creation happens only via the chain or Steward import promote, `services/imports.ts:709-923`) and never direct-write a CASH→CREDIT conversion (§4.1 forces the credit chain for everyone). New roles (ACCOUNTANT/FINANCE_MANAGER/GM) fall into the final `else` and cannot submit at all. VIEWER stays read-only (`lib/access.ts:153-154`).

---

## 10. Queue / UI query changes — [Proposed]

- `app/(app)/approvals/page.tsx:26-35`: where-clause becomes `{ state:'SUBMITTED', currentStepRole: me.role, ...roleSpecificScope }` — SUPERVISOR keeps the `submittedBy.supervisorId` relation filter; FM/GM/ACCOUNTANT see the whole slice of their step (global roles); MANAGER keeps the region-overlap slice of SUPERVISOR-step items (if O-3 keeps the override).
- `app/(app)/work/page.tsx:38` (salesman "my pending") unchanged; add chain-progress rendering from `chainSnapshot` + `currentStep` ("Step 2 of 4 — with Finance Manager").
- `app/(app)/dashboard/page.tsx:82` count splits per `currentStepRole` for the new roles' dashboards.
- `app/(app)/approvals/[id]/page.tsx:87` (`isPending = state==='SUBMITTED'`) additionally checks `currentStepRole === me.role` before showing decide buttons; credit steps render `requestedCreditLimit`/`paymentTermDays`/guarantee docs and (FM only) the amend inputs.

## 11. SLA + notification hook points (contract for the sibling design area) — [Proposed]

- SLA anchor = `currentStepEnteredAt` + per-step `slaHours` from `chainSnapshot`; scanner uses `@@index([state, currentStepEnteredAt])`. The engine guarantees the anchor resets on every advance/resubmit (§6 sets it inside the claim `updateMany`). Escalation policy (OLD auto-escalated supervisor breaches via hourly cron, `old-functional.md` line 102) belongs to the notification design area.
- Notification trigger points (emitted after the §6/§7 transactions commit): (a) submit → step-0 actors; (b) step advance → next-step actors; (c) RETURN/REJECT → submitter; (d) final APPROVED → submitter + Steward (Temix upload pending).

## 12. Test plan deltas — [Proposed]

Extend `tests/unit/permissions.test.ts` (patterns at :57-120): step-role mismatch denied; self-approval blocked at every step; prior-cycle decider allowed again after resubmit, same-cycle prior decider blocked; FM amendment recorded; GM cannot be skipped; claim race on the same step → exactly one winner, loser NOT_PENDING; resubmit resets to step 0 / cycle 2; CASH→CREDIT UPDATE forced onto the credit chain; H-1: Manager with empty scope AND Manager with disjoint region both denied direct-write.

---

## OPEN QUESTIONS

- **O-1** Reject/return granularity: v1 proposes RETURN→salesman (full chain restart) and REJECT→terminal at every step. Does the GM need "send back one step to Finance Manager" without involving the salesman?
- **O-2** CREDIT→CASH downgrade on an existing customer: single-step UPDATE chain (supervisor only), or does removing credit terms also need Finance/GM sign-off?
- **O-3** May a MANAGER (region) still substitute for the SUPERVISOR step (today's RBAC-05-003 override, `permissions.ts:135-142`), including on CREATE requests (scope derived from proposed branches)? Or is the chain strictly the named roles?
- **O-4** Are FINANCE_MANAGER / GM / ACCOUNTANT global (proposed) or scoped (region/depot like OLD's accountant-per-depot, `old-functional.md` line 67)? If multiple accountants exist, is the step "any accountant may act" (proposed) or assigned-accountant with deterministic routing?
- **O-5** Can GM amend the credit limit the FM approved, or only approve/return? Can GM **delegate** (vacation coverage)? Proposed: delegation is a user-admin feature (acting-role assignment), not an engine feature.
- **O-6** Duplicate handling on CREATE submit: soft-warn to approvers (proposed) or hard-block like OLD's `BLOCKED_EXACT_DUPLICATE` (`old-functional.md` line 48)?
- **O-7** Should the ACCOUNTANT final step double as "confirm keyed into Temix" (OLD's confirm-temix entered the `temixCode`, `old-functional.md` lines 53, 72), or is Accountant approval purely data sign-off with the Temix upload fully owned by the Steward batch export (proposed)?
- **O-8** SLA hours per step for FINANCE_MANAGER and GM (placeholders 16h/24h; OLD precedent only covers supervisor 8h / accountant 9h). Working-hours calendar or wall-clock?
- **O-9** Who may submit CREATE requests — SALESMAN only (proposed), or also SUPERVISOR/STEWARD on behalf of a salesman?
