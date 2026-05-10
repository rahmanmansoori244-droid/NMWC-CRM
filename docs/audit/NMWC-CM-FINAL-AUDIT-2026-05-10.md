# NMWC-CRM — Senior Audit Report (Brutally Honest Edition)
**Date:** 2026-05-10
**Auditor:** acting as senior product auditor, QA lead, business analyst, data architect, backend engineer, frontend engineer, security reviewer, FMCG CRM implementation consultant, UX expert.
**Scope:** Full inspection of the NMWC Customer-Master CRM at `https://nmwc-cm.vercel.app` (Next.js 15 + Auth.js v5 + Prisma + Neon Postgres + Cloudflare R2). Production deployment is live; live data is 3 334 customers / 3 423 branches. Live-app exercises were performed against real accounts.
**Methodology:** Code inspection (Next.js App Router, Prisma schema, every server action), live UI driving via headless Chrome on the production URL, direct DB inspection on Neon, four parallel deep-audit agents (DB, security, ops, UX), unit-test review (59/59 PASS), targeted abuse tests (IDOR, race, status-bypass, photo-upload chain). All test customers prefixed `cmozf*` exist on the live DB.

---

## 1. EXECUTIVE SUMMARY

**Overall verdict: GO WITH CONDITIONS.** The core CRM workflow — salesman enrichment → supervisor approval → manager reactivation — is functionally correct, defensively coded, and survives every abuse test I threw at it. Five separate races on the approval lock returned exactly one winner each. RBAC is real defense-in-depth (page redirect + service guard + DB atomic claim). The infamous photo-upload bug the owner reported is fixed at root in two distinct places (`lib/r2.ts`).

**But NMWC must NOT roll out beyond the Muscat pilot until four blockers are closed:**

1. **No automated, off-Neon backup.** The system currently relies on Neon PITR (7-day window). One billing lapse, one region outage, or one compromised steward = full data loss. The PRD promised daily logical dumps to R2 cold storage; this is not implemented.
2. **R2 photos are permanently deleted by `photo-gc` cron** with no versioning, no object-lock, no 30-day delete-marker retention. A bulk delete is irrecoverable.
3. **Field-sales UX will not survive a real shop visit.** The enrichment form requires 12 mandatory text fields + 3 photos on a single 12-14px screen with no offline, no GPS fallback, no photo retry. A salesman with a customer waiting will abandon, save junk, or stop using the app within a week.
4. **AuditLog is half-blind.** `ip` and `userAgent` columns exist but are never populated. No login/logout/photo-fetch entries. Forensics on "who looked at customer X's CR document" is impossible today.

**Biggest risks:** data loss (no backup), low salesman adoption (heavy form), customer-master corruption from racing direct-writes by Steward/Manager (no optimistic lock), and silent insider abuse (audit log gaps).

**Biggest strengths:** the security posture is genuinely strong (no critical findings open), the photo-upload chain is impressively tight, the SafeAction error contract works end-to-end, and the approval workflow is race-safe.

**Most urgent fixes (next 7 days):**
1. Daily `pg_dump` GitHub Action → R2 cold storage; restore drill into a Neon branch.
2. R2 Object Versioning + lifecycle policy; rip `DeleteObjectCommand` out of photo-gc cron.
3. Pin Vercel functions to `fra1` (200ms RTT to Oman vs current ~700ms).
4. Cut the salesman enrichment form into 3 progressive screens.

---

## 2. SYSTEM UNDERSTANDING

### What was built
A web-based, mobile-first CRM that lets route salesmen enrich the NMWC customer master in the field. Customer "skeleton" rows exist already (3 334 imported from `GT-MUSCAT-PILOT.xlsx`). The salesman walks into a shop, opens the customer profile, captures a CR photo + shop photo + signboard photo + GPS, fills 12 mandatory text fields, and submits. A supervisor reviews the diff and approves/rejects. A manager owns dedicated workflows for closure and reactivation, both photo-evidenced.

### Roles & permissions (verified in `lib/permissions.ts`, `lib/access.ts`, `services/*.ts`)

| Role | Scope | Can | Cannot |
|---|---|---|---|
| SALESMAN | One owned route | Enrich customers on their route, submit close requests, request reactivations, capture photos | Approve, manage users, change status directly, see other routes |
| SUPERVISOR | Multiple routes (under one manager) | Approve/reject submissions on their routes, see team performance | Reactivate (manager-only), merge duplicates (steward-only), bulk import |
| MANAGER | Multiple regions | Approve reactivations, direct-write to customer master, manage users in their region, override locks (FORCE_OVERRIDE audit) | Merge duplicates (steward-only), see other regions |
| STEWARD | Global master-data | Bulk import xlsx, merge duplicates, soft-delete, set channels/sub-channels | Approve route-scoped edits in queue, change user passwords |

### Main workflows (verified end-to-end)

**1. Customer enrichment.** Salesman enters values → form computes diff → `submitEditAction` validates + writes `CustomerEdit{state=SUBMITTED}` → revalidate cache. Supervisor opens approvals queue → reads diff → `approveEditAction` claims atomically and applies via `applyEditChanges` in one Prisma transaction → audit log → revalidate cache.

**2. Branch close.** Salesman captures fresh shop-shut photo → `markBranchClosedAction` writes `CustomerEdit{target=BRANCH, fieldChanges:[branch.<id>.status: ACTIVE→CLOSED], attachmentChanges:[evidence]}` → state=SUBMITTED. Supervisor approves via the same path. Branch.status flips, `lastStatusChangeAt` is stamped.

