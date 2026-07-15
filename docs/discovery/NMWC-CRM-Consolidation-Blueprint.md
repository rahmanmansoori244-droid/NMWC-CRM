# NMWC Unified CRM — Target Operating Model & Consolidation Blueprint

**Prepared for:** National Mineral Water Company SAOG (NMWC)
**Phase:** 2 — Target design & consolidation plan (planning artifact; **no code written, no system changed**)
**Date:** 2026-07-15
**Base system:** NEW — *NMWC Customer Master* (`C:\Users\abdulr\Desktop\NMWC-CRM`), the confirmed consolidation foundation.
**Companion documents:** [Discovery & Understanding Report](NMWC-CRM-Discovery-Report.md) · raw discovery evidence in [`raw-evidence/`](raw-evidence/) · codebase-grounded design inputs in [`blueprint-inputs/`](blueprint-inputs/) (6 files with exact `file:line` and DDL).

**Confidence legend:** `[Confirmed]` read in code · `[Proposed]` design decision · `[Open]` needs a business decision (consolidated in §11).
**Status of decisions:** the operating model in §1–§4 is **locked** (confirmed by the NMWC owner). Technical designs in §5–§10 are **proposed**, grounded in the real codebase. Nothing here is built.

---

## 0. How we got here (decisions already locked)

| Decision | Confirmed value |
|---|---|
| Scope | One system for the **full customer lifecycle** — create (cash/credit), enrich/correct, close, soft-delete |
| Positioning | **Aids Temix (ERP), does not replace it** — CRM authors/gathers customer master data + onboards, then **uploads to Temix** (batch) |
| Base | **NEW** (NMWC Customer Master) is the foundation; OLD contributes requirements, not code |
| Roles (8) | Salesman, Supervisor, **Accountant**, **Finance Manager**, **GM**, Steward, Manager, Viewer |
| Create — Cash | Salesman → Supervisor → Accountant → *Temix upload* |
| Create — Credit | Salesman → Supervisor → **Finance Manager** → **GM** → Accountant → *Temix upload*; **CRM captures the credit limit, payment-term days, and guarantee/security documents** the FM/GM approve |
| Update (master correction) | Salesman enriches → Supervisor approves (Viewer read-only) |
| Branches | One customer → **many branches (1:N)** — restore true multi-branch |
| Delete | **Soft-delete/archive** (retained for audit; flags Temix deactivation on next upload) |
| SLA + notifications | **In scope for v1** (approval SLA timers + escalation + in-app & email alerts) |
| Payment terms of migrated customers | **From Temix at migration** (never inferred) |
| Approver scope *(2026-07-15)* | **Finance Manager + GM org-wide; Accountant region-scoped** |
| Rejection semantics *(2026-07-15)* | **Step-back cascade** — reject at step N → back to step N-1; if that step rejects, back one more; reject at the first step → back to the salesman |
| Credit amendment *(2026-07-15)* | **FM/GM cannot amend** — they approve or reject the requested figures only |
| GM requirement *(2026-07-15)* | **GM always required** for credit (no threshold skip) |
| Create-time duplicates *(2026-07-15)* | **Hard-block** exact-CR duplicates |
| Identifier equivalence *(2026-07-15)* | **`nmwcCode` = `temixCode`** — crosswalk is a join, not a matching project |
| Temix master | The **current Temix master export will be provided** by NMWC |
| Non-negotiable, independent of consolidation | Rotate/purge both committed-secret exposures; fix NEW's always-granting rate limiter and Manager scope hole |

---

## 1. Target Operating Model (business)

**One application, three business processes, one master, feeding one ERP.**

```
                          ┌─────────────────────────── NMWC Unified CRM ───────────────────────────┐
  Field (mobile)          │                                                                        │
  Salesman ── CREATE ────▶│  Onboarding pipeline (cash / credit)  ──approved──▶  Customer master   │
  Salesman ── UPDATE ────▶│  Enrichment / correction              ──approved──▶  (Customer+Branch)  │
  Salesman ── CLOSE ─────▶│  Close / reactivate (photo-evidenced)                                   │──▶ batch Excel ──▶ Temix (ERP)
  Steward  ── IMPORT ────▶│  Bulk master import / de-dup / merge                                    │◀── batch Excel ◀── (assigns ERP code,
                          │                                                     soft-delete ─flag──▶│    owns transactions,
  Supervisor/FM/GM/Acct ─▶│  Multi-tier approval engine + SLA + notifications                       │    credit/AR)
                          └────────────────────────────────────────────────────────────────────────┘
```

