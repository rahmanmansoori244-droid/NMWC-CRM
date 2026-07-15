# NMWC Unified CRM — Security Remediation & Must-Fix Plan

**Design area:** Security remediation ticket list (input to the consolidation blueprint).
**Base system:** NEW — NMWC Customer Master (`C:\Users\abdulr\Desktop\NMWC-CRM`). OLD — ICO Customer Portal (`C:\Users\abdulr\Desktop\ICO\customer-portal`) contributes requirements only; its code is not lifted, but its live deployment and committed secrets remain a real exposure until decommissioned.
**Method:** every ticket below was re-confirmed against the current source this pass (not taken from discovery docs at face value). Confidence tags: **[Confirmed]** = read in code this pass · **[Proposed]** = my design · **[Open]** = needs a business decision. No secret values are reproduced anywhere in this document — locations and masked references only.

Ticket ID scheme: `SR-Cx` critical, `SR-Hx` high, `SR-Mx` medium, `SR-Lx` low. Every ticket carries: severity, exact file:line, concrete fix, verification, effort.

---

## 1. CRITICAL TICKETS (block everything else)

### SR-C1 — Rotate + purge OLD repo committed `.env` (NEXTAUTH_SECRET / CRON_SECRET) and scrub history
- **Severity:** CRITICAL (auth-bypass class)
- **Evidence [Confirmed this pass]:** `git ls-files` in `C:\Users\abdulr\Desktop\ICO\customer-portal` returns `.env` (tracked); `git log --oneline --all -- .env` → committed in `3761c02` ("Fix all TypeScript errors for production build"). Per discovery (`old-security.md` J-C1), the file contains a real 44-char `NEXTAUTH_SECRET` (masked: `hjT…`), a 64-char `CRON_SECRET` (masked: `b04…`), `DATABASE_URL`, `ADMIN_EMAIL`, SMTP settings. `.gitignore` covers `.env.local`/`.env*.local` but **not bare `.env`** (`old-techdebt.md` BUG-02).
- **Impact:** NEXTAUTH_SECRET disclosure = anyone with repo read access can forge a NextAuth JWT for any user incl. `role:"ADMIN"` on the OLD deployment (stateless JWT sessions). CRON_SECRET = trigger `/api/cron/*` (escalations, mass email). Exposure persists in git history even after deletion — treat every value ever committed as burned.
- **Fix [Proposed] — exact sequence:**
  1. In the OLD hosting env (Vercel): generate and set new `NEXTAUTH_SECRET` (invalidates all sessions — desired) and `CRON_SECRET`; rotate the DB password in the provider and update `DATABASE_URL`; rotate SMTP credentials at the mail provider.
  2. `git rm --cached .env`; append `.env` (bare) to `.gitignore`; commit.
  3. History scrub: `git filter-repo --invert-paths --path .env` (or BFG `--delete-files .env`); force-push; instruct any clone holders to re-clone. If the repo has forks/mirrors you cannot rewrite, rely on rotation (step 1) as the actual control — the scrub is hygiene, rotation is the fix.
  4. Also remove the stale `prisma/dev.db` (344 KB SQLite with possible real data) and the tracked `tsconfig.tsbuildinfo` while rewriting (`old-techdebt.md` §1.7, BUG-01).
- **Verification:** `git log --all -- .env` empty after rewrite; `gitleaks detect --source .` clean; old JWTs rejected (login required) on OLD deployment; cron endpoints 401 with the old bearer.
- **Effort:** 0.5 day (rotation) + 0.5 day (rewrite + coordination).
- **[Open] OQ-1:** Does OLD stay live in production during the consolidation window? If yes, SR-H3 (session staleness patch) also applies to it; if it is frozen/decommissioned at cutover, rotation alone suffices.

