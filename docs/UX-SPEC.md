# NMWC Customer Master — UX Specification (Phase 3)
**Version:** 1.0
**Date:** 2026-05-09
**Status:** For owner sign-off

This document specifies the visual system, layout primitives, navigation, and screen-by-screen content for v1. It does not include pixel-perfect mockups — we'll build straight to React components from these specs and iterate visually together.

---

## 1. Brand & Visual System

### 1.1 Brand mark
- Wordmark: **"NMWC"** in bold weight, all uppercase
- No icon/logo file in v1; the wordmark on a white or blue background is the brand
- Tagline (small, optional): "Customer Master"

### 1.2 Color palette (Tailwind tokens)

| Role | Token | Hex | Use |
|---|---|---|---|
| Primary | `blue-600` | #2563EB | Primary buttons, links, active state, brand |
| Primary hover | `blue-700` | #1D4ED8 | Hover/pressed primary |
| Primary subtle | `blue-50` | #EFF6FF | Card backgrounds, selected rows |
| Primary border | `blue-200` | #BFDBFE | Borders on primary surfaces |
| Brand top-bar | `blue-900` | #1E3A8A | Top navigation bar background |
| Success | `emerald-600` | #059669 | Approved, complete |
| Warning | `amber-500` | #F59E0B | Partial, pending review |
| Danger | `red-600` | #DC2626 | Rejected, errors, hard validations |
| Info | `sky-500` | #0EA5E9 | Informational badges |
| Neutral text | `slate-900` / `slate-600` / `slate-400` | — | Headings / body / muted |
| Neutral surfaces | `slate-50` / `white` | — | App background / cards |
| Border | `slate-200` | #E2E8F0 | Standard dividers |

### 1.3 Typography
- Font: **Inter** (or Vercel-default `font-sans`)
- Headings: 600/700 weight, `tracking-tight`
- Body: 400/500 weight
- Mobile sizes: H1 24px, H2 20px, body 16px, small 14px, tiny 12px
- Min tap target: 44×44px (Apple HIG); buttons default to 48px

### 1.4 Iconography
- **lucide-react** icon set
- 20px in body, 24px in buttons, 16px in tiny chips
- Common: `MapPin` (GPS), `Camera` (photo), `Pencil` (edit), `Check` (approve), `X` (reject), `AlertCircle` (rejected/warning), `Search` (filter), `LogOut`

### 1.5 Shadows & elevation
- Cards: `shadow-sm` rest, `shadow-md` on hover
- Modals: `shadow-2xl`
- Sticky bars: `shadow-[0_-2px_8px_rgba(0,0,0,0.04)]` (inverted)

### 1.6 Spacing & corners
- Spacing scale: Tailwind defaults (4 = 1rem)
- Corner radius: 8px (cards), 6px (buttons), 4px (inputs)

---

## 2. Layout Primitives

### 2.1 Mobile (Salesman/Supervisor primary)
```
┌──────────────────────────────────┐
│ [☰] NMWC          [🔔3] [👤]    │ ← Top bar (blue-900, white text), sticky
├──────────────────────────────────┤
│                                  │
│  Page content                    │ ← Scrollable, max-w-screen-sm
│                                  │
│                                  │
│                                  │
├──────────────────────────────────┤
│  [Today] [Customers] [Work] [Me] │ ← Bottom tab bar (only Salesman)
└──────────────────────────────────┘
```
- Top bar: brand mark (left) · notifications bell with count badge · profile avatar (right)
- Bottom tabs (Salesman only, 4 items): `Today`, `Customers`, `Work`, `Me`
- Sticky action footer: appears on form pages with primary action ("Submit") + secondary ("Save Draft")

### 2.2 Desktop (Manager/Steward primary, Supervisor co-primary)
```
┌────────────────────────────────────────────────────────────┐
│  NMWC                                          [🔔3] [👤]  │ ← Top bar (full width)
├──────────┬─────────────────────────────────────────────────┤
│          │                                                 │
│ Sidebar  │  Page content                                   │
│ nav      │                                                 │
│ (240px)  │                                                 │
│          │                                                 │
│ Logout   │                                                 │
└──────────┴─────────────────────────────────────────────────┘
```
- Sidebar: collapsible, role-based items
- Page content: fluid up to `max-w-screen-2xl`

