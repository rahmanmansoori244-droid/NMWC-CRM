# 04 — Pending work

This file lists everything that is not done, grouped and prioritised. It was written on 2026-10-04, when `main` was `9d0fd61`, for the person taking over NMWC CRM.

**This file is public**, because the repository is public. It names work, files and who decides. It holds no production status, counts or totals, no rollout or account state, no rotation status and no secret. All of that is in the **private handover pack (PRIVATE-HANDOVER.md)**. Where an item depends on private facts, it says so.

It links to the existing records and does not repeat them. When this file and the code disagree, the code wins. Next comes [`AUDITOR-BRIEF.md`](../../AUDITOR-BRIEF.md), then [`docs/HANDOVER.md`](../HANDOVER.md).

---

## How to read this

| Group | What it holds |
|---|---|
| **A** | Product and owner decisions that are still open. Nothing here is a code task until the owner answers. |
| **B** | Engineering follow-ups, with file pointers. |
| **C** | Owner-side operational actions: accounts, dashboards, secrets and access. |
| **D** | Data and ERP work that is in progress. Status and figures are private. |

**Priority**

| | Meaning |
|---|---|
| **P1** | Decide or do this first. It would affect daily field use, data safety or recovery. |
| **P2** | Do this within the first weeks. |
| **P3** | Backlog. |

**Effort** is Claude's rough estimate at `9d0fd61`. It includes tests. It does not include the time to make the decision or the review round.

| | |
|---|---|
| **S** | Half a day or less |
| **M** | 1–2 days |
| **L** | 3–5 days |
| **XL** | More than a week |

**Who decides**

| | |
|---|---|
| **Owner** | The person with product and business authority after the handover. The current owner names this person in PRIVATE-HANDOVER.md (it is on the fill-in list); until then, it is the current owner. In the repo, every "owner decision" means this role. |
| **Account holder** | Whoever has admin access to GitHub, Vercel, Neon, Cloudflare and Sentry ([`SECRETS-INVENTORY.md`](../SECRETS-INVENTORY.md) §1). |
| **Engineer** | Whoever builds the change. No business decision is needed. |
| **Steward, Managers** | The app roles that do the data work in the app. |
| **ERP team** | The Temix side. |
| **Counsel** | Legal advice on PDPL and data residency. |

**Tier** (for B items) is the review tier from [`HANDOVER.md`](../HANDOVER.md) §2. Tier B means a review before merge. If you are unsure, use Tier B.

Two standing rules from [`CLAUDE.md`](../../CLAUDE.md) (Process) apply to everything below:

- When the record says something is the owner's decision, do not build it. Ask.
- Say what is not done. When you finish an item, update this file in the same change. If the change alters something they state, update `AUDITOR-BRIEF.md` and `HANDOVER.md` too (HANDOVER §2 step 3).

---

## Start here

Suggested order for the first days:

1. **C14, before the handover.** The backup decryption key was not found on the owner's computer and is not in the handover pack, and GitHub's copy cannot be read back. Until the owner puts a copy in the pack, or adds the new person's age recipient and proves one decrypt, nobody else can decrypt any backup.
2. **C10, C9.** Agree who approves merges to `main` after the handover, and what any AI agent may do in production. The owner approves every merge in words, and since 2026-10-01 Claude has executed the approved merges (C10). Claude's production-write grant ends on the date recorded in PRIVATE-HANDOVER.md; after that the new person decides.
3. **C7, C13, C15.** Choose a second holder of the production credentials. Confirm that no pilot or QA account whose password is in the public repository can sign in. Get a named Data Steward account for the new person.
4. **B7.1 — done 2026-10-04.** `.gitignore` now covers every env file name. Copying this folder anywhere still means leaving its env files behind (B6).
5. **C1, C2.** Turn on the restore drill, and set up the alert webhook and an uptime monitor. Without them, backups are unproven and nobody is told when production breaks.
6. **A1.1–A1.5.** These field-workflow gaps would block or confuse salesmen in daily use. The owner decides; then build.
7. **B1.6.** Decide which user-guide set is the source. Users received a newer English and Arabic set on 2026-10-04, which is in the private pack; `docs/guide/` in this repository is stale.
8. **D1–D3, with the first row of A4.** The ERP hand-offs. D3 cannot be finished until the owner and the ERP team settle the file contract and item 4.
9. **C4, then F02 (A2) with C6.** The least-privilege database role, then photo protection.

---

## A. Product and owner decisions still open

### A1. Field-workflow gaps found on 2026-10-04

These were found while writing the user guides. Most are defaults that nobody decided. Where part of today's behaviour is a recorded owner decision or a deliberate engineering choice, the item says so. Changing any of it is the owner's call.

#### A1.1 A sent-back request stays "Needs correction" forever — P1

- **What.** When an approver sends a request back, its row goes to `NEEDS_CORRECTION`. For an update request, the salesman's only way to respond is to send a brand-new request. Nothing ever moves the old row out of `NEEDS_CORRECTION`. The same happens to a rejected close-shop request, and to a reactivation that a Manager decides with **Keep closed** (A1.7). All of these rows stay on the salesman's **Needs correction** page and in the Today and Work counts permanently. (The Dashboard no longer counts them all-time: since F2 (A6) it shows only requests submitted in the chosen period, by the state each is in now, and says that a sent-back update stays "sent back".) New-customer requests work differently: the salesman revises the same row and resubmits it.
- **Why it matters.** The list only grows. Salesmen cannot tell open corrections from finished ones. A final "Keep closed" reads as "fix this".
- **Where.**
  - `services/edits.ts`: the `INVARIANT` comment at line 763 says `cycle` is never bumped, because re-submitting always creates a new row. The reject path writes `NEEDS_CORRECTION` around line 1966 and notifies the submitter around lines 2043–2049.
  - `services/reactivations.ts`: **Keep closed** writes `NEEDS_CORRECTION` (around lines 515–522).
  - Lists and counts: `app/(app)/rejected/page.tsx:17`, `app/(app)/today/page.tsx:55-57`, `app/(app)/work/page.tsx:52`. The dashboard's request card is `lib/insights/load.ts` (`requestsSql`).
  - For comparison, the `services/creates.ts` header says resubmits reuse the same row and bump `cycle`.
- **Options.**
  - (a) Close the old row automatically when the salesman's next request for that customer is submitted or approved.
  - (b) Let him reopen the sent-back request and resubmit the same row, as new-customer requests do. The `services/edits.ts` comment warns that `cycle` must then be incremented.
  - (c) Give final decisions such as **Keep closed** a terminal state. Today `REJECTED` is written only by a duplicate merge (AUDITOR-BRIEF §6, "Duplicates & merge").
- **Decides:** Owner, including which state a finished row takes. **Effort:** M for (a) or (c), L for (b). **Tier:** B.

#### A1.2 Fixing a sent-back update means re-entering every change — P1

- **What.** For an update, the Needs correction page links to the customer profile. The edit form opens on the live values and only checks for `SUBMITTED` requests. The changes in the sent-back request are not loaded.
- **Why it matters.** The salesman has to retype everything, including fields the approver had no problem with. Some corrections get dropped.
- **Where.** `app/(app)/rejected/page.tsx` (the link target), `app/(app)/customers/[id]/edit/page.tsx:141`, and `lib/enrichment-patch.ts` (the patch-v2 bases).
- **Option.** Build this together with A1.1(b). Prefill from the sent-back request, re-based on today's live values so that the stale-field checks (F06) still apply.
- **Decides:** Owner, together with A1.1. **Effort:** L, combined with A1.1(b). **Tier:** B.

#### A1.3 New customers need the full field list; updates need only the core — P1

- **What.** The update gate is `CORE` by default: channel, phone, contact, address, GPS and shop photo. A new-customer request always requires much more:
  - sub-channel;
  - CR number and CR photo;
  - visit day and signboard photo on every branch;
  - credit limit, term days and a guarantee document for credit customers.
- **Part of this is a recorded owner decision.** `lib/validation/create.ts:145-152` records two rules as owner-confirmed: the CR number is required for **both** payment terms on a new customer, and the credit block. The rest mirrors the PRD §6 field rules. Changing any of it is a decision for the new owner, not a code fix.
- **Why it matters.** `CORE` was chosen because most customers are individuals or home-delivery addresses with no CR and no signboard (the `lib/submit-gate.ts` header says so). Those same customers cannot be added as new customers from the field.
- **Where.** `lib/validation/create.ts` (`collectMissingForCreate`, about lines 145–200), `lib/submit-gate.ts` (`SALESMAN_SUBMIT_GATE=FULL` switches updates to the full rule), `app/(app)/customers/new/CreateCustomerForm.tsx`, and AUDITOR-BRIEF §6 ("Submit gate", "CREATE").
- **Note.** The CR number also feeds the hard duplicate block at submit (`lib/create-guards.ts`). Without a CR, only the name + phone + region match guards against duplicates.
- **Decides:** Owner. Which fields does a new cash customer need? Do credit customers keep the full list? **Effort:** M. **Tier:** B.

#### A1.4 Closed branches on the salesman's route still block his submit — P1

- **What.** The submit gate checks every live branch of the customer that is on the salesman's route, whatever its status. A `CLOSED` or `SUSPENDED` branch that lacks an address, GPS or shop photo blocks updates to the customer's open branches.
- **Why it matters.** He cannot photograph a shop that has closed, so his update cannot be sent at all.
- **Where.** `lib/edit-scope.ts:42` (`salesmanBranches` filters by route only), and `services/edits.ts:193` (`collectMissingMandatory`) and `:731`. [`HANDOVER.md`](../HANDOVER.md) §4 lists this as a default that was kept unchanged, not as an owner decision.
- **Care.** `salesmanBranches` also decides which branches he sees (`lib/access.ts:132`), so change the gate only. The gated set is frozen on the request and checked again at approval (`CustomerEdit.submitGate`, `gateBranchesForApproval` in `lib/edit-scope.ts`).
- **Decides:** Owner. **Effort:** S–M. **Tier:** B.

#### A1.5 A multi-branch customer needs every branch complete before any submit — P1

- **What.** This is the same mechanism as A1.4. The gate covers all of the salesman's branches of the customer, not only the branches the request changes. So one incomplete branch blocks an update to a different branch.
- **Why it matters.** The product was built for multi-branch customers from the start ([`docs/PROJECT-DESCRIPTION.md`](../PROJECT-DESCRIPTION.md): "never assume a single branch"). A salesman who wants to fix one branch must complete all of them first.
- **Where.** As A1.4. Auditor finding F05 (AUDITOR-BRIEF Appendix B) already narrowed the gate to his own route.
- **Option.** Gate the customer-level fields plus only the branches the request changes. The completeness score keeps the full picture.
- **Decides:** Owner. **Effort:** M. **Tier:** B.

#### A1.6 Today lists closed branches — P2

