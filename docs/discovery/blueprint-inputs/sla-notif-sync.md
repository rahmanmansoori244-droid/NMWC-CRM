# Design: SLA / Escalation + Notifications + Temix Batch Sync

**Blueprint area 3 — against the NEW base (`C:\Users\abdulr\Desktop\NMWC-CRM`, worktree `.claude/worktrees/nmwc-crm-consolidation-e10c1e`, HEAD `c612c79`).**
All file:line references are to the NEW repo unless prefixed `OLD:` (= `C:\Users\abdulr\Desktop\ICO\customer-portal`).
Tags: **[Confirmed]** = read in code today · **[Proposed]** = this design · **[Open]** = needs a business decision.

---

## 0. Current state (what exists / what is absent)

| Capability | Today | Evidence |
|---|---|---|
| SLA / due-times / escalation | **Absent.** `CustomerEdit` has only `submittedAt`/`reviewedAt`, used for ordering | `prisma/schema.prisma:352-381` [Confirmed] |
| Aging on approval queue | Raw wall-clock `ageHours` computed inline (counts nights/Fridays against the reviewer), no threshold/badge/SLA sort | `app/(app)/approvals/page.tsx:66-69`; `orderBy submittedAt asc` at `:59` [Confirmed] |
| Notifications (in-app or email) | **Absent.** No Notification model, no mailer dependency in `package.json`; reviewers discover work only via queue pages + `revalidatePath` | `package.json` deps list; new-rules.md §M [Confirmed] |
| Cron mechanism A (Vercel) | Daily `photo-gc` at 03:00 UTC only; **Hobby plan rejects sub-daily schedules** | `vercel.json:9-13`; `.github/workflows/keep-warm.yml:8-9` comment [Confirmed] |
| Cron mechanism B (GitHub Actions) | `keep-warm` every 4 min 03:00–15:00 UTC; `db-backup` daily 02:00 UTC — both curl a **GET** route with `Authorization: Bearer $PROD_CRON_SECRET` | `.github/workflows/keep-warm.yml:17-45`, `.github/workflows/db-backup.yml:18-22` [Confirmed] |
| Cron route auth pattern | `CRON_SECRET` + length-check + `timingSafeEqual` (B-16) | `app/api/cron/photo-gc/route.ts:30-44`; duplicated in `app/api/cron/keep-warm/route.ts:38-50` [Confirmed] |
| PII-safe logging | pino `redact` paths (`*.email`, `*.phone`, `*.crNumber`…) + free-text `scrubString` (phones/emails) | `lib/logger.ts:3-16,27-48` [Confirmed] |
| Excel out | `buildWorkbook` (exceljs) with formula-injection escaping (QA-021) | `lib/excel.ts:81-105` [Confirmed] |
| Excel in | `parseWorkbook` + Steward import parse→quarantine→promote pipeline | `lib/excel.ts:15-69`; `services/imports.ts` [Confirmed] |
| Customer export shape | One row per branch, snake_case columns mirroring the import sheet | `services/exports.ts:118-168` [Confirmed] |
| Temix awareness | **Zero.** `grep -ri temix` over `app/ lib/ services/ prisma/` hits only `docs/discovery/*` — no `temixCode` field, no HTTP client, no sync state | grep-negative [Confirmed] |
| OLD SLA concept | Working-hours calendar + `slaDeadline`/`isSlaBreached`; supervisor 8h / accountant 9h; **cron never fired (BUG-03: `sla-check` route is POST-only, Vercel cron sends GET)**; hour math uses server-local timezone | OLD:`lib/sla.ts:1-156`; OLD:`lib/constants.ts:225-227`; OLD:`app/api/cron/sla-check/route.ts` [Confirmed] |
| OLD notification shape | In-app DB rows only (`prisma.notification.create`); nodemailer present but never wired | OLD:`lib/notifications.ts:14-164`; old-rules.md §K [Confirmed] |
| Customer soft-delete | No dedicated action yet — only merge sets `deletedAt` on the loser | `services/duplicates.ts:260` [Confirmed] |
| Audit taxonomy gap | Exports audited as `action: 'IMPORT'` ("no EXPORT in our enum yet") | `services/exports.ts:179` [Confirmed] |

**Interlock with other design areas.** The locked CASH/CREDIT create workflows introduce multi-stage approval (Salesman→Supervisor→[Finance Manager→GM]→Accountant). This document assumes the workflow/approval-engine area extends `CustomerEdit` (or a sibling model) with a notion of *current pending stage*. Everything below binds to a minimal `pendingRole` column so it works whether that area keeps `CustomerEdit` or adds an `ApprovalStep` table — the SLA/notification/sync hooks attach to "a stage was entered / left", not to a specific engine shape. [Proposed — coordinate field names with the approval-engine design.]

---

## 1. SLA & escalation

### 1.1 Working-hours calendar — `lib/working-hours.ts` [Proposed]

Port the OLD concept (OLD:`lib/sla.ts:83-113` `slaDeadline`, `:118-127` `isSlaBreached`, `:132-155` `formatSlaStatus`) but fix two defects:

1. **Timezone bug [Confirmed in OLD]:** OLD uses `getHours()`/`getDay()` on server-local time (OLD:`lib/sla.ts:16-18` via date-fns). On Vercel that is UTC, so "08:00–17:00" actually meant 12:00–21:00 Oman. Fix: compute against a fixed Oman offset. Oman is UTC+4 with **no DST**, so a constant offset is correct and avoids a tz library:

