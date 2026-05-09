-- QA-015: Postgres-backed rate limiter
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastRefill" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- QA-017: only one SUBMITTED edit per customer at a time. Partial unique
-- index makes this a DB invariant, not a race-prone application check.
CREATE UNIQUE INDEX "CustomerEdit_open_per_customer"
  ON "CustomerEdit"("customerId")
  WHERE "state" = 'SUBMITTED' AND "customerId" IS NOT NULL;

-- QA-030: partial unique index on Customer.primaryPhoneNorm for non-deleted rows.
-- Enforces the "phone unique across active customers" claim from the PRD.
CREATE UNIQUE INDEX "Customer_primaryPhoneNorm_active_unique"
  ON "Customer"("primaryPhoneNorm")
  WHERE "primaryPhoneNorm" IS NOT NULL AND "deletedAt" IS NULL;

-- QA-032: index on Attachment.hash used by the photo dedupe path.
CREATE INDEX "Attachment_hash_idx" ON "Attachment"("hash");

-- QA-028: index on Customer.deletedAt used by every list query that
-- filters out soft-deleted rows.
CREATE INDEX "Customer_deletedAt_idx" ON "Customer"("deletedAt");
