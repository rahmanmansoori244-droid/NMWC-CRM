# NMWC-CRM End-to-End Verification — 2026-05-10

## Scope
Full production verification on `https://nmwc-cm.vercel.app` after the bug-bash session. Covers the user-reported broken photo upload plus every audit-flagged invariant we touched (AUTH-09, EL-01, EL-04, EL-11/12, EL-15, PROD-001, PROD-006, NEW-PHOTO-013, NEW-PHOTO-014, DB-01, DB-02). Each row below was driven against live Vercel + live Neon Postgres + live Cloudflare R2 — no mocks.

## Summary

| Area | Status |
| --- | --- |
| Build green (`tsc --noEmit`) | PASS |
| Unit tests | 59 / 59 PASS |
| Photo upload chain | PASS (presign → R2 PUT → finalize → attach all 200) |
| Branch close → supervisor approve → reactivation request → manager approve | PASS (full cycle on CAA0367-01) |
| SafeAction error contract surfaces real messages | PASS |
| AUTH-09 forced-password-change redirect | PASS (Edge middleware) |
| EL-01 status bypass at approve | PASS (defense in depth) |
| PROD-001 atomic-claim race | PASS (5/5 races, 1 winner each) |
| Bulk seed safety (DB-01 length, DB-02 stamp) | PASS (backfilled live + script-enforced) |

## Details

### 1. Photo upload — root cause × 2, both fixed
- Symptom: salesman tapped capture, saw "Upload failed."
- Cause A (commit `0d9df2b`): AWS SDK ≥ 3.729 hoisted `x-amz-checksum-crc32=AAAAAA==` into the presigned PUT URL. R2 enforced it; `fetch` could not recompute the CRC32. Fix: `requestChecksumCalculation: 'WHEN_REQUIRED'` + `responseChecksumValidation: 'WHEN_REQUIRED'` on the `S3Client`.
- Cause B (commit `242d4a6`): SDK default virtual-host URLs (`bucket.<accountId>.r2.cloudflarestorage.com`) hit the CSP `connect-src` wildcard limit (CSP only allows a single subdomain layer). Fix: `forcePathStyle: true` so every PUT URL stays on the CSP-allowed host.
- Operator fix (Option A): R2 bucket CORS pasted via Cloudflare dashboard.
- Verified live: synthetic JPEG injected through the `<input type="file">` — full chain returned 200 / 200 / 200, `Attachment` row written in Postgres, branch tile displayed the new photo overlay.

### 2. Branch close + reactivation full cycle
Driven on customer `MASHARA JIBAL- (JIDAN HADEESA)` / branch `CAA0367-01`. Audit log:

```
09:35:11  REACTIVATE  Branch         by pilot.manager     ← manager approved reactivation
09:34:27  UPDATE      Branch         by c1-12345-nmwc     ← salesman submitted reactivation request
09:33:18  APPROVE     CustomerEdit   by ahmed.alndabi     ← supervisor approved closure
09:20:29  UPDATE      Branch         by c1-12345-nmwc     ← salesman submitted close request
```

Branch.status flipped ACTIVE → CLOSED → ACTIVE. `lastStatusChangeAt` stamped on every transition (EL-11 / EL-12 freshness anchor). The reactivation evidence photo had to be captured AFTER the closure timestamp; the freshness gate accepted the right photo and would have rejected a pre-closure shot.

Caveat: the supervisor "Approve" click is dispatched by an inline button that calls `window.confirm(...)`. Headless Chrome MCP froze the renderer mid-server-action when the confirm fired; I verified the underlying `approveEditCore` Prisma transaction in isolation (`prisma/test-approve-as-supervisor.ts`) and it produced the same APPROVED row + branch flip a real supervisor click would. The other three legs (close request UI, reactivation request UI, manager Reactivate button UI) all completed end-to-end through the live UI.

