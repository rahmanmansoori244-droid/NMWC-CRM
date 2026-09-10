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
| 2 | **RoutePro snapshot: 11-Sep export loaded** (13 new codes, 7 route moves, 5 pay-mode changes since 3-Sep). If more customers are created in Timix before Sunday, export again on Saturday: save the grid dump as `Downloads/RoutePro_Customer_Master_RAW_<yyyy-mm-dd>.csv`, tell me, and I normalize + rebuild (the builder picks the newest `..._LIVE_<date>.csv` automatically). | Customers created in Timix only reach the CRM through RoutePro (after the feeder) or through the sales file. The build also adds anyone invoiced this month that the snapshot lacks. |
| 3 | The org chart is **decided** (walk-through of 2026-09-10): no supervisor accounts; each manager supervises their own salesmen — Muscat by class (GT Ahmed Alnadabi · MT Sarath · HD Haitham · HORECA Sara Khayat), other regions by region (Nizwa Sunil KP · Khaburah Ashok · Salalah Tharwat · Barka Saqib · Al Wafi/Duqm Rasool). Approver accounts are generic: `accountant`, `finance.manager`, `gm.nmwc`. | Nothing to do unless a name changes. |
| 4 | **2,472 customers sit on routes with no recent sales** and are parked on UNASSIGNED in their region (`dq/inactive-routes-summary.csv`: DIRECT 1,102 · SL01 304 · S23 216 · S15 171 …). Only **W** (wholesale, 6 customers) has no salesman among the active routes. | Decided: keep them visible and reassign/close after go-live. |
| 5 | Finance to review **3,252 CREDIT customers with no credit limit** (`dq/credit-customers-without-limit.csv`). | Decided: load as CREDIT with a blank limit; finance fills them later. |
| 6 | Merge the branch to `main` so production deploys. The build runs `prisma migrate deploy`; the only new migration is additive (two nullable columns + an index on `ImportBatch`). | Production code must include RK-3 (chunked promote) or the load cannot complete. |
| 7 | In Neon, **create a branch from production immediately before the load** (e.g. `pre-golive-2026-09-13`). | Instant rollback: if the load is wrong, restore from that branch instead of trying to undo 20,000 rows. |

## 1. Sunday — the load (Data Steward, ~1 hour)

Everything happens in the production app, in this order. Do not skip a step; the
importer enforces most of the order, but not all of it.

1. **Create the Steward and the 11 Managers.** Neither can come from the app or a
   spreadsheet (the seeded `admin` is a Manager, Managers may only create field
   roles, and the import refuses admin-tier roles). Run once, from a machine with the
   **production** database URL:

   ```bash
   DATABASE_URL='<production URL>' npx tsx scripts/golive/bootstrap-accounts.ts golive-data/managers.json
   ```

   It creates `steward` plus the managers by name (`ahmed.alnadabi`, `haitham`,
   `sarath`, `sara.khayat`, `ashok`, `rashid`, `rasool`, `saqib`, `saud`, `sunil.kp`,
   `tharwat`), all with the initial password `12345` and a **forced password change at
   first login**. It skips any username that already exists and touches nothing else.
   Regions are assigned by the next step, not here.
2. Sign in as `steward` — you are sent straight to *change password* (12+ characters).
3. **Import → Account master** → `golive-data/account-master.xlsx`.
   Expect: 7 regions, 43 routes, 56 user rows applied. Open the issues list — it
   must be empty except for anything you already know about. Check **Users**: every
   manager now shows their regions; salesmen show their route and their manager as
   supervisor.
4. **Import → Customer master** → `golive-data/customer-master.xlsx` (~20,100 rows).
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
8. **Hand out logins — the same day.** Every salesman's username is their **route
   code** (`c4`, `sh01`, `nizd` …), every manager's is their name, and the initial
   password is `12345` for everyone. The app forces each person to choose a new
   12+-character password the first time they sign in. Because the usernames are
   guessable, the initial password is only safe for as long as accounts sit unused:
   **have everyone sign in and change it on launch day**, and ask the Steward to check
   **Users** the next morning for anyone who has not (their account still shows the
   forced-change flag). `credentials.xlsx` lists the logins — delete it afterwards.

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
