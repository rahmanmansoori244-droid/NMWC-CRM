# Instructions for coding agents (Codex and others)

This repository is worked on by more than one AI coding agent. Claude Code reads
`CLAUDE.md`; other agents read this file. **The common rules are the same rules**: everything
below the line "The rules (verbatim from CLAUDE.md)" is a copy of `CLAUDE.md`, and
`tests/unit/agents-md-guard.test.ts` fails if the two drift. Change them together.

**Owner working agreement, 2026-09-30:** the preface below and `docs/HANDOVER.md` §2
record the current workflow. They replace only the older instructions about **who merges
and how** (the owner uses GitHub Rebase and merge, replacing Claude's fast-forward push),
**review by tier** (Claude reviews Tier B changes in batches, not every change), and
**other agents' production access** (Codex has none, including reads; Claude's permission
does not transfer). Everything else in the verbatim rules still applies, including safety,
the CI exit-code gate for the exact commit, smoke before and after production changes,
and the adversarial pass after a substantial merge. The owner coordinates production
checks with Claude; Codex checks their CI results through GitHub. Keep `CLAUDE.md` and its
verbatim copy unchanged when updating this preface.

Two words in those rules come from Claude Code. A **scratchpad** is a directory outside
this repository (for example `%TEMP%\nmwc-scratch`) — never inside the repository and
never inside `golive-data/`. A **transcript** is anything you print, log or write into a
chat.

## Before you start

1. Read `docs/HANDOVER.md` — the state of production, the owner's recorded decisions,
   what is open, and how a change is verified and merged here — then `AUDITOR-BRIEF.md`,
   which describes how the system works and what is known to be wrong.
2. `git fetch`. A new task branches from `origin/main`, on a branch named
   `codex/<topic>`; keep each PR independent. A fix for findings on your earlier branch
   continues that branch. State any dependency on another PR in the description.
3. **Never push to `main` and never merge.** Merging deploys to production. The owner
   uses GitHub's **Rebase and merge** only after the checks and review below. Claude
   reviews Tier B PRs; Claude no longer reviews every change or performs the merge.
4. **Never work in the owner's main checkout: its `.env` points at PRODUCTION.** Work in
   your own clone or worktree whose `.env` names the **UAT** database. Before anything that
   loads `.env` (tests, `scripts/qa/run-with-env.mjs`, Prisma), run
   `node scripts/dev/env-check.cjs`: it prints only "production" or "not production" for
   `DATABASE_URL` and `DIRECT_URL` (in the file and the environment), never a value, and
   exits 1 on production. Never check with `grep` or `Select-String` on `.env`: they
   print the whole line, password included. Some integration suites and `prisma/seed.ts`
   do not refuse production. If you have no UAT access, do not look for credentials: say so
   when you hand the work back.
5. Never run `npm run build` locally (it runs `prisma migrate deploy` against whatever
   `.env` names before `next build`), any `npm run db:*` script, or
   `npx prisma migrate …` / `npx prisma db …`. Typecheck, lint and CI's `next build`
   are the build checks. Every branch push builds a Vercel preview that applies the
   branch's migrations to UAT: push a migration only when it is final, and never edit or
   rename one once pushed.
6. **Codex has no production access, for reads or writes.** If a task needs production,
   write up the operation for the owner to have Claude run with the safeguards in
   `docs/HANDOVER.md` §5. Do not run production probes or smoke checks yourself; inspect
   CI results through GitHub. Claude's standing permission does not extend to you.
7. Never open, list or copy `golive-data/`. Never print a secret.
8. Never run `npm run format`, `prettier --write` or `eslint --fix` over existing
   files: the tree is not prettier-clean. Format only the lines you add, by hand.
9. The owner's recorded decisions are in docs/HANDOVER.md §4 and `AUDITOR-BRIEF.md` §12.
   Do not re-ask them and do not build against them. Where a record says something is the
   owner's to decide, wait for the owner's answer before implementing it. Continue
   independently with the engineering items in `docs/HANDOVER.md` §6; each gets its own PR.
