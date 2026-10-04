# 02 — Access, accounts and secrets

This page is for the person taking over NMWC CRM from the owner. It lists every
outside account the project runs on and every secret the project uses. For each one
it says what it is for, where it is set up, who holds it today, how to hand it over,
and where its value is kept.

**This file is public.** The repository is public by owner decision (2026-09-27,
[HANDOVER §4](../HANDOVER.md)). This page names accounts and variables. It never
holds a value. If you ever find a value here, remove it and rotate it. Git history
keeps the old version.

Two lists in the repository are kept accurate by tests. This page builds on them and
does not replace them:

| List | What it covers | What keeps it true |
|---|---|---|
| [docs/SECRETS-INVENTORY.md](../SECRETS-INVENTORY.md) | Every runtime variable the app reads, what a leak exposes, and which other places must hold the same value | `tests/unit/secrets-inventory.test.ts` |
| [lib/ops/required-secrets.ts](../../lib/ops/required-secrets.ts) | Every GitHub Actions secret and variable the workflows read | `tests/unit/required-secrets.test.ts`; print it with `npm run ops:print-secrets` |

If this page disagrees with either list, the list is right. Those lists are tested and
this page is not.

---

## 0. Ground rules

- **Values never go into this repository.** That covers passwords, connection
  strings, tokens, keys and webhook URLs, in whole or in part.
