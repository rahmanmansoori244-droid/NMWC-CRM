# route area

> 15 nodes · cohesion 0.20

## Key Concepts

- **route.ts** (22 connections) — `app/api/photos/[id]/route.ts`
- **r2()** (11 connections) — `lib/r2.ts`
- **photo-mime.ts** (9 connections) — `lib/photo-mime.ts`
- **SEC-14e Served photo Content-Type was the uploader's choice** (7 connections) — `docs/audit/04-photos.md`
- **GET()** (6 connections) — `app/api/photos/[id]/route.ts`
- **serveHeadersFor()** (4 connections) — `lib/photo-mime.ts`
- **checkLimitLocal()** (4 connections) — `lib/rate-limit.ts`
- **photo-mime.test.ts** (4 connections) — `tests/unit/photo-mime.test.ts`
- **SEC-14e presigned upload Content-Type unbound (HTML served from app origin)** (3 connections) — `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- **B-13 CSP allows unsafe-inline for script-src** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- **SERVABLE_IMAGE_MIME** (2 connections) — `lib/photo-mime.ts`
- **EXT** (1 connections) — `lib/photo-mime.ts`
- **FROM_EXT** (1 connections) — `lib/photo-mime.ts`
- **ServeHeaders** (1 connections) — `lib/photo-mime.ts`
- **key()** (1 connections) — `tests/unit/photo-mime.test.ts`

## Relationships

- [[Photo upload and R2]] (10 shared connections)
- [[route area]] (4 shared connections)
- [[Cross-domain and RBAC audits]] (3 shared connections)
- [[Access scope and submit gate]] (3 shared connections)
- [[rate-limit area]] (3 shared connections)
- [[errors area]] (2 shared connections)
- [[logger area]] (2 shared connections)
- [[Photo attach routes]] (2 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (1 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (1 shared connections)
- [[Auth and page scope loading]] (1 shared connections)
- [[Customer list, filters and export]] (1 shared connections)

## Source Files

- `app/api/photos/[id]/route.ts`
- `docs/audit/04-photos.md`
- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `lib/photo-mime.ts`
- `lib/r2.ts`
- `lib/rate-limit.ts`
- `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- `tests/unit/photo-mime.test.ts`

## Audit Trail

- EXTRACTED: 74 (95%)
- INFERRED: 4 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*