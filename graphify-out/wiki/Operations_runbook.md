# Operations runbook

> 51 nodes · cohesion 0.07

## Key Concepts

- **NMWC Operations Runbook** (64 connections) — `docs/OPERATIONS.md`
- **Nightly DB backup workflow (db-backup.yml)** (7 connections) — `docs/OPERATIONS.md`
- **Runbook B: restore the nightly dump into a new Neon branch** (7 connections) — `docs/OPERATIONS.md`
- **Cron heartbeats and bearer health probe (B5)** (6 connections) — `docs/OPERATIONS.md`
- **Customer import lanes: refresh lane vs full lane, decided per row** (6 connections) — `docs/OPERATIONS.md`
- **R2 photo bucket versioning with 30-day non-current retention (owner action)** (6 connections) — `docs/OPERATIONS.md`
- **ops:requeue-untracked for customers SYNCED without a Temix code** (6 connections) — `docs/OPERATIONS.md`
- **Least-privilege DB roles: nmwc_app runtime vs owner DIRECT_URL (B4)** (5 connections) — `docs/OPERATIONS.md`
- **Measured RPO/RTO for recovery paths A, B and C** (5 connections) — `docs/OPERATIONS.md`
- **ops:rescore-completeness one-off repair (F21)** (5 connections) — `docs/OPERATIONS.md`
- **Runbook A: Neon point-in-time recovery** (5 connections) — `docs/OPERATIONS.md`
- **Backup age encryption and private-key escrow** (4 connections) — `docs/OPERATIONS.md`
- **Append-only AuditLog/EditApproval trigger with owner-only maintenance override** (4 connections) — `docs/OPERATIONS.md`
- **--expect-host and dry-run-first guard for operator scripts** (4 connections) — `docs/OPERATIONS.md`
- **Instant rollback then fix forward through CI** (4 connections) — `docs/OPERATIONS.md`
- **Error Reference digest lookup in Vercel logs and Sentry (item 10)** (4 connections) — `docs/OPERATIONS.md`
- **restore-verify.ts assertions (manifest M-01, trigger F-01)** (4 connections) — `docs/OPERATIONS.md`
- **ops:visit-days fill of visit days held back by quarantine** (4 connections) — `docs/OPERATIONS.md`
- **Backup layers: Neon PITR plus nightly encrypted off-Neon dump** (3 connections) — `docs/OPERATIONS.md`
- **Batch-page row fixes: Correct, Release shared phone, Re-check, Exclude, Withdraw fix** (3 connections) — `docs/OPERATIONS.md`
- **Health verdict tiers: critical vs warning scheduled jobs** (3 connections) — `docs/OPERATIONS.md`
- **Import rescoring of the customer and each live branch (F21)** (3 connections) — `docs/OPERATIONS.md`
- **Unscrubbed log fields: request query string, Next error printouts, library console** (3 connections) — `docs/OPERATIONS.md`
- **Vercel build applies prisma migrate deploy before next build** (3 connections) — `docs/OPERATIONS.md`
- **ops:print-secrets generated from lib/ops/required-secrets.ts (DO-16)** (3 connections) — `docs/OPERATIONS.md`
- *... and 26 more nodes in this community*

## Relationships

- [[Master session record and assessment]] (16 shared connections)
- [[Roadmap and service levels]] (8 shared connections)
- [[May 2026 audits and remediation]] (4 shared connections)
- [[Session Handoff 2026-05-10 area]] (4 shared connections)
- [[Original PRD and UX spec]] (3 shared connections)
- [[Data residency and processor register (d area]] (2 shared connections)
- [[NMWC Customer Master Technical Specifica area]] (2 shared connections)
- [[Production-readiness verification]] (2 shared connections)
- [[Pre-launch review (July)]] (2 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (1 shared connections)
- [[Oman PDPL applicability questions and fa area]] (1 shared connections)
- [[Records of processing activities (draft, area]] (1 shared connections)

## Source Files

- `docs/OPERATIONS.md`
- `docs/OWNER-ACTIONS-NOW.md`
- `docs/SERVICE-LEVELS.md`
- `docs/SESSION-HANDOFF-2026-05-10.md`
- `docs/SESSION-MASTER-RECORD.md`

## Audit Trail

- EXTRACTED: 203 (89%)
- INFERRED: 25 (11%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*