-- Lossless write paths (data audit 2026-10-10, gaps 4, 7, 8, 12, 14, 15, 19, 20
-- and 27; docs/HISTORY.md). Builds on 20261013100100_history_foundation.
--
-- Part A made the database write a dated history of every customer, shop, user,
-- route and region. Several paths still lost what they changed or what they
-- were about. This adds what the application code cannot keep on its own:
--
--   1. Customer.mergedIntoId (gap 8): the customer a duplicate merge folded this
--      one into. Captured in CustomerHistory like any other watched column, and
--      filled for the merges already made from their MERGE audit rows, each dated
--      when it happened (the history's effective time) and recorded now.
--   2. CustomerEdit.originalCustomerId (gap 8): the customer a request was first
--      about, set once by the database and never changed. A merge repoints a
--      request's customerId to the survivor; this keeps the truth. Filled for the
--      requests that exist from their APPROVE / REJECT / FINALIZE audit rows,
--      else their current customer.
--   3. The request as sent is evidence (gap 19): once a CustomerEdit leaves DRAFT
--      or NEEDS_CORRECTION, what it asked for, who sent it and when, its chain and
--      its gate can no longer change (customeredit_evidence_guard), and a request
--      can no longer be deleted (customeredit_no_delete / _no_truncate). Only the
--      owner's maintenance window gets through, as for AuditLog. Its state, its
--      decision, its SLA clock and its customerId still move as before.
--   4. EditRevision (gap 12): every round of a new-customer request, as sent.
--      Append-only; the application inserts it in the submit transaction.
--   5. AttachmentHistory (gap 15): every photo and document row in the dated
--      history, written by the database like part A's tables, with a first page
--      (BASELINE) for every photo that exists now and a DELETE tombstone when
--      photo-gc drops a row, so a replaced or removed photo keeps its link and
--      its fingerprint for ever. The capture GPS is never copied.
--   6. ExportJob becomes the append-only record of every export (gap 14): kind,
--      file SHA-256, filename and the customers it held.
--   7. ImportBatch.fileSha256 / fileBytes (gap 7), EditApproval.category (gap 12)
--      and EditBranchDraft.branchId (gap 27): plain new columns.
--
-- Everything is additive. No existing value is changed except the two new
-- columns' backfills. The new guards refuse future writes only.
--
-- COST: the AttachmentHistory baseline is one row per photo row (a few thousand
-- on production), the originalCustomerId backfill one indexed lookup per
-- request. Seconds. Customer, CustomerEdit and the other altered tables are
-- locked for the whole migration; deploy outside working hours, after part A.

SET lock_timeout = '10s';
-- One statement, in a fixed order: the tables this migration alters (ACCESS
-- EXCLUSIVE, which ALTER TABLE takes anyway), then Attachment, whose baseline and
-- capture triggers must not let a write fall between them.
LOCK TABLE "Customer", "CustomerEdit", "EditApproval", "EditBranchDraft", "ExportJob", "ImportBatch", "CustomerHistory" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "Attachment" IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. Columns and tables (Prisma's own DDL, so the CI drift gate matches) ──

ALTER TABLE "Customer" ADD COLUMN     "mergedIntoId" TEXT;

ALTER TABLE "CustomerEdit" ADD COLUMN     "originalCustomerId" TEXT;

ALTER TABLE "CustomerHistory" ADD COLUMN     "mergedIntoId" TEXT;

ALTER TABLE "EditApproval" ADD COLUMN     "category" TEXT;

ALTER TABLE "EditBranchDraft" ADD COLUMN     "branchId" TEXT;

ALTER TABLE "ExportJob" ADD COLUMN     "customerIds" TEXT[],
ADD COLUMN     "fileSha256" TEXT,
ADD COLUMN     "filename" TEXT,
ADD COLUMN     "kind" TEXT;

ALTER TABLE "ImportBatch" ADD COLUMN     "fileBytes" INTEGER,
ADD COLUMN     "fileSha256" TEXT;

CREATE TABLE "AttachmentHistory" (
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
    "attachmentId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "customerId" TEXT,
    "branchId" TEXT,
    "branchExtraId" TEXT,
    "editId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "hash" TEXT,
    "capturedById" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EditRevision" (
    "id" BIGSERIAL NOT NULL,
    "editId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "process" "EditProcess" NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "submittedById" TEXT NOT NULL,
    "paymentTerms" "PaymentTerms",
    "requestedCreditLimit" DECIMAL(14,3),
    "requestedPaymentTermDays" INTEGER,
    "approvalChain" JSONB,
    "payload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,

    CONSTRAINT "EditRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttachmentHistory_attachmentId_validFrom_id_idx" ON "AttachmentHistory"("attachmentId", "validFrom" DESC, "id" DESC);
CREATE INDEX "AttachmentHistory_customerId_validFrom_idx" ON "AttachmentHistory"("customerId", "validFrom");
CREATE INDEX "AttachmentHistory_branchId_validFrom_idx" ON "AttachmentHistory"("branchId", "validFrom");
CREATE INDEX "AttachmentHistory_hash_idx" ON "AttachmentHistory"("hash");
CREATE INDEX "AttachmentHistory_txId_idx" ON "AttachmentHistory"("txId");
CREATE INDEX "EditRevision_editId_cycle_idx" ON "EditRevision"("editId", "cycle");
CREATE INDEX "Customer_mergedIntoId_idx" ON "Customer"("mergedIntoId");
CREATE INDEX "CustomerEdit_originalCustomerId_idx" ON "CustomerEdit"("originalCustomerId");
CREATE INDEX "EditBranchDraft_branchId_idx" ON "EditBranchDraft"("branchId");

-- The 'sql' report reads only rows written with no cause (part A's convention).
CREATE INDEX "AttachmentHistory_unattributed_idx" ON "AttachmentHistory"("recordedAt") WHERE "sourceKind" = 'sql';

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditBranchDraft" ADD CONSTRAINT "EditBranchDraft_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. CustomerHistory records mergedIntoId (gap 8) ────────────────────────
--
-- The capture function of part A with one more watched, non-personal column, and
-- its UPDATE trigger re-created with that column in its WHEN clause. Same name,
-- same definer rights, same pinned search_path.

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
    IF o."mergedIntoId" IS DISTINCT FROM r."mergedIntoId" THEN f := f || 'mergedIntoId'::text; END IF;
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
    "customerId", "nmwcCode", "paymentTerms", "creditLimit", "paymentTermDays", "temixCode", "status", "channelId", "subChannelId", "crPhotoId", "deletedAt", "mergedIntoId")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."nmwcCode", r."paymentTerms", r."creditLimit", r."paymentTermDays", r."temixCode", r."status", r."channelId", r."subChannelId", r."crPhotoId", r."deletedAt", r."mergedIntoId");
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_history_customer() FROM PUBLIC;

DROP TRIGGER customer_history_capture_upd ON "Customer";
CREATE TRIGGER customer_history_capture_upd
  AFTER UPDATE ON "Customer"
  FOR EACH ROW
  WHEN ((OLD."nmwcCode", OLD."paymentTerms", OLD."creditLimit", OLD."paymentTermDays", OLD."temixCode", OLD."status",
         OLD."channelId", OLD."subChannelId", OLD."crPhotoId", OLD."deletedAt", OLD."mergedIntoId",
         OLD."legalName", OLD."crNumber", OLD."primaryPhone", OLD."altPhone", OLD."contactPerson", OLD."contactRole",
         OLD."email", OLD."notes")
        IS DISTINCT FROM
        (NEW."nmwcCode", NEW."paymentTerms", NEW."creditLimit", NEW."paymentTermDays", NEW."temixCode", NEW."status",
         NEW."channelId", NEW."subChannelId", NEW."crPhotoId", NEW."deletedAt", NEW."mergedIntoId",
         NEW."legalName", NEW."crNumber", NEW."primaryPhone", NEW."altPhone", NEW."contactPerson", NEW."contactRole",
         NEW."email", NEW."notes"))
  EXECUTE FUNCTION nmwc_history_customer();

-- ── 3. What a request was first about (gap 8) ─────────────────────────────
--
-- Backfill first: the customer named by the request's own decision row (APPROVE
-- and REJECT carry it when the writer put it there, FINALIZE names the customer a
-- new-customer request made), else the customer it points at now. A merge made
-- before this migration may already have repointed that one; the decision row,
-- never moved, is preferred for exactly that reason.

UPDATE "CustomerEdit" e
   SET "originalCustomerId" = COALESCE(
         (SELECT a."after"->>'customerId'
            FROM "AuditLog" a
           WHERE a."entityType" = 'CustomerEdit'
             AND a."entityId" = e."id"
             AND a."action" IN ('APPROVE', 'REJECT', 'FINALIZE')
             AND jsonb_typeof(a."after") = 'object'
             AND jsonb_typeof(a."after"->'customerId') = 'string'
           ORDER BY a."at", a."id"
           LIMIT 1),
         e."customerId")
 WHERE e."originalCustomerId" IS NULL;

-- Set once by the database: on INSERT from the request's customerId (whatever the
-- writer sent), on UPDATE from the first non-null customerId, and never changed
-- after, except by the table owner in a maintenance transaction. Not SECURITY
-- DEFINER: it reads nothing but its own row and the catalog.
CREATE OR REPLACE FUNCTION nmwc_customeredit_original_customer() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  owner_name name;
  maintenance boolean := false;
