# 07 — Project history

> Part of the handover set in [`docs/handover/`](./). **This file is public.** It holds
> no secrets, no customer or staff data, no production totals and no rollout status.
> Anything of that kind is in the private handover pack (PRIVATE-HANDOVER.md).

This file explains how NMWC CRM got to where it is. It covers what was built, in what
order, and why the big decisions went the way they did. It runs from the first commit
on 2026-05-09 to the handover on 2026-10-04, when `main` was `9d0fd61`. This handover
documentation set reached `main` after that commit (section 3.11).

It also fills a gap. The two changelogs stop early:

- [`CHANGELOG.md`](../../CHANGELOG.md) lists only the first build milestones (M0–M8).
- [`docs/CHANGELOG.md`](../CHANGELOG.md) stops at v1.0.1 on 2026-05-11.

It has no entries after 2026-05-11. For everything after May, use the git log, the pull requests and the
records linked below.

---

## 1. How to read this history

### Trust order

When sources disagree, trust them in this order:

1. the code;
2. [`AUDITOR-BRIEF.md`](../../AUDITOR-BRIEF.md);
3. recent commit messages;
4. everything else in `docs/` and `qa/`.

Many older documents are stale. AUDITOR-BRIEF §15 lists the known contradictions, so
you neither trust a stale document nor report it as a bug.

### Explore it yourself

```bash
git log --date=short --format="%ad %h %s"         # one line per commit, newest first
git log -1 --format=%B <hash>                      # the full message of one commit
git log --date=short --format="%ad %h %s" --since=2026-09-14 --until=2026-09-16
gh pr list --state all --limit 100                 # pull requests (#1 is 2026-09-14)
gh pr view <n> --json commits                      # which commits a PR carried
git tag -l                                         # v1.1.0-golive
```

Commit messages in this repository are written to be read. The title says what was
wrong in plain words. The body says why, what was tested and, often, what was **not**
done. Read the body before you trust the title.

> **Careful with old commits.** This repository is public, and its history contains
> credential literals: the shared initial password, the May pilot passwords and seeded
> test passwords. They sit in many diffs and in a few commit messages.
> AUDITOR-BRIEF §14 lists the known places. Read history on your own machine. Never
> paste `git show` or `git log -p` output into an issue, a pull request, a chat or an
> AI tool. To report one, name the commit and file, never the value. This file
> deliberately leaves out the hashes of the commits whose messages carry one.

### Names you will meet

- **Temix** is the company ERP. Some files and scripts spell it **Timix**. They are the
  same system (AUDITOR-BRIEF §1, §19).
- **The ICO Customer Portal** is the older customer-registration system. It is a
  separate codebase, outside this repository
  ([`docs/discovery/NMWC-CRM-Discovery-Report.md`](../discovery/NMWC-CRM-Discovery-Report.md),
  "The two systems at a glance"). In July this project took its requirements, not its
  code (section 3.2).

### Finding IDs

Commits and comments cite findings from several reviews, and some prefixes collide.
AUDITOR-BRIEF §13 ("Finding-ID prefixes in comments") maps the older prefixes and lists
the known collisions. Its table does **not** cover the 2026-09-27 recheck IDs, the `X-`
IDs or the `OCT-` IDs. In short:

| IDs | Source |
|---|---|
| `AUTH`, `PROD`, `RBAC-05`, `NEW-PHOTO`, `UXI`, `F-NN`, `GAP-NN` (May) | May 2026 audits, `docs/audit/01-auth-session.md` … `07-cross-check.md` |
| `B-NN` (for example `B-13`), `F-C*` | [`docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`](../audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md), `qa/findings/register.md` |
| `QA-*` | [`docs/QA-AUDIT-REPORT.md`](../QA-AUDIT-REPORT.md), [`docs/REMEDIATION-REPORT.md`](../REMEDIATION-REPORT.md) |
| `SEC-C*`, `SEC-H*` and other July hunt IDs | [`qa/findings/`](../../qa/findings/) (for example `final-golive-hunt.md`) |
| `final-hunt #N`, `perf audit #N`, `F-UAT-*` | [`docs/SESSION-MASTER-RECORD.md`](../SESSION-MASTER-RECORD.md), `qa/evidence/uat-live-run.md` |
| `B1`–`B6`, `SEC-*`, `REL-*`, `DG-*`, `DO-*` | 2026-09-14 assessment, [`qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`](../../qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md) |
| `item N` (1–41), also written `Gap #N` or `GAP-0N` | 2026-09-24 re-benchmark. The report is not in the repo; the list is AUDITOR-BRIEF Appendix A. **Collides with the May `GAP-NN`**: `GAP-07`/`GAP-08` in `ci.yml` are re-benchmark items, while `GAP-12` in `lib/rate-limit.ts` and `GAP-03` in photo-gc are May IDs |
| `F01`–`F22`, `N01`–`N09`, `Enh. N` | External deep recheck of 2026-09-27; status per finding in AUDITOR-BRIEF Appendix B |
| `X-AUTH-*`, `X-IMPORTS-*`, `X-OPS-*`, `X-APPR-*`, `X-STATUS-*`, `X-PHOTO-*`, `X-TEMIX-*` | Used next to the recheck findings in AUDITOR-BRIEF and HANDOVER §6.1. Their source report is not in the repo. Check those two files for each ID |
| `OCT-01`…`OCT-06` | An external review report acted on 2026-10-02. The report is not in the repo. The fixes are described in AUDITOR-BRIEF (§5, §6) and in the commit messages. Ask the owner whether the report is in the private handover pack (PRIVATE-HANDOVER.md) |

---

## 2. The project at a glance

