'use server';

/**
 * Phase 1 creation flow — net-new customer CREATE requests.
 *
 * A CREATE request is a CustomerEdit row with process=CREATE and
 * customerId=NULL; the proposed payload lives in typed drafts
 * (EditCustomerDraft 1:1 + EditBranchDraft 1:N) and unbound Attachment rows
 * stamped with editId. Nothing touches the Customer/Branch tables until the
 * FINAL step of the approval chain (Accountant) — see finalizeCreateInTx in
 * lib/create-finalize.ts, called from approveEditCore.
 *
 * Owner-confirmed rules enforced here:
 *  - Salesman only; every branch is forced onto the salesman's own route
 *    (region derived from the route — the client cannot choose either).
 *  - CASH chain SUP→ACC, CREDIT chain SUP→FM→GM→ACC (resolved + frozen at
 *    submit from the draft's paymentTerms).
 *  - Exact-CR duplicates HARD-BLOCK at submit (vs live customers AND other
 *    open CREATE requests), as does the EXACT_TRIPLE
 *    (legalName+phone+region) rule; phone-only matches are advisory/logged.
 *  - NEEDS_CORRECTION resubmits reuse the SAME row and bump `cycle`.
 */
import { prisma } from '@/lib/db';
import type { ZodIssue } from 'zod';
import {
  AttachmentKind,
  EditProcess,
  EditState,
  EditTarget,
  PaymentTerms,
  Role,
  type Prisma,
} from '@prisma/client';
import { auth } from '@/lib/auth';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { normalizePhone } from '@/lib/phone';
import { manualGpsMarker } from '@/lib/gps-manual';
import { normalizeCR } from '@/lib/cr';
import { checkLimit, FORM_LIMIT } from '@/lib/rate-limit';
import { resolveChain, stepDeadline } from '@/lib/approval-chains';
import {
  submitCreateSchema,
  collectMissingForCreate,
  collectAttachmentIds,
  resolveCycleOnSubmit,
  type SubmitCreateInput,
  type ParsedSubmitCreate,
} from '@/lib/validation/create';
import { resolveStepAudience, notifyUsers } from '@/lib/notifications';
import { lockCreateIdentity, assertNoExactCreateDuplicate } from '@/lib/create-guards';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  return session.user;
}

/** Map Zod issues to the create form's error keys (`customer.x`, `branch.<i>.x`, `credit.x`). */
function zodIssuesToFields(issues: ZodIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const p = issue.path;
    if (p[0] === 'branches' && typeof p[1] === 'number') {
      const sub = p.slice(2).join('.');
      // Map schema field names onto the form's rendered error slots.
      const key =
        sub === 'gpsLat' || sub === 'gpsLng' || sub === 'gpsManualReason'
          ? 'gps'
          : sub === 'shopPhotoAttachmentId'
            ? 'shopPhoto'
            : sub === 'signboardPhotoAttachmentId'
              ? 'signboardPhoto'
              : sub;
      fields[`branch.${p[1]}.${key}`] = issue.message;
      continue;
    }
    if (p[0] === 'customer' || p[0] === 'credit') {
      const sub = p.slice(1).join('.');
      const key = sub === 'crPhotoAttachmentId' ? 'crPhoto' : sub;
      fields[`${p[0]}.${key}`] = issue.message;
      continue;
    }
    if (p[0] === 'guaranteeAttachmentIds') {
      fields['guarantee'] = issue.message;
      continue;
    }
    fields[p.join('.') || '_form'] = issue.message;
  }
  return fields;
}

export async function submitCreateAction(
  input: SubmitCreateInput
): SafeAction<{ editId: string; state: EditState }> {
  return runAction(() => submitCreateCore(input));
}

