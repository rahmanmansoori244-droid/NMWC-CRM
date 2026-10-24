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

