# rate-limit area

> 16 nodes · cohesion 0.18

## Key Concepts

- **rate-limit.ts** (31 connections) — `lib/rate-limit.ts`
- **checkLimit()** (22 connections) — `lib/rate-limit.ts`
- **rate-limit.test.ts** (7 connections) — `tests/unit/rate-limit.test.ts`
- **refundLimit()** (6 connections) — `lib/rate-limit.ts`
- **checkLimitMemory()** (3 connections) — `lib/rate-limit.ts`
- **FORM_LIMIT** (3 connections) — `lib/rate-limit.ts`
- **checkLimitPg()** (2 connections) — `lib/rate-limit.ts`
- **PHOTO_LIMIT** (2 connections) — `lib/rate-limit.ts`
- **refundLimitMemory()** (2 connections) — `lib/rate-limit.ts`
- **refundLimitPg()** (2 connections) — `lib/rate-limit.ts`
- **tokensLeft()** (2 connections) — `tests/unit/login-throttle.test.ts`
- **grantsNow()** (2 connections) — `tests/unit/rate-limit.test.ts`
- **Bucket** (1 connections) — `lib/rate-limit.ts`
- **memBuckets** (1 connections) — `lib/rate-limit.ts`
- **RateLimitConfig** (1 connections) — `lib/rate-limit.ts`
- **h** (1 connections) — `tests/unit/rate-limit.test.ts`

## Relationships

- [[Login and sign-in throttling]] (7 shared connections)
- [[Photo upload and R2]] (4 shared connections)
- [[logger area]] (4 shared connections)
- [[New-customer creation and phones]] (4 shared connections)
- [[Edit submit and approval engine]] (4 shared connections)
- [[route area]] (3 shared connections)
- [[alert area]] (3 shared connections)
- [[Auth and page scope loading]] (3 shared connections)
- [[Account master import]] (3 shared connections)
- [[temix area]] (3 shared connections)
- [[Enterprise readiness assessment]] (2 shared connections)
- [[Customer list, filters and export]] (1 shared connections)

## Source Files

- `lib/rate-limit.ts`
- `tests/unit/login-throttle.test.ts`
- `tests/unit/rate-limit.test.ts`

## Audit Trail

- EXTRACTED: 88 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*