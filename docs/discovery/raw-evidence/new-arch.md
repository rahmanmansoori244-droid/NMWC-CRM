# NMWC Customer Master (NEW) — Section B: Repository & Architecture Map

**System root:** `C:\Users\abdulr\Desktop\NMWC-CRM` (analysis performed in worktree `.claude/worktrees/nmwc-crm-consolidation-e10c1e`, branch `claude/nmwc-crm-consolidation-e10c1e`).
**Scope:** Repository & architecture inventory. Read-only.

---

## 1. Project purpose — [Confirmed]
Field-driven **customer master-data cleanup / enrichment** app for National Mineral Water Company SAOG. Salesmen in the field enrich existing customer + branch records (phones, GPS, photos, channel taxonomy, coolers/stands counts), submit **edits** that flow through a **supervisor/manager approval queue**; a head-office **Steward** imports/exports and manages duplicates.
- `package.json:5` — description "field-driven master data cleanup app".
- Verified in code, not just README: `prisma/schema.prisma` models `Customer`, `Branch`, `CustomerEdit` (approval state machine `EditState` DRAFT→SUBMITTED→APPROVED/REJECTED/NEEDS_CORRECTION, `schema.prisma:44-50, 352-381`), `services/edits.ts`, `services/reactivations.ts`, `services/duplicates.ts`, `services/imports.ts`.
- Route groups confirm the workflow: `app/(app)/approvals`, `/customers`, `/duplicates`, `/import`, `/export`, `/reactivations`, `/rejected`, `/routes`, `/team`, `/users`.

## 2. Technology stack WITH versions — [Confirmed] (from `package.json`)
| Layer | Tech | Version (semver range) |
|---|---|---|
| Framework | Next.js (App Router, RSC, Server Actions) | `^15.0.0` |
| UI runtime | React / React-DOM | `^19.0.0` |
| Language | TypeScript | `^5.6.0` |
| ORM | Prisma + `@prisma/client` | `^6.19.3` |
| DB | PostgreSQL (Neon) | provider `postgresql` (`schema.prisma:9`, `migration_lock.toml`) |
| Auth | NextAuth / Auth.js v5 beta + `@auth/prisma-adapter` | `next-auth ^5.0.0-beta.31`, adapter `^2.11.2` |
| Password hash | `bcryptjs` | `^3.0.3` |
| Storage SDK | `@aws-sdk/client-s3` + `s3-request-presigner` (→ Cloudflare R2) | `^3.1045.0` |
| Validation | `zod` | `^3.23.8` |
| Forms | `react-hook-form` + `@hookform/resolvers` | `^7.53.0` / `^3.9.0` |
| Styling | TailwindCSS + `tailwind-merge`, `clsx`, `class-variance-authority` | `tailwind ^3.4.13` |
| Icons | `lucide-react` | `^0.453.0` |
| Excel | `exceljs` | `^4.4.0` |
| Logging | `pino` (+ `pino-pretty` dev) | `^9.5.0` |
| Error tracking | `@sentry/nextjs` | `^10.52.0` |
| Test | Vitest `^2.1.0`, Playwright `^1.59.1`, Testing-Library, jsdom, `@faker-js/faker` | — |
| Deploy CLI | `vercel` (devDep) | `^48.12.1` |

Node engine target: CI uses **Node 20** (`.github/workflows/ci.yml:16`).

## 3. Main entry points — [Confirmed]
- **Root layout:** `app/layout.tsx` — reads `x-nonce` header to propagate CSP nonce (`layout.tsx:22`).
- **App shell layout:** `app/(app)/layout.tsx` (renders Sidebar/TopBar).
- **Middleware (Edge):** `middleware.ts` — Auth.js `authorized` gate + per-request CSP nonce; matcher excludes `_next/static|_next/image|favicon.ico` (`middleware.ts:26,50-74`).
- **Edge auth config:** `auth.config.ts` — JWT session, cookie hardening, `authorized`/`session` callbacks (deliberately Prisma-free for Edge).
- **Node auth impl:** `lib/auth.ts` — Credentials provider, JWT callbacks, exports `handlers/auth/signIn/signOut` + `cachedAuth`.
- **Instrumentation:** `instrumentation.ts` — loads Sentry server/edge configs by `NEXT_RUNTIME`; exports `onRequestError`.
- **Route handlers:** `app/api/auth/[...nextauth]/route.ts`, `app/api/health`, `app/api/photos/{presign,finalize,[id]}`, `app/api/exports/customers`, `app/api/cron/{photo-gc,keep-warm}`, `app/api/perf-probe`.
- **Server Actions:** `app/actions/auth.ts` + all `services/*.ts` (`'use server'`).

