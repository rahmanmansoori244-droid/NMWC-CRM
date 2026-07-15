# Section F — Cross-Cutting Feature Comparison Matrix: OLD vs NEW

**OLD** = ICO Customer Portal — `C:\Users\abdulr\Desktop\ICO\customer-portal` — Next.js 14.2.5, NextAuth 4, Prisma 5.16 (schema=postgres, env=sqlite MISMATCH), workflow/approval **request tracker** that never writes the customer of record.
**NEW** = NMWC Customer Master — `C:\Users\abdulr\Desktop\NMWC-CRM` — Next.js 15 / React 19, Auth.js v5 beta, Prisma 6 / Neon Postgres, R2, Sentry+pino. Field **edit-only enrichment** of a pre-loaded ~3,000-row master; the app IS the system of record for master data (writes `Customer`/`Branch` directly on approve).

**Assessment mode:** read-only discovery; synthesized from per-system agent findings + two confirmatory spot-checks (OLD POST-only cron; NEW rate-limiter always-grants). Confidence tags: [Confirmed]=read in code, [Highly likely], [Possible], [Unknown]. Paths are relative to each system root.

**CRITICAL FRAMING — the two systems are NOT the same product.** OLD is a *new-customer registration + update-approval workflow* that records that a human will create the record in the external Temix ERP + RoutePro (no CustomerMaster write-back — `old-functional.md` §4 "CRITICAL FINDING", grep of `customerMaster.(create|update|upsert)` = upload+seed only) [Confirmed]. NEW is a *master-data cleanup/enrichment* tool with **no manual customer-creation path at all** (`services/imports.ts` promote is the only creator; `prisma.customer.create` appears only in seed/migration — `new-functional.md` J2) [Confirmed]. A unified NMWC CRM needs BOTH capabilities; neither system alone covers the full lifecycle. Feature "strength" below is judged against that unified target.

---

## F.0 Verdict legend
- **only-OLD / only-NEW** — capability exists in just one.
- **both-consistent** — present in both, materially equivalent.
- **both-different-impl** — both solve it, but via different models (migration/consolidation must pick one).
- **both-conflict** — both present but with contradictory business semantics that cannot silently coexist.
- **both-one-clearly-stronger** — both present, one is decisively better (named + justified).
- **missing-both** — neither has it (gap for the unified target).

---

## F.1 MASTER MATRIX (one row per feature)

