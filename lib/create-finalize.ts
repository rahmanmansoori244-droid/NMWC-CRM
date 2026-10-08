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
 *
 * Owner decision 2026-10-08: the Accountant creates the customer in Temix
 * before he approves and types the Temix code it got (lib/temix-code.ts). The
 * customer is created with that code, refused if any other customer holds it
 * (an archived one included) or it is a live branch's code, and stays
 * PENDING_UPLOAD: the next batch sends the full record (branches,
 * GPS, phones) as an UPSERT keyed by that temix_code — an update of the Temix
 * record he made, not a second one (lib/temix.ts buildTemixRows).
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
import { AppError, ConflictError } from './errors';
import { formatCustomerCode, formatBranchCode } from './codes';
import { omanYear } from './tz';
import { draftScores } from './create-score';
import { lockCreateIdentity, assertNoExactCreateDuplicate } from './create-guards';
import { writeAudit, type AuditEnvelope } from './audit';
import { UNWIRED_LIVE } from './photo-attach';
import { lockTemixCode, temixCodeHolder, temixCodeHolderMessage } from './temix-code';

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

/**
 * DG-06 — the actor arrives as a full `AuditEnvelope`, not a bare id. This
 * function runs INSIDE approveEditCore's interactive transaction, so it must
 * not build its own envelope: the envelope reader degrades to null ip/userAgent
 * rather than throwing, which would leave the FINALIZE and CREATE rows — the
 * two rows that prove a customer went live — quietly unattributed, with nothing
 * at runtime to complain. approveEditCore builds it before opening the
 * transaction and hands it down. `env.actorId` is the approving Accountant and
 * replaces the old `actorId` parameter.
 *
 * `temixCode` is the code the Accountant typed, already normalized and checked
 * for shape by the caller (services/edits.ts, lib/temix-code.ts).
 */
export async function finalizeCreateInTx(
  tx: Tx,
  edit: FinalizableEdit,
  env: AuditEnvelope,
  finalizedAt: Date,
  temixCode: string
): Promise<{ customerId: string; nmwcCode: string; legalName: string; temixCode: string }> {
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
  // Launch fix (wording): a reject steps back one approver, not "down the
  // chain to the salesman" (lib/approval-chains.ts resolveRejectTarget).
  if (liveReferenced.length !== referencedIds.length) {
    throw new ConflictError(
      'NEEDS_REUPLOAD',
      `A required photo on this request was removed after it was sent, so it cannot be approved. ${STEP_BACK_FOR_PHOTO}`
    );
  }
  if (isCredit && guarantees.length === 0) {
    throw new ConflictError(
      'NEEDS_REUPLOAD',
      'The guarantee document was removed after it was sent, so it cannot be approved. Reject it and say the guarantee is missing. It goes back one approver at a time; once it reaches the salesman, he can attach it again.'
    );
  }

  // 3b. Owner decision 2026-10-08: the Temix code is this customer's alone.
  //     After the photo checks, which no code typed here can fix. Locked first,
  //     so two finalizes typing the same code (or a finalize and an import
  //     recording it, services/imports.ts) cannot both pass the check. An
  //     archived customer's code is refused as the customer import refuses it:
  //     given to this customer, every inbound refresh of it would be rejected.
  await lockTemixCode(tx, temixCode);
  const holder = await temixCodeHolder(tx, temixCode);
  if (holder) {
    const message = temixCodeHolderMessage(temixCode, holder);
    throw new AppError('TEMIX_CODE_TAKEN', message, 409, { temixCode: message });
  }

  // 4. Code + Customer.
  // final-hunt #27/#36: derive the NMWC-YYYY year (and its CodeSequence scope)
  // from the Oman wall-clock, not raw UTC — otherwise a customer minted in the
  // 00:00-03:59 Oman window on Jan 1 gets the prior year's code prefix.
  const nmwcCode = await allocateCustomerCode(tx, omanYear(finalizedAt));
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
      // Owner decision 2026-10-08: the code the Accountant created it under in
      // Temix. Still queued: the next batch updates that record with all of it.
      temixCode,
      temixSyncState: TemixSyncState.PENDING_UPLOAD,
      temixSyncPendingSince: finalizedAt,
      createdById: edit.submittedById,
      lastEditedById: env.actorId,
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
        lastEditedById: env.actorId,
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
        ...UNWIRED_LIVE,
        editId: edit.id,
      },
      data,
    });
    if (bound.count !== 1) {
      throw new ConflictError(
        'NEEDS_REUPLOAD',
        `A required photo on this request was removed while it was being approved. ${STEP_BACK_FOR_PHOTO}`
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

  // 7. Completeness — computed from the drafts as they were just materialized
  //    (lib/create-score.ts; the approval queue rings show the same figure).
  const { customer: customerScore, branches: branchScores } = draftScores(
    draft,
    branches.map(({ draft: b }) => b)
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
  await writeAudit(tx, env, {
    action: 'FINALIZE',
    entityType: 'CustomerEdit',
    entityId: edit.id,
    after: {
      customerId: customer.id,
      nmwcCode,
      temixCode,
      branches: branches.length,
      paymentTerms: draft.paymentTerms,
      cycle: edit.cycle,
    } as unknown as Prisma.InputJsonValue,
  });
  await writeAudit(tx, env, {
    action: 'CREATE',
    entityType: 'Customer',
    entityId: customer.id,
    after: {
      nmwcCode,
      temixCode,
      legalName: draft.legalName,
      paymentTerms: draft.paymentTerms,
      branches: branches.length,
      viaEditId: edit.id,
    } as unknown as Prisma.InputJsonValue,
  });

  return { customerId: customer.id, nmwcCode, legalName: draft.legalName, temixCode };
}

/** What an approver at a later step does about a photo removed after the request was sent. */
const STEP_BACK_FOR_PHOTO =
  'Reject it and say which photo is missing. It goes back one approver at a time; once it reaches the salesman, he can take the photo again.';

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
