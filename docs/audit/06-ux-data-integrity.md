# NMWC-CRM — UX, Mobile and Data-Integrity Audit (Pre-Launch)

**Auditor:** UX / Data-integrity adversarial agent
**Date:** 2026-05-09 (T-1 day to pilot)
**Scope:** Navigation, form UX, error handling, empty states, mobile, performance, cross-cutting integrity invariants. Auth, RBAC, photos, edit lifecycle and imports are owned by sister agents — not re-audited here.
**Methodology:** Walked every flow as a real user; static read of all pages under `app/(app)/**`, `components/nmwc/**`, plus `lib/phone.ts`, `lib/cr.ts`, `lib/codes.ts`, `lib/completeness.ts`, `lib/tz.ts`, `prisma/schema.prisma`.

---

## Verdict

The remediation pass closed every Critical and High finding from the prior audit and the architecture is sound. **However, real users will hit a meaningful number of UX and integrity bugs in the first week of the pilot**, several of which silently corrupt data or block productive work. Below are the findings, in severity order.

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 8 |
| Medium | 14 |
| Low | 9 |

---

## CRITICAL findings

### UXI-001 — Photo "Trash" button hard-deletes another user's CR/shop/signboard slot, no confirm
**Severity:** Critical · **Confidence:** Confirmed (code)
**Files:** `components/nmwc/PhotoCaptureSlot.tsx:173-186`, `services/photos.ts:180-240`

**What a user observes:**
1. Salesman A captures the CR document for customer X. Photo wired into `Customer.crPhotoId`.
2. Days later Salesman A taps the Trash icon on the CR slot to "retake".
3. `detachPhotoAction` is called. It (a) clears `Customer.crPhotoId`, `Branch.shopPhotoId`, `Branch.signboardPhotoId` *anywhere* the attachment id appears, (b) renames the R2 key to `__deleted__/...`, and (c) writes an audit row.
4. There is no confirm dialog. A single misplaced tap on a phone instantly wipes a mandatory photo, drops the customer's completeness, and prevents resubmit until the salesman is back at the shop.

**Why this is Critical:**
- One-finger tap on a 14×14 px button (`p-1`, `h-3.5 w-3.5`) — there is no `onConfirm` modal even though UX-SPEC §5.5 says "Destructive actions confirm. Delete photo, mark closed, force-override → 2-step Dialog."
- The Trash button appears on initially-loaded photos (rendered when `initial` prop is passed → `filled = true`). Salesman accidentally deletes a photo they did not capture, on a customer they cannot re-photograph until tomorrow.
- Worse: the soft-delete renames `r2Key` and clears `hash`. Recovery requires a Steward DB hand-edit (the row is intact but disconnected from any slot).

**Fix:**
1. Wrap the Trash click in a confirm Dialog (Radix/`shadcn`) per UX-SPEC §5.5.
2. Tap target ≥ 44×44 px per UX-SPEC §1.3.
3. Server-side, prevent detach if the slot is the *only* photo of its mandatory kind (CR/SHOP/SIGNBOARD) on a customer that's already at SUBMITTED state — would make a pending edit fail re-validation at approve time.
4. Show a "photo replaced/removed by ${actor}" entry in the customer profile activity feed.

---

## HIGH findings

### UXI-002 — `localStorage` draft auto-save is global per browser; multi-user shared device leaks fields between users
**Severity:** High · **Confidence:** Confirmed (code)
**File:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:166-222`

`draftKey = 'nmwc:draft:${customer.id}'` — keyed only by customer id, not by user id. If two salesmen ever sign in to the same browser (training device, supervisor borrowing a phone, post-pilot device handover), one user's in-progress draft for customer X gets restored when the next user opens customer X's form. The "second user" sees fields they never typed, and on submit those fields ride along into the audit log under their actor id. Cross-user data attribution is broken.

**Fix:** `draftKey = `nmwc:draft:${userId}:${customerId}`. Also clear all `nmwc:draft:*` keys on `logoutAction`.

---

### UXI-003 — Stale draft never warns "the customer changed since you last edited"
**Severity:** High · **Confidence:** Confirmed (code)
**File:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:167-186`

Salesman starts editing at 9am, gets distracted, comes back at 1pm. Steward updated the customer at 11am (e.g. paid CR fee → CR number filled in, payment terms flipped, channel assigned). The draft restorer overwrites the freshly-loaded server data with the 9am `localStorage` snapshot, *silently*. On submit it submits the OLD values (which are now "before" relative to server, generating a diff that REVERTS server-side changes). Supervisor sees no warning — just a regular diff — and may approve, undoing legitimate work.

**Why this is High:** This is the textbook silent data corruption the owner is angry about. There is no "your draft is stale" comparison between `customer.updatedAt` at form mount and the savedAt timestamp embedded in `localStorage`.

**Fix:** Persist `customer.updatedAt` alongside the draft. On restore, fetch a HEAD/lightweight server timestamp; if `server.updatedAt > draft.savedAt`, show a banner "the customer was updated since your draft — discard or merge" and require explicit user choice before restoring fields.

---

### UXI-004 — Submit button does NOT disable on first click; rapid double-tap can fire two server actions
**Severity:** High · **Confidence:** Confirmed (code)
**File:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:583-601`

