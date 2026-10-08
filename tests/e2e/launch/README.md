# Launch e2e suite

The browser suite for launch: a **production build of this checkout**, served
locally by `next start`, on the **UAT** database, driven by Playwright on a
phone (Pixel 5, 412×915, GPS at Muscat) and a desktop (1280×800). Every
context runs in `Asia/Muscat` / `en-GB`; the server runs `TZ=UTC`, like Vercel.

Config: `playwright.launch.config.ts` (repo root). The old
`playwright.config.ts`, `tests/e2e/login.spec.ts`,
`tests/e2e/golive-update-flow.spec.ts` and the CI e2e job are untouched; the
old config still collects these files but every launch test skips there.

## Run it

Work in a UAT checkout (`C:\Users\rahma\dev\…`), **never** in
`C:\Users\rahma\OneDrive\Desktop\NMWC-CRM` (its `.env` is production — the
suite refuses that folder and any URL containing `ep-sweet-haze`).

1. Install and build (once per code change). Never `npm run build`: it runs
   `prisma migrate deploy` on UAT.

   ```bash
   npm ci --no-audit --no-fund && npx prisma generate
   NEXT_PUBLIC_SENTRY_DSN= node scripts/qa/run-with-env.mjs next build --no-lint
   ```

   The DSN is inlined at build time; the config refuses to start a build that
   carries one. (PowerShell cannot hold an empty variable — `$env:X = ''`
   deletes it — so there just make sure it is not set; `.env` has no DSN.)

2. Step 1 — everything but the exclusive tests:

   ```bash
   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts --project=phone --project=desktop
   ```

   Only the harness proof: add `harness` after the config name.

3. Step 2 — the exclusive tests, alone, after step 1 has cleaned up:

   ```bash
   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts --project=exclusive --workers=1
   ```

   These touch org-wide state (Temix Generate moves the whole queue; the SLA
   sweep escalates every overdue request). Each first checks that only its own
   fixtures would be affected and skips, with the counts, when real UAT rows
   would be — which on UAT is likely. Their real home is a Neon branch of UAT
   with its own server (set `DATABASE_URL`/`DIRECT_URL` to the branch for that run).

PowerShell: set the variable first, then run the same command without the
prefix — `$env:RUN_LAUNCH_E2E = '1'; node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts --project=phone --project=desktop`.
`run-with-env.mjs` re-parses arguments through `cmd.exe`, so do not pass
anything with spaces, `|`, `&`, `^` or `%` on the command line (a `--grep`
alternation, a path with spaces): put it in the config or in an env variable.

