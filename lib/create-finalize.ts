/**
 * Finalize a net-new-customer CREATE request — the FINAL (Accountant) approval
 * hook. Runs INSIDE approveEditCore's transaction, after the atomic
 * SUBMITTED→APPROVED claim succeeded, and materializes the typed drafts into
 * real Customer + Branch rows in the same all-or-nothing unit:
 *
 *   1. exact-duplicate re-check vs LIVE customers (advisory-locked per CR) —
 *      a colliding customer may have appeared during the multi-day chain;
 *   2. photo liveness re-check (EL-04 class): every referenced attachment must
 *      still exist, be un-deleted, and belong to this edit;
 *   3. provisional code allocation NMWC-YYYY-NNNNNN via the atomic
 *      CodeSequence counter (scope `CUSTOMER-<year>`) — allocated at FINALIZE,
 *      never at submit, so no codes burn on rejected/abandoned requests;
 *   4. Customer + Branch creation (region re-derived from the route's CURRENT
 *      region so the B-19 consistency trigger can never fire on stale data);
 *   5. binding the unbound attachments to their real slots (editId kept for
 *      provenance);
 *   6. completeness scoring, edit→customer linkage, FINALIZE/CREATE audit.
 *
 * Owner-confirmed: finalize copies the REQUESTED credit figures verbatim
 * (FM/GM approve or reject, never amend) and sets temixSyncState =
 * PENDING_UPLOAD for the Steward's next Temix batch.
 */
import {
  CustomerStatus,
  EditProcess,
  EditState,
  TemixSyncState,
  type EditBranchDraft,
  type EditCustomerDraft,
  type Prisma,
} from '@prisma/client';
import { ConflictError } from './errors';
import { formatCustomerCode, formatBranchCode } from './codes';
import { scoreBranch, scoreCustomer } from './completeness';
import { lockCreateIdentity, assertNoExactCreateDuplicate } from './create-guards';

type Tx = Prisma.TransactionClient;

export type FinalizableEdit = {
  id: string;
  submittedById: string;
  cycle: number;
  requestedCreditLimit: Prisma.Decimal | null;
  requestedPaymentTermDays: number | null;
  customerDraft: EditCustomerDraft;
  branchDrafts: EditBranchDraft[];
};

/** string[] stored as Json on the draft row. */
function extraIds(draft: EditBranchDraft): string[] {
  return Array.isArray(draft.extraPhotoAttachmentIds)
    ? (draft.extraPhotoAttachmentIds as string[])
    : [];
}

/**
 * Allocate the next provisional customer code for `year`. Atomic: the upsert
 * is a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement, so two
 * concurrent finalizes get distinct sequence numbers. The returned `next` is
 * the counter AFTER the bump, so the allocated seq is `next - 1`.
 *
 * Import-promoted customers carry raw Temix codes under the same unique index;
 * a formatted NMWC-YYYY-NNNNNN colliding with one is practically impossible
 * but we pre-check and skip forward defensively (bounded), with the unique
 * index as the final backstop.
 */
