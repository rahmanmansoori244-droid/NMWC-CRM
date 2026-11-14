# Go-live clean start: the owner's steps

This is your step-by-step for the clean start. You press every button yourself, in
GitHub. Claude never presses them.

What the clean start does (your decision of 2026-11-11):

- It removes all test customer data from the live CRM: customers, shops, photo records,
  requests, imports, exports, Temix batches, notifications, saved filters.
- It removes the test-period logs and history: the Audit page, sign-in records, job
  records, integrity results and seals.
- It keeps every account (the hidden zz.test accounts too), every route and region
  (ZZTEST too), the manager links and the channels. They are not changed at all.
- The test photos themselves are deleted later, at least 7 days after, in a separate step.
- After it, you load the real customer file through the Import screen.

The technical description is `docs/OPERATIONS.md`, section 5m. You do not need it.

---

## The rules (read these first)

1. **Never type anything into a run form except what this guide says.** The repository is
   public. What you type into a run form can be seen by anyone.
2. **Never paste a key, a password or a connection string** into a chat, an issue, a run
   form or an e-mail. Secrets go only into GitHub's secret boxes.
3. **Never press Approve on a run you did not start yourself, just now.**
4. **Never start `apply` again after a red `apply`.** Send Claude the link first.
5. **Never cancel a run while its Apply job is running.**
6. **Nobody uses the CRM** from the moment you start DB Backup until the run is green.
   Not even you, and not someone who is still signed in on a phone. One sign-in or one
   save changes the database, and the run then stops itself. Before reset day every
   tester signs out on every phone and browser (Step 1 L).
7. **No other merges to main** in the week of the clean start.
8. **No test walk on the live CRM after the reset** until the first real customer exists.
   Otherwise the test customer takes the number NMWC-2026-000001.
9. **Never use Neon's Restore after the photo step.** The records would point at photos
   that no longer exist.
10. **In Neon, never delete the production branch.** Delete only a branch whose name
    starts with `cleanstart-rehearsal-`, and only when this guide says so. After a
    confirmed going back, Claude tells you which other branch may go (see the end of
    "If you must go back").

---

## How to start a run (you will do this many times)

1. Open the repository on GitHub. Click the **Actions** tab.
2. In the list on the left, click the workflow (for example **Clean start**).
3. On the right, click **Run workflow**. A small form opens.
4. Leave **Use workflow from** at **Branch: main**. Never change it.
5. Fill in the boxes as the step says. Leave the other boxes empty.
6. Click the green **Run workflow** button.
7. After a few seconds the run appears at the top of the list, for example
   **Clean start dry-run**. Click it.

**How to read a run.**

- Each job has a green tick (good), a red cross (stopped), a yellow circle (running) or
  is grey (skipped). Grey is normal: each mode uses only some of the jobs.
- Click **Summary** (top left) and scroll down. Each job writes its lines there, like
  `backup equals production: yes`.
- A stopped job shows a bold line starting with **refused:**. That line says why.

**How to approve a run.** Some jobs wait for you. The run then shows **Waiting for
review** and a button **Review deployments**.

1. Click **Review deployments**.
2. Tick **production-reset**.
3. Click **Approve and deploy**.

**The run id.** Some steps ask for a run id. It is the long number in the address bar of
the run's page, after `/runs/`. The apply run also prints it in its summary, as
`run_id for the photo step: <number>`. It is not the short number with a `#`.

**The boxes of the Clean start form**, as GitHub shows them:

| Box (its label) | What you type |
|---|---|
| `dry-run (changes nothing) \| neon-rehearsal \| apply \| finish \| seal-restore` | choose the mode the step names |
| `The production host marker, typed (the first part of the database host)` | `ep-sweet-haze` (every time, every mode) |
| `apply only: REMOVE ALL TEST DATA followed by today's date in Oman (YYYY-MM-DD)` | only in mode apply, for example `REMOVE ALL TEST DATA 2026-11-18`; otherwise empty |
| `finish and seal-restore only: the number of the apply run` | only in mode finish or seal-restore: the apply run's id; otherwise empty |

