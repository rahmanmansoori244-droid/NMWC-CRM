# alert area

> 25 nodes · cohesion 0.12

## Key Concepts

- **alert.ts** (22 connections) — `lib/alert.ts`
- **alert.test.ts** (16 connections) — `tests/unit/alert.test.ts`
- **sendAlert()** (14 connections) — `lib/alert.ts`
- **scrubAndTruncate()** (8 connections) — `lib/scrub.ts`
- **WirePayload** (6 connections) — `lib/alert.ts`
- **import-rejection-alert.ts** (6 connections) — `lib/import-rejection-alert.ts`
- **importRejectionAlert()** (5 connections) — `lib/import-rejection-alert.ts`
- **validScope()** (3 connections) — `lib/alert.ts`
- **validSeverity()** (3 connections) — `lib/alert.ts`
- **isSelfMintedId()** (3 connections) — `lib/scrub.ts`
- **AlertInput** (2 connections) — `lib/alert.ts`
- **alertWindow()** (2 connections) — `lib/alert.ts`
- **failureLabel()** (2 connections) — `lib/alert.ts`
- **ALERT_LIMIT** (1 connections) — `lib/alert.ts`
- **AlertEvent** (1 connections) — `lib/alert.ts`
- **AlertSeverity** (1 connections) — `lib/alert.ts`
- **RowStateCount** (1 connections) — `lib/import-rejection-alert.ts`
- **BASE** (1 connections) — `tests/unit/alert.test.ts`
- **Call** (1 connections) — `tests/unit/alert.test.ts`
- **Counts** (1 connections) — `tests/unit/alert.test.ts`
- **PG_STATEMENT** (1 connections) — `tests/unit/alert.test.ts`
- **PgRow** (1 connections) — `tests/unit/alert.test.ts`
- **sentBody()** (1 connections) — `tests/unit/alert.test.ts`
- **simulatedPgLimiter()** (1 connections) — `tests/unit/alert.test.ts`
- **wireText()** (1 connections) — `tests/unit/alert.test.ts`

## Relationships

- [[Cron heartbeats]] (7 shared connections)
- [[Account master import]] (6 shared connections)
- [[logger area]] (4 shared connections)
- [[Sentry PII scrubbing]] (4 shared connections)
- [[route area]] (3 shared connections)
- [[rate-limit area]] (3 shared connections)
- [[Import row fixing and promote]] (2 shared connections)
- [[Enrichment form and patch v2]] (1 shared connections)

## Source Files

- `lib/alert.ts`
- `lib/import-rejection-alert.ts`
- `lib/scrub.ts`
- `tests/unit/alert.test.ts`

## Audit Trail

- EXTRACTED: 101 (97%)
- INFERRED: 3 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*