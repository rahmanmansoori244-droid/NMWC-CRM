-- Code review 2026-11-10, finding 28 (second round): the notice that rows were
-- loaded with their shop NOT changed stays on the batch page until the Data
-- Steward acknowledges it.
--
-- "shopNotChangedRows" counts the rows a promote of the batch loaded with their
-- shop left as it was; each customer's transaction adds its own rows, so the
-- count is exactly what committed. "shopNotChangedAckRows" is how many of them
-- the Steward has acknowledged, "shopNotChangedAckAt" and "shopNotChangedAckById"
-- when and who. Each acknowledgement is also an AuditLog UPDATE row on the batch.
--
-- Additive: two integer columns with constant defaults (metadata-only on
-- PostgreSQL 11+), two nullable columns, and a foreign key on a column that is
-- NULL in every existing row.
ALTER TABLE "ImportBatch" ADD COLUMN     "shopNotChangedAckAt" TIMESTAMP(3),
ADD COLUMN     "shopNotChangedAckById" TEXT,
ADD COLUMN     "shopNotChangedAckRows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shopNotChangedRows" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_shopNotChangedAckById_fkey" FOREIGN KEY ("shopNotChangedAckById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
