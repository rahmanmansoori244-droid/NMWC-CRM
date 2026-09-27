# Accounts and secrets — who holds what, and what depends on it

Item 13 of the re-benchmark (2026-09-24): **one person holds every credential.** Every
account this system runs on, and every secret in it, is held by the owner alone. If the
owner is unreachable, nobody else can deploy a fix, roll back a bad deploy, restore the
database, read a backup, rotate a leaked secret, or even read the detailed health probe.

This page lists what exists, where it lives and what breaks with it. It names things and
never holds a value; nothing here is a secret. It stays true because
`tests/unit/secrets-inventory.test.ts` fails when the application reads an environment
variable this page does not list.

**What this page cannot fix:** naming a second holder is the owner's decision (§4). Until
it is made, the risk this page describes is still open.

---

## 1. The accounts

These are the roots. Whoever holds them can reset every secret below.

| Account | What it controls | Holder today | Can a second person be added? |
|---|---|---|---|
| GitHub (`rahmanmansoori244-droid`) | The code; `main` deploys to production; every Actions secret (backup, cron, restore drill) | Owner | On a personal repository a collaborator can push but cannot manage settings or secrets. A second administrator needs the repository moved into a GitHub organisation (the free plan allows this). |
| Vercel (project `nmwc-cm`, **Pro plan since 2026-09-27**) | The production deployment, rollback, the scheduled jobs, the logs, every runtime variable in §2 | Owner | Yes: Settings → Members. A developer seat is $20 a month. A Viewer seat is free and read-only, which is enough to read the logs and the deployments but not to deploy or change a variable. |
| Neon (production endpoint `ep-sweet-haze`, UAT `ep-lucky-bar`) | The database, point-in-time restore, the owner role | Owner | Check Neon → Organization → Members for the current plan. |
| Cloudflare (R2 buckets `nmwc-photos` and the backup bucket) | Every photograph, every nightly dump, their API tokens | Owner | Cloudflare → Manage account → Members. |
| Sentry | Error reports from all three runtimes | Owner | The free plan has one user. |
| cron-job.org | The keep-warm and SLA sweep schedules — **being retired**: Vercel runs both since the Pro plan (OPERATIONS.md §5d) | Owner | Not needed once retired. Retiring it properly — delete the jobs and the API key, then rotate `CRON_SECRET` — removes cron-job.org's copy of the secret. Vercel and GitHub Actions (`PROD_CRON_SECRET`) still hold it. |
| The alert destination (`ALERT_WEBHOOK_URL`, once set) | Where failed-job and SLA alerts land | Not set yet | Point it at a channel two people read (OPERATIONS.md §5f). |

Check each provider's current plan page before acting on the "second person" column.
Plans change, and this column was written from what the plans allowed in September 2026.

---

## 2. Runtime variables (Vercel → Production → Environment Variables)

Secrets are marked **S**. The rest are settings, and are listed so that this page is the
one complete list: OPERATIONS.md §3 used to be that list and had fallen behind.