### SR-C2 — Rotate + purge NEW repo committed pilot credentials; re-enable `mustChangePassword`; add gitleaks CI gate
- **Severity:** CRITICAL (full RBAC nullification — STEWARD credential is public to anyone with repo access)
- **Evidence [Confirmed this pass]:** `git ls-files` in the NEW repo tracks both `docs/PILOT-MUSCAT-CREDENTIALS.md` and `scripts/bulk-reset-credentials.ts`. The script hardcodes `SALESMAN_PASSWORD = '[REDACTED-PILOT-PW]'` (`scripts/bulk-reset-credentials.ts:38`) and `STAFF_PASSWORD = '[REDACTED-PILOT-PW]'` (`:39`), covers `pilot.steward` / `pilot.manager` / `ahmed.alndabi` (`:57`), and sets `mustChangePassword: false` + wipes `PasswordHistory` (header, `:21-23`). The credentials doc lists live usernames + the same passwords + the production URL. `.github/workflows/ci.yml` (22 lines) runs typecheck/lint/test only — **no secret scanning**. Contrast: the proper create-user flow sets `mustChangePassword: true` (`services/users.ts:149`, `:274`).
- **Impact:** STEWARD is the highest-privilege role (imports, merges, bypasses all field locks and scope). Anyone who reads the repo can log in as STEWARD at the public URL. Shared passwords also destroy per-user audit attribution (`lib/audit.ts` actor trail becomes meaningless).
- **Fix [Proposed] — exact sequence:**
  1. **Rotate now (before any code change):** run a one-off reset that generates a unique random password per active user (`crypto.randomBytes`), sets `mustChangePassword: true`, bumps `sessionsRevokedAt` (kills live JWTs ≤5 min via `lib/auth.ts:165-217` freshness re-read), and emits the one-time password list to stdout/local file only — never into the repo.
  2. Replace `scripts/bulk-reset-credentials.ts` with a parameterized `scripts/reset-user-password.ts` that accepts `--username` and reads the new password from `process.env.NEW_PASSWORD` or generates one; delete the two hardcoded constants entirely. Keep the good parts (bcrypt cost 12, `sessionsRevokedAt` bump, audit row).
  3. `git rm docs/PILOT-MUSCAT-CREDENTIALS.md`; move operational instructions (minus secrets) into `docs/OPERATIONS.md`.
  4. History scrub: `git filter-repo --invert-paths --path docs/PILOT-MUSCAT-CREDENTIALS.md` plus `--replace-text` for the two literal password strings in the script's history. Same fork/mirror caveat as SR-C1 — rotation is the real control.
  5. Add a gitleaks job to `.github/workflows/ci.yml`:
     ```yaml
     secrets-scan:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with: { fetch-depth: 0 }
         - uses: gitleaks/gitleaks-action@v2
           env:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     ```
     plus a local pre-commit hook (`gitleaks protect --staged`) documented in the repo.
  6. Confirm the on-disk `.env`/`.env.local` at NEW repo root (gitignored, never committed — verified `git log --all -- .env` empty per discovery) hold **dev-only** values distinct from Vercel prod; rotate `NEXTAUTH_SECRET`/`SEED_ADMIN_PASSWORD` if they ever matched prod.
- **Verification:** login with `[REDACTED-PILOT-PW]`/`[REDACTED-PILOT-PW]` fails for every account; first login for each user forces password change (`mustChangePassword` flow); gitleaks CI red on a planted canary secret in a test branch; `git log --all -- docs/PILOT-MUSCAT-CREDENTIALS.md` empty.
- **Effort:** 1 day incl. coordination with the pilot field team.
- **[Open] OQ-2:** The owner explicitly accepted shared weak passwords on 2026-05-11 (recorded in the script header). The locked consolidation decision overrides this ("rotate+purge + re-enable mustChangePassword"), but the **distribution mechanism** for per-user passwords to low-tech-literacy salesmen (printed slips via supervisors? SMS? in-person at branch?) needs an owner decision before the reset is executed.

