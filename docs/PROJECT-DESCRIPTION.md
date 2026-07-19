# NMWC Unified CRM — Consolidation Project Description

> A self-contained briefing for an independent reviewer. It describes the business
> context, the locked requirements, the architecture, everything built so far, the
> verification method, and what remains open. Written so an evaluator with **no
> access to the repository** can still assess scope, design quality, and risk.

---

## 1. Executive summary

National Mineral Water Company (NMWC SAOG), Oman, had **two separate, overlapping
CRM codebases**. This project consolidates them into **one unified enterprise CRM**
that covers the full customer lifecycle (create → enrich → approve → sync to ERP →
correct → archive) for a field-sales operation of bottled water.

Crucially, the CRM **aids the company's existing ERP (called "Temix"), it does not
replace it.** Temix remains the system of record for transactions and the
authoritative customer code. The CRM authors and curates customer master data and
hands it to Temix in **batch Excel uploads** (there is no live Temix API in v1).

The work was executed as a **discovery-first, phased build**, with every code
increment subjected to an **adversarial multi-agent review** before commit and every
schema change validated on an **isolated database branch** (never production, which
carries a live pilot of ~3,300 customers).

Status: the planned build phases (1a–1e) are **functionally complete and committed**.
Remaining work is **owner decisions, a data-migration dry-run, and production
deployment/secret rotation** — not new feature construction.

---

## 2. Business context

- **Company:** NMWC SAOG (Oman) — bottled mineral water, field-sales / route-to-market.
- **ERP:** "Temix" — system of record for transactions and the definitive customer
  code. The CRM feeds it; it is not being replaced.
- **Two legacy systems being merged:**
  1. **OLD — "ICO Customer Portal":** a net-new customer *registration* workflow
     (multi-step approval, GPS + photo capture, duplicate checks, SLA concept).
  2. **NEW — "NMWC Customer Master":** an existing-customer *enrichment/correction*
     workflow (single-step supervisor approval, richer data model, photo pipeline,
     import/export, de-dup/merge).
- **Consolidation goal:** one system that does the full lifecycle — create cash and
  credit customers, enrich the master, correct data, close/archive customers, and
  upload everything to Temix — with a single role model, one approval engine, one
  data model, and one notification/SLA layer.
- The OLD system contributes **requirements, not code** (different framework
  generations). Its concepts (multi-tier approval, GPS-at-submit, photo gates,
  sequence-allocated codes, duplicate BLOCK/WARN, working-hours SLA) were
  **re-implemented**, not lifted.

---

## 3. Owner-confirmed requirements (the locked spec)

These were confirmed by the business owner and treated as non-negotiable; deviations
were considered bugs.

**Roles (8):** `SALESMAN`, `SUPERVISOR`, `ACCOUNTANT`, `FINANCE_MANAGER`, `GM`,
`MANAGER`, `STEWARD`, `VIEWER`.

**Two processes:**
- **CREATE** (net-new customer) — requires the finance tier.
  - **Cash chain:** Salesman → Supervisor → Accountant.
  - **Credit chain:** Salesman → Supervisor → Finance Manager → GM → Accountant.
  - **GM is always required for credit** — no credit-limit threshold skips GM.
- **UPDATE** (enrichment/correction) — Supervisor approves; Viewer is read-only.

**Scope model:**
- Finance Manager & GM are **org-wide** approvers.
- Accountant is **region-scoped** (fail-closed when it manages no regions).
- Manager is **region-scoped** (fail-closed), and is a fallback approver for the
  Supervisor step.
- Supervisor approves their **own team's** submissions.
- Salesman is limited to their **own route**.

**Approval behavior:**
- **Step-back reject cascade:** a rejection returns the request to the previous
  approver; a rejection at the first step returns it to the salesman
  (NEEDS_CORRECTION); a **loop guard** prevents infinite ping-pong (a step that
  rejects the same request twice in one cycle sends it to the salesman).
