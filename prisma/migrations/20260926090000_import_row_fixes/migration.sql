-- Benchmark item 20 (owner decision 2026-09-25): the Data Steward can fix a
-- held-back or rejected import row inside the app, and can record that a row
-- stays out on purpose.
--
--   corrections     the cells the Steward corrected, as { cells: { column: value } }
--                   plus { phoneReleased } when a shared phone was let through.
--                   "raw" stays exactly as uploaded: it is the evidence of what
--                   the sheet said, and the check re-runs over raw + corrections.
--   excludedAt/By   "accepted as excluded". A column, not a marker inside
--   excludedReason  "issues": the retention sweep clears "issues" after 90 days,
--                   and an exclusion must outlive that or the batch would come
--                   back to the Steward's Work list.
--
-- Additive and safe to apply before the build that uses it: every column is
-- nullable, the old build never reads them, and no existing row changes.
ALTER TABLE "ImportRow" ADD COLUMN "corrections" JSONB;
ALTER TABLE "ImportRow" ADD COLUMN "excludedAt" TIMESTAMP(3);
ALTER TABLE "ImportRow" ADD COLUMN "excludedById" TEXT;
ALTER TABLE "ImportRow" ADD COLUMN "excludedReason" TEXT;

ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_excludedById_fkey"
  FOREIGN KEY ("excludedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
