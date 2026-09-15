# Section J — Defensive Security & Access-Control Review

**System:** NMWC Customer Master (NEW). Root: `C:\Users\abdulr\Desktop\NMWC-CRM`
**Stack:** Next.js 15 (App Router, RSC + Server Actions), Auth.js v5 (JWT sessions), Prisma 6 / Neon Postgres, Cloudflare R2, bcryptjs, pino, Sentry, Vercel.
**Method:** static read-only trace of code (no docs trusted at face value; claims verified in source).
**Overall posture:** Strong. The team has clearly done multiple security passes (RBAC-05-*, AUTH-*, QA-*, B-*, F-* tags throughout). Access control, password handling, session revocation, rate-limiting, CSP, and IDOR defenses are largely present and correctly implemented. The dominant residual risks are **operational** (weak shared credentials committed to git) plus **one confirmed authorization gap** (Manager direct-write is not region-scoped).

---

## CONFIRMED FACTS vs INFERENCES vs UNVERIFIED

**Confirmed (read in code):** all findings tagged [Confirmed] below.
**Reasonable inferences:** production env values (secrets) are configured in Vercel, not the repo — the repo only tracks `.env.example` with empty values.
**Unverified / needs runtime:** actual production env var values; whether `DEMO_ACCOUNTS_DISABLED` is set in prod; whether R2 bucket is truly private (bucket ACL is server-side config, not in repo); Neon backup/retention config; whether the pilot weak passwords were rotated after the doc's 2026-05-11 date.
**Missing information:** Vercel project settings, R2 bucket policy, Neon backup policy, WAF/edge config.

---

## FINDINGS (prioritized)

### CRITICAL

#### C-1. Plaintext production credentials for all 13 users committed to git — including admin-tier (MANAGER/STEWARD) [Confirmed]
- **Evidence:** `docs/PILOT-MUSCAT-CREDENTIALS.md` (git-tracked — confirmed via `git ls-files`). Lists live usernames + passwords: 10 salesmen `c1-nmwc`…`mh02-nmwc` / `[REDACTED-PILOT-PW]`; staff `pilot.manager`, `pilot.steward` (STEWARD = highest privilege), `ahmed.alndabi` / `[REDACTED-PILOT-PW]`. Live URL `https://nmwc-cm.vercel.app` in the same file.
- **Corroborated by:** `scripts/bulk-reset-credentials.ts` (git-tracked) hardcodes `SALESMAN_PASSWORD = '[REDACTED-PILOT-PW]'`, `STAFF_PASSWORD = '[REDACTED-PILOT-PW]'`, sets `mustChangePassword=false`, clears `PasswordHistory`, and disables forced rotation.
- **Impact:** Anyone with repo read access (or who finds the public deploy URL + guesses the trivially documented scheme) can authenticate as **STEWARD** — the role that runs imports, merges customers, and bypasses all field locks and all scope checks. Passwords are also weak (`[REDACTED-PILOT-PW]` = a top-10 breached password) and **shared** (no per-user attribution — every "steward" action is really "whoever knows the password"). This nullifies the entire RBAC model.
- **Note on git history:** even if the doc is later scrubbed, these credentials persist in git history and must be treated as permanently compromised.
- **Remediation (do in this order):** (1) Rotate every password to unique high-entropy secrets NOW; set `mustChangePassword=true`. (2) Remove `docs/PILOT-MUSCAT-CREDENTIALS.md` from the repo AND purge from history (`git filter-repo`); rotate anything it exposed. (3) Delete/relocate the hardcoded passwords in `scripts/bulk-reset-credentials.ts` (accept only via env/prompt). (4) Add a pre-commit secret scanner (gitleaks) and a CI gate. (5) Enforce per-user credentials before any expansion beyond the pilot (the doc itself flags this but it is unenforced).

---

### HIGH

