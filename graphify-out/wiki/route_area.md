# route area

> 21 nodes · cohesion 0.19

## Key Concepts

- **route.ts** (19 connections) — `app/api/health/route.ts`
- **cronAuthorized()** (13 connections) — `lib/cron-auth.ts`
- **cron-auth.ts** (11 connections) — `lib/cron-auth.ts`
- **health-verdict.test.ts** (11 connections) — `tests/unit/health-verdict.test.ts`
- **health.ts** (9 connections) — `lib/health.ts`
- **GET()** (8 connections) — `app/api/health/route.ts`
- **bearerMatches()** (6 connections) — `lib/cron-auth.ts`
- **#15 P2 CRON_SECRET, HEALTH_BEARER, DEMO_ACCOUNTS_DISABLED missing from .env.example** (5 connections) — `qa/findings/pre-launch-deep-review.md`
- **loadHeartbeatReport()** (5 connections) — `lib/heartbeat.ts`
- **evaluateHealth()** (4 connections) — `lib/health.ts`
- **isProductionDeployment()** (4 connections) — `lib/health.ts`
- **r2Configured()** (4 connections) — `lib/health.ts`
- **cron-auth.test.ts** (4 connections) — `tests/unit/cron-auth.test.ts`
- **CheckState** (3 connections) — `lib/health.ts`
- **dbOk()** (2 connections) — `app/api/health/route.ts`
- **HealthStatus** (1 connections) — `lib/health.ts`
- **HealthVerdict** (1 connections) — `lib/health.ts`
- **JobVerdictInput** (1 connections) — `lib/health.ts`
- **SECRET** (1 connections) — `tests/unit/cron-auth.test.ts`
- **allOk** (1 connections) — `tests/unit/health-verdict.test.ts`
- **job()** (1 connections) — `tests/unit/health-verdict.test.ts`

## Relationships

- [[Cron heartbeats]] (10 shared connections)
- [[route area]] (8 shared connections)
- [[logger area]] (5 shared connections)
- [[Customer list, filters and export]] (4 shared connections)
- [[Pre-launch review (July)]] (2 shared connections)
- [[Design: SLA / escalation, notifications  area]] (2 shared connections)
- [[service-status area]] (2 shared connections)
- [[Auth and page scope loading]] (1 shared connections)
- [[NMWC go-live import templates README area]] (1 shared connections)
- [[Photo upload and R2]] (1 shared connections)

## Source Files

- `app/api/health/route.ts`
- `lib/cron-auth.ts`
- `lib/health.ts`
- `lib/heartbeat.ts`
- `qa/findings/pre-launch-deep-review.md`
- `tests/unit/cron-auth.test.ts`
- `tests/unit/health-verdict.test.ts`

## Audit Trail

- EXTRACTED: 113 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*