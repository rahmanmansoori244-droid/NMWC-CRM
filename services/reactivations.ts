'use server';

import { prisma } from '@/lib/db';
import { Role, EditState, EditTarget, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError, ValidationError, NotFoundError } from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';

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
export async function requestReactivationAction(formData: FormData) {
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
  const att = await prisma.attachment.findUnique({ where: { id: attachmentId } });
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
  if (att.branchId !== branch.id && att.branchExtraId !== branch.id) {
    throw new ValidationError({
      attachmentId: 'Photo is not attached to this branch.',
    });
  }

  const edit = await prisma.customerEdit.create({
    data: {
      target: EditTarget.BRANCH,
      branchId: branch.id,
      customerId: branch.customerId,
      state: EditState.SUBMITTED,
      submittedById: me.id,
      submittedAt: new Date(),
      isReactivation: true,
      decisionReason: reason,
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
export async function markBranchClosedAction(formData: FormData) {
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

  const att = await prisma.attachment.findUnique({ where: { id: attachmentId } });
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
  if (att.branchId !== branch.id && att.branchExtraId !== branch.id) {
    throw new ValidationError({
      attachmentId: 'Photo is not attached to this branch.',
    });
  }

  // Submit as a regular CustomerEdit so a Supervisor approves the closure.
  const edit = await prisma.customerEdit.create({
    data: {
      target: EditTarget.BRANCH,
      branchId: branch.id,
      customerId: branch.customerId,
      state: EditState.SUBMITTED,
      submittedById: me.id,
      submittedAt: new Date(),
      decisionReason: reason,
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
export async function approveReactivationAction(formData: FormData) {
  const me = await require([Role.MANAGER]);
  const editId = String(formData.get('editId') ?? '');
  if (!editId) throw new ValidationError({ editId: 'required' });

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: { branch: true, customer: true },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (!edit.isReactivation) throw new ValidationError({ editId: 'Not a reactivation.' });
  if (edit.state !== EditState.SUBMITTED) {
    throw new ValidationError({ editId: `Edit is in state ${edit.state}.` });
  }
  if (!edit.branch || !edit.customer) throw new NotFoundError('Branch / customer missing.');

  await prisma.$transaction(async (tx) => {
    await tx.branch.update({
      where: { id: edit.branchId! },
      data: { status: 'ACTIVE', lastEditedById: me.id },
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
    await tx.customerEdit.update({
      where: { id: editId },
      data: { state: EditState.APPROVED, reviewedById: me.id, reviewedAt: new Date() },
    });
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

export async function rejectReactivationAction(formData: FormData) {
  const me = await require([Role.MANAGER]);
  const editId = String(formData.get('editId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!editId) throw new ValidationError({ editId: 'required' });
  if (reason.length < 5) throw new ValidationError({ reason: '5+ chars required' });

  await prisma.customerEdit.update({
    where: { id: editId },
    data: {
      state: EditState.NEEDS_CORRECTION,
      reviewedById: me.id,
      reviewedAt: new Date(),
      decisionReason: reason,
    },
  });
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
