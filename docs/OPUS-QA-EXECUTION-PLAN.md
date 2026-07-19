# NMWC Unified CRM — Production-Readiness Test & Validation Plan
## Planning + Handover package for Opus 4.8 (execution model)

> **Stage discipline:** this document is *planning only*. No application code, schema,
> migration, test, or config was changed to produce it. It is grounded in a read-only
> verification pass over the actual repository (not the docs); every contradiction
> below carries `file:line` evidence. Opus 4.8 executes; this document tells it how,
> in what order, with what safety rails, and what to treat as already-known landmines.

Repository root (worktree): `C:\Users\abdulr\Desktop\NMWC-CRM\.claude\worktrees\nmwc-crm-consolidation-e10c1e`
Branch: `claude/nmwc-crm-consolidation-e10c1e`

---

## 0. TL;DR for the executor

- The core engine (approval chains, step auth, working-hours SLA, Temix state math)
  is implemented and its **pure logic is unit-tested (~122 tests)**. The **entire
  transactional/service/DB-integrity/e2e surface is effectively untested** — that is
  the bulk of the work.
- **Nine verified contradictions** between claimed protections and real code are listed
  in §2. Do not write tests against the false claims; test the *real* behavior and file
  the gaps as findings.
- **Two hard STOP conditions before any write:** (a) the active DB must be proven to be
  an isolated branch, not the production pilot (~3,300 real customers); (b)
  `prisma/synthetic.ts --reset` **TRUNCATEs every user and customer with no hostname
  guard** — it must never point at production.
- **Candidate P1 defects already surfaced** (Opus must confirm/refute, not assume): the
  reactivation lane can be approved by a Supervisor (bypassing Manager-only), lacks an
  atomic claim, and its reject action lacks state/type guards. See §2 and §7-K.

---

## Deliverable 1 — Verified system map

Grounded architecture (Next.js 15 App Router, RSC + Server Actions; Prisma 6.19 →
PostgreSQL/Neon; Auth.js v5 beta; Cloudflare R2; exceljs; Vitest/Playwright; Vercel +
GitHub Actions cron; Sentry).

**Routing / pages** — `app/(auth)/login`, `app/(app)/*` (customers, customers/new,
customers/[id], customers/[id]/edit, approvals, approvals/[id], work, today, rejected,
reactivations, duplicates, import, import/[batchId], export, temix, notifications,
dashboard, users, routes, team, audit, profile, profile/change-password). Auth layout
`app/(app)/layout.tsx` computes the bell unread-count per render.

**API / cron routes** — `app/api/health`, `app/api/photos/{presign,finalize,[id]}`,
`app/api/cron/{photo-gc,keep-warm,sla-escalate}`. Cron auth via `lib/cron-auth.ts`
(constant-time bearer).

**Server actions (services/)** — `edits.ts` (submit/approve/reject/bulk; UPDATE apply;
Temix re-queue hook), `creates.ts` (net-new submit/draft/resubmit + dup hard-block),
`temix.ts` (generate/download/mark-loaded), `customers.ts` (archive), `imports.ts`
(account + customer upload/promote + Temix refresh), `reactivations.ts` (close /
reactivate request + approve/reject), `duplicates.ts` (detect/merge/dismiss),
`photos.ts` (attach/detach), `users.ts`, `routes.ts`, `saved-views.ts`,
`exports.ts` + `customer-export.ts`, `notifications-actions.ts`.

**Engine / libs** — `lib/approval-chains.ts` (frozen chain matrix + stepDeadline),
`lib/permissions.ts` (`canActOnStep`, `canApproveSpecificEdit`, field locks),
`lib/access.ts` (`loadScope`, `canSeeCustomer`, `filterBranchesByScope`,
`canEditCustomer`, `assertCanAccessAttachment`), `lib/create-finalize.ts`,
`lib/create-guards.ts` (advisory-lock dedup), `lib/working-hours.ts`,
`lib/escalation.ts`, `lib/notifications.ts`, `lib/temix.ts`, `lib/rate-limit.ts`,
`lib/audit.ts`, `lib/codes.ts`, `lib/cr.ts`, `lib/phone.ts`, `lib/completeness.ts`,
`lib/excel.ts`, `lib/customer-filters.ts`, `lib/reference-data.ts`, `lib/db.ts`,
`lib/auth.ts` + `auth.config.ts`, `middleware.ts`, `lib/session.ts`.

**Data** — `prisma/schema.prisma` + 11 hand-written migrations under
`prisma/migrations/`. Seeds/scripts under `prisma/` and `scripts/` (several dangerous —
see §2 and §4).

**Tests (actual)** — `tests/unit/*` (16 files, ~122 tests, all pure), one gated PG
integration test (`tests/integration/rate-limit-pg.test.ts`, **skipped in CI**),
`tests/e2e/login.spec.ts` (3 unauthenticated smoke tests, **not run in CI**),
`tests/loadtest.mjs` (manual, targets the prod URL).

---

## Deliverable 2 — Contradictions & candidate defects (VERIFIED — do not build on the false claim)

Each is confirmed against code. Opus must test the **reality**, not the claim, and
independently confirm/refute the candidate defects before fixing anything.

