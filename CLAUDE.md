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
lands after it. Run `npm run typecheck`, `npm run lint` and the unit suite before
pushing anything. Not bare `npx tsc --noEmit`: without `next typegen` first there
are no route types, and it passes a `<Link>` to a page that does not exist.

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
