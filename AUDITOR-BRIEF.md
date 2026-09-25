# NMWC Customer Master — Brief for an External Code Auditor

**Written:** 2026-09-25. **Code described:** commit `2d1e702` (the item-22 follow-up) — the commit that adds this file sits on top of it. `origin/main` may lag the branch `claude/nmwc-crm-consolidation-e10c1e` until the owner merges; check `git log origin/main` before comparing line numbers.

**Trust order when sources disagree:** the code → this brief → recent commit messages → everything else in `docs/` and `qa/`. Many older documents are stale; §15 lists the known contradictions so you neither report a stale doc as a defect nor trust it as a spec.

**How this brief was made:** six readers mapped the code area by area with file references; the draft was then fact-checked claim by claim against the code by six independent checkers, and a seventh listed what an auditor would still miss. Items marked **(not verifiable from the repo)** are production settings or owner statements you cannot see.

---

## 1. What this system is

- **NMWC** is National Mineral Water Company SAOG, Oman (`docs/PROJECT-DESCRIPTION.md` §1–2). It sells bottled water through field salesmen; each salesman owns one **route** of shops (`User.ownedRouteId` is unique, `prisma/schema.prisma`).
- **The Customer Master** (package name `nmwc-cm`) is a field-driven tool to clean up and complete the customer master data. It **supports** the company ERP, **Temix** (spelled "Timix" in some docs and scripts); it does not replace it. Temix stays the system of record. Data reaches Temix as Excel batches a Data Steward uploads by hand — there is no live Temix API (`lib/temix.ts`, `services/temix.ts`).
- **Scale:** the production load ran on 2026-09-23 across **all seven regions** (MCT, KHB, NZW, SLL, AWF, DQM, BRK — `lib/ops/golive-accounts.ts` `GOLIVE_REGION_CODES`; `docs/GO-LIVE-RUNBOOK.md`: 7 regions, 43 routes, 62 accounts): **18,677 live customers, 20,596 branches** (`docs/OWNER-ACTIONS-NOW.md` §0). About 1,900 customers therefore have more than one branch.
- **Core loop:** a salesman opens a customer on his route, fills missing data (phone, contact, address, GPS, photos, channel…) and submits; an approver approves; the change lands in the master and is queued for the next Temix batch. New customers go through a multi-step approval chain. Stewards import, deduplicate and batch to Temix.
- **UI language:** English. Apart from the bilingual maintenance page (`lib/maintenance.ts`), Arabic exists only in the PDF guides `docs/guide/*-AR.pdf`, which are out of date (benchmark item 26).
- **Owner:** one product owner makes the business decisions (§12). "Owner decision" in comments and commits means a recorded choice by that person, not a developer's preference.

## 2. Ground rules for you (the auditor)

- **Do not connect to production.** The production database endpoint contains `ep-sweet-haze`; the production app is `https://nmwc-cm.vercel.app`. `npm run smoke` makes read-only, anonymous requests to that URL; run nothing else against it.
- **Run no script under `scripts/**` or `prisma/*.ts` against anything but your own empty database.** The write switch varies — `--apply`, a subcommand (`app-role.ts create|grant`), an environment flag (`CONFIRM_CREDENTIAL_RESET=yes`, `ALLOW_PRODUCTION=1`, `ALLOW_PROD_SEED=1`), or **nothing at all**. These write as soon as they run, with no production check: `scripts/wipe-synthetic-data.ts`, `flatten-customer-branches.ts`, `cleanup-synthetic-test.ts`, `seed-demo-edit.ts`, `prisma/inject-test-edits.ts`, `seed-muscat-customers.ts`, `seed-muscat-payment-terms.ts`, `prisma/test-*.ts`, and `prisma/seed.ts` (`npm run db:seed`). They are historical one-off tools the app never calls. The go-live operator scripts (`requeue-untracked.ts`, `zero-credit-limits.ts`, `apply-quarantined-visit-days.ts`, `scripts/golive/bootstrap-accounts.ts`) are built to write to production behind `--expect-host ep-sweet-haze`.
- **Customer data is not in the repository.** `golive-data/` (the real masters and generated passwords) is gitignored and appears in no commit on any ref. `.env` is gitignored; `.env.example` holds variable names with placeholder values and non-secret defaults.
- **Some committed files do contain passwords and personal data** — see §14. Do not reproduce values in your report; name the file and line. Do not open `docs/guide/img/*.png` expecting test data: they were captured from production during the May 2026 pilot.
- **Integration tests need a Postgres of your own** (§16). Never point them at a shared or production database: seven suites have no production check (§11).

## 3. Architecture and stack

| Layer | What | Where |
|---|---|---|
| Web app | Next.js 15.5.25 App Router, React 19.2, TypeScript, Tailwind 3.4; server components + server actions; `typedRoutes` | `app/`, `components/`, `next.config.ts` |
| Auth | next-auth 5.0.0-beta.32, Credentials provider, JWT sessions | `lib/auth.ts`, `auth.config.ts`, `middleware.ts` |
| Data | Prisma 6.19 on PostgreSQL (Neon). `DATABASE_URL` = the pooled app connection (a `-pooler` host; the pooler mode is a Neon setting, **not verifiable from the repo**); `DIRECT_URL` = the owner, for migrations and operator scripts | `prisma/`, `lib/db.ts` |
| Files | Photos in Cloudflare R2 (`nmwc-photos`), presigned PUT from the phone, served only through an authorising route | `lib/r2.ts`, `app/api/photos/**` |
| Hosting | Vercel, region `iad1` (Neon is in AWS us-east-1 per `docs/OPERATIONS.md` §2), `maxDuration` 60 s | `vercel.json` |
| Errors | Sentry with a scrubber on every runtime (`lib/sentry-scrub.ts`); no `withSentryConfig`, so no source-map upload | `sentry.*.config.ts`, `instrumentation*.ts` |
| Excel | exceljs 4.4 (import parsing; streaming writer for exports) | `lib/excel.ts` |

**Environments.**
- **Production:** Neon endpoint `ep-sweet-haze…`; Vercel Production.
- **UAT:** Neon branch `uat-testing`, endpoint `ep-lucky-bar…`. Per `docs/SESSION-MASTER-RECORD.md`, Vercel Preview builds (every branch push) are scoped to UAT and run `prisma migrate deploy` against it **(Vercel setting, not verifiable from the repo)**.
- **CI:** a throwaway `postgres:16` service container per job (`db-tests`, `e2e`, `restore-chain` each start their own).

**Time:** business logic runs on Oman time (UTC+4, fixed offset). Workweek Sun–Thu, 08:00–17:00 (`lib/working-hours.ts`, owner decision D1); `lib/tz.ts` computes the Oman day.

## 4. Repository map and entry points

```
app/(app)/**         24 signed-in pages; each gates its role inline (no central route→role table)
app/(auth)/, app/actions/auth.ts   sign-in UI and the login server action
app/api/**           14 route handlers (below)
components/nmwc/     UI components
lib/                 domain + infrastructure (access, permissions, auth, audit, csp, rate-limit,
                     approval-chains, working-hours, submission*, keyset, excel, temix, …)
services/*.ts        14 'use server' modules exporting 40 async functions (server actions);
                     a few lack the Action suffix (buildCustomerExport, findDuplicateCandidates,
                     listSavedViewsForCurrentUser)
prisma/              schema.prisma, 18 migrations, seeds, ad-hoc test scripts (§2)
scripts/             ops/ (smoke, app-role, restore-verify, cron-scheduler, R2 checks), qa/, golive/,
                     compliance/, plus ~16 historical scripts at the root (§2)
tests/unit           64 files, 927 tests (vitest + jsdom); one runs only where golive-data/ exists
tests/integration    25 DB-backed suites gated by RUN_* flags; 22 run in CI
tests/e2e            2 Playwright specs; only login.spec.ts runs in CI
tests/support        strip-comments (TypeScript-parser based), jsx-ast, where-eval, workflow-step,
                     promote, audit (owner-client purge helper)
docs/, qa/           specs, runbooks, audits — many stale (§15)
.github/workflows/   ci.yml + 7 operational workflows (§10); dependabot.yml
graphify-out/        a code knowledge graph generated in July 2026 — stale, not a source of truth
```