BEGIN
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
    maintenance := session_user = owner_name;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT maintenance THEN
      NEW."originalCustomerId" := NEW."customerId";
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."originalCustomerId" IS NOT NULL
     AND NEW."originalCustomerId" IS DISTINCT FROM OLD."originalCustomerId"
     AND NOT maintenance THEN
    RAISE EXCEPTION 'CustomerEdit %: originalCustomerId is set once and never changed (append-only). Only the table owner may change it, in a maintenance transaction (SET LOCAL nmwc.audit_maintenance = ''on'').',
      OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."originalCustomerId" IS NULL AND NEW."customerId" IS NOT NULL THEN
    NEW."originalCustomerId" := NEW."customerId";
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_customeredit_original_customer() FROM PUBLIC;

CREATE TRIGGER customeredit_original_customer
  BEFORE INSERT OR UPDATE OF "customerId", "originalCustomerId" ON "CustomerEdit"
  FOR EACH ROW EXECUTE FUNCTION nmwc_customeredit_original_customer();

-- ── 4. The merges already made (gap 8) ─────────────────────────────────────
--
-- Each loser named by a MERGE audit row (before.loser.id; the row's entityId is
-- the winner) gets mergedIntoId, if it is still archived, still unset, and the
-- winner still exists. Captured by the CustomerHistory trigger above under this
-- migration's source, with the merge's own time as the effective time: the history
-- reads "merged into W from <when it happened>", recorded now.