**System-of-record split.** The CRM is the authoring/enrichment system of record for **customer master attributes** (identity, contacts, channel, GPS, photos, branches, and — new — the approved credit terms). **Temix remains the system of record for transactions and for the definitive ERP customer code.** The link between them is a **batch Excel contract** (§8.3), not a live API (neither system has one today, and none is in v1 scope).

**Why this shape.** It preserves NEW's strengths (typed master, RBAC, audit, R2 photos, deploy/backup) and adds exactly the two things it lacks — **field-originated creation** and a **finance approval tier** — as native build, while OLD is retired to a read-only archive. It avoids creating a parallel source of truth: the CRM never competes with Temix on transactions; it feeds it.

---

## 2. Role & Permission Matrix (8 roles)

`[Confirmed]` current enum has 5 roles (`prisma/schema.prisma:15-21`). Target adds **ACCOUNTANT, FINANCE_MANAGER, GM** (note: Accountant is also new — the confirmed list is 8, current is 5, so +3).

| Capability | Salesman | Supervisor | Accountant | Finance Mgr | GM | Steward | Manager | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Create** new customer (cash/credit) | ✅ (own route) | — | — | — | — | via import | — | — |
| **Enrich / correct** existing | ✅ (own route) | — | — | — | — | ✅ (direct) | — | — |
| **Close / request reactivation** | ✅ (photo) | — | — | — | — | — | — | — |
| **Approve — update** | — | ✅ (own reports) | — | — | — | — | — | — |
| **Approve — create Cash** step | — | ✅ | ✅ (final) | — | — | — | — | — |
| **Approve — create Credit** step | — | ✅ | ✅ (final) | ✅ | ✅ | — | — | — |
| **Approve reactivation** | — | — | — | — | — | — | ✅ (own region) | — |
| **Import / export (Temix batch)** | — | — | — | — | — | ✅ | — | — |
| **De-dup / merge** | — | — | — | — | — | ✅ | — | — |
| **Users / routes / regions admin** | — | — | — | — | — | — | ✅ | — |
| **View audit / dashboards** | own | team | queue | queue | queue | all | ✅ | ✅ |
| **Read scope** | own route | team routes | assigned regions\* | global\* | global\* | all | managed regions (fail-closed) | all |

\* **Owner-confirmed (2026-07-15):** Finance Manager and GM are **org-wide**; the **Accountant is region-scoped**. Mechanism `[Proposed]`: Accountants receive region assignments via the same M:N mechanism Managers use (`managedRegions`), fail-closed when empty; the Accountant approval step checks region overlap with the customer's branches (`REGION_OVERLAP`). Assignment data (which regions each Accountant covers) is needed — §11 **Q-acct-regions**.

**Field-level locks (carried from NEW, extended):** for a Salesman, `legalName` + `nmwcCode` are always locked on *existing* records (Steward-owned); `crNumber` is locked only on CREDIT customers. **At creation** these locks do not apply — the salesman authors `legalName` and CR (they own the new record until approval). `[Confirmed]` lock logic `lib/permissions.ts:70-80`; `[Proposed]` create-time exception.

**Separation of duties (generalized across steps):** the submitter can never approve any step of their own request; **no single person may act on two steps of the same request** (blocks a dual-role user from, e.g., approving both the Supervisor and Finance Manager steps). `[Proposed]` generalizing EL-15 (`permissions.ts:134`).

---

## 3. The three workflow state machines

All transitions use NEW's existing **atomic-claim + optimistic-lock** patterns (`services/edits.ts:767-780`, `:503-572`), generalized to be step-aware. `SUBMITTED` remains the single "pending" state; a `currentStepIndex` + `pendingRole` locate *where* in the chain it sits, so every existing queue query keeps working.

### 3.1 UPDATE (master correction / enrichment) — 1 approver
```
DRAFT ──submit──▶ SUBMITTED (Supervisor) ──approve──▶ APPROVED → applied to master → queue Temix upload
                       │
                       └─return──▶ NEEDS_CORRECTION ──resubmit──▶ SUBMITTED
```
Steward/Manager get **direct-write** (auto-approved) for UPDATE only — **now region-scoped** (fixes the H-1 hole). Viewer read-only.

