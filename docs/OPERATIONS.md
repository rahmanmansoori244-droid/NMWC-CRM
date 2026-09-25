# NMWC Customer Master — Operations Runbook

This is the operator's manual: what to do when something breaks, how to deploy, where data lives. Companion to [PRD-v0.1.md](PRD-v0.1.md), [UX-SPEC.md](UX-SPEC.md), [TECH-SPEC.md](TECH-SPEC.md).

---

## 1. Production URL

- App: **https://nmwc-cm.vercel.app** (Vercel-issued; custom domain TBD)
- Health: https://nmwc-cm.vercel.app/api/health → public callers see only `{ "status": "ok" }` (200) or `{ "status": "degraded" }` (503 when the database does not answer `SELECT 1`; B-12 still holds — nothing else is disclosed; changed by B5 on 2026-09-14, it used to be 200 unconditionally). Authenticated monitoring with `Authorization: Bearer $HEALTH_BEARER` gets the full `{app, db, r2}` checks plus the `cron` heartbeat report (§5d) and a 503 status when any check or heartbeat alarms.

## 2. Where data lives

| Component | Location | Access |
|---|---|---|
| App code | GitHub `rahmanmansoori244-droid/NMWC-CRM` | git |
| Hosting | Vercel project `nmwc-cm` (account: `rahmanmansoori244-6893's projects`) | https://vercel.com/rahmanmansoori244-6893s-projects/nmwc-cm |
| Database | Neon project `nmwc-cm` (region: AWS us-east-1) | https://console.neon.tech/app/projects/snowy-haze-29025382 |
| Photos | Cloudflare R2 bucket `nmwc-photos` (account `a5cc755aea210134949be8fcc1146819`) | https://dash.cloudflare.com/a5cc755aea210134949be8fcc1146819/r2/default/buckets/nmwc-photos |
| Errors | Sentry project `nmwc-cm` (org `nmwc`) | https://nmwc.sentry.io |
| Email | Resend (free tier, optional — not yet wired) | n/a |

## 3. Environment variables (Vercel)

Production env vars are set in the Vercel project settings. To inspect/update via CLI:

```bash
export VERCEL_TOKEN=...   # personal access token, scope: rahmanmansoori244-6893's projects
npx vercel env ls
npx vercel env add SOME_VAR production
```

Required:
- `DATABASE_URL` — Neon pooled connection string
- `DIRECT_URL` — Neon direct connection (used for migrations only)
- `NEXTAUTH_SECRET` / `AUTH_SECRET` — 32-byte base64; same value
- `NEXTAUTH_URL` / `AUTH_URL` — `https://nmwc-cm.vercel.app`
- `AUTH_TRUST_HOST=true`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=nmwc-photos`
- `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`
- `LOG_LEVEL=info`

## 4. Deploy

Branch model: trunk (`main`). Every push to `main` is a deploy.

```bash
# manually deploy current local commit (CI does this on push too)
npx vercel --prod --token=$VERCEL_TOKEN --yes
```

Rollback: in the Vercel dashboard, find the previous deploy → "Promote to production". Or via CLI:

```bash
vercel rollback <deployment-url>
```

## 5. Database migrations

Schema lives at `prisma/schema.prisma`. Migrations in `prisma/migrations/`.

```bash
# create a new migration locally + apply to Neon
npm run db:migrate -- --name describe_change

# apply existing migrations to a fresh DB (e.g. staging branch)
npx prisma migrate deploy
```

- **Migrations ARE applied by the Vercel build.** `package.json` `build` runs `prisma generate && next typegen && tsc --noEmit && next lint && prisma migrate deploy && next build --no-lint`, so any migration on the deployed commit is applied to the database in `DIRECT_URL` as part of the deploy — but only after the typecheck and lint have passed. A deploy that failed in `next typegen`, `tsc` or `next lint` applied nothing; one that failed inside `next build` HAS applied its migrations. (This line previously said the opposite; it was wrong, and it matters — a rollback of the application does not roll back the schema, and a restore followed by a deploy will re-apply migrations.)

## 5b. First-time post-deploy operator checklist

Run these once after the senior-audit remediation deploy. Each item is needed by a senior-audit blocker; none auto-resolve themselves.

### A. Reconnect Vercel ↔ GitHub auto-deploy (op note 1)
The CLI cannot toggle this on its own. Do it via UI:
1. Open https://vercel.com/rahmanmansoori244-6893s-projects/nmwc-cm/settings/git
2. Under "Connected Git Repository", click "Connect" and select `rahmanmansoori244-droid/NMWC-CRM` on `main`.
3. Confirm in https://github.com/rahmanmansoori244-droid/NMWC-CRM/settings/installations that the Vercel app is installed.
4. From now on, every `git push origin main` triggers a Vercel build automatically. Until then, the deploy must be done manually with `npx vercel --prod`.

### B. Configure GitHub Actions secrets for the daily DB backup (op note 2)
The workflow `.github/workflows/db-backup.yml` fails at its **Validate** step without `DIRECT_URL`, at **Encrypt** without the age recipients, and at **Upload** without the R2 pair — so a missing value never produces a quiet, incomplete backup. Note that GitHub keeps *variables* and *secrets* on two different settings pages, and a value set on the wrong page simply reads as empty.
1. Run `npm run ops:print-secrets` locally — it lists exactly which secret names are needed and shows which values are already present in your `.env`.
2. Create a separate R2 bucket `nmwc-backups` (Cloudflare → R2 → "Create bucket"). Keep it separate from `nmwc-photos` so a leaked photo token cannot also touch the backups.
3. Create an R2 API token scoped only to that bucket: Cloudflare → R2 → API tokens → "Create token" → permission "Object Read & Write" → restrict to bucket `nmwc-backups`. Save the access key + secret immediately (R2 only shows the secret once).
4. Generate the age key pair — `age-keygen -o nmwc-backup.key` — and put the **public** half in the `BACKUP_AGE_RECIPIENTS` repository *variable*. Escrow the private half somewhere that is neither this machine nor this repository (§6.7). Without this the nightly job refuses to run, on purpose: it used to upload the whole customer master and every password hash in plaintext instead.
5. Set every name step 1 printed, on the two pages it names. Do not re-type a list here — the printed one is generated from `lib/ops/required-secrets.ts`, which a unit test compares against the workflow files in both directions. A hand-copied list in this document is exactly what drifted for four months (DO-16).
6. Trigger a manual run: Actions tab → "DB Backup" → "Run workflow". Confirm green, then check the bucket holds `db/<timestamp>.sql.gz.age`. The `.age` suffix is the proof it was encrypted.

### C. R2 lifecycle rules for the photos bucket (op note 3)

> **`npm run ops:r2-setup` IS NOT IDEMPOTENT, whatever its own comment says.** It calls
> `PutBucketLifecycleConfiguration`, which REPLACES a bucket's whole lifecycle
> configuration with the two rules written inside `scripts/r2-setup-lifecycle.ts`.
> Anything else on `nmwc-photos` is deleted by that call — including the
> `noncurrent-versions-30d` rule §6.13 asks you to create, which is the only
> protection the photographs have against an overwrite or a delete. **Run it before
> §6.13, or never.** Order and recovery: §6.13 step 0.

Two options — **B is preferred now; A is only safe on a bucket that has no lifecycle rules yet.**

**Option A (script, first-time only):** create a second R2 token with bucket-admin scope and let the script write both rules in one go.
1. Cloudflare → R2 → API tokens → "Create token" → permission "Admin Read & Write", then "Apply to specific buckets only" → `nmwc-photos`. Do not make it account-wide: the backups bucket has its own token, so that a leak of one does not expose the other.
2. Add the new key/secret to your local `.env` as `R2_ADMIN_ACCESS_KEY_ID` and `R2_ADMIN_SECRET_ACCESS_KEY` (separate from the existing `R2_ACCESS_KEY_ID`, which is object-only and should stay untouched).
3. Run `npm run ops:r2-setup`. It writes the `gc-marked-7d` and `incomplete-multipart-1d` rules — and **only** those two, deleting any others. It also attempts Object Versioning; R2 answered `NotImplemented`, so that part is a no-op and §6.13 step 1 does it in the dashboard.
4. The script falls back to the regular object-only R2 token if the admin key isn't set, and then prints an `AccessDenied` warning instead of writing anything.

**Option B (manual UI, safe at any time):** Cloudflare R2 dashboard → bucket `nmwc-photos` → Settings → Lifecycle rules → Add rule. Adding rules one at a time in the dashboard leaves the existing ones alone, which is why this is now the preferred route:
- Tag filter: `gc-marked=true` → Expire 7 days after tag applied.
- Also add: Multipart upload abort after 1 day.
- Versioning toggle on the same Settings page, plus the non-current-version rule in §6.13.

### D. (Optional) Mint a dedicated R2 admin token to remove the warnings
If you skipped Option A, `npm run ops:r2-setup` prints a warning about the photos token lacking bucket-admin scope whenever someone runs it by hand. Nothing runs it on a schedule — read the box above before running it at all. The admin token the *daily* check needs is a repository secret, not a `.env` entry: §6.13 step 4.

---

## 5c. Database roles — least privilege (B4, 2026-09-14)

The application no longer runs as the database owner. Two credentials exist:

| Variable | Role | Used by | May |
|---|---|---|---|
| `DIRECT_URL` | `neondb_owner` (direct endpoint) | `prisma migrate deploy` in the Vercel build, the nightly backup, Steward maintenance scripts (`scripts/wipe-synthetic-data.ts`, `prisma/synthetic.ts --reset`, `scripts/ops/app-role.ts`) | everything |
| `DATABASE_URL` | `nmwc_app` (pooled endpoint) | the running app | read/write application tables; **insert-only** on `AuditLog` and `EditApproval`; no DDL; no access to `_prisma_migrations` |

`AuditLog` and `EditApproval` are also protected by a database trigger (migrations `20260914150000_audit_immutability` + `20260914160000_audit_maintenance_owner_only`): UPDATE / DELETE / TRUNCATE raise `B4: … append-only` for every connection, including the owner, unless the statement runs inside a transaction that first executed `SET LOCAL nmwc.audit_maintenance = 'on'` **and the session logged in as the table owner** (`session_user`, which FK cascades cannot change). The maintenance scripts and the test clean-ups do exactly that on `DIRECT_URL`; the app role has no DELETE privilege on the ledgers or on `CustomerEdit` (the cascade path), and the trigger ignores its override anyway.

**Rolling the role out — the short way (recommended).** The owner database
credential lives in the Vercel environment and in this repository's secrets.
Copying it onto a laptop to run three commands is how credentials leak, so run
them where the secret already is:

1. Set the repository secret `NMWC_APP_PASSWORD` (24+ characters, no single
   quote). Keep the value — step 2 needs the same one.
2. **Actions → Provision app role → Run workflow.** Type the endpoint id you
   intend to touch (e.g. `ep-sweet-haze`); the job refuses to run if that
   string is not in `DIRECT_URL`. Tick *dry run* first if you want to see the
   current state without changing anything.
3. The run creates the role, applies the privilege set and proves every refusal
   connected as the role. **The application is still connecting as the owner at
   this point** — nothing has changed for users, and the role is unused.
4. **Vercel → Settings → Environment Variables → Production:** set
   `DATABASE_URL` to the pooled `nmwc_app` URL (same host as today with
   `-pooler` in it, user and password replaced), leave `DIRECT_URL` alone,
   redeploy.
5. Confirm `checks.db: ok` on the bearer health probe.

To roll back, set `DATABASE_URL` back to the owner URL and redeploy. The role
can stay; nothing connects as it.

**Rolling the role out by hand (the same three commands, if you prefer):**

```bash
# 1. create the role (owner credential in DIRECT_URL; pick a 24+ char password)
NMWC_APP_PASSWORD='<strong password>' node scripts/qa/run-with-env.mjs tsx scripts/ops/app-role.ts create
# 2. apply the grants (idempotent — safe to re-run after any migration)
node scripts/qa/run-with-env.mjs tsx scripts/ops/app-role.ts grant
# 3. prove it, connected AS the role (pooled host, user nmwc_app). Every probe runs in one
#    transaction that is rolled back — verify leaves no rows behind, so it is safe on production.
NMWC_APP_URL='postgresql://nmwc_app:<password>@<host>-pooler.../neondb?sslmode=require' \
  node scripts/qa/run-with-env.mjs tsx scripts/ops/app-role.ts verify