async function allocateCustomerCode(tx: Tx, year: number): Promise<string> {
  const scope = `CUSTOMER-${year}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rows = await tx.$queryRaw<Array<{ next: number }>>`
      INSERT INTO "CodeSequence" ("scope", "next") VALUES (${scope}, 2)
      ON CONFLICT ("scope") DO UPDATE SET "next" = "CodeSequence"."next" + 1
      RETURNING "next"`;
    const seq = Number(rows[0]!.next) - 1;
    const code = formatCustomerCode(year, seq);
    const taken = await tx.customer.findUnique({ where: { nmwcCode: code }, select: { id: true } });
    if (!taken) return code;
    // Collision => the counter is BEHIND pre-existing NMWC-YYYY-formatted codes.
    // That happens whenever formatted codes entered the table WITHOUT going
    // through this counter: a DB restore, a migration backfill, a manual insert,
    // or a seed that wrote NMWC-YYYY codes directly. A fixed number of +1 steps
    // would never catch up and net-new customer creation would be permanently
    // bricked (CODE_ALLOCATION_FAILED forever). Self-heal instead: fast-forward
    // the counter PAST the highest existing code for this year, then retry.
    // GREATEST() keeps the counter monotonic under a concurrent bump so two
    // finalizes racing the recovery still get distinct sequence numbers.
    const maxRows = await tx.$queryRaw<Array<{ maxseq: number | null }>>`
      SELECT MAX(CAST(SPLIT_PART("nmwcCode", '-', 3) AS INTEGER)) AS maxseq
      FROM "Customer"
      WHERE "nmwcCode" LIKE ${`NMWC-${year}-%`}`;
    const maxSeq = Number(maxRows[0]?.maxseq ?? 0);
    await tx.$executeRaw`
      INSERT INTO "CodeSequence" ("scope", "next") VALUES (${scope}, ${maxSeq + 1})
      ON CONFLICT ("scope") DO UPDATE SET "next" = GREATEST("CodeSequence"."next", ${maxSeq + 1})`;
  }
  throw new ConflictError(
    'CODE_ALLOCATION_FAILED',
    'Could not allocate a free customer code. Try again.'
  );
}

export async function finalizeCreateInTx(
  tx: Tx,
  edit: FinalizableEdit,
  actorId: string,
  finalizedAt: Date
): Promise<{ customerId: string; nmwcCode: string; legalName: string }> {
  const draft = edit.customerDraft;
  const isCredit = draft.paymentTerms === 'CREDIT';

  // 1. Region re-derivation FIRST: the B-19 trigger enforces Branch.regionId
  //    === Route.regionId at insert time, so the branches will materialize in
  //    the route's CURRENT region — and the duplicate re-check + identity
  //    locks below must therefore run against those same CURRENT regions, not
  //    the draft values frozen at submit (a route can be re-regioned by a
  //    Steward import mid-chain; checking the stale region would let a
  //    same-name+phone duplicate materialize in the new region).
  const routeIds = [...new Set(edit.branchDrafts.map((b) => b.routeId))];
  const routes = await tx.route.findMany({
    where: { id: { in: routeIds } },
    select: { id: true, regionId: true },
  });
  const routeById = new Map(routes.map((r) => [r.id, r]));
  for (const b of edit.branchDrafts) {
    if (!routeById.has(b.routeId)) {
      throw new ConflictError(
        'ROUTE_GONE',
        'The branch route no longer exists. Reject the request so the routing can be fixed.'
      );
    }
  }
  const currentRegionIds = [...new Set(routes.map((r) => r.regionId))];

  // 2. Duplicate re-check vs live customers, serialized on the full identity
  //    surface (CR + name/phone/region triple) — a colliding customer may
  //    have appeared during the multi-day chain, including via a concurrent
  //    finalize of a different-CR request for the same shop.
  await lockCreateIdentity(tx, {
    crNumberNorm: draft.crNumberNorm,
    legalName: draft.legalName,
    primaryPhoneNorm: draft.primaryPhoneNorm,
    regionIds: currentRegionIds,
  });
  await assertNoExactCreateDuplicate(tx, {
    crNumberNorm: draft.crNumberNorm,
    legalName: draft.legalName,
    primaryPhoneNorm: draft.primaryPhoneNorm,
    regionIds: currentRegionIds,
    excludeEditId: edit.id,
    includeOpenRequests: false,
  });

  // 3. Photo liveness pre-check. The submit gate proved these existed; a
  //    detach between submit and finalize must fail the approval with an
  //    actionable message, not materialize a customer missing mandatory docs.
  //    (This SELECT is advisory UX — the binds in step 6 re-assert liveness
  //    atomically via guarded updateMany, closing the TOCTOU window against a
  //    concurrent detach.)
  const referencedIds = [
    ...(draft.crPhotoAttachmentId ? [draft.crPhotoAttachmentId] : []),
    ...edit.branchDrafts.flatMap((b) => [
      ...(b.shopPhotoAttachmentId ? [b.shopPhotoAttachmentId] : []),
      ...(b.signboardPhotoAttachmentId ? [b.signboardPhotoAttachmentId] : []),
      ...extraIds(b),
    ]),
  ];
  const guarantees = await tx.attachment.findMany({
    where: { editId: edit.id, kind: 'GUARANTEE', deletedAt: null },
    select: { id: true },
  });
  const liveReferenced = referencedIds.length
    ? await tx.attachment.findMany({
        where: { id: { in: referencedIds }, deletedAt: null, editId: edit.id },
        select: { id: true },
      })
    : [];
  if (liveReferenced.length !== referencedIds.length) {
    throw new ConflictError(
      'NEEDS_REUPLOAD',
      'A required photo on this request was removed after submission. Reject the request so the salesman can re-capture it.'
    );
  }
  if (isCredit && guarantees.length === 0) {
    throw new ConflictError(
      'NEEDS_REUPLOAD',
      'The guarantee document was removed after submission. Reject the request so the salesman can re-attach it.'
    );
  }

  // 4. Code + Customer.
  const nmwcCode = await allocateCustomerCode(tx, finalizedAt.getFullYear());
  const customer = await tx.customer.create({
    data: {
      nmwcCode,
      legalName: draft.legalName,
      paymentTerms: draft.paymentTerms,
      crNumber: draft.crNumber,
      crNumberNorm: draft.crNumberNorm,
      channelId: draft.channelId,
      subChannelId: draft.subChannelId,
      primaryPhone: draft.primaryPhone,
      primaryPhoneNorm: draft.primaryPhoneNorm,
      altPhone: draft.altPhone,
      contactPerson: draft.contactPerson,
      contactRole: draft.contactRole,
      notes: draft.notes,
      status: CustomerStatus.ACTIVE,
      // No amendment: the approved figures ARE the requested figures.
      creditLimit: isCredit ? edit.requestedCreditLimit : null,
      paymentTermDays: isCredit ? edit.requestedPaymentTermDays : null,
      // Real ERP code arrives via the inbound Temix refresh after upload.
      temixCode: null,
      temixSyncState: TemixSyncState.PENDING_UPLOAD,
      temixSyncPendingSince: finalizedAt,
      createdById: edit.submittedById,
      lastEditedById: actorId,
    },
  });

  // 5. Branches (codes are parent-derived ordinals: NMWC-YYYY-NNNNNN-01, -02…).
  const branches: Array<{ id: string; draft: EditBranchDraft }> = [];
  for (let i = 0; i < edit.branchDrafts.length; i += 1) {
    const b = edit.branchDrafts[i]!;
    const branch = await tx.branch.create({
      data: {
        customerId: customer.id,
        branchCode: formatBranchCode(nmwcCode, i + 1),
        branchName: b.branchName,
        regionId: routeById.get(b.routeId)!.regionId,
        routeId: b.routeId,
        address: b.address,
        areaDescription: b.areaDescription,
        gpsLat: b.gpsLat,
        gpsLng: b.gpsLng,
        gpsAccuracy: b.gpsAccuracy,
        gpsCapturedAt: b.gpsCapturedAt,
        dayOfVisit: b.dayOfVisit,
        openingHours: b.openingHours,
        deliveryWindow: b.deliveryWindow,
        coolersCount: b.coolersCount,
        standsCount: b.standsCount,
        emptyBottlesCount: b.emptyBottlesCount,
        status: CustomerStatus.ACTIVE,
        createdById: edit.submittedById,
        lastEditedById: actorId,
      },
    });
    branches.push({ id: branch.id, draft: b });
  }

  // 6. Bind photos to their real slots. editId stays set for provenance
  //    (which create-request produced this photo). Every bind is a GUARDED
  //    updateMany re-asserting {live, claimed by this edit, still unwired} —
  //    the step-3 SELECT does not lock, so a concurrent detachPhoto could
  //    soft-delete a photo between the check and here; a guarded bind then
  //    matches 0 rows and we fail the approval instead of materializing a
  //    customer whose mandatory photo is already deleted (TOCTOU,
  //    adversarial-review finding).
  const bindOne = async (
    attachmentId: string,
    // Unchecked variant: branchExtraId is a relation-backed FK scalar.
    data: Prisma.AttachmentUncheckedUpdateManyInput
  ) => {
    const bound = await tx.attachment.updateMany({
      where: {
        id: attachmentId,
        deletedAt: null,
        editId: edit.id,
        customerId: null,
        branchId: null,
        branchExtraId: null,
      },
      data,
    });
    if (bound.count !== 1) {
      throw new ConflictError(
        'NEEDS_REUPLOAD',
        'A required photo on this request was removed while it was being approved. Reject the request so the salesman can re-capture it.'
      );
    }
  };
  if (draft.crPhotoAttachmentId) {
    await bindOne(draft.crPhotoAttachmentId, { customerId: customer.id });
    await tx.customer.update({
      where: { id: customer.id },
      data: { crPhotoId: draft.crPhotoAttachmentId },
    });
  }
  for (const g of guarantees) {
    await bindOne(g.id, { customerId: customer.id });
  }
  for (const { id: branchId, draft: b } of branches) {
    if (b.shopPhotoAttachmentId) {
      await bindOne(b.shopPhotoAttachmentId, { branchId });
      await tx.branch.update({
        where: { id: branchId },
        data: { shopPhotoId: b.shopPhotoAttachmentId },
      });
    }
    if (b.signboardPhotoAttachmentId) {
      await bindOne(b.signboardPhotoAttachmentId, { branchId });
      await tx.branch.update({
        where: { id: branchId },
        data: { signboardPhotoId: b.signboardPhotoAttachmentId },
      });
    }
    for (const extraId of extraIds(b)) {
      await bindOne(extraId, { branchId, branchExtraId: branchId });
    }
  }

  // 7. Completeness — computed from the in-memory materialized shapes (the
  //    photo-slot columns were just written above).
  const branchShapes = branches.map(({ draft: b }) => ({
    gpsLat: b.gpsLat,
    gpsLng: b.gpsLng,
    address: b.address,
    shopPhotoId: b.shopPhotoAttachmentId,
    signboardPhotoId: b.signboardPhotoAttachmentId,
    dayOfVisit: b.dayOfVisit,
    coolersCount: b.coolersCount,
    standsCount: b.standsCount,
    emptyBottlesCount: b.emptyBottlesCount,
    openingHours: b.openingHours,
    deliveryWindow: b.deliveryWindow,
    status: CustomerStatus.ACTIVE,
  }));
  const branchScores = branchShapes.map(scoreBranch);
  const customerScore = scoreCustomer(
    {
      channelId: draft.channelId,
      subChannelId: draft.subChannelId,
      primaryPhone: draft.primaryPhone,
      contactPerson: draft.contactPerson,
      crNumber: draft.crNumber,
      crPhotoId: draft.crPhotoAttachmentId,
      paymentTerms: draft.paymentTerms,
      notes: draft.notes,
    },
    branchShapes
  );
  await tx.customer.update({
    where: { id: customer.id },
    data: { completenessScore: customerScore },
  });
  for (let i = 0; i < branches.length; i += 1) {
    await tx.branch.update({
      where: { id: branches[i]!.id },
      data: { completenessScore: branchScores[i]! },
    });
  }

  // 8. Link the request to its materialized customer + audit trail.
  await tx.customerEdit.update({
    where: { id: edit.id },
    data: { customerId: customer.id },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      action: 'FINALIZE',
      entityType: 'CustomerEdit',
      entityId: edit.id,
      after: {
        customerId: customer.id,
        nmwcCode,
        branches: branches.length,
        paymentTerms: draft.paymentTerms,
        cycle: edit.cycle,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      action: 'CREATE',
      entityType: 'Customer',
      entityId: customer.id,
      after: {
        nmwcCode,
        legalName: draft.legalName,
        paymentTerms: draft.paymentTerms,
        branches: branches.length,
        viaEditId: edit.id,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return { customerId: customer.id, nmwcCode, legalName: draft.legalName };
}

/** Narrow re-export so approveEditCore can assert the edit shape it loaded. */
export function assertFinalizable(edit: {
  process: EditProcess;
  state: EditState;
  customerDraft: EditCustomerDraft | null;
  branchDrafts: EditBranchDraft[];
}): asserts edit is typeof edit & {
  customerDraft: EditCustomerDraft;
} {
  if (edit.process !== EditProcess.CREATE) {
    throw new ConflictError('NOT_CREATE', 'Not a create request.');
  }
  if (!edit.customerDraft || edit.branchDrafts.length === 0) {
    throw new ConflictError(
      'DRAFT_MISSING',
      'This create request has no draft payload — it cannot be finalized.'
    );
  }
}
