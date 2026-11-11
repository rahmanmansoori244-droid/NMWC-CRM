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
import type { BatchLoadHistory, NewerLoad } from '@/lib/import-batch-guard';

/**
 * Owner's answer 2026-11-11 (A5): the codes of every shop (archived ones too) of
 * the customers a sheet names, by customer code, so a row whose branch_code
 * only LOOKS like one of them is held back (lib/import-shop-code.ts). Shared by
 * the upload and the Steward's in-app fix, like the phone and CR maps above.
 * Read in chunks, well under PostgreSQL's bind-parameter limit.
 */
export async function masterShopCodes(
  custCodes: string[],
  db: Pick<Prisma.TransactionClient, 'branch'> = prisma
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const codes = [...new Set(custCodes.filter(Boolean))];
  for (let i = 0; i < codes.length; i += 2000) {
    const found = await db.branch.findMany({
      where: { customer: { nmwcCode: { in: codes.slice(i, i + 2000) } } },
      select: { branchCode: true, customer: { select: { nmwcCode: true } } },
    });
    for (const b of found ?? []) {
      const a = out.get(b.customer.nmwcCode) ?? [];
      a.push(b.branchCode);
      out.set(b.customer.nmwcCode, a);
    }
  }
  return out;
}

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
 * Of these customer codes, the ones that are live customers with a Temix code
 * on record — "linked to Temix". The upload asks before it stages a sheet that
 * has no temix_code column (code review 2026-11-10, finding 1): for such a
 * customer the row could not be told from a plain re-load, and its credit cells
 * would be ignored. Matched exactly, as the promote's lock finds a customer.
 */
export async function linkedCustomerCodes(codes: string[]): Promise<string[]> {
  const out: string[] = [];
  const CHUNK = 5000;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const found = await prisma.customer.findMany({
      where: {
        nmwcCode: { in: codes.slice(i, i + CHUNK) },
        deletedAt: null,
        AND: [{ temixCode: { not: null } }, { temixCode: { not: '' } }],
      },
      select: { nmwcCode: true },
    });
    out.push(...found.map((c) => c.nmwcCode));
  }
  return out.sort();
}

/**
 * A row whose fix a newer upload may rule out: `key` names it in the answer.
 * `fixed`: the row is (or is being) fixed in the app itself, so for a
 * customer linked to Temix it loads branch only; a row a fix only brought back
 * with it loads as the plain row it is.
 */
export type FixTarget = { key: string; code: string; branch: string | null; fixed: boolean };

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
           -- The refresh lane is decided for the customer's rows of one upload
           -- together (from its first plain row), so a row counts as a refresh
           -- row only when every row of the customer in that upload carries the
           -- customer's own Temix code (pre-merge review), in any case: the
           -- upload now stores it upper case, an older row or batch may not.
           (c."temixCode" IS NOT NULL
             AND b."id" IS DISTINCT FROM c."importBatchId"
             AND bool_and(UPPER(COALESCE(r."parsed"->>'temixCode', '')) = UPPER(c."temixCode"))
                   OVER (PARTITION BY r."batchId", r."parsed"->>'custCode')) AS "refreshRow"
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
    const hit = supersedingUpload(t, linked.has(t.code) && t.fixed, byCode.get(t.code) ?? []);
    if (hit) out.set(t.key, hit);
  }
  return out;
}

/** A row's fix target: its customer code and its branch code composed under it. */
export function fixTarget(
  key: string,
  code: string,
  branchCell: string | null,
  fixed: boolean
): FixTarget {
  return { key, code, branch: branchCell ? composeBranchCode(code, branchCell) : null, fixed };
}

/**
 * Code review 2026-11-10, finding 6: of this batch's rows still to load (CLEAN),
 * the customers a NEWER customer upload has already loaded (a PROMOTED row of
 * the same customer code in a batch uploaded later), with the newest such row.
 * Rows fixed in the app are left out: promote judges them by the newest-upload
 * rule above (newerUploadsCarrying), branch by branch for a customer linked to
 * Temix. Read-only. The newer batches are at most STAGED_BATCH_MAX_AGE_DAYS
 * younger than one that can still be promoted, so their rows are never swept.
 */
export async function newerLoadsOfBatch(
  db: Prisma.TransactionClient | typeof prisma,
  batchId: string,
  uploadedAt: Date
): Promise<NewerLoad[]> {
  const rows = await db.$queryRaw<Array<{ code: string; filename: string; rowNumber: number }>>`
    SELECT DISTINCT ON (r."parsed"->>'custCode')
           r."parsed"->>'custCode' AS "code", b."filename", nr."rowNumber"
      FROM "ImportRow" r
      JOIN "ImportRow" nr
        ON nr."parsed"->>'custCode' = r."parsed"->>'custCode' AND nr."state" = 'PROMOTED'
      JOIN "ImportBatch" b
        ON b."id" = nr."batchId" AND b."kind" = 'CUSTOMER' AND b."id" <> ${batchId}
       AND b."uploadedAt" > ${uploadedAt}
     WHERE r."batchId" = ${batchId} AND r."state" = 'CLEAN'
       AND r."parsed" IS NOT NULL
       AND COALESCE(r."parsed"->>'fixedInApp', 'false') <> 'true'
       AND r."parsed"->'fixedFrom' IS NULL
     ORDER BY r."parsed"->>'custCode', b."uploadedAt" DESC, nr."rowNumber"`;
  return rows.map((r) => ({ code: r.code, filename: r.filename, rowNumber: Number(r.rowNumber) }));
}

/**
 * Code review 2026-11-10, finding 6 (adversarial review): what a customer batch
 * has been through, for the age limit (lib/import-batch-guard.ts
 * stagedLoadExpired). A promote has run over it when it is PROMOTED, or when it
 * has a PROMOTED or REJECTED row (only a promote sets those — the same rule
 * services/import-fixes.ts withdraw uses), or a row fixed back from REJECTED, or
 * a row fixed after a load (`fixedAfterLoad`, set by the fix itself, so a batch
 * whose every row was held back and then fixed still reads as loaded). The
 * sheet's own rows still waiting are its CLEAN rows not fixed in the app.
 * Read-only.
 */
export async function batchLoadHistory(
  db: Prisma.TransactionClient | typeof prisma,
  batch: { id: string; status: string }
): Promise<BatchLoadHistory> {
  const [r] = await db.$queryRaw<Array<{ loaded: boolean; waiting: number }>>`
    SELECT
      EXISTS (
        SELECT 1 FROM "ImportRow"
         WHERE "batchId" = ${batch.id}
           AND ("state" IN ('PROMOTED', 'REJECTED')
                OR "parsed"->'fixedFrom'->>'state' = 'REJECTED'
                OR "parsed"->>'fixedAfterLoad' = 'true')
      ) AS "loaded",
      (SELECT COUNT(*)::int FROM "ImportRow"
        WHERE "batchId" = ${batch.id} AND "state" = 'CLEAN' AND "excludedAt" IS NULL
          AND "parsed" IS NOT NULL
          AND COALESCE("parsed"->>'fixedInApp', 'false') <> 'true'
          AND "parsed"->'fixedFrom' IS NULL) AS "waiting"`;
  return {
    everLoaded: batch.status === 'PROMOTED' || r?.loaded === true,
    uploadedRowsWaiting: Number(r?.waiting ?? 0),
  };
}
