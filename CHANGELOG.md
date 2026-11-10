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

### Customer import: CRM fields are fill-only (code review 2026-11-10, finding 1; branch `claude/fix-import-overwrite`)
- **What was wrong:** re-loading a customer sheet replaced what salesmen had collected. For a customer with no Temix code on record (about 3,300 seeded ones), and for every customer when the sheet had no column spelt exactly `temix_code`, the sheet's name, phone, CR number, contact person, channel, shop name, address, visit day and status were written over the record, a shop closed by an approved request was reopened, the credit columns were dropped, and the row read PROMOTED with nothing said.
- **Headings:** matched whatever their capitals, spaces or underscores (`lib/import-headings.ts`); every heading the import does not read is listed at upload and on the batch page; one column under two spellings refuses the file; a sheet with no `temix_code` column is refused, before anything is staged, when it names a customer that has a Temix code on record.
- **Fill-only:** for a customer or shop that already exists the import fills a blank CRM field, never replaces a value on record and never changes an open/closed status (`lib/import-crm-rule.ts`). Route and the Temix-owned fields behave as before; new customers and shops are created as before.
- **The option:** "Overwrite CRM fields from this sheet" — Steward only, per batch, off by default, needs a reason, audited, switched off again when the batch finishes (`ImportBatch.overwriteCrmFields`, migration `20261110100000_import_overwrite_option`, additive). With it on a row loads exactly as before, and every audit row of that load is marked.
- **Before you promote:** a summary counted against the CRM as it is — created, refreshed, filled, kept (or replaced), credit cells not applied and why, rows expected to be rejected (`lib/import-plan.ts`, `lib/import-promote-summary.ts`, `services/import-review.ts`).
- **Row notes:** "CRM value kept" and "Credit not applied", under Loaded with a warning.
- **Not done (owner decision):** a one-off script giving the seeded customers their customer code as their Temix code.
- **Tests:** unit (headings, the rule, the lane decision, the credit reasons, the summary, 22 parity scenarios run through the real promote, the option action, the dialog, the page) and `tests/integration/import-crm-fill-only.test.ts` (`RUN_IMPORT_TESTS`); the launch back-office spec goes through the review at every fresh promote.

### A request's reasons kept apart (code review 2026-11-10, finding 18; branch `claude/fix-request-reason`)
- **The defect:** a request kept one "reason" line (`CustomerEdit.decisionReason`) for three things: the salesman's own reason on a close-shop or reactivation request, the latest approver's reason, and the note on a request closed without a decision. Each writer replaced the one before. The salesman read only the last approver's words (he cannot open the approver's page); an approved request that had been stepped back showed the old rejection sentence under "Decision: APPROVED"; a merge's auto-close replaced the salesman's reason with its own sentence; and the approver of a pending close request was not shown why the salesman asked
- **Three sources now** (`lib/request-reasons.ts`): `CustomerEdit.requestReason`, the requester's own words, written once with the request and frozen by the evidence guard once sent (migration `20261110110000_request_reason`: the guard is its last definition plus one line); `EditApproval.reason`, every decision's reason, as before; `decisionReason`, now only the closure note and a copy of the latest send-back while a request stands sent back — cleared by every approval that moves a request on, by the approval that creates the customer and by the signed-form upload
- **The salesman sees** who sent a new-customer request back, at which step and when, and the earlier reasons of the same round — on the request's page, on Needs correction and (counted) on Work; a sent-back update names the step too. His "Needs correction" and "Signed application sent back" alerts end with the earlier reasons, by step; with one send-back in the round they read exactly as before
- **The approvers see** "Salesman's reason" on every close-shop and reactivation request, pending or decided; the decision box shows only what is current (nothing once approved); the reject form says when the salesman will also read earlier reasons of the round
- **Back-fill (only what is unambiguous; `decisionReason` never changed):** copied for a close or reactivation request whose sealed CREATE audit row carries the reason (sent since 2026-10-12 — this also recovers one a merge overwrote), one still SUBMITTED or APPROVED, and one REJECTED with its own REJECTED decision row. Left NULL: close and reactivation requests in NEEDS_CORRECTION (refused before 2026-10-07, when the reviewer's words replaced the salesman's), REJECTED ones with no REJECTED decision row and no ledger copy, and every update and new-customer request (they have no request-level reason)
- **Rollback:** while `REQUEST_REASON_LEGACY_COPY` is true a submit still copies the salesman's reason to `decisionReason`, where every earlier build reads it, so an Instant Rollback keeps working; turning it off is its own one-line commit (04-PENDING B9.1). After a rollback the OLDER build's nightly `protection-functions` check reports `nmwc_customeredit_evidence_guard` as changed — true of every guard migration, and expected
- **Tests:** unit (the truth tables, every writer through the real services, every screen, the migration's SQL, a structural guard that no page prints `decisionReason` itself); `tests/integration/request-reason-migration.test.ts` (`RUN_REQUEST_REASON_MIGRATION`: the back-fill against 22 rows shaped as the older builds left them, in a scratch database) and `tests/integration/request-reasons.test.ts` (`RUN_REQUEST_REASONS`: the full round trip, a close, a reactivation, a merge, and requests in flight from the older build), both added to CI and run on a throwaway Postgres 17; the launch e2e expectations are edited and listed, **not run**
- **Not done:** the migration has never been applied to UAT or production (a throwaway Postgres only); `CreateCustomerForm.tsx` keeps a "Returned for correction" banner the page no longer feeds (another branch is rewriting that file — 04-PENDING B9.2); whether an earlier reason that a later approval already answered should still be listed for the salesman is the owner's (04-PENDING B9.3: all of the round's are listed)

