# Start here: NMWC CRM handover

You are taking over the NMWC CRM. Begin on this page. It covers what the system is, who is
involved, what to read, what to do on day one, and the rules that matter most.

> **This repository is public.** Never add anything private to it: no password,
> connection string, token, key, customer or staff data, production figure or rollout
> status. Some private material is already in it, under a risk the owner accepted. The
> current files and the history hold the shared initial password, the May pilot
> passwords, the seeded admin and demo passwords, staff names and production screenshots
> ([AUDITOR-BRIEF §14](AUDITOR-BRIEF.md), [HANDOVER §4](docs/HANDOVER.md)). Never reuse
> any of those values. The private material you need is in the **encrypted handover
> pack**, with two exceptions that §4 explains: the backup decryption key, and the values
> that live only in Vercel and GitHub. The owner gives you the encrypted pack and,
> separately, its password. Begin with the first-day checklist in §4.

---

## 1. The system in one paragraph

The NMWC Customer Master (package `nmwc-cm`) is a web app for National Mineral Water
Company, Oman. Field salesmen open the customers on their route and fill in what the master
data is missing: phone, contact, address, GPS, photos, channel and visit day. Field values
wait for approval. Photos do not. A CR, shop or signboard photo taken in the edit form goes
live at once, and approval re-checks the mandatory fields against the live record. Managers
and the Data Steward can also write directly, and those writes are audited. New customers go
through an approval chain. A cash customer goes through the Supervisor step, then the
Accountant. A credit customer goes through the Supervisor step, the Finance Manager, the GM
and then the Accountant. Approved data is queued for the company ERP, **Temix** (spelled
"Timix" in some files), which stays the system of record. A Data Steward uploads the data
to Temix as Excel batches. There is no live API. The stack is Next.js 15 (App Router) with React 19,
Prisma 6 on Neon Postgres (production plus a separate UAT branch), Auth.js credentials
sign-in, Cloudflare R2 for photos and Sentry for errors. It is hosted on Vercel Pro
(project `nmwc-cm`, <https://nmwc-cm.vercel.app>). **Merging to `main` deploys to
production.**

## 2. Who is involved

| Who | Role |
|---|---|
| **The owner** | The product owner. Today the owner holds every account and secret ([SECRETS-INVENTORY §1](docs/SECRETS-INVENTORY.md)) and makes the business decisions. In commits and comments, "owner decision" means a choice the owner made and recorded. The owner approves every merge in words ("merge it"). Since 2026-10-01 Claude has carried out each approved merge (§5, "If merging passes to you"). After the handover, merge approval, product and business authority and the owner's other powers pass to the person the owner names in `PRIVATE-HANDOVER.md` (fill-ins F2 and F4). Until someone is named there, they stay with the owner. |
| **You** | You finish the project. On day one, settle with the owner what passes to you (checklist step 9). |
| **Claude Code** (Anthropic) | An AI agent used as reviewer and production operator. It reads [`CLAUDE.md`](CLAUDE.md). It reviews Tier B PRs (their titles start with `[needs Claude]`) and runs adversarial passes. It merges only after the owner says "merge it". Since 2026-10-01 it has done so by pushing the exact CI-green commit to `main`, with the procedure in [03 §4](docs/handover/03-OPERATIONS-AND-DEPLOYMENT.md). It is the only agent allowed to run production operations. On 2026-09-27 the owner gave it standing permission to write to production through operator scripts, under the safeguards in [HANDOVER §5](docs/HANDOVER.md). That permission ends on the date recorded in `PRIVATE-HANDOVER.md`, which also records its terms. After that date, you decide whether to keep, narrow or end it. |
| **Codex** (OpenAI) | An AI agent used as builder. It reads [`AGENTS.md`](AGENTS.md) and works on `codex/<topic>` branches, in its own clone, without any `.env` file or `golive-data/`. It labels every PR Tier A or Tier B. It never pushes to `main`, never merges, and has no production access at all, not even reads. |
| **App users** | Eight roles exist in code (`Role` in `prisma/schema.prisma`): Salesman, Supervisor, Manager, Accountant, Finance Manager, GM, Data Steward and Viewer ([AUDITOR-BRIEF §5](AUDITOR-BRIEF.md)). There are no Supervisor accounts. Managers do the Supervisor step ([HANDOVER §4](docs/HANDOVER.md)). Keep at least two active Data Steward accounts. The current state is in `PRIVATE-HANDOVER.md`. Without an active Steward, nobody can import, fix quarantined rows or reset passwords ([SECRETS-INVENTORY §3](docs/SECRETS-INVENTORY.md)). Ask the owner to create a named Steward account for you, with a name the demo-account denylist allows (§5). The role guides in [`docs/guide/`](docs/guide/) are stale. On 2026-10-04 a newer English and Arabic set was produced from the code and given to users: PDF guides for the Salesman, the Manager, the Approvers and the Data Steward, plus the how-the-system-works guide and an owner checklist. It is in the pack (`guides/`, and `golive-data/guides-2026-10-04/` with its content JSON and renderer). Answer users from that set. Whether it replaces `docs/guide/`, after a leak review, is still open. |

## 3. What to read, in order

**The handover set** was written for you in October 2026:

| # | Document | Read it for |
|---|---|---|
| — | `PRIVATE-HANDOVER.md` (**in the pack, never in this repository**) | The state of production with its figures, the plan, every owner decision with its date, the end date and terms of Claude's production permission, the credential status, the list of decisions the owner still has to fill in, an index of the pack, and contacts |
| 1 | [01-SYSTEM-OVERVIEW](docs/handover/01-SYSTEM-OVERVIEW.md) | What the app does: roles, flows, architecture, the repo map and the data model |
| 2 | [02-ACCESS-ACCOUNTS-AND-SECRETS](docs/handover/02-ACCESS-ACCOUNTS-AND-SECRETS.md) | Every service and account, every secret by **name**, and where each value lives |
| 3 | [03-OPERATIONS-AND-DEPLOYMENT](docs/handover/03-OPERATIONS-AND-DEPLOYMENT.md) | Merging and deploying, rollback, running scripts safely against production, backups, crons and monitoring |
| 4 | [04-PENDING-WORK](docs/handover/04-PENDING-WORK.md) | Everything that is not done: owner decisions, engineering work, owner-side actions and data work |
| 5 | [05-NEW-COMPUTER-SETUP](docs/handover/05-NEW-COMPUTER-SETUP.md) | From a clean machine to a working setup, including opening the pack. You use it at checklist step 6. |
| 6 | [06-WORKING-WITH-AI-AGENTS](docs/handover/06-WORKING-WITH-AI-AGENTS.md) | How Claude and Codex have been used here, and how to continue with them |
| 7 | [07-PROJECT-HISTORY](docs/handover/07-PROJECT-HISTORY.md) | A dated timeline and the major decisions |
| 8 | [08-KNOWLEDGE-GRAPH](docs/handover/08-KNOWLEDGE-GRAPH.md) | The knowledge graph in `graphify-out/`: a map of where things live in the code and docs and how they connect, how to query it, and how to rebuild it without leaking anything private |

**Existing documents.** The handover set links to these rather than copying them.

| Document | One line |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The 2026-09-30 working agreement: tiers, review and Codex's limits. Its preface says the owner merges with GitHub's Rebase and merge. Since 2026-10-01, Claude has carried out the owner's approved merges instead (§5). Below its preface is a verbatim copy of `CLAUDE.md`, and `tests/unit/agents-md-guard.test.ts` fails if the two drift apart. |
| [`CLAUDE.md`](CLAUDE.md) | The standing rules, each with the incident that made it a rule. Its merge rule, never to fast-forward `main` without the owner's explicit yes, is the one followed since 2026-10-01. |
| [`docs/HANDOVER.md`](docs/HANDOVER.md) | The 2026-09-30 handover. It covers the merge procedure as recorded then (§2), the owner's recorded decisions (§4), safe production reads and writes (§5), open items (§6) and Windows quirks (§8). |
| [`AUDITOR-BRIEF.md`](AUDITOR-BRIEF.md) | How the system works, in depth. §12 covers deliberate choices that look like bugs, §14 lists sensitive material already in the repo, §15 lists stale docs and §18 lists known gaps. Appendix B covers the auditor's findings. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | The operator runbook. §6 covers backups, §7a is day-1 support (symptom → action) and §8 is the incident playbook. Parts are stale (AUDITOR-BRIEF §15, and the list below). |
| [`docs/GO-LIVE-RUNBOOK.md`](docs/GO-LIVE-RUNBOOK.md) | The procedure for loading customer data. Confirm scope with the owner before you follow it. |
| [`docs/SECRETS-INVENTORY.md`](docs/SECRETS-INVENTORY.md) | Each account and each runtime variable, what breaks without it, and the open question of a second holder |
| [`docs/CREDENTIAL-ROTATION.md`](docs/CREDENTIAL-ROTATION.md) | How to rotate the production database credential, step by step |
| [`docs/SERVICE-LEVELS.md`](docs/SERVICE-LEVELS.md) | The six service objectives and where their numbers come from |
| [`scripts/dev/`](scripts/dev/) | Helpers, each with a usage header: `env-check.cjs`, `leak-check.cjs`, `ci-watch-sha.sh`, and the production diagnostics `prod-run.cjs`, `build-id.cjs` and `deploy-watch.sh` (owner and Claude only, HANDOVER §5) |
| [`CHANGELOG.md`](CHANGELOG.md), [`docs/CHANGELOG.md`](docs/CHANGELOG.md), `README.md` | All three are stale. The changelogs have no entries after May 2026, and the README still says "Milestone 0". Use `git log` and 07-PROJECT-HISTORY instead. |

**When sources disagree, trust them in this order:** the code, then `AUDITOR-BRIEF.md`,
then recent commit messages, then everything else in `docs/` and `qa/`.

**Where older documents are out of date.** These facts hold, whatever an older document
says:

- **Merging.** The owner approves every merge in words ("merge it"). Since 2026-10-01
  Claude has carried out each approved merge by pushing the exact CI-green commit to
  `main` ([03 §4](docs/handover/03-OPERATIONS-AND-DEPLOYMENT.md)). The `AGENTS.md` preface
  and HANDOVER §2 record the alternative: the owner uses GitHub's Rebase and merge. Codex
  never merges or pushes `main`.
- **Restore drill.** Its scheduled run on 2026-10-01 failed at preflight, because the
  `NEON_API_KEY` and `NEON_PROJECT_ID` GitHub secrets are missing. It has never
  succeeded. OPERATIONS §6.12, AUDITOR-BRIEF §7 and its Appendix A still say it has never
  run.
- **Photo versioning.** Cloudflare R2 supports neither object versioning nor object
  tagging ([HANDOVER §6.1](docs/HANDOVER.md), F02). OPERATIONS §6.13 is stale on this
  point.
- **SLA escalation.** When no regional Manager covers a Supervisor-step breach,
  `app/api/cron/sla-escalate/route.ts` sends it to the GM. The header comment in
  `lib/escalation.ts` ("all active MANAGERs") is stale.
- **CR-number recompute.** Closed. A read-only production dry run on 2026-10-04 found
  nothing to recompute. Parts of AUDITOR-BRIEF §18 and its Appendix A still call it
  pending.
- **May-2026 pilot edit requests.** None is pending. `PRIVATE-HANDOVER.md` records how
  they were closed.
- **User guides.** `docs/guide/` is stale. A newer set is in the pack (§2, App users).

## 4. First-day checklist

Work through these steps in order.

1. [ ] **Get the pack and its password from the owner.** The owner gives you the encrypted
   pack and, separately, its password. Never keep the password next to the pack, and never
   send it by e-mail or chat. Ask the owner which of the two steps for the backup
   decryption key was done (the accounts table below). When this page was written, the key
   was not in the pack.
2. [ ] **Open the pack on a local encrypted disk that you control**, for example one
   protected by BitLocker or FileVault. Copy the pack there first. Never decrypt it inside a
   synced or shared folder, and never move the unpacked folder into one. `HOW-TO-OPEN.txt`
   sits next to the pack. In Git Bash, or a macOS or Linux terminal:

   ```bash
   gpg --output pack.tar.gz --decrypt NMWC-CRM-handover-2026-10-04.tar.gz.gpg && tar -xzf pack.tar.gz
   ```

   GnuPG asks for the password. Then, inside the folder the archive unpacks to, run
   `sha256sum -c MANIFEST.sha256`. Every file must report `OK`. `pack.tar.gz` is an
   unencrypted copy, so delete it once the check passes, and keep the `.gpg` file as your
   archive. [05](docs/handover/05-NEW-COMPUTER-SETUP.md) covers the rest. The pack was
   sealed after this handover set reached `main`, so its copy of the repository includes
   it. `PRIVATE-HANDOVER.md` records the `main` commit the pack was built from.
3. [ ] **Read `PRIVATE-HANDOVER.md` from the pack.** It also lists the decisions the owner
   fills in for you. The pack holds Claude's memory, which includes a note of the owner's
   production-write grant to Claude. On 2026-10-04 that note was updated to the terms
   recorded in `PRIVATE-HANDOVER.md`, so you can restore the memory on your computer
   ([05 §6.4](docs/handover/05-NEW-COMPUTER-SETUP.md)). Claude Code reads it from
   `~/.claude/projects/<key>/memory/`. `<key>` is the absolute path of the folder you open
   Claude Code in, with every character that is not a letter or a digit replaced by `-`:
   `C:\Users\x\Desktop\NMWC-CRM` becomes `C--Users-x-Desktop-NMWC-CRM`. The notes also name
   the owner's local file locations, which do not exist on your computer. Correct them.
   Once the grant ends, keep, change or delete its note to match your own decision.
4. [ ] **Read [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md) and §5 below in full**
   before you run anything.
5. [ ] **Get your own access** to each account in the table below. Ask the owner to invite
   you under your own login. Do not share the owner's logins ([SECRETS-INVENTORY §4](docs/SECRETS-INVENTORY.md)
   compares the options).