- **What.** Today shows every live branch on the route whose visit day is today, including closed or suspended ones. The counts and the no-visit-day view use the same rule.
- **Why it matters.** Salesmen plan visits to shops that are closed, and the counts are inflated.
- **Where.** `app/(app)/today/page.tsx:34` (`routeBranchWhere`). AUDITOR-BRIEF §6 says: "There is no status filter". The test is `tests/unit/today-pagination.test.tsx`.
- **Options.** Hide closed branches, or list them last with a badge.
- **Decides:** Owner. **Effort:** S. **Tier:** A (a UI change with its test).

#### A1.7 Close-shop and reactivation requests notify nobody — P2

- **What.** `services/reactivations.ts` imports no notification helper (see its imports, lines 3–29). That file holds the salesman's reactivation request, the salesman's close-shop request (`markBranchClosedAction`, line 210), and the Manager's **Approve** and **Keep closed** for reactivations. So:
  - no Manager is told that a reactivation is waiting; he finds it only by opening `/reactivations`;
  - no approver is told that a close-shop request is waiting;
  - the salesman gets no notification of a reactivation decision. A **Keep closed** does appear on his Needs correction page, where it stays for good and looks like something to fix (A1.1).
- **What does notify.** A close-shop decision runs through the approval path in `services/edits.ts`, and that path notifies the submitter on approve (around line 1679) and on reject (around lines 2043–2049). Update and new-customer requests notify their approvers at submit (`services/edits.ts` around line 934, `services/creates.ts` around line 514).
- **Why it matters.** Requests wait unseen. Salesmen re-ask or resubmit.
- **Where.** `services/reactivations.ts`; `lib/notifications.ts` (`notifyUsers`, `resolveStepAudience`).
- **Decides:** Owner (who is told, and of what). **Effort:** S–M. **Tier:** B, because it writes inside the decision transaction.
- **Request half built 2026-10-05 (F1 writers, branch `claude/notify-email`, not yet merged).** A close-shop request now tells the salesman's supervisor when he can act on it, else every active Manager of the branch's region; a reactivation request tells his supervisor if he is an active Manager of the region, else every active Manager of it (`REACTIVATION_REQUESTED`, linked to `/reactivations`); both also tell the region's Accountant for information. The request and its rows are one transaction. These audiences are the defaults in `lib/notify-policy.ts`, waiting for the owner's confirmation (A1.11). **Not done:** the salesman is still not told of a reactivation decision (**Approve** / **Keep closed** in `services/reactivations.ts` notify nobody), and a **Keep closed** still sits on his Needs correction page (A1.1).

#### A1.8 Photos go live without approval — P2

- **What.** A CR, shop or signboard photo taken in the edit form replaces the live photo immediately. The old photo is soft-deleted and the score is recomputed. Field changes wait for approval; photos do not. The approver cannot reject a photo.
- **Why it matters.** A wrong or poor photo is shown to everyone at once and replaces a good one. Getting the old photo back depends on photo clean-up timing and on F02 (A2).
- **Where.** `services/photos.ts`; AUDITOR-BRIEF §6 ("UPDATE", first bullet). This is why approval re-checks the mandatory fields against the live record.
- **Options.** Keep it and record it as a decision, or hold photos as pending changes that are approved with the fields. The second option needs schema and approval-flow changes.
- **Decides:** Owner. **Effort:** none to keep; XL to change. **Tier:** B.

#### A1.9 Only one pending request per customer — P2

- **What.** Only one request can wait on a customer at a time, whether it is an update, a close or a reactivation. While one waits, salesmen on other routes of the same customer are refused, and so are Manager direct writes.
- **Why it matters.** Customers served from several routes block each other. One slow approval blocks the next person.
- **Where.** The partial unique index `CustomerEdit_open_per_customer` in `prisma/migrations/20260509150000_qa_remediation/migration.sql`. A branch-level twin, `CustomerEdit_open_per_branch`, is in `prisma/migrations/20260715120100_phase1_tables/migration.sql`. See also [`OPERATIONS.md`](../OPERATIONS.md) §7a (the pending-change row).
- **Options.** Keep it, or lock branch fields per branch and keep customer-level fields exclusive.
- **Decides:** Owner. **Effort:** L (a migration plus approval semantics). **Tier:** B.

#### A1.10 No in-app control for a route move or for covering an absent salesman — P2

- **What.** No button moves a route or gives a salesman temporary cover. The only path is the Steward's account-master import. It applies at once, with no review step, and leaves the previous owner with no route.
- **What moves and what does not.** Only the branches move with the route, so the Today list follows the new owner. Requests and new-customer drafts belong to the person who submitted them: the Needs correction, Work and Today pages filter on `submittedById`. After a move, the old salesman keeps his pending and sent-back requests, and the new owner never sees them.
- **Why it matters.** Leave, sickness and transfers are routine in a field team. Today each one needs an import out and another back.
- **Where.** [`OPERATIONS.md`](../OPERATIONS.md) §7 ("Move a route to another salesman") and §7a; `services/imports.ts` (route handover, `F-18`, around line 832); `services/users.ts`; `app/(app)/rejected/page.tsx:17`, `app/(app)/work/page.tsx:52`, `app/(app)/today/page.tsx:55-57`. Related: F14 in A2 (a route moved to another region leaves its branches behind).
- **Decides:** Owner. Who may move routes? Is cover temporary or permanent? What happens to pending requests and drafts? **Effort:** L. **Tier:** B.

#### A1.11 Notifications are in-app only — P2