DO $$
DECLARE
  m record;
BEGIN
  PERFORM set_config('nmwc.actor', '', true);
  PERFORM set_config('nmwc.source', 'migration:20261014100000_lossless_paths', true);
  FOR m IN
    SELECT DISTINCT ON (a."before"->'loser'->>'id')
           a."before"->'loser'->>'id' AS loser_id,
           a."entityId" AS winner_id,
           a."at" AS merged_at
      FROM "AuditLog" a
     WHERE a."action" = 'MERGE'
       AND a."entityType" = 'Customer'
       AND jsonb_typeof(a."before") = 'object'
       AND jsonb_typeof(a."before"->'loser'->'id') = 'string'
     ORDER BY a."before"->'loser'->>'id', a."at" DESC, a."id" DESC
  LOOP
    PERFORM set_config('nmwc.effective_from', to_char(m.merged_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), true);
    UPDATE "Customer" c
       SET "mergedIntoId" = m.winner_id
     WHERE c."id" = m.loser_id
       AND c."id" <> m.winner_id
       AND c."mergedIntoId" IS NULL
       AND c."deletedAt" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "Customer" w WHERE w."id" = m.winner_id);
  END LOOP;
  PERFORM set_config('nmwc.effective_from', '', true);
  PERFORM set_config('nmwc.source', '', true);
