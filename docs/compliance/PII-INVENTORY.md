# Personal-data inventory (technical annex)

<!-- GENERATED FILE — do not edit by hand.
     Source: prisma/schema.prisma + lib/compliance/pii-classification.ts
     Regenerate: npx tsx scripts/compliance/build-pii-inventory.ts
     CI fails if this file is stale or if any column is unclassified. -->

Every column the database stores, classified by whose personal data it is. This file is generated: the classification lives beside the code in `lib/compliance/pii-classification.ts`, and `tests/unit/pii-classification.test.ts` fails if a column is added without a decision. It is the factual annex to `docs/compliance/DATA-RESIDENCY-REGISTER.md`.

**537 stored columns across 37 tables** — Customer contact: 29 · Employee: 96 · Customer entity (personal if a sole establishment): 50 · Not personal data: 362.

## Columns holding personal data

### Route

| Column | Subject | Kind | Note |
|---|---|---|---|
| `code` | Employee | identifier | doubles as the salesman’s login username, so it names a person as well as a round |

### User

| Column | Subject | Kind | Note |
|---|---|---|---|
| `id` | Employee | identifier |  |
| `username` | Employee | identifier | route code for salesmen, given name for managers |
| `passwordHash` | Employee | credential | bcrypt |
| `fullName` | Employee | name |  |
| `role` | Employee | behaviour | job function |
| `isActive` | Employee | — | employment status in this system |
| `email` | Employee | contact |  |
| `phone` | Employee | contact |  |
| `createdAt` | Employee | — | account creation — start of the employment record here |
| `updatedAt` | Employee | — | record timestamp, not an attribute of a person |
| `lastLoginAt` | Employee | behaviour | when this person last worked in the system |
| `sessionsRevokedAt` | Employee | behaviour |  |
| `mustChangePassword` | Employee | credential |  |
| `supervisorId` | Employee | — | reporting line |
| `ownedRouteId` | Employee | — | the round this person works |

### PasswordHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `userId` | Employee | identifier |  |
| `hash` | Employee | credential | previous bcrypt hashes, last 5 kept |
| `createdAt` | Employee | behaviour | when this person changed their password |

### SavedView

| Column | Subject | Kind | Note |
|---|---|---|---|
| `userId` | Employee | identifier |  |
| `name` | Employee | free text | user-authored label |
| `urlParams` | Customer contact | free text | a saved search can embed the phone number or name that was searched for |

### Customer

| Column | Subject | Kind | Note |
|---|---|---|---|
| `id` | Customer entity (personal if a sole establishment) | identifier |  |
| `nmwcCode` | Customer entity (personal if a sole establishment) | identifier | the company’s own customer code |
| `legalName` | Customer entity (personal if a sole establishment) | name | a sole establishment is usually registered in the owner’s name |
| `paymentTerms` | Customer entity (personal if a sole establishment) | financial |  |
| `crNumber` | Customer entity (personal if a sole establishment) | identifier | commercial registration; identifies the owner of a sole establishment |
| `crNumberNorm` | Customer entity (personal if a sole establishment) | identifier | normalised copy for de-duplication |
| `primaryPhone` | Customer contact | contact | in practice the owner’s or manager’s mobile |
| `primaryPhoneNorm` | Customer contact | contact | normalised copy used for matching |
| `altPhone` | Customer contact | contact |  |
| `contactPerson` | Customer contact | name |  |
| `contactRole` | Customer contact | — | that person’s role at the shop |
| `email` | Customer contact | contact | credit customers only (owner decisions 2026-10-11); often the owner’s own address |
| `status` | Customer entity (personal if a sole establishment) | — |  |
| `notes` | Customer contact | free text | unbounded; whatever a salesman or approver typed |
| `creditLimit` | Customer entity (personal if a sole establishment) | financial |  |
| `paymentTermDays` | Customer entity (personal if a sole establishment) | financial |  |
| `temixCode` | Customer entity (personal if a sole establishment) | identifier | the identifier this customer has in the Temix ERP |
| `createdById` | Employee | behaviour | which member of staff created this record |
| `lastEditedById` | Employee | behaviour |  |

### Branch

| Column | Subject | Kind | Note |
|---|---|---|---|
| `id` | Customer entity (personal if a sole establishment) | identifier |  |
| `branchCode` | Customer entity (personal if a sole establishment) | identifier |  |
| `branchName` | Customer entity (personal if a sole establishment) | name |  |
| `address` | Customer entity (personal if a sole establishment) | location | premises address; a home-delivery customer’s address is their home |
| `areaDescription` | Customer entity (personal if a sole establishment) | location |  |
| `gpsLat` | Customer entity (personal if a sole establishment) | location | six-decimal precision — a doorway, not a district |
| `gpsLng` | Customer entity (personal if a sole establishment) | location |  |
| `gpsCapturedAt` | Employee | behaviour | when a named salesman stood at this location |
| `dayOfVisit` | Customer entity (personal if a sole establishment) | — |  |
| `openingHours` | Customer entity (personal if a sole establishment) | — |  |
| `deliveryWindow` | Customer entity (personal if a sole establishment) | — |  |
| `status` | Customer entity (personal if a sole establishment) | — |  |
| `createdById` | Employee | behaviour |  |
| `lastEditedById` | Employee | behaviour |  |

