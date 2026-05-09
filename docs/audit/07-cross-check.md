# Audit 07 — Cross-Domain Bugs, Contradictions, Gaps, Verification, Launch Readiness

**Auditor:** Seventh QA agent (cross-check). Independent of the six domain agents.
**Date:** 2026-05-09 (T-1 to pilot)
**Method:** Read all six prior reports + the remediation report. Cross-referenced against working tree at `C:\Users\rahma\OneDrive\Desktop\NMWC-CRM`. Specifically looked for **chains** (bugs where two agents each saw half), **contradictions** (where reports disagree on the same code), **gaps** (areas no agent looked at), and **previously-claimed-fixed-but-not** (what the remediation report says vs what the code actually does).

**Verdict in one line:** No-go for full launch tomorrow. A safe minimum-viable-launch (read-only + Steward-driven import) is achievable with ~6 hours of work.

| Category | Count |
|---|---|
| Cross-domain chains | 12 |
| Contradictions resolved | 7 |
| New gaps (unowned) | 11 |
| Remediation claims FALSELY claimed fixed | 5 confirmed, 2 partial |

---

## 1) Cross-domain chains (12)

Each chain combines findings from at least two of the six domain reports. The compound is more dangerous than either component finding read alone.

### CHAIN-01 — Steward mints a Manager via /import → that Manager approves cross-region edits → master corruption is global and laundered through approvals

- **Components:** F-02 (imports — Steward can mint a brand-new MANAGER user with no existing-row check) + RBAC-05-003 (MANAGER has zero region scope on `/approvals` and `canApproveSpecificEdit`) + RBAC-05-018 (privileged actions trust JWT role).
- **Walk:** rogue Steward uploads Account-master with row `username=manager.evil, role=MANAGER, password=<known>, change_role=no`. F-02 (c) means this passes (no existing-user check, role unconditionally written for new users at services/imports.ts:271). The new Manager logs in. They open `/approvals` (no region filter) and rubber-stamp every pending edit Oman-wide. AuditLog shows `actor=manager.evil` — but the trail is now entangled with legitimate state changes.
- **Why chained:** imports agent saw the mint, RBAC agent saw the global approve. Neither saw that the import path is the way the global approver gets created.
- **File:line evidence:** `services/imports.ts:271` (`if (!existing || wantsRoleChange) update.role = role`); `app/(app)/approvals/page.tsx:19-23` (no region filter for MANAGER); `lib/permissions.ts:103-110` (`canApproveSpecificEdit` returns `true` for any MANAGER).

### CHAIN-02 — Salesman submits with photos → detaches CR photo → Manager.B (different region) approves edit globally → APPROVED record left photo-less, in Manager.A's region, decided by Manager.B

- **Components:** EL-04 (approve-time mandatory gate not re-run) + UXI-001 (one-tap photo trash, no confirm) + RBAC-05-003 (Manager approves cross-region) + EL-14 (Manager region-scope on approval missing).
- **Walk:** salesman.mct-01 submits — gate passes. Two minutes later, on the customer profile, they tap the trash icon on the CR photo (UXI-001 — no confirm). `customer.crPhotoId` becomes null. `services/edits.ts:467-585` does NOT re-run `collectMissingMandatory`. Manager.B in Dhofar opens `/approvals` (sees Muscat customers, RBAC-05-003), clicks Approve. The edit lands. The customer in Muscat is now APPROVED with no CR photo, region Manager.A never saw the request, and Manager.B is the actor of record.
- **Why chained:** lifecycle, photos, RBAC. Three High findings stack into one realistic Critical scenario.
- **File:line:** `services/edits.ts:467-585` (no mandatory-re-check in approveEditAction); `components/nmwc/PhotoCaptureSlot.tsx:173-186` (no confirm); `lib/permissions.ts:103-110`.

### CHAIN-03 — Logout doesn't invalidate JWT + photo cache 60s + photo IDOR-by-uploader bypass = 8h+ historical access for a "logged out" user

