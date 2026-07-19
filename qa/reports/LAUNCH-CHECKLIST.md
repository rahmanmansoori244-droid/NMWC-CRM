# NMWC CRM — Launch Checklist & GO/NO-GO

**As of 2026-07-19, after the pre-launch deep review (25 confirmed findings) and fixes.**

## Current status: **NOT YET — a few gates remain, but they are small and mostly yours.**

The dangerous defects are fixed and regression-proven. What's left is (a) 5 owner
decisions/actions and (b) 1 code task before importing the *real* master. None are
deep engineering; most are config + confirmation.

---

## ✅ Fixed & regression-proven this round (committed)

| Fix | Severity | Proof |
|---|---|---|
| Manager could seize/disable the credit approvers (FM/GM/Accountant) | P1 | `tests/unit/user-admin-authz.test.ts` (fail→pass) |
| Region-less Manager read the whole customer master (list page) | P1 | `tests/unit/customer-list-scope.test.ts`; shared fail-closed helper |
| Concurrent reversed-pair merge archived BOTH customers | P1 | `tests/integration/merge-concurrency.test.ts` (fail→pass) |
| Silent cross-customer branch steal on promote | P1 | `tests/integration/promote-reconciliation.test.ts` |
| F-17 UNASSIGNED fallback rejected whole groups | P1 | same |
| Reactivation lane C11/C12/C13 | P1/P2 | `tests/integration/reactivation-authz.test.ts` |
| Deploy never ran migrations; Vercel in Frankfurt vs DB in us-east; missing env docs; xlsx row cap | P2 | config (this round) |

Full suite: **155 passed / 4 skipped / 0 failed** (all DB gates on).

---

## 👤 YOU must decide/do before launch (blocking)

1. **Rotate & set production secrets** in Vercel: `DATABASE_URL`/`DIRECT_URL`,
   `AUTH_SECRET` (+`NEXTAUTH_SECRET`), `CRON_SECRET`, `HEALTH_BEARER`,
   `DEMO_ACCOUNTS_DISABLED=true`, `RATE_LIMIT_BACKEND=pg`, R2 keys, Sentry DSN.
   All now documented in `.env.example`. The committed pilot creds must be dead.
2. **Confirm the workweek** (`WORK_DAYS`). Default is **6-day, Friday off**
   (`0,1,2,3,4,6`). If NMWC works **Sun–Thu (5-day)**, set `0,1,2,3,4`. Wrong value
   = every SLA deadline and escalation is miscalculated. Also confirm
   `WORK_TZ_OFFSET_MIN=240` (Oman UTC+4) and work hours 08–17.
3. **Cron reliability**: SLA-escalation, keep-warm, and DB backup currently run on
   **GitHub Actions `schedule:`**, which GitHub **auto-disables after 60 days of repo
   inactivity** — silently stopping escalation and backups. Decide: move them to
   Vercel Crons (reliable, needs Pro plan; only `photo-gc` is there today) or accept
   the GH Actions risk with a monthly "poke the repo" reminder.
4. **Preview-deploy DB**: the build now runs `prisma migrate deploy`. If Vercel
   Preview deployments point at the **production** DB, a preview will migrate prod.
   Confirm previews use a separate DB, or disable Preview deploys for this project.
5. **Temix contract questions** (owner/ERP-team): (a) should the outbound UPSERT
   push the CRM's copy of credit fields back to Temix, or are those inbound-only?
   (b) do you want per-row ERP-outcome tracking so a Temix-rejected row alarms
   instead of sitting in UPLOADED forever? These are design calls, not bugs.

---

## 🔧 One code task before importing the REAL master

**Do NOT promote the full ~3,300-customer master in a single import.** The promote
loops per customer with ~10 sequential queries each; even co-located with the DB
that can exceed the 60s function limit and strand the batch in `PROMOTING`. Options:
- **Interim (no code):** split the master into files of **≤500 customers** and
  promote each — safe today.
- **Proper fix (code, recommended):** make promote chunked/resumable (claim + process
  N groups per invocation, re-invoke until done). Tracked as the top P2.

---

## 📋 Remaining verified P2/P3 (not launch-blocking; fix in first patch window)

From `qa/findings/pre-launch-deep-review.md` — all code-cited & 3-lens verified:
- Promote/PROMOTING has no crash-recovery path back to READY (pairs with the chunking task).
- `attachPhoto`/`detachPhoto` race can create dangling photo-slot pointers (photos.ts).
- In-file dup phone/CR check not keyed by cust_code → a multi-branch customer with a
  repeated customer-level phone/CR is fully quarantined with no requeue.
- Legacy re-import upsert path bypasses the B-05 optimistic lock (no version bump/audit).
- Temix: archive of a crosswalk-less migrated customer drops its deactivation; refresh
  routing keys on per-row temix_code (a blank cell reroutes to the full-clobber lane).
- CREATE request wedges at the Accountant step if a route is re-regioned mid-chain.
- Close-shop request is un-approvable on incomplete (import-born) customers (EL-04 re-check).
- Cutover backfill left pre-Phase-1 SUBMITTED edits with `slaDueAt=NULL` (SLA-exempt) and
  stamped pre-existing reactivations with `pendingRole=SUPERVISOR` (un-actionable rows).

## Bottom line
Fix the 5 owner items + chunk the first master import, and this is **GO for a
supervised pilot**. The remaining P2/P3s are real but survivable and can land in the
first patch window with the pilot already running.
