-- F3 (2026-05-11): plain btree on Customer.legalName so the planner can
-- satisfy `ORDER BY legalName ASC LIMIT 50 OFFSET N` directly from the
-- index instead of a full in-memory sort.
--
-- Why this AND the existing trigram GIN index:
--   - The GIN trigram index (`Customer_legalName_trgm_idx`) accelerates
--     ILIKE '%q%' substring search but it cannot satisfy an ORDER BY —
--     trigram indexes are an unordered set of trigrams, not a sorted list
--     of legalName values.
--   - This btree (`Customer_legalName_btree_idx`) gives the planner an
--     ordered structure for the alphabetical scroll-through that the
--     /customers list does by default.
--
-- Both indexes coexist. The query planner picks the cheaper one per query
-- (typically: trigram for search, btree for unfiltered alphabetical list).

CREATE INDEX IF NOT EXISTS "Customer_legalName_btree_idx"
  ON "Customer" ("legalName")
  WHERE "deletedAt" IS NULL;

-- ANALYZE to refresh planner stats so this new index is considered immediately.
ANALYZE "Customer";
