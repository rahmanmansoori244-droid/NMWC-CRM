# OLD System (ICO Customer Portal) — Technical Architecture Assessment, Tech-Debt Register & Bug Catalogue

**System root:** `C:\Users\abdulr\Desktop\ICO\customer-portal`
**Assessed:** discovery-only, read-only static analysis. Paths below are relative to the system root.
**Stack (confirmed from `package.json`):** Next.js 14.2.5 (App Router), React 18.3.1, Prisma 5.16.1, NextAuth 4.24.7 (JWT/credentials), Zod, TailwindCSS, `@vercel/blob`, nodemailer, xlsx/papaparse. Deploy target: Vercel (`vercel.json`, `.vercel/`, `@vercel/blob`).

Legend: **[Confirmed]** read directly in code · **[Highly likely]** · **[Possible]** · **[Unknown]**

---

## PART 1 — ARCHITECTURE QUALITY

### 1.1 Architecture pattern & separation of concerns — GOOD (with caveats)
- **[Confirmed]** Clean layered structure: `app/api/**` route handlers (controllers) → `lib/*` domain/services (`permissions.ts`, `duplicate-check.ts`, `sla.ts`, `notifications.ts`, `storage.ts`, `email.ts`, `audit-log.ts`, `rate-limit.ts`) → Prisma (`lib/db.ts`). Validation centralized in `lib/validators/*` (Zod). Constants/config in `lib/constants.ts`. This is a competent, idiomatic Next.js layout.
- **[Confirmed]** Authorization logic is centralized in `lib/permissions.ts` and consistently invoked server-side in every mutation route (`canSupervisorAct`, `canAccountantAct`, `canActivateRoutePro`, `assertCanView`, `buildRequestScopeFilter`). This is the strongest part of the codebase.
- **Weakness [Confirmed]:** business rules leak across layers — e.g., submit-time field-requirement logic (GPS/photo rules per `updateCategory`) lives inline in `app/api/requests/[id]/submit/route.ts:42-66`, while the approval-path fork lives in `app/api/requests/[id]/approve/route.ts:52-57`. No single state-machine module; transitions are hand-coded per route.

### 1.2 Database access pattern — Prisma, mostly sound
- **[Confirmed]** Singleton Prisma client with dev global-cache guard (`lib/db.ts:5-14`) — correct for serverless.
- **[Confirmed]** Optimistic-concurrency pattern via guarded `updateMany({ where:{ id, status: currentStatus }})` + `count===0 → 409` used in submit/approve/reject/return/confirm-temix/activate-routepro. Good race mitigation.
- **Gaps [Confirmed]:** `PATCH /api/requests/[id]` (`app/api/requests/[id]/route.ts:97`) and both cron `update()` calls (`app/api/cron/sla-check/route.ts:40,93`) and the admin escalate (`.../escalate/route.ts:79`) use **unguarded** `update()` — no optimistic guard. See BUG-05, BUG-11.

### 1.3 Configuration management & environment separation — CRITICAL DEBT
- **[Confirmed] DB provider drift (see BUG-01).** `prisma/schema.prisma:6` and `prisma/migrations/migration_lock.toml` declare `provider = "postgresql"`; migration SQL uses Postgres syntax (`TIMESTAMP(3)`, partial unique index `WHERE "temixCode" IS NOT NULL`); code uses Postgres-only features (`mode:'insensitive'` in `app/api/customers/route.ts:56-58` and `app/api/requests/route.ts:49-51`; raw `INSERT … ON CONFLICT … RETURNING` + `NOW()` in `lib/rate-limit.ts:39-46`; `Json` columns in `AdminAuditLog`). **Yet** all env files set `DATABASE_URL="file:…"` (SQLite) and a stale `prisma/dev.db` (344 KB) exists. Every hand-off doc (`ISSUES_LOG.md`, `PRODUCTION_READINESS.md`, `HANDOVER.md`, `AI_REVIEW_HANDOFF.md`) claims the repo is "standardized on SQLite" — **directly contradicting the actual schema.** Local `prisma generate`/`db push` with `provider=postgresql` + `file:` URL will fail.
- **[Confirmed] Committed secrets (see BUG-02).** `.gitignore` ignores only `.env.local` / `.env*.local`; **`.env` is git-tracked** (`git ls-files` shows `.env`) and contains `NEXTAUTH_SECRET`, `CRON_SECRET`, SMTP creds, `DATABASE_URL`. Committed in `3761c02`.
- **[Confirmed]** SLA working-calendar is env-driven (`lib/sla.ts:4-10`, `WORK_DAYS`/`WORK_HOUR_START/END`) — good.