6. [ ] **Set up your computer with [05](docs/handover/05-NEW-COMPUTER-SETUP.md).** Use a
   fresh `git clone`, then add the private files from the pack. Do not copy the owner's
   folder. Its main checkout's `.env` points at **PRODUCTION**. The agent worktrees under
   `.claude/worktrees/` can hold their own `.env` files and private data. Git worktrees also
   record absolute paths, so they break when moved.
7. [ ] **Run `node scripts/dev/env-check.cjs [env file]` before anything loads a
   `.env`.** That includes tests, Prisma and `scripts/qa/run-with-env.mjs`. The check
   covers only `DATABASE_URL` and `DIRECT_URL`, in the file and in the process
   environment. For each one it prints `PRODUCTION`, `not production` or `not set`, never
   a value. It ends with `STOP: …` and exit code 1 on production, or `ok: …` otherwise.
   Run it first because `run-with-env.mjs` loads `.env` without checking the host, and
   because some integration suites and `prisma/seed.ts` do not refuse production
   (AGENTS.md item 4, [AUDITOR-BRIEF §11](AUDITOR-BRIEF.md)). Never inspect a `.env` with
   `grep` or `Select-String`. They print the whole line, password included. Every
   checkout's `.env` should name UAT. On the owner's computer today, the main checkout's
   `.env` is the production file, and Claude's operator runs pass it explicitly with
   `NMWC_PROD_ENV_FILE=<main checkout>/.env node scripts/dev/prod-run.cjs <script> [args]`.
   In your setup, keep the production env file outside every checkout, and pass it the
   same way, through `NMWC_PROD_ENV_FILE=<file>` ([HANDOVER §5](docs/HANDOVER.md)). If you
   copy an operator script from the pack into a checkout, name it `*.tmp.ts`. Git ignores
   that pattern, but still delete the copy after use.
