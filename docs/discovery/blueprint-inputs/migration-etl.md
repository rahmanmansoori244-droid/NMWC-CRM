# OLD → NEW Data Migration / ETL Runbook
## ICO Customer Portal (`C:\Users\abdulr\Desktop\ICO\customer-portal`) → NMWC Customer Master (`C:\Users\abdulr\Desktop\NMWC-CRM`)

**Design input for the NMWC unified-CRM consolidation blueprint. Read-only discovery; nothing in either repo was modified.**

Confidence tags: **[Confirmed]** = read in code · **[Proposed]** = this design · **[Open]** = needs a business decision.

---

## 0. Scope, principles, and non-goals

1. **Direction is one-way, one-time**: OLD is a source to be drained and frozen; NEW (as extended by the consolidation blueprint) is the target. OLD code is never lifted (Next 14→15, Prisma 5→6, NextAuth 4→Auth.js 5 major deltas — x-integration M.3.2 [Confirmed]).
2. **Migrate current master state only.** OLD's real per-customer "truth" is split across `CustomerMaster` (upload snapshot) and the latest `CustomerRequest` with `status='ACTIVE_IN_ROUTEPRO'` (GPS/photos/contact live on the request and are read back by JOIN — OLD `app/api/customers/[temixCode]/route.ts:59-80` [Confirmed]). The ETL **materializes** that JOIN. Workflow history (`CustomerRequest`/`StatusHistory`/`AdminAuditLog`/`DuplicateMatch`) is **archived, not migrated** (§9).
3. **Fail loud, never silently NULL.** Every categorical value (channel, subChannel, dayOfVisit, role, paymentTerms) is whitelisted against NEW's locked taxonomy/enums; unmapped values quarantine, mirroring NEW's `ImportRowState.QUARANTINED` lane (`prisma/schema.prisma:64-70`, `services/imports.ts:679` [Confirmed]).
4. **Reuse NEW's existing machinery** wherever it exists: `ImportBatch`/`ImportRow` for the quarantine review UI, `normalizeCR` (`lib/cr.ts:15-19`), `normalizePhone` (`lib/phone.ts:29-35`), `formatBranchCode` (`lib/codes.ts:16-18`), completeness scoring (`lib/completeness.ts:40-81`), the UNASSIGNED region/route fallback pattern (`services/imports.ts:751-762`), and the Neon-branch backup/restore-drill automation (`.github/workflows/db-backup.yml:152-243`) [Confirmed all]. Load is a **scripted bulk path** — NOT the Steward `/import` UI (5 MB xlsx cap + rate-limit make it unfit for a full backfill — x-integration M.7 [Confirmed]).
5. **Dependencies from other blueprint areas** (this runbook assumes they land first, per locked decisions): the `Role` enum gains `ACCOUNTANT`, `FINANCE_MANAGER`, `GM` (8-role model); `Customer.temixCode` legacy-xref column (proposed §3.3 here since it is migration-owned); multi-branch 1:N restore (removal of `branches[0]` assumptions, e.g. `services/duplicates.ts:61,137` [Confirmed]); and the must-fixes: secret rotation both repos, NEW rate-limiter always-grants bug (`lib/rate-limit.ts:102-104`), Manager region-scope hole (`services/edits.ts:259-264`).

---

## 1. STEP 0 — VERIFY (Gate G0: no ETL work starts until these unknowns are resolved)

### 1.1 V-1: What is OLD's real production datastore? (H-13)

**Why:** OLD `prisma/schema.prisma:5-8` declares `provider = "postgresql"` but the committed `.env` sets `DATABASE_URL="file:./dev.db"` (SQLite) and a 344 KB `prisma/dev.db` exists [Confirmed — old-data.md §5.3]. If prod is a real Postgres on Vercel, `dev.db` is a red herring; if prod actually ran SQLite, raw-SQL features (`lib/rate-limit.ts:33-36` `ON CONFLICT`) were broken there and the data volume is probably tiny/seed-only.

**Exact commands** [Proposed]:

```bash
# (a) Read the real prod env from the OLD Vercel project (owner/infra runs this;
#     do NOT rely on the committed .env — it is stale and its secrets are burned):
cd C:/Users/abdulr/Desktop/ICO/customer-portal
npx vercel env ls                      # look for DATABASE_URL scope=production
npx vercel env pull .env.prod-check --environment=production
grep -E '^DATABASE_URL' .env.prod-check | sed 's/=.\{10\}.*/=<scheme-only-redacted>/'   # inspect protocol only; never print the secret

# (b) If (a) yields postgres://... — inspect the live source:
psql "$OLD_DATABASE_URL" -c '\dt'
psql "$OLD_DATABASE_URL" -c 'SELECT count(*) FROM "CustomerMaster";'
psql "$OLD_DATABASE_URL" -c "SELECT count(*) FROM \"CustomerRequest\" WHERE status='ACTIVE_IN_ROUTEPRO';"
psql "$OLD_DATABASE_URL" -c 'SELECT count(*) FROM "RequestPhoto";'
psql "$OLD_DATABASE_URL" -c 'SELECT count(*) FROM "User";'

# (c) In parallel, characterize dev.db to rule it in/out as real data:
sqlite3 prisma/dev.db ".tables"
sqlite3 prisma/dev.db "SELECT count(*) FROM CustomerMaster;"
sqlite3 prisma/dev.db "SELECT count(*), min(createdAt), max(createdAt) FROM CustomerRequest;"
sqlite3 prisma/dev.db "SELECT status, count(*) FROM CustomerRequest GROUP BY status;"
```

**Conclusion matrix** [Proposed]:
| Finding | Conclusion → action |
|---|---|
| Prod `DATABASE_URL` = postgres, row counts plausible (hundreds–thousands, spread of `createdAt`) | Extract from prod Postgres. `dev.db` ignored. |
| Prod = postgres but near-empty; `dev.db` has the real-looking data | OLD never truly went live OR ran locally — treat `dev.db` as source, extract via sqlite3 CSV (§4.1), and expect seed pollution (owner confirms which requests are real). |
| Prod = SQLite `file:` URL | Vercel FS is ephemeral — prod data may be **lost**; escalate to owner immediately; `dev.db` becomes the best-available source. |
| No prod project / env inaccessible | **[Open Q-1]** owner must disclose the live OLD datasource before anything else. |

### 1.2 V-2: Does OLD `temixCode` equal NEW `nmwcCode`? (the highest-leverage unknown)

