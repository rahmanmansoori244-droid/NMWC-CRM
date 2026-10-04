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

1. The `AGENTS.md` preface and §2 below for the current working agreement, then the
   shared standing rules in `CLAUDE.md` and the verbatim part of `AGENTS.md`, each with
   the incident that made it a rule.
2. This file.
3. `AUDITOR-BRIEF.md`: how the system works, what is fixed, and what is known to be
   wrong (Appendix B lists the external auditor's findings one by one; §12 lists the
   deliberate choices, many of them the owner's).
4. `docs/OPERATIONS.md` and `docs/GO-LIVE-RUNBOOK.md` before touching production.

---

## 1. Operational reference

- Confirm the current `main` commit and its CI results through GitHub, including
  post-deploy smoke. Keep deployment verification in private owner records.
- **Rollout status** (who is using the system, and whether accounts have been handed
  out): ask the owner. It is deliberately not recorded in this public file.
- Keep dated production totals in private owner records.
- Migration definitions live in `prisma/migrations/`; confirm applied production
  migration state privately with the owner.
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

### Operation names and evidence pointers

Confirm execution dates, results and counts in the owner's private operation records.

- **Go-live load:** the load procedure and reconciliation are in
  `docs/GO-LIVE-RUNBOOK.md`; retain the manifest and load evidence privately.
- **Requeue customers without a Temix code:** `scripts/ops/requeue-untracked.ts`;
  ledger: `AuditLog` rows with `entityType = TemixRequeue`.
- **Zero empty credit limits with a one-day term:** `scripts/ops/zero-credit-limits.ts`;
  ledger: `AuditLog` rows with `entityType = CreditLimitZeroing`.
- **Apply quarantined visit days:** `scripts/ops/apply-quarantined-visit-days.ts`;
  ledger: `AuditLog` rows with `entityType = QuarantinedVisitDays`.
- **Correct the `nmwc_app` role's grants:** `scripts/ops/app-role.ts grant`;
  retain the operator's grant/status evidence privately.
- **Completeness rescore:** `npm run ops:rescore-completeness`;
  ledger: `AuditLog` rows with `entityType = CompletenessRescore`.
- **Clear a sub-channel belonging to a different channel (F16):** the audited
  `UPDATE` as the Data Steward, without a Temix requeue; retain the corresponding
  audit-row reference in the private operation record.

---

## 2. How a change is made, verified and merged here

**Owner working agreement, 2026-09-30.** Codex continues independently; Claude reviews
only risky changes, in batches. This section and the `AGENTS.md` preface replace only
these older rules: who merges and how (the owner uses GitHub's Rebase and merge, rather
than Claude merging after "merge it" or pushing `main`), review of every change by Claude
(now review by tier), and production access for other coding agents (none, even with the
older task-permission wording). Everything else in `CLAUDE.md` and its unchanged verbatim
copy in `AGENTS.md` still applies, including safety, the CI exit-code gate, smoke before
and after production changes, and the adversarial pass after every substantial merge.
**The owner merges; neither Codex nor Claude merges or pushes to `main`.**

**Codex has no production access, for reads or writes.** Work in a separate clone or
worktree with **UAT only**, never the owner's main checkout (§3). If work needs production,
write it up for the owner to have Claude run with §5's safeguards. Do not run production
probes or smoke checks from Codex; inspect CI results through GitHub. Never open, list or
copy `golive-data/`, print secrets, or reformat existing files.

### Classify every PR

Put the tier and its reason in every PR description. **If unsure, use Tier B.**

**Tier A — low risk, no Claude review:** documentation and wording, adding or strengthening
tests, UI layout and copy, `scripts/dev/` tooling except the three safety tools below, and
small loose ends. It must not touch any Tier B path. Deleting or loosening a `*-guard` test
is Tier B. The owner merges once CI is green and the compare API confirms the branch is
up to date with `main` (step 6).

**Tier B — Claude review before merge:** anything touching these paths or areas. Prefix
the title **`[needs Claude]`**. Batch these PRs for Claude's review.

| Area | Paths |
|---|---|
| Approvals and credit | `services/edits.ts`, `services/creates.ts`, `lib/decision-token.ts`, `lib/approval-chains.ts`, `lib/edit-approval.ts`, `app/(app)/approvals/**` |
| Permissions and scope | `lib/access.ts`, `lib/permissions.ts`, `lib/edit-scope.ts`, `lib/submit-gate.ts` |
| Imports | `services/imports.ts`, `lib/account-import.ts`, `lib/excel.ts`, `services/import-fixes.ts`, `lib/import-*.ts` |
| Database schema and migrations | `prisma/` |
| Sign-in, sessions and users | `lib/session.ts`, `lib/auth.ts`, `auth.config.ts`, `app/actions/auth.ts`, `services/password.ts`, `lib/login-throttle.ts`, `middleware.ts`, `lib/csp.ts`, `lib/demo-accounts.ts`, `lib/auth-handlers.ts`, `lib/password-policy.ts`, `lib/rate-limit.ts`, `app/api/auth/**`, `services/users.ts` |
| Privacy and exports | `lib/scrub.ts`, `lib/sentry-scrub.ts`, `sentry.*.config.ts`, `instrumentation*.ts`, `lib/sentry-*.ts`, `lib/logger.ts`, `services/exports.ts`, `services/customer-export.ts`, `app/api/exports/**`, `lib/export-scope.ts` |
| Forms, submissions, offline and drafts | `lib/enrichment-draft.ts`, `lib/enrichment-patch.ts`, `app/(app)/customers/[id]/edit/EnrichmentForm.tsx`, `app/(app)/customers/new/CreateCustomerForm.tsx`, `app/api/forms/**`, `lib/fetch-route.ts`, `lib/submission*.ts`, `lib/submit-client.ts`, `lib/create-*.ts` |
| Photos, storage and scheduled jobs | `services/photos.ts`, `app/api/photos/**`, `lib/r2.ts`, `app/api/cron/**`, `lib/cron-auth.ts`, `lib/photo-*.ts` |
| Audit and database access | `lib/audit.ts`, `lib/db.ts` |
| Build, deployment, CI and dependencies | `.github/workflows/**`, `package.json`, `package-lock.json`, `next.config.ts`, `vercel.json` |
| Safety tooling | `scripts/dev/prod-run.cjs`, `scripts/dev/env-check.cjs`, `scripts/dev/leak-check.cjs` |
| Scripts that can write to a database | `scripts/ops/**`, `prisma/*.ts`, `scripts/golive/**`, `scripts/bulk-reset-credentials.ts`, and any other database-writing script |
| Guard tests | Deleting or loosening any `*-guard` test |

Nothing with a migration merges without Claude's review. The PR recording this agreement
is also **Tier B**, as requested by the owner, because it changes the rulebook.

### Build, verify, review and merge

1. **Keep each PR independent.** Fetch and branch from current `origin/main` as
   `codex/<topic>`. A fix for findings on an earlier branch continues that branch. State
   any dependency on another PR in its description. Work from §6: implement owner-decision
   items only after the owner answers; otherwise continue with engineering items, each in
   its own PR.
2. **Local checks before any push or marking a PR ready:** run
   `node scripts/dev/env-check.cjs` and confirm "not production" before anything that loads
   `.env`. Then run `npm run typecheck` (includes `next typegen`; bare `tsc` misses route
   types), `npm run lint`, `npm test`, and any integration suites touched against UAT
   using their `RUN_*` flag and `scripts/qa/run-with-env.mjs` (§8). If UAT access is absent,
   do not look for credentials; record that limitation. Never run `npm run build` locally,
   any `npm run db:*`, `prisma migrate` or `prisma db` command. Never run `npm run format`,
   `prettier --write` or `eslint --fix` over existing files. On Windows, rerun a timeout
   alone before investigating (§8).
3. **Update the record.** Update `AUDITOR-BRIEF.md` in the same change whenever it states
   something the change alters. Run `node scripts/dev/leak-check.cjs` before committing
   and marking the PR ready. The PR description must state the tier and why, findings or
   items addressed, checks run with their results, dependencies if any, and what was
   **not** done.
4. **Push the review branch and wait for green CI on its latest commit.** Match the full
   `headSha`, not `gh run list --limit 1`. `bash scripts/dev/ci-watch-sha.sh <commit> [branch]`
   finds and waits for the exact commit's run, prints each job, and exits 0 only on
   success. Every branch push builds a Vercel preview that applies its migrations to UAT:
   push a migration only when final, and never edit or rename one once pushed. CI runs
   lint, unit, `next build`, Playwright on a production build, the secrets scan, the
   backup → encrypt → restore → verify chain, and 36 of 39 Postgres integration suites
   against a fresh database with all migrations applied.
5. **Review by tier.** Tier A needs no Claude review. Tier B waits for Claude to read the
   diff and touched files, verify the checks and review adversarially, then say it is
   ready. Fix findings on the same branch and repeat the affected checks and exact-commit
   CI. The standing rule to run an adversarial pass after a substantial merge still
   applies; it does not require Claude to review every Tier A change.
6. **The owner merges in GitHub using Rebase and merge.** For either tier, CI must be
   green on the latest commit and the branch must be up to date with `main`. Run
   `gh api repos/rahmanmansoori244-droid/NMWC-CRM/compare/main...<PR head sha> --jq .behind_by`
   using the current full PR head SHA: it must succeed and print **0**. The repository has
   `allow_update_branch=false` (GitHub's **Always suggest updating pull request branches**
   setting is off), so the absence of an **Update branch** button proves nothing. If behind,
   Codex fetches, rebases the review branch onto current `origin/main`, pushes that branch
   with `--force-with-lease`, and waits for fresh green CI on the new latest commit. Tier B
   additionally needs Claude's readiness verdict for the changes being merged. Neither
   Codex nor Claude performs the merge. Production smoke checks remain required before and
   after production changes; the owner coordinates those with Claude, not Codex (§5).
7. **After the owner's merge, check the resulting `main` commit through GitHub.** Rebase
   and merge always creates new commits, so `main`'s CI runs on a new commit, not the PR
   head. Wait for that exact resulting `main` commit's CI, including **post-deploy-smoke**,
   and tell the owner if anything is red. A missing or skipped smoke job is not a pass.
   This is a review of CI results, with no production
   requests from Codex.
8. **If `main`'s CI or post-deploy smoke goes red, Codex reports the job and exact commit
   and pushes nothing.** The owner has Claude check the live build, smoke and migration
   state. Recovery uses Vercel's instant rollback or a revert PR; never revert a migration
   without Claude. An application rollback does not undo an applied database migration.
   Resume branch refreshes only after the owner and Claude have resolved the incident and
   the current `main` commit's required CI and post-deploy smoke are green.

---

## 3. Where things live

| What | Where | Rule |
|---|---|---|
| Code, migrations, tests, CI, docs | GitHub (this repository, public) | — |
| Production and UAT connection strings, R2 keys, Sentry DSN, cron secrets | Vercel environment variables, GitHub Actions secrets, and the owner's local `.env` files | Never print, log or commit one. **The `.env` in the owner's main checkout points at PRODUCTION**: never work in that checkout. Give a coding agent a UAT `.env` only. |
| `golive-data/` — the go-live masters: customer data and generated passwords | Gitignored; on the owner's machine only (ask the owner where) | Never committed, never read into a chat or a log. Scripts may read it; people and agents may not. Never delete any worktree under `.claude/worktrees/` without asking the owner. |
| The go-live source files (RoutePro, Timix extracts, journey plans, the sales dashboard database) | The owner's Desktop, outside the repo | Read-only. `scripts/golive/build-masters.ts` names each one. |
| Helper scripts for review checks and owner/Claude production diagnostics | `scripts/dev/` | Codex uses the review checks in §2; production helpers are for the owner and Claude only (§5). |
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
  through operator scripts, with the safeguards in §5. At the 2026-10-04 handover the owner
  set its end date (recorded in the private handover pack, `PRIVATE-HANDOVER.md`); after
  that the person taking over decides whether to keep, narrow or end it. It covers no
  merge, no credential rotation, and no other agent. The 2026-09-30
  working agreement (§2) gives Codex **no production access, including reads**; production
  work is written up for the owner to have Claude run.

**Kept unchanged without asking the owner** (defaults, not decisions — changing either is a
product rule, so ask): the visit day cannot be cleared once set; a salesman's own CLOSED or
SUSPENDED branches still gate his submit. Engineering choices, not owner decisions: a
Manager's Service status view counts only the Supervisor step on requests in his own regions
(after the 2026-09-27 leak; do not widen it without a review).

---

## 5. Production: how to read and write safely

**For the owner and Claude only.** These safeguards grant Codex no production access.
Codex writes up any production work for the owner and checks post-merge CI through GitHub
as described in §2.

- `npm run smoke` before and after any production change.
- `node scripts/dev/build-id.cjs [url]` reads the live build ID; `deploy-watch.sh` can
  watch for it to change. These are owner/Claude diagnostics, not a Codex merge or
  production-check procedure. The owner merges through GitHub (§2); Codex checks only
  GitHub's CI results. If CI or post-deploy smoke is red, follow §2's recovery step and
  inspect the deployed build and migration state before choosing a rollback.
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

Decided since the list below was written: **X-AUTH-2** (the owner, 2026-10-04) — the per-network login bucket counts failed sign-ins only. It is charged first and given back on a successful sign-in and on a per-user refusal (`lib/auth.ts`, `refundLimit` in `lib/rate-limit.ts`). Trade-offs accepted with it: successful sign-ins from one address are no longer capped per address, and once an account is locked, keeping it locked costs the address doing so no network tokens (no worse than before, when the per-user bucket was charged first; no help for guessing, since refused attempts never reach the password check).

| Item | Question | Recommendation |
|---|---|---|
| F02 | Photo cleanup and backup. The owner earlier chose R2 versioning (`scripts/ops/r2-photos-versioning.ts`), and the cleanup relies on object tagging; R2 implements neither | Delete the object directly 30 days after its row was soft-deleted, driven by the rows; copy every photo nightly to a second bucket for recovery. A cost and data-residency choice as well |
| F04 | Photo scope is customer-level (any branch of the customer in scope) | Branch-level: only photos of branches in the viewer's own scope |
| F09 | Shared phone numbers inside one import file cannot be released | A reviewed release per row on the batch page, like the master-phone release |
| F12 / E5 | The Temix lifecycle: what CLOSED and reactivated branches look like in the batch file; a live customer with no Temix code | Needs the file contract from Temix/ERP first |
| F14 | A route moved to another region leaves its branches in the old region | Move the route's branches (and drafts) with it in the same transaction, audited |
| N04 | How a customer's status follows its branches | ACTIVE if any branch is active; CLOSED only when all are |
| X-APPR-1(a) | May the Finance Manager, GM and Accountant-on-CREDIT steps decide new-credit applications in bulk? | No |
| Q-sla | Response-time budgets for the Finance Manager, GM, Manager | The owner's numbers |
| — | May a salesman remove a guarantee or status-evidence photo while its request is pending? | No; he may replace it |
| X-IMPORTS-4 | Clearing an account's e-mail or phone | A Steward edit on the Users screen, not the import. The e-mail half is built (2026-10-05, F1); the phone half is open |

Also carried: whether an import row with a blank `temix_code` takes the full lane; unkeyed
dismissal digests; the new-customer form's Back after "Save draft" and a way to discard a
create draft; placeholder CR numbers on `/duplicates`; the salesman guide's create section;
`BranchStatusActions` pending state; whether a GM breach notifies every Manager; the
exact-name synthetic-account denylist question in §6.2; five security items from the
re-benchmark that the owner parked.

### 6.2 Only the owner can do, or must confirm

- Confirm with the owner that the signed-in CSP browser walk (sign-in, forced change, early sign-out, /audit filter, approve/reject, photo upload) is done or superseded.
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
  the D2 credit-ownership note; the draft-photo retention period.
- Policy questions carried forward from the retired `docs/OWNER-ACTIONS-NOW.md`: whether
  to deny synthetic approver accounts by exact name (never an `accountant.` prefix);
  whether archiving releases a customer's documents (DATA-RETENTION gap 1); audit-write
  failure policy (check current call sites before proposing a change); and the Steward's
  reach / two-person provisioning for approver-tier accounts. These remain owner questions,
  not permission to implement. The settled initial-password decision remains in §4.
- The CR-number recompute on production (item 16): closed — a read-only production dry run
  on 2026-10-04 found nothing to recompute. The code safeguards are
  complete: CR-recompute and completeness rescore print committed counts before their
  COMPLETED insert and record completion before verification. Both the verification-read
  catch and each script's CLI catch show safe argument/configuration instructions marked
  `OperatorRefusal`; other errors print only a Prisma error code or error class, never
  their message. Refusals containing database row values remain ordinary errors and are
  redacted. A failed check keeps COMPLETED, reports "not checked" and exits 2: run a dry
  run and, if it finds work, re-run `--apply`, then verify with another dry run. Remaining
  mismatches exit 1 with the next step printed; a second apply that still leaves work calls
  for investigation before a third. CR-normalization calculation errors after a successful
  verification read propagate.
- ~~Two edit requests left pending since the May pilot~~ — done 2026-10-04: every open
  May-pilot edit request was deleted on the owner's decision (audited; a backup is kept
  privately).
