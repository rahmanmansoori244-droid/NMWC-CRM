# Section M — Integration & Consolidation Risks (OLD ICO Customer Portal ↔ NEW NMWC Customer Master)

**Author:** cross-cutting consolidation analysis. **Mode:** read-only discovery. No project file modified.
**Sources:** all per-system discovery findings (`old-*.md`, `new-*.md`) plus spot-checks of source.
- OLD root: `C:\Users\abdulr\Desktop\ICO\customer-portal` (git HEAD `3d6217e`, last real work ~2026-04-17, **stalled**).
- NEW root: `C:\Users\abdulr\Desktop\NMWC-CRM` (git HEAD `c612c79`, live pilot `https://nmwc-cm.vercel.app`, **operational**).

Confidence tags: **[Confirmed]** read in code · **[Highly likely]** · **[Possible]** · **[Unknown]**.

---

## M.0 EXECUTIVE VERDICT — which system is the viable consolidation base

**The NEW system (NMWC Customer Master) is the only viable consolidation base. [Confirmed on evidence].** Rationale, concrete:

- NEW is **the actual system of record for customer data**; OLD is **not**. OLD's portal never writes `CustomerMaster` — `customerMaster.create|update|upsert` appears ONLY in master-file upload + seed (`old-functional.md` §4 "CRITICAL FINDING"; verified: OLD `CustomerMaster` is populated by `app/api/master/upload/route.ts:111,118`). The enriched field data a salesman captures in OLD (GPS, photos, contact) lives on `CustomerRequest` rows and is read back by JOINing `status=ACTIVE_IN_ROUTEPRO` (`app/api/customers/[temixCode]/route.ts:60-90`). OLD is a **workflow/approval tracker bolted onto an external ERP**, not a master-data store.
- NEW owns a normalized master: `Customer` (legal entity) + `Branch` (outlet) with a real approval/enrichment engine, soft-delete, optimistic locking, audit, import/export, R2 photo pipeline (`new-data.md` §2; `new-arch.md` §10). It is deployed and hardened (63-finding QA audit + 25-bug senior audit largely remediated — `new-docs.md` §2).
- NEW's stack is current (Next 15 / React 19 / Prisma 6 / Auth.js v5 / Sentry / pino); OLD is a version behind on every axis (Next 14 / React 18 / Prisma 5 / NextAuth 4 / no error-tracking / no structured logs) AND carries an unresolved **Postgres-schema-vs-SQLite-env contradiction that makes it not cleanly deployable as-is** (`old-arch.md` B.5; `old-techdebt.md` BUG-01).

**What choosing NEW as base COSTS (functionality that must be rebuilt or consciously dropped):** the entire OLD tiered ERP-creation workflow — Accountant "confirm-Temix" stage, RoutePro activation stage, the ACCOUNTANT and ROUTEPRO roles, SLA timers + auto-escalation, the 17-status request lifecycle, in-app new-customer/new-branch **request** intake, and email scaffolding. NEW deliberately has none of these (it is edit-only, no ERP round-trip, no SLA, no notifications — `new-rules.md` M; `new-functional.md` J2). If NMWC's target operating model still requires field-originated NEW-customer creation flowing to Temix, that is **net-new build on NEW**, not a migration. See M.4.

---

## M.1 DATA MIGRATION — schema mapping OLD → NEW

### M.1.1 The two systems do not share a customer identifier — [Confirmed] — **Likelihood: certain / Impact: Critical**
- OLD canonical key = `CustomerMaster.temixCode` `String @unique` (`schema.prisma:87`). NEW canonical key = `Customer.nmwcCode` `String @unique` (`new-data.md` §2). These are **different identifier spaces** (Temix ERP code vs NMWC master code). There is no field in either schema that carries the other's key. [Confirmed]
- Consequence: an identifier-reconciliation table (`temixCode ↔ nmwcCode`) must be built **out-of-band** (from ERP/business records) before any row can be matched. Neither repo contains this mapping. If NEW's `nmwcCode` was itself sourced from Temix (`imports.ts:820-833` uses the raw `cust_code` from the import sheet as `nmwcCode` — `new-rules.md` G note), then `cust_code` **may equal** `temixCode` — **verify this equivalence first**; if it holds, reconciliation is a join, if not it is a manual data project. [Possible — highest-leverage unknown to resolve].
- **Mitigation:** Before any migration, run a reconciliation study: export OLD `CustomerMaster.temixCode` + name + crNumber and NEW `Customer.nmwcCode` + legalName + crNumberNorm; match on `crNumber` (normalized) first, then exact name+phone. Freeze a crosswalk table; treat unmatched rows as manual triage. Do NOT assume the codes align.

