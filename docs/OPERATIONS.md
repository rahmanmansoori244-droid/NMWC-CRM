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
| Email | Notification e-mail only (F1, 2026-10-05): Gmail SMTP, `smtp.gmail.com:465`, from the owner's Gmail mailbox. Off until `NOTIFY_EMAIL_ENABLED=on` (section 5i). Resend, planned earlier, was not used. | The sending Google account (SECRETS-INVENTORY.md section 1) |

## 3. Environment variables (Vercel)

Production env vars are set in the Vercel project settings. To inspect/update via CLI:

```bash
export VERCEL_TOKEN=...   # personal access token, scope: rahmanmansoori244-6893's projects
npx vercel env ls
npx vercel env add SOME_VAR production
```

**The full list is [SECRETS-INVENTORY.md](SECRETS-INVENTORY.md) §2** — every variable the
application reads, which ones are secrets, what a leak exposes and which other place must
hold the same value. A test fails when the code reads a variable that list does not name.
This section used to keep its own list of eight; the code reads more than thirty, and the
missing ones included `CRON_SECRET`, `HEALTH_BEARER` and `ALERT_WEBHOOK_URL`.

**Every change to a `WORK_*` or `SLA_*` variable is a dated entry in the private
operations log** (the owner's handover pack, §5j and §5e; never in this repository): the
variable, its old and new value, who changed it, why, and the date it took effect (gap 37).
These set the working calendar and the step budgets every SLA deadline is computed on
(`lib/working-hours.ts`). Each request freezes its budgets with its chain when it is sent
(`lib/approval-chains.ts` `freezeChain`), and the calendar too once the object form is on
(`{ v, calendar, steps }`, §4 "The approval chain's stored form"), but deadlines are
computed on the calendar in force, so the log is what explains a deadline computed across
a change.

**An `SLA_*` value that is not a whole number of minutes refuses work.** The variables are
read with `Number(...)`, so `16h` or `16 hours` is not a number. `freezeChain` then refuses
every request whose chain has that step ("The approval deadline settings of this system are
not valid, so nothing was saved"; the log line `approval_chain.budget_invalid` names the
role), rather than storing a chain whose deadline means nothing. Correct the value, redeploy,
and log the change.

## 4. Deploy

Branch model: trunk (`main`). Every push to `main` is a deploy, and `main` moves only
to a commit whose CI is green (HANDOVER §2).

**Never deploy from a laptop.** This section used to recommend
`npx vercel --prod --yes` to "manually deploy the current local commit". That uploads
and builds whatever tree is checked out, committed or not, and the build runs
`prisma migrate deploy` before `next build` (§5) — so an old or unreviewed tree can
migrate the production database and then go live without CI having seen it.

**When production is broken, roll back, then fix forward through CI:**

1. `npm run smoke` and note what fails.
2. **Instant rollback.** Vercel → the `nmwc-cm` project → Deployments → the last
   production deployment known to be good → ⋯ → **Instant Rollback**. This re-points
   production at a build that already exists: nothing is uploaded, nothing is built,
   and no migration runs. `npm run smoke` again.
3. **Revert through a pull request.** `git revert` the bad change on a branch, open a PR, and
   let CI go green; the owner merges it as any other change. Its production deployment
   is the fix. **If the bad change contains a migration** (a directory under
   `prisma/migrations/`), a plain `git revert` deletes that migration and takes its
   change back out of `prisma/schema.prisma`, which turns the rollback into a migration
   revert. Keep both out of it: `git revert --no-commit`, then
   `git checkout HEAD -- prisma/schema.prisma prisma/migrations/<that migration>` before
   committing, and take the migration itself to the owner (below).
4. After an instant rollback, Vercel does not hand production to new deployments on its
   own. When the revert's deployment is ready, check that it is the one serving
   production, and **Promote** it if it is not. `npm run smoke` once more.

**Rolling back the application does not undo a migration that already ran.** The
rolled-back build runs against the newer schema. If the migration itself is what broke
production, or the older build cannot work with the new schema, a rollback will not
cure it: stop and take it to the owner. Reverting a migration is a separate, deliberate
change, never part of a rollback (HANDOVER §2).

**The approval chain's stored form (gap 37) — a two-step change, like §5k's alert.** A
request's approval chain (`CustomerEdit.approvalChain`, and the `EditRevision` of a
new-customer round) can be stored as `{ v, calendar, steps }` instead of the bare array of
steps. The production build before `claude/audit-gaps-final` (a454239) reads **only the
array**: there, an object reads as ONE Supervisor step, so the Supervisor's approval would
finalize a cash create without the Accountant, a credit create without the Sales Director,
the signed form, the Finance Manager and the GM, and a request past its first step would
have no step at all and could not be decided. So:

- The build that ships `claude/audit-gaps-final` **reads both forms and still writes the
  array** (`CHAIN_OBJECT_FORM_ENABLED = false` in `lib/approval-chains.ts`). An Instant
  Rollback from it to a454239 is safe as far as the chain goes. The gap-31 rules stay in the
  database whatever the rollback (§5l), and a454239 does not hold a breaking customer back
  from Temix Generate: there, one queued customer whose record breaks a rule refuses the
  whole batch (`DATA_RULE`, nobody named) until it is corrected.
- **The one-line enable commit** (`CHAIN_OBJECT_FORM_ENABLED = true` and its unit test in
  `tests/unit/approval-chain-freeze.test.ts`) is deployed only once that build has served
  production and passed smoke — it is then the rollback target, so no build that cannot
  read the object is left to roll back to.
- **Once chains are written as objects, never Instant-Rollback past the first build that
  reads them** (the merge of `claude/audit-gaps-final`), and a revert of commit `22dd7c6`
  (or of anything in `lib/approval-chains.ts`) must keep `readFrozenChain` and
  `parseChain`'s object reader. To go back, revert only the enable commit: the reader stays
  and new requests are written as arrays again; the objects already written stay readable.

| Step | Who | When | Done (date, in the go-live log) |
|---|---|---|---|
| 1. Deploy the build that reads both forms; smoke | operator | with the gap-31 rules (§5l) | |
| 2. The enable commit, deployed; smoke; the next request sent reads `{ "v": 2, "calendar": …, "steps": [ … ] }` in its `approvalChain` (read-only, through `prod-run.cjs`, §5j) | operator | the first working day after step 1 has served production and passed smoke — **the owner sets the date** (04-PENDING A9) | |
| 3. From here, the Instant Rollback floor is the step-1 build: write it in the go-live log | operator | with step 2 | |

## 5. Database migrations

Schema lives at `prisma/schema.prisma`. Migrations in `prisma/migrations/`.

```bash
# create a new migration locally + apply to Neon
npm run db:migrate -- --name describe_change

# apply existing migrations to a fresh DB (e.g. staging branch)
npx prisma migrate deploy
```

- **The history foundation (`20261013100100_history_foundation`) locks the five master tables while it runs.** It writes a first page of history for every customer, shop, account, route and region (about 31k rows on production, 1–3 s on Neon) under `SHARE ROW EXCLUSIVE` locks, so writes to those tables wait for it; `lock_timeout` is 10 s, so a busy table fails the deploy fast rather than queueing behind it — and "re-run it" is not enough on its own: see "A migration refused by a lock" below. Deploy it outside working hours. Re-run `scripts/ops/app-role.ts grant` afterwards (it takes INSERT/UPDATE on the history tables and their sequences back from `nmwc_app` if the role existed before the migration ran; the migration does it too when the role exists) and check `status`. Then `npx tsx scripts/ops/history-report.ts --expect-host <host>`: the baseline is in and nothing is unattributed. Every write path now names its cause (`lib/change-context.ts`); `docs/HISTORY.md` is the reference.
- **The lossless paths (`20261014100000_lossless_paths`) come after it, and lock `Customer`, `CustomerEdit`, `EditApproval`, `EditBranchDraft`, `ExportJob`, `ImportBatch` and `CustomerHistory` (ACCESS EXCLUSIVE) and `Attachment` (SHARE ROW EXCLUSIVE) while it runs** — reads of those tables wait too. It adds columns, writes a first page of photo history (one row per photo), fills `CustomerEdit.originalCustomerId` and the merged customers' `mergedIntoId`: seconds. Deploy it outside working hours, after the history foundation. Then re-run `scripts/ops/app-role.ts grant` and `status`: `EditRevision` and `ExportJob` must read insert-only and `AttachmentHistory` read-only. From then on: a request, once sent, cannot be rewritten or deleted (a fixture or a correction goes through the maintenance window, §5e); every export is recorded with its customers and file fingerprint before it is sent; an import writes nothing for a customer or shop it leaves as it is.
- **Part C (`20261015100000_authority_jobs_auth_events`, then `20261015100100_route_region_fixed`) comes after the lossless paths.** Additive and quick: four nullable columns on `EditApproval` (no rewrite; a CHECK on a few thousand rows), two new append-only tables (`JobRunDay`, filled from the `CronRun` rows that exist, and `AuthEvent`), a trigger on `User` that records every session cut-off, and a trigger on `Route` that refuses any change of its region. The second migration prints, read-only, `route_region_fixed: N shop(s) on M route(s) carry a region other than their route's` in the deploy log: a drift an earlier route move left behind (gap 16). If N is not 0, see §7 "A route never changes region". Afterwards re-run `scripts/ops/app-role.ts grant` and `status`: `JobRunDay` and `AuthEvent` must read insert-only. From then on: every decision row says who decided as what and why he could; a save that lost a race leaves a `CONFLICT` audit row; failed sign-ins on unknown names and every session cut-off are kept in `AuthEvent` (fingerprints, never names); the retention sweep keeps each day of scheduled-job runs in `JobRunDay` before it prunes them; and **no one can move a route to another region**, the Steward's account import included. `docs/HISTORY.md` §10 is the reference.
- **A migration refused by a lock** (`lock_timeout` — "canceling statement due to lock timeout" — or a deadlock with a live write, which Postgres resolves by cancelling one side). The history migrations (`20261013100100`, `20261014100000`, part C) take table-wide locks: part A `SHARE ROW EXCLUSIVE` on the five master tables and then `ACCESS EXCLUSIVE` on `AuditLog` (its `ALTER TABLE`), part B `ACCESS EXCLUSIVE` on `Customer`, `CustomerEdit` and five more. A request that has already written an audit row and then waits for a master table can deadlock with part A; whichever side Postgres cancels, nothing is lost on the application's side (its transaction rolls back and the user is told to retry). If it is the migration:
  1. Nothing of it was applied: Prisma sends each migration file as one script, which Postgres runs as one transaction, so it rolled back whole. Check with `npx prisma migrate status` (owner connection, `DIRECT_URL`): the migration is listed as **failed**.
  2. Prisma now refuses every later `migrate deploy` — and so every Vercel build — with **P3009** ("migrate found failed migrations in the target database") until it is marked rolled back: `npx prisma migrate resolve --rolled-back <name>` (for example `20261013100100_history_foundation`), on the same connection. Only after step 1 confirmed nothing was applied; never `--applied`.
  3. Deploy again (re-run the build), outside working hours.
- **Deploy the history in two steps, A1 alone first.** The Vercel build runs `prisma migrate deploy` BEFORE `next build`, so a deploy's migrations apply while the previous build is still serving. If the commit that makes every write name its cause (`7872d8a`, "Every database write says who made it and why": code, plus the `CONFLICT` enum value) is deployed in the same push as the history (`aa50694` onward: the triggers), every write the old build makes during that build is recorded under source `sql` (§5 of `docs/HISTORY.md` — not lost, but unattributed), and the history's table locks meet live traffic. So: push `7872d8a` to `main` alone, let it build and serve, smoke it; then push the rest (the history, the lossless paths and part C) outside working hours. If the two must go together, expect `sql` rows written during that build window on the Record keeping card and leave them: they are the old build's writes.
- **Migrations ARE applied by the Vercel build.** `package.json` `build` runs `prisma generate && next typegen && tsc --noEmit && next lint && prisma migrate deploy && next build --no-lint`, so any migration on the deployed commit is applied to the database in `DIRECT_URL` as part of the deploy — but only after the typecheck and lint have passed. A deploy that failed in `next typegen`, `tsc` or `next lint` applied nothing; one that failed inside `next build` HAS applied its migrations. (This line previously said the opposite; it was wrong, and it matters — a rollback of the application does not roll back the schema, and a restore followed by a deploy will re-apply migrations.)

## 5b. First-time post-deploy operator checklist

Run these once after the senior-audit remediation deploy. Each item is needed by a senior-audit blocker; none auto-resolve themselves.

### A. Reconnect Vercel ↔ GitHub auto-deploy (op note 1)
The CLI cannot toggle this on its own. Do it via UI:
1. Open https://vercel.com/rahmanmansoori244-6893s-projects/nmwc-cm/settings/git
2. Under "Connected Git Repository", click "Connect" and select `rahmanmansoori244-droid/NMWC-CRM` on `main`.
3. Confirm in https://github.com/rahmanmansoori244-droid/NMWC-CRM/settings/installations that the Vercel app is installed.
4. From then on, every push to `main` triggers a Vercel build automatically; that is how production deploys. If the connection is ever lost, reconnect it as above — do not fall back to `npx vercel --prod` from a laptop, which builds and migrates whatever tree is checked out (§4).

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
| `DIRECT_URL` | `neondb_owner` (direct endpoint) | `prisma migrate deploy` in the Vercel build, the nightly backup, Steward maintenance scripts (`prisma/synthetic.ts --reset`, `scripts/ops/app-role.ts`; every script that opens a database refuses production unless `--expect-host` names it, §5j) | everything |
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

Against production the scripts refuse to run unless `ALLOW_PRODUCTION=1` is set **and** the command line names the database with `--expect-host ep-sweet-haze` (§5j) — the owner runs steps 1–3 deliberately. `run-with-env.mjs` refuses a production connection string since 2026-10-11 (§5j), so these run with `npx tsx` directly, with the production URL passed explicitly. This `DIRECT_URL='…'` form is one of those still waiting to be rewritten for `scripts/dev/prod-run.cjs` (§5j):

```bash
ALLOW_PRODUCTION=1 DIRECT_URL='<production owner URL, direct host>' NMWC_APP_PASSWORD='<strong password>' \
  npx tsx scripts/ops/app-role.ts create --expect-host ep-sweet-haze
ALLOW_PRODUCTION=1 DIRECT_URL='<production owner URL, direct host>' npx tsx scripts/ops/app-role.ts grant --expect-host ep-sweet-haze
ALLOW_PRODUCTION=1 NMWC_APP_URL='postgresql://nmwc_app:<password>@<production pooled host>/neondb?sslmode=require' \
  npx tsx scripts/ops/app-role.ts verify --expect-host ep-sweet-haze
```
 CI performs the same create → grant → verify on every run against its throw-away Postgres, so a migration that breaks the privilege set is caught before it ships. Verified on the Neon UAT branch on 2026-09-14 (Neon allows `CREATE ROLE` via SQL for the owner; the role is not shown in the Neon console but works).

## 5d. Cron heartbeats and the health probe (B5, 2026-09-14)

Every scheduled job (`sla-escalate`, `keep-warm`, `photo-gc`, `retention-sweep`, `email-drain`, and since the watch-and-prove branch `integrity-watch`, §5k) records a heartbeat row (`CronHeartbeat`) when it finishes, success or failure. The bearer health probe reports them:

```bash
curl -s -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq .cron
```

States: `ok`, `outside-window` (not expected right now), `failed` (last run reported an error), `stale` (no run for 3 × the schedule interval inside its window), `never` (no run recorded). `failed`, `stale` and `never` are alarms.

**What pages and what does not (item 11, 2026-09-27).** Each job has a tier in `lib/heartbeat.ts`, and `lib/health.ts` turns them into the answer:

| Answer | When | Body |
|---|---|---|
| **503** `status: degraded` | a check fails (`db`, `r2`, `heartbeats`), R2 is **unconfigured on production**, or a **critical** job alarms: `sla-escalate` (approvals stop escalating) or `db-backup` (no off-Neon copy) | `cron.alarms` names the critical jobs |
| **200** `status: warn` | only a **warning** job alarms: `keep-warm` (speed only), `photo-gc`, `retention-sweep` (housekeeping; the next run catches up), `email-drain` (the e-mail copy is late, the in-app row is not; §5i), `integrity-watch` (the nightly data check and seal, §5k; stale after 36 h — whether it should be critical is an open owner question), or R2 unconfigured off production | `warnings: ["keep-warm:failed", …]` |
| **200** `status: ok` | nothing to report | |

Point an external uptime monitor at this URL with the bearer header and alert on non-200. It then pages only for the critical row. The warning rows are still visible: in the body, as `warn=[…]` on smoke's dead-man line, and as a `warn` (not `critical`) webhook alert when a warning job's run fails. Before this change any alarm answered 503, so one failed keep-warm ping paged as loudly as a dead SLA sweep. To move a job between tiers, change its `severity` in `HEARTBEAT_EXPECTATIONS`. `tests/unit/health-verdict.test.ts` pins which jobs are critical, so the change has to be deliberate.

The anonymous probe (no header) answers 503 when the database is unreachable, so a plain uptime check sees a real outage. It retries once after 750 ms first, so one pooler blip is logged (`health.db.retry`) and not reported as an outage.

**Since 2026-09-27 the project is on Vercel Pro, and Vercel runs all four jobs itself** (five since F1: the e-mail drain, §5i, is a Vercel cron too). `vercel.json` `crons` now holds keep-warm (`*/4 3-14 * * *`) and the SLA sweep (`15,45 3-14 * * *`) beside photo GC and the retention sweep. Pro runs them within the minute. Vercel sends `Authorization: Bearer <CRON_SECRET>` itself, so no header is set anywhere, and the external scheduler below is no longer needed. **Retire it once the Vercel jobs are proven** (owner). The check is the Service status page's **Scheduled jobs** list: keep-warm and the SLA escalation sweep must each read "Vercel last ran it …" with a recent time, through a whole working day. The objective cards cannot tell you this, because they count a run from any scheduler. Then:
1. At cron-job.org, **delete** both jobs (Cronjobs → each job → Delete). Disabling is not enough: a disabled job keeps its stored `Authorization: Bearer <CRON_SECRET>` header.
2. At cron-job.org, delete the API key (Settings → API). Then delete the `CRONJOB_API_KEY` repository secret in GitHub. Deleting only the GitHub secret leaves the key valid.
3. Rotate `CRON_SECRET`, because cron-job.org held it: set the new value in Vercel Production and in GitHub `PROD_CRON_SECRET`, then redeploy so Vercel's cron sends the new one. Do **not** run the External cron scheduler `apply` again: it would re-create the jobs and send them the new secret.

After this, only Vercel and GitHub Actions hold `CRON_SECRET`. GitHub still needs it as `PROD_CRON_SECRET` for the nightly backup's report and the backup workflows. Until then the two schedulers run side by side, which is harmless: keep-warm is free to repeat, and the sweep claims each escalation once. The GitHub workflows (`keep-warm.yml`, `sla-escalate.yml`) stay as a late, sparse backup.

What follows is how the external scheduler was set up, kept for the record and for a rollback to Hobby.

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

**Done 2026-09-27:** the move to Vercel Pro, described at the top of this section.

## 5g. Finding what happened — logs and the error Reference (item 10, 2026-09-27)

Vercel keeps runtime logs for **30 days** on Pro with **Observability Plus**, which is on by default for teams upgraded after 3 April 2026. Check it once under Vercel → Settings → Billing → Observability Plus. Without it, logs are kept for 1 day.

- **A user quotes a Reference from the error screen:** paste it into Vercel → Logs → search. Every server error writes a `request.error` line carrying that `digest` and the route it happened on (`instrumentation.ts`). The request's other log lines are grouped under it. The same Reference is a Sentry tag: search `digest:<reference>`. **If the Reference contains `@`** (`2847590223@E394`, an error Next raised itself), search only the part before the `@`: that is what the server knows.
- **Only the problems:** use the Level filter → Warning / Error. Since this change the app writes warnings and errors to stderr, which is how Vercel decides a line's level. Before it, every line was filed as info and the filter found nothing.
- **One job:** filter the Request Path by `/api/cron/<job>`, or use Vercel → Settings → Cron Jobs → View Logs.
- **What the logs may hold.** The app's own log lines, and Prisma's error lines (routed through the app logger since 2026-09-27), have phone numbers, e-mails and 7–12 digit runs scrubbed before they are written (`lib/scrub.ts`). The one exception is a top-level `digest`, a hash of the error, which is kept whole so the Reference can be found. **Three things are not scrubbed**, and Vercel now keeps them for 30 days:
  - the request path with its query string, which Vercel records for every request. A customer search puts the typed text, often a phone number or a name, in `?q=`;
  - Next's own printout of an unhandled server error (message and stack);
  - anything a library writes to the console itself.
  This is recorded as a known gap in docs/compliance/DATA-RETENTION-SCHEDULE.md.

