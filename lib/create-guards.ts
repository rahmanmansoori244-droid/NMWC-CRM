/**
 * Duplicate hard-block guards for the net-new-customer CREATE flow.
 *
 * Lives in lib/ (NOT a 'use server' module) so it can be shared by the
 * submit path (services/creates.ts) and the finalize re-check
 * (lib/create-finalize.ts) without becoming a client-invokable action.
 */
import { EditProcess, EditState, type Prisma } from '@prisma/client';
import { ConflictError } from './errors';
import { nameKey } from './name-key';
import { omanWhen } from './submission';
import { shownTime } from './submission-replay';

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
 * Keys are computed in JS on BOTH sides of any race, so the two competing
 * transactions always derive identical lock keys. The name part is
 * lib/name-key.ts nameKey — the same key the triple check below compares — so
 * two requests for "Al Noor  Shop" and "Al Noor Shop" queue on one lock instead
 * of both passing the check in parallel (item 16: the key used to be a plain
 * toLowerCase, which neither trimmed nor collapsed spaces). Locks are taken
 * in a deterministic sorted order to prevent lock-order deadlocks.
 */
export function createIdentityLockKeys(args: {
  crNumberNorm: string | null;
  legalName: string;
  primaryPhoneNorm: string | null;
  regionIds: string[];
}): string[] {
  const keys: string[] = [];
  if (args.crNumberNorm) keys.push(`nmwc:cr:${args.crNumberNorm}`);
  if (args.primaryPhoneNorm) {
    for (const regionId of args.regionIds) {
      keys.push(`nmwc:triple:${nameKey(args.legalName)}|${args.primaryPhoneNorm}|${regionId}`);
    }
  }
  return keys.sort();
}

export async function lockCreateIdentity(
  tx: Prisma.TransactionClient,
  args: {
    crNumberNorm: string | null;
    legalName: string;
    primaryPhoneNorm: string | null;
    regionIds: string[];
  }
): Promise<void> {
  for (const key of createIdentityLockKeys(args)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 42))`;
  }
}

/**
 * Exact-duplicate hard-block (owner-confirmed 2026-07-15): reject when the CR
 * (normalized) or the EXACT_TRIPLE (name key + primaryPhoneNorm + any shared
 * region) already exists on a live customer or another open CREATE request.
 * Re-run at finalize with includeOpenRequests=false — a colliding customer
 * may appear during the multi-day chain, but open requests were already
 * serialized against each other at submit.
 *
 * The name is compared with lib/name-key.ts nameKey, the key the duplicate
 * detector uses (owner decision 2026-09-25, item 16): whitespace runs
 * collapsed, ends trimmed, case folded. Postgres cannot apply that function, so
 * the triple leg narrows in SQL by normalized phone and region — the columns it
 * always matched exactly — and compares the names here. Before this the name
 * was compared in SQL, case-insensitively and nothing more, so "Al Noor  Shop"
 * with a doubled space, or with a pasted no-break space, was created beside
 * "Al Noor Shop" and then flagged by the detector as a duplicate of it.
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
    /**
     * Item 22: who is asking. When the open request in the way is theirs — a
     * send whose reply was lost, then a reload and a rebuild — say so, and
     * when it was sent, instead of "another request", which reads as someone
     * else's.
     */
    callerId?: string;
  }
): Promise<void> {
  const openStates = [EditState.DRAFT, EditState.SUBMITTED, EditState.NEEDS_CORRECTION];
  const openSelect = {
    edit: { select: { submittedById: true, state: true, submittedAt: true, updatedAt: true } },
  } as const;
  const ownRequest = (
    open: { edit: { submittedById: string; state: EditState; submittedAt: Date | null; updatedAt: Date } },
    what: string
  ) =>
    args.callerId && open.edit.submittedById === args.callerId
      ? `Your own new-customer request ${what}, ${open.edit.state === EditState.DRAFT ? 'saved as a draft' : 'sent'} at ${omanWhen(shownTime(open.edit))}, is already in progress — see Work.`
      : null;

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
        select: openSelect,
      });
      if (openCr) {
        throw new ConflictError(
          'DUPLICATE_CR',
          ownRequest(openCr, 'with this CR number') ??
            'Another new-customer request with this CR number is already in progress.'
        );
      }
    }
  }

  if (args.primaryPhoneNorm && args.regionIds.length > 0) {
    const want = nameKey(args.legalName);
    // Every live customer on this phone with a live branch in one of these
    // regions — a handful even for an owner who runs several shops on one
    // number — then the one whose name key matches.
    const livePhoneRegion = await tx.customer.findMany({
      where: {
        primaryPhoneNorm: args.primaryPhoneNorm,
        deletedAt: null,
        branches: { some: { regionId: { in: args.regionIds }, deletedAt: null } },
      },
      orderBy: { nmwcCode: 'asc' },
      select: { nmwcCode: true, legalName: true },
    });
    const tripleLive = livePhoneRegion.find((c) => nameKey(c.legalName) === want);
    if (tripleLive) {
      throw new ConflictError(
        'DUPLICATE_CUSTOMER',
        `This shop already exists: ${tripleLive.nmwcCode} — ${tripleLive.legalName} (same name, phone and region).`
      );
    }
    if (args.includeOpenRequests) {
      const openPhoneRegion = await tx.editCustomerDraft.findMany({
        where: {
          primaryPhoneNorm: args.primaryPhoneNorm,
          edit: {
            state: { in: openStates },
            process: EditProcess.CREATE,
            branchDrafts: { some: { regionId: { in: args.regionIds } } },
            ...(args.excludeEditId ? { id: { not: args.excludeEditId } } : {}),
          },
        },
        select: { legalName: true, ...openSelect },
      });
      const tripleOpen = openPhoneRegion.find((d) => nameKey(d.legalName) === want);
      if (tripleOpen) {
        throw new ConflictError(
          'DUPLICATE_CUSTOMER',
          ownRequest(tripleOpen, 'for this shop (same name, phone and region)') ??
            'Another new-customer request for this shop (same name, phone and region) is already in progress.'
        );
      }
    }
  }
}