### M.1.2 Structural shape conflict: flat OLD customer vs Customer+Branch NEW — [Confirmed] — **Likelihood: certain / Impact: High**
- OLD `CustomerMaster` is **flat**: `channel/subChannel/dayOfVisit/address/location/district/contactPerson/contactNumber` are all scalar columns on the customer (`schema.prisma:85-112`, spot-checked). There is no branch entity; "branches" in OLD are separate `CustomerRequest` rows of type `NEW_BRANCH` linked by loose string `parentTemixCode` (`old-data.md` §2). [Confirmed]
- NEW splits: `Customer` holds legal/contact/CR/paymentTerms; `Branch` holds address/GPS/dayOfVisit/equipment/photos/status; channel is normalized to `Channel`/`SubChannel` FK tables (`new-data.md` §2). NEW pilot was even **flattened to 1:1** Customer:Branch (`new-docs.md` §3 P1.2) though schema still permits 1:N. [Confirmed]
- Migration must **decompose** each OLD customer into a Customer + ≥1 Branch, and **resolve OLD free-string channel/subChannel/dayOfVisit against NEW's locked taxonomy** (`Channel`/`SubChannel` seeded from PRD Appendix A — `new-data.md` §2). OLD channel strings that don't map to a NEW taxonomy row will orphan (`channelId` is nullable SET NULL, so they silently become NULL). [Confirmed schema behavior]
- **Mitigation:** Build a channel/subChannel value crosswalk (OLD string → NEW `Channel.id`) and fail-loud on unmapped values rather than NULLing. Materialize OLD's real GPS/photo/contact enrichment (currently on `CustomerRequest` where `status=ACTIVE_IN_ROUTEPRO`) into NEW `Branch` fields — this data is NOT on OLD `CustomerMaster`, so a naive `CustomerMaster`→`Customer` copy loses every field the portal collected.

### M.1.3 Enum-vs-String data-type conflict — [Confirmed] — **Likelihood: certain / Impact: Medium-High**
- OLD stores **everything as bare `String`**: `status`, `type`, `role`, `duplicateRisk`, `channel`, `updateCategory`, `dayOfVisit` — **zero enums in the schema** (`old-data.md` §5.2). NEW uses **11 Postgres enums** (`Role`, `CustomerStatus`, `DayOfWeek`, `EditState`, `PaymentTerms`, etc. — `new-data.md` §1). [Confirmed both]
- Any OLD value that is not a member of the corresponding NEW enum will be **rejected at insert by Postgres** (enum type constraint) — e.g. OLD `dayOfVisit` free strings vs NEW `DayOfWeek(SAT..FRI)`; OLD role `ACCOUNTANT`/`ROUTEPRO` have **no NEW enum member** (see M.5). Migration ETL must normalize/whitelist every categorical value up-front. [Confirmed]
- OLD also has a **broken migration history**: migration `20260405..._add_update_existing_type` runs `ALTER TYPE "RequestType" ADD VALUE` against a Postgres enum that **does not exist** in the current String-based schema; base tables have **no init migration** (created by `db push`). `prisma migrate deploy` on a clean DB **fails** (`old-data.md` §5.2). This means OLD's own schema is non-replayable — you cannot stand up a clean OLD instance from its migrations to run a controlled export; you must export from the live/`dev.db` instance. [Confirmed — raises migration risk]

