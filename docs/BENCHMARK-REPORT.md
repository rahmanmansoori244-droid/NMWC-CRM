# NMWC Customer Master — Brutal Benchmark vs the Market

**Date:** 2026-05-09
**Scope of evidence:** the entire codebase as of commit `2a1297e`, 7 audit reports (`docs/audit/01..07`), the load test (`tests/loadtest.mjs`), the live deployment at `https://nmwc-cm.vercel.app`, the PRD/UX/Tech specs, and the post-launch fix campaign.

---

## 1. Executive summary

**Overall verdict.** This is a **focused custom MDM tool for a single use case** — cleaning up and stewarding a beverage distributor's customer master via field salesmen — that does its narrow job credibly after the audit fixes. It is not a CRM. It is not a sales-automation platform. It is not a retail-execution platform. Calling it "our CRM" misframes it; calling it "our field-sales master-data system" frames it correctly.

**Overall benchmark rating:** **63 / 100** — Solid v1 of a niche custom product. Below the named SaaS giants in functional breadth and field-app maturity; competitive with or ahead of them on *tight fit to the cleanup workflow* and on *governance discipline for that workflow*. Far behind on the things mature CPG field-sales platforms own (offline, orders, promotions, journey planning, native mobile, surveys, integration).

**Where the product is below market:** offline operation, native mobile, order/visit capture, journey planning, retail-execution (perfect-store), executive-grade analytics, ERP integration, observability/SRE.

**Where the product is at market:** RBAC and audit, photo+GPS evidence chain, supervisor approval workflow, mandatory-field gate at submit + approve time (this last one is actually *tighter* than most enterprise tools).

**Where the product is above market for its scope:** the field→supervisor→manager edit-and-approve loop is built around master-data correctness rather than around opportunity/order management — most CRMs treat the master as a backdrop, not the workload. Combined with the partial-unique constraints and the just-shipped photo replay/staleness guards, the *governance fidelity* on this narrow surface is real.

### Top 3 strengths

1. **Tight workflow fit for the mission**: route ownership → branch-level enrichment → supervisor approval → reactivation → merge → audit. Every screen exists for a reason.
2. **Governance discipline post-fix**: mandatory-field gate runs at submit *and* re-runs at approve; partial unique index for one-open-edit-per-customer; lastStatusChangeAt ties reactivation evidence to the closure event; sessionsRevokedAt makes JWT revocation deterministic. These are *better* than the same controls in most CRMs.
3. **Cost structure**: $0 license cost. ~$50–150/month infrastructure (Vercel + Neon + R2). For a 50-user pilot, the SaaS alternatives cost 50×–500× more.

### Top 3 weaknesses

1. **No offline mode.** Salesmen in market locations with bad cell signal cannot work disconnected. Every market-leading field tool — Salesforce CGC, SAP Sales Cloud, Zoho Field Service — has offline capture as table stakes.
2. **Master-data only, no transactional layer.** Cannot capture orders, returns, promotion redemptions, survey/audit responses, asset (cooler/freezer) tracking. The day NMWC asks "can the salesman take an order on the same visit?" the answer is *no*.
3. **Engineering maturity below where the spec implies.** The audit found 6 Critical + 34 High *post* a remediation report that claimed Critical+High closed. That gap between claimed and actual is the real risk. Now patched — but the rate of finding tells you what the testing surface is missing (E2E coverage, integration tests, real load testing, formal review).

### Top 3 immediate enhancements

1. Offline-first capture for Salesman edits (service worker + IndexedDB queue + sync).
2. Real ERP integration channel (signed webhook or NDJSON push to SAP/Oracle/whatever NMWC runs).
3. SLO/observability layer: real-user metrics, error budgets, alerting on the approval-pending queue depth and on import failures.

---

## 2. Benchmark matrix

Scores are 0–10 by category. "NMWC" is the product under test post-hardening.

