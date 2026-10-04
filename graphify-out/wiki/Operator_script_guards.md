# Operator script guards

> 39 nodes · cohesion 0.10

## Key Concepts

- **requeue-untracked.ts** (20 connections) — `scripts/ops/requeue-untracked.ts`
- **connectWaking()** (12 connections) — `scripts/ops/requeue-untracked.ts`
- **requireExpectedHost()** (12 connections) — `scripts/ops/requeue-untracked.ts`
- **resolveActor()** (12 connections) — `scripts/ops/requeue-untracked.ts`
- **temix-requeue-guard.test.ts** (12 connections) — `tests/unit/temix-requeue-guard.test.ts`
- **operatorErrorLabel()** (9 connections) — `scripts/ops/error-label.ts`
- **operator-error-label.test.ts** (9 connections) — `tests/unit/operator-error-label.test.ts`
- **demo-accounts.ts** (8 connections) — `lib/demo-accounts.ts`
- **isDemoAccount()** (8 connections) — `lib/demo-accounts.ts`
- **error-label.ts** (8 connections) — `scripts/ops/error-label.ts`
- **OperatorRefusal** (8 connections) — `scripts/ops/error-label.ts`
- **apply-quarantined-visit-days.ts** (7 connections) — `scripts/ops/apply-quarantined-visit-days.ts`
- **zero-credit-limits.ts** (6 connections) — `scripts/ops/zero-credit-limits.ts`
- **main()** (5 connections) — `scripts/ops/zero-credit-limits.ts`
- **golive-rehearsal.test.ts** (4 connections) — `tests/integration/golive-rehearsal.test.ts`
- **main()** (4 connections) — `scripts/ops/apply-quarantined-visit-days.ts`
- **export-crm-terms.ts** (4 connections) — `scripts/ops/export-crm-terms.ts`
- **assertUsableActor()** (4 connections) — `scripts/ops/requeue-untracked.ts`
- **main()** (4 connections) — `scripts/ops/requeue-untracked.ts`
- **main()** (3 connections) — `scripts/ops/export-crm-terms.ts`
- **Plan** (2 connections) — `scripts/ops/apply-quarantined-visit-days.ts`
- **wouldRequeue()** (2 connections) — `scripts/ops/requeue-untracked.ts`
- **cashCodesFromMaster()** (2 connections) — `scripts/ops/zero-credit-limits.ts`
- **DIR** (1 connections) — `tests/integration/golive-rehearsal.test.ts`
- **MockUser** (1 connections) — `tests/integration/golive-rehearsal.test.ts`
- *... and 14 more nodes in this community*

## Relationships

- [[recompute-cr-norm area]] (11 shared connections)
- [[Completeness rescore]] (11 shared connections)
- [[verify-load area]] (6 shared connections)
- [[Users page and password forms]] (2 shared connections)
- [[Auth and page scope loading]] (2 shared connections)
- [[Go-live account and master builder]] (2 shared connections)
- [[Duplicates, archive and Temix codes]] (2 shared connections)
- [[Account master import]] (1 shared connections)
- [[Edit submit and approval engine]] (1 shared connections)
- [[ops:rescore-completeness operator script area]] (1 shared connections)

## Source Files

- `lib/demo-accounts.ts`
- `scripts/ops/apply-quarantined-visit-days.ts`
- `scripts/ops/error-label.ts`
- `scripts/ops/export-crm-terms.ts`
- `scripts/ops/requeue-untracked.ts`
- `scripts/ops/zero-credit-limits.ts`
- `tests/integration/golive-rehearsal.test.ts`
- `tests/unit/operator-error-label.test.ts`
- `tests/unit/temix-requeue-guard.test.ts`

## Audit Trail

- EXTRACTED: 180 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*