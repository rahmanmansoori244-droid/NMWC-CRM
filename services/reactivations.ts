'use server';

import { prisma } from '@/lib/db';
import { Role, EditState, EditTarget, EditProcess, type Prisma } from '@prisma/client';
import { requireActor } from '@/lib/session';
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  ConflictError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';
import { lockCustomerRow } from '@/lib/locks';
import { REACTIVATION_STATE_CHANGED_MESSAGE, assertStatusEvidence } from '@/lib/status-evidence';
import { stepDeadline } from '@/lib/approval-chains';
import { STAGE_SLA_MINUTES, DEFAULT_STAGE_SLA_MIN } from '@/lib/working-hours';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import {
  answerIfLanded,
  findReceipt,
  isUniqueViolation,
  ownOpenRequestMessage,
  type RequestKind,
} from '@/lib/submission-replay';
import { submissionIdSchema, type SubmitReceipt } from '@/lib/submission';
import { notifySalesmanRequest } from '@/lib/notify-hierarchy';

async function require(role?: Role[]) {
  const user = await requireActor(); // F15: refuses a session that must change its password
  if (role && !role.includes(user.role)) {
    throw new ForbiddenError(`Role ${user.role} not allowed.`);
  }
  return user;
}

/**
 * A customer may have only ONE open edit at a time (CustomerEdit_open_per_customer
 * partial-unique index). A reactivation or close-shop submitted while an unrelated
 * change is still pending trips a raw P2002 — an opaque UNIQUE_CONSTRAINT dead-end
 * for the salesman (final-hunt #16/#24). Translate it into an actionable message.
 *
 * Item 22: when the open request is the salesman's own, say what it is — the
 * same request means his earlier attempt arrived; another one means this was
 * not sent. (The violation may also be this submit's own id, from a retry that
 * overlapped the first attempt; answerIfLanded answers that from the receipt.)
 */
async function openEditConflict(
  err: unknown,
  meId: string,
  customerId: string,
  sending: { kind: RequestKind; branchId: string }
): Promise<never> {
  if (!isUniqueViolation(err)) throw err;
  const open = await prisma.customerEdit.findFirst({
    where: { customerId, state: EditState.SUBMITTED },
    select: { submittedById: true, target: true, isReactivation: true, branchId: true, submittedAt: true },
  });
  throw new ConflictError(
    'OPEN_EDIT_EXISTS',
    open?.submittedById === meId
      ? ownOpenRequestMessage(open, sending)
      : 'This customer already has a pending change awaiting review. That must be approved or rejected before you can submit another.'
  );
}

/**
 * Item 22: this submit's receipt, if its id already landed as this kind of
 * request on this branch — asked first, and again if the submit fails.
 */
function receiptFor(meId: string, formData: FormData, isReactivation: boolean) {
  const submissionId = submissionIdSchema.safeParse(formData.get('submissionId')).data;
  const branchId = String(formData.get('branchId') ?? '');
  return () =>
    findReceipt(prisma, meId, submissionId, {
      process: EditProcess.UPDATE,
      target: EditTarget.BRANCH,
      branchId,
      isReactivation,
    });
}

type SessionUser = Awaited<ReturnType<typeof require>>;

/**
 * Salesman submits a reactivation request for a CLOSED branch.
 *
 * QA-008 fix: requires a fresh photo (≤24h old) attached to this branch as
 * evidence. The salesman captures the photo first via PhotoCaptureSlot (which
 * sets Attachment.branchExtraId or shopPhotoId), then submits this action with
 * the attachment id.
 */
export async function requestReactivationAction(formData: FormData): SafeAction<SubmitReceipt> {
  return runAction(() => requestReactivationCore(formData));
}

async function requestReactivationCore(formData: FormData): Promise<SubmitReceipt> {
  const me = await require([Role.SALESMAN]);
  // Item 22: a retry of a request that already landed is answered, not re-run —
  // before the checks below, which its own approval may since have changed.
  const receipt = receiptFor(me.id, formData, true);
  const replayed = await receipt();
  if (replayed) return replayed;
  return answerIfLanded(() => requestReactivationOnce(formData, me), receipt);
}

