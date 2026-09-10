-- RK-3: chunked, resumable customer-master promote.
--
-- A real customer master (~3,300 rows) needs roughly a thousand per-customer
-- transactions; over a networked Postgres that is minutes of work, far past the
-- 60s serverless function limit (vercel.json maxDuration). Promote therefore runs
-- in time-boxed slices and the batch is resumed until no CLEAN rows remain.
--
-- The lease is the concurrency token that makes resume safe: claiming a batch is
-- a single compare-and-set UPDATE, so only one worker holds it at a time, and the
-- lease EXPIRES (deliberately longer than the function limit) so a worker killed
-- mid-slice never strands the batch in PROMOTING forever.
--
-- Additive and nullable: existing batches read as "no lease held".
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "promoteLeaseBy" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "promoteLeaseUntil" TIMESTAMP(3);

-- The claim/resume filter is (status, promoteLeaseUntil).
CREATE INDEX IF NOT EXISTS "ImportBatch_status_promoteLeaseUntil_idx"
  ON "ImportBatch"("status", "promoteLeaseUntil");
