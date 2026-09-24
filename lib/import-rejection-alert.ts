/**
 * WHEN a customer-master promote tells a human that rows were rejected — decided
 * here, from the row states, so it can be proved by behaviour.
 *
 * It lived inline in services/imports.ts, where the only guard was a regular
 * expression over the `if`. Changing `countOf(ImportRowState.REJECTED)` to
 * `countOf(ImportRowState.CLEAN)` left that guard green — CLEAN is 0 whenever the
 * batch is done, so the alert could never fire again — because the text of the
 * condition never changed (adversarial review, 2026-09-24). services/imports.ts is
 * a `'use server'` module, where every export becomes a server action, so the
 * decision cannot be exported from there; it lives here instead.
 */
import { ImportRowState } from '@prisma/client';
import type { AlertInput } from './alert';

/** The shape `prisma.importRow.groupBy({ by: ['state'], _count: { _all: true } })` returns. */
export type RowStateCount = { state: ImportRowState; _count: { _all: number } };

/**
 * The alert to send, or null when there is nothing to say.
 *
 * Fires only on the slice that FINISHED the batch — no CLEAN row left — and only
 * when that slice still held the lease (`finalisedByThisSlice`, i.e. its guarded
 * finalize matched the row). A slice that lost the batch leaves the alert to the
 * owner that finalised it; otherwise a resumed load posts twice for one finish.
 * Counts come from the row states of the WHOLE batch, not from this slice.
 */
export function importRejectionAlert(args: {
  batchId: string;
  stateCounts: readonly RowStateCount[];
  finalisedByThisSlice: boolean;
  groups: number;
}): AlertInput | null {
  const countOf = (s: ImportRowState) =>
    args.stateCounts.find((c) => c.state === s)?._count._all ?? 0;
  const done = countOf(ImportRowState.CLEAN) === 0;
  const rejected = countOf(ImportRowState.REJECTED);
  if (!done || !args.finalisedByThisSlice || rejected === 0) return null;
  return {
    severity: 'warn',
    event: 'import.rejections',
    // Per batch, so two masters loaded the same morning both report.
    scope: args.batchId,
    message: 'A customer master load finished with rejected rows. Open the batch to see why.',
    counts: {
      rejected,
      promoted: countOf(ImportRowState.PROMOTED),
      groups: args.groups,
    },
    ids: { batchId: args.batchId },
  };
}