### SR-C3 — Fix NEW rate limiter: Postgres path never denies (BUG-1)
- **Severity:** CRITICAL (production brute-force protection is OFF)
- **Evidence [Confirmed this pass]:** `lib/rate-limit.ts:82-105`. The `ON CONFLICT DO UPDATE` subtracts 1 only when refilled ≥ 1 (`CASE … ELSE 0`, lines 92-99), so post-update `"tokens"` is floored at ≥ 0; the `RETURNING ("tokens" >= 0) AS "granted"` at **lines 102-104** is therefore **always true**. Every request is granted; `{ ok:false }` is unreachable on the PG path. This defeats `LOGIN_LIMIT` (capacity 5, line 114), `FORM_LIMIT`, `PHOTO_LIMIT` in any env with `DATABASE_URL` set (i.e. production). The fail-closed branch (lines 45-49) only fires on a thrown DB error — the query here *succeeds wrongly*, so it never engages. The unit test covers only the memory path (`tests/unit/rate-limit.test.ts` header states the PG path "is exercised in production").
- **Fix [Proposed] — minimal one-expression change in `checkLimitPg`:** always subtract 1 and floor at −1 so a denied request leaves a negative marker, making `tokens >= 0` a correct grant predicate:
  ```sql
  ON CONFLICT ("key") DO UPDATE SET
    "tokens" = GREATEST(
      -1::float,
      LEAST(
        ${cfg.capacity}::float,
        "RateLimit"."tokens" +
          EXTRACT(EPOCH FROM (NOW() - "RateLimit"."lastRefill")) * ${cfg.refillPerSec}
      ) - 1
    ),
    "lastRefill" = NOW(),
    "updatedAt" = NOW()
  RETURNING "tokens", ("tokens" >= 0) AS "granted";
  ```
  Semantics: refilled ≥ 1 ⇒ tokens = refilled−1 ≥ 0 ⇒ granted; refilled < 1 ⇒ tokens = refilled−1 < 0 ⇒ denied. The `GREATEST(-1, …)` caps the penalty at one token (~12 s extra at login refill rate) so repeated denials cannot spiral into unbounded lockout. Existing `retryAfterSec` math (`deficit = 1 - row.tokens`, lines 109-110) remains correct for negative tokens. No schema change required (`RateLimit.tokens` is float).
- **Verification (required, gates go-live):** new **Postgres-path integration test** `tests/integration/rate-limit-pg.test.ts`, gated on `TEST_DATABASE_URL`: (a) fire `LOGIN_LIMIT.capacity` calls → all `ok:true`; (b) call N+1 → `ok:false` with sane `retryAfterSec`; (c) wait/refill (or backdate `lastRefill` via SQL) → grants again; (d) two concurrent callers on one key never both consume the last token. Wire into CI with a Postgres service container. Manual check: >5 rapid failed logins on staging → 429/denied message.
- **Effort:** ~2 h fix + ~4 h integration test + CI service container.

---

## 2. HIGH TICKETS (must land before onboarding OLD's larger user/customer population)

### SR-H1 — Manager direct-write edits not region-scoped (H-1) + edit page missing Manager gate
- **Severity:** HIGH (broken object-level authorization; writes to master outside authority)
- **Evidence [Confirmed this pass]:** `services/edits.ts:259-264` — `submitEditCore` role gate: SALESMAN gets an `onMyRoute` check; MANAGER falls through the `else if (me.role !== Role.STEWARD && me.role !== Role.MANAGER)` guard with **no `managedRegions` check**. Line 421: `const isDirectWrite = !isDraft && (me.role === Role.STEWARD || me.role === Role.MANAGER)` → lines 424-451 apply directly to the master via `applyEditChanges` with `reviewedById = me.id` (looks self-approved in audit). Contrast: Manager scope IS fail-closed on read (`lib/access.ts:92`), branch filtering (`lib/access.ts:121`), and the reactivation approve path (`services/reactivations.ts:242-249`). Page layer: `app/(app)/customers/[id]/edit/page.tsx:83-97` redirects SUPERVISOR/VIEWER and scope-checks SALESMAN, but has **no MANAGER check** — an out-of-region Manager can open the form.
- **Failure scenario:** Muscat-only Manager POSTs `editCustomerAction` with a Dhofar `customerId` → direct master write (legalName/phone/CR) outside authority, audit shows a legitimate-looking self-review.
- **Fix [Proposed] — two exact edits:**
  1. `services/edits.ts` — after line 264, add a MANAGER branch reusing the existing helpers (`lib/access.ts:158-164` `assertCanEditCustomer`, which for MANAGER delegates to fail-closed `canSeeCustomer`):
     ```ts
     } else if (me.role === Role.MANAGER) {
       const { loadScope, assertCanEditCustomer } = await import('@/lib/access');
       const scope = await loadScope(me.id);
       assertCanEditCustomer({ id: me.id, role: me.role, username: '' }, customer, scope);
     } else if (me.role !== Role.STEWARD) {
       throw new ForbiddenError(`Role ${me.role} cannot submit edits.`);
     }
     ```
     (Empty `managedRegions` ⇒ `canSeeCustomer` returns false ⇒ Forbidden — fail-closed for free.)
  2. `app/(app)/customers/[id]/edit/page.tsx` — after `loadScope` at line 108, add:
     ```ts
     if (session.user.role === Role.MANAGER &&
         !canEditCustomer(sessionUser, customer, scope)) {
       redirect(`/customers/${customer.id}`);
     }
     ```
