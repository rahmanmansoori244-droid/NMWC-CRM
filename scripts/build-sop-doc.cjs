/* eslint-disable */
/**
 * Generates the Customer Master Management SOP & Access Control Policy (.docx).
 * Grounded in the implemented approval chains (lib/approval-chains.ts), roles,
 * scopes and SLAs (lib/working-hours.ts). Run: node scripts/build-sop-doc.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, TabStopType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, LevelFormat,
  Footer, Header, PageNumber, TableOfContents, PageBreak, VerticalAlign,
} = require('docx');

const NAVY = '1F3A5F', STEEL = '2E5E8C', LIGHT = 'EAF0F6', MID = 'D6E1EC', WHITE = 'FFFFFF';
const GREEN = '1B7A3D', GREY = '6B7280', AMBER = 'B45309';
const CONTENT_W = 9026; // A4 (11906) minus 1" margins each side

// integer column widths that sum EXACTLY to total
function cols(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => Math.round((w / sum) * total));
  const diff = total - raw.reduce((a, b) => a + b, 0);
  raw[raw.length - 1] += diff;
  return raw;
}
const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };
function cellBorders(color = MID) {
  const b = { style: BorderStyle.SINGLE, size: 4, color };
  return { top: b, bottom: b, left: b, right: b };
}
function txt(s, o = {}) { return new TextRun({ text: s, ...o }); }
function P(runs, o = {}) {
  return new Paragraph({ children: Array.isArray(runs) ? runs : [typeof runs === 'string' ? txt(runs) : runs], ...o });
}
function bullet(text, level = 0) {
  const runs = Array.isArray(text) ? text : [txt(text)];
  return new Paragraph({ children: runs, numbering: { reference: 'bul', level }, spacing: { after: 60 } });
}
function H1(text) { return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 260, after: 120 } }); }
function H2(text) { return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 90 } }); }
function body(text, o = {}) { return P(Array.isArray(text) ? text : [txt(text)], { spacing: { after: 120 }, alignment: AlignmentType.JUSTIFIED, ...o }); }

function cell(content, { w, shade, bold, color, align, size, valign } = {}) {
  const runs = (Array.isArray(content) ? content : [content]).map((c) =>
    typeof c === 'string' ? txt(c, { bold, color, size }) : c
  );
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: shade ? { type: ShadingType.CLEAR, color: 'auto', fill: shade } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    verticalAlign: valign || VerticalAlign.CENTER,
    borders: cellBorders(),
    children: [new Paragraph({ children: runs, alignment: align || AlignmentType.LEFT, spacing: { after: 0 } })],
  });
}
function headerRow(labels, widths, { size } = {}) {
  return new TableRow({
    tableHeader: true,
    children: labels.map((l, i) => cell(l, { w: widths[i], shade: NAVY, bold: true, color: WHITE, align: AlignmentType.CENTER, size })),
  });
}
function table(widths, rows) {
  return new Table({ columnWidths: widths, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, rows });
}

// ── flow "diagram": a row of shaded step boxes separated by arrows ──
function flowRow(steps) {
  const arrowW = 260;
  const stepW = Math.floor((CONTENT_W - arrowW * (steps.length - 1)) / steps.length);
  const widths = [];
  const cells = [];
  steps.forEach((s, i) => {
    widths.push(stepW);
    cells.push(cell([txt(s.title, { bold: true, color: WHITE, size: 18 }), ...(s.sub ? [new TextRun({ break: 1 }), txt(s.sub, { color: 'E5EEF6', size: 15 })] : [])],
      { w: stepW, shade: s.color || STEEL, align: AlignmentType.CENTER }));
    if (i < steps.length - 1) { widths.push(arrowW); cells.push(cell('→', { w: arrowW, align: AlignmentType.CENTER, bold: true, size: 22 })); }
  });
  const t = new Table({
    columnWidths: cols(CONTENT_W, widths), width: { size: CONTENT_W, type: WidthType.DXA },
    rows: [new TableRow({ children: cells })],
  });
  // strip inner borders for a clean flow look
  return t;
}

const children = [];

// ═══════════════════ COVER ═══════════════════
children.push(
  P([txt('NATIONAL MINERAL WATER COMPANY SAOG', { bold: true, color: STEEL, size: 20 })], { alignment: AlignmentType.CENTER, spacing: { before: 1600, after: 40 } }),
  P([txt('Sultanate of Oman', { color: GREY, size: 18 })], { alignment: AlignmentType.CENTER, spacing: { after: 600 } }),
  P([txt('Customer Master Management', { bold: true, color: NAVY, size: 44 })], { alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
  P([txt('Standard Operating Procedure & Access-Control Policy', { color: NAVY, size: 26 })], { alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
  P([txt('NMWC Unified CRM — supporting the Temix ERP', { italics: true, color: GREY, size: 20 })], { alignment: AlignmentType.CENTER, spacing: { after: 900 } }),
);
children.push(table(cols(CONTENT_W, [3, 5]), [
  ['Document reference', 'NMWC-CRM-SOP-001'],
  ['Version', '1.1 (for approval)'],
  ['Classification', 'Internal'],
  ['Document owner', 'CRM / IT (Master Data)'],
  ['Applies to', 'All CRM users: sales, supervision, finance, management, data stewardship'],
  ['Status', 'DRAFT — submitted for management approval'],
].map((r) => new TableRow({ children: [cell(r[0], { w: cols(CONTENT_W, [3, 5])[0], shade: LIGHT, bold: true }), cell(r[1], { w: cols(CONTENT_W, [3, 5])[1] })] }))));
children.push(P([new PageBreak()]));

// ═══════════════════ DOCUMENT CONTROL & APPROVAL ═══════════════════
children.push(H1('Document Control & Approval'));
children.push(H2('Version history'));
{
  const w = cols(CONTENT_W, [1.4, 2, 2.4, 3.2]);
  children.push(table(w, [
    headerRow(['Version', 'Date', 'Author', 'Summary'], w),
    ...[
      ['1.0', '__________', 'CRM / IT', 'Initial policy — customer lifecycle, approval chains, access-control matrix.'],
      ['1.1', '__________', 'CRM / IT', 'Added §8 Bulk Data Load (Import) Procedure: staged load, promotion in passes with resume, the mandatory post-load reconciliation, and the rule that bulk-loaded customers do not pass through the approval chain. Sections 8–10 renumbered to 9–11.'],
    ].map(
      (r) => new TableRow({ children: r.map((c, i) => cell(c, { w: w[i] })) })
    ),
  ]));
}
children.push(H2('Approval & sign-off'));
children.push(body('By signing below, the approver endorses this policy — the customer-creation workflow, the credit-approval chain, and the access rights each role is granted — as the governing procedure for the customer master.'));
{
  const w = cols(CONTENT_W, [2.4, 2.4, 2.4, 1.8]);
  const rows = [
    headerRow(['Role', 'Name', 'Signature', 'Date'], w),
    ...[
      'Prepared by — CRM / IT',
      'Reviewed by — Finance Manager',
      'Reviewed by — General Manager (GM)',
      'Approved by — Management / Board',
    ].map((role) => new TableRow({
      children: [cell(role, { w: w[0], shade: LIGHT, bold: true }), cell(' ', { w: w[1] }), cell(' ', { w: w[2] }), cell(' ', { w: w[3] })],
    })),
  ];
  children.push(table(w, rows));
}
children.push(P([new PageBreak()]));

// ═══════════════════ TOC ═══════════════════
children.push(H1('Table of Contents'));
children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));
children.push(P([new PageBreak()]));

// ═══════════════════ 1. PURPOSE & SCOPE ═══════════════════
children.push(H1('1.  Purpose & Scope'));
children.push(body('This document defines the standard operating procedure (SOP) for creating, approving and maintaining customer master records in the NMWC Unified CRM, and the access-control policy that governs what each type of user account may do.'));
children.push(body([txt('Purpose: ', { bold: true }), txt('to ensure that every customer added to the master is captured with proper field evidence, reviewed through the correct approval chain, and — for credit customers — cleared by finance and management before the record goes live and is pushed to the Temix ERP.')]));
children.push(body([txt('Scope: ', { bold: true }), txt('all customer and branch records, all approval activity, and all user accounts in the CRM. It covers the full lifecycle: field capture → approval → materialization → enrichment → branch closure/reactivation → Temix synchronization.')]));
children.push(body([txt('System of record: ', { bold: true }), txt('the Temix ERP remains the financial system of record. The CRM is the master-data and field-operations layer that feeds Temix; it does not replace it.')]));

// ═══════════════════ 2. DEFINITIONS ═══════════════════
children.push(H1('2.  Definitions & System Overview'));
{
  const w = cols(CONTENT_W, [2.3, 5.7]);
  const defs = [
    ['Customer', 'A legal trading entity, identified by its customer code and a CRM-allocated NMWC code. One customer may have several branches.'],
    ['Branch', 'A physical outlet of a customer (identified by a globally-unique branch code). Field data (GPS, photos, equipment) is captured per branch.'],
    ['CASH customer', 'Pays on delivery. Onboarding requires sales + accounts approval only.'],
    ['CREDIT customer', 'Granted a credit limit and payment terms. Onboarding additionally requires Finance Manager and GM approval.'],
    ['Approval chain', 'The fixed sequence of approver steps a request must pass, in order, before it takes effect.'],
    ['Materialization', 'The moment a net-new customer becomes a live record — only after the FINAL approval. Nothing exists in the master before that.'],
    ['SLA', 'The working-hours time budget for each approval step, after which the step escalates. Working week: Sunday–Thursday, 08:00–17:00 (Asia/Muscat).'],
    ['Region scope', 'The rule that limits which records a user can see and act on (own route / own team / managed region / all).'],
    ['Steward', 'The data-operations administrator who runs bulk imports, duplicate merges and Temix synchronization.'],
  ];
  children.push(table(w, [
    headerRow(['Term', 'Meaning'], w),
    ...defs.map((d) => new TableRow({ children: [cell(d[0], { w: w[0], shade: LIGHT, bold: true }), cell(d[1], { w: w[1] })] })),
  ]));
}

// ═══════════════════ 3. ROLES ═══════════════════
children.push(H1('3.  Roles & Responsibilities'));
children.push(body('The CRM has eight account types. Every user is assigned exactly one role.'));
{
  const w = cols(CONTENT_W, [1.9, 6.1]);
  const roles = [
    ['Salesman', 'Field sales. Creates and enriches customers on their OWN route, capturing the required photos and GPS. Submits branch-closure and reactivation requests. Cannot approve anything.'],
    ['Supervisor', 'First-line approver for their own team of salesmen. Approves the first step of every new-customer request and all enrichment edits from their team.'],
    ['Accountant', 'Region-scoped FINAL approver. The last gate on every new customer (cash and credit). On the Accountant’s approval the customer materializes and is queued for Temix.'],
    ['Finance Manager', 'Organization-wide credit approver — the second step of the CREDIT chain. Reviews the requested credit limit and terms.'],
    ['GM (General Manager)', 'Organization-wide credit approver — the third step of the CREDIT chain. Final management endorsement of credit before the Accountant.'],
    ['Manager', 'Regional field-force administrator. Creates and manages Salesman / Supervisor / Viewer accounts, approves branch REACTIVATIONS (photo-gated), stands in for an absent Supervisor on the first approval step, and sees a regional dashboard. Cannot create finance/approver accounts.'],
    ['Steward', 'Data-operations administrator. Runs the bulk account & customer master imports, merges duplicate customers, runs Temix synchronization, and provisions the approver accounts (Accountant / Finance Manager / GM). Does not sit in the approval chain.'],
    ['Viewer', 'Read-only management visibility across the whole master. Makes no changes and approves nothing.'],
  ];
  children.push(table(w, [
    headerRow(['Role', 'Responsibility'], w),
    ...roles.map((r) => new TableRow({ children: [cell(r[0], { w: w[0], shade: LIGHT, bold: true }), cell(r[1], { w: w[1] })] })),
  ]));
}

children.push(P([new PageBreak()]));
// ═══════════════════ 4. PROCESS FLOW ═══════════════════
children.push(H1('4.  The Customer Lifecycle — End-to-End Process Flow'));
children.push(body('A new customer moves through five stages. The record does NOT exist in the master until the final approval; every step is recorded in the audit log.'));
children.push(body([txt('Two ways into the master. ', { bold: true }), txt('This section describes customer creation in the FIELD, which is how every customer acquired after go-live enters the system. The other path is the bulk load used to migrate and reconcile customers that already exist in Temix; it is performed by the Data Steward, does not travel the approval chain, and is governed separately by §8.')]));

children.push(H2('4.1  High-level flow'));
children.push(flowRow([
  { title: '1. Capture', sub: 'Salesman — photos + GPS', color: STEEL },
  { title: '2. Submit', sub: 'enters approval chain', color: STEEL },
  { title: '3. Approve', sub: 'chain, step by step', color: NAVY },
  { title: '4. Go live', sub: 'materialize + code', color: GREEN ? '1B7A3D' : STEEL },
  { title: '5. Sync', sub: 'push to Temix', color: STEEL },
]));
children.push(P(' ', { spacing: { after: 60 } }));

children.push(H2('4.2  Step detail'));
children.push(bullet([txt('1. Capture (Salesman). ', { bold: true }), txt('At the shop the salesman records the customer and branch details, and captures the mandatory evidence: the CR (commercial registration) document photo, the shop photo and the signboard photo, plus GPS inside Oman. The salesman selects the payment basis — CASH or CREDIT — and, for credit, enters the requested credit limit, payment-term days and uploads the guarantee/security document.')]));
children.push(bullet([txt('2. Submit (Salesman). ', { bold: true }), txt('The system checks all mandatory fields are present, then submits the request into the approval chain. The SLA clock starts. Incomplete work can be saved as a draft instead.')]));
children.push(bullet([txt('3. Approve (chain). ', { bold: true }), txt('The request advances one approver step at a time (see §5). Any approver may REJECT and return it to the salesman for correction. No customer data is written to the master during these steps.')]));
children.push(bullet([txt('4. Go live / materialize (final approval). ', { bold: true }), txt('On the FINAL (Accountant) approval the customer and its branches are created as live records, a unique NMWC code is allocated, and the credit figures are copied verbatim. The record is immediately queued for Temix upload.')]));
children.push(bullet([txt('5. Synchronize (Steward). ', { bold: true }), txt('The steward runs the outbound Temix batch, which pushes the new/updated customers and their credit data to the ERP; an inbound refresh backfills the Temix code onto the CRM record.')]));
children.push(body([txt('Ongoing lifecycle: ', { bold: true }), txt('after go-live the salesman enriches the record (photos, contacts, equipment) through single-step Supervisor approval; a closed shop is marked closed (Salesman + fresh photo → Supervisor) and a reopened shop is reactivated (Salesman + fresh photo → Manager). The steward merges duplicates and re-runs Temix as needed.')]));

// ═══════════════════ 5. APPROVAL POLICY ═══════════════════
children.push(P([new PageBreak()]));
children.push(H1('5.  Approval Policy'));

children.push(H2('5.1  New CASH customer'));
children.push(flowRow([
  { title: 'Salesman', sub: 'submit' },
  { title: 'Supervisor', sub: 'own team', color: NAVY },
  { title: 'Accountant', sub: 'region — FINAL', color: '1B7A3D' },
]));
children.push(P(' ', { spacing: { after: 40 } }));
children.push(body('Two approval steps. The Supervisor of the submitting salesman confirms the field work; the region Accountant gives the final approval, at which point the customer goes live.'));

children.push(H2('5.2  New CREDIT customer'));
children.push(flowRow([
  { title: 'Salesman', sub: 'submit' },
  { title: 'Supervisor', sub: 'own team', color: NAVY },
  { title: 'Finance Mgr', sub: 'org-wide', color: NAVY },
  { title: 'GM', sub: 'org-wide', color: NAVY },
  { title: 'Accountant', sub: 'region — FINAL', color: '1B7A3D' },
]));
children.push(P(' ', { spacing: { after: 40 } }));
children.push(body([txt('Four approval steps. Credit onboarding always requires Finance Manager AND GM in addition to Supervisor and Accountant — there is no value threshold that skips them. ', {}), txt('Approvers approve or reject the requested figures as submitted; they cannot change the amount — a different limit means reject-and-resubmit. ', { bold: true }), txt('The credit limit and terms only take effect when the Accountant gives the final approval.')]));

children.push(H2('5.3  Enrichment edit (existing customer)'));
children.push(flowRow([{ title: 'Salesman', sub: 'submit edit' }, { title: 'Supervisor', sub: 'own team — FINAL', color: '1B7A3D' }]));
children.push(P(' ', { spacing: { after: 40 } }));
children.push(body('A single Supervisor step. If the salesman’s Supervisor is unavailable, a Manager whose region overlaps the customer may act on that step (fallback). Managers and Stewards may apply corrections directly (no queue) within their scope. The payment basis (CASH↔CREDIT) can NEVER be changed through an ordinary edit — a credit change must go through credit onboarding.'));

children.push(H2('5.4  Branch closure and reactivation'));
children.push(bullet([txt('Close a branch: ', { bold: true }), txt('the salesman submits a closure with a fresh photo of the shut shop; the Supervisor approves. (Imported customers with no historic photos can still be closed.)')]));
children.push(bullet([txt('Reactivate a closed branch: ', { bold: true }), txt('the salesman submits a reactivation with a fresh photo proving the shop reopened; a MANAGER (region-scoped) reviews the evidence and approves. Reactivation is deliberately a management decision, not a supervisor one.')]));

children.push(H2('5.5  Cross-cutting rules'));
children.push(bullet([txt('Separation of duty. ', { bold: true }), txt('A submitter can never approve their own request, and no single person may act on two different steps of the same request.')]));
children.push(bullet([txt('Region scope (fail-closed). ', { bold: true }), txt('Approvers see and act only on requests in their own region/team. A user with no region assigned sees nothing (they cannot fall back to seeing everything).')]));
children.push(bullet([txt('All-or-nothing. ', { bold: true }), txt('A net-new customer is written to the master only on the final approval — a request abandoned mid-chain leaves no partial record.')]));
children.push(bullet([txt('Audit. ', { bold: true }), txt('Every submission, approval, rejection and administrative change writes an immutable audit-log entry (who, what, when).')]));

children.push(H2('5.6  Service levels (SLA)'));
children.push(body('Each step has a working-hours budget (working week Sunday–Thursday, 08:00–17:00, Asia/Muscat). A step that exceeds its budget is flagged and escalated.'));
{
  const w = cols(CONTENT_W, [4, 2, 2]);
  const rows = [
    headerRow(['Approval step', 'Role', 'Budget (working hrs)'], w),
    ['Supervisor step (create & edits)', 'Supervisor', '8'],
    ['Final approval', 'Accountant', '9'],
    ['Credit — finance review', 'Finance Manager', '16'],
    ['Credit — management review', 'GM', '24'],
    ['Reactivation review', 'Manager', '16'],
  ].slice(1).map((r) => new TableRow({ children: r.map((c, i) => cell(c, { w: w[i], align: i === 2 ? AlignmentType.CENTER : AlignmentType.LEFT })) }));
  children.push(table(w, [headerRow(['Approval step', 'Role', 'Budget (working hrs)'], w), ...rows]));
}

// ═══════════════════ 6. ACCESS CONTROL MATRIX ═══════════════════
children.push(P([new PageBreak()]));
children.push(H1('6.  Access-Control Matrix — What Each Account Can Do'));
children.push(body('The table below is the authoritative statement of rights. A cell shows the scope of the right: Own = own route, Team = own team’s routes, Rgn = managed region(s), All = entire master, ✓ = permitted, — = not permitted.'));
{
  const roleW = 720;
  const actW = CONTENT_W - roleW * 8;
  const w = [actW, ...Array(8).fill(roleW)];
  const S = 15; // small font for density
  const roles = ['Sales', 'Super', 'Acct', 'Fin.Mgr', 'GM', 'Mgr', 'Stew', 'View'];
  const M = [
    ['Create a new customer (submit)', 'Own', '—', '—', '—', '—', '—', 'bulk', '—'],
    ['Approve — Supervisor step', '—', 'Team', '—', '—', '—', 'Rgn*', '—', '—'],
    ['Approve — Finance Manager step', '—', '—', '—', 'All', '—', '—', '—', '—'],
    ['Approve — GM step', '—', '—', '—', '—', 'All', '—', '—', '—'],
    ['Approve — Accountant (final) step', '—', '—', 'Rgn', '—', '—', '—', '—', '—'],
    ['Reject / return for correction', '—', '✓', '✓', '✓', '✓', '✓', '—', '—'],
    ['Edit / enrich a customer (submit)', 'Own', '—', '—', '—', '—', '—', '—', '—'],
    ['Edit a customer directly (no queue)', '—', '—', '—', '—', '—', 'Rgn', 'All', '—'],
    ['Approve an enrichment edit', '—', 'Team', '—', '—', '—', 'Rgn*', '—', '—'],
    ['Close a branch (submit + photo)', 'Own', '—', '—', '—', '—', '—', '—', '—'],
    ['Reactivate a closed branch (approve)', 'req', '—', '—', '—', '—', 'Rgn', '—', '—'],
    ['Merge duplicate customers', '—', '—', '—', '—', '—', '—', '✓', '—'],
    ['Import account / customer master', '—', '—', '—', '—', '—', '—', '✓', '—'],
    ['Run Temix sync (export / refresh)', '—', '—', '—', '—', '—', '—', '✓', '—'],
    ['Create/manage field users (SM/SUP/VW)', '—', '—', '—', '—', '—', '✓', '✓', '—'],
    ['Create/manage approver users (ACC/FM/GM)', '—', '—', '—', '—', '—', '—', '✓', '—'],
    ['View customer records', 'Own', 'Team', 'Rgn', 'All', 'All', 'Rgn', 'All', 'All'],
    ['Export customer data (scope-filtered)', '—', 'Team', 'Rgn', 'All', 'All', 'Rgn', 'All', 'All'],
  ];
  const rows = [headerRow(['Action', ...roles], w, { size: 16 })];
  M.forEach((r, idx) => {
    rows.push(new TableRow({
      children: r.map((c, i) => cell(c, {
        w: w[i], size: S,
        shade: i === 0 ? (idx % 2 ? WHITE : LIGHT) : (c === '—' ? WHITE : (idx % 2 ? WHITE : LIGHT)),
        bold: i === 0,
        color: c === '—' ? GREY : (['✓', 'Own', 'Team', 'Rgn', 'All', 'bulk', 'req'].includes(c) ? GREEN : undefined),
        align: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
      })),
    }));
  });
  children.push(table(w, rows));
  children.push(P([txt('* Manager acts on the Supervisor step only as a fallback for their region when the submitter’s Supervisor is unavailable.  “bulk” = via the Steward import, not the per-customer create screen.  “req” = the salesman raises the reactivation request; a Manager approves it.', { italics: true, color: GREY, size: 16 })], { spacing: { before: 80 } }));
}

// ═══════════════════ 7. SCENARIO PLAYBOOK ═══════════════════
children.push(P([new PageBreak()]));
children.push(H1('7.  Scenario Playbook'));
children.push(body('Common situations and exactly who does what.'));
{
  const w = cols(CONTENT_W, [0.5, 2.6, 4.9]);
  const sc = [
    ['A', 'New CASH shop', 'Salesman captures photos + details and submits → Supervisor approves → Accountant approves → customer is live and queued for Temix.'],
    ['B', 'New CREDIT shop', 'Salesman submits with requested limit + guarantee → Supervisor → Finance Manager → GM → Accountant. Only after the Accountant’s approval does the credit take effect.'],
    ['C', 'Rejected & corrected', 'Any approver rejects with a reason → the request returns to the salesman as “needs correction” → the salesman fixes and resubmits → the chain restarts from the first step.'],
    ['D', 'Adding a missing phone / photo', 'Salesman opens the live customer, edits, submits → Supervisor approves → change goes live. (No finance involvement — enrichment is a single step.)'],
    ['E', 'A shop closes', 'Salesman photographs the shut shop and submits a closure → Supervisor approves → the branch is marked CLOSED.'],
    ['F', 'A closed shop reopens', 'Salesman photographs the reopened shop and submits a reactivation → a MANAGER reviews the fresh photo and approves → the branch is ACTIVE again.'],
    ['G', 'Duplicate found', 'The Steward opens Duplicates, picks the record to keep, confirms (with a reason if the two are in different regions) → the duplicate is merged and archived.'],
    ['H', 'Go-live bulk load', 'The Steward imports the Account master (regions, routes, people), then the Customer master; reviews the staged rows; promotes them — the promotion runs in passes and reports progress; then reconciles the counts. Full procedure in §8.'],
    ['I', 'Supervisor on leave', 'A Manager whose region overlaps the customer approves the pending Supervisor step so work is not blocked (fallback).'],
    ['J', 'Push to Temix', 'The Steward runs the outbound batch; new/updated customers and their credit data are exported to Temix, and the returned Temix codes are backfilled to the CRM.'],
    ['K', 'Change a customer to CREDIT', 'This is NOT an edit. The payment basis cannot be switched in the edit screen; it is handled as a fresh credit onboarding / via Temix, so finance and GM review it.'],
    ['L', 'A bulk load is interrupted', 'Everything already promoted is saved. The batch shows “Promote interrupted” and appears in the Steward’s work list as “Import to resume”; the Steward clicks Resume promote and it continues from exactly where it stopped. Nothing is loaded twice or skipped (§8.3).'],
    ['M', 'Rows rejected during a load', 'A rejected row is NOT in the master. The Steward reviews each one (rejected rows are listed first, with the reason), corrects the source file, and re-imports the affected customers. The load is not complete until every rejected and quarantined row is resolved or formally accepted (§8.4).'],
  ];
  const rows = [headerRow(['#', 'Scenario', 'Who does what'], w)];
  sc.forEach((r, idx) => rows.push(new TableRow({
    children: [
      cell(r[0], { w: w[0], shade: NAVY, bold: true, color: WHITE, align: AlignmentType.CENTER }),
      cell(r[1], { w: w[1], shade: idx % 2 ? WHITE : LIGHT, bold: true }),
      cell(r[2], { w: w[2], shade: idx % 2 ? WHITE : LIGHT }),
    ],
  })));
  children.push(table(w, rows));
}

// ═══════════════════ 8. BULK DATA LOAD (IMPORT) ═══════════════════
children.push(H1('8.  Bulk Data Load (Import) Procedure'));
children.push(body('The customer master is first populated — and thereafter reconciled against Temix — by a bulk load performed by the Data Steward. Because a full master runs to several thousand rows, the load is a controlled, staged and resumable procedure rather than a single action. This section is the authoritative procedure for it.'));

children.push(H2('8.1  Order of loading (mandatory)'));
children.push(bullet([txt('1. Create the MANAGER and STEWARD accounts in the application first. ', { bold: true }), txt('The import deliberately CANNOT create these two roles, so that no administrative account can ever be introduced from a spreadsheet.')]));
children.push(bullet([txt('2. Import the Account master ', { bold: true }), txt('— regions, then routes, then people (salesmen, supervisors, accountants, Finance Manager, GM, viewers). Routes must exist before the customers that reference them.')]));
children.push(bullet([txt('3. Import the Customer master ', { bold: true }), txt('— customers and their branches, one row per branch.')]));
children.push(body([txt('Regions and routes are matched on their CODE, never their name. ', { bold: true }), txt('A customer whose region or route code is unknown is parked in an UNASSIGNED area with a warning for the Steward to resolve — it is never silently discarded.')]));

children.push(H2('8.2  Two stages: stage, then promote'));
children.push(body('An import is never applied directly to the live master. It has two distinct stages, and the record does not exist until the second.'));
children.push(bullet([txt('Stage (upload). ', { bold: true }), txt('The file is validated row by row. Valid rows are held as “clean”; rows that fail validation, or that collide with an existing customer on phone or commercial registration, are “quarantined” for the Steward to inspect. Nothing has entered the master at this point.')]));
children.push(bullet([txt('Promote. ', { bold: true }), txt('The Steward reviews the staged result and promotes it. Only now are the live customer and branch records created.')]));

children.push(H2('8.3  Promotion runs in passes and may be resumed'));
children.push(body('A full master is far too large to load in a single operation, so promotion works through it in successive passes, reporting progress as it goes (for example “1,200 done, 2,100 left”). The Steward keeps the screen open until it reports completion.'));
children.push(bullet([txt('Interruption is safe. ', { bold: true }), txt('If the load is interrupted — the screen is closed, the connection drops, the session times out — every record already promoted is permanently saved. The batch is shown as “Promote interrupted”, and a “Resume promote” action continues from exactly where it stopped. No record is loaded twice and none is skipped.')]));
children.push(bullet([txt('An interrupted load is a work item. ', { bold: true }), txt('It appears in the Steward’s work list as “Import to resume”, so a half-finished load cannot be forgotten.')]));
children.push(bullet([txt('One load at a time. ', { bold: true }), txt('Only one customer import may be promoted at any moment; a second is refused with a message naming the file already running. If a corrected file must be loaded, the first load is finished (or abandoned) first.')]));
children.push(bullet([txt('A stalled load stops itself. ', { bold: true }), txt('If a pass makes no progress, the system halts and reports it rather than retrying indefinitely. This is escalated to IT — it must never be answered by repeatedly re-clicking.')]));

children.push(H2('8.4  Mandatory reconciliation after every load'));
children.push(body([txt('A load is not complete when the screen stops moving; it is complete when it has been reconciled. ', { bold: true }), txt('The batch page reports six figures, and the Steward must check them before declaring the load done:')]));
{
  const w = cols(CONTENT_W, [2.2, 5.8]);
  children.push(table(w, [
    headerRow(['Figure', 'What the Steward must confirm'], w),
    ...[
      ['Total', 'Matches the number of data rows in the source file.'],
      ['Clean / Quarantined', 'Every quarantined row has been inspected; each is either corrected and re-imported, or formally accepted as excluded.'],
      ['Promoted', 'The rows that are now live in the master.'],
      ['Rejected', 'MUST be reviewed one by one. A rejected row is NOT in the master. The reason is shown against each row, and rejected rows are listed first so none is missed.'],
      ['Left to promote', 'Must be zero. Any other value means the load is unfinished — resume it.'],
      ['Reconciliation', 'Promoted + Rejected + Quarantined must equal Total. Record the figures as evidence that the load was checked.'],
    ].map((r, i) => new TableRow({
      children: [cell(r[0], { w: w[0], shade: LIGHT, bold: true }), cell(r[1], { w: w[1], shade: i % 2 ? WHITE : undefined })],
    })),
  ]));
}
children.push(body([txt('Unresolved rejected or quarantined rows are missing customers. ', { bold: true, color: AMBER }), txt('They must be corrected and re-imported, or explicitly signed off as excluded, before the load is treated as complete.')]));

children.push(H2('8.5  Bulk-loaded customers do not pass through the approval chain'));
children.push(body([txt('This is a deliberate policy decision requiring management endorsement. ', { bold: true }), txt('Customers introduced by a bulk import are existing NMWC customers being migrated or reconciled from Temix — not new applications — so they are created directly and do NOT travel the Supervisor / Finance Manager / GM / Accountant chain described in §5. Any customer created in the field after go-live does follow that chain in full.')]));
children.push(body('The compensating controls are that importing is restricted to the Data Steward alone, that the Steward sits outside the approval chain and so cannot approve their own work, that every import and every promotion pass is written to the immutable audit log with its counts, and that the reconciliation in §8.4 is mandatory.'));

children.push(H2('8.6  What an import may and may not create'));
children.push(bullet([txt('May create or update: ', { bold: true }), txt('regions, routes, user accounts for salesmen, supervisors, accountants, Finance Manager, GM and viewers; customers and their branches.')]));
children.push(bullet([txt('May never create: ', { bold: true }), txt('MANAGER or STEWARD accounts — these exist only through the application, created by an existing administrator. An import may also never promote an existing user INTO, or demote one OUT OF, those two roles. Administrative privilege therefore cannot be granted from a spreadsheet under any circumstances.')]));
children.push(bullet([txt('Never overwritten by a re-import: ', { bold: true }), txt('an existing user keeps their password, role and supervisor unless the file explicitly says otherwise; and field-captured customer data (photographs, GPS, equipment counts, contacts) is never cleared by a blank cell in a later file.')]));

children.push(P([new PageBreak()]));

// ═══════════════════ 9. DATA OWNERSHIP / TEMIX ═══════════════════
children.push(P([new PageBreak()]));
children.push(H1('9.  Data Ownership & the Temix Boundary'));
children.push(body('Temix is the financial system of record. The CRM owns field and identity master data and pushes it to Temix; credit onboarding originates in the CRM and flows outbound to Temix.'));
{
  const w = cols(CONTENT_W, [3.2, 4.8]);
  const rows = [
    headerRow(['Owned & maintained in the CRM', 'Provided by / reconciled with Temix'], w),
    ['Customer & branch identity, contacts, addresses, GPS, photos, channel, equipment, day-of-visit', 'The Temix customer code (crosswalk), returned after upload'],
    ['Requested credit limit & terms (created through the approval chain, pushed outbound)', 'Confirmation that the customer/credit landed in Temix'],
    ['Approval history, audit trail, region/route structure', 'ERP-side financial transactions (out of CRM scope)'],
  ];
  children.push(table(w, [rows[0], ...rows.slice(1).map((r) => new TableRow({ children: [cell(r[0], { w: w[0] }), cell(r[1], { w: w[1] })] }))]));
}
children.push(body([txt('Direction of credit: ', { bold: true }), txt('credit limits and terms are decided in the CRM approval chain and pushed OUTBOUND to Temix. (If Temix is ever to become the authoritative source for credit changes on existing customers, that is a separate decision to confirm with the ERP team.)')], { spacing: { before: 120 } }));

// ═══════════════════ 10. CONTROLS ═══════════════════
children.push(H1('10.  Controls, Safeguards & Audit'));
children.push(bullet([txt('Evidence-gated creation: ', { bold: true }), txt('a customer cannot be submitted without the CR photo and the branch shop/signboard photos; credit requires a guarantee document.')]));
children.push(bullet([txt('Three-tier credit control: ', { bold: true }), txt('every credit customer is reviewed by Finance Manager, GM and Accountant; the requested figures cannot be silently amended by an approver.')]));
children.push(bullet([txt('Segregation of the approver tier: ', { bold: true }), txt('only the Steward can create Accountant / Finance Manager / GM accounts — a regional Manager cannot mint or take over the credit-approval chain.')]));
children.push(bullet([txt('Region containment: ', { bold: true }), txt('users only see and act on their own scope; an unscoped user sees nothing by default.')]));
children.push(bullet([txt('Duplicate protection: ', { bold: true }), txt('the system flags customers that share a CR number or phone across different entities for steward review; merges are steward-only and confirmed.')]));
children.push(bullet([txt('Confidential documents: ', { bold: true }), txt('CR and credit-guarantee documents are never cached by the browser and are access-checked on every view.')]));
children.push(bullet([txt('Bulk-load reconciliation: ', { bold: true }), txt('importing is restricted to the Data Steward, who sits outside the approval chain; every load — and every pass of a resumed load — is written to the audit log with its counts; and the load is not complete until Promoted + Rejected + Quarantined equals Total (§8.4).')]));
children.push(bullet([txt('No silent data loss on import: ', { bold: true }), txt('a customer whose region or route is unknown is parked in UNASSIGNED with a warning rather than discarded; a customer that could not be loaded because of a technical fault is retried automatically rather than written off; and a load that stops making progress halts and reports instead of retrying indefinitely.')]));
children.push(bullet([txt('Full audit trail: ', { bold: true }), txt('every create, approve, reject, edit, merge, import and administrative action is recorded immutably.')]));

// ═══════════════════ 11. EXCEPTIONS ═══════════════════
children.push(H1('11.  Exceptions & Escalation'));
children.push(bullet('A step that breaches its SLA is flagged and escalated to the next approver/level so requests are not silently stuck.'));
children.push(bullet('If a Supervisor is unavailable, a region Manager may act on the Supervisor step (fallback) — see Scenario I.'));
children.push(bullet('A customer that cannot be placed in a known region/route on import is parked in an UNASSIGNED area with a warning for the Steward to resolve — it is never silently dropped.'));
children.push(bullet('Any deviation from this policy (e.g. a manual data fix) must be performed by the Steward and is captured in the audit log.'));

children.push(P([txt('— End of policy —', { italics: true, color: GREY })], { alignment: AlignmentType.CENTER, spacing: { before: 300 } }));

// ═══════════════════ DOCUMENT ═══════════════════
const doc = new Document({
  creator: 'NMWC CRM',
  title: 'Customer Master Management SOP & Access-Control Policy',
  styles: {
    default: { document: { run: { font: 'Calibri', size: 21 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { bold: true, size: 30, color: NAVY }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: MID, space: 4 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { bold: true, size: 24, color: STEEL }, paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [{ reference: 'bul', levels: [
      { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraphProperties: { indent: { left: 360, hanging: 240 } } } },
      { level: 1, format: LevelFormat.BULLET, text: '◦', alignment: AlignmentType.LEFT, style: { paragraphProperties: { indent: { left: 780, hanging: 240 } } } },
    ] }],
  },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    headers: { default: new Header({ children: [P([txt('NMWC — Customer Master SOP & Access-Control Policy', { color: GREY, size: 16 })], { alignment: AlignmentType.RIGHT })] }) },
    footers: { default: new Footer({ children: [P([txt('Internal — for approval    ·    Page ', { color: GREY, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: GREY, size: 16 }), txt(' of ', { color: GREY, size: 16 }), new TextRun({ children: [PageNumber.TOTAL_PAGES], color: GREY, size: 16 })], { alignment: AlignmentType.CENTER })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const out = path.join('docs', 'NMWC-Customer-Master-SOP-and-Access-Policy.docx');
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(out, buf);
  console.log('Wrote ' + out + ' (' + Math.round(buf.length / 1024) + ' KB)');
});
