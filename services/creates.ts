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
 *  - NEEDS_CORRECTION resubmits reuse the SAME row and bump `cycle`. One
 *    started on another route than the salesman's own (he was moved since) is
 *    refused, never re-filed on his new route; he withdraws it.
 *  - Launch fix: the salesman can withdraw his own DRAFT or NEEDS_CORRECTION
 *    request (withdrawCreateAction). It is closed for good (REJECTED), and so
 *    stops blocking that CR and shop for everyone (lib/create-guards.ts).
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
import { requireActor } from '@/lib/session';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ROUTE_INACTIVE_MESSAGE,
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
import { reportedIssues } from '@/lib/validation/fields';
import { resolveStepAudience, notifyUsers } from '@/lib/notifications';
import { notifySalesmanRequest } from '@/lib/notify-hierarchy';
import { lockCreateIdentity, assertNoExactCreateDuplicate } from '@/lib/create-guards';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { answerIfLanded, findReceipt, shownTime } from '@/lib/submission-replay';
import { omanWhen, submissionIdSchema, type SubmitReceipt } from '@/lib/submission';
import { UNWIRED_LIVE } from '@/lib/photo-attach';

async function requireUser() {
  return requireActor(); // F15: refuses a session that must change its password
}

/**
 * Map Zod issues to the create form's error keys (`customer.x`, `branch.<i>.x`,
 * `credit.x`). Only the first ones, their messages clipped (reportedIssues).
 */
