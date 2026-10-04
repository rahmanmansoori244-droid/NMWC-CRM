# Master session record and assessment

> 42 nodes · cohesion 0.07

## Key Concepts

- **NMWC Unified CRM Master Session Record** (52 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Enterprise-readiness assessment: 41/100 with blockers B1-B6** (7 connections) — `docs/SESSION-MASTER-RECORD.md`
- **RK-3 chunked and resumable customer promote** (7 connections) — `docs/SESSION-MASTER-RECORD.md`
- **B3: restore drill built so it could not fail; rebuilt with empty-branch restore** (6 connections) — `docs/SESSION-MASTER-RECORD.md`
- **AUTH-09: no forced first-login password change** (5 connections) — `docs/audit/01-auth-session.md`
- **B2: region-scoped Manager user administration** (5 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Go-live data build from the real masters into gitignored golive-data** (5 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Round-3 P1s: approver provisioning path, close approvals, payment-terms flip, presence-aware re-import** (5 connections) — `docs/SESSION-MASTER-RECORD.md`
- **F-03: promote swallows per-row failures and retries forever** (4 connections) — `docs/audit/03-imports-exports.md`
- **F-04: no duplicate detection on phone or CR during customer import** (4 connections) — `docs/audit/03-imports-exports.md`
- **Full-lane channel move clears a mismatched sub-channel (owner decision 2026-09-29, F16)** (4 connections) — `docs/OPERATIONS.md`
- **B4: audit immutability trigger and least-privilege nmwc_app role** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **B5: cron heartbeat dead-man and 503 health probe** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Daily retention-sweep cron (rate-limit rows, import payloads, notifications)** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Open decision: one shared initial password vs per-account (SEC-11)** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Update-flow verification (golive-update-flow integration and browser walk)** (4 connections) — `docs/SESSION-MASTER-RECORD.md`
- **F-17: unknown region/route codes auto-created as phantom regions** (3 connections) — `docs/audit/03-imports-exports.md`
- **Independent finding-refutation process (two or more refuters)** (3 connections) — `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- **B6: data residency and compliance documents (PII inventory)** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **F-UAT-8: self-healing CodeSequence allocator** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **SEC-01: inert middleware gate deliberately left unchanged** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **SIGPIPE under pipefail broke the backup pre-upload check (P0)** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **SR-USR-01: MANAGER_ADMINISTRABLE_ROLES allowlist** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Configurable submit gate SALESMAN_SUBMIT_GATE with CORE as default** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Three adversarial deep reviews (78 confirmed findings)** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- *... and 17 more nodes in this community*

## Relationships

- [[Operations runbook]] (16 shared connections)
- [[Production-readiness verification]] (15 shared connections)
- [[May 2026 audits and remediation]] (11 shared connections)
- [[Roadmap and service levels]] (6 shared connections)
- [[NMWC Customer Master Technical Specifica area]] (3 shared connections)
- [[Original PRD and UX spec]] (3 shared connections)
- [[Session Handoff 2026-05-10 area]] (2 shared connections)
- [[End-to-end verification and seeds]] (1 shared connections)
- [[Cross-domain and RBAC audits]] (1 shared connections)
- [[Middleware, CSP and maintenance]] (1 shared connections)

## Source Files

- `docs/OPERATIONS.md`
- `docs/OPUS-4.8-MASTER-EXECUTION-PLAN.md`
- `docs/PRD-v0.1.md`
- `docs/PROJECT-DESCRIPTION.md`
- `docs/SERVICE-LEVELS.md`
- `docs/SESSION-MASTER-RECORD.md`
- `docs/audit/01-auth-session.md`
- `docs/audit/03-imports-exports.md`

## Audit Trail

- EXTRACTED: 156 (85%)
- INFERRED: 27 (15%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*