8. [ ] **Run `npm run smoke`** (in PowerShell, `npm.cmd run smoke`, HANDOVER §8). It is
   read-only, needs no credentials and takes about fifteen seconds. It must end with
   `all 14 checks passed`, or `all 16 checks passed` when `HEALTH_BEARER` is set. That
   value is not in any env file in the pack (see below the accounts table). If anything
   fails, stop and ask the owner before you change anything.
9. [ ] **Agree these points with the owner.** Most of them are on the fill-in list in
   `PRIVATE-HANDOVER.md`.
   - who approves merges after the handover (until someone is named, the owner), and who
     carries them out;
   - who reviews Tier B PRs;
   - who holds product and business authority after the handover (until someone is named,
     the owner);
   - who runs production operations once Claude's permission ends;
   - a named Data Steward account for you;
   - the backup decryption key (the accounts table below);
   - who owns and pays for each account;
   - whether the GitHub repository moves to an organisation or is transferred to you;
   - when credentials are rotated.

### Accounts to receive

The first four rows are the smallest set that keeps production alive
([SECRETS-INVENTORY §4](docs/SECRETS-INVENTORY.md)). This is a transfer of the project, not
a second seat, so settle ownership and billing too (step 9).

| Account | What it controls | Transfer note | When |
|---|---|---|---|
| GitHub (`rahmanmansoori244-droid/NMWC-CRM`) | The code, CI and every Actions secret. Merging to `main` deploys. | This is a personal repository. A collaborator can push but cannot manage settings or Actions secrets. To administer it, the repo must move into an organisation or be transferred to you. | First |
| Vercel (project `nmwc-cm`, Pro) | Deploys, instant rollback, crons, logs and runtime variables | A developer seat costs money. A free Viewer seat is read-only. | First |
| Neon (production endpoint `ep-sweet-haze`, plus UAT) | The database, point-in-time restore and the owner role | Check the members page for the current plan | First |
| The backup decryption key (the age private identity for the nightly encrypted dumps) | The only way to read a backup. A new key cannot open old dumps ([OPERATIONS §6.7](docs/OPERATIONS.md)). The restore drill decrypts with the copy in the GitHub secret `BACKUP_AGE_IDENTITY`. Its scheduled run on 2026-10-01 failed at preflight, because the `NEON_API_KEY` and `NEON_PROJECT_ID` secrets are missing, and it has never succeeded. So decryption with that key is unproven. | The key was not found on the owner's computer, and it is not in the pack. GitHub's `BACKUP_AGE_IDENTITY` secret cannot be read back. Without the key, nobody else can decrypt any dump. It is the owner's first action before handing over: put a copy in the pack, or add your age recipient to `BACKUP_AGE_RECIPIENTS` and prove one decrypt with your key ([02 §2.10](docs/handover/02-ACCESS-ACCOUNTS-AND-SECRETS.md)). | First |
| Cloudflare R2 | Photos, the backup bucket and their tokens | Invite through account members | Soon |
| Sentry | Error reports | The free plan has one user | Soon |
| cron-job.org | Being retired ([OPERATIONS §5d](docs/OPERATIONS.md)) | Not needed after it is retired | Only to retire it |
| Alert destination (`ALERT_WEBHOOK_URL`) | Where failed-job and SLA alerts land | Not set yet. Point it at a channel that two people read ([OPERATIONS §5f](docs/OPERATIONS.md)). | When you set it up |
| Anthropic (Claude Code) and OpenAI (Codex) | The agents | Use your own accounts if you continue with the agents. Codex works in its own clone, without any `.env` file or `golive-data/`. | When you need them |

