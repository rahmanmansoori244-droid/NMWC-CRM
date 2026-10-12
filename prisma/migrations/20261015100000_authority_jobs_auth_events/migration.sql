-- Part C of the history foundation (data audit 2026-10-10, gaps 11, 21 and 23;
-- docs/HISTORY.md section 10). Builds on 20261013100100_history_foundation and
-- 20261014100000_lossless_paths.
--
--   1. EditApproval says WHO decided and WHY he could (gap 11): beside the step's
--      role, the decider's own role, the basis lib/permissions.ts stepAuthority
--      found (SUPERVISOR_OF_SUBMITTER, REGION_MANAGER, REGION_OVERLAP, GLOBAL, or
--      SUBMITTER for the salesman's signed-application upload), the regions the
--      request covered and the submitter's route, all as they were at that
--      moment. Nullable columns on an append-only table: no rewrite, no trigger
--      involved, and rows written before this migration stay NULL ("not
--      recorded then"), never back-filled with a guess.
--   2. JobRunDay (gap 21): one row per scheduled job per Oman day, kept for ever.
--      CronRun keeps 90 days; the retention sweep writes each complete day here
--      and, from now on, prunes only the runs of a day that has its row. Filled
--      here from the CronRun rows that exist.
--   3. AuthEvent (gap 23): failed sign-ins with names no account has, refusals by
--      the sign-in throttles, a failure on a retired route sign-in name, and
--      every session cut-off. The typed name is never stored, only a keyed
--      fingerprint (lib/username-fingerprint.ts). The cut-offs are written by the
--      DATABASE (user_session_revoke_capture) whenever User.sessionsRevokedAt
--      moves, with the change context's actor and source, so sign-out, disable,
--      password reset, role or route change and an account-import row are all
--      recorded and none can be skipped. A cut-off with no recorded cause is in
--      the 'sql' report like a history row (section 5), with its login (dbUser).
--
-- Everything is additive: two tables, four nullable columns, one new function
-- and part B's report replaced, six triggers, CHECK constraints on the new
-- columns only. No existing value changes.
--
-- COST: catalog-only ALTER on EditApproval (no rewrite; the CHECK scans a table of
-- a few thousand rows), one new trigger on "User", and a GROUP BY over CronRun
-- (at most 90 days of runs). Well under a second; locks are brief.

SET lock_timeout = '10s';

-- ── 1. Columns and tables (Prisma's own DDL, so the CI drift gate matches) ──

ALTER TABLE "EditApproval" ADD COLUMN     "actorRole" "Role",
ADD COLUMN     "authorityBasis" TEXT,
ADD COLUMN     "scopeRegionIds" TEXT[],
ADD COLUMN     "submitterRouteId" TEXT;

CREATE TABLE "JobRunDay" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "runs" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "maxDurationMs" INTEGER NOT NULL,
    "sources" TEXT[],
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRunDay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthEvent" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "usernameHmac" TEXT,
    "keyId" TEXT,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "actorId" TEXT,
    "source" TEXT,
    "txId" BIGINT,
    "dbUser" TEXT,

    CONSTRAINT "AuthEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobRunDay_key_day_key" ON "JobRunDay"("key", "day");
CREATE INDEX "AuthEvent_at_idx" ON "AuthEvent"("at" DESC);
CREATE INDEX "AuthEvent_userId_at_idx" ON "AuthEvent"("userId", "at" DESC);
CREATE INDEX "AuthEvent_usernameHmac_at_idx" ON "AuthEvent"("usernameHmac", "at" DESC);
CREATE INDEX "AuthEvent_kind_at_idx" ON "AuthEvent"("kind", "at" DESC);
-- The 'sql' report reads only the session cut-offs written with no cause (part
-- A's convention: a partial index, which Prisma does not model and ignores).
CREATE INDEX "AuthEvent_unattributed_idx" ON "AuthEvent"("at") WHERE "kind" = 'SESSION_REVOKE' AND "source" = 'sql';

-- The evidence says only what the code can say. A value outside these lists is a
-- bug in the writer, refused loudly rather than kept for ever. (Prisma does not
-- model CHECK constraints and ignores them, as it does Branch_gpsLat_range.)
ALTER TABLE "EditApproval" ADD CONSTRAINT "EditApproval_authorityBasis_check"
  CHECK ("authorityBasis" IS NULL OR "authorityBasis" IN ('SUPERVISOR_OF_SUBMITTER', 'REGION_MANAGER', 'REGION_OVERLAP', 'GLOBAL', 'SUBMITTER'));
ALTER TABLE "AuthEvent" ADD CONSTRAINT "AuthEvent_kind_check"
  CHECK ("kind" IN ('LOGIN_FAIL_UNKNOWN', 'LOGIN_RATE_LIMITED', 'LOGIN_FAIL_REUSED_NAME', 'SESSION_REVOKE'));

-- ── 2. The scheduled jobs' days (gap 21) ───────────────────────────────────
--
-- One row per job and Oman day the runs STARTED on, for every day that is over
-- (ended more than an hour ago, so a run that started just before midnight has
-- recorded itself). Nothing has been pruned yet anywhere (CronRun started on
-- 2026-09-27 and keeps 90 days), but if this runs on a database whose oldest run
-- is near the 90-day line, the oldest day may already be cut short by a prune and
-- is left out rather than summarised wrongly: a JobRunDay row is never corrected.

INSERT INTO "JobRunDay" ("key", "day", "runs", "failures", "firstAt", "lastAt", "maxDurationMs", "sources")
SELECT c."key",
       d.day,
       count(*)::int,
       (count(*) FILTER (WHERE NOT c."ok"))::int,
       min(c."at"),
       max(c."at"),
       max(c."durationMs"),
       COALESCE(array_agg(DISTINCT c."source" ORDER BY c."source") FILTER (WHERE c."source" IS NOT NULL), '{}')
  FROM "CronRun" c
  CROSS JOIN LATERAL (SELECT ((c."at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date AS day) d
 WHERE d.day < ((now() - interval '1 hour') AT TIME ZONE 'Asia/Muscat')::date
   AND NOT EXISTS (
         SELECT 1
           FROM (SELECT min(o."at") AS first_at FROM "CronRun" o) f
          WHERE f.first_at < (now() AT TIME ZONE 'UTC') - interval '89 days'
            AND d.day <= ((f.first_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date)
 GROUP BY c."key", d.day
ON CONFLICT ("key", "day") DO NOTHING;

-- ── 3. Session cut-offs, written by the database (gap 23) ─────────────────
--
-- Every write that ends a user's sessions bumps User.sessionsRevokedAt (AUTH-12):
-- sign-out, disable, password change or reset, role change, a route or username
-- change by the account import. This records each one, with the cause the writer
-- named (nmwc.actor / nmwc.source; 'sql' when it named none) and what moved with
-- it. As the history's capture functions: definer rights (the runtime role needs
-- no privilege beyond its INSERT), a pinned search_path, EXECUTE revoked from
-- PUBLIC, and it refuses to run on any table but "User".

CREATE OR REPLACE FUNCTION nmwc_user_session_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ctx record;
  why text[] := '{}';
BEGIN
  IF TG_RELID <> 'public."User"'::regclass THEN
    RAISE EXCEPTION 'nmwc_user_session_revoke() runs only on "User"';
  END IF;
  IF OLD."isActive" AND NOT NEW."isActive" THEN why := why || 'deactivated'::text; END IF;
  IF NOT OLD."isActive" AND NEW."isActive" THEN why := why || 'reactivated'::text; END IF;
  IF OLD."passwordHash" IS DISTINCT FROM NEW."passwordHash" THEN why := why || 'password'::text; END IF;
  IF OLD."role" IS DISTINCT FROM NEW."role" THEN why := why || 'role'::text; END IF;
  IF OLD."ownedRouteId" IS DISTINCT FROM NEW."ownedRouteId" THEN why := why || 'route'::text; END IF;
  IF OLD."username" IS DISTINCT FROM NEW."username" THEN why := why || 'username'::text; END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  INSERT INTO public."AuthEvent" ("at", "kind", "userId", "reason", "actorId", "source", "txId", "dbUser")
  VALUES (ctx.recorded_at, 'SESSION_REVOKE', NEW."id", NULLIF(array_to_string(why, ','), ''),
          ctx.actor_id, ctx.source, ctx.tx_id, ctx.db_user);
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_user_session_revoke() FROM PUBLIC;

CREATE TRIGGER user_session_revoke_capture
  AFTER UPDATE OF "sessionsRevokedAt" ON "User"
  FOR EACH ROW
  WHEN (NEW."sessionsRevokedAt" IS DISTINCT FROM OLD."sessionsRevokedAt" AND NEW."sessionsRevokedAt" IS NOT NULL)
  EXECUTE FUNCTION nmwc_user_session_revoke();

-- A row the application inserts (a failed sign-in) carries the cause and the
-- transaction like an AuditLog row: the same stamp function, which only reads
-- the writer's settings.
CREATE TRIGGER authevent_stamp_context
  BEFORE INSERT ON "AuthEvent"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- ── 4. Both are ledgers: insert, never change ──────────────────────────────

CREATE TRIGGER jobrunday_append_only BEFORE UPDATE OR DELETE ON "JobRunDay" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER jobrunday_no_truncate BEFORE TRUNCATE ON "JobRunDay" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER authevent_append_only BEFORE UPDATE OR DELETE ON "AuthEvent" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER authevent_no_truncate BEFORE TRUNCATE ON "AuthEvent" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- The runtime role, where it exists (scripts/ops/app-role.ts `grant` re-applies
-- the same after its blanket GRANT): insert and read, never update or delete;
-- the id sequences usable (nextval on insert) but not settable (setval).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "JobRunDay", "AuthEvent" FROM nmwc_app;
    REVOKE UPDATE ON SEQUENCE "JobRunDay_id_seq", "AuthEvent_id_seq" FROM nmwc_app;
  END IF;
END;
$$;

-- ── 5. The 'sql' report covers session cut-offs too (gap 24) ─────────────
--
-- A cut-off written with no change context is recorded under source 'sql', like
-- a history row, and is reported the same way (/status, /api/health,
-- scripts/ops/history-report.ts): by table, Oman day and login. Part B's report
-- with one more branch.

CREATE OR REPLACE FUNCTION nmwc_history_unattributed(p_since timestamp)
RETURNS TABLE (table_name text, day date, db_user text, n bigint, sample_ids bigint[])
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.table_name,
         ((u.recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date,
         u.db_user,
         count(*),
         (array_agg(u.id ORDER BY u.id))[1:5]
  FROM (
    SELECT 'CustomerHistory'::text AS table_name, h."id" AS id, h."recordedAt" AS recorded_at, h."dbUser" AS db_user
      FROM public."CustomerHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'BranchHistory', h."id", h."recordedAt", h."dbUser"
      FROM public."BranchHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'UserHistory', h."id", h."recordedAt", h."dbUser"
      FROM public."UserHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'RouteOwnerHistory', h."id", h."recordedAt", h."dbUser"
      FROM public."RouteOwnerHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'RouteHistory', h."id", h."recordedAt", h."dbUser"
      FROM public."RouteHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'RegionHistory', h."id", h."recordedAt", h."dbUser"
      FROM public."RegionHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'AttachmentHistory', h."id", h."recordedAt", h."dbUser"
      FROM public."AttachmentHistory" h WHERE h."sourceKind" = 'sql' AND h."recordedAt" >= p_since
    UNION ALL
    SELECT 'AuthEvent', e."id", e."at", COALESCE(e."dbUser", '?')
      FROM public."AuthEvent" e WHERE e."kind" = 'SESSION_REVOKE' AND e."source" = 'sql' AND e."at" >= p_since
  ) u
  GROUP BY 1, 2, 3
  ORDER BY 2 DESC, 1, 3
$$;

RESET lock_timeout;
