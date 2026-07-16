-- Phase 1 (part 1/2): unified-CRM enums, isolated in their own migration.
-- Postgres forbids using a newly ALTER TYPE ... ADD VALUE'd enum value in the
-- same transaction that added it, so all enum changes live here, ahead of the
-- table migration that references the new types.

CREATE TYPE "EditProcess" AS ENUM ('UPDATE', 'CREATE');
CREATE TYPE "TemixSyncState" AS ENUM ('SYNCED', 'PENDING_UPLOAD', 'UPLOADED', 'DEACTIVATE_PENDING');
CREATE TYPE "NotificationKind" AS ENUM ('EDIT_SUBMITTED', 'EDIT_STAGE_ADVANCED', 'EDIT_APPROVED_FINAL', 'EDIT_NEEDS_CORRECTION', 'SLA_BREACH');

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FINANCE_MANAGER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'GM';

ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'GUARANTEE';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STEP_APPROVE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FINALIZE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ESCALATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPORT';