`npm run ops:print-secrets` lists every GitHub Actions secret and variable. For each, it
shows where the value comes from and what breaks without it. [SECRETS-INVENTORY §2](docs/SECRETS-INVENTORY.md)
lists every runtime variable. `.env.example` holds the variable names with placeholder
values, although a few names are missing from it (AUDITOR-BRIEF §9).

Only some values are in the env files in the pack. The production file holds
`DATABASE_URL`, `DIRECT_URL`, `LOG_LEVEL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
`NEXT_PUBLIC_SENTRY_DSN`, `NODE_ENV`, the five `R2_*` values (`R2_ACCESS_KEY_ID`,
`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE`, `R2_SECRET_ACCESS_KEY`),
`SEED_ADMIN_PASSWORD`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`. The UAT file
holds the same names plus `AUTH_TRUST_HOST`, without `NEXT_PUBLIC_SENTRY_DSN`. Every other
value, including `CRON_SECRET`, `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN` and the
`BACKUP_AGE_*` secrets, has no copy in the local env files (`PRIVATE-HANDOVER.md` lists the
few that are kept elsewhere in the pack); the rest live only in Vercel and GitHub. Vercel
shows a value again unless it was saved as Sensitive; GitHub never shows a secret again. If no copy exists anywhere else, whoever holds those
accounts must generate a new value, which is a rotation.