Reports: `playwright-report/launch-<step>/`, screenshots and error context of
failures in `test-results/launch-<step>/` (one folder per step, so step 2 keeps
step 1's). The server's own output goes to `.e2e-launch/server-<step>.log` —
never to the console, because a server error can quote a connection string.

**No traces, and a secret scan.** Every context carries a session cookie, some
type a password, and the photo upload uses a presigned R2 URL (the account id,
the access key id, a live signature). A Playwright trace records call
parameters, DOM snapshots and the network log, so traces are **off**; passing
`--trace` brings them back and the scan below will delete them. The HTML
report titles each `fill` step with the typed value, so passwords are typed
with `fillSecret()` and the R2 PUT goes through Node's `fetch`. The last
reporter (`support/secret-scan-reporter.ts`) then scans every
`playwright-report/launch-*`, `test-results/launch-*` and `.e2e-launch/*.log`
— zip entries and the report's embedded data included — for a run password
(by its shape, `E2e-<16>-9a`), an Auth.js session token, a presigned URL or the
value of a secret env variable. A file that holds one is deleted and the run
fails, naming the file and the kind of secret, never the value. By hand,
read-only: `… sweep-cli.ts --scan`.

### Under load

Correctness under concurrency, not capacity (an overloaded laptop's latency
means nothing). Two passes, once step 1 is clean at the default 4 workers:

```bash
# all of step 1, ten workers
RUN_LAUNCH_E2E=1 E2E_WORKERS=10 E2E_RUN_BUDGET_MIN=180 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts --project=phone --project=desktop
# the three busiest specs, three times over, ten at a time
RUN_LAUNCH_E2E=1 E2E_WORKERS=10 E2E_RUN_BUDGET_MIN=180 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts --project=phone --project=desktop --repeat-each=3 salesman-phone update-flow approvals-queue
```

- Every repeat builds its own world (the suffix takes a counter), and cleans it.
- `E2E_SERVER_DB_CONNECTIONS` (default 10) is the server's pool: set it to
  production's `connection_limit` to load it as production is loaded. Each
  worker holds up to 5 connections of its own (3 test, 2 owner), so ten workers
  and the server need about 60 from the UAT compute — check its limit first.
- `E2E_RUN_BUDGET_MIN` is the run's real length: the clock guard refuses a
  start whose budget crosses Oman midnight (20:00 UTC).
- Afterwards: search `.e2e-launch/server-main.log` for `P2024`, `pool timeout`
  and `DB_UNAVAILABLE` (a test that failed on one of those failed on the pool,
  not on the app — report it as such), then run `sweep-cli.ts --check` (zero
  residue).
- `races.spec.ts` is the deliberate half — two people, or two taps, at one
  instant through the UI. Its barrier (`support/races-helpers.ts`) clicks every
  racer at one wall-clock instant and fails with "the barrier did not hold" when
  they land more than 250 ms apart, or "in flight together" when the POSTs did
  not overlap: on a machine that busy, run it alone (`races` after the config).

PowerShell: set each variable first (`$env:E2E_WORKERS = '10'` …), then the same
command without the prefix.

### What the run refuses to do

The config checks, before the server starts:

- `DATABASE_URL`/`DIRECT_URL` set, not production; not the Desktop clone;
- no `.env.local`, `.env.production`, `.env.development` (`next start` would read them over the UAT `.env`);
- the clock: no Oman midnight (20:00 UTC) inside the run's budget
  (`E2E_RUN_BUDGET_MIN`, default 120 minutes) and no start in the four hours
  after it, while the server's UTC date is still a day behind Oman's — with the
  default budget, no start between 18:00 and 24:00 UTC — and no overlap with
  Neon's compute-update window (Thursday 23:00–24:00 UTC);
- a production build exists, is newer than every file in `app/`,
  `components/`, `lib/`, `services/`, the schema and the root configs, and has
  no Sentry DSN inlined in `.next/static` or `.next/server`;
- `prisma migrate status` (read-only) says UAT is up to date with this checkout;
- this Node honours `TZ=UTC`.

It also clears `.next/cache/fetch-cache`, so the 5-minute reference-data cache
(filter dropdowns) starts empty.

Global setup then proves, separately: `/api/health`; the F1 migrations are
applied; a probe account created in this database signs in through the page
(so the server really reads UAT, whatever else holds port 3000 — the port must
be free anyway); `x-forwarded-for` reaches the login limiter; an R2 probe photo
streams back through `/api/photos/<id>`; a **minted** cookie opens a home page;
`page.request` carries that cookie. The probe world is cleaned to zero.

### Environment knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUN_LAUNCH_E2E` | — | must be `1`, or every launch test skips |
| `E2E_CHROMIUM` | newest installed headless shell | browser executable |
| `E2E_WORKERS` | 4 | parallel files |
| `E2E_PORT` | 3000 | server port (must be free) |
| `E2E_SERVER` | prod | `dev` = `next dev` while authoring (CSP/hydration/perf tests skip themselves) |
| `E2E_SERVER_DB_CONNECTIONS` | 10 | the server's Prisma pool (`connection_limit`, with `pool_timeout=30`) |
| `E2E_RUN_BUDGET_MIN` | 120 | how long the run may take, for the clock guard |
| `E2E_RUN_ID` | generated | set by the config with `??=`; set it yourself only to resume a run's naming |

The server listens on `127.0.0.1` only (`-H 127.0.0.1`): it holds the UAT
database URL, `AUTH_SECRET` and production's R2 keys and trusts
`x-forwarded-for`, so nothing else on the network may reach it. `BASE_URL`
stays `http://localhost:<port>` (the cookie domain): Chromium and Playwright's
HTTP client try both loopback addresses, and global setup proves the page, a
minted cookie and `page.request` all reach the server.

The server always gets: `TZ=UTC`, `AUTH_URL=NEXTAUTH_URL=http://localhost:<port>`,
`NOTIFY_EMAIL_ENABLED=''`, `EMAIL_REDIRECT_TO=''`, `ALERT_WEBHOOK_URL=''`,
`NEXT_PUBLIC_SENTRY_DSN=''`, `MAINTENANCE_MODE=''`, `INSIGHTS_DASHBOARD_DISABLED=''`,
`DEMO_ACCOUNTS_DISABLED=true`; `BULK_BUDGET_MS` and `RATE_LIMIT_BACKEND` are unset.

## What it touches

- **UAT database** — synthetic TEST rows only. Each world has a suffix
  `sfx = tag + RUN_ID + worker + project initial` that every typed value carries:
  usernames `e2e.<key>.<sfx>` (a salesman's is his route code, lower case),
  regions `E2R<SFX>n`, routes `E2<SFX>n`, customers `000E2E<SFX>-NNN`
  (`… Trading <sfx>`), CR numbers `CR<SFX>NN`, phones `+9689…` checked unused.
  The exception, `allocTwoCharRoute` (`Z?`/`Y?`, for the two-character
  route rules): its code and its salesman's username carry no suffix, so they
  are found by id only — never by the code or the name.
  Real rows are only ever read (clash checks, reference channels).
- **R2** — the bucket in `.env` is **production's** photo bucket. The suite PUTs
  only under `<UTC yyyy/mm/dd>/<fixture user id>/<KIND>/<uuid>.jpg` (the
  presign layout), lists only those day folders, and asserts that layout before
  every DeleteObject (`support/r2.ts`). Nothing else is listed or deleted.
- **Rows the app writes for fixtures** — LOGIN/APPROVE audit rows, step ledger,
  notifications (including those sent to REAL Stewards/FM/GM about a fixture
  request — found by `editId`), rate-limit buckets of fixture names and
  `198.18.x.x`/`198.19.x.x` addresses (plus the localhost buckets). The
  addresses are spread by the run id (the probe's too), so a run from another
  checkout rarely shares one — its cleanup would reset our buckets.
- **Rows other UAT activity writes TO fixtures** — while a world is alive, its
  Steward, FMs and GM are active members of the org-wide audiences, so anyone's
  new-customer request (a real one, another suite's) notifies them too. Cleanup
  first deactivates the world's users, then deletes every notification
  addressed to them (it must, to delete the users); nothing else of those
  requests is touched.
- **Rows other UAT activity makes WITH fixtures** — the integration suites pick
  a user, route or region with `findFirst` and may pick ours (a CREATE request
  submitted as our salesman, an import uploaded as our Steward, a route in our
  region). Cleanup deletes only what is the world's: registered ids, values
  that carry the suffix, and what hangs off those (branches and requests of a
  world customer, the customer a world CREATE request or import made, photos
  on world rows, rows of world imports). A row found only because a world user
  submitted, uploaded, captured or decided it, or because it sits in a world
  route or region, is **foreign**: never deleted, counted as `foreign<Table>`,
  and the world user, route or region it points at is kept (deactivated) — so
  the world stays dirty and a person decides. So is an audit row a world user
  wrote about anything but a world row (the audit trail of a real request).
- Known residue by design: the `CodeSequence 'CUSTOMER-<year>'` counter advances
  with every finalized CREATE; authorized cron calls leave `CronHeartbeat` /
  `CronRun` rows.

Passwords: every fixture account gets a per-run password generated in memory,
of the shape `E2e-<16 base64url>-9a` the secret scan looks for; `mustChangePassword`
fixtures (and any with `initialPassword: true`) get the real hand-out `12345`.
Never type one with `fill`/`type`/`pressSequentially` (the report titles the
step with the value): use `fillSecret(locator, value)`, and `clearSecretFields(page)`
before asserting on a page that still holds one (a failed assertion attaches an
ARIA snapshot, field values included). `signInViaUi` and `changePasswordViaUi`
do both.

## Writing a spec

Import only from `./support`. Build worlds in a describe-level `beforeAll`,
clean them in `afterAll`; never at module level (the old config imports these
files too).

```ts
import { expect, test } from '@playwright/test';
import { contextAs, installLaunchHooks, requireLaunchEnv, standardWorld, type World } from './support';

test.describe('today', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  let world: World;
  test.beforeAll(async () => { world = await standardWorld('td'); });
  test.afterAll(async () => { await world?.cleanup(); });

  test('due list', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/today');
    await expect(page.getByText(world.customer('DUE1').legalName)).toBeVisible();
  });
});
```

- Tags: `@phone`, `@desktop` (both = run on both projects, each with its own
  world), `@exclusive` (run alone in step 2). Multi-role tests open explicit
  contexts — `contextAs(browser, user, { device })` — and carry ONE tag.
- `standardWorld(tag, extra)`: R1 (M1, M2 share it) and R2 (M5); routes A, A2,
  FREE (unowned) in R1, B in R2; SA (A, supervisor M1), SA2 (A2, M2), SB (B, M5);
  ACC1/ACC2, FM1, FM2, GM1, STW, VW, SUP (a SUPERVISOR with no reports — pass
  `{ key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'SUP' }` in
  `extra.users` to put SA under him); customers GAPS, FULL (complete, three
  photos), CRED, MULTI (A1, A2 on A; B1 on B), CLOSEDB, ARCH, DUE1/DUE2 (due
  today), OTHERDAY, NODAY1/NODAY2, DELETED, BONLY. `extra` entries replace
  same-key defaults.
- Sessions: `contextAs` mints the Auth.js cookie (no login token, no LOGIN row);
  `signInViaUi` / `apiSignIn` when sign-in itself is under test (the
  `x-forwarded-for` is `world.ip(n)`, on the login POST only). A user whose
  password, role or status a test changes is used by that test only (each of
  these revokes every other session of that user).
- Any record created through the UI is registered: `world.adopt.customer(id)`,
  `.edit(id)`, `.attachment(id)`, `.importBatch(id)`, `.userId(id)`, `.routeId(id)` …
  By value (`.user(username)`, `.routeCode`, `.regionCode`) only when the value
  carries the suffix — anything else throws (adopt it by id). Unregistered rows
  a fixture user made (a photo taken and never attached, a CREATE request typed
  without the suffix, a workbook not named with `world.name()`) are FOREIGN to
  cleanup: the world stays dirty until the test adopts them.
- Seeds: `seedPhoto` (unique bytes, R2 + Attachment row), `seedUpdateEdit`
  (built from the live row with the app's own helpers and proven with
  `approvalPlanFor`), `seedNotification`. One SUBMITTED edit per customer.
  A reactivation's "photo older than the closure" needs the closure about 2 h
  ago and the photo between 24 h ago and then (the 24-hour rule is checked first).
- The FM, GM, Steward and Viewer queues and counts are org-wide (real UAT rows
  too): assert that a fixture row is there or not, never an exact total.
- The app's own routes, as the phone calls them (`support/api.ts`, all through
  `page.request`, so the page's session is the caller; refusals are returned,
  not thrown): `uploadPhotoViaApi(page, world, { kind, attach })` — presign →
  R2 PUT → finalize → attach, the key checked against the fixture users before
  the PUT; `submitEnrichViaApi(page, patch, { world })` — the edit form's patch
  v2 with bases read live; `submitCreateViaApi`, `closeBranchViaApi`,
  `requestReactivationViaApi`; `postForm`/`postJson` for anything else.
- Server actions (`support/actions.ts`): `captureServerAction(page, trigger)`
  ABORTS the action POST in the browser (it never reaches the server) and mutes
  that page's console watcher — close the page after. Never "hold" a request
  with a route and un-route it: Chromium then sends it on and the action runs.
  `replayServerAction(ctx.request, action)` posts it again as another user and
  says `refused` / `notFound` / `message` / `redirect`; `actionIdFor(name, worker)`
  reads the build's manifest. A replay by an allowed user RUNS the action —
  never replay an unscoped one (Temix Generate) outside the exclusive phase.
- Read-backs: `notificationsFor`, `auditFor`, `snapshot(tables, where)` (a hash
  for "nothing changed"). Media: `tinyJpeg`, `uniquePng` (unique after browser
  compression), `jpegInBrowser` (big camera JPEG), `fakeHeic`, `tinyPdf`, `textFile`.
- Known bugs: `test.fail(KNOWN_BUGS.x.open, KNOWN_BUGS.x.title)` in their own
  non-serial tests; set `open: false` when fixed. `/notifications` #418 is
  allow-listed by URL for every test while it is open. A marker about a wrong
  server DATE only holds between 20:00 and 24:00 UTC: gate it with
  `utcDateBehindOman()`, or it "passes unexpectedly" the rest of the day.
  On the final launch build (8 Oct) every KNOWN_BUGS entry is fixed
  (`open: false`, with `fixed` naming where) and no spec carries a `test.fail`:
  every test must pass. The in-place helpers (`landsOn`, `shownAfterRefresh`,
  `shownInPlace`, `landsInPlace`, create-chains' `createHere`) FAIL on a
  navigation hang; they no longer reload or load the URL for it.
- Temix code (owner decision 8 Oct): a test that approves a new customer at
  its last step types a code first — `typeTemixCode(page, temixCodeFor(w))`
  (support/temix-codes.ts: `TX<SFX><n>`, unique to the world). Approve does not
  open its confirmation without one, and a new customer at the Accountant's
  step is never in a bulk approve.
- SLA seeds ("OVERDUE 3h") are in WORKING minutes: `workingMinutesAgo(180)`,
  `slaDeadline`, `workingMinutesBetween` — never `Date.now() - 3h`.
- Login throttles: the per-user bucket is 5 tokens refilling one per 12 s and
  the per-address bucket counts failures only; a "sixth attempt locks" test
  pre-drains the bucket with `drainLimit('login:user:<name>')` instead of racing
  the refill. `resetLimits({ users, ips })` gives a heavy test full buckets.

Not built yet (ask the support owner rather than writing them in a spec):
page objects (`pages.ts`), `seedCreateRequest` (a CREATE request at a given
step, mirroring services/creates.ts) and the account/customer import workbooks.
Until then, drive the UI with the go-live spec's `label:text-is("X") + input`
lookup and create requests through `submitCreateViaApi`.
- After a change made in another context, use `page.goto`/`page.reload`
  (`freshGoto`): the router cache reuses pages for 30 s. Filter dropdowns can
  lag fixtures by 5 minutes — assert through URL parameters and rows.
- Expectations in Oman time: `OMAN_TODAY`, `omanFmt`, `omanDayAfter`; never a
  literal weekday or year. Never print an env value.

## After a crash — the sweep

Every world writes `.e2e-launch/registry/<runId>/<world>.json` **before** it
inserts anything: ids are minted client-side, codes and R2 keys are recorded
first. The folder is outside every Playwright output folder, so no later run
wipes it. Cleanup finds rows by the registry AND by the world's suffix.

- `world.cleanup()` deletes in foreign-key order on the table owner's
  connection (`DIRECT_URL`), in batches, with audit and step-ledger rows removed
  inside the owner's maintenance window (120 s transactions, not Prisma's 5 s).
  A pass that leaves anything is repeated up to three times; every pass is kept
  in the file's `attempts` list. R2 objects are deleted only under the folders
  of the registry's users (minted, adopted or carrying the suffix), never the
  object of a foreign photo, and only after the key is checked to be
  `<ymd>/<fixture user id>/<KIND>/<file>`. Only ids are written back to the
  registry — never a code or username without the suffix.
- Global setup sweeps every unclean world of finished runs; global teardown
  re-sweeps the current run, prints what each unclean world had left and why,
  and fails the run if anything is still left. A run is "finished" when its
  runner's heartbeat, `.e2e-launch/runs/<runId>.alive` (rewritten every 30 s,
  removed when the runner exits), is gone or older than three minutes — not by
  its process id, which Windows soon gives to another process.
- By hand (PowerShell: the same commands — nothing here needs quoting):

  ```bash
  node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --list     # registry state, deletes nothing
  node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --check    # recount every world on UAT and R2, read-only
  node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts            # sweep every finished run
  node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --run <runId>
  node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --scan     # secret scan of reports/results/logs, deletes nothing
  ```

A world stays DIRTY, deliberately, when a foreign row points at it — a fixture
user decided or reviewed a REAL request (the FM/GM/Steward queues are org-wide),
another suite submitted or imported as a fixture user, or put a row in a
fixture route or region: that request, approval, import or audit trail is not
the suite's to delete, and the user, route or region it points at is kept. The
registry file names what is left (`foreign*` counts, `kept …` in the error);
a person decides.
