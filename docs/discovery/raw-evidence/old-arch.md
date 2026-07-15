# Section B — Repository & Architecture Map: OLD = ICO Customer Portal

**System root:** `C:\Users\abdulr\Desktop\ICO\customer-portal`
**Assessment mode:** Read-only discovery. No project file modified.
**Analyzed:** 2026-07-15

---

## B.0 Confidence legend
[Confirmed] read directly in code · [Highly likely] · [Possible] · [Unknown]

---

## B.1 Project purpose [Confirmed]
A Next.js customer-registration / master-data workflow portal for **National Mineral Water Company (NMWC)**, internally branded "ICO Customer Portal". It captures new-customer (and update) requests from salesmen and routes them through a tiered approval workflow to Temix (ERP) creation and RoutePro activation.

- Verified from code, not just README: request lifecycle is enforced by API routes under `app/api/requests/[id]/*` — `submit`, `approve`, `reject`, `return`, `confirm-temix`, `activate-routepro` (route.ts files each present).
- Workflow (README lines 20-25, corroborated by routes + status enum `types/index.ts:9`): Salesman drafts → duplicate check on submit → Supervisor approve/return/reject → Accountant confirms Temix code → Admin activates in RoutePro → CLOSED.
- Request types (`types/index.ts:3`, README 30-34): `NEW_MAIN`, `NEW_BRANCH`, `NO_CR`, `UPDATE_EXISTING`.
- Package identity: `package.json:2` name `ico-customer-portal`, `:4` description "ICO Customer Registration Workflow Portal". README title says "NMWC Customer Registration Portal" — dual ICO/NMWC branding.

## B.2 Technology stack WITH versions [Confirmed] (from `package.json`)
| Layer | Tech | Version |
|---|---|---|
| Framework | Next.js (App Router) | `14.2.5` |
| Runtime | Node | 20 (Dockerfile `node:20-bookworm-slim`; CI `node-version: 20`) |
| Language | TypeScript | `5.5.3` (strict: true, `tsconfig.json:7`) |
| UI | React / React-DOM | `18.3.1` |
| Styling | Tailwind CSS `3.4.6` + tailwind-merge `2.4.0` + clsx `2.1.1`; PostCSS `8.4.40`, autoprefixer `10.4.19` | |
| Icons | lucide-react `0.414.0` | |
| Charts | recharts `2.12.7` | |
| ORM | Prisma (`prisma` + `@prisma/client`) | `5.16.1` |
| DB (declared) | PostgreSQL (`schema.prisma:6-7` provider = "postgresql") | |
| Auth | next-auth `4.24.7` (Credentials provider, JWT session) | |
| Password hash | bcryptjs `2.4.3` | |
| Email | nodemailer `6.9.14` | |
| Blob storage | @vercel/blob `^2.3.3` | |
| Validation | zod `3.23.8` + @hookform/resolvers `3.9.0` | |
| Forms | react-hook-form `7.52.1` | |
| Parsing/export | papaparse `5.4.1`, xlsx `0.18.5` (SheetJS) | |
| IDs / dates | uuid `10.0.0`, date-fns `3.6.0` | |
| **Logging** | none — plain `console.warn/error` (e.g. `lib/email.ts:35`, `lib/rate-limit.ts:54`). No pino/winston. [Confirmed] |
| **Error tracking** | **none** — no Sentry/@sentry dependency present. [Confirmed] |

