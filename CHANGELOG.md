# Changelog

## [Unreleased]

### M0 — Foundation
- Next.js 15 + TypeScript scaffold, NMWC blue brand
- Auth.js v5 credentials provider, JWT sessions, RBAC types
- `/api/health`, pino logger, Sentry config
- GitHub Actions CI; Vercel deploy
- Prisma 6 + Neon Postgres; initial schema (User, Region, Route, Channel, AuditLog)

### M1 — Auth + Users + Routes/Regions
- Manager `/users` admin (CRUD, role-aware form, password reset, enable/disable)
- Manager `/routes` admin (regions + routes; create + enable/disable)
- `/audit` log viewer (last 100 events)

### M2 — Customer + Branch read views
- Schema expansion: Customer, Branch, CustomerEdit, Attachment, ImportBatch, ImportRow, ExportJob
- Salesman `/today` (day-of-visit list + stats), `/customers` (search/filter/paginate), `/customers/:id` (full profile)
- Steward `/import` (Account master + Customer master upload, batch review, promote)
- Synthetic test data generator (95 customers, 115 branches, 8 scenarios)
- Sidebar nav + role-based shells; mobile bottom-tab bar for Salesman

### M3 — Photos via Cloudflare R2
- R2 bucket `nmwc-photos`, S3-compatible token
- `POST /api/photos/presign` (10-min PUT URL, validates kind/mime/size)
- `POST /api/photos/finalize` (HEAD verify + sha256 dedupe, creates Attachment)
- `GET /api/photos/:id` (auth-gated streaming proxy)
- `<PhotoCaptureSlot>` — capture (camera) + client-side compress + retake/remove
- Wired into enrichment form: shop + signboard required per branch + CR per customer + 2 free
- `/api/health` now pings R2

### M4 — Enrichment form (the salesman workhorse)
- `/customers/:id/edit` collapsible sections: Identity, Channel, Contact, per-Branch (Address, GPS, Schedule, Photos, Equipment)
- `<GpsCaptureButton>` — `navigator.geolocation` with accuracy badge
- `<StepperInput>` for equipment counters
- Field-level locks: Salesman cannot edit name or CR on Credit customers (server-enforced)
- Hard duplicate phone block across different customers
- localStorage draft auto-save (debounced 500ms)
- Sticky footer: Save Draft + Submit for Approval

### M5 — Approval workflow
- Supervisor `/approvals` queue with age-colored chips (>72h red)
- `/approvals/:id` side-by-side BEFORE/AFTER diff per changed field
- Approve action: atomic Prisma transaction applies changes, recomputes completeness, writes AuditLog
- Reject with required reason + category dropdown → edit goes to NEEDS_CORRECTION
- Concurrency guard: only one SUBMITTED edit per customer at a time
- Closed-shop reactivation flow with Manager review (`/reactivations`)

### M6 — Dashboards + completeness
- Manager `/dashboard`: KPI strip (7 metrics), daily approval bars (last 30 days), per-region completeness bars, top/bottom routes leaderboards
- Completeness recomputed on every approve and every photo attach

### M7 — Excel export + duplicate review
- `/export` filters page (region, route, status, payment terms, completeness range, updated-since)
- `GET /api/exports/customers` streams xlsx; one row per branch matching import shape
- `/duplicates` detection: exact phone, exact CR, fuzzy name (4-gram Jaccard ≥ 0.7)
- Merge tool: pick winner, branches reassigned to winner, loser soft-deleted, audit logged

### M8 — Production hardening
- In-memory token-bucket rate limits: 5 logins/min/user + IP, 60 form submits/hr/user, 120 photo uploads/hr/user
- Security headers: HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP (lenient v1)
- Operations runbook: `docs/OPERATIONS.md`
- Health check pings DB + R2; reports `degraded` HTTP 503 on failure

