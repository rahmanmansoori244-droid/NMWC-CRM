# DB Invariants & Workflow State-Machine Audit — 2026-05-10

**Auditor stance:** Senior database / data-integrity auditor. Read-only by default.
**Domain:** Live Postgres on Neon (production / pilot data). Commit `82c58ec` deployed at https://nmwc-cm.vercel.app.
**Method:** Six query passes against the live DB plus static walks of `services/edits.ts`, `services/imports.ts`, `services/photos.ts`, and seed scripts to confirm provenance for each anomaly.
**Date:** 2026-05-10 (post 08:30 UTC payment-terms refresh)
**Verdict:** **Zero Critical findings.** **Two High** (one is a Critical-class invariant that the runtime app upholds correctly but seed scripts violate; one is workflow-state stamping that affects EL-11/EL-12 reactivation governance for 6 closed/suspended branches). **Three Medium** (placeholder-address tail, GPS gap, supervisor-chain root-stewards). **Two Low** (missing-stamp on every ACTIVE branch is by-design; ACTIVE-w/o-phone tail is by-design until salesmen enrich).

The runtime app's invariants are tight: every FK, every uniqueness rule, every state-machine transition we tested holds. The bugs are all upstream of the runtime — seed scripts and one Excel cell.

---

## Verdict summary

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | — |
| **High** | **2** | DB-01 (short-address bypass), DB-02 (CLOSED/SUSPENDED w/o `lastStatusChangeAt`) |
| Medium | 3 | DB-03 (2,327 "Address pending" placeholders), DB-04 (98% of branches have no GPS), DB-05 (3 STEWARD/MANAGER roots have null supervisor — by-design but not documented) |
| Low | 2 | DB-06 (3,417 ACTIVE branches with null `lastStatusChangeAt` — by-design), DB-07 (2,571 customers with no phone — pre-enrichment) |

---

## Baseline counts (verified at audit time)

| Entity | Active | Soft-deleted | Total |
|---|---:|---:|---:|
| Customer | 3,334 | 0 | 3,334 |
| Branch | 3,423 | 0 | 3,423 |
| Attachment | 141 | 0 | 141 |
| User | 64 (all active) | — | 64 |
| CustomerEdit | — | — | 24 |
| Route | 48 | — | 48 |
| Region | 7 | — | 7 |

