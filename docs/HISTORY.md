# The dated history

What the CRM remembers about its customers, shops, accounts, routes, regions and
photos, from when to when, and why. Data audit 2026-10-10, gaps 5, 6, 17 and 24;
migration `prisma/migrations/20261013100100_history_foundation`. The write paths
that used to lose what they changed (gaps 4, 7, 8, 12, 14, 15, 19, 20 and 27) are
in §9, migration `20261014100000_lossless_paths`.

The owner's rule (2026-10-11): everything is logged, history is appended and never
rewritten, and it is kept for ever. Effective dates matter from the day this
shipped, not for the past.

## 1. How it is written

The **database** writes the history, not the application. A trigger on each of
`Customer`, `Branch`, `User`, `Route` and `Region` appends one row to that table's
history each time a **watched** column really changes (an insert, an update that
changes a watched column, a hard delete). A change to a manager's regions
(`_ManagerRegions`) is recorded once, when the transaction commits, as the user's
final region set. No code path can skip it: a script, a hand-typed `UPDATE` and the
application are all recorded alike.

An update that touches only bookkeeping — `updatedAt`, `version`,
`completenessScore`, `lastEditedById`, `lastLoginAt`, `sessionsRevokedAt`,
`passwordHash`, the Temix upload-queue columns — writes nothing, and neither does
an update that sets a value it already had.
`tests/unit/history-migration-guard.test.ts` lists every column of the five tables
as watched or deliberately not, and fails on a new column until someone decides.

### Who and why: the change context

Every writer names the cause of its transaction with
`lib/change-context.ts`:

```ts
await withChangeContext(prisma, { actorId: session.id, source: src.edit(editId) }, async (tx) => { … });
```

That sets three transaction-local settings the triggers read:

| Setting | What | Empty means |
|---|---|---|
| `nmwc.actor` | the signed-in user who caused it (a `User.id`) | a job or an unattended script |
| `nmwc.source` | what caused it (below) | recorded as `sql`: nobody said |
| `nmwc.effective_from` | when it takes effect, `YYYY-MM-DD` (that Oman day's start) or an ISO instant with its offset | the transaction's own time |

`tests/unit/change-context-guard.test.ts` fails on any transaction in `app/`,
`lib/` or `services/` that does not go through `withChangeContext`, and on any
master write outside one; `tests/unit/scripts-change-context-guard.test.ts` makes
every script and seed that writes a master table name its run.

### Source taxonomy

`<kind>:<part>[:<part>…]` — identifiers only, never text a person typed.

| Source | Written by |
|---|---|
| `edit:<editId>` | a request: submit, draft save, every approval step, the final apply and a new customer's finalize (actor: the approver), reject, close and reactivation requests and decisions, the signed credit form, a Manager's or Steward's direct write |
| `import:<batch>:<row>:<lane>` | one row of a customer-master import; lane `full`, `refresh` (Temix code on record), `backup` (first Temix code), `fixed` (a row the Steward corrected in the app). `import:<batch>:<row>` alone while the row's lane is being decided (reads only). |
| `import:<batch>:<Sheet>!<row>` | one row of an account-master import (`Regions`, `Routes`, `Users`) |
| `import:<batch>:setup` / `:summary` | an import's own set-up (the UNASSIGNED region and route) and closing write |
| `import-fix:<batch>:<rowId>` | the Steward's correction of a held-back import row |
| `merge:<winner>:<loser>` | a duplicate merge |
| `archive:<customerId>` | a customer archived from its page |
| `photo:<attachmentId>` / `photo:upload` | a photo attached, replaced, removed or uploaded |
| `print:<id>` | a printout recorded |
| `users:<action>:<id or username>` | user administration: `create`, `toggle`, `reset`, `role`, `account`, `email` |
| `routes:<action>:<id or code>` | `create-region`, `create-route`, `toggle-region`, `toggle-route` |
| `temix:<action>:<batchId>` | the Temix upload queue: `generate`, `loaded` |
| `auth:logout`, `password:change` | sign-out, a person changing their own password |
| `cron:<job>` | a scheduled job (`sla-escalate`, `photo-gc`) |
| `script:<name>:<runId>` | an operator script run (`scripts/ops/*`, bulk credential reset, go-live bootstrap) |
| `seed:<name>` | a development or pilot seed |
| `migration:<name>` | a migration's own writes (the baseline) |
| `e2e:<runId>`, `test:<suite>`, `verify:<probe>` | test harnesses and rolled-back verification probes |
| `temix-daily:<fileId>:<row>` | reserved for the daily Temix file (item D) |
| `sql` | **nobody said**: see §5 |

`AuditLog` rows carry the same `source` and the transaction id `txId`, stamped by
the database. Joining a history row's `txId` to `AuditLog.txId` gives the reason,
the request and the audit trail of the same change.

## 2. The tables

All six are INSERT-only: UPDATE, DELETE and TRUNCATE are refused by the same
trigger function as `AuditLog`'s (`nmwc_forbid_audit_mutation`), and a direct
INSERT is refused too — only the capture triggers write here. The one exception is
the table owner's maintenance window (`SET LOCAL nmwc.audit_maintenance = 'on'` on
the owner connection), which fixture clean-up uses. The runtime role (`nmwc_app`)
may read them and holds no write privilege on them or their sequences
(`scripts/ops/app-role.ts`).

