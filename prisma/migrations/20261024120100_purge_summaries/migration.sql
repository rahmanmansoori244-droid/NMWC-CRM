-- Gap 25 (data audit 2026-10-10): every purge leaves a summary.
--
-- The retention rules (lib/retention-rules.ts: the rate-limit buckets, the
-- import payloads, unread and read notifications, the scheduled-run history,
-- detached photos and old password hashes) each delete through ONE statement
-- that also writes a row here (lib/purge-summary.ts): which job and rule, which
-- table, how many rows, the oldest and newest date, the cut-off, and counts by
-- category (never a key, a name or a value). The periods do not change.
--
-- PurgeSummary is a ledger: insert, never change. The same protection as
-- AuditLog (nmwc_forbid_audit_mutation: only the table owner, inside the
-- maintenance window), the same stamp of the writer's cause and transaction
-- (nmwc_auditlog_stamp_context), and the runtime role may insert and read only.
--
-- Additive: one new table, its indexes, CHECK constraints and three triggers.

SET lock_timeout = '10s';

-- ── 1. The table (Prisma's own DDL, so the CI drift gate matches) ─────────

CREATE TABLE "PurgeSummary" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "job" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "dateColumn" TEXT NOT NULL,
    "oldestAt" TIMESTAMP(3),
    "newestAt" TIMESTAMP(3),
    "cutoff" TIMESTAMP(3),
    "retentionDays" INTEGER,
    "detail" JSONB,
    "runId" TEXT,
    "source" TEXT,
    "txId" BIGINT,

    CONSTRAINT "PurgeSummary_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurgeSummary_at_idx" ON "PurgeSummary"("at" DESC);

CREATE INDEX "PurgeSummary_tableName_at_idx" ON "PurgeSummary"("tableName", "at" DESC);

-- A summary says only what the code can say (Prisma ignores CHECK constraints,
-- as it does AuthEvent_kind_check). An empty batch writes no row at all.
ALTER TABLE "PurgeSummary" ADD CONSTRAINT "PurgeSummary_action_check"
  CHECK ("action" IN ('DELETE', 'CLEAR_PAYLOAD'));
ALTER TABLE "PurgeSummary" ADD CONSTRAINT "PurgeSummary_rule_check"
  CHECK ("rule" IN ('rate-limit-1d', 'import-payload-90d', 'notification-unread-180d', 'cron-run-90d', 'notification-read-90d', 'photo-detached-30d', 'password-history-last-5'));
ALTER TABLE "PurgeSummary" ADD CONSTRAINT "PurgeSummary_rows_check"
  CHECK ("rows" > 0);

-- ── 2. The writer's cause and transaction, stamped like AuditLog's ────────

CREATE TRIGGER purgesummary_stamp_context
  BEFORE INSERT ON "PurgeSummary"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- ── 3. A ledger: insert, never change ─────────────────────────────────────

CREATE TRIGGER purgesummary_append_only BEFORE UPDATE OR DELETE ON "PurgeSummary" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER purgesummary_no_truncate BEFORE TRUNCATE ON "PurgeSummary" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- The runtime role, where it exists (scripts/ops/app-role.ts `grant` re-applies
-- the same after its blanket GRANT): insert and read, never update or delete;
-- the id sequence usable (nextval on insert) but not settable (setval). Granted
-- explicitly: without them the first purge after this deploy would fail on the
-- runtime role until `app-role.ts grant` is re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    GRANT SELECT, INSERT ON "PurgeSummary" TO nmwc_app;
    GRANT USAGE, SELECT ON SEQUENCE "PurgeSummary_id_seq" TO nmwc_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PurgeSummary" FROM nmwc_app;
    REVOKE UPDATE ON SEQUENCE "PurgeSummary_id_seq" FROM nmwc_app;
  END IF;
END;
$$;

RESET lock_timeout;