```ts
// lib/working-hours.ts  [Proposed]
const TZ_OFFSET_MIN = Number(process.env.WORK_TZ_OFFSET_MIN ?? 240); // Asia/Muscat = UTC+4, no DST
const WORK_DAYS = new Set((process.env.WORK_DAYS ?? '0,1,2,3,4,6').split(',').map(Number)); // Sun–Thu + Sat; Fri off (OLD default)
const WORK_START = Number(process.env.WORK_HOUR_START ?? 8);   // 08:00 Oman
const WORK_END   = Number(process.env.WORK_HOUR_END ?? 17);    // 17:00 Oman

// Shift to "Oman wall clock expressed in UTC fields", then use getUTCDay/getUTCHours.
function toLocal(d: Date): Date { return new Date(d.getTime() + TZ_OFFSET_MIN * 60_000); }

/** Closed-form, minute-precision deadline: walk whole working days, not 1-hour loops. */
export function slaDeadline(start: Date, slaMinutes: number): Date { /* skip to next working window, subtract per-day capacity (WORK_END-WORK_START)*60 */ }
export function isBreached(dueAt: Date, now = new Date()): boolean { return now > dueAt; }
export function minutesRemaining(dueAt: Date, now = new Date()): number { /* working-minutes between now and dueAt; negative if overdue */ }
```

2. **Precision/perf:** OLD's `advanceOneWorkingHour` iterates hour-by-hour with a `safety < 200` loop (OLD:`lib/sla.ts:28-50`) and only counts whole hours. Replace with a deterministic closed-form walk — unit-testable (vitest exists: `package.json` `"test": "vitest run"`), minute precision.

**SLA policy = constants with env override, not a table** [Proposed] — same approach as OLD (`constants.ts:225-227`) and NEW's existing env-driven knobs. A `SlaPolicy` table is v2 if the business later wants per-region calendars/holidays.

```ts
// lib/sla-policy.ts  [Proposed]
export const STAGE_SLA_MINUTES: Record<string, number> = {
  SUPERVISOR:      Number(process.env.SLA_SUPERVISOR_MIN ?? 8 * 60),   // OLD parity
  ACCOUNTANT:      Number(process.env.SLA_ACCOUNTANT_MIN ?? 9 * 60),   // OLD parity
  FINANCE_MANAGER: Number(process.env.SLA_FINANCE_MIN ?? 16 * 60),     // [Open] value
  GM:              Number(process.env.SLA_GM_MIN ?? 24 * 60),          // [Open] value
  MANAGER:         Number(process.env.SLA_MANAGER_MIN ?? 16 * 60),     // reactivation approvals — [Open] whether SLA'd in v1 (recommend yes)
};
export const ESCALATION_MULTIPLIER = 2; // level-2 escalation at 2× SLA [Open]
```

### 1.2 Schema — SLA fields on the pending work item [Proposed]

Add to `CustomerEdit` (`prisma/schema.prisma:352-381`). The reactivation flow already rides `CustomerEdit` (`services/reactivations.ts:129-215` creates a SUBMITTED edit), so one set of columns covers both queues:

```prisma
model CustomerEdit {
  // ... existing fields ...
  pendingRole     Role?      // which role must act NOW; null once decided / for drafts
  stageEnteredAt  DateTime?  // when the current stage began (submit, or previous-stage approve)
  slaDueAt        DateTime?  // slaDeadline(stageEnteredAt, STAGE_SLA_MINUTES[pendingRole])
  escalationLevel Int        @default(0)  // 0 on time · 1 breached+escalated · 2 at 2× SLA
  escalatedAt     DateTime?

  @@index([state, slaDueAt])        // escalation scan + queue sort
  @@index([pendingRole, state])     // per-role queues for finance/GM stages
}
```

Migration SQL (idempotent, matching the hand-written-SQL house style noted in new-data.md §5):

```sql
-- 20260715xxxxxx_sla_notifications/migration.sql
ALTER TABLE "CustomerEdit"
  ADD COLUMN IF NOT EXISTS "pendingRole" "Role",
  ADD COLUMN IF NOT EXISTS "stageEnteredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "slaDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalationLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "CustomerEdit_state_slaDueAt_idx" ON "CustomerEdit"("state","slaDueAt");
CREATE INDEX IF NOT EXISTS "CustomerEdit_pendingRole_state_idx" ON "CustomerEdit"("pendingRole","state");
-- Backfill open queue so the escalation job doesn't mass-fire on day 1:
UPDATE "CustomerEdit" SET "pendingRole"='SUPERVISOR', "stageEnteredAt"="submittedAt"
  WHERE "state"='SUBMITTED' AND "pendingRole" IS NULL;
-- slaDueAt backfill runs in a one-off tsx script (needs the working-hours calendar, not SQL).
```