| Dimension | NMWC | SF CG Cloud | Dynamics 365 Sales | SAP SC V2 | Oracle Sales | Zoho CRM (+FSP) | Odoo |
|---|---|---|---|---|---|---|---|
| FMCG retail-execution fit | 4 | **9** | 4 | 6 | 4 | 5 | 5 |
| Customer master / MDM | **7.5** | 7 | 6 | 8 | 6 | 5 | 6 |
| Field-mobile UX | 5 | **9** | 7 | 7 | 6 | 7 | 6 |
| Offline / poor-network | 1 | **9** | 7 | 7 | 6 | 7 | 5 |
| Approval & governance | **8** | 8 | 7 | 8 | 7 | 6 | 6 |
| Duplicates / data quality | 7 | 7 | 6 | **8** | 6 | 5 | 5 |
| Reporting / analytics | 5 | 8 | **9** | 8 | 8 | 7 | 6 |
| Integration readiness | 3 | 8 | **9** | **9** | 8 | 7 | 8 |
| Security & compliance | 6.5 | **9** | 9 | 9 | 9 | 7 | 6 |
| Performance & resilience | 5 | **9** | 9 | 8 | 8 | 7 | 6 |
| Product polish | 6 | 8 | **9** | 7 | 7 | 7 | 6 |
| Implementation cost / time | **9** | 3 | 4 | 3 | 4 | 7 | 7 |
| 5-year TCO for 50 users | **9** | 2 | 4 | 3 | 3 | 7 | 7 |
| Vendor lock-in risk | **9** (zero) | 4 | 5 | 3 | 4 | 6 | 7 |
| Customisation fit | **10** | 6 | 7 | 6 | 6 | 7 | 8 |

### Weighted score against prompt's weights

| Dimension | Weight | NMWC raw | Contribution |
|---|---|---|---|
| Strategic fit for NMWC | 20% | 8.0 | 1.60 |
| Functional depth | 20% | 5.0 | 1.00 |
| Field-sales usability | 15% | 5.0 | 0.75 |
| Data governance / MDM | 15% | 7.5 | 1.125 |
| Architecture / extensibility | 10% | 6.5 | 0.65 |
| Security / operational maturity | 10% | 6.5 | 0.65 |
| Performance / resilience | 5% | 5.0 | 0.25 |
| Product polish | 5% | 6.0 | 0.30 |
| **Total** | 100% |  | **6.325 / 10 ⇒ 63 / 100** |

**Maturity label:** *Strong v1 / solid niche product*. Materially above MVP; well below enterprise-grade leader.

---

## 3. Direct competitor analysis

### Salesforce Consumer Goods Cloud / Retail Execution

- **Strong at:** Visit planning + journey optimisation; pre-selling and van-selling; perfect-store framework with image-recognition partners (Trax, ParallelDots); trade-promotion management; cooler/freezer asset tracking; survey/audit framework; full offline mobile (iOS/Android native); a CPG-specific data model (Account, Outlet, Visit, Survey, Promotion, Asset, KPI).
- **Better than NMWC:** Almost every "field-sales as a job" surface NMWC doesn't have — offline, native, orders, promotions, surveys, route optimisation, asset tracking, image recognition, executive analytics. Better integration: Mulesoft, native ERP connectors, OAuth APIs.
- **Where NMWC may actually be better:** Tight fit to the master-data cleanup mission. CGC's data model is generic; NMWC's app encodes Oman specifics directly. Replicating in CGC needs months of declarative configuration plus probably an Apex trigger or two for the field-lock and the multi-branch scope. The mandatory-fields-at-approve gate is *non-trivial* to replicate in CGC's standard approval objects.
- **Overkill / wrong fit:** $150–$250 per user per month + Sales Cloud underneath. Implementation 6–12 months, $200K–$1M. For 50 users that's $90K–$150K/year + 6-figure implementation. Master-data-only buy doesn't pencil.
- **Verdict:** Realistic replacement *only* if NMWC commits to running its full field-sales operation on Salesforce. As a master-data-only buy it's the wrong tool.

### Microsoft Dynamics 365 Sales

