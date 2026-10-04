# Roadmap and service levels

> 48 nodes · cohesion 0.06

## Key Concepts

- **NMWC Unified CRM Consolidation Project Description** (20 connections) — `docs/PROJECT-DESCRIPTION.md`
- **NMWC Service Levels** (12 connections) — `docs/SERVICE-LEVELS.md`
- **NMWC Post-launch Enhancement Roadmap** (11 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Wave 1: must add before full-scale launch** (6 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Outbound alert webhook ALERT_WEBHOOK_URL (GAP-2)** (5 connections) — `docs/OPERATIONS.md`
- **Vercel Pro crons run keep-warm, SLA sweep, photo GC and retention sweep** (4 connections) — `docs/OPERATIONS.md`
- **Approval SLA notifications and escalation** (4 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Production observability: structured logging, traces, alerting** (4 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Atomic-claim concurrency on every transition** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Eight roles: adds Accountant, Finance Manager and GM** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Fail-closed region/route scoping for unscoped Managers and Accountants** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Build phases 1a-1e (data model, approval engine, CREATE, Temix sync, SLA)** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Temix batch sync with flip-first-then-snapshot** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Working-hours SLA calendar (Asia/Muscat, Friday off, 08:00-17:00)** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Central scope helpers in lib/access.ts (loadScope, canSeeCustomer, assertCanAccessAttachment)** (4 connections) — `docs/REMEDIATION-REPORT.md`
- **Owner decision: SLA workweek Sunday-Thursday** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Fixed four-hour clock-window alert dedup per event+severity+scope** (3 connections) — `docs/OPERATIONS.md`
- **Arabic UI (RTL) for salesman and supervisor surfaces** (3 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Playwright end-to-end suite for submit-approve-reactivate-merge** (3 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Real ERP integration channel (signed webhook out, import endpoint in)** (3 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **Offline-first capture for salesman edits** (3 connections) — `docs/POST-LAUNCH-ROADMAP.md`
- **CodeSequence provisional code allocation (NMWC-YYYY-NNNNNN) at finalize** (3 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Credit create chain: Supervisor, Finance Manager, GM, Accountant (GM always)** (3 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Step-back reject cascade with loop guard** (3 connections) — `docs/PROJECT-DESCRIPTION.md`
- **Temix ERP: system of record fed by batch Excel uploads** (3 connections) — `docs/PROJECT-DESCRIPTION.md`
- *... and 23 more nodes in this community*

## Relationships

- [[Operations runbook]] (8 shared connections)
- [[Master session record and assessment]] (6 shared connections)
- [[Production-readiness verification]] (4 shared connections)
- [[May 2026 audits and remediation]] (4 shared connections)
- [[NMWC Customer Master Technical Specifica area]] (3 shared connections)
- [[Original PRD and UX spec]] (3 shared connections)
- [[Session Handoff 2026-05-10 area]] (3 shared connections)
- [[NMWC Independent QA / Security / Reliabi area]] (2 shared connections)

## Source Files

- `docs/OPERATIONS.md`
- `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- `docs/OPUS-QA-EXECUTION-PLAN.md`
- `docs/POST-LAUNCH-ROADMAP.md`
- `docs/PROD-LOAD-AND-BUGS.md`
- `docs/PROJECT-DESCRIPTION.md`
- `docs/REMEDIATION-REPORT.md`
- `docs/SERVICE-LEVELS.md`
- `docs/SESSION-HANDOFF-2026-05-10.md`
- `docs/SESSION-MASTER-RECORD.md`

## Audit Trail

- EXTRACTED: 134 (77%)
- INFERRED: 41 (23%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*