'use server';

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { Role, AttachmentKind, type Attachment, type Prisma } from '@prisma/client';
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';
import { loadScope, assertCanAccessAttachment, assertCanEditCustomer } from '@/lib/access';
import { ALREADY_ATTACHED_MESSAGE } from '@/lib/photo-attach';

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
 * Whether the attachment's own columns put it on exactly the target asked for,
 * as an attach to that target leaves them (the kind included: an attach sets
 * it). The slot column itself is read with the target, after the scope checks.
 */
function wiredTo(
  att: Pick<Attachment, 'kind' | 'customerId' | 'branchId' | 'branchExtraId' | 'editId'>,
  data: z.output<typeof attachSchema>
): boolean {
  if (att.editId) return false;
  if ('customerId' in data) {
    return (
      att.kind === AttachmentKind.CR &&
      att.customerId === data.customerId &&
      !att.branchId &&
      !att.branchExtraId
    );
  }
  if (att.customerId || att.branchId !== data.branchId) return false;
  if (data.slot === 'FREE') {
    return att.kind === AttachmentKind.FREE && att.branchExtraId === data.branchId;
  }
  return att.kind === AttachmentKind[data.slot] && !att.branchExtraId;
}

const detachSchema = z.object({ attachmentId: z.string().cuid() });

/**
 * Wire a freshly-uploaded Attachment to a customer or branch slot.
 *
 * Trust-boundary checks layered here (RBAC-05-011, NEW-PHOTO-001/002/003):
 *   • Only SALESMAN and STEWARD may attach photos. SUPERVISOR / VIEWER never;
 *     PRD §4 says they don't capture photos. MANAGER goes through the
 *     dedicated rewire path with `forceOverrideAction` (out of scope here).
 *   • Attachment must not be soft-deleted (`deletedAt`).
 *   • Attachment must be a fresh upload (no customerId/branchId/branchExtraId/
 *     editId) — or already on exactly the slot asked for, which is answered ok
 *     with nothing written (the photo slot's re-send of an unanswered attach).
 *   • Attachment must have been uploaded by the caller (Steward bypass for
 *     legitimate "rewire orphan" — flagged with FORCE_OVERRIDE audit row).
 *   • slot must match the attachment.kind (no swapping a SHOP photo into the
 *     CR slot to fool a supervisor's review).
 *   • Replacing an existing slot soft-deletes the previous Attachment so it
 *     no longer dedupes against future uploads and is eligible for R2 GC.
 */
/**
 * SafeAction-wrapped public entry. Photo attach errors (slot/kind mismatch,
 * route scope, soft-deleted attachment) must be visible to the salesman so
 * they can act — the SC-render-omitted generic was useless for diagnosis.
 * The photo slot reaches it through app/api/photos/attach, not as a server
 * action: one that stalls cannot be aborted, and queues every later one.
 */
export async function attachPhotoAction(
  input: z.input<typeof attachSchema>
): SafeAction<void> {
  return runAction(async () => {
    await attachPhotoCore(input);
  });
}

