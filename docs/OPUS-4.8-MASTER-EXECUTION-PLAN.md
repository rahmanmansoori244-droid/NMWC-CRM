# NMWC Unified CRM — Master Production-Readiness & UAT Execution Plan

**Author:** Fable 5 (Chief Production-Readiness Architect / QA Director / Deployment Strategist / Security Architect / Business-Process Auditor)
**Audience / Executor:** Opus 4.8
**Status:** PLANNING ONLY — no code was modified, nothing deployed, no DB created, no workbook generated, no defects fixed while producing this plan.
**Grounding:** Every file path, header, command and config below was verified against the repository at commit `a02deb4` on branch `claude/nmwc-crm-consolidation-e10c1e`. Where the written project description disagreed with the code, the **code wins** and the discrepancy is flagged as `[VERIFY]`.

---

## 0. How to read this plan

This document is 25 deliverables followed by the **OPUS 4.8 MASTER EXECUTION HANDOVER**. The handover is the ordered runbook; deliverables 1–24 are the reference material it points into. Opus 4.8 should execute the handover top-to-bottom, consulting the numbered deliverables as each step references them, and must **stop** at any STOP condition.

### 0.1 Three environments (non-negotiable separation)

| Env | Name | DB | R2 | Secrets | Purpose |
|---|---|---|---|---|---|
| **A** | Local / automated | ephemeral Neon *schema-only* branch, auto-expiring | mocked / none | test-only in a gitignored `.env` | unit, property, DB, service, API, server-action, static-security, migration tests, generator |
| **B** | Online UAT | **dedicated** Neon branch, no prod data | **dedicated** test bucket | UAT-only, distinct from prod | full online deployment, browser/role/mobile/cron/perf tests, UAT sign-off |
| **C** | Production | live Neon (`ep-sweet-haze-aq6nra0j`) | `nmwc-photos` | prod (owner-rotated) | **later, gated** controlled go-live only |

### 0.2 ERRATA — corrections after an independent adversarial red-team of this plan

An independent 3-critic red-team reviewed this plan against the code and found real defects in the **first draft**. All are verified true and corrected here; the corrections **override** any contradicting text elsewhere in the document. Executor: read these before Stage 1.

- **E1 (safety, was dangerous):** The draft called `npm run db:synthetic:reset` a "scoped synthetic-prefix wipe." **False and dangerous.** It is an unguarded `TRUNCATE … CASCADE` of every table with **no endpoint guard** (`prisma/synthetic.ts:76-90`) — a mis-set `.env` destroys production. Treat it as a **STOP CONDITION**; run only after an endpoint-abort check, Env A/B only. `scripts/wipe-synthetic-data.ts` is the only prefix-scoped wipe. (The sibling `docs/OPUS-QA-EXECUTION-PLAN.md` already flags this as its C5 stop condition — this plan now reconciles with it.)
- **E2 (data integrity, go-live):** The **CREATE / full-upsert** import lane defaults an absent/unrecognized payment-terms column to **CASH** (`imports.ts:676`, applied at `:968`); only the **refresh** lane is presence-aware (`:1033`). The first real-master import is a CREATE. **No synthetic test can catch this** (the workbook uses the matching header by construction). Every import "✓" and RK-4's "guarded" status are **conditional on the real Temix header row**. **Go-live step (add to §21):** obtain the real header row FIRST, diff it against the `imports.ts` alias lists, and reject blank/absent terms on the initial import (require explicit CASH/CREDIT per row) before any bulk load.
- **E3 (false gate):** `scripts/qa/constraint-smoke.ts` **only `console.log`s** missing invariants (line 60) and **exits 0** — it does not fail. Treating a 0 exit as "invariants present" (§7.2/§8.5/§24) is wrong. The gate must **add an assertion to the script** (exit non-zero when `MISSING_partialUnique` is non-empty or any expected CHECK/trigger is absent), or a human must read the printed VERDICT and confirm zero MISSING. Do not automate on exit code alone until the script asserts.
- **E4 (under-credited coverage):** The Deliverable-2 matrix marks R30 (SLA) and several approval requirements as ✗/net-new, but `tests/unit/working-hours.test.ts` **and** `tests/unit/approval-engine.test.ts` **already exist**. Before building "net-new" tests in Stage 4, **read those two files** and only fill genuine gaps (likely R13 SoD-puppet, R14 frozen-chain, R16 loop-guard, R17 FM/GM-amend, R19 finalize-after-approval, and an *independent* SLA cross-check) — do not rebuild existing coverage.
- **E5 (executability boundary):** ~9 of 14 stages need **human-provisioned resources** the agent cannot create unattended — there is no in-repo Neon branch-creation path (`print-required-secrets.ts` only *names* `NEON_API_KEY`/`NEON_PROJECT_ID`), and the R2 test bucket, Vercel UAT project, and Sentry UAT env are equally human-gated. The handover's "run top-to-bottom" framing is aspirational past Stage 1. **Partition:** Stages 1 + the DB-free parts of 3/4 are agent-autonomous; Stages 2, 5, 6, 7, 9, 10, 12 are **human-blocked** and each must gate on a named handoff artifact (branch endpoint, bucket name, Vercel project id) a human supplies first. See the revised handover note.
- **E6 (unfalsifiable gate):** §24 "performance is acceptable" has **no numeric SLO** — it cannot be evaluated. Replace with owner-agreed thresholds (e.g. `/customers` list p95 < X ms at 3,300 customers; promote of the full master completes < the function `maxDuration` or is chunked). Until the owner sets numbers, mark this gate **OPEN**, not passable.

**Priority correction:** the two things that actually gate the pilot are **E2 (real-header/CASH-default)** and **RK-3 (chunked/resumable import for the ~3,300 real master)** — build/verify these FIRST; defer the 25k-customer volume runs and the full ~94-row what-if matrix (especially the guessed-header TMX rows) until after a conditional-go pilot and after the real Temix headers are confirmed.

**Hard rules for the whole programme (carry into every step):**
- Never write to Environment C. Never reset the shared/parent Neon role password. Every QA/UAT script must hard-abort if `DATABASE_URL` contains `ep-sweet-haze` (pattern already used by `scripts/qa/probe-db.ts`).
- Prove isolation before any write (endpoint check + zero-PII row counts + migration fingerprint) — reuse `scripts/qa/probe-db.ts` and `scripts/qa/constraint-smoke.ts`.
- Never expose secrets in logs, screenshots, evidence, or fixtures. The clipboard→PowerShell credential technique (used earlier this session) keeps passwords out of output.
- Environment B being online is **not** authorization to deploy C. C requires the §24 gates + explicit owner approval.

---

## Deliverable 1 — Verified repository architecture

Stack (verified `package.json`): Next.js **15.5.18** (App Router, RSC + Server Actions), React 19, TypeScript 5.6, Prisma **6.19.3** on PostgreSQL/Neon, Auth.js v5 beta (`@auth/prisma-adapter`), Cloudflare R2 via `@aws-sdk/client-s3`, `exceljs`, `@faker-js/faker`, Vitest 2, Playwright, Sentry, `bcryptjs`, `pino` logger.