- **Components:** AUTH-12 (logout doesn't invalidate JWT) + NEW-PHOTO-009 (60s cache) + RBAC-05-014 (`assertCanAccessAttachment` short-circuits on `capturedById === user.id` even after route reassignment).
- **Walk:** salesman.mct-01 logs in on a borrowed phone. Cookie copied. They "logout". `signOut` clears cookie on their browser only. Attacker has the JWT (still valid 8h). Manager reassigns the salesman's route to a new salesman. Attacker pulls every photo the original captured via `/api/photos/[id]` — `assertCanAccessAttachment` short-circuits because `capturedById === user.id`. Each photo cached for 60s in browser; replaying without revalidation. Routes through R2.
- **Why chained:** auth agent saw the JWT replay; photos agent saw the cache + uploader-bypass; neither walked the chained path.
- **File:line:** `app/actions/auth.ts:56-58` (signOut is browser-only); `app/api/photos/[id]/route.ts:53` (60s cache); `lib/access.ts:138` (uploader bypass).

### CHAIN-04 — Manager A peer-resets Manager B's password → A logs in as B → B's JWT for prior 5 minutes is still valid (no revocation) → B and A are simultaneously logged-in-as-B for 5 min, both write to AuditLog as actor=B

- **Components:** AUTH-08 (Manager peer-reset, no notification, no second factor) + AUTH-12 (no JWT revocation) + AUTH-01 (5-min freshness window) + RBAC-05-006 (peer-Manager protection).
- **Walk:** Manager.A clicks Reset password on Manager.B in `/users`. The action just `prisma.user.update({ data: { passwordHash } })` — no `sessionsRevokedAt`, no logout-everywhere. Manager.B's JWT stays valid (signature passes, freshness re-read at 5 min returns the same active user — bcrypt hash mismatch never matters because JWT auth doesn't re-bcrypt). Two parallel sessions write audit rows as `actor=manager.b`. The audit log can't tell who actually did what.
- **Why chained:** auth agent flagged each leg separately; together it's a full account-takeover with shared "valid" sessions.
- **File:line:** `services/users.ts:126-146` (resetPasswordAction, no peer guard, no revocation timestamp); `lib/auth.ts:64,107-139` (5-min freshness, no `sessionsRevokedAt` check).

### CHAIN-05 — Phone-uniqueness leak (cross-region) + global PII in `/audit` + global `/users` PII = competitive intelligence harvest by a salesman or supervisor

