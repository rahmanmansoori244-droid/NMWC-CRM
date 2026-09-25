# Personal-data inventory (technical annex)

<!-- GENERATED FILE — do not edit by hand.
     Source: prisma/schema.prisma + lib/compliance/pii-classification.ts
     Regenerate: npx tsx scripts/compliance/build-pii-inventory.ts
     CI fails if this file is stale or if any column is unclassified. -->

Every column the database stores, classified by whose personal data it is. This file is generated: the classification lives beside the code in `lib/compliance/pii-classification.ts`, and `tests/unit/pii-classification.test.ts` fails if a column is added without a decision. It is the factual annex to `docs/compliance/DATA-RESIDENCY-REGISTER.md`.

**280 stored columns across 23 tables** — Customer contact: 25 · Employee: 61 · Customer entity (personal if a sole establishment): 36 · Not personal data: 158.

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
| `fieldChanges` | Customer contact | snapshot | before/after values of the customer and branch fields above — a second copy of the same personal data; plus, for a GPS point typed in by hand, the salesman’s own free-text reason (item 41), which the APPROVE audit row also copies |
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

### RateLimit

| Column | Subject | Kind | Note |
|---|---|---|---|
| `key` | Employee | identifier | login buckets are keyed `login:user:<username>` and `login:ip:<address>` — an attempted username and a source IP address |

### ExportJob

| Column | Subject | Kind | Note |
|---|---|---|---|
| `requestedById` | Employee | behaviour |  |
| `filters` | Customer contact | free text | would embed the search term used |

### AuditLog

| Column | Subject | Kind | Note |
|---|---|---|---|
| `actorId` | Employee | identifier | who did it |
| `action` | Employee | behaviour |  |
| `before` | Customer contact | snapshot | full field snapshot — legal name, CR number, phones, contact person, notes, address, GPS. Cannot be edited or deleted except in an owner-session maintenance transaction (migrations 20260914150000 + 20260914160000) |
| `after` | Customer contact | snapshot | as above |
| `reason` | Customer contact | free text |  |
| `ip` | Employee | device | source IP of the member of staff |
| `userAgent` | Employee | device | browser and device string |
| `at` | Employee | behaviour | when that person acted |

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
| `decision` | Employee | behaviour | what this named person decided |
| `actorId` | Employee | identifier |  |
| `reason` | Customer contact | free text |  |
| `at` | Employee | behaviour |  |

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

`Region`, `Channel`, `SubChannel`, `CronHeartbeat`, `CodeSequence`

## Columns classified as not personal data

<details><summary>Expand — every remaining column, so the classification is auditable</summary>

| Table | Column | Type | Why not personal data |
|---|---|---|---|
| Region | `id` | String | foreign key / structural value |
| Region | `name` | String | geographic area of operations |
| Region | `code` | String | structural / operational value |
| Region | `isActive` | Boolean | structural / operational value |
| Region | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Region | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| Route | `id` | String | foreign key / structural value |
| Route | `name` | String | structural / operational value |
| Route | `regionId` | String | foreign key / structural value |
| Route | `isActive` | Boolean | structural / operational value |
| Route | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| Route | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
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
| Branch | `customerId` | String | foreign key / structural value |
| Branch | `regionId` | String | foreign key / structural value |
| Branch | `routeId` | String | foreign key / structural value |
| Branch | `gpsAccuracy` | Float | metres reported by the device |
| Branch | `coolersCount` | Int | structural / operational value |
| Branch | `standsCount` | Int | structural / operational value |
| Branch | `emptyBottlesCount` | Int | structural / operational value |
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
| CustomerEdit | `process` | EditProcess | structural / operational value |
| CustomerEdit | `currentStepIndex` | Int | structural / operational value |
| CustomerEdit | `pendingRole` | Role | structural / operational value |
| CustomerEdit | `cycle` | Int | structural / operational value |
| CustomerEdit | `createdAt` | DateTime | record timestamp, not an attribute of a person |
| CustomerEdit | `updatedAt` | DateTime | record timestamp, not an attribute of a person |
| Attachment | `id` | String | foreign key / structural value |
| Attachment | `kind` | AttachmentKind | SHOP / SIGNBOARD / CR / GUARANTEE / EXTRA |
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
| AuditLog | `id` | String | foreign key / structural value |
| AuditLog | `entityType` | String | structural / operational value |
| AuditLog | `entityId` | String | foreign key / structural value |
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
| EditApproval | `id` | String | foreign key / structural value |
| EditApproval | `editId` | String | foreign key / structural value |
| EditApproval | `cycle` | Int | structural / operational value |
| EditApproval | `stepIndex` | Int | structural / operational value |
| Notification | `id` | String | foreign key / structural value |
| Notification | `kind` | NotificationKind | structural / operational value |
| Notification | `editId` | String | foreign key / structural value |
| Notification | `customerId` | String | foreign key / structural value |
| Notification | `emailedAt` | DateTime | record timestamp, not an attribute of a person |
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
