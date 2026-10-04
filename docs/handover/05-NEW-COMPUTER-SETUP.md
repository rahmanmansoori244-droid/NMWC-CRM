# 05 — Setting up a new computer

This page takes you from a clean computer to a working NMWC CRM setup. The owner worked
on Windows, so Windows comes first. Notes for macOS and Linux follow where they differ.

**This file is public.** It names files, folders and variables. It holds no values.
Everything private is in the private handover pack (PRIVATE-HANDOVER.md).

**Steps marked [SECRETS] touch secrets or customer data.** Do them alone, on your own
screen: no screen share, no screenshot, and no AI chat that can see the output. The
reason is in [CLAUDE.md](../../CLAUDE.md), under "Never let a secret reach a log, a
transcript or a screenshot".

**Shells.** Commands are written for Git Bash on Windows, or a macOS/Linux terminal,
unless marked PowerShell. In Windows PowerShell, type `npm.cmd` and `npx.cmd`, not `npm`
and `npx` (§3).

---

## The short version

1. Use a fresh clone plus the private pack. Do not copy the old project folder (§1).
2. Owner only, on the old computer: check that no work and no private file exists only
   in a place the move would miss, and settle the backup decryption key (§2).
3. Install the prerequisites and protect the disk (§3).
4. Clone into a local folder that is not synced, then run `npm ci` (§4).
5. **[SECRETS]** Open the pack (§5).
6. **[SECRETS]** Put each part of the pack where it belongs (§6).
7. Set up worktrees the safe way (§7).
8. Verify: env check, typecheck, lint, a few tests, smoke (§8).
9. Read the "never do this" list before you run anything else (§10).

---

## 1. Use a fresh clone, not a copy of the old folder

**Recommendation: clone the repository fresh from GitHub, then add the private parts from
the pack.** Do not copy the owner's project folder to the new computer.

| If you copy the whole old folder | With a fresh clone + the pack |
|---|---|
| You also copy the owner's main-checkout `.env`, which points at **production** ([HANDOVER.md §3](../HANDOVER.md)), and its `.env.local`, which does too ([CREDENTIAL-ROTATION.md, Step 3](../CREDENTIAL-ROTATION.md)). Anything you run there talks to production. | You choose each env file on purpose and check it first (§6.1). |
| `node_modules` holds binaries built for the old computer (the Prisma engine, for example). It is also very large. | `npm ci` installs the right ones from `package-lock.json`. |
| Git worktrees store absolute paths. Worktrees under `.claude/worktrees/` break when the folder moves. Codex's worktrees, and some temporary ones, lived outside the folder entirely, so they would not come with it. Some worktrees have a `node_modules` junction that points at a path on the old computer. | You create the worktrees you need (§7). |
| Leftovers come too: `.next/`, `tsconfig.tsbuildinfo`, `playwright-report/`, `test-results/`, `sigpipetest/`, graphify caches, and possibly database dump files. | Nothing that is not tracked comes with it. |
| `golive-data/` (customer data and generated passwords) is spread wherever the copy lands. | `golive-data/` goes to exactly one place (§6.2). |

### If you must copy the folder anyway

- Leave out what is rebuilt or not needed: `node_modules/`, `.next/`, `.claude/worktrees/`,
  `tsconfig.tsbuildinfo`, `playwright-report/`, `test-results/`, `sigpipetest/`,
  `graphify-corpus/`, `graphify-out/cache/`, `graphify-out/.graphify_python` and
  `graphify-out/.graphify_root`.
- **[SECRETS]** Leave out what must not travel this way:
  - `golive-data/`. It comes from the pack and lives in one place (§6.2).
  - `.env`, `.env.local` and any `.env.*.local`. Place fresh ones from the pack (§6.1).
  - Any `*.sql`, `*.sql.gz` or `*.sql.gz.age` file in the root. These are dump files from
    testing the backup pipeline, and they can hold customer data.
- Everything in both lists is gitignored ([.gitignore](../../.gitignore)).
- On the new computer, run `git worktree prune` (and `git worktree repair` for any
  worktree you did copy), then `npm ci`.
- **[SECRETS]** Before you run anything else, check every env file in the folder (§6.1).
  Assume an env file is production until `env-check.cjs` says otherwise.

---

## 2. Before the move (owner, on the old computer)

The pack carries private files. It does not carry unpushed git work. Three checks:

```bash
git worktree list                              # every working copy, including ones outside the project folder
git log --branches --not --remotes --oneline   # local commits that are on no remote
git stash list                                 # the stash is shared by every worktree
```

- For each path that `git worktree list` prints, `git -C <path> status --short` shows
  uncommitted work. Check the ones outside the project folder too (Codex's and temporary
  ones).
- GitHub's **Rebase and merge** creates new commits ([HANDOVER.md §2](../HANDOVER.md)), so
  the commits of a PR merged that way also show up as "on no remote". A PR merged by
  pushing its exact CI-green commit to `main` (how approved merges were done since
  2026-10-01, [03 §4](03-OPERATIONS-AND-DEPLOYMENT.md)) keeps its hashes and does not show
  up. Compare with the merged PRs before pushing anything. Push only review branches,
  never `main`. Write anything left unpushed into PRIVATE-HANDOVER.md.
- Do not delete worktrees to tidy up before the move. No worktree under
  `.claude/worktrees/` is removed without the owner's say ([HANDOVER.md §3 and
  §6.4](../HANDOVER.md)), and one may hold the only copy of something.
- **[SECRETS]** Pack `golive-data/` from where it actually lives. It may sit inside a
  worktree rather than in the main checkout root ([HANDOVER.md §3](../HANDOVER.md) says
  "ask the owner where"). A pack built from the main checkout alone would miss it.
- In every checkout you commit from, confirm `golive-data/` is not in git:
  `git status --short | grep -c golive-data` must print `0`
  ([CLAUDE.md](../../CLAUDE.md), "golive-data/ is customer PII").
- **[SECRETS] The backup decryption key comes first.** The `age` private identity that
  decrypts the nightly encrypted database dumps was not found on the owner's computer and
  is not in the pack, and GitHub's `BACKUP_AGE_IDENTITY` secret cannot be read back.
  Without it no dump can be decrypted by anyone else. Before handing over, the owner either
  puts a copy in the pack, or adds the new person's `age` recipient
  ([02 §2.10](02-ACCESS-ACCOUNTS-AND-SECRETS.md)) and proves one decrypt (§6.3).

