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

/**
 * The columns every dated-history table shares (prisma/migrations/20261013100100,
 * docs/HISTORY.md): when and why a change was recorded, and by whom.
 */
function historyCommon(table: string): Record<string, Classification> {
  return {
    [`${table}.id`]: { subject: 'none', note: 'the strict order of the history' },
    [`${table}.changeKind`]: { subject: 'none', note: 'BASELINE, CREATE, UPDATE or DELETE' },
    [`${table}.changedFields`]: { subject: 'none', note: 'field NAMES only — never a value' },
    [`${table}.validFrom`]: { subject: 'none', note: 'when the change took effect' },
    [`${table}.recordedAt`]: { subject: 'none', note: RECORD_META },
    [`${table}.effectiveRequested`]: { subject: 'none', note: 'the effective time the writer asked for' },
    [`${table}.actorId`]: { subject: 'employee', kind: 'identifier', note: 'who caused the change (null for a job or an unnamed script)' },
    [`${table}.source`]: {
      subject: 'none',
      kind: 'identifier',
      note: 'what caused it: a request, import row, script run or job (lib/change-context.ts), never text a person typed',
    },
    [`${table}.sourceKind`]: { subject: 'none' },
    [`${table}.txId`]: { subject: 'none', note: 'database transaction id (joins AuditLog.txId)' },
    [`${table}.dbUser`]: { subject: 'none', note: 'the database login (the runtime role or the owner), not a person' },
  };
}

