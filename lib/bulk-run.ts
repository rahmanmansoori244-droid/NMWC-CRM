/**
 * REL-04: running a batch of actions without losing the results.
 *
 * The bulk approve and reject loops called the single-item action and collected
 * `{ok:false}` results — which handles a business-rule rejection fine. What it
 * did not handle is a THROW. `runAction` re-throws anything that is not an
 * AppError, that escapes the loop, the outer `runAction` re-throws it again,
 * and the client awaits a rejected promise inside a transition with no catch.
 * The banner never renders.
 *
 * The damage is not the missing banner. Each item commits independently, so an
 * approver who selects twenty edits and hits a throw on the seventh has
 * approved six customers, been shown nothing at all, and will reasonably assume
 * none of it worked and try again.
 *
 * Two rules, then:
 *   1. One item can never take the batch down. A throw is recorded as that
 *      item's failure and the loop continues.
 *   2. The loop stops before the serverless function does. Fifty items at a
 *      couple of seconds each will outlive a 60-second limit, and a killed
 *      function loses the result for everything it had already committed — the
 *      same failure by a different route. Items past the budget are reported as
 *      not attempted, so the approver knows to run it again rather than
 *      wondering which half worked.
 */

export type BulkFailure = { editId: string; code: string; message: string };

export type BulkOutcome = {
  successes: string[];
  failures: BulkFailure[];
  /** Selected, never started: the time budget ran out first. */
  notAttempted: string[];
};

export type BulkItemResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * How long a bulk loop may keep starting new items.
 *
 * Vercel functions are capped at 60s (`vercel.json`). The budget stops well
 * short so the item already in flight, plus the response, still fit.
 */
export function bulkBudgetMs(): number {
  const raw = Number(process.env.BULK_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 40_000;
  return Math.min(Math.max(raw, 5_000), 55_000);
}

export async function runBulk(
  ids: string[],
  perItem: (id: string) => Promise<BulkItemResult>,
  opts: {
    budgetMs?: number;
    /** Injectable for tests; defaults to the wall clock. */
    now?: () => number;
    onItemError?: (id: string, err: unknown) => void;
  } = {}
): Promise<BulkOutcome> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? bulkBudgetMs();
  const startedAt = now();

  const successes: string[] = [];
  const failures: BulkFailure[] = [];
  const notAttempted: string[] = [];

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    // Check before starting, never mid-item: an item that has begun must be
    // allowed to finish so it either commits and is reported, or fails and is
    // reported. Abandoning it is how you get a commit nobody knows about.
    if (i > 0 && now() - startedAt >= budgetMs) {
      notAttempted.push(...ids.slice(i));
      break;
    }
    try {
      const res = await perItem(id);
      if (res.ok) successes.push(id);
      else failures.push({ editId: id, code: res.code, message: res.message });
    } catch (err) {
      opts.onItemError?.(id, err);
      failures.push({
        editId: id,
        code: (err as { code?: string })?.code ?? 'UNKNOWN',
        message:
          err instanceof Error && err.message
            ? err.message
            : 'This one failed unexpectedly and was skipped.',
      });
    }
  }

  return { successes, failures, notAttempted };
}