### 3.2 CREATE — Cash — 2 approver steps
```
DRAFT ──submit──▶ SUBMITTED[0]=Supervisor ──▶ SUBMITTED[1]=Accountant ──approve(final)──▶
        create Customer + Branch(es) + wire photos → temixSyncState=PENDING_UPLOAD
```

### 3.3 CREATE — Credit — 4 approver steps (captures credit data)
```
DRAFT ──submit(limit,termDays,guarantee docs)──▶ SUBMITTED[0]=Supervisor ──▶ [1]=Finance Manager ──▶ [2]=GM ──▶ [3]=Accountant ──approve(final)──▶
        create Customer(creditLimit,paymentTermDays) + Branch(es) + wire photos+guarantee → PENDING_UPLOAD
```

**Rules shared by all three (`[Proposed]`, from the engine design):**
- **Changes apply only at the final step.** Intermediate approvals advance the pointer + write a per-step decision record; they mutate nothing on the master (preserves all-or-nothing semantics).
- **Reject = step-back cascade (owner-confirmed 2026-07-15).** A rejection at step N sends the request **back to step N-1** with the rejection reason; if step N-1 also rejects, it goes back one more, and so on. A rejection at the **first step (Supervisor)** returns it to the **salesman** (`NEEDS_CORRECTION`), who edits and resubmits — that starts a **new cycle** at step 0, so every approval is a fresh signature over the changed payload. A stepped-back approver may re-approve, which moves the request forward again. `[Proposed loop guard — confirm, §11 Q-pingpong]`: if the same step rejects the same *unchanged* request twice within one cycle, force it down to the salesman instead of cascading again, so an approve/reject ping-pong cannot loop indefinitely.
- **CASH→CREDIT conversion guard:** an *update* that flips a customer's payment terms to CREDIT must **not** ride the 1-step update chain (that would grant credit with only a Supervisor). It is forced onto the CREDIT create-chain (carrying limit/terms/guarantee), for all roles. `[Proposed]`
- **No credit amendment (owner-confirmed 2026-07-15):** Finance Manager and GM approve or reject the **requested** figures exactly as submitted — they cannot change them. A wrong limit is corrected only by rejecting down the chain to the salesman, who edits and resubmits. Consequence for the schema: the `approved*` columns are dropped; at finalize `Customer.creditLimit`/`paymentTermDays` = the requested values (§5 C2).
- **GM is always required for credit (owner-confirmed 2026-07-15)** — no credit-limit threshold skips the GM step.

**Retired OLD concept:** OLD's 17-status request lifecycle (`PENDING_ACCOUNTANT`, `PENDING_ROUTEPRO`, `ACTIVE_IN_ROUTEPRO`, etc.) is **not** carried forward. The clean 5-value `EditState` + a step pointer expresses the same chains without the sprawl.

---

## 4. What changes for each user (plain language)

- **Salesman** gains a **"New customer"** flow (cash or credit) on mobile — capture identity, CR, GPS, shop/signboard photos, and for credit: requested limit + term days + guarantee docs. Everything else (enrich, close, reactivate) is as today.
- **Supervisor** approves updates *and* is now step 1 of every creation.
- **Accountant** (new) is the final approver on every creation — the sign-off that queues the record for Temix upload.
- **Finance Manager & GM** (new) approve only credit onboarding, and see/act on the credit figures + guarantee documents.
- **Steward** unchanged (import/export/de-dup/merge) + owns the **Temix batch upload/refresh**.
- **Manager** unchanged (users/routes/regions + reactivation approval) — but can **no longer silently edit customers outside their regions** (H-1 fix).
- **Viewer** unchanged (read-only).

---

## 5. Data-model delta (reconciled, authoritative)

Full DDL in [`blueprint-inputs/data-model.md`](blueprint-inputs/data-model.md). All additions are **nullable or defaulted → zero-downtime** `prisma migrate deploy`. Four ordered migration files (enum additions isolated first — Postgres cannot use a newly-added enum value in the same transaction).

**C1 — Roles 5→8** — add `ACCOUNTANT, FINANCE_MANAGER, GM` to `Role` via `ALTER TYPE ADD VALUE` (house pattern at `20260510120000_senior_audit_remediation/migration.sql:29-33`).

