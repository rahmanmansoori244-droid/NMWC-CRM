/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
/**
 * Builds the NMWC GO-LIVE master files from the real business sources.
 *
 *   npx tsx scripts/golive/build-masters.ts
 *
 * Reads (all read-only, paths overridable via env):
 *   RoutePro customer master LIVE (Sep-2026)   the Timix-fed assignment of record: every
 *                                              customer/branch code, its route, pay mode, status
 *   RoutePro route master LIVE                 109 routes + salesman on each
 *   Journey-plan master (JP_MASTER_CURRENT)    route × customer × visit days (24 routes)
 *   Temix customer extract (CUST-MASTER)       phone, address, contact, channel, team leader
 *   CRM-shaped master (Code-Branch, Jul-2026)  account credit limit / days, activity status
 *   Sales dashboard SQLite + today's upload    route master by region, latest salesman per route
 *
 * Writes to golive-data/ (GITIGNORED — customer PII and generated passwords):
 *   account-master.xlsx    Regions / Routes / Users  → Steward → Import → Account master
 *   customer-master.xlsx   Customers                 → Steward → Import → Customer master
 *   managers.json          MANAGER/STEWARD accounts to create IN THE APP before importing
 *   credentials.xlsx       every generated login + password (hand to people, then delete)
 *   RECONCILIATION.md      what was loaded, what was withheld, and every decision assumed
 *   dq/*.csv               the row-level evidence behind each reconciliation figure
 */
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DESKTOP = 'C:/Users/abdulr/Desktop';
const SRC = {
  rpCustomers:
    process.env.RP_CUSTOMERS ??
    `${DESKTOP}/claude/NMWC-JOURNEY-PLANS/harvests/RoutePro_Customer_Master_LIVE_2026-09-03.csv`,
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

// ── Region model ────────────────────────────────────────────────────────────
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
// RoutePro names ("MH02 DIRECT", "SAHAM - S20", "SDM1 -NMWC"), Temix codes and
// the dashboard's clustered codes all describe the same route family. The CRM
// gets ONE code per route: the dashboard's analytical/clustered form, which is
// also what the journey plan and the sales data use.
const ROUTE_ALIASES: Record<string, string> = {
  DQ1: 'DQ01',
  DQ1SV: 'DQ01',
  NIZDIR: 'NIZD',
  'WHS-': 'WHS-SO',
  'OTH-': 'OTH-HD',
  MH01SA: 'MH01',
  'PDO-NIZWA-DELIVERY': 'PDO-N',
  'NMWC-SMART-APP': 'SMART-APP',
  'HORECA-MUSANNA': 'HORECA-MUSANNA',
};
// Sales files carry the pre-seller's PERSONAL code ("SL03EA" = SL03 + Ehsan Ali);
// the route is the base. Applied only to that column — never to route masters.
function presellerRoute(code: unknown): string {
  const c = canonRoute(code);
  const m = /^([A-Z]+\d+)[A-Z]{1,2}$/.exec(c);
  return canonRoute(m ? m[1] : c);
}
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
  NIL: null,
  OTHERS: null,
  '': null,
};

