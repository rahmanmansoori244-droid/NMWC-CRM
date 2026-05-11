# Changelog

Every change to NMWC Customer Master, newest first. Each entry links to its commit hash so you can `git show <hash>` to see the diff.

This file grows over the lifetime of the project. For a deeper narrative of what happened in a single session, look at the dated `docs/SESSION-HANDOFF-*.md` files.

---

## v1.0.1 — 2026-05-11 — Real-world data fixes + pilot credentials

User audit of the live system found that the customer master had wrong
semantics (sub-branches instead of flat customers), the duplicate detector
was too noisy, phone uniqueness was wrongly enforced, and the steward had
no real filtering. Plus pre-launch hardening: pre-warm cron, perf cache,
shared simple passwords (explicit owner trade-off), synthetic load test.

### Major changes
- **P1.1** Synthetic data wipe (`scripts/wipe-synthetic-data.ts`) — removed
  6 fake regions, 38 routes, 115 branches, 95 customers, 38 fake users.
  Muscat-only state.
- **P1.2** Flatten data model (`scripts/flatten-customer-branches.ts`) —
  each Customer now owns exactly 1 Branch (was 1:1 or 1:N). 3308=3308.
  Reversibility map in `docs/audit/flatten-map-*.json`.
- **P1.3** Phone-uniqueness dropped (migration `20260510160000_p1_drop_phone_unique`).
  `DUPLICATE_PHONE` ConflictError removed from `services/edits.ts` (both
  submit + approve paths). Phone duplicates allowed everywhere with a
  soft logger.info note for steward review.
- **P1.4** Duplicate detector rewrite (`services/duplicates.ts`) — only
  CR-number exact match OR same legalName+phone+region triple. Dropped
  fuzzy name and phone-only.
- **P2.1** Steward filters on `/customers` (region / route / channel /
  sub-channel / supervisor / salesman / payment terms / completeness /
  date range), URL-bookmarkable, with visibility rules per role.
- **P2.2** Saved views (`SavedView` model + migration `20260510170000_p2_saved_views`).
- **P2.3** Filtered xlsx export (`services/customer-export.ts`).
- **P3** Perf pass — `customerCountFast` helper, `cache()` on
  `loadScope`, 6 loading skeletons, `revalidate=30` on dashboard+today.
- **F1** Reference-data cache (`lib/reference-data.ts`) — 5-min
  `unstable_cache` for the 6 dropdown lookups. 6 fewer Prisma queries
  per `/customers` render.
- **F2** GitHub Actions keep-warm cron (`.github/workflows/keep-warm.yml`) +
  endpoint (`app/api/cron/keep-warm/route.ts`). Runs every 4 min during
  Oman business hours. Eliminates cold-start during the workday.
- **F3** Btree index on `Customer.legalName` (migration `20260511000000_perf_btree_legalname`)
  for `ORDER BY` performance.
- **F4** `/api/perf-probe` endpoint (steward/manager only) reports per-query
  timing so we can verify cache wins.
- **Phone-search fix** — `lib/customer-filters.ts` now queries
  `primaryPhoneNorm` (trigram-indexed) instead of `primaryPhone`
  (seq-scan).
- **Bulk credential reset** (`scripts/bulk-reset-credentials.ts`) —
  salesmen renamed `<route>-nmwc`, all share password `12345678`; staff
  share `97246316`. `mustChangePassword=false` everywhere. 13 demo
  accounts disabled. Explicit security trade-off the owner accepted on
  2026-05-11 for pilot ease of use.
- **Synthetic load test** (`scripts/synthetic-launch-test.ts` +
  `cleanup-synthetic-test.ts`) — 4 concurrent Playwright workers verify
  the daily workflow against production with safe revert.
- **PDF guides regenerated** — all 8 user-facing PDFs refreshed with
  post-flatten data.
- **Launch checklist** at `docs/LAUNCH-CHECKLIST.md` — 7-minute pre-launch
  ritual.

### Commits

| Hash | Title |
|---|---|
| `f719362` | Pre-launch: synthetic smoke test, phone-search fix, fresh PDFs, checklist |
| `e156a2c` | perf: cache reference data + btree on legalName + GitHub-cron keep-warm |
| `7d0dcb1` | P1+P2+P3: flatten data, drop phone unique, tighten dup detector, steward filters, saved views, filtered xlsx export, perf pass |
| `462817e` | docs: 2026-05-10 session handoff + project CHANGELOG |

---

## v1.0.0 — 2026-05-10 — Senior-audit remediation + user guides + production-ready pilot