### Credit flow, part A (owner decisions 2026-10-11)
- New role **Sales Director**: one for every region, with the GM's access everywhere (read scope, menu, approval queue and review page, e-mail for work at his step, SLA fallback, account import, `verify-load`, go-live account `sales.director`); Steward-provisioned only
- CREDIT new-customer chain (CHAIN_VERSION 2): Supervisor → Sales Director → signed application (the submitting salesman) → Finance Manager → GM → Accountant; requests frozen with the 4-step chain keep it
- Signed-application step: the salesman uploads the customer's signed and stamped credit application from his request's page (`services/signed-form.ts`), within 3 working days (`SLA_SIGNED_FORM_MIN`); nobody approves the step; he may withdraw the request at it
- Send-backs one step at a time: Sales Director → Supervisor, Finance Manager → the signed application, GM → Finance Manager
- New alert `SIGNED_FORM_REQUESTED` (red for the salesman, never e-mailed); "Credit application to print" for his supervisor or the region's Managers; steps named in words on every screen and notification
- Credit documents (`ID_CARD`, `MEMBERSHIP_CERT`, `VAT_CERT`, `TAX_CARD`, `CREDIT_FORM`) handled like CR copies: salesman-only upload, never cached, every view recorded and refused when it cannot be; decisions bound to every one of them
- Schema: `Customer.email`, `EditCustomerDraft.email`, the new enum values (`AuditAction.PRINT` for part C); two additive migrations, deployed first as the foundation

### Credit flow, part B (owner decisions 2026-10-11)
- New-customer form, CREDIT only: the customer's **e-mail** (mandatory, trimmed and lower-cased, an e-mail keyboard) and the **four credit documents** — owner's ID card, membership certificate, VAT registration certificate, tax card — up to 4 pages each, a fresh slot after each page (`CreditDocumentSlots`); the submit gate asks for each, beside it
- The guarantee is **switched off** (`GUARANTEE_REQUIRED_FOR_CREDIT` false, kept): no guarantee slot, no guarantee required; guarantees a returned request carries stay shown, removable and sent again
- Cash requests: no e-mail stored, no credit document; a request switched to cash releases its documents
- Finalize: the required documents are read from the chain frozen on the request (4-step chain: a guarantee; 6-step chain: the four documents and the signed application); every live decision-bound document is bound to the customer and the e-mail copied for CREDIT; a missing document is refused by name
- Launch e2e: the R2 guard of the suite knows the new kinds (the signed-application pages part A uploads were refused at clean-up)

### Credit flow, part C (owner decisions 2026-10-11)
- **Credit application printout** (`/print/credit-application/<request>`): every request detail incl. the e-mail and the requested credit limit and days, each shop with its location, the customer's declaration verbatim from the paper form, the customer's Name / Designation / Signature / Company stamp boxes, and an annex of the request's documents and photos; offered only while the request waits at the signed-application step, linked from the review page's banner
- **Final customer form printout** (`/print/customer/<customer>`), for every customer: both codes, every detail and location, every photo and document (the signed application included), the approval trail, and approver signature boxes (cash: Supervisor, Accountant; credit: Supervisor, Sales Director, Finance Manager, GM, Accountant); linked from the profile and an approved new-customer request
- A4 portrait, English, no app chrome (`app/(print)` layout and `print.css`); the company named in text until a logo is sent
- Every role but the salesman prints, within its own scope (`lib/print.ts` PRINT_ALLOWED); out of scope is the branded 404
- Every print writes a `PRINT` audit row first (ids only; the Steward and, for their regions, Managers read it on /audit), and a print that cannot be recorded is not started; Ctrl+P prints a notice instead of the form; printing the credit application answers the printer's own "Credit application to print" alert
- Customer profile: the customer's e-mail

