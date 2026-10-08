// @vitest-environment node
/**
 * services/imports.ts promoteCustomerBatchCore — only one customer import may be
 * promoted at a time (RK-3), and the refusal leaves the refused batch exactly as
 * it was.
 *
 * The claim used to be taken BEFORE the "another import is live" check, and the
 * refusal cleared only the lease: a READY batch was left PROMOTING with no lease,
 * which the batch page shows as "Promote interrupted." with Resume and the Work
 * list as "Import to resume", although nothing had run. Now:
 *
 *  - the usual case (the other import is already live) is refused before the
 *    claim, writing nothing to this batch;
 *  - the race (the other batch claimed between that check and this claim) is
 *    caught by the check after the claim, and the claim is undone in one guarded
 *    write that puts back the status AND lease the claim replaced.
 *
 * The ImportBatch table is a small in-memory fake that evaluates the where
 * clauses the claim, the checks and the undo send. The same refusal against
 * Postgres is in tests/integration/promote-chunked-resume.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ db: {} as Record<string, unknown>, warn: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {},
}));
vi.mock('@/lib/alert', () => ({ sendAlert: async () => {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: () => {}, warn: h.warn, error: () => {}, debug: () => {} },
}));
vi.mock('@/lib/db', () => ({ prisma: h.db }));

import { promoteCustomerBatchAction } from '@/services/imports';

type Batch = {
  id: string;
  kind: 'CUSTOMER' | 'ACCOUNT';
  filename: string;
  uploadedAt: Date;
  status: string;
  promoteLeaseBy: string | null;
  promoteLeaseUntil: Date | null;
};

type Where = Record<string, unknown>;

/** The where shapes the promote's batch queries use; anything else throws. */
function matches(row: Batch, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (!(key in row)) throw new Error(`fake: the batch has no field "${key}"`);
    const value = row[key as keyof Batch];
    const t = (v: unknown) => (v instanceof Date ? v.getTime() : v) as number | string | null;
    if (cond === null || typeof cond !== 'object' || cond instanceof Date)
      return t(value) === t(cond);
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      if (op === 'not') return t(value) !== t(arg);
      if (value === null) return false;
      if (op === 'gt') return t(value)! > t(arg)!;
      if (op === 'lt') return t(value)! < t(arg)!;
      throw new Error(`fake: operator "${op}" is not modelled`);
    });
  });
}

let table: Batch[];
let writes: Array<{ where: Where; data: Partial<Batch> }>;
/** Runs once, just before the claim on batch-9 is applied (simulates a racing claim). */
let beforeClaim: (() => void) | null;
/** How many of the next writes that undo a claim fail (a dropped connection). */
let failUndos: number;

const pick = (row: Batch, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k as keyof Batch]])) : row;

beforeEach(() => {
  writes = [];
  beforeClaim = null;
  failUndos = 0;
  h.warn.mockClear();
  Object.assign(h.db, {
    importBatch: {
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
          const row = table.find((b) => b.id === where.id);
          return row ? pick({ ...row }, select) : null;
        }
      ),
      findFirst: vi.fn(
        async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
          const row = table.find((b) => matches(b, where));
          return row ? pick({ ...row }, select) : null;
        }
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Batch> }) => {
        if (where.id === 'batch-9' && data.status === 'PROMOTING' && beforeClaim) {
          beforeClaim();
          beforeClaim = null;
        }
        if (where.promoteLeaseBy && data.status !== 'PROMOTING' && failUndos > 0) {
          failUndos -= 1;
          throw new Error('Connection terminated unexpectedly');
        }
        writes.push({ where, data });
        const hit = table.filter((b) => matches(b, where));
        for (const b of hit) Object.assign(b, data);
        return { count: hit.length };
      }),
    },
    // Reached only if the promote got past the refusal: stop it there.
    region: {
      findMany: vi.fn(async () => {
        throw new Error('the promote went past the refusal');
      }),
    },
    route: { findMany: vi.fn(async () => []) },
  });
});

const T0 = new Date('2026-10-01T08:00:00Z');
const live = () => new Date(Date.now() + 60_000);

function batch(over: Partial<Batch>): Batch {
  return {
    id: 'batch-9',
    kind: 'CUSTOMER',
    filename: 'mine.xlsx',
    uploadedAt: T0,
    status: 'READY',
    promoteLeaseBy: null,
    promoteLeaseUntil: null,
    ...over,
  };
}

async function promote() {
  const fd = new FormData();
  fd.set('batchId', 'batch-9');
  return promoteCustomerBatchAction(fd);
}

const mine = () => table.find((b) => b.id === 'batch-9')!;