This session closed the senior-audit findings, hardened the daily backup workflow through 5 iterations, and produced 8 PDF user guides.

### Production state at end of session

- Live URL: `https://nmwc-cm.vercel.app` (commit `c9c291b`, fra1 region)
- 3 334 customers, 3 423 branches in live Neon
- Schema migration `20260510120000_senior_audit_remediation` applied
- Daily DB backup operational (`db/<date>.sql.gz` in R2 `nmwc-backups`)
- 59 / 59 unit tests pass, tsc clean

### Commits

| Hash | Title | Notes |
|---|---|---|
| `c9c291b` | Add Data Steward (head office) guide | 14 pages, English, indigo branding. `npm run guide:roles` re-builds. |
| `9013721` | Add 6 role × language guide PDFs | Salesman / Supervisor / Manager × English + Arabic (RTL). 6 PDFs, ~3 MB total. |
| `a6585db` | Add field-team user guide (combined) | 1.3 MB, 16 pages. Cover, who-does-what, role sections, FAQ, quick reference. |
| `a05cb5e` | db-backup: gate restore-drill on `NEON_DRILL_ENABLED` | Manual workflow runs go all-green when secrets aren't set yet. |
| `a331384` | db-backup: force pg_dump 17 binary path | Ubuntu 24.04 pre-installs v16; absolute path `/usr/lib/postgresql/17/bin/pg_dump` wins. |
| `3987335` | db-backup: bump pg_dump 16 → 17 | Neon Postgres 17.8 cluster — v16 client refused. |
| `99302a6` | db-backup: trim CR/LF + diagnostics | Notepad-pasted secrets carry trailing whitespace; defensive trim + sanitized length/head/tail diagnostic. |
| `d9b4658` | B-13 nonce CSP (real fix) + ops scripts | `app/layout.tsx` now reads `x-nonce` so Next.js stamps inline scripts. CSP now `script-src 'self' 'nonce-...' 'strict-dynamic'`. |
| `b596680` | B-13 hotfix: revert nonce-only CSP | First-pass nonce CSP without layout plumbing left production blank — temporary `'unsafe-inline'` fallback to unblock. |
| `2c112a1` | Senior-audit remediation: 22 of 25 bugs | Single big commit. Schema migration + bulk approve UI + audit log helper + optimistic locking + photo retry + GPS fallback + ConfirmModal + reject templates + font/tap bumps + fra1 region + R2 lifecycle tagging + GitHub Actions backup workflow. |

### Bug closures (B-01..B-25 from `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`)

22 of 25 fixed and live: B-01, B-02, B-03, B-04, B-05, B-07, B-08, B-09, B-10, B-11, B-12, B-13, B-14, B-15, B-16, B-17, B-18, B-19, B-20, B-21, B-23, B-24, B-25.
1 partial: B-06 (fonts/taps shipped; full progressive form rewrite deferred).
2 deferred to post-pilot: B-22 (EditFieldChange relational table), B-06 (full rewrite).

### New scripts

- `scripts/build-role-guides.ts` — 7 role-specific PDF generator
- `scripts/capture-guide-screenshots.ts` — mobile-viewport (390×844) screenshots
- `scripts/capture-steward-screenshots.ts` — desktop (1280×800) screenshots
- `scripts/seed-demo-edit.ts` — idempotent SUBMITTED edit for screenshot population
- `scripts/guide-html-to-pdf.ts` — Playwright HTML → PDF
- `scripts/r2-setup-lifecycle.ts` — programmatic R2 lifecycle config attempt (graceful fallback to dashboard URL)
- `scripts/print-required-secrets.ts` — list missing GitHub Actions secrets
- `prisma/test-prod-001-race.ts` — atomic-claim race verification
- `prisma/test-approve-as-supervisor.ts` — bypass UI for approve flow
- `prisma/inspect-pending-edit.ts` — see edits per customer

### New npm scripts

```
guide:capture · guide:pdf · guide:roles · guide:build
ops:r2-setup · ops:print-secrets
```

### New documentation