### 1.1 Surface map (verified files)

| Area | Entry point(s) | Notes |
|---|---|---|
| Auth gating | `middleware.ts` + `auth.config.ts` (`authorized` callback) | Matcher `/((?!_next/static|_next/image|favicon.ico).*)`; `if (!auth) return false`. Next 15.5.18 patched vs CVE-2025-29927. |
| App group guard | `app/(app)/layout.tsx` | `auth()` + `redirect('/login')` for the whole group. |
| Pages (26) | `app/(app)/**/page.tsx`, `app/(auth)/login/page.tsx` | work, approvals, approvals/[id], customers(+[id]/edit/new), reactivations, rejected, duplicates, import(+[batchId]), export, temix, notifications, audit, routes, team, users, dashboard, home, today, profile(+change-password). |
| API routes | `app/api/{auth/[...nextauth], health, perf-probe, exports/customers, photos/{presign,finalize,[id]}, cron/{keep-warm,photo-gc,sla-escalate}}/route.ts` | health: public `{status:ok}`, detailed behind `HEALTH_BEARER`. crons behind `CRON_SECRET`. |
| Roles | `enum Role` in `prisma/schema.prisma` | SALESMAN, SUPERVISOR, ACCOUNTANT, FINANCE_MANAGER, GM, MANAGER, STEWARD, VIEWER (8). |
| Permissions | `lib/permissions.ts` | `canActOnStep`, `canMutateUser`, `MANAGER_ADMINISTRABLE_ROLES` (allowlist), `isAdmin`. |
| Scope | `lib/access.ts` | `loadScope`, `canSeeCustomer`, `filterBranchesByScope`, `assertCan*`; MANAGER/ACCOUNTANT fail-closed on empty region. |
| List/export scope | `lib/customer-filters.ts` | `customerListBranchScope` (fail-closed helper), `applyCustomerFilters`, `mergeStringIn`. |
| Approval engine | `lib/approval-chains.ts` + `services/edits.ts` | `resolveChain`, `parseChain`, `resolveRejectTarget`, `isFinalStep`, `stepDeadline`, `CHAIN_VERSION=1`. |
| CREATE | `services/creates.ts` + `lib/create-finalize.ts` + `lib/create-guards.ts` | net-new customer/branch draft + finalize + code allocation. |
| UPDATE / approve / reject | `services/edits.ts` | `submitEditCore`, `approveEditCore`, `rejectEditCore` (guarded `updateMany` atomic-claim). |
| Reactivation / close | `services/reactivations.ts` | Manager-only reactivation; `WRONG_LANE` guards in the generic engine. |
| Duplicates / merge | `services/duplicates.ts` | `findDuplicateCandidates`, `mergeCustomersCore` (sorted `FOR UPDATE` + liveness recheck + 20s tx). |
| Import (master + accounts) | `services/imports.ts` | `uploadCustomerMasterAction`, `promoteCustomerBatchAction`, `uploadAccountMasterAction`. |
| Export | `services/customer-export.ts`, `services/exports.ts`, `app/api/exports/customers/route.ts` | filtered xlsx export. |
| Temix | `services/temix.ts`, `lib/temix.ts` | outbound batch build/upload/complete, inbound refresh, `resolveArchiveTemixState`. |
| Excel | `lib/excel.ts` | `parseWorkbook` (`MAX_TOTAL_ROWS=50k`), `buildWorkbook` (formula-escape). |
| SLA / working hours | `lib/working-hours.ts`, `lib/approval-chains.ts:stepDeadline`, `app/api/cron/sla-escalate/route.ts` | TZ +240, WORK_DAYS `0,1,2,3,4,6` (Sat–Thu, Fri off), 08–17. |
| Notifications | `lib/notifications.ts`, `services/notifications*.ts` | in-app `Notification` rows; **no external mailer wired** (verified). |
| Photos / R2 | `services/photos.ts`, `lib/r2.ts`, `app/api/photos/*` | presign/finalize/attach/detach; `photo-gc` cron. |
| Rate limit | `lib/rate-limit.ts` | memory or PG backend (`RATE_LIMIT_BACKEND`). |
| Audit | `AuditLog` model + writes across services | merge/import/reassign/reject/etc. |
| Schema / migrations | `prisma/schema.prisma`, `prisma/migrations/*` (11 migrations) | partial-unique indexes, CHECK constraints, region-consistency trigger. |
| CI / cron | `.github/workflows/{ci,db-backup,keep-warm,sla-escalate}.yml`, `vercel.json` | CI = typecheck+lint only; backup = pg_dump→R2 `nmwc-backups`. |
| Seed / scripts | `prisma/{seed,synthetic,seed-muscat-*}.ts`, `scripts/*` | see §4/§6. |
| Tests | `tests/unit/**`, `tests/integration/**` (gated), `tests/e2e/login.spec.ts` | runner `scripts/qa/run-with-env.mjs`. |

### 1.2 Challenges to the written description (verify-against-code)

1. `[VERIFY-1]` **Regions.** The description suggests `Muscat, Khaburah, Nizwa, Salalah, Al-Wafi, Duqm`. The actual seed (`prisma/synthetic.ts`) uses `MUSCAT, BATINAH_N, BATINAH_S, DAKHILIYAH, SHARQIYAH, DHAHIRAH` (+1). **Use the schema/seed codes, not the description's names**, or parameterize the generator. Region codes are data, not hardcoded enums, so either set works — pick one and keep it consistent across workbook + seed + assertions.
2. `[VERIFY-2]` **Workweek.** Description says "Saturday through Thursday, Friday excluded." Code default `WORK_DAYS=0,1,2,3,4,6` = Sun,Mon,Tue,Wed,Thu,Sat = **exactly Sat–Thu, Fri off**. Code MATCHES the locked requirement. (Earlier launch docs flagged this as an owner decision; the locked requirement here resolves it — confirm with owner but the default is correct.)
3. `[VERIFY-3]` **Email.** No mailer/provider is wired anywhere — "email disabled" is the current reality, not a config to set. Notifications are in-app `Notification` rows only. The "email kill-switch" step is therefore a **no-op assertion** ("prove no mailer exists"), not a configuration.
4. `[VERIFY-4]` **Banner.** No `SYNTHETIC DATA` banner mechanism exists (grep clean). Opus must **add** a small env-driven banner (see §7.4) — this is the one net-new UI change the UAT setup requires.
5. `[VERIFY-5]` **E2E coverage.** Only `tests/e2e/login.spec.ts` exists. Playwright is configured but coverage is ~nil; the role/workflow browser scripts in §15 are largely net-new.
6. `[VERIFY-6]` **CI.** `ci.yml` runs only `typecheck` + `lint` — it does **not** run tests (integration tests are DB-gated). Do not assume green CI means tested behavior.
7. `[VERIFY-7]` **GM/one-per-role.** The schema allows multiple users per role (no uniqueness on role). Two GM / two FM test accounts are creatable — the description's caveat doesn't bind here.

