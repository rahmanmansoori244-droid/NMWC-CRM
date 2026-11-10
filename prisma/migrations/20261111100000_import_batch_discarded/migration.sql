-- Code review 2026-11-10, finding 6: a staged customer-import batch can be
-- DISCARDED by the Data Steward (with a reason, audited as an UPDATE on the
-- batch). A discarded batch can no longer be promoted, resumed or fixed, and
-- leaves the Steward's Work list. Nothing is deleted: its rows stay as they are,
-- and the existing retention rules keep handling them.
--
-- Additive: one enum value, appended. Nothing in this migration uses it
-- (PostgreSQL forbids using a value in the transaction that added it).
ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'DISCARDED';