**Tracing:** Sentry samples 10% of requests. Vercel Observability → Functions shows latency by route, with p75 and a per-path breakdown on Observability Plus.

## 5h. Service levels (item 9, 2026-09-27)

The targets and how each is measured: [SERVICE-LEVELS.md](SERVICE-LEVELS.md). The live figures: the **Service status** page, in the menu for the Data Steward and the Managers. It is built from `CronRun` (one row per scheduled run, 90 days) and the stage snapshot on each approval decision, and measures from 2026-09-27 onward.

**The role after this deploy — done on production 2026-09-27.** `nmwc_app` gets DELETE on a table only when `grant` runs, and needs it on `CronRun` (the retention sweep) and `_ManagerRegions` (a manager's regions re-set by the account import). `grant` also takes back DELETE everywhere else. Before it ran, a read-only `status` on production showed the role holding DELETE on 14 tables it should not have (Branch, Channel, CodeSequence, CronHeartbeat, Customer, EditCustomerDraft, ExportJob, ImportBatch, ImportRow, Region, Route, SubChannel, TemixSyncBatch, User). It also held DELETE on `_ManagerRegions`, which it needs, only through that same blanket grant, and a default privilege gave it DELETE on every future table. All of this was left over from an earlier version of the grant that no later `grant` removed. `grant` then ran on production from an operator's machine (it needed the transaction budget of commit 1213f54 to finish over a slow link), and `status` now prints "DELETE is held exactly where it should be". Production still connects as the owner, so the running app used none of this. Re-run `grant` after any migration that adds a table to DELETABLE.

## 5f. Outbound alerts — the only way this system can reach you (GAP-2, 2026-09-24)

Until 2026-09-24 nothing in this system could reach a person who was not looking at a screen. There was no mailer and there is no SMS: a `Notification` row existing meant "visible in-app" and nothing more. (Since 2026-10-05 approvers can also receive notification e-mail, §5i. That is for their work, not for operations: this webhook is still the only channel that tells the OPERATOR something broke.) So the SLA sweep escalated twice an hour into a bell nobody had open, and a cron that stopped running was visible only to whoever thought to curl `/api/health` with the monitor bearer.

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
| `cron.failed` | A scheduled job records a failed run. `scope` is the job: `sla-escalate`, `keep-warm`, `photo-gc`, `retention-sweep`, `email-drain`, `db-backup`. For `email-drain` a failed run means a send failed, the Gmail login was refused, or Gmail refused the sending account (§5i) | Something scheduled is broken *now*. `db-backup` means last night's dump did not land — go to §6 and the Actions run. `sla-escalate` means approvals are no longer being escalated. Read the detail: `curl -H "Authorization: Bearer $HEALTH_BEARER" …/api/health \| jq .cron` — the scrubbed error text stays there rather than on the webhook. |
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

## 5i. Notification e-mail (F1, 2026-10-05)

**What it is.** When a salesman submits a request, the people in his hierarchy who must act on it, and his region's Accountant, get an in-app notification at once, written in the same transaction as the request. Every 10 minutes from 07:00 to 18:59 Oman time (`*/10 3-14 * * *` UTC, `vercel.json`), `/api/cron/email-drain` sends each of them at most one e-mail with what is new: counts, the kind of each request and links. **Never a customer, salesman or route name, never a reason**: the e-mail is built from the notification's kind and the request's id only (`lib/email/digest.ts`). Who is told, what is e-mailed and the limits are defaults in one module, `lib/notify-policy.ts`, listed for the owner in 04-PENDING A1.11.

Never e-mailed: a Steward, a Viewer or a salesman (an allowlist of roles, checked at send time; their in-app rows are unchanged), a notification already read in the app, a request already decided or moved past its recipient, a "please review" to someone the request's page would refuse (the drain asks the decision's own rule, `canActOnStep`, with his managed regions — so a supervisor who does not manage the salesman's route region is not e-mailed), anything older than 24 hours, and anything at all while `NOTIFY_EMAIL_ENABLED` is not `on`. Every notification that existed before this feature was marked done by its migration and is never e-mailed.

**Owner decision 6 (2026-10-07): the GM and late requests.** The GM is e-mailed like the other approvers, for work waiting on him only: a credit request at the GM step (by the same "can he decide it now" rule) and a late request the escalation sends him — never an information-only row. A late request (`SLA_BREACH`, written by the SLA sweep, `lib/escalation.ts`) is e-mailed to the people the escalation tells: at the Supervisor step the Managers of the request's regions (every region a customer has shops in), then the GM at 2x the budget, or the GM at once where no Manager covers the region; at the Accountant step the Finance Manager and the GM; at the Finance Manager step, and for a reactivation, the GM. Each row is re-checked at send time: the request is still open, the recipient is not its submitter, he still holds a role the plan names for the step it waits on (a Manager only over one of its regions), and he can act on it. So a late **GM** step, which the sweep shows to the region's Managers in-app for visibility (nobody outranks the GM), is not e-mailed to them; it is e-mailed only to the GM himself where the sweep fell back to him. A decision marks every late-request row about the request read, so a request that moved on is never e-mailed. A late request and a "please review" about the same request are one line in one digest; the limits below are unchanged.

**Deploying it.** The foundation (`claude/notify-foundation`) is merged and deployed on its own, and passes smoke, before the writers and the drain (`claude/notify-email`) are merged. Once the writers are live, an Instant Rollback goes to the foundation's deployment, never older: an older build cannot read the new notification kinds ([04-PENDING A1.11](handover/04-PENDING-WORK.md), "Deploy order"; [03 §6](handover/03-OPERATIONS-AND-DEPLOYMENT.md#6-rolling-back)).

**Limits.** One e-mail per person per run and at most one per person per 30 minutes; 40 per run; 400 per rolling 24 hours (consumer Gmail allows about 500 recipients a day — check Google's current figure). Work goes first: an e-mail that only informed does not hold back a later "please review" (the 30 minutes count only from an e-mail that also asked him to act); when a limit binds, e-mails with something to act on go before information-only ones; and information-only e-mails may use at most 300 of the 400 a day. A capped e-mail waits for a later run and is dropped after 24 hours; the in-app row stays. After 18:59 Oman nothing is sent until 07:00; inside that window it runs every day, weekends and public holidays included, like the other jobs.

**Before turning it on** (owner, in this order):
1. Read-only readiness check, counts only — its output is never committed or pasted into the repository: `NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs scripts/ops/notify-readiness.ts --expect-host ep-sweet-haze`. It counts approvers with no e-mail on file, salesmen whose supervisor is missing, disabled, of the wrong role or a Manager outside the route's region, regions with no active Accountant or Manager, and addresses held twice once case is ignored.
2. The Steward fixes what it found on `/users`: **Add e-mail / Change e-mail** on each approver's row (Steward only; an empty box clears the address), and **Reports to** for salesmen. `/users` never shows the address: an approver's row says "E-mail on file", or "E-mail not usable — re-enter it" (amber) when what is stored is not an address the drain can send to, by the drain's own rule — those are the readiness check's "not an address". The Steward, Viewer and salesman rows show neither, since they are never e-mailed (the GM's row has the e-mail editor since owner decision 6).
3. Vercel → Settings → Environment Variables → **Production**: `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD` (the app password is **Sensitive**; Google issues one only with 2-Step Verification on). `EMAIL_LINK_ORIGIN` only if links must not use `https://nmwc-cm.vercel.app`.
4. Prove it on a **preview** first (below), then set `NOTIFY_EMAIL_ENABLED=on` on Production and **redeploy**: variables are read when an instance starts. Then `npm run smoke`.
5. Watch the first runs: `curl -s -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq '.cron'` — `email-drain` should read `ok`. Each run's counts are in the Vercel logs (event key `email.drain`) and in its heartbeat row (`CronHeartbeat.lastDetail`): `sent`, `skipped` and `skippedBy` (why), `deferred`, `capped`, `sendErrors`, `authErrors`, `accountErrors`.

**Proving it on a preview (UAT).** Vercel runs crons on the production deployment only, so a preview never drains by itself. On the Preview environment set `NOTIFY_EMAIL_ENABLED=on`, the two Gmail variables and `EMAIL_REDIRECT_TO` = one test inbox (without it a preview sends nothing at all: UAT holds a copy of the real staff addresses). Redeploy the preview, submit a request there as a salesman whose supervisor and Accountant have addresses on file, then call the drain by hand with the preview's `CRON_SECRET`: `curl -s -H "Authorization: Bearer <preview CRON_SECRET>" https://<preview host>/api/cron/email-drain`. Check: the e-mail arrives in the test inbox with `[UAT]` in the subject and links to the preview; an immediate second call sends nothing more (the 30-minute gap); a deliberately wrong app password answers `authErrors: 1` and raises the warning-tier `cron.failed` alert. **This is also the only proof that Vercel's functions can open SMTP on port 465** — the repository cannot show it.

**Turning it off.** Set `NOTIFY_EMAIL_ENABLED` to anything but `on` (or delete it) and redeploy. The drain then reads nothing and answers `{ "enabled": false, "reason": "disabled" }`, a healthy run. Notifications written while it is off are never e-mailed more than 24 hours after they were written. During `MAINTENANCE_MODE=on` it sends nothing either (`reason: "maintenance"`): a restore may roll the rows back.

**When `email-drain` fails** (a warning-tier `cron.failed`): `configErrors` means the switch is on but a setting is unusable — a Gmail variable missing, or `EMAIL_REDIRECT_TO` / `EMAIL_LINK_ORIGIN` not an address / an https origin (the run's `reason` says which); nothing is sent until it is fixed and redeployed. `authErrors` means Gmail refused the login — the app password was revoked (changing the Google account's password revokes them all) or mistyped. Issue a new one (SECRETS-INVENTORY.md section 5, CREDENTIAL-ROTATION.md); nothing is lost meanwhile, since every unsent row is handed back and retried for 24 hours. Every run in the window tries the login again, so fix it promptly: Google may treat a stream of refused logins as suspicious. `accountErrors` means Gmail accepted the login but refused the sending account itself — most often its daily sending limit, which the owner's own mail counts against too, so the app's 400 a day cannot prevent it; or the account is blocked. The run stops at the first such refusal and hands every row back, nothing is marked `FAILED`, and each run tries once more until Google lifts it (usually within 24 hours; rows older than 24 hours are then dropped, the in-app rows stay). Check the mailbox in a browser for a notice from Google. Two different recipients refused one after the other count the same way: the first is marked `FAILED`, the run stops and the rest go back. `sendErrors` with `errorLabels` such as `ETIMEDOUT` / `ECONNECTION` / `SMTP_4XX` is the network or Gmail saying "not now" — those rows retry after their 5-minute lease; `SMTP_5XX` / `EENVELOPE` in `sendErrors` means Gmail refused that one recipient for good (his digest's rows are marked `FAILED`). The labels are all the app records about a failure: never the error text, never an address.

**What this does not cover.** A run killed between a send and its record can send that e-mail twice. The lease keeps two overlapping runs (a manual bearer call during a scheduled one) from sending the same row, but they can each claim a different row for the same person and each send him a digest: the 30-minute gap is read before sending, not reserved. Both are rare; neither loses anything. The sending mailbox's Sent folder keeps a copy of every e-mail, and each recipient's mailbox keeps another, outside the app's retention (DATA-RETENTION-SCHEDULE.md). `scripts/ops/smoke.ts` does not yet check that `/api/cron/email-drain` refuses an anonymous call: add `'email-drain'` to its unauthenticated-cron list after the route is live on production, since adding it earlier makes the pre-merge smoke against the old production fail.

## 5j. Scripts and tools against production (data audit 2026-10-10, owner decision 2026-10-11)

**Why.** The data audit of 2026-10-10 found that scripts in this repository could delete or rewrite history on production and nothing stopped them: two clean-up scripts opened the audit maintenance switch (`nmwc.audit_maintenance`, §5e) and deleted history, users and customers, others rewrote customers, and none checked which database it had been pointed at. On 2026-10-11 the owner decided to delete them from the repository (git history keeps them): `scripts/wipe-synthetic-data.ts`, `scripts/cleanup-synthetic-test.ts`, `scripts/flatten-customer-branches.ts`, `scripts/seed-demo-edit.ts`, `prisma/inject-test-edits.ts` and every `prisma/test-*.ts`. Later the same day the owner also deleted `scripts/synthetic-launch-test.ts` (it signed in to the live site and uploaded a photo there, whatever database it was given), `prisma/seed-muscat-customers.ts` and `prisma/seed-muscat-payment-terms.ts` (they rewrote customers from a local workbook).

**The rules.**

1. **Only the audited operator scripts in `scripts/ops/` run against production**, always through `scripts/dev/prod-run.cjs` (HANDOVER §5), and always with `--expect-host ep-sweet-haze` on the command line — for a dry run too:

   ```bash
   npm run smoke
   NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs \
     scripts/ops/<script>.ts --expect-host ep-sweet-haze [the script's own flags]
   npm run smoke
   ```

   Some commands in this repository still show the older form, `DIRECT_URL='…' npx tsx …` or `DIRECT_URL='…' npm run …` with the connection string on the command line: §5c (`app-role.ts`), §7 (`ops:requeue-untracked`, `ops:visit-days`, `ops:rescore-completeness`) and GO-LIVE-RUNBOOK steps 1, 3 and 6a. They are waiting to be rewritten for `prod-run.cjs` ([04-PENDING-WORK](handover/04-PENDING-WORK.md), "Production commands in the runbooks"). Until then this rule is what to follow, and HANDOVER §5 says never to put the connection string on a command line. Each of those scripts still refuses production without `--expect-host ep-sweet-haze`. `prod-run.cjs` itself refuses any run without `--expect-host ep-sweet-haze` among the script's arguments, read-only or not, and before it reads the env file (owner decisions 2026-10-11). It reads the flag where the script reads it and passes every argument on unchanged, so the script's own guard checks it again: one flag, typed once, checked twice. A throw-away `*.tmp.ts` read script is handed the flag too and may ignore it.

2. **Every script under `scripts/` and `prisma/` that opens a database checks which one first.** It calls `scripts/lib/assert-not-production.ts` before it connects (the ops scripts through `requireExpectedHost`, which ends in it). The guard refuses a host that starts with `ep-sweet-haze` unless `--expect-host` names it with a value that itself starts with `ep-sweet-haze`; refuses any host that a given `--expect-host` does not match; refuses a connection string it cannot read; and prints the host it is about to use before anything connects — never the user, the password or the rest of the URL, and a production host only as `ep-sweet-haze… (PRODUCTION)`. A refusal prints its reason and writes nothing. `tests/unit/scripts-production-guard.test.ts` fails CI when a script builds a database client without it. Scripts that are meant never to touch production keep their own refusals on top (`app-role.ts` and `restore-verify.ts` still need `ALLOW_PRODUCTION=1`; `prisma/synthetic.ts` and `prisma/seed-muscat-pilot.ts` still need `ALLOW_PROD_SEED=1`; `scripts/qa/probe-db.ts` and `constraint-smoke.ts` abort outright). `prisma/seed.ts` never runs on production, not even with `--expect-host` (owner decisions 2026-10-11): it refuses a production connection string before it builds a client, so it can never create the default `admin` Manager, or anything else, there. On any other database it only inserts what is missing — channels, sub-channels, regions and the `admin` account — and never changes an existing row: no region name, channel or sub-channel label, channel display order or account. It lists, by key, any existing row whose stored values differ from its own.

3. **Opening Prisma Studio (`npm run db:studio`, `npx prisma studio`) or `psql` against production — any direct database session there — counts as maintenance** and needs an entry in the private operations log in the owner's handover pack: who, when, why, and what was read or changed. **It is kept privately, never in this public repository** (owner decisions 2026-10-11): no log file is created here, and none is committed. The audit-maintenance windows of §5e, the reconciled load totals of GO-LIVE-RUNBOOK §6a and what an operator script ran ([03 §7.3](handover/03-OPERATIONS-AND-DEPLOYMENT.md) step 8) go in the same private log. Neither tool is a script in this repository, so the guard cannot see them; this rule is procedural.

**Still open with the owner (2026-10-11).** Rule 1 names `scripts/ops/` only, but some runbooks tell the owner to run scripts from elsewhere against production: `scripts/golive/audit-accounts.ts` (GO-LIVE-RUNBOOK step 3), `scripts/golive/bootstrap-accounts.ts`, `scripts/bulk-reset-credentials.ts` ([02 §4](handover/02-ACCESS-ACCOUNTS-AND-SECRETS.md)), the read-only question scripts of HANDOVER §5 and the private-pack scripts of [03 §7](handover/03-OPERATIONS-AND-DEPLOYMENT.md). Whether each moves into `scripts/ops/`, is named as an exception, or stops being run there is the owner's decision. Until then, every one of them that lives in this repository refuses production unless `--expect-host ep-sweet-haze` is on its command line; a private-pack copy (`*.tmp.ts` at a checkout's root) is not checked by the guard test.

**Also guarded since 2026-10-11 (review of the first guard).** `scripts/qa/run-with-env.mjs` refuses to start anything when `DATABASE_URL`, `DIRECT_URL` or any other connection string it holds points at production, percent-escaped or not. It has no opt-in: everything it is documented for runs on UAT or CI. Whether an explicit opt-in is wanted is an open owner question. The guard also treats a percent-escaped marker as production, and no longer prints a full endpoint id given as `--expect-host`. The guard test now parses each script and traces the URL each client is given back to the guard: an aliased `PrismaClient`, a client given a different variable from the one checked, and an import that reaches the app's own client (`lib/db.ts`) all fail it. `scripts/capture-guide-screenshots.ts` and `scripts/capture-steward-screenshots.ts`, whose browser signs in to the live site whatever database a checkout names, refuse to start unless `--expect-host ep-sweet-haze` is on the command line (owner decisions 2026-10-11; `liveSiteNamed` in the shared guard). `scripts/ops/restore-load.sh` is a shell script, so it cannot call the guard; since 2026-10-11 it refuses on its own a `RESTORE_TARGET_URL` with `ep-sweet-haze` anywhere in it — the host or any other part, in any case, as written or percent-decoded — and a `PGHOST` or `PGHOSTADDR` with it, before `psql` or `pg_restore` starts (owner decisions 2026-10-11; `tests/unit/restore-load-guard.test.ts` runs it).

## 5k. Nightly integrity check and ledger seals (watch and prove, data audit gaps 28 and 29)

**What runs.** `/api/cron/integrity-watch`, daily from `vercel.json` at **02:30 UTC (06:30 Oman)**: after the Oman day has ended, and before photo-gc (03:00) and the retention sweep (03:30) delete anything that day, so the checks see the state before the purges. It records the `integrity-watch` heartbeat (warning, stale after 36 h). One run:

1. **Twenty-two named, read-only checks** (`lib/integrity/checks.ts`), each in its own read-only transaction with a 10 s statement timeout, inside a 22 s budget. Each result goes to `IntegrityCheckResult` (append-only, sealed): the check, pass / fail / info / error, the count, at most ten sample ids and counts by sub-kind — never a name, phone, CR number or code.
2. **Tonight's seal** of the ledgers (`lib/seal/*`), its copy in R2 under `seals/`, and a recheck: every seal's body and link, the last seven seals' ranges and copies, **a rotating slice of the older seals' ranges** (each older seal is recomputed at least once every 28 nights while the run's budget holds; the result's `rotationCursor` says where the next night goes on), and **a listing of all of `seals/`** (one object per seal, at its own key, and nothing else).
3. **When an alerting check fails:** one in-app alert per active, non-test Data Steward per Oman day (kind `INTEGRITY_ALERT`, check titles and counts only, linking to **/status/integrity**; never e-mailed), and the operators' webhook (§5f, event `integrity.failed`, counts only; `critical` when the seal chain or the protection checks failed, `warn` otherwise). **The in-app alert ships switched off** (`lib/integrity/policy.ts` `INTEGRITY_INAPP_ALERTS_ENABLED = false`) — see "Deploy order" below.

A check that finds a problem does not fail the job. A check that could not run (`error`), or a failed R2 write, does: the heartbeat goes red and `cron.failed` alerts, because an unanswered check is not a passed one. **An `error` result never moves the next run's starting point:** each check goes on from its last result that ran (pass, fail or info), so the "since the last run" checks also cover an errored night, and the stored baselines (test flags, code counters, the jobs' last checked day, the seals' open findings and rotation) are not reset by it.

**The results page** (`/status/integrity`, Data Steward only, linked from the Record keeping card on `/status`): the latest run check by check, with why it matters, what to do and its samples (customers and shops as links, a customer shown by its NMWC code); a check that names where its findings are worked through links there when it finds any (`cr-number-shared`: **/duplicates**); a 14-run trend per check; the last ten seals; the last 30 days of purge summaries (§ DATA-RETENTION-SCHEDULE).

**The checks, and what to do.** The data checks leave the flagged test records out (§7, "Flag a test record"); the record-keeping checks do not — they test the recorder, and a mis-flag must not hide a defect.

| Check | Fails when | What to do |
|---|---|---|
| `shop-region-matches-route` | a live shop's region is not its route's | Correct the shop through the app (a route never changes region, §7) |
| `customer-status-follows-shops` | a customer's status contradicts its live shops in a way the rule never leaves: every shop closed and the customer not (**close**), or CLOSED with an open shop (**reopen**). An ACTIVE customer whose open shops are all suspended (**review**) is what the rule itself leaves when the last open shop is suspended (suspending moves nothing): **information, not counted**, its first ids listed on the page | `scripts/ops/customer-status-drift.ts --list`, then `--apply` (it moves close and reopen only; review is a person's decision) |
| `temix-code-shared` | two live customers share a Temix code (upper case, the ends trimmed). **Since 2026-10-25 the database enforces it** (owner decision: Temix codes are unique; the unique index `Customer_temixCode_live_unique`, §5l), so this should never find one: a finding means the index is missing or not valid | Check the index (§5l, "One live customer per Temix code"); then find which one Temix holds, and correct or merge the other |
| `cr-number-shared` | (information, never alerts — owner decision 2026-10-25: CR numbers are **not** unique, but every shared one is flagged) how many live customers share a normalised CR number (`crNumberNorm`, the key the duplicates detector's CR rule pairs by), how many CR numbers, the most customers on one (a placeholder CR shows as one large group) and how many pairs that makes. Samples are customers, shown by their NMWC code — never the CR number; the page links to **/duplicates** | On /duplicates (CR pairs first): merge the pairs that are one customer, mark the others distinct. A pair marked distinct is still counted here, because the CR is still shared |
| `temix-code-shape` | a code with a space, lower case, wrong length, bad shape or a CRM code. The three migrated codes with a space inside (their own customer code) are **information**; a fourth fails | Correct it through the Temix workflow |
| `customer-code-is-anothers-temix-code` | a live customer whose customer code is ANOTHER live customer's Temix code (upper case, the ends trimmed) — one shop on two cards. The customer import used to create the second card when a Temix extract listed an app-made customer under its Temix code with no `temix_code` (code review 2026-11-10, finding 7); it now rejects that row naming the customer. Samples show each pair together | Open both; the one holding the Temix code is the shop Temix knows. Move what the other holds that it lacks through a normal edit, archive the other, and tell the Steward which sheet made it |
| `test-scaffolding-mixed` | (information, never alerts — owner decision 2026-10-24) a real customer on the test route or region, a real route in the test region (or the reverse), a real person on test scaffolding | Move the real record off it, or have the owner flag it (§7). **Expect this after a production walk** that creates real-flagged customers on ZZTEST-R1 |
| `history-open-interval` | a live record with no open history interval, or an open interval for a record that is gone | A write bypassed the capture triggers: find when, repair in a logged maintenance window (§5e) |
| `history-matches-master` | the latest history values are not the record's (or a route's holder) | As above |
| `history-unattributed-since-last-run` | a change recorded under source `sql` since the last run | `scripts/ops/history-report.ts`; by the runtime role it is a code defect |
| `protection-triggers` | a protecting trigger missing, disabled (`D`), replica-only (`R`) or re-pointed | Restore it from its migration at once (owner), then `verify-seals` |
| `protection-functions` | a protecting function's body (MD5), rights or search path differs from its last migration | Re-create it from the migration; find who changed it |
| `runtime-role-privileges` | `nmwc_app` holds UPDATE/DELETE/TRUNCATE on a ledger, INSERT on the history, or UPDATE on a ledger sequence | `app-role.ts grant`, then `status` (§5c) |
| `app-login-is-runtime-role` | (information) the app still connects as the owner | Owner: switch `DATABASE_URL` (CREDENTIAL-ROTATION step 1) |
| `customer-code-sequence` | a `CUSTOMER-<year>` counter behind the highest code, or lower than last night | Find who moved it |
| `scheduled-jobs-on-time` | one of the jobs that alert — `sla-escalate` (late requests are escalated), `db-backup` and `integrity-watch` itself (`ALERTING_JOBS`, `lib/integrity/policy.ts`; owner decision 2026-10-24) — left a gap longer than its allowance (windowed), did not run on an Oman day (daily), or is `never`/`stale` now (the dump: 40 h). The same for any other job — `keep-warm`, `email-drain`, `photo-gc`, `retention-sweep`, and a job added later until it is listed — is **information, never alerted**: listed on the page, not counted (the result is `info` when only such jobs missed) | §5d; a failed run already alerted as `cron.failed` |
| `test-flags-changed` | the set of flagged test records changed since last night (the first run records it) | Only the owner flags; if he did not, find who did |
| `db-rules-older-rows` | (information, never alerts — gap 31) per database rule added NOT VALID (§5l), how many existing rows break it (test rows included: a VALIDATE scans them all), whether the constraint is present and validated, and which rules read 0 and are ready for their VALIDATE migration. Samples are `rule:row id` | Correct the rows (§5l); a rule at 0 here and in `db-rules-report` on production can be validated |
| `seal-written` | tonight's seal was deferred (a transaction open at the last seal is still open) or failed | Retried the next night; repeated: look for a stuck transaction |
| `seal-chain-intact` | a seal's body, link or range no longer matches the ledgers (rows changed, deleted or slipped into a sealed range), or a seal sealed fewer rows (or other rows) than the seal before it saw waiting for it | `verify-seals.ts --all`; record who changed what and why. **Alerted once per event, then information.** An event is its kind, table and seal — for the whole-chain totals, the number of rows short or over, never the moving last seal — so a deletion alerts once, and a second deletion (a new number) alerts again. A range mismatch whose seal is not recomputed tonight (it left the last seven, and the rotation has not come back to it) stays **open as information**, never a pass; recomputed clean, it is resolved, and found again later it is new again |
| `seal-offsite-copies` | a recent seal's R2 copy is missing (older than two days) or differs; the listing of `seals/` finds an older seal's copy missing, an object for a seq after the last seal, an object in another chain's folder or of no seal layout, or a seal row naming another key than its own | A copy up to two days old is re-written automatically; otherwise compare with `verify-seals`. Alerted once per event, then information; **critical** when the new finding is a copy that differs, an unexpected object or a wrong key (a sign that a copy or the seal table was rewritten), `warn` for a missing copy |
| `exports-since-last-run` | (information) exports by role | Thresholds are the owner's |
| `sign-in-failures-since-last-run` | (information) failed sign-ins and throttle refusals by kind | Thresholds are the owner's |

**The seals.** Every append-only ledger (`AuditLog`, `EditApproval`, `ExportJob` by their `seq` key, the seven `*History` tables, `EditRevision`, `AuthEvent`, `JobRunDay`, `PurgeSummary`, `IntegrityCheckResult` by their id) is sealed each night: per table the key range since the last seal, its row count and a SHA-256 over every row, chained to the previous seal's hash (`SealRecord`, append-only; a trigger refuses a seal that does not link). The first night writes the genesis (covers nothing); the second seals every row that existed then. A seal is deferred while a transaction that was open at the last one is still open, so a late commit can never land in a sealed range unseen. Because of that lag a row is hashed for good only by the seal of the night after next (24 to 48 hours after it is written); in between, every seal after the genesis also records the count and digest of the rows waiting for the next seal (`pn`, `pdigest`), and the next seal must have at least those rows, and the same ones when it has as many (late commits only add). **What is not covered:** a row's first hours, from its write to the first seal after it (at most a day) — an edit or deletion then leaves no trace. Two runs at once (a cron delivered twice, a manual call) do not fail: the one that loses the race on the seal's `UNIQUE(seq)` reports the day `already` sealed.

**The off-site keys.** Each copy is at `seals/v1/<the genesis seal's hash, 16 hex>/<seq, 8 digits>.json`: fixed by the chain and the seq, never by the seal's own hash or day, so a second body for the same seq can only land on the same key. The nightly check and `verify-seals` read each copy at that key (never at the key a seal row names, which nothing hashes) and list the whole of `seals/`. A chain started again from a new genesis gets a new folder; the old chain's objects are then reported once (another chain) and are information after that.

**Verify the chain** (read-only; production needs `--expect-host ep-sweet-haze`, through `prod-run.cjs`, §5j):

```bash
NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs \
  scripts/ops/verify-seals.ts --expect-host ep-sweet-haze [--from-seq N] [--to-seq N] [--no-offsite] [--all]
```

It prints the FIRST mismatch (every one with `--all`) as seq, day, table, kind, counts and hash prefixes — never a row — and exits 0 (all match), 1 (a mismatch) or 2 (could not run). Run it before and after every maintenance window (§5e) and on a restored dump as a restore check. **On UAT the chain breaks after any integration run** (their clean-ups delete ledger rows by design) and the crons do not run there.

**R2 (owner, Cloudflare).** Confirm that no lifecycle rule on `nmwc-photos` expires `seals/` (the photos' rule expires only objects photo-gc tags `gc-marked`), and that the app's R2 token may **list** the bucket (an "Object Read & Write" token can; without it every night is an R2 error). **Not configured here:** a write-once bucket lock on `seals/`, or a separate bucket with its own token, is what makes the off-site copy immutable to the app's own R2 token — and to the owner login, which can otherwise rewrite the ledger rows AND the seal table in a maintenance window. With such a lock, rewriting the database's seals is caught: the rewritten seal's copy would go to the same key, which the lock refuses, so the original is read back as `differs`; deleting the newest seals leaves their copies listed after the last seal; rewriting the chain from its genesis leaves the old chain's folder. Without it, the app's token can overwrite a copy, and nothing outside the database is fixed.

**Deploy order.** The three migrations (`20261024120000_test_records` … `20261024120400_integrity_results`, with the enum-only `20261024120300`) are additive; an older build keeps working on the new schema, except that it cannot read an `INTEGRITY_ALERT` notification row. So the build that ships them never writes one (`INTEGRITY_INAPP_ALERTS_ENABLED = false`); a one-line follow-up commit turns it on once this deployment has served production and passed smoke. **Before rolling back past this build, delete the `INTEGRITY_ALERT` notification rows** (Notification is deletable). The ledger-seal migration rewrites `AuditLog` under ACCESS EXCLUSIVE for a few seconds: deploy outside working hours; if its `lock_timeout` refuses, deploy again later. After the deploy on production: re-run `app-role.ts grant` (§5c); the first night writes the genesis seal, the second seals every existing ledger row (seconds).

**Deploy checklist — gap 29 is NOT closed by this build alone.** After this build, a failing check reaches **no one** unless the webhook is set: the in-app alert is off, and `ALERT_WEBHOOK_URL` is not configured (data audit gap 29, "the alert channel is not configured"). Until both steps below are done, report gap 29 as open; a failure shows only on `/status/integrity`.

| Step | Who | When | Done (date, in the go-live log) |
|---|---|---|---|
| 1. Deploy this build; re-run `app-role.ts grant`; the next morning, open `/status/integrity` and check `seal-written` is `info` (genesis) | operator | the deploy night, and the morning after | |
| 2. **The owner sets `ALERT_WEBHOOK_URL`** in Vercel (Production) to the operators' channel (§5f) and redeploys; a test alert is optional | owner | before or with step 1 — **open owner question: the channel and the date** | |
| 3. **The one-line enable commit:** `INTEGRITY_INAPP_ALERTS_ENABLED = true` in `lib/integrity/policy.ts` (and its unit test), deployed | operator | the first working day after this build has served production through one nightly run and passed smoke (it is then the rollback target, so no build that cannot read `INTEGRITY_ALERT` is left to roll back to) — **the owner sets the date** | |
| 4. Gap 29 closed: step 2 and step 3 are both dated above | operator | after 2 and 3 | |

**Decided by the owner (2026-10-24, 2026-10-25).** Which checks alert: every check above alerts on any non-zero count, except the information checks (`test-scaffolding-mixed`, `app-login-is-runtime-role`, the two behaviour checks, and since 2026-10-25 `cr-number-shared`) and the information lists (and `db-rules-older-rows`, information by its design since gap 31: an older row is known and counted, not a new fault); `scheduled-jobs-on-time` alerts only for `sla-escalate`, `db-backup` and `integrity-watch`, and lists every other job's missed runs as information (a new job is information until it is added to `ALERTING_JOBS`). The owner named the SLA sweep and the watch itself, and made the warning-tier jobs information; the nightly dump, the other job the heartbeat tiers critical (§5d), was not among them and still alerts — taking it out is one line in `ALERTING_JOBS`. The retention periods (DATA-RETENTION-SCHEDULE.md) were accepted by the owner on 11 October 2026.

**Open owner questions (the safe default built is in brackets).** At what count a check alerts [any non-zero count]; how `customer-status-follows-shops` treats **review** cases [information, not counted: the rule leaves them, and a person decides each]; how often the Steward is told [once per Steward per Oman day]; whether the seal findings should alert every night while they stay [once per event, then information]; whether a planned change (a PDPL erasure, a repair in a maintenance window) may be **acknowledged** in the system so it does not raise the critical alert [no: an acknowledgement the owner login can write would let that same login silence the alert for its own change; the explanation goes in the private operations log]; whether `integrity-watch` should be a critical heartbeat [warning]; the thresholds of the two behaviour checks [information only].

## 5m. Go-live clean start (owner decision 2026-11-11)

Before the pilot, everything the TEST period left in production is removed once, and the
real customer file is then loaded through the Import screen. The owner presses every
button that changes production himself, in GitHub; his step-by-step, in plain words, is
[`docs/GO-LIVE-CLEAN-START.md`](GO-LIVE-CLEAN-START.md). This section is the operator's
reference: what the run does, in the order the workflows do it. Where the workflows and
the design notes differ, this section and the owner's guide follow the workflows (the
differences are listed at the end).

### What it removes and what it keeps

By owner decision of 2026-11-11 (each open point built with the recommended default):

| | Tables (`scripts/ops/clean-start/tables.json`, pinned to `prisma/schema.prisma` by `tests/unit/clean-start-tables.test.ts`) |
|---|---|
| **Emptied** (one `TRUNCATE … CONTINUE IDENTITY RESTRICT`) | customer data: `Customer`, `Branch`, `Attachment`, `CustomerEdit`, `EditCustomerDraft`, `EditBranchDraft`, `EditApproval`, `EditRevision`, `Notification`, `ImportBatch`, `ImportRow`, `TemixSyncBatch`, `ExportJob`; logs: `AuditLog`, `AuthEvent`, `JobRunDay`, `PurgeSummary`, `IntegrityCheckResult`, `SealRecord`, `RateLimit`, `SavedView`; history: `CustomerHistory`, `BranchHistory`, `AttachmentHistory`, `UserHistory`, `RouteHistory`, `RouteOwnerHistory`, `RegionHistory` |
| **Partly** | `CodeSequence`: the `CUSTOMER-YYYY` counters (the next CRM-created customer is `NMWC-<year>-000001`, unless the real file brings NMWC codes, which the counter then skips past by itself). `CronRun`: rows older than the start of the Oman day before the reset (yesterday's and today's stay, so the first night's job check is true) |
| **Kept, byte for byte** | `User` (the hidden `zz.test.*` accounts too), `PasswordHistory`, `Region`, `Route` (`ZZTEST`, `ZZTEST-R1` and any `UNASSIGNED` region and route too), `_ManagerRegions`, `Channel`, `SubChannel`, `CronHeartbeat`; `_prisma_migrations` is not touched |

In the same transaction the four history tables of kept records get one `BASELINE` row
per region, route, account and route holder (the SQL of
`20261013100100_history_foundation`, with only the source, kind and actor changed), and
`AuditLog` gets exactly one row, `cleanstart-<run>`, with the run, commit, plan id,
backup, the hashes of the exported photo-key list and seals, the old chain, the archive
prefix, the Neon safety branch and the removed and kept counts. **No screen shows those
counts**: the Audit page lists the row (when, who, action, reason) but not its `after`
detail. The counts are read from the run's encrypted report
(`cleanstart/<run>/report/`), by Claude with the owner; showing them on the Audit page
is an app follow-up (below). No sequence is reset. Nobody is signed out: the accounts are
not touched, which is part of the proof that nothing real changed. Saved filters are
deleted (they were built on test data).

Outside the database: the old seal files under `seals/v1/<old chain>/` in the photo
bucket are copied to the backups bucket (`cleanstart/<run>/seal-archive/`), each copy
re-read and hash-checked, and only then removed from the live folder; any other object
under `seals/` is left alone. The test photos are deleted **at least 7 days later**, in a
separate run, only the keys production's `Attachment` rows held at the reset; an upload
no record pointed to is never touched, and (with the read-only test-environment secret)
a key the test environment also uses is kept.

### What does it

| Piece | What |
|---|---|
| `tables.json` | every table: EMPTY, PARTIAL (CodeSequence, CronRun) or KEEP |
| `plan.sql`, `guards.sql`, `fingerprint.sql` | the read-only checks (SQLSTATE `CS001`-`CS012`) and the exports (photo-key list, seals, plan, plan id), bound together by one plan id |
| `reset.sql`, `selfcheck.sql` | ONE transaction as the owner login in the §5e window: the checks again under SHARE locks, the plan id again (`CS013`), the `TRUNCATE`, two partial DELETEs, the AuditLog row, the baselines, the self-check (`CS101`-`CS113`), COMMIT |
| `verify.sql` | after COMMIT, read-only; `CS301` means the reset row is not there, so nothing changed |
| `facts.sql`, `counter.sql`, `photos-record.sql` | small read-only questions; the next customer number in a rolled-back transaction; the photo run's one AuditLog row |
| `run.sh`, `target-guard.sh` | the targets (the shared host list `config/production-hosts.txt`; the typed `confirm_host` and phrase), the public-log rule, encryption, storage, the GitHub and Neon calls. Neither names a database client: every database command is written in the workflow file and writes to a file |
| `seal-archive.sh` | the old seal files: `verify`, `archive`, `retire`; `restore` after a rollback |
| `photo-delete.sh` | the day-7 photo deletion: `check`, then `delete` |
| `rehearse-watch.ts`, `compare-watch.ts`, `expected-watch.json` | the first two nights of the integrity watch on a reset copy, and the first night on production, against the expected status table |
| `.github/workflows/clean-start.yml` | jobs `Plan (read-only)`, `Rehearse on the restored backup`, `Neon rehearsal`, `Apply (the owner's approval)`, `Finish an apply (steps e-j)`, `Seal restore (after a rollback)`; modes `dry-run`, `neon-rehearsal`, `apply`, `finish`, `seal-restore` |
| `.github/workflows/clean-start-photos.yml` | the photo deletion (phrase `DELETE TEST PHOTOS`) |

Every run is started by hand (`workflow_dispatch`), on `main` only (`run on the default
branch` is checked first), one at a time (`concurrency: clean-start`, never cancelled).
Every job that holds the Neon key, the read-write photo token or `PROD_CRON_SECRET` waits
for the owner's **Approve** on the GitHub environment `production-reset`. No artifact is
uploaded; every plaintext file is shredded in an `always()` step.

**The inputs, as the Run workflow form shows them.** `mode`; `confirm_host` (required in
every mode; the first part of the production database host, the first line of
`config/production-hosts.txt`); `confirm_phrase` (apply only:
`REMOVE ALL TEST DATA <today's date in Oman, YYYY-MM-DD>`); `run_id` (finish and
seal-restore only: the apply run's id, the long number in its address after `/runs/`).
The photo run: `run_id`, `list_sha256`, `confirm_host`, `confirm_phrase`
(`DELETE TEST PHOTOS`).

### The checks before anything changes (job "Plan (read-only)", every mode but finish and seal-restore)

- every setting the job needs is present (each missing one is named); the run is on `main`;
  in mode apply the evening window 15:30-23:30 UTC (19:30-03:30 Oman); every job that
  waits for the owner's Approve (apply, finish, seal-restore, photos) checks again that
  `production-reset` still has a required reviewer before it does anything;
- `DIRECT_URL` is production now (the first line of the host list) and `confirm_host`
  names it; in mode apply also the phrase (`target-guard.sh apply`), before the rehearsal;
- `/api/health` serves this run's commit; environment `production-reset` has a required
  reviewer; no DB Backup run is queued or running; in mode apply a green `neon-rehearsal`
  run on `main` of the same `scripts/ops/clean-start` tree and the same `clean-start.yml`
  within 14 days (a dry run only records it);
- the newest `db/*.sql.gz.age` has a manifest and is at most 4 hours old (so **every**
  mode, the Neon rehearsal included, starts with a fresh DB Backup run); from 15:00 UTC
  the dump must also be from after 15:00 UTC that day (an earlier dump lacks the reset
  day's last windowed job runs, and the rehearsal's night 2 would fail on a gap production
  does not have); the DB Backup heartbeat is at most 4 hours old;
- recorded yes/no for the owner: job runs for yesterday and today (Oman), and whether a
  windowed job ran outside 03:00-15:00 UTC in the last 3 days (an outside scheduler still
  on); refused when production's latest `runtime-role-privileges` result is `fail` or
  `error` (the rehearsal's copy has no grants, so this is the only place it is seen before
  the reset);
- `plan.sql` in a read-only session: the table list, ownership, foreign keys, triggers,
  migrations equal to the checkout's, only `CUSTOMER-YYYY` counters, no export or Temix
  file key, no photo under `seals/`, the actor (`CLEANSTART_ACTOR_USERNAME`) exactly one
  active real account, no clean start recorded yet; then the exports, bound to the plan id;
- the old seal copies (read-only photo token): a copy that differs from its seal refuses;
  a missing copy is allowed (its body is archived from the export); objects under
  `seals/` that are not production's chain are listed;
- the exports are stored age-encrypted under `cleanstart/<run>/plan/` in the backups bucket.

### Dry runs (mode `dry-run`; changes nothing on production)

"Rehearse on the restored backup" downloads the dump the plan picked, decrypts it,
restores it into a Postgres 17 service container, runs `restore-verify.ts --manifest`,
and runs `plan.sql` on it: its plan id must equal production's (`backup equals
production: yes`), which proves the backup holds exactly what the reset will remove and
keep. A sign-in or any other write between the backup and the plan changes the plan id
(a sign-in writes `User.lastLoginAt`), so nobody may use the CRM from the DB Backup run
until the dry run is green. Then: the old chain verified on the copy (recorded only), the
identical `reset.sql` (timed) and `verify.sql`, the integrity watch run twice (the reset
evening and the next Oman morning) against `expected-watch.json`, `pg_dump` of the result
through the nightly backup's own gates and size floors (`first nightly backup would be
below the size floor: yes; set MIN_DUMP_BYTES to <n>` names the value to set), and the
next customer number (`next customer code would be number 000001: yes`).

### The Neon dress rehearsal (mode `neon-rehearsal`; once, approval-gated)

Plan, then (after Approve) a temporary branch `cleanstart-rehearsal-<run>` of the
default branch with a compute; its host must not be production. The default branch
itself must be production's: one of its endpoints has the host of the first line of
`config/production-hosts.txt` (`Neon default branch is production: yes`), checked
before this branch and before apply's safety branch are made. Its fingerprint is taken
and the time noted; the reset and verify run on it, then the watch; then Neon makes a
new branch `cleanstart-rehearsal-<run>-at` from the rehearsal branch's history at the
noted time (a branch create with `parent_timestamp`: Neon's own point-in-time
`/restore` works on root branches only, and the rehearsal branch is a child), the reset
row must be gone there and the plan id must return exactly
(`the Neon restore returned the exact fingerprint: yes`). Both branches are deleted in an `always()` step, the newer
first (Neon refuses to delete a branch with a child); if one is left, the run says so and
the owner deletes it by hand. This proves Neon's history holds the noted time on a
branch of production; it does not exercise the console Restore of the production (root)
branch itself, rollback route 1. `branch equals production's plan` is only recorded: the proof is that the
restore returns the branch's own fingerprint. Apply needs a green run of this mode with
the same scripts within 14 days, so it is repeated after any change to
`scripts/ops/clean-start/`.

### Reset day (mode `apply`)

The owner first writes the private operations-log entry (§5e step 1) and tells staff to
stay out of the CRM (every tester signed out on every phone beforehand); runs DB Backup; then starts `apply` between 19:30 and 22:00
Oman time (the phrase carries the Oman date, which changes at 20:00 UTC, and is checked
again at the reset). Plan and Rehearse run as in a dry run (about 20 minutes). The Apply
job then waits for **Approve** on `production-reset`: that click is the yes. Apply:

- a. the checks again (window, production, release, reviewer, backups idle, the green
  Neon rehearsal; the newest backup at most 6 hours old and still the one rehearsed;
  `plan.sql` again: `production unchanged since the plan: yes`; heartbeat); the exports
  stored again under `cleanstart/<run>/apply/` (the later modes read this copy);
- b. Neon safety branch `pre-clean-start-<Oman date>-<run>` of production, no compute;
  `Neon history kept at least 7 days` recorded;
- c. the old seals archived (additive), re-read and chained;
- d. `target-guard.sh apply` (production, `confirm_host`, the phrase), `reset started at
  (UTC): …` and `reset started at (Oman time): …` printed and a marker written to disk,
  then `reset.sql` on production;
- e-f. `verify.sql` read-only settles it: `reset committed: yes` (only when `CS301`
  passed), `no (nothing changed)` (`CS301` alone), or `unknown (…)` with
  "run mode finish with this run id" (no connection, or an error before `CS301` was
  decided); `kept accounts, routes and regions verified after the reset: yes`;
- g. the old seal files removed from `seals/`, each only with a verified archive copy;
- h. the integrity watch through the app (`/api/cron/integrity-watch`); the new chain's
  id (the first 16 hex of its first seal's hash) recorded encrypted under
  `cleanstart/<run>/chain/` (`new seal chain id recorded: yes`) for `seal-restore`; the
  first run compared with night 1 of `expected-watch.json` (`first integrity checks as
  expected: yes`; `seal-written: info` is the new chain's first seal);
- i. `npm run smoke -- <APP_BASE_URL> --expect-commit <sha>` (`smoke ok: yes`);
- j. the encrypted report under `cleanstart/<run>/report/`, then `run_id for the photo
  step`, `list_sha256 for the photo step` and `reset started at (UTC)`.

The safety branch is deleted only when it is certain the reset did not commit (it never
started: no marker on disk and no exit code; Postgres refused it; or verify read
`CS301`); otherwise `Neon safety branch kept: yes`. The decision reads the files on disk
as well as the job environment, which a cancelled step may never apply. Production is left alone for about 75-90 minutes, from the backup to green;
the tables are locked for seconds.

**When objects under `seals/` are not production's chain** (another environment's chain
folder, a non-seal object), `seal-offsite-copies` is `fail` on the first night and
`info` after, by design (`expected-watch.json` `withForeignSeals`): the integrity
watch's critical alert to the operators fires once, on reset night. It is explained in
the operations log; nothing is to be done about it.

**Mode `finish`** (input `run_id`, approval-gated) repeats e-j for an apply run whose
answer to the COMMIT was lost: it settles first; when the reset did not commit it
deletes that run's safety branch and fails with "the reset of that run did not commit;
nothing changed on production". Its `verify.sql` runs with `scope=finish`: only the
checks that stay true while the CRM is used (`CS301`, `CS304`, `CS305`, `CS307`); the
"still empty" checks (`CS302`, `CS303`, `CS306`) are skipped, so a saved view or a new
request does not block it. It calls the watch only when no watch has run since the
reset, so there is never a second "first" run. **Run it the same evening, before 06:00
Oman (02:30 UTC).** If the scheduled 02:30 UTC watch runs first (between the COMMIT and
the removal of the old seal files), that run reports the old chain's files under
`seals/` as `offsite-unexpected`: **one unexplained critical alert**. finish accepts that
run as the first one (every finding must be an object listed under `seals/` now, outside
production's new chain), but the alert has already gone out. A second `apply` after a
committed one is refused by `CS012`.

### The next morning

Service status → Integrity: "Tonight's seal was written" (`seal-written`) is pass (seal 1)
and nothing fails except, at most, the one explained `seal-offsite-copies` line. The
night's DB Backup run is green (if the dry run said the first backup would be below the
size floor, the repository variable `MIN_DUMP_BYTES` was set to the value it named on
reset evening; it is deleted again once a nightly DB Backup log after the real import
shows `compressed size: <n> bytes` with n at least 80000: a green run alone only proves
the lowered floor). Nothing checks night 2 automatically on production: the owner reads
Service status the next morning. Nor is there a table for the first night after the real
import (night 3); the regular alerting applies. Only then is the real customer file loaded through the Import screen (codes in
capitals, as in the preview). That import is the database's point of no return.

### The photo step (day 7 or later; `clean-start-photos.yml`)

Approval-gated, phrase `DELETE TEST PHOTOS`, inputs `run_id` and `list_sha256` from the
apply run's summary. It refuses unless the reset row `cleanstart-<run_id>` exists and is
at least 7 days old, the sha256 of the stored list (`cleanstart/<run_id>/apply/photo-keys.txt.age`)
equals both the typed value and the reset row's value, and no production `Attachment`
row references a listed key (one hit means a rollback happened: everything is refused).
Before anything is deleted, the read-write photo token writes a throwaway object
(`cleanstart-probe/…`), reads it back and deletes it (`photo-delete.sh probe`): a
read-only, expired or revoked token, or a wrong bucket name, is refused there, with
nothing deleted. Then it deletes the Neon safety branch FIRST (no rollback may be left
pointing at missing files), skips keys without the photo shape, keeps keys the test
environment references (only when `UAT_DATABASE_URL_RO` is set; otherwise `test
environment checked for shared photos: no (no read-only UAT connection set)`), deletes
the rest in batches of at most 1000 and HEAD-checks each. It then writes one AuditLog row
per run attempt: `cleanstart-photos-<run>` for the first, `cleanstart-photos-<run>-<N>`
for a re-run attempt N (`photos-record.sql`). The row stores `complete` and `runAttempt`
with the counts; if the delete step was red, the row has `complete` false and its reason
says the deletion did NOT complete. The encrypted report goes under
`cleanstart/<run_id>/photos-<run>-<attempt>/`, one folder per photo run and attempt, so
a re-run never overwrites an earlier report. It cannot be undone. If bucket versioning is
on, the bytes linger up to 30 days.

### Going back

**Before COMMIT** every failure (a guard, a changed plan id, a lock or statement timeout,
the self-check, a lost connection) rolls the one transaction back. The seal archive and
the safety branch are additive.

**After COMMIT and before the real import**, the database, in order of preference:

1. Neon console → Branches → the production branch → Restore, to the `reset started at
   (UTC)` time in the run summary minus one minute (Oman time is UTC + 4). Same host, no
   redeploy. The Neon rehearsal proved such a restore returns the exact fingerprint.
2. The same Restore, from the branch `pre-clean-start-<date>-<run>`. Independent of the
   history window.
3. §6.5: the pre-reset dump into a new Neon branch, then repoint. Hours, and a redeploy.

Then mode `seal-restore` (input `run_id`, approval-gated): `production is back to before
the reset (old chain, no reset row): yes`, the archived old seal files copied back
(hash-checked), the new chain's objects moved to `cleanstart/<run>/abandoned-chain/`, the
watch once (`a check failing or in error: no`; a failing check makes the job red).
Only the recorded new chain's folder `seals/v1/<new chain>/` is moved: the photo bucket is
shared with the test environment, whose own chain keeps growing under `seals/`, so every
other object is left where it is (`other objects under seals/ left where they are`), and
without the recorded id nothing is moved: when apply stopped at step g or h before
recording it, the archived old files still go back, and the run refuses only if a chain
folder `seals/v1/<id>/` is there that is neither the old chain nor in the apply's list of
other objects at the reset (`every seal chain under seals/ is the old one or was there at the reset: yes`). Run it straight after the restore, the same
evening: a 02:30 UTC watch between the two reports the new chain's files as a critical
alert. Then delete `MIN_DUMP_BYTES` if it was set, and, once the rollback is confirmed,
delete the safety branch and Neon's preserved pre-restore copy (Claude names them; the
owner deletes them). The CRM is open again when seal-restore is green and Claude confirms.

**Points of no return**, each as late as possible: the database, at the first real write
(the owner's import of the real file); from then on, fix forward only. The photos, at the
photo run (it deletes the safety branch first). By themselves: Neon history ages out
(7 days documented) and the pre-reset dumps expire after 30 days (the `db/` lifecycle);
after that the test period cannot be recovered, which is the intent. **Never restore a
pre-reset dump or point in time after the photo deletion**: its `Attachment` rows would
point at nothing.

### Clean-up of tokens and secrets

After the photo step: delete the two Cloudflare R2 tokens made for this; delete the Neon
API key made for this; delete the repository secrets `CLEANSTART_ACTOR_USERNAME`,
`CLEANSTART_R2_RO_ACCESS_KEY_ID`, `CLEANSTART_R2_RO_SECRET_ACCESS_KEY` and the
environment secrets of `production-reset` (`CLEANSTART_R2_RW_ACCESS_KEY_ID`,
`CLEANSTART_R2_RW_SECRET_ACCESS_KEY`, `NEON_API_KEY`, `NEON_PROJECT_ID`,
`UAT_DATABASE_URL_RO`). The repository-level `NEON_API_KEY` and `NEON_PROJECT_ID`, when
they exist, belong to the monthly restore drill (§6) and stay. The environment
`production-reset` itself stays, with its required reviewer: a workflow naming a deleted
environment would recreate it with no reviewer. `lib/ops/required-secrets.ts` names the
clean-start secrets under "the go-live clean start".

### Public log, and where the record lives

The repository is public, so are its Actions logs and run inputs. Every database command
writes to a file; the log and the step summary show only step names, `<label>: yes|no`
lines, SQLSTATE codes, check ids with statuses, durations and hashes (12 or 64 hex); a
refusal is one fixed sentence, `clean start refused: …`. Counts, names, keys and the
integrity results exist only in the age-encrypted copies under `cleanstart/<run>/` in the
backups bucket (outside the 30-day `db/` rule) and in the reset's own AuditLog row.
`tests/support/clean-start/public-log.ts` is the allowlist the tests hold every printed
line to.

The record of the clean start: in the CRM, the AuditLog row `cleanstart-<run>` (the
first row of the new log) and the BASELINE history rows sharing its transaction; outside
it, the GitHub run and its approval, the encrypted plan, apply, report (and photos)
copies and the seal archive under `cleanstart/<run>/`, and the owner's private
operations-log entry, written before and completed after. The compliance notes:
`docs/compliance/DATA-RETENTION-SCHEDULE.md` and `RECORDS-OF-PROCESSING.md` (dated notes).

### After it (separate changes)

`lib/insights/policy.ts` `HISTORY_BASELINE_DAY` moves to the reset day (until then a
dashboard window reaching back before the reset compares with emptied days; planned for
reset day + 1); `db-backup.yml` stops printing the total row count; `lib/test-records.ts`
`KNOWN_TEST_RECORDS.customerCode` is no longer a test record (§7, "Flag a test record");
the Audit page shows the reset row's removed and kept counts (owner question 10, default
yes; today they are only in the encrypted report).

### Tests

`tests/unit/clean-start-tables.test.ts` (the table list against `prisma/schema.prisma` and
against every foreign key in the migrations; it pins the newest migration the list was
checked against, `20261111120000_import_shop_notice_ack`, the 42nd, so a later migration
fails it until the list, `guards.sql` and the fingerprint are checked again), `clean-start-sql.test.ts` (the SQL's rules and
mutations), `clean-start-run.test.ts` (the shell scripts against local stand-ins, every
refusal, the public-log rule), `clean-start-workflows.test.ts` (both YAML files),
`clean-start-codes.test.ts` (every refusal code raised once under a real condition; the
plan id covers all eight fingerprint parts), `clean-start-env-headers.test.ts` (what step
env headers may show) and `clean-start-docs.test.ts` (the guide quotes only real lines);
`tests/integration/clean-start.test.ts` (`RUN_CLEAN_START=1`, CI's db-tests);
`tests/integration/clean-start-watch.test.ts` (`RUN_CLEAN_START_WATCH=1`, the watch
runner the workflow calls); `tests/integration/clean-start-flow.test.ts`
(`RUN_CLEAN_START_FLOW=1`, a local cluster): every mode of both workflows end to end
against a seeded "production", including a connection lost at COMMIT in both directions.
Not testable before the day: Neon, R2 and the GitHub API themselves (stand-ins only).

### Where the workflows differ from the design notes

- `PROD_DB_HOST_MARKER` is not read: it was retired for `config/production-hosts.txt`
  (2026-11-10) and a test forbids a workflow to read it. The owner does not create it.
- `confirm_host` is required in every mode, the photo run included.
- The plan job runs in `neon-rehearsal` too, so the Neon rehearsal also needs a DB Backup
  run of at most 4 hours.
- Some yes/no lines report a fact rather than a pass (listed in the owner's guide,
  "Lines that may say no"); "every line says yes" is not the rule, a green job is.
- The repository-level `NEON_*` secrets of the restore drill are not deleted at the
  clean-up; only the environment's.
- The step env headers of the public log show, besides the printed lines: the plan id and
  the hashes in full (64 hex), the 16-hex seal chain ids, the dump's object key (a time
  stamp), the safety branch's name and id, and the reset's start time and exit code.
  None is a secret, a figure or personal data; each is declared with its shape in
  `tests/support/clean-start/public-log.ts`, and anything holding a connection string or
  a random secret is masked before it is handed on.
- `Neon history kept at least 7 days` is recorded, not refused: going back then uses the
  safety branch (route 2), which does not depend on it.
- `PROD_CRON_SECRET` is first used at apply step h, after the reset (a fresh DB Backup
  heartbeat does not prove it). Calling a cron route earlier would run a production job.
- Facts that must not reach the public log (a Temix upload marked loaded, an `UNASSIGNED`
  region or route) are only in the encrypted `plan.json`, read with the owner after dry
  run 1.

## 5l. Database rules added NOT VALID, and the VALIDATE step (data audit gap 31)

**What changed.** The rules the application already keeps are kept by the database too (migration `20261025090000_db_rules_not_valid`; the single source is `lib/db-rules.ts`, which also holds what each rule is for and what a refused save tells the person). Every one was added **NOT VALID**: the migration scans nothing and changes no row, so it cannot fail on old data.

| Rule (constraint) | Table(s) | Refuses |
|---|---|---|
| `*_credit_terms_only_credit` | Customer | a credit limit or term days on a customer that is not CREDIT |
| `*_subChannel_needs_channel` | Customer, EditCustomerDraft | a sub-channel with no channel |
| `*_subChannelId_channelId_fkey` | Customer, EditCustomerDraft | a sub-channel that is not one of the channel's (composite foreign key to `SubChannel(id, channelId)`) |
| `*_primaryPhoneNorm_shape` | Customer, EditCustomerDraft | a phone de-duplication key that is not `+968` and eight digits (what `normalizePhone` writes) |
| `*_crNumberNorm_shape` | Customer, EditCustomerDraft | an empty CR key, or one holding a character `normalizeCR` removes or folds (lower case, spaces, invisible marks, Arabic or Persian digits) |
| `*_gps_in_oman` | Branch, EditBranchDraft | a point outside 16–27°N, 51–61°E (the forms' own bounds) |
| `Branch_gps_pair` | Branch | a shop with only one coordinate (a draft may hold one) |
| `*_gpsAccuracy_range` | Branch, EditBranchDraft | an accuracy outside 0–10,000 m |
| `*_equipment_counts_range` | Branch, EditBranchDraft | coolers or stands outside 0–100, empty bottles outside 0–1,000 |
| foreign keys, SET NULL | Customer (`createdById`, `lastEditedById`, `importBatchId`, `lastTemixUploadBatchId`), Branch (`createdById`, `lastEditedById`), Attachment (`customerId`, `branchId`), Notification (`customerId`) | a link to a row that does not exist; deleting the row it names leaves the link null |
| foreign keys, RESTRICT | CustomerEdit (`originalCustomerId`, `newRouteId`), EditApproval (`submitterRouteId`) | a link to a row that does not exist; deleting the row it names |
| `CustomerEdit_customerId_fkey`, `CustomerEdit_branchId_fkey` | CustomerEdit | changed from SET NULL to **RESTRICT**: a customer or shop a request names can no longer be hard-deleted (the application never does). No older row can break them (the old keys held), so they are not counted below and can be validated at any time |

**One live customer per Temix code (owner decision 2026-10-25).** Temix codes are unique, and the database now says so: migration `20261025120000_temix_code_unique` adds the partial unique index `Customer_temixCode_live_unique` on `upper(btrim("temixCode"))` `WHERE "deletedAt" IS NULL AND "temixCode" IS NOT NULL` — the key the nightly `temix-code-shared` check compares by, so `caa0367` and ` CAA0367 ` are the same code. It is **not** NOT VALID (a unique index cannot be): building it reads every live customer, and the migration fails if two already share a code. Archived customers are outside it (an archived customer keeps its code, and its Temix deactivation goes out under it); the application still refuses to give an archived customer's code, or a live branch's code, to anyone else (`lib/temix-code.ts` `temixCodeHolder`), and bringing an archived customer back while a live one holds its code is refused by the index. Prisma cannot describe an index on an expression with a WHERE clause, so it is not in `schema.prisma`; CI's drift gate allows it by name.

- **What a refused save tells the person.** The paths that write a Temix code check it first, under the code's lock, and name the holder (`temixCodeHolder`); the index catches what that check cannot see — an older row spelling the code with an outer space, or a writer that took no lock. Its refusal is answered naming the live customer that holds the code (`temixCodeRefusal`, in `temixCodeHolder`'s words: "Temix code CAA0367 already belongs to customer NMWC-2026-000123. Check the code in Temix: every customer has its own."): at the Accountant's approval in the code box (`TEMIX_CODE_TAKEN`; nothing is approved), and on the customer import's row (REJECTED, the same words; nothing is created or changed), on every lane. Any other path is told the rule without a name (`runAction`, `TEMIX_CODE_TAKEN`). No screen edits a Temix code today.
- **Deploy precondition — count before pushing.** A pushed branch migrates UAT, and the merge migrates production: the migration's first statement refuses, in counts only, when live customers share a code (`Customer_temixCode_live_unique: N Temix code(s) are each held by more than one live customer`). The deploy then stops before `next build` (the previous build keeps serving), nothing of the migration is applied, and it is recorded as failed: every later build is refused with P3009 until it is marked rolled back, as in §5 "A migration refused by a lock", steps 1–3, once the data is corrected. Production held none, live or archived, on 2026-10-25 (read-only). Count UAT and production again, read-only, just before (production through `prod-run.cjs`, §5j):

  ```sql
  SELECT count(*) FROM (SELECT upper(btrim("temixCode")) FROM "Customer"
   WHERE "deletedAt" IS NULL AND "temixCode" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
  ```

  Anything but 0: correct or merge those customers first (the nightly `temix-code-shared` lists them), then deploy. The index is built in seconds at this size; the migration's `lock_timeout` is 10 s (writes to Customer wait while it builds).
- **Rollback.** Additive: an older build runs on it. Its paths answer a refusal as a generic conflict ("This value conflicts with an existing record") instead of naming the holder. Removing the rule is a migration of its own (`DROP INDEX`), never an edit of this one.

**What NOT VALID means — read before any change that saves old rows.**

- A NOT VALID **CHECK** is evaluated on **every INSERT and every UPDATE** of a row, an update to an unrelated column included. An older row that breaks one can **not be saved again by any path** until it is corrected: an edit, an approval, a merge, an archive, the Temix refresh, a customer-status follow, a completeness rescore, or a user delete that sets its creator to null. The person is answered in the rule's own words, never a value (`DATA_RULE`, from `lib/db-errors.ts` `dbRuleViolated` through `runAction`; for example "This customer's stored record breaks a data rule (credit figures on a cash customer). Ask the Data Steward to correct it."); the import names the constraint on the row. Since the code review of 2026-11-10 (finding 27) an approval, a Manager's or Steward's direct write and a reactivation write only the shop the request is about and the completeness scores that actually change (`lib/shop-rescore.ts`; they used to re-save every shop of the customer), so an older sister shop no longer blocks a change to another shop unless its own stored score is wrong; when a shop rule refuses a sister shop's score write, or the write of the shop an update or close request changes, the refusal names the shop by its code ("Shop B-0042's stored record breaks a data rule (a location outside Oman). …"): correct that shop. One exception: the reopened shop's own write in a reactivation keeps the generic words ("This shop's stored record breaks a data rule (…)"), without the code — the Manager is deciding that shop, and it is the one to correct.
- A NOT VALID **foreign key** is checked only when its own columns change. An older orphan (UAT held 232 notification orphans) can still be saved as long as its link is left alone.
- **One such row fails a whole statement, not just itself.** A write that changes many rows in ONE statement (an `updateMany`) is refused whole if any one of its rows breaks a CHECK, and nothing it would have written is written. Where that happens:
  - **Temix Generate** claims the whole queue in one statement. It now tests the locked queue against the Customer CHECKs first (`lib/db-rules.ts` `brokenChecks`) and **holds a breaker back**: left queued, named to the Steward under the Generate button ("Also not in this file, still queued: …") and on the batch's `EXPORT` row with the rule (`heldForRules`), as F11 holds back a shared code. Everyone else goes out. The held customer goes out with the first Generate after its record is corrected.
  - **Temix Mark loaded** settles a batch's archived rows in one statement. It refuses a batch whose archived rows break a rule, **naming them and the rule**, and marks nothing; the batch can be marked once they are corrected. Only a batch generated before the rules were live can hold one, so **finishing every Temix batch before the deploy is a precondition** (loaded into Temix, then Mark loaded): the report's `settling` column below must read 0, or those batches be finished, before the merge.
  - **A merge** moves the losing customer's shops in one statement: one shop that breaks a Branch rule refuses the merge, in the shop rule's words (no shop named). Correct the shop, then merge.
  - **Operator scripts that write many rows at once** (`requeue-untracked.ts`, `zero-credit-limits.ts`, `visitdays-from-sheets.ts`, `apply-quarantined-visit-days.ts`): run `db-rules-report.ts` first; a tranche that holds a breaker fails whole, and nothing in it is written. Correct the rows, or leave them out of the run. `recompute-cr-norm.ts` writes one customer per statement, but it corrects only the CR key: a customer that also breaks another rule still fails, and stops the run there.

**Before the rules merge, count production** (read-only, through `prod-run.cjs`, §5j):

```bash
NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs \
  scripts/ops/db-rules-report.ts --expect-host ep-sweet-haze
```

It prints, per rule, how many rows break it and whether it is present and validated — names and counts only, never an id. Every CHECK with rows here means saves of those rows will be refused once the rules are live, each alone, and **any statement that writes one of them with other rows is refused whole** (above): decide with the owner whether to correct the rows first or to ship and correct them as they surface (open question, 04-PENDING-WORK A9). A second table counts the Customer rules on the Temix paths: `queued` (rows Generate will hold back, named, until corrected) and `settling` (archived rows of a batch not yet marked loaded — **must read 0, or those batches be finished, before the merge**; the report prints `DEPLOY PRECONDITION` while it does not). After the deploy, the nightly check `db-rules-older-rows` (§5k) gives the same counts with sample ids (`rule:row id`) on `/status/integrity`.

**Correcting the rows.**

- **CR keys** written before the CR rule of 2026-09-25 (item 16): `scripts/ops/recompute-cr-norm.ts` (dry run first; it recomputes `crNumberNorm` from `crNumber`).
- **Notification orphans:** null the link (`UPDATE "Notification" SET "customerId" = NULL WHERE …`), in a logged window, **only with the owner's OK** — the notification text still names the customer.
- **Everything else** (credit figures on a cash customer, a sub-channel of another channel, a point outside Oman, a single coordinate, a count over its cap, a phone key in another shape, a dangling creator or batch): correct it through the app where a screen allows, or decide each with the Data Steward. Never correct a row by switching a rule off.

**The VALIDATE step — one rule at a time, by a new migration.** When `db-rules-older-rows` shows **0** for a rule on UAT **and** `db-rules-report` shows 0 for it on production, add a migration of its own:

```sql
ALTER TABLE "Customer" VALIDATE CONSTRAINT "Customer_credit_terms_only_credit";
```

- VALIDATE scans the table and **fails the migration on any row that breaks the rule** — which blocks the deploy. CI's database starts empty, but **UAT applies every pushed migration** (a branch push builds a preview that migrates UAT), and UAT holds its own older rows (232 notification orphans on 2026-10-10): count UAT before pushing.
- VALIDATE takes SHARE UPDATE EXCLUSIVE on the table (and ROW SHARE on the referenced table for a foreign key): reads and writes go on.
- After it, the check shows `validated: true` for the rule. The two re-added request keys and `CustomerEdit_routeIdAtSubmit_fkey` (gap 18) can be validated at any time.
- The restore check (`scripts/ops/restore-verify.ts` T-04, T-05) accepts exactly these constraints, by name, unvalidated; any other unvalidated foreign key or CHECK on a restored database still fails it.

**Not added, and why.** Address and name lengths (the import accepts any length; the address minimum is already `Branch_address_minlength`); display phones (`primaryPhone`, `altPhone`: typed formats in older rows and fixtures, and `altPhone` has no key — the phone key above is the guard); the Temix code's shape (three migrated codes hold a space, so a CHECK would refuse every later save of those customers; the nightly `temix-code-shape` stays); a unique live CR (the owner's decision, confirmed on 2026-10-25: CR numbers are not unique — one company can trade as several customers — but every shared one is flagged by the nightly `cr-number-shared`, §5k; UAT holds one shared value); (a unique live Temix code was added on 2026-10-25, above; the daily Temix import, when it is built, refuses a row whose code another live customer holds and flags it for the Steward instead of creating a duplicate); CREDIT carrying a limit, and a limit carrying term days (the refresh lane can write one without the other; UAT has three credit customers with no limit); the e-mail rules (the refresh lane can flip CREDIT to CASH without clearing the e-mail, and `isEmailAddress` cannot be written exactly in SQL); a shop's region equal to its route's (already the triggers `branch_region_consistency_check` and `route_region_fixed`); a photo's kind matching its slot, and the draft photo slots' links (cross-row triggers that photo-gc's hard deletes would meet); the ledger and history links (no foreign key on purpose: the ledgers outlive the rows they describe); id lists in arrays or JSON (no foreign key is possible); the account rules (role, route and regions; not covered in this pass).

**A correction.** The comment in migration `20260510160000_p1_drop_phone_unique` says a `crNumberNorm` partial-unique index exists. There is none: `Customer_crNumberNorm_idx` is an ordinary index. Migrations are never edited once applied, so the correction is in the header of `20261025090000_db_rules_not_valid`, here and in AUDITOR-BRIEF §7.

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

### 6.3a Point the guards and the backup at the new host

Runbooks A, B and C all end with production on a **new database host** (a new Neon branch has its own endpoint id; a new provider, a new host). Two things do not follow by themselves, and both fail silently (code review 2026-11-10, finding 14):

- **The safety guards** recognise production only by the markers in `config/production-hosts.txt`. Until the new host is listed, the seeds, test suites and clean-up scripts no longer see the real production as production, and `scripts/dev/prod-run.cjs` refuses to run anything on it.
- **The nightly backup** reads the GitHub repository secret `DIRECT_URL`, not Vercel's. Left on the old host it dumps the old, dead database every night. Since this review it refuses a host that is not on the first line of the list, and a nightly run fails when the newest record in what it dumped is more than a day old — but fix it here rather than wait for the red run.

Do these steps, in this order, as soon as the new host serves production:

1. **Update the list.** On GitHub, open `config/production-hosts.txt` on `main` and edit it in the browser: put the new host's marker on the **first** line — the start of its host name: for Neon the endpoint id's words **without** its random ending (`ep-<word>-<word>`, as `ep-sweet-haze` is today; this repository is public and the full endpoint id stays out of it), at least 6 characters, and **keep** the old marker on a line below it — the old database still holds real customers, and listed it stays protected. Commit to `main`. Remove a marker only when its database has been deleted. From now on operators type the new marker after `--expect-host`.
1a. **Pull the new list onto every computer.** Every guard on a computer reads the list from **its own copy** of the repository, not from GitHub, so the edit in step 1 protects nothing on a computer until it is pulled there. On every computer, in every clone and worktree of this repository, run `git pull` on `main` before running anything else — **first** the clone whose `.env` holds the production connection strings (the one Vercel's values were copied into). Then, in that clone, run `node scripts/dev/env-check.cjs`: its "production list" line must name the new marker first, and it must say `PRODUCTION` for the variables that now point at the new host (and end with `STOP` — expected here, it means the guards see production). If it says `not production` for them, that clone still has the old list: pull again before running anything there. Until a clone has pulled, its seeds, test suites, clean-up scripts and `env-check` do not treat the new host as production, and `prod-run.cjs` refuses it.
2. **Update the GitHub `DIRECT_URL` secret** (Settings → Secrets and variables → Actions) to the new host's owner connection string — the same value as Vercel Production's `DIRECT_URL`.
3. **Run the backup by hand:** Actions → **DB Backup** → Run workflow.
4. **Check its newest-record time is today.** Open the run's summary: "newest record in this database (UTC, checked after the upload)" must be today's date (UTC). That is the database's newest record when the check ran, after the dump and the upload, which is what tells a live database from a dead one; the line below it, "newest record before the dump (UTC, from the manifest; the backup holds at least this)", is the newest record the backup is sure to contain (third round of the review). If it is older, the app has not written to the new database since the switch: sign in to the app once (a sign-in writes an audit row), or wait for the next scheduled job (keep-warm runs every 4 minutes from 03:00 to 15:00 UTC), and run the backup again. If it is still old, `DIRECT_URL` (the secret) and Vercel's `DATABASE_URL` name different databases — stop and compare them. A run by hand only warns about an old record; the nightly run fails on it.

The repository variable `PROD_DB_HOST_MARKER` is no longer read by any workflow (the list replaced it); it can be deleted.

### 6.4 Runbook A — Neon point-in-time recovery

Use when the damage is recent and the database itself is healthy.

1. **Stop the bleeding.** If an import is running, abort it. There is no maintenance mode and no way to tell 106 field users to stop — see §6.8.
2. In the Neon console, create a branch from production **at a timestamp before the damage**. Neon branches are copy-on-write, so this is instant and costs storage only.
3. Point a psql session at the new branch and sanity-check the data you expected to recover.
4. Re-create the runtime role on it: `ALLOW_PRODUCTION=1 DIRECT_URL='<branch owner URL>' NMWC_APP_PASSWORD='<new>' npx tsx scripts/ops/app-role.ts create` then `grant`, then `verify` with `NMWC_APP_URL`.
5. Verify the restore properly: `npx tsx scripts/ops/restore-verify.ts --url '<branch owner URL>' --expect-app-role`.
6. Promote the branch to the primary in the Neon console, or repoint Vercel Production `DATABASE_URL` / `DIRECT_URL` at it and redeploy.
6a. **Point the guards and the backup at the new host — §6.3a, every step:** the new marker first in `config/production-hosts.txt` (the old one kept), `git pull` of that list into every clone and worktree on every computer (the production `.env` clone first, then `env-check` there), the GitHub `DIRECT_URL` secret to the new host, the backup run by hand, and its newest-record time checked to be today. Do it before anything else runs on the new production: until then `prod-run.cjs` refuses it and the other guards do not see it as production.
7. **Revoke sessions.** Set `sessionsRevokedAt = now()` on every user, or rotate `AUTH_SECRET`; otherwise a JWT issued before the restore still authenticates against the restored user table.
8. Confirm: `curl -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health` — `checks.db: ok` and no cron alarms.

### 6.5 Runbook B — restore the nightly dump into a new Neon branch

Use when the damage predates the PITR window, or PITR cannot reach a good state.

1. Steps 1 from Runbook A.
2. Create a Neon branch. **It arrives as a copy of production** — Neon has no empty-branch primitive — so empty it first: `psql "$URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'` and confirm `0` tables before loading anything. (Check twice that the URL is the branch, not production.)
3. Fetch the newest dump and its manifest from `nmwc-backups`, decrypt with the age identity, and load it with `BACKUP_AGE_RECIPIENTS="$(age-keygen -y <identity file>)" RESTORE_TARGET_URL='<branch owner URL>' RESTORE_DUMP=./dump.sql.gz bash scripts/ops/restore-load.sh` from the repository root (it needs `psql`, `age` and `shred`; it refuses a production URL, owner decisions 2026-10-11). Set `BACKUP_AGE_RECIPIENTS` as shown — it is a repository variable, not in your shell — or the script keeps no log at all, and the summary is all you will have. It runs `psql -f - -v ON_ERROR_STOP=1 -v VERBOSITY=verbose --echo-errors` (`-f -` is what makes psql number the dump line on every error), prints a summary of phase, dump line, SQLSTATE and table, keeps the full log only as `restore.log.age` encrypted to `BACKUP_AGE_RECIPIENTS`, and shreds the plaintext. **The full log can quote customer rows** — a failed COPY or constraint prints the row it failed on — so decrypt it (`age -d -i <identity> restore.log.age`) only on your own machine, and never paste it into an issue, a chat, a CI log or anything else in this public repository.
4. Re-create the runtime role (Runbook A step 4).
5. `npx tsx scripts/ops/restore-verify.ts --url '<branch owner URL>' --manifest manifest.json --expect-app-role`. This is the step that catches the dangerous failure: pg_dump writes triggers **after** the data, so a truncated restore comes back with every customer row present and the append-only audit triggers missing.
6. Steps 6–8 from Runbook A — **including step 6a** (§6.3a: the marker list, `git pull` of it into every clone, the GitHub `DIRECT_URL` secret, the backup by hand, its newest-record time today).

The monthly drill (`.github/workflows/restore-drill.yml`) performs exactly steps 2–5 against a throw-away branch, with the same load script, and publishes the timings. Run it on demand before you ever need it for real: **Actions → Restore drill → Run workflow**.

### 6.6 Runbook C — total provider loss

1. Provision PostgreSQL 17 anywhere, with the `pg_trgm` extension available.
2. Runbook B steps 3–5 against it.
3. Repoint Vercel Production at the new host and redeploy. The build runs `prisma migrate deploy`, which will be a no-op on a correctly restored database.
3a. **Point the guards and the backup at the new host — §6.3a, every step** (the new host's marker first in `config/production-hosts.txt`, the old kept; `git pull` of it into every clone and worktree, the production `.env` clone first; the GitHub `DIRECT_URL` secret; the backup by hand; its newest-record time today). On another provider the marker is the start of the new host name, at least 6 characters.
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
- **A backup of the wrong database** (finding 14, 2026-11-10). After a restore the GitHub `DIRECT_URL` secret is easy to leave on the old host. The nightly run now refuses any host but the first line of `config/production-hosts.txt`, records the newest write (audit row or scheduled-job heartbeat) in the manifest (`newestWriteAt`, `secondsSinceNewestWrite`), and a scheduled run fails when that is more than a day old (`scripts/ops/backup-freshness.sh`). A quiet database does not trip it: the app's scheduled jobs write heartbeats to its database many times a day even when nobody signs in. It does trip if every scheduled job has stopped for a day — which `/api/health` reports too. The dump has been uploaded before the check fails, so nothing is lost. The check asks the database for the age with its own small query (`scripts/ops/backup-newest-write.sql`; the manifest's value is the fallback), so a failed manifest — "manifest query failed — continuing without row counts" — is only a warning and does not by itself turn the run red; if neither gives an age, a scheduled run fails because it cannot show the database is live (second round of the review).

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
| A failed restore prints and uploads nothing of the row it failed on | the `restore-chain` job's failed-restore step (a real PostgreSQL COPY failure through `scripts/ops/restore-load.sh`), and `tests/unit/restore-drill-guard.test.ts` | every push |
| The real production dump restores and is complete | `.github/workflows/restore-drill.yml` | monthly + on demand |
| A restored database refuses audit tampering | `restore-verify.ts` assertion F-01 | both of the above |
| A backup actually happened last night | `db-backup` heartbeat on bearer `/api/health` | continuously |
| Dumps are expired after 30 days | `r2-backups-lifecycle.ts --check`, in `.github/workflows/r2-config.yml` | daily |
| Photo versioning is still on, with a 30-day non-current retention | `r2-photos-versioning.ts --check`, in `.github/workflows/r2-config.yml` | daily |

The bottom two rows read "on demand" until 2026-09-24, and on demand meant never: `r2-backups-lifecycle.ts --check` had been citable as evidence in four documents since 2026-09-14 and no workflow had ever called it.

**Those two live in a workflow of their own, and that is not cosmetic.** GitHub reports success or failure per *workflow*, not per job, and this check is red until the owner mints the admin tokens (§6.13). Sitting as a second job inside `db-backup.yml` it would have camouflaged a failed backup — a red **DB Backup** run is the alarm that caught seven missing nights this month — and it would have disarmed the `ALLOW_PLAINTEXT_BACKUP` guard, whose entire mechanism is that run turning red. So: a red **DB Backup** always means last night's dump, and a red **R2 bucket settings** always means a bucket setting. Neither can hide the other.

### 6.11 Other backup notes

- **Manual logical dump:** `npx prisma db pull` exports the schema; for data, `pg_dump` against `DIRECT_URL`.
- **Required GitHub secrets:** `DIRECT_URL`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `PROD_CRON_SECRET`. For the drill also `NEON_API_KEY`, `NEON_PROJECT_ID`, `BACKUP_AGE_IDENTITY` (§6.12). For the daily **R2 bucket settings** workflow also **two** Admin Read & Write R2 tokens, one per bucket and neither of them account-wide — `BACKUP_R2_ADMIN_ACCESS_KEY_ID` + `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY` scoped to `nmwc-backups`, and `R2_ADMIN_ACCESS_KEY_ID` + `R2_ADMIN_SECRET_ACCESS_KEY` scoped to `nmwc-photos`; add `R2_ACCOUNT_ID` only if the photographs live in a different Cloudflare account from the backups (§6.13). Repository variables: `BACKUP_AGE_RECIPIENTS`, optionally `MIN_DUMP_BYTES` and `R2_BUCKET`. Which host is production is not a variable: it is `config/production-hosts.txt` (§6.3a).
- **Two admin tokens, not one.** An admin token is the strongest credential a bucket has. One token covering both buckets would mean a leaked photographs credential also reaches every database dump — undoing the separation this whole design rests on, stated in `.github/workflows/db-backup.yml` and again under "R2 backup & versioning" below. `npm run ops:print-secrets` names all four.
- **The production host list is the interlock.** The drill's `DROP SCHEMA public CASCADE` refuses a URL carrying any marker in `config/production-hosts.txt`, and the drill stops before it creates a branch when the list cannot be read; the nightly dump refuses any host but the list's first line. Both read it with `scripts/ops/production-hosts.sh` (the `PROD_DB_HOST_MARKER` repository variable they used is no longer read — finding 14, 2026-11-10).

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
| Restore | `restore finished with 0 error line(s)` | DDL or data was skipped. `restore FAILED (psql exit N)` in its place means psql stopped on something the summary could not itemise; the reason is only in `restore.log.age`. |
| Verify the restored database | `✓ restore verified — N passed, 0 failed`, with `M-01 … tables match` and `F-01 … UPDATE refused by the trigger` | `M-01 skip` means no manifest was found beside the dump, so **row loss was not checked** — the run is weaker than it looks. `F-01` failing means the append-only audit guard did not survive. |
| Delete the drill branch | `delete branch … → HTTP 200` | A Neon branch holding a full live copy of customer personal data is still there. Delete it by hand, now. |

Then: download the `restore-drill-<run id>` artifact and grep `restore-verify.json` for `"status": "fail"` — there must be none — and check the Neon console's Branches list is free of `restore-drill-*`. Finally put the run's **Measured recovery time** into the RTO column of §6.2, replacing the estimate, and note the date.

**What the drill publishes, and what it does not** (N08, 2026-09-28). This repository is public: anyone can read its Actions logs and any signed-in GitHub user can download its artifacts. A restore that fails on a row makes PostgreSQL quote that row — `DETAIL: Failing row contains (…)`, the COPY line itself, `Key (…)=(…) is duplicated` — and the drill used to print the last 40 lines of that log and upload all of it for 90 days. It now prints only the load script's summary (severity, dump line, SQLSTATE, phase, statement kind and a table from the schema), adds the same table to the run summary, and uploads the full log only as `restore.log.age`, encrypted to `BACKUP_AGE_RECIPIENTS`; the plaintext is shredded on the runner. To read it, download the artifact and `age -d -i <identity> restore.log.age` **on your own machine**. If `BACKUP_AGE_RECIPIENTS` is not set the full log is discarded and the run warns; the summary is still there. `restore-verify.ts` likewise names a database error by its class and SQLSTATE, never by its message.

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
`/users` → row → "Disable". Their account stays in audit history but they cannot sign in. Disabling does not free their route: it stays theirs until it is given to someone else (next section).

### Move a route to another salesman
The Data Steward does this on `/users` (owner decision 8, 2026-10-07). A Manager who needs a route moved sends the Steward the route and the salesman who should own it. A route has one salesman, and it is never taken from an **active** one.

- **A salesman leaves (leaver/joiner).** Disable the leaver first. Then **Create user**: role Salesman, pick the route — it is listed "from <leaver> (disabled)" — and the username fills with the route code. The route moves in the same save, with a `REASSIGN` audit row on the leaver, and his sign-in name becomes `<code>.left.<yyyymmdd>` so the joiner can sign in with the code. To put an existing account on the route instead, use **Edit** on that account.
- **A salesman moves to another route.** **Edit** → Route. Tick **Sign in with the route code** to give him the new route's code as his sign-in name (it is ticked when he signed in with the old one). A route an active salesman works is refused: move that salesman first (a swap goes through a free route), or disable him if he has left. The supervisor must manage the new route's region.
- **His open requests.** Those in review stay his and stay with the approvers of the customer's region. But a new-customer request among them that is sent back after the move cannot be sent again from his new route: he opens it from Needs correction and withdraws it at the bottom of its page, and the salesman of the route it was started on adds the shop afresh. Updates sent back to him that are about his old route's customers he clears on Needs correction. New-customer requests that are not in review (drafts, or sent back) cannot be sent again from his new route either, so the move is refused while he has any: ask him to send or withdraw them, or tick **Withdraw them with this change**. The banner after the save says what happened to each.

The account-master import can do the same, with the same rules (`services/imports.ts`): a `Users` row takes a route from a **disabled** salesman as it is, and from an **active** one only when its `change_route` cell is `yes` (that salesman is then left with no route unless his own row gives him one, so put both rows of a swap in one file). Because the import finds accounts by username, a salesman's row whose `full_name` differs from the account's is held back unless `change_name` is `yes`: after a hand-over on `/users`, an older sheet would otherwise put the leaver's name on the joiner's account. The import has no review step, and it cannot withdraw anyone's requests.

### A route never changes region (owner, 2026-10-11)
Routes never move to another region, are never renamed, split or merged. A route's customers can move to other routes, and a route can be closed (switched off on `/routes`); a route for another region is a **new** route. The database refuses any change of a route's region (trigger `route_region_fixed`, migration `20261015100100_route_region_fixed`) for every user, script and the table owner — there is no maintenance-window override — and the account-master import holds back a `Routes` row whose `region_code` differs from the route's: *"Routes never move to another region. Close this route and open a new one in the other region."* The row's new `name` (the route's label) is still saved.

To serve an area from another region:
1. Create the new route in the other region (`/routes`, or a `Routes` row with a new code).
2. Move the customers' shops to it. Route moves are made in Temix (owner decision 2026-10-11). The edit flow has no route field (code review 2026-11-10, finding 28, second round), and since the owner's answer of 2026-11-11 ("A1 stop") **no customer-import path changes the route of a shop that already exists** either: the two that still could (a held-back row fixed on its batch page and then loaded, and a row with no `temix_code`) now load the rest of the row and leave the route as it is, and the row says so (`lib/import-shop-route.ts`; § Import, below). A shop the import **creates** — a new customer's, or a new shop of a customer already in the CRM — is still created on the route its row names. **Nothing in the CRM can move an existing shop to another route until the daily Temix → CRM import is built** (planned, not built: it will carry route moves, with history and an alert to the Steward). Until then **a route move made in Temix does not show in the CRM**: the shop stays on its old route in the CRM, and with it its salesman, region, Manager and the regional figures. Handing a whole ROUTE to another salesman (`/users`, or the account import) is a different thing and is unchanged.
3. Give the new route its salesman on `/users` (§ "Move a route to another salesman").
4. Switch the old route off when no shop is left on it.

If the deploy log of `20261015100100_route_region_fixed` reported shops whose region differs from their route's (an earlier route move), list them with:

```sql
SELECT b."branchCode", rb."code" AS shop_region, rr."code" AS route_region, r."code" AS route
  FROM "Branch" b JOIN "Route" r ON r."id" = b."routeId"
  JOIN "Region" rb ON rb."id" = b."regionId" JOIN "Region" rr ON rr."id" = r."regionId"
 WHERE b."regionId" <> r."regionId" ORDER BY r."code", b."branchCode";
```

and put each right through the customer-master import (the shop takes its route's region), so each correction is recorded with its batch and row. It is an owner decision whether to correct them; nothing does it automatically.

### Flag a test record (owner only; gap 30)

The test and synthetic records in production carry `isTest = true` (migration `20261024120000_test_records` marked only accounts starting `zz.test.`, region `ZZTEST`, route `ZZTEST-R1` and customer `NMWC-2026-000001`). Flagged rows are left out of the dashboards, the `/status` approval figures, the exports (the Steward may tick **Include test records**), the `/customers` list (the Steward's **Show test records**), the Temix workbook, verify-load and the nightly data checks. A test account still sees its own records, so a production walk works. Nothing is deleted.

**After the go-live clean start (§5m, owner decision 2026-11-11)** the customer `NMWC-2026-000001` no longer exists, and `NMWC-<year>-000001` is **no longer reserved for a test customer**: the clean start removes the `CUSTOMER-<year>` counter, so the first customer created in the CRM after it takes number 000001 (unless the real file brought NMWC codes of that year, which the counter skips past), and that customer is real. The `zz.test.*` accounts, `ZZTEST` and `ZZTEST-R1` are kept and stay flagged. `lib/test-records.ts` `KNOWN_TEST_RECORDS.customerCode` only records what the migration marked; it marks nothing. A production test walk before the first real customer is created would take number 000001 with an unflagged customer, so none is run until then; a test customer made later must be flagged as below.

Only the table owner, inside the maintenance window (§5e), can set or clear the flag — a trigger refuses the application and every other session, on insert or update. To flag a new one, log the reason first (§5e step 1), then, as the owner:

```sql
BEGIN;
SET LOCAL nmwc.audit_maintenance = 'on';
UPDATE "Customer" SET "isTest" = true WHERE "id" = '<the id>';   -- or "User", "Route", "Region"
COMMIT;
```

The next night's `test-flags-changed` check reports the change (that is expected: it is how an unexpected one is caught). Whether the Steward should have a screen for this instead is an open owner question.

### Re-import the master after a bulk fix

**The rule (code review 2026-11-10, finding 1; the owner's field-ownership rule).** The CRM is
master for a customer's name, phone, CR number, contact person and channel, for a shop's name,
address and visit day, and for whether a customer or shop is open or closed. Temix is master for
the route, cash/credit, credit limit, credit days and the Temix code. So, for a customer or shop
that is **already in the CRM**, an import **fills a blank CRM field, never replaces a value on
record, and never opens or closes anything.** Temix-owned fields behave as they always did (the
lanes below). New customers and new shops are created from the sheet as before.

**Never load a Temix extract through `/import`.** That screen loads the customer-master template.
A Temix extract has other headings, so its credit columns would not be read, and its rows would be
taken as a plain re-load of every customer in it. The daily Temix file is a separate lane that is
not built yet (item D).

1. Sign in as Steward.
2. `/import` → upload xlsx → review batch → Promote.
   - **At upload, read the "Not read" line.** It lists every heading of the sheet the import does
     not use; the batch page keeps the list. Headings are matched whatever their capitals, spaces
     or underscores: `TEMIX_CODE`, `Temix code` and `TemixCode` are all `temix_code` (until
     2026-11-10 they were ignored without a word). One column under two spellings in the same
     sheet refuses the file.
   - **A sheet with no `temix_code` column is refused when it names a customer that has a Temix
     code on record.** Nothing is staged. Add a column headed `temix_code` holding each customer's
     Temix code (it is on the customer page), blank for a customer not yet in Temix. The `/export`
     workbook has no such column, so it is refused the same way once it names such a customer.
   - **Codes in small letters are read in capitals** (owner's answer 2026-11-11). A `cust_code`
     of `cct0005` is the customer `CCT0005`: every lane, every check, the fix on the batch page
     and the stored code use the capital form, and a new customer is stored in capitals. Only the
     letters a-z are changed; any other letter is left exactly as typed. A `temix_code` has always
     been read in capitals. The sheet's cell is kept as uploaded (the batch page's "uploaded"
     values); the loaded row says "Code in capitals" with both spellings, and "Before you promote"
     counts such rows. Two rows whose codes differ only in capitals are rows of ONE customer: as
     for any customer with several rows, the first row is the customer's, and their branch codes
     must differ.
   - **A shop code that only looks like another shop of the same customer is held back**
     (owner's answer 2026-11-11). The row's `branch_code` is compared with the codes of the shops
     the same customer has in the CRM (archived ones too) and with the other rows of that customer
     in the sheet, ignoring capital letters and the leading zeros of each number: `1` looks like
     `01` (Excel drops the zero), `ab` looks like `AB`. When they look alike but are not the same
     code, the row is held back on its `branch_code` cell, naming both codes; nothing is matched
     or renamed, and no second shop is created. Two rows of the sheet that look alike are both
     held back. A code that IS one of the customer's shop codes is never held back. Correct the
     cell if it is the same shop; if `1` and `01` really are two different shops, use
     **Different shop: release…** (below). Codes that differ ONLY in capital letters cannot be two
     shops — the CRM keeps shop codes in capitals, so `ab` would load as the shop `AB` — so such a
     row can only be corrected or excluded. A release belongs to the code it was given for:
     correcting that row's `branch_code` (or `cust_code`) afterwards ends it, and the new code is
     checked again; that correction's audit row says so ("…; its shop code changed, so the
     'Different shop' release ends", with `shopCodeReleaseEnded` in its record). Promote checks the same rule again under the
     customer's lock, for a shop added after the upload, and rejects the customer with the same
     reason; "Before you promote" expects it. For a NEW customer it also compares the number a
     row with a blank `branch_code` is given by its place (`-01`, `-02`, …) with the codes of the
     customer's other rows: a blank row numbered `-01` beside a row coded `1` is rejected, naming
     the `branch_code` cell, and loads once the Steward gives one of them a code. The reason is
     written to every row of the customer, so it names the rows by number ("The branch_code on
     row 2 is blank, … looks like shop code "1" on row 3 … Give row 2 a branch_code").
   - **Promote opens "Before you promote".** It counts, against the CRM as it is at that moment:
     customers and shops that will be created; Temix-owned fields refreshed; rows naming a route
     that will NOT be applied; rows whose codes were read in capitals; blank CRM fields filled; customers and shops where the sheet differs
     from the record (kept); rows whose credit cells will not be applied, and why; and rows
     expected to be rejected. It is a check, not a lock. Resume and Finish skip it.
   - **"Overwrite CRM fields from this sheet"** is in that dialog. Steward only, off by default,
     needs a reason (10+ characters), and can be changed only while the batch is ready to
     promote — not part-way through a load. Switched on, the sheet's name, phone, CR number,
     contact person, channel, shop name, address, visit day and status **replace** what is on
     record wherever the sheet gives a value, as every re-import did before 2026-11-10. Use it
     only for a deliberate bulk correction — for example a master load that is meant to put the
     master's names and addresses over the seeded ones. While it is on, the batch page shows a red
     banner. The switch is an `UPDATE` audit row on the batch with the reason; every customer and
     shop audit row of that load carries `overwriteCrmFields: true` with the value before and
     after; and it switches itself off when the batch finishes.
3. Existing customers (matching by `cust_code`) are upserted — but not all in the same way.
   **The lane is decided by each ROW, not by the customer** (checked against `services/imports.ts`
   on 2026-09-26, item 20):
   - **A file row whose `temix_code` equals the Temix code already stored on the customer**
     takes the *refresh* lane. Only the Temix-owned fields (Temix code, payment terms, credit
     figures) are refreshed, and the row **never creates or changes a branch**: a file cannot be
     told apart from an inbound Temix refresh or an old copy of the master, and branches are the
     CRM's. Such rows are listed under **Loaded with a warning** ("Branch not updated") when their
     branch is missing or differs. Since code review 2026-11-10 (finding 28) the note reads
     "loaded, shop NOT changed" and, when the row's route differs, says the route was NOT applied and
     that route moves are made in Temix (`lib/import-shop-notice.ts` `ROUTE_NOT_APPLIED`,
     second round; third round: the words "No screen in the CRM changes a shop's route" were
     taken out while a held-back row fixed on the batch page and then loaded, and a row with no
     `temix_code`, could still set one; since the owner's answer of 2026-11-11 ("A1 stop")
     neither can — see "a shop that exists keeps its route" below); name, address, visit
     day and status can be changed by an edit on the customer page — a route cannot. "Before you
     promote" counts these rows and Promote waits for the Steward to tick that he understands. The
     rows counted are those that carry the customer's Temix code and name a shop of that customer whose
     details differ from the CRM, or that the CRM does not have; a row with no `branch_code`, or naming
     an archived shop, has its own note and is not counted. When the load finishes, its result ("✓ Done
     — …") stays on screen, and the batch page shows a notice with the count of such rows **until the
     Steward presses "I have read this"** — also after a reload or on a later visit. The acknowledgement
     is stored on the batch (`shopNotChangedAckRows`, `shopNotChangedAckAt`, `shopNotChangedAckById`)
     and audited (an UPDATE row on the batch: how many). Rows a later load of the same batch adds bring
     the notice back for those rows only (second round, finding 28). Batches loaded before this
     release show no 'shop NOT changed' notice, because the count starts at this release. The refresh
     also flips the customer from UPLOADED to **SYNCED**, as though Temix had confirmed the last
     batch — do not re-import the full master while a Temix batch is waiting for its
     acknowledgement. A row with a *different* non-blank `temix_code` is rejected. The credit
     limit and credit days apply only while the customer is, or becomes, CREDIT; for a CASH
     customer they are dropped, and the row now says so ("Credit not applied"). The overwrite
     option changes nothing on this lane: it never writes a CRM field.
   - **Every other file row takes the full lane — including a row with a blank `temix_code` for a
     customer that has one.** It creates a customer or shop the CRM does not have, from every
     value the row gives. **On a customer or shop that exists (the option off, the default):** it
     fills a blank phone, contact person, CR number or channel, a blank visit day, and a shop
     address that is blank or still the importer's own "Address pending"; it leaves the shop on its
     route (below); and it **keeps every CRM value on record and writes no status**, so an older
     sheet no longer undoes an approved correction or reopens a shop that an approved request
     closed. A row whose value was kept is listed under **Loaded with a warning**, labelled
     "CRM value kept" — the fields are named, never the values — and nothing is written or audited
     for a kept value. It never writes the credit limit or credit days of a customer that exists;
     a row carrying them says so ("Credit not applied": the customer has no Temix code on record,
     or the row's `temix_code` is blank). **With the option on** it overwrites the legal name, and
     the phone, CR, contact, channel and
     status wherever the row gives them, and the branch cells it gives; it adds no warning (but for
     the sub-channel note below). Either way it
     does **not** queue the customer for Temix, so the ERP keeps the old values. For a customer
     that has a Temix code, always fill `temix_code` with its stored code (it is on the customer
     page). Template rows with a blank `temix_code` take this lane.
     Most customers created by the go-live load carry a Temix code; the ~3,300 pilot-seeded ones
     do not, and always take this lane.
   - **Status.** With the option off, a sheet's `customer_status` is read only for a customer or
     shop the load creates; a new open shop under a customer that is not ACTIVE still makes the
     customer ACTIVE (owner decision 7), and the summary counts it. The rest of this bullet is
     what the full lane does **with the option on**.
     On the full lane a customer's status follows all its live branches, not only the file's rows:
     it is settled after the branches are written, and a blank `customer_status` cell says nothing
     (its branch keeps its stored status, and a branch it creates is ACTIVE). On every lane, a load that
     closes a customer's last open shop closes the customer and one that reopens a shop opens it (owner
     decision 7, 2026-10-07); either move, or a status the file states, is one audit row on the
     customer, from its status before the load. A blank name, address
     or route keeps the stored value (a NEW branch still gets "Main", "Address pending" or the
     UNASSIGNED route); and once a customer has branches, a row with no `branch_code` is rejected
     — it would be numbered by its position in the file and could overwrite a sibling. **Always
     include `branch_code`.**
   - **A shop that exists keeps its route — on every lane, with the overwrite option on or off**
     (owner's answer 2026-11-11, "A1 stop": route moves are made in Temix, never in the CRM;
     `lib/import-shop-route.ts`, the one place both the full lane and a row fixed in the app build
     what they write on a shop that exists — it has no route in it). A row that names a different
     route for a shop already in the CRM is **not refused for that**: the rest of the row loads as
     its lane says, and only the route (and the region that would follow it) is not applied. The
     Steward is told four times: on the batch page, a held-back row or a fix waiting to load that
     names a different route says so before it is corrected or loaded; **Before you promote** has
     a line "Route NOT applied: N row(s) …" and the tick Promote waits for covers these rows too;
     the row itself, under **Loaded with a warning**, is labelled "Route not applied" and reads
     "shop C-01: the sheet names route R2; the shop is on route R1. The route was NOT applied; the
     shop stays on its current route. Route moves are made in Temix."; and the end-of-load notice
     the Steward acknowledges counts these rows with the "shop NOT changed" ones, each row once
     (`ImportBatch.shopNotChangedRows`; its heading now reads "N row(s) were loaded, but not
     everything they say about their shop was applied", because the other cells of a route row may
     have been applied). Nothing about the route is written to the audit log or BranchHistory: the
     row's note is the record. Still done: a shop the import **creates** (a new customer's, or a new
     shop of a customer in the CRM) is created on the route its row names — that is how the owner's
     file lands on an emptied database; and a shop whose stored region is not its own route's region
     (left by a route moved between regions before routes were fixed to their region) is put back
     into its own route's region when its row names a route — that is not a route move. A test
     (`tests/unit/import-shop-route-guard.test.ts`) reads every import source file and fails if any
     write on an existing shop names a route.
   - **A full-lane row that moves a customer to another channel clears its sub-channel when the
     stored one belongs to the old channel** (owner decision 2026-09-29, auditor recheck F16) —
     **only with the overwrite option on**; by default the channel on record is kept, so nothing
     is cleared: the
     pair would otherwise be one that creating a customer refuses, and reports and Temix read it.
     The sheet has no sub-channel column, so the new one is picked on the customer page; the
     customer's first row in the file says so under **Loaded with a warning**, labelled
     "Sub-channel cleared" (the rest of the row, its branch included, loaded as usual — it is not
     a "Branch not updated" note), and the log gets
     `import.promote.subchannel_cleared` with the customer's id. A sub-channel of the new channel
     is kept; a row that restates the channel, or leaves `channel` blank, clears nothing — even
     when the pair on file is already mismatched. **Known costs:** the customer loses the channel
     pair's 10 completeness points until someone picks a sub-channel; the cleared sub-channel
     does not reach Temix until the customer's next queued change (this lane queues nothing, as
     above); and under the FULL submit gate (`SALESMAN_SUBMIT_GATE=FULL`) a salesman's edit
     already waiting on that customer is refused at approval with "Sub-channel is required", so
     the approver rejects it and he resubmits with one (the default CORE gate does not ask).
   - Every lane rescores the customer **and each of its live branches** when its rows land
     (auditor recheck F21; before, only the customer was, so a branch the import created sat at
     completeness 0 on the dashboard's leaderboards). Only a score that changes is written, and
     that write moves neither `updatedAt` nor `version`. A branch the row would not change is not
     written at all — its `updatedAt`, which the export prints as `last_edited_at`, stays put —
     and one it does change gets `version + 1`, as an approved edit does. On the full lane a
     branch still in the old region of a route that an account import has since moved to another
     region counts as changed even when every cell matches, and the write puts it in its route's
     region: the account import moves the route alone, not its branches. The refresh lane does
     not compare the region, so there such a branch keeps the old region until a full-lane row
     that names a route (any route: the shop keeps its own) repairs it. A status the row only restates is no status change: `lastStatusChangeAt`
     (reactivation evidence is dated against it) moves only when the status does.
   - The export's **Updated since** filter is per customer: it reads the *customer's* `updatedAt`,
     and a customer it matches comes out with all its live branches. A full-lane or refresh-lane
     row writes the customer, so a re-import moves it for every customer whose rows load, changed
     or not — an "updated since" export taken after a full re-import returns the whole file. A group
     of rows fixed in the app (branch only) moves it only when it writes a branch or fills the
     customer's empty phone.
   - A salesman's edit already waiting on a customer is refused at approval, whole, when the
     import has since changed a field the edit changes, to anything but the edit's own value ("Changed on the customer after this
     request was sent: …", auditor recheck F06 — a sub-channel the import cleared counts): the
     approver rejects it and he sends it again from a fresh form. An edit that changes none of
     the fields the import changed approves as before.
4. Problem rows are fixed on the batch page, not with scripts: **Correct…** (only the cells the
   problem names; never payment terms, credit or the Temix code; only changed cells are
   recorded), **Release shared phone…** (with a reason; audited as FORCE_OVERRIDE),
   **Different shop: release…** (a shop code that looks like another shop of the customer only by
   its zeros, when the two really are different shops; with a reason; audited as FORCE_OVERRIDE;
   never for codes that differ only in capitals), **Re-check**, **Exclude…** (with a reason). A fixed row waits under **Fixed, waiting to
   promote** and can be taken back with **Withdraw fix** until the batch is promoted.
   - **A row fixed in the app for a customer linked to Temix is always "branch only"** (owner
     decision 2026-09-25), whatever its `temix_code` cell says and whatever rows are beside it in
     the promote — decided per row: it creates its branch, or updates it from the cells it gave
     (a shop that exists: its blank name, address or visit day by default, and every cell it
     gave only with the batch's overwrite option on — the row says "CRM value kept" otherwise;
     never its route: see "a shop that exists keeps its route", above),
     changes nothing else about the customer (not the name, phone, CR, contact or channel, and
     not the credit figures) — except that its phone fills the customer's phone when the customer
     has none (owner decision 2026-09-27; never over an existing phone) — and queues the customer
     for the next Temix batch. The plain rows
     beside it take the lane their first row decides, as above. A fixed row that corrected or
     released one of those customer-level values says on the row that it was **not written**
     ("change it on the customer page"), and the batch page says so before the Steward corrects
     or releases one. A fixed row alone is no word from Temix, so it does not flip UPLOADED to
     SYNCED. A fixed row that cannot be applied — no `branch_code` (every go-live head-office
     row), a code another customer holds, an archived branch — comes back **REJECTED** with
     `branch_code` offered for correction; a code this customer does not use yet creates a new
     branch.
   - Only the row the Steward acts on counts as fixed. A rejected row takes its customer's other
     rejected rows in the batch back to CLEAN with it, as the plain rows they were; the page says
     so on them ("came back with the fix of row N"). All the rows one fix brought back form one
     unit (`parsed.fixGroup`): promote rejects them together when one is overtaken or past the fix
     window (a row of the unit held back again does not load, and the page says the others load
     without it), and **Withdraw fix** — offered on
     any of them, and on the acted row when it came back held back — takes back exactly them,
     never a separate fix of the same customer. A row of the unit fixed again on its own stays
     in the unit. A promoted batch that a fix set
     back to READY is PROMOTED again when nothing is left to promote.
   - **Fix only in the newest upload.** A fix is refused while the batch is being promoted; on a
     row uploaded more than 90 days ago, when the newer uploads' data may already be swept; and
     in an upload older than another that carries the same customer. Each row of the fix is
     judged by its own rule: the row acted on, for a customer linked to Temix, only against a
     newer row about the same *branch* that wrote or may write it (a plain refresh row never
     does, so an inbound Temix refresh does not block a held-back branch row; a newer row with no
     `branch_code` counts against every branch); every other row — including a linked
     customer's row the fix only brings back, which loads as a plain row and writes the
     customer's own fields — against any newer upload of the customer. A rejected row is refused
     when one of its customer's other rejected rows is overtaken, and the message names that
     row: exclude it first. The page offers only Exclude on such rows, in the server's words.
     Promote asks again for every unit: **a fix that waited past the 90 days, or that a newer
     upload overtook while it waited, is rejected at promote with every row it brought back**
     rather than loaded over the newer data. A row whose data the 90-day retention sweep has
     cleared can only be excluded or uploaded again.

### An old or replaced customer batch (code review 2026-11-10, finding 6)

A staged batch used to stay promotable for ever, could not be thrown away, and **Resume** loaded
an interrupted one with no question — weeks later it would write its older values back.

- **Promote and Resume both open the review first.** It says when and by whom the batch was
  uploaded and how old it is ("Uploaded 05 Nov 2026, 10:00 by … (5 days ago)"), then what it
  will do; nothing loads until the Steward presses the button in it.
- **Older than 7 days, a staged batch can no longer be promoted or resumed**
  (`lib/import-batch-guard.ts` `STAGED_BATCH_MAX_AGE_DAYS`; a default awaiting the owner). The
  batch page and Work say "too old to promote"; a fix that would bring a row back to load is
  refused. Upload the sheet again, and discard the old batch. (A run already under way may
  finish its next slice — only while its lease is live: a tab that went quiet long enough for
  the lease to run out is asked again, like any resume.) The limit is on a **staged** batch: one never loaded, or one whose
  first load stopped with rows of the sheet still waiting. A batch **already loaded** keeps the
  90-day fix window above for its held-back and rejected rows: they can still be fixed and
  loaded after 7 days, judged by the newest-upload rule (`stagedLoadExpired`,
  `batchLoadHistory`; adversarial review of finding 6).
- **A customer a newer upload has already loaded is not loaded again from an older batch.**
  The review names how many and from which file, in red; Promote stays disabled until the
  Steward ticks "Leave out these … customer(s)". Their rows in the older batch are then
  REJECTED ("Customer … was loaded since from a newer upload …, so this older row was not loaded
  over it. Exclude it.") and the rest loads. Rows fixed in the app keep their own newest-upload
  rule (above). A run whose lease lapsed (a weak signal, a long pause) is checked again when its
  tab comes back, so a newer upload loaded in the meantime is not overwritten (second round).
- **Discard batch** (Data Steward only): on a staged batch, or one whose promote stopped
  part-way, with a reason. It asks first. The batch becomes `DISCARDED` (migration
  `20261111100000_import_batch_discarded`, one enum value), leaves Work, and can never be
  promoted, resumed or fixed; the `UPDATE` audit row on the batch has who, when, why, the status
  before, and how many rows were not loaded and how many an earlier promote had loaded (those
  stay loaded). Nothing is deleted. The 90-day retention sweep empties the details of **every**
  row of a discarded batch, 90 days after upload, and so for a staged batch that expired without
  ever being loaded; the rows and their outcomes stay, and each sweep leaves its purge summary
  (code review 2026-11-10, second round).

### Export the cleaned master for ERP
1. Sign in as Steward (or Manager).
2. `/export` → choose filters → **Download .xlsx**.
3. The workbook is a report, **not an import file**: `sales_region` and `channel` are the
   region name and channel label (the importer expects the code and the key), and
   `customer_status` would be applied to every branch. Re-uploading it can reopen closed
   branches. For bulk fixes, start from the import template (found 2026-09-25, item 28;
   making it round-trip is an open owner decision).

### Requeue customers the ERP was never told about (one-off, 2026-09-23)

A customer whose `temixSyncState` is `SYNCED` while `temixCode` is null is claiming Temix already knows it, and nothing re-examines that claim: the upload queue selects only `PENDING_UPLOAD` and `DEACTIVATE_PENDING`, so the row never enters a batch, never shows on `/temix`, and the ERP never learns it exists — it cannot be invoiced, however complete it looks in the CRM. The May pilot seed could leave rows in that state; the importer handles it correctly for rows it creates. `verify:load` fails on exactly this ("customers with no Temix code are queued for upload").

Before the verification command, set `EXPECTED_BRANCHES` and `EXPECTED_VISIT_DAYS`
from the private reconciliation described in [GO-LIVE-RUNBOOK §6a](GO-LIVE-RUNBOOK.md).
Use the manifest, or the manifest adjusted by recorded approved changes (cleanup ledger
rows, journey-plan fills). Reconcile retained pre-load branches outside the underlying master
and their expected days; count branches matched by the load only once, including retained
days. These are whole-database live totals, not counts inserted by this batch. Requeuing
Temix state does not itself change those totals. Never set them from observed totals merely
to make verification pass; if the baseline or change records are missing, reconcile first.

To fix it, **dry run first** — the script writes nothing without `--apply`, and `--expect-host` is required either way, because a dry run against the wrong database reports "nothing to do" and reads as "already fixed":

```bash
npm run smoke                       # before any production change — fourteen checks, ~15s
DIRECT_URL='<owner connection>' npm run ops:requeue-untracked -- --expect-host ep-sweet-haze
# read the counts, then:
DIRECT_URL='<owner connection>' npm run ops:requeue-untracked -- --expect-host ep-sweet-haze --apply
npm run smoke                       # and after
npm run verify:load -- --expect-host ep-sweet-haze \
  --expected-branches "$EXPECTED_BRANCHES" --expected-visit-days "$EXPECTED_VISIT_DAYS"
```

`npm run smoke` on both sides is not optional — it is the standing rule for any production change, it needs no credentials, and each of its fourteen checks is something that has already been wrong here (including production serving a four-month-old build for weeks). Run it before, so a regression that was already there is not blamed on this; run it after, so one caused by this is caught while the operator is still at the keyboard.

The dry run resolves everything `--apply` needs, including the audit actor, so anything the apply would refuse is refused in the rehearsal instead. If it reports more than one active Steward, pass `--actor <username>`; the script refuses a username that is not an active Steward, or one on the demo denylist (`lib/demo-accounts.ts`) — rename the account rather than relaxing the list.

It flips only live, code-less, `SYNCED` rows to `PENDING_UPLOAD`, a few hundred per statement so it cannot hold a long lock over the WAN link, and it is re-runnable — a second run finds nothing and says so. It refuses outright if the resulting queue would exceed the 5,000-customer batch cap (`lib/temix-cap.ts` `TEMIX_BATCH_ROW_CAP`), so that a requeue goes out in one file; drain the existing queue first, or requeue in tranches with `--limit`, and re-run. (Since code review 2026-11-10, finding 11, a queue over the cap no longer stops `/temix`: **Generate takes the 5,000 customers waiting longest** — `temixSyncPendingSince`, an unknown time first — and under the button says how many are still waiting; the Steward presses Generate again for a file with the rest. Each file is loaded into Temix and marked loaded as usual. The batch's `EXPORT` row records `moreQueued` and the cap. Which changes put a customer in the queue is unchanged: an owner question.)

**If `/temix` cannot generate the batch afterwards, requeue in tranches with `--limit`.** The cap the script refuses on is not the only ceiling. `generateTemixBatchCore()` snapshots the entire queue inside one interactive transaction budgeted at 30 seconds, and that budget cannot be raised past the 60 seconds Vercel allows the function — so a queue can be legal under the 5,000-customer cap and still be too large to snapshot in time. A timeout there rolls back untouched and leaves the queue exactly as it was, so it costs nothing to find out; but `/temix` has no un-queue action and the script's predicate stops matching a row the moment it is requeued, so without `--limit` there is no way to make the queue smaller again. Run `--limit 1000 --apply`, have the Steward generate and load that batch, then run it again for the next tranche. The counts and the workbook estimate the script prints describe the tranche it is actually going to touch, not the whole backlog, and it tells you how many it is leaving behind.

Two `AuditLog` rows per applied run (`entityType = TemixRequeue`), sharing one `entityId` — the run's `temixSyncPendingSince`: a STARTING row written before the first chunk and a COMPLETED row after the last. The chunks each commit on their own, so **a STARTING row with no COMPLETED row beside it means the run was interrupted**: the rows it did change all carry that `temixSyncPendingSince`, which is how you count them and how you put them back. The run also prints a block to paste into the go-live log. Afterwards, have the Steward generate the batch from `/temix`.

### Work out WHICH branches are missing a visit day

`verify:load` compares the live-branch and visit-day totals against the reconciled expectations
from the manifest or explicit overrides (GO-LIVE-RUNBOOK §6a), including retained pre-load
branches and recorded approved changes. It never reads the master, so **it cannot name a
single row**: it lists mechanisms that withhold a day as leads. Counts alone cannot say
whether a gap came from rejected rows, quarantine or a skipped refresh-lane branch update.

To attribute it, join the master to production per customer:

1. For each customer's `cust_code`, the authorized operator derives **expected day-bearing branches = branches the master gives a non-blank `day_of_visit`, plus that customer's retained branches that keep a day, minus approved cleanups**. Match by the importer's derived branch identity, not a blank `branch_code`, and count an identity in both the master and retained sets only once. Apply other recorded approved changes only if not already represented in that expectation. The master already counts the days restored by the quarantine fill. Keep the per-customer reconciliation and source records private.
2. Query production for the same customers and count their live branches carrying a `dayOfVisit`.
3. The customers where production is short are the answer. For each, look at the import rows: a REJECTED row wrote nothing at all, a QUARANTINED row was held for review and never promoted, and a customer that already carries a `temixCode` may have taken the refresh lane, which skips the branch loop.

If the missing days belong to held quarantined rows, assess `ops:visit-days` (below)
under its matching safeguards. A mismatch alone does not justify applying it.

### Land a visit day that a quarantine held back

```bash
DIRECT_URL='<owner connection>' npm run ops:visit-days -- --expect-host ep-sweet-haze
# read the counts, then:
DIRECT_URL='<owner connection>' npm run ops:visit-days -- --expect-host ep-sweet-haze --apply
npm run smoke
# Use the privately reconciled expectations; do not add the days this quarantine fill restores.
npm run verify:load -- --expect-host ep-sweet-haze \
  --expected-branches "$EXPECTED_BRANCHES" --expected-visit-days "$EXPECTED_VISIT_DAYS"
```

A quarantined row is never promoted, so its branch never receives the journey plan's `dayOfVisit`. This writes that day onto the branch that already exists — exactly what the promote would have written. It does **not** merge customers, clear the quarantine or resolve the duplicate; those stay in `/duplicates` for a Steward, because merging two customer records needs a human to say which one survives.

Use the recorded expectations from GO-LIVE-RUNBOOK §6a. **This quarantine fill restores
days that the manifest's `branchesWithVisitDay` already counts, so the expectation does
not change after it.** Branches already live before this operation stay in the branch
expectation once. Only an approved no-day → day change on a branch whose day is not
already counted in the expectation adds 1; changing an existing weekday adds nothing.
Keep the totals and records private. Do not increase the expectation for this repair or
copy observed totals into it; an incomplete approved operation must be reconciled.

It applies a row only when the customer has exactly one live branch of that name and that branch has no day recorded. Anything ambiguous is skipped and reported — writing the wrong branch's visit day sends a salesman to the wrong shop on the wrong morning.

It takes no customer lock and recomputes no completeness score, although a visit day is worth 5 points: the branches it wrote keep the score from before, until `ops:rescore-completeness` (below) repairs them. **Never run the two at the same time** — the rescore's safety under load is the customer lock, which this script does not take.

### Load the visit days the Managers filled in (the per-region sheets)

The sheets list, one workbook per region and one sheet per route, the live branches that
had no visit day. A Manager fills column J (Visit day, one of SAT SUN MON TUE WED THU FRI)
and sends the workbook back. `scripts/ops/visitdays-from-sheets.ts` loads it; its header
gives every rule. Run it through the runner, never with `DIRECT_URL=` on the command line
(HANDOVER §5):

```bash
npm run smoke
NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs \
  scripts/ops/visitdays-from-sheets.ts --expect-host ep-sweet-haze --sheets <folder of returned workbooks>
# Have the set file checked against the same sheets by a second person or agent. Then,
# with the set file and the SHA-256 the dry run printed:
NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs \
  scripts/ops/visitdays-from-sheets.ts --expect-host ep-sweet-haze --set <set .json> --set-sha <hash> --rehearse
NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs \
  scripts/ops/visitdays-from-sheets.ts --expect-host ep-sweet-haze --set <set .json> --set-sha <hash> --apply
npm run smoke
```

The dry run writes two private files into `golive-data/visitdays/from-sheets/`: the set
(every branch it would write, with its day) and the review workbook (every row that needs a
person, with the reason; blank rows and rows whose branch already has that day are only
counted). It writes a day only onto an ACTIVE branch that still has none, on the route its
sheet names, and only when the row has no note; a branch named on several rows loads only
when they all give the same day without a note. If one route's sheet is in two workbooks
(two versions of a region's sheets), it refuses: pass one version at a time. The apply
writes only branches that are unchanged since the dry run, in transactions of up to
`--chunk` branches (default 200) that each take their customers' locks (in the order
`lib/locks.ts` gives), with one audit row each, and rescores their customers inside that
lock. It prints the run id as soon as it starts. The rehearsal takes about as long as the
apply: time it first. The rows in the review workbook go to a Manager or the Steward to
settle in the app (customer → **Enrich** → **Day of visit**). To undo a run,
`--reverse <runId>` (a dry run), then `--reverse <runId> --confirm`: it clears only the
days still as the run wrote them.

Each day written onto a branch whose day the expectation does not already count adds 1 to
the visit-day expectation of `verify:load` (GO-LIVE-RUNBOOK §6a). Derive it from the
ledger, never from an observed total: count the run's `Branch` audit rows (each carries the
run id in `after.runId`, so this also covers a run that stopped before its COMPLETED row),
and subtract what a `--reverse` of that run set back to none (its `reversed` row in
`entityType = VisitDaysFromSheets`). Keep the figures private.

### Rescore completeness after the import fix (one-off, auditor recheck F21, 2026-09-29)

Until this fix the promote rescored only the customer: every branch the go-live load created sat at `completenessScore` 0, and a branch whose address, visit day, status or route an import changed kept its old score — unless a later edit, photo or reactivation happened to rescore that customer. `Branch.completenessScore` is what the dashboard's region and route leaderboards and the branch ring read, so they are understated. The fixed promote keeps the scores right from now on; this repairs what the earlier loads, and `ops:visit-days`, left behind. Run it **after** the fix is deployed, so nothing written behind it is stale again.

```bash
npm run smoke                       # before — the standing rule for any production change
DIRECT_URL='<owner connection>' npm run ops:rescore-completeness -- --expect-host ep-sweet-haze
# read the counts to the owner, then, on the owner's go-ahead:
DIRECT_URL='<owner connection>' npm run ops:rescore-completeness -- --expect-host ep-sweet-haze --apply --actor <steward username>
DIRECT_URL='<owner connection>' npm run ops:rescore-completeness -- --expect-host ep-sweet-haze   # again: expect "Nothing to do"
npm run smoke                       # and after
```

- **Tell the owner before `--apply` that the leaderboards will rise visibly**: the dry run prints how many customer and branch scores move, up and down, by how many points in total, and how many branch scores are stored as 0 today. It prints counts only — never a name, code, phone or id — and writes nothing, not even a ledger row. `--expect-host` is required for the dry run too.
- It is a production write. The standing production-write permission of 2026-09-27 may cover it; confirm it is still in force when it runs.
- `--apply` requires `--actor`, an active Steward not on the demo denylist; a dry run given `--actor` checks it too. It writes `Customer.completenessScore` and `Branch.completenessScore` on live customers and their live branches and nothing else — a customer archived or merged away while its page waited for the lock is dropped from the page once the lock is held — in raw SQL and only where the score differs — `updatedAt` (a customer's is what the export's "updated since" filter reads, a branch's is its `last_edited_at`) and `version` (a concurrent edit's versioned write) do not move, nothing is queued for Temix. Two `AuditLog` rows (`entityType = CompletenessRescore`, one `entityId`), counts only: STARTING before the first page, and COMPLETED, with how many customer and branch scores the pages wrote, as soon as the last page commits.
- Each page of customers (`--chunk`, default 200) is one transaction that first takes their row locks in the one order `lib/locks.ts` gives, so an edit approval, a Steward's or Manager's direct edit, a photo, a reactivation or an import on the same customer is waited for, not skipped, and what it commits is what gets scored. **`ops:visit-days` takes no customer lock — never run it at the same time.** A page that fails (a lock timeout behind a long import group, say) stops the run with the pages before it committed, and leaves a STARTING row with no COMPLETED beside it; re-run it. It is idempotent: a second run reports nothing to do.
- **The check after the last page.** Once COMPLETED is written, `--apply` reads and scores every live customer again, as the dry run does, and prints the result as `still differ` in the go-live block. It is printed, not recorded: a failure of the check (a dropped connection during tens of seconds of reads) cannot lose the COMPLETED row or its counts, which it did before (post-merge review of phase 2, finding 7). `--apply` exits:
  - **0** — checked, `still differ 0`. Run the dry run again as above; expect "Nothing to do".
  - **1** — `still differ` is not 0: that many scores went stale again after their page was written, most likely because something wrote a scored field without rescoring while the run was going (`ops:visit-days` is one such writer). Run `--apply` again — it rewrites only what differs and writes its own STARTING and COMPLETED pair — then the dry run, expecting "Nothing to do". If a second `--apply` still leaves some, stop and find what is writing those fields before running a third.
  - **2** — either the run failed ("COMPLETENESS RESCORE FAILED", see the page failure above) or only the check did ("The check after the last page FAILED", and `still differ not checked`). In the second case the scores are written and the ledger has its COMPLETED row: run the dry run; "Nothing to do" closes it, and scores to change mean `--apply` again.

### Spot a duplicate in the live master
1. Sign in as Steward.
2. `/duplicates` → review pairs: CR-number matches first, then name + phone + region (item 16: any shared region; names compared ignoring case and spacing). A phone alone is not a match. "Mark distinct" hides a pair until what they share changes; "Marked distinct" lists them with Undo.
3. Click "Keep ←" / "Keep →" to merge; loser is soft-deleted, branches reassigned, AuditLog written.

### Reactivate a closed shop
1. Salesman: from a closed customer's profile, submit reactivation with a fresh photo.
2. Manager: `/reactivations` → review with photo evidence → Approve or Keep closed.

## 7a. Day-1 support — symptom → action

What users report in their first days, and the control in the app that answers each one. Every action here is a control the app has; if a fix needs something that is not listed, collect the details and hand them to the Steward rather than improvising.

| The user says or sees | Action |
|---|---|
| "The app asked me to sign in again in the middle of the day" | Expected. A sign-in lasts at most 8 hours from the moment of signing in, for every role, however much the app is used (owner's answer 2026-11-11); the sign-in page then says so. Nothing to fix: sign in again. On the field forms (new customer, edit, close, reactivate, signed credit application) and the photo slots, the page says "You need to sign in again …": keep that page open, sign in in another tab, come back and tap Try again or Retry upload — the form and the photo are still there. An approver's typed reason, or an import correction, is kept only while that page stays open. A promote the limit stops takes the Steward to the sign-in page (the batch page cannot be shown signed out, so he does not see "Not signed in." on the button) and keeps every slice it loaded: sign in again, open the batch and Resume once the page offers it (about a minute and a half). Known behaviour, not changed: when the limit stops a promote between two of its parts, for about 20 seconds the batch page says "Another promote is running — wait for it to finish." although it is his own stopped run (the hand-over lease, `PROMOTE_HANDOFF_GRACE_MS` in `services/imports.ts`); after that it says "Promote interrupted." and Resume works. Known behaviour, not changed, and rare: a request that leaves the device at the very moment the 8 hours end still carries the old sign-in, and the reply to it clears the sign-in cookie in that browser (Auth.js clears it whenever it refuses a session, and the middleware lets that through); if the person has by then signed in again in another tab, that reply signs out the new sign-in as well, and he signs in once more. |
| First sign-in: "my password does not work" | Open `/users` on the **All** tab (the default **Active** tab hides disabled accounts) and find the account. Read **Status** first: **Disabled**, or an amber **Cannot sign in** badge (the username itself is refused by the demo-account block), means no password will work and a reset changes nothing — find out why it was disabled before anyone enables it, and take a **Cannot sign in** account to the owner, since it has to be renamed (since the code review of 2026-11-10 such a name can no longer be given to a new account, on `/users` or in the account import, so this applies only to older accounts). Then read **Last login**. **`never`**: nobody has signed in with it — check the username, then reset the password (who may: last row). **Anything else** (a date): someone has already signed in with this account and may have changed its password. The Steward resets it at once — a reset also ends that other session within five minutes — then opens `/audit`, sets **Action** = `LOGIN` and **Entity** = `User`, and reads the **When** column of the rows whose **Actor** is that person (newest first, 50 to a page; times are Oman time). `/audit` does not show where a sign-in came from: the IP is recorded with the row, but only the owner can read it, from the database. |
| "Account temporarily locked due to repeated attempts. Try again in …s" | Five sign-in attempts on that username within about a minute. Wait the seconds shown, then type it carefully: one attempt is let through every 12 seconds. Trying again sooner is refused but does not make the wait longer (since the code review of 2026-11-10, finding 10). A password reset does not lift the lock; waiting does. If it stays locked although the person has stopped trying, someone else is trying that username — there is no control in the app that clears the lock, so tell the owner, and the Steward looks in `/audit` for failed sign-ins on that account. |
| First sign-in: the password change says "Current password incorrect" on a retry, or the page says the new password may already be active | The change was probably saved but its answer was lost on a weak signal. Type the same current and new passwords again and press **Change password**: since the code review of 2026-11-10 (finding 22) a change that is already saved is answered as done. If it keeps failing, sign in with the NEW password. No reset is needed. Five wrong tries on this form wait about 12 seconds ("Too many attempts. Try again in …s"). "Your password could not be checked just now, so nothing was changed" means the guess limit could not be checked because the database did not answer (logged as `rate-limit.store.unavailable`): nothing was tried, so wait a minute and try again. |
| "Too many attempts from your network. Try again in …s" | About thirty FAILED sign-ins (a wrong password or username) from that network in a short time, by anyone on it; one more is allowed every 12 seconds after that (`LOGIN_NETWORK_CAPACITY` and `LOGIN_NETWORK_REFILL_PER_MIN` in `lib/rate-limit.ts`). Successful sign-ins do not count, so there is no need to stagger people who type correctly, and attempts that are refused do not count either, so a room retrying does not keep itself locked. Wait the seconds shown, and have whoever is failing check the username and the password, or switch to mobile data. |
| A customer's visit day is wrong | A Manager (customers in his regions) or the Steward opens the customer → **Enrich** → **Day of visit** → submit. From those two roles it is a direct write, with no approval step, and it is audited. A day can be changed but not cleared — pick the right one. While a request is waiting on the customer the form will not submit; decide that one first (two rows down). |
| A salesman needs another route, or has left | Collect the route and the right owner and hand them to the Steward, who moves it on `/users` (**Disable** the leaver, then **Create user** or **Edit**: §7, "Move a route to another salesman"). That moves the whole route; it never moves a single customer. |
| One customer is on the wrong route | Collect the customer and branch codes and the right route and hand them to the Steward. Route moves are made in Temix (owner decision 2026-10-11) — the Steward records those for the owner. A row that carries the customer's Temix code never changes an existing shop, and says so ("loaded, shop NOT changed … The route was NOT applied; the shop stays on its current route. Route moves are made in Temix."). Since 2026-11-11 no import row changes the route of a shop that exists (§ Import), so until the daily Temix → CRM import is built, the move made in Temix does not show in the CRM. |
| "A submitted edit is already pending review for this customer.", "This customer already has a pending change awaiting review", or on the edit page "A submission is already pending review (by …)". When the waiting request is the user's own, the message starts "Your changes sent…" or "Your … sent …" instead. | Only one request can be open on a customer. The Manager decides the waiting one — **Approvals**, or **Reactivations** for a reopen request — and the salesman then submits again. |
| An error page showing a **Reference** | Ask for the Reference exactly as shown and the time it happened, then look it up as §5g describes. |
| Who can reset or disable whom | **Manager**: Salesman and Supervisor accounts in his own regions. **Steward**: every account except his own, and only the Steward has **Edit** (role, route, supervisor, regions, phone, e-mail). Nobody can disable the only active Manager until another Manager account is active. Nobody changes their own password from `/users`; that is `/profile`. |

## 8. Incident playbook

### Symptom: an "Integrity alert" (in-app "Data check", or webhook `integrity.failed`)

1. Open **/status/integrity** as the Data Steward. Each failing check says why it matters and what to do (the table in §5k), with up to ten examples.
2. **`critical`** (the seal chain, the protection triggers or functions, or a new sign that an off-site seal copy or the seal table was rewritten — a copy that differs, an unexpected object under `seals/`, a seal naming another key): treat as a possible tampering incident. It is sent once, the night the finding is new; while it stays, the page shows it as information. Run `scripts/ops/verify-seals.ts --all` (§5k), check the private operations log for a maintenance window that explains it, and if none does, preserve the evidence (a fresh dump, §5e step 2) before changing anything.
3. **`warn`** (a data or record-keeping check): fix the records through the app or the named script; the next night's run shows whether it cleared.
4. A check in `error` could not run (a timeout, a missing table): it runs again the next night; if it stays, look at the run's heartbeat and logs (§5g).

### Symptom: `/api/health` (bearer) shows a cron job `stale` / `never` / `failed`

`never` after a deploy: the job has not run yet. Check the scheduler: **Vercel → Settings → Cron Jobs** first (the Service status page's Scheduled jobs list shows when Vercel last ran each job), then GitHub Actions → the workflow's recent runs, and cron-job.org's log while it is still in use. `stale`: the scheduler stopped calling. On Vercel, check that the cron is listed and enabled and that the latest deployment is the production one; the GitHub backups are late and sparse and will not keep it fresh on their own. `failed`: open `cron.jobs[].lastError` in the payload; the SLA sweep also logs `cron.sla.row_failed` per row in Vercel logs.

## 5e. Opening an audit-maintenance window (owner only)

The append-only trigger has exactly one override: a transaction that runs
`SET LOCAL nmwc.audit_maintenance = 'on'` **from a session logged in as the table
owner**. The application role cannot use it at all. Because the record of such an
edit would have to live in the table being edited, the accountability for it is
procedural, and this is the procedure:

1. **Write down why, before you open it.** Add a dated entry to
   the private operations log in the owner's handover pack — never in this public
   repository (owner decisions 2026-10-11): who authorised it, what is being
   changed, which rows, and under what request.
2. Take a fresh dump first — `Actions → DB Backup → Run workflow` — so the
   pre-edit state is preserved off-Neon.
3. Do the narrowest possible change inside one transaction, as the owner
   (`DIRECT_URL`), and never as part of a script that also does other work.
4. Record the row counts before and after in the same log entry.

**The window also covers the dated history** (gap 6, migration
`20261013100100_history_foundation`, `docs/HISTORY.md`): the six `*History` tables
refuse UPDATE, DELETE and TRUNCATE through the same function, and a direct INSERT
through `nmwc_history_insert_guard()`, unless the owner has opened this window. The
history is kept for ever; on production nothing purges it. Deleting a customer, shop,
account, route or region (owner, in the window) writes a DELETE tombstone into its
history — the record of the delete.

**And, since `20261014100000_lossless_paths` (docs/HISTORY.md §9), the request and
export records:** `AttachmentHistory` is protected like the six above;
`EditRevision` and `ExportJob` refuse UPDATE, DELETE and TRUNCATE (the application
only inserts them); a `CustomerEdit` can no longer be deleted or truncated, and once
it has left DRAFT / NEEDS_CORRECTION what it asked for, who sent it and when cannot
change — all unless the owner has opened this window. Hard-deleting a user who
exported needs their `ExportJob` rows removed in the window first (RESTRICT); a
customer another one was merged into cannot be hard-deleted while that one points at
it (`Customer.mergedIntoId`, RESTRICT).

**And, since part C (`20261015100000_authority_jobs_auth_events`, docs/HISTORY.md
§10):** `JobRunDay` (the scheduled jobs' days) and `AuthEvent` (sign-in failures and
session cut-offs) refuse UPDATE, DELETE and TRUNCATE the same way; the application
only inserts them, and they are kept for ever. **The window does NOT open the route
rule** (`20261015100100_route_region_fixed`): a route's region cannot be changed in
it or anywhere else (§7, "A route never changes region").

**And, since the watch-and-prove branch (2026-10-24):** `PurgeSummary`, `SealRecord` and `IntegrityCheckResult` refuse UPDATE, DELETE and TRUNCATE the same way, and the test-record flag (`isTest` on Customer, User, Route, Region) can be set or cleared only inside this window. **A change to a sealed ledger row made in the window is reported by `seal-chain-intact`, and stays visible to `scripts/ops/verify-seals.ts` for good** (§5k): a deletion, by the next night (the totals, or the next seal's count against the one before); an edit to a row of the last seven seals, by the next night; an edit to an older row, the night the rotation recomputes its seal (within 28 nights while the run's budget holds) — run `verify-seals --all` after the window to see it at once. It is alerted once (critical), then shown as information while it stays. Rows written less than a day before the window that no seal has seen yet are NOT covered (§5k, "What is not covered"). Run `verify-seals` before and after, and log the reason with the rest of the entry: there is no in-system acknowledgement of a planned change (an open owner question), so the private operations log is where the critical alert is explained. The window itself still leaves no trace of its own (an `AuditMaintenanceLog` is not built).

Legitimate uses so far: test-fixture clean-up on isolated branches
(`tests/support/audit.ts`, including `purgeHistory`; the launch e2e clean-up's step 10;
`scripts/qa/purge-orphan-history.ts` on UAT, which refuses production) and the
synthetic-data wipe scripts. Of those scripts only
`prisma/synthetic.ts` (`--reset`, `--clear-only`) is left: `scripts/wipe-synthetic-data.ts`
and `scripts/cleanup-synthetic-test.ts` were deleted on 2026-10-11 (owner decision, data
audit 2026-10-10; §5j). The **go-live clean start** (§5m) is a legitimate
use, once, by owner decision of 2026-11-11: one `TRUNCATE` of the test period's
customer data, ledgers, logs and history, two partial DELETEs and the new baselines in
this window, in one transaction, through `scripts/ops/clean-start/reset.sql` only, run
by `.github/workflows/clean-start.yml` mode `apply` after the owner's Approve. The steps
above apply as follows: step 1 is the owner's operations-log entry written before the
run; step 2 is the DB Backup run the workflow refuses to start without (and the Neon
safety branch it makes); step 4's counts are in the reset's own AuditLog row
`cleanstart-<run>` and the encrypted report, never in the public log. The seal chain is
restarted rather than reporting the deletion: the old seals are archived first
(`cleanstart/<run>/seal-archive/`). The photo deletion at day 7 or later is a separate
approved run and writes its own AuditLog row. An erasure
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
- `r2: unconfigured` → one of `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` is missing from this deployment. On production that is a 503: no photograph can be uploaded. Set it in Vercel and redeploy.
- `warnings` holds `history:unattributed` → in the last 24 hours the application's database login changed a customer, shop, account, route or region, or cut a session off, without naming the cause: a code path missing `withChangeContext` (`docs/HISTORY.md` §5). The login is the one the application connects as — `nmwc_app`, or the owner while production still connects as the owner (AUDITOR-BRIEF §8); in the second case a change typed by hand under the owner login in that window warns too, and the rows tell which it was. The change itself was recorded (source `sql`); find the rows with `scripts/ops/history-report.ts` or the Steward's Record keeping card on `/status`, and report it as a defect. Never pages.
- `warnings` holds `history:triggers-disabled` / `history:triggers-missing` / `history:unreadable` → a history trigger was disabled or dropped (changes are going unrecorded), or the history could not be read. Re-enable it (`ALTER TABLE … ENABLE TRIGGER …`, owner) and record the gap in the private operations log; `scripts/ops/restore-verify.ts` T-03/T-10 list what should be there.
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

## 9. Credential handling and the shared-password trade-off

Keep current account inventories, initial-password status and rotation evidence in
private owner records. The accepted enrollment decision is recorded in HANDOVER §4;
it does not establish any account's current credential or usage state.

For an individual application password, use §7, "Reset password for a user".
Use `docs/CREDENTIAL-ROTATION.md` for infrastructure credentials, following HANDOVER §5.
Never infer usable logins from historical seed examples or publish per-account
credential-state observations here.

## 10. Things to do before real pilot

- [ ] Replace the seeded administrator password (see the private credential record).
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
