-- Code review 2026-11-10, finding 1: the per-batch "Overwrite CRM fields from this sheet" option.
--
-- A customer import now only FILLS blank CRM-owned fields of a customer or shop
-- that already exists (name, phone, CR number, contact person, channel, shop
-- name, address, visit day) and never changes its open/closed status. The Data
-- Steward can switch this option on for one batch, with a reason, to let that
-- sheet replace those values (a deliberate bulk correction). It is off by
-- default, switches itself off when the batch finishes, and "overwriteCrmFieldsAt"
-- stays as the record of when it was last switched on. Who switched it on is the
-- actor of the AuditLog UPDATE row on the batch.
--
-- Additive: two columns with constant defaults (metadata-only on PostgreSQL 11+).
ALTER TABLE "ImportBatch" ADD COLUMN     "overwriteCrmFields" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "overwriteCrmFieldsAt" TIMESTAMP(3);
