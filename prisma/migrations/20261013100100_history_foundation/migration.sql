-- History foundation (data audit 2026-10-10, gaps 5, 6, 17 and 24; docs/HISTORY.md).
--
-- The owner wants a "mini ERP": every change to a customer, shop, user, route or
-- region kept, dated, and never rewritten, so that "which routes served this
-- customer, from when to when", "when was it created" and "what were its terms on
-- date D" have recorded answers. Until now each of these was kept only as its
-- current value.
--
-- WHAT THIS DOES
--   1. Six INSERT-only history tables (CustomerHistory, BranchHistory,
--      UserHistory, RouteOwnerHistory, RouteHistory, RegionHistory), modelled in
--      schema.prisma without relations.
--   2. A first page for every record that exists now (gap 5): one BASELINE row
--      each, valid from the record's createdAt and marked inferred for any time
--      before this migration ran. Written HERE, under the same locks as the
--      triggers are created, so no change can fall between the baseline and the
--      first trigger row. Earlier history is not replayed: the owner said
--      effective dates matter from now on, not for the past.
--   3. Capture triggers, written by the database itself: AFTER INSERT / DELETE
--      on each master table, and AFTER UPDATE only WHEN a watched column really
--      changed. An update that touches only updatedAt, version, the score,
--      lastEditedById, lastLoginAt, sessionsRevokedAt or passwordHash writes
--      nothing. A change to _ManagerRegions is captured once, at commit, as the
--      user's final region set (a deferred constraint trigger).
--   4. Who and why (gap 24): each row carries nmwc.actor and nmwc.source as the
--      writer set them (lib/change-context.ts), the transaction id (joins to the
--      new AuditLog.txId) and the login role. A change made with no context is
--      still recorded, under source 'sql', and reported (nmwc_history_unattributed,
--      the /status card, /api/health).
--   5. An effective time separate from the recorded time (gap 17): validFrom is
--      nmwc.effective_from when the writer passed one (the daily Temix file will
--      pass its load day), otherwise the transaction's time; recordedAt is the
--      wall clock; effectiveRequested keeps what was asked. validFrom never goes
--      below the same record's previous validFrom, so each chain stays ordered.
--   6. Protection like AuditLog's: UPDATE, DELETE and TRUNCATE refused by
--      nmwc_forbid_audit_mutation() (only the owner session in the maintenance
--      window gets through), and a direct INSERT refused too, so the history
--      cannot be forged even while production still connects as the owner
--      (AUDITOR-BRIEF section 8). The runtime role loses INSERT/UPDATE on the
--      tables and every privilege on their sequences.
--   7. As-of, interval and report functions (SQL, STABLE, SECURITY INVOKER).
--
-- PERSONAL DATA (PDPL-ASSESSMENT Q4): the history stores values only for
-- non-personal business columns. Names, phones, CR number, contact, e-mail,
-- notes, address and GPS appear only as a field NAME in changedFields, so no
-- personal value is copied into a ledger that can never be erased.
--
-- COST: about 31k baseline rows on production (14,190 customers, 16,218 shops,
-- users, 45 routes, 9 regions), 1 to 3 s on Neon. Writes to the five master
-- tables wait for the whole migration (SHARE ROW EXCLUSIVE). lock_timeout makes
-- a busy table fail the deploy fast and retryably instead of queueing behind it.
-- Deploy outside working hours.
--
-- Everything here is additive: new tables, columns, functions, triggers and
-- indexes. No existing row is changed.

