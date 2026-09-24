# NMWC Customer Master

Field-driven customer master data cleanup app for National Mineral Water Company (Oman).

> **Status:** Milestone 0 — foundation. See [docs/PRD-v0.1.md](docs/PRD-v0.1.md), [docs/UX-SPEC.md](docs/UX-SPEC.md), [docs/TECH-SPEC.md](docs/TECH-SPEC.md).

## Stack

- Next.js 15 (App Router) + TypeScript + React 19
- Tailwind CSS + shadcn/ui (added in M2)
- PostgreSQL on Neon + Prisma (added in M1)
- Auth.js — Credentials provider (added in M1)
- Cloudflare R2 for photos (added in M3)
- Sentry + pino (wired in M0)
- Vitest + Playwright
- Deployed to Vercel

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in values
npm run dev                   # http://localhost:3000
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server |
| `npm run build` | Production build |
| `npm run typecheck` | clears `.next/types/app`, then `next typegen && tsc --noEmit` — route types first, or no href is checked; the clearing stops a deleted page's leftover types failing it |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit/integration |
| `npm run test:e2e` | Playwright E2E |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:studio` | Prisma Studio GUI |

## Project structure

See [docs/TECH-SPEC.md §2](docs/TECH-SPEC.md).
