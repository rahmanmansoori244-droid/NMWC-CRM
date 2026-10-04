# Edit service and channel pairs

> 45 nodes · cohesion 0.06

## Key Concepts

- **edit-service.test.ts** (32 connections) — `tests/unit/edit-service.test.ts`
- **F16: channel / sub-channel pair validation at submit, approval and import** (13 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **F20: omitted = keep, null = clear, value = set** (13 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **channel-pair.ts** (11 connections) — `lib/channel-pair.ts`
- **Phase 2 spec: owner decisions** (10 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **editPayload()** (8 connections) — `tests/support/edit-payload.ts`
- **resolveChannelPair()** (7 connections) — `lib/channel-pair.ts`
- **Owner decision 7: read-only counts before any production cleanup or DB backstop** (7 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **submitEditAction()** (7 connections) — `services/edits.ts`
- **channel-pair.test.ts** (7 connections) — `tests/unit/channel-pair.test.ts`
- **CLEARABLE_CUSTOMER_FIELDS / CLEARABLE_BRANCH_FIELDS** (5 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **subChannelClearedByChannelChange()** (4 connections) — `lib/channel-pair.ts`
- **Owner decision 1: CR number may be cleared from the edit form** (4 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **CHANNEL_PAIR_INVALID approval refusal (ConflictError, 409)** (3 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **Owner decision 2: day of visit can be changed but not cleared** (3 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **Owner decision 8: run the one-off completeness rescore on production** (3 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **Standing production-write permission (granted 2026-09-27)** (3 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **body()** (3 connections) — `tests/unit/edit-service.test.ts`
- **submit()** (3 connections) — `tests/unit/edit-service.test.ts`
- **RBAC-05-004 Manager direct-write with no region check or reason** (2 connections) — `docs/audit/05-rbac-scope.md`
- **ChannelPairDb** (2 connections) — `lib/channel-pair.ts`
- **Owner decision 5: the import clears a sub-channel that belongs to the replaced channel** (2 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **Left out: DB backstops (N02 CHECKs, channel trigger) and all production cleanups** (2 connections) — `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- **EditPatch** (2 connections) — `tests/support/edit-payload.ts`
- **sent()** (2 connections) — `tests/support/edit-payload.ts`
- *... and 20 more nodes in this community*

## Relationships

- [[Edit value model]] (12 shared connections)
- [[Edit submit and approval engine]] (8 shared connections)
- [[New-customer creation and phones]] (8 shared connections)
- [[Phase 2 spec contract]] (5 shared connections)
- [[ops:rescore-completeness operator script area]] (5 shared connections)
- [[golive-update-flow.test area]] (4 shared connections)
- [[Account master import]] (3 shared connections)
- [[Access scope and submit gate]] (3 shared connections)
- [[F21: verified-zero equipment plus import area]] (2 shared connections)
- [[DB roles and migrations]] (2 shared connections)
- [[Audit immutability tests]] (2 shared connections)
- [[Cross-domain and RBAC audits]] (1 shared connections)

## Source Files

- `docs/audit/05-rbac-scope.md`
- `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- `docs/design/phase2-edit-semantics/spec-risks_and_left_out.txt`
- `lib/channel-pair.ts`
- `services/edits.ts`
- `tests/support/edit-payload.ts`
- `tests/unit/channel-pair.test.ts`
- `tests/unit/edit-service.test.ts`

## Audit Trail

- EXTRACTED: 175 (97%)
- INFERRED: 5 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*