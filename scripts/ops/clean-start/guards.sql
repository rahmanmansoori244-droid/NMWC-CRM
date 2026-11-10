-- Go-live clean start: the PLAN CHECKS that live in the database (design
-- section 2, "Release and schema" and "Data"). Read-only. plan.sql runs them in
-- a read-only transaction; reset.sql runs them AGAIN under its SHARE locks, just
-- before the destructive statement. Each failure raises its own SQLSTATE
-- (CS001-CS012), so the public log names the reason without a figure or a name.
--
-- psql variables (an absent one is taken as empty, which refuses):
--   actor_username       the CRM login of the person who performs the reset
--                        (secret CLEANSTART_ACTOR_USERNAME)
--   expected_migrations  sha256 (hex) of the checkout's migration list: one line
--                        "<folder> <sha256 of its migration.sql>\n" per folder of
--                        prisma/migrations, sorted bytewise (LC_ALL=C)
--
-- The table lists are tables.json's (tests/unit/clean-start-sql.test.ts).

\if :{?actor_username}
\else
\set actor_username ''
\endif
\if :{?expected_migrations}
\else
\set expected_migrations ''
\endif

SELECT set_config('cs.actor_username', :'actor_username', true) AS a,
       set_config('cs.expected_migrations', :'expected_migrations', true) AS m
\gset cs_ignore_

-- CS001: the public tables are exactly tables.json's (EMPTY + PARTIAL + KEEP + ignored).
DO $cs$
DECLARE
  expected text[] := ARRAY[
    -- EMPTY
    'Customer', 'Branch', 'Attachment', 'CustomerEdit', 'EditCustomerDraft', 'EditBranchDraft', 'EditApproval',
    'EditRevision', 'Notification', 'ImportBatch', 'ImportRow', 'TemixSyncBatch', 'ExportJob', 'AuditLog',
    'AuthEvent', 'JobRunDay', 'PurgeSummary', 'IntegrityCheckResult', 'SealRecord', 'RateLimit', 'SavedView',
    'CustomerHistory', 'BranchHistory', 'AttachmentHistory', 'UserHistory', 'RouteHistory', 'RouteOwnerHistory',
    'RegionHistory',
    -- PARTIAL
    'CodeSequence', 'CronRun',
    -- KEEP
    'User', 'PasswordHistory', 'Region', 'Route', '_ManagerRegions', 'Channel', 'SubChannel', 'CronHeartbeat',
    -- ignored
    '_prisma_migrations'];
  extra int;
  missing int;
BEGIN
  SELECT count(*) INTO extra FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
     AND NOT (c.relname = ANY (expected));
  SELECT count(*) INTO missing FROM unnest(expected) e(t)
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname = e.t);
  IF extra > 0 OR missing > 0 THEN
    RAISE EXCEPTION 'clean-start guard: the public tables differ from tables.json' USING ERRCODE = 'CS001';
  END IF;
END
$cs$;

-- CS002: this login owns every public table (the maintenance window opens only for the owner).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
                AND pg_catalog.pg_get_userbyid(c.relowner) <> session_user) THEN
    RAISE EXCEPTION 'clean-start guard: this login does not own every table' USING ERRCODE = 'CS002';
  END IF;
END
$cs$;

-- CS003: no foreign key from a table that is not emptied into one that is.
DO $cs$
DECLARE
  emptied text[] := ARRAY[
    'Customer', 'Branch', 'Attachment', 'CustomerEdit', 'EditCustomerDraft', 'EditBranchDraft', 'EditApproval',
    'EditRevision', 'Notification', 'ImportBatch', 'ImportRow', 'TemixSyncBatch', 'ExportJob', 'AuditLog',
    'AuthEvent', 'JobRunDay', 'PurgeSummary', 'IntegrityCheckResult', 'SealRecord', 'RateLimit', 'SavedView',
    'CustomerHistory', 'BranchHistory', 'AttachmentHistory', 'UserHistory', 'RouteHistory', 'RouteOwnerHistory',
    'RegionHistory'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
               JOIN pg_catalog.pg_class src ON src.oid = k.conrelid
               JOIN pg_catalog.pg_class dst ON dst.oid = k.confrelid
              WHERE k.contype = 'f'
                AND dst.relnamespace = 'public'::regnamespace AND dst.relname = ANY (emptied)
                AND NOT (src.relnamespace = 'public'::regnamespace AND src.relname = ANY (emptied))) THEN
    RAISE EXCEPTION 'clean-start guard: a kept table has a foreign key into an emptied one' USING ERRCODE = 'CS003';
  END IF;
END
$cs$;