# 4. Vercel → env → DATABASE_URL = the nmwc_app URL from step 3 (keep DIRECT_URL = owner) → redeploy
# 5. curl -H "Authorization: Bearer $HEALTH_BEARER" https://<host>/api/health   → checks.db ok
```

Against production the scripts refuse to run unless `ALLOW_PRODUCTION=1` is set — the owner runs steps 1–3 deliberately, and because `run-with-env.mjs` only fills variables that are *unset*, the production owner URL must be passed explicitly or the commands act on whatever `.env` holds (UAT):

```bash
ALLOW_PRODUCTION=1 DIRECT_URL='<production owner URL, direct host>' NMWC_APP_PASSWORD='<strong password>' \n  npx tsx scripts/ops/app-role.ts create
ALLOW_PRODUCTION=1 DIRECT_URL='<production owner URL, direct host>' npx tsx scripts/ops/app-role.ts grant
ALLOW_PRODUCTION=1 NMWC_APP_URL='postgresql://nmwc_app:<password>@<production pooled host>/neondb?sslmode=require' \n  npx tsx scripts/ops/app-role.ts verify
```
 CI performs the same create → grant → verify on every run against its throw-away Postgres, so a migration that breaks the privilege set is caught before it ships. Verified on the Neon UAT branch on 2026-09-14 (Neon allows `CREATE ROLE` via SQL for the owner; the role is not shown in the Neon console but works).

## 5d. Cron heartbeats and the health probe (B5, 2026-09-14)

Every scheduled job (`sla-escalate`, `keep-warm`, `photo-gc`) records a heartbeat row (`CronHeartbeat`) when it finishes, success or failure. The bearer health probe reports them:

```bash
curl -s -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq .cron
```

States: `ok`, `outside-window` (not expected right now), `failed` (last run reported an error), `stale` (no run for 3 × the schedule interval inside its window), `never` (no run recorded). `failed`, `stale` and `never` set `status: degraded` and **HTTP 503** — point an external uptime monitor at this URL with the bearer header and alert on non-200. The anonymous probe (no header) now also answers 503 when the database is unreachable, so a plain uptime check sees a real outage.

**Scheduler decision (D3) — owner chose an EXTERNAL scheduler (2026-09-14).** GitHub Actions delivered 2–4 of the ~180 configured keep-warm runs a day, so the SLA sweep effectively did not run. The jobs stay where they are (plain authenticated GET endpoints); only the caller changes.

Set up at any free cron service (cron-job.org, EasyCron, Better Uptime's "heartbeat + request" — the steps below use cron-job.org):

| # | Job | URL | Schedule (UTC) | Oman local |
|---|---|---|---|---|
| 1 | Keep-warm | `https://nmwc-cm.vercel.app/api/cron/keep-warm` | `*/4 3-14 * * *` (every 4 min) | 07:00–18:59 |
| 2 | SLA escalation | `https://nmwc-cm.vercel.app/api/cron/sla-escalate` | `15,45 3-14 * * *` (twice an hour) | 07:15–18:45 |

**Set them up with the workflow, not by hand (2026-09-24).** Setting cron-job.org up through its web page did not work, and doing it by hand means copying `CRON_SECRET` out of Vercel, where it may not be revealable. `.github/workflows/cron-scheduler.yml` does it through cron-job.org's API instead, from inside GitHub Actions, using the `PROD_CRON_SECRET` repository secret the GitHub-scheduled workflows already use successfully. Nobody handles the secret.

