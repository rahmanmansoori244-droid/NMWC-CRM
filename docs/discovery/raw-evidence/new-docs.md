# NMWC Customer Master (NEW) — Documentation-vs-Implementation Reconciliation

**Dimension:** Docs ↔ code reconciliation. Read-only discovery. System root: `C:\Users\abdulr\Desktop\NMWC-CRM`.
**Method:** Read `docs/*`, `docs/audit/*`, `prisma/schema.prisma`, `services/*`, `lib/*`, `app/*`; traced git history for the 4 named later commits.

---

## 1. INTENDED DESIGN (from specs) — CONFIRMED (read in docs)

- **Purpose:** Field-driven **edit-only** enrichment of a pre-loaded ~3,000-record customer master (ERP→Excel→app→Excel→ERP). New customer creation from the field is explicitly OUT of scope (`PRD-v0.1.md` §1, §2.3, line 22).
- **5 roles / RBAC** (`PRD` §3–4): SALESMAN (1:1 with Route), SUPERVISOR (approves his team), MANAGER (region-scoped admin + dashboards + user mgmt), STEWARD (import/dedupe/export, direct write), VIEWER (read-only). Enum matches (`schema.prisma:15-21`).
- **Workflow** (`PRD` §6–7): Salesman edits → `SUBMITTED` → Supervisor approve/reject → `APPROVED` applies to live master; reject → `NEEDS_CORRECTION` → resubmit. One open edit per customer locked (concurrency §7.3).
- **Stated business policies / SOP:** name+CR locked for **CREDIT** customers only (§4 matrix line 106-108); phone uniqueness **hard-blocked across parent customers** (§8.1 line 353); import-time duplicate detection with fuzzy-name + phone-collision (§9); closed-shop needs fresh photo evidence; **reactivation requires MANAGER approval** (§ Changelog O5); passwords **min 12 chars, bcrypt cost 12** (§8, §15); Customer 1→**many** Branches (§5.2); weighted completeness 0–100 (§10); no email — `/work` page instead (O6).

## 2. KNOWN AUDIT FINDINGS & CLAIMED REMEDIATION STATUS — CONFIRMED (docs)

- **QA-AUDIT-REPORT.md** (2026-05-09): independent adversarial audit, **63 findings** (5 Critical, 18 High, 22 Medium, 11 Low/Info).
- **REMEDIATION-REPORT.md**: claims **5/5 Critical + 18/18 High closed**, 11/22 Medium fixed inline, 38 unit tests, live-retested on `ab09b7a`. Pre-pilot blockers: apply migration, `DEMO_ACCOUNTS_DISABLED=true`, rotate admin pw.
- **NMWC-CM-FINAL-AUDIT-2026-05-10.md** (senior 5-expert audit): 25 bugs B-01..B-25. **CHANGELOG claims 22/25 fixed live**, B-06 partial (fonts/taps only), **B-06 full form rewrite + B-22 (`EditFieldChange` relational table) deferred post-pilot**.
- Later PROD-001..006, AUTH-09, EL-01, PHOTO-013/014, DB-01/02 all documented closed in CHANGELOG.

## 3. THE 4 NAMED LATER COMMITS — what changed & why (CONFIRMED via git show + code)