---

## 3. Prerequisites

| Tool | Version / note | Why you need it | Where the repo says so |
|---|---|---|---|
| **Node.js** | **22**. There is no `.nvmrc` and no `engines` field. CI uses Node 22. Vercel runs Node 24. Use a recent Node 22 release to match CI. | Everything | [ci.yml](../../.github/workflows/ci.yml) (`node-version: '22'`); [OPERATIONS.md §11](../OPERATIONS.md) |
| **npm** | Comes with Node. Always `npm ci`, which installs exactly what the lockfile says. | Install | [package-lock.json](../../package-lock.json) |
| **Git** | On Windows, install Git for Windows. It includes Git Bash. | Clone, branches, worktrees | — |
| **Git Bash** (Windows only) | Comes with Git for Windows. Leave it next to `git`. It also includes `gpg`, GNU `tar` and `sha256sum` (§5). | `npm test` runs one CI step in the `bash.exe` found beside `git`, and fails without it. The `scripts/dev/*.sh` helpers are bash. | [tests/support/workflow-step.ts](../../tests/support/workflow-step.ts) (`resolveBash`); [scripts/dev/ci-watch-sha.sh](../../scripts/dev/ci-watch-sha.sh) |
| **GitHub CLI (`gh`)** | Signed in with your own account. | CI checks on an exact commit, and the "is the branch up to date" check before a merge. | [AGENTS.md](../../AGENTS.md) "When you finish a task"; [scripts/dev/ci-watch-sha.sh](../../scripts/dev/ci-watch-sha.sh) |
| **GnuPG (`gpg`)** | Included in Git for Windows (Git Bash). On macOS `brew install gnupg`, on Linux the `gnupg` package. | Opening the private pack (§5) | `HOW-TO-OPEN.txt`, next to the pack |
| Playwright Chromium (optional) | Install after `npm ci` (§9). | `npm run test:e2e` and the user-guide builds | [playwright.config.ts](../../playwright.config.ts); [ci.yml](../../.github/workflows/ci.yml) |
| Python + uv (optional) | Only for rebuilding or querying the graphify knowledge graph (§9). Install the tool with `uv tool install graphifyy==0.8.44`. | `graphify-out/` | [08-KNOWLEDGE-GRAPH.md](08-KNOWLEDGE-GRAPH.md) |
| `psql`, `age`, `shred` (optional) | Only if you will restore a database backup. `age-keygen` also makes the key pair whose public half you give the owner for the backups (§6.3). | Backup restore runbooks | [OPERATIONS.md §6.5](../OPERATIONS.md); [02 §2.10](02-ACCESS-ACCOUNTS-AND-SECRETS.md) |
| Claude Code / Codex (optional) | Only if you will work with an AI agent. The rules they follow come with the repo. | — | [CLAUDE.md](../../CLAUDE.md), [AGENTS.md](../../AGENTS.md) |

**Protect the disk.** This computer will hold production credentials and customer data.
Anyone with the machine that holds the production `DIRECT_URL` holds the database owner
role ([SECRETS-INVENTORY.md §3](../SECRETS-INVENTORY.md)). Turn on full-disk encryption
(BitLocker on Windows, FileVault on macOS) and a screen lock before §5.

**Windows PowerShell:** type `npm.cmd` and `npx.cmd`, not `npm` and `npx`. The execution
policy blocks `npm.ps1` ([HANDOVER.md §8](../HANDOVER.md)), and `npx.ps1` sits beside it
and is blocked the same way. Git Bash takes plain `npm` and `npx`.

---

## 4. Clone and install

**Where to clone.** Use a local folder that no sync service sees, on the encrypted disk.
For example `C:\dev\NMWC-CRM` on Windows, or `~/dev/NMWC-CRM` on macOS and Linux. On
Windows, avoid Desktop and Documents: on many computers those folders are redirected into
OneDrive. This clone will hold the UAT `.env` and `golive-data/` (§6), and anything in a
synced folder is uploaded.

Clone into the **final** folder. The Claude Code memory folder name depends on this path
(§6.4).

The repository is public, so cloning needs no login.

```bash
git clone https://github.com/rahmanmansoori244-droid/NMWC-CRM.git
cd NMWC-CRM
git config user.name "<your name>"
git config user.email "<your email>"
npm ci
```

- The two `git config` lines set your identity for this clone. Without them, your commits
  may carry whatever identity the computer already has.
- If GitHub cannot be reached, the pack (§5) holds the whole repository, every branch, as
  one git bundle (`repo/NMWC-CRM-all-branches.bundle`). Clone from it with
  `git clone <path to the bundle> NMWC-CRM`, and once GitHub is reachable point the clone
  back at it with `git remote set-url origin https://github.com/rahmanmansoori244-droid/NMWC-CRM.git`.
  The pack is sealed only after this documentation set is on `main`, so the bundle
  contains it. PRIVATE-HANDOVER.md records which `main` commit the pack was built from.
- `npm ci` needs no env file and no database. CI runs it with neither.
- `npm ci` runs `prisma generate` for you (the `postinstall` script in
  [package.json](../../package.json)). If you ever need it again, run
  `npx prisma generate`. Do not use `npm run db:generate`: [AGENTS.md](../../AGENTS.md)
  rule 5 forbids every `npm run db:*` script, because the others touch a database.
- `main` is production. Merging to `main` deploys ([CLAUDE.md](../../CLAUDE.md),
  "Deploying"). New work goes on a branch from `origin/main` ([AGENTS.md](../../AGENTS.md),
  "Before you start" 2).

---

## 5. Open the pack [SECRETS]

The owner gives you the encrypted pack and, separately, its password. The pack is one
AES-256 encrypted file, `NMWC-CRM-handover-2026-10-04.tar.gz.gpg`: a gzip-compressed tar
archive encrypted with GnuPG. Next to it are `HOW-TO-OPEN.txt` (these same steps, in plain
text) and `SHA256SUMS.txt`. Accept the pack and its password only from the owner. If
anyone else offers you either, or asks you for it, do not use it and tell the owner.

