# OLD to NEW data migration / ETL runbook area

> 20 nodes · cohesion 0.14

## Key Concepts

- **OLD to NEW data migration / ETL runbook** (25 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Gate G0: verify OLD datastore, code equivalence and counts before any extraction** (5 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **ETL runbook gates G0-G5 plus soak** (5 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **LegacyCrosswalk table with match tiers T1-T5** (4 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **V-2: does OLD temixCode equal NEW nmwcCode?** (4 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **OLD to NEW role crosswalk (ADMIN and ROUTEPRO open)** (3 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Payment terms sourced from the Temix export, never inferred** (3 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **DEPOT_REGION_MAP owner-signed crosswalk** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **History: freeze OLD as an archive, do not inject it into AuditLog** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **LEGACY_CHANNEL_MAP fail-loud channel crosswalk** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **migration-bot user (inactive STEWARD owning migrated lineage)** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Oman GPS envelope (lat 16-27, lng 51-61, enforced in the app layer)** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Photo re-host from Vercel Blob to R2 (script-inserted Attachments)** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **ETL principles: one-way and one-time, current state only, fail loud, reuse NEW machinery** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Reconciliation checks R1-R5 (Gate G4)** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Go-live by re-running the idempotent ETL against production, not promoting the Neon branch** (2 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Migration-blocking questions (Q-old-db, Q-channel-map, Q-depot-region)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **Temix master export to be provided by NMWC (payment terms and credit figures source)** (2 connections) — `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- **legacy-ico/ archive versus the 30-day R2 backup lifecycle rule** (1 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`
- **Field precedence: OLD fills only NULL or empty NEW fields** (1 connections) — `docs/discovery/blueprint-inputs/migration-etl.md`

## Relationships

- [[NMWC Unified CRM: target operating model area]] (3 shared connections)
- [[NMWC CRM: discovery and understanding re area]] (3 shared connections)
- [[Design: SLA / escalation, notifications  area]] (1 shared connections)
- [[Design: multi-tier, payment-terms-condit area]] (1 shared connections)
- [[NEW system: documentation versus impleme area]] (1 shared connections)
- [[NEW system: data model and data dictiona area]] (1 shared connections)
- [[NEW system: repository and architecture  area]] (1 shared connections)
- [[NMWC Unified CRM: security remediation a area]] (1 shared connections)
- [[CR normalisation and row checks]] (1 shared connections)
- [[New-customer creation and phones]] (1 shared connections)
- [[Edit value model]] (1 shared connections)
- [[Photos and completeness scoring]] (1 shared connections)

## Source Files

- `docs/discovery/NMWC-CRM-Consolidation-Blueprint.md`
- `docs/discovery/blueprint-inputs/migration-etl.md`

## Audit Trail

- EXTRACTED: 72 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*