- **`7d0dcb1` P1+P2+P3** (2026-05-10): Owner audit found the senior-audit "missed" data-model reality. **P1.1** wiped synthetic data (Muscat-only). **P1.2** flattened Customer→Branch to **1:1** (3308=3308) via `scripts/flatten-customer-branches.ts`. **P1.3** dropped phone-unique index (`migrations/20260510160000_p1_drop_phone_unique/migration.sql`) + removed both `DUPLICATE_PHONE` throws in `services/edits.ts` (now soft `logger.info` at `edits.ts:324-338` submit, `:694-705` approve). **P1.4** rewrote `services/duplicates.ts`: dropped fuzzy-name + phone-only, kept CR-exact, added `EXACT_TRIPLE` (legalName+phoneNorm+regionId) — reasons now only `'CR' | 'EXACT_TRIPLE'` (`duplicates.ts:30,116-150`). **P2** steward filters + `SavedView` model (`schema.prisma:204-214`) + filtered xlsx (`services/customer-export.ts`). **P3/F1-F4** perf cache, btree on legalName, keep-warm cron, perf-probe.
- **`e156a2c`**: reference-data cache, `Customer_legalName_btree_idx` (`migrations/20260511000000_perf_btree_legalname`), GitHub keep-warm cron.
- **`c612c79` Lock legalName for all salesman edits** (2026-05-11): `lib/permissions.ts:70-80` — `isFieldLocked` now returns **true for `legalName` AND `nmwcCode` for ALL salesmen (any payment terms)**; crNumber still CREDIT-only. `services/edits.ts` splits the lock into two `isFieldLocked` calls; `collectMissingMandatory` gains `actorIsSalesman` to **skip locked fields from the "missing—cannot submit" blocker** (fixes CREDIT CR dead-end). 62/62 tests.
- **`61ddec1` Bulk credential reset** (2026-05-11): `scripts/bulk-reset-credentials.ts` — salesmen renamed `<route>-nmwc` / pw `[REDACTED-PILOT-PW]`; staff pw `[REDACTED-PILOT-PW]`; **`mustChangePassword=false` everywhere**; disables 13 demo accounts; bumps `sessionsRevokedAt`. Explicit owner-accepted weak-shared-password trade-off, flagged in OPERATIONS + PILOT-MUSCAT-CREDENTIALS.
- **Pilot seed `23cab7c` GT-MUSCAT**: direct DB seed `prisma/seed-muscat-pilot.ts` — MANAGER Abdullah, STEWARD Abdulrahman, SUPERVISOR Ahmed, 10 routes (C1,C4,C6,C7,C12,C13,C14,C15,MH01,MH02), 10 salesmen. Out-of-band because F-02 blocks STEWARD import-creating MANAGER/STEWARD by design.

## 4. DOC CLAIMS THAT CONTRADICT CURRENT CODE (file:line, confidence)

