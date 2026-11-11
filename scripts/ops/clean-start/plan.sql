-- Go-live clean start: the PLAN exports (design section 2). READ-ONLY: one
-- READ ONLY transaction; the wrapper also sets PGOPTIONS='-c default_transaction_read_only=on'.
--
--   psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/ops/clean-start/plan.sql \
--     -v out_dir=<an empty private folder> -v actor_username=… -v expected_migrations=… > plan.out 2>&1
--
-- It runs guards.sql (each failure its own CSnnn) and fingerprint.sql, then
-- writes four files into out_dir and NOTHING to stdout:
--   photo-keys.txt  every Attachment.r2Key, sorted COLLATE "C", one per line
--                   ("\n"); empty file when there is none
--   seals.jsonl     every SealRecord as {"seq","day","hash","r2Key","bodyText"},
--                   by seq, one JSON object per line
--   plan.json       counts of every table, the CodeSequence rows, the test-flag
--                   ids, the latest integrity result of every check with its
--                   open findings, and the facts the owner's questions need.
--                   It holds figures and ids: it is ENCRYPTED before upload and
--                   never printed.
--   plan-id.txt     key=value lines: plan_id, photo_keys_sha256, seals_sha256,
--                   migrations_sha256, old_chain (16 hex or "none"). The
--                   wrapper must check sha256(photo-keys.txt) and
--                   sha256(seals.jsonl) against these lines before upload: they
--                   are the same values the fingerprint binds, recomputed under
--                   lock by reset.sql.
-- Exit 0 = written. Exit 3 = a check refused (SQLSTATE in the output).
-- The files are written by psql on the machine that runs it (\o), in unaligned
-- tuples-only form.

\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set QUIET on

\if :{?out_dir}
\else
\set out_dir ''
\endif

BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';
SELECT set_config('cs.out_dir', :'out_dir', true) AS o
\gset cs_ignore_

-- CS022: an output folder was named.
DO $cs$
BEGIN
  IF current_setting('cs.out_dir') = '' THEN
    RAISE EXCEPTION 'clean-start plan: no output folder' USING ERRCODE = 'CS022';
  END IF;
END
$cs$;

\ir guards.sql

\set fp_prefix plan
\ir fingerprint.sql

\pset format unaligned
\pset tuples_only on
\pset footer off
\pset pager off

\set cs_file :out_dir '/photo-keys.txt'
\o :cs_file
SELECT a."r2Key" FROM public."Attachment" a ORDER BY a."r2Key" COLLATE "C";
\o

\set cs_file :out_dir '/seals.jsonl'
\o :cs_file
SELECT json_build_object('seq', s."seq", 'day', s."day", 'hash', s."hash", 'r2Key', s."r2Key", 'bodyText', s."bodyText")::text
  FROM public."SealRecord" s ORDER BY s."seq";
\o

\set cs_file :out_dir '/plan.json'
\o :cs_file
SELECT jsonb_pretty(jsonb_build_object(
  'planId', current_setting('cs.plan_plan_id'),
  'counts', (SELECT jsonb_object_agg(c.relname,
               (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, false, '')))[1]::text::bigint)
               FROM pg_catalog.pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'),
  'codeSequence', (SELECT COALESCE(jsonb_object_agg(s."scope", s."next"), '{}'::jsonb) FROM public."CodeSequence" s),
  'testFlags', jsonb_build_object(
     'User', (SELECT COALESCE(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM public."User" x WHERE x."isTest"),
     'Route', (SELECT COALESCE(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM public."Route" x WHERE x."isTest"),
     'Region', (SELECT COALESCE(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM public."Region" x WHERE x."isTest"),
     'Customer', (SELECT COALESCE(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM public."Customer" x WHERE x."isTest")),
  'integrity', (SELECT COALESCE(jsonb_object_agg(r."checkId", jsonb_build_object('runAt', r."runAt", 'status', r."status",
                                  'count', r."count", 'open', r."detail" -> 'open')), '{}'::jsonb)
                  FROM (SELECT DISTINCT ON (i."checkId") i."checkId", i."runAt", i."status", i."count", i."detail"
                          FROM public."IntegrityCheckResult" i ORDER BY i."checkId", i."runAt" DESC) r),
  'oldChain', (SELECT jsonb_build_object(
                 'genesis', EXISTS (SELECT 1 FROM public."SealRecord" g WHERE g."seq" = 0),
                 'chain', (SELECT left(g."hash", 16) FROM public."SealRecord" g WHERE g."seq" = 0),
                 'lastSeq', l."seq", 'lastDay', l."day", 'lastHash', l."hash")
                 FROM (SELECT 1) AS one
                 LEFT JOIN LATERAL (SELECT s."seq", s."day", s."hash" FROM public."SealRecord" s ORDER BY s."seq" DESC LIMIT 1) l ON true),
  'unassignedRegion', EXISTS (SELECT 1 FROM public."Region" g WHERE g."code" = 'UNASSIGNED'),
  'unassignedRoute', EXISTS (SELECT 1 FROM public."Route" r WHERE r."code" = 'UNASSIGNED'),
  'temixBatchMarkedLoaded', EXISTS (SELECT 1 FROM public."TemixSyncBatch" b WHERE b."markedLoadedAt" IS NOT NULL),
  'photoKeysNotPhotoShaped', (SELECT count(*) FROM public."Attachment" a
                                WHERE a."r2Key" !~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}/[A-Za-z0-9]+/[A-Z_]+/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  'cronRunsYesterday', EXISTS (SELECT 1 FROM public."CronRun" r
                                WHERE (r."at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date - 1),
  'cronRunsToday', EXISTS (SELECT 1 FROM public."CronRun" r
                            WHERE (r."at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date),
  'windowedJobOutsideHoursLast3Days', EXISTS (SELECT 1 FROM public."CronRun" r
                                               WHERE r."key" IN ('sla-escalate', 'keep-warm', 'email-drain')
                                                 AND r."at" >= (now() AT TIME ZONE 'UTC') - interval '3 days'
                                                 AND extract(hour FROM r."at") NOT BETWEEN 3 AND 14),
  'runtimeRoleExists', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app'),
  -- Whether the APP connects as the runtime role: this session is always the
  -- owner (CS002), so the answer is the app's own latest watch result
  -- (app-login-is-runtime-role detail.login: 'runtime-role' or 'other'; null if never run).
  'appLoginLatestWatch', (SELECT i."detail" ->> 'login' FROM public."IntegrityCheckResult" i
                           WHERE i."checkId" = 'app-login-is-runtime-role' ORDER BY i."runAt" DESC LIMIT 1),
  'runtimeRolePrivilegesLatestWatch', (SELECT i."status" FROM public."IntegrityCheckResult" i
                                        WHERE i."checkId" = 'runtime-role-privileges' ORDER BY i."runAt" DESC LIMIT 1)
));
\o

\set cs_file :out_dir '/plan-id.txt'
\o :cs_file
SELECT 'plan_id=' || :'cs_plan_plan_id'
UNION ALL SELECT 'photo_keys_sha256=' || :'cs_plan_photo_keys_sha256'
UNION ALL SELECT 'seals_sha256=' || :'cs_plan_seals_sha256'
UNION ALL SELECT 'migrations_sha256=' || :'cs_plan_migrations_sha256'
UNION ALL SELECT 'old_chain=' || COALESCE((SELECT left(g."hash", 16) FROM public."SealRecord" g WHERE g."seq" = 0), 'none');
\o

COMMIT;
