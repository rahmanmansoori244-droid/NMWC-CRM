# NMWC Customer Master — Operations Runbook

This is the operator's manual: what to do when something breaks, how to deploy, where data lives. Companion to [PRD-v0.1.md](PRD-v0.1.md), [UX-SPEC.md](UX-SPEC.md), [TECH-SPEC.md](TECH-SPEC.md).

---

## 1. Production URL

- App: **https://nmwc-cm.vercel.app** (Vercel-issued; custom domain TBD)
- Health: https://nmwc-cm.vercel.app/api/health → returns `{app, db, r2}` checks

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

## 6. Backups

- **Neon PITR:** point-in-time recovery, 7 days on the Launch plan.
- **Manual logical dump:** `npx prisma db pull` exports schema; for data, run `pg_dump` against `DIRECT_URL`.
- **R2 photos:** R2 has 11 nines durability; we keep originals indefinitely. To take a copy, use `rclone copy r2:nmwc-photos /backup/path` (configure rclone with the same R2 keys).

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

## 9. Test users (synthetic data)

Synthetic data is regenerated by `npm run db:synthetic:reset`. All test passwords are `Demo!2026Demo`.

| Username pattern | Role | Use to test |
|---|---|---|
| `admin` (password `ChangeMeNow!2026`) | MANAGER | Original seed admin |
| `manager.a` / `manager.b` | MANAGER | Two managers split across 7 regions |
| `supervisor.1` … `supervisor.7` | SUPERVISOR | Approval queue |
| `salesman.<route-code>` (e.g. `salesman.mct-01`) | SALESMAN | Field-side enrichment, mobile UX |
| `steward` | STEWARD | Imports, exports, duplicates |
| `viewer` | VIEWER | Read-only dashboard |

⚠️ Replace these synthetic accounts before pilot. Disable them in `/users`, then run the real Account-master upload.

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
