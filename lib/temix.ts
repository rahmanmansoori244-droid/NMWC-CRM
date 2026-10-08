/**
 * Temix (ERP) batch-sync helpers — Phase 1 Temix increment.
 *
 * The CRM aids Temix, never replaces it (owner-locked): approved master data
 * queues per-customer (temixSyncState) and a Steward carries it to Temix as an
 * Excel workbook. There is NO live API in v1 — the contract is
 * at-least-once-with-dedup: Temix upserts on the customer code, so re-sending
 * an unchanged row is a no-op, and every batch is regenerable from its
 * TemixSyncBatch.customerIds snapshot.
 *
 * Pure decision logic + row shaping live here (unit-tested); the Steward
 * actions live in services/temix.ts.
 */
import { PaymentTerms, TemixSyncState, type Prisma } from '@prisma/client';

/**
 * The outbound queue. Two lanes:
 *  - PENDING_UPLOAD, live rows only — approved creates/corrections;
 *  - DEACTIVATE_PENDING, deletedAt DELIBERATELY IGNORED: deactivation rows are
 *    by definition soft-deleted. This is the documented exception to the
 *    codebase-wide `deletedAt: null` convention (data-model.md §8) — copying
 *    the usual filter here would silently drop every deactivation forever.
 */
export const TEMIX_QUEUE_WHERE: Prisma.CustomerWhereInput = {
  OR: [
    { temixSyncState: TemixSyncState.PENDING_UPLOAD, deletedAt: null },
    { temixSyncState: TemixSyncState.DEACTIVATE_PENDING },
  ],
};

export type TemixExportCustomer = {
  id: string;
  nmwcCode: string;
  temixCode: string | null;
  legalName: string;
  paymentTerms: PaymentTerms;
  creditLimit: Prisma.Decimal | null;
  paymentTermDays: number | null;
  crNumber: string | null;
  primaryPhone: string | null;
  altPhone: string | null;
  contactPerson: string | null;
  deletedAt: Date | null;
  channel: { label: string } | null;
  subChannel: { label: string } | null;
  branches: Array<{
    branchCode: string;
    branchName: string;
    address: string;
    dayOfVisit: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    deletedAt: Date | null;
    region: { name: string; code: string };
    route: { code: string };
  }>;
  /** live GUARANTEE attachment count (docs cannot ride an Excel row — Q-guarantee-transfer). */
  guaranteeDocs: number;
};

export type TemixExportRow = Record<string, string | number>;

/**
 * Shape the workbook rows for one batch.
 *
 * - UPSERT lane (live customers): one row per LIVE branch, mirroring the
 *   existing customer-master export contract so the sheet stays re-importable
 *   (services/exports.ts columns) + the sync columns. A row with a
 *   `temix_code` updates that Temix record. Since owner decision 2026-10-08 a
 *   new customer has one from its last approval: the Accountant created it in
 *   Temix and typed the code (lib/create-finalize.ts), so its first row here
 *   fills in the record he made rather than creating a second one. `temix_code`
 *   blank = "create in Temix", as before, for a customer with no Temix code on
 *   record (created in the app before that decision, or imported without one);
 *   for one created in the app, the inbound refresh records the code Temix
 *   assigns (services/imports.ts, the backup match).
 * - DEACTIVATE lane (soft-deleted customers): one row per CUSTOMER with blank
 *   branch fields — Temix only needs the code + the action.
 *
 * NOTE (Q-temix-headers, open): the exact header row Temix's importer accepts
 * is still unconfirmed — these are the CRM's export-contract names; remap
 * once the owner supplies the authoritative Temix template.
 */
