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
 *  - X-TEMIX-2: re-downloading a batch is rate-limited and is recorded before
 *    the file is returned; when that record fails, no file.
 *  - Gap 31 review: a NOT VALID CHECK is evaluated on every write of a row, and
 *    one row that breaks it fails the whole statement. A queued customer whose
 *    stored record breaks a Customer rule (lib/db-rules.ts) is HELD BACK by
 *    Generate — left queued, named apart from F11's — so the claim cannot fail
 *    for everyone; Mark loaded names the archived rows of an older batch that
 *    break one instead of failing in words that name nobody.
 *  - Gap 14 (lossless paths): the FILE — on Generate and on every re-download —
 *    is recorded through lib/export-record.ts with the customers written to it,
 *    its name and its bytes (an ExportJob and its EXPORT row), after it is built
 *    and before it is returned. Generate's claim keeps its own EXPORT row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  isTest: boolean;
  // Gap 31 review: the columns the Customer CHECKs read (lib/db-rules.ts).
  paymentTerms: string;
  creditLimit: number | null;
  paymentTermDays: number | null;
  channelId: string | null;
  subChannelId: string | null;
  primaryPhoneNorm: string | null;
  crNumberNorm: string | null;
};

const h = vi.hoisted(() => ({
  writeAudit: vi.fn(),
  /** lib/export-record.ts recordExport: the file's record (gap 14). */
  recordExport: vi.fn(),
  checkLimit: vi.fn(),
  batchFind: vi.fn(),
  /** markTemixBatchLoadedAction's claim and its follow-up read, inside the transaction. */
  batchClaim: vi.fn(),
  batchFindTx: vi.fn(),
  batchFindOrThrowTx: vi.fn(),
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
vi.mock('@/lib/export-record', () => ({ recordExport: h.recordExport }));

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
    // Gap 24: the change context each transaction sets first (lib/change-context.ts).
    $executeRaw: async () => 1,
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
      findUniqueOrThrow: h.batchFindOrThrowTx,
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
    // Gap 30: a real customer (TEMIX_QUEUE_WHERE leaves test customers out).
    isTest: false,
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
  h.recordExport.mockResolvedValue({ exportJobId: 'job-1', fileSha256: 'f'.repeat(64) });
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
    // Gap 14: the file itself, with exactly the customers written to it (N2 is not).
    expect(h.recordExport).toHaveBeenCalledTimes(1);
    const [env, rec] = h.recordExport.mock.calls[0];
    expect(env).toMatchObject({ actorId: 'stew' });
    expect(rec).toMatchObject({
      kind: 'temix-batch',
      filters: { batchId: 'batch-new', action: 'generate', heldBack: ['N2'] },
      filename: res.data.filename,
      rowCount: res.data.rowCount,
      reason: `generate ${res.data.rowCount} rows / 3 customers`,
    });
    expect([...rec.customerIds].sort()).toEqual(['id-N1', 'id-N3', 'id-N4']);
    // The bytes recorded are the bytes returned.
    expect(Buffer.from(rec.bytes).toString('base64')).toBe(res.data.base64);
    // Nothing but the file's own fields goes back to the browser.
    expect(Object.keys(res.data).sort()).toEqual(['base64', 'batchId', 'customerCount', 'filename', 'heldBack', 'rowCount']);
  });

  it('Generate returns no file when the file cannot be recorded (the batch stays, for its Download)', async () => {
    model.state.rows = [cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD })];
    h.recordExport.mockRejectedValue(new Error('insert failed'));
    let out: unknown;
    try {
      out = await generateTemixBatchAction();
    } catch (e) {
      out = e;
    }
    expect(JSON.stringify(out ?? null)).not.toMatch(/"base64"/);
    expect(out && typeof out === 'object' && 'ok' in out && (out as { ok: boolean }).ok).toBeFalsy();
    // The claim committed before the file was built: the customer is in the batch.
    expect(row('N1')).toMatchObject({ temixSyncState: 'UPLOADED', lastTemixUploadBatchId: 'batch-new' });
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

  it('gap 30: a flagged test customer is not in the queue, so it is never held back or named', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1' }), // live, SYNCED, not queued
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING, isTest: true }),
      cust({ nmwcCode: 'N3', temixCode: null, temixSyncState: TemixSyncState.PENDING_UPLOAD }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok && res.data.heldBack).toBeUndefined();
    expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N3']);
    expect(row('N2').temixSyncState).toBe('DEACTIVATE_PENDING');
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
    expect(h.recordExport).not.toHaveBeenCalled();
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
      expect(h.recordExport).not.toHaveBeenCalled();
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

  it('records the copy — its customers, name and bytes — once, before the file is returned', async () => {
    const res = await downloadTemixBatchAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Gap 14: through lib/export-record.ts, no bare EXPORT row of its own.
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(h.recordExport).toHaveBeenCalledTimes(1);
    const [env, rec] = h.recordExport.mock.calls[0];
    expect(env).toMatchObject({ actorId: 'stew' });
    expect(rec).toMatchObject({
      kind: 'temix-batch',
      filters: { batchId: 'batch-old', action: 'redownload', heldBack: [] },
      customerIds: ['id-N1'],
      filename: res.data.filename,
      rowCount: 1,
      reason: 'redownload 1 rows / 1 customers',
    });
    expect(Buffer.from(rec.bytes).toString('base64')).toBe(res.data.base64);
    expect(res.data.base64.length).toBeGreaterThan(0);
  });

  it('returns no file when the record cannot be written', async () => {
    h.recordExport.mockRejectedValue(new Error('insert failed'));
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
      // The record says which customers this copy held — not the held-back one —
      // and which were held back.
      expect(h.recordExport.mock.calls[0][1]).toMatchObject({
        kind: 'temix-batch',
        filters: { batchId: 'batch-old', action: 'redownload', heldBack: ['N2'] },
        customerIds: ['id-N1', 'id-N3'],
        reason: 'redownload 2 rows / 2 customers',
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
      expect(h.recordExport).not.toHaveBeenCalled();
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
    expect(h.recordExport).not.toHaveBeenCalled();
  });
});