## 5. Golden rules

These rules come from [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md). Most rows
name the incident that made the rule. The others say how to follow it.

| Rule | Why, or how |
|---|---|
| Never write to the production database. Its endpoint contains `ep-sweet-haze`. | If `prisma/seed-muscat-pilot.ts` ran on production, it would revive accounts that an operator had just deactivated, with passwords that are literals in that file. The one exception is the owner's grant to Claude. Under it, writes go only through operator scripts under `scripts/ops/`. Each runs as a dry run first, with `--expect-host ep-sweet-haze`, then with `--apply`, through `scripts/dev/prod-run.cjs` ([HANDOVER §5](docs/HANDOVER.md)). |
| `golive-data/` is customer PII and generated passwords. Never commit it, and never read it into a chat, a log or a screenshot. | It is gitignored. Before every commit, `git status --short \| grep -c golive-data` must print 0. |
| Never let a secret reach a log, a transcript or a screenshot. | A `node -e "…"` in double quotes once echoed part of a production role password, and the role had to be rotated. Put any code with quotes, backticks, `$` or regex backslashes in a `.cjs` file in a scratchpad directory **outside the repository**, never inside it or inside `golive-data/`. Run it with `node <file>`. Heredocs and `-e` also silently drop backslashes. |
| Merging to `main` deploys to production. | GitHub branch protection is not available on the current plan ([AUDITOR-BRIEF §10](AUDITOR-BRIEF.md)). Anyone with push rights can push to `main` and deploy. So `main` moves only after the owner's explicit "merge it", and only through the gates below. |
| Never run `npm run build`, any `npm run db:*` script, or `prisma migrate` / `prisma db` locally. | The build runs `prisma migrate deploy` **before** `next build`, against whatever `.env` names. A failed build can leave production migrated but not deployed. |
| Push a migration only when it is final. Never edit or rename a migration after you push it. | Every branch push builds a Vercel preview, and the preview applies that branch's migrations to UAT (AGENTS.md item 5). |
| A rollback does not undo a migration. | Vercel's instant rollback restores the app, not the schema. Never revert a migration casually. HANDOVER §2 step 8 says not without Claude. |
| Run `npm run typecheck` (not bare `tsc`), `npm run lint` and `npm test` before pushing. | Without `next typegen` first there are no route types, so a link to a page that does not exist passes. |
| Gate on CI's exit code for the **exact** commit: `bash scripts/dev/ci-watch-sha.sh <commit>`. | Chaining a push after a status check with `&&` or `;` once put a red commit on `main`. `gh run list --limit 1` can report the previous run when a push is still fresh. |
| Run `npm run smoke` before and after every production change. | Production once served a four-month-old build for weeks. |
| Write audit rows only through `writeAudit()` from `lib/audit.ts`. | ESLint enforces this. `tests/unit/audit-guard.test.ts` proves that the rule still runs, because a broken selector fails open. |
| Never reorder the content-security-policy (`lib/csp.ts`). | Next takes the nonce from the first directive that starts with `script-src`. If `script-src-elem` comes first, production renders a blank page. |
| Never relax the demo-account denylist (`lib/demo-accounts.ts`). Rename the account instead. | The Data Steward was once issued as `steward`, which production blocks. The load would have failed at sign-in. |
| `DATABASE_URL` is the app's pooled connection. `DIRECT_URL` is the owner connection, used for migrations and operator scripts. | The app is designed to run on the least-privilege `nmwc_app` role. Whether production uses it is recorded in `PRIVATE-HANDOVER.md`; switching is an owner-side action ([`docs/CREDENTIAL-ROTATION.md`](docs/CREDENTIAL-ROTATION.md) step 1). |
| Never assert a test fixture that reads the real clock against a literal. | A test stored the Oman weekday and asserted `'SUN'`. It was red every Sunday, and people re-ran it as a flake. |
| Prefer structural guard tests (`tests/unit/*-guard.test.ts`). Strip comments with `tests/support/strip-comments.ts` before asserting on source text. | Several defects were correct helpers that nothing called. A comment that quotes the asserted text makes a test pass or fail for the wrong reason. 11 test files still use a naive regex (AUDITOR-BRIEF §13). |
| Run an adversarial review after every substantial merge, including over your own work. | It has found real defects every time on this project. |
| When the record says something is the owner's decision, ask. Do not build it. | Per-account passwords were built against a standing instruction, then reverted. |
| Say what is not done. | A list where every row says "fixed" is a list nobody checked. |

