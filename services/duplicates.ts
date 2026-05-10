'use server';

import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
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
  a: { id: string; nmwcCode: string; legalName: string; primaryPhone: string | null; crNumber: string | null; completenessScore: number; branchCount: number };
  b: { id: string; nmwcCode: string; legalName: string; primaryPhone: string | null; crNumber: string | null; completenessScore: number; branchCount: number };
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

function pickSummary(
  c: {
    id: string;
    nmwcCode: string;
    legalName: string;
    primaryPhone: string | null;
    crNumber: string | null;
    completenessScore: number;
    _count: { branches: number };
  }
): DuplicateCandidate['a'] {
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
export async function mergeCustomersAction(
  formData: FormData
): SafeAction<{ winnerId: string }> {
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
      include: { branches: { where: { deletedAt: null }, select: { id: true, regionId: true, routeId: true } } },
    }),
    prisma.customer.findFirst({
      where: { id: loserId, deletedAt: null },
      include: { branches: { where: { deletedAt: null }, select: { id: true, regionId: true, routeId: true } } },
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

  await prisma.$transaction(async (tx) => {
    // Move branches
    await tx.branch.updateMany({
      where: { customerId: loser.id, deletedAt: null },
      data: { customerId: winner.id, lastEditedById: session.id },
    });
    // QA-028: also move the loser's CustomerEdit history into the winner.
    await tx.customerEdit.updateMany({
      where: { customerId: loser.id },
      data: { customerId: winner.id },
    });
    // Move CR photo if winner has none
    if (!winner.crPhotoId && loser.crPhotoId) {
      await tx.customer.update({
        where: { id: winner.id },
        data: { crPhotoId: loser.crPhotoId },
      });
      await tx.customer.update({ where: { id: loser.id }, data: { crPhotoId: null } });
    }
    // Soft-delete the loser
    await tx.customer.update({
      where: { id: loser.id },
      data: { deletedAt: new Date(), lastEditedById: session.id },
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
    await tx.auditLog.create({
      data: {
        actorId: session.id,
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
      },
    });
  });

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
  await prisma.auditLog.create({
    data: {
      actorId: session.id,
      action: 'UPDATE',
      entityType: 'CustomerPair',
      entityId: `${aId}|${bId}`,
      reason: 'Deemed distinct by steward',
    },
  });
  revalidatePath('/duplicates');
}
