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

- **Migrations ARE applied by the Vercel build.** `package.json` `build` runs `prisma generate && prisma migrate deploy && next build`, so any migration on the deployed commit is applied to the database in `DIRECT_URL` as part of the deploy. (This line previously said the opposite; it was wrong, and it matters — a rollback of the application does not roll back the schema, and a restore followed by a deploy will re-apply migrations.)

## 5b. First-time post-deploy operator checklist

Run these once after the senior-audit remediation deploy. Each item is needed by a senior-audit blocker; none auto-resolve themselves.

### A. Reconnect Vercel ↔ GitHub auto-deploy (op note 1)
The CLI cannot toggle this on its own. Do it via UI:
1. Open https://vercel.com/rahmanmansoori244-6893s-projects/nmwc-cm/settings/git
2. Under "Connected Git Repository", click "Connect" and select `rahmanmansoori244-droid/NMWC-CRM` on `main`.
3. Confirm in https://github.com/rahmanmansoori244-droid/NMWC-CRM/settings/installations that the Vercel app is installed.
4. From now on, every `git push origin main` triggers a Vercel build automatically. Until then, the deploy must be done manually with `npx vercel --prod`.

### B. Configure GitHub Actions secrets for the daily DB backup (op note 2)
The workflow `.github/workflows/db-backup.yml` will fail at the upload step until these secrets exist.
1. Run `npm run ops:print-secrets` locally — it lists exactly which secret names are needed and shows which values are already present in your `.env`.
2. Create a separate R2 bucket `nmwc-backups` (Cloudflare → R2 → "Create bucket"). Keep it separate from `nmwc-photos` so a leaked photo token cannot also touch the backups.
3. Create an R2 API token scoped only to that bucket: Cloudflare → R2 → API tokens → "Create token" → permission "Object Read & Write" → restrict to bucket `nmwc-backups`. Save the access key + secret immediately (R2 only shows the secret once).
4. At https://github.com/rahmanmansoori244-droid/NMWC-CRM/settings/secrets/actions, add: `DIRECT_URL`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET=nmwc-backups`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`. For the restore-drill job: also `NEON_API_KEY` (Neon console → Settings → API keys) and `NEON_PROJECT_ID=snowy-haze-29025382`.
5. Trigger a manual run: Actions tab → "DB Backup" → "Run workflow". Confirm green, then check the bucket has `db/<TODAY>.sql.gz`.

### C. R2 lifecycle rules for the photos bucket (op note 3)
Two options — **A is preferred for full automation; B is the fallback if you don't want to mint a new token.**

**Option A (recommended):** create a second R2 token with bucket-admin scope and let our script configure lifecycle rules end-to-end.
1. Cloudflare → R2 → API tokens → "Create token" → permission "Admin Read & Write" (scoped to the photos account).
2. Add the new key/secret to your local `.env` as `R2_ADMIN_ACCESS_KEY_ID` and `R2_ADMIN_SECRET_ACCESS_KEY` (separate from the existing `R2_ACCESS_KEY_ID` which is object-only and should stay untouched).
3. Run `npm run ops:r2-setup`. The script enables Object Versioning and writes the `gc-marked-7d` lifecycle rule + `incomplete-multipart-1d` rule. Re-run any time; idempotent.
4. The script will fall back to the regular R2 token if the admin key isn't set, so it's safe to run either way — it just prints a warning.

**Option B (manual UI):** Cloudflare R2 dashboard → bucket `nmwc-photos` → Settings → Lifecycle rules → Add rule:
- Tag filter: `gc-marked=true` → Expire 7 days after tag applied.
- Also add: Multipart upload abort after 1 day.
- Versioning toggle on the same Settings page.

### D. (Optional) Mint a dedicated R2 admin token to remove the warnings
Even if you finish steps A–C, the daily R2 setup script (`npm run ops:r2-setup`) will continue printing a warning about the photos token lacking bucket-admin scope. To silence it cleanly: follow Option A above and add the admin token vars to `.env`.

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

For each job: method **GET**, one custom header `Authorization: Bearer <CRON_SECRET>` — the same value as the `CRON_SECRET` variable in Vercel → Settings → Environment Variables → Production (copy it from there; never paste it into a support ticket or a screenshot). Enable the service's "notify on failure" so a run that answers 401/500/503 mails you. Photo GC stays on Vercel's own daily cron (`vercel.json`), which the Hobby plan does allow.

Afterwards, confirm within ten minutes:

```bash
curl -s -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq '.status, .cron'
```