10. **Classify every PR** using the tiers below, and state the tier and why in its
    description. If unsure, use Tier B.

### PR review tiers

**Tier A — low risk, no Claude review:** documentation and wording, adding or strengthening
tests, UI layout and copy, `scripts/dev/` tooling except the three safety tools listed
below, and small loose ends. A Tier A PR must not touch any Tier B path. Deleting or
loosening a `*-guard` test is **Tier B**, not "tests only". The owner merges Tier A once CI
is green and the branch is up to date.

**Tier B — Claude review required before merge:** any change touching the following paths
or areas, including a documentation or wording change inside them. Prefix the PR title
with **`[needs Claude]`**. Review these PRs with Claude in batches.

| Area | Paths |
|---|---|
| Approvals and credit | `services/edits.ts`, `services/creates.ts`, `lib/decision-token.ts`, `lib/approval-chains.ts`, `lib/edit-approval.ts`, `lib/create-*.ts`, `app/(app)/approvals/**` |
| Permissions and scope | `lib/access.ts`, `lib/permissions.ts`, `lib/edit-scope.ts`, `lib/submit-gate.ts`, `lib/export-scope.ts` |
| Imports | `services/imports.ts`, `lib/account-import.ts`, `lib/excel.ts`, `services/import-fixes.ts`, `lib/import-*.ts` |
| Database, audit and migrations | `prisma/`, `lib/db.ts`, `lib/audit.ts` |
| Sign-in, sessions and user administration | `lib/session.ts`, `lib/auth.ts`, `auth.config.ts`, `app/actions/auth.ts`, `app/api/auth/**`, `services/password.ts`, `services/users.ts`, `lib/login-throttle.ts`, `lib/demo-accounts.ts`, `lib/auth-handlers.ts`, `lib/password-policy.ts`, `lib/rate-limit.ts`, `middleware.ts`, `lib/csp.ts` |
| Privacy and exports | `lib/scrub.ts`, `sentry.*.config.ts`, `instrumentation*.ts`, `lib/sentry-*.ts`, `lib/logger.ts`, `services/exports.ts`, `services/customer-export.ts`, `app/api/exports/**` |
| Forms, submissions, offline and drafts | `app/api/forms/**`, `lib/fetch-route.ts`, `lib/submission*.ts`, `lib/submit-client.ts`, `lib/enrichment-draft.ts`, `lib/enrichment-patch.ts`, `app/(app)/customers/[id]/edit/EnrichmentForm.tsx`, `app/(app)/customers/new/CreateCustomerForm.tsx` |
| Photos, storage and cron authentication | `services/photos.ts`, `app/api/photos/**`, `lib/r2.ts`, `lib/photo-*.ts`, `app/api/cron/**`, `lib/cron-auth.ts` |
| CI, dependencies and deployment | `.github/workflows/**`, `package.json`, `package-lock.json`, `next.config.ts`, `vercel.json` |
| Operational safety tools | `scripts/dev/prod-run.cjs`, `scripts/dev/env-check.cjs`, `scripts/dev/leak-check.cjs` |
| Go-live, credentials and database-writing scripts | `scripts/golive/**`, `scripts/bulk-reset-credentials.ts`, `scripts/ops/**`, `prisma/*.ts`, and any other database-writing script |

Nothing with a migration merges without Claude's review. The PR recording this working
agreement is also **Tier B**, as the owner requested, because it changes the rulebook.

## When you finish a task

- Before marking a PR ready, run `node scripts/dev/env-check.cjs` and confirm it says
  "not production", then `npm run typecheck`, `npm run lint` and `npm test`, and the
  integration suites you touched against UAT:
  `RUN_<FLAG>=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/<file>.test.ts`
  (PowerShell: `$env:RUN_<FLAG>='1'; node scripts/qa/run-with-env.mjs vitest run …`; the
  flag is named inside the suite). On Windows some tests time out under load and pass when
  rerun alone (docs/HANDOVER.md §8).
