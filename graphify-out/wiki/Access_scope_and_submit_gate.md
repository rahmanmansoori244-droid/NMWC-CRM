# Access scope and submit gate

> 49 nodes · cohesion 0.07

## Key Concepts

- **access.ts** (46 connections) — `lib/access.ts`
- **edit-scope.ts** (23 connections) — `lib/edit-scope.ts`
- **edit-scope.test.ts** (15 connections) — `tests/unit/edit-scope.test.ts`
- **F05: salesman submit gate scoped to his own route's branches, frozen on the request** (14 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **canSeeCustomer()** (12 connections) — `lib/access.ts`
- **access.test.ts** (12 connections) — `tests/unit/access.test.ts`
- **salesmanBranches()** (11 connections) — `lib/edit-scope.ts`
- **assertCanAccessAttachment()** (10 connections) — `lib/access.ts`
- **attachment-access-transaction.test.ts** (10 connections) — `tests/unit/attachment-access-transaction.test.ts`
- **CustomerEdit.submitGate (JSONB, nullable)** (9 connections) — `docs/design/phase2-edit-semantics/spec-migration.txt`
- **filterBranchesByScope()** (8 connections) — `lib/access.ts`
- **gateBranchesForApproval()** (7 connections) — `lib/edit-scope.ts`
- **gateForApproval (frozen record, legacy fallback, or not gated)** (7 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **Owner decision 4: the gate in force at submit judges the approval** (6 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **EL-04 approval-time mandatory re-gate** (6 connections) — `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- **Owner decision 3: a salesman's CLOSED/SUSPENDED branches still block submit** (5 connections) — `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- **parseSubmitGate()** (4 connections) — `lib/edit-scope.ts`
- **withoutSubmitterLockedFields()** (4 connections) — `lib/edit-scope.ts`
- **assertCanSeeCustomer()** (3 connections) — `lib/access.ts`
- **branchIdsNamedIn()** (3 connections) — `lib/edit-scope.ts`
- **NEEDS_REUPLOAD refusal (unchanged)** (3 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **SubmitGateRecord {v:1, gate, branchIds}** (3 connections) — `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- **Scope** (2 connections) — `lib/access.ts`
- **_AccessUser** (1 connections) — `lib/access.ts`
- **CustomerWithBranches** (1 connections) — `lib/access.ts`
- *... and 24 more nodes in this community*

## Relationships

- [[Edit submit and approval engine]] (19 shared connections)
- [[Customer edit pages and badges]] (11 shared connections)
- [[Auth and page scope loading]] (5 shared connections)
- [[Permissions and user administration]] (4 shared connections)
- [[Photos and completeness scoring]] (4 shared connections)
- [[Approval chains and detail page]] (3 shared connections)
- [[route area]] (3 shared connections)
- [[errors area]] (3 shared connections)
- [[Cross-domain and RBAC audits]] (3 shared connections)
- [[Edit value model]] (3 shared connections)
- [[DB roles and migrations]] (3 shared connections)
- [[Edit service and channel pairs]] (3 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- `docs/design/phase2-edit-semantics/spec-migration.txt`
- `docs/design/phase2-edit-semantics/spec-owner_decisions.txt`
- `docs/design/phase2-edit-semantics/spec-payload_contract.txt`
- `docs/design/phase2-edit-semantics/spec-per_finding.txt`
- `lib/access.ts`
- `lib/edit-scope.ts`
- `tests/unit/access.test.ts`
- `tests/unit/attachment-access-transaction.test.ts`
- `tests/unit/edit-scope.test.ts`

## Audit Trail

- EXTRACTED: 240 (96%)
- INFERRED: 9 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*