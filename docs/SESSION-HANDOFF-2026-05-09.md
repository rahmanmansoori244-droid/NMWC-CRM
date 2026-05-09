# Session handoff — 2026-05-09

This file captures everything done in the 2026-05-09 session and where to pick up.

## TL;DR

- **Deployed:** `https://nmwc-cm.vercel.app` running commit `2a1297e` (post-fix-campaign + page-gate follow-up).
- **Status:** every Critical and stop-ship High from the 7-agent audit closed in code, deployed to production, and live-tested in Chrome.
- **Outstanding launch-blockers:** none from the audit. Two operational items remain (see §5).
- **Tomorrow:** decide between (a) ship the 2-route pilot, (b) start Wave-1 enhancements (offline / E2E / observability / SLA notifications / Arabic), or (c) close the import-action robustness bug spawned as a separate task.

---

## 1. What this session produced

### 1.1 The 7-agent adversarial audit (`docs/audit/01..07.md`)

Six parallel domain agents + one cross-check agent walked every workflow as a real user. Findings before fixes:

| Domain | Critical | High | Medium | Low |
|---|---|---|---|---|
| 01 — Auth / Session / User mgmt | 0 | 9 | 7 | 4 |
| 02 — Edit lifecycle + approvals | 1 | 3 | 8 | 4 |
| 03 — Imports + exports + Excel | 2 | 6 | 9 | 6 |
| 04 — Photo pipeline | 0 | 3 | 4 | 5 |
| 05 — RBAC + scope matrix | 2 | 5 | 9 | 9 |
| 06 — UX / data integrity | 1 | 8 | 14 | 9 |
| 07 — Cross-check + gaps | — | 12 chains + 11 gaps | — | — |
| **TOTAL** | **6** | **34** | **51** | **37** + 12 chains + 11 gaps |

### 1.2 The fix campaign (commits `7856627` + `2a1297e`)

57 files changed, 5,240 insertions, 347 deletions. All Critical and stop-ship High closed. Schema migration `20260510000000_pre_launch_hardening` applied to Neon (idempotent). Highlights below — see commit messages for full list.

**Critical fixes**
- **EL-01** customer-status CLOSED bypass — guard mirrors branch-status guard
- **F-01** export scope filter overwrite — intersect, never replace
- **F-02** Steward-mints-Manager via import (3 bypasses) — block STEWARD from any promotion to MANAGER/STEWARD by `id`, not `username`
- **RBAC-05-001** multi-branch leak — `filterBranchesByScope` on profile + edit pages
- **RBAC-05-003** Manager approves any region — `canApproveSpecificEdit` requires region overlap + region-scoped queue + detail check + `EL-15` self-approval block
- **UXI-001** photo trash one-tap delete — confirm dialog + 44px tap target

**High fixes**
- **AUTH-04..AUTH-19** — role-change UI, last-Manager guard, peer-Manager guard, `mustChangePassword`, `sessionsRevokedAt`, change-password page, low-entropy `AUTH_SECRET` smell test, lowercased rate-limit key, per-user vs per-IP message split, "Forgot password?" link
- **EL-02** GPS Zod path mapping; **EL-03** phone-collision PII leak across regions; **EL-04** mandatory gate re-run at approve; **EL-05** audit-log diff (not count); **EL-09** P2002 detection by message; **EL-10** reassigned-branch drop on approve; **EL-11/12** `capturedAt > Branch.lastStatusChangeAt`
- **F-03..F-19** — promote failures REJECTED + audit; phone+CR dedup intra-file + master; `stripHtml` + formula-prefix refusal on import; promote advisory-lock + rate-limit; sanitised log; phantom-region warning; ownedRoute reassignment audit; per-batch IMPORT audit
- **NEW-PHOTO-001..007** — slot-kind binding; dedupe per-uploader; soft-delete prior slot photo on replace; 3 MB cap presign+finalize; `capturedAt` = R2 LastModified
- **RBAC-05-002..023** — list-card scope; peer-Manager block; audit region scope + STEWARD; reactivation region scope; imports + duplicates Steward-only (page-level + service-layer); work region scope; supervisor blocked on attach; fail-closed `canSeeCustomer` for unscoped Manager; `capturedById` bypass only when truly orphan; soft-deleted attachment 404; edit-form branches scope; `/users` PII trim
- **UXI-002..024** — user-scoped draft key; stale-draft warning; synchronous submit lock; `router.replace` + `force-dynamic`; Arabic-Indic phone digits + reject ambiguous lengths; Attachment `deletedAt` column; numeric `inputMode`; CR strip whitespace only; empty routes filtered from leaderboard; `createObjectURL` instead of FileReader