1. **cron-job.org → Settings → API → create an API key.** Leave its IP restriction **off**: GitHub's runners change address, and a restricted key answers 403.
2. **GitHub → Settings → Secrets and variables → Actions → New repository secret:** name `CRONJOB_API_KEY`, value the key. (Or `gh secret set CRONJOB_API_KEY` and paste it at the prompt.)
3. **Actions → External cron scheduler → Run workflow → mode `check`.** Read-only: it lists what exists, how each job differs from the spec, and its last executions. It is red until both jobs are right.
4. **Run it again with mode `apply`.** It first proves the bearer with a real GET to keep-warm, and writes nothing if production refuses it. Then it creates both jobs, or corrects a hand-made one in place (time zone, `Bearer ` prefix, schedule, method, failure e-mails). A second job on the same URL is disabled, not deleted, and other jobs on the account are not touched. It ends by re-reading and must finish green.

What `apply` writes, for the record: method **GET**, time zone **UTC**, the schedules above, header `Authorization: Bearer <PROD_CRON_SECRET>`, a 30-second timeout, and an e-mail after two consecutive failures and when cron-job.org disables a job. `scripts/ops/cron-scheduler.ts` is the whole specification, and `tests/unit/cron-scheduler.test.ts` proves it against a simulated cron-job.org, including that neither the cron secret nor the API key is ever printed. A free account allows 100 API requests a day; `check` uses about five, `apply` about ten.

Doing it by hand remains possible, and the same rules apply: GET, UTC, one header `Authorization: Bearer <CRON_SECRET>` with the Production value (never paste it into a ticket or a screenshot), failure notifications on. Photo GC stays on Vercel's own daily cron (`vercel.json`), which the Hobby plan does allow.

Afterwards, confirm — **inside the window, 03:00–14:59 UTC** (outside it both jobs read `outside-window`, which proves nothing). `npm run smoke -- --expect-commit <main's short sha>` must pass all 16 checks, and pass again **20+ minutes later with no manual trigger in between** — a single green right after a manual run only proves that run. The `check` mode's execution history should show keep-warm every 4 minutes and the sweep at :15 and :45, all HTTP 200. Or directly:

```bash
curl -s -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq '.status, .cron'
```

`keep-warm` and `sla-escalate` should read `"state": "ok"` and the overall status `ok` (HTTP 200). Until the first run of each job the probe correctly answers 503 with `"state": "never"`.

The two GitHub Actions workflows (`.github/workflows/keep-warm.yml`, `sla-escalate.yml`) can be left enabled as a free backup — the sweep is idempotent and a duplicate keep-warm ping costs nothing. Note they use `curl -fsSL`, so with the B5 change they now go red when the endpoint answers 503, which is the intended signal.

**If you ever move to Vercel Pro instead**, delete the external jobs and add to `vercel.json` `crons`: `{"path": "/api/cron/keep-warm", "schedule": "*/4 3-14 * * *"}` and `{"path": "/api/cron/sla-escalate", "schedule": "15,45 3-14 * * *"}`. Vercel signs its own cron calls, so no header is needed.

## 5f. Outbound alerts — the only way this system can reach you (GAP-2, 2026-09-24)

Until 2026-09-24 nothing in this system could reach a person who was not looking at a screen. There is no mailer and no SMS: a `Notification` row existing means "visible in-app" and nothing more (`lib/notifications.ts` says so in terms — the e-mail drain queue has no drainer). So the SLA sweep escalated twice an hour into a bell nobody had open, and a cron that stopped running was visible only to whoever thought to curl `/api/health` with the monitor bearer.

There is now one outgoing webhook: one URL, one variable, no account, no vendor.

### What to paste, and where

Create an incoming webhook in whichever channel you actually read:

| Channel | Where the URL comes from |
|---|---|
| Slack | Slack → your app → Incoming Webhooks → Add New Webhook to Workspace |
| Teams | The channel → ⋯ → Connectors → Incoming Webhook |
| Discord | Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL |
| WhatsApp | Any bridge that accepts a JSON POST and forwards the `text` field |

Then: Vercel → Settings → Environment Variables → **Production** → `ALERT_WEBHOOK_URL` = that URL → **redeploy**. A new variable does not reach a deployment that is already running, so without the redeploy nothing changes and it reads as the webhook not working.

**The URL is a credential** — whoever holds it can post into that channel. It is never logged, never in the health payload, and must not go into a ticket or a screenshot. It is deliberately **not** a GitHub Actions secret and deliberately **not** in `lib/ops/required-secrets.ts`: that list is the workflows' contract and its drift test fails on any name the workflows do not read (§DO-16).

**Leaving it unset is a valid state**, not an error — `lib/alert.ts` no-ops silently and no sweep, import or cron behaves differently. The cost of leaving it unset is this entire section.

Prove the URL itself is live before you rely on it. Nothing in the app sends a test alert, so this checks the channel, not the wiring:

```bash
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"text":"[INFO] nmwc alert test — ignore","content":"[INFO] nmwc alert test — ignore"}' \
  "$ALERT_WEBHOOK_URL"
```

### What each alert means when it arrives at 3am

Every message reads `[SEVERITY] event/scope — sentence (counts)` and carries an `env` field, so UAT and production can share one channel. **Counts and self-minted ids only — never a customer name, phone, CR number or address** (the payload in `lib/alert.ts` is an allowlist, and `tests/unit/alert.test.ts` proves it drops the rest). The allowlist covers the field NAMES as well as their values, because the names are rendered into that line too — a filter that checked only values was the 2026-09-24 finding.

| `event` | Fires when | What it means, and what to do |
|---|---|---|
| `cron.failed` | A scheduled job records a failed run. `scope` is the job: `sla-escalate`, `keep-warm`, `photo-gc`, `retention-sweep`, `db-backup` | Something scheduled is broken *now*. `db-backup` means last night's dump did not land — go to §6 and the Actions run. `sla-escalate` means approvals are no longer being escalated. Read the detail: `curl -H "Authorization: Bearer $HEALTH_BEARER" …/api/health \| jq .cron` — the scrubbed error text stays there rather than on the webhook. |
| `sla.escalated` | The SLA sweep escalated at least one request. `critical` when any of them was a *second* escalation | Approvals are sitting past their budget. Nobody is required to act at 3am — the working window is Sun–Thu 08:00–17:00 — but a `critical` means a request has now been waiting over twice its stage budget. `warn` and `critical` are deduplicated separately, so a first escalation earlier in the window cannot hold a `critical` back. Open the app; it names them, the alert deliberately does not. |
| `import.rejections` | A customer master promote **finished** with rejected rows. `scope` and `ids.batchId` are the batch | The Steward's load is done but incomplete. Open `/import/<batchId>` for the per-row reasons. One alert per batch, never one per row — a load that rejects 1,833 rows sends exactly one message. |

At most **one alert per `event`+severity+`scope` per four-hour window**. A repeat inside the window is dropped and logged as `alert.suppressed`; the SLA sweep runs 24 times a day, and a channel that repeats itself 24 times gets muted, which puts you back where this section started. Severity is part of that key because a `warn` must never silence a `critical`: until 2026-09-24 a first escalation at 04:15 held back a second-level one at 04:45, and the second was never reported at all.

**What re-raises and what does not.** `cron.failed` is sent by each *failing run*, so how often it repeats depends on how often the job runs. `keep-warm` and `sla-escalate` run many times a day inside 03:00–15:00 UTC, so a failure that persists raises itself again as each window opens: three or four messages a day rather than once or twenty-four times. `db-backup`, `photo-gc` and `retention-sweep` run once a day, so they alert once a day, on that day's failing run. `sla.escalated` and `import.rejections` are *events*: each escalation is counted once, on the sweep that performs it, and each batch finishes once. One that falls inside an already-used window, or whose POST fails, is **not** sent later. So treat an SLA alert as "go and look", not as a complete list — the app's approvals queue is the list.

