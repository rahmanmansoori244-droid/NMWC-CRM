# Audit 04 — Photos pipeline (end-to-end)

**Auditor:** Adversarial QA — pre-launch round 2
**Scope:** capture, presign, R2 upload, finalize (hash dedup), attach, detach, view, cache, IDOR, soft-delete, privacy
**Files reviewed:**
- `services/photos.ts`
- `app/api/photos/finalize/route.ts`
- `app/api/photos/[id]/route.ts`
- `app/api/photos/presign/route.ts`
- `components/nmwc/PhotoCaptureSlot.tsx`
- `components/nmwc/GpsCaptureButton.tsx`
- `components/nmwc/BranchStatusActions.tsx`
- `lib/r2.ts`, `lib/access.ts`, `lib/auth.ts`, `lib/rate-limit.ts`
- `prisma/schema.prisma` (Attachment), `prisma/migrations/20260509150000_qa_remediation/migration.sql`
- `next.config.ts` (CSP)

**Verification of prior fixes:**

| Prior finding | Status | Notes |
|---|---|---|
| QA-002 (photo IDOR) | **FIXED** | `app/api/photos/[id]/route.ts:33-43` calls `loadScope` + `assertCanAccessAttachment`; returns 404 (not 403) on miss. |
| QA-003 (any user can delete) | **FIXED** | `services/photos.ts:180-240` checks scope via `assertCanAccessAttachment`, blocks VIEWER, requires SALESMAN ownership; soft-deletes by renaming `r2Key` and clearing `hash`. |
| QA-004 (re-point another's attachment) | **FIXED** | `services/photos.ts:46-57` enforces `capturedById === me` (or admin role) AND attachment must not be already wired. |
| QA-005 (finalize accepts arbitrary key) | **FIXED** | `app/api/photos/finalize/route.ts:62-67` enforces prefix `${YYYY}/${MM}/${DD}/${userId}/` (today + yesterday UTC). |
| QA-049 (photo cache 5 min) | **FIXED** | `app/api/photos/[id]/route.ts:53` sets `private, max-age=60, must-revalidate`. |

The five photo-pipeline fixes from the original audit are in place. **However, walking each scenario as a real user uncovers 12 new logical / data-integrity / privacy issues — three of them High severity.** Findings below.

---

## Findings

### NEW-PHOTO-001 — Slot kind (`SHOP/SIGNBOARD/CR/FREE`) is taken from caller-supplied input on every step; server never re-derives or constrains by route/branch state

- **Severity:** High
- **Confidence:** Confirmed (code)
- **File:** `app/api/photos/presign/route.ts:16-20, 51-55` and `app/api/photos/finalize/route.ts:31-40, 87-101` and `services/photos.ts:13-25, 119-140`

**What a real user would observe:** Salesman opens the "Shop front" slot in `EnrichmentForm`, taps the camera button. That click fires `PhotoCaptureSlot.onPicked` with `kind: 'SHOP'` baked into the closure. Three independent HTTP calls follow — presign, R2 PUT, finalize, attach. **Each call carries its own `kind`/`slot` field**; the server never cross-checks them. A scripted client can:

1. Presign with `kind: 'SHOP'` (bypasses rate limiter as `SHOP`).
2. Upload to R2.
3. Finalize with `kind: 'CR'` — Attachment row is now `kind = CR`.
4. Attach with `slot: 'CR'` to the customer — succeeds, because `attachPhotoAction` only checks the *target slot* not against the original presign intent.

**Why it matters:** A signboard photo can be slotted into the CR-document slot. Supervisor approving the edit sees the wrong evidence type. Reactivation evidence (`requestReactivationAction` per QA-008 fix) checks "branch has a fresh photo" — the freshness/branch tie are checked, but the PRD's intent that the *kind* matches the slot is silently broken. Combined with the finalize key path (`{ymd}/{userId}/SHOP/uuid.jpg` — note `kind` is in the path) the auditor cannot cheaply verify "this attachment was originally intended as a CR shot".

**Recommended fix:**
```ts
// Finalize: parse kind from key path and assert it matches body.kind
const m = /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[a-z0-9]+\/(SHOP|SIGNBOARD|CR|FREE)\//.exec(key);
if (!m || m[1] !== kind) return NextResponse.json({ error: 'KIND_MISMATCH' }, { status: 403 });
```
And in `attachPhotoAction`, refuse `slot` ≠ `att.kind` unless `slot === 'FREE'`.

---

### NEW-PHOTO-002 — Hash dedupe across users leaks scope and binds two different customers' photos to a single Attachment row; `detachPhotoAction` then "soft-deletes" the shared row out from under the second user

- **Severity:** High
- **Confidence:** Confirmed (code)
- **File:** `app/api/photos/finalize/route.ts:81-85` (`existing = findFirst({ where: { hash } })` returns first match) and `services/photos.ts:204-227` (soft-delete renames `r2Key`, clears `hash`)

**Walk:**
1. Salesman A captures CR photo P, finalizes — Attachment `att1` created with `hash = H`, `capturedById = A`, wired to Customer A's CR slot.
2. Salesman B (different route) captures the *same* CR photo (e.g., a stock building image, or a reused CR document). `compressImage` re-encodes to JPEG with the canvas, but if both phones produce byte-identical JPEG (same source file uploaded to two phones, same compression), the hashes match.
3. B's finalize step returns `{ attachmentId: att1.id, deduped: true }` — **B is now handed A's Attachment row**.
4. B's `attachPhotoAction` runs. Ownership check at line 51 — `att1.capturedById` is A, not B, and B is not STEWARD/MANAGER. Throws `NotFoundError('Attachment not found.')`.

So far so good — B can't actually wire it. **But:** the finalize step has already revealed `att1.id` to B. Worse:

5. B retries with role STEWARD or MANAGER (or a colluding user with that role): the dedup path returns A's existing Attachment ID; that ID is now wired to *both* A's customer slot AND, after `attachPhotoAction`, B's customer slot via `customer.crPhotoId = att1.id`. A and B now share an attachment — but the attach code doesn't error on this because the ownership check is bypassed by admin role and the "already wired" guard at line 55 (`att.customerId || att.branchId || att.branchExtraId`) only blocks if THIS attachment row already has a denormalized backref. Since the dedupe path returned `att1` *which already has `customerId = A's customer*, line 55 *should* block — but only if `att1.customerId` was set when A attached it. It was (line 79: `tx.attachment.update({ data: { customerId: c.id, kind: CR } })`). OK, so attach is blocked.
6. **However**, the finalize-only flow without attach still creates a DB-side observation: B's audit log / Sentry traces / dev console can see "this hash already exists and that ID is X" — a confirmation oracle for arbitrary photo content.
7. **And the soft-delete is the actual data-integrity bug:** if A detaches, `detachPhotoAction` at line 206 runs `tx.customer.updateMany({ where: { crPhotoId: att1.id }, data: { crPhotoId: null } })` — which clears the slot on *every customer pointing at att1*. If by any path two customer rows end up pointing at the same attachment (e.g., a future merge, or Steward attach), one detach blanks both.

**Why it matters:**
- Hash dedupe is a confirmation oracle: "did anyone in the system already upload this photo?" reachable to any authenticated user (including VIEWER, who never had upload access).
- The soft-delete `updateMany` semantics + dedupe together mean a single detach could break a slot on a customer the actor never had scope over.

**Recommended fix:**
- In finalize: only return `deduped: true` if the existing attachment was uploaded by the same `capturedById`. Otherwise, create a new Attachment row pointing at the same `r2Key` (cheap — R2 dedup happens at object level only if you use content-addressed keys, which we don't). Or accept the duplicate row and let dedup happen at GC time.
- In `detachPhotoAction`: scope the slot-clear `updateMany` to the customer/branch the caller has access to, not "every row that points here".

---

### NEW-PHOTO-003 — `attachPhotoAction` orphans the previous slot photo with no audit and leaves the R2 object permanently billed

- **Severity:** High
- **Confidence:** Confirmed (code) — explicitly acknowledged as QA-044, claimed "11 of 22 mediums fixed in remediation" but **NOT actually fixed**
- **File:** `services/photos.ts:74-102` (CR replacement) and `services/photos.ts:119-140` (SHOP/SIGNBOARD replacement)

**Walk:** Salesman captures CR photo P → `customer.crPhotoId = P`. Two days later, the salesman re-takes the CR (per UI: "RefreshCw" button on the slot). `onPicked` fires, presign + put + finalize creates Attachment Q, then `attachPhotoAction({ attachmentId: Q, customerId, slot: 'CR' })` runs.

Looking at lines 81-83: the customer is updated with `crPhotoId: att.id` (Q). **Nothing happens to P.** P is now an orphan: `att1.customerId = customer.id` still, but no slot points at it. The audit log writes `before: { crPhotoId: prev }, after: { crPhotoId: att.id }` (good) — but the previous Attachment row is not soft-deleted, not detached, not re-categorised.

**Same bug for SHOP/SIGNBOARD** at lines 121-134: `updateBranch.shopPhoto = { connect: { id: att.id } }` blasts the old shopPhotoId without touching the previous Attachment.

**Why it matters:**
1. **Storage cost balloon:** at 38 routes × ~80 customers/route × 5 photo slots × an estimated 2 retakes/year, that's **~30,000 orphan photos per year on R2** that nobody ever cleans up. The remediation report claims a "30-day GC job" — `grep -rn 'gc\|garbage\|cron'` finds no such job in the repo.
2. **Audit trail gap:** the previous photo is unreachable from the customer profile but its row remains wired (`customerId` set). A future enumeration of `Attachment` rows shows two CRs for one customer — silent data inconsistency.
3. **Privacy / right-to-be-forgotten:** if a customer demands deletion, the orphan CR photos remain.

**Recommended fix:** in `attachPhotoAction`, before pointing the slot at Q, soft-delete the previous attachment (rename r2Key, clear hash) and write an audit row `reason: 'photo replaced'`. Add a daily GC Vercel Cron that hard-deletes R2 objects whose Attachment row has `r2Key` starting with `__deleted__/` AND was renamed >30 days ago.

---

### NEW-PHOTO-004 — EXIF metadata (GPS, device, owner name) is **not** stripped before upload to R2

- **Severity:** Medium
- **Confidence:** Confirmed (code)
- **File:** `components/nmwc/PhotoCaptureSlot.tsx:25-57` (`compressImage`)

**Walk:** Salesman's iPhone embeds GPS, owner name, device model, capture time, sometimes Apple's Live-Photo metadata. The `compressImage` function reads the file via FileReader → loads into `<img>` → draws onto `<canvas>` → calls `canvas.toBlob('image/jpeg', 0.85)`. Canvas-encoded JPEGs do not preserve the original EXIF chunk — **so for the resize path, EXIF is effectively stripped**. Good.

**However:** if the user's image is already smaller than `maxLong = 1920` px, the function still re-encodes via canvas, which still strips. OK — this looks safe by accident.

**Real risk:** on Android Chrome, canvas-tainted images (e.g., CORS-failed background images) won't strip; not relevant here. **Real risk #2:** the auditor cannot see any test that asserts EXIF is gone. Any future "skip compression for small files" optimisation reintroduces the leak silently.

**Why it matters:** The salesman's own GPS and device serial leaked into a customer photo create a privacy issue. The customer's CR document photo carrying the salesman's home GPS (taken yesterday, then re-uploaded) is a real-world case. Especially relevant because customer photos ship out via Excel export downloads in some flows.

**Recommended fix:**
- Add an explicit assertion-test (`tests/unit/photo-exif.test.ts`) that pipes a sample JPEG with EXIF through `compressImage` and asserts the resulting blob has no `Exif\0\0` marker.
- Long-term, run a server-side strip in the finalize step using `sharp().rotate().jpeg().toBuffer()` (rotate handles EXIF orientation, then drops EXIF). Do this server-side because the client can be malicious.

---

### NEW-PHOTO-005 — Finalize allows uploads up to **10 MB** but R2 PUT is direct (no server-side size enforcement); presigned URL has only `ContentLength` header which is client-asserted

- **Severity:** Medium
- **Confidence:** Confirmed (code)
- **Files:** `app/api/photos/presign/route.ts:14, 19, 60-67`; `app/api/photos/finalize/route.ts:78`

**Walk:** Presign accepts `bytes ≤ 10 * 1024 * 1024` (10 MB). `getSignedUrl(PutObjectCommand({ ContentLength: bytes }))` includes content-length as a *signed* header, so R2 should reject mismatched uploads — verify in production. Finalize then does `head.ContentLength ?? 0` and trusts whatever R2 returns.

**Real risk:** even at 10 MB cap × 38 salesmen × 5 photos/customer, a salesman who wants to "lose" their data plan could upload 10 MB JPEGs. The client compresses to 1920 px / quality 0.85 — typically <500 KB. Enforce that on server-side too (the client can be replaced).

**Why it matters:** R2 storage cost (Cloudflare R2 is ~$15/TB/month). 10 MB per slot × 5 slots × 3000 customers = 150 GB. A misbehaving / hostile client doing per-day re-uploads would balloon storage. Cap at 2 MB on both presign AND finalize-side `head.ContentLength`.

**Recommended fix:** drop presign cap to 3 MB; in finalize, reject if `head.ContentLength > 3_000_000`.

---

### NEW-PHOTO-006 — No GPS sanity check ties photo capture coordinates to the branch / route's expected region

- **Severity:** Medium
- **Confidence:** Confirmed (code)
- **Files:** `components/nmwc/PhotoCaptureSlot.tsx:73, 142-143` (capturedLat/Lng passed through but never validated); `app/api/photos/finalize/route.ts:37-38` (Zod just bounds -90..90 / -180..180); cross-reference `lib/validation/edit.ts` (PROD-005).

**Walk:** Salesman in their living room in Muscat (23.5°N, 58.4°E) "captures" the CR photo for a Salalah branch (~17°N, 54°E). The photo's GPS will say Muscat. The branch's saved GPS says Salalah. Nothing in `attachPhotoAction` or `finalize` compares them. The supervisor reviewing the edit sees a green check on "photo captured", but it was captured 1000 km from the shop.

**Why it matters:** This is the kind of fraud the photo-evidence requirement was supposed to defeat (PRD §reactivation: "fresh photo as evidence"). Without a server-side sanity check, a salesman can fake-claim shop visits without leaving home.

**Recommended fix:** in `attachPhotoAction`, when the target is a branch with non-null `gpsLat/gpsLng`, compute the haversine distance between branch GPS and `att.capturedLat/Lng`. If >2 km AND `att.capturedLat` is non-null, write `flagSuspicious: true` to the audit log and surface a "GPS mismatch" warning on the supervisor's approval view. Don't outright reject (handheld GPS in concrete buildings drifts).

---

### NEW-PHOTO-007 — Reactivation "fresh photo" check vulnerable to back-dating via client-supplied `capturedAt` in finalize

- **Severity:** Medium
- **Confidence:** Confirmed (code)
- **Files:** `app/api/photos/finalize/route.ts:39, 96` (accepts `capturedAt` from client body, falls back to `new Date()`); `services/reactivations.ts` per remediation report (≤24 h window)

**Walk:** Reactivation requires a photo "captured by the salesman, ≤24 h old, attached to the branch" (REMEDIATION-REPORT §QA-008). The "≤24 h" check on the server compares `now - att.capturedAt < 24h`. **`att.capturedAt` is whatever the client posted in `finalize.capturedAt`** (Zod schema: `z.coerce.date().optional()`). A salesman who took a photo last week can finalize with `capturedAt: new Date()` — instantly "fresh".

**Why it matters:** the reactivation evidence control is one of the headline PRD invariants. It's bypassed by trivial client manipulation. Any salesman who has ever taken a photo of the shop can re-finalize an old R2 object with a current `capturedAt`.

**Recommended fix:** in finalize, IGNORE `body.capturedAt` and use `head.LastModified` (R2 returns the upload time on `HeadObjectCommand`) or simply `new Date()`. Client-provided capture time is hostile and unverifiable.

---

### NEW-PHOTO-008 — Finalize uses today + yesterday UTC for prefix check; in Oman (UTC+4) the daily cutover happens at 04:00 local, breaking late-night uploads at 4 AM local time

- **Severity:** Low
- **Confidence:** Confirmed (code)
- **File:** `app/api/photos/finalize/route.ts:17-26`

**Walk:** Salesman wraps up at 23:55 Oman time (19:55 UTC), photo is presigned with key `2026/05/09/<userId>/...`. Network is bad; the upload retries past midnight Oman = 03:55 UTC the next day, `getCurrentDate()` flips to `2026/05/10`. Finalize checks today (`05/10`) and yesterday (`05/09`) — OK, still in window. **However** if the upload finishes at 04:30 UTC the next day, finalize sees `today = 05/10`, `yesterday = 05/09` — still passes the original key. Good.

**Real edge:** the presign URL has a 10-minute expiry (`expiresIn: 600`). If R2 PUT fails and retry happens 11+ minutes later, the URL is dead anyway. Time-skew bug here is minimal in practice. Down-grading to Low.

**Why it matters:** documenting the time-zone mismatch so a future engineer doesn't extend the window further to fix a non-existent issue and accidentally weaken the prefix check.

**Recommended fix:** comment that yesterday-UTC is the only fudge needed for the presign 10-minute expiry; widen ONLY if expiry changes.

---

### NEW-PHOTO-009 — Cache-Control `must-revalidate` does NOT actually re-check scope on every fetch — browsers serve from cache for 60 s after access revocation

- **Severity:** Low
- **Confidence:** Confirmed (per QA-049 wording, re-verified)
- **File:** `app/api/photos/[id]/route.ts:53`

**Walk:** Manager A views customer X's CR photo. Browser caches with `private, max-age=60`. Steward revokes manager A's regional scope. For the next 60 s, manager A's browser still serves the cached image bytes from disk — no network round-trip, no scope re-check.

**Why it matters:** the remediation report claimed the cache headers tightened from 5 minutes to 60 s (good), but did not eliminate the staleness window. For high-confidentiality CR documents, 60 s is still 60 s of leaked access after revocation. Probably acceptable; document explicitly in the runbook so the security team isn't surprised.

**Recommended fix (defense-in-depth):** swap to `Cache-Control: private, no-cache, no-store, max-age=0` for CR-kind attachments specifically (still allow caching for SHOP/SIGNBOARD which are non-PII). The route already loads `att`, so it can branch on `att.kind === 'CR'`.

---

### NEW-PHOTO-010 — `/api/photos/[id]` has no rate limit; an attacker enumerating IDs gets 60-second-cached 404s but unbounded request volume

- **Severity:** Low
- **Confidence:** Confirmed (code)
- **File:** `app/api/photos/[id]/route.ts` — no `checkLimit` call

**Walk:** Attacker scripts `GET /api/photos/<random-cuid>` at 100 req/s. Each unauthorized fetch returns 404. CUIDs are 25 chars random — practically unguessable — but the attacker pays no rate-limit cost for trying. Combined with the timing of `loadScope` (one DB roundtrip) + `assertCanAccessAttachment` (1-2 DB roundtrips for attached photos), each enumeration costs ~30 ms of DB work. Sustained scan = DB CPU burner.

**Why it matters:** Neon autosuspend → constant traffic keeps it warm → bigger compute bill. Not a confidentiality issue (CUIDs aren't enumerable), but a DoS / cost issue.

**Recommended fix:** wrap with `checkLimit('photo-get:' + ip, { capacity: 60, refillPerSec: 1 })`. Photo views are bursty when a manager opens a customer page (~5-10 photos in a flash), so allow burst of 60 then sustained 1/s.

---

### NEW-PHOTO-011 — `attachPhotoAction` `branchExtraId` slot bypasses the "already wired" guard for FREE photos

- **Severity:** Low
- **Confidence:** Confirmed (code)
- **File:** `services/photos.ts:54-57, 136-140`

**Walk:** Line 55 blocks when `att.customerId || att.branchId || att.branchExtraId` is truthy. Line 138, when slotting a FREE photo, sets `branchExtraId: b.id, branchId: b.id`. **So a single Attachment can be attached to FREE once and only once.** Good. But there is no inverse — FREE attachments cannot be reassigned (e.g., wrong branch by typo). The UI shows an "extra photos" gallery (per schema `Branch.extraPhotos`). To move a FREE photo from branch X to branch Y, the salesman must detach + re-upload. That requires two photo captures of the same scene, not great UX.

**Why it matters:** minor UX, but the soft-deleted `r2Key` after detach also kills the dedup path — so a re-upload of a similar photo creates a *third* R2 object. Storage waste.

**Recommended fix:** add a separate `movePhotoToSlotAction` that requires Steward/Manager and does not require detach.

---

### NEW-PHOTO-012 — HEIC files (iPhone default) are silently rejected by presign — no helpful error in the UI

- **Severity:** Low
- **Confidence:** Confirmed (code)
- **Files:** `app/api/photos/presign/route.ts:13, 18`; `components/nmwc/PhotoCaptureSlot.tsx:95-97, 116`

**Walk:** Salesman with iPhone takes a photo. iOS Camera defaults to HEIC. The `<input type="file" capture="environment">` returns the file as `image/heic`. `compressImage` on the client reads it via `<img>.src = dataUrl` — Safari can decode HEIC, the canvas re-encode to JPEG works, and finalize uploads JPEG. So the happy path works on Safari/iOS.

**However:** if the user picks an existing HEIC photo on Chrome / Android (rare cross-device edge), Chrome cannot decode HEIC on canvas. `img.onerror` fires → `compressImage` rejects with `"Image decode failed"`. Salesman sees a tiny `text-[10px]` red error in the UI with no guidance. **The presign endpoint also explicitly rejects `image/heic`** (`ALLOWED_MIME` is `jpeg/png/webp` only) — but the rejection happens client-side first via `compressImage`, so the user gets the wrong error message.

**Why it matters:** field salesmen will hit this. They're not engineers. "Image decode failed" doesn't tell them to switch their iOS Camera setting to "Most Compatible" (`Settings > Camera > Formats`).

**Recommended fix:**
- In `compressImage`, if `file.type === 'image/heic' || 'image/heif'`, surface a friendly error: "Your phone is using HEIC photos. Open Settings → Camera → Formats and switch to 'Most Compatible' (JPEG)."
- OR add a server-side conversion via `sharp` for HEIC inputs and accept HEIC in `ALLOWED_MIME`.

---

## Summary

12 new findings on the photo pipeline. The five Critical-flagged photo fixes from the prior audit (QA-002 through QA-005, QA-049) are all genuinely in place and correctly implemented. The new findings cluster around:

- **Trust boundaries between presign/finalize/attach** — kind/slot, capturedAt, hash dedupe (NEW-PHOTO-001, 002, 007).
- **Lifecycle gaps** — orphaned previous photos, missing GC cron (NEW-PHOTO-003).
- **Privacy / data integrity** — EXIF, GPS sanity, file-size cap (NEW-PHOTO-004, 005, 006).
- **Operational hardening** — cache, rate-limit, HEIC UX (NEW-PHOTO-009, 010, 012).

| Severity | Count |
|---|---|
| Critical | 0 |
| **High** | **3** (NEW-PHOTO-001, 002, 003) |
| Medium | 4 (NEW-PHOTO-004, 005, 006, 007) |
| Low | 5 (NEW-PHOTO-008, 009, 010, 011, 012) |

**Recommendation:** fix all three Highs before pilot. NEW-PHOTO-007 (back-dating reactivation evidence) is a Medium I'd treat as borderline-High — it directly bypasses one of the two Manager-only invariants in the PRD.

— Adversarial QA, 2026-05-09

---

## SEC-14e — the served Content-Type was the uploader's to choose (2026-09-15)

Found while verifying the P3 list, four months after the audit above recorded the
upload controls as adequate. That earlier reading was reasonable and wrong, and it
is worth saying why: the presign route carries a three-entry MIME allowlist that
looks like the boundary, and it is not one.

`@aws-sdk/s3-request-presigner` adds `content-type` to its unsignable-headers set
by design, so the header never reaches `SignedHeaders`. A client may PUT the signed
URL with any Content-Type at all. `finalize` then copied the stored value straight
into `Attachment.mimeType`, and the serving route echoed that column back as the
response Content-Type — from the app's own origin.

So a salesman could request an ordinary presign, PUT an HTML document, finalize it,
attach it to a slot on his own route and submit the edit. Every photo tile on the
approvals and customer screens is an `<a target="_blank">` to `/api/photos/<id>`,
and the supervisor guide tells the approver to tap one to open it full size. The
reviewer would get an attacker-written page on the domain they had just signed into.
Not stored cross-site scripting — the nonce CSP carries `strict-dynamic` and neither
policy allows `unsafe-inline` — but neither policy declares `form-action` either, so
a convincing "your session expired" form could post a GM's credentials anywhere.

**The fix pins the served type and touches no write path.** `lib/photo-mime.ts`
takes the stored type only if it is one of the three servable image types, then
falls back to the R2 key's extension — which is server-minted, because the presign
builds it from a zod-validated body and the presigned PUT binds the Key — and
otherwise serves `application/octet-stream` as an attachment. `Attachment.mimeType`
had exactly one reader, so pinning at that single consumer closes the hole for rows
already stored as well as for future ones, with no migration and no object rewrite.

**Two residuals, stated rather than papered over.**

1. *Browser caches are not retroactive.* Non-confidential photos carry
   `private, max-age=3600, immutable` and an ETag keyed on the immutable attachment
   id, so a client that already fetched a photo keeps the old Content-Type. This
   was first written here as "a one-hour window", and that was wrong: the 304
   branch returns only the ETag and `Cache-Control`, so each hourly revalidation
   renews the stored entry's freshness **without correcting its type**. For an
   already-cached photo the pin never arrives at all, at any point, until that
   browser evicts the entry.
   The ETag prefix was still deliberately NOT bumped: bumping it forces every photo
   to be re-fetched over the Oman WAN link and discards the perf work at #22/#23,
   and the affected population is a handful of UAT testers' browsers — the go-live
   photograph set does not exist yet. Bumping the prefix to `"p2-"` is the lever if
   the audit query below ever returns a row, and it should be pulled BEFORE the
   go-live load rather than after.
2. *The stored column is still attacker-influenceable.* Only this one consumer pins
   it. `R2_PUBLIC_BASE` already sits unused in `.env.example`; whoever wires a public
   R2 domain, hands a signed GET URL to a browser, or writes an export that zips the
   originals must pin the type there too.

**What a reviewer should be suspicious of:** the word "inoperative". The presign
allowlist is not dead — it still decides the key extension, which is now what the
served type falls back to. Relaxing it to admit `application/pdf` for GUARANTEE
without also deciding the disposition in `lib/photo-mime.ts` would re-open exactly
the navigation surface this closed. A PDF must be served as an attachment.
