# Handover — the state of the NMWC CRM and how to continue it

Written 2026-09-30 for whoever continues this project — another coding agent
(Codex), a developer, or Claude in a new session. It records what is not in the
code: the state of production, the owner's decisions, what is open, and how a
change is verified and merged here.

This repository is **public**. Nothing in this file is a secret, and nothing may be
added to it that is: no password, connection string, token, customer or staff data,
and nothing about which accounts have or have not been used. Ask the owner for
anything of that kind; it is handed over privately, not written here.

Read in this order:

1. `AGENTS.md` (or `CLAUDE.md` — the same rules): the standing rules, each with the
   incident that made it a rule.
2. This file.
3. `AUDITOR-BRIEF.md`: how the system works, what is fixed, and what is known to be
   wrong (Appendix B lists the external auditor's findings one by one; §12 lists the
   deliberate choices, many of them the owner's).
4. `docs/OPERATIONS.md` and `docs/GO-LIVE-RUNBOOK.md` before touching production.

---

## 1. Where things stand (2026-09-30)

- **`main` = `95c8a63`**, deployed to production and verified: the build serves that
  commit, `npm run smoke` passes 14/14, and the post-deploy smoke in CI passes 16/16
  with no scheduled job alarming. If `origin/main` has no `AGENTS.md`, this handover
  package has not reached `main` yet: stop and ask the owner.
- **Rollout status** (who is using the system, and whether accounts have been handed
  out): ask the owner. It is deliberately not recorded in this public file.
- The data is loaded: seven regions; 18,703 live customers and 20,682 live branches on
  2026-09-29.
- **21 migrations** are applied on production; the last is
  `20260929120000_edit_submit_gate_equipment_confirmed` (two added columns).
- Hosting: Vercel Pro (project `nmwc-cm`, functions in `iad1`), Neon Postgres
  (production and a separate UAT branch), Cloudflare R2 for photos, Sentry for errors.

### What the last week merged

| When (UTC) | `main` | What |
|---|---|---|
| 2026-09-25 | `14a9356` | Benchmark items 16 and 20: duplicate matching and the import batch page (row actions, fixes, dismissals). |
| 2026-09-27 | `b650115` | Review fixes for 16 and 20, and the owner's decisions of 2026-09-27 (`a38ef1d`). |
| 2026-09-27 | `af795b6`, `dfa0ea9` | Items 9–13: Service status page and SLOs, health tiers, R2 health, Sentry digest search, secrets inventory. The Manager's Service status view leaked other people's approval figures; closed in `dfa0ea9` and narrowed again in `2060423`. |
| 2026-09-28 | `2060423` | The external auditor's Deep Recheck (2026-09-27), phase 1: decision tokens on every approval (N01), forced password change enforced by every action and route (F15), login throttle counted once (F22), audit rows in the same transaction as the change (F13), status evidence re-checked at decision (F10), account-import transactions and role rules (F07, F08), Temix same-code merges (F11), filtered export (F17), Sentry request bodies (N07), restore-log privacy (N08), photo-GC failures reported (N09), and more — Appendix B of the brief. |
| 2026-09-29 | `1f3f00a` | Fixes from the adversarial pass after `2060423`: browser Sentry no longer receives on-screen labels (customer names, the search term), photo-GC trusts only R2's own "not found", attach re-reads its target, the account import applies the Users screen's rules. |
| 2026-09-29 | `ab6d998` | Phase 2 of the recheck — edit-form semantics: F05 (a salesman is gated only on his own route's branches), F06 (only touched fields are sent, each with the value it was based on; a stale one is refused field by field, and again at approval), F16 (channel/sub-channel pair), F19 (phones in Arabic and Persian digits), F20 (clearing optional fields), N02 (strip before length), F21 ("Counted" equipment, import rescoring). One migration. |
| 2026-09-29 | `95c8a63` | Fixes from the adversarial pass after `ab6d998`: a late GPS fix, the sub-channel base after a channel conflict, request arrays refused on length before parsing, linear HTML strip and e-mail scrub, the import's region repair, the rescore ledger. |

### Production operations already run (each with the owner's go-ahead)

- **2026-09-23 — the go-live load**, and after it: 3,308 customers with no Temix code
  requeued (`scripts/ops/requeue-untracked.ts`), 1,770 empty credit limits set to 0 with a
  one-day term (`zero-credit-limits.ts`), quarantined visit days applied
  (`apply-quarantined-visit-days.ts`).
- **2026-09-27** — the `nmwc_app` role's grants corrected (`scripts/ops/app-role.ts grant`).
- **2026-09-29 06:00 UTC — completeness rescore** (`npm run ops:rescore-completeness`, as
  the Data Steward): 550 customer and 18,890 branch scores rewritten; a second dry run found
  nothing to do. Ledger: `AuditLog` rows with `entityType = CompletenessRescore`.
- **2026-09-29 — one customer's sub-channel cleared**: it belonged to another channel than
  the customer's (F16). One audited `UPDATE` as the Data Steward, no Temix requeue.

---

## 2. How a change is made, verified and merged here

This is the loop every change has followed. It is slow on purpose: every review round on
this project has found real defects, including ones that would have reached production.

1. **Branch** from `origin/main`; never work on `main`. A fix for findings on a branch
   continues that branch.
2. **Local checks before any push**: `npm run typecheck` (it runs `next typegen` first —
   bare `tsc` misses route types), `npm run lint`, `npm test`. Never `npm run format`,
   `prettier --write` or `eslint --fix` over existing files: the tree is not prettier-clean,
   and it turns a small change into hundreds of reformatted lines. On Windows some tests
   time out under load and pass when rerun alone (§8) — rerun before investigating.
   Never run `npm run build` locally: it runs `prisma migrate deploy` against whatever
   `.env` names before `next build` (CI runs the build without migrating).
3. **Push**, knowing that every branch push builds a Vercel preview which applies the
   branch's migrations to the **UAT** database: push a migration only when it is final, and
   never edit or rename a migration once pushed. Then wait for CI on the exact commit:
   `bash scripts/dev/ci-watch-sha.sh <commit> [branch]` resolves the commit to its full SHA,
   finds the CI run for exactly that commit, waits, prints each job, and exits 0 only if the
   run succeeded. (`gh run list --limit 1` races a fresh push.) CI runs lint, unit,
   `next build`, Playwright on a production build, the secrets scan, the
   backup → encrypt → restore → verify chain, and 35 of the 38 Postgres integration suites
   against a fresh database with every migration applied.
4. **Review.** A substantial change gets an independent adversarial review before merge; a
   substantial merge that was not already reviewed that way gets one after (CLAUDE.md,
   "Process"). Small follow-ups get tests, CI and a careful self-review (the owner's rule,
   2026-09-27).
5. **The owner says "merge it"** — for that commit or batch. Nothing else moves `main`:
   merging deploys to production. **Claude runs the merge procedure; the agent that wrote a
   change never pushes to `main`.**
6. **Merge procedure** (each step checked before the next — never chained with `&&`):
   1. `HEAD` equals the pushed branch; `origin/main` is an ancestor of `HEAD`.
   2. CI is green on exactly `HEAD` (step 3).
   3. `node scripts/dev/build-id.cjs` (the build production serves now; it exits 1 and
      prints nothing on stdout if it cannot tell) and `npm run smoke` (14 checks, no
      credentials).
   4. `git push origin <full sha>:refs/heads/main` (a fast-forward; no merge commits).
   5. `bash scripts/dev/deploy-watch.sh <commit> <build id from 3>`: waits for a new build
      ID, runs `npm run smoke`, then waits for `main`'s CI and prints its post-deploy smoke
      ("production is running the commit you think it is running"). It exits 0 only if the
      build changed, smoke passed and CI succeeded.
   6. If the change has a migration, confirm it applied (read-only; §5).
7. **Update `AUDITOR-BRIEF.md`** in the same change whenever it states something the change
   alters, and run `node scripts/dev/leak-check.cjs` before committing it or this file.

### Handover between agents (Codex builds, Claude verifies)

- Codex works on `codex/<topic>` in its own clone or worktree whose `.env` names **UAT**
  (§3), pushes, and states in the last commit message or PR: the findings or items
  addressed, what changed, the checks run with their results, and what it did **not** do.
- Claude then reads the diff and the files it touches, reruns the checks, runs an
  adversarial pass over the range, and reports findings with concrete scenarios.
- Findings are fixed on the same branch. The owner says "merge it"; Claude runs the merge
  procedure.

---

## 3. Where things live

| What | Where | Rule |
|---|---|---|
| Code, migrations, tests, CI, docs | GitHub (this repository, public) | — |
| Production and UAT connection strings, R2 keys, Sentry DSN, cron secrets | Vercel environment variables, GitHub Actions secrets, and the owner's local `.env` files | Never print, log or commit one. **The `.env` in the owner's main checkout points at PRODUCTION**: never work in that checkout. Give a coding agent a UAT `.env` only. |
| `golive-data/` — the go-live masters: customer data and generated passwords | Gitignored; on the owner's machine only (ask the owner where) | Never committed, never read into a chat or a log. Scripts may read it; people and agents may not. Never delete any worktree under `.claude/worktrees/` without asking the owner. |
| The go-live source files (RoutePro, Timix extracts, journey plans, the sales dashboard database) | The owner's Desktop, outside the repo | Read-only. `scripts/golive/build-masters.ts` names each one. |
| Helper scripts for the merge loop and production reads | `scripts/dev/` | See §2 and §5. |
| Design notes for phase 2 | `docs/design/phase2-edit-semantics/` | The spec, the critic's attack and the lead's rulings. Where they differ from the code, the code and `AUDITOR-BRIEF.md` win. |

---

## 4. The owner's recorded decisions

Each is final until the owner changes it. Do not re-ask, and do not build against one. When
a record says something is the owner's to decide, ask — do not implement it. More owner
decisions, each with where it is recorded, are in `AUDITOR-BRIEF.md` §12 (among them the
Sun–Thu workweek, the D2/D3/D4 decisions, no unique phone or CR index, exact-only duplicate
matching, offline limited to local drafts, no auto-retry on submit, exports never stored on
the server, items 40b and 41).

**Organisation and access**
- There are **no Supervisor accounts**: the Managers supervise their salesmen directly (by
  class in Muscat, by region elsewhere), and the Supervisor step is cleared by region
  overlap. One Accountant per region; one Finance Manager and one GM, global.
  (2026-09-10, 2026-09-20)
- Salesmen sign in with their route code, Managers with their class; one shared initial
  password with a forced change at first sign-in. **Accepted risk**: until an account first
  signs in, anyone who knows the shared value can take it. Per-account passwords were built
  and reverted as the owner's call.
- The repository stays **public** (2026-09-27). **Accepted risk**: it contains, in current
  files and in history, the shared initial password, the May pilot passwords, staff names
  and production screenshots (`AUDITOR-BRIEF.md` §14).
- Only SALESMAN (his own captures), STEWARD and MANAGER remove photos (2026-09-27,
  `a38ef1d`); the edit form and its Enrich button follow the same three roles.

**Edits and approvals**
- The salesman submit gate is `CORE` (channel, phone, contact, address, GPS, shop photo);
  `FULL` stays available by setting (2026-09-10).
- Phase 2 (2026-09-29): an import that changes a customer's channel **clears** a
  sub-channel of the old channel and notes it; the **CR number is clearable** from the edit
  form (a salesman's clear goes through approval and is refused under the FULL gate); a
  salesman can tick **"Counted"** equipment but never untick it, and a Steward or Manager
  can also untick it; existing zero-equipment branches stay **uncounted** (no backfill).

**Imports and data (items 16 and 20, 2026-09-25; amended 2026-09-27)**
- Four row actions on the batch page; credit cells are never editable in the app; a
  Temix-linked customer's fixed row updates the branch only — except that the row's phone
  fills the customer's phone when the customer has none (a phone it already has is never
  overwritten; `a38ef1d`); the three no-Temix re-import traps are fixed; a shared region is
  allowed; spaces in names are collapsed; CR numbers fold Arabic/Persian digits (the
  production recompute is ready, §6.2); dismissed duplicate pairs lapse and can be undone; a
  New customer button on Today.
- Item 4: a Temix crosswalk import was built and withdrawn pending a provenance column — a
  schema change, the owner's call.

**Operations**
- Vercel Pro (2026-09-27). Credential rotation is the owner's.
- On 2026-09-27 the owner gave **Claude** standing permission to write to production
  through operator scripts, with the safeguards in §5, until the owner says the product is
  "done". It covers no merge, no credential rotation, and no other agent: any other agent
  needs the owner's permission for each task, for reads as well as writes.

**Kept unchanged without asking the owner** (defaults, not decisions — changing either is a
product rule, so ask): the visit day cannot be cleared once set; a salesman's own CLOSED or
SUSPENDED branches still gate his submit. Engineering choices, not owner decisions: a
Manager's Service status view counts only the Supervisor step on requests in his own regions
(after the 2026-09-27 leak; do not widen it without a review).

---

## 5. Production: how to read and write safely

- `npm run smoke` before and after any production change.
- **Read-only questions**: a small script that opens a `SET TRANSACTION READ ONLY`
  transaction, builds its client as `new PrismaClient({ datasourceUrl: process.env.DIRECT_URL })`,
  and prints counts only (never a name, code, phone or id), run with
  `NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs <script> [args]`. The runner
  refuses an env file whose host is not production, gives the script `DIRECT_URL` only
  (`DATABASE_URL` is set to an address that cannot connect), runs it with no shell, and masks
  the URL, its password (raw and decoded), user and host, and anything shaped like a
  connection string, in everything it prints.
- **Writes** go through an operator script under `scripts/ops/` that follows the convention
  there: a dry run by default, `--expect-host ep-sweet-haze` required even for the dry run,
  `--apply` to write (with `--actor <steward username>`, required by some scripts and needed
  wherever more than one Steward exists), a ledger row before and after, counts-only output,
  and a second dry run that reports nothing left. See `rescore-completeness.ts` and
  `recompute-cr-norm.ts`. Run it through `prod-run.cjs` like a read (the runner passes its
  arguments through, e.g. `--expect-host ep-sweet-haze --apply --actor <steward>`); never put
  `DIRECT_URL=…` on a command line, even though the scripts' own headers show that form.
- The app still connects as the database owner; switching it to `nmwc_app` is open (§6.2).

---

## 6. What is open

The recommendations below are **Claude's, not yet answered by the owner**.

### 6.1 Waiting on the owner's decision

| Item | Question | Recommendation |
|---|---|---|
| F02 | Photo cleanup and backup. The owner earlier chose R2 versioning (`scripts/ops/r2-photos-versioning.ts`), and the cleanup relies on object tagging; R2 implements neither | Delete the object directly 30 days after its row was soft-deleted, driven by the rows; copy every photo nightly to a second bucket for recovery. A cost and data-residency choice as well |
| F04 | Photo scope is customer-level (any branch of the customer in scope) | Branch-level: only photos of branches in the viewer's own scope |
| F09 | Shared phone numbers inside one import file cannot be released | A reviewed release per row on the batch page, like the master-phone release |
| F12 / E5 | The Temix lifecycle: what CLOSED and reactivated branches look like in the batch file; a live customer with no Temix code | Needs the file contract from Temix/ERP first |
| F14 | A route moved to another region leaves its branches in the old region | Move the route's branches (and drafts) with it in the same transaction, audited |
| N04 | How a customer's status follows its branches | ACTIVE if any branch is active; CLOSED only when all are |
| X-AUTH-2 | The per-network login bucket counts every attempt | Count only failed sign-ins |
| X-APPR-1(a) | May the Finance Manager, GM and Accountant-on-CREDIT steps decide new-credit applications in bulk? | No |
| Q-sla | Response-time budgets for the Finance Manager, GM, Manager | The owner's numbers |
| — | May a salesman remove a guarantee or status-evidence photo while its request is pending? | No; he may replace it |
| X-IMPORTS-4 | Clearing an account's e-mail or phone | A Steward edit on the Users screen, not the import |

Also carried: whether an import row with a blank `temix_code` takes the full lane; unkeyed
dismissal digests; the new-customer form's Back after "Save draft" and a way to discard a
create draft; placeholder CR numbers on `/duplicates`; the salesman guide's create section;
`BranchStatusActions` pending state; whether a GM breach notifies every Manager; whether the
synthetic `accountant.*` / `pilot.*` names should be denylisted; five security items from the
re-benchmark that the owner parked.

### 6.2 Only the owner can do, or must confirm

- Restore drill secrets (`NEON_API_KEY`, `NEON_PROJECT_ID`); `ALERT_WEBHOOK_URL`.
- Retire cron-job.org by following `docs/OPERATIONS.md` §5d exactly (delete both jobs and
  the API key, delete the `CRONJOB_API_KEY` secret, rotate `CRON_SECRET` in Vercel and
  `PROD_CRON_SECRET` in GitHub, redeploy; do not run the scheduler `apply` again). Check
  first that Service status shows "Vercel last ran it" for every job.
- Confirm Vercel Observability Plus (30-day logs) is on.
- Name a second holder of the production credentials (item 13; `docs/SECRETS-INVENTORY.md` §4).
- Decide on search terms kept unredacted in Vercel request logs for 30 days
  (DATA-RETENTION gap 7).
- Item 14, switching the app to the least-privilege `nmwc_app` role: engineering can verify
  the app under `nmwc_app` on UAT; the switch itself is `docs/CREDENTIAL-ROTATION.md` step 1,
  done by the owner (Vercel and GitHub secrets).
- The PDPL / data-residency blanks and the memo to counsel; the export round-trip decision;
  the D2 credit-ownership note; the draft-photo retention period; the items under
  "Decisions" in `docs/OWNER-ACTIONS-NOW.md`.
- The CR-number recompute on production (item 16): the script is ready and falls under
  Claude's standing permission, but `AUDITOR-BRIEF.md` §18 still says "go-ahead pending" —
  confirm with the owner, and fix its ledger loose end (§6.3) first.
- Two edit requests left pending since the May pilot: an approver should reject them (one
  flips a customer-level status, which approval refuses).
- Credential rotation.

### 6.3 Engineering not started

From the 41-item benchmark list (2026-09-24): **32** three integration suites
(`build-chain-data`, `golive-rehearsal`, `uat-load`) never run in CI; **10** and **13**
partly done; **15** duplicate scan on open; **17** a merge cannot be undone; **18** no
data-quality history; **19** the score counts "Address pending"; **21** installable /
offline; **23** offline photos; **24** plan adherence; **25** Today covers a third of the
route; **26** Arabic only in old PDFs; **27** notifications are in-app only; **29** no API;
**30** no machine accounts; **31** no feature flags or staging; **33–35** months-scale
(visits/orders/surveys/coolers, multi-company, order capture). Item 14's engineering part is
in §6.2.

From the auditor's recheck: ENH-4 and enhancements 1, 2, 7, 8, 9; the dependency-audit
triage.

Loose ends the reviews recorded: `/api/forms` has no body-size cap of its own (the server
actions' 8 MB cap is above Vercel's 4.5 MB request limit, which is the bound that applies to
both); the two export routes accept unbounded filter lists; the Temix-linked (refresh)
import lane does not repair a branch's region; the CHANGELOG has not been kept since July;
`scripts/ops/recompute-cr-norm.ts` reads before it writes its COMPLETED row, as the rescore
did before `95c8a63`.

Rough size with the review loop in §2 (Claude's estimate, 2026-09-29): the decision items
~2 days once decided; item 14 and the CI suites ~1 day; the data tools ~2 days; offline and
field features ~3 days; Arabic and notifications ~2–3 days; the platform items ~2 days. Of
these, §6.2, item 14 and the decision items that affect daily use (F04, X-APPR-1(a),
X-AUTH-2, photo removal) matter most.

### 6.4 Housekeeping

- Old agent worktrees under `.claude/worktrees/` on the owner's machine: remove one only
  with the owner's go-ahead.
- The main checkout on the owner's machine can sit on an old commit: `git pull` first, and
  remember its `.env` is production.

---

## 7. Things that look like defects and are not

- **Local database timings are WAN-bound.** Tests and scripts run from Oman against Neon in
  us-east; production runs beside the database. A promote that takes seconds locally takes
  tens of milliseconds there. Measure production separately before optimising — but do fix
  what the slow link exposes (it found a real transaction-timeout bug).
- **Vercel functions** here (measured 2026-09-25, before the Pro upgrade) have ~2 GB memory,
  2 vCPUs, Node 24 and a 60 s limit; a 16 MB buffered response is fine; streaming exceljs
  writes 60,000 rows in ~13 s.

## 8. Windows test quirks

- `excel.test.ts`, `import-templates.test.ts` and other exceljs-heavy files time out at 5 s
  on a first or loaded run and pass alone (`--testTimeout=60000` if the machine is busy).
- `ci-gates-guard.test.ts` runs the real smoke step in Git Bash, where every process costs
  ~0.25 s; its scenarios take minutes. "Did not finish" is not "failed". Do not shrink its
  attempt budget.
- `typed-routes-guard.test.ts` spawns `tsc` and can exceed its budget under load.
- Other projects' dev servers on the same machine can hold the CPU — check before reading a
  timeout as a defect.
- Heredocs and `node -e` eat backslashes: put a script with quotes, backticks, `$` or regex
  backslashes in a file and run it.
- Integration suites against UAT: `RUN_<FLAG>=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/<file>.test.ts`
  (PowerShell: `$env:RUN_<FLAG>='1'; node scripts/qa/run-with-env.mjs vitest run …`). The
  flag is named inside the suite (`grep -n RUN_ tests/integration/<file>.test.ts`). The
  runner loads `.env` with no host check, and some suites do not refuse production — run
  `node scripts/dev/env-check.cjs` first (it prints only "production" / "not production",
  never a value, and exits 1 on production). Never check with `grep` or `Select-String` on
  `.env`: they print the whole line, password included. A spaced `-t "pattern"` passed through the runner becomes
  file filters; use a pattern without spaces.
- In PowerShell use `npm.cmd` (the execution policy blocks `npm.ps1`).
- The UAT database link from this machine is flaky ("can't reach database server"); rerun.
