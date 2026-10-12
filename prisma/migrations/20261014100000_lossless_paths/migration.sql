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
--      else their current customer — except where an earlier merge makes that a
--      guess: then NULL ("not known"), unless the merge's own auto-close named
--      the loser.
--   3. The request as sent is evidence (gap 19): once a CustomerEdit leaves DRAFT
--      or NEEDS_CORRECTION, what it asked for, who sent it and when, its chain and
--      its gate can no longer change (customeredit_evidence_guard), and a request
--      can no longer be deleted (customeredit_no_delete / _no_truncate). Only the
--      owner's maintenance window gets through, as for AuditLog. Its decision,
--      its SLA clock and its customerId still move as before, and its state
--      moves only forward: a decided request is never reopened, and a sent one
--      goes back to its sender only as NEEDS_CORRECTION, never as a DRAFT.
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
--   8. Part A's as-of answers about a customer name the customer it was merged
--      into (merged_into_id), and "who served X" says so when X was merged away
--      rather than answering nothing (section 9).
--
-- Everything is additive. No existing value is changed except the two new
-- columns' backfills. The new guards refuse future writes only.
--
-- COST: the AttachmentHistory baseline is one row per photo row (a few thousand
-- on production), the originalCustomerId backfill one indexed lookup per
-- request. Seconds. Customer, CustomerEdit and the other altered tables are
-- locked for the whole migration; deploy outside working hours, after part A.
-- Refused by a lock, it rolls back whole and must be marked rolled back before
-- the next deploy (docs/OPERATIONS.md §5, "A migration refused by a lock").

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
--
-- Best effort, and said so: where the value can only be a guess it is left NULL
-- ("not known"), never filled with a customer that may be the wrong one. A merge
-- moved every request of the loser to the winner and kept no list of them, so a
-- request now on a merge's winner, made before that merge, whose customer is not
-- named by a decision row dated before the merge, may have been the loser's or
-- the winner's. Those are resolved only where the merge said so itself: the
-- loser's open request it closed carries "Auto-closed: customer <loser> merged
-- into <winner>." (services/duplicates.ts before this migration), which names
-- the loser. The rest stay NULL; the counts are in the deploy log.

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

-- The guesses, taken back (see above). Each merge row names its winner, its loser
-- and both codes as they were (before.loser / before.winner, entityId = winner).
DO $$
DECLARE
  from_reason bigint;
  unknown bigint;
BEGIN
  WITH merges AS (
    SELECT a."entityId" AS winner_id,
           a."before"->'loser'->>'id' AS loser_id,
           a."before"->'loser'->>'nmwcCode' AS loser_code,
           a."before"->'winner'->>'nmwcCode' AS winner_code,
           a."at" AS merged_at
      FROM "AuditLog" a
     WHERE a."action" = 'MERGE'
       AND a."entityType" = 'Customer'
       AND jsonb_typeof(a."before") = 'object'
       AND jsonb_typeof(a."before"->'loser'->'id') = 'string'
  ),
  unsure AS (
    SELECT e."id",
           (SELECT m.loser_id
              FROM merges m
             WHERE e."state" = 'REJECTED'
               AND e."decisionReason" = 'Auto-closed: customer ' || m.loser_code || ' merged into ' || m.winner_code || '.'
             ORDER BY m.merged_at
             LIMIT 1) AS loser_id
      FROM "CustomerEdit" e
     WHERE EXISTS (
             SELECT 1
               FROM merges m
              WHERE m.winner_id = e."originalCustomerId"
                AND e."createdAt" < m.merged_at
                AND NOT EXISTS (
                      SELECT 1
                        FROM "AuditLog" d
                       WHERE d."entityType" = 'CustomerEdit'
                         AND d."entityId" = e."id"
                         AND d."action" IN ('APPROVE', 'REJECT', 'FINALIZE')
                         AND jsonb_typeof(d."after") = 'object'
                         AND jsonb_typeof(d."after"->'customerId') = 'string'
                         AND d."at" < m.merged_at))
  ),
  taken AS (
    UPDATE "CustomerEdit" e
       SET "originalCustomerId" = u.loser_id
      FROM unsure u
     WHERE u."id" = e."id"
    RETURNING e."originalCustomerId"
  )
  SELECT count(*) FILTER (WHERE t."originalCustomerId" IS NOT NULL),
         count(*) FILTER (WHERE t."originalCustomerId" IS NULL)
    INTO from_reason, unknown
    FROM taken t;
  RAISE NOTICE 'lossless_paths: originalCustomerId of % request(s) on a merged customer: % named by the merge that closed them, % left unknown (NULL)',
    from_reason + unknown, from_reason, unknown;