The windows are **fixed clock windows** — 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 UTC — not four hours measured from the last message. So a condition first reported at 03:59 can report once more a minute later. That is deliberate and it is the smaller fault: measuring from the last message needs a bucket that refills, and on the durable rate limiter this system runs (`lib/rate-limit.ts`, the Postgres backend) a refilling bucket **never re-raised at all** — it was found on 2026-09-24 posting one message for a condition that stayed true for a day, having been documented here as re-raising every four hours. `tests/unit/alert.test.ts` now pins the re-raise against a simulation of that limiter's own statement.

### What this does NOT cover

- **A job that stops running altogether pushes nothing.** No run means no failure to report. `stale` and `never` are still only visible on the pulled `/api/health` probe, so the external monitor in §5d is **still required** — this webhook does not replace it.
- **No retry.** A webhook that is down for the one POST loses that alert, and the window's single token has already been spent. A `cron.failed` comes back on the job's next failing run (see above for how soon that is); an `import.rejections` or `sla.escalated` does not come back at all.
- **While the database is unreachable the dedup is per server instance.** The limiter falls back to memory for alert keys so that an alert *about* the outage can still go out, and every cold-started instance has its own memory — so during an outage expect repeats, up to one per instance per window.
- **The URL is also kept out of Sentry.** Sentry records every outgoing request itself and keeps the URL's path, which for Slack, Teams and Discord is the secret; `lib/sentry-scrub.ts` replaces the configured URL, its path and its query with `[alert-webhook]` in every event it sends.
- **Nothing else alerts.** Not a degraded health check, not sign-in failures, not R2 errors, not the database being unreachable on its own — only a scheduled job that failed *because* of it.
- The alert never says *which* customer. That is not an oversight; a webhook is a third party.

## 6. Backups, recovery, and what they are actually worth

### 6.1 What exists

| Layer | Covers | Window | Where |
|---|---|---|---|
| Neon point-in-time recovery | The database, to any instant | 7 days | Same provider, same region as production |
| Nightly off-Neon dump | The database, as of the dump | 30 days of dumps | Cloudflare R2 `nmwc-backups` — encrypted to the age recipients; until the key is set up (§6.7) the workflow **fails and uploads nothing** |
| **Nothing yet** | The photographs in `nmwc-photos` | — | Single copy. Bucket versioning + a 30-day non-current retention is the chosen answer and is an **owner action** — §6.13. It is an undo, not a second copy: even once it is on, this row still says one copy |

The nightly dump is `.github/workflows/db-backup.yml`: `pg_dump --no-owner --no-privileges --format=plain --no-unlogged-table-data`, gzipped, age-encrypted, uploaded to `db/<timestamp>.sql.gz.age` with a row-count manifest beside it at `db/<timestamp>.manifest.json`.

### 6.2 Recovery objectives

These are measured, not aspirational. Two different RPOs apply and conflating them is the usual mistake.

| Scenario | Path | RPO — data you lose | RTO — time to serving again |
|---|---|---|---|
| Bad import, bad migration, or a destructive mistake, **within 7 days** | **A — Neon PITR** | Effectively **zero**: restore to the second before the damage | **15–30 min**, most of it deciding the timestamp |
| Damage older than 7 days, or a Neon-side logical problem | **B — restore the latest dump into a new Neon branch** | Up to the age of the last dump. The schedule says 24 h; GitHub's scheduler actually delivers late and unevenly — across 127 runs only 12 started in the 02:00 UTC hour and the worst observed gap between dumps was **33 h**. Plan for **up to 36 h** | **45–90 min** (the monthly drill publishes the measured number) |
| Total loss of Neon | **C — rebuild on another Postgres** | As B | **Half a day**, dominated by provisioning and re-pointing, not by the restore |

**Photographs have no recovery path at all.** A database restore brings back `Attachment` rows pointing at objects in `nmwc-photos`. If those objects are gone, the rows are dangling and the CR documents behind credit decisions are gone with them. This is an accepted risk today, not a solved problem. §6.13 is the owner action that closes the *overwrite and delete* half of it — and only that half: versioning keeps old bytes in the same bucket in the same account, so it survives a mistake and does not survive losing the bucket or the account.

### 6.3 What a restore does not bring back

`pg_dump` carries tables, data, indexes, constraints, triggers, functions and the `_prisma_migrations` ledger. It does **not** carry:

1. **Roles or grants.** `--no-privileges` strips every GRANT and pg_dump never dumps roles, so a restored database has no `nmwc_app` and no REVOKEs — the least-privilege half of B4 is absent from every restore by construction. Re-create it (step 4 of each runbook below).
2. **Photographs** — see above.
3. **Configuration.** Before a restored database can serve the application, all of this must also exist: `DATABASE_URL` (the `nmwc_app` pooled URL), `DIRECT_URL` (owner), `AUTH_SECRET` + `NEXTAUTH_SECRET` (rotating these logs everyone out), `CRON_SECRET`, `HEALTH_BEARER`, the four `R2_*` variables, the Sentry DSN, and the working-hours and SLA variables. `.env.example` is the checklist.

### 6.4 Runbook A — Neon point-in-time recovery

Use when the damage is recent and the database itself is healthy.

1. **Stop the bleeding.** If an import is running, abort it. There is no maintenance mode and no way to tell 106 field users to stop — see §6.8.
2. In the Neon console, create a branch from production **at a timestamp before the damage**. Neon branches are copy-on-write, so this is instant and costs storage only.
3. Point a psql session at the new branch and sanity-check the data you expected to recover.
4. Re-create the runtime role on it: `ALLOW_PRODUCTION=1 DIRECT_URL='<branch owner URL>' NMWC_APP_PASSWORD='<new>' npx tsx scripts/ops/app-role.ts create` then `grant`, then `verify` with `NMWC_APP_URL`.
5. Verify the restore properly: `npx tsx scripts/ops/restore-verify.ts --url '<branch owner URL>' --expect-app-role`.
6. Promote the branch to the primary in the Neon console, or repoint Vercel Production `DATABASE_URL` / `DIRECT_URL` at it and redeploy.
7. **Revoke sessions.** Set `sessionsRevokedAt = now()` on every user, or rotate `AUTH_SECRET`; otherwise a JWT issued before the restore still authenticates against the restored user table.
8. Confirm: `curl -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health` — `checks.db: ok` and no cron alarms.

### 6.5 Runbook B — restore the nightly dump into a new Neon branch

Use when the damage predates the PITR window, or PITR cannot reach a good state.

1. Steps 1 from Runbook A.
2. Create a Neon branch. **It arrives as a copy of production** — Neon has no empty-branch primitive — so empty it first: `psql "$URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'` and confirm `0` tables before loading anything. (Check twice that the URL is the branch, not production.)
3. Fetch the newest dump and its manifest from `nmwc-backups`, decrypt with the age identity, and load with `psql -v ON_ERROR_STOP=1 --echo-errors`, keeping the log.
4. Re-create the runtime role (Runbook A step 4).
5. `npx tsx scripts/ops/restore-verify.ts --url '<branch owner URL>' --manifest manifest.json --expect-app-role`. This is the step that catches the dangerous failure: pg_dump writes triggers **after** the data, so a truncated restore comes back with every customer row present and the append-only audit triggers missing.
6. Steps 6–8 from Runbook A.

The monthly drill (`.github/workflows/restore-drill.yml`) performs exactly steps 2–5 against a throw-away branch and publishes the timings. Run it on demand before you ever need it for real: **Actions → Restore drill → Run workflow**.

### 6.6 Runbook C — total provider loss

1. Provision PostgreSQL 17 anywhere, with the `pg_trgm` extension available.
2. Runbook B steps 3–5 against it.
3. Repoint Vercel Production at the new host and redeploy. The build runs `prisma migrate deploy`, which will be a no-op on a correctly restored database.
4. Runbook A steps 7–8.
5. Photographs: if R2 is also gone, they are gone. Record what was lost.