describe('the upload file is named by the Oman day (launch fix)', () => {
  // 21:30 UTC on the 7th is 01:30 on the 8th in Oman; the process runs in UTC,
  // as on Vercel. A UTC date named a batch generated before 04:00 for the day before.
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T21:30:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('on Generate', async () => {
    model.state.rows = [cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD })];
    const res = await generateTemixBatchAction();
    expect(res.ok && res.data.filename).toBe('temix-upload-2026-10-08-ch-new.xlsx');
  });

  it('on a re-download', async () => {
    model.state.rows = [cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.UPLOADED })];
    h.batchFind.mockResolvedValue({ id: 'batch-old', customerIds: ['id-N1'] });
    const f = new FormData();
    f.set('batchId', 'batch-old');
    const res = await downloadTemixBatchAction(f);
    expect(res.ok && res.data.filename).toBe('temix-upload-2026-10-08-ch-old.xlsx');
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

describe('gap 31 review: a customer whose stored record breaks a database rule is held back, not the batch', () => {
  it('Generate leaves it queued and names it apart; everyone else goes out, and the claim never touches it', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      // Credit figures on a cash customer: Customer_credit_terms_only_credit.
      cust({ nmwcCode: 'N2', temixCode: 'T2', temixSyncState: TemixSyncState.PENDING_UPLOAD, creditLimit: 500 }),
      // An archived one with a CR key written before the CR rule: Customer_crNumberNorm_shape.
      cust({ nmwcCode: 'N3', temixCode: 'T3', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING, crNumberNorm: 'cr 12' }),
      cust({ nmwcCode: 'N4', temixCode: 'T4', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      // A CREDIT customer with its figures is fine.
      cust({ nmwcCode: 'N5', temixCode: 'T5', temixSyncState: TemixSyncState.PENDING_UPLOAD, paymentTerms: 'CREDIT', creditLimit: 900, paymentTermDays: 30 }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.heldForRules).toEqual(['N2', 'N3']);
    expect(res.data.heldBack).toBeUndefined();
    expect(res.data.customerCount).toBe(3);
    expect(await sheetCodes(res.data.base64)).toEqual(['UPSERT:N1', 'DEACTIVATE:N4', 'UPSERT:N5']);
    // They keep their place in the queue, untouched.
    expect(row('N2')).toMatchObject({ temixSyncState: 'PENDING_UPLOAD', lastTemixUploadBatchId: null });
    expect(row('N3')).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING', lastTemixUploadBatchId: null });
    // The claim is bounded to the rest: the database never sees a write of N2 or N3.
    const { TEMIX_QUEUE_WHERE } = await import('@/lib/temix');
    expect(model.state.flipWhere).toEqual({ AND: [TEMIX_QUEUE_WHERE, { id: { in: ['id-N1', 'id-N4', 'id-N5'] } }] });
    // The EXPORT row says who and which rule; the file's record says who.
    expect(h.writeAudit.mock.calls[0][2]).toMatchObject({
      action: 'EXPORT',
      after: {
        customers: 3,
        heldForRules: [
          { nmwcCode: 'N2', rules: ['Customer_credit_terms_only_credit'] },
          { nmwcCode: 'N3', rules: ['Customer_crNumberNorm_shape'] },
        ],
      },
    });
    expect(h.recordExport.mock.calls[0][1]).toMatchObject({ filters: { action: 'generate', heldForRules: ['N2', 'N3'] } });
    expect([...h.recordExport.mock.calls[0][1].customerIds].sort()).toEqual(['id-N1', 'id-N4', 'id-N5']);
  });

  it('both kinds held back at once are named apart', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1', temixSyncState: TemixSyncState.PENDING_UPLOAD }),
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD, primaryPhoneNorm: '99123456' }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok && res.data.heldBack).toEqual(['N2']);
    expect(res.ok && res.data.heldForRules).toEqual(['N3']);
    expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N1']);
  });

  it('when every queued customer is held back, it says which, for which reason, and nothing is flipped', async () => {
    model.state.rows = [
      cust({ nmwcCode: 'N1', temixCode: 'T1' }), // live, SYNCED, not queued
      cust({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at, temixSyncState: TemixSyncState.DEACTIVATE_PENDING }),
      cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD, subChannelId: 'sc-1', channelId: null }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toBe(
      'Nothing can go to Temix yet. Held back for review: N2. Held back until their stored records are corrected (each breaks a data rule): N3.'
    );
    expect(row('N3').temixSyncState).toBe('PENDING_UPLOAD');
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(h.recordExport).not.toHaveBeenCalled();
  });

  it('a customer held back for a rule alone has its own words', async () => {
    model.state.rows = [cust({ nmwcCode: 'N3', temixCode: 'T3', temixSyncState: TemixSyncState.PENDING_UPLOAD, paymentTermDays: 30 })];
    const res = await generateTemixBatchAction();
    expect(!res.ok && res.message).toBe(
      'Nothing can go to Temix yet. Held back until their stored records are corrected (each breaks a data rule): N3.'
    );
  });

  it('a record that keeps every rule is never held back', async () => {
    model.state.rows = [
      cust({
        nmwcCode: 'N1',
        temixCode: 'T1',
        temixSyncState: TemixSyncState.PENDING_UPLOAD,
        primaryPhoneNorm: '+96899123456',
        crNumberNorm: 'CR1234567',
        channelId: 'ch-1',
        subChannelId: 'sc-1',
      }),
    ];
    const res = await generateTemixBatchAction();
    expect(res.ok && res.data.heldForRules).toBeUndefined();
    expect(res.ok && (await sheetCodes(res.data.base64))).toEqual(['UPSERT:N1']);
  });

  describe('Mark loaded', () => {
    const fd = () => {
      const f = new FormData();
      f.set('batchId', 'batch-1');
      return f;
    };
    const inBatch = { temixSyncState: TemixSyncState.UPLOADED, lastTemixUploadAt: at, lastTemixUploadBatchId: 'batch-1' };
    beforeEach(() => {
      h.batchClaim.mockResolvedValue({ count: 1 });
    });

    it('settles the batch deactivations as before when none breaks a rule', async () => {
      model.state.rows = [
        cust({ nmwcCode: 'N1', temixCode: 'T1', ...inBatch }),
        cust({ nmwcCode: 'N2', temixCode: 'T2', ...inBatch, deletedAt: at }),
      ];
      h.batchFindOrThrowTx.mockResolvedValue({ id: 'batch-1', customerIds: ['id-N1', 'id-N2'] });
      const res = await markTemixBatchLoadedAction(fd());
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
      expect(row('N1').temixSyncState).toBe('UPLOADED');
      expect(row('N2').temixSyncState).toBe('SYNCED');
      expect(h.writeAudit.mock.calls[0][2]).toMatchObject({ after: { deactivationsSettled: 1 } });
    });

    it('an archived row of an older batch that breaks a rule is named, and nothing is settled', async () => {
      model.state.rows = [
        cust({ nmwcCode: 'N2', temixCode: 'T2', ...inBatch, deletedAt: at }),
        cust({ nmwcCode: 'N3', temixCode: 'T3', ...inBatch, deletedAt: at, creditLimit: 100 }),
      ];
      h.batchFindOrThrowTx.mockResolvedValue({ id: 'batch-1', customerIds: ['id-N2', 'id-N3'] });
      const res = await markTemixBatchLoadedAction(fd());
      expect(res).toMatchObject({
        ok: false,
        code: 'VALIDATION_FAILED',
        message:
          'This batch cannot be marked loaded yet: the stored records of N3 break a data rule (Customer_credit_terms_only_credit), so they cannot be settled. Have them corrected, then mark it loaded.',
      });
      expect(model.state.rows.map((c) => c.temixSyncState)).toEqual(['UPLOADED', 'UPLOADED']);
      expect(h.writeAudit).not.toHaveBeenCalled();
    });
  });
});
