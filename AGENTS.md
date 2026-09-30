# Instructions for coding agents (Codex and others)

This repository is worked on by more than one AI coding agent. Claude Code reads
`CLAUDE.md`; other agents read this file. **The rules are the same rules**: everything
below the line "The rules (verbatim from CLAUDE.md)" is a copy of `CLAUDE.md`, and
`tests/unit/agents-md-guard.test.ts` fails if the two drift. Change them together.

Two words in those rules come from Claude Code. A **scratchpad** is a directory outside
this repository (for example `%TEMP%\nmwc-scratch`) — never inside the repository and
never inside `golive-data/`. A **transcript** is anything you print, log or write into a
chat.

## Before you start

1. Read `docs/HANDOVER.md` — the state of production, the owner's recorded decisions,
   what is open, and how a change is verified and merged here — then `AUDITOR-BRIEF.md`,
   which describes how the system works and what is known to be wrong.
2. `git fetch`. A new task branches from `origin/main`, on a branch named
   `codex/<topic>`; a fix for findings on your earlier branch continues that branch.
3. **Never push to `main` and never merge.** Merging deploys to production. Claude runs
   the merge only after the owner's explicit "merge it", normally once Claude has verified
   your branch (docs/HANDOVER.md §2).
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
6. Production access of any kind — reads as well as writes — needs the owner's permission
   for that task, and then only through the safeguards in docs/HANDOVER.md §5. A standing
   permission the owner gave Claude does not extend to you.
7. Never open, list or copy `golive-data/`. Never print a secret.
8. Never run `npm run format`, `prettier --write` or `eslint --fix` over existing
   files: the tree is not prettier-clean. Format only the lines you add, by hand.
9. The owner's recorded decisions are in docs/HANDOVER.md §4 and `AUDITOR-BRIEF.md` §12.
   Do not re-ask them and do not build against them. Where a record says something is the
   owner's to decide, ask.

## When you finish a task

- Run `npm run typecheck`, `npm run lint` and `npm test`, and the integration suites
  you touched against UAT:
  `RUN_<FLAG>=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/<file>.test.ts`
  (PowerShell: `$env:RUN_<FLAG>='1'; node scripts/qa/run-with-env.mjs vitest run …`; the
  flag is named inside the suite). On Windows some tests time out under load and pass when
  rerun alone (docs/HANDOVER.md §8).
- Push the branch. In the last commit message (or the PR description) state what changed,
  which findings or items it addresses, the checks you ran with their results, and what you
  did **not** do.
- If the change alters something `AUDITOR-BRIEF.md` states, update the brief in the same
  change and run `node scripts/dev/leak-check.cjs` before committing.

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