---

## Step 1. One-time setup (about 1 hour, a week before)

Do these in order. Never show a key to anyone. Tick each one off in your private notes.

**A. The approval rule.**
GitHub → the repository → **Settings** → **Environments** → **New environment**.
Name it exactly `production-reset`. Tick **Required reviewers** and add your own
account. Leave **Prevent self-review** unticked. Under **Deployment branches and tags**
choose **Selected branches** and add `main`. Save.

**B. A read-only photo token.**
Cloudflare → **R2** → **Manage R2 API Tokens** → **Create API token**.
Permission **Object Read only**. **Apply to specific buckets only**: `nmwc-photos`.
TTL 60 days. Create it.
Then GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository
secret**. Add two secrets: `CLEANSTART_R2_RO_ACCESS_KEY_ID` and
`CLEANSTART_R2_RO_SECRET_ACCESS_KEY`. These are repository secrets.

**C. A read-and-write photo token.**
Cloudflare, a second token: **Object Read & Write**, `nmwc-photos` only, TTL 60 days.
Then GitHub → **Settings** → **Environments** → **production-reset** → **Add environment
secret**. Add `CLEANSTART_R2_RW_ACCESS_KEY_ID` and `CLEANSTART_R2_RW_SECRET_ACCESS_KEY`.
These are environment secrets, not repository secrets.

**D. A Neon key.**
Neon console → **Account settings** → **API keys** → **Create new API key**.
Neon → your project → **Settings** → **General** → copy the **Project ID**.
Add both as environment secrets of **production-reset**: `NEON_API_KEY` and
`NEON_PROJECT_ID`. (Repository secrets with the same names may already exist, for the
monthly restore drill. Leave those as they are.)

**E. Your name for the record.**
Add the repository secret `CLEANSTART_ACTOR_USERNAME`. Its value is the login name of your
own CRM account. It is recorded as the person who did the clean start. It must be an
active account, not a zz.test one.

