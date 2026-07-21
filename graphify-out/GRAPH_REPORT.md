# Graph Report - .  (2026-07-21)

## Corpus Check
- Corpus is ~37,648 words - fits in a single context window. You may not need a graph.

## Summary
- 257 nodes · 357 edges · 40 communities (16 shown, 24 thin omitted)
- Extraction: 73% EXTRACTED · 27% INFERRED · 0% AMBIGUOUS · INFERRED: 97 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Approval Chain Engine|Approval Chain Engine]]
- [[_COMMUNITY_Approval Queue & Atomic-Claim Lanes|Approval Queue & Atomic-Claim Lanes]]
- [[_COMMUNITY_Ops, Auth & Deployment|Ops, Auth & Deployment]]
- [[_COMMUNITY_Import  Promote & Schema|Import / Promote & Schema]]
- [[_COMMUNITY_Temix Master Import & Risks|Temix Master Import & Risks]]
- [[_COMMUNITY_Region Scope & Adversarial Review|Region Scope & Adversarial Review]]
- [[_COMMUNITY_Access Control & Customer List|Access Control & Customer List]]
- [[_COMMUNITY_Temix ERP Sync|Temix ERP Sync]]
- [[_COMMUNITY_Secrets & Cron Reliability|Secrets & Cron Reliability]]
- [[_COMMUNITY_Photos & Merge|Photos & Merge]]
- [[_COMMUNITY_SLA Working-Hours Calendar|SLA Working-Hours Calendar]]
- [[_COMMUNITY_Planning Documents|Planning Documents]]
- [[_COMMUNITY_Cron Infrastructure|Cron Infrastructure]]
- [[_COMMUNITY_Synthetic Reset Guard|Synthetic Reset Guard]]
- [[_COMMUNITY_Production DB Isolation|Production DB Isolation]]
- [[_COMMUNITY_CR Uniqueness  Duplicate Block|CR Uniqueness / Duplicate Block]]
- [[_COMMUNITY_Constraint-Smoke Gate|Constraint-Smoke Gate]]
- [[_COMMUNITY_Rate Limiting|Rate Limiting]]
- [[_COMMUNITY_Temix Batch Cap|Temix Batch Cap]]
- [[_COMMUNITY_Middleware Auth|Middleware Auth]]
- [[_COMMUNITY_Migration Compatibility|Migration Compatibility]]
- [[_COMMUNITY_Separation of Duty|Separation of Duty]]
- [[_COMMUNITY_DB Backup Workflow|DB Backup Workflow]]
- [[_COMMUNITY_Keep-Warm Workflow|Keep-Warm Workflow]]
- [[_COMMUNITY_Phone Normalization|Phone Normalization]]
- [[_COMMUNITY_Online UAT Environment|Online UAT Environment]]
- [[_COMMUNITY_NEEDS_CORRECTION PII|NEEDS_CORRECTION PII]]
- [[_COMMUNITY_RegionRoute Audit Gaps|Region/Route Audit Gaps]]
- [[_COMMUNITY_Executability Boundary|Executability Boundary]]
- [[_COMMUNITY_Performance SLO Gap|Performance SLO Gap]]
- [[_COMMUNITY_Local Test Environment|Local Test Environment]]
- [[_COMMUNITY_Excel Row Guard|Excel Row Guard]]
- [[_COMMUNITY_SoD Puppet Risk|SoD Puppet Risk]]
- [[_COMMUNITY_Frozen-Chain Authz Drift|Frozen-Chain Authz Drift]]
- [[_COMMUNITY_Photo-GC Orphan Risk|Photo-GC Orphan Risk]]
- [[_COMMUNITY_Optimistic Locking|Optimistic Locking]]
- [[_COMMUNITY_Baseline Lint|Baseline Lint]]
- [[_COMMUNITY_Baseline Typecheck|Baseline Typecheck]]
- [[_COMMUNITY_Baseline Unit Tests|Baseline Unit Tests]]
- [[_COMMUNITY_Viewer Role|Viewer Role]]

