# NMWC Customer Master — Operations Runbook

This is the operator's manual: what to do when something breaks, how to deploy, where data lives. Companion to [PRD-v0.1.md](PRD-v0.1.md), [UX-SPEC.md](UX-SPEC.md), [TECH-SPEC.md](TECH-SPEC.md).

---

## 1. Production URL

- App: **https://nmwc-cm.vercel.app** (Vercel-issued; custom domain TBD)
- Health: https://nmwc-cm.vercel.app/api/health → public callers always see `{ "status": "ok" }` with HTTP 200 (B-12; no information leak about DB/R2 state). Authenticated monitoring with `Authorization: Bearer $HEALTH_BEARER` gets the full `{app, db, r2}` checks payload and a 503 status when any check fails.

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

Vercel's build pipeline runs `prisma generate` automatically (configured in `package.json`). Migrations are NOT auto-deployed on Vercel — you run `prisma migrate deploy` manually before the deploy that needs the new schema.

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

## 6. Backups

- **Neon PITR:** point-in-time recovery, 7 days on the Launch plan.
- **Off-Neon daily dump (B-01):** GitHub Actions workflow `.github/workflows/db-backup.yml` runs at 02:00 UTC daily and on manual dispatch. It `pg_dump`s `DIRECT_URL` (`--no-owner --no-privileges --format=plain --no-unlogged-table-data`), gzips, and uploads to R2 bucket `nmwc-backups` at key `db/<YYYY-MM-DD>.sql.gz`. Failures (any non-zero exit from pg_dump or aws s3 cp) surface as a red workflow run.
  - **Required GitHub secrets:** `DIRECT_URL`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET=nmwc-backups`. For the restore-drill job: also `NEON_API_KEY`, `NEON_PROJECT_ID=snowy-haze-29025382`.
  - **Restore drill:** `Actions → DB Backup → Run workflow` runs the `restore-drill` job, which downloads the most recent dump and restores it into a Neon branch named `restore-drill-<DATE>`. After verifying, delete the branch in the Neon console (it costs storage, not free).
- **Manual logical dump:** `npx prisma db pull` exports schema; for data, run `pg_dump` against `DIRECT_URL`.
- **R2 photos:** R2 has 11 nines durability; we keep originals indefinitely. To take a copy, use `rclone copy r2:nmwc-photos /backup/path` (configure rclone with the same R2 keys).

### R2 backup & versioning

Two independent buckets, each with its own lifecycle policy.

**`nmwc-photos` (production photo storage)** — operator must configure once in the Cloudflare R2 dashboard:

1. **Object Versioning:** enable on the bucket. This way, if the photo-gc cron tags an object incorrectly or someone overwrites a key, the previous version is recoverable.
2. **Lifecycle rule — `gc-marked` expiry:** `nmwc-photos` → Settings → Lifecycle rules → "Add rule":
   - Condition: object tag `gc-marked=true`.
   - Action: expire objects 7 days after the tag is applied.
   - Why: `app/api/cron/photo-gc/route.ts` no longer hard-deletes from R2 (B-02). Instead it tags soft-deleted attachments with `gc-marked=true` and `gc-marked-at=<isoDate>`. The bucket lifecycle is what permanently removes them, leaving a 7-day window to recover from a faulty cron run or operator mistake.
3. **Optional non-current version expiry:** with versioning on, set non-current versions to expire after 30 days so old overwrites don't accumulate forever.

**`nmwc-backups` (off-Neon SQL dumps from B-01)** — operator must configure once:

1. **Lifecycle rule — 30-day retention:** `nmwc-backups` → Settings → Lifecycle rules → "Add rule":
   - Condition: object age greater than 30 days under prefix `db/`.
   - Action: delete.
2. **No versioning needed** — dumps are immutable per-day artifacts; `db/<DATE>.sql.gz` is overwritten only if a same-day re-run happens.
3. **Separate credentials from `nmwc-photos`.** The GitHub Actions workflow uses `BACKUP_R2_*` secrets, never the production photo R2 keys. Compromise of one bucket does not expose the other.

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

### Symptom: `/api/health` returns degraded
Public `/api/health` always returns 200 + `{ "status": "ok" }` (B-12). To see real status, hit it with `Authorization: Bearer $HEALTH_BEARER`:
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