export function buildTemixRows(
  customers: TemixExportCustomer[],
  batchId: string
): TemixExportRow[] {
  const rows: TemixExportRow[] = [];
  for (const c of customers) {
    const action = c.deletedAt ? 'DEACTIVATE' : 'UPSERT';
    const isCredit = c.paymentTerms === PaymentTerms.CREDIT;
    const base: TemixExportRow = {
      sync_action: action,
      sync_batch_id: batchId,
      temix_code: c.temixCode ?? '',
      cust_code: c.nmwcCode,
      cust_name: c.legalName,
      payment_terms: c.paymentTerms,
      credit_limit: isCredit && c.creditLimit != null ? Number(c.creditLimit) : '',
      payment_term_days: isCredit && c.paymentTermDays != null ? c.paymentTermDays : '',
      cr_no: c.crNumber ?? '',
      guarantee_docs: isCredit ? c.guaranteeDocs : '',
      phone: c.primaryPhone ?? '',
      alt_phone: c.altPhone ?? '',
      contact_person: c.contactPerson ?? '',
      channel: c.channel?.label ?? '',
      sub_channel: c.subChannel?.label ?? '',
    };
    if (action === 'DEACTIVATE') {
      rows.push({
        ...base,
        branch_code: '',
        branch_name: '',
        sales_region: '',
        region_code: '',
        route: '',
        address: '',
        day_of_visit: '',
        gps_lat: '',
        gps_lng: '',
      });
      continue;
    }
    const liveBranches = c.branches.filter((b) => !b.deletedAt);
    for (const b of liveBranches) {
      rows.push({
        ...base,
        branch_code: b.branchCode,
        branch_name: b.branchName,
        sales_region: b.region.name,
        region_code: b.region.code,
        route: b.route.code,
        address: b.address,
        day_of_visit: b.dayOfVisit ?? '',
        gps_lat: b.gpsLat ?? '',
        gps_lng: b.gpsLng ?? '',
      });
    }
    if (liveBranches.length === 0) {
      // A live customer with no live branches still needs its master row.
      rows.push({
        ...base,
        branch_code: '',
        branch_name: '',
        sales_region: '',
        region_code: '',
        route: '',
        address: '',
        day_of_visit: '',
        gps_lat: '',
        gps_lng: '',
      });
    }
  }
  return rows;
}

type ArchiveTemixFacts = {
  temixCode: string | null;
  lastTemixUploadAt: Date | null;
  temixSyncState: TemixSyncState;
};

function knownToTemix(customer: ArchiveTemixFacts): boolean {
  return (
    customer.temixCode != null ||
    customer.lastTemixUploadAt != null ||
    customer.temixSyncState === TemixSyncState.SYNCED ||
    customer.temixSyncState === TemixSyncState.UPLOADED
  );
}

/**
 * Temix state for a customer being archived (C8 soft-delete) or merged away.
 *
 * DEACTIVATE_PENDING only makes sense when Temix has (or may have) heard of
 * the customer: it carries a temixCode, was ever in an upload batch, or is a
 * migrated/refreshed row (SYNCED). A never-uploaded CRM-born customer
 * (PENDING_UPLOAD, no code, never batched) simply leaves the queue — Temix
 * has nothing to deactivate — so it parks as SYNCED (nothing to do).
 *
 * It does not know whether another live customer holds the same Temix code, so
 * no caller asks it alone: archive and merge ask liveTemixCodeHolders first (F11).
 */
export function resolveArchiveTemixState(customer: ArchiveTemixFacts): TemixSyncState {
  return knownToTemix(customer) ? TemixSyncState.DEACTIVATE_PENDING : TemixSyncState.SYNCED;
}

/**
 * F11: the code that archiving or merging `customer` away would deactivate in
 * Temix (deactivationCode: its customer code when it has no Temix code, the code
 * Generate holds such a row back against), or null when it deactivates nothing
 * because Temix never heard of it. Archive and merge ask liveTemixCodeHolders
 * about this code. Asked about the Temix code alone, an uncoded customer known to
 * Temix whose customer code a live customer holds as its Temix code was queued
 * for a deactivation that Generate then held back, and named, on every run for
 * good (review of 8cb2509).
 */
export function archiveDeactivationCode(
  customer: ArchiveTemixFacts & { nmwcCode: string }
): string | null {
  return knownToTemix(customer) ? deactivationCode(customer) : null;
}

/**
 * F11: the archived customers with no Temix code whose deactivation goes out, or
 * went out, keyed on `code` as their customer code (deactivationCode). Temix
 * knows them: the deactivation is queued (DEACTIVATE_PENDING) or in a batch
 * (UPLOADED), or they were in an upload batch. knownToTemix is not asked: after
 * the archive, a seeded customer that was never uploaded is DEACTIVATE_PENDING,
 * and SYNCED means one parked because a live customer held the code, or one
 * Temix never heard of. The customer import refuses to give a live customer
 * such a code as its Temix code (services/imports.ts), as it refuses one another
 * customer holds as its Temix code.
 */