**F. Check that these already exist** (names only; do not open them).
Repository secrets: `DIRECT_URL`, `BACKUP_AGE_IDENTITY`, `BACKUP_R2_ACCOUNT_ID`,
`BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`,
`PROD_CRON_SECRET`, `HEALTH_BEARER`. Repository variables: `BACKUP_AGE_RECIPIENTS` and
`APP_BASE_URL` (the live site's address, which the runs call).
If `BACKUP_AGE_IDENTITY` is missing, add it yourself from your handover pack. Never show
it to anyone. You do **not** need `PROD_DB_HOST_MARKER`: nothing reads it any more.
The first dry run also names any missing setting, in a line like
`setting CLEANSTART_ACTOR_USERNAME present: no`.

**G. Only if it applies.** If the photo bucket is in a different Cloudflare account from
the backups: add the repository secret `R2_ACCOUNT_ID`. If the photo bucket is not called
`nmwc-photos`: add the repository variable `R2_BUCKET`.

**H. Look, without changing anything,** at Cloudflare → **R2** → `nmwc-photos` →
**Settings**. Tell Claude three things: is **Object versioning** on; which **lifecycle
rules** are listed; is there any **bucket lock** rule.

**I. Look at Vercel** → the project → **Settings** → **Git**: the Production Branch
should be `main`. Then **Settings** → **Environment Variables**: `DATABASE_URL` and
`DIRECT_URL` for **Preview** and **Development** must not contain `ep-sweet-haze`. Tell
Claude yes or no.

**J. Optional, for the photo step.** A read-only connection string of the test
environment's database, as the environment secret `UAT_DATABASE_URL_RO` of
**production-reset**. With it, photos the test environment also uses are kept. Without
it, the photo step still works.

**K. Your operations log.** In your private handover pack, start the entry: the date,
"go-live clean start", your decisions, "I authorise it". Leave space for the run link,
the plan id and the results. The Audit page shows that the clean start happened and why,
but **not** how many records of each kind were removed: those figures are only in the
run's encrypted report. If you want them in your log, Claude reads the report with you
after the reset.

**L. Everyone signs out.** Before reset day, every person who tested the CRM presses
**Sign out** on every phone and computer they used. Signing out also deletes the unsent
copies of forms that a phone keeps for 7 days; otherwise a test request saved during
testing could be sent after the reset and become a real-looking request.

**M. The merge.** When Claude says the pull request is green, reply "merge it". After the
merge, wait about 15 minutes for the live site to update before the first dry run.

---

## Step 2. Dry run 1 (an evening; it changes nothing)

Do it in the evening, between 19:30 and 23:00 Oman time, when nobody uses the CRM. A run
started in the evening refuses a backup taken earlier that day (before 19:00 Oman), so
always start with a fresh DB Backup.

1. Actions → **DB Backup** → **Run workflow** → **Run workflow**. Wait for the green tick
   (about 5 minutes).
2. Actions → **Clean start** → **Run workflow**. Mode `dry-run`. Host box `ep-sweet-haze`.
   Phrase box empty. Run id box empty. Click **Run workflow**.
3. Wait about 20 minutes. Do not sign in to the CRM meanwhile.

**Green looks like this.** Both **Plan (read-only)** and **Rehearse on the restored
backup** have a green tick. In the summary you see, among others:

- `connection is production, named by the owner: yes`
- `production serves this run's commit: yes`
- `environment production-reset has a required reviewer: yes`
- `plan checks: ok`
- `backup equals production: yes`
- `reset on the restored backup: ok`
- `verify on the restored backup: ok`
- `first integrity checks as expected: yes`
- `the nightly backup's table gate passes on the reset copy: yes`
- `next customer code would be number 000001: yes`

Some lines report a fact and may say `no` while the run is still green. They are listed
at the end of this guide, under "Lines that may say no".

**Write down** (in your private notes) the line that starts with
`first nightly backup would be below the size floor:`. If it says `yes; set
MIN_DUMP_BYTES to …`, you will need that number on reset day. If it says
`yes; even 20000 bytes is too high, ask before the reset`, tell Claude before reset day.

Send Claude the run link. After dry run 1, Claude reads the run's encrypted plan file
with you. It answers two of your questions that the public summary must not show:
whether any Temix upload was marked as loaded (test NMWC codes may then be in the real
Temix), and whether an UNASSIGNED region or route exists.

**If it is red:** see "When something is red" below. If the red line is
`backup equals production: no`, someone used the CRM after the backup. Make sure nobody
does, then run DB Backup again and the dry run again.

---

## Step 3. The Neon dress rehearsal (once, any day after the merge)

It copies the live database to a temporary Neon branch, does the clean start there,
proves Neon can put it back, and deletes the copy. The live CRM is not changed.

It must be green, with the same scripts, within 14 days before reset day. If Claude
changes the clean-start scripts after it, you do it again.

1. Actions → **DB Backup** → **Run workflow**. Wait for green. (This run also needs a
   backup of at most 4 hours.)
2. Actions → **Clean start** → **Run workflow**. Mode `neon-rehearsal`. Host box
   `ep-sweet-haze`. Phrase and run id empty. **Run workflow**.
3. When the run shows **Waiting for review**: **Review deployments** → tick
   **production-reset** → **Approve and deploy**.
4. Wait about 20-30 minutes.

**Green looks like this.** **Plan (read-only)** and **Neon rehearsal** are green, and the
summary has:

- `Neon default branch is production: yes`
- `Neon branch host is not production: yes`
- `reset on the Neon branch: ok`
- `first integrity checks as expected: yes`
- `Neon made a copy of the branch as it was at the noted time: yes`
- `the reset row is gone after the restore: yes`
- `the Neon restore returned the exact fingerprint: yes`
- `temporary Neon branches deleted: yes`

**Afterwards:** Neon console → your project → **Branches**. No branch whose name starts
with `cleanstart-rehearsal-` may be left. If the run said
`a temporary Neon branch is left; delete it by hand in the Neon console (Branches)`,
delete that branch (only that one) and tell Claude.

---

## Step 4. Dry run 2 (the evening before reset day)

Repeat Step 2 exactly. It must be green again.

---

## Step 5. Reset day

Choose a weekday evening. Start between **19:30 and 22:00 Oman time**, and press
Approve within 10 minutes of **Waiting for review**. The reset itself comes about 35-45
minutes after you start (it must come before midnight Oman time, because the phrase holds
today's date); the whole run, to the last green tick, takes about 75-90 minutes. A late
start is refused safely (`the target guard refused`), but the evening is lost.

1. **Write the entry in your private operations log first:** the date, "go-live clean
   start", that you authorise it, and why.
2. **Tell staff not to open the CRM** until you say so. Do not sign in yourself.
3. Actions → **DB Backup** → **Run workflow**. Wait for the green tick.
4. Actions → **Clean start** → **Run workflow**:
   - mode `apply`;
   - host box `ep-sweet-haze`;
   - phrase box `REMOVE ALL TEST DATA` and today's date in Oman, for example
     `REMOVE ALL TEST DATA 2026-11-18` (capital letters, one space between words, the
     date as year-month-day);
   - run id box empty.
   Click **Run workflow**.
5. Wait until **Plan (read-only)** and **Rehearse on the restored backup** are green (about
   20 minutes). If either is red: stop. Send Claude the link. Nothing has changed.
6. The run shows **Waiting for review**. Click **Review deployments** → tick
   **production-reset** → **Approve and deploy**. **This click is your yes.**
7. Wait about 10 minutes for **Apply (the owner's approval)**. Do not touch anything.

**Green looks like this.** The Apply job has a green tick, and its summary says:

- `production unchanged since the plan: yes`
- `Neon default branch is production: yes`
- `Neon branch created and confirmed: yes`
- `old seals archived, re-read and chained: yes`
- `reset started at (UTC): …` and `reset started at (Oman time): …` (write both in your
  log)
- `reset: ok`
- `reset committed: yes`
- `kept accounts, routes and regions verified after the reset: yes`
- `old seal files removed from the live folder, each with a verified archive copy: yes`
- `integrity watch ran on production: yes`
- `seal-written: info` (the new first seal)
- `first integrity checks as expected: yes`
- `smoke ok: yes`
- `run_id for the photo step: …` and `list_sha256 for the photo step: …`
  (copy both into your log; you need them in Step 8)
- `Neon safety branch kept: yes`

If there were other files in the seal folder, the summary also has
`seal-offsite-copies: fail`. That is expected and explained. You will get **one critical
integrity alert tonight** because of it. Note it in your log; do nothing about it.

**If it is red:** do not press anything again. Send Claude the link. The summary says
whether the reset happened: `reset committed: yes`, or `reset committed: no (nothing
changed)`, or `reset committed: unknown`. For `unknown`, see "When something is red".
When Claude says to run **finish**, run it **the same evening, before 06:00 Oman time**
(the nightly integrity check runs at 06:30). If that time has passed, tell Claude before
you press anything: the night's check will then have reported the old seal files as one
unexplained critical alert.

**The size of tomorrow's backup.** If your dry run said
`first nightly backup would be below the size floor: yes; set MIN_DUMP_BYTES to …`, do
this tonight: GitHub → **Settings** → **Secrets and variables** → **Actions** →
**Variables** tab → **New repository variable**. Name `MIN_DUMP_BYTES`, value the number
from that line. Save. (The automatic backup runs at about 06:00 Oman.)

**Check in the browser** (after the green tick):

1. Sign in with your own account. Then sign in with one zz.test account.
2. Users, Routes and Regions look as before. ZZTEST is still there.
3. Customers is empty.
4. **Service status** → **Integrity**: every line is pass or information. The one
   exception allowed is "The off-site copies of the seals are there" when the summary
   showed `seal-offsite-copies: fail`.
5. **Audit**: the clean-start entry is the only row before your sign-ins, with its reason.
   Write in your private operations log that you saw it, with the run link. (The page
   does not show how many records were removed; see Step 1 K.)
6. Tell staff the CRM is open again, but no new customers yet.

---

## Step 6. The next morning

1. **Service status** → **Integrity**: "Tonight's seal was written" is pass. Nothing is
   failing.
2. Actions → **DB Backup**: last night's run has a green tick.
3. **Requests** is empty. If a request is there, it was sent from a phone that kept a
   test form: tell Claude before the import.
4. Only now load the real customer file through the **Import** screen. Check the preview
   first: the codes should be in capital letters, like CCT0005. Two things on the batch
   page are expected and are not faults:
   - A customer code or Temix code typed in small letters is read in capitals. The row
     says "Code in capitals", and "Before you promote" counts such rows.
   - A row whose shop code only looks like another shop of the same customer (for
     example 1 and 01, which Excel can cause) is held back. Correct the code on the
     batch page, or leave the row out. If they really are two different shops,
     "Different shop: release…" lets the row through with a typed reason. If you are
     unsure, ask Claude first.

Until Claude's small follow-up change lands (planned for the day after the reset), the
dashboards' "up/down" comparisons that reach back before the reset day compare with
empty days. Read the comparisons from the reset day on.

**From this import on there is no way back** for the database. Mistakes are then fixed
forward.

After the real import, look at the next nightly **DB Backup** run (only if you set
`MIN_DUMP_BYTES`): open its log and find the line with `compressed size`. When that size
is at least 80000 bytes, delete the variable: GitHub → **Settings** → **Secrets and
variables** → **Actions** → **Variables** → delete `MIN_DUMP_BYTES`. The normal size check
then returns. A green backup alone does not prove it (it passed the lowered floor); if
you are unsure, send Claude the link and Claude confirms.

---

## Step 7. When something is red

Find the bold **refused:** line in the summary.

| The line says | What it means | What you do |
|---|---|---|
| `a setting this mode needs is missing (named above)` or `the setting … is missing` | a secret is missing; the line names it | add it (Step 1), then start again |
| `the run is not on the default branch` | the form was not on main | start again with **Branch: main** |
| `apply runs only between 15:30 and 23:30 UTC` | too early or too late | start between 19:30 and 22:00 Oman (Step 5): the check allows 19:30 to 03:30 Oman, but the reset must also come before midnight Oman, because the phrase holds today's date |
| `confirm_host does not name the production host` | the host box is wrong | type `ep-sweet-haze` exactly |
| `the target guard refused (production, confirm_host and the phrase are checked together)` | the phrase is wrong, or it is past midnight in Oman | check the phrase and the date; start again (from DB Backup) |
| `production does not serve the commit this run checked out` | the live site has not finished updating | wait 15 minutes and start again; if it stays, send Claude the link |
| `environment production-reset has no required reviewer` | Step 1 A is not done | do Step 1 A |
| `a DB Backup run is in progress; wait for it and start again` | a backup is running | wait for it, then start again |
| `run DB Backup first: the newest dump is too old` | the backup is older than allowed | run DB Backup, then start again |
| `a newer dump exists than the one the rehearsal restored; start again` | a backup ran during the run | start again |
| `backup equals production: no` or `production unchanged since the plan: no` | someone used the CRM | make sure nobody does; DB Backup again; start again |
| `no green neon-rehearsal of these exact scripts in the last 14 days` | the dress rehearsal is missing or too old | do Step 3 again |
| `the newest dump was taken before 19:00 Oman; run DB Backup again now, then start again` | the backup is from earlier today | run DB Backup, then start again |
| `DB Backup heartbeat ok within 4 h: no` (or `6 h`) | the CRM has not seen the last backup | send Claude the link |
| `runtime role privileges not failing on production (latest watch): no` | the nightly check found a wrong database permission | send Claude the link; it must be fixed before the reset |
| `reset committed: unknown (no connection); run mode finish with this run id` or `reset committed: unknown (the check did not finish); run mode finish with this run id` | the answer was lost | run **finish** (below), the same evening |
| `the real customer file is loaded (customers exist): no` (photos) | the real file is not loaded yet | load it first (Step 6) |
| `the new seal chain's id of that run was not recorded, so no seal file is moved; tell Claude` (seal-restore) | | send Claude the link |
| anything else | | send Claude the link; do not press anything |

Every refusal before the line `reset started at (UTC)` means nothing changed.

**Mode finish** (only when Claude or the summary says so): Actions → **Clean start** →
**Run workflow**. Mode `finish`. Host box `ep-sweet-haze`. Phrase empty. Run id box: the
id of the apply run. **Run workflow**, then **Review deployments** → **Approve and deploy**.
Run it the same evening, before 06:00 Oman time; if that has passed, tell Claude before
pressing anything. It first finds out whether the reset happened. If it did, it completes the remaining
steps and its summary says `reset committed: yes` and the same lines as a green apply. If
it did not, it says `reset committed: no (nothing changed)` and stops in red with
`the reset of that run did not commit; nothing changed on production`. That red is the
answer, not a fault. Send Claude the link either way.

---

## Step 8. The photo step (day 7 or later)

Only when you are sure you will never go back: the real file is loaded and checked, and
at least 7 full days have passed since the reset. **It cannot be undone.**

1. Actions → **Clean start photos** → **Run workflow**. Fill in:
   - `The number of the clean-start apply run (from its summary)`: the `run_id for the
     photo step` from your log;
   - `list_sha256 from that run's summary`: the `list_sha256 for the photo step` from
     your log (64 letters and digits; copy it exactly);
   - `The production host marker, typed`: `ep-sweet-haze`;
   - `Exactly: DELETE TEST PHOTOS`: `DELETE TEST PHOTOS`.
   Click **Run workflow**.
2. **Review deployments** → tick **production-reset** → **Approve and deploy**.

**Green looks like this.** The job **Delete the test photos (the owner's approval)** is
green, and the summary says:

- `the reset is at least 7 days old: yes`
- `the stored list, the typed value and the reset row agree: yes`
- `production references none of the listed photos: yes`
- `temporary Neon branches deleted: yes` (this is the Neon safety copy; if it was
  already gone, the line is `Neon branches to delete: no`)
- `every photo to delete is confirmed gone: yes`
- `photo deletion recorded in the audit log: ok`

Note it in your operations log. If it is red, send Claude the link. A refusal before
`temporary Neon branches deleted` means nothing was deleted.

---

## Step 9. Clean up (after the photo step)

1. Cloudflare → **R2** → **Manage R2 API Tokens**: delete the two tokens you made in
   Step 1 B and C.
2. Neon → **Account settings** → **API keys**: delete the key you made in Step 1 D.
3. GitHub → **Settings** → **Secrets and variables** → **Actions**: delete the repository
   secrets `CLEANSTART_ACTOR_USERNAME`, `CLEANSTART_R2_RO_ACCESS_KEY_ID` and
   `CLEANSTART_R2_RO_SECRET_ACCESS_KEY`.
4. GitHub → **Settings** → **Environments** → **production-reset**: delete its secrets
   `CLEANSTART_R2_RW_ACCESS_KEY_ID`, `CLEANSTART_R2_RW_SECRET_ACCESS_KEY`, `NEON_API_KEY`,
   `NEON_PROJECT_ID` and `UAT_DATABASE_URL_RO` (if you added it).
5. Do **not** delete the environment **production-reset** itself, and do not delete the
   repository secrets `NEON_API_KEY` and `NEON_PROJECT_ID` if they exist (the monthly
   restore drill uses them).

---

## If you must go back (only before the real file is loaded)

Do this only with Claude, and only before Step 6's import.

Do it in one evening, before 06:00 Oman time: the nightly integrity check at 06:30 must
not run between the restore (step 2) and seal-restore (step 3), or it raises a critical
alert about the new seal files.

1. Tell staff not to use the CRM.
2. Neon console → your project → **Branches** → the production branch → **Restore**.
   Your log has the start of the reset in both zones: `reset started at (UTC)` and
   `reset started at (Oman time)`. Look at the time zone the Neon screen shows next to
   the time box, take the line in that zone, and choose one minute **before** it. With
   the wrong zone you restore 4 hours too early (test changes of that afternoon are lost)
   or 4 hours too late (the reset is still there, and seal-restore then refuses). If
   unsure, send Claude a screenshot first. Confirm the restore.
   (If that is not possible, Claude helps you restore from the branch named
   `pre-clean-start-<date>-<run id>` instead.)
3. Straight after: Actions → **Clean start** → **Run workflow**. Mode `seal-restore`.
   Host box `ep-sweet-haze`. Phrase empty. Run id box: the apply run's id. **Run
   workflow**, then **Review deployments** → **Approve and deploy**. Green shows
   `production is back to before the reset (old chain, no reset row): yes`,
   `old seal files back in the live folder, hash-checked: yes`,
   `the abandoned new chain moved out of the live folder: yes` and
   `a check failing or in error: no`. If a check is failing, the job is red: send Claude
   the link before anyone uses the CRM. One exception keeps it green: when the test
   environment's files sit in the seal folder, the summary shows
   `seal-offsite-copies: fail` and
   `seal-offsite-copies failing only for objects outside the old chain (checked above): yes`.
   Tell Claude; it is expected.
4. If you set `MIN_DUMP_BYTES`, delete it.
5. Tell Claude. When Claude confirms the going back is complete, staff may use the CRM
   again (as during testing).
6. Afterwards, with Claude: Neon console → **Branches**. Two copies of production are
   left: `pre-clean-start-<date>-<run id>` (the safety copy) and the copy Neon kept of the
   branch before your restore (Neon shows its name after the restore). Claude tells you
   when, and which ones, to delete. Never delete the production branch itself.

---

## Lines that may say no

These lines report a fact. They can say `no` (or `yes`) while the job is green:

| Line | What it tells you |
|---|---|
| `old seal chain present` | whether the test period had seals |
| `an old seal copy is missing (its body is archived from the export)` | `yes` is fine: the copy is rebuilt from the database |
| `other objects under seals/ (reported once on the first night)` | `yes` means one expected critical alert on reset night |
| `old seal chain verifies on the restored backup` | recorded only |
| `dump of the reset copy at least … bytes` | how small the first backup will be |
| `first nightly backup would be below the size floor` | `yes` means: set `MIN_DUMP_BYTES` on reset day |
| `branch equals production's plan` (dress rehearsal) | recorded only |
| `Neon history kept at least 7 days` | `no`: tell Claude; going back then uses the safety branch |
| `read-only test environment connection set` (photos) | `no` if you skipped Step 1 J |
| `test environment checked for shared photos` (photos) | the same |
| `keys skipped because they do not have the photo shape` | recorded only |
| `keys kept because the test environment uses them` | recorded only |
| `a check failing or in error` (seal-restore) | `no` is the good answer; `yes` makes the job red, unless the only failing line is `seal-offsite-copies` (see "If you must go back") |
| `old seals to archive` and `old seal files to remove` | `no` when the test period wrote no seals |
| `Neon branches to delete` | `no` when there was nothing to delete |
| `job runs recorded for yesterday in Oman`, `job runs recorded for today in Oman` | recorded for Claude |
| `a windowed job ran outside 03:00-15:00 UTC in the last 3 days` | `yes` means the old outside scheduler may still be on; tell Claude |
| `green Neon rehearsal of these scripts within 14 days` (dry run) | `no` before Step 3 is normal; apply needs `yes` |
| `the first watch after the reset already ran` (finish) | recorded; finish runs it when `no` |
| `new seal chain id recorded` | `no` only if the first check did not run; tell Claude |
| `other objects under seals/ left where they are` (seal-restore) | recorded only |

Every other `<something>: no` line, and every bold **refused:** line, means stop and send
Claude the link.
