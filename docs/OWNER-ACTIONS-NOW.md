# What needs you — 2026-09-20

Launch is this week. Everything that could be done without a decision from you is
done and deployed. This is the rest, in the order it should be done, with what
happens if it is skipped.

The detail for each lives in `GO-LIVE-RUNBOOK.md` §0 and `OPERATIONS.md`. This page
exists so you do not have to find them.

---

## 1. The age key — you have had no backup since 16 September

**This is the only thing currently failing, and it is the cause of the "Run
failed: DB Backup" emails.** Four nightly runs have refused to upload. That is a
change I made deliberately: the job used to upload a plaintext copy of the entire
customer master and every employee password hash to object storage, warn about it
inside a run that stayed green, and repeat every night. It now refuses instead.

**You are not currently unprotected.** Neon point-in-time recovery covers the last
7 days to any instant (`OPERATIONS.md` §6.4), so the four missing dumps are still
recoverable today. That window closes on 23 September, and it does not survive the
customer-master load — after the load you want a dump.

~5 minutes:

```bash
age-keygen -o nmwc-backup.key
```

- Put the **public** key (the `age1…` line) in the repository **variable**
  `BACKUP_AGE_RECIPIENTS` — Settings → Secrets and variables → Actions →
  **Variables**, not Secrets. A value on the wrong page reads as empty.
- Put the **private** key in the password manager **and** on paper, off this
  machine. A lost key makes every future backup unrecoverable.
- Put a copy of the private key in the **secret** `BACKUP_AGE_IDENTITY`, which is
  what the restore drill decrypts with.
- Then Actions → **DB Backup** → Run workflow, and confirm the object in the
  bucket ends `.sql.gz.age`. The `.age` suffix is the proof it was encrypted.

`npm run ops:print-secrets` prints the whole list with the variables page first.

---

## 2. Rebuild the go-live files — the current ones name an account that cannot sign in

```bash
npx tsx scripts/golive/build-masters.ts
```

The builder issued the Data Steward as `steward`. Production refuses that exact
username, because demo accounts are disabled there and the synthetic seed owns
that name. You would have created the account, been told "invalid username or
password" at step 2 of the load, and had no way forward inside the application —
the account import is Steward-only, a Manager cannot reset a Steward, and the
fallback `admin` is refused too.

It is now `data.steward`, and a test checks every username the builder emits
against that list. **Your existing `golive-data/` files still say `steward`**, so
they must be rebuilt. The builder now moves the old credentials file aside as
`.superseded-<timestamp>` rather than overwriting it, so nothing is lost.

---

## 3. Smoke the deployment before you load anything

```bash
npm run smoke
```

Fourteen checks, no credentials, fifteen seconds. It must say `all 14 checks
passed`. It passes right now. Run it again after step 4, because that changes the
live application's configuration.

And after the load, the data-level companion:

```bash
DIRECT_URL='<the OWNER connection string>' npm run verify:load
```

Twelve read-only checks against the database. The in-app reconcile proves the
batch balanced; this asks whether the rows actually landed. A customer can be
counted as promoted and still have no branch, no route and no visit day — that is
exactly what the narrow ERP refresh lane used to produce, and the reconcile
balanced anyway.

It will also tell you **how many branches on a worked route have no visit day**.
That number decides whether the field force sees anything on **Today** the next
morning, and it is worth reading before you hand out a single login.

---

## 4. Point the app at the least-privilege database role

Actions → **Provision app role** → Run workflow, then set Vercel Production
`DATABASE_URL` to the `nmwc_app` pooled URL, keep `DIRECT_URL` as the owner, and
redeploy. `OPERATIONS.md` §5c.

The role exists on production already and every refusal was proven against it.
**Until this variable changes, the application still connects as the owner**, so
the audit-immutability work is not yet in force for the credential that actually
runs. Do the preview first.

---

## 5. Create the two scheduled jobs

Keep-warm every 4 minutes and the SLA sweep twice an hour, 03:00–14:59 UTC, with
`Authorization: Bearer <CRON_SECRET>`. Table of exact settings in `OPERATIONS.md`
§5d. Then point an uptime monitor at the bearer health endpoint, which answers 503
when any job is stale, failed, or has never run.

Until a scheduler calls it, the SLA escalation sweep does not run — and now you
will see that rather than it being silent.

---

## 6. Run the restore drill once

It has **never run**. Not once, in the entire life of this project. Until it
passes, the recovery time is unknown and the encryption key is unproven. Needs
`NEON_API_KEY`, `NEON_PROJECT_ID` and `PROD_DB_HOST_MARKER` (that last one is
required — the drill refuses to drop a schema without knowing which host is
production).

---

## 7. The residency blanks, before the load and not after

Fill the `[OWNER]` markers in `compliance/DATA-RESIDENCY-REGISTER.md` — both R2
bucket locations, the Sentry region, the account holder of record per vendor, and
where Temix runs — and send `compliance/PDPL-ASSESSMENT.md` to counsel.

Once 20,000 Omani customer records are in a US database, a residency requirement
becomes a cutover rather than a configuration change. This is the last cheap
moment.

---

## Decisions I need from you

**None of these block the load.** They are open because they are yours, not mine.

### a. One shared initial password, or one per account?

Your instruction was one shared password plus a forced change at first login.
SEC-11 replaced it with a per-account 8-digit issuer, and that was **my mistake of
process** — the assessment had recorded the choice as yours and I made it in code
without asking. You said not to revert it yet, so it stands.

- **Revert** costs one constant in the builder plus the distribution wording in
  runbook step 8. The issuer and its seven tests are recoverable from `db51732`.
- **Keep** means every person gets their own row from `credentials.xlsx` and a
  manager who also sells a route has two logins with two different values.

What the shared design accepts: usernames are route codes and are printed on the
journey plan, so until a person first signs in, anyone who knows the shared value
can sign in as them and own their audit trail from then on. The forced change
closes that window one account at a time, which is why the runbook hands the
logins out and walks people through the change the same day.

### b. Does archiving a customer release its documents?

The commercial-registration and guarantee photographs behind a credit decision.
Gap 1 in `compliance/DATA-RETENTION-SCHEDULE.md`. Merging is already settled — the
loser's documents move to the winner and nothing is released.

### c. How long may a change request sit before its photographs are swept?

A request left in draft or needs-correction keeps its images forever, including
the commercial registration of a customer that was never created. Gap 5 in the
same schedule. "Abandoned" is a judgement about how long a salesman may leave a
correction outstanding, not a technical default.

### d. Should a failed audit write fail the user's action?

Two best-effort sites currently swallow it. The other thirty-four are inside the
caller's transaction and already abort with it.

### e. The Steward's reach, and two-person provisioning

A Steward can import, merge and bypass every field lock. Should provisioning an
approver-tier account require two people? A role-design question, not a defect.

---

## The one thing only you can do that I cannot

**The signed-in browser walk.** I will not enter a password into a login form, so
the unauthenticated half is verified and this half is not: sign in, complete a
forced password change, click **Sign out before the page finishes loading**, apply
a filter on `/audit` (the only native GET form in the app), approve and reject
something, and upload a photo.

Those six are where a content-security-policy change shows up if it is wrong, and
this codebase has had to revert one under production pressure before.

**To sign in on UAT**, the usernames are bare route codes — `c4`, `c1` — not
`c4-12345-nmwc`. That older shape is the May seed's, which only production has.
`c4` and `c1` exist, are active, and have never logged in, so they still hold
their initial password.
