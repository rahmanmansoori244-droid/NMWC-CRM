-- B4 hardening (adversarial review of a6addee, 2026-09-14): the maintenance
-- override is only honoured for the TABLE OWNER's session.
--
-- The first cut let any session that ran `SET LOCAL nmwc.audit_maintenance = 'on'`
-- through the trigger, relying on the runtime role having no DELETE privilege
-- on the two ledgers. That was not enough: "EditApproval".editId is ON DELETE
-- CASCADE from "CustomerEdit", and PostgreSQL executes referential actions with
-- the privileges of the referencing table's OWNER — so `nmwc_app` (which may
-- DELETE "CustomerEdit") could set the placeholder GUC, delete a decided edit
-- and take its approval ledger with it, ACL notwithstanding.
--
-- `session_user` is the authenticated login role and is NOT changed by
-- referential actions or SECURITY DEFINER functions, so comparing it with the
-- table owner closes every cascade path: only a session that logged in as the
-- owner (neondb_owner on Neon, `ci` in CI) can use the override. The runtime
-- role additionally loses DELETE/TRUNCATE on "CustomerEdit" (scripts/ops/app-role.ts)
-- because the application never deletes edits at runtime.

CREATE OR REPLACE FUNCTION nmwc_forbid_audit_mutation() RETURNS trigger AS $$
DECLARE
  owner_name name;
BEGIN
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name FROM pg_class c WHERE c.oid = TG_RELID;
    IF session_user = owner_name THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSIF TG_OP = 'TRUNCATE' THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'B4: % on "%" is forbidden — the audit trail is append-only. Only the table owner may open a maintenance transaction (SET LOCAL nmwc.audit_maintenance = ''on'') to override.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