---

## Deliverable 2 — Requirement → code traceability matrix

Legend: **Cov** = existing automated coverage (✓ committed test / ~ partial / ✗ none).

| # | Locked requirement | Code anchor | Enforcement | Cov | Test method (Env) |
|---|---|---|---|---|---|
| R1 | 8 roles | `enum Role` schema | type | ✓ | assert enum (A) |
| R2 | Cash chain SUP→ACC | `resolveChain` `approval-chains.ts:68` | code | ~ | fixture on resolveChain (A) + e2e (B) |
| R3 | Credit chain SUP→FM→GM→ACC; GM always | `approval-chains.ts:71-77` | code | ~ | fixture (A) + e2e credit walk (B) |
| R4 | UPDATE = SUP; Manager fallback | `parseChain(null)` + `canActOnStep` | code | ~ | integration (A) + e2e (B) |
| R5 | Salesman own route | `access.ts canSeeCustomer SALESMAN` | code | ~ | unit + integration (A) |
| R6 | Supervisor own team | `access.ts SUPERVISOR` | code | ~ | unit + integration (A) |
| R7 | Manager regions; **fail-closed empty** | `access.ts:99`, `customer-filters.ts:customerListBranchScope` | code | ✓ | `tests/unit/customer-list-scope.test.ts` (A) |
| R8 | Accountant regions; fail-closed empty | `access.ts:92,131`, `customerListBranchScope` | code | ✓ | unit (A) |
| R9 | FM/GM org-wide | `approval-chains.ts` scope GLOBAL; `access.ts:77` | code | ~ | integration (A) |
| R10 | Steward = data-gov | `requireSteward` in imports/duplicates | code | ✓ | integration (A) |
| R11 | Viewer read-only | `access.ts VIEWER`, no write actions | code | ~ | e2e negative (B) |
| R12 | Submitter cannot approve | `canActOnStep` self-exclusion | code | ~ | integration (A) |
| R13 | One person ≠ two steps | `canActOnStep` priorStepActorIds | code | ✗ | integration puppet-accounts (A) |
| R14 | Chain frozen at submit | `approvalChain` JSON frozen; queue vs approve authz | code | ✗ | integration mid-chain matrix change (A) |
| R15 | Reject → previous step; first→salesman | `resolveRejectTarget` | code | ~ | integration (A) |
| R16 | Loop guard | `cycle` counter + reject cascade | code | ✗ | integration repeated-reject (A) |
| R17 | FM/GM cannot amend credit figures | edit apply path (owner-confirmed values) | code | ✗ | integration (A) |
| R18 | No double-decision (PROD-001) | guarded `updateMany` count===0 | code | ✓ | `tests/integration/*` pattern (A) |
| R19 | Final materialize only after final approval | `create-finalize.ts` + `isFinalStep` | code | ✗ | integration (A) |
| R20 | Multi-branch model | `Branch` FK to `Customer` | schema | ✓ | schema (A) |
| R21 | Global unique `nmwcCode` | `@unique` schema | DB | ✓ | constraint-smoke (A) |
| R22 | Global unique `branchCode` | `@unique` schema | DB | ✓ | constraint-smoke + `promote-reconciliation` (A) |
| R23 | Exact norm CR dup blocked | `crNumberNorm` + import dedup | code+DB | ~ | `import-reconciliation` (A) |
| R24 | Branch region == route region | trigger `enforce_branch_region_consistency` | DB trigger | ✓ | constraint-smoke + `promote-reconciliation` F-17 (A) |
| R25 | Archive not hard-delete | `deletedAt` soft-delete | code | ~ | integration merge/archive (A) |
| R26 | Optimistic locking | `version` field + increments | code | ~ | integration concurrent-edit (A) |
| R27 | Credit requires limit/terms/guarantee | `create-guards.ts` + CHECK constraints | code+DB | ~ | integration credit-create (A) |
| R28 | Oman GPS bounds | Zod (app-level) + Branch CHECK lat/lng | code+DB | ✓ | constraint-smoke + unit (A) |
| R29 | Approved → Temix sync | `temixSyncState` transitions | code | ~ | `promote-reconciliation` refresh (A) |
| R30 | SLA Asia/Muscat +4, Sat–Thu, 08–17, working-min only | `working-hours.ts` | code | ✗ | **independent fixture** (A) |
| R31 | Temix crosswalk conflict rejected | `imports.ts` promote CROSSWALK guard | code | ✓ | `promote-reconciliation` (A) |
| R32 | Import stage-then-promote atomic claim | `promoteCustomerBatchCore` batch claim | code | ✓ | `promote-reconciliation` double-promote (A) |
| R33 | Formula-injection refused on import | `isFormulaPayload` | code | ✓ | `import-reconciliation` (A) |
| R34 | Phone format validated | `isValidPhoneFormat` | code | ✓ | `import-reconciliation` (A) |

**Coverage gaps to close in Stage 4 (R13, R14, R16, R17, R19, R30, and strengthen R4/R9/R12/R15/R26/R27):** these are the highest-value net-new automated tests.

---

## Deliverable 3 — Risk register

Severity: P0 = launch-stopping, corruption/security with no workaround; P1 = must-fix before go-live; P2 = fix in first patch window; P3 = polish.

| ID | Risk | Area | Sev if unmitigated | Current status | Verify in |
|---|---|---|---|---|---|
| RK-1 | Approval SoD bypass via multi-account puppet | authz | P1 | needs R13 test | Stage 8 |
| RK-2 | Frozen-chain vs current-role authz drift wedges/leaks | approval | P1 | needs R14 test; one known P2 (route re-region wedge) carried | Stage 8/9 |
| RK-3 | Large master promote times out → batch stuck PROMOTING | ops/perf | P1 | **known, open** — chunking not built | Stage 10 |
| RK-4 | Temix inbound absent-column flips CREDIT→CASH | data | P1 | guarded (presence-aware); needs refresh-routing test | Stage 7 |
| RK-5 | Merge/promote/edit lost-update on rollups | integrity | P2 | version lock partial | Stage 8 |
| RK-6 | photo-gc orphans R2 object on tag failure | ops | P3 | known carried | Stage 10 |
| RK-7 | Migrations fail on populated pre-Phase-1 prod schema | deploy | P1 | needs rehearsal on schema snapshot | Stage 13 |
| RK-8 | SLA math wrong under UTC server + Oman calendar | SLA | P1 | needs independent fixture | Stage 4 |
| RK-9 | Cron double-run double-escalates | ops | P2 | escalation guards exist; needs replay test | Stage 8 |
| RK-10 | Real Temix file anomalies not covered by synthetic | data | P1 (residual) | **cannot be closed without real file** | Stage 13 gate |
| RK-11 | Secret leakage (committed pilot creds) | security | P1 | owner rotation pending | Stage 13 |
| RK-12 | GH Actions cron auto-disable (60-day) stops SLA/backup | ops | P2 | known; owner decision | Stage 13 |

