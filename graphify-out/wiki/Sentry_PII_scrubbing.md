# Sentry PII scrubbing

> 66 nodes · cohesion 0.06

## Key Concepts

- **sentry-scrub.ts** (29 connections) — `lib/sentry-scrub.ts`
- **scrub.ts** (18 connections) — `lib/scrub.ts`
- **scrubEvent()** (18 connections) — `lib/sentry-scrub.ts`
- **sentry-scrub.test.ts** (15 connections) — `tests/unit/sentry-scrub.test.ts`
- **scrubText()** (13 connections) — `lib/sentry-scrub.ts`
- **sentry-envelope.test.ts** (12 connections) — `tests/unit/sentry-envelope.test.ts`
- **sentry.server.config.ts** (11 connections) — `sentry.server.config.ts`
- **sentry-envelope-browser.test.ts** (10 connections) — `tests/unit/sentry-envelope-browser.test.ts`
- **scrubString()** (9 connections) — `lib/scrub.ts`
- **scrubSpan()** (9 connections) — `lib/sentry-scrub.ts`
- **r2-trace-signing.test.ts** (9 connections) — `tests/unit/r2-trace-signing.test.ts`
- **instrumentation-client.ts** (8 connections) — `instrumentation-client.ts`
- **scrubBreadcrumb()** (7 connections) — `lib/sentry-scrub.ts`
- **sentry.edge.config.ts** (7 connections) — `sentry.edge.config.ts`
- **sentry-env.ts** (6 connections) — `lib/sentry-env.ts`
- **scrubUrl()** (6 connections) — `lib/sentry-scrub.ts`
- **isErrorDigest()** (5 connections) — `lib/scrub.ts`
- **sentryEnvironment()** (5 connections) — `lib/sentry-env.ts`
- **sentryRelease()** (5 connections) — `lib/sentry-env.ts`
- **redactWebhook()** (5 connections) — `lib/sentry-scrub.ts`
- **scrubDeep()** (5 connections) — `lib/sentry-scrub.ts`
- **sentry-env.test.ts** (5 connections) — `tests/unit/sentry-env.test.ts`
- **register()** (4 connections) — `instrumentation.ts`
- **scrub** (4 connections) — `lib/sentry-scrub.ts`
- **tagDigest()** (4 connections) — `lib/sentry-scrub.ts`
- *... and 41 more nodes in this community*

## Relationships

- [[logger area]] (5 shared connections)
- [[alert area]] (4 shared connections)
- [[Cross-domain and RBAC audits]] (3 shared connections)
- [[submit-body-bounds.test area]] (3 shared connections)
- [[Data residency and processor register (d area]] (2 shared connections)
- [[Oman PDPL applicability questions and fa area]] (2 shared connections)
- [[Phase 2 design notes]] (2 shared connections)
- [[New-customer creation and phones]] (2 shared connections)
- [[Enterprise readiness assessment]] (1 shared connections)
- [[Customer list, filters and export]] (1 shared connections)
- [[Account master import]] (1 shared connections)
- [[Cron heartbeats]] (1 shared connections)

## Source Files

- `docs/compliance/DATA-RESIDENCY-REGISTER.md`
- `instrumentation-client.ts`
- `instrumentation.ts`
- `lib/logger.ts`
- `lib/scrub.ts`
- `lib/sentry-env.ts`
- `lib/sentry-scrub.ts`
- `lib/sentry-server-integrations.ts`
- `sentry.edge.config.ts`
- `sentry.server.config.ts`
- `tests/unit/r2-trace-signing.test.ts`
- `tests/unit/sentry-env.test.ts`
- `tests/unit/sentry-envelope-browser.test.ts`
- `tests/unit/sentry-envelope.test.ts`
- `tests/unit/sentry-scrub.test.ts`

## Audit Trail

- EXTRACTED: 292 (97%)
- INFERRED: 8 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*