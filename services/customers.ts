'use server';

/**
 * Customer lifecycle actions — Phase 1 Temix increment.
 *
 * archiveCustomerAction is the owner-confirmed soft-delete (Blueprint C8):
 * the CRM never hard-deletes a customer; archiving tombstones it
 * (deletedAt) and queues the Temix deactivation (DEACTIVATE_PENDING) when the
 * ERP has heard of the customer and no other live customer still holds, as its
 * Temix code, the code that deactivation would take (F11: the customer's Temix
 * code, or its customer code when it has none). AuditAction.SOFT_DELETE carries
 * actor + reason — no extra columns needed.
 */
import { prisma } from '@/lib/db';
import { EditState, Role, TemixSyncState, type Prisma } from '@prisma/client';
import { requireActor } from '@/lib/session';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { loadScope, assertCanEditCustomer } from '@/lib/access';
import {
  archiveDeactivationCode,
  deactivationCode,
  liveTemixCodeHolders,
  resolveArchiveTemixState,
} from '@/lib/temix';
import { lockCustomersAndTemixCodeHolders } from '@/lib/locks';

export async function archiveCustomerAction(formData: FormData): SafeAction<void> {
  return runAction(() => archiveCustomerCore(formData));
}

async function archiveCustomerCore(formData: FormData) {
  const session = { user: await requireActor() }; // F15: refuses a session that must change its password
  // Steward (data-ops, org-wide) or Manager (region-scoped, fail-closed via
  // assertCanEditCustomer) — the same pair with direct-write authority.
  if (session.user.role !== Role.STEWARD && session.user.role !== Role.MANAGER) {
    throw new ForbiddenError('Only a Steward or Manager can archive a customer.');
  }
  const customerId = String(formData.get('customerId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!customerId) throw new ValidationError({ customerId: 'required' });
  if (reason.length < 5 || reason.length > 1000) {
    throw new ValidationError({ reason: 'Reason must be 5–1000 characters.' });
  }

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    include: { branches: { select: { id: true, routeId: true, regionId: true, deletedAt: true } } },
  });
  if (!customer) throw new NotFoundError('Customer not found.');

  const sessionUser = { id: session.user.id, role: session.user.role, username: session.user.username };
  const scope = await loadScope(session.user.id);
  assertCanEditCustomer(sessionUser, customer, scope);
  // Archiving tombstones the WHOLE customer, so a Manager needs EVERY live
  // branch inside their managed regions — the any-branch-overlap rule that
  // grants edit access is not enough authority to destroy other regions'
  // branches (adversarial-review finding). Steward is org-wide.
  if (session.user.role === Role.MANAGER) {
    const liveBranches = customer.branches.filter((b) => !b.deletedAt);
    const allInScope = liveBranches.every((b) => scope.managedRegionIds.includes(b.regionId));
    if (!allInScope) {
      throw new ForbiddenError(
        'This customer has branches outside your regions — ask the Steward to archive it.'
      );
    }
  }

  const archivedAt = new Date();
  // DG-06: capture the request envelope before the transaction opens.
  const env = await getAuditEnvelope(session.user.id);
  await prisma.$transaction(async (tx) => {
    // Re-checked INSIDE the tx (pre-tx check would be TOCTOU): a request
    // mid-approval must be decided first — archiving under it would orphan
    // the reviewers' queue rows and confuse the audit trail.
    const openEdit = await tx.customerEdit.findFirst({
      where: { customerId, state: EditState.SUBMITTED },
      select: { id: true },
    });
    if (openEdit) {
      throw new ConflictError(
        'EDIT_OPEN',
        'A submitted request is still in review for this customer. Approve or reject it before archiving.'
      );
    }
    // F11: the customer and every other live customer holding, as its Temix
    // code, the code this archive would deactivate (its customer code when it
    // has no Temix code), locked in one order before anything is read
    // (lib/locks.ts), so two customers sharing a code cannot both be archived
    // each thinking the other still holds it.
    await lockCustomersAndTemixCodeHolders(tx, [customerId], deactivationCode(customer));
    // Decide the Temix state from a FRESH in-tx read and pin the claim on the
    // observed state — a batch generation committing between a stale read and
    // the write would otherwise get its UPLOADED clobbered and the
    // deactivation lost forever (adversarial-review finding).
    const fresh = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: {
        nmwcCode: true,
        temixCode: true,
        lastTemixUploadAt: true,
        temixSyncState: true,
        deletedAt: true,
      },
    });
    if (fresh.deletedAt) {
      throw new ConflictError('ALREADY_ARCHIVED', 'This customer was just archived.');
    }
    if (fresh.temixCode !== customer.temixCode) {
      // The lock above covered the holders of the code read before the
      // transaction; a code that moved since needs a fresh start.
      throw new ConflictError(
        'STATE_CHANGED',
        "This customer's Temix code just changed. Refresh and try again."
      );
    }
    // F11: a Temix code another live customer still holds is not deactivated —
    // that would take the ERP identity away from the customer the CRM keeps —
    // so this customer just leaves the queue, and the SOFT_DELETE row says so.
    // The last live holder archived is the one that deactivates the code. An
    // uncoded customer Temix knows is asked about its customer code: its
    // deactivation goes out keyed on it, and Generate holds it back against it.
    const sharedWith = await liveTemixCodeHolders(tx, archiveDeactivationCode(fresh), customerId);
    const nextState =
      sharedWith.length > 0 ? TemixSyncState.SYNCED : resolveArchiveTemixState(fresh);
    const claim = await tx.customer.updateMany({
      where: { id: customerId, deletedAt: null, temixSyncState: fresh.temixSyncState },
      data: {
        deletedAt: archivedAt,
        lastEditedById: session.user.id,
        temixSyncState: nextState,
        temixSyncPendingSince: nextState === 'DEACTIVATE_PENDING' ? archivedAt : null,
        // B-05: visible to the optimistic lock so racing direct-writes see
        // VERSION_CONFLICT instead of mutating a tombstoned customer.
        version: { increment: 1 },
      },
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'STATE_CHANGED',
        'This customer just changed (another action or a Temix batch ran). Refresh and try again.'
      );
    }
    // Tombstone the branches too — route/region-scoped reads (today lists,
    // duplicate detection, exports) all key off branch.deletedAt.
    await tx.branch.updateMany({
      where: { customerId, deletedAt: null },
      data: { deletedAt: archivedAt, lastEditedById: session.user.id },
    });
    await writeAudit(tx, env, {
      action: 'SOFT_DELETE',
      entityType: 'Customer',
      entityId: customerId,
      reason,
      before: {
        nmwcCode: customer.nmwcCode,
        legalName: customer.legalName,
        temixSyncState: customer.temixSyncState,
      } as unknown as Prisma.InputJsonValue,
      after: {
        temixSyncState: nextState,
        ...(sharedWith.length > 0
          ? { temixDeactivation: 'skipped-shared-code', temixCodeHeldBy: sharedWith }
          : {}),
      } as unknown as Prisma.InputJsonValue,
    });
    return nextState;
  });

  logger.info({ customerId, by: session.user.id }, 'customer.archive');
  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
  revalidatePath('/temix');
}