async function submitCreateCore(
  input: SubmitCreateInput
): Promise<{ editId: string; state: EditState }> {
  const session = await requireUser();
  const lim = await checkLimit(`edit:${session.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  // Owner-confirmed: only a Salesman initiates a create request (Steward's
  // lane is the import; Manager/Steward direct-write is UPDATE-only).
  if (session.role !== Role.SALESMAN) {
    throw new ForbiddenError('Only a Salesman can request a new customer.');
  }

  const parsed = submitCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(zodIssuesToFields(parsed.error.issues));
  }
  const data: ParsedSubmitCreate = parsed.data;
  const isDraft = data.isDraft;

  // The salesman's own route decides region + route for EVERY branch draft.
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      id: true,
      supervisorId: true,
      ownedRoute: { select: { id: true, regionId: true, isActive: true } },
    },
  });
  if (!me.ownedRoute) {
    throw new ForbiddenError('You have no route assigned — ask your supervisor.');
  }
  if (!me.ownedRoute.isActive) {
    throw new ForbiddenError('Your route is inactive — ask your supervisor.');
  }
  const route = me.ownedRoute;

  // Normalize contact + CR. Invalid (unnormalizable) phones are rejected even
  // for drafts — storing a phone that normalizePhone(null)s would silently
  // drop it at finalize.
  const c = data.customer;
  let primaryPhoneNorm: string | null = null;
  if (c.primaryPhone !== undefined) {
    primaryPhoneNorm = normalizePhone(c.primaryPhone);
    if (!primaryPhoneNorm) {
      throw new ValidationError({
        'customer.primaryPhone': 'Enter a valid Oman number (8 digits, or +968 XXXXXXXX).',
      });
    }
  }
  let altPhoneNorm: string | null = null;
  if (c.altPhone !== undefined) {
    altPhoneNorm = normalizePhone(c.altPhone);
    if (!altPhoneNorm) {
      throw new ValidationError({
        'customer.altPhone': 'Enter a valid Oman number (8 digits, or +968 XXXXXXXX).',
      });
    }
  }
  const crNumber = c.crNumber ?? null;
  const crNumberNorm = normalizeCR(crNumber);

  // Channel pair sanity: sub-channel must belong to the chosen channel.
  if (c.subChannelId) {
    const sub = await prisma.subChannel.findUnique({
      where: { id: c.subChannelId },
      select: { channelId: true, isActive: true },
    });
    if (!sub || !sub.isActive || !c.channelId || sub.channelId !== c.channelId) {
      throw new ValidationError({
        'customer.subChannelId': 'Sub-channel does not belong to the chosen channel.',
      });
    }
  }

  // Resuming an existing request? Ownership + state gate.
  const existing = data.editId
    ? await prisma.customerEdit.findUnique({
        where: { id: data.editId },
        select: { id: true, process: true, state: true, submittedById: true, cycle: true, submittedAt: true },
      })
    : null;
  if (data.editId) {
    if (!existing || existing.process !== EditProcess.CREATE) {
      throw new NotFoundError('Create request not found.');
    }
    if (existing.submittedById !== session.id) {
      throw new ForbiddenError('This create request belongs to another user.');
    }
    if (existing.state === EditState.SUBMITTED || existing.state === EditState.APPROVED) {
      throw new ConflictError(
        'EDIT_LOCKED',
        existing.state === EditState.SUBMITTED
          ? 'This request is already submitted and in review.'
          : 'This request was already approved.'
      );
    }
    // DRAFT / NEEDS_CORRECTION / REJECTED may all be revised and resubmitted.
  }

  // Mandatory-field gate — submits only; drafts save partial work.
  if (!isDraft) {
    const missing = collectMissingForCreate(data);
    if (Object.keys(missing).length > 0) throw new ValidationError(missing);
  }

  // Referenced attachments: exist, live, captured by me, kind matches slot,
  // never wired to a real slot, and not claimed by a DIFFERENT edit.
  const { all: attachmentIds, byKind } = collectAttachmentIds(data);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new ValidationError({ _form: 'The same photo is referenced twice.' });
  }
  const atts = attachmentIds.length
    ? await prisma.attachment.findMany({
        where: { id: { in: attachmentIds } },
        select: {
          id: true,
          kind: true,
          deletedAt: true,
          capturedById: true,
          customerId: true,
          branchId: true,
          branchExtraId: true,
          editId: true,
        },
      })
    : [];
  const attById = new Map(atts.map((a) => [a.id, a]));
  for (const ref of byKind) {
    const a = attById.get(ref.id);
    if (!a || a.deletedAt) throw new NotFoundError('A referenced photo no longer exists.');
    if (a.capturedById !== session.id) {
      throw new ForbiddenError('You can only use photos you captured yourself.');
    }
    if (a.customerId || a.branchId || a.branchExtraId) {
      throw new ValidationError({ _form: 'A referenced photo is already wired to a customer.' });
    }
    if (a.editId && a.editId !== existing?.id) {
      throw new ValidationError({ _form: 'A referenced photo belongs to another request.' });
    }
    if (a.kind !== (AttachmentKind[ref.expect] as AttachmentKind)) {
      throw new ValidationError({
        _form: `Photo kind mismatch: expected ${ref.expect}, got ${a.kind}.`,
      });
    }
  }

  // Phone-only duplicates never block (P1.3) — advisory log for stewards.
  if (primaryPhoneNorm) {
    const phoneDup = await prisma.customer.findFirst({
      where: { primaryPhoneNorm, deletedAt: null },
      select: { id: true, nmwcCode: true },
    });
    if (phoneDup) {
      logger.info(
        { actor: session.id, dupId: phoneDup.id, dupNmwc: phoneDup.nmwcCode },
        'create.phone_shared_with_existing_customer'
      );
    }
  }

  const submittedAt = new Date();
  const chain = resolveChain(EditProcess.CREATE, c.paymentTerms);
  const firstStep = chain[0]!;
  const isCredit = c.paymentTerms === PaymentTerms.CREDIT;

  const customerDraftFields = {
    legalName: c.legalName,
    paymentTerms: c.paymentTerms,
    crNumber,
    crNumberNorm,
    channelId: c.channelId ?? null,
    subChannelId: c.subChannelId ?? null,
    primaryPhone: primaryPhoneNorm,
    primaryPhoneNorm,
    altPhone: altPhoneNorm,
    contactPerson: c.contactPerson ?? null,
    contactRole: c.contactRole ?? null,
    notes: c.notes ?? null,
    crPhotoAttachmentId: c.crPhotoAttachmentId ?? null,
  };
  const branchDraftRows = data.branches.map((b) => ({
    branchName: b.branchName,
    regionId: route.regionId,
    routeId: route.id,
    address: b.address ?? '(address pending)',
    areaDescription: b.areaDescription ?? null,
    gpsLat: b.gpsLat ?? null,
    gpsLng: b.gpsLng ?? null,
    gpsAccuracy: b.gpsAccuracy ?? null,
    gpsCapturedAt: b.gpsCapturedAt ?? null,
    dayOfVisit: b.dayOfVisit ?? null,
    openingHours: b.openingHours ?? null,
    deliveryWindow: b.deliveryWindow ?? null,
    coolersCount: b.coolersCount,
    standsCount: b.standsCount,
    emptyBottlesCount: b.emptyBottlesCount,
    shopPhotoAttachmentId: b.shopPhotoAttachmentId ?? null,
    signboardPhotoAttachmentId: b.signboardPhotoAttachmentId ?? null,
    extraPhotoAttachmentIds: b.extraPhotoAttachmentIds as unknown as Prisma.InputJsonValue,
  }));
  // Item 41 (owner: option A): a point typed in by hand is kept, with its reason,
  // as a marker in fieldChanges — EditBranchDraft has no column for it. Rebuilt
  // from THIS payload on every save, so a resubmit never carries a stale one.
  const gpsMarkers = data.branches.flatMap((b, i) =>
    b.gpsManualReason && b.gpsLat != null && b.gpsLng != null
      ? [manualGpsMarker(i, b.gpsLat, b.gpsLng, b.gpsManualReason)]
      : []
  );

  // DG-06: envelope built before the transaction opens (services/users.ts
  // pattern). getAuditEnvelope degrades to null ip/userAgent rather than
  // throwing, so any loss of request context inside the callback would be
  // silent; keeping the call out here makes that impossible.
  const env = await getAuditEnvelope(session.id);

  const edit = await prisma.$transaction(async (tx) => {
    // Hard-block exact duplicates — serialized on the FULL identity surface
    // (CR leg + name/phone/region triple leg) so two racing submits cannot
    // both pass the check even when their CR numbers differ. Submits only; a
    // draft can hold anything (it is private to the salesman until submitted).
    if (!isDraft) {
      await lockCreateIdentity(tx, {
        crNumberNorm,
        legalName: c.legalName,
        primaryPhoneNorm,
        regionIds: [route.regionId],
      });
      await assertNoExactCreateDuplicate(tx, {
        crNumberNorm,
        legalName: c.legalName,
        primaryPhoneNorm,
        regionIds: [route.regionId],
        excludeEditId: existing?.id,
        includeOpenRequests: true,
      });
    }

    const stateFields = isDraft
      ? { state: EditState.DRAFT }
      : {
          state: EditState.SUBMITTED,
          submittedAt,
          // Fresh chain freeze on every submit: paymentTerms may have changed
          // across a correction round, which re-routes CASH ↔ CREDIT.
          paymentTermsAtSubmit: c.paymentTerms,
          approvalChain: chain as unknown as Prisma.InputJsonValue,
          currentStepIndex: 0,
          pendingRole: firstStep.role,
          stageEnteredAt: submittedAt,
          slaDueAt: stepDeadline(submittedAt, firstStep.slaHours),
          // Fresh SLA clock for the new round (see the advance branch in
          // approveEditCore).
          escalationLevel: 0,
          slaBreachedAt: null,
          lastEscalatedAt: null,
          // Stale decision fields from the previous round would mislead
          // approvers reading the detail page.
          decisionReason: null,
          decisionCategory: null,
          reviewedById: null,
          reviewedAt: null,
        };
    const creditFields = {
      requestedCreditLimit: isCredit ? (data.credit?.requestedCreditLimit ?? null) : null,
      requestedPaymentTermDays: isCredit ? (data.credit?.requestedPaymentTermDays ?? null) : null,
    };

    let editRow;
    if (existing) {
      const cycle = resolveCycleOnSubmit(existing, isDraft);
      // Atomic claim on the current state AND cycle so a double-tap / stale
      // tab cannot double-submit, and a row that went through a whole
      // submit→reject round since our snapshot cannot receive a stale
      // (un-bumped) cycle write — the claim just misses and returns
      // EDIT_LOCKED instead.
      const claim = await tx.customerEdit.updateMany({
        where: {
          id: existing.id,
          state: existing.state,
          cycle: existing.cycle,
          submittedById: session.id,
        },
        data: {
          ...stateFields,
          ...creditFields,
          cycle,
          fieldChanges: gpsMarkers as unknown as Prisma.InputJsonValue,
        },
      });
      if (claim.count === 0) {
        throw new ConflictError(
          'EDIT_LOCKED',
          'This request just changed in another tab. Refresh to see its current state.'
        );
      }
      editRow = await tx.customerEdit.findUniqueOrThrow({ where: { id: existing.id } });
      await tx.editCustomerDraft.upsert({
        where: { editId: existing.id },
        create: { editId: existing.id, ...customerDraftFields },
        update: customerDraftFields,
      });
      await tx.editBranchDraft.deleteMany({ where: { editId: existing.id } });
    } else {
      editRow = await tx.customerEdit.create({
        data: {
          target: EditTarget.CUSTOMER,
          process: EditProcess.CREATE,
          customerId: null,
          submittedById: session.id,
          fieldChanges: gpsMarkers as unknown as Prisma.InputJsonValue,
          attachmentChanges: [] as unknown as Prisma.InputJsonValue,
          cycle: 1,
          ...stateFields,
          ...creditFields,
        },
      });
      await tx.editCustomerDraft.create({
        data: { editId: editRow.id, ...customerDraftFields },
      });
    }
    await tx.editBranchDraft.createMany({
      data: branchDraftRows.map((b) => ({ ...b, editId: editRow.id })),
    });

    // Claim referenced attachments for this edit; release (soft-delete) any
    // previously claimed photo the salesman removed from the form — mirrors
    // detachPhoto semantics so the GC pipeline picks them up.
    if (attachmentIds.length > 0) {
      const claimed = await tx.attachment.updateMany({
        where: {
          id: { in: attachmentIds },
          deletedAt: null,
          capturedById: session.id,
          customerId: null,
          branchId: null,
          branchExtraId: null,
          OR: [{ editId: null }, { editId: editRow.id }],
        },
        data: { editId: editRow.id },
      });
      if (claimed.count !== attachmentIds.length) {
        throw new ConflictError(
          'PHOTO_CONFLICT',
          'A referenced photo was just used elsewhere. Refresh and re-check the photo slots.'
        );
      }
    }
    await tx.attachment.updateMany({
      where: {
        editId: editRow.id,
        deletedAt: null,
        ...(attachmentIds.length ? { id: { notIn: attachmentIds } } : {}),
      },
      data: { deletedAt: submittedAt, hash: null },
    });

    await writeAudit(tx, env, {
      action: existing ? 'UPDATE' : 'CREATE',
      entityType: 'CustomerEdit',
      entityId: editRow.id,
      after: {
        process: 'CREATE',
        state: isDraft ? 'DRAFT' : 'SUBMITTED',
        paymentTerms: c.paymentTerms,
        branches: branchDraftRows.length,
        cycle: editRow.cycle,
      } as unknown as Prisma.InputJsonValue,
    });

    if (!isDraft) {
      const audience = await resolveStepAudience(
        tx,
        firstStep,
        { supervisorId: me.supervisorId },
        [route.regionId]
      );
      await notifyUsers(tx, audience, {
        kind: 'EDIT_SUBMITTED',
        title: 'New customer request',
        body: `${c.legalName} — new ${c.paymentTerms} customer request awaiting your review.`,
        editId: editRow.id,
      });
    }

    return editRow;
    // Above Prisma's 5s default: the draft write fans out (~20 statements for
    // a 10-branch request) and the identity lock may wait on a concurrent
    // finalize holding the same keys.
  }, { timeout: 20_000, maxWait: 5_000 });

  logger.info(
    {
      editId: edit.id,
      by: session.id,
      state: isDraft ? 'DRAFT' : 'SUBMITTED',
      terms: c.paymentTerms,
      branches: branchDraftRows.length,
      cycle: edit.cycle,
    },
    'create.submit'
  );

  revalidatePath('/work');
  revalidatePath('/approvals');
  return { editId: edit.id, state: isDraft ? EditState.DRAFT : EditState.SUBMITTED };
}
