/**
 * Gap 22 (data audit 2026-10-10): the losing side of two people saving at once,
 * kept in the ledger.
 *
 * runAction (lib/errors.ts) calls this, through the recorder lib/db.ts
 * registers, for every ConflictError or StaleFieldsError thrown with conflict
 * meta. By then the losing transaction has rolled back, so the CONFLICT row is
 * written in a transaction of its own, under the loser's name and a
 * `conflict:<path>:<id>` source, beside what the winner left (for a request: its
 * state, step and who decided it). Best-effort: a failure here is logged and the
 * 409 the user sees is unchanged. Bulk decisions record each item, because each
 * goes through runAction itself (services/edits.ts bulkApproveEditsAction).
 *
 * The import's overwrites and the merge's moves are made visible elsewhere
 * (lossless paths, gaps 4 and 8): they lose no race, they win it.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { src, withChangeContext } from '@/lib/change-context';
import { logger } from '@/lib/logger';
import type { AppError, ConflictMeta } from '@/lib/errors';
import { conflictAfter, conflictReason, type LiveEdit } from '@/lib/conflict-row';

export async function recordConflict(err: AppError & { conflict: ConflictMeta }): Promise<void> {
  const meta = err.conflict;
  try {
    // The loser's own request: his address and device, as on every audit row.
    const env = await getAuditEnvelope(meta.actorId);
    await withChangeContext(
      prisma,
      { actorId: meta.actorId, source: src.conflict(meta.path, meta.entityId) },
      async (tx) => {
        const live: LiveEdit | null =
          meta.entityType === 'CustomerEdit'
            ? await tx.customerEdit.findUnique({
                where: { id: meta.entityId },
                select: { state: true, currentStepIndex: true, cycle: true, reviewedById: true, reviewedAt: true },
              })
            : null;
        await writeAudit(tx, env, {
          action: 'CONFLICT',
          entityType: meta.entityType,
          entityId: meta.entityId,
          reason: conflictReason(err.code, meta),
          after: conflictAfter(err, meta, live) as Prisma.InputJsonValue,
        });
      },
      { timeout: 5_000, maxWait: 2_000 }
    );
  } catch (e) {
    logger.warn(
      {
        code: err.code,
        path: meta.path,
        entityType: meta.entityType,
        err: (e as Error)?.message?.slice(0, 120),
      },
      'conflict.record_failed'
    );
  }
}
