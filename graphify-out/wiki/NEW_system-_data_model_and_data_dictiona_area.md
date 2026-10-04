# NEW system: data model and data dictiona area

> 18 nodes · cohesion 0.16

## Key Concepts

- **NEW system: data model and data dictionary (raw evidence)** (14 connections) — `docs/discovery/raw-evidence/new-data.md`
- **CustomerEdit_open_per_customer partial unique index** (5 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **Branch model (branchCode, GPS, equipment counts, version)** (4 connections) — `docs/discovery/raw-evidence/new-data.md`
- **branch_region_consistency_check trigger (Branch.regionId must equal Route.regionId)** (4 connections) — `docs/discovery/raw-evidence/new-data.md`
- **CustomerEdit model (fieldChanges JSON, EditState machine)** (4 connections) — `docs/discovery/raw-evidence/new-data.md`
- **No DB guard against concurrent open branch-target edits** (4 connections) — `docs/discovery/raw-evidence/new-data.md`
- **C10: CustomerEdit_open_per_branch partial unique index** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **EditBranchDraft model (replicated GPS/address CHECKs and region trigger)** (3 connections) — `docs/discovery/blueprint-inputs/data-model.md`
- **Quarantine through an ImportBatch of kind LEGACY_ICO** (3 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Customer model (nmwcCode business key, version lock, soft-delete)** (3 connections) — `docs/discovery/raw-evidence/new-data.md`
- **Loose scalar references without FKs (createdById, lastEditedById, importBatchId, Attachment ids)** (3 connections) — `docs/discovery/raw-evidence/new-data.md`
- **Phone uniqueness added then dropped** (3 connections) — `docs/discovery/raw-evidence/new-data.md`
- **Attachment model (sha256 hash, denormalized customerId/branchId)** (2 connections) — `docs/discovery/raw-evidence/new-data.md`
- **Dead or write-only fields (newRouteId, isWrongRoute, decisionCategory)** (2 connections) — `docs/discovery/raw-evidence/new-data.md`
- **ImportBatch.kind magic string (CUSTOMER / ACCOUNT)** (2 connections) — `docs/discovery/raw-evidence/new-data.md`
- **DB invariants live only in hand-written migration SQL** (2 connections) — `docs/discovery/raw-evidence/new-data.md`
- **AuditLog model (immutable before/after)** (1 connections) — `docs/discovery/raw-evidence/new-data.md`
- **User model (username, ownedRouteId, managedRegions)** (1 connections) — `docs/discovery/raw-evidence/new-data.md`

## Relationships

- [[Unified CRM blueprints]] (4 shared connections)
- [[Edit submit and approval engine]] (1 shared connections)
- [[Design: multi-tier, payment-terms-condit area]] (1 shared connections)
- [[Import row fixing and promote]] (1 shared connections)
- [[OLD to NEW data migration / ETL runbook area]] (1 shared connections)
- [[DB roles and migrations]] (1 shared connections)
- [[F21: verified-zero equipment plus import area]] (1 shared connections)
- [[Access scope and submit gate]] (1 shared connections)
- [[Duplicates, archive and Temix codes]] (1 shared connections)
- [[NEW system: documentation versus impleme area]] (1 shared connections)

## Source Files

- `docs/discovery/blueprint-inputs/approval-engine.md`
- `docs/discovery/blueprint-inputs/data-model.md`
- `docs/discovery/blueprint-inputs/migration-etl.md`
- `docs/discovery/raw-evidence/new-data.md`

## Audit Trail

- EXTRACTED: 60 (95%)
- INFERRED: 3 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*