SET lock_timeout = '10s';
LOCK TABLE "Customer", "Branch", "User", "Route", "Region", "_ManagerRegions" IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. Tables (Prisma's own DDL, so the CI drift gate matches) ──────────────

CREATE TYPE "HistoryChange" AS ENUM ('BASELINE', 'CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "CustomerHistory" (
    "id" BIGSERIAL NOT NULL,
    "changeKind" "HistoryChange" NOT NULL,
    "changedFields" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "effectiveRequested" TIMESTAMP(3),
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "txId" BIGINT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "nmwcCode" TEXT NOT NULL,
    "paymentTerms" "PaymentTerms" NOT NULL,
    "creditLimit" DECIMAL(14,3),
    "paymentTermDays" INTEGER,
    "temixCode" TEXT,
    "status" "CustomerStatus" NOT NULL,
    "channelId" TEXT,
    "subChannelId" TEXT,
    "crPhotoId" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CustomerHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BranchHistory" (
    "id" BIGSERIAL NOT NULL,
    "changeKind" "HistoryChange" NOT NULL,
    "changedFields" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "effectiveRequested" TIMESTAMP(3),
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "txId" BIGINT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "dayOfVisit" "DayOfWeek",
    "status" "CustomerStatus" NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "coolersCount" INTEGER NOT NULL,
    "standsCount" INTEGER NOT NULL,
    "emptyBottlesCount" INTEGER NOT NULL,
    "equipmentConfirmed" BOOLEAN NOT NULL,
    "hasGps" BOOLEAN NOT NULL,
    "shopPhotoId" TEXT,
    "signboardPhotoId" TEXT,

    CONSTRAINT "BranchHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserHistory" (
    "id" BIGSERIAL NOT NULL,
    "changeKind" "HistoryChange" NOT NULL,
    "changedFields" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "effectiveRequested" TIMESTAMP(3),
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "txId" BIGINT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "supervisorId" TEXT,
    "ownedRouteId" TEXT,
    "regionIds" TEXT[],

    CONSTRAINT "UserHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RouteOwnerHistory" (
    "id" BIGSERIAL NOT NULL,
    "changeKind" "HistoryChange" NOT NULL,
    "changedFields" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "effectiveRequested" TIMESTAMP(3),
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "txId" BIGINT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "ownerId" TEXT,

    CONSTRAINT "RouteOwnerHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RouteHistory" (
    "id" BIGSERIAL NOT NULL,
    "changeKind" "HistoryChange" NOT NULL,
    "changedFields" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "effectiveRequested" TIMESTAMP(3),
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "txId" BIGINT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,

    CONSTRAINT "RouteHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegionHistory" (
    "id" BIGSERIAL NOT NULL,
    "changeKind" "HistoryChange" NOT NULL,
    "changedFields" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "effectiveRequested" TIMESTAMP(3),
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "txId" BIGINT NOT NULL,
    "dbUser" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,

    CONSTRAINT "RegionHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerHistory_customerId_validFrom_id_idx" ON "CustomerHistory"("customerId", "validFrom" DESC, "id" DESC);
CREATE INDEX "CustomerHistory_txId_idx" ON "CustomerHistory"("txId");
CREATE INDEX "BranchHistory_branchId_validFrom_id_idx" ON "BranchHistory"("branchId", "validFrom" DESC, "id" DESC);
CREATE INDEX "BranchHistory_customerId_validFrom_idx" ON "BranchHistory"("customerId", "validFrom");
CREATE INDEX "BranchHistory_routeId_validFrom_idx" ON "BranchHistory"("routeId", "validFrom");
CREATE INDEX "BranchHistory_txId_idx" ON "BranchHistory"("txId");
CREATE INDEX "UserHistory_userId_validFrom_id_idx" ON "UserHistory"("userId", "validFrom" DESC, "id" DESC);
CREATE INDEX "UserHistory_username_idx" ON "UserHistory"("username");
CREATE INDEX "UserHistory_txId_idx" ON "UserHistory"("txId");
CREATE INDEX "RouteOwnerHistory_routeId_validFrom_id_idx" ON "RouteOwnerHistory"("routeId", "validFrom" DESC, "id" DESC);
CREATE INDEX "RouteOwnerHistory_ownerId_validFrom_idx" ON "RouteOwnerHistory"("ownerId", "validFrom");
CREATE INDEX "RouteOwnerHistory_txId_idx" ON "RouteOwnerHistory"("txId");
CREATE INDEX "RouteHistory_routeId_validFrom_id_idx" ON "RouteHistory"("routeId", "validFrom" DESC, "id" DESC);
CREATE INDEX "RouteHistory_txId_idx" ON "RouteHistory"("txId");
CREATE INDEX "RegionHistory_regionId_validFrom_id_idx" ON "RegionHistory"("regionId", "validFrom" DESC, "id" DESC);
CREATE INDEX "RegionHistory_txId_idx" ON "RegionHistory"("txId");

-- The 'sql' report reads only the rows written with no context: partial indexes
-- keep it cheap however large the history grows. Prisma ignores partial indexes
-- (Customer_crNumberNorm_idx passes the drift gate the same way).
CREATE INDEX "CustomerHistory_unattributed_idx" ON "CustomerHistory"("recordedAt") WHERE "sourceKind" = 'sql';
CREATE INDEX "BranchHistory_unattributed_idx" ON "BranchHistory"("recordedAt") WHERE "sourceKind" = 'sql';
CREATE INDEX "UserHistory_unattributed_idx" ON "UserHistory"("recordedAt") WHERE "sourceKind" = 'sql';
CREATE INDEX "RouteOwnerHistory_unattributed_idx" ON "RouteOwnerHistory"("recordedAt") WHERE "sourceKind" = 'sql';
CREATE INDEX "RouteHistory_unattributed_idx" ON "RouteHistory"("recordedAt") WHERE "sourceKind" = 'sql';
CREATE INDEX "RegionHistory_unattributed_idx" ON "RegionHistory"("recordedAt") WHERE "sourceKind" = 'sql';

-- ── 2. AuditLog: the cause and the transaction of every audit row ───────────

ALTER TABLE "AuditLog" ADD COLUMN "source" TEXT,
ADD COLUMN "txId" BIGINT;

CREATE INDEX "AuditLog_txId_idx" ON "AuditLog"("txId");

-- ── 3. The change context the writer set (lib/change-context.ts) ───────────
--
-- One row: who (nmwc.actor), why (nmwc.source, 'sql' when nothing was set),
-- the part of the source before its first ':' (the kind the report groups by),
-- the effective time asked for, the validFrom it gives (before the per-record
-- clamp), the wall-clock recordedAt, the transaction and the login role.
-- Times are converted to UTC explicitly, so a psql session set to Asia/Muscat
-- cannot store local times in these TIMESTAMP columns. An effective time more
-- than five minutes ahead is refused loudly: history may not be written ahead.

CREATE OR REPLACE FUNCTION nmwc_change_ctx(
  OUT actor_id text,
  OUT source text,
  OUT source_kind text,
  OUT effective_requested timestamp,
  OUT valid_from timestamp,
  OUT recorded_at timestamp,
  OUT tx_id bigint,
  OUT db_user text
) LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  raw text;
BEGIN
  actor_id := NULLIF(current_setting('nmwc.actor', true), '');
  source := left(COALESCE(NULLIF(current_setting('nmwc.source', true), ''), 'sql'), 200);
  source_kind := split_part(source, ':', 1);
  raw := NULLIF(current_setting('nmwc.effective_from', true), '');
  IF raw IS NULL THEN
    effective_requested := NULL;
  ELSIF raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    -- A calendar day is the start of that day in Oman (Asia/Muscat).
    effective_requested := (raw::date::timestamp AT TIME ZONE 'Asia/Muscat') AT TIME ZONE 'UTC';
  ELSE
    effective_requested := raw::timestamptz AT TIME ZONE 'UTC';
  END IF;
  IF effective_requested > (clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'nmwc.effective_from (%) is in the future: history may not be written ahead of time', raw
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  valid_from := COALESCE(effective_requested, now() AT TIME ZONE 'UTC');
  recorded_at := clock_timestamp() AT TIME ZONE 'UTC';
  tx_id := txid_current();
  db_user := session_user;
END;
$$;

-- ── 4. The first page: one BASELINE row per existing record (gap 5) ─────────
--
-- validFrom = the record's createdAt, recordedAt = now (this transaction's start,
-- the same for every baseline row). Any answer for a time before recordedAt that
-- rests on a BASELINE row is reported as inferred: it says what the record was
-- when history began, not what it was then. Soft-deleted records are included.

INSERT INTO "RegionHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "regionId", "code", "name", "isActive")
SELECT 'BASELINE', '{}', r."createdAt", now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261013100100_history_foundation', 'migration', txid_current(), session_user,
  r."id", r."code", r."name", r."isActive"
FROM "Region" r
ORDER BY r."createdAt", r."id";

INSERT INTO "RouteHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "routeId", "code", "name", "regionId", "isActive")
SELECT 'BASELINE', '{}', r."createdAt", now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261013100100_history_foundation', 'migration', txid_current(), session_user,
  r."id", r."code", r."name", r."regionId", r."isActive"
FROM "Route" r
ORDER BY r."createdAt", r."id";

INSERT INTO "UserHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "userId", "username", "role", "isActive", "supervisorId", "ownedRouteId", "regionIds")
SELECT 'BASELINE', '{}', u."createdAt", now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261013100100_history_foundation', 'migration', txid_current(), session_user,
  u."id", u."username", u."role", u."isActive", u."supervisorId", u."ownedRouteId",
  COALESCE((SELECT array_agg(mr."A" ORDER BY mr."A") FROM "_ManagerRegions" mr WHERE mr."B" = u."id"), '{}')
FROM "User" u
ORDER BY u."createdAt", u."id";

-- Who held each route. A route whose holder's account was created after the
-- route gets two rows: nobody from the route's creation, then the holder from
-- his account's creation (an account cannot have held a route before it existed).
INSERT INTO "RouteOwnerHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "routeId", "ownerId")
SELECT 'BASELINE', '{}', p.valid_from, now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261013100100_history_foundation', 'migration', txid_current(), session_user,
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

INSERT INTO "CustomerHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "customerId", "nmwcCode", "paymentTerms", "creditLimit", "paymentTermDays", "temixCode", "status", "channelId", "subChannelId", "crPhotoId", "deletedAt")
SELECT 'BASELINE', '{}', c."createdAt", now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261013100100_history_foundation', 'migration', txid_current(), session_user,
  c."id", c."nmwcCode", c."paymentTerms", c."creditLimit", c."paymentTermDays", c."temixCode", c."status", c."channelId", c."subChannelId", c."crPhotoId", c."deletedAt"
FROM "Customer" c
ORDER BY c."createdAt", c."id";

INSERT INTO "BranchHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "branchId", "branchCode", "customerId", "routeId", "regionId", "dayOfVisit", "status", "deletedAt",
  "coolersCount", "standsCount", "emptyBottlesCount", "equipmentConfirmed", "hasGps", "shopPhotoId", "signboardPhotoId")
SELECT 'BASELINE', '{}', b."createdAt", now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261013100100_history_foundation', 'migration', txid_current(), session_user,
  b."id", b."branchCode", b."customerId", b."routeId", b."regionId", b."dayOfVisit", b."status", b."deletedAt",
  b."coolersCount", b."standsCount", b."emptyBottlesCount", b."equipmentConfirmed", (b."gpsLat" IS NOT NULL AND b."gpsLng" IS NOT NULL),
  b."shopPhotoId", b."signboardPhotoId"
FROM "Branch" b
ORDER BY b."createdAt", b."id";

-- ── 5. Capture functions and triggers ──────────────────────────────────────
--
-- SECURITY DEFINER (owned by the migration role) so the runtime role can write
-- the master tables without any privilege on the history tables; search_path
-- pinned and every name schema-qualified (20260915120000_trigger_search_path
-- explains why); EXECUTE revoked from PUBLIC so no other role can attach them
-- to a table of its own; and each refuses to run on any table but its own.
-- Each returns NULL (AFTER trigger). The previous validFrom of the same record
-- is read through the (key, validFrom DESC, id DESC) index; the row lock the
-- master write holds serialises that read per record.

CREATE OR REPLACE FUNCTION nmwc_history_customer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."Customer"%ROWTYPE;
  o public."Customer"%ROWTYPE;
  k public."HistoryChange";
  f text[] := '{}';
  ctx record;
  prev timestamp;
BEGIN
  IF TG_RELID <> 'public."Customer"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_customer() runs only on "Customer"';
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW; k := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    r := OLD; k := 'DELETE';
  ELSE
    r := NEW; o := OLD; k := 'UPDATE';
    IF o."nmwcCode" IS DISTINCT FROM r."nmwcCode" THEN f := f || 'nmwcCode'::text; END IF;
    IF o."paymentTerms" IS DISTINCT FROM r."paymentTerms" THEN f := f || 'paymentTerms'::text; END IF;
    IF o."creditLimit" IS DISTINCT FROM r."creditLimit" THEN f := f || 'creditLimit'::text; END IF;
    IF o."paymentTermDays" IS DISTINCT FROM r."paymentTermDays" THEN f := f || 'paymentTermDays'::text; END IF;
    IF o."temixCode" IS DISTINCT FROM r."temixCode" THEN f := f || 'temixCode'::text; END IF;
    IF o."status" IS DISTINCT FROM r."status" THEN f := f || 'status'::text; END IF;
    IF o."channelId" IS DISTINCT FROM r."channelId" THEN f := f || 'channelId'::text; END IF;
    IF o."subChannelId" IS DISTINCT FROM r."subChannelId" THEN f := f || 'subChannelId'::text; END IF;
    IF o."crPhotoId" IS DISTINCT FROM r."crPhotoId" THEN f := f || 'crPhotoId'::text; END IF;
    IF o."deletedAt" IS DISTINCT FROM r."deletedAt" THEN f := f || 'deletedAt'::text; END IF;
    -- Personal values: the field name only.
    IF o."legalName" IS DISTINCT FROM r."legalName" THEN f := f || 'legalName'::text; END IF;
    IF o."crNumber" IS DISTINCT FROM r."crNumber" THEN f := f || 'crNumber'::text; END IF;
    IF o."primaryPhone" IS DISTINCT FROM r."primaryPhone" THEN f := f || 'primaryPhone'::text; END IF;
    IF o."altPhone" IS DISTINCT FROM r."altPhone" THEN f := f || 'altPhone'::text; END IF;
    IF o."contactPerson" IS DISTINCT FROM r."contactPerson" THEN f := f || 'contactPerson'::text; END IF;
    IF o."contactRole" IS DISTINCT FROM r."contactRole" THEN f := f || 'contactRole'::text; END IF;
    IF o."email" IS DISTINCT FROM r."email" THEN f := f || 'email'::text; END IF;
    IF o."notes" IS DISTINCT FROM r."notes" THEN f := f || 'notes'::text; END IF;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  SELECT h."validFrom" INTO prev FROM public."CustomerHistory" h
   WHERE h."customerId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  INSERT INTO public."CustomerHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "customerId", "nmwcCode", "paymentTerms", "creditLimit", "paymentTermDays", "temixCode", "status", "channelId", "subChannelId", "crPhotoId", "deletedAt")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."nmwcCode", r."paymentTerms", r."creditLimit", r."paymentTermDays", r."temixCode", r."status", r."channelId", r."subChannelId", r."crPhotoId", r."deletedAt");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nmwc_history_branch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."Branch"%ROWTYPE;
  o public."Branch"%ROWTYPE;
  k public."HistoryChange";
  f text[] := '{}';
  ctx record;
  prev timestamp;
BEGIN
  IF TG_RELID <> 'public."Branch"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_branch() runs only on "Branch"';
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW; k := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    r := OLD; k := 'DELETE';
  ELSE
    r := NEW; o := OLD; k := 'UPDATE';
    IF o."branchCode" IS DISTINCT FROM r."branchCode" THEN f := f || 'branchCode'::text; END IF;
    IF o."customerId" IS DISTINCT FROM r."customerId" THEN f := f || 'customerId'::text; END IF;
    IF o."routeId" IS DISTINCT FROM r."routeId" THEN f := f || 'routeId'::text; END IF;
    IF o."regionId" IS DISTINCT FROM r."regionId" THEN f := f || 'regionId'::text; END IF;
    IF o."dayOfVisit" IS DISTINCT FROM r."dayOfVisit" THEN f := f || 'dayOfVisit'::text; END IF;
    IF o."status" IS DISTINCT FROM r."status" THEN f := f || 'status'::text; END IF;
    IF o."deletedAt" IS DISTINCT FROM r."deletedAt" THEN f := f || 'deletedAt'::text; END IF;
    IF o."coolersCount" IS DISTINCT FROM r."coolersCount" THEN f := f || 'coolersCount'::text; END IF;
    IF o."standsCount" IS DISTINCT FROM r."standsCount" THEN f := f || 'standsCount'::text; END IF;
    IF o."emptyBottlesCount" IS DISTINCT FROM r."emptyBottlesCount" THEN f := f || 'emptyBottlesCount'::text; END IF;
    IF o."equipmentConfirmed" IS DISTINCT FROM r."equipmentConfirmed" THEN f := f || 'equipmentConfirmed'::text; END IF;
    IF o."shopPhotoId" IS DISTINCT FROM r."shopPhotoId" THEN f := f || 'shopPhotoId'::text; END IF;
    IF o."signboardPhotoId" IS DISTINCT FROM r."signboardPhotoId" THEN f := f || 'signboardPhotoId'::text; END IF;
    -- Personal values: the field name only. The four GPS columns are one name.
    IF o."branchName" IS DISTINCT FROM r."branchName" THEN f := f || 'branchName'::text; END IF;
    IF o."address" IS DISTINCT FROM r."address" THEN f := f || 'address'::text; END IF;
    IF o."areaDescription" IS DISTINCT FROM r."areaDescription" THEN f := f || 'areaDescription'::text; END IF;
    IF (o."gpsLat", o."gpsLng", o."gpsAccuracy", o."gpsCapturedAt") IS DISTINCT FROM (r."gpsLat", r."gpsLng", r."gpsAccuracy", r."gpsCapturedAt") THEN
      f := f || 'gps'::text;
    END IF;
    IF o."openingHours" IS DISTINCT FROM r."openingHours" THEN f := f || 'openingHours'::text; END IF;
    IF o."deliveryWindow" IS DISTINCT FROM r."deliveryWindow" THEN f := f || 'deliveryWindow'::text; END IF;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  SELECT h."validFrom" INTO prev FROM public."BranchHistory" h
   WHERE h."branchId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  INSERT INTO public."BranchHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "branchId", "branchCode", "customerId", "routeId", "regionId", "dayOfVisit", "status", "deletedAt",
    "coolersCount", "standsCount", "emptyBottlesCount", "equipmentConfirmed", "hasGps", "shopPhotoId", "signboardPhotoId")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."branchCode", r."customerId", r."routeId", r."regionId", r."dayOfVisit", r."status", r."deletedAt",
    r."coolersCount", r."standsCount", r."emptyBottlesCount", r."equipmentConfirmed", (r."gpsLat" IS NOT NULL AND r."gpsLng" IS NOT NULL),
    r."shopPhotoId", r."signboardPhotoId");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nmwc_history_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."User"%ROWTYPE;
  o public."User"%ROWTYPE;
  k public."HistoryChange";
  f text[] := '{}';
  ctx record;
  prev timestamp;
  regions text[];
  holder text;
  last_owner_row timestamp;
  owner_route text;
  owner_id text;
  step integer;
BEGIN
  IF TG_RELID <> 'public."User"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_user() runs only on "User"';
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW; k := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    r := OLD; o := OLD; k := 'DELETE';
  ELSE
    r := NEW; o := OLD; k := 'UPDATE';
    IF o."username" IS DISTINCT FROM r."username" THEN f := f || 'username'::text; END IF;
    IF o."role" IS DISTINCT FROM r."role" THEN f := f || 'role'::text; END IF;
    IF o."isActive" IS DISTINCT FROM r."isActive" THEN f := f || 'isActive'::text; END IF;
    IF o."supervisorId" IS DISTINCT FROM r."supervisorId" THEN f := f || 'supervisorId'::text; END IF;
    IF o."ownedRouteId" IS DISTINCT FROM r."ownedRouteId" THEN f := f || 'ownedRouteId'::text; END IF;
    -- Personal values: the field name only.
    IF o."fullName" IS DISTINCT FROM r."fullName" THEN f := f || 'fullName'::text; END IF;
    IF o."email" IS DISTINCT FROM r."email" THEN f := f || 'email'::text; END IF;
    IF o."phone" IS DISTINCT FROM r."phone" THEN f := f || 'phone'::text; END IF;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  SELECT COALESCE(array_agg(mr."A" ORDER BY mr."A"), '{}') INTO regions
    FROM public."_ManagerRegions" mr WHERE mr."B" = r."id";
  SELECT h."validFrom" INTO prev FROM public."UserHistory" h
   WHERE h."userId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  INSERT INTO public."UserHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "userId", "username", "role", "isActive", "supervisorId", "ownedRouteId", "regionIds")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."username", r."role", r."isActive", r."supervisorId", r."ownedRouteId", regions);

  -- Who holds the route (RouteOwnerHistory, one chain per route): step 1 is the
  -- release of the route this user held, step 2 the take of the route he holds
  -- now. A release is written only when the route's latest holder IS this user,
  -- so the chain never claims a hand-over that did not happen. In a hand-over the
  -- release and the take share a validFrom; id orders them.
  FOR step IN 1..2 LOOP
    owner_route := NULL;
    IF step = 1 AND TG_OP IN ('UPDATE', 'DELETE') AND o."ownedRouteId" IS NOT NULL
       AND (TG_OP = 'DELETE' OR o."ownedRouteId" IS DISTINCT FROM r."ownedRouteId") THEN
      SELECT h."ownerId" INTO holder FROM public."RouteOwnerHistory" h
       WHERE h."routeId" = o."ownedRouteId" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
      IF holder = o."id" THEN
        owner_route := o."ownedRouteId";
        owner_id := NULL;
      END IF;
    ELSIF step = 2 AND TG_OP IN ('INSERT', 'UPDATE') AND r."ownedRouteId" IS NOT NULL
       AND (TG_OP = 'INSERT' OR o."ownedRouteId" IS DISTINCT FROM r."ownedRouteId") THEN
      owner_route := r."ownedRouteId";
      owner_id := r."id";
    END IF;
    IF owner_route IS NOT NULL THEN
      SELECT h."validFrom" INTO last_owner_row FROM public."RouteOwnerHistory" h
       WHERE h."routeId" = owner_route ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
      INSERT INTO public."RouteOwnerHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
        "routeId", "ownerId")
      VALUES (CASE WHEN last_owner_row IS NULL THEN 'CREATE'::public."HistoryChange" ELSE 'UPDATE'::public."HistoryChange" END, '{ownerId}',
        GREATEST(ctx.valid_from, last_owner_row), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
        owner_route, owner_id);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nmwc_history_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."Route"%ROWTYPE;
  o public."Route"%ROWTYPE;
  k public."HistoryChange";
  f text[] := '{}';
  ctx record;
  prev timestamp;
