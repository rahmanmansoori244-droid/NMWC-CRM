'use server';

import { prisma } from '@/lib/db';
import { Role, EditState, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { scoreCustomer } from '@/lib/completeness';
import { resolveArchiveTemixState } from '@/lib/temix';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

// RBAC-05-009: PRD §4 reserves duplicate merge to STEWARD. Previous code
// also accepted MANAGER which conflated master-data ops with people-ops
// privileges. Tightened to STEWARD only.
async function requireSteward() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can merge customers.');
  }
  return session.user;
}

export type DuplicateCandidate = {
  reason: 'CR' | 'EXACT_TRIPLE'; // CR-number match (high-confidence) OR exact name+phone+region match
  similarity: number; // 0–1
  a: {
    id: string;
    nmwcCode: string;
    legalName: string;
    primaryPhone: string | null;
    crNumber: string | null;
    completenessScore: number;
    branchCount: number;
  };
  b: {
    id: string;
    nmwcCode: string;
    legalName: string;
    primaryPhone: string | null;
    crNumber: string | null;
    completenessScore: number;
    branchCount: number;
  };
};

/**
 * P1.4 (2026-05-10) — find duplicate candidate pairs across the live
 * customer master, but ONLY high-confidence pairs.
 *
 * NMWC reality:
 *   - One owner often runs many shops with the same primaryPhone — phone
 *     duplicates are LEGITIMATE, not a duplicate signal.
 *   - Chain shops (e.g. "ABU RETAJ AL M-…") share legalName prefixes across
 *     different areas — name fuzziness produced ~50 false positives per run
 *     and caused the steward to lose trust in the queue.
 *
 * New rules (only the ones that survive both real-world tests):
 *   1. EXACT CR-number match across different customers (rare, almost
 *      always a true duplicate — same legal entity registered twice).
 *   2. EXACT legalName + EXACT primaryPhone + same regionId — a very
 *      strong signal that the same shop was entered twice.
 *
 * Dropped: PHONE-only (legitimate), NAME-fuzzy (too noisy).
 *
 * Returns up to `limit` pairs sorted by reason strength.
 */
