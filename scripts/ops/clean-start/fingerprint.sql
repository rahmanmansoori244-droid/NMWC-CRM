-- Go-live clean start: the PLAN FINGERPRINT (design section 2).
--
-- One read-only statement. It computes plan_id = sha256 over a document of:
--   - the migration list (name, checksum, finished, rolled back);
--   - per KEEP table except CronHeartbeat: count and md5 of every row as jsonb,
--     in key order (COLLATE "C");
--   - per EMPTY table except RateLimit: count, max key, max seq and max
--     updatedAt where those columns exist;
--   - the CodeSequence rows;
--   - sha256 of the photo-key list and sha256 of the seal export (byte for byte
--     the files plan.sql writes);
--   - md5 of the trigger set (printed without parentheses, so that a restored
--     dump gives the same value; see triggers_stable) and of the function bodies.
-- CronRun, CronHeartbeat and RateLimit are left out: the schedulers write them.
--
-- Rows are hashed as to_jsonb(row)::text, not row::text: jsonb prints dates and
-- numbers the same whatever the session's DateStyle, so production and the
-- restored backup give the same value.
--
-- It must run INSIDE a transaction: plan.sql and reset.sql include it (\ir).
-- The psql variable fp_prefix (plan | before | after; default plan) names the
-- results: psql variables cs_<prefix>_<column> through \gset, and the
-- transaction-local settings cs.<prefix>_<column> that the DO blocks of
-- reset.sql and selfcheck.sql compare. It prints nothing.
--
-- tests/unit/clean-start-sql.test.ts pins the table lists below to tables.json.

\if :{?fp_prefix}
\else
\set fp_prefix plan
\endif
\set fp_gset cs_ :fp_prefix _