### M.1.4 Historical request/edit records are structurally incompatible — [Confirmed] — **Likelihood: certain / Impact: High (compliance) / Medium (operational)**
- OLD workflow history = `CustomerRequest` (17-status lifecycle) + `StatusHistory` (per-transition audit) + `AdminAuditLog` + `DuplicateMatch` (`old-data.md` §1). NEW workflow history = `CustomerEdit` (5-state `EditState`) + `AuditLog` + `ImportRow`/`ImportBatch` (`new-data.md` §1). **The state machines do not correspond** — OLD's PENDING_SUPERVISOR / PENDING_ACCOUNTANT / PENDING_ROUTEPRO / CONFIRMED_TEMIX / ACTIVE_IN_ROUTEPRO have **no NEW equivalent**; NEW's DRAFT/SUBMITTED/APPROVED/NEEDS_CORRECTION only partly overlap OLD's DRAFT/RETURNED/APPROVED. [Confirmed]
- There is **no clean way to load OLD `CustomerRequest` history into NEW `CustomerEdit`** without lossy re-coding. The realistic options: (a) **freeze OLD read-only** as a historical archive (recommended); (b) export OLD `StatusHistory`/`CustomerRequest` into NEW `AuditLog` as opaque `before/after` JSON blobs tagged with a synthetic action, losing queryable structure. [Confirmed constraints]
- **Mitigation:** Preserve OLD as a frozen, read-only archive DB + object store for the audit-retention window; migrate only the **current customer master state** into NEW, not the request/approval history. Document the cutover date as the provenance boundary.

### M.1.5 Referential-integrity + denormalization landmines in BOTH — [Confirmed] — **Likelihood: high / Impact: Medium**
- OLD: `parentTemixCode`/`existingTemixCode`/`routeCode`/`salesmanName` are loose strings with **no FK** (`old-data.md` §5.4) — dangling references will not error on export but will mis-map on import.
- NEW: `Attachment.customerId`/`branchId`, `Customer.importBatchId`, `createdById`/`lastEditedById` are **loose scalars with no FK** (`new-data.md` §4.2). A migration that inserts customers referencing not-yet-inserted users leaves silently-orphaned provenance. [Confirmed]
- NEW has **DB invariants invisible in schema.prisma**: GPS range CHECKs (lat 16–27, lng 51–61 Oman envelope), address minlength, `branch_region_consistency_check` trigger (Branch.regionId must equal Route.regionId), pg_trgm indexes, partial-unique on `crNumberNorm` (`new-data.md` §5; `new-rules.md` E,G). **Migrated OLD data will be rejected by these** if OLD GPS is outside Oman (OLD has NO geofence — accepts any global coordinate, `old-rules.md` B), if OLD address < min length, or if branch region ≠ route region. [Confirmed — will hard-fail inserts]
- **Mitigation:** Run all OLD rows through NEW's Zod + DB CHECK constraints in a dry-run load against a Neon branch; quarantine violators (mirrors NEW's own import QUARANTINED lane, `imports.ts`). Expect OLD GPS/address rows to fail the Oman geofence + minlength checks.

---

## M.2 SCHEMA CONFLICTS (direct object-level) — [Confirmed]

| Concern | OLD | NEW | Conflict |
|---|---|---|---|
| Customer key | `temixCode` | `nmwcCode` | Different identifier spaces (M.1.1) |
| Customer shape | flat single table | `Customer`+`Branch`+`Channel`/`SubChannel` FK | Decompose + taxonomy remap (M.1.2) |
| Enrichment data of record | on `CustomerRequest` (status=ACTIVE) | on `Customer`/`Branch` | OLD master lacks the real field data |
| Categorical typing | all `String` | 11 enums | Whitelist/normalize every value (M.1.3) |
| Workflow entity | `CustomerRequest` 17-status | `CustomerEdit` 5-state | Non-corresponding state machines (M.1.4) |
| Roles | SALESMAN/SUPERVISOR/**ACCOUNTANT**/ADMIN/**ROUTEPRO** | SALESMAN/SUPERVISOR/**MANAGER**/**STEWARD**/VIEWER | 3 of 5 roles differ (M.5) |
| Storage keys | Vercel Blob URL / local disk key | `Attachment.r2Key` (R2 object key) | Photo re-hosting required (M.4/M.6) |
| Payment terms | **absent** | `PaymentTerms` enum CASH/CREDIT | OLD has no source value → default CASH |
| Soft-delete | only on Depot/Route/User/CustomerMaster; **not on requests** | `deletedAt` everywhere | OK into NEW; OLD requests have no archive flag |

---

## M.3 DEPLOYMENT RISKS