function zodIssuesToFields(issues: ZodIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of reportedIssues(issues)) {
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

export async function submitCreateAction(input: SubmitCreateInput): SafeAction<SubmitReceipt> {
  return runAction(() => submitCreateCore(input));
}

async function submitCreateCore(input: SubmitCreateInput): Promise<SubmitReceipt> {
  const session = await requireUser();
  // Item 22: a retry of a submit that already landed is answered from what it
  // wrote. Without this, a lost reply on a fresh form dead-ended: the retry was
  // refused because its photos "belong to another request" — the salesman's own.
  const submissionId = submissionIdSchema.safeParse(input?.submissionId).data;
  const rawEditId = typeof input?.editId === 'string' ? input.editId : undefined;
  const receipt = () =>
    findReceipt(prisma, session.id, submissionId, {
      process: EditProcess.CREATE,
      ...(rawEditId ? { editId: rawEditId } : {}),
    });
  const replayed = await receipt();
  if (replayed) return replayed;
  // …and one that overlapped its first attempt — refused by the identity lock's
  // duplicate check, the id's unique index, the photo claim or the draft claim —
  // is answered the same way instead of with the refusal.
  return answerIfLanded(() => submitCreateOnce(input, session, submissionId), receipt);
}

async function submitCreateOnce(
  input: SubmitCreateInput,
  session: Awaited<ReturnType<typeof requireUser>>,
  submissionId: string | undefined
): Promise<SubmitReceipt> {
  // Launch fix: a draft save spends its own bucket, not the one submits share
  // (services/edits.ts says why). Read off the body, as the schema has not run.
  const draftSave = (input as { isDraft?: unknown } | undefined)?.isDraft === true;
  const lim = await checkLimit(`${draftSave ? 'edit-draft' : 'edit'}:${session.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  // Owner-confirmed: only a Salesman initiates a create request (Steward's
  // lane is the import; Manager/Steward direct-write is UPDATE-only).
  if (session.role !== Role.SALESMAN) {
    throw new ForbiddenError('Only a Salesman can request a new customer.');
  }

  const parsed = submitCreateSchema.safeParse(input);
  // The request being resumed, read on its own when the body fails the schema:
  // one he can no longer save or send (another's, in review, withdrawn, or
  // started on a route he has left) says so before any field is refused. He
  // corrected every field first, and was then told. A body that fails with no
  // request to resume is still refused before the database.
  const editId = parsed.success
    ? parsed.data.editId
    : submitCreateSchema.shape.editId.safeParse((input as { editId?: unknown } | undefined)?.editId)
        .data;
  if (!parsed.success && !editId) {
    throw new ValidationError(zodIssuesToFields(parsed.error.issues));
  }

  // The salesman's own route decides region + route for EVERY branch draft.
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      id: true,
      supervisorId: true,
      ownedRoute: { select: { id: true, code: true, regionId: true, isActive: true } },
    },
  });
  if (!me.ownedRoute) {
    throw new ForbiddenError('You have no route assigned — ask your supervisor.');
  }
  if (!me.ownedRoute.isActive) {
    throw new ForbiddenError(ROUTE_INACTIVE_MESSAGE);
  }
  const route = me.ownedRoute;

  // Resuming an existing request? Ownership + state gate.
  const existing = editId
    ? await prisma.customerEdit.findUnique({
        where: { id: editId },
        select: {
          id: true,
          process: true,
          state: true,
          submittedById: true,
          cycle: true,
          submittedAt: true,
          branchDrafts: { select: { routeId: true, route: { select: { code: true } } } },
        },
      })
    : null;
  if (editId) {
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
    // Launch fix: a withdrawn request is closed for good. It no longer blocks
    // its CR or shop, so sending it again could slip past a request made since.
    // (Nothing else ever wrote REJECTED on a new-customer request.)
    if (existing.state === EditState.REJECTED) {
      throw new ConflictError('EDIT_LOCKED', WITHDRAWN_MESSAGE);
    }
    // Security review: one started on a route he has since left (moved while it
    // was in review, then sent back; or moved by a role change or an import) is
    // never re-filed. Rebuilding its drafts below would put the shop on his NEW
    // route, before that region's approvers. He withdraws it (withdrawCreateCore
    // checks no route); the salesman of its route adds the shop afresh.
    const startedOn = [
      ...new Set(
        existing.branchDrafts.filter((b) => b.routeId !== route.id).map((b) => b.route.code)
      ),
    ].join(', ');
    if (startedOn) {
      throw new ConflictError('EDIT_LOCKED', routeMovedMessage(startedOn, route.code));
    }
    // DRAFT / NEEDS_CORRECTION may be revised and resubmitted.
  }

  if (!parsed.success) {
    throw new ValidationError(zodIssuesToFields(parsed.error.issues));
  }
  const data: ParsedSubmitCreate = parsed.data;
  const isDraft = data.isDraft;

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
      throw await photoClaimedConflict(a.editId, session.id);
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
        callerId: session.id,
        // Launch fix: name a live duplicate only when it is on his route.
        callerRouteId: route.id,
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
          // Item 22: a draft save changes neither state nor cycle, so without
          // this an overlapping retry of the SAME save re-passed the claim and
          // rewrote the drafts (and wrote a second audit row). Its own id on
          // the row means it landed: the claim misses, and the receipt answers.
          ...(submissionId
            ? { OR: [{ submissionId: null }, { submissionId: { not: submissionId } }] }
            : {}),
        },
        data: {
          ...stateFields,
          ...creditFields,
          cycle,
          fieldChanges: gpsMarkers as unknown as Prisma.InputJsonValue,
          // Item 22: the latest write's id answers its own retry. Undefined
          // (an older client) leaves the column as it was.
          submissionId,
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
          submissionId,
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
          ...UNWIRED_LIVE,
          capturedById: session.id,
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
      // F1: the route region's Accountant is told for information — he is the
      // final approver on both create chains (lib/notify-policy.ts). In this
      // transaction, like the row above: it commits with the submit or not at all.
      await notifySalesmanRequest(tx, {
        event: 'CREATE',
        submitter: { id: session.id, supervisorId: me.supervisorId },
        regionId: route.regionId,
        editId: editRow.id,
        subject: { legalName: c.legalName, nmwcCode: null },
        alreadyTold: audience,
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
  return {
    editId: edit.id,
    state: isDraft ? EditState.DRAFT : EditState.SUBMITTED,
    submittedAt: edit.submittedAt?.toISOString() ?? null,
    replayed: false,
  };
}

const WITHDRAWN_MESSAGE =
  'This request was withdrawn and is closed. Start a new request if the shop still needs adding.';

/** A request started on a route he no longer works (app/(app)/customers/new/page.tsx says the same). */
function routeMovedMessage(from: string, to: string): string {
  return `This request was started on route ${from}, and you now work route ${to}, so it cannot be saved or sent again. Withdraw it, and the salesman of route ${from} adds the shop afresh.`;
}

/**
 * Launch fix: the salesman withdraws his own new-customer request — a draft he
 * abandoned, or one sent back to him that he will not correct. Until now
 * nothing could end one: every open request (DRAFT, SUBMITTED,
 * NEEDS_CORRECTION) blocks its CR number and its shop for every salesman
 * (lib/create-guards.ts), and an approver's reject only ever returns it.
 *
 * It becomes REJECTED — closed without being applied, the state a merge leaves
 * an open request in (services/duplicates.ts) — with the clock stopped, and
 * the decision fields say who closed it and when. The approvers' earlier
 * decisions and reasons stay in its EditApproval history. One in review
 * (SUBMITTED) cannot be withdrawn: an approver has it, and sends it back first.
 * Its photos stay bound to it (an abandoned-draft sweep is the owner's open
 * retention decision, schema.prisma Attachment.editId).
 */
export async function withdrawCreateAction(input: { editId: string }): SafeAction<{ editId: string }> {
  return runAction(() => withdrawCreateCore(input));
}

async function withdrawCreateCore(input: { editId: string }): Promise<{ editId: string }> {
  const session = await requireUser();
  const editId = typeof input?.editId === 'string' ? input.editId : '';
  if (!editId) throw new ValidationError({ editId: 'required' });
  const lim = await checkLimit(`edit:${session.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    select: { id: true, process: true, state: true, submittedById: true, cycle: true },
  });
  // A create request is private to its submitter: anyone else's reads as not found.
  if (!edit || edit.process !== EditProcess.CREATE || edit.submittedById !== session.id) {
    throw new NotFoundError('Create request not found.');
  }
  // Already withdrawn (a retry whose first answer was lost): that is the answer.
  if (edit.state === EditState.REJECTED) return { editId };
  if (edit.state !== EditState.DRAFT && edit.state !== EditState.NEEDS_CORRECTION) {
    throw new ConflictError(
      'EDIT_LOCKED',
      edit.state === EditState.SUBMITTED
        ? 'This request is in review, so it cannot be withdrawn now. Ask the approver who has it to send it back to you, then withdraw it.'
        : 'This request was already approved.'
    );
  }

  const env = await getAuditEnvelope(session.id);
  const withdrawnAt = new Date();
  await prisma.$transaction(async (tx) => {
    // Claimed on the state and cycle read above: a submit from another tab in
    // between wins, and this answers that it changed.
    const claim = await tx.customerEdit.updateMany({
      where: { id: editId, state: edit.state, cycle: edit.cycle, submittedById: session.id },
      data: {
        state: EditState.REJECTED,
        pendingRole: null,
        slaDueAt: null,
        slaBreachedAt: null,
        lastEscalatedAt: null,
        escalationLevel: 0,
        reviewedById: session.id,
        reviewedAt: withdrawnAt,
        decisionReason: 'Withdrawn by the salesman who sent it.',
        decisionCategory: 'withdrawn',
      },
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'EDIT_LOCKED',
        'This request just changed in another tab. Refresh to see its current state.'
      );
    }
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'CustomerEdit',
      entityId: editId,
      reason: 'withdrawn by the salesman',
      after: {
        process: 'CREATE',
        state: EditState.REJECTED,
        from: edit.state,
        cycle: edit.cycle,
      } as unknown as Prisma.InputJsonValue,
    });
  });

  logger.info({ editId, by: session.id, from: edit.state }, 'create.withdraw');
  revalidatePath('/work');
  revalidatePath('/today');
  revalidatePath('/rejected');
  return { editId };
}

/**
 * A referenced photo is already claimed by another request. When that request
 * is the salesman's OWN (item 22: the reply to a first attempt was lost, and the
 * retry changed something, so it carries a new id), say where his work went —
 * the old message read like somebody else had his photos. A conflict, not a
 * field error: it has no field, and the form says it beside the button.
 */
async function photoClaimedConflict(
  editId: string,
  meId: string
): Promise<ValidationError | ConflictError> {
  const other = await prisma.customerEdit.findUnique({
    where: { id: editId },
    select: { submittedById: true, state: true, submittedAt: true, updatedAt: true },
  });
  if (!other || other.submittedById !== meId) {
    return new ValidationError({ _form: 'A referenced photo belongs to another request.' });
  }
  const when = omanWhen(shownTime(other));
  return new ConflictError(
    'REQUEST_ALREADY_SENT',
    other.state === EditState.DRAFT
      ? `These photos are already in your draft saved at ${when}. Open it from Work to carry on — anything you changed since was not saved.`
      : `This request already arrived at ${when} — see Work. Anything you changed since was not sent.`
  );
}
