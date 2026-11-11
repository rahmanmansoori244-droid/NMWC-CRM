-- Go-live clean start: VERIFY, after COMMIT (design section 5, steps e and f;
-- the same file in mode finish). Read-only, its own transaction.
--
--   psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=… -f scripts/ops/clean-start/verify.sql > verify.out 2>&1
--
-- The FIRST check settles an ambiguous COMMIT: CS301 means the reset row of
-- this run is not there, so the reset did not commit and nothing changed.
-- The rest (CS302-CS307) prove the state the reset left, in ways that stay true
-- while the application is used again before the real import: customer data
-- still empty, this run's baselines whole, every kept account, route and region
-- with a matching open history interval, every trigger on, no counter, no
-- history row without a cause since the reset.
-- Exit 0 and the line "clean-start: verify ok" = all hold; exit 3 = one failed
-- (its SQLSTATE in the output); exit 2 = no connection.

\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set QUIET on

\if :{?run_id}
\else
\set run_id ''
\endif
-- -v scope=finish (mode finish, which may run after the CRM is used again):
-- CS302 (customer data empty), CS303 (baseline count = kept records now) and
-- CS306 (no counter) describe the state right after the reset and stop being
-- true as soon as anyone creates a request, a saved view, a customer or
-- removes a route; they are skipped there. CS301 (did it commit) and the
-- checks that stay true while the CRM is used (CS304, CS305, CS307) always run.
\if :{?scope}
\else
\set scope apply
\endif
SELECT :'scope' = 'finish' AS cs_finish_scope
\gset

BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';
SELECT set_config('cs.run_id', :'run_id', true) AS r
\gset cs_ignore_

-- CS301: the reset of this run committed.
DO $cs$
BEGIN
  IF current_setting('cs.run_id') !~ '^[A-Za-z0-9-]{1,40}$'
     OR NOT EXISTS (SELECT 1 FROM public."AuditLog" a
                     WHERE a."id" = 'cleanstart-' || current_setting('cs.run_id')
                       AND a."source" = 'script:clean-start:' || current_setting('cs.run_id')) THEN
    RAISE EXCEPTION 'clean-start verify: the reset row of this run is not there' USING ERRCODE = 'CS301';
  END IF;
END
$cs$;

\if :cs_finish_scope
\else
-- CS302: the customer data is still empty.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Customer") OR EXISTS (SELECT 1 FROM public."Branch")
     OR EXISTS (SELECT 1 FROM public."Attachment") OR EXISTS (SELECT 1 FROM public."CustomerEdit")
     OR EXISTS (SELECT 1 FROM public."EditCustomerDraft") OR EXISTS (SELECT 1 FROM public."EditBranchDraft")
     OR EXISTS (SELECT 1 FROM public."EditApproval") OR EXISTS (SELECT 1 FROM public."EditRevision")
     OR EXISTS (SELECT 1 FROM public."ImportBatch") OR EXISTS (SELECT 1 FROM public."ImportRow")
     OR EXISTS (SELECT 1 FROM public."TemixSyncBatch") OR EXISTS (SELECT 1 FROM public."ExportJob")
     OR EXISTS (SELECT 1 FROM public."CustomerHistory") OR EXISTS (SELECT 1 FROM public."BranchHistory")
     OR EXISTS (SELECT 1 FROM public."AttachmentHistory") OR EXISTS (SELECT 1 FROM public."SavedView") THEN
    RAISE EXCEPTION 'clean-start verify: customer data is present' USING ERRCODE = 'CS302';
  END IF;
END
$cs$;
\endif

\if :cs_finish_scope
\else
-- CS303: this run's baselines are whole (one per kept region, route, account; the holder rows).
DO $cs$
DECLARE
  src text := 'script:clean-start:' || current_setting('cs.run_id');
BEGIN
  IF (SELECT count(*) FROM public."RegionHistory" h WHERE h."source" = src AND h."changeKind" = 'BASELINE')
       <> (SELECT count(*) FROM public."Region" r WHERE r."createdAt" <= (SELECT a."at" FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || current_setting('cs.run_id')))
     OR (SELECT count(*) FROM public."RouteHistory" h WHERE h."source" = src AND h."changeKind" = 'BASELINE')
       <> (SELECT count(*) FROM public."Route" r WHERE r."createdAt" <= (SELECT a."at" FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || current_setting('cs.run_id')))
     OR (SELECT count(*) FROM public."UserHistory" h WHERE h."source" = src AND h."changeKind" = 'BASELINE')
       <> (SELECT count(*) FROM public."User" u WHERE u."createdAt" <= (SELECT a."at" FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || current_setting('cs.run_id')))
     OR (SELECT count(*) FROM public."RouteOwnerHistory" h WHERE h."source" = src AND h."changeKind" = 'BASELINE')
       < (SELECT count(*) FROM public."Route" r WHERE r."createdAt" <= (SELECT a."at" FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || current_setting('cs.run_id'))) THEN
    RAISE EXCEPTION 'clean-start verify: this run''s baselines are not whole' USING ERRCODE = 'CS303';
  END IF;
