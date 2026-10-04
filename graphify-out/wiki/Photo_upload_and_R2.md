# Photo upload and R2

> 43 nodes · cohesion 0.08

## Key Concepts

- **route.ts** (23 connections) — `app/api/photos/presign/route.ts`
- **route.ts** (22 connections) — `app/api/photos/finalize/route.ts`
- **photo-upload-roles.test.ts** (15 connections) — `tests/unit/photo-upload-roles.test.ts`
- **r2.ts** (13 connections) — `lib/r2.ts`
- **Audit 04 — Photos pipeline end-to-end (2026-05-09, addendum 2026-09-15)** (12 connections) — `docs/audit/04-photos.md`
- **POST()** (8 connections) — `app/api/photos/finalize/route.ts`
- **POST()** (8 connections) — `app/api/photos/presign/route.ts`
- **attachPhotoAction()** (8 connections) — `services/photos.ts`
- **Photo upload diagnosis (2026-05-10)** (7 connections) — `docs/audit/photo-upload-diagnosis.md`
- **NEW-PHOTO-001 Photo slot kind taken from client input at every step** (5 connections) — `docs/audit/04-photos.md`
- **NEW-PHOTO-003 Replaced slot photo orphaned, no GC job (QA-044)** (5 connections) — `docs/audit/04-photos.md`
- **canUploadPhoto()** (5 connections) — `lib/permissions.ts`
- **photo-presign-tracing.test.ts** (5 connections) — `tests/unit/photo-presign-tracing.test.ts`
- **NEW-PHOTO-005 Upload size cap 10 MB and client-asserted** (4 connections) — `docs/audit/04-photos.md`
- **GAP-03 No scheduled jobs; claimed 30-day photo GC absent** (4 connections) — `docs/audit/07-cross-check.md`
- **AWS SDK >=3.729 flexible checksums break presigned R2 PUT** (4 connections) — `docs/audit/photo-upload-diagnosis.md`
- **compressImage()** (4 connections) — `components/nmwc/PhotoCaptureSlot.tsx`
- **NEW-PHOTO-012 HEIC photos rejected with an unhelpful error** (3 connections) — `docs/audit/04-photos.md`
- **kindFromKey regex re-derives photo kind from the R2 key** (3 connections) — `docs/audit/photo-upload-diagnosis.md`
- **post()** (3 connections) — `tests/unit/photo-upload-roles.test.ts`
- **NEW-PHOTO-004 EXIF stripped only by accident of canvas re-encode** (2 connections) — `docs/audit/04-photos.md`
- **NEW-PHOTO-006 No GPS sanity check between photo and branch** (2 connections) — `docs/audit/04-photos.md`
- **NEW-PHOTO-010 Photo GET route has no rate limit** (2 connections) — `docs/audit/04-photos.md`
- **RBAC-05-011 attachPhotoAction has no role gate for Supervisor/Manager** (2 connections) — `docs/audit/05-rbac-scope.md`
- **B-08 Photo retake needs full re-upload, no retry or progress** (2 connections) — `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- *... and 18 more nodes in this community*

## Relationships

- [[route area]] (13 shared connections)
- [[Cross-domain and RBAC audits]] (6 shared connections)
- [[Photo attach routes]] (6 shared connections)
- [[End-to-end verification and seeds]] (5 shared connections)
- [[logger area]] (5 shared connections)
- [[Create finalize and synthetic data]] (4 shared connections)
- [[rate-limit area]] (4 shared connections)
- [[Permissions and user administration]] (3 shared connections)
- [[Records of processing activities (draft, area]] (2 shared connections)
- [[session area]] (2 shared connections)
- [[May 2026 audits and remediation]] (1 shared connections)
- [[NMWC-CRM senior audit report (2026-05-10 area]] (1 shared connections)

## Source Files

- `app/api/photos/finalize/route.ts`
- `app/api/photos/presign/route.ts`
- `components/nmwc/PhotoCaptureSlot.tsx`
- `docs/audit/04-photos.md`
- `docs/audit/05-rbac-scope.md`
- `docs/audit/07-cross-check.md`
- `docs/audit/NMWC-CM-FINAL-AUDIT-2026-05-10.md`
- `docs/audit/photo-upload-diagnosis.md`
- `lib/permissions.ts`
- `lib/r2.ts`
- `services/photos.ts`
- `tests/unit/photo-presign-tracing.test.ts`
- `tests/unit/photo-upload-roles.test.ts`

## Audit Trail

- EXTRACTED: 188 (96%)
- INFERRED: 8 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*