// ── Org chart ───────────────────────────────────────────────────────────────
// Supervisors = the real Temix "Team Leaders". Managers = the regional/class heads
// who run the sales dashboard today. Both lists are ASSUMPTIONS to be confirmed by
// the owner — they are written out in RECONCILIATION.md for exactly that reason.
const SUPERVISORS: Array<{
  username: string;
  fullName: string;
  teamLeader: string;
  regions: string[];
}> = [
  {
    username: 'sajjad.yousuf',
    fullName: 'SAJJAD YOUSUF',
    teamLeader: 'SAJJAD YOUSUF',
    regions: ['MCT'],
  },
  {
    username: 'balbir.singh',
    fullName: 'BALBIR SINGH',
    teamLeader: 'BALBIR SINGH',
    regions: ['KHB'],
  },
  {
    username: 'mohd.arif',
    fullName: 'MOHD ARIF SAIFULLAH',
    teamLeader: 'MOHD ARIF SAIFULLAH',
    regions: ['SLL'],
  },
  { username: 'usman', fullName: 'USMAN', teamLeader: 'USMAN', regions: ['BRK'] },
  {
    username: 'shafeeq.ahamad',
    fullName: 'SHAFEEQ AHAMAD',
    teamLeader: 'SHAFEEQ AHAMAD',
    regions: ['AWF', 'DQM'],
  },
];
const MANAGERS: Array<{
  username: string;
  fullName: string;
  regions: string[];
  teamLeader?: string;
  note: string;
}> = [
  {
    username: 'ahmed.alnadabi',
    fullName: 'AHMED ALNADABI',
    regions: ['MCT'],
    note: 'dashboard manager for MCT GT',
  },
  {
    username: 'haitham',
    fullName: 'HAITHAM',
    regions: ['MCT'],
    note: 'dashboard manager for MCT HD (home delivery)',
  },
  {
    username: 'sarath',
    fullName: 'SARATH',
    regions: ['MCT'],
    note: 'dashboard manager for MCT MT (modern trade)',
  },
  {
    username: 'sara.khayat',
    fullName: 'SARA KHAYAT',
    regions: ['MCT'],
    teamLeader: 'SARA HORECA',
    note: 'dashboard manager for HORECA; Temix team leader "Sara Horeca"; also the C3 preseller — no salesman account is created for C3',
  },
  {
    username: 'ashok',
    fullName: 'ASHOK',
    regions: ['KHB'],
    note: 'dashboard manager for KHABOURAH',
  },
  {
    username: 'rashid',
    fullName: 'RASHID',
    regions: ['BRK', 'DQM', 'AWF', 'KHB'],
    note: 'dashboard manager BARKA,DUQUM,ALWAFI,KHABOURAH',
  },
  {
    username: 'rasool',
    fullName: 'RASOOL',
    regions: ['AWF', 'DQM'],
    note: 'dashboard manager ALWAFI,DUQUM',
  },
  { username: 'saqib', fullName: 'SAQIB', regions: ['BRK'], note: 'dashboard manager BARKA' },
  {
    username: 'saud',
    fullName: 'SAUD',
    regions: ['DQM', 'AWF', 'NZW'],
    note: 'dashboard manager DUQUM,ALWAFI,NIZWA',
  },
  {
    username: 'sunil.kp',
    fullName: 'SUNIL KP',
    regions: ['NZW'],
    teamLeader: 'SUNIL KP',
    note: 'dashboard manager NIZWA and Temix team leader for Nizwa — supervises the Nizwa salesmen directly',
  },
  {
    username: 'tharwat',
    fullName: 'THARWAT MOHAMED',
    regions: ['SLL'],
    note: 'dashboard manager SALALAH (also appears as SL01 preseller)',
  },
];
const DEFAULT_SUPERVISOR_BY_REGION: Record<string, string> = {
  MCT: 'sajjad.yousuf',
  KHB: 'balbir.singh',
  SLL: 'mohd.arif',
  BRK: 'usman',
  AWF: 'shafeeq.ahamad',
  DQM: 'shafeeq.ahamad',
  NZW: 'sunil.kp',
  UNASSIGNED: 'sajjad.yousuf',
};
const TEAM_LEADER_TO_USERNAME: Record<string, string> = {};
for (const s of SUPERVISORS) TEAM_LEADER_TO_USERNAME[s.teamLeader.toUpperCase()] = s.username;
for (const m of MANAGERS)
  if (m.teamLeader) TEAM_LEADER_TO_USERNAME[m.teamLeader.toUpperCase()] = m.username;

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
function slugUsername(fullName: string): string {
  const parts = fullName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'user';
  const base = parts.length === 1 ? parts[0] : `${parts[0]}.${parts[parts.length - 1]}`;
  return base.slice(0, 40).padEnd(3, 'x');
}
function genPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `Nmwc-${s}`;
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

  // 1. Dashboard route master (region + name per clustered code) and latest salesman.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(SRC.dashDb, { readOnly: true });
  const dimRoutes: any[] = db.prepare('select route_code, route_name, region from dim_route').all();
  // Region per route is a VOTE: a route like C1 has rows under several classes and
  // regions in the dashboard; the customers on it decide where it lives.
  const regionVotes = new Map<string, Map<string, number>>();
  const voteRegion = (route: string, rc: string | null, w = 1) => {
    if (!route || !rc) return;
    const m = regionVotes.get(route) ?? new Map<string, number>();
    m.set(rc, (m.get(rc) ?? 0) + w);
    regionVotes.set(route, m);
  };
  const routeName = new Map<string, string>();
  const dimRouteCodes = new Set<string>();
  for (const r of dimRoutes) {
    const code = canonRoute(r.route_code);
    if (!code) continue;
    dimRouteCodes.add(code);
    voteRegion(code, regionCodeFromName(r.region), 1);
    if (!routeName.has(code)) routeName.set(code, S(r.route_name) || code);
  }
  // salesman per route: this month's upload first (most invoices), then August aggregates.
  const routeSalesmanVotes = new Map<string, Map<string, number>>();
  const vote = (route: string, name: string, w = 1) => {
    if (!route || isPlaceholderName(name, route)) return;
    const m = routeSalesmanVotes.get(route) ?? new Map<string, number>();
    m.set(name.trim().toUpperCase(), (m.get(name.trim().toUpperCase()) ?? 0) + w);
    routeSalesmanVotes.set(route, m);
  };
  const todayRows = await xlsxObjects(SRC.todayUpload, 'UPLOAD_READY');
  const latestSalesRoute = new Map<string, { route: string; date: Date }>();
  for (const r of todayRows) {
    // Pre-sales rows: `code` is the seller's own route, `route_code` is the delivery van.
    const route = S(r.code) ? presellerRoute(r.code) : canonRoute(r.route_code);
    const name = S(r.preseller_name) || S(r.salesman_name);
    vote(route, name, 3);
    voteRegion(route, regionCodeFromName(S(r.region)), 1);
    const cust = S(r.customer_no);
    if (cust) {
      const d = r.invoice_date instanceof Date ? r.invoice_date : new Date(S(r.invoice_date));
      const key = `${cust}|${S(r.branch_code) === '0' ? '' : S(r.branch_code)}`;
      const prev = latestSalesRoute.get(key);
      if (!prev || d > prev.date) latestSalesRoute.set(key, { route, date: d });
    }
  }
  const aggRows: any[] = db
    .prepare(
      `select route, salesman, preseller, sum(value) v from agg_route
       where (year*100+month) >= (select max(year*100+month) from agg_route) - 1
       group by 1,2,3`
    )
    .all();
  for (const r of aggRows)
    vote(
      canonRoute(r.route),
      S(r.preseller) || S(r.salesman),
      Math.max(1, Math.round(Number(r.v) / 5000))
    );

  // 2. RoutePro route master: canonical codes, region hints, salesman fallback.
  const rpRoutes = csvObjects(SRC.rpRoutes);
  const rpRouteSalesman = new Map<string, string>();
  const rpActiveRoutes = new Set<string>();
  const rpSubareaHint = new Map<string, string>();
  for (const r of rpRoutes) {
    const code = canonRoute(r.ROUTE_NAME);
    if (!code) continue;
    if (/^active$/i.test(S(r.STATUS))) rpActiveRoutes.add(code);
    // "MUSCAT" is RoutePro's default sub-area and is wrong for half the estate — only
    // a non-default sub-area says anything, and even then only as a tie-breaker.
    const sub = S(r.SUBAREA).toUpperCase();
    if (sub && sub !== 'MUSCAT') {
      const rc = regionCodeFromName(sub);
      if (rc) rpSubareaHint.set(code, rc);
    }
    if (!routeName.has(code)) routeName.set(code, code);
    if (r.SALESMAN && !isPlaceholderName(r.SALESMAN, code))
      rpRouteSalesman.set(code, r.SALESMAN.trim().toUpperCase());
  }

  // 3. Temix extract: contact data, channel, team leader per route.
  const temixRaw = await xlsxObjects(SRC.temixRaw);
  const temixByCode = new Map<string, Record<string, unknown>>();
  const routeTeamLeaderVotes = new Map<string, Map<string, number>>();
  const unknownChannels = new Map<string, number>();
  for (const r of temixRaw) {
    const code = S(r['Customer No']).toUpperCase();
    if (!code) continue;
    if (!temixByCode.has(code)) temixByCode.set(code, r);
    const route = canonRoute(r.RouteCode);
    const tl = S(r['Team Leaders']).toUpperCase();
    if (route && tl && TEAM_LEADER_TO_USERNAME[tl]) {
      const m = routeTeamLeaderVotes.get(route) ?? new Map<string, number>();
      m.set(tl, (m.get(tl) ?? 0) + 1);
      routeTeamLeaderVotes.set(route, m);
    }
  }
  const supervisorForRoute = (route: string, region: string): string => {
    const votes = routeTeamLeaderVotes.get(route);
    if (votes) {
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      if (best) return TEAM_LEADER_TO_USERNAME[best[0]];
    }
    return DEFAULT_SUPERVISOR_BY_REGION[region] ?? 'sajjad.yousuf';
  };

  // 4. Code-Branch master: credit limit/days per account and activity status.
  const cbRows = await xlsxObjects(SRC.codeBranch);
  const cbByBase = new Map<
    string,
    { limit: number | null; days: number | null; status: string; route: string; name: string }
  >();
  const cbByAlt = new Map<string, Record<string, unknown>>();
  for (const r of cbRows) {
    voteRegion(canonRoute(r['Current Route']), regionCodeFromName(S(r.Region)), 2);
    const base = S(r['Base Code']).toUpperCase();
    const alt = S(r['Customer Code']).toUpperCase();
    if (alt) cbByAlt.set(alt, r);
    if (!base) continue;
    const limit =
      r['Credit Limit (acct)'] != null && S(r['Credit Limit (acct)']) !== ''
        ? Number(r['Credit Limit (acct)'])
        : null;
    const days =
      r['Credit Days (acct)'] != null && S(r['Credit Days (acct)']) !== ''
        ? Number(r['Credit Days (acct)'])
        : null;
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
  const arRows: any[] = db
    .prepare('select customer_no, credit_limit, credit_days from ar_aging where credit_limit > 0')
    .all();
  const arByCode = new Map<string, { limit: number; days: number | null }>();
  for (const r of arRows)
    arByCode.set(S(r.customer_no).toUpperCase(), {
      limit: Number(r.credit_limit),
      days: r.credit_days != null ? Number(r.credit_days) : null,
    });

  // 5. Journey plan: first planned day per alt code (+ full pattern for the report).
  const jpRows = csvObjects(SRC.jp);
  const jpDay = new Map<string, string>();
  const jpMulti: unknown[][] = [];
  for (const r of jpRows) {
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
  const rpCustomers = csvObjects(SRC.rpCustomers);
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
  for (const r of rpCustomers) {
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
      route: canonRoute(r.ROUTE_NAME),
      pay: /CHARGE/i.test(S(r.PAY_MODE)) ? 'CREDIT' : 'CASH',
      status: /^active$/i.test(S(r.STATUS)) ? 'ACTIVE' : 'CLOSED',
    });
  }
  const inRoutePro = new Set(universe.map((c) => c.base));
  // Customers that bought in 2026 (Code-Branch Active / At risk) but are not in RoutePro:
  // still real, still served — include them on their last known route.
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

  // 7. Routes referenced anywhere → the Routes sheet; resolve regions.
  // A route exists in the CRM if customers sit on it, the dashboard analyses it, or
  // RoutePro still has it active. Inactive RoutePro routes with nobody on them
  // (retired vans, routes named after a person) are not carried over.
  const customerRouteCount = new Map<string, number>();
  for (const c of universe)
    if (c.route) customerRouteCount.set(c.route, (customerRouteCount.get(c.route) ?? 0) + 1);
  const routeCodes = new Set<string>([
    ...customerRouteCount.keys(),
    ...dimRouteCodes,
    ...rpActiveRoutes,
  ]);
  const routesUnmappedRegion: unknown[][] = [];
  const routes: Array<{ code: string; name: string; region: string }> = [];
  for (const code of [...routeCodes].sort()) {
    if (!code || code === 'UNASSIGNED') continue;
    const votes = regionVotes.get(code);
    let rc: string | null = votes ? ([...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null;
    rc = rc ?? rpSubareaHint.get(code) ?? regionByPrefix(code) ?? null;
    if (!rc) {
      rc = 'UNASSIGNED';
      routesUnmappedRegion.push([code]);
    }
    routes.push({ code, name: routeName.get(code) ?? code, region: rc });
  }
  routes.push({ code: 'UNASSIGNED', name: 'Unassigned', region: 'UNASSIGNED' });
  const regionOfRoute = new Map(routes.map((r) => [r.code, r.region]));

  // 8. Customers sheet.
  const legalNameByBase = new Map<string, string>();
  for (const c of universe) if (!c.branch && c.name) legalNameByBase.set(c.base, c.name);
  for (const c of universe)
    if (!legalNameByBase.has(c.base))
      legalNameByBase.set(c.base, S(temixByCode.get(c.base)?.Name) || c.name);

  // phone: clean, then withhold duplicates across DIFFERENT customers (the importer
  // quarantines cross-customer duplicates; thousands of them would stall go-live).
  const phoneByBase = new Map<string, string>();
  const phoneReasons: unknown[][] = [];
  const phoneOwners = new Map<string, string[]>();
  const rank = (base: string) => {
    const c =
      universe.find((u) => u.base === base && !u.branch) ?? universe.find((u) => u.base === base);
    const active = c?.status === 'ACTIVE' ? 1 : 0;
    const cb = cbByBase.get(base);
    return active * 10 + (cb?.status === 'Active' ? 2 : cb?.status === 'At risk' ? 1 : 0);
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
  let jpCovered = 0;
  const seenBranch = new Set<string>();
  const channelUsed = new Map<string, number>();
  universe.sort(
    (a, b) => a.base.localeCompare(b.base) || (a.branch ?? '').localeCompare(b.branch ?? '')
  );
  for (const c of universe) {
    const t = temixByCode.get(c.base);
    const route = c.route && regionOfRoute.has(c.route) ? c.route : 'UNASSIGNED';
    const region = regionOfRoute.get(route) ?? 'UNASSIGNED';
    const branchKey = `${c.base}|${c.branch ?? ''}`;
    if (seenBranch.has(branchKey)) continue;
    seenBranch.add(branchKey);
    const chRaw = S(t?.Channel).toUpperCase();
    let channel: string | null = null;
    if (chRaw in CHANNEL_MAP) channel = CHANNEL_MAP[chRaw];
    else if (chRaw) unknownChannels.set(chRaw, (unknownChannels.get(chRaw) ?? 0) + 1);
    if (channel) channelUsed.set(channel, (channelUsed.get(channel) ?? 0) + 1);
    const cb = cbByBase.get(c.base);
    const ar = arByCode.get(c.base);
    const limit = c.pay === 'CREDIT' ? (cb?.limit ?? ar?.limit ?? null) : null;
    const days = c.pay === 'CREDIT' ? (cb?.days ?? ar?.days ?? null) : null;
    if (c.pay === 'CREDIT' && !c.branch && (limit == null || limit <= 0))
      creditNoLimit.push([c.base, legalNameByBase.get(c.base), route]);
    const day = jpDay.get(c.alt) ?? (c.branch ? undefined : jpDay.get(c.base)) ?? null;
    if (day) jpCovered++;
    const sales = latestSalesRoute.get(`${c.base}|${c.branch ?? ''}`);
    if (sales && sales.route && sales.route !== route)
      routeDiff.push([c.alt, c.name, route, sales.route, sales.date.toISOString().slice(0, 10)]);
    custRows.push({
      cust_code: c.base,
      cust_name: legalNameByBase.get(c.base) ?? c.name,
      branch_code: c.branch ?? '',
      branch_name: c.branch ? c.name || c.branch : 'Main',
      sales_region: region,
      route,
      address: [S(t?.Address), S(t?.City)].filter(Boolean).join(', '),
      phone: c.branch ? '' : (phoneByBase.get(c.base) ?? ''),
      contact_person: c.branch ? '' : S(t?.['Contact Person']),
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

  // 9. Users sheet.
  const users: Record<string, unknown>[] = [];
  const credentials: unknown[][] = [];
  const usedUsernames = new Set<string>();
  const uniqueUsername = (base: string) => {
    let u = base;
    let n = 2;
    while (usedUsernames.has(u)) u = `${base}${n++}`;
    usedUsernames.add(u);
    return u;
  };
  for (const m of MANAGERS) usedUsernames.add(m.username);
  for (const s of SUPERVISORS) {
    usedUsernames.add(s.username);
    const pw = genPassword();
    users.push({
      username: s.username,
      full_name: titleCase(s.fullName),
      role: 'SUPERVISOR',
      password: pw,
      supervisor_username: '',
      route_code: '',
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    });
    credentials.push([s.username, titleCase(s.fullName), 'SUPERVISOR', s.regions.join(','), pw]);
  }
  // Manager rows: they must already exist (created in the app); the import then
  // assigns their regions. A blank password means "keep".
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
    });
  }
  const managerNames = new Set(MANAGERS.map((m) => m.fullName.toUpperCase()));
  const salesmanByRoute = new Map<string, string>();
  const salesmanRoutes = new Map<string, string[]>();
  const routesNoSalesman: unknown[][] = [];
  const namesFromRoutePro: unknown[][] = [];
  for (const r of routes) {
    if (r.code === 'UNASSIGNED') continue;
    const votes = routeSalesmanVotes.get(r.code);
    let name = votes ? [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    if (!name) {
      const rp = rpRouteSalesman.get(r.code);
      if (rp) {
        // RoutePro truncates names to 20 chars — recover the full name when we have it.
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
        "no named person sells on this route (van/direct route, inactive, or not in this year's sales)",
      ]);
      continue;
    }
    if (
      managerNames.has(name) ||
      [...managerNames].some(
        (mn) =>
          name!.startsWith(mn.split(' ')[0]) &&
          mn.split(' ').length > 1 &&
          name!.includes(mn.split(' ')[1])
      )
    ) {
      routesNoSalesman.push([
        r.code,
        r.region,
        `top seller is ${titleCase(name)}, who is set up as a MANAGER — assign a salesman in the app`,
      ]);
      continue;
    }
    salesmanByRoute.set(r.code, name);
    salesmanRoutes.set(name, [...(salesmanRoutes.get(name) ?? []), r.code]);
  }
  const salesmanMultiRoute: unknown[][] = [];
  const salesmanUsername = new Map<string, string>();
  for (const [name, rts] of salesmanRoutes) {
    // A salesman owns exactly one route in the CRM. Give them the route where they sell
    // most; the others are reported for the owner to assign.
    const best = rts
      .map((rc) => [rc, routeSalesmanVotes.get(rc)?.get(name) ?? 0] as const)
      .sort((a, b) => b[1] - a[1])[0][0];
    if (rts.length > 1) salesmanMultiRoute.push([titleCase(name), rts.join(' '), best]);
    const username = uniqueUsername(slugUsername(name));
    salesmanUsername.set(name, username);
    const region = regionOfRoute.get(best) ?? 'UNASSIGNED';
    const pw = genPassword();
    users.push({
      username,
      full_name: titleCase(name),
      role: 'SALESMAN',
      password: pw,
      supervisor_username: supervisorForRoute(best, region),
      route_code: best,
      region_codes: '',
      email: '',
      phone: '',
      reset_password: '',
      change_role: '',
    });
    credentials.push([username, titleCase(name), 'SALESMAN', best, pw]);
    for (const rc of rts)
      if (rc !== best)
        routesNoSalesman.push([
          rc,
          regionOfRoute.get(rc),
          `${titleCase(name)} also sells here but owns ${best} — assign in the app`,
        ]);
  }
  // Approver tier placeholders so every chain can complete on day one.
  const allRegions = REGIONS.filter((r) => r.code !== 'UNASSIGNED')
    .map((r) => r.code)
    .join(',');
  for (const [username, fullName, role, regions] of [
    ['accountant', 'ACCOUNTANT — assign a real person', 'ACCOUNTANT', allRegions],
    ['finance.manager', 'FINANCE MANAGER — assign a real person', 'FINANCE_MANAGER', ''],
    ['gm.nmwc', 'GENERAL MANAGER — assign a real person', 'GM', ''],
  ] as const) {
    const pw = genPassword();
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
    });
    credentials.push([username, fullName, role, regions, pw]);
  }

  // 10. Write workbooks.
  const acct = new ExcelJS.Workbook();
  acct.creator = 'NMWC CRM go-live builder';
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
    routes
      .filter((r) => r.code !== 'UNASSIGNED')
      .map((r) => ({ code: r.code, name: r.name, region_code: r.region }))
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
    ],
    users
  );
  await acct.xlsx.writeFile(path.join(OUT, 'account-master.xlsx'));

  const cust = new ExcelJS.Workbook();
  cust.creator = 'NMWC CRM go-live builder';
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

  const cred = new ExcelJS.Workbook();
  const stewardPw = genPassword();
  const managerCreds = MANAGERS.map((m) => ({ ...m, password: genPassword() }));
  addSheet(
    cred,
    'Create in app FIRST',
    ['username', 'full_name', 'role', 'regions', 'password', 'note'],
    [
      {
        username: 'steward',
        full_name: 'DATA STEWARD',
        role: 'STEWARD',
        regions: '',
        password: stewardPw,
        note: 'create first; runs the imports',
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
        steward: { username: 'steward', fullName: 'DATA STEWARD', password: stewardPw },
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

  // 11. Data-quality evidence + reconciliation report.
  writeDq('unparseable-codes.csv', ['alt_code', 'name', 'route', 'status'], unparseable);
  writeDq('phones-withheld-duplicates.csv', ['cust_code', 'name', 'phone', 'why'], phoneWithheld);
  writeDq('phones-unusable.csv', ['cust_code', 'name', 'raw_phone', 'why'], phoneReasons);
  writeDq('routes-no-salesman.csv', ['route', 'region', 'why'], routesNoSalesman);
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
    byRegion.set(S(r.sales_region), (byRegion.get(S(r.sales_region)) ?? 0) + 1);
    byStatus.set(S(r.customer_status), (byStatus.get(S(r.customer_status)) ?? 0) + 1);
    byTerms.set(S(r.payment_terms), (byTerms.get(S(r.payment_terms)) ?? 0) + 1);
  }
  const distinctCustomers = new Set(custRows.map((r) => r.cust_code)).size;
  const md: string[] = [];
  md.push('# NMWC go-live master data — build reconciliation');
  md.push(`Built ${new Date().toISOString()} from:`);
  for (const [k, f] of Object.entries(SRC)) md.push(`- ${k}: \`${f}\``);
  md.push('');
  md.push('## What is in the files');
  md.push(
    `- **Regions:** ${REGIONS.length - 1} (${REGIONS.filter((r) => r.code !== 'UNASSIGNED')
      .map((r) => r.code)
      .join(', ')})`
  );
  md.push(
    `- **Routes:** ${routes.length - 1}${routesUnmappedRegion.length ? ` — ${routesUnmappedRegion.length} could not be placed in a region and are parked under UNASSIGNED (dq/routes-region-unmapped.csv)` : ''}`
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
    `  - journey-plan day set on **${jpCovered}** branches (the plan covers 24 routes; ${jpMulti.length} customers are planned on more than one day and were loaded with their FIRST day — dq/jp-multi-day-customers.csv)`
  );
  md.push(
    `  - channel set on ${[...channelUsed.values()].reduce((a, b) => a + b, 0)} rows: ${[...channelUsed].map(([k, v]) => `${k} ${v}`).join(' · ')}${unknownChannels.size ? ` — unmapped Temix channels: ${[...unknownChannels].map(([k, v]) => `${k} (${v})`).join(', ')}` : ''}`
  );
  md.push(
    `  - phone set on ${[...phoneByBase.values()].length} customers; **${phoneWithheld.length} withheld** because the same number sits on another customer (dq/phones-withheld-duplicates.csv); ${phoneReasons.length} unusable in the source (dq/phones-unusable.csv)`
  );
  md.push(
    `  - **${creditNoLimit.length} CREDIT customers have no credit limit on file** (dq/credit-customers-without-limit.csv) — finance to confirm`
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
    `- **Users in the account master:** ${users.length} — ${SUPERVISORS.length} supervisors, ${MANAGERS.length} manager rows (regions only; the accounts are created in the app first), ${salesmanRoutes.size} salesmen, 3 approver placeholders`
  );
  md.push(
    `  - **${routesNoSalesman.length} routes have no salesman account** (dq/routes-no-salesman.csv) — van/direct routes, routes whose seller is a manager, or a second route of a salesman who already owns one`
  );
  md.push(
    `  - ${salesmanMultiRoute.length} salesmen sell on more than one route; each owns the route where they sell most (dq/salesmen-multiple-routes.csv)`
  );
  md.push(
    `  - ${namesFromRoutePro.length} salesman names come only from the RoutePro route master, which cuts names at 20 characters — check them in Users (dq/users-name-from-routepro.csv)`
  );
  md.push(
    `  - RoutePro route-name variants were folded into their base route (a van and its pre-seller are one territory): ${[
      ...routeMerges,
    ]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 8)
      .map(([k, v]) => `${k} → ${v.to} (${v.n})`)
      .join(', ')} … full list in dq/routepro-route-variants-merged.csv`
  );
  md.push('');
  md.push('## Decisions assumed — CONFIRM before production');
  md.push(
    '1. **Region codes**: MCT Muscat · KHB Khaburah (Saham/Sohar/Musannah) · NZW Nizwa · SLL Salalah · AWF Al Wafi · DQM Duqm · BRK Barka.'
  );
  md.push(
    '2. **Supervisors** are the Temix "Team Leaders": ' +
      SUPERVISORS.map((s) => `${titleCase(s.fullName)} (${s.regions.join('/')})`).join(', ') +
      '.'
  );
  md.push(
    '3. **Managers** are the sales-dashboard regional/class heads, scoped to the CRM region their class sits in:'
  );
  for (const m of MANAGERS)
    md.push(`   - ${titleCase(m.fullName)} → ${m.regions.join(', ')} — ${m.note}`);
  md.push(
    '   Muscat therefore has four managers (GT, HD, MT, HORECA) who each see the whole Muscat region — the CRM scopes by region, not by class.'
  );
  md.push(
    '4. **Salesman per route** = the named person with the most invoices on that route in September (then August, then the RoutePro route master). Van/"DIRECT" routes with no named person get no account.'
  );
  md.push(
    '5. **Approver placeholders** `accountant` (all regions), `finance.manager`, `gm.nmwc` exist so every approval chain can complete on day one. Rename/replace them with the real people in Users.'
  );
  md.push('6. **Bulk-loaded customers do not pass through the approval chain** (SOP §8.5).');
  md.push(
    '7. **Journey plan**: a branch planned on several days carries only its first day (the CRM holds one visit day per branch).'
  );
  md.push(
    '8. **Payment terms** come from RoutePro PAY_MODE (CHARGE → CREDIT, CASH → CASH); limits/days from the July account master, else the June AR snapshot.'
  );
  md.push('');
  md.push('## Load order');
  md.push(
    '1. Create the STEWARD and the 11 MANAGER accounts in the app (`credentials.xlsx`, sheet "Create in app FIRST").'
  );
  md.push(
    '2. As the steward: Import → Account master → `account-master.xlsx` (regions, routes, supervisors, salesmen, approver placeholders; assigns manager regions).'
  );
  md.push(
    '3. Import → Customer master → `customer-master.xlsx` → review quarantined rows → Promote (runs in passes; resume if interrupted) → reconcile per SOP §8.4.'
  );
  md.push('4. Hand each person their login from `credentials.xlsx`, then DELETE that file.');
  md.push('');
  md.push('## Build log');
  md.push(...notes.map((n) => `- ${n}`));
  writeFileSync(path.join(OUT, 'RECONCILIATION.md'), md.join('\n') + '\n', 'utf8');

  log(
    `account-master.xlsx: ${REGIONS.length - 1} regions, ${routes.length - 1} routes, ${users.length} users`
  );
  log(
    `customer-master.xlsx: ${custRows.length} rows / ${distinctCustomers} customers (JP day on ${jpCovered})`
  );
  log(`credentials.xlsx + managers.json written — SENSITIVE, gitignored`);
  log(`reconciliation: ${path.join(OUT, 'RECONCILIATION.md')}`);
  db.close();
}

main().catch((e) => {
  console.error('BUILD FAILED:', e);
  process.exit(1);
});