- Push only the review branch, then wait until CI is green on the PR's **latest commit**.
  Match the run's full `headSha`; never trust `gh run list --limit 1` alone. The PR
  description must state its tier and why, findings or items addressed, checks run with
  their results, dependencies if any, and what you did **not** do.
- If the change alters something `AUDITOR-BRIEF.md` states, update the brief in the same
  change. Run `node scripts/dev/leak-check.cjs` before committing and marking the PR ready.
- Before the owner uses **Rebase and merge**, substitute the PR's latest full head SHA
  in the command below. It must succeed and print **0**:

  ```sh
  gh api repos/rahmanmansoori244-droid/NMWC-CRM/compare/main...<PR head sha> --jq .behind_by
  ```

  The repository's **Always suggest updating pull request branches** setting is off
  (`allow_update_branch=false`), so an absent **Update branch** button proves nothing.
  If behind, fetch, rebase the review branch onto current `origin/main`, push that branch
  with `--force-with-lease`, and wait for green CI on the new latest commit. Tier B also
  needs Claude to say it is ready before the owner merges.
- After the owner merges, check `main`'s CI run for the resulting commit through GitHub,
  including **post-deploy-smoke**. GitHub's **Rebase and merge always creates new commits**,
  so `main`'s CI runs on a new commit, not the reviewed PR head. Do not access production
  to perform this check.
- **If `main`'s CI or post-deploy smoke goes red after a merge, Codex reports the failing
  job and commit and pushes nothing.** The owner has Claude check the live build, smoke
  and migration state. Recovery is Vercel's instant rollback or a revert PR, selected by
  the owner with Claude; never revert a migration without Claude. A deployment rollback
  does not undo database migrations. Resume branch pushes only after the owner and Claude
  have resolved the incident and `main`'s checks are verified green.

---

## The rules (verbatim from CLAUDE.md)

# Working rules for this repository

Every rule here exists because breaking it cost something real. The incident is
named in one line, because a rule without its reason gets deleted by the next
person who finds it inconvenient.

---

## Safety

**Never write to the production database.** Its endpoint contains `ep-sweet-haze`.
Every gated test asserts `if (DATABASE_URL.includes('ep-sweet-haze')) throw`, and
`scripts/ops/app-role.ts`, `restore-verify.ts` and `prisma/synthetic.ts` refuse it
outright. `prisma/seed-muscat-pilot.ts` refuses it too — its upsert sets
`isActive: true`, so running it against production would REVIVE accounts an
operator had just deactivated, with passwords that are literals in that file.

**`golive-data/` is customer PII and generated passwords.** Gitignored, never
committed, never read into a transcript. Assert `git status --short | grep -c
golive-data` is 0 before every commit. Scripts may read it; people and transcripts
may not.

**Never let a secret reach a log, a transcript or a screenshot.** A `node -e "…"`
written in double quotes once let the shell run a secret path as command
substitution and echoed part of a production role password into a transcript; the
role had to be rotated. **Put anything containing backticks, quotes, `$` or regex
backslashes in a scratchpad `.cjs` file and run `node <file>`** — never through a
heredoc or `-e`, which silently eat backslashes.

---

## Deploying

**Merging to `main` deploys to production.** Never fast-forward `main` without an
explicit yes from the owner.

**`prisma migrate deploy` runs BEFORE `next build`.** So anything `next build`
refuses surfaces *after* migrations have already been applied to the production
database, leaving it migrated but undeployed. Since 2026-09-24 the build script
typechecks and lints ahead of the migrate (`tests/unit/ci-gates-guard.test.ts`
pins the order), but a compile or prerender failure inside `next build` still
lands after it — and so do the per-page type checks (a page's exports, its
`params`/`searchParams` types), because Next writes those files only while
`next build` compiles. Only CI's `next build` on the branch catches them before a
migrate, which is one more reason `main` moves only to a CI-green commit. Run
`npm run typecheck`, `npm run lint` and the unit suite before pushing anything.
Not bare `npx tsc --noEmit`: without `next typegen` first there are no route
types, and it passes a `<Link>` to a page that does not exist.