**C2 — Credit data** — `Customer.creditLimit Decimal(14,3)` + `paymentTermDays Int?`; `CustomerEdit` carries `requestedCreditLimit` + `requestedPaymentTermDays` only (FM/GM approve or reject these figures — **no amendment**, owner-confirmed; the previously proposed `approved*` columns are dropped and finalize copies requested → Customer); `AttachmentKind + GUARANTEE`. Money is `Decimal(14,3)` (OMR baisa), never Float. DB CHECKs: limit ≥ 0, term-days 0–365.

**C3 — Creation-request spine (the reconciled decision).** Extend **`CustomerEdit`** with a `process` discriminator (`UPDATE`/`CREATE`); a CREATE row has `customerId = NULL` (already nullable; the one-open-edit unique index only fires on non-null `customerId`, so CREATEs pass through untouched). The proposed payload lives in **typed child tables** — `EditCustomerDraft` (1:1) + `EditBranchDraft` (1:N) — with **real FKs to Channel/Region/Route and the same GPS/address CHECKs + region-consistency trigger** as the live tables.
  - *Why not raw JSON:* a credit chain lives for days; JSON `regionId`/`routeId` refs rot silently and can't carry DB validation — the highest-stakes writes would get the weakest checks.
  - *Why not a separate `CustomerCreateRequest` table:* it would duplicate every subsystem (SLA, notifications, per-step audit, queue, atomic claim, bulk actions all bind to `CustomerEdit`).
  - Photos captured before the customer exists → finalize creates **unbound** `Attachment` rows (`services/photos.ts:95-96` already supports this); add `Attachment.editId` to track them; wire to real slots inside the finalize transaction; extend `photo-gc` to sweep abandoned unbound attachments.
  - `nmwcCode` allocation finally wires the unused `formatCustomerCode` (`lib/codes.ts:9-18`) via a new `CodeSequence` counter, at **finalize** (no codes burned on rejected drafts). Provisional `NMWC-YYYY-NNNNNN` distinguishes app-minted from Temix `cust_code`; the real ERP code lands later via the Temix refresh into the new `temixCode` column.

**C4 — Multi-step approval data** — on `CustomerEdit`: `approvalChain Json` (frozen at submit — immutable per request even if the matrix later changes), `currentStepIndex Int`, denormalized `pendingRole Role?` (indexed for queues/SLA/notifications), and a resubmission `cycle` counter. New **`EditApproval`** child records each step decision (actor/decision/reason) — **append-only with a decision sequence**: under the owner-confirmed step-back cascade, one step can legitimately decide more than once per cycle (approve → stepped-back → re-approve), so uniqueness is per-decision, not per-(cycle,step); the atomic claim (§6) remains the race guard, and `AuditLog` stays the immutable forensic log. Backfill sets existing rows to `process=UPDATE` + a single-supervisor chain. Also closes a **confirmed gap**: add the missing `CustomerEdit_open_per_branch` partial-unique.

**C5 — SLA + Notifications** — SLA columns on `CustomerEdit` (`stageEnteredAt, slaDueAt, slaBreachedAt, escalationLevel, lastEscalatedAt`); new **`Notification`** model (`userId, kind, title, body [PII-safe], editId, readAt, emailedAt`) — two timestamps rather than a channel enum (row = in-app; `emailedAt` = the email batch-drain queue). `AuditAction + ESCALATE`.

**C6 — Restore safe 1:N branches (code, not schema).** The schema was **always 1:N** — the *pilot flattened the data* to 1:1 and three code paths grew `branches[0]`/`take:1` assumptions. Fix exactly: `services/duplicates.ts:73-77` (drop `take:1`) + `:137-138` (EXACT_TRIPLE per distinct branch region, not just the first — currently *misses* dupes on non-first branches), `services/customer-export.ts:182-195` (one row per branch), `app/(app)/customers/page.tsx` (keep one card subtitle but add scoped `where` + branch-count badge), and **retire `scripts/flatten-customer-branches.ts`**. Completeness already averages N branches — no change. `[Open]` **Q-remerge**: re-merge the ~69 flatten-split customers using the on-disk reversal map?

**C7 — Temix crosswalk + sync queue** — `Customer.temixCode String?` (**nullable, non-unique** per locked H-01 — a unique constraint would block migration on the first ERP-side duplicate; harden to partial-unique after the Steward verifies cleanliness), `TemixSyncState { SYNCED, PENDING_UPLOAD, UPLOADED, DEACTIVATE_PENDING }` (default `SYNCED` = backfill-free), sync timestamps, and a `TemixSyncBatch` snapshot table (modeled on `ExportJob`).

