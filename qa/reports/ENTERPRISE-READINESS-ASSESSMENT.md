# Enterprise Readiness Assessment — NMWC Unified CRM / Customer Master

| | |
|---|---|
| **Assessment date** | 2026-09-14 |
| **Branch / commit** | `claude/nmwc-crm-consolidation-e10c1e` @ `27f3d94` — 74 commits ahead of `origin/main` @ `c612c79` (2026-05-11) |
| **Deployed production** | Verified live as the `origin/main` build: `/api/cron/sla-escalate` → 404; `x-vercel-id` region `fra1` = `origin/main:vercel.json:3` |
| **Method** | Static review of code, migrations, workflows, docs; `gh` and `npm audit` output. No servers started, no DB tests run, production DB untouched, `golive-data/` not read. |
| **Evidence rule** | Every claim cites `file:line` or a command output; unverifiable items are marked **Not Verified**. |

---

## 1. Executive Verdict

NMWC Unified CRM has an enterprise-grade **core** inside an SMB-grade **envelope**.

The core is above what most 60-user internal tools ship: fail-closed object-level authorization (`lib/access.ts:67-100,110-140`), engine-level separation of duty (`lib/permissions.ts:166-208`), a durable fail-closed login limiter (`lib/rate-limit.ts:28-53,93-134`), atomic compare-and-set claims on every workflow transition (`services/edits.ts:857-882,951-970,1164-1183,1502-1516`), DB-level partial uniques, triggers and CHECK constraints (`prisma/migrations/20260510120000_senior_audit_remediation/migration.sql:154-222`), a serverless-safe chunked import (`services/imports.ts:920-1053`), and daily off-provider backups with 126/126 green scheduled runs (`.github/workflows/db-backup.yml:19-21,114-134`).

The envelope an enterprise buyer inspects is thin or absent:

- **Release integrity** — production serves a 4-month-old `main` whose login limiter never denies (`git show origin/main:lib/rate-limit.ts` :88-104); CI has never run on the go-live branch (`.github/workflows/ci.yml:3-7`; `gh run list --branch claude/…` → empty).
- **Authorization gap** — a region-scoped MANAGER can mint an org-wide VIEWER with export rights and CR/GUARANTEE document access (`lib/permissions.ts:223-227`; `lib/access.ts:73-79,193`; `lib/export-scope.ts:18`).
- **Recovery** — the restore drill ran once (2026-05-10), failed, and has been gated off since (`db-backup.yml:154`; `gh secret list` → no `NEON_API_KEY`); RTO/RPO undefined.
- **Audit integrity** — 26 of 38 audit writers bypass the IP/UA envelope; AuditLog is mutable by the app credential; `docs/TECH-SPEC.md:776,779` tick controls that do not exist.
- **Identity** — credentials only; no MFA/SSO/SCIM (`lib/auth.ts:284-286`; grep `totp|saml|oidc|scim` → 0).
- **Observability** — browser errors never reach Sentry; anonymous `/api/health` always returns 200 (`app/api/health/route.ts:35-37`); no alerting or monitor.
- **Compliance** — Omani customer and employee PII processed and backed up in `us-east-1` with no residency decision, retention schedule or PDPL assessment.

**Score: 41/100 ("Production-capable SMB", floor of the band). Verdict: ❌ Not enterprise-ready.** Six confirmed P1 blockers, each remediable in days to weeks. The architecture does not need replacing; its operational and governance shell needs building.

---

## 2. Current Enterprise Readiness Score /100

**40.9 → 41 / 100**

| Band | Range | Meaning |
|---|---|---|
| Prototype | 0–20 | Works for its authors only |
| Early production application | 21–40 | Runs, but not safe to hand to an operations team |
| **Production-capable SMB application** | **41–60** | **Runs one company's business with a named engineer on call; fails enterprise procurement** |
| Enterprise-capable with significant gaps | 61–75 | Passes a security/ops review with documented exceptions |
| Strong enterprise-grade platform | 76–90 | Passes without exceptions; multi-team operable |
| Best-in-class enterprise maturity | 91–100 | Reference implementation for the category |

Weights sum to 100; Multi-tenancy is weighted 0 because the product is single-company by construction (grep `tenant|orgId|workspaceId` → 0). Closing the P1 blockers (§12) moves the score to the mid-40s; 61+ requires federated identity with MFA, an enforced CI gate with DB-backed tests, DB-level audit immutability under a least-privilege role, client observability with alerting, and signed residency/retention decisions.

---

## 3. Scorecard by Category

| Category | Weight | Score | Weighted | Evidence | Gap | Action |
|---|---|---|---|---|---|---|
| Architecture | 7 | 60 | 4.2 | Layering enforced (grep `@/services` in lib → 0); `runAction` `lib/errors.ts:112-151`; god functions `services/imports.ts:964-1746`, `services/edits.ts:770-1274`; 90 prisma call sites in `app/` | No read-model layer; 10 duplicated `require*()`; no config module | Read-models for hot pages; split 3 god functions; `lib/config.ts` |
| Scalability | 6 | 38 | 2.3 | Full-table dedupe `services/duplicates.ts:79-104`; id materialisation `app/(app)/audit/page.tsx:60-83`; inert `revalidate` `dashboard/page.tsx:14,17`; no pool sizing `lib/db.ts:7-21`; 10-VU load test only | Unbounded admin queries; sync exports; no load evidence | SQL dedupe; `@@index([at])`; scoped groupBys; ≥200-VU test |
| Reliability & Resilience | 8 | 44 | 3.5 | Atomic claims; backups green; drill failed once then gated (`db-backup.yml:154`); no S3 timeouts `lib/r2.ts:13-50`; DB call before render `app/(app)/layout.tsx:13-15` | RTO undefined; no maintenance mode; unreliable scheduler | Timed drill; Edge `MAINTENANCE_MODE`; S3 timeouts; Pro crons |
| Security | 11 | 55 | 6.1 | Fail-closed scope, SoD, nonce CSP `middleware.ts:37-47`; **but** MANAGER→VIEWER `lib/permissions.ts:223-227`; inert gate `auth.config.ts:87`; audit 4 critical/10 high; `'12345'` seed `scripts/golive/build-masters.ts:73` | Unscoped delegation; no MFA; boolean gate; no dep audit | Region-scope user admin; bump/pin deps; `authorized` returns Response |
| Enterprise Identity | 6 | 18 | 1.1 | Sole `Credentials` provider `lib/auth.ts:284-286`; no MFA fields `prisma/schema.prisma:175-227`; admin-typed resets `services/users.ts:279` | No SSO/MFA/SCIM/self-service | OIDC + IdP MFA; JIT provisioning; idle timeout |
| Data & Database | 7 | 62 | 4.3 | Partial uniques, trigger, 11 CHECKs, trgm, Decimal, versions; **but** no GRANT/TRIGGER on AuditLog; `db push` dropped constraints once (`qa/evidence/00-isolation-gate.json:15`); 7 missing FKs; no retention | Immutability by convention; drift risk; PII forever | `nmwc_app` role + trigger; `migrate diff` in CI; FKs; retention sweep |
| Multi-tenancy | 0 | — | 0.0 | No tenant identifiers (grep → 0); scope by route/region `lib/access.ts:5-10` | N/A by design | Record decision in TECH-SPEC |
| Observability | 6 | 25 | 1.5 | Server Sentry `instrumentation.ts:3-22`; client SDK dead; `environment: NODE_ENV`; health anonymous 200; no request id | No client capture, releases, alerts, monitor | `instrumentation-client.ts`; `VERCEL_ENV`; external monitor |
| DevOps & Deployment | 8 | 35 | 2.8 | CI main-only `ci.yml:3-7`; migrate-in-build `package.json:8`; no tags; no IaC; `sla-escalate.yml` absent from default branch; keep-warm 2–4 runs/day vs 180 | No branch CI or merge gate; migrations coupled to deploy | CI on all branches + Postgres job; migrate as release step; merge + tag |
| Testing & QE | 7 | 40 | 2.8 | 144 unit / 70 integration / 5 e2e; integration gated (`describe.skipIf` 20/20); no coverage-v8 installed; grep `401` in tests → 0; prod guard missing in 14 files | Integration/e2e never in CI; coverage unknown | Postgres CI job; thresholds; negative auth tests |
| Performance | 4 | 45 | 1.8 | Only baseline `docs/PROD-LOAD-AND-BUGS.md:11-22` (p95 3,089 ms @ 10 VU, May); 6 serialised login writes; ~500 ms geography floor (`docs/SESSION-MASTER-RECORD.md:81`) | No re-baseline or budgets | k6 on 20k dataset; dedupe login limiter |
| Governance & Auditability | 7 | 45 | 3.2 | Envelope on 12 writers; 26 bypass; swallowed writes `services/exports.ts:186`; exports as `IMPORT` `:180`; cron rows attributed to salesman `sla-escalate/route.ts:160-177` | Null ip/UA on business actions; mislabels; no system actor | Route all through `writeAudit`; SYSTEM user; fix labels |
| Compliance Readiness | 5 | 18 | 0.9 | Neon `us-east-1` `docs/OPERATIONS.md:18`; `vercel.json:3 iad1`; plaintext dumps via GitHub runner `db-backup.yml:29,114-133`; no PDPL/retention/PII register | Every documentary artefact absent | Signed residency register; PDPL opinion; encrypt dumps |
| User & Access Admin | 4 | 40 | 1.6 | `updateUserRoleAction` no UI caller (`services/users.ts:345`); `managedRegions` only via import `services/imports.ts:509`; routes admin unscoped `services/routes.ts:17-24` | Spreadsheet-driven admin; unscoped delegation | Role/region editor; region-scope admin actions |
| Enterprise UX | 4 | 42 | 1.7 | Sidebar hidden `<md`, tab bar salesman-only `components/nmwc/Sidebar.tsx:91,120-121`; English-only `app/layout.tsx:24`; export shown to roles that 403 | No approver mobile nav; i18n; a11y | Drawer nav; next-intl; axe check |
| Integration Readiness | 3 | 15 | 0.5 | `lib/temix.ts:4-9` "NO live API"; headers unconfirmed `:74-77`; batch not reproducible `services/temix.ts:222-244`; no API/webhooks | ERP contract open; no machine interface | Freeze headers; persist batch; minimal API |
| Maintainability | 3 | 52 | 1.6 | Strict TS, zero TODO markers; 1.5–1.7k-line services; PII regex ×3; 7 unimported deps; `README.md:5` "Milestone 0" | Duplication, dead code, stale docs | Dedupe; prune; doc refresh |
| Supportability & Ops | 4 | 30 | 1.2 | `docs/OPERATIONS.md:70` contradicts `package.json:8`; 4-symptom playbook `:170-191`; "tell me" support `docs/LAUNCH-CHECKLIST.md:110,126,130` | Stale runbook; no severity/on-call; rotation trap | Rewrite OPERATIONS.md; severity matrix; secrets inventory |
| **Total** | **100** | | **40.9** | | | |