- **What.** No e-mail, SMS or push sender exists. Approvers learn of work only by opening the app. SLA escalations reach only the app and the operations webhook.
- **Why it matters.** Approvals are delayed. The objectives in [`SERVICE-LEVELS.md`](../SERVICE-LEVELS.md) depend on people looking.
- **Where.** AUDITOR-BRIEF §6 ("Notifications"); re-benchmark item 27; [`POST-LAUNCH-ROADMAP.md`](../POST-LAUNCH-ROADMAP.md) §4; `lib/notifications.ts`; `lib/escalation.ts`.
- **Decides:** Owner. Which channel and provider? What personal data may leave the app (see the PDPL row in A4)? **Effort:** L. **Tier:** B.
- **Built 2026-10-05 (F1), not merged.** The owner asked that whenever a salesman submits or uploads, his manager and the region's accountant get both an in-app alert and an e-mail from the owner's Gmail, everyone in the hierarchy except the GM and the Data Steward. He chose his Gmail (HANDOVER §4). Branch `claude/notify-foundation` holds the foundation (both migrations, the inbox links and labels, the review-page banner, the Steward's e-mail edit, `scripts/ops/notify-readiness.ts`); `claude/notify-email` adds the in-app writers and the e-mail drain on top. How it works: AUDITOR-BRIEF §6 ("Notifications"); how to turn it on, prove it on UAT and turn it off: [OPERATIONS §5i](../OPERATIONS.md).
- **Deploy order (required, not a preference).** The foundation adds two migrations, one of them two new notification kinds (`REQUEST_FYI`, `REACTIVATION_REQUESTED`). A build older than the foundation cannot read a row of either kind: its `/notifications` page reads whole rows and Prisma throws `Value '…' not found in enum`, so that page fails for every Accountant and Manager whose newest 100 rows hold one, until someone fixes forward. Therefore:
  1. Merge `claude/notify-foundation` alone. It writes neither kind. Let its deployment serve production and pass `npm run smoke`.
  2. Only then merge `claude/notify-email` (the writers and the drain). Its PR description must say so.
  3. Once the writers are live, the Instant Rollback target is the **foundation's deployment, never anything older**. To go further back, re-kind the new rows first ([03 §6](03-OPERATIONS-AND-DEPLOYMENT.md#6-rolling-back)).

  Merging `claude/notify-email` as one PR without step 1 makes the previous production deployment — the documented first rollback lever — the unsafe one.
- **Owner decisions implemented as DEFAULTS, all in `lib/notify-policy.ts` — confirm or change each before `NOTIFY_EMAIL_ENABLED=on`:**
  1. Who must act: update and new-customer requests unchanged (his `supervisorId`); a close-shop request → his supervisor if he can act on it, else every active Manager of the branch's region; a reactivation → his supervisor if he is an active Manager of the region, else every active Manager of it (new kind `REACTIVATION_REQUESTED`, linked to `/reactivations`).
  2. The region's active Accountant(s) are told **for information** (`REQUEST_FYI`) of every salesman request — update, new customer, close, reactivation — never the must-act people or the submitter. Region-wide Manager FYI is **off** (Muscat has several class Managers).
  3. Photo uploads notify nobody (live writes, several per visit; `NOTIFY_PHOTO_UPLOADS = false`).
  4. E-mail goes only to Managers, Supervisors, Accountants and the Finance Manager — never the GM, a Steward, a Viewer or a salesman — re-checked at send time. The GM and the Steward keep their in-app rows (the GM must still act on every CREDIT request; the Stewards drive the Temix hand-off).
  5. E-mailed kinds: `EDIT_SUBMITTED`, `REACTIVATION_REQUESTED`, `REQUEST_FYI`, and `EDIT_STAGE_ADVANCED` only when the recipient is the step that must act now. SLA breaches are not e-mailed (`EMAIL_SLA_BREACH = false`; the escalation chain is still open).
  6. Content: counts, request kinds and links only — never a customer, salesman or route name, never a reason; plain text with an Arabic line; a line that the CRM never asks for a password.
  7. Delivery: every 10 minutes 07:00–18:59 Oman, one digest per person per run, at most one per 30 minutes, 40 per run, 400 a day, nothing older than 24 hours, nothing already read or already decided. Work goes first (fixer review 2026-10-05): an information-only e-mail does not start the 30-minute gap for a later "please review"; when a cap binds, digests with something to act on go before information-only ones; and information-only digests may use at most 300 of the 400 a day (`informationDailyCap`).
  8. Addresses: the Steward sets or clears them on `/users` (X-IMPORTS-4, e-mail half), for the e-mailed roles only; the row says "E-mail on file", or "E-mail not usable — re-enter it" when what is stored is not an address the drain can send to (the drain's own rule, `lib/notify-address.ts`). `User.email` stays unique, so two accounts cannot share one mailbox. No self-service, no opt-out.
  9. The bell: unread for-information rows (`REQUEST_FYI`) are a muted second count, not the red one, and `/notifications` offers **Mark information read** for them alone (`BELL_INFORMATION_KINDS`). Otherwise an Accountant's bell would read "9+" all day, and clearing it with **Mark all read** would also mark his must-act rows read, which are then never e-mailed.
- **Not done:** e-mail is **off** until the owner sets `NOTIFY_EMAIL_ENABLED=on` (and the Gmail variables, OPERATIONS §5i); the UAT check that Vercel can open SMTP on port 465 has not been run; the salesman is not told of a reactivation decision (A1.7); no per-user opt-out; the sender is the owner's personal Gmail, with no processor agreement (PDPL-ASSESSMENT Q6, DATA-RESIDENCY-REGISTER P9 and open action 4a); `scripts/ops/smoke.ts` does not yet check the drain route (add `'email-drain'` to its list once the route is live on production); an update request's notifications still share item 22's loss on a lost reply (AUDITOR-BRIEF §18); the in-app alert is still the bell count on page load — no live pop-up or push (that would be new scope); **Mark all read** still marks must-act rows read too, and a read row is never e-mailed (use **Mark information read** to clear only the information); `/notifications` shows the newest 100 rows, so in a busy region information rows can push older must-act rows off the list (the `/approvals` queue is the complete list); an update or new-customer request's must-act row still goes to the salesman's `supervisorId` as before, even when that supervisor cannot act on it (a Manager outside the route's region, which `scripts/ops/notify-readiness.ts` counts): the drain now skips his e-mail, since the request's page would refuse him, but the region Managers who can act are not told (`lib/notifications.ts`, deliberately unchanged). The integration suites `notify-request-writers` (`RUN_NOTIFY_WRITERS`) and `email-drain` (`RUN_EMAIL_DRAIN`) need the new migrations, so they ran in no local session: their first run is CI's.

### A2. Owner decisions carried from HANDOVER §6.1 and the auditor's recheck

The recommendations are Claude's and have not been answered. The sources are [`HANDOVER.md`](../HANDOVER.md) §6.1 and the "Owner" rows of [`AUDITOR-BRIEF.md`](../../AUDITOR-BRIEF.md) Appendix B. The owner decides every row; F12 / E5 and Enh. 5 also need the ERP team. The owner decided X-AUTH-2 on 2026-10-04, and X-APPR-1(a) (no bulk approval of credit, built) and the GPS accuracy standard (±30 m capture, ±100 m approve, built) on 2026-10-05 (HANDOVER §6.1), so do not reopen them.

| ID | Question | Recommendation on record | Why it matters | Effort once decided | P |
|---|---|---|---|---|---|
| F02 | Photo clean-up and recovery. `photo-gc` relies on R2 object tagging, and the recovery plan relies on bucket versioning. The recheck found that R2 implements neither. | Driven by the rows, delete the object 30 days after its row was soft-deleted, and copy every photo to a second bucket each night. This is also a cost and data-residency choice. | Photos are the evidence behind credit decisions, and they have no recovery path ([`OPERATIONS.md`](../OPERATIONS.md) §6.2). Blocks C6, which also has to resolve a contradiction in OPERATIONS. | M–L | P1 |
| F04 | Photo read and remove scope works at customer level: any branch of the customer in scope is enough. | Branch level: only photos of branches in the viewer's own scope. | Documents are visible across routes and regions. It also changes who may approve what (RBAC-05-003). | M | P1 |
| Photo removal while pending | May a salesman remove a guarantee or status-evidence photo while its request is pending? | No. He may replace it. | Today, removing the photo forces the request to be rejected (AUDITOR-BRIEF §6, "Close shop / reactivation"). | S–M | P1 |
| F14 | A route moved to another region leaves its branches in the old region. | Move the route's branches (and drafts) with it, in the same transaction, audited. | Region scope is then wrong for Managers and Accountants. Related to A1.10. | M | P2 |
| N04 | How should a customer's status follow its branches? | `ACTIVE` if any branch is active; `CLOSED` only when all are. | A customer's status can contradict its branches. | M | P2 |
| F12 / E5 | The Temix lifecycle: what closed and reactivated branches look like in the batch file, and what happens to a live customer with no Temix code. | Get the file contract from the ERP team first (A4). | The ERP and the CRM drift apart. | Depends on the contract | P2 |
| Q-sla | Response-time budgets for the Finance Manager, GM and Manager steps. Today they are placeholders. | The owner supplies the numbers (`SLA_*_MIN` in `lib/working-hours.ts`). | Escalations and Service status mean nothing for those steps until they are set. | S | P2 |
| F09 | Shared phone numbers inside one import file cannot be released. | A reviewed release per row on the batch page, like the existing release for a phone already in the master. | Legitimately shared phones are held back. | M | P3 |
| X-IMPORTS-4 | How to clear an account's e-mail or phone. | A Steward edit on the Users screen, not through the import. **E-mail half built 2026-10-05** (F1 foundation: `updateUserEmailAction`, Steward only). The phone half and the import's own validation of the e-mail cell are still open. | Stale contact data stays on accounts. | S | P3 |
| Enh. 5 | Immutable Temix batch payloads, and the 5,000-row batch ceiling. | Depends on the Temix contract. | A batch re-download may not match what was loaded. | Depends on the contract | P3 |

### A3. Smaller owner questions carried forward

The sources are HANDOVER §6.1 ("Also carried") and §6.2.

| Question | Where | Why it matters | Decides | Effort | P |
|---|---|---|---|---|---|
| **Blank `temix_code`.** Should an import row with a blank `temix_code` keep taking the full lane for a Temix-linked customer? Today it overwrites CRM-owned customer fields and branch cells without re-queuing the customer for Temix. | AUDITOR-BRIEF §6 ("Imports"); OPERATIONS §7; `services/imports.ts` | The CRM and the ERP drift apart and nobody is told. | Owner | S–M (Tier B) | P2 |
| **New-customer drafts.** After **Save draft**, Back from Work shows an empty form, and a create draft cannot be discarded. | AUDITOR-BRIEF §18 (item 22) | Salesmen think the draft is lost. Abandoned drafts keep their photos (DATA-RETENTION gap 5, A4). | Owner | S–M | P2 |
| **Escalation of an uncovered Supervisor step.** When a request breaches its SLA at the Supervisor step and no active Manager covers its regions, `app/api/cron/sla-escalate/route.ts` sends the breach to the GM. The header comment in `lib/escalation.ts` still says "fallback: all active MANAGERs"; that comment is stale. The route marks the chain "[Open — owner to confirm the escalation chain.]". Is the GM the right fallback? | AUDITOR-BRIEF §6 ("SLA"), §15; `lib/escalation.ts` (`escalationPlan`); `app/api/cron/sla-escalate/route.ts` (the fallback) | An escalation may reach someone who cannot act on it, and the stale comment misleads the next reader. | Owner (the chain); Engineer (correct the comment, B5) | S | P2 |
| **Synthetic and pilot accounts.** Should synthetic approver accounts be denied by exact name? Never by an `accountant.` prefix. The same question applies to the pilot accounts in C13. | HANDOVER §6.2; `lib/demo-accounts.ts`; AUDITOR-BRIEF §8 ("Demo accounts") | Test accounts with known passwords. | Owner | S (Tier B) | P2 |
| **Salesman guide.** The new-customer section of the salesman guide in `docs/guide/` is still open. Check it against the 2026-10-04 guide set first (B1.6). | HANDOVER §6.1; B1.6 | Salesmen learn the create flow from it. | Owner (content); Engineer (the rebuild) | S | P2 |
| **Parked security items.** The owner parked five security items from the 2026-09-24 re-benchmark. They are not in the repository. | AUDITOR-BRIEF §8, Appendix A | Unknown until someone reads them. | Owner. Ask the previous owner; if they are written down, PRIVATE-HANDOVER.md says where. | Unknown | P2 |
| **Unkeyed dismissal digests.** The digests stored when a pair is marked distinct on `/duplicates` are unkeyed, so a 7-digit CR can be recovered from one by brute force. | AUDITOR-BRIEF §6 ("Duplicates & merge"); `services/duplicates.ts` | Anyone who can read those audit rows can recover the CR number. | Owner | S–M (keyed digests need a secret and a plan for existing rows) | P3 |
| **Placeholder CR numbers.** Values such as `0` fill `/duplicates`. | AUDITOR-BRIEF §18 (item 16) | Real duplicates are buried among false pairs. | Owner (which values count as placeholders) | S | P3 |
| **Pending state.** `components/nmwc/BranchStatusActions.tsx` still uses `useTransition`, so another server action in flight can hold its "Submitting" state. | AUDITOR-BRIEF §6 ("Field submits over fetch") | The close and reactivate buttons can look stuck. | Engineer; it is listed with the owner items in HANDOVER §6.1, so confirm first | S | P3 |
| **Missing PRD flows.** The PRD's wrong-route flag and add-branch sub-flows are not built. | AUDITOR-BRIEF §18; `docs/PRD-v0.1.md` | A customer on the wrong route goes to the Steward by hand today (OPERATIONS §7a). | Owner (are they still wanted?) | M–L each | P3 |

### A4. Policy, privacy and ERP-contract decisions

| Decision | Why it matters | Where it is recorded | Decides | Effort once decided | P |
|---|---|---|---|---|---|
| Confirm the Temix file format (item 5). Decide on a provenance column for a Temix crosswalk import (item 4). That import was built and withdrawn before commit; the `54de6aa` commit message records why. | Without it, ERP codes cannot come back into the CRM (D3). | AUDITOR-BRIEF Appendix A, §12; HANDOVER §4 | Owner + ERP team | M–L (an import path and a migration) | P1 |
| Fill the PDPL and data-residency blanks, and send the memo to counsel. | The legal basis for holding and moving the data is unconfirmed. | [`PDPL-ASSESSMENT.md`](../compliance/PDPL-ASSESSMENT.md), [`DATA-RESIDENCY-REGISTER.md`](../compliance/DATA-RESIDENCY-REGISTER.md) | Owner + Counsel | None in code until counsel answers | P2 |
| Backups defeat erasure for up to 30 days, and Neon point-in-time restore for 7. Is a written backup exception available under Omani law? | An erasure request cannot be honoured inside the backup window. | [`DATA-RETENTION-SCHEDULE.md`](../compliance/DATA-RETENTION-SCHEDULE.md) gap 3; PDPL-ASSESSMENT Q5 | Owner + Counsel | None in code; a written policy | P2 |
| Credit ownership (D2). The decision says credit is CRM-owned, but the import's refresh lane and the comments in `services/edits.ts` treat Temix as authoritative. | The two systems can overwrite each other's credit figures. | AUDITOR-BRIEF §15; `qa/reports/OWNER-DECISIONS.md` | Owner + ERP team | S (docs) to M (code) | P2 |
| How long to keep the photos of new-customer requests that are never finished. Today they are kept forever. | CR documents and shopfronts of customers that never existed are kept indefinitely. | DATA-RETENTION gap 5 | Owner + Counsel | M (a scheduled sweep, Tier B) | P2 |
| Search terms stay unredacted in Vercel request logs for 30 days. | A typed phone number or name sits in the logs for a month. | DATA-RETENTION gap 7; OPERATIONS §5g | Owner | S–M (search as a POST body) or none (a setting) | P2 |
| Export round trip. Today the export is a report, not an import file, and re-uploading it can reopen closed branches. | A natural "export, fix, re-import" loop corrupts data. | OPERATIONS §7 ("Export the cleaned master for ERP"); `services/exports.ts` | Owner | L | P3 |
| Should archiving a customer release its documents? | An archived customer's CR and shop photos are never cleaned up. | DATA-RETENTION gap 1 | Owner | S–M | P3 |
| What happens when an audit write fails. Check the current call sites before proposing a change. | Decides whether a change may commit without its audit row. | HANDOVER §6.2; `tests/unit/audit-atomic-guard.test.ts` | Owner | S–M | P3 |
| How far the Steward's powers reach, and whether approver-tier accounts need two people to provision. | One account can create an approver today. | HANDOVER §6.2 | Owner | M–L | P3 |
| The Viewer role reads and exports everything, including CR and guarantee documents. The code calls this "by design", but no owner confirmation is recorded. | Wide access to identity documents. | AUDITOR-BRIEF §5, §12; `lib/access.ts` | Owner | S (record it) to M (restrict it) | P3 |
| A per-username login lockout can be triggered by anyone who knows a username. | Someone can keep a salesman locked out. | AUDITOR-BRIEF §18; `lib/auth.ts`, `lib/rate-limit.ts` | Owner + Engineer | M | P3 |

### A5. Recorded decisions the new owner may want to revisit

These have been decided. They change only when the owner says so, so do not build against them (HANDOVER §4).

- **The repository is public** (2026-09-27). Its current files and history contain the shared initial password, the May pilot passwords, staff names, and guide screenshots captured from production. AUDITOR-BRIEF §14 lists the files. Making the repository private now does not undo existing copies; rotating the affected credentials does (C8).
- **One shared initial password**, with a forced change at first sign-in (F01). The accepted risk: until an account first signs in, anyone who knows the shared value can take it over.
- **The `CORE` submit gate is the default** (2026-09-10). A1.3 describes how it differs from the new-customer rules.
- **The new-customer CR and credit rules** are owner-confirmed (A1.3).

### A6. Insights dashboard (F2): built on defaults the owner has not confirmed

**Done (2026-10-05, branch `claude/dashboard-insights`).** `/dashboard` is now an interactive, report-based insights page: new customers and customers updated over time and per region and route, activity and completeness rankings by route, closures and reactivations, requests by state, an approximate Oman map of where located branches cluster, data-quality gaps, and a short "What stands out" reading. Filters (period, region, route) live in the URL. How it keeps scope, privacy and the CSP is in AUDITOR-BRIEF §5 ("Insights dashboard"). The Steward's menu now offers the page it already admitted.

**Not confirmed.** Each row below is a decision the record gives to the owner. So that the page works, each was built as the recommended default and kept in **one module, `lib/insights/policy.ts`**. Until the owner answers, treat them as open. Not every entry there is a switch: who gets the page, imports shown apart, direct writes shown apart, the Pending steps, the map and the time constants are read by the code, so changing one changes the page. How new customers are counted, the attribution, route-level only and no company figures are **records** of what the code does in its structure; `tests/unit/insights-policy.test.ts` fails if one is edited alone, and another answer means changing the code each one names.

| Decision | Default built | P |
|---|---|---|
| Who gets the dashboard, at what scope | MANAGER (his regions), VIEWER and STEWARD (whole organisation) — `DASHBOARD_ROLES`. Adding ACCOUNTANT, FM or GM is that list, the menu and maybe `lib/role-home.ts` | P2 |
| What a "new customer" is | A new-customer request given its final approval in the period, counted as a request; customers loaded by import shown apart, never added | P2 |
| What "customer updated" means | An approved UPDATE request on the customer; Manager/Steward direct writes as their own series; closures and reactivations on their own card; photos and imports not counted | P2 |
| How past activity is attributed | The branch's **current** route and region (a new customer: the route it was raised on, that route's region today). A snapshot of the route at decision time would need a schema change | P2 |
| The map | A self-drawn approximate outline with server-binned cells (0.05°, 0.01° with one region in view) and the GPS coverage beside it; no tiles, no exact pins | P2 |
| Per-salesman figures for Managers | None: route-level only, and no name shown — but each route is shown by its code, which is its salesman's username, so its figures identify his work (RECORDS-OF-PROCESSING A4). The route ranking credits a request to the route of the branch it changed (or the salesman's own route), not to every route of a chain customer | P2 |
| National totals or benchmarks for a region Manager | None | P2 |
| Approval turnaround on the dashboard | None: a link to Service status | P3 |
| The Manager's "Pending approval" | The Supervisor step in his regions, matching `/approvals` and `/status`. Against the old page it **adds** new-customer requests waiting at the Supervisor step and **drops** reactivations, which the Manager decides on `/reactivations`; the tile shows those on a line of their own, and the Closures card counts them as "Reactivations waiting". **The number can rise or fall; say so in the release note** | P1 |
| A completeness or data-quality trend | Not built (no history kept; item 18) | P3 |
| Day boundary | Oman calendar days; weeks start on Monday, as Postgres does | P3 |

