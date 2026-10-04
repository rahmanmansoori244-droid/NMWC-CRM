# Approval chains and detail page

> 32 nodes · cohesion 0.10

## Key Concepts

- **page.tsx** (42 connections) — `app/(app)/approvals/[id]/page.tsx`
- **approval-chains.ts** (26 connections) — `lib/approval-chains.ts`
- **rejectEditCore()** (13 connections) — `services/edits.ts`
- **stepDeadline()** (12 connections) — `lib/approval-chains.ts`
- **ApprovalDetailPage()** (11 connections) — `app/(app)/approvals/[id]/page.tsx`
- **resolveChain()** (11 connections) — `lib/approval-chains.ts`
- **parseChain()** (10 connections) — `lib/approval-chains.ts`
- **canActOnStep()** (10 connections) — `lib/permissions.ts`
- **approval-engine.test.ts** (9 connections) — `tests/unit/approval-engine.test.ts`
- **F-C11 Supervisor can decide a Manager-only reactivation via the generic engine (P1)** (8 connections) — `qa/findings/register.md`
- **resolveRejectTarget()** (7 connections) — `lib/approval-chains.ts`
- **isFinalStep()** (6 connections) — `lib/approval-chains.ts`
- **stageSnapshot()** (6 connections) — `lib/working-hours.ts`
- **WRONG_LANE guard in approveEditCore/rejectEditCore** (5 connections) — `qa/findings/register.md`
- **DiffRow()** (2 connections) — `app/(app)/approvals/[id]/page.tsx`
- **isEmpty()** (2 connections) — `app/(app)/approvals/[id]/page.tsx`
- **ApprovalStep** (2 connections) — `lib/approval-chains.ts`
- **stageHours()** (2 connections) — `lib/approval-chains.ts`
- **metadata** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- **PhotoRow()** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- **APPROVER_ROLES** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- **DetailRow()** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- **DetailSection()** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- **DiffSection()** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- **FieldChange** (1 connections) — `app/(app)/approvals/[id]/page.tsx`
- *... and 7 more nodes in this community*

## Relationships

- [[Edit submit and approval engine]] (25 shared connections)
- [[New-customer creation and phones]] (9 shared connections)
- [[Permissions and user administration]] (7 shared connections)
- [[Approval decision UI and bulk]] (6 shared connections)
- [[working-hours area]] (6 shared connections)
- [[reactivations area]] (5 shared connections)
- [[Auth and page scope loading]] (3 shared connections)
- [[gps-manual area]] (3 shared connections)
- [[CustomerCard area]] (3 shared connections)
- [[QA defect register]] (3 shared connections)
- [[Access scope and submit gate]] (3 shared connections)
- [[route area]] (3 shared connections)

## Source Files

- `app/(app)/approvals/[id]/page.tsx`
- `lib/approval-chains.ts`
- `lib/permissions.ts`
- `lib/working-hours.ts`
- `qa/findings/register.md`
- `services/edits.ts`
- `tests/unit/approval-engine.test.ts`

## Audit Trail

- EXTRACTED: 185 (93%)
- INFERRED: 13 (7%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*