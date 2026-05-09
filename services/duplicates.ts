'use server';

import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError, ValidationError, NotFoundError } from '@/lib/errors';
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
  reason: 'PHONE' | 'CR' | 'NAME';
  similarity: number; // 0–1
  a: { id: string; nmwcCode: string; legalName: string; primaryPhone: string | null; crNumber: string | null; completenessScore: number; branchCount: number };
  b: { id: string; nmwcCode: string; legalName: string; primaryPhone: string | null; crNumber: string | null; completenessScore: number; branchCount: number };
};

/**
 * Find duplicate candidate pairs across the live customer master.
 * Three rules:
 *   1. EXACT phone match across different parent customers (hard duplicate)
 *   2. EXACT CR match across different parent customers
 *   3. FUZZY name match (case-insensitive Jaro-like via shared 4-grams)
 *
 * Returns up to `limit` pairs sorted by reason strength.
 */
export async function findDuplicateCandidates(limit = 100): Promise<DuplicateCandidate[]> {
  await requireSteward();

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
      _count: { select: { branches: { where: { deletedAt: null } } } },
    },
  });

  const out: DuplicateCandidate[] = [];

  // Index by phone + CR
  const byPhone = new Map<string, typeof customers>();
  const byCr = new Map<string, typeof customers>();
  for (const c of customers) {
    if (c.primaryPhoneNorm) {
      const arr = byPhone.get(c.primaryPhoneNorm) ?? [];
      arr.push(c);
      byPhone.set(c.primaryPhoneNorm, arr);
    }
    if (c.crNumberNorm) {
      const arr = byCr.get(c.crNumberNorm) ?? [];
      arr.push(c);
      byCr.set(c.crNumberNorm, arr);
    }
  }

  function pushPair(
    reason: DuplicateCandidate['reason'],
    similarity: number,
    a: (typeof customers)[number],
    b: (typeof customers)[number]
  ) {
    out.push({
      reason,
      similarity,
      a: pickSummary(a),
      b: pickSummary(b),
    });
  }

  for (const [, group] of byPhone) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pushPair('PHONE', 1.0, group[i], group[j]);
      }
    }
  }
  const seenPhonePair = new Set(out.map((p) => `${p.a.id}|${p.b.id}`));
  for (const [, group] of byCr) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = `${group[i].id}|${group[j].id}`;
        if (!seenPhonePair.has(key)) pushPair('CR', 1.0, group[i], group[j]);
      }
    }
  }

  // Fuzzy name: 4-gram Jaccard. O(N²) but fine at our scale.
  const grams = customers.map((c) => ({ c, g: ngrams(normalizeName(c.legalName), 4) }));
  const seenAny = new Set(out.map((p) => `${p.a.id}|${p.b.id}`));
  for (let i = 0; i < grams.length && out.length < limit; i++) {
    for (let j = i + 1; j < grams.length && out.length < limit; j++) {
      const sim = jaccard(grams[i].g, grams[j].g);
      if (sim < 0.7) continue;
      const key = `${grams[i].c.id}|${grams[j].c.id}`;
      if (seenAny.has(key)) continue;
      seenAny.add(key);
      pushPair('NAME', sim, grams[i].c, grams[j].c);
    }
  }

  // Sort: exact matches first, then by similarity
  out.sort((a, b) => {
    const rank = (r: DuplicateCandidate['reason']) =>
      r === 'PHONE' ? 0 : r === 'CR' ? 1 : 2;
    return rank(a.reason) - rank(b.reason) || b.similarity - a.similarity;
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

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ngrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  if (s.length < n) {
    out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Merge two customers: branches of `loserId` are reassigned to `winnerId`,
 * the loser is soft-deleted, and an audit log entry is written.
 *
 * Caller picks the winner. The winner keeps its identity; the loser's
 * NMWC code is preserved in the audit `before` payload for traceability.
 */
export async function mergeCustomersAction(formData: FormData) {
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
  return { ok: true as const, winnerId };
}

export async function dismissDuplicateAction(formData: FormData) {
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