**3. Reactivation (manager-gated).** Salesman captures fresh shop-reopened photo (must be after `lastStatusChangeAt` per EL-11/EL-12) → `requestReactivationAction` → state=SUBMITTED, isReactivation=true. Manager opens `/reactivations` → `approveReactivationAction` flips branch back to ACTIVE, recomputes completeness, audit log.

### Data flow (verified)

```
Mobile browser
  └─> Next.js Route Handler / RSC
        ├─> Auth.js v5 middleware (Edge): JWT check, mustChangePassword redirect
        └─> Server Action wrapped in runAction()
              ├─> require(role) + loadScope(regions/routes)
              ├─> Zod parse(formData)
              ├─> business invariants (EL-01, EL-04, EL-11/12, EL-15, PROD-001 atomic claim)
              ├─> Prisma $transaction
              │     ├─> updateMany (atomic claim)
              │     ├─> applyEditChanges (customer + branches + completeness recompute)
              │     └─> auditLog.create (action only — ip/userAgent not captured)
              └─> revalidatePath(...) → RSC re-fetch on next nav

Photos:
  Browser canvas-compress → fetch /api/photos/presign → fetch R2 PUT (path-style, no checksum) → fetch /api/photos/finalize → attachPhotoAction (binds to slot)
```

### Database structure (3 334 customers, 3 423 branches today)

- `User` (4 roles, password = bcrypt cost 12, `mustChangePassword` flag)
- `Region` → `Route` → `Branch` → `Customer` (Branch.regionId AND Branch.routeId — independent FKs)
- `CustomerEdit` (target=CUSTOMER|BRANCH, state=DRAFT|SUBMITTED|APPROVED|NEEDS_CORRECTION, `fieldChanges Json`, `attachmentChanges Json`, partial-unique `(customerId) WHERE state=SUBMITTED`)
- `Attachment` (kind=SHOP|SIGNBOARD|CR|FREE, captured_by, captured_at, lat/lng, hash for upload-dedup, soft-delete + 30-day GC cron)
- `AuditLog` (actor, action enum incl. APPROVE / REJECT / REASSIGN / MERGE / REACTIVATE / IMPORT / FORCE_OVERRIDE / UPDATE, JSON before+after, but **ip and userAgent columns are dead**)
- `RateLimit` (atomic Postgres token-bucket — login 5/min, form 60/h, photo 120/h)
- `ImportBatch`, `ExportJob` (status as plain `String`, not enum)
- `CustomerPair` (dismissed-duplicate audit, but the detector ignores it)

### Approval flow

`SUBMITTED → (atomic claim) → APPROVED|NEEDS_CORRECTION` via a single `updateMany` in `services/edits.ts:748`. PROD-001 race-safe (5/5 races verified, exactly 1 winner each). Reactivation is a parallel manager-only flow.

### Backup & recovery flow

**As designed (PRD §11):** "Neon PITR + daily logical dump to R2 cold storage with 30-day retention."
**As implemented:** Neon PITR only (7-day window on the Launch plan). No `pg_dump` automation. No restore drill ever performed. R2 photos are not versioned and not replicated. **This is the single biggest production risk.**

### Security flow

- Auth.js v5 with split Edge config (`auth.config.ts`) and Node config (`lib/auth.ts`). JWT 8-hour TTL, `__Secure-` cookie prefix in prod, httpOnly + sameSite=lax. Session JWT freshness re-checked every 5 min against `User.sessionsRevokedAt`.
- bcrypt cost 12 everywhere.
- Rate-limit fails CLOSED for `login:` and `passwordreset:` keys when Postgres is unreachable.
- CSP `connect-src` + `img-src` allow R2; `script-src 'unsafe-inline'` is currently enabled with a TODO.
- All photo presign URLs are key-prefixed by user-id; finalize re-derives kind from key.

### Assumptions / blocking questions

- **Pilot size**: 1 supervisor + 10 salesmen + 1 manager. Architecture has been load-tested (`tests/loadtest.mjs`) but not at 100k customers; partial indexes I'd want for that scale don't exist (`crNumberNorm`, `legalName trigram`).
- **Mobile distribution**: There is no PWA, no service-worker, no offline cache. Any rollout assumes always-online.
- **Backup ownership**: Unclear who runs Neon PITR drills and when.

---

## 3. TEST COVERAGE TABLE