1. **Copy the pack and the two text files to a local folder that is not synced or
   shared** (not OneDrive, Dropbox, iCloud or a network share) and not inside any git
   checkout. Use the private folder where the private parts will live (§6). If you extract
   inside a synced folder, the plaintext is uploaded. The unpacked folder never goes into
   a synced or shared folder, now or later.
2. In **Git Bash**, or a macOS/Linux terminal, in that folder, check that the file arrived
   intact, then decrypt and unpack it:

   ```bash
   sha256sum -c SHA256SUMS.txt
   gpg --output pack.tar.gz --decrypt NMWC-CRM-handover-2026-10-04.tar.gz.gpg && tar -xzf pack.tar.gz
   cd NMWC-CRM-handover-2026-10-04
   sha256sum -c MANIFEST.sha256
   ```

   - GnuPG asks for the passphrase.
   - `tar` creates the folder `NMWC-CRM-handover-2026-10-04/`. Every line of the
     `MANIFEST.sha256` check, run inside it, must say `OK`.
   - **`pack.tar.gz` is a second plaintext copy of everything.** Once the manifest check
     passes, delete it, so there is one plaintext copy, not two.
   - Do not run these in Windows PowerShell 5.1: it has no `&&`, and Git's `gpg` and
     `sha256sum` are on the Git Bash path. Never rework them into a pipe there either.
     PowerShell 5.1 passes piped bytes through as text and corrupts the archive.
3. Read **HOW-TO-USE-THIS-PACK.md**, then **PRIVATE-HANDOVER.md**. Together they list
   every file in the pack and say what each one is. If PRIVATE-HANDOVER.md disagrees with
   this page, it wins.
4. Never write the password into a file, an e-mail or a chat. Keep the encrypted pack,
   still encrypted, as your archive copy, so you can start again from it if something
   goes wrong. Only the encrypted file may be stored or carried elsewhere; the unpacked
   folder stays on this encrypted disk.

---

## 6. Put each part where it belongs [SECRETS]

| Part of the pack | Where it goes | Contains |
|---|---|---|
| The **UAT** env file | `.env` in the root of your working clone, and in each worktree (§6.1) | Secrets for the UAT database and services. Protect it like the production file (§6.1). |
| The **production** env files (copies of the owner's main-checkout `.env` and `.env.local`; both point at production) | A private folder **outside every git checkout** (§6.1) | The production owner credential |
| `golive-data/` | The root of the one clone you run operator scripts from (§6.2) | Customer data and generated passwords |
| Private backups folder (`NMWC-Private-Backups/`) | A private folder outside every checkout (§6.3) | Customer data, and Codex's private notes (§6.5) |
| Source spreadsheets and exports | A private folder outside every checkout (§6.3) | Customer data |
| Operator scripts copied by the owner | A private scratch folder outside every checkout. Read each one before running it; to run one, copy it into the checkout as `<name>.tmp.ts` (§6.3). | Possibly production procedures |
| User guides (PDF, English and Arabic) | A private folder (§9) | The 2026-10-04 guide set, newer than `docs/guide/` |
| Claude Code memory | `~/.claude/projects/<key>/memory/` (§6.4) | Private project notes, including the owner's production-write permission for Claude, with its end date |
| Chat history: the app's exports of the three NMWC CRM sessions, and the raw Claude Code project folders for them (with Claude's workflow scripts) | A private folder, for reading (§6.5) | Anything, possibly secrets |
| The repository bundle | Only if GitHub cannot be reached (§4) | The code, every branch |

Apart from the repository bundle, which is the public code, nothing in this table ever
goes to GitHub.

### 6.1 Env files [SECRETS]

The variable names are in [.env.example](../../.env.example) and
[SECRETS-INVENTORY.md §2](../SECRETS-INVENTORY.md). The values are in the pack.
PRIVATE-HANDOVER.md says which env file points at which database.

**The one rule that matters most:** on the owner's computer, the `.env` in the main
checkout points at **PRODUCTION** ([HANDOVER.md §3](../HANDOVER.md);
[AGENTS.md](../../AGENTS.md), "Before you start" 4), and so does its `.env.local`
([CREDENTIAL-ROTATION.md, Step 3](../CREDENTIAL-ROTATION.md)). So any seed, test or
`npm run dev` started there goes to production. Claude's operator runs on that computer
pass the file explicitly:
`NMWC_PROD_ENV_FILE=<main checkout>/.env node scripts/dev/prod-run.cjs …`. Do not rebuild
that layout on the new computer: keep the production file outside every checkout, and
still pass it explicitly.

**What the env files hold, and what they do not** (names only;
[02 §3](02-ACCESS-ACCOUNTS-AND-SECRETS.md) has the detail):