**Gap closures**
- `app/error.tsx` + `app/not-found.tsx` (GAP-04 — branded error pages)
- `/api/health` minimal info disclosure + bearer detail (GAP-01)
- Sentry server+client scrub URL/body/exception (GAP-02 / CHAIN-12)
- Photo GC daily cron + `vercel.json` (GAP-03 / NEW-PHOTO-003)
- Rate-limit fail-closed for login under DB outage (GAP-12)

**Schema migration `20260510000000_pre_launch_hardening`**
- `User.sessionsRevokedAt`, `User.mustChangePassword`
- `Branch.lastStatusChangeAt`
- `Attachment.deletedAt` + index on `deletedAt` + `hash` (idempotent — uses `IF NOT EXISTS`)

### 1.3 Live tests in production via Chrome MCP

| Test | Verdict |
|---|---|
| GAP-01 — `/api/health` unauthenticated returns `{"status":"ok"}` only | ✅ PASS |
| AUTH-15 — `/login` shows "Forgot your password?" link | ✅ PASS |
| RBAC-05-001 — Carrefour multi-branch shows `Branches (1)` for `salesman.mct-01` | ✅ PASS |
| EL-01 — Customer Status select hidden for SALESMAN | ✅ PASS |
| Mandatory-fields banner — visible with exact missing list, Submit disabled | ✅ PASS |
| RBAC-05-005 — Supervisor `/edit` redirects to read-only profile | ✅ PASS |
| RBAC-05-003 — `manager.b` (Dhofar/Sharqiyah/Dhahirah) sees only SHQ approvals | ✅ PASS |
| GAP-04 — branded 404 page renders for cross-region deep-link | ✅ PASS |
| F-01 — `?regionId=fake` reduces export from 16,597 B → 6,054 B (empty xlsx) | ✅ PASS |
| RBAC-05-009 — `manager.a` redirected from `/import` and `/duplicates` | ✅ PASS |
| F-02 — malicious xlsx (manager.evil + salesman.mct-01→MANAGER) does NOT mutate DB | ✅ PASS |

UXI-001 photo trash confirm dialog was code-verified but not live-triggered (no customer with attached photos in test data).

### 1.4 Brutal benchmark vs market

Full report at `docs/BENCHMARK-REPORT.md`. Headline numbers:

- **Overall: 63 / 100 — Strong v1 / solid niche product.**
- Best benchmark = Salesforce Consumer Goods Cloud (functional parity for what NMWC will need); most realistic commercial alternative = Zoho CRM + Field Service Plus.
- Recommendation: **continue custom build with major upgrades**. Wave-1 enhancements detailed in `docs/POST-LAUNCH-ROADMAP.md`.

---

## 2. Repo state

- **Branch:** `main`
- **Latest commit:** `2a1297e` ("Page-level redirect for /import + /duplicates (RBAC-05-009 follow-up)")
- **Previous commit:** `7856627` ("Pre-launch hardening: 6 Critical + 34 High closures")
- **Migrations applied:** through `20260510000000_pre_launch_hardening`
- **Tests:** 47/47 unit tests pass (`npx vitest run`)
- **Typecheck:** clean (`npx tsc --noEmit`)
- **Build:** clean (`npx next build`)