**Route handlers** (`app/api/**/route.ts`):

| Route | Methods | Auth |
|---|---|---|
| `auth/[...nextauth]` | GET/POST | next-auth |
| `forms/[form]` (item 22) | POST (+ GET for `customer-create` receipts) | session checked in the route (401); JSON only (415); cross-site `Origin` refused (403); a request with **no** Origin is accepted |
| `photos/presign`, `photos/finalize` | POST | session only |
| `photos/[id]` | GET | session + `assertCanAccessAttachment` (404 when denied) |
| `exports/customers`, `exports/changes` | GET | session + export role + scope; writes an `EXPORT` audit row |
| `health` | GET | anonymous `{status}`; detail only with `HEALTH_BEARER` (≥20 chars) |
| `cron/keep-warm`, `cron/photo-gc`, `cron/retention-sweep`, `cron/sla-escalate` | GET | `Bearer CRON_SECRET` |
| `ops/backup-report` | POST | `Bearer CRON_SECRET`; writes the `db-backup` heartbeat |
| `perf-probe` | GET | STEWARD or MANAGER; org-wide counts and timings (ignores the Manager's regions) |

## 5. Domain: roles and scope

Eight roles (`Role` enum; checks in `lib/permissions.ts`, `lib/access.ts`). Scope comes from the user record: a salesman owns one route; a supervisor covers his direct reports' routes; Managers and Accountants have regions (`managedRegions`, M:N). **Scope fails closed** — an empty region list sees nothing — and an out-of-scope read returns **404, not 403** (`lib/access.ts`).

| Role | Sees | Can do |
|---|---|---|
| SALESMAN | own route | submit UPDATE edits (through the submit gate); the **only** role that starts a new-customer (CREATE) request and files close-shop / reactivation requests; attach only photos he captured. Field locks: `legalName` always locked; `crNumber` locked for CREDIT customers |
| SUPERVISOR | direct reports' routes | approve the Supervisor step for his reports; export his team's routes. Cannot edit. Per the runbook there are **no Supervisor accounts in production** — Managers approve through the region fallback **(production state not verifiable from the repo)** |
| MANAGER | managed regions | **direct write** (edits apply at once, no approval, no mandatory gate — audited `direct-write:`); region check per branch for field edits (photos: any branch of the customer in region is enough); fallback approver on the Supervisor step; the **only** role that decides reactivations; archive a customer if every live branch is in scope; administer SALESMAN/SUPERVISOR accounts in his regions; export |
| STEWARD | everything | imports, duplicates & merge, Temix batches, direct write, archive, administer every role |
| VIEWER | everything | read + export org-wide, including CR and GUARANTEE documents (by design, `lib/access.ts`; no owner confirmation of the document access is recorded) |
| ACCOUNTANT | managed regions | final step of both CREATE chains |
| FINANCE_MANAGER, GM | everything (read) | steps on the CREDIT chain only |

Export roles: MANAGER, STEWARD, VIEWER, SUPERVISOR. Separation of duty: the submitter never acts on his own request, and no user acts on two different steps within one **cycle** (`canActOnStep`; a resubmitted CREATE starts a new cycle).

**Scope works at two levels — the place to look for cross-region leaks.**
- A **customer** is visible when **any** live branch is in scope (`canSeeCustomer`). Each surface must then narrow the **branches** itself with `filterBranchesByScope` (customer page, edit page, approval page, `services/edits.ts`).
- Customer-level fields (phone, contact, CR, channel, status) are shared by every branch, so anyone who can see or edit any branch sees them and can propose changes to them.
- Photos are authorised at **customer** level (`assertCanAccessAttachment` → `assertCanSeeCustomer`).
- The same rules are re-implemented for queries in `lib/customer-filters.ts` (list + "Export filtered"), `lib/export-scope.ts` (field-update report), an **inline copy** in `services/exports.ts` (master export) and a third copy in `services/customer-export.ts` — `lib/export-scope.ts`'s header says it is shared so the exports cannot disagree; that is not true today.
- Some code still assumes one branch per customer (the May "flatten"): `services/duplicates.ts` keys EXACT_TRIPLE on the first live branch's region.

**Session facts: cookie versus database** (`lib/auth.ts`, `lib/session.ts`, `lib/access.ts`). Role and `mustChangePassword` come from the JWT cookie; the Edge middleware sees only the cookie. Scope (owned route, team routes, managed regions) is read from the database on every request. The JWT callback re-reads the user (active? `sessionsRevokedAt`?) at most every 5 minutes behind a 30-second per-instance cache; because Auth.js discards the refreshed cookie on the RSC/server-action path, `lastCheck` can stay at its sign-in value, so the effective revocation delay is up to 5 minutes after sign-in and then up to about 30 seconds per warm instance. If the database errors during the re-read the session is **kept** and retried. `sessionsRevokedAt` is bumped by logout, own password change, admin password reset, activate/deactivate and role change.

## 6. Domain: the flows

**UPDATE — salesman enrichment** (`app/(app)/customers/[id]/edit/*`, `services/edits.ts`)
- One `CustomerEdit` row carrying `fieldChanges` (before/after per field). **Field** changes wait for approval. **Photos do not:** a CR, shop or signboard photo captured in the edit form goes into the live slot on the customer or branch at once (the previous one is soft-deleted and the completeness score recomputed), and detaching clears it at once (`services/photos.ts`). That is why approval re-checks the mandatory fields against the live record.
- **One open edit per customer**, enforced by the raw-SQL partial unique index `CustomerEdit_open_per_customer` (also covers close/reactivate requests).
- Approval: an atomic `updateMany` claim on `SUBMITTED`; for salesman edits (not status-only close requests) a mandatory-field re-check in the transaction; then `applyEditChanges` with an optimistic `version` lock. If anything was applied, a customer in `SYNCED` or `UPLOADED` is re-queued as `PENDING_UPLOAD`.
- Editable fields are the `CUSTOMER_FIELDS` / `BRANCH_FIELDS` lists; `routeId` and `paymentTerms` cannot change through an edit. A customer-level status flip is refused for every role; a Manager or Steward direct write **can** flip a branch between CLOSED/SUSPENDED and ACTIVE with no photo.
- **Submit gate** (`lib/submit-gate.ts`, UPDATE only): `CORE` by default (owner decision 2026-09-10) — channel, phone, contact, address ≥3 chars, GPS, shop photo. `SALESMAN_SUBMIT_GATE=FULL` adds sub-channel, CR number (CASH customers; locked on CREDIT) + CR photo, visit day, signboard. Salesmen only; drafts exempt. CREATE has its own fixed rules (`lib/validation/create.ts`) that always require sub-channel, CR number and photo, visit day and signboard.

**Field submits over fetch (item 22, 2026-09-25)** — the three field forms (customer update, new customer, close/reactivate) submit by POSTing JSON to `app/api/forms/[form]/route.ts`, which calls the same server-action functions. (Their photo slots still use server actions.) Reason: a stalled server action cannot be aborted and every later action queues behind it (`lib/submit-client.ts` header).
- Each submit carries a **`submissionId`** (UUID minted on the phone per payload), stored on `CustomerEdit.submissionId`, unique per submitter (migration `20260925130000_edit_submission_id`). A retry whose id already landed **writes nothing** and gets a receipt (`replayed: true`, the request as it stands now). The receipt is checked at the start of the submit and again if the submit fails (`answerIfLanded`, `lib/submission-replay.ts`).
- The phone reuses an id only for the **same** payload after an attempt with no answer (`SubmissionIds`). The form says beside the button what is known: answered / offline (nothing sent) / signed out / maintenance / unconfirmed ("cannot tell if it arrived"). After a successful submit it leaves by a full document load (`lib/navigate.ts`), because a route handler's `revalidatePath` does not clear the browser's router cache.
- The new-customer form writes the id of every send to its localStorage copy **before** sending; after a reload it asks `GET /api/forms/customer-create?submissionId=` (own requests only) whether one landed, and opens a landed draft instead of inviting a rebuild.

**CREATE — new customer** (`app/(app)/customers/new/*`, `services/creates.ts`, `lib/create-finalize.ts`, `lib/create-guards.ts`)
- A `CustomerEdit` with `process=CREATE`, `customerId=null`; payload in `EditCustomerDraft` + `EditBranchDraft[]`; photos held by `Attachment.editId`. Every branch is forced onto the salesman's own route.
- Hard duplicate blocks at submit (not for drafts): exact normalized CR, or EXACT_TRIPLE (case-insensitive legal name + normalized phone + region), against live customers **and** other open CREATE requests (DRAFT, SUBMITTED, NEEDS_CORRECTION), serialized with transaction-scoped advisory locks. There is deliberately **no** unique index on CR (legacy duplicates); a stale comment in migration `20260510160000` says otherwise.
- **Chains** (`lib/approval-chains.ts`), frozen onto the row at submit: UPDATE = Supervisor; CASH create = Supervisor → Accountant; CREDIT create = Supervisor → Finance Manager → GM → Accountant. A reject steps back one step; from step 0 it goes to `NEEDS_CORRECTION`; a second reject by the same step in one cycle goes straight to `NEEDS_CORRECTION`.
- Finalize at the last step: re-checks duplicates, allocates `NMWC-YYYY-NNNNNN`, creates Customer + Branches, binds photos, copies the requested credit figures unchanged (FM/GM approve or reject; they never amend).

**Close shop / reactivation** (`services/reactivations.ts`): a fresh photo (≤24 h, by the same salesman, after the branch's last status change, attached to that branch) + a reason of ≥5 characters. Close goes to the Supervisor queue; reactivation is decided by a Manager on `/reactivations` and refused on the generic approve path.

**SLA** (`lib/working-hours.ts`, `lib/escalation.ts`, `app/api/cron/sla-escalate`): working-hours budgets per step (SUP 8 h, ACC 9 h; FM/GM/MANAGER values are placeholders, owner question Q-sla). Escalation level 1 at breach and 2 at twice the budget. It **never changes workflow state**; it does write `escalationLevel`/`slaBreachedAt`/`lastEscalatedAt`, an `ESCALATE` audit row, notifications, and an operations alert. The escalation targets are marked "[Open — owner to confirm]".

**Photos:** presign → R2 PUT → finalize → attach. Presign limits the *declared* type (jpeg/png/webp) and size (3 MB); the presigned PUT does not bind Content-Type, so the served type is re-derived from the server-minted key (`lib/photo-mime.ts`). Finalize checks the object (HeadObject), the caller's own key prefix for today/yesterday, re-checks 3 MB, and takes `capturedAt` from R2. Served only through `app/api/photos/[id]`. `photo-gc` tags soft-deleted objects for R2 lifecycle expiry after a 30-day grace and then hard-deletes the database row.

**Imports** (`services/imports.ts`, Steward only): account master (regions, routes, users — any role, including approvers) and customer master, with a chunked, leased, resumable promote.
- The **ordinary lane** is an upsert. On **create** it writes payment terms, the Temix code when the row has one, and — for CREDIT rows — credit limit and term days; a new CREDIT customer is refused only when the row has **no** `temix_code` (the go-live master carried one on every row). On an **existing** customer it writes none of these and rejects a row whose terms disagree with the stored ones.
- The **refresh lane** applies only when the stored `temixCode` **equals** the row's `temix_code` (a different code is rejected); it writes Temix code, payment terms and credit.

**Temix** (`services/temix.ts`): the whole queue goes into one batch; over 5,000 rows generation is refused (no in-app split). "Mark loaded" settles only the **deactivation** rows (archived customers) to `SYNCED`; live rows stay `UPLOADED` until an inbound Temix refresh import flips them.

**Duplicates & merge** (`services/duplicates.ts`): exact CR or EXACT_TRIPLE only (phone-only and fuzzy matching were dropped); candidates are computed when the Duplicates page opens. Dismissals are stored as `AuditLog` rows (`entityType 'CustomerPair'`) and read back as state — business decisions in the append-only ledger. Merge locks both rows, auto-rejects the loser's open edit (the only place `CustomerEdit.state = REJECTED` is written), moves branches/edits/attachments to the winner, soft-deletes the loser, and queues its Temix deactivation if Temix knew it.

**Exports** (`services/exports.ts`, `lib/change-report.ts`): the master export and the field-update report read in keyset pages and write with the streaming xlsx writer; the finished file is buffered and sent as one response. Ceiling 60,000 rows (item 28). The report holds every in-scope branch in memory to sort by route and reads the window's UPDATE edits in one query. The role scope is intersected with the caller's filters, never replaced (F-01). The export is **not** an import file — re-uploading it could reopen closed branches (commit `3e775d4`); making it round-trip is an open owner decision. The `/customers` "Export filtered" button is still capped at 5,000.

**Notifications:** in-app only (no email sender exists). **Today** (`app/(app)/today`): the salesman's branches whose visit day equals the Oman day, capped at 200 rows, with no status filter (closed branches are listed).

## 7. Data layer

- **23 models** plus the join table `_ManagerRegions`; 281 stored columns (the 23 models), each classified for personal data in `lib/compliance/pii-classification.ts` (a test fails on any unclassified or orphaned column; `docs/compliance/PII-INVENTORY.md` is generated by `scripts/compliance/build-pii-inventory.ts`). `ExportJob`, `isWrongRoute` and `newRouteId` are unused by any code.
- **18 migrations.** Raw-SQL objects that `schema.prisma` does not declare — **`npm run db:migrate` is `prisma migrate dev`; do not run it against a real database without checking drift**:
  - partial unique indexes `CustomerEdit_open_per_customer`, `CustomerEdit_open_per_branch`, and `(submittedById, submissionId)` is declared;
  - raw-only indexes such as `Customer_legalName_btree_idx`, `Customer_crNumberNorm_idx` (partial, non-unique), `Branch_routeId_dayOfVisit_deletedAt_idx`, `Customer_deletedAt_idx`, three `pg_trgm` GIN indexes and the extension itself;
  - trigger `branch_region_consistency_check` (a branch's region must equal its route's region) and its draft twin;
  - CHECK constraints (GPS ranges on Branch, Attachment and the draft table; `Branch_address_minlength`; credit limit ≥ 0 and term days 0–365);
  - **the append-only ledger:** one function, `nmwc_forbid_audit_mutation()`, behind BEFORE UPDATE/DELETE row triggers and BEFORE TRUNCATE statement triggers on `AuditLog` and `EditApproval`. It honours `nmwc.audit_maintenance='on'` only from a session logged in as the table owner (`20260914150000`, `20260914160000`). The ledger function and the branch-region trigger function both pin `search_path` (`20260915120000`).
- **Audit rows** go only through `writeAudit()` in `lib/audit.ts`. An ESLint `no-restricted-syntax` rule bans direct `auditLog.create*`/`upsert` in `app`, `components`, `lib`, `services`; `tests/unit/audit-guard.test.ts` proves the rule still fires. Operator scripts are deliberately outside the rule. System rows are attributed to a real user with null ip/user-agent and a `system:` reason.
- **Soft deletes:** `deletedAt` on Customer, Branch, Attachment. There is **no** central filter or middleware: each query handles soft deletes itself (some fetch by id and check `.deletedAt`; some read deleted rows on purpose). Verify per query.
- **Least-privilege role:** `scripts/ops/app-role.ts` defines `nmwc_app`: SELECT/INSERT/UPDATE on all tables except `REVOKE ALL` on `_prisma_migrations`; DELETE only on six tables (Attachment, Notification, SavedView, EditBranchDraft, PasswordHistory, RateLimit); no UPDATE/DELETE/TRUNCATE on `AuditLog`/`EditApproval`; no DELETE/TRUNCATE on `CustomerEdit`. The role exists on production with grants applied. **Status:** per `docs/CREDENTIAL-ROTATION.md` (2026-09-23) production still connects as the owner role **(Vercel setting, not verifiable from the repo)**. Consequence: while the app runs as the table owner, its own credential can use the ledger override or disable the triggers — today the triggers stop accidents, not a leaked app credential. (`docs/OPERATIONS.md` §5c and the `app-role.ts` header say the switch is done; they are stale.)
- **Backups:** nightly `pg_dump` → integrity gates → age encryption → R2 (`db-backup.yml`); successful on 09-23, 09-24, 09-25 after failing 09-18 to 09-22. CI rehearses dump → encrypt → restore → verify on every push (`restore-chain`). The monthly restore drill against Neon has **never run** (needs owner-provided `NEON_API_KEY`/`NEON_PROJECT_ID`). Photos have a single copy until R2 versioning is enabled (owner action).

## 8. Security controls

- **Passwords:** bcrypt cost 12. New and reset accounts, and imported accounts whose row sets `must_change_password`, must change it at first sign-in (AUTH-09): ≥12 characters, not the current one nor one of the last five. `mustChangePassword` is enforced **only** by the middleware redirect (from the cookie claim), not re-checked by actions.
- **Login throttling:** buckets per username and per client IP (first `X-Forwarded-For` value), capacity 5 refilling 5 per minute, Postgres-backed. A login through the form is charged **twice** per bucket (the login action and again inside `authorize()`), so the effective burst is about two attempts; a refusal inside `authorize()` shows as "Invalid username or password" even for a correct password. `login:` keys fail closed if Postgres is unreachable, unless `RATE_LIMIT_BACKEND=memory` or `DATABASE_URL` is unset. Failed logins on existing usernames write an audit row; unknown usernames and rate-limited attempts reach only the logger.
- **Sessions:** JWT, 8 h, `__Host-` cookie, httpOnly, SameSite=Lax, Secure in production. Revocation timing: §5 "Session facts".
- **The middleware does not gate signed-out requests.** `auth.config.ts`'s `authorized: false` is discarded because `middleware.ts` wraps a function (next-auth beta.32, `node_modules/next-auth/lib/index.js`); the file explains why returning a Response would break server-action POSTs. **Every page, route handler and server action checks auth itself** — an engineering decision recorded as SEC-01 in `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`; verify it per surface (§4 lists the routes). Stale comments: `middleware.ts` header still claims "Auth gating", `auth.config.ts` names beta.31.
- **Cross-site requests:** SameSite=Lax is the main control. Server actions also get Next's built-in Origin check (`next.config.ts` sets no `allowedOrigins`). Only `app/api/forms/[form]` checks Origin and content type itself. Photo presign/finalize rely on Lax plus the session and parse any body as JSON. The cookie-authenticated GET exports write an `EXPORT` audit row (Lax cookies are sent on top-level cross-site GET navigations).
- **CSP:** per-request nonce, `strict-dynamic`, no `unsafe-eval` in production (`lib/csp.ts`). **Never reorder the directives** — Next finds the nonce with `startsWith('script-src')`; `tests/unit/csp.test.ts` pins it. Plus HSTS, nosniff, `X-Frame-Options: DENY`, COOP/CORP (`next.config.ts`). The maintenance 503 carries no CSP.
- **Demo accounts** (`steward`, `viewer`, `admin`, `salesman.*`, `supervisor.*`, `manager.a|b`) are refused at sign-in only when `DEMO_ACCOUNTS_DISABLED` is exactly `'true'` (said to be set in production — not verifiable from the repo). The JWT refresh does not re-check it. `tests/unit/golive-usernames.test.ts` keeps go-live usernames clear of the denylist. Pilot accounts from `prisma/seed-muscat-pilot.ts` (e.g. `pilot.steward`) are not on the denylist and do not set `mustChangePassword`; commit `6d7fe64` says 26 pilot/QA leftovers show as disabled — whether every one is disabled is not verifiable from the repo.
- **Machine auth:** cron and ops routes need `Bearer CRON_SECRET` (compared in constant time after a length check; an unset secret always denies). `/api/health` detail needs `HEALTH_BEARER` (≥20 chars); a wrong bearer gets 401.
- **Maintenance mode:** `MAINTENANCE_MODE=on` → bilingual 503 (`x-nmwc-maintenance: 1`) for everything except `/api/health`, `/api/cron/`, `/api/ops/`, `/api/auth/`, `/_next`, and any request carrying the bypass cookie `nmwc_maintenance_bypass` equal to `MAINTENANCE_BYPASS_TOKEN`.
- **Secrets hygiene:** gitleaks runs in CI on **each push's new commits only** (the log shows "1 commits scanned"; the `ci.yml` comment claiming full history is wrong) with default rules and no `.gitleaks.toml` — a green scan says nothing about older history or low-entropy passwords (§14). `npm audit --omit=dev` is gated at critical: 0 critical, 4 high, 3 moderate open; fixing them needs Next 16, Prisma 7 and an exceljs change. Dependabot is configured (weekly, majors ignored).
- **The owner parked the security part of the 2026-09-24 re-benchmark** ("ignore security, we will see that later"); five security items were set aside. Neither the quote nor the items are in the repository. Security findings are still valuable — expect some to be known (the assessment's open backlog lists many).

### Rate limits

| Key / surface | Limit | Backend / failure mode |
|---|---|---|
| `login:user:*`, `login:ip:*` (login action + `authorize()`) | 5, refill 5/min | Postgres; fails closed |
| `edit:<userId>` — UPDATE and CREATE submits, both draft saves | 60/hour | Postgres; fails open to memory |
| photo presign | 120/hour | Postgres |
| photo serve (`photos/[id]`) | 60 burst, 1/s | per-instance memory only |
| imports, Temix batches | capacity 3 | Postgres |
| **No limit:** the three exports; approve, reject and bulk actions (up to 50 per call); close/reactivation requests; password reset and the rest of user admin; `GET /api/forms/customer-create`; `perf-probe`; `/api/health` (one DB round trip per anonymous call) | | |

A `passwordreset:` key prefix is treated as critical in `lib/rate-limit.ts` but nothing uses it.

## 9. Environment variables that change behaviour

Names only (`.env.example`); **production values are not verifiable from the repo**.

| Variable | Effect |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | pooled app connection / owner connection |
| `AUTH_SECRET` | strength-checked (≥32 chars, not trivially low-entropy) only when `NODE_ENV=production`; `AUTH_URL`/`NEXTAUTH_URL` are deleted on non-production `VERCEL_ENV` |
| `DEMO_ACCOUNTS_DISABLED` | demo denylist enforced only for the exact string `'true'` |
| `RATE_LIMIT_BACKEND` | `memory` makes every limiter per-instance and disables fail-closed |
| `CRON_SECRET`, `HEALTH_BEARER` | machine bearers (the same `CRON_SECRET` is held by cron-job.org, a third party) |
| `MAINTENANCE_MODE`, `MAINTENANCE_BYPASS_TOKEN` | maintenance 503 and its bypass cookie; Vercel env changes need a redeploy |
| `ALERT_WEBHOOK_URL` | operations alerts (inert when unset or not https) |
| `SALESMAN_SUBMIT_GATE` | `FULL` tightens the salesman submit gate (not in `.env.example`) |
| `WORK_*`, `SLA_*_MIN` | override the workweek (D1) and the SLA budgets; budgets are frozen onto requests at submit |
| `PROMOTE_SLICE_BUDGET_MS`, `BULK_BUDGET_MS` | import-promote and bulk-action time slices (not in `.env.example`) |
| `R2_*`, Sentry vars | storage and error reporting; `/api/health` reports R2 as `pending` (counted as OK) when R2 vars are absent |

`npm run smoke` checks none of `DEMO_ACCOUNTS_DISABLED`, `RATE_LIMIT_BACKEND`, `SALESMAN_SUBMIT_GATE` or the bypass token.

## 10. Deployment and operations

- **Merging to `main` deploys production** through the Vercel ↔ GitHub integration (documented in `ci.yml` comments and CLAUDE.md; there is no repo config for it). CI does **not** deploy, and nothing in the repo makes Vercel wait for CI; the process rule is that `main` is fast-forwarded only to a commit whose CI is already green. Per a 403 recorded on 2026-09-14, GitHub branch protection is not available on the current plan.
- **Build order** (`package.json` `build`): `prisma generate && next typegen && tsc --noEmit && next lint && prisma migrate deploy && next build --no-lint`. Migrations run **before** `next build`, so anything `next build` refuses (compile, prerender, per-page route types) surfaces after the schema changed; typecheck and lint were moved ahead of the migrate to shrink that window. `tests/unit/ci-gates-guard.test.ts` pins the chain and its order (it asserts the migrate still precedes `next build` — it pins the hazard, it does not remove it). "Run typecheck/lint/unit before pushing" is a process rule no test can enforce.
- **CI** (`.github/workflows/ci.yml`, every push to every branch; superseded runs cancelled except on `main`):
  - `lint-test-build`: typecheck, lint, `npm test`, `next build` (no migrate), `npm audit` gate.
  - `db-tests`: migrate, seed, `app-role.ts` create/grant/verify, generated fixtures, the PII-inventory check, and 22 integration suites (17 `RUN_*` flags). It connects as the owner role; only `audit-immutability` connects as `nmwc_app`.
  - `e2e`: `login.spec.ts` on `next start` (chromium + mobile-chrome projects, 2 retries).
  - `restore-chain`, `secrets-scan`.
  - `post-deploy-smoke` (`main` only, needs only `lint-test-build`): retries `scripts/ops/smoke.ts --expect-commit $GITHUB_SHA` up to 24 times, 15 s apart (~12 min), then fails. The commit check is a 7-character prefix match. It exits **green** when the only failing check is the cron dead-man in a known alarm state (never/stale/failed — `failed` is only a `::warning::`), so a green job does not mean all 16 checks passed.
- **`npm run smoke`**: 14 read-only checks without a bearer (health, CSP/nonce, security headers, redirects, cron/ops/photo/export routes refuse without auth, region `iad1`, auth provider host); 16 with `HEALTH_BEARER`.
- **Scheduled work:**
  - Vercel crons: `photo-gc` 03:00 UTC, `retention-sweep` 03:30 UTC.
  - `keep-warm` (every 4 min) and `sla-escalate` (:15, :45) in the window 03:00–14:59 UTC **every day**, weekends included — called by **cron-job.org** (owner decision D3, recorded in `docs/GO-LIVE-RUNBOOK.md` §0; whether those jobs exist is **not verifiable from the repo**) and by GitHub Actions as a backup (which delivers late and irregularly). The SLA sweep is claim-guarded and idempotent.
  - `db-backup` 02:00 UTC (GitHub start times have varied from 02 to 13 UTC); `restore-drill` 04:00 UTC on the 1st; `r2-config` 05:00 UTC.
  - Every cron records a heartbeat; `/api/health` with the bearer alarms on `failed`, `stale` and `never`.
- **Alerts:** `lib/alert.ts` posts to `ALERT_WEBHOOK_URL`: a closed set of three events (`sla.escalated`, `cron.failed`, `import.rejections`), deduplicated per event/severity/scope in fixed 4-hour UTC windows. The payload carries counts, system-minted ids and a free-text message scrubbed of phones, e-mails and digit runs (not of customer names).
- **Other workflows:** `cron-scheduler` (dispatch only; creates/fixes the cron-job.org jobs), `provision-app-role` (sets `ALLOW_PRODUCTION=1` on every run; its only gate is a typed `confirm_host`, matched as a substring), `r2-config` (red until the owner mints R2 admin tokens **and** enables photo-bucket versioning with non-current retention).
- **Operational docs:** `docs/OPERATIONS.md` (partly stale — §15), `docs/CREDENTIAL-ROTATION.md`, `docs/GO-LIVE-RUNBOOK.md` (stale header).

## 11. Standing rules (`CLAUDE.md`) — and how true they are today

`CLAUDE.md` is the working agreement for anyone changing this code; each rule names the incident behind it. Read it first. So you can hold the code to the rule rather than to its wording:

| Rule | Status in code |
|---|---|
| Never write to the production DB (`ep-sweet-haze`); "every gated test asserts" it | **18 of 25** integration suites throw on `DATABASE_URL` in `beforeAll`. The other **7 do not**: `import-reconciliation`, `import-region-codes` and `rate-limit-pg` have no production check at all; `merge-attachment-reparent`, `merge-concurrency`, `promote-reconciliation` and `reactivation-authz` call the purge helper, which checks only `DIRECT_URL` — that stops the two merge suites before their first write, but runs after the writes in `reactivation-authz` and is swallowed by `.catch` in `promote-reconciliation`. There is no central guard. `app-role.ts`, `restore-verify.ts`, `prisma/synthetic.ts` and `seed-muscat-pilot.ts` refuse production **unless** `ALLOW_PRODUCTION=1` / `ALLOW_PROD_SEED=1` is set ("outright" in CLAUDE.md is too strong). `scripts/qa/run-with-env.mjs` loads `.env` and has no host check. |
| `golive-data/` is PII, never committed or read into a transcript | Gitignored; in no commit on any ref. |
| Never let a secret reach a log/transcript; complex strings go in a script file, not `node -e`/heredoc | Process rule. |
| Merging to `main` deploys; never fast-forward without the owner's explicit yes | Process rule; no branch protection available. |
| `migrate deploy` runs before `next build`; typecheck, lint and unit before pushing | The build order is pinned by `ci-gates-guard`; running checks before pushing is process. |
| Gate the merge on CI's exit code for the exact head SHA | Process rule. |
| `npm run smoke` before and after production changes | Process rule; plus `post-deploy-smoke`. |
| Audit rows only through `writeAudit()` | ESLint rule + `audit-guard` test. |
| Never reorder the CSP | `csp.test.ts`. |
| Never relax the demo denylist; rename the account | `lib/demo-accounts.ts`, `golive-usernames.test.ts`. |
| `DATABASE_URL` is the pooled least-privilege role; `DIRECT_URL` the owner | **The design; per the owner docs not yet true in production** (§7). |
| A fixture that reads the real clock is never asserted against a literal | Followed where spot-checked (`golive-update-flow.test.ts` derives `PROPOSED_DAY`); the item-22 tests were fixed for exactly this in `ab5867f`. Not exhaustively checked. |
| Prefer structural guards where the defect is "nobody called it" | `tests/unit/*-guard.test.ts` (§13). |
| Windows quirks (`excel`/`import-templates` first-run timeouts; slow `ci-gates-guard`) | Rerun before investigating. |
| Run an adversarial pass after every substantial merge, including your own | Recent merges each have a follow-up review commit (e.g. `e7db028`, `efe3729`, `ab5867f`, `2d1e702`). |
| When the record says something is the owner's decision, ask — don't implement | §12. |
| Say what is not done | Some commits end with "Not done" lists (items 22, 28, 41/40b among them); most do not. |

## 12. Deliberate choices that look like bugs

Do not report these as defects without new evidence; you may of course challenge the risk they accept.

| Choice | Kind | Where recorded |
|---|---|---|
| **One shared initial password for every account, forced change at first sign-in.** Salesman usernames are route codes; managers use class codes (`mct-gt`…); the steward and approvers have generic names (`data.steward`, `accountant.<region>`, `finance.manager`, `gm.nmwc`) — all guessable. Accepted risk: until first sign-in, anyone who knows the shared value can take over an account. The per-account version (`db51732`) was reverted (`dff8b27`) as the owner's call. | owner | `scripts/golive/build-masters.ts`; runbook §1.1, §1.8 |
| Middleware `authorized:false` left inert; every surface checks auth itself (SEC-01) | engineering | `auth.config.ts`; assessment (SEC-01) |
| No Supervisor accounts; any Manager whose regions overlap approves the Supervisor step (the four Muscat managers all have region `MCT`) | owner | runbook §0; fallback rule in `lib/permissions.ts`; managers in `build-masters.ts` |
| Manager/Steward direct write skips approval and the mandatory gate (audited) | owner | `services/edits.ts` |
| VIEWER reads and exports org-wide incl. CR/GUARANTEE documents; FM/GM read org-wide | FM/GM owner-confirmed; VIEWER "by design" | `lib/access.ts`, `lib/permissions.ts` |
| CORE submit gate by default (2026-09-10) | owner | `lib/submit-gate.ts` |
| Workweek Sun–Thu (D1); credit CRM-owned (D2 — but see §15); Temix header contract (D4 — file not yet confirmed with Temix) | owner | `qa/reports/OWNER-DECISIONS.md` |
| External cron scheduler (D3, 2026-09-14) | owner | `docs/GO-LIVE-RUNBOOK.md` §0 |
| No unique phone index (one owner, several shops); no unique CR index (legacy duplicates); `temixCode` nullable, not unique | owner / engineering | migration `20260510160000`; `lib/create-guards.ts`; schema |
| Duplicate detection is exact-only | owner (May 2026) | `docs/CHANGELOG.md` P1.4 |
| Offline descoped to localStorage drafts (no IndexedDB queue, no offline photos) — items 21/23 open | owner | `docs/BUILD-REPORT.md` |
| Item 41 (2026-09-25): a GPS point typed by hand is flagged by a marker inside `CustomerEdit.fieldChanges` (no migration); the salesman's reason lands in the immutable audit row; the flag is not visible on the branch after approval | owner | `lib/gps-manual.ts` |
| Item 40b: Call/Directions chips on list cards for all roles, VIEWER included | owner | `app/(app)/customers/page.tsx`; `666bce8` |
| Item 22 (2026-09-25): no offline queue or auto-retry; a `submissionId` column; all three field forms; Save draft keeps the phone copy | owner | `lib/submission.ts`, `b7d9041` |
| Item 4: a Temix crosswalk import was built and withdrawn before commit, pending a provenance column (a schema change = the owner's call) | owner | `54de6aa` message |
| Exports are never stored server-side (a stored export is a new copy of personal data at rest) | owner | `services/exports.ts` |
| Escalation never changes workflow state | engineering | `lib/escalation.ts` |
| Bulk-loaded customers skipped the approval chain | owner | runbook §3 |
| Credential rotation to be done **last**, after the functional work | owner | only outside the repo; `docs/CREDENTIAL-ROTATION.md` says "the next thing" and the runbook said "before load day" |

## 13. How the team verifies changes — and what the tests exercise

- Before any push: `npm run typecheck` (runs `next typegen` first — bare `tsc` misses route types), `npm run lint`, `npm test`. Integration suites run locally against the UAT branch by practice (`scripts/qa/run-with-env.mjs` just loads `.env`); CI runs 22 of them.
- **Structural guards** assert on source or configuration where the historical defect was "a correct helper nobody called": `submit-wiring-guard`, `audit-guard` and `branch-address-guard` read comment-stripped source; `ci-gates-guard` executes the workflow's shell steps under `bash -e` with stubs; `typed-routes-guard` compiles probe files; `pii-classification` parses the schema. 11 test files still strip comments with a naive regex that `tests/support/strip-comments.ts` documents as wrong.
- **Mutation testing by hand**, recorded in commit messages (e.g. `efe3729` 11/11 unit mutants; `ab5867f` 20/20; `2d1e702` 11/11). No Stryker config.
- **Adversarial review after merges**: three to six lenses, each finding put to one or two independent skeptics; confirmed findings are fixed in a follow-up commit whose message lists them.
- **What the tests actually exercise (read "927 unit tests" with this in mind):**
  - Service functions are exercised against real Postgres by the integration suites; 21 of 25 mock `@/lib/auth`, so the real session path runs only in `tests/e2e/login.spec.ts`.
  - Unit tests reach services mostly through source-text guards or `vi.mock`; `customer-master-export.test.ts` is the one unit test that runs a service with Prisma mocked.
  - No test exercises `services/temix.ts`, `customers.ts`, `routes.ts`, `saved-views.ts`, `notifications-actions.ts` or `customer-export.ts` for behaviour; `findDuplicateCandidates` and `dismissDuplicateAction` have no tests (benchmark item 16).
  - Not run in CI and **not to be run by you**: `build-chain-data` and `uat-load` (leave data behind), `golive-rehearsal` (reads `golive-data/`); `tests/e2e/golive-update-flow.spec.ts` needs a live R2 bucket.
  - No test coverage is measured (the vitest coverage block is configured but the provider is not installed).
- Commit messages are the design record for recent work: `git log --format=%B` for `54de6aa`, `666bce8`, `e7db028`, `b239e4b`, `3e775d4`, `efe3729`, `b7d9041`, `ab5867f`, `2d1e702`.

### Finding-ID prefixes in comments

Comments cite findings from several audits whose prefixes collide. Before reporting, check whether an ID's source already records it:

| Prefix | Source |
|---|---|
| AUTH, PROD, RBAC-05, NEW-PHOTO, UXI, F-NN, **GAP-NN (May)** | `docs/audit/01-auth-session.md` … `07-cross-check.md` (May 2026) |
| B-NN, F-C* | `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`, `qa/findings/register.md` |
| QA-* | `docs/QA-AUDIT-REPORT.md`, `docs/REMEDIATION-REPORT.md` |
| SEC-*, REL-*, B1–B6, DG-*, DO-* | `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md` (2026-09-14) |
| other hunts | `qa/findings/final-golive-hunt.md`, `deep-scan-round2.md`, `pre-launch-deep-review.md` |
| "final-hunt #N", "perf audit #N", F-UAT-* | `docs/SESSION-MASTER-RECORD.md`, `qa/evidence/uat-live-run.md` |
| **item N / Gap #N / GAP-0N (Sept)** | the 2026-09-24 re-benchmark (Appendix A) |

Collisions: `B-13` (May) vs `B3`/`B6` (September); `GAP-07`/`GAP-08` in `ci.yml` are re-benchmark items 7 and 8, but `GAP-12` in `lib/rate-limit.ts` and `GAP-03` in photo-gc are the May cross-check; `F-01`, `F-C11`, `F-15` and `F4` come from four different sources.

## 14. Sensitive material in the repository

Name the file and line in findings; do not reproduce values. The owner has been told about this list.

- **The shared initial password** — live for any account that has not yet signed in **(not verifiable from the repo whether any such account remains)** — appears in: `scripts/golive/build-masters.ts` (`INITIAL_PASSWORD` and other lines), `app/actions/auth.ts` (a comment), `docs/GO-LIVE-RUNBOOK.md`, `docs/OWNER-ACTIONS-NOW.md`, `docs/CREDENTIAL-ROTATION.md`, `docs/SESSION-MASTER-RECORD.md`, `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md` and its `.html` twin, `tests/e2e/golive-update-flow.spec.ts`, `tests/integration/golive-update-flow.test.ts`, `tests/integration/import-region-codes.test.ts`, and the messages of commits `db51732`, `dff8b27`, `fbbb270`, `29e7ee6`.
- **Pilot production passwords (May 2026):** `docs/audit/E2E-VERIFICATION-2026-05-10.md` ("Production credentials reference"), `prisma/seed-muscat-pilot.ts`, `scripts/capture-guide-screenshots.ts`, `scripts/capture-steward-screenshots.ts`, `scripts/synthetic-launch-test.ts`; in history `docs/PILOT-MUSCAT-CREDENTIALS.md` (removed in `821b02b`), `scripts/bulk-reset-credentials.ts` at `61ddec1`, and the seven docs `821b02b` redacted.
- **A seeded admin password** (the `prisma/seed.ts` fallback): `docs/OPERATIONS.md`, `prisma/synthetic.ts`, `docs/BUILD-REPORT.md`, `docs/PILOT-E2E-TEST-2026-05-10.md`, `docs/QA-AUDIT-REPORT.md`, `docs/REMEDIATION-REPORT.md`, `docs/SESSION-HANDOFF-2026-05-09.md`, `docs/audit/01-auth-session.md`, `docs/audit/07-cross-check.md`.
- **A demo password:** `docs/SESSION-MASTER-RECORD.md`, `docs/BUILD-REPORT.md`, `docs/QA-AUDIT-REPORT.md`, `docs/SESSION-HANDOFF-2026-05-09.md`, `prisma/synthetic.ts`, `qa/evidence/uat-live-run.md`, `tests/integration/build-chain-data.test.ts`, `tests/loadtest.mjs` (which also defaults to the production URL).
- `ci.yml` has literal passwords for the throwaway CI database only.
- **Staff personal data:** employees' full names in the managers roster (`scripts/golive/build-masters.ts`, `docs/GO-LIVE-RUNBOOK.md`); a real person's name as a pilot supervisor username (`docs/OPERATIONS.md`, `docs/GO-LIVE-RUNBOOK.md`, `docs/audit/E2E-VERIFICATION-2026-05-10.md`, `prisma/seed-muscat-pilot.ts`).
- **Possibly customer data in images:** `docs/guide/img/*.png` (21 files) and the guide PDFs were captured from production during the May pilot (`scripts/capture-guide-screenshots.ts`; commit `a6585db`). Not inspected for this brief.
- **Credential exposures recorded:** the production database owner credential was exposed on 2026-09-23 (`docs/CREDENTIAL-ROTATION.md`), and earlier (runbook §0 row 1: "pasted in chat and appears in UAT screenshots"; Neon branches share the owner password, so UAT and production share it). Whether rotation has happened is not recorded in the repo.

## 15. Docs versus code — known contradictions

Trust the code. Known stale or contradictory documents:

- **`README.md`** still says "Milestone 0". **`docs/PRD-v0.1.md`** (v0.2) predates 8 roles, CREATE, Manager direct write and escalation. **`docs/TECH-SPEC.md`** describes a Prisma soft-delete middleware (none exists), a unique phone index (dropped), pnpm and an 80% coverage target (no coverage is measured); its §5.4 (idempotency) is current.
- **`docs/GO-LIVE-RUNBOOK.md`** header says the load has not run (it ran 2026-09-23). **`docs/OWNER-ACTIONS-NOW.md`** (2026-09-23) says backups fail (the workflow has succeeded since 09-23) and that cron jobs still need creating (work on them landed 2026-09-24).
- **`qa/reports/OWNER-DECISIONS.md`** still shows D3 as needing Vercel Pro (superseded by the external scheduler) and D5 as pending.
- **Passwords:** `docs/SESSION-MASTER-RECORD.md` and the assessment (SEC-11, "closed in code") describe per-account passwords; the code uses one shared value (§12).
- **Least-privilege role:** `docs/OPERATIONS.md` §5c and the `scripts/ops/app-role.ts` header say production runs as `nmwc_app`; `docs/CREDENTIAL-ROTATION.md` (2026-09-23) says it does not.
- **Credit ownership (D2):** the decision says CRM-owned; `services/imports.ts` (refresh lane) and `services/edits.ts` comments treat Temix as authoritative. A genuine open question (the "D2 note"), not only a stale doc.
- **Escalation fallback:** `lib/escalation.ts` says all Managers; `app/api/cron/sla-escalate/route.ts` falls back to the GM.
- **Duplicates page** empty state mentions phone and fuzzy-name matching; only exact CR and EXACT_TRIPLE exist.
- **`lib/export-scope.ts`** says it is shared so the exports cannot disagree; the master and filtered exports keep their own copies.
- **`OPERATIONS.md`** says CI deploys (it does not), lists 3 heartbeat jobs (there are 5), and says "no maintenance mode" (there is one).
- **Comments:** `middleware.ts` header claims auth gating; `auth.config.ts` names next-auth beta.31 (beta.32 is installed); the `ci.yml` secrets-scan comment claims full history; a leftover `ci.yml` comment calls the audit gate "advisory"; migration `20260510160000` mentions a CR unique index that never existed; `app/api/cron/keep-warm/route.ts` points at a `vercel.json` entry that does not exist.
- **`docs/BENCHMARK-REPORT.md`** is the May 2026 benchmark (63/100), not the 2026-09-24 re-benchmark whose numbered items commits cite (Appendix A).

## 16. How to verify locally

```bash
npm ci
npm run typecheck        # next typegen + tsc --noEmit
npm run lint
npm test                 # 927 unit tests (one skips without golive-data/); integration files collect and skip
npx next build           # no migrate; needs AUTH_SECRET >= 32 varied chars and placeholder DATABASE_URL/DIRECT_URL
```

**Integration suites** (your own empty Postgres only):

```bash
# DATABASE_URL and DIRECT_URL both pointing at your database
npx prisma migrate deploy && npm run db:seed
RUN_GOLIVE_FLOW=1 npx vitest run tests/integration/golive-update-flow.test.ts
```

The `RUN_*` flag of each suite is in its `describe.skipIf`; the CI set is in `ci.yml` (`db-tests`). Reproducing all of CI also needs `scripts/ops/app-role.ts create/grant` with `NMWC_APP_URL` (for `audit-immutability`) and the generated import fixtures (`ci.yml`).

**Running the app by hand:** `npm run db:synthetic` on your own database creates users for every role (it truncates core tables and refuses `ep-sweet-haze` unless overridden); `npm run db:seed` alone creates one Manager. Use `npm run dev` for interactive sessions — under `next start` over plain http the browser drops the `__Host-`/Secure cookie and sign-in does not persist. Photo flows need an R2 bucket of your own (never `nmwc-photos`); without one, test them by inserting `Attachment` rows as the integration suites do — and since the CORE gate needs a shop photo, no salesman submit completes locally without that. Playwright: build, start `npx next start` on :3000 first (as `ci.yml` does) or set `E2E_BASE_URL`; otherwise `playwright.config.ts` starts `npm run dev` itself.

## 17. Where to look first

1. `CLAUDE.md`, then §11–§12 of this brief.
2. `auth.config.ts`, `middleware.ts`, `lib/auth.ts`, `app/actions/auth.ts`.
3. `lib/access.ts`, `lib/permissions.ts`, `lib/customer-filters.ts`, `lib/export-scope.ts` vs `services/exports.ts` and `services/customer-export.ts` (§5 "two levels").
4. `services/edits.ts` (submit, approve, reject, `applyEditChanges`), `services/creates.ts`, `lib/create-finalize.ts`, `lib/create-guards.ts`, `lib/approval-chains.ts`.
5. `app/api/forms/[form]/route.ts`, `lib/submit-client.ts`, `lib/submission*.ts` (item 22).
6. `services/imports.ts` promote lanes; `services/duplicates.ts` merge; `services/temix.ts`.
7. `app/api/photos/*`, `lib/photo-mime.ts`, `services/photos.ts`.
8. `prisma/schema.prisma` and the ledger migrations `20260914150000`, `20260914160000`, `20260915120000`; `scripts/ops/app-role.ts`.
9. `package.json` scripts, `.github/workflows/ci.yml`, `tests/unit/ci-gates-guard.test.ts`, `scripts/ops/smoke.ts`.
10. `app/api/health`, `lib/heartbeat.ts`, `lib/cron-auth.ts`, `app/api/cron/*`, `lib/alert.ts`, `lib/maintenance.ts`, `lib/rate-limit.ts`.
11. `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md` (remediation log and open backlog).

## 18. Known gaps and open items

**Owner-side (blocked on the owner, not on code):** restore-drill secrets; `ALERT_WEBHOOK_URL`; R2 photo versioning + admin tokens; Temix file format confirmation; switching production to `nmwc_app`; credential rotation (last); PDPL/residency blanks; the export round-trip decision; the D2 credit-ownership note; the draft-photo retention period; the items under "Decisions" in `OWNER-ACTIONS-NOW.md`.

**Code-side, recorded as not done:**
- Item 22: an approver's notification is lost if the reply is lost between the insert and the notify (the retry is answered "received"); a retry after a duplicate merge moved the edit is refused as a reused id; a changed retry of a photo-less new-customer draft without a reload can create a second draft; a full-page load after submit shows the browser's offline page if that load fails.
- Item 28: `/customers` "Export filtered" capped at 5,000; no export is rate-limited; the field-update report's 60k ceiling is estimated, not measured on the platform.
- Items 41/40b: change-report GPS rows do not mention a typed point; the direct-write audit row carries no branch data.
- `mustChangePassword` enforced only by the middleware redirect; per-username login lockout can be triggered by anyone (usernames are guessable).
- No sweep for **never-attached** uploads or for photos claimed by abandoned new-customer drafts (photo-gc only processes soft-deleted rows). An unmerged July attempt lives on branch `claude/nervous-saha-580313` (two commits labelled GAP-03/Q4 — the May label, not re-benchmark item 3).
- The PRD's wrong-route flag and add-branch sub-flows are not built.
- The remaining items of the 2026-09-24 re-benchmark (Appendix A).

## 19. Glossary

- **Temix** ("Timix" in some files) — the company ERP; system of record. **RoutePro** — the route/credit source used for the go-live load.
- **Steward** — the Data Steward role (imports, merges, Temix batches).
- **Route / region** — a salesman's route belongs to one region; a branch's region must equal its route's region (DB trigger).
- **CustomerEdit** — any change request (UPDATE, CREATE, close, reactivate); **fieldChanges** — its before/after list.
- **Chain / step / cycle** — the frozen approval sequence on a request; `pendingRole` names who acts next; a resubmission starts a new cycle.
- **CORE / FULL gate** — the salesman submit gate's two levels.
- **Direct write** — a Manager's/Steward's edit applied without approval.
- **Refresh lane** — the import path that updates Temix-owned fields on an existing customer whose Temix code matches.
- **EXACT_TRIPLE** — duplicate key: legal name (case-insensitive) + normalized phone + region.
- **Item N** — an entry in the 2026-09-24 re-benchmark list (Appendix A); comments also cite some as "Gap #N"/"GAP-0N" — do not confuse with the May audit's GAP-NN.

---

## Appendix A — The 2026-09-24 re-benchmark list (items 1–41)

The re-benchmark report itself is **not in the repository**; this list is the owner's working copy, and the owner works through it by number. Titles for items 9–21, 23–27 and 29–35 cannot be checked against the repo. Five security items were parked by the owner and are not listed. Status as of 2026-09-25.

**Do now (1–8)**
1. Restore drill never run — tooling fixed; **owner**: `NEON_API_KEY`, `NEON_PROJECT_ID`, then run once.
2. No alerting — `lib/alert.ts` shipped; **owner**: `ALERT_WEBHOOK_URL` in Vercel + redeploy.
3. Photos have no backup — verifier shipped; **owner**: R2 versioning + admin tokens (`r2-config` red until then).
4. Temix codes can never come back in — crosswalk withdrawn; **owner** decision on a provenance column.
5. Temix file format never confirmed with Temix — **owner** (business).
6. Push to main / migrate before build — **done** (typecheck + typegen + lint before migrate); branch protection not available on the plan.
7. Browser tests never ran in CI — **done** (Playwright job).
8. Smoke never ran after deploy — **done** (`post-deploy-smoke`).

**Weeks (9–32)**
9 SLOs/dashboard · 10 log search/tracing · 11 health goes red for minor things · 12 unconfigured R2 reads healthy · 13 one person holds every credential · 14 app connects as the DB owner · 15 duplicates found only when the screen opens · **16 no tests on duplicate detection** (next, per the owner 2026-09-25) · 17 merge not undoable and discards better values · 18 no data-quality history · 19 quality score counts "Address pending" as data · **20 Steward cannot fix quarantined/rejected import rows in-app** (next, per the owner 2026-09-25) · 21 not installable/offline · **22 lost connection at submit — done** (`b7d9041`, `ab5867f`, `2d1e702`) · 23 photos cannot be taken offline · 24 nothing measures plan adherence · 25 Today covers about a third of the route · 26 Arabic only in stale PDFs · 27 notifications in-app only · **28 Excel export capped at 25,000 — done** (`b239e4b`, `3e775d4`, `efe3729`) · 29 no API · 30 no machine accounts · 31 no feature flags/staging · 32 three test suites never run in CI.

**Months (33–35)** 33 visits/orders/surveys/coolers (buy vs build) · 34 multi-country/company · 35 order capture cannot reuse the approval engine.

**Small daily (36–41) — all done** (`86a4eb4`, `666bce8`, `e7db028`): 36 phone keypad on phone fields · 37 review page and queue fit 320–1280 px · 38 wide tables scroll inside their box · 39 44×44 px steppers · 40a tel:/Maps/Directions links on detail screens · 40b Call/Directions on list cards (all roles) · 41 a typed-in GPS point is flagged to its approver.
