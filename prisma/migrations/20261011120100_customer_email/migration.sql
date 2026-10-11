-- Credit flow (owner decisions 2026-10-11): the customer's e-mail, a new field
-- on the new-customer form, mandatory for a CREDIT request and not asked for a
-- cash one. Kept on the request's customer draft and copied to the customer at
-- finalize, like every other draft field.
--
-- Additive, and safe to apply before the build that uses it:
--   - two nullable columns with no default: a catalogue-only change (no table
--     rewrite, only a brief lock);
--   - no constraint, trigger or index, so no existing row can make
--     `prisma migrate deploy` fail before `next build`; no backfill — no
--     existing customer or request has an e-mail to copy;
--   - the running build's Prisma client selects and inserts explicit columns, so
--     it never reads either column, and its inserts get NULL;
--   - scripts/ops/restore-verify.ts inserts with an explicit column list, so it
--     is unaffected.
-- If `next build` fails after the migrate, production keeps serving the old build
-- beside two unused columns. Grants are table-level (scripts/ops/app-role.ts), so
-- the runtime role can already read and write both.
ALTER TABLE "Customer" ADD COLUMN "email" TEXT;
ALTER TABLE "EditCustomerDraft" ADD COLUMN "email" TEXT;
