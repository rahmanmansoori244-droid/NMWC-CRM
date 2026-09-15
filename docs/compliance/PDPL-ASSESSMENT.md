# Oman PDPL — applicability questions and the facts counsel needs

**Status: NOT A LEGAL OPINION.** This was written by the engineer who built the system. It contains no legal conclusions and deliberately leaves every legal question open. Its purpose is to put the technical facts in front of counsel in the form the questions actually need, so that an opinion can be produced quickly and against accurate premises.

Created 2026-09-14 to close blocker B6 of `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`, which recorded: *"whether Oman RD 6/2022 binds this dataset: Not Verified — the repo shows it was never asked."*

Read with [`RECORDS-OF-PROCESSING.md`](RECORDS-OF-PROCESSING.md) (what we do), [`DATA-RESIDENCY-REGISTER.md`](DATA-RESIDENCY-REGISTER.md) (where it goes), [`DATA-RETENTION-SCHEDULE.md`](DATA-RETENTION-SCHEDULE.md) (how long we keep it) and [`PII-INVENTORY.md`](PII-INVENTORY.md) (which column holds what).

---

## Q1 — Does the Personal Data Protection Law bind this processing, and is the cross-border transfer lawful?

**Facts.** The controller is an Omani company. The subjects are Omani customers and Omani employees. Every byte is processed outside Oman: application compute in `iad1` (US East), the database in Neon `us-east-1`, photographs and backups in two Cloudflare R2 buckets whose location is not recorded, error telemetry in a Sentry region determined by an environment variable, and a nightly copy of the whole database transiting a GitHub-hosted runner in an unknowable region. No in-country component exists. No transfer mechanism has been put in place, because no one asked whether one was needed.

**Needed from counsel.** Whether the law applies; if so, what mechanism legitimises the transfer to each destination; and whether any category here (employee monitoring data, credit information, identity documents) attracts a stricter rule.

**What turns on the answer.** If in-country or in-region processing is required, remediation is a full database and object-store migration. It is materially cheaper before the go-live data load than after — see "Timing" below.

## Q2 — Are the ~20,100 customer records personal data, and in what proportion?

**Facts.** `Customer` is modelled as a legal entity: legal name, commercial-registration number, credit limit, payment terms. The unambiguously personal fields are narrower — `contactPerson`, `contactRole`, `primaryPhone`, `altPhone`, the premises location, and free-text `notes`. But a sole establishment registered to a named individual is a very common form in Omani retail, and for those customers the legal name and CR number *are* the owner's personal data.

**The system cannot tell the two apart.** There is no legal-form field on `Customer`. Everything that depends on the distinction — how many data subjects exist, which records a subject-access request must return — is therefore unanswerable today.

**Needed from counsel and the owner.** Whether sole-establishment customers are in scope, and (from the Temix or commercial-registration data) what proportion of the master they represent. If the distinction matters, a `legalForm` field and a migration are a small change; the classification of the existing 3,300 customers is the real work.

## Q3 — What must employees and customers have been told?

**Facts.** The system records, per employee: every action with a timestamp, and — for anything done through the application — the source IP and browser string with it (the exception is a handful of maintenance scripts an operator runs directly against the database, where there is no request to read either from; see §A6 of `RECORDS-OF-PROCESSING.md`); the device GPS at each photograph; and whether each approval deadline was met, with an escalation counter. That is workforce monitoring, whatever it is called internally. Per customer: identity, location to six decimals, contact person and commercial terms, plus photographs of the premises. Bystanders appear in shopfront photographs, were not informed, and cannot be located or removed on request because the images are not indexed by the people in them.

**Needed from counsel.** Notice and, if applicable, consent requirements for each population, including the bystanders.

## Q4 — How is an erasure request satisfied against an append-only ledger?

This is the hardest question in the system and it was created deliberately.