### M.3.1 Two separate Vercel projects / two datastores — [Confirmed] — **Likelihood: high / Impact: High**
- OLD: Vercel project (`.vercel/` present) + declared Postgres but committed SQLite env + `prisma/dev.db` + Docker/compose assuming SQLite + Vercel crons that are **POST-only while Vercel Cron sends GET → crons never fire** (`old-techdebt.md` BUG-03). NEW: distinct Vercel project `prj_h2Nwxt…`, org `team_Zs4wKn…`, region `fra1`, Neon Postgres, R2, GitHub-Actions off-platform crons (`new-arch.md` §6). [Confirmed]
- Consolidating means **decommissioning one project + DNS/URL cutover**. OLD's live URL/users must be redirected to NEW's `nmwc-cm.vercel.app` (or a new prod domain). Two different cron mechanisms (broken Vercel-POST vs working GitHub-Actions) — do not carry OLD's cron config forward.
- **Mitigation:** Single target = NEW's Vercel+Neon+R2. Retire OLD project after archive export. Re-point any bookmarked OLD URL via redirect.

### M.3.2 Framework/ORM/auth major-version deltas — [Confirmed] — **Likelihood: certain if any OLD code reused / Impact: High**
- Prisma **5.16 → 6.19**, NextAuth **4.24 → 5.0-beta**, Next **14 → 15**, React **18 → 19**, storage **@vercel/blob → @aws-sdk/client-s3(R2)** (`old-arch.md` B.2 vs `new-arch.md` §2). These are **breaking** across the board: NextAuth 4→5 changes the entire auth config surface (OLD `authOptions`/`getServerSession` vs NEW `auth.config.ts`+`handlers`); Prisma 5→6 changes client behavior; React 18→19 + Next 14→15 change RSC/server-action semantics.
- **Implication:** OLD feature code **cannot be lifted into NEW** — any OLD capability wanted in NEW (see M.4) is a **reimplementation against NEW's stack**, not a merge. Attempting to run both codebases in one repo/deploy is not feasible. [Confirmed by version incompatibility]
- **NEW's own risk:** `next-auth ^5.0.0-beta.31` is a **beta auth dependency in production** (`new-arch.md` §11). Pin it exactly and gate any upgrade behind the auth test suite before scaling beyond pilot.

### M.3.3 Env/secret differences + committed-secret contamination — [Confirmed] — **Likelihood: certain / Impact: Critical**
- OLD env var set (Vercel-Blob, SMTP, S3, `NEXTAUTH_SECRET`, `CRON_SECRET`) differs materially from NEW (R2_*, Sentry, `AUTH_SECRET`/`NEXTAUTH_SECRET` dual-read, `HEALTH_BEARER`, `DEMO_ACCOUNTS_DISABLED`) — `old-arch.md` B.8 vs `new-arch.md` §8. A merge must reconcile to NEW's set; OLD's blob/SMTP vars are dropped.
- **OLD `.env` is committed to git with live secrets** (`git ls-files` → `.env`, confirmed): `NEXTAUTH_SECRET="hjT…"` (redacted), `CRON_SECRET="b04…"` (redacted) — `old-security.md` J-C1. **These are burned** and must be rotated regardless of consolidation. Do NOT copy OLD secret values into NEW.
- **NEW has committed plaintext pilot credentials** (`git ls-files` → `docs/PILOT-MUSCAT-CREDENTIALS.md`, `scripts/bulk-reset-credentials.ts`, confirmed): shared 8-char passwords `[REDACTED-PILOT-PW]`/`[REDACTED-PILOT-PW]` incl. STEWARD (highest privilege), `mustChangePassword=false` — `new-security.md` C-1. **Also burned; permanently in history.**
- **Mitigation:** Fresh secret generation for the consolidated prod (Vercel env store + GitHub secrets only); rotate ALL of the above; `git rm --cached` + history purge (BFG/filter-repo) on both repos; add gitleaks pre-commit + CI gate; enforce per-user credentials + `mustChangePassword=true` before non-pilot rollout. Redact placeholder: mask everything after first 3 chars — do not surface values.

---

## M.4 FUNCTIONALITY LOST IF NEW IS THE BASE (and what it costs) — [Confirmed]