`keep-warm` and `sla-escalate` should read `"state": "ok"` and the overall status `ok` (HTTP 200). Until the first run of each job the probe correctly answers 503 with `"state": "never"`.

The two GitHub Actions workflows (`.github/workflows/keep-warm.yml`, `sla-escalate.yml`) can be left enabled as a free backup — the sweep is idempotent and a duplicate keep-warm ping costs nothing. Note they use `curl -fsSL`, so with the B5 change they now go red when the endpoint answers 503, which is the intended signal.

**If you ever move to Vercel Pro instead**, delete the external jobs and add to `vercel.json` `crons`: `{"path": "/api/cron/keep-warm", "schedule": "*/4 3-14 * * *"}` and `{"path": "/api/cron/sla-escalate", "schedule": "15,45 3-14 * * *"}`. Vercel signs its own cron calls, so no header is needed.


## 6. Backups, recovery, and what they are actually worth

### 6.1 What exists

| Layer | Covers | Window | Where |
|---|---|---|---|
| Neon point-in-time recovery | The database, to any instant | 7 days | Same provider, same region as production |
| Nightly off-Neon dump | The database, as of the dump | 30 days of dumps | Cloudflare R2 `nmwc-backups` — **plaintext until the age key is set up** (§6.7); the workflow warns loudly on every run until then |
| **Nothing** | The photographs in `nmwc-photos` | — | Single copy |

The nightly dump is `.github/workflows/db-backup.yml`: `pg_dump --no-owner --no-privileges --format=plain --no-unlogged-table-data`, gzipped, age-encrypted, uploaded to `db/<timestamp>.sql.gz.age` with a row-count manifest beside it at `db/<timestamp>.manifest.json`.

### 6.2 Recovery objectives

These are measured, not aspirational. Two different RPOs apply and conflating them is the usual mistake.

| Scenario | Path | RPO — data you lose | RTO — time to serving again |
|---|---|---|---|
| Bad import, bad migration, or a destructive mistake, **within 7 days** | **A — Neon PITR** | Effectively **zero**: restore to the second before the damage | **15–30 min**, most of it deciding the timestamp |
| Damage older than 7 days, or a Neon-side logical problem | **B — restore the latest dump into a new Neon branch** | Up to the age of the last dump. The schedule says 24 h; GitHub's scheduler actually delivers late and unevenly — across 127 runs only 12 started in the 02:00 UTC hour and the worst observed gap between dumps was **33 h**. Plan for **up to 36 h** | **45–90 min** (the monthly drill publishes the measured number) |
| Total loss of Neon | **C — rebuild on another Postgres** | As B | **Half a day**, dominated by provisioning and re-pointing, not by the restore |

**Photographs have no recovery path at all.** A database restore brings back `Attachment` rows pointing at objects in `nmwc-photos`. If those objects are gone, the rows are dangling and the CR documents behind credit decisions are gone with them. This is an accepted risk today, not a solved problem.

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

Until `BACKUP_AGE_RECIPIENTS` is set the workflow still runs and emits a loud warning, and the uploaded dump is plaintext — a complete customer master and every password hash, unencrypted.

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
| Dumps are expired after 30 days | `r2-backups-lifecycle.ts --check` | on demand |

### 6.11 Other backup notes

- **Manual logical dump:** `npx prisma db pull` exports the schema; for data, `pg_dump` against `DIRECT_URL`.
- **Required GitHub secrets:** `DIRECT_URL`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `PROD_CRON_SECRET`. For the drill also `NEON_API_KEY`, `NEON_PROJECT_ID`, `BACKUP_AGE_IDENTITY`. Repository variables: `BACKUP_AGE_RECIPIENTS`, optionally `PROD_DB_HOST_MARKER` and `MIN_DUMP_BYTES`.

### R2 backup & versioning

Two independent buckets, each with its own lifecycle policy.

**`nmwc-photos` (production photo storage)** — configure once:

1. **Lifecycle rule — `gc-marked` expiry:** condition object tag `gc-marked=true`, action expire 7 days after the tag is applied. `app/api/cron/photo-gc/route.ts` tags rather than deletes (B-02), so without this rule tagged objects accumulate forever, and with it there is a 7-day window to recover from a faulty GC run. `npx tsx scripts/r2-setup-lifecycle.ts` sets it if your token has bucket-admin scope.
2. **Object versioning** if the bucket class supports it — the script attempts it and reports cleanly when R2 does not expose the API.

**`nmwc-backups`** — see §6.9. Separate credentials from the photos bucket, so a leak of one does not expose the other.

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
3. Workbook columns mirror the import shape so it round-trips.

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
