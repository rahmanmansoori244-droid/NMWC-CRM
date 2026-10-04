# approveEditCore()

> God node · 44 connections · `services/edits.ts`

**Community:** [[Edit submit and approval engine]]

## Connections by Relation

### calls
- [[writeAudit()]] `EXTRACTED`
- [[getAuditEnvelope()]] `EXTRACTED`
- [[applyEditChanges()]] `EXTRACTED`
- [[finalizeCreateInTx()]] `EXTRACTED`
- [[stepDeadline()]] `EXTRACTED`
- [[notifyUsers()]] `EXTRACTED`
- [[collectMissingMandatory()]] `EXTRACTED`
- [[approveEditAction()]] `EXTRACTED`
- [[parseChain()]] `EXTRACTED`
- [[lockCustomerRow()]] `EXTRACTED`
- [[canActOnStep()]] `EXTRACTED`
- [[planApproval()]] `EXTRACTED`
- [[resolveStepAudience()]] `EXTRACTED`
- [[evidenceIds()]] `EXTRACTED`
- [[resolveChannelPair()]] `EXTRACTED`
- [[gateBranchesForApproval()]] `EXTRACTED`
- [[assertStatusEvidence()]] `EXTRACTED`
- [[isFinalStep()]] `EXTRACTED`
- [[stageSnapshot()]] `EXTRACTED`
- [[storedFieldChanges()]] `EXTRACTED`

### contains
- [[edits.ts]] `EXTRACTED`

### imports_from
- [[access.ts]] `EXTRACTED`

### references
- [[F05: salesman submit gate scoped to his own route's branches, frozen on the request]] `EXTRACTED`
- [[Spec: approval behaviour for the final UPDATE step]] `EXTRACTED`
- [[EL-01: Salesman can flip customer-level status to CLOSED via the edit form]] `EXTRACTED`
- [[[7/15] P2 RK-2 CREATE scope drift: frozen draft region vs current route region]] `EXTRACTED`
- [[[1] P1 EL-04 re-check blocks branch-CLOSE approvals for imported customers]] `EXTRACTED`
- [[EL-04 approval-time mandatory re-gate]] `EXTRACTED`
- [[PROD-001 atomic claim (updateMany guarded on state SUBMITTED)]] `INFERRED`
- [[[22] P3 EL-04 approve-time photo gate is a TOCTOU]] `EXTRACTED`
- [[WRONG_LANE guard in approveEditCore/rejectEditCore]] `EXTRACTED`
- [[PROD-001 Atomic approval claim (one winner per race)]] `INFERRED`
- [[God-function debt (promoteCustomerBatchCore, approveEditCore, submitEditCore)]] `EXTRACTED`
- [[[32] P3 UPDATE approve transaction uses default 5s timeout]] `EXTRACTED`
- [[#17 P2 Close-shop requests un-approvable on import-born customers (EL-04)]] `EXTRACTED`
- [[classifyChanges: DROPPED / CONVERGED / STALE / APPLY per stored change]] `EXTRACTED`

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*