BEGIN
  IF TG_RELID <> 'public."Route"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_route() runs only on "Route"';
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW; k := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    r := OLD; k := 'DELETE';
  ELSE
    r := NEW; o := OLD; k := 'UPDATE';
    IF o."code" IS DISTINCT FROM r."code" THEN f := f || 'code'::text; END IF;
    IF o."name" IS DISTINCT FROM r."name" THEN f := f || 'name'::text; END IF;
    IF o."regionId" IS DISTINCT FROM r."regionId" THEN f := f || 'regionId'::text; END IF;
    IF o."isActive" IS DISTINCT FROM r."isActive" THEN f := f || 'isActive'::text; END IF;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  SELECT h."validFrom" INTO prev FROM public."RouteHistory" h
   WHERE h."routeId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  INSERT INTO public."RouteHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "routeId", "code", "name", "regionId", "isActive")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."code", r."name", r."regionId", r."isActive");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nmwc_history_region() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."Region"%ROWTYPE;
  o public."Region"%ROWTYPE;
  k public."HistoryChange";
  f text[] := '{}';
  ctx record;
  prev timestamp;
BEGIN
  IF TG_RELID <> 'public."Region"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_region() runs only on "Region"';
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW; k := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    r := OLD; k := 'DELETE';
  ELSE
    r := NEW; o := OLD; k := 'UPDATE';
    IF o."code" IS DISTINCT FROM r."code" THEN f := f || 'code'::text; END IF;
    IF o."name" IS DISTINCT FROM r."name" THEN f := f || 'name'::text; END IF;
    IF o."isActive" IS DISTINCT FROM r."isActive" THEN f := f || 'isActive'::text; END IF;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  SELECT h."validFrom" INTO prev FROM public."RegionHistory" h
   WHERE h."regionId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  INSERT INTO public."RegionHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "regionId", "code", "name", "isActive")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."code", r."name", r."isActive");
  RETURN NULL;
