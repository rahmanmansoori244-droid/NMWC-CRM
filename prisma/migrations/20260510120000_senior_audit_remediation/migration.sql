-- Senior-audit remediation migration. All additive — no destructive operations.
-- Idempotent: safe to re-run if a previous attempt partially applied.
--
-- Bugs addressed:
--   B-05  HIGH    optimistic locking on Customer + Branch (`version` column)
--   B-10  MEDIUM  pg_trgm GIN indexes for fuzzy search; B-tree on crNumberNorm;
--                 composite index for the route/day branch list
--   B-15  MEDIUM  PasswordHistory table (reuse-prevention scaffolding)
--   B-18  LOW     loose string statuses → typed enums on ImportBatch / ExportJob
--   B-19  LOW     Postgres trigger enforcing Branch.regionId = Route.regionId
--   B-20  LOW     CHECK constraints on GPS lat/lng + Branch.address minlength
--   B-03/B-04     new AuditAction enum values for granular auth + delete +
--                 photo-view actions (other agent's runtime task uses these)

-- ─────────────────────────────────────────────────────────────────────────────
-- B-05: optimistic locking columns. Default 0 so existing rows have a baseline
-- the service layer can compare against on first UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Branch"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- B-03 / B-04: extend AuditAction enum. New values are appended; legacy values
-- keep their original ordinals so existing rows are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOGIN_FAIL';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REVOKE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DELETE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SOFT_DELETE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PHOTO_VIEW';

-- ─────────────────────────────────────────────────────────────────────────────
-- B-15: PasswordHistory. Used by the new change-password flow to reject any
-- hash matching the user's most-recent N entries. ON DELETE CASCADE keeps
-- history bound to the User lifecycle (e.g. eventual hard-delete).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PasswordHistory" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "hash"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PasswordHistory_userId_fkey'
  ) THEN
    ALTER TABLE "PasswordHistory"
      ADD CONSTRAINT "PasswordHistory_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PasswordHistory_userId_createdAt_idx"
  ON "PasswordHistory"("userId", "createdAt" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- B-18: loose status strings → typed enums. Existing values are uppercase
-- already (PARSING / READY / PROMOTED / FAILED for ImportBatch; PENDING /
-- RUNNING / DONE / FAILED for ExportJob), so the cast is clean.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImportBatchStatus') THEN
    CREATE TYPE "ImportBatchStatus" AS ENUM ('PARSING', 'READY', 'PROMOTING', 'PROMOTED', 'FAILED');
  END IF;
END $$;

-- services/imports.ts uses 'PROMOTING' as an in-flight intermediate state.
-- This ALTER runs idempotently in case an older copy of the enum exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ImportBatchStatus' AND e.enumlabel = 'PROMOTING'
  ) THEN
    ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'PROMOTING' BEFORE 'PROMOTED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExportJobStatus') THEN
    CREATE TYPE "ExportJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'ImportBatch'
      AND column_name = 'status'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE "ImportBatch"
      ALTER COLUMN "status" TYPE "ImportBatchStatus"
      USING "status"::"ImportBatchStatus";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'ExportJob'
      AND column_name = 'status'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE "ExportJob"
      ALTER COLUMN "status" TYPE "ExportJobStatus"
      USING "status"::"ExportJobStatus";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- B-10: search performance. pg_trgm enables fuzzy LIKE/ILIKE on legalName,
-- nmwcCode, primaryPhoneNorm via GIN. crNumberNorm gets a B-tree because
-- lookups there are exact, not fuzzy. Branch composite covers the route +
-- day-of-visit list query that filters out soft-deleted rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Customer_legalName_trgm_idx"
  ON "Customer" USING GIN ("legalName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_nmwcCode_trgm_idx"
  ON "Customer" USING GIN ("nmwcCode" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_primaryPhoneNorm_trgm_idx"
  ON "Customer" USING GIN ("primaryPhoneNorm" gin_trgm_ops)
  WHERE "primaryPhoneNorm" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Customer_crNumberNorm_idx"
  ON "Customer" ("crNumberNorm")
  WHERE "crNumberNorm" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Branch_routeId_dayOfVisit_deletedAt_idx"
  ON "Branch" ("routeId", "dayOfVisit", "deletedAt");

-- ─────────────────────────────────────────────────────────────────────────────
-- B-19: Branch.regionId must equal Route.regionId. Application code can
-- forget; the trigger makes it a DB invariant for both INSERT and UPDATE
-- of either column.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_branch_region_consistency()
RETURNS TRIGGER AS $$
DECLARE
  expected_region_id TEXT;
BEGIN
  SELECT "regionId" INTO expected_region_id FROM "Route" WHERE id = NEW."routeId";
  IF expected_region_id IS NULL THEN
    RAISE EXCEPTION 'B-19: routeId % does not exist', NEW."routeId";
  END IF;
  IF NEW."regionId" <> expected_region_id THEN
    RAISE EXCEPTION 'B-19: Branch.regionId (%) must match Route.regionId (%)', NEW."regionId", expected_region_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS branch_region_consistency_check ON "Branch";
CREATE TRIGGER branch_region_consistency_check
  BEFORE INSERT OR UPDATE OF "regionId", "routeId" ON "Branch"
  FOR EACH ROW EXECUTE FUNCTION enforce_branch_region_consistency();

-- ─────────────────────────────────────────────────────────────────────────────
-- B-20: GPS range + address minlength CHECK constraints. Wrapped in DO blocks
-- so the migration is idempotent (CHECK constraints lack IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Branch_gpsLat_range') THEN
    ALTER TABLE "Branch"
      ADD CONSTRAINT "Branch_gpsLat_range"
      CHECK ("gpsLat" IS NULL OR ("gpsLat" >= -90 AND "gpsLat" <= 90));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Branch_gpsLng_range') THEN
    ALTER TABLE "Branch"
      ADD CONSTRAINT "Branch_gpsLng_range"
      CHECK ("gpsLng" IS NULL OR ("gpsLng" >= -180 AND "gpsLng" <= 180));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Attachment_capturedLat_range') THEN
    ALTER TABLE "Attachment"
      ADD CONSTRAINT "Attachment_capturedLat_range"
      CHECK ("capturedLat" IS NULL OR ("capturedLat" >= -90 AND "capturedLat" <= 90));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Attachment_capturedLng_range') THEN
    ALTER TABLE "Attachment"
      ADD CONSTRAINT "Attachment_capturedLng_range"
      CHECK ("capturedLng" IS NULL OR ("capturedLng" >= -180 AND "capturedLng" <= 180));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Branch_address_minlength') THEN
    ALTER TABLE "Branch"
      ADD CONSTRAINT "Branch_address_minlength"
      CHECK (length(btrim("address")) >= 3);
  END IF;
END $$;
