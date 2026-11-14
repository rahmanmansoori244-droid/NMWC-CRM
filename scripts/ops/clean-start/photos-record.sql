-- Go-live clean start, PHOTOS step 5 (design section 6): ONE AuditLog row on
-- production recording that the test photos of reset run R were deleted, under
-- this run's change source. An INSERT only: AuditLog is append-only and an
-- insert needs no maintenance window. The counts are visible only in-app.
-- complete=yes only when the delete step succeeded (every photo to delete was
-- confirmed gone); with no, the row says the deletion did NOT complete.
-- attempt is GitHub's run attempt: a "Re-run failed jobs" keeps the run id, so a
-- later attempt gets its own row (cleanstart-photos-<run>-<attempt>); the first
-- attempt's id stays cleanstart-photos-<run>.
--
--   psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/ops/clean-start/photos-record.sql \
--     -v run_id=<this run> -v reset_run_id=<R> -v actor_username=… -v list_sha256=<64 hex> \
--     -v listed=N -v skipped_shape=N -v skipped_uat=N -v deleted=N -v complete=yes|no -v attempt=N > record.out 2>&1
-- Exit 0 = recorded; 3 = refused (SQLSTATE only).

\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set QUIET on

BEGIN;
SET LOCAL TimeZone = 'UTC';
SELECT set_config('nmwc.actor', COALESCE((SELECT min(u."id") FROM public."User" u
                                            WHERE u."username" = :'actor_username' AND u."isActive" AND NOT u."isTest"
                                           HAVING count(*) = 1), ''), true) AS a,
       set_config('nmwc.source', 'script:clean-start-photos:' || :'run_id', true) AS s,
       set_config('cs.run_id', :'run_id', true) AS r,
       set_config('cs.reset_run_id', :'reset_run_id', true) AS rr,
       set_config('cs.list_sha256', :'list_sha256', true) AS l,
       set_config('cs.complete', :'complete', true) AS cp,
       set_config('cs.attempt', :'attempt', true) AS at,
       set_config('cs.counts', :'listed' || ',' || :'skipped_shape' || ',' || :'skipped_uat' || ',' || :'deleted', true) AS c
\gset cs_ignore_

-- CS401: the run's values have their shapes, and the actor is one active real account.
DO $cs$
BEGIN
  IF current_setting('cs.run_id') !~ '^[0-9]{1,20}$'
     OR current_setting('cs.reset_run_id') !~ '^[0-9]{1,20}$'
     OR current_setting('cs.list_sha256') !~ '^[0-9a-f]{64}$'
     OR current_setting('cs.counts') !~ '^[0-9]{1,9},[0-9]{1,9},[0-9]{1,9},[0-9]{1,9}$'
     OR current_setting('cs.complete') NOT IN ('yes', 'no')
     OR current_setting('cs.attempt') !~ '^[1-9][0-9]{0,3}$'
     OR current_setting('nmwc.actor') = '' THEN
    RAISE EXCEPTION 'clean-start photos: a run value is malformed' USING ERRCODE = 'CS401';
  END IF;
END
$cs$;

-- CS402: the reset of that run is recorded, and its list is this list.
DO $cs$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."AuditLog" a
                  WHERE a."id" = 'cleanstart-' || current_setting('cs.reset_run_id')
                    AND a."after" ->> 'photoKeysSha256' = current_setting('cs.list_sha256')) THEN
    RAISE EXCEPTION 'clean-start photos: the reset row is not there or names another list' USING ERRCODE = 'CS402';
  END IF;
END
$cs$;

INSERT INTO public."AuditLog" ("id", "actorId", "action", "entityType", "entityId", "reason", "after")
VALUES ('cleanstart-photos-' || current_setting('cs.run_id')
          || CASE WHEN current_setting('cs.attempt') = '1' THEN '' ELSE '-' || current_setting('cs.attempt') END,
current_setting('nmwc.actor'), 'DELETE', 'System', 'clean-start-photos',
        CASE WHEN current_setting('cs.complete') = 'yes'
             THEN 'Go-live clean start (owner decision): the test-period photos listed at the reset were deleted from storage, at least 7 days after it.'
             ELSE 'Go-live clean start (owner decision): the deletion of the test-period photos listed at the reset did NOT complete; some are still in storage (see the run).'
        END,
        jsonb_build_object(
          'runId', current_setting('cs.run_id'),
          'runAttempt', current_setting('cs.attempt')::int,
          'resetRunId', current_setting('cs.reset_run_id'),
          'listSha256', current_setting('cs.list_sha256'),
          'listed', split_part(current_setting('cs.counts'), ',', 1)::int,
          'skippedNotPhotoShaped', split_part(current_setting('cs.counts'), ',', 2)::int,
          'skippedUsedByTestEnvironment', split_part(current_setting('cs.counts'), ',', 3)::int,
          'deleted', split_part(current_setting('cs.counts'), ',', 4)::int,
          'complete', current_setting('cs.complete') = 'yes'));

COMMIT;

\echo 'clean-start: photos recorded'
