-- P1.3 (2026-05-10): drop the partial-unique index on Customer.primaryPhoneNorm.
--
-- Why: NMWC's real-world data has many customers (= shops) sharing one
-- primary phone — typically because one owner runs several shops. The unique
-- index was rejecting legitimate field submissions and blocking the
-- customer-master flatten migration. The owner has explicitly approved
-- allowing phone duplicates everywhere.
--
-- The crNumberNorm partial-unique index is NOT touched — CR numbers do
-- need to be unique per legal entity.
--
-- Reversibility: re-create with `CREATE UNIQUE INDEX ... WHERE deletedAt
-- IS NULL` if the rule changes back.

DROP INDEX IF EXISTS "Customer_primaryPhoneNorm_active_unique";

-- Keep a non-unique B-tree on primaryPhoneNorm for filter/search performance.
-- Idempotent — already exists in some environments via the senior-audit
-- pg_trgm work, but a plain btree is also useful for exact lookups.
CREATE INDEX IF NOT EXISTS "Customer_primaryPhoneNorm_idx"
  ON "Customer" ("primaryPhoneNorm")
  WHERE "primaryPhoneNorm" IS NOT NULL;