## 4. Folder map — [Confirmed]
**Source (tracked):**
- `app/` (57 files) — `(app)/` protected route group (13 feature areas), `(auth)/login`, `actions/`, `api/`.
- `components/nmwc/` (16) — UI components (CustomerCard, PhotoCaptureSlot, GpsCaptureButton, Sidebar, etc.).
- `lib/` (22) — infra: `db.ts`, `auth.ts`, `auth-handlers.ts`, `audit.ts`, `rate-limit.ts`, `r2.ts`, `logger.ts`, `access.ts`, `permissions.ts`, `session.ts`, `reference-data.ts`, `customer-count.ts`, `customer-filters.ts`, `completeness.ts`, `codes.ts`, `cr.ts`, `phone.ts`, `tz.ts`, `excel.ts`, `errors.ts`, `utils.ts`, `validation/edit.ts`.
- `services/` (10) — business logic: customer-export, duplicates, edits, exports, imports, photos, reactivations, routes, saved-views, users.
- `prisma/` — `schema.prisma`, `migrations/` (9 migrations), plus many seed/test scripts (`seed*.ts`, `synthetic.ts`, `test-*.ts`, `inject-test-edits.ts`).
- `scripts/` (13) — ops/one-off tooling (bulk-reset-credentials, flatten-customer-branches, r2-setup-lifecycle, guide/PDF builders, synthetic-launch-test).
- `tests/` — `unit/` (10 vitest specs), `e2e/login.spec.ts`, `loadtest.mjs`, `setup.ts`.
- `docs/` — PRD, TECH-SPEC, BUILD-REPORT, `audit/` (multiple audit .md), `guide/`.
- Config: `next.config.ts`, `middleware.ts`, `auth.config.ts`, `instrumentation.ts`, `sentry.{client,server,edge}.config.ts`, `vercel.json`, `tailwind/postcss/eslint/vitest/playwright` configs, `tsconfig.json`.

**Generated / build artifacts (NOT source):** `.next/`, `node_modules/`, `tsconfig.tsbuildinfo` (413 KB tracked-ish but gitignored), `.vercel/` (output/cache gitignored), `.claude/worktrees/*` (three sibling git worktrees: `awesome-swartz-5904a0`, `magical-goldstine-b8d2b4`, `nmwc-crm-consolidation-e10c1e` — separate branches, ignore for source analysis).

## 5. Database access — [Confirmed]
- **Provider:** PostgreSQL on **Neon** (`.env.example:10-14` names Neon; `schema.prisma:8-12` uses `DATABASE_URL` pooled + `DIRECT_URL` direct-for-migrate).
- **Prisma client singleton:** `lib/db.ts:7-15` — global `__prismaClient` guard, dev logging only. Standard pattern.
- **Raw SQL** ($queryRaw / $executeRaw) exists in 4 places — all parameterized tagged templates: `lib/rate-limit.ts:82` (atomic UPSERT token-bucket), `lib/customer-count.ts`, `app/api/health/route.ts:46` (`SELECT 1`), `app/api/cron/keep-warm/route.ts:56` (`SELECT 1`).
- **Provider-specific hacks** [Confirmed]: `pg_trgm` extension + GIN trigram indexes on `legalName/nmwcCode/primaryPhoneNorm` (`20260510120000_senior_audit_remediation/migration.sql:130-140`); partial B-tree indexes `WHERE ... IS NOT NULL / deletedAt IS NULL`; partial-unique on `crNumberNorm`; **phone uniqueness deliberately dropped** (`20260510160000_p1_drop_phone_unique` — many shops share one owner phone); `ALTER TYPE ... ADD VALUE` for enum extensions; `ANALYZE`. Optimistic locking via `version` column on Customer/Branch (`schema.prisma:264,329`).