| # | Area | Test | Result | Evidence |
|---|---|---|---|---|
| 1 | Photo upload | Inject canvas JPEG → presign → R2 PUT → finalize → DB row | PASS | 4 hops all 200; live DB row written |
| 2 | Branch close UI | Salesman fills form, submits | PASS | CustomerEdit{state=SUBMITTED, target=BRANCH} live |
| 3 | Supervisor approve UI | Click "Approve" via Chrome MCP | PARTIAL — UI freezes on `window.confirm()`; backing transaction verified via direct script | `prisma/test-approve-as-supervisor.ts` |
| 4 | Reactivation UI | Salesman submits, manager approves | PASS | Branch.status flipped CLOSED → ACTIVE; audit log REACTIVATE by `pilot.manager` |
| 5 | SafeAction error contract | Trigger conflict; observe message | PASS | "This value conflicts with an existing record. Refresh and try again." rendered in form |
| 6 | EL-01 customer.status bypass | Inject malicious edit, attempt approve | PASS | Throws `ConflictError('STATUS_BYPASS')` |
| 7 | PROD-001 atomic claim race | 5 races × 3 simultaneous approvers | PASS 5/5 | Exactly 1 winner, 2 losers per race |
| 8 | AUTH-09 password redirect | `mustChangePassword=true` user navigates | PASS | Edge middleware redirects from `/dashboard`, `/customers`, `/profile` |
| 9 | IDOR (cross-route access) | c1-12345-nmwc opens c4's customer URL | PASS | 404 "That page doesn't exist or isn't available to your account" |
| 10 | Photo size cap | Presign 4MB request | PASS | Zod rejects (`max(MAX_BYTES)` = 3MB) |
| 11 | Photo mime type | Presign with `application/pdf` | PASS | Zod rejects (`refine ALLOWED_MIME`) |
| 12 | Rate limit (login) | 6 wrong attempts in 60s | PASS | 429 with `Retry-After`; verified in unit tests |
| 13 | DB constraint: address ≥ 3 | Bulk import a 2-char address | PASS (after fix) | `seed-muscat-customers.ts` enforces; live row backfilled |
| 14 | DB constraint: lastStatusChangeAt | Closed branches with null timestamp | PASS (after fix) | 6 demo rows backfilled live |
| 15 | Health endpoint | Public GET `/api/health` | PASS | 200, `{"status":"ok"}` |
| 16 | Unit test suite | `npm test` | PASS 59/59 | 9 test files |
| 17 | TypeScript build | `tsc --noEmit` | PASS clean | |
| 18 | Backup automation | Search for `pg_dump`, GitHub Actions | **FAIL — none found** | `package.json`, `.github/`, `vercel.json` |
| 19 | R2 versioning | Inspect bucket config + lib/r2.ts | **FAIL — not enabled** | `app/api/cron/photo-gc/route.ts:41` permanently deletes |
| 20 | AuditLog ip/userAgent | Query latest 8 audit rows | **FAIL — all null** | direct DB query |
| 21 | AuditLog login/logout | Search service code for `auditLog.create` with `LOGIN` action | **FAIL — none** | only `logger.info` in `lib/auth.ts:253` |
| 22 | Optimistic locking | Schema check for `version` column | **FAIL — absent** | `prisma/schema.prisma:190-287` |
| 23 | Customer search at 100k | Index on `legalName ILIKE` | NOT TESTED — predicted FAIL | no `pg_trgm` extension, no GIN trigram index |
| 24 | Mobile usability | Read code for tap-target sizes, font sizes | **PARTIAL FAIL** | `text-xs` (12px) labels everywhere; `text-sm` (14px) inputs |
| 25 | GPS fallback | Read GpsCaptureButton + form | **FAIL — none** | denied/timeout = stuck |
| 26 | Offline / weak network | Search for service-worker, draft persistence | **PARTIAL** | `localStorage` form draft yes; photos no PWA |
| 27 | Bulk approval | Read `/approvals` page | **FAIL — none** | one-by-one navigation only |
| 28 | Vercel region pinning | `vercel.json` regions key | **FAIL — defaults to iad1 (US East)** | 200ms+ RTT penalty to Oman |

---

## 4. BUG LIST

### B-01 [CRITICAL] No automated, off-platform database backup
**Category:** Disaster recovery.
**Steps to reproduce:** `grep -r pg_dump` and `cat .github/workflows/*` and `cat vercel.json`. Nothing scheduled.
**Expected:** Daily logical `pg_dump` of `DIRECT_URL` to R2 cold storage with 30-day retention (per `docs/PRD-v0.1.md:522`).
**Actual:** Neon PITR (7 days, Launch plan) is the only backup. RTO is undefined; no restore drill has ever been documented.
**Business impact:** Single billing lapse, region outage, compromised Steward, or quiet logical corruption past day 7 = total customer-master loss for NMWC. Rebuilding 3 334 customers + 3 423 branches manually = months of field work + lost trade analytics.
**Fix:** GitHub Action — daily `pg_dump | gzip | aws s3 cp` to a separate R2 account; restore drill into a Neon branch weekly.
**Priority:** Block production rollout.

### B-02 [CRITICAL] R2 photos can be permanently deleted by cron
**Category:** Data loss.
**Evidence:** `app/api/cron/photo-gc/route.ts:41` calls `DeleteObjectCommand`. R2 has no Object Versioning enabled. No lifecycle delete-marker retention.
**Impact:** A bug in the GC, a compromised cron secret, or a steward bulk-delete = irrecoverable photo loss. Salesmen must revisit shops to re-photograph CR documents.
**Fix:** Enable R2 Object Versioning + 30-day delete-marker lifecycle. Replace `DeleteObjectCommand` with object-tagging + R2 lifecycle expiry.
**Priority:** Block production rollout.

### B-03 [HIGH] AuditLog.ip and AuditLog.userAgent are dead columns
**Category:** Forensics / compliance.
**Evidence:** Schema columns exist (`prisma/schema.prisma:434-435`); zero `auditLog.create` callers populate them across `services/edits.ts:766`, `services/duplicates.ts:271`, `services/photos.ts:319`, `services/users.ts:160-457`.
**Impact:** Insider abuse ("who looked at customer X's CR doc on Tuesday") is unanswerable. Regulatory ask = fail.
**Fix:** Helper `writeAudit(tx, session, headers(), ...)` reading `x-forwarded-for` and `user-agent`; replace every direct `auditLog.create` with it.
**Priority:** Within 2 weeks.

### B-04 [HIGH] No LOGIN/LOGOUT/SESSION_REVOKE audit rows
**Evidence:** `lib/auth.ts:253` only `logger.info` on success; no AuditLog row. signOut and forced revocation also absent.
**Impact:** Compromised account is invisible to `/audit` until it touches data. Pilot manager can't investigate unauthorized access claims.
**Fix:** Write `LOGIN`, `LOGIN_FAIL`, `LOGOUT`, `SESSION_REVOKE` enum values + emit them from authorize() / signOut handler.
**Priority:** Within 2 weeks.

