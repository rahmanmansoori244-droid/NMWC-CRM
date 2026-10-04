# Design: SLA / escalation, notifications  area

> 19 nodes · cohesion 0.18

## Key Concepts

- **Design: SLA / escalation, notifications and Temix batch sync** (18 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Temix batch-sync contract (stateful, idempotent, Steward-operated Excel loop)** (12 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **SLA escalation sweep: GitHub Actions cron calling GET /api/cron/sla-escalate** (9 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **notify() service: in-app rows plus post-commit best-effort email** (7 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Shared cron bearer check (timing-safe, extracted once)** (6 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **NEW-BUG-1: Postgres rate limiter never denies** (6 connections) — `docs/discovery/NMWC-CRM-Discovery-Report.md`
- **PROD-001 atomic claim (updateMany guarded on state SUBMITTED)** (5 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **Working-hours calendar (Asia/Muscat fixed UTC+4, closed-form deadline)** (4 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **SLA, notification and Temix rollout order (notification migration first)** (3 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **SLA columns on CustomerEdit (pendingRole, stageEnteredAt, slaDueAt, escalationLevel)** (3 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **STAGE_SLA_MINUTES per-stage SLA policy (env-overridable constants)** (3 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **TEMIX_OWNED_FIELDS field-ownership whitelist for inbound overwrites** (3 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Two-step Temix ack (Mark uploaded; creates sync only when the inbound code arrives)** (3 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **SLA and notification hook points (currentStepEnteredAt anchor)** (2 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **In-app bell and /notifications inbox** (2 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Email via Resend behind an EMAIL_ENABLED kill-switch** (2 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Escalation notifies, never reassigns or mutates workflow state** (2 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **Steward /temix page (pending counts, generate upload file, mark uploaded)** (2 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`
- **TEMIX_RELEVANT_FIELDS upload-trigger filter** (2 connections) — `docs/discovery/blueprint-inputs/sla-notif-sync.md`

## Relationships

- [[route area]] (4 shared connections)
- [[Design: multi-tier, payment-terms-condit area]] (3 shared connections)
- [[Unified CRM blueprints]] (3 shared connections)
- [[Phase 2 spec contract]] (3 shared connections)
- [[NMWC CRM: discovery and understanding re area]] (3 shared connections)
- [[NMWC Unified CRM: target operating model area]] (2 shared connections)
- [[Customer list, filters and export]] (2 shared connections)
- [[working-hours area]] (2 shared connections)
- [[Edit submit and approval engine]] (1 shared connections)
- [[New-customer creation and phones]] (1 shared connections)
- [[service-levels area]] (1 shared connections)
- [[excel area]] (1 shared connections)

## Source Files

- `docs/discovery/NMWC-CRM-Discovery-Report.md`
- `docs/discovery/blueprint-inputs/approval-engine.md`
- `docs/discovery/blueprint-inputs/sla-notif-sync.md`

## Audit Trail

- EXTRACTED: 86 (91%)
- INFERRED: 8 (9%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*