**Why:** NEW's import writes the raw `cust_code` from the Temix export sheet as `nmwcCode` (`services/imports.ts:616-618` parse → `:820-833` `tx.customer.upsert({ where: { nmwcCode: custCode } … })` [Confirmed]); the `NMWC-YYYY-NNNNNN` generator (`lib/codes.ts:9-11`) is effectively unused [Confirmed — x-integration M.1.1]. If Temix's `cust_code` **is** the same code the OLD accountant keyed into `CustomerRequest.temixCode` → `CustomerMaster.temixCode`, the crosswalk is a trivial join.

**Exact commands** [Proposed] (run on a NEW **Neon branch**, never prod):

```bash
# 1. Export OLD codes (postgres variant; swap to sqlite3 -csv if V-1 says SQLite):
psql "$OLD_DATABASE_URL" -c "\copy (SELECT \"temixCode\", name, \"crNumber\", \"contactNumber\", \"isActive\" FROM \"CustomerMaster\") TO 'old_codes.csv' CSV HEADER"

# 2. Load into a scratch table on the NEW Neon branch:
psql "$NEW_BRANCH_URL" <<'SQL'
CREATE SCHEMA IF NOT EXISTS legacy_ico;
CREATE TABLE legacy_ico._old_codes (
  temix_code text PRIMARY KEY, name text, cr_number text, contact_number text, is_active boolean
);
SQL
psql "$NEW_BRANCH_URL" -c "\copy legacy_ico._old_codes FROM 'old_codes.csv' CSV HEADER"

# 3. The verdict query:
psql "$NEW_BRANCH_URL" <<'SQL'
SELECT
  (SELECT count(*) FROM legacy_ico._old_codes)                                        AS old_total,
  (SELECT count(*) FROM "Customer" WHERE "deletedAt" IS NULL)                          AS new_total,
  count(*)                                                                             AS exact_code_matches,
  round(100.0 * count(*) / NULLIF((SELECT count(*) FROM legacy_ico._old_codes),0), 1) AS pct_of_old
FROM legacy_ico._old_codes o
JOIN "Customer" c ON c."nmwcCode" = o.temix_code;

-- Sanity: do matched pairs also agree on name/CR? (guards against coincidental collision)
SELECT o.temix_code, o.name AS old_name, c."legalName" AS new_name, o.cr_number, c."crNumber"
FROM legacy_ico._old_codes o JOIN "Customer" c ON c."nmwcCode" = o.temix_code
ORDER BY random() LIMIT 25;
SQL
```

**What to conclude** [Proposed]:
- **≥ ~90% exact match + names agree** → same identifier space. Crosswalk = the join; residue goes through tiers T2/T3 (§3.2).
- **Partial (10–90%)** → same space, different snapshots in time (OLD stalled ~2026-04-17; NEW imported later). Still join-based; residue is genuinely new/closed customers — triage per tier.
- **≈ 0%** → different identifier spaces; the crosswalk becomes an out-of-band data project anchored on the authoritative Temix customer list **[Open Q-2: owner must supply the Temix export]**. Do not proceed to §5 load until resolved.

### 1.3 V-3: Cardinality + photo-backend facts needed to size the plan

```sql
-- OLD: does true multi-branch exist? (drives 1:N restore priority)
SELECT "parentTemixCode", count(*) FROM "CustomerRequest"
WHERE type='NEW_BRANCH' AND status='ACTIVE_IN_ROUTEPRO'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- OLD: enrichment coverage — how many masters have a materializable ACTIVE request?
SELECT count(DISTINCT "existingTemixCode") FROM "CustomerRequest"
WHERE status='ACTIVE_IN_ROUTEPRO' AND "existingTemixCode" IS NOT NULL;

-- OLD: which photo backend was actually used (Blob URL vs /api/files disk path)?
SELECT substr("fileUrl",1,40) AS url_prefix, count(*) FROM "RequestPhoto" GROUP BY 1;

-- OLD: in-flight (non-terminal) requests that must be drained before freeze (§2):
SELECT status, count(*) FROM "CustomerRequest"
WHERE status IN ('DRAFT','PENDING_SUPERVISOR','WARNING_POSSIBLE_DUPLICATE','PENDING_ACCOUNTANT',
                 'PENDING_ROUTEPRO','RETURNED_BY_SUPERVISOR','RETURNED_BY_ACCOUNTANT','ESCALATED')
GROUP BY status;
```
[Proposed; fields per OLD `prisma/schema.prisma:137-219` [Confirmed]]

**Gate G0 exit criteria:** V-1 source identified and reachable; V-2 verdict recorded; V-3 counts documented; Temix authoritative customer + payment-terms export in hand (**Q-2**). Sign-off: owner + steward.

---

## 2. STEP 1 — Freeze, snapshot, drain (Gate G1)

1. **Drain OLD in-flight work.** Every request in a non-terminal status (V-3 last query) is either pushed to `ACTIVE_IN_ROUTEPRO`/rejected by its actors during a 1–2 week drain window, or explicitly written off. In-flight OLD states (`PENDING_ACCOUNTANT`, `PENDING_ROUTEPRO`, `ESCALATED`, `RETURNED_*`) have **no representable NEW state** (`EditState` = DRAFT/SUBMITTED/APPROVED/REJECTED/NEEDS_CORRECTION, NEW `prisma/schema.prisma:44-50` [Confirmed]) — do not attempt to map them. **[Open Q-3: who owns the drain decision per stuck request?]**
2. **Set OLD read-only.** Enforce at the DB role, not the app (OLD has no read-only flag): `ALTER ROLE ico_app SET default_transaction_read_only = on;` or `REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public FROM ico_app;` + a banner on the OLD UI [Proposed].
3. **Labeled snapshots, both sides** [Proposed, reusing NEW automation]:
   - OLD: `pg_dump --no-owner --no-privileges --format=plain "$OLD_DATABASE_URL" | gzip > legacy-ico-final-$(date -u +%F).sql.gz`, uploaded to the existing `nmwc-backups` R2 bucket under a `legacy-ico/` prefix (same bucket/creds as `.github/workflows/db-backup.yml:123-134` [Confirmed]).
   - NEW: trigger `workflow_dispatch` on `db-backup.yml` for a fresh pre-load dump, and create a Neon branch `pre-legacy-load-<date>` via the Neon API exactly as the restore-drill job does (`db-backup.yml:206-228` [Confirmed]). This branch is the instant-rollback point (§10).
4. **Mirror OLD Blob objects** (photo re-host source, §7): enumerate `RequestPhoto.fileUrl/fileKey` and bulk-download to staging before the OLD Vercel project is touched. Blob objects are `access:'public'` UUID-keyed (OLD `lib/storage.ts:42-127` [Confirmed — old-arch B.10]), so a plain HTTPS GET per `fileUrl` works.

