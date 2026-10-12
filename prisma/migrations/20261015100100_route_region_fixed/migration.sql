-- A route never changes region (data audit 2026-10-10 gap 16, restated by the
-- owner on 2026-10-11; docs/HISTORY.md, docs/OPERATIONS.md).
--
-- The owner's rule: routes NEVER move to another region, are never renamed,
-- split or merged. A route may be closed and its customers moved to other
-- routes; a route for another region is a NEW route. Until now nothing enforced
-- it: the account import moved a route to another region when its Routes sheet
-- said so, and the route's shops kept the old region (Branch.regionId must equal
-- Route.regionId only when a shop itself is written, B-19), so the wrong
-- Manager and Accountant held them and the regional figures counted them in the
-- old region, with no dated record of when each shop changed region.
--
-- Now the database refuses it: any UPDATE that changes Route.regionId fails,
-- for every role and every path, with the same plain words the account import
-- shows (lib/route-region.ts). There is no override, not even in the owner's
-- maintenance window: the owner said never. Creating a route in any region,
-- renaming its label, switching it off and on, and deleting it are unchanged.
--
-- First, a drift report (read only): shops whose region is not their route's,
-- which an earlier route move left behind. Nothing is changed here; the count
-- appears in the deploy log, and docs/OPERATIONS.md says how to put them right.

SET lock_timeout = '10s';

DO $$
DECLARE
  shops bigint;
  routes bigint;
BEGIN
  SELECT count(*), count(DISTINCT b."routeId") INTO shops, routes
    FROM "Branch" b
    JOIN "Route" r ON r."id" = b."routeId"
   WHERE b."regionId" <> r."regionId";
  RAISE NOTICE 'route_region_fixed: % shop(s) on % route(s) carry a region other than their route''s (report only, nothing changed)', shops, routes;
END;
$$;

-- Not SECURITY DEFINER: it reads nothing. EXECUTE revoked from PUBLIC like the
-- history's guards, so no role can attach it elsewhere.
CREATE OR REPLACE FUNCTION nmwc_route_region_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Routes never move to another region. Close this route and open a new one in the other region.'
    USING ERRCODE = 'check_violation',
          DETAIL = format('Route %s stays in region %s.', OLD."code", OLD."regionId");
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_route_region_fixed() FROM PUBLIC;

CREATE TRIGGER route_region_fixed
  BEFORE UPDATE OF "regionId" ON "Route"
  FOR EACH ROW
  WHEN (NEW."regionId" IS DISTINCT FROM OLD."regionId")
  EXECUTE FUNCTION nmwc_route_region_fixed();

RESET lock_timeout;