### 1.4 Error handling & logging — WEAK / MINIMAL
- **[Confirmed]** API errors funneled through `apiError()`/`apiSuccess()` (`lib/utils.ts:113-118`) — consistent JSON envelope `{success,error}`. Health endpoint deliberately opaque (`app/api/health/route.ts`).
- **[Confirmed]** No structured logging / APM / request IDs. Failures logged via bare `console.error` (`lib/rate-limit.ts:52`, notification `catch` blocks). Prisma log level errors-only in prod (`lib/db.ts:11`). `ISSUES_LOG.md` itself flags "Operational observability is still minimal — Open."
- **[Confirmed]** Rate limiter **fails open** on any DB error (`lib/rate-limit.ts:49-53`) — brute-force protection silently disappears if the table/DB is unavailable.

### 1.5 Dependency management — ACCEPTABLE
- **[Confirmed]** Deps pinned exactly (no `^` on most). Next 14.2.5 / NextAuth 4.24.7 are near-EOL-ish but not abandoned. `xlsx@0.18.5` **[Highly likely]** — the npm `xlsx` distribution at this version has known prototype-pollution/ReDoS advisories (CVE-2023-30533 / GHSA for `sheetjs`); used in `app/api/master/upload/route.ts:13`. `@aws-sdk/client-s3` is dynamically imported but **not in `package.json`** (`lib/storage.ts:104`) → S3 path throws at runtime if `STORAGE_TYPE=s3` (dead/broken branch unless dep added).

### 1.6 State management (frontend) — [Unknown/Not deeply audited]
- Client pages under `app/(dashboard)/**` use react-hook-form; not deeply reviewed in this dimension. `app/(dashboard)/DashboardClient.tsx` + `components/*` present. No global store (Redux/Zustand) — server-component + fetch pattern **[Highly likely]**.

### 1.7 Modularity, reusability, naming — GOOD
- **[Confirmed]** Consistent naming, DRY helpers, single source for channels/statuses/SLA/update-categories in `lib/constants.ts`. `SUPERVISOR_ONLY_CATEGORIES` derived from config (`constants.ts` end) rather than hardcoded — good (this was `ISSUE-009`).
- **Dead code [Confirmed]:** `canCancel()` (`lib/permissions.ts:~170`) is unused (no cancel/DELETE endpoint for requests exists — only `app/api/admin/users/[id]/route.ts` has DELETE). `LEGACY_STATUSES` and `CREATED_IN_TEMIX` retained in `ACCOUNTANT_VISIBLE_STATUSES` though marked legacy. `tsconfig.tsbuildinfo` (143 KB build artifact) is git-tracked.

### 1.8 Performance hotspots & scalability limits
- **[Confirmed] Master upload N+1** — `app/api/master/upload/route.ts:206-212`: for **every** ROUTE_SALESMAN row, re-queries **all** active supervisor/accountant/salesman users (full-table scan per row). O(rows × users).
- **[Confirmed] Mega-transaction** — CUSTOMER_MASTER path (`:109-157`) does `updateMany deactivate-all` then a **per-row `upsert` inside one `$transaction`**; a 20 MB / multi-thousand-row file becomes one long serial transaction → Vercel function timeout (10–60 s) + long lock hold. No batching/`createMany`.
- **[Confirmed] Duplicate-check scan risk** — `lib/duplicate-check.ts:92-101`: `normalizedName contains namePrefix` compiles to unanchored `LIKE '%abcd%'`, which **cannot** use the `@@index([normalizedName])` btree; plus in-app Levenshtein over up to 50 master + 100 pending rows per submit (`:103-118, 205-251`). Fine at pilot scale, O(N·M) as master grows.
- **[Confirmed]** `GET /api/requests` orders by `updatedAt desc` but there is **no index on `updatedAt`** (`schema.prisma` CustomerRequest indexes cover status/salesman/etc. but not updatedAt) → sort cost grows with table.

### 1.9 Testability / deployment readiness / backup
- **[Confirmed]** Test harnesses exist (`test/`, `test-*.js`, npm `validate`) but are integration/smoke scripts run against a live server, not unit tests; coverage unverifiable statically.
- **[Confirmed]** Deployment self-contradicts: `PRODUCTION_READINESS.md` verdict "ALMOST READY / single-instance SQLite," while real target is Vercel serverless + Postgres + Vercel Blob. Docs are unreliable for ops. No backup/restore automation beyond "back up the SQLite file" guidance that doesn't match Postgres reality.

---

## PART 2 — BUG CATALOGUE

### CONFIRMED BUGS