| # | Claim | Reality (evidence) | Test implication / severity |
|---|---|---|---|
| C1 | `middleware.ts` blocks unauthenticated traffic | next-auth beta ignores a `false` from `authorized` when a custom middleware fn is wrapped; middleware only sets a CSP nonce. Protection rests entirely on per-page `requireSession()` and per-route checks. (`middleware.ts:50-68`, `lib/session.ts:12`, next-auth `lib/index.js` branch order) | Probe **every** `app/(app)/*` page and every API route **unauthenticated**; any page missing `requireSession`/role gate is internet-exposed. **P0 if any hole found.** |
| C2 | No hard-coded passwords; "every committed password is burned" | Live pilot creds hard-coded in ≥4 committed files targeting the prod URL (`scripts/capture-guide-screenshots.ts:13-18`, `capture-steward-screenshots.ts:12`, `synthetic-launch-test.ts:59-62`, `prisma/seed-muscat-pilot.ts:55-117`). `DEMO_ACCOUNTS_DISABLED` covers synthetic names only, **not** `pilot.*`/`ahmed.alndabi`/`c1-…`. | Verify each committed credential is **rejected in production** (proves rotation). **P0** until rotation confirmed. |
| C3 | CI runs the tests, incl. the SEC-C3 limiter regression | `ci.yml` has no Postgres service, no `DATABASE_URL`, never sets `RUN_PG_RATE_LIMIT_TEST=1` → the PG limiter suite is silently skipped. Only the in-memory path (not production) is tested. | Add a Postgres-service CI job; the production denial path has **zero** coverage today. **P1.** |
| C4 | Playwright e2e is configured/covered | No workflow invokes Playwright; suite = 3 unauthenticated smoke tests. Zero authenticated/RBAC/workflow e2e. | Treat e2e coverage as **nil**; build from scratch. |
| C5 | `synthetic.ts` is "idempotent, truncates demo data" | `--reset` runs `TRUNCATE … User, Customer, Region, Route, … RESTART IDENTITY CASCADE` — wipes **all real pilot users + 3,300 customers**, recreates only `admin`. No hostname guard. (`prisma/synthetic.ts:73-105`) | **STOP CONDITION.** Never run against prod. Add a hostname allowlist before use. |
| C6 | `sla-escalate.yml` "mirrors keep-warm exactly" | No empty-secret guard (keep-warm has one) → unset secret fails the run red vs keep-warm's green skip; both hardcode `https://nmwc-cm.vercel.app`. (`sla-escalate.yml:26-29`) | Ops smoke: bearer-GET the **real** deployment `/api/cron/sla-escalate`, assert JSON counters (proves URL+secret alignment). |
| C7 | `maxDuration:30` protects heavy operations | `vercel.json` glob `app/**/*.ts` matches only `route.ts` handlers; all heavy `'use server'` mutations run on the **platform default (10s on Hobby)**. (`vercel.json:5-7`) | Deploy-env timing test on each heavy action; verify effective budget. **P1 scale risk.** |
| C8 | Import promote handles a full ~3,300 master safely | ~6–10 sequential queries per customer → **~20–35k round trips**; batch is claimed `READY→PROMOTING` first, and on timeout **nothing resets it** (only-READY guard blocks retry) → stuck batch + partial promote. (`imports.ts:755-763,823-1045`) | Stress test at 3,000 rows; confirm timeout + stuck-`PROMOTING` + partial state. **P1.** |
| C9 | Temix batch capped at 5,000 rows | Cap counts **customers**; `buildTemixRows` emits one row **per live branch** (~1.7×) → ~8,500 rows, whole workbook in memory → base64 via server-action payload, on a non-`maxDuration` function. (`temix.ts:39`, `lib/temix.ts:118-131`) | Test near-cap multi-branch queue: real row count, memory, payload survival. |
| C10 | Optimistic locking protects all customer/branch writes | Reactivation/close paths flip status via plain `update` — **no `version` check/increment**; also never re-queue `temixSyncState`. (`reactivations.ts:276-312`) | Scope R23 tests to edit-apply/archive/refresh/merge; file reactivation gap. **P2.** |
| C11 | Reactivation is Manager-only | Reactivation edits are created with **`approvalChain` unset** → `parseChain(null)` = single SUPERVISOR step → the submitter's **Supervisor can `approveEditAction`** and reactivate, bypassing `require([MANAGER])`. (`reactivations.ts:103-129`, `edits.ts:705-766`) | **Candidate P1 authorization bypass.** Confirm/refute first. |
| C12 | Reactivation approve is race-safe like edits (PROD-001) | `approveReactivationCore` checks state pre-tx then `update` by **id only** (no atomic claim) → double-approve writes **two REACTIVATE audit rows**. (`reactivations.ts:255-312`) | **Candidate P1 concurrency.** |
| C13 | `rejectReactivationAction` is symmetric/guarded | No `isReactivation` guard, no state guard → can flip an **APPROVED** reactivation to NEEDS_CORRECTION, and can hit **unrelated** BRANCH edits. (`reactivations.ts:333-368`) | **Candidate P1 state corruption.** |
| C14 | R9 "submitter can never self-approve" | Steward/Manager **direct-write** deliberately creates `state=APPROVED` with `submittedById==reviewedById==self`. (`edits.ts:475-506`) | Don't assert "no self-approved rows"; assert direct-write is **only** STEWARD + region-scoped MANAGER, blocked for all else. |
| C15 | R10 "no user acts on two steps" | Enforced **per-cycle only** (`priorStepActorIds` filters on `cycle`). After a cycle bump a prior approver may act again. (`edits.ts:754-757`) | Test within-cycle denial + that every re-submit **bumps cycle** (`resolveCycleOnSubmit`). |
| C16 | R28 notifications never carry PII | NEEDS_CORRECTION body interpolates the **free-text reject reason** (`edits.ts:1429-1435`) — unsanitized; PII guarantee holds only for system-composed fields. | PII sweep must whitelist `EDIT_NEEDS_CORRECTION`; flag reason-passthrough. |
| C17 | R22 has a DB backstop for CR uniqueness | **No unique index on `crNumberNorm` ever existed**; hard-block is app-level advisory-lock + `findFirst` on the CREATE-finalize path only. Import promote + edit-crNumber changes have **no** duplicate-CR defense. (`lib/create-guards.ts:15-21`) | Test advisory-lock races on finalize; test that unguarded paths **can** land duplicate CRs. |
| C18 | Phones are DB-unique (schema comment) | Partial unique **dropped** (`20260510160000`); duplicates allowed and only soft-logged. | Do **not** test duplicate-phone rejection; test that duplicates are allowed + logged. |
| C19 | Region/Route mutations are audited | `services/routes.ts` create/toggle actions write **no** AuditLog rows — org-structure changes (which feed scoping + the B-19 trigger) are forensically invisible. | Audit-completeness test with an explicit exclusion list; mark routes.ts as a **defect to fix**. |
| C20 | photo-gc is recoverable (7-day R2 lifecycle) | If R2 tagging fails, the DB row is **still deleted** → permanently orphaned object (never tagged, no row to retry). (`photo-gc/route.ts:55-66`) | Chaos test with R2 down; assert orphan creation. **P2.** |
| C21 | Sentry covers client/server/edge | `sentry.client.config.ts` is **dead code** (no `withSentryConfig` wrapper / no `instrumentation-client.ts`) → browser errors report nowhere. | Don't rely on client Sentry; verify server `onRequestError` path works. |
| C22 | 5 MB import cap is a zip-bomb defense | Cap bounds **compressed** size; `parseWorkbook` fully inflates in memory (no row/decompressed bound). | Adversarial highly-compressible xlsx; assert memory/timeout. Steward-only ⇒ insider-grade. |
| C23 | Enum order in schema mirrors DB | `ALTER TYPE ADD VALUE` appended new values → **DB ordinal order differs** from schema declaration. | Any enum ordinal/sort logic must use explicit app-level rank maps. |
| C24 | Migrations are re-runnable | Only 5/11 are idempotent; `phase1_tables` mixes unguarded + guarded DDL. **`prisma migrate deploy` from empty is the only supported path.** | DR test = deploy-from-empty; rehearse `migrate resolve` for a mid-file failure. |