| Variable | S | What it does | If it leaks | Must match |
|---|---|---|---|---|
| `DATABASE_URL` | S | Pooled connection the app runs on. It is meant to be the least-privilege role `nmwc_app`; until CREDENTIAL-ROTATION.md step 1 is done it is the **owner** (item 14). | As the owner, full control of the database. As `nmwc_app`, read and write of customer data; rotate the role (OPERATIONS.md §5c). | Once on `nmwc_app`, GitHub `NMWC_APP_PASSWORD` holds the same role's password |
| `DIRECT_URL` | S | Owner connection; `prisma migrate deploy` runs with it during every build | Full control of the database, the audit log included. See CREDENTIAL-ROTATION.md. | GitHub `DIRECT_URL`, and the local `.env` of anyone who runs operator scripts |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | S | Signs every session | Anyone can mint a session as any user. Rotating it signs everyone out. | Each other (same value) |
| `AUTH_URL` / `NEXTAUTH_URL` | | The production origin, for sign-in redirects | — | Each other |
| `AUTH_TRUST_HOST` | | `true`; read by Auth.js itself, not by this code | — | — |
| `CRON_SECRET` | S | Bearer that the scheduled jobs present. Vercel's own cron sends it automatically. | Anyone can trigger the sweeps (they are idempotent), and can post a false "backup succeeded" report to `/api/ops/backup-report`, hiding a failing nightly backup from the health check and the Service status page | GitHub `PROD_CRON_SECRET`; while cron-job.org is still in use, re-run the External cron scheduler `apply` so it sends the new one |
| `HEALTH_BEARER` | S | Unlocks the detailed `/api/health` | Exposes the running commit, the job states and their last (scrubbed) errors | GitHub `HEALTH_BEARER` (CI's post-deploy smoke) |
| `R2_ACCOUNT_ID` | | The Cloudflare account the photo bucket lives in | — | — |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S | Photo uploads and reads | Every photograph, the confidential documents included. Revoke the token in Cloudflare and issue a new one. | — |
| `R2_BUCKET` | | Photo bucket name (`nmwc-photos`) | — | — |
| `ALERT_WEBHOOK_URL` | S | Where alerts are posted | Anyone can post into that channel | — |
| `MAINTENANCE_MODE` | | `on` closes the app behind a notice, after a redeploy (OPERATIONS.md §6.8) | — | — |
| `MAINTENANCE_BYPASS_TOKEN` | S | Lets the operator through while closed | Bypasses only the maintenance notice, not sign-in | — |
| `DEMO_ACCOUNTS_DISABLED` | | Blocks the seeded demo logins; production sets it | — | — |
| `NEXT_PUBLIC_SENTRY_DSN` | | Where error reports go. It ships to the browser by design. | Someone could post junk events | — |
| `LOG_LEVEL` | | Log verbosity | — | — |
| `RATE_LIMIT_BACKEND` | | `memory` forces the in-process limiter (tests only) | — | — |
| `SALESMAN_SUBMIT_GATE` | | `FULL` makes every mandatory field block a salesman's submission; unset means the lighter `CORE` gate | — | — |
| `PROMOTE_SLICE_BUDGET_MS`, `BULK_BUDGET_MS` | | Time budgets for import promote and bulk approve | — | — |
| `WORK_TZ_OFFSET_MIN`, `WORK_DAYS`, `WORK_HOUR_START`, `WORK_HOUR_END` | | The working calendar SLA clocks run on | — | — |
| `SLA_SUPERVISOR_MIN`, `SLA_ACCOUNTANT_MIN`, `SLA_MANAGER_MIN`, `SLA_FINANCE_MIN`, `SLA_GM_MIN` | | Approval SLA per tier | — | — |

Set by the platform, never by hand: `NODE_ENV`, `NEXT_RUNTIME`, `VERCEL_ENV`,
`VERCEL_GIT_COMMIT_SHA`. `next.config.ts` maps the last two into `NEXT_PUBLIC_SENTRY_ENV`
and `NEXT_PUBLIC_SENTRY_RELEASE` at build time.

---

## 3. Everything else that is a credential

- **GitHub Actions secrets and variables** — one list, kept in step with the workflows by
  a test: `npm run ops:print-secrets` (it renders `lib/ops/required-secrets.ts`, with where
  each value comes from and what breaks without it).
- **The backup age private key** (`BACKUP_AGE_IDENTITY`, plus the escrowed second key).
  Without it no backup can be read. It is the one secret that cannot be re-issued, because
  a new key cannot decrypt the dumps made for the old one. OPERATIONS.md §6.7.
- **Local `.env` files** on the owner's machine. The main checkout's `.env` holds the
  **production** `DIRECT_URL`. Anyone with that machine holds the owner role.
- **Application accounts with administrative reach**: the Data Steward and the Managers.
  These are users of the app, not infrastructure, but if the only active Steward is
  unavailable, nobody can import, correct quarantined rows or reset passwords. Keep at
  least two active Steward accounts.

---

## 4. What a second holder needs, and the decision that is open

**Owner decision, not yet made:** who the second holder is, and which of these is used.

1. **A second administrator on each account.** This is the cleanest option: nobody shares
   a password and every action is attributable. Vercel is on Pro now, so this costs $20 a
   month for their developer seat (a free Viewer seat can read but not deploy). It also
   needs a paid Sentry plan and a GitHub organisation (free).
2. **Sealed break-glass credentials.** The owner's logins are kept in a password-manager
   vault or a sealed envelope that a named second person can open, and opening it is
   recorded. It costs nothing, but everything is done as the owner, so the audit trail
   cannot tell the two people apart.
3. **Accept the risk and write it down.** An outage while the owner is away then lasts
   until the owner is back.

The smallest set that lets a second person keep production alive is: GitHub (to merge a
fix, which deploys it), Vercel (to roll back and to change a variable), Neon (to restore)
and the age private key (to read a backup). Cloudflare, Sentry and cron-job.org can wait
for the owner.

## 5. Rotation dependencies

Rotating one value often means changing it in two or three places. The **Must match**
column in §2 lists them. Two are easy to forget:

- **`CRON_SECRET`**: Vercel, then GitHub `PROD_CRON_SECRET`. Vercel's own cron picks
  the new value up at the next deploy. While cron-job.org is still in use, also run the
  External cron scheduler `apply`, or cron-job.org answers 401 every four minutes and
  then disables its jobs.
- **The owner database password**: Vercel `DIRECT_URL`, GitHub `DIRECT_URL`, then every
  local `.env`. Neon branches share the role's password, so UAT changes with it.
  CREDENTIAL-ROTATION.md is the full procedure.
