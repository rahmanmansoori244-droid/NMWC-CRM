-- Is this the database the app writes to? The newest write, on its own.
-- (code review 2026-11-10, finding 14; second round.)
--
-- The nightly backup's freshness check (scripts/ops/backup-freshness.sh) used to
-- read this age from the manifest only. The manifest is a large query (an exact
-- count of every table); when it failed, the run went on "without row counts" as
-- its warning said — and then the freshness check found no age and failed the
-- scheduled run, so one failed count turned a backup that had been taken and
-- uploaded red. This small query asks for the age alone, so a failed manifest
-- stays the warning it says it is, and a database the app no longer writes to
-- still fails loudly.
--
-- The same expression as the manifest's newestWriteAt / secondsSinceNewestWrite
-- (scripts/ops/backup-manifest.sql): the newer of the newest audit row and the
-- newest scheduled-job heartbeat. The columns hold UTC without a zone, so the age
-- is taken against now() in UTC and printed as stored, whatever the session's
-- time zone.
--
--   psql "$PGURL" -At -v ON_ERROR_STOP=1 -f scripts/ops/backup-newest-write.sql
--
-- Prints one line: <seconds since the newest write>|<newest write, ISO UTC>.
-- Both are empty ("|") when the database has no audit row and no heartbeat.
SELECT floor(extract(epoch FROM (now() AT TIME ZONE 'UTC') - w))::bigint,
       to_char(w, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM (SELECT greatest((SELECT max("at") FROM "AuditLog"), (SELECT max("lastRunAt") FROM "CronHeartbeat")) AS w) newest;