**Ways back without a code change.** `INSIGHTS_DASHBOARD_DISABLED=true` in Vercel Production and a redeploy switch the dashboard off: `/dashboard` then shows a notice and links to the pages each role works from, and runs no dashboard query (`lib/insights/rollout.ts`). The change has no migration, so Vercel's instant rollback is safe for it too. A slow statement cannot hold the landing page: each has a 10 s `statement_timeout` and the page waits at most 20 s for all of them, then shows the late cards as not available.

**Not done, and known limits.** No completeness or data-quality history (B3 item 18), no per-salesman lens, no download of the dashboard's figures, no saved dashboard views. The 10 s and 20 s limits were chosen, not measured at production's size. Attribution follows the current route, so a handover moves history (F14 makes a moved route's branches count in the old region). A resubmitted new-customer request is dated by its latest submit in the request card. Route filter options come from the cached active routes cut by the route's region, so a route moved away whose branches stayed behind is counted but not offered, and the lists can be five minutes stale. `CustomerEdit` has no `reviewedAt` index; measure before adding one (B2). The role guides' dashboard pages and screenshots describe the old page (B1.6). Route-level figures are labelled by route code, which is the salesman's username, so they identify his work (RECORDS-OF-PROCESSING A4; the lawful basis is still with counsel). An adversarial review ran over the branch before merge (three reviewers: correctness and privacy, repository guards and deploy safety, tests and performance); its findings were fixed in the branch (a "period before" that was not like for like, a route ranking that credited chain customers' updates to every route, `?period=toString` read as a preset, no time limit and no kill switch, the Pending wording, records that misstated what the policy module does). The pass after the merge is still owed.

---

## B. Engineering follow-ups

Unless a row says otherwise, the Engineer does these and no business decision is needed.

### B1. Follow-ups from the 2026-10-04 batch

AUDITOR-BRIEF §18 ("Closed by the 2026-10-04 batch") records what that batch closed. These are what it left open.

| # | What | Where | Why it matters | Effort | Tier | P |
|---|---|---|---|---|---|---|
| B1.1 | The Create user form takes the password only once. The forced change and the Manager/Steward reset now ask for it twice and have a Show button (`bda75b1`). | `app/(app)/users/CreateUserForm.tsx:146` | One typo creates an account that nobody can sign in to. | S | A (client-side check only) | P2 |
| B1.2 | **Fixed on `claude/fix-times` (2026-10-07):** every date and time on screen is now Oman time, through the `lib/tz.ts` helpers. When it is merged, OPERATIONS §7a must stop telling support to add 4 hours to `/audit` times. Was: Dates are shown in server time (UTC), not Oman time. This affects the Today header date, the `/audit` times, Users "Last login" and the date on the Needs correction page. | `app/(app)/today/page.tsx:126` (the list itself uses `omanDayOfWeek`, line 76); `app/(app)/audit/page.tsx:175`; `app/(app)/users/page.tsx:324`; `app/(app)/rejected/page.tsx:60`; helpers in `lib/tz.ts` | From 00:00 to 04:00 Oman time the header shows yesterday's date. Support has to add 4 hours to audit times; OPERATIONS §7a says so, so update it after the fix. | S | A | P2 |
| B1.3 | Menus. No role's sidebar or drawer links to Profile, where the password is changed. Only the salesman's phone tab bar ("Me") and the 404 page link to it. The Manager's menu has no Export, although `canExport` allows Managers. The Viewer and Supervisor menus have no Export either. | `components/nmwc/Sidebar.tsx:39` (`NAV_BY_ROLE`), `:145` (`MobileTabBar`); `components/nmwc/TopBar.tsx`; `app/not-found.tsx:24`; `lib/permissions.ts:43`; the menu tests `tests/unit/status-page.test.tsx`, `role-home.test.tsx`, `audit-menu.test.tsx` | Managers and approvers cannot find how to change their password. Managers cannot find Export. | S | A | P2 |
| B1.4 | On Approvals, the per-card checkboxes have no cap. **Select all** stops at 50, but ticking cards one by one can go past it, and the server then refuses the whole action with a clear message. | `app/(app)/approvals/BulkApprovalQueue.tsx` (`toggleOne`, `selectAllIds`); `lib/bulk-run.ts` (`BULK_DECISION_LIMIT`) | Wasted clicks. Nothing wrong is written. | S | B | P3 |
| B1.5 | The Approvals page reads the queue and then counts it, one query after the other. The queue shows the 200 most overdue, with no next page (by design today). | `app/(app)/approvals/page.tsx:101` and `:140`; `QUEUE_PAGE_SIZE` at `:24` | One extra database round trip on every view, over a slow link (HANDOVER §7). | S | B | P3 |
| B1.6 | There are two guide sets, and the one in this repository is stale. **The newer set:** on 2026-10-04 an English and Arabic set was produced from the code and given to users: PDFs for Salesman, Manager, Approvers and Data Steward, an overview of how the app works, and an owner checklist. It is in the private pack (`guides/`, and `golive-data/guides-2026-10-04/` with its content JSON and renderer), not in this repository. **The repository set:** `docs/guide/` is stale. `scripts/build-role-guides.ts` changed four times on 2026-10-04 (`0465f3e`, `e6d26c0`, `8e5a516`, `a86ac19`). The newest generated role-guide files date from `883235a` (2026-09-29); some are older, such as the Supervisor HTML from May. `NMWC-CRM-USER-GUIDE.html` is edited by hand (last in `8e5a516`), but its PDF dates from May 2026. **Pending:** decide whether the 2026-10-04 set replaces `docs/guide/`, after a leak review, or whether `npm run guide:roles` stays the source and is rebuilt. Until then, support answers from the set users received. | The private pack (`guides/`); `scripts/build-role-guides.ts` (`npm run guide:roles`: role-guide HTML and PDF); `scripts/guide-html-to-pdf.ts` (`npm run guide:pdf`: the PDF of `NMWC-CRM-USER-GUIDE.html`); `docs/guide/` | Users learn the app from the guides. `docs/guide/` describes controls that differ from the app, and support that answers from it contradicts what users were given. Since F2 (A6) the Manager guide's "Daily dashboard check" and its screenshot describe the old dashboard too. | M | A | P1 |
| B1.7 | The X-AUTH-2 sign-in limit is untested end to end on Postgres. `authorize()` charges the network bucket, then the per-user bucket, then refunds. That sequence is tested only on the in-memory backend, which does not debit refused requests. Postgres does (floor −1, timestamp reset), so each retry during a lock restarts the wait. The Postgres suite tests `refundLimit` on its own, not the sequence. | `tests/unit/login-throttle.test.ts`; `tests/integration/rate-limit-pg.test.ts` (`RUN_PG_RATE_LIMIT_TEST`, runs in CI); `lib/rate-limit.ts` (around line 104); `lib/auth.ts` (around lines 330–353); AUDITOR-BRIEF §8 | How the new limit behaves in production is not proven end to end. | S–M | A (tests only) | P2 |
| B1.8 | When the server refuses the forced password change (wrong current password, too short, or reused), the form clears every box. Only "the two new passwords differ" is caught before the action runs. | `app/(app)/profile/change-password/ChangePasswordForm.tsx` (the comment near `onSubmit` explains that React resets the fields after a form action) | First sign-in is where users struggle most. Retyping three passwords on a phone invites more mistakes. | S | A if client-side only; B if `services/password.ts` changes | P2 |
| B1.9 | Dependency advisories. CI fails `npm audit --omit=dev` only on critical findings. The remaining high and moderate advisories need Next 16, Prisma 7 and an exceljs change. `next-auth` is a beta (`5.0.0-beta.32`), and Dependabot ignores major versions. | `.github/workflows/ci.yml` (the npm audit step); `.github/dependabot.yml`; `package.json`; AUDITOR-BRIEF §8; auditor enhancement 9 | Production dependencies carry known advisories. | L–XL | B | P2 |

**Rebuilding the guides in `docs/guide/` (B1.6).**

- If the 2026-10-04 set is to replace them, do not copy it in unread. Review the PDFs in the pack's `guides/` folder for leaks first (step 5 of "Working an item"). Its content JSON and renderer sit in `golive-data/`, which never enters Git.
- `npm run guide:roles` needs Playwright's Chromium for the Playwright version in `package-lock.json`. Install it with `npx playwright install chromium` (CI uses `--with-deps` in `.github/workflows/ci.yml`). Or set `GUIDE_CHROMIUM` to a Chromium executable (`scripts/build-role-guides.ts`, around line 2086). `npm run guide:pdf` has no such override; it needs the installed Playwright Chromium.
- A run rewrites every role guide. Git shows only the files whose content changed, so review the diff.
- The Arabic guides load the Tajawal font from Google Fonts, so build while online. The Arabic text is also older than the English (re-benchmark item 26).
- HANDOVER §4 records that there are no Supervisor accounts. Ask the owner whether the Supervisor guides are still needed.
- **Do not run `npm run guide:capture` or `npm run guide:build`.** They sign in to the live production app with credentials written in `scripts/capture-guide-screenshots.ts`.
- The existing images in `docs/guide/img/` were captured from production in May (AUDITOR-BRIEF §14). Do not add new production screenshots to this public repository.

### B2. Recorded as "not done" in the code

Each line points to where it is described in full.

- **Safety — P1.** Several integration suites do not refuse a production `DATABASE_URL` before they write, and there is no central guard. AUDITOR-BRIEF §11 names them; `rate-limit-pg` gained a guard on 2026-10-04, and suites added since that count were not recounted. Separately, `scripts/qa/run-with-env.mjs` loads `.env` with no host check. It also runs operator scripts outside vitest (OPERATIONS §5c runs `app-role.ts` through it), so a guard in the vitest setup would not cover it. It needs its own check: refuse a production host unless the operator opts in explicitly. **Effort:** S–M. **Tier:** A for the suites; B for `run-with-env.mjs`.
- **Export scope copies — P2.** The scope rule for exports exists in several copies: `lib/export-scope.ts`, an inline copy in `services/exports.ts`, a third in `services/customer-export.ts`, and the list filters in `lib/customer-filters.ts`. They can drift apart (AUDITOR-BRIEF §5). **Effort:** M. **Tier:** B.
- **Phase 2 (AUDITOR-BRIEF §18) — P3.** **Effort:** S–M each. **Tier:** B.
  - A request sent from the previous form can still revert a value that was already newer when it was sent. The approval-page banner is the only mitigation.
  - The other rescore writers still update one row at a time.
  - Phone drafts saved before phase 2 carry no "Counted" marker.
- **Item 22 (§18) — P3.** **Effort:** S–M each. **Tier:** B.
  - An approver's notification is lost if the reply is lost.
  - A retry after a duplicate merge is refused as a reused id.
  - A changed retry of a photo-less new-customer draft can create a second draft.
  - If the full-page load after a submit fails, the browser's offline page shows.
  - The photo hold is bounded but long, and a busy slot has no Cancel.
  - A late attach is found only through Retry or a reload, and can replace a retaken photo.
- **Item 16 (§18) — P3.** Placeholder CRs (A3), names that differ only by a zero-width character, unkeyed digests (A3), and a full scan every time the page opens (item 15). **Effort:** S–M. **Tier:** B.
- **Item 20 (§18; HANDOVER §6.3) — P3.** Some of these are by design; check AUDITOR-BRIEF §6 before changing them. **Effort:** S–M each. **Tier:** B.
  - A file re-import cannot update an existing branch of a Temix-linked customer (by design: only an in-app fix can).
  - A blank `temix_code` row takes the full lane (A3).
  - A released phone is not written when the customer already has one.
  - Account-master rows have no in-app fix.
  - Rejected-row payloads are swept after 90 days.
  - Held-back rows keep their payload (DATA-RETENTION gap 6).
  - Problem rows cannot be downloaded.
  - The refresh lane does not repair a branch's region.
- **Item 28 (§18) — P3.** "Export filtered" is capped at 5,000 rows. No export is rate-limited (B7.4). The 60k ceiling of the field-update report is an estimate. **Effort:** S–M. **Tier:** B.
- **Items 41 / 40b (§18) — P3.** Change-report GPS rows do not mention a point typed by hand. The direct-write audit row carries no branch data. **Effort:** S. **Tier:** B.
- **Photo sweep (§18) — P3.** Nothing sweeps uploads that were never attached, or photos held by abandoned new-customer drafts. The second needs the owner's retention period first (A4). An unmerged attempt from July lives on branch `claude/nervous-saha-580313`. **Effort:** M. **Tier:** B.
- **Small retention gaps — P3.** `SavedView.urlParams` and `CronHeartbeat.lastDetail` have no retention, and both can hold a searched name or phone (DATA-RETENTION gap 4). **Effort:** S. **Tier:** B. The owner should confirm the period.
- **Test hygiene (AUDITOR-BRIEF §13) — P3.** Eleven test files still strip comments with a naive regex that `tests/support/strip-comments.ts` documents as wrong. Test coverage is not measured because the provider is not installed. **Effort:** S. **Tier:** A.

### B3. Open items from the 2026-09-24 re-benchmark

The source is AUDITOR-BRIEF Appendix A. HANDOVER §6.3 has the historical size estimates. The Engineer builds these once the owner confirms an item is still wanted; items 33–35 are the owner's buy-versus-build choices.

| Item | What is open | Effort | P |
|---|---|---|---|
| 10 (partly) | Request tracing is Sentry's 10% sample | S–M | P3 |
| 13 (partly) | Naming a second credential holder → C7 | — | P1 |
| 14 | Least-privilege database role → C4 | — | P1 |
| 15 | Duplicates are found only when `/duplicates` opens, with a full scan each time | M | P3 |
| 17 | A merge cannot be undone and can discard better values | L | P3 |
| 18 | No data-quality history. Since F2 (A6) the dashboard shows the current gaps per region and route; nothing records how they change | M–L | P3 |
| 19 | The completeness score counts "Address pending" as data | S–M | P2 |
| 21, 23 | Not installable; no offline queue; no offline photos. Today there are drafts in browser storage only (an owner decision) | L each | P3 |
| 24 | Nothing measures plan adherence | L | P3 |
| 25 | Today covers only part of the route. `/today?view=no-day` (2026-10-04) lists branches with no visit day; whether that closes the item is the owner's call | S | P3 |
| 26 | Arabic exists only in the guides: the stale `docs/guide/` set and the 2026-10-04 set in the private pack (B1.6). The app's own screens have none | L | P2 |
| 27 | Notifications are in-app only → A1.11 (built 2026-10-05, not merged; e-mail off until the owner switches it on) | — | P2 |
| 29, 30, 31 | No API, no machine accounts, no feature flags or staging | M–L each | P3 |
| 32 | Three integration suites (`build-chain-data`, `golive-rehearsal`, `uat-load`) never run in CI. `golive-rehearsal` reads `golive-data/` and cannot run there | S–M | P3 |
| 33–35 | Visits, orders, surveys and coolers; multi-company; order capture. Each is months of work | XL | P3 |

### B4. Auditor recheck items still open

The source is AUDITOR-BRIEF Appendix B.

- **Enh. 4.** Uploaded bytes are not checked to be real images (no image decoding). **Effort:** M. **Tier:** B. **P2.**
- **Enh. 1, 2, 7, 8, 9 and the concurrency section.** These cover authenticated scenario suites, shared invariants, a fuller privacy test corpus, field-device tests, dependency triage (B1.9) and more native two-connection tests. **Effort:** L each. **Tier:** A for tests only. **P3.**
- **The rest of F11.** A live customer with no Temix code is known to Temix by its customer code, and nothing yet treats that code as held. This belongs with F12 (A2). **Who:** Owner + ERP team first. **Effort:** depends on the contract. **P2.**

### B5. Documentation debt

**Who:** Engineer. **Tier:** A (documentation). **P2** for the runbook items, **P3** for the rest.

- **The changelog** has no entries after 2026-05-11 (v1.0.1). See `CHANGELOG.md` and `docs/CHANGELOG.md`. Commit messages are the real record (AUDITOR-BRIEF §13). **Effort:** S–M.
- **AUDITOR-BRIEF §15** (known contradictions) needs a refresh. **Effort:** S–M.
  - Its line that `OPERATIONS.md` "says CI deploys" is itself stale: `0465f3e` removed that text, and OPERATIONS §4 now says a push to `main` deploys through Vercel. Correct AUDITOR-BRIEF §15.
  - Still true: OPERATIONS §5d lists 3 heartbeat jobs (AUDITOR-BRIEF says there are 5), and "no maintenance mode" appears in §6.4 step 1 and in §6.8, beside the maintenance-mode entry in §6.8.
  - `README.md` still says "Milestone 0". `docs/PRD-v0.1.md` and `docs/TECH-SPEC.md` are out of date. `qa/reports/OWNER-DECISIONS.md` is stale on D3 and D5.
  - The least-privilege wording disagrees between OPERATIONS §5c, HANDOVER §5 and the `scripts/ops/app-role.ts` header (C4).
  - Code comments in `middleware.ts`, `auth.config.ts`, `.github/workflows/ci.yml`, migration `20260510160000` and `app/api/cron/keep-warm/route.ts` are stale. So is the header of `lib/escalation.ts`: an uncovered Supervisor-step breach goes to the GM, not to "all active MANAGERs" (A3).
- **Production commands in the runbooks.** OPERATIONS §7 (`ops:requeue-untracked`, `ops:visit-days`, `ops:rescore-completeness`) and `docs/GO-LIVE-RUNBOOK.md` still show `DIRECT_URL='…'` on the command line. HANDOVER §5 says never to do that and to run through `scripts/dev/prod-run.cjs` instead. Rewrite the examples. **Effort:** S.
- **Photo protection sections.** OPERATIONS §6.13 and "R2 backup & versioning" are stale: they rely on bucket versioning and on object tagging, and Cloudflare R2 supports neither (HANDOVER §6.1, F02; C6). AUDITOR-BRIEF §7 (the Backups line, "until R2 versioning is enabled") and Appendix A item 3 say the same. Rewrite them once F02 is decided. **Effort:** S.
- **Restore drill history.** OPERATIONS §6.12 ("has never run"), AUDITOR-BRIEF §7 (the Backups line) and AUDITOR-BRIEF Appendix A item 1 are stale. The drill's scheduled run on 2026-10-01 failed at preflight, and it has never succeeded (C1). **Effort:** S.
- **The `docs/GO-LIVE-RUNBOOK.md` header** is stale (AUDITOR-BRIEF §10). **Effort:** S.
- Keep `AUDITOR-BRIEF.md` true whenever the code changes (HANDOVER §2 step 3).

### B6. Housekeeping

- **Branches.** `git branch -r --no-merged origin/main` can list a branch that was in fact merged: a PR merged with GitHub's Rebase and merge lands as new commits. (A merge executed by pushing the CI-green commit keeps the branch's own commits, C10.) Check `gh pr list` before deleting any branch. **Who:** Engineer. **Effort:** S. **P3.**
- **Worktrees.** Old agent worktrees under `.claude/worktrees/` on the previous owner's machine are removed only with the owner (HANDOVER §6.4). **On Windows**, `git worktree remove --force` follows a `node_modules` junction and empties the folder it points to. Remove the junction first (`cmd /c rmdir <worktree>\node_modules`), check that it is gone, then remove the worktree. **Who:** Owner with the Engineer. **Effort:** S. **P3.**
- **Moving the working folder.** If the folder is copied to another computer, leave out `node_modules` (run `npm ci` there) and `.claude/worktrees/`. Private files (`.env` files, `golive-data/`) travel only in the encrypted private pack, never through Git. B7.1 is done, so Git ignores any env file the copy carries, but leave them out anyway. On the previous owner's computer, the main checkout's `.env` points at production (the `AGENTS.md` preface says so too). Do not recreate that on the new computer: keep the production env file outside every checkout and pass it explicitly (step 11 of "Working an item"). **Who:** Owner. **Effort:** S. **P1.**
- **`graphify-out/`.** This is a generated map of the repository, not a source of truth. It is tracked in this public repository, `wiki/` included. It was rebuilt on 2026-10-04 from `main` `9d0fd61`: 4,602 nodes, 10,495 links and 226 clusters. Start at `graphify-out/wiki/index.md`. `graph.html` needs internet access, because it loads the vis-network library from unpkg.com. Install graphify with `uv tool install graphifyy==0.8.44`; [`08-KNOWLEDGE-GRAPH.md`](08-KNOWLEDGE-GRAPH.md) has the details. The open work is keeping it current. There is no `.graphifyignore`. Rebuild it from tracked files only, as 08 describes, so that `golive-data/`, `.env` files and private-pack files can never enter the corpus. Before committing a rebuild, run `node scripts/dev/leak-check.cjs` over the generated Markdown and `graph.json`, and look for connection strings and customer names by eye. **Who:** Engineer. **Effort:** S per rebuild. **P3.**

### B7. Hardening follow-ups recorded in AUDITOR-BRIEF

| # | What | Where | Why it matters | Effort | Tier | P |
|---|---|---|---|---|---|---|
| B7.1 | **Done 2026-10-04.** `.gitignore` ignored only `.env`, `.env.local` and `.env.*.local`, so `.env.production`, `.env.uat` or `prod.env` would have been staged by `git add -A`. It now ignores `.env*`, `*.env` and `*.env.local`, which also covers a pack file copied in under its own name, and tracks only `.env.example`. `tests/unit/gitignore-guard.test.ts` pins this with `git check-ignore`, and fails if any ignore rule matches a tracked file (the `*.sql` incident, `8b122da`). The 2026-10-04 handover change had already added `*.tmp.ts`, so an operator script copied into a checkout under that name cannot be staged either. Still delete it after use. Not done: a file named otherwise (say `production-settings.txt`) is still not ignored, so keep env files outside checkouts. | `.gitignore` (the Env section and its last lines); `tests/unit/gitignore-guard.test.ts` | An env file copied into the folder, for example during a move, could have been committed to a public repository. gitleaks would not reliably catch it (B7.3). | S | B (safety) | done |
| B7.2 | `provision-app-role` sets `ALLOW_PRODUCTION=1` on every run. Its only gate is a typed `confirm_host`, matched as a substring. | `.github/workflows/provision-app-role.yml`; AUDITOR-BRIEF §10 | A loose match is the only thing between a mistyped run and a production role change. Match the host exactly. | S | B | P2 |
| B7.3 | gitleaks scans only each push's new commits, with default rules and no `.gitleaks.toml`. The `ci.yml` comment that claims a full-history scan is wrong. | `.github/workflows/ci.yml` (the secrets-scan job); AUDITOR-BRIEF §8 | A green scan says nothing about older history or low-entropy passwords. A full-history scan will report the literals listed in AUDITOR-BRIEF §14; decide how to handle them first. | S–M | B | P2 |
| B7.4 | No rate limit on: the three exports; approve, reject and bulk actions (up to 50 per call); close and reactivation requests; password reset and the rest of user admin; `GET /api/forms/customer-create`; `perf-probe`; `/api/health` (one database round trip per anonymous call). | AUDITOR-BRIEF §8 (the rate-limit table); `lib/rate-limit.ts` | A script or a stuck client can load the database. `/api/health` needs no sign-in at all. | M | B | P2 |
| B7.5 | The JWT refresh does not re-check the demo-account denylist. | `lib/auth.ts` (the `jwt` callback, around line 199); `lib/demo-accounts.ts`; AUDITOR-BRIEF §8 | A demo-account session that already exists is not cut off when the denylist applies. | S | B | P3 |

---

## C. Owner-side operational actions

These need account access or an owner decision, not code. Whether each one is already done is in PRIVATE-HANDOVER.md.

**Values that cannot be read back.** `CRON_SECRET`, `HEALTH_BEARER`, `MAINTENANCE_BYPASS_TOKEN`, the `BACKUP_AGE_*` values and the other values that live only in Vercel or GitHub are in no local env file. Vercel sensitive variables and GitHub secrets cannot be read back. If no copy exists elsewhere, whoever holds those accounts must regenerate the value, which is a rotation (C8): follow [`CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md) and the "must match" pairs in SECRETS-INVENTORY §5. The age private key is the exception: a new one cannot decrypt old backups (C14).

### C1. Restore drill — P1

- **What.** The drill's scheduled run on 2026-10-01 failed at preflight, because the GitHub secrets `NEON_API_KEY` and `NEON_PROJECT_ID` are missing. It has never succeeded. Add those two secrets; read OPERATIONS §6.12 step 3 on how narrowly a Neon key can be scoped. Run **Restore drill** once and check the four evidence lines. Record the measured recovery time in OPERATIONS §6.2.
- **Why it matters.** A backup that has never been restored is unproven. The drill is the only regular proof, and its green tick alone is not evidence (OPERATIONS §6.12, step 5).
- **Where.** [`OPERATIONS.md`](../OPERATIONS.md) §6.12; `.github/workflows/restore-drill.yml`. Actions logs in this public repository are public; §6.12 says what the drill publishes.
- **Who:** Account holder. **Effort:** S.

### C2. Alerts and uptime — P1

- **What.** Set `ALERT_WEBHOOK_URL` in Vercel Production, then redeploy. Point it at a channel two people read (SECRETS-INVENTORY §1). Point an external uptime monitor at `/api/health` with the `HEALTH_BEARER` header, and alert on anything other than 200. `HEALTH_BEARER` is one of the values that cannot be read back (see above). If no copy exists, regenerate it in Vercel and in the GitHub secret of the same name together, because `post-deploy-smoke` needs the two to match.
- **Why it matters.** `lib/alert.ts` does nothing when the URL is unset. Failed jobs, SLA escalations and import rejections then reach nobody outside the app.
- **Where.** OPERATIONS §5f, §5d; `lib/alert.ts`; `lib/health.ts`.
- **Who:** Account holder. **Effort:** S.

### C3. Logs — P2

- **What.** Confirm that Vercel Observability Plus (30-day logs) is on, under Vercel → Settings → Billing → Observability Plus. Then decide DATA-RETENTION gap 7 (A4).
- **Why it matters.** Without it, logs last 1 day, and an error Reference that a user quotes cannot be looked up after that (OPERATIONS §5g).
- **Where.** OPERATIONS §5g.
- **Who:** Account holder; Owner for gap 7. **Effort:** S.

### C4. Least-privilege database role (item 14) — P1

- **What.** Whether production uses the restricted `nmwc_app` role is recorded in PRIVATE-HANDOVER.md; switching is an owner-side action ([`CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md) step 1). The repository's docs disagree on this (AUDITOR-BRIEF §15; B5), so go by PRIVATE-HANDOVER.md. Before any switch, verify the app under `nmwc_app` on UAT (`scripts/ops/app-role.ts verify`), then switch `DATABASE_URL`. Re-apply the grants after each migration with `scripts/ops/app-role.ts grant`; it is safe to re-run.
- **Why it matters.** Under the owner role, nothing in the database limits what a defect in the app can do.
- **Where.** OPERATIONS §5c; [`CREDENTIAL-ROTATION.md`](../CREDENTIAL-ROTATION.md) step 1; `.github/workflows/provision-app-role.yml` (see B7.2); HANDOVER §6.2.
- **Who:** Engineer (UAT); Account holder (the switch). **Effort:** M.