### Imports and the Temix file (code review 2026-11-10, findings 6, 7, 11, 23, 28 and 30; branch `claude/fx2-imports`)
- **Finding 30 — no stray apostrophe in the Temix upload workbook:** a name, address, contact or shop name starting with `=`, `+`, `-` or `@` used to go into the weekly Temix file as `'@Home …`, and in an .xlsx file that apostrophe is real text. The Temix workbook is now built without the formula escape (`buildWorkbook(…, { escapeFormulas: false })`): its cells are typed text cells, which no spreadsheet evaluates (`lib/excel.ts` `typedTextCell` writes anything that is not text, a number, a boolean or a date as its text, so no formula object can get in). Every other export keeps the escape, and any CSV output would need it. Tests: the workbook bytes are opened as XML and every such cell is a shared string with no formula (`tests/support/xlsx-xml.ts`, `excel.test.ts`, `temix-service.test.ts`); `formula-escape-guard.test.ts` pins that the escape is off in the Temix file and nowhere else
- **Finding 11 — a Temix queue over 5,000 customers no longer stops the flow:** Generate used to refuse ("contact support to split the batch") and nothing in the app could shrink the queue. It now takes the 5,000 customers waiting longest (`temixSyncPendingSince`, an unknown time first; `lib/locks.ts` `lockTemixQueue(tx, limit)` chooses them, then locks them in id order as before), says under the button how many are still waiting, and the Steward presses Generate again for the rest. The confirmation says so before he presses it when the queue is over the cap. The cap is one named constant (`lib/temix-cap.ts` `TEMIX_BATCH_ROW_CAP`); the batch's `EXPORT` row records `moreQueued`. Not changed (owner decision pending): which edits put a customer in the queue. Tests: unit (the oldest go, the rest stay queued, a second Generate takes them; the page's wording; the lock statements pinned) and `tests/integration/temix-queue-lock.test.ts` (the limit picks the oldest on Postgres)
- **Finding 7 — the import no longer creates a second card for a shop under its Temix code:** a sheet built from a Temix extract that lists an app-made customer (NMWC-2026-…, Temix code typed by the Accountant) under that Temix code, with `temix_code` blank or absent, created a new cash customer. Now, before creating any new customer, the promote takes the finalize's advisory lock on the row's customer code and asks the finalize's lookup (`lib/temix-code.ts` `temixCodeHolder`); when a LIVE customer holds it as its Temix code the row is REJECTED naming that customer (`newCustomerCodeHeld`). An archived holder or a branch code is not this rule and is left as it was. "Before you promote" counts such rows as expected to be rejected. New nightly check `customer-code-is-anothers-temix-code` (alert, data group, test records left out) finds any pair made before or by another path. Tests: unit (the service, the summary, the plan, the message, the check's classifier and the registry) and the gated `import-first-temix-code` and `integrity-watch` suites on Postgres
