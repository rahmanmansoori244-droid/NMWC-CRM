-- Owner decision 2026-10-25: a Temix code belongs to one live customer.
--
-- Until now the rule lived in the application only: a finalize, an import and
-- the first Temix code of a CRM-born customer each take the code's advisory lock
-- and ask lib/temix-code.ts temixCodeHolder before they write (H-01 kept the
-- column NON-unique because migrated rows carry nmwcCode == temixCode, and a
-- unique index was to follow once the crosswalk was known to be clean). It is:
-- production held no two customers, live or archived, on one Temix code when the
-- owner decided (read-only check, 2026-10-25), and the nightly check
-- temix-code-shared has found none since it was added.
--
-- The index compares the code the way the nightly check does, upper case with
-- the ends trimmed, so an older row stored as " caa0367" and a new "CAA0367" are
-- one code. Live rows only ("deletedAt" IS NULL): an archived customer keeps its
-- code (its Temix deactivation is sent under it), and the application already
-- refuses to give an archived customer's code to anyone else (temixCodeHolder;
-- the customer import's crosswalk guard), which only the Data Steward may decide.
-- Customers with no Temix code are left out.
--
-- A save the index refuses is answered with the customer that holds the code
-- (lib/temix-code.ts temixCodeRefusal; the approval's finalize, the customer
-- import's lanes, lib/errors.ts runAction for any other path).
--
-- Prisma cannot describe an index on an expression with a WHERE clause, so it is
-- not in schema.prisma; CI's schema-drift gate allows it by name, as it allows
-- the four raw-SQL indexes before it.
--
-- Additive: one index. Building it fails, and the migration with it, if live
-- customers share a code by then; the check below says so first, in counts only.

SET lock_timeout = '10s';

DO $$
DECLARE
  shared integer;
BEGIN
  SELECT count(*) INTO shared FROM (
    SELECT upper(btrim("temixCode"))
      FROM "Customer"
     WHERE "deletedAt" IS NULL AND "temixCode" IS NOT NULL
     GROUP BY 1
    HAVING count(*) > 1
  ) AS d;
  IF shared > 0 THEN
    RAISE EXCEPTION 'Customer_temixCode_live_unique: % Temix code(s) are each held by more than one live customer. Correct or merge them first (nightly check temix-code-shared, docs/OPERATIONS.md section 5l), then deploy again.', shared;
  END IF;
END
$$;

CREATE UNIQUE INDEX "Customer_temixCode_live_unique"
  ON "Customer" (upper(btrim("temixCode")))
  WHERE "deletedAt" IS NULL AND "temixCode" IS NOT NULL;
