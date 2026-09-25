# Data residency and processor register

**Status: DRAFT — engineering-prepared inventory. Not signed, not legal advice.**
Created 2026-09-14 (blocker B6). Companion to [`RECORDS-OF-PROCESSING.md`](RECORDS-OF-PROCESSING.md).

## The finding this document exists to record

Roughly 20,100 Omani customer records — names, phone numbers, premises addresses, six-decimal GPS coordinates, commercial-registration numbers and credit terms — together with 106 employee accounts and their password hashes, are processed and stored entirely in the United States. **No residency decision was ever taken.** The deployment region was chosen three times, each time on latency or cost grounds, and the word "residency" appears in no commit message, no configuration comment and no design document before this one:

| When | Change | Stated reason |
|---|---|---|
| — | no region pinned → `fra1` | "~200 ms RTT to Oman vs iad1 ~700 ms" |
| — | `fra1` → `iad1` | "co-locate compute with the Neon database" |
| open | proposal to move to `fra1` + Neon `eu-central-1` | latency |

That is a defensible engineering history and an indefensible compliance one. The purpose of this register is to state the position plainly so the owner can decide it deliberately — before go-live makes the region expensive to change.

## Processors

Data categories use the vocabulary of [`PII-INVENTORY.md`](PII-INVENTORY.md).

| # | Processor | Purpose | Data it holds | Location as configured | Configured at | Contract / DPA |
|---|---|---|---|---|---|---|
| P1 | **Vercel Inc.** | Hosts the application: every server action, render, API route and the build | All personal data, in transit and in memory; runtime logs | `iad1` — US East (N. Virginia) | `vercel.json` | **[OWNER]** |
| P2 | **Neon Inc.** | Managed PostgreSQL — the system of record | Everything: customer master, employee accounts, the append-only ledger | `us-east-1` — US East | `docs/OPERATIONS.md` §1 | **[OWNER]** |
| P3 | **Cloudflare, Inc.** — bucket `nmwc-photos` | Photographs of premises, signboards, CR and guarantee documents | Images; object keys embedding employee id and date | **Not recorded.** `region: 'auto'` in `lib/r2.ts` is an S3-protocol placeholder and says nothing about where the bucket lives | `lib/r2.ts` | **[OWNER]** |
| P4 | **Cloudflare, Inc.** — bucket `nmwc-backups` | Nightly dump of the whole database — **plaintext today**, encryption pending the age key | A complete copy of every category above | **Not recorded** — same as P3 | `.github/workflows/db-backup.yml` | **[OWNER]** |
| P5 | **GitHub, Inc. (Microsoft)** | Source control, CI, and the runner that takes the nightly dump | The **entire database** transits a GitHub-hosted runner every night; repository secrets include the owner database credential | Runner region is not selectable on this plan and is **not knowable** | `.github/workflows/` | **[OWNER]** |
| P6 | **Functional Software, Inc. (Sentry)** | Error and performance telemetry | Exception messages, request URLs and bodies, breadcrumbs, **and performance transactions with their span data** — scrubbed of phone numbers, e-mail addresses and the customer search term before they leave the process (`lib/scrub.ts`, `lib/sentry-scrub.ts`). Name redaction is the `q` search parameter specifically, not free text: a customer's legal name written into an error message is not removed | **Undetermined from the repository.** The CSP permits the legacy non-regional host and both regional ones — it listed only the EU regional host until 2026-09-15, which would have made every browser report silently refused if the DSN pointed at a US project. The region is fixed by the DSN, which is an environment variable, so **[OWNER]** must say which region this project is in: the CSP is now permissive enough for either, and the register cannot state where the telemetry lands until someone reads the DSN | `next.config.ts`, Vercel env | **[OWNER]** |
| P7 | **External cron vendor** — *not yet chosen* | Will call two authenticated production endpoints on a schedule (decision D3) | No customer data in the request, but it holds a production bearer token | **[OWNER]** | `docs/OPERATIONS.md` §5d | **[OWNER]** |
| P8 | **Temix (ERP)** | Receives the approved customer master as a workbook | The full customer master, recurrently | **[OWNER]** — where it runs and who operates it | `lib/temix.ts` | **[OWNER]** |

### Not processors, but worth recording

- **Google** — the customer and approval pages, the Today and Customers lists, and the field-update workbook contain Google Maps hyperlinks: pins (`https://www.google.com/maps?q=<lat>,<lng>`) and, since 2026-09-25, Directions (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`). All of them are built in `lib/contact-links.ts`. They are inert until a person clicks one; there is no Maps API key, no embed and no automatic request. It is a user-initiated disclosure of one premises location, not a processing relationship. It still means a manager who taps "map" tells Google where that shop is, and anyone the workbook is forwarded to can do the same. A Directions link carries no origin, but Google Maps plots the route from wherever the device is, under that device's own Google location permission. The Customers list shows these links for every customer in the viewer's scope, which is the whole organisation for Steward, Viewer, Finance Manager and GM (owner decision, 2026-09-25).
- **The Steward's own device** — the Temix workbook is downloaded, carried and uploaded by a person. That copy is outside every control in this system.

## Where the plaintext actually is

Encrypting the nightly dump (B3, 2026-09-14) narrows one exposure and should not be mistaken for closing the problem:

- The dump is written **in plaintext to a GitHub-hosted runner's disk** before it is encrypted. Encryption protects the object at rest in R2 and in transit; it does not remove GitHub from the data path.
- `DIRECT_URL` — the database owner credential, full read and write on production — is an ordinary repository secret available to workflows. Anyone who can land a workflow change on this repository can read the entire database. Branch protection and required reviews are the control for that, not encryption. **[OWNER]** — state whether branch protection is enabled on `main`.

## Open owner actions

1. **Record both R2 bucket locations.** Cloudflare dashboard → bucket → Settings → Location. The hint is set at creation and cannot be changed afterwards; record the value and the date read.
2. **Record the Sentry data region** from the production DSN host or the Sentry org settings.
3. **Name the account holder of record for every vendor**, and transfer them to NMWC SAOG if they are personal accounts.
4. **Name the cron vendor** before pasting a production secret into it, and give it its own secret rather than sharing `CRON_SECRET` with the backup reporting endpoint.
5. **State where Temix runs** and who operates it.
6. **Decide residency** — see `PDPL-ASSESSMENT.md` Q1. If in-country or in-region processing is required, the cost is a full database and object-store migration, and it is far cheaper before the go-live data load than after.

## Verification

Claims in this register that the repository can check are checked:

| Claim | Checked by |
|---|---|
| Dumps under `db/` expire after 30 days | `npx tsx scripts/ops/r2-backups-lifecycle.ts --check` |
| Every database column is classified | `tests/unit/pii-classification.test.ts` (CI) |
| The scrubber removes phones, e-mail and the search term from telemetry, on the error **and** the transaction channel, in all three runtimes | `tests/unit/sentry-scrub.test.ts` (CI) |
| The audit ledger cannot be edited by the application | `tests/integration/audit-immutability.test.ts` (CI) |
| Backups are restorable | `.github/workflows/restore-drill.yml` (monthly), `restore-chain` job in CI (every push) |

## Signature

| Role | Name | Date | Signature |
|---|---|---|---|
| Controller representative (NMWC) | | | |
| System owner | | | |