- **Components:** EL-03 (phone-uniqueness error leaks legalName + NMWC code across regions) + RBAC-05-007 (Manager sees global audit) + RBAC-05-023 (`/users` lists every user's email/phone globally).
- **Walk:** A Muscat salesman runs a phone-spam loop on the edit form (`99000000`–`99999999`) — each collision returns the cross-region duplicate's `legalName + NMWC code`. They've now built a directory of every customer in the country. A Manager in any region opens `/audit` and `/users` and pulls the entire actor PII set with full names, phones, emails. Combined harvest: customer master + user master.
- **Why chained:** edit agent caught the per-form leak; RBAC caught the per-page leaks. Together they're a full directory-style enumeration with no SQL access.
- **File:line:** `services/edits.ts:248-261` (collision error message); `app/(app)/audit/page.tsx:9-20`; `app/(app)/users/page.tsx:16-23`.

### CHAIN-06 — Export endpoint scope-bypass (F-01) + soft-deleted attachments still served (RBAC-05-015) + Sentry doesn't strip request bodies = a Supervisor can scrape every customer's last-known phone + photo URLs even after deletion, and any error is captured to Sentry with the unredacted query string

- **Components:** F-01 (export scope filter overwritten by user query) + RBAC-05-015 (soft-deleted attachments cause 502, leaking ID validity) + GAP-09 below (Sentry server config strips headers but not query strings or request bodies).
- **Walk:** rogue Supervisor crafts `?routeId=DHF-04&routeId=DHF-05&...` (F-01 — gets all Dhofar). Then iterates IDs against `/api/photos/<id>`: 200 = exists, 502 = soft-deleted-but-recoverable-in-R2-still-not-purged, 404 = real miss. They build a corpus of customer phone numbers + photo IDs. If any one request errors, Sentry's `beforeSend` (sentry.server.config.ts) strips `headers.authorization/cookie` but NOT `request.query_string` or `request.body` — so phones leaked into URL params end up in a third-party SaaS.
- **Why chained:** export, photos, and observability — three different agents, none owned the data-flow boundary.
- **File:line:** `services/exports.ts:54-58` (overwrite); `app/api/photos/[id]/route.ts:25-26,46-58` (502 leak); `sentry.server.config.ts:9-15` (only headers stripped).

### CHAIN-07 — Reactivation accepts back-dated photos (NEW-PHOTO-007) + soft-deleted attachments (UXI-008) + Manager A approves any region's reactivation (RBAC-05-008) = a salesman can reactivate a closed branch using a deleted, pre-closure photo and the wrong Manager rubber-stamps it

- **Components:** NEW-PHOTO-007 (`capturedAt` is client-supplied) + UXI-008 (Attachment soft-delete sentinel doesn't filter `findUnique`) + RBAC-05-008 (Manager region scope missing on approve).
- **Walk:** salesman finalizes a year-old photo with `capturedAt: new Date()` (NEW-PHOTO-007). Branch is closed. Salesman submits reactivation. `services/reactivations.ts:57` does `findUnique({ where: { id } })` — even if the photo was soft-deleted (`r2Key` rewritten to `__deleted__/...`), the row is still found, capturedAt passes ≤24h. Manager.A in Muscat approves a Dhofar reactivation (no region check). Branch flips back to ACTIVE with rotten evidence.
- **File:line:** `app/api/photos/finalize/route.ts:39,96` (client-supplied capturedAt); `services/reactivations.ts:57`; `services/reactivations.ts:174-238` (no region check on approve).

### CHAIN-08 — Hash dedupe oracle (NEW-PHOTO-002) + cross-region phone leak (EL-03) = a salesman can confirm whether a specific photo file (and its phone-number metadata) was uploaded to any customer in the master, regardless of scope

- **Components:** NEW-PHOTO-002 (finalize returns existing attachment ID for any matching hash) + EL-03 (phone leak by collision message).
- **Walk:** the salesman has a stock CR document image. They hash it, finalize, get `{ attachmentId: <existing>, deduped: true }`. They now know the photo exists in the system. They still can't view it (attach is blocked by ownership), but they can confirm "this CR document is in the master" — which combined with EL-03's phone-leak directory builds a customer→photo relationship map.
- **File:line:** `app/api/photos/finalize/route.ts:81-85`; `services/edits.ts:248-261`.

### CHAIN-09 — Imports auto-create regions/routes silently (F-17) + `canSeeCustomer` for Manager-with-empty-regions returns true (RBAC-05-012) = phantom-region customers are invisible to legitimate Managers but visible to ANY new Manager (until the new Manager has regions assigned)

- **Components:** F-17 (typo'd region auto-created) + RBAC-05-012 (fail-open default for unscoped Manager).
- **Walk:** Steward uploads `sales_region = TYPO_REGION`. The 200 customers are now in a phantom region. Legit Managers (with assigned regions) don't see them. **A newly-created Manager (between row creation and region-assignment) has `managedRegionIds=[]` and sees EVERYTHING — including the phantom-region customers**. The Steward who controls imports + has temporary creates-Manager privileges (F-02) can mint a fresh Manager for ~minutes between create and region-assign and exfiltrate the phantom-region data.
- **File:line:** `services/imports.ts:533-550`; `lib/access.ts:74-79`.

### CHAIN-10 — Browser-back-after-submit (UXI-005) + double-submit race (UXI-004) + P2002 surfacing as opaque error (EL-09) = a salesman can land in a state where their edit appeared to fail but actually went through — and they can't tell from the UI

- **Components:** UXI-005 (back-after-submit shows stale form, allows resubmit) + UXI-004 (rapid double-tap fires two server actions before `pending` flips) + EL-09 (P2002 surfacing through SuperJSON wrapper not always preserves the code).
- **Walk:** salesman taps Submit, network is slow, taps again. Both actions race the partial unique index. One wins; the other gets P2002 → may surface as opaque 500 (EL-09) instead of `EDIT_LOCKED`. Salesman hits Back to "retry" — UXI-005 lets them re-edit. They submit again. Now `canSubmit` is stale; if SUBMITTED edit exists they get a confusing ConflictError on a brand new attempt. Salesman concludes the system is broken; manager sees an audit row they don't understand.
- **File:line:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:268-277,583-601`; `services/edits.ts:368-396`.

### CHAIN-11 — `lastEditedById` set on system writes by import-promote (UXI-023) + `Customer.lastEditedById` on every customer/branch update silently overwrites a salesman's pending edit's submitter when Steward re-promotes (F-14)

- **Components:** F-14 (re-promote silently overwrites in-flight edits) + UXI-023 (lastEditedById has no system actor).
- **Walk:** salesman submits an edit (SUBMITTED). Steward re-uploads + re-promotes the same customer master file (idempotent on data, but still touches lastEditedById). The customer is updated — now `customer.lastEditedById = stewardId` — and any in-flight SUBMITTED edit silently overwrites once approved. The salesman's edit's `before` snapshot is now stale relative to the live record. Approve at the supervisor reverts the steward's promote.
- **File:line:** `services/imports.ts:565-628`; UXI-023 (`prisma/schema.prisma:212,261`).

### CHAIN-12 — Sentry replay disabled but errors still ship full request payload (GAP-09) + import-promote logs Prisma error messages with embedded customer values (F-15) = customer phones/CR numbers from import errors land in Sentry events untouched

- **Components:** F-15 (logger.warn includes `err.message` from Prisma which contains the colliding value) + Sentry server config doesn't strip URL/body params.
- **Walk:** import promote of a row with a duplicate phone `+96891234567` throws P2002. `logger.warn({ err: err.message })` writes `Unique constraint failed on the fields: (primaryPhoneNorm) — value '+96891234567' already exists` to pino logs (which Sentry instrumentation also captures). pino's path-based redaction doesn't see the embedded value. Sentry sends it. Phones in Sentry indefinitely.
- **File:line:** `services/imports.ts:622-626`; `lib/logger.ts:3-12`; `sentry.server.config.ts`.

---

## 2) Contradictions resolved

The reports occasionally disagree on the same piece of code. Each row reads the relevant file and picks a winner.

| # | Topic | Report A says | Report B says | Code says | Winner |
|---|---|---|---|---|---|
| C-1 | `/api/photos/finalize` CSRF | Auth report (AUTH-14) calls it "effectively safe from CSRF" because of JSON-only requirement | Photo report does not flag this | Code at `app/api/photos/finalize/route.ts:42-104` only checks `auth()`. SameSite=Lax + JSON-only do mitigate, but no Origin check exists. | **Auth correct** — currently safe, but only "by accident". Both reports under-flag the cross-domain risk: a Manager opens a malicious link in same browser → if any other endpoint accepts simple form POSTs cross-origin it's exposed. |
| C-2 | `/api/exports/customers` Zod-before-auth | Imports report (F-21) flags as "still open, re-emergence of QA-047, Low" | Auth/RBAC reports don't flag | Code at `app/api/exports/customers/route.ts:19-33`: `filterSchema.parse(...)` runs BEFORE `buildCustomerExport` calls `requireExport`. Logged-out attacker hits 500 with details. | **Imports correct** — confirmed in code. Severity should be Medium not Low (information disclosure pre-auth). |
| C-3 | EXIF stripping | Photos report (NEW-PHOTO-004) — canvas re-encode strips EXIF, "safe by accident", flagged Medium for fragility | UX report doesn't flag | Code at `components/nmwc/PhotoCaptureSlot.tsx:25-57` — canvas re-encode happens always. EXIF is dropped. | **Photos correct.** Confirmed by reading the code. The "safe by accident" caveat is the right framing — any future "skip compression for small files" optimization re-introduces leak. |
| C-4 | `canApproveSpecificEdit` for Manager | Edit-lifecycle report (EL-14) flags as Low ("manager region-scope on approval missing") | RBAC report (RBAC-05-003) flags as **Critical** | Code at `lib/permissions.ts:103-110` — Manager returns `true` unconditionally. RBAC report's framing wins because the impact is global state corruption, not a UX nit. | **RBAC correct** — Critical. EL-14 under-rated. |
| C-5 | `attachPhotoAction` ownership | Edit-lifecycle (EL-08) flags Steward/Manager bypass as Medium with reasonable rationale | RBAC (RBAC-05-011) flags Supervisor/Manager attach as Medium contradicting PRD | Code at `services/photos.ts:35-171` — Salesman has a route check; Steward/Manager bypass; **Supervisor falls through with no role gate at all** (line 50: `isAdmin = STEWARD || MANAGER` only checks those two; line 65 only checks `if SALESMAN`). | **RBAC correct.** Both reports right that bypass exists; RBAC's read of "Supervisor falls through with no role gate" is more accurate. The Salesman-only branch on line 65 is the only role-specific gate. |
| C-6 | EL-14 vs RBAC-05-003 — same code | EL-14: "any MANAGER (no region scoping) can approve any salesman's edit" — flagged Low | RBAC-05-003: same code — flagged Critical | Identical underlying code. | **RBAC correct** in severity. EL-14 should be Critical not Low. |
| C-7 | Two reports on Manager direct-write region scope | Edit (EL-01) addresses customer-status flips by Salesman but not Manager direct-write region | RBAC (RBAC-05-004) flags Manager direct-write as High | `services/edits.ts:204-209,336-366` — code allows Manager to write any customer with no region check, no override flag/reason | **RBAC correct.** EL-01 is its own (Critical) finding for status, but doesn't cover the broader RBAC-05-004 problem. Both findings are real and orthogonal. |

---

## 3) Gaps — areas no agent owned

### GAP-01 — `/api/health` endpoint info disclosure
**File:** `app/api/health/route.ts`. **Status:** No auth. Returns `{ service: 'nmwc-cm', version, timestamp, checks: { app, db, r2 } }`. Confirms infrastructure stack (Postgres + R2). Returns 503 vs 200 telling attackers when the DB is degraded. Useful for timing attacks (DB up → fast; DB stressed → slow). **Severity: Low.** Fix: keep the 200/503 but only return `{status}`. Internal monitoring can hit a separate authenticated endpoint.

### GAP-02 — Sentry leakage at the wire
**Files:** `sentry.server.config.ts:9-15`, `sentry.client.config.ts:11-14`. **Status:** Server config only deletes `headers.authorization` and `headers.cookie`. Client only deletes `request.cookies`. **Neither strips:**
- `event.request.url` (full URL with query string — phones/IDs/regionIds)
- `event.request.data` / body
- `event.exception.values[].value` — error messages with embedded values from Prisma (CHAIN-12)
- `event.breadcrumbs[]` — fetch breadcrumbs include URLs
- `event.user.id` (set by Sentry by default if available)
**Severity: Medium.** Fix: add denylist scrubbing on `request.url`, `request.data`, `exception.values[].value` using a regex for common PII patterns (`\+968\d{8}`, CR numbers).

### GAP-03 — Cron / scheduled jobs
**Status:** None. No `vercel.json` cron config, no Vercel Cron route handlers, no `app/api/cron/`. The remediation report claims a "30-day GC job" exists for soft-deleted attachments (NEW-PHOTO-003) — confirmed absent. Orphan attachments (UXI-008) accumulate forever. **Severity: Medium.** Cost balloon over 12 months.

### GAP-04 — Error pages: no `error.tsx`, no `not-found.tsx`, no `global-error.tsx`
**Status:** Confirmed via glob — neither file exists in `app/`. Next.js falls back to its DEFAULT error page in production (which still renders a stack trace in dev and a generic "An error occurred" in prod). **Severity: High** for two reasons:
1. Any unhandled error in a server component (e.g., `services/exports.ts` calling `prisma.branch.findMany` and OOMing — F-16) will surface Next.js's default which leaks framework version + sometimes a digest hash.
2. No `not-found.tsx` means `notFound()` (used by `lib/access.ts` 404 paths) renders a generic Next.js "404" page with no app branding/no logout link/no help. Confusing for a user who gets bounced from a customer they "should" see.

### GAP-05 — Session fixation across tabs / login race
**Status:** Not flagged anywhere. With `strategy: 'jwt'` (auth.config.ts:14), each tab has independent token state. If user logs in on tab A, then changes their password from tab B, tab A's JWT is still valid (no `sessionsRevokedAt`). Combined with AUTH-12, a malicious script in a third tab (XSS via `unsafe-inline` script-src) can hold the cookie open. **Severity: Medium.** Fix: same as AUTH-12 (`User.sessionsRevokedAt` column).

### GAP-06 — Webhook endpoints
**Status:** None. Searched `app/api/` — no webhook routes. Good. **Severity: N/A.**

### GAP-07 — Internationalization / Arabic right-to-left
**Status:** No `lang="ar"`, no `dir="rtl"` toggling. `app/layout.tsx` is fixed `lang="en"`. Customer legal names contain Arabic text from the import master (UXI-015 confirms). Arabic strings render LTR-by-default in `<div>`s, which means parenthesis/punctuation jumbles for mixed Latin+Arabic strings (e.g., `Lulu (الأسرة)` renders with parens on the wrong side of the Arabic). **Severity: Low** — owner deferred Arabic UI per locked decisions. Document for v1.1.

### GAP-08 — Accessibility (keyboard nav, screen reader)
**Status:** UX agent flagged some sub-points (UXI-029 StatusBadge no aria, UXI-020 emoji empty state) but no holistic pass. Quick check: `<input type="number">` widely used → screen reader announces "edit textbox" with no field name unless `<label>` is paired. Sidebar uses `<a>` not `<nav role="navigation">`. **Severity: Medium** for WCAG 2.1 AA (PRD §15 requires it).

### GAP-09 — Performance pathologies under realistic data volumes
**Status:** F-16 noted export OOM at ~10k rows. **Other paths not load-tested:**
- `/audit` `take: 100` is under control but each page-load runs `findMany` without index hints; at 100k+ rows the orderBy on `at desc` is fine (indexed), but no cursor pagination means deep pages will be DB-CPU-heavy.
- `/customers` query with `branches: { take: 1 }` and full include scales linearly; at 5000 customers + 50 branches each, ~250 KB JSON per page-load — tolerable.
- `services/duplicates.ts` `findDuplicateCandidates` is O(N²) per the remediation report — fine at 5k.
- `lib/completeness.ts` is called inside transactions on every customer write; it's pure, fast.
- **Real risk:** `services/edits.ts` `applyEditChanges` recomputes scoreCustomer including reading every branch (line 442-462). On a 50-branch chain customer this is a 50-branch findMany inside a transaction.
**Severity: Low** for v1 scale. Documented for v1.1.

### GAP-10 — Database migration safety (current vs. next)
**Status:** Not addressed. `prisma/migrations/20260509150000_qa_remediation` adds three indexes + a table. None of the proposed fixes from the six audits would require a destructive migration except: adding `User.sessionsRevokedAt` (AUTH-12 fix), `User.mustChangePassword` (AUTH-09), `Branch.lastStatusChangeAt` (EL-11), `Attachment.deletedAt` (UXI-008 fix). All additive. **Severity: N/A** for tomorrow; flag for v1.1.

### GAP-11 — Email notifications
**Status:** None. Searched: no `nodemailer`, no `@vercel/mail`, no Postmark/Sendgrid imports. AUTH-08 (peer password reset notification) and AUTH-15 (forgot-password flow) both depend on email. The schema has `User.email` but no delivery path. **Severity: Low** for v1.0; **High** if launch happens without an out-of-band password-reset path documented.

### GAP-12 — Rate-limit fallback to in-memory under DB blip = denial-of-protection
**File:** `lib/rate-limit.ts:36-43`. The `try { checkLimitPg } catch { checkLimitMemory }` fallback means a DB hiccup silently downgrades to per-Lambda in-memory limiting (which is useless on Vercel's serverless because each cold start has a fresh map). An attacker who can cause DB pressure (e.g., a slow query loop on `/api/exports/customers` per F-21 which runs DB-heavy queries pre-auth) can shift the limiter into a state where the per-Lambda buckets reset on every cold start. They get effectively unlimited login attempts. **Severity: Medium.** Fix: on PG failure, *fail closed* (return `{ ok: false }`) for login but `{ ok: true }` for non-security-critical limits — or add a circuit breaker that alerts and uses memory for max 60s.

---

## 4) Previously-claimed-fixed-but-not — verification table

The remediation report (REMEDIATION-REPORT.md) claims **5 Critical + 18 High** closed, with 38 tests. Three sister agents flagged that QA-011, QA-029, QA-034, QA-047, QA-025 are claimed-fixed-but-not. I read each one in code:

| Claim # | Description | Claimed-fixed? | Actually-fixed? | Evidence (file:line) | Notes |
|---|---|---|---|---|---|
| QA-011 | Steward cannot escalate self via import | YES (rem §2 imports) | **NO** | `services/imports.ts:184-191` (guard) + `:271` (`update.role = role`) | Three independent bypasses confirmed (F-02): case mismatch, re-key in same upload, new-user-creates-Manager unbounded. The guard only catches the rare `change_role=yes && username===me.username` case. |
| QA-029 | HTML-strip parity on import | NO (rem §5 explicitly says "still raw at promote time") | **NO** | `services/imports.ts:418,433-444,567-592` — no `stripHtml` calls at all | Both reports agree this is open. Remediation report's status is correct. NOT a contradiction; simply not done. |
| QA-034 | Export row cap | NO (rem §5: "fine for ~3k") | **NO** | `services/exports.ts:78-150` — no `take` clause; no row cap | Remediation correctly admits this is open. F-16 confirms. |
| QA-047 | `/api/exports/customers` parses Zod before auth | YES (implied by rem section) — actually NOT in fixed list | **NO** | `app/api/exports/customers/route.ts:19-33` — `filterSchema.parse` BEFORE `buildCustomerExport` (which calls auth) | Remediation doesn't explicitly claim QA-047 fixed, but `app/api/exports/customers/route.ts` has not been changed. Auth still after Zod. F-21 confirms. |
| QA-025 / QA-048 | Export 500-vs-403 mapping | YES claimed via "added test" in rem | **NO** | `app/api/exports/customers/route.ts:46-48` — still uses `message.includes('signed in') ? 401 : 500` | `(err as Error).message.includes('signed in') ? 401 : 500`. SALESMAN's `Your role cannot export.` doesn't contain 'signed in' — returns 500. F-22 confirms. |
| QA-044 | Photos GC for orphan attachments | YES (rem §5 mentions "30-day GC job") | **NO** | No `vercel.json` cron, no `app/api/cron/` route, no `services/gc*` file. Confirmed via glob. | NEW-PHOTO-003 confirms. |
| QA-035–37 | User mgmt hardening (peer protection, last-Manager, role validation) | NO (rem §5: "lower-blast-radius improvements") | **NO** | `services/users.ts:103-146` — `toggleUserActiveAction` and `resetPasswordAction` have no peer guards, no last-Manager check, no role-tier check | RBAC-05-006, AUTH-07, AUTH-08, RBAC-05-018 all confirm. Remediation correctly punted; agents correctly flagged the deferral as launch-blocking. |
| QA-040–42 | Logger PII tightening | NO (rem §5 explicitly open) | **NO** | `lib/logger.ts:3-12` — only path-based redaction; F-15 (Prisma message string includes value) shows shallow redaction insufficient | Aligns with prior reports. |
| QA-046 | `/api/health` info disclosure | NO (rem §5 explicitly open) | **NO** | `app/api/health/route.ts:42-49` returns version + service + checks publicly | GAP-01 confirms. |

**Two genuinely partial:**
- QA-012 (5 MB cap): claimed fixed; actually only compressed-size cap. F-06 documents that decompressed XML-bomb still possible. **Partial.**
- QA-049 (photo cache): claimed fixed (5 min → 60 s); actually changed but the underlying staleness issue remains. **Partial — improvement is real but doesn't eliminate the leak.**

**Summary line for the table:** The remediation report is honest about ~70% of the open Mediums, but **it overclaims on the five items above** (QA-011, QA-025/048, QA-047, QA-044, plus the implicit QA-029 narrative). Agents 03, 04, and 05 were right to call it out.

---

## 5) Launch readiness — minimum-viable-launch profile

### Hard truth

With **6 Critical + 34 High + 51 Medium + 37 Low** outstanding (counts from the prior six reports + this audit's additions), the system is **NOT** safe to launch as a full pilot tomorrow. The five most damaging cross-domain chains (CHAIN-01 through CHAIN-05) will land in production within Week 1.

### Realistic minimum-viable-launch options (in increasing order of value to the owner)

#### Option A — Field-only mode ("Excel + view-only app")
The app ships in **read-only mode for Salesmen and Supervisors**, and **Stewards drive everything via /import**. Managers do not use the app for approvals or direct-writes — they confirm changes via Excel diffs.

What's safe to ship:
- `/login` (after fixes below)
- `/today` and `/customers` lists for SALESMAN, SUPERVISOR, MANAGER, VIEWER (read-only)
- `/customers/[id]` profile (read-only — no edit links)
- `/export` (after F-01 fix — which is one-line)
- `/dashboard` for MANAGER (region-scoped, already fixed)
- `/audit` for MANAGER (DOCUMENT THE LEAK; fix RBAC-05-007 first)

What's disabled:
- `/customers/[id]/edit` — disable the route (404 it from middleware) for SALESMAN; only Steward via /import path
- `/approvals` — the entire flow is unsafe due to CHAIN-01, CHAIN-02. Disable the route.
- `/users` create/role-change — Steward via Account-master Excel only (after F-02 fix)
- `/duplicates` merge — Steward only (already correct in PRD; remove Manager access per RBAC-05-009)
- `/reactivations` — disable until RBAC-05-008 + NEW-PHOTO-007 fixed.

#### Option B — Two-route pilot with a guardrail
If owner insists on a real edit/approve flow: limit pilot to **2 routes (38 routes is too many to monitor)** and **1 Manager + 1 Supervisor + 2 Salesmen**. With one Manager, RBAC-05-003 is moot (no peer-Manager region collision). Steward stays sole admin.

This still needs the 7 fixes below. The Manager being a single human means the cross-region issues don't trigger; the salesman-side leaks (RBAC-05-001, RBAC-05-002, EL-03) still trigger and must be fixed.

### Smallest set of fixes to make Option A safe (estimated 4–6 hours)

| # | Fix | File:line | Effort |
|---|---|---|---|
| 1 | Disable `/customers/[id]/edit` from middleware for SALESMAN | `middleware.ts` add matcher exclusion or page-level early-redirect | 15 min |
| 2 | Disable `/approvals` and `/approvals/[id]` for all roles via 404 | `app/(app)/approvals/page.tsx:1` add `notFound()` | 5 min |
| 3 | Disable `/reactivations` route | `app/(app)/reactivations/page.tsx:1` add `notFound()` | 5 min |
| 4 | F-01 fix: intersect role scope with user filter on `/api/exports/customers` | `services/exports.ts:42-58` | 30 min |
| 5 | RBAC-05-001 fix: filter `customer.branches` by user scope on profile + edit pages | `app/(app)/customers/[id]/page.tsx:25-50,120-167` and `app/(app)/customers/[id]/edit/page.tsx:39-65` | 1 hr |
| 6 | RBAC-05-007 fix: scope `/audit` to managed regions + add STEWARD | `app/(app)/audit/page.tsx:9-20` | 45 min |
| 7 | RBAC-05-012 fix: `canSeeCustomer` for unscoped Manager → `return false` (fail-closed) | `lib/access.ts:74-79` | 5 min |
| 8 | F-02 fix: in `services/imports.ts` block STEWARD from creating MANAGER/STEWARD rows | `services/imports.ts:271` add role-tier guard before `update.role = role` | 30 min |
| 9 | Set `DEMO_ACCOUNTS_DISABLED=true` in Vercel env | env config | 2 min |
| 10 | Rotate `admin` password from `ChangeMeNow!2026` | run `npm run db:seed` | 5 min |
| 11 | Add `error.tsx` and `not-found.tsx` at `app/error.tsx` and `app/not-found.tsx` (GAP-04) | new files, branded | 30 min |
| 12 | Lower `/api/photos/[id]` cache for CR-kind to `no-store` (NEW-PHOTO-009 partial) | `app/api/photos/[id]/route.ts:53` | 10 min |

**Total: ~4 hours.** Tested via existing 38 unit tests + 5 new integration tests for the scoped read paths.

### Items that CAN slip to Week 1 of pilot (already documented)

- AUTH-04, AUTH-05, AUTH-07, AUTH-08, AUTH-09, AUTH-12, AUTH-15 (auth hardening — all need User schema additions; can ship 7-day patch)
- UXI-006 (Arabic-Indic phone) — visible UX bug; will get tickets fast
- UXI-007 (equipment sub-score) — wrong dashboard numbers; non-blocking
- UXI-009 (audit pagination) — only matters at scale
- Photo GC cron (NEW-PHOTO-003) — cost-only, not security

### Items that MUST NOT slip

If the launch does proceed full-scope (Option B with 2 routes, Single Manager), at least the four below must be fixed BEFORE day 1:
- RBAC-05-006 (peer-Manager protection) — Critical regardless of how few Managers
- EL-01 (customer-status CLOSED bypass) — Critical correctness
- EL-04 (approve-time mandatory gate re-check) — Critical correctness
- F-01 (export scope bypass) — Critical, one-click data exfil

---

## 6) Recommended go/no-go

**No-go for the 38-route full pilot.** The compound damage of CHAIN-01, CHAIN-02, CHAIN-04, CHAIN-05 in production within Week 1 will undermine trust and require emergency patches that re-touch the auth + RBAC + edit paths simultaneously — the riskiest possible configuration for hot-fixes.

**Conditional go for Option A (read-only + Steward-driven import) with the 12 fixes above (~4 hours of work).** This shrinks the launch surface to the parts that have been adversarially audited and verified clean. Salesmen continue field work in Excel for one more week while the edit-approval flow is hardened.

**Conditional go for Option B (2-route pilot, single Manager) with the 4 hard-block fixes above PLUS the 8 from Option A.** Adds ~4 more hours of work for the EL-01 and EL-04 fixes. Total: 8 hours.

The owner asked at T-1 because the work plan has been "fix what's broken right now" not "audit comprehensively". This 7th audit found 12 cross-domain chains the 6 single-domain agents could not see. The fixes are mostly small (most are <1 hour each); the path to a safe launch is real, but it is not "ship as-is and patch later".

— Cross-check QA, 2026-05-09
