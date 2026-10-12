/**
 * Gap 22 (data audit 2026-10-10): what a CONFLICT audit row says about a save
 * that lost a race (lib/conflict-record.ts writes it; lib/errors.ts ConflictMeta
 * is what the throw site knew).
 *
 *   reason  '<code>: <path>' — 'NOT_PENDING: edit.approve'
 *   after   { code, path, fields?, expectedVersion?, liveVersion?, message, live? }
 *
 * `live` is what the winner left: for a request, its state, step, cycle and who
 * decided it and when, read right after the loser's transaction rolled back. The
 * message is the sentence the loser was shown (fixed wording, never a value a
 * person typed), cut to 300 characters.
 *
 * PURE: no imports beyond types.
 */
import type { ConflictMeta } from './errors';

export type LiveEdit = {
  state: string;
  currentStepIndex: number;
  cycle: number;
  reviewedById: string | null;
  reviewedAt: Date | null;
};

export const CONFLICT_MESSAGE_MAX = 300;

export function conflictReason(code: string, meta: ConflictMeta): string {
  return `${code}: ${meta.path}`;
}

export function conflictAfter(
  err: { code: string; message: string },
  meta: ConflictMeta,
  live: LiveEdit | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: err.code,
    path: meta.path,
    message: err.message.slice(0, CONFLICT_MESSAGE_MAX),
  };
  if (meta.fields && meta.fields.length > 0) out.fields = [...meta.fields];
  if (meta.expectedVersion !== undefined) out.expectedVersion = meta.expectedVersion;
  if (meta.liveVersion !== undefined) out.liveVersion = meta.liveVersion;
  if (live) {
    out.live = {
      state: live.state,
      currentStepIndex: live.currentStepIndex,
      cycle: live.cycle,
      reviewedById: live.reviewedById,
      reviewedAt: live.reviewedAt ? live.reviewedAt.toISOString() : null,
    };
  }
  return out;
}
