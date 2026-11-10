-- Go-live clean start: THE RESET (design section 5, reset.sql).
--
-- ONE transaction, as the owner login, in the sanctioned maintenance window:
-- the change context names the run, every table the reset reads or changes is
-- locked in SHARE mode (writers wait, readers go on), the plan checks and the
-- plan fingerprint are checked AGAIN under the locks, then ONE
--   TRUNCATE <the 28 EMPTY tables> CONTINUE IDENTITY RESTRICT
-- (no sequence is reset, no CASCADE: Postgres itself refuses it if a kept table
-- points into an emptied one), the two partial DELETEs, the one reset AuditLog
-- row, the four BASELINE history inserts copied from
-- prisma/migrations/20261013100100_history_foundation (lines 295-335), the
-- self-check, COMMIT. Nothing is disabled, altered or re-pointed: every ledger's
-- own BEFORE TRUNCATE trigger lets the owner's window through
-- (nmwc_forbid_audit_mutation, 20260915120000_trigger_search_path).
--
-- Run it ONLY through the clean-start wrapper, which checks the host first:
--   psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/ops/clean-start/reset.sql \
--     -v run_id=… -v plan_id=… -v actor_username=… -v expected_migrations=… \
--     [-v commit=… -v backup_key=… -v backup_sha256=… -v safety_branch=… -v archive_prefix=…] > reset.out 2>&1
-- Exit 0 = committed. Exit 3 = refused or failed, and the transaction rolled
-- back: the output names the SQLSTATE only (CSnnn = a clean-start check; any
-- other code = Postgres's own refusal, e.g. 55P03 a lock wait, 42501 a missing
-- privilege). Exit 2 = no connection. Exit 1 = psql could not read a file.
--
-- psql variables:
--   run_id               required, [A-Za-z0-9-]{1,40}: the GitHub run id (the
--                        AuditLog row is 'cleanstart-<run_id>', the change
--                        source 'script:clean-start:<run_id>')
--   plan_id              required, 64 hex: the PLAN job's fingerprint; the
--                        fingerprint under lock must be equal, else CS013
--   actor_username       required: guards.sql CS011
--   expected_migrations  required: guards.sql CS007
--   commit, backup_key, backup_sha256, safety_branch, archive_prefix
--                        optional, recorded in the reset row (CS020 on a bad shape)
--
-- Every statement shape is pinned by tests/unit/clean-start-sql.test.ts.

\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set QUIET on

\if :{?run_id}
\else
\set run_id ''
\endif
\if :{?plan_id}
\else
\set plan_id ''
\endif
\if :{?actor_username}
\else
\set actor_username ''
\endif
\if :{?commit}
\else
\set commit ''
\endif
\if :{?backup_key}
\else
\set backup_key ''
\endif
\if :{?backup_sha256}
\else
\set backup_sha256 ''
\endif
\if :{?safety_branch}
\else
\set safety_branch ''
\endif
\if :{?archive_prefix}
\else
\set archive_prefix ''
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL TimeZone = 'UTC';
SET LOCAL nmwc.audit_maintenance = 'on';
SELECT set_config('nmwc.actor', COALESCE((SELECT min(u."id") FROM public."User" u
                                            WHERE u."username" = :'actor_username' AND u."isActive" AND NOT u."isTest"
                                           HAVING count(*) = 1), ''), true) AS a,
       set_config('nmwc.source', 'script:clean-start:' || :'run_id', true) AS s,
       set_config('nmwc.effective_from', '', true) AS e,
       set_config('cs.run_id', :'run_id', true) AS r,
       set_config('cs.plan_expected', :'plan_id', true) AS p,
       set_config('cs.commit', :'commit', true) AS c,
       set_config('cs.backup_key', :'backup_key', true) AS bk,
       set_config('cs.backup_sha256', :'backup_sha256', true) AS bs,
       set_config('cs.safety_branch', :'safety_branch', true) AS sb,
       set_config('cs.archive_prefix', :'archive_prefix', true) AS ap
\gset cs_ignore_

-- CS020: the run's own values have the shape they must have.
DO $cs$
BEGIN
  IF current_setting('cs.run_id') !~ '^[A-Za-z0-9-]{1,40}$'
     OR current_setting('cs.plan_expected') !~ '^[0-9a-f]{64}$'
     OR current_setting('cs.commit') !~ '^([0-9a-f]{7,40})?$'
     OR current_setting('cs.backup_key') !~ '^[A-Za-z0-9._/:-]{0,200}$'
     OR current_setting('cs.backup_sha256') !~ '^([0-9a-f]{64})?$'
     OR current_setting('cs.safety_branch') !~ '^[A-Za-z0-9._-]{0,100}$'
     OR current_setting('cs.archive_prefix') !~ '^[A-Za-z0-9._/-]{0,200}$' THEN
    RAISE EXCEPTION 'clean-start: a run value is missing or malformed' USING ERRCODE = 'CS020';
  END IF;
