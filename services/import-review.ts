'use server';

/**
 * The "Before you promote" check of a staged customer batch (code review
 * 2026-11-10, finding 1): what Promote would create, refresh, keep or replace,
 * and which credit cells it would not apply, counted against the CRM as it is
 * now (lib/import-promote-summary.ts).
 *
 * Read-only: it writes nothing, takes no lock and leaves no audit row. Steward
 * only, as every import action is. Counts, never a customer's name or a value.
 */
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { requireActor } from '@/lib/session';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { checkLimit } from '@/lib/rate-limit';
import { loadPromoteSummary } from '@/lib/import-promote-summary';
import { summaryLines, type PromoteSummary, type SummaryLine } from '@/lib/import-plan';

export type PromoteReview = {
  summary: PromoteSummary;
  /** The batch's "Overwrite CRM fields from this sheet" option, as it is now. */
  overwrite: boolean;
  /** The summary as sentences, worded for that option. */
  lines: SummaryLine[];
};

export async function summariseCustomerBatchAction(formData: FormData): SafeAction<PromoteReview> {
  return runAction(() => summariseCore(formData));
}

async function summariseCore(formData: FormData): Promise<PromoteReview> {
  const me = await requireActor(); // F15: refuses a session that must change its password
  if (me.role !== Role.STEWARD) throw new ForbiddenError('Only the Data Steward can run imports.');
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) throw new ValidationError({ batchId: 'required' });
  // The check reads every clean row of the batch and the customers and shops they
  // name: a handful of times while the Steward decides, not in a loop.
  const lim = await checkLimit(`import-summary:${me.id}`, { capacity: 10, refillPerSec: 0.2 });
  if (!lim.ok) throw new RateLimitError(`Wait ${lim.retryAfterSec}s before checking this batch again.`);
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { kind: true, overwriteCrmFields: true },
  });
  if (!batch) throw new NotFoundError('Import batch not found.');
  if (batch.kind !== 'CUSTOMER') throw new ValidationError({ batchId: 'not a customer import' });
  const overwrite = batch.overwriteCrmFields === true;
  const summary = await loadPromoteSummary(prisma, batchId, overwrite);
  return { summary, overwrite, lines: summaryLines(summary, overwrite) };
}
