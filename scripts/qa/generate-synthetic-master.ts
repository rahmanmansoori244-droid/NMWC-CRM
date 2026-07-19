/**
 * Deterministic synthetic Temix-master generator (QA — Deliverable 3).
 *
 * Produces, from a fixed seed, both:
 *   (a) an .xlsx customer-master workbook matching the import parser contract
 *       (services/imports.ts recognized headers), and
 *   (b) a JSON ground-truth MANIFEST giving the expected disposition of every
 *       row (accepted / rejected / updated / unchanged / conflict / duplicate /
 *       missing-mandatory / invalid-format / unauthorized / steward-review),
 *
 * so import/refresh tests assert against ground truth, not against re-running
 * the app's own logic.
 *
 * SAFETY: all data is unmistakably synthetic (names prefixed 'ZZ-SYN', CRs in a
 * reserved 9,000,000+ band, phones +96890000xxxx). No real customer data.
 *
 * NOTE ON HEADERS: the exact real Temix importer header row is an OPEN OWNER
 * DECISION (Q-temix-headers). These columns mirror the CRM import contract as a
 * proxy; remap once the genuine Temix export is supplied.
 *
 * Usage:
 *   npx tsx scripts/qa/generate-synthetic-master.ts --scale=prod --seed=424242
 *   scales: tiny(20) | medium(300) | prod(3300) | stress(10000) | dirty(catalogue)
 * Output: qa/fixtures/<scale>-<seed>/{master.xlsx, manifest.json, meta.json}
 */
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ── Seeded PRNG (mulberry32) — reproducible, no Math.random ───────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Disposition =
  | 'ACCEPTED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED' | 'CONFLICT'
  | 'DUPLICATE' | 'MISSING_MANDATORY' | 'INVALID_FORMAT' | 'STEWARD_REVIEW';

type ManifestRow = {
  rowNumber: number;          // 1-based data row (sheet row = rowNumber + 1)
  custCode: string;
  branchCode: string;
  expectedDisposition: Disposition;
  expectedErrorCode?: string;
  requirementRefs: string[];
  note?: string;
};

// Column order = the import contract (services/imports.ts recognized headers) +
// Temix refresh columns.
const HEADERS = [
  'cust_code', 'cust_name', 'branch_code', 'sales_region', 'region_code', 'route',
  'address', 'phone', 'alt_phone', 'contact_person', 'contact_role', 'cr_no',
  'payment_terms', 'credit_limit', 'payment_term_days', 'temix_code', 'channel',
  'sub_channel', 'day_of_visit', 'coolers', 'stands', 'empty_bottles',
  'gps_lat', 'gps_lng', 'customer_status', 'temix_sync_state',
] as const;

const REGIONS = [
  { code: 'MCT', name: 'Muscat' }, { code: 'DHO', name: 'Dhofar' },
  { code: 'BAT', name: 'Al Batinah' }, { code: 'DAK', name: 'Ad Dakhiliyah' },
  { code: 'SHA', name: 'Ash Sharqiyah' }, { code: 'BUR', name: 'Al Buraimi' },
];
const CHANNELS = ['HORECA', 'Modern Trade', 'General Trade', 'Convenience & Gas', 'Institutions'];
const SUBCHANNELS = ['Restaurants', 'Hotels', 'Supermarket', 'Grocery', 'Cafeteria'];
const DAYS = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU'];
const EN_NAMES = ['Al Fanar', 'Corner', 'Green Oasis', 'Blue Nile', 'Sultan', 'Pearl', 'Desert Rose', 'Falcon', 'Nizwa', 'Sur Bay'];
const AR_NAMES = ['النور', 'الواحة', 'اللؤلؤة', 'الصحراء', 'الخليج', 'النخيل'];
const SUFFIX = ['Trading LLC', 'Restaurant', 'Supermarket', 'Cafeteria', 'Est.'];

