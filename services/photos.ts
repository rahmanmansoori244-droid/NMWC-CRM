'use server';

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { Role, AttachmentKind, type Prisma } from '@prisma/client';
import { ForbiddenError, ValidationError, NotFoundError } from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';
import { loadScope, assertCanAccessAttachment } from '@/lib/access';

const customerAttach = z.object({
  attachmentId: z.string().cuid(),
  customerId: z.string().cuid(),
  slot: z.literal('CR'),
});

const branchAttach = z.object({
  attachmentId: z.string().cuid(),
  branchId: z.string().cuid(),
  slot: z.enum(['SHOP', 'SIGNBOARD', 'FREE']),
});

const attachSchema = z.union([customerAttach, branchAttach]);

/**
 * Wire a freshly-uploaded Attachment to a customer or branch slot.
 *
 * QA-004 fix: the attachment must have been uploaded by the calling user
 * AND must not yet be wired to anything. STEWARD/MANAGER can bypass the
 * uploader check (they may need to attach someone else's photo) but still
 * cannot reuse already-wired attachments.
 */
export async function attachPhotoAction(input: z.input<typeof attachSchema>) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  const parsed = attachSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const data = parsed.data;

  const att = await prisma.attachment.findUnique({ where: { id: data.attachmentId } });
  if (!att) throw new NotFoundError('Attachment not found.');

  // QA-004 — ownership: the attachment must belong to the caller (or admin role).
  const isAdmin = session.user.role === Role.STEWARD || session.user.role === Role.MANAGER;
  if (!isAdmin && att.capturedById !== session.user.id) {
    throw new NotFoundError('Attachment not found.');
  }
  // QA-004 — must be a fresh upload, not already attached anywhere.
  if (att.customerId || att.branchId || att.branchExtraId) {
    throw new ValidationError({ attachmentId: 'Attachment already wired to a slot.' });
  }

  if ('customerId' in data) {
    const c = await prisma.customer.findFirst({
      where: { id: data.customerId, deletedAt: null },
      include: { branches: { where: { deletedAt: null } } },
    });
    if (!c) throw new NotFoundError('Customer not found.');
    if (session.user.role === Role.SALESMAN) {
      const me = await prisma.user.findUniqueOrThrow({
        where: { id: session.user.id },
        select: { ownedRouteId: true },
      });
      if (!c.branches.some((b) => b.routeId === me.ownedRouteId)) {
        throw new ForbiddenError('Customer not on your route.');
      }
    }
    await prisma.$transaction(async (tx) => {
      // QA-044: capture previous attachment for audit + GC
      const prev = c.crPhotoId;
      await tx.attachment.update({
        where: { id: att.id },
        data: { customerId: c.id, kind: AttachmentKind.CR },
      });
      await tx.customer.update({
        where: { id: c.id },
        data: { crPhotoId: att.id, lastEditedById: session.user.id },
      });
      const fresh = await tx.customer.findUniqueOrThrow({
        where: { id: c.id },
        include: { branches: { where: { deletedAt: null } } },
      });
      const cScore = scoreCustomer(fresh, fresh.branches);
      await tx.customer.update({ where: { id: c.id }, data: { completenessScore: cScore } });
      await tx.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'UPDATE',
          entityType: 'Customer',
          entityId: c.id,
          before: { crPhotoId: prev } as unknown as Prisma.InputJsonValue,
          after: { crPhotoId: att.id } as unknown as Prisma.InputJsonValue,
          reason: 'CR photo attached',
        },
      });
    });
  } else {
    const b = await prisma.branch.findFirst({
      where: { id: data.branchId, deletedAt: null },
      include: { customer: { select: { id: true, branches: { where: { deletedAt: null } } } } },
    });
    if (!b) throw new NotFoundError('Branch not found.');
    if (session.user.role === Role.SALESMAN) {
      const me = await prisma.user.findUniqueOrThrow({
        where: { id: session.user.id },
        select: { ownedRouteId: true },
      });
      if (b.routeId !== me.ownedRouteId) {
        throw new ForbiddenError('Branch not on your route.');
      }
    }

    await prisma.$transaction(async (tx) => {
      const updateBranch: Prisma.BranchUpdateInput = { lastEditedById: session.user.id };
      if (data.slot === 'SHOP') {
        await tx.attachment.update({
          where: { id: att.id },
          data: { branchId: b.id, kind: AttachmentKind.SHOP },
        });
        updateBranch.shopPhoto = { connect: { id: att.id } };
        await tx.branch.update({ where: { id: b.id }, data: updateBranch });
      } else if (data.slot === 'SIGNBOARD') {
        await tx.attachment.update({
          where: { id: att.id },
          data: { branchId: b.id, kind: AttachmentKind.SIGNBOARD },
        });
        updateBranch.signboardPhoto = { connect: { id: att.id } };
        await tx.branch.update({ where: { id: b.id }, data: updateBranch });
      } else {
        await tx.attachment.update({
          where: { id: att.id },
          data: { branchExtraId: b.id, branchId: b.id, kind: AttachmentKind.FREE },
        });
      }

      const refreshed = await tx.branch.findUniqueOrThrow({ where: { id: b.id } });
      const bScore = scoreBranch(refreshed);
      await tx.branch.update({ where: { id: b.id }, data: { completenessScore: bScore } });

      const fresh = await tx.customer.findUniqueOrThrow({
        where: { id: b.customerId },
        include: { branches: { where: { deletedAt: null } } },
      });
      const cScore = scoreCustomer(fresh, fresh.branches);
      await tx.customer.update({
        where: { id: b.customerId },
        data: { completenessScore: cScore },
      });
      await tx.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'UPDATE',
          entityType: 'Branch',
          entityId: b.id,
          after: { slot: data.slot, attachmentId: att.id } as unknown as Prisma.InputJsonValue,
          reason: 'photo attached',
        },
      });
    });
  }

  logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach');
  if ('customerId' in data) revalidatePath(`/customers/${data.customerId}`);
  return { ok: true as const };
}