- **Consolidation note [Proposed]:** when the 8-role model lands, re-derive this gate from a single `canEditCustomer` call for ALL roles (SALESMAN/MANAGER/STEWARD) instead of per-role branches — the current duplication is exactly why MANAGER was missed.
- **Verification:** unit test in `tests/unit/access.test.ts` style + a service test: Manager with regions `[A]` submitting an edit for a customer whose only branch is in region B → ForbiddenError; Manager with empty regions → ForbiddenError; in-region Manager → direct write succeeds.
- **Effort:** ~3 h incl. tests.

### SR-H2 — Region-less import writes a Route id into `Branch.regionId` (BUG-2) — blocks the OLD-customer migration path
- **Severity:** HIGH (functional/integrity; every region-less legacy row is REJECTED — this is the exact path the consolidation migration will exercise)
- **Evidence [Confirmed this pass]:** `services/imports.ts:751-762` — `unassignedRegion` is declared with `let` *inside* `if (!unassignedRoute)`; when the UNASSIGNED route already exists, no Region is ever loaded. Line 802: `const effectiveRegionId = (region ?? unassignedRoute!).id;` — falls back to a **Route** id. At `tx.branch.upsert` the `Branch.regionId → Region` FK rejects it (P2003), the per-customer transaction throws, and the group is marked REJECTED (`services/imports.ts` failure handler ~891-922).
- **Fix [Proposed] — hoist and correct the fallback:**
  ```ts
  // replace lines 751-762
  let unassignedRegion = await prisma.region.findUnique({ where: { code: 'UNASSIGNED' } });
  if (!unassignedRegion) {
    unassignedRegion = await prisma.region.create({
      data: { code: 'UNASSIGNED', name: 'Unassigned' },
    });
  }
  let unassignedRoute = await prisma.route.findUnique({ where: { code: 'UNASSIGNED' } });
  if (!unassignedRoute) {
    unassignedRoute = await prisma.route.create({
      data: { code: 'UNASSIGNED', name: 'Unassigned', regionId: unassignedRegion.id },
    });
  }
  // line 802
  const effectiveRegionId = (region ?? unassignedRegion).id;
  ```
- **Verification:** service-level test: import a batch containing (a) a row with blank region, (b) a row with unknown region code, with the UNASSIGNED route pre-existing → both promote; `Branch.regionId` resolves to the UNASSIGNED **Region**; steward sees the F-17 flag. Re-run migration dry-run on a Temix extract with blank `sales_region` values.
- **Effort:** ~1 h incl. test. **Must land before the Temix/OLD data migration import.**

