# Production load test + 5 expert bug-hunt

**Date:** 2026-05-09
**Target:** https://nmwc-cm.vercel.app · commit `ab09b7a`+
**Method:** 10 concurrent virtual users (all 5 roles) exercising every major workflow + targeted bug-hunting in parallel.

---

## 1) Heavy-duty load test result

| Metric | Value |
|---|---|
| Concurrent users | 10 (4 salesmen, 2 supervisors, 2 managers, 1 steward, 1 viewer) |
| Total HTTP calls | **81** |
| 5xx errors | **0** |
| Timeouts (>9s) | **0** |
| Top-level exceptions | **0** |
| Wall time | 11 s |
| Latency p50 | 757 ms |
| Latency p95 | **3,089 ms** |
| Latency p99 | 4,081 ms |
| Latency max | 4,081 ms (login under burst) |

**Pages exercised**: `/login`, `/today`, `/customers`, `/customers/<id>`, `/customers/<id>/edit`, `/work`, `/rejected`, `/profile`, `/approvals`, `/approvals/<id>`, `/team`, `/dashboard`, `/users`, `/routes`, `/audit`, `/reactivations`, `/import`, `/export`, `/duplicates`, `/api/exports/customers` (with and without filters).

**Verdict:** the app is functionally stable under 10× concurrent load. Login is the slowest call by far (~3–4 s per attempt) because every login does two Postgres rate-limit transactions + bcrypt + Prisma user lookup + Prisma user update. Acceptable for the 38-route population (one login per shift). Could be optimised by parallelising the rate-limit reads and skipping the lastLoginAt update on every login.

The driver itself is at `tests/loadtest.mjs` and re-runnable.

---

## 2) Five expert production bugs

Numbered in order of business risk for go-live.

### PROD-001 — Concurrent approve race (Supervisor double-decision possible)

**Severity:** High · **Confidence:** Confirmed by code review

**File:** `services/edits.ts:368-454`

**The bug:**
```ts
const edit = await prisma.customerEdit.findUnique({ ... });   // OUTSIDE tx
if (edit.state !== EditState.SUBMITTED) throw ConflictError;  // OUTSIDE tx
// ... lots of logic ...
await prisma.$transaction(async (tx) => {
  await applyEditChanges(tx, ...);                            // INSIDE tx
  await tx.customerEdit.update({ ... state: APPROVED });
  await tx.auditLog.create({ ... });
});
```
The "is it still SUBMITTED?" check happens outside the transaction. Two parallel `approveEditAction` calls (e.g., a Supervisor refreshing the queue twice and double-tapping Approve, or two Managers acting at once) can both pass the check, both run the transaction. Inside the tx, both succeed in updating the edit row's state from SUBMITTED to APPROVED. The customer fields are written twice (idempotent — same values). **Two AuditLog rows are created** for what should be a single decision, and `applyEditChanges` runs twice (recomputing completeness twice).

**Repro (live verification not run — would require RSC action ID extraction):**
```bash
# In two parallel shells, both POST the approve action for the same editId.
# Observe two AuditLog rows with action=APPROVE for the same entityId.
```

**Fix:** Move the state check inside the transaction with `SELECT ... FOR UPDATE`:
```ts
await prisma.$transaction(async (tx) => {
  const edit = await tx.$queryRaw<...>`SELECT ... FROM "CustomerEdit" WHERE id = ${id} FOR UPDATE`;
  if (edit.state !== 'SUBMITTED') throw new ConflictError(...);
  // ... apply ...
});
```
Or, simpler, change the update statement to be conditional and verify it changed exactly one row:
```ts
const updated = await tx.customerEdit.updateMany({
  where: { id: editId, state: 'SUBMITTED' },  // optimistic check
  data: { state: 'APPROVED', ... },
});
if (updated.count === 0) throw new ConflictError('NOT_PENDING', ...);
```

---

### PROD-002 — Disabled user retains access for up to 8 hours

**Severity:** High · **Confidence:** Confirmed by code review

**File:** `lib/auth.ts:148-150` and the JWT session strategy in `auth.config.ts:15`

**The bug:**
```ts
// authorize() — runs only at LOGIN
const hashToCheck = user?.isActive ? user.passwordHash : DUMMY_BCRYPT_HASH;
if (!user || !user.isActive || !ok) return null;
```
`isActive` is checked **only when issuing a JWT**. After issue, the JWT is valid for 8 hours. `auth()` (used by every page and server action) decodes the JWT signature and trusts the embedded role/userId; it never re-reads the User row. The middleware does the same.

**Result:** When a Manager clicks "Disable" on `/users` and toggles `isActive=false`, the disabled user's existing browser session continues to work for the full JWT TTL (up to 8 h). They can still edit customers, approve edits, upload photos, etc.

**Real-world impact:** Disabling a user (e.g., terminated salesman, compromised account) is **not effective** until their session expires. For a security incident this could be hours of damage.

**Fix (two options):**
1. **Cheap:** Reduce `session.maxAge` to 30–60 minutes; force re-login frequently.
2. **Right:** In the JWT callback, if the token is older than ~5 minutes, re-fetch the user record and revoke the JWT if `!isActive` or role changed:
```ts
async jwt({ token, user, trigger }) {
  if (user) { /* ... existing fresh-login path ... */ return token; }
  // Periodic freshness check
  const lastCheck = (token.lastCheck as number | undefined) ?? 0;
  if (Date.now() - lastCheck > 5 * 60 * 1000) {
    const fresh = await prisma.user.findUnique({ where: { id: token.userId as string } });
    if (!fresh?.isActive) return { ...token, exp: 0 }; // forces logout
    token.role = fresh.role;
    token.lastCheck = Date.now();
  }
  return token;
}
```

