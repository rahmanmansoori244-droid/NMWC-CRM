-- Gap 28 (data audit 2026-10-10): the history can be PROVEN untouched.
--
-- The ledgers were protected against accidents (the append-only triggers), but
-- nothing sealed them: a row changed or removed in the owner's maintenance
-- window, or with a trigger switched off, left no trace. From this migration a
-- nightly job (app/api/cron/integrity-watch, lib/seal/*) writes a seal: per
-- sealed table, the key range since the last seal, the row count and a SHA-256
-- digest of every row in it, chained to the previous seal's hash. A copy of each
-- seal goes to R2 under seals/. scripts/ops/verify-seals.ts recomputes the chain
-- and names the first seal and table that no longer match.
--
--   1. AuditLog, EditApproval and ExportJob get a strictly increasing key, seq
--      (their ids are cuids, which are not ordered). Existing rows are numbered
--      in their physical order: a stable unique key, not a time order, for rows
--      older than this migration. The ALTER rewrites each table under ACCESS
--      EXCLUSIVE for a few seconds (AuditLog is the largest), so this runs
--      outside working hours; it fires no row trigger. Every other sealed table
--      already has a BIGSERIAL id.
--   2. SealRecord: one row per seal. Append-only like AuditLog, stamped with the
--      writer's cause, and a trigger refuses a row whose hash is not the SHA-256
--      of its body, whose body does not name its own seq and previous hash, or
--      which does not link to the last seal (seq + 1, prevHash = its hash). Two
--      writers at once are settled by UNIQUE(seq).
--
-- What this does NOT prove (AUDITOR-BRIEF.md section 8): the owner login can
-- still rewrite rows AND the seals in the maintenance window, and the app's R2
-- token can overwrite the off-site copy, until the bucket is locked (owner).
--
-- Additive. COST: three table rewrites (seconds), one new table, one function.

SET lock_timeout = '10s';

-- ── 1. The keys and the seal table (Prisma's own DDL, so the drift gate matches) ──

ALTER TABLE "ExportJob" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

ALTER TABLE "AuditLog" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

ALTER TABLE "EditApproval" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

CREATE TABLE "SealRecord" (
    "id" BIGSERIAL NOT NULL,
    "seq" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "snapshotXmax" BIGINT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "txId" BIGINT,

    CONSTRAINT "SealRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SealRecord_seq_key" ON "SealRecord"("seq");

CREATE UNIQUE INDEX "SealRecord_day_key" ON "SealRecord"("day");

CREATE UNIQUE INDEX "SealRecord_hash_key" ON "SealRecord"("hash");

CREATE UNIQUE INDEX "ExportJob_seq_key" ON "ExportJob"("seq");

CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");

CREATE UNIQUE INDEX "EditApproval_seq_key" ON "EditApproval"("seq");

-- The shape every seal has (Prisma ignores CHECK constraints): seq 0 is the
-- genesis and only the genesis has no previous hash; a hash is 64 hex digits.
ALTER TABLE "SealRecord" ADD CONSTRAINT "SealRecord_shape_check"
  CHECK ("seq" >= 0 AND ("seq" = 0) = ("prevHash" IS NULL) AND "hash" ~ '^[0-9a-f]{64}$');

-- ── 2. A seal links to the last one, and is what it says it is ────────────

CREATE OR REPLACE FUNCTION nmwc_seal_link_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  last_seq integer;
  last_hash text;
  body jsonb;
BEGIN
  IF encode(sha256(convert_to(NEW."bodyText", 'UTF8')), 'hex') IS DISTINCT FROM NEW."hash" THEN
    RAISE EXCEPTION 'seal %: its hash is not the SHA-256 of its body', NEW."seq"
      USING ERRCODE = 'check_violation';
  END IF;
  body := NEW."bodyText"::jsonb;
  IF (body->>'seq')::int IS DISTINCT FROM NEW."seq" OR (body->>'prev') IS DISTINCT FROM NEW."prevHash" THEN
    RAISE EXCEPTION 'seal %: its body names another seq or previous hash', NEW."seq"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."seq", s."hash" INTO last_seq, last_hash
    FROM public."SealRecord" s ORDER BY s."seq" DESC LIMIT 1;
  IF last_seq IS NULL THEN
    IF NEW."seq" <> 0 THEN
      RAISE EXCEPTION 'seal %: the first seal must be seq 0 (the genesis)', NEW."seq"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."seq" <> last_seq + 1 OR NEW."prevHash" IS DISTINCT FROM last_hash THEN
    RAISE EXCEPTION 'seal %: does not link to the last seal (%)', NEW."seq", last_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_seal_link_guard() FROM PUBLIC;

CREATE TRIGGER sealrecord_link_guard
  BEFORE INSERT ON "SealRecord"
  FOR EACH ROW EXECUTE FUNCTION nmwc_seal_link_guard();

CREATE TRIGGER sealrecord_stamp_context
  BEFORE INSERT ON "SealRecord"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- ── 3. A ledger: insert, never change ─────────────────────────────────────

CREATE TRIGGER sealrecord_append_only BEFORE UPDATE OR DELETE ON "SealRecord" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER sealrecord_no_truncate BEFORE TRUNCATE ON "SealRecord" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- The runtime role, where it exists (scripts/ops/app-role.ts `grant` re-applies
-- the same): the seal table insert and read only; the new key sequences usable
-- (nextval on every insert) but never settable (setval would make keys collide
-- and a sealed range move). Granted explicitly: without USAGE on
-- "AuditLog_seq_seq" every audit insert by the runtime role would fail until
-- `app-role.ts grant` is re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    GRANT SELECT, INSERT ON "SealRecord" TO nmwc_app;
    GRANT USAGE, SELECT ON SEQUENCE "SealRecord_id_seq", "AuditLog_seq_seq", "EditApproval_seq_seq", "ExportJob_seq_seq" TO nmwc_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SealRecord" FROM nmwc_app;
    REVOKE UPDATE ON SEQUENCE "SealRecord_id_seq", "AuditLog_seq_seq", "EditApproval_seq_seq", "ExportJob_seq_seq" FROM nmwc_app;
  END IF;
END;
$$;

RESET lock_timeout;
