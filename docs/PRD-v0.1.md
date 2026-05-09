# NMWC Customer Master Cleanup — Product Requirements Document
**Version:** 0.2 (APPROVED 2026-05-09)
**Date:** 2026-05-09
**Owner:** NMWC project owner
**Status:** PHASE 2 — APPROVED. Phase 3 (UX), Phase 4 (architecture), Phase 5 (build plan) follow.

## Changelog
- **v0.2 (2026-05-09):** Owner approved. Resolutions:
  - O5: Closed-shop **reactivation** flow → requires **Manager** approval (not Supervisor). Salesman submits reactivation with fresh photo evidence; Manager reviews on the dashboard.
  - O6: No email notifications. Instead, a **Work Items** page per user that surfaces pending/rejected/assigned items. See §11 page inventory and §6.5 below.
  - O7: Production domain → use Vercel-provided subdomain for v1 (e.g., `nmwc-cm.vercel.app`); custom domain deferred.
  - O8: Brand = "NMWC" wordmark; primary color **blue** (Tailwind `blue-600` family). Full brand tokens in UX-SPEC.md.

---

## 1. Executive Summary

NMWC operates 38 field sales routes across 7 regions in Oman. The existing customer master (~3,000 records, exported from ERP to Excel) is incomplete and inconsistent — missing GPS, channels, photos, CR documents, and structured contact data.

This application is a **field-driven enrichment tool**. Each route's salesman, during his normal daily market visits, opens his pre-loaded customer list, walks into each shop, and progressively fills in the missing master data fields with photos, GPS, and structured classifications. Submissions flow through a one-step Supervisor approval before becoming part of the live master. The cleaned master can be exported to Excel at any time and re-uploaded to ERP manually.

**v1 is edit-only.** New customer creation in the field is explicitly out of scope.

---

## 2. Scope

### 2.1 In scope (v1)
- Username/password authentication for all roles
- Pre-loaded customer master (imported from Excel)
- Salesman daily customer list with per-customer enrichment form
- Pre-filled forms: existing data shown, only missing/wrong fields editable
- Mandatory photo capture: shop front, signboard, CR document
- Mandatory GPS capture (button-triggered)
- Equipment audit: count of coolers, stands, empty bottles at customer
- Channel & sub-channel classification (7 channels, ~25 sub-channels)
- Day-of-visit, opening hours, delivery window
- Cash vs Credit field rules (name/CR locked for credit customers)
- Edits flow: Salesman → submitted → Supervisor approval → live master
- Rejection flow with reason → "Needs Correction" page for salesman → resubmit
- Supervisor approval queue with side-by-side before/after diff view
- Wrong-route flag and route reassignment by Supervisor
- Closed-shop reporting (with mandatory photo evidence)
- Branch addition to existing parent customers (not new customers)
- Manager (Admin) dashboards across assigned regions
- Data Steward import & deduplication console
- Audit log for every change
- Excel export of customer master (filtered by region/route/status)
- Photo lightbox view in customer profile
- Light offline tolerance: form drafts saved in browser, queued submissions retry when reconnected
- Sentry error tracking, structured logs, daily DB backup

### 2.2 In scope (v1.1, fast follow within ~6 weeks of v1)
- Configurable approval workflow (toggle which fields require approval per role)
- Duplicate-merge tool for Data Steward
- Per-region completeness leaderboards
- Photo compression on device side
- Bulk re-export with field-level filtering

### 2.3 Out of scope (v2 or later)
- New customer creation from the field
- Visit logging, order capture, invoice/payment workflows
- Full offline-first PWA (work fully offline including new records)
- Direct ERP / RoutePro integration (push or pull)
- Native mobile app (Capacitor wrap)
- Geofencing or route-adherence enforcement
- Arabic UI / RTL
- Multi-tenant or multi-country support

---

## 3. Users and Roles

The system has **5 roles** with strict role-based access control. Single login per user. No SSO. Salesman is 1:1 with Route.

