// @vitest-environment node
/**
 * services/import-fixes.ts setImportOverwriteAction — the batch's "Overwrite CRM
 * fields from this sheet" option (code review 2026-11-10, finding 1), with the
 * database mocked. The same action against Postgres, and a promote under it, is
 * tests/integration/import-crm-fill-only.test.ts.
 *
 * A customer import fills blank CRM fields of a customer or shop that exists and
 * never replaces one on record. This option is the only way back to the old
 * behaviour, so who may switch it, when, and what it leaves behind are pinned.
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

import { setImportOverwriteAction } from '@/services/import-fixes';

type Batch = {
  id: string;
  kind: string;
  status: string;
  promoteLeaseUntil: Date | null;
  uploadedAt: Date;
  filename: string;
  overwriteCrmFields: boolean;
};

let batch: Batch | null;
let lockSql: string[];
let sources: string[];
let tx: { $queryRaw: Fn; $executeRaw: Fn; importBatch: { update: Fn } };

function ready(over: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-9',
    kind: 'CUSTOMER',
    status: 'READY',
    promoteLeaseUntil: null,
    uploadedAt: new Date('2026-11-01T06:00:00Z'),
    filename: 'bulk-fix.xlsx',
    overwriteCrmFields: false,
    ...over,
  };
}

beforeEach(() => {
  h.role = 'STEWARD';
  h.audit.mockClear();
  h.revalidated.length = 0;
  batch = ready();
  lockSql = [];
  sources = [];
  tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      lockSql.push(strings.join('?'));
      return batch ? [batch] : [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sources.push(String(Prisma.sql(strings, ...values).values[1]));
      return 1;
    }),
    importBatch: {
      update: vi.fn(async ({ data }: { data: Partial<Batch> }) => {
        Object.assign(batch!, data);
        return batch;
      }),
    },
  };
  Object.assign(h.db, { $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) });
});

function send(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return setImportOverwriteAction(fd);
}
const REASON = 'Bulk correction of shop addresses agreed with the owner';
const refusal = (res: Awaited<ReturnType<typeof send>>) =>
  res.ok ? null : (res.fields ? Object.values(res.fields).join(' ') : res.message);

describe('switching the option on', () => {
  it('the Steward, with a reason, on a batch ready to promote: on, dated, audited with the reason', async () => {
    const before = Date.now();
    const res = await send({ batchId: 'batch-9', on: 'on', reason: `  ${REASON}  ` });
    expect(res).toEqual({ ok: true, data: { on: true } });
    expect(tx.importBatch.update).toHaveBeenCalledTimes(1);
    const { where, data } = tx.importBatch.update.mock.calls[0]![0];
    expect(where).toEqual({ id: 'batch-9' });
    expect(data).toEqual({ overwriteCrmFields: true, overwriteCrmFieldsAt: expect.any(Date) });
    expect((data.overwriteCrmFieldsAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [client, env, row] = h.audit.mock.calls[0] as unknown as [unknown, { actorId: string }, Record<string, unknown>];
    // In the same transaction as the write, by the Steward.
    expect(client).toBe(tx);
    expect(env.actorId).toBe('stew');
    expect(row).toEqual({
      action: 'UPDATE',
      entityType: 'ImportBatch',
      entityId: 'batch-9',
      before: { overwriteCrmFields: false },
      after: { overwriteCrmFields: true },
      reason: `Overwrite CRM fields from this sheet switched ON: ${REASON}`,
    });
    expect(h.revalidated).toContain('/import/batch-9');
  });

  it('under the batch row lock the promote’s claim also takes, named in the history as this batch’s option', async () => {
    await send({ batchId: 'batch-9', on: 'on', reason: REASON });
    expect(lockSql[0]).toMatch(/FROM "ImportBatch" WHERE "id" = \? FOR UPDATE/);
    expect(lockSql[0]).toContain('"overwriteCrmFields"');
    expect(sources).toEqual(['import-fix:batch-9:overwrite']);
  });

  it.each([
    ['no reason', ''],
    ['a reason of nine characters', '123456789'],
    ['spaces', '              '],
  ])('%s: refused, and nothing is written', async (_label, reason) => {
    const res = await send({ batchId: 'batch-9', on: 'on', reason });
    expect(refusal(res)).toBe('Say why this sheet should replace CRM fields (10+ characters).');
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(batch!.overwriteCrmFields).toBe(false);
  });

  it('a reason over 500 characters is refused', async () => {
    const res = await send({ batchId: 'batch-9', on: 'on', reason: 'x'.repeat(501) });
    expect(refusal(res)).toBe('Keep the reason to 500 characters or fewer.');
    expect(batch!.overwriteCrmFields).toBe(false);
  });

  it.each(['SALESMAN', 'SUPERVISOR', 'MANAGER', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'SALES_DIRECTOR', 'VIEWER'])(
    'a %s cannot: only the Data Steward',
    async (role) => {
      h.role = role;
      const res = await send({ batchId: 'batch-9', on: 'on', reason: REASON });
      expect(res.ok).toBe(false);
      expect(h.db.$transaction).not.toHaveBeenCalled();
      expect(h.audit).not.toHaveBeenCalled();
      expect(batch!.overwriteCrmFields).toBe(false);
    }
  );

  it('not in the middle of a load: an interrupted batch (PROMOTING, no live lease) must be resumed first', async () => {
    batch = ready({ status: 'PROMOTING', promoteLeaseUntil: new Date(Date.now() - 60_000) });
    const res = await send({ batchId: 'batch-9', on: 'on', reason: REASON });
    expect(refusal(res)).toBe(
      'This batch is part-way through a promote — resume it first. The option cannot change in the middle of a load.'
    );
    expect(tx.importBatch.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('not while a promote is running on the batch (a live lease)', async () => {
    batch = ready({ status: 'PROMOTING', promoteLeaseUntil: new Date(Date.now() + 60_000) });
    const res = await send({ batchId: 'batch-9', on: 'on', reason: REASON });
    expect(res.ok).toBe(false);
    expect(refusal(res)).toMatch(/being promoted right now/);
    expect(tx.importBatch.update).not.toHaveBeenCalled();
  });

  it.each(['PROMOTED', 'PARSING'])('not on a %s batch: there is nothing left for it to apply to', async (status) => {
    batch = ready({ status });
    const res = await send({ batchId: 'batch-9', on: 'on', reason: REASON });
    expect(refusal(res)).toBe('Only a batch that is ready to promote can change this option.');
    expect(tx.importBatch.update).not.toHaveBeenCalled();
  });

  it('a batch left FAILED by the old single-pass promote can still take it, as it can still be promoted', async () => {
    batch = ready({ status: 'FAILED' });
    expect((await send({ batchId: 'batch-9', on: 'on', reason: REASON })).ok).toBe(true);
  });

  it('not on an account-master batch, and not on a batch that does not exist', async () => {
    batch = ready({ kind: 'ACCOUNT' });
    expect((await send({ batchId: 'batch-9', on: 'on', reason: REASON })).ok).toBe(false);
    batch = null;
    expect((await send({ batchId: 'nope', on: 'on', reason: REASON })).ok).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('already on: said, and no second audit row', async () => {
    batch = ready({ overwriteCrmFields: true });
    const res = await send({ batchId: 'batch-9', on: 'on', reason: REASON });
    expect(refusal(res)).toBe('The option is already on for this batch.');
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('anything but "on" or "off" is refused', async () => {
    for (const on of ['', 'true', 'yes']) {
      const res = await send({ batchId: 'batch-9', on, reason: REASON });
      expect(refusal(res)).toBe('Say whether the option is to be on or off.');
    }
    expect(refusal(await send({ on: 'on', reason: REASON }))).toBe('Batch required.');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('switching it off again', () => {
  it('needs no reason, is audited, and leaves the date it was last switched on as the record', async () => {
    batch = ready({ overwriteCrmFields: true });
    const res = await send({ batchId: 'batch-9', on: 'off' });
    expect(res).toEqual({ ok: true, data: { on: false } });
    expect(tx.importBatch.update.mock.calls[0]![0].data).toEqual({ overwriteCrmFields: false });
    expect((h.audit.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>])[2]).toEqual({
      action: 'UPDATE',
      entityType: 'ImportBatch',
      entityId: 'batch-9',
      before: { overwriteCrmFields: true },
      after: { overwriteCrmFields: false },
      reason: 'Overwrite CRM fields from this sheet switched off',
    });
  });

  it('already off: said, and nothing is written', async () => {
    const res = await send({ batchId: 'batch-9', on: 'off' });
    expect(refusal(res)).toBe('The option is already off for this batch.');
    expect(tx.importBatch.update).not.toHaveBeenCalled();
  });
});
