-- Gap 30 (data audit 2026-10-10): the test and synthetic records left in
-- production are flagged, so the figures, the exports, the Temix workbook,
-- verify-load and the nightly data checks can leave them out (lib/test-records.ts).
--
--   1. An isTest flag on Region, Route, User and Customer, false by default.
--   2. ONLY these known production test records are marked, by exact identity
--      (lib/test-records.ts KNOWN_TEST_RECORDS, pinned to this file by
--      tests/unit/test-records.test.ts):
--        accounts whose username starts with 'zz.test.'
--        the region coded 'ZZTEST'
--        the route coded 'ZZTEST-R1'
--        the customer coded 'NMWC-2026-000001' (the walk-through customer)
--      starts_with(), not LIKE: '_' and '%' are never wildcards here. On a
--      database without them (a fresh UAT, CI) nothing is marked. NOTHING is
--      deleted, and nothing else changes: the flag is not a watched column, so
--      no history row is written, and updatedAt is set only by the application.
--   3. Once the dashboards, exports and checks key on the flag, an application
--      credential must not be able to hide a real record by flipping it. So,
--      created AFTER the marking: only the table owner, inside the maintenance
--      window (SET LOCAL nmwc.audit_maintenance = 'on', the rule
--      nmwc_forbid_audit_mutation applies to the ledgers), may set or clear it.
--      Every other writer is refused, including an INSERT of a row already
--      flagged. The nightly check test-flags-changed reports any change.
--
-- Additive: four columns with a constant default (no table rewrite), four
-- UPDATEs over a handful of rows, one function and eight triggers.

SET lock_timeout = '10s';

-- ── 1. The flag (Prisma's own DDL, so the CI drift gate matches) ──────────

ALTER TABLE "Region" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Route" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "User" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Customer" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. The known production test records, by exact identity ───────────────

DO $$
DECLARE
  n_users int;
  n_regions int;
  n_routes int;
  n_customers int;
BEGIN
  UPDATE "User"     SET "isTest" = true WHERE starts_with("username", 'zz.test.');
  GET DIAGNOSTICS n_users = ROW_COUNT;
  UPDATE "Region"   SET "isTest" = true WHERE "code" = 'ZZTEST';
  GET DIAGNOSTICS n_regions = ROW_COUNT;
  UPDATE "Route"    SET "isTest" = true WHERE "code" = 'ZZTEST-R1';
  GET DIAGNOSTICS n_routes = ROW_COUNT;
  UPDATE "Customer" SET "isTest" = true WHERE "nmwcCode" = 'NMWC-2026-000001';
  GET DIAGNOSTICS n_customers = ROW_COUNT;
  RAISE NOTICE 'test_records: marked % users, % regions, % routes, % customers',
    n_users, n_regions, n_routes, n_customers;
END;
$$;

-- ── 3. Only the owner, in the maintenance window, may move the flag ───────

CREATE OR REPLACE FUNCTION nmwc_is_test_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  owner_name name;
BEGIN
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
    IF session_user = owner_name THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Only the database owner, inside a maintenance transaction, may mark or unmark a test record on "%". Test records are flagged by the owner (docs/OPERATIONS.md section 7), never by the application.',
    TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_is_test_guard() FROM PUBLIC;

CREATE TRIGGER customer_is_test_guard_ins
  BEFORE INSERT ON "Customer"
  FOR EACH ROW
  WHEN (NEW."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();
CREATE TRIGGER customer_is_test_guard_upd
  BEFORE UPDATE OF "isTest" ON "Customer"
  FOR EACH ROW
  WHEN (NEW."isTest" IS DISTINCT FROM OLD."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();

CREATE TRIGGER user_is_test_guard_ins
  BEFORE INSERT ON "User"
  FOR EACH ROW
  WHEN (NEW."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();
CREATE TRIGGER user_is_test_guard_upd
  BEFORE UPDATE OF "isTest" ON "User"
  FOR EACH ROW
  WHEN (NEW."isTest" IS DISTINCT FROM OLD."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();

CREATE TRIGGER route_is_test_guard_ins
  BEFORE INSERT ON "Route"
  FOR EACH ROW
  WHEN (NEW."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();
CREATE TRIGGER route_is_test_guard_upd
  BEFORE UPDATE OF "isTest" ON "Route"
  FOR EACH ROW
  WHEN (NEW."isTest" IS DISTINCT FROM OLD."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();

CREATE TRIGGER region_is_test_guard_ins
  BEFORE INSERT ON "Region"
  FOR EACH ROW
  WHEN (NEW."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();
CREATE TRIGGER region_is_test_guard_upd
  BEFORE UPDATE OF "isTest" ON "Region"
  FOR EACH ROW
  WHEN (NEW."isTest" IS DISTINCT FROM OLD."isTest")
  EXECUTE FUNCTION nmwc_is_test_guard();

RESET lock_timeout;