WITH
keep_tables(t, ord) AS (
  VALUES
    ('User', 'x."id" COLLATE "C"'),
    ('PasswordHistory', 'x."id" COLLATE "C"'),
    ('Region', 'x."id" COLLATE "C"'),
    ('Route', 'x."id" COLLATE "C"'),
    ('_ManagerRegions', 'x."A" COLLATE "C", x."B" COLLATE "C"'),
    ('Channel', 'x."id" COLLATE "C"'),
    ('SubChannel', 'x."id" COLLATE "C"')
),
empty_tables(t) AS (
  VALUES
    ('Customer'), ('Branch'), ('Attachment'), ('CustomerEdit'), ('EditCustomerDraft'),
    ('EditBranchDraft'), ('EditApproval'), ('EditRevision'), ('Notification'), ('ImportBatch'),
    ('ImportRow'), ('TemixSyncBatch'), ('ExportJob'), ('AuditLog'), ('AuthEvent'),
    ('JobRunDay'), ('PurgeSummary'), ('IntegrityCheckResult'), ('SealRecord'), ('SavedView'),
    ('CustomerHistory'), ('BranchHistory'), ('AttachmentHistory'), ('UserHistory'), ('RouteHistory'),
    ('RouteOwnerHistory'), ('RegionHistory')
),
keep_fp AS (
  SELECT 'keep:' || k.t AS name,
         (xpath('/table/row/v/text()', query_to_xml(format(
            'SELECT count(*)::text || '':'' || COALESCE(md5(string_agg(to_jsonb(x)::text, E''\n'' ORDER BY %s)), ''-'') AS v FROM public.%I x',
            k.ord, k.t), false, false, '')))[1]::text AS value
    FROM keep_tables k
),
empty_cols AS (
  SELECT e.t,
         (SELECT a.atttypid = 'pg_catalog.text'::regtype FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = format('public.%I', e.t)::regclass AND a.attname = 'id') AS text_id,
         EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = format('public.%I', e.t)::regclass AND a.attname = 'seq' AND NOT a.attisdropped) AS has_seq,
         EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = format('public.%I', e.t)::regclass AND a.attname = 'updatedAt' AND NOT a.attisdropped) AS has_upd
    FROM empty_tables e
),
empty_fp AS (
  SELECT 'empty:' || c.t AS name,
         (xpath('/table/row/v/text()', query_to_xml(format(
            'SELECT count(*)::text || '':'' || COALESCE(max(x."id"%s)::text, ''-'') || '':'' || %s || '':'' || %s AS v FROM public.%I x',
            CASE WHEN c.text_id THEN ' COLLATE "C"' ELSE '' END,
            CASE WHEN c.has_seq THEN 'COALESCE(max(x."seq")::text, ''-'')' ELSE '''-''' END,
            CASE WHEN c.has_upd THEN 'COALESCE(to_jsonb(max(x."updatedAt"))::text, ''-'')' ELSE '''-''' END,
            c.t), false, false, '')))[1]::text AS value
    FROM empty_cols c
),
migrations AS (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(m.migration_name || ' ' || m.checksum || E'\n', ''
                  ORDER BY m.migration_name COLLATE "C", m.started_at), ''), 'UTF8')), 'hex') AS sha,
         md5(COALESCE(string_agg(m.migration_name || ' ' || m.checksum || ' ' || (m.finished_at IS NOT NULL)::text
                  || ' ' || (m.rolled_back_at IS NOT NULL)::text, E'\n' ORDER BY m.migration_name COLLATE "C", m.started_at), '')) AS state
    FROM public._prisma_migrations m
),
codeseq AS (
  SELECT COALESCE(string_agg(s."scope" || '=' || s."next", ',' ORDER BY s."scope" COLLATE "C"), '-') AS rows
    FROM public."CodeSequence" s
),
photo_keys AS (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(a."r2Key" || E'\n', '' ORDER BY a."r2Key" COLLATE "C"), ''), 'UTF8')), 'hex') AS sha
    FROM public."Attachment" a
),
seals AS (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
           json_build_object('seq', s."seq", 'day', s."day", 'hash', s."hash", 'r2Key', s."r2Key", 'bodyText', s."bodyText")::text || E'\n', ''
           ORDER BY s."seq"), ''), 'UTF8')), 'hex') AS sha
    FROM public."SealRecord" s
),
triggers AS (
  SELECT md5(COALESCE(string_agg(c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_catalog.pg_get_triggerdef(t.oid),
           E'\n' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"), '')) AS md5
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
),
-- The same set, as a dump RESTORES it: Postgres keeps a trigger's WHEN clause as
-- an expression tree, and a chain of ORs created as written is printed nested
-- ((a OR b) OR c) while the same clause re-read from a dump is printed flat
-- (a OR b OR c). Found by tests/integration/clean-start-flow.test.ts: with the
-- printed text in the plan id, production's plan id could never equal the
-- restored backup's (REHEARSE step 2). The plan id therefore takes the text
-- without parentheses; triggers_md5 (the before/after comparison inside one
-- database, selfcheck.sql CS107) keeps the exact text.
triggers_stable AS (
  SELECT md5(COALESCE(string_agg(c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|'
                                 || regexp_replace(pg_catalog.pg_get_triggerdef(t.oid), '[()]', '', 'g'),
           E'\n' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"), '')) AS md5
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
),
functions AS (
  SELECT md5(COALESCE(string_agg(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')|'
           || md5(p.prosrc) || '|' || p.prosecdef::text || '|' || COALESCE(array_to_string(p.proconfig, ';'), ''),
           E'\n' ORDER BY p.proname COLLATE "C", pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"), '')) AS md5
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'public'::regnamespace
     AND l.lanname IN ('plpgsql', 'sql')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
lines(name, value) AS (
  SELECT 'migrations', (SELECT sha || ':' || state FROM migrations)
  UNION ALL SELECT name, value FROM keep_fp
  UNION ALL SELECT name, value FROM empty_fp
  UNION ALL SELECT 'codesequence', (SELECT rows FROM codeseq)
  UNION ALL SELECT 'photo-keys', (SELECT sha FROM photo_keys)
  UNION ALL SELECT 'seals', (SELECT sha FROM seals)
  UNION ALL SELECT 'triggers', (SELECT md5 FROM triggers_stable)
  UNION ALL SELECT 'functions', (SELECT md5 FROM functions)
),
doc AS (
  SELECT string_agg(name || '=' || COALESCE(value, 'NULL'), E'\n' ORDER BY name COLLATE "C") AS text,
         md5(string_agg(name || '=' || COALESCE(value, 'NULL'), E'\n' ORDER BY name COLLATE "C")
               FILTER (WHERE name LIKE 'keep:%')) AS keep_md5
    FROM lines
),
fp AS (
  SELECT encode(sha256(convert_to(d.text, 'UTF8')), 'hex') AS plan_id,
         d.keep_md5,
         (SELECT md5 FROM triggers) AS triggers_md5,
         (SELECT md5 FROM functions) AS functions_md5,
         (SELECT sha FROM photo_keys) AS photo_keys_sha256,
         (SELECT sha FROM seals) AS seals_sha256,
         (SELECT sha FROM migrations) AS migrations_sha256
    FROM doc d
)
SELECT fp.plan_id, fp.keep_md5, fp.triggers_md5, fp.functions_md5, fp.photo_keys_sha256, fp.seals_sha256, fp.migrations_sha256,
       set_config('cs.' || :'fp_prefix' || '_plan_id', fp.plan_id, true) AS s1,
       set_config('cs.' || :'fp_prefix' || '_keep_md5', fp.keep_md5, true) AS s2,
       set_config('cs.' || :'fp_prefix' || '_triggers_md5', fp.triggers_md5, true) AS s3,
       set_config('cs.' || :'fp_prefix' || '_functions_md5', fp.functions_md5, true) AS s4,
       set_config('cs.' || :'fp_prefix' || '_photo_keys_sha256', fp.photo_keys_sha256, true) AS s5,
       set_config('cs.' || :'fp_prefix' || '_seals_sha256', fp.seals_sha256, true) AS s6
  FROM fp
\gset :fp_gset
