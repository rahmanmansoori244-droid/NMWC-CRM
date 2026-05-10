# Photo upload diagnosis — 2026-05-10

**Reporter:** owner via "tried to upload a photo on the customer edit form and it did not work."
**Branch:** `main`
**Latest commit before fix:** `82c58ec`
**Deploy:** https://nmwc-cm.vercel.app
**Status:** Root cause confirmed and fixed in this session.

---

## TL;DR

Every browser-side photo PUT to Cloudflare R2 was failing with a checksum
mismatch because AWS SDK v3 ≥ 3.729 enables flexible-checksums by default. The
SDK pre-computes `x-amz-checksum-crc32` for an empty body and hoists it into
the presigned URL's query string. R2 then rejects the actual JPEG upload
because its real CRC32 is not `AAAAAA==`. The browser's `fetch` cannot
recompute or send a real CRC32 header.

**Fix:** opt out of flexible-checksums in the R2 client by setting
`requestChecksumCalculation: 'WHEN_REQUIRED'` and
`responseChecksumValidation: 'WHEN_REQUIRED'` (`lib/r2.ts`). Verified by
re-running the signing locally — the bogus `x-amz-checksum-crc32` and
`x-amz-sdk-checksum-algorithm` query params disappear; signed headers reduce
to `content-length;host`.

---

## Likely root causes (ranked by probability)

### 1. AWS SDK flexible-checksums regression (CONFIRMED — fixed)

- **File:** `lib/r2.ts`
- **Trigger:** `@aws-sdk/client-s3@^3.1045.0` + `@aws-sdk/s3-request-presigner@^3.1045.0`. Both ≥ 3.729 (the version that turned on default checksums).
- **Reproduction:** local `node -e` script invoking `getSignedUrl(PutObjectCommand)` with the same `Bucket / Key / ContentType / ContentLength` shows the URL contains:
  - `x-amz-checksum-crc32=AAAAAA%3D%3D` (CRC32 of empty body, base64)
  - `x-amz-sdk-checksum-algorithm=CRC32`
  - `X-Amz-SignedHeaders=content-length;host` (note: checksum header is in the query, not in `SignedHeaders`)
- **Why it breaks R2:** Cloudflare R2 — like S3 in `WHEN_SUPPORTED` mode — verifies the CRC32 against the actual uploaded body. Browser `fetch(blob)` cannot run CRC32 computations, so the body's real checksum never matches the placeholder in the URL. R2 returns `400` with `XAmzContentChecksumMismatch` (or similar) and the PUT fails before ever reaching `/api/photos/finalize`.
- **Fix applied:**
  ```ts
  // lib/r2.ts
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  ```
  After fix, signed URL contains only the standard `X-Amz-Algorithm / X-Amz-Credential / X-Amz-Date / X-Amz-Expires / X-Amz-Signature / X-Amz-SignedHeaders=content-length;host`. No checksum query params. Confirmed via `node -e` repro.

### 2. NEW-PHOTO-001 kindFromKey regex (RULED OUT)

- **File:** `app/api/photos/finalize/route.ts:34`
- **Regex:** `/^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[a-z0-9]+\/(SHOP|SIGNBOARD|CR|FREE)\//`
- **Status:** Tested against real CUIDs (`cmozemi6m000ptvb8mf217n4j` etc.) and all four kinds. Regex matches correctly. `[a-z0-9]+` is the exact CUID alphabet (Prisma `@default(cuid())` produces only `[a-z0-9]`).
- **Confidence:** Not a contributor.

### 3. NEW-PHOTO-005 3 MB cap (LOW PROBABILITY)

- **File:** `app/api/photos/presign/route.ts:16` and `app/api/photos/finalize/route.ts:40`
- **Walk:** `compressImage` produces JPEG q=0.85 at max 1920px. Typical iPhone 12-MP photo at 1920px is ~400-700 KB. A noisy outdoor shot with lots of texture could plausibly hit 1-1.5 MB. 3 MB cap is comfortable headroom.
- **Edge case:** if a salesman's phone refuses to recompress (rare canvas-tainted bug) and hits the 10 MB raw limit, the new 3 MB cap would block. Logs would show `bytes` > 3 MB in the presign Zod failure.
- **Confidence:** Not the cause unless the user's phone has a specific canvas-encoding bug. Worth checking Vercel logs for `VALIDATION_FAILED` on `/api/photos/presign` from the user's session.

### 4. NEW-PHOTO-003 soft-delete previous slot photo (RULED OUT)

- **File:** `services/photos.ts:114-120, 169-188`
- **Walk:** `if (prev && prev !== att.id)` correctly guards against the no-prior-photo case. `prisma.attachment.update` does throw P2025 if the prior id no longer exists, but the prior id is only set when `customer.crPhotoId` already pointed at a real attachment (FK-constrained), so this is a no-op for first-upload customers.
- **Confidence:** Not a contributor.

### 5. R2 CORS missing for vercel.app (UNCHECKED — possible secondary)