async function requestReactivationOnce(formData: FormData, me: SessionUser): Promise<SubmitReceipt> {
  const branchId = String(formData.get('branchId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const attachmentId = String(formData.get('attachmentId') ?? '');
  if (!branchId) throw new ValidationError({ branchId: 'required' });
  if (reason.length < 5) throw new ValidationError({ reason: 'Tell us why (5+ chars).' });
  if (!attachmentId) {
    throw new ValidationError({ attachmentId: 'A fresh photo of the shop is required.' });
  }

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, deletedAt: null },
    include: { customer: true },
  });
  if (!branch) throw new NotFoundError('Branch not found.');
  if (branch.status !== 'CLOSED') {
    throw new ValidationError({ branchId: 'Branch is not in CLOSED state.' });
  }
  const meRow = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    // supervisorId: F1, who is told of this request (lib/notify-hierarchy.ts).
    select: { ownedRouteId: true, supervisorId: true },
  });
  if (branch.routeId !== meRow.ownedRouteId) {
    throw new ForbiddenError('Branch is not on your route.');
  }

  // Photo evidence must:
  //   1) exist, 2) be captured by this salesman, 3) be ≤24h old, 4) belong to this branch
  // UXI-008: filter soft-deleted. EL-11/EL-12: photo evidence must have been
  // captured AFTER the most recent status change on this branch — otherwise
  // a salesman can use a pre-closure shop photo to "prove" the shop reopened.
  const att = await prisma.attachment.findFirst({
    where: { id: attachmentId, deletedAt: null },
  });
  if (!att) throw new ValidationError({ attachmentId: 'Photo not found.' });
  if (att.capturedById !== me.id) {
    throw new ValidationError({ attachmentId: 'You did not capture that photo.' });
  }
  const ageMs = Date.now() - new Date(att.capturedAt).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    throw new ValidationError({
      attachmentId: 'Photo is older than 24 hours — capture a fresh one.',
    });
  }
  if (
    branch.lastStatusChangeAt &&
    new Date(att.capturedAt).getTime() <= new Date(branch.lastStatusChangeAt).getTime()
  ) {
    throw new ValidationError({
      attachmentId:
        'Photo was captured before the last status change. Take a new photo at the shop today.',
    });
  }
  if (att.branchId !== branch.id && att.branchExtraId !== branch.id) {
    throw new ValidationError({
      attachmentId: 'Photo is not attached to this branch.',
    });
  }

  const reactSubmittedAt = new Date();
  // F1 / A1.7: the request and the notifications of it commit together, so a
  // replay (answered from the receipt before any of this runs) and a refused
  // insert (P2002, rolled back whole) both leave no notification behind. The
  // P2002 is still translated outside the transaction by openEditConflict.
  // A failed hierarchy lookup now fails the submit, as a new-customer submit's
  // notification always has; the salesman's retry is answered or re-run.
  const edit = await prisma.$transaction(async (tx) => {
    const e = await tx.customerEdit.create({
      data: {
        target: EditTarget.BRANCH,
        branchId: branch.id,
        customerId: branch.customerId,
        state: EditState.SUBMITTED,
        submittedById: me.id,
        submittedAt: reactSubmittedAt,
        isReactivation: true,
        decisionReason: reason,
        // Phase 1 SLA: reactivations are decided by MANAGER (approveReactivation
        // is Manager-only) — stamping pendingRole keeps them OUT of the
        // Supervisor-step /approvals queues and puts them on the SLA clock.
        pendingRole: Role.MANAGER,
        stageEnteredAt: reactSubmittedAt,
        slaDueAt: stepDeadline(
          reactSubmittedAt,
          (STAGE_SLA_MINUTES[Role.MANAGER] ?? DEFAULT_STAGE_SLA_MIN) / 60
        ),
        fieldChanges: [
          { field: `branch.${branch.id}.status`, before: 'CLOSED', after: 'ACTIVE' },
        ] as unknown as Prisma.InputJsonValue,
        attachmentChanges: [
          { kind: att.kind, attachmentId: att.id, action: 'EVIDENCE' },
        ] as unknown as Prisma.InputJsonValue,
        submissionId: submissionIdSchema.safeParse(formData.get('submissionId')).data,
      },
    });
    // A Manager decides a reactivation: his supervisor if he is a Manager over
    // the branch's region, else every active Manager of it (REACTIVATION_REQUESTED,
    // linked to /reactivations); the region's Accountant for information.
    await notifySalesmanRequest(tx, {
      event: 'REACTIVATION',
      submitter: { id: me.id, supervisorId: meRow.supervisorId },
      regionId: branch.regionId,
      editId: e.id,
      customerId: branch.customerId,
      subject: { legalName: branch.customer.legalName, nmwcCode: branch.customer.nmwcCode },
    });
    return e;
  }).catch((err: unknown) =>
    openEditConflict(err, me.id, branch.customerId, { kind: 'reactivate', branchId: branch.id })
  );

  logger.info({ editId: edit.id, by: me.id }, 'reactivation.request');
  revalidatePath('/work');
  revalidatePath(`/customers/${branch.customerId}`);
  return { editId: edit.id, state: edit.state, submittedAt: reactSubmittedAt.toISOString(), replayed: false };
}