// Oman GPS envelope (matches the app's Zod bounds lat 16-27, lng 51-61).
function omanGps(rnd: () => number) {
  return { lat: +(16.5 + rnd() * 10).toFixed(6), lng: +(52 + rnd() * 8).toFixed(6) };
}

function pick<T>(rnd: () => number, arr: readonly T[]): T { return arr[Math.floor(rnd() * arr.length)]!; }

/** A clean, valid customer with N branches → one manifest row per branch, all ACCEPTED. */
function makeCleanCustomer(rnd: () => number, idx: number, region: { code: string; name: string }) {
  const custCode = `ZZSYN-${String(idx).padStart(6, '0')}`;
  const isCredit = rnd() < 0.3;
  const nameEn = `ZZ-SYN ${pick(rnd, EN_NAMES)} ${pick(rnd, SUFFIX)}`;
  const nameAr = pick(rnd, AR_NAMES);
  const cr = String(9_000_000 + idx); // reserved synthetic CR band
  const phone = `+96890${String(100000 + (idx % 900000)).padStart(6, '0')}`;
  const channel = pick(rnd, CHANNELS);
  const sub = pick(rnd, SUBCHANNELS);
  const nBranches = (() => { const r = rnd(); return r < 0.6 ? 1 : r < 0.85 ? 2 : r < 0.95 ? 3 : 4; })();
  const syncState = pick(rnd, ['SYNCED', 'SYNCED', 'SYNCED', 'PENDING_UPLOAD', 'UPLOADED', 'DEACTIVATE_PENDING']);
  const rows: Array<Record<string, string | number>> = [];
  for (let b = 0; b < nBranches; b++) {
    const gps = omanGps(rnd);
    rows.push({
      cust_code: custCode,
      cust_name: rnd() < 0.5 ? `${nameEn} ${nameAr}` : nameEn,
      branch_code: `${custCode}-${String(b + 1).padStart(2, '0')}`,
      sales_region: region.name, region_code: region.code,
      route: `${region.code}-R${String(1 + (idx % 8)).padStart(2, '0')}`,
      address: `Building ${1 + (idx % 200)}, Way ${100 + (idx % 8000)}, ${region.name}`,
      phone, alt_phone: '', contact_person: `ZZ-SYN Contact ${idx}`, contact_role: 'Owner',
      cr_no: cr, payment_terms: isCredit ? 'CREDIT' : 'CASH',
      credit_limit: isCredit ? (Math.round(rnd() * 5000 * 1000) / 1000).toFixed(3) : '',
      payment_term_days: isCredit ? pick(rnd, [14, 30, 45, 60]) : '',
      temix_code: syncState === 'SYNCED' ? custCode : '', // migrated rows: temix==nmwc
      channel, sub_channel: sub, day_of_visit: pick(rnd, DAYS),
      coolers: Math.floor(rnd() * 4), stands: Math.floor(rnd() * 3), empty_bottles: Math.floor(rnd() * 80),
      gps_lat: gps.lat, gps_lng: gps.lng,
      customer_status: rnd() < 0.9 ? 'ACTIVE' : 'CLOSED',
      temix_sync_state: syncState,
    });
  }
  return { custCode, rows, isCredit };
}

/**
 * The dirty-data / adversarial catalogue. Each entry appends its own row(s) to
 * the sheet and returns the manifest rows describing the expected disposition.
 * Reproduction contract lines up with the import parser's real behavior
 * (F-05 stripHtml + formula reject, F-12 payment-terms whitelist, master
 * phone/CR cross-checks now self-excluding by nmwcCode, etc.).
 */
