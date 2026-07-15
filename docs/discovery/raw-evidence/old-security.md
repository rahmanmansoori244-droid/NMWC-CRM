# Section J — Defensive Security & Access-Control Review
## OLD system: ICO Customer Portal
Root: `C:\Users\abdulr\Desktop\ICO\customer-portal`
Stack: Next.js 14.2.5 (App Router) · NextAuth 4.24.7 (Credentials + JWT) · Prisma 5.16.1 (schema provider = postgresql) · bcryptjs 12 rounds · Vercel Blob / local disk storage.

Overall posture: **Substantially better than a typical greenfield app.** The codebase carries an extensive, verified history of security fixes (annotated `ISSUE-xxx`, `V1..V12`, `L1..L5`). I VERIFIED these against current code rather than trusting the annotations — most are genuinely implemented. The residual risk is concentrated in **secret management (committed `.env`)** and **JWT session staleness (deactivation/role-change not enforced until token expiry).**

---

## CONFIRMED FACTS (verified in code)

### Access control — GOOD (verified)
- Central role model in `lib/permissions.ts`; every state-changing API route re-checks server-side. Spot-verified: `requests/[id]/approve` (`canSupervisorAct`, permissions.ts:90), `requests/[id]/route.ts` GET/PATCH (`assertCanView`/`canEditDraft`), `admin/users`, `admin/users/[id]`, `admin/users/bulk`, `admin/audit-log`, `admin/requests/[id]/escalate` all gate on `isAdmin` (403). `master/upload` gates on `canUploadMaster`. All `app/api/admin/*` route.ts files contain a role check (grep-confirmed none missing).
- IDOR defenses present and verified:
  - `notifications/[id]/read/route.ts:19` — `notification.userId !== user.id` → 403.
  - `files/[key]/route.ts:22-42` — resolves owning `RequestPhoto`→`CustomerRequest`, calls `canViewRequest`; plus path-traversal guard (line 17-18 char-whitelist + line 49 `startsWith(uploadsDir)`).
  - `blob/proxy/route.ts:31-50` — ownership-gated + SSRF allow-list (only `*.vercel-storage.com`).
  - `customers/[temixCode]/route.ts:23-28` + `master/customers` + `customers/route.ts` — non-admins scoped to their route codes via `resolveCustomerScopeRouteCodes` (permissions.ts:201).
- Query-filter tampering closed: `requests/route.ts:33-55` merges user filters via `AND` so client cannot widen the ACCOUNTANT scope OR-clause; `depotId/supervisorId/salesmanId` filters gated by role.
- Optimistic-concurrency on approve (`updateMany where status=current`, returns 409 on race) — prevents first-click-wins races.

