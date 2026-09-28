// @vitest-environment node
/**
 * services/temix.ts against a small in-memory customer table that honours the
 * where clauses the service uses.
 *
 *  - F11, the batch invariant: a deactivation carrying a Temix code a live
 *    customer still holds is HELD BACK — it and any queued row with the same
 *    code stay queued and are named — while every other customer goes out.
 *    A whole batch is never refused over one pair; one that races in after the
 *    check rolls the batch back instead of going out.
 *  - X-TEMIX-2: re-downloading a batch is rate-limited and writes one EXPORT
 *    audit row before the file is returned; when that write fails, no file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TemixSyncState } from '@prisma/client';
import { parseWorkbook } from '@/lib/excel';

type Cust = {
  id: string;
  nmwcCode: string;
  temixCode: string | null;
  deletedAt: Date | null;
  temixSyncState: TemixSyncState;
  lastTemixUploadAt: Date | null;
  lastTemixUploadBatchId: string | null;
};

const h = vi.hoisted(() => ({
  writeAudit: vi.fn(),
  checkLimit: vi.fn(),
  batchFind: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: h.checkLimit }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: h.writeAudit,
}));

const model = vi.hoisted(() => {
  type Where = Record<string, unknown> | undefined;
  type Row = Record<string, unknown>;
  const state = { rows: [] as Row[], beforeFlip: null as null | (() => void) };
  /** The where shapes services/temix.ts uses, and nothing else (an unknown key fails loudly). */
  function matches(c: Row, where: Where): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === 'AND') return (v as Row[]).every((w) => matches(c, w));
      if (k === 'OR') return (v as Row[]).some((w) => matches(c, w));
      if (v === null) return c[k] === null;
      if (typeof v === 'object' && !(v instanceof Date)) {
        const op = v as { not?: unknown; in?: unknown[]; notIn?: unknown[] };
        if ('not' in op) return op.not === null ? c[k] !== null : c[k] !== op.not;
        if (op.in) return op.in.includes(c[k]);
        if (op.notIn) return !op.notIn.includes(c[k]);
        throw new Error(`unmodelled where on ${k}: ${JSON.stringify(v)}`);
      }
      return c[k] === v;
    });
  }
  const customer = {
    count: async ({ where }: { where: Where }) => state.rows.filter((c) => matches(c, where)).length,
    findMany: async ({ where, orderBy }: { where: Where; orderBy?: unknown }) => {
      const out = state.rows.filter((c) => matches(c, where)).map((c) => ({ ...c }));
      if (orderBy) out.sort((a, b) => String(a.nmwcCode).localeCompare(String(b.nmwcCode)));
      return out;
    },
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      if (data.temixSyncState === 'UPLOADED' && state.beforeFlip) {
        state.beforeFlip();
        state.beforeFlip = null;
      }
      const hit = state.rows.filter((c) => matches(c, where));
      for (const c of hit) Object.assign(c, data);
      return { count: hit.length };
    },
  };
  return { state, customer };
});

vi.mock('@/lib/db', () => {
  const customerModel = model.customer;
  const tx = {
    customer: customerModel,
    temixSyncBatch: {
      create: async () => ({ id: 'batch-new' }),
      update: async () => ({}),
    },
  };
  return {
    prisma: {
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      customer: customerModel,
      attachment: { groupBy: async () => [] },
      temixSyncBatch: { findUnique: h.batchFind },
    },
  };
});

import { generateTemixBatchAction, downloadTemixBatchAction } from '@/services/temix';

const at = new Date('2026-09-20T08:00:00Z');
function cust(over: Partial<Cust> & { nmwcCode: string }): Record<string, unknown> {
  return {
    id: `id-${over.nmwcCode}`,
    temixCode: null,
    deletedAt: null,
    temixSyncState: TemixSyncState.SYNCED,
    lastTemixUploadAt: null,
    lastTemixUploadBatchId: null,
    legalName: `Shop ${over.nmwcCode}`,
    paymentTerms: 'CASH',
    creditLimit: null,
    paymentTermDays: null,
    crNumber: null,
    primaryPhone: null,
    altPhone: null,
    contactPerson: null,
    channel: null,
    subChannel: null,
    branches: [],
    ...over,
  };
}
const row = (code: string) => model.state.rows.find((c) => c.nmwcCode === code)!;
const sheetCodes = async (base64: string) =>
  (await parseWorkbook(Buffer.from(base64, 'base64')))[0].rows.map((r) => `${r.sync_action}:${r.cust_code}`);

beforeEach(() => {
  vi.clearAllMocks();
  model.state.rows = [];
  model.state.beforeFlip = null;
  h.checkLimit.mockResolvedValue({ ok: true });
  h.writeAudit.mockResolvedValue(undefined);
});

