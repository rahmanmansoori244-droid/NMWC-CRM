# Monthly restore drill on an emptied Neon area

> 18 nodes · cohesion 0.26

## Key Concepts

- **Monthly restore drill on an emptied Neon branch (B3)** (18 connections) — `.github/workflows/restore-drill.yml`
- **.github/workflows/db-backup.yml** (16 connections) — `.github/workflows/db-backup.yml`
- **Nightly DB backup: pg_dump to R2 nmwc-backups (B-01, B3)** (13 connections) — `.github/workflows/db-backup.yml`
- **CI job restore-chain (backup, encrypt, restore, verify)** (10 connections) — `.github/workflows/ci.yml`
- **R2 bucket settings check (backup lifecycle, photo versioning)** (10 connections) — `.github/workflows/r2-config.yml`
- **.github/workflows/restore-drill.yml** (9 connections) — `.github/workflows/restore-drill.yml`
- **age encryption to BACKUP_AGE_RECIPIENTS (key escrow)** (7 connections) — `.github/workflows/db-backup.yml`
- **ALLOW_PLAINTEXT_BACKUP escape hatch turns the run red (DO-16)** (5 connections) — `.github/workflows/db-backup.yml`
- **Backups and restore posture** (4 connections) — `AUDITOR-BRIEF.md`
- **DIRECT_URL validation by length only plus PROD_DB_HOST_MARKER** (4 connections) — `.github/workflows/db-backup.yml`
- **Backup dead-man report (/api/ops/backup-report)** (4 connections) — `.github/workflows/db-backup.yml`
- **Backup row-count manifest (scripts/ops/backup-manifest.sql)** (4 connections) — `.github/workflows/db-backup.yml`
- **scripts/ops/restore-load.sh (sanitised summary, sealed log, N08)** (4 connections) — `.github/workflows/restore-drill.yml`
- **Single-pass dump verification with awk (SIGPIPE fix)** (3 connections) — `.github/workflows/db-backup.yml`
- **.github/workflows/r2-config.yml** (3 connections) — `.github/workflows/r2-config.yml`
- **Always delete the drill branch (a full copy of personal data)** (3 connections) — `.github/workflows/restore-drill.yml`
- **scripts/ops/restore-verify.ts** (3 connections) — `.github/workflows/restore-drill.yml`
- **One admin token per R2 bucket** (2 connections) — `.github/workflows/r2-config.yml`

## Relationships

- [[Handover and go-live runbook]] (11 shared connections)
- [[Auditor brief]] (8 shared connections)
- [[CI job post-deploy-smoke (GAP-08) area]] (7 shared connections)
- [[Data residency and processor register (d area]] (5 shared connections)
- [[Scheduled work: Vercel crons and GitHub  area]] (4 shared connections)
- [[Oman PDPL applicability questions and fa area]] (3 shared connections)
- [[docs/CHANGELOG.md area]] (2 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (1 shared connections)
- [[Standing rules (CLAUDE.md, AGENTS.md)]] (1 shared connections)

## Source Files

- `.github/workflows/ci.yml`
- `.github/workflows/db-backup.yml`
- `.github/workflows/r2-config.yml`
- `.github/workflows/restore-drill.yml`
- `AUDITOR-BRIEF.md`

## Audit Trail

- EXTRACTED: 113 (93%)
- INFERRED: 8 (7%)
- AMBIGUOUS: 1 (1%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*