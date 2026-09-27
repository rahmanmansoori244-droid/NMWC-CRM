-- Benchmark item 9 (owner go-ahead 2026-09-27): service levels, measured over a
-- window instead of only "right now".
--
--   CronRun        one row per scheduled run (keep-warm, the SLA sweep, photo GC,
--                  the retention sweep, the nightly backup). CronHeartbeat keeps
--                  only each job's LAST run, which cannot answer "what share of
--                  the last 30 days was the app up?". No error text and no run
--                  detail: those can quote a customer's phone. Pruned after 90
--                  days by the retention sweep, which is why nmwc_app needs
--                  DELETE on it (scripts/ops/app-role.ts DELETABLE).
--   EditApproval   the stage as it stood when each decision was made — when it
--    .stageEnteredAt  was entered, when it was due, and how many working minutes
--    .slaDueAt        it took. The change request keeps SLA state for its current
--    .workingMinutes  stage only and overwrites it on every advance, so "was this
--                   stage decided inside its SLA" could not be answered afterwards.
--                   Rows written before this migration stay null (the table is
--                   append-only; nothing is backfilled) and count as untracked.
--   EditApproval_at_idx  the report reads a 30-day window of decisions; without
--                   it that is a sequential scan of a table that only grows.
--
-- Additive and safe to apply before the build that uses it: a new table, three
-- nullable columns the old build never reads, and an index. ADD COLUMN without a
-- default does not rewrite rows, so EditApproval's append-only trigger is not
-- involved. The index build briefly blocks writes to EditApproval, which holds
-- one row per approval decision.

-- AlterTable
ALTER TABLE "EditApproval" ADD COLUMN     "slaDueAt" TIMESTAMP(3),
ADD COLUMN     "stageEnteredAt" TIMESTAMP(3),
ADD COLUMN     "workingMinutes" INTEGER;

-- CreateTable
CREATE TABLE "CronRun" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "dbMs" INTEGER,
    "source" TEXT,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CronRun_key_at_idx" ON "CronRun"("key", "at");

-- CreateIndex
CREATE INDEX "EditApproval_at_idx" ON "EditApproval"("at" DESC);