/**
 * Remove an attachment.
 *
 * QA-003 fix: previously any logged-in user could delete any attachment by ID.
 * Now requires the caller to either own the capture OR have access to the
 * attached customer. Soft-delete in DB; R2 object retained for 30-day GC.
 */
export async function detachPhotoAction(input: { attachmentId: string }) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  const att = await prisma.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!att) throw new NotFoundError('Attachment not found.');

  // QA-003 — ownership / scope check.
  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  const scope = await loadScope(session.user.id);
  await assertCanAccessAttachment(sessionUser, att, scope);

  // VIEWER never deletes
  if (session.user.role === Role.VIEWER) {
    throw new ForbiddenError('Read-only role cannot delete photos.');
  }
  // SALESMAN must be the capturer (extra layer beyond scope check)
  if (session.user.role === Role.SALESMAN && att.capturedById !== session.user.id) {
    throw new ForbiddenError('You can only remove photos you captured.');
  }

  await prisma.$transaction(async (tx) => {
    // Detach from any slots that point to this attachment
    await tx.customer.updateMany({
      where: { crPhotoId: att.id },
      data: { crPhotoId: null },
    });
    await tx.branch.updateMany({
      where: { shopPhotoId: att.id },
      data: { shopPhotoId: null },
    });
    await tx.branch.updateMany({
      where: { signboardPhotoId: att.id },
      data: { signboardPhotoId: null },
    });
    // Soft-delete: mark with a special r2Key prefix so the row survives audit
    // queries but no longer matches dedupe lookups, and a future GC job knows
    // it's safe to remove from R2 after a grace period.
    await tx.attachment.update({
      where: { id: att.id },
      data: {
        r2Key: `__deleted__/${new Date().toISOString()}/${att.r2Key}`,
        hash: null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        action: 'UPDATE',
        entityType: 'Attachment',
        entityId: att.id,
        reason: 'photo removed (soft-delete)',
      },
    });
  });
  logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.detach');
  return { ok: true as const };
}