## God Nodes (most connected - your core abstractions)
1. `Pre-launch deep review (round 1)` - 26 edges
2. `services/imports.ts` - 18 edges
3. `Deep scan round 2` - 17 edges
4. `CREDIT approval chain (SUP to FM to GM to ACC)` - 8 edges
5. `R1-#4/#8 [P2] Promote has no crash/timeout recovery — batch stranded in PROMOTING forever` - 8 edges
6. `R1-#5 [P2] attachPhoto/detachPhoto TOCTOU — dangling photo-slot pointers the GC then destroys` - 8 edges
7. `R1-#15 [P2] CRON_SECRET/HEALTH_BEARER/DEMO_ACCOUNTS_DISABLED read by prod code but absent from docs` - 8 edges
8. `R1-#16 [P2] CREATE request wedges at Accountant step when route is re-regioned mid-chain (RK-2)` - 8 edges
9. `services/imports.ts` - 7 edges
10. `Step-aware approval engine` - 7 edges

## Surprising Connections (you probably didn't know these)
- `C8 Import promote cannot handle the full ~3,300 master` --semantically_similar_to--> `RK-3 Large master promote times out (stuck PROMOTING)`  [INFERRED] [semantically similar]
  OPUS-QA-EXECUTION-PLAN.md → OPUS-4.8-MASTER-EXECUTION-PLAN.md
- `C5 synthetic.ts --reset is an unguarded TRUNCATE CASCADE` --semantically_similar_to--> `E1 db:synthetic:reset unguarded TRUNCATE stop condition`  [INFERRED] [semantically similar]
  OPUS-QA-EXECUTION-PLAN.md → OPUS-4.8-MASTER-EXECUTION-PLAN.md
- `Verdict — CONDITIONALLY READY / GO for a supervised pilot` --cites--> `Deep scan round 2`  [INFERRED]
  qa-reports/PRODUCTION-READINESS-VERDICT.md → qa-findings/deep-scan-round2.md
- `RK-3 — chunked/resumable import` --conceptually_related_to--> `R1-#4/#8 [P2] Promote has no crash/timeout recovery — batch stranded in PROMOTING forever`  [INFERRED]
  qa-reports/EXEC-RECORD.md → qa-findings/pre-launch-deep-review.md
- `Gate — deploy via prisma migrate deploy, never db push` --conceptually_related_to--> `R1-#13 [P2] No automated prisma migrate deploy in the deploy path — first Phase-1 deploy outage`  [INFERRED]
  qa-reports/PRODUCTION-READINESS-VERDICT.md → qa-findings/pre-launch-deep-review.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **CREDIT approval chain participants (SUP to FM to GM to ACC, GM always)** — graphify_corpus_project_description_salesman, graphify_corpus_project_description_supervisor, graphify_corpus_project_description_finance_manager, graphify_corpus_project_description_gm, graphify_corpus_project_description_accountant, graphify_corpus_project_description_credit_approval_chain [EXTRACTED 1.00]
- **CASH approval chain participants (SUP to ACC)** — graphify_corpus_project_description_salesman, graphify_corpus_project_description_supervisor, graphify_corpus_project_description_accountant, graphify_corpus_project_description_cash_approval_chain [EXTRACTED 1.00]
- **Pre-launch round 1 P1 fixes** — graphify_corpus_session_master_record_sr_usr_01, graphify_corpus_session_master_record_sr_m2, graphify_corpus_session_master_record_prod_dup_01, graphify_corpus_session_master_record_pre_launch_deep_review [EXTRACTED 1.00]
- **Deep scan round 2 confirmed findings** — finding_supervisor_export_empty_scope, finding_branchcode_collision_promote, finding_crossregion_merge_deadend, finding_import_password_no_session_revoke, finding_account_import_unlink_supervisor, finding_promote_no_completeness_score, round_deep_scan_round2 [EXTRACTED 1.00]
- **Go-live GO/NO-GO gate conditions** — gate_secret_rotation, gate_workweek_confirm, gate_cron_reliability, gate_preview_db, gate_temix_contract, gate_chunked_import, gate_migrate_deploy, verdict_conditionally_ready [INFERRED 0.85]
- **CREDIT create approval chain (SUP→FM→GM→ACC)** — role_supervisor, role_finance_manager, role_gm, role_accountant, concept_credit_chain [EXTRACTED 1.00]