**BUG-01 — DB engine drift: schema=PostgreSQL vs env=SQLite (CRITICAL).**
Evidence: `prisma/schema.prisma:5-7` (`provider="postgresql"`), `prisma/migrations/migration_lock.toml` (`postgresql`), `lib/rate-limit.ts:39-46` (Postgres raw upsert), `app/api/customers/route.ts:56-58` & `app/api/requests/route.ts:49-51` (`mode:'insensitive'`), vs `.env`/`.env.local`/`.env.example` `DATABASE_URL="file:…"` + `prisma/dev.db`.
Repro: fresh clone → `npm run db:generate && db:push` with shipped `.env` → Prisma rejects `file:` URL for a postgres datasource. On SQLite (if URL honored) `mode:'insensitive'` is ignored and `lib/rate-limit.ts` ON CONFLICT/NOW() SQL breaks.
Impact: local dev broken out-of-box; every "SQLite" doc misleads operators; search becomes case-sensitive on SQLite; rate-limit fails-open on SQLite. Root cause: repo migrated SQLite→Postgres but env files and all docs never updated. Fix: delete/ignore `dev.db`, set `DATABASE_URL` to a Postgres URL in all envs, rewrite the four hand-off docs, add `.env*` to `.gitignore`.

**BUG-02 — Secrets committed to git (CRITICAL / security).**
Evidence: `git ls-files` returns `.env`; `.gitignore` omits bare `.env`. `.env` contains `NEXTAUTH_SECRET=hj…`, `CRON_SECRET=b0…`, SMTP + DB settings (values redacted). Introduced in commit `3761c02`.
Impact: JWT-forgery (NEXTAUTH_SECRET) → full auth bypass; CRON_SECRET → anyone can trigger cron endpoints; history exposure persists after deletion. Fix: `git rm --cached .env`, rotate **all** secrets, add `.env` to `.gitignore`, scrub history.

**BUG-03 — Vercel cron jobs never fire: routes are POST-only, Vercel Cron sends GET (HIGH).**
Evidence: `vercel.json` crons → `/api/cron/sla-check` (`0 8 * * *`) and `/api/cron/daily-summary` (`0 6 * * *`); both routes export **only** `POST` (`app/api/cron/sla-check/route.ts:8`, `app/api/cron/daily-summary/route.ts:7`). Vercel Cron invokes endpoints via HTTP **GET** → 405, handler never runs.
Impact: **SLA breach auto-escalation and the daily admin summary never execute in production.** `supervisorSlaBreached`/`accountantSlaBreached`/`ESCALATED` are never set automatically; management email never sent. Root cause: method mismatch. Fix: add `GET` handlers (or rename) and validate the `Authorization: Bearer $CRON_SECRET` header Vercel sends.

**BUG-04 — In-app notification emails are dead code; no emails are ever sent (HIGH).**
Evidence: `lib/email.ts:26` `sendNotificationEmail()` is defined but **not called anywhere** (`grep` across `app/ lib/ components/` returns only its definition). `lib/notifications.ts` only writes DB rows (`createNotification`), never emails. The only email sender wired in is `sendDailySummaryEmail`, called solely by the daily-summary cron — which is itself broken (BUG-03).
Impact: supervisors/accountants/salesmen receive **no** email on submit/approve/reject/return/Temix/activation despite SMTP being configured; approvals stall waiting on in-portal polling only. Fix: call `sendNotificationEmail` from `createNotification` (best-effort) with recipient lookup.

**BUG-05 — SLA escalation is asymmetric and race-unsafe (MEDIUM).**
Evidence: `app/api/cron/sla-check/route.ts:40-43` supervisor breach does unguarded `update({data:{ supervisorSlaBreached:true, status:'ESCALATED'}})`; accountant breach `:93-95` sets only `accountantSlaBreached:true` and **never** changes status. So supervisor SLA yanks the request out of the supervisor queue into `ESCALATED` (and `canSupervisorAct` then returns false — supervisor can no longer act; recovery only via admin `escalate`), while accountant SLA leaves it in `PENDING_ACCOUNTANT`. Inconsistent business behavior. Unguarded `update` can also race an in-flight approve. Fix: make both symmetric, use status-guarded `updateMany`, notify salesman.

**BUG-06 — Master ROUTE_SALESMAN import: N+1 full user scan per row (HIGH, perf).**
Evidence: `app/api/master/upload/route.ts:206`. See §1.8. Impact: import latency/timeout on realistic route files; risk of partial-commit if the transaction times out mid-loop.

**BUG-07 — Hardcoded default admin password in production seed (MEDIUM, security).**
Evidence: `prisma/seed-production.ts:42` `bcrypt.hash('Admin1234!', 12)`. If `seed-production` is run against prod, a well-known admin credential exists. Fix: require an env-supplied password / force reset on first login.