describe('generateTemixBatchAction — F11: a shared code is held back, not the batch', () => {
  it('the merged pair (UPSERT T1 + DEACTIVATE T1) stays queued and named; everyone else goes out', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N4', temixCode: 'T4', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.heldBack).toEqual(['N1', 'N2']);
    expect(res.data.customerCount).toBe(2);
    expect(await sheetCodes(res.data.base64)).toEqual(['UPSERT:N3', 'DEACTIVATE:N4']);
    // Held rows keep their place in the queue, untouched.
    expect(row('N1')).toMatchObject({ temixSyncState: 'PENDING_UPLOAD', lastTemixUploadBatchId: null });
    expect(row('N2')).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING', lastTemixUploadBatchId: null });
    expect(row('N3')).toMatchObject({ temixSyncState: 'UPLOADED', lastTemixUploadBatchId: 'batch-new' });
    // And the EXPORT ledger row names them.
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0][2]).toMatchObject({
      action: 'EXPORT',
      entityType: 'TemixSyncBatch',
      after: { customers: 2, deactivations: 1, heldBack: ['N1', 'N2'] },
    });
  });

  it('a deactivation of a code held by a live customer OUTSIDE the queue is held back too', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1' }), // live, SYNCED, not queued
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      cust({ nmwcCode: 'N3', temixCode: null, temixSyncState: TemixSyncState.PENDING_UPLOAD }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok && res.data.heldBack).toEqual(['N2']);
    expect(row('N1').temixSyncState).toBe('SYNCED');
    expect(row('N2').temixSyncState).toBe('DEACTIVATE_PENDING');
    expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N3']);
  });

  it('when every queued row is held back, it says which, and nothing is flipped', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toBe('Nothing can go to Temix yet. Held back for review: N1, N2.');
    expect(model.state.rows.map((c) => c.temixSyncState)).toEqual(['PENDING_UPLOAD', 'DEACTIVATE_PENDING']);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('a clash that races in after the check rolls the batch back instead of going out', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T7' }), // live, SYNCED
      cust({ nmwcCode: 'N5', temixCode: 'T7' }), // live duplicate code, archived below
      cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
    ];
    // An archive commits between the check and the flip.
    model.state.beforeFlip = () =>
      Object.assign(row('N5'), { deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING });
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toBe(
      'The Temix queue changed while this batch was being built. Generate it again.'
    );
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('with nothing shared, the batch is what it always was', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N2', temixCode: 'T2', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.heldBack).toBeUndefined();
    expect(await sheetCodes(res.data.base64)).toEqual(['UPSERT:N1', 'DEACTIVATE:N2']);
  });
});

describe('downloadTemixBatchAction — X-TEMIX-2', () => {
  const fd = () => {
    const f = new FormData();
    f.set('batchId', 'batch-old');
    return f;
  };
  beforeEach(() => {
    model.state.rows = [cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.UPLOADED })];
    h.batchFind.mockResolvedValue({ id: 'batch-old', customerIds: ['id-N1'] });
  });

  it('writes one EXPORT audit row for the batch before the file is returned', async () => {
    const res = await downloadTemixBatchAction(fd());
    expect(res.ok).toBe(true);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    const [client, env, params] = h.writeAudit.mock.calls[0];
    expect(client).toBeNull();
    expect(env).toMatchObject({ actorId: 'stew' });
    expect(params).toEqual({
      action: 'EXPORT',
      entityType: 'TemixSyncBatch',
      entityId: 'batch-old',
      reason: 'redownload 1 rows / 1 customers',
    });
    expect(res.ok && res.data.base64.length).toBeGreaterThan(0);
  });

  it('returns no file when the audit row cannot be written', async () => {
    h.writeAudit.mockRejectedValue(new Error('insert failed'));
    let out: unknown;
    try {
      out = await downloadTemixBatchAction(fd());
    } catch (e) {
      out = e;
    }
    expect(JSON.stringify(out ?? null)).not.toMatch(/"base64"/);
    expect(out && typeof out === 'object' && 'ok' in out && (out as { ok: boolean }).ok).toBeFalsy();
  });

  it('is rate-limited in its own bucket, before anything is read', async () => {
    h.checkLimit.mockResolvedValue({ ok: false, retryAfterSec: 17 });
    const res = await downloadTemixBatchAction(fd());
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toBe('Wait 17s before downloading again.');
    expect(h.checkLimit).toHaveBeenCalledWith('temix-download:stew', { capacity: 3, refillPerSec: 0.05 });
    expect(h.batchFind).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});
