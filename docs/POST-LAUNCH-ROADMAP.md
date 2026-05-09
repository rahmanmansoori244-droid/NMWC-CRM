# NMWC Customer Master — Post-launch enhancement roadmap

Sequenced from the brutal benchmark in `docs/BENCHMARK-REPORT.md`. Every item carries: *problem · why it matters · impact · difficulty · priority · gap-vs-market or differentiator · category*.

---

## Wave 1 — Must add now (pre full-scale launch)

### 1. Offline-first capture for Salesman edits

- **Problem:** salesman in market with poor 3G loses work on a tab refresh.
- **Why it matters:** the largest gap vs every market alternative — Salesforce CGC, SAP Sales Cloud, Zoho FSP all ship offline as table stakes.
- **Impact:** unlocks pilot in real network conditions; saves an estimated 15–30 min/salesman/day in retries.
- **Difficulty:** High (service worker + IndexedDB queue + sync conflict policy).
- **Priority:** 1.
- **Closes:** market gap.
- **Category:** field UX.

### 2. End-to-end test suite (Playwright) covering salesman submit → supervisor approve → reactivation → merge

- **Problem:** unit tests cover lib/services but not user journeys; the audit found Critical bugs the unit tests couldn't catch.
- **Why it matters:** prevents regression in the highest-blast-radius flows.
- **Impact:** gates every deploy; catches what the audit had to find by hand.
- **Difficulty:** Medium.
- **Priority:** 1.
- **Closes:** engineering maturity gap.
- **Category:** engineering / architecture.

### 3. Production observability: structured logging + traces + alerting

- **Problem:** today Sentry catches errors but there are no SLOs and no alerting on import failures or stale approval queue.
- **Why it matters:** failure modes will surface from users, not from dashboards.
- **Impact:** MTTD drops from days to minutes.
- **Difficulty:** Medium.
- **Priority:** 1.
- **Category:** security / reliability.

### 4. Approval SLA + email/Slack/WhatsApp notifications + escalation

- **Problem:** "stale > 3 days" exists as a query, but there's no notification, no escalation, no inbox for the supervisor. Approvals will rot quietly.
- **Why it matters:** the workflow's value collapses if approvals queue indefinitely.
- **Difficulty:** Medium (need email or push provider).
- **Priority:** 1.
- **Category:** product capabilities.

### 5. Arabic UI (RTL, translated strings) for salesman + supervisor surfaces

- **Problem:** not every NMWC field salesman is comfortable in English.
- **Why it matters:** adoption risk.
- **Difficulty:** Medium (`next-intl` or `react-intl` + content translation).
- **Priority:** 1.
- **Category:** field UX.

---

## Wave 2 — High-value next wave (within 90 days of pilot)

### 6. Visit object + GPS trail

- **Problem:** there's no "salesman visited this branch on this day" record beyond timestamped edits. Supervisors can't audit visit compliance.
- **Difficulty:** Medium.
- **Closes:** major gap vs every CPG field tool.
- **Category:** product capabilities.

### 7. Lightweight order/inventory capture during visit

- **Problem:** the same salesman who's enriching the master also takes orders today, in a separate notebook.
- **Why it matters:** unifying the field session is a step-change in field productivity.
- **Difficulty:** High (new domain model + order rules + optional ERP send).
- **Category:** product capabilities + integration.

### 8. Real ERP integration channel (signed webhook out + import endpoint in)

- **Problem:** exports are Excel, imports are Excel. Re-keying is the failure mode.
- **Difficulty:** Medium.
- **Closes:** the biggest "why are we paying for a custom thing if it doesn't talk to ERP" question.
- **Category:** engineering / integration.

### 9. Dashboard upgrade: trend lines + DQ score over time + region drill-down

- **Problem:** current dashboards show point-in-time KPIs, no trend, no benchmarking, no narrative.
- **Why it matters:** leadership won't trust v1 dashboards for steering decisions.
- **Difficulty:** Medium.
- **Category:** analytics / reporting.

### 10. Cooler / freezer asset object (not just `coolersCount` integer)

- **Problem:** coolers are NMWC's primary trade asset; they need serial numbers, photos, service tickets, depreciation, audit.
- **Difficulty:** Medium.
- **Closes:** major gap.
- **Category:** product capabilities.

### 11. Survey / audit module (planogram check, competitor presence, promo execution)

- **Difficulty:** Medium-High.
- **Closes:** perfect-store gap.
- **Category:** product capabilities.

---

## Wave 3 — Strategic differentiators

### 12. Image recognition for shop / signboard / CR validation

Trigger a 3rd-party OCR + vision pipeline on photo upload; flag suspicious matches for supervisor.
- **Differentiates:** automates Steward's manual visual review.
- **Difficulty:** High.

### 13. Anomaly detection on edit submissions

(salesman X submits 50 changes at 2 a.m. from outside Oman) — feed to Steward dashboard.
- **Differentiates:** governance edge over competitors.
- **Difficulty:** Medium.

### 14. MDG-grade lineage

Per-field history with impact view: "this phone changed 5 times in 60 days; here's who, when, why".
- **Difficulty:** Medium.
- **Closes a real MDM gap.**

---

## Wave 4 — Nice to have

15. SSO / SAML for parent-group tenants.
16. WhatsApp Business notifications to salesmen.
17. PWA install prompt + native-shell wrapper (Capacitor) — only after step 1 (offline) lands.
18. Self-serve password reset via SMS OTP.
19. Multi-region failover and backup drills.

---

## Group breakdown by category

- **Product capabilities:** 4, 6, 7, 10, 11, 13, 14
- **Field UX:** 1, 5, 17
- **Data quality / governance:** 12, 13, 14
- **Analytics / reporting:** 9
- **Security / reliability:** 3, 15, 16, 18, 19
- **Engineering / architecture:** 2, 8

---

## Sequencing logic

- **Wave 1 is non-negotiable before scale.** Without offline (1), without E2E (2), without observability (3), and without approval notifications (4), the platform will burn the team in the first month of real use.
- **Wave 2 closes the "are we still a master-data tool or a field-sales platform?" question.** Visit + order + ERP integration are the spine of a true DSD field-sales suite.
- **Wave 3 is where the custom path can credibly out-differentiate Salesforce CGC** — the AI/ML use of the photo+GPS evidence chain is genuinely interesting because we already have the captured data, just no inference layer.
- **Wave 4 is post-product-market-fit polish.** Don't touch until the first three waves are real.

## Re-evaluation gate at month 12

After 12 months of pilot + Wave 1 + Wave 2, re-run the benchmark scoring with hard production data:

- NPS / CSAT from salesmen and supervisors
- Approval queue depth + median time-to-decision
- ERP round-trip latency (custom → SAP/Oracle → custom)
- Error rate / SLO attainment
- Storage growth + R2 cost trajectory
- Master-data quality score trend

If the numbers say the custom path is sustainable: continue to Wave 3. If they don't: commit to a Zoho hybrid where Zoho takes the field-sales lifecycle and the custom app is reduced to a thin master-data governance layer feeding Zoho.
