'use server';

import { prisma } from '@/lib/db';
import { Role, EditState, EditTarget, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
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
import { stepDeadline } from '@/lib/approval-chains';
import { STAGE_SLA_MINUTES, DEFAULT_STAGE_SLA_MIN } from '@/lib/working-hours';

async function require(role?: Role[]) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (role && !role.includes(session.user.role)) {
    throw new ForbiddenError(`Role ${session.user.role} not allowed.`);
  }
  return session.user;
}

/**
 * Salesman submits a reactivation request for a CLOSED branch.
 *
 * QA-008 fix: requires a fresh photo (≤24h old) attached to this branch as
 * evidence. The salesman captures the photo first via PhotoCaptureSlot (which
 * sets Attachment.branchExtraId or shopPhotoId), then submits this action with
 * the attachment id.
 */
export async function requestReactivationAction(
  formData: FormData
): SafeAction<{ editId: string }> {
  return runAction(() => requestReactivationCore(formData));
}

async function requestReactivationCore(formData: FormData): Promise<{ editId: string }> {
  const me = await require([Role.SALESMAN]);
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
    select: { ownedRouteId: true },
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
  const edit = await prisma.customerEdit.create({
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
    },
  });

  logger.info({ editId: edit.id, by: me.id }, 'reactivation.request');
  revalidatePath('/work');
  revalidatePath(`/customers/${branch.customerId}`);
  return { editId: edit.id };
}

/**
 * Salesman marks a branch as CLOSED. Requires a fresh photo (≤24h old) of the
 * closed shop attached as the `shopPhotoId` slot or as a free photo.
 */
export async function markBranchClosedAction(
  formData: FormData
): SafeAction<{ editId: string }> {
  return runAction(() => markBranchClosedCore(formData));
}

async function markBranchClosedCore(formData: FormData): Promise<{ editId: string }> {
  const me = await require([Role.SALESMAN]);
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
    select: { ownedRouteId: true },
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
  const edit = await prisma.customerEdit.create({
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
    },
  });
  logger.info({ editId: edit.id, by: me.id }, 'branch.close.request');
  revalidatePath('/work');
  revalidatePath(`/customers/${branch.customerId}`);
  return { editId: edit.id };
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
    await tx.auditLog.create({
      data: {
        actorId: me.id,
        action: 'REACTIVATE',
        entityType: 'Branch',
        entityId: edit.branchId!,
        reason: edit.decisionReason ?? undefined,
      },
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

  // QA-C13: atomic claim (PROD-001) so a reject racing a concurrent approve/reject
  // can't double-decide — the loser aborts before writing an audit row.
  const claim = await prisma.customerEdit.updateMany({
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
  await prisma.auditLog.create({
    data: {
      actorId: me.id,
      action: 'REJECT',
      entityType: 'CustomerEdit',
      entityId: editId,
      reason,
    },
  });
  revalidatePath('/reactivations');
}