- **Private material is in the private handover pack.** This is one AES-256 encrypted
  archive. The owner gives you the encrypted pack and, separately, its password. Its
  index is `PRIVATE-HANDOVER.md`, inside the pack. It holds the `.env` files,
  `golive-data/`, the private backups, the chat history (§2.11), Claude's memory, the
  operator scripts, the source spreadsheets and the 2026-10-04 user guides (§2.8). It
  does **not** hold the backup decryption key (§2.10). None of it ever goes to GitHub.
  - The pack is sealed after this documentation set is merged to `main`, so the
    repository bundle inside it contains these pages. `PRIVATE-HANDOVER.md` records
    the `main` commit the pack was built from.
  - **To open it,** use Git Bash, or a macOS or Linux terminal, in a folder that is not
    synced and not inside any checkout
    ([05 §5](05-NEW-COMPUTER-SETUP.md#5-open-the-pack-secrets)). `HOW-TO-OPEN.txt`
    sits next to the pack.

    ```bash
    gpg --output pack.tar.gz --decrypt NMWC-CRM-handover-2026-10-04.tar.gz.gpg && tar -xzf pack.tar.gz
    ```

    Then run `sha256sum -c MANIFEST.sha256` inside the unpacked folder. `pack.tar.gz`
    is an unencrypted copy of everything, so delete it once that check passes.
- **Never print a `.env` file.** Do not use `cat`, `type`, `grep` or `Select-String`
  on it, and do not open it while sharing your screen. Those commands print the whole
  line, password included. To check whether a file points at production, run
  `node scripts/dev/env-check.cjs [file]`. It prints only whether something points at
  production, never a value ([AGENTS.md](../../AGENTS.md), "Before you start" item 4).
- **Put any command that contains quotes, backticks, `$` or backslashes in a script
  file.** Never run it through `node -e` or a heredoc. That mistake once printed part
  of a production password into a transcript ([CLAUDE.md](../../CLAUDE.md), Safety).
- **Before you commit a document,** run `node scripts/dev/leak-check.cjs <file>`. It
  looks only for the known password literals, so read your diff as well.
- **Before every commit,** `git status --short` must show no `golive-data` path and no
  env file ([CLAUDE.md](../../CLAUDE.md), Safety). §3 explains which env file names
  Git does *not* ignore.

---

## 1. At a glance

"Owner" means the person handing over. Every account below is in the owner's name
today.

| # | Account or item | What it is for | Holder today | How to hand it over | Where the values are |
|---|---|---|---|---|---|
| 1 | GitHub repository `rahmanmansoori244-droid/NMWC-CRM` | Code, CI, Dependabot and Actions secrets. **Merging to `main` deploys production.** | Owner (personal account) | Transfer the repository, or move it into an organisation (§2.1) | Secrets cannot be read back from GitHub. §2.2 says where each value comes from |
| 2 | Vercel project `nmwc-cm` (Pro plan) | Hosting, preview builds, scheduled jobs, logs, runtime variables | Owner | Add as a member, or transfer the project (§2.3) | Vercel → Settings → Environment Variables. Vercel shows a value again unless it was saved as Sensitive. The pack's env files hold copies of some, but not of `CRON_SECRET`, `HEALTH_BEARER` or `MAINTENANCE_BYPASS_TOKEN` (§2.3, §3) |
| 3 | Neon project `nmwc-cm` | Postgres: the production branch and the UAT branch `uat-testing` | Owner | Add as an organisation member, or transfer (§2.4) | Neon console. The connection strings are also in the pack's `.env` files |
| 4 | Cloudflare account (R2) | The photo bucket `nmwc-photos` and the backups bucket | Owner | Manage account → Members (§2.5) | Tokens are shown once, at creation. The app photo token is in Vercel and the pack's env files; the backup and admin tokens are only in GitHub, which cannot show them again |
| 5 | Sentry, org `nmwc`, project `nmwc-cm` | Error reports | Owner | The free plan has one user (§2.6) | The DSN is in Vercel and in the production env files |
| 6 | cron-job.org | The old external scheduler | Owner | **Do not transfer it. Retire it** (§2.7) | `CRONJOB_API_KEY` in GitHub |
| 7 | Production URL `https://nmwc-cm.vercel.app` | The app's address | Comes with the Vercel project | There is no custom domain, so there is nothing separate to transfer (§2.8) | — |
| 8 | Alert webhook | Alerts for failed jobs, SLA escalations and import rejections | Not set up yet | Create one in a channel the new person reads (§2.9) | Vercel `ALERT_WEBHOOK_URL` |
| 9 | External uptime monitor | Raises an alarm when `/api/health` fails | Not recorded in the repo | Ask the owner (§2.9) | If one exists, it holds `HEALTH_BEARER` |
| 10 | Backup encryption key (age) | The only way to read a nightly backup | Not recorded. No copy was found on the owner's computer, and none is in the pack | **The owner's first action before handing over:** put a copy in the pack, or add the new person's key and prove one decrypt (§2.10) | GitHub `BACKUP_AGE_IDENTITY` holds one copy, which GitHub cannot show again |
| 11 | Claude Code (Anthropic) | AI reviewer and operator. Since 2026-10-01 it has also carried out the merges the owner approved (§2.1) | Owner's personal subscription | Cannot be transferred. Use your own (§2.11) | The chat exports, the raw session folders and Claude's memory are in the pack |
| 12 | Codex (OpenAI) | AI builder on `codex/*` branches | Owner's personal subscription | Cannot be transferred. Use your own (§2.11) | Codex's own history is not in the pack. Its private notes are, in `NMWC-Private-Backups` |
| 13 | Billing on each paid provider | Pays for Vercel Pro, the Neon plan and any Cloudflare usage | Owner's payment method | Move the billing owner on each provider (§2.12) | Each provider's Billing page |
| 14 | Personal logins, 2FA and personal tokens | How each account above is reached | Owner | New logins by invite; the owner revokes their own tokens at the end (§2.13) | Private |
| 15 | Local `.env` files | Operator scripts, tests, local development | Owner's computer | Copies are in the pack (§3) | Pack. §3 lists the names each file holds, and the values that are in no local file |
| 16 | Application accounts (`data.steward` and others) | Day-to-day administration inside the app | The owner. Keep at least two Data Steward accounts; the current state is in `PRIVATE-HANDOVER.md` | The owner, signed in as a Data Steward, creates a named Steward account for the new person (§4) | No application password is written in the handover docs |

**E-mail: the notification sending mailbox (F1, 2026-10-05, not yet merged).** The
notification e-mail (`lib/email/`, [OPERATIONS §5i](../OPERATIONS.md)) is sent from
the owner's own Gmail account (his decision), through SMTP with an app password held in
Vercel as `GMAIL_APP_PASSWORD` beside `GMAIL_ADDRESS`; it sends nothing until
`NOTIFY_EMAIL_ENABLED=on`. That app password opens the whole mailbox, and a personal
Gmail account cannot be handed over without its owner's login: before the handover,
either move the sender to a dedicated or company mailbox (a new app password, set in
Vercel, then redeploy — [CREDENTIAL-ROTATION](../CREDENTIAL-ROTATION.md)), or record
that the owner keeps it ([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md)). Whether the
variables are set, and on which environments, is private.

The smallest set that lets someone keep production running is GitHub, Vercel, Neon
and the age private key ([SECRETS-INVENTORY §4](../SECRETS-INVENTORY.md)). Hand those
over first. The age private key is the one of the four that no account invite can
hand over, and the pack does not contain it (§2.10).

---

## 2. Each account in detail

### 2.1 GitHub — the repository

- **What it is:** `rahmanmansoori244-droid/NMWC-CRM`. It is public and sits on the
  owner's personal account.
- **What it controls:** the code. Production deploys from `main` through Vercel's
  GitHub integration. No file in the repo sets that integration up
  ([AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md)). GitHub also holds every Actions
  secret and variable, runs the scheduled backup and check workflows, and runs
  Dependabot.
- **How `main` moves:**
  - The owner approves every merge in words ("merge it").
  - Since 2026-10-01, Claude has carried out each approved merge by pushing the exact
    CI-green commit to `main`, with the procedure in
    [03 §4](03-OPERATIONS-AND-DEPLOYMENT.md#4-deploying-moving-main):
    `scripts/dev/ci-watch-sha.sh`, `scripts/dev/build-id.cjs`, `npm run smoke`,
    `git push origin <sha>:refs/heads/main`, then `scripts/dev/deploy-watch.sh`.
  - The alternative recorded in [HANDOVER §2](../HANDOVER.md) is the owner using
    GitHub's **Rebase and merge**.
  - Codex never merges and never pushes `main`.
  - Who approves merges after the handover is for the owner and the new person to
    agree. It is on the fill-in list in `PRIVATE-HANDOVER.md`.
- **Settings worth knowing:**
  - `allow_update_branch=false`, so a missing **Update branch** button proves
    nothing ([HANDOVER §2](../HANDOVER.md) step 6).
  - **Branch protection: check it now.** [AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md)
    records it as unavailable, after a 403 on 2026-09-14. The repository has been
    public since 2026-09-27. GitHub's documentation says the free plan offers branch
    protection and rulesets for public repositories. Look under Settings → Branches
    and Settings → Rules. A rule on `main` matters because merging deploys. Whether to
    add one is the repository owner's decision: a rule that requires a review or a
    status check changes the merge steps in [HANDOVER §2](../HANDOVER.md), and a rule
    that requires a pull request refuses the direct push above unless the pusher is
    allowed to bypass it.
- **The limit:** on a personal repository, a collaborator can push code but cannot
  manage settings or secrets ([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md)).

**How to hand it over:**

| Option | What the new person gets | Notes |
|---|---|---|
| A. Transfer the repository to the new person's account | Full admin | The simplest option. The owner loses admin rights. |
| B. Move it into a GitHub organisation and make both people admins | Full admin. The owner keeps access until removed | The free plan allows this ([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md)). |
| C. Add the new person as a collaborator only | Push access only. No secrets, no settings | Not enough to run the project alone. |

**After option A or B, check each of these:**

1. **The Vercel ↔ GitHub connection.** Open Vercel → project → Settings → Git and
   reconnect as described in [OPERATIONS §5b A](../OPERATIONS.md). If the connection
   is broken, merges to `main` stop deploying. Do not fall back to deploying from a
   laptop.
2. **Every secret and variable name in §2.2 is still present.** `gh secret list`
   prints secret names only. `gh variable list` also prints the variables' values.
   None of those values is a credential. But `PROD_DB_HOST_MARKER` holds the full
   production endpoint id, which the public docs deliberately shorten to
   `ep-sweet-haze…`. Do not paste that output into an issue, a PR or a chat.
3. **Every place the repository name is written.** Update the ones that people or
   tools follow:
   - `REPO` in `scripts/print-required-secrets.ts`.
   - The `gh api repos/…/compare` command in [AGENTS.md](../../AGENTS.md) ("When you
     finish a task"), [HANDOVER §2](../HANDOVER.md) and
     [AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md). Codex follows the AGENTS.md copy.
   - [SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md) (the GitHub row).
   - [OPERATIONS §2](../OPERATIONS.md) (the first row) and
     [OPERATIONS §5b A](../OPERATIONS.md) (the URLs).
   - Dated reports also name it (`docs/BUILD-REPORT.md`, `docs/QA-AUDIT-REPORT.md`,
     `docs/SESSION-MASTER-RECORD.md`). They are records of the past. Updating them is
     optional.
   - Run `git grep -l rahmanmansoori244-droid` to find any others.

   The owner's **Vercel team name** is also written in [OPERATIONS §2, §3 and
   §5b A](../OPERATIONS.md). Update it if the Vercel project moves (§2.3).
4. **The secrets scan.** CI's `secrets-scan` job runs `gitleaks/gitleaks-action@v3`
   with only `GITHUB_TOKEN` (`.github/workflows/ci.yml`). If the repository moves into
   an organisation, check that action's documentation in case it needs a licence key
   for organisation-owned repositories. Any new secret name you add to a workflow
   must also go into `lib/ops/required-secrets.ts`, or `required-secrets.test.ts`
   fails.
5. **The scheduled workflows stay enabled.** GitHub's documentation says it disables
   scheduled workflows in a public repository after 60 days with no repository
   activity. If nobody pushes for two months, the nightly **DB Backup** stops. Look
   for a "disabled" banner in the Actions tab.
6. **Who receives scheduled-run failures.** GitHub's documentation says it sends a
   scheduled workflow's failure notices to the user who last changed its `cron` line,
   or who last re-enabled the workflow. It does not send them to the repository owner
   or to admins. Moving the repository or adding an admin does **not** redirect them.
   So today the owner gets every failure e-mail for the five scheduled workflows:

   | Workflow | Schedule line |
   |---|---|
   | DB Backup | `.github/workflows/db-backup.yml:54` |
   | Restore drill | `.github/workflows/restore-drill.yml:44` |
   | R2 bucket settings | `.github/workflows/r2-config.yml:39` |
   | Keep production warm | `.github/workflows/keep-warm.yml:23` |
   | SLA escalation sweep | `.github/workflows/sla-escalate.yml:15` |

   To take them over, the new person either disables and **immediately re-enables**
   each one in the Actions tab, or commits a change to each `schedule:` line. A change
   under `.github/workflows/**` is Tier B ([AGENTS.md](../../AGENTS.md), "PR review
   tiers"). Check GitHub's current documentation before relying on either.

**Dependabot.** [`.github/dependabot.yml`](../../.github/dependabot.yml) opens grouped
npm pull requests every Monday at 06:00 Asia/Muscat (minor and patch only; majors are
ignored on purpose), and GitHub Actions pull requests monthly. Their changes touch
`package.json`, `package-lock.json` or `.github/workflows/**`, so every one of them is
Tier B. Dependabot runs do not receive the repository's Actions secrets; GitHub keeps
a separate store for Dependabot secrets. Someone must own triaging these pull
requests. Name that person at handover (§6).

**The workflows and what they read:**

| File | Name in Actions | When it runs | Secrets and variables it reads |
|---|---|---|---|
| `ci.yml` | CI | Every push | `HEALTH_BEARER` (post-deploy smoke, `main` only) |
| `db-backup.yml` | DB Backup | 02:00 UTC daily, and on demand | `DIRECT_URL`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `PROD_CRON_SECRET`; variables `BACKUP_AGE_RECIPIENTS`, `APP_BASE_URL`, `PROD_DB_HOST_MARKER`, `MIN_DUMP_BYTES`, `ALLOW_PLAINTEXT_BACKUP` |
| `restore-drill.yml` | Restore drill | 04:00 UTC on the 1st of each month, and on demand | `BACKUP_AGE_IDENTITY`, the same four `BACKUP_R2_*` secrets, `NEON_API_KEY`, `NEON_PROJECT_ID`; variables `BACKUP_AGE_RECIPIENTS`, `PROD_DB_HOST_MARKER` |
| `r2-config.yml` | R2 bucket settings | 05:00 UTC daily, and on demand | `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ADMIN_ACCESS_KEY_ID`, `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY`, `R2_ADMIN_ACCESS_KEY_ID`, `R2_ADMIN_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`; variable `R2_BUCKET` |
| `keep-warm.yml` | Keep production warm | Every 4 minutes, 03:00–14:59 UTC | `PROD_CRON_SECRET`; variable `KEEP_WARM_PREVIEW_URL` |
| `sla-escalate.yml` | SLA escalation sweep | At :15 and :45, 03:00–14:59 UTC | `PROD_CRON_SECRET` |
| `provision-app-role.yml` | Provision app role | Manual only | `DIRECT_URL`, `NMWC_APP_PASSWORD` |
| `cron-scheduler.yml` | External cron scheduler | Manual only | `CRONJOB_API_KEY`, `PROD_CRON_SECRET`; variable `APP_BASE_URL` |

Vercel has run keep-warm and the SLA sweep since the move to Pro. The two GitHub
copies stay on as a sparse backup ([OPERATIONS §5d](../OPERATIONS.md)).

### 2.2 GitHub Actions secrets and variables

They live under GitHub → Settings → Secrets and variables → Actions. Secrets and
variables are on **separate tabs**. A value saved on the wrong tab reads as empty.

GitHub never shows a secret's value again after you save it. Each value in the
"Where the value comes from" column below is normally needed only to set a secret
again. Setting a credential again with a new value is a rotation, so read §5 first.

Of the credentials below, only two have a readable copy in the private pack:
`DIRECT_URL`, in the pack's env files (§3), and `NMWC_APP_PASSWORD`, in
`golive-data/prod-app-role.secret`. `PROD_CRON_SECRET` and `HEALTH_BEARER` hold the
same values as Vercel's `CRON_SECRET` and `HEALTH_BEARER`, which Vercel shows again
only if they were not saved as Sensitive (§2.3). Account ids and bucket names can be
read again in Cloudflare. Every token, bearer and key that has no copy anywhere else
must be generated again by whoever holds the account, and that is a rotation.

**Secrets (17):**

| Name | Required | Read by | Where the value comes from | The same value must also be in |
|---|---|---|---|---|
| `DIRECT_URL` | Yes | db-backup, provision-app-role | Neon: the owner role's **direct** (non-pooler) connection string | Vercel `DIRECT_URL`; the local production env file |
| `BACKUP_R2_ACCOUNT_ID` | Yes | db-backup, restore-drill, r2-config | Cloudflare → R2 | — |
| `BACKUP_R2_BUCKET` | Yes | db-backup, restore-drill, r2-config | The backups bucket's name | — |
| `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` | Yes | db-backup, restore-drill | An R2 token with Object Read & Write on the **backups bucket only** | — |
| `BACKUP_R2_ADMIN_ACCESS_KEY_ID`, `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY` | Yes | r2-config | An R2 token with Admin Read & Write on the **backups bucket only** | — |
| `R2_ADMIN_ACCESS_KEY_ID`, `R2_ADMIN_SECRET_ACCESS_KEY` | Yes | r2-config | An R2 token with Admin Read & Write on the **photos bucket only** (a second, separate token) | — |
| `R2_ACCOUNT_ID` | No | r2-config | Needed only if the photos bucket is in a different Cloudflare account from the backups bucket | — |
| `PROD_CRON_SECRET` | Yes | cron-scheduler, db-backup, keep-warm, sla-escalate | Generated: 32 or more random characters. The same value as Vercel's `CRON_SECRET`. No local env file holds it. Read it in Vercel if it was not saved as Sensitive; otherwise, if no copy exists elsewhere, set a new value in every place in the last column at once (a rotation, §5) | Vercel `CRON_SECRET`, and cron-job.org until it is retired |
| `CRONJOB_API_KEY` | No | cron-scheduler | cron-job.org → Settings → API | — (delete it when you retire cron-job.org) |
| `HEALTH_BEARER` | Yes | ci | The same value as Vercel's. No local env file holds it. Read it in Vercel if it was not saved as Sensitive; otherwise, if no copy exists elsewhere, set a new value in every place in the last column at once (a rotation, §5) | Vercel `HEALTH_BEARER`; the external uptime monitor, if one exists |
| `BACKUP_AGE_IDENTITY` | Drill only | restore-drill | One age **private** key (§2.10) | Wherever that private key is kept. No copy was found on the owner's computer, and none is in the pack (§2.10) |
| `NEON_API_KEY` | Drill only | restore-drill | Neon → API keys (§2.4) | — |
| `NEON_PROJECT_ID` | Drill only | restore-drill | Neon → Project settings | — |
| `NMWC_APP_PASSWORD` | Manual workflow only | provision-app-role | Generated. At least 24 characters, no single quote. The production value has a copy in the private pack (`golive-data/prod-app-role.secret`) | The `nmwc_app` role in Neon, and Vercel `DATABASE_URL` whenever the app connects as that role (§2.4) |

**Variables (7):**

| Name | Required | What it holds |
|---|---|---|
| `BACKUP_AGE_RECIPIENTS` | Yes | The age **public** keys, separated by commas. Without them the nightly backup refuses to run |
| `APP_BASE_URL` | Yes | The production origin, with no trailing slash |
| `PROD_DB_HOST_MARKER` | Yes | The production endpoint id. Without it the restore drill refuses to run. Do not paste it into public places (§2.1 check 2) |
| `KEEP_WARM_PREVIEW_URL` | No | A second address to keep warm, normally the UAT preview |
| `R2_BUCKET` | No | The photos bucket's name. Leave it unset while it is `nmwc-photos` |
| `MIN_DUMP_BYTES` | No | The size below which a dump counts as truncated |
| `ALLOW_PLAINTEXT_BACKUP` | **Leave it unset** | An emergency switch that uploads an unencrypted dump |

`GITHUB_TOKEN` comes from GitHub itself. Never set it.

A comment in `restore-drill.yml` mentions `NEON_DRILL_ENABLED`. No workflow reads
that variable any more, so do not create it.

### 2.3 Vercel — hosting

- **What it is:** project `nmwc-cm`, on the Pro plan since 2026-09-27. Its functions
  run in `iad1` ([vercel.json](../../vercel.json)). [OPERATIONS §2](../OPERATIONS.md)
  names the team.
- **What it controls:**
  - Production deploys from `main`.
  - A preview deploy for every branch push. Each preview runs
    `prisma migrate deploy` against UAT.
  - Instant rollback.
  - The four scheduled jobs in `vercel.json`: `photo-gc`, `retention-sweep`,
    `keep-warm` and `sla-escalate`.
  - Runtime logs. They are kept 30 days with Observability Plus
    ([OPERATIONS §5g](../OPERATIONS.md)). Confirming that it is on is still open
    ([HANDOVER §6.2](../HANDOVER.md)).
  - Every runtime variable.
- **Why it matters:** the production build runs `prisma migrate deploy` with
  `DIRECT_URL` before `next build`. So whoever can edit Vercel's `DIRECT_URL`
  decides which database production migrates.
- **The CLI link is committed.** [`.vercel/project.json`](../../.vercel/project.json)
  holds the project id and the team (org) id. They are identifiers, not secrets. The
  Vercel CLI (`npx vercel env ls`, `npx vercel env pull`) uses this file to find the
  project, as well as your token. If the project moves to another team, run
  `npx vercel link` in a clean clone and commit the updated file through a normal PR.

**How to hand it over:** Settings → Members. A developer seat can deploy and change
variables. [SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md) recorded it at $20 a month
in September 2026; check the current price. A Viewer seat is free and read-only. The
other way is to move the project into the new person's team. Read Vercel's own
documentation on project transfer before you do that. Billing is a separate step
(§2.12).

**After either, check:**

1. The Git connection to the repository ([OPERATIONS §5b A](../OPERATIONS.md)).
2. The plan is still Pro. The sub-daily schedules for keep-warm and the SLA sweep
   moved to Vercel because of Pro ([OPERATIONS §5d](../OPERATIONS.md)).
3. Settings → Cron Jobs lists the four jobs. The in-app **Service status** page says
   "Vercel last ran it" for keep-warm and the SLA sweep.
4. Every Production name below is present. `npx vercel env ls` lists names; it needs
   your own `VERCEL_TOKEN` or a login ([OPERATIONS §3](../OPERATIONS.md)), and the
   link in `.vercel/project.json`.
5. `npm run smoke` passes. It runs 14 checks, needs no credentials and takes about
   fifteen seconds.
6. Vercel's own notifications (failed deployments, usage, billing) go to the account
   that set them up. The new person sets their own in their Vercel account settings.

**Production variables.** Names only. What each one does is in
[SECRETS-INVENTORY §2](../SECRETS-INVENTORY.md).

| Group | Names | Secret? |
|---|---|---|
| Database | `DATABASE_URL`, `DIRECT_URL` | Yes |
| Sign-in | `AUTH_SECRET` and `NEXTAUTH_SECRET` (the same value) | Yes |
| Sign-in | `AUTH_URL` and `NEXTAUTH_URL` (the same origin), `AUTH_TRUST_HOST` | No |
| Machine bearers | `CRON_SECRET`, `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN` | Yes |
| Photos (R2) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Yes |
| Photos (R2) | `R2_ACCOUNT_ID`, `R2_BUCKET` | No |
| Alerts | `ALERT_WEBHOOK_URL` (not set yet) | Yes |
| Errors | `NEXT_PUBLIC_SENTRY_DSN` (sent to the browser by design) | No |
| Switches | `DEMO_ACCOUNTS_DISABLED`, `MAINTENANCE_MODE`, `SALESMAN_SUBMIT_GATE`, `RATE_LIMIT_BACKEND`, `LOG_LEVEL` | No |
| Tuning | `PROMOTE_SLICE_BUDGET_MS`, `BULK_BUDGET_MS`, `WORK_TZ_OFFSET_MIN`, `WORK_DAYS`, `WORK_HOUR_START`, `WORK_HOUR_END`, `SLA_SUPERVISOR_MIN`, `SLA_ACCOUNTANT_MIN`, `SLA_MANAGER_MIN`, `SLA_FINANCE_MIN`, `SLA_GM_MIN` | No |
| Set by the platform | `NODE_ENV`, `NEXT_RUNTIME`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`. `next.config.ts` derives `NEXT_PUBLIC_SENTRY_ENV` and `NEXT_PUBLIC_SENTRY_RELEASE` from the last two | Never set by hand |

An optional name that is not set falls back to the code's default. Two of these must
stay as they are in production:

- **`DEMO_ACCOUNTS_DISABLED` must stay exactly `true`.** The code compares it with
  the string `true` (`lib/auth.ts`, `app/(app)/users/page.tsx`). Any other value,
  such as `1`, `yes` or `TRUE`, turns the block off. That re-enables the seeded demo
  accounts, whose passwords are public ([AUDITOR-BRIEF §9](../../AUDITOR-BRIEF.md)).
  `npm run smoke` does not check it.
- `RATE_LIMIT_BACKEND` must never be `memory`. That value is for tests only.

**Other Vercel environments.** The repository cannot see Vercel's settings
([AUDITOR-BRIEF §3](../../AUDITOR-BRIEF.md)), so check each of these in the dashboard:

- **Preview.** [SESSION-MASTER-RECORD §4](../SESSION-MASTER-RECORD.md) records that
  `DATABASE_URL` and `DIRECT_URL` point Preview at the UAT branch `uat-testing`.
  `AUTH_URL` may also apply to Preview. The code removes it on any deployment that is
  not production (`lib/auth.ts`, `auth.config.ts`).
- **Development.** The same record says the Development database variables point at
  **production**. If that is still true, `npx vercel env pull` writes production
  database credentials into a local file. Check before you pull. Better still,
  re-point Development at UAT.

**Values you may not be able to read back.** Vercel shows an environment variable's
value again unless it was saved as Sensitive ([OPERATIONS §5d](../OPERATIONS.md) warns
that `CRON_SECRET` may not be revealable), and GitHub never shows a secret again. The
pack's env files hold copies only of the names listed in §3; the pack also holds a copy
of `NMWC_APP_PASSWORD` (§3). `CRON_SECRET`, `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN`,
`BACKUP_AGE_IDENTITY` and the other values that live only in Vercel or GitHub are in no
local file. `CRON_SECRET`, `HEALTH_BEARER` and `MAINTENANCE_BYPASS_TOKEN` can be read in
Vercel if they were not saved as Sensitive. Otherwise, and for the values that live only
in GitHub, if no copy exists anywhere else they cannot be recovered: whoever holds those
accounts must generate new values, which is a rotation (§5).

**CLI token.** The `VERCEL_TOKEN` in [OPERATIONS §3](../OPERATIONS.md) is a personal
access token. It is not a project secret. Make your own; do not reuse the owner's.

### 2.4 Neon — the database

- **What it is:** one project, `nmwc-cm`, in AWS us-east-1. The project id and
  console link are in [OPERATIONS §2](../OPERATIONS.md).
  [OPERATIONS §11](../OPERATIONS.md) records the plan as Launch; check this.
- **Branches:**
  - **Production**, endpoint `ep-sweet-haze…`. Every safety check in this repository
    looks for that string.
  - **UAT**, branch `uat-testing`, endpoint `ep-lucky-bar…`. Keep its auto-delete set
    to **Never**. An earlier UAT branch deleted itself in the middle of testing
    ([SESSION-MASTER-RECORD §4](../SESSION-MASTER-RECORD.md)).
- **Roles:**

| Role | What it may do | Who uses it | Where its credential lives |
|---|---|---|---|
| `neondb_owner` | Everything, including DDL and the audit-maintenance override | Vercel `DIRECT_URL` (migrations on every build); GitHub `DIRECT_URL` (backup, role provisioning); operator scripts. Whether the running app also uses it, through `DATABASE_URL`, is recorded in `PRIVATE-HANDOVER.md` (item 14) | Vercel, GitHub, and the `.env` files in the pack |
| `nmwc_app` | Read and write application tables; insert-only on `AuditLog` and `EditApproval`; no DDL | The intended runtime role. Whether production uses it is recorded in `PRIVATE-HANDOVER.md`; switching is an owner-side action ([CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md)) | GitHub `NMWC_APP_PASSWORD` (the password only). The production password also has a copy in the private pack (§3) |

- **Which role the running app uses.** Whether production uses the restricted
  `nmwc_app` role is recorded in `PRIVATE-HANDOVER.md`; switching is an owner-side
  action ([CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md)). Confirm it in Vercel,
  privately, before you change anything.
- **Restores leave the role behind.** `pg_dump` carries no roles, so a restored
  database has no `nmwc_app` until you create it again
  ([OPERATIONS §6.3](../OPERATIONS.md)).
- **UAT and production may share a password.** The repository records that Neon
  branches share the owner role's password
  ([SECRETS-INVENTORY §5](../SECRETS-INVENTORY.md),
  [AUDITOR-BRIEF §14](../../AUDITOR-BRIEF.md)). **Treat any UAT owner credential as a
  production credential.**
- **Point-in-time recovery** covers 7 days and runs from the Neon console
  ([OPERATIONS §6.1, §6.4](../OPERATIONS.md)). Whoever holds the Neon account holds
  this. The window depends on the plan, so check it after any plan or billing change
  (§2.12).
- **Restore drill keys.** The drill needs `NEON_API_KEY` and `NEON_PROJECT_ID`
  ([OPERATIONS §6.12](../OPERATIONS.md)). [HANDOVER §6.2](../HANDOVER.md) still lists
  them as to be set. The drill's scheduled run on 2026-10-01 failed at preflight
  because both secrets are missing; it has never succeeded. (OPERATIONS §6.12 still
  says the drill has never run. That is out of date.) A Neon API key belongs to the
  account that created it, and it can delete branches. Create it from the account or
  organisation that will own the project after the handover. A key made under the
  owner's personal account stops working when that account loses access.
- **Notifications.** Neon sends its account and usage e-mails to the account holder.
  The new person checks their own notification settings once they have access.

**How to hand it over:** Neon → Organization → Members (check what the current plan
allows), or move the project. To confirm access, the new person should be able to see
both branches, the Roles page and the restore window. **Do not reset any password
just to test access.** Resetting `neondb_owner` breaks every existing connection at
once ([CREDENTIAL-ROTATION step 2](../CREDENTIAL-ROTATION.md)).

### 2.5 Cloudflare R2 — photographs and backups

- **What it is:** the owner's Cloudflare account. Its id is in
  [OPERATIONS §2](../OPERATIONS.md).
- **Buckets:**
  - `nmwc-photos` holds shop photos and the CR and guarantee documents.
  - The backups bucket holds the encrypted nightly dumps for 30 days
    ([OPERATIONS §6.1, §6.9](../OPERATIONS.md) name it `nmwc-backups`; GitHub
    `BACKUP_R2_BUCKET` holds the name).
  - They are kept apart on purpose: a leaked photo token cannot reach the backups.
- **Tokens (four pairs):**

| Token | Permission and scope | Stored as | Stored in |
|---|---|---|---|
| App photo token | Object Read & Write, `nmwc-photos` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Vercel |
| Backup token | Object Read & Write, backups bucket only | `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` | GitHub |
| Backups admin token | Admin Read & Write, backups bucket only | `BACKUP_R2_ADMIN_ACCESS_KEY_ID`, `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY` | GitHub. Also needed locally for `npx tsx scripts/ops/r2-backups-lifecycle.ts`, which applies the backup retention rule, and its `--check` mode ([OPERATIONS §6.9](../OPERATIONS.md)) |
| Photos admin token | Admin Read & Write, `nmwc-photos` only | `R2_ADMIN_ACCESS_KEY_ID`, `R2_ADMIN_SECRET_ACCESS_KEY` | GitHub. Also needed locally for `npx tsx scripts/ops/r2-photos-versioning.ts --check` ([OPERATIONS §6.13](../OPERATIONS.md) step 5) and for `npm run ops:r2-setup`. Read the warning in [OPERATIONS §5b C](../OPERATIONS.md) before you run `ops:r2-setup`: it replaces the bucket's lifecycle rules |

  [OPERATIONS §6.9](../OPERATIONS.md) still calls the `R2_ADMIN_*` pair
  "account-wide". [OPERATIONS §6.13](../OPERATIONS.md) scopes it to `nmwc-photos`
  only. With that scope it cannot configure the backups bucket, so use the backups
  admin token for `r2-backups-lifecycle.ts`.
- **The admin tokens may not exist yet.**
  [AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md) records the R2 bucket settings workflow
  as red until the owner mints the two admin tokens
  ([OPERATIONS §6.13](../OPERATIONS.md)). Check the latest run.
- **Photo versioning cannot be turned on.** Cloudflare R2 supports neither object
  versioning nor object tagging (F02 in [HANDOVER §6.1](../HANDOVER.md)). The
  workflow's photos check (`r2-photos-versioning.ts --check`) passes only when
  versioning is enabled, so that half of the workflow stays red even with both tokens,
  until F02 is decided and the check is changed to match. On this point
  [OPERATIONS §6.13](../OPERATIONS.md), which treats versioning as a dashboard setting,
  is stale.
- **The photographs exist in one place only.** They have no backup copy
  ([OPERATIONS §6.2](../OPERATIONS.md); F02 in [HANDOVER §6.1](../HANDOVER.md)).
  Whoever holds this Cloudflare account holds the only copy.

**How to hand it over:** Cloudflare → Manage account → Members
([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md)). Moving the buckets to a different
Cloudflare account is a migration, not a transfer. It means new tokens in Vercel and
GitHub, new account ids, and copying every object. Plan it as a separate project.

### 2.6 Sentry — error reports

- **What it is:** org `nmwc`, project `nmwc-cm` ([OPERATIONS §2](../OPERATIONS.md)).
  It collects errors from the server, edge and browser runtimes. The only setting is
  the DSN, `NEXT_PUBLIC_SENTRY_DSN`, in Vercel. The project has no source-map upload
  and no Sentry auth token ([AUDITOR-BRIEF §3](../../AUDITOR-BRIEF.md)).
- **Leftover names in the local env files.** They still carry `SENTRY_AUTH_TOKEN`,
  `SENTRY_ORG` and `SENTRY_PROJECT` (§3), from a source-map upload that was never wired
  up (`withSentryConfig` is not applied; see `instrumentation-client.ts`). Nothing
  reads them. If `SENTRY_AUTH_TOKEN` holds a value, it is a token on the owner's Sentry
  account: revoke it at the end (§2.13).
- **How to hand it over:** the free plan has one user
  ([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md)). There are two ways:
  1. Upgrade the plan and invite the new person as an owner.
  2. The new person creates a Sentry project under their own account. Replace
     `NEXT_PUBLIC_SENTRY_DSN` in every Vercel environment that uses it, then
     redeploy. The scrubbing lives in code (`lib/sentry-scrub.ts`), so it carries on
     either way.
- **Alert e-mails** go to the Sentry account. Check its alert settings once the new
  person holds it.
- **Priority:** low. Sentry can wait until after the core four
  ([SECRETS-INVENTORY §4](../SECRETS-INVENTORY.md)).

### 2.7 cron-job.org — retire it, do not transfer it

Since the move to Pro, Vercel runs keep-warm and the SLA sweep itself. cron-job.org
still keeps a copy of `CRON_SECRET` inside its two jobs until they are deleted.
Retiring it is an open item ([HANDOVER §6.2](../HANDOVER.md)). Follow
[OPERATIONS §5d](../OPERATIONS.md) exactly:

1. Wait until the Service status page shows "Vercel last ran it" for both jobs,
   across a whole working day.
2. Delete both jobs at cron-job.org. Disabling them is not enough.
3. Delete the API key at cron-job.org. Then delete the `CRONJOB_API_KEY` secret in
   GitHub.
4. Rotate `CRON_SECRET` in Vercel and `PROD_CRON_SECRET` in GitHub, then redeploy.
5. **Never run the External cron scheduler's `apply` mode again.** It would create
   the jobs again.

Steps 2 and 3 need the owner's cron-job.org login. Ideally the owner does this before
stepping away.

### 2.8 Production URL and domain

The app is at `https://nmwc-cm.vercel.app`. Vercel issued this address. There is no
custom domain ([OPERATIONS §1](../OPERATIONS.md)), so there is no domain registrar or
DNS account to hand over.

The URL is written in many places. If it ever changes (for example, a custom domain
is added, or a Vercel move changes the address), all of these must change together.
Run `git grep -l nmwc-cm.vercel.app` for the full list.

| Kind | Where |
|---|---|
| Runtime settings | Vercel `AUTH_URL` and `NEXTAUTH_URL`; GitHub variable `APP_BASE_URL` |
| Workflow defaults and literals | The `APP_BASE_URL` defaults in `cron-scheduler.yml` and `db-backup.yml`; literals in `keep-warm.yml`, `sla-escalate.yml` and `provision-app-role.yml` (its closing instructions) |
| Scripts | `scripts/ops/smoke.ts`, `scripts/dev/build-id.cjs`, `scripts/ops/cron-scheduler.ts`, and `tests/loadtest.mjs`, which **defaults to production**: always set `BASE` to a non-production URL before running it |
| Unit tests that pin it | `tests/unit/ci-gates-guard.test.ts`, `cron-scheduler.test.ts`, `sentry-scrub.test.ts`, `sentry-envelope.test.ts`, `golive-route-names-guard.test.ts`. Change `smoke.ts` or `cron-scheduler.ts` without these and CI goes red |
| Templates | `.env.example` (a comment) |
| User guides | The HTML and PDF files in `docs/guide/` are generated. Rebuild them; do not hand-edit them. `npm run guide:roles` runs `scripts/build-role-guides.ts`, and `npm run guide:pdf` runs `scripts/guide-html-to-pdf.ts`; check which script produces each file. `docs/guide/` is stale: a newer English and Arabic set (PDFs for Salesman, Manager, Approvers, Data Steward and an overview guide, plus an owner checklist), produced on 2026-10-04 from the code, is the set users were given. It is in the private pack (`guides/`, and `golive-data/guides-2026-10-04/` with its content JSON and renderer). Check it as well. Whether it replaces `docs/guide/`, after a leak review, is still open |

Many dated reports and audits also mention the URL. They are records and can stay as
they are.

### 2.9 Alerts and monitoring

- **`ALERT_WEBHOOK_URL`** is the system's only outgoing alert. It is set in Vercel
  only. It is deliberately not a GitHub secret and not in
  `lib/ops/required-secrets.ts` ([OPERATIONS §5f](../OPERATIONS.md)). It is not set
  yet ([HANDOVER §6.2](../HANDOVER.md)). To set it up:
  1. Create an incoming webhook in a channel the new person reads.
  2. Set it in Vercel Production.
  3. Redeploy.
  4. Test it as [OPERATIONS §5f](../OPERATIONS.md) shows.

  The URL itself is a credential: anyone who has it can post into the channel.
- **External uptime monitor.** [OPERATIONS §5d and §5f](../OPERATIONS.md) say one
  should watch `/api/health` with the bearer header. The webhook cannot report a job
  that has stopped running. The repository does not record whether a monitor exists
  or which service runs it. **Ask the owner.** If one exists, it holds
  `HEALTH_BEARER` and is one more account to hand over.
- **Failure e-mails.** Each source sends them somewhere different:

  | Source | Who gets the e-mail today | How the new person takes it over |
  |---|---|---|
  | Scheduled GitHub workflows | The user who last changed each `cron` line or re-enabled the workflow (GitHub's documentation) | §2.1 check 6 |
  | Other GitHub Actions runs | GitHub's per-user notification settings | The new person's own settings |
  | Vercel deployments | The Vercel account's notification settings | §2.3 check 6 |
  | Neon | The Neon account holder | §2.4 |
  | Sentry | The Sentry account | §2.6 |
  | cron-job.org | The owner's cron-job.org account | Retire it (§2.7) |

### 2.10 The backup encryption key (age)

- Each nightly dump is encrypted to every public key in `BACKUP_AGE_RECIPIENTS`.
- A matching **private** key is the only way to read a backup.
- `BACKUP_AGE_IDENTITY` holds **one** private key: the one stored there at setup
  ([OPERATIONS §6.7](../OPERATIONS.md) step 3). The monthly drill decrypts with that
  key and no other (`.github/workflows/restore-drill.yml`, the `age -d -i` step).
- **It cannot be re-issued.** A new key cannot decrypt dumps made for an old one
  ([SECRETS-INVENTORY §3](../SECRETS-INVENTORY.md),
  [OPERATIONS §6.7](../OPERATIONS.md)).
- [OPERATIONS §6.7](../OPERATIONS.md) asks for a second recipient held by a different
  person, and for each private key to be stored in two places that cannot fail
  together.
- **No copy of the private key has been found.** It was not found on the owner's
  computer, and it is not in the pack. GitHub's `BACKUP_AGE_IDENTITY` secret holds one
  copy, but GitHub cannot show it again. Without a copy of the key, nobody else can
  decrypt any dump.
- **This is the owner's first action before handing over.** Either put a copy of the
  private key in the pack, or add the new person's age recipient (steps 1–4 below)
  and prove one decrypt. The second way covers only dumps made after the recipient is
  added. The dumps already stored stay readable only with the owner's key.

**The recommended handover avoids copying the owner's key:**

1. The new person runs `age-keygen` on their own machine. They keep the private half
   off the machine and out of the repository, in two places that cannot fail
   together.
2. Add their **public** key to `BACKUP_AGE_RECIPIENTS`. The list is comma-separated.
3. From the next night on, every dump can be read with the new person's key.
4. **Prove their key works.** A green restore drill does *not* prove this, because
   the drill uses only the key in `BACKUP_AGE_IDENTITY`. Do one of these:
   - Download one dump made after step 2 and decrypt it with
     `age -d -i <their key file>`. Do not keep the plaintext: a decrypted dump holds
     every customer row and every password hash.
   - Or put their private key into `BACKUP_AGE_IDENTITY` and then run the drill. The
     drill cannot run until `NEON_API_KEY` and `NEON_PROJECT_ID` exist (§2.4).
5. Keep the old private key until the last dump made only for it has expired. Dumps
   are kept 30 days.
6. **If the owner's key is later removed from `BACKUP_AGE_RECIPIENTS`,** first make
   sure `BACKUP_AGE_IDENTITY` holds a private key the new person controls. Otherwise
   the drill keeps depending on the owner's key, and it cannot decrypt any dump made
   after the removal.

### 2.11 AI tools: Claude Code and Codex

- **Claude Code** (Anthropic) has been the reviewer and production operator. Since
  2026-10-01 it has also carried out each merge the owner approved (§2.1). It reads
  [CLAUDE.md](../../CLAUDE.md).
- **Codex** (OpenAI) has been a builder on `codex/*` branches. It never merges and
  never pushes `main`. It reads [AGENTS.md](../../AGENTS.md).
  `tests/unit/agents-md-guard.test.ts` keeps the shared rules in the two files
  identical.
- **No AI key is a project secret.** Nothing in the app or the workflows calls an
  Anthropic or OpenAI API. Both subscriptions are the owner's own. The new person
  uses their own accounts.
- **Claude's production-write permission** ([HANDOVER §4](../HANDOVER.md)):
  - The owner gave it to Claude for operator scripts, under the safeguards in
    [HANDOVER §5](../HANDOVER.md).
  - It covers no credential rotation and no other agent. It does not cover merging
    either: Claude merges only after the owner's "merge it" for that change (§2.1).
  - It ends on the date recorded in `PRIVATE-HANDOVER.md`. After that, the new person
    decides whether to keep it, narrow it or end it, and records the decision in
    HANDOVER §4.
- **Claude's memory** is in the pack. Its note about this permission was updated on
  2026-10-04 to the current terms, so restoring the memory on a new machine is fine.
  It goes in `~/.claude/projects/<key>/memory/`, where `<key>` is the absolute path of
  the folder you open Claude Code in, with every character that is not a letter or a
  digit replaced by `-`. So `C:\Users\x\Desktop\NMWC-CRM` becomes
  `C--Users-x-Desktop-NMWC-CRM`. [05 §6.4](05-NEW-COMPUTER-SETUP.md#64-claude-code-memory)
  has the steps.
- **Chat history in the pack.** The pack holds the Claude app's official exports of
  all three NMWC CRM chat sessions (the conversation, the sub-agent transcripts and
  the metadata). It also holds the raw Claude Code project folders for them: the `*.jsonl`
  transcripts, the sub-agent and workflow transcripts, and the tool results.
- **Codex's own history is not in the pack.** It is `~/.codex` on the owner's computer,
  about 4 GB, and it also holds the owner's personal OpenAI sign-in. Codex's private
  notes are in `NMWC-Private-Backups`, which is in the pack.
- **Codex has no production access,** for reads or writes
  ([HANDOVER §2](../HANDOVER.md)). That stays the rule unless the new person changes
  it.
- **Connected apps.** Check the GitHub account's installed apps and authorised
  applications. Vercel's GitHub app is the deploy integration: **keep it**, and
  reconnect it under the new owner first (§2.1 check 1). Any AI tool connected to
  the owner's GitHub account is another connection. Remove the owner's AI connections
  once the new person has set up their own (§2.13).
- **Treat the chat history and Claude's memory files in the pack as secret.**
  They may contain credential material. [CLAUDE.md](../../CLAUDE.md) records part of
  a role password once being printed into a transcript. Do not upload them anywhere.
  Do not paste them into another AI tool without checking them first.

### 2.12 Billing

Each paid service bills the owner's payment method today. Moving a member seat does
not move the bill.

| Provider | What is paid for | What happens if payment stops |
|---|---|---|
| Vercel | The Pro plan, with $20 a month per developer seat as recorded in September 2026 ([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md)) | If the plan drops to Hobby, sub-daily schedules are rejected (comments at the top of `keep-warm.yml` and `sla-escalate.yml`), so Vercel stops running keep-warm and the SLA sweep. Log retention also gets shorter ([OPERATIONS §5g](../OPERATIONS.md)) |
| Neon | The Launch plan ([OPERATIONS §11](../OPERATIONS.md)); check this | The point-in-time recovery window depends on the plan. Check it after any change |
| Cloudflare | R2 storage and operations, if the account is billed | Check Cloudflare → Billing |
| Sentry, GitHub, cron-job.org | Free plans, as recorded in the repository | — |

Decide at handover who pays from now on. Move the billing owner on each provider
before the owner removes their payment method.

### 2.13 Personal logins, 2FA and personal tokens

- **Every login is personal.** The GitHub, Vercel, Neon, Cloudflare, Sentry and
  cron-job.org logins are tied to the owner's e-mail address and the owner's
  two-factor authentication. The new person gets **their own** login on each, by
  invite or transfer. Never share the owner's password.
- **Recovery codes.** Decide who keeps the owner's 2FA recovery codes during the
  transition. Record that decision in the private pack, not here.
  [SECRETS-INVENTORY §4](../SECRETS-INVENTORY.md) option 2 (sealed break-glass
  credentials) describes one way to do it.
- **At the end, the owner revokes their own tokens and connections.** Removing a seat
  does not revoke a personal token on an account that keeps access. The list:
  - The owner's `VERCEL_TOKEN` (personal access token).
  - The owner's `gh` CLI login and any GitHub personal access tokens.
  - Any personal Neon API key. If the drill's `NEON_API_KEY` was made under the
    owner's personal account, replace it first (§2.4).
  - The cron-job.org API key (part of retiring it, §2.7).
  - `SENTRY_AUTH_TOKEN`, if the local env files hold a value for it (§2.6).
  - The Claude and Codex GitHub app authorisations on the owner's account (§2.11).

---

## 3. Local `.env` files

All the real ones are gitignored. Copies are in the private pack.
`PRIVATE-HANDOVER.md` says which file is which.

| File | Where it is today | Database it points at | What uses it | Risk |
|---|---|---|---|---|
| `.env` in the owner's **main checkout** | Owner's computer | **PRODUCTION** (`DATABASE_URL` and `DIRECT_URL`; [HANDOVER §3](../HANDOVER.md), [CREDENTIAL-ROTATION step 3](../CREDENTIAL-ROTATION.md)) | `scripts/dev/prod-run.cjs` (its default file), the Prisma CLI, `scripts/qa/run-with-env.mjs`, any script started in that folder | **The most dangerous file in the project.** Any seed, test or migration started in that folder runs against production. Never work in that checkout ([HANDOVER §3](../HANDOVER.md)). |
| `.env.local` in the same checkout | Owner's computer | **PRODUCTION** as well ([CREDENTIAL-ROTATION step 3](../CREDENTIAL-ROTATION.md)) | `npm run dev`, `npm run ops:print-secrets` | The same risk. |
| `.env` in an agent worktree | Owner's computer | **UAT** (`uat-testing`) | Tests, `scripts/qa/run-with-env.mjs`, integration suites | It carries the owner role's password, which the repository records as shared across Neon branches (§2.4). Protect it like a production credential. |
| `.env.example` | Committed | None | A template listing names | Never put a value in it. |

**Today, on the owner's computer,** the production env file is that main checkout's
`.env`, and Claude's operator runs name it explicitly:
`NMWC_PROD_ENV_FILE=<main checkout>/.env node scripts/dev/prod-run.cjs <script> [args]`.
For the new set-up, keep the production env file outside every checkout and pass it
the same way (step 3 below).

**What the env files hold (names only).** Never print one of these files to find
out (§0).

| File | Names it holds |
|---|---|
| Production: `.env` and `.env.local` in the main checkout | `DATABASE_URL`, `DIRECT_URL`, `LOG_LEVEL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `NODE_ENV`, `R2_ACCESS_KEY_ID`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE`, `R2_SECRET_ACCESS_KEY`, `SEED_ADMIN_PASSWORD`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` |
| UAT: the worktree `.env` | The same names, plus `AUTH_TRUST_HOST`, without `NEXT_PUBLIC_SENTRY_DSN` |

**What no local file holds.** `CRON_SECRET`, `HEALTH_BEARER`,
`MAINTENANCE_BYPASS_TOKEN`, `BACKUP_AGE_IDENTITY`, the `BACKUP_R2_*` and `R2_ADMIN_*`
tokens, `PROD_CRON_SECRET`, `CRONJOB_API_KEY`, and every other value that lives only in
Vercel or GitHub. `NMWC_APP_PASSWORD`, the production `nmwc_app` role's password, is
not on this list: it is in no env file, but a copy is in the private pack, in
`golive-data/prod-app-role.secret`. GitHub never shows a secret again. Vercel shows a
variable's value again unless it was saved as Sensitive, so `CRON_SECRET`,
`HEALTH_BEARER` and `MAINTENANCE_BYPASS_TOKEN` can be read in Vercel only if they were
not. If no copy exists anywhere else, whoever holds those accounts must generate new
values, and that is a rotation (§5).

**Which env file names Git ignores.** `.gitignore` ignores only `.env`, `.env.local`
and `.env.*.local`. A file unpacked into a checkout as `.env.production`, `.env.prod`,
`.env.uat` or `prod.env` is **not** ignored, and `git add .` would commit it. Next.js
also loads `.env.production` during `next build` and `next start`. So never put a
pack file inside a checkout under any other name. Keep production files outside every
checkout (step 3 below).

`.gitignore` also ignores `*.tmp.ts`, the name an operator script from the pack is
given when it is copied into a checkout to run through `prod-run.cjs`. Delete the copy
after use all the same.

**Which files each tool loads:**

| Tool | What it loads |
|---|---|
| Prisma CLI (`prisma migrate`, `prisma db`, `prisma studio`) | `.env` |
| `npm run dev` (Next.js) | `.env.local`, then `.env`. Variables already set in the shell win |
| `scripts/qa/run-with-env.mjs` | `.env` only. Shell variables win. **It does not check the host** |
| `scripts/print-required-secrets.ts` | `.env.local` and `.env`. It prints lengths only, never values |
| `scripts/dev/prod-run.cjs` | The file named in `NMWC_PROD_ENV_FILE`, otherwise `.env`. It refuses anything that is not production and masks the output |
| `scripts/dev/env-check.cjs` | The file you name, otherwise `.env`, plus the shell environment |
| `scripts/ops/smoke.ts` | No file. Set `HEALTH_BEARER` in the shell to add the bearer-only checks |

**Recommended set-up on a new computer:**

1. **Make a fresh `git clone`.** Do not copy the owner's checkout. If you must move
   the whole folder instead, read "Moving the whole folder" below.
2. **Put the UAT `.env` from the pack into the clone,** named exactly `.env`. Then run
   `node scripts/dev/env-check.cjs`. It must end with
   "ok: nothing here points at production."
3. **Keep the production env file outside every checkout,** so that nothing loads it
   by accident. Use it only through
   `NMWC_PROD_ENV_FILE=<path> node scripts/dev/prod-run.cjs <script> [args]`
   ([HANDOVER §5](../HANDOVER.md)).
4. **Do not create a `.env.local` that holds production values.** Do not run
   `npx vercel env pull` until you have checked Vercel's Development scope (§2.3).
5. **Never type `DIRECT_URL=…` on a command line** ([HANDOVER §5](../HANDOVER.md)).

**Moving the whole folder.** If the owner's project folder is copied to another
computer instead of cloned, it carries more than code:

- **Secrets.** The main checkout's production `.env` and `.env.local` come with it.
  So does every worktree under `.claude/worktrees/`: each has its own `.env`. Possibly
  `golive-data/` comes too ([HANDOVER §3](../HANDOVER.md)). Keep the copy on an
  encrypted disk, never in a synced or shared folder.
- **Worktree links break.** Git records each worktree's location as an absolute path.
  After a move, run `git worktree list` in the main checkout, then
  `git worktree repair`.
- **`node_modules` junctions.** A worktree's `node_modules` may be a junction to
  another checkout's `node_modules`. On Windows, `git worktree remove --force` follows
  the junction and empties its target. Remove the junction first
  (`cmd /c rmdir <worktree>\node_modules`), check it is gone, and only then remove the
  worktree. On the new machine, reinstall with `npm ci` rather than copying
  `node_modules`.
- **Never delete a worktree without the owner's go-ahead** while the owner is still
  reachable ([HANDOVER §3, §6.4](../HANDOVER.md)).

**Variables you set by hand for one command.** Most of these exist only on an
operator's machine. `HEALTH_BEARER` is the exception: it is also a Vercel and a
GitHub value. Set each one only for the single command that needs it.

| Name | Read by | What it does |
|---|---|---|
| `NMWC_PROD_ENV_FILE` | `scripts/dev/prod-run.cjs` | The path to the production env file |
| `ALLOW_PRODUCTION` | `scripts/ops/app-role.ts`, `scripts/ops/restore-verify.ts` | Set to `1`, it lets these scripts act on production. The provision workflow sets it on every run |
| `NMWC_APP_PASSWORD`, `NMWC_APP_URL` | `scripts/ops/app-role.ts` | Create the `nmwc_app` role, and check it by connecting as that role |
| `RESTORE_VERIFY_URL` | `scripts/ops/restore-verify.ts` | The database to verify |
| `GOLIVE_DIR` | `scripts/golive/build-masters.ts`, `scripts/ops/verify-load.ts`, `scripts/ops/export-crm-terms.ts`, `scripts/ops/zero-credit-limits.ts` | Where `golive-data/` is |
| `CONFIRM_CREDENTIAL_RESET` | `scripts/bulk-reset-credentials.ts` | Set to `yes`, it lets the script write. Read the warning in §4 first |
| `HEALTH_BEARER` | `scripts/ops/smoke.ts` | Adds the bearer-only smoke checks. The same value is in Vercel and GitHub |
| `R2_ADMIN_*`, `BACKUP_R2_ADMIN_*`, `R2_ACCOUNT_ID`, `BACKUP_R2_ACCOUNT_ID` | The R2 scripts in §2.5 | Bucket checks and lifecycle rules |
| `SEED_ADMIN_PASSWORD` | `prisma/seed.ts`, `prisma/synthetic.ts` | The seeded admin's password. Its default value is a literal in the public repository ([AUDITOR-BRIEF §14](../../AUDITOR-BRIEF.md)) |
| `ALLOW_PROD_SEED` | `prisma/synthetic.ts`, `prisma/seed-muscat-pilot.ts` | An escape hatch past their production refusal. **Never set it** |

---

## 4. Application accounts

These are users of the app, not infrastructure. They still decide who can run the
system day to day.

- **Roles** (`enum Role` in `prisma/schema.prisma`): SALESMAN, SUPERVISOR,
  ACCOUNTANT, FINANCE_MANAGER, GM, MANAGER, STEWARD, VIEWER. By owner decision there
  are no Supervisor accounts ([HANDOVER §4](../HANDOVER.md)).
- **`data.steward` is a head-office administrator account** (a Data Steward). It was
  created once by `scripts/golive/bootstrap-accounts.ts`, because the app has no way
  to create the first Steward. A Steward imports the masters, fixes quarantined rows,
  and may create any role, including another Steward (`services/users.ts`).
- **What Managers can do.** A Manager administers only Salesman and Supervisor
  accounts in their own regions (`MANAGER_ADMINISTRABLE_ROLES` in
  `lib/permissions.ts`). A Manager cannot reset a Steward. A Steward can reset every
  account except their own. Nobody changes their own password from `/users`; they use
  `/profile` ([OPERATIONS §7, §7a](../OPERATIONS.md)).
- **Keep at least two active Data Steward accounts**
  ([SECRETS-INVENTORY §3](../SECRETS-INVENTORY.md)); the current state is in
  `PRIVATE-HANDOVER.md`. If no Steward can sign in, the way back in is an operator
  script run as the database owner:
  - `scripts/golive/bootstrap-accounts.ts` creates a Steward **only when no active
    Steward exists**. It reads its accounts file from `golive-data/` (in the private
    pack) and refuses to run without `--expect-host`. See
    [GO-LIVE-RUNBOOK](../GO-LIVE-RUNBOOK.md) for how it was run.
  - `scripts/bulk-reset-credentials.ts --username=<steward username>` resets one
    active account. Read the warning below before you use it.
- **For the new person (an owner action):** the owner, signed in as a Data Steward,
  creates a **named** Steward account for the new person on the Users page. It is on
  the fill-in list in `PRIVATE-HANDOVER.md`. Never share a Steward account.
  - The username must not match the demo denylist in `lib/demo-accounts.ts`
    (`DEMO_USERNAME_PATTERN` and `DEMO_EXACT`). Anything that starts with `salesman.`
    or `supervisor.` is blocked, and so are the exact names `manager.a`, `manager.b`,
    `steward`, `viewer` and `admin`. Names such as `data.steward` or `manager.ahmed`
    are allowed (`tests/unit/golive-usernames.test.ts`).
  - Those names are refused at sign-in whenever `DEMO_ACCOUNTS_DISABLED` is exactly
    `true` (`lib/auth.ts`), and production sets it to `true` (§2.3).
  - Never relax the list to make an account work. Rename the account instead
    ([CLAUDE.md](../../CLAUDE.md)).
- **Application passwords are not written in any handover document.**
  - The shared initial password and some older pilot and seed passwords do appear as
    literals in this public repository. [AUDITOR-BRIEF §14](../../AUDITOR-BRIEF.md)
    lists the files, and [HANDOVER §4](../HANDOVER.md) records this as an accepted
    risk. Treat every one of them as public.
  - The passwords generated for go-live are in `golive-data/`, inside the private
    pack.
- **Warning: `scripts/bulk-reset-credentials.ts`.**
  - It has no production refusal.
  - It is a dry run unless `CONFIRM_CREDENTIAL_RESET=yes` is set.
  - Without `--username=…` it resets **every active user**.
  - It prints the new passwords to the terminal.
  - Do not run it through an AI agent's terminal. Do not run it at all without a
    single `--username`.

---

## 5. Rotation

**The rotation status is in `PRIVATE-HANDOVER.md`,** with the exposure history. The
repository does not record whether rotation has happened
([AUDITOR-BRIEF §14](../../AUDITOR-BRIEF.md)), and
[CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md) says to confirm the current state
privately before starting.

Removing the owner from an account does not invalidate secret values already copied
out of it. Only rotation does that. Generating a new value for a secret that has no
readable copy (§2.3, §3) is a rotation too, so it follows the same order.

For any rotation by the new person, **the order matters, and rotation comes last:**

1. **Get access first.** Rotate only once you hold every account in §1 and can write
   to every place in the "Must match" column of
   [SECRETS-INVENTORY §2](../SECRETS-INVENTORY.md). A value changed in one place but
   not in its pair breaks a job.
2. **Pick a quiet time.** Avoid data loads and busy field days. CREDENTIAL-ROTATION
   says to plan rotation outside any active data load.
3. **Retire cron-job.org first** (§2.7). Its last step rotates `CRON_SECRET`, so you
   avoid rotating that secret twice.
4. **Database:** follow [CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md) in its
   order.
   - Step 1 moves the app onto `nmwc_app` if it is not there already
     (`PRIVATE-HANDOVER.md` records which role production uses). Step 2 resets
     `neondb_owner`. If you skip step 1, the site is down from the reset until the
     next redeploy.
   - Afterwards, update every local `.env`, the UAT one included. The repository
     records that Neon branches share the role's password
     ([SECRETS-INVENTORY §5](../SECRETS-INVENTORY.md)).
5. **Then the rest, one at a time.** After each one, run `npm run smoke` and the check
   its row names in [SECRETS-INVENTORY §2](../SECRETS-INVENTORY.md):
   - `HEALTH_BEARER`: set the same value in Vercel Production and in GitHub, and in
     the external uptime monitor if one exists (§2.9). Redeploy. Then run
     `npm run smoke` with `HEALTH_BEARER` set in your shell, where no screen share or
     transcript can see it. CI's post-deploy smoke checks it only on the next push to
     `main`.
   - R2 tokens: create the new token and set it. Redeploy for the app token. For the
     GitHub tokens, run DB Backup and R2 bucket settings. Then revoke the old token.
   - `NEON_API_KEY`, `MAINTENANCE_BYPASS_TOKEN`, `ALERT_WEBHOOK_URL`.
   - **`AUTH_SECRET` / `NEXTAUTH_SECRET` last of all.** Rotating it signs every user
     out at once.
6. **Do not rotate the age key.** Add a new recipient and keep the old private key
   until its dumps expire (§2.10).
7. **Application passwords are separate.** None of the steps above changes them
   ([CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md),
   "What this does not rotate").

---

## 6. Handover sequence

1. **Owner, first, before handing anything over:** the backup decryption key (§2.10).
   Put a copy of the age private key in the pack, or add the new person's age
   recipient and prove one decrypt. Until one of these is done, nobody else can read
   any backup.
2. **Owner:** give the new person the encrypted pack and, separately, its password.
3. **Owner:** give the new person access to GitHub (§2.1), Vercel (§2.3), Neon (§2.4)
   and Cloudflare (§2.5), then Sentry (§2.6). Each by invite or transfer, to the new
   person's own login (§2.13). For each account, record in `PRIVATE-HANDOVER.md` the
   method chosen (transfer, organisation, member invite, or sealed break-glass
   credentials), the target date, who pays (§2.12), and who holds the 2FA recovery
   codes meanwhile (§2.13).
4. **Owner, ideally before stepping away:** retire cron-job.org (§2.7). If that is not
   done, write it down as open.
5. **Owner:** signed in as a Data Steward, create a named Steward account for the new
   person (§4).
6. **New person:** confirm access without changing anything.
   - Run `gh secret list` and `gh variable list`, and compare them with §2.2. Keep the
     variable output private (§2.1 check 2).
   - Run `npx vercel env ls` and compare it with §2.3.
   - Check the Neon branches and roles (§2.4) and the Cloudflare buckets (§2.5).
7. **New person:** set up the computer as in §3. Run
   `node scripts/dev/env-check.cjs`, then `npm run smoke`.
8. **New person:** take over the failure e-mails: the scheduled workflows (§2.1
   check 6), Vercel, Neon and Sentry (§2.9).
9. **Owner and new person together, decide:**
   - Who holds which account from now on. [SECRETS-INVENTORY §4](../SECRETS-INVENTORY.md)
     lists the options.
   - Who approves merges after the handover, and who carries them out (§2.1). This is
     on the fill-in list in `PRIVATE-HANDOVER.md`.
   - Who pays for each provider, and when billing moves (§2.12).
   - Who keeps the owner's recovery codes during the transition (§2.13).
   - Where alerts go (§2.9).
   - Who holds an age key (§2.10).
   - Who triages Dependabot pull requests (§2.1).
   - Whether to add a branch rule on `main` (§2.1).
10. **New person, once the date recorded in `PRIVATE-HANDOVER.md` has passed:** decide
    whether Claude's production-write permission is kept, narrowed or ended (§2.11).
11. **New person:** close the open items in §7 as each becomes possible.
12. **Rotation, last** (§5).
13. **Optionally, after rotation:** the owner revokes their own tokens and app
    connections (§2.13). Then remove the owner's access from each account.

---

## 7. Not done, as of `9d0fd61`

These come from the repository's own records. Check each one before acting on it.

| Item | Where it is recorded |
|---|---|
| A second holder of the production credentials (item 13). This handover answers it only once the accounts have actually moved | [SECRETS-INVENTORY §4](../SECRETS-INVENTORY.md) |
| The database role the running app uses (item 14). Whether production uses the restricted `nmwc_app` role is recorded in `PRIVATE-HANDOVER.md`; switching is an owner-side action | `PRIVATE-HANDOVER.md`; [CREDENTIAL-ROTATION step 1](../CREDENTIAL-ROTATION.md) |
| Credential rotation. The status is in `PRIVATE-HANDOVER.md` | [HANDOVER §6.2](../HANDOVER.md); [CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md) |
| The backup decryption key. No copy was found on the owner's computer and none is in the pack. The owner's first action before handing over | §2.10 |
| `NEON_API_KEY` and `NEON_PROJECT_ID` for the restore drill. The scheduled run on 2026-10-01 failed at preflight because they are missing; the drill has never succeeded. Until they exist, it cannot prove any backup can be restored | [HANDOVER §6.2](../HANDOVER.md); [OPERATIONS §6.12](../OPERATIONS.md) (which still says it has never run) |
| `ALERT_WEBHOOK_URL` is not set | [HANDOVER §6.2](../HANDOVER.md) |
| cron-job.org is not retired | [HANDOVER §6.2](../HANDOVER.md); [OPERATIONS §5d](../OPERATIONS.md) |
| The R2 admin tokens. The R2 bucket settings workflow stays red without them. Its photos check stays red even with them, because R2 supports no versioning, until F02 is decided and the check is changed (§2.5) | [AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md); [HANDOVER §6.1](../HANDOVER.md) F02; [OPERATIONS §6.13](../OPERATIONS.md) (stale on versioning) |
| Vercel Observability Plus (30-day logs) is not confirmed on | [HANDOVER §6.2](../HANDOVER.md) |
| Branch protection on `main` was recorded as unavailable on 2026-09-14, before the repository went public. Not re-checked | [AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md) |
| Scheduled-workflow failure e-mails still go to the owner until the new person takes them over | §2.1 check 6 |
| Billing is on the owner's payment method | §2.12 |
| Whether an external uptime monitor exists | Not recorded. Ask the owner |
| A named Steward account for the new person. An owner action. Keep at least two Data Steward accounts; the current state is in `PRIVATE-HANDOVER.md` | §4; the fill-in list in `PRIVATE-HANDOVER.md` |
| Who approves merges after the handover. For the owner and the new person to agree | §2.1; the fill-in list in `PRIVATE-HANDOVER.md` |
| Whether the 2026-10-04 English and Arabic guide set replaces the stale `docs/guide/`, after a leak review | §2.8 |
| The Vercel Development scope may point at production | [SESSION-MASTER-RECORD §4](../SESSION-MASTER-RECORD.md). Check it in Vercel |
| Known password literals in the public repository and its history (an accepted risk). Changing that decision means rotating application passwords and deciding about history | [HANDOVER §4](../HANDOVER.md); [AUDITOR-BRIEF §14](../../AUDITOR-BRIEF.md) |