---

### PROD-003 — Stale role in JWT after role change (privilege does not revoke)

**Severity:** High · **Confidence:** Confirmed by code review

**Same root cause as PROD-002.** The JWT carries `role` from the moment of login. If a Manager demotes a user from `MANAGER` to `SALESMAN` via the import or `/users` flow:
- The demoted user keeps `MANAGER` access for the rest of their JWT lifetime.
- The same is true in reverse: a promotion only takes effect at next login.

**Concretely:** an attacker who briefly elevates themselves (see also QA-011 audit finding) can keep their elevated role in the live JWT even after the change is reverted.

**Fix:** Same as PROD-002 — refresh role on JWT renewal.

---

### PROD-004 — `/today` shows the wrong day for ~4 hours overnight (timezone bug)

**Severity:** Medium · **Confidence:** Confirmed by code

**File:** `app/(app)/today/page.tsx:38`
```ts
const DAY_BY_INDEX = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const today = DAY_BY_INDEX[new Date().getDay()];
```

`new Date().getDay()` returns the day **in the server's timezone**. Vercel functions run in **UTC**. Oman is **UTC+4**.

**Concretely:** between **Oman midnight and 04:00**, the salesman's phone shows the new day (e.g., Sunday) but the UTC server still thinks it's Saturday. `/today` queries `dayOfVisit = 'SAT'` and returns Saturday's customers. The salesman walks into the market expecting Sunday's customers and sees yesterday's list.

**Fix:**
```ts
// Compute Oman day-of-week, ignoring the server timezone.
function omanDayOfWeek(): typeof DAY_BY_INDEX[number] {
  const utc = new Date();
  // Oman is UTC+4 year-round (no DST)
  const oman = new Date(utc.getTime() + 4 * 60 * 60 * 1000);
  return DAY_BY_INDEX[oman.getUTCDay()];
}
const today = omanDayOfWeek();
```
Or import a TZ-aware library (`Intl.DateTimeFormat` with `timeZone: 'Asia/Muscat'`).

The same bug exists in any other place that uses `new Date()` to make day-level decisions (e.g., the dashboard's "last 30 days" window — verified, that one is fine because it uses ms math, not getDay).

---

### PROD-005 — GPS coordinates accept anywhere on Earth (no Oman bounding box)

**Severity:** Medium · **Confidence:** Confirmed by code

**File:** `lib/validation/edit.ts:56-57`
```ts
gpsLat: z.number().min(-90).max(90).optional(),
gpsLng: z.number().min(-180).max(180).optional(),
```

A salesman (deliberately or by accident on a faulty device) can submit `(0, 0)` (Null Island), `(-77, 166)` (Antarctica), or any other absurd coordinate. The supervisor would only catch this by eye, and the dashboard maps (when added) would render the customer in the wrong place. Worse, the `<GpsCaptureButton>` UI does NOT confirm the device's location is plausible before submitting.

**Fix:**
- Tighten Zod to Oman's actual bounding box: roughly **16.0°N–27.0°N, 51.0°E–60.5°E**:
```ts
gpsLat: z.number().min(16).max(27).optional(),
gpsLng: z.number().min(51).max(61).optional(),
```
- AND, server-side, log a warning if `gpsAccuracy > 100 m` so the supervisor sees a "low-confidence GPS" badge in the diff.
- Branch sub-region (city/govern.) lookup for cross-validation against the assigned route would be a v2 nice-to-have.

---

## 3) Other notable findings from the load test

These are not bugs but worth tracking for production tuning:

1. **Login latency 3–4 s under 10× burst.** Two sequential rate-limit Postgres transactions + bcrypt cost-12 + 2 Prisma queries. For a real 38-salesman fleet logging in once at 8 a.m., that's a ~4 s load spike on Neon's autosuspend-on-idle compute. Consider:
   - Parallelize the user-bucket and IP-bucket rate-limit checks (`Promise.all` instead of `for ... await`).
   - Skip the `lastLoginAt` update on every login (or update it asynchronously).
   - Pre-warm Neon with a periodic health check.
2. **`/users` page is 124 KB rendered.** Lists all 50 users plus joined supervisor + route info inline. If users grow to 500 the page would be ~1.2 MB. Add server-side pagination.
3. **`/customers` page reaches 270 KB for steward/viewer/managers** (95 customers × eager-loaded branch). Already paginated at 50/page — good — but the included branch object is heavy. Consider trimming the columns.
4. **Manager dashboard is 56 KB** with KPI counts + 30-day chart + region bars + route leaderboards. Fine for now; with 5,000 routes this would need server-side aggregation tables.
5. **No errors anywhere in 81 calls** is the headline result. The recent remediation didn't break legitimate flows.

---

## 4) Verdict and remediation priority

| Bug | Sev | Time-to-fix | Block pilot? |
|---|---|---|---|
| PROD-001 race | High | 30 min | **Yes** |
| PROD-002 stale isActive | High | 1 h | **Yes** |
| PROD-003 stale role | High | 0 h (same fix as PROD-002) | **Yes** |
| PROD-004 timezone | Medium | 15 min | No, but fix before salesmen open at 6am |
| PROD-005 GPS bounds | Medium | 10 min | No |

**Recommendation:** Fix PROD-001/002/003 (60 min total) before the pilot starts. PROD-004/005 can ship with the pilot and be patched in week 1.

Performance: app is healthy under 10× load. Login is the slow path; optimise post-pilot if salesmen complain.
