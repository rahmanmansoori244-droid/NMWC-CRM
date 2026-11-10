-- Go-live clean start: the SELF-CHECK, inside the reset's transaction, before
-- COMMIT (design section 5). Read-only. Any failure raises its own SQLSTATE
-- (CS101-CS113) and, with ON_ERROR_STOP, the whole reset rolls back.
--
-- Included by reset.sql only: it reads the transaction-local settings and the
-- temporary table cs_before that reset.sql made, and the fingerprint taken
-- before the TRUNCATE (cs.before_*).
--
-- The history-open-interval and history-matches-master SQL is that of
-- lib/integrity/checks.ts (CAPTURED, for User, Route and Region, and the route
-- holder rule); the compared columns are listed on the "captured" lines below
-- and pinned to CAPTURED by tests/unit/clean-start-sql.test.ts.

-- CS101: every emptied table is empty, apart from the one reset row and the baselines.
-- CS112: the audit log is exactly the one reset row of this run.
DO $cs$
DECLARE
  emptied text[] := ARRAY[
    'Customer', 'Branch', 'Attachment', 'CustomerEdit', 'EditCustomerDraft', 'EditBranchDraft', 'EditApproval',
    'EditRevision', 'Notification', 'ImportBatch', 'ImportRow', 'TemixSyncBatch', 'ExportJob', 'AuditLog',
    'AuthEvent', 'JobRunDay', 'PurgeSummary', 'IntegrityCheckResult', 'SealRecord', 'RateLimit', 'SavedView',
    'CustomerHistory', 'BranchHistory', 'AttachmentHistory', 'UserHistory', 'RouteHistory', 'RouteOwnerHistory',
    'RegionHistory'];
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY emptied LOOP
    CONTINUE WHEN t IN ('AuditLog', 'UserHistory', 'RouteHistory', 'RouteOwnerHistory', 'RegionHistory');
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'clean-start self-check: an emptied table is not empty' USING ERRCODE = 'CS101';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public."AuditLog") <> 1
     OR NOT EXISTS (SELECT 1 FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || current_setting('cs.run_id')) THEN
    RAISE EXCEPTION 'clean-start self-check: the audit log is not the one reset row' USING ERRCODE = 'CS112';
  END IF;
END
$cs$;

-- CS102: one BASELINE row per kept region, route and account; per route one
-- holder row, and a second one when its holder's account is younger than the route.
DO $cs$
BEGIN
  IF (SELECT count(*) FROM public."RegionHistory") <> (SELECT count(*) FROM public."Region")
     OR (SELECT count(*) FROM public."RouteHistory") <> (SELECT count(*) FROM public."Route")
     OR (SELECT count(*) FROM public."UserHistory") <> (SELECT count(*) FROM public."User")
     OR (SELECT count(*) FROM public."RouteOwnerHistory")
          <> (SELECT count(*) FROM public."Route")
             + (SELECT count(*) FROM public."Route" r JOIN public."User" o ON o."ownedRouteId" = r."id" WHERE o."createdAt" > r."createdAt")
     OR EXISTS (SELECT 1 FROM public."RegionHistory" h WHERE h."changeKind" <> 'BASELINE')
     OR EXISTS (SELECT 1 FROM public."RouteHistory" h WHERE h."changeKind" <> 'BASELINE')
     OR EXISTS (SELECT 1 FROM public."UserHistory" h WHERE h."changeKind" <> 'BASELINE')
     OR EXISTS (SELECT 1 FROM public."RouteOwnerHistory" h WHERE h."changeKind" <> 'BASELINE') THEN
    RAISE EXCEPTION 'clean-start self-check: the baselines are not one per kept record' USING ERRCODE = 'CS102';
  END IF;
END
$cs$;

-- CS103: history-open-interval (lib/integrity/checks.ts) finds nothing for User, Route and Region.
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
     OR EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (h."userId") h."userId" AS k, h."changeKind" FROM public."UserHistory" h
                                ORDER BY h."userId", h."validFrom" DESC, h."id" DESC) l
                 WHERE l."changeKind" <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM public."User" m WHERE m."id" = l.k))
     OR EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (h."routeId") h."routeId" AS k, h."changeKind" FROM public."RouteHistory" h
                                ORDER BY h."routeId", h."validFrom" DESC, h."id" DESC) l
                 WHERE l."changeKind" <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM public."Route" m WHERE m."id" = l.k))
     OR EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (h."regionId") h."regionId" AS k, h."changeKind" FROM public."RegionHistory" h
                                ORDER BY h."regionId", h."validFrom" DESC, h."id" DESC) l
                 WHERE l."changeKind" <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM public."Region" m WHERE m."id" = l.k)) THEN
    RAISE EXCEPTION 'clean-start self-check: a kept record has no open history interval' USING ERRCODE = 'CS103';
  END IF;