**Gate G1 exit:** OLD read-only verified (a test INSERT fails); final OLD dump + Blob mirror in R2 `legacy-ico/`; NEW `pre-legacy-load` Neon branch exists; in-flight queue = 0 or written off.

---

## 3. STEP 2 — Identifier crosswalk (temixCode ↔ nmwcCode)

### 3.1 Crosswalk table DDL [Proposed]

Lives in NEW's DB (Prisma-managed, so it survives and is queryable by the app for Temix-upload re-keying — x-integration M.8):

```prisma
// migration: add_legacy_crosswalk
model LegacyCrosswalk {
  id           String   @id @default(cuid())
  temixCode    String   @unique          // OLD CustomerMaster.temixCode
  nmwcCode     String?                   // matched NEW Customer.nmwcCode (null = unmatched yet)
  customerId   String?  @unique          // resolved NEW Customer.id after load
  matchTier    String                    // T1_CODE | T2_CR | T3_NAME_PHONE | T4_MANUAL | T5_CREATED_NEW
  confidence   Float                     // 1.0 exact … 0.5 manual
  oldName      String
  oldCrNorm    String?
  oldPhoneNorm String?
  decidedById  String?                   // steward who confirmed T3/T4
  createdAt    DateTime @default(now())

  @@index([nmwcCode])
  @@index([matchTier])
}
```

```sql
-- migration.sql (hand-written, idempotent, matching NEW house style — cf.
-- prisma/migrations/20260510120000_senior_audit_remediation/migration.sql)
CREATE TABLE IF NOT EXISTS "LegacyCrosswalk" (
  "id" TEXT PRIMARY KEY, "temixCode" TEXT NOT NULL, "nmwcCode" TEXT,
  "customerId" TEXT, "matchTier" TEXT NOT NULL, "confidence" DOUBLE PRECISION NOT NULL,
  "oldName" TEXT NOT NULL, "oldCrNorm" TEXT, "oldPhoneNorm" TEXT,
  "decidedById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "LegacyCrosswalk_temixCode_key" ON "LegacyCrosswalk"("temixCode");
CREATE UNIQUE INDEX IF NOT EXISTS "LegacyCrosswalk_customerId_key" ON "LegacyCrosswalk"("customerId") WHERE "customerId" IS NOT NULL;
```

### 3.2 Match tiers [Proposed]

Populate from `legacy_ico._old_codes` (§1.2) + staged OLD tables (§4), in strict order; each tier only touches rows still unmatched:

| Tier | Rule | Normalization | Confidence |
|---|---|---|---|
| **T1_CODE** | `o.temixCode = c.nmwcCode` | none | 1.0 — only if V-2 verdict = same space AND spot-check names agree |
| **T2_CR** | `normalizeCR(o.crNumber) = c.crNumberNorm` | NEW `lib/cr.ts:15-19` (strip whitespace, uppercase) applied to the OLD value at staging time | 0.95 — CR is the regulatory anchor; NEW carries a partial index on live `crNumberNorm` (`migrations/20260510120000:142-144`; partial-unique per new-rules G [Confirmed]) so at most one live match |
| **T3_NAME_PHONE** | `lower(o.normalizedName) = lower(c.legalName)` AND `normalizePhone(o.contactNumber) = c.primaryPhoneNorm` | NEW `lib/phone.ts:29-35` | 0.8 — **steward confirms each pair** before it counts (phone is deliberately non-unique in NEW — `p1_drop_phone_unique` migration [Confirmed]) |
| **T4_MANUAL** | steward hand-match from a side-by-side export | — | 0.5, requires `decidedById` |
| **T5_CREATED_NEW** | no NEW row exists → ETL will CREATE the Customer (§5.4) | — | 1.0 by construction |

Fields used: OLD `CustomerMaster.temixCode:87, crNumber:90, normalizedName:89, contactNumber:97` [Confirmed]; NEW `Customer.nmwcCode:246, legalName:247, crNumberNorm:250, primaryPhoneNorm:254` [Confirmed].

### 3.3 Retain temixCode on NEW Customer [Proposed]

Per H-01 recommended direction (nmwcCode canonical, temixCode retained as ERP xref) — required forever for Temix upload re-keying:

```prisma
model Customer {
  ...
  temixCode String? // legacy Temix ERP cross-reference; populated by LegacyCrosswalk at migration
  @@index([temixCode])
}
```
```sql
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "temixCode" TEXT;
CREATE INDEX IF NOT EXISTS "Customer_temixCode_idx" ON "Customer"("temixCode") WHERE "temixCode" IS NOT NULL;
```
Deliberately **not unique** initially — Temix may have split/merged codes; enforce uniqueness after reconciliation if clean **[Open Q-4]**. If V-2 says the spaces are equal, then for T1 rows `temixCode == nmwcCode` — still populate explicitly so the Temix-upload exporter never has to "guess by equality".

**Gate G2 exit:** every OLD `CustomerMaster` row has a `LegacyCrosswalk` row; T3/T4 rows steward-signed; count(T5) reviewed by owner (these become net-new customers in NEW).

---

## 4. STEP 3 — Extraction & staging

### 4.1 Stage OLD tables into the NEW Neon **work branch** (never prod) [Proposed]

```bash
# Create the ETL work branch from current prod head (same Neon API call pattern
# as db-backup.yml:214-219); name: legacy-etl-<date>.

# Postgres source:
pg_dump --no-owner --no-privileges --schema=public \
  -t '"CustomerMaster"' -t '"CustomerRequest"' -t '"RequestPhoto"' \
  -t '"User"' -t '"Depot"' -t '"Route"' -t '"StatusHistory"' \
  "$OLD_DATABASE_URL" \
| sed 's/CREATE TABLE public\./CREATE TABLE legacy_ico./; s/ALTER TABLE public\./ALTER TABLE legacy_ico./; s/COPY public\./COPY legacy_ico./' \
> old_stage.sql   # review the sed result manually before applying
psql "$NEW_BRANCH_URL" -c 'CREATE SCHEMA IF NOT EXISTS legacy_ico;'
psql "$NEW_BRANCH_URL" -v ON_ERROR_STOP=1 -f old_stage.sql

# SQLite source (if V-1 concluded dev.db):
sqlite3 prisma/dev.db ".mode csv" ".headers on" \
  ".once CustomerMaster.csv" "SELECT * FROM CustomerMaster;"   # …repeat per table
# then \copy each CSV into legacy_ico.* tables created from the OLD schema DDL.
```

Staging in-DB (not app-side) makes every transform + validation a reviewable SQL/TS step against one connection and makes the dry-run (§6) cheap to re-run.

