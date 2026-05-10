/**
 * Bulk-load the GT-MUSCAT pilot customer master.
 *
 * Source: C:/Users/rahma/Downloads/GT-MUSCAT-PILOT.xlsx
 * 3,308 rows → upsert into Customer + Branch.
 *
 * Field map:
 *   Alternate Code   → Customer.nmwcCode
 *   Customer Name    → Customer.legalName
 *   Route            → Branch.route (lookup by code, must exist)
 *   (constant)       → Branch.region = MUSCAT
 *   ADDRESS          → Branch.address  ("0" → null → "Address pending")
 *   PHONE            → Customer.primaryPhone (normalized; "0" → null;
 *                      first writer wins on collisions to satisfy the
 *                      partial-unique index)
 *   CR               → Customer.crNumber  ("0" → null; normalized)
 *   CONTACT PERSON   → Customer.contactPerson  ("0" → null)
 *   EMAIL            → dropped (no Customer.email field in schema)
 *   CHANNEL          → null per user instruction; salesmen pick at enrichment
 *   (default)        → Customer.paymentTerms = CASH
 *
 * Idempotent: every write is upsert keyed on nmwcCode / branchCode.
 * Re-running refreshes the rows without duplicating.
 *
 * Run with:  npx tsx prisma/seed-muscat-customers.ts
 */
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { normalizePhone } from '../lib/phone.js';
import { normalizeCR } from '../lib/cr.js';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const SOURCE_FILE = 'C:/Users/rahma/Downloads/GT-MUSCAT-PILOT.xlsx';
const SHEET_NAME = 'Consolidated';

type Row = {
  rowNum: number;
  routeCode: string;
  custCode: string;
  custName: string;
  cr: string | null;
  phone: string | null; // normalized
  contact: string | null;
  address: string | null;
};

function clean(s: unknown): string {
  return String(s ?? '').trim();
}
function nullIfZero(s: unknown): string | null {
  const v = clean(s);
  if (!v || v === '0') return null;
  return v;
}

