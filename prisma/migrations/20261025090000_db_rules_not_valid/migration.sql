-- Gap 31 (data audit 2026-10-10): the rules the application keeps, kept by the
-- database too.
--
-- The application refuses credit figures on a cash customer, a sub-channel of
-- another channel (or with no channel), a shop outside Oman, a location with one
-- coordinate, an accuracy or an equipment count out of range, and a phone or CR
-- de-duplication key in a shape its normaliser never writes. The database did
-- not, so an import, a script or a future screen could store any of them. And
-- several links had no foreign key: the photos' customer and shop, the
-- notifications' customer (232 orphans on UAT), the creator and last editor of a
-- customer and of a shop, a customer's import and Temix batches, a request's
-- original customer and new route, and an approval's submitter route. The
-- single source of every rule below is lib/db-rules.ts;
-- tests/unit/db-rules-migration-guard.test.ts holds this file to it.
--
-- Every constraint is added NOT VALID: nothing is scanned, so this migration
-- cannot fail on old data, and no existing row is changed. What NOT VALID means
-- (docs/OPERATIONS.md section 5l):
--   - a NOT VALID CHECK is evaluated on every INSERT and every UPDATE of a row,
--     an update to an unrelated column included. An older row that breaks one
--     can not be saved again by any path until it is corrected (an edit, a
--     merge, an archive, the Temix refresh, a status follow, a user delete that
--     sets its creator to null);
--   - a NOT VALID foreign key is checked only when its own columns change, so
--     an older orphan can still be saved while its link is left alone.
-- The nightly check db-rules-older-rows counts the older rows that break each
-- rule; a rule is VALIDATEd by a later migration of its own once it shows 0 on
-- UAT and on production. Nothing here VALIDATEs.
--
-- CustomerEdit.customerId and branchId change from SET NULL to RESTRICT: the
-- application never hard-deletes a customer or a shop, and a request keeps what
-- it is about. Each key is dropped and re-added NOT VALID in the same
-- statement, so the table is never without it.
--
-- Not added here, and why (docs/OPERATIONS.md section 5l): address and name
-- lengths (the import accepts any length), display phones (typed formats in
-- older rows), the Temix code's shape (three migrated codes hold a space) and
-- uniqueness (a unique index cannot be NOT VALID; owner and Steward), CR
-- uniqueness (the owner's decision), CREDIT carrying a limit (the refresh lane
-- writes one without the other), the e-mail rules, and the cross-row rules.
--
-- A correction to an older migration's comment, which is never edited once
-- applied: 20260510160000_p1_drop_phone_unique says a crNumberNorm partial-unique
-- index exists. There is none; Customer_crNumberNorm_idx is an ordinary index.
--
-- Deploy at a quiet hour: each ALTER TABLE takes an ACCESS EXCLUSIVE lock on its
-- table for a moment (one statement per table, so each is locked once).

SET lock_timeout = '10s';

