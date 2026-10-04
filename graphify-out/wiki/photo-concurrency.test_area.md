# photo-concurrency.test area

> 8 nodes · cohesion 0.25

## Key Concepts

- **photo-concurrency.test.ts** (10 connections) — `tests/integration/photo-concurrency.test.ts`
- **assertNoClaimedPhotoWired()** (1 connections) — `tests/integration/photo-concurrency.test.ts`
- **assertNoSlotOnADeletedPhoto()** (1 connections) — `tests/integration/photo-concurrency.test.ts`
- **gate** (1 connections) — `tests/integration/photo-concurrency.test.ts`
- **holdInGap()** (1 connections) — `tests/integration/photo-concurrency.test.ts`
- **MockUser** (1 connections) — `tests/integration/photo-concurrency.test.ts`
- **photo()** (1 connections) — `tests/integration/photo-concurrency.test.ts`
- **snapshot()** (1 connections) — `tests/integration/photo-concurrency.test.ts`

## Relationships

- [[Audit immutability tests]] (2 shared connections)
- [[purgeAuditLog area]] (1 shared connections)

## Source Files

- `tests/integration/photo-concurrency.test.ts`

## Audit Trail

- EXTRACTED: 17 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*