## 6. Hosting / deployment — [Confirmed]
- **Vercel** (`vercel.json`): region `fra1`; `app/**/*.ts` `maxDuration` 30 s; **Vercel cron** `/api/cron/photo-gc` daily `0 3 * * *`. Project bound: `.vercel/project.json` `projectId prj_h2Nwxt…`, `orgId team_Zs4wKn…` (project identifiers, low sensitivity, tracked).
- **Production URL:** `https://nmwc-cm.vercel.app` (`.github/workflows/keep-warm.yml:45`, `.env.example:19`).
- **CI:** `.github/workflows/ci.yml` — on push/PR to main: `npm ci` → typecheck → lint → `npm test` (vitest). No deploy step (Vercel Git integration handles deploy).
- **Off-platform cron via GitHub Actions:** `keep-warm.yml` (`*/4 3-14 * * *`, pings keep-warm during Oman hours — Hobby plan can't do sub-daily Vercel cron); `db-backup.yml` (daily `0 2 * * *` `pg_dump 17 → gzip → R2 nmwc-backups`, plus manual restore-drill into a Neon branch, gated on `NEON_DRILL_ENABLED`).
- **Build:** `prisma generate && next build` (`package.json:8`).

## 7. Auth mechanism — [Confirmed]
- **Auth.js v5 (next-auth beta)**, **Credentials provider** (username + bcrypt), **JWT session strategy**, `maxAge` 8 h (`auth.config.ts:14`).
- Split config for Edge-safety: `auth.config.ts` (no Prisma) consumed by `middleware.ts`; heavy provider/callbacks in `lib/auth.ts`.
- Hardening present: `__Secure-` cookie prefix + httpOnly + sameSite=lax in prod (`auth.config.ts:19-31`); `AUTH_SECRET` length+entropy assertion in prod (`lib/auth.ts:17-32`); constant-time bcrypt via `DUMMY_BCRYPT_HASH` (`lib/auth.ts:39,260,289`); rate-limited authorize (`lib/auth.ts:249`); JWT freshness re-read every 5 min honoring `sessionsRevokedAt`/role change/disable (`lib/auth.ts:83,165-217`); forced password change gate `mustChangePassword` (`auth.config.ts:75-85`); password-reuse history (`PasswordHistory` model). Roles: SALESMAN/SUPERVISOR/MANAGER/STEWARD/VIEWER (`schema.prisma:15-21`); RBAC in `lib/access.ts` + `lib/permissions.ts`.

## 8. Environment variables — [Confirmed] (names only, values MASKED)
| Var | Purpose | Where read |
|---|---|---|
| `DATABASE_URL` | Neon pooled runtime conn | `schema.prisma:10`, `lib/rate-limit.ts:33`, seeds |
| `DIRECT_URL` | Neon direct conn (migrate/backup) | `schema.prisma:11`, seeds, `db-backup.yml:39` |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | JWT signing secret | `lib/auth.ts:19` |
| `NEXTAUTH_URL` | canonical app URL | `.env.example:20` |
| `R2_ACCOUNT_ID` | R2 endpoint/account | `lib/r2.ts:7`, `next.config.ts:3`, `middleware.ts:28`, `health` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 photo credentials | `lib/r2.ts:8-9` |
| `R2_BUCKET` | photos bucket (default `nmwc-photos`) | `lib/r2.ts:54` |
| `R2_ADMIN_ACCESS_KEY_ID` / `R2_ADMIN_SECRET_ACCESS_KEY` | R2 admin for lifecycle setup | `scripts/r2-setup-lifecycle.ts:31-32` |
| `R2_PUBLIC_BASE` | optional public photo base | `.env.example:28` |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN | sentry.{client,server,edge}.config.ts |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Sentry sourcemap upload (CI) | `.env.example:32-35` |
| `CRON_SECRET` | bearer for cron routes | `photo-gc/route.ts:41`, `keep-warm/route.ts:47` |
| `HEALTH_BEARER` | gate detailed `/api/health` | `health/route.ts:31` (must be ≥20 chars) |
| `DEMO_ACCOUNTS_DISABLED` | disable seed/demo logins | `lib/auth.ts:276` |
| `SEED_ADMIN_PASSWORD` | seed script admin pw | `prisma/seed.ts:99`, `synthetic.ts:94` |
| `LOG_LEVEL` | pino level | `lib/logger.ts:51` |
| `RATE_LIMIT_BACKEND` | force `memory` backend | `lib/rate-limit.ts:32` |
| `NODE_ENV` / `NEXT_RUNTIME` | env/runtime switches | multiple |
| `CI` / `E2E_BASE_URL` / `BASE` | test config | playwright/loadtest |
| GitHub Actions secrets (not app runtime): `BACKUP_R2_*`, `PROD_CRON_SECRET`, `NEON_API_KEY`, `NEON_PROJECT_ID`; var `NEON_DRILL_ENABLED` | backup/keep-warm CI | workflows |

## 9. External services / integrations — [Confirmed]
- **Neon Postgres** (DB). **Cloudflare R2** (photo storage `nmwc-photos` via presigned S3 PUT + backups bucket `nmwc-backups`; path-style + checksum opt-out hacks in `lib/r2.ts:34,49`). **Sentry** (`@sentry/nextjs`, PII-scrubbing `beforeSend`). **Vercel** (host+cron). **GitHub Actions** (backup, keep-warm cron). No ERP / Temix / RoutePro integration found [Confirmed — grep-negative; standalone master-data tool].

## 10. Functional modules (by route group / service) — [Confirmed]
`customers` (list/detail/edit enrichment), `approvals` (+bulk queue), `reactivations`, `rejected`, `duplicates` (merge), `import`/`import/[batchId]` (Excel promote), `export` + `api/exports/customers`, `routes`, `team`, `users` (admin), `dashboard`/`today`/`work`/`home`, `audit`, `profile`/change-password. Photo pipeline: `api/photos/{presign,finalize,[id]}` + `photo-gc` GC cron.

## 11. Development maturity — **Operational / pilot-launch** — [Highly likely]
Evidence: production Vercel deploy bound (`.vercel/project.json`) + live URL; recent commits are pilot-launch focused ("Bulk credential reset for pilot launch", "Pre-launch: synthetic smoke test", "Muscat pilot" seeds); full CI (typecheck/lint/test) + 10 unit specs + Playwright e2e + loadtest; DB backup + restore-drill automation; extensive security-audit remediation trail (QA-/AUTH-/B-/GAP- tags throughout, `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`); **TODO/FIXME density very low** (13 total, mostly in docs/package-lock; only ~4 in source). Not abandoned; not experimental. Caveat: `next-auth ^5.0.0-beta.31` is a **beta** auth dependency in production [Confirmed].

## 12. Security — secret handling — [Confirmed]
- **No secrets committed.** `.env`, `.env.local` exist locally (1075 bytes each) but are **gitignored** (`.gitignore` "Env" block); `git ls-files` tracks only `.env.example` (placeholders). Real secrets live in Vercel env + GitHub Actions secrets.
- Only "secret-looking" tracked strings are literal `postgresql://` scheme checks and placeholders in `db-backup.yml`/`.env.example` — **no real credentials** (redacted N/A; none present).
- `.vercel/project.json` exposes `projectId`/`orgId` (Vercel identifiers, not credentials) — low sensitivity; acceptable but could be gitignored.
- `DUMMY_BCRYPT_HASH` in `lib/auth.ts:39` is an intentional constant for a fake password, not a real secret.
- **Remediation:** none required for committed secrets. Recommend confirming Vercel/GitHub secret rotation policy and considering `.vercel/project.json` ignore.

## Confidence separation
- **CONFIRMED FACTS:** all versions, entry points, env-var names/locations, DB provider/access, auth model, hosting/cron config, folder map, no-committed-secrets — all read directly in code/config.
- **REASONABLE INFERENCES:** "operational/pilot" maturity (from commit history + deploy binding + seeds); "no ERP integration" (grep-negative).
- **UNVERIFIED ASSUMPTIONS:** actual runtime values of env vars (masked, not inspected); whether Vercel cron/keep-warm are actually enabled in the live project; whether restore-drill has ever run.
- **MISSING INFO:** live DB size/row counts; actual Sentry project activity; real deploy frequency (git history is local branch only — no remote CI run logs inspected). Verify via Vercel dashboard, Neon console, Sentry, and GitHub Actions run history.