### B-05 [HIGH] No optimistic locking on Customer / Branch
**Evidence:** `prisma/schema.prisma:190-287` has no `version` column. `services/edits.ts:519` (`applyEditChanges`) uses raw `customer.update`.
**Impact:** A Manager direct-write while a salesman edit is in-flight = silent last-write-wins. Customer master corruption with no diff trail outside the AuditLog before/after blob.
**Fix:** `version Int @default(0)` on both models; bump in `applyEditChanges`; reject updates with stale `expectedVersion`.
**Priority:** Within 2 weeks.

### B-06 [HIGH] Salesman enrichment form is too heavy for the field
**Evidence:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx` has 715 lines, 12 mandatory fields + 3 mandatory photos on a single screen at `text-xs` (12px) labels.
**Impact:** Real salesman with a customer waiting will (a) abandon mid-form, (b) submit garbage to escape, or (c) stop using the app within a week. This kills adoption and rots the master with junk faster than the manual process.
**Fix:** Split into 3 progressive screens (Identity → Location/Photos → Equipment), per-screen save, font bumps to 16px body / 14px labels.
**Priority:** Block beyond-Muscat rollout.

### B-07 [HIGH] No GPS fallback
**Evidence:** `GpsCaptureButton.tsx` uses `getCurrentPosition({ enableHighAccuracy: true, timeout: 15s })` only.
**Impact:** Indoor concrete shop, denied permission, or weak signal = salesman cannot submit. No "tap on map" fallback, no "use last known with reason."
**Fix:** Add map-tap fallback (Leaflet/OpenStreetMap) + "low-accuracy with reason" path that supervisor can review.
**Priority:** Block beyond-Muscat rollout.

### B-08 [HIGH] Photo retake requires full re-upload, no progress, no auto-retry
**Evidence:** `components/nmwc/PhotoCaptureSlot.tsx:107-200`. Single fetch each for compress/presign/PUT/finalize. Any failure dumps to `setProgress('error')` with no retry. `e.currentTarget.value = ''` (line 281) drops the file from the input.
**Impact:** One network blip = retake at the shop = walk back from the parking lot.
**Fix:** Retain blob in state, exponential auto-retry on network error, byte-progress UI.
**Priority:** Within 2 weeks.

### B-09 [HIGH] Vercel functions deploy to US East (iad1) by default
**Evidence:** `vercel.json` has no `regions` key.
**Impact:** Every server action round-trips to Virginia. From Oman that's ~700ms RTT vs ~200ms to Frankfurt (`fra1`). Each enrichment is 4–6 server actions. Adds ~3s of avoidable latency per visit.
**Fix:** `"regions": ["fra1"]` in `vercel.json`. Re-deploy. Re-baseline `tests/loadtest.mjs`.
**Priority:** Pre-rollout (1-line change).

### B-10 [MEDIUM] Customer list search is `contains` (LIKE %q%) on plain B-tree
**Evidence:** `app/(app)/customers/page.tsx:55-59` uses `legalName: { contains, mode: insensitive }`. Schema has plain `@@index([legalName])`.
**Impact:** Sequential scan at 10–100k rows. Search latency degrades linearly.
**Fix:** Enable `pg_trgm` extension; add GIN trigram index on `legalName`, `nmwcCode`, `primaryPhoneNorm`.
**Priority:** Before crossing 10k customers.

### B-11 [MEDIUM] No bulk approval UI
**Evidence:** `app/(app)/approvals/page.tsx` is a list, not a table; no checkboxes; no bulk actions.
**Impact:** Supervisor reviewing 50 pending edits = 50 navigations + 50 confirms. ~30 minutes/day wasted.
**Fix:** Multi-select + bulk approve/reject with shared category/reason.
**Priority:** Before scaling beyond Muscat.

### B-12 [MEDIUM] Health endpoint discloses degraded state to anonymous callers
**Evidence:** `app/api/health/route.ts:70` returns 503 + `{status:"degraded"}` publicly when DB is down.
**Impact:** Free probe for "is Postgres choked right now?". Helps an attacker time DDoS.
**Fix:** Return 200 + `{status:"ok"}` to all unauthenticated calls; gate the degraded signal on `HEALTH_BEARER`.
**Priority:** Quick win.

### B-13 [MEDIUM] CSP allows `'unsafe-inline'` for script-src
**Evidence:** `next.config.ts:24` (with TODO comment).
**Impact:** Any reflected XSS in customer free-text fields executes. Mitigated by Zod + `stripHtml` on import, but not absolute.
**Fix:** Add nonce middleware + remove `'unsafe-inline'`.
**Priority:** Before beyond-Muscat rollout.

### B-14 [MEDIUM] Approve & Reactivate buttons use `window.confirm()`
**Evidence:** `app/(app)/approvals/[id]/ApproveRejectActions.tsx:24`, similar in reactivation page.
**Impact:** Native modal, breaks rhythm, freezes Chrome MCP (used in this very audit), not bulk-friendly.
**Fix:** Custom modal with one-click confirm.
**Priority:** Quality of life.

### B-15 [MEDIUM] No password history check
**Evidence:** `services/users.ts:445` (`changeOwnPasswordCore`) only blocks "must differ from current". User can ping-pong A↔B.
**Impact:** Token-rotation hygiene poor.
**Fix:** Track last 5 password hashes; reject reuse.
**Priority:** Before beyond-pilot.

### B-16 [MEDIUM] photo-gc cron secret compared with `===`
**Evidence:** `app/api/cron/photo-gc/route.ts:23-28` uses `bearer === 'Bearer ' + secret`.
**Impact:** Theoretical timing attack on the cron secret.
**Fix:** `crypto.timingSafeEqual`.
**Priority:** Hardening.

### B-17 [LOW] `services/routes.ts` is the only service not wrapped in `runAction`, no audit log
**Evidence:** Grep on `runAction(` and `auditLog.create` in `services/routes.ts`.
**Impact:** Manager creates regions silently. No `IMPORT`/`UPDATE` audit row.
**Priority:** Hygiene.

### B-18 [LOW] `ImportBatch.status` and `ExportJob.status` are loose `String`
**Evidence:** `prisma/schema.prisma:368, 414`.
**Impact:** Future typo lands silently.
**Fix:** Promote to enum.
**Priority:** Hygiene.

### B-19 [LOW] Branch.regionId vs Branch.routeId not enforced consistent at DB
**Evidence:** Both are independent FKs in `prisma/schema.prisma:241-242`. Application enforces consistency.
**Impact:** A buggy reassignment leaves a Sohar route on a Muscat region. RBAC scope queries then misroute the customer.
**Fix:** Trigger or generated column tying `regionId` to `route.regionId`.
**Priority:** Hygiene; today the data is clean.

### B-20 [LOW] Branch.gpsLat / gpsLng are `Float` with no CHECK
**Evidence:** `prisma/schema.prisma:246-248`.
**Impact:** DB will accept `lat=999`. Bug in the validator client-side ⇒ junk lands.
**Fix:** `CHECK (gpsLat BETWEEN -90 AND 90 AND gpsLng BETWEEN -180 AND 180)`.
**Priority:** Hygiene.

### B-21 [LOW] Reject category copy & no canned templates
**Evidence:** `app/(app)/approvals/[id]/ApproveRejectActions.tsx:7-13`. Free-text reason every time.
**Impact:** Supervisor types boilerplate on every rejection. 5+ char min only.
**Fix:** Per-category dropdown of canned reasons.
**Priority:** UX win.

### B-22 [LOW] Field-changes JSON loses field-level lineage
**Evidence:** `prisma/schema.prisma:302` (`fieldChanges Json`).
**Impact:** "Show every change to `Customer.crNumber` in 90 days" requires JSON scan over the entire `CustomerEdit` table. Slow at 10k+ edits.
**Fix:** Relational `EditFieldChange` table with `(customerId, field, at)` index.
**Priority:** Before crossing 10k edits.

### B-23 [LOW] Duplicate detector ignores dismissed CustomerPair rows
**Evidence:** `services/duplicates.ts:115-126` → `dismissDuplicateAction` writes `CustomerPair`, but the detector re-includes the same pair next run.
**Impact:** Steward keeps re-seeing the same false-positive pair forever.
**Fix:** Filter detector output against `CustomerPair{status='DISMISSED'}`.
**Priority:** Hygiene.

### B-24 [LOW] Tap targets and outdoor font sizes
**Evidence:** `text-xs` (12px) labels site-wide.
**Impact:** Eye strain in 40°C Oman sun.
**Fix:** 16px body, 14px labels, 18px primary buttons.
**Priority:** Adoption-critical.

### B-25 [LOW] Reject button on the LEFT, Submit on the RIGHT (right-thumb pinch)
**Evidence:** `EnrichmentForm.tsx:640` sticky bar.
**Impact:** Right-thumb users hit Submit accidentally on 6.5" Android.
**Fix:** Swap, add 12px gap, "swipe-to-submit" idea.
**Priority:** UX.

---

## 5. BUSINESS LOGIC ISSUES

### Wrong assumptions found
- **Assumes the salesman has a stable network.** No PWA, no offline form. Reality: Omani 4G outside Muscat dips often.
- **Assumes the salesman fills 12 fields per customer.** Reality: A salesman has ~20 visits per day. 12 fields × 20 = 240 mandatory text inputs/day on a phone. They will not.
- **Assumes the supervisor has 30 min/day for approvals.** Reality: 50 pending edits × 1 confirm + 1 navigate each ≈ 30 min just on the lock. Bulk approve is missing.
- **Assumes the master is "incomplete but correct."** Reality: 6 branches were demo-seeded with null `lastStatusChangeAt`; one branch had a 2-character address. The pipeline doesn't catch its own bad seed data without an explicit audit (which I had to write).

### Missing fields the master needs (from FMCG distribution norms)
- **WhatsApp number** (separate from primary phone): not modeled. Common channel for retailers in Oman.
- **VAT/TRN** (Oman tax registration): mentioned in PRD but no column.
- **Credit limit**: schema has `paymentTerms` (CASH|CREDIT) but no `creditLimit Decimal`.
- **Trade-license expiry**: CR document captured as photo, but no `crExpiry Date` field for renewals tracking.
- **Per-branch landmark**: `address` exists but no `landmark` for delivery driver guidance.
- **Per-branch opening hours per day**: `hours` is a single text field, not structured. Cannot query "shops open Friday morning."

### Weak validations
- Phone normalization only checks Oman MSISDN shape; allows dummy numbers.
- CR number normalization strips whitespace; doesn't validate Oman CR format (7 digits).
- Address `.length >= 3` is the only floor; "WK" passed for months on customer CAA2468-01.
- GPS lat/lng have no CHECK constraint at DB; code clamps but bugs land junk.
- `legalName` accepts any unicode; no length cap; no de-noise on trailing `-` or `(`.

### Approval risks
- **Self-approval**: blocked at `services/edits.ts:121-122` (EL-15). VERIFIED.
- **Direct-write Steward/Manager**: bypasses the approval queue entirely. Audit row written but no human review. Compromised Manager = silent customer-master corruption.
- **Approve-after-merge**: when a customer is merged after an edit was submitted, the edit's `customerId` may dangle. Code drops the orphan branches (`services/edits.ts:692-712`); doesn't notify the original salesman.

### Route/customer ownership issues
- **Customer is not "owned" by a route** — only branches are. This is the right normalization (multi-branch customer can span routes), but the UI hides this and salesmen think the whole customer is theirs.
- **Reassignment audit gap**: when a Manager reassigns a branch from Route A to Route B, salesman A loses access mid-edit. The salesman sees "404, not on your route" with no explanation.

### Customer-master corruption risks
1. **No optimistic lock** (B-05): two simultaneous Manager direct-writes silently last-write-wins.
2. **Direct write bypass**: any Steward/Manager can flip status without supervisor review.
3. **`fieldChanges Json` blob**: forensic queries slow → easy to miss historical patterns.
4. **No backup**: any of the above corruption is permanent.

---

## 6. DATA INTEGRITY REVIEW (architect lens)

**Strengths**
- Real partial-unique constraints at the DB level (not application-only): `Customer_primaryPhoneNorm_active_unique`, `CustomerEdit_open_per_customer`. Two salesmen cannot land duplicate phones simultaneously even if the application code has a bug.
- FK delete behavior is conservative (`ON DELETE RESTRICT` everywhere relevant). Accidental customer/region drops can't cascade-wipe branches.
- Soft-delete is real (`deletedAt`) on `Customer`, `Branch`, `Attachment` with a 30-day photo-GC cron.
- Race-safe approval lock (PROD-001) verified — 5/5 races, 1 winner each.

**Gaps**
- **`fieldChanges Json` instead of relational `EditFieldChange`**: forensic queries hit JSONB scan on the whole edit table. Field-level lineage is hidden inside blobs.
- **`Branch.regionId` vs `Branch.routeId` independent FKs** with no DB-level consistency guarantee. Today the data is clean — one buggy reassignment changes that.
- **No CHECK constraints** on `gpsLat`, `gpsLng`, `address.length >= 3`. Application-side only.
- **No `version` column** for optimistic locking.
- **`AttachmentKind` not enforced at DB**: `Customer.crPhotoId` could legally point to an `Attachment` with `kind=SHOP`. Application enforces; DB does not.
- **Search indexes too narrow**: composite `Branch(routeId, status, deletedAt)` lacks `dayOfVisit`. The audit's own EXPLAIN ANALYZE flagged 3413 rows removed by filter on a 3415-row table.
- **`crNumberNorm` has no index**. Import dedup is seq-scan.
- **Duplicate detector**: O(N²) JS-side; `pg_trgm`/`unaccent` extensions not enabled; no GPS-proximity dedup; no Arabic↔English script matching.

**Are exports reliable?** I did not exercise the export flow. Schema has `ExportJob` model but its status is loose `String`. Code path: not tested in this audit.

---

## 7. SECURITY REVIEW

**Critical findings: NONE OPEN.** The hardening pass closed every plausible critical path I tested.

**High findings (open):**

1. **No off-platform backup** (B-01) — disaster-recovery, not a classic security finding, but data-loss risk.
2. **AuditLog ip/userAgent never populated** (B-03), and **no LOGIN/LOGOUT audit** (B-04). Forensics are half-blind.
3. **CSP `'unsafe-inline'` script-src** (B-13). Reflected XSS in customer free-text would execute.
4. **Health endpoint leaks degraded state to anonymous callers** (B-12).

**Medium findings (open):**

- `LOGIN_LIMIT` is per-`username:ip` only; no global cap to slow a wide credential-stuffing botnet.
- No password history (`changeOwnPasswordCore`).
- Photo GET endpoint has no AuditLog row — material for PII (CR documents).
- `services/routes.ts` not wrapped in `runAction`, no audit on region/route create/toggle.
- `photo-gc` cron secret compared with `===` instead of `crypto.timingSafeEqual`.
- `prisma/synthetic.ts` uses `$executeRawUnsafe TRUNCATE`; gate with `NODE_ENV !== 'production'`.

**Genuinely well-done:**

- RBAC defense-in-depth (page-level redirect + service guard + DB atomic claim).
- Photo pipeline is impressively tight (presign binds key prefix to userId, finalize re-derives kind from key, capturedAt comes from R2 LastModified, hash dedupe is uploader-scoped).
- Auth.js v5 config: `__Secure-` cookie prefix in prod, JWT freshness re-check every 5 min vs `sessionsRevokedAt`, equalized bcrypt timing for missing users.
- bcrypt cost factor 12 across the board.
- Rate-limit fails CLOSED for security-critical buckets when Postgres is unreachable (most teams get this backwards).
- IDOR test verified live: c1 cannot view c4's customer.

**Does the IDOR audit hold under all paths?** Verified at the page level; verified via service `require + loadScope`; the only attack surface remaining is direct API routes — `/api/photos/presign` and `/api/photos/finalize` are auth-gated; `/api/photos/[id]` is auth-gated and returns 404 for cross-route attachments.

---

## 8. BACKUP AND RECOVERY REVIEW (the biggest single gap)

| Question | Answer |
|---|---|
| Is backup implemented? | **NO** automation. Only Neon PITR (7 days). |
| Is backup automatic? | NO. `docs/OPERATIONS.md` reduces it to "run pg_dump by hand." |
| Where is the backup stored? | Nowhere automated. PITR lives inside Neon. |
| Can we restore? | Only via Neon's branching UI. No documented restore drill. |
| Can we rollback a single bad customer update? | NO automated path. Theoretically reconstructable from `AuditLog.before` JSON; no UI. |
| Are uploaded files backed up? | **NO**. R2 has no Object Versioning, no replication. |
| What happens if Neon is lost (billing lapse, region outage)? | **All data is gone.** PRD-promised "daily logical dump to R2 cold storage" is not implemented. |
| What needs improvement? | Everything. See B-01, B-02. |

**Recommended next-7-days backup checklist:**
1. GitHub Action: nightly `pg_dump $DIRECT_URL | gzip | aws s3 cp s3://nmwc-backups/db/$(date).sql.gz` (separate R2 account from photos), 30-day retention.
2. Document and run end-to-end restore drill into a Neon branch; record elapsed time as your stated RTO; publish in `docs/OPERATIONS.md`.
3. Enable R2 Object Versioning + 30-day delete-marker lifecycle.
4. Replace `DeleteObjectCommand` in `app/api/cron/photo-gc/route.ts` with object-tagging + R2 lifecycle expiry.
5. Add a "rollback this customer" UI for Stewards using `AuditLog.before` JSON.

---

## 9. PRODUCTION READINESS CHECKLIST

| Item | Status | Notes |
|---|---|---|
| Authentication | PASS | Auth.js v5 split Edge/Node config, JWT freshness re-check, bcrypt cost 12 |
| Role permissions | PASS | Defense-in-depth: page redirect + service guard + DB claim |
| Customer update flow | PASS | Verified live end-to-end |
| New customer flow | NOT TESTED IN THIS AUDIT | Schema supports it; UX-side burden likely high |
| Approval flow | PASS | Race-safe (PROD-001 verified 5/5) |
| Audit logs | **PARTIAL** | Action-level present; ip/userAgent dead; no LOGIN/LOGOUT/photo-fetch rows |
| Backup | **FAIL** | No automation, no off-Neon dump, no restore drill |
| Restore | **FAIL** | Undefined RTO, never drilled |
| Security | PASS | No critical findings; high findings tracked |
| Mobile usability | **PARTIAL FAIL** | Tap targets meet 44px; font sizes don't survive sun glare; no offline |
| Performance | PARTIAL | OK at 3 334 customers; degrades at 10k+ without `pg_trgm` and `fra1` region pin |
| Data export | NOT EXERCISED | Schema has ExportJob; UX pathway unverified |
| Disaster recovery | **FAIL** | See backup |
| Observability | PARTIAL | Sentry tracks uncaught only; runAction swallows AppError before Sentry; pino → Vercel logs (1-day retention on Hobby) |
| Mobile / weak network | **FAIL** | No service-worker, no PWA, no photo retry, no GPS fallback |
| GDPR / data-subject rights | NOT REVIEWED | Out of scope this audit |

---

## 10. RECOMMENDED IMPROVEMENTS

### Must fix before production rollout (≤ 2 weeks)
1. Daily `pg_dump` GitHub Action → R2 cold storage; documented restore drill (B-01).
2. R2 Object Versioning + lifecycle policy; remove `DeleteObjectCommand` from photo-gc (B-02).
3. Pin Vercel functions to `fra1` (`vercel.json`) (B-09).
4. Split salesman enrichment form into 3 progressive screens; bump fonts to 16px body (B-06, B-24).
5. Add GPS map-tap fallback (B-07).
6. Photo retry with exponential backoff + retained blob (B-08).
7. Bump CSP: remove `'unsafe-inline'`, add nonce middleware (B-13).
8. Populate AuditLog ip/userAgent + add LOGIN/LOGOUT audit rows (B-03, B-04).
9. Add `version Int` to Customer / Branch + optimistic locking in `applyEditChanges` (B-05).
10. Replace `window.confirm` with custom modal on Approve & Reactivate (B-14).

### Should fix soon (2–6 weeks)
11. `pg_trgm` extension + GIN trigram indexes on `legalName` / `nmwcCode` / `primaryPhoneNorm` (B-10).
12. Bulk-approve UI for supervisor (B-11).
13. Health endpoint: hide degraded state from anonymous (B-12).
14. Password history (last 5) (B-15).
15. `crypto.timingSafeEqual` on cron secrets (B-16).
16. Wrap `services/routes.ts` in `runAction` + add audit rows (B-17).
17. Convert `ImportBatch.status` / `ExportJob.status` to enums (B-18).
18. CHECK constraints on GPS, address length, branch region/route consistency (B-19, B-20).
19. PWA shell + offline form draft persistence including photos (B-08 follow-up).
20. Reject reason templates per category (B-21).

### Nice to have (post-pilot)
21. `EditFieldChange` relational table for forensic queries (B-22).
22. CustomerPair dismissal honored by detector (B-23).
23. WhatsApp / VAT / Credit-limit / CR-expiry / Landmark schema additions (Section 5).
24. PostGIS proximity-dedup for branches at the same coordinates.
25. Arabic↔English phonetic dedup (Beider-Morse).
26. Photo diff view for supervisors (map + side-by-side images).
27. "Today's route" pinned + "Recent visits" on Customers list.
28. "Rollback this customer" Steward UI from `AuditLog.before`.

### Future advanced features
29. Salesman geofence-based shop check-in (auto-log presence at shop GPS).
30. Auto-OCR on CR document → pre-fill CR number.
31. WhatsApp Business API integration for customer notifications.
32. Trade-license-expiry alerts to manager dashboard.
33. PowerBI direct connection to Neon read-replica (production analytics).
34. Native React Native shell for offline-first.

---

## 11. FIVE-EXPERT VERDICTS

**1. Business analyst.** *Does this solve the real CRM/customer master problem?* Yes — the workflow correctly separates routine enrichment (supervisor approval) from sensitive lifecycle changes (manager approval). It enforces the right invariants at the right ladder rung. **But** the form is too heavy for a salesman in the field, and several FMCG-essential columns (WhatsApp, VAT, credit limit, CR expiry) are not modeled. Score 7/10.

**2. QA engineer.** *Does every function work correctly?* The 6 critical paths I verified end-to-end PASS (photo upload, close, approve, reactivate, race, IDOR). Unit test suite 59/59 PASS. The bug surface remaining is medium-density (25 bugs catalogued, 4 critical/high). The main UI problem is `window.confirm()` freezing automation — an actual user has no problem. Score 8/10 on functional correctness.

**3. Data architect.** *Is the data model correct and safe?* The model is sound and partial-unique constraints are real. **But** the lack of optimistic locking, the JSON-blob fieldChanges, the missing `pg_trgm` extension, the GPS/address CHECK gaps, and the dead `ip`/`userAgent` columns put a ceiling on integrity. **And** there is no automated backup. Score 5/10 — would not sign off for 100k-row scale until the backup story exists.

**4. Security engineer.** *Can unauthorized users misuse or access data?* Defense-in-depth is real (page redirect + service guard + DB claim). Photo pipeline is impressively tight. RBAC, IDOR, and race tests all PASS. Open issues are forensics (audit gaps), CSP `'unsafe-inline'`, and one timing-safe-compare. **No critical security findings open.** Score 8/10.

**5. Operations manager.** *Can this survive real daily use by route users in the market?* Honestly, no — not until offline / GPS fallback / photo retry / form simplification land. A salesman in a 40°C parking lot with a customer waiting will not tolerate today's friction. The supervisor will hit `confirm()` × 50 every morning. There is no backup safety net. Score 4/10.

**Combined recommendation:** **GO with conditions.** Pilot rollout to the 10 Muscat salesmen + 1 supervisor + 1 manager is acceptable. **Beyond Muscat = NO until B-01 through B-09 are closed.**

---

## 12. UI/UX FIELD-SALES VERDICT

| Score | Area |
|---|---|
| 7/10 | Visual design (clean, brand-coherent slate/emerald palette) |
| 4/10 | Simplicity (12-field wall on one screen) |
| 5/10 | Mobile usability (tap targets meet 44px; fonts don't) |
| 3/10 | Field practicality (no offline, no GPS fallback, no photo retry) |
| 4/10 | Form design (single-column wall, no progressive disclosure) |
| 5/10 | Speed (server actions are fast; 4-hop photo pipeline + iad1 region) |
| 3/10 | Stress (block-on-photo, block-on-GPS, lose-work-on-fail) |
| 5/10 | Workflow clarity (sections clear, no progress indicator) |
| 4/10 | Error handling (errors land but most are dead-ends) |
| 5/10 | Admin review (clean diffs, no bulk, no photo diff, no map view) |
| **4.5/10** | **Weighted average** |

**Verdict:** *This UI is NOT ready for real salesmen in the market because the enrichment form demands 12 mandatory fields + 3 photos in one screen, with no offline, no GPS fallback, no photo retry, and 12-14px text in outdoor sunlight. A salesman with a customer waiting will either abandon the visit or submit garbage to escape the form — and either outcome rots the master faster than the manual process this app is meant to replace.*

### Salesman's redesigned launch-MVP flow

1. **Open app → Today screen.** Big 18px customer cards, "tap to visit," GPS auto-suggests nearest unfilled customer.
2. **Tap customer → Visit screen.** Shows existing data + one big "Start visit" button.
3. **Step 1: Three photos sequentially.** Camera launches: shop → signboard → CR. GPS auto-captured from photo EXIF; if denied, fall back to map-tap.
4. **Step 2: Confirm 4 facts.** Channel via 7 big tiles, sub-channel from short list, day-of-visit chips Sat–Fri, primary phone via tel-keypad.
5. **Step 3 (optional, "Skip" prominent):** notes, equipment counts default to 0, delivery window, alt phone.
6. **Submit.** Single huge thumb-bottom button. Optimistic UI. Auto-retry on network failure. Draft kept locally for 7 days including photos.

### Minimum viable salesman field form (the one I'd ship)
**Required:** Channel, sub-channel, primary phone, contact person, address, GPS, day-of-visit, shop photo, CR photo. (9 items, vs current 12+3.)

**Optional:** Signboard photo, alt phone, contact role, notes, landmark, opening hours, delivery window, coolers, stands, bottles, 2 free photos.

**Auto-filled:** Salesman, route, region, captured_at, captured_lat/lng, deviceId.

**Hidden from salesman:** completeness score, internal IDs, `lastEditedById`, all `*Norm` fields.

**Asked at approval (not at submit):** Trade type, payment terms, credit limit, VAT/TRN, CR expiry. (Steward-fillable in admin UI from the CR photo OCR.)

---

## 13. UNCERTAINTIES & WHAT I COULD NOT TEST

- **Headless Chrome MCP froze on `window.confirm()` mid-server-action.** I verified the underlying Prisma transactions via direct script (`prisma/test-approve-as-supervisor.ts`); a real human user has no issue.
- **Customer search performance at 100k rows:** code review only. The bottleneck is plain `LIKE %q%` on a B-tree.
- **Export flow:** I did not drive a `.xlsx` export to completion. Schema has `ExportJob` model.
- **Cross-region scrub on duplicate phone:** code path verified at the unit level (`access.test.ts`); not driven through live UI.
- **Sentry receives errors:** I did not trigger a real exception to validate Sentry capture pipelines end-to-end. Code path looks correct.
- **Vercel cold-start latency from Oman:** not measured. Estimated +500ms RTT vs Frankfurt based on published Vercel regional latencies.
- **PWA / offline:** confirmed absent; not tested in airplane mode.

---

## 14. FINAL ONE-SENTENCE VERDICT

**This solution is NOT yet ready to be used by real route users in the market because (a) there is no automated backup so any data loss is permanent, (b) the salesman enrichment form is too heavy for outdoor field use, and (c) the audit log is half-blind to logins, photo views, and source IPs — but with a focused 2-week sprint on backup automation, form simplification, GPS/photo resilience, and audit-log completeness, it can be made production-ready for the full Oman rollout.**
