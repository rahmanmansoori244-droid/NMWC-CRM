-- Gap 18 (data audit 2026-10-10): where a request was raised, kept with it.
--
-- Reports and the Manager's audit view follow a request's route and region as
-- they are TODAY: a route handed over, or a shop moved, carries its past with it.
-- For a new customer the attribution at the time is already known (its draft
-- route, and that route's region: a route never changes region). For an update,
-- a close or a reactivation it was not stored at all, so it could never be
-- recovered later. Two columns now hold it, written once with the SUBMITTED state
-- (services/edits.ts, services/creates.ts, services/reactivations.ts;
-- lib/scope-at-submit.ts), and the sealed CREATE audit row carries them too:
--
--   routeIdAtSubmit    a new customer's draft route; otherwise the submitter's own
--                      route when he sent it (null if he held none);
--   regionIdsAtSubmit  the regions of the request's scope at that moment — the
--                      same rule the approval queue uses (requestScopeBranches),
--                      or the draft route's region.
--
-- Nothing reads them to decide who may see what: whether a Manager's /audit and
-- the region-scoped figures should follow the region at the time is the owner's
-- open question (04-PENDING-WORK A6). No backfill: older rows stay null and empty,
-- and docs/HISTORY.md gives the as-of query that answers them, marked inferred.
--
-- The route link is a foreign key, RESTRICT (a sent request is evidence), added
-- NOT VALID like gap 31's (docs/OPERATIONS.md section 5l): the column is new, so
-- no older row can break it, and it can be validated at any time.
--
-- The evidence guard (last defined in 20261014100000_lossless_paths) gains two
-- lines: neither column can change once the request was sent. Everything else in
-- it is as it was.
--
-- Additive: two nullable columns, one foreign key, one function replaced.

SET lock_timeout = '10s';

-- ── 1. The columns and the route link (Prisma's own DDL, NOT VALID) ────────

ALTER TABLE "CustomerEdit"
  ADD COLUMN "regionIdsAtSubmit" TEXT[],
  ADD COLUMN "routeIdAtSubmit" TEXT,
  ADD CONSTRAINT "CustomerEdit_routeIdAtSubmit_fkey"
    FOREIGN KEY ("routeIdAtSubmit") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- ── 2. What was sent is evidence: the two columns are frozen with the rest ──

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