- **Strong at:** Lead/opportunity/quote/order pipeline, Office 365 + Teams integration, Power Platform extensions, Copilot.
- **Better than NMWC:** Pipeline reporting, Power BI dashboards, offline-capable Sales Mobile app. Power Apps lets you ship a custom canvas app on top of the same data.
- **Where NMWC may be better:** Dynamics is built around the opportunity-to-cash B2B sale, not master-data stewardship. Supervisor-approval-of-master-data-edit is doable in Power Apps + Power Automate but not native.
- **Overkill / wrong fit:** No native CPG retail execution. License $65–$95/user/month + Field Service add-on ~$50/user/month + Power Apps premium connectors.
- **Verdict:** Partial benchmark, not a realistic replacement. Reasonable if NMWC's parent group already standardises on Microsoft.

### SAP Sales Cloud V2

- **Strong at:** Sales planning, territory management, opportunity, deep ties to S/4HANA / SAP MDG.
- **Better than NMWC:** Direct integration with SAP S/4HANA Customer master, Business Partner objects, SAP MDG (Master Data Governance) for stewardship — this is real MDM with golden-record management, lineage and stewardship workflows.
- **Where NMWC may be better:** If NMWC isn't on SAP ERP, you're carrying a Ferrari engine without the chassis. Implementation is enormous.
- **Overkill:** Cost (enterprise-tier), implementation length (9–18 months), license fees per user.
- **Verdict:** Realistic only if SAP is the ERP. Otherwise, not a fit.

### Oracle Sales (Fusion)

- **Strong at:** Account/contact/opportunity, integration with Oracle ERP/EPM, AI-assisted forecasting.
- **Better than NMWC:** ERP integration (if Oracle), forecasting, analytics. Stronger at standard B2B sales motion.
- **Where NMWC is better:** Oracle Sales is even less FMCG-retail-oriented than Dynamics; their CPG presence is thin.
- **Verdict:** Not a good fit. Outside SAP and Salesforce, the CPG/DSD vertical doesn't have a strong Oracle answer.

### Zoho CRM (+ Zoho FSM / Field Service Plus)

- **Strong at:** Affordable ($14–$52/user/month), customisable via Deluge scripting and Canvas builder, has Field Service Plus (~$25/user/month) for mobile field workforce. Reasonable mobile app with offline. Multi-app suite.
- **Better than NMWC:** Mobile app maturity (offline, push, native camera). Pre-built reporting (Zoho Analytics). Public REST APIs and webhooks.
- **Where NMWC is better:** Custom data model fidelity. Zoho CRM is built around Leads/Deals/Contacts/Accounts; bending it to NMWC's Customer→Branch→Route hierarchy with field-locks and partial-unique constraints is doable but ugly. Mandatory-fields-on-approve gate is awkward to express in Blueprint.
- **Overkill / wrong fit:** Less so than the giants — Zoho is the best price-fit for a 50-user FMCG operation. Real risk: capability ceiling for true CPG-vertical needs (perfect store, planogram, image recognition).
- **Verdict:** Most realistic SaaS alternative for NMWC's budget. Tradeoff: custom data model and approval discipline get watered down.

### Odoo

- **Strong at:** Modular open-source ERP-CRM-Sales-Inventory-Accounting suite. Self-hostable. Highly customisable in Python. €24–€39/user/month Enterprise.
- **Better than NMWC:** Built-in inventory + accounting + sales pipeline + invoicing in one suite.
- **Where NMWC is better:** Odoo's CRM is generic; field-data-collection UX is functional but unremarkable. Custom approval workflows are painful in Python overrides. MDM features are shallow.
- **Verdict:** Realistic alternative *if* the strategy is "replace the ERP too". Otherwise, not the right tool.

---

## 4. Best-practice gap analysis