### Injection / XSS — GOOD (verified)
- No raw string SQL. All three `$queryRaw` uses (`rate-limit.ts:32`, `cron/daily-summary:74`, `health:10`) are Prisma tagged templates → parameterized. No `queryRawUnsafe`/`executeRawUnsafe`.
- No `dangerouslySetInnerHTML`, `eval`, or `new Function` anywhere in `app/components/lib`.
- CSV export escapes formula-injection (`admin/audit-log/route.ts:62-69`, prefixes `'` on `=+-@`).
- Security headers set globally (`next.config.js:20-53`): X-Frame-Options DENY, nosniff, Referrer-Policy, CSP with `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.

### File upload — GOOD (verified)
- Photos (`requests/[id]/photos/route.ts`): magic-byte MIME detection (line 23-60) overrides client `file.type`, 10 MB cap, zero-byte reject, status gating, per-request ownership. Master upload: 20 MB cap, column/row validation, admin-only.

### Password handling — GOOD (verified)
- bcrypt cost 12 everywhere (`admin/users:109`, `[id]:56`, `bulk:195`, `auth.ts:80`). Strong-password regex enforced on create/update/bulk. Login returns uniform "Invalid credentials." for no-user / bad-password / inactive → no direct enumeration message.

---

## FINDINGS (prioritized)

### CRITICAL

**J-C1 — Real secrets committed to git in `.env` [Confirmed]**
`.env` is tracked (git ls-files shows `.env`; `git log` → committed in `3761c02`; present in HEAD tree). `.gitignore` ignores `.env.local` and `.env*.local` but **NOT `.env`**. It contains live-looking secrets (masked):
- `NEXTAUTH_SECRET="hjT…"` (len 44, real 32-byte base64 — distinct from `.env.example` placeholder `"replace-me…"`)
- `CRON_SECRET="b04…"` (len 64, real)
- `DATABASE_URL`, `ADMIN_EMAIL`, `SMTP_HOST/PORT`.
- Impact: **NEXTAUTH_SECRET disclosure = full auth bypass** — an attacker who reads the repo can forge a valid NextAuth JWT for any user (including `role:"ADMIN"`), since sessions are stateless JWTs signed with this secret. CRON_SECRET disclosure = trigger `/api/cron/*` (escalations, mass emails).
- Remediation: `git rm --cached .env`; add `.env` to `.gitignore`; **rotate NEXTAUTH_SECRET and CRON_SECRET immediately** (rotating NEXTAUTH_SECRET invalidates all sessions — desired); purge from git history (git-filter-repo / BFG); move all secrets to Vercel env vars. Treat any value ever committed as burned.

### HIGH

**J-H1 — Account deactivation & role changes not enforced until JWT expiry (up to 8h) [Confirmed]**
`isActive` is checked ONLY at login (`lib/auth.ts:76`). The `jwt`/`session` callbacks (auth.ts:105-120) copy role/depot from the token and **never re-load the user from DB**; `middleware.ts` only `getToken()` (decode, no DB check). Session `maxAge = 8h` (auth.ts:102).
- Impact: A fired/disabled user, or a user demoted from ADMIN, retains full prior access for up to 8 hours after the change. The "last-admin guard" and soft-delete (`admin/users/[id]` DELETE sets isActive=false) do not revoke live sessions. Also a user whose role is downgraded keeps elevated privileges until token expiry.
- Remediation: In `session`/`jwt` callback (or middleware) re-fetch `user.isActive`+`role` from DB (or maintain a token-version/`sessionInvalidatedAt` column and reject stale tokens). At minimum lower `maxAge` and force re-validation on privileged routes.

**J-H2 — Rate-limiter fails open + DB-dialect mismatch can silently disable it [Confirmed code / Highly likely impact]**
`lib/rate-limit.ts:51-56` catches any DB error and returns `{allowed:true}` ("fail open"). The SQL (`INSERT … ON CONFLICT … RETURNING`, `NOW()`) is **Postgres-specific**. Committed `.env`/`.env.local` set `DATABASE_URL="file:./…"` (SQLite) while `schema.prisma` provider is `postgresql`, and queries use Postgres-only `mode:'insensitive'`.
- Impact: If the app ever runs against SQLite (as the committed env implies for dev), or the `RateLimitAttempt` table is unmigrated, **login brute-force / credential-stuffing protection is silently off** — the only defense against password guessing disappears with no error surfaced to operators.
- Remediation: Confirm prod truly runs Postgres with the table migrated; add a startup health assertion; consider fail-closed (or a short in-memory fallback bucket) for the auth path specifically; fix the committed env dialect mismatch.

### MEDIUM

**J-M1 — Middleware does not enforce role on `/api/admin/*`; only per-route checks protect them [Confirmed]**
`middleware.ts:20` restricts `role !== 'ADMIN'` only for the `/admin` **page** path; API admin routes pass middleware with any authenticated token and rely entirely on each route's own `isAdmin` call. Today all routes have it, but this is a fragile defense-in-depth gap — any future `/api/admin/*` route that forgets the check is fully exposed to any logged-in salesman.
- Remediation: Add `pathname.startsWith('/api/admin') && token.role!=='ADMIN' → 403` in middleware as a backstop.

**J-M2 — Vulnerable dependency `xlsx@0.18.5` [Confirmed version]**
Used in `master/upload` and `admin/users/bulk` (`XLSX.read` on uploaded files). 0.18.5 is affected by CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS); SheetJS has no fixed npm-registry release for these.
- Impact: Admin-only upload surface (limited blast radius) but a malicious/compromised admin file could trigger prototype pollution / DoS.
- Remediation: Upgrade to SheetJS ≥0.20.2 from the vendor CDN, or replace with `exceljs`; run `npm audit` in CI.

**J-M3 — CSP allows `script-src 'unsafe-inline'` in production [Confirmed]**
`next.config.js:38-40` keeps `'unsafe-inline'` for scripts in prod (drops only `'unsafe-eval'`). This materially weakens XSS mitigation should any injection sink be introduced (none found today).
- Remediation: Move to nonce/hash-based CSP for Next inline hydration chunks.

**J-M4 — Timing-unsafe secret comparisons [Confirmed]**
`cron/sla-check:10` and `cron/daily-summary:9` use `secret !== process.env.CRON_SECRET` (non-constant-time). Login also performs `bcrypt.compare` only when the user exists (`auth.ts:72-83`) — no dummy hash on the not-found branch → a bcrypt-timing user-enumeration oracle.
- Remediation: `crypto.timingSafeEqual` for CRON_SECRET; run a dummy bcrypt compare when user not found.

### LOW / INFORMATIONAL
- **J-L1 CSRF [Confirmed by absence]:** No explicit CSRF tokens on custom POST/PATCH routes. Practical risk is LOW because NextAuth's session cookie defaults to `SameSite=Lax` (blocks cross-site credentialed POST/fetch). Verify cookie flags in prod (Secure + Lax/Strict); add CSRF/origin check if any state-change moves to a form GET.
- **J-L2 Sensitive data in logs:** No password/secret logging found (grep clean). `console.error('[rate-limit] DB error…', err)` and notification `console.error` may log stack/DB detail to server logs — low.
- **J-L3 Auditability:** `StatusHistory` + `recordAdminAudit` cover status changes and admin mutations well. Gaps: no audit of read/exports, and login success/failure is not persisted (only rate-limited).
- **J-L4 Encryption at rest:** Not determinable statically (depends on prod Postgres/Blob config) — see MISSING INFO.
- **J-L5 Local uploads served from app** (`/api/files/[key]`) are auth+ownership gated (good); Vercel Blob is `access:'public'` (unguessable UUID) mitigated by the auth proxy — acceptable but blob URLs remain valid if ever leaked.

---

## REASONABLE INFERENCES
- The committed `file:` SQLite `DATABASE_URL` + Postgres-only SQL strongly imply prod uses a separate Postgres URL injected via Vercel env; the committed secrets are likely dev-tier — but must still be rotated/untracked (J-C1) since git history is the disclosure.
- Vercel Cron delivers `Authorization: Bearer <CRON_SECRET>`; the route's `authorization.replace('Bearer ','')` path (cron routes) matches this — cron auth is functional.

## UNVERIFIED ASSUMPTIONS
- That production sessions cookies carry `Secure`/`HttpOnly`/`SameSite` (NextAuth defaults suggest yes; not overridden in code — confirm at runtime).
- That the `RateLimitAttempt` table is migrated in prod (migrations dir exists; not inspected row-by-row here).

## MISSING INFORMATION (how to verify)
- Prod `DATABASE_URL` dialect and DB-at-rest encryption → check Vercel project env + DB provider settings.
- Whether NEXTAUTH_SECRET/CRON_SECRET committed values equal current prod values → compare Vercel env to git blob (do NOT print values); if equal, escalate J-C1 rotation as urgent.
- Backup protection/retention for the customer master DB → infra/hosting config, not in repo.
- git history depth of `.env` exposure → `git log --all -- .env` and history rewrite scope.