The living register is `qa/findings/register.md` + `qa/findings/pre-launch-deep-review.md` + `qa/findings/deep-scan-round2.md` (already in-repo). New findings append there.

---

## Deliverable 4 — Synthetic organization design

**Reuse and extend `prisma/synthetic.ts`** (`faker.seed(20260509)`, idempotent) rather than building new. Extend it to hit the scale below; keep the fixed seed.

> ⚠️ **DESTRUCTIVE-COMMAND CORRECTION (see ERRATA E1).** `npm run db:synthetic:reset` / `prisma/synthetic.ts` `clearSyntheticData()` is **NOT** a scoped wipe — it runs `TRUNCATE TABLE "AuditLog","CustomerEdit","ImportRow","ImportBatch","ExportJob","Attachment","Branch","Customer","Route","Region","User" RESTART IDENTITY CASCADE` (`synthetic.ts:76-90`) with **NO endpoint/hostname guard**. Against a mis-set `.env` it destroys the entire production DB. It is a **STOP CONDITION**: never run it without an `ep-sweet-haze` endpoint-abort check passing immediately before (or add that guard to `synthetic.ts` first). The **only** prefix-scoped wipe is `scripts/wipe-synthetic-data.ts` (synthetic region codes + `MCT-` route prefix + `salesman.` username prefix).