### C5. Retire cron-job.org — P2

- **What.** Do this if it is still in use. First check that Service status shows "Vercel last ran it" for every job, through a whole working day. Then delete both jobs and the cron-job.org API key, delete the `CRONJOB_API_KEY` secret, rotate `CRON_SECRET` (Vercel) and `PROD_CRON_SECRET` (GitHub), and redeploy. Never run the scheduler `apply` again.
- **Why it matters.** cron-job.org holds a copy of `CRON_SECRET`. Until it is retired, a third party can call the cron routes.
- **Where.** OPERATIONS §5d; SECRETS-INVENTORY §1, §5.
- **Who:** Account holder. **Effort:** S.

### C6. Photo protection — P1

- **What.** Settle F02 (A2) first. Cloudflare R2 supports neither object versioning nor object tagging (HANDOVER §6.1, F02; AUDITOR-BRIEF §6 "Photos", Appendix B). OPERATIONS §6.13 and "R2 backup & versioning" are stale on this point: they depend on bucket versioning and on a tag-based expiry rule (`gc-marked-7d`), and §6.13 says that rule is already on the production bucket. Do not follow §6.13's versioning steps. Rewrite those sections to match the design F02 chooses (B5).
  - The daily `r2-config` workflow runs two checks. Its backup-bucket check (`scripts/ops/r2-backups-lifecycle.ts --check`) still matters. Its photo check (`scripts/ops/r2-photos-versioning.ts --check`) looks for versioning, which R2 cannot provide, so that check cannot pass. Replace it with a check for the chosen design. Until then, read both lines of each red run; do not treat red as noise. Both checks need the admin tokens, one per bucket: `R2_ADMIN_ACCESS_KEY_ID` / `R2_ADMIN_SECRET_ACCESS_KEY` and `BACKUP_R2_ADMIN_ACCESS_KEY_ID` / `BACKUP_R2_ADMIN_SECRET_ACCESS_KEY` (OPERATIONS §6.13 step 4).
  - Never run `npm run ops:r2-setup` against the production photo bucket. It replaces the bucket's whole lifecycle configuration (§6.13 step 0).