END
$cs$;

-- CS021: the owner's window is open and the transaction may write.
DO $cs$
BEGIN
  IF current_setting('nmwc.audit_maintenance', true) IS DISTINCT FROM 'on'
     OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'clean-start: the maintenance window is not open for writing' USING ERRCODE = 'CS021';
  END IF;
END
$cs$;

LOCK TABLE
  public."Customer", public."Branch", public."Attachment", public."CustomerEdit", public."EditCustomerDraft",
  public."EditBranchDraft", public."EditApproval", public."EditRevision", public."Notification", public."ImportBatch",
  public."ImportRow", public."TemixSyncBatch", public."ExportJob", public."AuditLog", public."AuthEvent",
  public."JobRunDay", public."PurgeSummary", public."IntegrityCheckResult", public."SealRecord", public."RateLimit",
  public."SavedView", public."CustomerHistory", public."BranchHistory", public."AttachmentHistory", public."UserHistory",
  public."RouteHistory", public."RouteOwnerHistory", public."RegionHistory",
  public."CodeSequence", public."CronRun",
  public."User", public."PasswordHistory", public."Region", public."Route", public."_ManagerRegions",
  public."Channel", public."SubChannel"
  IN SHARE MODE;

\ir guards.sql

\set fp_prefix before
\ir fingerprint.sql

-- CS013: the state under the locks is exactly the state the PLAN job saw.
DO $cs$
BEGIN
  IF current_setting('cs.before_plan_id', true) IS DISTINCT FROM current_setting('cs.plan_expected') THEN
    RAISE EXCEPTION 'clean-start: the database no longer matches the plan' USING ERRCODE = 'CS013';
  END IF;
END
$cs$;

CREATE TEMP TABLE cs_before ON COMMIT DROP AS
SELECT 'table'::text AS kind, c.relname::text AS name,
       (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, false, '')))[1]::text::bigint AS n
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
UNION ALL
SELECT 'sequence'::text, s.sequencename::text, COALESCE(s.last_value, 0)
  FROM pg_catalog.pg_sequences s
 WHERE s.schemaname = 'public';

CREATE TEMP TABLE cs_chain ON COMMIT DROP AS
SELECT jsonb_build_object(
         'chain', (SELECT left(g."hash", 16) FROM public."SealRecord" g WHERE g."seq" = 0),
         'lastSeq', l."seq",
         'lastDay', l."day",
         'lastHash', l."hash") AS info
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (SELECT s."seq", s."day", s."hash" FROM public."SealRecord" s ORDER BY s."seq" DESC LIMIT 1) l ON true;

TRUNCATE TABLE
  public."Customer", public."Branch", public."Attachment", public."CustomerEdit", public."EditCustomerDraft",
  public."EditBranchDraft", public."EditApproval", public."EditRevision", public."Notification", public."ImportBatch",
  public."ImportRow", public."TemixSyncBatch", public."ExportJob", public."AuditLog", public."AuthEvent",
  public."JobRunDay", public."PurgeSummary", public."IntegrityCheckResult", public."SealRecord", public."RateLimit",
  public."SavedView", public."CustomerHistory", public."BranchHistory", public."AttachmentHistory", public."UserHistory",
  public."RouteHistory", public."RouteOwnerHistory", public."RegionHistory"
  CONTINUE IDENTITY RESTRICT;

DELETE FROM public."CodeSequence" WHERE "scope" ~ '^CUSTOMER-[0-9]{4}$';

DELETE FROM public."CronRun" WHERE "at" < (((now() AT TIME ZONE 'Asia/Muscat')::date - 1)::timestamp AT TIME ZONE 'Asia/Muscat' AT TIME ZONE 'UTC');

