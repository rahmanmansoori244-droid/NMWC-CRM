// @vitest-environment node
/**
 * services/temix.ts against a small in-memory customer table that honours the
 * where clauses the service uses.
 *
 *  - F11, the batch invariant: a deactivation that would take away a code a live
 *    customer still holds as its Temix code — an uncoded archived row goes out
 *    under its customer code — is HELD BACK: that archived row stays queued and
 *    is named, while every other customer, the live holder included, goes out.
 *    A whole batch is never refused over one pair; one that races in after the
 *    check rolls the batch back instead of going out. A re-download applies the
 *    same rule to the batch's customers as they are now: one merged or archived
 *    since, parked with a code a live customer holds, is left out and named.
 *  - Generate locks the queue first, in id order (lib/locks.ts lockTemixQueue),
 *    and claims only the rows it locked, so it cannot deadlock with an archive or
 *    merge locking a customer and the holders of its code in that order.
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
  /** markTemixBatchLoadedAction's claim and its follow-up read, inside the transaction. */
  batchClaim: vi.fn(),
  batchFindTx: vi.fn(),
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
  const state = {
    rows: [] as Row[],
    beforeFlip: null as null | (() => void),
    /** The statements that lock or write, in the order they ran. */
    log: [] as string[],
    lockSql: [] as string[],
    flipWhere: undefined as Where,
  };
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
      if (data.temixSyncState === 'UPLOADED') {
        state.log.push('flip');
        state.flipWhere = where;
      }
      if (data.temixSyncState === 'UPLOADED' && state.beforeFlip) {
        state.beforeFlip();
        state.beforeFlip = null;
      }
      const hit = state.rows.filter((c) => matches(c, where));
      for (const c of hit) Object.assign(c, data);
      return { count: hit.length };
    },
  };
  return { state, customer, matches };
});