Columns every table has:

| Column | Meaning |
|---|---|
| `id` | strict order (BIGSERIAL) |
| `changeKind` | `BASELINE` (the first page, §3), `CREATE`, `UPDATE`, `DELETE` (a hard delete: the row keeps the last values) |
| `changedFields` | the watched columns that changed — **names only** for personal ones; `{}` on BASELINE, CREATE and DELETE |
| `validFrom` | when the change took effect (§4) |
| `recordedAt` | when it was written (wall clock, UTC) |
| `effectiveRequested` | the effective time the writer asked for; null = "same as recorded" |
| `actorId`, `source`, `sourceKind` | who and why (§1); `sourceKind` is the source's part before its first `:` |
| `txId` | the database transaction (joins `AuditLog.txId`) |
| `dbUser` | the database login: `nmwc_app` (the application) or the owner (scripts, hand-typed SQL) |

There is **no `validTo`**: a row is valid until the next row of the same record,
which the interval functions derive (§6). Storing it would need an UPDATE path
into an append-only table.

| Table | Key | Values kept | Recorded by name only |
|---|---|---|---|
| `CustomerHistory` | `customerId` | `nmwcCode`, `paymentTerms`, `creditLimit`, `paymentTermDays`, `temixCode`, `status`, `channelId`, `subChannelId`, `crPhotoId`, `deletedAt`, `mergedIntoId` (§9; null on rows written before it) | `legalName`, `crNumber`, `primaryPhone`, `altPhone`, `contactPerson`, `contactRole`, `email`, `notes` |
| `BranchHistory` | `branchId` | `branchCode`, `customerId`, `routeId`, `regionId`, `dayOfVisit`, `status`, `deletedAt`, `coolersCount`, `standsCount`, `emptyBottlesCount`, `equipmentConfirmed`, `hasGps` (whether a point is on file), `shopPhotoId`, `signboardPhotoId` | `branchName`, `address`, `areaDescription`, `gps` (the four GPS columns), `openingHours`, `deliveryWindow` |
| `UserHistory` | `userId` | `username` (as it was), `role`, `isActive`, `supervisorId`, `ownedRouteId`, `regionIds` (sorted) | `fullName`, `email`, `phone` |
| `RouteOwnerHistory` | `routeId` | `ownerId` (null = nobody): who held the route | — |
| `RouteHistory` | `routeId` | `code`, `name`, `regionId`, `isActive` | — |
| `RegionHistory` | `regionId` | `code`, `name`, `isActive` | — |
| `AttachmentHistory` | `attachmentId` | `kind`, `customerId`, `branchId`, `branchExtraId`, `editId`, `deletedAt`, `hash` (the image's SHA-256), `capturedById`, `capturedAt` (§9) | — (the capture GPS is never copied) |

**No personal value of a customer or an employee's contact details is copied into
the history.** It is kept for ever and cannot be erased, so it records that the
CR number, a phone or the address changed — when, by whom, from which import row —
but not the value (PDPL-ASSESSMENT Q4). The values a request changed stay in
`CustomerEdit` and `AuditLog`, as before.

Deliberately not tracked: the Temix upload-queue columns (`temixSyncState`,
`lastTemixUpload*`: `TemixSyncBatch.customerIds` already says which batches carried
a customer, and Generate flips thousands at once) and the channel taxonomy's
labels (locked; the same pattern can be added later).

## 3. The first page (baseline)

The migration wrote one `BASELINE` row for every customer, shop, account, route and
region that existed, and each user's region set, in the same transaction that
created the triggers, under locks — so no change can fall between the first page
and the first trigger row. A baseline row is valid from the record's `createdAt`,
with `recordedAt` = the migration's time and source
`migration:20261013100100_history_foundation`. A route whose holder's account was
created after the route has two baseline rows: nobody from the route's creation,
then the holder from his account's creation.

**What a baseline row means:** "this is what the record was when history began".
For any time before its `recordedAt` it is an **inference**, not a record: a shop
that moved route in September shows its October route from its creation. Every
as-of answer that rests on a baseline row for a time before it was recorded says
`inferred = true`. Earlier history is not replayed from `AuditLog` (the owner:
effective dates matter from now on). The official pilot-day backup is taken
separately.

**"Null = not recorded before `<date>`":** a history question about a time before
the migration was deployed (the baseline rows' `recordedAt`, the same for all of
them) has only the baseline to go on. Before a baseline's `validFrom` (the record's
`createdAt`) there is no row at all, and an as-of function returns nothing for it.
`AuditLog.source` and `AuditLog.txId` are null on every audit row written before
the deploy.

