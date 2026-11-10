-- Go-live clean start: the small READ-ONLY questions the workflows ask a
-- database between the main steps. One READ ONLY transaction; prints only the
-- answer (unaligned, tuples only), into the file the workflow names.
--
--   psql "$URL" -X -q -At -v ON_ERROR_STOP=1 -f scripts/ops/clean-start/facts.sql -v fact=<name> [-v …] > answer 2>&1
--
--   heartbeat      -v hours=N   t when the db-backup heartbeat is ok and younger than N hours
--   reset-row      -v run_id=R  "<epoch> <photoKeysSha256> <safetyBranch>" of AuditLog cleanstart-R, or nothing
--   reset-report   -v run_id=R  the reset row's after (jsonb) — counts: for the ENCRYPTED report only
--   watch-results               the first watch run since the reset: checkId<TAB>status<TAB>open signatures
--   watch-latest                the latest watch run, in the same form (mode seal-restore)
--   watch-since-reset           t when any integrity result exists (the first run already happened)
--   no-reset-row                t when no clean-start reset row exists (the Neon restore proof)
--   seal-state     -v run_id=R  t when the seal chain's genesis is the old chain -v old_chain=X and the reset row of R is gone
--   attachment-keys             every Attachment.r2Key, sorted COLLATE "C" — for the photo step's files only
--
-- Exit 0 = answered; 3 = an error (SQLSTATE only, VERBOSITY sqlstate).

\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset footer off
\pset pager off
\pset fieldsep '\t'

\if :{?fact}
\else
\set fact ''
\endif
\if :{?run_id}
\else
\set run_id ''
\endif
\if :{?hours}
\else
\set hours 4
\endif
\if :{?old_chain}
\else
\set old_chain ''
\endif

BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';

SELECT :'fact' = 'heartbeat' AS f_heartbeat,
       :'fact' = 'reset-row' AS f_reset_row,
       :'fact' = 'reset-report' AS f_reset_report,
       :'fact' = 'watch-results' AS f_watch_results,
       :'fact' = 'watch-latest' AS f_watch_latest,
       :'fact' = 'watch-since-reset' AS f_watch_since,
       :'fact' = 'no-reset-row' AS f_no_reset_row,
       :'fact' = 'seal-state' AS f_seal_state,
       :'fact' = 'attachment-keys' AS f_attachment_keys,
       :'run_id' ~ '^[0-9]{1,20}$' AS f_run_ok,
       :'hours' ~ '^[0-9]{1,2}$' AS f_hours_ok
\gset

\if :f_heartbeat
  \if :f_hours_ok
SELECT EXISTS (SELECT 1 FROM public."CronHeartbeat" h
                WHERE h."key" = 'db-backup' AND h."lastOk"
                  AND h."lastRunAt" > (now() AT TIME ZONE 'UTC') - make_interval(hours => :'hours'::int));
  \endif
\elif :f_reset_row
  \if :f_run_ok
SELECT extract(epoch FROM a."at")::bigint, a."after" ->> 'photoKeysSha256', a."after" ->> 'safetyBranch'
  FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || :'run_id';
  \endif
\elif :f_reset_report
  \if :f_run_ok
SELECT a."after"::text FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || :'run_id';
  \endif
\elif :f_watch_results
SELECT r."checkId", r."status",
       COALESCE((SELECT string_agg(o ->> 'sig', ',' ORDER BY o ->> 'sig')
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r."detail" -> 'open') = 'array'
                                                  THEN r."detail" -> 'open' ELSE '[]'::jsonb END) o), '')
  FROM public."IntegrityCheckResult" r
 WHERE r."runAt" = (SELECT min(x."runAt") FROM public."IntegrityCheckResult" x)
 ORDER BY r."checkId" COLLATE "C";
\elif :f_watch_latest
SELECT r."checkId", r."status", ''
  FROM public."IntegrityCheckResult" r
 WHERE r."runAt" = (SELECT max(x."runAt") FROM public."IntegrityCheckResult" x)
 ORDER BY r."checkId" COLLATE "C";
\elif :f_watch_since
SELECT EXISTS (SELECT 1 FROM public."IntegrityCheckResult");
\elif :f_no_reset_row
SELECT NOT EXISTS (SELECT 1 FROM public."AuditLog" a WHERE a."id" LIKE 'cleanstart-%');
\elif :f_seal_state
  \if :f_run_ok
SELECT COALESCE((SELECT left(s."hash", 16) FROM public."SealRecord" s WHERE s."seq" = 0), 'none') = :'old_chain'
       AND NOT EXISTS (SELECT 1 FROM public."AuditLog" a WHERE a."id" = 'cleanstart-' || :'run_id');
  \endif
\elif :f_attachment_keys
SELECT a."r2Key" FROM public."Attachment" a ORDER BY a."r2Key" COLLATE "C";
\endif

COMMIT;