**Target org (Env A seed + Env B seed identical):**
- **Regions:** 6 (use the seed codes `[VERIFY-1]`). Assign every region a Manager and ≥1 region-scoped Accountant.
- **Routes:** ≥30 across regions with the distribution mix in the brief (high/low volume, cash-heavy, credit-heavy, multi-branch-heavy, incomplete, duplicate-risk). Route codes carry a region prefix so region/route consistency (R24) is checkable.
- **Users (≥ the brief's minima):** 40–60 Salesman, 10–15 Supervisor (≥2 per major region), 6 Manager, ≥6 Accountant (region-scoped), 2 FM, 2 GM, 2 Steward, 2 Viewer, **plus explicit edge accounts**: 1 unscoped Manager, 1 unscoped Accountant, 1 disabled user, 1 whose role changes mid-test, 1 Salesman reassigned between routes, 1 Supervisor reassigned between teams. Document each edge account's ID in `USERS_AND_SCOPE`.
- **Passwords:** never in the workbook. Seed via a **separate secure process** — reuse `scripts/bulk-reset-credentials.ts` / the account-master import `reset_password` column in the isolated Env B only, and record credentials in an access-controlled, gitignored store (not the repo).

Deliverable artifact: `USERS_AND_SCOPE` sheet (workbook §5) + a machine-readable `qa/fixtures/org-<seed>.json` the seed and assertions both consume.

---

## Deliverable 5 — Synthetic Excel workbook specification

**Do not invent headers.** The importer column reads are verified below. Two importers exist:

### 5.1 Customer master importer (`uploadCustomerMasterAction` → `promoteCustomerBatchAction`)
Single data sheet; per-row columns (importer accepts the first present of each alias set — verified in `services/imports.ts`):

| Field | Accepted headers | Notes |
|---|---|---|
| cust_code | `cust_code` \| `custcode` \| `CUSTCODE` \| `code` \| `Code` | → `nmwcCode`; mandatory |
| cust_name | `cust_name` \| `CUST NAME` \| `name` | mandatory; `stripHtml` |
| branch_code | `branch_code` \| `CUST BRANCH` | bare code composed to `custcode-branchcode`; blank→positional |
| branch_name | `branch_name` \| `CUST BRANCH` \| `branch` | |
| sales_region | `sales_region` \| `SALES REGION` \| `region` | matched against `Region.code` |
| region_code | `region_code` | |
| route | `route` \| `ROUTE` | matched against `Route.code`; unknown→UNASSIGNED (warn) |
| address | `address` \| `ADDRSS` \| `ADDRESS` | |
| phone | `phone` \| `PHONE` \| `Primary Phone` | `normalizePhone` + `isValidPhoneFormat` |
| contact_person | `contact_person` \| `CONTACT PERSON` | |
| cr_no | `cr_no` \| `CR NO` | `normalizeCR`; exact-dup blocked |
| payment_terms | `payment_terms` \| `PAYMENT TERMS` | whitelist CASH/CREDIT (F-12) |
| credit_limit | `credit_limit` \| `CREDIT LIMIT` | rounded 3dp; ≥0 |
| payment_term_days | `payment_term_days` \| `PAYMENT TERM DAYS` | 0–365 |
| temix_code | `temix_code` \| `temixcode` \| `TEMIX CODE` \| `Temix Code` | crosswalk; conflict→steward review |

`[VERIFY]` The real Temix header row is an **open owner input** (`scripts/qa/generate-synthetic-master.ts` header note). The workbook's `TEMIX_MASTER_VALID` sheet must use the importer aliases above until the owner confirms the real Temix export headers; the plan flags this as a residual (RK-10).

### 5.2 Account master importer (`uploadAccountMasterAction`) — for org seed via Env B
Three sheets by name (`Regions`, `Routes`, `Users`):
- **Regions:** `code`\|`Code`, `name`\|`Name`.
- **Routes:** `code`\|`Code`, `name`\|`Name`, `region_code`\|`regionCode`\|`region`.
- **Users:** `username`, `full_name`\|`fullName`\|`name`, `role`, `password`, `reset_password`\|`resetPassword`, `change_role`\|`changeRole`, `supervisor_username`\|`supervisorUsername`, `route_code`\|`routeCode`, `region_codes`\|`regionCodes` (comma-sep), `email`, `phone`.

### 5.3 Ground-truth workbook (10 sheets) — the deliverable Opus generates in Stage 3
Reuse the deterministic, hash-verified approach already built in `scripts/qa/generate-synthetic-master.ts` (mulberry32 PRNG, `dataSha256`/`manifestSha256`, pinned workbook metadata for reproducibility). Extend it to emit the multi-sheet workbook:
1. **README** — purpose, synthetic warning, seed, version, gen date, expected counts (total/valid/invalid/conflict/duplicate), testing instructions.
2. **TEMIX_MASTER_VALID** — the production-like master in §5.1 format.
3. **CUSTOMERS_GROUND_TRUTH** — per customer: expected disposition (ACCEPTED/QUARANTINED/CONFLICT + reason) — the manifest, already produced per-row by the generator.
4. **BRANCHES_GROUND_TRUTH** — branch↔customer, composed branchCode, expected region/route.
5. **USERS_AND_SCOPE** — org (§4); **no passwords**.
6. **DUPLICATE_CASES** — CR / name / phone / branch / temix-code duplicates with expected outcome.
7. **INVALID_CASES** — missing mandatory, bad format, formula payload, bad GPS, bad decimals/dates, oversized.
8. **CREDIT_CASES** — limit/terms/guarantee + FM/GM/Accountant expected decisions.
9. **SCENARIO_MATRIX** — the §10 what-if IDs and expected outcomes.
10. **EXPECTED_RESULTS** — exact reconciliation totals (counts by disposition; branch counts; created/updated/rejected).

**Scale:** 360–500 customers; 500–750 branches; ≥25% multi-branch; ≥25% credit; ≥10% invalid/problematic; ≥5% archive/deactivation; ≥5% duplicate/conflict. Distribution mix per brief §7. Fixed seed; regenerable; identical `dataSha256` across runs.

### 5.4 Adversarial workbooks (separate files, one defect each)
Missing headers; renamed headers; header not on row 1; wrong sheet name; duplicate headers; extra columns; missing optional; missing mandatory; empty workbook; empty sheet; corrupted zip; very large (>50k rows to hit `MAX_TOTAL_ROWS`); formula-injection; invalid dates; invalid decimals; Arabic/mixed-RTL text; duplicate rows; re-import of a prior file (idempotency). Each has a one-line expected-outcome manifest.

---

## Deliverable 6 — Synthetic data generation design

- **Determinism:** fixed seed; reproducibility contract on canonical **data hash** not zip bytes (exceljs stamps live timestamps — already solved in `generate-synthetic-master.ts` by pinning `wb.created/modified` + hashing cell content).
- **Two consumers, one source:** the generator emits (a) the xlsx for Env B import tests and (b) a JSON seed (`qa/fixtures/*`) for Env A DB seeding, from the **same** ground-truth so import-reconciliation and DB-seed assertions agree.
- **Realism:** faker for names (English/Arabic/mixed), Oman phone formats, CR variants, GPS inside/borderline/outside the Oman envelope, channel/sub-channel valid pairings, visit days, equipment quantities, credit figures, completeness spread.
- **Manifest = ground truth:** every row carries `expectedDisposition` + `requirementRefs` (Rxx) so reconciliation is a machine check, not eyeballing.
- **Wipe/reset (READ ERRATA E1):** `npm run db:synthetic:reset` is an **unguarded full-table `TRUNCATE CASCADE`** (every row in the listed tables) with **no endpoint guard** — treat it as a STOP CONDITION; only ever run it on Env A after an endpoint-abort check confirms the target is NOT production. `scripts/wipe-synthetic-data.ts` is the **only** prefix-scoped wipe (safe for Env B). Verify the endpoint before either.

---

## Deliverable 7 — Environment-isolation plan (Env B)

1. **Neon UAT branch:** create a dedicated branch (schema-only or full-from-a-snapshot — schema-only preferred: zero PII). Endpoint must differ from `ep-sweet-haze`. Put pooled URL → `DATABASE_URL`, direct → `DIRECT_URL`. **Credential handling:** clipboard→PowerShell into a gitignored `.env`; never echo the password.
2. **Provision:** run `prisma migrate deploy` on the branch (NOT `db push` — proven this session to drop migration-only partial indexes/CHECKs). Then `scripts/qa/constraint-smoke.ts` must show all invariants present (40 FK / unique / 12 CHECK / 2 partial-unique / trigger).
3. **R2 test bucket:** a **separate** bucket (not `nmwc-photos`, not `nmwc-backups`). Set `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE`. Lifecycle via `scripts/r2-setup-lifecycle.ts` if applicable.
4. **Secrets (UAT-distinct):** `AUTH_SECRET`(+`NEXTAUTH_SECRET`), `CRON_SECRET`, `HEALTH_BEARER`, `DEMO_ACCOUNTS_DISABLED=true`, `RATE_LIMIT_BACKEND=pg`, `WORK_*`/`SLA_*` (see `.env.example`), Sentry DSN pointed at a **UAT Sentry environment** (`SENTRY_ENVIRONMENT=uat` if wired; else leave DSN unset). Use `scripts/print-required-secrets.ts` as the checklist.
5. **Email:** assert no mailer exists `[VERIFY-3]` — nothing to disable; document "in-app notifications only".
6. **Cron:** point Vercel cron `photo-gc` at UAT; for `sla-escalate`/`keep-warm` (GitHub Actions) either add UAT-scoped workflows or trigger manually with the UAT `CRON_SECRET`. **Never** let a UAT cron hit prod URLs.
7. **Access control:** restrict the UAT URL (Vercel password protection / allow-list / Auth-only). Confirm no prod login works.
8. **Banner `[VERIFY-4]`:** add a minimal env-driven server component in `app/(app)/layout.tsx` rendering `NMWC CRM — SYNTHETIC DATA TEST ENVIRONMENT` when `NEXT_PUBLIC_ENV_LABEL` is set. This is the only net-new UI change for UAT.
9. **Isolation proof (blocking):** run `scripts/qa/probe-db.ts` — endpoint ≠ prod, row counts zero-PII, migration fingerprint captured. Write a `qa/evidence/uat-isolation-gate.json` verdict. If isolation cannot be proven → **STOP**.
10. **Reset & rollback docs:** document the exact reset (`db:synthetic:reset` + wipe) and rollback (redeploy previous commit; restore Neon branch) procedures in `docs/OPERATIONS.md` UAT section.

---

## Deliverable 8 — Online UAT deployment plan (exact ordered steps)

> Do not assume exact Vercel/Neon/R2 CLI beyond what's verified. Where a console/API action is required, the step says so.

1. Create UAT git branch from the reviewed commit; confirm clean `git status`.
2. Record the exact commit SHA to deploy (evidence).
3. Create the isolated Neon branch (console/API); capture endpoint (masked).
4. Populate `.env` (Env B) via the secure credential flow; run `scripts/print-required-secrets.ts` to confirm completeness.
5. `prisma migrate deploy`; then `scripts/qa/constraint-smoke.ts` (all invariants present).
6. Create the R2 test bucket; set lifecycle; smoke a presign/put/get with a throwaway object.
7. Configure Vercel **Preview/UAT** project env vars (all §7.4 secrets) — separate from the prod project, or a distinct env scope so prod vars are untouched. Confirm `regions: iad1` co-locates with the Neon branch region.
8. Configure Sentry UAT environment (or unset DSN).
9. Add the banner env `NEXT_PUBLIC_ENV_LABEL`.
10. Deploy the **production build** (`npm run build` runs `migrate deploy` + `next build`) to the UAT URL.
11. Deployment smoke tests (§8.1).
12. Seed org: `npm run db:synthetic` (or account-master import of the `Regions/Routes/Users` sheets) against Env B; set passwords via the secure process.
13. Import the synthetic master (`TEMIX_MASTER_VALID`) via the UI import → promote flow; capture batch id + `{promoted, failed}`.
14. Reconcile counts/relationships vs `EXPECTED_RESULTS` (must match exactly).
15. Confirm the banner renders.
16. Record the UAT URL + commit SHA in `qa/evidence/uat-deployment.json`.
17. Prove no prod system is connected (endpoint check + a query that would only return prod rows returns zero).
18. Test rollback (redeploy previous commit; app healthy).
19. Test redeploy (deploy current again; healthy).
20. Test DB reset + reseed — **run `scripts/qa/probe-db.ts` first to prove the endpoint is the isolated UAT branch (E1), then** `db:synthetic:reset` (unguarded truncate — Env B only) + reseed; counts back to baseline.

### 8.1 Deployment smoke tests
- `GET /api/health` → `{status:ok}` 200 (public); with `Authorization: Bearer $HEALTH_BEARER` → detailed `db`/`r2` `ok`.
- `/login` renders; a seeded UAT user logs in; `/work` renders scoped data; banner visible.
- One CREATE draft saves; one import batch promotes; one export downloads.
- `read_console_messages` / Sentry: zero errors on the smoke path.

---

## Deliverable 9 — Full test matrix (by stage)

| Layer | Tooling | Env | Representative targets |
|---|---|---|---|
| Static | `tsc --noEmit`, `next lint` | A | zero errors/warnings |
| Unit | Vitest `tests/unit/**` | A | permissions allowlist, list-scope fail-closed, SLA fixtures (R30), completeness, codes, phone/CR |
| Property | Vitest + fast-check (add) | A | code-gen uniqueness/padding, phone/CR normalization round-trips, chain resolution invariants |
| DB/constraint | `scripts/qa/constraint-smoke.ts` | A | FK/unique/CHECK/partial-unique/trigger present |
| Service integration | Vitest gated `tests/integration/**` via `run-with-env.mjs` | A | reactivation authz, import-reconciliation, promote-reconciliation, merge-concurrency (existing) + new R13/R14/R16/R17/R19 |
| API/route | Vitest / supertest-style + direct fetch | A/B | health, exports scope, photos presign/finalize authz, cron secret |
| Server Action | direct invocation w/ mocked `@/lib/auth` + `next/cache` | A | every exported action's authz + happy path |
| Migration | `migrate deploy` on clean + on pre-Phase-1 snapshot | A | applies cleanly; §13 |
| E2E browser | Playwright `tests/e2e/**` (expand) | B | role logins, CREATE/UPDATE/approve, import, export, merge, reactivation |
| Concurrency | parallel action calls | A/B | §12 |
| Performance | k6/Playwright + seeded volumes | B | §13 |
| Failure injection | env/dep manipulation | B | §14 |

Existing committed automated tests to keep green (run all with the four `RUN_*` gates): 160 passing / 4 skipped.

---

## Deliverable 10 — What-if scenario matrix

**Row template (every scenario carries all fields):** `ID | assumption | trigger | preconditions | roles | input | expected system behavior | expected DB state | expected notifications | expected audit | expected Temix outcome | failure indicators | severity-if-fail`.

Encode the full matrix in the workbook `SCENARIO_MATRIX` sheet + a runnable `qa/scenarios/*.ts` harness. Families and IDs (expand each to the template):

- **ORG-01..13** — salesman route move; supervisor team change; manager loses regions; accountant loses regions; new region; route re-region; route deactivated; supervisor absent → manager fallback; FM disabled mid-approval; GM disabled mid-approval; role change after submit; region change after submit; chain config change after submit. (ORG-11/12/13 map to RK-2/R14.)
- **CUST-01..17** — cash→credit; credit→cash; limit up/down; term change; guarantee missing; +1 branch; +10 branches; route change; region change; archive while update pending; archive after batch generated; merge while sync pending; edit after outbound batch; Temix changes before refresh; submit twice; two users create same customer.
- **APR-01..18** — each step approve/reject; first-step reject→salesman; repeated reject loop (R16); same person two stages (R13); submitter approves (R12); two approvers simultaneously (R18); approve+reject race; double-submit; network fail post-approval; finalize fail after code allocation begins (R19); notification-create fail during approval.
- **TMX-01..18** — normal outbound; two Stewards simultaneous batch; customer changes during generation; archive during generation; workbook gen fails; download interrupted; mark-loaded twice; failed batch marked loaded; inbound repeat file (idempotency); inbound missing credit columns (R4/absent-column); shared temix codes; conflicting codes (R31); Temix changes CRM-owned field; Temix changes Temix-owned field; partial import fails; retry import; workbook formulas (R33); malicious cell values.
- **INFRA-01..16** — DB slow; DB interrupted; pool exhausted; R2 down; attachment missing; cron double-run (RK-9); invalid cron secret; email provider down (n/a — assert); Sentry down; app restart mid-workflow; deploy while requests pending; migration half-fails (RK-7); env var missing; SLA values change mid-flight; server TZ ≠ Muscat (RK-8); app/DB different regions.
- **VOL-01..12** — 360; 3,300; 10,000; 25,000 customers; 100 concurrent users; simultaneous approvals; large approval history; large notification inbox; large import; large export; customer with very many branches; many pending SLA breaches. (VOL-02+ target RK-3.)

For each family, the harness asserts DB state + audit rows + notification rows + `temixSyncState` against the manifest. Concurrency/infra scenarios reuse the `parallel()` + `FOR UPDATE`/atomic-claim patterns already validated.

---

## Deliverable 11 — Security test plan

- **AuthN:** unauthenticated probe of every route (expect redirect/401); middleware bypass attempt via `x-middleware-subrequest` (expect blocked on 15.5.18); session fixation after `sessionsRevokedAt` bump; password policy.
- **AuthZ (server-side, per role × per action):** IDOR — pass another scope's editId/customerId/branchId/attachmentId to every action; expect `NotFound` (not Forbidden — avoids oracle). Verify `MANAGER_ADMINISTRABLE_ROLES` allowlist blocks approver create/reset/disable/promote. Verify empty-region Manager/Accountant fail-closed on list **and** export (SR-M2/SR-EXP-01 regressions).
- **SoD / approval:** R12, R13, R14, R18 attacks (puppet accounts, replay, simultaneous).
- **Injection/upload:** formula payloads (R33); HTML/script in every text field (stripHtml); oversized/decompression-bomb xlsx (`MAX_TOTAL_ROWS`); path traversal / key-overwrite on photo presign; cross-user finalize.
- **Secrets:** confirm no committed secret is live in UAT; cron secret required + timing-safe; health detail behind bearer.
- **Data exposure:** exports/dashboards scoped; PII never in URLs/logs/notification text (C16 owner decision); audit reason fields PII-safe.
- **Static:** `/security-review` on the branch diff; dependency review (`npm audit`).

---

## Deliverable 12 — Concurrency test plan

Reuse the proven pattern (parallel action calls against the isolated DB; assert exactly-one-winner + audit-row count). Cases:
- Approval double-decision (R18) — two approvers, one wins, 1 audit row.
- Reactivation double-approve (existing C12) and reject-lane guards (C11/C13).
- Merge reversed-pair (existing PROD-DUP-01) + same-pair double-click.
- Import double-promote (existing) + two Stewards racing the same batch.
- Temix batch: two Stewards generate simultaneously; mark-loaded twice.
- Optimistic-lock: concurrent edit-approve vs Temix refresh on one customer → `VERSION_CONFLICT` (R26).
- Rollup lost-update: concurrent branch add + completeness recompute.
- Rate-limit durability (`checkLimitPg`) under parallel calls.
Every case: `Promise.all` the actions, assert final DB state + audit/notification counts; 20s tx timeout where a lock serializes.

---

## Deliverable 13 — Performance test plan

Seed Env B at graduated volumes (360 → 3,300 → 10,000 → 25,000 customers; 500 → 40k branches) with the generator. Measure:
- p50/p95 for `/customers` list (paginated), search, dashboard, `/work`, `/approvals`, customer detail — with app+DB **co-located** (iad1) per the region fix.
- Import promote wall-clock at 3,300 and 10,000 — **expected to exceed 60s** (RK-3); this quantifies the chunking requirement.
- Export at 25k rows (memory + duration vs `MAX_TOTAL_ROWS`).
- SLA-escalate cron sweep worst-case (many pending breaches) vs `maxDuration`.
- 100 concurrent users (k6 or Playwright workers) on read paths; error rate + latency.
Record numbers in `qa/evidence/perf-*.json`. **Do not claim "N× faster in prod" without measured evidence.**

---

## Deliverable 14 — Failure-injection plan

- DB: kill connection mid-tx (expect rollback, clean error); pool exhaustion; artificial latency.
- R2: bucket unreachable during presign/finalize/gc (expect graceful degrade, no DB corruption; note RK-6).
- Cron: replay same invocation (idempotency); wrong/empty `CRON_SECRET` (expect 401).
- Deploy: deploy mid-request (expect no partial write); migration half-fail on a scratch branch (expect abort, documented recovery).
- Config: unset each required env var one at a time (expect fail-fast, not silent-wrong).
- Time: run app with `TZ=UTC` and assert SLA still computes Muscat working-minutes (RK-8).
Each injection has expected behavior + a pass/fail criterion; failures become findings.

---

## Deliverable 15 — Role-based UAT scripts (Env B, Playwright + manual)

One script per role, each ends with a scope-negative test (attempt an out-of-scope action → blocked). Expand `tests/e2e/`:
- **Salesman:** create cash customer; create credit customer (guarantee upload); enrich; submit; mark closed (photo); request reactivation; see only own route; cannot approve.
- **Supervisor:** review queue (team only); approve/reject an UPDATE; act as first CREATE step; cannot see other teams.
- **Accountant:** finalize cash + credit CREATE (region-scoped); cannot act outside region; empty-region account sees nothing.
- **Finance Manager:** approve/reject credit step org-wide; cannot amend credit figures (R17).
- **GM:** approve/reject credit step; verify always-required (R3).
- **Manager:** region dashboards; UPDATE fallback for Supervisor; manage field-force users only (not approvers); empty-region fail-closed.
- **Steward:** import master; promote; generate Temix outbound; inbound refresh; merge duplicates (incl cross-region confirm flow); cannot approve customer edits.
- **Viewer:** read everything permitted; every mutating control absent/blocked.
Mobile + desktop viewport passes for Salesman + Supervisor (field usage); dark-mode pass.

---

## Deliverable 16 — Defect-classification framework

- **P0** — data corruption/loss, auth bypass, or approval bypass with no workaround; blocks all use. Fix immediately, stop programme.
- **P1** — must-fix before go-live: authz/scope defect, approval-integrity, data-integrity, Temix sync-loss, migration failure, SLA miscalculation.
- **P2** — fix in first patch window: integrity/ops risk with a workaround, UX dead-ends.
- **P3** — polish.
Each defect record: id, title, severity, component, requirement violated (Rxx), evidence (file:line), reproduction, expected, actual, root cause, blast radius, fix, regression test, residual risk. Append to `qa/findings/register.md`.

---

## Deliverable 17 — Independent finding-refutation process

Every candidate defect is verified by **≥2 independent refuters** (fresh context, told to break the finding) across three lenses — accuracy (is the code claim true?), reachability (is there a production-reachable trigger?), impact (does it cause the claimed harm at the claimed severity?). **Confirm only on ≥2/3 non-refuted.** This is the exact multi-agent pattern already run twice this session (`qa/findings/pre-launch-deep-review.md`, `deep-scan-round2.md`); reuse it. Refuters must read the current code (post any interim fixes) so already-fixed items self-refute.

---

## Deliverable 18 — Evidence-retention structure

```
qa/
  evidence/        # isolation gate, deployment record, perf JSON, smoke logs, screenshots
  findings/        # register.md + per-scan findings (pre-launch, round2, uat)
  fixtures/        # generator output (workbook data hash, org JSON, manifests)
  reports/         # readiness verdict, launch checklist, execution tracker
  scenarios/       # runnable what-if harness + per-scenario expected/actual
```
Every stage writes a dated artifact; every claim in the final verdict cites one. Screenshots via Playwright/browser tools; never contain secrets.

---

## Deliverable 19 — Defect-fixing process

1. Confirm (§17) → 2. write a **fail-before** regression test proving the defect on the isolated DB → 3. minimal fix → 4. **pass-after** the same test → 5. `tsc` + `lint` clean → 6. full suite green (all `RUN_*` gates) → 7. commit with the requirement id + fail-before/pass-after evidence in the message → 8. redeploy UAT → 9. rerun impacted stage. Never fix without a fail-before proof. (This is the process already used for C11/C12/C13, the promote P1s, the two deep-scan rounds.)

---

## Deliverable 20 — Regression-testing plan

- Keep all committed tests green every commit (unit always; integration via the four gates against the isolated DB).
- Each confirmed defect adds a permanent regression test; the suite only grows.
- Before any redeploy: full `tsc`/`lint`/`vitest` + constraint-smoke.
- Before the UAT sign-off (Stage 12): a full clean run of the entire suite + the §10 scenario harness + the §11 security pass on the final commit, evidence archived.

---

## Deliverable 21 — Production migration plan (Env C, later)

1. **Rehearse on a snapshot of production's current (pre-Phase-1) schema** — restore a Neon branch from prod, run `prisma migrate deploy`, confirm the 3 Phase-1 migrations apply cleanly on populated data (enum-in-same-tx, NOT-NULL-without-default, backfill `UPDATE`, index-on-existing-dupes) — RK-7.
2. Freeze window; take an off-Neon `pg_dump` backup (the `db-backup.yml` mechanism to `nmwc-backups`).
3. Deploy the reviewed commit to prod (build runs `migrate deploy`).
4. **Real Temix master:** obtain the real file; re-derive the importer header mapping (RK-10); import in **chunks ≤500 customers** (until chunked-promote is built) OR after the chunked-promote lands; reconcile each batch.
5. Verify constraint-smoke on prod post-migrate; verify a smoke CREATE/approve/export.
6. First-day monitoring (§23).

---

## Deliverable 22 — Rollback plan

- **App:** redeploy the previous known-good commit (Vercel instant rollback). Verified in UAT Stage 8.19.
- **DB:** migrations are forward-only; for a bad migration, restore from the pre-migration `pg_dump` backup or Neon PITR (≤7 days) to a new branch and repoint. Document the exact restore command in `docs/OPERATIONS.md`.
- **Data:** archive-not-delete means most mistakes are reversible via `deletedAt`. Merges are auditable (audit `before` payload) but not auto-reversible — document manual un-merge steps.
- Rollback rehearsal is a go-live gate (§24).

---

## Deliverable 23 — Monitoring plan

- **Health:** external monitor hits `/api/health` with `HEALTH_BEARER` for the detailed payload (db/r2 status); public path stays `{status:ok}`.
- **Errors:** Sentry (prod environment) with alerting on new issue types; watch the approval/import/temix paths first-day.
- **Cron:** confirm `photo-gc` (Vercel) + `sla-escalate`/`keep-warm`/`db-backup` (GitHub Actions) actually fire; **RK-12** — set a 30-day reminder or migrate GH crons to Vercel to avoid the 60-day auto-disable.
- **Business signals first-day:** pending-approval aging, SLA breaches, import batch outcomes, Temix sync-state distribution, failed-login rate.
- **DB:** Neon compute/storage; slow-query watch on `/customers` and promote.

---

## Deliverable 24 — Final go-live gates (all must be TRUE)

No open P0. No open P1 in authorization / approval / data-integrity / Temix-sync-loss. All role scopes verified **server-side**. All locked requirements (R1–R34) tested. Migration succeeds from a clean DB **and** from the pre-Phase-1 prod-schema snapshot. Synthetic import **and** export reconcile exactly. Approval concurrency proven. Code allocation proven. Duplicate prevention proven. Archive causes no hard delete. SLA passes independent fixtures. Cron replay safe. Attachments access-controlled. Performance acceptable (or the large-import chunking mitigation in place). Rollback tested. Production isolation maintained throughout UAT. Owner decisions documented (workweek `[VERIFY-2]`, cron infra RK-12, Temix credit-direction, C16/C19). Secrets rotated (RK-11). **Real Temix master obtained and its header mapping confirmed** (RK-10) — required before final data migration. Owner explicitly authorizes go-live.

Verdict values: **Ready** / **Conditionally ready** (list conditions) / **Not ready** (list blockers).

---

# OPUS 4.8 MASTER EXECUTION HANDOVER

**Definition of done:** a signed §24 verdict backed by dated evidence in `qa/`, all committed tests green (all `RUN_*` gates) on the final UAT commit, the full §10 scenario harness executed, the §11 security pass clean, and a written go/no-go recommendation — with production **not** deployed unless every §24 gate is TRUE and the owner approves.

**Global stop conditions (halt and report):** isolation cannot be proven; any write would hit `ep-sweet-haze`; a P0 is found; a migration fails on the prod-schema snapshot; a secret would be exposed; the real Temix file is required but absent for a gated step.

**Required inputs before starting:** owner answers to `[VERIFY-2]` (workweek) and the Temix credit-direction/C16/C19 decisions; access to create a Neon UAT branch + R2 test bucket + Vercel UAT project; the real Temix master (only for Stage 13+).

**Execution order (each stage gates the next):**

1. **Stage 1 — Baseline (A):** `tsc --noEmit`; `next lint`; `vitest run` (unit); `npm run build`; `npm audit`; review existing tests. Evidence: `qa/evidence/baseline-*.txt`. Gate: zero errors.
2. **Stage 2 — Isolation (A):** create ephemeral Neon branch; `.env` via secure flow; `migrate deploy`; `constraint-smoke.ts`; `probe-db.ts`. Gate: isolation proven → `qa/evidence/isolation-gate.json`. STOP if not.
3. **Stage 3 — Generator (A):** extend `scripts/qa/generate-synthetic-master.ts` to emit the 10-sheet workbook (§5.3) + adversarial files (§5.4) + org JSON (§4); assert deterministic hashes, counts, relationships. Gate: `EXPECTED_RESULTS` internally consistent.
4. **Stage 4 — Automated tests (A):** run all gated integration suites; **add** the R13/R14/R16/R17/R19/R30 tests and property tests (§9); security static (`/security-review`); migration tests (clean + snapshot). Gate: full suite green; new coverage lands.
5. **Stage 5 — UAT deploy (B):** execute §7 + §8 fully; smoke (§8.1); seed org; import master; reconcile vs `EXPECTED_RESULTS`; banner up; isolation re-proven; record URL+SHA. Gate: online, reconciled, isolated.
6. **Stage 6 — Roles (B):** run §15 role scripts (all 8) incl scope-negatives. Gate: every role's scope holds server-side.
7. **Stage 7 — Workflows (B):** CREATE (cash+credit), UPDATE, correction, archive, merge (incl cross-region), Temix outbound+inbound. Gate: each reconciles + audits.
8. **Stage 8 — Adversarial/concurrency (A/B):** §11 + §12. Gate: no auth/approval/integrity bypass survives refutation.
9. **Stage 9 — What-if (A/B):** execute the full §10 matrix via `qa/scenarios/*`. Gate: every scenario's DB/audit/notification/Temix state matches manifest.
10. **Stage 10 — Performance/resilience (B):** §13 + §14 at graduated volumes. Gate: numbers recorded; RK-3 chunking quantified.
11. **Stage 11 — Defect correction:** for each confirmed finding, §17 refute → §19 fix-with-fail-before → redeploy → rerun impacted stage.
12. **Stage 12 — UAT regression (B):** full clean rerun of suite + scenarios + security on the final commit; archive evidence.
13. **Stage 13 — Production prep (C, no deploy):** §21 migration rehearsal on prod-schema snapshot; deployment/rollback runbooks; secret-rotation + backup checklists; real-Temix header mapping; go-live smoke script; first-day monitoring plan.
14. **Stage 14 — Verdict:** compute §24 gates; write `qa/reports/FINAL-READINESS-VERDICT.md` (Ready / Conditionally / Not) with cited evidence; present to owner. **Production deploy only on all-gates-TRUE + explicit owner approval.**

**Required outputs (files):** `qa/evidence/{baseline-*,isolation-gate,uat-isolation-gate,uat-deployment,perf-*}.*`; `qa/fixtures/{workbook + org JSON + manifests}`; `qa/scenarios/*`; `qa/findings/{register,uat-scan}.md`; `qa/reports/FINAL-READINESS-VERDICT.md`; new tests under `tests/`; the UAT banner change; updated `docs/OPERATIONS.md` (UAT + rollback sections).

**Non-negotiables (repeat):** planning-vs-prod separation; never write Env C; never `db push` to provision (use `migrate deploy`); never expose secrets; never claim unmeasured performance; fix nothing without a fail-before test; the real Temix master is required before final data migration and its absence caps confidence (RK-10).
