# The dated history

What the CRM remembers about its customers, shops, accounts, routes, regions and
photos, from when to when, and why. Data audit 2026-10-10, gaps 5, 6, 17 and 24;
migration `prisma/migrations/20261013100100_history_foundation`. The write paths
that used to lose what they changed (gaps 4, 7, 8, 12, 14, 15, 19, 20 and 27) are
in §9, migration `20261014100000_lossless_paths`. Who decided as what (gap 11),
the scheduled jobs' days (21), the losing side of two saves at once (22), sign-in
events and session cut-offs (23) and the rule that a route never changes region
(16) are in §10, migrations `20261015100000_authority_jobs_auth_events` and
`20261015100100_route_region_fixed`. Where to read a customer's history in the
app (the Data Steward's History page) is §11. The nightly seal, integrity checks,
purge summaries and test flag that prove it untouched (gaps 25, 28, 29, 30) are §12.

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
an update that sets a value it already had. (A move of `sessionsRevokedAt` — a
session cut-off — is recorded in `AuthEvent` instead, §10.)
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
| `import:<batch>:<row>:<lane>` | one row of a customer-master import; lane `full`, `refresh` (Temix code on record), `backup` (first Temix code), `fixed` (a row the Steward corrected in the app). A customer's group opens under its first row and the lane that row most likely takes; the lane is decided under the lock and the row renamed before any write when the guess was wrong. |
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
| `auth:login-fail`, `auth:rate-limited` | a failed sign-in or a throttle refusal kept in `AuthEvent` (§10) |
| `conflict:<path>:<id>` | the `CONFLICT` audit row of a save that lost a race (§10): `edit.approve`, `edit.reject`, `edit.submit`, `edit.direct`, `edit.apply`, `create.submit`, `photo.detach`, … |
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
| `RouteOwnerHistory` | `routeId` | `ownerId` (null = nobody): who held the route. A route opened after the baseline starts its chain with a `CREATE` row of nobody, written with the route; the first salesman's take follows | — |
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
that moved route in September shows its October route from its creation. The same
holds for any other row a migration wrote for a time before it ran — the merges
made before §9's migration are dated when they happened, but carry the loser's
other values as found at the migration. Every as-of answer that rests on a row
written by a migration (source `migration:…`, or a `BASELINE`) for a time before
it was recorded says `inferred = true` (`from_inferred` on the interval
functions). Earlier history is not replayed from `AuditLog` (the owner:
effective dates matter from now on). The official pilot-day backup is taken
separately.

**"Null = not recorded before `<date>`":** a history question about a time before
the migration was deployed (the baseline rows' `recordedAt`, the same for all of
them) has only the baseline to go on. Before a baseline's `validFrom` (the record's
`createdAt`) there is no row at all, and an as-of function returns nothing for it.
**An empty answer about a time before the baseline is not evidence**: a shop moved
to another customer, or merged away, before history began is on the baseline under
its customer of then — the other one. The two "who served customer X" functions
therefore never answer "nothing" for such a time: they return one row with no shop
and `note = 'no-shop-recorded'` (§6). `AuditLog.source` and `AuditLog.txId` are
null on every audit row written before the deploy.

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

- `dbUser` = the login the application connects as: an application path is
  missing its context — a **defect**. `/api/health` (bearer) reports the warning
  `history:unattributed` when one appeared in the last 24 hours. It never pages.
  The application's login is read from its own connection, not assumed: it
  should be `nmwc_app`, but while production still connects as the table owner
  (AUDITOR-BRIEF §8) the owner's rows count here — a change typed by hand under
  that login cannot be told from the application's then, and the card says so.
- any other `dbUser`: SQL typed by hand, or a script that does not name its run.

A session cut-off written with no context (`AuthEvent`, `SESSION_REVOKE`, source
`sql`, §10) is in the same report, as table `AuthEvent`, with the login that wrote
it (`AuthEvent.dbUser`).

Where to see it: the Steward's **Record keeping** card on `/status` (30 days),
`npx tsx scripts/ops/history-report.ts --expect-host <host> [--days N]` (read-only),
or `SELECT * FROM nmwc_history_unattributed(now() AT TIME ZONE 'UTC' - interval '30 days');`.
`/api/health` also warns `history:triggers-disabled` or `history:triggers-missing`
when a history trigger is off or gone: changes would then go unrecorded.