END;
$$;

-- ── 5. Photos and documents in the dated history (gap 15) ──────────────────
--
-- The first page: one BASELINE row per Attachment row there is now, valid from
-- its createdAt, written before the capture triggers exist and under the lock
-- taken at the top, so no change falls between the two.

INSERT INTO "AttachmentHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
  "attachmentId", "kind", "customerId", "branchId", "branchExtraId", "editId", "deletedAt", "hash", "capturedById", "capturedAt")
SELECT 'BASELINE', '{}', a."createdAt", now() AT TIME ZONE 'UTC', NULL, NULL, 'migration:20261014100000_lossless_paths', 'migration', txid_current(), session_user,
  a."id", a."kind", a."customerId", a."branchId", a."branchExtraId", a."editId", a."deletedAt", a."hash", a."capturedById", a."capturedAt"
FROM "Attachment" a
ORDER BY a."createdAt", a."id";

-- As part A's capture functions: definer rights, pinned search_path, EXECUTE
-- revoked from PUBLIC, and it refuses to run on any table but its own. Watched:
-- where the photo is (customer, shop, extra slot, request), what it is, whether
-- it was removed, and its fingerprint. Who took it and when are copied as values;
-- where it was taken (capturedLat/Lng) never is.
CREATE OR REPLACE FUNCTION nmwc_history_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."Attachment"%ROWTYPE;
  o public."Attachment"%ROWTYPE;
  k public."HistoryChange";
  f text[] := '{}';
  ctx record;
  prev timestamp;
BEGIN
  IF TG_RELID <> 'public."Attachment"'::regclass THEN
    RAISE EXCEPTION 'nmwc_history_attachment() runs only on "Attachment"';
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW; k := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    r := OLD; k := 'DELETE';
  ELSE
    r := NEW; o := OLD; k := 'UPDATE';
    IF o."kind" IS DISTINCT FROM r."kind" THEN f := f || 'kind'::text; END IF;
    IF o."customerId" IS DISTINCT FROM r."customerId" THEN f := f || 'customerId'::text; END IF;
    IF o."branchId" IS DISTINCT FROM r."branchId" THEN f := f || 'branchId'::text; END IF;
    IF o."branchExtraId" IS DISTINCT FROM r."branchExtraId" THEN f := f || 'branchExtraId'::text; END IF;
    IF o."editId" IS DISTINCT FROM r."editId" THEN f := f || 'editId'::text; END IF;
    IF o."deletedAt" IS DISTINCT FROM r."deletedAt" THEN f := f || 'deletedAt'::text; END IF;
    IF o."hash" IS DISTINCT FROM r."hash" THEN f := f || 'hash'::text; END IF;
  END IF;
  SELECT * INTO ctx FROM public.nmwc_change_ctx();
  SELECT h."validFrom" INTO prev FROM public."AttachmentHistory" h
   WHERE h."attachmentId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;
  INSERT INTO public."AttachmentHistory" ("changeKind", "changedFields", "validFrom", "recordedAt", "effectiveRequested", "actorId", "source", "sourceKind", "txId", "dbUser",
    "attachmentId", "kind", "customerId", "branchId", "branchExtraId", "editId", "deletedAt", "hash", "capturedById", "capturedAt")
  VALUES (k, f, GREATEST(ctx.valid_from, prev), ctx.recorded_at, ctx.effective_requested, ctx.actor_id, ctx.source, ctx.source_kind, ctx.tx_id, ctx.db_user,
    r."id", r."kind", r."customerId", r."branchId", r."branchExtraId", r."editId", r."deletedAt", r."hash", r."capturedById", r."capturedAt");
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_history_attachment() FROM PUBLIC;

