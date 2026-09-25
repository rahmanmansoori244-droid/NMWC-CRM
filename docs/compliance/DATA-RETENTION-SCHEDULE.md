# Data retention schedule

**Status: DRAFT — periods proposed by engineering, to be confirmed by the owner and counsel.**
Created 2026-09-14 (blocker B6).

Two columns matter more than the periods themselves: **Enforced by** and **Proven by**. Before today most of this schedule existed only as prose, and two of the four real rules were dashboard tasks nobody had confirmed. A retention period that nothing implements is not a retention period.

## Schedule

| Data | Kept for | Enforced by | Proven by |
|---|---|---|---|
| Customer and branch records | Indefinite while active; soft-deleted on archive, never purged | — | — |
| Photographs, attached | Indefinite while attached | — | — |
| Photographs, detached or replaced | 30 days, then the row is deleted and the object tagged `gc-marked`; 7 further days, then the bucket expires it | `app/api/cron/photo-gc/route.ts` (daily) + an R2 lifecycle rule on `nmwc-photos` | **[OWNER]** confirm the lifecycle rule exists — `scripts/r2-setup-lifecycle.ts` |
| Append-only ledger (`AuditLog`, `EditApproval`) | **Indefinite, by design.** No application credential can delete a row | Database triggers, migrations `20260914150000` + `20260914160000` | `tests/integration/audit-immutability.test.ts` (CI) |
| Change requests (`CustomerEdit` and its drafts) | Indefinite. Deletable by the owner credential *unless* an approval step exists, which the ledger trigger then blocks | — | — |
| Import payloads (`ImportRow.raw` / `parsed` / `issues` / `corrections`) | A PROMOTED or REJECTED row: 90 days after upload, once its batch is PROMOTED or FAILED. A held-back (QUARANTINED) row: 90 days after the Steward excluded it, whatever the batch's status (item 20). Then the payload — the verbatim spreadsheet copy and any cells corrected in the app — is emptied; the row, its outcome and its exclusion are kept | `app/api/cron/retention-sweep/route.ts` (daily) | `tests/integration/retention-sweep.test.ts` (CI) |
| Notifications, read | 90 days | `app/api/cron/sla-escalate/route.ts` | — |
| Notifications, unread | 180 days | `app/api/cron/retention-sweep/route.ts` | — |
| Login rate-limit rows (username, source IP) | 1 day | `app/api/cron/retention-sweep/route.ts` | — |
| Previous password hashes | Last 5 per user | `services/users.ts` | — |
| Employee accounts | Never deleted; disabled only. Seven `ON DELETE RESTRICT` foreign keys make deletion impossible while the ledger exists | — | — |
| Database dumps (`nmwc-backups`, prefix `db/`) | 30 days | R2 lifecycle rule, **now set and checkable from code** | `npx tsx scripts/ops/r2-backups-lifecycle.ts --check` |
| Neon point-in-time recovery | 7 days | Neon plan setting | — |
| Error telemetry (Sentry) | **[OWNER]** — Sentry org retention, typically 90 days | Sentry | — |
| Application logs (Vercel) | ~1 day on the current plan | Vercel | — |

## Why the rate-limit period is one day and not thirty

The row exists solely to hold token-bucket state — a token count and a refill timestamp. The bucket refills within minutes. Everything after that is a record of which username was tried from which IP address, kept for no operational purpose. One day is already generous.

## What the sweep deliberately does not touch

`AuditLog` and `EditApproval`. They are retained on purpose, and any change to them is an owner-authorised maintenance operation under `SET LOCAL nmwc.audit_maintenance = 'on'` — never a scheduled job. See `docs/OPERATIONS.md` for the maintenance-window procedure and `PDPL-ASSESSMENT.md` Q4 for the erasure question this creates.

## Known gaps, stated rather than hidden

1. **Archiving a customer does not release its photographs.** Soft-deleting a customer and its branches sets `deletedAt` on those records only; `Attachment.deletedAt` is untouched, so the CR documents and shopfront images of an archived customer are never garbage-collected. Fixing this means deciding whether an archived customer's evidence should survive the archive — a business question, not a cleanup bug.
2. **Nothing records what a maintenance window was used for.** By construction: the audit of a ledger edit would live in the ledger being edited. The mitigation is procedural — see the maintenance-window procedure in `docs/OPERATIONS.md`.
3. **Backups defeat erasure for up to 30 days**, and Neon PITR for 7. The standard industry answer is a written backup exception; whether that answer is available under Omani law is **[COUNSEL]** (`PDPL-ASSESSMENT.md` Q5), not something this document should assume.
4. **`SavedView.urlParams` and `CronHeartbeat.lastDetail`** have no retention. Both are small; both can embed a searched name or phone. Listed so they are not forgotten.
5. **Photographs taken for a change request that is never finished are kept forever.** A net-new CREATE uploads its images against `Attachment.editId` before the customer exists, and `services/creates.ts` releases those claimed images only when the *same* edit row is re-submitted. A request left in `DRAFT` or `NEEDS_CORRECTION` therefore keeps its photographs indefinitely — including the commercial registration of a customer that was never created, and a shopfront that may show bystanders. No scheduled job covers this, and adding one needs a period from the owner first: "abandoned" is a judgement about how long a salesman may reasonably leave a correction outstanding, not a technical default.

6. **A held-back import row that is never fixed or excluded keeps its payload indefinitely** — names, phones, CR numbers, addresses. The Work list keeps such a batch in view until every row is fixed or excluded (item 20). A row fixed in the app and waiting in a batch that is never promoted again is not swept either, and nor is the rest of that batch while it waits (the sweep requires a finished batch). Account-master issue rows have no in-app fix at all.

**Settled by the merge fix, so the two are not confused:** merging two duplicate customers *re-parents* the loser's documents to the winner and releases nothing. A merge asserts the two rows are the same legal entity, so the evidence is the surviving customer's. Only gap 1 — the archive — is still an open policy question.