## B.3 Main entry points [Confirmed]
- **Middleware:** `middleware.ts` — NextAuth `getToken` JWT gate; 401 JSON for `/api/*`, redirect to `/login` for pages; admin-route guard `pathname.startsWith('/admin') && token.role !== 'ADMIN'` (`middleware.ts:20`). Matcher list `middleware.ts:28-42` (dashboard, requests, customers, admin, notifications + matching API namespaces).
- **Route groups (App Router):** `app/(auth)/login`, `app/(dashboard)/*` (dashboard, admin/*, customers/[temixCode], notifications, requests/[id]|new|update).
- **NextAuth handler:** `app/api/auth/[...nextauth]/route.ts` wiring `lib/auth.ts` `authOptions`.
- **No custom server** (uses `next start`); **no instrumentation.ts** found. [Confirmed]
- **Prisma client singleton:** `lib/db.ts:8-16` global-cached `PrismaClient` (dev-mode global reuse to avoid connection exhaustion on hot reload).
- **Session provider:** `components/providers/SessionProvider.tsx`; shell `components/layout/DashboardShell.tsx` + `Header.tsx` + `Sidebar.tsx`.

## B.4 Full folder map [Confirmed]
SOURCE:
- `app/` — App Router pages + `app/api/*` (34 `route.ts` API endpoints; full list below).
- `lib/` — server logic: `auth.ts, db.ts, permissions.ts, rate-limit.ts, sla.ts, duplicate-check.ts, email.ts, notifications.ts, audit-log.ts, storage.ts, constants.ts, utils.ts, validators/`.
- `components/` — dashboard, forms (GPSCapture, PhotoUpload), layout, providers, requests (DuplicateAlert, RequestTimeline, StatusBadge).
- `prisma/` — `schema.prisma`, `migrations/` (3 migrations + `migration_lock.toml`), `seed.ts`, `seed-production.ts`, **`dev.db` (SQLite file, 344 KB, committed-adjacent — see B.5 anomaly)**.
- `scripts/` — 6 ops `.mjs` audit/purge scripts (audit-data-integrity, audit-linkage, audit-security, audit-workflow-integrity, purge-ghost-drafts, purge-test-data).
- `test/` — `e2e-workflow.ts, regression.ts, stress-test.ts, smoke-test.js, http-client.js`; plus root `test-security.js`, `test-permissions.js`.
- `types/index.ts`, `docs/` (pitch decks + PROJECT_STATE.md), `public/`, `uploads/`.

GENERATED / NON-SOURCE (do not treat as code): `.next/` (build), `node_modules/`, `.vercel/`, `tsconfig.tsbuildinfo` (143 KB incremental), `next-env.d.ts`, `smoke-server.out.log/.err.log`, `tmp_test/`, `package-lock.json`.

## B.5 Database technology + access [Confirmed + FLAGGED INCONSISTENCY]
- Access: **Prisma client singleton** only (`lib/db.ts`). No ORM bypass except one raw query.
- **Raw SQL (provider-specific):** `lib/rate-limit.ts:32-38` — `prisma.$queryRaw` `INSERT ... ON CONFLICT ("key","windowStart") DO UPDATE ... RETURNING` + `NOW()`. This is **PostgreSQL-specific syntax** (fails on SQLite). Fails-open on error (`:52-55`).
- **CRITICAL PROVIDER MISMATCH:**
  - `schema.prisma:6` `provider = "postgresql"`; `prisma/migrations/migration_lock.toml` `provider = "postgresql"`; migration SQL uses Postgres-only DDL (`ALTER TYPE ... ADD VALUE`, `TIMESTAMP(3)`, `ADD CONSTRAINT ... FOREIGN KEY`).
  - BUT `.env:1`, `.env.example`, `docker-compose.yml:9`, README all set `DATABASE_URL="file:./dev.db"` (SQLite) and a real `prisma/dev.db` exists. README ("Database: Prisma + SQLite") and CI (`.env.example` → `db:push`/`db:seed`) assume SQLite.
  - Effect: the declared Postgres schema is **incompatible with the configured SQLite URL** — Prisma refuses `file:` URLs under a postgresql datasource. Evidence of a mid-project SQLite→Postgres migration that left env/docs/dev.db stale. **VERIFY** which DB actually runs in the target deployment before any consolidation. Confidence [Confirmed] on the contradiction; [Possible] on which side is "live" (Postgres, given migrations + Vercel crons + raw ON CONFLICT).

## B.6 Hosting / deployment [Confirmed]
- **Vercel** primary: `vercel.json` — `framework: nextjs`, buildCommand `npx prisma generate && npm run build`; **crons** `/api/cron/sla-check` `0 8 * * *` and `/api/cron/daily-summary` `0 6 * * *`. `.vercel/` dir present (linked project).
- **Docker** alternative: `Dockerfile` multi-stage (deps/builder/runner) `node:20-bookworm-slim`, `CMD npx prisma db push && npm run start`, HEALTHCHECK → `/api/health`. `docker-compose.yml` mounts `sqlite-data:/app/data` + `uploads-data` (again assumes SQLite).
- **CI:** `.github/workflows/ci.yml` — on push (main/master/`codex/**`) + PR: `npm ci`, cp `.env.example`→`.env`, `db:generate/push/seed`, `db:validate`, `lint`, `npm test`, `build`. No deploy step (Vercel auto-deploys) and **no CD**.
- `next.config.js`: security headers (X-Frame-Options DENY, nosniff, Referrer-Policy, hardened CSP dropping `unsafe-eval` in prod `:38-40`), image remotePatterns for `*.amazonaws.com` + `*.r2.cloudflarestorage.com`.

## B.7 Auth mechanism [Confirmed]
- **NextAuth 4.24.7**, Credentials provider, **JWT session** strategy, `maxAge` 8h (`lib/auth.ts:100-103`).
- Password: `bcrypt.compare` against `User.passwordHash` (`lib/auth.ts:80`); inactive users rejected (`:76`).
- Rate-limiting on login: DB-backed dual bucket — (ip,email) 5/15min + ip-only 30/15min (`lib/auth.ts:59-69`).
- JWT/session callbacks inject `id, role, depotId, supervisorId` (`lib/auth.ts:104-121`). Secret from `NEXTAUTH_SECRET` (`:126`).
- Authorization: server-side role/ownership checks in `lib/permissions.ts` (`canViewRequest`, `ACCOUNTANT_VISIBLE_STATUSES`, role guards). Roles (`types/index.ts:1`): `SALESMAN | SUPERVISOR | ACCOUNTANT | ADMIN | ROUTEPRO`.

## B.8 Environment variables (names only; values MASKED) [Confirmed via grep process.env]
Core: `NODE_ENV`, `DATABASE_URL` (DB conn), `NEXTAUTH_SECRET` (JWT signing), `APP_NAME`, `APP_URL`. Also referenced in configs: `NEXTAUTH_URL`, `NEXTAUTH_URL_INTERNAL`.
Storage: `STORAGE_TYPE` (local|s3), `LOCAL_UPLOAD_PATH`, `BLOB_READ_WRITE_TOKEN` (Vercel Blob), `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_PUBLIC_BASE_URL`.
Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `ADMIN_EMAIL`.
Cron: `CRON_SECRET` (guards both cron routes `app/api/cron/*/route.ts:9-10`).
SLA calendar: `WORK_HOUR_START`, `WORK_HOUR_END`, `WORK_DAYS`.

## B.9 SECURITY — committed secrets [Confirmed — HIGH severity]
- **`.env` is tracked in git** (`git ls-files` shows `.env`). `.gitignore` only ignores `.env.local`/`.env*.local`, **not `.env`**. The file contains **live secrets committed to history**:
  - `NEXTAUTH_SECRET="hjT…"` (redacted; JWT signing key — full value in `.env:2`). Remediation: rotate immediately, remove `.env` from tracking (`git rm --cached .env`), add `.env` to `.gitignore`, purge from history.
  - `CRON_SECRET="b04…"` (redacted; cron auth bearer — `.env:7`). Same remediation; rotate.
  - `DATABASE_URL`, `SMTP_*` present but currently non-sensitive (SQLite file path; empty SMTP creds).
- Verify whether these were ever pushed to a remote before relying on rotation alone.

## B.10 External services / integrations [Confirmed]
- **Vercel Blob** (`@vercel/blob`, `lib/storage.ts:42-64`) — primary file storage when `BLOB_READ_WRITE_TOKEN` set; note free-tier blobs are `access:'public'`, mitigated by UUID keys + auth-gated proxy `app/api/blob/proxy/route.ts` (ownership-checked via `canViewRequest`).
- **S3 / R2-compatible** storage (optional, `STORAGE_TYPE=s3`, `lib/storage.ts:98-127`, dynamic import of `@aws-sdk/client-s3` which is NOT in package.json → runtime import; only works if installed). Fallback = local disk `/api/files/[key]`.
- **SMTP email** via nodemailer (`lib/email.ts`), no-ops when unconfigured (`:34-37`).
- **Temix (ERP)** and **RoutePro** — represented as **workflow stages/fields only** (`confirm-temix`, `activate-routepro` routes; `temixCode`, `routeproActivatedAt` fields). **No live API integration to Temix/RoutePro found — they are manual/offline steps recorded in the portal.** [Confirmed — no HTTP client to those systems].
- No Sentry, no analytics.

## B.11 Main functional modules (by API namespace) [Confirmed]
34 API routes. Groups: **requests** (`/api/requests` CRUD + `[id]/{submit,approve,reject,return,confirm-temix,activate-routepro,photos}`, `duplicate-check`), **admin** (`activation-queue, audit-log, depots, requests/[id]/escalate, storage-stats, users(+[id],bulk)`), **customer-master** (`lookup`), **customers** (`[temixCode]`), **master** (`customers, upload, uploads` — CSV/XLSX master-data ingest), **dashboard/stats**, **notifications** (+read/read-all), **cron** (`sla-check, daily-summary`), **auth**, **blob/proxy**, **files/[key]**, **health**. Supporting libs: `duplicate-check.ts` (CR/name/phone matching), `sla.ts` (working-hours SLA), `audit-log.ts` (`AdminAuditLog`), `notifications.ts`.

## B.12 Development maturity [Confirmed facts + inference]
**Assessment: functional/near-production single-server MVP with real hardening but unresolved deployment-config debt.**
- FACTS: 10 git commits, single author line, last commit **2026-04-17** (~3 months stale vs 2026-07-15 today). Commit messages show audit-remediation cycles ("resolve all 17 pre-release audit issues", "22 audit findings"). Working CI pipeline that lints+tests+builds. Test suite present (e2e, regression, stress, smoke, security, permissions). Only **2 TODO/FIXME** in app/lib/components (low). Migrations + rate-limit table + audit log + SLA crons indicate genuine production intent. PRODUCTION_READINESS.md acknowledges remaining "infrastructure blockers".
- INFERENCE [Highly likely]: reached a "pilot/pre-launch hardened" state, then stalled. The Postgres-schema vs SQLite-env contradiction (B.5) and committed `.env` secrets (B.9) mean it is **not cleanly deployable as-is without config reconciliation**.
- [Possible] The optional S3 path is dead code unless `@aws-sdk/client-s3` is added.

## B.13 CONFIRMED vs INFERRED vs ASSUMED vs MISSING
- CONFIRMED: stack/versions, auth model, env var names, route inventory, committed `.env` secrets, Postgres/SQLite contradiction, raw SQL in rate-limit, no Sentry/logging lib, Vercel+Docker deploy configs, crons.
- REASONABLE INFERENCES: project stalled post-hardening; Postgres is the intended live DB (migrations/crons/ON CONFLICT); Temix/RoutePro are manual steps.
- UNVERIFIED ASSUMPTIONS: which DB the production instance actually runs; whether committed secrets were pushed to a remote; whether S3 path is ever exercised.
- MISSING INFORMATION: production DATABASE_URL/host; remote git URL & push history; actual runtime env on Vercel; whether `dev.db` reflects real vs seed data. Verify via: Vercel project env dashboard, `git remote -v` + history scan, and confirming the deployed datasource.