These rules come from `AGENTS.md` and `docs/HANDOVER.md`:

- Never work in a checkout whose `.env` names production (AGENTS.md item 4).
- Never run `npm run format`, `prettier --write` or `eslint --fix` over existing files. The
  tree is not prettier-clean (AGENTS.md item 8).
- Run `node scripts/dev/leak-check.cjs` before committing documentation. By default it
  checks only `AUDITOR-BRIEF.md`, `AGENTS.md`, `docs/HANDOVER.md` and `docs/design/**`.
  Name any other files yourself, for example
  `node scripts/dev/leak-check.cjs HANDOVER-START-HERE.md docs/handover/*.md`. Git Bash
  expands the `*`. In PowerShell, list each file. The script looks only for known password
  literals, so read your diff as well. Changing its defaults is a Tier B change.
- Never delete a worktree under `.claude/worktrees/` on the owner's machine without asking
  the owner ([HANDOVER §3, §6.4](docs/HANDOVER.md)).

### If merging passes to you

Every merge needs an explicit "merge it" from whoever holds merge approval. Two routes are
recorded. Run every step on its own and read its exit code. Never chain steps with `&&` or
`;`.

**The route used since 2026-10-01.** Claude pushed the exact CI-green commit to `main`.
[03 §4](docs/handover/03-OPERATIONS-AND-DEPLOYMENT.md) has the full gates. In Git Bash,
with `<sha>` the full SHA of the PR head:

