# NEW Defensive Security Review (new-secur area

> 16 nodes · cohesion 0.18

## Key Concepts

- **NEW Defensive Security Review (new-security.md)** (14 connections) — `docs/discovery/raw-evidence/new-security.md`
- **BUG-1 Postgres Rate Limiter Always Grants** (9 connections) — `docs/discovery/raw-evidence/new-techdebt.md`
- **C-1 Pilot User Credentials Committed to Git** (8 connections) — `docs/discovery/raw-evidence/new-security.md`
- **Auth and Session Rules (JWT 8h, freshness, AUTH-12 revocation, LOGIN_LIMIT)** (7 connections) — `docs/discovery/raw-evidence/new-rules.md`
- **NEW Login Trace (loginAction to Credentials authorize)** (4 connections) — `docs/discovery/raw-evidence/new-functional.md`
- **M-2 Login Rate Limit Generous Against Weak Passwords** (4 connections) — `docs/discovery/raw-evidence/new-security.md`
- **Login Lockout Guidance (5 wrong tries, 1-minute lock)** (3 connections) — `docs/guide/NMWC-CRM-USER-GUIDE.html`
- **Gitleaks Pre-Commit and CI Secret Scanner** (3 connections) — `docs/discovery/raw-evidence/new-security.md`
- **H-11 Auth Generation (NextAuth 4 vs Auth.js v5 beta)** (3 connections) — `docs/discovery/raw-evidence/x-contradictions.md`
- **Middleware authorized() Deny Path Inert (register C1 correction)** (2 connections) — `docs/discovery/raw-evidence/new-security.md`
- **M-1 Shared Passwords Defeat Per-User Auditability** (2 connections) — `docs/discovery/raw-evidence/new-security.md`
- **M-3 Gitignored .env Files Present on Disk** (2 connections) — `docs/discovery/raw-evidence/new-security.md`
- **TD-3 Login Latency p95 About 3s** (2 connections) — `docs/discovery/raw-evidence/new-techdebt.md`
- **BUG-07 OLD Hardcoded Seed Admin Password** (2 connections) — `docs/discovery/raw-evidence/old-techdebt.md`
- **Logger PII Redaction (lib/logger.ts)** (1 connections) — `docs/discovery/raw-evidence/new-security.md`
- **M-4 CSP style-src unsafe-inline** (1 connections) — `docs/discovery/raw-evidence/new-security.md`

## Relationships

- [[Old system reverse-engineering]] (6 shared connections)
- [[Contradiction and Decision Register (x-c area]] (5 shared connections)
- [[Missing Enterprise Capabilities Gap Anal area]] (4 shared connections)
- [[NEW System Functional Reverse-Engineerin area]] (3 shared connections)
- [[OLD vs NEW Feature Comparison Matrix (x- area]] (3 shared connections)
- [[Data Steward User Guide v1.0 area]] (1 shared connections)
- [[NEW Business Rule Catalogue (new-rules.m area]] (1 shared connections)

## Source Files

- `docs/discovery/raw-evidence/new-functional.md`
- `docs/discovery/raw-evidence/new-rules.md`
- `docs/discovery/raw-evidence/new-security.md`
- `docs/discovery/raw-evidence/new-techdebt.md`
- `docs/discovery/raw-evidence/old-techdebt.md`
- `docs/discovery/raw-evidence/x-contradictions.md`
- `docs/guide/NMWC-CRM-USER-GUIDE.html`

## Audit Trail

- EXTRACTED: 48 (72%)
- INFERRED: 15 (22%)
- AMBIGUOUS: 4 (6%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*