### CustomerEdit

| Column | Subject | Kind | Note |
|---|---|---|---|
| `submittedById` | Employee | behaviour | who proposed the change |
| `submittedAt` | Employee | behaviour |  |
| `reviewedById` | Employee | behaviour |  |
| `reviewedAt` | Employee | behaviour |  |
| `decisionReason` | Customer contact | free text | approver’s words; may describe the customer or the submitting employee |
| `fieldChanges` | Customer contact | snapshot | before/after values of the customer and branch fields above, and for a field kept over a value changed after the form opened, that newer value (overrodeLive, F06) — a second copy of the same personal data; plus, for a GPS point typed in by hand, the salesman’s own free-text reason (item 41), which the UPDATE APPROVE audit row also copies |
| `paymentTermsAtSubmit` | Customer entity (personal if a sole establishment) | financial |  |
| `approvalChain` | Employee | snapshot | the roles and step order frozen at submit time |
| `requestedCreditLimit` | Customer entity (personal if a sole establishment) | financial |  |
| `requestedPaymentTermDays` | Customer entity (personal if a sole establishment) | financial |  |
| `stageEnteredAt` | Employee | behaviour | feeds the SLA clock on a named approver |
| `slaDueAt` | Employee | behaviour |  |
| `slaBreachedAt` | Employee | behaviour | records that a named person missed a deadline |
| `escalationLevel` | Employee | behaviour |  |
| `lastEscalatedAt` | Employee | behaviour |  |

### Attachment

| Column | Subject | Kind | Note |
|---|---|---|---|
| `r2Key` | Employee | image reference | the key embeds date/userId/kind, so the bucket listing alone is an employee activity log; the image it points at may show a CR document, a shopfront, passers-by and vehicle plates |
| `capturedById` | Employee | identifier |  |
| `capturedAt` | Employee | behaviour |  |
| `capturedLat` | Employee | location | where the member of staff was standing — device GPS, not the premises record |
| `capturedLng` | Employee | location |  |

### ImportBatch

| Column | Subject | Kind | Note |
|---|---|---|---|
| `uploadedById` | Employee | behaviour |  |
| `uploadedAt` | Employee | behaviour |  |
| `promoteLeaseBy` | Employee | identifier | which Steward holds the promote lease |

### ImportRow

| Column | Subject | Kind | Note |
|---|---|---|---|
| `raw` | Customer contact | snapshot | the source spreadsheet row verbatim, including columns the app never maps — a third copy of the customer master |
| `parsed` | Customer contact | snapshot |  |
| `issues` | Customer contact | free text | validation messages quote the offending value |
| `reviewedById` | Employee | behaviour |  |
| `reviewedAt` | Employee | behaviour |  |
| `corrections` | Customer contact | snapshot | cells the Steward corrected in the app (item 20); cleared with raw by the retention sweep |
| `excludedAt` | Employee | behaviour |  |
| `excludedById` | Employee | behaviour |  |
| `excludedReason` | Employee | free text | why the Steward accepted the row as excluded; may name the customer |

### IntegrityCheckResult

| Column | Subject | Kind | Note |
|---|---|---|---|
| `sampleIds` | Employee | identifier | at most ten ids: may hold user ids, and customer, shop, route or history row ids, trigger names, job keys or code scopes — never a value |

### RateLimit

| Column | Subject | Kind | Note |
|---|---|---|---|
| `key` | Employee | identifier | login buckets are keyed `login:user:<username>` and `login:ip:<address>` — an attempted username and a source IP address |

### ExportJob

| Column | Subject | Kind | Note |
|---|---|---|---|
| `requestedById` | Employee | behaviour |  |
| `filters` | Customer contact | free text | the filters and role scope of the export; the filtered list carries the search term typed, which can be a name or a phone |

### AuditLog

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who did it |
| `action` | Employee | behaviour | includes PHOTO_VIEW: which member of staff opened which photo or document (data audit gap 2), read by the Data Steward only; and PRINT: which member of staff printed which customer form or credit application (owner decisions 2026-10-11), read by the Data Steward and, for their regions, Managers |
| `before` | Customer contact | snapshot | full field snapshot — legal name, CR number, phones, contact person, notes, address, GPS. Cannot be edited or deleted except in an owner-session maintenance transaction (migrations 20260914150000 + 20260914160000) |
| `after` | Customer contact | snapshot | as above; an UPDATE approval also copies CustomerEdit.fieldChanges here, including a salesman’s free-text manual-GPS reason (item 41). A duplicate dismissal stores truncated, unkeyed sha256 digests of the shared CR and of name + phone (item 16) — for a short CR the value can be recovered by brute force |
| `reason` | Customer contact | free text |  |
| `ip` | Employee | device | source IP of the member of staff |
| `userAgent` | Employee | device | browser and device string |
| `at` | Employee | behaviour | when that person acted |

### AuthEvent

