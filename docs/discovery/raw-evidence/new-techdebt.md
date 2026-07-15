# NMWC Customer Master — Technical Architecture Assessment, Tech-Debt Register & Bug Catalogue
### (Discovery-only, read-only. Feeds Section K [tech debt] + Section I [bugs].)
System root: `C:\Users\abdulr\Desktop\NMWC-CRM` · Branch analysed: `main` (worktree). Date: 2026-07-15.

Confidence tags: **[Confirmed]** = read in code · **[Highly likely]** · **[Possible]** · **[Unknown]**.

---

## 0. Stack & architecture snapshot (CONFIRMED FACTS)

- **Framework:** Next.js 15 App Router, React 19, TypeScript 5.6, server components + server actions. (`package.json`)
- **Auth:** NextAuth v5 beta (`next-auth ^5.0.0-beta.31`), JWT strategy, Credentials provider, bcryptjs. (`lib/auth.ts`, `auth.config.ts`, `middleware.ts`)
- **DB:** PostgreSQL (Neon) via Prisma 6.19. Single global client (`lib/db.ts`). Schema: `prisma/schema.prisma` (18 models, 9 migrations).
- **Storage:** Cloudflare R2 via AWS S3 SDK, presigned PUT + server-side finalize (`app/api/photos/*`, `lib/r2.ts`).
- **Observability:** Sentry (client/server/edge configs), pino logger (`lib/logger.ts`).
- **Deploy:** Vercel (`vercel.json` crons, `.vercel/`), GitHub Actions db-backup + keep-warm cron.
- **Layering (GOOD):** clear separation — `app/` (pages/routes) → `services/` (server actions, business logic, `'use server'`) → `lib/` (pure helpers: permissions, access/scope, completeness, errors, rate-limit, audit). Permission logic is centralised and pure (`lib/permissions.ts`, `lib/access.ts`). Error contract is disciplined (`lib/errors.ts` `runAction`/`SafeAction` discriminated union solves the RSC "message omitted in production" trap).
- **Maturity:** Heavily hardened. Hundreds of tagged prior fixes (B-xx, AUTH-xx, QA-xxx, RBAC-05-xxx, EL-xx, F-xx, NEW-PHOTO-xxx, PROD-xxx). Optimistic locking (`version` col) on Customer/Branch; atomic edit-claim; DB-level partial unique index for one-open-edit-per-customer; session revocation via `sessionsRevokedAt`; constant-time cron bearer compare; formula-injection escaping on Excel in AND out.

**Secret hygiene (CONFIRMED):** `.env`, `.env.local` exist on disk but are gitignored and **not in git history** (`git log --all -- .env` empty). Only `.env.example` is tracked (variable NAMES only, no values). No hardcoded secrets found in tracked `.ts/.tsx/.mjs/.json`. `assertAuthSecret()` (`lib/auth.ts:17-32`) enforces AUTH_SECRET length + entropy in prod. **No secret exposure found.**

---

## PART 2 — BUG CATALOGUE

### CONFIRMED BUGS

#### BUG-1 [Confirmed] — CRITICAL — Postgres rate limiter NEVER denies (production brute-force protection defeated)
- **Location:** `lib/rate-limit.ts:78-112`, specifically the `RETURNING` clause at `lib/rate-limit.ts:102-104`.
- **Description:** `checkLimitPg` computes the refilled token count, then subtracts 1 **only when** refilled ≥ 1 (the `CASE … ELSE 0` at lines 92-99), flooring stored `tokens` at 0. It then returns `granted = ("tokens" >= 0)`. Because the post-update `tokens` value can never go below 0 (when < 1 token is available it subtracts 0), **`granted` is ALWAYS true**. The durable limiter grants every request and never returns `{ ok: false }`.
- **Reproduction:** Any environment with `DATABASE_URL` set and `RATE_LIMIT_BACKEND != 'memory'` (i.e. **production**). Fire >5 logins for one username within a minute → all allowed; `LOGIN_LIMIT` (`capacity 5`) is never enforced. The unit test only covers the in-memory path and even documents it: *"The Postgres path is exercised in production"* (`tests/unit/rate-limit.test.ts:1-6`) — so this is untested and live.
- **Business impact:** Login brute-force, credential-stuffing, form spam (`FORM_LIMIT`), photo enumeration (`PHOTO_LIMIT`), photo-serve DoS, and import throttling are all **unprotected in production**. bcrypt cost-12 is the only remaining brute-force friction. Note the security-critical fail-**closed** path (`lib/rate-limit.ts:44-49`) only triggers on a DB *exception* — here the query succeeds and wrongly returns granted, so fail-closed never engages.
- **Root cause:** `granted` derived from the clamped post-update `tokens` instead of from "was a full token available" (i.e. the `refilled >= 1` predicate).
- **Fix:** Return `granted` from the availability predicate, e.g. `RETURNING "tokens", (LEAST(cap, tokens+elapsed*refill) >= 1) AS granted`, or drop the CASE, always subtract 1 (allow negative), and clamp on next refill.
- **Remediation effort:** ~1 hr incl. an integration test against a real Postgres.