## 4. Effective dates (gap 17)

`validFrom` is:

- the writer's `nmwc.effective_from` when it set one: a day `YYYY-MM-DD` is the
  start of that day in Oman (Asia/Muscat, UTC+4); an instant needs its offset;
- otherwise the transaction's start time (for a CRM approval: the approval).

It is **never earlier than the same record's previous row** (it is clamped up to
it), so each record's chain stays in order even when an older transaction commits
after a newer one, or a load day precedes a change made earlier the same day.
`effectiveRequested` keeps what was asked. An effective time more than five minutes
in the future is refused by the database (and earlier by `lib/change-context.ts`).

CRM approvals pass no effective date: a change is effective when it is approved, as
the owner decided. No form asks for one.

## 5. Changes with no recorded cause (`sql`)

A write with no change context is still recorded, under source `sql`. Zero is
expected.

- `dbUser = nmwc_app`: an application path is missing its context — a **defect**.
  `/api/health` (bearer) reports the warning `history:unattributed` when one
  appeared in the last 24 hours. It never pages.
- any other `dbUser` (the owner): SQL typed by hand, or a script that does not name
  its run.

Where to see it: the Steward's **Record keeping** card on `/status` (30 days),
`npx tsx scripts/ops/history-report.ts --expect-host <host> [--days N]` (read-only),
or `SELECT * FROM nmwc_history_unattributed(now() AT TIME ZONE 'UTC' - interval '30 days');`.
`/api/health` also warns `history:triggers-disabled` or `history:triggers-missing`
when a history trigger is off or gone: changes would then go unrecorded.

## 6. Asking it: the as-of functions