- **Why it matters.** Photos are the evidence behind credit decisions, and OPERATIONS §6.2 says they have no recovery path.
- **Where.** OPERATIONS §6.13 and "R2 backup & versioning"; `scripts/ops/r2-photos-versioning.ts`; `.github/workflows/r2-config.yml`; `app/api/cron/photo-gc/route.ts`.
- **Who:** Owner (F02); Account holder (the buckets and tokens). **Effort:** S, plus F02.

### C7. Second credential holder (item 13) — P1

- **What.** Choose option 1, 2 or 3 from SECRETS-INVENTORY §4. The minimum set is GitHub, Vercel, Neon and the age private key. The age key comes first (C14). Add a second `BACKUP_AGE_RECIPIENTS` key held by a different person (OPERATIONS §6.7; [02 §2.10](02-ACCESS-ACCOUNTS-AND-SECRETS.md)). Decide what access the previous owner keeps.
- **If the repository or the hosting moves to another account.** Re-link Vercel to GitHub (OPERATIONS §5b A); merging to `main` is what deploys. Then update every hard-coded reference. Search with `git grep` before and after.
  - The repository path is in `AGENTS.md` (the merge-gate command), `docs/HANDOVER.md` §2 step 6, `AUDITOR-BRIEF.md` §10, `docs/OPERATIONS.md` §2 and §5b A, and `scripts/print-required-secrets.ts`. `docs/SECRETS-INVENTORY.md` §1 names the GitHub account.
  - The production URL is in `.github/workflows/keep-warm.yml`, `sla-escalate.yml` and `provision-app-role.yml`; in `cron-scheduler.yml` and `db-backup.yml` as the fallback when the `APP_BASE_URL` repository variable is unset; in `scripts/ops/smoke.ts` (the default) and `scripts/capture-guide-screenshots.ts`; and in OPERATIONS §1 and AUDITOR-BRIEF §2.
