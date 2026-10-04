-- F1 (2026-10-05): the Notification table becomes the e-mail outbox.
--
-- Every Notification row is written inside the transaction of the state change
-- that caused it (lib/notifications.ts), so a committed row is exactly a change
-- that happened. The e-mail drain (app/api/cron/email-drain, lib/email/drain.ts)
-- reads committed rows only and never runs inside a request or a transaction.
-- `emailedAt` and the (emailedAt, createdAt) index were built for this in Phase 1
-- and never used; three columns complete it:
--
--   emailStatus      how the outbox finished with the row: SENT, FAILED or a
--                    SKIPPED_* reason (lib/email/drain.ts EmailStatus). NULL while
--                    it is still waiting. Text, not an enum: a new reason must not
--                    need its own migration.
--   emailAttempts    claims so far. A row that reaches the cap without a send
--                    becomes FAILED.
--   emailLeaseUntil  the drain's claim. A run that dies mid-send leaves the lease
--                    to expire (5 minutes, longer than the 60 s function limit),
--                    so two overlapping runs never send the same row.
--
-- emailedAt now means "the outbox is done with this row", whatever the status.
--
-- THE BACKFILL IS THE POINT. Nothing ever wrote emailedAt, so every existing row
-- has it NULL, and a drain switched on later would e-mail up to 180 days of
-- history, GM and Steward rows included. Every row that exists when this runs is
-- marked PRE_FEATURE and done (emailedAt = createdAt): no historical row is ever
-- e-mailed. Rows the OLD build writes after this migration and before the new
-- build is live are new and carry NULL; the drain's 24-hour maximum age and its
-- recipient and kind allowlists apply to them like any other row, and the drain
-- sends nothing until NOTIFY_EMAIL_ENABLED is 'on'.
--
-- Additive and safe to apply before the build that uses it:
--   - two nullable columns and one with a constant default: catalogue-only in
--     PostgreSQL 11+, no table rewrite;
--   - no constraint, trigger or index (the existing (emailedAt, createdAt) index
--     serves the drain's "emailedAt IS NULL AND createdAt >= cutoff");
--   - the running build's Prisma client names its columns, so it never reads the
--     new ones, and its inserts get NULL / 0;
--   - the UPDATE touches Notification only, which has no trigger, and takes row
--     locks for its duration: a mark-read running at the same moment waits for it.
-- Grants are table-level (scripts/ops/app-role.ts): the runtime role can already
-- read and write the new columns.
ALTER TABLE "Notification" ADD COLUMN "emailStatus" TEXT,
ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emailLeaseUntil" TIMESTAMP(3);

UPDATE "Notification"
SET "emailStatus" = 'PRE_FEATURE', "emailedAt" = "createdAt"
WHERE "emailedAt" IS NULL;