1. **[Confirmed] STALE REMEDIATION-REPORT — phone uniqueness reversed.** `REMEDIATION-REPORT.md:53` ("Approve re-checks duplicate phone... throws ConflictError, QA-014") and `:87` ("Partial unique index on Customer.primaryPhoneNorm... DB-level enforcement of phone uniqueness, QA-030") describe closed remediations that P1.3 **deliberately undid**. Code now allows dup phones: index dropped (`migrations/20260510160000...`), throws removed (`services/edits.ts:324-338, 694-705`). Report never updated (frozen 2026-05-09); only CHANGELOG v1.0.1 records the reversal.
2. **[Confirmed] PRD §8.1 phone uniqueness false.** `PRD-v0.1.md:353` "Phone uniqueness: hard-blocked across different parent customers... Enforced by partial unique constraint" — no longer true (see #1).
3. **[Confirmed] PRD §9 duplicate detection false.** `PRD:368-372` fuzzy trigram >0.85 + phone-collision hard block — both dropped; `services/duplicates.ts:53,183` explicitly removed them.
4. **[Confirmed] PRD §4 permission matrix false for Cash name edit.** `PRD:106` "Edit customer (Cash) — name, CR | Salesman ✅". Code: `lib/permissions.ts:77` locks `legalName` for **all** salesmen regardless of payment terms. Salesman can no longer edit legalName on Cash customers.
5. **[Confirmed] PRD §5.2 / §10 Customer→many Branches now 1:1.** `PRD:169` "Branch (one customer → many branches)", §10 "customer with 3 branches reports average". P1.2 flattened to 1:1; `services/duplicates.ts:61,137` now assumes `branches[0]` ("post-flatten there's exactly one"). Prisma schema still permits 1:N (`Branch[]`), so this is a **data-semantics** contradiction, not schema.
6. **[Confirmed] Password policy bypassed for live pilot.** PRD §8/§15 + code enforce min-12 (`services/users.ts:35 z.string().min(12)`; UI hints `CreateUserForm.tsx:118`, `ChangePasswordForm.tsx:67`). But `scripts/bulk-reset-credentials.ts:38-39` writes **8-char** shared passwords directly to DB and sets `mustChangePassword=false`, bypassing the app rule. Documented owner trade-off, but PRD §8 password rule no longer reflects the live system.
7. **[Confirmed] PRD §11 pages not implemented.** No `/add-branch`, `/customers/:id/branches/:branchId/edit`, `/reassignments`, `/forgot-password`, `/reset-password` under `app/` (verified by path search). Wrong-route data exists (`schema.prisma:367-368 isWrongRoute/newRouteId`) but no dedicated reassignments page; no self-service password reset (consistent with §3 shared-pw pilot decision, contradicts PRD §11 page inventory).
8. **[Possible] Completeness equipment rule stricter than PRD.** `PRD:400` "Equipment counts entered (any of 3 ≥ 0): 5" (always true). Code `lib/completeness.ts:66` grants the 5 pts only if **sum > 0**. Minor deviation; docs overstate ease of the point. Also `:47 (c.notes || c.paymentTerms)` — paymentTerms always set (default CASH), so that 5 pts is effectively always granted.

## 5. CONFIRMED MATCHES (doc == code)

- Reactivation MANAGER-only + region-scoped: `services/reactivations.ts:225 require([Role.MANAGER])`, RBAC-05-008 (matches PRD O5). [Confirmed]
- Duplicate merge STEWARD-only: `services/duplicates.ts:20-27` (matches PRD §4, RBAC-05-009). [Confirmed]
- Optimistic locking `version` on Customer/Branch (`schema.prisma:264,329`), audit enum granularity (B-03/04), soft-delete `deletedAt` on Attachment (UXI-008), durable `RateLimit` token bucket (QA-015) — all as documented. [Confirmed]
- Completeness weights (customer 40 / branch 60, band ≥80/≥50) match PRD §10 (`lib/completeness.ts`). [Confirmed]
- B-22 deferred confirmed: schema still `fieldChanges Json` (`schema.prisma:364`), no `EditFieldChange` table. [Confirmed]

## 6. SECURITY NOTE (redacted)

- **Weak shared pilot passwords committed to git.** `scripts/bulk-reset-credentials.ts:38-39` — `SALESMAN_PASSWORD = "123…"`, `STAFF_PASSWORD = "972…"` (plaintext, 8-char), also echoed in `docs/PILOT-MUSCAT-CREDENTIALS.md` and `docs/OPERATIONS.md`, and pilot seed `prisma/seed-muscat-pilot.ts` derives passwords from route codes. `mustChangePassword=false` disables the forced-rotation guard. **Remediation:** treat as pilot-only, rotate to strong unique per-user passwords + re-enable `mustChangePassword` before any non-pilot use; scrub literals from repo/docs. This is a documented owner-accepted trade-off, not an accidental leak — but it is a real weakening of the PRD §8/§15 security posture. No API keys/DB strings were exposed in the reviewed docs/scripts.

## 7. FACTS vs INFERENCE vs MISSING

- **CONFIRMED FACTS:** all §3–§6 code:line claims (read directly).
- **REASONABLE INFERENCES:** #7 pages "deferred" (absence in `app/`, not a doc statement of removal); export scope for Supervisor applied at query layer (`canExport` allows it, scope not re-verified here).
- **UNVERIFIED:** live Neon DB actual row counts / applied migrations (static repo only); whether REMEDIATION/PRD are intended as historical snapshots (they read as current-state and are cross-linked from CHANGELOG "How to read").
- **MISSING INFO:** no doc supersedes PRD §4/§8.1/§9 in place — the contradictions live only in CHANGELOG v1.0.1 narrative; PRD/REMEDIATION were never annotated as superseded. To verify runtime: query prod for a dup `primaryPhoneNorm`, attempt salesman legalName edit on a CASH customer, inspect `Customer_primaryPhoneNorm` indexes via `\d Customer`.