vi.mock('@/lib/db', () => {
  const customerModel = model.customer;
  const tx = {
    customer: customerModel,
    // lib/locks.ts lockTemixQueue: the rows the queue predicate selects, by id.
    // Its SQL is pinned against TEMIX_QUEUE_WHERE by temix-deactivation-guard.test.ts.
    $queryRaw: async (strings: TemplateStringsArray) => {
      const { TEMIX_QUEUE_WHERE } = await import('@/lib/temix');
      model.state.log.push('lock');
      model.state.lockSql.push(strings.join('?'));
      return model.state.rows
        .filter((c) => model.matches(c, TEMIX_QUEUE_WHERE as Record<string, unknown>))
        .map((c) => ({ id: String(c.id) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    temixSyncBatch: {
      create: async () => {
        model.state.log.push('batch.create');
        return { id: 'batch-new' };
      },
      update: async () => ({}),
      updateMany: h.batchClaim,
      findUnique: h.batchFindTx,
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

import { generateTemixBatchAction, downloadTemixBatchAction, markTemixBatchLoadedAction } from '@/services/temix';

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
  model.state.log = [];
  model.state.lockSql = [];
  model.state.flipWhere = undefined;
  h.checkLimit.mockResolvedValue({ ok: true });
  h.writeAudit.mockResolvedValue(undefined);
});

describe('generateTemixBatchAction — F11: a shared code is held back, not the batch', () => {
  it('the merged pair (UPSERT T1 + DEACTIVATE T1): only the deactivation is held back and named; the live holder and everyone else go out', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N4', temixCode: 'T4', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.heldBack).toEqual(['N2']);
    expect(res.data.customerCount).toBe(3);
    // The live customer's correction is not held hostage by the archived row.
    expect(await sheetCodes(res.data.base64)).toEqual(['UPSERT:N1', 'UPSERT:N3', 'DEACTIVATE:N4']);
    expect(row('N1')).toMatchObject({ temixSyncState: 'UPLOADED', lastTemixUploadBatchId: 'batch-new' });
    // The held row keeps its place in the queue, untouched.
    expect(row('N2')).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING', lastTemixUploadBatchId: null });
    expect(row('N3')).toMatchObject({ temixSyncState: 'UPLOADED', lastTemixUploadBatchId: 'batch-new' });
    // And the EXPORT ledger row names it.
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0][2]).toMatchObject({
      action: 'EXPORT',
      entityType: 'TemixSyncBatch',
      after: { customers: 3, deactivations: 1, heldBack: ['N2'] },
    });
  });

  it('an archived row with no Temix code goes out under its customer code, so a live holder of that code holds it back', async () => {
    model.state.rows = [
      // A live customer whose Temix code is N2's customer code.
      cust({ nmwcCode: 'N1', temixCode: 'N2', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N2', temixCode: null, deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      // Uncoded and archived, and nobody live holds N6: it goes out as before.
      cust({ nmwcCode: 'N6', temixCode: null, deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.heldBack).toEqual(['N2']);
    expect(await sheetCodes(res.data.base64)).toEqual(['UPSERT:N1', 'DEACTIVATE:N6']);
    expect(row('N2').temixSyncState).toBe('DEACTIVATE_PENDING');
  });

  it('an uncoded deactivation archived after the queue lock is not claimed: the next Generate holds it back', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'N5' }), // live, SYNCED, holds N5's customer code
      cust({ nmwcCode: 'N5', temixCode: null, lastTemixUploadAt: at }),
      cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
    ];
    // An archive commits after the lock: N5 was not queued, so not locked.
    model.state.beforeFlip = () =>
      Object.assign(row('N5'), { deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING });
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(true);
    expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N3']);
    expect(row('N5')).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING', lastTemixUploadBatchId: null });
    // The next Generate sees it, and holds it back.
    const next = await generateTemixBatchAction();
    expect(!next.ok && next.message).toBe('Nothing can go to Temix yet. Held back for review: N5.');
  });

  it('a customer that joins the queue after the lock waits for the next batch', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N9', temixCode: 'T9' }), // live, SYNCED
    ];
    // An edit approval re-queues N9 after the lock.
    model.state.beforeFlip = () => Object.assign(row('N9'), { temixSyncState: TemixSyncState.PENDING_UPLOAD });
    const res = await generateTemixBatchAction();
    expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N1']);
    expect(row('N9')).toMatchObject({ temixSyncState: 'PENDING_UPLOAD', lastTemixUploadBatchId: null });
  });

  it('locks the queue first, in id order, and claims only the rows it locked, less those held back', async () => {
    model.state.rows = [
      // Ids out of customer-code order.
      cust({ id: 'b', nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ id: 'B', nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      cust({ id: 'a', nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ id: 'c', nmwcCode: 'N4', temixCode: 'T4' }), // live, SYNCED, not queued
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok && res.data.heldBack).toEqual(['N2']);
    // One lock statement, before the batch row and the flip, and nothing locks after it.
    expect(model.state.log).toEqual(['lock', 'batch.create', 'flip']);
    expect(model.state.lockSql).toHaveLength(1);
    expect(model.state.lockSql[0]).toMatch(/ORDER BY "id" COLLATE "C" FOR UPDATE$/);
    // The flip is bounded by the locked ids: N2 held back, N4 never queued.
    const { TEMIX_QUEUE_WHERE } = await import('@/lib/temix');
    expect(model.state.flipWhere).toEqual({ AND: [TEMIX_QUEUE_WHERE, { id: { in: ['a', 'b'] } }] });
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
      cust({ nmwcCode: 'N1', temixCode: 'T1' }), // live, SYNCED, not queued
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toBe('Nothing can go to Temix yet. Held back for review: N2.');
    expect(model.state.rows.map((c) => c.temixSyncState)).toEqual(['SYNCED', 'DEACTIVATE_PENDING']);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['its Temix code', 'T7', 'T7'],
    ['its customer code, having no Temix code', null, 'N5'],
  ])(
    'a live customer taking a claimed deactivation’s code (%s) after the check rolls the batch back instead of going out',
    async (_label, temixCode, heldCode) => {
      model.state.rows = [
        cust({ nmwcCode: 'N5', temixCode, deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
        cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      ];
      // The lock holds the queue, not the holders: a live holder commits between the check and the flip.
      model.state.beforeFlip = () => model.state.rows.push(cust({ nmwcCode: 'N1', temixCode: heldCode }));
      const res = await generateTemixBatchAction();
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toBe(
        'The Temix queue changed while this batch was being built. Generate it again.'
      );
      expect(h.writeAudit).not.toHaveBeenCalled();
    }
  );

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

  describe('F11: a customer parked since the batch with a code a live customer holds is left out and named', () => {
    const old = { temixSyncState: TemixSyncState.UPLOADED, lastTemixUploadAt: at, lastTemixUploadBatchId: 'batch-old' };
    const snapshot = (...codes: string[]) =>
      h.batchFind.mockResolvedValue({ id: 'batch-old', customerIds: codes.map((c) => `id-${c}`) });

    it('after a same-code merge: the loser goes out as nothing, the winner and the rest as before', async () => {
      // B1 carried W (N1) and L (N2), both UPSERT T5000. L was then merged into W:
      // archived, parked SYNCED (skipped-shared-code), keeping T5000.
      model.state.rows = [
        cust({ nmwcCode: 'N1', temixCode: 'T5000', ...old }),
        cust({ nmwcCode: 'N2', temixCode: 'T5000', ...old, deletedAt: at, temixSyncState: TemixSyncState.SYNCED }),
        cust({ nmwcCode: 'N3', temixCode: 'T3', ...old }),
      ];
      snapshot('N1', 'N2', 'N3');
      const res = await downloadTemixBatchAction(fd());
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(await sheetCodes(res.data.base64)).toEqual(['UPSERT:N1', 'UPSERT:N3']);
      expect(res.data.heldBack).toEqual(['N2']);
      expect(res.data.customerCount).toBe(2);
      expect(h.writeAudit.mock.calls[0][2]).toEqual({
        action: 'EXPORT',
        entityType: 'TemixSyncBatch',
        entityId: 'batch-old',
        reason: 'redownload 2 rows / 2 customers',
        after: { heldBack: ['N2'] },
      });
    });

    it('the uncoded variant: a parked customer whose customer code a live customer holds as its Temix code', async () => {
      model.state.rows = [
        cust({ nmwcCode: 'N1', temixCode: 'N2', ...old }),
        cust({ nmwcCode: 'N2', temixCode: null, ...old, deletedAt: at, temixSyncState: TemixSyncState.SYNCED }),
      ];
      snapshot('N1', 'N2');
      const res = await downloadTemixBatchAction(fd());
      expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N1']);
      expect(res.ok && res.data.heldBack).toEqual(['N2']);
    });

    it('a deactivation whose code no live customer holds still goes out', async () => {
      model.state.rows = [
        cust({ nmwcCode: 'N1', temixCode: 'T1', ...old }),
        cust({ nmwcCode: 'N4', temixCode: 'T4', ...old, deletedAt: at }),
        cust({ nmwcCode: 'N6', temixCode: null, ...old, deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      ];
      snapshot('N1', 'N4', 'N6');
      const res = await downloadTemixBatchAction(fd());
      expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N1', 'DEACTIVATE:N4', 'DEACTIVATE:N6']);
      expect(res.ok && res.data.heldBack).toBeUndefined();
    });

    it('when every customer in the batch is held back, it says which, and returns no file', async () => {
      model.state.rows = [
        cust({ nmwcCode: 'N1', temixCode: 'T1' }), // live, SYNCED, not in the batch
        cust({ nmwcCode: 'N2', temixCode: 'T1', ...old, deletedAt: at, temixSyncState: TemixSyncState.SYNCED }),
      ];
      snapshot('N2');
      const res = await downloadTemixBatchAction(fd());
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toBe('Nothing in this batch can go to Temix now. Held back for review: N2.');
      expect(h.writeAudit).not.toHaveBeenCalled();
    });
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

// Launch fix (2026-10-07): these refusals carried their text only in
// fields._form, so their message was ValidationError's default "Validation
// failed" — all the Temix page showed. The message is now the text itself.
describe('Temix refusals say what happened', () => {
  it('Generate with an empty queue', async () => {
    const res = await generateTemixBatchAction();
    expect(res).toMatchObject({ ok: false, message: 'Nothing is pending for Temix upload.' });
  });

  it('Generate over the 5,000-customer cap', async () => {
    model.state.rows = Array.from({ length: 5001 }, (_, i) =>
      cust({ nmwcCode: `N${i}`, temixSyncState: TemixSyncState.PENDING_UPLOAD })
    );
    const res = await generateTemixBatchAction();
    expect(res).toMatchObject({
      ok: false,
      message: 'Queue exceeds 5000 customers — contact support to split the batch.',
    });
    expect(model.state.log).not.toContain('flip');
  });

  it('Mark loaded on a batch already marked', async () => {
    h.batchClaim.mockResolvedValue({ count: 0 });
    h.batchFindTx.mockResolvedValue({ markedLoadedAt: new Date('2026-10-01T08:00:00Z') });
    const fd = new FormData();
    fd.set('batchId', 'batch-1');
    const res = await markTemixBatchLoadedAction(fd);
    expect(res).toMatchObject({ ok: false, message: 'This batch is already marked as loaded.' });
  });
});