**C8 — Soft-delete** — already fully covered (`deletedAt` on Customer/Branch/Attachment + `AuditAction.SOFT_DELETE`); no hard delete exists. Need only a **user-facing archive action** (service work, no schema) that sets `deletedAt` + `temixSyncState=DEACTIVATE_PENDING`. Deliberately **not** adding `deletedById/deleteReason` columns — `AuditLog` already captures actor + reason.

---

## 6. Approval engine (how it's built)

Design: [`blueprint-inputs/approval-engine.md`](blueprint-inputs/approval-engine.md). Evolves the single-tier engine, not a rewrite.

- **Config-in-code matrix** (`lib/approval-chains.ts`): three chains keyed by process + payment terms, resolved once at submit and **snapshotted** onto the row. Rejected a DB-config table (three owner-locked chains ⇒ near-zero churn; a config UI would just add a new privilege surface) and rejected scattered `if (create && credit)` branching (that's what became OLD's 17-status sprawl).
- **Step advance** = the existing atomic claim generalized: `updateMany(where:{id, state:SUBMITTED, currentStepIndex:idx, cycle})`. Loser of any race → `NOT_PENDING`. Non-final step bumps the pointer; final step flips to `APPROVED` and runs the finalize hook.
- **Per-step authorization** (`canActOnStep`): role gate + SoD (submitter never acts; no user approves two *different* steps of one request — re-deciding your own step after a step-back is allowed) + per-step scope: `SUPERVISOR_OF_SUBMITTER` for the supervisor step; `GLOBAL` for **Finance Manager and GM** (owner-confirmed); **`REGION_OVERLAP` for the Accountant** (owner-confirmed region scoping — Accountants get region assignments via the same `managedRegions` M:N mechanism Managers use, fail-closed when empty).
- **Finalize hook** creates the `Customer`+`Branch[]` from the typed drafts (or applies `fieldChanges` for UPDATE), wires photos, computes completeness, sets `temixSyncState=PENDING_UPLOAD`, writes a `CREATE` audit row. Re-runs exact-duplicate + mandatory + lock checks at finalize (a colliding customer may have appeared during the multi-day chain).
- **Preserved invariants** (relocated, not lost): STATUS_BYPASS guard every step; QA-013 lock re-eval, EL-04 mandatory re-gate, QA-039 dropped-branch filter at the final step; optimistic `version` locking inside the final transaction; bulk approve/reject unchanged (each item advances one step).
- **H-1 fix** built in: Manager direct-write becomes region-scoped fail-closed (`assertCanEditCustomer`), and direct-write is valid for `UPDATE` only — never for CREATE or a credit conversion.

**Onboarding duplicate policy** (**hard-block owner-confirmed 2026-07-15**): at create-submit, **hard-block** an exact `crNumberNorm` match or an EXACT_TRIPLE (legalName+phone+region) match against live customers or other open creates (a true CR collision is the same legal entity); **advise, don't block**, on a phone-only match (many shops share one owner phone — NEW's deliberate rule). No fuzzy matching at create (stays a Steward offline concern). Re-checked at finalize (a colliding customer may appear during the multi-day chain).

---

## 7. Net-new creation flow (the capability NEW lacks)