### Watch and prove (data audit gaps 25, 28, 29, 30; 2026-10-24)
- **Test records flagged:** `isTest` on Customer, User, Route and Region; only the known production test records marked (accounts `zz.test.*`, ZZTEST, ZZTEST-R1, NMWC-2026-000001), nothing deleted; the flag moves only in the owner's maintenance window. Dashboards, `/status` approval figures, the exports, the `/customers` list, the Temix workbook, verify-load and the data checks leave them out; the Steward can include them in an export or the list; a test account sees its own
- **Purge summaries:** every retention rule (periods unchanged, now in `lib/retention-rules.ts`) deletes through one statement that also writes a `PurgeSummary` row (what, how many, date range, counts by category)
- **Ledger seals:** a daily SHA-256 chain over every append-only ledger (`SealRecord`, `seq` keys on AuditLog, EditApproval, ExportJob), copied to R2 under `seals/`; `scripts/ops/verify-seals.ts` names the first mismatch
- **Nightly integrity check:** `/api/cron/integrity-watch` (06:30 Oman) runs twenty named read-only checks, stores their results (`IntegrityCheckResult`), and alerts the Data Steward in-app (switched on by a follow-up commit) and the operators' webhook; results on `/status/integrity`
- **Review fixes:** the status check counts only close and reopen cases (an active customer whose open shops are all suspended follows the rule: listed as information); an errored check never moves the next run's window or baseline; a seal finding alerts once per event (a deletion stays one event though the last seal moves; a mismatch out of the recheck window stays open, never a pass) and every older seal is recomputed in turn (within 28 nights); each seal also watches the rows waiting for the next one; the R2 copies are keyed by chain and seq and the whole of `seals/` is listed; two runs at once report the day already sealed; the Temix tiles leave test customers out like the queue
- **Deploy checklist (gap 29 is NOT closed by this build alone):** until the owner sets `ALERT_WEBHOOK_URL` and the one-line commit switches the in-app alert on (`INTEGRITY_INAPP_ALERTS_ENABLED`, the first working day after this build has served one night and passed smoke), a failing check shows only on `/status/integrity` — OPERATIONS §5k, "Deploy checklist"


### Data audit gaps 31, 37 and 18 (branch `claude/audit-gaps-final`; 2026-10-25)
- **The rules the app keeps, in the database too (gap 31):** fourteen CHECKs (credit figures only on CREDIT; a sub-channel needs a channel; the phone and CR de-duplication keys in their normalisers' shapes; a shop's GPS inside Oman, as a pair, accuracy 0–10,000 m; equipment within its caps) and fourteen foreign keys (the sub-channel pair, creators and editors, import and Temix batches, photos', notifications', requests' and approvals' links), all added NOT VALID, so the migration scans nothing and changes no row; CustomerEdit's customer and shop links go from SET NULL to RESTRICT. Single source `lib/db-rules.ts`; a refused save is answered in the rule's words (`DATA_RULE`). OPERATIONS §5l says what NOT VALID means: an older row that breaks a CHECK cannot be saved again by any path until corrected
- **Older rows counted every night:** the information check `db-rules-older-rows` counts, per rule, the rows a VALIDATE would refuse and names the rules ready for one; `scripts/ops/db-rules-report.ts` gives the same counts read-only on production — **read it before this merges**
- **Frozen with the calendar (gap 37):** every request's approval chain goes through `freezeChain`, close and reactivation included (a reactivation's page now names the Manager step); this build reads the `{ v, calendar, steps }` form and still writes the bare array — **the object form is turned on by its own one-line commit** once this build is production's rollback target (`CHAIN_OBJECT_FORM_ENABLED`, OPERATIONS §4), because the build before reads an object as one Supervisor step; a `WORK_*` or `SLA_*` change is a dated entry in the private operations log
- **Review fixes:** a stored chain that is present but not a chain is refused (`CHAIN_UNREADABLE`, logged), never read as the Supervisor fallback; a step budget that is not a number keeps its step, and `freezeChain` refuses to write one (`SLA_SETTINGS_INVALID`); Temix Generate holds back, named, a queued customer whose record breaks a Customer rule instead of failing the batch for everyone, and Mark loaded names such rows instead of failing in words that name nobody; `db-rules-report.ts` counts the Temix paths apart — finishing every batch generated before the deploy is a precondition (OPERATIONS §5l)
- **Archive and hand-over (gap 37):** archiving a customer closes its unsent drafts with a row each and lists them and its sent-back requests on the SOFT_DELETE row; a request can no longer land on a customer archived a moment earlier; the REASSIGN, disable and route or role change rows record the person's open work (request ids and a photo count)
- **Where a request was raised (gap 18):** `CustomerEdit.routeIdAtSubmit` and `regionIdsAtSubmit`, written once with the SUBMITTED state and frozen by the evidence guard. The dashboard's attribution and a Manager's visibility still follow today's route and region — the owner's open question (04-PENDING A6, A9)
- **Not done:** the migrations were never applied (offline Prisma diff and reading only); the gated suites (`RUN_DB_RULES`, `RUN_ARCHIVE_REQUESTS`, `RUN_REQUEST_SCOPE`) were written, not run; no VALIDATE, no backfill, no uniqueness rule — 04-PENDING A9

