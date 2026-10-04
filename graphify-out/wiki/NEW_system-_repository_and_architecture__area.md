# NEW system: repository and architecture  area

> 12 nodes · cohesion 0.20

## Key Concepts

- **NEW system: repository and architecture map (raw evidence)** (9 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **NEW-C-1: shared weak pilot passwords committed to the repo** (5 connections) — `docs/discovery/NMWC-CRM-Discovery-Report.md`
- **Beta auth dependency in production (next-auth 5 beta)** (3 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **NEW stack (Next 15, React 19, Prisma 6, Auth.js v5 beta, Neon Postgres, Cloudflare R2, Sentry, pino)** (3 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Users re-provisioned (email to username, no password-hash copy, forced change)** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Environment-variable inventory (names only, values masked)** (2 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Off-platform GitHub Actions crons (keep-warm, db-backup with restore drill)** (2 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Claim: no secrets committed (env files gitignored)** (2 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Pooled DATABASE_URL for runtime versus DIRECT_URL for migrate and backup** (2 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Vercel hosting (fra1, 30 s maxDuration, daily photo-gc cron)** (2 connections) — `docs/discovery/raw-evidence/new-arch.md`
- **Commit 61ddec1: bulk credential reset (shared pilot passwords, forced change off)** (2 connections) — `docs/discovery/raw-evidence/new-docs.md`
- **Operational pilot-launch maturity** (1 connections) — `docs/discovery/raw-evidence/new-arch.md`

## Relationships

- [[NMWC Unified CRM: security remediation a area]] (3 shared connections)
- [[OLD to NEW data migration / ETL runbook area]] (1 shared connections)
- [[NMWC CRM: discovery and understanding re area]] (1 shared connections)
- [[Customer list, filters and export]] (1 shared connections)
- [[Photo upload and R2]] (1 shared connections)
- [[route area]] (1 shared connections)
- [[NEW system: documentation versus impleme area]] (1 shared connections)

## Source Files

- `docs/discovery/NMWC-CRM-Discovery-Report.md`
- `docs/discovery/blueprint-inputs/migration-etl.md`
- `docs/discovery/raw-evidence/new-arch.md`
- `docs/discovery/raw-evidence/new-docs.md`

## Audit Trail

- EXTRACTED: 30 (86%)
- INFERRED: 3 (9%)
- AMBIGUOUS: 2 (6%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*