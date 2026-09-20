/**
 * Generate the go-live import templates as .xlsx, with headers that EXACTLY match
 * the importer's recognized columns, example rows, and an Instructions sheet.
 *
 * Output: docs/import-templates/{account-master-template,customer-master-template}.xlsx
 * Run:    npx tsx scripts/build-import-templates.ts
 *
 * Contract sources (keep in sync):
 *   - Account master: services/imports.ts uploadAccountMasterCore (Regions/Routes/Users)
 *   - Customer master: services/imports.ts uploadCustomerMasterCore parse (`parsed` obj)
 */
import ExcelJS from 'exceljs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Col = {
  key: string;
  required: string; // 'Required' | 'Optional' | 'Required for SALESMAN' etc.
  format: string;
  notes: string;
};

const HEADER_FILL = 'FF1E3A5F';
const EXAMPLE_FILL = 'FFFFF7E6';

function styleHeaderRow(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  row.alignment = { vertical: 'middle' };
  row.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function addDataSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  cols: Col[],
  examples: Record<string, string | number>[]
) {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = cols.map((c) => ({
    header: c.key,
    key: c.key,
    width: Math.max(14, c.key.length + 4),
  }));
  styleHeaderRow(ws);
  for (const ex of examples) {
    const r = ws.addRow(ex);
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXAMPLE_FILL } };
  }
  return ws;
}