- **No amendment of credit figures by FM/GM** — they approve or reject the salesman's
  *requested* credit limit / term exactly; corrections happen only by rejecting down
  to the salesman.
- **Separation of duty:** the submitter can never approve; no user may act on two
  different steps of the same request.

**Data / identity:**
- **Multi-branch customers (1:N)** from day one — never assume a single branch.
- **Customer identity = `custcode`** (stored as `nmwcCode`, globally unique).
- **Branch identity = `custcode`-`branchcode`** (stored as `branchCode`, globally
  unique; e.g. `NMWC-2026-000123-01`). The "main" record is the custcode; branches
  are the composite.
- **`nmwcCode == temixCode`** for migrated rows — the ERP crosswalk is a *join*, not
  a matching project. `temixCode` is nullable and **non-unique** until the Steward
  verifies crosswalk cleanliness.
- Capture **credit limit + payment terms + guarantee/security documents** for credit
  customers.
- **Soft-delete / archive** (never hard-delete a customer).
- **Hard-block exact-CR duplicates** at create.

**Non-functional:**
- **SLA timers + escalation + in-app notifications** in scope.
- **Working hours:** Asia/Muscat (UTC+4, no DST), working days Sun–Thu **plus Sat**
  (Friday off), 08:00–17:00. SLA math must count working time only.
- The current Temix master export **will be provided by the owner** for migration.

---

## 4. Architecture & technology

- **Framework:** Next.js 15 (App Router, React Server Components + Server Actions),
  React 19, TypeScript 5.6.
- **Data:** Prisma 6.19 ORM against **PostgreSQL on Neon** (serverless, copy-on-write
  branching). Hand-written idempotent SQL migrations alongside the Prisma schema.
- **Auth:** Auth.js v5 (next-auth beta), JWT session strategy, bcryptjs password
  hashing, session-revocation freshness check.
- **Files/photos:** Cloudflare R2 (S3-compatible), presigned uploads, server-streamed
  reads through an access-controlled route.
- **Spreadsheets:** exceljs for import parsing and export generation.
- **Testing:** Vitest (unit), Playwright (e2e scaffold).
- **Ops:** Vercel hosting; GitHub Actions for sub-daily cron (Vercel Hobby has no
  sub-daily cron); Sentry for errors; a token-bucket rate limiter persisted in
  Postgres.

**Design conventions:**
- Server Actions return a `SafeAction` discriminated union `{ ok, data | code,
  message, fields }` — never throw across the RSC boundary.
- All authorization is centralized in pure functions (`lib/permissions.ts`,
  `lib/access.ts`) that take a pre-fetched user + entity; every mutation calls one
  first.
- Region/route scoping is **fail-closed**: an unscoped Manager/Accountant sees
  nothing, never everything.

---

## 5. Data model (key entities)

- **Customer** — `nmwcCode` (unique), `legalName`, `paymentTerms` (CASH|CREDIT),
  `crNumber`/`crNumberNorm`, channel/sub-channel, phones (normalized), contact,
  status, completeness score, `version` (optimistic lock), soft-delete `deletedAt`,
  credit fields (`creditLimit` Decimal(14,3), `paymentTermDays`), and the Temix
  crosswalk block (`temixCode`, `temixSyncState`, `temixSyncPendingSince`,
  `lastTemixUploadAt`, `lastTemixUploadBatchId`).