| Capability | NMWC status | Gap impact |
|---|---|---|
| Offline-first capture with conflict resolution on sync | ❌ | Critical — biggest market gap |
| Native mobile or PWA + service worker + IndexedDB queue | ⚠️ Responsive PWA only, no SW | Salesmen lose work on tab close, no push |
| Journey planning + route optimisation | ❌ | Manual planning, no compliance KPI |
| Order capture during visit | ❌ | Master-data only, no commercial value |
| Visit logging with start/end + GPS trail | ⚠️ Per-action capturedAt only | "Did salesman X visit shop Y?" unanswerable |
| Survey / audit framework | ❌ | No promo-compliance, competitor presence |
| Image recognition / AI for shelf, signboard, planogram | ❌ | Trax/ParallelDots/Klisha integrations expected |
| Mandatory-field gate at submit + approve | ✅ Better than most CRMs | Strength |
| Photo evidence chain (capturedAt > lastStatusChangeAt) | ✅ Better than market | Strength |
| Audit trail with diffs, not counts | ✅ Now implemented | Strength |
| Region-scoped Manager separation of duty | ✅ Implemented | Strength |
| Public API (REST/GraphQL) + webhooks | ❌ Server Actions only | Blocks ERP integration |
| SCIM / SSO | ❌ | Fine for 50 users; problem at 500 |
| Forced first-login password change + MFA | ⚠️ First-login change yes, MFA no | MFA is industry table stakes |
| Offline conflict-free CRDT or last-write-wins with replay | ❌ | Will burn anyone who tries to add offline later |
| SLO dashboard / error budget | ❌ Sentry only | Won't know what "broken" means until users complain |
| Real-time GPS trail of salesmen | ❌ | DSD industry-standard |
| Cooler/freezer asset tracking | ❌ | NMWC's primary trade asset |
| Promotion / trade-promo / chargeback | ❌ | Out of scope for v1 |
| Approver SLA tracking + escalation | ⚠️ "Stale > 3 days" but no escalation | Approvals will rot |
| Multi-language UI (Arabic RTL) | ❌ | Real Oman gap |
| Data lineage view per field | ⚠️ AuditLog yes, no UI to visualise | Compliance gap |
| Golden-record management | ⚠️ Merge ships, no continuous candidate stream | Will fall behind as data drifts |
| Bulk DQ scoring / dashboards | ⚠️ Per-record only, no aggregated trends | "Is data quality improving?" unanswerable |
| Production observability (RUM, traces, alerts) | ⚠️ Sentry only | Failures surface late |
| E2E test coverage (Playwright) | ❌ Unit tests only | Every release ships on hope |
| Feature flags / staged rollout | ❌ | Single-environment risk |
| Backup / restore drills | ❌ | Business continuity gap |

**Strengths that exceed market for the niche:**
- Approval-time mandatory-field re-validation (most CRMs gate at submit only)
- Photo-vs-status-change-time freshness anchoring
- Atomic edit-claim on approval (prevents duplicate-decision races)
- Region-scoped manager separation of duty with self-approval block
- Soft-delete via real `deletedAt` columns (post-fix)

---

## 5. Product maturity rating

**Strong v1 / solid niche product.**

- **Above MVP** — working approval workflow, working duplicate-merge flow, working reactivation flow, real audit, real RBAC. None stubbed.
- **Below "very strong"** — no offline, no integration, no analytics depth, no E2E tests, no SLOs, no Arabic, no native app.
- **Recent audit revealed real holes** — 6 Critical + 34 High found *after* the previous remediation said "all closed". That's a maturity signal: testing surface too narrow. Now closed → credible v1, not mature production.

---

## 6. Build vs buy recommendation

**Recommendation: continue custom build with major upgrades.** Specifically *not* "replace with SaaS" and *not* "extend custom forever".

### Commercial justification

- 50 users × Salesforce CGC at ~$200/user/month = $120K/year + $300K implementation. 5-year TCO ≈ $900K–$1.2M.
- 50 users × Zoho CRM Enterprise + FSP at ~$70/user/month = $42K/year + ~$50K implementation. 5-year TCO ≈ $260K. Real alternative if budget is the only filter.
- Current custom: ~$1.5K/year infra + roughly 0.5 FTE engineering for the next 12 months ($60–$100K). 5-year TCO ≈ $200–$350K.

### Technical justification