## Communities (40 total, 24 thin omitted)

### Community 0 - "Approval Chain Engine"
Cohesion: 0.07
Nodes (34): lib/approval-chains.ts, lib/create-finalize.ts, lib/permissions.ts, R14 Chain frozen at submit, R16 Loop guard, R17 FM/GM cannot amend credit figures, R19 Final materialize only after final approval, R2 Cash chain SUP to ACC (+26 more)

### Community 1 - "Approval Queue & Atomic-Claim Lanes"
Cohesion: 0.13
Nodes (25): app/(app)/approvals/page.tsx, app/(app)/reactivations/page.tsx, app/(app)/work/page.tsx, lib/approval-chains.ts, prisma/migrations/20260715120100_phase1_tables/migration.sql, services/edits.ts, services/reactivations.ts, Approval chain engine (+17 more)

### Community 2 - "Ops, Auth & Deployment"
Cohesion: 0.11
Nodes (25): app/api/cron/sla-escalate/route.ts, docs/OPERATIONS.md, docs/TECH-SPEC.md, lib/auth.ts, package.json, .github/workflows/sla-escalate.yml, vercel.json, Legacy full-upsert lane (+17 more)

### Community 3 - "Import / Promote & Schema"
Cohesion: 0.14
Nodes (24): app/(app)/import/[batchId]/page.tsx, lib/codes.ts, lib/completeness.ts, lib/notifications.ts, prisma/schema.prisma, services/exports.ts, services/imports.ts, services/users.ts (+16 more)

### Community 4 - "Temix Master Import & Risks"
Cohesion: 0.12
Nodes (22): E2 CREATE import defaults absent payment-terms to CASH, Import stage-then-promote, RK-10 Real Temix file anomalies not covered by synthetic, RK-11 Secret leakage (committed pilot creds), RK-3 Large master promote times out (stuck PROMOTING), RK-4 Temix inbound absent-column flips CREDIT to CASH, scripts/qa/generate-synthetic-master.ts, services/imports.ts (+14 more)

### Community 5 - "Region Scope & Adversarial Review"
Cohesion: 0.11
Nodes (22): Environment B (online UAT), lib/access.ts, lib/customer-filters.ts, R7 Manager regions; fail-closed empty, services/customer-export.ts, services/duplicates.ts, Adversarial multi-agent review + independent refutation, Duplicate merge (+14 more)

### Community 6 - "Access Control & Customer List"
Cohesion: 0.14
Nodes (18): app/(app)/customers/page.tsx, lib/access.ts, lib/customer-filters.ts, lib/permissions.ts, services/customer-export.ts, CASH create approval chain, CREDIT create approval chain, Region scope / access control (+10 more)

### Community 7 - "Temix ERP Sync"
Cohesion: 0.18
Nodes (16): lib/temix.ts, services/customers.ts, services/temix.ts, Duplicate customer merge, Temix refresh lane, Temix ERP sync, D2 — Temix credit-field direction is outbound (CRM-owned), D4 — Real Temix header contract (+8 more)

### Community 8 - "Secrets & Cron Reliability"
Cohesion: 0.24
Nodes (10): app/api/health/route.ts, .env.example, lib/cron-auth.ts, D3 — Move SLA-escalation + backup off GitHub Actions, C2 — committed pilot credentials in >=4 files, R1-#15 [P2] CRON_SECRET/HEALTH_BEARER/DEMO_ACCOUNTS_DISABLED read by prod code but absent from docs, Gate — cron reliability (GH Actions 60-day auto-disable), Gate — rotate & set production secrets (+2 more)

