-- Both security-relevant trigger functions resolved their lookups through the
-- CALLER's search_path, so the caller could decide what they read.
--
-- A plpgsql function with no search_path of its own runs with whatever the
-- session has set, and `pg_temp` is searched ahead of `pg_catalog` for tables.
-- So the runtime role could do this, with no DDL privilege on anything real:
--
--   CREATE TEMP TABLE pg_class (oid oid, relowner oid, relname name);
--   INSERT INTO pg_class VALUES (<the ledger's oid>, <its own oid>, 'AuditLog');
--   SET LOCAL nmwc.audit_maintenance = 'on';
--   UPDATE "AuditLog" SET "actorId" = '...' WHERE ...;
--
-- nmwc_forbid_audit_mutation() would have read the shadow table, concluded that
-- session_user IS the table owner, and allowed the write. The append-only ledger
-- — the whole of B4, and the artefact docs/compliance/RECORDS-OF-PROCESSING.md
-- names as the record of who did what — would then be rewritable by exactly the
-- credential B4 exists to contain. Every approval of a credit customer could be
-- reattributed, with nothing in the application or the ledger showing it.
--
-- The same trick shadows "Route" to defeat enforce_branch_region_consistency(),
-- which would let a branch be filed under a region that does not own its route.
-- scripts/ops/restore-verify.ts describes that invariant as the thing every
-- region-scoped permission check depends on.
--
-- The fix is to stop asking the caller. `SET search_path` pins resolution for
-- the duration of the function; pg_temp is listed LAST and only because omitting
-- it entirely is not portable. The catalog lookup is additionally schema
-- qualified, and the "Route" lookup is qualified to public, so neither depends
-- on the search_path even being honoured.
--
-- This is a hardening of two existing functions. It creates nothing and drops
-- nothing, so it is safe to apply to a live database and needs no downtime; the
-- triggers themselves are untouched and keep pointing at the same function names.

CREATE OR REPLACE FUNCTION nmwc_forbid_audit_mutation() RETURNS trigger AS $$
DECLARE
  owner_name name;
BEGIN
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
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
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION enforce_branch_region_consistency()
RETURNS TRIGGER AS $$
DECLARE
  expected_region_id TEXT;
BEGIN
  SELECT "regionId" INTO expected_region_id FROM public."Route" WHERE id = NEW."routeId";
  IF expected_region_id IS NULL THEN
    RAISE EXCEPTION 'B-19: routeId % does not exist', NEW."routeId";
  END IF;
  IF NEW."regionId" <> expected_region_id THEN
    RAISE EXCEPTION 'B-19: Branch.regionId (%) must match Route.regionId (%)', NEW."regionId", expected_region_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp;