Choosing NEW drops these OLD capabilities (all confirmed present in OLD, absent in NEW):
1. **ERP-creation workflow (Accountant confirm-Temix + RoutePro activation)** — OLD's 4-stage pipeline that records Temix code + activation (`old-functional.md` §4). NEW has **no ERP round-trip at all** (`new-arch.md` §9 grep-negative). Cost: full re-design if field→ERP creation is still required.
2. **Field-originated NEW-customer / NEW-branch intake.** OLD salesmen can raise new-customer requests; NEW has **no manual customer-creation UI — only Steward Excel import** (`new-functional.md` J2). Cost: net-new intake feature on NEW, or accept import-only onboarding.
3. **SLA timers + auto-escalation** (supervisor 8h / accountant 9h working-hours, cron escalation — `old-rules.md` J). NEW has **no SLA/escalation** (`new-rules.md` M). Cost: rebuild if approval-aging SLAs are a business requirement.
4. **ACCOUNTANT and ROUTEPRO roles** — no NEW equivalent (M.5).
5. **Email scaffolding** (nodemailer present) — though OLD email is **dead code / never sent** (`old-techdebt.md` BUG-04), so little real loss.
6. **Duplicate-review as a rich fuzzy matcher** — OLD does Levenshtein name + phone + CR (`old-rules.md` D); NEW deliberately **dropped fuzzy/phone matching**, keeping only CR-exact + EXACT_TRIPLE (`new-rules.md` F). Different (arguably deliberate) semantics; not strictly "lost" but changed.

**If OLD were the base instead (not recommended):** you would lose NEW's normalized master, R2 pipeline, session-revocation/freshness auth, Sentry/pino observability, import/export/steward tooling, optimistic locking, soft-delete-everywhere, and inherit OLD's un-deployable Postgres/SQLite contradiction + broken crons + no-write-back-to-master architecture. Strictly worse.

---

## M.5 USER-ACCESS & ROLE-MAPPING RISKS — [Confirmed] — **Likelihood: certain / Impact: High**
- **Role sets overlap only partially.** OLD: `SALESMAN, SUPERVISOR, ACCOUNTANT, ADMIN, ROUTEPRO` (`old-functional.md` §2). NEW: `SALESMAN, SUPERVISOR, MANAGER, STEWARD, VIEWER` (`new-functional.md` §1). Only SALESMAN + SUPERVISOR are common by name. Mapping decisions required:
  - OLD `ADMIN` → NEW `MANAGER` or `STEWARD`? (NEW splits admin into region-admin MANAGER vs data-ops STEWARD — no single super-admin). [decision needed]
  - OLD `ACCOUNTANT` (ERP confirm role) → **no NEW target**; likely retire or map to VIEWER.
  - OLD `ROUTEPRO` (activation role) → **no NEW target**; retire.
- **Scope model differs.** OLD scopes by **Depot + Route** (`buildRequestScopeFilter`, `resolveCustomerScopeRouteCodes` — `old-rules.md` G). NEW scopes by **Route (salesman) / team routes (supervisor) / managed Regions (manager, M:N)** with fail-closed (`new-rules.md` A). OLD has **Depot** as a first-class scoping unit; NEW has **Region**. Depot→Region reconciliation is required, and OLD users' depot assignments do not translate directly. [Confirmed]
- **Auth model differs** (NextAuth4 JWT `{id,role,depotId,supervisorId}` vs Auth.js5 with session-revocation/freshness/`ownedRouteId`/`managedRegions`). OLD user rows cannot be lifted; users must be **re-provisioned** in NEW (usernames — NEW uses `username`, OLD uses `email` as login — `new-functional.md` §1 vs `old-functional.md` §1). [Confirmed]
- **Mitigation:** Build an explicit OLD-role→NEW-role + OLD-depot→NEW-region mapping sign-off matrix with the business. Re-create all users in NEW via the Steward/Manager provisioning flow with `mustChangePassword=true`; do not attempt to copy password hashes (bcrypt hashes are portable in principle, but login key changes email→username, so re-provision is cleaner and safer).

---