END;
$$;

-- A manager's regions, captured once at commit as the final set. Prisma's
-- `managedRegions: { set }` deletes then inserts join rows; firing per row at the
-- statement would record every intermediate set. Deferred, each queued event
-- recomputes the set and writes a row only when it differs from the user's
-- latest, so a whole `set` yields one row. Safe because every region change
-- runs in a transaction of one cause (a user-admin action, or one account-import
-- row). A user deleted in the same transaction is skipped: his tombstone is the
-- User trigger's.
CREATE OR REPLACE FUNCTION nmwc_history_manager_regions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text;
  u public."User"%ROWTYPE;
  regions text[];
  latest public."UserHistory"%ROWTYPE;
  ctx record;
BEGIN
  IF TG_RELID <> 'public."_ManagerRegions"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_manager_regions() runs only on "_ManagerRegions"';
  END IF;
  uid := CASE WHEN TG_OP = 'DELETE' THEN OLD."B" ELSE NEW."B" END;
  SELECT * INTO u FROM public."User" WHERE "id" = uid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(array_agg(mr."A" ORDER BY mr."A"), '{}') INTO regions
    FROM public."_ManagerRegions" mr WHERE mr."B" = uid;
  SELECT * INTO latest FROM public."UserHistory" h
   WHERE h."userId" = uid ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  IF FOUND AND latest."regionIds" IS NOT DISTINCT FROM regions THEN
    RETURN NULL;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  INSERT INTO public."UserHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "userId", "username", "role", "isActive", "supervisorId", "ownedRouteId", "regionIds")
  VALUES (CASE WHEN latest."id" IS NULL THEN 'CREATE'::public."HistoryChange" ELSE 'UPDATE'::public."HistoryChange" END, '{regionIds}',
    GREATEST(ctx.valid_from, latest."validFrom"), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    u."id", u."username", u."role", u."isActive", u."supervisorId", u."ownedRouteId", regions);
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_history_customer() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nmwc_history_branch() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nmwc_history_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nmwc_history_route() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nmwc_history_region() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nmwc_history_manager_regions() FROM PUBLIC;