---

## 4. Architecture Assessment

**Shape.** Single-tenant Next.js 15.5.18 App Router monolith: `app/` (routes, 11 API handlers, actions) → `services/` (14 `'use server'` modules) → `lib/`. The direction rule holds (no `lib/` file imports `services/`; no service imports another — `services/edits.ts:3-33`, `services/imports.ts:3-29`). All exported actions pass through `runAction()` (`lib/errors.ts:112-151`), which returns typed `{ok:false, code, message, fields?}` for `AppError`s and re-throws programmer errors. The Edge/Node split is clean (`auth.config.ts:4-6` keeps Prisma/bcrypt out of middleware); `middleware.ts:37-47` issues a per-request CSP nonce with `'strict-dynamic'`. Approval chains are versioned config-in-code snapshotted per request (`lib/approval-chains.ts:4-9,26,122-127`; `services/edits.ts:490-505`).

**Liabilities.**
1. **God functions in the riskiest code** — `promoteCustomerBatchCore` ~783 lines (`services/imports.ts:964-1746`), `approveEditCore` ~505 (`services/edits.ts:770-1274`), `submitEditCore` ~405 (`:220-624`). Unit tests cover `lib/` only, so these run only under env-gated integration suites.
2. **No read-model layer** — 22/24 `app/(app)` pages import `@/lib/db`; 90 prisma call sites in `app/` (`dashboard/page.tsx` 13). Scope predicates are re-derived per page; one omission is a data-scope leak.
3. **Systematic duplication** — ten per-service `require*()` copies (`services/creates.ts:61` … `customer-export.ts:36`) while `lib/session.ts:10-26` is dead; export gate triplicated (`lib/export-scope.ts:20-27` vs `services/exports.ts:10-22` vs `services/customer-export.ts:36-48`) despite `lib/export-scope.ts:3-4`; PII regex ×3 (`lib/logger.ts:27-28`, `sentry.client.config.ts:3-4`, `sentry.server.config.ts:11-12`); AUTH_URL delete ×2 (`auth.config.ts:17-20`, `lib/auth.ts:48-51`).
4. **No configuration module** — 29 `process.env` names read at call sites; only `AUTH_SECRET` validated at boot (`lib/auth.ts:17-32`); R2 fails lazily (`lib/r2.ts:10-12`); `SALESMAN_SUBMIT_GATE` and `PROMOTE_SLICE_BUDGET_MS` absent from `.env.example`.
5. **Blurred `lib/` boundary** — `lib/create-finalize.ts:1-4` runs 11 tx writes inside `approveEditCore`; `lib/audit.ts:18`, `lib/auth.ts:5` import `next/headers`; `lib/reference-data.ts:30` imports `next/cache`.
6. **Framework pillars** — `next` 15.5.18 and `next-auth` 5.0.0-beta.31 with a caret on a beta (`package.json:45-46`); `@auth/prisma-adapter` is a direct dependency with zero imports.

**Verdict.** A sound modular monolith with the right primitives. It needs a read-model layer, function decomposition and helper consolidation before a second engineer can work in it safely — not re-platforming.

---

## 5. Security Assessment

**Strong.** Fail-closed object scope with 404 masking (`lib/access.ts:12-14,95,129,139`); step-level SoD (`lib/permissions.ts:176-181`; `services/edits.ts:831-843`); login limited on both action and `authorize()` paths (`app/actions/auth.ts:38-62`; `lib/auth.ts:297-320`) with dummy-bcrypt timing equalisation (`lib/auth.ts:39-40,342-343`); server-side JWT revocation via `sessionsRevokedAt` (`lib/auth.ts:241-253`; `services/users.ts:251,305,434,498`); nonce CSP plus HSTS preload, COOP/CORP, `X-Frame-Options DENY` (`next.config.ts:17-38`); uploads bound to the caller and re-validated at finalize (`app/api/photos/presign/route.ts:13-24,55-70`; `finalize/route.ts:17-40,84-128`); all runtime raw SQL parameterised (`lib/rate-limit.ts:97-127`; the sole `$queryRawUnsafe` at `lib/customer-count.ts:61-63` is a constant); all 30 exported actions and 11 route handlers gate on auth.

**Weaknesses.**

| ID | Finding | Evidence | Status |
|---|---|---|---|
| SEC-02 (P1) | Region-scoped MANAGER can create an org-wide VIEWER (read, export, CR/GUARANTEE docs) and assign a SALESMAN to any route | `lib/permissions.ts:223-227`; `services/users.ts:113-117,155-163,413-427`; `lib/access.ts:73-79,117-121,193`; `lib/export-scope.ts:18`; tests pin the behaviour `tests/unit/user-admin-authz.test.ts:21,37-41,57-59` | CONFIRMED |
| SEC-06 (P1) | Production runs `origin/main` whose Postgres limiter always grants | `git show origin/main:lib/rate-limit.ts` :88-104; live 404 on `/api/cron/sla-escalate`; region `fra1` | CONFIRMED (live) |
| SEC-01 (P2) | Middleware gate inert: boolean `false` from `authorized` is ignored when a user middleware fn is supplied; QA register refuted C1 on the wrong premise | `auth.config.ts:87`; `middleware.ts:57-75`; `node_modules/next-auth/lib/index.js:136-156`; `qa/findings/register.md:74`; regression in `2c112a1`, repeated in `d9b4658` | CONFIRMED |
| SEC-03 (P2) | STEWARD unconstrained: any role incl. peer STEWARD/MANAGER; admin-known plaintext resets; import resets anyone. Mitigating: Steward already sets CREDIT terms via import without approval (`services/imports.ts:1451-1463`), so the chain is not the control against this role | `lib/permissions.ts:235-239,246-266`; `services/users.ts:279,303-306`; `services/imports.ts:395-413` | PARTIALLY_CONFIRMED |
| SEC-05 (P2) | `npm audit --omit=dev`: 4 critical/10 high; only GHSA-m99w-x7hq-7vfj (Server-Action DoS) applies on Vercel/Linux; no audit in CI | `package.json:45-46`; `ci.yml:18-21` | PARTIALLY_CONFIRMED |
| SEC-11 (P2) | Shared `'12345'` seed with route-code usernames; import accepts 4-char passwords; credentials doc in git history | `scripts/golive/build-masters.ts:73`; `docs/GO-LIVE-RUNBOOK.md:68-75`; `services/imports.ts:267-273` vs `services/users.ts:45`; `git log --all -- docs/PILOT-MUSCAT-CREDENTIALS.md` → 3 commits | PLAUSIBLE |
| SEC-08 (P2) | Per-username bucket debits before password check → unauthenticated lockout DoS; also inserts a RateLimit row per attacker-chosen username before the IP check | `lib/auth.ts:301-320`; `app/actions/auth.ts:47,55`; `lib/rate-limit.ts:136` | PLAUSIBLE |
| SEC-14 (P3) | `===` bearer compare; CSP lacks `base-uri`/`form-action`; `__Secure-` not `__Host-`; edge Sentry unscrubbed; uploads not content-sniffed | `app/api/health/route.ts:33`; `middleware.ts:37-47`; `auth.config.ts:38-47`; `sentry.edge.config.ts:3-8`; `finalize/route.ts:107-125` | PLAUSIBLE |

**Identity.** No MFA, SSO, SCIM or self-service recovery (`components/nmwc/LoginForm.tsx:71-75`). Workable at 60 users; at 5,000 it is 5,000 admin-issued passwords with no central deprovisioning.

---

## 6. Scalability & Reliability Assessment

**At go-live scale (≈60 users, 18,172 customers / 20,129 branches — `docs/SESSION-MASTER-RECORD.md:130`) the system is adequate.** Search is index-backed (trgm GIN + partial btree, `senior_audit_remediation:130-147`; `perf_btree_legalname:17-19`) with an O(1) `reltuples` count (`lib/customer-count.ts:51-77`); import promote is time-boxed and lease-protected and was rehearsed at 20,129 rows with zero failures.

**Not built for growth** — six surfaces do O(table) or O(scope) work per request:

