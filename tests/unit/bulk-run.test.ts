/**
 * REL-04: a bulk approval must never lose its own result.
 *
 * The failure this guards against is not cosmetic. Each item commits
 * independently, so an approver who selects twenty edits and hits a throw on
 * the seventh has approved six customers, seen no banner at all, and will
 * reasonably assume nothing worked and do it again.
 */
import { describe, it, expect, vi } from 'vitest';
import { runBulk, bulkBudgetMs } from '@/lib/bulk-run';

const ok = async () => ({ ok: true }) as const;

describe('runBulk', () => {
  it('records a thrown item as that item\'s failure and keeps going', async () => {
    const out = await runBulk(['1', '2', '3', '4', '5'], async (id) => {
      if (id === '3') throw new Error('boom');
      return { ok: true };
    });
    expect(out.successes).toEqual(['1', '2', '4', '5']);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]!.editId).toBe('3');
    expect(out.failures[0]!.message).toBe('boom');
    expect(out.notAttempted).toEqual([]);
  });

  it('carries a Prisma-style error code through to the failure', async () => {
    const out = await runBulk(['a'], async () => {
      throw Object.assign(new Error('nope'), { code: 'P2028' });
    });
    expect(out.failures[0]!.code).toBe('P2028');
  });

  it('keeps a returned {ok:false} as a failure, unchanged', async () => {
    const out = await runBulk(['a', 'b'], async (id) =>
      id === 'a' ? { ok: true } : { ok: false, code: 'WRONG_LANE', message: 'Not your step.' }
    );
    expect(out.successes).toEqual(['a']);
    expect(out.failures).toEqual([{ editId: 'b', code: 'WRONG_LANE', message: 'Not your step.' }]);
  });

  it('stops starting new items once the budget is spent, and says which were untouched', async () => {
    let t = 0;
    // 5s per item against a 12s budget: items 1-3 start, then the loop stops.
    const out = await runBulk(['1', '2', '3', '4', '5'], ok, {
      budgetMs: 12_000,
      now: () => {
        const v = t;
        t += 5_000;
        return v;
      },
    });
    expect(out.successes.length).toBeGreaterThan(0);
    expect(out.successes.length + out.notAttempted.length).toBe(5);
    expect(out.notAttempted.length).toBeGreaterThan(0);
    // The reported sets must partition the input — an id can never vanish.
    expect([...out.successes, ...out.failures.map((f) => f.editId), ...out.notAttempted].sort()).toEqual(
      ['1', '2', '3', '4', '5']
    );
  });

  it('always attempts the first item, however tight the budget', async () => {
    const out = await runBulk(['only'], ok, { budgetMs: 1, now: () => 10_000_000 });
    expect(out.successes).toEqual(['only']);
    expect(out.notAttempted).toEqual([]);
  });

  it('reports the item that threw to the caller for logging', async () => {
    const onItemError = vi.fn();
    await runBulk(['x'], async () => {
      throw new Error('kaput');
    }, { onItemError });
    expect(onItemError).toHaveBeenCalledOnce();
    expect(onItemError.mock.calls[0]![0]).toBe('x');
  });

  it('handles an empty selection without inventing work', async () => {
    const out = await runBulk([], ok);
    expect(out).toEqual({ successes: [], failures: [], notAttempted: [] });
  });
});

describe('bulkBudgetMs', () => {
  it('leaves room inside the 60s function limit by default', () => {
    delete process.env.BULK_BUDGET_MS;
    expect(bulkBudgetMs()).toBe(40_000);
  });

  it('clamps an override rather than trusting it', () => {
    process.env.BULK_BUDGET_MS = '999999';
    expect(bulkBudgetMs()).toBe(55_000);
    process.env.BULK_BUDGET_MS = '10';
    expect(bulkBudgetMs()).toBe(5_000);
    process.env.BULK_BUDGET_MS = 'not a number';
    expect(bulkBudgetMs()).toBe(40_000);
    delete process.env.BULK_BUDGET_MS;
  });
});