- Credential rotation.

### 6.3 Engineering follow-ups

Completed in code: form POSTs under `/api/forms/[form]` have a 4 MiB raw-byte cap,
enforced while reading and before JSON parsing. An overflow cancels the stream and
returns a 413 refusal in the action-result shape, which the phone displays as an answer.
The cap is independent of `Content-Length` and field validation; sign-in and Origin
checks still run first, and the shared reader's photo callers are unchanged.

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

Completed in code: the two export download routes now bound repeated query filters after
authentication, before validation or workbook building: 500 region IDs and 500 route IDs,
each ID at most 128 UTF-16 code units; the master route also permits three statuses and two
payment terms. Repetitions count, and overflow returns the existing generic 400 without
truncating or dropping filters. Direct server-action calls and the separate filtered export
are unchanged.

Loose ends the reviews recorded: the Temix-linked (refresh) import lane does not repair a
branch's region; the CHANGELOG has no entries after 2026-05-11 (v1.0.1).

CR-recompute and completeness rescore use the same verification-failure policy; their
completed safeguards are recorded in §6.2; the production CR run is closed (nothing to recompute, 2026-10-04).

Historical rough size (Claude's estimate, 2026-09-29, before the tiered review agreement):
the decision items ~2 days once decided; item 14 and the CI suites ~1 day; the data tools
~2 days; offline and field features ~3 days; Arabic and notifications ~2–3 days; the platform
items ~2 days. Of these, §6.2, item 14 and the decision items that affect daily use (F04, X-APPR-1(a),
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