describe('promote while another customer import is being promoted', () => {
  it('is refused before the claim: the READY batch is not written at all', async () => {
    table = [
      batch({}),
      batch({
        id: 'other',
        filename: 'other.xlsx',
        status: 'PROMOTING',
        promoteLeaseBy: 'someone:tok',
        promoteLeaseUntil: live(),
      }),
    ];
    const before = { ...mine() };

    const res = await promote();

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/Another customer import \(\\"other.xlsx\\"\)/);
    expect(mine()).toEqual(before); // still READY, no lease — not "Promote interrupted."
    expect(writes).toEqual([]); // nothing was claimed, so nothing had to be undone
  });

  it('the race: a claim undone after the second check puts the batch back to READY with no lease', async () => {
    const other = batch({ id: 'other', filename: 'other.xlsx', status: 'READY' });
    table = [batch({}), other];
    // The other batch is claimed after this promote's first check but before its
    // claim, so only the check after the claim can see it.
    beforeClaim = () =>
      Object.assign(other, {
        status: 'PROMOTING',
        promoteLeaseBy: 'someone:tok',
        promoteLeaseUntil: live(),
      });

    const res = await promote();

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/Another customer import/);
    expect(mine()).toMatchObject({
      status: 'READY',
      promoteLeaseBy: null,
      promoteLeaseUntil: null,
    });
    // The undo is ONE write, guarded by this promote's own token.
    const undo = writes.at(-1)!;
    expect(writes).toHaveLength(2);
    expect(undo.where).toEqual({ id: 'batch-9', promoteLeaseBy: expect.stringMatching(/^stew:/) });
    expect(undo.data).toEqual({ status: 'READY', promoteLeaseBy: null, promoteLeaseUntil: null });
    // The other import's claim is untouched.
    expect(other).toMatchObject({ status: 'PROMOTING', promoteLeaseBy: 'someone:tok' });
  });

  it('the race on an interrupted batch puts back its old, expired lease too', async () => {
    const expired = new Date(Date.now() - 5_000);
    const other = batch({ id: 'other', filename: 'other.xlsx', status: 'READY' });
    table = [
      batch({ status: 'PROMOTING', promoteLeaseBy: 'stew:old', promoteLeaseUntil: expired }),
      other,
    ];
    beforeClaim = () =>
      Object.assign(other, {
        status: 'PROMOTING',
        promoteLeaseBy: 'someone:tok',
        promoteLeaseUntil: live(),
      });

    const res = await promote();

    expect(res.ok).toBe(false);
    expect(mine()).toEqual(
      batch({ status: 'PROMOTING', promoteLeaseBy: 'stew:old', promoteLeaseUntil: expired })
    );
  });

  // The undo is a separate write from the claim (in one transaction, each claim
  // would be hidden from the other batch's check). If it fails, a READY batch is
  // left PROMOTING under this promote's live lease: blocking every other promote
  // until it runs out, then reading "Promote interrupted". So it is tried twice.
  it('the race: an undo that fails once is tried again, and the batch is put back', async () => {
    const other = batch({ id: 'other', filename: 'other.xlsx', status: 'READY' });
    table = [batch({}), other];
    beforeClaim = () =>
      Object.assign(other, {
        status: 'PROMOTING',
        promoteLeaseBy: 'someone:tok',
        promoteLeaseUntil: live(),
      });
    failUndos = 1;

    const res = await promote();

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/Another customer import/);
    expect(mine()).toEqual(batch({}));
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('the race: an undo that fails twice is logged, and the refusal still names the other import', async () => {
    const other = batch({ id: 'other', filename: 'other.xlsx', status: 'READY' });
    table = [batch({}), other];
    beforeClaim = () =>
      Object.assign(other, {
        status: 'PROMOTING',
        promoteLeaseBy: 'someone:tok',
        promoteLeaseUntil: live(),
      });
    failUndos = 2;

    const res = await promote();

    expect(JSON.stringify(res)).toMatch(/Another customer import \(\\"other.xlsx\\"\)/);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'batch-9' }),
      'import.promote.unclaim_failed'
    );
    // Left claimed under this promote's lease: resumable once that runs out.
    expect(mine()).toMatchObject({
      status: 'PROMOTING',
      promoteLeaseBy: expect.stringMatching(/^stew:/),
    });
  });

  it.each(['PROMOTED', 'PARSING'])(
    'a %s batch is told its state, not that another import is running',
    async (status) => {
      // Promote of a batch that cannot be promoted, while another import is
      // live: the answer is the batch's own state, as with nothing else running.
      table = [
        batch({ status }),
        batch({
          id: 'other',
          filename: 'other.xlsx',
          status: 'PROMOTING',
          promoteLeaseBy: 'someone:tok',
          promoteLeaseUntil: live(),
        }),
      ];

      const res = await promote();

      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain(
        `Batch is in state ${status} — only READY or interrupted batches can be promoted.`
      );
      expect(mine()).toEqual(batch({ status }));
    }
  );

  it('the claim only takes the batch as the preflight read it', async () => {
    // Read as PROMOTED; a fix puts it back to READY between that read and the
    // claim. The claim must not take it — an undo would otherwise put back
    // PROMOTED over a batch that has CLEAN rows again.
    table = [batch({ status: 'PROMOTED' })];
    beforeClaim = () => Object.assign(mine(), { status: 'READY' });

    const res = await promote();

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/changed just as Promote started/);
    expect(mine()).toEqual(batch({ status: 'READY' }));
  });
});