### Community 9 - "Photos & Merge"
Cohesion: 0.28
Nodes (9): app/(app)/duplicates/MergeForm.tsx, app/api/cron/photo-gc/route.ts, lib/create-finalize.ts, services/duplicates.ts, services/photos.ts, C20 — photo-gc hard-deletes Attachment row even when R2 tagging fails, R2 [P2] Cross-region merge is a permanent dead-end — MergeForm never sends confirmCrossRegion/reason, R2 [P3] Merge leaves moved CR photo's Attachment.customerId pointing at the archived loser (+1 more)

### Community 10 - "SLA Working-Hours Calendar"
Cohesion: 0.47
Nodes (6): E4 Under-credited existing SLA/approval coverage, lib/working-hours.ts, R30 SLA Asia/Muscat working-minutes only, RK-8 SLA math wrong under UTC server + Oman calendar, SLA working-hours calendar, Owner decision: Sun-Thu workweek

### Community 11 - "Planning Documents"
Cohesion: 0.67
Nodes (4): OPUS 4.8 Master Production-Readiness & UAT Execution Plan, OPUS QA Production-Readiness Test & Validation Plan, NMWC Unified CRM Consolidation Project Description, NMWC Unified CRM Master Session Record

### Community 12 - "Cron Infrastructure"
Cohesion: 0.67
Nodes (3): app/api/cron/sla-escalate/route.ts, RK-12 GitHub Actions cron 60-day auto-disable, Owner decision: Vercel Pro for sub-daily cron

### Community 13 - "Synthetic Reset Guard"
Cohesion: 1.00
Nodes (3): E1 db:synthetic:reset unguarded TRUNCATE stop condition, prisma/synthetic.ts, C5 synthetic.ts --reset is an unguarded TRUNCATE CASCADE

### Community 14 - "Production DB Isolation"
Cohesion: 0.67
Nodes (3): Environment C (production), Production Neon endpoint ep-sweet-haze, scripts/qa/probe-db.ts

### Community 15 - "CR Uniqueness / Duplicate Block"
Cohesion: 1.00
Nodes (3): lib/create-guards.ts, C17 No DB backstop for CR uniqueness, Duplicate hard-block (CR + name/phone/region)

## Knowledge Gaps
- **76 isolated node(s):** `SALESMAN role`, `GM role`, `VIEWER role`, `lib/permissions.ts`, `lib/access.ts` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **24 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Pre-launch deep review (round 1)` connect `Ops, Auth & Deployment` to `Approval Queue & Atomic-Claim Lanes`, `Import / Promote & Schema`, `Access Control & Customer List`, `Temix ERP Sync`, `Secrets & Cron Reliability`, `Photos & Merge`?**
  _High betweenness centrality (0.154) - this node is a cross-community bridge._
- **Why does `Deep scan round 2` connect `Import / Promote & Schema` to `Photos & Merge`, `Ops, Auth & Deployment`, `Approval Queue & Atomic-Claim Lanes`, `Access Control & Customer List`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `Pre-launch deep review round 1 (25 confirmed)` connect `Region Scope & Adversarial Review` to `Approval Chain Engine`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Pre-launch deep review (round 1)` (e.g. with `F-C11 — Supervisor approves Manager-only reactivation via generic engine` and `Deep scan round 2`) actually correct?**
  _`Pre-launch deep review (round 1)` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `Deep scan round 2` (e.g. with `Pre-launch deep review (round 1)` and `Verdict — CONDITIONALLY READY / GO for a supervised pilot`) actually correct?**
  _`Deep scan round 2` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 5 inferred relationships involving `R1-#4/#8 [P2] Promote has no crash/timeout recovery — batch stranded in PROMOTING forever` (e.g. with `PROD-001 atomic claim invariant` and `Customer-master import promote`) actually correct?**
  _`R1-#4/#8 [P2] Promote has no crash/timeout recovery — batch stranded in PROMOTING forever` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `SALESMAN role`, `GM role`, `VIEWER role` to the rest of the system?**
  _82 weakly-connected nodes found - possible documentation gaps or missing edges._