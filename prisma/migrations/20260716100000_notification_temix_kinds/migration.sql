-- Phase 1 SLA/notifications increment: Temix notification kinds.
-- Isolated enum-only migration (Postgres allows ADD VALUE inside a
-- transaction only if the value is not used in the same transaction — same
-- pattern as 20260715120000_phase1_enums).
-- Resolves the blueprint cross-doc divergence: sla-notif-sync specifies the
-- debounced Steward TEMIX_UPLOAD_READY ping and the submitter TEMIX_SYNC_ACKED
-- ack; data-model's 5-kind enum omitted them without reconciling.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TEMIX_UPLOAD_READY';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TEMIX_SYNC_ACKED';