Design: [`blueprint-inputs/creation-flow.md`](blueprint-inputs/creation-flow.md). Reimplemented natively (OLD code can't be lifted).

- **UI:** `app/(app)/customers/new/page.tsx` + `CreateCustomerForm.tsx` — a close cousin of the existing `EnrichmentForm`, with a **payment-terms selector** that reveals the credit section (requested limit, term days, guarantee-doc slots) for CREDIT; a **multi-branch repeater**; salesman branch region/route locked to their own route; sticky "Submit for approval / Save draft" with the existing double-tap guard. Nav entry + `/today` CTA.
- **Mandatory gate at create** reuses `collectMissingMandatory` *without* the lock-skips (the salesman authors `legalName`/CR here). Credit adds: limit > 0, term-days ≥ 0, ≥1 guarantee document.
- **Photos before the customer exists:** captured as unbound attachments, carried by id on the drafts, bound in the finalize transaction with the same kind/scope validation.
- **Scope-safe & rate-limited** (own route only; reuses the form rate-limit — after the limiter bug is fixed).
- `[Open]` **Q-multibranch-create**: one create request may author N branches, but must they all be on the salesman's own route (recommended), with cross-route branches added later? **Q-guarantee-pdf**: guarantee docs are likely PDFs — the upload pipeline is image-only today and needs a PDF allowance for `kind=GUARANTEE`.

---

## 8. SLA, Notifications & Temix batch-sync

Design: [`blueprint-inputs/sla-notif-sync.md`](blueprint-inputs/sla-notif-sync.md).

### 8.1 SLA + escalation
- Working-hours calendar ported from OLD's `lib/sla.ts` concept but **timezone-explicit (Asia/Muscat, UTC+4, no DST)** — OLD computed in server-local UTC, a latent bug. Per-step budgets (OLD's Supervisor 8h / Accountant 9h are proven; FM/GM need values — `[Open]` **Q-sla**).
- The queue replaces its wall-clock age with working-hours SLA status (breached-first sort, amber < 2h).
- **Escalation sweep = GitHub-Actions cron → in-app `GET` route** (`/api/cron/sla-sweep`), **not Vercel cron**. This is deliberate: it must run hourly during business hours (Vercel Hobby forbids sub-daily), and using a `GET` handler structurally avoids **OLD's dead-cron bug** (its sweep was `POST`-only while Vercel Cron sends `GET`, so escalation never fired). Reuses the existing `CRON_SECRET` timing-safe bearer pattern and the `PROD_CRON_SECRET` GitHub secret. v1 = **notify-only + escalation badge** (auto-reassign risks orphaning region scope).

### 8.2 Notifications (in-app + email)
- In-app `Notification` rows on submit / each step advance / final approve / return / SLA breach, with a bell/inbox surface. Email delivery recommended via **Resend** (HTTP API, serverless-native) or **AWS SES** (reuses the AWS SDK already present for R2) — `[Open]` **Q-email**. Ship in-app first; email behind `NOTIFY_EMAIL_ENABLED`, drained in batch by the sweep to keep approval actions fast.
- **PII-safe:** bodies contain only `legalName` + `nmwcCode` + a deep link + reason; all logging goes through the existing `lib/logger.ts` redactor; free-text reasons are scrubbed before entering an email body.

### 8.3 Temix batch-sync contract (the CRM→ERP link)
- **Outbound (upload):** a Steward action builds a Temix upload workbook (reusing `services/exports.ts` + `exceljs`) from the queue `temixSyncState IN (PENDING_UPLOAD, DEACTIVATE_PENDING)`, with `temix_code` (blank = create in Temix), `sync_action` (UPSERT/DEACTIVATE), `payment_terms`, `credit_limit`, `payment_term_days`, and a batch id. Rows flip to `UPLOADED` at export; the Steward confirms "loaded into Temix"; the inbound refresh flips them to `SYNCED`.
- **Idempotency:** a `TemixSyncBatch` snapshot + the customer `version` watermark give at-least-once-with-dedup (Temix UPSERTs on the code, so re-sending an unchanged row is a no-op).
- **Inbound (refresh):** the Steward imports a Temix export to refresh the master, **back-fill `temixCode`** for CRM-created customers, and — per the locked decision — **set `paymentTerms`/limits from Temix** authoritatively.
- **Triggers:** final approval of a create, an approved Temix-relevant master edit, and a soft-delete all enqueue the customer. `[Open]` **Q-temix-fields** (which field changes are Temix-relevant), **Q-temix-headers** (exact sheet schema from the ERP team), **Q-guarantee-transfer** (documents can't ride an Excel row). A **live Temix API** is explicitly out of v1 scope; the batch contract is forward-compatible.

---

## 9. OLD → NEW Migration / ETL Runbook

Full runbook with commands: [`blueprint-inputs/migration-etl.md`](blueprint-inputs/migration-etl.md). It is a **transform, not a copy**; every OLD row is dry-run-validated against NEW's invariants and quarantined on failure (mirroring NEW's own import lane), on a **Neon branch first**.

**Gate G0 — VERIFY (nothing extracted before this passes):**
1. **OLD's real production database** — schema says Postgres, every env file says SQLite. Pull the live `DATABASE_URL`; extract from the true source, not the possibly-stale `dev.db`. Do **not** try `prisma migrate deploy` on OLD (its migration history is non-replayable).
2. **`nmwcCode` = `temixCode` — RESOLVED (owner-confirmed 2026-07-15).** Reconciliation is a **join**; the `temixCode` backfill for imported rows is simply `SET temixCode = nmwcCode`. Still run the sample join at load time as a sanity check (expect ~100% match; investigate any miss rather than force it). NMWC will provide the **current Temix master export**, which is also the authoritative source for payment terms (step 3) and the credit-limit/term-day values of existing credit customers.

