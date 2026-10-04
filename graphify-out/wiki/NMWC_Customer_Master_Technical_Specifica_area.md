# NMWC Customer Master Technical Specifica area

> 24 nodes · cohesion 0.12

## Key Concepts

- **NMWC Customer Master Technical Specification** (18 connections) — `docs/TECH-SPEC.md`
- **Pilot E2E Test 2026-05-10** (5 connections) — `docs/PILOT-E2E-TEST-2026-05-10.md`
- **Field-level locks via isFieldLocked** (5 connections) — `docs/TECH-SPEC.md`
- **Photo upload flow: presign, direct PUT to R2, finalize** (5 connections) — `docs/TECH-SPEC.md`
- **SafeAction discriminated-union result contract for server actions** (4 connections) — `docs/PROJECT-DESCRIPTION.md`
- **RBAC through pure permission functions called first in every service** (4 connections) — `docs/TECH-SPEC.md`
- **Server Actions and route-handler API surface** (4 connections) — `docs/TECH-SPEC.md`
- **Bug #1: AUTH-09 forced password change silently dead in Edge middleware** (3 connections) — `docs/PILOT-E2E-TEST-2026-05-10.md`
- **Bug #2: EL-01 status flip not blocked at approve time** (3 connections) — `docs/PILOT-E2E-TEST-2026-05-10.md`
- **ConflictError messages lost across the server-action boundary** (3 connections) — `docs/PILOT-E2E-TEST-2026-05-10.md`
- **Tier 1 live scenarios: scoping, IDOR, approvals, forced password change** (3 connections) — `docs/PILOT-E2E-TEST-2026-05-10.md`
- **PROD-006 SafeAction error contract via runAction()** (3 connections) — `docs/SESSION-HANDOFF-2026-05-10.md`
- **Served photo content-type decided at /api/photos/[id] (lib/photo-mime.ts)** (3 connections) — `docs/SESSION-MASTER-RECORD.md`
- **Error taxonomy mapped to HTTP statuses (400, 403, 404, 409, 429)** (3 connections) — `docs/TECH-SPEC.md`
- **Idempotent field-form submits via submissionId (item 22)** (3 connections) — `docs/TECH-SPEC.md`
- **Security checklist with audit-immutability and content-type annotations** (3 connections) — `docs/TECH-SPEC.md`
- **EL-16: isFieldLocked ignores its field parameter** (2 connections) — `docs/audit/02-edit-lifecycle.md`
- **Workflows still untested live (photos/GPS, close and reactivate, imports, races)** (2 connections) — `docs/PILOT-E2E-TEST-2026-05-10.md`
- **Cash vs Credit field locks: name and CR locked for Credit customers** (2 connections) — `docs/PRD-v0.1.md`
- **Account-master import aborts on a mixed valid/invalid file (spawned task)** (2 connections) — `docs/SESSION-HANDOFF-2026-05-09.md`
- **Single-deployable Next.js architecture with service and repository layers** (2 connections) — `docs/TECH-SPEC.md`
- **Build plan milestones M0-M8** (1 connections) — `docs/TECH-SPEC.md`
- **Active risk register R1-R5** (1 connections) — `docs/TECH-SPEC.md`
- **Soft-delete strategy via deletedAt** (1 connections) — `docs/TECH-SPEC.md`

## Relationships

- [[May 2026 audits and remediation]] (4 shared connections)
- [[Master session record and assessment]] (3 shared connections)
- [[Original PRD and UX spec]] (3 shared connections)
- [[Roadmap and service levels]] (3 shared connections)
- [[Session Handoff 2026-05-10 area]] (2 shared connections)
- [[Operations runbook]] (2 shared connections)
- [[End-to-end verification and seeds]] (1 shared connections)
- [[Pre-launch review (July)]] (1 shared connections)
- [[Enterprise readiness assessment]] (1 shared connections)
- [[NMWC Independent QA / Security / Reliabi area]] (1 shared connections)

## Source Files

- `docs/PILOT-E2E-TEST-2026-05-10.md`
- `docs/PRD-v0.1.md`
- `docs/PROJECT-DESCRIPTION.md`
- `docs/SESSION-HANDOFF-2026-05-09.md`
- `docs/SESSION-HANDOFF-2026-05-10.md`
- `docs/SESSION-MASTER-RECORD.md`
- `docs/TECH-SPEC.md`
- `docs/audit/02-edit-lifecycle.md`

## Audit Trail

- EXTRACTED: 68 (80%)
- INFERRED: 17 (20%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*