function addInstructions(
  wb: ExcelJS.Workbook,
  title: string,
  intro: string[],
  sections: { sheet: string; cols: Col[] }[],
  footer: string[]
) {
  const ws = wb.addWorksheet('Instructions');
  ws.columns = [
    { header: 'Column', key: 'k', width: 22 },
    { header: 'Required?', key: 'r', width: 26 },
    { header: 'Format / values', key: 'f', width: 40 },
    { header: 'Notes', key: 'n', width: 70 },
  ];
  let rowIdx = 1;
  const put = (
    vals: (string | undefined)[],
    opts: { bold?: boolean; fill?: string; span?: boolean } = {}
  ) => {
    const r = ws.getRow(rowIdx++);
    r.getCell(1).value = vals[0] ?? '';
    r.getCell(2).value = vals[1] ?? '';
    r.getCell(3).value = vals[2] ?? '';
    r.getCell(4).value = vals[3] ?? '';
    if (opts.bold) r.font = { bold: true };
    if (opts.fill) r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    r.alignment = { vertical: 'top', wrapText: true };
    return r;
  };
  put([title], { bold: true, fill: HEADER_FILL });
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
  put([]);
  for (const line of intro) put([line]);
  put([]);
  for (const sec of sections) {
    put([`SHEET: ${sec.sheet}`], { bold: true, fill: 'FFE8EEF5' });
    put(['Column', 'Required?', 'Format / values', 'Notes'], { bold: true });
    for (const c of sec.cols) put([c.key, c.required, c.format, c.notes]);
    put([]);
  }
  for (const line of footer) put([line]);
  return ws;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT MASTER  (import FIRST — regions, routes, then people)
// ─────────────────────────────────────────────────────────────────────────────
const regionsCols: Col[] = [
  {
    key: 'code',
    required: 'Required',
    format: '2–20 chars, UPPERCASE, A–Z 0–9 - _',
    notes: 'Unique region code. The CUSTOMER master "sales_region" column matches THIS code.',
  },
  { key: 'name', required: 'Required', format: 'text', notes: 'Display name, e.g. Muscat.' },
];
const routesCols: Col[] = [
  {
    key: 'code',
    required: 'Required',
    format: '2–20 chars, UPPERCASE, A–Z 0–9 - _',
    notes: 'Unique route code. The CUSTOMER master "route" column matches THIS code.',
  },
  {
    key: 'name',
    required: 'Required',
    format: 'text',
    notes: 'Display name, e.g. Muscat Central 1.',
  },
  {
    key: 'region_code',
    required: 'Required',
    format: 'a code from the Regions sheet',
    notes: 'Which region this route belongs to. Must exist in Regions.',
  },
];
const usersCols: Col[] = [
  {
    key: 'username',
    required: 'Required',
    format: 'lowercase, 1–50, a–z 0–9 . _ -',
    notes: 'Login name. Must be lowercase and unique.',
  },
  { key: 'full_name', required: 'Required', format: 'text', notes: "Person's full name." },
  {
    key: 'role',
    required: 'Required',
    format: 'SALESMAN | SUPERVISOR | ACCOUNTANT | FINANCE_MANAGER | GM | VIEWER',
    notes:
      'MANAGER and STEWARD CANNOT be created here — create them in the app (/users) first, then load everyone else here.',
  },
  {
    key: 'password',
    required: 'Required for NEW users',
    format: '12+ characters',
    notes:
      'Only for brand-new users. Leave BLANK for people who already exist (keeps their current password). To change an existing password, set reset_password=yes AND fill this.',
  },
  {
    key: 'supervisor_username',
    required: 'Required for SALESMAN',
    format: 'a username from this sheet',
    notes:
      "The salesman's supervisor. Blank on a re-import = keep the existing supervisor (does not unlink).",
  },
  {
    key: 'route_code',
    required: 'Required for SALESMAN',
    format: 'a code from the Routes sheet',
    notes: 'The route this salesman owns (one salesman per route). Leave blank for non-salesmen.',
  },
  {
    key: 'region_codes',
    required: 'Required for ACCOUNTANT',
    // 'BAT' was the example here and is not a region in this system. A copied
    // example that does not resolve is worse than no example: the import used to
    // drop an unknown code silently, leaving a fail-closed accountant who sees an
    // empty queue for good. It now quarantines the row, so a copied 'BAT' fails
    // loudly — but the example should still be a real code.
    format: 'comma-separated Region codes, e.g. MCT or MCT,BRK',
    notes:
      'Regions this accountant covers — REQUIRED, else the accountant sees no approvals and the credit chain stalls. Go-live issues one accountant per region, so this is normally a SINGLE code. An unknown code now quarantines the row rather than silently clearing the account regions. Ignored for other roles.',
  },
  { key: 'email', required: 'Optional', format: 'email', notes: '' },
  { key: 'phone', required: 'Optional', format: 'text', notes: '' },
  {
    key: 'reset_password',
    required: 'Optional',
    format: 'yes / blank',
    notes:
      'Set to "yes" to rotate an EXISTING user\'s password (also logs them out). Must also fill "password".',
  },
  {
    key: 'change_role',
    required: 'Optional',
    format: 'yes / blank',
    notes:
      'Set to "yes" to change an EXISTING user\'s role. (Cannot promote to/from MANAGER or STEWARD — use /users.)',
  },
  {
    key: 'must_change_password',
    required: 'Optional',
    format: 'yes / blank',
    notes:
      'Set to "yes" to force the person to choose a new password at first login. Only then is a short initial password (4+) accepted; the one they choose must be 12+.',
  },
];

function buildAccountMaster(): Buffer {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NMWC CRM';
  addInstructions(
    wb,
    'NMWC — ACCOUNT MASTER (organization) import',
    [
      'PURPOSE: load your regions, routes, and people (salesmen, supervisors, accountants, finance managers, GM, viewers).',
      'ORDER: import this file FIRST — before the Customer master. Inside the file the app auto-processes supervisors before salesmen, so you can keep everyone on one Users sheet.',
      'HOW TO IMPORT: sign in as the Steward → Import → Account master → upload this file. Rows with problems are listed for review; fix and re-upload (re-import is safe).',
      'DELETE the yellow EXAMPLE rows on each sheet before you import.',
      'The three data sheets MUST stay named exactly: Regions, Routes, Users.',
    ],
    [
      { sheet: 'Regions', cols: regionsCols },
      { sheet: 'Routes', cols: routesCols },
      { sheet: 'Users', cols: usersCols },
    ],
    [
      "TIP: create MANAGER and STEWARD accounts in the app first (Users page), then this import can reference a manager as a salesman's supervisor if you use the management ladder.",
      'RE-IMPORT is idempotent: existing users keep their password/role/supervisor unless you explicitly set reset_password=yes / change_role=yes.',
    ]
  );
  addDataSheet(wb, 'Regions', regionsCols, [
    { code: 'MCT', name: 'Muscat' },
    { code: 'BAT', name: 'Al Batinah' },
  ]);
  addDataSheet(wb, 'Routes', routesCols, [
    { code: 'MCT-01', name: 'Muscat Central 1', region_code: 'MCT' },
    { code: 'MCT-02', name: 'Muscat Central 2', region_code: 'MCT' },
    { code: 'BAT-01', name: 'Batinah North 1', region_code: 'BAT' },
  ]);
  addDataSheet(wb, 'Users', usersCols, [
    {
      username: 'khalid.supervisor',
      full_name: 'Khalid Al Amri',
      role: 'SUPERVISOR',
      password: 'ChangeMe-2026!',
      supervisor_username: '',
      route_code: '',
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    },
    {
      username: 'ahmed.salesman',
      full_name: 'Ahmed Salim',
      role: 'SALESMAN',
      password: 'ChangeMe-2026!',
      supervisor_username: 'khalid.supervisor',
      route_code: 'MCT-01',
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    },
    {
      username: 'salwa.accountant',
      full_name: 'Salwa Nasser',
      role: 'ACCOUNTANT',
      password: 'ChangeMe-2026!',
      supervisor_username: '',
      route_code: '',
      region_codes: 'MCT',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    },
    {
      username: 'faisal.finance',
      full_name: 'Faisal Harthy',
      role: 'FINANCE_MANAGER',
      password: 'ChangeMe-2026!',
      supervisor_username: '',
      route_code: '',
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    },
    {
      username: 'general.manager',
      full_name: 'GM Name',
      role: 'GM',
      password: 'ChangeMe-2026!',
      supervisor_username: '',
      route_code: '',
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    },
  ]);
  // parser looks up sheets by name (Regions/Routes/Users); Instructions is ignored.
  return wb.xlsx.writeBuffer() as unknown as Buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER MASTER  (import SECOND — after regions/routes/salesmen exist)
// ─────────────────────────────────────────────────────────────────────────────
const customerCols: Col[] = [
  {
    key: 'cust_code',
    required: 'Required',
    format: 'text (the ERP/Temix customer code)',
    notes:
      'Customer identity. Repeat the SAME cust_code on several rows to give one customer several branches.',
  },
  { key: 'cust_name', required: 'Required', format: 'text', notes: 'Legal / trading name.' },
  {
    key: 'branch_code',
    required: 'Optional',
    format: 'text',
    notes:
      'Branch identity. A bare code like "01" is auto-composed to <cust_code>-01. Must be unique within the customer. Leave blank for single-branch customers and the app numbers them.',
  },
  {
    key: 'branch_name',
    required: 'Optional',
    format: 'text',
    notes: 'e.g. Main Branch, Warehouse.',
  },
  {
    key: 'sales_region',
    required: 'Recommended',
    format: 'a REGION CODE from the Account master (e.g. MCT)',
    notes:
      '⚠ This is the region CODE, not the name. Must match a Regions.code you imported. Blank/unknown → branch parked in UNASSIGNED with a warning (fix later in-app).',
  },
  {
    key: 'route',
    required: 'Recommended',
    format: 'a ROUTE CODE from the Account master (e.g. MCT-01)',
    notes: '⚠ CODE, not name. Decides which salesman owns this branch. Blank/unknown → UNASSIGNED.',
  },
  { key: 'address', required: 'Optional', format: 'text', notes: 'Street / area / landmark.' },
  {
    key: 'phone',
    required: 'Optional',
    format: '7–20 chars: digits, + - ( ) spaces',
    notes:
      'Bad format → row held for review. Same phone across branches of the SAME customer is fine; the same phone on DIFFERENT customers is flagged for steward review.',
  },
  { key: 'contact_person', required: 'Optional', format: 'text', notes: '' },
  {
    key: 'cr_no',
    required: 'Optional',
    format: 'text (commercial registration no.)',
    notes: 'Same CR on DIFFERENT customers is flagged for steward review (possible duplicate).',
  },
  {
    key: 'payment_terms',
    required: 'Optional',
    format: 'CASH or CREDIT (default CASH)',
    notes: 'Anything other than CASH/CREDIT → row held for review.',
  },
  {
    key: 'credit_limit',
    required: 'For CREDIT',
    format: 'number, OMR, up to 3 decimals',
    notes: 'Only for CREDIT customers. Leave blank for CASH.',
  },
  {
    key: 'payment_term_days',
    required: 'For CREDIT',
    format: 'whole number 0–365',
    notes: 'Only for CREDIT customers. Leave blank for CASH.',
  },
  {
    key: 'temix_code',
    required: 'Optional',
    format: 'text (the Temix ERP code)',
    notes:
      'Fill for customers already in Temix (links CRM ↔ Temix). Leave blank if not yet in Temix.',
  },
  {
    key: 'channel',
    required: 'Optional',
    format:
      'HORECA, MODERN_TRADE, GENERAL_TRADE, CONVENIENCE_AND_GAS, ECOMMERCE, HOME_OFFICE_DELIVERY, INSTITUTIONS',
    notes:
      'The CRM channel CODE. Anything else → row held for review. Blank = not set (the salesman fills it in later).',
  },
  {
    key: 'day_of_visit',
    required: 'Optional',
    format: 'SAT, SUN, MON, TUE, WED, THU or FRI',
    notes:
      "The journey-plan visit day for this branch. Drives the salesman's Today list. Anything else → row held for review.",
  },
  {
    key: 'customer_status',
    required: 'Optional',
    format: 'ACTIVE or CLOSED (default ACTIVE)',
    notes:
      'CLOSED marks the branch (and, if every branch is closed, the customer) as closed on load. A customer with any ACTIVE branch stays ACTIVE.',
  },
];

function buildCustomerMaster(): Buffer {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NMWC CRM';
  // IMPORTANT: the importer reads the FIRST sheet as the customer data, so the
  // Customers sheet MUST come first; Instructions goes after it.
  addDataSheet(wb, 'Customers', customerCols, [
    {
      cust_code: 'C-10001',
      cust_name: 'Al Noor Trading LLC',
      branch_code: '01',
      branch_name: 'Main Branch',
      sales_region: 'MCT',
      route: 'MCT-01',
      address: 'Way 2233, Al Khuwair, Muscat',
      phone: '+96824000001',
      contact_person: 'Mr. Salim',
      cr_no: '1234567',
      payment_terms: 'CASH',
      credit_limit: '',
      payment_term_days: '',
      temix_code: '',
      channel: 'GENERAL_TRADE',
      day_of_visit: 'MON',
      customer_status: 'ACTIVE',
    },
    {
      cust_code: 'C-10001',
      cust_name: 'Al Noor Trading LLC',
      branch_code: '02',
      branch_name: 'Seeb Branch',
      sales_region: 'MCT',
      route: 'MCT-02',
      address: 'Seeb Souq, Muscat',
      phone: '+96824000001',
      contact_person: 'Mr. Salim',
      cr_no: '1234567',
      payment_terms: 'CASH',
      credit_limit: '',
      payment_term_days: '',
      temix_code: '',
      channel: 'GENERAL_TRADE',
      day_of_visit: 'WED',
      customer_status: 'ACTIVE',
    },
    {
      cust_code: 'C-10002',
      cust_name: 'Gulf Foodstuff Co',
      branch_code: '01',
      branch_name: 'Main',
      sales_region: 'BAT',
      route: 'BAT-01',
      address: 'Sohar Industrial',
      phone: '+96826000002',
      contact_person: 'Ms. Aisha',
      cr_no: '7654321',
      payment_terms: 'CREDIT',
      credit_limit: '5000.000',
      payment_term_days: '30',
      temix_code: 'TMX-10002',
      channel: 'HORECA',
      day_of_visit: 'SUN',
      customer_status: 'ACTIVE',
    },
  ]);
  addInstructions(
    wb,
    'NMWC — CUSTOMER MASTER import',
    [
      'PURPOSE: load your customers and their branches (identity, contact, credit terms, region/route placement, Temix crosswalk).',
      'ORDER: import this AFTER the Account master — the regions, routes and salesmen must already exist.',
      'HOW TO IMPORT: sign in as the Steward → Import → Customer master → upload → review the staged rows → Promote. Rows with problems are quarantined for review (fix and re-promote).',
      'ONE ROW PER BRANCH: a customer with 3 branches = 3 rows sharing the same cust_code (with different branch_code).',
      'DELETE the yellow EXAMPLE rows before you import. The data must be the FIRST sheet (named "Customers").',
      'NOT IN THIS FILE (captured later in the app by the salesman): GPS, channel/sub-channel, day of visit, cooler/stand/bottle counts, photos, alternate phone, contact role, customer status. Do not add columns for these — they are ignored.',
    ],
    [{ sheet: 'Customers', cols: customerCols }],
    [
      '⚠ REGION & ROUTE ARE CODES: "sales_region" holds a region CODE (e.g. MCT) and "route" holds a route CODE (e.g. MCT-01) — the exact codes from your Account master, not display names. If your source file has names, translate them to codes first, or the rows fall back to UNASSIGNED.',
      'Header names are flexible on a few columns (cust_code also accepts "code"; cr_no also "CR NO"; branch also "CUST BRANCH") but using the exact names above is safest.',
    ]
  );
  return wb.xlsx.writeBuffer() as unknown as Buffer;
}

async function main() {
  const outDir = path.join('docs', 'import-templates');
  mkdirSync(outDir, { recursive: true });
  const account = await buildAccountMaster();
  const customer = await buildCustomerMaster();
  writeFileSync(path.join(outDir, 'account-master-template.xlsx'), account);
  writeFileSync(path.join(outDir, 'customer-master-template.xlsx'), customer);
  console.log('Wrote:');
  console.log('  ' + path.join(outDir, 'account-master-template.xlsx'));
  console.log('  ' + path.join(outDir, 'customer-master-template.xlsx'));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