- The **production** files (the main checkout's `.env` and `.env.local`): `DATABASE_URL`,
  `DIRECT_URL`, `LOG_LEVEL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_SENTRY_DSN`,
  `NODE_ENV`, `R2_ACCESS_KEY_ID`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE`,
  `R2_SECRET_ACCESS_KEY`, `SEED_ADMIN_PASSWORD`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
  `SENTRY_PROJECT`.
- The **UAT** file (a worktree's `.env`): the same names, plus `AUTH_TRUST_HOST`, minus
  `NEXT_PUBLIC_SENTRY_DSN`.
- **In no local env file:** `CRON_SECRET`, `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN`,
  the `BACKUP_AGE_*` values and the other values that exist only in Vercel and GitHub
  ([02 §2.2 and §2.3](02-ACCESS-ACCOUNTS-AND-SECRETS.md)). Vercel's sensitive variables
  and GitHub's secrets cannot be read back. If no copy exists elsewhere, the value must be
  regenerated, which is a rotation, by whoever holds those accounts.

**Protect the UAT file exactly like the production one.** "UAT" does not mean "harmless".
Neon branches share the owner role's password, so UAT changes with it
([SECRETS-INVENTORY.md §5](../SECRETS-INVENTORY.md)). Never show the UAT file to an AI
chat, a screen share or a screenshot either.

**Recommended layout:**

- **Working clone `.env` = UAT.** Prisma's CLI, [scripts/qa/run-with-env.mjs](../../scripts/qa/run-with-env.mjs)
  and [scripts/dev/env-check.cjs](../../scripts/dev/env-check.cjs) all read `.env`.
- **Production env file = outside every checkout.** It is used only through
  [scripts/dev/prod-run.cjs](../../scripts/dev/prod-run.cjs), which takes its path from
  `NMWC_PROD_ENV_FILE`, refuses a file that is not production, and masks the connection
  string in everything it prints ([HANDOVER.md §5](../HANDOVER.md)). Always set
  `NMWC_PROD_ENV_FILE`: without it, `prod-run.cjs` reads `./.env`. If the file is never
  inside a checkout, nothing loads it by accident.

**How to read `env-check.cjs`.** It prints a verdict for `DATABASE_URL` and `DIRECT_URL`,
once for the file and once for your shell's environment, and never a value. Read every
line, not only the last one:

| Line | A UAT file | The production file |
|---|---|---|
| `env file: …` | The path you meant, **not** ending in `(missing)` | The path you meant, **not** ending in `(missing)` |
| `DATABASE_URL (file)`, `DIRECT_URL (file)` | `not production` on both | `PRODUCTION` (at least for `DIRECT_URL`) |
| `DATABASE_URL (environment)`, `DIRECT_URL (environment)` | `not set` | `not set` |
| Last line, and exit code | `ok: nothing here points at production.`, exit 0 | `STOP: something here points at production.`, exit 1 |

- **`ok` on its own proves nothing.** The script also prints `ok` and exits 0 when the
  file is missing, or holds neither variable. Then the first line ends in `(missing)`, or
  the file lines say `not set`. Treat either as a failure: the path is wrong, or it is the
  wrong file.
- If an `(environment)` line says anything but `not set`, your shell has that variable
  set. `run-with-env.mjs` lets the shell's value win over the file. Clear it before you go
  on.
- For the production file, `STOP` and exit 1 are expected. They tell you which file it is.

**Steps:**

1. **Check each env file before you place it.** Run this from the clone root:

   ```bash
   node scripts/dev/env-check.cjs <path to the env file>
   ```

2. Copy the UAT file to `.env` in the clone root. `.env`, `.env.local` and `.env.*.local`
   are gitignored ([.gitignore](../../.gitignore)), so git will not pick it up.
3. Run `node scripts/dev/env-check.cjs` with no argument, in the clone root. It checks
   `./.env`. The `env file:` line must not say `(missing)`, both `(file)` lines must say
   `not production`, and the last line must be `ok: nothing here points at production.`
4. **Do not create a `.env.local` with production values.** Next.js loads `.env.local`
   ahead of `.env`, so it would quietly win over a UAT `.env` when you run `npm run dev`.
   [scripts/print-required-secrets.ts](../../scripts/print-required-secrets.ts) also loads
   `.env.local` first. If a `.env.local` exists, check it:
   `node scripts/dev/env-check.cjs .env.local`.
5. **Never put secrets in `.env.development` or `.env.production`.** Next.js loads those
   names too, and `.gitignore` does not cover them. A `git add` would pick them up.
6. Never print an env file to a terminal: no `cat`, `type`, `grep` or `Select-String`.
   They print the whole line, password included ([AGENTS.md](../../AGENTS.md), "Before
   you start" 4). Edit it in an editor, alone.

**[README.md](../../README.md) and `.env.example` say otherwise. This page wins.** The
README's quick start runs `npm install` and copies `.env.example` to `.env.local`, and the
header of `.env.example` says the same. Use `npm ci`, and name the file `.env`: the safety
tools check `.env`. The README's Scripts table also lists `npm run build` and
`npm run db:migrate` with no warning. Never run either (§10).

### 6.2 `golive-data/` [SECRETS — customer data and generated passwords]

- Put it in **one** place: the root of the clone you run operator scripts from, named
  exactly `golive-data/`. The scripts default to that path, relative to where you run
  them ([scripts/golive/build-masters.ts](../../scripts/golive/build-masters.ts),
  [scripts/golive/verify-credentials.ts](../../scripts/golive/verify-credentials.ts),
  [scripts/ops/verify-load.ts](../../scripts/ops/verify-load.ts)). `build-masters.ts` and
  `verify-load.ts` also accept `GOLIVE_DIR` to point somewhere else. `verify-credentials.ts`
  takes the folder as its argument.
- Check that git ignores it:
  - `git check-ignore -v golive-data` should print the `/golive-data/` rule.
  - Before every commit, `git status --short | grep -c golive-data` must print `0`. In
    PowerShell, use `git status --short | Select-String golive-data`, which must print
    nothing.
- **Scripts may read it. People and transcripts may not** ([CLAUDE.md](../../CLAUDE.md)).
  Do not open its files in an AI session, and do not paste from them anywhere. Coding
  agents must never open, list or copy it ([AGENTS.md](../../AGENTS.md) rule 7).
- If `golive-data/account-master.xlsx` exists, one unit test reads its Routes sheet as a
  staleness check
  ([tests/unit/golive-route-names-guard.test.ts](../../tests/unit/golive-route-names-guard.test.ts)).
  So a full `npm test` in that clone touches the folder. The gated `golive-rehearsal`
  integration suite reads it too.
- You should not need to rebuild it. If you do, read
  [GO-LIVE-RUNBOOK.md](../GO-LIVE-RUNBOOK.md) first. `build-masters.ts` finds its source
  files through a `DESKTOP` constant that points at the owner's old computer. Override
  each source with its env var: `RP_CUSTOMERS`, `RP_CREDIT`, `CRM_TERMS`, `RP_ROUTES`,
  `JP_MASTER`, `TEMIX_RAW`, `CODE_BRANCH`, `DASH_DB`, `TODAY_UPLOAD`, and `GOLIVE_DIR` for
  the output. A rebuild moves the previous files aside and does not overwrite them (see
  the header of that file).

### 6.3 Private backups, source files and operator scripts [SECRETS]

- Keep all three **outside every git checkout**, on the encrypted disk. They hold
  customer data.
- **Source spreadsheets and exports** (RoutePro, Temix, journey plans, the sales dashboard
  database) are what `build-masters.ts` reads. Point it at them with the env vars in
  §6.2. [HANDOVER.md §3](../HANDOVER.md) says they are read-only.
- **The private backups folder** (`NMWC-Private-Backups/`) holds data the owner exported
  from production, and Codex's private notes. PRIVATE-HANDOVER.md says what each file is.
- **Operator scripts copied by the owner, and read scripts you write yourself:** keep them
  in a private scratch folder outside every checkout, and read each one before running
  it. A script usually imports the repository's packages (`@prisma/client`, for example),
  and `tsx` resolves those only from inside a checkout. So to run one, copy it into the
  root of the checkout as `<name>.tmp.ts`, run it with
  `NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs <name>.tmp.ts`, then
  delete the copy. `*.tmp.ts` is gitignored ([.gitignore](../../.gitignore)), so
  `git add` does not pick such a copy up, but delete it after use anyway and check
  `git status --short` before any commit. Anything that writes to production follows the
  `scripts/ops/` convention ([HANDOVER.md §5](../HANDOVER.md)):
  - a dry run by default, with `--expect-host ep-sweet-haze` even for the dry run;
  - `--apply` to write, with `--actor <steward username>`, which some scripts require and
    which is needed wherever more than one Steward exists;
  - counts-only output, and a second dry run that reports nothing left;
  - run through `prod-run.cjs`, which passes the arguments on:
    `NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs <script> [args]`
    (PowerShell: `$env:NMWC_PROD_ENV_FILE='<env file>'; node scripts/dev/prod-run.cjs <script> [args]`).
  - **Never put `DIRECT_URL=…` on a command line**, even though the headers of scripts
    such as [rescore-completeness.ts](../../scripts/ops/rescore-completeness.ts) show that
    form ([HANDOVER.md §5](../HANDOVER.md)).
  - `npm run smoke` before and after ([CLAUDE.md](../../CLAUDE.md), "Deploying").
- **Nightly database backups** are encrypted with `age`. Reading one needs the backup age
  private key (the `age` identity). It is the one secret that cannot be re-issued
  ([OPERATIONS.md §6.7](../OPERATIONS.md); [SECRETS-INVENTORY.md §3](../SECRETS-INVENTORY.md)).
  **It is not in the pack.** It was not found on the owner's computer, and GitHub's
  `BACKUP_AGE_IDENTITY` secret cannot be read back. Without it no dump can be decrypted by
  anyone else. It is the owner's first action before handing over (§2): put a copy in the
  pack, or add your `age` recipient (make the key pair with `age-keygen`; the steps are in
  [02 §2.10](02-ACCESS-ACCOUNTS-AND-SECRETS.md)) and prove one decrypt.

### 6.4 Claude Code memory

Claude Code keeps notes for each project under your home folder, in
`~/.claude/projects/<key>/memory/`. The index file is `MEMORY.md`. Claude reads it at
the start of every session in that project. The owner's memory for this project is in the
pack, in `claude/memory/`.

**Why copying it is not enough:** `<key>` is the absolute path of the folder Claude Code
is opened in, with every character that is not a letter or a digit replaced by `-`
(`.` included). For example:

| Folder Claude Code is opened in | Memory folder |
|---|---|
| `C:\Users\x\Desktop\NMWC-CRM` | `~/.claude/projects/C--Users-x-Desktop-NMWC-CRM/memory/` |
| `D:\work\NMWC-CRM` | `~/.claude/projects/D--work-NMWC-CRM/memory/` |
| `/home/sam/NMWC-CRM` | `~/.claude/projects/-home-sam-NMWC-CRM/memory/` |

A new computer means a new path, so a new folder name.

**Moving it to the new path:**

1. Clone into the final folder first (§4). Moving the clone later changes the name again.
2. Start Claude Code in the clone root, send one short message, then exit. Look in
   `~/.claude/projects/` for the folder it just created. The folder may not appear until
   a session has been saved, which is why you send a message first.
3. Copy the contents of the pack's `claude/memory/` folder into it, so that
   `~/.claude/projects/<that folder>/memory/MEMORY.md` exists.
4. **Before your first real session, review the notes** (step 6). Then start a new session
   and ask Claude what its memory index says. This confirms it was picked up.
5. If Claude does not see it, compare the folder name with the rule above and check
   §12.
6. **What to review:**
   - The notes name the owner's old paths and worktrees, including where the owner kept
     the production env file. Those paths do not exist on your computer. Correct them, or
     Claude will look for files that are not there.
   - One note (`prod-write-permission.md`) records the owner's standing permission for
     Claude to write to production through operator scripts, the permission recorded in
     [HANDOVER.md §4](../HANDOVER.md). Copied into your setup, Claude will read that note
     and act on it. It was updated on 2026-10-04 to the terms recorded in
     PRIVATE-HANDOVER.md, so restoring it as it is is fine. **The permission ends on the
     date recorded in PRIVATE-HANDOVER.md; after that the decision is yours, as the new
     person:** keep, change or delete the note.
   - Edit or delete any other note that should not carry over.

Notes:

- In the owner's setup, sessions started inside `.claude/worktrees/<name>` used the main
  clone's memory folder, while each worktree got its own transcript folder (for
  `D:\work\NMWC-CRM\.claude\worktrees\topic` that is
  `~/.claude/projects/D--work-NMWC-CRM--claude-worktrees-topic/`). That was observed, not
  documented, so check it on your version.
- The memory holds production details. Never commit it, and never copy it into the repo.
- The project's working rules are not in the memory. They are in
  [CLAUDE.md](../../CLAUDE.md) (for Claude) and [AGENTS.md](../../AGENTS.md) (for Codex
  and other agents), and they come with the clone. A test keeps the two in step
  ([tests/unit/agents-md-guard.test.ts](../../tests/unit/agents-md-guard.test.ts)).

### 6.5 Chat transcripts and Codex history [SECRETS]

- **The pack holds the whole Claude chat history of the three NMWC CRM sessions, in two
  forms:**
  - the app's official exports, one per session: the conversation, the sub-agent
    transcripts and the metadata;
  - the raw Claude Code project folders for those sessions, packed whole under
    `claude/raw-transcripts/`: the `.jsonl` transcripts, every sub-agent and workflow
    transcript, the saved tool results, and the scripts of Claude's multi-agent
    workflows, in `claude/raw-transcripts/<project folder>/<session id>/workflows/scripts/`.
- Claude Code saves each session as a `.jsonl` file in `~/.claude/projects/<key>/`
  (§6.4). There is **one such folder for every folder a session started in**: the main
  clone, each `.claude/worktrees/<name>`, and other folders. So the raw copy holds several
  project folders, not one. PRIVATE-HANDOVER.md lists them.
- They are for reading and searching, not for restoring. Read them in a text editor, any
  JSONL viewer or any text-search tool. They do not have to be under `~/.claude` to be
  read. Keep them in your private folder.
- **The owner also worked with Codex** (on `codex/*` branches). Codex keeps its own
  history in `~/.codex`, outside this project folder and outside `~/.claude`. **That
  history is not in the pack:** it is about 4 GB and also holds the owner's personal
  OpenAI sign-in. Codex's private notes are in the pack, inside `NMWC-Private-Backups/`
  (§6.3).
- **Treat all of it as secret.** CLAUDE.md records a session that echoed part of a
  production role password into a transcript. Never upload, paste from or commit any of
  it.

---

## 7. Worktrees

**Convention.** Keep one main clone. Extra working copies are git worktrees under
`.claude/worktrees/<name>/` inside it. The `.claude/` folder is gitignored, and Claude Code
creates its worktrees there. Codex worked in separate clones or worktrees of its own, without
any `.env` file or `golive-data/`; it never merges or pushes `main` ([HANDOVER.md §2](../HANDOVER.md)).

**Create one:**

```bash
git fetch
git worktree add .claude/worktrees/<topic> -b <branch> origin/main
```

Codex branches are named `codex/<topic>` ([AGENTS.md](../../AGENTS.md), "Before you start"
2). The owner's Claude sessions used `claude/<topic>`.

Each worktree needs its own **UAT** `.env` (check it with `env-check.cjs`, §6.1) and its
own `npm ci`.

**Never remove a worktree whose `node_modules` is a junction or symlink into another
checkout.** On Windows, `git worktree remove --force` follows a `node_modules` junction and
deletes everything inside the target. On 2026-10-01 this emptied another checkout's
`node_modules` in the middle of a review (owner's private notes). Do it in this order:

1. Remove the junction itself first. In PowerShell: `cmd /c rmdir <worktree>\node_modules`.
   A Git Bash `rm` of a junction once failed silently.
2. Check that `Test-Path <worktree>\node_modules` prints `False`.
3. Check that `git -C <worktree> status --short` is empty and the branch is pushed.
4. Only then run `git worktree remove <worktree>`.

If you find a `node_modules` emptied, run `npm ci --prefer-offline` in that checkout, then
`npx prisma generate`.

---

## 8. Verify the setup

Run these in the clone root, in this order. Stop at the first failure. In PowerShell,
type `npm.cmd` and `npx.cmd` (§3).

| # | Command | You should see | Notes |
|---|---|---|---|
| 1 | `node scripts/dev/env-check.cjs` | `env file:` with no `(missing)`; both `(file)` lines `not production`; then `ok: nothing here points at production.` and exit 0 | **[SECRETS]** It reads `.env` but prints no value. `ok` alone is not enough (§6.1). Run it before anything that loads `.env`. |
| 2 | `npm run typecheck` | Exit 0 | It runs `next typegen` first. Bare `npx tsc --noEmit` misses route types ([CLAUDE.md](../../CLAUDE.md)). |
| 3 | `npm run lint` | Exit 0 | — |
| 4 | `npx vitest run tests/unit/csp.test.ts tests/unit/agents-md-guard.test.ts tests/unit/secrets-inventory.test.ts tests/unit/audit-guard.test.ts` | All pass | A few quick guards. No database, no network. |
| 5 | `npm test` (optional, long) | The unit suite passes. The integration suites report as skipped. | Each integration suite skips itself unless its own `RUN_*` flag and `DATABASE_URL` are set (for example [tests/integration/build-chain-data.test.ts](../../tests/integration/build-chain-data.test.ts)). [vitest.config.ts](../../vitest.config.ts) only runs files one at a time when a `RUN_*` flag is set. See the Windows notes below. |
| 6 | `npm run smoke` | Every line `PASS`, then `all … checks passed`, exit 0 | Read-only GETs against **production**, plus one POST that must be refused. No credentials, no database ([scripts/ops/smoke.ts](../../scripts/ops/smoke.ts)). |
| 7 | `gh auth status`, then `gh run list --branch main --limit 3` | You are signed in, and you see recent CI runs | Uses your own GitHub login. To gate anything on CI, use `bash scripts/dev/ci-watch-sha.sh <commit> [branch]` instead ([HANDOVER.md §2](../HANDOVER.md)). |

**Windows notes** ([HANDOVER.md §8](../HANDOVER.md); [CLAUDE.md](../../CLAUDE.md), "Tests"):

- `excel.test.ts` and `import-templates.test.ts` can time out on the first run after a
  large `npm ci`, then pass on a rerun. Rerun before you investigate.
- `ci-gates-guard.test.ts` takes minutes, because it runs a real CI step in Git Bash. A
  step that "did not finish" has not failed. Do not shrink its attempt budget.
- A busy machine makes other timeouts look like defects. Rerun the file alone first.

**Optional smoke with the monitor bearer [SECRETS]:** setting `HEALTH_BEARER` in the
environment adds the monitor-only checks. No env file in the pack holds it (§6.1).
`npm run smoke -- --expect-commit <sha>` checks which build production is serving, and
refuses to run without the bearer
([scripts/ops/smoke.ts](../../scripts/ops/smoke.ts)). Never type the bearer where it can be
seen or kept: on screen, in a shared terminal, or in your shell's history file.

**Integration suites against UAT** (only once §6.1 is done and `env-check.cjs` reads as in
row 1):

```bash
RUN_<FLAG>=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/<file>.test.ts
```

PowerShell:

```powershell
$env:RUN_<FLAG>='1'; node scripts/qa/run-with-env.mjs vitest run tests/integration/<file>.test.ts
```

The flag name is inside each suite. The runner loads `.env` with no host check, and some
suites do not refuse production, so the env check comes first
([AGENTS.md](../../AGENTS.md), "Before you start" 4; [HANDOVER.md §8](../HANDOVER.md)). In
PowerShell, `$env:RUN_<FLAG>` stays set for the rest of that window.

---

## 9. Optional tools

**Playwright browsers**

- After `npm ci`, run `npx playwright install chromium`. On Linux, CI runs
  `npx playwright install --with-deps chromium` ([ci.yml](../../.github/workflows/ci.yml)).
- To reuse a Chromium that is already installed, set `E2E_CHROMIUM` to its path for the
  tests ([playwright.config.ts](../../playwright.config.ts)), or `GUIDE_CHROMIUM` for
  `npm run guide:roles` ([scripts/build-role-guides.ts](../../scripts/build-role-guides.ts)).
- `npm run test:e2e` starts `npm run dev` against whatever `.env.local` or `.env` names,
  unless `E2E_BASE_URL` is set. Run `env-check.cjs` first.
- `npm run guide:pdf` renders `docs/guide/NMWC-CRM-USER-GUIDE.html` to PDF on your
  computer ([scripts/guide-html-to-pdf.ts](../../scripts/guide-html-to-pdf.ts)).
- `npm run guide:roles` builds the role guides and renders them to PDF on your computer.
  The Arabic guides load a font from Google Fonts, so it needs the network.
- **The guides in `docs/guide/` are stale.** A newer English and Arabic set (PDFs for
  Salesman, Manager, Approvers, Data Steward and How it works, plus an owner checklist) was
  produced on 2026-10-04 from the code and given to users. It is in the pack: the PDFs in
  `guides/`, and the content JSON and renderer in `golive-data/guides-2026-10-04/`.
  Whether it replaces `docs/guide/` in the repository, after a leak review, is a pending
  item ([04-PENDING-WORK.md](04-PENDING-WORK.md)).
- **`npm run guide:capture` and `npm run guide:build` sign in to the live production
  app** with accounts named in
  [scripts/capture-guide-screenshots.ts](../../scripts/capture-guide-screenshots.ts).
  `guide:build` runs the capture first, then the PDF step ([package.json](../../package.json)).
  Both are production actions. Do not run either without deciding to.

**The graphify knowledge graph**

- `graphify-out/` is committed. It was rebuilt on 2026-10-04 from `main` at `9d0fd61`:
  4,602 nodes, 10,495 links, 226 clusters. Start at `graphify-out/wiki/index.md`, or read
  `graphify-out/GRAPH_REPORT.md`. You need nothing installed for either.
  `graphify-out/graph.html` opens in a browser but needs internet: it loads the
  vis-network library from unpkg.com. [08-KNOWLEDGE-GRAPH.md](08-KNOWLEDGE-GRAPH.md)
  explains what is in it and how to query and rebuild it.
- To rebuild or query the graph you need the graphify tool. It is a separate Python tool,
  not a dependency of this repo. Install the version the graph was built with:
  `uv tool install graphifyy==0.8.44`. The owner also drove it through a Claude Code
  skill, which is not in this repository; the commands in
  [08-KNOWLEDGE-GRAPH.md](08-KNOWLEDGE-GRAPH.md) use the command-line tool.
- **`graphify-out/` is public.** Rebuild only from the tracked files, as
  [08-KNOWLEDGE-GRAPH.md](08-KNOWLEDGE-GRAPH.md) describes. Nothing from `golive-data/`,
  any `.env*` file, `.claude/` or the pack may reach its input. Before committing, check
  that `graphify-out/manifest.json` and the rest hold no absolute local paths.
- Do not copy its machine-specific files (`graphify-out/.graphify_python`,
  `graphify-out/.graphify_root`, `graphify-out/cache/`). They are gitignored.
- The graph is a map, not the truth. The code and [AUDITOR-BRIEF.md](../../AUDITOR-BRIEF.md)
  win where they differ. The repository map near the top of the brief describes the
  2026-10-04 build. Whoever commits a rebuilt graph updates that line in the same change
  ([AGENTS.md](../../AGENTS.md), "When you finish a task").

**Backup restore tools.** `psql`, `age` and `shred` are needed only for the restore
runbooks ([OPERATIONS.md §6.5](../OPERATIONS.md)). **[SECRETS]** Restoring also needs the
backup age private key ([OPERATIONS.md §6.7](../OPERATIONS.md)), which is not in the pack
(§6.3).

**Vercel CLI.** It is already a devDependency, so you run it as `npx vercel`.

- `.vercel/project.json` is tracked in git. So a fresh clone is **already linked** to the
  Vercel project that file names. Treat every `npx vercel` command run in a checkout as
  aimed at the production project.
- Reading variable names with `npx vercel env ls` needs your own Vercel token
  ([OPERATIONS.md §3](../OPERATIONS.md)).
- **[SECRETS]** Do not run `npx vercel env pull` in a checkout. It writes the pulled
  secret values into a file there (`.env.local` unless you name another), and Next.js
  loads `.env.local` ahead of `.env`.
- Do not run a bare `npx vercel`. It uploads your local tree as a preview deployment. A
  preview build runs the `build` script, which applies the tree's migrations to UAT
  ([HANDOVER.md §2](../HANDOVER.md), step 4).
- Never run `npx vercel --prod` (§10).

**GitHub Actions secret names.** `npm run ops:print-secrets` lists the secrets and
variables the workflows need, and where each one comes from. **[SECRETS]** It reads
`.env.local` and `.env`, but prints only whether each value is set and its length
([scripts/print-required-secrets.ts](../../scripts/print-required-secrets.ts)).

---

## 10. Never do these on any computer

| Never | Why | Source |
|---|---|---|
| `npm run build` locally | It runs `prisma migrate deploy` against whatever `.env` names, before `next build`. | [AGENTS.md](../../AGENTS.md) rule 5; [package.json](../../package.json) `build` |
| Any `npm run db:*`, `npx prisma migrate …` or `npx prisma db …` | They touch a database. | [AGENTS.md](../../AGENTS.md) rule 5 |
| `npx vercel --prod` | It uploads and builds whatever is checked out, and migrates production first. | [OPERATIONS.md §4](../OPERATIONS.md) |
| A bare `npx vercel`, or `npx vercel env pull`, in a checkout | The first deploys your local tree as a preview, which migrates UAT. The second writes secrets into the checkout. | §9; [HANDOVER.md §2](../HANDOVER.md) |
| Move `main` without an explicit "merge it" for that change, or without green CI on that exact commit | Merging deploys to production. Today the owner approves every merge in words. Who approves after the handover is for the owner and you to agree (PRIVATE-HANDOVER.md). An approved merge is either the exact CI-green commit pushed to `main` with the procedure in 03 §4, or GitHub's Rebase and merge. Codex never merges or pushes `main`. | [CLAUDE.md](../../CLAUDE.md), "Deploying"; [HANDOVER.md §2](../HANDOVER.md); [03 §4](03-OPERATIONS-AND-DEPLOYMENT.md) |
| `npm run format`, `prettier --write` or `eslint --fix` on existing files | The tree is not prettier-clean, so a small change becomes a huge diff. | [AGENTS.md](../../AGENTS.md) rule 8 |
| Print an env file, or put a secret in `node -e "…"` or a heredoc | Secrets reach transcripts. Shells eat backslashes. Put such code in a scratch `.cjs` file outside the repo and run `node <file>`. | [CLAUDE.md](../../CLAUDE.md), "Safety" |
| Put `DIRECT_URL=…` on a command line | It lands in shell history and on screen. Use `prod-run.cjs` (§6.3). | [HANDOVER.md §5](../HANDOVER.md) |
| Work in a checkout whose `.env` is production | Every command goes to production. | [HANDOVER.md §3](../HANDOVER.md) |
| Put secrets in `.env.development` or `.env.production` | They are not gitignored. | [.gitignore](../../.gitignore) |
| Decrypt the pack through a PowerShell 5.1 pipe | It corrupts the archive (§5). | — |
| Commit anything from the pack, or a graph built from anything but the tracked files | The repository is public. | [HANDOVER.md](../HANDOVER.md) (opening paragraph) |

### Before you commit anything

1. `git status --short | grep -c golive-data` prints `0` ([CLAUDE.md](../../CLAUDE.md)).
2. `node scripts/dev/leak-check.cjs` checks the default public documents: `AUDITOR-BRIEF.md`,
   `AGENTS.md`, `docs/HANDOVER.md` and `docs/design/**`
   ([scripts/dev/leak-check.cjs](../../scripts/dev/leak-check.cjs)). It does **not** check
   other files unless you name them. For these handover pages, run it in Git Bash as
   `node scripts/dev/leak-check.cjs docs/handover/*.md`.
3. `leak-check.cjs` looks only for the password literals it knows. It cannot see other
   secrets, customer data or rollout status. Read the diff yourself before you push.

---

## 11. Accounts are separate from this setup

Setting up this computer gives you no access to GitHub, Vercel, Neon, Cloudflare or
Sentry. Who holds each account, and how a second person can be added, is in
[SECRETS-INVENTORY.md §1 and §4](../SECRETS-INVENTORY.md). What the owner arranged for
you is in PRIVATE-HANDOVER.md.

The same goes for the app itself. A named Data Steward account of your own is
recommended; creating it is an owner action on the PRIVATE-HANDOVER.md fill-in list. Its
username must not be one the demo-account denylist blocks ([CLAUDE.md](../../CLAUDE.md),
"The code").

The old computer holds copies of these secrets and of the customer data. Cleaning it is
the owner's job, starting from [CREDENTIAL-ROTATION.md, Step 3](../CREDENTIAL-ROTATION.md).
The procedure for rotating credentials is [CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md),
together with [SECRETS-INVENTORY.md §5](../SECRETS-INVENTORY.md), which lists the places
that must change together. Whether credentials were rotated at the handover is recorded
in PRIVATE-HANDOVER.md.

---

## 12. What this page does not cover

- **It has not been tested on a clean machine.** It was written from the repository at
  commit `9d0fd61` and the owner's Windows setup. The macOS and Linux notes come from the
  CI workflow (Ubuntu), not from a run on those systems.
- **The pack's full contents** are not listed here. HOW-TO-USE-THIS-PACK.md and
  PRIVATE-HANDOVER.md, inside the pack, list them (§5).
- **The Claude Code folder naming** (§6.4) was observed on the owner's computer. Claude
  Code may change it, so step 2 there tells you how to check.
- **Codex's own history** (`~/.codex`) is not in the pack, and this page does not cover
  setting Codex up again (§6.5).

## Read next

- [HANDOVER.md](../HANDOVER.md): the state of the project, the owner's decisions, what is
  open, and how a change is merged.
- [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md): the standing rules, each
  with the incident behind it.
- [AUDITOR-BRIEF.md](../../AUDITOR-BRIEF.md): how the system works and what is known to be
  wrong.
- [OPERATIONS.md](../OPERATIONS.md) and [GO-LIVE-RUNBOOK.md](../GO-LIVE-RUNBOOK.md): read
  these before you touch production.
- [SECRETS-INVENTORY.md](../SECRETS-INVENTORY.md) and
  [CREDENTIAL-ROTATION.md](../CREDENTIAL-ROTATION.md): every account and secret, by name.
- The handover set in [this folder](./), in the order
  [HANDOVER-START-HERE.md](../../HANDOVER-START-HERE.md) gives:
  1. [01-SYSTEM-OVERVIEW.md](01-SYSTEM-OVERVIEW.md)
  2. [02-ACCESS-ACCOUNTS-AND-SECRETS.md](02-ACCESS-ACCOUNTS-AND-SECRETS.md)
  3. [03-OPERATIONS-AND-DEPLOYMENT.md](03-OPERATIONS-AND-DEPLOYMENT.md)
  4. [04-PENDING-WORK.md](04-PENDING-WORK.md)
  5. 05-NEW-COMPUTER-SETUP.md (this page)
  6. [06-WORKING-WITH-AI-AGENTS.md](06-WORKING-WITH-AI-AGENTS.md)
  7. [07-PROJECT-HISTORY.md](07-PROJECT-HISTORY.md)
  8. [08-KNOWLEDGE-GRAPH.md](08-KNOWLEDGE-GRAPH.md): the knowledge graph in
     `graphify-out/`, and how to query and rebuild it.