| # | Feature | Verdict | Stronger | One-line justification (evidence) |
|---|---|---|---|---|
| 1 | User management | both-one-clearly-stronger | **NEW** | NEW has in-app CRUD + peer-tier protection + last-Manager guard + reuse history (`services/users.ts`, `permissions.ts:152-172`); OLD admin-only CRUD + bulk CSV but `role` is unconstrained `String`, no peer protection (`admin/users`, `schema.prisma:55`). |
| 2 | Authentication | both-one-clearly-stronger | **NEW** | Both NextAuth Credentials+JWT+bcrypt-12. NEW adds 5-min JWT freshness re-read, `sessionsRevokedAt` hard-revoke, constant-time dummy-hash, `__Secure-` cookies, entropy-asserted secret (`lib/auth.ts:148-218`). OLD checks `isActive` only at login → up to 8h stale sessions (`old-security.md` J-H1) [Confirmed]. |
| 3 | Authorization / RBAC | both-one-clearly-stronger | **NEW** | Both centralize authz. NEW: region/route/team scope, field-locks, self-approval block, fail-closed Managers, DB enum `Role` (`lib/access.ts`,`permissions.ts`). OLD: solid route-scope helpers but `Role` is free `String`, no field-locks (`old-rules.md` F/G). NEW has one live authz hole (see #34, H-1 Manager direct-write not region-scoped). |
| 4 | Customer creation | both-different-impl (conflict at product level) | **OLD** (for net-new) | OLD = full 4-stage new-customer workflow (`NEW_MAIN/NEW_BRANCH/NO_CR`, `app/api/requests`) [Confirmed]. NEW = **no manual creation**, only Steward Excel import→promote (`imports.ts:700`) [Confirmed]. For a unified CRM that must onboard field customers, OLD's capability is mandatory and NEW lacks it. |
| 5 | Customer updates / enrichment | both-one-clearly-stronger | **NEW** | NEW writes changes directly to the master on approve with field-level diff, optimistic `version` lock, re-checked locks/mandatory (`edits.ts:503-572,739-760`) [Confirmed]. OLD "update" only records `changesSummary` JSON text for a human to re-key into Temix — **no write-back** (`old-functional.md` §5) [Confirmed]. |
| 6 | Customer search | both-different-impl | **NEW** | NEW: pg_trgm GIN + btree partial indexes on `legalName/nmwcCode/primaryPhoneNorm`, SavedViews, steward filters (`new-arch.md` §5). OLD: route-scoped list with `mode:'insensitive'` but no trigram; unanchored `LIKE '%prefix%'` in dup-check can't use btree (`old-techdebt.md` §1.8). |
| 7 | Duplicate prevention | both-conflict | **depends** | OLD: Levenshtein fuzzy (0.85/0.70) + phone last-8 + CR, runs at submit, blocks EXACT (`lib/duplicate-check.ts`) but has a first-4-char prefix **recall gap** [Confirmed]. NEW: **fuzzy deliberately removed**, only CR-exact + EXACT_TRIPLE, phone-unique **dropped by design** (`p1_drop_phone_unique`), advisory-only, Steward-driven merge (`services/duplicates.ts`) [Confirmed]. Directly contradictory philosophies — cannot merge silently. |
| 8 | Forms & fields | both-different-impl | **NEW** | NEW has richer domain (Branch equipment counts, GPS anchor, channel taxonomy, completeness) with Oman-geofenced GPS + Arabic-digit phone canonicalization (`lib/phone.ts`,`edit.ts:59-68`). OLD forms cover request intake; GPS accepts any global coord (`old-rules.md` B) [Confirmed]. |
| 9 | Validation | both-one-clearly-stronger | **NEW** | Both Zod server-side + `stripHtml`. NEW adds Oman GPS envelope, phone canonical `+968`, formula-injection block on import, min-12 passwords (`new-rules.md` G) [Confirmed]. OLD: min-8 pw, no geofence, no CR/format checks, no formula-injection guard [Confirmed]. |
| 10 | Cash workflow | both-different-impl (weak both) | ~tie | OLD models "cash" only as `NO_CR` request type (stricter photos, CR skipped) — no cash flag (`old-rules.md` H) [Confirmed]. NEW has real `PaymentTerms.CASH` enum but its ONLY behavioral effect is a CR field-lock toggle (`new-functional.md` J4) [Confirmed]. Neither has AR/limits. |
| 11 | Credit workflow | missing-both | — | Neither models credit-limit, terms-approval, balance, or aging. OLD has zero credit fields (`old-data.md` §5.5). NEW has a `CREDIT` enum value gating a field-lock only (`new-rules.md` C) [Confirmed]. **Gap for a distribution CRM.** |
| 12 | Approval workflow | both-different-impl | **depends** | OLD: 3-tier Supervisor→Accountant→RoutePro, 17 statuses, dup-gated submit, SLA escalation (`old-rules.md` E). NEW: 1-tier Supervisor(or Manager) approve of edits, `EditState` 5 values, atomic claim, separate close/reactivate flows (`new-rules.md` D/E). OLD richer for onboarding; NEW cleaner for enrichment. Both use optimistic-concurrency guards [Confirmed]. |
| 13 | Document / photo handling | both-one-clearly-stronger | **NEW** | Both magic-byte/MIME-gated. NEW: presigned R2 PUT + server finalize, key-prefix binding, kind-from-key binding, size re-check via HeadObject, `capturedAt` from R2 LastModified (anti-spoof), 30-day GC lifecycle (`new-rules.md` H, `new-security.md` L6) [Confirmed]. OLD: server magic-byte + 10MB, but Vercel Blob is `access:'public'` behind a proxy; no capture-time anti-spoof [Confirmed]. |
| 14 | Audit trail | both-one-clearly-stronger | **NEW** | NEW: immutable `AuditLog` with before/after JSON, ip/ua, 19 actions incl LOGIN/SESSION_REVOKE/MERGE/PHOTO_VIEW, actor FK RESTRICT (`schema.prisma:489-507`) [Confirmed]. OLD: `StatusHistory` (good, per-transition) + `AdminAuditLog` that is **write-only, never surfaced** (`old-data.md` §5.1) [Confirmed]. NEW caveat: audit misused as mutable state for dup-dismissals + no EXPORT action (`new-techdebt.md` TD-5). |
| 15 | Notifications | only-OLD (both weak) | **OLD** (nominally) | OLD writes in-app `Notification` rows on every transition (`lib/notifications.ts`), but **email is dead code and the daily-summary cron never fires** (POST-only vs Vercel GET — BUG-03/04) [Confirmed]. NEW has **no notification subsystem at all** — work-queue pages + `revalidatePath` only (`new-rules.md` M) [Confirmed]. Effectively neither delivers push/email. |
| 16 | Database structure | both-one-clearly-stronger | **NEW** | NEW: 16 models, 11 **real enums**, migration-based, DB CHECK constraints + triggers + trigram/partial indexes, soft-delete, optimistic `version` (`new-data.md`) [Confirmed]. OLD: 13 models, **zero enums** (all `String`), no `0_init` migration, a migration referencing a non-existent PG enum → `migrate deploy` fails, provisioned by `db push` (`old-data.md` §5.2) [Confirmed]. |
| 17 | Reporting / dashboards | both-different-impl | **NEW** | NEW: completeness-score dashboards, region/route rollups, xlsx export with scope-intersection + async ExportJob (`new-rules.md` K/L). OLD: recharts dashboard + `/api/dashboard/stats`, master xlsx, but daily-summary email cron broken [Confirmed]. Both have in-memory aggregation scaling limits (`new-techdebt.md` SUS-3). |
| 18 | Deployment | both-one-clearly-stronger | **NEW** | NEW: Vercel + Prisma migrate deploy + GH-Actions pg_dump backup + restore-drill + keep-warm, live `nmwc-cm.vercel.app` (`new-arch.md` §6) [Confirmed]. OLD: Vercel+Docker but **schema=postgres / env=sqlite mismatch** makes it not cleanly deployable, crons dead, no backup automation (`old-arch.md` B.5, BUG-01/03) [Confirmed]. |
| 19 | Error handling | both-one-clearly-stronger | **NEW** | NEW: `runAction`/`SafeAction` discriminated union (solves RSC prod message-strip), Sentry, pino with PII redaction (`lib/errors.ts`,`lib/logger.ts`) [Confirmed]. OLD: consistent `apiError` envelope but bare `console.error`, no APM/Sentry/structured logs (`old-techdebt.md` §1.4) [Confirmed]. |
| 20 | Security (overall) | both-one-clearly-stronger | **NEW** | Both hardened via audit cycles. NEW's code posture is stronger (revocation, timing-safe crons, IDOR 404-not-403, formula-injection). Decisive differentiator: **OLD commits real secrets to git** (`.env` tracked: NEXTAUTH_SECRET, CRON_SECRET → JWT-forgery/full-auth-bypass) [Confirmed]; NEW commits **no infra secrets** but **does commit weak shared plaintext user passwords** (`docs/PILOT-MUSCAT-CREDENTIALS.md`, `[REDACTED-PILOT-PW]`) [Confirmed]. Different secret-hygiene failures; OLD's is worse (server-side signing key). |
| 21 | UX | both-different-impl | **NEW** [Highly likely] | NEW: React 19, CVA components, mobile-first field capture (GpsCaptureButton, PhotoCaptureSlot), completeness cues (`components/nmwc/*`). OLD: functional Tailwind dashboard. Not deeply audited on either side; NEW is purpose-built for field mobile use [Highly likely]. |
| 22 | Mobile responsiveness | both-different-impl | **NEW** [Highly likely] | NEW is explicitly field-salesman-on-mobile oriented (GPS/photo capture components, keep-warm for edge networks). OLD mobile behavior not audited (`old-techdebt.md` §1.6 Unknown). [Highly likely NEW] but [Unknown] for OLD. |
| 23 | Administration | both-one-clearly-stronger | **NEW** | NEW: Steward import/export/merge, Manager user/route/region admin, saved views, audit page, peer protections (`new-functional.md` J9/J10) [Confirmed]. OLD: admin escalate/force-transition, master upload, activation queue, but AdminAuditLog unread and no self-service tooling [Confirmed]. |
| 24 | Maintainability | both-one-clearly-stronger | **NEW** | NEW: strong layering, tests (vitest+playwright, but service layer untested — TD-4), typed enums, but `Json` blob fieldChanges + `as any` casts (TD-6). OLD: clean layering too, but String-typed everything, dead code (`canCancel`, LEGACY_STATUSES), doc/reality drift, near-EOL deps (`old-techdebt.md`). NEW's typed schema wins. |

Additional (beyond the required 24, high-value for consolidation):

| # | Feature | Verdict | Stronger | Justification |
|---|---|---|---|---|
| 25 | Rate limiting | both-conflict (both currently broken) | **neither works** | OLD: Postgres `ON CONFLICT` limiter **fails-OPEN** on error + dialect mismatch can disable it (`old-security.md` J-H2). NEW: durable PG limiter **always grants** — `RETURNING ("tokens">=0)` is always true (BUG-1, `lib/rate-limit.ts:104`) [Confirmed by spot-check]. Both leave login brute-force unprotected in prod; NEW at least fails-closed on DB *exception*. Must be fixed regardless of which base is chosen. |
| 26 | Branch model | both-different-impl | **NEW** | NEW: first-class `Branch` model, per-branch GPS/photos/status/scope (`schema.prisma:294-349`) [Confirmed] — though flattened to 1:1 in the pilot (`new-docs.md` #5). OLD models branches only as `NEW_BRANCH` request type + `parentTemixCode` string (no FK) [Confirmed]. |
| 27 | Customer lifecycle (close/suspend/reactivate) | both-partial | **NEW** | NEW: photo-evidenced close→Supervisor, reactivate→Manager, anti-replay via `lastStatusChangeAt` (`new-rules.md` E) [Confirmed]; but SUSPENDED is a dead-end + branch-close doesn't cascade to customer (`new-functional.md` gaps). OLD: reject/return terminal states only, no suspend concept. |
| 28 | External ERP integration (Temix/RoutePro) | missing-both | — | Neither integrates with Temix or RoutePro via API (grep-negative both) [Confirmed]. OLD *records* manual Temix codes; NEW is standalone. A unified CRM's ERP sync is unbuilt in both. |
| 29 | SLA / escalation | only-OLD (broken) | **OLD** (design only) | OLD has working-hours SLA + auto-escalation design (`lib/sla.ts`) but the cron **never fires** (BUG-03) [Confirmed]. NEW has no SLA at all (`new-rules.md` M) [Confirmed]. Neither functions in production. |
| 30 | Optimistic concurrency | both-consistent | tie | Both use guarded `updateMany` / `version` columns for race safety on transitions (`old-rules.md` E; `new-rules.md` N) [Confirmed]. Genuinely equivalent strength; NEW extends it to a `version` column, OLD to status-guards. NEW has 2 unguarded paths (BUG-05/11), NEW has 1 (SUS-1). |

---

## F.2 DEEP-DIVE on the load-bearing differences

### F.2.1 System-of-record vs workflow-tracker (the biggest architectural divide) [Confirmed]
- **OLD never mutates `CustomerMaster`** on any approval/activation. `customerMaster.create/update/upsert` appears ONLY in `app/api/master/upload/route.ts:111,118` + seed (`old-functional.md` §4). The portal is an approval *ledger* over an external Temix/RoutePro reality. Data of record lives in Temix.
- **NEW IS the master of record**: `approveEditCore`→`applyEditChanges` writes `Customer`/`Branch` fields with version-lock (`services/edits.ts:503-572`). But it CANNOT mint a customer from the field (import-only).
- **Consolidation consequence:** you cannot pick one wholesale. A unified CRM = NEW's master-data engine + a NEW-native *net-new-customer creation workflow* (which OLD has and NEW lacks) + a real ERP write-back (neither has). Migrating OLD's request data into NEW means mapping OLD's 17-status request lifecycle onto NEW's `CustomerEdit` model — non-trivial; OLD requests reference Temix codes as un-FK'd strings.

### F.2.2 Duplicate philosophy is a true CONFLICT, not a quality gap [Confirmed]
- OLD *prevents at entry* (fuzzy+phone, blocks EXACT). NEW *allows dups, detects post-hoc, Steward merges*, and **deliberately dropped phone-uniqueness** because one owner runs many shops on one phone (`p1_drop_phone_unique`; `new-docs.md` #1-3). NEW's PRD/REMEDIATION docs still *claim* phone-hard-block — stale (`new-docs.md` §4). 
- These encode opposite business truths about NMWC's real customer base. The **NEW decision is better-grounded in the actual FMCG reality** (shared-owner phones), but OLD's entry-time fuzzy-name catch (typo variants, Arabic/EN) is a genuine capability NEW gave up. Unified target should keep NEW's non-blocking model but restore *fuzzy-name candidate surfacing* at edit time (advisory).

### F.2.3 Secret hygiene — both fail, differently; OLD is worse [Confirmed via both agents]
- OLD: `.env` git-tracked with live `NEXTAUTH_SECRET` + `CRON_SECRET` → **JWT forgery = full ADMIN impersonation** (`old-security.md` J-C1). This is a server-side signing key: catastrophic, and persists in history.
- NEW: infra secrets clean (gitignored, never committed), BUT `docs/PILOT-MUSCAT-CREDENTIALS.md` + `scripts/bulk-reset-credentials.ts` commit **plaintext shared weak user passwords** incl STEWARD, with `mustChangePassword=false` (`new-security.md` C-1). Bad, but user-tier and rotatable; owner-accepted pilot trade-off.
- Both require immediate remediation. OLD's is the more severe class (auth-bypass primitive).

### F.2.4 Both flagship rate-limiters are non-functional in prod [Confirmed by spot-check]
- OLD `lib/rate-limit.ts` fails-open on any error + PG/SQLite dialect mismatch.
- NEW `lib/rate-limit.ts:104` `RETURNING ("tokens">=0) AS granted` — the CASE clamps tokens ≥0, so `granted` is ALWAYS true; unit test only covers the memory path and even notes the PG path is "exercised in production" (untested, live). 
- Net: **brute-force protection is illusory in BOTH.** This is a must-fix in the consolidated system irrespective of the base chosen.

---

## F.3 EVALUATION AXES (rolled up)

| Axis | OLD | NEW | Verdict |
|---|---|---|---|
| Business suitability | Onboarding/approval workflow; no master write-back | Master enrichment; no onboarding | **Split** — need both; NEW is closer to "customer master" mandate |
| Code quality | Clean layering, but String-typed, dead code, doc drift | Clean layering, typed enums, disciplined errors; some `Json`/`any` | **NEW** |
| Security | Strong controls but committed signing secrets, stale sessions | Stronger controls; committed weak user pw; 1 authz hole | **NEW** (both need fixes) |
| Data integrity | No enums, no init migration, migrate-deploy broken, no write-back | Enums, CHECK/triggers, version-lock, soft-delete; some loose FKs | **NEW** decisively |
| Completeness (vs unified target) | Has creation+multi-tier approval; lacks master persistence | Has master persistence+enrichment; lacks creation | **Split** |
| Maintainability | String types + drift + near-EOL deps | Typed + tested-partly + beta auth dep | **NEW** |
| Scalability | N+1 master import, mega-transaction, unindexed sort | trigram indexes, but in-memory dup/dash scans | **NEW** (both have hotspots) |
| UX / mobile | Functional desktop dashboard | Field-mobile-first capture | **NEW** [Highly likely] |
| Ease of migration | Data references Temix as un-FK'd strings; hard to normalize | Migration-based, enum'd, cleaner target to import INTO | **NEW as the base to keep** |
| Fit for unified NMWC CRM | Contributes the creation+ERP-handoff workflow pattern | Contributes the master model, RBAC, audit, storage, deploy | **NEW as foundation; port OLD's creation workflow onto it** |

---

## F.4 CONSOLIDATION RECOMMENDATION (evidence-based, not newer-by-default)
**Keep NEW as the foundation** — decisively stronger on data integrity (real enums, CHECK constraints, version-lock, migrations that actually deploy), security controls, audit, storage, observability, and deployment (it is the one actually live at `nmwc-cm.vercel.app`). This is justified by evidence, not recency: OLD's `migrate deploy` is broken, its schema/env mismatch blocks clean deploy, and it never persists the customer of record — disqualifying it as the master-data base.

**Port these OLD capabilities INTO NEW** (NEW genuinely lacks them):
1. Net-new **customer creation workflow** from the field (OLD's `NEW_MAIN/NEW_BRANCH/NO_CR`) — NEW's import-only model can't onboard (#4, F.2.1).
2. **Multi-tier approval** option (Accountant/finance tier) if credit customers are in scope (#12).
3. **SLA/escalation** concept (#29) — but implement correctly (OLD's cron is dead).
4. Working **notifications** (#15) — both are effectively non-functional; build fresh.

**Must-fix before ANY production consolidation (present in the chosen NEW base):**
- Rate limiter always-grants (BUG-1) [Confirmed].
- Manager direct-write not region-scoped (H-1) [Confirmed].
- Region-less import FK bug (BUG-2), CASH CR-drop on approve (BUG-3) [Confirmed].
- Rotate + purge committed pilot passwords; re-enable `mustChangePassword` (C-1).
- Reconcile stale PRD/REMEDIATION docs vs code (phone-unique, cash name-edit) (`new-docs.md` §4).

**Do NOT carry over from OLD:** committed `.env`/secrets, String-typed schema, broken migration history, POST-only crons, dead email code, no-write-back architecture.

---

## F.5 CONFIRMED vs INFERRED vs ASSUMED vs MISSING
- **CONFIRMED (read in code / spot-checked):** all matrix rows citing file:line; OLD POST-only cron + NEW always-grant limiter (verified this pass); OLD no-CustomerMaster-write; NEW import-only creation; both secret-hygiene failures; enum vs String schema; deploy/migrate status.
- **REASONABLE INFERENCES:** UX/mobile edge favoring NEW (components purpose-built, not pixel-audited) [Highly likely]; that a unified CRM requires both creation and master-persistence; NEW is the cheaper migration target (it is the live system-of-record).
- **UNVERIFIED ASSUMPTIONS:** OLD prod actually runs Postgres (env says sqlite); NEW pilot passwords rotated post-2026-05-11; NEW Vercel cron/keep-warm enabled at runtime; OLD frontend state mgmt (not deep-read).
- **MISSING INFORMATION:** runtime DB row counts/overlap between the two datasets (needed to scope a real migration); whether OLD's request data must be preserved or is superseded by NEW's master; live Temix/RoutePro contract for future ERP integration (neither system has it); actual production secrets vs committed values (verify in Vercel dashboards, do NOT print).

**How to verify the open items:** inspect Vercel env for both projects (DB dialect, secret parity); query Neon for `Customer`/`CustomerMaster` overlap keys (crNumber/temixCode↔nmwcCode); confirm NEW cron enablement + pilot password rotation; run `prisma migrate diff` on OLD against a fresh DB to prove the migrate-deploy breakage.