**Write points (exact edits):**
- `submitEditCore` — the queued-create at `services/edits.ts:452-464`: add `pendingRole: Role.SUPERVISOR, stageEnteredAt: submittedAt, slaDueAt: submittedAt ? slaDeadline(submittedAt, STAGE_SLA_MINUTES.SUPERVISOR) : null` to the `customerEdit.create` data (drafts get null; draft→submit promotion stamps the same way).
- `approveEditCore` — inside the atomic claim at `services/edits.ts:767-780`: today it flips SUBMITTED→APPROVED terminally. Under multi-stage, a **non-final** approve instead advances `pendingRole`; in the same `updateMany` set `stageEnteredAt: new Date()`, `slaDueAt: slaDeadline(...next stage...)`, `escalationLevel: 0`, `escalatedAt: null`. Final approve nulls `pendingRole`/`slaDueAt`.
- `rejectEditCore` — the update at `services/edits.ts:959-968`: add `pendingRole: null, slaDueAt: null` (NEEDS_CORRECTION stops the clock; the salesman's rework is not SLA-tracked in v1 — [Open] if a resubmit SLA is wanted).
- `markBranchClosedAction` / `requestReactivationAction` (`services/reactivations.ts:129-215`, `:34-123`): stamp `pendingRole` = SUPERVISOR (close) / MANAGER (reactivation — MANAGER-only approve per `services/reactivations.ts:225`) + due time.

### 1.3 Escalation job — GitHub-Actions cron → GET route [Proposed]

**Mechanism decision: GitHub Actions, not Vercel cron.** Vercel Hobby rejects sub-daily schedules [Confirmed — `keep-warm.yml:8-9`; only daily photo-gc lives in `vercel.json:9-13`]. Escalation needs sub-daily resolution. Reuse the keep-warm pattern exactly (`keep-warm.yml:17-45`): scheduled curl with `Authorization: Bearer ${PROD_CRON_SECRET}` (GitHub secret mirroring Vercel's `CRON_SECRET`, `keep-warm.yml:14-15,35`). Note GH-Actions schedules can lag 5–15 min — acceptable against an 8-working-hour SLA; do not promise minute-exact escalation.

```yaml
# .github/workflows/sla-escalate.yml  [Proposed]
name: SLA escalation sweep
on:
  schedule:
    - cron: '15,45 3-14 * * *'   # every 30 min, 07:15–18:45 Oman (mirrors keep-warm window)
  workflow_dispatch:
permissions: { contents: read }
jobs:
  sweep:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Curl sla-escalate
        env: { PROD_CRON_SECRET: ${{ secrets.PROD_CRON_SECRET }} }
        run: |
          set -euo pipefail
          curl -fsSL -H "Authorization: Bearer ${PROD_CRON_SECRET}" \
            "https://nmwc-cm.vercel.app/api/cron/sla-escalate"
```

**Route `app/api/cron/sla-escalate/route.ts` [Proposed]** — **`GET`** handler (this is the direct fix for OLD BUG-03, whose POST-only `sla-check` never fired), `runtime='nodejs'`, `dynamic='force-dynamic'`. Auth: extract `bearerMatches` from `app/api/cron/photo-gc/route.ts:30-37` into a shared `lib/cron-auth.ts` and refactor photo-gc + keep-warm to import it (it is already copy-pasted twice — `keep-warm/route.ts:38-44`; a third copy is where drift starts). Logic:

```ts
const BATCH = 200; // photo-gc batching precedent, photo-gc/route.ts:22
export async function GET(req: NextRequest) {
  // bearerMatches(CRON_SECRET) exactly as photo-gc/route.ts:39-44
  const now = new Date();
  const due = await prisma.customerEdit.findMany({
    where: { state: 'SUBMITTED', slaDueAt: { lt: now }, escalationLevel: 0 },
    take: BATCH, orderBy: { slaDueAt: 'asc' },
    include: { submittedBy: { select: { id: true, supervisorId: true, fullName: true } },
               customer: { select: { id: true, nmwcCode: true, legalName: true,
                 branches: { where: { deletedAt: null }, select: { regionId: true } } } } },
  });
  for (const e of due) {
    // Idempotent claim — same PROD-001 updateMany-guard pattern as edits.ts:767-780:
    const claimed = await prisma.customerEdit.updateMany({
      where: { id: e.id, state: 'SUBMITTED', escalationLevel: 0 },
      data: { escalationLevel: 1, escalatedAt: now },
    });
    if (claimed.count === 0) continue;          // decided / already escalated by a racer
    await auditLog('ESCALATE', 'CustomerEdit', e.id, { pendingRole: e.pendingRole, slaDueAt: e.slaDueAt });
    await notifyEscalation(e);                  // §2 — in-app + email to the escalation target
  }
  // Second sweep: escalationLevel=1 items whose stageEnteredAt-based 2×-SLA deadline passed → level 2, same claim pattern.
  // Piggyback jobs (cheap, same invocation): email-retry sweep (§2.2), notification GC (§2.3), steward Temix reminder (§3.5).
  return NextResponse.json({ escalated, level2 });
}
```

**Escalation targets [Proposed / partly Open]:**
- `pendingRole=SUPERVISOR` breached → the MANAGER(s) of the customer's branch regions (resolve `branches.regionId` ∩ `Region.managers`; fail-closed like the Manager queue scoping at `app/(app)/approvals/page.tsx:30-42`; if no region manager exists, fall back to all active MANAGERs).
- `ACCOUNTANT` breached → FINANCE_MANAGER + GM. `FINANCE_MANAGER` breached → GM. `GM` breached → all MANAGERs + STEWARD (visibility only; nobody outranks GM). **[Open — owner must confirm the chain.]**
- Escalation **notifies, never auto-reassigns or mutates workflow state** in v1. (OLD force-flipped supervisor-breached requests to an `ESCALATED` status — OLD:`sla-check:47-73`. We deliberately do not touch `state`, so the approver of record still acts and the EL-15 self-approval + atomic-claim invariants at `services/edits.ts:767-780` / `lib/permissions.ts:125-145` are untouched.) [Proposed]

New enum values (one migration): `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ESCALATE'; ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPORT';` — the latter closes the taxonomy gap where exports are logged as `IMPORT` (`services/exports.ts:179`). (PG 12+ allows ADD VALUE in a transaction as long as the value isn't used in the same transaction — safe in its own migration file.)

### 1.4 Aging surfaced on the queues [Proposed]

`app/(app)/approvals/page.tsx` already ships `ageHours` into `ApprovalQueueItem` (`:66-83`). Extend:
- Add `slaDueAt`, `overdue: boolean`, `escalationLevel` to the query select (`:45-60`) and mapped item (`:70-82`).
- Change `orderBy` (`:59`) to `[{ slaDueAt: 'asc' }, { submittedAt: 'asc' }]` — most-overdue first (index `[state, slaDueAt]` backs it).
- `BulkApprovalQueue.tsx`: render a pill per row — green "due in 5h" / amber "<2h" / red "OVERDUE 3h" — reimplementing OLD's `formatSlaStatus` labels (OLD:`lib/sla.ts:132-155`) on `minutesRemaining`. Same treatment on `/reactivations` (`app/(app)/reactivations/page.tsx`) and the detail page `app/(app)/approvals/[id]/page.tsx`.
- Dashboard (`app/(app)/dashboard/page.tsx`): "breached SLAs" count card for MANAGER/GM — one `count({ where: { state:'SUBMITTED', slaDueAt: { lt: now } } })`.

---

## 2. Notifications (in-app + email)

### 2.1 Schema [Proposed]

```prisma
enum NotificationKind {
  STEP_PENDING          // you have an item to review
  EDIT_APPROVED         // your submission advanced / was finally approved
  EDIT_REJECTED         // returned for correction
  SLA_ESCALATED         // an item under your authority breached SLA
  REACTIVATION_PENDING
  TEMIX_UPLOAD_READY    // steward: approved items queued for the next Temix upload
  TEMIX_SYNC_ACKED      // submitter: your customer landed in Temix (code assigned)
}

model Notification {
  id         String           @id @default(cuid())
  userId     String
  kind       NotificationKind
  title      String                        // PII-lean: "Edit on NMWC-2026-000123 needs your review"
  body       String?          @db.Text
  entityType String?                       // 'CustomerEdit' | 'Customer' | 'TemixSyncBatch'
  entityId   String?
  readAt     DateTime?
  emailedAt  DateTime?                     // simple outbox: null + emailError set ⇒ retry candidate
  emailError String?
  createdAt  DateTime         @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, readAt, createdAt(sort: Desc)])  // bell badge + inbox
  @@index([emailedAt, createdAt])                   // retry sweep
}
```

Add `notifications Notification[]` to `User` (`schema.prisma:140-185`). **Content rule:** titles/bodies carry `nmwcCode`, `legalName`, edit id — **never** phone/CR numbers — matching the PII floor set by `lib/logger.ts:3-16` and F-15 (`services/imports.ts:892-901`).

### 2.2 Service — `services/notifications.ts` [Proposed]

```ts
export async function notify(userIds: string[], kind: NotificationKind, payload: {
  title: string; body?: string; entityType?: string; entityId?: string;
}): Promise<void>
```
- `createMany` the rows (dedupe `userIds`, skip `isActive: false` users).
- Then **best-effort email, strictly after the caller's transaction commits** — `notify()` is always invoked where `logger.info(... 'edit.approve')` sits today (`services/edits.ts:801`), i.e. post-`$transaction`, so a mail-provider outage can never roll back an approval.
- Per-recipient try/catch: on failure set `emailError`, leave `emailedAt` null. The sla-escalate cron does a bounded retry sweep (`emailedAt: null, emailError: {not: null}, createdAt > now-24h`, cap 50) — an outbox without a new cron.

**Hook points (exact locations):**

| Event | Where to call `notify()` | Recipients |
|---|---|---|
| Salesman submits (create or enrichment) | `submitEditCore`, after the create at `services/edits.ts:452-464` (and after draft→submit promotion) | `submittedBy.supervisorId` — the same person `canApproveSpecificEdit` requires (`lib/permissions.ts:125-145`) |
| Stage approve (non-final) | `approveEditCore`, after tx commit — next to `logger.info` at `services/edits.ts:801` | submitter (`EDIT_APPROVED` progress) + all active users of the next `pendingRole` (FINANCE_MANAGER / GM / ACCOUNTANT — see [Open] Q3 on scoping) |
| Final approve (Accountant) | same place, terminal branch | submitter + STEWARDs (`TEMIX_UPLOAD_READY`, **debounced** — §3.5, not one per approval) |
| Reject | `rejectEditCore`, after the audit write at `services/edits.ts:969-977` | submitter (`EDIT_REJECTED`, include `decisionReason` — already 5–1000 chars, `edits.ts:925-927`) |
| Close-branch submitted / reactivation requested | `services/reactivations.ts:129-215` / `:34-123`, post-create | supervisor / region MANAGERs (`REACTIVATION_PENDING`) |
| Reactivation decided | `services/reactivations.ts:224-307`, post-tx | requesting salesman |
| SLA breach | cron route (§1.3) | escalation-target chain |
| Bulk approve/reject (`services/edits.ts:818-913`) | per-edit via the per-edit core calls — no extra work | as above |
| Steward/Manager direct-write (`services/edits.ts:424-451`) | **no notification** — no reviewer exists [Proposed] | — |

### 2.3 In-app surface [Proposed]

- **Bell in `components/nmwc/TopBar.tsx`** — insert before the sign-out form (`TopBar.tsx:24-37`). TopBar is server-rendered receiving `user`; pass `unreadCount` from `app/(app)/layout.tsx` via one `prisma.notification.count({ where: { userId, readAt: null } })` per page render. Badge caps at "9+".
- **`app/(app)/notifications/page.tsx`** inbox: newest-first (index-backed), row click = mark-read + deep-link via `entityType`/`entityId` to `/approvals/[id]` / `/customers/[id]` / `/temix`. Server actions `markReadAction` / `markAllReadAction` in `app/actions/notifications.ts`, following the `SafeAction`/`runAction` convention used throughout `services/edits.ts`.
- **Freshness:** RSC + `revalidatePath` on navigation (the app's existing model — new-rules.md §M). Optional 60 s client poller against a tiny `/api/notifications/count`; no websockets on Vercel serverless. [Open — v1 can ship without the poller.]
- **Retention:** GC read notifications >90 days inside the sla-escalate cron (`deleteMany`, capped) — same batching pragmatism as photo-gc (`photo-gc/route.ts:46-51`). [Proposed]

### 2.4 Email delivery [Proposed + Open]

- **Recommendation: Resend** (`resend` npm package). Rationale: NEW has **no SMTP/mailer dependency at all** [Confirmed — `package.json`]; the app runs serverless on Vercel where a single HTTPS API call beats SMTP socket handshakes inside the 30 s `maxDuration` budget (`vercel.json:4-6`); free tier (~3k emails/month) covers this volume (tens/day); exactly one secret. Alternatives if mandated: AWS SES (cheapest at scale, reuses the `@aws-sdk` family already in deps, more setup) or nodemailer+company SMTP (only if NMWC insists on its own mail server — note OLD's nodemailer was dead code, old-techdebt BUG-04). **[Open — provider + sending domain (e.g. `crm@nmwc.om`) + SPF/DKIM owner.]**
- New envs in `.env.example` (currently has no mail section, `.env.example:1-38`): `RESEND_API_KEY=`, `EMAIL_FROM="NMWC CRM <crm@…>"`, `EMAIL_ENABLED=false` (kill-switch: when false, in-app only — lets v1 ship before DNS is done).
- `lib/mailer.ts`: thin `sendEmail({to, subject, html})`. Logs only `{ kind, notificationId }` — never the address; even accidental leakage is caught by the `*.email` redact path and `scrubString` email regex (`lib/logger.ts:8-11,27-31`). Email bodies obey the §2.1 PII rule (codes + names, no phones/CRs), because corporate mailboxes sit outside the app's access-control perimeter (a Supervisor-scoped user must not receive another region's phone numbers by mail).
- **`User.email` is nullable** (`schema.prisma:147`) — recipients without email silently get in-app only. **[Open — do salesmen/supervisors have company email? If not, v1 email is effectively a management-tier channel. SMS/WhatsApp out of scope.]**

---

## 3. Temix batch-sync contract

**Ground truth:** there is **no live Temix API in either repo** [Confirmed — grep-negative in NEW; OLD records Temix steps as manually-keyed fields only (x-integration M.8)]. v1 formalizes the batch-Excel loop new-docs §1 describes ("ERP→Excel→app→Excel→ERP") into a **stateful, idempotent, Steward-operated contract**. A real API is an **[Open] roadmap item** requiring Temix vendor discovery — nothing exists in-code to build against.

### 3.1 Crosswalk + sync state — schema [Proposed]

```prisma
enum TemixSyncState {
  NOT_SYNCED           // never sent (drafts; pre-backfill legacy rows)
  PENDING_CREATE       // final-approved create; awaiting upload + Temix code
  PENDING_UPDATE       // approved master correction on an already-SYNCED customer
  PENDING_DEACTIVATE   // soft-deleted/closed; Temix must deactivate on next upload
  SYNCED               // ack received (temixCode present / steward-confirmed)
}

enum TemixBatchStatus { GENERATED  UPLOADED  ACKED  VOID }

model Customer {
  // ... existing (schema.prisma:244-292) ...
  temixCode        String?                        // ERP identifier — THE nmwcCode↔temixCode crosswalk lives here
  temixSyncState   TemixSyncState @default(NOT_SYNCED)
  temixSyncedAt    DateTime?
  temixSyncBatchId String?                        // last outbound batch carrying this row (loose scalar — house style, cf. importBatchId schema.prisma:267)

  @@index([temixSyncState])
}

model TemixSyncBatch {
  id            String           @id @default(cuid())
  direction     String           @default("OUTBOUND")  // OUTBOUND | INBOUND (ack import)
  status        TemixBatchStatus @default(GENERATED)
  generatedById String
  generatedAt   DateTime         @default(now())
  uploadedAt    DateTime?        // steward pressed "I uploaded this to Temix"
  ackedAt       DateTime?
  rowCount      Int              @default(0)
  notes         String?          @db.Text

  generatedBy User @relation("TemixBatchGenerator", fields: [generatedById], references: [id])
}
```

Migration: `ALTER TABLE "Customer" ADD COLUMN "temixCode" TEXT;` + **partial unique** `CREATE UNIQUE INDEX "Customer_temixCode_key" ON "Customer"("temixCode") WHERE "temixCode" IS NOT NULL;` (tolerant of the mostly-null start; same partial-unique technique as `CustomerEdit_open_per_customer`, `prisma/migrations/20260509150000_qa_remediation/migration.sql:10-14`).

**Backfill (migration ETL):** set `temixCode` from the Temix export and `temixSyncState='SYNCED'` for every migrated row — this is also where the locked decision "payment terms for migrated customers come FROM Temix" executes (the import already strictly whitelists CASH/CREDIT, `services/imports.ts:643-651`, and writes `paymentTerms` at `:824,835`). **[Open — highest-leverage unknown (x-integration M.1.1): does `nmwcCode` (= import `cust_code`, used verbatim as the business key at `services/imports.ts:820-833`) already equal `temixCode`? If yes the crosswalk column is a copy; if no it is a reconciliation project. Verify BEFORE writing the backfill script.]**

Branch-level codes: v1 keeps the crosswalk at Customer level; each export row carries the NMWC `branch_code` so Temix-side mapping is possible. **[Open — does Temix key outlets separately? If yes, add `Branch.temixBranchCode String?` + partial unique in the same migration.]**

### 3.2 State-transition triggers (exact write points) [Proposed]

All flips happen **inside the same transaction as the business event**, so sync state can never disagree with approved data:

1. **Final approval of a CREATE** (Accountant stage, CASH or CREDIT): in `approveEditCore`'s tx (`services/edits.ts:762-799`), terminal-approve branch → `temixSyncState: 'PENDING_CREATE'`.
2. **Approved master correction** (Supervisor approves an enrichment edit): same tx — `tx.customer.updateMany({ where: { id: customerId, temixSyncState: 'SYNCED' }, data: { temixSyncState: 'PENDING_UPDATE' } })`. The `WHERE SYNCED` guard folds corrections on a not-yet-created customer into its existing `PENDING_CREATE` (no double row in the upload).
3. **Soft-delete / close:** the (to-be-built — today only merge sets `deletedAt`, `services/duplicates.ts:260`) `softDeleteCustomerAction` sets `deletedAt` + `temixSyncState: temixCode ? 'PENDING_DEACTIVATE' : 'NOT_SYNCED'` — a never-synced customer needs nothing from Temix.
4. **Merge** (`mergeCustomersAction`, `services/duplicates.ts:193-294`): loser (soft-deleted at `:260`) → `PENDING_DEACTIVATE` if it has a `temixCode`; winner → `PENDING_UPDATE` if `SYNCED`. Both inside the merge transaction.
5. **Steward/Manager direct-write** (`services/edits.ts:424-451`): same `SYNCED→PENDING_UPDATE` flip inside the direct-write tx.

Field filter [Proposed]: flip on any change to Temix-relevant fields (identity/contact/terms/territory/status); pure photo/GPS/equipment enrichment does NOT re-trigger an upload. Maintain a `TEMIX_RELEVANT_FIELDS` whitelist next to `CUSTOMER_FIELDS` (`services/edits.ts:56-68`). **[Open — exact list depends on what Temix actually stores.]**

### 3.3 Outbound — `services/temix-sync.ts buildTemixUploadAction()` [Proposed]

STEWARD-only (`requireSteward` pattern, `services/duplicates.ts:20-27`). Flow:

1. Select `Customer where temixSyncState IN (PENDING_CREATE, PENDING_UPDATE, PENDING_DEACTIVATE)` (deleted rows included **only** for `PENDING_DEACTIVATE`) with branches — reusing the include + row mapping of `services/exports.ts:119-168`.
2. Workbook via `buildWorkbook` (`lib/excel.ts:87-105` — QA-021 formula-escaping comes free). **Columns** = the existing export contract (`services/exports.ts:134-168`: `cust_code, cust_name, payment_terms, cr_no, branch_code, branch_name, sales_region, region_code, route, address, phone, contact_person, channel, sub_channel, day_of_visit, gps_lat, gps_lng, …`) **plus**:
   - `temix_code` (blank for creates — Temix assigns),
   - `sync_action` ∈ `CREATE | UPDATE | DEACTIVATE`,
   - `sync_batch_id`,
   - credit columns owned by the credit-workflow area: `requested_credit_limit` (OMR), `payment_term_days`, `guarantee_docs` (count + document refs). *(Dependency: that area must persist these — e.g. a `CreditApplication` relation. This export reads them, never owns them.)*
   - **[Open — the authoritative Temix import template (exact headers/order its importer accepts) must come from NMWC ops. The above is the superset the CRM can produce; do not guess Temix's header row.]**
3. One transaction: create `TemixSyncBatch(status: GENERATED, rowCount)` + stamp included customers' `temixSyncBatchId`. **Do NOT flip `temixSyncState`** — generation is read-only w.r.t. pending-ness.
4. `AuditLog action: 'EXPORT', entityType: 'TemixSyncBatch'` (new enum value; replaces the `IMPORT` mislabel pattern at `services/exports.ts:174-185`).
5. Return `{bytes, filename, rowCount}` exactly like `buildCustomerExport` (`services/exports.ts:188-192`) via a route mirroring `app/api/exports/customers/route.ts` (auth-before-parse, F-21).

**Idempotency:** because generation never flips state, the Steward can regenerate freely (browser crash, Temix rejected the file) — every still-pending row reappears, stamped with the newer batch id. Exactly-once is enforced at **ack**, not at export.

**Ack (two-step, evidence-based):**
- Steward clicks **"Mark uploaded"** → `TemixSyncBatch.status='UPLOADED', uploadedAt=now`, and flips that batch's `UPDATE`/`DEACTIVATE` customers `→ SYNCED` (`temixSyncedAt=now`) via a guarded `updateMany({ where: { temixSyncBatchId, temixSyncState: { in: ['PENDING_UPDATE','PENDING_DEACTIVATE'] } } })` — Temix returns nothing for these; the steward's confirmation IS the ack. Guarded `updateMany` = idempotent under double-click (PROD-001 pattern, `edits.ts:763-780`).
- `CREATE` rows **stay `PENDING_CREATE` until the inbound path (§3.4) delivers their `temixCode`**. This closes the loop OLD only hand-recorded (confirm-Temix stage) and prevents "we think it's in Temix but it has no ERP code". Batch flips to `ACKED` when its last create is coded.
- **[Open — if ops finds two-step too heavy: fallback is "Mark uploaded" flips everything and creates reconcile lazily on the next inbound import. Recommend keeping strict.]**

### 3.4 Inbound — Temix → Excel → import refresh [Proposed]

Extend the existing Steward customer-master import (parse: `services/imports.ts:496-683`; promote: `:709-923`) — do not build a second pipeline:

1. **New recognized column `temix_code`** in parse (alongside `cust_code` at `:626`), carried into `parsed`.
2. **Promote** (upsert at `:820-845`): add to both `update` and `create` blocks — `temixCode: parsed.temixCode ?? undefined`; and when a `PENDING_CREATE` customer receives a non-null code: `temixSyncState: 'SYNCED', temixSyncedAt: new Date()` + `TEMIX_SYNC_ACKED` notification to the originating submitter (via `createdById`).
3. **Conflict rules** (quarantine, never overwrite — reuse the QUARANTINED lane, `:679`, and the pre-check style of the CR/phone collision checks `:634-642`):
   - incoming `temix_code` already on a **different** customer → quarantine (the partial unique would P2002 anyway; catch it early with a friendly message);
   - incoming `temix_code` ≠ existing non-null `temixCode` for the same `cust_code` → quarantine ("crosswalk conflict — steward review").
4. **Payment terms:** Temix stays authoritative — inbound `payment_terms` continues to overwrite via the strict whitelist (`:643-651`) + upsert (`:824,835`). This implements the locked decision for migration AND ongoing refreshes. **Caution [Confirmed]:** today's upsert also overwrites `legalName/phone/contactPerson/crNumber` (`:822-831`) — fine for Temix-owned identity fields, wrong for CRM-enriched ones if Temix's file carries stale values. **[Open — field-ownership matrix. Recommend: Temix owns `payment_terms`, `temix_code`, `cust_name` (legalName is steward-locked to salesmen anyway, `lib/permissions.ts:77`), `cr_no`; the CRM owns all field-force enrichment (GPS, photos, contact enrichment, dayOfVisit, equipment). Implement as a `TEMIX_OWNED_FIELDS` whitelist inside the promote `update` block.]**
5. **Cadence:** [Open — weekly / monthly / after each upload?] Document the chosen cadence as the sanctioned drift-control loop (x-integration M.8).

### 3.5 Steward UI — `app/(app)/temix/page.tsx` [Proposed]

STEWARD-only nav entry (`components/nmwc/Sidebar.tsx`): pending counts grouped by `temixSyncState`, "Generate upload file" (→ §3.3), batch history (`TemixSyncBatch` table) with per-batch "Mark uploaded", and a red "creates unacked > N days" indicator. The `TEMIX_UPLOAD_READY` steward notification is **debounced**: created at most once/day by the sla-escalate cron when `count(PENDING_*) > 0` and no unread one exists — never one per approval (final-approve bursts would spam the bell).

---

## 4. Rollout order & dependencies

1. **Migration 1** (independent — ship first): `Notification` + `NotificationKind`; `CustomerEdit` SLA columns; `AuditAction += ESCALATE, EXPORT`; `lib/working-hours.ts` (+vitest suite); wire notifications + SLA stamps into the **existing single-stage** flow (submit→Supervisor). Immediate pilot value, zero workflow-area dependency.
2. **Cron**: `lib/cron-auth.ts` extraction, `app/api/cron/sla-escalate/route.ts`, `.github/workflows/sla-escalate.yml` (+`PROD_CRON_SECRET` already provisioned for keep-warm, `keep-warm.yml:35`).
3. **Migration 2** (after the approval-engine area lands multi-stage + credit capture): `pendingRole` stage advancement in `approveEditCore`, FINANCE_MANAGER/GM SLA policies + escalation chain, per-role queues.
4. **Migration 3** (with the migration/ETL workstream): `temixCode` backfill + `TemixSyncState`/`TemixSyncBatch` + inbound `temix_code` column + `/temix` page. Blocked on [Open] crosswalk verification + Temix template.
5. Email provider onboarding (domain/DNS) can trail everything — `EMAIL_ENABLED=false` keeps v1 in-app-only until sign-off.

Must-fix prerequisite: the always-grants rate limiter (`lib/rate-limit.ts` — new-techdebt BUG-1) should be fixed before adding the `/api/notifications/count` poller, since polling adds a new hot endpoint surface.

---

## 5. OPEN QUESTIONS (consolidated)

1. **SLA budgets** for FINANCE_MANAGER / GM stages (Supervisor 8h + Accountant 9h inherited from OLD:`constants.ts:225-227`); SLA on reactivation approvals (MANAGER)? Does the rework clock (NEEDS_CORRECTION→resubmit) count?
2. **Escalation chain** per stage; does level-2 (2× SLA) exist and who does it hit; confirm escalation is notify-only (no auto-status flip, unlike OLD's `ESCALATED` force-status).
3. **Are FINANCE_MANAGER / GM / ACCOUNTANT global or region-scoped approvers?** Determines notification recipients + queue filters; today's scope model (`lib/access.ts`) has no hooks for them.
4. **Email provider + sending domain** (Resend recommended); do field roles even have company email (`User.email` nullable, `schema.prisma:147`)?
5. **Working calendar confirmation:** Sun–Thu + Sat, Fri off, 08:00–17:00 Oman (OLD defaults) — correct for NMWC? Public holidays in scope? (v1: no holiday table.)
6. **Crosswalk equivalence:** does `nmwcCode` (= import `cust_code`, `services/imports.ts:820-833`) equal Temix's `temixCode`? Single highest-leverage unknown (x-integration M.1.1) — gates the backfill.
7. **Temix upload template:** exact headers/order/format its importer accepts; does Temix model branches with their own codes (→ `Branch.temixBranchCode`)? What is Temix's deactivation semantic (flag vs delete)?
8. **Ack strictness:** two-step (creates SYNCED only on inbound code) vs steward one-click; inbound refresh **cadence**; **field-ownership matrix** for inbound overwrites (§3.4.4 recommendation).
9. **Credit payload:** currency/format of `requested_credit_limit` (OMR assumed), and how guarantee documents travel to Temix (photo/document refs in the sheet? printed pack?) — depends on the credit-workflow area's model.
10. **Vercel plan:** staying on Hobby (→ GitHub-Actions cron, this design) or upgrading to Pro (native sub-daily Vercel cron would simplify ops)?
11. **Notification retention** (90-day GC proposed) and whether the unread-count client poller ships in v1.
12. **Future Temix API:** roadmap-only flag — requires vendor capability discovery; nothing exists to integrate against today [Confirmed grep-negative both repos].

## Key file:line anchors (reuse targets)
- Cron auth to extract/copy: `app/api/cron/photo-gc/route.ts:30-44` (GET + `timingSafeEqual` + `CRON_SECRET`); duplicate at `app/api/cron/keep-warm/route.ts:38-50`.
- GitHub-Actions curl-cron to clone: `.github/workflows/keep-warm.yml:17-45` (secret `PROD_CRON_SECRET` `:35`); daily precedent `.github/workflows/db-backup.yml:18-22`.
- Vercel cron (daily-only, Hobby): `vercel.json:9-13`; `maxDuration:30` at `:4-6`.
- Queue aging to replace: `app/(app)/approvals/page.tsx:59,66-83`.
- Workflow hook points: `services/edits.ts:452-464` (queued submit), `:424-451` (direct-write), `:762-799` (approve tx), `:801` (post-tx log = notify point), `:959-977` (reject); `services/reactivations.ts:34-123,129-215,224-307`; `services/duplicates.ts:193-294,260` (merge/soft-delete).
- Atomic-claim idempotency pattern: `services/edits.ts:767-780` (PROD-001).
- SLA calendar to port+fix: OLD:`lib/sla.ts:1-156` (tz bug `:16-18`, hour-loop `:28-50`); budgets OLD:`constants.ts:225-227`; BUG-03 POST-only cron OLD:`app/api/cron/sla-check/route.ts`.
- Notification shape reference: OLD:`lib/notifications.ts:14-164` (in-app rows; email never wired — old-techdebt BUG-04).
- Export/Excel reuse: `services/exports.ts:38-192` (scoping `:46-103`, columns `:134-168`, audit mislabel `:179`); `lib/excel.ts:15-69` (parse), `:81-105` (build + QA-021).
- Import extension points: `services/imports.ts:496-683` (parse; payment-terms whitelist `:643-651`; collision pre-checks `:634-642`; quarantine `:679`), `:709-923` (promote; upsert `:820-845`; PII-safe failure `:892-901`).
- PII redaction: `lib/logger.ts:3-16,27-48`.
- Schema targets: `Customer` `schema.prisma:244-292`; `CustomerEdit` `:352-381`; `User.email` `:147`; `AuditAction` `:72-91`; partial-unique precedent `prisma/migrations/20260509150000_qa_remediation/migration.sql:10-14`.