-- ── 1. The pair the composite foreign keys point at (Prisma's own DDL) ────
-- It cannot fail: "id" alone is the primary key.

CREATE UNIQUE INDEX "SubChannel_id_channelId_key" ON "SubChannel"("id", "channelId");

-- ── 2. Customer ───────────────────────────────────────────────────────────

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_credit_terms_only_credit"
    CHECK ("paymentTerms" = 'CREDIT' OR ("creditLimit" IS NULL AND "paymentTermDays" IS NULL)) NOT VALID,
  ADD CONSTRAINT "Customer_subChannel_needs_channel"
    CHECK ("subChannelId" IS NULL OR "channelId" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "Customer_primaryPhoneNorm_shape"
    CHECK ("primaryPhoneNorm" IS NULL OR "primaryPhoneNorm" ~ '^\+968[0-9]{8}$') NOT VALID,
  ADD CONSTRAINT "Customer_crNumberNorm_shape"
    CHECK ("crNumberNorm" IS NULL OR ("crNumberNorm" <> '' AND "crNumberNorm" !~ '[\u0061-\u007A\u0009-\u000D\u0020\u00A0\u00AD\u061C\u0660-\u0669\u06F0-\u06F9\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF]')) NOT VALID,
  ADD CONSTRAINT "Customer_subChannelId_channelId_fkey"
    FOREIGN KEY ("subChannelId", "channelId") REFERENCES "SubChannel"("id", "channelId") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID,
  ADD CONSTRAINT "Customer_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "Customer_lastEditedById_fkey"
    FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "Customer_importBatchId_fkey"
    FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "Customer_lastTemixUploadBatchId_fkey"
    FOREIGN KEY ("lastTemixUploadBatchId") REFERENCES "TemixSyncBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- ── 3. Branch ─────────────────────────────────────────────────────────────

ALTER TABLE "Branch"
  ADD CONSTRAINT "Branch_gps_in_oman"
    CHECK (("gpsLat" IS NULL OR "gpsLat" BETWEEN 16 AND 27) AND ("gpsLng" IS NULL OR "gpsLng" BETWEEN 51 AND 61)) NOT VALID,
  ADD CONSTRAINT "Branch_gps_pair"
    CHECK (("gpsLat" IS NULL) = ("gpsLng" IS NULL)) NOT VALID,
  ADD CONSTRAINT "Branch_gpsAccuracy_range"
    CHECK ("gpsAccuracy" IS NULL OR "gpsAccuracy" BETWEEN 0 AND 10000) NOT VALID,
  ADD CONSTRAINT "Branch_equipment_counts_range"
    CHECK ("coolersCount" BETWEEN 0 AND 100 AND "standsCount" BETWEEN 0 AND 100 AND "emptyBottlesCount" BETWEEN 0 AND 1000) NOT VALID,
  ADD CONSTRAINT "Branch_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "Branch_lastEditedById_fkey"
    FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- ── 4. EditCustomerDraft (a new customer's request) ───────────────────────
-- No credit rule here: a draft carries the requested terms on its request.

ALTER TABLE "EditCustomerDraft"
  ADD CONSTRAINT "EditCustomerDraft_subChannel_needs_channel"
    CHECK ("subChannelId" IS NULL OR "channelId" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "EditCustomerDraft_primaryPhoneNorm_shape"
    CHECK ("primaryPhoneNorm" IS NULL OR "primaryPhoneNorm" ~ '^\+968[0-9]{8}$') NOT VALID,
  ADD CONSTRAINT "EditCustomerDraft_crNumberNorm_shape"
    CHECK ("crNumberNorm" IS NULL OR ("crNumberNorm" <> '' AND "crNumberNorm" !~ '[\u0061-\u007A\u0009-\u000D\u0020\u00A0\u00AD\u061C\u0660-\u0669\u06F0-\u06F9\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF]')) NOT VALID,
  ADD CONSTRAINT "EditCustomerDraft_subChannelId_channelId_fkey"
    FOREIGN KEY ("subChannelId", "channelId") REFERENCES "SubChannel"("id", "channelId") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;

-- ── 5. EditBranchDraft ────────────────────────────────────────────────────
-- No pair rule here: a draft may hold one coordinate until it is sent.

ALTER TABLE "EditBranchDraft"
  ADD CONSTRAINT "EditBranchDraft_gps_in_oman"
    CHECK (("gpsLat" IS NULL OR "gpsLat" BETWEEN 16 AND 27) AND ("gpsLng" IS NULL OR "gpsLng" BETWEEN 51 AND 61)) NOT VALID,
  ADD CONSTRAINT "EditBranchDraft_gpsAccuracy_range"
    CHECK ("gpsAccuracy" IS NULL OR "gpsAccuracy" BETWEEN 0 AND 10000) NOT VALID,
  ADD CONSTRAINT "EditBranchDraft_equipment_counts_range"
    CHECK ("coolersCount" BETWEEN 0 AND 100 AND "standsCount" BETWEEN 0 AND 100 AND "emptyBottlesCount" BETWEEN 0 AND 1000) NOT VALID;

-- ── 6. Attachment (SET NULL, like branchExtraId) ──────────────────────────

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "Attachment_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- ── 7. Notification ───────────────────────────────────────────────────────

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- ── 8. EditApproval (an append-only ledger: RESTRICT) ─────────────────────

ALTER TABLE "EditApproval"
  ADD CONSTRAINT "EditApproval_submitterRouteId_fkey"
    FOREIGN KEY ("submitterRouteId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- ── 9. CustomerEdit ───────────────────────────────────────────────────────
-- The customer and shop keys go from SET NULL to RESTRICT (dropped and re-added
-- in this one statement); the original customer (set once by a trigger) and the
-- new route (the evidence guard refuses a SET NULL on a sent request) are
-- RESTRICT too.

ALTER TABLE "CustomerEdit"
  DROP CONSTRAINT "CustomerEdit_customerId_fkey",
  ADD CONSTRAINT "CustomerEdit_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  DROP CONSTRAINT "CustomerEdit_branchId_fkey",
  ADD CONSTRAINT "CustomerEdit_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CustomerEdit_originalCustomerId_fkey"
    FOREIGN KEY ("originalCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CustomerEdit_newRouteId_fkey"
    FOREIGN KEY ("newRouteId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

RESET lock_timeout;