#### BUG-2 [Confirmed] — HIGH — Customer import "UNASSIGNED" fallback writes a Route id into `Branch.regionId` (FK violation → rows silently REJECTED)
- **Location:** `services/imports.ts:802-803` (fallback), scope bug at `services/imports.ts:751-762`.
- **Description:** In `promoteCustomerBatchCore`, when a row's `regionCode` is missing/unknown the code does `const effectiveRegionId = (region ?? unassignedRoute!).id;`. The fallback object is **`unassignedRoute` (a Route), not a Region** — `unassignedRegion` is declared with `let` *inside* the `if (!unassignedRoute)` block (lines 753-758) and is out of scope here; when `unassignedRoute` already exists it is never even loaded. So `Branch.regionId` gets set to a `Route.id`.
- **Reproduction:** Import any customer-master row whose `sales_region`/`region` column is blank or references an unknown region code (the documented "map to UNASSIGNED route" path — `services/imports.ts:504`). At `tx.branch.upsert` the `Branch.regionId → Region.id` FK (`schema.prisma:338`) rejects the Route id (P2003), the per-customer transaction throws, and the whole group is marked `REJECTED` (`services/imports.ts:891-922`).
- **Business impact:** Every legacy customer lacking a valid region code fails to promote — a core migration path for the exact "dirty master data" this app exists to clean. Steward sees rows rejected with an opaque `promote failed (P2003/UNKNOWN)`.
- **Root cause:** Wrong fallback variable + `unassignedRegion` scoped inside the creation branch.
- **Fix:** Hoist `unassignedRegion` to the same scope as `unassignedRoute` (always resolve it), and use `(region ?? unassignedRegion).id` for `effectiveRegionId`.
- **Remediation effort:** ~30 min.

#### BUG-3 [Confirmed] — MEDIUM — Approve-time lock silently discards a CASH customer's salesman-collected CR number
- **Location:** `services/edits.ts:682-692` vs submit-time `services/edits.ts:284-289`.
- **Description:** At submit, locks are applied **conditionally**: `isFieldLocked('legalName', …)` (always true for SALESMAN) and `isFieldLocked('crNumber', …)` (only true when `paymentTerms === 'CREDIT'`, per `lib/permissions.ts:70-80`). So for a **CASH** customer a salesman's `crNumber` change IS recorded in `fieldChanges`. But at approve time the code guards only on `isFieldLocked('legalName', …)` (always true for a salesman) and then unconditionally `delete customerProposed.legalName; delete customerProposed.crNumber;` — dropping `crNumber` even for CASH customers where it was never locked.
- **Reproduction:** SALESMAN edits a CASH customer, fills CR number, submits → Supervisor approves → CR number is not written to the master (silently lost); the salesman's captured value vanishes.
- **Business impact:** Silent data loss of legitimately field-collected CR numbers for CASH customers; erodes trust in the approval pipeline; inconsistent with submit-time behaviour.
- **Root cause:** Approve path re-implements the lock as "legalName locked ⇒ also drop crNumber" instead of re-checking `crNumber` lock independently against current payment terms.
- **Fix:** Mirror submit logic — `if (isFieldLocked('legalName', …)) delete legalName;` and separately `if (isFieldLocked('crNumber', …)) delete crNumber;`.
- **Remediation effort:** ~20 min.

#### BUG-4 [Confirmed] — LOW — Completeness score always grants the "notes/paymentTerms" 5 points
- **Location:** `lib/completeness.ts:47` — `if (c.notes || c.paymentTerms) s += 5;`
- **Description:** `paymentTerms` is a non-nullable enum defaulting to `CASH` (`schema.prisma:256`), so the condition is **always truthy**. Every customer receives +5 regardless of whether `notes` is populated. Intended signal (has notes) is dead.
- **Impact:** Completeness scores inflated by a fixed 5 points for all customers; min customer-part score is 5 not 0. Skews dashboard "avg completeness" and the completeness band thresholds. Low severity (systematic, not data-corrupting).
- **Fix:** Drop `|| c.paymentTerms`, or split into two distinct signals.

#### BUG-5 [Confirmed] — LOW — Dead/tautological equipment-score branch
- **Location:** `lib/completeness.ts:58-67`. The outer `if ((coolers ?? 0) >= 0 && … && sum >= 0)` is always true (counts default 0, sum ≥ 0 always). Only the inner `if (sum > 0) s += 5` matters. The outer guard is dead code and misleading (comments reference an "explicit confirmation" case that was never implemented).
- **Impact:** Maintainability/readability only. No runtime effect.

