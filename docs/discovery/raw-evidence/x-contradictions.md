# Section H — Contradiction & Decision Register (OLD ICO Customer Portal vs NEW NMWC Customer Master)

**Assessment mode:** Read-only cross-cutting discovery. No project file modified.
**OLD system root:** `C:\Users\abdulr\Desktop\ICO\customer-portal` (Next.js 14, NextAuth 4, Prisma 5, schema=postgres/env=SQLite).
**NEW system root:** `C:\Users\abdulr\Desktop\NMWC-CRM` (Next.js 15, Auth.js v5 beta, Prisma 6, Neon Postgres, R2).
**Evidence base:** the 12 per-system discovery findings (`old-*.md`, `new-*.md`) plus direct source spot-checks (schema identifiers/roles confirmed 2026-07-15).
**Confidence tags:** [Confirmed] read in code · [Highly likely] · [Possible] · [Unknown].

> These are two DIFFERENT applications with DIFFERENT data models, DIFFERENT purposes, and DIFFERENT identity keys — not two versions of one app. The OLD system is a **new-customer registration / approval-workflow tracker** that never writes the customer master (Temix/RoutePro are external, manual). The NEW system is an **edit-only master-data enrichment tool** over a pre-loaded ~3,300-record master, with no new-customer creation. Consolidation therefore requires explicit business decisions, not a mechanical merge. Every material conflict below is flagged with a decision owner; **none is silently resolved.**

---

## Contradiction summary matrix

| ID | Area | Severity | Urgency | Blocks implementation until decided? |
|---|---|---|---|---|
| H-01 | Customer identity key (temixCode vs nmwcCode) | Critical | Immediate | **YES** |
| H-02 | System purpose / system-of-record (workflow tracker vs master-data store) | Critical | Immediate | **YES** |
| H-03 | New-customer creation journey (present vs absent) | Critical | Immediate | **YES** |
| H-04 | Data model / entities (13 tables, request-centric vs 16+ models, customer/branch-centric) | Critical | Immediate | **YES** |
| H-05 | Role set & permission model (SALESMAN/SUPERVISOR/ACCOUNTANT/ADMIN/ROUTEPRO vs SALESMAN/SUPERVISOR/MANAGER/STEWARD/VIEWER) | Critical | Immediate | **YES** |
| H-06 | Approval sequence & tiers (2-tier + RoutePro activation vs 1-tier + reactivation) | High | Immediate | **YES** |
| H-07 | Cash/Credit handling (NO_CR type vs PaymentTerms enum + CR field-lock) | High | Near-term | **YES** |
| H-08 | Duplicate-detection logic (fuzzy Levenshtein vs two exact rules) | High | Near-term | Partial |
| H-09 | Customer↔Branch cardinality (parentTemixCode string link vs Branch model, flattened 1:1) | High | Near-term | **YES** |
| H-10 | Customer status model (17 request statuses vs ACTIVE/CLOSED/SUSPENDED) | High | Near-term | Partial |
| H-11 | Auth generation (NextAuth 4 / 8h static JWT vs Auth.js v5 / 5-min freshness + revocation) | High | Near-term | No (NEW is superset) |
| H-12 | Storage backend (Vercel Blob / local disk vs Cloudflare R2 presigned) | Medium | Near-term | No |
| H-13 | Deployment / DB config integrity (postgres-schema/SQLite-env drift vs clean Neon) | Critical (OLD-only) | Immediate | N/A (OLD not deployable as-is) |
| H-14 | Secret hygiene (committed `.env` secrets vs committed plaintext pilot passwords) | Critical (both) | Immediate | No (remediate regardless) |
| H-15 | Branding / identity (ICO vs NMWC, domain, package name) | Medium | Near-term | No |
| H-16 | Enum enforcement (String columns vs DB enums) | Medium | Near-term | No |
| H-17 | Notifications & SLA (in-app + email + SLA cron vs none) | Medium | Near-term | **YES** |
| H-18 | GPS geofence & capture integrity (global bounds, spoofable vs Oman envelope + server-derived capture) | Medium | Near-term | No |
| H-19 | Migration workflow (db push, non-replayable vs replayable migrations) | Medium | Near-term | No |
| H-20 | Rate-limiter correctness (OLD fails-open on SQLite / NEW always-grants in prod) | High | Immediate | No (both must be fixed) |

---

## H-01 — Customer identity key: `temixCode` vs `nmwcCode`

- **(2) Area/module:** Customer master data model / primary identifier.
- **(3) OLD behavior:** Canonical customer key is **`CustomerMaster.temixCode` `String @unique`** (`prisma/schema.prisma:87`, spot-confirmed). `CustomerRequest` carries denormalized string refs `temixCode?` (`:185`), `parentTemixCode`, `existingTemixCode` (`:177-178`) with **no FK** to CustomerMaster. Temix code is assigned by the accountant manually from the external Temix ERP (`confirm-temix` route). `routeCode` is a denormalized string, not FK to `Route.code` (`:91`). [Confirmed — old-data.md §2]
- **(4) NEW behavior:** Canonical customer key is **`Customer.nmwcCode` `String @unique`** (`prisma/schema.prisma:246`, spot-confirmed), format `NMWC-YYYY-NNNNNN` (`lib/codes.ts:9-18`) — though import actually uses the raw `cust_code` from the sheet as `nmwcCode`, so the generator is effectively unused (`imports.ts:820-833`). Branch key is `Branch.branchCode` (`<PARENT>-NN`). [Confirmed — new-data.md §2, new-rules.md §G]
- **(5) Evidence:** OLD `schema.prisma:87,177-178,185`; NEW `schema.prisma:246`, `lib/codes.ts:9-18`, `services/imports.ts:820-833`.
- **(6) Business impact:** The two systems key customers on **different, non-overlapping identifiers**. There is no stored mapping between a Temix code and an NMWC code. Merging or cross-referencing customers across systems is impossible without a reconciliation table.
- **(7) Technical impact:** No FK/relational bridge exists. Any consolidation needs an explicit `temixCode ↔ nmwcCode` crosswalk plus a rule for records present in one system but not the other.
- **(8) Data-migration impact:** HIGH. Migrating OLD → NEW requires mapping each `temixCode`/`parentTemixCode`/`existingTemixCode` to an `nmwcCode`. OLD refs are plain strings with no integrity guarantee, so orphan/dangling codes are likely and must be cleaned first.
- **(9) Security/compliance impact:** Low directly; but mis-mapping identity can attach one customer's PII/CR to another. CR number is the only cross-system regulatory anchor and is optional in both.
- **(10) Recommended direction:** Adopt **`nmwcCode` as the canonical go-forward key** (NEW is the master-data system of record). Preserve `temixCode` as a non-unique legacy/ERP cross-reference attribute on `Customer` during migration.
- **(11) Alternatives:** (a) Keep both as first-class dual keys with a mapping table; (b) key on CR number where present (rejected — CR is nullable and not unique in either system).
- **(12) Decision required:** Business owner must confirm `nmwcCode` is the enterprise customer key and that `temixCode` becomes a retained ERP cross-reference, and must own producing the temix↔nmwc crosswalk from Temix.
- **(13) Urgency:** Immediate — everything downstream depends on it.
- **(14) Wait for clarification?** **YES.** No migration or consolidation can start before the identity decision.