async function attachPhotoCore(input: z.input<typeof attachSchema>) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  const parsed = attachSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const data = parsed.data;

  // RBAC-05-011: SUPERVISOR / VIEWER cannot reach attach. SALESMAN + STEWARD
  // are the legitimate callers. MANAGER may attach but is now region-scoped
  // fail-closed (SEC-H1) at the customer/branch checks below — previously it
  // had a silent, UNSCOPED bypass that let a Manager attach to (and destroy the
  // existing photo of) any customer nationwide. In-scope Manager attaches of a
  // photo they did not capture are logged as FORCE_OVERRIDE on both paths.
  if (
    session.user.role !== Role.SALESMAN &&
    session.user.role !== Role.STEWARD &&
    session.user.role !== Role.MANAGER
  ) {
    throw new ForbiddenError('Your role cannot attach photos.');
  }

  const att = await prisma.attachment.findUnique({ where: { id: data.attachmentId } });
  if (!att) throw new NotFoundError('Attachment not found.');
  // UXI-008: never act on a soft-deleted attachment.
  if (att.deletedAt) throw new NotFoundError('Attachment not found.');

  const isAdmin = session.user.role === Role.STEWARD || session.user.role === Role.MANAGER;
  if (!isAdmin && att.capturedById !== session.user.id) {
    throw new NotFoundError('Attachment not found.');
  }
  // Must be a fresh upload, not already attached anywhere else. `editId` counts
  // as wired: a photo claimed by a pending CREATE request must not be re-routed
  // onto an unrelated customer/branch slot (Phase 1 creation flow). A photo
  // already on the slot asked for is not refused: once the checks below pass
  // and the slot still holds it, the answer is ok and nothing is written. The
  // photo slot re-sends an attach that got no answer, and this is how it learns
  // the first one landed (post-merge review of 30ec23a: it read the refusal as
  // "landed" instead, and a re-send answered "the database did not respond"
  // left a photo that was on the slot showing as failed).
  const wired = Boolean(att.customerId || att.branchId || att.branchExtraId || att.editId);
  if (wired && !wiredTo(att, data)) {
    throw new ValidationError({ attachmentId: ALREADY_ATTACHED_MESSAGE });
  }
  // NEW-PHOTO-001: slot must match the attachment.kind, except FREE which
  // accepts anything (it's a generic extra-photo bucket).
  const expectedKindForSlot: Record<string, AttachmentKind> = {
    CR: AttachmentKind.CR,
    SHOP: AttachmentKind.SHOP,
    SIGNBOARD: AttachmentKind.SIGNBOARD,
  };
  if (data.slot !== 'FREE') {
    const expected = expectedKindForSlot[data.slot];
    if (expected && att.kind !== expected) {
      throw new ValidationError({
        attachmentId: `Slot ${data.slot} requires a ${expected} photo (this one is ${att.kind}).`,
      });
    }
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
    } else if (session.user.role === Role.MANAGER) {
      // SEC-H1 (completeness): a Manager attaching a CR photo must be
      // region-scoped, exactly like submitEditCore and detachPhotoCore. Without
      // this a Manager (even one with empty managedRegions) could attach to —
      // and destructively soft-delete the existing CR photo of — ANY customer
      // nationwide. assertCanEditCustomer is fail-closed for empty regions.
      const scope = await loadScope(session.user.id);
      assertCanEditCustomer(
        { id: session.user.id, role: session.user.role, username: session.user.username },
        c,
        scope
      );
    }
    if (wired) {
      if (c.crPhotoId !== att.id) throw new ValidationError({ attachmentId: ALREADY_ATTACHED_MESSAGE });
      logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach.already_on_slot');
      return { ok: true as const };
    }
    // DG-06: capture the request envelope before opening the transaction.
    const env = await getAuditEnvelope(session.user.id);
    await prisma.$transaction(async (tx) => {
      // NEW-PHOTO-003: soft-delete the prior CR photo on replacement so it no
      // longer dedupes against future uploads, no longer counts in storage,
      // and the R2 GC cron has a clean signal to remove the object.
      const prev = c.crPhotoId;
      if (prev && prev !== att.id) {
        await tx.attachment.update({
          where: { id: prev },
          data: { deletedAt: new Date(), hash: null },
        });
      }
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
      await writeAudit(tx, env, {
        // FORCE_OVERRIDE when an admin attaches a photo they didn't capture.
        action: isAdmin && att.capturedById !== session.user.id ? 'FORCE_OVERRIDE' : 'UPDATE',
        entityType: 'Customer',
        entityId: c.id,
        before: { crPhotoId: prev } as unknown as Prisma.InputJsonValue,
        after: { crPhotoId: att.id } as unknown as Prisma.InputJsonValue,
        reason: 'CR photo attached',
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
    } else if (session.user.role === Role.MANAGER) {
      // SEC-H1 (completeness): region-scope the Manager branch-photo attach too,
      // via the branch's owning customer. Fail-closed for empty managedRegions.
      const scope = await loadScope(session.user.id);
      assertCanEditCustomer(
        { id: session.user.id, role: session.user.role, username: session.user.username },
        b.customer,
        scope
      );
    }
    if (wired) {
      // FREE has no slot column: the attachment's own columns are the wiring.
      const holds =
        data.slot === 'SHOP'
          ? b.shopPhotoId === att.id
          : data.slot === 'SIGNBOARD'
            ? b.signboardPhotoId === att.id
            : true;
      if (!holds) throw new ValidationError({ attachmentId: ALREADY_ATTACHED_MESSAGE });
      logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach.already_on_slot');
      return { ok: true as const };
    }

    // DG-06: same as the CR branch — envelope before the transaction.
    const env = await getAuditEnvelope(session.user.id);
    await prisma.$transaction(async (tx) => {
      const updateBranch: Prisma.BranchUpdateInput = { lastEditedById: session.user.id };
      // NEW-PHOTO-003: soft-delete the prior shop/signboard photo on
      // replacement so storage doesn't balloon and dedupe stays correct.
      if (data.slot === 'SHOP') {
        if (b.shopPhotoId && b.shopPhotoId !== att.id) {
          await tx.attachment.update({
            where: { id: b.shopPhotoId },
            data: { deletedAt: new Date(), hash: null },
          });
        }
        await tx.attachment.update({
          where: { id: att.id },
          data: { branchId: b.id, kind: AttachmentKind.SHOP },
        });
        updateBranch.shopPhoto = { connect: { id: att.id } };
        await tx.branch.update({ where: { id: b.id }, data: updateBranch });
      } else if (data.slot === 'SIGNBOARD') {
        if (b.signboardPhotoId && b.signboardPhotoId !== att.id) {
          await tx.attachment.update({
            where: { id: b.signboardPhotoId },
            data: { deletedAt: new Date(), hash: null },
          });
        }
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
      await writeAudit(tx, env, {
        // SEC-H1: mirror the CR path — an admin (Steward/Manager) attaching a
        // branch photo they did not capture is a FORCE_OVERRIDE, so the audit
        // trail flags it even though the write is now region-scoped.
        action: isAdmin && att.capturedById !== session.user.id ? 'FORCE_OVERRIDE' : 'UPDATE',
        entityType: 'Branch',
        entityId: b.id,
        after: { slot: data.slot, attachmentId: att.id } as unknown as Prisma.InputJsonValue,
        reason: 'photo attached',
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
 * UXI-008 / NEW-PHOTO-002 — soft-delete uses the new `deletedAt` column
 * (not the previous r2Key-rename sentinel) so every Attachment lookup that
 * filters `deletedAt: null` correctly hides the row. The slot clear is
 * scoped to the caller's reachable customer/branch so a Steward detach
 * doesn't blank a slot on a customer the actor never had scope over.
 * The photo slot reaches it through app/api/photos/detach.
 */
export async function detachPhotoAction(
  input: { attachmentId: string }
): SafeAction<void> {
  return runAction(async () => {
    await detachPhotoCore(input);
  });
}

async function detachPhotoCore(input: { attachmentId: string }) {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  // The id goes into a `where`: unchecked, an object there is a filter (and a
  // missing one no filter at all), acting on a photo the caller did not name.
  const parsed = detachSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({ attachmentId: 'A valid photo id is required.' });
  }
  const att = await prisma.attachment.findFirst({
    where: { id: parsed.data.attachmentId, deletedAt: null },
  });
  if (!att) throw new NotFoundError('Attachment not found.');

  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  const scope = await loadScope(session.user.id);
  await assertCanAccessAttachment(sessionUser, att, scope);

  if (session.user.role === Role.VIEWER) {
    throw new ForbiddenError('Read-only role cannot delete photos.');
  }
  if (session.user.role === Role.SALESMAN && att.capturedById !== session.user.id) {
    throw new ForbiddenError('You can only remove photos you captured.');
  }

  // NEW-PHOTO-002: only blank the slot on the customer/branch that this
  // attachment is *currently* attached to (not "every customer that ever
  // pointed at this hash"). Combined with NEW-PHOTO-003 (replacement
  // soft-deletes the prior), each Attachment row points to at most one slot.
  // DG-06: envelope before the transaction (see attachPhotoCore).
  const env = await getAuditEnvelope(session.user.id);
  await prisma.$transaction(async (tx) => {
    if (att.customerId) {
      await tx.customer.updateMany({
        where: { id: att.customerId, crPhotoId: att.id },
        data: { crPhotoId: null },
      });
    }
    if (att.branchId) {
      await tx.branch.updateMany({
        where: { id: att.branchId, shopPhotoId: att.id },
        data: { shopPhotoId: null },
      });
      await tx.branch.updateMany({
        where: { id: att.branchId, signboardPhotoId: att.id },
        data: { signboardPhotoId: null },
      });
    }
    // UXI-008: real soft-delete column. Keep the r2Key as-is for the GC job
    // to find the object; clear the hash so dedup queries miss the row.
    await tx.attachment.update({
      where: { id: att.id },
      data: { deletedAt: new Date(), hash: null },
    });
    // Rollup parity with attachPhoto (final-hunt #10/#20): removing a photo lowers
    // completeness, so recompute the affected branch + customer scores. Without
    // this, detach left the completenessScore stale-HIGH — a customer that lost its
    // CR/shop photo still read as "complete" on the dashboard and in prioritization.
    if (att.branchId) {
      const b = await tx.branch.findUnique({ where: { id: att.branchId } });
      if (b) {
        await tx.branch.update({ where: { id: b.id }, data: { completenessScore: scoreBranch(b) } });
        const fresh = await tx.customer.findUnique({
          where: { id: b.customerId },
          include: { branches: { where: { deletedAt: null } } },
        });
        if (fresh) {
          await tx.customer.update({ where: { id: fresh.id }, data: { completenessScore: scoreCustomer(fresh, fresh.branches) } });
        }
      }
    }
    if (att.customerId) {
      const fresh = await tx.customer.findUnique({
        where: { id: att.customerId },
        include: { branches: { where: { deletedAt: null } } },
      });
      if (fresh) {
        await tx.customer.update({ where: { id: fresh.id }, data: { completenessScore: scoreCustomer(fresh, fresh.branches) } });
      }
    }
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'Attachment',
      entityId: att.id,
      reason: 'photo removed (soft-delete)',
    });
  });
  logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.detach');
  return { ok: true as const };
}