The Submit button uses `disabled={pending || submitBlocked}`. `pending` is set by `useTransition` *after* the `start()` callback runs. On real Android keyboards / 3G, the first onClick fires before `start()` flips `pending`. Two calls to `submitEditAction` run in parallel.

The DB now has `CustomerEdit_open_per_customer` partial unique index, so the second insert fails with P2002 → ConflictError → user sees "Another submission for this customer was just made." But:
- The first submit may still succeed silently in the background; the user sees only the second's error.
- The user may see "Another submission was just made" while their actual submission also went through, leaving them unsure what happened.
- localStorage draft is cleared on success of the *first* call's promise resolution; if the second call's error fires first, draft is wiped before the user can see the success.

**Fix:** `useRef` locking on the click handler; OR aria-disabled on first click via React state set synchronously before `start()`. Show the result of the FIRST request authoritatively (compare editIds). On ConflictError, refresh and check whether their own submit landed.

---

### UXI-005 — Browser back button after submit shows stale form with full data — accidental re-submit risk
**Severity:** High · **Confidence:** Confirmed (code)
**File:** `app/(app)/customers/[id]/edit/EnrichmentForm.tsx:268-277`

After successful submit, code does `localStorage.removeItem(draftKey)` and `router.push(/customers/${id})`. User hits Back: Next.js renders the cached client component tree. Form fields are still populated (React state), localStorage is empty, but `canSubmit` was passed at server-render time and may now be `false` (because a SUBMITTED edit exists). Component reuses the *initial* `canSubmit` prop with no refresh. User can re-type and re-submit the same content. The DB unique index will reject it, but only after the user has typed something new — they get a confusing ConflictError on a brand new edit attempt. No "this customer has a pending edit" banner because the page wasn't re-rendered.

**Fix:** `router.replace` (not push) after submit; mark the edit page non-cached (`export const dynamic = 'force-dynamic'`); listen to `beforeunload` and re-fetch the pending state. Also add `bfcache` busting via `Cache-Control: no-store` on the edit page.

---

### UXI-006 — Phone normalization: comma/Arabic-Indic digits silently produce broken canonical form
**Severity:** High · **Confidence:** Confirmed (code)
**Files:** `lib/phone.ts:16-39`

Walking the inputs from the prompt:

| Input | Cleaned digits | Result |
|---|---|---|
| `+968 9123 4567` | `96891234567` | ✅ `+96891234567` |
| `0096891234567` | `0096891234567` → strip 00 → `96891234567` | ✅ `+96891234567` |
| `9123 4567` | `91234567` (8) | ✅ `+96891234567` |
| `9123-4567` | `91234567` | ✅ `+96891234567` |
| `+96891234567` | `96891234567` | ✅ `+96891234567` |
| `+968.9123.4567` | `9689123` + `.4567` ⇒ regex strips dots → `96891234567` | ✅ |
| `0968 9123 4567` (typo single zero) | `096891234567` (12) → not 11, not 8 → fallback `+096891234567` | **❌ canonical wrong** |
| `968-91234567 ext 5` | digits-only: `968912345675` (12) → fallback `+968912345675` | **❌ extension grafted onto number** |
| Arabic-Indic digits ٩١٢٣٤٥٦٧ | `cleaned = ''` (regex `/[^\d+]/` does NOT match Arabic-Indic in JS — actually `\d` in JS *does* match `[0-9]` only, NOT Unicode digits) | **`null` returned silently — phone field becomes empty** |
| `+968 9 1 2 3 4 5 6 7` | `96891234567` | ✅ |
| Empty space `   ` | `null` | ✅ |