export function archivedUncodedDeactivationWhere(code: string): Prisma.CustomerWhereInput {
  return {
    nmwcCode: code,
    temixCode: null,
    deletedAt: { not: null },
    OR: [
      { temixSyncState: { in: [TemixSyncState.DEACTIVATE_PENDING, TemixSyncState.UPLOADED] } },
      { lastTemixUploadAt: { not: null } },
    ],
  };
}

/**
 * F11: what a merge must do about the loser's Temix identity, given the winner's.
 * Customer.temixCode is not unique, so two CRM rows for one ERP customer can
 * carry the same code, and resolveArchiveTemixState alone queued the loser for
 * deactivation — the next batch then held `UPSERT T1` for the winner and
 * `DEACTIVATE T1` for the loser, and which one Temix applied last depended on
 * the nmwcCode sort.
 *  - 'SHARED_CODE': the loser's code IS the winner's. Nothing is to be
 *    deactivated — the identity survives in the winner — so the loser leaves
 *    the queue (SYNCED) instead. The merge acts on this through
 *    liveTemixCodeHolders, which also finds a third live customer holding it.
 *  - 'CROSSED': one side's Temix code is the other side's customer code. A blank
 *    or deactivated code may be keyed on cust_code in Temix, so the merge could
 *    still reach the winner's identity: refused for Steward review.
 *  - null: nothing shared; resolveArchiveTemixState decides as before.
 */
export type MergeTemixIdentity = { nmwcCode: string; temixCode: string | null };

export function mergeTemixClash(
  loser: MergeTemixIdentity,
  winner: MergeTemixIdentity
): 'SHARED_CODE' | 'CROSSED' | null {
  if (loser.temixCode && loser.temixCode === winner.temixCode) return 'SHARED_CODE';
  if (
    (loser.temixCode && loser.temixCode === winner.nmwcCode) ||
    (winner.temixCode && winner.temixCode === loser.nmwcCode)
  ) {
    return 'CROSSED';
  }
  return null;
}

/**
 * F11, for every path that takes a customer out of the master (archive, merge):
 * the customer codes of the OTHER live customers that still hold `temixCode` as
 * their Temix code; both pass archiveDeactivationCode, the code leaving would
 * deactivate. Deactivating that code would take the ERP identity away from them,
 * so a customer leaving while this is non-empty is parked SYNCED instead of
 * queued for deactivation, and its audit row says so ('skipped-shared-code').
 * The last live holder to leave is the one that deactivates the code. Read
 * through the caller's transaction, after lib/locks.ts
 * lockCustomersAndTemixCodeHolders.
 */
export async function liveTemixCodeHolders(
  tx: Prisma.TransactionClient,
  temixCode: string | null,
  exceptId: string
): Promise<string[]> {
  if (!temixCode) return [];
  const rows = await tx.customer.findMany({
    where: { temixCode, deletedAt: null, id: { not: exceptId } },
    select: { nmwcCode: true },
    orderBy: { nmwcCode: 'asc' },
    take: 10,
  });
  return rows.map((r) => r.nmwcCode);
}

/**
 * F11: the code a DEACTIVATE row takes away in Temix. buildTemixRows sends
 * temix_code = the Temix code and cust_code = the customer code; a row with no
 * Temix code goes out keyed on its customer code alone, and migrated rows carry
 * nmwcCode == temixCode (schema.prisma), so that is the code it reaches.
 */
export function deactivationCode(c: { nmwcCode: string; temixCode: string | null }): string {
  return c.temixCode || c.nmwcCode;
}

/**
 * F11, the batch-level invariant, for any writer and any data already stored:
 * the codes that the DEACTIVATE lane of `customers` (archived rows, as
 * buildTemixRows decides the lane) would take away (deactivationCode) while a
 * live customer still holds the same Temix code (`liveCodes`). Deactivating one
 * of them would take the ERP identity away from a customer the CRM keeps. The
 * batch holds back those archived rows only — the live holder's own upload still
 * goes out — rather than refusing the whole batch, which would stop every other
 * customer's upload.
 */
export function deactivationsOfLiveCodes(
  customers: ReadonlyArray<{ nmwcCode: string; temixCode: string | null; deletedAt: Date | null }>,
  liveCodes: ReadonlySet<string>
): string[] {
  const out = new Set<string>();
  for (const c of customers) {
    if (c.deletedAt && liveCodes.has(deactivationCode(c))) out.add(deactivationCode(c));
  }
  return [...out].sort();
}
