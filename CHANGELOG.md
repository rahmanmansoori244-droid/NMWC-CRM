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