-- CS004: every trigger is on (O = origin/local, A = always; D = off, R = replica only).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
                AND t.tgenabled NOT IN ('O', 'A')) THEN
    RAISE EXCEPTION 'clean-start guard: a trigger is not enabled' USING ERRCODE = 'CS004';
  END IF;
END
$cs$;

-- CS005: every TRUNCATE trigger is a BEFORE ... FOR EACH STATEMENT trigger on an
-- emptied table, bound to nmwc_forbid_audit_mutation (the guard whose owner's
-- window the reset passes in the sanctioned way); none anywhere else.
-- tgtype bits: 1 = row, 2 = before, 32 = truncate.
DO $cs$
DECLARE
  emptied text[] := ARRAY[
    'Customer', 'Branch', 'Attachment', 'CustomerEdit', 'EditCustomerDraft', 'EditBranchDraft', 'EditApproval',
    'EditRevision', 'Notification', 'ImportBatch', 'ImportRow', 'TemixSyncBatch', 'ExportJob', 'AuditLog',
    'AuthEvent', 'JobRunDay', 'PurgeSummary', 'IntegrityCheckResult', 'SealRecord', 'RateLimit', 'SavedView',
    'CustomerHistory', 'BranchHistory', 'AttachmentHistory', 'UserHistory', 'RouteHistory', 'RouteOwnerHistory',
    'RegionHistory'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
               JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
               JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
              WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND (t.tgtype & 32) <> 0
                AND NOT ((t.tgtype & 2) <> 0 AND (t.tgtype & 1) = 0
                         AND p.proname = 'nmwc_forbid_audit_mutation' AND p.pronamespace = 'public'::regnamespace
                         AND c.relname = ANY (emptied))) THEN
    RAISE EXCEPTION 'clean-start guard: an unexpected TRUNCATE trigger exists' USING ERRCODE = 'CS005';
  END IF;
END
$cs$;

-- CS006: no migration unfinished or rolled back.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public._prisma_migrations m WHERE m.finished_at IS NULL OR m.rolled_back_at IS NOT NULL) THEN
    RAISE EXCEPTION 'clean-start guard: a migration is unfinished or rolled back' USING ERRCODE = 'CS006';
  END IF;
END
$cs$;

-- CS007: the applied migrations (names and checksums) are the checkout's.
DO $cs$
DECLARE
  want text := current_setting('cs.expected_migrations', true);
  have text;
BEGIN
  SELECT encode(sha256(convert_to(COALESCE(string_agg(m.migration_name || ' ' || m.checksum || E'\n', ''
           ORDER BY m.migration_name COLLATE "C", m.started_at), ''), 'UTF8')), 'hex')
    INTO have FROM public._prisma_migrations m;
  IF want IS NULL OR want !~ '^[0-9a-f]{64}$' OR have IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'clean-start guard: the applied migrations are not the checkout''s' USING ERRCODE = 'CS007';
  END IF;
END
$cs$;

-- CS008: the code counter holds only CUSTOMER-<year> scopes.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."CodeSequence" s WHERE s."scope" !~ '^CUSTOMER-[0-9]{4}$') THEN
    RAISE EXCEPTION 'clean-start guard: the code counter holds a scope other than CUSTOMER-<year>' USING ERRCODE = 'CS008';
  END IF;
END
$cs$;

-- CS009: no export or Temix batch names a stored file (their r2Key is unused).
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."ExportJob" j WHERE j."r2Key" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."TemixSyncBatch" b WHERE b."r2Key" IS NOT NULL) THEN
    RAISE EXCEPTION 'clean-start guard: an export or Temix batch names a stored file' USING ERRCODE = 'CS009';
  END IF;
END
$cs$;

-- CS010: no photo row points under seals/.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Attachment" a WHERE a."r2Key" LIKE 'seals/%') THEN
    RAISE EXCEPTION 'clean-start guard: a photo row points under seals/' USING ERRCODE = 'CS010';
  END IF;
END
$cs$;

-- CS011: the actor is exactly one active account that is not a test account.
DO $cs$
DECLARE
  who text := current_setting('cs.actor_username', true);
  n int;
BEGIN
  SELECT count(*) INTO n FROM public."User" u
   WHERE u."username" = who AND u."isActive" AND NOT u."isTest";
  IF who IS NULL OR who = '' OR n <> 1 THEN
    RAISE EXCEPTION 'clean-start guard: the actor is not exactly one active, real account' USING ERRCODE = 'CS011';
  END IF;
END
$cs$;

-- CS012: no clean start has been recorded here already.
DO $cs$
BEGIN
  IF EXISTS (SELECT 1 FROM public."AuditLog" a WHERE a."id" LIKE 'cleanstart-%') THEN
    RAISE EXCEPTION 'clean-start guard: a clean start is already recorded in this database' USING ERRCODE = 'CS012';
  END IF;
END
$cs$;