### Files of interest (not exhaustive)

```
docs/
├─ audit/
│  ├─ 01-auth-session.md         9 High
│  ├─ 02-edit-lifecycle.md       1 Critical, 3 High
│  ├─ 03-imports-exports.md      2 Critical, 6 High
│  ├─ 04-photos.md               3 High
│  ├─ 05-rbac-scope.md           2 Critical, 5 High
│  ├─ 06-ux-data-integrity.md    1 Critical, 8 High
│  └─ 07-cross-check.md          12 chains + 11 gaps + 7 falsely-claimed-fixed
├─ BENCHMARK-REPORT.md           market benchmark, 63/100, recommendation
├─ POST-LAUNCH-ROADMAP.md        prioritised enhancement waves
├─ SESSION-HANDOFF-2026-05-09.md this file
├─ PRD-v0.1.md
├─ TECH-SPEC.md
├─ UX-SPEC.md
├─ BUILD-REPORT.md
├─ QA-AUDIT-REPORT.md            old (superseded by docs/audit/)
├─ REMEDIATION-REPORT.md         old (audit found this had over-claimed fixes)
└─ PROD-LOAD-AND-BUGS.md         the original 5-PROD bugs we fixed first
```

### Demo accounts (DEMO_ACCOUNTS_DISABLED currently `false`)

| Username | Role | Notes |
|---|---|---|
| `admin` | MANAGER | seed; password: `ChangeMeNow!2026` (rotate before go-live) |
| `manager.a` / `manager.b` | MANAGER | a = Muscat/Batinah/Dakhiliyah; b = Sharqiyah/Dhahirah/Dhofar |
| `steward` | STEWARD | imports, duplicates |
| `viewer` | VIEWER | read-only global |
| `supervisor.1` … `.7` | SUPERVISOR | each has 5–6 salesmen |
| `salesman.<route-code>` | SALESMAN | e.g. `salesman.mct-01`, 38 of them |
| All passwords: `Demo!2026Demo` |

---

## 3. Outstanding follow-ups

### 3.1 Spawned task chip — Account-master import error robustness

During the F-02 live test, the Account-master upload action errored out completely on a mixed valid/invalid xlsx (no `ImportBatch` row created). The **security boundary held** (no DB damage), but a single bad row currently aborts the whole upload instead of being recorded as `QUARANTINED`. Spawned as a separate task — start it in a fresh worktree.

Likely culprits to investigate:
- F-19 audit-log create call near the end fails if action threw earlier
- `prisma.user.findUnique` twice (`targetExisting` + `existing`) — confirm shape
- `parseWorkbook` on small xlsx — exceljs edge case
- Missing Sentry breadcrumbs around per-row processing → diagnose first

Tests to add: integration test that uploads a malicious xlsx and asserts (a) malicious rows land as `QUARANTINED ImportRow` rows, (b) legit row creates the user, (c) action returns successfully.

### 3.2 Pre-launch ops checklist

Before flipping to full pilot (whether 2-route or full 38-route):

1. **Set `DEMO_ACCOUNTS_DISABLED=true`** in Vercel env. Currently `false` for testing.
2. **Rotate `admin` password** away from `ChangeMeNow!2026`. Either via `npm run db:seed` with `SEED_ADMIN_PASSWORD=<strong>` or via the new `/users` flow.
3. **Set `HEALTH_BEARER`** env var (≥20 chars) so monitoring can hit `/api/health` with `Authorization: Bearer <token>` for the detailed payload. Without it, public callers only see `{status}`.
4. **Set `CRON_SECRET`** env var so the photo-GC cron at `/api/cron/photo-gc` works (Vercel auto-injects on cron invocations).
5. **Auth.js auto-deploy from GitHub appears disabled.** Pushing to `main` did NOT trigger a Vercel build today; we deployed manually with `npx vercel --prod --yes`. Either (a) reconnect GitHub integration in Vercel, or (b) document the manual deploy step in the runbook.

