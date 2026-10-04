# Production-readiness verification

> 42 nodes · cohesion 0.08

## Key Concepts

- **NMWC Master Production-Readiness and UAT Execution Plan (Opus 4.8)** (22 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **NMWC Production-Readiness Test and Validation Plan (Opus QA)** (22 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **Verified contradictions C1-C24 between claimed protections and code** (11 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **Final go-live gates (Deliverable 24)** (6 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **RK-10: real Temix header row and file anomalies cannot be closed with synthetic data** (5 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **Errata E1: db:synthetic:reset is an unguarded TRUNCATE CASCADE (stop condition)** (4 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **Errata E2: CREATE import lane defaults absent payment terms to CASH** (4 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **Risk register RK-1 to RK-12** (4 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **RK-3: large master promote times out and strands the batch in PROMOTING** (4 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **C11: Supervisor can approve a Manager-only reactivation via the generic engine** (4 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C5: synthetic.ts --reset truncates all users and customers with no hostname guard** (4 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C8: full-master promote times out leaving the batch stuck PROMOTING** (4 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **Isolation gate with QA-ISOLATION-OK sentinel row** (4 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **Reactivation lane fixes for C11/C12/C13 (WRONG_LANE guards, atomic claim)** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Opus 4.8 master execution handover, Stages 1-14** (3 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **Three-environment separation: Local (A), Online UAT (B), Production (C)** (3 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **Online UAT deployment plan for Environment B** (3 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **C12: reactivation approve lacks an atomic claim** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C13: rejectReactivationAction lacks isReactivation and state guards** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C17: no DB unique index on crNumberNorm** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C1: middleware authorized() gate is inert under next-auth beta** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C21: client Sentry config is dead code** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C2: live pilot credentials hard-coded in committed files** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **C9: Temix batch cap counts customers while rows are emitted per branch** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- **Execution phases A-Q with application fixes only in Phase P** (3 connections) — `docs/OPUS-QA-EXECUTION-PLAN.md`
- *... and 17 more nodes in this community*

## Relationships

- [[Master session record and assessment]] (15 shared connections)
- [[Roadmap and service levels]] (4 shared connections)
- [[Operations runbook]] (2 shared connections)
- [[NMWC Independent QA / Security / Reliabi area]] (2 shared connections)
- [[May 2026 audits and remediation]] (1 shared connections)
- [[Master-Plan Execution Record (2026-07-20 area]] (1 shared connections)
- [[Customer import service tests]] (1 shared connections)
- [[Middleware, CSP and maintenance]] (1 shared connections)

## Source Files

- `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- `docs/OPUS-QA-EXECUTION-PLAN.md`
- `docs/PROJECT-DESCRIPTION.md`
- `docs/QA-AUDIT-REPORT.md`
- `docs/SESSION-MASTER-RECORD.md`
- `docs/audit/03-imports-exports.md`

## Audit Trail

- EXTRACTED: 139 (82%)
- INFERRED: 30 (18%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*