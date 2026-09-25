/**
 * The master side of the customer-upload check: which live customers already
 * hold a phone or CR a sheet row carries. Shared by the upload and by the
 * Steward's in-app fix of a held-back row (benchmark item 20), so a fixed row
 * is checked against the master exactly as an uploaded one is.
 *
 * Keyed by the OWNING nmwcCode so a row that updates its own customer (a
 * re-import or a Temix refresh of the existing master) does not self-collide —
 * this once used bare Sets and every refresh row of a known customer was
 * quarantined against itself.
 */
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import type { NewerUpload } from '@/lib/import-row-fix';

export async function masterCollisionMaps(
  phones: string[],
  crs: string[]
): Promise<{ masterPhones: Map<string, string[]>; masterCrs: Map<string, string[]> }> {
  const masterPhones = new Map<string, string[]>();
  if (phones.length) {
    for (const c of await prisma.customer.findMany({
      where: { primaryPhoneNorm: { in: phones }, deletedAt: null },
      select: { primaryPhoneNorm: true, nmwcCode: true },
    })) {
      if (!c.primaryPhoneNorm) continue;
      const a = masterPhones.get(c.primaryPhoneNorm) ?? [];
      a.push(c.nmwcCode);
      masterPhones.set(c.primaryPhoneNorm, a);
    }
  }
  const masterCrs = new Map<string, string[]>();
  if (crs.length) {
    for (const c of await prisma.customer.findMany({
      where: { crNumberNorm: { in: crs }, deletedAt: null },
      select: { crNumberNorm: true, nmwcCode: true },
    })) {
      if (!c.crNumberNorm) continue;
      const a = masterCrs.get(c.crNumberNorm) ?? [];
      a.push(c.nmwcCode);
      masterCrs.set(c.crNumberNorm, a);
    }
  }
  return { masterPhones, masterCrs };
}

/**
 * For each customer code, the row in the NEWEST customer upload after
 * `uploadedAt` that carries it. The batch page uses it to offer only
 * "Exclude" on a row a newer upload has superseded, and the fix actions use it
 * to refuse one — the same query, so the page never offers what the server
 * refuses.
 */
export async function newerUploadsCarrying(
  db: Prisma.TransactionClient | typeof prisma,
  uploadedAt: Date,
  codes: string[]
): Promise<Map<string, NewerUpload>> {
  const out = new Map<string, NewerUpload>();
  if (codes.length === 0) return out;
  const rows = await db.$queryRaw<
    Array<{ code: string; filename: string; rowNumber: number; state: string; excluded: boolean }>
  >`
    SELECT DISTINCT ON (r."parsed"->>'custCode')
           r."parsed"->>'custCode' AS "code", b."filename", r."rowNumber",
           r."state"::text AS "state", (r."excludedAt" IS NOT NULL) AS "excluded"
      FROM "ImportRow" r
      JOIN "ImportBatch" b ON b."id" = r."batchId"
     WHERE b."kind" = 'CUSTOMER'
       AND b."uploadedAt" > ${uploadedAt}
       AND r."parsed"->>'custCode' = ANY(${codes})
     ORDER BY r."parsed"->>'custCode', b."uploadedAt" DESC, r."rowNumber"`;
  for (const r of rows) {
    out.set(r.code, { filename: r.filename, rowNumber: r.rowNumber, state: r.state, excluded: r.excluded });
  }
  return out;
}