- **File:** R2 bucket CORS, set in Cloudflare dashboard (not in this repo).
- **Required policy:**
  ```json
  [{
    "AllowedOrigins": ["https://nmwc-cm.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "Authorization"],
    "MaxAgeSeconds": 3600
  }]
  ```
- **Confidence:** If CORS is missing, the browser would block the PUT preflight before the request hits R2. The user would see a CORS error in console. The owner did not mention a CORS error, so this is plausible but not the primary cause. **Verify in Cloudflare R2 dashboard** before pilot.

### 6. CSP `connect-src` (RULED OUT)

- **File:** `next.config.ts:27`
- **Header:** `connect-src 'self' https://${r2AccountId}.r2.cloudflarestorage.com ...`
- **Walk:** `r2AccountId` is `process.env.R2_ACCOUNT_ID` at server start. If this env var is not set in Vercel production, the CSP would default to `*` (the file uses `?? '*'`), which is permissive and would allow R2. If set correctly, it would allow only that account. Either way, R2 PUT is allowed.
- **Confidence:** Not the cause.

### 7. attachPhotoAction expectedKindForSlot (RULED OUT for current bug)

- **File:** `services/photos.ts:81-93`
- **Walk:** FREE slot bypasses the kind check (`if (data.slot !== 'FREE')`). Other slots require `att.kind === expectedKindForSlot[slot]`. Since `kindFromKey` already enforces this on the finalize side, slot/kind binding is internally consistent. Not the failure mode.
- **Note:** A salesman submitting a FREE-slot photo with a `kind: 'FREE'` body and a key segment of `FREE` is fine. But `kind: 'FREE'` requires the presign to have been called with `kind: 'FREE'`, which the UI already does (`PhotoCaptureSlot kind="FREE"` in EnrichmentForm.tsx).

---

## Paranoid pass on `compressImage` (PhotoCaptureSlot.tsx:25-71)

| Concern | Status | Notes |
|---|---|---|
| `URL.createObjectURL` undefined | Safe | API present in every browser supporting `<input type="file" capture>`. No defensive check needed. |
| Object URL leak in compressImage | Safe | `try { ... } finally { URL.revokeObjectURL(objectUrl); }` |
| Object URL leak in preview | **Minor leak** | `previewUrl = URL.createObjectURL(blob)` (line 176) is only revoked in `actuallyClear`. If user replaces photo without going through Remove dialog, the prior previewUrl leaks until tab close. Not fatal — single Blob URL is a few bytes of overhead. Could fix later but not the cause of the upload failure. |
| Canvas mime-type | Safe | `canvas.toBlob(cb, 'image/jpeg', 0.85)` returns a JPEG. Client always sends `mimeType: 'image/jpeg'` to presign regardless of input format. |
| HEIC error path | Safe | `img.onerror` fires for HEIC on non-Safari, surfaces the actionable hint message. |
| `canvas.toBlob` returning null | Safe | `b ? resolve(b) : reject(new Error('Compression failed'))` |

---

## Verification commands

After deploy, run any photo upload from a browser. Expected:

1. `POST /api/photos/presign` → 200, returns `{ url, key, headers: { 'Content-Type': 'image/jpeg' } }`.
2. `PUT <url>` → **200 (was failing with 400 before fix)**. Look at the URL in DevTools network tab — it should NOT contain `x-amz-checksum-crc32` or `x-amz-sdk-checksum-algorithm`.
3. `POST /api/photos/finalize` → 200, returns `{ attachmentId, deduped: false }`.
4. Server-action `attachPhotoAction` → returns `{ ok: true }`.

Local repro of the signing change:
```bash
node -e "
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
(async () => {
  const c = new S3Client({
    region: 'auto',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const url = await getSignedUrl(c, new PutObjectCommand({
    Bucket: 'b', Key: 'k.jpg', ContentType: 'image/jpeg', ContentLength: 1234,
  }), { expiresIn: 600 });
  console.log(new URL(url).searchParams.get('X-Amz-SignedHeaders'));
})();
"
# Expected output: content-length;host  (no checksum params in URL)
```

---

## What I need to confirm the fix in production

- **Vercel runtime logs:** I do not have access from this sandbox. The owner should run `npx vercel logs https://nmwc-cm.vercel.app/api/photos/finalize` after a real upload attempt post-deploy and look for `r2.finalize.head_fail` or `KIND_MISMATCH` warnings (should not appear if checksum fix works).
- **R2 bucket CORS:** Owner should verify in Cloudflare dashboard. If missing, browser preflight will fail and the PUT never reaches R2, regardless of this fix.
- **Browser test:** open the customer edit form on the deployed site, capture a photo, watch DevTools network tab. PUT should be 200 (was 400 before fix).

---

## What's left

1. **Deploy the `lib/r2.ts` change** and re-test photo upload end-to-end.
2. **Verify R2 CORS policy** in Cloudflare dashboard allows PUT from `https://nmwc-cm.vercel.app`. Out of repo scope.
3. **(Optional cleanup)** Address the minor object URL leak in PhotoCaptureSlot for the preview path. Not the cause of the bug; defer to a follow-up.

— Diagnosis run 2026-05-10