- **Why it matters.** Every recovery step needs credentials that one person holds (OPERATIONS §6.8, "Bus factor of one").
- **Where.** SECRETS-INVENTORY §1, §4; OPERATIONS §6.7, §6.8.
- **Who:** Owner. **Effort:** S; M if the repository or hosting moves.

### C8. Credential rotation — P2

- **What.** When to rotate is the owner's decision (HANDOVER §4). Follow CREDENTIAL-ROTATION.md and the "must match" pairs in SECRETS-INVENTORY §5. Rotation status is in PRIVATE-HANDOVER.md.
- **Why it matters.** AUDITOR-BRIEF §14 lists credentials that appear in this public repository and its history. Anyone who held a credential before the handover keeps it until it is rotated.
- **Where.** CREDENTIAL-ROTATION.md; SECRETS-INVENTORY §2, §5; AUDITOR-BRIEF §14.
- **Who:** Owner; Account holder. **Effort:** M.

### C9. Agent production access — P1

- **What.** HANDOVER §4 records Claude's standing permission to write to production through operator scripts, with the safeguards in HANDOVER §5. It ends on the date recorded in PRIVATE-HANDOVER.md; after that the new person decides. HANDOVER §2 gives Codex no production access. Decide what continues after that date, and record it in HANDOVER §2 and §4 and in the `AGENTS.md` preface.
- **Why it matters.** A production-write permission should be confirmed by whoever is accountable for production now.
- **Where.** HANDOVER §2, §4, §5; `AGENTS.md`.
- **Who:** Owner. **Effort:** S.

### C10. Merge authority — P1

- **What.** The owner approves every merge in words ("merge it"). Since 2026-10-01, Claude has executed the approved merges by pushing the exact CI-green commit to `main`, with the procedure in [03 §4](03-OPERATIONS-AND-DEPLOYMENT.md): `scripts/dev/ci-watch-sha.sh` on that commit, `scripts/dev/build-id.cjs` and `npm run smoke` for the baseline, `git push origin <sha>:refs/heads/main`, then `scripts/dev/deploy-watch.sh`. The alternative recorded in HANDOVER §2 is the owner merging with GitHub's **Rebase and merge**. Codex never merges or pushes `main`. Who approves merges after the handover is for the owner and the new person to agree; it is on the fill-in list in PRIVATE-HANDOVER.md. Name who gives the Tier B review at the same time. Record the result in HANDOVER §2 and the `AGENTS.md` preface. Both still describe the 2026-09-30 agreement, in which no agent merges.
- **Care.** Keep `CLAUDE.md` and its verbatim copy in `AGENTS.md` identical. `tests/unit/agents-md-guard.test.ts` checks that copy, and it also requires `AGENTS.md` to mention `docs/HANDOVER.md` and to contain "Never push to `main` and never merge". That line binds Codex and the other agents that read `AGENTS.md`. Claude follows `CLAUDE.md`, which lets `main` move only on an explicit yes from the owner. If the new arrangement lets Codex or another agent merge, that guard has to change, and loosening a guard test is Tier B.
- **Why it matters.** Merging to `main` deploys to production.
- **Where.** HANDOVER §2; `AGENTS.md`; `tests/unit/agents-md-guard.test.ts`.
- **Who:** Owner. **Effort:** S.

### C11. CSP browser walk — P3

- **What.** Confirm that the signed-in walk is done or superseded: sign-in, forced change, early sign-out, `/audit` filter, approve/reject, photo upload.
- **Why it matters.** A content-security-policy mistake renders pages blank (CLAUDE.md, "Never reorder the content-security-policy"). These are the signed-in paths a test would miss.
- **Where.** HANDOVER §6.2; `lib/csp.ts`.
- **Who:** Owner. **Effort:** S.

### C12. Leftover pilot requests — done 2026-10-04

- **Done.** On the owner's decision, every May-pilot edit request that was still open was deleted on 2026-10-04. The deletion is audited, and a backup is in the private pack. None is pending, so none blocks its customer (A1.9).
- **Where.** HANDOVER §6.2 records it. Any other document that still asks an approver to reject them is stale.

### C13. Pilot and QA leftover accounts — P1

- **What.** Accounts created by `prisma/seed-muscat-pilot.ts` are not on the demo-account denylist and do not set `mustChangePassword`. Their May passwords are in this public repository (AUDITOR-BRIEF §8 "Demo accounts", §14). Whether every such account, and every other QA leftover, is disabled cannot be checked from the repository. Confirm each one on `/users` (the **All** tab), and record the result in PRIVATE-HANDOVER.md, not here.
- **Care.** Never relax `lib/demo-accounts.ts` to make an account work (CLAUDE.md). Denying these accounts by exact name is the owner question in A3.
- **Why it matters.** An enabled account with a published password can be used by anyone.
- **Where.** `prisma/seed-muscat-pilot.ts`; `lib/demo-accounts.ts`; AUDITOR-BRIEF §8, §14; OPERATIONS §7a (who may disable whom).
- **Who:** Owner, or the Steward on the owner's behalf. **Effort:** S.

### C14. Backup decryption key — P1, the owner's first action before handing over

- **What.** The nightly database dumps are encrypted with age. The age private identity that decrypts them was not found on the owner's computer, and it is not in the handover pack. GitHub's `BACKUP_AGE_IDENTITY` secret cannot be read back. Without that key, nobody else can decrypt any dump. Before handing over, the owner either puts a copy of the key in the pack, or adds the new person's age recipient to `BACKUP_AGE_RECIPIENTS` and proves one decrypt with the new person's key ([02 §2.10](02-ACCESS-ACCOUNTS-AND-SECRETS.md) has the steps).
- **Why it matters.** A backup that nobody can decrypt is not a backup. The key cannot be re-issued: a new key cannot decrypt dumps made for the old one (SECRETS-INVENTORY §3).
- **Where.** OPERATIONS §6.7; 02 §2.10; `.github/workflows/db-backup.yml`; `.github/workflows/restore-drill.yml` (it decrypts with `BACKUP_AGE_IDENTITY` only).
- **Who:** Owner. **Effort:** S.

### C15. A named Data Steward account for the new person — P1

- **What.** Keep at least two Data Steward accounts; the current state is in PRIVATE-HANDOVER.md. The owner, signed in as a Data Steward, creates a named Steward account for the new person on the Users page. The username must not match the demo-account denylist in `lib/demo-accounts.ts`; never relax the list to make a name work (CLAUDE.md). This is on the owner's fill-in list in PRIVATE-HANDOVER.md.
- **Why it matters.** The Steward imports the masters, runs the Temix batches (D1) and administers accounts. SECRETS-INVENTORY §3 asks for at least two active Steward accounts.
- **Where.** [02 §4](02-ACCESS-ACCOUNTS-AND-SECRETS.md); SECRETS-INVENTORY §3; `services/users.ts` (a Steward may create any role); `lib/demo-accounts.ts`.
- **Who:** Owner. **Effort:** S.

---

## D. Data and ERP work in progress

This work is ongoing outside the code. It is described here only in general terms. Progress, lists and figures are in PRIVATE-HANDOVER.md.

### D1. Queued customers that still need ERP codes or a decision — P1

