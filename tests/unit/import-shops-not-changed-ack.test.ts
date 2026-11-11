// @vitest-environment node
/**
 * services/import-fixes.ts acknowledgeShopsNotChangedAction — code review
 * 2026-11-10, finding 28 (second round), with the database mocked. The same
 * action against Postgres, after a real promote, is in
 * tests/integration/import-batch-guard.test.ts (RUN_IMPORT_TESTS).
 *
 * What was wrong: the count of rows loaded with their shop NOT changed was an
 * alert inside the Promote button, and the refresh to PROMOTED took the button
 * away, so the Steward never saw it (nor the "✓ Done" result behind it). The
 * count now lives on the batch and the page shows it until the Steward
 * acknowledges it; this pins who may, what is stored and what is logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type Fn = ReturnType<typeof vi.fn>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  role: 'STEWARD',
  audit: vi.fn(async () => {}),
  revalidated: [] as string[],
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: h.role, username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => h.revalidated.push(p), revalidateTag: () => {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: h.audit,
}));
vi.mock('@/lib/db', () => ({ prisma: h.db }));

import { acknowledgeShopsNotChangedAction } from '@/services/import-fixes';

type Batch = { id: string; status: string; promoteLeaseUntil: Date | null; rows: number; acked: number };

let batch: Batch | null;
let lockSql: string[];
let sources: string[];
let tx: { $queryRaw: Fn; $executeRaw: Fn; importBatch: { update: Fn } };

beforeEach(() => {
  h.role = 'STEWARD';
  h.audit.mockClear();
  h.revalidated.length = 0;
  batch = { id: 'batch-9', status: 'PROMOTED', promoteLeaseUntil: null, rows: 2, acked: 0 };
  lockSql = [];
  sources = [];
  tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      lockSql.push(strings.join('?'));
      return batch ? [{ ...batch }] : [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sources.push(String(Prisma.sql(strings, ...values).values[1]));
      return 1;
    }),
    importBatch: {
      update: vi.fn(async ({ data }: { data: { shopNotChangedAckRows: number } }) => {
        batch!.acked = data.shopNotChangedAckRows;
        return batch;
      }),
    },
  };
  Object.assign(h.db, { $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) });
});

function send(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return acknowledgeShopsNotChangedAction(fd);
}
const refusal = (res: Awaited<ReturnType<typeof send>>) =>
  res.ok ? null : res.fields ? Object.values(res.fields).join(' ') : res.message;

describe('acknowledging the rows loaded with their shop NOT changed', () => {
  it('the Steward, on a finished batch: stored (how many, when, who) and audited in the same transaction', async () => {
    const before = Date.now();
    const res = await send({ batchId: 'batch-9', rows: '2' });
    expect(res).toEqual({ ok: true, data: { acknowledged: 2, total: 2 } });
    expect(lockSql[0]).toMatch(/FROM "ImportBatch" WHERE "id" = \? FOR UPDATE/);
    expect(sources).toEqual(['import-fix:batch-9:shops-not-changed']);
    const { where, data } = tx.importBatch.update.mock.calls[0]![0];
    expect(where).toEqual({ id: 'batch-9' });
    expect(data).toEqual({ shopNotChangedAckRows: 2, shopNotChangedAckAt: expect.any(Date), shopNotChangedAckById: 'stew' });
    expect((data.shopNotChangedAckAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [client, env, row] = h.audit.mock.calls[0] as unknown as [unknown, { actorId: string }, Record<string, unknown>];
    expect(client).toBe(tx);
    expect(env.actorId).toBe('stew');
    expect(row).toEqual({
      action: 'UPDATE',
      entityType: 'ImportBatch',
      entityId: 'batch-9',
      before: { shopNotChangedAckRows: 0 },
      after: { shopNotChangedAckRows: 2, shopNotChangedRows: 2, acknowledged: 2 },
      reason: 'Rows loaded with something about their shop not applied (shop NOT changed, or route not applied), acknowledged by the Data Steward: 2',
    });
    expect(h.revalidated).toContain('/import/batch-9');
  });

  it('a second tap (or another tab) changes nothing and writes no audit row', async () => {
    await send({ batchId: 'batch-9', rows: '2' });
    const res = await send({ batchId: 'batch-9', rows: '2' });
    expect(res).toEqual({ ok: true, data: { acknowledged: 0, total: 2 } });
    expect(tx.importBatch.update).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('rows a later promote added are not covered by an earlier acknowledgement: only the new ones are recorded', async () => {
    batch = { ...batch!, rows: 5, acked: 2 };
    const res = await send({ batchId: 'batch-9', rows: '5' });
    expect(res).toEqual({ ok: true, data: { acknowledged: 3, total: 5 } });
    const row = (h.audit.mock.calls[0] as unknown as [unknown, unknown, { before: unknown; after: unknown }])[2];
    expect(row.before).toEqual({ shopNotChangedAckRows: 2 });
    expect(row.after).toEqual({ shopNotChangedAckRows: 5, shopNotChangedRows: 5, acknowledged: 3 });
  });

  it('a page showing more rows than the batch holds is out of date: refused, nothing written', async () => {
    const res = await send({ batchId: 'batch-9', rows: '3' });
    expect(refusal(res)).toBe('This page is out of date — reload it and read the notice again.');
    expect(tx.importBatch.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refused while a promote is running on the batch (its count is still rising)', async () => {
    batch = { ...batch!, status: 'PROMOTING', promoteLeaseUntil: new Date(Date.now() + 60_000) };
    const res = await send({ batchId: 'batch-9', rows: '2' });
    expect(res.ok).toBe(false);
    expect(refusal(res)).toMatch(/being promoted right now/);
    expect(tx.importBatch.update).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'SUPERVISOR', 'SALESMAN', 'VIEWER'])('%s: refused before anything is read', async (role) => {
    h.role = role;
    const res = await send({ batchId: 'batch-9', rows: '2' });
    expect(res.ok).toBe(false);
    expect(lockSql).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([['0'], ['-1'], ['1.5'], ['two'], ['']])('a count of %j is refused', async (rows) => {
    const res = await send({ batchId: 'batch-9', rows });
    expect(refusal(res)).toBe('Say how many rows the notice showed.');
    expect(lockSql).toEqual([]);
  });

  it('a batch that does not exist', async () => {
    batch = null;
    const res = await send({ batchId: 'nope', rows: '2' });
    expect(res.ok).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