### 2.3 Component library (shadcn/ui)
Used everywhere: `Button`, `Input`, `Label`, `Select`, `Textarea`, `Card`, `Badge`, `Sheet` (mobile drawer), `Dialog`, `Tabs`, `Toast`, `Avatar`, `Separator`, `Progress`, `ScrollArea`, `Skeleton`, `Table` (desktop), `DropdownMenu`, `Popover`, `Form` (with `react-hook-form` + Zod resolver).

Custom NMWC components on top:
- `<CompletenessRing value={75} />` — circular progress indicator
- `<StatusBadge status="ACTIVE | CLOSED | SUSPENDED | PENDING | REJECTED" />`
- `<PaymentTermsPill terms="CASH | CREDIT" />` — visually distinct
- `<PhotoCaptureSlot kind="SHOP" required />` — single tap → camera → preview → confirm
- `<GpsCaptureButton />` — single tap → captures lat/lng/accuracy → shows coords
- `<DiffField label="Phone" before="123" after="456" />` — supervisor approval view
- `<EditableField label="Name" value="..." readOnly={isCreditAndSalesman} />` — pencil to edit

---

## 3. Navigation Map

### Salesman (5 destinations + login)
```
/login
└── /today (default after login)
    ├── /customers
    │   └── /customers/:id
    │       ├── /customers/:id/edit
    │       ├── /customers/:id/branches/:bid/edit
    │       └── /customers/:id/add-branch
    ├── /work (work items inbox)
    ├── /rejected (subset of /work, kept as direct link from notifications)
    └── /profile
```

### Supervisor
```
/login
└── /approvals (default)
    ├── /approvals/:id
    ├── /reassignments
    ├── /team
    │   └── /team/:userId
    ├── /work
    └── /profile
```

### Manager
```
/login
└── /dashboard (default)
    ├── /reactivations (closed-shop reactivation review queue)
    ├── /users
    ├── /routes
    ├── /audit
    ├── /work
    └── /profile
```

### Data Steward
```
/login
└── /import (default)
    ├── /import/:batchId
    ├── /duplicates
    ├── /export
    ├── /work
    └── /profile
```

---

## 4. Screen Specifications

For each screen below: purpose, content, primary action, edge cases. ASCII layouts where it helps.

### 4.1 `/login`
**Purpose:** Authenticate user.
**Content:** NMWC wordmark, "Sign in" heading, username field, password field, "Forgot password?" link, primary button.
**Primary action:** Submit credentials.
**Edge cases:** Wrong creds → inline error under password ("Invalid username or password"). Locked account → message + steward contact info. Rate-limit reached → friendly cooldown message.

```
┌─────────────────────────┐
│                         │
│        NMWC             │
│   Customer Master       │
│                         │
│   ┌─────────────────┐   │
│   │ Username        │   │
│   └─────────────────┘   │
│   ┌─────────────────┐   │
│   │ Password    👁️ │   │
│   └─────────────────┘   │
│                         │
│   [    Sign in     ]    │
│                         │
│      Forgot password?   │
│                         │
└─────────────────────────┘
```

---

### 4.2 `/today` — Salesman home (most-used screen)
**Purpose:** Show today's customers in route order, fastest path to start enriching.
**Content:**
- Greeting: "Good morning, {firstName}" + date
- Stats strip: 3 mini-cards — `Visited today: N`, `Pending approval: N`, `Rejected: N`
- "Today's customers" list (sorted by Day-of-Visit = today, then sequence)
  - Per row: customer name (bold), branch name (muted), small address line, `<CompletenessRing />` (top-right), `<PaymentTermsPill />`, status icon
  - Tap row → `/customers/:id`
- Empty state: "No customers due today. View full route →"

**Primary action:** Tap a customer row.

