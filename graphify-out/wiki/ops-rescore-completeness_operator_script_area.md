# ops:rescore-completeness operator script area

> 11 nodes · cohesion 0.29

## Key Concepts

- **ops:rescore-completeness operator script** (14 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Phase 2 spec: one-off production completeness rescore** (12 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Production rescore runbook (CI-green, dry run, owner go-ahead, apply, dry run shows 0, smoke)** (6 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Read-only owner-decision counts (F16 mismatched pairs, F05 multi-route customers, N02 empty names)** (5 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Dry run writes nothing and prints counts only (no name, code, phone or id)** (4 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Dashboard region and route leaderboards fed by Branch.completenessScore** (3 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **CompletenessRescore STARTING / COMPLETED ledger rows** (2 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Sorted FOR UPDATE customer locks per chunk** (2 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **npm run smoke (before and after every production change)** (2 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Raw UPDATE ... FROM (VALUES ...) score writes** (2 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`
- **Operator-script safety model (own client on the owner connection, --expect-host, actor resolution)** (2 connections) — `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`

## Relationships

- [[Edit service and channel pairs]] (5 shared connections)
- [[Completeness rescore]] (4 shared connections)
- [[Duplicates, archive and Temix codes]] (2 shared connections)
- [[Phase 2 spec contract]] (1 shared connections)
- [[PageHeader area]] (1 shared connections)
- [[Audit log writing]] (1 shared connections)
- [[Access scope and submit gate]] (1 shared connections)
- [[New-customer creation and phones]] (1 shared connections)
- [[recompute-cr-norm area]] (1 shared connections)
- [[Operator script guards]] (1 shared connections)
- [[Photos and completeness scoring]] (1 shared connections)
- [[F21: verified-zero equipment plus import area]] (1 shared connections)

## Source Files

- `docs/design/phase2-edit-semantics/spec-prod_rescore.txt`

## Audit Trail

- EXTRACTED: 51 (94%)
- INFERRED: 3 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*