function dirtyCatalogue(startIdx: number) {
  const sheetRows: Array<Record<string, string | number>> = [];
  const manifest: Array<Omit<ManifestRow, 'rowNumber'>> = [];
  const base = (over: Record<string, string | number>) => ({
    cust_code: `ZZDIRTY-${String(startIdx + sheetRows.length).padStart(4, '0')}`,
    cust_name: 'ZZ-SYN Dirty Co', branch_code: '', sales_region: 'Muscat', region_code: 'MCT',
    // Unique per row — a constant phone would trip the importer's in-file
    // phone-dup check on EVERY row (the check is correct; a shared fixture phone
    // is not). Rows that test phone behavior override this explicitly below.
    route: 'MCT-R01', address: 'Way 1, Muscat', phone: `+9689${String(2_000_000 + sheetRows.length)}`, alt_phone: '',
    contact_person: 'ZZ-SYN C', contact_role: 'Owner', cr_no: String(9_500_000 + sheetRows.length),
    payment_terms: 'CASH', credit_limit: '', payment_term_days: '', temix_code: '',
    channel: 'HORECA', sub_channel: 'Restaurants', day_of_visit: 'MON',
    coolers: 0, stands: 0, empty_bottles: 0, gps_lat: 23.6, gps_lng: 58.4,
    customer_status: 'ACTIVE', temix_sync_state: 'SYNCED', ...over,
  });
  const add = (row: Record<string, string | number>, m: Omit<ManifestRow, 'rowNumber'>) => {
    sheetRows.push(row); manifest.push({ ...m, custCode: String(row.cust_code), branchCode: String(row.branch_code) });
  };

  // Missing mandatory cust_code / cust_name.
  add(base({ cust_code: '' }), { custCode: '', branchCode: '', expectedDisposition: 'MISSING_MANDATORY', expectedErrorCode: 'cust_code:required', requirementRefs: ['R17'] });
  add(base({ cust_name: '' }), { custCode: '', branchCode: '', expectedDisposition: 'MISSING_MANDATORY', expectedErrorCode: 'cust_name:required', requirementRefs: ['R17'] });
  // Invalid payment_terms (F-12 whitelist).
  add(base({ payment_terms: 'Crdit' }), { custCode: '', branchCode: '', expectedDisposition: 'INVALID_FORMAT', expectedErrorCode: 'payment_terms', requirementRefs: ['R1', 'R2'] });
  // Invalid phone format.
  add(base({ phone: '12' }), { custCode: '', branchCode: '', expectedDisposition: 'INVALID_FORMAT', expectedErrorCode: 'phone', requirementRefs: ['R34'] });
  // Formula injection in a text field (F-05 reject).
  add(base({ cust_name: '=cmd|/c calc', address: '@SUM(A1:A9)' }), { custCode: '', branchCode: '', expectedDisposition: 'REJECTED', expectedErrorCode: 'formula_payload', requirementRefs: ['SEC-03'] });
  // HTML/script (stripped, not rejected — becomes clean text).
  add(base({ contact_person: '<script>x</script>ZZ-SYN' }), { custCode: '', branchCode: '', expectedDisposition: 'ACCEPTED', requirementRefs: ['SEC-03'], note: 'stripHtml sanitizes to plain text' });
  // In-file duplicate CR (two rows, different cust_code, same CR).
  const dupCr = String(9_600_001);
  add(base({ cust_code: 'ZZDUP-A', cr_no: dupCr }), { custCode: 'ZZDUP-A', branchCode: '', expectedDisposition: 'STEWARD_REVIEW', expectedErrorCode: 'cr_no:dup_in_file', requirementRefs: ['R22'] });
  add(base({ cust_code: 'ZZDUP-B', cr_no: dupCr }), { custCode: 'ZZDUP-B', branchCode: '', expectedDisposition: 'STEWARD_REVIEW', expectedErrorCode: 'cr_no:dup_in_file', requirementRefs: ['R22'] });
  // Duplicate phone in file (allowed — P1.3; not blocked).
  // An in-file phone duplicate flags BOTH occurrences for steward review (neither
  // is canonical). Phone dups ARE allowed at the master level (partial-unique was
  // dropped) — so both promote fine, but the import quarantines both for review.
  add(base({ cust_code: 'ZZPH-A', phone: '+96890222222' }), { custCode: 'ZZPH-A', branchCode: '', expectedDisposition: 'STEWARD_REVIEW', expectedErrorCode: 'phone:dup_in_file', requirementRefs: ['R-phone'], note: 'in-file phone dup flags BOTH rows; dup allowed at master level' });
  add(base({ cust_code: 'ZZPH-B', phone: '+96890222222' }), { custCode: 'ZZPH-B', branchCode: '', expectedDisposition: 'STEWARD_REVIEW', expectedErrorCode: 'phone:dup_in_file', requirementRefs: ['R-phone'], note: 'in-file phone dup flags BOTH rows; dup allowed at master level' });
  // GPS outside Oman — import carries no GPS columns to the parser, so this is
  // NOT a bypass at import; documented for the CREATE/edit path instead.
  add(base({ cust_code: 'ZZGPS', gps_lat: 33.3, gps_lng: 44.4 }), { custCode: 'ZZGPS', branchCode: '', expectedDisposition: 'ACCEPTED', requirementRefs: ['R25'], note: 'import parser ignores gps columns; Oman-bound enforced only on CREATE/edit Zod + no DB CHECK for envelope' });
  // Temix crosswalk conflict: temix_code already owned by a different customer.
  add(base({ cust_code: 'ZZXW-A', temix_code: 'TEMIX-SHARED-1' }), { custCode: 'ZZXW-A', branchCode: '', expectedDisposition: 'ACCEPTED', requirementRefs: ['R19'], note: 'first claimant of the temix code' });
  add(base({ cust_code: 'ZZXW-B', temix_code: 'TEMIX-SHARED-1' }), { custCode: 'ZZXW-B', branchCode: '', expectedDisposition: 'CONFLICT', expectedErrorCode: 'CROSSWALK:temix_code', requirementRefs: ['R19', 'R31'], note: 'refresh must reject: code owned by another customer' });
  // Credit with >3-dp / negative / absurd credit limit.
  add(base({ payment_terms: 'CREDIT', credit_limit: '100.12345', payment_term_days: 30 }), { custCode: '', branchCode: '', expectedDisposition: 'INVALID_FORMAT', expectedErrorCode: 'credit_limit', requirementRefs: ['R20'], note: 'refresh parser rounds to 3dp; >3dp is precision loss to verify' });
  add(base({ payment_terms: 'CREDIT', credit_limit: '-5.000', payment_term_days: 30 }), { custCode: '', branchCode: '', expectedDisposition: 'INVALID_FORMAT', expectedErrorCode: 'credit_limit', requirementRefs: ['R20'] });
  add(base({ payment_terms: 'CREDIT', payment_term_days: 999 }), { custCode: '', branchCode: '', expectedDisposition: 'INVALID_FORMAT', expectedErrorCode: 'payment_term_days', requirementRefs: ['R20'] });
  // Whitespace-only / very long values.
  add(base({ contact_person: '   ' }), { custCode: '', branchCode: '', expectedDisposition: 'ACCEPTED', requirementRefs: ['R-validation'], note: 'whitespace trimmed to empty optional' });
  add(base({ cust_name: 'ZZ-SYN ' + 'X'.repeat(500) }), { custCode: '', branchCode: '', expectedDisposition: 'ACCEPTED', requirementRefs: ['R-validation'], note: 'length bound behavior to verify (import has no explicit length cap)' });
  // Route-region mismatch (route code from a different region than sales_region).
  add(base({ sales_region: 'Muscat', region_code: 'MCT', route: 'DHO-R01' }), { custCode: '', branchCode: '', expectedDisposition: 'STEWARD_REVIEW', expectedErrorCode: 'route_region_mismatch', requirementRefs: ['R24'], note: 'unknown/foreign route -> UNASSIGNED fallback + warning (F-17)' });

  return { sheetRows, manifest };
}