**Steps 1–7 (each with a go/no-go gate):**
1. **Identifier crosswalk** `temixCode ↔ nmwcCode` (match on code → normalized CR → name+phone); add the `Customer.temixCode` column; unmatched OLD rows = net-new customers to load.
2. **Structural transform** — OLD's *real enrichment lives on `CustomerRequest` (status ACTIVE), not `CustomerMaster`* — the migration must reproduce that JOIN or it loses every field the portal collected. Decompose flat → Customer + Branch(1:N); remap free-string channel → NEW's locked taxonomy **fail-loud** (unmapped → quarantine, never silent NULL); resolve routes, take each branch's region **from its route** (the region-consistency trigger demands it).
3. **Payment terms from Temix** (locked) — join the Temix export; strict CASH/CREDIT whitelist; missing → quarantine for a Steward pass (never default).
4. **Validate/quarantine** every row against NEW's DB CHECKs (Oman GPS envelope, address minlength, region trigger) + Zod. Expect quarantine from OLD's un-geofenced GPS and blank addresses; flag all migrated GPS **legacy/unverified** (OLD capture was client-spoofable).
5. **Photo re-host** Blob/disk → R2 with NEW's key convention + sha256 dedup; invalidate OLD public URLs.
6. **Users** re-provisioned (login changes email→username; role/depot→region crosswalk; `mustChangePassword=true`; do not copy hashes). **History:** freeze OLD read-only as an archive; migrate only current master state; do **not** inject re-coded OLD history into NEW's immutable audit log.
7. **Rollback:** labeled Neon snapshot + R2 backup pre-load; load on a branch, validate, then cut `DATABASE_URL` over (instant revert); keep OLD live-read-only for ≥1 reconciliation cycle; never hard-delete OLD until NEW is soak-validated.

