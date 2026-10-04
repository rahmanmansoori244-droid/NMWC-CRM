# Create finalize and synthetic data

> 39 nodes · cohesion 0.08

## Key Concepts

- **create-finalize.ts** (28 connections) — `lib/create-finalize.ts`
- **synthetic.ts** (28 connections) — `prisma/synthetic.ts`
- **finalizeCreateInTx()** (13 connections) — `lib/create-finalize.ts`
- **photo-attach.ts** (10 connections) — `lib/photo-attach.ts`
- **seedCustomers()** (10 connections) — `prisma/synthetic.ts`
- **formatBranchCode()** (9 connections) — `lib/codes.ts`
- **formatCustomerCode()** (9 connections) — `lib/codes.ts`
- **applyCreateApproval final-step hook (create Customer and Branches, queue Temix upload)** (7 connections) — `docs/discovery/blueprint-inputs/approval-engine.md`
- **materializeCreateRequest final transaction** (7 connections) — `docs/discovery/blueprint-inputs/creation-flow.md`
- **F-UAT-8 code allocator bricks creation when CodeSequence counter lags** (6 connections) — `qa/findings/register.md`
- **[27/36] P3 NMWC code year taken from UTC, not Oman wall-clock** (5 connections) — `qa/findings/final-golive-hunt.md`
- **codes.ts** (5 connections) — `lib/codes.ts`
- **allocateCustomerCode()** (5 connections) — `lib/create-finalize.ts`
- **main()** (5 connections) — `prisma/synthetic.ts`
- **Cash chain step 1 walked live (Manager fallback for Supervisor step, R4)** (4 connections) — `qa/evidence/uat-live-run.md`
- **build-chain-data.test.ts** (4 connections) — `tests/integration/build-chain-data.test.ts`
- **[32] P3 UPDATE approve transaction uses default 5s timeout** (3 connections) — `qa/findings/final-golive-hunt.md`
- **omanYear()** (3 connections) — `lib/tz.ts`
- **branch()** (2 connections) — `tests/integration/build-chain-data.test.ts`
- **mkAtt()** (2 connections) — `tests/integration/build-chain-data.test.ts`
- **extraIds()** (2 connections) — `lib/create-finalize.ts`
- **TZ_OFFSET_MIN** (2 connections) — `lib/working-hours.ts`
- **clearSyntheticData()** (2 connections) — `prisma/synthetic.ts`
- **makeAttachment()** (2 connections) — `prisma/synthetic.ts`
- **pickShopName()** (2 connections) — `prisma/synthetic.ts`
- *... and 14 more nodes in this community*

## Relationships

- [[Photos and completeness scoring]] (14 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (6 shared connections)
- [[Edit submit and approval engine]] (5 shared connections)
- [[create-guards area]] (5 shared connections)
- [[Unified CRM blueprints]] (4 shared connections)
- [[Audit log writing]] (4 shared connections)
- [[Photo upload and R2]] (4 shared connections)
- [[New-customer creation and phones]] (4 shared connections)
- [[Account master import]] (3 shared connections)
- [[CR normalisation and row checks]] (3 shared connections)
- [[Import row fixing and promote]] (2 shared connections)
- [[Master-Plan Execution Record (2026-07-20 area]] (2 shared connections)

## Source Files

- `docs/discovery/blueprint-inputs/approval-engine.md`
- `docs/discovery/blueprint-inputs/creation-flow.md`
- `lib/codes.ts`
- `lib/create-finalize.ts`
- `lib/photo-attach.ts`
- `lib/tz.ts`
- `lib/working-hours.ts`
- `prisma/synthetic.ts`
- `qa/evidence/uat-live-run.md`
- `qa/findings/final-golive-hunt.md`
- `qa/findings/register.md`
- `qa/reports/FINAL-GOLIVE-VERDICT.md`
- `tests/integration/build-chain-data.test.ts`

## Audit Trail

- EXTRACTED: 181 (94%)
- INFERRED: 12 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*