### 4.2 Materialize OLD enrichment (the critical subtlety)

OLD's REAL enrichment does **not** live on `CustomerMaster` — GPS/photos/updated contact live on `CustomerRequest` rows and are surfaced by joining `status='ACTIVE_IN_ROUTEPRO'` (OLD `app/api/customers/[temixCode]/route.ts:59-80` [Confirmed]; old-functional §4/§5: update requests never write back to the master [Confirmed]). Build a staging view [Proposed]:

```sql
CREATE VIEW legacy_ico.v_effective_customer AS
SELECT
  m.*,
  upd."gpsLat"      AS eff_gps_lat,      upd."gpsLng"        AS eff_gps_lng,
  upd."gpsAccuracy" AS eff_gps_accuracy, upd."gpsCapturedAt" AS eff_gps_captured_at,
  COALESCE(upd."contactPerson",  m."contactPerson") AS eff_contact_person,
  COALESCE(upd."primaryPhone",   m."contactNumber") AS eff_primary_phone,
  upd."alternatePhone"                              AS eff_alt_phone,
  COALESCE(upd."address",        m.address)         AS eff_address,
  upd."areaDescription"                             AS eff_area_description,
  COALESCE(upd."channel",        m.channel)         AS eff_channel,
  COALESCE(upd."subChannel",     m."subChannel")    AS eff_sub_channel,
  COALESCE(upd."dayOfVisit",     m."dayOfVisit")    AS eff_day_of_visit,
  upd."openingHours" AS eff_opening_hours, upd."deliveryWindow" AS eff_delivery_window,
  upd."coolerRequired", upd."standRequired", upd."emptyBottlesRequired",
  upd.id AS enrichment_request_id,
  cre.id AS creation_request_id
FROM legacy_ico."CustomerMaster" m
LEFT JOIN LATERAL (
  SELECT * FROM legacy_ico."CustomerRequest" r
  WHERE r."existingTemixCode" = m."temixCode" AND r.status = 'ACTIVE_IN_ROUTEPRO'
  ORDER BY r."routeproActivatedAt" DESC NULLS LAST LIMIT 1
) upd ON true
LEFT JOIN LATERAL (
  SELECT * FROM legacy_ico."CustomerRequest" r
  WHERE r."temixCode" = m."temixCode" AND r.type <> 'UPDATE_EXISTING'
  ORDER BY r."routeproActivatedAt" DESC NULLS LAST LIMIT 1
) cre ON true;
```
(Field names per OLD `prisma/schema.prisma:85-219` [Confirmed]. The creation-request lateral also backfills masters whose portal-captured data never made it into a master re-upload.) `NEW_BRANCH` requests (`parentTemixCode`, OLD `:177`) that are `ACTIVE_IN_ROUTEPRO` but have **no own CustomerMaster row** become additional Branches under the parent's Customer (§5.3) — this is where true 1:N re-emerges.

---

## 5. STEP 4 — Structural transform
Script `scripts/migrate-legacy-ico.ts` [Proposed], run with `tsx` against the work branch, same style as `prisma/synthetic.ts` / `scripts/flatten-customer-branches.ts` [Confirmed those exist].

### 5.1 Taxonomy crosswalk — channel/subChannel (fail-loud)

OLD stores free strings validated only by Zod against `CHANNELS` (OLD `lib/constants.ts:5-47` [Confirmed]); NEW is a locked FK taxonomy (`prisma/schema.prisma:217-241`, seeded `prisma/seed.ts:14-58` [Confirmed]). The vocabularies are ALMOST equal — the deltas are real and will bite [Confirmed by direct diff]:

| OLD key (`constants.ts:5-47`) | NEW key (`seed.ts:14-58`) | Note |
|---|---|---|
| `HORECA` | `HORECA` | subs identical |
| `MODERN_TRADE` | `MODERN_TRADE` | identical |
| `GENERAL_TRADE` | `GENERAL_TRADE` | identical |
| `C_AND_G` | `CONVENIENCE_AND_GAS` | **key differs** |
| `E_COMMERCE` | `ECOMMERCE` | **key differs** |
| `HOME_OFFICE_DELIVERY` | `HOME_OFFICE_DELIVERY` | identical |
| `INSTITUTIONS` | `INSTITUTIONS` | sub labels differ: OLD `Education (schools, colleges, universities)` → NEW `Education`; OLD `Healthcare (hospitals, clinics)` → NEW `Healthcare` |

Also: OLD data may hold the **label** (`'Modern Trade'`) or the **key** (`'MODERN_TRADE'`) depending on which form wrote it — the mapper must accept both. NEW SubChannel keys are derived `label.toUpperCase().replace(/[^A-Z0-9]+/g,'_')` (`seed.ts:80` [Confirmed]).