/**
 * Salesman marks a branch as CLOSED. Requires a fresh photo (≤24h old) of the
 * closed shop attached as the `shopPhotoId` slot or as a free photo.
 */
export async function markBranchClosedAction(formData: FormData): SafeAction<SubmitReceipt> {
  return runAction(() => markBranchClosedCore(formData));
}

async function markBranchClosedCore(formData: FormData): Promise<SubmitReceipt> {
  const me = await require([Role.SALESMAN]);
  // Item 22: as for a reactivation — a retry of a close that landed is answered.
  const receipt = receiptFor(me.id, formData, false);
  const replayed = await receipt();
  if (replayed) return replayed;
  return answerIfLanded(() => markBranchClosedOnce(formData, me), receipt);
}

async function markBranchClosedOnce(formData: FormData, me: SessionUser): Promise<SubmitReceipt> {
  const branchId = String(formData.get('branchId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const attachmentId = String(formData.get('attachmentId') ?? '');
  if (!branchId) throw new ValidationError({ branchId: 'required' });
  if (reason.length < 5) throw new ValidationError({ reason: 'Tell us why (5+ chars).' });
  if (!attachmentId) {
    throw new ValidationError({ attachmentId: 'A fresh photo is required.' });
  }

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, deletedAt: null },
    include: { customer: true },
  });
  if (!branch) throw new NotFoundError('Branch not found.');
  const meRow = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    // supervisorId: F1, who is told of this request (lib/notify-hierarchy.ts).
    select: { ownedRouteId: true, supervisorId: true },
  });
  if (branch.routeId !== meRow.ownedRouteId) {
    throw new ForbiddenError('Branch is not on your route.');
  }
  if (branch.status === 'CLOSED') {
    throw new ValidationError({ branchId: 'Branch is already CLOSED.' });
  }

  // UXI-008: filter soft-deleted. EL-11/EL-12: photo evidence must have been
  // captured AFTER the most recent status change on this branch — otherwise
  // a salesman can use a pre-closure shop photo to "prove" the shop reopened.
  const att = await prisma.attachment.findFirst({
    where: { id: attachmentId, deletedAt: null },
  });
  if (!att) throw new ValidationError({ attachmentId: 'Photo not found.' });
  if (att.capturedById !== me.id) {
    throw new ValidationError({ attachmentId: 'You did not capture that photo.' });
  }
  const ageMs = Date.now() - new Date(att.capturedAt).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    throw new ValidationError({
      attachmentId: 'Photo is older than 24 hours — capture a fresh one.',
    });
  }
  if (
    branch.lastStatusChangeAt &&
    new Date(att.capturedAt).getTime() <= new Date(branch.lastStatusChangeAt).getTime()
  ) {
    throw new ValidationError({
      attachmentId:
        'Photo was captured before the last status change. Take a new photo at the shop today.',
    });
  }
  if (att.branchId !== branch.id && att.branchExtraId !== branch.id) {
    throw new ValidationError({
      attachmentId: 'Photo is not attached to this branch.',
    });
  }

  // Submit as a regular CustomerEdit so a Supervisor approves the closure.
  const closeSubmittedAt = new Date();
  // F1 / A1.7: as for a reactivation — the request and its notifications commit
  // together, and the P2002 is translated outside the transaction.
  const edit = await prisma.$transaction(async (tx) => {
    const e = await tx.customerEdit.create({
      data: {
        target: EditTarget.BRANCH,
        branchId: branch.id,
        customerId: branch.customerId,
        state: EditState.SUBMITTED,
        submittedById: me.id,
        submittedAt: closeSubmittedAt,
        decisionReason: reason,
        // Phase 1 SLA: close requests ride the normal Supervisor approval.
        pendingRole: Role.SUPERVISOR,
        stageEnteredAt: closeSubmittedAt,
        slaDueAt: stepDeadline(
          closeSubmittedAt,
          (STAGE_SLA_MINUTES[Role.SUPERVISOR] ?? DEFAULT_STAGE_SLA_MIN) / 60
        ),
        fieldChanges: [
          { field: `branch.${branch.id}.status`, before: branch.status, after: 'CLOSED' },
        ] as unknown as Prisma.InputJsonValue,
        attachmentChanges: [
          { kind: att.kind, attachmentId: att.id, action: 'EVIDENCE' },
        ] as unknown as Prisma.InputJsonValue,
        submissionId: submissionIdSchema.safeParse(formData.get('submissionId')).data,
      },
    });
    // The Supervisor step decides a close: his supervisor if he can act on it,
    // else the active Managers of the branch's region (EDIT_SUBMITTED, linked to
    // the review page); the region's Accountant for information.
    await notifySalesmanRequest(tx, {
      event: 'CLOSE',
      submitter: { id: me.id, supervisorId: meRow.supervisorId },
      regionId: branch.regionId,
      editId: e.id,
      customerId: branch.customerId,
      subject: { legalName: branch.customer.legalName, nmwcCode: branch.customer.nmwcCode },
    });
    return e;
  }).catch((err: unknown) =>
    openEditConflict(err, me.id, branch.customerId, { kind: 'close', branchId: branch.id })
  );
  logger.info({ editId: edit.id, by: me.id }, 'branch.close.request');
  revalidatePath('/work');
  revalidatePath(`/customers/${branch.customerId}`);
  return { editId: edit.id, state: edit.state, submittedAt: closeSubmittedAt.toISOString(), replayed: false };
}