**Two real bugs:**
1. **Arabic-Indic digits silently dropped.** Many Omani users type Arabic-Indic ٠١٢٣٤٥٦٧٨٩ on Arabic keyboards. `replace(/[^\d+]/g,'')` in V8 does NOT match `\d` to `٠-٩` (JS `\d` is ASCII unless `u` flag is set, which it isn't). Result: `cleaned` is empty → returns null → primary phone considered empty → mandatory check fires AT SUBMIT TIME → ValidationError "Primary phone is required" with no helpful guidance. Salesman has no idea why his perfectly-typed phone was rejected.
2. **No length validation.** A 12-digit input doesn't get rejected — it gets prefixed with `+` and saved. Two bad inputs may collide on `primaryPhoneNorm` on the partial unique index, causing legitimate submits later to ConflictError.

**Fix:**
- Normalize Arabic-Indic to ASCII before stripping: `s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())`.
- After cleaning, REJECT outright if `digits.length` is not 8 or 11; do not silently return a corrupt fallback. The form's submit-time error will be clearer than the unique-index collision later.
- Apply the SAME normalization on the import path (`services/imports.ts`) so legacy Excel sheets with Arabic-Indic numerals (very common) get canonicalized identically.

---

### UXI-007 — Completeness "equipment" sub-score inconsistent with PRD §10
**Severity:** High · **Confidence:** Confirmed (code)
**File:** `lib/completeness.ts:58-67`

PRD §10 says: *"Equipment counts entered (any of 3 ≥ 0): 5"*. The implementation reads:

```ts
if (... ((coolers+stands+bottles) >= 0)) {
  if ((coolers+stands+bottles) > 0) s += 5;
}
```

The outer condition is always true (counts default to 0, sum is always ≥ 0). The inner condition requires sum *> 0*, NOT "any ≥ 0" as the PRD says. So a customer where the salesman has confirmed "no equipment present" — a legitimate, common state — never gets the 5 points. This shaves 5 points off every truly-empty shop's completeness, blocking submission to 100% (mandatory field gate is independent — but the scoreboard underreports completeness for these shops, biasing the manager dashboard against routes with many bottle-shops vs. café-only routes).

Worse: a salesman has no UI affordance to "I confirmed there's no equipment" vs. "I haven't checked yet" — they're both `0`. The comment in the code admits this: `// granted if at least one count > 0 OR salesman explicitly confirmed (we'll handle the explicit case in UI later)`. "Later" = production day.

**Fix:** Add an "Equipment confirmed" toggle on the form (boolean). Persist on Branch. Score the 5 points if the toggle is true OR any count > 0. Without the toggle, the dashboard cannot distinguish "no audit done" from "audit done, found zero".

---

### UXI-008 — Soft-delete invariant: `findDuplicateCandidates` and `submitEditAction.collision` filter on `deletedAt: null`, but `prisma.attachment.findUnique` and reactivation do NOT
**Severity:** High · **Confidence:** Confirmed (code)
**Files:** `services/reactivations.ts:57`, `services/photos.ts:46,183`, `app/(app)/audit/page.tsx:14`, several others

A soft-deleted Attachment now has its `r2Key` rewritten to `__deleted__/.../...`. But the row still has `customerId`, `branchId`, `branchExtraId` references and is found by every `findUnique` and `findFirst` that doesn't filter on `r2Key NOT LIKE '__deleted__%'`. Concrete cases:

1. `services/reactivations.ts:57` — `prisma.attachment.findUnique({ where: { id } })`. A salesman could submit a reactivation whose `attachmentId` points to a deleted Attachment row (capturedAt still passes 24h check, branchId still matches). The "fresh photo evidence" requirement is bypassed because the photo is logically gone — only the metadata row survives. The R2 object is renamed but actual photo not visible to the manager; manager sees blank photo at `/api/photos/[id]` (R2 fetch fails on the new key). UX shows broken image; manager either approves anyway (bad: undoes the closure decision) or rejects the salesman who did nothing wrong.
2. `app/(app)/audit/page.tsx:14` — fetches latest 100 audit rows globally. A Salesman demoted to a different role retains `actor` association; their full name & username appear in any Manager's audit. (Minor, but: audit log shouldn't expose terminated user PII unless the audit row itself is the issue.) Soft-delete here is `User.isActive=false` not `deletedAt`, so this is a related but separate concern.
3. `app/(app)/dashboard/page.tsx:67-79` — region.branches `where: { deletedAt: null }` ✓ but the per-region "completenessScore" array is recomputed from all branches. If a customer is soft-deleted but its branches are not also soft-deleted (no cascade), region average pulls in dead data. Verified: `services/duplicates.ts` merge soft-deletes the loser customer but `tx.branch.updateMany({ where: { customerId: loser.id }, data: { customerId: winner.id } })` re-points them. So far OK, but there is no guard ensuring branches of a soft-deleted customer never persist as orphans.

**Fix:**
- Centralize: `prisma` middleware or extension that injects `deletedAt: null` into every `Customer`, `Branch` query unless an `includeDeleted` opt-in is passed. Prisma "client extensions" support this cleanly.
- For Attachment, add a `deletedAt` column + index, and use it instead of the rewritten `r2Key` sentinel. Filter every Attachment lookup on `deletedAt: null`.

---

### UXI-009 — `/audit` page is hard-capped at 100 rows; no pagination, no filters; useless after first month
**Severity:** High · **Confidence:** Confirmed (code)
**File:** `app/(app)/audit/page.tsx:14-17`

```ts
const logs = await prisma.auditLog.findMany({
  orderBy: { at: 'desc' },
  take: 100,
});
```

No filtering by actor, by entityType, by entityId, by action, by date range. No pagination. PRD §11 #18 says "Audit: full searchable log with filters by actor, entity, date." UX-SPEC §4.18 reiterates "full searchable log with filters". At 38 salesmen × ~50 enrichments × 8 weeks = ~15,000 audit rows in two months. The Manager will see "the last 100 actions" and have no path to the 14,900 prior. Worse, every approve writes ~3 audit rows (claim + apply + log) and every photo attach writes one — actual rate is higher.

A regulator/auditor request "show me everything actor X did in March" cannot be served. The auditor is in the dashboard's blast radius for the legal-defense argument the owner's company will need.

**Fix:** Add filters (actor select, entityType select, action select, date range), server-side `where` building, cursor or page-based pagination, and a CSV export. Index already exists (`AuditLog_actorId_at_idx`, `AuditLog_action_at_idx`).

---

### UXI-010 — `/today` and `/customers` rendered with `take: 200`/`50` and no scroll-restoration; on slow 3G a tap mid-load can navigate to a stale row id
**Severity:** High · **Confidence:** Confirmed (code)
**Files:** `app/(app)/today/page.tsx:40`, `app/(app)/customers/page.tsx:65-76`

Real-user sequence at 7am on flaky 3G:
1. Salesman opens `/today`. Server starts rendering (~3s on 3G p95 per the load test).
2. Page partially streams — header, stats card.
3. Customer list still rendering. Salesman, impatient, taps the stats card — but the header has shifted and the tap lands on a row that hasn't finished hydrating. Next.js Link is server-rendered but `<CustomerCard href={/customers/${id}}>` requires the customer prop to be there.
4. If hydration was incomplete, no navigation; user thinks tap was missed; taps again. Multiple navigations queued. Upon arrival, `/customers/[id]` fetches the customer — could be a different one if the user scrolled while waiting.

The submit flow on `/customers/[id]/edit` itself has no protection against "I started filling fields while the form was still loading photos." `PhotoCaptureSlot.initial` is the SERVER snapshot; while the user types `legalName` the server snapshot may have included a half-loaded `crPhotoId` of `null`. User submits → validator says "CR photo missing" even though it actually exists, because the form passed `customer.crPhotoId: null` from the stale server render.

**Fix:**
- Use `loading.tsx` skeletons that occupy real layout space (avoid CLS — UX-SPEC #10 says "Predictable loading. Skeleton loaders, never blank screens").
- Set `revalidate` / `dynamic = 'force-dynamic'` on `/today` and `/customers/[id]/edit` so server data is always fresh.
- Add a "data fetched at HH:MM" timestamp + manual refresh button on `/today`.

---

## MEDIUM findings

### UXI-011 — GpsCaptureButton has no permission-denied UX, no accuracy warning, no manual-entry fallback
**Severity:** Medium · **File:** `components/nmwc/GpsCaptureButton.tsx:26-51`

The component swallows `err.message` from the GeolocationPositionError into a small red sub-label. There's no:
- Friendly explanation when permission is denied ("You denied location access. To capture GPS for this shop, open Site Settings → Location → Allow.").
- Branch-level warning if `accuracy > 100m` (PROD-005 noted as "should warn"; not implemented anywhere I can find — `gpsAccuracy` is captured and stored but never compared against any threshold in UI or services).
- Manual lat/lng entry fallback for cases where the device's GPS chip is dead (common on cheap Android phones). Field user is locked out from completing this customer at all.
- Timeout messaging: 15s timeout is not super-aggressive; on a clouded indoor shop the salesman may sit confused. Show "Looking for satellites... try moving outside" after 8s.

**Fix:** Add permission-denied modal with phone-OS-specific instructions (detect via UA), a "low-confidence GPS" warning if accuracy > 50m, manual override that flags the entry as `manualGps=true` for the supervisor.

### UXI-012 — GPS-bounds validation rejects legitimate Musandam (governorate exclave at ~26.2°N) on the upper edge — fine; but rejects Salalah airport (16.97°N) at the lower edge with "≥16°N" — also fine; HOWEVER the Salalah area extends to ~16.5°N and the validation is `min(16)`. Marginal but flammable.
**Severity:** Medium · **File:** `lib/validation/edit.ts:60-67`

Stricter than necessary. Real Salalah neighborhoods sit at ~17.0°N. Min 16 is OK with slack. But the south Dhofar coast goes to ~16.7°N; if the salesman is at the airport (~17.04) the bound passes but Sarfait area at 16.66 fails. UX message "≥16°N" is geographically correct but unhelpful to a Salalah salesman who'll have no idea why his GPS reading was rejected. Should show "Your captured location is outside the Oman service area. Recapture or contact your supervisor."

Also, the schema applies the bound **only** if `gpsLat` is present — fine — but the form's mandatory-field gate (`branch.${id}.gps`) is checked client-side BEFORE Zod runs server-side, so a salesman captures a bad GPS, sees green checkmark with `±2000m` accuracy at Null Island (he's traveling abroad? device defaults to last-known?), tries to submit, gets validation error from the server only. Round-trip wasted.

**Fix:** Apply the same bound check in the GpsCaptureButton on the client immediately after capture; show "Out of Oman — recapture" before the salesman thinks the GPS is good.

### UXI-013 — `StepperInput` accepts comma-separator on Android and silently produces NaN
**Severity:** Medium · **File:** `components/nmwc/StepperInput.tsx:38-46`

```tsx
<input type="number" ... onChange={(e) => set(Number(e.currentTarget.value))} />
```

`type=number` on Android allows comma decimal separator (Oman locale typically is en-GB/en-OM which uses period, but Arabic ar-OM uses Arabic-Indic comma). Salesman types "12,5" in coolers. `Number("12,5") === NaN`. `set(NaN)` runs, `if (NaN < min)` is false, `if (NaN > max)` is false, so it sets value to NaN. Re-renders with `value={NaN}` which React warns about and the field appears empty. No error message; field just goes blank after they typed a number.

Also: `inputmode` is not set, so the keyboard for `coolers` shows the full keyboard (with letters) instead of a numeric pad. UX-SPEC §1.3 says one-handed mobile usage; full keyboard wastes screen.

**Fix:** `inputMode="numeric" pattern="[0-9]*"`, parse with `parseInt(value, 10)`, fall back to current value on NaN.

### UXI-014 — CR normalization loses meaningful punctuation: `1234567/2024` and `1234567-2024` collide
**Severity:** Medium · **File:** `lib/cr.ts:10-14`

`replace(/[\s\-_/.]+/g, '')` collapses any of `/  - _ . space` into nothing. Two distinct CRs `1234567/2024` and `12345672024` (the latter being a typo'd CR) produce identical `crNumberNorm`. `prisma.customer.findFirst({ where: { crNumberNorm: ... } })` for dedupe will report a false positive. Steward is forced to manually verify every match. At our scale tolerable; at scale a problem.

PRD §8 says: *"cr_number: optional; if present, 5–50 chars, alphanumeric + `-`; auto-normalized (uppercase, strip spaces)"*. The PRD says strip spaces only — not strip hyphens, slashes, dots. The implementation is more aggressive than spec.

**Fix:** Match the spec: only strip whitespace, normalize case. If dedupe wants laxer comparison, do it at query time with similarity(), not by losing data in storage.

### UXI-015 — Arabic search on `/customers` works only by coincidence
**Severity:** Medium · **File:** `app/(app)/customers/page.tsx:54-60`

```ts
where.OR = [
  { legalName: { contains: q, mode: 'insensitive' } },
  { nmwcCode:  { contains: q, mode: 'insensitive' } },
  { primaryPhone: { contains: q } },
];
```

`mode: 'insensitive'` works ASCII-only in Postgres' `ILIKE`. Arabic case-folding is identity (no upper/lower distinction in Arabic), so the practical result is `LIKE '%q%'`. This works for substring Arabic strings as long as the input bytes match exactly. But:
- No tatweel normalization (kashida): user types "محمد" but DB has "م ـ ح ـ م ـ د" (with tatweel) — no match.
- No alif normalization (ا/أ/إ/آ folded): "احمد" vs "أحمد" don't match.
- No diacritic stripping.
- No trigram/fuzzy index — the `legalName` index is a btree on the column; `LIKE '%foo%'` is a sequential scan even with the index.

PRD says no Arabic UI/RTL in v1, but legacy data legalName column **will contain Arabic characters from the Excel master**. Salesman searching for "Lulu" finds it. Searching for "العائلة" may or may not find the row depending on import-time tatweels. Very fragile.

**Fix:** Use `unaccent`/custom trigram index on a normalized column. Pre-normalize the search term.

### UXI-016 — Pagination `<a href>` URL preserves filters but uses `&` separator with empty status, builds malformed querystring
**Severity:** Medium · **File:** `app/(app)/customers/page.tsx:131-141`

```tsx
?q=${encodeURIComponent(q)}&status=${statusFilter}&page=${page-1}
```

When `statusFilter = ''` and `q = ''`, URL becomes `?q=&status=&page=2`. Functional but ugly and extra bytes. More importantly: salesmen who navigate from `/today` -> filter to "ACTIVE" -> page 5 -> tap a customer -> hit Back will land on page 5 only because Next.js cached it. The URL is preserved. Good. But the search input `defaultValue={q}` is empty by Next.js form re-render, while the `?q=foo` is in the URL. After a back-nav, the form looks empty even though the page is still filtered. User adds a new search term and submits; result is double filter. Confusing.

Also: the prev/next links use `href` (full reload) instead of Next.js `<Link>`, killing client-side cache. Each pagination tap is a fresh server render (~500ms-1s). Easily fixable.

**Fix:** Use `<Link>` and a client-side router for pagination; canonicalize URL (strip empty params) with a small helper.

### UXI-017 — `/team` shows orphans when supervisor was deactivated, but doesn't show salesmen whose supervisor was reassigned
**Severity:** Medium · **File:** `app/(app)/team/page.tsx:14-25`

Query: `prisma.user.findMany({ where: { supervisorId: session.user.id, role: SALESMAN } })`. If a salesman's `supervisorId` was changed (Manager moved them under a different supervisor mid-day), the OLD supervisor no longer sees them on `/team` — fine. But this means:
1. No "transition" indicator: the previous supervisor doesn't know one of their salesmen was moved.
2. The previous supervisor's `/approvals` queue may still show edits where `submittedBy.supervisorId == oldSupId` only if the **schema captures supervisor at edit time** — it does NOT (the join is live). So if salesman submitted an edit at 8am, then was reassigned at 10am, the OLD supervisor can no longer approve it (queue filters `submittedBy.supervisorId = me.id`). The new supervisor sees a pending edit but no context. Edit becomes stuck in limbo until rejected by the new supervisor or escalated to a Manager.
3. Soft-deleted (`isActive=false`) supervisor: their salesmen still have `supervisorId` pointing at the inactive record. The salesman's submitted edits cannot be approved — `canApproveSpecificEdit` checks active session role only, not the assigned supervisor's status. Stuck.

**Fix:** When reassigning a supervisor, transfer all `state=SUBMITTED` edits to the new supervisor with an audit trail. When deactivating a supervisor, require the Manager to also reassign their team.

### UXI-018 — Manager dashboard "leaderboard" shows 100% for empty routes (or drops them), depending on path
**Severity:** Medium · **File:** `app/(app)/dashboard/page.tsx:94-100`

```ts
const scores = r.branches.map((b) => b.completenessScore);
const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
```

A route with zero branches gets `avg = 0` and shows up at the bottom of "Routes needing attention" with `0%`. From the user's perspective, "this route is failing" — but actually it has no customers, so the score is meaningless. UX-SPEC §4.12 says "Top performing routes (table)" — there's no opt-out for empty routes. Conversely, a route with one branch at 100% rockets to the top, beating routes with 30 branches averaging 95%.

The bottom-five list is `[...routeStats].reverse().slice(0,5)` — that includes empty routes prominently. Manager sees "Route XYZ is at 0%" and may accidentally start a productivity intervention on a route that has no work at all.

**Fix:** Filter out routes with `count === 0` from the leaderboards. Or surface them in a separate "Empty routes" panel.

### UXI-019 — Notes field accepts 5000 chars with `maxLength` HTML attribute only — paste of 50 KB is silently truncated client-side, but if a Manager pastes via DevTools or import path, server allows up to 5000 too — no error message, content just clips
**Severity:** Medium · **Files:** `EnrichmentForm.tsx:345`, `lib/validation/edit.ts:47`

`<textarea maxLength={5000}>` blocks paste at the input level — browser truncates. No "Note was truncated to fit the 5000 character limit" toast. Server-side Zod also caps at 5000 with `.max(5000)` — submitting a 5001-char string produces a generic "String must contain at most 5000 character(s)" Zod error in red text under the field. Salesmen who've pasted will not understand.

PRD §8 says "5000 chars max" is the rule. Non-blocking; just polish.

**Fix:** When characters exceed 4500, show a counter "4523 / 5000". On overflow, show a modal explaining and offer "trim" / "edit again".

### UXI-020 — Empty state on `/work` for managers who have no stale items uses a sparkle emoji ✨ — fails CSP if emojis are in a Content-Security-Policy script block (they aren't here, fine), but fails accessibility (no ARIA, no alt)
**Severity:** Medium · **File:** `components/nmwc/EmptyState.tsx`, `app/(app)/work/page.tsx:120`

Title literally `"All clear ✨"`. Screen reader announces it as "All clear sparkles emoji". Acceptable for a friendly empty state but not WCAG 2.1 AA compliant per PRD §15. UX-SPEC §1.4 specifies icons via lucide-react, not Unicode emoji.

Also: Manager work page shows "stale approval (>3 days)" — but this is a Manager-only feature in v1 since there's no team filter. A manager with 100 supervisors will see all of their stale approvals globally, not scoped to their managed regions. Inconsistent with the dashboard's region scoping. (Cross-cutting: covered at the system level by RBAC agent? Verify.)

**Fix:** Replace ✨ with a `<CheckCircle2 />` icon. Add `aria-label`. Scope `/work` for Manager to managed regions.

### UXI-021 — Channel/sub-channel: form clears `subChannelId` when channel changes, but server validation does NOT enforce that selected sub-channel belongs to the selected channel
**Severity:** Medium · **File:** `lib/validation/edit.ts:28-29`, `services/edits.ts`

PRD §8 says: *"sub_channel_id: must reference an active SubChannel whose channel_id = customer.channel_id (Zod superRefine cross-validation)"*. The schema declares `subChannelId: z.string().cuid().optional()` with no `superRefine`. A salesman with the form's two `<select>`s in dirty state could submit a subChannelId from a *different* channel (manipulating client state, or a stale draft restored after channel change). DB happily stores the inconsistency.

**Fix:** Add `.superRefine(async (data, ctx) => { if (data.subChannelId && data.channelId) verify against DB; })` OR enforce at write time in `submitEditAction`.

### UXI-022 — Mobile keyboard for `gpsLat/gpsLng` fields not enforced (the form doesn't show editable lat/lng — only `GpsCaptureButton`); but if a future "manual GPS" UI is added, the fields will accept comma decimals on Android
**Severity:** Medium (preventive) · **File:** `lib/validation/edit.ts:59-68`

Currently lat/lng are only set via `GpsCaptureButton` calling `pos.coords.latitude` (always a JS number). No manual entry — so the comma-vs-period concern from the prompt question is currently moot. **However**, if anyone adds a manual override, the same `Number(...)` pattern from the StepperInput will silently NaN on comma. Document this and gate any future manual-entry input behind `inputMode="decimal"` and explicit comma-to-period replacement.

### UXI-023 — `lastEditedById` is required by app code path on every customer/branch update but field is `String?` (nullable) in the schema; system jobs (cron / import) do not set it — orphan rows after promote
**Severity:** Medium · **File:** `prisma/schema.prisma:212,261`, `services/imports.ts` (promote path)

`Customer.lastEditedById` is nullable (`String?`). The promote path writes `lastEditedById = stewardId` (good). But `dailyJobs` (if any) and the `applyEditChanges` use `actorId` which IS the steward/manager session. If a system action ever needs to be attributed to "system", there's no system-user CUID; the field will be `null`, the Customer profile will show "Last edited by: —". Forensics gets fuzzy.

**Fix:** Seed a `nmwc-system` user with role STEWARD `isActive=false` and use it for any non-user-attributable writes.

### UXI-024 — Photo capture `accept="image/*"` on iOS Safari accepts HEIC; PhotoCaptureSlot's `compressImage` re-encodes to JPEG via canvas — works, but the data URL roundtrip uses `FileReader.readAsDataURL` for a 12 MB HEIC, which may OOM on a 2GB-RAM iPhone 8
**Severity:** Medium · **File:** `components/nmwc/PhotoCaptureSlot.tsx:25-57`

iPhone 8 / SE (1st gen) / older Androids will read 4032×3024 12MB HEIC into a base64 data URL (~16 MB string), then create an `Image`, then draw to canvas, then `toBlob`. Two large strings live in memory simultaneously. On a low-RAM device this can crash the tab.

UX impact: salesman's tab refreshes, draft is restored, but the photo isn't — they wonder if it worked.

**Fix:** Use `URL.createObjectURL(file)` + `<img>` + canvas → blob — never reads as base64. ~1/3 the memory.

---

## LOW findings

### UXI-025 — `/today` subtitle uses `new Date().toLocaleDateString('en-GB', ...)` on the server; in UTC the date may be yesterday during Oman 00:00–04:00
Same root cause as PROD-004 but for the *display* of date, not the day-of-week selector. The DAY_OF_WEEK is fixed (uses `omanDayOfWeek()`), but the subtitle text says "Saturday, 9 May" rendered from the server's UTC clock. After Oman midnight, subtitle says "Friday, 8 May" while the visit list says "today is SAT". User confusion. Use `omanDateISO()` and format Oman-locally.

### UXI-026 — `CompletenessRing` shows `pct` rounded to integer but server uses `Math.round` differently: 49.5 → 50 (medium band), but PRD says <50 is low — boundary off-by-one
`completenessBand`: `score >= 50 → medium`. With `pct = Math.round(49.5) = 50`, this passes medium. PRD §10 doesn't define the boundaries explicitly (just "low/medium/high"). Verify with owner.

### UXI-027 — `formatBranchCode` doesn't enforce uniqueness across collisions; if parent has 99 branches, branch 100 → `PARENT-100` (3 digits) but `padStart(2,'0')` doesn't pad — shows `100`, looks fine, but past 99 the format is inconsistent
`String(100).padStart(2,'0') === '100'`. Harmless visually but breaks any downstream parser that expects a 2-digit suffix. v1 unlikely to hit 99 branches per customer; doc the limit.

### UXI-028 — `formatCustomerCode` produces `NMWC-2026-000001` but yearly counter rollover is not enforced anywhere I can find
Comment says "caller is responsible for atomicity". `services/imports.ts` — does it use a sequence? Need to verify the import path generates non-colliding codes under concurrent steward uploads. (Not in scope for this agent — flagged for imports agent.)

### UXI-029 — `StatusBadge` has no aria attributes; screen readers announce only the visible text
WCAG fail; PRD §15 requires AA. Add `<span aria-label="Status: Active">`.

### UXI-030 — `EmptyState` describes filter as "Try clearing filters or searching for a different term." but doesn't include a "Clear filters" button
UX-SPEC §5.7: "Empty states aren't blank. Always a friendly message + a CTA pointing somewhere useful." Missing the actionable CTA.

### UXI-031 — `/rejected` shows the most recent decisionReason but if a salesman re-submits and gets re-rejected, the old decisionReason is overwritten on the same CustomerEdit row (in `rejectEditAction`)
Wait — actually `submitEditAction` always creates a NEW CustomerEdit. Good. But `rejectEditAction` updates an existing one. Resubmission flow: NEEDS_CORRECTION → user resubmits → creates a NEW edit → SUBMITTED. Old NEEDS_CORRECTION row is stranded. Verified: no overwrite, but the user's `/rejected` view shows the OLD reason indefinitely (it's `state: 'NEEDS_CORRECTION'`). After the new edit is approved, the old NEEDS_CORRECTION row never transitions; clutters `/rejected` permanently. Should auto-resolve when a new edit on the same customer goes APPROVED.

### UXI-032 — Print/PDF: no `/print` pages, no reports route — confirmed by glob; OK for v1 but missing per PRD §13.2 "Excel export" — only Excel, no print, fine.

### UXI-033 — Number formatting mostly uses `toLocaleString()` (no locale arg → server locale, which is C/POSIX on Vercel). KPIs render as `1,234` only because the default V8 locale for Vercel happens to be `en-US`. If Vercel ever changes runtime, `12345.toLocaleString()` becomes `12345`. Pin via `('en-GB')`.

---

## Cross-cutting integrity invariants — verification matrix

| Invariant | Holds? | Notes |
|---|---|---|
| `Customer.deletedAt: null` filter on every read | **Mostly** | `/customers/[id]/page.tsx:26` ✓ ; `/customers/page.tsx:39` ✓ ; dashboard ✓; duplicates ✓; **edit page ✓**; **/today ✓** (filters branches' deletedAt only — but a customer soft-deleted while branches are active wouldn't show) |
| `Branch.deletedAt: null` filter | **Mostly** | Most paths filter; `/dashboard` filters ✓; reactivation uses `findFirst({where: {id, deletedAt: null}})` ✓ |
| `Attachment` soft-delete via r2Key sentinel | **Inconsistent** | Many lookups by `findUnique({id})` see soft-deleted attachments — see UXI-008 |
| One open SUBMITTED edit per customer | DB-enforced ✓ | partial unique index, P2002 → ConflictError translated. UI doesn't re-fetch this state on Back-nav (UXI-005) |
| Phone uniqueness across customers | DB-enforced + app re-check at submit AND approve ✓ | But phone normalization gaps (UXI-006) can produce non-canonical pairs that miss the index |
| Sub-channel ⊆ channel | **Not enforced server-side** | UXI-021 |
| GPS in Oman bounding box | App-enforced ✓ but client-side feedback missing | UXI-012 |
| Photo `capturedById === me` for write | ✓ in services/photos.ts | But detach allows scope-based access for non-capturer (UXI-001) |
| `lastEditedById` set on every write | App-enforced ✓ in customer/branch update paths | But system actions have no actor (UXI-023) |
| Reactivation requires fresh photo | App-enforced ✓ | But Attachment soft-delete bypass (UXI-008) |
| Completeness score reflects PRD weights | **Partial** | Equipment sub-score off (UXI-007) |

---

## Top recommendations for go-live (priority order)

1. **UXI-001** — Add a confirm dialog before photo deletion. Most likely real-world bug to hit users in week 1 (one bad tap = redo a customer visit).
2. **UXI-006** — Fix phone normalization for Arabic-Indic digits, reject ambiguous lengths instead of silently corrupting.
3. **UXI-002 / UXI-003** — Scope localStorage drafts to userId; add stale-draft warning on restore.
4. **UXI-005** — `router.replace` after submit; mark edit page non-cached.
5. **UXI-009** — `/audit` filters + pagination before the log gets unwieldy.
6. **UXI-007** — Fix or document the equipment sub-score; add the "confirmed empty" toggle.
7. **UXI-008** — Stop using r2Key rename as the soft-delete sentinel; add a real `deletedAt` column.
8. **UXI-021** — Server-side superRefine on channel/sub-channel.
9. **UXI-013** — Numeric `inputMode` on StepperInput; reject NaN input.
10. **UXI-018** — Filter empty routes from leaderboards.

The remaining items are pilot-week polish, not pilot-blockers.

---

## Note on the prior agent's report

I cross-checked the previous QA-AUDIT and the REMEDIATION-REPORT. The remediation pass closed the auth/RBAC criticals well. **None of the bugs in this report are duplicates of QA-001…QA-063 from the prior audit.** The UX-and-integrity layer was not the previous engagement's focus, and the pre-flight checklist failed to catch these because the team prioritized RBAC/security correctness first (correctly so).

Real users will hit UXI-001, UXI-005, UXI-006, UXI-013, UXI-018 in the first week with high confidence. UXI-002 will hit any deployment to a shared/training device. UXI-003 is the silent corruption the owner is worried about.

— UX & Data-Integrity audit, 2026-05-09