CREATE TRIGGER customer_history_capture
  AFTER INSERT OR DELETE ON "Customer"
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_customer();
CREATE TRIGGER customer_history_capture_upd
  AFTER UPDATE ON "Customer"
  FOR EACH ROW
  WHEN ((OLD."nmwcCode", OLD."paymentTerms", OLD."creditLimit", OLD."paymentTermDays", OLD."temixCode", OLD."status",
         OLD."channelId", OLD."subChannelId", OLD."crPhotoId", OLD."deletedAt",
         OLD."legalName", OLD."crNumber", OLD."primaryPhone", OLD."altPhone", OLD."contactPerson", OLD."contactRole",
         OLD."email", OLD."notes")
        IS DISTINCT FROM
        (NEW."nmwcCode", NEW."paymentTerms", NEW."creditLimit", NEW."paymentTermDays", NEW."temixCode", NEW."status",
         NEW."channelId", NEW."subChannelId", NEW."crPhotoId", NEW."deletedAt",
         NEW."legalName", NEW."crNumber", NEW."primaryPhone", NEW."altPhone", NEW."contactPerson", NEW."contactRole",
         NEW."email", NEW."notes"))
  EXECUTE FUNCTION nmwc_history_customer();

CREATE TRIGGER branch_history_capture
  AFTER INSERT OR DELETE ON "Branch"
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_branch();
CREATE TRIGGER branch_history_capture_upd
  AFTER UPDATE ON "Branch"
  FOR EACH ROW
  WHEN ((OLD."branchCode", OLD."customerId", OLD."routeId", OLD."regionId", OLD."dayOfVisit", OLD."status", OLD."deletedAt",
         OLD."coolersCount", OLD."standsCount", OLD."emptyBottlesCount", OLD."equipmentConfirmed",
         OLD."shopPhotoId", OLD."signboardPhotoId",
         OLD."branchName", OLD."address", OLD."areaDescription", OLD."gpsLat", OLD."gpsLng", OLD."gpsAccuracy",
         OLD."gpsCapturedAt", OLD."openingHours", OLD."deliveryWindow")
        IS DISTINCT FROM
        (NEW."branchCode", NEW."customerId", NEW."routeId", NEW."regionId", NEW."dayOfVisit", NEW."status", NEW."deletedAt",
         NEW."coolersCount", NEW."standsCount", NEW."emptyBottlesCount", NEW."equipmentConfirmed",
         NEW."shopPhotoId", NEW."signboardPhotoId",
         NEW."branchName", NEW."address", NEW."areaDescription", NEW."gpsLat", NEW."gpsLng", NEW."gpsAccuracy",
         NEW."gpsCapturedAt", NEW."openingHours", NEW."deliveryWindow"))
  EXECUTE FUNCTION nmwc_history_branch();

CREATE TRIGGER user_history_capture
  AFTER INSERT OR DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_user();
CREATE TRIGGER user_history_capture_upd
  AFTER UPDATE ON "User"
  FOR EACH ROW
  WHEN ((OLD."username", OLD."role", OLD."isActive", OLD."supervisorId", OLD."ownedRouteId",
         OLD."fullName", OLD."email", OLD."phone")
        IS DISTINCT FROM
        (NEW."username", NEW."role", NEW."isActive", NEW."supervisorId", NEW."ownedRouteId",
         NEW."fullName", NEW."email", NEW."phone"))
  EXECUTE FUNCTION nmwc_history_user();

CREATE TRIGGER route_history_capture
  AFTER INSERT OR DELETE ON "Route"
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_route();
CREATE TRIGGER route_history_capture_upd
  AFTER UPDATE ON "Route"
  FOR EACH ROW
  WHEN ((OLD."code", OLD."name", OLD."regionId", OLD."isActive")
        IS DISTINCT FROM (NEW."code", NEW."name", NEW."regionId", NEW."isActive"))
  EXECUTE FUNCTION nmwc_history_route();

CREATE TRIGGER region_history_capture
  AFTER INSERT OR DELETE ON "Region"
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_region();
CREATE TRIGGER region_history_capture_upd
  AFTER UPDATE ON "Region"
  FOR EACH ROW
  WHEN ((OLD."code", OLD."name", OLD."isActive") IS DISTINCT FROM (NEW."code", NEW."name", NEW."isActive"))
  EXECUTE FUNCTION nmwc_history_region();

CREATE CONSTRAINT TRIGGER managerregions_history_capture
  AFTER INSERT OR UPDATE OR DELETE ON "_ManagerRegions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_manager_regions();

-- ── 6. AuditLog rows carry the same cause and transaction ──────────────────
--
-- Not SECURITY DEFINER: it only reads two settings. A row written outside any
-- context (a sign-in, a photo view, a stand-alone export) keeps source NULL: it
-- is an event, not a master change. txId joins an audit row to the history rows
-- of its transaction, and so to the reason and the request behind them.
CREATE OR REPLACE FUNCTION nmwc_auditlog_stamp_context() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW."source" := left(COALESCE(NEW."source", NULLIF(current_setting('nmwc.source', true), '')), 200);
  NEW."txId" := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER auditlog_stamp_context
  BEFORE INSERT ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- ── 7. Protection ──────────────────────────────────────────────────────────
