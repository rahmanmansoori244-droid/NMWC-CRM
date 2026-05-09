'use server';

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { Role, AttachmentKind, type Prisma } from '@prisma/client';
import { ForbiddenError, ValidationError, NotFoundError } from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';

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
 * This happens AS the salesman captures (not at form submit), so photos go
 * live immediately. The corresponding edit (field changes) still flows
 * through Supervisor approval.
 *
 * Permissions:
 *   - Salesman: branch must be on his route
 *   - Supervisor: branch must be on his team's route
 *   - Manager / Steward: any
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
        // FREE: link via branchExtra relation (Attachment.branchExtraId)
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
    });
  }

  logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach');
  if ('customerId' in data) revalidatePath(`/customers/${data.customerId}`);
  return { ok: true as const };
}

export async function detachPhotoAction(input: { attachmentId: string }) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  const att = await prisma.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!att) throw new NotFoundError('Attachment not found.');

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
    await tx.attachment.delete({ where: { id: att.id } });
  });
  return { ok: true as const };
}