| Column | Subject | Kind | Note |
|---|---|---|---|
| `at` | Employee | behaviour | when the attempt or the cut-off happened |
| `userId` | Employee | identifier | the account concerned, when there is one (no foreign key: the event outlives the account) |
| `usernameHmac` | Employee | identifier | keyed fingerprint of the typed sign-in name — pseudonymous: matching it to a name needs AUTH_SECRET; the name itself is never stored |
| `ip` | Employee | device | source IP of the attempt, as AuditLog.ip |
| `userAgent` | Employee | device | browser and device string, as AuditLog.userAgent |
| `actorId` | Employee | identifier | who cut the sessions off (the change context); null for a sign-in failure |

### CustomerHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |
| `customerId` | Customer entity (personal if a sole establishment) | identifier |  |
| `nmwcCode` | Customer entity (personal if a sole establishment) | identifier | the customer code as it was |
| `paymentTerms` | Customer entity (personal if a sole establishment) | financial |  |
| `creditLimit` | Customer entity (personal if a sole establishment) | financial |  |
| `paymentTermDays` | Customer entity (personal if a sole establishment) | financial |  |
| `temixCode` | Customer entity (personal if a sole establishment) | identifier |  |
| `status` | Customer entity (personal if a sole establishment) | — |  |

### BranchHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |
| `branchId` | Customer entity (personal if a sole establishment) | identifier |  |
| `branchCode` | Customer entity (personal if a sole establishment) | identifier |  |
| `dayOfVisit` | Customer entity (personal if a sole establishment) | — |  |
| `status` | Customer entity (personal if a sole establishment) | — |  |

### UserHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |
| `userId` | Employee | identifier |  |
| `username` | Employee | identifier | as it was: a salesman’s is his route code, retired on hand-over |
| `role` | Employee | behaviour | job function then |
| `isActive` | Employee | — | employment status in this system then |
| `supervisorId` | Employee | — | reporting line then |
| `ownedRouteId` | Employee | — | the round this person worked then |
| `regionIds` | Employee | — | the regions this person administered then |

### RouteOwnerHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |
| `ownerId` | Employee | identifier | who held the round then (null: nobody) |

### RouteHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |
| `code` | Employee | identifier | as Route.code: doubles as the salesman’s login username |

### RegionHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |

### AttachmentHistory

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who caused the change (null for a job or an unnamed script) |
| `capturedById` | Employee | identifier | who took the photo |
| `capturedAt` | Employee | behaviour | when this person took it |

### EditRevision

| Column | Subject | Kind | Note |
|---|---|---|---|
| `submittedAt` | Employee | behaviour |  |
| `submittedById` | Employee | behaviour | who sent this round |
| `paymentTerms` | Customer entity (personal if a sole establishment) | financial |  |
| `requestedCreditLimit` | Customer entity (personal if a sole establishment) | financial |  |
| `requestedPaymentTermDays` | Customer entity (personal if a sole establishment) | financial |  |
| `approvalChain` | Employee | snapshot | the roles and step order frozen with this round |
| `payload` | Customer contact | snapshot | the round as sent: channel, terms, per shop its route, region, visit day, counts and photo ids, documents by kind; the name, CR number, phones, contact, e-mail, notes, shop name, address, hours and GPS point only as unkeyed SHA-256 fingerprints (lib/fingerprint.ts) — for a short CR number or a phone the value can be recovered by brute force |

### EditCustomerDraft

| Column | Subject | Kind | Note |
|---|---|---|---|
| `legalName` | Customer entity (personal if a sole establishment) | name |  |
| `paymentTerms` | Customer entity (personal if a sole establishment) | financial |  |
| `crNumber` | Customer entity (personal if a sole establishment) | identifier |  |
| `crNumberNorm` | Customer entity (personal if a sole establishment) | identifier |  |
| `primaryPhone` | Customer contact | contact |  |
| `primaryPhoneNorm` | Customer contact | contact |  |
| `altPhone` | Customer contact | contact |  |
| `contactPerson` | Customer contact | name |  |
| `contactRole` | Customer contact | — |  |
| `email` | Customer contact | contact | credit requests only; copied to Customer.email at finalize |
| `notes` | Customer contact | free text |  |

### EditBranchDraft

| Column | Subject | Kind | Note |
|---|---|---|---|
| `branchName` | Customer entity (personal if a sole establishment) | name |  |
| `address` | Customer entity (personal if a sole establishment) | location |  |
| `areaDescription` | Customer entity (personal if a sole establishment) | location |  |
| `gpsLat` | Customer entity (personal if a sole establishment) | location |  |
| `gpsLng` | Customer entity (personal if a sole establishment) | location |  |
| `gpsCapturedAt` | Employee | behaviour |  |
| `dayOfVisit` | Customer entity (personal if a sole establishment) | — |  |
| `openingHours` | Customer entity (personal if a sole establishment) | — |  |
| `deliveryWindow` | Customer entity (personal if a sole establishment) | — |  |

### EditApproval

| Column | Subject | Kind | Note |
|---|---|---|---|
| `role` | Employee | behaviour |  |
| `decision` | Employee | behaviour | what this named person decided: APPROVED, REJECTED, or FORM_UPLOADED (the salesman uploaded the signed credit application, owner decisions 2026-10-11) |
| `actorId` | Employee | identifier |  |
| `reason` | Customer contact | free text |  |
| `at` | Employee | behaviour |  |
| `stageEnteredAt` | Employee | behaviour |  |
| `slaDueAt` | Employee | behaviour |  |
| `workingMinutes` | Employee | behaviour | how long this named person took to decide |
| `actorRole` | Employee | behaviour | the decider’s own role when he decided |

