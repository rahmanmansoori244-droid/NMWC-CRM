'use server';

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { Role, AttachmentKind, EditState, type Attachment, type Prisma } from '@prisma/client';
import {
  ConflictError,
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
import { CR_DOCUMENT_LOCKED_MESSAGE, PHOTO_WRITER_ROLES, isFieldLocked } from '@/lib/permissions';
import {
  ALREADY_ATTACHED_MESSAGE,
  PHOTO_CHANGED_MESSAGE,
  PHOTO_CONFLICT_MESSAGE,
  PHOTO_GONE_MESSAGE,
  PHOTO_IN_REVIEW_MESSAGE,
  PHOTO_TARGET_CHANGED_MESSAGE,
  UNWIRED_LIVE,
} from '@/lib/photo-attach';
import { lockCustomerRow } from '@/lib/locks';

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

// The customer's row lock (lib/locks.ts), taken before anything else in a
// photo transaction. Attach and Remove reach the server over plain fetches
// now (9edcbad), so two photos taken on one phone can land together, and each
// recomputes the completeness score from what it reads: without the lock the
// later one wrote a score that left out the other photo (pre-merge review).
const lockCustomer = lockCustomerRow;

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

/**
 * N06: the attach's claim, re-asserting at the moment it writes what the checks
 * in attachPhotoCore read before any lock — live and on no slot, claimed by no
 * new-customer request, the caller's own capture (a Steward or Manager may
 * attach anyone's) and the slot's kind (FREE takes any). In the gap a Remove
 * could soft-delete the photo, a new-customer request claim it, or another
 * attach wire it elsewhere; the unconditional update that stood here then put a
 * deleted photo on a live slot, or one photo on two.
 */
function claimWhere(
  id: string,
  data: z.output<typeof attachSchema>,
  capturedById: string | null
): Prisma.AttachmentWhereInput {
  return {
    id,
    ...UNWIRED_LIVE,
    editId: null,
    ...(capturedById ? { capturedById } : {}),
    ...(data.slot === 'FREE' ? {} : { kind: AttachmentKind[data.slot] }),
  };
}

/**
 * A claim that changed no row: read again, under the customer's lock. The photo
 * already on exactly the slot asked for — an earlier send of this attach landed
 * while this one waited for the lock — is ok with nothing written, the photo
 * slot's re-send contract; anything else is refused before a write.
 */
async function assertOnRequestedSlot(
  tx: Prisma.TransactionClient,
  id: string,
  data: z.output<typeof attachSchema>
): Promise<void> {
  const now = await tx.attachment.findUnique({ where: { id } });
  let holds = false;
  if (now && !now.deletedAt && wiredTo(now, data)) {
    if ('customerId' in data) {
      const c = await tx.customer.findUnique({ where: { id: data.customerId }, select: { crPhotoId: true } });
      holds = c?.crPhotoId === id;
    } else if (data.slot === 'FREE') {
      holds = true;
    } else {
      const b = await tx.branch.findUnique({
        where: { id: data.branchId },
        select: { shopPhotoId: true, signboardPhotoId: true },
      });
      holds = (data.slot === 'SHOP' ? b?.shopPhotoId : b?.signboardPhotoId) === id;
    }
  }
  if (!holds) throw new ConflictError('PHOTO_CONFLICT', PHOTO_CONFLICT_MESSAGE);
}

const detachSchema = z.object({ attachmentId: z.string().cuid() });

/**
 * Wire a freshly-uploaded Attachment to a customer or branch slot.
 *
 * Trust-boundary checks layered here (RBAC-05-011, NEW-PHOTO-001/002/003):
 *   • Only PHOTO_WRITER_ROLES (SALESMAN, STEWARD, MANAGER) may attach photos,
 *     the same roles presign and finalize admit (ENH-3). MANAGER is
 *     region-scoped (SEC-H1, below).
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
 *   • Those checks read the photo before any lock, so the transaction first
 *     claims it with a guarded write (claimWhere, N06) and writes nothing else
 *     unless that claim took exactly the one row.
 *   • They read the target before any lock too, so under the lock and before
 *     the claim the transaction reads it again and refuses (PHOTO_CHANGED) a
 *     customer removed or merged away since, or a branch removed or moved to
 *     another customer since (the mirror of Remove's X-PHOTO-1).
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
  const session = { user: await requireActor() }; // F15: refuses a session that must change its password
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
  if (!PHOTO_WRITER_ROLES.includes(session.user.role)) {
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

  // Keep the existing actor-scope policy; recheck the target under its lock.
  const managerScope = session.user.role === Role.MANAGER ? await loadScope(session.user.id) : null;
  let ownedRouteId: string | null = null;

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
      ownedRouteId = me.ownedRouteId;
      if (!c.branches.some((b) => b.routeId === ownedRouteId)) {
        throw new ForbiddenError('Customer not on your route.');
      }
      // Owner decision 2 (2026-10-07): the CR document of a CREDIT customer
      // follows its finance-locked CR number. An attach goes live at once and
      // an update request cannot carry a photo for approval, so a salesman's is
      // refused here, before anything is written; a Manager or the Steward
      // replaces it. Checked again under the lock below (terms can change).
      if (isFieldLocked('crPhoto', session.user, c)) {
        throw new ForbiddenError(CR_DOCUMENT_LOCKED_MESSAGE);
      }
    } else if (session.user.role === Role.MANAGER) {
      // SEC-H1 (completeness): a Manager attaching a CR photo must be
      // region-scoped, exactly like submitEditCore and detachPhotoCore. Without
      // this a Manager (even one with empty managedRegions) could attach to —
      // and destructively soft-delete the existing CR photo of — ANY customer
      // nationwide. assertCanEditCustomer is fail-closed for empty regions.
      assertCanEditCustomer(
        { id: session.user.id, role: session.user.role, username: session.user.username },
        c,
        managerScope!
      );
    }
    if (wired) {
      if (c.crPhotoId !== att.id) throw new ValidationError({ attachmentId: ALREADY_ATTACHED_MESSAGE });
      logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach.already_on_slot');
      return { ok: true as const };
    }
    // DG-06: capture the request envelope before opening the transaction.
    const env = await getAuditEnvelope(session.user.id);
    const claimed = await prisma.$transaction(async (tx) => {
      await lockCustomer(tx, c.id);
      // The customer as it stands under the lock, not as read before it (post-
      // merge review, 2026-09-29). A Steward's merge holding this lock while the
      // attach waited has tombstoned it and moved its branches and photos to the
      // winner by the time the lock is ours; claimed here, the photo landed on the
      // tombstone, out of every salesman's reach, and was answered ok. Refused
      // before the claim, as Remove refuses a photo that moved (X-PHOTO-1).
      const customerNow = await tx.customer.findUnique({
        where: { id: c.id },
        select: {
          deletedAt: true,
          paymentTerms: true,
          branches: { where: { deletedAt: null }, select: { routeId: true, regionId: true, deletedAt: true } },
        },
      });
      if (!customerNow || customerNow.deletedAt) {
        throw new ConflictError('PHOTO_CHANGED', PHOTO_TARGET_CHANGED_MESSAGE);
      }
      // An import may have moved the last reachable branch while we waited.
      // Refuse before claiming the upload, replacing a photo or rescoring.
      if (session.user.role === Role.SALESMAN && !customerNow.branches.some((b) => b.routeId === ownedRouteId)) {
        throw new ForbiddenError('Customer not on your route.');
      }
      // Owner decision 2: the terms as they stand under the lock.
      if (isFieldLocked('crPhoto', session.user, customerNow)) {
        throw new ForbiddenError(CR_DOCUMENT_LOCKED_MESSAGE);
      }
      if (managerScope) assertCanEditCustomer(session.user, customerNow, managerScope);
      // N06: claim first. Refused, the previous photo and the slot are untouched.
      const claim = await tx.attachment.updateMany({
        where: claimWhere(att.id, data, isAdmin ? null : session.user.id),
        data: { customerId: c.id, kind: AttachmentKind.CR },
      });
      if (claim.count !== 1) {
        await assertOnRequestedSlot(tx, att.id, data);
        return false;
      }
      // NEW-PHOTO-003: soft-delete the prior CR photo on replacement so it no
      // longer dedupes against future uploads, no longer counts in storage,
      // and the R2 GC cron has a clean signal to remove the object. Read under
      // the lock: another attach may have replaced it since the read above.
      const prev = (await tx.customer.findUniqueOrThrow({ where: { id: c.id }, select: { crPhotoId: true } }))
        .crPhotoId;
      if (prev && prev !== att.id) {
        await tx.attachment.update({
          where: { id: prev },
          data: { deletedAt: new Date(), hash: null },
        });
      }
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
      return true;
    });
    if (!claimed) {
      logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach.already_on_slot');
      return { ok: true as const };
    }
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
      ownedRouteId = me.ownedRouteId;
      if (b.routeId !== ownedRouteId) {
        throw new ForbiddenError('Branch not on your route.');
      }
    } else if (session.user.role === Role.MANAGER) {
      // SEC-H1 (completeness): region-scope the Manager branch-photo attach too,
      // via the branch's owning customer. Fail-closed for empty managedRegions.
      assertCanEditCustomer(
        { id: session.user.id, role: session.user.role, username: session.user.username },
        b.customer,
        managerScope!
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
    const claimed = await prisma.$transaction(async (tx) => {
      await lockCustomer(tx, b.customerId);
      // The branch and its customer as they stand under the lock, as on the CR
      // path. A merge waited on here has moved the branch to the winner, whose
      // lock this transaction does not hold, and whose score it would leave
      // stale while rescoring the tombstone; an archive has removed both.
      const branchNow = await tx.branch.findUnique({
        where: { id: b.id },
        select: { customerId: true, deletedAt: true, routeId: true },
      });
      const customerNow = await tx.customer.findUnique({
        where: { id: b.customerId },
        select: { deletedAt: true, branches: { where: { deletedAt: null }, select: { routeId: true, regionId: true, deletedAt: true } } },
      });
      if (
        !branchNow ||
        branchNow.deletedAt ||
        branchNow.customerId !== b.customerId ||
        !customerNow ||
        customerNow.deletedAt
      ) {
        throw new ConflictError('PHOTO_CHANGED', PHOTO_TARGET_CHANGED_MESSAGE);
      }
      if (session.user.role === Role.SALESMAN && branchNow.routeId !== ownedRouteId) {
        throw new ForbiddenError('Branch not on your route.');
      }
      // Manager photo access remains customer-level overlap (F04 is an owner
      // decision); this rechecks that policy using the locked live branches.
      if (managerScope) assertCanEditCustomer(session.user, customerNow, managerScope);
      // N06: claim first, as on the CR path. An extra (FREE) photo is wired by
      // its own columns alone, so for it the claim is the whole attach.
      const claim = await tx.attachment.updateMany({
        where: claimWhere(att.id, data, isAdmin ? null : session.user.id),
        data:
          data.slot === 'FREE'
            ? { branchExtraId: b.id, branchId: b.id, kind: AttachmentKind.FREE }
            : { branchId: b.id, kind: AttachmentKind[data.slot] },
      });
      if (claim.count !== 1) {
        await assertOnRequestedSlot(tx, att.id, data);
        return false;
      }
      // The slots as they stand under the lock, not as read before it.
      const now = await tx.branch.findUniqueOrThrow({
        where: { id: b.id },
        select: { shopPhotoId: true, signboardPhotoId: true },
      });
      const updateBranch: Prisma.BranchUpdateInput = { lastEditedById: session.user.id };
      // NEW-PHOTO-003: soft-delete the prior shop/signboard photo on
      // replacement so storage doesn't balloon and dedupe stays correct.
      if (data.slot === 'SHOP') {
        if (now.shopPhotoId && now.shopPhotoId !== att.id) {
          await tx.attachment.update({
            where: { id: now.shopPhotoId },
            data: { deletedAt: new Date(), hash: null },
          });
        }
        updateBranch.shopPhoto = { connect: { id: att.id } };
        await tx.branch.update({ where: { id: b.id }, data: updateBranch });
      } else if (data.slot === 'SIGNBOARD') {
        if (now.signboardPhotoId && now.signboardPhotoId !== att.id) {
          await tx.attachment.update({
            where: { id: now.signboardPhotoId },
            data: { deletedAt: new Date(), hash: null },
          });
        }
        updateBranch.signboardPhoto = { connect: { id: att.id } };
        await tx.branch.update({ where: { id: b.id }, data: updateBranch });
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
      return true;
    });
    if (!claimed) {
      logger.info({ attachmentId: att.id, by: session.user.id }, 'photo.attach.already_on_slot');
      return { ok: true as const };
    }
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
  const session = { user: await requireActor() }; // F15: refuses a session that must change its password
  // The id goes into a `where`: unchecked, an object there is a filter (and a
  // missing one no filter at all), acting on a photo the caller did not name.
  const parsed = detachSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({ attachmentId: 'A valid photo id is required.' });
  }
  // Read removed or not: a photo already removed is answered PHOTO_GONE, and
  // only after every check below, so "not found" stays the scope's answer and
  // tells no one who could not remove it that the id exists.
  const att = await prisma.attachment.findFirst({
    where: { id: parsed.data.attachmentId },
  });
  if (!att) throw new NotFoundError('Attachment not found.');

  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  const scope = await loadScope(session.user.id);
  await assertCanAccessAttachment(sessionUser, att, scope);

  // Owner decision 2026-09-27: only the roles that can attach a photo may
  // remove one. This refused VIEWER alone, so a Supervisor, Accountant, Finance
  // Manager or GM could remove any photo they could see — though none of them
  // can attach one or submit an edit (pre-merge review).
  if (!PHOTO_WRITER_ROLES.includes(session.user.role)) {
    throw new ForbiddenError('Your role cannot remove photos.');
  }
  if (session.user.role === Role.SALESMAN && att.capturedById !== session.user.id) {
    throw new ForbiddenError('You can only remove photos you captured.');
  }
  // Owner decision 2 (2026-10-07): nor the CR document of a credit customer,
  // even one he took — removing it changes it as much as replacing it does.
  // Checked again under the lock below.
  const crOfCustomer = att.kind === AttachmentKind.CR ? att.customerId : null;
  if (session.user.role === Role.SALESMAN && crOfCustomer) {
    const owner = await prisma.customer.findUnique({
      where: { id: crOfCustomer },
      select: { paymentTerms: true },
    });
    if (owner && isFieldLocked('crPhoto', sessionUser, owner)) {
      throw new ForbiddenError(CR_DOCUMENT_LOCKED_MESSAGE);
    }
  }
  // Post-merge review (2026-09-29): the photo slot cleared on NOT_FOUND, taking
  // it to mean "removed already" — but the scope check above answers NOT_FOUND
  // too, for a customer archived or a route reassigned while the form was open,
  // and then the slot showed a photo removed that the server kept. Removed
  // already has its own code now, and the slot clears on that one alone.
  if (att.deletedAt) throw new ConflictError('PHOTO_GONE', PHOTO_GONE_MESSAGE);

  // NEW-PHOTO-002: only blank the slot on the customer/branch that this
  // attachment is *currently* attached to (not "every customer that ever
  // pointed at this hash"). Combined with NEW-PHOTO-003 (replacement
  // soft-deletes the prior), each Attachment row points to at most one slot.
  // DG-06: envelope before the transaction (see attachPhotoCore).
  const env = await getAuditEnvelope(session.user.id);
  const ownerId =
    att.customerId ??
    (att.branchId
      ? ((await prisma.branch.findUnique({ where: { id: att.branchId }, select: { customerId: true } }))
          ?.customerId ?? null)
      : null);
  // X-PHOTO-1: everything above — the checks, the owner, the slots to clear —
  // rests on a read taken before any lock, and for a photo on no slot no lock is
  // taken at all. An attach landing in the gap (the slot's stalled attach, then
  // Remove) left its slot on a photo removed here, which photo-gc later blanks
  // with no rescore and no audit row; a merge moving the photo or its branch to
  // another customer left that customer's slot and score unguarded. So the
  // photo is read again inside the transaction, and removed only if it still
  // sits where that read put it. Refused rather than followed: the checks
  // passed on the old wiring, and a lock taken on a second customer here could
  // deadlock. Nothing is written before the refusal.
  const wiring = {
    customerId: att.customerId,
    branchId: att.branchId,
    branchExtraId: att.branchExtraId,
    editId: att.editId,
  };
  await prisma.$transaction(async (tx) => {
    if (ownerId) await lockCustomer(tx, ownerId);
    const now = await tx.attachment.findFirst({ where: { id: att.id, deletedAt: null } });
    // Removed since the read above, by another Remove or replaced on its slot:
    // nothing to do, and the slot is told so — the answer it clears on.
    if (!now) throw new ConflictError('PHOTO_GONE', PHOTO_GONE_MESSAGE);
    // The owner found as ownerId was, now: a merge moves a branch, not its photos.
    const ownerNow =
      now.customerId ??
      (now.branchId
        ? ((await tx.branch.findUnique({ where: { id: now.branchId }, select: { customerId: true } }))
            ?.customerId ?? null)
        : null);
    const moved =
      now.customerId !== wiring.customerId ||
      now.branchId !== wiring.branchId ||
      now.branchExtraId !== wiring.branchExtraId ||
      now.editId !== wiring.editId ||
      ownerNow !== ownerId;
    if (moved) throw new ConflictError('PHOTO_CHANGED', PHOTO_CHANGED_MESSAGE);
    // A route/region move can commit while Remove waits for the customer
    // lock without changing the photo wiring. Recheck live customer scope
    // through tx before writing; retain F04's customer-level overlap rule.
    await assertCanAccessAttachment(sessionUser, now, scope, tx);
    // Owner decision 2: the customer's terms as they stand under the lock.
    if (session.user.role === Role.SALESMAN && crOfCustomer) {
      const owner = await tx.customer.findUnique({
        where: { id: crOfCustomer },
        select: { paymentTerms: true },
      });
      if (owner && isFieldLocked('crPhoto', sessionUser, owner)) {
        throw new ForbiddenError(CR_DOCUMENT_LOCKED_MESSAGE);
      }
    }
    // Launch browser suite: a photo of his new-customer request stays while the
    // request is with the approvers; removed, they reviewed a removed photo. The
    // request's row is locked, as its submit's state write locks it before that
    // submit claims the photos, so a submit cannot land between this and the
    // soft-delete. A draft's or a sent-back request's photo he still removes.
    if (session.user.role === Role.SALESMAN && now.editId) {
      const [request] = await tx.$queryRaw<Array<{ state: EditState }>>`SELECT "state" FROM "CustomerEdit" WHERE "id" = ${now.editId} FOR UPDATE`;
      if (request?.state === EditState.SUBMITTED) throw new ForbiddenError(PHOTO_IN_REVIEW_MESSAGE);
    }
    // UXI-008: real soft-delete column. Keep the r2Key as-is for the GC job
    // to find the object; clear the hash so dedup queries miss the row. Guarded
    // on the same wiring: without a lock (a photo on no slot) an attach or a
    // new-customer request can still claim it between the read and here.
    const gone = await tx.attachment.updateMany({
      where: { id: att.id, deletedAt: null, ...wiring },
      data: { deletedAt: new Date(), hash: null },
    });
    if (gone.count !== 1) throw new ConflictError('PHOTO_CHANGED', PHOTO_CHANGED_MESSAGE);
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
