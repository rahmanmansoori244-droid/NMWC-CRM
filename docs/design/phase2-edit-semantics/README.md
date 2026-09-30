# Phase 2 design notes — edit-form semantics (auditor findings F05 F06 F16 F19 F20 N02 F21)

The design record behind `ab6d998` (merged 2026-09-29), kept so a later reader can see
why the code is shaped the way it is. These are working notes, not a specification to
build from: where they and the code differ, **the code and `AUDITOR-BRIEF.md` win**, and
the review rounds after the design changed several details (listed below).

How they were produced, in order:

1. `angles.txt` — three independent designs (minimal, correctness-first, operator-first),
   summarised.
2. `spec-*.txt` — one spec synthesised from them by a lead, section by section:
   `spec-summary`, `spec-payload_contract`, `spec-per_finding`, `spec-approval_behaviour`,
   `spec-draft_compatibility`, `spec-errors_and_messages`, `spec-migration`,
   `spec-prod_rescore`, `spec-test_plan`, `spec-owner_decisions`, `spec-risks_and_left_out`.
3. `critique.txt` — a critic's attack on that spec, before any code.
4. `CORRECTIONS.md` — the rulings on every critic item and the owner's answers
   (2026-09-29). **It overrides the spec where they differ.**

Changed after these notes, by the reviews of the built code:

- A phone draft restores a "Counted" tick or untick only while the value loaded now
  equals the one loaded when it was saved (`confirmedLoaded`), not "a tick, never an
  untick".
- The GPS point is judged, recorded and written as one value (both coordinates), not
  field by field.
- "Keep mine" marks only fields whose live value actually moved; a stale channel's answer
  carries the saved sub-channel.
- The import's rescore does not bump `version`; a branch-only import row that writes a
  branch moves the customer's `updatedAt` (the export's "updated since" reads it).
- Every array in the submit payloads is refused on its length before any element is read.

Line numbers in these notes are at `2060423` and have moved since.

Two things in these notes need reading correctly:

- `CORRECTIONS.md` lists "Owner decisions" 1 to 5. Items 1 to 4 are the owner's answers of
  2026-09-29. Item 5 (the visit day cannot be cleared; a salesman's own CLOSED/SUSPENDED
  branches still gate his submit) is a default kept **without** asking the owner — changing
  either is a product rule, so ask (docs/HANDOVER.md §4).
- Where a note mentions "the standing 2026-09-27 production-write permission", that
  permission was given to Claude for its work; it grants nothing to any other agent
  (docs/HANDOVER.md §4).
