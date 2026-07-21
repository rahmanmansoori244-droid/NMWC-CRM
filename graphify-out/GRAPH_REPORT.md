# Graph Report - .  (2026-07-21)

## Corpus Check
- 20 files · ~52,106 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 282 nodes · 425 edges · 49 communities (16 shown, 33 thin omitted)
- Extraction: 78% EXTRACTED · 22% INFERRED · 0% AMBIGUOUS · INFERRED: 92 edges (avg confidence: 0.88)
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
- [[_COMMUNITY_Cluster 40|Cluster 40]]
- [[_COMMUNITY_Cluster 41|Cluster 41]]
- [[_COMMUNITY_Cluster 42|Cluster 42]]
- [[_COMMUNITY_Cluster 43|Cluster 43]]
- [[_COMMUNITY_Cluster 44|Cluster 44]]
- [[_COMMUNITY_Cluster 45|Cluster 45]]
- [[_COMMUNITY_Cluster 46|Cluster 46]]
- [[_COMMUNITY_Cluster 47|Cluster 47]]
- [[_COMMUNITY_Cluster 48|Cluster 48]]

## God Nodes (most connected - your core abstractions)
1. `Final go-live bug hunt (third, definitive)` - 38 edges
2. `services/imports.ts` - 28 edges
3. `Pre-launch deep review (round 1)` - 25 edges
4. `Deep scan round 2` - 17 edges
5. `Final verdict — NO open P0/P1, GO for a supervised pilot` - 16 edges
6. `Final-hunt #0 — SR-USR-01 allowlist strands approver provisioning (net-new CREATE stalls)` - 14 edges
7. `services/edits.ts` - 12 edges
8. `CREDIT approval chain (SUP to FM to GM to ACC)` - 8 edges
9. `services/reactivations.ts` - 8 edges
10. `services/photos.ts` - 8 edges

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
- **Deep scan round 2 confirmed findings** — finding_supervisor_export_empty_scope, finding_branchcode_collision_promote, finding_crossregion_merge_deadend, finding_import_password_no_session_revoke, finding_account_import_unlink_supervisor, finding_promote_no_completeness_score, round_deep_scan_round2 [EXTRACTED 1.00]
- **CREDIT create approval chain (SUP→FM→GM→ACC)** — role_supervisor, role_finance_manager, role_gm, role_accountant, concept_credit_chain [EXTRACTED 1.00]
- **Go-live GO/NO-GO gate conditions** — gate_secret_rotation, gate_workweek_confirm, gate_cron_reliability, gate_preview_db, gate_temix_contract, gate_chunked_import, gate_migrate_deploy, verdict_conditionally_ready [INFERRED 0.85]
- **All 7 round-3 P1 go-live blockers** — finding_final_hunt_0, finding_final_hunt_1, finding_final_hunt_2, finding_final_hunt_3, finding_final_hunt_4, finding_final_hunt_5, finding_final_hunt_6 [EXTRACTED 1.00]
- **Re-import overwrite / CREDIT->CASH finding cluster** — finding_final_hunt_4, finding_final_hunt_5, finding_final_hunt_6, finding_final_hunt_9, finding_final_hunt_19 [INFERRED 0.85]
- **Credit-chain requirements R17/R19/R26** — req_r17, req_r19, req_r26 [EXTRACTED 1.00]

## Communities (49 total, 33 thin omitted)

### Community 0 - "Approval Chain Engine"
Cohesion: 0.11
Nodes (36): app/api/cron/photo-gc/route.ts, app/(app)/users/CreateUserForm.tsx, components/nmwc/CompletenessRing.tsx, lib/working-hours.ts, services/imports.ts, services/routes.ts, Final verdict — NO open P0/P1, GO for a supervised pilot, F-UAT-7 — multi-branch import self-quarantine (in-file phone/CR dup) (+28 more)

### Community 1 - "Approval Queue & Atomic-Claim Lanes"
Cohesion: 0.10
Nodes (34): app/(app)/approvals/page.tsx, app/api/cron/photo-gc/route.ts, app/(app)/reactivations/page.tsx, app/(app)/work/page.tsx, prisma/migrations/20260715120100_phase1_tables/migration.sql, services/edits.ts, services/photos.ts, services/reactivations.ts (+26 more)

### Community 2 - "Ops, Auth & Deployment"
Cohesion: 0.09
Nodes (29): app/(app)/customers/page.tsx, app/(app)/duplicates/MergeForm.tsx, app/(app)/import/[batchId]/page.tsx, lib/access.ts, lib/codes.ts, lib/completeness.ts, lib/customer-filters.ts, prisma/schema.prisma (+21 more)

### Community 3 - "Import / Promote & Schema"
Cohesion: 0.13
Nodes (27): lib/temix.ts, services/customers.ts, services/temix.ts, vercel.json, Legacy full-upsert lane, B-05 optimistic version lock, Temix refresh lane, Temix ERP sync (+19 more)

### Community 4 - "Temix Master Import & Risks"
Cohesion: 0.09
Nodes (26): lib/approval-chains.ts, lib/create-finalize.ts, R14 Chain frozen at submit, R16 Loop guard, R17 FM/GM cannot amend credit figures, R19 Final materialize only after final approval, R2 Cash chain SUP to ACC, R3 Credit chain SUP to FM to GM to ACC; GM always (+18 more)