/**
 * Manager approves the reactivation: branch goes back to ACTIVE, customer too if all branches now active.
 */
export async function approveReactivationAction(formData: FormData): SafeAction<void> {
  return runAction(() => approveReactivationCore(formData));
}

async function approveReactivationCore(formData: FormData) {
  const me = await require([Role.MANAGER]);
  const editId = String(formData.get('editId') ?? '');
  if (!editId) throw new ValidationError({ editId: 'required' });

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: { branch: true, customer: true, submittedBy: { select: { id: true } } },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (!edit.isReactivation) throw new ValidationError({ editId: 'Not a reactivation.' });
  if (edit.state !== EditState.SUBMITTED) {
    throw new ValidationError({ editId: `Edit is in state ${edit.state}.` });
  }
  if (!edit.branch || !edit.customer) throw new NotFoundError('Branch / customer missing.');
  // RBAC-05-008: a Manager can only approve reactivations in regions they
  // manage. Without this, Manager A could rubber-stamp a reactivation in
  // Manager B's region with no paper trail of cross-region action.
  const { loadScope } = await import('@/lib/access');
  const actorScope = await loadScope(me.id);
  if (actorScope.managedRegionIds.length === 0) {
    throw new ForbiddenError('You have no managed regions assigned.');
  }
  if (!actorScope.managedRegionIds.includes(edit.branch.regionId)) {
    throw new ForbiddenError('This branch is not in your managed regions.');
  }
  // EL-15: cannot approve your own reactivation.
  if (edit.submittedBy?.id === me.id) {
    throw new ForbiddenError('Cannot approve your own reactivation.');
  }

  // DG-06: envelope built before the transaction opens (services/users.ts
  // pattern). getAuditEnvelope degrades to null ip/userAgent rather than
  // throwing, so any loss of request context inside the callback would be
  // silent; keeping the call out here makes that impossible.
  const env = await getAuditEnvelope(me.id);

  await prisma.$transaction(async (tx) => {
    // QA-C12: claim the edit atomically FIRST (PROD-001 pattern, mirroring
    // services/edits.ts approveEditCore). The pre-tx state read above is a fast
    // reject; this is the authoritative guard. Two Managers (or a double-click)
    // racing here: only one updateMany matches state=SUBMITTED, the loser sees
    // count=0 and aborts before any branch/customer/score/audit side effects —
    // no duplicate REACTIVATE audit rows, no reviewer misattribution.
    const claim = await tx.customerEdit.updateMany({
      where: { id: editId, state: EditState.SUBMITTED, isReactivation: true },
      data: {
        state: EditState.APPROVED,
        pendingRole: null,
        reviewedById: me.id,
        reviewedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'NOT_PENDING',
        'This reactivation was just decided by another reviewer. Refresh to see the current state.'
      );
    }
    // The customer's row lock before the branch write (lib/locks.ts): photo
    // attach and Remove take it first too, and the opposite order deadlocked
    // on the same branch (pre-merge review).
    await lockCustomerRow(tx, edit.customerId!);
    // X-STATUS-1: the branch and customer as they stand now, not as loaded
    // before the transaction. An archive or an import can land while the
    // request waits, and the write below is by id: it would reopen a
    // removed branch, one now under another customer, or one no longer closed
    // — and with no live branch left, `every` below is true on an empty list
    // and a tombstoned customer came back ACTIVE.
    const branchNow = await tx.branch.findUnique({
      where: { id: edit.branchId! },
      select: { customerId: true, status: true, deletedAt: true },
    });
    const customerNow = await tx.customer.findUnique({
      where: { id: edit.customerId! },
      select: { deletedAt: true },
    });
    if (
      !branchNow ||
      branchNow.deletedAt ||
      branchNow.customerId !== edit.customerId ||
      branchNow.status !== 'CLOSED' ||
      !customerNow ||
      customerNow.deletedAt
    ) {
      // The Reactivations queue's reject button is "Keep closed"; the message names it.
      throw new ConflictError('STATE_CHANGED', REACTIVATION_STATE_CHANGED_MESSAGE);
    }
    // F10: the photo the request was sent with must still stand — live, the
    // submitter's, on this branch. Read under the lock Remove also takes; the
    // 24-hour age rule is not re-applied (lib/status-evidence.ts).
    await assertStatusEvidence(tx, {
      branchId: edit.branchId,
      submittedById: edit.submittedById,
      attachmentChanges: edit.attachmentChanges,
      queue: 'reactivations',
    });
    await tx.branch.update({
      where: { id: edit.branchId! },
      data: {
        status: 'ACTIVE',
        lastEditedById: me.id,
        lastStatusChangeAt: new Date(),
      },
    });
    // If any branch active, customer is active
    const others = await tx.branch.findMany({
      where: { customerId: edit.customerId!, deletedAt: null },
    });
    const allActive = others.every((b) => b.status === 'ACTIVE');
    if (allActive) {
      await tx.customer.update({
        where: { id: edit.customerId! },
        data: { status: 'ACTIVE', lastEditedById: me.id },
      });
    }
    // Recompute scores
    const fresh = await tx.customer.findUniqueOrThrow({
      where: { id: edit.customerId! },
      include: { branches: { where: { deletedAt: null } } },
    });
    const cScore = scoreCustomer(fresh, fresh.branches);
    await tx.customer.update({
      where: { id: edit.customerId! },
      data: { completenessScore: cScore },
    });
    for (const b of fresh.branches) {
      const bScore = scoreBranch(b);
      await tx.branch.update({ where: { id: b.id }, data: { completenessScore: bScore } });
    }
    // (edit state already claimed to APPROVED at the top of this tx — QA-C12.)
    await writeAudit(tx, env, {
      action: 'REACTIVATE',
      entityType: 'Branch',
      entityId: edit.branchId!,
      reason: edit.decisionReason ?? undefined,
    });
  });

  logger.info({ editId, by: me.id }, 'reactivation.approve');
  revalidatePath('/reactivations');
  revalidatePath(`/customers/${edit.customerId}`);
}

export async function rejectReactivationAction(formData: FormData): SafeAction<void> {
  return runAction(() => rejectReactivationCore(formData));
}

async function rejectReactivationCore(formData: FormData) {
  const me = await require([Role.MANAGER]);
  const editId = String(formData.get('editId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!editId) throw new ValidationError({ editId: 'required' });
  if (reason.length < 5) throw new ValidationError({ reason: '5+ chars required' });

  // RBAC-05-008: same region scope as approve. Reject is not a privilege
  // escalation but it still touches another Manager's queue.
  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: { branch: true, submittedBy: { select: { id: true } } },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (!edit.branch) throw new NotFoundError('Branch missing.');
  // QA-C13 (Critical): symmetric with approveReactivationCore. Without these
  // guards a Manager could reject an ALREADY-DECIDED reactivation (corrupting
  // APPROVED->NEEDS_CORRECTION while the branch stays ACTIVE) or pass the id of
  // an UNRELATED regular branch edit and strand it mid-chain. Reject only a
  // still-pending reactivation.
  if (!edit.isReactivation) throw new ValidationError({ editId: 'Not a reactivation.' });
  if (edit.state !== EditState.SUBMITTED) {
    throw new ValidationError({ editId: `Edit is in state ${edit.state}.` });
  }
  const { loadScope } = await import('@/lib/access');
  const actorScope = await loadScope(me.id);
  if (
    actorScope.managedRegionIds.length === 0 ||
    !actorScope.managedRegionIds.includes(edit.branch.regionId)
  ) {
    throw new ForbiddenError('This branch is not in your managed regions.');
  }
  if (edit.submittedBy?.id === me.id) {
    throw new ForbiddenError('Cannot reject your own request.');
  }

  // F13: the decision and its audit row commit together or not at all. They
  // were two autocommit statements, so an audit insert that failed after the
  // claim had committed was answered "Nothing was saved" while the request was
  // already rejected, with no REJECT row in the audit ledger. The envelope is
  // built before the transaction opens (DG-06).
  const env = await getAuditEnvelope(me.id);
  await prisma.$transaction(async (tx) => {
    // QA-C13: atomic claim (PROD-001) so a reject racing a concurrent approve/reject
    // can't double-decide — the loser aborts before writing an audit row.
    const claim = await tx.customerEdit.updateMany({
      where: { id: editId, state: EditState.SUBMITTED, isReactivation: true },
      data: {
        state: EditState.NEEDS_CORRECTION,
        pendingRole: null,
        reviewedById: me.id,
        reviewedAt: new Date(),
        decisionReason: reason,
      },
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'NOT_PENDING',
        'This reactivation was just decided by another reviewer. Refresh to see the current state.'
      );
    }
    await writeAudit(tx, env, {
      action: 'REJECT',
      entityType: 'CustomerEdit',
      entityId: editId,
      reason,
    });
  });
  revalidatePath('/reactivations');
}