async function buildWorkbook(rows: Array<Record<string, string | number>>, headerRow = 1, sheetName = 'Customers') {
  const wb = new ExcelJS.Workbook();
  // Pin all workbook metadata so the .xlsx bytes are BYTE-IDENTICAL across runs
  // for a given seed (exceljs otherwise stamps live created/modified times,
  // breaking reproducibility — QA determinism requirement).
  const fixed = new Date('2026-01-01T00:00:00.000Z');
  wb.creator = 'nmwc-qa-generator';
  wb.lastModifiedBy = 'nmwc-qa-generator';
  wb.created = fixed;
  wb.modified = fixed;
  const ws = wb.addWorksheet(sheetName);
  // Optional: header not on row 1 (parser-variant fixtures).
  for (let i = 1; i < headerRow; i++) ws.addRow([`(intentional blank row ${i})`]);
  ws.addRow(HEADERS as unknown as string[]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  return wb;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'];
  }));
  const seed = Number(args.seed ?? 424242);
  const scale = String(args.scale ?? 'tiny');
  const counts: Record<string, number> = { tiny: 20, medium: 300, prod: 3300, stress: Number(args.count ?? 10000) };
  const rnd = mulberry32(seed);

  const outDir = path.join('qa', 'fixtures', `${scale}-${seed}`);
  mkdirSync(outDir, { recursive: true });

  const sheetRows: Array<Record<string, string | number>> = [];
  const manifest: ManifestRow[] = [];

  if (scale === 'dirty') {
    const d = dirtyCatalogue(1);
    d.sheetRows.forEach((r, i) => {
      sheetRows.push(r);
      manifest.push({ rowNumber: i + 1, ...d.manifest[i]! });
    });
  } else {
    const n = counts[scale] ?? 20;
    let created = 0;
    let idx = 1;
    while (created < n) {
      const region = pick(rnd, REGIONS);
      const c = makeCleanCustomer(rnd, idx, region);
      for (const r of c.rows) {
        sheetRows.push(r);
        manifest.push({
          rowNumber: sheetRows.length, custCode: c.custCode, branchCode: String(r.branch_code),
          expectedDisposition: 'ACCEPTED',
          requirementRefs: ['R16', 'R17', 'R18', c.isCredit ? 'R20' : 'R1'],
        });
      }
      created++; idx++;
    }
  }

  const wb = await buildWorkbook(sheetRows);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const xlsxPath = path.join(outDir, 'master.xlsx');
  writeFileSync(xlsxPath, buf);
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

  const dispo = manifest.reduce<Record<string, number>>((a, m) => { a[m.expectedDisposition] = (a[m.expectedDisposition] ?? 0) + 1; return a; }, {});
  const customers = new Set(manifest.map((m) => m.custCode)).size;
  // Determinism is asserted on the DATA, not the .xlsx bytes: an .xlsx is a ZIP
  // whose per-entry timestamps are set at write time, so byte-identical zips are
  // impractical. dataSha256 hashes the canonical cell content (header + every
  // row in column order) and manifestSha256 hashes the ground truth — both are
  // pure functions of (scale, seed) and are the reproducibility contract.
  const canonical = JSON.stringify({ headers: HEADERS, rows: sheetRows.map((r) => HEADERS.map((h) => String(r[h] ?? ''))) });
  const meta = {
    scale, seed, headers: HEADERS,
    rowCount: sheetRows.length, customerCount: customers,
    dispositionCounts: dispo,
    dataSha256: createHash('sha256').update(canonical).digest('hex'),
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    xlsxByteDeterminism: 'NOT_GUARANTEED (zip container timestamps); use dataSha256/manifestSha256 for reproducibility',
    reproduce: `npx tsx scripts/qa/generate-synthetic-master.ts --scale=${scale} --seed=${seed}`,
    headerNote: 'Columns are a PROXY for the CRM import contract. Real Temix headers are an OPEN owner decision (Q-temix-headers).',
  };
  writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({ scale, seed, rows: sheetRows.length, customers, dispo, out: outDir, dataSha256: meta.dataSha256.slice(0, 16), manifestSha256: meta.manifestSha256.slice(0, 16) }, null, 2));
}

main().catch((e) => { console.error('GEN ERROR', e); process.exitCode = 1; });
