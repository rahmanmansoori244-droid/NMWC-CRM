-- Code review 2026-11-10, finding 18: a request kept only one "reason" line.
--
-- CustomerEdit.decisionReason held three unrelated things: the SALESMAN's own
-- reason on a close or reactivation request (written when he sent it), the LATEST
-- approver's reason on a new-customer or update request (overwritten by every
-- rejection, and left behind on a request that then moved on and was approved),
-- and the note on a request closed with no decision (withdrawn, auto-closed by a
-- merge). So a merge that auto-closed a pending close request replaced the
-- salesman's reason with its own sentence, and an approved request could show an
-- old send-back reason as if it were current.
--
-- The requester's own reason gets its own column, written once with the request
-- (services/reactivations.ts) and frozen with the rest of what was sent. Every
-- approver's reason already lives on his decision (EditApproval.reason, append-
-- only); screens and notifications read it from there (lib/request-reasons.ts).
-- decisionReason stays, for the closure note and a copy of the latest send-back
-- while a request stands sent back. This migration never changes it.
--
-- BACK-FILL: only what is unambiguous is copied; everything else stays NULL.
--   2a  a close or reactivation request whose CREATE row in the ledger carries
--       `requestReason` (requests sent since 2026-10-12, lib/request-evidence.ts):
--       that row is the sealed copy of the request as it was sent. This also
--       RECOVERS a reason a merge's auto-close has since overwritten.
--   2b  a close or reactivation request still SUBMITTED, or APPROVED: the only
--       writer that ever set decisionReason on such a row is its own submit.
--       Every writer that overwrote it also moved the row out of these states
--       (a send-back before 2026-10-07 -> NEEDS_CORRECTION, a merge -> REJECTED).
--   2c  a close or reactivation request REJECTED with its own REJECTED decision
--       row: refused by a reviewer on the path that keeps the salesman's reason
--       (since 2026-10-07). A merge closes only SUBMITTED rows, which have no
--       REJECTED decision row; its sentence is excluded by name all the same.
-- Left NULL:
--   - close / reactivation requests in NEEDS_CORRECTION (refused before
--     2026-10-07: the reviewer's words replaced the salesman's; not recoverable);
--   - REJECTED close / reactivation requests with no REJECTED decision row and no
--     ledger copy (auto-closed by a merge, or a reactivation kept closed between
--     7 and 15 Oct 2026 that was sent before 12 Oct: nothing structural tells
--     these apart);
--   - every update and new-customer request (they have no request-level reason).
-- The application reads the older rows the same way (requestReasonOf).
--
-- The back-fill runs BEFORE the evidence guard below is replaced, while the
-- column is not yet one the guard compares, so it needs no maintenance bypass
-- and uses none.
--
-- The evidence guard (last defined in 20261025090100_request_scope_at_submit)
-- gains ONE line: requestReason cannot change once the request was sent.
-- Everything else in it is as it was.
--
-- Additive: one nullable column, three back-fill updates of that column only,
-- one function replaced.

SET lock_timeout = '10s';

-- ── 1. The column (Prisma's own DDL) ───────────────────────────────────────

ALTER TABLE "CustomerEdit" ADD COLUMN "requestReason" TEXT;

-- ── 2. Back-fill: only the rows whose reason is the requester's beyond doubt ─

-- 2a. The request as it was sent, from the ledger.
UPDATE "CustomerEdit" e
   SET "requestReason" = s.reason
  FROM (
    SELECT DISTINCT ON (a."entityId")
           a."entityId" AS edit_id,
           a."after"->>'requestReason' AS reason
      FROM "AuditLog" a
     WHERE a."entityType" = 'CustomerEdit'
       AND a."action" = 'CREATE'
       AND jsonb_typeof(a."after"->'requestReason') = 'string'
       AND btrim(a."after"->>'requestReason') <> ''
     ORDER BY a."entityId", a."at", a."id"
  ) s
 WHERE e."id" = s.edit_id
   AND e."target" = 'BRANCH'
   AND e."requestReason" IS NULL;

-- 2b. Still waiting, or approved.
UPDATE "CustomerEdit"
   SET "requestReason" = "decisionReason"
 WHERE "requestReason" IS NULL
   AND "target" = 'BRANCH'
   AND "state" IN ('SUBMITTED', 'APPROVED')
   AND btrim(coalesce("decisionReason", '')) <> '';

-- 2c. Refused by a reviewer on the path that keeps the salesman's reason.
UPDATE "CustomerEdit" e
   SET "requestReason" = e."decisionReason"
 WHERE e."requestReason" IS NULL
   AND e."target" = 'BRANCH'
   AND e."state" = 'REJECTED'
   AND btrim(coalesce(e."decisionReason", '')) <> ''
   AND e."decisionReason" NOT LIKE 'Auto-closed: customer %'
   AND EXISTS (
     SELECT 1 FROM "EditApproval" d
      WHERE d."editId" = e."id" AND d."decision" = 'REJECTED');

-- ── 3. What was sent is evidence: the column is frozen with the rest ────────

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
    IF NEW."routeIdAtSubmit" IS DISTINCT FROM OLD."routeIdAtSubmit" THEN changed := changed || 'routeIdAtSubmit'::text; END IF;
    IF NEW."regionIdsAtSubmit" IS DISTINCT FROM OLD."regionIdsAtSubmit" THEN changed := changed || 'regionIdsAtSubmit'::text; END IF;
    IF NEW."requestReason" IS DISTINCT FROM OLD."requestReason" THEN changed := changed || 'requestReason'::text; END IF;
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

RESET lock_timeout;