## 6. Asking it: the as-of functions

SQL functions (read-only, `STABLE`, run with the caller's privileges). Times are
UTC `timestamp`s, as in every table. The answers about customers carry
`merged_into_id`: the customer a duplicate merge folded this one into (§9), from
the merge on.

**"On day D"** means the state at the **end of that Oman day**: a change made or
loaded at any time on D counts for D (`nmwc_day_end(d)` = the start of D+1 in
Muscat, in UTC). `*_at(ts)` answers for an exact instant.

| Function | Answers |
|---|---|
| `nmwc_customer_service_on(customer_id, d)` | who served customer X on d: per live shop, its route and region (with codes), visit day, status, and the salesman who held the route then (his username as it was), `inferred`. No shop then: one row with no shop and a `note` — `merged` (X had been merged into `merged_into_id`, whose shops they were) or `no-shop-recorded` (the time is before X's first page was written, so unknown) — instead of an empty answer; an empty answer is a recorded "no live shop" |
| `nmwc_customer_route_intervals(customer_id)` | which routes served X, from when to when, with the salesman of each stretch (every shop ever X's). Nothing of a stretch is dropped: a route opened after the baseline is held by nobody until its first salesman (salesman null, `note` null); a stretch that begins before its route's own first row (a move loaded effective earlier than the route's creation was recorded) has that part with no salesman and `note = 'holder-unrecorded'`. Rows with no shop say where X was not on record: `merged` (from the merge on, `merged_into_id`) and `no-shop-recorded` (before X's first page was written, when no shop of X is on record then) |
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

-- Gap 18: where a request was raised. Sent since 20261025090100: read it.
SELECT "routeIdAtSubmit", "regionIdsAtSubmit" FROM "CustomerEdit" WHERE id = '<edit id>';
-- Sent before (both empty): the history as of its submittedAt answers it — the
-- route the submitter held then, and the region each shop it names was in then.
-- INFERRED when submittedAt is before the first page (§3, 'inferred' = true).
SELECT u.owned_route_id, u.inferred
  FROM "CustomerEdit" e, nmwc_users_at(e."submittedAt") u
 WHERE e.id = '<edit id>' AND u.user_id = e."submittedById";
SELECT b.branch_id, b.region_id, b.inferred
  FROM "CustomerEdit" e, nmwc_branches_at(e."submittedAt") b
 WHERE e.id = '<edit id>' AND b.customer_id = e."customerId";
-- A decision counted for the region the shop was in when it was decided
-- (EditApproval.scopeRegionIds holds it since part C; before, the history):
SELECT a."editId", a."at", b.region_id
  FROM "EditApproval" a JOIN "CustomerEdit" e ON e.id = a."editId",
       nmwc_branches_at(a."at") b
 WHERE b.branch_id = e."branchId";
```

The app itself still attributes past activity to today's route and region (the
insights cards say "current", and a Manager's /audit and region-scoped figures
follow the region now): switching either is the owner's open question A6
(04-PENDING-WORK), and changes what a Manager sees. The history and the columns
above make the "at the time" answer possible with no further schema change.

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
  the history and that a change it makes is recorded, that a session cut-off is
  recorded once, and that a route cannot change region; `scripts/ops/restore-verify.ts`
  F-03/F-04 prove a restored database still records and still refuses a rewrite,
  and F-05 that it still refuses to move a route to another region.
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
| 8 — merges | `Customer.mergedIntoId` (set by the merge, filled for earlier merges from their MERGE rows, dated when they happened; those rows are `inferred` before the migration, §3); `CustomerEdit.originalCustomerId`, set once by the database (trigger `customeredit_original_customer`) and never moved by a merge. For the requests that existed before the migration it is **best effort**: the customer named by their own decision row, else their current customer — but NULL ("not known") where an earlier merge makes that a guess (a request now on a merge's winner, made before that merge, with no decision row naming its customer from before it), unless that merge's own auto-close named the loser. A NULL stays NULL: a later repoint is not a request's first customer. The MERGE row lists `movedBranchIds`, `movedAttachmentIds`, `repointedEditIds`, `autoClosedEditIds` and the loser's non-personal standing (`loserSnapshot`), and always keeps the typed reason; each request the merge closed has its own `REJECT` row; moved shops get `version + 1`. Searching a merged code, or opening its old page, leads to the customer it was merged into. | `services/duplicates.ts`, `lib/merged-customers.ts` |
| 12 — a new-customer request's rounds | `EditRevision`: one row per submit (never a draft), in the submit's transaction — cycle, terms, credit figures, the chain, and a payload of the channel, each shop's route, region, visit day, counts and photo ids, and the documents by kind; the name, CR number, phones, contact, e-mail, notes and each shop's name, address, hours and GPS point as fingerprints only. `payloadSha256` says whether two rounds sent the same thing. A send-back's category is on its `EditApproval` row (`category`) and its `REJECT` row (`decisionCategory`). | `services/creates.ts`, `lib/edit-revision.ts` |
| 14 — exports | Every export writes an `ExportJob` (kind, the filters and role scope, `customerIds`, `filename`, `fileSha256` of the exact bytes) and its `EXPORT` row (entityId = the job's id) in one transaction before the bytes are sent: the customer master (`customer-master`), the filtered list (`customers-filtered`), the field-update report (`field-updates`) and the Temix upload file (`temix-batch`, on Generate and on every re-download: `filters.batchId`, `action`, the codes held back; `customerIds` = the customers written to that copy). A Temix batch's claim keeps its own `EXPORT` row keyed by the batch. `ExportJob` is append-only. The file itself is never stored. | `lib/export-record.ts`, `services/temix.ts` |
| 15 — photos | `AttachmentHistory`, written by the database like the tables above, with a BASELINE for every photo row that existed and a DELETE tombstone when photo-gc drops a row. A removed or replaced photo keeps its `hash` (dedupe reads live rows only). A slot write names the photo it replaced (`replacedAttachmentId`) and the replaced one gets a `SOFT_DELETE` row; so does a photo released by a new-customer resubmit or a signed-application page left out of a new upload. Remove's audit row says what was removed and from where. | `services/photos.ts` |
| 19 — approval evidence | Once a request has left DRAFT or NEEDS_CORRECTION, what it asked for (`fieldChanges`, `attachmentChanges`), who sent it and when, its process, target, gate, chain, credit figures, cycle, shop and submission id **cannot change** (trigger `customeredit_evidence_guard`), and a request cannot be deleted (`customeredit_no_delete`, `_no_truncate`); the owner's maintenance window is the only way past. Its state moves only forward, so the freeze cannot be stepped around: a decided request (APPROVED, REJECTED) is never reopened, a sent one goes back to its sender only as NEEDS_CORRECTION (the send-back) — never as a DRAFT — and an open one is approved only once sent. Every update, close-shop and reactivation submit writes a `CustomerEdit` `CREATE` row with the request as sent. An `APPROVE` row adds what was `applied`, what was `alreadyLive`, what the submitter's role was `lockedOut` of, and the gate's shops; a direct write lists every applied change, customer and shop. | `services/edits.ts`, `services/reactivations.ts`, `lib/request-evidence.ts` |
| 20 — reopening | A close or reactivation request stores the photo's capture time and the shop's closure time it was checked against (`attachmentChanges`). The `REACTIVATE` row records the request, the evidence, the closure time and where it came from (`closureReference`: the request, the shop's dated history, or none) and the Manager's reason when the form sends one. Acceptance rules are unchanged. | `services/reactivations.ts` |
| 37 — the rules a request was sent under | The approval chain is frozen through `freezeChain` for every sent request — close and reactivation included, which froze none before (a reactivation's page then named the Supervisor fallback) — and can be stored as `{ v, calendar, steps }`: the matrix version (`CHAIN_VERSION`), the working calendar in force (`WORK_*`: offset, week, window) and the steps with their budgets. **This build reads that form and still writes the bare array; the object is written once `CHAIN_OBJECT_FORM_ENABLED` is turned on** by its own commit, after this build is production's rollback target (the build before reads an object as one Supervisor step: OPERATIONS §4). Until then no calendar is recorded per request; the ESCALATE rows keep theirs (gap 21). The `EditRevision` of a new-customer round holds the same value as its request. The bare array reads as version 0 (no calendar). A stored value that is not a chain is refused, never read as the Supervisor fallback. Deadlines are still computed on the live calendar; a `WORK_*` or `SLA_*` change is a dated entry in the private operations log (OPERATIONS §3). | `lib/approval-chains.ts` (`freezeChain`, `readFrozenChain`), `services/edits.ts`, `services/creates.ts`, `services/reactivations.ts` |
| 37 — archive and hand-over | Archiving a customer closes its unsent drafts (REJECTED, `withdrawn`, one `UPDATE` row each, `closedBy: archive`), leaves its sent-back requests as the record of the send-back, and lists both on the `SOFT_DELETE` row (`openRequests`, ids capped at 200, with counts); a request in review still blocks it, and a request can no longer land on a customer archived a moment earlier (both take the customer's row lock). A route hand-over (`REASSIGN`, on /users and in the account import), a disable and an account edit that changes the route or role record the person's `openWork`: requests in review, drafts, sent-back, those the change withdrew (ids, capped at 200, with counts) and his photos on no slot (a count). Requests left open on customers archived before are not touched (an open owner question). | `services/customers.ts`, `lib/archive-open-requests.ts`, `lib/locks.ts`, `services/users.ts`, `services/imports.ts`, `lib/open-work.ts` |
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

-- Which exports held customer X (the Temix upload files included)?
SELECT j."id", j."kind", j."filename", j."fileSha256", j."completedAt", j."requestedById"
  FROM "ExportJob" j WHERE '<customerId>' = ANY (j."customerIds") ORDER BY j."startedAt";
```

Kept for ever like the rest of the history: `AttachmentHistory`, `EditRevision`,
`ExportJob`. `ExportJob.customerIds` of a full master export is about 14,000 ids
(~0.4 MB); a daily master export would add ~130 MB a year — see
`docs/compliance/DATA-RETENTION-SCHEDULE.md`.

## 10. Who decided, the jobs' days, lost races, sign-ins, and the route rule (part C)

Migrations `20261015100000_authority_jobs_auth_events` and
`20261015100100_route_region_fixed`. Additive; nothing existing is rewritten.

| Gap | What is kept now | Where |
|---|---|---|
| 11 — who decided, as what | Every `EditApproval` row says, beside the step's `role`: the decider's own role (`actorRole`), why he could decide (`authorityBasis`: `SUPERVISOR_OF_SUBMITTER` the salesman's own Supervisor, `REGION_MANAGER` a Manager of every region of the request — the Supervisor step's fallback, and every reactivation decision —, `REGION_OVERLAP` an Accountant over one of its regions, `GLOBAL` the Finance Manager, GM or Sales Director, `SUBMITTER` the salesman's own signed-application upload, never an approval), the regions the request covered (`scopeRegionIds`) and the salesman's route (`submitterRouteId`), as they were at that moment. The database refuses any other basis. A reactivation's approve and "Keep closed" now write their `EditApproval` row too (stepIndex 0, the MANAGER step); `/status` reads reactivations from the request, so its figures leave those rows out and do not change. Rows written before part C keep these columns empty: **not recorded then**, never guessed. | `lib/permissions.ts` `stepAuthority` (`canActOnStep` is its wrapper), `services/edits.ts`, `services/signed-form.ts`, `services/reactivations.ts` |
| 18 — where a request was raised | `CustomerEdit.routeIdAtSubmit` and `regionIdsAtSubmit` (migration `20261025090100_request_scope_at_submit`): a new customer's draft route and its region; otherwise the submitter's own route when he sent it (null if he held none) and the regions of the request's scope then, by the queue's rule — what `submitterRouteId` and `scopeRegionIds` record for a decision. Written once with the SUBMITTED state (a resubmit writes them again), frozen by the evidence guard, and carried by the sealed `CREATE` row. The route link is a foreign key (RESTRICT, added NOT VALID). Rows sent before stay null and empty: **not recorded then** — §6 gives the as-of query, inferred before the first page. Nothing reads them to decide visibility (owner question A6). | `lib/scope-at-submit.ts`, `services/edits.ts`, `services/creates.ts`, `services/reactivations.ts`, `lib/request-evidence.ts` |
| 21 — escalations and job runs | The `ESCALATE` row (source `cron:sla-escalate`) says which step of which round was late (`stepIndex`, `cycle`), from when (`stageEnteredAt`), on what budget and working calendar (`budgetMin`, `calendar`), at which `level`, and who was told (`audienceUserIds`) — the notifications that say the same are deleted after 90 days. `JobRunDay`: one row per scheduled job per Oman day — runs, failures, first and last start, the slowest run, the schedulers — written by the retention sweep for every day that is over, before that day's runs may be pruned; a `CronRun` row past 90 days is deleted only once its day has its row. Filled at the migration from the runs that existed. No system user: `AuditLog.source` names the job. | `app/api/cron/sla-escalate`, `lib/job-run-day.ts`, `app/api/cron/retention-sweep` |
| 22 — the losing side of two saves at once | A save refused because another landed first — `NOT_PENDING`, `VERSION_CONFLICT`, `STALE_FIELDS`, `STALE_BEFORE`, `STALE_VIEW`, `EDIT_LOCKED`, `STATE_CHANGED`, `ROW_CHANGED`, `PHOTO_CHANGED` — leaves one `CONFLICT` audit row under the loser's name, source `conflict:<path>:<id>`, written in its own transaction after his has rolled back: the write that lost, the field names (never values), the version or stage he expected and the one he found, and for a request what the winner left (`live`: state, step, who decided, when). Best-effort: the 409 he sees is unchanged. Imports and merges do not lose races, they win them; what they overwrite is in their own rows (§9). | `lib/errors.ts` (`ConflictMeta`, `runAction`), `lib/conflict-record.ts`; `tests/unit/conflict-meta-guard.test.ts` fails on a throw of those codes without its meta |
| 23 — sign-ins and session cut-offs | `AuthEvent`, append-only, kept for ever. `SESSION_REVOKE`: written by the **database** (trigger `user_session_revoke_capture`) whenever `User.sessionsRevokedAt` moves — sign-out, disable, password change or reset, role change, an account-import row — with the writer's actor and source (`sql` when none: then it is in the §5 report, with its login in `dbUser`) and what moved with it (`reason`: `deactivated`, `password`, `role`, `route`, `username`). `LOGIN_FAIL_UNKNOWN`: a name no account has (`not_found`, `demo_disabled`, or `retired_username` when an account used to hold it). `LOGIN_RATE_LIMITED`: a throttle refusal, at most one row per bucket (`ip` or `user`) per five minutes. `LOGIN_FAIL_REUSED_NAME`: a failure on an account whose name another account held before — a leaver typing his old route sign-in name — beside its `LOGIN_FAIL` audit row. The typed name is **never stored**: `usernameHmac` is HMAC-SHA256 of the trimmed, lower-cased name under a key derived from `AUTH_SECRET` (HKDF, label `nmwc-auth-event-v1`), `keyId` the first 8 hex digits of the key's SHA-256. The 30-day logs no longer carry the typed name either. | `lib/auth.ts`, `lib/auth-events.ts`, `lib/sign-in-events.ts` |
| 16 — a route never changes region | The owner's rule (2026-10-11): routes never move to another region, are never renamed, split or merged; a route may be closed and its customers moved to other routes, and a route for another region is a new route. The database refuses any change of `Route.regionId` (trigger `route_region_fixed`), for every role and path, with no override — not even the maintenance window: *"Routes never move to another region. Close this route and open a new one in the other region."* The account-master import holds back a Routes row that names another region than the stored route's, in the same words; its label (`name`) may still change. The migration reported, read-only, how many shops carry a region other than their route's. | `lib/route-region.ts`, `services/imports.ts`, `docs/OPERATIONS.md` |

Examples:

```sql
-- Did anyone approve outside their region? Decisions made as the region's Manager
-- whose request covered a region the decider did not manage at that moment.
SELECT a."editId", a."at", a."actorId", a."scopeRegionIds", u."regionIds"
  FROM "EditApproval" a
  CROSS JOIN LATERAL (
    SELECT h."regionIds" FROM "UserHistory" h
     WHERE h."userId" = a."actorId" AND h."validFrom" <= a."at"
     ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) u
 WHERE a."authorityBasis" = 'REGION_MANAGER'
   AND NOT (a."scopeRegionIds" <@ u."regionIds");

-- Did the SLA sweep run on 3 November 2026, and how often did it fail?
SELECT "runs", "failures", "firstAt", "lastAt", "sources"
  FROM "JobRunDay" WHERE "key" = 'sla-escalate' AND "day" = DATE '2026-11-03';

-- Who lost a race on this request, and to what?
SELECT "at", "actorId", "reason", "after"
  FROM "AuditLog" WHERE "action" = 'CONFLICT' AND "entityId" = '<editId>' ORDER BY "at";

-- Every time this account's sessions were cut off, and why.
SELECT "at", "reason", "source", "actorId" FROM "AuthEvent"
 WHERE "kind" = 'SESSION_REVOKE' AND "userId" = '<userId>' ORDER BY "at";

-- Failed sign-ins on names no account has, by fingerprint, last 7 days.
SELECT "usernameHmac", "keyId", count(*), min("at"), max("at"), array_agg(DISTINCT "ip")
  FROM "AuthEvent"
 WHERE "kind" IN ('LOGIN_FAIL_UNKNOWN', 'LOGIN_RATE_LIMITED') AND "at" > now() - interval '7 days'
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

To ask "did anyone try the name X?", fingerprint X with the same key
(`lib/sign-in-events.ts` `usernameFingerprint`, with `AUTH_SECRET`) and look the value
up; a row whose `keyId` differs was written under an earlier secret.

Kept for ever: `JobRunDay`, `AuthEvent`, and the new `EditApproval` columns with
their table. An `ESCALATE` and a `CONFLICT` row are `AuditLog` rows and are kept
like the rest of it.

## 11. In the app: the customer's History page (Data Steward)

`/customers/<id>/history`, opened from the **History** button on the customer
page (and **Shop history** on each shop card, `?shop=<branchId>`). The owner's
goal: "this route served it, then that route; the date it was created; who
changed what and when". Read-only; nothing in the database changed for it.

| Section | What it shows | Read from |
|---|---|---|
| Created | how the customer came to be: the new-customer request (who sent it, who approved it), the import file and row (who promoted it), or another cause; a customer that existed when history began reads "on record at history start", with the lineage its live row carries (import batch, creator). A shop's view: the shop's first row on this customer, or its move in | its first `CustomerHistory` row (read on its own, so it survives the read cap) |
| Routes that served this customer | per shop: route, the salesman who held it in that stretch (his name now, and the username he signed in with then), from – until in Oman dates (the last day is inclusive: a move effective at Oman midnight on 16/10 reads "… – 15/10", then "16/10 – now"); "Nobody held the route", "Salesman not recorded", the inferred badge, and the merged / not-on-record notes | `nmwc_customer_route_intervals` (§6) |
| Terms over time | cash/credit, credit limit (OMR), credit days, Temix code, status, channel, and whether the record was live, archived or merged — one card per stretch in which none of them moved, with who set it and why | `CustomerHistory` |
| Every change | one entry per transaction and cause, newest first, 25 a page: when (the effective time, and when it was recorded if an effective date was asked for or the two are a minute or more apart), who (name and role **at that moment**, or the job, script or file), what (field by field: values for the non-personal fields, "**<field>: changed**" for every personal one), and a link to what caused it | `CustomerHistory`, `BranchHistory`, `AttachmentHistory` (the credit documents and the guarantee), `UserHistory` (role then) |

- **No personal value from the history is shown.** Changed personal fields read
  "**<field>: changed**": the history tables store a name, phone, CR number,
  contact, e-mail, note, address, opening hours or GPS point by field name only
  (§2), and the page never reads `AuditLog`, whose before/after values and typed
  reasons can hold them. A field the code does not know reads "changed" too
  (`lib/customer-history.ts`, `fieldChange`; `tests/unit/customer-history.test.ts`
  pins the lists to the PII register). The page header and the shop picker show
  today's customer and shop names (`Customer.legalName`, `Branch.branchName`),
  and "who" shows account full names, read from the live tables as the customer
  page does; the PII register classes these as name data.
- **A cause the app does not write is not printed.** The database keeps any
  `nmwc.source` text (up to 200 characters, one typed in psql say), so a source
  that fails `SOURCE_RE` reads "A cause not in the app's list (its text is not
  shown)". A source that matches `SOURCE_RE` but whose kind this version does not
  know yet is shown as it is, in monospace, with no link.
- **Links** go only where the Data Steward can go: a request to
  `/audit?entityType=CustomerEdit&q=<editId>` (a Manager's or Steward's direct
  write to `/audit?entityType=Customer&q=<customerId>`, where its ledger row is),
  an import row to `/import/<batch>`, a merge to `/audit?action=MERGE&q=<winner>`,
  an archive to the customer's audit rows, a photo change to the audit rows of
  the customer, shop or document it was on, route and Temix changes to `/routes`
  and `/temix`. A job, script, daily Temix file, test harness or `sql` has no link.
- **Who may open it:** the Data Steward only (`lib/permissions.ts`
  `canSeeCustomerHistory`), checked before anything is read, so any other role
  is sent home whether the customer exists or not. A default for the owner to
  confirm: whether the GM, the Sales Director, Managers (for their regions) or
  Viewers should see it too is an open question. Archived and merged customers
  are shown, with a banner.
- **Opening it is not audited.** No page view is recorded anywhere in the app
  (only photo views, `PHOTO_VIEW`, and printouts, `PRINT`); the page shows no
  photo, so it writes nothing.
- **Not listed (first version):** extra shop photos (they carry no customer id),
  and request events that change nothing (sent back, rejected) — those stay in
  the customer page's Recent activity and on `/audit`.
- **Limits:** at most 5,000 rows per history table are read; past that the page
  says "Only the latest 5,000 changes are listed; older ones are in the audit
  log", and the creation entry still comes from the first row.
- Code: `app/(app)/customers/[id]/history/`, `lib/customer-history.ts` (pure
  assembly), `lib/customer-history-load.ts` (the reads). Tests:
  `tests/unit/customer-history.test.ts`, `tests/unit/customer-history-page.test.tsx`,
  `tests/e2e/launch/customer-history.spec.ts`.

## 12. Proving it untouched: the daily seal, the nightly checks, the purge summaries and the test flag (watch and prove)

Data audit gaps 25, 28, 29 and 30; migrations `20261024120000_test_records` to
`20261024120400_integrity_results`; `docs/OPERATIONS.md` §5k.

**The seal (gap 28).** Each night (`/api/cron/integrity-watch`, `lib/seal/*`) one
REPEATABLE READ transaction seals every append-only ledger: `AuditLog`,
`EditApproval` and `ExportJob` by their `seq` key (their ids are cuids; `seq` was
added by the seal migration, numbering existing rows in physical order), the seven
`*History` tables, `EditRevision`, `AuthEvent`, `JobRunDay`, `PurgeSummary` and
`IntegrityCheckResult` by their id. Per table the seal records the key range, the row
count and a digest (the SHA-256 of every row's SHA-256, each row being Postgres's
`json_build_array` of an explicit, versioned column list), the highest key it could
see, and its snapshot's xmax; its body is canonical JSON, its hash the SHA-256 of it,
chained to the previous seal (`SealRecord`, append-only; `nmwc_seal_link_guard`
refuses a seal that does not link). Seal k covers what seal k-1 could see, and is
written only once every transaction open at seal k-1 has ended, so a row with a low
key committed late cannot land unseen in a sealed range. The genesis covers nothing;
the next night's seal covers every row that existed then — the past before the
genesis is not proven. A copy of each body goes to R2 under `seals/`, at a key fixed by
the chain (its genesis hash) and the seq: `seals/v1/<chain>/<seq>.json`.
`scripts/ops/verify-seals.ts` recomputes it all, lists `seals/`, and names the first
mismatch: body edited, chain link broken, rows deleted, rows added into a sealed range,
rows changed, rows deleted or changed before they were sealed, off-site copy missing or
different, an off-site object that is no seal of the chain, a seal naming another key.

**The exposure window.** Because of the lag rule, a row is hashed for good only by the
seal of the night after next — 24 to 48 hours after it is written. In between it is
watched: every seal after the genesis also records the count and digest of the rows
waiting for the next seal as it sees them (`pn`, `pdigest`), and the next seal must
have at least those rows, and exactly those when it has as many (a late commit only
adds rows). What is NOT covered is a row's first hours, from its write to the first
seal after it (at most a day): an edit or a deletion in that time — the newest row
included — leaves no trace in the chain.

**How often each part is rechecked.** Every night: every seal's body and link, the
whole-chain counts (a deletion anywhere), the provisional counts, the last seven seals'
ranges and copies, and a listing of `seals/`; and a rotating slice of the older seals'
ranges, so that each is recomputed at least once in 28 nights while the run's budget
holds. An edit to an old row (same count) is therefore found within that cycle, or at
once by `verify-seals --all`.

**The checks (gap 29).** The same job runs twenty-two named read-only checks
(`lib/integrity/checks.ts`), among them: every live record has an open history
interval, and its latest history row's values are the record's (the columns each
capture trigger records) — which catches a write made with a trigger off or in
replica mode; no change recorded under `sql` since the last run; every protecting
trigger present, enabled for normal sessions and bound to its table and function; every
protecting function's body, rights and search path as its last migration made them;
and (gap 31, information) how many older rows break each database rule added NOT
VALID (OPERATIONS §5l). Results go to `IntegrityCheckResult`, append-only and sealed.

**Temix codes and CR numbers (owner decisions 2026-10-25).** Temix codes are unique,
and the database enforces it: the partial unique index `Customer_temixCode_live_unique`
(migration `20261025120000_temix_code_unique`) refuses a second live customer with a
code, compared upper case with the ends trimmed. `temix-code-shared` still runs, on
the same key, and says so: it should find none, and a finding means the index is
missing or not valid (OPERATIONS §5l). CR numbers are not unique, but every shared one
is flagged: `cr-number-shared` (information, never alerting) counts the live real
customers sharing a normalised CR (`crNumberNorm`, the key the duplicates detector's
CR rule pairs by), with how many CR numbers and pairs, samples shown as NMWC codes
(never the CR number), and a link to /duplicates. The dated history keeps each
customer's Temix code (`CustomerHistory.temixCode`), so who held a code on day D is
answered by `nmwc_customers_on(D)`; the CR number is not a captured column, so who
shared a CR on day D is not.

**Which checks alert (owner decisions 2026-10-24 and 2026-10-25).** Every check fails,
and alerts, on any non-zero count, except five that are information and never alert:
`test-scaffolding-mixed`, `app-login-is-runtime-role`, `exports-since-last-run`,
`sign-in-failures-since-last-run` and, since 2026-10-25, `cr-number-shared`.
`scheduled-jobs-on-time` counts only the jobs in
`ALERTING_JOBS` (`lib/integrity/policy.ts`): the SLA escalation sweep, the nightly dump
and the integrity watch itself. A missed run of any other job — keep-warm, the e-mail
drain, photo-gc, the retention sweep, and a job added later until it is listed — is
listed as information, never counted. The seal findings alert once per event, then
show as information (`docs/OPERATIONS.md` §5k).

**The purge summaries (gap 25).** Every retention rule writes one `PurgeSummary` row
per batch in the same statement as the deletion (`lib/purge-summary.ts`), so what a
clean-up removed — how many, which dates, counts by category — is answerable after it.

**The test flag (gap 30).** `isTest` on Customer, User, Route and Region is not a
watched column (no history row; the nightly `test-flags-changed` check reports any
change) and moves only in the owner's maintenance window. **The as-of functions above
do not filter it**: they answer for every record, test ones included.

**What none of this proves.** The owner login can still rewrite ledger rows and the
seal table in the maintenance window, and the app's R2 token can overwrite the copies,
until `seals/` is locked write-once (owner; with the lock, a rewritten seal's copy is
refused at its fixed key and the original is read back as different); the maintenance
window still leaves no trace of its own, so a mismatch says that a sealed row changed,
not who changed it; and a row changed or deleted before the first seal after its
write leaves no trace at all.