#### H-1. MANAGER direct-write edits are NOT region-scoped — Broken Object-Level Authorization via `customerId` [Confirmed]
- **Evidence:** `services/edits.ts` → `submitEditCore`, role gate at lines 259-264:
  ```
  if (me.role === Role.SALESMAN) { ...onMyRoute check... }
  else if (me.role !== Role.STEWARD && me.role !== Role.MANAGER) { throw }
  ```
  MANAGER falls through with **no `managedRegions` check**. Then line 421 `const isDirectWrite = !isDraft && (me.role === Role.STEWARD || me.role === Role.MANAGER)` and lines 424-451 apply the change **directly to the master with no approval** (`applyEditChanges`).
- **Contrast:** Manager region scope IS fail-closed everywhere else — read (`lib/access.ts` `canSeeCustomer` line 92, returns false when `managedRegionIds.length===0`), approve (`lib/permissions.ts` `canApproveSpecificEdit` lines 135-142, region overlap required), and export (`services/exports.ts` lines 59-86, intersection). The direct-edit write path is the one place the scope is skipped.
- **Corroborating gap at page layer:** `app/(app)/customers/[id]/edit/page.tsx` lines 83-97 redirects SUPERVISOR/VIEWER and scope-checks SALESMAN, but performs **no `canSeeCustomer`/`canEditCustomer` check for MANAGER** — so a Manager can even reach the enrichment form for an out-of-region customer.
- **Failure scenario:** A Manager who manages only the Muscat regions POSTs `editCustomerAction` with a `customerId` belonging to a Dhofar customer (ID obtainable via export intersection edge cases, guesswork, or shared links). The edit writes directly to the master, altering legalName/phone/CR/etc. outside their authority, with `reviewedById = me.id` (looks self-approved/legitimate in audit).
- **Remediation:** In `submitEditCore`, for `me.role === MANAGER` load scope (`loadScope`) and assert at least one non-deleted branch of the target customer is in `managedRegionIds` (reuse `assertCanEditCustomer` from `lib/access.ts`, which already encodes exactly this for MANAGER). Also add the same `canSeeCustomer` gate for MANAGER on the edit page.

---

### MEDIUM

#### M-1. Shared/rotated passwords + `mustChangePassword=false` defeat per-user auditability and revocation [Confirmed]
- **Evidence:** `scripts/bulk-reset-credentials.ts` sets `mustChangePassword=false` for all and clears `PasswordHistory`; `docs/PILOT-MUSCAT-CREDENTIALS.md` "Forced password change disabled". The otherwise-excellent audit trail (`lib/audit.ts`, per-action `actorId`+ip+ua) becomes meaningless when N people share one login.
- **Impact:** No non-repudiation; a leaked shared password cannot be traced to an individual; `sessionsRevokedAt` revocation is per-account not per-person.
- **Remediation:** Per-user secrets + `mustChangePassword=true` on issuance (the create-user flow at `services/users.ts` line 149 already does this correctly for new users — the bulk script overrides it).

#### M-2. Login rate limit is generous against weak numeric passwords [Confirmed]
- **Evidence:** `lib/rate-limit.ts` `LOGIN_LIMIT = { capacity: 5, refillPerSec: 5/60 }` (≈1 attempt / 12s sustained after burst). Keyed per-username AND per-IP (`app/actions/auth.ts` lines 40-55, `lib/auth.ts` lines 249-266). Fails **closed** on DB outage for `login:`/`passwordreset:` keys (`lib/rate-limit.ts` lines 45-49) — good.
- **Impact:** Against a strong password this is fine. Against the pilot's `[REDACTED-PILOT-PW]` (10^8 space but a known top-breached value) or `[REDACTED-PILOT-PW]`, per-user throttling + known usernames still leaves the shared static passwords the weak link. This is a defense-in-depth note; the root issue is C-1/M-1.
- **Remediation:** Keep the limiter; fix credential strength. Consider lowering `capacity`/adding progressive backoff and an account-lock threshold with alerting.

