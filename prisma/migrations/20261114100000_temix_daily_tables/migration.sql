-- The daily Temix-to-CRM import, stage 1: the tables only (the merged plan,
-- design B: a module of its own, apart from the Import screen).
--
-- Additive: two enums, six new tables, their indexes, CHECK constraints and
-- triggers, one retention rule id added to PurgeSummary_rule_check, and the
-- runtime role's privileges on the new tables. No existing table, column,
-- trigger or function is changed; ImportBatch, ImportRow, Customer, Branch,
-- every history table and AuditLog stay exactly as they are. Nothing writes the
-- new tables yet. lib/temix-daily-tables.ts lists what is created here, and
-- tests/unit/temix-daily-tables.test.ts holds the two together.
--
--   TemixDailyFile     one row per uploaded file; never deleted. loadDay is the
--                      Oman day of the upload, never in the future, and it and
--                      the file's identity never change. The same bytes once
--                      per load day; at most one file mid-load at a time.
--   TemixDailyRow      staging, one row per file row. raw and parsed are the
--                      customer's details as sent; the retention rule
--                      temix-daily-payload-90d empties them (lib/retention-rules.ts).
--   TemixChange        the ledger: one row per applied change or notice. INSERT
--                      only; source and txId stamped by the database, so txId
--                      joins the history and AuditLog rows of the same write.
--   TemixChangeReview  "seen / handled" marks, so the ledger is never updated.
--   TemixNoticeSeen    "listed once": a keyed hash, never the value itself.
--   TemixRouteMap      Temix route code -> CRM route, starts EMPTY; entries are
--                      added and retired by new rows, never by an update.
--
-- Left out on purpose (the owner has not decided): which row of a customer is
-- its main account, the A/I status mapping, creating customers and shops from
-- the file, route-code variants (the map starts empty), any threshold, the end
-- of the pilot rule, and a Temix code on Branch (the shop crosswalk).

SET lock_timeout = '10s';