---

## H-02 — System of record / purpose: workflow tracker vs master-data store

- **(2) Area:** Core architecture / system responsibility.
- **(3) OLD behavior:** **The portal never writes the customer record.** `CustomerMaster` is mutated ONLY by admin master-file upload (`app/api/master/upload/route.ts:111,118`) and seed; no approval/confirm-temix/activate step creates or updates a `CustomerMaster` row (grep-confirmed). Temix and RoutePro are external systems; the portal only *records* that a human performed those steps (stores `temixCode`, `routeproActivatedAt`). It is a **registration + approval tracker**, not the master data system. [Confirmed — old-functional.md §4 CRITICAL FINDING, old-rules.md §L]
- **(4) NEW behavior:** The app **is** the master-data store. Approved edits write directly to the live `Customer`/`Branch` rows via `applyEditChanges` with optimistic locking (`services/edits.ts:503-572`). Data flows ERP→Excel→app→Excel→ERP; the app owns enrichment of the master between import/export cycles. No live ERP integration either, but the app mutates the master rows itself. [Confirmed — new-functional.md J1/J3, new-docs.md §1]
- **(5) Evidence:** OLD `app/api/master/upload/route.ts:111,118`, `app/api/customers/[temixCode]/route.ts:60-90`; NEW `services/edits.ts:503-572`, `services/imports.ts:700-833`.
- **(6) Business impact:** Fundamentally different operating models. OLD tracks *creation* of customers in an external ERP; NEW *is* the editable customer database. A consolidated system must pick which role it plays (or both).
- **(7) Technical impact:** OLD has no write-back machinery; NEW has no create-in-ERP workflow. Combining them means building the missing half in whichever base is chosen.
- **(8) Data-migration impact:** OLD "customer" state is spread across `CustomerMaster` (upload snapshot) + the latest ACTIVE_IN_ROUTEPRO `CustomerRequest` (GPS/photos/contact live on the request, read by JOIN). NEW expects a single flat `Customer`+`Branch`. Migrating OLD requires *collapsing* request data back onto the master record.
- **(9) Security/compliance impact:** Provenance differs — OLD reconstructs "who changed what" from `StatusHistory`+`salesmanId`; NEW has per-mutation `AuditLog`. Compliance/audit expectations must be re-based.
- **(10) Recommended direction:** Standardize on the **NEW system as the customer master-data system of record**, and treat "new-customer registration into Temix" (H-03) as a bolt-on workflow if still required.
- **(11) Alternatives:** (a) Keep OLD as a front-door registration funnel that feeds NEW after Temix creation; (b) rebuild registration inside NEW.
- **(12) Decision required:** Owner must declare which system is the go-forward system of record and whether external Temix/RoutePro creation must remain a tracked workflow.
- **(13) Urgency:** Immediate.
- **(14) Wait?** **YES.** Determines the entire consolidation direction.

---

## H-03 — New-customer creation journey: present vs absent

- **(2) Area:** Customer onboarding.
- **(3) OLD behavior:** Full 4-stage new-customer workflow (`NEW_MAIN`, `NEW_BRANCH`, `NO_CR`): Salesman drafts → duplicate check → Supervisor → Accountant (Temix) → RoutePro activation (`app/api/requests/*`). Field teams can originate net-new customers. [Confirmed — old-functional.md §4]
- **(4) NEW behavior:** **No manual create-customer UI or action exists.** `prisma.customer.create` appears only in seed/migration scripts. Real creation is Steward Excel import→promote only (`services/imports.ts:517,700`). Salesmen enrich pre-seeded skeletons; they cannot onboard a new customer without a Steward import round-trip. [Confirmed — new-functional.md J2, new-techdebt.md]
- **(5) Evidence:** OLD `lib/validators/request.ts:13-95`, request routes; NEW `services/imports.ts:517,700-833`, absence of `customer.create` in app code.
- **(6) Business impact:** Direct capability conflict. If the field force must create customers, NEW cannot do it today; if creation is centralized via ERP import, OLD's whole workflow is redundant.
- **(7) Technical impact:** Adopting NEW loses field-origination; adopting OLD loses direct master enrichment.
- **(8) Data-migration impact:** Low for existing rows; high for process continuity.
- **(9) Security/compliance impact:** OLD's duplicate-gating on creation prevents duplicate customers at source; NEW relies on Steward import controls + advisory dedupe.
- **(10) Recommended direction:** Decide by operating model. If Oman field reps must onboard new outlets, build a governed create-customer flow in NEW (reusing its approval engine). Otherwise keep creation centralized (import) and retire OLD's registration path.
- **(11) Alternatives:** Hybrid — field "provisional customer" request in NEW that a Steward promotes.
- **(12) Decision required:** Owner must state whether field-originated new-customer creation is a required capability going forward.
- **(13) Urgency:** Immediate.
- **(14) Wait?** **YES.** Scope-defining.

---

## H-04 — Data model / entities: request-centric (13 tables) vs customer/branch-centric (16 models + 11 enums)