- **Branch** — `branchCode` (unique, = `custcode-NN`), `regionId`/`routeId` (a DB
  trigger enforces `branch.regionId == route.regionId`), address, GPS (bounded to
  Oman's envelope by DB CHECKs), day-of-visit, equipment counts, photo slots, status.
- **CustomerEdit** — the unit of work for BOTH processes. `process` (CREATE|UPDATE),
  `customerId` (**null for CREATE** until finalize), `state`
  (DRAFT|SUBMITTED|APPROVED|REJECTED|NEEDS_CORRECTION), the **frozen approval chain**
  (`approvalChain` JSON snapshot, `currentStepIndex`, `pendingRole`, `cycle`),
  requested credit figures, and SLA fields (`stageEnteredAt`, `slaDueAt`,
  `escalationLevel`, `slaBreachedAt`, `lastEscalatedAt`).
- **EditCustomerDraft (1:1) + EditBranchDraft (1:N)** — typed payload tables for a
  net-new CREATE request (real FKs + replicated DB CHECKs), so a proposed customer
  gets the same validation as a live one before it exists.
- **EditApproval** — append-only per-step decision log (a step can legitimately be
  decided more than once per cycle under the step-back cascade).
- **Notification** — in-app notifications (7 kinds); PII-safe bodies (code + legal
  name + deep link only, never phone/CR).
- **TemixSyncBatch** — snapshot of one outbound upload batch (customer id list,
  row count, status, `markedLoadedAt`).
- **CodeSequence** — atomic per-scope counter for app-minted provisional codes
  (`NMWC-YYYY-NNNNNN`), allocated at finalize.
- **Attachment** — R2-backed photos; carries `editId` for photos captured during a
  CREATE before the customer exists; kinds include `CR`, `SHOP`, `SIGNBOARD`, `FREE`,
  and `GUARANTEE` (credit security docs).
- Plus the pre-existing org hierarchy (Region, Route, User with self-referential
  supervisor + M:N managed regions), Channel/SubChannel taxonomy, ImportBatch/
  ImportRow, AuditLog (immutable), and the rate-limit/export/saved-view tables.

---

## 6. The approval engine (heart of the system)

- **Config-in-code chain matrix**, resolved once at submit and **frozen** onto the
  edit as a JSON snapshot. In-flight requests are therefore deterministic even if the
  matrix later changes; step advancement always reads the row's snapshot.
- **Atomic-claim concurrency:** each transition is an `updateMany` guarded on
  `{id, state, currentStepIndex, cycle}` — two racing approvers, only one wins;
  the loser gets a clean conflict, never a double-apply.
- **Optimistic locking** (`version`) on Customer/Branch protects against a direct
  write racing an approval.
- **Nothing touches the live master until the FINAL step.** Intermediate approvals
  only advance the pointer and write an audit + notification. The final Accountant
  step materializes everything all-or-nothing (for CREATE: allocate code, create
  Customer + Branch[], bind photos, set completeness, queue for Temix).
- **Step-back reject cascade** with loop guard, exactly as specified.
- **Separation of duty** generalized to the multi-step chain.

---

## 7. What was built — phase by phase (all committed)

Branch: `claude/nmwc-crm-consolidation-e10c1e`.

- **Discovery (docs):** an evidence-based reverse-engineering report of both systems
  (with file:line citations and confidence tags) and a **Target Operating Model &
  Consolidation Blueprint** capturing the owner decisions above.

- **Phase 0 — security hardening** (landed on a hotfix branch for the live pilot):
  fixed an always-granting Postgres rate limiter; added Manager region-scoping to the
  photo-attach path; rewrote a credential-reset script to per-user random passwords,
  dry-run by default. Also fixed an empty-region Manager bulk-export data leak.

- **Phase 1a — unified data model:** the 8 roles, credit fields, the draft tables,
  EditApproval, Notification, TemixSyncBatch, CodeSequence, the multi-step CustomerEdit
  fields, SLA fields, and `temixCode` — as hand-written idempotent migrations
  (enum-add-value isolated per Postgres rules, partial unique indexes, CHECK
  constraints, region-consistency triggers cloned onto the draft table).

- **Phase 1b — step-aware approval engine:** the chain matrix + per-step
  authorization (`canActOnStep`), then the generalized submit/advance/reject engine.
  The live single-step UPDATE flow is provably behavior-identical. A regression caught
  in review (the region-Manager fallback approver being dropped) was fixed by
  delegating to the single source of truth.

- **Phase 1c — net-new CREATE flow, end to end:** a salesman "New customer" form
  (cash/credit toggle that switches the chain and reveals the credit-application
  block; multi-branch; unbound photo capture; live mandatory-field gate); typed draft
  persistence; exact-CR **and** name+phone+region duplicate **hard-block under
  advisory locks**; finalize that allocates the `NMWC-YYYY-NNNNNN` code, materializes
  Customer + Branch[], and binds photos with TOCTOU-proof guarded writes; step-aware
  approval queues for all five approver roles; and in-app notifications on every
  transition.

- **Phase 1d — Temix ERP batch sync:** the outbound queue (Steward-only `/temix`
  page), batch generation (a **flip-first-then-snapshot** design so no concurrent
  edit can be lost), an Excel workbook built from the export contract plus sync
  columns, mark-loaded settling; the **archive** action (soft-delete → queue ERP
  deactivation); merge-loser deactivation; and the **inbound refresh** riding the
  existing customer-master import with a `temix_code` column that back-fills ERP
  codes, applies Temix-authoritative fields (payment terms, credit figures) without
  clobbering CRM-owned data, and rejects crosswalk conflicts for Steward review.

- **Phase 1e — SLA engine + in-app notifications:** a working-hours calendar (fixes
  the OLD system's confirmed timezone bug via a fixed UTC+4 shift; minute-precision
  closed-form deadline math); an escalation cron (a **GET** route + GitHub Actions
  schedule — the OLD system's cron was POST-only and never fired); a notification
  bell with unread badge and a `/notifications` inbox; and working-hours SLA pills +
  most-overdue-first ordering on the approval queues.

---

## 8. Verification methodology (important for evaluation)

Every non-trivial increment went through the same gate before commit:

1. **Typecheck + unit tests + lint** must be clean (the suite grew to ~120+ unit
   tests, including hand-computed working-hours calendar fixtures and the approval
   decision logic).
2. **Adversarial multi-agent review:** 4–5 independent "hostile reviewer" agents,
   each assigned one dimension (authorization/scope, concurrency/state-machine,
   finalize/DB-integrity, regression vs the prior code, validation/UI, calendar math),
   instructed to *find defects* and ground each in `file:line` evidence with a
   concrete failing scenario.
3. **Independent refutation:** each HIGH/CRITICAL finding was handed to **two more
   agents told to REFUTE it**; only findings that survived a majority refutation
   attempt were treated as real.
4. **Fix-before-commit:** every confirmed finding was fixed in the same increment.

This process **caught real, shippable bugs** at every stage — e.g. a duplicate
hard-block that was race-able when two requests carried different CR numbers; a Temix
refresh that would silently flip credit customers to cash when a column was absent; an
SLA escalation claim that could falsely mark a freshly-advanced stage as breached.
All were fixed before the corresponding commit.

**Database safety:** the "dev" database turned out to be the **live production pilot**
(~3,300 customers). All schema changes were therefore applied and validated on an
**isolated Neon branch** (copy-on-write clone); production was never written to. Raw
SQL like the atomic code counter and advisory locks was probed directly on the branch.

---

## 9. Security & data-handling posture

- Never wrote to the production database; used an isolated branch throughout.
- Secrets are masked in all output; the owner rotates credentials/secrets **before
  go-live** (not done in-session by design). No git-history scrubbing or force-pushes.
- PII floor: logs and notifications never carry phone/CR values; export/notification
  bodies carry codes + legal names only. Photo access is scope-checked; CR documents
  are served no-store.
- Auth: fail-closed scoping, session revocation freshness, peer-manager protections,
  password-reuse prevention, constant-time cron-bearer comparison.

---

## 10. Current state — done / pending / open

**Done (committed, reviewed, tests green):** the unified data model; the step-aware
approval engine; the full net-new CREATE flow (cash + credit); Temix outbound batch +
inbound refresh + archive/merge deactivation; the SLA engine + escalation cron + the
notification bell/inbox. A production build runs locally against the Neon branch with
seeded demo users for all 8 roles.

**Pending — needs the owner, not more code:**
- **Open decisions:** the exact Temix importer header row / sheet schema
  (`Q-temix-headers`); the FM/GM SLA hour values (16h/24h are placeholders); final
  sign-off on the escalation chain; the email provider + sending domain (in-app
  notifications ship now; email delivery is built behind an env kill-switch, off).
- **Migration ETL dry-run:** unblocked when the owner supplies the current Temix
  master export — back-fill `temixCode = nmwcCode`, reconcile payment terms + credit
  figures, all rehearsed on the branch first.
- **Deploy:** apply the (validated) migrations to production together with the code,
  and rotate secrets/credentials at go-live.
- **Deferred items:** a garbage-collection sweep for orphaned unbound photos (spun off
  as a separate task); a full server-action integration-test suite against the branch;
  email sending (env-gated).

**Known open questions flagged in the docs (deliberately out of v1 scope):** live
Temix API; how credit guarantee documents (likely PDFs) physically reach Temix
(they cannot ride an Excel row); branch-level Temix codes; Temix deactivation
semantics (flag vs delete); the exact field-ownership matrix on refresh; a
partial-unique hardening of `temixCode` after crosswalk verification.

---

## 11. What an evaluator should scrutinize

- **Correctness of the approval engine invariants** under concurrency (atomic claim +
  frozen chain + separation of duty + step-back loop guard).
- **The CREATE finalize transaction** — code allocation atomicity, photo-binding
  TOCTOU safety, region re-derivation, and duplicate re-check.
- **Temix sync integrity** — that no approved change or deactivation can be lost
  across the queue → batch → refresh cycle, and that the refresh never clobbers
  CRM-owned fields.
- **SLA calendar math** — working-hours correctness across day/Friday/window
  boundaries, and that env changes don't retime already-frozen in-flight edits.
- **Scoping/authorization** — fail-closed behavior for unscoped Manager/Accountant,
  and that every queue row a role sees is actually actionable by that role.
- **The open questions** above — whether any of them should have been resolved in v1.

---

## 12. Repository / commit map

Branch `claude/nmwc-crm-consolidation-e10c1e`, newest first:

```
06867e4  Phase 1e — SLA engine + in-app notifications
896eda6  Phase 1d — Temix ERP batch sync (queue → batch → refresh)
b87f44f  Phase 1c — net-new customer CREATE flow (submit → chain → finalize)
2ed47c5  Phase 1b (part 2) — step-aware approval engine
54c5d34  Fix empty-region Manager bulk-export leak
ae5157a  Phase 1b (part 1) — 8 roles + chain matrix + step auth
c81dbf9  Phase 1a — unified-CRM data model (schema + migrations)
35b41cc  docs — discovery report, blueprint, grounded design inputs
```

Key source locations: approval engine `services/edits.ts` + `lib/approval-chains.ts`
+ `lib/permissions.ts`; CREATE flow `services/creates.ts` + `lib/create-finalize.ts`
+ `app/(app)/customers/new/`; Temix `services/temix.ts` + `lib/temix.ts` +
`app/(app)/temix/`; SLA `lib/working-hours.ts` + `app/api/cron/sla-escalate/`;
notifications `lib/notifications.ts` + `app/(app)/notifications/`. Design docs under
`docs/discovery/`.

---

## 13. How to run it

Prereqs: Node, a Postgres connection (Neon), R2 credentials, an auth secret.
`npm install`, apply migrations (`prisma migrate deploy`), then `npm run dev` (or
`npm run build && npm run start` for production; off-Vercel set `AUTH_TRUST_HOST=true`).
Tests: `npm test`. Demo data can be seeded per role for a click-through.

*Note on performance during any local demo:* if the app server and the database are in
different regions, each page's several sequential queries incur full network round
trips and pages feel slow. In production (app and DB colocated) this is ~50× faster;
it is a demo-topology artifact, not an app characteristic.