### Community 5 - "Region Scope & Adversarial Review"
Cohesion: 0.13
Nodes (22): app/api/photos/[id]/route.ts, lib/notifications.ts, lib/permissions.ts, prisma/seed-muscat-pilot.ts, services/users.ts, CASH create approval chain, CREDIT create approval chain, Separation of duty (canActOnStep) (+14 more)

### Community 6 - "Access Control & Customer List"
Cohesion: 0.12
Nodes (18): app/api/health/route.ts, docs/OPERATIONS.md, docs/TECH-SPEC.md, .env.example, lib/auth.ts, lib/cron-auth.ts, package.json, D3 — Move SLA-escalation + backup off GitHub Actions (+10 more)

### Community 7 - "Temix ERP Sync"
Cohesion: 0.19
Nodes (14): E2 CREATE import defaults absent payment-terms to CASH, Import stage-then-promote, RK-10 Real Temix file anomalies not covered by synthetic, RK-3 Large master promote times out (stuck PROMOTING), RK-4 Temix inbound absent-column flips CREDIT to CASH, services/duplicates.ts, services/imports.ts, services/temix.ts (+6 more)

### Community 8 - "Secrets & Cron Reliability"
Cohesion: 0.29
Nodes (8): lib/create-finalize.ts, F-UAT-8 — code allocator self-heal (CodeSequence counter behind), Final-hunt #27 — NMWC code year from UTC not Oman wall-clock, Final-hunt #36 — NMWC code year derived from UTC runtime, R17 — approve action takes only editId (approvers cannot amend credit figures), R19 — CREATE materializes the Customer only at the final ACC step, R26 — concurrent final approvals yield exactly one materialization, credit-chain-e2e.test.ts

### Community 9 - "Photos & Merge"
Cohesion: 0.40
Nodes (6): app/api/cron/sla-escalate/route.ts, .github/workflows/sla-escalate.yml, SLA escalation engine, D1 — Workweek Sun-Thu (5-day), R1-#21 [P3] SLA sweep worst case exceeds 30s maxDuration — truncated sweeps + red cron runs, Gate — confirm the workweek (WORK_DAYS)

### Community 10 - "SLA Working-Hours Calendar"
Cohesion: 0.50
Nodes (5): E4 Under-credited existing SLA/approval coverage, lib/working-hours.ts, R30 SLA Asia/Muscat working-minutes only, RK-8 SLA math wrong under UTC server + Oman calendar, SLA working-hours calendar

### Community 11 - "Planning Documents"
Cohesion: 0.67
Nodes (3): OPUS 4.8 Master Production-Readiness & UAT Execution Plan, OPUS QA Production-Readiness Test & Validation Plan, NMWC Unified CRM Consolidation Project Description

### Community 12 - "Cron Infrastructure"
Cohesion: 1.00
Nodes (3): E1 db:synthetic:reset unguarded TRUNCATE stop condition, prisma/synthetic.ts, C5 synthetic.ts --reset is an unguarded TRUNCATE CASCADE

### Community 13 - "Synthetic Reset Guard"
Cohesion: 0.67
Nodes (3): Environment C (production), Production Neon endpoint ep-sweet-haze, scripts/qa/probe-db.ts

### Community 14 - "Production DB Isolation"
Cohesion: 0.67
Nodes (3): lib/access.ts, lib/customer-filters.ts, Fail-closed region/route scope

### Community 15 - "CR Uniqueness / Duplicate Block"
Cohesion: 1.00
Nodes (3): lib/create-guards.ts, C17 No DB backstop for CR uniqueness, Duplicate hard-block (CR + name/phone/region)

## Knowledge Gaps
- **95 isolated node(s):** `OPUS 4.8 Master Production-Readiness & UAT Execution Plan`, `lib/permissions.ts`, `lib/access.ts`, `lib/customer-filters.ts`, `lib/approval-chains.ts` (+90 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **33 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Pre-launch deep review (round 1)` connect `Import / Promote & Schema` to `Approval Queue & Atomic-Claim Lanes`, `Ops, Auth & Deployment`, `Region Scope & Adversarial Review`, `Access Control & Customer List`, `Photos & Merge`?**
  _High betweenness centrality (0.143) - this node is a cross-community bridge._
- **Why does `Final go-live bug hunt (third, definitive)` connect `Approval Chain Engine` to `Secrets & Cron Reliability`, `Approval Queue & Atomic-Claim Lanes`, `Ops, Auth & Deployment`, `Region Scope & Adversarial Review`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `services/imports.ts` connect `Approval Chain Engine` to `Approval Queue & Atomic-Claim Lanes`, `Ops, Auth & Deployment`, `Import / Promote & Schema`, `Region Scope & Adversarial Review`, `Access Control & Customer List`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Deep scan round 2` (e.g. with `Pre-launch deep review (round 1)` and `Verdict — CONDITIONALLY READY / GO for a supervised pilot`) actually correct?**
  _`Deep scan round 2` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `OPUS 4.8 Master Production-Readiness & UAT Execution Plan`, `lib/permissions.ts`, `lib/access.ts` to the rest of the system?**
  _102 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Approval Chain Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.11428571428571428 - nodes in this community are weakly interconnected._
- **Should `Approval Queue & Atomic-Claim Lanes` be split into smaller, more focused modules?**
  _Cohesion score 0.0962566844919786 - nodes in this community are weakly interconnected._