/**
 * Duplicate hard-block guards for the net-new-customer CREATE flow.
 *
 * Lives in lib/ (NOT a 'use server' module) so it can be shared by the
 * submit path (services/creates.ts) and the finalize re-check
 * (lib/create-finalize.ts) without becoming a client-invokable action.
 */
import { EditProcess, EditState, type Prisma } from '@prisma/client';
import { ConflictError } from './errors';

/**
 * Serialize concurrent submits/finalizes for the same normalized CR inside
 * the surrounding transaction (advisory xact locks release automatically at
 * commit/rollback). This is what makes the app-level exact-CR hard-block
 * race-free — there is deliberately NO unique index on Customer.crNumberNorm
 * (legacy master data contains genuine duplicates).
 */
export async function lockCrForUpdate(tx: Prisma.TransactionClient, crNumberNorm: string) {
  // $executeRaw, NOT $queryRaw: pg_advisory_xact_lock returns `void`, which
  // $queryRaw fails to deserialize (P2010) — caught by the Neon-branch probe.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'nmwc:cr:' + crNumberNorm}, 42))`;
}

/**
 * Serialize the full duplicate-identity surface of a create request: the CR
 * leg AND the EXACT_TRIPLE leg (legalName + phone + region). The CR-only lock
 * left the triple check unserialized when two requests carried DIFFERENT CR
 * numbers (typo'd vs real CR) — both could pass submit, and two concurrent
 * final approvals could then materialize duplicate live customers
 * (adversarial-review CONFIRMED finding).
 *
 * Keys are computed in JS (toLowerCase) on BOTH sides of any race, so the two
 * competing transactions always derive identical lock keys. Locks are taken
 * in a deterministic sorted order to prevent lock-order deadlocks.
 */
export async function lockCreateIdentity(
  tx: Prisma.TransactionClient,
  args: {
    crNumberNorm: string | null;
    legalName: string;
    primaryPhoneNorm: string | null;
    regionIds: string[];
  }
): Promise<void> {
  const keys: string[] = [];
  if (args.crNumberNorm) keys.push(`nmwc:cr:${args.crNumberNorm}`);
  if (args.primaryPhoneNorm) {
    for (const regionId of args.regionIds) {
      keys.push(`nmwc:triple:${args.legalName.toLowerCase()}|${args.primaryPhoneNorm}|${regionId}`);
    }
  }
  keys.sort();
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 42))`;
  }
}

/**
 * Exact-duplicate hard-block (owner-confirmed 2026-07-15): reject when the CR
 * (normalized) or the EXACT_TRIPLE (legalName casefold + primaryPhoneNorm +
 * region) already exists on a live customer or another open CREATE request.
 * Re-run at finalize with includeOpenRequests=false — a colliding customer
 * may appear during the multi-day chain, but open requests were already
 * serialized against each other at submit.
 */
export async function assertNoExactCreateDuplicate(
  tx: Prisma.TransactionClient,
  args: {
    crNumberNorm: string | null;
    legalName: string;
    primaryPhoneNorm: string | null;
    regionIds: string[];
    excludeEditId?: string;
    includeOpenRequests: boolean;
  }
): Promise<void> {
  const openStates = [EditState.DRAFT, EditState.SUBMITTED, EditState.NEEDS_CORRECTION];

  if (args.crNumberNorm) {
    const liveCr = await tx.customer.findFirst({
      where: { crNumberNorm: args.crNumberNorm, deletedAt: null },
      select: { nmwcCode: true, legalName: true },
    });
    if (liveCr) {
      throw new ConflictError(
        'DUPLICATE_CR',
        `A customer with this CR number already exists: ${liveCr.nmwcCode} — ${liveCr.legalName}. Open that customer instead of creating a new one.`
      );
    }
    if (args.includeOpenRequests) {
      const openCr = await tx.editCustomerDraft.findFirst({
        where: {
          crNumberNorm: args.crNumberNorm,
          edit: {
            state: { in: openStates },
            process: EditProcess.CREATE,
            ...(args.excludeEditId ? { id: { not: args.excludeEditId } } : {}),
          },
        },
        select: { id: true },
      });
      if (openCr) {
        throw new ConflictError(
          'DUPLICATE_CR',
          'Another new-customer request with this CR number is already in progress.'
        );
      }
    }
  }

  if (args.primaryPhoneNorm && args.regionIds.length > 0) {
    const tripleLive = await tx.customer.findFirst({
      where: {
        legalName: { equals: args.legalName, mode: 'insensitive' },
        primaryPhoneNorm: args.primaryPhoneNorm,
        deletedAt: null,
        branches: { some: { regionId: { in: args.regionIds }, deletedAt: null } },
      },
      select: { nmwcCode: true, legalName: true },
    });
    if (tripleLive) {
      throw new ConflictError(
        'DUPLICATE_CUSTOMER',
        `This shop already exists: ${tripleLive.nmwcCode} — ${tripleLive.legalName} (same name, phone and region).`
      );
    }
    if (args.includeOpenRequests) {
      const tripleOpen = await tx.editCustomerDraft.findFirst({
        where: {
          legalName: { equals: args.legalName, mode: 'insensitive' },
          primaryPhoneNorm: args.primaryPhoneNorm,
          edit: {
            state: { in: openStates },
            process: EditProcess.CREATE,
            branchDrafts: { some: { regionId: { in: args.regionIds } } },
            ...(args.excludeEditId ? { id: { not: args.excludeEditId } } : {}),
          },
        },
        select: { id: true },
      });
      if (tripleOpen) {
        throw new ConflictError(
          'DUPLICATE_CUSTOMER',
          'Another new-customer request for this shop (same name, phone and region) is already in progress.'
        );
      }
    }
  }
}