export const PII_CLASSIFICATION: Record<string, Classification> = {
  // ---- Region: organisational taxonomy -----------------------------------
  'Region.id': { subject: 'none', note: STRUCTURAL },
  'Region.name': { subject: 'none', note: 'geographic area of operations' },
  'Region.code': { subject: 'none' },
  'Region.isActive': { subject: 'none' },
  'Region.isTest': { subject: 'none', note: 'a test or synthetic record left in production (gap 30); set by the owner only' },
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
  'Route.isTest': { subject: 'none', note: 'a test or synthetic record left in production (gap 30); set by the owner only' },
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
  'User.isTest': { subject: 'none', note: 'a test or synthetic record left in production (gap 30); set by the owner only' },

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
  'Customer.email': { subject: 'customer', kind: 'contact', note: 'credit customers only (owner decisions 2026-10-11); often the owner’s own address' },
  'Customer.status': { subject: 'business-or-person' },
  'Customer.notes': { subject: 'customer', kind: 'free text', note: 'unbounded; whatever a salesman or approver typed' },
  'Customer.completenessScore': { subject: 'none', note: 'derived' },
  'Customer.version': { subject: 'none', note: 'optimistic-concurrency counter' },
  'Customer.importBatchId': { subject: 'none', note: STRUCTURAL },
  'Customer.importRowId': { subject: 'none', note: STRUCTURAL },
  'Customer.isTest': { subject: 'none', note: 'a test or synthetic record left in production (gap 30); set by the owner only' },
  'Customer.mergedIntoId': { subject: 'none', note: 'the customer a duplicate merge folded this one into (lossless paths, gap 8); structural' },
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
  'Branch.equipmentConfirmed': { subject: 'none', note: 'the counts were confirmed at the shop (F21)' },
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
  'CustomerEdit.originalCustomerId': {
    subject: 'none',
    note: 'the customer the request was first about, set once by the database (lossless paths, gap 8); structural',
  },
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
    note: 'before/after values of the customer and branch fields above, and for a field kept over a value changed after the form opened, that newer value (overrodeLive, F06) — a second copy of the same personal data; plus, for a GPS point typed in by hand, the salesman’s own free-text reason (item 41), which the UPDATE APPROVE audit row also copies',
  },
  'CustomerEdit.attachmentChanges': { subject: 'none', kind: 'image reference' },
  'CustomerEdit.isReactivation': { subject: 'none' },
  'CustomerEdit.isWrongRoute': { subject: 'none' },
  'CustomerEdit.newRouteId': { subject: 'none', note: STRUCTURAL },
  'CustomerEdit.submissionId': {
    subject: 'none',
    note: 'a random id the phone mints for each submit, so a retry is never written twice (item 22); identifies the request, not a person or a device',
  },
  'CustomerEdit.submitGate': {
    subject: 'none',
    note: 'the ids of the branches a salesman submit was checked against (F05); structural',
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
  'Attachment.kind': {
    subject: 'none',
    note: 'SHOP / SIGNBOARD / CR / GUARANTEE / EXTRA, and the credit documents (owner decisions 2026-10-11): ID_CARD (the owner’s ID card), MEMBERSHIP_CERT, VAT_CERT, TAX_CARD and CREDIT_FORM (the signed credit application). The kind is not personal; the image behind an ID card is the owner’s identity document',
  },
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
  'ImportBatch.fileSha256': {
    subject: 'none',
    note: 'SHA-256 of the uploaded workbook as a whole (gap 7): identifies the file, not its contents — no value can be read back from it',
  },
  'ImportBatch.fileBytes': { subject: 'none', note: 'size of the uploaded workbook' },
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

  // ---- CronRun: one row per scheduled run (item 9) ------------------------
  // Deliberately no error text and no run detail: those can quote a customer's
  // phone. The scheduler is stored as a fixed label, never the User-Agent.
  'CronRun.id': { subject: 'none', note: STRUCTURAL },
  'CronRun.key': { subject: 'none' },
  'CronRun.at': { subject: 'none', note: RECORD_META },
  'CronRun.ok': { subject: 'none' },
  'CronRun.durationMs': { subject: 'none' },
  'CronRun.dbMs': { subject: 'none' },
  'CronRun.source': { subject: 'none', note: "a fixed label ('vercel', 'cron-job.org', 'github', 'other'), not the User-Agent" },

  // ---- JobRunDay (gap 21, part C) ------------------------------------------
  // One row per scheduled job per Oman day, summarised from CronRun before its
  // runs are pruned, and kept for ever. Counts and times of machine jobs only.
  'JobRunDay.id': { subject: 'none', note: STRUCTURAL },
  'JobRunDay.key': { subject: 'none', note: 'which scheduled job' },
  'JobRunDay.day': { subject: 'none', note: 'the Oman calendar day the runs started on' },
  'JobRunDay.runs': { subject: 'none' },
  'JobRunDay.failures': { subject: 'none' },
  'JobRunDay.firstAt': { subject: 'none', note: RECORD_META },
  'JobRunDay.lastAt': { subject: 'none', note: RECORD_META },
  'JobRunDay.maxDurationMs': { subject: 'none' },
  'JobRunDay.sources': { subject: 'none', note: 'the CronRun scheduler labels seen that day, never a User-Agent' },
  'JobRunDay.recordedAt': { subject: 'none', note: RECORD_META },

  // ---- IntegrityCheckResult (gap 29: one row per nightly check) ----
  'IntegrityCheckResult.id': { subject: 'none', note: 'the strict order of the results' },
  'IntegrityCheckResult.runAt': { subject: 'none', note: 'when the run started (groups a run)' },
  'IntegrityCheckResult.day': { subject: 'none', note: 'the Oman day of the run' },
  'IntegrityCheckResult.checkId': { subject: 'none', note: 'lib/integrity/checks.ts check id' },
  'IntegrityCheckResult.version': { subject: 'none' },
  'IntegrityCheckResult.status': { subject: 'none', note: 'pass, fail, info or error' },
  'IntegrityCheckResult.count': { subject: 'none', note: 'how many records broke the rule' },
  'IntegrityCheckResult.sampleIds': {
    subject: 'employee',
    kind: 'identifier',
    note: 'at most ten ids: may hold user ids, and customer, shop, route or history row ids, trigger names, job keys or code scopes — never a value',
  },
  'IntegrityCheckResult.detail': { subject: 'none', note: 'counts by sub-kind and ids as above — never a name, phone, CR number or code' },
  'IntegrityCheckResult.durationMs': { subject: 'none' },
  'IntegrityCheckResult.recordedAt': { subject: 'none', note: RECORD_META },
  'IntegrityCheckResult.source': { subject: 'none', note: 'the change-context source (the nightly job)' },
  'IntegrityCheckResult.txId': { subject: 'none', note: 'database transaction id' },

  // ---- PurgeSummary (gap 25: one row per batch a retention rule removed) ----
  'PurgeSummary.id': { subject: 'none', note: 'the strict order of the summaries' },
  'PurgeSummary.at': { subject: 'none', note: RECORD_META },
  'PurgeSummary.job': { subject: 'none', note: 'which job ran the rule' },
  'PurgeSummary.rule': { subject: 'none', note: 'lib/retention-rules.ts rule id' },
  'PurgeSummary.tableName': { subject: 'none' },
  'PurgeSummary.action': { subject: 'none', note: 'DELETE or CLEAR_PAYLOAD' },
  'PurgeSummary.rows': { subject: 'none', note: 'how many rows the batch removed' },
  'PurgeSummary.dateColumn': { subject: 'none' },
  'PurgeSummary.oldestAt': { subject: 'none', note: 'the oldest value of the rule date column in the batch' },
  'PurgeSummary.newestAt': { subject: 'none', note: 'the newest value of the rule date column in the batch' },
  'PurgeSummary.cutoff': { subject: 'none' },
  'PurgeSummary.retentionDays': { subject: 'none' },
  'PurgeSummary.detail': {
    subject: 'none',
    note: 'counts by category only (bucket kind, month, notification kind and e-mail outcome, import batch id and row state, job key, photo kind) — never a key, a name or text',
  },
  'PurgeSummary.runId': { subject: 'none', note: 'job name and run start' },
  'PurgeSummary.source': { subject: 'none', note: 'the change-context source (a job name)' },
  'PurgeSummary.txId': { subject: 'none', note: 'database transaction id (joins AuditLog.txId)' },

  // ---- RateLimit -----------------------------------------------------------
  'RateLimit.key': {
    subject: 'employee',
    kind: 'identifier',
    note: 'login buckets are keyed `login:user:<username>` and `login:ip:<address>` — an attempted username and a source IP address',
  },
  'RateLimit.tokens': { subject: 'none' },
  'RateLimit.lastRefill': { subject: 'none', note: RECORD_META },
  'RateLimit.updatedAt': { subject: 'none', note: RECORD_META },

  // ---- ExportJob: the record of every export (lossless paths, gap 14; append-only)
  'ExportJob.id': { subject: 'none', note: STRUCTURAL },
  'ExportJob.requestedById': { subject: 'employee', kind: 'behaviour' },
  'ExportJob.filters': {
    subject: 'customer',
    kind: 'free text',
    note: 'the filters and role scope of the export; the filtered list carries the search term typed, which can be a name or a phone',
  },
  'ExportJob.kind': { subject: 'none', note: 'which export: customer-master, customers-filtered, field-updates or temix-batch (the Temix upload file, on Generate and on each re-download)' },
  'ExportJob.fileSha256': { subject: 'none', note: 'SHA-256 of the exact bytes sent: identifies the file, not its contents' },
  'ExportJob.filename': { subject: 'none', note: 'the file name the export was sent under (a date, never a customer)' },
  'ExportJob.customerIds': { subject: 'none', note: 'identifiers of the customers the file held; the file itself is never stored' },
  'ExportJob.seq': { subject: 'none', note: 'strict order: the key the nightly seal ranges are read by (gap 28)' },
  'ExportJob.status': { subject: 'none' },
  'ExportJob.r2Key': { subject: 'none', kind: 'image reference' },
  'ExportJob.rowCount': { subject: 'none' },
  'ExportJob.startedAt': { subject: 'none', note: RECORD_META },
  'ExportJob.completedAt': { subject: 'none', note: RECORD_META },
  'ExportJob.errorMessage': { subject: 'none' },

  // ---- AuditLog: append-only, and therefore the hardest to erase from ------
  'AuditLog.id': { subject: 'none', note: STRUCTURAL },
  'AuditLog.actorId': { subject: 'employee', kind: 'identifier', note: 'who did it' },
  'AuditLog.action': {
    subject: 'employee',
    kind: 'behaviour',
    note: 'includes PHOTO_VIEW: which member of staff opened which photo or document (data audit gap 2), read by the Data Steward only; and PRINT: which member of staff printed which customer form or credit application (owner decisions 2026-10-11), read by the Data Steward and, for their regions, Managers',
  },
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
  // Gap 24: stamped by the database from the writer's change context.
  'AuditLog.source': {
    subject: 'none',
    kind: 'identifier',
    note: 'what caused the row: a request, import row, script run or job (lib/change-context.ts), never text a person typed',
  },
  'AuditLog.txId': { subject: 'none', note: 'database transaction id: joins the row to the dated history rows of the same change' },
  'AuditLog.seq': { subject: 'none', note: 'strict order: the key the nightly seal ranges are read by (gap 28)' },

  // ---- AuthEvent (gap 23, part C) ------------------------------------------
  // Sign-in failures on names no account has, throttle refusals, failures on a
  // retired sign-in name, and every session cut-off; append-only, kept for ever.
  // The typed name is NEVER stored: usernameHmac is a keyed fingerprint
  // (HMAC-SHA256 under a key derived from AUTH_SECRET, lib/sign-in-events.ts),
  // so neither a name nor a password typed into the name field can be read back
  // from the table without the application secret.
  'AuthEvent.id': { subject: 'none', note: 'the strict order of the events' },
  'AuthEvent.at': { subject: 'employee', kind: 'behaviour', note: 'when the attempt or the cut-off happened' },
  'AuthEvent.kind': { subject: 'none', note: 'LOGIN_FAIL_UNKNOWN, LOGIN_RATE_LIMITED, LOGIN_FAIL_REUSED_NAME or SESSION_REVOKE' },
  'AuthEvent.userId': { subject: 'employee', kind: 'identifier', note: 'the account concerned, when there is one (no foreign key: the event outlives the account)' },
  'AuthEvent.usernameHmac': {
    subject: 'employee',
    kind: 'identifier',
    note: 'keyed fingerprint of the typed sign-in name — pseudonymous: matching it to a name needs AUTH_SECRET; the name itself is never stored',
  },
  'AuthEvent.keyId': { subject: 'none', note: 'which fingerprint key (first 8 hex of its SHA-256): a rotated AUTH_SECRET gives another' },
  'AuthEvent.reason': { subject: 'none', note: 'a fixed category (not_found, retired_username, ip, user, deactivated, password, role, …), never free text' },
  'AuthEvent.ip': { subject: 'employee', kind: 'device', note: 'source IP of the attempt, as AuditLog.ip' },
  'AuthEvent.userAgent': { subject: 'employee', kind: 'device', note: 'browser and device string, as AuditLog.userAgent' },
  'AuthEvent.actorId': { subject: 'employee', kind: 'identifier', note: 'who cut the sessions off (the change context); null for a sign-in failure' },
  'AuthEvent.source': {
    subject: 'none',
    kind: 'identifier',
    note: 'what caused it (lib/change-context.ts): auth:logout, users:toggle:<id>, import:<batch>:Users!<row>, …',
  },
  'AuthEvent.txId': { subject: 'none', note: 'database transaction id: joins the AuditLog rows of the same change' },
  'AuthEvent.dbUser': { subject: 'none', note: 'the database login that wrote a session cut-off (nmwc_app or the owner role)' },

  // ---- Dated history (gaps 5, 6, 17, 24; docs/HISTORY.md) ------------------
  // Append-only and kept for ever, so it holds NO personal value of a customer:
  // names, phones, CR number, contact, e-mail, notes, address and GPS appear only
  // as a field NAME in changedFields (PDPL-ASSESSMENT Q4). The values kept are
  // business columns, classified as on the live record they copy.
  ...historyCommon('CustomerHistory'),
  'CustomerHistory.customerId': { subject: 'business-or-person', kind: 'identifier' },
  'CustomerHistory.nmwcCode': { subject: 'business-or-person', kind: 'identifier', note: 'the customer code as it was' },
  'CustomerHistory.paymentTerms': { subject: 'business-or-person', kind: 'financial' },
  'CustomerHistory.creditLimit': { subject: 'business-or-person', kind: 'financial' },
  'CustomerHistory.paymentTermDays': { subject: 'business-or-person', kind: 'financial' },
  'CustomerHistory.temixCode': { subject: 'business-or-person', kind: 'identifier' },
  'CustomerHistory.status': { subject: 'business-or-person' },
  'CustomerHistory.channelId': { subject: 'none', note: STRUCTURAL },
  'CustomerHistory.subChannelId': { subject: 'none', note: STRUCTURAL },
  'CustomerHistory.crPhotoId': { subject: 'none', kind: 'image reference', note: 'which CR document was on file' },
  'CustomerHistory.deletedAt': { subject: 'none', note: 'soft-delete marker as it was' },
  'CustomerHistory.mergedIntoId': { subject: 'none', note: 'the customer it had been merged into then; structural' },
  ...historyCommon('BranchHistory'),
  'BranchHistory.branchId': { subject: 'business-or-person', kind: 'identifier' },
  'BranchHistory.branchCode': { subject: 'business-or-person', kind: 'identifier' },
  'BranchHistory.customerId': { subject: 'none', note: STRUCTURAL },
  'BranchHistory.routeId': { subject: 'none', note: 'the route that served the shop then' },
  'BranchHistory.regionId': { subject: 'none', note: STRUCTURAL },
  'BranchHistory.dayOfVisit': { subject: 'business-or-person' },
  'BranchHistory.status': { subject: 'business-or-person' },
  'BranchHistory.deletedAt': { subject: 'none', note: 'soft-delete marker as it was' },
  'BranchHistory.coolersCount': { subject: 'none' },
  'BranchHistory.standsCount': { subject: 'none' },
  'BranchHistory.emptyBottlesCount': { subject: 'none' },
  'BranchHistory.equipmentConfirmed': { subject: 'none' },
  'BranchHistory.hasGps': { subject: 'none', note: 'whether a GPS point was on file; the point itself is never copied' },
  'BranchHistory.shopPhotoId': { subject: 'none', kind: 'image reference' },
  'BranchHistory.signboardPhotoId': { subject: 'none', kind: 'image reference' },
  ...historyCommon('UserHistory'),
  'UserHistory.userId': { subject: 'employee', kind: 'identifier' },
  'UserHistory.username': { subject: 'employee', kind: 'identifier', note: 'as it was: a salesman’s is his route code, retired on hand-over' },
  'UserHistory.role': { subject: 'employee', kind: 'behaviour', note: 'job function then' },
  'UserHistory.isActive': { subject: 'employee', note: 'employment status in this system then' },
  'UserHistory.supervisorId': { subject: 'employee', note: 'reporting line then' },
  'UserHistory.ownedRouteId': { subject: 'employee', note: 'the round this person worked then' },
  'UserHistory.regionIds': { subject: 'employee', note: 'the regions this person administered then' },
  ...historyCommon('RouteOwnerHistory'),
  'RouteOwnerHistory.routeId': { subject: 'none', note: STRUCTURAL },
  'RouteOwnerHistory.ownerId': { subject: 'employee', kind: 'identifier', note: 'who held the round then (null: nobody)' },
  ...historyCommon('RouteHistory'),
  'RouteHistory.routeId': { subject: 'none', note: STRUCTURAL },
  'RouteHistory.code': {
    subject: 'employee',
    kind: 'identifier',
    note: 'as Route.code: doubles as the salesman’s login username',
  },
  'RouteHistory.name': { subject: 'none' },
  'RouteHistory.regionId': { subject: 'none', note: STRUCTURAL },
  'RouteHistory.isActive': { subject: 'none' },
  ...historyCommon('RegionHistory'),
  'RegionHistory.regionId': { subject: 'none', note: STRUCTURAL },
  'RegionHistory.code': { subject: 'none' },
  'RegionHistory.name': { subject: 'none', note: 'geographic area of operations' },
  'RegionHistory.isActive': { subject: 'none' },
  // Lossless paths (20261014100000): photos and documents, and new-customer request rounds.
  ...historyCommon('AttachmentHistory'),
  'AttachmentHistory.attachmentId': { subject: 'none', kind: 'image reference' },
  'AttachmentHistory.kind': { subject: 'none', note: 'which slot or document kind it was' },
  'AttachmentHistory.customerId': { subject: 'none', note: STRUCTURAL },
  'AttachmentHistory.branchId': { subject: 'none', note: STRUCTURAL },
  'AttachmentHistory.branchExtraId': { subject: 'none', note: STRUCTURAL },
  'AttachmentHistory.editId': { subject: 'none', note: STRUCTURAL },
  'AttachmentHistory.deletedAt': { subject: 'none', note: 'when it was removed or replaced, as it was' },
  'AttachmentHistory.hash': {
    subject: 'none',
    note: 'the SHA-256 the phone computed of the image: matches the same picture, cannot show it. The capture GPS is never copied',
  },
  'AttachmentHistory.capturedById': { subject: 'employee', kind: 'identifier', note: 'who took the photo' },
  'AttachmentHistory.capturedAt': { subject: 'employee', kind: 'behaviour', note: 'when this person took it' },
  'EditRevision.id': { subject: 'none', note: 'the strict order of the rounds' },
  'EditRevision.editId': { subject: 'none', note: STRUCTURAL },
  'EditRevision.cycle': { subject: 'none' },
  'EditRevision.process': { subject: 'none' },
  'EditRevision.submittedAt': { subject: 'employee', kind: 'behaviour' },
  'EditRevision.submittedById': { subject: 'employee', kind: 'behaviour', note: 'who sent this round' },
  'EditRevision.paymentTerms': { subject: 'business-or-person', kind: 'financial' },
  'EditRevision.requestedCreditLimit': { subject: 'business-or-person', kind: 'financial' },
  'EditRevision.requestedPaymentTermDays': { subject: 'business-or-person', kind: 'financial' },
  'EditRevision.approvalChain': { subject: 'employee', kind: 'snapshot', note: 'the roles and step order frozen with this round' },
  'EditRevision.payload': {
    subject: 'customer',
    kind: 'snapshot',
    note: 'the round as sent: channel, terms, per shop its route, region, visit day, counts and photo ids, documents by kind; the name, CR number, phones, contact, e-mail, notes, shop name, address, hours and GPS point only as unkeyed SHA-256 fingerprints (lib/fingerprint.ts) — for a short CR number or a phone the value can be recovered by brute force',
  },
  'EditRevision.payloadSha256': { subject: 'none', note: 'SHA-256 of the payload: two rounds that sent the same thing match' },
  'EditRevision.recordedAt': { subject: 'none', note: RECORD_META },
  'EditRevision.source': { subject: 'none', kind: 'identifier', note: 'the request that wrote it (lib/change-context.ts)' },

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
  'EditCustomerDraft.email': { subject: 'customer', kind: 'contact', note: 'credit requests only; copied to Customer.email at finalize' },
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
  'EditBranchDraft.branchId': { subject: 'none', note: 'the shop this draft became at finalize (gap 27); structural' },

  // ---- EditApproval: the per-step decision ledger (append-only) ------------
  'EditApproval.id': { subject: 'none', note: STRUCTURAL },
  'EditApproval.editId': { subject: 'none', note: STRUCTURAL },
  'EditApproval.cycle': { subject: 'none' },
  'EditApproval.stepIndex': { subject: 'none' },
  'EditApproval.role': { subject: 'employee', kind: 'behaviour' },
  'EditApproval.decision': {
    subject: 'employee',
    kind: 'behaviour',
    note: 'what this named person decided: APPROVED, REJECTED, or FORM_UPLOADED (the salesman uploaded the signed credit application, owner decisions 2026-10-11)',
  },
  'EditApproval.actorId': { subject: 'employee', kind: 'identifier' },
  'EditApproval.reason': { subject: 'customer', kind: 'free text' },
  'EditApproval.at': { subject: 'employee', kind: 'behaviour' },
  // Item 9: the stage as it stood when this person decided it — together they say
  // whether a named approver met the SLA, the same class as the SLA columns on
  // CustomerEdit.
  'EditApproval.stageEnteredAt': { subject: 'employee', kind: 'behaviour' },
  'EditApproval.slaDueAt': { subject: 'employee', kind: 'behaviour' },
  'EditApproval.workingMinutes': { subject: 'employee', kind: 'behaviour', note: 'how long this named person took to decide' },
  'EditApproval.category': { subject: 'none', note: 'the send-back reason category picked from a fixed list (gap 12)' },
  // Gap 11 (part C): who decided as what, and why he could, at that moment.
  'EditApproval.actorRole': { subject: 'employee', kind: 'behaviour', note: 'the decider’s own role when he decided' },
  'EditApproval.authorityBasis': {
    subject: 'none',
    note: 'why the decider could decide (lib/permissions.ts AUTHORITY_BASES), a fixed value the database checks',
  },
  'EditApproval.scopeRegionIds': { subject: 'none', note: 'the regions the request covered when decided' },
  'EditApproval.submitterRouteId': { subject: 'none', note: 'the submitting salesman’s route when decided' },
  'EditApproval.seq': { subject: 'none', note: 'strict order: the key the nightly seal ranges are read by (gap 28)' },

  // ---- SealRecord (gap 28: the daily seal of the ledgers; digests and counts only) ----
  'SealRecord.id': { subject: 'none', note: STRUCTURAL },
  'SealRecord.seq': { subject: 'none', note: 'the seal number, 0 = genesis' },
  'SealRecord.day': { subject: 'none', note: 'the Oman day of the run' },
  'SealRecord.formatVersion': { subject: 'none' },
  'SealRecord.prevHash': { subject: 'none', note: 'SHA-256 of the previous seal' },
  'SealRecord.hash': { subject: 'none', note: 'SHA-256 of bodyText' },
  'SealRecord.bodyText': { subject: 'none', note: 'per sealed table: key range, row count and a SHA-256 digest, and the count and digest of the rows waiting for the next seal — never a row' },
  'SealRecord.r2Key': { subject: 'none', note: 'where the off-site copy is: seals/v1/<the chain>/<seq>.json' },
  'SealRecord.snapshotXmax': { subject: 'none', note: 'a database transaction id' },
  'SealRecord.sealedAt': { subject: 'none', note: RECORD_META },
  'SealRecord.source': { subject: 'none', note: 'the change-context source (the nightly job)' },
  'SealRecord.txId': { subject: 'none', note: 'database transaction id' },

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
  // F1 e-mail outbox state (lib/email/drain.ts). Operational values about this
  // row's delivery, never the address, the subject or the text of a message,
  // none of which is stored anywhere in the database.
  'Notification.emailStatus': {
    subject: 'none',
    note: 'outbox state of this row (SENT, FAILED, SKIPPED_* or PRE_FEATURE); no address or message text',
  },
  'Notification.emailAttempts': { subject: 'none', note: 'outbox claim counter' },
  'Notification.emailLeaseUntil': { subject: 'none', note: RECORD_META },
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
