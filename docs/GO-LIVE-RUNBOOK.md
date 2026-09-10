# NMWC CRM — Go-live runbook (target: Sunday 13 September 2026)

This is the step-by-step for putting the real customer master into production. The
files it loads are built by `scripts/golive/build-masters.ts` into `golive-data/`
(gitignored — customer data and generated passwords never enter the repository).
Rebuild them any time the sources change:

```bash
npx tsx scripts/golive/build-masters.ts
```

Read `golive-data/RECONCILIATION.md` after every build. It states what is in the
files, what was withheld, and **every assumption that needs your confirmation**.

---

## 0. Before Sunday — decisions and safety (owner)

| # | Item | Why |
|---|---|---|
| 1 | **Rotate the `neondb_owner` password** in Neon, then update `DATABASE_URL`/`DIRECT_URL` in Vercel (Production + Preview). | The current password was pasted in chat and appears in UAT screenshots. Neon branches share it, so it is the **production** password. |
| 2 | Confirm the **11 managers** and **5 supervisors** in `RECONCILIATION.md` §"Decisions assumed". | The org chart was inferred from the sales dashboard and the Temix "Team Leaders". Two people (Sara Khayat, Tharwat) are both managers and pre-sellers; they were set up as managers. |
| 3 | Name the real **Accountant(s), Finance Manager and GM**. | The file creates placeholders (`accountant`, `finance.manager`, `gm.nmwc`) so approvals cannot stall on day one. Rename them in Users, or tell me the names and I rebuild. |
| 4 | Decide the **51 routes without a salesman** (`dq/routes-no-salesman.csv`). | Van/direct routes have no named person; 6 salesmen sell on two routes and own only one. Customers on those routes exist but nobody can capture/edit them in the field until a salesman is assigned in Users. |
| 5 | Finance to review **3,252 CREDIT customers with no credit limit** (`dq/credit-customers-without-limit.csv`). | RoutePro says "CHARGE" but no limit is on file. They load as CREDIT with a blank limit. |
| 6 | Merge the branch to `main` so production deploys. The build runs `prisma migrate deploy`; the only new migration is additive (two nullable columns + an index on `ImportBatch`). | Production code must include RK-3 (chunked promote) or the load cannot complete. |
| 7 | In Neon, **create a branch from production immediately before the load** (e.g. `pre-golive-2026-09-13`). | Instant rollback: if the load is wrong, restore from that branch instead of trying to undo 20,000 rows. |

## 1. Sunday — the load (Data Steward, ~1 hour)

Everything happens in the production app, in this order. Do not skip a step; the
importer enforces most of the order, but not all of it.

1. **Create the first Steward.** This cannot be done in the app: the seeded `admin`
   is a Manager, Managers may only create field roles, and the import refuses to
   create a Steward. Run once, from a machine with the **production** database URL
   (the password is the one in `credentials.xlsx` → *Create in app FIRST*, first row):

   ```bash
   STEWARD_PASSWORD='<that password>' DATABASE_URL='<production URL>' npx tsx scripts/golive/bootstrap-steward.ts
   ```

   It refuses to run if a Steward already exists and touches nothing else. Sign in as
   `steward`; you will be asked to change the password.
2. **Create the 11 Manager accounts** in **Users** (same sheet). Username, full name,
   role MANAGER, password as listed. Do **not** assign regions by hand — the next step
   does it.
3. **Import → Account master** → `golive-data/account-master.xlsx`.
   Expect: 7 regions, 127 routes, ~95 user rows applied. Open the issues list — it
   must be empty except for anything you already know about. Check **Users**: every
   manager now shows their regions; salesmen show their route and supervisor.
4. **Import → Customer master** → `golive-data/customer-master.xlsx` (20,104 rows).
   Wait for staging. Expect roughly **all rows CLEAN**; a handful QUARANTINED at most.
   Open every quarantined row — the reason is shown. (The rehearsal quarantine picture
   is in `golive-data/REHEARSAL-RESULT.md`.)
5. **Promote**. It runs in passes and shows *"Promoting… N done, M left"*. Production
   is co-located with the database, so expect the whole master in roughly 10–20
   minutes. **Leave the tab open.** If it is interrupted, the page shows *Promote
   interrupted* — click **Resume promote**; nothing is lost or repeated.
6. **Reconcile** (SOP §8.4): *Left to promote* = 0, and *Promoted + Rejected +
   Quarantined = Total*. Open every REJECTED row (they are listed first). Screenshot
   the six figures — that is the evidence the load was checked.
7. **Spot-check** as a salesman (any login from `credentials.xlsx`, sheet *Created by
   import*): **Today** shows that route's journey-plan customers for today's weekday;
   a customer page shows region, route, channel, payment terms, Temix code.
8. **Hand out logins.** Each person gets their row from `credentials.xlsx`. Then
   **delete `credentials.xlsx`** (and empty the recycle bin). Everyone must change
   their password on first login.

## 2. If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| Account master lists issues for salesman rows: *route "X" not found* | A route code in the Users sheet is not in the Routes sheet. | Rebuild the files; the builder guarantees consistency. |
| Account master upload fails with a timeout / gateway error | The Users sheet creates ~95 accounts in one request, each with a deliberately slow password hash; on a slow day that can brush the 60-second request limit. | Nothing is lost — whatever was applied stays applied. Split the **Users** sheet in two (keep Regions/Routes in both, they are idempotent) and upload each half. Re-importing an already-created user is safe: it keeps their password. |
| Many customer rows QUARANTINED for *duplicate phone* | A phone shared across customers that the builder did not catch. | Review; if genuine duplicates, merge later — they will not block the rest. |
| Promote stops with *"Stopped — N rows made no progress"* | Repeated technical failures on the same customers. | Do not keep clicking. Screenshot and call IT. |
| Promote refused: *"Another customer import is being promoted"* | Someone else (or an earlier tab) holds the batch. | Wait a minute and resume; only one load runs at a time by design. |
| The load is wrong and must be undone | — | Restore production from the Neon branch taken in step 0.7. |

## 3. What the load does NOT do (by design)

- Bulk-loaded customers **do not pass through the approval chain** (SOP §8.5).
- No photos, GPS, sub-channel, equipment counts — the field team captures those.
- A branch planned on several days carries only its **first** visit day.
- Customers dormant in the July master **and** absent from RoutePro were not loaded
  (`dq/codebranch-dormant-not-loaded.csv`, 154 customers).