| Period | Phase | Where `main` (production) was | Main records |
|---|---|---|---|
| 2026-05-09 → 05-11 | First build, audits and the May pilot | First commits up to `c612c79` | [`docs/CHANGELOG.md`](../CHANGELOG.md), `docs/SESSION-HANDOFF-2026-05-09.md`, `docs/SESSION-HANDOFF-2026-05-10.md` |
| 05-12 → 07-14 | No commits | `c612c79` | — |
| 07-15 → 07-22 | Consolidation discovery, phase 1 (approval engine), July QA programme | `c612c79`; all work on branch `claude/nmwc-crm-consolidation-e10c1e` | [`docs/discovery/`](../discovery/), [`docs/SESSION-MASTER-RECORD.md`](../SESSION-MASTER-RECORD.md), [`qa/`](../../qa/) |
| 07-23 → 09-09 | No commits | `c612c79` | — |
| 09-10 | Go-live build | `c612c79` | [`docs/GO-LIVE-RUNBOOK.md`](../GO-LIVE-RUNBOOK.md) |
| 09-14 → 09-15 | Enterprise-readiness assessment, blockers B1–B6, P2/P3 lists | `6852063` (PR #1, tag `v1.1.0-golive`), then `0f6c0e1` (B4/B5, 09-14) and `3f753ef` (B3/B6, 09-15) | [`qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`](../../qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md) remediation log |
| 09-20 → 09-24 | Standing rules, smoke test, load preparation, follow-up fixes, re-benchmark | Fast-forwards after the owner said "merge it"; PR #8 | [`CLAUDE.md`](../../CLAUDE.md), commit messages |
| 09-25 → 09-27 | Benchmark items, auditor brief, service levels | PR #9; `14a9356`, `b650115`, `af795b6`, `dfa0ea9` | HANDOVER §1, AUDITOR-BRIEF |
| 09-27 → 09-29 | External deep recheck: phase 1 and phase 2 (edit semantics) | `2060423`, `1f3f00a`, `ab6d998`, `95c8a63` | AUDITOR-BRIEF Appendix B, [`docs/design/phase2-edit-semantics/`](../design/phase2-edit-semantics/) |
| 09-30 → 10-02 | Handover to coding agents, working agreement, Codex PRs, OCT fixes | PRs #2 and #10–#24 (see below for how each reached `main`) | HANDOVER §2, [`AGENTS.md`](../../AGENTS.md) |
| 10-04 | The 2026-10-04 batch, then the handover to a new person | `9d0fd61` (no pull request); the handover documentation set after it | AUDITOR-BRIEF §18; section 3.11 |

### How `main` actually moved

**Merging to `main` deploys to production** (Vercel's GitHub integration). The written
rule and what happened are not the same, so both are recorded here.

- **Until 2026-09-30.** Claude fast-forwarded `main` after the owner's explicit
  "merge it" ([`CLAUDE.md`](../../CLAUDE.md), "Deploying"). PR #1 on 2026-09-14 was the
  first pull request.
- **The working agreement of 2026-09-30** (PR #12; HANDOVER §2; the
  [`AGENTS.md`](../../AGENTS.md) preface) wrote down that only the owner merges, in
  GitHub, with **Rebase and merge**, after exact-commit CI is green and the branch is
  not behind `main`.
- **What actually happened from 2026-10-01 to 10-04.** The owner approved every merge
  in words ("merge it"). Apart from PR #2, Claude then carried out each approved merge
  by pushing the exact CI-green commit to `main`: `scripts/dev/ci-watch-sha.sh` on the
  commit, `node scripts/dev/build-id.cjs` and `npm run smoke` for the baseline,
  `git push origin <sha>:refs/heads/main`, then `scripts/dev/deploy-watch.sh`. That
  procedure is written up in
  [`03-OPERATIONS-AND-DEPLOYMENT.md`](03-OPERATIONS-AND-DEPLOYMENT.md) §4. Codex never
  merged and never pushed `main`. The evidence is in GitHub:
  - Every merged pull request except #2 reached `main` with the pull request's own
    commit hashes. GitHub's Rebase and merge always creates new commits (HANDOVER §2
    step 7), so these were pushes. GitHub then marked the pull requests as merged.
  - PR #2 (`eff0e7c`) is the only commit on `main` that GitHub itself committed.
  - PRs #21 and #23 are **closed**, not merged, on GitHub. Their commits reached `main`
    as cherry-picks with new hashes (each says "cherry picked from commit …").
  - The 2026-10-04 batch (`fe6f65f` → `9d0fd61`) reached `main` from an integration
    branch with **no pull request at all**.
- **At handover.** The owner approves every merge in words. Claude carries out an
  approved merge with the push procedure in 03 §4. The alternative recorded in
  HANDOVER §2 is the owner pressing GitHub's **Rebase and merge**. Codex never merges
  or pushes `main`. Who approves merges after the handover is for the owner and the
  new person to agree; it is on the fill-in list in PRIVATE-HANDOVER.md. Write what
  they agree into HANDOVER §2 and the AGENTS.md preface. (Keep CLAUDE.md and its
  verbatim copy in AGENTS.md in step; `tests/unit/agents-md-guard.test.ts` fails if
  they drift.) Whoever moves `main`, gate the merge on CI for the exact commit
  (`bash scripts/dev/ci-watch-sha.sh <commit>`) and run `npm run smoke` before and
  after.

---

## 3. Timeline

### 3.1 May 2026 — first build and the Muscat pilot (2026-05-09 → 05-11)

**Build (05-09).** The app was built in one session, milestone by milestone:

- M0 foundation: `cf8f86a`, `fdd4294`, `0cc52a2`.
- M1–M2 schema, shell, admin and import: `f69cc8f`.
- M3 photos through Cloudflare R2: `bf35052`.
- M4–M5 enrichment form and approval queue: `ff5f4d5`.
- M6–M8 export, duplicates, reactivation, dashboards and hardening: `0a0732e`.

The same day an independent adversarial audit was run (`9ccf62c`). Its Critical and
High findings were fixed (`aea667a`, `c40209d`), and pre-launch hardening followed
(`7856627`). A market benchmark was saved (`61785a8`,
[`docs/BENCHMARK-REPORT.md`](../BENCHMARK-REPORT.md), 63/100). It is **not** the
September re-benchmark that later commits cite.

**Pilot (05-10).**

- A pilot organisation was seeded in production.
- Photo upload to R2 was fixed twice (`0d9df2b`, `242d4a6`).
- Server actions got one error contract (`5a1f8b7`).
- A senior five-expert audit was largely closed in one commit (`2c112a1`). That commit
  also pinned the Vercel functions to the `fra1` region.
- **Incident:** the first nonce-only content-security-policy left production rendering
  a blank page, because `app/layout.tsx` never stamped the nonce on Next's own scripts.
  It was reverted as a hotfix (`b596680`), then fixed properly (`d9b4658`). Directive
  order played no part in May. The ordering hazard behind the CLAUDE.md rule "never
  reorder the CSP" was found on 2026-09-15 (`5ecda53`). It leads to the same failure
  mode: a blank production page.
- The nightly database backup workflow took five iterations: `2c112a1` added it, then
  `99302a6`, `3987335`, `a331384` and `a05cb5e` fixed it
  ([`docs/CHANGELOG.md`](../CHANGELOG.md) v1.0.0). The last one gated the restore drill
  behind a variable that was never created. Nobody noticed until September (section 3.4,
  B3).
- Role guides were written as HTML and PDF in English and Arabic (`a6585db`, `9013721`,
  `c9c291b`).

**v1.0.1 (05-10 → 05-11).** A user audit of the live pilot changed several things:

- The pilot data was flattened to one branch per customer (`7d0dcb1`). **This was
  reversed in July.** The schema was always one-to-many, and the consolidation
  blueprint restored many branches per customer (Blueprint §0 and C6).
- Phone numbers are no longer unique.
- Duplicate detection was tightened to exact matches.
- The Steward got filters, saved views and a filtered export.
- A performance pass and a keep-warm job on GitHub Actions (`e156a2c`).
- A bulk pilot credential reset, as an explicit owner trade-off for pilot ease of use
  ([`docs/CHANGELOG.md`](../CHANGELOG.md) v1.0.1). The script's hard-coded passwords
  were removed from current files on 2026-07-15 (`821b02b`), but they remain in
  history.
- Legal name locked for salesman edits (`c612c79`).

`c612c79` then stayed on `main` — and in production — until 2026-09-14.

### 3.2 July 2026 — consolidation and phase 1, the approval engine (07-15 → 07-22)

**Phase 0 security (07-15, `821b02b`).**

- The durable rate limiter never denied anything in production. Fixed.
- A Manager could write to customers outside his regions. Scoped.
- Hard-coded pilot passwords were removed from a script and redacted from seven docs.
- A gitleaks secrets scan was added to CI.

**Discovery and blueprint (07-15, `35b41cc`).** NMWC had two overlapping systems: the
older **ICO Customer Portal** (new-customer registration) and this codebase (master-data
enrichment). The discovery report and blueprint chose to build on this codebase and
take only requirements from the portal. The operating model was locked with the owner,
including **many branches per customer**. See
[`docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`](../discovery/NMWC-CRM-Consolidation-Blueprint.md)
§0 and [`docs/PROJECT-DESCRIPTION.md`](../PROJECT-DESCRIPTION.md).

**Phase 1, the unified CRM (07-16).**

| Commit | Phase | What |
|---|---|---|
| `c81dbf9` | 1a | Data model: 8 roles, credit fields, CREATE drafts, approval chain columns, Temix sync state, code sequence |
| `ae5157a`, `2ed47c5` | 1b | Approval-chain matrix (`lib/approval-chains.ts`), step authorisation, step-aware engine with the step-back reject cascade |
| `b87f44f` | 1c | New-customer CREATE flow: submit → chain → all-or-nothing finalise |
| `896eda6` | 1d | Temix ERP batch sync: outbound queue → Excel batch → inbound refresh |
| `06867e4` | 1e | SLA engine on a working-hours calendar, escalation cron, in-app notifications |

**July QA programme (07-19 → 07-21).**

- An isolated-database proof of the reactivation lane and the master import
  (`d87cffb`, `e3cf5e6`, `b330965`).
- Ops hardening moved the Vercel functions from `fra1` to `iad1`, next to the Neon
  database in AWS us-east-1 (`605d161`, 07-19). This stayed on the branch until
  2026-09-14 (section 3.4, B1).
- Three adversarial deep-review rounds (`a18ddf7`, `08230d2`, `fa81618`, `0794995`,
  `638eeef`). Findings are in [`qa/findings/`](../../qa/findings/).
- Owner decisions of 07-20 (`4044182`, `e60545c`): **D1, D2 and D4 confirmed**. D3 was
  left open ("upgrade to Pro or accept GitHub Actions") and was decided on 09-14. D5 is
  still marked pending. See section 4.
- Online UAT on a separate database branch (`cbe4ade`, `30447bb`).
- A performance pass (`8778811`).
- Verdict on 07-21: no open P0 or P1. It recommended a supervised pilot once the owner
  completed the actions it listed
  ([`qa/reports/FINAL-GOLIVE-VERDICT.md`](../../qa/reports/FINAL-GOLIVE-VERDICT.md)).
- The first graphify knowledge graph was committed to `graphify-out/` (`a5752a9`,
  `fd897d0`). It was replaced by a full rebuild on 2026-10-04 (section 3.11).
- Go-live import templates were added (`7b83bfb`).

**07-22.** The Customer Master SOP and access-control policy was added for management
sign-off (`302e104`,
[`docs/NMWC-Customer-Master-SOP-and-Access-Policy.docx`](../NMWC-Customer-Master-SOP-and-Access-Policy.docx)).

None of this reached production in July. It all stayed on the consolidation branch.

### 3.3 September 10 — the go-live build

- **Chunked, resumable import (`355e9fa`, `7761faf`).** The real customer master could
  never have loaded in one request within the function time limit. Promote now runs
  in leased, time-boxed slices and resumes until done.
- **Go-live data build (`fd6b505`).**
  [`scripts/golive/build-masters.ts`](../../scripts/golive/build-masters.ts) builds the
  account and customer masters from the real source systems (RoutePro, Temix extracts,
  journey plans, the sales dashboard). It writes them to `golive-data/`, which is
  gitignored because it holds customer data and generated credentials. The runbook is
  [`docs/GO-LIVE-RUNBOOK.md`](../GO-LIVE-RUNBOOK.md).
- **Sign-in model (`c4e1ad9`, `68127e8`).** Salesmen sign in with their route code.
  Everyone starts with one shared initial password and must change it at first
  sign-in. This was the owner's decision (section 4).
- **Update flow verified end to end (`4eab4d4`).** Defects were fixed on the way,
  including a first-login password change that could never complete.
- **CORE submit gate (`27f3d94`).** An owner decision (section 4).
- **Preview sign-in (`c76fe36`).** Preview deployments must never inherit the
  production `AUTH_URL`.
- **First Steward (`e8b763a`).** It comes from the audited bootstrap script
  (`scripts/golive/bootstrap-accounts.ts`), not from the app.

### 3.4 September 14–15 — enterprise assessment and blockers B1–B6

**Assessment (09-14, `62981b0`, `7743ac4`).** A multi-agent review scored the system
41/100: "an enterprise-grade core inside an SMB-grade envelope". It listed six P1
blockers. Remediation started the same day.

| Blocker | What was wrong | What was done | Still open |
|---|---|---|---|
| **B1** | Production still served May's `main`. CI had never run on the go-live branch. | CI runs on every branch, with database-backed integration suites (`f4f1f02`, `70feff0`). PR #1 was merged by fast-forward with the owner's explicit go. Tag `v1.1.0-golive` = `6852063`. The `iad1` region went live with this merge. | — |
| **B2** | A region-scoped Manager could create an org-wide Viewer and assign salesmen to any route. | Region-scoped Manager administration (`f4f1f02`). | — |
| **B4** | The audit trail could be changed by the credential the app runs with. | Append-only triggers on `AuditLog` and `EditApproval`, and a least-privilege role `nmwc_app` (`a6addee`, `0f6c0e1`, [`scripts/ops/app-role.ts`](../../scripts/ops/app-role.ts)). The role was created on production on 09-15 through the dispatch-only `provision-app-role` workflow (`f9230b7`), so the owner credential stays inside GitHub Actions. | Whether production uses the restricted `nmwc_app` role is recorded in PRIVATE-HANDOVER.md. Switching to it is item 14, an owner-side action (HANDOVER §5, §6.2; [`docs/CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md) step 1). If the app connects as the database owner, the triggers stop accidents, not a leaked app credential (AUDITOR-BRIEF §7). |
| **B5** | Nothing noticed when a scheduled job stopped running. | Cron heartbeats and a health probe that can fail (`a6addee`, `0f6c0e1`, `lib/heartbeat.ts`). | — |
| **B3** | Nobody had ever restored the database. The May drill was gated off and could not have failed anyway. | The monthly drill was rebuilt as its own workflow (`restore-drill.yml`). A `restore-chain` CI job proves dump → encrypt → restore → verify on every push (`b587754`). The nightly dump is encrypted before upload. | **The monthly drill against Neon has never succeeded.** Its scheduled run on 2026-10-01 failed at preflight, because the `NEON_API_KEY` and `NEON_PROJECT_ID` GitHub secrets are missing. They are needed from the owner (AUDITOR-BRIEF §7, HANDOVER §6.2). Until then only the CI chain proves a restore. Separately, the age private key that decrypts the nightly dumps is not in the handover pack (section 3.11). |
| **B6** | Nobody had asked where the personal data lives. | Records of processing, data-residency register, retention schedule, PDPL questions for counsel, and a generated PII inventory ([`docs/compliance/`](../compliance/)). | The PDPL and residency blanks and the memo to counsel (HANDOVER §6.2). |

`main` moved three times in these two days: to `6852063` (PR #1), then to `0f6c0e1`
(B4/B5 deployed, 09-14), then to `3f753ef` (B3/B6, 09-15). Every database role on
production is managed through the `provision-app-role` workflow. Note its only gate is
a typed `confirm_host`, matched as a substring (AUDITOR-BRIEF §10).

Notes on the same two days:

- The adversarial review of B3/B6 found a P0: the nightly backup check would have
  killed the backup job every night. CI was green because its fixture was too small to
  show it (`4e88812`).
- D3 was decided as an external cron scheduler (`1ebcabb`). It changed on 09-27
  (section 4).
- **P2/P3 pass (09-15).** Cross-site form posts were closed (`5ecda53`), Sentry
  redaction was widened, every audit row records device and network (`990e459`,
  `a7ef425`), and `MAINTENANCE_MODE` can close the app during a recovery (`e2f6e68`).
  Dependencies were updated and the audit gate made able to fail (`5a9620a`).
- An inert middleware gate was recorded truthfully instead of being "fixed" (`f22f18f`).
- A `.gitignore` rule that silently dropped new migrations was fixed (`8b122da`).
- SEC-11 replaced the shared initial password with per-account passwords. That went
  against a decision recorded as the owner's, and it was reverted on 09-20 (section 4).
- A hostile pass over the blocker code found two defects that would each have spoiled
  the go-live load (`08e1af4`). One was that the builder issued the first Data Steward
  under a name the demo-account denylist blocks. That is the incident behind the
  CLAUDE.md rule "rename the account, never relax the denylist". Findings left unfixed
  were recorded in the assessment (`8c610f7`).

### 3.5 Late September — rules, smoke, load preparation and follow-ups

- **09-20 — CLAUDE.md (`1d51876`).** Standing rules, each with the incident behind it.
  See section 5.
- **09-20 — Smoke test (`43f74cb`, `005032e`).** `npm run smoke` runs read-only
  checks, each something that has already been wrong here. With the monitor bearer
  (`HEALTH_BEARER`), `--expect-commit <sha>` also confirms which commit production
  runs. Without the bearer that flag is refused, not skipped
  (`scripts/ops/smoke.ts`; AUDITOR-BRIEF §10).
- **09-20 — Sunday test.** A test that read the real clock was red every Sunday
  (`2ea4525`, `c782ff6`).
- **09-20 — Owner decisions.** The shared initial password was restored. Managers sign
  in by class (`3a21013`). There is one Accountant per region (`eff8b57`).
- **09-22 — Load rehearsal (`1148ad8`).**
- **09-23 — Load tooling.**
  - The account bootstrap now refuses the wrong database (`1c7f336`).
  - Credit limits come from RoutePro (`27bcc28`).
  - [`docs/CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md) was added.
- **09-23 → 09-24 — Follow-up fixes.**
  - The visit-day gate named the wrong cause (`1b28e07`, `d834c0a`, `19331c7`,
    `4e104a0`).
  - A zero credit limit is a decision, not a blank (`b67ca69`, `ff3575e`).
  - Payment-terms ownership (`e14ffb7`).
- **09-24 — Re-benchmark.** A new benchmark produced the numbered items 1–41 that later
  commits cite (AUDITOR-BRIEF Appendix A). The first batch landed the same day:
  - outbound alerts through `lib/alert.ts`, Playwright in CI, `post-deploy-smoke` after
    every deploy to `main`, and typecheck before the migrate in the build (`54de6aa`);
  - follow-up fixes to those gates (`ef69595`, `ddd651f`, `3b1632d`);
  - typed routes that really check every link (`fb879c3`, PR #8);
  - schedulers that will really run (`6ff6485`, `99492f4`).

**The go-live load.** The production go-live load followed the runbook in September
2026. This public file does not date it. Its date, manifest, results and reconciliation
are kept privately, in the private handover pack (PRIVATE-HANDOVER.md). HANDOVER §1
names the follow-up operations. Most are operator scripts that write an `AuditLog`
ledger row. Two are not: the `nmwc_app` grant correction
(`scripts/ops/app-role.ts grant`, evidence kept privately) and the F16 sub-channel
clear (an audited `UPDATE` made as the Data Steward).

### 3.6 September 25–27 — benchmark items, auditor brief, service levels

- **Small daily items 36–41 (`86a4eb4`, `666bce8`, `e7db028`).** Phone keypads, screens
  that fit a phone, Call/Directions links, and a flag on a GPS point typed by hand.
- **Windows test runner (PR #9, `310b747`).** The smoke-step scenarios in
  `ci-gates-guard.test.ts` may take minutes on Windows. "Did not finish" is no longer
  read as "failed".
- **Item 22 (`b7d9041`, then `ab5867f`, `2d1e702`, `e5d4043`, `374b0e7`, `30ec23a`).**
  The salesman is told whether a submit arrived, and a retry is never written twice.
- **Item 28 (`b239e4b`, `3e775d4`, `efe3729`).** The master export and the
  field-update report no longer refuse at 25,000 rows. They page by value up to a
  **60,000-row ceiling**. The `/customers` "Export filtered" button is still capped at
  5,000 (AUDITOR-BRIEF §6, §18).
- **Item 16 (`84c5b74`, `306a0d8`).** Duplicate detection gained tests, then the owner's
  matching rules.
- **Item 20 (`8290342`, `215bf41`).** The Steward can fix import problem rows in the app.
- **New customer from a phone (`748a164`).**
- **AUDITOR-BRIEF.md (`4b8a348`).** A brief for an external code auditor. It has been
  kept current since and is the best single description of the system.
- **09-26.** Review follow-ups (`4482c4c`, `7b59180`, `9edcbad`, `14a9356`).
- **09-27 — owner decisions (`a38ef1d`).** An empty phone is filled from a fixed import
  row. Only the roles that attach photos may remove them.
- **09-27 — items 9–13 (`28556d5`, `36a21ab`, `f05752e`, `af795b6`).**
  - Service levels and a Service status page ([`docs/SERVICE-LEVELS.md`](../SERVICE-LEVELS.md)).
  - Logs searchable on Vercel Pro, and crons moved to Vercel.
  - Health severity tiers, and an R2 health check.
  - A secrets inventory ([`docs/SECRETS-INVENTORY.md`](../SECRETS-INVENTORY.md)).
  - The Manager's Service status view leaked other regions' approval figures. It was
    narrowed in `f0e6776` and `dfa0ea9`, and again in `4275f9f` (merged with
    `2060423`).

### 3.7 September 27–29 — the external deep recheck

An external auditor rechecked `af795b6` on 2026-09-27. Every finding was verified
against the code before any change. Fixes then went in batches, each reviewed
adversarially. Status per finding: AUDITOR-BRIEF Appendix B. Findings that need a
business decision were **not** coded; they are listed as "Owner".

**Phase 1 (09-28; merged as `2060423`).** The seven batches were merged in `299caaa`.

| Finding | Fix |
|---|---|
| N01 | Every approval decision is bound to the request the reviewer saw (`77eb204`, `lib/decision-token.ts`) |
| F15 | The forced password change is enforced by every action and route, not only by middleware (`8d25e7f`) |
| F13 | The audit row commits in the same transaction as its change |
| F10 | Status evidence is re-checked at decision time (`d6148e8`) |
| F07, F08 | Account-import transactions and role rules (`4504a04`) |
| F11 | A Temix deactivation is never issued for a code a live customer still holds (`023173c`, `338118f`) |
| F17, N03, N05 | Export and import correctness (`563c5a1`) |
| N07, N08, N09 | Sentry scrubbing, private restore logs, photo-GC failures reported (`60b3587`, `8f0f8ad`, `53761bc`) |

The adversarial pass after the merge found more: browser Sentry still received
on-screen labels, and photo-GC trusted a network failure as "gone" (`64fbc80`,
`0c5db67`, `363a0bb`, `1f3f00a`).

**Phase 2 — edit-form semantics (09-29; merged as `ab6d998`).** Commits `eaad8de` →
`f1ae788`, one migration.

| Finding | Fix |
|---|---|
| F05 | A salesman is gated only on his own route's branches |
| F06 | The form sends only touched fields ("patch v2"), each with the value it was based on. A stale field is refused (`STALE_FIELDS` at submit, `STALE_BEFORE` at approval) |
| F16 | The channel/sub-channel pair is checked everywhere (`lib/channel-pair.ts`) |
| F19 | Phones in Arabic and Persian digits |
| F20 | Optional fields can be cleared |
| N02 | HTML is stripped before the length check |
| F21 | "Counted" equipment and import rescoring |

The design was done before the code: three independent designs, a synthesised spec, a
critic's attack and the lead's rulings. They are in
[`docs/design/phase2-edit-semantics/`](../design/phase2-edit-semantics/README.md). The
owner's answers are in
[`CORRECTIONS.md`](../design/phase2-edit-semantics/CORRECTIONS.md). Post-merge fixes:
`c8066d6` → `5b3c95a`, merged as `95c8a63`. A one-off production rescore then ran
through the operator-script safeguards (`npm run ops:rescore-completeness`, ledger
`CompletenessRescore`; HANDOVER §1). Its results are kept privately.

### 3.8 September 30 – October 1 — handover to other coding agents

- **`f48d298`, `78a16a3`.** [`AGENTS.md`](../../AGENTS.md),
  [`docs/HANDOVER.md`](../HANDOVER.md), the merge-loop helpers in
  [`scripts/dev/`](../../scripts/dev/) and the phase-2 design notes. Until then, what
  another agent needed lived in Claude's private notes.
  `tests/unit/agents-md-guard.test.ts` fails if `AGENTS.md` and `CLAUDE.md` drift.
- **Working agreement (PR #12: `321145c`, `fab4be0`).** Codex builds on `codex/*`
  branches. Claude reviews only Tier B changes. The agreement says the owner merges with
  Rebase and merge. Codex has no production access and never merges or pushes `main`.
  See section 2 for how `main` really moved, and HANDOVER §2.
- **Codex PRs.**
  - #11 CR-recompute ledger and safe refusals (`f488908`, `da1db6f`, `ad18ead`). The
    production recompute itself was closed on 2026-10-04 (section 3.11).
  - #13 4 MiB cap on field-form JSON bodies (`c564c18`).
  - #14 bounded export filters (`8c8a148`).
  - #10 started as a Dependabot runtime update (`24ee6cf`). It was retitled "Update
    runtime packages with Sentry deduplication and safe photo signing" and also
    carries `cd37802` and `3cb3811`.
  - #15 R2 signatures that survive Sentry HTTP tracing (`33c7e69`).
- **Dependabot (10-01).** PR #2 (`eff0e7c`) was merged in GitHub. PRs #3, #4, #6 and #16
  were closed, and their updates landed as direct commits (`8b9f075`, `3824126`,
  `efc7411`, `0e0f063`). PRs #5 and #7 were closed as superseded.

### 3.9 October 2 — public-doc hygiene and the OCT fixes

- **Today and load verification (PR #17: `c87b6da`, `5b2f11e`; PR #18: `7e2b678`,
  `2729045`).** Today no longer silently drops visits after the first page. Load
  verification fails on a partial load instead of passing.
- **Public-doc hygiene (PR #19: `8d9cbe7`, `cd15646`).** Account-state disclosures and
  launch status were removed from public documents. Status is kept privately from then
  on. **This file follows the same rule.** The cleanup was not complete; see section 6.
- **OCT fixes, from an external review report.** Each started with a failing test, run
  on real PostgreSQL where it mattered.

| ID | PR | Commits on `main` | What |
|---|---|---|---|
| OCT-01 | #20 | `06d12a5`, `4c2fd31` | A Manager's direct write re-checks customer and branch scope after it takes the customer lock |
| OCT-02 – OCT-05 | #22 | `f30a600`, `ffe3436`, `082e406` | Form drafts and GPS: controls freeze while sending; a late GPS fix is discarded with a message; drafts and storage failures behave predictably |
| OCT-06 | #21 (closed on GitHub; its commits were cherry-picked to `main`) | `45cac3a`, `b52d13b` (the fix); `0409bee` (the docs recount) | Load verification checks for usable Supervisor-step approver coverage |
| Photo attach scope | #23 (closed on GitHub; its commits were cherry-picked to `main`) | `1b05134`, `e4352b3` | Photo attach re-checks scope under the customer lock |
| Photo Remove scope | #24 | `0e7119b`, `923e0ee` | Photo Remove re-checks scope through the locked transaction |

The original commits of #21 and #23 are still on their `codex/*` branches on GitHub.
Their content is on `main` under the cherry-picked hashes, so there is nothing left to
merge from them.

### 3.10 October 4 — the 2026-10-04 batch (`fe6f65f` → `9d0fd61`)

Small fixes for daily use. Each was built on its own branch and reviewed adversarially.
The integration follow-ups were then reviewed together (AUDITOR-BRIEF §18, "Closed by
the 2026-10-04 batch"). The batch reached `main` from an integration branch with no
pull request (section 2).

| Commit | What |
|---|---|
| `fe6f65f` | Sign-in trims the username and turns off phone auto-correct |
| `ca4c2d1` | X-AUTH-2: the per-network sign-in limit counts only failed sign-ins (owner decision of the day; `refundLimit` in `lib/rate-limit.ts`) |
| `bda75b1` | Password change and reset ask for the new password twice and can show it |
| `2a17e73` | Approvals: Select all stops at the bulk limit (`lib/bulk-run.ts`); the header shows the real pending count |
| `97d7d16` | Today lists the salesman's route branches with no visit day (`/today?view=no-day`) |
| `3875ce2` | The Users page marks active accounts that have not signed in yet or still have a password change pending |
| `2195b2d` | Approvers land on Approvals; the Steward's menu links to Audit |
| `0465f3e`, `e6d26c0`, `8e5a516` | The May pilot checklist is retired ([`docs/LAUNCH-CHECKLIST.md`](../LAUNCH-CHECKLIST.md)); OPERATIONS describes only controls that exist |
| `a86ac19`, `9d0fd61` | Review follow-ups: a per-user refusal gives the network token back; docs match |

**Not done in that batch:** the generated guides in `docs/guide/` were not rebuilt.
They still carry old wording in places (AUDITOR-BRIEF §18), and the set has no
Approvers guide and no Arabic Data Steward guide. The sources were updated:
`scripts/build-role-guides.ts` (in `0465f3e`, `e6d26c0`, `8e5a516`, `a86ac19`) and
`docs/guide/NMWC-CRM-USER-GUIDE.html` (in `8e5a516`).

**A newer guide set exists outside the repository.** On 2026-10-04 a new English and
Arabic set was produced from the code and given to users: PDFs for Salesman, Manager,
Approvers and Data Steward, the how-the-system-works guide, and an owner checklist. It
is in the private handover pack (`guides/`, and `golive-data/guides-2026-10-04/` with
its content JSON and renderer; PRIVATE-HANDOVER.md). So `docs/guide/` is stale, and it is
**not** what users hold. Whether the new set replaces `docs/guide/` (after a review for
private material, because the repository is public) or `docs/guide/` is rebuilt is a
pending decision ([`04-PENDING-WORK.md`](04-PENDING-WORK.md) B1.6). When you answer a
support question, answer from the set users received.

If `docs/guide/` is rebuilt instead:

- `npm run guide:roles` rebuilds the role guides (HTML and PDF) from
  `scripts/build-role-guides.ts`. It renders locally with Playwright's Chromium and
  uses no database.
- `npm run guide:pdf` re-renders the combined user guide's PDF from its HTML.
- **Do not run `guide:capture` or `guide:build`.** They sign in to a live deployment to
  re-take screenshots. `scripts/capture-guide-screenshots.ts` points at the production
  URL and carries pilot credential literals (AUDITOR-BRIEF §14).
- Check the new PDFs before committing them. The existing screenshots were captured
  from production in May (AUDITOR-BRIEF §14).

### 3.11 October 4 — handover to a new person

The owner is handing the project to a new person. Recorded for that handover:

- **The documentation set.** These `docs/handover/` documents (01–08) and
  [`HANDOVER-START-HERE.md`](../../HANDOVER-START-HERE.md) are public and link to the
  existing records rather than copying them. They reached `main` after `9d0fd61`,
  together with the rebuilt knowledge graph. The same change adds `*.tmp.ts` to
  `.gitignore`, so an operator script copied into a checkout under that name stays out
  of commits. Delete such a copy after use anyway.
- **The private pack.** All private material goes into one encrypted pack, handed over
  offline. **Nothing private goes to GitHub.** The pack is sealed only after this
  documentation set is merged to `main`, so the repository bundle inside it contains
  the set. PRIVATE-HANDOVER.md records the `main` commit the pack was built from. The
  pack holds:
  - environment files, `golive-data/`, the private backups, operator notes and source
    spreadsheets;
  - the chat history: the Claude app's official exports of all three NMWC CRM chat
    sessions (the conversation, sub-agent transcripts and metadata), and the raw
    Claude Code project folders for them (`*.jsonl` transcripts, sub-agent and
    workflow transcripts, tool results);
  - Claude's memory, and Codex's private notes (in `NMWC-Private-Backups`). Codex's
    own local history (`~/.codex`) is **not** in the pack.

  Values that are in no local env file are **not** in the pack either: `CRON_SECRET`,
  `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN`, `BACKUP_AGE_*` and the other values kept
  only in GitHub or Vercel. GitHub secrets and Vercel sensitive variables cannot be read
  back. If no copy exists elsewhere, whoever holds those accounts must regenerate them,
  and that is a rotation
  ([`02-ACCESS-ACCOUNTS-AND-SECRETS.md`](02-ACCESS-ACCOUNTS-AND-SECRETS.md)).
- **The backup decryption key is not in the pack.** The age private key that decrypts
  the nightly encrypted dumps was not found on the owner's computer, and it is not in
  the pack. GitHub's `BACKUP_AGE_IDENTITY` secret cannot be read back. Without that key
  nobody else can decrypt any dump. It is the owner's first action before handing over:
  put a copy of the key in the pack, or add the new person's age recipient and prove
  one decrypt.
- **Who approves merges after the handover** is for the owner and the new person to
  agree. It is on the fill-in list in PRIVATE-HANDOVER.md (section 2, "At handover").
- **Product and business decisions after the handover** belong to the person the owner
  names in PRIVATE-HANDOVER.md. Until someone is named, they stay with the owner
  (section 4).
- **Credential rotation is the owner's decision.** The recorded choice is to do it last,
  after the functional work (AUDITOR-BRIEF §12). Follow
  [`docs/CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md). Its status at handover is
  recorded in PRIVATE-HANDOVER.md.
- **Claude's production-write permission** (granted 2026-09-27, HANDOVER §4) was kept
  for a transition period only. It ends on the date recorded in PRIVATE-HANDOVER.md.
  After that, the new person decides whether any agent keeps production access.
- **Two open data items were closed on 2026-10-04:**
  - The May-2026 pilot edit requests that were still open were all deleted, on the
    owner's decision. The deletion is audited, and a backup is in the private pack.
    None is pending (HANDOVER §6.2).
  - The CR-number normalisation recompute (item 16): a read-only production dry run
    found nothing to recompute. The item is closed (HANDOVER §6.2).
- **The knowledge graph** in `graphify-out/` (first committed 2026-07-21) was rebuilt
  on 2026-10-04 from `main` at `9d0fd61`: 4,602 nodes, 10,495 links and 226 clusters,
  built with graphify 0.8.44 (`uv tool install graphifyy==0.8.44`). Start at
  [`graphify-out/wiki/index.md`](../../graphify-out/wiki/index.md). `graph.html` needs
  internet access, because it loads the vis-network library from unpkg.com. See
  [`08-KNOWLEDGE-GRAPH.md`](08-KNOWLEDGE-GRAPH.md). `graphify-out/` is committed to a
  **public** repository. Any rebuild must start from the tracked files only, never
  from a working folder that holds `golive-data/`, an `.env`, backups or transcripts.
  Check `graphify-out/manifest.json` and the output for private material and local
  paths before committing.
- **Things a GitHub clone does not bring:**
  - `golive-data/`, the `.env` files and everything else that is gitignored;
  - about 60 local branches and about two dozen worktrees under `.claude/worktrees/` on
    the owner's machine. Roughly half carry commits whose hashes are not on `main`.
    Most look like per-batch branches (`p2/*`, `p2fix/*`, `pmfix/*`, `fix/*`,
    `worktree-*`) whose work reached `main` through integration branches under new
    hashes. Nobody has checked that commit by commit. Do not delete any of them
    without the owner (HANDOVER §6.4);
  - the older **ICO Customer Portal**, a separate codebase. Whether it travels with the
    project is the owner's call.
- **Unmerged work that is on GitHub:** branch `claude/nervous-saha-580313` holds the
  July sweep for never-attached photo uploads (two commits labelled GAP-03/Q4, the May
  label). It was never merged (AUDITOR-BRIEF §18).

---

## 4. Major decisions and why

"Owner" means the product owner made the call. A recorded owner decision is not
re-argued in code. If you think one is wrong, ask (CLAUDE.md, "When the record says
something is the owner's decision"). Fuller lists: HANDOVER §4 and AUDITOR-BRIEF §12.

| Date | Decision | Why | Recorded in |
|---|---|---|---|
| 2026-05-11 | Phone not unique; exact-only duplicate matching | One owner can have several shops with one phone. The fuzzy duplicate detector was too noisy | [`docs/CHANGELOG.md`](../CHANGELOG.md) v1.0.1; AUDITOR-BRIEF §12 |
| 2026-05-10 → **reversed** 2026-07-15 | The pilot's one-branch-per-customer flattening was undone: many branches per customer (1:N) | The schema was always 1:N; real customers have several shops | [Blueprint §0](../discovery/NMWC-CRM-Consolidation-Blueprint.md) and C6; AUDITOR-BRIEF §1 |
| 2026-07-15 | Build on this codebase; the ICO Customer Portal gives requirements, not code | This codebase already had the typed master, access control, audit, photos, deploy and backup | [Blueprint §0](../discovery/NMWC-CRM-Consolidation-Blueprint.md) |
| 2026-07-15 | The CRM **aids** the Temix ERP and does not replace it. The link is a batch Excel file | Temix stays the system of record for transactions and the customer code. There is no live Temix API | Blueprint §0–§1; AUDITOR-BRIEF §1 |
| 2026-07-15 | 8 roles. Chains: UPDATE = Supervisor; CASH create = Supervisor → Accountant; CREDIT create = Supervisor → Finance Manager → GM → Accountant. GM always required for credit. FM/GM approve figures but cannot amend them. Reject steps back one approver at a time | Owner's operating model, with a finance tier for credit | Blueprint §0; `lib/approval-chains.ts` |
| 2026-07-19 | Vercel functions in `iad1` instead of `fra1` (live from 2026-09-14) | Run beside the Neon database in AWS us-east-1. It matters for data residency (B6) and explains the latency notes in HANDOVER §7 | `605d161`; `vercel.json`; [`docs/compliance/`](../compliance/) |
| 2026-07-20 | D1: workweek Sun–Thu | Drives all SLA arithmetic | [`qa/reports/OWNER-DECISIONS.md`](../../qa/reports/OWNER-DECISIONS.md) |
| 2026-07-20 | D2: credit limit and terms are CRM-owned and pushed to Temix | Owner answer. **Still open:** the inbound refresh treats Temix as authoritative (the "D2 note") | OWNER-DECISIONS.md; AUDITOR-BRIEF §15 |
| 2026-07-20 | D4: Temix header contract defined by the CRM | The owner will format the real export to the CRM's headers. Not yet confirmed with Temix (item 5) | OWNER-DECISIONS.md; AUDITOR-BRIEF Appendix A |
| 2026-07-20 → 09-27 | D3 scheduler: left open on 07-20; an external cron service on 09-14 (`1ebcabb`); Vercel crons after the move to Vercel Pro on 09-27 | The Hobby plan had no sub-daily cron. Retiring the external jobs is still an owner step | [`docs/OPERATIONS.md`](../OPERATIONS.md) §5d; HANDOVER §6.2 |
| Pending | D5: Vercel Preview builds isolated from the production database | Still marked pending in OWNER-DECISIONS.md. Other records say Preview builds use the UAT branch (AUDITOR-BRIEF §3, HANDOVER §2 step 4); that is a Vercel setting the repo cannot show. Confirm it | OWNER-DECISIONS.md; AUDITOR-BRIEF §15 |
| 2026-09-10 | Salesman submit gate is **CORE** (channel, phone, contact, address, GPS, shop photo). `SALESMAN_SUBMIT_GATE=FULL` restores the full rule | The imported master lacks the other fields, and many customers have no CR or signboard | `27f3d94`; `lib/submit-gate.ts`; HANDOVER §4 |
| 2026-09-10 | Route-code usernames, one shared initial password, forced change at first sign-in | Simple to hand out in the field. Per-account passwords were built on 09-15 (SEC-11) and reverted on 09-20, because the choice was the owner's. The accepted risk is recorded in HANDOVER §4 and AUDITOR-BRIEF §12 | HANDOVER §4; AUDITOR-BRIEF §12 |
| 2026-09-10, 09-20 | No Supervisor accounts: Managers supervise their own salesmen. Managers sign in by class. One Accountant per region; one Finance Manager and one GM | Matches the real organisation. A class login outlives the person in it | HANDOVER §4; `3a21013`, `eff8b57` |
| 2026-09-25 | Item 22: no offline queue and no auto-retry; a submission id makes a retry safe | Keep the form honest without building an offline system | `b7d9041`; AUDITOR-BRIEF §12 |
| 2026-09-25, amended 09-27 | Items 16/20: duplicate and import-fix rules (any region, collapsed spacing, Arabic/Persian digits in CR numbers, dismissals that lapse) | Owner's answers to the review questions | HANDOVER §4; `306a0d8`, `a38ef1d` |
| 2026-09-27 | The repository stays **public** | Owner's call. **Accepted risk:** current files and history contain the material listed in AUDITOR-BRIEF §14 | HANDOVER §4; AUDITOR-BRIEF §14 |
| 2026-09-27 | Only Salesman (own captures), Steward and Manager remove photos | Approval-only roles should not delete evidence | `a38ef1d`; HANDOVER §4 |
| 2026-09-27 | Claude may write to production through operator scripts, with safeguards, until the owner says "done". The grant does not cover merges (each still needs the owner's "merge it"), credential rotation or any other agent | Production fixes needed an operator; the safeguards keep it auditable | HANDOVER §4–§5 |
| Not dated in the repo | Credential rotation is the owner's, and is to be done last, after the functional work | Owner's sequencing | AUDITOR-BRIEF §12; [`docs/CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md) |
| 2026-09-29 | Phase 2 answers: an import channel change clears a foreign sub-channel; the CR number is clearable; "Counted" can be ticked by a salesman but not unticked; no backfill | Owner's answers to the phase-2 critic | [`CORRECTIONS.md`](../design/phase2-edit-semantics/CORRECTIONS.md); HANDOVER §4 |
| 2026-09-30 | Working agreement: Tier A/B review, owner-only merges with Rebase and merge, no production access for Codex, and Codex never merges or pushes `main` | Let a second agent build safely while the owner keeps control of production. Practice differed: the owner approved each merge in words and Claude pushed it; see section 2 | HANDOVER §2; [`AGENTS.md`](../../AGENTS.md) preface |
| 2026-10-04 | X-AUTH-2: the per-network sign-in bucket counts failed sign-ins only | Many people sign in from one office address. Successes alone emptied the bucket. Trade-offs are stated in HANDOVER §6.1 | `ca4c2d1`; HANDOVER §6.1 |
| 2026-10-04 | The May-2026 pilot edit requests that were still open are deleted, rather than approved or rejected | Owner's call. The deletion is audited and a backup is kept privately | HANDOVER §6.2; section 3.11 |
| 2026-10-04 | Claude's production-write grant is kept for a transition period. It ends on the date recorded in PRIVATE-HANDOVER.md; after that the new person decides | The owner is handing over. The person taking over decides whether to keep, narrow or end it | HANDOVER §4; PRIVATE-HANDOVER.md |
| 2026-10-04 | Private material handed over offline in one encrypted pack; nothing private on GitHub | The repository is public | Section 3.11; the private handover pack (PRIVATE-HANDOVER.md) |

Decisions still **waiting** on an owner: F02, F04, F09, F12/E5, F14, N04,
X-APPR-1(a), SLA budgets and others (HANDOVER §6.1–§6.2, AUDITOR-BRIEF §18); D5; the
switch to `nmwc_app` (item 14; whether it has been made is recorded in
PRIVATE-HANDOVER.md); the restore-drill secrets; and, new at handover, who approves
merges (section 2) and whether the newer guide set replaces `docs/guide/`
(section 3.10). Do not implement them as code tasks without an answer.

**Who answers them after the handover.** Product and business decisions pass to the
person the owner names in PRIVATE-HANDOVER.md (a fill-in item). Until someone is named,
the owner decides. Who approves merges is for the owner and the new person to agree.

---

## 5. Incidents that became rules

### Rules in CLAUDE.md

Each standing rule in [`CLAUDE.md`](../../CLAUDE.md) names the incident behind it. This
table links the main ones to the history, so you can read the commits.

| Rule (CLAUDE.md) | Incident behind it | Where to read more |
|---|---|---|
| Never write to the production database (`ep-sweet-haze`) | `prisma/seed-muscat-pilot.ts` would revive accounts an operator had just deactivated | CLAUDE.md "Safety"; AUDITOR-BRIEF §11 says how true the rule is in code |
| Never let a secret reach a log or transcript; put complex strings in a script file, never `node -e` | A double-quoted `node -e` echoed part of a production role password into a transcript, and the role had to be rotated | CLAUDE.md "Safety"; HANDOVER §8 |
| `npm run smoke` before and after any production change | Production served a four-month-old build for weeks, and nobody could tell (found 2026-09-14, B1) | `43f74cb`, `005032e`; `post-deploy-smoke` in CI (`54de6aa`) |
| Gate a merge on CI's exit code for the exact head SHA | A status check chained with `&&` pushed a red commit to `main` | `scripts/dev/ci-watch-sha.sh` |
| Typecheck and lint run before `prisma migrate deploy` | Migrations run before `next build`, so a build failure leaves production migrated but undeployed | `54de6aa`; `tests/unit/ci-gates-guard.test.ts` |
| Audit rows only through `writeAudit()` | A broken ESLint selector fails open, and the build continues unlinted | `990e459`, `a7ef425`; `tests/unit/audit-guard.test.ts` |
| Never reorder the content-security-policy | The May blank page (2026-05-10, `b596680` → `d9b4658`) had a different cause, a missing nonce. The ordering hazard that leads to the same blank page was found and pinned on 2026-09-15 (`5ecda53`) | `lib/csp.ts`, `tests/unit/csp.test.ts` |
| Never relax the demo-account denylist; rename the account | The builder issued the first Steward under a denylisted name (2026-09-15, `08e1af4`) | `lib/demo-accounts.ts` |
| Never assert a clock-reading fixture against a literal | A test read the real clock and was red every Sunday (2026-09-20, `2ea4525`, `c782ff6`) | `tests/integration/golive-update-flow.test.ts` |
| On Windows, "did not finish" is not "failed" | Smoke-step scenarios killed by a spawn budget read as wrong answers (2026-09-25) | PR #9, `310b747` |
| When the record says it is the owner's decision, ask | Per-account initial passwords were built against a recorded owner decision (2026-09-15) and reverted (2026-09-20) | HANDOVER §4; AUDITOR-BRIEF §12 |
| Run an adversarial pass after every substantial merge | It has found real defects every time, for example `4e88812`, `08e1af4`, `8c610f7` | CLAUDE.md "Process" |

### Lessons and controls (not CLAUDE.md rules)

These are worth knowing, but they are not written as rules in CLAUDE.md or AGENTS.md.

| Incident | When / where | Lesson or control |
|---|---|---|
| The restore drill was gated off for months and could not have failed anyway | 2026-05-10 `a05cb5e`; found 2026-09-14 | A restore is proven on every push (`restore-chain`, `b587754`). The real drill has never succeeded: its scheduled run on 2026-10-01 failed at preflight on the missing `NEON_*` secrets |
| A nightly-backup check would have killed every backup; CI was green because the fixture was tiny | 2026-09-14, `4e88812` | Fixtures must be big enough to exercise the real path |
| A `.gitignore` rule silently dropped new migrations | 2026-09-15, `8b122da` | Check what a commit really adds, not only what you meant to add |

---

## 6. Patterns worth knowing

- **Adversarial passes find real defects every time.** Almost every substantial merge
  above has a follow-up commit titled "Close what the review … found". Keep doing it,
  including over your own work (CLAUDE.md, "Process").
- **Documents drift; the code does not lie.** Old reports describe controls that were
  later changed or never existed (AUDITOR-BRIEF §15). When a document and the code
  disagree, believe the code and fix the document.
- **Owner decisions are recorded, not re-litigated.** The cost of breaking this was a
  full revert on 2026-09-20.
- **Status belongs in private records, and the cleanup is not finished.** Since PR #19
  the policy is that production totals, account state and rollout status stay out of
  public files. Some current public files still carry production figures and dated
  production outcomes from before that policy (parts of `AUDITOR-BRIEF.md` and the May
  sections of `docs/CHANGELOG.md` among them), and so do some commit messages.
  Scrubbing the current files is a handover cleanup task. Commit messages cannot be
  changed without rewriting history. Do not add new figures to any public file or
  commit message.
- **Work was done by people and AI agents together.** The owner made the decisions and
  approved the merges. Claude (Claude Code) built, reviewed, operated, and carried out
  almost every approved merge (section 2). Codex built on `codex/*` branches from
  2026-09-30 and never merged or pushed `main`. Most commits made with Claude carry a
  `Co-Authored-By: Claude …` trailer; some early ones do not. Codex commits carry no
  trailer; you recognise Codex work by its `codex/*` pull-request branch.

---

## 7. Where to go next

- How the system works today: [`AUDITOR-BRIEF.md`](../../AUDITOR-BRIEF.md).
- How a change is made and merged, and what is open: [`docs/HANDOVER.md`](../HANDOVER.md)
  and, for the push procedure that moved `main`,
  [`03-OPERATIONS-AND-DEPLOYMENT.md`](03-OPERATIONS-AND-DEPLOYMENT.md) §4.
- Standing rules: [`CLAUDE.md`](../../CLAUDE.md) and [`AGENTS.md`](../../AGENTS.md).
- Operating production: [`docs/OPERATIONS.md`](../OPERATIONS.md),
  [`docs/GO-LIVE-RUNBOOK.md`](../GO-LIVE-RUNBOOK.md),
  [`docs/SECRETS-INVENTORY.md`](../SECRETS-INVENTORY.md),
  [`docs/CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md).
- The knowledge graph: [`08-KNOWLEDGE-GRAPH.md`](08-KNOWLEDGE-GRAPH.md).
- Everything private: the private handover pack (PRIVATE-HANDOVER.md).
- The rest of this handover set: [`HANDOVER-START-HERE.md`](../../HANDOVER-START-HERE.md),
  then [`docs/handover/`](./) 01–08 (08 is the knowledge graph).
