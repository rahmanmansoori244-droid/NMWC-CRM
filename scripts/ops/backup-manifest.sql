-- B3: the manifest that makes data loss in a restore DETECTABLE.
--
-- Taken against the SOURCE database at dump time and uploaded next to the dump.
-- Without it, a restore that silently dropped one COPY block — one table, or the
-- tail of a large one — looks exactly like a good restore: the tables are all
-- there, the app starts, and nobody finds out until someone asks where a
-- customer went. scripts/ops/restore-verify.ts --manifest compares every count.
--
-- Pure SQL so the backup job needs no Node, no checkout and no npm install.
-- query_to_xml runs an exact count(*) per table; reltuples would be an estimate.
--
--   psql "$DIRECT_URL" -At -f scripts/ops/backup-manifest.sql > manifest.json
SELECT json_build_object(
  'takenAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'serverVersion', current_setting('server_version'),
  'serverEncoding', current_setting('server_encoding'),
  'database', current_database(),
  -- The RPO watermark: the newest thing that happened before the snapshot.
  'newestAuditAt', (SELECT to_char(max("at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM "AuditLog"),
  'newestCustomerUpdate', (SELECT to_char(max("updatedAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM "Customer"),
  'tableCount', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'),
  'indexCount', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'i'),
  'triggerCount', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal),
  'unloggedTables', (SELECT coalesce(json_agg(relname), '[]'::json) FROM pg_class
                     WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relpersistence <> 'p'),
  'rowCounts', (
    SELECT json_object_agg(t.relname, t.n ORDER BY t.relname)
    FROM (
      SELECT c.relname,
             (xpath('/row/c/text()',
                    query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                                 false, true, '')))[1]::text::bigint AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    ) t
  )
);
