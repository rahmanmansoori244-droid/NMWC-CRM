# Unified CRM blueprints

> 27 nodes · cohesion 0.11

## Key Concepts

- **Blueprint: target data model and schema changes** (20 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Blueprint: net-new customer creation (field onboarding)** (13 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **C7: temixCode crosswalk, TemixSyncState queue and TemixSyncBatch** (8 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **C1: Role enum from 5 to 8 values (ACCOUNTANT, FINANCE_MANAGER, GM)** (7 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **C3: create-request spine on CustomerEdit with typed draft tables** (7 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Cross-blueprint data-model reconciliation (spine, temixCode uniqueness, no EditStage, TemixSyncState names)** (7 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Unbound-attachment photos at create time (finalize without attach)** (4 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **C4: multi-step approval data (approvalChain, currentStepIndex, pendingRole, EditApproval)** (4 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **createPayloadSchema / createBranchDraftSchema (zod)** (3 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **CustomerCreateRequest / CustomerCreateBranch alternative (not adopted)** (3 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **collectMissingMandatoryForCreate (mandatory gate without lock-skips)** (3 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **Onboarding duplicate policy (hard-block exact CR and EXACT_TRIPLE, phone advisory, no fuzzy)** (3 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **Orphan unbound-attachment sweep in photo-gc** (3 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **Provisional NMWC-YYYY-NNNNNN code via a CodeSequence counter** (3 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **C5: SLA columns on CustomerEdit and a Notification model** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **C8: soft-delete with the Temix deactivation signal** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **C9: CodeSequence counter for nmwcCode allocation** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **EditApproval per-step decision model** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Notification model (readAt and emailedAt, no channel enum)** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **pendingRole denormalized queue key (no separate EditStage enum)** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **CreateCustomerForm at /customers/new (payment-terms selector, multi-branch repeater)** (2 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **EditCustomerDraft model** (2 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Four ordered migrations with enum additions isolated first** (2 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **TemixSyncBatch snapshot table (modelled on ExportJob)** (2 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Create-time exact-CR duplicate hard-block (owner-confirmed)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- *... and 2 more nodes in this community*

## Relationships

- [[NMWC Unified CRM: target operating model area]] (12 shared connections)
- [[Create finalize and synthetic data]] (4 shared connections)
- [[NEW system: data model and data dictiona area]] (4 shared connections)
- [[Design: multi-tier, payment-terms-condit area]] (3 shared connections)
- [[Design: SLA / escalation, notifications  area]] (3 shared connections)
- [[New-customer creation and phones]] (2 shared connections)
- [[NEW system: documentation versus impleme area]] (2 shared connections)
- [[Enrichment form and patch v2]] (1 shared connections)
- [[Edit value model]] (1 shared connections)
- [[Edit submit and approval engine]] (1 shared connections)
- [[page area]] (1 shared connections)
- [[route area]] (1 shared connections)

## Source Files

- `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- `docs/discovery/blueprint-inputs/creation-flow.md`
- `docs/discovery/blueprint-inputs/data-model.md`

## Audit Trail

- EXTRACTED: 116 (97%)
- INFERRED: 3 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*