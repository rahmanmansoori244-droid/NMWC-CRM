# Phase 2 — lead's corrections to the spec (these OVERRIDE spec-*.txt where they differ)

The spec (spec-*.txt in this folder) was produced by a design panel and then attacked by a
critic (critique.txt). The lead has ruled on every critic item and on the owner's questions.
Read spec-summary, spec-payload_contract, spec-per_finding, spec-approval_behaviour,
spec-draft_compatibility, spec-errors_and_messages, spec-migration, spec-prod_rescore and
spec-test_plan, then apply THIS file on top. Where this file is silent, the spec stands.

## Owner decisions (2026-09-29, final — do not change)

1. Customer import changes a customer's channel and the stored sub-channel belongs to the old
   channel → CLEAR the sub-channel in the same write and leave a lane note on the lead row
   (plus a PII-free log line). A sub-channel that belongs to the new channel is kept.
2. CR number IS clearable from the edit form (crNumber in the clearable set). A clear sets
   crNumber and crNumberNorm to null; the approver sees "Cleared". Under the FULL gate a
   salesman's clear is refused ("CR number is required.").
3. Equipment "Counted" (Branch.equipmentConfirmed): a SALESMAN can only set it to true (by
   ticking, or implicitly by entering a count); a STEWARD or MANAGER may also set it to false.
   Scoring: +5 when equipmentConfirmed OR any count > 0.
4. Existing branches: NO backfill. equipmentConfirmed defaults to false everywhere.
5. Defaults kept as today (no product change): dayOfVisit cannot be cleared once set (null is
   refused); a salesman's own CLOSED/SUSPENDED branches still gate his submit.

## Rulings on the critic's items (critique.txt numbering)

1. ADOPT. No automatic rebase after STALE_FIELDS. The form keeps the typed value and shows,
   per conflicting field, the value now saved and two actions: "Keep mine" (sets that field's
   base to the live value, so the next submit overrides it knowingly) and "Use this value"
   (sets the field's state to the live value, dropping the typed one). A resubmit while any
   conflict is unresolved is refused again. When a field was resolved with "Keep mine", the
   stored fieldChange carries `overrodeLive: <the live value at the conflict>`; the approval
   page shows that row as "replaces a value changed after the form was opened". isDraft
   (Save draft) SKIPS the stale check entirely (UPDATE DRAFT rows are write-only) and never
   rebases.
2. ADOPT. The approval page shows a banner on a pending UPDATE whose submitGate IS NULL and whose
   submitter is a SALESMAN: "Sent by the previous version of the form, which sent every field —
   check each row against the customer." (No code needed at deploy beyond this; the lead takes a
   read-only count of in-flight rows before merging.)
3. ADOPT. The sub-channel lane note must survive services/imports.ts's later
   `rowNotes[i] = { note: null, written: true }`: make that assignment merge
   (`{ ...rowNotes[i], note: null, written: true }`) or set the note after it. A test in the
   import multibranch/lane-note suite asserts the note lands on the lead row.
4. ADOPT. One shared rescore helper (e.g. lib/rescore.ts `rescoreCustomerTx(tx, customerIds)`)
   that writes Customer and Branch completenessScore with `UPDATE … FROM (VALUES …) WHERE
   "completenessScore" <> v.score` (one statement per table), so untouched rows keep
   updatedAt and version. Used by the import promote AND the ops rescore script. The import
   separately bumps Branch.version (and lets updatedAt move) only on branches it creates or
   whose imported fields it actually changes.
5. ADOPT. If classifyChanges leaves APPLY empty (everything converged), write nothing: no version
   bump, no rescore, no Temix requeue.
6. ADOPT. The structural guard pins that collectMissingMandatory's branch argument at approval is
   the value returned by the gate helper (an identifier such as `gateBranches`) or a
   `salesmanBranches(` call — never a `.branches` member of the whole customer. Strip comments
   before matching.
7. ADOPT. GPS companions follow the pair: gpsAccuracy and gpsCapturedAt are applied only when
   gpsLat or gpsLng is applied; otherwise they are CONVERGED/ignored. The schema requires
   gpsCapturedAt (and gpsAccuracy, null allowed) whenever gpsLat/gpsLng is sent.
8. MODIFIED (take the critic's cut). The approval page does NOT disable Approve and shows no
   "Now:" values. It shows one amber banner listing the LABELS of stored changes whose live
   value no longer equals their `before` (after the same QA-013 lock re-check the server applies,
   via one shared helper), saying Approve will be refused and Reject sends it back. The server's
   STALE_BEFORE stays the authority.
9. ADOPT. lib/scrub.ts PHONE_PATTERN also covers Persian digits (U+06F0–U+06F9) in the arms that
   cover Arabic-Indic digits, with tests, in the same change as lib/phone.ts folding them.
10. ADOPT. Correct the claim in comments/docs; add to docs/OPERATIONS.md (rescore runbook) that
    scripts/ops/apply-quarantined-visit-days.ts must not run concurrently with the rescore, and
    that the rescore repairs the scores that script left stale.
11. ADOPT. A missing-mandatory error for a branch the page did not show says to reload the page.
    Never trust branch ids from the client for the gate.
12. ADOPT. salesmanBranches lives in lib/edit-scope.ts (pure); lib/access.ts imports it.
13. Decided by the owner (decision 3 above).
14. ADOPT. Neutral wording: "changed after you opened this form" (never "by someone else").
15. Accept as a known cost (document it in the import section of the docs).

## Cuts (do NOT build these)

- Freezing the gate. CustomerEdit.submitGate stores `{ v: 1, branchIds: [...] }` only. At
  approval the gate RULE is `salesmanSubmitGate()` as today; the BRANCH SET is the frozen ids
  (fallback for NULL rows: the branches named in fieldChanges plus the submitter's current route,
  as the spec says). Keep the column name `submitGate`.
- Changing applyEditChanges' signature to take expected versions. Take the customer lock,
  classify against a fresh read, then call the existing applyEditChanges.
- Approval-page "Now:" values, disabled Approve, new reject template (see ruling 8).
- New per-field error slots. Only make enrichmentFormRendersError an explicit allowlist; unslotted
  keys already surface at the top through surfaceUnrenderedErrors.
- Read-only counts inside the rescore script (the lead runs one-off SQL instead).
- Re-checking channel isActive at approval for a channel deactivated after submit. The F16 rule is
  CREATE's: the sub-channel must be active and belong to the effective channel.
- `convergedFields` in the audit, and branch-code formatting in the STALE_BEFORE message (a plain
  list of field labels is enough).
- Hiding "—" in the day-of-visit select (the server refuses null).

## Standing constraints

- The migration is exactly the spec's two ADD COLUMNs (submitGate JSONB NULL — holding only
  branchIds now — and equipmentConfirmed BOOLEAN NOT NULL DEFAULT false). No CHECK, trigger or
  index. Keep the migration comment accurate to the cut (no gate in the JSON).
- Update lib/compliance/pii-classification.ts and regenerate docs/compliance/PII-INVENTORY.md
  (`npx tsx scripts/compliance/build-pii-inventory.ts`).
- No i18n exists; English strings only.
- Every audit row through writeAudit() inside the same transaction.
- Do not touch owner items: F04, F09, F12 (no new Temix requeue), F14, N04.