**Hard prerequisites for the migration:** the region-less-import bug (SR-H2) must be fixed first (it's the exact path region-blank legacy rows take), and the `branches[0]` de-flattening (C6) must land before loading true multi-branch OLD customers.

---

## 10. Security remediation sequence

Full ticket list with fixes/tests: [`blueprint-inputs/security-remediation.md`](blueprint-inputs/security-remediation.md). No secret values are reproduced anywhere.

**Phase 0 — immediate (before any consolidation code):**
- **SR-C2** rotate NEW pilot credentials (unique per-user + `mustChangePassword=true` + session-revoke); replace the hardcoded-password reset script.
- **SR-C1** rotate OLD `NEXTAUTH_SECRET`/`CRON_SECRET`/DB/SMTP.
- **SR-C3** fix the rate limiter (one-expression change: derive `granted` from token availability, floor at −1) + a **Postgres-path integration test** in CI.
- **SR-H1** Manager write scope + edit-page gate (the H-1 fix, folded into the engine design).

**Phase 1 — before the migration import & before onboarding OLD's users:**
- History scrubs (`git filter-repo`) + **gitleaks CI gate** + `.gitignore` fixes.
- **SR-H2** import UNASSIGNED-region fix (**hard gate for migration**).
- **SR-M1** CASH `crNumber` dropped-at-approve fix (**gate for the CASH create flow** — it reuses this path).
- **SR-M2** `/customers` list fail-closed for empty-region Manager; **SR-M3** dependency pinning + `npm audit` CI; decide OLD's fate → **SR-H3** (patch session-staleness or freeze).

**Phase 2 — with the consolidation build:** `EXPORT` audit action + `DuplicateDismissal` model (stop abusing the audit log as mutable state); reactivation version-lock; progressive login lockout; completeness scoring fixes (+ fleet rescore).
**Phase 3 — post-cutover hardening:** CSP `style-src` tightening + CSP parity test; retire OLD → closes its residual findings.

**Go/no-go for onboarding OLD's population:** Phases 0–1 done; PG rate-limit test green; gitleaks green; staging proof that out-of-region Manager write → Forbidden, empty-region Manager list → empty, region-blank import row → UNASSIGNED.

---

## 11. Decision register & remaining open questions

### A. RESOLVED by the owner (2026-07-15) — all former Phase-1 design blockers
| Question | Decision |
|---|---|
| Approver scope | **Finance Manager + GM org-wide; Accountant region-scoped** (assignments via the Manager-style region mechanism) |
| Rejection semantics | **Step-back cascade** — reject at step N → step N-1 → … → first-step reject returns to the salesman |
| Credit amendment | **Not allowed** — FM/GM approve/reject the requested figures only; correction happens via reject-to-salesman |
| GM threshold | **GM always required** for credit |
| Create-time exact-CR duplicate | **Hard-block** |
| `nmwcCode` vs `temixCode` | **Identical** — migration crosswalk is a join |
| Temix master export | **Will be provided by NMWC** (also the payment-terms + credit-figures source for existing customers) |

**Two small follow-ups raised by these decisions (confirm before engine build, not blocking schema work):**
| # | Question | Recommendation |
|---|---|---|
| **Q-pingpong** | Step-back loop guard: if the same step rejects the same *unchanged* request twice in one cycle, force it down to the salesman instead of cascading again? | Yes — prevents an approve/reject ping-pong from looping indefinitely |
| **Q-acct-regions** | Which regions does each Accountant cover, and who administers those assignments? | Manager administers, like `managedRegions`; need the actual region list per accountant at user provisioning |

### B. Blocking the migration (need before/at the ETL)
| # | Question | Why |
|---|---|---|
| **Q-old-db** | OLD's **real production database** (and is `dev.db` real or seed)? | Determines what data even exists to migrate |
| **Q-temix-headers** | Exact **Temix upload/refresh sheet schema** — likely answered by the promised master export | ETL mapping + the sync contract |
| **Q-channel-map** | Sign-off mapping every OLD channel/sub-channel string → NEW taxonomy | Unmapped values quarantine |
| **Q-depot-region** | OLD **Depot → NEW Region** crosswalk | Branch region assignment + user scope |

### C. Needed before their specific build phase (not blocking now)
Q-sla (per-role SLA hours + confirm Oman calendar) · Q-email (Resend vs SES + sender domain) · Q-multibranch-create (N branches on own route?) · Q-guarantee-pdf (PDF upload allowance) · Q-guarantee-transfer (how guarantee docs reach Temix) · Q-remerge (re-merge the ~69 flatten-split customers?) · Q-temix-fields (which edits are Temix-relevant) · Q-old-lifetime (how long OLD stays live → session-staleness patch vs freeze) · Q-password-distribution (how per-user passwords reach field staff) · Q-completeness-rebase (rebase dashboard bands after the +5 fix) · Q-create-submitters (Salesman only, or Supervisor/Steward on behalf?).

---

## 12. Phased build roadmap (proposed sequence)

Each phase is a reviewable increment; **none starts without your go-ahead.**

1. **Phase 0 — Security & correctness (no new features).** SR-C1/C2/C3, SR-H1, gitleaks CI. *Ships fixes to the live pilot; independent of consolidation.*
2. **Phase 1 — Schema & engine foundation.** The 4 migrations (roles, credit, create-spine, SLA/notifications), the config-in-code matrix, step-aware engine + `canActOnStep`, 1:N de-flatten, `temixCode` column. *Behind the scenes; UPDATE flow behaves exactly as today.*
3. **Phase 2 — Creation flow.** New-customer UI + finalize hook + onboarding dedup; cash then credit (incl. FM/GM steps + guarantee docs). *The headline new capability.*
4. **Phase 3 — SLA + notifications.** Working-hours SLA, sweep cron (GET), in-app inbox, email.
5. **Phase 4 — Temix batch-sync.** Outbound upload workbook + sync-state queue + inbound refresh/back-fill.
6. **Phase 5 — Migration.** Run G0 verification → crosswalk → dry-run on a Neon branch → cutover → soak → retire OLD.
7. **Phase 6 — Adoption hardening.** Arabic/RTL (top adoption risk), offline capture, delegation, dashboards — as prioritized.

---

*End of blueprint. This is a plan only — no code has been written and no system changed. All former Phase-1 design blockers are now resolved (§11.A, owner decisions of 2026-07-15); Phase 0 (security fixes) and Phase 1 (schema + engine foundation) are unblocked pending only the two small §11.A follow-ups. The migration (Phase 5) still needs the §11.B answers and the promised Temix master export. Nothing will be built without explicit go-ahead.*