| Role | Count (est.) | Primary purpose |
|---|---|---|
| **Salesman** (Route User) | 38 | Field enrichment of customers on his single assigned route |
| **Supervisor** | ~6–10 | Approves edits from his assigned salesmen; flags wrong-route customers for reassignment |
| **Manager** (Admin) | 2 | Owns multiple regions; oversees supervisors; views dashboards; manages user accounts |
| **Data Steward** | 1 (= owner + Claude during build) | Runs imports, resolves duplicates, exports master to Excel for ERP upload |
| **Read-only Viewer** | optional | Management view of dashboards and customer profiles, no edits |

### Hierarchy
```
Country (Oman)
└── Region (×7)
    └── Route (×~38)
        └── Salesman (1:1 with route)

Salesman → Supervisor (1 supervisor per ~5–7 salesmen)
Supervisor → Manager (1 of 2)
```

---

## 4. Permission Matrix

✅ = allowed · ❌ = denied · 👁️ = read-only · ⚠️ = with conditions

| Action | Salesman | Supervisor | Manager | Data Steward | Viewer |
|---|---|---|---|---|---|
| Log in | ✅ | ✅ | ✅ | ✅ | ✅ |
| See own route customers | ✅ | 👁️ (his salesmen's routes) | 👁️ (his regions) | 👁️ (all) | 👁️ (all) |
| See other routes' customers | ❌ | ⚠️ his team only | ⚠️ his regions only | ✅ | 👁️ |
| Edit customer (Cash) — name, CR | ✅ | ✅ (after approving) | ❌ | ✅ | ❌ |
| Edit customer (Credit) — name, CR | ❌ | ❌ | ❌ | ✅ | ❌ |
| Edit customer — other fields | ✅ | ✅ | ❌ | ✅ | ❌ |
| Capture / replace photos | ✅ | ❌ (cannot capture, but can request re-capture by rejecting) | ❌ | ✅ | ❌ |
| Capture GPS | ✅ | ❌ | ❌ | ❌ | ❌ |
| Add new branch to existing customer | ✅ (subject to approval) | ✅ | ❌ | ✅ | ❌ |
| Submit edit for approval | ✅ | n/a | n/a | ⚠️ direct write | n/a |
| Approve / reject submission | ❌ | ✅ (his team only) | ⚠️ override only | ❌ | ❌ |
| Reassign customer to different route | ❌ | ✅ (within his region) | ✅ | ✅ | ❌ |
| Mark customer as Closed | ⚠️ submit only | ✅ approve | ❌ | ✅ | ❌ |
| Import Excel master | ❌ | ❌ | ❌ | ✅ | ❌ |
| Export Excel master | ❌ | ⚠️ his team scope | ✅ | ✅ | ✅ |
| Resolve duplicates / merge | ❌ | ❌ | ❌ | ✅ | ❌ |
| Manage users (create/disable) | ❌ | ❌ | ✅ | ❌ | ❌ |
| Manage routes / regions | ❌ | ❌ | ✅ | ✅ | ❌ |
| View dashboards | own progress | team progress | regional | global | global |
| View audit log | own actions | team actions | regional | global | global |

**Manager note:** Managers can override (force-push edits) only in exceptional cases; every override is audit-logged with mandatory reason.

---

## 5. Data Model — Entities

### 5.1 Core entities (high-level; full schema in Phase 4)

```
User ──┬── owns ──> Route (1:1 for Salesmen)
       └── manages ──> User (Supervisor → Salesman; Manager → Supervisor)

Region ──> Route ──> Customer ──> Branch ──> [Photos, EquipmentCount, GPS]

Customer ──> CustomerEdit (proposed change; pending/approved/rejected)
CustomerEdit ──> CustomerEditField[] (per-field before/after)

Channel ──> SubChannel
Customer ──> Channel + SubChannel

AuditLog (immutable; every state change)
ImportBatch ──> ImportRow ──> Customer (lineage tracking)
```

### 5.2 Key entities and required fields

#### `Customer` (parent legal entity)
- `id` (uuid, PK)
- `nmwc_code` (unique, from Excel; system can issue temp codes for new branches)
- `legal_name` (string)
- `payment_terms` (enum: CASH / CREDIT — set at import, admin only)
- `cr_number` (string, nullable; required to be "complete")
- `cr_photo_id` (FK → Attachment; required to be "complete")
- `channel_id` (FK → Channel)
- `sub_channel_id` (FK → SubChannel)
- `primary_phone` (string; format-validated)
- `alt_phone` (string, nullable)
- `contact_person` (string)
- `contact_role` (string, nullable)
- `status` (enum: ACTIVE / CLOSED / SUSPENDED)
- `notes` (text, nullable)
- `completeness_score` (computed, 0–100)
- `created_at`, `updated_at`, `created_by`, `last_edited_by`
- soft-delete: `deleted_at`

#### `Branch` (one customer → many branches)
- `id`, `customer_id` (FK)
- `branch_code` (auto: `<NMWC_CODE>-<NN>` or from Excel)
- `branch_name`
- `region_id`, `route_id` (FK)
- `address` (text)
- `area_description` (string, nullable)
- `gps_lat`, `gps_lng`, `gps_accuracy`, `gps_captured_at`
- `day_of_visit` (enum: SAT…FRI)
- `opening_hours` (string, nullable)
- `delivery_window` (string, nullable)
- `coolers_count` (int, default 0)
- `stands_count` (int, default 0)
- `empty_bottles_count` (int, default 0)
- `shop_photo_id`, `signboard_photo_id` (FK → Attachment, required)
- `extra_photo_ids[]` (up to 2)
- `status` (enum: ACTIVE / CLOSED / SUSPENDED)
- `completeness_score`
- timestamps + audit fields

#### `CustomerEdit` (the approval-flow record)
- `id`, `customer_id` (or `branch_id`), `submitted_by`, `submitted_at`
- `state` (enum: DRAFT / SUBMITTED / APPROVED / REJECTED / NEEDS_CORRECTION)
- `reviewed_by` (Supervisor), `reviewed_at`, `decision_reason` (required if rejected)
- `field_changes` (jsonb: array of `{field, old_value, new_value}`)
- `attachment_changes` (jsonb: photos added / replaced)
- on APPROVED: changes are applied to `Customer`/`Branch` and `AuditLog` is written

#### `Attachment` (photos & CR documents)
- `id`, `kind` (enum: SHOP / SIGNBOARD / CR / FREE)
- `customer_id` or `branch_id`
- `r2_object_key`, `mime_type`, `width`, `height`, `bytes`
- `captured_by`, `captured_at`, `captured_lat`, `captured_lng` (defense in depth)

#### `AuditLog`
- `id`, `actor_id`, `entity_type`, `entity_id`, `action`, `before` (jsonb), `after` (jsonb), `at`
- append-only; never updated or deleted

#### `Channel`, `SubChannel`
- Seeded from the locked taxonomy (§Appendix A)

#### `Region`, `Route`
- Seeded from the legacy Excel during import; only Manager/Steward can edit

#### `ImportBatch`, `ImportRow`
- Tracks every row imported, its source file, pre-/post-cleanup state, and merge target

### 5.3 Indexing strategy (preview)
- Unique: `Customer.nmwc_code`, `Branch.branch_code`, `User.username`
- Composite: `Branch(route_id, status)`, `CustomerEdit(state, submitted_at)`, `AuditLog(entity_type, entity_id, at DESC)`
- Trigram on `Customer.legal_name` for fuzzy search and import-time dedupe
- Partial: `Branch WHERE deleted_at IS NULL` for the hot-path query

---

## 6. Daily Salesman Workflow

This is the **core flow**. UX must make this take <2 minutes per customer.

```
1. Salesman opens app on phone, logs in.
2. Home screen: "Today's Route" — list of his customers, sorted by Day-of-Visit.
   - Each row shows: branch name, address snippet, completeness % bar,
     status icon (✓ complete / ⚠ partial / ❗ rejected / 🆕 not yet enriched).
3. Salesman walks into a shop. Taps the customer row.
4. Customer Profile opens, prefilled with all known data.
5. Sections (collapsible cards):
   ┌─ Identity ──────────── (locked if Credit)
   ├─ Channel & Classification
   ├─ Contact
   ├─ Location ─── [📍 Capture GPS] button
   ├─ Photos ──── [📷 Shop] [📷 Signboard] [📷 CR] [+2 free]
   ├─ Equipment ── coolers / stands / empty bottles counters
   └─ Schedule ── day of visit / opening hours / delivery window
6. Each editable field has a pencil icon — tap to edit inline.
7. Sticky footer: "Save Draft" (always) and "Submit for Approval" (only when
   completeness ≥ 100% OR a closed-shop flag is raised).
8. On submit:
   - Validations run client + server.
   - Form data + photos uploaded (resumable, retry-on-reconnect).
   - Salesman gets confirmation; customer card moves to "Pending approval" state.
9. Salesman moves to the next shop.
```

### 6.1 Closed-shop sub-flow
Salesman taps the customer's status → "Mark Closed" → mandatory photo of the closed shop → optional reason note → Submit. Goes through Supervisor approval like any edit.

### 6.2 Wrong-route sub-flow
Salesman taps "⚠ Wrong route" → choose reason → Submit. Customer goes to Supervisor "Reassignment" queue. Supervisor picks correct route. Audit-logged.

### 6.3 Add Branch sub-flow
From an existing parent customer, salesman taps "+ Add Branch" → fills branch fields (the Branch section of the form) → Submit. Goes through approval.

### 6.5 Work Items page (replaces email notifications)
Every user gets a `/work` page that lists items needing their attention. Computed on demand from existing tables — no separate notifications table. Filtered by role:

- **Salesman:** Rejected submissions (with reason), customers below 100% completeness on his route, customers due today (by Day-of-Visit).
- **Supervisor:** Pending approvals (oldest first), wrong-route reassignments, stale drafts on his team (>3 days untouched).
- **Manager:** Stale Supervisor approvals (>3 days), reactivation requests from any salesman, override candidates flagged by system, low-completeness regions.
- **Data Steward:** Quarantined import rows, duplicate review queue, photos awaiting GC, failed exports.

Each item has a clear primary action ("Review", "Fix", "Approve") and a one-line context. Badge counter visible in top nav.

### 6.4 Offline behavior
- Form fields are auto-saved to IndexedDB every 5 seconds while editing.
- Photos are stored client-side until reconnected, then uploaded.
- Submissions are queued and retried on reconnect with exponential backoff.
- A clear banner shows offline state and pending sync count.
- **No new customer creation while offline** (and not at all in v1).

---

## 7. Approval Workflow

```
┌────────────┐    submit    ┌────────────┐
│  DRAFT     │ ───────────▶ │ SUBMITTED  │
│ (salesman) │              │ (in queue) │
└────────────┘              └─────┬──────┘
                                  │
                          ┌───────┴────────┐
                          │                │
                       approve           reject
                          │                │
                          ▼                ▼
                    ┌──────────┐     ┌─────────────────────┐
                    │ APPROVED │     │ NEEDS_CORRECTION    │
                    │ (live!)  │     │ (back to salesman)  │
                    └──────────┘     └──────────┬──────────┘
                                                │ resubmit
                                                ▼
                                          (back to SUBMITTED)
```

### 7.1 Supervisor approval queue
- Sorted by: oldest pending first, then by salesman.
- Per-submission view: side-by-side BEFORE / AFTER diff per changed field.
- Photo viewer: tap to enlarge; salesman cannot replace, supervisor can only Approve or Reject.
- Approve: changes applied atomically to Customer/Branch; AuditLog written; salesman notified.
- Reject: mandatory reason (free text + optional category dropdown: bad photo / wrong GPS / missing field / wrong info / other). Salesman notified.

### 7.2 SLA expectations (for dashboards, not enforced)
- Salesman submits during the day (8am–5pm Oman time).
- Supervisor reviews same day or next morning.
- Stale submissions (>3 days) flagged on Manager dashboard.

### 7.3 Concurrency
- A customer with a `SUBMITTED` edit is **locked** for further edits until approval/rejection completes.
- Salesman can save drafts but cannot submit a second proposal on top of one in review.

---

## 8. Validation Catalogue

| Field | Type | Rule | Where enforced |
|---|---|---|---|
| `username` | string | 3–50 chars, alphanumeric + `._-` | client + server |
| `password` | string | min 12 chars, 1 uppercase + 1 digit | client + server |
| `nmwc_code` | string | unique; format `[A-Z]{2,4}\d{3,6}` (legacy) or `NMWC-YYYY-NNNNNN` (system) | server |
| `legal_name` | string | 2–200 chars; HTML stripped; trimmed; not editable on Credit by Salesman | server |
| `cr_number` | string | optional; if present, 5–50 chars, alphanumeric + `-`; auto-normalized (uppercase, strip spaces); not editable on Credit by Salesman | server |
| `primary_phone` | string | required; regex `^[\d\s\-\+\(\)]{7,20}$`; normalized to `+968 XXXXXXXX` for Oman numbers when possible | server |
| `alt_phone` | string | optional; same regex | server |
| `contact_person` | string | 2–200 chars; HTML stripped | server |
| `address` | text | 3–500 chars; HTML stripped | server |
| `area_description` | text | optional; max 500 chars | server |
| `gps_lat` | float | -90 ≤ x ≤ 90; required at submit (not draft) | server |
| `gps_lng` | float | -180 ≤ x ≤ 180; required at submit | server |
| `gps_accuracy` | float | auto-captured by browser geolocation API | client |
| `day_of_visit` | enum | SAT/SUN/MON/TUE/WED/THU/FRI | server |
| `opening_hours` | string | optional; max 100 chars | server |
| `delivery_window` | string | optional; max 100 chars | server |
| `channel_id` | uuid | must reference an active Channel | server |
| `sub_channel_id` | uuid | must reference an active SubChannel **whose `channel_id = customer.channel_id`** (Zod superRefine cross-validation) | server |
| `coolers_count` / `stands_count` / `empty_bottles_count` | int | 0 ≤ x ≤ 100 | server |
| `notes` | text | optional; max 5000 chars; HTML stripped | server |
| `payment_terms` | enum | CASH / CREDIT; only Steward sets at import | server |
| `status` | enum | ACTIVE / CLOSED / SUSPENDED; Closed requires photo evidence | server |
| Photo (any) | file | image/jpeg, image/png, image/webp; max 10 MB raw; auto-compressed to ≤2 MB; min 800×600; EXIF stripped except GPS | server |
| `decision_reason` | text | required if rejecting; 5–1000 chars | server |

### 8.1 Cross-field rules
- Submission to "complete" requires every field marked **mandatory** in §5.2 to be filled.
- Status = CLOSED → at least one photo with kind ∈ {SHOP, SIGNBOARD, FREE} captured within the last 7 days.
- Phone uniqueness: hard-blocked across different *parent customers*; allowed across branches of the same parent. Enforced by partial unique constraint and pre-save check.

### 8.2 Server-side hardening
- HTML stripped from every text input (defense in depth against XSS).
- All inputs Zod-parsed at API boundary; reject early with structured errors.
- Rate-limit: 60 form submissions per salesman per hour, 5 logins per minute per IP.
- File uploads via presigned R2 URL; server validates content-type and re-checks size after upload.
- All writes wrapped in DB transactions; on failure, attachments orphaned in R2 are GC'd by a daily job.

---

## 9. Duplicate Detection (import-time only)

Since v1 has no field creation, duplicate detection runs only when the Data Steward imports an Excel file. Detected during import:

1. **Exact match** on `nmwc_code` → blocks import; row goes to quarantine table.
2. **Exact match** on `(legal_name normalized, primary_phone)` → flagged as candidate duplicate.
3. **Fuzzy match** on `legal_name` (trigram similarity > 0.85) AND same region → flagged as candidate duplicate.
4. **Phone collision** across different proposed parent customers → hard block; review required.

Steward sees a queue of flagged candidates with side-by-side comparison. Actions:
- **Confirm new** (legitimate distinct customer)
- **Merge into existing** (link as branch / update existing / discard duplicate)
- **Reject** (drop the row entirely)

All decisions audit-logged. The merge tool is v1.1 if not finished in v1.

---

## 10. Completeness Scoring

A weighted score, 0–100, computed at write time and stored on `Customer` and `Branch`:

**Customer-level (40 points max):**
- Channel + sub-channel set: 10
- Phone valid: 5
- Contact person filled: 5
- CR number filled: 5
- CR photo uploaded: 10
- Notes / payment terms set: 5

**Branch-level (60 points max, per branch):**
- GPS captured: 15
- Address ≥ 10 chars: 5
- Shop photo: 10
- Signboard photo: 10
- Day of visit: 5
- Equipment counts entered (any of 3 ≥ 0): 5
- Opening hours OR delivery window: 5
- Status = ACTIVE confirmed: 5

A customer with 3 branches reports the **average** branch score for the branch portion. The dashboards show the full distribution, not just the mean.

---

## 11. Page Inventory (v1)

Mobile-first; same routes work on desktop with adapted layout.

### Salesman (mobile primary)
1. `/login` — login
2. `/today` — Today's Route (default home)
3. `/customers` — full route list with filters
4. `/customers/:id` — customer profile (read view)
5. `/customers/:id/edit` — enrichment form
6. `/customers/:id/branches/:branchId/edit` — branch enrichment
7. `/customers/:id/add-branch` — new branch form
8. `/rejected` — Rejected / Needs Correction queue
9. `/work` — **Work Items inbox (new in v0.2)** — unified page for items needing action
10. `/profile` — own profile + logout

### Supervisor (mobile + desktop)
10. `/approvals` — pending approval queue
11. `/approvals/:id` — diff view + approve/reject
12. `/team` — list of his salesmen + their progress
13. `/reassignments` — wrong-route flagged customers
14. `/reports/team` — team dashboard

### Manager (desktop primary)
15. `/dashboard` — global / regional KPIs
16. `/users` — manage user accounts
17. `/routes` — manage routes & assignments
18. `/audit` — full audit log with filters

### Data Steward (desktop)
19. `/import` — upload Excel, see staged batches
20. `/import/:batchId` — review rows, dedupe, promote/reject
21. `/duplicates` — full duplicate review queue
22. `/export` — Excel export with filters

### Common
23. `/forgot-password`
24. `/reset-password`
25. `/health` (200 OK; for monitoring)

---

## 12. Reports & Dashboards

### Salesman home widgets
- "Customers visited today" (count)
- "Submissions pending approval" (count)
- "Rejected — needs correction" (count, badge)
- Personal completeness contribution (this week)

### Supervisor dashboard
- Pending approval queue depth + age histogram
- Per-salesman activity (this week / this month)
- Per-route completeness % over time
- Rejection rate per salesman

### Manager dashboard (across his regions)
- Master completeness % overall + per region + per route
- New enrichments per day (line chart)
- Top performers / laggards (route ranking)
- Open issues: stale approvals (>3d), wrong-route flags, closed shops awaiting confirmation
- Photo storage usage

### Data Steward console
- Records imported / quarantined / merged / rejected
- Duplicate queue depth
- Last export run timestamp + record count

All charts are recharts on Postgres-aggregated views; heavy aggregations cached for 5 min.

---

## 13. Excel Import / Export

### 13.1 Import (one-shot at setup, repeatable as needed)
- Upload `.xlsx` via Steward console.
- Server parses with `exceljs`, validates each row against a schema.
- Mandatory columns (mapped to NMWC fields): Sales Region · Route · CustCode · Cust Branch · Cust Name · CR No · Address · Phone · Contact Person · **Payment Terms (Cash/Credit)** ← owner adds this column.
- Each row creates `ImportRow` records; rows are not promoted to live `Customer` until Steward reviews the batch.
- Quarantine reasons: missing required column, invalid phone format, unrecognized region/route, duplicate detected, malformed CR.
- Steward bulk-promotes clean rows; reviews flagged ones individually.

### 13.2 Export
- "Export to Excel" button on Manager + Steward + Viewer pages.
- Filters: region, route, status, completeness threshold, date range.
- Output sheet shape (mirrors ERP target columns):
  - All input columns from import
  - Plus: Channel, Sub-Channel, GPS lat, GPS lng, GPS captured at, Day of visit, Opening hours, Delivery window, Coolers, Stands, Empty bottles, Status, Last edited by, Last edited at, Completeness %
- Heavy exports run as background job; user gets email or in-app link when ready.

---

## 14. UX Principles

1. **One-handed mobile usage.** Tap targets ≥ 48px. Sticky bottom bar for primary actions.
2. **Prefilled, not blank.** Every form opens with the existing data shown; salesman edits only what's wrong.
3. **Per-field edit affordance.** Pencil icon next to each value; tap to switch to input.
4. **Big visual cues.** Completeness ring, status badges, color-coded severity.
5. **Never lose data.** Auto-save every 5s to IndexedDB. Network failures show retry banner, not error pages.
6. **Forgiving validation.** Inline messages near the field, never blocking modals. Server errors mapped to clear, English-only messages.
7. **No clutter.** Each screen has one primary action. Secondary actions hidden in a "..." menu.
8. **Photo capture flow.** One tap → device camera (capture=environment) → preview with retake → confirm.
9. **Trust the field user.** Don't second-guess his GPS or photos; that's the supervisor's job.
10. **Predictable loading.** Skeleton loaders, never blank screens.

---

## 15. Non-functional Requirements

| Area | Requirement |
|---|---|
| Performance | Customer list (≤200 rows) loads in <1s on 3G; form save <500ms (excluding photo upload) |
| Concurrency | Handle 50 concurrent salesmen submitting at end-of-day peak |
| Availability | 99.5% during business hours (8am–5pm Oman time); planned maintenance on Fridays |
| Backup | Neon PITR on; daily logical dump exported to R2; 30-day retention |
| Security | TLS 1.3 only; bcrypt @ cost 12; CSRF on all mutating routes; audit log immutable |
| Accessibility | WCAG 2.1 AA (color contrast, keyboard nav, ARIA on form fields) |
| Browsers | Chrome/Edge/Safari latest 2 versions; Android 10+ / iOS 15+ |
| Privacy | Phone numbers treated as PII; never logged in error reports; Sentry scrubbing configured |
| Observability | Sentry error tracking, pino structured JSON logs, request IDs on every API call |
| i18n-readiness | All UI strings extracted to a single `messages.en.json` so a future Arabic add can plug in |

---

## 16. Open Items / TBDs

| # | Item | Notes |
|---|---|---|
| O1 | Real NMWC master Excel file | Owner pulling from server next working day; will inform import column mapping |
| O2 | Real region & route names | Will come from the master Excel |
| O3 | Equipment counts: cap at 100 sane? Or higher? | Defaulting to 100 max; will adjust if real data shows higher |
| O4 | Specific 2-Manager region split | Cosmetic; configurable later |
| O5 | ~~Closed-shop reactivation flow~~ | ✅ RESOLVED v0.2: Manager approval required |
| O6 | ~~Notification mechanism~~ | ✅ RESOLVED v0.2: in-app `/work` page only, no email |
| O7 | ~~Domain name for production~~ | ✅ RESOLVED v0.2: Vercel subdomain for v1 |
| O8 | ~~NMWC logo / brand colors~~ | ✅ RESOLVED v0.2: "NMWC" wordmark + blue palette |

---

## 17. Risks (carried from Phase 1, refined)

| # | Risk | Mitigation |
|---|---|---|
| R1 | Field UX too slow → salesmen avoid the app | Target <2 min per customer; pilot with 2 routes before full rollout; iterate from real timing data |
| R2 | Photo storage cost balloons | Compress to ≤2 MB; cap 5 photos per customer; R2 keeps egress free |
| R3 | Bad imports overwrite good data | Quarantine-first import; never directly write live master from upload |
| R4 | Salesman skips GPS by faking location | Server captures device GPS accuracy + photo EXIF GPS as cross-check; supervisor sees both |
| R5 | Supervisor approval becomes bottleneck | Dashboard surfaces stale approvals; Manager can override; mobile-friendly approval UI |
| R6 | Connectivity drops mid-photo upload | Resumable client-side queue, retry-on-reconnect, IndexedDB persistence |
| R7 | Solo maintenance after launch (owner + Claude) | Lean on managed services (Vercel + Neon); structured logs + Sentry; runbook in handover |

---

## 18. Build Plan (preview — full backlog in Phase 5)

8 milestones, each demo-able.

| M | Milestone | Outcome |
|---|---|---|
| M0 | Repo + CI + infra plumbing | Empty Next.js app deployed to Vercel + Neon staging; auth.js scaffolded |
| M1 | Auth + RBAC + user management | All 5 roles can log in; Manager can create users |
| M2 | Schema + import skeleton | Schema migrated; basic Excel import + quarantine console |
| M3 | Salesman customer list + read profile | Can see assigned customers, view profile (read-only) |
| M4 | Enrichment form + photos + GPS | Full edit form, photos, GPS capture, drafts to IndexedDB |
| M5 | Approval workflow | Submit → Supervisor queue → approve/reject → notification |
| M6 | Dashboards + completeness scoring | Manager and Supervisor dashboards live |
| M7 | Excel export + duplicate review tool | Steward console complete |
| M8 | Hardening + UAT + production cutover | Sentry, monitoring, runbook, real NMWC pilot route(s) |

---

## Appendix A — Channels & Sub-Channels (locked)

| # | Channel | Sub-Channels |
|---|---|---|
| 1 | HORECA | Restaurants · Cafés/Coffee shops · Hotels/Resorts · Catering · Cinemas · Gyms |
| 2 | Modern Trade | Hypermarkets · Supermarkets |
| 3 | General Trade | Small Groceries · Mini-markets · Pharmacies |
| 4 | Convenience & Gas (C&G) | Petrol station convenience stores |
| 5 | E-Commerce | Food-delivery apps · eGrocery apps |
| 6 | Home & Office Delivery | Residential 5gb · Small offices |
| 7 | Institutions | Government/Municipalities/Military · Education · Healthcare · Construction/Worker camps · Mosques |

## Appendix B — Stack (locked)

- **Framework:** Next.js 15 (App Router) + TypeScript
- **UI:** Tailwind + shadcn/ui + Lucide icons
- **DB:** PostgreSQL on Neon (Launch plan)
- **ORM:** Prisma
- **Auth:** Auth.js (Credentials provider)
- **Storage:** Cloudflare R2 (S3 API)
- **Hosting:** Vercel Pro
- **Email:** Resend
- **Errors:** Sentry
- **Logs:** pino (JSON structured)
- **Testing:** Vitest + Playwright + Testing Library
- **CI/CD:** GitHub Actions
- **Validation:** Zod

## Appendix C — Definition of Done (per feature)

A feature is "Done" only when:
1. Code merged to `main` via PR (no direct pushes)
2. Unit tests for business logic (≥80% coverage on services)
3. Integration test for the API endpoint(s) involved
4. E2E test for the user-visible happy path
5. Permission tests confirm RBAC enforcement
6. Validation tests cover invalid-input branches
7. Manual smoke test on mobile (real phone, not just devtools)
8. Sentry breadcrumbs added for the new flow
9. Owner approves the feature in staging before promotion to prod

---

**END OF PRD v0.1.**
**Owner — please review and respond with: APPROVE | CHANGES (list them) | QUESTIONS.**
**Once approved, Phase 3 (UX wireframes) begins, then Phase 4 (full ERD + API contract).**
