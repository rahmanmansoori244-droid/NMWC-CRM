-- Gap 29 (data audit 2026-10-10): something watches the data.
--
-- The nightly integrity watch (app/api/cron/integrity-watch, lib/integrity)
-- runs a set of named, read-only checks and records each one's outcome here:
-- the run, the check and its version, pass / fail / info / error, how many
-- records broke the rule, at most ten sample ids (record ids, trigger names, job
-- keys or code scopes — never a personal value) and counts by sub-kind. A run
-- that finds a problem leaves the Data Steward one in-app alert, linking to
-- /status/integrity, where these rows are read.
--
-- The results are evidence too: append-only like AuditLog, stamped with the
-- writer's cause, insert and read only for the runtime role, and sealed with
-- the other ledgers (lib/seal/canon.ts).
--
-- Additive: one new table, its indexes, a CHECK constraint and three triggers.

SET lock_timeout = '10s';

-- ── 1. The table (Prisma's own DDL, so the CI drift gate matches) ─────────

CREATE TABLE "IntegrityCheckResult" (
    "id" BIGSERIAL NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "day" DATE NOT NULL,
    "checkId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "count" INTEGER,
    "sampleIds" TEXT[],
    "detail" JSONB,
    "durationMs" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "txId" BIGINT,

    CONSTRAINT "IntegrityCheckResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrityCheckResult_checkId_runAt_idx" ON "IntegrityCheckResult"("checkId", "runAt" DESC);

CREATE INDEX "IntegrityCheckResult_runAt_idx" ON "IntegrityCheckResult"("runAt" DESC);

CREATE UNIQUE INDEX "IntegrityCheckResult_runAt_checkId_key" ON "IntegrityCheckResult"("runAt", "checkId");

-- What a result can say (Prisma ignores CHECK constraints).
ALTER TABLE "IntegrityCheckResult" ADD CONSTRAINT "IntegrityCheckResult_status_check"
  CHECK ("status" IN ('pass', 'fail', 'info', 'error'));

-- ── 2. The writer's cause and transaction, stamped like AuditLog's ────────

CREATE TRIGGER integritycheckresult_stamp_context
  BEFORE INSERT ON "IntegrityCheckResult"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- ── 3. A ledger: insert, never change ─────────────────────────────────────

CREATE TRIGGER integritycheckresult_append_only BEFORE UPDATE OR DELETE ON "IntegrityCheckResult" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER integritycheckresult_no_truncate BEFORE TRUNCATE ON "IntegrityCheckResult" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- The runtime role, where it exists (scripts/ops/app-role.ts `grant` re-applies
-- the same): insert and read, never update or delete; the id sequence usable but
-- not settable. Granted explicitly, so the first nightly run after this deploy
-- does not wait on a re-run of `app-role.ts grant`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    GRANT SELECT, INSERT ON "IntegrityCheckResult" TO nmwc_app;
    GRANT USAGE, SELECT ON SEQUENCE "IntegrityCheckResult_id_seq" TO nmwc_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "IntegrityCheckResult" FROM nmwc_app;
    REVOKE UPDATE ON SEQUENCE "IntegrityCheckResult_id_seq" FROM nmwc_app;
  END IF;
END;
$$;

RESET lock_timeout;