async function readRows(): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE_FILE);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found`);
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (c) => headers.push(clean(c.value)));
  const idxOf = (h: string) => headers.findIndex((x) => x === h);
  const ROUTE = idxOf('Route');
  const CODE = idxOf('Alternate Code');
  const NAME = idxOf('Customer Name');
  const CR = idxOf('CR');
  const PHONE = idxOf('PHONE');
  const CONTACT = idxOf('CONTACT PERSON');
  const ADDRESS = idxOf('ADDRESS');

  const out: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (r, rowNum) => {
    if (rowNum === 1) return;
    const route = clean(r.getCell(ROUTE + 1).value).toUpperCase();
    const code = clean(r.getCell(CODE + 1).value);
    const name = clean(r.getCell(NAME + 1).value);
    if (!code || !name) return; // skip empties
    out.push({
      rowNum,
      routeCode: route,
      custCode: code,
      custName: name,
      cr: nullIfZero(r.getCell(CR + 1).value),
      phone: normalizePhone(nullIfZero(r.getCell(PHONE + 1).value)),
      contact: nullIfZero(r.getCell(CONTACT + 1).value),
      address: nullIfZero(r.getCell(ADDRESS + 1).value),
    });
  });
  return out;
}

async function main() {
  console.log('Customer master load — GT-MUSCAT — start');
  const rows = await readRows();
  console.log(`  parsed ${rows.length} non-empty rows from ${SOURCE_FILE}`);

  // Resolve foreign keys
  const muscat = await prisma.region.findUniqueOrThrow({ where: { code: 'MUSCAT' } });
  const allRoutes = await prisma.route.findMany({ select: { id: true, code: true } });
  const routeByCode = new Map(allRoutes.map((r) => [r.code, r.id]));
  const steward = await prisma.user.findUnique({ where: { username: 'pilot.steward' } });
  const stewardId = steward?.id;

  // Group rows by parent customer code so multi-branch customers land cleanly
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const list = groups.get(r.custCode) ?? [];
    list.push(r);
    groups.set(r.custCode, list);
  }
  console.log(`  ${groups.size} unique parent customers (Alternate Code)`);

  // Track phone collisions across customers — first writer wins. The DB
  // partial-unique index on Customer.primaryPhoneNorm WHERE deletedAt IS NULL
  // would otherwise reject the 2nd+ insert.
  const claimedPhones = new Set<string>();
  // Pre-claim phones already in the live master so re-runs don't fight
  // existing customers.
  for (const c of await prisma.customer.findMany({
    where: { primaryPhoneNorm: { not: null }, deletedAt: null },
    select: { primaryPhoneNorm: true },
  })) {
    if (c.primaryPhoneNorm) claimedPhones.add(c.primaryPhoneNorm);
  }

  // Track CR collisions similarly (no unique index on crNumberNorm but
  // dedup makes the dataset cleaner).
  const claimedCrs = new Set<string>();
  for (const c of await prisma.customer.findMany({
    where: { crNumberNorm: { not: null }, deletedAt: null },
    select: { crNumberNorm: true },
  })) {
    if (c.crNumberNorm) claimedCrs.add(c.crNumberNorm);
  }

  let customers = 0;
  let branches = 0;
  let phonesDropped = 0;
  let crsDropped = 0;
  let routeMisses = 0;
  let errors = 0;
  const errSamples: Array<{ code: string; reason: string }> = [];

  for (const [custCode, list] of groups) {
    const first = list[0];
    const routeId = routeByCode.get(first.routeCode);
    if (!routeId) {
      routeMisses += list.length;
      if (errSamples.length < 5)
        errSamples.push({ code: custCode, reason: `unknown route ${first.routeCode}` });
      continue;
    }

    // First writer wins on phone — pick the first row with a non-null phone
    // whose normalized form isn't already claimed.
    let phone: string | null = null;
    for (const r of list) {
      if (r.phone && !claimedPhones.has(r.phone)) {
        phone = r.phone;
        claimedPhones.add(r.phone);
        break;
      } else if (r.phone) {
        phonesDropped++;
      }
    }
    let cr: string | null = null;
    let crNorm: string | null = null;
    for (const r of list) {
      if (r.cr) {
        const n = normalizeCR(r.cr);
        if (n && !claimedCrs.has(n)) {
          cr = r.cr;
          crNorm = n;
          claimedCrs.add(n);
          break;
        } else if (n) {
          crsDropped++;
        }
      }
    }
    const contact = list.find((r) => r.contact)?.contact ?? null;

    try {
      const customer = await prisma.customer.upsert({
        where: { nmwcCode: custCode },
        update: {
          legalName: first.custName,
          primaryPhone: phone,
          primaryPhoneNorm: phone,
          contactPerson: contact,
          crNumber: cr,
          crNumberNorm: crNorm,
          lastEditedById: stewardId,
        },
        create: {
          nmwcCode: custCode,
          legalName: first.custName,
          paymentTerms: 'CASH',
          primaryPhone: phone,
          primaryPhoneNorm: phone,
          contactPerson: contact,
          crNumber: cr,
          crNumberNorm: crNorm,
          createdById: stewardId,
          lastEditedById: stewardId,
        },
      });
      customers++;

      // One branch per source row. branchCode = "<custCode>-NN" so
      // multi-row customers get multiple branches.
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const branchCode = `${custCode}-${String(i + 1).padStart(2, '0')}`;
        const branchRouteId = routeByCode.get(r.routeCode);
        if (!branchRouteId) {
          routeMisses++;
          continue;
        }
        await prisma.branch.upsert({
          where: { branchCode },
          update: {
            branchName: list.length === 1 ? 'Main' : `Branch ${i + 1}`,
            customerId: customer.id,
            regionId: muscat.id,
            routeId: branchRouteId,
            address: r.address ?? 'Address pending',
            lastEditedById: stewardId,
          },
          create: {
            branchCode,
            branchName: list.length === 1 ? 'Main' : `Branch ${i + 1}`,
            customerId: customer.id,
            regionId: muscat.id,
            routeId: branchRouteId,
            address: r.address ?? 'Address pending',
            createdById: stewardId,
          },
        });
        branches++;
      }
    } catch (err) {
      errors++;
      const msg = (err as Error).message?.slice(0, 120);
      if (errSamples.length < 5) errSamples.push({ code: custCode, reason: msg ?? 'unknown' });
    }
    if (customers % 200 === 0) console.log(`  ... ${customers} customers / ${branches} branches`);
  }

  // Single audit log row attributing the bulk import to the seed actor.
  if (stewardId) {
    await prisma.auditLog.create({
      data: {
        actorId: stewardId,
        action: 'IMPORT',
        entityType: 'CustomerMaster',
        entityId: 'GT-MUSCAT-PILOT',
        after: {
          source: 'GT-MUSCAT-PILOT.xlsx',
          customers,
          branches,
          phonesDropped,
          crsDropped,
          routeMisses,
          errors,
        },
        reason: 'gt_muscat_pilot_initial_load',
      },
    });
  }

  console.log('\nCustomer master load — GT-MUSCAT — done');
  console.log(`  customers upserted: ${customers}`);
  console.log(`  branches upserted:  ${branches}`);
  console.log(`  phones dropped (collision): ${phonesDropped}`);
  console.log(`  CRs dropped (collision):    ${crsDropped}`);
  console.log(`  rows skipped (route miss):  ${routeMisses}`);
  console.log(`  errors:             ${errors}`);
  if (errSamples.length) {
    console.log('  sample errors:');
    for (const s of errSamples) console.log(`    ${s.code}: ${s.reason}`);
  }
}

main()
  .catch((err) => {
    console.error('Customer load failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