INSERT INTO public."AuditLog" ("id", "actorId", "action", "entityType", "entityId", "reason", "after")
VALUES ('cleanstart-' || :'run_id', current_setting('nmwc.actor'), 'DELETE', 'System', 'clean-start',
        'Go-live clean start (owner decision): test-period customer data, requests, imports, exports, notifications, logs and history removed; accounts, routes and regions kept; seal chain restarted.',
        jsonb_build_object(
          'runId', :'run_id',
          'commit', :'commit',
          'planId', :'plan_id',
          'backup', jsonb_build_object('key', :'backup_key', 'sha256', :'backup_sha256'),
          'photoKeysSha256', current_setting('cs.before_photo_keys_sha256'),
          'sealsSha256', current_setting('cs.before_seals_sha256'),
          'oldChain', (SELECT x.info FROM cs_chain x),
          'sealArchivePrefix', :'archive_prefix',
          'safetyBranch', :'safety_branch',
          'removed', (SELECT jsonb_object_agg(b.name,
                               CASE b.name WHEN 'CodeSequence' THEN b.n - (SELECT count(*) FROM public."CodeSequence")
                                           WHEN 'CronRun' THEN b.n - (SELECT count(*) FROM public."CronRun")
                                           ELSE b.n END ORDER BY b.name)
                        FROM cs_before b
                       WHERE b.kind = 'table' AND b.name NOT IN ('User', 'PasswordHistory', 'Region', 'Route', '_ManagerRegions', 'Channel', 'SubChannel', 'CronHeartbeat')),
          'kept', (SELECT jsonb_object_agg(b.name,
                            CASE b.name WHEN 'CodeSequence' THEN (SELECT count(*) FROM public."CodeSequence")
                                        WHEN 'CronRun' THEN (SELECT count(*) FROM public."CronRun")
                                        ELSE b.n END ORDER BY b.name)
                     FROM cs_before b
                    WHERE b.kind = 'table' AND b.name IN ('User', 'PasswordHistory', 'Region', 'Route', '_ManagerRegions', 'Channel', 'SubChannel', 'CronHeartbeat', 'CodeSequence', 'CronRun'))
        ));

-- BEGIN BASELINE (prisma/migrations/20261013100100_history_foundation lines 295-335, with
-- only actorId, source and sourceKind substituted; tests/unit/clean-start-sql.test.ts)
INSERT INTO "RegionHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "regionId", "code", "name", "isActive")
SELECT 'BASELINE', '{}', r."createdAt", now() AT TIME ZONE 'UTC', NULL, current_setting('nmwc.actor'), current_setting('nmwc.source'), 'script', txid_current(), session_user,
  r."id", r."code", r."name", r."isActive"
FROM "Region" r
ORDER BY r."createdAt", r."id";

INSERT INTO "RouteHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "routeId", "code", "name", "regionId", "isActive")
SELECT 'BASELINE', '{}', r."createdAt", now() AT TIME ZONE 'UTC', NULL, current_setting('nmwc.actor'), current_setting('nmwc.source'), 'script', txid_current(), session_user,
  r."id", r."code", r."name", r."regionId", r."isActive"
FROM "Route" r
ORDER BY r."createdAt", r."id";

INSERT INTO "UserHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "userId", "username", "role", "isActive", "supervisorId", "ownedRouteId", "regionIds")
SELECT 'BASELINE', '{}', u."createdAt", now() AT TIME ZONE 'UTC', NULL, current_setting('nmwc.actor'), current_setting('nmwc.source'), 'script', txid_current(), session_user,
  u."id", u."username", u."role", u."isActive", u."supervisorId", u."ownedRouteId",
  COALESCE((SELECT array_agg(mr."A" ORDER BY mr."A") FROM "_ManagerRegions" mr WHERE mr."B" = u."id"), '{}')
FROM "User" u
ORDER BY u."createdAt", u."id";

-- Who held each route. A route whose holder's account was created after the
-- route gets two rows: nobody from the route's creation, then the holder from
-- his account's creation (an account cannot have held a route before it existed).
INSERT INTO "RouteOwnerHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "routeId", "ownerId")
SELECT 'BASELINE', '{}', p.valid_from, now() AT TIME ZONE 'UTC', NULL, current_setting('nmwc.actor'), current_setting('nmwc.source'), 'script', txid_current(), session_user,
  p.route_id, p.owner_id
FROM (
  SELECT r."id" AS route_id, r."createdAt" AS valid_from,
         CASE WHEN o."id" IS NOT NULL AND o."createdAt" <= r."createdAt" THEN o."id" END AS owner_id
  FROM "Route" r
  LEFT JOIN "User" o ON o."ownedRouteId" = r."id"
  UNION ALL
  SELECT r."id", o."createdAt", o."id"
  FROM "Route" r
  JOIN "User" o ON o."ownedRouteId" = r."id"
  WHERE o."createdAt" > r."createdAt"
) p
ORDER BY p.valid_from, p.route_id;
-- END BASELINE

\ir selfcheck.sql

COMMIT;

\echo 'clean-start: reset committed'