```
┌──────────────────────────────────┐
│ NMWC          🔔3      👤        │
├──────────────────────────────────┤
│ Good morning, Ali                │
│ Saturday, May 9                  │
│                                  │
│ ┌──────┐ ┌──────┐ ┌──────┐      │
│ │  4   │ │  2   │ │  1   │      │
│ │Visit.│ │Pend. │ │Rejec.│      │
│ └──────┘ └──────┘ └──────┘      │
│                                  │
│ Today's customers (12)           │
│                                  │
│ ┌──────────────────────────────┐│
│ │ AL HARAM SUPERMARKET    ⭕75││
│ │ Main branch · CASH       ⚠️ ││
│ │ Salalah, Sultan St           ││
│ └──────────────────────────────┘│
│ ┌──────────────────────────────┐│
│ │ NIZWA HOTELS LLC        ⭕30││
│ │ Branch 2 · CREDIT        🆕 ││
│ │ Nizwa Souq                   ││
│ └──────────────────────────────┘│
│  ...                             │
├──────────────────────────────────┤
│ [Today][Customers][Work][Me]    │
└──────────────────────────────────┘
```

---

### 4.3 `/customers` — full route list
**Purpose:** Browse / search all customers on the salesman's route.
**Content:**
- Search bar (top, sticky): searches name, code, phone
- Filter chips: `All`, `Pending`, `Rejected`, `Complete`, `Closed`
- Day-of-visit filter (dropdown: Sat–Fri, default = All)
- List (same row format as `/today`)
- Infinite scroll or pagination (200/page)

**Edge cases:** Empty filter → "No customers match these filters." Slow connection → skeleton rows.

---

### 4.4 `/customers/:id` — customer profile (read view)
**Purpose:** See everything about a customer at a glance, choose to edit.
**Content (cards in this order):**

1. **Header card**
   - Customer name (large) · `<PaymentTermsPill />` · status badge
   - NMWC code · channel/sub-channel · last edited
   - Big `<CompletenessRing />` 0–100
   - Primary CTA: `[Enrich / Edit]` (full-width on mobile)
   - Secondary actions: `Mark Wrong Route`, `Mark Closed`

2. **Identity card**
   - Legal name, CR number, CR document photo (thumbnail; tap to lightbox)
   - Locked indicators if Credit (gray pencil with lock icon)

3. **Channel & Classification card**
   - Channel · sub-channel · day of visit

4. **Contact card**
   - Phone (tap to call), alt phone, contact person + role

5. **Branches list** (if multiple)
   - Each branch row: name, route/region, completeness, status
   - `[+ Add Branch]` button at bottom

6. **Per-branch view (when single, expanded inline; multi-branch → tap row to drill)**
   - Address, area description, GPS pin (mini-map preview), opening hours, delivery window
   - Photos: shop, signboard, +2 free (4-thumbnail row)
   - Equipment: 3 counters

7. **History card**
   - Last 5 changes: who, what fields, when, decision
   - "View full history →"

**Primary action:** `[Enrich / Edit]` opens `/customers/:id/edit`.

---

### 4.5 `/customers/:id/edit` — enrichment form (the workhorse)
**Purpose:** The form salesmen will use 50+ times per week. Must be fast and forgiving.

**Layout:** Vertical accordion of 6 sections, each collapsible. Section header shows ✓/⚠/❗ status. Sticky footer with `[Save Draft]` + `[Submit for Approval]`.

**Sections (in order):**

1. **Identity** (collapsed by default if Credit, since locked)
   - Legal name (read-only if Credit/Salesman) — pencil disabled
   - CR number (read-only if Credit/Salesman)
   - Payment terms badge (read-only always)
   - CR photo: `<PhotoCaptureSlot kind="CR" required />`

2. **Channel & Classification**
   - Channel `<Select>` (7 options)
   - Sub-channel `<Select>` (filtered to selected channel; cleared on channel change)
   - Day of visit `<Select>` (Sat–Fri)

3. **Contact**
   - Primary phone (tel input, validated on blur)
   - Alt phone (optional)
   - Contact person, role