-- ── 1. The tables (Prisma's own DDL, so the CI drift gate matches) ─────────

-- CreateEnum
CREATE TYPE "TemixDailyFileState" AS ENUM ('STAGED', 'CHECKED', 'APPLYING', 'FINALIZING', 'LOADED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "TemixDailyRowOutcome" AS ENUM ('PENDING', 'NO_CHANGE', 'APPLIED', 'PARTLY_APPLIED', 'HELD', 'REJECTED');

-- CreateTable
CREATE TABLE "TemixDailyFile" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "loadDay" DATE NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileSha256" TEXT NOT NULL,
    "fileBytes" INTEGER NOT NULL,
    "headings" JSONB NOT NULL,
    "state" "TemixDailyFileState" NOT NULL DEFAULT 'STAGED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "appliedRows" INTEGER NOT NULL DEFAULT 0,
    "noChangeRows" INTEGER NOT NULL DEFAULT 0,
    "heldRows" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "noticeRows" INTEGER NOT NULL DEFAULT 0,
    "applyLeaseBy" TEXT,
    "applyLeaseUntil" TIMESTAMP(3),
    "applyStartedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "loadedAt" TIMESTAMP(3),
    "discardedById" TEXT,
    "discardedAt" TIMESTAMP(3),
    "discardReason" TEXT,
    "sameBytesAsFileId" TEXT,
    "reversalAckById" TEXT,
    "reversalAckAt" TIMESTAMP(3),

    CONSTRAINT "TemixDailyFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemixDailyRow" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "custCodeKey" TEXT,
    "branchCodeKey" TEXT,
    "isMainRow" BOOLEAN,
    "customerId" TEXT,
    "branchId" TEXT,
    "outcome" "TemixDailyRowOutcome" NOT NULL DEFAULT 'PENDING',
    "holdReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemixDailyRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemixChange" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileId" TEXT NOT NULL,
    "rowId" TEXT,
    "loadDay" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "customerId" TEXT,
    "branchId" TEXT,
    "field" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "detailCode" TEXT,
    "source" TEXT,
    "txId" BIGINT,

    CONSTRAINT "TemixChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemixChangeReview" (
    "id" BIGSERIAL NOT NULL,
    "changeId" BIGINT NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "source" TEXT,
    "txId" BIGINT,

    CONSTRAINT "TemixChangeReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemixNoticeSeen" (
    "id" BIGSERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "valueHash" TEXT NOT NULL,
    "firstFileId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemixNoticeSeen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemixRouteMap" (
    "id" BIGSERIAL NOT NULL,
    "temixRouteCode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "routeId" TEXT,
    "retiresId" BIGINT,
    "reason" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "txId" BIGINT,

    CONSTRAINT "TemixRouteMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TemixDailyFile_state_applyLeaseUntil_idx" ON "TemixDailyFile"("state", "applyLeaseUntil");

-- CreateIndex
CREATE INDEX "TemixDailyFile_loadDay_uploadedAt_idx" ON "TemixDailyFile"("loadDay", "uploadedAt");

-- CreateIndex
CREATE INDEX "TemixDailyRow_fileId_outcome_idx" ON "TemixDailyRow"("fileId", "outcome");

-- CreateIndex
CREATE INDEX "TemixDailyRow_fileId_custCodeKey_idx" ON "TemixDailyRow"("fileId", "custCodeKey");

-- CreateIndex
CREATE INDEX "TemixDailyRow_customerId_idx" ON "TemixDailyRow"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "TemixDailyRow_fileId_rowNumber_key" ON "TemixDailyRow"("fileId", "rowNumber");

-- CreateIndex
CREATE INDEX "TemixChange_loadDay_kind_idx" ON "TemixChange"("loadDay", "kind");

-- CreateIndex
CREATE INDEX "TemixChange_customerId_createdAt_idx" ON "TemixChange"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "TemixChange_branchId_createdAt_idx" ON "TemixChange"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "TemixChange_fileId_idx" ON "TemixChange"("fileId");

-- CreateIndex
CREATE INDEX "TemixChange_txId_idx" ON "TemixChange"("txId");

-- CreateIndex
CREATE INDEX "TemixChangeReview_changeId_reviewedAt_idx" ON "TemixChangeReview"("changeId", "reviewedAt");

-- CreateIndex
CREATE INDEX "TemixNoticeSeen_firstFileId_idx" ON "TemixNoticeSeen"("firstFileId");

-- CreateIndex
CREATE UNIQUE INDEX "TemixNoticeSeen_customerId_kind_valueHash_key" ON "TemixNoticeSeen"("customerId", "kind", "valueHash");

-- CreateIndex
CREATE UNIQUE INDEX "TemixRouteMap_retiresId_key" ON "TemixRouteMap"("retiresId");

-- CreateIndex
CREATE INDEX "TemixRouteMap_temixRouteCode_id_idx" ON "TemixRouteMap"("temixRouteCode", "id");

-- CreateIndex
CREATE INDEX "TemixRouteMap_routeId_idx" ON "TemixRouteMap"("routeId");

-- CreateIndex
CREATE INDEX "TemixRouteMap_byId_idx" ON "TemixRouteMap"("byId");

-- AddForeignKey
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_discardedById_fkey" FOREIGN KEY ("discardedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_reversalAckById_fkey" FOREIGN KEY ("reversalAckById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_sameBytesAsFileId_fkey" FOREIGN KEY ("sameBytesAsFileId") REFERENCES "TemixDailyFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixDailyRow" ADD CONSTRAINT "TemixDailyRow_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "TemixDailyFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixChange" ADD CONSTRAINT "TemixChange_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "TemixDailyFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixChange" ADD CONSTRAINT "TemixChange_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "TemixDailyRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixChangeReview" ADD CONSTRAINT "TemixChangeReview_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "TemixChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixChangeReview" ADD CONSTRAINT "TemixChangeReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixNoticeSeen" ADD CONSTRAINT "TemixNoticeSeen_firstFileId_fkey" FOREIGN KEY ("firstFileId") REFERENCES "TemixDailyFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_retiresId_fkey" FOREIGN KEY ("retiresId") REFERENCES "TemixRouteMap"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 2. Indexes Prisma cannot express (partial; CI's drift gate keeps them) ──

-- The same file (by its SHA-256) is staged once per load day; a discarded file
-- frees its day, so a wrong upload can be discarded and the right one staged.
CREATE UNIQUE INDEX "TemixDailyFile_sha_day_live_unique"
  ON "TemixDailyFile" ("fileSha256", "loadDay") WHERE "state" <> 'DISCARDED';

-- One load at a time: at most one file is APPLYING or FINALIZING.
CREATE UNIQUE INDEX "TemixDailyFile_one_in_flight"
  ON "TemixDailyFile" ((true)) WHERE "state" IN ('APPLYING', 'FINALIZING');

-- The retention sweep reads only rows that still hold a payload, oldest first;
-- an emptied row leaves this index, so the nightly scan does not grow with time.
CREATE INDEX "TemixDailyRow_payload_createdAt_idx"
  ON "TemixDailyRow" ("createdAt") WHERE "raw" <> '{}'::jsonb OR "parsed" IS NOT NULL;

-- ── 3. CHECK constraints (Prisma ignores them, as PurgeSummary_rule_check) ──

ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_sha_check"
  CHECK ("fileSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_counts_check"
  CHECK ("fileBytes" >= 0 AND "totalRows" >= 0 AND "appliedRows" >= 0 AND "noChangeRows" >= 0
         AND "heldRows" >= 0 AND "rejectedRows" >= 0 AND "noticeRows" >= 0);
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_lease_check"
  CHECK (("applyLeaseBy" IS NULL) = ("applyLeaseUntil" IS NULL));
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_loaded_check"
  CHECK ("state" <> 'LOADED' OR "loadedAt" IS NOT NULL);
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_discard_check"
  CHECK (("state" = 'DISCARDED') = ("discardedAt" IS NOT NULL)
         AND ("state" <> 'DISCARDED' OR ("discardedById" IS NOT NULL AND btrim(COALESCE("discardReason", '')) <> '')));
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_reversal_ack_check"
  CHECK (("reversalAckById" IS NULL) = ("reversalAckAt" IS NULL));
ALTER TABLE "TemixDailyFile" ADD CONSTRAINT "TemixDailyFile_same_bytes_check"
  CHECK ("sameBytesAsFileId" IS NULL OR "sameBytesAsFileId" <> "id");

-- Codes only: a key is already normalised (capitals, trimmed, not empty), a
-- hold reason is a code word, never a value from the file.
ALTER TABLE "TemixDailyRow" ADD CONSTRAINT "TemixDailyRow_row_number_check"
  CHECK ("rowNumber" >= 1);
ALTER TABLE "TemixDailyRow" ADD CONSTRAINT "TemixDailyRow_keys_check"
  CHECK (("custCodeKey" IS NULL OR ("custCodeKey" <> '' AND "custCodeKey" = upper(btrim("custCodeKey"))))
         AND ("branchCodeKey" IS NULL OR ("branchCodeKey" <> '' AND "branchCodeKey" = upper(btrim("branchCodeKey")))));
ALTER TABLE "TemixDailyRow" ADD CONSTRAINT "TemixDailyRow_hold_reasons_check"
  CHECK (array_to_string(COALESCE("holdReasons", ARRAY[]::text[]), ',') ~ '^([A-Z][A-Z0-9_]{0,59}(,[A-Z][A-Z0-9_]{0,59})*)?$');

ALTER TABLE "TemixChange" ADD CONSTRAINT "TemixChange_kind_check"
  CHECK ("kind" IN ('ROUTE_MOVE', 'TERMS_CHANGED', 'CREDIT_LIMIT_CHANGED', 'CREDIT_DAYS_CHANGED', 'CUSTOMER_CREATED', 'SHOP_CREATED', 'TEMIX_CODE_CONFIRMED', 'STATUS_DIFFERS', 'NAME_DIFFERS', 'ROUTE_NOT_MATCHED', 'ROUTE_INACTIVE', 'SHOP_CODE_LOOKALIKE', 'SHOP_NOT_LINKED', 'DUPLICATE_SUSPECT', 'CODE_HELD_BY_OTHER', 'MISSING_FROM_FILE', 'ACCOUNTANT_CODE_NOT_SEEN', 'DAUGHTER_TERMS_IGNORED'));
-- A field is a column name; a value is a code, an id, an enum value or a figure.
ALTER TABLE "TemixChange" ADD CONSTRAINT "TemixChange_values_check"
  CHECK (("field" IS NULL OR "field" ~ '^[A-Za-z][A-Za-z0-9]{0,62}$')
         AND ("detailCode" IS NULL OR "detailCode" ~ '^[A-Z][A-Z0-9_]{0,59}$')
         AND ("fromValue" IS NULL OR char_length("fromValue") <= 100)
         AND ("toValue" IS NULL OR char_length("toValue") <= 100));

ALTER TABLE "TemixChangeReview" ADD CONSTRAINT "TemixChangeReview_note_check"
  CHECK ("note" IS NULL OR "note" ~ '^[A-Z][A-Z0-9_]{0,39}$');

ALTER TABLE "TemixNoticeSeen" ADD CONSTRAINT "TemixNoticeSeen_kind_check"
  CHECK ("kind" IN ('NAME_DIFFERS'));
ALTER TABLE "TemixNoticeSeen" ADD CONSTRAINT "TemixNoticeSeen_hash_check"
  CHECK ("valueHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_action_check"
  CHECK ("action" IN ('ADD', 'RETIRE'));
ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_shape_check"
  CHECK (("action" = 'ADD' AND "routeId" IS NOT NULL AND "retiresId" IS NULL)
         OR ("action" = 'RETIRE' AND "routeId" IS NULL AND "retiresId" IS NOT NULL));
ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_code_check"
  CHECK ("temixRouteCode" <> '' AND "temixRouteCode" = upper(btrim("temixRouteCode")) AND char_length("temixRouteCode") <= 40);
ALTER TABLE "TemixRouteMap" ADD CONSTRAINT "TemixRouteMap_reason_check"
  CHECK (btrim("reason") <> '');

-- The staged payload of a daily file is cleared like an import row's
-- (lib/retention-rules.ts temix-daily-payload-90d). PurgeSummary is append-only;
-- replacing its CHECK changes no row (every existing row names an older rule).
ALTER TABLE "PurgeSummary" DROP CONSTRAINT "PurgeSummary_rule_check";
ALTER TABLE "PurgeSummary" ADD CONSTRAINT "PurgeSummary_rule_check"
  CHECK ("rule" IN ('rate-limit-1d', 'import-payload-90d', 'notification-unread-180d', 'cron-run-90d', 'notification-read-90d', 'photo-detached-30d', 'password-history-last-5', 'temix-daily-payload-90d'));

-- ── 4. A file: its load day and identity are fixed, its end states final ──

-- loadDay is never in the future (the Oman calendar day of the database's clock),
-- and the file's name, hash, size, load day, uploader and upload time never
-- change after it is staged. LOADED and DISCARDED are final. Which day a file's
-- changes are dated is loadDay; whether that should be the upload day or the
-- apply day is the owner's open question, so nothing here ties it to either.
CREATE OR REPLACE FUNCTION nmwc_temix_daily_file_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."loadDay" > (clock_timestamp() AT TIME ZONE 'Asia/Muscat')::date THEN
    RAISE EXCEPTION 'TemixDailyFile: load day % is in the future', NEW."loadDay"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."filename" IS DISTINCT FROM OLD."filename"
       OR NEW."loadDay" IS DISTINCT FROM OLD."loadDay"
       OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
       OR NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt"
       OR NEW."fileSha256" IS DISTINCT FROM OLD."fileSha256"
       OR NEW."fileBytes" IS DISTINCT FROM OLD."fileBytes" THEN
      RAISE EXCEPTION 'TemixDailyFile: a staged file''s name, hash, size, load day and uploader never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" IN ('LOADED', 'DISCARDED') AND NEW."state" IS DISTINCT FROM OLD."state" THEN
      RAISE EXCEPTION 'TemixDailyFile: a % file stays %', OLD."state", OLD."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER temixdailyfile_identity_guard
  BEFORE INSERT OR UPDATE ON "TemixDailyFile"
  FOR EACH ROW EXECUTE FUNCTION nmwc_temix_daily_file_guard();

-- Never deleted: the hash, size, counts and outcome of every file are kept, as
-- the ledger rows point at it. Only the owner, in the maintenance window.
CREATE TRIGGER temixdailyfile_no_delete BEFORE DELETE ON "TemixDailyFile" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER temixdailyfile_no_truncate BEFORE TRUNCATE ON "TemixDailyFile" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- ── 5. The ledger: stamped, consistent with its file, insert only ─────────

CREATE TRIGGER temixchange_stamp_context
  BEFORE INSERT ON "TemixChange"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- A ledger row carries its file's load day, and its row (when it names one)
-- belongs to that file.
CREATE OR REPLACE FUNCTION nmwc_temix_change_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."TemixDailyFile" f WHERE f."id" = NEW."fileId" AND f."loadDay" = NEW."loadDay") THEN
    RAISE EXCEPTION 'TemixChange: loadDay % is not the load day of file %', NEW."loadDay", NEW."fileId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rowId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public."TemixDailyRow" r WHERE r."id" = NEW."rowId" AND r."fileId" = NEW."fileId") THEN
    RAISE EXCEPTION 'TemixChange: row % is not a row of file %', NEW."rowId", NEW."fileId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER temixchange_insert_guard
  BEFORE INSERT ON "TemixChange"
  FOR EACH ROW EXECUTE FUNCTION nmwc_temix_change_guard();

CREATE TRIGGER temixchange_append_only BEFORE UPDATE OR DELETE ON "TemixChange" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER temixchange_no_truncate BEFORE TRUNCATE ON "TemixChange" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- ── 6. Reviews and "listed once": insert only ─────────────────────────────

CREATE TRIGGER temixchangereview_stamp_context
  BEFORE INSERT ON "TemixChangeReview"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();
CREATE TRIGGER temixchangereview_append_only BEFORE UPDATE OR DELETE ON "TemixChangeReview" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER temixchangereview_no_truncate BEFORE TRUNCATE ON "TemixChangeReview" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

CREATE TRIGGER temixnoticeseen_append_only BEFORE UPDATE OR DELETE ON "TemixNoticeSeen" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER temixnoticeseen_no_truncate BEFORE TRUNCATE ON "TemixNoticeSeen" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- ── 7. The route map: added and retired by new rows, one live entry a code ─

CREATE TRIGGER temixroutemap_stamp_context
  BEFORE INSERT ON "TemixRouteMap"
  FOR EACH ROW EXECUTE FUNCTION nmwc_auditlog_stamp_context();

-- An ADD is refused while the code has a live entry (an ADD with no RETIRE
-- naming it); a RETIRE must name a live ADD of the same code. Two writers of
-- one code are put in line by a transaction-level advisory lock on the code,
-- taken before the check, so the second sees the first's committed row.
CREATE OR REPLACE FUNCTION nmwc_temix_route_map_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('TemixRouteMap:' || NEW."temixRouteCode", 0));
  IF NEW."action" = 'ADD' THEN
    IF EXISTS (SELECT 1 FROM public."TemixRouteMap" a
                WHERE a."temixRouteCode" = NEW."temixRouteCode" AND a."action" = 'ADD'
                  AND NOT EXISTS (SELECT 1 FROM public."TemixRouteMap" r WHERE r."retiresId" = a."id")) THEN
      RAISE EXCEPTION 'TemixRouteMap: % already has a live entry; retire it first', NEW."temixRouteCode"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public."TemixRouteMap" a
                     WHERE a."id" = NEW."retiresId" AND a."action" = 'ADD'
                       AND a."temixRouteCode" = NEW."temixRouteCode") THEN
    RAISE EXCEPTION 'TemixRouteMap: a RETIRE row must name an entry of the same code'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER temixroutemap_live_guard
  BEFORE INSERT ON "TemixRouteMap"
  FOR EACH ROW EXECUTE FUNCTION nmwc_temix_route_map_guard();

CREATE TRIGGER temixroutemap_append_only BEFORE UPDATE OR DELETE ON "TemixRouteMap" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER temixroutemap_no_truncate BEFORE TRUNCATE ON "TemixRouteMap" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- ── 8. The runtime role, where it exists ──────────────────────────────────
--
-- scripts/ops/app-role.ts `grant` re-applies the same after its blanket GRANT
-- (lib/temix-daily-tables.ts TEMIX_DAILY_LEDGERS). The files and rows: read,
-- insert and update, never delete. The ledgers: insert and read, never update
-- or delete; their id sequences usable (nextval) but not settable (setval).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "TemixDailyFile", "TemixDailyRow" TO nmwc_app;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TemixDailyFile", "TemixDailyRow" FROM nmwc_app;
    GRANT SELECT, INSERT ON "TemixChange", "TemixChangeReview", "TemixNoticeSeen", "TemixRouteMap" TO nmwc_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TemixChange", "TemixChangeReview", "TemixNoticeSeen", "TemixRouteMap" FROM nmwc_app;
    GRANT USAGE, SELECT ON SEQUENCE "TemixChange_id_seq", "TemixChangeReview_id_seq", "TemixNoticeSeen_id_seq", "TemixRouteMap_id_seq" TO nmwc_app;
    REVOKE UPDATE ON SEQUENCE "TemixChange_id_seq", "TemixChangeReview_id_seq", "TemixNoticeSeen_id_seq", "TemixRouteMap_id_seq" FROM nmwc_app;
  END IF;
END;
$$;

RESET lock_timeout;