## M.6 SECURITY RISKS INTRODUCED BY MERGING — [Confirmed]
1. **Secret cross-contamination** (M.3.3): merging repos/histories risks propagating OLD's committed `NEXTAUTH_SECRET`/`CRON_SECRET` and NEW's committed pilot passwords into the consolidated history. **Likelihood high / Impact Critical.** Mitigation: start the consolidated repo from a clean history (squash), never `git merge` the OLD repo wholesale; rotate everything.
2. **Regression of NEW's hardening if OLD patterns are ported.** OLD's rate-limiter **fails open** and OLD auth **does not revoke on deactivation for up to 8h** (`old-security.md` J-H1/J-H2). NEW has session-revocation + fail-closed auth rate-limit. Porting OLD code could reintroduce these. **Likelihood medium / Impact High.** Mitigation: NEW patterns win; never backport OLD auth/rate-limit.
3. **NEW's own live defect must be fixed as part of cutover:** NEW rate-limiter Postgres path **never denies** (`checkLimitPg` `granted` always true — `new-techdebt.md` BUG-1) — brute-force protection is effectively off in prod. And **MANAGER direct-write is not region-scoped** (BOLA — `new-security.md` H-1). **Likelihood: active now / Impact: High.** Mitigation: fix BUG-1 (`lib/rate-limit.ts:102-104`) and H-1 (`services/edits.ts:259-264`) **before** onboarding OLD's larger user/customer population, since consolidation raises exposure.
4. **GPS trust:** OLD accepts client-supplied coordinates (device-capture is frontend-only, spoofable — `old-rules.md` M.2). NEW derives photo freshness from R2 `LastModified` and geofences GPS server-side. Migrating OLD GPS data imports **unverified** coordinates into a system that assumes verified ones. Mitigation: flag migrated GPS as "legacy/unverified" (e.g. re-capture required) rather than trusting it.

---

## M.7 OPERATIONAL INTERRUPTION DURING CUTOVER — [Confirmed constraints] — **Likelihood: high / Impact: High**
- Both systems front the **same real users** (NMWC salesmen/supervisors). A cutover implies: freeze OLD intake, export+reconcile+load into NEW (a multi-step ETL with quarantine, M.1.5), re-provision users, re-host photos to R2, then redirect.
- **Photo re-hosting is a hard dependency:** OLD photos live in Vercel Blob / local disk keyed on `RequestPhoto.fileKey/fileUrl`; NEW references `Attachment.r2Key`. Every OLD photo must be **copied into R2** and re-keyed to NEW's `YYYY/MM/DD/<userId>/…` convention with kind-binding (`new-rules.md` H). This is bulk object movement, not a DB migration. **Likelihood certain / Impact High.**
- NEW's import lane is Steward-gated + rate-limited (3/bucket) + 5 MB/`.xlsx` cap (`new-rules.md` I) — a full ~3,000-customer + branch + photo backfill will not fit the interactive import UI; needs a scripted bulk load path (like NEW's own `scripts/flatten-customer-branches.ts` / `synthetic.ts`). 
- **Mitigation:** Plan a maintenance window with OLD set read-only; run the ETL against a **Neon branch** first (NEW already automates restore-drill into a Neon branch — `new-arch.md` §6), validate row counts + spot-check, then promote. Provide a same-day fallback (M.9). Communicate a login change (email→username) to users.

---