**Gate the merge on CI's exit code, not on the command that printed it.** Chaining
a push after a status check with `&&` or `;` pushes regardless — that put a red
commit on `main` once. And `gh run list --limit 1` races a fresh push: capture the
run whose `headSha` equals `HEAD` before trusting the result.

**`npm run smoke` before and after any production change.** Fourteen checks, no
credentials, fifteen seconds. Each one is something that has already been wrong
here — including production serving a four-month-old build for weeks.

---

## The code

**Audit rows go through `writeAudit()` from `lib/audit.ts`.** ESLint enforces it
across `app`, `components`, `lib` and `services`; `tests/unit/audit-guard.test.ts`
proves the rule still runs, because a broken ESLint selector fails OPEN and the
build continues unlinted. Operator scripts are deliberately outside the rule: they
have no request, so both forensic columns are null either way, and importing
`lib/audit` would drag `next/headers` and the pooled client into them.

**Never reorder the content-security-policy.** Next finds the nonce with
`find(d => d.startsWith('script-src'))`, so a directive named `script-src-elem`
placed ahead of `script-src` returns the wrong one and production renders blank.
Both policies come from `lib/csp.ts`; `tests/unit/csp.test.ts` re-implements the
extractor to pin it. The CHANGELOG records a strict policy being reverted under
production pressure once.

**Never relax the demo-account denylist to make a real account work — rename the
account.** `lib/demo-accounts.ts` blocks `steward`, `viewer`, `admin` and the
`salesman.`/`supervisor.`/`manager.a|b` prefixes whenever
`DEMO_ACCOUNTS_DISABLED` is set, which production sets. The go-live builder once
issued the Data Steward as `steward`; the load would have died at sign-in with no
in-app recovery.

**`DATABASE_URL` is the pooled least-privilege role; `DIRECT_URL` is the owner.**
Operator scripts use `DIRECT_URL` and build their own client — they run as the
owner and must not be coupled to the request runtime.

---

## Tests

**A fixture that reads the real clock must never be asserted against a literal.**
`golive-update-flow.test.ts` stored `omanDayOfWeek()` and asserted `'SUN'`, so it
was red every Sunday — the day the go-live targets — and green otherwise, which
reads as a flake and gets re-run rather than read. Derive the value once and use
that constant in both places.

**Structural guards over behavioural ones where the defect is "nobody called it".**
Several defects here were a correct helper that nothing used, or a rule that no
longer ran. The guards live in `tests/unit/*-guard.test.ts` and friends; when you
assert against source text, strip comments first — a comment quoting the thing
being asserted passes or fails for the wrong reason.

**Windows: `excel.test.ts` and `import-templates.test.ts` fail on the first run
after a large `npm ci` and pass on every rerun.** An exceljs load-time cost against
a 5-second timeout. Not a defect; rerun before investigating.

**Windows: `ci-gates-guard.test.ts` takes minutes, and a step that did not finish
is not a step that failed.** It executes the real smoke step in Git Bash, where
every process costs ~0.25 s, and five scenarios run all 24 attempts. The old 60 s
spawn budget killed them under a full suite run, and they failed as "expected -1
to be 1", which reads as the step answering wrongly (2026-09-25). `runStep` now
throws `did not finish` instead. Do not shrink the attempt budget to speed them
up: what those scenarios prove is about the 24th attempt.

---

## Process

**Run an adversarial pass after every substantial merge, including over your own
work.** It has found real defects every single time on this project: nine in a
batch that had already been reviewed before merging, and thirty-five in the
blocker code that had only ever been reviewed for correctness by its author. Two
of those would each have stopped the go-live load while reporting success.

**When the record says something is the owner's decision, do not implement it as a
code task.** The assessment recorded per-account initial passwords as an owner
decision; it was built anyway, against a standing instruction. Ask.

**Say what is not done.** Several rows in this project's assessment read "open —
owner decision" or "already fixed" or "never true". A list where every row says
"fixed" is a list nobody checked.