### SR-H3 — OLD session staleness (≤8 h stale role/isActive) — containment during the transition window
- **Severity:** HIGH on the OLD deployment; N/A for NEW (already solved)
- **Evidence:** OLD `lib/auth.ts:105-120` jwt/session callbacks never re-read the user; `isActive` checked only at login (`lib/auth.ts:76`); `maxAge = 8h` (`old-security.md` J-H1) [Confirmed in discovery; OLD code not re-read this pass]. NEW already implements the correct model: 5-min DB freshness re-read honoring `isActive`, role change, and `sessionsRevokedAt` (`lib/auth.ts:165-217`) [Confirmed in prior pass].
- **Design position [Proposed]:** Do **not** port any OLD auth code (locked decision: OLD code is not lifted). The ticket is containment: (a) if OLD stays live > ~2 weeks during consolidation, apply a minimal patch — re-fetch `isActive`+`role` in the `jwt` callback, reject when disabled — or drop `maxAge` to 1 h; (b) if OLD is frozen at cutover, do nothing beyond SR-C1 rotation (which itself invalidates all OLD sessions). Consolidated system inherits NEW's session model unchanged; the 8-role expansion must keep the `sessionsRevokedAt` bump on role change (already done in `services/users.ts`).
- **Verification (if patched):** disable a user on OLD → next request within 1 poll interval is rejected.
- **Effort:** 0 (decommission path) or ~3 h (patch path). Depends on **OQ-1**.

---

## 3. MEDIUM TICKETS

### SR-M1 — Approve path silently drops CASH customers' CR number (BUG-3)
- **Severity:** MEDIUM (silent data loss in the core approval pipeline)
- **Evidence [Confirmed this pass]:** submit-time locks are applied independently — `services/edits.ts:284-289` checks `isFieldLocked('legalName', …)` and `isFieldLocked('crNumber', …)` separately (crNumber is locked only for CREDIT customers per `lib/permissions.ts`). But approve-time, `services/edits.ts:682-692`, guards only on `isFieldLocked('legalName', …)` (always true for SALESMAN) and then deletes **both** `customerProposed.legalName` and `customerProposed.crNumber` — discarding a CASH customer's legitimately collected CR number.
- **Fix [Proposed] — mirror the submit logic exactly:**
  ```ts
  if (submitterUser?.role === Role.SALESMAN) {
    const shape = { id: submitter.id, role: Role.SALESMAN, username: '' };
    if (isFieldLocked('legalName', shape, edit.customer)) delete customerProposed.legalName;
    if (isFieldLocked('crNumber', shape, edit.customer)) delete customerProposed.crNumber;
  }
  ```
  This preserves the QA-013 intent (re-evaluate against CURRENT payment terms: CASH→CREDIT between submit and approve still drops crNumber correctly).
- **Verification:** service test: SALESMAN edits CASH customer setting `crNumber` → supervisor approve → master `crNumber` updated. Repeat with customer flipped to CREDIT before approve → `crNumber` dropped.
- **Effort:** ~1 h incl. tests.
- **Consolidation relevance:** the CASH create workflow (Salesman→Supervisor→Accountant) will reuse this approve path; shipping it broken would corrupt new-customer CR capture.

### SR-M2 — `/customers` list not fail-closed for empty-region Manager (G-A1)
- **Severity:** MEDIUM (read-scope leak; contradicts the RBAC-05-012 fail-closed rule enforced everywhere else)
- **Evidence [Confirmed this pass]:** `app/(app)/customers/page.tsx:77-84` — for MANAGER with `regionIds.length === 0`, only `branchInclude.where = { id: '__none__' }` is set (blanks the card subtitle); `branchSomeBase` stays `undefined`, so `baseWhere` remains `{ deletedAt: null }` and the list returns **every customer**. Contrast fail-closed: `lib/access.ts:92` (`canSeeCustomer` returns false), export path, and the SALESMAN no-route branch on the same page (line 66 sets `baseWhere.id = '__none__'`).
- **Fix [Proposed]:** in the MANAGER else-branch (line 82-84), add the same sentinel used for route-less salesmen:
  ```ts
  } else {
    baseWhere.id = '__none__';
    branchInclude.where = { id: '__none__' };
  }
  ```
  Also add the equivalent guard to any count/stat queries on the page that reuse `baseWhere`.
- **Consolidation note [Proposed]:** TD-11 (scope logic duplicated between this page and `services/customer-export.ts:109-163`) is the root cause; the consolidation build should extract a single `buildCustomerListWhere(user, scope, filters)` in `lib/access.ts` used by page, export, and the future dashboards, so fail-closed is encoded once.
- **Verification:** e2e: Manager with no `managedRegions` logs in → `/customers` shows zero rows + the empty-scope banner. Unit test on the extracted where-builder.
- **Effort:** ~1 h tactical; extraction ~1 day (fold into consolidation refactor).