### SUSPECTED BUGS (not fully confirmed)

#### SUS-1 [Highly likely] — MEDIUM — Reactivation approve lacks optimistic version locking
- **Location:** `services/reactivations.ts:255-302` (`approveReactivationCore`). Unlike `applyEditChanges` (`services/edits.ts:503-572`), the branch/customer updates here use plain `tx.branch.update`/`tx.customer.update` with no `version` check. A Manager approving a reactivation concurrently with a Supervisor approving a normal edit on the same branch is a last-write-wins race (the exact orthogonal race `applyEditChanges` was written to prevent). Lower likelihood (reactivation volume is low) but the protection asymmetry is real.
- **Verify:** Attempt concurrent `approveReactivationAction` + `approveEditAction` on one branch; observe no VERSION_CONFLICT.

#### SUS-2 [Confirmed pattern, Possible impact] — MEDIUM/scalability — Duplicate detector full-table scan + audit-as-state
- **Location:** `services/duplicates.ts:62-98`. `findDuplicateCandidates` loads the **entire non-deleted Customer table** into memory each run and loads **all `AuditLog` rows where `entityType='CustomerPair'`** to reconstruct dismissed pairs. At ~3.3k customers it is fine; it degrades linearly and abuses the immutable AuditLog table as mutable application state (`dismissDuplicateCore`, `services/duplicates.ts:300-317`). Also O(n²) within CR/triple groups (bounded by group size, usually tiny).
- **Impact:** Scalability + semantic misuse of audit log (dismissals can never be un-dismissed cleanly; they permanently suppress pairs on every future run).

#### SUS-3 [Confirmed pattern] — LOW/scalability — Dashboard pulls all branch scores into memory
- **Location:** `app/(app)/dashboard/page.tsx:96-135`. `regionStats` and `routes` each `select branches { completenessScore }` for all branches in scope, then average in JS. Cached 30s (`revalidate = 30`) which masks it, but at 10k+ branches this materialises large arrays per render.
- **Fix:** Push averaging into SQL (`_avg` grouped by region/route).

### KNOWN-ISSUES DOC RECONCILIATION (mined + verified in code)
- **PROD-001 (approve race, doc: `docs/PROD-LOAD-AND-BUGS.md`):** ✅ **FIXED** — atomic claim via `updateMany(where state=SUBMITTED)` present at `services/edits.ts:767-780`.
- **QA-021 / QA-029 (formula injection in/out):** ✅ FIXED — `lib/excel.ts:81-85` (out) + `services/imports.ts:54-57` (in).
- **QA-027 (open-redirect):** ✅ FIXED — same-origin allowlist `lib/auth.ts:136-147`.
- **PROD-004 (timezone, doc marked "fix before 6am"):** [Unknown] — not re-verified this pass; check `lib/tz.ts` + `today` page. **MISSING INFO.**

---

## PART 1 — TECH-DEBT REGISTER (architecture quality)