export async function findDuplicateCandidates(limit = 100): Promise<DuplicateCandidate[]> {
  await requireSteward();

  // We need region context for the EXACT_TRIPLE rule. Pull the customer's
  // first branch's region (post-flatten there's exactly one).
  const customers = await prisma.customer.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      nmwcCode: true,
      legalName: true,
      primaryPhone: true,
      primaryPhoneNorm: true,
      crNumber: true,
      crNumberNorm: true,
      completenessScore: true,
      branches: {
        where: { deletedAt: null },
        select: { regionId: true },
        take: 1,
      },
      _count: { select: { branches: { where: { deletedAt: null } } } },
    },
  });

  // Honor steward-dismissed pairs (writes AuditLog row with
  // entityType='CustomerPair', entityId='aId|bId').
  const dismissedAuditRows = await prisma.auditLog.findMany({
    where: { entityType: 'CustomerPair' },
    select: { entityId: true },
  });
  const dismissedKeys = new Set<string>();
  for (const r of dismissedAuditRows) {
    if (!r.entityId.includes('|')) continue;
    const [a, b] = r.entityId.split('|');
    if (a && b) {
      dismissedKeys.add(`${a}|${b}`);
      dismissedKeys.add(`${b}|${a}`);
    }
  }
  const isDismissed = (a: string, b: string) =>
    dismissedKeys.has(`${a}|${b}`) || dismissedKeys.has(`${b}|${a}`);

  const out: DuplicateCandidate[] = [];
  const seen = new Set<string>();

  function pushPair(
    reason: DuplicateCandidate['reason'],
    similarity: number,
    a: (typeof customers)[number],
    b: (typeof customers)[number]
  ) {
    if (isDismissed(a.id, b.id)) return;
    const key = `${a.id}|${b.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ reason, similarity, a: pickSummary(a), b: pickSummary(b) });
  }

  // Rule 1: CR-number exact match.
  const byCr = new Map<string, typeof customers>();
  for (const c of customers) {
    if (!c.crNumberNorm) continue;
    const arr = byCr.get(c.crNumberNorm) ?? [];
    arr.push(c);
    byCr.set(c.crNumberNorm, arr);
  }
  for (const [, group] of byCr) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length && out.length < limit; j++) {
        pushPair('CR', 1.0, group[i], group[j]);
      }
    }
  }

  // Rule 2: same legalName + same primaryPhone + same region.
  // Build a triple-key and look for collisions.
  const byTriple = new Map<string, typeof customers>();
  for (const c of customers) {
    if (!c.legalName || !c.primaryPhoneNorm || !c.branches[0]?.regionId) continue;
    const triple = `${c.legalName.toLowerCase().trim()}|${c.primaryPhoneNorm}|${c.branches[0].regionId}`;
    const arr = byTriple.get(triple) ?? [];
    arr.push(c);
    byTriple.set(triple, arr);
  }
  for (const [, group] of byTriple) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length && out.length < limit; j++) {
        pushPair('EXACT_TRIPLE', 1.0, group[i], group[j]);
      }
    }
  }

  // Sort: CR first (strongest), then triple matches.
  out.sort((a, b) => {
    const rank = (r: DuplicateCandidate['reason']) => (r === 'CR' ? 0 : 1);
    return rank(a.reason) - rank(b.reason);
  });

  return out.slice(0, limit);
}

function pickSummary(c: {
  id: string;
  nmwcCode: string;
  legalName: string;
  primaryPhone: string | null;
  crNumber: string | null;
  completenessScore: number;
  _count: { branches: number };
}): DuplicateCandidate['a'] {
  return {
    id: c.id,
    nmwcCode: c.nmwcCode,
    legalName: c.legalName,
    primaryPhone: c.primaryPhone,
    crNumber: c.crNumber,
    completenessScore: c.completenessScore,
    branchCount: c._count.branches,
  };
}

// (P1.4 2026-05-10) — fuzzy-name + n-gram + Jaccard helpers were removed
// alongside the noisy NAME-similarity rule. Kept the file clean.

/**
 * Merge two customers: branches of `loserId` are reassigned to `winnerId`,
 * the loser is soft-deleted, and an audit log entry is written.
 *
 * Caller picks the winner. The winner keeps its identity; the loser's
 * NMWC code is preserved in the audit `before` payload for traceability.
 */
export async function mergeCustomersAction(formData: FormData): SafeAction<{ winnerId: string }> {
  return runAction(() => mergeCustomersCore(formData));
}

async function mergeCustomersCore(formData: FormData): Promise<{ winnerId: string }> {
  const session = await requireSteward();
  const winnerId = String(formData.get('winnerId') ?? '');
  const loserId = String(formData.get('loserId') ?? '');
  // QA-018: explicit confirmation token required when the merge crosses regions.
  const confirmCrossRegion = String(formData.get('confirmCrossRegion') ?? '') === 'yes';
  const reason = String(formData.get('reason') ?? '').trim();
  if (!winnerId || !loserId || winnerId === loserId) {
    throw new ValidationError({ _form: 'Pick a winner and a different loser.' });
  }

  const [winner, loser] = await Promise.all([
    prisma.customer.findFirst({
      where: { id: winnerId, deletedAt: null },
      include: {
        branches: {
          where: { deletedAt: null },
          select: { id: true, regionId: true, routeId: true },
        },
      },
    }),
    prisma.customer.findFirst({
      where: { id: loserId, deletedAt: null },
      include: {
        branches: {
          where: { deletedAt: null },
          select: { id: true, regionId: true, routeId: true },
        },
      },
    }),
  ]);
  if (!winner || !loser) throw new NotFoundError('Customer pair not found.');

  // QA-018 — detect cross-region merge.
  const winnerRegions = new Set(winner.branches.map((b) => b.regionId));
  const loserRegions = new Set(loser.branches.map((b) => b.regionId));
  const isCrossRegion =
    [...loserRegions].some((r) => !winnerRegions.has(r)) ||
    [...winnerRegions].some((r) => !loserRegions.has(r));
  if (isCrossRegion && !confirmCrossRegion) {
    throw new ValidationError({
      _form:
        'Cross-region merge requires explicit confirmation (confirmCrossRegion=yes) and a reason.',
    });
  }
  if (isCrossRegion && reason.length < 5) {
    throw new ValidationError({ reason: 'Cross-region merges require a reason (5+ chars).' });
  }

  // DG-06: build the forensic envelope BEFORE the transaction opens, matching
  // the services/users.ts pattern. Two reasons. The merge holds FOR UPDATE on
  // both customer rows for the whole callback (timeout 20s below), so no
  // request-scoped work belongs in there; and getAuditEnvelope degrades to null
  // ip/userAgent instead of throwing, so if the request context were ever lost
  // inside the callback the loss would be silent — exactly the gap this change
  // exists to close.
  const env = await getAuditEnvelope(session.id);

  await prisma.$transaction(
    async (tx) => {
      // PROD-DUP-01 (P1): lock BOTH customer rows in a deterministic (id-sorted)
      // order, then re-validate both are still live INSIDE the transaction. Without
      // this, two concurrent merges of the SAME pair with winner/loser SWAPPED
      // (merge(A,B) racing merge(B,A)) each atomically claim a DIFFERENT loser row,
      // so BOTH customers get soft-deleted and their live branches are stranded
      // under deleted parents — silent data loss. Sorted `FOR UPDATE` serializes
      // the pair (identical lock order ⇒ no deadlock); the loser of the race
      // re-reads here and finds a party already archived, and aborts cleanly.
      for (const id of [winner.id, loser.id].sort()) {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE`;
      }
      const [winnerLive, loserLive] = await Promise.all([
        tx.customer.findUnique({ where: { id: winner.id }, select: { deletedAt: true } }),
        tx.customer.findUnique({ where: { id: loser.id }, select: { deletedAt: true } }),
      ]);
      if (!winnerLive || winnerLive.deletedAt) {
        throw new ValidationError({
          _form:
            'The winning customer was just merged or archived by another action. Refresh and retry the merge.',
        });
      }
      if (!loserLive || loserLive.deletedAt) {
        throw new ValidationError({
          _form:
            'The losing customer was just merged or archived by another action. Refresh and retry the merge.',
        });
      }

      // Move branches
      await tx.branch.updateMany({
        where: { customerId: loser.id, deletedAt: null },
        data: { customerId: winner.id, lastEditedById: session.id },
      });
      // QA-028 / final-hunt #31: move the loser's CustomerEdit history into the
      // winner for audit continuity. The loser is about to be soft-deleted, so FIRST
      // terminate any OPEN (SUBMITTED) edit on it — reparenting a loser-side SUBMITTED
      // edit onto a winner that also has one would collide under the
      // CustomerEdit_open_per_customer partial-unique index (customerId WHERE
      // state='SUBMITTED') and abort the whole merge with an opaque P2002. The loser's
      // pending workflow is moot once its identity is merged away, so auto-reject it
      // and stop its SLA clock, THEN reparent everything (no loser edit is SUBMITTED).
      const mergedAt = new Date();
      await tx.customerEdit.updateMany({
        where: { customerId: loser.id, state: EditState.SUBMITTED },
        data: {
          state: EditState.REJECTED,
          pendingRole: null,
          reviewedById: session.id,
          reviewedAt: mergedAt,
          decisionReason: `Auto-closed: customer ${loser.nmwcCode} merged into ${winner.nmwcCode}.`,
          slaDueAt: null,
          slaBreachedAt: null,
          lastEscalatedAt: null,
          escalationLevel: 0,
        },
      });
      await tx.customerEdit.updateMany({
        where: { customerId: loser.id },
        data: { customerId: winner.id },
      });
      // DG-03/04: a merge asserts these two rows are the SAME legal entity, so the
      // loser's documents ARE the winner's documents. Re-parent them; never release
      // them. Two separate defects are closed here, both on the happy path:
      //
      //  1. WRITE ORDER / P2002. `Customer.crPhotoId` is backed by a plain,
      //     NON-deferrable unique index (Customer_crPhotoId_key, migration
      //     20260509102405), so Postgres checks it at statement end, not at commit.
      //     The old code set the WINNER's slot while the LOSER row still held the
      //     same attachment id — 23505 → P2002 → the whole merge aborted with an
      //     opaque "Unique constraint failed on the fields: (`crPhotoId`)" for
      //     EVERY pair where only the loser had a CR document. The loser must
      //     release the pointer before the winner can claim it.
      //  2. ORPHANED EVIDENCE. Moving the slot pointer never moved
      //     `Attachment.customerId`, and the loser is soft-deleted a few statements
      //     below. assertCanAccessAttachment resolves an attachment through
      //     `customer.findFirst({ deletedAt: null })`, so every customer-bound
      //     document left behind on the loser 404s for every role except
      //     STEWARD/VIEWER. GUARANTEE documents (bound by Attachment.customerId in
      //     lib/create-finalize.ts) were never moved at all: 404 to the FM/GM who
      //     granted the limit, and invisible to the live-GUARANTEE groupBy in
      //     services/temix.ts, so the winner's Temix export understated the credit
      //     evidence behind its own limit.
      //
      // Every LIVE customer-bound attachment moves. Rows already soft-deleted stay
      // on the loser — they belong to the GC, not to the winner.
      await tx.attachment.updateMany({
        where: { customerId: loser.id, deletedAt: null },
        data: { customerId: winner.id },
      });
      // Read the loser's CR slot FRESH. Both customer rows are FOR UPDATE-locked
      // above, so this value cannot move again inside the transaction, whereas the
      // pre-tx `loser.crPhotoId` can be stale: attachCrPhoto soft-deletes the photo
      // it replaces, so a stale pointer can name an already-deleted attachment and
      // would hand the winner a slot the GC hard-deletes 30 days later.
      const loserCr = await tx.customer.findUniqueOrThrow({
        where: { id: loser.id },
        select: { crPhotoId: true },
      });
      if (loserCr.crPhotoId) {
        // Release first — see (1). Clearing it unconditionally also keeps
        // detachPhotoCore's `{ id: att.customerId, crPhotoId: att.id }` slot-clear
        // from missing: a live pointer left on a tombstoned customer would otherwise
        // survive the detach of the photo it names.
        await tx.customer.update({
          where: { id: loser.id },
          data: { crPhotoId: null },
        });
        // Guarded on `crPhotoId: null` at WRITE time rather than on the pre-tx read,
        // so a CR photo attached to the winner between the load and here is not
        // clobbered: the winner keeps its own, and the loser's CR survives as a
        // second, unslotted CR row now parented to the winner. Nothing renders
        // customerId-bound CR rows, so this adds no UI — only reachability through
        // /api/photos/[id] and an intact evidence trail.
        await tx.customer.updateMany({
          where: { id: winner.id, crPhotoId: null },
          data: { crPhotoId: loserCr.crPhotoId },
        });
      }
      // Soft-delete the loser. Phase 1 Temix sync: a loser Temix has heard of
      // (coded / ever uploaded / migrated-SYNCED) queues for ERP deactivation;
      // a never-uploaded loser just leaves the queue — Temix has nothing to
      // deactivate (lib/temix.ts resolveArchiveTemixState). Decided from a
      // FRESH in-tx read and pinned on the observed state: a Temix batch
      // committing between the pre-tx load and this write would otherwise get
      // its UPLOADED clobbered and the deactivation lost forever
      // (adversarial-review finding).
      const loserFresh = await tx.customer.findUniqueOrThrow({
        where: { id: loser.id },
        select: { temixCode: true, lastTemixUploadAt: true, temixSyncState: true },
      });
      const loserTemixState = resolveArchiveTemixState(loserFresh);
      const loserClaim = await tx.customer.updateMany({
        where: { id: loser.id, deletedAt: null, temixSyncState: loserFresh.temixSyncState },
        data: {
          deletedAt: new Date(),
          lastEditedById: session.id,
          temixSyncState: loserTemixState,
          temixSyncPendingSince: loserTemixState === 'DEACTIVATE_PENDING' ? new Date() : null,
          version: { increment: 1 },
        },
      });
      if (loserClaim.count === 0) {
        throw new ValidationError({
          _form:
            'The customer just changed (another action or a Temix batch ran). Refresh and retry the merge.',
        });
      }
      // The winner absorbed branches (and possibly a CR photo) — its Temix
      // master view changed, so re-queue it for the next batch (same guard as
      // applyEditChanges: PENDING_UPLOAD/DEACTIVATE_PENDING rows stay put).
      await tx.customer.updateMany({
        where: { id: winner.id, temixSyncState: { in: ['SYNCED', 'UPLOADED'] } },
        data: { temixSyncState: 'PENDING_UPLOAD', temixSyncPendingSince: new Date() },
      });
      // Recompute winner completeness
      const fresh = await tx.customer.findUniqueOrThrow({
        where: { id: winner.id },
        include: { branches: { where: { deletedAt: null } } },
      });
      const newScore = scoreCustomer(fresh, fresh.branches);
      await tx.customer.update({
        where: { id: winner.id },
        data: { completenessScore: newScore },
      });
      await writeAudit(tx, env, {
        action: 'MERGE',
        entityType: 'Customer',
        entityId: winner.id,
        before: {
          loser: { id: loser.id, nmwcCode: loser.nmwcCode, legalName: loser.legalName },
          winner: { id: winner.id, nmwcCode: winner.nmwcCode },
          crossRegion: isCrossRegion,
        } as unknown as Prisma.InputJsonValue,
        reason: isCrossRegion
          ? `Cross-region merge: ${loser.nmwcCode} -> ${winner.nmwcCode}. ${reason}`
          : `Merged ${loser.nmwcCode} into ${winner.nmwcCode}`,
      });
    },
    {
      // The merge holds a FOR UPDATE lock on both customer rows while it moves
      // branches/edits and recomputes completeness (~a dozen sequential writes). A
      // second merge of the same pair serializes behind that lock, so its total
      // time = winner's tx + its own re-read. The default 5s interactive-tx
      // timeout can be exceeded under lock contention or a large multi-branch
      // customer; 20s gives ample headroom for this rare, Steward-only operation.
      timeout: 20_000,
    }
  );

  logger.info({ winnerId, loserId, by: session.id }, 'customer.merge');
  revalidatePath('/duplicates');
  revalidatePath('/customers');
  return { winnerId };
}

export async function dismissDuplicateAction(formData: FormData): SafeAction<void> {
  return runAction(() => dismissDuplicateCore(formData));
}

async function dismissDuplicateCore(formData: FormData) {
  const session = await requireSteward();
  const aId = String(formData.get('aId') ?? '');
  const bId = String(formData.get('bId') ?? '');
  if (!aId || !bId) throw new ValidationError({ _form: 'Pair required.' });
  // We just record an audit note; future detector runs will still surface them, but the steward
  // can use this as a paper trail for "deemed distinct".
  await writeAudit(null, await getAuditEnvelope(session.id), {
    action: 'UPDATE',
    entityType: 'CustomerPair',
    entityId: `${aId}|${bId}`,
    reason: 'Deemed distinct by steward',
  });
  revalidatePath('/duplicates');
}
