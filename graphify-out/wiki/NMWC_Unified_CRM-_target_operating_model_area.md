# NMWC Unified CRM: target operating model area

> 21 nodes · cohesion 0.15

## Key Concepts

- **NMWC Unified CRM: target operating model and consolidation blueprint (2026-07-15)** (45 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **CREATE Credit workflow: Supervisor, Finance Manager, GM, Accountant, then Temix upload** (6 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **canActOnStep step-aware authorization** (5 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **Create request threads the approval engine and materializes only on final approval** (4 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **C2: credit data (creditLimit, paymentTermDays, GUARANTEE attachments)** (4 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Phase 6 adoption hardening: Arabic/RTL, offline capture, delegation, dashboards** (4 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Arabic / i18n / RTL absent (top adoption risk)** (4 connections) — `docs/discovery/NMWC-CRM-Discovery-Report.md`
- **Approver scope: Finance Manager and GM org-wide, Accountant region-scoped** (3 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Phased build roadmap (Phase 0 security to Phase 6 adoption hardening)** (3 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Separation of duties: no single person acts on two steps of one request** (3 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Step-back rejection cascade (owner-confirmed 2026-07-15)** (3 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Target operating model: one app, three processes, one master, one ERP** (3 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **English-only UI (no i18n mechanism)** (3 connections) — `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- **RETURN vs REJECT with full chain restart (proposed v1)** (2 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **CASH-to-CREDIT conversion forced onto the credit chain** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **CREATE Cash workflow: Supervisor then Accountant, then Temix upload** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **GM always required for credit (no threshold skip)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **No credit amendment by Finance Manager or GM (owner-confirmed)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Q-acct-regions answered 2026-09-20: one ACCOUNTANT per region** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Q-pingpong loop guard (same step rejects an unchanged request twice: send to salesman)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **System-of-record split: CRM owns master attributes, Temix owns transactions and the ERP code** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`

## Relationships

- [[Unified CRM blueprints]] (12 shared connections)
- [[NMWC CRM: discovery and understanding re area]] (8 shared connections)
- [[NMWC Unified CRM: security remediation a area]] (7 shared connections)
- [[Design: multi-tier, payment-terms-condit area]] (6 shared connections)
- [[OLD to NEW data migration / ETL runbook area]] (3 shared connections)
- [[Permissions and user administration]] (2 shared connections)
- [[Design: SLA / escalation, notifications  area]] (2 shared connections)
- [[Phase 2 spec contract]] (2 shared connections)
- [[Access scope and submit gate]] (1 shared connections)
- [[NEW system: documentation versus impleme area]] (1 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-errors_and_messages.txt`
- `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- `docs/discovery/NMWC-CRM-Discovery-Report.md`
- `docs/discovery/blueprint-inputs/approval-engine.md`
- `docs/discovery/blueprint-inputs/creation-flow.md`
- `docs/discovery/blueprint-inputs/data-model.md`

## Audit Trail

- EXTRACTED: 95 (90%)
- INFERRED: 11 (10%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*