| Surface | Mechanism | Evidence | Breaks at |
|---|---|---|---|
| `/duplicates` | Loads every live customer plus dismissal audit rows; groups in JS | `services/duplicates.ts:79-104,133-167` | ~100k customers (project's own threshold was "before 10k", `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md:210`) |
| `/audit` (Manager) | Every in-scope customer+branch id into `IN` lists; Steward path has no `at` index | `app/(app)/audit/page.tsx:60-96`; `prisma/schema.prisma:615-617` | A region 2–3× today's largest — Prisma may throw on the un-splittable `OR`+`orderBy` |
| `/dashboard` | Unbounded 30-day findMany; two unscoped Branch groupBys; `revalidate=30` inert (auth() → `headers()` → `DynamicServerError`) | `dashboard/page.tsx:14,17,94-123` | ~100k approvals/month for global roles |
| Field-update report | `since` defaults to epoch when omitted; org-wide extras scan; 4-sheet exceljs in memory | `lib/change-report.ts:185,250-283,473-681`; `changes/route.ts:69` | Any direct GET without `since` |
| Exports | Synchronous 25k-row `findMany`+`include`; ExportJob dead | `services/exports.ts:109,120-133,171-172` | Cap is 80% of today's master; 4.5 MB response limit **Not Verified** for the styled report |
| Login | 6 serialised writes + bcrypt 12; no pool sizing | `app/actions/auth.ts:47,55,85`; `lib/auth.ts:303-304,343,355-367`; `lib/db.ts:7-21` | Per-instance pool starvation (P2024) at a few hundred concurrent logins |

Also: Branch `ILIKE` with no trigram index (`lib/customer-filters.ts:190-201`); offset pagination; reference cache assumes ≤80 users and `ref:users` is never invalidated on user mutations (`lib/reference-data.ts:25-28`); Notification GC 500/run with unread rows never eligible (`sla-escalate/route.ts:40-41,281-290`); photo GC 200 serial R2 calls/day (`photo-gc/route.ts:22-23`).

**Reliability.** Concurrency correctness is strong (atomic claims; sorted `FOR UPDATE` on merge `services/duplicates.ts:271-273`; advisory locks `lib/create-guards.ts:36-56`; tx timeouts tuned from a real WAN failure `lib/db.ts:11-19`). The gaps are operational:

- **Recovery** — drill run `25630332801` (2026-05-10) failed at "Create Neon branch"; `a05cb5e` gated it behind `NEON_DRILL_ENABLED` three minutes later; secrets still absent; no RTO/RPO; `docs/GO-LIVE-RUNBOOK.md:86` rollback has no steps; dumps plaintext.
- **Degradation** — `app/(app)/layout.tsx:13-15` awaits a DB count before render with no try/catch; only `app/error.tsx` exists; no maintenance switch (grep → 0).
- **Dependency timeouts** — `lib/r2.ts:13-50` sets no `requestHandler`; smithy legacy defaults supply none; `finalize/route.ts:100-105` maps every HeadObject error to a non-retryable 404 (retained blob allows manual retry, `PhotoCaptureSlot.tsx:443-458`).
- **Transient errors** — classified only in `services/imports.ts:947-956`; `lib/errors.ts:139-149` special-cases only P2002.
- **Scheduling** — `sla-escalate.yml` not on the default branch (GitHub runs schedules there only); keep-warm never exceeded ~27 runs/day, 2–4/day since 08-27 (867 runs over ~125 days); the 60-day auto-disable cited in `qa/reports/LAUNCH-CHECKLIST.md:39-43` applies to public repos only.
- **Bulk approve** — 50 sequential approvals, no try/catch or budget (`services/edits.ts:1293-1307`); one thrown error discards accumulated successes.

**Not Verified:** Neon compute size / `max_connections` / PITR window; production `DATABASE_URL` params; Vercel plan and Fluid compute; R2 lifecycle rules.

---

## 7. Data & Governance Assessment

**Schema rigor is the system's strongest area.** Partial uniques for one open edit per customer/branch (`20260509150000_qa_remediation/migration.sql:12-14`; `phase1_tables:229-231`); a plpgsql trigger enforcing `Branch.regionId == Route.regionId` (`senior_audit_remediation:154-173`); 11 CHECKs on GPS, address, credit (`:179-222`; `phase1_tables:237-271`); `Decimal(14,3)` money (`prisma/schema.prisma:316,441`); optimistic `version` bumped by every writer (`services/edits.ts:658-707`; `services/imports.ts:1402,1446`; `services/duplicates.ts:351`). Migrations are forward-only, never rewritten, with one owner-approved `DROP INDEX` (`p1_drop_phone_unique:15`). Core entities are soft-deleted only.

**Governance is weaker.**
1. **AuditLog mutable by the app credential** (DG-01, CONFIRMED) — no `REVOKE/GRANT/TRIGGER/POLICY` on AuditLog in any migration; app connects as `neondb_owner`, whose password "was pasted in chat" (`docs/GO-LIVE-RUNBOOK.md:21`); `scripts/wipe-synthetic-data.ts:39-41,152` runs an unguarded owner-credential `deleteMany` written for production; `docs/TECH-SPEC.md:776` and `docs/BUILD-REPORT.md:345` tick immutability.
2. **Migration-only objects invisible to Prisma** (DG-10) — trgm, partial uniques, trigger, CHECKs exist only in raw SQL; `qa/evidence/00-isolation-gate.json:15` records `prisma db push` dropping them; no `migrate diff` in CI; migrations run inside every Vercel build (`package.json:8`) while `docs/OPERATIONS.md:70` says otherwise; `phase1_tables:10-134` unguarded DDL.
3. **Missing FKs** — `Attachment.customerId/branchId` (`schema:478-479`), `createdById/lastEditedById`, `importBatchId`, `lastTemixUploadBatchId`, `Notification.customerId`.
4. **Audit completeness** — 26 direct `auditLog.create` writers bypass `lib/audit.ts` (e.g. `services/edits.ts:536-545`); four writes are `.catch(() => undefined)` (`services/exports.ts:186`, `customer-export.ts:235`, `changes/route.ts:88`, `imports.ts:558`); import update lanes write no before/after (`services/imports.ts:1381-1404,1424-1447,1505-1518`); `managedRegions` unaudited (`:507-510`); `importRowId` never populated; `PHOTO_VIEW` declared (`schema:94`) never written; GC deletes unaudited; SLA rows attributed to the submitter (`sla-escalate/route.ts:160-177`); exports logged as `IMPORT` (`services/exports.ts:180`; `customer-export.ts:229`).
5. **Retention** (DG-03) — none for AuditLog, `ImportRow.raw` (verbatim customer rows, `services/imports.ts:872-879`), RateLimit (raw IPs — `clientIpHash()` at `lib/auth.ts:118-127` does not hash), TemixSyncBatch.
6. **Erasure** (DG-04, CONFIRMED) — archive and merge never soft-delete attachments (grep `attachment` in `services/customers.ts`, `services/duplicates.ts` → 0); `lib/access.ts:193` returns for STEWARD/VIEWER before the `deletedAt` check at `:252-258`, so archived customers' CR/GUARANTEE documents stay servable via `app/api/photos/[id]/route.ts:44-100` and outside photo-gc (`:31-35`); `prisma/schema.prisma:481-482` falsely claims abandoned-draft photos are swept.
7. **Residency & compliance** (DG-05, CONFIRMED) — Neon `us-east-1`, Vercel `iad1`, dumps through `ubuntu-latest` (`db-backup.yml:29,114-133`), R2 location unrecorded, Sentry non-EU URL (`docs/OPERATIONS.md:20`); region chosen twice on latency (`git log vercel.json`; `docs/SESSION-MASTER-RECORD.md:81`); no PDPL assessment, PII inventory, retention schedule or data-subject procedure (`docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md:439`; `x-gaps.md:69,92`). Whether Oman RD 6/2022 binds this dataset: **Not Verified** — the repo shows it was never asked.

---

## 8. DevOps / Observability Assessment

**CI/CD.** `ci.yml:3-7` triggers on push/PR to `main` only; `:18-21` runs typecheck, lint, `npm test` with no env or services; `:30-38` gitleaks. No PR has ever been opened (`gh pr list --state all` → `[]`); no tags (`git tag` → empty vs `docs/TECH-SPEC.md:761`); branch protection returns 403 (GitHub Free). The 74 go-live commits have zero CI runs. The only enforced gate is Vercel's build (`package.json:8`) — compile, type-check, lint and `migrate deploy`, no tests; the branch built 27 Preview deployments successfully. The merge is a fast-forward (`origin/main` is an ancestor), so residual risk is environmental: production env vars, region `fra1→iad1`, and a pending-migration discrepancy (git shows 4 branch-only migration dirs; runbook `:26` says one) to reconcile against production `_prisma_migrations`.

**Scheduling.** Vercel Hobby allows one daily cron (`vercel.json:12-17`); sub-daily jobs ride GitHub Actions, evaluated only on the default branch and delivered at a fraction of cadence. No heartbeat, no `if: failure()`, no notification; `keep-warm.yml:43-46` exits green when the secret is missing.

**Observability.** Server Sentry is wired (`instrumentation.ts:3-22`) with good scrubbing (`sentry.server.config.ts:22-63`). Client Sentry is dead code: no `withSentryConfig` (`next.config.ts:71`), no `instrumentation-client.ts`; `.next/static/chunks/app/error.js` has 0 Sentry references and ships `pino/browser.js`; `app/error.tsx:27` "Our team has been notified" is true only for server errors and only if `NEXT_PUBLIC_SENTRY_DSN` is set (**Not Verified**). `environment: NODE_ENV` in all three configs; no `release`; edge config unscrubbed. No request id (grep `requestId|x-vercel-id|logger.child` → 0), log drain, metrics, SLO or alert rules (**Not Verified** in Sentry UI). `/api/health` returns 200 `{status:'ok'}` to anonymous callers (`:35-37`); the bearer mode has no consumer; unconfigured R2 counts as healthy (`:53-63`).

**Infrastructure & docs.** No IaC; `docs/OPERATIONS.md:72-107` manual checklist; `db-backup.yml:10-13` retention TODO; `.vercel/project.json` tracked; CI Node 20 vs runbook Node 24 (`ci.yml:16`; `docs/OPERATIONS.md:242`), no `engines`; no maintenance mode or flags. Rotating `neondb_owner` without updating the GitHub `DIRECT_URL` secret (2026-05-10) breaks the nightly backup silently. `docs/OPERATIONS.md` (last touched 2026-07-15) contradicts the code on migrations (`:70`), Neon plan (`:112` vs `:177`) and documents a deleted credentials file (`:195-216`); `README.md:5` says "Milestone 0"; `.env.example:26-28` claims a missing `CRON_SECRET` leaves crons open while `lib/cron-auth.ts:22-23` fails closed.

---

## 9. Enterprise UX & Administration Assessment

**Administration.** One allowlist governs who administers whom, enforced server-side and mirrored in the UI (`lib/permissions.ts:223-266`; `services/users.ts:113-117`; `CreateUserForm.tsx:33`); last-active-Manager guard (`services/users.ts:233-242,389-398`); every user-admin mutation audited with envelope. But `updateUserRoleAction` (`services/users.ts:345`) has no UI caller; `managedRegions` is written only by the Steward Excel import (`services/imports.ts:507-510`); `UserRowActions.tsx:59-96` offers Disable/Enable/Reset only; `/users` is unbounded with no search; Channel/SubChannel have no in-app writer (only `prisma/seed.ts:74-81`); routes admin is create+toggle, unscoped for Managers (`services/routes.ts:17-24,80-127`); SLA budgets and the submit gate are env-only (`lib/working-hours.ts:36-42`; `lib/submit-gate.ts:21-23`); no settings model. Lost-device revocation *is* covered: logout/disable/reset bump `sessionsRevokedAt` for all devices (`app/actions/auth.ts:92-103`).

**Field and approver UX.** Salesman mobile is solid (tab bar; compressed upload with progress, backoff and retained-blob retry, `PhotoCaptureSlot.tsx:82-160,443-458`; localStorage drafts `EnrichmentForm.tsx:207-266`). Approver mobile is not: sidebar `hidden … md:block`, `MobileTabBar` null for non-SALESMAN (`Sidebar.tsx:91,120-121`, "hamburger TBD" since 2026-05-09; `docs/UX-SPEC.md:59-75` specified a drawer). A working but hidden path exists via bell → deep link → `/approvals/{id}`. ACCOUNTANT/FM/GM land on `/customers` "for now" (`lib/role-home.ts:14-18`) though `approvals/page.tsx:28-57` already serves them; the Manager dashboard has zero `href`s.

**Lists, bulk, exports.** Approvals `take: 200` with header `items.length` (`approvals/page.tsx:121,162`); "Select all" picks 200 while the server caps 50 with "Validation failed" (`BulkApprovalQueue.tsx:70-78,96-97`; `services/edits.ts:1293`); notifications capped at 100; export controls shown to ACCOUNTANT/FM/GM who get a raw JSON 403 (`export/page.tsx:13`; `customers/page.tsx:129` vs `lib/export-scope.ts:18`).

**Accessibility, i18n, offline.** PRD targets WCAG 2.1 AA and i18n-readiness (`docs/PRD-v0.1.md:524,528`): unassociated labels (`CreateUserForm.tsx:160-170`; `routes/forms.tsx:166-172`), five `window.confirm/alert` sites, `RejectModal` without dialog semantics (`BulkApprovalQueue.tsx:320-327`) beside a correct `ConfirmModal`, no axe test; `app/layout.tsx:24 lang="en"`, no i18n dependency, 18 hard-coded `en-GB` formats. Offline promised in `docs/PRD-v0.1.md:50,272-277` is not implemented (no service worker; `public/` empty) — an owner descope (`docs/BUILD-REPORT.md:26`) the PRD never reflected.

**Integration.** Excel round-trip to Temix; header contract unconfirmed (`lib/temix.ts:74-77`); re-download regenerates from current data (`services/temix.ts:222-244`); inbound ack only via re-import (`services/imports.ts:1364-1411`); no API, webhooks, API keys, or email channel (`lib/notifications.ts:1-4`).

---

## 10. Market Benchmark

**Salesforce Sales Cloud + Consumer Goods Cloud (Shield, Maps).** *Why:* the reference for configurable CRM admin (permission sets, sharing rules, field-level security), data-driven approvals with Approval Trace, field audit (Field History 18 months; Shield Field Audit Trail 10 years), an offline-first FMCG retail-execution app with Sync Management, mandatory MFA, SCIM, and Hyperforce UAE residency. *Versus NMWC:* matches on snapshotted chains and step-level SoD; lacks dynamic approver rules, FLS, field-history UI, offline app, SSO/MFA/SCIM. Sources: help.salesforce.com (CG offline app; `identity_scim_overview`; `field_audit_trail`); salesforce.com/platform/shield; salesforce.com/eu/products/hyperforce-uae.

**Microsoft Dynamics 365 Sales + Field Service on Dataverse.** *Why:* the most transparently documented security model (business units, role depth, column security with masking), auditing with retention defaulting to Forever, published limits (6,000 req/5 min/user, 429 + Retry-After), a 99.9% financially backed SLA, offline profiles with a Sync Error table and explicit conflict policy, UAE region `crm15`. *Versus NMWC:* region/route scoping approximates one dimension of BU depth; no column security, audit retention, published limits, offline profile or SLA. Sources: learn.microsoft.com `wp-security-cds`, `field-level-security`, `manage-dataverse-auditing`, `api-limits`, `set-up-offline-profile`, `resolve-sync-conflicts`, `new-datacenter-regions`; Microsoft Online Services SLA.

**Repsly.** *Why:* right-sized mid-market retail execution — territory permissions, forms, photos, GPS check-in, offline sync, REST API with 50-row pages and import-job status; its missing public SSO/SOC 2/SLA calibrate what a vendor this size gets away with. *Versus NMWC:* comparable photo/GPS/route capture; Repsly exceeds on offline and API. Sources: repsly-dev.readme.io; knowledge.repsly.com API section; repsly.com/product.

**Pepperi (Advantive).** *Why:* the closest route-to-market analogue for a water distributor — offline rep/van-sales app, configurable order approvals, OAuth 2.0 REST API, iPaaS with 50+ ERP connectors, ISO 27001 + ISAE 3402. *Versus NMWC:* no ERP connector surface, no security attestation. Sources: pepperi.com/security, /ipaas, /integrations; support.pepperi.com Pepperi API.

**Profisee MDM.** *Why:* the upper bound for governed customer-master management — match/merge, survivorship, steward workflow with escalation, full audit trail, SOC 2 Type II, ISO 27001:2022, OIDC + MFA, quarterly pen tests, 365-day SIEM retention, 99.8% uptime. *Versus NMWC:* exact-match dedupe and Steward merge are a fraction; the point is to stop consciously short. Sources: profisee.com/security, /platform/golden-record-management, /platform/workflow, /platform/integration.

**Fundamentals — status here.** IdP SSO + MFA ❌; additive RBAC with row scoping ✅; field-level security ❌; immutable per-field history with retention ⚠️ (imports bypass; AuditLog mutable); approval state machine as data with trace ✅; duplicate prevention + merge ⚠️ (exact, in-memory); offline-first mobile ❌; versioned REST API with OAuth/429 ❌; defined ERP contract with logs/alerts ❌; environment separation ✅; tested restore with RPO/RTO ❌; residency statement ❌; server-side validation on all channels ✅; operational monitoring ❌.

**Best practices — status.** IdP-group→role ❌; audit export to SIEM ❌; dynamic approvers with reminders/escalation ⚠️ (code exists, undeployed); per-role offline profiles ❌; visible sync-error queue ❌; fuzzy matching + steward queue ❌; survivorship by source ❌; event-driven integration ❌; published rate limits ⚠️; admin-editable metadata ❌; published security posture/pen test ❌; admin observability views ⚠️; privacy lifecycle/erasure ❌; visit-centric cockpit ✅ (`/today`).

**Differentiators (not required here).** Retail-execution data model; territory/route optimization; AI copilots and image recognition; Shield-class event monitoring with BYOK; lakehouse-native golden records; unified B2B commerce; POS ingestion; matrix business units; financially backed SLA.

**Overengineering for a 60-user single company.** Multidomain MDM engine; multi-tenant isolation; own SCIM endpoint; Shield-class streaming/BYOK; drag-and-drop workflow designer; license-metered API entitlements; build-your-own-object platform; multiple FetchXML offline profiles; plugin marketplace/iPaaS; 10-year audit big object; multi-currency engines; AI/route optimization as go-live requirements; per-record column unmasking; 99.9% SLA credit mechanics.

---

## 11. Missing Enterprise Capabilities

| Capability | Expected in enterprise software because | Status here | Priority |
|---|---|---|---|
| SSO (OIDC/SAML) + MFA | Every benchmark mandates it; phished route-code passwords give full access | Absent (`lib/auth.ts:284-286`) | P1 @5k / P2 @60 |
| Tested restore with RPO/RTO | An unrestored backup is a hypothesis | Drill failed once, gated off (`db-backup.yml:154`) | P1 |
| Enforced CI gate with DB-backed tests | Concurrency/authz regressions otherwise reach prod | Main-only CI; 70 integration cases gated | P1 |
| DB-level audit immutability + least-privilege role | Auditors reject self-attested immutability | No GRANT/TRIGGER; app = owner | P1 |
| Residency & processor register; PDPL assessment | Regulators and due diligence start here | Absent; region chosen on latency | P1 (decision) |
| Reliable sub-daily scheduling + dead-man alert | Escalation, SLA, GC depend on it | GitHub cron ~2–15% cadence; route not deployed | P1 |
| Region-scoped delegated admin | Prevents lateral escalation | Manager can mint org-wide VIEWER | P1 |
| Client error capture, releases, alerts, uptime monitor | MTTD otherwise = first complaint | Client Sentry dead; no monitor | P2 |
| Audit envelope on all actions; non-swallowed writes | Device/network attribution | 26 bypassing; 4 best-effort | P2 |
| Retention schedule + sweeps | Data minimisation; bounded backups | None for AuditLog/ImportRow/RateLimit | P2 |
| Erasure reaching R2 documents | Customer/data-subject removal | Archive/merge leave CR docs live | P2 |
| Field-level security on credit/contact | Sensitive attributes per role in API/exports | Role-level only; import sets credit unapproved | P2 |
| Admin UI for role/region/settings | Operate without redeploy or spreadsheet | Import-and-redeploy driven | P2 |
| Maintenance mode / kill switches | Freeze writes during restore | Absent | P2 |
| Documented ERP contract; reproducible batches; API/webhooks | Finance system of record | Excel round-trip, headers unconfirmed | P2 |
| Mobile navigation for approvers | Approvers act from phones | Sidebar hidden `<md` | P2 |
| Encrypted backups; photo backup | Second copy must be as protected as the first | Plain gzip; photos single-copy | P2 |
| Load test with budgets | Capacity evidence | One 10-VU run, May 2026 | P2 |
| Offline-first capture | Field reps on patchy networks | Text drafts only (owner descope) | P3 |
| i18n/Arabic; WCAG AA with checks | Workforce language; procurement clauses | English-only; a11y gaps | P3 |

---

## 12. Enterprise Blockers (ranked)

**P0 — none confirmed.** B1 becomes P0 if accounts are bootstrapped with `'12345'` before the merge.

### P1

**B1 — Production runs a 4-month-old `main` whose brute-force limiter never denies; the go-live branch has never passed CI** (SEC-06/DO-01 — **CONFIRMED**, live)
- *Evidence:* `git rev-list --count origin/main..HEAD` = 74; `git show origin/main:lib/rate-limit.ts` :88-104 (`granted` always true); live probe 404 on `/api/cron/sla-escalate`, region `fra1`; `ci.yml:3-7`; `gh pr list` → `[]`.
- *Why it matters:* the audited system is not the deployed one.
- *Business impact:* unlimited credential guessing against real customer data until merge; SLA engine, chunked promote, AUTH_URL fix and migrations absent from production.
- *Technical impact:* the first CI run will coincide with, not precede, the production deploy; the branch-added gitleaks job runs for the first time on that push.
- *Solution:* open a PR; widen `ci.yml` to all branches; run the Postgres-gated limiter test once manually (CI cannot — `rate-limit-pg.test.ts:21`); reconcile pending migrations against production `_prisma_migrations`; fast-forward merge; tag `v1.1.0-golive`; verify `curl /api/cron/sla-escalate` → 401 and region `iad1`; expect lockout by the ~4th bad login (double debit at `app/actions/auth.ts:47` + `lib/auth.ts:303`).
- *Complexity:* Low (0.5 eng-week).

**B2 — Regional MANAGER can mint an org-wide VIEWER and assign salesmen to any route** (SEC-02 — **CONFIRMED**)
- *Evidence:* `lib/permissions.ts:223-227`; `services/users.ts:113-117,155-163,413-427`; `lib/access.ts:73-79,117-121,193`; `lib/export-scope.ts:18`; 11 region-scoped managers, 0 VIEWERs at go-live (`docs/GO-LIVE-RUNBOOK.md:23`).
- *Why it matters:* the fail-closed scope model is bypassable in two clicks by the role it constrains.
- *Business impact:* any manager can export the 18k-customer master with phones, CR numbers, GPS and credit terms and read confidential documents nationwide — attributable afterwards, unmonitored now.
- *Technical impact:* horizontal + vertical escalation; tests pin the vulnerable behaviour (`tests/unit/user-admin-authz.test.ts:21,37-41,57-59`).
- *Solution:* remove VIEWER from `MANAGER_ADMINISTRABLE_ROLES` (or region-scope VIEWER); in `createUserCore`/`updateUserRoleCore` require route and supervisor ∈ `loadScope(me.id).managedRegionIds`, fail closed; filter the route dropdown (`users/page.tsx:45-49`); flip the three assertions; alert on LOGIN within 15 min of a CREATE/reset by another actor.
- *Complexity:* Low (0.5 eng-week).

**B3 — Restore has never succeeded; RTO/RPO undefined; dumps are plaintext PII** (REL-01/DO-06 — **CONFIRMED**)
- *Evidence:* drill run `25630332801` failed at "Create Neon branch"; `a05cb5e` added the `vars.NEON_DRILL_ENABLED` gate three minutes later; `gh secret list` lacks `NEON_API_KEY`/`NEON_PROJECT_ID`; 131 subsequent runs show "Restore drill | skipped"; grep `RTO|RPO` → only `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md:151,431`; `db-backup.yml:114-134` no encryption, `:10-13` retention TODO.
- *Why it matters:* the runbook's only data rollback (`GO-LIVE-RUNBOOK.md:27,86`) is unrehearsed and undocumented.
- *Business impact:* after a corrupting import or bad migration nobody can state data loss or downtime.
- *Technical impact:* rotating `neondb_owner` without updating the GitHub `DIRECT_URL` secret silently breaks the nightly backup.
- *Solution:* add the NEON secrets; widen `db-backup.yml:154` to `|| schedule`; run and time the drill; write three restore paths (PITR, pre-load branch, R2 dump) each ending with the Vercel env swap and a `sessionsRevokedAt` bump; assert Customer/Branch/User counts in the smoke; encrypt with `age`; enforce the lifecycle rule from the workflow; rotate `neondb_owner` and `DIRECT_URL` together.
- *Complexity:* Low (1 eng-week).

**B4 — AuditLog immutability is convention-only; app runs as DB owner; governance docs assert a control that does not exist** (DG-01 — **CONFIRMED**)
- *Evidence:* grep `REVOKE|GRANT|CREATE TRIGGER|POLICY` across migrations → only the two branch-region triggers; `prisma/schema.prisma:599` comment only; `docs/GO-LIVE-RUNBOOK.md:21` credential exposed; `docs/TECH-SPEC.md:776`, `docs/BUILD-REPORT.md:345`; `scripts/wipe-synthetic-data.ts:39-41,152`.
- *Why it matters:* the sole forensic record of credit approvals can be erased by the credential most likely to leak.
- *Business impact:* control-attestation failure; internal fraud could be self-erased.
- *Technical impact:* DDL, DML and audit DML share one role; a trigger alone does not bind the owner.
- *Solution:* create `nmwc_app` (no UPDATE/DELETE/TRUNCATE on AuditLog/EditApproval, no DDL) for `DATABASE_URL`; keep owner for `migrate deploy` moved into a CI release step; add a `BEFORE UPDATE OR DELETE` trigger as accident protection (switch cleanup scripts/tests to TRUNCATE or a bypass role); un-tick TECH-SPEC/BUILD-REPORT; add the host guard to the five unguarded integration files. Neon's ability to `CREATE ROLE` on the pooled endpoint is **Not Verified** — confirm first.
- *Complexity:* Medium (1.5 eng-weeks).

**B5 — Sub-daily scheduling is not delivered; SLA escalation has never run in production; no dead-man alarm** (DO-03/REL-03 — **CONFIRMED**)
- *Evidence:* `gh api …/actions/workflows` → CI, DB Backup, Keep production warm only; keep-warm `*/4 3-14` (`keep-warm.yml:21`) at 2–4 runs/day since 08-27; `vercel.json:12-17` photo-gc only; no heartbeat; `qa/reports/OWNER-DECISIONS.md:9` D3 open.
- *Why it matters:* SLA-breach pings, Temix-ready pings, notification GC and cold-start masking exist in code but not in operation, silently.
- *Business impact:* stalled credit approvals never escalate; every idle salesman pays a cold start.
- *Technical impact:* GitHub evaluates schedules on the default branch only; throttling root cause **Not Verified**.
- *Solution:* merge (prerequisite); decide D3 — Vercel Pro crons or an external scheduler with the bearer; `CronHeartbeat` row per sweep surfaced by bearer `/api/health`; `keep-warm` returns 503 when `dbOk` is false; correct `LAUNCH-CHECKLIST.md:39-43`.
- *Complexity:* Low (0.5 eng-week + plan decision).

**B6 — No data-residency decision or data-protection assessment for Omani PII processed in the US** (DG-05 — **CONFIRMED** as governance gap)
- *Evidence:* `docs/OPERATIONS.md:18`; `vercel.json:3`; `db-backup.yml:29-30,114-134,152-243`; R2 location unrecorded; grep `PDPL|residency|processor register` → 0; PII at `prisma/schema.prisma:290-300,361-362,182-186,489-492,609-610`.
- *Why it matters:* if in-country residency is required, post-go-live remediation is a full DB + object-store migration.
- *Business impact:* due-diligence and regulatory review begin with the register; its absence stalls them.
- *Technical impact:* region set independently in four places; edge Sentry unscrubbed.
- *Solution:* owner + legal sign a one-page Data Residency & Processor Register with an explicit decision; PDPL (RD 6/2022) applicability opinion; migrate before the region becomes permanent if required; mirror `beforeSend` into `sentry.edge.config.ts` now.
- *Complexity:* Low for the decision (0.2 eng-week + legal); High if migration is required.

### P2 (each Low–Medium)

| ID | Issue | Evidence | Solution |
|---|---|---|---|
| SEC-01 | Inert middleware gate + false QA record | `auth.config.ts:87`; `register.md:74` | `authorized` returns `Response`; negative tests; correct 6 docs |
| SEC-03/09, DG-09 | Steward super-user; import sets CREDIT unapproved; direct writes as plain UPDATE; no system actor | `lib/permissions.ts:235-239`; `services/imports.ts:1451-1463`; `services/edits.ts:516-547` | One-time credentials; two-person rule for approver tiers; `DIRECT_WRITE`/`PASSWORD_RESET`; SYSTEM user; gate credit fields |
| SEC-05 | Dependency posture | `package.json:45-46`; `ci.yml` | `next@15.5.25`, `next-auth@beta.32`, pin, uninstall unused, `npm audit` + dependabot |
| DG-06/07 | Envelope bypass; swallowed and mislabelled audit writes | 26 writers; `services/exports.ts:180,186` | `writeAudit` everywhere; fail on failure; fix labels; ESLint rule |
| DO-04/05/07 | No client Sentry, monitor, alerts, env/release tags | `next.config.ts:71`; `health/route.ts:35-37` | `instrumentation-client.ts`; `VERCEL_ENV`; external monitor; two alert rules |
| DO-02, UAT-03 | CI not a gate; coverage unmeasurable | `ci.yml:10-21`; no coverage-v8 | Postgres job; thresholds; Playwright login; fix `login.spec.ts:17` |
| DG-03/04, SCALE-04 | No retention; erasure incomplete | `services/imports.ts:872-879`; `lib/access.ts:193` | Retention sweep; soft-delete attachments on archive/merge/reject |
| SCALE-01/03/05/08 | Unbounded admin queries | §6 table | SQL dedupe + dismissal table; `@@index([at])`; scoped cached dashboard; Branch trgm |
| REL-02/04/05/06 | No maintenance mode; bulk-approve loses results; no S3 timeouts; no transient mapping | `layout.tsx:13-15`; `edits.ts:1293-1307`; `lib/r2.ts:13-50` | Edge `MAINTENANCE_MODE`; per-item try/catch + budget; `NodeHttpHandler` timeouts; `RETRYABLE` in `runAction` |
| UAT-01/02/06 | No role/region editor; no approver mobile nav; dead export buttons | `services/users.ts:345`; `Sidebar.tsx:91,120-121` | Wire editor; drawer nav; hide export from non-export roles |
| SEC-11 | Weak initial credentials | `build-masters.ts:73`; git history | Per-user random seeds; import min 12; `git filter-repo` |

### P3
Health `===` compare, CSP `base-uri`/`form-action`, `__Host-` cookie, content-sniffed uploads (SEC-14); stale docs/env contract (DO-16/17, UAT-17/18); a11y/i18n (UAT-07/08); segment loading/error boundaries (UAT-15); Temix batch persistence (DG-14); channel CRUD (DG-16); per-lambda caches (SCALE-17).

---

## 13. What Will Break First at Scale

1. **Today, hostile internet.** Per-username lockout DoS (`lib/auth.ts:301-320`; route-code usernames) and, until merged, an always-grant production limiter.
2. **Today, operational.** Sub-daily crons at a fraction of cadence; SLA route absent from production; a Neon or R2 hiccup blanks every page (REL-02/05).
3. **First busy Monday (~200 open approvals).** "Select all" > 50 → "Validation failed"; 50 sequential approvals lose per-item results on any thrown error (`services/edits.ts:1293-1307`).
4. **~100–300 concurrent logins.** Six serialised writes per login with no pool sizing → per-instance pool starvation and P2024 (`lib/db.ts:7-21`; already listed as expected at `services/imports.ts:953`). Not Neon-wide exhaustion — the transaction-mode pooler multiplexes autocommit statements.
5. **~2–3× today's largest region.** Manager audit `IN` lists cross Prisma's split threshold with an un-chunkable `OR`+`orderBy` → exception (`audit/page.tsx:60-96`).
6. **~100k customers.** `/duplicates` exceeds 60 s (`services/duplicates.ts:79-167`); dashboard unbounded findMany for global roles; field-update report without `since`.
7. **~25k branches (today 20,129).** Full export refused above `EXPORT_ROW_CAP` (`services/exports.ts:109-117`).
8. **~500k customers / 5M branches.** Branch `ILIKE` seq-scans per search; offset paging past ~200; Notification growth outruns the 12,000/day GC ceiling; photo GC at 200/day permanently behind.
9. **5,000 users regardless of customers.** Whole-user-list `<option>`s per render (`lib/reference-data.ts:25-28`); `/users` renders 5,000 rows; JWT freshness cache `clear()`s at 5,000 entries (`lib/auth.ts:114-116,225`); admin-issued passwords and manual leaver handling scale linearly.

---

## 14. Technical Debt That Must Be Addressed

| Debt | Evidence | Why it must be paid |
|---|---|---|
| Three god functions | `services/edits.ts:220-624,770-1274`; `services/imports.ts:964-1746` | Untestable in isolation; every security fix so far was found post hoc |
| Dispersed reads with per-page scope | 22/24 pages import `@/lib/db`; 90 call sites | One missed predicate = scope leak; blocks scalability fixes |
| Duplicated gates and dead modules | 10 `require*()`; `lib/session.ts`; export gate ×3; PII regex ×3; `lib/permissions.ts:16,31,52,56,90`; `lib/auth.ts:406` | A fix to one copy misses the others |
| Audit-writer bypass | 26 direct `auditLog.create`; no lint rule | Forensic columns dead on every business action |
| Unused/extraneous dependencies | `@auth/prisma-adapter`, `react-hook-form`, `@hookform/resolvers`, `class-variance-authority`, `pino-pretty`, testing-library ×2; `docx/sax/xml-js/xml` extraneous | Advisories for nothing; 60 audit findings |
| Migration-only schema objects; migrate-in-build | No counterpart in `schema.prisma`; `package.json:8`; `phase1_tables:10-134` | `db push` already dropped them; mid-file failure blocks all deploys |
| Dead schema | `ExportJob`, `importRowId`, `PHOTO_VIEW/DELETE/CLOSE/SESSION_REVOKE`, `TemixSyncBatch.r2Key` | Misleads auditors; masks unimplemented features |
| Config/env contract | 29 ad-hoc reads; `.env.example` missing knobs, wrong `CRON_SECRET` claim (`:26-28`) | Env mistakes surface as user failures |
| Documentation drift | `README.md:5`; CHANGELOGs end 2026-05-11; `docs/OPERATIONS.md:70,112,177,195-216,242`; `keep-warm/route.ts:11-12`; `TECH-SPEC.md:776,779`; `BUILD-REPORT.md:345,348`; `register.md:74` | Operators and auditors actively misled |
| Test hygiene | Prod guard missing in 5 integration + 9 prisma scripts; `loadtest.mjs:8-9` defaults to production with a demo password; `login.spec.ts:17` cannot pass; stale baselines | A script can write to production; CI tier flaky on cold start |
| Toolchain | Node 20 in CI vs 24 in runbook; no `engines`; vitest/vercel majors behind | CI/runtime behavioural drift |

---

## 15. Areas That Are Already Strong

- **Fail-closed authorization** — `lib/access.ts:67-100,110-140`, applied on read (`customers/[id]/page.tsx:56-71`) and write (`services/edits.ts:274-300`; `services/reactivations.ts:278-290`; `services/photos.ts:138-139,311-312`).
- **Separation of duty with frozen chains** — `lib/permissions.ts:166-208`; `lib/approval-chains.ts:4-9,122-127`; `EditApproval` append-only (grep `editApproval.update|delete` → 0); concurrent-approval integration test (`tests/integration/credit-chain-e2e.test.ts:121-181`).
- **Atomic claims on every transition** — `services/edits.ts:857-882,951-970,1164-1183,1502-1516`; `services/creates.ts:370-384`; `services/temix.ts:153-179,257-268`; `sla-escalate/route.ts:142-157`; `services/imports.ts:991-1009`. Retries are safe by construction.
- **Serverless-safe import** — slice budget below `maxDuration`, 90 s lease, token-guarded finalize, transient deferral, derived counters (`services/imports.ts:920-956,1604-1608,1644-1672,1725-1742`); three regression suites; 20,129-row rehearsal with 0 failures.
- **Login hardening** — durable single-statement bucket failing closed for auth keys (`lib/rate-limit.ts:45-49,100-126`); dual-path enforcement; timing equalisation; same-origin redirect allowlist (`lib/auth.ts:174-185`); real revocation.
- **Browser hardening** — nonce + `'strict-dynamic'`, strict static fallback, HSTS preload, COOP/CORP; no `dangerouslySetInnerHTML/eval` (grep → 0).
- **Upload pipeline** — user-prefixed keys, MIME/size/TTL at presign, prefix/kind/size re-check at finalize, scoped and rate-limited serving with `no-store` for confidential kinds.
- **DB-level invariants** — partial uniques, region trigger, 11 CHECKs, `Decimal(14,3)`, optimistic versions, advisory locks, `CodeSequence` upsert with self-heal (`lib/create-finalize.ts:69-102`).
- **Backups proven** — 126/126 scheduled successes to a separate bucket with separate credentials; `DIRECT_URL` validated without printing (`db-backup.yml:92-104`).
- **PII scrubbing** — pino redact + regex (`lib/logger.ts:3-31`); Sentry server `beforeSend` (`sentry.server.config.ts:22-63`); confidential documents never served from a public URL.
- **Secrets hygiene** — `.env` never committed (`git log --all -- .env` → empty); gitleaks on full history; `print-required-secrets.ts` prints names only; `AUTH_SECRET` entropy check; previews cannot inherit production `AUTH_URL`.
- **Cron endpoints** — constant-time fail-closed bearer (`lib/cron-auth.ts:11-25`); tag-before-delete GC; per-row transactions and advisory-lock debounce in the sweep.
- **Evidence-grade QA record** — three adversarial rounds, 78 confirmed findings, defect-linked tests (SEC-C3, PROD-DUP-01, RK-3, F-UAT-7, QA-021), isolation gate JSON, "no fabricated results" (`qa/reports/EXEC-RECORD.md:6`).
- **Salesman field UX** — compression, progress, retained-blob retry, stale-draft guard; bilingual role guides regenerated at go-live.

---

## 16. Features We Should NOT Build Yet

| Do not build | Instead | Justification |
|---|---|---|
| SCIM endpoint | OIDC + JIT provisioning + nightly group reconciliation | <1,000 users, one IdP; Dynamics itself defers SCIM to Entra |
| ABAC/OPA policy engine | Fix SEC-02/SEC-10 in `lib/permissions.ts` + `lib/access.ts` | Current pure-function model is small, tested, auditable |
| Session inventory UI | jti-keyed Session table first | No value until MFA/SSO change session creation |
| Field-level encryption / KMS | Neon at-rest + scoped access + audit immutability + encrypted backups | Breaks trgm search, dedupe and the Excel round-trip |
| SIEM/WAF/SOC, bug bounty | A few Sentry alert rules + email/Slack | No security function to consume it |
| Multi-tenancy / RLS | Record the single-tenant decision | Widens the surface to verify |
| Read replicas, multi-region, Redis, Kafka/BullMQ | Indexes, `take` caps, retention sweeps, ExportJob on cron | Every cited query is sub-second at 18k customers |
| OpenSearch | Branch trigram index | pg_trgm already serves the master |
| AuditLog partitioning / WORM ledger | `@@index([at])`, role split, trigger, archive later | Years from 10M rows |
| CQRS rewrite before cheap fixes | Incremental read-models, hot pages first | Maintainability cost, not a scale blocker |
| Terraform for four SaaS consoles | Read-only drift-check script + manifest | A state backend would itself need protecting |
| Feature-flag SaaS | `SystemSetting` table or Edge env `MAINTENANCE_MODE` | No audience for targeting |
| OpenTelemetry/Grafana | Sentry performance + request id in pino | Dashboards nobody would watch |
| Workflow designer | Chains in code; SLA/gate/regions in a Setting table | Three chains, near-zero churn, snapshotted per request |
| Full offline PWA with CRDTs | Banner + IndexedDB drafts + replay via existing version conflict | Owner descoped offline; amend PRD first |
| Public GraphQL platform | Confirm Temix headers; one narrow REST + signed webhook | Single-company deployment |
| Real-time push (WebSocket/SSE) | Email drainer + working escalation cron | SLA clocks tick in hours |
| Full Arabic RTL | String extraction + `Intl` formatting now | RTL audit is pointless before i18n plumbing |

---

## 17. Prioritized Enterprise Roadmap

Effort: S ≤ 1 eng-week, M 1–3, L 3–6, XL > 6. Arch = architectural change.

### Stage 1 — Blockers (weeks 1–4)

| # | Item | Priority | Impact | Effort | Dependencies | Risk reduction | Arch |
|---|---|---|---|---|---|---|---|
| 1.1 | PR + CI on all branches; manual PG limiter test; reconcile migrations; fast-forward merge; tag; live verification (B1) | P1 | Very high | S (0.5) | — | Brute-force exposure; deployed ≠ audited | N |
| 1.2 | Region-scope Manager admin; drop VIEWER from allowlist; flip tests (B2) | P1 | High | S (0.5) | — | Lateral escalation / mass export | N |
| 1.3 | Restore drill executed and timed; RTO/RPO + three restore runbooks; encrypt dumps; rotate `neondb_owner` + `DIRECT_URL` together (B3) | P1 | High | S–M (1) | Neon API key | Undefined recovery; silent backup break | N |
| 1.4 | D3 decision → Pro crons or external scheduler; heartbeat in bearer health; keep-warm 503 on DB fail (B5) | P1 | High | S (0.5) | 1.1 | Silent escalation/GC failure | N |
| 1.5 | Signed residency & processor register; PDPL opinion; edge Sentry scrub (B6) | P1 | High | S (0.2 + legal) | Owner/legal | Cutover-class rework later | N unless migration |
| 1.6 | Dependency bump/pin/prune; `npm audit` + dependabot; `authorized` returns Response; negative auth tests; correct register C1 | P2 | Medium | S (0.5) | 1.1 | Server-Action DoS; false control record | N |
| 1.7 | Per-user random initial passwords; import min 12; `filter-repo` credentials doc | P2 | Medium | S (0.3) | 1.1 | Rollout takeover window | N |

### Stage 2 — Foundation (weeks 4–12)

| # | Item | Priority | Impact | Effort | Dependencies | Risk reduction | Arch |
|---|---|---|---|---|---|---|---|
| 2.1 | `nmwc_app` role; `migrate deploy` as CI release step; AuditLog/EditApproval trigger; `migrate diff` check; missing FKs (B4) | P1 | High | M (1.5) | Neon role capability (Not Verified) | Audit tamper; drift; deploy coupling | Y (pipeline) |
| 2.2 | All 26 audit writers via `writeAudit`; fail on audit failure; fix labels; SYSTEM user; `PASSWORD_RESET`/`DIRECT_WRITE`/`PHOTO_VIEW`; import diffs; ESLint guard | P2 | High | M (2) | — | Forensic attribution | N |
| 2.3 | Postgres CI job (rate-limit-pg, merge-concurrency, credit-chain, import-multibranch, promote-*); coverage-v8 + thresholds; Playwright login; centralised prod guard; tests in Vercel build or CI-driven deploy | P1 | High | M (2) | 1.1 | Silent regressions | N |
| 2.4 | Client Sentry + release/env tags; external monitor on bearer health; alert rules; request-id child logger; log drain | P2 | High | M (1.5) | Vercel Pro (drain) | MTTD = first complaint | N |
| 2.5 | STEWARD controls: one-time credentials, two-person rule for approver tiers, refuse tier resets in import, gate credit fields | P2 | Medium | M (2) | 2.2 | Single-insider credit fraud | N |
| 2.6 | Edge `MAINTENANCE_MODE`; `app/(app)/error.tsx`; S3 timeouts; finalize 503; transient-DB mapping in `runAction`; bulk-approve budget + per-item results | P2 | Medium | M (1.5) | — | Outage UX; lost bulk results | N |
| 2.7 | Retention sweep (ImportRow.raw, RateLimit, unread Notifications); erasure on archive/merge/reject; written schedule | P2 | Medium | M (1.5) | 1.4 | PII accumulation; erasure | N |
| 2.8 | Admin UI: role/region/supervisor editor; region-scoped routes admin; channel CRUD; `/users` search+paging; hide export from non-export roles | P2 | Medium | M (2) | 1.2 | Spreadsheet-driven admin | N |
| 2.9 | `lib/config.ts`; collapse duplicated gates; delete dead modules; doc refresh; CONTRIBUTING/CODEOWNERS/SECURITY.md | P3 | Medium | M (1.5) | — | Misconfiguration; operator error | N |

### Stage 3 — Scale (months 3–6)

| # | Item | Priority | Impact | Effort | Dependencies | Risk reduction | Arch |
|---|---|---|---|---|---|---|---|
| 3.1 | OIDC (Entra) + IdP MFA; JIT provisioning; group→role; Credentials as break-glass; idle timeout; session table | P1 @5k / P2 @60 | Very high | L (4) | IdP availability | Phished credentials; leaver latency | Y (auth) |
| 3.2 | SQL dedupe + `DuplicateDismissal`; `@@index([at])` + EXISTS scoping; scoped cached dashboard; Branch trgm; `(state, reviewedAt)` index; report window clamp | P2 | High | M (2) | — | Admin pages time out | N |
| 3.3 | Read-model layer for dashboard/work/approvals/audit; split the three god functions with unit tests | P2 | High | L (4) | 3.2 | Scope leaks; untestable cores | Y (internal) |
| 3.4 | Single limiter check + background `lastLoginAt`/audit; pool `connection_limit`/`pool_timeout`; document Neon compute; k6 at 50/200/500 VU with budgets | P2 | High | M (2) | Neon branch | Login-wave P2024 | N |
| 3.5 | ExportJob wired: async xlsx to R2 + presigned download; rate-limit export routes; `maxDuration` 300 | P2 | Medium | M (2) | Vercel Pro | Export ceiling | Y (job pattern) |
| 3.6 | Temix: freeze headers with fixture test; persist batch xlsx to R2; stale-UPLOADED alert; ack↔batch link; email drainer | P2 | Medium | M (2) | ERP owner | Irreproducible batches; silent drift | N |
| 3.7 | Approver mobile drawer; approvers land on `/approvals`; queue pagination with true counts; a11y fixes + axe | P2 | Medium | M (1.5) | — | SLA breaches from phones | N |

### Stage 4 — Differentiation (months 6–12)

| # | Item | Priority | Impact | Effort | Dependencies | Risk reduction | Arch |
|---|---|---|---|---|---|---|---|
| 4.1 | i18n (next-intl, `ar`, RTL) | P3 | Medium | L (4) | — | Adoption | N |
| 4.2 | Offline minimum per PRD §6.4: banner, IndexedDB drafts incl. photo blobs, replay queue | P3 | Medium | L (5) | 3.3 | Field data loss | Y (client) |
| 4.3 | Minimal versioned REST API (API keys, cursor paging, 429) + signed webhook + OpenAPI | P3 | Medium | L (4) | 3.1 | Integrations from zero | Y (API) |
| 4.4 | Field-level security for credit/contact; audit UI with diff/date/actor/export | P3 | Medium | M (3) | 2.2 | Sensitive-field exposure | N |
| 4.5 | Region move closer to Oman if residency or latency demands | P3 | Medium | L (cutover) | 1.5 | 500 ms geography floor | Y (infra) |

**Recommended sequence:** 1.1 → 1.2 → 1.5 (decision) in week 1; 1.3, 1.4, 1.6, 1.7 in weeks 2–4; then 2.3 and 2.1 first so every later change lands through a gate; 2.2 with 2.5; 2.4 and 2.6 in parallel; 2.7–2.9; Stage 3 opens with 3.2/3.4 (measure, then fix) before 3.3; 3.1 as soon as an IdP exists; Stage 4 only after Stage 3 measurements.

---

## 18. Top 10 Highest-ROI Improvements

| # | Improvement | Effort | Return |
|---|---|---|---|
| 1 | Merge + tag + live verification (B1) | 0.5 wk | Activates every security fix already written; ends deployed≠audited |
| 2 | Region-scope Manager user admin (B2) | 0.5 wk | Closes the only confirmed privilege escalation |
| 3 | Run and time the restore drill; write three restore paths (B3) | 1 wk | "Backup exists" → "recovery works"; RTO defined |
| 4 | Reliable crons + heartbeat + external monitor (B5, DO-05) | 0.5 wk + plan | Escalation/GC run; outages detected |
| 5 | `authorized` returns Response; negative tests; fix register C1 | 0.3 wk | Restores defence in depth; corrects a false record |
| 6 | Audit writers via `writeAudit`; no swallowed failures; fix labels | 1 wk | Forensic value on every business action |
| 7 | Postgres CI job + coverage thresholds + CI on all branches | 1.5 wk | Concurrency/authz suites on every change |
| 8 | Dependency bump/pin/prune + audit in CI | 0.3 wk | Removes the one applicable DoS and a spurious critical |
| 9 | Client Sentry + env/release tags + honest error copy | 0.5 wk | Mobile failures visible; preview noise separated |
| 10 | Signed residency register + PDPL opinion | 0.2 wk + legal | Prevents a cutover-class migration later |

---

## 19. Target Architecture / End-State Recommendation

**Keep.** The modular monolith with `app → services → lib`; `runAction`; Edge/Node split and nonce CSP; fail-closed `lib/access.ts` + pure `lib/permissions.ts`; config-in-code chains snapshotted per request; atomic-claim transitions; Postgres-level invariants and optimistic versions; the slice-and-lease job pattern; Neon + R2 + Vercel + GitHub, single region until a residency decision says otherwise; pg_trgm search; Postgres token-bucket limiter.

**Fix now, before scaling.**
1. *Pipeline as the gate* — CI on every branch with Postgres; migrations as a CI release step under the owner URL; runtime on `nmwc_app`; tagged releases; only green commits deploy.
2. *Identity boundary* — `authorized` returns Responses; OIDC + IdP MFA with Credentials as break-glass; region-scoped delegated admin; server-generated one-time credentials.
3. *Audit as a subsystem* — one writer, a SYSTEM principal, correct taxonomy, DB-level immutability, per-row import diffs, retention policy.
4. *Operability shell* — bearer health with heartbeats consumed by an external monitor; client + server Sentry with release/env; request ids; Edge maintenance switch; documented RTO with a scheduled monthly drill; secrets inventory with rotation dependencies.
5. *Bounded queries* — every list/aggregate scoped and capped in SQL; `@@index([at])`, `(state, reviewedAt)`, Branch trgm; dedupe in SQL with a dismissal table.

**Can safely evolve later.** Read-model layer and god-function decomposition (incremental, hot pages first); ExportJob async path and keyset pagination (trigger: >50k branches or >500 users); session table / idle timeout (after SSO); `SystemSetting` for SLA/gate/regions; i18n/RTL, offline queue, REST API + webhooks, field-level security, audit UI depth; region relocation on a residency or measured-latency decision; partitioning, log platforms, worker fleets only when measurements justify them.

**For 5,000 users** add federated identity with JIT provisioning, pool sizing validated by a ≥500-VU test, async exports, typeahead user lookups, keyset pagination, retention sweeps on a reliable scheduler, and a second operator with a severity matrix. No new infrastructure class (queues, replicas, multi-region) is required at that number for this data shape.

---

## 20. Final Verdict

The engineering core is credible and in places exemplary for its size; the operational, identity, observability and governance envelope is not yet built. Six confirmed P1 items — a stale production deploy with a non-functional limiter, a Manager→VIEWER escalation, a never-successful restore, convention-only audit immutability under an exposed owner credential, undelivered sub-daily scheduling, and an unmade residency decision — are each small to fix but individually disqualifying for an enterprise buyer.

**❌ Not enterprise-ready**

**"If you were the CTO of a large company evaluating whether to purchase and deploy this application, what would stop you from approving it today?"**

Five things, in order. First, I cannot buy what is running: production serves a build 74 commits behind the audited code with a brute-force limiter that never denies (`git show origin/main:lib/rate-limit.ts` :88-104), and that code has never passed CI. Second, my regional managers could each export my entire customer master and read every credit-guarantee document by creating one VIEWER account (`lib/permissions.ts:223-227`; `lib/access.ts:193`). Third, nobody has ever restored a backup — the one attempt failed and was gated off (run `25630332801`; `db-backup.yml:154`) — so no one can tell me my recovery time. Fourth, the audit trail I would rely on in a dispute can be rewritten by a database credential that has already been pasted into chat (`docs/GO-LIVE-RUNBOOK.md:21`), while the spec assures me it is immutable (`docs/TECH-SPEC.md:776`). Fifth, my users' identities live in a local password table with no MFA or SSO, and my customers' and employees' personal data sits in a US region with no residency decision or data-protection assessment on file. Fix the first four within a month, show me a signed residency decision and an SSO plan, and I would re-evaluate for a controlled departmental deployment.

---

## Remediation log (after the assessment)

| Date | Blocker | Status | Evidence |
|---|---|---|---|
| 2026-09-14 | **B2** — regional MANAGER could mint an org-wide VIEWER / administer outside their regions (SEC-02) | **Closed** | `lib/permissions.ts` (`MANAGER_ADMINISTRABLE_ROLES` = SALESMAN, SUPERVISOR; `managerCanAdministerUser` / `managerCanAssignRoute` / `managerCanAssignSupervisor`), `services/users.ts` (`assertManagerScopeOverTarget` on disable/reset/re-role; route + supervisor scope on create/re-role), `/users` narrowed; SEC-10 alongside (`services/routes.ts` region-scoped, region creation Steward-only). Tests: `tests/unit/user-admin-authz.test.ts` (9 new cases), `tests/integration/user-admin-region-scope.test.ts` (7/7, also in CI). Commit `f4f1f02`. |
| 2026-09-14 | **B1** — production served the May `main`; go-live branch never ran through CI (SEC-06 / DO-01 / DO-02) | **Closed** | `.github/workflows/ci.yml`: CI on every push, `next build`, advisory `npm audit`, `db-tests` job (postgres:16, migrate + seed + generated fixtures, 77 DB-backed integration tests, ~25 s). First green run `34837699665` on `70feff0`. Owner-approved fast-forward of `main` to `6852063` (PR #1), production build applied the four additive migrations; verified live: `/api/cron/sla-escalate` 401 (was 404), region `iad1` (was `fra1`), providers on the production host. Tag `v1.1.0-golive`. Still open from B1's blast radius: the production DATA load (runbook §1) and the dependency bump (SEC-05, roadmap 1.6). |
| 2026-09-14 | **B3** — restore had never succeeded; RTO/RPO undefined; dumps were plaintext PII | **Code closed — drill secrets pending (owner)** | Root cause found: the one attempt (run `25630332801`) died on a missing-secrets guard and a commit 2 min later added `&& vars.NEON_DRILL_ENABLED == 'true'`, a variable never created — so 127 runs reported the drill "skipped" while the workflow reported success. Worse, it created a Neon branch with no parent, i.e. a clone of production, so its "≥10 tables" check would have passed whether or not a row loaded. Now: the drill is its own workflow, EMPTIES the branch and asserts 0 tables before loading, restores with `ON_ERROR_STOP` keeping the log, runs `scripts/ops/restore-verify.ts` (schema, enums, migration ledger, extensions, all six triggers, FK/CHECK validity, orphans, the B-19 invariant, usable password hashes, plus functional probes that the restored ledger really refuses an UPDATE), re-creates `nmwc_app` (pg_dump carries no roles — every restore lacks it), times every phase, and DELETES the branch in `if: always()`. Dumps are age-encrypted to `BACKUP_AGE_RECIPIENTS` with key escrow documented; each run writes its own timestamped key (no same-day overwrite); a row-count manifest makes silent data loss detectable; the dump is checked for pg_dump's completion marker, a byte floor and the expected tables before upload; the job POSTs its outcome so a missed night alarms on bearer `/api/health` within 40 h (threshold set from the real cadence: 64 of 126 gaps exceed 24 h, worst 33.2 h). CI proves the whole chain — dump → encrypt → decrypt → restore into an empty database → verify → rebuild the role — on **every push** (`restore-chain`). Backup retention is now set and checkable from code (`scripts/ops/r2-backups-lifecycle.ts`), not a dashboard TODO. RTO/RPO and three runbooks in OPERATIONS §6, including the two facts nobody had written down: photographs have no backup at all, and a restored database has no runtime role. **Owner:** age key + `NEON_API_KEY`/`NEON_PROJECT_ID`, then run the drill (runbook §0 step 10). |
| 2026-09-14 | **B4** AuditLog immutability + least-privilege DB role | **Code closed — production rollout pending (owner)** | Migration `20260914150000_audit_immutability`: `nmwc_forbid_audit_mutation()` BEFORE UPDATE/DELETE row triggers + BEFORE TRUNCATE statement triggers on `AuditLog` and `EditApproval`, refusing every connection (owner included) unless the transaction first ran `SET LOCAL nmwc.audit_maintenance = 'on'` (maintenance scripts + test clean-ups via `tests/support/audit.ts`). `scripts/ops/app-role.ts create\|grant\|verify`: least-privilege login role `nmwc_app` (app tables read/write, INSERT-only on the two ledgers, no `_prisma_migrations`, no DDL, default privileges for future migrations); `verify` proves each refusal connected AS the role. Neon `CREATE ROLE` capability **verified** on the UAT branch (created, granted, verified ✓). Tests: `tests/integration/audit-immutability.test.ts` 3/3 + 16 converted suites 16/16 under the live trigger; CI runs create→grant→verify and RUN_AUDIT_IMMUTABLE on every push. Runtime split `DATABASE_URL` = `nmwc_app` pooled / `DIRECT_URL` = owner. **Owner:** run the three commands against production (`ALLOW_PRODUCTION=1`), swap Vercel Production `DATABASE_URL`, redeploy, check the bearer health probe (runbook §0 step 8, OPERATIONS §5c). |
| 2026-09-14 | **B5** sub-daily scheduling + heartbeat | **Dead-man built and deployed; D3 decided (external scheduler) — owner to create the two cron jobs** | `CronHeartbeat` table (migration `20260914150100_cron_heartbeat`) + `lib/heartbeat.ts`: `withHeartbeat` wraps `sla-escalate` / `keep-warm` / `photo-gc` so every finished run is recorded (401 excluded; a thrown handler records a failure and answers 500); `heartbeatReport` states `ok / failed / stale / never / outside-window` against the schedules (30 min and 4 min inside 03–15 UTC, daily), stale after 3 missed intervals. `/api/health`: anonymous **503** when `SELECT 1` fails (was always 200); bearer mode adds `cron.alarms` + `cron.jobs` and answers **503** on any alarm — the URL for an external monitor. keep-warm 503 on DB failure. Unit `tests/unit/heartbeat.test.ts` 6/6. Owner decided D3 on 2026-09-14: an **external scheduler** calls the two bearer endpoints (`keep-warm` every 4 min, `sla-escalate` twice an hour, 03:00–14:59 UTC); OPERATIONS §5d carries the step-by-step setup and the verification curl. Until those jobs exist the probe answers `never` — which is the point. Merged to `main` and deployed to production on 2026-09-14 (commit `0f6c0e1`). |
| 2026-09-14 | **B4/B5 adversarial review** of commit `a6addee` (6 lenses → 18 candidates → 3 skeptics each → 13 confirmed, 8 distinct) | **All fixed** | **P1** the runtime role could reach `EditApproval` through the `CustomerEdit` ON DELETE CASCADE (referential actions run as the table owner) after setting the placeholder GUC itself → migration `20260914160000_audit_maintenance_owner_only` (override honoured only when `session_user` is the table owner — cascades cannot change `session_user`) + `REVOKE DELETE, TRUNCATE ON "CustomerEdit"` (the app never deletes edits) + `verify` probes both paths + integration case run AS `nmwc_app` (also in CI). **P1** the heartbeat opening grace reported a job dead for days as `ok` every morning, and the outside-window rule cleared a live alarm at 15:00 → allowance now anchored on the previous window close (`allowedAgeMinutes`), 8 unit cases incl. dead-for-days-at-03:15 and died-mid-window-stays-stale. **P2** `verify` left a fabricated `UPDATE` audit row attributed to the oldest user on every production run → every probe now runs inside one transaction that is rolled back (savepoints per probe, `lock_timeout` 2 s, transaction-scoped advisory lock instead of a session lock that leaked through the pooler). **P2** test clean-ups ran the maintenance transaction on `DATABASE_URL`, which after the rollout is `nmwc_app` → `tests/support/audit.ts` opens an owner client on `DIRECT_URL` per purge (also takes the purge out of a suite's mocked `$transaction`). **P2** the immutability test's `TRUNCATE` could queue on ACCESS EXCLUSIVE against a live database → bounded by `lock_timeout`. **P2** OPERATIONS still said the public health probe is always 200 (two places) and never showed the production override for the role commands → corrected. Refuted (5): `create` resets an existing role's password (documented contract), health folds alarms into one 503 (by design), pre-existing e2e assertion, anonymous DB round-trip keeps Neon awake (intended), doc command context (fixed anyway). |
| 2026-09-14 | **B6** — no residency decision or data-protection assessment for Omani PII processed in the US | **Documented and instrumented — owner blanks + counsel pending** | Deliberately not the "one-page register" the assessment asked for: a register answers *where* and cannot answer *why, on what basis, to whom, for how long*. Four documents in `docs/compliance/`: `RECORDS-OF-PROCESSING.md` (six activities, three subject populations — including employees as monitored workers and photograph bystanders — with lawful basis left blank for counsel, not guessed), `DATA-RESIDENCY-REGISTER.md` (eight processors incl. Temix and the GitHub runner the whole database transits nightly; records that both R2 bucket locations and the Sentry region are genuinely unknowable from the repo), `DATA-RETENTION-SCHEDULE.md` (with an Enforced-by and a Proven-by column), and `PDPL-ASSESSMENT.md` (six questions for counsel with the engineering facts each needs, no legal conclusions). The technical annex `PII-INVENTORY.md` is **generated** from the schema plus `lib/compliance/pii-classification.ts` — all 280 columns classified (25 customer, 61 employee, 36 entity-or-person, 158 non-personal) — and `tests/unit/pii-classification.test.ts` fails CI if a column is added without a decision, so the annex cannot rot. Code fixes found along the way: the Edge Sentry runtime had **no scrubbing at all** (middleware sees every URL and cookie) — one tested scrubber now serves all three runtimes; cron error strings were stored and served to the health probe unscrubbed; two of the four export paths wrote their audit row as `IMPORT`, so "who exported the customer master" was unanswerable; `clientIpHash()` did not hash. A retention sweep now enforces the schedule for spent rate-limit rows (1 day — they hold usernames and IPs), verbatim import payloads (90 days) and unread notifications (180 days). **Owner:** the `[OWNER]` blanks, and counsel. Timing matters: the go-live load has not run, so residency is still a configuration change rather than a cutover. |
| 2026-09-14 | **B3/B6 adversarial review** of commit `b587754` (6 lenses → 3 skeptics each → 7 confirmed, 6 distinct, 33 refuted) | **All fixed** | **P0: the nightly backup would never have uploaded.** The pre-upload check ran `gunzip -c dump.sql.gz \| grep -q PATTERN` under `set -o pipefail`; `grep -q` exits on the first match, `gunzip` dies of SIGPIPE (141), pipefail propagates it and the `\|\|` branch fires — so the step reported "dump does not contain table Customer" on a dump that does contain it, aborting before the encrypt and upload steps. Reproduced locally on a 505 KB dump. **CI stayed green only because its fixture dump was ~11 KB — small enough to fit in one 64 KB pipe buffer** — so the new gate was itself blind to the defect it was meant to prevent. Fixed with `scripts/ops/dump-rowcounts.awk` (one pass that consumes the whole stream, emits per-table row counts and asserts the completion marker), an exact `case` membership test (`grep -P` is not portable — it refuses to run in some locales), and a CI fixture padded to ~4,000 rows so the streaming path is genuinely exercised. **P1:** the retention sweep left the data it claimed to clear — Prisma reads `undefined` as "leave this column alone", so only `raw` was emptied while `parsed` kept name, address, phone, contact person and CR number, and the `raw = {}` progress marker then excluded the row forever (now one raw SQL statement, with `tests/integration/retention-sweep.test.ts` 6/6 proving it against real rows, gated in CI). **P1:** a `workflow_dispatch` input was interpolated into a shell script in the job holding the backup decryption key, the R2 credentials and the Neon API key (now passed through the environment, plus a key-shape check). **P1:** `BRANCH_ID` reached `GITHUB_ENV` only after four further extractions that can each throw, so a partial failure left an undeletable Neon branch holding a full copy of production data (recorded first, alone). **P1:** the row-count manifest was taken by a separate session before pg_dump opened its snapshot, so an ordinary write during the dump window made a byte-perfect restore fail (counts now come from the dump itself; the watermark check became a floor). **P2:** the "no dumps found" message was unreachable because the JMESPath expression raises on an empty prefix. |
