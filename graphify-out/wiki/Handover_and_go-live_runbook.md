# Handover and go-live runbook

> 45 nodes · cohesion 0.09

## Key Concepts

- **docs/GO-LIVE-RUNBOOK.md** (28 connections) — `docs/GO-LIVE-RUNBOOK.md`
- **docs/HANDOVER.md** (28 connections) — `docs/HANDOVER.md`
- **Least-privilege role nmwc_app (scripts/ops/app-role.ts)** (14 connections) — `AUDITOR-BRIEF.md`
- **Sensitive material inventory (section 14)** (12 connections) — `AUDITOR-BRIEF.md`
- **Shared initial password with forced change (owner decision)** (10 connections) — `AUDITOR-BRIEF.md`
- **Pre-load owner items (section 0: rotation, B3-B6)** (10 connections) — `docs/GO-LIVE-RUNBOOK.md`
- **Owner recorded decisions (section 4)** (10 connections) — `docs/HANDOVER.md`
- **Owner-only actions (section 6.2)** (10 connections) — `docs/HANDOVER.md`
- **Provision app role workflow (create, grant, verify; B4 step 1)** (8 connections) — `.github/workflows/provision-app-role.yml`
- **Append-only audit ledger (nmwc_forbid_audit_mutation triggers)** (7 connections) — `AUDITOR-BRIEF.md`
- **Production Neon database** (7 connections) — `AUDITOR-BRIEF.md`
- **--expect-host guard (wrong-database incident 2026-09-23)** (7 connections) — `docs/GO-LIVE-RUNBOOK.md`
- **Operator-script convention: dry run, --expect-host, --apply, ledger** (7 connections) — `docs/HANDOVER.md`
- **Demo-account denylist (DEMO_ACCOUNTS_DISABLED)** (6 connections) — `AUDITOR-BRIEF.md`
- **Rule: owner decisions are not code tasks; ask** (6 connections) — `CLAUDE.md`
- **scripts/golive/bootstrap-accounts.ts (Steward and managers)** (6 connections) — `docs/GO-LIVE-RUNBOOK.md`
- **scripts/dev/prod-run.cjs (masked production runner)** (6 connections) — `docs/HANDOVER.md`
- **Rule: never relax the demo-account denylist; rename the account** (5 connections) — `CLAUDE.md`
- **Rule: golive-data/ is customer PII and generated passwords** (5 connections) — `CLAUDE.md`
- **Same-day login handout with forced password change** (5 connections) — `docs/GO-LIVE-RUNBOOK.md`
- **Rotate the Neon owner password before load** (5 connections) — `docs/GO-LIVE-RUNBOOK.md`
- **Claude standing production-write permission (2026-09-27)** (5 connections) — `docs/HANDOVER.md`
- **Production CR-number recompute pending (item 16)** (5 connections) — `docs/HANDOVER.md`
- **Production operations and their AuditLog ledgers** (5 connections) — `docs/HANDOVER.md`
- **CI job db-tests (Postgres integration suites)** (5 connections) — `.github/workflows/ci.yml`
- *... and 20 more nodes in this community*

## Relationships

- [[Auditor brief]] (35 shared connections)
- [[Standing rules (CLAUDE.md, AGENTS.md)]] (30 shared connections)
- [[docs/CHANGELOG.md area]] (15 shared connections)
- [[Monthly restore drill on an emptied Neon area]] (11 shared connections)
- [[CI job post-deploy-smoke (GAP-08) area]] (4 shared connections)
- [[Scheduled work: Vercel crons and GitHub  area]] (4 shared connections)
- [[Phase 2 design notes]] (2 shared connections)
- [[docs/BUILD-REPORT.md area]] (1 shared connections)
- [[NMWC go-live import templates README area]] (1 shared connections)
- [[Enterprise readiness assessment]] (1 shared connections)

## Source Files

- `.github/workflows/ci.yml`
- `.github/workflows/provision-app-role.yml`
- `AUDITOR-BRIEF.md`
- `CLAUDE.md`
- `docs/BUILD-REPORT.md`
- `docs/GO-LIVE-RUNBOOK.md`
- `docs/HANDOVER.md`

## Audit Trail

- EXTRACTED: 232 (82%)
- INFERRED: 52 (18%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*