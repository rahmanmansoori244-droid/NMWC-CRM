# Audit log writing

> 45 nodes · cohesion 0.08

## Key Concepts

- **writeAudit()** (61 connections) — `lib/audit.ts`
- **getAuditEnvelope()** (52 connections) — `lib/audit.ts`
- **routes.ts** (32 connections) — `services/routes.ts`
- **audit.ts** (28 connections) — `lib/audit.ts`
- **admin-audit-atomic.test.ts** (17 connections) — `tests/unit/admin-audit-atomic.test.ts`
- **forms.tsx** (10 connections) — `app/(app)/routes/forms.tsx`
- **logoutAction()** (6 connections) — `app/actions/auth.ts`
- **rejectReactivationCore()** (6 connections) — `services/reactivations.ts`
- **createRouteCore()** (6 connections) — `services/routes.ts`
- **requireRouteAdmin()** (6 connections) — `services/routes.ts`
- **toggleRegionActiveCore()** (6 connections) — `services/routes.ts`
- **toggleRouteActiveCore()** (6 connections) — `services/routes.ts`
- **audit-guard.test.ts** (5 connections) — `tests/unit/audit-guard.test.ts`
- **assertRegionInScope()** (4 connections) — `services/routes.ts`
- **createRegionAction()** (4 connections) — `services/routes.ts`
- **createRegionCore()** (4 connections) — `services/routes.ts`
- **createRouteAction()** (4 connections) — `services/routes.ts`
- **regionScopeOf()** (4 connections) — `services/routes.ts`
- **toggleRegionActiveAction()** (4 connections) — `services/routes.ts`
- **toggleRouteActiveAction()** (4 connections) — `services/routes.ts`
- **B-03 AuditLog ip and userAgent never populated** (3 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **Operator maintenance scripts write AuditLog with null ip/userAgent by construction** (3 connections) — `docs/compliance/RECORDS-OF-PROCESSING.md`
- **[25] P3 routes.ts mutations never revalidate ref-data cache tags** (3 connections) — `qa/findings/final-golive-hunt.md`
- **AuditEnvelope** (3 connections) — `lib/audit.ts`
- **writeLoginFail()** (3 connections) — `lib/auth.ts`
- *... and 20 more nodes in this community*

## Relationships

- [[Permissions and user administration]] (14 shared connections)
- [[import-fixes area]] (12 shared connections)
- [[Auth and page scope loading]] (10 shared connections)
- [[Exports and export scope]] (10 shared connections)
- [[Duplicates, archive and Temix codes]] (10 shared connections)
- [[Photos and completeness scoring]] (10 shared connections)
- [[Customer list, filters and export]] (8 shared connections)
- [[Edit submit and approval engine]] (7 shared connections)
- [[runAction area]] (7 shared connections)
- [[route area]] (5 shared connections)
- [[New-customer creation and phones]] (5 shared connections)
- [[Account master import]] (5 shared connections)

## Source Files

- `app/(app)/routes/forms.tsx`
- `app/actions/auth.ts`
- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `docs/compliance/RECORDS-OF-PROCESSING.md`
- `lib/audit.ts`
- `lib/auth.ts`
- `qa/findings/final-golive-hunt.md`
- `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- `services/import-fixes.ts`
- `services/reactivations.ts`
- `services/routes.ts`
- `services/users.ts`
- `tests/unit/admin-audit-atomic.test.ts`
- `tests/unit/audit-guard.test.ts`

## Audit Trail

- EXTRACTED: 306 (99%)
- INFERRED: 4 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*