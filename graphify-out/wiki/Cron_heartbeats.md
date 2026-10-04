# Cron heartbeats

> 32 nodes · cohesion 0.09

## Key Concepts

- **heartbeat.ts** (37 connections) — `lib/heartbeat.ts`
- **route.ts** (10 connections) — `app/api/ops/backup-report/route.ts`
- **recordHeartbeat()** (8 connections) — `lib/heartbeat.ts`
- **B5 Sub-daily scheduling and CronHeartbeat dead-man alarm** (8 connections) — `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- **heartbeat.test.ts** (8 connections) — `tests/unit/heartbeat.test.ts`
- **withHeartbeat()** (7 connections) — `lib/heartbeat.ts`
- **D3 Cron infrastructure: Vercel Pro (Hobby is daily-only) vs GitHub Actions reminder** (6 connections) — `qa/reports/OWNER-DECISIONS.md`
- **POST()** (5 connections) — `app/api/ops/backup-report/route.ts`
- **heartbeatReport** (5 connections) — `lib/heartbeat.ts`
- **classifyRunSource()** (4 connections) — `lib/heartbeat.ts`
- **HEARTBEAT_EXPECTATIONS** (4 connections) — `lib/heartbeat.ts`
- **Cron reliability: GitHub Actions schedules vs Vercel Crons** (4 connections) — `qa/reports/LAUNCH-CHECKLIST.md`
- **record()** (4 connections) — `tests/unit/alert.test.ts`
- **GitHub Actions schedules auto-disable after 60 days of inactivity** (3 connections) — `qa/findings/pre-launch-deep-review.md`
- **alertJobFailed()** (3 connections) — `lib/heartbeat.ts`
- **clean()** (2 connections) — `app/api/ops/backup-report/route.ts`
- **allowedAgeMinutes()** (2 connections) — `lib/heartbeat.ts`
- **HeartbeatKey** (2 connections) — `lib/heartbeat.ts`
- **inWindow()** (2 connections) — `lib/heartbeat.ts`
- **toInt4()** (2 connections) — `lib/heartbeat.ts`
- **acceptingFetch()** (2 connections) — `tests/unit/alert.test.ts`
- **state()** (2 connections) — `tests/unit/heartbeat.test.ts`
- **GET()** (1 connections) — `app/api/ops/backup-report/route.ts`
- **HeartbeatExpectation** (1 connections) — `lib/heartbeat.ts`
- **HeartbeatRow** (1 connections) — `lib/heartbeat.ts`
- *... and 7 more nodes in this community*

## Relationships

- [[route area]] (14 shared connections)
- [[alert area]] (7 shared connections)
- [[logger area]] (6 shared connections)
- [[Enterprise readiness assessment]] (4 shared connections)
- [[cron-run-history.test area]] (4 shared connections)
- [[Pre-launch review (July)]] (3 shared connections)
- [[Customer list, filters and export]] (3 shared connections)
- [[service-status area]] (2 shared connections)
- [[Cron scheduler (cron-job.org)]] (2 shared connections)
- [[Sentry PII scrubbing]] (1 shared connections)
- [[vercel.json area]] (1 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (1 shared connections)

## Source Files

- `app/api/ops/backup-report/route.ts`
- `lib/heartbeat.ts`
- `qa/findings/pre-launch-deep-review.md`
- `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- `qa/reports/LAUNCH-CHECKLIST.md`
- `qa/reports/OWNER-DECISIONS.md`
- `tests/unit/alert.test.ts`
- `tests/unit/heartbeat.test.ts`

## Audit Trail

- EXTRACTED: 132 (94%)
- INFERRED: 8 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*