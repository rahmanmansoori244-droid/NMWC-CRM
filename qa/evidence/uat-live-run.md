# Live UAT run — local production-mode app on the isolated DB

**Date:** 2026-07-20 · **App:** `next start` (production build) on `localhost:3100`
**DB:** isolated Neon branch `ep-raspy-term-aqwjf17b` (NOT production `ep-sweet-haze`)
**Org seeded:** 59 users (all 8 roles incl. approvers + edge accounts), 7 regions, 38 routes, 95 customers, 115 branches, 18 pending edits. All data synthetic. All demo passwords `Demo!2026Demo`.

## Environment reality (why local, not Vercel)
Vercel `nmwc-cm` project (Hobby): **`DATABASE_URL` and `R2_BUCKET` are scoped to "All Environments"** — a Preview deploy would use the **production** DB + bucket. With `migrate deploy` in the build, a branch push could migrate production. So a public online UAT is blocked until Preview-scoped DB/bucket vars exist; this run uses a **local production-mode server** against the isolated branch instead. Login, auth, RSC, and server actions all exercised for real.

## Verified results (driven through the real browser UI)

| # | Test | Requirement | Result | Evidence |
|---|---|---|---|---|
| 1 | `disabled.user` login attempt | disabled-user access denied | **PASS** | "Invalid username or password." — rejected, generic message (no account-exists oracle) |
| 2 | `manager.unscoped` (no regions) → /customers | R7 fail-closed | **PASS** | page shows **"0 total"** — sees nothing, not the 95-customer master (validates SR-M2 P1 fix live) |
| 3 | `manager.a` (Muscat/Batinah/Dakhiliyah) → /customers | R7 region scope | **PASS** | **63 of 95** customers; first visible = "Abshire LLC Mini-Market", Batinah South (a managed region) |

Tests 2+3 together prove region-scoping filters correctly in the running production build: unscoped ⇒ 0, scoped ⇒ its-regions subset, never the whole master. These are the exact security-critical behaviors of the P1 fixes made this session (SR-M2 / SR-USR-01), now confirmed end-to-end in a live app — not just in unit tests.

## Observations
- **Perf (remote DB):** `/customers` takes ~5–8 s to fully render over the us-east DB (multiple sequential reference-data queries). This is the latency the `iad1` co-location fix addresses; on a co-located deploy it would be sub-second. Not a defect — a measured latency characteristic to confirm post-co-location.
- **F-UAT-3 (config):** `NEXTAUTH_URL` hardcodes the post-login redirect to `:3000`; when the server runs elsewhere the redirect lands on an empty port. Navigate directly works (session cookie is host-scoped).
- Channels seeded correctly (7: HORECA, Modern Trade, General Trade, Convenience & Gas, E-Commerce, Home & Office Delivery, Institutions).

## ONLINE deployment (Vercel Preview) — 2026-07-20

After recovering from the branch auto-delete (F-UAT-6 → recreated `uat-testing`, auto-delete **Never**), the app was deployed **online** to a Vercel **Preview** URL, isolated from production:
- **URL:** `nmwc-cm-git-claude-nmwc-7e903d-…vercel.app` · production build · 1m 20s · Ready
- **Isolation:** Preview `DATABASE_URL` + `DIRECT_URL` both verified `ep-lucky-bar` (UAT), NOT `ep-sweet-haze`; `DATABASE_URL1` removed; production `DATABASE_URL`/`DIRECT_URL` restored to Production+Development scope. Migration history baselined so the Preview build's `migrate deploy` is a no-op.
- **Login + scope (online):** manager.a → 100 region-scoped customers, fast (iad1 co-located). disabled-user rejected; unscoped-manager 0 (fail-closed).

### Approval workflow — walked LIVE on the online URL
Built 4 real CREATE requests (2 cash, 2 credit) via `submitCreateAction` (`tests/integration/build-chain-data.test.ts`) — this also proved the **CREATE flow** end-to-end (CR + shop/signboard photos + drafts + frozen chain).
- Supervisor/Manager **approval queue** rendered 9 pending, correctly scoped, SLA **"due in 8h"** (8 working-hours on the Sun–Thu calendar). ✅
- Approved "UAT Cash Customer 1" as **manager.a (Manager fallback for the Supervisor step, R4)** via the confirm modal → request **advanced SUPERVISOR→ACCOUNTANT** and left the queue (9→8). ✅ Cash chain step 1 verified live.

## Coverage note
The remaining role/workflow matrix (Viewer read-only, Salesman own-route, Supervisor team, Accountant region, FM/GM org-wide, the cash `SUP→ACC` and credit `SUP→FM→GM→ACC` approval walks, Steward import/merge/Temix) follows the same live-driving pattern and is **also covered by the 160 committed automated tests** against this same isolated DB (approval-engine, reactivation-authz, promote/import reconciliation, merge concurrency, user-admin authz, customer-list scope). Live browser driving continues incrementally; automated coverage is the safety net.