SQL functions (read-only, `STABLE`, run with the caller's privileges). Times are
UTC `timestamp`s, as in every table.

**"On day D"** means the state at the **end of that Oman day**: a change made or
loaded at any time on D counts for D (`nmwc_day_end(d)` = the start of D+1 in
Muscat, in UTC). `*_at(ts)` answers for an exact instant.

| Function | Answers |
|---|---|
| `nmwc_customer_service_on(customer_id, d)` | who served customer X on d: per live shop, its route and region (with codes), visit day, status, and the salesman who held the route then (his username as it was), `inferred` |
| `nmwc_customer_route_intervals(customer_id)` | which routes served X, from when to when, with the salesman of each stretch (every shop ever X's) |
| `nmwc_customer_terms_on(customer_id, d)` | X's cash/credit, limit, days, Temix code, status, channel on d |
| `nmwc_route_owner_on(route_id, d)` | who held route R on d |
| `nmwc_user_on(user_id, d)` | a user's role, supervisor, regions, route (and its region), active, on d |
| `nmwc_branches_at(ts)` / `nmwc_branches_on(d)` | every shop's state then |
| `nmwc_customers_at(ts)` / `nmwc_customers_on(d)` | every customer's terms and status then |
| `nmwc_users_at(ts)` / `nmwc_users_on(d)` | every account then |
| `nmwc_routes_at(ts)`, `nmwc_route_owners_at(ts)` / `nmwc_route_owners_on(d)` | routes and their holders then |
| `nmwc_branch_intervals(id)`, `nmwc_customer_intervals(id)`, `nmwc_user_intervals(id)`, `nmwc_route_owner_intervals(route_id)` | one record's rows, oldest first, with `valid_to` |
| `nmwc_history_unattributed(since)` | §5 |

Examples (run on the owner or the runtime role's connection):

```sql
-- Which routes served customer C12345, from when to when, and which salesman:
SELECT * FROM nmwc_customer_route_intervals((SELECT id FROM "Customer" WHERE "nmwcCode" = 'C12345'));

-- Who served it on 15 November 2026:
SELECT branch_code, route_code, salesman_username, branch_status, inferred
  FROM nmwc_customer_service_on('<customer id>', DATE '2026-11-15');

-- When it was created (CREATE with edit:<id> or import:<batch>:<row>, or BASELINE with its createdAt, inferred):
SELECT valid_from, change_kind, source, actor_id FROM nmwc_customer_intervals('<customer id>') LIMIT 1;

-- Its terms on 31 December 2026:
SELECT payment_terms, credit_limit, payment_term_days, temix_code, status, channel_id
  FROM nmwc_customer_terms_on('<customer id>', DATE '2026-12-31');

-- Who held route R on 1 November 2026; a user that day:
SELECT * FROM nmwc_route_owner_on('<route id>', DATE '2026-11-01');
SELECT * FROM nmwc_user_on('<user id>', DATE '2026-11-01');

-- The shops on route R that day:
SELECT * FROM nmwc_branches_on(DATE '2026-11-01') WHERE route_id = '<route id>' AND deleted_at IS NULL;

-- The master as of a date (non-personal columns):
SELECT * FROM nmwc_branches_on(DATE '2026-11-01') b JOIN nmwc_customers_on(DATE '2026-11-01') c USING (customer_id);

-- Why a change happened: the audit rows of the same transaction.
SELECT a.* FROM "BranchHistory" h JOIN "AuditLog" a ON a."txId" = h."txId" WHERE h.id = <history id>;
```

## 7. How the daily Temix file plugs in (item D, later)

Nothing in the history needs to change. Each file row runs in its own transaction:

```ts
await withChangeContext(prisma,
  { actorId: null /* or the Steward who loaded it */, source: src.temixDaily(fileId, row), effectiveFrom: loadDay /* 'YYYY-MM-DD' */ },
  async (tx) => { /* route, cash/credit, limit, days; skip a row that changes nothing */ });
```

The move is then valid from the start of the load day in Oman (clamped after any
CRM change already recorded that day), which is the owner's rule: a change brought
by the daily file is effective the day the file is loaded. An unchanged row writes
nothing (the same no-bump rule as the master import).

## 8. Operations

- **Kept for ever.** Never swept (`docs/compliance/DATA-RETENTION-SCHEDULE.md`).
  About 31k baseline rows, then an estimated 100k–300k rows a year.
- **Maintenance:** only the table owner, in a maintenance transaction, may delete
  history rows — the same window as `AuditLog` (`docs/OPERATIONS.md`). On UAT,
  `scripts/qa/purge-orphan-history.ts` (dry run by default, refuses production)
  removes the history of records that no longer exist; integration suites call
  `purgeHistory` (`tests/support/audit.ts`), and the launch e2e clean-up purges its
  world's history last (`tests/e2e/launch/support/cleanup.ts`, step 10).
- **Checks:** `scripts/ops/app-role.ts verify` proves the runtime role cannot write
  the history and that a change it makes is recorded; `scripts/ops/restore-verify.ts`
  F-03/F-04 prove a restored database still records and still refuses a rewrite.
- **Cost per write:** one extra statement per write transaction (`set_config`); a
  changed row adds one index lookup and one insert. An import names each row it
  writes (one more statement per row).

## 9. Lossless write paths (gaps 4, 7, 8, 12, 14, 15, 19, 20, 27)

Migration `20261014100000_lossless_paths`. The history above records what a
watched column became; these paths also lost *where a value came from* or *what a
request was*. Each is now kept, append-only.

| Gap | What is kept now | Where |
|---|---|---|
| 4 — the customer-master import | A customer or shop the row leaves as it is is **not written** (no version, editor or `updatedAt` bump; a shop change moves only the customer's `updatedAt`, for the export's "updated since"). Each customer and shop it creates or changes has an `AuditLog` `CREATE`/`UPDATE` row with the before and after of the changed fields and the lineage `{batchId, importRowId, rowNumber, lane}`, reason `import <batch> row <n> (<lane>)`; the history rows say `import:<batch>:<row>:<lane>`. | `services/imports.ts`, `lib/import-lineage.ts` |
| 7 — which file and row | `ImportBatch.fileSha256` and `fileBytes` (the file itself is not kept); `Customer.importRowId` names the row that created it; a Steward's correction of a held-back row records each corrected cell — old and new value for codes, channel, visit day and status, SHA-256 fingerprints for a name, address, phone, CR number, contact or note. The 90-day sweep empties the row's payload; the history's source, the audit rows and the batch's file fingerprint survive it. | `services/import-fixes.ts` |
| 8 — merges | `Customer.mergedIntoId` (set by the merge, filled for earlier merges from their MERGE rows, dated when they happened); `CustomerEdit.originalCustomerId`, set once by the database (trigger `customeredit_original_customer`) and never moved by a merge. The MERGE row lists `movedBranchIds`, `movedAttachmentIds`, `repointedEditIds`, `autoClosedEditIds` and the loser's non-personal standing (`loserSnapshot`), and always keeps the typed reason; each request the merge closed has its own `REJECT` row; moved shops get `version + 1`. Searching a merged code, or opening its old page, leads to the customer it was merged into. | `services/duplicates.ts`, `lib/merged-customers.ts` |
| 12 — a new-customer request's rounds | `EditRevision`: one row per submit (never a draft), in the submit's transaction — cycle, terms, credit figures, the chain, and a payload of the channel, each shop's route, region, visit day, counts and photo ids, and the documents by kind; the name, CR number, phones, contact, e-mail, notes and each shop's name, address, hours and GPS point as fingerprints only. `payloadSha256` says whether two rounds sent the same thing. A send-back's category is on its `EditApproval` row (`category`) and its `REJECT` row (`decisionCategory`). | `services/creates.ts`, `lib/edit-revision.ts` |
| 14 — exports | Every export writes an `ExportJob` (kind, the filters and role scope, `customerIds`, `filename`, `fileSha256` of the exact bytes) and its `EXPORT` row (entityId = the job's id) in one transaction before the bytes are sent. `ExportJob` is append-only. The file itself is never stored. | `lib/export-record.ts` |
| 15 — photos | `AttachmentHistory`, written by the database like the tables above, with a BASELINE for every photo row that existed and a DELETE tombstone when photo-gc drops a row. A removed or replaced photo keeps its `hash` (dedupe reads live rows only). A slot write names the photo it replaced (`replacedAttachmentId`) and the replaced one gets a `SOFT_DELETE` row; so does a photo released by a new-customer resubmit or a signed-application page left out of a new upload. Remove's audit row says what was removed and from where. | `services/photos.ts` |
| 19 — approval evidence | Once a request has left DRAFT or NEEDS_CORRECTION, what it asked for (`fieldChanges`, `attachmentChanges`), who sent it and when, its process, target, gate, chain, credit figures, cycle, shop and submission id **cannot change** (trigger `customeredit_evidence_guard`), and a request cannot be deleted (`customeredit_no_delete`, `_no_truncate`); the owner's maintenance window is the only way past. Every update, close-shop and reactivation submit writes a `CustomerEdit` `CREATE` row with the request as sent. An `APPROVE` row adds what was `applied`, what was `alreadyLive`, what the submitter's role was `lockedOut` of, and the gate's shops; a direct write lists every applied change, customer and shop. | `services/edits.ts`, `services/reactivations.ts`, `lib/request-evidence.ts` |
| 20 — reopening | A close or reactivation request stores the photo's capture time and the shop's closure time it was checked against (`attachmentChanges`). The `REACTIVATE` row records the request, the evidence, the closure time and where it came from (`closureReference`: the request, the shop's dated history, or none) and the Manager's reason when the form sends one. Acceptance rules are unchanged. | `services/reactivations.ts` |
| 27 — a new customer's shops | At finalize each draft names the shop it became (`EditBranchDraft.branchId`), shops are numbered in draft id order, and each shop has a `Branch` `CREATE` row (draft, route, region, visit day, GPS present, counts, the request). A submit's audit row carries `duplicateSignals` (live customers on the phone, at most ten; whether the CR is a live customer's); a submit refused as an exact duplicate leaves a `REJECT` row on `CustomerCreateAttempt`. | `lib/create-finalize.ts`, `services/creates.ts` |

Examples:

```sql
-- Which import file and row last set this shop's route?
SELECT h."validFrom", h."source", b."filename", b."fileSha256"
  FROM "BranchHistory" h
  LEFT JOIN "ImportBatch" b ON b."id" = split_part(h."source", ':', 2)
 WHERE h."branchId" = '<id>' AND 'routeId' = ANY (h."changedFields") AND h."sourceKind" = 'import'
 ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1;

-- Which photo was in the shop slot on 1 Nov 2026, and is its fingerprint still known?
SELECT b.shop_photo_id, a."hash", a."changeKind"
  FROM nmwc_branches_on(DATE '2026-11-01') b
  LEFT JOIN LATERAL (SELECT * FROM "AttachmentHistory" x WHERE x."attachmentId" = b.shop_photo_id
                     ORDER BY x."validFrom" DESC, x."id" DESC LIMIT 1) a ON true
 WHERE b.branch_id = '<id>';

-- What did round 1 of a new-customer request contain?
SELECT "cycle", "submittedAt", "paymentTerms", "requestedCreditLimit", "payload"
  FROM "EditRevision" WHERE "editId" = '<id>' ORDER BY "cycle", "id";

-- Which exports held customer X?
SELECT j."id", j."kind", j."filename", j."fileSha256", j."completedAt", j."requestedById"
  FROM "ExportJob" j WHERE '<customerId>' = ANY (j."customerIds") ORDER BY j."startedAt";
```

Kept for ever like the rest of the history: `AttachmentHistory`, `EditRevision`,
`ExportJob`. `ExportJob.customerIds` of a full master export is about 14,000 ids
(~0.4 MB); a daily master export would add ~130 MB a year — see
`docs/compliance/DATA-RETENTION-SCHEDULE.md`.