- `docs/SESSION-HANDOFF-2026-05-10.md` — comprehensive session record (this file's source of truth)
- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md` — senior-auditor 5-expert verdict
- `docs/audit/E2E-VERIFICATION-2026-05-10.md` — live-driven workflow verification
- `docs/CHANGELOG.md` — this file
- `docs/guide/NMWC-CRM-USER-GUIDE.{html,pdf}` + 7 role-specific PDFs

---

## 0.1.x — 2026-05-10 (early session) — Photo upload, EL-01 approve guard, AUTH-09, PROD-006

Earlier in the same session, before the senior-audit work.

| Hash | Title | Notes |
|---|---|---|
| `242d4a6` | Photo upload fix #2: force path-style R2 URLs | NEW-PHOTO-014. CSP `connect-src` was rejecting bucket-as-subdomain; `forcePathStyle: true` keeps all PUTs on the allowed host. |
| `5a1f8b7` | PROD-006 server-action error contract | All actions return `{ ok: true, data } \| { ok: false, code, message, fields? }` via `runAction()`. P2002 → `UNIQUE_CONSTRAINT`. 11 forms updated. |
| `0d9df2b` | Photo upload fix #1: opt out of AWS SDK flexible-checksums | NEW-PHOTO-013. SDK ≥ 3.729 was hoisting `x-amz-checksum-crc32=AAAAAA==` (empty-payload CRC) into the presigned URL. R2 rejected every PUT. |
| `82c58ec` | E2E test pass + 2 bugs found and fixed live | DB-01 (address ≥ 3 on import), DB-02 (lastStatusChangeAt backfill). |
| `1432981` | EL-01 defense-in-depth: status flips rejected at approve | Mirror of submit-time guard inside `approveEditCore`. |
| `90ae392` | Fix AUTH-09: middleware-side mustChangePassword redirect | Edge config session callback was missing — JWT field never reached middleware. |
| `23cab7c` | Pilot seed: GT-MUSCAT pilot org | Abdullah (MANAGER), Abdulrahman (STEWARD), Ahmed (SUPERVISOR), 10 routes, 10 salesmen. |

---

## 0.0.x — 2026-05-09 — Foundation, build, audit, pre-launch hardening

Initial build session. See `docs/SESSION-HANDOFF-2026-05-09.md` for the deep narrative.

| Hash | Title | Notes |
|---|---|---|
| `61785a8` | Save 2026-05-09 session handoff + brutal benchmark + roadmap | Closing artifacts. |
| `2a1297e` | Page-level redirect for /import + /duplicates | RBAC-05-009 follow-up. |
| `7856627` | Pre-launch hardening: 6 Critical + 34 High closures | Schema migration `20260510000000_pre_launch_hardening` applied. 57 files, +5240 / -347 lines. |
| `d6494b2` | PROD-004 timezone + PROD-005 GPS bounds + client-side mandatory gate | |
| `fa5d07f` | PROD-001/002/003 + mandatory-field gate | Atomic-claim approval lock; submit-time required-fields enforcement. |
| `7562fd3` | QA: heavy-load test (10 users, 81 calls, 0 errors) | 5 production bugs documented (PROD-001..005). |
| `ab09b7a` | Auth: valid bcrypt dummy hash for equal-time path | |
| `dda8ff0` | QA-001 polish: notFound() instead of throw | |
| `c40209d` | docs: remediation report — all 5 Critical + 18 High closed | |
| `aea667a` | Remediation: fix all 5 Critical + 18 High audit findings | |
| `9ccf62c` | QA: independent adversarial audit (63 findings) | |
| `b8445e0` | docs: full build report — phases, milestones, issues | |
| `0a0732e` | M6 + M7 + M8: export, dedupe, reactivation, dashboards | |
| `bf35052` | M3: photo capture via Cloudflare R2 | |
| `ff5f4d5` | M4 + M5: enrichment form + supervisor approval queue | |
| `bf0cd46` | Vercel: run prisma generate during build + postinstall | |
| `f69cc8f` | M1 + M2: full schema, synthetic data, shell, manager admin, steward import | |
| `0cc52a2` | M0: fix login action — native Auth.js redirect | Was bouncing back to /login. |
| `fdd4294` | M0: split Auth.js config for Edge middleware compat | |
| `cf8f86a` | M0: foundation — Next.js 15 + TS + Tailwind + Auth.js + Prisma | First commit. |

---

## How to read this file

- **Major versions** (`v1.0.0`) are tied to milestones — go-live, pilot rollout, schema migrations.
- **Minor versions** (`0.1.x`) group commits within a single session.
- For commit-level detail use `git show <hash>` or read the related session-handoff doc.
- Bug-fix references (`B-01`, `EL-01`, `PROD-006`, `RBAC-05-003`) are catalogued in:
  - `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md` (B-01..B-25 — senior audit)
  - `docs/audit/01..07.md` (per-domain reports from 7-agent audit)
  - `docs/REMEDIATION-REPORT.md` (initial QA findings)
  - `docs/QA-AUDIT-REPORT.md` (initial 63-finding audit)