1. `bash scripts/dev/ci-watch-sha.sh <sha> <branch>` exits 0.
2. `gh api repos/rahmanmansoori244-droid/NMWC-CRM/compare/main...<sha> --jq .behind_by`
   succeeds and prints `0`. The repository has `allow_update_branch=false`, so a missing
   **Update branch** button proves nothing.
3. A Tier B PR also needs its reviewer's verdict on that exact commit. Today the reviewer
   is Claude.
4. Record the production baseline with `OLD=$(node scripts/dev/build-id.cjs)`, then run
   `npm run smoke`.
5. After the explicit yes, run `git push origin <sha>:refs/heads/main`. Never add
   `--force`. A rejected push means `main` moved, so start again at step 1.
6. `bash scripts/dev/deploy-watch.sh <sha> "$OLD"` must exit 0. It waits for the new
   build, runs smoke, and watches `main`'s CI, including `post-deploy-smoke`.

**The alternative in [HANDOVER §2](docs/HANDOVER.md), steps 6–8.** After steps 1–3, the
owner merges with **Rebase and merge** on GitHub. This creates new commits, so wait for CI
on the resulting `main` commit, including `post-deploy-smoke`. A missing or skipped smoke
job does not count as a pass.

**If `main`'s CI or post-deploy smoke goes red**, check the live build, smoke and
migration state. Only then choose between Vercel's instant rollback and a revert PR
([03 §6](docs/handover/03-OPERATIONS-AND-DEPLOYMENT.md)). If the deployed code is itself
faulty, use Instant Rollback in Vercel to the previous production deployment. The last
code batches contain no database migration. `PRIVATE-HANDOVER.md` names the deployments
to roll back to, in order.

## 6. Where to ask

- **The owner.** Ask about account access and anything private, and about business
  decisions until the owner names someone else for them in `PRIVATE-HANDOVER.md`.
  Contacts are in `PRIVATE-HANDOVER.md`. Do not re-ask a decision that is already recorded.
  Recorded decisions are in [HANDOVER §4](docs/HANDOVER.md) and AUDITOR-BRIEF §12.
