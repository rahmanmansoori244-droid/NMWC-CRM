/**
 * Apply the Payment Type column from the (now 4-column) GT-MUSCAT-PILOT
 * xlsx onto the loaded customer master.
 *
 * Source columns: Route · Alternate Code · Customer Name · Payment Type
 *   - Payment Type is a formula whose `result` is "Cash" or "Credit".
 *
 * Behaviour:
 *   - For every row, set Customer.paymentTerms ∈ {CASH, CREDIT}.
 *   - For NEW customers (not already in the master), also create the
 *     customer + a primary "Main" branch on the matching route.
 *   - Existing customers' phone/CR/contact/address are LEFT ALONE so this
 *     run does not destroy data the earlier loader already wrote.
 *   - Idempotent: re-running just refreshes paymentTerms.
 *
 * Run with:  npx tsx prisma/seed-muscat-payment-terms.ts
 */
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const SOURCE_FILE = 'C:/Users/rahma/Downloads/GT-MUSCAT-PILOT.xlsx';
const SHEET_NAME = 'Consolidated';

/** Read a cell value robustly — handles plain values, rich text, and
 *  formula cells (returns the computed `.result`). */
function readCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object') {
    if ('result' in v) {
      const r = (v as { result: unknown }).result;
      if (r && typeof r === 'object' && 'error' in r) return '';
      return String(r ?? '').trim();
    }
    if ('richText' in v) {
      return (v as { richText: { text: string }[] }).richText
        .map((rt) => rt.text)
        .join('')
        .trim();
    }
    if ('text' in v) return String((v as { text: string }).text).trim();
  }
  return String(v).trim();
}

type Row = {
  rowNum: number;
  routeCode: string;
  custCode: string;
  custName: string;
  paymentTerms: 'CASH' | 'CREDIT';
};

async function readRows(): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE_FILE);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found`);

  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (c) => headers.push(readCell(c.value)));
  const idx = (h: string) => headers.findIndex((x) => x === h);
  const ROUTE = idx('Route');
  const CODE = idx('Alternate Code');
  const NAME = idx('Customer Name');
  const PT = idx('Payment Type');
  if (ROUTE < 0 || CODE < 0 || NAME < 0 || PT < 0) {
    throw new Error(`Missing columns. Found: ${headers.join(', ')}`);
  }

  const out: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (r, rowNum) => {
    if (rowNum === 1) return;
    const route = readCell(r.getCell(ROUTE + 1).value).toUpperCase();
    const code = readCell(r.getCell(CODE + 1).value);
    const name = readCell(r.getCell(NAME + 1).value);
    const ptRaw = readCell(r.getCell(PT + 1).value).toUpperCase();
    if (!code || !name) return;
    const pt: 'CASH' | 'CREDIT' = ptRaw === 'CREDIT' ? 'CREDIT' : 'CASH';
    out.push({ rowNum, routeCode: route, custCode: code, custName: name, paymentTerms: pt });
  });
  return out;
}

async function main() {
  console.log('Customer payment-terms refresh — GT-MUSCAT — start');
  const rows = await readRows();
  const ptCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.paymentTerms] = (acc[r.paymentTerms] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  parsed ${rows.length} rows`);
  console.log(`  payment-terms distribution: ${JSON.stringify(ptCounts)}`);

  const muscat = await prisma.region.findUniqueOrThrow({ where: { code: 'MUSCAT' } });
  const allRoutes = await prisma.route.findMany({ select: { id: true, code: true } });
  const routeByCode = new Map(allRoutes.map((r) => [r.code, r.id]));
  const steward = await prisma.user.findUnique({ where: { username: 'pilot.steward' } });
  const stewardId = steward?.id;

  // Group rows by parent customer code so multi-row customers refresh once.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const list = groups.get(r.custCode) ?? [];
    list.push(r);
    groups.set(r.custCode, list);
  }
  console.log(`  ${groups.size} unique parent customers`);

  let refreshed = 0;
  let created = 0;
  let branchesCreated = 0;
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

    try {
      const existed = await prisma.customer.findUnique({ where: { nmwcCode: custCode } });
      const customer = await prisma.customer.upsert({
        where: { nmwcCode: custCode },
        // Only update name + paymentTerms — leave phone/CR/contact/address alone
        update: {
          legalName: first.custName,
          paymentTerms: first.paymentTerms,
          lastEditedById: stewardId,
        },
        create: {
          nmwcCode: custCode,
          legalName: first.custName,
          paymentTerms: first.paymentTerms,
          createdById: stewardId,
          lastEditedById: stewardId,
        },
      });
      if (existed) refreshed++;
      else created++;

      // Branches — one per source row. Existing branches keep their
      // address/photos; new ones get a placeholder address.
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const branchRouteId = routeByCode.get(r.routeCode);
        if (!branchRouteId) {
          routeMisses++;
          continue;
        }
        const branchCode = `${custCode}-${String(i + 1).padStart(2, '0')}`;
        const existing = await prisma.branch.findUnique({ where: { branchCode } });
        if (existing) {
          // refresh route/region only — preserve enriched fields
          await prisma.branch.update({
            where: { branchCode },
            data: {
              regionId: muscat.id,
              routeId: branchRouteId,
              lastEditedById: stewardId,
            },
          });
        } else {
          await prisma.branch.create({
            data: {
              branchCode,
              branchName: list.length === 1 ? 'Main' : `Branch ${i + 1}`,
              customerId: customer.id,
              regionId: muscat.id,
              routeId: branchRouteId,
              address: 'Address pending',
              createdById: stewardId,
            },
          });
          branchesCreated++;
        }
      }
    } catch (err) {
      errors++;
      const msg = (err as Error).message?.slice(0, 160);
      if (errSamples.length < 5) errSamples.push({ code: custCode, reason: msg ?? 'unknown' });
    }
    if ((refreshed + created) % 200 === 0 && (refreshed + created) > 0) {
      console.log(`  ... ${refreshed + created} parents processed`);
    }
  }

  if (stewardId) {
    await prisma.auditLog.create({
      data: {
        actorId: stewardId,
        action: 'IMPORT',
        entityType: 'CustomerMaster',
        entityId: 'GT-MUSCAT-PILOT-PT',
        after: {
          source: 'GT-MUSCAT-PILOT.xlsx',
          step: 'payment-terms-refresh',
          refreshed,
          created,
          branchesCreated,
          routeMisses,
          errors,
          paymentTermDistribution: ptCounts,
        },
        reason: 'gt_muscat_pilot_payment_terms',
      },
    });
  }

  console.log('\nCustomer payment-terms refresh — GT-MUSCAT — done');
  console.log(`  refreshed (existed):    ${refreshed}`);
  console.log(`  created (new):          ${created}`);
  console.log(`  branches created:       ${branchesCreated}`);
  console.log(`  rows skipped (route miss): ${routeMisses}`);
  console.log(`  errors:                 ${errors}`);
  if (errSamples.length) {
    console.log('  sample errors:');
    for (const s of errSamples) console.log(`    ${s.code}: ${s.reason}`);
  }
}

main()
  .catch((err) => {
    console.error('Refresh failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