4. **Location** (per branch)
   - Address (textarea)
   - Area description / landmark (optional)
   - **`[📍 Capture GPS]`** button → reads `navigator.geolocation` → shows captured lat/lng/accuracy as a chip with `[Recapture]`
   - Opening hours, delivery window (optional)

5. **Photos** (per branch)
   - 5 slots in a 2×3 grid: SHOP (req), SIGNBOARD (req), CR (req — appears in Identity card too, mirrored), FREE 1, FREE 2
   - Each slot: tap empty → opens device camera; tap filled → preview with `[Retake]` `[Delete]`

6. **Equipment**
   - Coolers count: stepper `[-] 0 [+]`
   - Stands count: stepper
   - Empty bottles count: stepper

**Validation behavior:**
- Inline (not blocking) under each field as user types
- Submit button disabled until completeness ≥ 100% OR closed-shop flag is on
- Tooltip on disabled submit: "Need: GPS, signboard photo" (lists missing items)

**Auto-save:**
- IndexedDB write on every field change (debounced 1s)
- "Draft saved" subtle toast every save
- Banner on top if offline: "Offline — drafts saved locally"

**Sticky footer:**
```
┌─────────────────────────────────────┐
│  [ Save Draft ]   [ Submit ▶ ]      │
└─────────────────────────────────────┘
```

---

### 4.6 Photo capture flow (used in 4.5)
**Purpose:** Make photo capture frictionless.
**Flow:**
1. Tap empty slot.
2. `<input type="file" accept="image/*" capture="environment">` opens native camera.
3. Returned image shown in a preview modal with `[Retake]` `[Use this]`.
4. On Use: client compresses to ≤2 MB / max 1920px long edge, strips EXIF except GPS, computes hash, uploads to R2 via presigned URL with progress bar.
5. On success: thumbnail appears in slot.
6. On failure: red banner, retry button, queued for offline retry.

---

### 4.7 `/work` — Work Items inbox (NEW)
**Purpose:** Single page where each user sees what needs their attention. Replaces email.
**Content:** List of work items, each card showing:
- Icon + category label (Rejected / Pending Approval / Reactivation / Stale Draft / etc.)
- One-line context (e.g., "AL HARAM Supermarket — rejected by Supervisor: bad photo")
- Timestamp ("2 hours ago")
- Primary action button (Fix / Review / Approve / Resubmit)

Filter chips at top by category. Items group by date.

**For Salesman:** Rejected (deep-linked from `/rejected`), customers due today, customers below 50% completeness.
**For Supervisor:** Pending approvals, wrong-route requests, stale drafts on team.
**For Manager:** Stale supervisor approvals, reactivation requests, low-completeness regions.
**For Steward:** Quarantine queue, dedupe queue, failed exports.

**Edge case:** Empty inbox → "All clear ✨ — nothing waiting on you."

---

### 4.8 `/rejected` — Rejected / Needs Correction (Salesman)
**Purpose:** Dedicated focus page for rejected submissions (also surfaced in `/work`).
**Content:**
- List of rejected submissions
- Per row: customer name, what was rejected (field summary), reason (full text), Supervisor name, date
- Primary action: `[Fix and resubmit]` → opens `/customers/:id/edit` with rejected fields highlighted in red
- Empty state: "No rejections — keep it up 👍"

---

### 4.9 `/approvals` — Supervisor approval queue
**Purpose:** Single page where Supervisor processes the day's submissions.
**Content:**
- Header: "{N} pending" with age histogram (mini bar)
- List sorted by oldest first
- Per row: customer name, salesman, fields changed (count), photos changed (count), submitted time
- Tap → `/approvals/:id`

---

### 4.10 `/approvals/:id` — Approval diff view
**Purpose:** Side-by-side diff so Supervisor can decide in <30 seconds.
**Content:**
- Header: customer name + salesman + submitted time
- For each changed field: `<DiffField label before after />` with red strike on before, green on after
- Photo diffs: thumbnails before / after, tap for lightbox
- Decision area:
  - `[✓ Approve]` button (green)
  - `[✗ Reject]` button (red) → opens reason modal (category dropdown + free text, 5–1000 chars)

