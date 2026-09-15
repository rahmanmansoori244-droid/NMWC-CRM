# NMWC CRM — Go-live runbook

> **The 13 September target passed.** The load has not run: production still holds the
> May seed data. Nothing in this document expires with the date — it is written for
> "load day", whichever day that turns out to be. Where it says "Sunday", read "load
> day"; where it says "before Sunday", read "before you start".

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

## 0. Before load day — decisions and safety (owner)

| # | Item | Why |
|---|---|---|
| 1 | **Rotate the `neondb_owner` password** in Neon, then update `DATABASE_URL`/`DIRECT_URL` in Vercel (Production + Preview). | The current password was pasted in chat and appears in UAT screenshots. Neon branches share it, so it is the **production** password. |
| 2 | **RoutePro snapshot: 11-Sep export loaded** (13 new codes, 7 route moves, 5 pay-mode changes since 3-Sep). If more customers are created in Timix before Sunday, export again on Saturday: save the grid dump as `Downloads/RoutePro_Customer_Master_RAW_<yyyy-mm-dd>.csv`, tell me, and I normalize + rebuild (the builder picks the newest `..._LIVE_<date>.csv` automatically). | Customers created in Timix only reach the CRM through RoutePro (after the feeder) or through the sales file. The build also adds anyone invoiced this month that the snapshot lacks. |
| 3 | The org chart is **decided** (walk-through of 2026-09-10): no supervisor accounts; each manager supervises their own salesmen — Muscat by class (GT Ahmed Alnadabi · MT Sarath · HD Haitham · HORECA Sara Khayat), other regions by region (Nizwa Sunil KP · Khaburah Ashok · Salalah Tharwat · Barka Saqib · Al Wafi/Duqm Rasool). Approver accounts are generic: `accountant`, `finance.manager`, `gm.nmwc`. | Nothing to do unless a name changes. |
| 4 | **2,472 customers sit on routes with no recent sales** and are parked on UNASSIGNED in their region (`dq/inactive-routes-summary.csv`: DIRECT 1,102 · SL01 304 · S23 216 · S15 171 …). Only **W** (wholesale, 6 customers) has no salesman among the active routes. | Decided: keep them visible and reassign/close after go-live. |
| 5 | Finance to review **3,252 CREDIT customers with no credit limit** (`dq/credit-customers-without-limit.csv`). | Decided: load as CREDIT with a blank limit; finance fills them later. |
| 6 | ~~**Merge the branch to `main` so production deploys**~~ **DONE 2026-09-14 11:39 UTC** (owner's go; PR #1 fast-forwarded `main` to `6852063`, tag `v1.1.0-golive`; `main` has moved on since — production is whatever `git log -1 origin/main` says, and as of 2026-09-15 that is `e94f017`; production verified: `sla-escalate` → 401, region `iad1`, providers on `nmwc-cm.vercel.app`, health ok). Kept for the record — the sequence was: (a) CI is green on the branch (it now runs on every branch, including the Postgres-backed integration job); (b) in Vercel → Production env confirm `AUTH_SECRET` (≥32 chars), `AUTH_URL=https://nmwc-cm.vercel.app`, `CRON_SECRET`, `HEALTH_BEARER`, `RATE_LIMIT_BACKEND=pg`, `DEMO_ACCOUNTS_DISABLED=true`, the `R2_*` set, `DATABASE_URL`/`DIRECT_URL`; (c) fast-forward `main` to the branch (`git push origin <branch>:main`) — the production build applies four additive migrations (`phase1_enums`, `phase1_tables`, `notification_temix_kinds`, `promote_chunked_lease`); (d) verify `curl -s -o /dev/null -w '%{http_code}' https://nmwc-cm.vercel.app/api/cron/sla-escalate` → **401** and `x-vercel-id` region **iad1**; (e) tag `v1.1.0-golive`. | Production code must include RK-3 (chunked promote) or the load cannot complete; the login limiter on the May build never denies. |
| 7 | In Neon, **create a branch from production immediately before the load** (e.g. `pre-golive-2026-09-13`). | Instant rollback: if the load is wrong, restore from that branch instead of trying to undo 20,000 rows. |
> **Step-by-step for steps 8–11**, with the exact dashboard paths, commands and verification for each: https://claude.ai/code/artifact/f018d0f5-de0c-4afc-bcd9-80b2500655b3 — the procedures themselves are also written out in `docs/OPERATIONS.md` §5c (role), §5d (schedulers) and §6.7 (backup key), so this repository stays self-sufficient if that link is ever lost.

| 8 | **B4 — switch the app to the least-privilege role.** After the merge that carries migrations `20260914150000_audit_immutability` + `20260914160000_audit_maintenance_owner_only` is live: run **Actions → Provision app role → Run workflow** (it uses the `DIRECT_URL` secret, so nobody handles the owner credential; type the endpoint id to confirm), then set Vercel Production `DATABASE_URL` to the `nmwc_app` pooled URL (keep `DIRECT_URL` = owner), redeploy, check `checks.db: ok` on the bearer health probe. Steps in `docs/OPERATIONS.md` §5c. Do Preview/UAT first. | The audit trail becomes tamper-proof for the credential the app actually uses; a leaked `DATABASE_URL` can no longer run DDL or truncate tables. |
| 9 | **B5 — create the two external cron jobs** (owner decided D3 = external scheduler on 2026-09-14): keep-warm every 4 min and sla-escalate twice an hour, 03:00–14:59 UTC, `Authorization: Bearer <CRON_SECRET>`. Step-by-step table in `docs/OPERATIONS.md` §5d. Then point an uptime monitor at the bearer health probe, which returns 503 when any job is `stale` / `never` / `failed`. | Until a reliable scheduler calls it, the SLA escalation sweep does not run, and now you will SEE that. |
| 10 | **B3 — make the backups recoverable.** Generate an age key pair, set repository variable `BACKUP_AGE_RECIPIENTS` to the public key (add a second recipient held by someone else), store the private key in the password manager AND on paper, and put a copy in the secret `BACKUP_AGE_IDENTITY`. Add `NEON_API_KEY` and `NEON_PROJECT_ID`. Then run **Actions → Restore drill → Run workflow** and read the measured recovery time. Set the backup retention rule with `npx tsx scripts/ops/r2-backups-lifecycle.ts`. Full detail in `docs/OPERATIONS.md` §6.7. **This is now a prerequisite, not a hardening step:** without `BACKUP_AGE_RECIPIENTS` the nightly job REFUSES to upload and you have no backup at all. It used to upload a plaintext copy of the whole customer master and every password hash instead, warning about it inside a run that stayed green (DO-16), which is the worse of the two failures. | Nobody has ever restored this database. Until the drill passes, the recovery time is unknown and the encryption key is unproven — and a lost key means every backup is unrecoverable. |
| 11 | **B6 — answer the residency question before the data load, not after.** Fill the `[OWNER]` blanks in `docs/compliance/DATA-RESIDENCY-REGISTER.md` (both R2 bucket locations, the Sentry region, the account holder of record per vendor, where Temix runs) and send `docs/compliance/PDPL-ASSESSMENT.md` to counsel. | Once ~20,100 Omani customer records are loaded into a US database, a residency requirement becomes a cutover rather than a configuration change. This is the last cheap moment. |

## 1. Load day — the load (Data Steward, ~1 hour)

Everything happens in the production app, in this order. Do not skip a step; the
importer enforces most of the order, but not all of it.

1. **Create the Steward and the 11 Managers.** Neither can come from the app or a
   spreadsheet (the seeded `admin` is a Manager, Managers may only create field
   roles, and the import refuses admin-tier roles). Run once, from a machine with the
   **production** database URL:

   ```bash
   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/golive/bootstrap-accounts.ts golive-data/managers.json
   ```

   Use the **owner** connection — the same value Vercel holds in `DIRECT_URL`, not the
   `nmwc_app` one. After step 8 of the previous section, "the production URL" means two
   different things, and this script mints the first Data Steward.

   It creates `data.steward` plus the managers by name (`ahmed.alnadabi`, `haitham`,
   `sarath`, `sara.khayat`, `ashok`, `rashid`, `rasool`, `saqib`, `saud`, `sunil.kp`,
   `tharwat`), each with **their own initial password** read from `managers.json` (the
   same 12 values appear in `credentials.xlsx`, sheet *Create in app FIRST*) and a
   **forced password change at first login** — there is no single password for everyone
   any more (SEC-11). It skips any username that already exists and touches nothing
   else. Regions are assigned by the next step, not here.
2. Sign in as `data.steward` — you are sent straight to *change password* (12+ characters).
   Not `steward`: that exact username is blocked while `DEMO_ACCOUNTS_DISABLED=true`,
   which production sets, because the synthetic seed uses it for a demo account.
3. **Import → Account master** → `golive-data/account-master.xlsx`.
   Expect: 7 regions, 43 routes, 56 user rows applied. Open the issues list — it
   must be empty except for anything you already know about. Check **Users**: every
   manager now shows their regions; salesmen show their route and their manager as
   supervisor.

   Then check what **else** can sign in:

   ```bash
   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/golive/audit-accounts.ts
   ```

   Nothing in this load removes an account. Step 1 skips a username that already
   exists, and the account-master import never deactivates anyone the sheet does not
   name — both deliberately, so a re-run is safe. The consequence is that every
   account created before today survives the load, and this database was seeded in
   May with pilot accounts, one of them a **Steward**. The passwords those were
   issued with can be recovered from the repository's history. The script only reads:
   it lists every account the master does not name, most privileged first, and exits
   non-zero if any of them can still sign in. **Deactivate or reset each one from
   Users before you hand out a single login** — a reset also kills that account's
   live sessions.
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
   code** (`c4`, `sh01`, `nizd` …), every manager's is their name. **Each account now
   has its own 8-digit initial password** (SEC-11) — there is no single password for
   everyone. The values are in `credentials.xlsx`: sheet *Create in app FIRST* (the
   Steward and the 11 managers) and sheet *Created by import* (the salesmen and the
   approver accounts). **Hand over one row per person, and never show the sheet to a
   room** — it is the whole company's credentials on one screen. If a manager also
   sells a route they have **two logins with two different passwords**; both rows are
   in the file, so give them both and say so, or they will try the wrong one.

   The app still forces each person to choose a new 12+-character password the first
   time they sign in, and their 8-digit value stops working at that moment — so **sit
   with each person while they sign in and change it**. That screen (English only, 12
   characters minimum, no show-password toggle) is the step most likely to stall;
   budget time for it. Ask the Steward to check **Users** the next morning for anyone
   who has not signed in (their account still shows the forced-change flag). If a slip
   is lost, reset that one account from **Users → Reset password** — note the value
   you type there must itself be 12+ characters, it is not another 8-digit code, and
   the reset re-arms the forced change and kills the account's open sessions. Delete
   `credentials.xlsx` and `managers.json` when you are done.

   > ⚠ **OWNER DECISION, still open — how the slips reach people.** Printed slips
   > handed over in person by each regional manager is the only channel that needs no
   > new system and that works for a salesman who does not read English well: the
   > password is digits only, and the one English string on the slip is his own route
   > code, which he uses every day. SMS would need an Oman A2P sender registered with
   > the TRA, staff mobile numbers this pipeline does not have (the Users sheet writes
   > `phone` blank for every row), and it delivers the secret into a shared phone's
   > message list. Decide before printing anything.

## 2. If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| Account master lists issues for salesman rows: *route "X" not found* | A route code in the Users sheet is not in the Routes sheet. | Rebuild the files; the builder guarantees consistency. |
| Account master upload fails with a timeout / gateway error | The Users sheet creates ~95 accounts in one request, each with a deliberately slow password hash; on a slow day that can brush the 60-second request limit. | Nothing is lost — whatever was applied stays applied. Split the **Users** sheet in two (keep Regions/Routes in both, they are idempotent) and upload each half. Re-importing an already-created user is safe: it keeps their password. |
| Many customer rows QUARANTINED for *duplicate phone* | A phone shared across customers that the builder did not catch. | Review; if genuine duplicates, merge later — they will not block the rest. |
| Promote stops with *"Stopped — N rows made no progress"* | Repeated technical failures on the same customers. | Do not keep clicking. Screenshot and call IT. |
| Promote refused: *"Another customer import is being promoted"* | Someone else (or an earlier tab) holds the batch. | Wait a minute and resume; only one load runs at a time by design. |
| `audit-accounts` exits non-zero and lists accounts under *CAN SIGN IN* | **Expect this the first time.** It is not a failure of the load. This database was seeded in May, and nothing in the load removes an account — so `pilot.steward`, `pilot.manager`, `ahmed.alndabi` and the ten `<route>-12345-nmwc` salesmen are still there, with passwords that are literals in `prisma/seed-muscat-pilot.ts`. | Deactivate or reset each one from **Users** before handing out a single login, then re-run the script until it prints *OK*. A reset also kills that account's live sessions. Do not skip it because the load itself succeeded. |
| `audit-accounts` says a managers.json or account-master file is missing | You have not rebuilt the go-live files on this machine, or you are in the wrong directory. | Run `npx tsx scripts/golive/build-masters.ts` first (see the preamble), then re-run. |
| The load is wrong and must be undone | — | Restore production from the Neon branch taken in step 0.7. |

## 3. What the load does NOT do (by design)

- Bulk-loaded customers **do not pass through the approval chain** (SOP §8.5).
- No photos, GPS, sub-channel, equipment counts — the field team captures those.
- A branch planned on several days carries only its **first** visit day.
- Customers dormant in the July master **and** absent from RoutePro were not loaded
  (`dq/codebranch-dormant-not-loaded.csv`, 154 customers).

## 4. After the load — the update flow (verified 2026-09-10)

This is what the field force does from Sunday on, and what was walked end to end in a
real browser against the UAT data (`tests/e2e/golive-update-flow.spec.ts`) and in the
service layer (`tests/integration/golive-update-flow.test.ts`):

1. **Salesman** signs in with the route code → forced password change → **Today** shows
   the journey-plan customers for the weekday and a link to **All my customers** (only
   ~1 in 3 branches has a JP day, so the full list matters). **Customers** searches by
   shop name, customer code, branch code (`CAK0240-AK2`), branch name or phone, and only
   ever shows that route.
2. Open a customer → **Enrich** → capture **GPS** (device location; manual entry with a
   reason if the phone cannot), take the **photos** (camera → compressed to JPEG →
   uploaded straight to R2 → attached to the slot), fill the fields → **Submit for
   approval**. The submit button unlocks the moment the required photos are attached —
   no page reload.
3. **Manager** (the salesman's direct supervisor — there are no Supervisor accounts)
   sees it under **Approvals** (now in the Manager menu) and on the dashboard KPI; the
   review page shows the before/after diff (channel names, not ids), the **current
   photos** and an **Open in Google Maps** link for the location on file and for the
   proposed one; **Approve** applies it, **Reject** sends it back with a reason and the
   salesman sees it under **Needs correction**. Every step writes an audit row and an
   in-app notification.
4. **Owner / Steward / Manager** — **Export → Field-update report**: every customer in
   the chosen regions/routes (one row per branch, the import shape) with each cell a
   salesman changed **in the chosen window** highlighted **yellow** (hover the cell for
   *was → now, by whom, when*), cells with a proposal still awaiting approval
   **orange**, photos added in the window yellow; sheet 2 lists every change, sheet 3
   the totals per salesman, sheet 4 the legend. Unhighlighted = not touched. Managers
   get their regions, Supervisors their team routes, the Steward everything.

**Coverage check (dashboard window of 56 days to 2026-08-08):** 3,068 customers had
invoices; **3,065 are in the master**, 3,054 on a live salesman's route. The 11 on
UNASSIGNED are the two generic `CASHCUST`/`COUPCUST` codes plus 9 small customers on
parked routes (S20 ×4, SL04 ×2, NZ04, S04, WHS-); 3 tiny S07 customers (OMR 118
together) are not in RoutePro at all. Nothing with sales was loaded as CLOSED.

**Bugs this verification found and fixed (all in the branch):** the **first-login
password change could not be completed** — the login landed on `/home`, the forced
redirect left the address bar there, and the change-password form then posted to a URL
the middleware redirected ("An unexpected response was received from the server"); the
login form itself still refused **two-character usernames** (C1–C9, W) although the
account policy had been relaxed everywhere else; a tap on *Sign in* before the page
had finished loading put the username **and password into the URL**; photo attach
could die with *Transaction already closed* on a slow link (Prisma's 5 s default — now
20 s app-wide); a salesman's **CR number on a CASH customer was dropped at approval**,
and the approval then failed with *CR number is required* (the two field locks were
still evaluated together); the Submit button stayed disabled after taking the photos
until the page was reloaded; the Manager menu had no **Approvals** entry; the review
page showed no photos and no map; **Download all** was refused above 10,000 rows (the
master is 20,129); every exported phone number came out as `'+968…` (formula guard);
and nothing hydrated on a local `next dev` server (CSP without `'unsafe-eval'` in
development), which is why no browser walk had ever been run before.

**Mandatory fields — decided 2026-09-10 (owner): CORE.** A salesman can submit once
**phone, contact person, address, GPS and the shop-front photo** are present; channel
comes from the import. Sub-channel, CR number, CR document photo, day of visit and the
signboard photo stay on the form and count toward completeness but do not block
submit — the imported data has none of them, and most customers are individuals /
home-delivery addresses with no CR and no signboard. The stricter enrichment-campaign
rule (all of the above) is one Vercel environment variable away:
`SALESMAN_SUBMIT_GATE=FULL` (no deploy needed).
