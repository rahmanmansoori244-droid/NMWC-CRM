# 03 — Operations and deployment

How to run NMWC CRM day to day. It covers how a change reaches production, how to undo
one, how to touch the production database safely, and what to watch.

This page is a **map**. The detailed procedures are in these files:

- [`docs/OPERATIONS.md`](../OPERATIONS.md): the runbook.
- [`docs/HANDOVER.md`](../HANDOVER.md): how changes are made and merged.
- [`CLAUDE.md`](../../CLAUDE.md) and [`AGENTS.md`](../../AGENTS.md): the standing rules.

This page links to those files rather than repeating them. It fills the gaps between them,
and it says where they are out of date ([§2.5](#25-read-first-and-what-is-stale)).

> **This file is public.** It holds no secret, no customer data and no production
> figures. The env files, account logins and private records mentioned here are in the
> private handover pack (PRIVATE-HANDOVER.md), which is handed over offline. Two kinds of
> secret are not: the backup decryption key ([§8](#8-backups-and-restores)) and the values
> that exist only in Vercel and GitHub ([§2.3](#23-two-env-files-kept-apart)).
> Never copy anything from that pack into this repository, an issue, a PR or a chat.

## Contents

1. [What runs where](#1-what-runs-where)
2. [Before you operate anything](#2-before-you-operate-anything)
3. [Rules that are never bent](#3-rules-that-are-never-bent)
4. [Deploying: moving `main`](#4-deploying-moving-main)
5. [Why the migration runs before the build](#5-why-the-migration-runs-before-the-build)
6. [Rolling back](#6-rolling-back)
7. [Running operator scripts against production](#7-running-operator-scripts-against-production)
8. [Backups and restores](#8-backups-and-restores)
9. [Scheduled jobs](#9-scheduled-jobs)
10. [Health and monitoring](#10-health-and-monitoring)
11. [A routine for the operator](#11-a-routine-for-the-operator)
12. [Day-1 support](#12-day-1-support)
13. [When something breaks](#13-when-something-breaks)
14. [Windows quirks](#14-windows-quirks)
15. [Operational items that are not done](#15-operational-items-that-are-not-done)

---

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Application | Vercel project `nmwc-cm` on the Pro plan, with functions in `iad1` ([`vercel.json`](../../vercel.json)). The production URL is `https://nmwc-cm.vercel.app`. | Vercel runs Node 24 ([OPERATIONS §11](../OPERATIONS.md#11-stack-snapshot-current)). The function limit is 60 s. |
| Database | Neon Postgres. The production endpoint is `ep-sweet-haze`; the UAT endpoint is `ep-lucky-bar` ([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md#1-the-accounts)). | `DIRECT_URL` is the owner connection, used by migrations and operator scripts. `DATABASE_URL` is the pooled connection the app uses. It is *designed* to be the least-privilege role `nmwc_app` (`CLAUDE.md`, "The code"). Whether production uses it is recorded in `PRIVATE-HANDOVER.md`; it is a Vercel setting the repository cannot show. |
| Photos | Cloudflare R2 bucket `nmwc-photos` | There is only one copy ([OPERATIONS §6.1](../OPERATIONS.md#61-what-exists)) and no working cleanup or recovery design yet (owner decision F02, [§15](#15-operational-items-that-are-not-done)). |
| Database backups | Cloudflare R2 bucket `nmwc-backups`, objects `db/<timestamp>.sql.gz.age` | Encrypted with age. See [§8](#8-backups-and-restores). |
| Errors and traces | Sentry (`NEXT_PUBLIC_SENTRY_DSN`) | See [§10](#10-health-and-monitoring). |
| CI, backups, drills, checks | GitHub Actions in this repository ([`.github/workflows/`](../../.github/workflows)) | See [§4.4](#44-what-ci-does-and-what-green-means) and [§9](#9-scheduled-jobs). |
| Schedules | Vercel cron, GitHub Actions schedules, and cron-job.org (being retired) | See [§9](#9-scheduled-jobs). |

Console links for each provider are in [OPERATIONS §2](../OPERATIONS.md#2-where-data-lives).
[SECRETS-INVENTORY §2](../SECRETS-INVENTORY.md#2-runtime-variables-vercel--production--environment-variables)
lists every runtime variable and marks which ones are secrets. The logins, and the values
held in local env files, are in the private handover pack. The values held only in Vercel
and GitHub are not ([§2.3](#23-two-env-files-kept-apart)).

---

## 2. Before you operate anything

### 2.1 Tools on your machine

| Tool | Used for | Notes |
|---|---|---|
| Git, and on Windows **Git Bash** | Everything, including the `.sh` helpers in `scripts/dev/` | Run `bash scripts/dev/*.sh` from Git Bash, not PowerShell. |
| Node.js and npm (`npm ci` after cloning) | Smoke, operator scripts, tests | CI uses Node 22 ([`ci.yml`](../../.github/workflows/ci.yml)). Vercel runs Node 24. `npm ci` also runs `prisma generate` (the `postinstall` script). |
| GitHub CLI `gh`, signed in with access to this repository | `ci-watch-sha.sh`, `deploy-watch.sh`, the compare API, `gh secret list` | Check with `gh auth status`. |
| `curl` and `jq` | The health-probe examples in OPERATIONS | |
| `age`, the PostgreSQL 17 client (`psql`), `shred` | Restores only ([`scripts/ops/restore-load.sh`](../../scripts/ops/restore-load.sh), [OPERATIONS §6.5](../OPERATIONS.md#65-runbook-b--restore-the-nightly-dump-into-a-new-neon-branch)) | Not needed day to day. |

### 2.2 Accounts and access

The root accounts are listed in
[SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md#1-the-accounts):

- GitHub
- Vercel
- Neon
- Cloudflare
- Sentry
- **cron-job.org**: needed until it is retired, because only its login can delete its jobs
  and its API key ([§9](#9-scheduled-jobs)).
- the alert channel, once `ALERT_WEBHOOK_URL` is set.

The smallest set that keeps production alive is:

- GitHub, to merge a fix
- Vercel, to roll back or change a variable
- Neon, to restore
- the backup age private key, to read a backup

([SECRETS-INVENTORY §4](../SECRETS-INVENTORY.md#4-what-a-second-holder-needs-and-the-decision-that-is-open)).
The private handover pack says where each login is. The backup key is the exception: at
handover no copy of it was found outside GitHub, and it is not in the pack
([§8](#8-backups-and-restores)).

**Repository ownership.** The repository is a personal one. A collaborator can push, but
cannot manage its settings or its Actions secrets
([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md#1-the-accounts)). To operate this project
you need admin rights. If the repository is transferred, or moved into a GitHub
organisation:

- Update `repos/rahmanmansoori244-droid/NMWC-CRM` everywhere it appears. That is the
  `gh api` commands in this page, in [`AGENTS.md`](../../AGENTS.md), in
  [HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) and in
  [AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md#10-deployment-and-operations). It is also the
  `REPO` constant in [`scripts/print-required-secrets.ts`](../../scripts/print-required-secrets.ts)
  and the links in OPERATIONS §2 and §5b. `git grep rahmanmansoori244-droid` finds them all.
- Re-make the Vercel ↔ GitHub connection
  ([OPERATIONS §5b A](../OPERATIONS.md#5b-first-time-post-deploy-operator-checklist)).
  Then confirm that a push to `main` still starts a Vercel build. If nothing builds, nothing
  deploys.
- Check that every Actions secret and variable is still there. Use `gh secret list` and
  `gh variable list`, and compare them with the names `npm run ops:print-secrets` prints
  ([§8](#8-backups-and-restores)). It is not recorded whether they survive a transfer.
- GitHub branch protection was not available on the current plan
  ([AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md#10-deployment-and-operations)). If the new
  home offers it, consider requiring CI on `main`. Check the plan first.

For Vercel, Neon, Cloudflare and Sentry, add yourself as a member where the plan allows
([SECRETS-INVENTORY §1](../SECRETS-INVENTORY.md#1-the-accounts)). The Vercel developer seat
belongs with that step.

**In the app**, keep at least two active Data Steward accounts. With only one, nobody can
import, correct quarantined rows or reset passwords while that person is away. Operator
scripts also need an active Steward for `--actor`
([SECRETS-INVENTORY §3](../SECRETS-INVENTORY.md#3-everything-else-that-is-a-credential)).
Keep at least two active Steward accounts; the current state is in `PRIVATE-HANDOVER.md`. A named Steward account for
the person taking over is recommended. Creating it is an owner action on the
fill-in list in PRIVATE-HANDOVER.md, which also records who holds the existing account.
Choose a username that is not on the demo denylist
([`lib/demo-accounts.ts`](../../lib/demo-accounts.ts)).

### 2.3 Two env files, kept apart

- **A UAT `.env`** in the checkout you work in. Tests, `scripts/qa/run-with-env.mjs` and
  Prisma read it.
- **A production env file** holding the production `DIRECT_URL`. Use it only through
  `scripts/dev/prod-run.cjs` ([§7](#7-running-operator-scripts-against-production)), and
  always name it explicitly with `NMWC_PROD_ENV_FILE`.

**Where the production file is today, and where it should be.** On the previous owner's
computer, the main checkout's `.env` *is* the production env file, and Claude's operator
runs pass it explicitly (`NMWC_PROD_ENV_FILE=<main checkout>/.env node
scripts/dev/prod-run.cjs …`). That works, but it leaves a checkout in which anything that
loads `.env` by default reaches production ([§2.4](#24-if-you-received-a-copied-folder)).
For the new setup, **keep the production env file outside every checkout** and pass it
explicitly. Then nothing that loads `.env` by default can reach production by accident.

**What no local env file holds.** `CRON_SECRET`, `HEALTH_BEARER`,
`MAINTENANCE_BYPASS_TOKEN`, the `BACKUP_AGE_*` values and the other values that exist only
as Vercel variables or GitHub secrets are in no local env file. Vercel's sensitive
variables and GitHub's secrets cannot be read back. So if no copy exists elsewhere, the only
way to get a usable value is to generate a new one and set it everywhere it must match:
that is a rotation, done by whoever holds those accounts
([CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md),
[SECRETS-INVENTORY §5](../SECRETS-INVENTORY.md#5-rotation-dependencies)). The names each
local env file holds are listed in PRIVATE-HANDOVER.md.

Before anything that loads `.env`, run this:

```bash
node scripts/dev/env-check.cjs            # optional argument: a path to an env file
```

It never prints a value. For `DATABASE_URL` and `DIRECT_URL`, in the file and in the
environment, it prints only `PRODUCTION`, `not production` or `not set`. It exits 1 if
either one points at production
([`scripts/dev/env-check.cjs`](../../scripts/dev/env-check.cjs)). Never check an env file
with `cat`, `grep` or `Select-String`: they print the whole line, password included.

### 2.4 If you received a copied folder

A fresh `git clone` of this public repository holds no secrets, no `golive-data/` and no
worktrees. That is the safest place to start: add a UAT `.env` from the private pack.

If you received a copy of the previous owner's folder instead:

1. **Before anything else, run `node scripts/dev/env-check.cjs` in every checkout.** That
   means the main folder and each worktree under `.claude/worktrees/`. The previous owner's
   main checkout has a `.env` that points at **production**
   ([HANDOVER §3](../HANDOVER.md#3-where-things-live),
   [SECRETS-INVENTORY §3](../SECRETS-INVENTORY.md#3-everything-else-that-is-a-credential)).
   In a checkout that prints `STOP`, run no test, no Prisma command and no `npm run`
   script. `prod-run.cjs` also falls back to `.env` in the current directory.
2. **Some things exist only in that copy and in the private pack.** Both `.claude/` and
   `/golive-data/` are gitignored ([`.gitignore`](../../.gitignore)), so neither the worktrees
   nor `golive-data/` are on GitHub. Never delete a worktree without checking whether it
   holds `golive-data/` ([HANDOVER §3](../HANDOVER.md#3-where-things-live)).
3. **Moved worktrees:** git stores absolute paths. From the main checkout, run
   `git worktree repair`, then `git worktree list`.
4. **Windows: a worktree's `node_modules` may be a junction** to another checkout's
   `node_modules`. `git worktree remove --force` follows the junction and empties the
   *target*. Remove the junction first with `cmd /c rmdir <worktree>\node_modules`, check
   that it is gone, and only then remove the worktree.
5. Run `git fetch`, then check which commit each checkout is on. The main checkout can sit
   on an old commit ([HANDOVER §6.4](../HANDOVER.md#64-housekeeping)). Run `npm ci` in any
   checkout that moved to a different machine.

### 2.5 Read first, and what is stale

Read these in order:

1. [`CLAUDE.md`](../../CLAUDE.md): the standing rules, each with the incident behind it.
2. The [`AGENTS.md`](../../AGENTS.md) preface and [HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here): how a change is built, reviewed and merged.
3. [HANDOVER §5](../HANDOVER.md#5-production-how-to-read-and-write-safely): reading and writing production.
4. [OPERATIONS §4–§6](../OPERATIONS.md#4-deploy), [§7a](../OPERATIONS.md#7a-day-1-support--symptom--action) and [§8](../OPERATIONS.md#8-incident-playbook).

**Parts of OPERATIONS.md are stale**
([AUDITOR-BRIEF §15](../../AUDITOR-BRIEF.md#15-docs-versus-code--known-contradictions)).
This page links into it, so know these before you trust it:

| OPERATIONS says | The truth |
|---|---|
| §5c: the running app uses `nmwc_app` | Not confirmable from the repository; the current state is in `PRIVATE-HANDOVER.md`. |
| §6.4 step 1, and one bullet in §6.8: there is no maintenance mode | There is one (the other §6.8 bullet; [`lib/maintenance.ts`](../../lib/maintenance.ts); [§6](#6-rolling-back)). |
| §5d's opening lists three heartbeat jobs | There are five ([`lib/heartbeat.ts`](../../lib/heartbeat.ts); [§9](#9-scheduled-jobs)). |
| §6.13 and "R2 backup & versioning": tag objects for expiry, turn on versioning. §6.13 also says the tag-scoped `gc-marked-7d` rule is already on the production bucket | Cloudflare R2 supports neither object versioning nor object tagging ([HANDOVER §6.1](../HANDOVER.md#61-waiting-on-the-owners-decision), F02). §6.13 is stale on this point. A tag-scoped rule has nothing to act on, because `photo-gc`'s tag call is refused ([§9](#9-scheduled-jobs)). The design is open as F02. |
| §6.12: the restore drill "has never run", and `gh run list` returns nothing | Its scheduled run on 2026-10-01 **failed at preflight**, because the `NEON_API_KEY` and `NEON_PROJECT_ID` repository secrets are missing. It has never succeeded ([§8](#8-backups-and-restores)). |
| §5: `npm run db:migrate` to "apply to Neon" | It runs `prisma migrate dev`. It is banned against any shared database ([§3](#3-rules-that-are-never-bent) rule 3). |

Other documents and code comments are stale too:

- The [GO-LIVE-RUNBOOK](../GO-LIVE-RUNBOOK.md) header is stale.
- The `secrets-scan` comment in `ci.yml` claims a full-history scan, which is wrong
  ([§4.4](#44-what-ci-does-and-what-green-means)).
- The `AGENTS.md` preface and [HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here)
  record only one way of merging, and say that no coding agent pushes `main`. The practice
  since 2026-10-01 differs ([§4.1](#41-how-main-moves)).
- The header comment in [`lib/escalation.ts`](../../lib/escalation.ts) says a Supervisor-step
  breach that no regional Manager covers goes to "all active MANAGERs". The cron route
  sends it to the GM instead ([§9](#9-scheduled-jobs)).

---

## 3. Rules that are never bent

Each rule comes from [`CLAUDE.md`](../../CLAUDE.md), [`AGENTS.md`](../../AGENTS.md) or
[`docs/HANDOVER.md`](../HANDOVER.md).

1. **Merging to `main` deploys to production.** Vercel builds every push to `main`.
   Nothing in the repository makes Vercel wait for CI, and GitHub branch protection is not
   available on the current plan
   ([AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md#10-deployment-and-operations)). So the CI gate
   is a procedure you follow. GitHub does not enforce it.
2. **`main` moves only to a commit whose CI is green, and only after the owner's explicit
   yes in words** ([§4.1](#41-how-main-moves)). Check that exact commit, by exit code.
   Never chain a push or a merge after a status check with `&&` or `;`.
3. **Never deploy or migrate from a laptop:**
   - No `npx vercel --prod` ([OPERATIONS §4](../OPERATIONS.md#4-deploy)).
   - No local `npm run build`. It runs `prisma migrate deploy` against whatever `.env`
     names.
   - **No `npm run db:*`, `npx prisma migrate …` or `npx prisma db …`**
     ([AGENTS.md](../../AGENTS.md) "Before you start" 5,
     [HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) step 2).
     `npm run db:migrate` is `prisma migrate dev`, which can reset the database it points
     at.
   - The only place these commands appear is your own throw-away, empty Postgres
     ([AUDITOR-BRIEF §16](../../AUDITOR-BRIEF.md#16-how-to-verify-locally)). Never UAT,
     never production.
4. **`npm run smoke` before and after every production change.**
5. **Never print a secret.** Not in a terminal you share, a log, a screenshot, a PR or a
   chat.
6. **`golive-data/` is customer data and generated passwords.** It is gitignored. Never
   open it into a transcript and never commit it. Before every commit,
   `git status --short | grep -c golive-data` must print `0`.
7. **Write to production only as [§7](#7-running-operator-scripts-against-production)
   describes.**
8. **Before committing a public document, run the leak check.** Its default targets are
   `AUDITOR-BRIEF.md`, `AGENTS.md`, `docs/HANDOVER.md` and `docs/design/**`. Any other
   file must be named on the command line, so run both of these:
   `node scripts/dev/leak-check.cjs`, then
   `node scripts/dev/leak-check.cjs docs/handover/*.md` (Git Bash expands the glob)
   ([`scripts/dev/leak-check.cjs`](../../scripts/dev/leak-check.cjs)). It looks only for
   known password literals, so read the diff yourself as well.
9. **Run an adversarial review after every substantial merge**, including over your own
   work.

---

## 4. Deploying: moving `main`

### 4.1 How `main` moves

**The owner approves every merge in words** ("merge it"). Nothing moves `main` without
that yes. Two ways of carrying out an approved merge are recorded:

- **A fast-forward push of the exact CI-green commit.** Since 2026-10-01, Claude has
  executed the owner's approved merges this way, with the gates in [§4.2](#42-the-gates-in-order):
  `ci-watch-sha.sh` on the exact SHA, `build-id.cjs` and `npm run smoke` for the baseline,
  `git push origin <sha>:refs/heads/main`, then `deploy-watch.sh`. `main` receives exactly
  the commit whose CI was watched.
- **GitHub's Rebase and merge, pressed by the owner.** This is the route the owner working
  agreement of 2026-09-30 recorded
  ([HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) steps 6–8;
  [`AGENTS.md`](../../AGENTS.md) preface and "When you finish a task"). It always creates
  new commits, so the commit that lands on `main` is not the one whose CI was watched on
  the branch.

[§4.6](#46-the-two-routes-compared) compares them. **Codex never merges and never pushes
`main`.**

HANDOVER §2 and the `AGENTS.md` preface still describe only Rebase and merge, and say that
neither Codex nor Claude merges or pushes `main`. The practice since 2026-10-01 differs, as
above; [06 §4](./06-WORKING-WITH-AI-AGENTS.md#4-the-loop-from-task-to-production) has the
history. **Who approves merges after the handover, and which route is used, is for the
owner and the person taking over to agree.** It is on the fill-in list in
PRIVATE-HANDOVER.md. Then record the result in the `AGENTS.md` preface, HANDOVER §2 and
[AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md#10-deployment-and-operations) in one change
(Tier B, because it changes the rulebook).

**Classify every PR** as Tier A or Tier B
([HANDOVER §2, "Classify every PR"](../HANDOVER.md#classify-every-pr)). Tier B covers:

- schema and migrations
- auth
- approvals
- imports
- privacy
- CI and dependencies
- scripts that write to a database
- guard tests

The recorded rule is that Claude reviews Tier B, and that nothing with a migration merges
without that review. After handover, decide who does that review: Claude in a session you
run, or a named person. Write the decision into HANDOVER §2. Until then, keep the rule:
no Tier B PR, and nothing with a migration, merges without an independent adversarial
review.

### 4.2 The gates, in order

Run these from the repository root, in **one** Git Bash session, because `$OLD` must
survive from gate 5 to gate 9. After each step, read its output **and** its exit code,
then go on to the next step. Never join steps with `&&` or `;`. `<sha>` is the full
commit SHA of the PR head.

| # | Gate | Command | Pass when |
|---|---|---|---|
| 0 | Fresh refs | `git fetch origin` | — |
| 1 | **The head has not moved since review** | `gh pr view <number> --json headRefOid --jq .headRefOid` | It equals the SHA that was reviewed. If not, the review does not cover what you would ship. Stop. |
| 2a | **`origin/main` is an ancestor of the head** | `git merge-base --is-ancestor origin/main <sha>`, then `echo $?` | Prints `0`. |
| 2b | **GitHub agrees it is not behind** | `gh api repos/rahmanmansoori244-droid/NMWC-CRM/compare/main...<sha> --jq .behind_by` | The call succeeds and prints `0`. The repository has `allow_update_branch=false`, so a missing **Update branch** button proves nothing. |
| — | Know what ships | `git log --oneline origin/main..<sha>`, then `git diff --name-only origin/main <sha> -- prisma/migrations` | If the second command prints anything, a migration ships: read [§5](#5-why-the-migration-runs-before-the-build) first. |
| 3 | **CI green on the exact SHA** | `bash scripts/dev/ci-watch-sha.sh <sha> <branch>` | Exit `0`, and the jobs read as [§4.4](#44-what-ci-does-and-what-green-means) says. On a branch, that is every job `success` except one: `Smoke production once it is serving this commit: skipped`. |
| 4 | **Review** | — | For Tier B, the reviewer has said this exact SHA is ready ([§4.1](#41-how-main-moves)). |
| 5 | **Production baseline** | `OLD=$(node scripts/dev/build-id.cjs)`, then `echo "$OLD"`, then `npm run smoke` | A build ID is printed, and smoke prints `all 14 checks passed` (16 with `HEALTH_BEARER` set). If no ID is printed, the fetch failed: retry, and never guess. If smoke already fails, read the paragraph below this table. |
| 6 | **The explicit yes** | — | The owner has said "merge it" in words for this change, and the head is the one that was reviewed. After the handover, the approver is whoever the owner and the person taking over agreed ([§4.1](#41-how-main-moves)). If the head moved after the yes, start again. |
| 7 | **Move `main`** | **Fast-forward push:** `git push origin <sha>:refs/heads/main`. **Or** GitHub → the PR → **Rebase and merge** | The push succeeds. Never add `--force`. A rejected push means `main` moved: go back to gate 0. |
| 8 | **Find the new `main` SHA** | After a push: it is `<sha>`. After Rebase and merge: `git fetch origin`, then `git rev-parse origin/main` | Rebase and merge always creates new commits, so that SHA differs from `<sha>`. |
| 9 | **Watch the deploy** | `bash scripts/dev/deploy-watch.sh <new main sha> "$OLD"` | Exit `0`. A missing or skipped `post-deploy-smoke` job is not a pass. |

**If gate 2 fails:** fetch, then rebase the review branch onto `origin/main`. Push the
**branch** with `git push --force-with-lease`. That is the only force-push allowed, and it
never goes to `main`
([HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) step 6). Wait
for fresh CI on the new head, and start again at gate 1. The rebased head is a new SHA, so
whoever reviewed the old head must also review what the rebase changed.

**If smoke already fails at gate 5:** normally, stop. Do not deploy on top of a broken
production. Two cases are exceptions. Decide each one deliberately and record why:

- **The only failure is smoke's cron dead-man check, in a known alarm state** (`never`,
  `stale` or `failed`), for a reason that has nothing to do with this change. CI's own
  `post-deploy-smoke` excuses exactly this case and nothing else. The comment above that job
  in [`ci.yml`](../../.github/workflows/ci.yml) explains why.
- **This change is the fix for what fails, and a rollback cannot cure it.** For example, a
  migration broke production ([§6](#6-rolling-back), third row of the table). Fixing forward
  then goes through every gate above.

**What the helpers do** (the scripts are short; read them):

- [`ci-watch-sha.sh`](../../scripts/dev/ci-watch-sha.sh) resolves the commit to its full SHA.
  It finds the `CI` run whose `headSha` matches, polling for up to about 10 minutes. Then it
  watches the run, prints the run's conclusion and each job, and **exits with CI's result**.
  Exit 2 means an unknown commit. Exit 3 means no CI run was found. The script exists
  because `gh run list --limit 1` races a fresh push.
- [`build-id.cjs`](../../scripts/dev/build-id.cjs) prints the Next build ID that production
  serves on `/login`. On any failure it prints nothing and exits 1, so a network error never
  reads as a new build.
- [`deploy-watch.sh`](../../scripts/dev/deploy-watch.sh) waits up to 15 minutes for the build
  ID to change, then runs `npm run smoke`. Next it finds and watches `main`'s CI run for the
  SHA, including `post-deploy-smoke`, and prints the smoke lines from that job's log. It
  exits 0 only when the build changed, smoke passed and `main`'s CI succeeded.

**After a green deploy:**

- Run the adversarial review ([§3](#3-rules-that-are-never-bent) rule 9).
- If [`AUDITOR-BRIEF.md`](../../AUDITOR-BRIEF.md) states something the change altered, update
  it in the same kind of change
  ([HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) step 3).
- Record what shipped in your private operations record.

### 4.3 If `deploy-watch.sh` does not exit 0

| It printed | What it means | Do |
|---|---|---|
| `build ID did NOT change within 15 min` | Vercel did not deploy, or the build failed. | Open Vercel → Deployments → this commit's build log. If the build failed inside `next build`, the migrations have already run ([§5](#5-why-the-migration-runs-before-the-build)). |
| `smoke FAILED` | The live build is broken. | [§6](#6-rolling-back). |
| `no CI run on main for <sha>` | GitHub did not start CI for the push, or started it late. | Check the Actions tab, then re-run `bash scripts/dev/ci-watch-sha.sh <sha> main`. |
| A red job in `main`'s run | Read which job it is. | If `Smoke production once it is serving this commit` is red, production is not serving this commit or a deploy-level check failed ([§4.4](#44-what-ci-does-and-what-green-means)). Any other red job means the code is already deployed. Choose between a fix-forward and [§6](#6-rolling-back). |

### 4.4 What CI does and what "green" means

[`ci.yml`](../../.github/workflows/ci.yml) runs on every push to every branch. A superseded
run on a working branch is cancelled. A run on `main` never is. `ci-watch-sha.sh`,
`deploy-watch.sh` and the Actions tab show each job's **display name**:

| Job ID | Display name | What it proves | On a branch | On `main` |
|---|---|---|---|---|
| `lint-test-build` | `lint-test-build` | Typecheck, lint, unit tests, `next build` (without a migrate), production-dependency audit | `success` | `success` |
| `db-tests` | `db-tests` | Migrations on a fresh Postgres; the `nmwc_app` role created, granted and verified; 37 of the 40 integration suites | `success` | `success` |
| `e2e` | `Playwright (login, health probe, CSP) on a production build` | Login, health probe and CSP on a production build | `success` | `success` |
| `restore-chain` | `Backup → encrypt → restore → verify` | The backup chain, on throw-away databases | `success` | `success` |
| `secrets-scan` | `secrets-scan` | gitleaks over **the commits each push adds**. It does not scan the whole history, whatever the comment in `ci.yml` says ([AUDITOR-BRIEF §8](../../AUDITOR-BRIEF.md#8-security-controls), §15). It uses default rules, which miss low-entropy passwords. | `success` | `success` |
| `post-deploy-smoke` | `Smoke production once it is serving this commit` | Waits until production serves this commit, then smokes it | **`skipped`** (it runs only on `main`) | `success` |

Any other `skipped`, `cancelled` or `failure` is not a pass.

`post-deploy-smoke` retries `scripts/ops/smoke.ts --expect-commit $GITHUB_SHA` up to 24
times, 15 seconds apart. It needs the `HEALTH_BEARER` repository secret, set to the **same**
value as Vercel's. When that secret is missing, the job fails rather than skips.

**A green `post-deploy-smoke` does not mean all 16 checks passed.** By design it excuses the
cron dead-man check when that is the only failure and it names a known alarm state:
`never`, `stale` or `failed`. A `failed` state is raised only as a warning. To see the cron
state, read the job log or the bearer health probe
([AUDITOR-BRIEF §10](../../AUDITOR-BRIEF.md#10-deployment-and-operations)).

### 4.5 Every branch push migrates UAT

Every branch push builds a Vercel **preview**, and the preview build applies that branch's
migrations to the **UAT** database. So push a migration only when it is final. Never edit
or rename a migration once it has been pushed
([HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) step 4,
[`AGENTS.md`](../../AGENTS.md) "Before you start" 5).

### 4.6 The two routes compared

| | Fast-forward push | Rebase and merge |
|---|---|---|
| Who carries it out | Claude, after the owner's "merge it". The route in use since 2026-10-01 | The owner, in GitHub. The route recorded in the `AGENTS.md` preface and HANDOVER §2 |
| What lands on `main` | Exactly `<sha>`, the commit whose CI was watched at gate 3 | New commits. CI first runs on them once they are already on `main` |
| Gate 8 | Nothing to look up | `git fetch origin`, then `git rev-parse origin/main` |
| Helpers | [`deploy-watch.sh`](../../scripts/dev/deploy-watch.sh) is written for it (see its header) | `deploy-watch.sh` works with the new SHA |

For the push:

- Never add `--force`. A rejected push means `main` moved: go back to gate 0.
- When one PR depends on another, have the dependent PR rebased onto `main` after its base
  merges, so that the reviewed head itself lands. History shows stacked PRs that were
  cherry-picked instead ([06 §4](./06-WORKING-WITH-AI-AGENTS.md#4-the-loop-from-task-to-production)).

Whichever route is chosen, record it as [§4.1](#41-how-main-moves) says.

---

## 5. Why the migration runs before the build

Vercel runs the `build` script in [`package.json`](../../package.json):

```
prisma generate && next typegen && tsc --noEmit && next lint && prisma migrate deploy && next build --no-lint
```

The database is migrated **before** `next build` runs. Typecheck and lint were moved ahead
of the migrate on 2026-09-24, and
[`tests/unit/ci-gates-guard.test.ts`](../../tests/unit/ci-gates-guard.test.ts) pins that
order. The hazard remains for anything that only `next build` catches.

| The Vercel build fails in | Migrations applied to production? | Production then serves |
|---|---|---|
| `prisma generate`, `next typegen`, `tsc`, `next lint` | No | The previous build, on the old schema. Harmless. |
| `prisma migrate deploy` | Possibly some: earlier migrations in the batch, and part of the failing one. Prisma records a failed migration and will not apply later ones until it is resolved. | The previous build. Treat it as a database incident and do not improvise. Read [OPERATIONS §6](../OPERATIONS.md#6-backups-recovery-and-what-they-are-actually-worth). |
| `next build` (a compile or prerender error, or a page's `params`/`searchParams` types) | **Yes** | The previous build, **against the new schema.** The database is migrated but the code is not deployed. |
| Nothing (deployed, then found broken) | Yes | The new build. An Instant Rollback returns the old build, still on the new schema. |

What follows from this:

- **Only CI's `next build` on the branch catches the third row before a migrate.** That
  is one more reason `main` moves only to a CI-green commit.
- Before pushing, run `npm run typecheck`, `npm run lint` and `npm test`. Use
  `npm run typecheck`, not bare `npx tsc --noEmit`. Without `next typegen` there are no
  route types, and a `<Link>` to a page that does not exist passes.
- **An application rollback never undoes a migration** ([§6](#6-rolling-back)).
- **A redeploy re-runs the whole build script**, including `prisma migrate deploy`. That
  step does nothing when no migration is pending. So **a restore followed by a deploy
  re-applies migrations** ([OPERATIONS §5](../OPERATIONS.md#5-database-migrations)).
- Recommendation: write each migration so that the build **before** it still works against
  the schema **after** it (add first, remove in a later release). That keeps the third and
  fourth rows survivable.

---

## 6. Rolling back

The procedure is [OPERATIONS §4](../OPERATIONS.md#4-deploy). In short:

1. Run `npm run smoke` and note what fails.
2. **Instant Rollback:** Vercel → project `nmwc-cm` → Deployments → the last production
   deployment known to be good → ⋯ → **Instant Rollback**. Nothing is built and no
   migration runs. Run smoke again.
3. **Revert through a PR.** Run `git revert` on a branch, wait for green CI, then merge as in
   [§4](#4-deploying-moving-main). If the bad change contains a migration, keep the migration
   out of the revert:
   1. Run `git revert --no-commit`.
   2. Run `git checkout HEAD -- prisma/schema.prisma prisma/migrations/<that migration>`.
   3. Commit.
4. After an Instant Rollback, Vercel does **not** hand production to new deployments on its
   own. When the revert's deployment is ready, check that it is the one serving production.
   If it is not, **Promote** it. Run smoke once more.

| Problem | Lever |
|---|---|
| Bad application code, no migration | Instant Rollback, then a revert PR. |
| The insights dashboard (`/dashboard`) is slow or broken | `INSIGHTS_DASHBOARD_DISABLED=true` in Vercel Production, then **Redeploy**: the page shows a notice and links and runs no dashboard query. Or Instant Rollback (F2 has no migration). |
| Bad code that shipped with a migration, and the old build works on the new schema | Instant Rollback. Revert the code but keep the migration (step 3). |
| The migration itself broke production, or the old build cannot run on the new schema | **Not a rollback.** Reverting a migration is a separate, deliberate database change. Stop and plan it. Never revert a migration without the Tier B review ([HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here) step 8). A fix-forward through [§4.2](#42-the-gates-in-order) may be the only cure. |
| Bad data written (an import, a script, a mistake) | A database recovery, not an app rollback. Neon point-in-time recovery reaches back 7 days ([OPERATIONS §6.4](../OPERATIONS.md#64-runbook-a--neon-point-in-time-recovery)). |

**The rollback target at handover.** In Vercel, Instant Rollback to the previous
production deployment. The code batches up to the handover contain no database
migration, so the previous build runs on the current schema. Identify the deployment in
Vercel by its commit. Which deployments to roll back to, in order, and their build IDs are
in PRIVATE-HANDOVER.md. Once `main` moves on, re-check this before you rely on it:
`git diff --name-only <rollback target's commit> origin/main -- prisma/` must print
nothing.

**Once F1 (notifications, 04-PENDING A1.11) is merged, that check prints its two
migrations, and the rule changes.** The foundation (`claude/notify-foundation`) adds two
notification kinds, `REQUEST_FYI` and `REACTIVATION_REQUESTED`. A build older than the
foundation cannot read a row of either: its `/notifications` page reads whole rows and
Prisma throws `Value '…' not found in enum`, so the page fails for every Accountant and
Manager with such a row among their newest 100, until someone fixes forward. So the
foundation is merged and deployed on its own, and passes smoke, before the writers
(`claude/notify-email`) are merged; after that, **the rollback target is the
foundation's deployment, never an older one.** The foundation writes neither kind, so
rolling back from it to the build before it is safe while no writer has run. If you must
go further back once writers have run, it is a deliberate database change first (Tier B,
with Claude, through `scripts/dev/prod-run.cjs`; HANDOVER §5): give the new-kind rows a
kind the old build knows, then roll back:

```sql
UPDATE "Notification" SET kind = 'EDIT_STAGE_ADVANCED' WHERE kind = 'REQUEST_FYI';
UPDATE "Notification" SET kind = 'EDIT_SUBMITTED'      WHERE kind = 'REACTIVATION_REQUESTED';
```

The rows keep their links and text; the inbox labels them "Progress" and "Review", and the
change is not undone when F1 is deployed again.

**Redeploying without a laptop:** Vercel → Deployments → the current production deployment
→ **Redeploy** ([CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md) step 1.4). A changed
environment variable reaches only new deployments, so every variable change needs this
step. A redeploy re-runs the build script, migrations included ([§5](#5-why-the-migration-runs-before-the-build)).

**Maintenance mode** puts the app behind a bilingual notice. To turn it on:

1. Set `MAINTENANCE_MODE=on` and `MAINTENANCE_BYPASS_TOKEN` in Vercel Production.
   The bypass token is in no local env file, and Vercel does not show a sensitive variable
   again ([§2.3](#23-two-env-files-kept-apart)). If you have no copy, set a new one.
2. **Redeploy**.

Health, cron, `/api/ops/` and `/api/auth/` stay open ([`lib/maintenance.ts`](../../lib/maintenance.ts)).
Because of the redeploy, OPERATIONS notes that in a real emergency pausing the deployment in
Vercel is faster. The bypass cookie is described in
[OPERATIONS §6.8](../OPERATIONS.md#68-what-can-still-go-wrong-and-is-not-fixed).

---

## 7. Running operator scripts against production

### 7.1 Who may

- Codex has **no** production access, for reads or for writes
  ([HANDOVER §2](../HANDOVER.md#2-how-a-change-is-made-verified-and-merged-here)).
- On 2026-09-27 the owner gave Claude a standing permission to write to production through
  operator scripts, with the safeguards below
  ([HANDOVER §4](../HANDOVER.md#4-the-owners-recorded-decisions)). It covers no credential
  rotation and no other agent. It is not a merge approval either: each merge still needs
  its own "merge it" ([§4.1](#41-how-main-moves)). **It ends on the date recorded in
  PRIVATE-HANDOVER.md; after that the new person decides** whether any AI agent touches
  production, and on what terms.

### 7.2 The runner: `scripts/dev/prod-run.cjs`

[`prod-run.cjs`](../../scripts/dev/prod-run.cjs) runs one script against production without
the connection string ever reaching the terminal:

- It reads `DIRECT_URL` from the file named by `NMWC_PROD_ENV_FILE`. If the variable is not
  set, it uses `.env` in the current directory. Always set the variable, and never rely on
  the default.
- It **refuses** a file whose host is not production (`ep-sweet-haze…`).
- It gives the script `DIRECT_URL` only. It sets `DATABASE_URL` to an address that cannot
  connect, so a script that ignores `DIRECT_URL` fails instead of using another database.
- It runs the script through `tsx` with **no shell**, so an argument is only ever an
  argument. The script runs in the **current directory**.
- It **masks** the following in everything the script prints: the URL, its password (raw
  and decoded), the user, the host, the endpoint, and anything shaped like a connection
  string.
- Output appears **when the script ends**. A run is stopped after 25 minutes.

Run it from the root of the checkout that holds what the script needs, and pass the
script's **file path**, not an `npm run` name:

```bash
# Git Bash
export NMWC_PROD_ENV_FILE=/path/outside/any/checkout/prod.env
node scripts/dev/prod-run.cjs scripts/ops/rescore-completeness.ts --expect-host ep-sweet-haze
```

```powershell
# PowerShell
$env:NMWC_PROD_ENV_FILE = 'C:\path\outside\any\checkout\prod.env'
node scripts/dev/prod-run.cjs scripts/ops/rescore-completeness.ts --expect-host ep-sweet-haze
Remove-Item Env:NMWC_PROD_ENV_FILE
```

On the previous owner's computer, the variable names the main checkout's `.env` instead.
[§2.3](#23-two-env-files-kept-apart) says why the new setup should not do that.

Never put `DIRECT_URL=…` on a command line, even though the scripts' own headers and
OPERATIONS §7 show that form
([HANDOVER §5](../HANDOVER.md#5-production-how-to-read-and-write-safely)).

**Scripts that need `golive-data/`** read it relative to the current directory, unless
`GOLIVE_DIR` names another folder. Run these scripts from the checkout that holds
`golive-data/` (it comes from the private pack), or set `GOLIVE_DIR`:

- `zero-credit-limits.ts` refuses to run without `golive-data/customer-master.xlsx`.
- `verify-load.ts` reads `golive-data/load-manifest.json`, unless both expectation flags
  are given.
- `export-crm-terms.ts` writes into `golive-data/`.

### 7.3 The sequence for a write

The operator scripts in `scripts/ops/` share one convention:

- They do a **dry run by default**.
- `--expect-host` is required **even for the dry run**. A dry run on the wrong database
  reports "nothing to do", which reads as "already fixed".
- `--apply` writes.
- Each applied run writes a ledger row before and after.
- Output is counts only.

The sequence:

1. Run `npm run smoke` and note the result.
2. **Rehearse on UAT** when the script is new or has changed. Do it in a checkout whose
   `.env` is UAT, where `node scripts/dev/env-check.cjs` says `not production`. Run
   `node scripts/qa/run-with-env.mjs tsx scripts/ops/<script>.ts --expect-host ep-lucky-bar`,
   then the same command with `--apply`.
3. **Run a production dry run** through `prod-run.cjs` with `--expect-host ep-sweet-haze`.
   The dry run resolves everything `--apply` needs, including the audit actor, so it meets
   every refusal the apply would.
4. **Read the counts.** If the script's notes say someone must be told first, tell them and
   get the go-ahead. For example, the completeness rescore visibly moves the leaderboards
   ([OPERATIONS §7](../OPERATIONS.md#7-common-operations)).
5. **Apply:** the same command plus `--apply`. Add `--actor <steward username>` where the
   script requires it, or wherever more than one Steward exists. The actor must be an active
   Steward and must not be on the demo denylist
   ([`lib/demo-accounts.ts`](../../lib/demo-accounts.ts)).
6. **Dry run again.** Expect nothing left to do.
7. Run `npm run smoke` again. Where the operation touches the load totals, run
   `scripts/ops/verify-load.ts` with the privately reconciled expectations
   ([OPERATIONS §7](../OPERATIONS.md#7-common-operations), [GO-LIVE-RUNBOOK](../GO-LIVE-RUNBOOK.md) step 6a).
8. Record what ran, when, and its counts in your **private** operations record. Never in
   this repository.

**The ledger tells you whether a run finished.** Each applied run writes a `STARTING` row and
a `COMPLETED` row in `AuditLog`, sharing one `entityId`. A `STARTING` row with no `COMPLETED`
row is an interrupted run: run it again.

**Exit codes after `--apply`:**

- The completeness rescore (`rescore-completeness.ts`) is explained in
  [OPERATIONS §7](../OPERATIONS.md#7-common-operations).
- The CR recompute (`recompute-cr-norm.ts`) is **not** in OPERATIONS. Its codes are in the
  script header
  ([`scripts/ops/recompute-cr-norm.ts`](../../scripts/ops/recompute-cr-norm.ts)) and in
  [HANDOVER §6.2](../HANDOVER.md#62-only-the-owner-can-do-or-must-confirm):
  - **0** means verified clean.
  - **1** means some norms still differ. Run `--apply` again, then a dry run.
  - **2** means a failure, or a failed check after the writes. The `COMPLETED` row is kept.
    Run a dry run, and run `--apply` again if it finds work.

  A successful dry run returns 0.

### 7.4 Read-only questions

For a one-off question, write a small script that opens a read-only transaction and prints
**counts only**: never a name, code, phone or id. Here is a sketch that follows
[HANDOVER §5](../HANDOVER.md#5-production-how-to-read-and-write-safely):

```ts
// count-example.tmp.ts: write it in a scratch folder, then copy it into the root of your
// checkout (never inside golive-data/) so that tsx can resolve @prisma/client. The
// .tmp.ts ending is gitignored. Delete the copy afterwards.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

async function main() {
  const n = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.customer.count({ where: { deletedAt: null } });
    },
    // Prisma's default interactive-transaction timeout is 5 s. Over the WAN link
    // to Neon a large count can take longer (scripts/ops/app-role.ts passes these too).
    { maxWait: 10_000, timeout: 60_000 }
  );
  console.log(`live customers: ${n}`);
}

main().finally(() => prisma.$disconnect());
```

Write it in a scratch folder outside the checkout, copy it into the checkout's root as
`count-example.tmp.ts`, and run it from there with
`NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs count-example.tmp.ts`
(Git Bash; in PowerShell set the variable first, as in
[§7.2](#72-the-runner-scriptsdevprod-runcjs)). Name every throw-away script `*.tmp.ts`:
[`.gitignore`](../../.gitignore) ignores that pattern, so it cannot be committed by
accident. A file with any other name is not ignored, so check `git status` before any
commit. Either way, delete the file when you are done.

### 7.5 Hygiene

- Put anything with backticks, quotes, `$` or regex backslashes in a file, and run it with
  `node <file>` (or `tsx`). Never use `node -e "…"` or a heredoc. They eat backslashes,
  and a double-quoted `node -e` once let the shell expand a secret path and print part of
  a production password ([`CLAUDE.md`](../../CLAUDE.md), "Safety").
- Never paste script output that contains customer or staff details anywhere. The scripts
  print counts only. Keep your own scripts that way.
- Never run `ops:visit-days` and `ops:rescore-completeness` at the same time
  ([OPERATIONS §7](../OPERATIONS.md#7-common-operations)).
- Do not run `npm run ops:r2-setup` against the photos bucket. It **replaces** the bucket's
  whole lifecycle configuration
  ([OPERATIONS §6.13](../OPERATIONS.md#613-photographs--bucket-versioning-owner-cloudflare-dashboard) step 0).
- An `AuditLog` delete refused with `B4: … append-only` is expected. The only override is
  the owner-only maintenance window in
  [OPERATIONS §5e](../OPERATIONS.md#5e-opening-an-audit-maintenance-window-owner-only).

### 7.6 Scripts that read or write a database

All of these are Tier B
([HANDOVER §2](../HANDOVER.md#classify-every-pr), "Scripts that can write to a database").
Read a script's header before you run it.

**Operator scripts in `scripts/ops/`:**

| Purpose | File (npm name) | Writes? | Ledger `entityType` | Runbook |
|---|---|---|---|---|
| Requeue customers the ERP was never told about | `requeue-untracked.ts` (`ops:requeue-untracked`) | With `--apply` | `TemixRequeue` | OPERATIONS §7 |
| Zero empty credit limits with a one-day term | `zero-credit-limits.ts` (`ops:zero-credit-limits`) | With `--apply`. Needs `golive-data/` | `CreditLimitZeroing` | Script header; HANDOVER §1 |
| Land visit days that a quarantine held back | `apply-quarantined-visit-days.ts` (`ops:visit-days`) | With `--apply` | `QuarantinedVisitDays` | OPERATIONS §7 |
| Rescore completeness | `rescore-completeness.ts` (`ops:rescore-completeness`) | With `--apply --actor` | `CompletenessRescore` | OPERATIONS §7 |
| Recompute normalized CR numbers | `recompute-cr-norm.ts` (`ops:recompute-cr-norm`) | With `--apply` | `CrNormRecompute` (and `CustomerPair` rows) | Script header; HANDOVER §6.2 |
| Load the visit days the Managers filled into the per-region sheets | `visitdays-from-sheets.ts` (`ops:visitdays-from-sheets`) | With `--apply`, of the reviewed set named by `--set` and `--set-sha`. `--reverse <runId> --confirm` undoes a run | `VisitDaysFromSheets`, plus one `Branch` row per day carrying the run id | Script header; OPERATIONS §7 |
| Verify the customer-master load | `verify-load.ts` (`verify:load`) | No. Reads `golive-data/` unless both expectation flags are given | — | OPERATIONS §7, GO-LIVE-RUNBOOK |
| Export the CRM's payment terms for the master builder | `export-crm-terms.ts` (`ops:export-crm-terms`) | Writes a CSV of customer data into `golive-data/` (private) | — | Script header |
| The least-privilege app role | `app-role.ts` | Yes. Refuses production unless `ALLOW_PRODUCTION=1` | — | OPERATIONS §5c (prefer the **Provision app role** workflow) |
| Verify a restored database | `restore-verify.ts` | No. Refuses production | — | OPERATIONS §6.4–6.5 |
| Load a dump into an **empty** target | `restore-load.sh` | Yes, into the target it is given | — | OPERATIONS §6.5 |
| Backup-bucket retention | `r2-backups-lifecycle.ts` | **Yes, without `--check`**: it writes the bucket's lifecycle rules. Only `--check` is read-only | — | OPERATIONS §6.9 |
| Photo-bucket versioning check | `r2-photos-versioning.ts` | No. It is a checker only (`--check`) | — | OPERATIONS §6.13 |
| cron-job.org jobs | `cron-scheduler.ts` | Writes to cron-job.org in `apply` mode. It runs inside the **External cron scheduler** workflow. Do not run `apply` again ([§9](#9-scheduled-jobs)) | — | OPERATIONS §5d |

**Scripts outside `scripts/ops/` that write to a database.** Each one is dangerous
against production:

| File | What to know |
|---|---|
| [`scripts/golive/bootstrap-accounts.ts`](../../scripts/golive/bootstrap-accounts.ts) | Creates the first Steward and the Managers from `golive-data/managers.json`. Requires `--expect-host`. |
| [`scripts/bulk-reset-credentials.ts`](../../scripts/bulk-reset-credentials.ts) | Writes only with `CONFIRM_CREDENTIAL_RESET=yes`. **It prints the generated passwords to stdout.** Never run it where its output reaches a transcript, a log or a shared screen. It has no production-host check. |
| [`scripts/wipe-synthetic-data.ts`](../../scripts/wipe-synthetic-data.ts) | Deletes data. It has no production-host check. |
| [`prisma/seed-muscat-pilot.ts`](../../prisma/seed-muscat-pilot.ts) | Refuses production. Its upsert sets `isActive: true`, so on production it would **revive deactivated accounts** with passwords that are written in the file (`CLAUDE.md`, "Safety"). |
| [`prisma/synthetic.ts`](../../prisma/synthetic.ts) (`npm run db:synthetic`) | Truncates core tables. Refuses `ep-sweet-haze`. |
| [`prisma/seed.ts`](../../prisma/seed.ts) (`npm run db:seed`) | Does **not** refuse production ([`AGENTS.md`](../../AGENTS.md) "Before you start" 4). |

Other scripts in `scripts/` and `scripts/golive/` open a database too. Treat any script
that builds a `PrismaClient` as able to write until you have read it. The output of the
`scripts/golive/` readers is private.

**Operator scripts that are not in this repository.** Some production operations were run
with scripts kept only in the private pack, among them `temix-link-apply.ts`,
`visitdays-jp.ts` and `pilot-edits-delete.ts`. To run one:

1. Copy it into the root of a checkout as `<name>.tmp.ts`, so that `tsx` can resolve
   `@prisma/client` and the copy is gitignored. If it reads `golive-data/`, use the
   checkout that holds it ([§7.2](#72-the-runner-scriptsdevprod-runcjs)).
2. Read its header, then follow [§7.3](#73-the-sequence-for-a-write), running it from that
   checkout's root as
   `NMWC_PROD_ENV_FILE=<production env file> node scripts/dev/prod-run.cjs <name>.tmp.ts`.
   Its flags may differ from those of the scripts above.
3. Delete the copy afterwards.

They were run on one pattern: a dry run, an independent check of its counts, a rehearsal
(rolled back) where the script has a `--rehearse` mode, then the apply, with
`npm run smoke` before and after. `temix-link-apply.ts` and `pilot-edits-delete.ts` have a
`--rehearse` mode. `visitdays-jp.ts` has no rehearse or reverse mode.

**The per-region visit-day sheets are loaded by `scripts/ops/visitdays-from-sheets.ts`**
(in the table above), on that same pattern: a dry run that writes a private set file and
review workbook into `golive-data/visitdays/from-sheets/`, an independent check of the set
against the same sheets, `--rehearse`, then `--apply` naming the reviewed set by `--set`
and `--set-sha`, with `npm run smoke` before and after. `--reverse <runId>` undoes a run;
it is a dry run until `--confirm`. The rows that need a person (a note, a day that is not
one of the seven codes, a branch that moved, closed or already has another day, rows that
disagree about one branch) are listed in the review workbook, for the in-app ways of
setting a visit day that [04 D2](./04-PENDING-WORK.md#d2-filling-in-missing-visit-days--p1)
describes. Blank rows, and rows whose branch already has that very day, are only counted.

---

## 8. Backups and restores

[OPERATIONS §6](../OPERATIONS.md#6-backups-recovery-and-what-they-are-actually-worth) has the
full picture, with recovery objectives and runbooks.

| Layer | What and when | How you know it worked |
|---|---|---|
| Neon point-in-time recovery | The database, at any instant in the last 7 days | The Neon console |
| Nightly dump: **DB Backup** ([`db-backup.yml`](../../.github/workflows/db-backup.yml)) | `pg_dump`, then gzip, then age encryption, then upload to R2 `nmwc-backups`, with a row-count manifest beside it. Scheduled at `0 2 * * *` UTC, but GitHub starts it late and unevenly. | **Both** of these: the run is green, **and** the `db-backup` heartbeat on the bearer health probe is `ok`. Each run reports to `/api/ops/backup-report` using `PROD_CRON_SECRET`. |
| Retention | 30 days, enforced by an R2 lifecycle rule on `db/` | `npx tsx scripts/ops/r2-backups-lifecycle.ts --check` (needs an admin token). The **R2 bucket settings** workflow runs it daily. |
| CI rehearsal | Dump, encrypt, restore and verify, on throw-away databases | The `restore-chain` job, on every push |
| Monthly **Restore drill** ([`restore-drill.yml`](../../.github/workflows/restore-drill.yml)) | Restores the newest real dump into a throw-away Neon branch and verifies it. Runs at `0 4 1 * *` UTC, or on demand. **It has never succeeded** (see below). | **Not the green tick.** Read the four evidence lines in [OPERATIONS §6.12](../OPERATIONS.md#612-turning-the-restore-drill-on-owner-neon-console) step 5. |
| Photos | **No backup.** The planned versioning and tag-then-expire design depends on two features Cloudflare R2 does not support: object versioning and object tagging. Open as F02. | [HANDOVER §6.1](../HANDOVER.md#61-waiting-on-the-owners-decision); [AUDITOR-BRIEF §6](../../AUDITOR-BRIEF.md#6-domain-the-flows) "Photos" |

Things to know:

- **What a red DB Backup means.** It means one of these:
  - the dump did not land, for example because `DIRECT_URL` is wrong or rotated, or the R2
    secrets are missing;
  - `BACKUP_AGE_RECIPIENTS` is missing, so the job refused to upload plaintext;
  - `ALLOW_PLAINTEXT_BACKUP` is set. In that case the run **uploads an unencrypted dump
    and then goes red on purpose**. Remove the variable and delete the plaintext object,
    which the run's error names
    ([`db-backup.yml`](../../.github/workflows/db-backup.yml), the last step;
    [OPERATIONS §6.7](../OPERATIONS.md#67-backup-encryption-and-key-escrow)).
- **A green DB Backup is not proof on its own.** If `PROD_CRON_SECRET` differs from Vercel's
  `CRON_SECRET`, the report step only prints a warning (HTTP 401) and the run stays green.
  The `db-backup` heartbeat then goes `stale`. It is a **critical** job, so the bearer probe
  answers 503 after 40 hours ([`lib/heartbeat.ts`](../../lib/heartbeat.ts)). If
  `PROD_CRON_SECRET` is unset, the heartbeat reads `never`.
- **The age private key decrypts every backup. Lose it and every backup is lost**
  ([OPERATIONS §6.7](../OPERATIONS.md#67-backup-encryption-and-key-escrow)). At handover,
  the backup decryption key (the age private identity for the nightly encrypted dumps) was
  **not found on the owner's computer and is not in the private pack**. GitHub's
  `BACKUP_AGE_IDENTITY` secret cannot be read back. Without a copy, no dump can be
  decrypted by anyone else. It is the owner's **first action before handing over**: put a
  copy in the pack, or add the new person's age recipient to `BACKUP_AGE_RECIPIENTS` and
  prove one decrypt. Until you have decrypted one dump yourself with a key you hold, treat
  the backups as unreadable and raise it with the owner before anything else. The drill is
  also the test that the GitHub copy of the key works.
- **The restore drill cannot run until `NEON_API_KEY` and `NEON_PROJECT_ID` exist** as
  repository secrets. Its preflight refuses to run rather than skipping. Its scheduled run
  on 2026-10-01 **failed at preflight** because both secrets are missing, so **it has never
  succeeded**. The secrets are listed as open in
  [HANDOVER §6.2](../HANDOVER.md#62-only-the-owner-can-do-or-must-confirm). Check with
  `gh secret list` and `gh run list --workflow=restore-drill.yml`. How to create them, and the
  key's scope:
  [OPERATIONS §6.12](../OPERATIONS.md#612-turning-the-restore-drill-on-owner-neon-console)
  (whose "has never run" is stale, [§2.5](#25-read-first-and-what-is-stale)).
- **R2 bucket settings** ([`r2-config.yml`](../../.github/workflows/r2-config.yml)) is a
  separate workflow on purpose, so that its red can never hide a failed backup. It stays
  red until the two per-bucket admin tokens exist. Its photo-versioning check will stay red
  even after that, because Cloudflare R2 does not support object versioning, until F02 is
  redesigned and the check changed with it.
- **Take a fresh dump before any risky database change:** Actions → **DB Backup** → Run
  workflow, or `gh workflow run db-backup.yml`.
- **A restore does not bring back** the `nmwc_app` role or its grants, the photographs, or
  the configuration
  ([OPERATIONS §6.3](../OPERATIONS.md#63-what-a-restore-does-not-bring-back)).
- **A restore log can quote customer rows.** It is kept only in encrypted form
  (`restore.log.age`). Decrypt it on your own machine and never paste it anywhere. This
  repository and its Actions logs are public.
- **Which secrets and variables the workflows need:** `npm run ops:print-secrets` lists the
  names. Its set or missing column describes **your local `.env` and `.env.local`**, not
  GitHub ([`scripts/print-required-secrets.ts`](../../scripts/print-required-secrets.ts)). It
  loads `.env`, so run `env-check` first. To see what the repository actually holds, use
  `gh secret list` and `gh variable list`.

---

## 9. Scheduled jobs

Times are UTC. Oman is UTC+4, so `3-14` means 07:00–18:59 in Oman.

| Job | What it does | Vercel cron ([`vercel.json`](../../vercel.json)) | GitHub Actions | cron-job.org | Heartbeat tier ([`lib/heartbeat.ts`](../../lib/heartbeat.ts)) |
|---|---|---|---|---|---|
| `keep-warm` | Keeps the app warm. Its probes are the availability measurement. | `*/4 3-14 * * *` | `keep-warm.yml`, same schedule (a late, sparse backup) | Yes, until retired (not visible from the repository) | warning |
| `sla-escalate` | Notifies about approvals that are past their SLA. A Supervisor-step breach goes to the Managers of the request's regions. When no active regional Manager covers it, the route sends it to the GM ([`app/api/cron/sla-escalate/route.ts`](../../app/api/cron/sla-escalate/route.ts)); the header comment in [`lib/escalation.ts`](../../lib/escalation.ts), "all active MANAGERs", is stale | `15,45 3-14 * * *` | `sla-escalate.yml`, same schedule | Yes, until retired | **critical** |
| `photo-gc` | Takes photos soft-deleted more than 30 days ago, tags their objects for an R2 expiry rule, then deletes their rows. R2 does not implement object tagging (F02). When R2 refuses the tag, the row is kept and the run records a failure ([`app/api/cron/photo-gc/route.ts`](../../app/api/cron/photo-gc/route.ts)). Do not rely on it to remove photo bytes. | `0 3 * * *` | — | — | warning |
| `retention-sweep` | The personal-data retention sweep | `30 3 * * *` | — | — | warning |
| `email-drain` | F1 (2026-10-05, not yet merged): sends the notification e-mail digests; does nothing until `NOTIFY_EMAIL_ENABLED=on` ([OPERATIONS §5i](../OPERATIONS.md)) | `*/10 3-14 * * *` | — | — | warning |
| `db-backup` | The nightly encrypted dump | — | `db-backup.yml`, `0 2 * * *` | — | **critical**; `stale` after 40 h |
| Restore drill | The monthly proof that a restore works | — | `restore-drill.yml`, `0 4 1 * *` | — | — |
| R2 bucket settings | Checks backup retention and photo versioning | — | `r2-config.yml`, `0 5 * * *` | — | — |

Two workflows run only when dispatched by hand:

- **External cron scheduler** (`cron-scheduler.yml`) manages the cron-job.org jobs.
- **Provision app role** (`provision-app-role.yml`).

How the schedules authenticate and where to look:

- Vercel sends `Authorization: Bearer <CRON_SECRET>` itself. GitHub sends the same secret,
  stored as `PROD_CRON_SECRET`. The two values must match
  ([SECRETS-INVENTORY §5](../SECRETS-INVENTORY.md#5-rotation-dependencies)). Neither is in
  any local env file. GitHub never shows a secret again, and Vercel does not show a
  sensitive variable again ([§2.3](#23-two-env-files-kept-apart)). Without a copy, the only
  way to change one side is to generate a new value and set both: a rotation.
- Duplicate calls are harmless. The SLA sweep claims each escalation only once, and
  keep-warm can repeat freely.
- **Retiring cron-job.org** is still open at `9d0fd61`. You need the cron-job.org login. Follow
  [OPERATIONS §5d](../OPERATIONS.md#5d-cron-heartbeats-and-the-health-probe-b5-2026-09-14)
  exactly:
  1. Confirm on the Service status page that Vercel runs every job.
  2. Delete both jobs. Disabling them is not enough.
  3. Delete the API key and the `CRONJOB_API_KEY` secret.
  4. Rotate `CRON_SECRET` in Vercel and `PROD_CRON_SECRET` in GitHub.
  5. Redeploy.

  Do not run the scheduler's `apply` again.
- Where to look:
  - Vercel → Settings → Cron Jobs
  - the Actions tab
  - the in-app **Service status** page (`/status`), which shows when Vercel last ran each job

---

## 10. Health and monitoring

| Signal | What it tells you | How |
|---|---|---|
| `npm run smoke` | 14 read-only checks in about 15 seconds. They cover health, CSP and nonce, security headers, redirects, cron and ops routes refusing anonymous calls, region `iad1`, and the auth host. Each check is something that has already gone wrong here. | `npm run smoke` for production, or `npm run smoke -- <preview url>`. With `HEALTH_BEARER` set it runs 16 checks, including **which commit production serves** and the cron dead-man. `--expect-commit <sha>` asserts the commit, and it refuses to run without `HEALTH_BEARER` ([`scripts/ops/smoke.ts`](../../scripts/ops/smoke.ts)). |
| `/api/health`, anonymous | `{"status":"ok"}` (200), or 503 `{"status":"degraded"}` when the database does not answer. Nothing else. | `curl -s https://nmwc-cm.vercel.app/api/health` |
| `/api/health` with `Authorization: Bearer $HEALTH_BEARER` | The DB and R2 checks, the running commit, and every job's heartbeat. It answers 503 when a check fails or a **critical** job alarms, and 200 `warn` when only a warning-tier job does. | [OPERATIONS §5d](../OPERATIONS.md#5d-cron-heartbeats-and-the-health-probe-b5-2026-09-14). See the rules on the bearer value below. |
| Service status page (`/status`) | Six service-level objectives, measured live, and the list of scheduled jobs | For the Data Steward and the Managers. The targets are in [SERVICE-LEVELS.md](../SERVICE-LEVELS.md). |
| Sentry | Unhandled errors from the server, edge and browser. It traces 10% of requests. | Search for a user's error **Reference** as the `digest` tag ([OPERATIONS §5g](../OPERATIONS.md#5g-finding-what-happened--logs-and-the-error-reference-item-10-2026-09-27)). |
| Vercel logs | Every request. `request.error` lines carry the Reference. | Kept for 30 days only with Observability Plus. Confirming that it is on is still open ([HANDOVER §6.2](../HANDOVER.md#62-only-the-owner-can-do-or-must-confirm)). |
| Alert webhook (`ALERT_WEBHOOK_URL`) | Pushes `cron.failed`, `sla.escalated` and `import.rejections` to a chat channel | **Recorded as not set.** Until it is set, nothing is pushed and you must look for yourself ([OPERATIONS §5f](../OPERATIONS.md#5f-outbound-alerts--the-only-way-this-system-can-reach-you-gap-2-2026-09-24)). |

**The bearer value** ([`app/api/health/route.ts`](../../app/api/health/route.ts)):

- `HEALTH_BEARER` in Vercel must be **at least 20 characters**. If it is unset or shorter,
  every request that sends a bearer gets 401 `MONITOR_NOT_CONFIGURED`.
- A wrong bearer gets 401 `UNAUTHORIZED`.
- A request that sends a bearer never falls back to the anonymous answer.
- The GitHub secret `HEALTH_BEARER` must hold the same value. Without it,
  `post-deploy-smoke` fails ([§4.4](#44-what-ci-does-and-what-green-means)).
- A new value reaches only new deployments, so redeploy after setting it.
- **Where the value is.** `HEALTH_BEARER` is in no local env file. It lives only in Vercel
  and in GitHub. GitHub never shows a secret again. Vercel shows a variable's value again
  unless it was saved as **Sensitive** ([§2.3](#23-two-env-files-kept-apart)), so if
  Vercel still shows it, read it there. If it was saved as Sensitive and you hold no copy,
  generate a new value of at least 20 characters, set it in Vercel Production and as the
  GitHub secret, then redeploy. That is a rotation: any external monitor that sends the
  old value must be updated too.

To set the bearer in Git Bash without leaving it in your shell history:

```bash
read -rs HEALTH_BEARER && export HEALTH_BEARER     # paste the value you hold, press Enter
npm run smoke -- --expect-commit "$(git rev-parse origin/main)"
curl -s -H "Authorization: Bearer $HEALTH_BEARER" https://nmwc-cm.vercel.app/api/health | jq .cron
```

**What nothing watches for you.** A job that stops running altogether pushes no alert. Only
the bearer probe shows `stale` or `never`. OPERATIONS §5d says to point an external uptime
monitor at the bearer probe and alert on any non-200. This repository does not record
whether one exists. Check, and set one up if there is none.

---

## 11. A routine for the operator

A suggested rhythm. It adds nothing new; it puts the checks above on a calendar.

**Each working day** (Oman's working week is Sunday to Thursday):

- Run `gh run list --workflow=db-backup.yml --limit 3`. Last night's dump should be green.
- Check the bearer probe's `.cron` (command in [§10](#10-health-and-monitoring)): `db-backup`
  should be `ok`. This catches a green run whose report was refused ([§8](#8-backups-and-restores)).
- Open the Service status page. No objective should be at Missed, and the scheduled jobs
  should be recent.
- Check Sentry for new issues since yesterday.

**Each week:**

- Run `npm run smoke` with `HEALTH_BEARER` set and `--expect-commit` on `origin/main`'s SHA.
- Check the bearer probe's `.cron`. Nothing should be `failed`, `stale` or `never`.
- Check the **R2 bucket settings** runs. They stay red for a known reason
  ([§8](#8-backups-and-restores)). Make sure the failure message has not changed.

**Each month:**

- After the 1st, read the restore drill's evidence lines ([§8](#8-backups-and-restores)).
  Until the `NEON_API_KEY` and `NEON_PROJECT_ID` secrets exist, expect it to fail at
  preflight, as it did on 2026-10-01.
- Record the drill's measured recovery time in
  [OPERATIONS §6.2](../OPERATIONS.md#62-recovery-objectives).

**For every change**, follow [§4](#4-deploying-moving-main). **For every production write**,
follow [§7](#7-running-operator-scripts-against-production).

---

## 12. Day-1 support

What users report first, and the in-app control that answers each report, is in the table
in **[OPERATIONS §7a, Day-1 support](../OPERATIONS.md#7a-day-1-support--symptom--action)**.
It covers:

- a first sign-in that fails
- an account lock
- the per-network sign-in limit
- a wrong visit day
- route and customer moves
- "already pending review" messages
- an error **Reference**
- who may reset or disable whom

Things to hold on to:

- **Use only the controls the table names.** If a fix needs anything else, collect the
  details and hand them to the Data Steward. Do not improvise in the database.
- **`/audit` shows times in UTC.** Add 4 hours for Oman.
- **The per-network sign-in limit counts failed sign-ins only** (owner decision X-AUTH-2,
  2026-10-04; [HANDOVER §6.1](../HANDOVER.md#61-waiting-on-the-owners-decision)). People who
  type correctly do not use it up.
- **No May-2026 pilot edit request is pending.** Those still open were all deleted on
  2026-10-04, on the owner's decision. The deletion is audited and a backup of the rows is
  in the private pack
  ([HANDOVER §6.2](../HANDOVER.md#62-only-the-owner-can-do-or-must-confirm)). So an
  "already pending review" message now points at a real, current request.
- **Users have a newer guide set than the repository.** On 2026-10-04 an English and Arabic
  set of PDF guides was produced from the code and given to users: one each for the
  Salesman, the Manager, the Approvers and the Data Steward, the how-the-system-works
  guide, and a checklist for the owner. It is in the private pack: `guides/`, and
  `golive-data/guides-2026-10-04/` with its content JSON and renderer. **Answer users from
  that set**, and check it against the app when in doubt.
- **The generated role guides in [`docs/guide/`](../guide/) are stale.** They were not
  rebuilt after the 2026-10-04 changes, they carry old wording in places
  ([AUDITOR-BRIEF §18](../../AUDITOR-BRIEF.md#18-known-gaps-and-open-items)), and they
  include no Approvers guide and no Arabic Steward guide. Whether the newer set replaces
  them, after a leak review, is still open ([§15](#15-operational-items-that-are-not-done)).
- **Keep at least two active Steward accounts** ([§2.2](#22-accounts-and-access)). The current state is in `PRIVATE-HANDOVER.md`.

Route and customer moves go through the Steward's imports
([OPERATIONS §7](../OPERATIONS.md#7-common-operations)). Password resets and disabling a
leaver are done on `/users`.

---

## 13. When something breaks

The incident playbook is [OPERATIONS §8](../OPERATIONS.md#8-incident-playbook). Where to
start:

| Symptom | First look | Then |
|---|---|---|
| Smoke fails | The failing check's `why it matters` line | [§6](#6-rolling-back) if a deploy caused it |
| `Smoke production once it is serving this commit` red on `main` | The job log: is production serving the commit? | [§4.3](#43-if-deploy-watchsh-does-not-exit-0) |
| The bearer health probe shows a job `stale`, `never` or `failed` | Vercel → Settings → Cron Jobs; the workflow's runs; `.cron.jobs[].lastError` | OPERATIONS §8, first symptom |
| `/api/health` answers 503 | The bearer probe's `checks` | OPERATIONS §8, "returns degraded" |
| Sign-in errors (500) | Sentry | OPERATIONS §8, "Sign-in 500s" |
| Photo upload fails | Vercel logs for the presign route | OPERATIONS §8 |
| **DB Backup** run is red | The failed step: Validate (`DIRECT_URL`), the encryption refusal (`BACKUP_AGE_RECIPIENTS`), Upload (R2 secrets), or the last step (`ALLOW_PLAINTEXT_BACKUP` is set) | [§8](#8-backups-and-restores); [OPERATIONS §6.8](../OPERATIONS.md#68-what-can-still-go-wrong-and-is-not-fixed) |
| **DB Backup** is green, but `db-backup` is `stale` or `never` | The warning from the run's "Report the outcome" step | `PROD_CRON_SECRET` is unset or does not match Vercel's `CRON_SECRET` ([SECRETS-INVENTORY §5](../SECRETS-INVENTORY.md#5-rotation-dependencies)) |
| **R2 bucket settings** run is red | Which of its two checks failed | Expected until the admin tokens exist. The photo-versioning check stays red after that too, because R2 does not support versioning, until F02 is redesigned ([§8](#8-backups-and-restores)). It never means a backup failed. |
| A user quotes an error Reference | Vercel Logs and a Sentry search | [OPERATIONS §5g](../OPERATIONS.md#5g-finding-what-happened--logs-and-the-error-reference-item-10-2026-09-27) |
| A script fails with `B4: DELETE on "AuditLog" is forbidden` | Nothing is wrong: the audit tables are append-only | [OPERATIONS §5e](../OPERATIONS.md#5e-opening-an-audit-maintenance-window-owner-only) |
| Bad data written | Stop the cause first | [OPERATIONS §6.2](../OPERATIONS.md#62-recovery-objectives), path A |

---

## 14. Windows quirks

The project was run from Windows. The test-side quirks are in
[HANDOVER §8](../HANDOVER.md#8-windows-test-quirks) and in [`CLAUDE.md`](../../CLAUDE.md),
"Tests". These are the ones that matter for operating:

- **Run the `.sh` helpers in Git Bash.** In PowerShell, `bash` may not be Git's bash.
- **Git Bash costs about 0.25 s per process.** `ci-gates-guard.test.ts` takes minutes,
  and "did not finish" is not the same as "failed". Do not shrink its attempt budget.
- **PowerShell:** use `npm.cmd`, because the execution policy blocks `npm.ps1`. Set a
  variable with `$env:NAME = 'value'` before the command, not as a prefix to it.
- **Heredocs and `node -e` eat backslashes.** Put the code in a file
  ([§7.5](#75-hygiene)).
- **Never inspect an env file with `grep`, `Select-String` or `cat`.** Use
  `node scripts/dev/env-check.cjs`.
- **Worktrees:** never `git worktree remove --force` a worktree whose `node_modules` is a
  junction. Remove the junction first ([§2.4](#24-if-you-received-a-copied-folder)).
- **Line endings:** [`.gitattributes`](../../.gitattributes) sets `eol=lf` for text files, so
  the shell scripts check out with LF and run in Git Bash.
- **`excel.test.ts` and `import-templates.test.ts`** fail on the first run after a large
  `npm ci` and pass on a rerun. Rerun them before investigating.
- **Local database timings are WAN-bound** (Oman to Neon in us-east). Do not read them as
  production performance
  ([HANDOVER §7](../HANDOVER.md#7-things-that-look-like-defects-and-are-not)). The UAT link
  is also flaky. On "can't reach database server", rerun.
- **A spaced `-t "pattern"`** passed through `run-with-env.mjs` becomes a set of file
  filters. Use a pattern without spaces.

---

## 15. Operational items that are not done

At `9d0fd61` and at the 2026-10-04 handover, the items below are open. Check each one
before you rely on it, because some may have been done since. The owner-side list is
[HANDOVER §6.2](../HANDOVER.md#62-only-the-owner-can-do-or-must-confirm), and the owner's
fill-in list is in PRIVATE-HANDOVER.md.

| Item | Effect while open | Where |
|---|---|---|
| A copy of the backup decryption key outside GitHub | It was not found on the owner's computer and is not in the private pack, and GitHub's `BACKUP_AGE_IDENTITY` cannot be read back. Without a copy, no dump can be decrypted by anyone else. The owner's first action before handing over | [§8](#8-backups-and-restores); OPERATIONS §6.7 |
| `NEON_API_KEY` and `NEON_PROJECT_ID` for the restore drill | The drill's scheduled run on 2026-10-01 failed at preflight. It has never succeeded, so nothing has proven that a real dump is restorable | [§8](#8-backups-and-restores); OPERATIONS §6.12 |
| `ALERT_WEBHOOK_URL` | No push alerts at all | OPERATIONS §5f |
| An external uptime monitor on the bearer probe | A dead job or an outage is noticed only when someone looks | OPERATIONS §5d (not recorded either way) |
| Retire cron-job.org and rotate `CRON_SECRET` | A third party still holds the cron secret | OPERATIONS §5d |
| R2 admin tokens (one per bucket) | **R2 bucket settings** stays red | OPERATIONS §6.13 step 4 |
| Photo cleanup and recovery design (F02) | Photos are a single copy. `photo-gc` relies on object tagging and the plan relied on versioning, and Cloudflare R2 supports neither | HANDOVER §6.1; AUDITOR-BRIEF §6, §18 |
| Confirm the app's database role (item 14) | Whether production uses the restricted `nmwc_app` role is recorded in PRIVATE-HANDOVER.md. Switching is an owner-side action ([CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md)) | CREDENTIAL-ROTATION step 1; HANDOVER §6.2 |
| Confirm Vercel Observability Plus | Logs may be kept for 1 day instead of 30 | OPERATIONS §5g |
| Decide about search terms kept unredacted in Vercel request logs | Customer search text stays in the logs for as long as they are kept | HANDOVER §6.2 (DATA-RETENTION gap 7) |
| A second holder of the production credentials | One person can deploy, roll back and restore | SECRETS-INVENTORY §4 |
| Values held only in Vercel and GitHub (`CRON_SECRET`, `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN`, `BACKUP_AGE_*` and the rest) | They are in no local env file and cannot be read back. Without a copy elsewhere, using one means regenerating it: a rotation | [§2.3](#23-two-env-files-kept-apart); SECRETS-INVENTORY §2, §5 |
| A named Data Steward account for the new person | With too few Steward accounts, an absence or a lock-out leaves nobody able to import, correct quarantined rows or reset passwords | [§2.2](#22-accounts-and-access); PRIVATE-HANDOVER.md fill-in list |
| Who approves merges after handover, and by which route | Until the owner and the person taking over agree, only the owner says "merge it". The `AGENTS.md` preface and HANDOVER §2 describe only Rebase and merge | [§4.1](#41-how-main-moves); PRIVATE-HANDOVER.md fill-in list |
| Who reviews Tier B after handover | The recorded rule names Claude | [§4.1](#41-how-main-moves); HANDOVER §2 |
| Loading the per-region visit-day sheets as they come back | The loader exists (`scripts/ops/visitdays-from-sheets.ts`), but each returned workbook still has to be run through it, and the rows it leaves need a person | [§7.6](#76-scripts-that-read-or-write-a-database); PRIVATE-HANDOVER.md |
| Confirm that the signed-in CSP browser walk is done or superseded | It covers sign-in, the forced password change, early sign-out, the `/audit` filter, approve and reject, and photo upload | HANDOVER §6.2 |
| Fix the stale parts of OPERATIONS.md (including §6.12 and §6.13), the GO-LIVE-RUNBOOK header and the `lib/escalation.ts` header comment | Readers follow wrong instructions ([§2.5](#25-read-first-and-what-is-stale)) | AUDITOR-BRIEF §15 |
| The role guides in `docs/guide/` | Users hold the newer 2026-10-04 guide set, and `docs/guide/` carries old wording and lacks the Approvers and Arabic Steward guides. Decide whether the newer set replaces `docs/guide/`, after a leak review, or rebuild `docs/guide/` with `npm run guide:roles` ([§12](#12-day-1-support)) | AUDITOR-BRIEF §18; [04 B1.6](./04-PENDING-WORK.md) |
| Credential rotation | See [CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md) and the "Must match" pairs in SECRETS-INVENTORY §2 and §5. Rotation status is in PRIVATE-HANDOVER.md. | HANDOVER §6.2 |

**Recorded as open in older text, but closed on 2026-10-04.** Some documents may still list
these as pending. Do not act on them:

| Item | What happened |
|---|---|
| The May-2026 pilot edit requests | All of those still open were deleted on 2026-10-04, on the owner's decision. The deletion is audited, and a backup of the rows is in the private pack. None is pending ([§12](#12-day-1-support)). |
| The CR-number recompute on production | Closed. A read-only production dry run on 2026-10-04 found nothing to recompute. The script stays in the repository; [§7.3](#73-the-sequence-for-a-write) has its exit codes. |

When you finish one, update the document named in the last column in the same change. Then
the next reader neither redoes it nor trusts it before it is true. Run the leak check
([§3](#3-rules-that-are-never-bent) rule 8) before you commit.
