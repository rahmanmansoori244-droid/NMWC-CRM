# Data residency and processor register (d area

> 14 nodes · cohesion 0.19

## Key Concepts

- **Data residency and processor register (draft, 2026-09-14)** (21 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **No data-residency decision ever taken: all data processed in the US** (5 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Database dump transits a GitHub runner in plaintext; owner DB credential is a repo secret** (4 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Vercel (P1) — app hosting, region iad1 US East** (4 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **B-09 Vercel functions default to US East (iad1)** (3 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **GitHub (P5) — source control, CI and the nightly-dump runner** (3 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Cloudflare R2 bucket nmwc-backups (P4) — nightly database dumps** (3 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Gap: Vercel runtime logs keep unscrubbed ?q= search terms for 30 days** (3 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **Q6 Vendor accounts appear held by individuals, not NMWC SAOG** (3 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **cron-job.org external scheduler (P7, being retired for Vercel cron)** (2 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Neon (P2) — managed PostgreSQL system of record, us-east-1** (2 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Open owner actions: bucket locations, Sentry region, vendor account holders, residency decision** (2 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- **Controller: National Mineral Water Company SAOG (NMWC), Oman** (2 connections) — `docs/compliance/RECORDS-OF-PROCESSING.md`
- **Google Maps links: user-initiated disclosure of a premises location** (1 connections) — `docs/compliance/DATA-RESIDENCY-REGISTER.md`

## Relationships

- [[Oman PDPL applicability questions and fa area]] (7 shared connections)
- [[Monthly restore drill on an emptied Neon area]] (5 shared connections)
- [[Records of processing activities (draft, area]] (4 shared connections)
- [[r2-backups-lifecycle area]] (2 shared connections)
- [[Operations runbook]] (2 shared connections)
- [[Sentry PII scrubbing]] (2 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (1 shared connections)
- [[Audit immutability tests]] (1 shared connections)

## Source Files

- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- `docs/compliance/PDPL-ASSESSMENT.md`
- `docs/compliance/RECORDS-OF-PROCESSING.md`

## Audit Trail

- EXTRACTED: 47 (81%)
- INFERRED: 11 (19%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*