--
-- UPDATE, DELETE and TRUNCATE: refused exactly as on AuditLog, by the same
-- function (only the owner session, inside the maintenance window, gets through).
-- INSERT: only from a capture trigger (pg_trigger_depth() >= 2: this guard runs
-- inside the capture trigger's insert) or in the owner's maintenance window, so a
-- history row cannot be forged by the application credential even while
-- production still connects as the owner. Created after the baseline above.
CREATE OR REPLACE FUNCTION nmwc_history_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  owner_name name;
BEGIN
  IF pg_trigger_depth() >= 2 THEN
    RETURN NEW;
  END IF;
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
    IF session_user = owner_name THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'History: a direct INSERT into "%" is refused — the history is written only by the database''s own triggers. Only the table owner may add rows, in a maintenance transaction (SET LOCAL nmwc.audit_maintenance = ''on'').',
    TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_history_insert_guard() FROM PUBLIC;

CREATE TRIGGER customerhistory_append_only BEFORE UPDATE OR DELETE ON "CustomerHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER customerhistory_no_truncate BEFORE TRUNCATE ON "CustomerHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER customerhistory_insert_guard BEFORE INSERT ON "CustomerHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

CREATE TRIGGER branchhistory_append_only BEFORE UPDATE OR DELETE ON "BranchHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER branchhistory_no_truncate BEFORE TRUNCATE ON "BranchHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER branchhistory_insert_guard BEFORE INSERT ON "BranchHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

CREATE TRIGGER userhistory_append_only BEFORE UPDATE OR DELETE ON "UserHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER userhistory_no_truncate BEFORE TRUNCATE ON "UserHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER userhistory_insert_guard BEFORE INSERT ON "UserHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

CREATE TRIGGER routeownerhistory_append_only BEFORE UPDATE OR DELETE ON "RouteOwnerHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER routeownerhistory_no_truncate BEFORE TRUNCATE ON "RouteOwnerHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER routeownerhistory_insert_guard BEFORE INSERT ON "RouteOwnerHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

CREATE TRIGGER routehistory_append_only BEFORE UPDATE OR DELETE ON "RouteHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER routehistory_no_truncate BEFORE TRUNCATE ON "RouteHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER routehistory_insert_guard BEFORE INSERT ON "RouteHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

CREATE TRIGGER regionhistory_append_only BEFORE UPDATE OR DELETE ON "RegionHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER regionhistory_no_truncate BEFORE TRUNCATE ON "RegionHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER regionhistory_insert_guard BEFORE INSERT ON "RegionHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

-- The runtime role: read the history, never write it, and never touch its
-- sequences (setval would make every capture insert collide). The default
-- privileges handed it SELECT/INSERT/UPDATE on these new tables and
-- USAGE/SELECT/UPDATE on their sequences; scripts/ops/app-role.ts `grant`
-- re-revokes the same after its blanket GRANT. Skipped where the role does not
-- exist yet (a fresh CI database: app-role.ts runs after the migrations).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON "CustomerHistory", "BranchHistory", "UserHistory", "RouteOwnerHistory", "RouteHistory", "RegionHistory"
      FROM nmwc_app;
    REVOKE ALL
      ON SEQUENCE "CustomerHistory_id_seq", "BranchHistory_id_seq", "UserHistory_id_seq",
                  "RouteOwnerHistory_id_seq", "RouteHistory_id_seq", "RegionHistory_id_seq"
      FROM nmwc_app;
  END IF;
END;
$$;

-- ── 8. As-of, interval and report functions (docs/HISTORY.md) ──────────────
--
-- SQL, STABLE, SECURITY INVOKER: they read with the caller's privileges, and the
-- runtime role may SELECT the history. Conventions:
--   *_at(p_at timestamp)   the state at that UTC instant: the latest row of each
--                          record with validFrom <= p_at; a DELETE tombstone drops it.
--   *_on(d date)           the state at the END of that Oman day: a change made or
--                          loaded at any time on d counts for d.
--   inferred               the answer rests on a BASELINE row for a time before the
--                          baseline was recorded: true "as found when history
--                          began", not a record of what it was then.
--   *_intervals(id)        every row of one record with valid_to = the next row's
--                          validFrom (null = still current).

CREATE OR REPLACE FUNCTION nmwc_day_end(d date) RETURNS timestamp
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ((d + 1)::timestamp AT TIME ZONE 'Asia/Muscat') AT TIME ZONE 'UTC'
$$;

CREATE OR REPLACE FUNCTION nmwc_branches_at(p_at timestamp)
RETURNS TABLE (
  branch_id text, branch_code text, customer_id text, route_id text, region_id text,
  day_of_visit "DayOfWeek", status "CustomerStatus", deleted_at timestamp,
  coolers_count integer, stands_count integer, empty_bottles_count integer, equipment_confirmed boolean,
  has_gps boolean, shop_photo_id text, signboard_photo_id text,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."branchId", h."branchCode", h."customerId", h."routeId", h."regionId",
         h."dayOfVisit", h."status", h."deletedAt",
         h."coolersCount", h."standsCount", h."emptyBottlesCount", h."equipmentConfirmed",
         h."hasGps", h."shopPhotoId", h."signboardPhotoId",
         h."validFrom", h."id", h."changeKind", h."source", h."actorId",
         (h."changeKind" = 'BASELINE' AND p_at < h."recordedAt")
  FROM (
    SELECT DISTINCT ON (x."branchId") x.*
    FROM public."BranchHistory" x
    WHERE x."validFrom" <= p_at
    ORDER BY x."branchId", x."validFrom" DESC, x."id" DESC
  ) h
  WHERE h."changeKind" <> 'DELETE'
$$;

CREATE OR REPLACE FUNCTION nmwc_branches_on(d date)
RETURNS TABLE (
  branch_id text, branch_code text, customer_id text, route_id text, region_id text,
  day_of_visit "DayOfWeek", status "CustomerStatus", deleted_at timestamp,
  coolers_count integer, stands_count integer, empty_bottles_count integer, equipment_confirmed boolean,
  has_gps boolean, shop_photo_id text, signboard_photo_id text,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.nmwc_branches_at(public.nmwc_day_end(d) - interval '1 millisecond')
$$;

CREATE OR REPLACE FUNCTION nmwc_customers_at(p_at timestamp)
RETURNS TABLE (
  customer_id text, nmwc_code text, payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer,
  temix_code text, status "CustomerStatus", channel_id text, sub_channel_id text, cr_photo_id text, deleted_at timestamp,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."customerId", h."nmwcCode", h."paymentTerms", h."creditLimit", h."paymentTermDays",
         h."temixCode", h."status", h."channelId", h."subChannelId", h."crPhotoId", h."deletedAt",
         h."validFrom", h."id", h."changeKind", h."source", h."actorId",
         (h."changeKind" = 'BASELINE' AND p_at < h."recordedAt")
  FROM (
    SELECT DISTINCT ON (x."customerId") x.*
    FROM public."CustomerHistory" x
    WHERE x."validFrom" <= p_at
    ORDER BY x."customerId", x."validFrom" DESC, x."id" DESC
  ) h
  WHERE h."changeKind" <> 'DELETE'
$$;

CREATE OR REPLACE FUNCTION nmwc_customers_on(d date)
RETURNS TABLE (
  customer_id text, nmwc_code text, payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer,
  temix_code text, status "CustomerStatus", channel_id text, sub_channel_id text, cr_photo_id text, deleted_at timestamp,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.nmwc_customers_at(public.nmwc_day_end(d) - interval '1 millisecond')
$$;

CREATE OR REPLACE FUNCTION nmwc_users_at(p_at timestamp)
RETURNS TABLE (
  user_id text, username text, role "Role", is_active boolean, supervisor_id text, owned_route_id text, region_ids text[],
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."userId", h."username", h."role", h."isActive", h."supervisorId", h."ownedRouteId", h."regionIds",
         h."validFrom", h."id", h."changeKind", h."source", h."actorId",
         (h."changeKind" = 'BASELINE' AND p_at < h."recordedAt")
  FROM (
    SELECT DISTINCT ON (x."userId") x.*
    FROM public."UserHistory" x
    WHERE x."validFrom" <= p_at
    ORDER BY x."userId", x."validFrom" DESC, x."id" DESC
  ) h
  WHERE h."changeKind" <> 'DELETE'
$$;

CREATE OR REPLACE FUNCTION nmwc_users_on(d date)
RETURNS TABLE (
  user_id text, username text, role "Role", is_active boolean, supervisor_id text, owned_route_id text, region_ids text[],
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.nmwc_users_at(public.nmwc_day_end(d) - interval '1 millisecond')
$$;

CREATE OR REPLACE FUNCTION nmwc_routes_at(p_at timestamp)
RETURNS TABLE (
  route_id text, code text, name text, region_id text, is_active boolean,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."routeId", h."code", h."name", h."regionId", h."isActive",
         h."validFrom", h."id", h."changeKind", h."source", h."actorId",
         (h."changeKind" = 'BASELINE' AND p_at < h."recordedAt")
  FROM (
    SELECT DISTINCT ON (x."routeId") x.*
    FROM public."RouteHistory" x
    WHERE x."validFrom" <= p_at
    ORDER BY x."routeId", x."validFrom" DESC, x."id" DESC
  ) h
  WHERE h."changeKind" <> 'DELETE'
$$;

CREATE OR REPLACE FUNCTION nmwc_route_owners_at(p_at timestamp)
RETURNS TABLE (
  route_id text, owner_id text,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."routeId", h."ownerId",
         h."validFrom", h."id", h."changeKind", h."source", h."actorId",
         (h."changeKind" = 'BASELINE' AND p_at < h."recordedAt")
  FROM (
    SELECT DISTINCT ON (x."routeId") x.*
    FROM public."RouteOwnerHistory" x
    WHERE x."validFrom" <= p_at
    ORDER BY x."routeId", x."validFrom" DESC, x."id" DESC
  ) h
$$;

CREATE OR REPLACE FUNCTION nmwc_route_owners_on(d date)
RETURNS TABLE (
  route_id text, owner_id text,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.nmwc_route_owners_at(public.nmwc_day_end(d) - interval '1 millisecond')
$$;

-- Who served customer X at the end of day d: per live shop of the customer then,
-- its route and region, visit day and status, and the salesman who held that
-- route then (his username as it was: route usernames are retired on hand-over).
-- A shop is the customer's on d if its latest row on d names the customer — a shop
-- merged away before d is the winner's, not X's.
CREATE OR REPLACE FUNCTION nmwc_customer_service_on(p_customer_id text, d date)
RETURNS TABLE (
  branch_id text, branch_code text, route_id text, route_code text, region_id text, region_code text,
  day_of_visit "DayOfWeek", branch_status "CustomerStatus",
  salesman_id text, salesman_username text, salesman_active boolean, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH t AS (
    SELECT public.nmwc_day_end(d) - interval '1 millisecond' AS at_ts
  ),
  cand AS (
    SELECT DISTINCT h."branchId" AS branch_id
    FROM public."BranchHistory" h, t
    WHERE h."customerId" = p_customer_id AND h."validFrom" <= t.at_ts
  ),
  b AS (
    SELECT x.*
    FROM cand c
    CROSS JOIN t
    CROSS JOIN LATERAL (
      SELECT h.* FROM public."BranchHistory" h
      WHERE h."branchId" = c.branch_id AND h."validFrom" <= t.at_ts
      ORDER BY h."validFrom" DESC, h."id" DESC
      LIMIT 1
    ) x
    WHERE x."customerId" = p_customer_id AND x."changeKind" <> 'DELETE' AND x."deletedAt" IS NULL
  )
  SELECT b."branchId", b."branchCode", b."routeId", rt.code, b."regionId", rg.code,
         b."dayOfVisit", b."status",
         ow."ownerId", us."username", us."isActive",
         ((b."changeKind" = 'BASELINE' AND t.at_ts < b."recordedAt")
          OR (ow."changeKind" = 'BASELINE' AND t.at_ts < ow."recordedAt")
          OR (us."changeKind" = 'BASELINE' AND t.at_ts < us."recordedAt")) IS TRUE
  FROM b
  CROSS JOIN t
  LEFT JOIN LATERAL (
    SELECT h."code" FROM public."RouteHistory" h WHERE h."routeId" = b."routeId"
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) rt ON true
  LEFT JOIN LATERAL (
    SELECT h."code" FROM public."RegionHistory" h WHERE h."regionId" = b."regionId"
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) rg ON true
  LEFT JOIN LATERAL (
    SELECT h.* FROM public."RouteOwnerHistory" h
    WHERE h."routeId" = b."routeId" AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) ow ON true
  LEFT JOIN LATERAL (
    SELECT h.* FROM public."UserHistory" h
    WHERE h."userId" = ow."ownerId" AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) us ON true
  ORDER BY b."branchCode"
$$;

-- A customer's terms at the end of day d (cash or credit, limit, days, Temix
-- code, status, channel). No row: the customer did not exist then, or was
-- hard-deleted.
CREATE OR REPLACE FUNCTION nmwc_customer_terms_on(p_customer_id text, d date)
RETURNS TABLE (
  payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer, temix_code text,
  status "CustomerStatus", channel_id text, sub_channel_id text, deleted_at timestamp,
  valid_from timestamp, source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT x."paymentTerms", x."creditLimit", x."paymentTermDays", x."temixCode",
         x."status", x."channelId", x."subChannelId", x."deletedAt",
         x."validFrom", x."source", x."actorId",
         (x."changeKind" = 'BASELINE' AND public.nmwc_day_end(d) - interval '1 millisecond' < x."recordedAt")
  FROM (
    SELECT h.* FROM public."CustomerHistory" h
    WHERE h."customerId" = p_customer_id AND h."validFrom" <= public.nmwc_day_end(d) - interval '1 millisecond'
    ORDER BY h."validFrom" DESC, h."id" DESC
    LIMIT 1
  ) x
  WHERE x."changeKind" <> 'DELETE'
$$;

-- Who held route R at the end of day d (no owner_id: nobody did).
CREATE OR REPLACE FUNCTION nmwc_route_owner_on(p_route_id text, d date)
RETURNS TABLE (
  owner_id text, owner_username text, owner_active boolean,
  valid_from timestamp, source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH t AS (SELECT public.nmwc_day_end(d) - interval '1 millisecond' AS at_ts),
  o AS (
    SELECT h.* FROM public."RouteOwnerHistory" h, t
    WHERE h."routeId" = p_route_id AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC
    LIMIT 1
  )
  SELECT o."ownerId", us."username", us."isActive", o."validFrom", o."source", o."actorId",
         ((o."changeKind" = 'BASELINE' AND t.at_ts < o."recordedAt")
          OR (us."changeKind" = 'BASELINE' AND t.at_ts < us."recordedAt")) IS TRUE
  FROM o
  CROSS JOIN t
  LEFT JOIN LATERAL (
    SELECT h.* FROM public."UserHistory" h
    WHERE h."userId" = o."ownerId" AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) us ON true
$$;

-- A user at the end of day d: role, supervisor, regions, the route he held and
-- its region, active or not.
CREATE OR REPLACE FUNCTION nmwc_user_on(p_user_id text, d date)
RETURNS TABLE (
  username text, role "Role", is_active boolean, supervisor_id text, supervisor_username text,
  region_ids text[], owned_route_id text, owned_route_code text, owned_route_region_id text,
  valid_from timestamp, source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH t AS (SELECT public.nmwc_day_end(d) - interval '1 millisecond' AS at_ts),
  u AS (
    SELECT h.* FROM public."UserHistory" h, t
    WHERE h."userId" = p_user_id AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC
    LIMIT 1
  )
  SELECT u."username", u."role", u."isActive", u."supervisorId", sv."username",
         u."regionIds", u."ownedRouteId", rt."code", rt."regionId",
         u."validFrom", u."source", u."actorId",
         (u."changeKind" = 'BASELINE' AND t.at_ts < u."recordedAt")
  FROM u
  CROSS JOIN t
  LEFT JOIN LATERAL (
    SELECT h."username" FROM public."UserHistory" h
    WHERE h."userId" = u."supervisorId" AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) sv ON true
  LEFT JOIN LATERAL (
    SELECT h."code", h."regionId" FROM public."RouteHistory" h
    WHERE h."routeId" = u."ownedRouteId" AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) rt ON true
  WHERE u."changeKind" <> 'DELETE'
$$;

-- Every row of one record, oldest first, with valid_to derived. A row whose
-- valid_to equals its valid_from was superseded in the same instant (a create
-- and an update in one transaction); it is kept, so the first row is always the
-- record's birth (CREATE, or BASELINE for one that existed before history began).
CREATE OR REPLACE FUNCTION nmwc_branch_intervals(p_branch_id text)
RETURNS TABLE (
  history_id bigint, change_kind "HistoryChange", valid_from timestamp, valid_to timestamp,
  recorded_at timestamp, effective_requested timestamp, changed_fields text[], source text, actor_id text,
  customer_id text, branch_code text, route_id text, region_id text, day_of_visit "DayOfWeek",
  status "CustomerStatus", deleted_at timestamp, from_inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."id", h."changeKind", h."validFrom", lead(h."validFrom") OVER w,
         h."recordedAt", h."effectiveRequested", h."changedFields", h."source", h."actorId",
         h."customerId", h."branchCode", h."routeId", h."regionId", h."dayOfVisit",
         h."status", h."deletedAt", h."changeKind" = 'BASELINE'
  FROM public."BranchHistory" h
  WHERE h."branchId" = p_branch_id
  WINDOW w AS (ORDER BY h."validFrom", h."id")
  ORDER BY h."validFrom", h."id"
$$;

CREATE OR REPLACE FUNCTION nmwc_customer_intervals(p_customer_id text)
RETURNS TABLE (
  history_id bigint, change_kind "HistoryChange", valid_from timestamp, valid_to timestamp,
  recorded_at timestamp, effective_requested timestamp, changed_fields text[], source text, actor_id text,
  nmwc_code text, payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer, temix_code text,
  status "CustomerStatus", channel_id text, sub_channel_id text, deleted_at timestamp, from_inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."id", h."changeKind", h."validFrom", lead(h."validFrom") OVER w,
         h."recordedAt", h."effectiveRequested", h."changedFields", h."source", h."actorId",
         h."nmwcCode", h."paymentTerms", h."creditLimit", h."paymentTermDays", h."temixCode",
         h."status", h."channelId", h."subChannelId", h."deletedAt", h."changeKind" = 'BASELINE'
  FROM public."CustomerHistory" h
  WHERE h."customerId" = p_customer_id
  WINDOW w AS (ORDER BY h."validFrom", h."id")
  ORDER BY h."validFrom", h."id"
$$;

CREATE OR REPLACE FUNCTION nmwc_user_intervals(p_user_id text)
RETURNS TABLE (
  history_id bigint, change_kind "HistoryChange", valid_from timestamp, valid_to timestamp,
  recorded_at timestamp, effective_requested timestamp, changed_fields text[], source text, actor_id text,
  username text, role "Role", is_active boolean, supervisor_id text, owned_route_id text, region_ids text[],
  from_inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."id", h."changeKind", h."validFrom", lead(h."validFrom") OVER w,
         h."recordedAt", h."effectiveRequested", h."changedFields", h."source", h."actorId",
         h."username", h."role", h."isActive", h."supervisorId", h."ownedRouteId", h."regionIds",
         h."changeKind" = 'BASELINE'
  FROM public."UserHistory" h
  WHERE h."userId" = p_user_id
  WINDOW w AS (ORDER BY h."validFrom", h."id")
  ORDER BY h."validFrom", h."id"
$$;

-- Who held route R, from when to when. Zero-length rows (the release and the
-- take of one hand-over share an instant) are left out.
CREATE OR REPLACE FUNCTION nmwc_route_owner_intervals(p_route_id text)
RETURNS TABLE (
  owner_id text, owner_username text, valid_from timestamp, valid_to timestamp,
  source text, actor_id text, from_inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT o."ownerId", us."username", o."validFrom", o.valid_to, o."source", o."actorId", o."changeKind" = 'BASELINE'
  FROM (
    SELECT h.*, lead(h."validFrom") OVER (ORDER BY h."validFrom", h."id") AS valid_to
    FROM public."RouteOwnerHistory" h
    WHERE h."routeId" = p_route_id
  ) o
  LEFT JOIN LATERAL (
    SELECT h."username" FROM public."UserHistory" h
    WHERE h."userId" = o."ownerId"
    ORDER BY (h."validFrom" <= o."validFrom") DESC,
             CASE WHEN h."validFrom" <= o."validFrom" THEN h."validFrom" END DESC,
             h."validFrom", h."id" DESC
    LIMIT 1
  ) us ON true
  WHERE o.valid_to IS NULL OR o.valid_to > o."validFrom"
  ORDER BY o."validFrom", o."id"
$$;

-- "Which routes served customer X, from when to when": every shop that ever
-- belonged to the customer, its unbroken stretches on one route while it was
-- live and the customer's (gaps and islands), each cut by who held the route
-- (tsrange intersection). from_inferred: the stretch begins on a baseline row,
-- so its start is the record's createdAt as found, not a recorded move.
CREATE OR REPLACE FUNCTION nmwc_customer_route_intervals(p_customer_id text)
RETURNS TABLE (
  branch_id text, branch_code text, route_id text, route_code text,
  salesman_id text, salesman_username text, valid_from timestamp, valid_to timestamp, from_inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH bids AS (
    SELECT DISTINCT h."branchId" AS branch_id FROM public."BranchHistory" h WHERE h."customerId" = p_customer_id
  ),
  hist AS (
    SELECT h.*, lead(h."validFrom") OVER (PARTITION BY h."branchId" ORDER BY h."validFrom", h."id") AS valid_to
    FROM public."BranchHistory" h
    WHERE h."branchId" IN (SELECT branch_id FROM bids)
  ),
  live AS (
    SELECT * FROM hist
    WHERE "customerId" = p_customer_id AND "changeKind" <> 'DELETE' AND "deletedAt" IS NULL
      AND (valid_to IS NULL OR valid_to > "validFrom")
  ),
  marked AS (
    SELECT l.*,
           CASE WHEN lag(l."routeId") OVER w IS DISTINCT FROM l."routeId"
                  OR lag(l.valid_to) OVER w IS DISTINCT FROM l."validFrom"
                THEN 1 ELSE 0 END AS starts
    FROM live l
    WINDOW w AS (PARTITION BY l."branchId" ORDER BY l."validFrom", l."id")
  ),
  grouped AS (
    SELECT m.*, sum(m.starts) OVER (PARTITION BY m."branchId" ORDER BY m."validFrom", m."id") AS island
    FROM marked m
  ),
  islands AS (
    SELECT g."branchId" AS branch_id, g."routeId" AS route_id, g.island,
           min(g."validFrom") AS island_from,
           (array_agg(g.valid_to ORDER BY g."validFrom" DESC, g."id" DESC))[1] AS island_to,
           (array_agg(g."branchCode" ORDER BY g."validFrom" DESC, g."id" DESC))[1] AS branch_code,
           -- When the island begins on a baseline row: the time before which its
           -- start is "as found", not recorded.
           (array_agg(CASE WHEN g."changeKind" = 'BASELINE' THEN g."recordedAt" END ORDER BY g."validFrom", g."id"))[1] AS baseline_recorded_at
    FROM grouped g
    GROUP BY g."branchId", g."routeId", g.island
  ),
  owners AS (
    SELECT o."routeId" AS route_id, o."ownerId" AS owner_id, o."validFrom" AS owner_from, o.owner_to,
           CASE WHEN o."changeKind" = 'BASELINE' THEN o."recordedAt" END AS baseline_recorded_at
    FROM (
      SELECT h.*, lead(h."validFrom") OVER (PARTITION BY h."routeId" ORDER BY h."validFrom", h."id") AS owner_to
      FROM public."RouteOwnerHistory" h
      WHERE h."routeId" IN (SELECT route_id FROM islands)
    ) o
    WHERE o.owner_to IS NULL OR o.owner_to > o."validFrom"
  ),
  pieces AS (
    SELECT i.branch_id, i.branch_code, i.route_id, ow.owner_id,
           CASE WHEN ow.route_id IS NULL THEN tsrange(i.island_from, i.island_to)
                ELSE tsrange(i.island_from, i.island_to) * tsrange(ow.owner_from, ow.owner_to) END AS span,
           i.baseline_recorded_at AS island_baseline, ow.baseline_recorded_at AS owner_baseline
    FROM islands i
    LEFT JOIN owners ow
      ON ow.route_id = i.route_id
     AND tsrange(ow.owner_from, ow.owner_to) && tsrange(i.island_from, i.island_to)
  )
  SELECT p.branch_id, p.branch_code, p.route_id, rt."code", p.owner_id, us."username",
         lower(p.span), upper(p.span),
         (lower(p.span) < p.island_baseline OR lower(p.span) < p.owner_baseline) IS TRUE
  FROM pieces p
  LEFT JOIN LATERAL (
    SELECT h."code" FROM public."RouteHistory" h WHERE h."routeId" = p.route_id
    ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1
  ) rt ON true
  LEFT JOIN LATERAL (
    SELECT h."username" FROM public."UserHistory" h
    WHERE h."userId" = p.owner_id
    ORDER BY (h."validFrom" <= lower(p.span)) DESC,
             CASE WHEN h."validFrom" <= lower(p.span) THEN h."validFrom" END DESC,
             h."validFrom", h."id" DESC
    LIMIT 1
  ) us ON true
  ORDER BY lower(p.span), p.branch_code
$$;

-- Changes recorded with no cause since p_since, per table, Oman day and login
-- role. A dbUser of the runtime role (nmwc_app) means an application path is
-- missing its change context — a bug; the owner role means manual SQL or a
-- script. lib/history-report.ts reads this for /status and /api/health.
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
  ) u
  GROUP BY 1, 2, 3
  ORDER BY 2 DESC, 1, 3
$$;

RESET lock_timeout;