### SUSPECTED BUGS

**BUG-08 — Submit notification failure returns 500 after state already committed (LOW/MEDIUM) [Highly likely].**
Evidence: `app/api/requests/[id]/submit/route.ts:167-175` awaits `notifyRequestSubmitted` **outside** any try/catch, after the status transaction has committed. If the notification insert throws, the client gets a 500 though the request is already `PENDING_SUPERVISOR` → salesman may resubmit / perceive failure. (approve/reject/return correctly wrap notifications in try/catch; submit does not.) Fix: wrap in try/catch like the others.

**BUG-09 — `xlsx@0.18.5` known-vuln dependency (MEDIUM) [Highly likely].**
Evidence: `package.json` pins `xlsx: 0.18.5`, parsed on admin upload (`app/api/master/upload/route.ts:288`). Version predates SheetJS prototype-pollution/ReDoS fixes. Attack surface limited to ADMIN uploads, but still. Verify against current advisory DB; upgrade to patched SheetJS.

**BUG-10 — S3 storage branch is unbuildable (LOW) [Confirmed code / Possible runtime].**
Evidence: `lib/storage.ts:104` dynamically imports `@aws-sdk/client-s3`, which is absent from `package.json`. Any deployment with `STORAGE_TYPE=s3` throws at first upload. Currently masked because Vercel Blob branch (`BLOB_READ_WRITE_TOKEN`) takes precedence. Fix: add dep or remove branch.

**BUG-11 — `PATCH /api/requests/[id]` edit has no optimistic concurrency guard (LOW).**
Evidence: `app/api/requests/[id]/route.ts:97` unguarded `update()`; also resets `duplicateRisk:'NONE'` and can change `type` freely without re-resolving supervisor/accountant/depot routing that was fixed at create time. Low impact (edit is salesman-owned, single actor) but inconsistent with the guarded pattern elsewhere and can desync routing on type change.

**BUG-12 — CSP still permits `'unsafe-inline'` for scripts in production (LOW/MEDIUM, security) [Confirmed].**
Evidence: `next.config.js` CSP keeps `script-src 'self' 'unsafe-inline'` in production (only `'unsafe-eval'` dropped). Residual stored/reflected-XSS risk given user-controlled fields rendered into email HTML templates (`lib/email.ts:101-103` interpolates `title`/`message`/customer name without escaping — though email, not the app DOM). Verify request-field sanitization in `lib/validators/request.ts` (not fully read here).

**BUG-13 — Duplicate-check `pendingStatuses` includes legacy `CREATED_IN_TEMIX`/`APPROVED_BY_SUPERVISOR` but omits `ESCALATED` (LOW) [Confirmed].**
Evidence: `lib/duplicate-check.ts:152-162`. A request auto-escalated by SLA (BUG-03/05) drops out of duplicate scanning, so a genuine duplicate of an escalated request would not be flagged. Minor given BUG-03 means escalation rarely happens.

---

## CONFIRMED FACTS vs INFERENCES vs UNVERIFIED vs MISSING

- **Confirmed facts:** all file:line evidence tagged [Confirmed] (schema/env drift, tracked `.env`, POST-only crons, unused `sendNotificationEmail`, N+1 upload loop, asymmetric SLA, hardcoded seed password, unguarded PATCH, dead `canCancel`).
- **Reasonable inferences:** Vercel Cron uses GET (documented Vercel behavior) → BUG-03 breakage; `xlsx@0.18.5` advisory applicability (BUG-09); local-dev-broken claim in BUG-01.
- **Unverified assumptions:** exact frontend state-management approach (client pages not deep-read); whether `seed-production` is actually run in prod; runtime confirmation that prod `DATABASE_URL` is overridden to Postgres in Vercel dashboard (env there not visible).
- **Missing information:** Vercel project env vars (real `DATABASE_URL`/secrets at runtime); `lib/validators/request.ts` full sanitization rules (referenced, not fully quoted); actual git history depth for secret exposure; test coverage numbers.

## Tech-debt severity roll-up
- **Critical:** BUG-01 (DB/config+docs drift), BUG-02 (committed secrets).
- **High:** BUG-03 (crons dead), BUG-04 (no emails), BUG-06 (upload N+1/timeout). Remediation each ~0.5–2 days.
- **Medium:** BUG-05, BUG-07, BUG-09, observability gap, duplicate-check scan cost, `updatedAt` index. ~0.5–1 day each.
- **Low:** BUG-08/10/11/12/13, dead code, committed `tsconfig.tsbuildinfo`. Hours each.
