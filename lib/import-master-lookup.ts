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
import {
  composeBranchCode,
  supersedingUpload,
  type NewerCandidate,
  type NewerUpload,
} from '@/lib/import-row-fix';

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

/** A row whose fix a newer upload may rule out: `key` names it in the answer. */
export type FixTarget = { key: string; code: string; branch: string | null };

/**
 * For each target, the newer customer upload (after `uploadedAt`) that rules
 * out fixing it, if any — `supersedingUpload` decides, per customer: any newer
 * upload for a customer not linked to Temix, only a newer row about the same
 * branch for one that is. The batch page uses it to offer only "Exclude" (or
 * "Withdraw fix"), the fix actions to refuse, and promote to reject a fix that
 * a newer upload overtook while it waited — one rule, so the page never offers
 * what the server refuses.
 */
export async function newerUploadsCarrying(
  db: Prisma.TransactionClient | typeof prisma,
  uploadedAt: Date,
  targets: FixTarget[]
): Promise<Map<string, NewerUpload>> {
  const out = new Map<string, NewerUpload>();
  const codes = [...new Set(targets.map((t) => t.code))];
  if (codes.length === 0) return out;
  const rows = await db.$queryRaw<
    Array<{
      code: string;
      filename: string;
      rowNumber: number;
      state: string;
      excluded: boolean;
      branchCode: string | null;
      fixedInApp: boolean | null;
      refreshRow: boolean | null;
    }>
  >`
    SELECT r."parsed"->>'custCode' AS "code", b."filename", r."rowNumber",
           r."state"::text AS "state", (r."excludedAt" IS NOT NULL) AS "excluded",
           r."parsed"->>'branchCode' AS "branchCode",
           (r."parsed"->>'fixedInApp') = 'true' AS "fixedInApp",
           (c."temixCode" IS NOT NULL
             AND r."parsed"->>'temixCode' = c."temixCode"
             AND b."id" IS DISTINCT FROM c."importBatchId") AS "refreshRow"
      FROM "ImportRow" r
      JOIN "ImportBatch" b ON b."id" = r."batchId"
      LEFT JOIN "Customer" c ON c."nmwcCode" = r."parsed"->>'custCode'
     WHERE b."kind" = 'CUSTOMER'
       AND b."uploadedAt" > ${uploadedAt}
       AND r."parsed"->>'custCode' = ANY(${codes})
     ORDER BY b."uploadedAt" DESC, r."rowNumber"`;
  const byCode = new Map<string, NewerCandidate[]>();
  for (const r of rows) {
    const list = byCode.get(r.code) ?? [];
    list.push({
      filename: r.filename,
      rowNumber: r.rowNumber,
      state: r.state,
      excluded: r.excluded,
      branch: r.branchCode ? composeBranchCode(r.code, r.branchCode) : null,
      fixedInApp: r.fixedInApp === true,
      refreshRow: r.refreshRow === true,
    });
    byCode.set(r.code, list);
  }
  if (byCode.size === 0) return out;
  const linked = new Set(
    (
      await db.customer.findMany({
        where: { nmwcCode: { in: [...byCode.keys()] }, deletedAt: null, temixCode: { not: null } },
        select: { nmwcCode: true },
      })
    ).map((c) => c.nmwcCode)
  );
  for (const t of targets) {
    const hit = supersedingUpload(t, linked.has(t.code), byCode.get(t.code) ?? []);
    if (hit) out.set(t.key, hit);
  }
  return out;
}

/** A row's fix target: its customer code and its branch code composed under it. */
export function fixTarget(key: string, code: string, branchCell: string | null): FixTarget {
  return { key, code, branch: branchCell ? composeBranchCode(code, branchCell) : null };
}
