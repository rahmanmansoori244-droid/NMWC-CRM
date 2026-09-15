/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
/**
 * Builds the NMWC GO-LIVE master files from the real business sources.
 *
 *   npx tsx scripts/golive/build-masters.ts
 *
 * Reads (all read-only, paths overridable via env):
 *   RoutePro customer master LIVE (Sep-2026)   the Timix-fed assignment of record: every
 *                                              customer/branch code, its route, pay mode, status
 *   RoutePro route master LIVE                 salesman name per route (20-char truncated)
 *   Journey-plan master (JP_MASTER_CURRENT)    route × customer × visit days (24 routes)
 *   Temix customer extract (CUST-MASTER)       phone, address, contact, channel
 *   CRM-shaped master (Code-Branch, Jul-2026)  account credit limit / days, activity status
 *   Sales dashboard SQLite + today's upload    ACTIVE routes, class per route, latest salesman
 *
 * Owner decisions applied (2026-09-10, walked through one by one):
 *   - region codes MCT/KHB/NZW/SLL/AWF/DQM/BRK
 *   - NO supervisors from Timix "Team Leaders" (that field is stale — names that do not
 *     exist). Managers supervise their salesmen directly: Muscat by class, others by region.
 *   - ONLY routes active in the dashboard's latest data (the JP team's rule: ≥ 500 OMR
 *     invoiced in the last 8 weeks). Customers on any other route are loaded but parked
 *     under UNASSIGNED in their region, and listed for reassignment.
 *
 * Writes to golive-data/ (GITIGNORED — customer PII and generated passwords):
 *   account-master.xlsx, customer-master.xlsx, managers.json, credentials.xlsx,
 *   RECONCILIATION.md, dq/*.csv
 */
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeInitialPasswordIssuer } from './initial-password';

const DESKTOP = 'C:/Users/abdulr/Desktop';
// The RoutePro customer master is re-exported before every real load; whichever
// RoutePro_Customer_Master_LIVE_<date>.csv is newest (by the date in its name) wins.
function newestRouteProExport(): string {
  const dirs = [`${DESKTOP}/claude/NMWC-JOURNEY-PLANS/harvests`, 'C:/Users/abdulr/Downloads'];
  let best: { date: string; file: string } | null = null;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const m = /^RoutePro_Customer_Master_LIVE_(\d{4}-\d{2}-\d{2})\.csv$/i.exec(f);
      if (m && (!best || m[1] > best.date)) best = { date: m[1], file: `${d}/${f}` };
    }
  }
  if (!best) throw new Error('no RoutePro_Customer_Master_LIVE_<date>.csv found');
  return best.file;
}
const SRC = {
  rpCustomers: process.env.RP_CUSTOMERS ?? newestRouteProExport(),
  rpRoutes:
    process.env.RP_ROUTES ??
    `${DESKTOP}/claude/NMWC-JOURNEY-PLANS/harvests/RoutePro_Route_Master_LIVE_2026-09-01.csv`,
  jp: process.env.JP_MASTER ?? `${DESKTOP}/claude/NMWC-JOURNEY-PLANS/master/JP_MASTER_CURRENT.csv`,
  temixRaw: process.env.TEMIX_RAW ?? `${DESKTOP}/SALES-REPORTS/CUST-MASTER-with-class.xlsx`,
  codeBranch:
    process.env.CODE_BRANCH ??
    `${DESKTOP}/SALES-REPORTS/NMWC-Customer-Master-CRM (Code-Branch).xlsx`,
  dashDb: process.env.DASH_DB ?? `${DESKTOP}/NMWC-SALES-DASHBOARD/server/db/nmwc.db`,
  todayUpload:
    process.env.TODAY_UPLOAD ??
    `${DESKTOP}/NMWC-SALES-DASHBOARD/NMWC-Daily-Sales-Upload-Template.xlsx`,
};
const OUT = path.resolve(process.env.GOLIVE_DIR ?? 'golive-data');
const DQ = path.join(OUT, 'dq');
// The dashboard/JP activity lens: a route is ACTIVE if it invoiced at least this much
// in the 8 weeks before the snapshot's last day (or in this month's upload file).
const ACTIVE_MIN_OMR = Number(process.env.ACTIVE_MIN_OMR ?? 500);
const ACTIVE_WINDOW_DAYS = 56;
// SEC-11, superseding the 2026-09-10 shared-password decision. Every account now gets
// its OWN 8-digit initial secret, drawn fresh on each build — see ./initial-password.ts
// for why 8 digits, and why there is deliberately no env override.
//
// This does not remove the window before a person's first sign-in; it makes that window
// per-person. Usernames are route codes and are public (they are printed on the journey
// plan), so the secret is the only thing separating one account from another. Shared, it
// means anyone in the room can sign in as a colleague who has not signed in yet, set a
// password, and have every later edit, approval and audit row carry that colleague's
// name. Per-person, a leaked secret opens exactly the one account it was issued for.
//
// Every user row below still sets must_change_password=yes, and that flag is load-
// bearing: services/imports.ts only accepts an initial value shorter than 12 when it is
// set, and auth.config.ts pins the account to /profile/change-password until the person
// chooses a 12+ character password of their own (passwordRule, services/users.ts).
//
// DISTRIBUTION IS NOT SOLVED HERE. Every row of credentials.xlsx — BOTH sheets — now has
// to reach one named person and nobody else, and a manager who also sells a route has
// two logins with two different secrets. Read item 16 of RECONCILIATION.md and step 8 of
// docs/GO-LIVE-RUNBOOK.md before printing anything.
const issueInitialPassword = makeInitialPasswordIssuer();

// ── Region model (owner-confirmed) ───────────────────────────────────────────
const REGIONS: Array<{ code: string; name: string }> = [
  { code: 'MCT', name: 'Muscat' },
  { code: 'KHB', name: 'Khaburah' },
  { code: 'NZW', name: 'Nizwa' },
  { code: 'SLL', name: 'Salalah' },
  { code: 'AWF', name: 'Al Wafi' },
  { code: 'DQM', name: 'Duqm' },
  { code: 'BRK', name: 'Barka' },
  { code: 'UNASSIGNED', name: 'Unassigned' },
];
const REGION_BY_NAME: Record<string, string> = {
  MUSCAT: 'MCT',
  'CAPITAL (MUSCAT)': 'MCT',
  KHABURAH: 'KHB',
  KHABOURAH: 'KHB',
  KHABHURAH: 'KHB',
  SAHAM: 'KHB',
  MUSANNAH: 'KHB',
  NIZWA: 'NZW',
  SALALAH: 'SLL',
  'AL WAFI': 'AWF',
  ALWAFI: 'AWF',
  'AL KAMIL (AL WAFI)': 'AWF',
  DUQM: 'DQM',
  DUQUM: 'DQM',
  BARKA: 'BRK',
};
function regionCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = String(name)
    .trim()
    .toUpperCase()
    .replace(/^\d+\s+/, '');
  return REGION_BY_NAME[n] ?? null;
}
function regionByPrefix(code: string): string | null {
  if (/^(NZ|NPNT|NIZ|NM\d|PDO)/.test(code)) return 'NZW';
  if (/^(SL|AISS|SLM|SLTT|WH-S|SPNT)/.test(code)) return 'SLL';
  if (/^(AW|AISW|APNT|AWM)/.test(code)) return 'AWF';
  if (/^(BMU|BPNT|BHG)/.test(code)) return 'BRK';
  if (/^(DQ|DPNT)/.test(code)) return 'DQM';
  if (
    /^(SH|MU|SMU|SMM|PNT\d|S1\d|S2\d|OTHS|WHS-SO|WHS-MU|MDM|SDM)/.test(code) ||
    /MUSANNA/.test(code)
  )
    return 'KHB';
  if (
    /^(S0\d|DM|C\d|MH|WHS|W$|DC|HO|G\d|K\d|M\d|GR|SSR|DIRECT|WAC|OTH-HD|SMART|MIS|DMIS)/.test(code)
  )
    return 'MCT';
  return null;
}

