# NMWC-CRM senior audit report (2026-05-10 area

> 21 nodes · cohesion 0.10

## Key Concepts

- **NMWC-CRM senior audit report (2026-05-10)** (25 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **PROD-001 Atomic approval claim (one winner per race)** (4 connections) — `docs/audit/E2E-VERIFICATION-2026-05-10.md`
- **rotatePasswordHistory (lib/password-policy.ts, last 5 hashes)** (4 connections) — `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- **B-01 No automated off-platform database backup** (3 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-05 No optimistic locking on Customer/Branch** (3 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-06 Salesman enrichment form too heavy for field use** (3 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **lockCustomerRow (customer row lock)** (3 connections) — `docs/design/phase2-edit-semantics/spec-approval_behaviour.txt`
- **UXI-015 Arabic customer search works only by coincidence** (2 connections) — `docs/audit/06-ux-data-integrity.md`
- **GAP-01 /api/health discloses stack and degraded state publicly** (2 connections) — `docs/audit/07-cross-check.md`
- **B-10 Customer search uses LIKE on a B-tree (no pg_trgm)** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-12 Health endpoint shows degraded state to anonymous callers** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-15 No password history check** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-16 photo-gc cron secret compared without timingSafeEqual** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-17 services/routes.ts not wrapped in runAction, no audit** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **Minimum viable salesman field form (9 required items)** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **RBAC defense-in-depth: page redirect + service guard + DB atomic claim** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-04 No LOGIN/LOGOUT/SESSION_REVOKE audit rows** (1 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-07 No GPS fallback** (1 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-11 No bulk approval UI** (1 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **B-23 Duplicate detector ignores dismissed CustomerPair rows** (1 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **Missing FMCG master fields (WhatsApp, VAT/TRN, credit limit, CR expiry, landmark)** (1 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`

## Relationships

- [[Phase 2 design notes]] (2 shared connections)
- [[Cross-domain and RBAC audits]] (2 shared connections)
- [[Edit submit and approval engine]] (2 shared connections)
- [[End-to-end verification and seeds]] (2 shared connections)
- [[Original PRD and UX spec]] (2 shared connections)
- [[Oman PDPL applicability questions and fa area]] (2 shared connections)
- [[route area]] (2 shared connections)
- [[Operations runbook]] (1 shared connections)
- [[Audit log writing]] (1 shared connections)
- [[Photo upload and R2]] (1 shared connections)
- [[Data residency and processor register (d area]] (1 shared connections)
- [[Monthly restore drill on an emptied Neon area]] (1 shared connections)

## Source Files

- `docs/audit/06-ux-data-integrity.md`
- `docs/audit/07-cross-check.md`
- `docs/audit/E2E-VERIFICATION-2026-05-10.md`
- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `docs/compliance/DATA-RETENTION-SCHEDULE.md`
- `docs/design/phase2-edit-semantics/spec-approval_behaviour.txt`

## Audit Trail

- EXTRACTED: 53 (78%)
- INFERRED: 15 (22%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*