END
$cs$;
\endif

-- CS304: every kept account, route and region has an open history interval that matches it (lib/integrity/checks.ts).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."User" m
              WHERE NOT EXISTS (SELECT 1 FROM (SELECT h.* FROM public."UserHistory" h WHERE h."userId" = m."id"
                                                ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l WHERE l."changeKind" <> 'DELETE'))
     OR EXISTS (SELECT 1 FROM public."Route" m
              WHERE NOT EXISTS (SELECT 1 FROM (SELECT h.* FROM public."RouteHistory" h WHERE h."routeId" = m."id"
                                                ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l WHERE l."changeKind" <> 'DELETE'))
     OR EXISTS (SELECT 1 FROM public."Region" m
              WHERE NOT EXISTS (SELECT 1 FROM (SELECT h.* FROM public."RegionHistory" h WHERE h."regionId" = m."id"
                                                ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l WHERE l."changeKind" <> 'DELETE'))
     OR EXISTS (SELECT 1 FROM public."User" m
               CROSS JOIN LATERAL (SELECT h.* FROM public."UserHistory" h WHERE h."userId" = m."id"
                                    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l
              WHERE l."changeKind" <> 'DELETE'
                AND ROW(m."username", m."role", m."isActive", m."supervisorId", m."ownedRouteId",
                        COALESCE((SELECT array_agg(mr."A" ORDER BY mr."A") FROM public."_ManagerRegions" mr WHERE mr."B" = m."id"), '{}'))
                    IS DISTINCT FROM
                    ROW(l."username", l."role", l."isActive", l."supervisorId", l."ownedRouteId", l."regionIds"))
     OR EXISTS (SELECT 1 FROM public."Route" m
               CROSS JOIN LATERAL (SELECT h.* FROM public."RouteHistory" h WHERE h."routeId" = m."id"
                                    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l
              WHERE l."changeKind" <> 'DELETE'
                AND ROW(m."code", m."name", m."regionId", m."isActive")
                    IS DISTINCT FROM ROW(l."code", l."name", l."regionId", l."isActive"))
     OR EXISTS (SELECT 1 FROM public."Region" m
               CROSS JOIN LATERAL (SELECT h.* FROM public."RegionHistory" h WHERE h."regionId" = m."id"
                                    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l
              WHERE l."changeKind" <> 'DELETE'
                AND ROW(m."code", m."name", m."isActive") IS DISTINCT FROM ROW(l."code", l."name", l."isActive"))
     OR EXISTS (SELECT 1 FROM public."Route" r
                 LEFT JOIN LATERAL (SELECT h."ownerId", h."changeKind" FROM public."RouteOwnerHistory" h
                                     WHERE h."routeId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l ON true
                 LEFT JOIN public."User" u ON u."ownedRouteId" = r."id"
                WHERE (l."changeKind" IS NULL AND u."id" IS NOT NULL)
                   OR (l."changeKind" IS NOT NULL AND l."ownerId" IS DISTINCT FROM u."id")) THEN
    RAISE EXCEPTION 'clean-start verify: a kept record''s history does not match it' USING ERRCODE = 'CS304';
  END IF;
END
$cs$;

-- CS305: every trigger is on.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
                AND t.tgenabled NOT IN ('O', 'A')) THEN
    RAISE EXCEPTION 'clean-start verify: a trigger is not enabled' USING ERRCODE = 'CS305';
  END IF;
END
$cs$;

\if :cs_finish_scope
\else
-- CS306: no customer-code counter (none can have been used while Customer is empty).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."CodeSequence" s WHERE s."scope" ~ '^CUSTOMER-[0-9]{4}$') THEN
    RAISE EXCEPTION 'clean-start verify: a customer-code counter is present' USING ERRCODE = 'CS306';
  END IF;
END
$cs$;
\endif

-- CS307: no history row without a cause since the reset.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."UserHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."RouteHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."RouteOwnerHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."RegionHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."CustomerHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."BranchHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."AttachmentHistory" WHERE "sourceKind" = 'sql') THEN
    RAISE EXCEPTION 'clean-start verify: a history row has no cause' USING ERRCODE = 'CS307';
  END IF;
END
$cs$;

COMMIT;

\echo 'clean-start: verify ok'
