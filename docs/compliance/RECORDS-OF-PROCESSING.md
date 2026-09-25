# Records of processing activities

**Status: DRAFT — prepared by engineering, not yet reviewed by counsel or signed by the controller.**
Created 2026-09-14 to close blocker B6 of `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`.

## What this is, and what it is not

The assessment asked for "a one-page Data Residency & Processor Register". A register answers *where* data sits. It cannot answer *why we hold it, on what basis, who else sees it, for how long, and whether we may lawfully send it abroad* — and those are the questions this deployment is actually exposed on. So the artefact is split:

| Document | Answers | Who owns it |
|---|---|---|
| **This file** | What processing happens, for what purpose, on whose data, who receives it | Owner + counsel |
| [`DATA-RESIDENCY-REGISTER.md`](DATA-RESIDENCY-REGISTER.md) | Which third parties hold the data and in which country | Owner |
| [`DATA-RETENTION-SCHEDULE.md`](DATA-RETENTION-SCHEDULE.md) | How long each category is kept and what enforces that | Engineering, owner signs |
| [`PDPL-ASSESSMENT.md`](PDPL-ASSESSMENT.md) | The open legal questions, with the engineering facts each one needs | Counsel |
| [`PII-INVENTORY.md`](PII-INVENTORY.md) | Which database column holds whose personal data (generated, CI-checked) | Engineering |

Everything below marked **[OWNER]** is a blank the repository cannot fill. Leaving them blank is the honest state; filling them with plausible text would make this document worse than useless.

## The controller and the systems

- **Controller:** National Mineral Water Company SAOG ("NMWC"), Oman. *(`docs/PROJECT-DESCRIPTION.md`)*
- **System:** NMWC Unified CRM — the customer master for the bottled-water distribution business, feeding the Temix ERP.
- **Scale:** ~20,100 customer branches across ~3,300 customers; ~106 employee accounts.
- **[OWNER] Contracting party per vendor.** Every vendor account in use (Vercel, Neon, Cloudflare, GitHub, Sentry) appears to be held by an individual rather than by NMWC SAOG. A processor record is only meaningful if the controller is a party to the contract. State, per vendor, who holds the account of record and whether it is being transferred to the company. Until this is answered, no row in the residency register can cite a controller-to-processor contract.
- **[OWNER] Human access list.** Who holds production credentials today (Vercel, Neon, Cloudflare, GitHub, Sentry, the owner database URL), and under what instrument external contributors are bound.

## Data subjects

Three populations, not one. The third is routinely forgotten.

1. **Customer-side contacts** — the named contact person at each shop and the phone numbers that in practice are that person's mobile. ~20,100 branch records.
2. **Employees** — ~106 salesmen, managers and administrators. The system records not only their identity and credentials but their *activity*: every action with a timestamp, and — for anything done through the application — the source IP and device string with it (`AuditLog`), where they were standing when they photographed a shop (`Attachment.capturedLat/Lng`), and whether they met each approval deadline (`CustomerEdit.slaBreachedAt`, `escalationLevel`). That is employee monitoring, and it should be named as such rather than described as an audit trail.
3. **Bystanders** — shopfront and signboard photographs are taken in public by salesmen on phones. They routinely include passers-by and vehicle number plates. These people have no relationship with NMWC, were not informed, and are not searchable — so in practice their images can be neither found nor removed on request.

**[OWNER]** Were employees told what this system records about them? Were customers told their data is held in this CRM and transferred to a US-hosted database?

## Processing activities

Retention periods are the ones the system actually enforces — see `DATA-RETENTION-SCHEDULE.md`. "Lawful basis" is deliberately left for counsel: an engineer asserting a basis is the single most common way a document like this becomes misleading.

### A1 — Maintain the customer master

| | |
|---|---|
| **Purpose** | Hold an accurate record of every customer and branch NMWC delivers to: identity, location, contact, commercial terms. |
| **Personal data** | Contact person and role; primary and alternate phone; premises address, area description and GPS to six decimals; free-text notes. Entity-level and personal only for sole establishments: legal name, CR number, credit limit and payment terms. |
| **Subjects** | Customer contacts; customer entities. |
| **Source** | Migrated from RoutePro and the Temix ERP at go-live; thereafter field capture by salesmen and Steward-run spreadsheet imports. |
| **Recipients** | NMWC staff, scoped by region and role (`lib/permissions.ts`, `lib/access.ts`). Exported to the Temix ERP as a workbook (A5). |
| **Retention** | Indefinite while the customer is active; soft-deleted on archive with no purge today. |
| **Lawful basis** | **[COUNSEL]** |

### A2 — Change requests and multi-step approval

| | |
|---|---|
| **Purpose** | Control who may change a customer record, and record who approved a credit limit or payment terms. |
| **Personal data** | Before/after snapshots of every field in A1 (`CustomerEdit.fieldChanges`, and a second copy in `AuditLog.before/after`); the approver's identity, role, decision, reason and timing; and, for a GPS point the salesman typed in by hand, the salesman's own free-text reason (since 2026-09-25, item 41), which may name people — kept in `CustomerEdit.fieldChanges` and, once an update is approved, copied into that `APPROVE` row's `AuditLog.after`. |
| **Subjects** | Customer contacts; employees (as approvers and submitters, and as the authors of a manual-GPS reason). |
| **Recipients** | NMWC staff in the approval chain. |
| **Retention** | Indefinite. `AuditLog` and `EditApproval` are **append-only at the database** (migrations `20260914150000`, `20260914160000`) and cannot be edited or deleted by any application credential. |
| **Lawful basis** | **[COUNSEL]** — and specifically whether the evidential purpose justifies retaining customer identifiers in a ledger that cannot be edited. See `PDPL-ASSESSMENT.md` Q4. |