### SR-M3 — Dependency + supply-chain hardening
- **Severity:** MEDIUM
- **Evidence [Confirmed this pass]:** NEW `package.json`: `next-auth ^5.0.0-beta.31` (beta channel, caret range — a `npm i` can silently jump betas), `next ^15.0.0`, `exceljs ^4.4.0` (NEW does **not** use the vulnerable `xlsx` package — that is OLD-only: `xlsx@0.18.5`, CVE-2023-30533/CVE-2024-22363, used in OLD `master/upload`). CI (`.github/workflows/ci.yml`) has no `npm audit` step.
- **Fix [Proposed]:** (1) pin `next-auth` to an exact beta (remove `^`) and record an upgrade note to GA when released; (2) add `npm audit --omit=dev --audit-level=high` to CI (allow-list file for accepted advisories); (3) enable Dependabot/Renovate weekly; (4) OLD's `xlsx` is remediated by decommissioning OLD — do not port any xlsx-based parser; the consolidated import/export stays on `exceljs` + the existing formula-injection guards (`lib/excel.ts:81-85` out, `services/imports.ts:54-57` in).
- **Verification:** CI fails on a known-vulnerable transitive pin in a test branch.
- **Effort:** ~3 h.

### SR-M4 — CSP hardening: drop `style-src 'unsafe-inline'`
- **Severity:** MEDIUM-LOW (script-src already nonce'd + strict-dynamic; residual risk is CSS exfiltration/UI redress)
- **Evidence [Confirmed this pass]:** `next.config.ts:33` and `middleware.ts:35` both ship `style-src 'self' 'unsafe-inline'` (Tailwind runtime injection, per the comment at `next.config.ts:13`).
- **Fix [Proposed]:** move to hashed/nonce'd styles once Tailwind v4/Next support stabilizes; interim: keep, but add `frame-ancestors 'none'` / verify `form-action 'self'` present in both CSP emitters and add a regression test asserting the two CSP strings stay in sync (they are hand-duplicated today — drift risk).
- **Verification:** CSP evaluator (Lighthouse/csp-evaluator) score; header parity test.
- **Effort:** ~0.5 day (parity test now; unsafe-inline removal tracked).

### SR-M5 — Login rate-limit posture after SR-C3 (defense-in-depth)
- **Severity:** MEDIUM-LOW
- **Evidence [Confirmed this pass]:** `lib/rate-limit.ts:114` `LOGIN_LIMIT = { capacity: 5, refillPerSec: 5/60 }`, keyed per-username AND per-IP (`app/actions/auth.ts`, `lib/auth.ts`); fail-closed for `login:`/`passwordreset:` keys on DB exception (lines 45-49) — good design, currently moot because of BUG-1.
- **Fix [Proposed]:** after SR-C3 lands, add progressive lockout: on the Nth consecutive `LOGIN_FAIL` audit row for a username within 15 min, require a 15-min cool-down and emit an ops alert (Sentry). Uses the existing `AuditAction.LOGIN_FAIL` (`prisma/schema.prisma:86`) — no schema change.
- **Effort:** ~1 day. Sequence after SR-C2 (strong passwords) + SR-C3.

---

## 4. LOW TICKETS

### SR-L1 — Completeness scoring defects (BUG-4 / BUG-5)
- **Evidence [Confirmed this pass]:** `lib/completeness.ts:47` — `if (c.notes || c.paymentTerms) s += 5;` — `paymentTerms` is a non-nullable enum defaulting to CASH, so every customer gets +5 (the "has notes" signal is dead). `lib/completeness.ts:58-67` — outer equipment guard is tautological (`(x ?? 0) >= 0` always true); only the inner `sum > 0` matters.
- **Fix [Proposed]:** line 47 → `if (c.notes) s += 5;`. Lines 58-67 → collapse to `if ((b.coolersCount ?? 0) + (b.standsCount ?? 0) + (b.emptyBottlesCount ?? 0) > 0) s += 5;`. Then run the existing rescore path (scores are recomputed on edit-approve; add a one-off `scripts/rescore-all.ts` batch or fold into the consolidation migration, since all completeness thresholds shift down by 5).
- **Verification:** unit tests in `tests/unit/completeness.test.ts` updated; dashboard avg shifts as expected on staging.
- **Effort:** ~2 h + rescore run.
- **[Open] OQ-3:** the pilot's dashboard bands/PRD targets were calibrated with the inflated +5. Rebase thresholds or keep score compatibility? (Product owner call — trivial either way.)

### SR-L2 — Audit taxonomy: add `EXPORT` action; stop using AuditLog as mutable state
- **Evidence [Confirmed this pass]:** `prisma/schema.prisma:72-91` — `enum AuditAction` has no `EXPORT`; exports are logged as `action: 'IMPORT', entityType: 'Export'` with an apologetic comment (`services/exports.ts:179-180`, `services/customer-export.ts:226-227`). Separately, dismissed duplicate pairs are persisted as AuditLog rows and reconstructed by scanning (`services/duplicates.ts`, discovery SUS-2).
- **Fix [Proposed]:**
  1. Migration (fold into the consolidation's role-enum migration to save a deploy):
     ```sql
     ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPORT';
     ```
     (PG ≥12 allows ADD VALUE in a transaction as long as the value isn't used in the same transaction — keep the enum migration separate from any data migration that writes `EXPORT` rows.)
  2. Update `services/exports.ts:179` and `services/customer-export.ts:226` to `action: 'EXPORT'`.
  3. New model for dup dismissals (design input for the data-model workstream):
     ```prisma
     model DuplicateDismissal {
       id           String   @id @default(cuid())
       customerAId  String
       customerBId  String
       dismissedById String
       reason       String?
       createdAt    DateTime @default(now())
       revokedAt    DateTime?
       @@unique([customerAId, customerBId])
     }
     ```
     `dismissDuplicateCore` writes here (plus a normal audit row); the detector joins against `revokedAt IS NULL`. Enables un-dismiss, removes the audit-as-state abuse.
- **Verification:** export produces an `EXPORT` audit row; audit report filters by EXPORT; dismiss→un-dismiss round-trip test.
- **Effort:** enum+call-sites ~1 h; dismissal model ~0.5 day.

### SR-L3 — Reactivation approve missing optimistic version lock (SUS-1)
- **Evidence [Confirmed this pass]:** `services/reactivations.ts:255-302` (`approveReactivationCore` transaction) uses plain `tx.branch.update` / `tx.customer.update` with **no `version` guard or increment** — contrast `applyEditChanges` (`services/edits.ts:526-568`), which does `updateMany({ where: { id, version }, data: { …, version: { increment: 1 } } })` and throws `VERSION_CONFLICT` on count 0. A Manager approving a reactivation concurrently with a Supervisor approving an edit on the same branch is last-write-wins.
- **Fix [Proposed]:** replicate the guarded pattern: read `version` for branch (and customer when flipping status), use `updateMany` with `{ id, version }` + `version: { increment: 1 }`, throw `ConflictError('VERSION_CONFLICT', …)` on count 0 (the UI already handles that error code from the edit path).
- **Verification:** concurrency test: fire `approveReactivationAction` + `approveEditAction` on one branch in parallel → exactly one succeeds, the other returns VERSION_CONFLICT.
- **Effort:** ~3 h incl. test.

### SR-L4 — OLD-only residuals (relevant ONLY if OLD stays live past cutover; else closed by decommission)
- [Confirmed in discovery, not re-read this pass] Timing-unsafe CRON_SECRET compares + bcrypt user-enumeration oracle (OLD `cron/sla-check:10`, `daily-summary:9`, `auth.ts:72-83` — J-M4); middleware doesn't backstop `/api/admin/*` (J-M1); `xlsx@0.18.5` (J-M2); hardcoded seed admin password `prisma/seed-production.ts:42` (BUG-07). **Design position [Proposed]:** none of these are ported — NEW already has timing-safe cron compares, DUMMY-hash constant-time login, middleware allowlist, exceljs, and env-driven seeding. Track as a single "OLD containment" ticket contingent on OQ-1; the seed password account should be checked/disabled on the OLD prod DB regardless (~15 min).

---

## 5. REMEDIATION SEQUENCE (ordered; gates for onboarding the OLD population)

**Phase 0 — Immediate (this week, before any consolidation code):**
1. SR-C2 step 1 (rotate NEW pilot passwords + `mustChangePassword` + session revoke) — *hours, no deploy needed (script run)*.
2. SR-C1 step 1 (rotate OLD NEXTAUTH_SECRET/CRON_SECRET/DB/SMTP) — *hours*.
3. SR-C3 (rate-limiter fix + PG integration test) — deploy with 4.
4. SR-H1 (Manager write scope + edit-page gate) — deploy with 3.

**Phase 1 — Before the migration import & before onboarding OLD's users (~week 1-2):**
5. SR-C1/C2 history scrubs + gitleaks CI + `.gitignore` fixes.
6. SR-H2 (import UNASSIGNED region fix) — **hard gate for the Temix/OLD customer migration**.
7. SR-M1 (CASH crNumber at approve) — gate for the CASH create workflow build.
8. SR-M2 (customers list fail-closed).
9. SR-M3 (dependency pinning + audit CI).
10. Decide OQ-1 → execute SR-H3 (patch or freeze OLD).

**Phase 2 — With the consolidation build (role enum / schema migrations):**
11. SR-L2 (EXPORT enum — ride the same migration as the 8-role enum expansion; DuplicateDismissal model with the branch-model work).
12. SR-L3 (reactivation version lock — before Manager approval volume grows with GM/FINANCE_MANAGER flows).
13. SR-M5 (progressive lockout + alerting — before user count grows ~10x with OLD's population).
14. SR-L1 (completeness fixes + rescore — fold into the migration rescore).

**Phase 3 — Hardening (post-cutover):**
15. SR-M4 (CSP style-src), CSP parity test, SR-L4 residual closure via OLD decommission.

**Go/no-go gate for onboarding OLD's user/customer population:** Phases 0 and 1 complete, PG rate-limit integration test green in CI, gitleaks green, and a staging exercise proving: out-of-region Manager write → Forbidden; empty-region Manager list → empty; region-less import row → promoted to UNASSIGNED.

---

## 6. OPEN QUESTIONS (business decisions required)

- **OQ-1:** Does the OLD ICO portal remain in production during the consolidation window, and for how long? Determines SR-H3 (patch vs. freeze) and SR-L4 scope. Recommendation: freeze OLD to read-only at migration start.
- **OQ-2:** Password distribution mechanism for per-user credentials to field salesmen after SR-C2 (printed slips via supervisors / SMS / in-person). The rotation itself is locked; only logistics are open.
- **OQ-3:** After SR-L1, completeness scores drop ~5 points fleet-wide — rebase the dashboard bands/PRD targets, or apply a compensating rubric change?
- **OQ-4:** History rewrite (`git filter-repo`) requires force-push and re-clones; if either repo has external mirrors/forks (e.g., contractor clones), confirm inventory before rewriting — otherwise rely on rotation and document residual history exposure as accepted.
- **OQ-5:** Should `mustChangePassword` enforcement be coupled with a minimum-length ≥12 policy for salesmen (matches `passwordRule` for app-set passwords), or a relaxed field policy (≥8 + lockout)? Affects SR-C2 script parameters.

## 7. Verification summary matrix

| Ticket | Automated test | Manual/staging check |
|---|---|---|
| SR-C1/C2 | gitleaks CI green; canary-secret branch fails CI | old creds rejected; forced password change on first login |
| SR-C3 | `tests/integration/rate-limit-pg.test.ts` (PG container) | 6th rapid login denied on staging |
| SR-H1 | service test: out-of-region/empty-region Manager → Forbidden | Manager UX regression pass |
| SR-H2 | import test: blank/unknown region → UNASSIGNED region promote | migration dry-run on Temix extract |
| SR-M1 | approve test: CASH crNumber persists; CREDIT dropped | — |
| SR-M2 | where-builder unit test | empty-region Manager sees 0 rows |
| SR-L2 | audit row `action=EXPORT` asserted in export test | audit report filter |
| SR-L3 | parallel approve concurrency test → one VERSION_CONFLICT | — |