**DB rules invisible to `schema.prisma`** (must be smoke-tested via `pg_catalog` after
deploy): 2 region-consistency triggers (Branch + EditBranchDraft), 12 CHECK constraints
(GPS ±90/±180, address length ≥3, credit non-neg + 0–365 on Customer & CustomerEdit,
etc.), 2 partial unique indexes (`CustomerEdit_open_per_customer`, `open_per_branch`),
`pg_trgm`/extension, and several SQL-only indexes (`Customer_deletedAt_idx`, etc.).

---

## Deliverable 3 — Synthetic Temix master specification

**Why synthetic:** the real Temix master is unavailable; a synthetic master validates
*system behavior and resilience* but **cannot** prove real Temix header names,
field-ownership rules, or real historical anomalies. That remains an owner sign-off item
(§ Owner decisions).

**Generator architecture** — a single deterministic TypeScript generator
(`scripts/qa/generate-synthetic-master.ts`, to be created) seeded by a fixed integer
(`--seed`, default `424242`), emitting BOTH (a) `.xlsx` workbooks matching the import
contract and (b) a JSON **ground-truth manifest** per dataset describing the expected
disposition of every row (accept / reject-with-code / quarantine / update / skip). No
`Math.random()` without seeding; use a seeded PRNG (e.g. mulberry32). All values must be
unmistakably synthetic (names prefixed `ZZ-SYN`, CRs in a reserved `9xxxxxx` band,
phones `+96890000xxxx`).

**Dataset scales:** (1) **Tiny** deterministic (~20 customers) for debugging; (2)
**Medium** (~300) for service-integration; (3) **Prod-equivalent** (**3,300**); (4)
**Stress** (10,000 and 25,000); (5) **Import/export volume** (a single workbook at the
5 MB edge + a decompression-bomb variant, quarantined for adversarial use).

**Distributions (prod-equivalent target):** ~10 regions, ~40 routes, 1 salesman/route,
1 supervisor/~5 salesmen, 4 managers (each 2–3 regions), 3 accountants (region-scoped),
7 channels × sub-channels; ~70% cash / 30% credit; 85% active / 10% closed / 5%
archived; branch spread 60% single / 25% two / 10% three / 5% four-plus (max 10);
completeness spread; Temix-state spread SYNCED 80% / PENDING_UPLOAD 12% / UPLOADED 5% /
DEACTIVATE_PENDING 3%; a subset with prior approval + audit history.