**Facts.**
- Blocker B4 (closed 2026-09-14) made `AuditLog` and `EditApproval` append-only *at the database*. `UPDATE`, `DELETE` and `TRUNCATE` raise `insufficient_privilege` for every connection, including the owner's, unless a transaction first sets `nmwc.audit_maintenance = 'on'` **and** the session logged in as the table owner. The application credential (`nmwc_app`) cannot do this at all — not directly, and not through the `CustomerEdit` cascade.
- `AuditLog.before` / `.after` contain full field snapshots: legal name, CR number, both phone numbers, contact person, notes, address and GPS. The same values appear again in `CustomerEdit.fieldChanges`, and a third time in `ImportRow.raw`.
- The application has **no hard delete** for a customer, branch or user. Archiving sets `deletedAt`. A user cannot be deleted at all: seven `ON DELETE RESTRICT` foreign keys pin the row, and the first of them points at the ledger.

**The consequence, stated plainly.** Pseudonymising a customer record does not make that person unidentifiable. Their name and phone number remain readable in the ledger, joined to the customer id. Only an owner-credential maintenance transaction can reach them, and doing so is exactly the tamper action the ledger exists to prevent.

**Needed from counsel.** Whether the ledger may be retained despite an erasure request and on what footing; whether pseudonymising the live record while retaining the ledger is an acceptable response; and if the ledger must be edited, what record of that edit is required — noting that by construction it cannot be recorded inside the ledger itself.

**Deliberately not built yet.** An erasure script would encode the answers to all of the above — which fields to blank, which rows to leave, what tombstone values to write. Writing it before counsel rules would make an engineering guess into the company's de-facto policy the first time it ran. The mechanics are documented; the tool waits for the ruling.

## Q5 — Do backups defeat erasure, and is the usual exception available here?

**Facts.** A dump taken before an erasure still contains the data. Dumps are kept 30 days; Neon point-in-time recovery covers 7. Since 2026-09-14 each dump is written to its own timestamped key, so dumps are effectively write-once and are not selectively editable. **They are NOT yet encrypted at rest**: the workflow encrypts to the recipients in the `BACKUP_AGE_RECIPIENTS` repository variable, and that variable has not been created, so every dump currently in the bucket is plaintext (runbook §0 step 10).

**Needed from counsel.** Whether the standard formulation — erasure applied to live systems immediately, backups not selectively edited, the erasure re-applied if a backup is ever restored — is acceptable under Omani law, or whether something else is required.

## Q6 — Who is the controller's counterparty for each processor?

**Facts.** Every vendor account appears to be held by an individual rather than by NMWC SAOG. A processor relationship the controller is not a party to is not a processor relationship.

**Needed from the owner.** The account holder of record per vendor, and whether each is being transferred to the company.

---

## Timing

The go-live data load has **not** been executed: production still holds May seed data. Until it runs, the customer master is not yet in a US database at scale, and a residency decision can still be implemented by changing where the system is deployed rather than by migrating live data. After the load, the same decision becomes a cutover.

This is the one point in the project where Q1 is cheap to answer.

## What engineering has already done, so counsel need not ask

| Control | Where | Proven by |
|---|---|---|
| Every database column classified by subject | `lib/compliance/pii-classification.ts` | `tests/unit/pii-classification.test.ts` (CI) |
| Telemetry scrubbed of phone numbers and e-mail in all three runtimes | `lib/scrub.ts`, `lib/sentry-scrub.ts` | `tests/unit/sentry-scrub.test.ts` (CI) |
| Audit ledger tamper-proof against the application credential | migrations `20260914150000`, `20260914160000` | `tests/integration/audit-immutability.test.ts` (CI) |
| Exports attributable — "who exported the master" answerable | `services/exports.ts`, `services/customer-export.ts` | `AuditLog` action `EXPORT` |
| Retention enforced by a job, not a document | `app/api/cron/retention-sweep/route.ts` | `DATA-RETENTION-SCHEDULE.md` |
| Backups encrypted, restorable and proven restorable | `.github/workflows/db-backup.yml`, `restore-drill.yml` | `restore-chain` job in CI, monthly drill |
| Backup retention actually configured | `scripts/ops/r2-backups-lifecycle.ts --check` | on demand |
