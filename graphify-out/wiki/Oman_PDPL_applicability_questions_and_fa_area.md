# Oman PDPL applicability questions and fa area

> 20 nodes · cohesion 0.17

## Key Concepts

- **Oman PDPL applicability questions and facts for counsel (2026-09-14)** (23 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **Data retention schedule (draft, 2026-09-14)** (17 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **Personal-data inventory (generated technical annex: 297 columns, 24 tables)** (10 connections) — `docs/compliance/PII-INVENTORY.md`
- **Append-only ledger: AuditLog and EditApproval immutable at the database** (7 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **Detached photo GC: row deleted after 30 days, object tagged gc-marked, R2 lifecycle expiry 7 days later** (6 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **Q4 Erasure requests against an append-only ledger** (6 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **Q5 Backups defeat erasure (30-day dumps, 7-day PITR)** (4 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **Nightly dumps not yet encrypted (BACKUP_AGE_RECIPIENTS variable unset)** (4 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **A6 Operating the service (telemetry, logs, rate limits, dumps)** (4 connections) — `docs/compliance/RECORDS-OF-PROCESSING.md`
- **B-02 R2 photos permanently deleted by photo-gc cron** (3 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **Q1 Does the PDPL bind this processing; is the cross-border transfer lawful?** (3 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **PII subject classes: Customer contact, Employee, Customer entity (if sole establishment), Not personal** (3 connections) — `docs/compliance/PII-INVENTORY.md`
- **Customer master copied into AuditLog snapshots, CustomerEdit.fieldChanges and ImportRow.raw** (3 connections) — `docs/compliance/PII-INVENTORY.md`
- **A2 Change requests and multi-step approval** (3 connections) — `docs/compliance/RECORDS-OF-PROCESSING.md`
- **Gap: photos of an abandoned CREATE request are kept forever** (2 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **Gap: archiving a customer never releases its photographs** (2 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **ImportRow payloads emptied 90 days after upload by the retention sweep** (2 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **Erasure tooling deliberately not built until counsel rules** (2 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **Oman Personal Data Protection Law (Royal Decree 6/2022)** (2 connections) — `docs/compliance/PDPL-ASSESSMENT.md`
- **Q2 Sole-establishment customers as personal data (no legalForm field)** (2 connections) — `docs/compliance/PDPL-ASSESSMENT.md`

## Relationships

- [[Records of processing activities (draft, area]] (9 shared connections)
- [[Data residency and processor register (d area]] (7 shared connections)
- [[pii-classification area]] (5 shared connections)
- [[route area]] (4 shared connections)
- [[logger area]] (3 shared connections)
- [[Audit immutability tests]] (3 shared connections)
- [[Monthly restore drill on an emptied Neon area]] (3 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (2 shared connections)
- [[r2-backups-lifecycle area]] (2 shared connections)
- [[Sentry PII scrubbing]] (2 shared connections)
- [[Operations runbook]] (1 shared connections)
- [[Enterprise readiness assessment]] (1 shared connections)

## Source Files

- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- `docs/compliance/PDPL-ASSESSMENT.md`
- `docs/compliance/PII-INVENTORY.md`
- `docs/compliance/RECORDS-OF-PROCESSING.md`

## Audit Trail

- EXTRACTED: 90 (83%)
- INFERRED: 16 (15%)
- AMBIGUOUS: 2 (2%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*