---

### 4.11 `/reassignments` — Wrong-route queue (Supervisor)
**Purpose:** Process wrong-route flags from salesmen.
**Content:** List with: customer, current route, salesman who flagged, reason. Action: pick correct route from dropdown, confirm.

---

### 4.12 `/dashboard` — Manager dashboard
**Purpose:** At-a-glance health of the master cleanup.
**Content (KPI strip):**
- Total customers · Total complete (≥80%) · Total active enrichments today · Pending approvals · Rejection rate (last 7d)
**Charts:**
- Completeness % by region (horizontal bar)
- Daily enrichments (line, last 30 days)
- Top performing routes (table)
- Stale items (>3 days pending)

---

### 4.13 `/reactivations` — Reactivation queue (Manager)
**Purpose:** Manager-only review of reactivation requests for closed shops.
**Content:** List with: customer name, last closed date, salesman who requested reactivation, fresh photo evidence (lightbox). Decision: `[Reactivate]` / `[Keep Closed]`.

---

### 4.14 `/import` — Import console (Steward)
**Purpose:** Upload Excel master, review staged batches.
**Content:**
- `[Upload .xlsx]` drop zone
- Recent batches table: filename, uploaded by, date, status (Parsing / Quarantined / Ready / Promoted / Failed), total rows / clean rows / quarantined rows
- Click batch → `/import/:batchId`

### 4.15 `/import/:batchId` — Batch review
**Content:** Three tabs: `Clean (N)`, `Quarantined (N)`, `Promoted (N)`. Each tab is a paginated table of rows with their issues. Steward can:
- Bulk-promote clean rows to live master
- Edit individual row + fix → re-validate
- Reject row (drops from import)
- Merge into existing customer (opens duplicate-merge modal)

### 4.16 `/duplicates` — Duplicate review
**Content:** Pairs of suspected duplicates side-by-side, with similarity score and matching fields highlighted. Actions: `Confirm Distinct`, `Merge Into A`, `Merge Into B`.

### 4.17 `/export` — Excel export
**Content:**
- Filters: region, route, status, completeness range, last-edited date range
- `[Generate Export]` button → background job; banner appears with "Export ready" link (also surfaces in `/work`)
- Recent exports table with download links

### 4.18 `/users`, `/routes`, `/audit` (Manager)
Standard CRUD/list pages. Users: create, disable, reset password, change role, assign route. Routes: add/edit, assign salesman + supervisor + manager. Audit: full searchable log with filters by actor, entity, date.

---

## 5. Critical UX rules (apply everywhere)

1. **Forms never submit silently.** Every submit shows a toast: success ✓, error ✗ with retry.
2. **Loading states always visible.** Skeletons within 100ms; spinner only on actions taking >500ms.
3. **No browser-default alerts.** Use `Toast` and `Dialog` from shadcn.
4. **Read-only fields show why.** Locked field: gray + lock icon + tooltip ("Locked: Credit customers cannot rename here. Contact Steward.").
5. **Destructive actions confirm.** Delete photo, mark closed, force-override → 2-step Dialog.
6. **Phone numbers are tap-to-call** wherever shown (read view only).
7. **Empty states aren't blank.** Always a friendly message + a CTA pointing somewhere useful.
8. **Errors never blame the user.** "We couldn't save that. Retrying…" not "Invalid input."
9. **Unfinished features stay hidden.** No greyed-out "Coming soon" buttons. v2 doesn't appear in v1 UI.
10. **Mobile thumb zone respected.** Primary actions always in the bottom 1/3 of the screen.

---

## 6. Wireframe priority for Phase 6 build

These get built first as actual React components (priority order):
1. Login
2. Today (Salesman home)
3. Customer Profile (read)
4. Enrichment Form (the big one)
5. Photo capture component
6. Approval queue + diff view
7. Work Items page
8. Rejected page
9. Manager dashboard
10. Import console
11. Reactivation queue
12. Export page

Everything else (audit, users, routes, etc.) follows in M1/M7.

---

**End of UX-SPEC v1.0.**
