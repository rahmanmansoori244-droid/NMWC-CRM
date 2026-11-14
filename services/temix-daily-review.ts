'use server';

/**
 * The daily Temix import, stage 6: the drill-down's "Reviewed" button. The
 * Data Steward marks a line of a day's ledger (a route move, a missing
 * customer, a name difference, ...) as looked at, one line or every line of
 * the day not marked yet.
 *
 * The ledger is never updated: a mark is a new TemixChangeReview row
 * (INSERT-only, note REVIEWED), stamped with its source and transaction by the
 * database. A mark changes nothing else: an open spell stays open until the
 * customer or code is in a file again, and no customer, shop or route is
 * touched. One AuditLog row per file whose lines were marked (counts only).
 * Data Steward only.
 */

import { revalidatePath } from 'next/cache';
import { AuditAction, Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { ForbiddenError, RateLimitError, ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { checkLimit } from '@/lib/rate-limit';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { omanDayStart, setChangeContext, src, withChangeContext } from '@/lib/change-context';
import { REVIEW_FIELDS, REVIEW_NOTE } from '@/lib/temix-daily-review';

async function requireSteward() {
  const user = await requireActor();
  if (user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can review the Temix daily changes.');
  }
  return user;
}

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

/** At most this many lines are marked by one press of "mark all" (the page says so and the Steward presses again). */
const MARK_ALL_MAX = 5000;
const CHUNK = 1000;

export async function reviewTemixChangesAction(formData: FormData): SafeAction<{ reviewed: number }> {
  return runAction(async () => {
    const me = await requireSteward();
    const lim = await checkLimit(`temix-daily-review:${me.id}`, { capacity: 60, refillPerSec: 1 });
    if (!lim.ok) throw new RateLimitError(`Wait ${lim.retryAfterSec}s and try again.`);
    const loadDay = str(formData.get(REVIEW_FIELDS.loadDay)).trim();
    const changeRaw = str(formData.get(REVIEW_FIELDS.changeId)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(loadDay) || !omanDayStart(loadDay)) throw new ValidationError({ loadDay: 'No day named.' });
    if (changeRaw && !/^\d{1,18}$/.test(changeRaw)) throw new ValidationError({ changeId: 'No such line.' });
    const env = await getAuditEnvelope(me.id);
    const day = new Date(`${loadDay}T00:00:00Z`);

    const reviewed = await withChangeContext(prisma, { actorId: me.id, source: src.temixDailyStep('-', 'review') }, async (tx) => {
      // One review at a time per Steward, so a double press marks a line once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nmwc:temix-daily-review:${me.id}`}, 42))`;
      const lines = await tx.temixChange.findMany({
        where: { loadDay: day, reviews: { none: {} }, ...(changeRaw ? { id: BigInt(changeRaw) } : {}) },
        select: { id: true, fileId: true },
        orderBy: { id: 'asc' },
        take: MARK_ALL_MAX,
      });
      if (changeRaw && lines.length === 0) {
        const exists = await tx.temixChange.count({ where: { id: BigInt(changeRaw), loadDay: day } });
        if (exists === 0) throw new ValidationError({ changeId: 'No such line on this day.' });
        return 0; // already reviewed
      }
      const byFile = new Map<string, bigint[]>();
      for (const l of lines) byFile.set(l.fileId, [...(byFile.get(l.fileId) ?? []), l.id]);
      for (const [fileId, ids] of byFile) {
        await setChangeContext(tx, { actorId: me.id, source: src.temixDailyStep(fileId, 'review') });
        for (let i = 0; i < ids.length; i += CHUNK) {
          await tx.temixChangeReview.createMany({
            data: ids.slice(i, i + CHUNK).map((changeId) => ({ changeId, reviewedById: me.id, note: REVIEW_NOTE })),
          });
        }
        await writeAudit(tx, env, {
          action: AuditAction.UPDATE,
          entityType: 'TemixDailyFile',
          entityId: fileId,
          after: { kind: 'TEMIX_DAILY_REVIEWED', loadDay, lines: ids.length, ...(changeRaw ? { changeId: changeRaw } : {}) },
        });
      }
      return lines.length;
    });
    revalidatePath(`/temix-daily/day/${loadDay}`);
    return { reviewed };
  });
}