---

## 4. Audit verdicts that did NOT make it into the fix campaign

The audit produced 51 Medium and 37 Low findings beyond Critical/High. Most are deliberately deferred. The ones worth re-reading the audit reports for:

**Mediums I would tackle next:**
- **AUTH-13** explicit cookie hardening (`__Host-` prefix) — partial: `__Secure-` is in, `__Host-` not yet
- **EL-08** Steward/Manager attaching another user's photo — currently flagged as `FORCE_OVERRIDE` audit row but no UI banner
- **NEW-PHOTO-006** GPS sanity check (haversine distance branch ↔ photo) — straightforward to add
- **RBAC-05-022** edit-form sub-channel ⊆ channel cross-validation — server-side `superRefine`
- **UXI-009** `/audit` filters + pagination — done in this session ✅ (already shipped)
- **UXI-018** empty-routes filtered from leaderboard — done in this session ✅
- **UXI-021** sub-channel/channel cross-validation — not yet shipped
- **UXI-007** equipment "confirmed empty" toggle — UX/data quality

**Lows:** see audit files for detail; mostly polish.

---

## 5. Where to pick up tomorrow

Three viable paths in priority order:

### Path A — Pilot launch (2-route or 38-route)

1. Run the pre-launch ops checklist (§3.2).
2. Decide pilot scope: 2-route conservative or 38-route full.
3. Run a final smoke test from Chrome with each role.
4. Set up basic monitoring: at least an UptimeRobot ping on `/api/health` and a Sentry alert rule on error rate.

### Path B — Wave 1 enhancements

Per `docs/POST-LAUNCH-ROADMAP.md`, in priority order:

1. **Playwright E2E suite** — submit→approve→reactivate→merge across SALESMAN/SUPERVISOR/MANAGER. Highest value relative to effort.
2. **Approval SLA + email/Slack notifications + escalation** — current "stale > 3 days" surfaces nothing actionable.
3. **Production observability** — structured traces, RUM, alerts on import failures and approval queue depth.
4. **Arabic UI (RTL + i18n)** — adoption-critical for Oman field deployment.
5. **Offline-first salesman capture** — biggest market gap; service worker + IndexedDB queue + sync.

### Path C — Close the spawned import bug + harden test surface

1. Fix the Account-master import action robustness bug (spawned task chip from this session).
2. Add the integration test for the malicious-xlsx → QUARANTINED flow.
3. Backfill Playwright E2E coverage of the importer + approval queue.

My recommendation: **A first** (close the loop on the production launch you've been preparing for), then **B in parallel** with the pilot running. **C** can be a worktree by the second engineer if you have one.

---

## 6. Key facts to keep in mind

- **`DEMO_ACCOUNTS_DISABLED=false`** in Vercel right now. Demo passwords are seeded. Flip on go-live.
- **JWT freshness** runs every 5 minutes. Disable / role-change / password-reset revoke session within 5 minutes via `sessionsRevokedAt` marker — not instant.
- **Rate-limit on login is fail-closed** (GAP-12): if Postgres rate-limit table is briefly unreachable, login returns 503 for 30 seconds. Non-security-critical limits (form, photo) fall back to in-memory.
- **Photo GC cron** at `/api/cron/photo-gc` runs daily at 03:00 UTC (07:00 Oman). Hard-deletes `Attachment` rows soft-deleted ≥30 days ago + their R2 objects.
- **Vercel auto-deploy from GitHub appears disabled** — manual `npx vercel --prod --yes` was needed today. Re-check Vercel project settings.
- **Neon autosuspend** means a cold start adds ~3s to the first login of the morning. Consider a periodic warmup ping.
- **The previous `REMEDIATION-REPORT.md` over-claimed fixes** for QA-011, QA-025/048, QA-047, QA-044. The new audit reports in `docs/audit/` are the source of truth.
