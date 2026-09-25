/**
 * B6 (enterprise assessment, 2026-09-14): whose personal data is in each column.
 *
 * This is the TECHNICAL ANNEX to `docs/compliance/` — an inventory of where data
 * physically sits. It is deliberately NOT a compliance artefact on its own: it
 * records no purpose, no lawful basis, no recipient and no retention period,
 * because those belong to a processing ACTIVITY rather than to a column, and
 * they are recorded in `docs/compliance/RECORDS-OF-PROCESSING.md`. A
 * column-level table mistaken for a data-protection record is compliance
 * theatre; this one exists to stop the register drifting from the schema.
 *
 * `tests/unit/pii-classification.test.ts` fails when a column is added, removed
 * or renamed without a decision here, so the annex cannot silently go stale.
 *
 * Subjects:
 *   employee            — a named member of staff (≈106 accounts)
 *   customer            — a natural person on the customer side (the shop's
 *                         contact person, and the phone numbers that in practice
 *                         are that person's mobile)
 *   business-or-person  — an attribute of the CUSTOMER ENTITY. Personal data
 *                         only when that customer is a sole establishment
 *                         registered to a named individual, which is common in
 *                         Omani retail. The repository cannot tell the two apart
 *                         (there is no legal-form field on Customer), so these
 *                         are flagged rather than decided — see the open
 *                         question Q2 in docs/compliance/PDPL-ASSESSMENT.md.
 *   none                — structural, operational or derived values that
 *                         identify no natural person.
 */

export type Subject = 'employee' | 'customer' | 'business-or-person' | 'none';

export const SUBJECT_LABEL: Record<Subject, string> = {
  employee: 'Employee',
  customer: 'Customer contact',
  'business-or-person': 'Customer entity (personal if a sole establishment)',
  none: 'Not personal data',
};

export type Classification = {
  subject: Subject;
  /** What kind of value it is — drives the transfer and minimisation discussion. */
  kind?:
    | 'identifier'
    | 'name'
    | 'contact'
    | 'location'
    | 'credential'
    | 'financial'
    | 'free text'
    | 'behaviour'
    | 'device'
    | 'image reference'
    | 'snapshot';
  note?: string;
};

const RECORD_META = 'record timestamp, not an attribute of a person';
const STRUCTURAL = 'foreign key / structural value';