- **What.** Some queued customers still need ERP codes or a decision; see PRIVATE-HANDOVER.md. Getting ERP codes back into the CRM is D3.
- **How the app's queue works.** An archived or merged customer must also be deactivated in the ERP (Temix), or the two masters disagree. The app has its own path for an archived customer:
  - Archiving or merging queues a Temix deactivation only when the ERP has heard of the customer and no other live customer holds the code it would deactivate (F11). Otherwise the archived customer leaves the queue as `SYNCED`, and nothing is sent.
  - The Steward generates the batch at `/temix`. Generate also holds back any queued deactivation whose code a live customer holds.
  - "Mark loaded" settles the deactivation rows to `SYNCED`.
- **Where.** `services/temix.ts`; `services/customers.ts` (archive; header lines 3–12, F11 logic around lines 126–141); `services/duplicates.ts` (merge); `lib/temix.ts` (`deactivationCode`); AUDITOR-BRIEF §6 ("Temix", "Exports").
- **Care.** Never deactivate a code that a live customer still holds.
- **Who.** Owner and ERP team. The Steward runs the batches. **Effort:** none in code; S per batch.

### D2. Filling in missing visit days — P1

- **What.** A branch with no visit day never appears on Today. Managers (in their regions) and the Steward set the day from the customer page (**Enrich** → **Day of visit**); for those roles it is a direct, audited write. Salesmen see their own gaps at `/today?view=no-day` and can propose a day through an ordinary update.
- **Bulk fills.** The journey-plan fill scripts used so far, such as `visitdays-jp.ts`, are in the private pack, not in this repository; see PRIVATE-HANDOVER.md. Two visit-day writers are here: `npm run ops:visit-days` (`scripts/ops/apply-quarantined-visit-days.ts`), which only lands days for import rows that a quarantine held back, and the sheet loader below.
- **The per-region visit-day sheets: the loader is done (2026-10-04).** These are the sheets on which missing visit days are being collected region by region. `scripts/ops/visitdays-from-sheets.ts` (`npm run ops:visitdays-from-sheets`) loads a returned workbook on the pattern of the existing operator scripts: a dry run that writes a private set file and review workbook, an independent check of the set against the same sheets, `--rehearse`, then `--apply` of the reviewed set; `--reverse <runId>` undoes a run. It writes only ACTIVE branches that still have no day, each with one audit row, and rescores their customers; a branch named on several rows loads only when they all give the same day without a note. Run it like every operator script (step 11 of "Working an item"; OPERATIONS §7). Tested in `tests/unit/visitdays-from-sheets.test.ts` and, on Postgres, `tests/integration/visitdays-from-sheets.test.ts`. **Not done:** loading the sheets themselves as they come back, and settling in the app the rows the review workbook lists (a note, a day that is not one of the seven codes, a branch that moved, closed or already has another day, rows that disagree).
- **Where.** OPERATIONS §7 ("Work out WHICH branches are missing a visit day", "Land a visit day that a quarantine held back") and §7a; `app/(app)/today/page.tsx`.
- **Care.** Once set, a visit day can be changed but not cleared (HANDOVER §4). The one exception is `--reverse` of the sheet loader, an operator's undo of that script's own writes. Never run `ops:visit-days` and `ops:rescore-completeness` at the same time (OPERATIONS §7).
- **Who.** Managers and the Steward enter the data; the Owner follows it up. **Effort:** none in code; data entry.

### D3. ERP codes cannot come back into the CRM — P1

- **What.** A customer created or completed in the CRM reaches Temix only as a row in an Excel batch that the Steward generates. "Mark loaded" settles only deactivation rows; live rows stay `UPLOADED`. **There is no way to record the code the ERP then issues** for a customer the CRM holds without one:
  - the refresh lane runs only when the stored `temixCode` already equals the row's `temix_code`;
  - a full-lane row on an existing customer writes neither `temixCode` nor payment terms.

  So these customers stay `UPLOADED` and never reach `SYNCED`. This is re-benchmark item 4, "Temix codes can never come back in". Until the contract says otherwise, the batch identifies a customer with no Temix code by its CRM customer code (`lib/temix.ts`, `deactivationCode`).
- **Where.**
  - `services/imports.ts:2117-2122` (`isRefresh`) and the comment at lines 2108–2113.
  - `services/temix.ts`: the whole queue goes into one batch, and generation is refused above 5,000 rows.
  - AUDITOR-BRIEF §6 ("Imports", "Temix") and Appendix A item 4.
  - OPERATIONS §7, "Requeue customers the ERP was never told about": `npm run ops:requeue-untracked`, in tranches with `--limit`.
- **Blocked by.** Item 4 (the owner's decision on a provenance column, a schema change), item 5 (the file format is not confirmed) and F12. See A4 and A2.
- **Who.** Owner and ERP team decide; the Engineer builds the return path; the Steward runs the batches. **Effort:** M–L once decided. **Tier:** B.

### D4. How "branch customers" are coded in the ERP — P2

- **What.** It is still open how the ERP codes the CRM's "branch customers". The repository does not record this case. The case, the customers involved and the options are in PRIVATE-HANDOVER.md.
- **Related.** Item 4, F12, and the one-customer-many-branches model (AUDITOR-BRIEF §1, §6).
- **Who.** Owner and ERP team. **Effort:** depends on the decision; S–M if it only changes the batch file.

### D5. The CR-number recompute — closed 2026-10-04

- **Done.** A read-only production dry run of `scripts/ops/recompute-cr-norm.ts` on 2026-10-04 found nothing to recompute, so there was nothing to apply (AUDITOR-BRIEF §18, item 16; HANDOVER §6.2).
- **If it is ever needed again**, for example after `normalizeCR` changes, follow the operator-script convention in HANDOVER §5: a dry run first, `--expect-host`, `--apply`, the ledger rows, and a second dry run that finds nothing left.

---

## Working an item

The full procedure is in [`HANDOVER.md`](../HANDOVER.md) §2 and §5. In short:

1. **Owner-decision items.** Get the answer in writing first, and record it in HANDOVER §4.
2. **Branch and classify.** Branch from current `origin/main`. Decide Tier A or Tier B (HANDOVER §2). Put the tier and the reason in the PR description; a Tier B title starts with `[needs Claude]`, or whatever prefix C10 settles on.
3. **Check the environment.** Before anything that loads `.env`, run `node scripts/dev/env-check.cjs [env file]`. It passes only when its last line reads `ok: nothing here points at production.` and it exits 0. It checks `DATABASE_URL` and `DIRECT_URL`, in the file and in the process environment.
4. **Run the checks.** Run `npm run typecheck`, `npm run lint` and `npm test`. Run integration suites against UAT only, through `scripts/qa/run-with-env.mjs` with their `RUN_*` flag (HANDOVER §8). That runner has no host check (B2), so step 3 is your only guard.
5. **Leak check.** Run `node scripts/dev/leak-check.cjs` (its default list is `AUDITOR-BRIEF.md`, `AGENTS.md`, `docs/HANDOVER.md` and `docs/design/**`). Run it again on the files you changed, for example `node scripts/dev/leak-check.cjs docs/handover/*.md`; file arguments replace the default list. It knows only password literals, so check by eye for counts, customer data, account or rollout status and contact details. Before every commit, `git status --short | grep -c golive-data` must print 0 (CLAUDE.md).
6. **Migrations.** Every branch push builds a Vercel preview that applies its migrations to UAT. Push a migration only when it is final, and never edit or rename one once pushed.
7. **Wait for green CI on the exact commit.** Use `bash scripts/dev/ci-watch-sha.sh <commit> [branch]`. Never chain a push or merge after a status check with `&&` or `;` (CLAUDE.md).
8. **Review by tier.** Tier B waits for its review before merge.
9. **Merge, only on an explicit "merge it"** from whoever approves merges (C10; today, the owner). First run `gh api repos/rahmanmansoori244-droid/NMWC-CRM/compare/main...<PR head sha> --jq .behind_by` with the full PR head SHA. It must succeed and print 0. The repository has `allow_update_branch=false`, so a missing **Update branch** button proves nothing. If the repository moves, update the path (C7). Then use one of the two recorded routes:
    - **Push the CI-green commit.** This is how Claude has executed approved merges since 2026-10-01. Follow the gates in [03 §4](03-OPERATIONS-AND-DEPLOYMENT.md): `scripts/dev/ci-watch-sha.sh` on the exact commit, `OLD=$(node scripts/dev/build-id.cjs)` and `npm run smoke`, `git push origin <sha>:refs/heads/main` (never with `--force`), then `bash scripts/dev/deploy-watch.sh <sha> "$OLD"`. A rejected push means `main` moved: start again.
    - **GitHub's Rebase and merge** (HANDOVER §2), done by the person who approves.
10. **After the merge.** A push puts exactly the watched commit on `main`. Rebase and merge creates new commits, so find the new `main` SHA first. Either way, wait for `main`'s CI on that SHA, including `post-deploy-smoke`; a missing or skipped smoke job is not a pass. After a substantial merge, run an adversarial pass (CLAUDE.md, Process).
11. **Production work.** Use only operator scripts, run as `NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs <script path> --expect-host ep-sweet-haze …`: a dry run first, then `--apply`. Run `npm run smoke` before and after (HANDOVER §5). Do not copy the `DIRECT_URL='…'` form that OPERATIONS §7 and GO-LIVE-RUNBOOK still show (B5).
    - **Where the production env file lives.** Keep it outside every checkout and pass it explicitly, as above. On the previous owner's computer today, the main checkout's `.env` points at production, and Claude's operator runs pass that file explicitly; do not set up a new computer that way (B6).
    - **Operator scripts from the private pack.** A script copied into a checkout as `*.tmp.ts` is ignored by Git (B7.1). Delete it after use all the same.
12. **Update this file.** Mark the item done with its commit, and say what is still not done.

**Never run:**

- `npm run build` locally;
- any `npm run db:*`, `prisma migrate` or `prisma db` command;
- `npx vercel --prod` from a laptop: it builds and migrates whatever tree is checked out (OPERATIONS §4);
- `npm run format`, `prettier --write` or `eslint --fix` over existing files;
- `npm run guide:capture` or `npm run guide:build`;
- `npm run ops:r2-setup` against the production photo bucket (OPERATIONS §6.13 step 0);
- the historical scripts that write as soon as they run, with no production check (AUDITOR-BRIEF §2): `scripts/wipe-synthetic-data.ts`, `scripts/flatten-customer-branches.ts`, `scripts/cleanup-synthetic-test.ts`, `scripts/seed-demo-edit.ts`, `prisma/inject-test-edits.ts`, `prisma/seed-muscat-customers.ts`, `prisma/seed-muscat-payment-terms.ts`, `prisma/test-*.ts` and `prisma/seed.ts`;
- any other script under `scripts/**` or `prisma/*.ts` before you have read it and know its write switch (AUDITOR-BRIEF §2).

Never open, list or copy `golive-data/`, and never print a secret ([`CLAUDE.md`](../../CLAUDE.md), Safety).