### Temix codes unique, CR numbers flagged (owner decisions 2026-10-25; branch `claude/audit-gaps-final`)
- **One live customer per Temix code, kept by the database:** the partial unique index `Customer_temixCode_live_unique` on `upper(btrim("temixCode"))` for live customers with a code (migration `20261025120000_temix_code_unique`; its first statement refuses, in counts only, when live customers already share one — production had none on 2026-10-25). Not describable in `schema.prisma`; CI's drift gate allows it by name
- **A refusal names the holder:** finalize (in the Accountant's code box, nothing approved) and the customer import (the row REJECTED, every lane) answer it with the live customer holding the code, in `temixCodeHolder`'s words (`lib/temix-code.ts` `temixCodeRefusal`, `lib/db-errors.ts` `temixCodeIndexViolated`); any other path gets the rule from `runAction` (`TEMIX_CODE_TAKEN`). The nightly `temix-code-shared` now says the database enforces it
- **Shared CR numbers flagged:** the nightly information check `cr-number-shared` counts the live customers sharing a normalised CR (the duplicates detector's CR key; samples shown as NMWC codes, never the CR) and links to /duplicates
- **Tests:** unit (the migration, the error shapes seen on Postgres 17, the refusal wording, the check and its agreement with the detector, the page link) and `tests/integration/temix-code-unique.test.ts` (`RUN_TEMIX_UNIQUE`, added to CI); the F11 merge and archive suites now set up the shared identity the index still allows (an uncoded customer's customer code held as another's Temix code)

### Prisma 7 (2026-10-25; on 7.10.1 and current main since 2026-11-10)
- **Prisma 6.19.3 -> 7.10.1** (`prisma`, `@prisma/client` and the new `@prisma/adapter-pg`, pinned to one exact version; built on 7.10.0, moved to 7.10.1 once it was two weeks old). No migration changes and no change for users
- **Connection strings:** `schema.prisma` holds none any more. The CLI (`migrate deploy` in the build, `migrate status`, `migrate diff`) reads `DIRECT_URL` from the new `prisma.config.ts`, as `directUrl` did; the app's client runs on `DATABASE_URL` through the Postgres driver adapter (`lib/db.ts`). `DATABASE_URL`, `DIRECT_URL` and the Vercel build are unchanged
- **Pool and TLS settings kept:** `lib/pg-pool-config.ts` turns the Prisma 6 URL parameters (`connection_limit`, `pool_timeout`, `connect_timeout`, `sslmode`, `channel_binding`, `pgbouncer`) into node-postgres options with Prisma 6's defaults (pg's own would wait for ever for a connection). `sslmode=require` now verifies the server certificate; a missing URL can never fall back to localhost
- **Same decisions on errors:** the new error shapes (the SQLSTATE in `meta.driverAdapterError`, a constraint name where `meta.target` listed columns, deadlocks as P2034, P2039, node-postgres's own connection errors) are read by `lib/db-errors.ts` (`sqlStateOf`, `uniqueTargetFields`), so retry-or-reject, "may or may not have been saved", the clashing form field, the seal retry and the operator scripts' error text decide as they did. A promote row refused for a string `meta.target` no longer throws a TypeError
- **The client no longer reads `.env` itself.** Operator scripts and tests build their client as `new PrismaClient({ adapter: new PrismaPg(pgPoolConfig(<guarded URL>)) })`; the scripts production guard accepts only that inline form, and counts `@prisma/adapter-pg` as opening a database
- **CI drift check:** `migrate diff --to-schema … --output drift.sql`, the shadow database from `SHADOW_DATABASE_URL` (CI only)
- **Cold start:** the warm-up runs `SELECT 1`, because `$connect()` no longer opens a connection
- **7.10.1 (2026-11-10):** its `@prisma/config` takes deepmerge-ts 8.0.2 and its CLI mysql2 3.24.4, so prisma, `@prisma/config` and deepmerge-ts leave the `npm audit` list
- **The rules main added since, on Prisma 7:** a CHECK refused on a model write arrives as P2039 where Prisma 6 gave an error with no code, and `dbRuleViolated` did not read it, so a save one of the NOT VALID database rules refuses would have been a 500 again instead of the rule's own words (`DATA_RULE`); it reads it now. The rule is the constraint the database named, never a rule's name in the lines of calling code Prisma quotes in its message outside production (found by the gated suite on its first run on Postgres: it was answered with another rule's words). `Customer_temixCode_live_unique` is listed with the raw-SQL unique indexes, and `scripts/ops/db-rules-report.ts` builds its client with the adapter
- **Checked on a throwaway Postgres 17 (UTC), 2026-11-10:** `tests/integration/db-rules.test.ts` now asserts, for every refusal it provokes (model, raw and many-row writes), that the real error is read as its rule and answered with the rule's words; with CI's 33 gates 60 suites / 472 tests pass; the backup → restore → verify chain passes with the NOT VALID rules; each interactive transaction keeps one connection and its own `nmwc.*` settings (40 at once on a pool of 4)

### zod 4 (2026-10-25; on 4.6.7 and current main since 2026-11-10)
- **zod 3.25.76 -> 4.6.7** (GHSA-mrhx-c7xc-m3w5, fixed in 4.6.6). No change for users: every refusal reads as zod 3 worded it, in the same order and on the same field
- **One door:** `lib/zod.ts` is the only module that imports zod; ESLint refuses the import anywhere else in `app/`, `components/`, `lib/` and `services/`. It installs zod 3's English messages as zod 4's error map and holds the zod 3 rules the forms' messages depend on (`number3`, `int3`, `cuid3`, `uuid3`, `email3`, `nativeEnum3`, `enum3`, `array3`, `string3`, `object3`)
- **No eval under the CSP:** zod 4 compiles object parsers with `new Function` when it may; the policy allows no `'unsafe-eval'` and three client bundles carry a schema, so `lib/zod.ts` sets `jitless` before any schema exists. `tests/unit/zod-jitless-guard.test.ts` runs every such schema with `Function` refusing as a browser under the policy refuses, and proves the ESLint rule runs
- **Held to a record:** `tests/unit/validation-messages.test.ts` compares 3,179 cases (every form, upload, export and sign-in) with the record taken under zod 3.25.76 (`tests/unit/fixtures/validation-messages.zod3.json`, byte-identical since)
- **4.6.5 -> 4.6.7:** a bounded array, set or map is now refused on its count before any element is read (the advisory's fix), and the record type is declared differently (types only). No schema here bounds an array with zod's own `.max()` (`array3`, `cappedArray`), so nothing users see moves — and so zod's fix does not reach them either: `cappedArray` already refused an oversized payload array on its count, `array3` did not
- **Review fix (2026-11-10) — the three lists kept on `array3`** (the signed-form upload's pages, the two users forms' regions): `array3` read every element of a list however far over its cap, which is the advisory's pattern, and on zod 4 it was worse than on main: about six times the CPU, and from about 125,000 issues zod 4 overflows the stack merging them, so the parse threw (a 500, a RangeError in Sentry) where zod 3 refused — reachable by any signed-in salesman with a 400 KB list of page ids. Now a list longer than twenty times its cap (never under 1,000) is refused on its count alone and none of its elements is parsed (1.5 million ids, a 4.5 MB body: about 30 ms, one issue). Up to that ceiling every answer is zod 3's, as the record holds; above it the signed-form upload still says "At most 6 pages." and the users forms show the count's words where zod 3 showed the last bad id's, for a list no form builds. `tests/unit/array3-ceiling.test.ts` drives the three real actions with 200,000 ids
- **Advisories (2026-11-10):** `npm audit --omit=dev` lists 13 packages (0 critical, 1 high, 12 moderate) against 17 on main's lockfile the same day (5 high): zod, prisma, `@prisma/config` and deepmerge-ts are gone. Left: postcss under next (high), nodemailer (kept on purpose), uuid under exceljs, and glob and minimatch under `@sentry/nextjs`'s build plugins — two advisories published after 2026-10-25, not taken here