- **(2) Area:** Database schema.
- **(3) OLD behavior:** 13 tables, **0 enums** (all categorical values are bare `String`). Central entity is `CustomerRequest` (largest, `schema.prisma:137-219`) holding contact/GPS/photo/workflow data. `CustomerMaster` is a thin upload target. No `Branch` entity — branches modeled via `parentTemixCode` string. [Confirmed — old-data.md §1]
- **(4) NEW behavior:** 16 models + **11 enums**. Central entities `Customer` (`:244-292`) + first-class `Branch` (`:294-349`) + `CustomerEdit` change-request. Rich support tables: ImportBatch/ImportRow, SavedView, PasswordHistory, ExportJob, AuditLog, RateLimit, Channel/SubChannel. DB-level invariants (CHECK constraints, triggers, trigram/partial indexes) beyond schema. [Confirmed — new-data.md §1-2, §5]
- **(5) Evidence:** OLD `prisma/schema.prisma` (317 lines); NEW `prisma/schema.prisma` (508 lines) + `migrations/*`.
- **(6) Business impact:** The two schemas represent the customer concept incompatibly (request-as-record vs customer+branch). No table-to-table equivalence.
- **(7) Technical impact:** Migration is a transform, not a copy. NEW's DB invariants (GPS range, address minlength, branch/region consistency trigger) will reject OLD data that violated them.
- **(8) Data-migration impact:** HIGH. Must map OLD request+master fields → NEW Customer/Branch/Attachment, synthesize `Channel`/`SubChannel` FK rows from OLD's string channel/subChannel, and satisfy NEW CHECK/trigger constraints.
- **(9) Security/compliance impact:** PII inventories differ slightly (NEW adds `Attachment.capturedLat/Lng` person-location); re-classify on migration.
- **(10) Recommended direction:** Use **NEW schema as target**; write a one-time ETL from OLD with a validation/quarantine lane (mirroring NEW's import QUARANTINED state) for rows that fail NEW invariants.
- **(11) Alternatives:** Extend OLD schema (rejected — weaker typing, no branch model, deployment debt).
- **(12) Decision required:** Confirm NEW schema as canonical; approve an ETL + quarantine approach and who reviews quarantined rows.
- **(13) Urgency:** Immediate (blocks migration design).
- **(14) Wait?** **YES.**

---

## H-05 — Role set & permission model

- **(2) Area:** RBAC / roles.
- **(3) OLD behavior:** 5 roles **SALESMAN, SUPERVISOR, ACCOUNTANT, ADMIN, ROUTEPRO** (`types/index.ts:1`); `User.role` is an unconstrained **`String`** in DB (`schema.prisma:55`, spot-confirmed) — integrity only via Zod allow-list. Permissions in `lib/permissions.ts` are request-workflow-centric (approve/confirm-temix/activate). [Confirmed — old-functional.md §2, old-rules.md §G]
- **(4) NEW behavior:** 5 roles **SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER** (`enum Role`, `schema.prisma:15-21`, spot-confirmed) — a **DB enum**. Permissions in `lib/permissions.ts`+`lib/access.ts` are data-scope-centric (region/route scope, field locks, direct-write for Steward/Manager). [Confirmed — new-functional.md §2, new-rules.md §A]
- **(5) Evidence:** OLD `types/index.ts:1`, `schema.prisma:55`; NEW `schema.prisma:15-21`, `lib/permissions.ts`, `lib/access.ts`.
- **(6) Business impact:** Only SALESMAN + SUPERVISOR overlap by name. **ACCOUNTANT, ADMIN, ROUTEPRO have no NEW equivalent; MANAGER, STEWARD, VIEWER have no OLD equivalent.** Every user's role must be re-mapped, and some responsibilities (accountant Temix confirmation, RoutePro activation) have no home in NEW.
- **(7) Technical impact:** Role strings can't be copied across; NEW's enum will reject OLD's `ACCOUNTANT`/`ROUTEPRO`. Scope model differs (depot/route vs region/route-ownership).
- **(8) Data-migration impact:** User migration requires an explicit role crosswalk (e.g., ADMIN→MANAGER or STEWARD? ACCOUNTANT→? ROUTEPRO→retired?). Depot concept (OLD) does not exist in NEW (region-based).
- **(9) Security/compliance impact:** Mis-mapping can over-grant (e.g., mapping ADMIN→STEWARD grants import/merge/lock-bypass). Steward is the highest-privilege role in NEW.
- **(10) Recommended direction:** Adopt **NEW's role model**. Define an explicit crosswalk with the owner: SALESMAN→SALESMAN, SUPERVISOR→SUPERVISOR, ADMIN→MANAGER (+ STEWARD where data-ops needed), ACCOUNTANT/ROUTEPRO→retire or fold into a workflow step if H-02/H-06 keep Temix.
- **(11) Alternatives:** Add ACCOUNTANT/ROUTEPRO roles to NEW if the Temix/RoutePro workflow is retained.
- **(12) Decision required:** Owner must approve the role crosswalk, especially the fate of ACCOUNTANT and ROUTEPRO and who becomes STEWARD.
- **(13) Urgency:** Immediate (gates user migration + auth).
- **(14) Wait?** **YES.**

---

## H-06 — Approval sequence & tiers

- **(2) Area:** Workflow / approval engine.
- **(3) OLD behavior:** **Two-tier approval + activation**: Salesman submit → Supervisor approve → Accountant confirm-Temix → Admin/RoutePro activate → ACTIVE_IN_ROUTEPRO. Minor `UPDATE_EXISTING` categories bypass the accountant (supervisor → PENDING_ROUTEPRO). Duplicate-gating (BLOCKED/WARNING) at submit. SLA-driven auto-escalation. [Confirmed — old-functional.md §3, old-rules.md §E]
- **(4) NEW behavior:** **Single-tier approval**: Salesman submit edit (SUBMITTED) → Supervisor **or** Manager approve (APPROVED, applied to master) → reject sends NEEDS_CORRECTION. Steward/Manager **direct-write** (auto-approved, no queue). Separate **reactivation** path requires **Manager** approval. No accountant tier, no activation stage, no SLA. [Confirmed — new-functional.md §3, new-rules.md §D-E]
- **(5) Evidence:** OLD `approve/route.ts:52-70`, `confirm-temix/route.ts:63`, `activate-routepro/route.ts:62-63`; NEW `services/edits.ts:600,767-780,421-451`, `services/reactivations.ts:224-307`.
- **(6) Business impact:** Different segregation-of-duty. OLD enforces accountant + activation checkpoints; NEW collapses to one approver and lets Steward/Manager bypass approval entirely. Consolidation must decide the authoritative approval chain.
- **(7) Technical impact:** State machines are incompatible (17 request statuses vs 5 EditState values). Hand-coded transitions in OLD vs atomic-claim engine in NEW.
- **(8) Data-migration impact:** In-flight OLD requests (PENDING_ACCOUNTANT, PENDING_ROUTEPRO, ESCALATED, RETURNED_*) have no NEW equivalent state — must be drained/closed in OLD before cutover or hand-mapped.
- **(9) Security/compliance impact:** NEW's Steward/Manager direct-write is a documented control gap (no second-person review) — stricter industries may require OLD's dual approval.
- **(10) Recommended direction:** Adopt NEW's edit-approval engine; **add back a second-tier/finance checkpoint only if the business requires accountant sign-off**. Explicitly decide whether Steward/Manager direct-write is acceptable for the consolidated risk profile.
- **(11) Alternatives:** Configurable approval tiers per change category (mirrors OLD's SUPERVISOR_ONLY vs FULL split).
- **(12) Decision required:** Owner must approve the go-forward approval chain and whether direct-write bypass stays.
- **(13) Urgency:** Immediate.
- **(14) Wait?** **YES.**

---

## H-07 — Cash/Credit handling

- **(2) Area:** Payment terms / credit.
- **(3) OLD behavior:** **No payment-terms field at all.** "Cash" is modeled implicitly as the `NO_CR` request type (customer without CR, stricter GPS/photo, CR photo skipped); "credit" is only implied by having a CR. No `paymentTerms`, credit-limit, or AR logic anywhere. [Confirmed — old-functional.md §6, old-rules.md §H]
- **(4) NEW behavior:** Explicit **`PaymentTerms` enum CASH/CREDIT** (`schema.prisma:23-26`, default CASH). Behavioral effect: on CREDIT, `crNumber` is field-locked for SALESMAN and dropped from their mandatory gate (`permissions.ts:78-79`, `edits.ts:137,154`). Import strictly whitelists CASH/CREDIT (`imports.ts:643-651`). Still no credit-limit/AR logic. [Confirmed — new-functional.md J4, new-rules.md §C]
- **(5) Evidence:** OLD `constants.ts:206-211`; NEW `schema.prisma:23-26`, `lib/permissions.ts:78-79`, `services/imports.ts:643-651`.
- **(6) Business impact:** Cash/credit is a first-class attribute in NEW but absent in OLD. Migrating OLD customers gives no payment-terms source — every OLD customer would default to CASH, which may be wrong for credit customers.
- **(7) Technical impact:** No mapping field. `NO_CR`↔CASH is a plausible but lossy heuristic (NO_CR means "no CR", not "cash terms").
- **(8) Data-migration impact:** MEDIUM. Payment terms for OLD customers must come from ERP/Temix, not the portal. Defaulting all to CASH risks unlocking `crNumber` edits on genuine credit customers.
- **(9) Security/compliance impact:** Field-lock behavior (who may edit CR) depends on payment terms; wrong terms weaken the CR-edit control.
- **(10) Recommended direction:** Source authoritative `paymentTerms` from Temix/ERP during migration; do **not** infer from `NO_CR`. Keep NEW's enum.
- **(11) Alternatives:** Provisional CASH default with a mandatory Steward review pass to set CREDIT before go-live.
- **(12) Decision required:** Owner must provide the payment-terms source of truth and the default/reconciliation policy for migrated customers.
- **(13) Urgency:** Near-term (before customer migration).
- **(14) Wait?** **YES** for the migration data source.

---

## H-08 — Duplicate-detection logic

- **(2) Area:** Deduplication.
- **(3) OLD behavior:** **Fuzzy** Levenshtein name similarity (EXACT ≥0.85, POSSIBLE ≥0.70) against both `CustomerMaster` and pending requests, plus CR-match and last-8-digit phone `contains` matching; first-4-char prefix prefetch (recall gap). Submit maps risk→BLOCKED/WARNING/PENDING (`lib/duplicate-check.ts`). [Confirmed — old-rules.md §D]
- **(4) NEW behavior:** **No fuzzy matching** (deliberately removed). Only two EXACT rules: CR-exact, and EXACT_TRIPLE (lower(legalName)+primaryPhoneNorm+regionId). **Phone duplicates explicitly allowed** (unique index dropped — many shops share one owner phone). Steward-only; advisory (never blocks edits). [Confirmed — new-rules.md §F, new-data.md §4.4, new-docs.md §3 P1.3/P1.4]
- **(5) Evidence:** OLD `lib/duplicate-check.ts:7-8,91-101,122-146`; NEW `services/duplicates.ts:116-150`, `migrations/20260510160000_p1_drop_phone_unique`.
- **(6) Business impact:** Opposite philosophies. OLD blocks at creation on fuzzy/phone signals; NEW treats phone duplicates as legitimate and only flags high-confidence exact pairs for Steward review. A consolidated dedupe policy must be chosen.
- **(7) Technical impact:** OLD's fuzzy scan is O(N·M) and won't use indexes at scale; NEW's exact rules use trigram/exact indexes but miss typo/variant duplicates.
- **(8) Data-migration impact:** MEDIUM. Migrating OLD data under NEW's rules may import records OLD would have blocked as duplicates (and vice versa). A one-time dedupe reconciliation is advisable pre-cutover.
- **(9) Security/compliance impact:** Phone-uniqueness removal is an intentional data-model decision (owner-accepted); document it so it isn't re-introduced.
- **(10) Recommended direction:** Keep NEW's exact rules as the guardrail; **optionally** add a fuzzy *advisory* Steward report (not a hard block) to recover OLD's typo-catching without reintroducing false blocks.
- **(11) Alternatives:** Reinstate phone/fuzzy blocking (rejected per the shared-owner-phone reality) or keep NEW as-is.
- **(12) Decision required:** Owner confirms the shared-phone reality and whether fuzzy advisory matching is wanted.
- **(13) Urgency:** Near-term.
- **(14) Wait?** Partial — NEW default is usable; only the optional fuzzy-advisory enhancement needs sign-off.

---

## H-09 — Customer↔Branch cardinality

- **(2) Area:** Entity relationships.
- **(3) OLD behavior:** No `Branch` model. A branch is a separate `CustomerRequest` of type `NEW_BRANCH` linked to its parent only via the **`parentTemixCode` string** (no FK). [Confirmed — old-functional.md §6, old-data.md §4]
- **(4) NEW behavior:** `Branch` is a first-class model (`schema.prisma:294-349`) with FK `customerId` (RESTRICT), own region/route/GPS/photos/status. Schema permits 1:N, **but P1.2 flattened production data to 1:1** (3308 customers = 3308 branches); `services/duplicates.ts` now assumes `branches[0]`. [Confirmed — new-data.md, new-docs.md §3 P1.2, §4 #5]
- **(5) Evidence:** OLD `constants.ts:200-205`, `lib/validators/request.ts:65-71`; NEW `schema.prisma:294-349`, `scripts/flatten-customer-branches.ts:137`, `services/duplicates.ts:61,137`.
- **(6) Business impact:** OLD supports multi-branch customers via parent linkage; NEW's *schema* supports 1:N but its *data + code* now assume 1:1. Whether a customer can have multiple branches going forward is unresolved.
- **(7) Technical impact:** NEW code paths (dedupe `branches[0]`, completeness averaging) assume one branch — re-introducing multi-branch data could break these assumptions.
- **(8) Data-migration impact:** HIGH. OLD parent+branch requests must be collapsed into NEW's Customer(1)→Branch(1..N) shape, but NEW currently expects 1:1 — a conflict if OLD has true multi-branch customers.
- **(9) Security/compliance impact:** NEW's `filterBranchesByScope` prevents multi-branch scope leaks — relevant only if 1:N is re-enabled.
- **(10) Recommended direction:** Decide the go-forward cardinality. If multi-branch is required, **audit and fix the `branches[0]` assumptions** before migrating OLD multi-branch data; if not, keep 1:1 and map each OLD branch-request to its own Customer.
- **(11) Alternatives:** Keep 1:1 (simpler) vs restore 1:N (matches OLD + original PRD §5.2).
- **(12) Decision required:** Owner confirms whether customers can have multiple branches in the consolidated system.
- **(13) Urgency:** Near-term (before branch migration).
- **(14) Wait?** **YES** for the cardinality decision.

---

## H-10 — Customer status model

- **(2) Area:** Status / lifecycle.
- **(3) OLD behavior:** 17 **request** statuses (DRAFT…ACTIVE_IN_ROUTEPRO, REJECTED_*, RETURNED_*, ESCALATED, CANCELLED, + legacy) as bare `String` (`types/index.ts:9-26`). Customer-level lifecycle is only `CustomerMaster.isActive` + `pendingUpdate`. No SUSPENDED. [Confirmed — old-functional.md §3, old-data.md §4]
- **(4) NEW behavior:** `CustomerStatus` enum **ACTIVE/CLOSED/SUSPENDED** shared by Customer and Branch (`schema.prisma:28-32`). Edit lifecycle is separate `EditState` (5 values). **SUSPENDED is a dead-end** (no in-app entry/exit); branch CLOSED never cascades to Customer. [Confirmed — new-functional.md §3b gaps, new-rules.md §E]
- **(5) Evidence:** OLD `types/index.ts:9-26`, `lib/constants.ts:78`; NEW `schema.prisma:28-32`, `services/reactivations.ts:56-58`.
- **(6) Business impact:** OLD conflates workflow state with customer state; NEW separates them but has orphaned SUSPENDED and no customer-level close. Neither cleanly models "customer lifecycle."
- **(7) Technical impact:** No status mapping — OLD statuses are workflow-phase, NEW statuses are customer-condition.
- **(8) Data-migration impact:** MEDIUM. Map OLD `isActive` → NEW ACTIVE/CLOSED; there is no OLD source for SUSPENDED. In-flight OLD workflow statuses map to NEW `EditState`, not `CustomerStatus`.
- **(9) Security/compliance impact:** Low.
- **(10) Recommended direction:** Keep NEW's `CustomerStatus` enum; **close the SUSPENDED dead-end and the branch→customer CLOSED cascade gap** as part of consolidation. Map OLD `isActive=false`→CLOSED.
- **(11) Alternatives:** Add a TEMPORARY/INACTIVE state if the business needs it (absent in both).
- **(12) Decision required:** Owner defines the customer lifecycle states required and SUSPENDED semantics.
- **(13) Urgency:** Near-term.
- **(14) Wait?** Partial — NEW is usable; SUSPENDED/cascade fixes need product sign-off.

---

## H-11 — Auth generation & session security

- **(2) Area:** Authentication / session.
- **(3) OLD behavior:** **NextAuth 4.24.7**, Credentials/JWT, 8h `maxAge`, secret from `NEXTAUTH_SECRET`. **`isActive`/role checked only at login**; JWT callbacks never re-read the DB → a fired/demoted user keeps access up to 8h (documented HIGH finding J-H1). Timing-unsafe CRON compare; no dummy-hash on user-not-found (enumeration oracle). [Confirmed — old-arch.md B.7, old-security.md J-H1/J-M4]
- **(4) NEW behavior:** **Auth.js v5 beta**, Credentials/JWT, 8h TTL but **5-min freshness re-read** honoring `isActive`/role-change/`sessionsRevokedAt` hard revocation; `__Secure-` cookie prefix; AUTH_SECRET entropy assertion; constant-time bcrypt dummy-hash; `mustChangePassword` gate; password-reuse history; timing-safe cron compare. Caveat: runs on a **beta** auth dependency. [Confirmed — new-arch.md 7, new-security.md L-3/L-4/L-9]
- **(5) Evidence:** OLD `lib/auth.ts:76,100-127`; NEW `lib/auth.ts:17-32,148-218`, `auth.config.ts:14-32`.
- **(6) Business impact:** NEW's auth is materially stronger (immediate revocation, forced rotation). OLD's session staleness is a real security gap. But NEW depends on a beta library.
- **(7) Technical impact:** Different major auth versions; no session/token compatibility. Consolidation inherits NEW's model.
- **(8) Data-migration impact:** Password hashes are bcrypt in both (portable). User accounts must be re-provisioned into NEW's `User` model + role crosswalk (H-05).
- **(9) Security/compliance impact:** Adopt NEW for revocation/freshness; but pin/track the Auth.js v5 beta→stable upgrade as a production risk.
- **(10) Recommended direction:** Standardize on **NEW's auth stack**; add a task to move off `next-auth ^5.0.0-beta.31` to a stable release before broad rollout.
- **(11) Alternatives:** Backport freshness/revocation to NextAuth 4 (rejected — NEW already implements it).
- **(12) Decision required:** Accept the beta-auth dependency risk (with an upgrade plan) — informational sign-off.
- **(13) Urgency:** Near-term.
- **(14) Wait?** No — NEW is the clear superset; proceed while tracking the beta upgrade.

---

## H-12 — Storage backend

- **(2) Area:** File/photo storage.
- **(3) OLD behavior:** **Vercel Blob** primary (`access:'public'` + UUID keys, auth-gated proxy) with optional S3/R2 branch that is **broken** (`@aws-sdk/client-s3` not in package.json → runtime import failure) and local-disk fallback. Photos stored as `RequestPhoto` rows keyed to requests. [Confirmed — old-arch.md B.10, old-techdebt.md BUG-10]
- **(4) NEW behavior:** **Cloudflare R2** via S3 SDK, presigned PUT + server-side finalize (HeadObject size/kind verification, capturedAt from R2 LastModified), streamed through auth'd route (no public keys). `Attachment` model with sha256 dedupe, soft-delete, GC cron. [Confirmed — new-arch.md 9, new-rules.md §H, new-security.md L-6]
- **(5) Evidence:** OLD `lib/storage.ts:42-127`; NEW `lib/r2.ts`, `app/api/photos/{presign,finalize,[id]}`.
- **(6) Business impact:** Different storage providers and object-key schemes. Existing OLD photos must be migrated to R2.
- **(7) Technical impact:** NEW's photo pipeline is stronger (evidence-integrity, private serving). OLD's Blob URLs remain valid if leaked.
- **(8) Data-migration impact:** MEDIUM. Copy OLD Blob/local files → R2, create `Attachment` rows with hashes, re-associate to Customer/Branch. OLD photos lack NEW's capturedAt/GPS-at-capture metadata.
- **(9) Security/compliance impact:** NEW is more private (no public objects). Migrated OLD public-blob URLs should be invalidated post-migration.
- **(10) Recommended direction:** Standardize on **R2 pipeline**; migrate OLD photos with a backfill job; deprecate Vercel Blob.
- **(11) Alternatives:** Dual-read during transition.
- **(12) Decision required:** Approve R2 as the single storage backend and photo-migration approach.
- **(13) Urgency:** Near-term.
- **(14) Wait?** No — direction is clear.

---

## H-13 — Deployment / DB configuration integrity (OLD-only critical)

- **(2) Area:** Deployment / database provider.
- **(3) OLD behavior:** **Schema declares `provider = "postgresql"` but every env file sets `DATABASE_URL="file:./dev.db"` (SQLite)**, and a 344 KB `prisma/dev.db` exists. Postgres-only features used (`mode:'insensitive'`, raw `ON CONFLICT`/`NOW()`, `ALTER TYPE`). Base tables created via `db push` (no init migration); a migration references a non-existent Postgres enum → `migrate deploy` fails. Docs claim "standardized on SQLite," contradicting schema. **Not cleanly deployable as-is.** [Confirmed — old-data.md §5.2-5.3, old-arch.md B.5, old-techdebt.md BUG-01]
- **(4) NEW behavior:** Clean PostgreSQL on Neon, pooled `DATABASE_URL` + `DIRECT_URL`, replayable migrations with `migration_lock.toml`, DB backup + restore-drill automation. [Confirmed — new-arch.md 5-6, new-data.md §5]
- **(5) Evidence:** OLD `schema.prisma:6`, `.env`, `prisma/dev.db`, `migrations/20260405000000_add_update_existing_type`; NEW `prisma/migrations/*`, `.github/workflows/db-backup.yml`.
- **(6) Business impact:** OLD cannot be reliably stood up or migrated from until its DB target is reconciled. Determines what data even exists to migrate (dev.db seed vs a real prod Postgres).
- **(7) Technical impact:** Must confirm the actual OLD production datasource before ETL. If prod is a separate Postgres (likely), `dev.db` is a red herring.
- **(8) Data-migration impact:** HIGH/blocking for OLD extraction — source of truth is unknown until verified.
- **(9) Security/compliance impact:** See H-14 (committed secrets compound this).
- **(10) Recommended direction:** Before any OLD data extraction, **verify the real OLD production `DATABASE_URL`** (Vercel env). Extract from the true source, not `dev.db`.
- **(11) Alternatives:** None — verification is mandatory.
- **(12) Decision required:** Owner/infra must disclose the live OLD datasource.
- **(13) Urgency:** Immediate (gates OLD extraction).
- **(14) Wait?** N/A — OLD is a source system; verify before extracting. NEW deployment is unaffected.

---

## H-14 — Secret hygiene (both systems, different failure modes)

- **(2) Area:** Security / secrets in git.
- **(3) OLD behavior:** **`.env` is committed to git** (tracked; `.gitignore` misses bare `.env`) containing live-looking `NEXTAUTH_SECRET` (JWT signing → full auth-forgery/admin-impersonation risk) and `CRON_SECRET`, plus DB/SMTP settings. Committed in `3761c02`. [Confirmed — old-security.md J-C1, old-data.md §6, old-arch.md B.9]
- **(4) NEW behavior:** No `.env` in git (correctly gitignored; history clean). **But plaintext production pilot credentials for all 13 users — including STEWARD (highest privilege) — are committed** in `docs/PILOT-MUSCAT-CREDENTIALS.md` and hardcoded in `scripts/bulk-reset-credentials.ts` (`[REDACTED-PILOT-PW]`/`[REDACTED-PILOT-PW]`), with `mustChangePassword=false`. [Confirmed — new-security.md C-1, new-docs.md §6]
- **(5) Evidence:** OLD `.env` (redacted `NEXTAUTH_SECRET="hjT…"`, `CRON_SECRET="b04…"`); NEW `docs/PILOT-MUSCAT-CREDENTIALS.md`, `scripts/bulk-reset-credentials.ts:38-39`.
- **(6) Business impact:** Both expose a full-compromise path. OLD: forge any session. NEW: log in as Steward and run imports/merges/lock-bypass. Weak shared passwords also destroy per-user auditability.
- **(7) Technical impact:** Secrets/passwords persist in git history even after deletion — must be treated as permanently burned.
- **(8) Data-migration impact:** None, but credentials must be rotated before/at cutover.
- **(9) Security/compliance impact:** CRITICAL both. Non-repudiation void under shared passwords; committed signing secret = auth bypass.
- **(10) Recommended direction:** **Rotate everything now.** OLD: `git rm --cached .env`, rotate `NEXTAUTH_SECRET`+`CRON_SECRET`, purge history. NEW: rotate all pilot passwords to unique high-entropy, set `mustChangePassword=true`, purge the credentials doc + script literals from history, add a gitleaks pre-commit/CI gate. (Report locations only — no secret values reproduced here.)
- **(11) Alternatives:** None — remediation is mandatory regardless of consolidation direction.
- **(12) Decision required:** Approve immediate rotation window + history rewrite (informational — this is a must-do, not a choice).
- **(13) Urgency:** Immediate.
- **(14) Wait?** No — fix independently of consolidation.

---

## H-15 — Branding / identity (ICO vs NMWC)

- **(2) Area:** Naming / branding / domain.
- **(3) OLD behavior:** Dual branding: package `ico-customer-portal`, description "ICO Customer Registration Workflow Portal" (`package.json:2,4`), internally "ICO Customer Portal", README titled "NMWC Customer Registration Portal". Serves NMWC but ICO-branded. [Confirmed — old-arch.md B.1]
- **(4) NEW behavior:** Consistent **NMWC** branding; live domain `https://nmwc-cm.vercel.app`; package/description "field-driven master data cleanup app". [Confirmed — new-arch.md 1,6]
- **(5) Evidence:** OLD `package.json:2,4`, README; NEW `package.json:5`, `.github/workflows/keep-warm.yml:45`.
- **(6) Business impact:** OLD's ICO branding is inconsistent with the NMWC entity; consolidated product should be single-branded NMWC.
- **(7) Technical impact:** Package name, domain, app-name env vars, email templates need alignment.
- **(8) Data-migration impact:** None.
- **(9) Security/compliance impact:** Low (email "from"/domain consistency).
- **(10) Recommended direction:** Standardize on **NMWC** branding + domain; retire the ICO name.
- **(11) Alternatives:** Keep ICO if it is the actual operating brand — owner to confirm.
- **(12) Decision required:** Owner confirms the official product name/brand/domain.
- **(13) Urgency:** Near-term (cosmetic but should be settled before rollout).
- **(14) Wait?** No.

---

## H-16 — Enum enforcement (weak String typing vs DB enums)

- **(2) Area:** Data integrity / typing.
- **(3) OLD behavior:** **Zero DB enums** — `status`, `type`, `role`, `duplicateRisk`, `channel`, `updateCategory`, etc. are bare `String`; type-safety only in TS/Zod. A raw DB write can inject an arbitrary role/status. [Confirmed — old-data.md §5.2, old-functional.md §9]
- **(4) NEW behavior:** **11 DB enums** (Role, PaymentTerms, CustomerStatus, EditState, etc.), plus CHECK constraints and triggers. DB rejects invalid categorical values. [Confirmed — new-data.md §1]
- **(5) Evidence:** OLD `schema.prisma:55` (+ absence of enums); NEW `schema.prisma:15-106`.
- **(6) Business impact:** NEW enforces integrity at the DB; OLD relies entirely on app code. Migrating OLD String values into NEW enums will reject any out-of-vocabulary value.
- **(7) Technical impact:** Migration must normalize OLD strings to NEW enum vocabularies (e.g., channel/subChannel → FK rows; role → enum).
- **(8) Data-migration impact:** MEDIUM — value normalization + quarantine of unmappable values.
- **(9) Security/compliance impact:** NEW is stronger; adopt it.
- **(10) Recommended direction:** Keep NEW's enum discipline; build value-normalization maps during ETL.
- **(11) Alternatives:** None sensible.
- **(12) Decision required:** None beyond approving normalization mappings (data-cleaning, not policy).
- **(13) Urgency:** Near-term.
- **(14) Wait?** No.

---

## H-17 — Notifications & SLA

- **(2) Area:** Notifications / escalation / SLA.
- **(3) OLD behavior:** In-app `Notification` rows on every transition; **email scaffolding present but not wired** to the lifecycle (SMTP blank; `sendNotificationEmail` is dead code — BUG-04); **SLA engine** (supervisor 8h / accountant 9h working-hours) with hourly cron auto-escalation (though cron is POST-only vs Vercel GET → BUG-03, so it never fires in prod). [Confirmed — old-rules.md §J-K, old-techdebt.md BUG-03/04]
- **(4) NEW behavior:** **No notification subsystem at all** (no email/SMS/push/in-app model), **no SLA/escalation/aging** logic. Reviewers discover work via `/approvals`/`/work` queue pages refreshed by `revalidatePath`. [Confirmed — new-rules.md §M]
- **(5) Evidence:** OLD `lib/notifications.ts`, `lib/sla.ts`, `vercel.json` crons; NEW — absence (no Notification model, no mailer dep).
- **(6) Business impact:** OLD *intended* notifications + SLA (even if broken); NEW deliberately has none. If the business needs SLA tracking or approver alerts, NEW must add them.
- **(7) Technical impact:** Building notifications/SLA into NEW is net-new work.
- **(8) Data-migration impact:** None (OLD notifications are transient).
- **(9) Security/compliance impact:** SLA/escalation may be an operational-control requirement.
- **(10) Recommended direction:** Decide whether SLA + approver notifications are required. If yes, implement in NEW (queue-aging + optional email); if no, accept NEW's queue-only model.
- **(11) Alternatives:** Queue-only (status quo NEW) vs full SLA/email parity with OLD's intent.
- **(12) Decision required:** Owner states whether SLA timers and notifications are in-scope for the consolidated system.
- **(13) Urgency:** Near-term.
- **(14) Wait?** **YES** if SLA/notifications are required — it is net-new scope.

---

## H-18 — GPS geofence & capture integrity

- **(2) Area:** GPS validation.
- **(3) OLD behavior:** Global bounds only (lat ±90, lng ±180); **no Oman geofence**. Device-capture enforced **frontend-only** — the API accepts arbitrary lat/lng/capturedAt (spoofable). [Confirmed — old-rules.md §B]
- **(4) NEW behavior:** **Oman envelope** (lat 16–27, lng 51–61) enforced server-side; photo `capturedAt` derived from **R2 HeadObject.LastModified**, not client input, so freshness/location can't be spoofed. [Confirmed — new-rules.md §E,G]
- **(5) Evidence:** OLD `lib/validators/request.ts:39-40`, `components/forms/GPSCapture.tsx:35-72`; NEW `lib/validation/edit.ts:59-69`, `app/api/photos/finalize/route.ts:74-78`.
- **(6) Business impact:** NEW enforces plausible in-country coordinates and tamper-resistant capture; OLD does not. Migrated OLD GPS may fall outside NEW's envelope and be rejected.
- **(7) Technical impact:** OLD coordinates must be validated against NEW's CHECK constraints on import.
- **(8) Data-migration impact:** MEDIUM — out-of-envelope OLD GPS rows quarantined.
- **(9) Security/compliance impact:** NEW stronger (anti-spoof).
- **(10) Recommended direction:** Keep NEW's geofence + server-derived capture; quarantine/repair out-of-bounds OLD GPS during ETL.
- **(11) Alternatives:** Widen envelope only if legitimate cross-border outlets exist.
- **(12) Decision required:** Confirm the Oman envelope covers all real outlets (data-cleaning threshold).
- **(13) Urgency:** Near-term.
- **(14) Wait?** No.

---

## H-19 — Migration workflow (db push vs replayable migrations)

- **(2) Area:** Schema-change process.
- **(3) OLD behavior:** Base tables via **`db push`** (no init migration); migration history inconsistent/non-replayable (references a non-existent Postgres enum); `migrate deploy` on a clean DB fails. [Confirmed — old-data.md §5.2, old-techdebt.md BUG-01]
- **(4) NEW behavior:** 8–9 timestamped **replayable migrations** with `migration_lock.toml`; hand-written idempotent SQL (DO-blocks, triggers, CHECK/partial/trigram indexes) carrying invariants beyond schema.prisma. [Confirmed — new-data.md §5]
- **(5) Evidence:** OLD `prisma/migrations/*`; NEW `prisma/migrations/*`.
- **(6) Business impact:** NEW has a reproducible, auditable schema pipeline; OLD does not. Consolidated system should inherit NEW's discipline.
- **(7) Technical impact:** Note that NEW's real DB invariants live in migration SQL, not schema.prisma — reviewers must read migrations, not just the schema.
- **(8) Data-migration impact:** Low.
- **(9) Security/compliance impact:** Low.
- **(10) Recommended direction:** Adopt NEW's migration workflow; ensure any consolidation schema changes go through replayable migrations.
- **(11) Alternatives:** None sensible.
- **(12) Decision required:** None (engineering standard).
- **(13) Urgency:** Near-term.
- **(14) Wait?** No.

---

## H-20 — Rate-limiter correctness (both broken, different ways)

- **(2) Area:** Brute-force protection.
- **(3) OLD behavior:** DB-backed dual-bucket limiter using Postgres `ON CONFLICT`/`NOW()` raw SQL that **fails OPEN** on any DB error, and **breaks on SQLite** (the committed dev target) → login brute-force protection silently off in that config. [Confirmed — old-security.md J-H2, old-techdebt.md BUG-01]
- **(4) NEW behavior:** Durable token-bucket, fails **closed** for `login:`/`passwordreset:` keys on DB exception (good) — **but** the Postgres path's `granted` is derived from a clamped token count that can never go negative, so **`granted` is always true**: the limiter **never denies in production** (`lib/rate-limit.ts:102-104`, BUG-1). Only the in-memory path (tests) works. [Confirmed — new-techdebt.md BUG-1]
- **(5) Evidence:** OLD `lib/rate-limit.ts:32-56`; NEW `lib/rate-limit.ts:78-112`.
- **(6) Business impact:** **Both systems' login brute-force protection is effectively disabled in their real deployment configs.** With NEW's weak shared pilot passwords (H-14), this is an acute exposure.
- **(7) Technical impact:** NEW's is a one-line logic bug (~1h fix); OLD's is a provider-mismatch symptom of H-13.
- **(8) Data-migration impact:** None.
- **(9) Security/compliance impact:** HIGH in both — the only remaining brute-force friction is bcrypt cost-12.
- **(10) Recommended direction:** Fix NEW's `granted` predicate (return from availability, not clamped tokens) and add a Postgres-path integration test; for OLD, resolve H-13 and add a startup assertion. Adopt NEW's (fixed) limiter for consolidation.
- **(11) Alternatives:** None — correctness fix required.
- **(12) Decision required:** None (bug fix); flag as go/no-go blocker for NEW.
- **(13) Urgency:** Immediate.
- **(14) Wait?** No — fix regardless.

---

## Cross-cutting decision priorities (for the business owner)

**Must decide before ANY migration/implementation (blocking):**
1. H-02 system-of-record + H-01 canonical identifier (`nmwcCode`, `temixCode` as legacy xref).
2. H-03 whether field-originated new-customer creation is required.
3. H-05 role crosswalk (fate of ACCOUNTANT/ROUTEPRO; who becomes STEWARD/MANAGER).
4. H-06 approval chain (keep single-tier + direct-write, or reinstate a finance/second tier).
5. H-04/H-09 target schema (NEW) + branch cardinality (1:1 vs 1:N).
6. H-07 payment-terms source of truth for migrated customers.
7. H-17 whether SLA/notifications are in-scope (net-new in NEW).

**Must fix immediately regardless of direction (not blocking, do in parallel):**
- H-14 secret/credential rotation + history purge (both systems).
- H-20 rate-limiter correctness (NEW `granted` bug; OLD provider mismatch).
- H-13 verify OLD's real production datasource before extracting data.

**Clear engineering direction, confirm-only:**
- H-11 auth (adopt NEW; plan the beta→stable upgrade), H-12 storage (R2), H-15 branding (NMWC), H-16 enums, H-18 GPS, H-19 migrations, H-08 dedupe (NEW default + optional fuzzy advisory), H-10 status (NEW + fix SUSPENDED/cascade).

**Guiding principle:** The NEW system is the stronger, safer, cleaner base (typed schema, real migrations, modern auth, private storage, richer audit) and should be the consolidation target. The OLD system contributes **requirements the NEW lacks** — new-customer creation, accountant/Temix + RoutePro activation workflow, SLA/escalation, notifications — which must be explicitly re-scoped into NEW rather than assumed. No material business contradiction above has been silently resolved; each carries a named decision.