export const PII_CLASSIFICATION: Record<string, Classification> = {
  // ---- Region: organisational taxonomy -----------------------------------
  'Region.id': { subject: 'none', note: STRUCTURAL },
  'Region.name': { subject: 'none', note: 'geographic area of operations' },
  'Region.code': { subject: 'none' },
  'Region.isActive': { subject: 'none' },
  'Region.createdAt': { subject: 'none', note: RECORD_META },
  'Region.updatedAt': { subject: 'none', note: RECORD_META },

  // ---- Route ---------------------------------------------------------------
  'Route.id': { subject: 'none', note: STRUCTURAL },
  'Route.name': { subject: 'none' },
  'Route.code': {
    subject: 'employee',
    kind: 'identifier',
    note: 'doubles as the salesman’s login username, so it names a person as well as a round',
  },
  'Route.regionId': { subject: 'none', note: STRUCTURAL },
  'Route.isActive': { subject: 'none' },
  'Route.createdAt': { subject: 'none', note: RECORD_META },
  'Route.updatedAt': { subject: 'none', note: RECORD_META },

  // ---- User: the employee record ------------------------------------------
  'User.id': { subject: 'employee', kind: 'identifier' },
  'User.username': { subject: 'employee', kind: 'identifier', note: 'route code for salesmen, given name for managers' },
  'User.passwordHash': { subject: 'employee', kind: 'credential', note: 'bcrypt' },
  'User.fullName': { subject: 'employee', kind: 'name' },
  'User.role': { subject: 'employee', kind: 'behaviour', note: 'job function' },
  'User.isActive': { subject: 'employee', note: 'employment status in this system' },
  'User.email': { subject: 'employee', kind: 'contact' },
  'User.phone': { subject: 'employee', kind: 'contact' },
  'User.createdAt': { subject: 'employee', note: 'account creation — start of the employment record here' },
  'User.updatedAt': { subject: 'employee', note: RECORD_META },
  'User.lastLoginAt': { subject: 'employee', kind: 'behaviour', note: 'when this person last worked in the system' },
  'User.sessionsRevokedAt': { subject: 'employee', kind: 'behaviour' },
  'User.mustChangePassword': { subject: 'employee', kind: 'credential' },
  'User.supervisorId': { subject: 'employee', note: 'reporting line' },
  'User.ownedRouteId': { subject: 'employee', note: 'the round this person works' },

  // ---- PasswordHistory -----------------------------------------------------
  'PasswordHistory.id': { subject: 'none', note: STRUCTURAL },
  'PasswordHistory.userId': { subject: 'employee', kind: 'identifier' },
  'PasswordHistory.hash': { subject: 'employee', kind: 'credential', note: 'previous bcrypt hashes, last 5 kept' },
  'PasswordHistory.createdAt': { subject: 'employee', kind: 'behaviour', note: 'when this person changed their password' },

  // ---- SavedView -----------------------------------------------------------
  'SavedView.id': { subject: 'none', note: STRUCTURAL },
  'SavedView.userId': { subject: 'employee', kind: 'identifier' },
  'SavedView.name': { subject: 'employee', kind: 'free text', note: 'user-authored label' },
  'SavedView.urlParams': {
    subject: 'customer',
    kind: 'free text',
    note: 'a saved search can embed the phone number or name that was searched for',
  },
  'SavedView.createdAt': { subject: 'none', note: RECORD_META },

  // ---- Channel / SubChannel: product taxonomy ------------------------------
  'Channel.id': { subject: 'none', note: STRUCTURAL },
  'Channel.key': { subject: 'none' },
  'Channel.label': { subject: 'none' },
  'Channel.displayOrder': { subject: 'none' },
  'Channel.isActive': { subject: 'none' },
  'Channel.createdAt': { subject: 'none', note: RECORD_META },
  'SubChannel.id': { subject: 'none', note: STRUCTURAL },
  'SubChannel.key': { subject: 'none' },
  'SubChannel.label': { subject: 'none' },
  'SubChannel.channelId': { subject: 'none', note: STRUCTURAL },
  'SubChannel.isActive': { subject: 'none' },
  'SubChannel.createdAt': { subject: 'none', note: RECORD_META },

  // ---- Customer ------------------------------------------------------------
  'Customer.id': { subject: 'business-or-person', kind: 'identifier' },
  'Customer.nmwcCode': { subject: 'business-or-person', kind: 'identifier', note: 'the company’s own customer code' },
  'Customer.legalName': { subject: 'business-or-person', kind: 'name', note: 'a sole establishment is usually registered in the owner’s name' },
  'Customer.paymentTerms': { subject: 'business-or-person', kind: 'financial' },
  'Customer.crNumber': { subject: 'business-or-person', kind: 'identifier', note: 'commercial registration; identifies the owner of a sole establishment' },
  'Customer.crNumberNorm': { subject: 'business-or-person', kind: 'identifier', note: 'normalised copy for de-duplication' },
  'Customer.channelId': { subject: 'none', note: STRUCTURAL },
  'Customer.subChannelId': { subject: 'none', note: STRUCTURAL },
  'Customer.primaryPhone': { subject: 'customer', kind: 'contact', note: 'in practice the owner’s or manager’s mobile' },
  'Customer.primaryPhoneNorm': { subject: 'customer', kind: 'contact', note: 'normalised copy used for matching' },
  'Customer.altPhone': { subject: 'customer', kind: 'contact' },
  'Customer.contactPerson': { subject: 'customer', kind: 'name' },
  'Customer.contactRole': { subject: 'customer', note: 'that person’s role at the shop' },
  'Customer.status': { subject: 'business-or-person' },
  'Customer.notes': { subject: 'customer', kind: 'free text', note: 'unbounded; whatever a salesman or approver typed' },
  'Customer.completenessScore': { subject: 'none', note: 'derived' },
  'Customer.version': { subject: 'none', note: 'optimistic-concurrency counter' },
  'Customer.importBatchId': { subject: 'none', note: STRUCTURAL },
  'Customer.importRowId': { subject: 'none', note: STRUCTURAL },
  'Customer.crPhotoId': { subject: 'none', note: 'reference to the CR document image in R2' },
  'Customer.creditLimit': { subject: 'business-or-person', kind: 'financial' },
  'Customer.paymentTermDays': { subject: 'business-or-person', kind: 'financial' },
  'Customer.temixCode': { subject: 'business-or-person', kind: 'identifier', note: 'the identifier this customer has in the Temix ERP' },
  'Customer.temixSyncState': { subject: 'none' },
  'Customer.temixSyncPendingSince': { subject: 'none', note: RECORD_META },
  'Customer.lastTemixUploadAt': { subject: 'none', note: RECORD_META },
  'Customer.lastTemixUploadBatchId': { subject: 'none', note: STRUCTURAL },
  'Customer.createdAt': { subject: 'none', note: RECORD_META },
  'Customer.updatedAt': { subject: 'none', note: RECORD_META },
  'Customer.createdById': { subject: 'employee', kind: 'behaviour', note: 'which member of staff created this record' },
  'Customer.lastEditedById': { subject: 'employee', kind: 'behaviour' },
  'Customer.deletedAt': { subject: 'none', note: 'soft-delete marker' },

  // ---- Branch --------------------------------------------------------------
  'Branch.id': { subject: 'business-or-person', kind: 'identifier' },
  'Branch.customerId': { subject: 'none', note: STRUCTURAL },
  'Branch.branchCode': { subject: 'business-or-person', kind: 'identifier' },
  'Branch.branchName': { subject: 'business-or-person', kind: 'name' },
  'Branch.regionId': { subject: 'none', note: STRUCTURAL },
  'Branch.routeId': { subject: 'none', note: STRUCTURAL },
  'Branch.address': { subject: 'business-or-person', kind: 'location', note: 'premises address; a home-delivery customer’s address is their home' },
  'Branch.areaDescription': { subject: 'business-or-person', kind: 'location' },
  'Branch.gpsLat': { subject: 'business-or-person', kind: 'location', note: 'six-decimal precision — a doorway, not a district' },
  'Branch.gpsLng': { subject: 'business-or-person', kind: 'location' },
  'Branch.gpsAccuracy': { subject: 'none', note: 'metres reported by the device' },
  'Branch.gpsCapturedAt': { subject: 'employee', kind: 'behaviour', note: 'when a named salesman stood at this location' },
  'Branch.dayOfVisit': { subject: 'business-or-person' },
  'Branch.openingHours': { subject: 'business-or-person' },
  'Branch.deliveryWindow': { subject: 'business-or-person' },
  'Branch.coolersCount': { subject: 'none' },
  'Branch.standsCount': { subject: 'none' },
  'Branch.emptyBottlesCount': { subject: 'none' },
  'Branch.shopPhotoId': { subject: 'none', kind: 'image reference', note: 'reference; the image itself is in R2' },
  'Branch.signboardPhotoId': { subject: 'none', kind: 'image reference' },
  'Branch.status': { subject: 'business-or-person' },
  'Branch.completenessScore': { subject: 'none', note: 'derived' },
  'Branch.lastStatusChangeAt': { subject: 'none', note: RECORD_META },
  'Branch.version': { subject: 'none', note: 'optimistic-concurrency counter' },
  'Branch.createdAt': { subject: 'none', note: RECORD_META },
  'Branch.updatedAt': { subject: 'none', note: RECORD_META },
  'Branch.createdById': { subject: 'employee', kind: 'behaviour' },
  'Branch.lastEditedById': { subject: 'employee', kind: 'behaviour' },
  'Branch.deletedAt': { subject: 'none', note: 'soft-delete marker' },

  // ---- CustomerEdit: the change-request record -----------------------------
  'CustomerEdit.id': { subject: 'none', note: STRUCTURAL },
  'CustomerEdit.target': { subject: 'none' },
  'CustomerEdit.customerId': { subject: 'none', note: STRUCTURAL },
  'CustomerEdit.branchId': { subject: 'none', note: STRUCTURAL },
  'CustomerEdit.state': { subject: 'none' },
  'CustomerEdit.submittedById': { subject: 'employee', kind: 'behaviour', note: 'who proposed the change' },
  'CustomerEdit.submittedAt': { subject: 'employee', kind: 'behaviour' },
  'CustomerEdit.reviewedById': { subject: 'employee', kind: 'behaviour' },
  'CustomerEdit.reviewedAt': { subject: 'employee', kind: 'behaviour' },
  'CustomerEdit.decisionReason': { subject: 'customer', kind: 'free text', note: 'approver’s words; may describe the customer or the submitting employee' },
  'CustomerEdit.decisionCategory': { subject: 'none' },
  'CustomerEdit.fieldChanges': {
    subject: 'customer',
    kind: 'snapshot',
    note: 'before/after values of the customer and branch fields above — a second copy of the same personal data; plus, for a GPS point typed in by hand, the salesman’s own free-text reason (item 41), which the UPDATE APPROVE audit row also copies',
  },
  'CustomerEdit.attachmentChanges': { subject: 'none', kind: 'image reference' },
  'CustomerEdit.isReactivation': { subject: 'none' },
  'CustomerEdit.isWrongRoute': { subject: 'none' },
  'CustomerEdit.newRouteId': { subject: 'none', note: STRUCTURAL },
  'CustomerEdit.submissionId': {
    subject: 'none',
    note: 'a random id the phone mints for each submit, so a retry is never written twice (item 22); identifies the request, not a person or a device',
  },
  'CustomerEdit.process': { subject: 'none' },
  'CustomerEdit.paymentTermsAtSubmit': { subject: 'business-or-person', kind: 'financial' },
  'CustomerEdit.approvalChain': { subject: 'employee', kind: 'snapshot', note: 'the roles and step order frozen at submit time' },
  'CustomerEdit.currentStepIndex': { subject: 'none' },
  'CustomerEdit.pendingRole': { subject: 'none' },
  'CustomerEdit.cycle': { subject: 'none' },
  'CustomerEdit.requestedCreditLimit': { subject: 'business-or-person', kind: 'financial' },
  'CustomerEdit.requestedPaymentTermDays': { subject: 'business-or-person', kind: 'financial' },
  'CustomerEdit.stageEnteredAt': { subject: 'employee', kind: 'behaviour', note: 'feeds the SLA clock on a named approver' },
  'CustomerEdit.slaDueAt': { subject: 'employee', kind: 'behaviour' },
  'CustomerEdit.slaBreachedAt': { subject: 'employee', kind: 'behaviour', note: 'records that a named person missed a deadline' },
  'CustomerEdit.escalationLevel': { subject: 'employee', kind: 'behaviour' },
  'CustomerEdit.lastEscalatedAt': { subject: 'employee', kind: 'behaviour' },
  'CustomerEdit.createdAt': { subject: 'none', note: RECORD_META },
  'CustomerEdit.updatedAt': { subject: 'none', note: RECORD_META },

  // ---- Attachment: photo metadata (the images live in R2) ------------------
  'Attachment.id': { subject: 'none', note: STRUCTURAL },
  'Attachment.kind': { subject: 'none', note: 'SHOP / SIGNBOARD / CR / GUARANTEE / EXTRA' },
  'Attachment.customerId': { subject: 'none', note: STRUCTURAL },
  'Attachment.branchId': { subject: 'none', note: STRUCTURAL },
  'Attachment.branchExtraId': { subject: 'none', note: STRUCTURAL },
  'Attachment.editId': { subject: 'none', note: STRUCTURAL },
  'Attachment.r2Key': {
    subject: 'employee',
    kind: 'image reference',
    note: 'the key embeds date/userId/kind, so the bucket listing alone is an employee activity log; the image it points at may show a CR document, a shopfront, passers-by and vehicle plates',
  },
  'Attachment.mimeType': { subject: 'none' },
  'Attachment.bytes': { subject: 'none' },
  'Attachment.width': { subject: 'none' },
  'Attachment.height': { subject: 'none' },
  'Attachment.capturedById': { subject: 'employee', kind: 'identifier' },
  'Attachment.capturedAt': { subject: 'employee', kind: 'behaviour' },
  'Attachment.capturedLat': { subject: 'employee', kind: 'location', note: 'where the member of staff was standing — device GPS, not the premises record' },
  'Attachment.capturedLng': { subject: 'employee', kind: 'location' },
  'Attachment.hash': { subject: 'none', note: 'content hash for duplicate detection' },
  'Attachment.createdAt': { subject: 'none', note: RECORD_META },
  'Attachment.deletedAt': { subject: 'none', note: 'soft-delete marker; starts the 30-day GC clock' },

  // ---- ImportBatch / ImportRow --------------------------------------------
  'ImportBatch.id': { subject: 'none', note: STRUCTURAL },
  'ImportBatch.filename': { subject: 'none', note: 'operator-supplied file name' },
  'ImportBatch.kind': { subject: 'none' },
  'ImportBatch.uploadedById': { subject: 'employee', kind: 'behaviour' },
  'ImportBatch.uploadedAt': { subject: 'employee', kind: 'behaviour' },
  'ImportBatch.status': { subject: 'none' },
  'ImportBatch.totalRows': { subject: 'none' },
  'ImportBatch.cleanRows': { subject: 'none' },
  'ImportBatch.quarantinedRows': { subject: 'none' },
  'ImportBatch.promotedRows': { subject: 'none' },
  'ImportBatch.rejectedRows': { subject: 'none' },
  'ImportBatch.promoteLeaseBy': { subject: 'employee', kind: 'identifier', note: 'which Steward holds the promote lease' },
  'ImportBatch.promoteLeaseUntil': { subject: 'none', note: RECORD_META },
  'ImportRow.id': { subject: 'none', note: STRUCTURAL },
  'ImportRow.batchId': { subject: 'none', note: STRUCTURAL },
  'ImportRow.rowNumber': { subject: 'none' },
  'ImportRow.raw': {
    subject: 'customer',
    kind: 'snapshot',
    note: 'the source spreadsheet row verbatim, including columns the app never maps — a third copy of the customer master',
  },
  'ImportRow.parsed': { subject: 'customer', kind: 'snapshot' },
  'ImportRow.state': { subject: 'none', note: 'CLEAN / QUARANTINED / PROMOTED / REJECTED' },
  'ImportRow.issues': { subject: 'customer', kind: 'free text', note: 'validation messages quote the offending value' },
  'ImportRow.reviewedById': { subject: 'employee', kind: 'behaviour' },
  'ImportRow.reviewedAt': { subject: 'employee', kind: 'behaviour' },
  'ImportRow.createdAt': { subject: 'none', note: RECORD_META },
  'ImportRow.corrections': { subject: 'customer', kind: 'snapshot', note: 'cells the Steward corrected in the app (item 20); cleared with raw by the retention sweep' },
  'ImportRow.excludedAt': { subject: 'employee', kind: 'behaviour' },
  'ImportRow.excludedById': { subject: 'employee', kind: 'behaviour' },
  'ImportRow.excludedReason': { subject: 'employee', kind: 'free text', note: 'why the Steward accepted the row as excluded; may name the customer' },

  // ---- CronHeartbeat -------------------------------------------------------
  'CronHeartbeat.key': { subject: 'none' },
  'CronHeartbeat.lastRunAt': { subject: 'none', note: RECORD_META },
  'CronHeartbeat.lastOk': { subject: 'none' },
  'CronHeartbeat.lastDurationMs': { subject: 'none' },
  'CronHeartbeat.lastError': { subject: 'none', note: 'scrubbed through lib/scrub.ts before it is stored' },
  'CronHeartbeat.lastDetail': { subject: 'none', note: 'job counters returned by the route' },
  'CronHeartbeat.runs': { subject: 'none' },
  'CronHeartbeat.failures': { subject: 'none' },
  'CronHeartbeat.createdAt': { subject: 'none', note: RECORD_META },
  'CronHeartbeat.updatedAt': { subject: 'none', note: RECORD_META },

  // ---- RateLimit -----------------------------------------------------------
  'RateLimit.key': {
    subject: 'employee',
    kind: 'identifier',
    note: 'login buckets are keyed `login:user:<username>` and `login:ip:<address>` — an attempted username and a source IP address',
  },
  'RateLimit.tokens': { subject: 'none' },
  'RateLimit.lastRefill': { subject: 'none', note: RECORD_META },
  'RateLimit.updatedAt': { subject: 'none', note: RECORD_META },

  // ---- ExportJob (declared, not yet used by any code path) -----------------
  'ExportJob.id': { subject: 'none', note: STRUCTURAL },
  'ExportJob.requestedById': { subject: 'employee', kind: 'behaviour' },
  'ExportJob.filters': { subject: 'customer', kind: 'free text', note: 'would embed the search term used' },
  'ExportJob.status': { subject: 'none' },
  'ExportJob.r2Key': { subject: 'none', kind: 'image reference' },
  'ExportJob.rowCount': { subject: 'none' },
  'ExportJob.startedAt': { subject: 'none', note: RECORD_META },
  'ExportJob.completedAt': { subject: 'none', note: RECORD_META },
  'ExportJob.errorMessage': { subject: 'none' },

  // ---- AuditLog: append-only, and therefore the hardest to erase from ------
  'AuditLog.id': { subject: 'none', note: STRUCTURAL },
  'AuditLog.actorId': { subject: 'employee', kind: 'identifier', note: 'who did it' },
  'AuditLog.action': { subject: 'employee', kind: 'behaviour' },
  'AuditLog.entityType': { subject: 'none' },
  'AuditLog.entityId': { subject: 'none', note: STRUCTURAL },
  'AuditLog.before': {
    subject: 'customer',
    kind: 'snapshot',
    note: 'full field snapshot — legal name, CR number, phones, contact person, notes, address, GPS. Cannot be edited or deleted except in an owner-session maintenance transaction (migrations 20260914150000 + 20260914160000)',
  },
  'AuditLog.after': {
    subject: 'customer',
    kind: 'snapshot',
    note: 'as above; an UPDATE approval also copies CustomerEdit.fieldChanges here, including a salesman’s free-text manual-GPS reason (item 41). A duplicate dismissal stores truncated, unkeyed sha256 digests of the shared CR and of name + phone (item 16) — for a short CR the value can be recovered by brute force',
  },
  'AuditLog.reason': { subject: 'customer', kind: 'free text' },
  'AuditLog.ip': { subject: 'employee', kind: 'device', note: 'source IP of the member of staff' },
  'AuditLog.userAgent': { subject: 'employee', kind: 'device', note: 'browser and device string' },
  'AuditLog.at': { subject: 'employee', kind: 'behaviour', note: 'when that person acted' },

  // ---- Edit drafts: proposed values, same shape as the live records --------
  'EditCustomerDraft.id': { subject: 'none', note: STRUCTURAL },
  'EditCustomerDraft.editId': { subject: 'none', note: STRUCTURAL },
  'EditCustomerDraft.legalName': { subject: 'business-or-person', kind: 'name' },
  'EditCustomerDraft.paymentTerms': { subject: 'business-or-person', kind: 'financial' },
  'EditCustomerDraft.crNumber': { subject: 'business-or-person', kind: 'identifier' },
  'EditCustomerDraft.crNumberNorm': { subject: 'business-or-person', kind: 'identifier' },
  'EditCustomerDraft.channelId': { subject: 'none', note: STRUCTURAL },
  'EditCustomerDraft.subChannelId': { subject: 'none', note: STRUCTURAL },
  'EditCustomerDraft.primaryPhone': { subject: 'customer', kind: 'contact' },
  'EditCustomerDraft.primaryPhoneNorm': { subject: 'customer', kind: 'contact' },
  'EditCustomerDraft.altPhone': { subject: 'customer', kind: 'contact' },
  'EditCustomerDraft.contactPerson': { subject: 'customer', kind: 'name' },
  'EditCustomerDraft.contactRole': { subject: 'customer' },
  'EditCustomerDraft.notes': { subject: 'customer', kind: 'free text' },
  'EditCustomerDraft.crPhotoAttachmentId': { subject: 'none', kind: 'image reference' },
  'EditBranchDraft.id': { subject: 'none', note: STRUCTURAL },
  'EditBranchDraft.editId': { subject: 'none', note: STRUCTURAL },
  'EditBranchDraft.branchName': { subject: 'business-or-person', kind: 'name' },
  'EditBranchDraft.regionId': { subject: 'none', note: STRUCTURAL },
  'EditBranchDraft.routeId': { subject: 'none', note: STRUCTURAL },
  'EditBranchDraft.address': { subject: 'business-or-person', kind: 'location' },
  'EditBranchDraft.areaDescription': { subject: 'business-or-person', kind: 'location' },
  'EditBranchDraft.gpsLat': { subject: 'business-or-person', kind: 'location' },
  'EditBranchDraft.gpsLng': { subject: 'business-or-person', kind: 'location' },
  'EditBranchDraft.gpsAccuracy': { subject: 'none' },
  'EditBranchDraft.gpsCapturedAt': { subject: 'employee', kind: 'behaviour' },
  'EditBranchDraft.dayOfVisit': { subject: 'business-or-person' },
  'EditBranchDraft.openingHours': { subject: 'business-or-person' },
  'EditBranchDraft.deliveryWindow': { subject: 'business-or-person' },
  'EditBranchDraft.coolersCount': { subject: 'none' },
  'EditBranchDraft.standsCount': { subject: 'none' },
  'EditBranchDraft.emptyBottlesCount': { subject: 'none' },
  'EditBranchDraft.shopPhotoAttachmentId': { subject: 'none', kind: 'image reference' },
  'EditBranchDraft.signboardPhotoAttachmentId': { subject: 'none', kind: 'image reference' },
  'EditBranchDraft.extraPhotoAttachmentIds': { subject: 'none', kind: 'image reference' },

  // ---- EditApproval: the per-step decision ledger (append-only) ------------
  'EditApproval.id': { subject: 'none', note: STRUCTURAL },
  'EditApproval.editId': { subject: 'none', note: STRUCTURAL },
  'EditApproval.cycle': { subject: 'none' },
  'EditApproval.stepIndex': { subject: 'none' },
  'EditApproval.role': { subject: 'employee', kind: 'behaviour' },
  'EditApproval.decision': { subject: 'employee', kind: 'behaviour', note: 'what this named person decided' },
  'EditApproval.actorId': { subject: 'employee', kind: 'identifier' },
  'EditApproval.reason': { subject: 'customer', kind: 'free text' },
  'EditApproval.at': { subject: 'employee', kind: 'behaviour' },

  // ---- Notification --------------------------------------------------------
  'Notification.id': { subject: 'none', note: STRUCTURAL },
  'Notification.userId': { subject: 'employee', kind: 'identifier' },
  'Notification.kind': { subject: 'none' },
  'Notification.title': { subject: 'customer', kind: 'free text', note: 'carries the customer’s legal name and code by design' },
  'Notification.body': { subject: 'customer', kind: 'free text' },
  'Notification.editId': { subject: 'none', note: STRUCTURAL },
  'Notification.customerId': { subject: 'none', note: STRUCTURAL },
  'Notification.readAt': { subject: 'employee', kind: 'behaviour', note: 'whether and when this person read it' },
  'Notification.emailedAt': { subject: 'none', note: RECORD_META },
  'Notification.createdAt': { subject: 'none', note: RECORD_META },

  // ---- TemixSyncBatch: the outbound ERP hand-off ---------------------------
  'TemixSyncBatch.id': { subject: 'none', note: STRUCTURAL },
  'TemixSyncBatch.createdById': { subject: 'employee', kind: 'behaviour' },
  'TemixSyncBatch.createdAt': { subject: 'none', note: RECORD_META },
  'TemixSyncBatch.rowCount': { subject: 'none' },
  'TemixSyncBatch.customerIds': { subject: 'none', note: 'identifiers only; the workbook itself carries the personal data' },
  'TemixSyncBatch.status': { subject: 'none' },
  'TemixSyncBatch.r2Key': { subject: 'none', kind: 'image reference' },
  'TemixSyncBatch.markedLoadedAt': { subject: 'none', note: RECORD_META },

  // ---- CodeSequence --------------------------------------------------------
  'CodeSequence.scope': { subject: 'none' },
  'CodeSequence.next': { subject: 'none', note: 'customer-code counter' },
};
