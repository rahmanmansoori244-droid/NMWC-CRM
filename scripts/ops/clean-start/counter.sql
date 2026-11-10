-- Go-live clean start, REHEARSE step 7: the customer-code counter statement
-- (lib/create-finalize.ts) on the RESET COPY, in a transaction that is always
-- rolled back: it must answer next = 2, so the first CRM-created customer is
-- NMWC-<year>-000001. Never run on production (the workflow runs it only on
-- the restored backup, after rehearse-target).
--
--   psql "$REHEARSE_URL" -X -q -At -v ON_ERROR_STOP=1 -f scripts/ops/clean-start/counter.sql > counter.out 2>&1

\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset footer off

BEGIN;
INSERT INTO public."CodeSequence" ("scope", "next")
VALUES ('CUSTOMER-' || to_char(now() AT TIME ZONE 'Asia/Muscat', 'YYYY'), 2)
ON CONFLICT ("scope") DO UPDATE SET "next" = public."CodeSequence"."next" + 1
RETURNING "next";
ROLLBACK;