**Data dictionary (columns to emit; align later to real Temix headers — OPEN):**
`cust_code, cust_name (EN + AR variants), branch_code (= custcode-NN), sales_region,
region_code, route, address, phone, alt_phone, contact_person, contact_role, cr_no,
payment_terms (CASH|CREDIT), credit_limit (3-dp), payment_term_days, temix_code,
channel, sub_channel, day_of_visit, coolers, stands, empty_bottles, gps_lat, gps_lng,
customer_status, temix_sync_state, created_at, updated_at, completeness`.

**Dirty-data catalogue (each row tagged in the manifest with expected outcome):**
duplicate CR (exact + formatting-only), duplicate name, duplicate phone, duplicate
name+phone+region, duplicate branch code, duplicate cust code, shared temix code,
missing temix code, temix-code conflict (code owned by another customer / conflicting
recorded code / archived owner), cash-with-credit-fields, credit-missing-docs, missing
mandatory, invalid payment_terms (`Crdit`), invalid date, >3-dp decimal, negative
credit, absurdly high credit, null / empty / whitespace-only, Arabic + RTL, very long
values, **formula-injection** (`=`,`+`,`-`,`@`), HTML/script, SQL-like, invalid phone,
GPS outside Oman, route-region mismatch, orphan branch, missing/renamed/extra columns,
alternate sheet name, header not on row 1, empty sheet, corrupted workbook, oversized
workbook, "customer updated after batch generated," "archived while pending sync,"
merge winner/loser pairs, re-imported batch, partially-processed batch, failed batch,
repeated mark-loaded.

**Workbook structure variants (for the refresh/import parser):** header on row 1
(happy), header on row 3, different worksheet name, missing required column
(`cust_code`), renamed column (`customer_code`), extra unexpected column, mixed-type
cells (dates as numbers/strings), merged cells, blank leading rows.

**Ground-truth manifest fields per row:** `rowId, inputValues, expectedDisposition,
expectedErrorCode?, expectedResultingState?, requirementRefs[]`. This is what makes the
import/export tests assert *exactly* — Opus compares actual DB state + ImportRow issues
against the manifest, not against re-running the app's own logic.

**Validation of the generator itself:** counts + duplicate-counts + invalid-counts must
match a printed summary; regenerating from the same seed must be byte-identical
(checksum the workbook + manifest).

---

## Deliverable 4 — Environment-isolation plan (MANDATORY pre-write proof)

Opus must **prove isolation before any write** and treat any uncertainty as a full stop.

**Isolation gate (run + record before Phase B write steps):**
1. Assert the runtime `DATABASE_URL` host is a **dedicated QA Neon branch** (or local
   Postgres), never the production endpoint. Record the masked host.
2. Fingerprint check (read-only): the QA DB must carry the Phase-1 migrations **and**
   must **not** be the production pilot. Positive signal used previously:
   `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN
   ('20260715120000_phase1_enums','20260715120100_phase1_tables',
   '20260716100000_notification_temix_kinds') AND finished_at IS NOT NULL` = 3.
   Distinguish prod vs QA by a deliberately-seeded sentinel row
   (`Region.code = 'QA-ISOLATION-OK'`) that Opus inserts as the *first* write and
   asserts on every subsequent run — production will never have it.
3. Assert `AUTH_TRUST_HOST`, test-only `AUTH_SECRET`/`CRON_SECRET`,
   `EMAIL_ENABLED=false` (or a sink), R2 pointed at a **synthetic bucket** or mocked,
   and Sentry DSN unset. Record all as masked.
4. Assert no production credential is present (grep the running env for the known prod
   host / pilot usernames → must be absent).
5. Write the isolation proof to `qa/evidence/00-isolation-proof.json` and refuse to
   proceed if any assertion fails.

**Hard stops:** any DB whose host matches production; any run of `synthetic.ts --reset`
or `wipe-synthetic-data.ts` or `bulk-reset-credentials.ts` without the isolation gate
green; email `EMAIL_ENABLED` not false; R2 not synthetic.

**Backup / reset:** because the QA target is a Neon branch, the reset procedure is
"delete + recreate the branch from the intended baseline" (documented, not scripted
against prod). Never restore *into* production.

---

## Deliverable 5 — Full test matrix

Organized by type. IDs are stable handles for the trace matrix + evidence. Automation:
`U`=vitest unit, `PB`=property-based (fast-check), `DB`=Postgres-integration (real
branch), `SVC`=service-action integration (real branch, auth mocked), `API`=route test,
`E2E`=Playwright authenticated, `SEC`=security probe, `CONC`=concurrency, `PERF`=load,
`FI`=fault-injection, `UX`=manual, `OPS`=operational.

Only the high-value / non-obvious tests are enumerated; the dirty-data catalogue (D3)
expands the import/export rows mechanically via the manifest.

### Unit (extend existing)
- `U-01` working-hours boundary values (08:00/17:00 exact, Thu-eve, Fri, Sat-morning,
  multi-day, zero/negative, degenerate env) — extend `working-hours.test.ts`.
