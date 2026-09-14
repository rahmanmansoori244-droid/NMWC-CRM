-- B4 (enterprise assessment, 2026-09-14): the audit trail is append-only AT THE
-- DATABASE, not by convention.
--
-- Until now "AuditLog is immutable" was a comment in schema.prisma and a ticked
-- box in TECH-SPEC while the application connected as the database OWNER, so any
-- leaked credential — or any accidental deleteMany in a script — could rewrite
-- the forensic record of credit approvals. Two controls now enforce it:
--
--   1. This trigger: UPDATE / DELETE / TRUNCATE on "AuditLog" and "EditApproval"
--      raise unless the session has explicitly opened a maintenance window with
--      `SET LOCAL nmwc.audit_maintenance = 'on'` inside the same transaction.
--      That protects every connection, including the owner's, from accidents.
--   2. The least-privilege runtime role `nmwc_app` (scripts/ops/app-role.ts)
--      has no UPDATE/DELETE/TRUNCATE privilege on these tables at all, so the
--      GUC override is unavailable to the application in production — the
--      bypass exists for test clean-up and Steward-run maintenance under the
--      owner credential only.
--
-- EditApproval is included because it is the per-step decision ledger the
-- chain engine and the review page rely on (append-only by design; the app
-- never updates or deletes a step). Note its FK to CustomerEdit is ON DELETE
-- CASCADE: deleting an edit that has recorded steps is refused too, which is
-- the intended semantics — decided requests are history.

CREATE OR REPLACE FUNCTION nmwc_forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSIF TG_OP = 'TRUNCATE' THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'B4: % on "%" is forbidden — the audit trail is append-only. Open a maintenance transaction (SET LOCAL nmwc.audit_maintenance = ''on'') to override.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auditlog_append_only ON "AuditLog";
CREATE TRIGGER auditlog_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();

DROP TRIGGER IF EXISTS auditlog_no_truncate ON "AuditLog";
CREATE TRIGGER auditlog_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

DROP TRIGGER IF EXISTS editapproval_append_only ON "EditApproval";
CREATE TRIGGER editapproval_append_only
  BEFORE UPDATE OR DELETE ON "EditApproval"
  FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();

DROP TRIGGER IF EXISTS editapproval_no_truncate ON "EditApproval";
CREATE TRIGGER editapproval_no_truncate
  BEFORE TRUNCATE ON "EditApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