END;
$$;

-- Set once by the database: on INSERT from the request's customerId (whatever the
-- writer sent), on UPDATE from the request's FIRST customer (a new-customer
-- request gets one at finalize; customerId was null until then), and never
-- changed after, except by the table owner in a maintenance transaction. A
-- request whose original customer the back-fill above could not know stays NULL:
-- a later repoint of its customerId is not its first customer. Not SECURITY
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
  IF NEW."originalCustomerId" IS NULL AND OLD."customerId" IS NULL AND NEW."customerId" IS NOT NULL THEN
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
-- reads "merged into W from <when it happened>", recorded now. The row's other
-- values (terms, status, channel) are the loser's as found now, not as they were
-- at the merge: the as-of functions flag a row a migration wrote as inferred for
-- any time before it was recorded, as they do the baseline.

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
--
-- The state moves only forward, or the freeze could be stepped around: move a
-- sent or decided request back to an open state, rewrite it, move it back. So a
-- decided request (APPROVED, REJECTED) stays decided, a sent one (SUBMITTED) goes
-- back to its sender only as NEEDS_CORRECTION — the send-back, which writes its
-- REJECT row, and for a new-customer request each round is kept in EditRevision
-- — never as a DRAFT, and an open one (DRAFT, NEEDS_CORRECTION) is approved only
-- once sent. Every writer in the application keeps to this: submit, re-save as
-- draft and resubmit (DRAFT/NEEDS_CORRECTION -> DRAFT/SUBMITTED), an approval
-- step (SUBMITTED -> SUBMITTED/APPROVED), a send-back or step-back (SUBMITTED ->
-- NEEDS_CORRECTION/SUBMITTED), a rejection, a withdrawal, a merge's auto-close and
-- an account change's close of a stranded request (-> REJECTED).
-- The owner's maintenance window gets through, as on AuditLog.

CREATE OR REPLACE FUNCTION nmwc_customeredit_evidence_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  owner_name name;
  changed text[] := '{}';
  refused text;
BEGIN
  IF NEW."state" <> OLD."state"
     AND (OLD."state" IN ('APPROVED', 'REJECTED')
          OR (OLD."state" = 'SUBMITTED' AND NEW."state" = 'DRAFT')
          OR (OLD."state" IN ('DRAFT', 'NEEDS_CORRECTION') AND NEW."state" = 'APPROVED')) THEN
    refused := format('its state cannot go from %s to %s: a decided request stays decided, a sent one goes back to its sender only as NEEDS_CORRECTION, and an open one is approved only once sent',
      OLD."state", NEW."state");
  ELSIF OLD."state" IN ('DRAFT', 'NEEDS_CORRECTION') THEN
    RETURN NEW;
  ELSE
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
    refused := format('%s cannot change once the request was sent (state %s)', array_to_string(changed, ', '), OLD."state");
  END IF;
  IF current_setting('nmwc.audit_maintenance', true) = 'on' THEN
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
    IF session_user = owner_name THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'CustomerEdit %: % — what was sent is evidence, append-only. Only the table owner may change it, in a maintenance transaction (SET LOCAL nmwc.audit_maintenance = ''on'').',
    OLD."id", refused
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