| ID | Severity | Item | Evidence | Business impact | Effort |
|----|----------|------|----------|-----------------|--------|
| TD-1 | **Critical** | Rate limiter non-functional in prod (see BUG-1) | `lib/rate-limit.ts:102-104` | Auth brute-force exposure | S (~1h) |
| TD-2 | **High** | Region-less imports fail (see BUG-2) | `services/imports.ts:802` | Core migration path broken | S |
| TD-3 | **High** | Login latency p95 ~3s: two **sequential** PG rate-limit txns + bcrypt + user find + user update (`lastLoginAt`) on **every** login | `lib/auth.ts:248-304`; `docs/PROD-LOAD-AND-BUGS.md:§1` | Slow logins for field salesmen on mobile/edge networks; cold-start compounds | M |
| TD-4 | Medium | No service-layer test coverage. Tests exist only for pure `lib/*` (`access`, `completeness`, `errors`, `excel`, `permissions`, `phone`, `tz`, rate-limit-memory) + 1 e2e login. All approval/import/merge/photo business logic is untested | `tests/` (11 files, unit only) | Regressions in critical flows ship undetected; testability gap | L |
| TD-5 | Medium | Audit table misuse: no `EXPORT` action in enum — exports logged as `action:'IMPORT', entityType:'Export'` (`services/exports.ts:179`, `services/customer-export.ts:227`); dismissed dup-pairs stored as `AuditLog` rows (`services/duplicates.ts:307-315`). Immutable audit log used as mutable app state | as cited | Muddied forensics; can't cleanly report/undo | M |
| TD-6 | Medium | Pervasive type-safety erosion: dozens of `as unknown as Prisma.InputJsonValue` / `as any` casts across services; `fieldChanges`/`attachmentChanges` are untyped `Json` blobs reconstructed by string-prefix parsing (`services/edits.ts:637-653`) — B-22 ("EditFieldChange relational table") deferred (`docs/CHANGELOG.md:106`) | `services/*.ts` throughout | Fragile edit reconstruction; a schema drift in the JSON shape silently corrupts approvals | M–L |
| TD-7 | Medium | Config/env separation: three env files on disk (`.env`, `.env.local`, `.env.example`); `NEXTAUTH_SECRET` vs `AUTH_SECRET` dual-read (`lib/auth.ts:19`); Sentry DSN etc. No single typed config module — env vars read ad hoc across files (`process.env.*` in db, r2, rate-limit, middleware, auth) | multiple | Config drift risk; no startup validation beyond AUTH_SECRET | M |
| TD-8 | Low | Dynamic `await import('@/lib/access')` inside hot server-action paths (`services/edits.ts:624,944`; `services/reactivations.ts:242,328`) instead of a top-level import. Unusual; minor per-call overhead + obscures dependency graph | as cited | Micro-perf + readability | S |
| TD-9 | Low | Duplicate-detector & dashboard in-memory aggregation (see SUS-2, SUS-3) won't scale past ~10k rows | `services/duplicates.ts:62`; `dashboard/page.tsx:96` | Fine at pilot scale; degrades linearly | M |
| TD-10 | Low | Completeness scoring defects (BUG-4, BUG-5) | `lib/completeness.ts:47,58-67` | Slightly inflated/again dead metrics | S |
| TD-11 | Low | Code duplication: `/customers` page scope logic (`app/(app)/customers/page.tsx:64-165`) is re-implemented almost verbatim in `services/customer-export.ts:109-163`. Two copies of role→branchWhere must stay in sync | as cited | Drift risk between list view and its export | M |
| TD-12 | Low | Single shared Prisma client with no explicit connection-pool tuning for serverless/Neon; relies on Neon pooler + keep-warm cron (`app/api/cron/keep-warm`) to mask cold starts | `lib/db.ts`; `vercel.json` | Acceptable at scale; documented workaround | — |

### Cross-cutting assessment notes
- **API design consistency:** Mixed but deliberate. Route handlers (`app/api/*`) return `NextResponse.json` with status codes; server actions return the `SafeAction` union. Consistent WITHIN each style. Photo endpoints use machine `error` codes (`KEY_MISMATCH`, `KIND_MISMATCH`) — good. **Confirmed strong:** finalize ignores client `capturedAt` and derives kind from the R2 key path (`app/api/photos/finalize/route.ts:74-92,123`), closing evidence-freshness spoofing.
- **DB access pattern:** Prisma everywhere; two raw SQL spots (`lib/rate-limit.ts` upsert, `lib/customer-count.ts` `pg_class` estimate) — both parameterised/`regclass`-guarded, no injection. Optimistic locking correctly implemented for edits.
- **Error handling / logging:** Strong. `runAction` prevents RSC message stripping; pino structured logs; import failures deliberately log codes-only to avoid PII leakage (`services/imports.ts:891-901`). Sentry wired.
- **Authz / scope:** Centralised, fail-closed for unscoped Managers (`lib/access.ts:86-96`), branch-level scope filtering for multi-region chains, self-approval blocked (`lib/permissions.ts:134`), peer-admin protection (`canMutateUser`). This is above-average. The one live authz-adjacent defect is the rate limiter (BUG-1).
- **Deployment readiness:** Vercel + Prisma migrate deploy + GH Actions backup + keep-warm; `next.config.ts` static strict-CSP fallback + per-request nonce middleware. Reasonable. **Gap:** rate-limiter regression (BUG-1) should block go/no-go.
- **Backup/recovery:** GH Actions `db-backup.yml` cron; R2 GC tags for 7-day lifecycle recovery (`app/api/cron/photo-gc`). Present.

### CONFIRMED FACTS vs INFERENCES vs UNVERIFIED vs MISSING
- **CONFIRMED (read in code):** BUG-1..5, TD-1..12 evidence citations, secret hygiene, PROD-001/QA-021/QA-027 fixes.
- **REASONABLE INFERENCES:** BUG-1 production impact (test file states PG path is prod-only); SUS-1 race window; scalability of SUS-2/3.
- **UNVERIFIED ASSUMPTIONS:** Exact Neon pool behaviour under concurrency; whether autovacuum keeps `reltuples` fresh enough for the approx count UX.
- **MISSING INFORMATION:** PROD-004 timezone status (not re-checked — verify `lib/tz.ts` + `today` page); live runtime confirmation of BUG-1 (requires a Postgres-backed environment to fire >capacity requests); no load/perf profiling beyond the one documented 10-VU run.