- Custom data model already encodes Oman-specific semantics (channel taxonomy, paymentTerms field-lock, single-route ownership, GPS bounding box, Asia/Muscat day-of-visit).
- Post-audit governance posture is genuinely tighter than off-the-shelf tools provide out of the box.
- Biggest technical risks are *exactly* the categories where SaaS tools shine (offline mobile, integration, analytics).

### Operational justification

- 50 users on a 2–3 month pilot is fine on the current platform if Wave 1 lands.
- Going to 200+ users without observability and without E2E tests is asking for a 3 a.m. incident with no instrumentation.
- The "claimed-fixed-but-not" pattern in the prior remediation report tells you the operational discipline isn't yet at the level the platform claims.

### Hybrid option to consider

If NMWC commits to *full field-sales operations*, evaluate **Zoho One + a custom thin master-data layer**. Zoho gives the ERP-adjacent surfaces and a real mobile/offline app; the custom app keeps the governance discipline already built. Cheapest credible path to a complete field-sales platform.

---

## 7. Final verdict

**A. Overall score:** **63 / 100**

**B. Product maturity label:** *Strong v1 / solid niche product*

**C. Compared with the market, this solution is:** competitive for its niche (master-data cleanup with field-driven enrichment); below market on the surrounding field-sales lifecycle; clearly behind on offline operation and engineering maturity.

**D. Best competitor benchmark:** **Salesforce Consumer Goods Cloud** (functional parity for what NMWC will eventually need). **Zoho CRM + Field Service Plus** is the most realistic *commercial* benchmark for NMWC's scale and budget.

**E. Biggest competitive advantages:**

1. Fit-for-purpose data model that encodes Oman/NMWC specifics directly.
2. Approval-time mandatory-field re-validation and photo evidence chain *tighter* than off-the-shelf CRMs.
3. Region-scoped Manager separation of duty with self-approval block — non-trivial to replicate.
4. Cost: 50× to 500× cheaper than the enterprise alternatives at this scale.
5. Zero vendor lock-in.

**F. Biggest competitive weaknesses:**

1. **No offline mode.** Disqualifying for serious field deployment in spotty-coverage areas.
2. **Master-data only.** No orders, no surveys, no promotions, no journey, no asset tracking.
3. **Integration-poor.** Server Actions everywhere is great UX, but ERP integration is Excel-only today.
4. **Engineering maturity below the spec implies.** No E2E tests, no SLOs, no production observability beyond Sentry.
5. **Analytics + Arabic + native mobile** all missing.

**G. Recommended decision:** **Continue custom build with major upgrades.** Ship Wave 1 (offline, E2E, observability, SLA notifications, Arabic) before declaring v1 production-ready; ship Wave 2 (visit + order + ERP integration + dashboards + assets + survey) within 90 days of pilot, or commit to a Zoho hybrid by month 3. Re-evaluate at month 12 with hard data (NPS, queue depth, ERP round-trip time, error rate).

**H. Top 10 enhancements in priority order** (full detail in `docs/POST-LAUNCH-ROADMAP.md`):

1. Offline-first salesman capture (service worker + IndexedDB sync queue).
2. Playwright E2E coverage of submit→approve→reactivate→merge.
3. Production observability: traces, RUM, alerts on queue depth and error rate.
4. Approval SLA + email/Slack/WhatsApp notifications + escalation.
5. Arabic UI (RTL, translated strings) for salesman + supervisor surfaces.
6. Visit object + GPS trail per visit (the missing transactional spine).
7. Real ERP integration channel (signed webhook + REST endpoint) — kill Excel re-keying.
8. Order capture during visit (lightweight) — unify the field session.
9. Dashboard upgrade: DQ trend lines + region drill-down + executive narrative.
10. Cooler/freezer asset object with photos, serial, service tickets.

---

The bluntest version: this is a *good v1 of the wrong thing if NMWC's eventual goal is field-sales*; this is a *very good v1 of the right thing if NMWC's goal is just master-data cleanup*. The roadmap above tells you exactly how to make it the right thing for both.
