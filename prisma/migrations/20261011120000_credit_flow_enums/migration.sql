-- Credit flow (owner decisions 2026-10-11): the enum values the new credit
-- chain, its documents and its printouts need.
--
--   Role.SALES_DIRECTOR              one Sales Director for every region in Oman:
--                                    the credit-chain step after the Supervisor,
--                                    org-wide, with the GM's access everywhere.
--   AttachmentKind.ID_CARD,          the four credit documents a credit request
--     MEMBERSHIP_CERT, VAT_CERT,     carries (the owner's ID card, the membership
--     TAX_CARD                       certificate, the VAT registration certificate
--                                    and the tax card), 1..N pages each like a
--                                    GUARANTEE.
--   AttachmentKind.CREDIT_FORM       the printed credit application, signed and
--                                    stamped by the customer, uploaded by the
--                                    salesman at the new signed-application step.
--   AuditAction.PRINT                every printout (credit application, final
--                                    customer form) is recorded.
--   NotificationKind.SIGNED_FORM_REQUESTED
--                                    the salesman's must-act alert for that step.
--                                    EDIT_STAGE_ADVANCED cannot carry it: it is
--                                    counted in the salesman's muted bell
--                                    (lib/notify-policy.ts SALESMAN_BELL_INFORMATION_KINDS).
--
-- Isolated enum-only migration: Postgres refuses a new enum value in the same
-- transaction that added it, so nothing else goes here (same pattern as
-- 20260715120000_phase1_enums and 20261005100000_notification_kinds_fyi_reactivation).
--
-- Deploy order. A Prisma client that does not know an enum value throws when it
-- reads a row holding one ("Value ... not found in enum"): the Role of a user
-- row, the kind of an Attachment or a Notification, the action of an AuditLog
-- row. So the build that READS these values must already be production's
-- rollback target before any build WRITES them. This migration ships in the
-- credit-flow FOUNDATION commit, whose build knows every value and writes none;
-- the writers (the Sales Director account, the documents, the alerts, the print
-- records) ship in a LATER deploy, once the foundation's deployment has served
-- production and passed smoke. From then on the rollback target is the
-- foundation's deployment, never an older one; rolling back past it needs every
-- row holding a new value re-kinded or removed first.
-- A rollback from the full build TO the foundation corrupts nothing, but it
-- FREEZES every credit request frozen with the new 6-step chain until the roll
-- forward: the foundation knows no signed-application step (a Sales Director's
-- approve still moves a request into it, and then nobody can upload, withdraw or
-- decide it), and its finalize asks for a guarantee the new chain does not carry.
-- Once any 6-step request exists, prefer a roll-forward fix.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SALES_DIRECTOR';

ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'ID_CARD';
ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_CERT';
ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'VAT_CERT';
ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'TAX_CARD';
ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'CREDIT_FORM';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRINT';

ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'SIGNED_FORM_REQUESTED';
