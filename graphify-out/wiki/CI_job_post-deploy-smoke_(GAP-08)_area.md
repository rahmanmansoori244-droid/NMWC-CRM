# CI job post-deploy-smoke (GAP-08) area

> 21 nodes · cohesion 0.15

## Key Concepts

- **CI job post-deploy-smoke (GAP-08)** (12 connections) — `.github/workflows/ci.yml`
- **.github/workflows/ci.yml** (11 connections) — `.github/workflows/ci.yml`
- **Docs versus code contradictions (section 15)** (9 connections) — `AUDITOR-BRIEF.md`
- **Principle: fail rather than skip (127 vacuous drill runs)** (8 connections) — `.github/workflows/restore-drill.yml`
- **Hazard: prisma migrate deploy runs before next build** (7 connections) — `CLAUDE.md`
- **Build order: typecheck and lint before migrate** (6 connections) — `AUDITOR-BRIEF.md`
- **Health severity tiers (lib/health.ts, item 11)** (6 connections) — `AUDITOR-BRIEF.md`
- **CI job e2e (Playwright login spec on production build, GAP-07)** (6 connections) — `.github/workflows/ci.yml`
- **CI job lint-test-build (typecheck, lint, unit, next build)** (6 connections) — `.github/workflows/ci.yml`
- **README.md** (5 connections) — `README.md`
- **npm audit gate at critical for production deps** (5 connections) — `.github/workflows/ci.yml`
- **Per-request nonce CSP (lib/csp.ts)** (4 connections) — `AUDITOR-BRIEF.md`
- **Secrets hygiene: gitleaks, npm audit gate, Dependabot** (4 connections) — `AUDITOR-BRIEF.md`
- **Pattern: || CODE=$? under inherited bash -e** (4 connections) — `.github/workflows/ci.yml`
- **CI job secrets-scan (gitleaks)** (4 connections) — `.github/workflows/ci.yml`
- **Grouped weekly npm updates, majors ignored (SEC-05)** (3 connections) — `.github/dependabot.yml`
- **npm scripts (typecheck runs next typegen first)** (3 connections) — `README.md`
- **Change-password page action-worker check (X-AUTH-1)** (3 connections) — `.github/workflows/ci.yml`
- **.github/dependabot.yml** (2 connections) — `.github/dependabot.yml`
- **Trust order: code, brief, commits, then docs** (2 connections) — `AUDITOR-BRIEF.md`
- **Stack: Next.js 15, Neon Postgres + Prisma, Auth.js, R2, Sentry, Vercel** (2 connections) — `README.md`

## Relationships

- [[Auditor brief]] (15 shared connections)
- [[Standing rules (CLAUDE.md, AGENTS.md)]] (11 shared connections)
- [[Monthly restore drill on an emptied Neon area]] (7 shared connections)
- [[docs/CHANGELOG.md area]] (4 shared connections)
- [[Handover and go-live runbook]] (4 shared connections)
- [[Scheduled work: Vercel crons and GitHub  area]] (3 shared connections)
- [[docs/BENCHMARK-REPORT.md area]] (2 shared connections)
- [[docs/BUILD-REPORT.md area]] (2 shared connections)

## Source Files

- `.github/dependabot.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/restore-drill.yml`
- `AUDITOR-BRIEF.md`
- `CLAUDE.md`
- `README.md`

## Audit Trail

- EXTRACTED: 93 (83%)
- INFERRED: 19 (17%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*