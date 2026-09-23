# Rotating the production database credential — 2026-09-23

## What happened

On 2026-09-23, while working out how to reach the production database directly,
the full production connection string — host, role and password — was shown in a
terminal screenshot and passed through a working transcript. The role is
`neondb_owner`, which is the **owner** of the production database: it can read
every customer row, every employee password hash, and it can drop the schema.

Treat that password as public. Nothing suggests it has been used by anyone else,
and nothing here is an emergency in the "we are being attacked" sense — but a
credential that has been in a screenshot is not a secret any more, and it is the
strongest one this system has.

The load was finished first, deliberately and at your instruction, because
rotating mid-load would have left a half-imported customer master. The load is
done. This is the next thing.

---

## What you need open

- The Neon console, on the NMWC project
- The Vercel dashboard, on the NMWC project
- GitHub → the repository → Settings → Secrets and variables → Actions
- Your password manager

Allow about 30 minutes. Steps 1 and 2 each end with a verification you should not
skip; if one fails, stop there rather than continuing.

---

## Before you start: two new passwords

Generate both in the password manager and save them there **first**, before
pasting them anywhere. Each needs 24+ characters and **must not contain a single
quote** (`'`) — the provisioning script refuses one, because the password is
interpolated into a SQL statement.

- one for `nmwc_app` — the least-privilege application role
- one for `neondb_owner` — you will not need to invent this one; Neon generates it

---

## Step 1 — move the application off the owner role

**Do this first.** Right now the production application connects as
`neondb_owner` — I checked, and all four live connections during the customer
load were the owner. That is why this step comes first: once the app is on
`nmwc_app`, resetting the owner password in step 2 does not touch the running
site at all, and there is no window where the app is down.

The role `nmwc_app` already exists on production, with its privilege set applied.
It has simply never been used. This step gives it a fresh password and points the
app at it.

1. GitHub → Settings → Secrets and variables → Actions → **Secrets**. Find
   `NMWC_APP_PASSWORD` and **Update** it to the new app password. (Update, not
   New — a second secret with the same name is not possible, but a typo'd name
   silently reads as empty.)

2. GitHub → **Actions** → **Provision app role** → Run workflow. In the confirm
   box type the endpoint id exactly:

   ```
   ep-sweet-haze
   ```

   Leave `dry_run` unchecked. The job refuses to touch any database whose
   `DIRECT_URL` does not contain what you typed, resets the role's password,
   re-applies the grants, and then connects **as** `nmwc_app` to prove each
   refusal still holds. Wait for it to go green.

3. Vercel → Project → Settings → Environment Variables → **Production**. Edit
   `DATABASE_URL`:

   - user: `nmwc_app`
   - password: the new app password
   - host: **must contain `-pooler`** — this is the pooled endpoint, and the
     application depends on it
   - leave the database name and the `?sslmode=require` query exactly as they are

   **Leave `DIRECT_URL` alone in this step.** Migrations and the nightly backup
   need the owner.

4. Vercel → Deployments → the current production deployment → **Redeploy**.
   An environment variable does not take effect until a deployment picks it up.

5. **Verify before moving on:**

   ```bash
   npm run smoke
   ```

   Fourteen checks, no credentials, about fifteen seconds. All fourteen must
   pass. Then sign in to the app and open **Customers** and **Work items** — a
   missing grant shows up as a page that loads and then errors, not as a failed
   smoke check.

   If anything fails: set `DATABASE_URL` back to the owner value and redeploy.
   The role can stay; it is inert until something connects as it. Then tell me
   what broke rather than forcing it.

---

## Step 2 — rotate the owner password

1. Neon console → the NMWC project → **Roles** → `neondb_owner` → **Reset
   password**. Neon shows the new password **once**. Copy it into the password
   manager immediately, along with both connection strings it offers — the
   direct one and the pooled one.

   The moment you confirm this, every existing connection using the old password
   fails. If step 1 is done, that is nothing user-facing: the app is on
   `nmwc_app`. If you skipped step 1, the site is down from here until step 2.3
   and a redeploy.

2. Vercel → Settings → Environment Variables → **Production** → `DIRECT_URL` =
   the new **direct** (non-pooler) connection string.

   If you skipped step 1, also set `DATABASE_URL` to the new **pooled** owner
   string in the same edit.

3. Vercel → Deployments → **Redeploy** production.

4. GitHub → Settings → Secrets and variables → Actions → Secrets → `DIRECT_URL`
   → Update, with the same direct string.

   Paste **only the value**. Not `DIRECT_URL=…`, not wrapped in quotes. The
   backup job checks for both and fails the run with a message naming the
   mistake, which is better than backing up nothing quietly — but it still means
   a night without a backup if you do not notice.

---

## Step 3 — clean this machine

The old password is still sitting in four places on this laptop.

1. Delete the scratch file that held the connection string:

   ```bash
   del C:\Users\abdulr\prod-url.txt
   ```

2. `C:\Users\abdulr\Desktop\NMWC-CRM\.env` and
   `C:\Users\abdulr\Desktop\NMWC-CRM\.env.local` both point `DATABASE_URL` **and**
   `DIRECT_URL` at production.

   This is worth a second of alarm on its own: it means any script run from the
   main checkout — a seed, a migration, a one-off — talks to production by
   default. Repoint both files at the UAT branch, or empty the two values. The
   worktree's own `.env` already points at UAT and does not need changing.

3. Close the terminal window that displayed the string, so it is not in
   scrollback, and delete the screenshot from wherever it was saved.

---

## Step 4 — prove it worked

```bash
npm run smoke
```

- all fourteen checks pass
- GitHub → Actions → **DB Backup** → Run workflow → green, and the object in the
  bucket ends `.sql.gz.age`. That run is what proves the new `DIRECT_URL` secret
  is correct; nothing else exercises it.
- Sign in as the Data Steward and open one page that reads customers.
- Neon → Monitoring: no connection should still be failing to authenticate.

---

## What this does **not** rotate

Say these out loud to yourself, because a rotation that quietly leaves something
behind is worse than one that never happened.

- **The 62 application account passwords.** They are `12345` by your decision,
  they are in `golive-data/credentials.xlsx`, and they are unchanged by any of
  the above. They are meant to be changed by each person at first sign-in. That
  is a separate piece of work and it is not done.
- **`NEXTAUTH_SECRET`.** Not exposed. Rotating it signs every user out
  immediately, so do not do it casually. Leave it.
- **`BACKUP_AGE_IDENTITY`, the R2 access keys, `PROD_CRON_SECRET`,
  `HEALTH_BEARER`, `NEON_API_KEY`.** None of these were shown in the screenshot
  or the transcript. They do not need rotating for this incident.
- **Neon point-in-time recovery and the existing backups.** A dump taken before
  the rotation is still valid and still restorable — restoring it does not
  restore the old password, because the password lives on the role, not in the
  dump.
