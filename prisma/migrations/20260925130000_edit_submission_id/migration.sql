-- Benchmark item 22 (owner decision 2026-09-25): a salesman who loses signal at
-- Submit must be able to tell whether it arrived. The phone now sends a
-- submission id with every field submit (customer update, new customer, close /
-- reactivate), stored here. A retry carrying an id this submitter already sent
-- is answered with a receipt for that request and writes nothing
-- (lib/submission-replay.ts) - so a lost reply is never a second request, a
-- second audit row or a second notification.
--
-- Additive and safe to apply before the build that uses it: nullable, so every
-- existing row, and every writer that does not send one (imports, approvals,
-- merges), is untouched; the old build never reads the column. Postgres treats
-- NULLs as distinct, so the unique index constrains only rows that carry an id.
ALTER TABLE "CustomerEdit" ADD COLUMN "submissionId" TEXT;

CREATE UNIQUE INDEX "CustomerEdit_submittedById_submissionId_key"
  ON "CustomerEdit"("submittedById", "submissionId");