### 6.7 Backup encryption and key escrow

Dumps are encrypted with [age](https://age-encryption.org) to the public keys in the repository variable `BACKUP_AGE_RECIPIENTS` (comma-separated; public keys are not secrets). The private key decrypts every backup.

**If the private key is lost, every backup is unrecoverable.** Encryption introduces this failure mode; the escrow below is what makes it acceptable.

Setup, once:

```bash
age-keygen -o nmwc-backup.key          # prints the public key (age1…) to stderr
```

Then:
1. Put the **public** key in repository variable `BACKUP_AGE_RECIPIENTS`. Add a **second** recipient held by a different person, so one lost laptop is not the end of the backups.
2. Store the **private** key in at least two places that do not fail together: the company password manager, and printed on paper in a safe. Never in the repository, never in an e-mail.
3. Put a copy in the repository secret `BACKUP_AGE_IDENTITY` so the monthly drill can decrypt.
4. Delete the local file.

**The monthly drill is also the key test.** If it fails to decrypt, the backups are already unrecoverable and the clock started at the last successful drill. Treat a decryption failure as a P1 incident, not a workflow annoyance.

Until `BACKUP_AGE_RECIPIENTS` is set the nightly workflow **fails** at its encrypt step and uploads nothing. It used to warn and upload anyway, inside a run that stayed green; since the checklist the owner is told to follow did not name this variable (DO-16), the likely outcome was a nightly plaintext copy of the complete customer master and every password hash that nobody noticed. Failing is the louder signal, and the fix takes a minute. If you genuinely need one plaintext run, set the repository variable `ALLOW_PLAINTEXT_BACKUP` to exactly `true`, take the run, and unset it — every path that honours it also writes a line into the run summary saying the dump is not encrypted.

### 6.8 What can still go wrong, and is not fixed

- **Bus factor of one.** Every recovery step needs credentials one person holds. There is no named alternate and no stated authority to declare a disaster.
- **Maintenance mode** (REL-02, added 2026-09-15): set Vercel Production `MAINTENANCE_MODE=on` and `MAINTENANCE_BYPASS_TOKEN=<a long random string>`, then **redeploy** — environment variables are read at instance start, so the switch does not take effect without one. Everyone then sees a bilingual 503 that says nothing was lost; `/api/health`, the cron routes, `/api/ops/` and `/api/auth/` stay open so the probe, the heartbeats and an operator sign-in keep working. To work on the app yourself, set the cookie `nmwc_maintenance_bypass` to the token value. Unset the variable and redeploy when done. **The redeploy requirement is the limitation:** in a genuine emergency the faster lever is pausing the deployment in Vercel.
- **No maintenance mode.** Nothing can stop 106 field users writing during a recovery, and there is no channel to tell them.
- **The dead man lives inside the thing it watches.** The `db-backup` heartbeat is a row in the production database. If that database is unreachable the bearer health probe reports `checks.db: fail` and answers 503 — so an outage still alarms — but the backup-specific alarm is silent in exactly that case.
- **`PROD_CRON_SECRET` may be stale.** The backup reports its outcome using that repository secret; the route validates against `CRON_SECRET` in Vercel. If they have drifted the POST returns 401, the workflow warns, and the heartbeat goes stale. Check both after any secret rotation.
- **Rotating `neondb_owner` breaks the backup** unless the GitHub `DIRECT_URL` secret is updated in the same change. Since 2026-09-14 that failure alarms within 40 hours instead of silently; it is still a manual pairing.

### 6.9 Retention of the backups themselves

30 days, enforced by an R2 lifecycle rule on `nmwc-backups` under prefix `db/`. That rule is now set and verified from code rather than being a dashboard task nobody confirmed:

```bash
npx tsx scripts/ops/r2-backups-lifecycle.ts           # apply
npx tsx scripts/ops/r2-backups-lifecycle.ts --check   # verify, exit 1 if wrong
```

Needs an R2 token with **Admin Read & Write** (`BACKUP_R2_ADMIN_*` or the account-wide `R2_ADMIN_*` pair); the object-scoped token the backup uses cannot configure a bucket.

Each run writes to its own timestamped key, so a second run on the same day adds an object instead of overwriting the good nightly dump.

### 6.10 Proving all of this

| Claim | Proven by | When |
|---|---|---|
| The dump/encrypt/restore/verify chain works | `restore-chain` job in CI | every push |
| The real production dump restores and is complete | `.github/workflows/restore-drill.yml` | monthly + on demand |
| A restored database refuses audit tampering | `restore-verify.ts` assertion F-01 | both of the above |
| A backup actually happened last night | `db-backup` heartbeat on bearer `/api/health` | continuously |
| Dumps are expired after 30 days | `r2-backups-lifecycle.ts --check`, in `.github/workflows/r2-config.yml` | daily |
| Photo versioning is still on, with a 30-day non-current retention | `r2-photos-versioning.ts --check`, in `.github/workflows/r2-config.yml` | daily |

The bottom two rows read "on demand" until 2026-09-24, and on demand meant never: `r2-backups-lifecycle.ts --check` had been citable as evidence in four documents since 2026-09-14 and no workflow had ever called it.

**Those two live in a workflow of their own, and that is not cosmetic.** GitHub reports success or failure per *workflow*, not per job, and this check is red until the owner mints the admin tokens (§6.13). Sitting as a second job inside `db-backup.yml` it would have camouflaged a failed backup — a red **DB Backup** run is the alarm that caught seven missing nights this month — and it would have disarmed the `ALLOW_PLAINTEXT_BACKUP` guard, whose entire mechanism is that run turning red. So: a red **DB Backup** always means last night's dump, and a red **R2 bucket settings** always means a bucket setting. Neither can hide the other.

### 6.11 Other backup notes

- **Manual logical dump:** `npx prisma db pull` exports the schema; for data, `pg_dump` against `DIRECT_URL`.
- **Required GitHub secrets:** `DIRECT_URL`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `PROD_CRON_SECRET`. For the drill also `NEON_API_KEY`, `NEON_PROJECT_ID`, `BACKUP_AGE_IDENTITY` (§6.12). For the daily **R2 bucket settings** workflow also **two** Admin Read & Write R2 tokens, one per bucket and neither of them account-wide — `BACKUP_R2_ADMIN_ACCESS_KEY_ID` + `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY` scoped to `nmwc-backups`, and `R2_ADMIN_ACCESS_KEY_ID` + `R2_ADMIN_SECRET_ACCESS_KEY` scoped to `nmwc-photos`; add `R2_ACCOUNT_ID` only if the photographs live in a different Cloudflare account from the backups (§6.13). Repository variables: `BACKUP_AGE_RECIPIENTS`, optionally `PROD_DB_HOST_MARKER`, `MIN_DUMP_BYTES` and `R2_BUCKET`.
- **Two admin tokens, not one.** An admin token is the strongest credential a bucket has. One token covering both buckets would mean a leaked photographs credential also reaches every database dump — undoing the separation this whole design rests on, stated in `.github/workflows/db-backup.yml` and again under "R2 backup & versioning" below. `npm run ops:print-secrets` names all four.
- **`PROD_DB_HOST_MARKER` is not optional for the drill.** It is the only interlock in front of the drill's `DROP SCHEMA public CASCADE`, and the drill refuses to start without it. Optional only for the nightly dump, which merely warns.

### 6.12 Turning the restore drill on (owner: Neon console)

`.github/workflows/restore-drill.yml` has **never run**. `gh run list --workflow=restore-drill.yml` returns nothing.

Two things are true about that and only one of them is a fault. The schedule is `0 4 1 * *` and the workflow landed on `main` in mid-September, so the first *scheduled* run is 1 October — no runs yet is arithmetic, not breakage. But it also **cannot** run: `NEON_API_KEY` and `NEON_PROJECT_ID` do not exist, and the preflight step refuses rather than skipping, which is what you will see if you dispatch it by hand today. Everything else it needs is already there: secrets `BACKUP_AGE_IDENTITY`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `DIRECT_URL`, `PROD_CRON_SECRET`, and variables `BACKUP_AGE_RECIPIENTS`, `PROD_DB_HOST_MARKER`.

**1. `NEON_PROJECT_ID`.** Neon console → open this project → **Settings → General** → *Project ID* (a string in the shape `cool-forest-12345678`). It is also the `projects/<id>` segment of the console URL. Add it at GitHub → Settings → Secrets and variables → Actions → Secrets → *New repository secret*.

**2. `NEON_API_KEY`.** Neon console → your avatar (top right) → **Account settings → API keys** → *Create new API key*. The value is displayed once; copy it straight into the GitHub secret.

**3. Scope — read this before you create the key.** Neon API keys are not permission-scoped the way an R2 token is. A key that can create a branch can also delete one, and a *personal* key reaches every project your Neon account can see. If your account is on an organization plan, create the key from the **organization's** API keys page and scope it to this project; that is the narrowest thing Neon offers, and it is still a production-destructive credential. The drill calls exactly two endpoints — `POST /projects/{id}/branches` and `DELETE /projects/{id}/branches/{id}` — so nothing is gained by giving it more. Rotate it if the repository's secrets are ever in doubt.

**4. Run it.** Actions → **Restore drill** → *Run workflow* → branch `main`, leave *object key* empty so it takes the newest dump. Expect 10–20 minutes.

**5. Confirm it really restored.** The green tick is not the evidence — the old drill was green 127 times without restoring anything. These four lines are the evidence, and all four must be there:

| Step | The line that proves it | If it is absent |
|---|---|---|
| Empty the branch, and prove it is empty | `target is empty (0 tables) — the restore starts from nothing` | The restore loaded into a clone of production and proved nothing. This is the exact hole the old drill had. |
| Restore | `restore finished with 0 error line(s)` | DDL or data was skipped. |
| Verify the restored database | `✓ restore verified — N passed, 0 failed`, with `M-01 … tables match` and `F-01 … UPDATE refused by the trigger` | `M-01 skip` means no manifest was found beside the dump, so **row loss was not checked** — the run is weaker than it looks. `F-01` failing means the append-only audit guard did not survive. |
| Delete the drill branch | `delete branch … → HTTP 200` | A Neon branch holding a full live copy of customer personal data is still there. Delete it by hand, now. |

Then: download the `restore-drill-<run id>` artifact and grep `restore-verify.json` for `"status": "fail"` — there must be none — and check the Neon console's Branches list is free of `restore-drill-*`. Finally put the run's **Measured recovery time** into the RTO column of §6.2, replacing the estimate, and note the date.

**What a false pass would look like**, so you can recognise one: `M-01` reported as `skip`, or the "0 tables" line missing. Neither fails the run on its own.

### 6.13 Photographs — bucket versioning (owner: Cloudflare dashboard)

§6.1 and §6.2 say the photographs have no recovery path. The chosen answer is **R2 object versioning on `nmwc-photos` plus a 30-day non-current-version retention**. It is a dashboard setting; there is no code that can turn it on, so this section is the whole of the work.

**Be clear what it buys.** Versioning keeps the previous bytes when an object is overwritten or deleted, in the **same bucket in the same Cloudflare account**. So it covers an overwrite, an accidental delete, and a faulty `photo-gc` run — the three ways photographs have actually been at risk here. It does **not** survive the bucket being deleted, the Cloudflare account being deleted or suspended, or Cloudflare losing the data. After this is done, §6.1 still reads "one copy": this is not a backup, it is an undo.

**0. Order of work, because one of our own scripts will delete what you are about to create.** `npm run ops:r2-setup` (`scripts/r2-setup-lifecycle.ts`, §5b C) calls `PutBucketLifecycleConfiguration`, which **replaces the bucket's entire lifecycle configuration** with the two rules hard-coded inside it. `noncurrent-versions-30d` is not one of them, so running it after step 2 silently deletes the rule this section exists to create, and the photographs quietly stop being protected.

| | |
|---|---|
| **If `gc-marked-7d` is already on the bucket** (it is, in production) | Do not run `npm run ops:r2-setup` again, at all. Add every further rule in the dashboard, which touches only the rule you are editing. |
| **If you are setting up a fresh bucket** | Run `npm run ops:r2-setup` **first**, then do steps 1–2 here. Never the other way round. |
| **If someone runs it by mistake anyway** | The daily check goes red the next morning with `no rule expires non-current versions`. Redo step 2. Versions created before the rule was deleted are unaffected — only the expiry is gone — so this is recoverable, which is exactly why the check has to exist rather than be trusted. |

Nothing runs `ops:r2-setup` on a schedule; it is only ever a person at a terminal.

**1. Turn versioning on.** Cloudflare dashboard → **R2** → bucket **`nmwc-photos`** → **Settings** → *Object versioning* → enable. Versioning only protects writes that happen **after** it is on; nothing already overwritten comes back.

**2. Add the non-current-version retention.** Same Settings page → *Object lifecycle rules* → add a rule named `noncurrent-versions-30d` whose action deletes previous / non-current versions after **30 days**. The label for that action has changed wording at least once on Cloudflare's side; it is the one about *previous* or *non-current* versions, not the one that expires objects.

Two things about that rule, both of which the checker treats as findings:

- **It must apply to the whole bucket.** No prefix, no tag filter, no object-size filter, and not a combination of those. A rule narrowed any of those ways leaves every photograph outside it keeping versions forever, and leaves the ones the rule does cover as the only ones protected — the opposite of the intent. (Note that `gc-marked-7d` *is* tag-scoped; that is correct for what it does, and it is not this rule.)
- **Do not also cap the number of versions kept.** If the dashboard offers "keep the newest N versions" beside the day count, leave it empty. With a cap of 2, a version is expired as soon as two newer ones exist — re-photograph a CR document three times in an afternoon and the original is gone the same afternoon, while the rule still reads "30 days".

Why 30 and not 7: a recovery can restore a database dump up to 30 days old (§6.9), and its `Attachment` rows point at photo objects. A photo version that expires sooner than the oldest restorable dump re-opens the exact gap this is being switched on to close. Longer than 30 keeps personal data past `docs/compliance/DATA-RETENTION-SCHEDULE.md`. The checker treats **either** direction as a finding.

**3. Know what this does to the `gc-marked-7d` rule.** On a versioned bucket, expiring a *current* version writes a delete marker and keeps the bytes as a non-current version. So `photo-gc`'s 7-day window becomes "hidden after 7 days, bytes gone 30 days later". The behaviour the app shows is unchanged; the retention schedule's sentence for photographs is not, and `docs/compliance/DATA-RETENTION-SCHEDULE.md` should be updated to say so.

**4. Let the daily check see it — with one token per bucket.** Neither setting can be read with an object-scoped token, so this needs Admin Read & Write. Mint **two** tokens at *R2 → API tokens*, each one "Apply to specific buckets only":

| Token scoped to | Repository secrets |
|---|---|
| `nmwc-photos` | `R2_ADMIN_ACCESS_KEY_ID`, `R2_ADMIN_SECRET_ACCESS_KEY` |
| `nmwc-backups` | `BACKUP_R2_ADMIN_ACCESS_KEY_ID`, `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY` |

Add `R2_ACCOUNT_ID` as well only if the photographs are in a different Cloudflare account from `nmwc-backups`.

**Do not mint one account-wide token for both.** It is two extra minutes of clicking and it is the difference between a leaked photographs credential exposing the photographs and it exposing every database dump — the separation `.github/workflows/db-backup.yml` and "R2 backup & versioning" below are both built on, and the reason the *upload* tokens were already split. `npm run ops:print-secrets` lists all four and will tell you which are missing.

**Until they exist, `.github/workflows/r2-config.yml` ("R2 bucket settings") fails every day, on both checks.** That is deliberate: a check that reports "skipped" is how the old restore drill stayed green 127 times. It is also its own workflow rather than a job inside `db-backup.yml`, so that this daily red cannot camouflage a failed backup or silence the `ALLOW_PLAINTEXT_BACKUP` guard — see §6.10.

**5. Confirm it took.**

```bash
R2_ACCOUNT_ID=… R2_ADMIN_ACCESS_KEY_ID=… R2_ADMIN_SECRET_ACCESS_KEY=… \
  npx tsx scripts/ops/r2-photos-versioning.ts --check
```

Two ✓ lines and exit 0. It has no apply mode on purpose, and step 0 is why: `PutBucketLifecycleConfiguration` replaces a bucket's *whole* lifecycle configuration, so a script that wrote only the non-current rule would silently delete `gc-marked-7d` — the only thing that ever removes the objects `photo-gc` tags instead of deleting (B-02). It is a checker precisely so that it cannot be the thing that breaks the bucket. If it reports `NotImplemented`, R2 will not answer the versioning query on this bucket; that is reported as a **failure**, because unverified is not verified. Confirm in the dashboard and record the date here.

### R2 backup & versioning

Two independent buckets, each with its own lifecycle policy. Both are verified daily by `.github/workflows/r2-config.yml` ("R2 bucket settings") — its own workflow, so that its red cannot be mistaken for, or hide, a failed backup (§6.10).

**`nmwc-photos` (production photo storage)** — configure once:

1. **Lifecycle rule — `gc-marked` expiry:** condition object tag `gc-marked=true`, action expire 7 days after the tag is applied. `app/api/cron/photo-gc/route.ts` tags rather than deletes (B-02), so without this rule tagged objects accumulate forever, and with it there is a 7-day window to recover from a faulty GC run. Add it **in the dashboard** (§5b C, Option B). `scripts/r2-setup-lifecycle.ts` also writes it, but that call REPLACES the bucket's whole lifecycle configuration and would delete the non-current-version rule in §6.13 — so it is safe only on a bucket that has no other rules yet. §6.13 step 0 has the ordering.
2. **Object versioning and a 30-day non-current-version retention** — the owner action in §6.13, verified by `scripts/ops/r2-photos-versioning.ts --check`. `scripts/r2-setup-lifecycle.ts` also *attempts* versioning, and R2 answered `NotImplemented`; do it in the dashboard.

**`nmwc-backups`** — see §6.9. Separate credentials from the photos bucket, so a leak of one does not expose the other. That holds for the **admin** tokens the daily check uses as much as for the upload tokens: one per bucket, neither account-wide (§6.13 step 4).

## 7. Common operations

### Reset password for a user
1. Sign in as Manager.
2. `/users` → row → "Reset password" → set new value.

The rotation is audit-logged.

### Disable a leaving salesman
`/users` → row → "Disable". Their account stays in audit history but they cannot sign in. To later reassign their route, edit the route from `/routes` and pick a new owner.

### Re-import the master after a bulk fix
1. Sign in as Steward.
2. `/import` → upload xlsx → review batch → Promote.
3. Existing customers (matching by `cust_code`) are upserted.

### Export the cleaned master for ERP
1. Sign in as Steward (or Manager).
2. `/export` → choose filters → **Download .xlsx**.
3. The workbook is a report, **not an import file**: `sales_region` and `channel` are the
   region name and channel label (the importer expects the code and the key), and
   `customer_status` would be applied to every branch. Re-uploading it can reopen closed
   branches. For bulk fixes, start from the import template (found 2026-09-25, item 28;
   making it round-trip is an open owner decision).

### Requeue customers the ERP was never told about (one-off, 2026-09-23)

A customer whose `temixSyncState` is `SYNCED` while `temixCode` is null is claiming Temix already knows it, and nothing re-examines that claim: the upload queue selects only `PENDING_UPLOAD` and `DEACTIVATE_PENDING`, so the row never enters a batch, never shows on `/temix`, and the ERP never learns it exists — it cannot be invoiced, however complete it looks in the CRM. The May pilot seed left several thousand rows in that state; the importer has handled it correctly for rows it creates since. `npm run verify:load` fails on exactly this ("customers with no Temix code are queued for upload"). To fix it, **dry run first** — the script writes nothing without `--apply`, and `--expect-host` is required either way, because a dry run against the wrong database reports "nothing to do" and reads as "already fixed":

```bash
npm run smoke                       # before any production change — fourteen checks, ~15s
DIRECT_URL='<owner connection>' npm run ops:requeue-untracked -- --expect-host ep-sweet-haze
# read the counts, then:
DIRECT_URL='<owner connection>' npm run ops:requeue-untracked -- --expect-host ep-sweet-haze --apply
npm run smoke                       # and after
npm run verify:load
```

`npm run smoke` on both sides is not optional — it is the standing rule for any production change, it needs no credentials, and each of its fourteen checks is something that has already been wrong here (including production serving a four-month-old build for weeks). Run it before, so a regression that was already there is not blamed on this; run it after, so one caused by this is caught while the operator is still at the keyboard.

The dry run resolves everything `--apply` needs, including the audit actor, so anything the apply would refuse is refused in the rehearsal instead. If it reports more than one active Steward, pass `--actor <username>`; the script refuses a username that is not an active Steward, or one on the demo denylist (`lib/demo-accounts.ts`) — rename the account rather than relaxing the list.

It flips only live, code-less, `SYNCED` rows to `PENDING_UPLOAD`, a few hundred per statement so it cannot hold a long lock over the WAN link, and it is re-runnable — a second run finds nothing and says so. It refuses outright if the resulting queue would exceed the 5,000-customer batch cap in `services/temix.ts`, because a queue over the cap means the Steward can generate **no** batch at all, including the one that would drain it; drain the existing queue first and re-run.

**If `/temix` cannot generate the batch afterwards, requeue in tranches with `--limit`.** The cap the script refuses on is not the only ceiling. `generateTemixBatchCore()` snapshots the entire queue inside one interactive transaction budgeted at 30 seconds, and that budget cannot be raised past the 60 seconds Vercel allows the function — so a queue can be legal under the 5,000-customer cap and still be too large to snapshot in time. A timeout there rolls back untouched and leaves the queue exactly as it was, so it costs nothing to find out; but `/temix` has no un-queue action and the script's predicate stops matching a row the moment it is requeued, so without `--limit` there is no way to make the queue smaller again. Run `--limit 1000 --apply`, have the Steward generate and load that batch, then run it again for the next tranche. The counts and the workbook estimate the script prints describe the tranche it is actually going to touch, not the whole backlog, and it tells you how many it is leaving behind.

Two `AuditLog` rows per applied run (`entityType = TemixRequeue`), sharing one `entityId` — the run's `temixSyncPendingSince`: a STARTING row written before the first chunk and a COMPLETED row after the last. The chunks each commit on their own, so **a STARTING row with no COMPLETED row beside it means the run was interrupted**: the rows it did change all carry that `temixSyncPendingSince`, which is how you count them and how you put them back. The run also prints a block to paste into the go-live log. Afterwards, have the Steward generate the batch from `/temix`.

### Work out WHICH branches are missing a visit day

`verify:load`'s visit-day check compares two totals — how many branches carry a day against how many `load-manifest.json` says the master supplied. It never reads the master, so **it cannot name a single row**, and it deliberately no longer tries to: it lists the mechanisms that withhold a day as leads and stops there. Twice in one day it asserted a cause from that number and was wrong both times — first blaming the Temix refresh lane for a gap that was 95% rejected rows, then blaming the rejections for a gap that turned out to be a quarantine.

To attribute it, join the master to production per customer:

1. Read `golive-data/customer-master.xlsx`, and for each `cust_code` count the rows whose `day_of_visit` is non-blank. Do **not** join on `branch_code` — 18,184 of the 20,199 rows have a blank one, because the importer derives it.
2. Query production for the same customers and count their live branches carrying a `dayOfVisit`.
3. The customers where production is short are the answer. For each, look at the import rows: a REJECTED row wrote nothing at all, a QUARANTINED row was held for review and never promoted, and a customer that already carries a `temixCode` may have taken the refresh lane, which skips the branch loop.

On 2026-09-24 that produced: 47 customers short, **all 47** with a quarantined row, every quarantine being `phone already exists in master`. The fix was `npm run ops:visit-days` (below), not a code change.

### Land a visit day that a quarantine held back

```bash
DIRECT_URL='<owner connection>' npm run ops:visit-days -- --expect-host ep-sweet-haze
# read the counts, then:
DIRECT_URL='<owner connection>' npm run ops:visit-days -- --expect-host ep-sweet-haze --apply
npm run smoke && npm run verify:load
```

A quarantined row is never promoted, so its branch never receives the journey plan's `dayOfVisit`. This writes that day onto the branch that already exists — exactly what the promote would have written. It does **not** merge customers, clear the quarantine or resolve the duplicate; those stay in `/duplicates` for a Steward, because merging two customer records needs a human to say which one survives.

It applies a row only when the customer has exactly one live branch of that name and that branch has no day recorded. Anything ambiguous is skipped and reported — writing the wrong branch's visit day sends a salesman to the wrong shop on the wrong morning.

### Spot a duplicate in the live master
1. Sign in as Steward.
2. `/duplicates` → review pairs (PHONE matches first, then CR, then fuzzy NAME).
3. Click "Keep ←" / "Keep →" to merge; loser is soft-deleted, branches reassigned, AuditLog written.

### Reactivate a closed shop
1. Salesman: from a closed customer's profile, submit reactivation with a fresh photo.
2. Manager: `/reactivations` → review with photo evidence → Approve or Keep closed.

## 8. Incident playbook

### Symptom: `/api/health` (bearer) shows a cron job `stale` / `never` / `failed`

`never` after a deploy: the job has not run yet — check the scheduler (GitHub Actions → the workflow's recent runs, or the external scheduler's log). `stale`: the scheduler stopped calling — GitHub disables schedules on inactive public repos and throttles them generally; re-trigger the workflow by hand and consider option (a)/(b) in §5d. `failed`: open `cron.jobs[].lastError` in the payload; the SLA sweep also logs `cron.sla.row_failed` per row in Vercel logs.

## 5e. Opening an audit-maintenance window (owner only)

The append-only trigger has exactly one override: a transaction that runs
`SET LOCAL nmwc.audit_maintenance = 'on'` **from a session logged in as the table
owner**. The application role cannot use it at all. Because the record of such an
edit would have to live in the table being edited, the accountability for it is
procedural, and this is the procedure:

1. **Write down why, before you open it.** Add a dated entry to
   `docs/compliance/maintenance-log.md` (create it on first use): who authorised
   it, what is being changed, which rows, and under what request.
2. Take a fresh dump first — `Actions → DB Backup → Run workflow` — so the
   pre-edit state is preserved off-Neon.
3. Do the narrowest possible change inside one transaction, as the owner
   (`DIRECT_URL`), and never as part of a script that also does other work.
4. Record the row counts before and after in the same log entry.

Legitimate uses so far: test-fixture clean-up on isolated branches
(`tests/support/audit.ts`) and the synthetic-data wipe scripts. An erasure
request is **not** yet a legitimate use — see `docs/compliance/PDPL-ASSESSMENT.md`
Q4, which is open with counsel.

### Symptom: a script fails with `B4: DELETE on "AuditLog" is forbidden`

Expected: the audit tables are append-only. If the deletion is legitimate maintenance (isolated branch clean-up), run it inside a transaction that starts with `SET LOCAL nmwc.audit_maintenance = 'on'` using the owner credential (`DIRECT_URL`). The application role cannot do this at all — do not try to work around it from the app.

### Symptom: `/api/health` returns degraded
Since B5 (2026-09-14) the public `/api/health` itself answers **503 `{ "status": "degraded" }` when the database is unreachable** — so a 503 seen by a plain uptime check or `curl -f` IS the database, not the CDN. It says nothing else (B-12). For the detail, hit it with `Authorization: Bearer $HEALTH_BEARER`:
```bash
curl -fsSL -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq
```
- `db: fail` → Neon project may be sleeping (free tier auto-suspends). Hit any page; first load wakes it. If persistent: check Neon console.
- `r2: fail` → check R2 bucket exists and the API token isn't revoked. Test: `curl -X HEAD https://<account>.r2.cloudflarestorage.com/nmwc-photos -H "Authorization: ..."`.

### Symptom: Sign-in 500s
- Check Sentry for the actual error.
- Most common: `NEXTAUTH_SECRET`/`AUTH_SECRET` mismatch between env vars and the cookies in clients.
- Force fix: rotate the secret in Vercel → redeploy → users get logged out and need to sign in again.

### Symptom: Photo upload fails at "Upload failed"
- The presigned PUT URL expires after 10 minutes. If the user's clock is off or upload is very slow: tell them to retake.
- Check Vercel logs for the presign route — usually it's an R2 token issue.

### Symptom: Salesman cannot see a customer
- Verify the customer has a branch on the salesman's `ownedRouteId` (Manager can check from `/users`).
- If the customer is multi-route, only branches on his route show up; he should still be able to open the customer profile.

## 9. Live pilot credentials + the shared-password trade-off (read this)

**As of 2026-05-11**, all live pilot accounts share two simple passwords —
this is an explicit operational trade-off the owner accepted for the
Muscat field team's ease of use. Anyone who knows a username can log in
as that user. **Rotate before any expansion beyond the Muscat pilot.**

| Role | Username | Password |
|---|---|---|
| MANAGER    | `pilot.manager` | `[REDACTED-PILOT-PW]` |
| STEWARD    | `pilot.steward` | `[REDACTED-PILOT-PW]` |
| SUPERVISOR | `ahmed.alndabi` | `[REDACTED-PILOT-PW]` |
| SALESMAN (×10) | `<route-lowercase>-nmwc` (e.g. `c1-nmwc`, `mh02-nmwc`) | `[REDACTED-PILOT-PW]` |

`mustChangePassword = false` on every account — users will NOT be forced
to rotate on first login. Full breakdown + rotate procedure in
`docs/PILOT-MUSCAT-CREDENTIALS.md`. To rotate later:

```bash
# Edit the two password constants at the top of the script, then:
npx tsx scripts/bulk-reset-credentials.ts
```

The script is idempotent and writes one summary AuditLog row per run.

### Demo / legacy accounts (disabled)

Bulk-reset disabled the following 13 leftover accounts — they cannot log
in, but their audit history is preserved: `admin`, `manager.a`,
`manager.b`, `steward`, `supervisor.1`..`supervisor.7`, `test.mustchange`,
`viewer`.

Synthetic test data is regenerated by `npm run db:synthetic:reset` for
development environments only — DO NOT run against production.

## 10. Things to do before real pilot

- [ ] Replace `admin / ChangeMeNow!2026` password.
- [ ] Run real Account master import (all real users, real regions, real routes).
- [ ] Run real Customer master import (current ERP export).
- [ ] Verify each Manager has the right regions assigned.
- [ ] Verify each Salesman has the right route.
- [ ] Tell salesmen to enable "Use my location" in their browser when prompted.
- [ ] Train Supervisor on the approval queue (5 minutes).
- [ ] Pilot with 2 routes for a week before full rollout.
- [ ] Watch Sentry for unhandled errors; watch Manager dashboard for stale approvals.

## 11. Stack snapshot (current)

- Next.js 15 (App Router) on Vercel, Node 24
- React 19 + TypeScript strict mode
- Tailwind 3 + shadcn-style primitives + lucide-react icons
- PostgreSQL on Neon (Launch plan), Prisma 6, JWT sessions via Auth.js v5
- Cloudflare R2 + AWS SDK v3 S3 client, presigned uploads
- pino structured logging with PII redaction, Sentry error tracking
- exceljs for import/export
- @faker-js/faker for synthetic data
- Vitest + Playwright for tests