#### M-3. `.env` and `.env.local` present on disk with real secret values (not committed, but co-located) [Confirmed — presence; values NOT read]
- **Evidence:** both files exist at repo root, byte-identical (1075 bytes), and are correctly listed in `.gitignore` (`.env`, `.env.local`, `.env.*.local`). `git ls-files` confirms only `.env.example` is tracked; `git log --all --diff-filter=A` shows no env file was ever committed. Keys present (names only): `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `SENTRY_AUTH_TOKEN`, `SEED_ADMIN_PASSWORD`, etc. Values were intentionally NOT printed.
- **Impact:** Low residual (gitignored), but developer-machine secrets sitting in the working tree risk accidental commit if `.gitignore` is ever edited or a `git add -f` is run. `SEED_ADMIN_PASSWORD` and `NEXTAUTH_SECRET` in a checked-out file are the sensitive ones.
- **Remediation:** Confirm these are dev-only values distinct from production (prod secrets should live only in Vercel). Rotate `NEXTAUTH_SECRET`/DB creds if this file ever held prod values. Keep gitleaks pre-commit as the backstop.

#### M-4. `style-src 'unsafe-inline'` remains in CSP [Confirmed]
- **Evidence:** `next.config.ts` line 33 and `middleware.ts` line 36 both keep `style-src 'self' 'unsafe-inline'` (Tailwind JIT injects inline styles). `script-src` is properly nonce'd + `strict-dynamic` (middleware) / `'self'` only (static fallback) — script XSS is well contained.
- **Impact:** Limited — inline styles enable CSS-based exfiltration/UI-redress in narrow cases, not script execution. Combined with the app's server-side `stripHtml` (see below) the practical XSS risk is low.
- **Remediation:** Track lifting `'unsafe-inline'` from `style-src` (nonce or hash Tailwind's injected style) as hardening; low priority.

---

### LOW / INFORMATIONAL (mostly verified-good controls)

- **L-1. `$queryRawUnsafe` in `lib/customer-count.ts` line 61** — [Confirmed NOT injectable]. The SQL is a hardcoded literal (`SELECT reltuples … WHERE oid = '"Customer"'::regclass`) with **no interpolated user input**. All other raw queries (`lib/rate-limit.ts` line 82, health/keep-warm `SELECT 1`) are parameterized `$queryRaw` tagged templates. No SQL injection surface found.
- **L-2. XSS storage defense present** — [Confirmed]. `services/imports.ts` `stripHtml` (lines 43-47) strips tags on import; `isFormulaPayload` (lines 54-57) blocks CSV/formula-injection into Excel exports; edit form uses `lib/validation/edit.ts`. No `dangerouslySetInnerHTML`/`innerHTML`/`eval` anywhere in `app`/`lib`/`services`/`components` (grep clean). React auto-escaping covers render.
- **L-3. Password hashing** — [Confirmed strong]. bcrypt cost 12 everywhere (`lib/auth.ts` DUMMY hash, `services/users.ts` lines 134/267/451, bulk script). Constant-time login via always-run `bcrypt.compare` against a precomputed DUMMY hash for unknown/inactive users (`lib/auth.ts` lines 39-40, 260, 277, 288-289). Password reuse prevention (last 5 + current) in `services/users.ts` lines 487-512. Min length 12 for app-set passwords (`passwordRule`).
- **L-4. Session management** — [Confirmed strong]. JWT, 8h TTL (`auth.config.ts` line 14); 5-min freshness re-read (`lib/auth.ts` lines 165-217) honoring `isActive`, role change, and `sessionsRevokedAt` hard-revocation marker (bumped on logout/disable/reset/role-change). Cookies `httpOnly`+`sameSite=lax`+`__Secure-` prefix in prod (`auth.config.ts` lines 19-32). `AUTH_SECRET` length+entropy asserted at boot in prod (`lib/auth.ts` lines 17-32).
- **L-5. IDOR defenses** — [Confirmed] for the paths reviewed. Photo stream `app/api/photos/[id]/route.ts` resolves attachment→customer and runs `assertCanAccessAttachment` (scope + soft-delete filter, 404-not-403 to avoid ID oracle). Customer read (`customers/[id]/page.tsx` lines 54-69) and edit (`edit/page.tsx` 89-109) enforce scope + `filterBranchesByScope` for multi-branch leakage — **except MANAGER on edit, see H-1**. Saved-view delete checks ownership (`services/saved-views.ts` line 118). Photo delete checks `capturedById` for salesmen (`services/photos.ts` line 288).
- **L-6. Unsafe upload controls** — [Confirmed present]. Presign (`app/api/photos/presign/route.ts`) restricts MIME allowlist + 3MB cap + per-user rate limit. Finalize (`finalize/route.ts`) binds key to caller's presign prefix (lines 80-85), enforces kind-from-key match (86-92), re-checks size via HeadObject (108-110), and ignores client `capturedAt` (uses R2 LastModified). Photos are streamed through an authenticated route, not served by public guessable key (no `R2_PUBLIC_BASE` in use for reads). Import upload capped at 5MB (`services/imports.ts` line 78).
- **L-7. Unprotected routes audit** — [Confirmed]. Every reviewed route/action gates auth first: ~~`middleware.ts` `authorized` callback denies all non-public paths~~ (**corrected 2026-09-15: that deny path is inert — see register.md C1**; the gating is per-layout, per-page and per-action); public allowlist is minimal (`/login`, `/api/auth`, `/api/health`, `/_next`, favicon — `auth.config.ts` 63-69). Cron routes (`photo-gc`, `keep-warm`) require `CRON_SECRET` via **timing-safe** bearer compare (`node:crypto.timingSafeEqual`, length-checked). `/api/health` returns only `{status:ok}` unless `HEALTH_BEARER` matches. `/api/perf-probe` requires STEWARD/MANAGER. `/api/exports/customers` checks session then delegates to `buildCustomerExport` which re-checks role + applies scope intersection.
- **L-8. Sensitive data in logs** — [Confirmed mitigated]. `lib/logger.ts` redacts structured PII keys (password, passwordHash, phone, email, crNumber, authorization/cookie headers) AND runs a free-text scrubber for Omani phone/email patterns. Errors logged as `.message` strings, not full objects, in most handlers.
- **L-9. Account deactivation** — [Confirmed]. Disable bumps `sessionsRevokedAt` (kills JWT ≤5min), last-active-Manager lockout guard, peer-tier protection (`canMutateUser` — a MANAGER cannot disable/reset/demote another MANAGER or STEWARD).
- **L-10. CSRF** — [Reasonable inference, good]. Server Actions rely on Next.js Origin check + `sameSite=lax` cookies; no custom state-changing GET handlers that mutate found. Cron GETs are bearer-gated.
- **L-11. Vercel cron mismatch (non-security, note)** — `vercel.json` declares only the `photo-gc` cron; `keep-warm/route.ts` header comments describe an every-4-min cron that is not present in `vercel.json`. Functionality/ops note, not a vulnerability.

---

## VERIFICATION OF EXISTING SECURITY DOCS
Reviewed presence of `docs/QA-AUDIT-REPORT.md`, `docs/REMEDIATION-REPORT.md`, and `docs/audit/*` (01-auth-session, 05-rbac-scope, NMWC-CM-FINAL-AUDIT). Their remediation tags (RBAC-05-*, AUTH-*, QA-*, B-*) were **cross-checked against live code and largely hold** (session revocation, manager fail-closed reads/approves, photo IDOR, timing-safe crons, log redaction all verified present). Two doc claims do NOT fully hold in code: (a) the manager scoping enforced on read/approve is **absent on the direct-edit write path** (H-1); (b) `docs/PILOT-MUSCAT-CREDENTIALS.md` documents an accepted "shared weak password" trade-off but the credentials are **committed to the repo**, which the docs do not flag as a git-history exposure (C-1).