CREATE TRIGGER attachment_history_capture
  AFTER INSERT OR DELETE ON "Attachment"
  FOR EACH ROW EXECUTE FUNCTION nmwc_history_attachment();
CREATE TRIGGER attachment_history_capture_upd
  AFTER UPDATE ON "Attachment"
  FOR EACH ROW
  WHEN ((OLD."kind", OLD."customerId", OLD."branchId", OLD."branchExtraId", OLD."editId", OLD."deletedAt", OLD."hash")
        IS DISTINCT FROM
        (NEW."kind", NEW."customerId", NEW."branchId", NEW."branchExtraId", NEW."editId", NEW."deletedAt", NEW."hash"))
  EXECUTE FUNCTION nmwc_history_attachment();

-- Protected exactly as part A's history tables (after the baseline above).
CREATE TRIGGER attachmenthistory_append_only BEFORE UPDATE OR DELETE ON "AttachmentHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER attachmenthistory_no_truncate BEFORE TRUNCATE ON "AttachmentHistory" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER attachmenthistory_insert_guard BEFORE INSERT ON "AttachmentHistory" FOR EACH ROW EXECUTE FUNCTION nmwc_history_insert_guard();

-- ── 6. A request, once sent, is evidence (gap 19) ──────────────────────────
--
-- What a request asked for, who sent it and when, the chain and the gate frozen
-- on it are what every decision on it was made against. Once it has left DRAFT
-- or NEEDS_CORRECTION they may no longer change. Every writer in the application
-- changes only the state, the decision, the SLA clock or the customer (a merge,
-- a finalize) after that point; a new-customer request sent back is re-sent from
-- NEEDS_CORRECTION, which stays open, and each round is kept in EditRevision.
--
-- One exception that is not a rewrite: a shop hard-deleted by the owner nulls
-- branchId through its foreign key (ON DELETE SET NULL). That is allowed when the
-- shop no longer exists; the request's own CREATE audit row keeps its id.
-- The owner's maintenance window gets through, as on AuditLog.

CREATE OR REPLACE FUNCTION nmwc_customeredit_evidence_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  owner_name name;
  changed text[] := '{}';