### A3 — Photographic evidence of premises and documents

| | |
|---|---|
| **Purpose** | Prove a branch exists at the recorded location; hold the commercial-registration and credit-guarantee documents behind a credit decision. |
| **Personal data** | Images of shopfronts, signboards, CR documents and guarantees; the capturing employee's identity, timestamp and device GPS; bystanders visible in the frame. |
| **Subjects** | Customer entities; employees; bystanders. |
| **Recipients** | NMWC staff, scope-checked per image; the image bytes are served through an authenticated proxy, never a public URL. |
| **Storage** | Cloudflare R2 bucket `nmwc-photos`. **Not covered by the database backup** — see `docs/OPERATIONS.md` §6. |
| **Retention** | Indefinite while attached; 30 days after detach, then bucket lifecycle expiry. |
| **Lawful basis** | **[COUNSEL]** — including the bystander question. |

### A4 — Workforce administration and monitoring

| | |
|---|---|
| **Purpose** | Authenticate staff, enforce role and region scoping, and evidence who did what. |
| **Personal data** | Username (the route code for salesmen), full name, e-mail, phone, bcrypt password hash and the last five previous hashes, last-login time, every audited action — with source IP and user-agent for anything done through the application — SLA timings and escalation counts, and device GPS attached to each photo. |
| **Subjects** | Employees. |
| **Recipients** | Stewards and managers within scope. |
| **Retention** | Accounts are disabled, never deleted — seven `ON DELETE RESTRICT` foreign keys make deletion impossible without first removing the append-only ledger. |
| **Lawful basis** | **[COUNSEL]** — employment-context processing and monitoring. |

### A5 — Export to the Temix ERP and to spreadsheets

| | |
|---|---|
| **Purpose** | Load approved customers into the ERP; give managers a working copy of their region's master. |
| **Personal data** | The full A1 set, as an `.xlsx` workbook. The field-update report additionally embeds each branch's coordinates as a clickable Google Maps link. |
| **Recipients** | **Temix** (the ERP) — a recipient of the entire customer master, by design, on a recurring basis. **[OWNER]** State where Temix runs, who operates it, and under what agreement. The workbook is carried between systems by a Steward, so a copy also exists on that person's device. |
| **Retention** | The CRM keeps only a record that an export happened (`AuditLog`, action `EXPORT`); copies outside the system are uncontrolled. |
| **Lawful basis** | **[COUNSEL]** |

### A6 — Operating the service

| | |
|---|---|
| **Purpose** | Run, monitor, back up and support the application. |
| **Personal data** | Error telemetry (scrubbed of phone numbers and e-mail addresses before it leaves the process — `lib/scrub.ts`, applied in all three Sentry runtimes); application logs; login rate-limit state keyed on username and source IP; a nightly encrypted dump of the entire database. |
| **Recipients** | Vercel, Neon, Cloudflare, GitHub, Sentry — see `DATA-RESIDENCY-REGISTER.md`. |
| **Retention** | Rate-limit rows 1 day; dumps 30 days; Sentry per its own org setting **[OWNER]**; Vercel logs ~1 day. |
| **Lawful basis** | **[COUNSEL]** |

**The rows the ledger cannot attribute to a device.** Eight maintenance scripts write
`AuditLog` directly: the bulk credential reset, the synthetic-data wipe and its
cleanup, the branch flatten, the go-live account bootstrap, the least-privilege role
probe (whose insert is rolled back and is not an audit record at all), and three
go-live corrections that each write a STARTING row before their first chunk and a
COMPLETED row after their last, so an interrupted run is visible as a STARTING with no
COMPLETED beside it — the Temix requeue (`scripts/ops/requeue-untracked.ts`), the
credit-limit zeroing (`scripts/ops/zero-credit-limits.ts`) and the quarantined
visit-day apply (`scripts/ops/apply-quarantined-visit-days.ts`). An operator runs
these by hand against the database rather than through the application, so there is
no request to read an address or a device string from. On those rows `ip` and
`userAgent` are null **by construction, not by omission**, and a reader of the ledger
should not read a blank there as a gap in the record. Each such row still names a
real accountable person in `actorId` and carries a `reason` describing what was run.
Every other row is written by a single function, `writeAudit()` in `lib/audit.ts`,
which always populates both columns; a lint rule in `eslint.config.mjs` and
`tests/unit/audit-guard.test.ts` are what keep that true as the code changes.

## Cross-border transfer

Every activity above is processed outside Oman. There is no in-country component. The destinations, and what the repository can and cannot say about each, are in `DATA-RESIDENCY-REGISTER.md`. Whether that transfer is lawful, and on what mechanism, is **[COUNSEL]** — question Q1 in `PDPL-ASSESSMENT.md`.

## Signature

This document is not effective until signed.

| Role | Name | Date | Signature |
|---|---|---|---|
| Controller representative (NMWC) | | | |
| Legal counsel | | | |
| System owner | | | |