- `U-02` chain matrix incl. **Manager-fallback positive only on the Supervisor step**;
  GM never skipped for credit; frozen-chain immutability.
- `U-03` `resolveCycleOnSubmit` bumps on every re-submit incl. NEEDS_CORRECTION→DRAFT→
  SUBMITTED (C15).
- `U-04` `resolveArchiveTemixState`, `TEMIX_QUEUE_WHERE` shape (deactivate lane ignores
  `deletedAt`), `buildTemixRows` (row-per-branch, credit-only cols, DEACTIVATE = 1 row).
- `U-05` `escalationPlan` all roles/levels; `formatSlaStatus` tones.
- `U-06` `normalizeCR`/`normalizePhone` incl. Arabic-Indic digits; `formatBranchCode`/
  `formatCustomerCode`.
- `U-07` `collectMissingForCreate` full grid (cash vs credit, guarantee docs).

### Property-based (new)
- `PB-01` `slaDeadline` monotonic (later start ⇒ never earlier deadline); minutes-only
  within working windows; idempotent across DST-free year.
- `PB-02` chain resolution: for any (process, terms), GM ∈ credit chain, Accountant is
  always terminal, indices contiguous.
- `PB-03` cycle/loop-guard: `resolveRejectTarget` never loops beyond one back-step per
  cycle for arbitrary reject histories.

### Database integrity (new, real branch)
- `DB-01` `pg_catalog` smoke: assert all 2 triggers, 12 CHECKs, 2 partial uniques,
  extension, SQL-only indexes exist after `migrate deploy` (D2 invisible-rules list).