### Notification

| Column | Subject | Kind | Note |
|---|---|---|---|
| `userId` | Employee | identifier |  |
| `title` | Customer contact | free text | carries the customer’s legal name and code by design |
| `body` | Customer contact | free text |  |
| `readAt` | Employee | behaviour | whether and when this person read it |

### TemixSyncBatch

| Column | Subject | Kind | Note |
|---|---|---|---|
| `createdById` | Employee | behaviour |  |

## Tables with no personal data

`Region`, `Channel`, `SubChannel`, `CronHeartbeat`, `CronRun`, `JobRunDay`, `SealRecord`, `PurgeSummary`, `CodeSequence`

## Columns classified as not personal data

<details><summary>Expand — every remaining column, so the classification is auditable</summary>

| Table | Column | Type | Why not personal data |
|---|---|---|---|
| Region | `id` | String | foreign key / structural value |
| Region | `name` | String | geographic area of operations |
| Region | `code` | String | structural / operational value |
| Region | `isActive` | Boolean | structural / operational value |
| Region | `isTest` | Boolean | a test or synthetic record left in production (gap 30); set by the owner only |
| Region | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Region | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| Route | `id` | String | foreign key / structural value |
| Route | `name` | String | structural / operational value |
| Route | `regionId` | String | foreign key / structural value |
| Route | `isActive` | Boolean | structural / operational value |
| Route | `isTest` | Boolean | a test or synthetic record left in production (gap 30); set by the owner only |
| Route | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Route | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| User | `isTest` | Boolean | a test or synthetic record left in production (gap 30); set by the owner only |
| PasswordHistory | `id` | String | foreign key / structural value |
| SavedView | `id` | String | foreign key / structural value |
| SavedView | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Channel | `id` | String | foreign key / structural value |
| Channel | `key` | String | structural / operational value |
| Channel | `label` | String | structural / operational value |
| Channel | `displayOrder` | Int | structural / operational value |
| Channel | `isActive` | Boolean | structural / operational value |
| Channel | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| SubChannel | `id` | String | foreign key / structural value |
| SubChannel | `key` | String | structural / operational value |
| SubChannel | `label` | String | structural / operational value |
| SubChannel | `channelId` | String | foreign key / structural value |
| SubChannel | `isActive` | Boolean | structural / operational value |
| SubChannel | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Customer | `channelId` | String | foreign key / structural value |
| Customer | `subChannelId` | String | foreign key / structural value |
| Customer | `completenessScore` | Int | derived |
| Customer | `version` | Int | optimistic-concurrency counter |
| Customer | `importBatchId` | String | foreign key / structural value |
| Customer | `importRowId` | String | foreign key / structural value |
| Customer | `crPhotoId` | String | reference to the CR document image in R2 |
| Customer | `temixSyncState` | TemixSyncState | structural / operational value |
| Customer | `temixSyncPendingSince` | DateTime | record timestamp, not an attribute of a person |
| Customer | `lastTemixUploadAt` | DateTime | record timestamp, not an attribute of a person |
| Customer | `lastTemixUploadBatchId` | String | foreign key / structural value |
| Customer | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Customer | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| Customer | `deletedAt` | DateTime | soft-delete marker |
| Customer | `mergedIntoId` | String | the customer a duplicate merge folded this one into (lossless paths, gap 8); structural |
| Customer | `isTest` | Boolean | a test or synthetic record left in production (gap 30); set by the owner only |
| Branch | `customerId` | String | foreign key / structural value |
| Branch | `regionId` | String | foreign key / structural value |
| Branch | `routeId` | String | foreign key / structural value |
| Branch | `gpsAccuracy` | Float | metres reported by the device |
| Branch | `coolersCount` | Int | structural / operational value |
| Branch | `standsCount` | Int | structural / operational value |
| Branch | `emptyBottlesCount` | Int | structural / operational value |
| Branch | `equipmentConfirmed` | Boolean | the counts were confirmed at the shop (F21) |
| Branch | `shopPhotoId` | String | reference; the image itself is in R2 |
| Branch | `signboardPhotoId` | String | structural / operational value |
| Branch | `completenessScore` | Int | derived |
| Branch | `lastStatusChangeAt` | DateTime | record timestamp, not an attribute of a person |
| Branch | `version` | Int | optimistic-concurrency counter |
| Branch | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Branch | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| Branch | `deletedAt` | DateTime | soft-delete marker |
| CustomerEdit | `id` | String | foreign key / structural value |
| CustomerEdit | `target` | EditTarget | structural / operational value |
| CustomerEdit | `customerId` | String | foreign key / structural value |
| CustomerEdit | `branchId` | String | foreign key / structural value |
| CustomerEdit | `state` | EditState | structural / operational value |
| CustomerEdit | `decisionCategory` | String | structural / operational value |
| CustomerEdit | `attachmentChanges` | Json | structural / operational value |
| CustomerEdit | `isReactivation` | Boolean | structural / operational value |
| CustomerEdit | `isWrongRoute` | Boolean | structural / operational value |
| CustomerEdit | `newRouteId` | String | foreign key / structural value |
| CustomerEdit | `submissionId` | String | a random id the phone mints for each submit, so a retry is never written twice (item 22); identifies the request, not a person or a device |
| CustomerEdit | `submitGate` | Json | the ids of the branches a salesman submit was checked against (F05); structural |
| CustomerEdit | `routeIdAtSubmit` | String | the route the request was raised from when it was sent (gap 18); structural |
| CustomerEdit | `regionIdsAtSubmit` | String[] | the regions of the request’s scope when it was sent (gap 18); structural |
| CustomerEdit | `originalCustomerId` | String | the customer the request was first about, set once by the database (lossless paths, gap 8); structural |
| CustomerEdit | `process` | EditProcess | structural / operational value |
| CustomerEdit | `currentStepIndex` | Int | structural / operational value |
| CustomerEdit | `pendingRole` | Role | structural / operational value |
| CustomerEdit | `cycle` | Int | structural / operational value |
| CustomerEdit | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| CustomerEdit | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| Attachment | `id` | String | foreign key / structural value |
| Attachment | `kind` | AttachmentKind | SHOP / SIGNBOARD / CR / GUARANTEE / EXTRA, and the credit documents (owner decisions 2026-10-11): ID_CARD (the owner’s ID card), MEMBERSHIP_CERT, VAT_CERT, TAX_CARD and CREDIT_FORM (the signed credit application). The kind is not personal; the image behind an ID card is the owner’s identity document |
| Attachment | `customerId` | String | foreign key / structural value |
| Attachment | `branchId` | String | foreign key / structural value |
| Attachment | `branchExtraId` | String | foreign key / structural value |
| Attachment | `editId` | String | foreign key / structural value |
| Attachment | `mimeType` | String | structural / operational value |
| Attachment | `bytes` | Int | structural / operational value |
| Attachment | `width` | Int | structural / operational value |
| Attachment | `height` | Int | structural / operational value |
| Attachment | `hash` | String | content hash for duplicate detection |
| Attachment | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Attachment | `deletedAt` | DateTime | soft-delete marker; starts the 30-day GC clock |
| ImportBatch | `id` | String | foreign key / structural value |
| ImportBatch | `filename` | String | operator-supplied file name |
| ImportBatch | `kind` | String | structural / operational value |
| ImportBatch | `status` | ImportBatchStatus | structural / operational value |
| ImportBatch | `totalRows` | Int | structural / operational value |
| ImportBatch | `cleanRows` | Int | structural / operational value |
| ImportBatch | `quarantinedRows` | Int | structural / operational value |
| ImportBatch | `promotedRows` | Int | structural / operational value |
| ImportBatch | `rejectedRows` | Int | structural / operational value |
| ImportBatch | `promoteLeaseUntil` | DateTime | record timestamp, not an attribute of a person |
| ImportBatch | `fileSha256` | String | SHA-256 of the uploaded workbook as a whole (gap 7): identifies the file, not its contents — no value can be read back from it |
| ImportBatch | `fileBytes` | Int | size of the uploaded workbook |
| ImportRow | `id` | String | foreign key / structural value |
| ImportRow | `batchId` | String | foreign key / structural value |
| ImportRow | `rowNumber` | Int | structural / operational value |
| ImportRow | `state` | ImportRowState | CLEAN / QUARANTINED / PROMOTED / REJECTED |
| ImportRow | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| CronHeartbeat | `key` | String | structural / operational value |
| CronHeartbeat | `lastRunAt` | DateTime | record timestamp, not an attribute of a person |
| CronHeartbeat | `lastOk` | Boolean | structural / operational value |
| CronHeartbeat | `lastDurationMs` | Int | structural / operational value |
| CronHeartbeat | `lastError` | String | scrubbed through lib/scrub.ts before it is stored |
| CronHeartbeat | `lastDetail` | Json | job counters returned by the route |
| CronHeartbeat | `runs` | Int | structural / operational value |
| CronHeartbeat | `failures` | Int | structural / operational value |
| CronHeartbeat | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| CronHeartbeat | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| CronRun | `id` | String | foreign key / structural value |
| CronRun | `key` | String | structural / operational value |
| CronRun | `at` | DateTime | record timestamp, not an attribute of a person |
| CronRun | `ok` | Boolean | structural / operational value |
| CronRun | `durationMs` | Int | structural / operational value |
| CronRun | `dbMs` | Int | structural / operational value |
| CronRun | `source` | String | a fixed label ('vercel', 'cron-job.org', 'github', 'other'), not the User-Agent |
| JobRunDay | `id` | BigInt | foreign key / structural value |
| JobRunDay | `key` | String | which scheduled job |
| JobRunDay | `day` | DateTime | the Oman calendar day the runs started on |
| JobRunDay | `runs` | Int | structural / operational value |
| JobRunDay | `failures` | Int | structural / operational value |
| JobRunDay | `firstAt` | DateTime | record timestamp, not an attribute of a person |
| JobRunDay | `lastAt` | DateTime | record timestamp, not an attribute of a person |
| JobRunDay | `maxDurationMs` | Int | structural / operational value |
| JobRunDay | `sources` | String[] | the CronRun scheduler labels seen that day, never a User-Agent |
| JobRunDay | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| IntegrityCheckResult | `id` | BigInt | the strict order of the results |
| IntegrityCheckResult | `runAt` | DateTime | when the run started (groups a run) |
| IntegrityCheckResult | `day` | DateTime | the Oman day of the run |
| IntegrityCheckResult | `checkId` | String | lib/integrity/checks.ts check id |
| IntegrityCheckResult | `version` | Int | structural / operational value |
| IntegrityCheckResult | `status` | String | pass, fail, info or error |
| IntegrityCheckResult | `count` | Int | how many records broke the rule |
| IntegrityCheckResult | `detail` | Json | counts by sub-kind and ids as above — never a name, phone, CR number or code |
| IntegrityCheckResult | `durationMs` | Int | structural / operational value |
| IntegrityCheckResult | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| IntegrityCheckResult | `source` | String | the change-context source (the nightly job) |
| IntegrityCheckResult | `txId` | BigInt | database transaction id |
| SealRecord | `id` | BigInt | foreign key / structural value |
| SealRecord | `seq` | Int | the seal number, 0 = genesis |
| SealRecord | `day` | DateTime | the Oman day of the run |
| SealRecord | `formatVersion` | Int | structural / operational value |
| SealRecord | `prevHash` | String | SHA-256 of the previous seal |
| SealRecord | `hash` | String | SHA-256 of bodyText |
| SealRecord | `bodyText` | String | per sealed table: key range, row count and a SHA-256 digest, and the count and digest of the rows waiting for the next seal — never a row |
| SealRecord | `r2Key` | String | where the off-site copy is: seals/v1/<the chain>/<seq>.json |
| SealRecord | `snapshotXmax` | BigInt | a database transaction id |
| SealRecord | `sealedAt` | DateTime | record timestamp, not an attribute of a person |
| SealRecord | `source` | String | the change-context source (the nightly job) |
| SealRecord | `txId` | BigInt | database transaction id |
| PurgeSummary | `id` | BigInt | the strict order of the summaries |
| PurgeSummary | `at` | DateTime | record timestamp, not an attribute of a person |
| PurgeSummary | `job` | String | which job ran the rule |
| PurgeSummary | `rule` | String | lib/retention-rules.ts rule id |
| PurgeSummary | `tableName` | String | structural / operational value |
| PurgeSummary | `action` | String | DELETE or CLEAR_PAYLOAD |
| PurgeSummary | `rows` | Int | how many rows the batch removed |
| PurgeSummary | `dateColumn` | String | structural / operational value |
| PurgeSummary | `oldestAt` | DateTime | the oldest value of the rule date column in the batch |
| PurgeSummary | `newestAt` | DateTime | the newest value of the rule date column in the batch |
| PurgeSummary | `cutoff` | DateTime | structural / operational value |
| PurgeSummary | `retentionDays` | Int | structural / operational value |
| PurgeSummary | `detail` | Json | counts by category only (bucket kind, month, notification kind and e-mail outcome, import batch id and row state, job key, photo kind) — never a key, a name or text |
| PurgeSummary | `runId` | String | job name and run start |
| PurgeSummary | `source` | String | the change-context source (a job name) |
| PurgeSummary | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| RateLimit | `tokens` | Float | structural / operational value |
| RateLimit | `lastRefill` | DateTime | record timestamp, not an attribute of a person |
| RateLimit | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| ExportJob | `id` | String | foreign key / structural value |
| ExportJob | `status` | ExportJobStatus | structural / operational value |
| ExportJob | `r2Key` | String | structural / operational value |
| ExportJob | `rowCount` | Int | structural / operational value |
| ExportJob | `startedAt` | DateTime | record timestamp, not an attribute of a person |
| ExportJob | `completedAt` | DateTime | record timestamp, not an attribute of a person |
| ExportJob | `errorMessage` | String | structural / operational value |
| ExportJob | `kind` | String | which export: customer-master, customers-filtered, field-updates or temix-batch (the Temix upload file, on Generate and on each re-download) |
| ExportJob | `fileSha256` | String | SHA-256 of the exact bytes sent: identifies the file, not its contents |
| ExportJob | `filename` | String | the file name the export was sent under (a date, never a customer) |
| ExportJob | `customerIds` | String[] | identifiers of the customers the file held; the file itself is never stored |
| ExportJob | `seq` | BigInt | strict order: the key the nightly seal ranges are read by (gap 28) |
| AuditLog | `id` | String | foreign key / structural value |
| AuditLog | `entityType` | String | structural / operational value |
| AuditLog | `entityId` | String | foreign key / structural value |
| AuditLog | `source` | String | what caused the row: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| AuditLog | `txId` | BigInt | database transaction id: joins the row to the dated history rows of the same change |
| AuditLog | `seq` | BigInt | strict order: the key the nightly seal ranges are read by (gap 28) |
| AuthEvent | `id` | BigInt | the strict order of the events |
| AuthEvent | `kind` | String | LOGIN_FAIL_UNKNOWN, LOGIN_RATE_LIMITED, LOGIN_FAIL_REUSED_NAME or SESSION_REVOKE |
| AuthEvent | `keyId` | String | which fingerprint key (first 8 hex of its SHA-256): a rotated AUTH_SECRET gives another |
| AuthEvent | `reason` | String | a fixed category (not_found, retired_username, ip, user, deactivated, password, role, …), never free text |
| AuthEvent | `source` | String | what caused it (lib/change-context.ts): auth:logout, users:toggle:<id>, import:<batch>:Users!<row>, … |
| AuthEvent | `txId` | BigInt | database transaction id: joins the AuditLog rows of the same change |
| AuthEvent | `dbUser` | String | the database login that wrote a session cut-off (nmwc_app or the owner role) |
| CustomerHistory | `id` | BigInt | the strict order of the history |
| CustomerHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| CustomerHistory | `changedFields` | String[] | field NAMES only — never a value |
| CustomerHistory | `validFrom` | DateTime | when the change took effect |
| CustomerHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| CustomerHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| CustomerHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| CustomerHistory | `sourceKind` | String | structural / operational value |
| CustomerHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| CustomerHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| CustomerHistory | `channelId` | String | foreign key / structural value |
| CustomerHistory | `subChannelId` | String | foreign key / structural value |
| CustomerHistory | `crPhotoId` | String | which CR document was on file |
| CustomerHistory | `deletedAt` | DateTime | soft-delete marker as it was |
| CustomerHistory | `mergedIntoId` | String | the customer it had been merged into then; structural |
| BranchHistory | `id` | BigInt | the strict order of the history |
| BranchHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| BranchHistory | `changedFields` | String[] | field NAMES only — never a value |
| BranchHistory | `validFrom` | DateTime | when the change took effect |
| BranchHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| BranchHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| BranchHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| BranchHistory | `sourceKind` | String | structural / operational value |
| BranchHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| BranchHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| BranchHistory | `customerId` | String | foreign key / structural value |
| BranchHistory | `routeId` | String | the route that served the shop then |
| BranchHistory | `regionId` | String | foreign key / structural value |
| BranchHistory | `deletedAt` | DateTime | soft-delete marker as it was |
| BranchHistory | `coolersCount` | Int | structural / operational value |
| BranchHistory | `standsCount` | Int | structural / operational value |
| BranchHistory | `emptyBottlesCount` | Int | structural / operational value |
| BranchHistory | `equipmentConfirmed` | Boolean | structural / operational value |
| BranchHistory | `hasGps` | Boolean | whether a GPS point was on file; the point itself is never copied |
| BranchHistory | `shopPhotoId` | String | structural / operational value |
| BranchHistory | `signboardPhotoId` | String | structural / operational value |
| UserHistory | `id` | BigInt | the strict order of the history |
| UserHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| UserHistory | `changedFields` | String[] | field NAMES only — never a value |
| UserHistory | `validFrom` | DateTime | when the change took effect |
| UserHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| UserHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| UserHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| UserHistory | `sourceKind` | String | structural / operational value |
| UserHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| UserHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| RouteOwnerHistory | `id` | BigInt | the strict order of the history |
| RouteOwnerHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| RouteOwnerHistory | `changedFields` | String[] | field NAMES only — never a value |
| RouteOwnerHistory | `validFrom` | DateTime | when the change took effect |
| RouteOwnerHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| RouteOwnerHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| RouteOwnerHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| RouteOwnerHistory | `sourceKind` | String | structural / operational value |
| RouteOwnerHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| RouteOwnerHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| RouteOwnerHistory | `routeId` | String | foreign key / structural value |
| RouteHistory | `id` | BigInt | the strict order of the history |
| RouteHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| RouteHistory | `changedFields` | String[] | field NAMES only — never a value |
| RouteHistory | `validFrom` | DateTime | when the change took effect |
| RouteHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| RouteHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| RouteHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| RouteHistory | `sourceKind` | String | structural / operational value |
| RouteHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| RouteHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| RouteHistory | `routeId` | String | foreign key / structural value |
| RouteHistory | `name` | String | structural / operational value |
| RouteHistory | `regionId` | String | foreign key / structural value |
| RouteHistory | `isActive` | Boolean | structural / operational value |
| RegionHistory | `id` | BigInt | the strict order of the history |
| RegionHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| RegionHistory | `changedFields` | String[] | field NAMES only — never a value |
| RegionHistory | `validFrom` | DateTime | when the change took effect |
| RegionHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| RegionHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| RegionHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| RegionHistory | `sourceKind` | String | structural / operational value |
| RegionHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| RegionHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| RegionHistory | `regionId` | String | foreign key / structural value |
| RegionHistory | `code` | String | structural / operational value |
| RegionHistory | `name` | String | geographic area of operations |
| RegionHistory | `isActive` | Boolean | structural / operational value |
| AttachmentHistory | `id` | BigInt | the strict order of the history |
| AttachmentHistory | `changeKind` | HistoryChange | BASELINE, CREATE, UPDATE or DELETE |
| AttachmentHistory | `changedFields` | String[] | field NAMES only — never a value |
| AttachmentHistory | `validFrom` | DateTime | when the change took effect |
| AttachmentHistory | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| AttachmentHistory | `effectiveRequested` | DateTime | the effective time the writer asked for |
| AttachmentHistory | `source` | String | what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed |
| AttachmentHistory | `sourceKind` | String | structural / operational value |
| AttachmentHistory | `txId` | BigInt | database transaction id (joins AuditLog.txId) |
| AttachmentHistory | `dbUser` | String | the database login (the runtime role or the owner), not a person |
| AttachmentHistory | `attachmentId` | String | structural / operational value |
| AttachmentHistory | `kind` | AttachmentKind | which slot or document kind it was |
| AttachmentHistory | `customerId` | String | foreign key / structural value |
| AttachmentHistory | `branchId` | String | foreign key / structural value |
| AttachmentHistory | `branchExtraId` | String | foreign key / structural value |
| AttachmentHistory | `editId` | String | foreign key / structural value |
| AttachmentHistory | `deletedAt` | DateTime | when it was removed or replaced, as it was |
| AttachmentHistory | `hash` | String | the SHA-256 the phone computed of the image: matches the same picture, cannot show it. The capture GPS is never copied |
| EditRevision | `id` | BigInt | the strict order of the rounds |
| EditRevision | `editId` | String | foreign key / structural value |
| EditRevision | `cycle` | Int | structural / operational value |
| EditRevision | `process` | EditProcess | structural / operational value |
| EditRevision | `payloadSha256` | String | SHA-256 of the payload: two rounds that sent the same thing match |
| EditRevision | `recordedAt` | DateTime | record timestamp, not an attribute of a person |
| EditRevision | `source` | String | the request that wrote it (lib/change-context.ts) |
| EditCustomerDraft | `id` | String | foreign key / structural value |
| EditCustomerDraft | `editId` | String | foreign key / structural value |
| EditCustomerDraft | `channelId` | String | foreign key / structural value |
| EditCustomerDraft | `subChannelId` | String | foreign key / structural value |
| EditCustomerDraft | `crPhotoAttachmentId` | String | structural / operational value |
| EditBranchDraft | `id` | String | foreign key / structural value |
| EditBranchDraft | `editId` | String | foreign key / structural value |
| EditBranchDraft | `regionId` | String | foreign key / structural value |
| EditBranchDraft | `routeId` | String | foreign key / structural value |
| EditBranchDraft | `gpsAccuracy` | Float | structural / operational value |
| EditBranchDraft | `coolersCount` | Int | structural / operational value |
| EditBranchDraft | `standsCount` | Int | structural / operational value |
| EditBranchDraft | `emptyBottlesCount` | Int | structural / operational value |
| EditBranchDraft | `shopPhotoAttachmentId` | String | structural / operational value |
| EditBranchDraft | `signboardPhotoAttachmentId` | String | structural / operational value |
| EditBranchDraft | `extraPhotoAttachmentIds` | Json | structural / operational value |
| EditBranchDraft | `branchId` | String | the shop this draft became at finalize (gap 27); structural |
| EditApproval | `id` | String | foreign key / structural value |
| EditApproval | `editId` | String | foreign key / structural value |
| EditApproval | `cycle` | Int | structural / operational value |
| EditApproval | `stepIndex` | Int | structural / operational value |
| EditApproval | `category` | String | the send-back reason category picked from a fixed list (gap 12) |
| EditApproval | `authorityBasis` | String | why the decider could decide (lib/permissions.ts AUTHORITY_BASES), a fixed value the database checks |
| EditApproval | `scopeRegionIds` | String[] | the regions the request covered when decided |
| EditApproval | `submitterRouteId` | String | the submitting salesman’s route when decided |
| EditApproval | `seq` | BigInt | strict order: the key the nightly seal ranges are read by (gap 28) |
| Notification | `id` | String | foreign key / structural value |
| Notification | `kind` | NotificationKind | structural / operational value |
| Notification | `editId` | String | foreign key / structural value |
| Notification | `customerId` | String | foreign key / structural value |
| Notification | `emailedAt` | DateTime | record timestamp, not an attribute of a person |
| Notification | `emailStatus` | String | outbox state of this row (SENT, FAILED, SKIPPED_* or PRE_FEATURE); no address or message text |
| Notification | `emailAttempts` | Int | outbox claim counter |
| Notification | `emailLeaseUntil` | DateTime | record timestamp, not an attribute of a person |
| Notification | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| TemixSyncBatch | `id` | String | foreign key / structural value |
| TemixSyncBatch | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| TemixSyncBatch | `rowCount` | Int | structural / operational value |
| TemixSyncBatch | `customerIds` | Json | identifiers only; the workbook itself carries the personal data |
| TemixSyncBatch | `status` | ExportJobStatus | structural / operational value |
| TemixSyncBatch | `r2Key` | String | structural / operational value |
| TemixSyncBatch | `markedLoadedAt` | DateTime | record timestamp, not an attribute of a person |
| CodeSequence | `scope` | String | structural / operational value |
| CodeSequence | `next` | Int | customer-code counter |

</details>