-- ── 9. The as-of answers say when a customer was merged (gap 8) ──────────
--
-- Part A's customer answers, with the same columns, now filling merged_into_id
-- from the history (part A returns it null: the column is this migration's). The
-- two "who served customer X" answers also say so when X had been merged away:
-- its shops were then the winner's, so no shop names X, and an empty answer would
-- read as "nobody served it".
--   nmwc_customer_service_on(X, d): one row with no shop, note 'merged' and the
--     winner in merged_into_id, when X's own row on d says it was merged and no
--     shop names X on d.
--   nmwc_customer_route_intervals(X): one row with no shop for each stretch X
--     stood merged into a customer (note 'merged'); the 'no-shop-recorded' row of
--     part A then ends where the first such stretch begins.
-- inferred / from_inferred follow part A's rule: a row a migration wrote (the
-- baseline, or section 4's merge back-fill) for a time before it was recorded.

CREATE OR REPLACE FUNCTION nmwc_customers_at(p_at timestamp)
RETURNS TABLE (
  customer_id text, nmwc_code text, payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer,
  temix_code text, status "CustomerStatus", channel_id text, sub_channel_id text, cr_photo_id text, deleted_at timestamp,
  merged_into_id text,
  valid_from timestamp, history_id bigint, change_kind "HistoryChange", source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."customerId", h."nmwcCode", h."paymentTerms", h."creditLimit", h."paymentTermDays",
         h."temixCode", h."status", h."channelId", h."subChannelId", h."crPhotoId", h."deletedAt",
         h."mergedIntoId",
         h."validFrom", h."id", h."changeKind", h."source", h."actorId",
         ((h."changeKind" = 'BASELINE' OR h."sourceKind" = 'migration') AND p_at < h."recordedAt")
  FROM (
    SELECT DISTINCT ON (x."customerId") x.*
    FROM public."CustomerHistory" x
    WHERE x."validFrom" <= p_at
    ORDER BY x."customerId", x."validFrom" DESC, x."id" DESC
  ) h
  WHERE h."changeKind" <> 'DELETE'
$$;

CREATE OR REPLACE FUNCTION nmwc_customer_terms_on(p_customer_id text, d date)
RETURNS TABLE (
  payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer, temix_code text,
  status "CustomerStatus", channel_id text, sub_channel_id text, deleted_at timestamp, merged_into_id text,
  valid_from timestamp, source text, actor_id text, inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT x."paymentTerms", x."creditLimit", x."paymentTermDays", x."temixCode",
         x."status", x."channelId", x."subChannelId", x."deletedAt", x."mergedIntoId",
         x."validFrom", x."source", x."actorId",
         ((x."changeKind" = 'BASELINE' OR x."sourceKind" = 'migration')
          AND public.nmwc_day_end(d) - interval '1 millisecond' < x."recordedAt")
  FROM (
    SELECT h.* FROM public."CustomerHistory" h
    WHERE h."customerId" = p_customer_id AND h."validFrom" <= public.nmwc_day_end(d) - interval '1 millisecond'
    ORDER BY h."validFrom" DESC, h."id" DESC
    LIMIT 1
  ) x
  WHERE x."changeKind" <> 'DELETE'
$$;

CREATE OR REPLACE FUNCTION nmwc_customer_intervals(p_customer_id text)
RETURNS TABLE (
  history_id bigint, change_kind "HistoryChange", valid_from timestamp, valid_to timestamp,
  recorded_at timestamp, effective_requested timestamp, changed_fields text[], source text, actor_id text,
  nmwc_code text, payment_terms "PaymentTerms", credit_limit numeric, payment_term_days integer, temix_code text,
  status "CustomerStatus", channel_id text, sub_channel_id text, deleted_at timestamp, merged_into_id text,
  from_inferred boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT h."id", h."changeKind", h."validFrom", lead(h."validFrom") OVER w,
         h."recordedAt", h."effectiveRequested", h."changedFields", h."source", h."actorId",
         h."nmwcCode", h."paymentTerms", h."creditLimit", h."paymentTermDays", h."temixCode",
         h."status", h."channelId", h."subChannelId", h."deletedAt", h."mergedIntoId",
         (h."changeKind" = 'BASELINE' OR h."sourceKind" = 'migration') AND h."validFrom" < h."recordedAt"
  FROM public."CustomerHistory" h
  WHERE h."customerId" = p_customer_id
  WINDOW w AS (ORDER BY h."validFrom", h."id")
  ORDER BY h."validFrom", h."id"
$$;

CREATE OR REPLACE FUNCTION nmwc_customer_service_on(p_customer_id text, d date)
RETURNS TABLE (
  branch_id text, branch_code text, route_id text, route_code text, region_id text, region_code text,
  day_of_visit "DayOfWeek", branch_status "CustomerStatus",
  salesman_id text, salesman_username text, salesman_active boolean, inferred boolean,
  merged_into_id text, note text
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
  ),
  served AS (
    SELECT b."branchId" AS shop_id, b."branchCode" AS shop_code, b."routeId" AS shop_route_id, rt.code AS shop_route_code,
           b."regionId" AS shop_region_id, rg.code AS shop_region_code,
           b."dayOfVisit" AS shop_day, b."status" AS shop_status,
           ow."ownerId" AS holder_id, us."username" AS holder_username, us."isActive" AS holder_active,
           (((b."changeKind" = 'BASELINE' OR b."sourceKind" = 'migration') AND t.at_ts < b."recordedAt")
            OR ((ow."changeKind" = 'BASELINE' OR ow."sourceKind" = 'migration') AND t.at_ts < ow."recordedAt")
            OR ((us."changeKind" = 'BASELINE' OR us."sourceKind" = 'migration') AND t.at_ts < us."recordedAt")) IS TRUE AS shop_inferred
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
  ),
  -- The customer's own row then.
  c AS (
    SELECT h.* FROM public."CustomerHistory" h, t
    WHERE h."customerId" = p_customer_id AND h."validFrom" <= t.at_ts
    ORDER BY h."validFrom" DESC, h."id" DESC
    LIMIT 1
  ),
  cnow AS (
    SELECT c."mergedIntoId" AS merged_into,
           ((c."changeKind" = 'BASELINE' OR c."sourceKind" = 'migration') AND t.at_ts < c."recordedAt") AS row_inferred
    FROM c
    CROSS JOIN t
    WHERE c."changeKind" <> 'DELETE'
  )
  SELECT s.*, (SELECT n.merged_into FROM cnow n), NULL::text FROM served s
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         n.row_inferred, n.merged_into,
         CASE WHEN n.merged_into IS NOT NULL THEN 'merged' ELSE 'no-shop-recorded' END
  FROM cnow n
  WHERE (n.merged_into IS NOT NULL OR n.row_inferred)
    AND NOT EXISTS (SELECT 1 FROM served)
  ORDER BY 2
$$;

CREATE OR REPLACE FUNCTION nmwc_customer_route_intervals(p_customer_id text)
RETURNS TABLE (
  branch_id text, branch_code text, route_id text, route_code text,
  salesman_id text, salesman_username text, valid_from timestamp, valid_to timestamp, from_inferred boolean,
  merged_into_id text, note text
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
           (array_agg(CASE WHEN g."changeKind" = 'BASELINE' OR g."sourceKind" = 'migration' THEN g."recordedAt" END
                      ORDER BY g."validFrom", g."id"))[1] AS inferred_until
    FROM grouped g
    GROUP BY g."branchId", g."routeId", g.island
  ),
  owners AS (
    SELECT o."routeId" AS route_id, o."ownerId" AS owner_id, o."validFrom" AS owner_from, o.owner_to,
           CASE WHEN o."changeKind" = 'BASELINE' OR o."sourceKind" = 'migration' THEN o."recordedAt" END AS inferred_until
    FROM (
      SELECT h.*, lead(h."validFrom") OVER (PARTITION BY h."routeId" ORDER BY h."validFrom", h."id") AS owner_to
      FROM public."RouteOwnerHistory" h
      WHERE h."routeId" IN (SELECT route_id FROM islands)
    ) o
    WHERE o.owner_to IS NULL OR o.owner_to > o."validFrom"
  ),
  first_owner AS (
    SELECT ow.route_id, min(ow.owner_from) AS owner_from FROM owners ow GROUP BY ow.route_id
  ),
  pieces AS (
    SELECT i.branch_id, i.branch_code, i.route_id, ow.owner_id,
           tsrange(i.island_from, i.island_to) * tsrange(ow.owner_from, ow.owner_to) AS span,
           i.inferred_until AS island_inferred_until, ow.inferred_until AS owner_inferred_until,
           NULL::text AS note
    FROM islands i
    JOIN owners ow
      ON ow.route_id = i.route_id
     AND tsrange(ow.owner_from, ow.owner_to) && tsrange(i.island_from, i.island_to)
    UNION ALL
    SELECT i.branch_id, i.branch_code, i.route_id, NULL::text,
           tsrange(i.island_from, i.island_to) * tsrange(NULL, f.owner_from),
           i.inferred_until, NULL::timestamp,
           'holder-unrecorded'
    FROM islands i
    LEFT JOIN first_owner f ON f.route_id = i.route_id
    WHERE f.owner_from IS NULL OR i.island_from < f.owner_from
  ),
  shops AS (
    SELECT p.branch_id, p.branch_code, p.route_id, rt."code" AS route_code, p.owner_id, us."username" AS owner_username,
           lower(p.span) AS span_from, upper(p.span) AS span_to,
           (lower(p.span) < p.island_inferred_until OR lower(p.span) < p.owner_inferred_until) IS TRUE AS span_inferred,
           p.note
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
  ),
  -- X's own rows, and the stretches it stood merged into one customer.
  own AS (
    SELECT h."id", h."validFrom", h."recordedAt", h."changeKind", h."sourceKind",
           CASE WHEN h."changeKind" = 'DELETE' THEN NULL ELSE h."mergedIntoId" END AS merged_into,
           lead(h."validFrom") OVER (ORDER BY h."validFrom", h."id") AS valid_to
    FROM public."CustomerHistory" h
    WHERE h."customerId" = p_customer_id
  ),
  own_marked AS (
    SELECT o.*,
           CASE WHEN lag(o.merged_into) OVER (ORDER BY o."validFrom", o."id") IS DISTINCT FROM o.merged_into
                THEN 1 ELSE 0 END AS starts
    FROM own o
  ),
  own_grouped AS (
    SELECT o.*, sum(o.starts) OVER (ORDER BY o."validFrom", o."id") AS grp
    FROM own_marked o
  ),
  merged AS (
    SELECT g.merged_into,
           min(g."validFrom") AS merged_from,
           (array_agg(g.valid_to ORDER BY g."validFrom" DESC, g."id" DESC))[1] AS merged_to,
           (array_agg(CASE WHEN g."changeKind" = 'BASELINE' OR g."sourceKind" = 'migration' THEN g."recordedAt" END
                      ORDER BY g."validFrom", g."id"))[1] AS inferred_until
    FROM own_grouped g
    WHERE g.merged_into IS NOT NULL
    GROUP BY g.merged_into, g.grp
  ),
  first_page AS (
    SELECT c."validFrom" AS page_from,
           LEAST(c."recordedAt", (SELECT min(m.merged_from) FROM merged m)) AS page_to,
           c."recordedAt" AS page_recorded
    FROM (
      SELECT h.* FROM public."CustomerHistory" h WHERE h."customerId" = p_customer_id
      ORDER BY h."validFrom", h."id" LIMIT 1
    ) c
    WHERE (c."changeKind" = 'BASELINE' OR c."sourceKind" = 'migration') AND c."validFrom" < c."recordedAt"
  )
  SELECT s.branch_id, s.branch_code, s.route_id, s.route_code, s.owner_id, s.owner_username,
         s.span_from, s.span_to, s.span_inferred, NULL::text, s.note
  FROM shops s
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, NULL, NULL, m.merged_from, m.merged_to,
         (m.merged_from < m.inferred_until) IS TRUE, m.merged_into, 'merged'
  FROM merged m
  WHERE m.merged_to IS NULL OR m.merged_to > m.merged_from
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, NULL, NULL, fp.page_from, fp.page_to, true, NULL, 'no-shop-recorded'
  FROM first_page fp
  WHERE fp.page_to > fp.page_from
    AND NOT EXISTS (SELECT 1 FROM shops s WHERE s.span_from < fp.page_recorded)
  ORDER BY 7, 2
$$;

RESET lock_timeout;