BEGIN
  IF OLD."state" IN ('DRAFT', 'NEEDS_CORRECTION') THEN
    RETURN NEW;
  END IF;
  IF NEW."fieldChanges" IS DISTINCT FROM OLD."fieldChanges" THEN changed := changed || 'fieldChanges'::text; END IF;
  IF NEW."attachmentChanges" IS DISTINCT FROM OLD."attachmentChanges" THEN changed := changed || 'attachmentChanges'::text; END IF;
  IF NEW."submittedById" IS DISTINCT FROM OLD."submittedById" THEN changed := changed || 'submittedById'::text; END IF;
  IF NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN changed := changed || 'submittedAt'::text; END IF;
  IF NEW."process" IS DISTINCT FROM OLD."process" THEN changed := changed || 'process'::text; END IF;
  IF NEW."target" IS DISTINCT FROM OLD."target" THEN changed := changed || 'target'::text; END IF;
  IF NEW."submitGate" IS DISTINCT FROM OLD."submitGate" THEN changed := changed || 'submitGate'::text; END IF;
  IF NEW."isReactivation" IS DISTINCT FROM OLD."isReactivation" THEN changed := changed || 'isReactivation'::text; END IF;
  IF NEW."isWrongRoute" IS DISTINCT FROM OLD."isWrongRoute" THEN changed := changed || 'isWrongRoute'::text; END IF;
  IF NEW."newRouteId" IS DISTINCT FROM OLD."newRouteId" THEN changed := changed || 'newRouteId'::text; END IF;
  IF NEW."paymentTermsAtSubmit" IS DISTINCT FROM OLD."paymentTermsAtSubmit" THEN changed := changed || 'paymentTermsAtSubmit'::text; END IF;
  IF NEW."approvalChain" IS DISTINCT FROM OLD."approvalChain" THEN changed := changed || 'approvalChain'::text; END IF;
  IF NEW."requestedCreditLimit" IS DISTINCT FROM OLD."requestedCreditLimit" THEN changed := changed || 'requestedCreditLimit'::text; END IF;
  IF NEW."requestedPaymentTermDays" IS DISTINCT FROM OLD."requestedPaymentTermDays" THEN changed := changed || 'requestedPaymentTermDays'::text; END IF;
  IF NEW."cycle" IS DISTINCT FROM OLD."cycle" THEN changed := changed || 'cycle'::text; END IF;
  IF NEW."submissionId" IS DISTINCT FROM OLD."submissionId" THEN changed := changed || 'submissionId'::text; END IF;
  IF NEW."branchId" IS DISTINCT FROM OLD."branchId"
     AND NOT (NEW."branchId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM public."Branch" b WHERE b."id" = OLD."branchId")) THEN
    changed := changed || 'branchId'::text;
  END IF;
  IF cardinality(changed) = 0 THEN
    RETURN NEW;
  END IF;
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
    IF session_user = owner_name THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'CustomerEdit %: % cannot change once the request was sent (state %) — what was sent is evidence, append-only. Only the table owner may change it, in a maintenance transaction (SET LOCAL nmwc.audit_maintenance = ''on'').',
    OLD."id", array_to_string(changed, ', '), OLD."state"
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE EXECUTE ON FUNCTION nmwc_customeredit_evidence_guard() FROM PUBLIC;

CREATE TRIGGER customeredit_evidence_guard
  BEFORE UPDATE ON "CustomerEdit"
  FOR EACH ROW EXECUTE FUNCTION nmwc_customeredit_evidence_guard();
-- A request is never deleted (the runtime role already holds no DELETE on it); the
-- owner's maintenance window is the only way, as for the ledger it cascades into.
CREATE TRIGGER customeredit_no_delete BEFORE DELETE ON "CustomerEdit" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER customeredit_no_truncate BEFORE TRUNCATE ON "CustomerEdit" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- ── 7. The ledgers the application writes (gaps 12 and 14) ─────────────────
--
-- EditRevision and ExportJob: the application inserts, nothing updates or deletes.

CREATE TRIGGER editrevision_append_only BEFORE UPDATE OR DELETE ON "EditRevision" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER editrevision_no_truncate BEFORE TRUNCATE ON "EditRevision" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER exportjob_append_only BEFORE UPDATE OR DELETE ON "ExportJob" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation();
CREATE TRIGGER exportjob_no_truncate BEFORE TRUNCATE ON "ExportJob" FOR EACH STATEMENT EXECUTE FUNCTION nmwc_forbid_audit_mutation();

-- The runtime role, where it exists (scripts/ops/app-role.ts `grant` re-applies
-- the same after its blanket GRANT): AttachmentHistory like part A's history,
-- read only, its sequence out of reach; EditRevision and ExportJob insert-only,
-- and the EditRevision sequence usable (nextval) but not settable (setval).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nmwc_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "AttachmentHistory" FROM nmwc_app;
    REVOKE ALL ON SEQUENCE "AttachmentHistory_id_seq" FROM nmwc_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "EditRevision", "ExportJob" FROM nmwc_app;
    REVOKE UPDATE ON SEQUENCE "EditRevision_id_seq" FROM nmwc_app;
  END IF;
END;
$$;

-- ── 8. The 'sql' report covers the photo history too ──────────────────────

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
  ) u
  GROUP BY 1, 2, 3
  ORDER BY 2 DESC, 1, 3
$$;

RESET lock_timeout;