- `DB-02` B-19 trigger: insert Branch/EditBranchDraft with region≠route.region → raises.
- `DB-03` partial unique `open_per_customer`: two SUBMITTED edits for one customer → P2002.
- `DB-04` GPS CHECKs / address-length CHECK reject out-of-range at DB level.
- `DB-05` credit CHECKs (non-neg, 0–365) on Customer + CustomerEdit.
- `DB-06` `migrate deploy` from **empty** DB succeeds end-to-end; enum values present.
- `DB-07` re-apply safety: confirm which migrations fail on re-run (document, don't fix).
- `DB-08` audit-log immutability posture (no UPDATE/DELETE paths in app).
- `DB-09` CodeSequence atomic allocation: N concurrent finalizes → N distinct codes
  (the advisory-lock probe already proven; formalize it).

### Service-action integration (new, real branch, auth mocked) — the biggest gap
- `SVC-CREATE-*` submit→(each step)→finalize for cash and credit; assert **no live
  Customer/Branch exists before final approval**; code + branchCode allocation; photo
  binding; completeness; audit; notifications; Temix queue entry.
- `SVC-DUP-*` exact-CR + name+phone+region hard-block at submit **and** finalize;
  drafts bypass; unguarded paths (import/edit) can land duplicate CR (C17).
- `SVC-UPDATE-*` field/branch update apply-exactly-once; optimistic-lock conflict;
  cash↔credit conversion forcing the credit chain; Temix re-queue on applied change.
- `SVC-REJECT-*` step-back cascade, first-step → NEEDS_CORRECTION, loop guard, SLA-clock
  reset on advance/step-back/resubmit.
- `SVC-TEMIX-*` generate (flip-first-then-snapshot; concurrent edit not lost),
  download-from-snapshot, mark-loaded (settles deactivate lane, batch-scoped),
  refresh (temix-owned fields only; absent payment_terms keeps terms; crosswalk
  conflicts rejected; UPLOADED→SYNCED guarded; TEMIX_SYNC_ACKED).
- `SVC-ARCHIVE-*` blocks under SUBMITTED edit; tombstones branches; Manager needs ALL
  live branches in-region; DEACTIVATE_PENDING only when Temix-known.
- `SVC-MERGE-*` branch/edit/photo movement; loser deactivation; winner re-queue;
  cross-region confirmation; unauthorized refusal.
- `SVC-REACT-*` **candidate defects C11/C12/C13** — assert Manager-only, atomic claim,
  reject guards. Expected to FAIL today → findings.

### Server-action / API authorization (new)
- `API-01` every `app/(app)/*` page unauthenticated → redirect to /login (C1 probe).
- `API-02` every service action invoked by an unauthorized role directly (not via UI) →
  Forbidden; **hidden buttons are not sufficient** — call the action.
- `API-03` cron routes: missing/invalid bearer → 401; constant-time compare.
- `API-04` photo routes: presign/finalize/read/scope, MIME/extension/kind spoofing,
  cross-customer/cross-region read, unbound-edit-photo access by chain approvers,
  TOCTOU rebind at finalize.

### Security (new)
- `SEC-01` committed-credential rejection in prod (C2). `SEC-02` privilege-escalation
  matrix. `SEC-03` formula-injection round-trip (import parse strips; export escapes).
- `SEC-04` rate-limit denial on the **Postgres** path (C3) incl. fail-closed for
  `login:` vs fail-open for `photo:/edit:`; note exports unlimited (C-exports).
- `SEC-05` user-enumeration + secret-in-logs sweep. `SEC-06` unauthenticated route
  inventory (companion to API-01).

### Concurrency (new, real branch)
- `CONC-01` two approvers same step → one wins (PROD-001). `CONC-02` two final
  Accountants. `CONC-03` two creates same CR / same triple. `CONC-04` approve vs
  direct-write (version). `CONC-05` batch-generate vs approval-apply (no lost change).
  `CONC-06` archive vs batch-generate. `CONC-07` sla-escalate double-fire idempotency.
  `CONC-08` reactivation double-approve (expected FAIL, C12).

### Performance / resilience (new)
- `PERF-01..` p95 thresholds per operation (see D9). `PERF-02` promote at 3,000 rows
  (expect timeout + stuck PROMOTING, C8). `PERF-03` temix generate at cap with
  multi-branch (row inflation + memory, C9). `PERF-04` mark-loaded 5s default (C10-mark).
  `PERF-05` list/detail pages at 25k customers (N+1 + sequential round-trip audit).
  `PERF-06` duplicate detection in-memory grouping at 25k (`duplicates.ts`).
- `FI-01` R2 down at presign/finalize/read/gc (C20, C21-finalize-404). `FI-02` DB pool
  exhaustion. `FI-03` app/DB cross-region latency (already observed ~230 ms/round trip).
  `FI-04` decompression bomb (C22). `FI-05` partial-transaction failure mid-finalize.

### Manual UX / accessibility
- `UX-01..` per-role walkthroughs (D6-N list): forms clarity, validation messages,
  credit-flow, multi-branch, mobile/tablet/desktop, keyboard, screen-reader labels,
  loading/empty/error states, duplicate-submit prevention, SLA visibility, Arabic/RTL.

### Operational readiness
- `OPS-01` deploy-from-empty + smoke. `OPS-02` cron URL+secret alignment (C6).
  `OPS-03` reconciliation report (synthetic import vs export round-trip exact).
  `OPS-04` backup/branch-reset rehearsal. `OPS-05` observability gaps (C21).

---

## Deliverable 6 — Execution phases

For each: **objective / entry / tasks / tools / data / outputs / stop / exit / risk /
code-changes-allowed**. Phases A–O are **read/verify/test only (no app changes)**; P is
the only phase permitting fixes; Q is verdict.

- **A — Discovery & baseline.** Reproduce the system map; run `npm ci`, `typecheck`,
  `lint`, `npm test` (record the ~122 green baseline). *No code changes.* Exit: baseline
  recorded. Stop: build broken.
- **B — Isolated-environment verification.** Execute Deliverable 4 gate; write
  `00-isolation-proof.json`. *No writes until green.* Stop: any isolation assertion
  fails.
- **C — Synthetic master generator.** Build `generate-synthetic-master.ts` + manifests
  for all 5 scales; validate determinism (checksums). *New files under `scripts/qa/` +
  `qa/fixtures/` only — no app changes.*
- **D — Existing-suite baseline + coverage.** Run vitest coverage; publish the real
  coverage map (expect libs high, services ~0). Wire the **skipped PG limiter test**
  into a Postgres run (C3).
- **E — Unit + property-based.** Add U-/PB- tests. *Test files only.*
- **F — DB & migration validation.** DB-01..09; deploy-from-empty; `pg_catalog` smoke;
  re-run safety documentation.
- **G — Role/scope & security.** API-01..04, SEC-01..06 — the full server-side authz
  matrix + the C1 unauthenticated route probe + C2 credential rejection.
- **H — CREATE & UPDATE workflows.** SVC-CREATE/UPDATE/DUP/REJECT against the branch.
- **I — Approval-engine concurrency.** CONC-01..08 (incl. the reactivation FAILs).
- **J — Temix outbound + inbound.** SVC-TEMIX/ARCHIVE/MERGE + the manifest-driven
  refresh/import dirty-data sweep + reconciliation (OPS-03).
- **K — SLA, cron, notifications.** sla-escalate route tests, escalation targeting,
  debounce, PII sweep (C16), cron auth (API-03), C6 alignment.
- **L — Attachments.** API-04 + FI-01 R2 chaos + GC orphan (C20).
- **M — Performance & stress.** PERF-01..06, FI-02..05 at 3.3k/10k/25k.
- **N — UX & accessibility.** UX-01 per role, all viewports.
- **O — Operational readiness.** OPS-01..05; observability; runbooks; DR.
- **P — Defect correction & regression.** *Only phase where app code changes.* Fix
  confirmed P0/P1 in severity order; each fix ships with a regression test; re-run the
  full suite + a targeted adversarial re-review of the changed surface.
- **Q — Final production-readiness verdict.** Evaluate against Deliverable 9 gates;
  produce the report + the explicit owner-decision list.

---

## Deliverable 7 — Opus 4.8 execution instructions (ordered checklist)

Commands below are **verified present** in `package.json`/config unless marked *(create)*.

1. `npm ci` — clean install.
2. `npx tsc --noEmit` (or `npm run typecheck`) — must be clean.
3. `npm run lint` — must be clean.
4. `npm test` — record baseline (~122 pass). *(vitest; unit + integration dirs)*
5. **Isolation gate** (Deliverable 4) → `qa/evidence/00-isolation-proof.json`. **Do not
   proceed to any write step until green.**
6. Point a **dedicated QA Neon branch** DB; `npx prisma migrate deploy`; `npx prisma
   generate`. Verify with the `pg_catalog` smoke (DB-01).
7. *(create)* `scripts/qa/generate-synthetic-master.ts`; generate all datasets +
   manifests into `qa/fixtures/`; verify determinism.
8. Wire + run the **PG rate-limit** test: `RUN_PG_RATE_LIMIT_TEST=1 DATABASE_URL=<qa>
   npx vitest run tests/integration/rate-limit-pg.test.ts`.
9. Execute Phases E→O in order, writing evidence per Deliverable 8. Server-action and
   DB/concurrency suites run **against the QA branch only**.
10. E2E: `E2E_BASE_URL=<qa-preview> npx playwright test` after building authenticated
    journeys *(create)*; or run local `npm run build && npm run start` with
    `AUTH_TRUST_HOST=true` against the QA branch.
11. Collate findings (Deliverable 2 candidates + newly discovered) with the required
    fields (Deliverable 8); run an **independent refutation** on each P0/P1 before
    accepting.
12. **Only after §Q gate review** enter Phase P for fixes. Do not fix during A–O.

Do not invent commands. If a needed command isn't in `package.json`/config, add a script
*(and note it as a change)* rather than guessing flags.

---

## Deliverable 8 — Evidence structure

Create `qa/` (git-tracked, secrets-free) with:
```
qa/
  plan/                 (this plan + any refinements)
  fixtures/             (generated workbooks + JSON manifests — gitignore >1MB xlsx)
  evidence/
    00-isolation-proof.json
    coverage/           (vitest v8 html + text)
    db/                 (pg_catalog smoke output, query plans EXPLAIN ANALYZE)
    perf/               (timings, p95 tables, memory traces)
    security/           (route-probe matrix, authz matrix, credential-rejection log)
    screenshots/        (UX; redact any data)
    logs/               (redacted app logs — NO secrets, NO customer PII)
  findings/
    F-<id>.md           (one per finding, Deliverable 8 field set)
    refutations/R-<id>.md
  reports/
    reconciliation.md   (import↔export round-trip exact match)
    final-readiness.md
```
**Never commit:** secrets, real customer data, generated CR/guarantee documents,
oversized xlsx, or any file containing a live credential.

**Finding record fields (mandatory):** ID, severity (P0–P3/Enh), area, requirement
violated, file+line evidence, reproduction steps, input data, expected, actual, business
consequence, technical root cause, deterministic?, affects-production-data?,
recommended fix, regression tests required, refutation result, final disposition.

---

## Deliverable 9 — Production-readiness gates (objective pass/fail)

Ship only when ALL hold:
1. **Zero open P0.**
2. Zero open P1 in authorization, data-integrity, approval-correctness, or Temix-loss.
3. Every locked requirement (R1–R34) traced **and** tested (Deliverable 2 matrix, no
   MISSING left on a P0/P1 requirement).
4. Every role boundary verified **server-side** (not via hidden UI) — C1 route probe
   clean; no unauthenticated app page; no unauthorized action invocation succeeds.
5. `prisma migrate deploy` from **empty** succeeds; `pg_catalog` smoke passes (all
   triggers/CHECKs/partial-uniques present).
6. Synthetic import↔export **reconcile exactly** against the ground-truth manifest.
7. **No approved change or deactivation can be lost** across the Temix queue→batch→
   refresh cycle (CONC-05/06 + SVC-TEMIX green).
8. **No hard customer delete** anywhere (grep + behavior).
9. SLA fixtures pass **independently-calculated** expectations (not app-derived).
10. Performance within agreed p95 (Deliverable 9 thresholds) at 3,300; documented
    behavior + graceful failure at 25,000 (promote/temix scale ceilings acknowledged).
11. **Production untouched** (isolation proof retained; sentinel intact).
12. Backup/branch-reset, deploy, and rollback procedures rehearsed; committed
    credentials proven rotated (C2).
13. Remaining **business-owner decisions** explicitly separated from technical defects
    (they do not block a *technical* readiness verdict but DO block go-live).

**Suggested p95 targets (QA branch, colocated; tighten on real prod topology):** login
< 800 ms; customer search < 1 s; list/detail < 1.2 s; approval queue < 1 s; create
submit < 1.5 s; final approval < 3 s; temix generate (3.3k) < 20 s or explicit async;
temix download < 5 s; refresh (3.3k) documented; notification inbox < 600 ms; sla cron
< 25 s at 200+200.

---

## Deliverable 10 — Defect classification

P0 Critical: data corruption, production exposure, authz bypass, lost approved change,
irreversible migration failure, secret leak. P1 High: major workflow failure, wrong
approval, duplicate creation, missed ERP sync, wrong credit handling, serious
concurrency defect. P2 Medium: important edge-case failure, misleading workflow,
incomplete validation, operational weakness. P3 Low: usability/maintainability/minor
validation. Enhancement: not a defect but materially improves reliability/UX/perf/audit.

Every finding requires an **independent refutation attempt** before acceptance or
dismissal (spawn a second reviewer told to refute; only majority-survivors stand).

---

## OPUS 4.8 EXECUTION HANDOVER

**1. Ordered execution plan.** Phases A→Q (Deliverable 6). A–O are strictly
read/verify/test (no app-code changes). P is the only phase that edits application code;
Q is the verdict. Within each phase run the mapped test IDs (Deliverable 5), write
evidence (Deliverable 8), and refute every P0/P1 before accepting.

**2. Mandatory safety rules (non-negotiable).**
- Prove isolation (Deliverable 4) and keep the sentinel row before ANY write. Uncertainty
  about the active DB = full stop.
- Never write to production; never use production credentials; never send real email
  (`EMAIL_ENABLED=false` / sink); no uncontrolled R2 writes (synthetic bucket/mock);
  no real customer PII in fixtures/logs/screenshots; no secrets in any artifact.
- **Never** run `prisma/synthetic.ts --reset`, `scripts/wipe-synthetic-data.ts`, or
  `scripts/bulk-reset-credentials.ts` against anything but the proven QA branch (C5).
- Do not fix code before Phase P. Planning/testing only through O.

**3. Files Opus must read first (in order).**
`docs/PROJECT-DESCRIPTION.md` → this plan → `prisma/schema.prisma` →
`prisma/migrations/*` (all 11) → `lib/approval-chains.ts`, `lib/permissions.ts`,
`lib/access.ts` → `services/edits.ts`, `services/creates.ts`, `lib/create-finalize.ts`,
`lib/create-guards.ts` → `services/temix.ts`, `lib/temix.ts`, `services/imports.ts` →
`services/reactivations.ts` (candidate defects) → `lib/working-hours.ts`,
`app/api/cron/sla-escalate/route.ts` → `lib/auth.ts`, `auth.config.ts`, `middleware.ts`,
`lib/session.ts` → `.github/workflows/*`, `vercel.json`, `next.config.ts`,
`vitest.config.ts`, `playwright.config.ts`, `package.json`.

**4. Files/dirs Opus is expected to create.** `qa/` tree (Deliverable 8);
`scripts/qa/generate-synthetic-master.ts`; new tests under `tests/unit/`,
`tests/property/`, `tests/db/`, `tests/integration/`, `tests/e2e/` (authenticated);
a Postgres-service CI job addition (documented as a change). No app-source edits before
Phase P.

**5. Test commands (verified).** `npm ci`; `npx tsc --noEmit`; `npm run lint`;
`npm test`; `npx prisma migrate deploy`; `npx prisma generate`;
`RUN_PG_RATE_LIMIT_TEST=1 DATABASE_URL=<qa> npx vitest run
tests/integration/rate-limit-pg.test.ts`; `npx vitest run <path>`;
`E2E_BASE_URL=<qa> npx playwright test`; `npm run build && npm run start`
(local prod needs `AUTH_TRUST_HOST=true`). Coverage: `npx vitest run --coverage`.

**6. Dataset-generation requirements.** Deterministic seeded generator; 5 scales
(20 / 300 / 3,300 / 10k+25k / volume+bomb); full dirty-data catalogue with a JSON
ground-truth manifest per row (expected disposition + error code + resulting state +
requirement refs); workbook-structure variants for the parser; determinism verified by
checksum; all data unmistakably synthetic.

**7. Definition of done.** All Deliverable 9 gates pass; every finding has an ID,
evidence, refutation result, and disposition; the reconciliation report shows exact
import↔export match; the isolation proof + sentinel confirm production was never
touched; the final readiness report separates technical defects (fixed) from owner
decisions (listed).

**8. Stop conditions.** Isolation gate fails or is ambiguous; the sentinel is missing on
a write run; any command would target the production host; a destructive script lacks a
hostname guard; a P0 authz/exposure is found live (pause, report, do not proceed to
broad writes until scoped).

**9. Reporting format.** Per-finding markdown (Deliverable 8 fields) + refutation file;
phase-level evidence folders; a single `qa/reports/final-readiness.md` with the gate
table (pass/fail per gate), the P0/P1 register, the performance p95 table, the
reconciliation result, and the owner-decision list.

**10. Unresolved owner decisions Opus MUST NOT invent (and cannot close with synthetic
data).**
- The **real Temix importer header row / sheet schema** (`Q-temix-headers`) — the
  synthetic contract is a proxy; real headers, field-ownership rules, and historical
  anomalies require the actual Temix master export for business sign-off.
- **FM/GM SLA hour values** (16h/24h are placeholders).
- **Final escalation chain** sign-off.
- **Email provider + sending domain + SPF/DKIM owner** (delivery stays env-gated off).
- Whether **credit guarantee documents (PDFs)** physically accompany the Temix batch
  and how — they cannot ride an Excel row.
- **Branch-level Temix codes**, Temix **deactivation semantics** (flag vs delete), and
  the **temixCode partial-unique hardening** timing (after crosswalk verification).
- The **branch-code composition** from the customer's real file (full `custcode-branchcode`
  vs suffix) — pending the master upload; affects the import parser's branch-key rule.

Opus must **fix technical defects** and **flag these** — never fabricate the Temix
contract or the owner's business parameters.

---

*End of plan. Grounded in a read-only verification pass; contradictions in Deliverable 2
carry file:line evidence and were confirmed against the code, not the documentation.*
