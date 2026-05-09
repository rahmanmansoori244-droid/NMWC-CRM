-- Pre-launch hardening migration. All additive — no destructive operations.
-- Idempotent: safe to re-run if a previous attempt partially applied.
--
-- 1. AUTH-12 / AUTH-01 / AUTH-02: User.sessionsRevokedAt — JWT iat must be ≥ this
--    timestamp for the session to be considered fresh. Bumped on logout, disable,
--    role change, password reset.
-- 2. AUTH-09: User.mustChangePassword — forces /profile/change-password on next
--    login until cleared.
-- 3. EL-11/EL-12: Branch.lastStatusChangeAt — reactivation/closure evidence must
--    be captured after this timestamp.
-- 4. UXI-008: Attachment.deletedAt — real soft-delete column. The previous
--    "rename r2Key to __deleted__/..." sentinel is preserved for back-compat,
--    but every Attachment lookup now also filters on deletedAt IS NULL.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Branch"
  ADD COLUMN IF NOT EXISTS "lastStatusChangeAt" TIMESTAMP(3);

ALTER TABLE "Attachment"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Backfill: existing soft-deleted attachments (those whose r2Key starts with
-- the sentinel) get a non-null deletedAt so the new code path treats them
-- correctly without a separate cleanup job.
UPDATE "Attachment"
SET "deletedAt" = "createdAt"
WHERE "r2Key" LIKE '\_\_deleted\_\_/%' ESCAPE '\'
  AND "deletedAt" IS NULL;

-- The Attachment_hash_idx was added by an earlier migration on some envs.
-- Both indexes are created with IF NOT EXISTS so re-running the bundle is
-- always safe.
CREATE INDEX IF NOT EXISTS "Attachment_deletedAt_idx" ON "Attachment"("deletedAt");
CREATE INDEX IF NOT EXISTS "Attachment_hash_idx" ON "Attachment"("hash");