- **The docs.** Follow the reading order in §3. For anything open, use
  [04-PENDING-WORK](docs/handover/04-PENDING-WORK.md). For what users report, use
  OPERATIONS §7a.
- **The knowledge graph** in [`graphify-out/`](graphify-out/). Read
  [08-KNOWLEDGE-GRAPH](docs/handover/08-KNOWLEDGE-GRAPH.md) first. The graph was rebuilt
  on 2026-10-04 from `main` at `9d0fd61`, from the tracked files only. It has 4,602
  nodes, 10,495 links and 226 clusters, and it covers the code and the documents, but not
  the PDFs and screenshots in `docs/guide/`.
  - **Start with [`graphify-out/wiki/index.md`](graphify-out/wiki/index.md).** It links
    one article per cluster and per highly connected node.
  - `GRAPH_REPORT.md` is the summary.
  - `graph.html` is an interactive map. It needs internet access, because it loads the
    vis-network library from unpkg.com.
  - `graph.json` is for the `graphify` command-line tool. Install the version the graph
    was built with: `uv tool install graphifyy==0.8.44`. 08 says how to query the graph.

  The graph is a map, not a source of truth. It shows what the stale role guides say, not
  what is true. Where the graph and the code differ, the code wins. Check the date at the
  top of `GRAPH_REPORT.md`. It should say 2026-10-04.
  **Before you commit a rebuilt graph**, build it from a clean export of the tracked
  files, as 08 shows. A `git archive` export holds tracked files only, so it cannot
  include `.env` files, `golive-data/` or `.claude/`, which `.gitignore` excludes, or
  anything else untracked, such as the pack. Then search every output file for absolute
  paths, and run leak-check on the outputs. In Git Bash:
  `node scripts/dev/leak-check.cjs graphify-out/*.md graphify-out/*.json graphify-out/.graphify_labels.json graphify-out/graph.html graphify-out/wiki/*.md`.
  The copies committed before the rebuild, which are still in the history, held absolute
  paths from the owner's computer.
- **The history.** The commit messages here are detailed (`git log`). The pack holds the
  app's official exports of all three NMWC CRM chat sessions (the conversation, the
  sub-agent transcripts and the metadata). It also holds the raw Claude Code project
  folders for those sessions (the `*.jsonl` transcripts, sub-agent and workflow
  transcripts, and tool results) and Claude's memory. Codex's own history (`~/.codex`,
  about 4 GB, which also holds the owner's personal OpenAI sign-in) is not in the pack.
  Codex's private notes are in the pack's private backups folder (`NMWC-Private-Backups`).
  All of this may hold production figures, customer details and paths from the owner's
  computer, so treat it like the `.env` files.
- **Claude Code in this repository.** It loads `CLAUDE.md` automatically. Give it the
  handover set and ask. 08 suggests pointing it at `graphify-out/wiki/index.md` first.

## 7. Not settled by this handover

- **Credential rotation.** The procedure is in
  [CREDENTIAL-ROTATION](docs/CREDENTIAL-ROTATION.md). When you rotate, do it last, after
  the functional work (AUDITOR-BRIEF §12). The current status is in `PRIVATE-HANDOVER.md`.
- **The backup decryption key.** Until the owner has done one of the two steps in the
  accounts table (§4), nobody else can decrypt any nightly dump.
- **Claude's production permission.** It ends on the date recorded in
  `PRIVATE-HANDOVER.md`. After that, you decide.
- **Merge approval and product authority.** Who approves merges, and who makes product and
  business decisions after the handover, are for you and the owner to agree. The owner
  records them in `PRIVATE-HANDOVER.md`. Until someone is named there, both stay with the
  owner.
- **The user guides.** Whether the 2026-10-04 guide set replaces `docs/guide/`, after a
  leak review, is open ([04-PENDING-WORK](docs/handover/04-PENDING-WORK.md)).
- **A second holder.** [SECRETS-INVENTORY §4](docs/SECRETS-INVENTORY.md) describes the
  risk of one person holding every credential. Once the accounts are yours, decide who
  backs you up.
- **The open items.** They are listed in [04-PENDING-WORK](docs/handover/04-PENDING-WORK.md)
  and [HANDOVER §6](docs/HANDOVER.md).