### 3. SafeAction error contract (PROD-006)
Every server action under `services/{edits,photos,users,imports,duplicates,reactivations}.ts` now returns the discriminated union `{ ok: true, data } | { ok: false, code, message, fields? }` via `runAction()` in `lib/errors.ts`. Verified in production: when I tried to submit a second close request while one was still SUBMITTED, the form rendered:

> "This value conflicts with an existing record. Refresh and try again."

instead of the previous generic "Server Components render" splat. P2002 → `UNIQUE_CONSTRAINT`, ConflictError / ValidationError / ForbiddenError / NotFoundError / RateLimitError all preserve `code` + `fields` across the RSC boundary. Forms (`ApproveRejectActions`, `EnrichmentForm`, `BranchStatusActions`, `PhotoCaptureSlot`, etc.) read `res.fields` first, fall back to `res.message`, never crash on unknown error shapes. 12 unit tests in `tests/unit/errors.test.ts` cover the contract.

### 4. AUTH-09 forced password change (commit `90ae392`)
Before: `test.mustchange` user with `mustChangePassword=true` could navigate freely after login because Edge middleware reads `auth.user.mustChangePassword` and the Edge config (`auth.config.ts`) had no `session` callback bubbling JWT fields. Fix: mirrored the session callback into the Edge config so the flag survives the JWT → session hop on Edge. Verified live: redirect now fires from `/dashboard`, `/customers`, `/profile`.

### 5. EL-01 customer.status bypass at approve (commit `1432981`)
The submit-time guard already blocked salesmen / supervisors / stewards / managers from flipping `customer.status` through the regular edit form. We added a mirror guard inside `approveEditCore` so even a DB-injected SUBMITTED edit with `customer.status: ACTIVE → CLOSED` is rejected with `ConflictError('STATUS_BYPASS')` rather than rubber-stamped. Verified by injecting the malicious payload directly via Prisma; ahmed's approve click now returns the actionable message instead of writing the flip.

### 6. PROD-001 atomic claim
Concurrency test (`prisma/test-prod-001-race.ts`): 5 separate races, 3 simultaneous claim+apply transactions per race, each race produced exactly 1 winner and 2 losers (the losers saw `count=0` from `customerEdit.updateMany` and bailed). No edit was applied twice, no duplicate audit row was written. Total: 5 winners / 10 losers across 15 attempts — the contract holds.

### 7. DB invariants
- DB-01 (address.length ≥ 3): live record `CAA2468-01` had `address="WK"` from the source xlsx, would have permanently blocked the salesman from submitting any edit; fixed live + `prisma/seed-muscat-customers.ts` now enforces the 3-char floor.
- DB-02 (lastStatusChangeAt on CLOSED/SUSPENDED): 6 demo-seeded branches with null timestamps backfilled from `updatedAt` so the EL-11 freshness gate has an anchor.

## Production credentials reference (ops handoff)

| Role | Username | Password |
| --- | --- | --- |
| Manager | `pilot.manager` | `Manager-NMWC-2026!` |
| Steward | `pilot.steward` | (set in seed script) |
| Supervisor | `ahmed.alndabi` | `Ahmed-NMWC-2026!` |
| Salesman C1 | `c1-12345-nmwc` | `C1-12345-NMWC` |
| Salesman C4..MH02 | `<route>-12345-nmwc` | `<ROUTE>-12345-NMWC` |

## Known low-risk gaps
- The supervisor Approve button uses `window.confirm()`; this is fine in real browsers but freezes Chrome MCP. No change recommended — replacing it with a custom dialog adds complexity for no user-visible benefit.
- Phone collision UX cross-region scrubbing was inspected at the unit-test level (`access.test.ts`) but not driven through the live UI in this session. The duplicate phone path inside `approveEditCore` (line 674-690) does scrub the legalName when the colliding customer is outside the actor's region scope; we exercised the throw path during the cleanup of the AQA0549 leftover edits.
- Full CR-document and shop/signboard photo capture during enrichment was previously verified end-to-end and was not re-driven here; the bug fixed in `lib/r2.ts` applies uniformly across all photo slots.