Mapper contract [Proposed]: a static `LEGACY_CHANNEL_MAP: Record<string, {channelKey, subChannelKey}>` covering every distinct value found by `SELECT DISTINCT eff_channel, eff_sub_channel FROM legacy_ico.v_effective_customer`. Any value not in the map → the row **quarantines** (§6), never `channelId = NULL`. (NEW's FK is `SET NULL`-tolerant nullable — `schema.prisma:251-252,280-281` — which is exactly the silent-NULL failure mode we refuse.)

### 5.2 dayOfVisit

OLD free strings `'Saturday'…'Friday'` (`constants.ts:64-72` [Confirmed]) → NEW `DayOfWeek` enum `SAT..FRI` (`schema.prisma:34-42` [Confirmed]). Static 7-entry map; anything else quarantines.

### 5.3 Field-by-field mapping

**Customer** (target NEW `schema.prisma:244-292`):

| NEW field | Source | Rule |
|---|---|---|
| `nmwcCode` | crosswalk | T1–T4: existing row's code. T5: **[Open Q-5]** use `temixCode` as `nmwcCode` if V-2 = same space; else mint via `formatCustomerCode` (`lib/codes.ts:9-11`) from a reserved legacy sequence |
| `temixCode` (new col §3.3) | `m.temixCode` | always |
| `legalName` | `m.name` | enrich-only precedence (below) |
| `paymentTerms` | **Temix export, §5.5** — never inferred | locked decision |
| `crNumber` / `crNumberNorm` | `m.crNumber` / `normalizeCR()` | |
| `channelId`/`subChannelId` | §5.1 map on `eff_channel/eff_sub_channel` | fail-loud |
| `primaryPhone`/`primaryPhoneNorm` | `eff_primary_phone` / `normalizePhone()` | |
| `altPhone` | `eff_alt_phone` | |
| `contactPerson` | `eff_contact_person`; `contactRole`: no OLD source → NULL | |
| `status` | `m.isActive ? ACTIVE : CLOSED` | no OLD source for SUSPENDED (H-10) |
| `notes` | append marker `Migrated from ICO portal <date>; legacy GPS/photos unverified.` [Proposed] | GPS-trust, §7.6 |
| `createdById`/`lastEditedById` | synthetic `migration-bot` user id (§8.4) | loose scalars, no FK (`schema.prisma:276-277` [Confirmed]) |
| `completenessScore` | recompute post-load via `scoreCustomer` (`lib/completeness.ts:73-81` [Confirmed]) | one pass over all migrated rows |
| `version` | 0 on create; on update, `version = version + 1` to respect B-05 optimistic locking (`schema.prisma:262-264` [Confirmed]) | |

**Precedence rule for T1–T4 matches (customer already exists in NEW):** OLD **only fills NULL/empty NEW fields; it never overwrites a non-null NEW value.** NEW's data came from a later Temix export + live pilot enrichment, so it is presumed fresher; conflicts (both non-null and different) are emitted to a `legacy_conflicts.csv` steward report instead of auto-resolved. **[Open Q-6: any fields where OLD should win, e.g. contactPerson, where OLD capture was richer?]**

**Branch** (target NEW `schema.prisma:294-349`); one Branch per effective outlet:
- T1–T4 match: enrich the customer's existing branch(es) — match by `m.routeCode` → `Route.code` where possible, else the single existing branch (pilot data is 1:1, new-docs P1.2 [Confirmed]).
- T5 (created): create Branch with `branchCode = formatBranchCode(nmwcCode, 1)` (`lib/codes.ts:16-18` [Confirmed]).
- OLD `NEW_BRANCH` requests (§4.2): additional Branch under the parent's Customer, `branchCode = formatBranchCode(parentNmwcCode, n+1)` — restores true 1:N; **must land after the `branches[0]` code fixes** (dependency §0.5).

| NEW Branch field | Source / rule |
|---|---|
| `address` | `eff_address` — must satisfy CHECK `Branch_address_minlength` `length(btrim(address)) >= 3` (`migrations/20260510120000:215-222` [Confirmed]); shorter → quarantine |
| `areaDescription` | `eff_area_description`, fallback concat `m.location + ', ' + m.district` [Proposed] |
| `gpsLat/gpsLng/gpsAccuracy/gpsCapturedAt` | `eff_gps_*` — validated against the **Oman envelope** (§6) |
| `regionId`/`routeId` | depot/route crosswalk §8.3; resolution failure → `UNASSIGNED` region/route exactly like `services/imports.ts:751-762,790-815` [Confirmed pattern]. Always derive `regionId` **from the resolved route** (`route.regionId`) so the `branch_region_consistency_check` trigger (`migrations/20260510120000:154-173` [Confirmed]) can never fire |
| `dayOfVisit` | §5.2 map |
| `openingHours`/`deliveryWindow` | `eff_*` |
| `coolersCount/standsCount/emptyBottlesCount` | OLD booleans `coolerRequired/standRequired/emptyBottlesRequired` (`schema.prisma:173-175` [Confirmed]) → **[Open Q-7]**: `true→1` is mechanical but the boolean means "required", not "count on site". Recommend `0` + steward re-count campaign; owner decides |
| `status` | parent customer status |
| `shopPhotoId/signboardPhotoId` | wired in §7 after re-host |

### 5.4 Load order (per-customer transaction, mirroring `promoteCustomerBatchCore`'s QA-019 pattern, `services/imports.ts:764-873` [Confirmed])

1. upsert Customer (precedence rule) → 2. upsert Branch(es) → 3. update `LegacyCrosswalk.customerId` → 4. one `AuditLog` row `{ action: IMPORT, entityType: 'Customer', reason: 'LEGACY_ICO_MIGRATION', before: null, after: <snapshot> }` (uses existing `AuditAction.IMPORT`, `schema.prisma:77` [Confirmed]) — see §9 for why this is the ONLY AuditLog write.

### 5.5 Payment terms — sourced from Temix (locked decision)

OLD has **no payment-terms field anywhere** (schema read end-to-end [Confirmed]; H-07 — "cash" was only implied by the `NO_CR` request type). Do **not** infer. The join [Proposed]:

1. Owner supplies a fresh Temix export containing at minimum `cust_code, payment_terms` (ideally also credit limit + term days for the credit-workflow design area).
2. Stage as `legacy_ico._temix_terms(cust_code text PRIMARY KEY, payment_terms text)`.
3. Apply with the same strict whitelist NEW's importer uses (`services/imports.ts:643-651` [Confirmed] — F-12: anything not exactly CASH/CREDIT is an error, not a silent CASH):

```sql
-- fail-loud scan first; must return 0 rows:
SELECT cust_code, payment_terms FROM legacy_ico._temix_terms
WHERE upper(trim(payment_terms)) NOT IN ('CASH','CREDIT');

UPDATE "Customer" c
SET "paymentTerms" = upper(trim(t.payment_terms))::"PaymentTerms",
    "version"      = c."version" + 1
FROM legacy_ico._temix_terms t
WHERE c."temixCode" = t.cust_code;

-- migrated customers with no Temix terms row → steward triage list
SELECT c."nmwcCode", c."legalName"
FROM "Customer" c
JOIN "LegacyCrosswalk" x ON x."customerId" = c.id
LEFT JOIN legacy_ico._temix_terms t ON t.cust_code = c."temixCode"
WHERE t.cust_code IS NULL;    -- default stays CASH but is REPORTED, not silent  [Open Q-8]
```
Terms correctness has a control consequence: `crNumber` is field-locked for SALESMAN when `paymentTerms=CREDIT` (`lib/permissions.ts:78-79` per new-rules C [Confirmed]) — a wrongly-CASH credit customer has that CR-edit control silently disabled.

---

## 6. STEP 5 — Validation & quarantine lane (Gate G3)

**Dry-run every transformed row against NEW's full invariant set on the work branch before any prod write.** Two layers — they are NOT the same [Confirmed, important nuance]:

| Invariant | Where it lives | Bound |
|---|---|---|
| GPS global range | DB CHECKs `Branch_gpsLat_range`/`Branch_gpsLng_range` (`migrations/20260510120000:179-195`) | ±90 / ±180 |
| GPS **Oman envelope** | Zod only — `lib/validation/edit.ts:59-68` | lat 16–27, lng 51–61 |
| Address minlength | DB CHECK (`:215-222`) + Zod `min(3)` (`edit.ts:53`) | ≥3 trimmed |
| Branch.regionId == Route.regionId | DB trigger (`:154-173`) | hard fail |
| CR uniqueness (live rows) | partial index on `crNumberNorm` (`:142-144`; partial-unique per new-rules G) | insert conflict |
| Enum membership | Postgres enums (`DayOfWeek`, `PaymentTerms`, `CustomerStatus`) | insert reject |

**Policy [Proposed]:** the ETL enforces the **stricter app-level Oman envelope**, not just the DB CHECK — OLD accepted any global coordinate (OLD `lib/validators/request.ts:39-40`, ±90/±180 only [Confirmed — old-rules B]), so out-of-envelope rows are exactly the suspect ones. Failing GPS keeps the branch but with `gpsLat/gpsLng = NULL` + a quarantine record for field re-capture, rather than blocking the whole customer **[Open Q-9: null-and-flag vs full-row quarantine]**.

**Mechanism [Proposed]:** materialize the quarantine inside NEW's existing import machinery so the steward reviews it in the UI they already know:
- One `ImportBatch { kind: 'LEGACY_ICO', filename: 'legacy-ico-migration', status: READY }`. `kind` is a loose string (`schema.prisma:427` [Confirmed]) so `'LEGACY_ICO'` needs no migration — and `promoteCustomerBatchCore` rejects non-`CUSTOMER` kinds (`services/imports.ts:720` [Confirmed]), which is desirable: the legacy batch can never be promoted by the UI button, only by `scripts/migrate-legacy-ico.ts`.
- Every failed row → `ImportRow { state: QUARANTINED, raw: <old row snapshot>, parsed: <transformed>, issues: [{field, message}] }` — same shape as `services/imports.ts:612-683` [Confirmed].
- Expected failure classes to budget for: out-of-Oman GPS (OLD had no geofence), address < 3 chars, unmapped channel strings, `dayOfVisit` typos, steward-rejected T3 matches.

**Gate G3 exit:** dry-run of 100% of rows completes with `promoted + quarantined = total`; quarantine rate reviewed (suggested go threshold < 15% **[Open Q-10]**); zero unclassified exceptions.

---

## 7. STEP 6 — Photo re-host (bulk object movement, not a DB step)

Source: OLD `RequestPhoto { type SHOP|SIGNBOARD|CR, fileUrl, fileKey }` (`schema.prisma:221-230` [Confirmed]), objects in Vercel Blob (public, UUID-keyed) or local disk (V-3 says which). Target: R2 photo bucket + NEW `Attachment` rows (`schema.prisma:384-421` [Confirmed]).

**Only photos of migrated effective state move**: those of the `enrichment_request_id`/`creation_request_id` chosen in §4.2 (mirrors OLD's own display query, `app/api/customers/[temixCode]/route.ts:70-80` [Confirmed]). Photos of rejected/superseded requests stay archive-only.

Per photo [Proposed]:
1. Read from the §2.4 staging mirror (fallback: HTTPS GET on `fileUrl`).
2. `sha256` the bytes → `Attachment.hash` (dedupe support, `schema.prisma:400` + `Attachment_hash_idx` [Confirmed]). Idempotence: skip upload+insert if an Attachment with this hash + target already exists.
3. Upload to R2 with NEW's key convention `YYYY/MM/DD/<userId>/<kind>/<uuid>.<ext>` (`app/api/photos/presign/route.ts:53-57` [Confirmed]), where the date component = the original OLD `RequestPhoto.uploadedAt` date and `<userId>` = the migration-bot id, so key chronology stays truthful.
4. Insert `Attachment` **directly via the script** — do NOT route through `/api/photos/finalize`: finalize derives `capturedAt` from R2 `HeadObject.LastModified` (new-rules H [Confirmed]), which for migrated objects would be the migration date, destroying the evidence timeline. Set `capturedAt = RequestPhoto.uploadedAt`, `capturedById = migration-bot`, `capturedLat/Lng = NULL` (OLD stored no per-photo GPS [Confirmed — schema `:221-230`]).
5. Wire slots: `SHOP → Branch.shopPhotoId`, `SIGNBOARD → Branch.signboardPhotoId` (`schema.prisma:317-318`), `CR → Customer.crPhotoId` (`:271`); surplus photos of a type → FREE attachments with `branchExtraId` (+`branchId`) per NEW's own pattern (`services/photos.ts:217` [Confirmed — new-data §4.3]).
6. **Trust flag:** migrated photos + GPS are legacy-unverified (OLD capture was client-spoofable — old-rules M.2 [Confirmed]). Mark via the §5.3 `notes` marker + the AuditLog IMPORT row; do not fake freshness. Note NEW's reactivation guard already requires `attachment.capturedAt > lastStatusChangeAt` (`schema.prisma:322-325` [Confirmed]) — migrated old `capturedAt` values correctly CANNOT satisfy future reactivation evidence. No code change needed.
7. Post-soak: OLD public Blob URLs remain fetchable until deleted (H-12 [Confirmed]) — delete the Blob store when OLD is decommissioned.

Throughput: single worker, concurrency ~8, resumable via the hash check in step 2.

---

## 8. STEP 7 — Users, roles, depot→region

### 8.1 Re-provision, never copy [Confirmed constraints → Proposed plan]
- Login identifier changes **email → username** (OLD `User.email @unique` `schema.prisma:52`; NEW `User.username @unique` `schema.prisma:142` [Confirmed]). Proposed username = email local-part, lowercased, de-duplicated with numeric suffix; steward reviews the generated list before creation.
- **Do not copy `passwordHash`.** bcrypt is portable in principle, but OLD's secret hygiene is burned (committed `.env`, H-14) and the login key changes anyway. Fresh high-entropy per-user passwords, `mustChangePassword = true` (`schema.prisma:158` [Confirmed]), distributed out-of-band. This also supersedes the committed-pilot-credential problem for migrated users.
- Only owner-confirmed active users are created; OLD `isActive=false` users are not **[Open Q-11: dormant-user policy — some may be needed for display names in archived contexts, which the frozen archive covers]**.

### 8.2 Role crosswalk (aligned to the locked 8-role model)

| OLD role (`types/index.ts:1` [Confirmed]) | Target role | Note |
|---|---|---|
| SALESMAN | SALESMAN | assign `ownedRouteId` (1:1, NEW `schema.prisma:166-167` [Confirmed]) from OLD `Route.salesmanId` (`schema.prisma:35-36` [Confirmed]) via route crosswalk |
| SUPERVISOR | SUPERVISOR | `supervisorId` hierarchy ports 1:1 (OLD `:58-60` → NEW `:161-163`) |
| ACCOUNTANT | ACCOUNTANT | exists only after the 8-role enum migration lands (prerequisite) |
| ADMIN | **[Open Q-12]** MANAGER vs STEWARD, per person | NEW splits admin; STEWARD is highest privilege — assign deliberately |
| ROUTEPRO | **[Open Q-13]** retire (recommended) or VIEWER | the activation stage doesn't exist in the target workflow |

The role-enum migration itself (owned by the roles/permissions design area) is a hard prerequisite: `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT'; … 'FINANCE_MANAGER'; … 'GM';` in NEW's idempotent house style (cf. `migrations/20260510120000:29-33` [Confirmed pattern]).

### 8.3 Depot → Region and Route crosswalk
OLD scopes by Depot (`Depot.code @unique` `schema.prisma:13`; `User.depotId` `:56` [Confirmed]); NEW scopes by Region (7 seeded, `prisma/seed.ts:61-69` [Confirmed]) + M:N `managedRegions`. Build a static `DEPOT_REGION_MAP: Record<depotCode, regionCode>` signed by the owner **[Open Q-14: the actual mapping; can a depot span regions?]**. OLD `Route.code` → NEW `Route.code` should match textually (both originate from Temix route codes); verify: `SELECT o.code FROM legacy_ico."Route" o LEFT JOIN "Route" n ON n.code = upper(o.code) WHERE n.id IS NULL;` — misses fall back to UNASSIGNED with a steward report (never auto-create routes — F-17 rationale, `services/imports.ts:785-801` [Confirmed]).

### 8.4 Migration-bot user [Proposed]
One `User { username: 'migration-bot', role: STEWARD, isActive: false }` created before the load; owns `createdById/lastEditedById/capturedById` on migrated rows and satisfies `AuditLog.actorId`'s real FK (`schema.prisma:502` [Confirmed] — actor must exist). `isActive:false` blocks login without blocking references. Deactivate its credential material entirely (random hash, never issued).

---

## 9. STEP 8 — History: freeze, don't inject

- **NEW `AuditLog` is append-only/immutable and reflects real actor actions** (new-rules N [Confirmed]). Do **not** re-code OLD `StatusHistory`/`AdminAuditLog` into it — the state machines do not correspond (17 request statuses vs 5 EditStates — x-integration M.1.4 [Confirmed]) and synthetic history would poison the trail's evidentiary value. The ONLY AuditLog writes are the honest per-entity `IMPORT` rows of §5.4.
- **Archive** = the labeled OLD dump + Blob mirror in R2 `legacy-ico/` (§2.3–2.4) + a final git tag on the OLD repo. Retention: owner-defined audit window **[Open Q-15]**.
- **Lifecycle trap [Confirmed]:** `nmwc-backups` enforces a 30-day expiry lifecycle rule bucket-side (`db-backup.yml:10-13`). The `legacy-ico/` prefix MUST be excluded from that rule (or use a separate bucket), otherwise the archive silently self-deletes after a month. Explicit operator task.
- OLD stays deployed **read-only** (DB-role enforced, §2.2) for one full reconciliation cycle so historical lookups remain possible, then is decommissioned to the static archive and the Vercel project retired (redirect the old URL — x-integration M.3.1).

---

## 10. STEP 9 — Reconciliation, promote, rollback

### 10.1 Reconciliation checks (loaded work branch; all must pass — Gate G4)

```sql
-- R1: conservation — every OLD master row accounted for
SELECT (SELECT count(*) FROM legacy_ico."CustomerMaster") AS old_masters,
       (SELECT count(*) FROM "LegacyCrosswalk")           AS crosswalked,
       (SELECT count(*) FROM "ImportRow" ir JOIN "ImportBatch" b ON b.id = ir."batchId"
         WHERE b.kind = 'LEGACY_ICO' AND ir.state = 'QUARANTINED') AS quarantined;
-- expect: old_masters = crosswalked; loaded + quarantined = old_masters

-- R2: region/route invariant holds (belt over the trigger's braces)
SELECT count(*) FROM "Branch" b JOIN "Route" r ON r.id = b."routeId"
WHERE b."regionId" <> r."regionId";                                  -- must be 0

-- R3: photo conservation
SELECT (SELECT count(*) FROM legacy_ico."RequestPhoto" p
        JOIN legacy_ico."CustomerRequest" r ON r.id = p."requestId"
        WHERE r.status = 'ACTIVE_IN_ROUTEPRO')                        AS old_effective_photos,
       (SELECT count(*) FROM "Attachment" WHERE "capturedById" = '<migration-bot-id>') AS migrated;

-- R4: paymentTerms distribution vs the Temix export counts
SELECT "paymentTerms", count(*) FROM "Customer" c
JOIN "LegacyCrosswalk" x ON x."customerId" = c.id GROUP BY 1;

-- R5: scripted side-by-side of 25 random customers (OLD effective view vs NEW row)
```
Plus a human pass: steward opens 10 migrated customers in the NEW UI — photos stream, GPS pin plots, channel/terms display, completeness ring sane.

### 10.2 Promote to production (maintenance window)

The work branch was created **from** prod, but prod keeps moving (pilot users still edit). Therefore [Proposed]:
- **Preferred — re-run, don't promote the branch:** treat the work-branch load as the final dress rehearsal. In the window: freeze NEW writes (announcement + optional maintenance flag), snapshot (`pre-legacy-load` branch + `workflow_dispatch` dump), then run the same idempotent ETL **against prod**. Every step is resumable (upserts, crosswalk state, hash-checked photo uploads).
- Rejected alternative: promoting the Neon work branch to primary would discard pilot edits made after branch creation.

### 10.3 Rollback

| Trigger | Action |
|---|---|
| Load fails mid-run | Resume (idempotent), or restore the pre-load dump / re-point `DATABASE_URL` at `pre-legacy-load-<date>` (Neon-branch mechanics proven by the restore drill, `db-backup.yml:206-243` [Confirmed]) |
| Post-cutover data wrong within soak | Partial rollback by crosswalk: delete rows with `matchTier='T5_CREATED_NEW'`; for enriched T1–T4 rows, revert using the AuditLog IMPORT `after` snapshots. The crosswalk is the split key — keep it forever |
| Fundamental identity mis-mapping at scale | Re-point to `pre-legacy-load` (loses interim edits — announce), fix the crosswalk, re-run |
| OLD needed operationally again | OLD is still deployed read-only during soak — flip the DB role back (documented, owner-approved only) |

Do NOT hard-delete anything OLD (repo, DB, Blob) until NEW has soaked one full Temix upload/reconciliation cycle post-cutover.

---

## 11. Runbook summary — ordered gates

| # | Step | Gate to exit | Owner |
|---|---|---|---|
| 0 | Verify: OLD datastore (V-1), code equivalence (V-2), counts/photo backend (V-3); obtain Temix terms export | **G0** verdicts recorded + export in hand | Eng + owner |
| P | Parallel prerequisites: secret rotation both repos; rate-limiter fix (`lib/rate-limit.ts:102-104`); Manager scope fix (`services/edits.ts:259-264`); 8-role enum + `Customer.temixCode` + `LegacyCrosswalk` migrations; `branches[0]` 1:N fixes | **GP** merged + deployed | Eng |
| 1 | Drain OLD in-flight; freeze read-only; labeled dumps + Blob mirror → R2 `legacy-ico/`; `pre-legacy-load` Neon branch | **G1** freeze verified, backups exist | Eng + workflow actors |
| 2 | Build `LegacyCrosswalk` T1→T5; steward signs T3/T4 | **G2** 100% crosswalked | Steward |
| 3 | Stage OLD into `legacy_ico.*` on work branch; `v_effective_customer` view | staging counts == source | Eng |
| 4 | Transform + dry-run load (customers, branches, Temix terms) | **G3** quarantine < threshold; 0 unclassified failures | Eng + steward |
| 5 | Photo re-host to R2 + Attachment wiring (resumable) | R3 conservation passes | Eng |
| 6 | User re-provisioning (usernames, roles, depot→region, `mustChangePassword=true`) | owner signs role/region matrix | Owner + manager |
| 7 | Reconciliation R1–R5 + UI spot-check on work branch | **G4** all green | Steward + owner |
| 8 | Maintenance window: freeze NEW, snapshot, re-run ETL against prod, re-run R1–R5 | **G5 go-live** all green, else rollback | Eng |
| 9 | Soak: OLD read-only one reconciliation cycle; quarantine burn-down; decommission OLD (+ delete Blob) | soak clean | Owner |

---

## 12. OPEN QUESTIONS (business decisions — not assumed)

| # | Question | Blocks |
|---|---|---|
| Q-1 | What is OLD's live production `DATABASE_URL` (Vercel env)? Is `dev.db` real data or seed? | G0 |
| Q-2 | Owner to supply the authoritative Temix customer export (`cust_code`, name, `payment_terms`, ideally credit limit + term days) as reconciliation + terms anchor | G0 |
| Q-3 | Disposition policy for OLD in-flight requests that cannot be drained (approve, reject, or re-key as NEW DRAFT edits?) | G1 |
| Q-4 | Should `Customer.temixCode` become UNIQUE after reconciliation, or can one Temix code map to multiple NMWC customers (splits)? | schema |
| Q-5 | For OLD-only customers (T5): reuse `temixCode` as `nmwcCode`, or mint `NMWC-YYYY-NNNNNN`? (depends on V-2 verdict) | G2 |
| Q-6 | Field precedence for matched customers: confirm "NEW wins, OLD fills NULLs only" — any exceptions? | G3 |
| Q-7 | Equipment booleans → counts: `true→1` or `0` + steward re-count campaign? | G3 |
| Q-8 | Customers absent from the Temix terms export: CASH-with-flag, or block their promotion? | G3 |
| Q-9 | Out-of-Oman GPS: null-and-flag (branch loads without GPS) vs quarantine the whole branch? | G3 |
| Q-10 | Acceptable quarantine-rate threshold before go-live is reconsidered (suggested 15%)? | G4 |
| Q-11 | Migrate deactivated OLD users at all, or active-only (recommended)? | step 6 |
| Q-12 | Per-person mapping of OLD ADMINs → MANAGER vs STEWARD (STEWARD = highest privilege) | step 6 |
| Q-13 | ROUTEPRO users: retire (recommended) or VIEWER? | step 6 |
| Q-14 | The actual Depot→Region matrix (owner-signed; may a depot span regions?) | step 6 |
| Q-15 | Audit-retention period for the frozen OLD archive; confirm `legacy-ico/` is excluded from the 30-day R2 lifecycle rule on `nmwc-backups` | step 8 |

---

## 13. Key file:line evidence index

**NEW (`C:\Users\abdulr\Desktop\NMWC-CRM`)** — `prisma/schema.prisma:244-292` Customer, `:294-349` Branch, `:352-381` CustomerEdit, `:384-421` Attachment, `:424-459` import models, `:44-50` EditState, `:64-70` ImportRowState, `:77` AuditAction.IMPORT, `:142` username, `:158` mustChangePassword, `:166-167` ownedRouteId, `:262-264/:327-329` version locks, `:322-325` reactivation guard, `:502` AuditLog actor FK; `services/imports.ts:616-618` cust_code parse, `:643-651` F-12 terms whitelist, `:679` QUARANTINED, `:720` kind guard, `:751-762` UNASSIGNED fallback, `:764-873` per-customer transaction, `:820-833` nmwcCode=cust_code upsert; `lib/codes.ts:9-18`; `lib/cr.ts:15-19`; `lib/phone.ts:29-35`; `lib/validation/edit.ts:53,59-68` Oman envelope; `lib/completeness.ts:40-81`; `app/api/photos/presign/route.ts:53-57` R2 key convention; `prisma/migrations/20260510120000_senior_audit_remediation/migration.sql:29-33` idempotent enum pattern, `:142-147` crNumberNorm index, `:154-173` region trigger, `:179-222` GPS/address CHECKs; `prisma/seed.ts:14-58` taxonomy, `:61-69` regions, `:80` subKey derivation; `.github/workflows/db-backup.yml:10-13` 30-day lifecycle, `:123-134` R2 upload, `:152-243` Neon-branch restore drill; must-fix anchors `lib/rate-limit.ts:102-104`, `services/edits.ts:259-264`; 1:N assumptions `services/duplicates.ts:61,137`.

**OLD (`C:\Users\abdulr\Desktop\ICO\customer-portal`)** — `prisma/schema.prisma:5-8` provider mismatch, `:85-112` CustomerMaster (temixCode `:87`, normalizedName `:89`, crNumber `:90`, routeCode `:91`, contactNumber `:97`, isActive `:103`), `:137-219` CustomerRequest (parentTemixCode/existingTemixCode `:177-178`, temixCode `:185`, equipment booleans `:173-175`), `:221-230` RequestPhoto, `:50-83` User (email `:52`, role String `:55`, depotId `:56`), `:13/:21` Depot, `:35-40` Route assignments; `app/api/customers/[temixCode]/route.ts:53-80` the enrichment JOIN (materialization source); `lib/constants.ts:5-47` channels, `:64-72` days; `lib/validators/request.ts:39-40` global-only GPS bounds; `types/index.ts:1` roles; committed `.env` (secrets burned — rotate; never copy values).
