# NMWC Unified CRM: security remediation a area

> 19 nodes · cohesion 0.19

## Key Concepts

- **NMWC Unified CRM: security remediation and must-fix plan** (18 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **Remediation sequence (Phase 0-3) and the go/no-go gate for onboarding OLD's population** (17 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-C3: fix the Postgres rate limiter (subtract 1, floor at -1)** (7 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-C2: rotate NEW pilot credentials, re-enable forced password change, add a secret-scanning gate** (6 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-H2: region-less import falls back to the UNASSIGNED region** (6 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-L1: completeness scoring fixes and fleet rescore** (6 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-L2: EXPORT audit action and DuplicateDismissal model** (5 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-M1: approve path keeps a CASH customer's CR number** (5 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-C1: rotate and purge the OLD repo's committed .env** (4 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-H3: OLD session-staleness containment** (4 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-L3: reactivation approve gets the optimistic version lock** (4 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-M2: /customers list fail-closed for a Manager with no regions** (4 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-M3: dependency pinning and npm audit in CI** (3 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-M5: progressive login lockout after the rate-limit fix** (3 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **Auth hardening (5-minute JWT freshness re-read, sessionsRevokedAt, forced password change, constant-time bcrypt)** (3 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Secret-scanning CI gate (gitleaks)** (2 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SR-L4: OLD-only residuals closed by decommissioning** (2 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **OLD J-H1: deactivation and role change not enforced until JWT expiry (8 h)** (2 connections) — `docs/discovery/NMWC-CRM-Discovery-Report.md`
- **rate-limit-pg.test.ts** (1 connections) — `tests/integration/rate-limit-pg.test.ts`

## Relationships

- [[NMWC Unified CRM: target operating model area]] (7 shared connections)
- [[NMWC CRM: discovery and understanding re area]] (6 shared connections)
- [[NEW system: repository and architecture  area]] (3 shared connections)
- [[Photos and completeness scoring]] (3 shared connections)
- [[Design: multi-tier, payment-terms-condit area]] (2 shared connections)
- [[Middleware, CSP and maintenance]] (2 shared connections)
- [[Customer list, filters and export]] (2 shared connections)
- [[Permissions and user administration]] (1 shared connections)
- [[rate-limit area]] (1 shared connections)
- [[Design: SLA / escalation, notifications  area]] (1 shared connections)
- [[Account master import]] (1 shared connections)
- [[OLD to NEW data migration / ETL runbook area]] (1 shared connections)

## Source Files

- `docs/discovery/NMWC-CRM-Discovery-Report.md`
- `docs/discovery/blueprint-inputs/security-remediation.md`
- `docs/discovery/raw-evidence/new-arch.md`
- `tests/integration/rate-limit-pg.test.ts`

## Audit Trail

- EXTRACTED: 97 (95%)
- INFERRED: 5 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*