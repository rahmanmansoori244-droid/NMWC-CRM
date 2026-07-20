# NMWC CRM — Owner decisions (confirmed 2026-07-20)

Resolves the open owner-decision items from the launch checklist and the two deep-review rounds.

| # | Decision | Owner answer | Action taken | Status |
|---|---|---|---|---|
| D1 | **Workweek** (drives all SLA math) | **Sun–Thu (5-day)**, Fri + Sat off | `WORK_DAYS` default → `0,1,2,3,4`; SLA test fixtures recomputed (roll to Sunday, not Saturday); `.env.example` updated | ✅ DONE (140 unit tests green) |
| D2 | **Temix credit-field direction** | **(a) the CRM pushes credit limit / terms TO Temix (outbound)** | Confirms the current outbound export behavior is **intended** — see D2-note | ✅ CONFIRMED; refutes a deep-review finding |
| D3 | **Cron infra** — move SLA-escalation + backup off GitHub Actions | OK to move | ⚠ Vercel Cron on **Hobby only allows daily** schedules; SLA-escalation runs several times/day → needs **Vercel Pro**, OR keep GitHub Actions with a 30-day "poke the repo" reminder (GH auto-disables after 60 idle days) | ⏳ owner: upgrade to Pro or accept GH-Actions reminder |
| D4 | **Real Temix header contract** | Owner will format the real export to the CRM's headers | Canonical header list provided (cust_code, cust_name, branch_code, sales_region, route, address, phone, contact_person, cr_no, payment_terms[CASH/CREDIT], credit_limit, payment_term_days, temix_code) | ✅ contract defined; closes the E2 CASH-default risk once the real file matches |
| D5 | **Vercel Preview-DB isolation** | (pending) | Add Preview-scoped `DATABASE_URL`/`DIRECT_URL` (isolated `uat-testing` branch) + a Preview test `R2_BUCKET`, so a Preview deploy never touches production | ⏳ owner: two env-var adds in Vercel |

## D2-note — an inconsistency the owner answer surfaces (verify, not blocking)

D2 says **credit limit/terms are CRM-owned and pushed TO Temix (outbound)**. This **refutes** the deep-review candidate finding "outbound pushes stale credit fields back into the ERP" — that push is now confirmed **by design**.

**However**, the code's **inbound Temix refresh** currently treats credit limit/terms as **Temix-authoritative** and overwrites the CRM's values on refresh (`services/imports.ts` refresh lane — "credit figures … authoritative FROM Temix"). If credit is genuinely **CRM-owned** (D2), then a refresh that runs after the CRM changed a credit limit but before Temix echoes it back would **revert** the CRM's newer value to Temix's older one.

**To confirm with the ERP team:** does Temix ever *modify* credit limit/terms, or is it a passive store of what the CRM sent? If passive (CRM is the sole source), the inbound refresh should **skip** credit fields (treat them as CRM-owned, not overwrite). This is a narrow edge (the round-trip is usually value-consistent) — flagged for correctness, not a launch blocker.

## Still open (owner)
- D3 (cron plan), D5 (Vercel Preview-DB vars), and secret rotation before go-live.
- The real Temix master file itself (for the actual data migration) — synthetic UAT cannot prove real-file compatibility (RK-10).