// ── Route code canonicalisation ─────────────────────────────────────────────
// RoutePro names ("MH02 DIRECT", "SAHAM - S20", "SDM1 -NMWC"), Timix codes and the
// dashboard's clustered codes all describe the same route family. The CRM gets ONE
// code per route: the dashboard's clustered form, which the journey plan and the
// sales data also use.
const ROUTE_ALIASES: Record<string, string> = {
  DQ1: 'DQ01',
  DQ1SV: 'DQ01',
  NIZDIR: 'NIZD',
  // JP BRAIN law 8: RoutePro "NZ05 -DIRECT" is the dashboard's NIZD (Nizwa direct).
  NZ05: 'NIZD',
  'WHS-': 'WHS-SO',
  'OTH-': 'OTH-HD',
  MH01SA: 'MH01',
  'PDO-NIZWA-DELIVERY': 'PDO-N',
  'NMWC-SMART-APP': 'SMART-APP',
};
function canonRoute(raw: unknown): string {
  let s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!s) return '';
  s = s.replace(/\s*-\s*NOT USED$/, '');
  // "MH02 DIRECT" → MH02, but a route literally named "DIRECT" keeps its name.
  s = s.replace(/^(.+?)\s*-?\s*DIRECT$/, '$1');
  s = s.replace(/^(.+?)\s*-?\s*NMWC$/, '$1');
  const m = /^(?:SAHAM|CAPITAL)\s*-\s*(\S+)$/.exec(s);
  if (m) s = m[1];
  s = s
    .replace(/[\/\s]+/g, '-')
    .replace(/[^A-Z0-9_-]/g, '')
    .replace(/-+/g, '-');
  if (ROUTE_ALIASES[s]) s = ROUTE_ALIASES[s];
  s = s.replace(/^-|-$/g, '');
  if (ROUTE_ALIASES[s]) s = ROUTE_ALIASES[s];
  return s;
}
// Sales files carry the pre-seller's PERSONAL code ("SL03EA" = SL03 + Ehsan Ali); the
// route is the base. Applied only to that column — never to route masters.
function presellerRoute(code: unknown): string {
  const c = canonRoute(code);
  const m = /^([A-Z]+\d+)[A-Z]{1,2}$/.exec(c);
  return canonRoute(m ? m[1] : c);
}

// ── Channel mapping (Temix "Channel" → CRM channel key) ─────────────────────
const CHANNEL_MAP: Record<string, string | null> = {
  'HOME DELIVERY': 'HOME_OFFICE_DELIVERY',
  HOUSEHOLD: 'HOME_OFFICE_DELIVERY',
  'SMALL GROCERY': 'GENERAL_TRADE',
  'LARGE GROCERY': 'GENERAL_TRADE',
  IMPULSE: 'GENERAL_TRADE',
  'SELF SERVICE': 'GENERAL_TRADE',
  WHOLESALE: 'GENERAL_TRADE',
  CAFETERIA: 'HORECA',
  RESTAURANT: 'HORECA',
  'RESTAURANT(CLOSED)': 'HORECA',
  HORECA: 'HORECA',
  CAFE: 'HORECA',
  CATERING: 'HORECA',
  HOTEL: 'HORECA',
  COFFESHOP: 'HORECA',
  SUPERMARKET: 'MODERN_TRADE',
  HYPERMARKET: 'MODERN_TRADE',
  SCHOOL: 'INSTITUTIONS',
  'INSTITUTION / OFFICE': 'INSTITUTIONS',
  OFFICE: 'INSTITUTIONS',
  'PETROL & CON.STORES': 'CONVENIENCE_AND_GAS',
  'C & G': 'CONVENIENCE_AND_GAS',
  'CONVENIENT STORE': 'CONVENIENCE_AND_GAS',
  // Long-tail Temix labels (≈80 customers in total).
  HOSPITAL: 'INSTITUTIONS',
  MINISTRIES: 'INSTITUTIONS',
  CLUB: 'INSTITUTIONS',
  'STAFF  ACCOMODATION': 'INSTITUTIONS',
  'STAFF ACCOMODATION': 'INSTITUTIONS',
  PHARMACY: 'GENERAL_TRADE',
  'SEMI WHOLESALE': 'GENERAL_TRADE',
  'SMALL GROCERY(CLOSED)': 'GENERAL_TRADE',
  'KEY ACCOUNT': 'MODERN_TRADE',
  'CASH/CPN': null,
  NIL: null,
  OTHERS: null,
  '': null,
};

// ── Org chart (owner-confirmed 2026-09-10) ──────────────────────────────────
// Managers = the people who run the sales dashboard today. They supervise their
// salesmen DIRECTLY (a Manager may be a salesman's supervisor in the CRM, and the
// supervisor approval step accepts them). No separate supervisor accounts.
const MANAGERS: Array<{ username: string; fullName: string; regions: string[]; note: string }> = [
  {
    username: 'ahmed.alnadabi',
    fullName: 'AHMED ALNADABI',
    regions: ['MCT'],
    note: 'Muscat GT — supervises the GT salesmen',
  },
  {
    username: 'haitham',
    fullName: 'HAITHAM',
    regions: ['MCT'],
    note: 'Muscat home delivery — supervises the HD salesmen',
  },
  {
    username: 'sarath',
    fullName: 'SARATH',
    regions: ['MCT'],
    note: 'Muscat modern trade — supervises the MT salesmen',
  },
  {
    username: 'sara.khayat',
    fullName: 'SARA KHAYAT',
    regions: ['MCT'],
    note: 'HORECA — supervises the HORECA salesmen; also the C3 pre-seller, so C3 gets no salesman account',
  },
  {
    username: 'ashok',
    fullName: 'ASHOK',
    regions: ['KHB'],
    note: 'Khaburah — supervises the Khaburah salesmen',
  },
  {
    username: 'rashid',
    fullName: 'RASHID',
    regions: ['BRK', 'DQM', 'AWF', 'KHB'],
    note: 'covers Barka/Duqm/Al Wafi/Khaburah — fallback approver',
  },
  {
    username: 'rasool',
    fullName: 'RASOOL',
    regions: ['AWF', 'DQM'],
    note: 'Al Wafi + Duqm — supervises their salesmen',
  },
  {
    username: 'saqib',
    fullName: 'SAQIB',
    regions: ['BRK'],
    note: 'Barka — supervises the Barka salesmen',
  },
  {
    username: 'saud',
    fullName: 'SAUD',
    regions: ['DQM', 'AWF', 'NZW'],
    note: 'covers Duqm/Al Wafi/Nizwa — fallback approver',
  },
  {
    username: 'sunil.kp',
    fullName: 'SUNIL KP',
    regions: ['NZW'],
    note: 'Nizwa — supervises the Nizwa salesmen',
  },
  {
    username: 'tharwat',
    fullName: 'THARWAT MOHAMED',
    regions: ['SLL'],
    note: 'Salalah — supervises the Salalah salesmen',
  },
];
const MUSCAT_SUPERVISOR_BY_CLASS: Record<string, string> = {
  'MCT GT': 'ahmed.alnadabi',
  'MCT MT': 'sarath',
  'MCT HD': 'haitham',
  HORECA: 'sara.khayat',
};
// Owner decision: Sara Khayat also sells C3 herself — a second, SALESMAN login.
const MANAGER_ALSO_SELLS: Record<string, { username: string; fullName: string }> = {
  C3: { username: 'c3', fullName: 'SARA KHAYAT' },
};
const SUPERVISOR_BY_REGION: Record<string, string> = {
  NZW: 'sunil.kp',
  KHB: 'ashok',
  SLL: 'tharwat',
  BRK: 'saqib',
  AWF: 'rasool',
  DQM: 'rasool',
};