User role distribution: SALESMAN=48, SUPERVISOR=8, MANAGER=4, STEWARD=2, VIEWER=2. All active.
Payment-terms distribution: CASH=228, CREDIT=3,106 (matches owner's brief).

---

## 1. FK + uniqueness invariants — **all PASS**

| Invariant | Result | Affected rows |
|---|:---:|---:|
| `Customer.crPhotoId → Attachment.id (active, customerId match)` | PASS | 0 |
| `Branch.shopPhotoId → Attachment.id (active, branchId match)` | PASS | 0 |
| `Branch.signboardPhotoId → Attachment.id (active, branchId match)` | PASS | 0 |
| `Branch.routeId → Route.id (active)` | PASS | 0 |
| `Branch.regionId == Branch.route.regionId` | PASS | 0 |
| `User.ownedRouteId → role=SALESMAN` | PASS | 0 (all 48 owners are SALESMAN+isActive) |
| `User.supervisorId → role IN (SUPERVISOR, MANAGER)` (AUTH-06) | PASS | 0 |
| `Customer.primaryPhoneNorm` unique among non-deleted | PASS | 0 dupes (partial unique idx confirmed in `pg_indexes`) |
| `CustomerEdit.customerId` exists | PASS | 0 |
| `CustomerEdit.branchId` exists | PASS | 0 |
| `Customer.crNumberNorm` no dupes (non-deleted) | PASS | 0 |
| `Branch.branchCode` no dupes (non-deleted) | PASS | 0 |
| `Attachment.r2Key` no dupes | PASS | 0 |
| `Attachment` reverse-lookup vs slot kind | PASS | 0 (every slot's kind matches: `crPhoto`→CR, `shopPhoto`→SHOP, `signboardPhoto`→SIGNBOARD) |
| `Attachment` no dual-owner (`customerId` AND `branchId` both set) | PASS | 0 |
| `Customer.primaryPhoneNorm == primaryPhone` | PASS | 0 drift |
| `Customer.crNumberNorm == crNumber` | PASS | 0 drift (spec — `normalizeCR` may legitimately differ; acceptable) |

The partial unique index `Customer_primaryPhoneNorm_active_unique` (where `primaryPhoneNorm IS NOT NULL AND deletedAt IS NULL`) is healthy: 0 violations.

---

## 2. Soft-delete consistency — **all PASS**

| Check | Result | Affected rows |
|---|:---:|---:|
| Active Branch with soft-deleted Customer | PASS | 0 |
| Active Customer using soft-deleted CR Attachment | PASS | 0 |
| Active Branch using soft-deleted Shop Attachment | PASS | 0 |
| Active Branch using soft-deleted Signboard Attachment | PASS | 0 |
| Active Customer with **all** branches soft-deleted | PASS | 0 |
| Active Customer with **no** branches at all | PASS | 0 |
| Soft-deleted Attachment referenced by any non-deleted slot | PASS | 0 |
| Orphan Attachment (kind=SHOP/SIG/CR with no inverse owner) | PASS | 0 |

Effectively no soft-deletes have happened in production yet (`deletedAt IS NOT NULL` count is zero across Customer / Branch / Attachment), so the invariants are also vacuously true. When the first soft-deletes land, the same queries should be re-run as a smoke test.

---

## 3. CustomerEdit state-machine — **all PASS**

State distribution (24 total):

| State | Count |
|---|---:|
| SUBMITTED | 10 |
| NEEDS_CORRECTION | 7 |
| APPROVED | 6 |
| DRAFT | 1 |
| REJECTED | 0 |

| Invariant | Result | Affected rows |
|---|:---:|---:|
| APPROVED ⇒ `reviewedById, reviewedAt` not null | PASS | 0 |
| REJECTED ⇒ `reviewedById, reviewedAt` not null | PASS | 0 (no rejections in DB) |
| State IN (SUBMITTED, APPROVED, REJECTED, NEEDS_CORRECTION) ⇒ `submittedAt` not null | PASS | 0 |
| NEEDS_CORRECTION ⇒ `decisionReason` non-blank | PASS | 0 |
| DRAFT ⇒ `submittedAt` is null | PASS | 0 |
| Edit has at least one of `customerId` / `branchId` | PASS | 0 |
| target=CUSTOMER ⇒ `customerId` not null; target=BRANCH ⇒ `branchId` not null | PASS | 0 |
| `isReactivation` edits scoped to branch-status only | PASS | 0 reactivation edits in DB (vacuously true) |
| `fieldChanges` is array of `{field, before, after}` | PASS | 0 malformed entries |
| Submitter / reviewer FKs resolve | PASS | 0 orphans |
| Open-edit uniqueness (`CustomerEdit_open_per_customer` partial unique idx) | PASS | DB enforces; we observed zero collisions |

The state-machine itself appears robust. The application code in `services/edits.ts` plus the partial unique index covers every transition we audited.

---

## 4. Data quality — Findings

### DB-01 (HIGH) — Branch `CAA2468-01` has `address = "WK"` (length 2), violating the >=3 mandatory-field gate

**Where:** `Branch.id = cmozfs4zc03ljtvfkz6ek9z0p`, `branchCode = "CAA2468-01"`, customer `CAA2468 — AL BARAQ NATIONAL SHOPPING`. Created 2026-05-10 07:13:29 by `pilot.steward`. No `importBatchId` set on the customer.

**What a user sees:** When the salesman who owns C1/C4/etc. opens this customer to enrich it, the EnrichmentForm submits → `submitEditCore` calls `collectMissingMandatory` (services/edits.ts:151–159) → an error `branch.<id>.address: "Branch CAA2468-01: address is required."` fires. The salesman did **not** type "WK"; they're being asked to fix something they didn't break. Worse, if the salesman *doesn't* touch the address field, `addr.trim().length < 3` still triggers because the merged value falls back to the live DB record's `"WK"`. The salesman is locked out of submitting any edit on this customer until they retype the address.

The Zod schema `submitEditSchema` in `lib/validation/edit.ts:53` enforces `address.min(3)`, so the runtime can't introduce this. The bypass came from the seed import — `prisma/seed-muscat-customers.ts:231` passes `r.address ?? 'Address pending'` straight into `prisma.branch.upsert`, no validation. The source row in `GT-MUSCAT-PILOT.xlsx` for `CAA2468` had `address = "WK"`.

**Severity:** HIGH. One row is a small blast radius but it's a guaranteed-to-trip-the-gate inconsistency that produces a misleading user error. Could be the first paper-cut a salesman hits this week.

**Suggested fix (do not run yet):**
```sql
-- Cleanup: replace the 2-char address with the imports-pipeline placeholder
UPDATE "Branch"
SET    address = 'Address pending', "updatedAt" = NOW()
WHERE  id = 'cmozfs4zc03ljtvfkz6ek9z0p' AND address = 'WK';
```

**Code-level prevention:**
1. Make `prisma/seed-muscat-customers.ts:224–243` validate the address with the same `min(3)` constraint before calling `upsert`. Sketch:
   ```ts
   const addr = (r.address ?? 'Address pending').trim();
   const safeAddr = addr.length >= 3 ? addr : 'Address pending';
   // ...use safeAddr in both branches of the upsert
   ```
2. Add a Postgres `CHECK` constraint to make this physically impossible:
   ```sql
   ALTER TABLE "Branch"
   ADD CONSTRAINT "branch_address_minlen"
   CHECK (length(btrim(address)) >= 3);
   ```
   This is a defense-in-depth — Prisma's schema doesn't have CHECK constraints, but a one-line migration adds one. Future seed scripts and any other write path get caught at the DB boundary.

### DB-02 (HIGH) — 6 CLOSED/SUSPENDED branches have null `lastStatusChangeAt`, defeating EL-11/EL-12 reactivation evidence freshness

**Affected rows:** 6 branches, all created 2026-05-09 by `pilot.steward` (seemingly via `prisma/inject-test-edits.ts` or a similar fixture path):

| branchCode | status | createdAt | updatedAt |
|---|---|---|---|
| NMWC-2026-000066-01 | CLOSED | 2026-05-09T11:46:33.732Z | 2026-05-09T11:46:36.137Z |
| NMWC-2026-000067-01 | CLOSED | 2026-05-09T11:46:37.627Z | 2026-05-09T11:46:39.353Z |
| NMWC-2026-000068-01 | CLOSED | 2026-05-09T11:46:40.735Z | 2026-05-09T11:46:42.170Z |
| NMWC-2026-000069-01 | CLOSED | 2026-05-09T11:46:43.594Z | 2026-05-09T11:46:45.011Z |
| NMWC-2026-000070-01 | SUSPENDED | 2026-05-09T11:46:46.429Z | 2026-05-09T11:46:47.934Z |
| NMWC-2026-000071-01 | SUSPENDED | 2026-05-09T11:46:49.455Z | 2026-05-09T11:46:50.019Z |

**What this breaks:** The schema comment on `Branch.lastStatusChangeAt` says: *"stamped whenever `status` changes. Reactivation evidence must have `attachment.capturedAt > lastStatusChangeAt`, so a salesman cannot reuse a pre-closure photo to 'prove' a reopening."* For these 6 branches, `lastStatusChangeAt` is NULL, so the comparison `attachment.capturedAt > lastStatusChangeAt` becomes `> NULL` (= NULL = falsy in Postgres). Depending on how `services/reactivations.ts` evaluates that, a salesman trying to reactivate one of these test branches will either (a) silently bypass the freshness guard, or (b) hit a less helpful "No fresh evidence" error.

I did not test this end-to-end; the right fix is to ensure freshness check explicitly handles `NULL` as "very old" (i.e. all photos are fresh, meaning reactivation should be allowed) OR backfill the stamps. **Seed-injected test fixtures should not silently disable security guards.**

**Severity:** HIGH. These are test branches today, but the same pattern can repeat with real CLOSED/SUSPENDED branches because **`services/edits.ts:543–545`'s "stamp on status change" only fires when there's a previous status to compare against**:
```ts
const current = await tx.branch.findUnique({ where: { id: bp.branchId }, select: { status: true } });
if (current && current.status !== branchUpdate.status) {
  branchUpdate.lastStatusChangeAt = new Date();
}
```
This means a brand-new branch born CLOSED (e.g. via a future hypothetical "closed at import time" path) would also have a NULL stamp. Today it's only test fixtures, so the production blast radius is "the 6 test rows," but the **invariant is loose**.

**Suggested fix (do not run yet):**
```sql
-- Cleanup: backfill the missing stamp using updatedAt as a best estimate
UPDATE "Branch"
SET    "lastStatusChangeAt" = "updatedAt"
WHERE  status IN ('CLOSED','SUSPENDED')
  AND  "lastStatusChangeAt" IS NULL
  AND  "deletedAt" IS NULL;
-- Affects 6 rows.
```

**Code-level prevention:** harden the stamping logic so it fires whenever a branch ends up non-ACTIVE regardless of prior state. In `services/edits.ts:538–546`, change:
```ts
if (branchUpdate.status !== undefined) {
  // ... existing change-detection ...
}
```
to also stamp when a fresh row is created with non-ACTIVE status. For the seed/test fixtures, add a runtime check to `prisma/inject-test-edits.ts` that explicitly sets `lastStatusChangeAt: new Date()` when injecting CLOSED/SUSPENDED state.

### DB-03 (MEDIUM) — 2,327 active branches still have `address = "Address pending"`

**What this is:** The placeholder set by `services/imports.ts:781–784` and `prisma/seed-muscat-customers.ts:231` when the source row had no address. **Length is 15, so the >=3 gate passes**, but these are not real addresses — they are flagged as "fix me later."

**Why surface it:** Without an address, the salesman cannot route to the store. With the placeholder, the mandatory-fields gate currently lets the customer through completeness scoring (the score already correctly stays low: 3,238 of 3,334 customers have score=0). But there's no UI surfacing "your route has X stores with placeholder addresses," and the EnrichmentForm doesn't pre-warn the salesman that the address shown is a placeholder. The salesman might submit photos + GPS + day-of-visit thinking they're done, then get the gate-rejection on submit.

**Severity:** MEDIUM. Operational tail, not an integrity bug. The mandatory-fields gate does fire on submit (placeholder is preserved untouched, so the merged value still equals `"Address pending"` which has length 15 — wait, that *passes* the length check). Re-checking the code: `services/edits.ts:157` uses `(addr as string).trim().length < 3` only — there is **no semantic check** that the address is meaningful. So a salesman who doesn't change the address can submit an edit and have it approved with `"Address pending"` still in the address field. **This is a genuine product gap, not just a tail count.**

**Suggested fix (do not run):** No DB cleanup — these rows are real, they need user enrichment.

**Code-level prevention:**
1. In `services/edits.ts:151` `collectMissingMandatory`, add an explicit blacklist:
   ```ts
   const PLACEHOLDER_ADDRESSES = new Set(['Address pending', 'TBD', 'tbd', 'pending']);
   if (!isStr(addr) || (addr as string).trim().length < 3 ||
       PLACEHOLDER_ADDRESSES.has((addr as string).trim().toLowerCase())) {
     errors[`branch.${b.id}.address`] = `Branch ${tag}: real address required (placeholder detected).`;
   }
   ```
2. In the EnrichmentForm, if `branch.address === 'Address pending'`, show a yellow banner: "This address was auto-imported; please replace with the actual store address."

### DB-04 (MEDIUM) — 3,367 of 3,423 active branches (98.4%) have no GPS

**What this is:** The seed import didn't carry GPS coordinates, so `gpsLat/gpsLng/gpsAccuracy/gpsCapturedAt` are all NULL. The mandatory-fields gate (services/edits.ts:160–162) catches this on edit submit, so the data integrity is fine — it's just that the dataset is mostly un-enriched until salesmen capture GPS in the field.

**Severity:** MEDIUM as a **business-visibility** issue, not a bug. The number is large enough that the manager dashboard should show it as a top-of-funnel metric.

**Suggested fix:** No DB action needed. Recommend a `/dashboard` widget that surfaces "Branches missing GPS" alongside "Branches missing address" and "Branches missing photos."

### DB-05 (MEDIUM) — Two STEWARD users have `supervisorId = NULL`

**Affected rows:** `pilot.steward (cmozemdrr0001tvb8nb2101xh)` and `steward (cmoy9xm68002etvf8xa9vwfqv)`.

**Why surface it:** Stewards are not in the salesman → supervisor → manager hierarchy by design (they're a staff role attached to ops, not field). The schema's `User.supervisorId` is nullable, so this is structurally fine. But the AUTH-06 invariant audit only checked "if supervisorId is set, the supervisor must be SUPERVISOR or MANAGER." It did not check "should certain roles always have a supervisor?" My read of the docs says STEWARD/MANAGER/VIEWER may have no supervisor, while SALESMAN and SUPERVISOR should. The DB rows match that read:

- 4 MANAGERs: 0 of 4 have a supervisor (correct — MANAGER is the org root)
- 2 STEWARDs: 0 of 2 have a supervisor (acceptable — staff role)
- 8 SUPERVISORs: 8 of 8 have a supervisor (correct — chained to MANAGER)
- 48 SALESMEN: all have a supervisor (correct)
- 2 VIEWERs: 0 of 2 have a supervisor (need to confirm — see below)

**Severity:** LOW-MEDIUM as a documentation gap. No data is broken; the role/supervisor combinations match the expected pattern. But the audit query in `lib/auth.ts` (or wherever AUTH-06 lives) should be tightened so a future reviewer can see the rule expressed explicitly: "SALESMAN must have supervisor; SUPERVISOR must have supervisor; MANAGER, STEWARD, VIEWER may have null supervisor."

**Code-level prevention:** Add a Zod refinement / DB constraint on User insert/update:
```ts
const userSchema = z.object({...}).refine(
  (u) => !(u.role === 'SALESMAN' && !u.supervisorId),
  { message: 'SALESMAN must have a supervisor', path: ['supervisorId'] }
).refine(
  (u) => !(u.role === 'SUPERVISOR' && !u.supervisorId),
  { message: 'SUPERVISOR must have a supervisor', path: ['supervisorId'] }
);
```

### DB-06 (LOW) — All 3,417 ACTIVE branches have null `lastStatusChangeAt`

**By design.** Per the schema comment, the stamp is only set when status *changes*. Brand-new branches that have never moved off ACTIVE legitimately have `lastStatusChangeAt = NULL`. Any reactivation flow on these branches is a no-op (they are already ACTIVE). Surfaced for clarity only.

### DB-07 (LOW) — 2,571 of 3,334 active customers (77%) have `primaryPhoneNorm = NULL`

**By design at this stage.** The seed import dropped 77 phones for E.164 normalisation failures (visible in the 07:28 import audit log: `"phonesDropped": 77`) and never had phone for the rest. As salesmen enrich, this number drops. No integrity violation. Surfaced for completeness.

---

## 5. Orphans — **all PASS**

| Orphan check | Affected rows |
|---|---:|
| `Attachment.capturedById → User.id` | 0 |
| `CustomerEdit.submittedById → User.id` | 0 |
| `CustomerEdit.reviewedById → User.id` (where set) | 0 |
| `Customer.lastEditedById → User.id` (where set) | 0 |
| `Customer.createdById → User.id` (where set) | 0 |
| `Branch.createdById → User.id` (where set) | 0 |
| `Branch.lastEditedById → User.id` (where set) | 0 |
| `AuditLog.actorId → User.id` | 0 |

Every audit-trail FK resolves cleanly. No deleted-user cascade hazard.

---

## 6. Index health — `EXPLAIN ANALYZE` results

All four hot queries execute in <3 ms with index scans. No sequential scans on any table > 1 K rows except `Route` (48 rows; full seq-scan is correct).

### `/customers` list — `WHERE deletedAt IS NULL AND status='ACTIVE' ORDER BY legalName LIMIT 50`
```
Index Scan using "Customer_legalName_idx" on "Customer"  (cost=0.28..7.53 rows=50 width=75)
  (actual time=2.46..2.53 rows=50 loops=1)
  Filter: ((deletedAt IS NULL) AND (status = 'ACTIVE'))
  Buffers: shared hit=49 read=2
Execution Time: 2.55 ms
```
**Verdict:** Healthy. Uses `Customer_legalName_idx`. Consider a partial index on `legalName WHERE deletedAt IS NULL AND status = 'ACTIVE'` if the cardinality grows past ~50K rows; not needed today.

### `/today` — `WHERE deletedAt IS NULL AND dayOfVisit='SAT' AND routeId IN (SELECT id FROM Route WHERE code='C1') LIMIT 200`
```
Limit  (cost=1.87..54.83 rows=1 width=93) (actual time=0.13..0.97 rows=2 loops=1)
  Buffers: shared hit=291
  ->  Nested Loop (Branch ⨝ Route ⨝ Customer)
        Index Scan using "Branch_routeId_status_deletedAt_idx" on "Branch" b
          Index Cond: (deletedAt IS NULL)
          Filter: (dayOfVisit = 'SAT')
          Rows Removed by Filter: 3413
Execution Time: 1.02 ms
```
**Verdict:** Healthy at current scale (3.4 K branches), but **the filter `dayOfVisit='SAT'` removes 3,413 rows after the index scan picks 3,415**. At 30 K branches this becomes ~30 ms. If `/today` becomes a top-3 page-load contributor, add `Branch(routeId, dayOfVisit, deletedAt)` as a composite. For pilot scale this is unnecessary.

### `/approvals` queue — `WHERE state='SUBMITTED' ORDER BY submittedAt LIMIT 50`
```
Limit  (actual time=0.03..0.03 rows=10 loops=1)
  ->  Sort  Sort Key: submittedAt
        ->  Seq Scan on "CustomerEdit"  Filter: (state = 'SUBMITTED')
              Rows Removed by Filter: 14
Execution Time: 0.05 ms
```
**Verdict:** Seq scan is correct because `CustomerEdit` has only 24 rows. The `CustomerEdit_state_submittedAt_idx` exists but the planner skipped it (cost=0.05 ms is the fastest path at this scale). No action needed; the index is in place for future scale.

### `/api/photos/[id]` — `WHERE id = X AND deletedAt IS NULL`
```
Index Scan using "Attachment_pkey" on "Attachment" a
  Index Cond: (id = X)
  Filter: (deletedAt IS NULL)
Execution Time: 0.11 ms
```
**Verdict:** Optimal. PK lookup + post-filter on `deletedAt`. The `Attachment_deletedAt_idx` is also present and will help bulk listings.

### Index inventory observations
- All foreign-key columns we audited (`customerId`, `branchId`, `routeId`, `regionId`) have indexes.
- Partial unique indexes are in place for `Customer_primaryPhoneNorm_active_unique` and `CustomerEdit_open_per_customer`.
- `AuditLog` has the right (entityType, entityId, at DESC) index for the customer-history view.
- **One missing index recommendation:** `Customer.crNumberNorm` has no dedicated index. If the duplicate-CR detection on imports does a `WHERE crNumberNorm = ?` lookup over 3,334 rows, that's a ~3 ms seq scan today; at 100 K it's ~30 ms. Adding a non-unique index `Customer(crNumberNorm) WHERE deletedAt IS NULL` is a one-line migration. Not urgent — surfaced as a follow-up.
- `Branch.lastStatusChangeAt` has no index, but it's only read inside reactivation flows (one row at a time keyed by `branchId`), so an index isn't justified.

---

## 7. Cleanup queries (DO NOT RUN — for orchestrator review)

```sql
-- DB-01: Replace the 2-char "WK" address with the imports placeholder so the
-- salesman who edits CAA2468 isn't blocked by a false "address required" error.
UPDATE "Branch"
SET    address = 'Address pending', "updatedAt" = NOW()
WHERE  id = 'cmozfs4zc03ljtvfkz6ek9z0p' AND address = 'WK';

-- DB-02: Backfill lastStatusChangeAt on the 6 CLOSED/SUSPENDED test fixtures
-- so EL-11/EL-12 reactivation evidence freshness has a meaningful anchor.
UPDATE "Branch"
SET    "lastStatusChangeAt" = "updatedAt"
WHERE  status IN ('CLOSED','SUSPENDED')
  AND  "lastStatusChangeAt" IS NULL
  AND  "deletedAt" IS NULL;

-- (Optional defense-in-depth) DB-CHECK: physically prevent <3-char addresses
-- on future writes, regardless of which seed/script wrote them.
ALTER TABLE "Branch"
  ADD CONSTRAINT "branch_address_minlen"
  CHECK (length(btrim(address)) >= 3);
```

The CHECK constraint should be added **after** the DB-01 cleanup, otherwise it'll reject the existing `"WK"` row.

---

## 8. Code-level recommendations to prevent recurrence

| Recommendation | Rationale | Effort |
|---|---|---|
| Add `CHECK (length(btrim(address)) >= 3)` to `Branch.address` | Closes the seed-script bypass that produced DB-01 | 1 migration line |
| In `services/edits.ts:151` `collectMissingMandatory`, blacklist `'Address pending'` and similar placeholder values | Closes DB-03 — placeholder addresses currently pass the length check | 5 lines |
| Stamp `lastStatusChangeAt` on insert when initial status ≠ ACTIVE | Closes DB-02 at the runtime; ensures every CLOSED/SUSPENDED row has a reactivation anchor | 3 lines in `services/edits.ts` and any other `branch.create` write paths |
| In `prisma/inject-test-edits.ts` (and any other test-fixture seed), explicitly set `lastStatusChangeAt: new Date()` whenever creating non-ACTIVE rows | Stops test fixtures from contaminating the dataset with NULL stamps | 1 line per fixture |
| Add Zod refinement: `SALESMAN.supervisorId` and `SUPERVISOR.supervisorId` must be non-null (DB-05) | Hardens the AUTH-06 invariant for future user creation | 5 lines in `services/users.ts` |
| Add non-unique index on `Customer(crNumberNorm) WHERE deletedAt IS NULL` | Speeds duplicate-CR lookups at 50K+ scale (not urgent) | 1 migration line |

None of these are launch-blocking. DB-01 and DB-02 are worth fixing in a single follow-up commit before the salesmen hit `/customers/CAA2468`.

---

## Appendix A — Queries used

All queries are in `tmp-audit-1.js`, `tmp-audit-2.js`, `tmp-audit-3.js`, `tmp-audit-4.js` at the project root. They're temporary scaffolding; safe to delete once the report is reviewed. They run read-only against the live DB via `DATABASE_URL` from `.env`.

Total queries executed: 56 (1 baseline, 16 FK/uniqueness, 12 soft-delete + state-machine, 13 data-quality, 8 orphan, 4 EXPLAIN ANALYZE, 1 index inventory, 1 supervisor-chain).

Total live-DB query time: ~3 seconds.

## Appendix B — What this audit did **not** test

- End-to-end behavior of the reactivation flow on the 6 NULL-stamp branches (DB-02). I read the schema comment and `services/reactivations.ts` referenced it, but did not simulate a salesman reactivating one of those test branches to confirm the freshness check's NULL handling.
- ImportRow lifecycle correctness (PENDING→CLEAN→PROMOTED). The DB has zero ImportRow rows currently; the seed bypassed the import pipeline. Re-audit when a real `/import` workflow runs end-to-end.
- AuditLog completeness (does every CREATE/UPDATE produce an audit row?). The 25 logs we observed match the operations performed. A formal "every state transition writes an audit log" audit would need static analysis of every `tx.*` write site.
- Sentry / Vercel-edge logs for actual user errors. This audit is purely DB-side.