END
$cs$;

-- CS104: history-matches-master (lib/integrity/checks.ts) finds nothing for User, Route, Region and the route holders.
-- captured User: username role isActive supervisorId ownedRouteId regionIds
-- captured Route: code name regionId isActive
-- captured Region: code name isActive
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."User" m
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
    RAISE EXCEPTION 'clean-start self-check: a baseline differs from its record' USING ERRCODE = 'CS104';
  END IF;
END
$cs$;

-- CS105: no history row without a cause (source 'sql').
-- CS113: every baseline and the reset row carry this run's cause, actor and transaction.
DO $cs$
DECLARE
  src text := current_setting('nmwc.source');
  actor text := current_setting('nmwc.actor');
BEGIN
  IF EXISTS (SELECT 1 FROM public."CustomerHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."BranchHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."AttachmentHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."UserHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."RouteHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."RouteOwnerHistory" WHERE "sourceKind" = 'sql')
     OR EXISTS (SELECT 1 FROM public."RegionHistory" WHERE "sourceKind" = 'sql') THEN
    RAISE EXCEPTION 'clean-start self-check: a history row has no cause' USING ERRCODE = 'CS105';
  END IF;
  IF EXISTS (SELECT 1 FROM public."UserHistory" WHERE "source" IS DISTINCT FROM src OR "sourceKind" <> 'script' OR "actorId" IS DISTINCT FROM actor OR "txId" <> txid_current())
     OR EXISTS (SELECT 1 FROM public."RouteHistory" WHERE "source" IS DISTINCT FROM src OR "sourceKind" <> 'script' OR "actorId" IS DISTINCT FROM actor OR "txId" <> txid_current())
     OR EXISTS (SELECT 1 FROM public."RouteOwnerHistory" WHERE "source" IS DISTINCT FROM src OR "sourceKind" <> 'script' OR "actorId" IS DISTINCT FROM actor OR "txId" <> txid_current())
     OR EXISTS (SELECT 1 FROM public."RegionHistory" WHERE "source" IS DISTINCT FROM src OR "sourceKind" <> 'script' OR "actorId" IS DISTINCT FROM actor OR "txId" <> txid_current())
     OR EXISTS (SELECT 1 FROM public."AuditLog" WHERE "source" IS DISTINCT FROM src OR "actorId" IS DISTINCT FROM actor OR "txId" <> txid_current()) THEN
    RAISE EXCEPTION 'clean-start self-check: a new row does not carry this run' USING ERRCODE = 'CS113';
  END IF;
END
$cs$;

\set fp_prefix after
\ir fingerprint.sql

-- CS106 / CS107 / CS108: the kept tables, the triggers and the functions are exactly as before.
DO $cs$
BEGIN
  IF current_setting('cs.after_keep_md5') IS DISTINCT FROM current_setting('cs.before_keep_md5') THEN
    RAISE EXCEPTION 'clean-start self-check: a kept table changed' USING ERRCODE = 'CS106';
  END IF;
  IF current_setting('cs.after_triggers_md5') IS DISTINCT FROM current_setting('cs.before_triggers_md5') THEN
    RAISE EXCEPTION 'clean-start self-check: the triggers changed' USING ERRCODE = 'CS107';
  END IF;
  IF current_setting('cs.after_functions_md5') IS DISTINCT FROM current_setting('cs.before_functions_md5') THEN
    RAISE EXCEPTION 'clean-start self-check: a function changed' USING ERRCODE = 'CS108';
  END IF;
END
$cs$;

-- CS109: no CUSTOMER-<year> counter is left (the next new customer is NMWC-<year>-000001).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."CodeSequence" s WHERE s."scope" ~ '^CUSTOMER-[0-9]{4}$') THEN
    RAISE EXCEPTION 'clean-start self-check: a customer-code counter is left' USING ERRCODE = 'CS109';
  END IF;
END
$cs$;

-- CS110: no sequence went back (keys are never reused).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM cs_before b
               LEFT JOIN pg_catalog.pg_sequences s ON s.schemaname = 'public' AND s.sequencename = b.name
              WHERE b.kind = 'sequence' AND (s.sequencename IS NULL OR COALESCE(s.last_value, 0) < b.n)) THEN
    RAISE EXCEPTION 'clean-start self-check: a sequence went back' USING ERRCODE = 'CS110';
  END IF;
END
$cs$;

-- CS111: no job run from before the Oman day before the reset day is left.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."CronRun" r
              WHERE r."at" < (((now() AT TIME ZONE 'Asia/Muscat')::date - 1)::timestamp AT TIME ZONE 'Asia/Muscat' AT TIME ZONE 'UTC')) THEN
    RAISE EXCEPTION 'clean-start self-check: job runs from before the kept days are left' USING ERRCODE = 'CS111';
  END IF;
END
$cs$;
