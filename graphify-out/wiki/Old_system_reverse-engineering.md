# Old system reverse-engineering

> 29 nodes · cohesion 0.12

## Key Concepts

- **Integration and Consolidation Risks (x-integration.md)** (23 connections) — `docs/discovery/raw-evidence/x-integration.md`
- **OLD Business Rule Catalogue (old-rules.md)** (14 connections) — `docs/discovery/raw-evidence/old-rules.md`
- **OLD Tech-Debt Register and Bug Catalogue (old-techdebt.md)** (14 connections) — `docs/discovery/raw-evidence/old-techdebt.md`
- **OLD Functional Reverse-Engineering (old-functional.md)** (12 connections) — `docs/discovery/raw-evidence/old-functional.md`
- **OLD 17-Status Request State Machine** (9 connections) — `docs/discovery/raw-evidence/old-functional.md`
- **OLD Defensive Security Review (old-security.md)** (9 connections) — `docs/discovery/raw-evidence/old-security.md`
- **J-C1 OLD Signing and Cron Secrets Committed in .env** (7 connections) — `docs/discovery/raw-evidence/old-security.md`
- **OLD 4-Stage New-Customer Journey (Supervisor, Accountant, RoutePro)** (6 connections) — `docs/discovery/raw-evidence/old-functional.md`
- **OLD Levenshtein Fuzzy Duplicate Check (0.85 / 0.70)** (5 connections) — `docs/discovery/raw-evidence/old-rules.md`
- **J-H1 Deactivation and Role Change Not Enforced Until JWT Expiry** (5 connections) — `docs/discovery/raw-evidence/old-security.md`
- **H-05 Role Set Crosswalk** (5 connections) — `docs/discovery/raw-evidence/x-contradictions.md`
- **OLD Roles (SALESMAN, SUPERVISOR, ACCOUNTANT, ADMIN, ROUTEPRO)** (4 connections) — `docs/discovery/raw-evidence/old-functional.md`
- **Freeze OLD as Read-Only Archive (M.1.4, M.9)** (4 connections) — `docs/discovery/raw-evidence/x-integration.md`
- **Steward Backup and Restore-Drill Responsibilities** (3 connections) — `docs/guide/NMWC-Steward-Guide-EN.html`
- **Photo GC Cron (R2 lifecycle tagging)** (3 connections) — `docs/discovery/raw-evidence/new-rules.md`
- **Timing-Safe Cron Bearer Compare (B-16)** (3 connections) — `docs/discovery/raw-evidence/new-security.md`
- **OLD Middleware JWT Gate (getToken, /admin page guard)** (3 connections) — `docs/discovery/raw-evidence/old-arch.md`
- **OLD canCancel Has No Route** (3 connections) — `docs/discovery/raw-evidence/old-rules.md`
- **OLD No Cash/Credit Model (cash implied by NO_CR)** (3 connections) — `docs/discovery/raw-evidence/old-rules.md`
- **OLD Request Types (NEW_MAIN, NEW_BRANCH, NO_CR, UPDATE_EXISTING)** (3 connections) — `docs/discovery/raw-evidence/old-rules.md`
- **Start Consolidated Repo from Clean History (M.6)** (3 connections) — `docs/discovery/raw-evidence/x-integration.md`
- **Neon Branch Load and Rollback Plan (M.9)** (3 connections) — `docs/discovery/raw-evidence/x-integration.md`
- **User Re-Provisioning (email login to username, M.5)** (3 connections) — `docs/discovery/raw-evidence/x-integration.md`
- **OLD Status-Guarded updateMany Concurrency** (2 connections) — `docs/discovery/raw-evidence/old-functional.md`
- **OLD First-4-Character Prefix Recall Gap** (2 connections) — `docs/discovery/raw-evidence/old-rules.md`
- *... and 4 more nodes in this community*

## Relationships

- [[OLD vs NEW Feature Comparison Matrix (x- area]] (16 shared connections)
- [[Contradiction and Decision Register (x-c area]] (16 shared connections)
- [[NEW Defensive Security Review (new-secur area]] (6 shared connections)
- [[NEW Business Rule Catalogue (new-rules.m area]] (5 shared connections)
- [[BUG-03 OLD Vercel Crons Never Fire (POST area]] (5 shared connections)
- [[Missing Enterprise Capabilities Gap Anal area]] (5 shared connections)
- [[Data Steward User Guide v1.0 area]] (3 shared connections)
- [[NEW System Functional Reverse-Engineerin area]] (3 shared connections)

## Source Files

- `docs/discovery/raw-evidence/new-rules.md`
- `docs/discovery/raw-evidence/new-security.md`
- `docs/discovery/raw-evidence/old-arch.md`
- `docs/discovery/raw-evidence/old-functional.md`
- `docs/discovery/raw-evidence/old-rules.md`
- `docs/discovery/raw-evidence/old-security.md`
- `docs/discovery/raw-evidence/old-techdebt.md`
- `docs/discovery/raw-evidence/x-contradictions.md`
- `docs/discovery/raw-evidence/x-integration.md`
- `docs/guide/NMWC-Steward-Guide-EN.html`

## Audit Trail

- EXTRACTED: 131 (82%)
- INFERRED: 26 (16%)
- AMBIGUOUS: 2 (1%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*