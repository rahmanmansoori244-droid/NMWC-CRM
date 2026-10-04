# May 2026 audits and remediation

> 42 nodes · cohesion 0.08

## Key Concepts

- **Session Handoff 2026-05-09** (19 connections) — `docs/SESSION-HANDOFF-2026-05-09.md`
- **Audit 03: Bulk Import / Export and Excel Handling** (17 connections) — `docs/audit/03-imports-exports.md`
- **Audit 01: Auth and Session (adversarial)** (15 connections) — `docs/audit/01-auth-session.md`
- **Audit 02: Edit Lifecycle (pre-production pass)** (14 connections) — `docs/audit/02-edit-lifecycle.md`
- **NMWC Remediation Report (Critical + High closures)** (13 connections) — `docs/REMEDIATION-REPORT.md`
- **Fix campaign closing 6 Critical and 34 High findings** (10 connections) — `docs/SESSION-HANDOFF-2026-05-09.md`
- **Production Load Test and Five Expert Bug Hunt (2026-05-09)** (8 connections) — `docs/PROD-LOAD-AND-BUGS.md`
- **User.sessionsRevokedAt session-revocation marker** (6 connections) — `docs/audit/01-auth-session.md`
- **F-02: account-master self-promotion guard (QA-011) bypassable** (6 connections) — `docs/audit/03-imports-exports.md`
- **Day-1 support symptom-to-action table** (5 connections) — `docs/OPERATIONS.md`
- **PROD-002: disabled user retains access for the JWT lifetime** (5 connections) — `docs/PROD-LOAD-AND-BUGS.md`
- **7-agent adversarial audit (docs/audit 01-07)** (5 connections) — `docs/SESSION-HANDOFF-2026-05-09.md`
- **AUTH-07: no last-Manager lockout protection** (4 connections) — `docs/audit/01-auth-session.md`
- **Remediation items claimed fixed but not (QA-011, QA-025/048, QA-047, QA-044)** (4 connections) — `docs/audit/07-cross-check.md`
- **Pre-launch ops checklist (DEMO_ACCOUNTS_DISABLED, HEALTH_BEARER, CRON_SECRET)** (4 connections) — `docs/SESSION-HANDOFF-2026-05-09.md`
- **AUTH-01: disabled user keeps access for up to 5 minutes** (3 connections) — `docs/audit/01-auth-session.md`
- **AUTH-02: stale role for up to 5 minutes after promote/demote** (3 connections) — `docs/audit/01-auth-session.md`
- **AUTH-04: no in-app way to change a user's role** (3 connections) — `docs/audit/01-auth-session.md`
- **AUTH-08: Manager can reset a peer Manager's password without notification** (3 connections) — `docs/audit/01-auth-session.md`
- **EL-14: any Manager can approve any region's edit** (3 connections) — `docs/audit/02-edit-lifecycle.md`
- **EL-15: Manager self-approval of a crafted SUBMITTED edit** (3 connections) — `docs/audit/02-edit-lifecycle.md`
- **Route moves only through the Steward account-master import (F-18 REASSIGN audit)** (3 connections) — `docs/OPERATIONS.md`
- **Periodic JWT freshness re-check of isActive and role** (3 connections) — `docs/PROD-LOAD-AND-BUGS.md`
- **PROD-003: stale role in JWT after role change** (3 connections) — `docs/PROD-LOAD-AND-BUGS.md`
- **Demo accounts and the DEMO_ACCOUNTS_DISABLED switch** (3 connections) — `docs/SESSION-HANDOFF-2026-05-09.md`
- *... and 17 more nodes in this community*

## Relationships

- [[Cross-domain and RBAC audits]] (14 shared connections)
- [[Master session record and assessment]] (11 shared connections)
- [[NMWC Independent QA / Security / Reliabi area]] (6 shared connections)
- [[Original PRD and UX spec]] (5 shared connections)
- [[NMWC Customer Master Technical Specifica area]] (4 shared connections)
- [[Operations runbook]] (4 shared connections)
- [[Roadmap and service levels]] (4 shared connections)
- [[End-to-end verification and seeds]] (2 shared connections)
- [[Session Handoff 2026-05-10 area]] (2 shared connections)
- [[Production-readiness verification]] (1 shared connections)
- [[Photo upload and R2]] (1 shared connections)
- [[Phase 2 design notes]] (1 shared connections)

## Source Files

- `docs/OPERATIONS.md`
- `docs/PROD-LOAD-AND-BUGS.md`
- `docs/QA-AUDIT-REPORT.md`
- `docs/REMEDIATION-REPORT.md`
- `docs/SESSION-HANDOFF-2026-05-09.md`
- `docs/SESSION-MASTER-RECORD.md`
- `docs/TECH-SPEC.md`
- `docs/audit/01-auth-session.md`
- `docs/audit/02-edit-lifecycle.md`
- `docs/audit/03-imports-exports.md`
- `docs/audit/07-cross-check.md`

## Audit Trail

- EXTRACTED: 173 (88%)
- INFERRED: 24 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*