// ── helpers ─────────────────────────────────────────────────────────────────
function parseCsv(file: string): { headers: string[]; rows: string[][] } {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const parseLine = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) {
        if (ch === '"') {
          if (l[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  return { headers, rows: lines.slice(1).map(parseLine) };
}
function csvObjects(file: string): Record<string, string>[] {
  const { headers, rows } = parseCsv(file);
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const cellVal = (c: ExcelJS.Cell): unknown => {
  const v = c.value as any;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return v.result ?? v.text ?? (v.richText ? v.richText.map((r: any) => r.text).join('') : null);
  }
  return v;
};
async function xlsxObjects(file: string, sheetName?: string): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = sheetName ? wb.getWorksheet(sheetName)! : wb.worksheets[0];
  const headers = Array.from(ws.getRow(1).values as unknown[])
    .slice(1)
    .map((h, i) => String(h ?? `col${i}`).trim());
  const out: Record<string, unknown>[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const o: Record<string, unknown> = {};
    headers.forEach((h, k) => {
      o[h] = cellVal(row.getCell(k + 1));
    });
    out.push(o);
  });
  return out;
}
const S = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
// The importer refuses any cell starting with a spreadsheet-formula trigger (= + - @);
// Timix addresses like "-BLD 900" are data, not formulas, so drop the prefix.
const T = (v: unknown) => S(v).replace(/^[=+\-@\t\r\s]+/, '');
function cleanPhone(raw: unknown): { phone: string | null; reason?: string } {
  const s = S(raw);
  if (!s) return { phone: null };
  if (/E\+/i.test(s)) return { phone: null, reason: 'scientific notation (Excel-mangled)' };
  const tokens = s.split(/[\/,;]|\s{2,}|\s(?=\d{8}\b)/).map((t) => t.replace(/\D/g, ''));
  for (let t of tokens) {
    if (t.startsWith('00968')) t = t.slice(5);
    else if (t.startsWith('968') && t.length === 11) t = t.slice(3);
    if (t.length === 8 && /^[2479]/.test(t)) return { phone: `+968${t}` };
  }
  const all = s.replace(/\D/g, '');
  if (all.length === 8) return { phone: `+968${all}` };
  return { phone: null, reason: `no valid 8-digit Oman number in "${s.slice(0, 30)}"` };
}
function isPlaceholderName(name: string, routeCode: string): boolean {
  const u = name.trim().toUpperCase();
  if (!u) return true;
  if (u === routeCode) return true;
  return /NMWC|DIRECT|WAREHOUSE|OTHERS|SMART APP|^PNT\d|DELIVERY|^AIS |^S\d\d$|^SDM|^MDM|^DPNT|-PNT|^SL\d\d/.test(
    u
  );
}
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
const DAY_ORDER = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
function csvLine(vals: unknown[]): string {
  return vals
    .map((v) => {
      const s = S(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}
function writeDq(name: string, headers: string[], rows: unknown[][]) {
  writeFileSync(
    path.join(DQ, name),
    [csvLine(headers), ...rows.map(csvLine)].join('\n') + '\n',
    'utf8'
  );
}
function top<K>(m: Map<K, number> | undefined): K | null {
  if (!m || m.size === 0) return null;
  return [...m].sort((a, b) => b[1] - a[1])[0][0];
}
function bump<K>(m: Map<K, number>, k: K, w = 1) {
  m.set(k, (m.get(k) ?? 0) + w);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, f] of Object.entries(SRC)) {
    if (!existsSync(f)) throw new Error(`missing source ${k}: ${f}`);
  }
  mkdirSync(DQ, { recursive: true });
  const notes: string[] = [];
  const log = (s: string) => {
    console.log(s);
    notes.push(s);
  };

  // 1. Dashboard: ACTIVE routes (activity lens), class per route, region votes,
  //    latest salesman per route.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(SRC.dashDb, { readOnly: true });
  const snapshotEnd: string = db
    .prepare('select max(invoice_date_clean) d from fact_sales_lines')
    .get().d;
  const activeOmr = new Map<string, number>();
  for (const r of db
    .prepare(
      `select clustered_route r, sum(act_net) v from fact_sales_lines
       where invoice_date_clean >= date(?, '-${ACTIVE_WINDOW_DAYS} days') and transaction_type = 'Invoice'
       group by 1`
    )
    .all(snapshotEnd) as any[]) {
    const code = canonRoute(r.r);
    if (code) bump(activeOmr, code, Number(r.v));
  }
  const regionVotes = new Map<string, Map<string, number>>();
  const classVotes = new Map<string, Map<string, number>>();
  const voteRegion = (route: string, rc: string | null, w = 1) => {
    if (!route || !rc) return;
    const m = regionVotes.get(route) ?? new Map<string, number>();
    bump(m, rc, w);
    regionVotes.set(route, m);
  };
  const voteClass = (route: string, cls: string, w = 1) => {
    if (!route || !cls) return;
    const m = classVotes.get(route) ?? new Map<string, number>();
    bump(m, cls, w);
    classVotes.set(route, m);
  };
  for (const r of db
    .prepare(
      `select clustered_route r, region_clean g, analytical_class c, count(distinct customer_no) n
       from fact_sales_lines where invoice_date_clean >= '2026-01-01' group by 1,2,3`
    )
    .all() as any[]) {
    const code = canonRoute(r.r);
    voteRegion(code, regionCodeFromName(r.g), Number(r.n));
    voteClass(code, S(r.c), Number(r.n));
  }
  const routeName = new Map<string, string>();
  for (const r of db
    .prepare('select route_code, route_name, region, analytical_class from dim_route')
    .all() as any[]) {
    const code = canonRoute(r.route_code);
    if (!code) continue;
    voteRegion(code, regionCodeFromName(r.region), 1);
    voteClass(code, S(r.analytical_class), 1);
    if (!routeName.has(code)) routeName.set(code, S(r.route_name) || code);
  }
  // salesman per route: this month's upload first (most invoices), then the last two
  // aggregated months. Pre-sales rows: `code` is the seller's own route, `route_code`
  // the delivery van.
  const routeSalesmanVotes = new Map<string, Map<string, number>>();
  const vote = (route: string, name: string, w = 1) => {
    if (!route || isPlaceholderName(name, route)) return;
    const m = routeSalesmanVotes.get(route) ?? new Map<string, number>();
    bump(m, name.trim().toUpperCase(), w);
    routeSalesmanVotes.set(route, m);
  };
  const todayRows = await xlsxObjects(SRC.todayUpload, 'UPLOAD_READY');
  const latestSalesRoute = new Map<string, { route: string; date: Date }>();
  const uploadOmr = new Map<string, number>();
  const septSeen = new Map<
    string,
    { cust: string; branch: string; name: string; route: string; region: string | null }
  >();
  for (const r of todayRows) {
    const route = S(r.code) ? presellerRoute(r.code) : canonRoute(r.route_code);
    if (S(r.transaction_type).toLowerCase() === 'invoice')
      bump(uploadOmr, route, Number(r.act_net) || 0);
    vote(route, S(r.preseller_name) || S(r.salesman_name), 3);
    voteRegion(route, regionCodeFromName(S(r.region)), 1);
    const cust = S(r.customer_no);
    if (cust) {
      const d = r.invoice_date instanceof Date ? r.invoice_date : new Date(S(r.invoice_date));
      const key = `${cust}|${S(r.branch_code) === '0' ? '' : S(r.branch_code)}`;
      const prev = latestSalesRoute.get(key);
      if (!prev || d > prev.date) latestSalesRoute.set(key, { route, date: d });
      if (!septSeen.has(key))
        septSeen.set(key, {
          cust: cust.toUpperCase(),
          branch: S(r.branch_code) === '0' ? '' : S(r.branch_code).toUpperCase(),
          name: S(r.customer_name),
          route,
          region: regionCodeFromName(S(r.region)),
        });
    }
  }
  for (const r of db
    .prepare(
      `select route, salesman, preseller, sum(value) v from agg_route
       where (year*100+month) >= (select max(year*100+month) from agg_route) - 1 group by 1,2,3`
    )
    .all() as any[]) {
    vote(
      canonRoute(r.route),
      S(r.preseller) || S(r.salesman),
      Math.max(1, Math.round(Number(r.v) / 5000))
    );
  }
  const ACTIVE = new Set<string>();
  for (const [code, v] of activeOmr) if (v >= ACTIVE_MIN_OMR) ACTIVE.add(code);
  for (const [code, v] of uploadOmr) if (v >= ACTIVE_MIN_OMR) ACTIVE.add(code);
  ACTIVE.delete('');
  ACTIVE.delete('UNASSIGNED');

  // 2. RoutePro route master: salesman name fallback (truncated to 20 chars).
  const rpRouteSalesman = new Map<string, string>();
  for (const r of csvObjects(SRC.rpRoutes)) {
    const code = canonRoute(r.ROUTE_NAME);
    if (!code) continue;
    if (!routeName.has(code)) routeName.set(code, code);
    if (r.SALESMAN && !isPlaceholderName(r.SALESMAN, code))
      rpRouteSalesman.set(code, r.SALESMAN.trim().toUpperCase());
  }

  // 3. Temix extract: contact data + channel only (its "Team Leaders" field is stale).
  const temixByCode = new Map<string, Record<string, unknown>>();
  const unknownChannels = new Map<string, number>();
  for (const r of await xlsxObjects(SRC.temixRaw)) {
    const code = S(r['Customer No']).toUpperCase();
    if (code && !temixByCode.has(code)) temixByCode.set(code, r);
  }

  // 4. Code-Branch master: credit limit/days per account, activity status, region votes.
  const cbByBase = new Map<
    string,
    { limit: number | null; days: number | null; status: string; route: string; name: string }
  >();
  for (const r of await xlsxObjects(SRC.codeBranch)) {
    voteRegion(canonRoute(r['Current Route']), regionCodeFromName(S(r.Region)), 2);
    const base = S(r['Base Code']).toUpperCase();
    if (!base) continue;
    const limit = S(r['Credit Limit (acct)']) !== '' ? Number(r['Credit Limit (acct)']) : null;
    const days = S(r['Credit Days (acct)']) !== '' ? Number(r['Credit Days (acct)']) : null;
    const prev = cbByBase.get(base);
    if (!prev)
      cbByBase.set(base, {
        limit,
        days,
        status: S(r.Status),
        route: canonRoute(r['Current Route']),
        name: S(r['Customer Name']),
      });
    else {
      if (prev.limit == null && limit != null) prev.limit = limit;
      if (prev.days == null && days != null) prev.days = days;
      if (prev.status !== 'Active' && S(r.Status) === 'Active') prev.status = 'Active';
    }
  }
  const arByCode = new Map<string, { limit: number; days: number | null }>();
  for (const r of db
    .prepare('select customer_no, credit_limit, credit_days from ar_aging where credit_limit > 0')
    .all() as any[]) {
    arByCode.set(S(r.customer_no).toUpperCase(), {
      limit: Number(r.credit_limit),
      days: r.credit_days != null ? Number(r.credit_days) : null,
    });
  }

  // 5. Journey plan: first planned day per alt code (+ full pattern for the report).
  const jpDay = new Map<string, string>();
  const jpMulti: unknown[][] = [];
  for (const r of csvObjects(SRC.jp)) {
    voteRegion(canonRoute(r.route_code), regionCodeFromName(r.region), 3);
    const days = DAY_ORDER.filter((d) => r[d] === '1');
    const alt = S(r.customer_code).toUpperCase();
    if (!alt || days.length === 0) continue;
    jpDay.set(alt, days[0].toUpperCase());
    if (days.length > 1)
      jpMulti.push([
        alt,
        r.customer_name,
        r.route_code,
        days.map((d) => d.toUpperCase()).join('+'),
        days[0].toUpperCase(),
      ]);
  }

  // 6. RoutePro customer master — the universe.
  type Cust = {
    alt: string;
    base: string;
    branch: string | null;
    name: string;
    route: string;
    pay: string;
    status: string;
  };
  const universe: Cust[] = [];
  const unparseable: unknown[][] = [];
  const routeMerges = new Map<string, { to: string; n: number }>();
  for (const r of csvObjects(SRC.rpCustomers)) {
    const rawRoute = S(r.ROUTE_NAME).toUpperCase();
    const canon = canonRoute(rawRoute);
    if (rawRoute && canon !== rawRoute) {
      const e = routeMerges.get(rawRoute) ?? { to: canon, n: 0 };
      e.n++;
      routeMerges.set(rawRoute, e);
    }
    const alt = S(r.ALT_CODE).toUpperCase();
    const m = /^([A-Z0-9]+)(?:-(.+))?$/.exec(alt);
    if (!m) {
      unparseable.push([r.ALT_CODE, r.NAME, r.ROUTE_NAME, r.STATUS]);
      continue;
    }
    universe.push({
      alt,
      base: m[1],
      branch: m[2] ? m[2].replace(/[^A-Z0-9_-]/gi, '').toUpperCase() || null : null,
      name: S(r.NAME),
      route: canon,
      pay: /CHARGE/i.test(S(r.PAY_MODE)) ? 'CREDIT' : 'CASH',
      status: /^active$/i.test(S(r.STATUS)) ? 'ACTIVE' : 'CLOSED',
    });
  }
  const inRoutePro = new Set(universe.map((c) => c.base));
  const cbOnly: unknown[][] = [];
  const cbDormantSkipped: unknown[][] = [];
  for (const [base, cb] of cbByBase) {
    if (inRoutePro.has(base)) continue;
    if (cb.status === 'Active' || cb.status === 'At risk') {
      universe.push({
        alt: base,
        base,
        branch: null,
        name: cb.name,
        route: cb.route,
        pay: cb.limit && cb.limit > 0 ? 'CREDIT' : 'CASH',
        status: 'ACTIVE',
      });
      cbOnly.push([base, cb.name, cb.route, cb.status]);
    } else cbDormantSkipped.push([base, cb.name, cb.route, cb.status]);
  }
  // Customers (and branches) invoiced THIS month that the RoutePro snapshot does not
  // know yet — created in Timix after the export. Cash/coupon pseudo-accounts are not
  // customers and are skipped.
  const septNew: unknown[][] = [];
  const knownAlt = new Set(universe.map((c) => c.alt));
  for (const s of septSeen.values()) {
    if (/^(CASH|COUP|STAFF)/i.test(s.cust)) continue;
    const alt = s.branch ? `${s.cust}-${s.branch}` : s.cust;
    if (knownAlt.has(alt)) continue;
    const baseKnown = inRoutePro.has(s.cust) || cbByBase.has(s.cust);
    knownAlt.add(alt);
    universe.push({
      alt,
      base: s.cust,
      branch: s.branch || null,
      name: s.name,
      route: s.route,
      pay: 'CASH',
      status: 'ACTIVE',
    });
    septNew.push([
      alt,
      s.name,
      s.route,
      s.region ?? '',
      baseKnown ? 'new branch of a known customer' : 'new customer (not in the RoutePro snapshot)',
    ]);
  }

  // 7. Routes sheet = ACTIVE routes only. Region by vote; class by vote.
  const regionOf = (code: string): string | null =>
    top(regionVotes.get(code)) ?? regionByPrefix(code);
  const classOf = (code: string): string | null => top(classVotes.get(code));
  const routes: Array<{
    code: string;
    name: string;
    region: string;
    cls: string | null;
    omr: number;
  }> = [];
  const routesUnmappedRegion: unknown[][] = [];
  for (const code of [...ACTIVE].sort()) {
    let rc = regionOf(code);
    if (!rc) {
      rc = 'UNASSIGNED';
      routesUnmappedRegion.push([code]);
    }
    routes.push({
      code,
      name: routeName.get(code) ?? code,
      region: rc,
      cls: classOf(code),
      omr: Math.round((activeOmr.get(code) ?? 0) + (uploadOmr.get(code) ?? 0)),
    });
  }
  const regionOfRoute = new Map(routes.map((r) => [r.code, r.region]));
  regionOfRoute.set('UNASSIGNED', 'UNASSIGNED');

  // 8. Customers sheet. A customer on a route that is NOT active is loaded, kept in
  //    its region, but parked on UNASSIGNED and listed for reassignment.
  const legalNameByBase = new Map<string, string>();
  for (const c of universe) if (!c.branch && c.name) legalNameByBase.set(c.base, c.name);
  for (const c of universe)
    if (!legalNameByBase.has(c.base))
      legalNameByBase.set(c.base, S(temixByCode.get(c.base)?.Name) || c.name);

  const phoneByBase = new Map<string, string>();
  const phoneReasons: unknown[][] = [];
  const phoneOwners = new Map<string, string[]>();
  const rank = (base: string) => {
    const c =
      universe.find((u) => u.base === base && !u.branch) ?? universe.find((u) => u.base === base);
    const cb = cbByBase.get(base);
    return (
      (c?.status === 'ACTIVE' ? 10 : 0) +
      (cb?.status === 'Active' ? 2 : cb?.status === 'At risk' ? 1 : 0)
    );
  };
  for (const base of new Set(universe.map((c) => c.base))) {
    const t = temixByCode.get(base);
    const { phone, reason } = cleanPhone(t?.Phone);
    if (reason) phoneReasons.push([base, legalNameByBase.get(base), S(t?.Phone), reason]);
    if (phone) {
      phoneByBase.set(base, phone);
      phoneOwners.set(phone, [...(phoneOwners.get(phone) ?? []), base]);
    }
  }
  const phoneWithheld: unknown[][] = [];
  for (const [phone, owners] of phoneOwners) {
    if (owners.length < 2) continue;
    const keep = [...owners].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))[0];
    for (const o of owners) {
      if (o === keep) continue;
      phoneByBase.delete(o);
      phoneWithheld.push([
        o,
        legalNameByBase.get(o),
        phone,
        `same phone as ${keep} (${legalNameByBase.get(keep)}) — kept on that customer`,
      ]);
    }
  }

  const custRows: Record<string, unknown>[] = [];
  const creditNoLimit: unknown[][] = [];
  const routeDiff: unknown[][] = [];
  const onInactiveRoute: unknown[][] = [];
  const inactiveRouteCounts = new Map<string, number>();
  let jpCovered = 0;
  const seenBranch = new Set<string>();
  const channelUsed = new Map<string, number>();
  universe.sort(
    (a, b) => a.base.localeCompare(b.base) || (a.branch ?? '').localeCompare(b.branch ?? '')
  );
  for (const c of universe) {
    const branchKey = `${c.base}|${c.branch ?? ''}`;
    if (seenBranch.has(branchKey)) continue;
    seenBranch.add(branchKey);
    const t = temixByCode.get(c.base);
    let route = c.route;
    let region = regionOfRoute.get(route) ?? null;
    if (!route || !ACTIVE.has(route)) {
      const original = route || '(none)';
      region = (route ? regionOf(route) : null) ?? 'UNASSIGNED';
      route = 'UNASSIGNED';
      bump(inactiveRouteCounts, original);
      onInactiveRoute.push([c.alt, c.name, original, region, c.status]);
    }
    const chRaw = S(t?.Channel).toUpperCase();
    let channel: string | null = null;
    if (chRaw in CHANNEL_MAP) channel = CHANNEL_MAP[chRaw];
    else if (chRaw) bump(unknownChannels, chRaw);
    if (channel) bump(channelUsed, channel);
    const cb = cbByBase.get(c.base);
    const ar = arByCode.get(c.base);
    const limit = c.pay === 'CREDIT' ? (cb?.limit ?? ar?.limit ?? null) : null;
    const days = c.pay === 'CREDIT' ? (cb?.days ?? ar?.days ?? null) : null;
    if (c.pay === 'CREDIT' && !c.branch && (limit == null || limit <= 0))
      creditNoLimit.push([c.base, legalNameByBase.get(c.base), route]);
    const day = jpDay.get(c.alt) ?? (c.branch ? undefined : jpDay.get(c.base)) ?? null;
    if (day) jpCovered++;
    const sales = latestSalesRoute.get(`${c.base}|${c.branch ?? ''}`);
    if (sales && sales.route && route !== 'UNASSIGNED' && sales.route !== route)
      routeDiff.push([c.alt, c.name, route, sales.route, sales.date.toISOString().slice(0, 10)]);
    custRows.push({
      cust_code: c.base,
      cust_name: T(legalNameByBase.get(c.base) ?? c.name) || c.base,
      branch_code: c.branch ?? '',
      branch_name: c.branch ? T(c.name) || c.branch : 'Main',
      sales_region: region ?? 'UNASSIGNED',
      route,
      address: [T(t?.Address), T(t?.City)].filter(Boolean).join(', '),
      phone: c.branch ? '' : (phoneByBase.get(c.base) ?? ''),
      contact_person: c.branch ? '' : T(t?.['Contact Person']),
      cr_no: '',
      payment_terms: c.pay,
      credit_limit: limit != null && limit > 0 ? limit : '',
      payment_term_days: days != null && days >= 0 && days <= 365 ? days : '',
      temix_code: c.base,
      channel: channel ?? '',
      day_of_visit: day ?? '',
      customer_status: c.status,
    });
  }

  // 9. Users sheet: manager rows (regions only — created in the app first), salesmen
  //    on ACTIVE routes supervised by their manager, approver placeholders.
  const users: Record<string, unknown>[] = [];
  const credentials: unknown[][] = [];
  const usedUsernames = new Set<string>(MANAGERS.map((m) => m.username));
  const uniqueUsername = (base: string) => {
    let u = base;
    let n = 2;
    while (usedUsernames.has(u)) u = `${base}${n++}`;
    usedUsernames.add(u);
    return u;
  };
  const supervisorFor = (route: { code: string; region: string; cls: string | null }): string => {
    if (route.region === 'MCT') return MUSCAT_SUPERVISOR_BY_CLASS[route.cls ?? ''] ?? '';
    return SUPERVISOR_BY_REGION[route.region] ?? '';
  };
  for (const m of MANAGERS) {
    users.push({
      username: m.username,
      full_name: titleCase(m.fullName),
      role: 'MANAGER',
      password: '',
      supervisor_username: '',
      route_code: '',
      region_codes: m.regions.join(','),
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
      must_change_password: 'yes',
    });
  }
  const managerNames = MANAGERS.map((m) => m.fullName.toUpperCase());
  const looksLikeManager = (name: string) =>
    managerNames.some(
      (mn) =>
        name === mn ||
        (mn.includes(' ') && name.startsWith(mn.split(' ')[0]) && name.includes(mn.split(' ')[1]))
    );
  const salesmanRoutes = new Map<string, string[]>();
  const routesNoSalesman: unknown[][] = [];
  const namesFromRoutePro: unknown[][] = [];
  const noSupervisor: unknown[][] = [];
  const managerSalesRoutes: Array<{
    route: (typeof routes)[number];
    username: string;
    fullName: string;
  }> = [];
  for (const r of routes) {
    let name = top(routeSalesmanVotes.get(r.code)) ?? undefined;
    if (!name) {
      const rp = rpRouteSalesman.get(r.code);
      if (rp) {
        const all = new Set<string>();
        for (const m of routeSalesmanVotes.values()) for (const k of m.keys()) all.add(k);
        const full = [...all].find((n) => n.startsWith(rp));
        name = full ?? rp;
        if (!full)
          namesFromRoutePro.push([
            r.code,
            titleCase(rp),
            rp.length >= 20
              ? 'likely cut at 20 characters — correct the name in Users'
              : 'from RoutePro route master',
          ]);
      }
    }
    if (!name) {
      routesNoSalesman.push([
        r.code,
        r.region,
        r.cls ?? '',
        'no named person sells on this route (van/direct route) — assign in the app if someone should',
      ]);
      continue;
    }
    const also = MANAGER_ALSO_SELLS[r.code];
    if (also && looksLikeManager(name)) {
      managerSalesRoutes.push({ route: r, username: also.username, fullName: also.fullName });
      continue;
    }
    if (looksLikeManager(name)) {
      routesNoSalesman.push([
        r.code,
        r.region,
        r.cls ?? '',
        `top seller is ${titleCase(name)}, who is a MANAGER — assign a salesman in the app`,
      ]);
      continue;
    }
    salesmanRoutes.set(name, [...(salesmanRoutes.get(name) ?? []), r.code]);
  }
  const salesmanMultiRoute: unknown[][] = [];
  for (const [name, rts] of salesmanRoutes) {
    const best = rts
      .map((rc) => [rc, routeSalesmanVotes.get(rc)?.get(name) ?? 0] as const)
      .sort((a, b) => b[1] - a[1])[0][0];
    if (rts.length > 1) salesmanMultiRoute.push([titleCase(name), rts.join(' '), best]);
    const route = routes.find((r) => r.code === best)!;
    const sup = supervisorFor(route);
    if (!sup) noSupervisor.push([best, route.region, route.cls ?? '', titleCase(name)]);
    const username = uniqueUsername(best.toLowerCase());
    const pw = issueInitialPassword();
    users.push({
      username,
      full_name: titleCase(name),
      role: 'SALESMAN',
      password: pw,
      supervisor_username: sup,
      route_code: best,
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
      must_change_password: 'yes',
    });
    credentials.push([
      username,
      titleCase(name),
      'SALESMAN',
      `${best} → ${sup || '(no supervisor)'}`,
      pw,
    ]);
    for (const rc of rts)
      if (rc !== best)
        routesNoSalesman.push([
          rc,
          regionOfRoute.get(rc),
          routes.find((r) => r.code === rc)?.cls ?? '',
          `${titleCase(name)} also sells here but owns ${best} — assign in the app`,
        ]);
  }
  for (const m of managerSalesRoutes) {
    const sup = supervisorFor(m.route);
    usedUsernames.add(m.username);
    const pw = issueInitialPassword();
    users.push({
      username: m.username,
      full_name: titleCase(m.fullName),
      role: 'SALESMAN',
      password: pw,
      supervisor_username: sup,
      route_code: m.route.code,
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
      must_change_password: 'yes',
    });
    credentials.push([
      m.username,
      titleCase(m.fullName),
      'SALESMAN',
      `${m.route.code} → ${sup || '(no supervisor)'} (second login of a manager)`,
      pw,
    ]);
  }
  const allRegions = REGIONS.filter((r) => r.code !== 'UNASSIGNED')
    .map((r) => r.code)
    .join(',');
  for (const [username, fullName, role, regions] of [
    // Owner decision: generic approver accounts, no personal names.
    ['accountant', 'Accountant', 'ACCOUNTANT', allRegions],
    ['finance.manager', 'Finance Manager', 'FINANCE_MANAGER', ''],
    ['gm.nmwc', 'General Manager', 'GM', ''],
  ] as const) {
    const pw = issueInitialPassword();
    users.push({
      username,
      full_name: fullName,
      role,
      password: pw,
      supervisor_username: '',
      route_code: '',
      region_codes: regions,
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
      must_change_password: 'yes',
    });
    credentials.push([username, fullName, role, regions, pw]);
  }

  // 10. Workbooks.
  const addSheet = (
    wb: ExcelJS.Workbook,
    name: string,
    headers: string[],
    rows: Record<string, unknown>[]
  ) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));
    ws.columns.forEach((c) => (c.width = 18));
  };
  const acct = new ExcelJS.Workbook();
  addSheet(
    acct,
    'Regions',
    ['code', 'name'],
    REGIONS.filter((r) => r.code !== 'UNASSIGNED').map((r) => ({ code: r.code, name: r.name }))
  );
  addSheet(
    acct,
    'Routes',
    ['code', 'name', 'region_code'],
    routes.map((r) => ({ code: r.code, name: r.name, region_code: r.region }))
  );
  addSheet(
    acct,
    'Users',
    [
      'username',
      'full_name',
      'role',
      'password',
      'supervisor_username',
      'route_code',
      'region_codes',
      'email',
      'phone',
      'reset_password',
      'change_role',
      'must_change_password',
    ],
    users
  );
  await acct.xlsx.writeFile(path.join(OUT, 'account-master.xlsx'));

  const cust = new ExcelJS.Workbook();
  addSheet(
    cust,
    'Customers',
    [
      'cust_code',
      'cust_name',
      'branch_code',
      'branch_name',
      'sales_region',
      'route',
      'address',
      'phone',
      'contact_person',
      'cr_no',
      'payment_terms',
      'credit_limit',
      'payment_term_days',
      'temix_code',
      'channel',
      'day_of_visit',
      'customer_status',
    ],
    custRows
  );
  await cust.xlsx.writeFile(path.join(OUT, 'customer-master.xlsx'));

  const stewardPw = issueInitialPassword();
  const managerCreds = MANAGERS.map((m) => ({ ...m, password: issueInitialPassword() }));
  const cred = new ExcelJS.Workbook();
  addSheet(
    cred,
    'Create in app FIRST',
    ['username', 'full_name', 'role', 'regions', 'password', 'note'],
    [
      {
        // NOT 'steward': lib/auth.ts blocks that exact username whenever
        // DEMO_ACCOUNTS_DISABLED is set, which production has set, because
        // prisma/synthetic.ts seeds a demo STEWARD under that name. The go-live
        // Steward signing in is step 2 of the load and the account-master import
        // is Steward-only, so the collision would stop the entire load with
        // "Invalid username or password" and no in-app way back.
        username: 'data.steward',
        full_name: 'DATA STEWARD',
        role: 'STEWARD',
        regions: '',
        password: stewardPw,
        note: 'create first (bootstrap script); runs the imports',
      },
      ...managerCreds.map((m) => ({
        username: m.username,
        full_name: titleCase(m.fullName),
        role: 'MANAGER',
        regions: m.regions.join(','),
        password: m.password,
        note: m.note,
      })),
    ]
  );
  addSheet(
    cred,
    'Created by import',
    ['username', 'full_name', 'role', 'route_or_regions', 'password'],
    credentials.map((c) => ({
      username: c[0],
      full_name: c[1],
      role: c[2],
      route_or_regions: c[3],
      password: c[4],
    }))
  );
  await cred.xlsx.writeFile(path.join(OUT, 'credentials.xlsx'));
  writeFileSync(
    path.join(OUT, 'managers.json'),
    JSON.stringify(
      {
        // Same name as credentials.xlsx above, and deliberately not 'steward'.
        steward: { username: 'data.steward', fullName: 'DATA STEWARD', password: stewardPw },
        managers: managerCreds.map((m) => ({
          username: m.username,
          fullName: titleCase(m.fullName),
          regions: m.regions,
          password: m.password,
        })),
      },
      null,
      2
    )
  );

  // 11. Data-quality evidence + reconciliation.
  writeDq(
    'routes-active.csv',
    ['route', 'region', 'class', 'omr_recent', 'salesman_login', 'supervisor'],
    routes.map((r) => {
      const u = users.find((x) => x.route_code === r.code);
      return [
        r.code,
        r.region,
        r.cls ?? '',
        r.omr,
        u?.username ?? '',
        u?.supervisor_username ?? '',
      ];
    })
  );
  writeDq(
    'customers-on-inactive-routes.csv',
    ['alt_code', 'name', 'original_route', 'region', 'status'],
    onInactiveRoute
  );
  writeDq(
    'inactive-routes-summary.csv',
    ['original_route', 'customers'],
    [...inactiveRouteCounts].sort((a, b) => b[1] - a[1])
  );
  writeDq('unparseable-codes.csv', ['alt_code', 'name', 'route', 'status'], unparseable);
  writeDq('phones-withheld-duplicates.csv', ['cust_code', 'name', 'phone', 'why'], phoneWithheld);
  writeDq('phones-unusable.csv', ['cust_code', 'name', 'raw_phone', 'why'], phoneReasons);
  writeDq('routes-no-salesman.csv', ['route', 'region', 'class', 'why'], routesNoSalesman);
  writeDq('salesmen-no-supervisor.csv', ['route', 'region', 'class', 'salesman'], noSupervisor);
  writeDq('salesmen-multiple-routes.csv', ['salesman', 'routes', 'assigned'], salesmanMultiRoute);
  writeDq('routes-region-unmapped.csv', ['route'], routesUnmappedRegion);
  writeDq('credit-customers-without-limit.csv', ['cust_code', 'name', 'route'], creditNoLimit);
  writeDq(
    'jp-multi-day-customers.csv',
    ['alt_code', 'name', 'route', 'planned_days', 'loaded_as'],
    jpMulti
  );
  writeDq(
    'route-differs-from-sept-sales.csv',
    ['alt_code', 'name', 'routepro_route', 'sept_sales_route', 'last_invoice'],
    routeDiff
  );
  writeDq('new-from-september-sales.csv', ['alt_code', 'name', 'route', 'region', 'why'], septNew);
  writeDq('codebranch-only-included.csv', ['cust_code', 'name', 'route', 'status'], cbOnly);
  writeDq(
    'codebranch-dormant-not-loaded.csv',
    ['cust_code', 'name', 'route', 'status'],
    cbDormantSkipped
  );
  writeDq('users-name-from-routepro.csv', ['route', 'name_as_loaded', 'note'], namesFromRoutePro);
  writeDq(
    'routepro-route-variants-merged.csv',
    ['routepro_route_name', 'loaded_as', 'customers'],
    [...routeMerges].map(([k, v]) => [k, v.to, v.n]).sort((a, b) => Number(b[2]) - Number(a[2]))
  );

  const byRegion = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const byTerms = new Map<string, number>();
  for (const r of custRows) {
    bump(byRegion, S(r.sales_region));
    bump(byStatus, S(r.customer_status));
    bump(byTerms, S(r.payment_terms));
  }
  const distinctCustomers = new Set(custRows.map((r) => r.cust_code)).size;
  const parked = onInactiveRoute.length;
  const salesmenCount = users.filter((u) => u.role === 'SALESMAN').length;
  const md: string[] = [];
  md.push('# NMWC go-live master data — build reconciliation');
  md.push(
    `Built ${new Date().toISOString()} · RoutePro export: ${path.basename(SRC.rpCustomers)} · dashboard snapshot to ${snapshotEnd} · active route = ≥ ${ACTIVE_MIN_OMR} OMR invoiced in the last ${ACTIVE_WINDOW_DAYS} days (or in this month's upload)`
  );
  md.push('');
  md.push('## Decisions confirmed by the owner (2026-09-10)');
  md.push(
    '1. **Region codes**: MCT Muscat · KHB Khaburah (Saham/Sohar/Musannah) · NZW Nizwa · SLL Salalah · AWF Al Wafi · DQM Duqm · BRK Barka. ✅'
  );
  md.push(
    '2. **No supervisors from Timix "Team Leaders"** — that field holds names that do not exist. Dropped entirely. ✅'
  );
  md.push(
    '3. **Managers supervise their salesmen directly.** Muscat by class: GT → Ahmed Alnadabi · Modern trade → Sarath · Home delivery → Haitham · HORECA → Sara Khayat. Other regions: Nizwa → Sunil KP · Khaburah → Ashok · Salalah → Tharwat · Barka → Saqib · Al Wafi + Duqm → Rasool. Rashid and Saud remain managers over their regions (fallback approvers). ✅'
  );
  md.push(
    '4. **Only ACTIVE routes** (dashboard activity lens) exist in the CRM. Customers on any other route are loaded in their region but parked on **UNASSIGNED** — see below. ✅'
  );
  md.push('');
  md.push(
    '5. **Approver accounts are generic, without personal names**: `accountant` (all regions), `finance.manager`, `gm.nmwc`. ✅'
  );
  md.push('');
  md.push('6. **Bulk-loaded customers do not pass through the approval chain** (SOP §8.5). ✅');
  md.push(
    '7. **Journey plan**: a branch planned on several days carries only its first day (the CRM holds one visit day per branch). ✅'
  );
  md.push(
    '8. **Payment terms** from RoutePro PAY_MODE (CHARGE → CREDIT, CASH → CASH); limits/days from the July account master, else the June AR snapshot; CREDIT with no limit on file loads as CREDIT with a blank limit. ✅'
  );
  md.push(
    '9. **Customers on routes with no recent sales stay loaded but parked on UNASSIGNED** in their region, for the Steward and managers to reassign or close after go-live. ✅'
  );
  md.push(
    '10. **Duplicate phones**: a number shared by several customers is kept on the most active one and left blank on the others (listed). ✅'
  );
  md.push(
    '11. **Customers missing from RoutePro**: 2026 buyers are included on their last route; long-dormant codes are not loaded. **The RoutePro snapshot must be the latest before the final build** — owner to export a fresh customer master (many new customers since 3-Sep). ⚠ pending'
  );
  md.push(
    '12. **Route conflicts**: Timix/RoutePro is the assignment of record; September sales on another route are listed, not applied. ✅'
  );
  md.push('13. **Codes with stray characters** are skipped and listed for correction in Timix. ✅');
  md.push(
    '14. **C3**: Sara Khayat also sells it herself — she gets a second, salesman login (`sara.khayat.c3`). **W** (wholesale) has no named seller and stays without a salesman. ✅'
  );
  md.push(
    `15. **Newcomers from this month's sales**: ${septNew.length} customers/branches invoiced in September that the RoutePro snapshot (${path.basename(SRC.rpCustomers)}) does not contain were added on their September route as CASH/ACTIVE (dq/new-from-september-sales.csv). Re-export RoutePro before the final build to capture customers created in Timix that have not bought yet.`
  );
  md.push('');
  md.push(
    '16. **Credentials**: salesmen sign in with their ROUTE CODE (e.g. `c4`, `sh01`), managers with their name (e.g. `ashok`, `sara.khayat`), the steward as `steward`. **Every account has its OWN 8-digit initial password** (SEC-11) — there is no longer one password for everyone, so a leaked login opens exactly one account and every approval stays attributable to the person whose name is on it. The value is digits only, so it can be read off paper and typed on any phone keyboard without switching language, and it stops working the moment its owner completes the forced change at first sign-in. Hand each person **only their own row** of `credentials.xlsx`; a manager who also sells a route has a second login with a DIFFERENT password. ✅ ⚠ HOW those rows reach people is an owner decision and is not settled — see step 8 of docs/GO-LIVE-RUNBOOK.md.'
  );
  md.push('## What is in the files');
  md.push(`- **Regions:** 7`);
  md.push(
    `- **Routes (active):** ${routes.length}${routesUnmappedRegion.length ? ` — ${routesUnmappedRegion.length} could not be placed in a region (dq/routes-region-unmapped.csv)` : ''} — full list with class, recent OMR, salesman and supervisor in dq/routes-active.csv`
  );
  md.push(
    `- **Customer rows (branches):** ${custRows.length} across **${distinctCustomers} customers**`
  );
  md.push(`  - by region: ${[...byRegion].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  md.push(
    `  - by status: ${[...byStatus].map(([k, v]) => `${k} ${v}`).join(' · ')} (CLOSED = Inactive in RoutePro/Timix)`
  );
  md.push(`  - by terms: ${[...byTerms].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  md.push(
    `  - **${parked} branches sit on routes that are not active and are parked on UNASSIGNED** (kept in their region; dq/customers-on-inactive-routes.csv). By original route: ${[
      ...inactiveRouteCounts,
    ]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}${inactiveRouteCounts.size > 12 ? ' …' : ''} (dq/inactive-routes-summary.csv)`
  );
  md.push(
    `  - journey-plan day set on **${jpCovered}** branches (24 routes in the plan; ${jpMulti.length} customers planned on more than one day carry their FIRST day — dq/jp-multi-day-customers.csv)`
  );
  md.push(
    `  - channel set on ${[...channelUsed.values()].reduce((a, b) => a + b, 0)} rows: ${[...channelUsed].map(([k, v]) => `${k} ${v}`).join(' · ')}${unknownChannels.size ? ` — unmapped Temix channels: ${[...unknownChannels].map(([k, v]) => `${k} (${v})`).join(', ')}` : ''}`
  );
  md.push(
    `  - phone set on ${phoneByBase.size} customers; **${phoneWithheld.length} withheld** because the same number sits on another customer (dq/phones-withheld-duplicates.csv); ${phoneReasons.length} unusable in the source (dq/phones-unusable.csv)`
  );
  md.push(
    `  - **${creditNoLimit.length} CREDIT customers have no credit limit on file** (dq/credit-customers-without-limit.csv)`
  );
  md.push(
    `  - ${cbOnly.length} customers bought in 2026 but are missing from RoutePro — included on their last route (dq/codebranch-only-included.csv); ${cbDormantSkipped.length} dormant-and-missing customers NOT loaded (dq/codebranch-dormant-not-loaded.csv)`
  );
  md.push(
    `  - ${routeDiff.length} branches invoiced in September on a route different from their RoutePro assignment (dq/route-differs-from-sept-sales.csv) — RoutePro (Timix) was taken as the assignment of record`
  );
  md.push(
    `  - ${unparseable.length} RoutePro codes could not be parsed and were skipped (dq/unparseable-codes.csv)`
  );
  md.push(
    `- **Users in the account master:** ${users.length} — ${MANAGERS.length} manager rows (regions only; the accounts are created in the app first), ${salesmenCount} salesmen, 3 approver placeholders`
  );
  md.push(
    `  - **${routesNoSalesman.length} active routes have no salesman account** (dq/routes-no-salesman.csv)`
  );
  md.push(
    `  - ${noSupervisor.length} salesmen have no supervisor because their route's class has no manager mapped (dq/salesmen-no-supervisor.csv)`
  );
  md.push(
    `  - ${salesmanMultiRoute.length} salesmen sell on more than one active route; each owns the route where they sell most (dq/salesmen-multiple-routes.csv)`
  );
  md.push(
    `  - ${namesFromRoutePro.length} salesman names come only from the RoutePro route master (cut at 20 characters) — check in Users (dq/users-name-from-routepro.csv)`
  );
  md.push(
    `  - RoutePro route-name variants folded into their base route: ${[...routeMerges]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 6)
      .map(([k, v]) => `${k} → ${v.to} (${v.n})`)
      .join(', ')} … (dq/routepro-route-variants-merged.csv)`
  );
  md.push('');
  md.push('## Load order');
  md.push(
    '1. Create the STEWARD (bootstrap script) and the 11 MANAGER accounts in the app (`credentials.xlsx`, sheet "Create in app FIRST").'
  );
  md.push(
    '2. As the steward: Import → Account master → `account-master.xlsx` (regions, active routes, salesmen, approver placeholders; assigns manager regions).'
  );
  md.push(
    '3. Import → Customer master → `customer-master.xlsx` → review quarantined rows → Promote (passes; resume if interrupted) → reconcile per SOP §8.4.'
  );
  md.push(
    '4. Hand each person **their own row** from `credentials.xlsx` — passwords are now per-person, so one sheet held up in front of a room hands every account to everyone in it. Have each person sign in and complete the forced password change while you are still with them; their 8-digit value is dead from that moment. Then DELETE `credentials.xlsx` and `managers.json`.'
  );
  md.push('');
  md.push('## Build log');
  md.push(...notes.map((n) => `- ${n}`));
  writeFileSync(path.join(OUT, 'RECONCILIATION.md'), md.join('\n') + '\n', 'utf8');

  log(
    `account-master.xlsx: 7 regions, ${routes.length} active routes, ${users.length} users (${salesmenCount} salesmen)`
  );
  log(
    `customer-master.xlsx: ${custRows.length} rows / ${distinctCustomers} customers (JP day on ${jpCovered}; ${parked} parked on UNASSIGNED)`
  );
  log(`credentials.xlsx + managers.json written — SENSITIVE, gitignored`);
  db.close();
}

main().catch((e) => {
  console.error('BUILD FAILED:', e);
  process.exit(1);
});