## M.8 ERP SYNCHRONIZATION RISK — [Confirmed] — **Likelihood: high / Impact: High**
- **Neither system has a live ERP integration.** OLD records Temix/RoutePro steps as **manual/offline** fields (`temixCode`, `routeproActivatedAt`) — no HTTP client to Temix (`old-arch.md` B.10, grep-negative). NEW has **no Temix/RoutePro concept at all** (`new-arch.md` §9). [Confirmed both]
- Consolidating on NEW **removes the only place Temix codes were captured** (OLD's confirm-Temix stage). If NMWC's operating model relies on the portal to (a) drive Temix customer creation and (b) round-trip `nmwcCode`↔`temixCode`, that linkage **disappears** under NEW. NEW's ERP sync is Excel-in/Excel-out by the Steward (`new-docs.md` §1: "ERP→Excel→app→Excel→ERP"), i.e. **manual, batch, no API**.
- **Risk:** Post-cutover, new customers created in Temix will not appear in NEW until a Steward re-imports; edits approved in NEW will not reach Temix until a Steward exports and someone keys/loads them into Temix. **Two-way drift** between NEW master and Temix is the steady-state operational risk. [Confirmed by absence of integration]
- **Mitigation:** Define and document the Steward import/export cadence as the sanctioned ERP-sync mechanism; preserve the `temixCode`↔`nmwcCode` crosswalk (M.1.1) as a first-class artifact so exports can be re-keyed to Temix. If real-time ERP sync is required, it is **net-new integration work** on NEW (out of scope of either current codebase).

---

## M.9 HISTORICAL-DATA PRESERVATION & ROLLBACK REQUIREMENTS — [Confirmed]
- **Historical preservation (M.1.4):** OLD `CustomerRequest`/`StatusHistory`/`AdminAuditLog`/`DuplicateMatch` cannot be faithfully re-expressed in NEW's schema. Preserve OLD as a **frozen read-only archive** (DB snapshot + Blob export) for the retention/audit window; migrate only current master state. NEW's `AuditLog` is append-only and immutable (`new-rules.md` N) — do not attempt to inject re-coded OLD history into it as if native. **Likelihood certain / Impact Medium-High (compliance).**
- **Rollback:** The migration must be reversible until validated. NEW already has **daily `pg_dump`→R2 backups + restore-drill into a Neon branch** (`new-arch.md` §6) — leverage this. Requirements: (1) take a labeled Neon snapshot + R2 backup immediately pre-load; (2) run the load on a Neon **branch**, validate, then cut the pooled `DATABASE_URL` over — enabling instant revert by pointing back to the pre-load branch; (3) keep OLD project **live-but-read-only** (not deleted) for at least one full reconciliation cycle so a same-day fallback to OLD is possible; (4) preserve the id crosswalk so a partial rollback can re-split merged/enriched rows. **Do NOT** hard-delete OLD until NEW is validated in production for a defined soak period. [Confirmed — leverages existing NEW backup automation]

---

## M.10 CONSOLIDATION COST SUMMARY (concrete, on NEW as base)
| Workstream | Nature | Risk driver |
|---|---|---|
| Identifier reconciliation (`temixCode`↔`nmwcCode`) | data project, out-of-band | M.1.1 — may be a join or a manual match |
| Customer flatten→decompose + taxonomy remap | ETL with quarantine | M.1.2/M.1.3/M.1.5 |
| Materialize OLD enrichment (from CustomerRequest) into Branch | ETL | M.0 / M.1.2 — data is not on OLD master |
| Photo bulk re-host Blob/disk→R2 + re-key | object movement | M.7 |
| Rebuild lost workflow (ERP-creation, SLA, new-customer intake) **if required** | net-new feature build on NEW stack | M.4 — cannot lift OLD code (M.3.2) |
| Role/depot→region mapping + user re-provisioning | config + admin | M.5 |
| Secret rotation + history purge (both repos) | security remediation | M.3.3 / M.6 |
| Fix NEW BUG-1 (rate limiter) + H-1 (manager BOLA) before scale | code fix | M.6 |
| Freeze OLD archive + rollback plan on Neon branch | ops | M.9 |

---

## M.11 CONFIRMED FACTS vs INFERENCES vs UNVERIFIED vs MISSING
- **CONFIRMED FACTS:** version/stack deltas; OLD committed `.env` + NEW committed pilot creds (`git ls-files` spot-checked both); OLD never writes CustomerMaster; identifier fields (`temixCode` vs `nmwcCode`); OLD flat vs NEW Customer+Branch+taxonomy (schema spot-checked `CustomerMaster` cols); enum-vs-String; role-set divergence; NEW DB CHECK/trigger invariants; no ERP integration in either; NEW backup/restore-drill automation; NEW BUG-1/H-1 live defects.
- **REASONABLE INFERENCES:** NEW is the only viable base (from maturity + system-of-record + deployability evidence); OLD workflow history is best archived not migrated; Depot→Region needs business mapping.
- **UNVERIFIED ASSUMPTIONS:** whether NEW `nmwcCode` (= import `cust_code`) equals OLD `temixCode` — **the single highest-leverage unknown**; actual live row counts in either DB; whether OLD prod runs Postgres or SQLite (env says SQLite, schema says Postgres — `old-arch.md` B.5); whether OLD data in `dev.db` is real or seed.
- **MISSING INFORMATION (how to verify):** (1) Sample-join OLD `CustomerMaster.temixCode` against NEW `Customer.nmwcCode` to confirm/deny code equivalence (resolve M.1.1 first). (2) Read OLD prod Vercel `DATABASE_URL` to confirm the real datastore. (3) Obtain the ERP (Temix) authoritative customer list to anchor reconciliation. (4) Confirm OLD photo storage backend actually in use (Blob vs disk) and volume for the R2 re-host estimate.
