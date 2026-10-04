# Final pre-go-live adversarial bug hunt ( area

> 24 nodes · cohesion 0.13

## Key Concepts

- **Final pre-go-live adversarial bug hunt (2026-07-21)** (33 connections) — `qa/findings/final-golive-hunt.md`
- **FINAL go-live verdict (2026-07-21)** (15 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **[7/15] P2 RK-2 CREATE scope drift: frozen draft region vs current route region** (8 connections) — `qa/findings/final-golive-hunt.md`
- **[17] P2 Manager direct-write can tamper an out-of-region branch** (7 connections) — `qa/findings/final-golive-hunt.md`
- **[4/6/9/19] Non-refresh re-import overwrites CRM-owned fields and flips CREDIT to CASH** (7 connections) — `qa/findings/final-golive-hunt.md`
- **Owner actions before go-live (rotate DB owner role, RK-3, D2, Vercel Pro, real Temix master, seed password rotation)** (7 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **[3] P1 paymentTerms CASH/CREDIT flip via UPDATE edit bypasses the credit chain** (6 connections) — `qa/findings/final-golive-hunt.md`
- **[14] P2 Re-import upsert bypasses the B-05 optimistic lock** (5 connections) — `qa/findings/final-golive-hunt.md`
- **B-05 optimistic lock (Customer.version)** (4 connections) — `qa/findings/final-golive-hunt.md`
- **[23] P3 Promote can strand a batch in PROMOTING (UNASSIGNED create race)** (4 connections) — `qa/findings/final-golive-hunt.md`
- **[31] P3 Merge moves all loser edits and violates open_per_customer** (4 connections) — `qa/findings/final-golive-hunt.md`
- **Presence-aware non-refresh update mirroring the refresh lane** (4 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **[18] P2 GUARANTEE credit documents browser-cacheable for 60s** (3 connections) — `qa/findings/final-golive-hunt.md`
- **#16 P2 CREATE wedges at Accountant step after mid-chain route re-region** (3 connections) — `qa/findings/pre-launch-deep-review.md`
- **#7 P2 Legacy re-import overwrites CRM-enriched fields, defaults CASH, bypasses B-05** (3 connections) — `qa/findings/pre-launch-deep-review.md`
- **CREATE visibility resolves current route.regionId (RK-2 fix)** (3 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **Per-branch managedRegionIds guard for Manager direct-write** (3 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **Merge auto-rejects the loser's SUBMITTED edit before reparenting** (3 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **Edit flow rejects any paymentTerms change** (3 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **Promote releases batch to FAILED on abort** (3 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **[34] P3 Completeness notes dimension is dead (paymentTerms always truthy)** (2 connections) — `qa/findings/final-golive-hunt.md`
- **Recommendation: GO for a supervised pilot** (2 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **no-store extended to all confidential attachment kinds** (2 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- **Definitive hunt: 137 agents, 2 rounds x 9 lenses x 3-lens verify plus critics (37 confirmed)** (1 connections) — `qa/findings/final-golive-hunt.md`

## Relationships

- [[Photos and completeness scoring]] (9 shared connections)
- [[Create finalize and synthetic data]] (6 shared connections)
- [[Edit submit and approval engine]] (5 shared connections)
- [[Permissions and user administration]] (5 shared connections)
- [[route area]] (4 shared connections)
- [[Import row fixing and promote]] (4 shared connections)
- [[Audit immutability tests]] (4 shared connections)
- [[Auth and page scope loading]] (3 shared connections)
- [[NMWC go-live import templates README area]] (3 shared connections)
- [[Duplicates, archive and Temix codes]] (3 shared connections)
- [[Pre-launch review (July)]] (3 shared connections)
- [[reactivations area]] (2 shared connections)

## Source Files

- `qa/findings/final-golive-hunt.md`
- `qa/findings/pre-launch-deep-review.md`
- `qa/reports/FINAL-GOLIVE-VERDICT.md`

## Audit Trail

- EXTRACTED: 124 (92%)
- INFERRED: 11 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*