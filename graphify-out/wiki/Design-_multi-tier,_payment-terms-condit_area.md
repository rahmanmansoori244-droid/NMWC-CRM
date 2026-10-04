# Design: multi-tier, payment-terms-condit area

> 11 nodes · cohesion 0.25

## Key Concepts

- **Design: multi-tier, payment-terms-conditional approval engine** (19 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **SR-H1: Manager direct-write region scope and edit-page gate** (10 connections) — `docs/discovery/blueprint-inputs/security-remediation.md`
- **NEW-H-1: Manager direct-write not region-scoped (BOLA)** (6 connections) — `docs/discovery/NMWC-CRM-Discovery-Report.md`
- **APPROVAL_CHAINS config-in-code matrix** (4 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **Approval chain snapshot frozen per request at submit** (3 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **Atomic step claim pinned on step and cycle** (3 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **ApprovalStepDecision model (unique per edit, cycle and step)** (3 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **ApprovalProcess (UPDATE / CREATE_CASH / CREATE_CREDIT) resolved from payment terms** (2 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **Preserved approve-time invariants (STATUS_BYPASS, QA-013 lock re-eval, EL-04, QA-039)** (2 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **UPDATE workflow: Salesman enriches, Supervisor approves (region-scoped direct write for Steward/Manager)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Approval-engine open questions O-1..O-9** (1 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`

## Relationships

- [[NMWC Unified CRM: target operating model area]] (6 shared connections)
- [[Design: SLA / escalation, notifications  area]] (3 shared connections)
- [[Unified CRM blueprints]] (3 shared connections)
- [[Customer edit pages and badges]] (3 shared connections)
- [[Access scope and submit gate]] (2 shared connections)
- [[Edit submit and approval engine]] (2 shared connections)
- [[NMWC Unified CRM: security remediation a area]] (2 shared connections)
- [[Create finalize and synthetic data]] (1 shared connections)
- [[NEW system: data model and data dictiona area]] (1 shared connections)
- [[Approval chains and detail page]] (1 shared connections)
- [[Duplicates, archive and Temix codes]] (1 shared connections)
- [[NMWC CRM: discovery and understanding re area]] (1 shared connections)

## Source Files

- `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- `docs/discovery/NMWC-CRM-Discovery-Report.md`
- `docs/discovery/blueprint-inputs/approval-engine.md`
- `docs/discovery/blueprint-inputs/security-remediation.md`

## Audit Trail

- EXTRACTED: 51 (93%)
- INFERRED: 4 (7%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*