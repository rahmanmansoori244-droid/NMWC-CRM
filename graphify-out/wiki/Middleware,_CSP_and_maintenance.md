# Middleware, CSP and maintenance

> 29 nodes · cohesion 0.11

## Key Concepts

- **middleware.ts** (12 connections) — `middleware.ts`
- **auth.config.ts** (8 connections) — `auth.config.ts`
- **C1 Auth.js authorized gate is inert (verdict corrected 2026-09-15)** (8 connections) — `qa/findings/register.md`
- **csp.test.ts** (8 connections) — `tests/unit/csp.test.ts`
- **maintenance.ts** (6 connections) — `lib/maintenance.ts`
- **maintenanceResponse()** (6 connections) — `lib/maintenance.ts`
- **next.config.ts** (6 connections) — `next.config.ts`
- **csp.ts** (5 connections) — `lib/csp.ts`
- **buildCsp()** (5 connections) — `lib/csp.ts`
- **SR-M4: CSP style-src hardening and CSP parity test** (4 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **SEC-01 inert middleware gate (closed as a documentation defect)** (4 connections) — `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- **SEC-14b CSP base-uri/form-action from one policy builder** (4 connections) — `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- **maintenance.test.ts** (3 connections) — `tests/unit/maintenance.test.ts`
- **tokenMatches()** (2 connections) — `lib/maintenance.ts`
- **middleware()** (2 connections) — `middleware.ts`
- **nextConfig** (2 connections) — `next.config.ts`
- **loadConfig()** (2 connections) — `tests/unit/auth-cookie.test.ts`
- **names()** (2 connections) — `tests/unit/csp.test.ts`
- **parse()** (2 connections) — `tests/unit/csp.test.ts`
- **authorized()** (1 connections) — `auth.config.ts`
- **session()** (1 connections) — `auth.config.ts`
- **MAINTENANCE_ALLOW** (1 connections) — `lib/maintenance.ts`
- **{ auth }** (1 connections) — `middleware.ts`
- **config** (1 connections) — `middleware.ts`
- **generateNonce()** (1 connections) — `middleware.ts`
- *... and 4 more nodes in this community*

## Relationships

- [[Enterprise readiness assessment]] (4 shared connections)
- [[NMWC Unified CRM: security remediation a area]] (2 shared connections)
- [[QA defect register]] (2 shared connections)
- [[approval-decision-pages.test area]] (2 shared connections)
- [[Auth and page scope loading]] (1 shared connections)
- [[Production-readiness verification]] (1 shared connections)
- [[Master session record and assessment]] (1 shared connections)
- [[Customer import service tests]] (1 shared connections)
- [[route area]] (1 shared connections)

## Source Files

- `auth.config.ts`
- `docs/discovery/blueprint-inputs/security-remediation.md`
- `lib/csp.ts`
- `lib/maintenance.ts`
- `middleware.ts`
- `next.config.ts`
- `qa/findings/register.md`
- `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- `tests/unit/auth-cookie.test.ts`
- `tests/unit/csp.test.ts`
- `tests/unit/maintenance.test.ts`

## Audit Trail

- EXTRACTED: 95 (94%)
- INFERRED: 6 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*