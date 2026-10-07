// @vitest-environment node
/**
 * F11: merging two customers that share one Temix code queued the SURVIVING
 * identity for deactivation. The in-transaction loser claim asked only
 * resolveArchiveTemixState, which answers DEACTIVATE_PENDING for any coded
 * loser, while the winner was re-queued PENDING_UPLOAD — the next batch said
 * `UPSERT T1` and `DEACTIVATE T1`, and markTemixBatchLoaded then recorded the
 * deactivation as done.
 *
 * Now the two identities, read under the merge's row locks, are compared first
 * (lib/temix.ts mergeTemixClash): a crossed pair is refused before anything is
 * written. A loser code that another live customer still holds — the winner or
 * a third customer, locked with the pair — parks the loser SYNCED and the MERGE
 * audit says the deactivation was skipped and who holds the code. The database
 * mocked here; the real merge against Postgres is
 * tests/integration/merge-temix-shared-code.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

type Ident = {
  nmwcCode: string;
  temixCode: string | null;
  temixSyncState?: string;
  lastTemixUploadAt?: Date | null;
};

const h = vi.hoisted(() => ({
  ids: {} as Record<string, Ident>,
  // Live customers other than the pair, holding a Temix code.
  others: {} as Record<string, { nmwcCode: string; temixCode: string | null }>,
  // What the transaction reads for the loser's code, when it moved after the pre-read.
  loserCodeInTx: undefined as string | null | undefined,
  locks: [] as Array<{ sql: string; values: unknown[] }>,
  // The codes liveTemixCodeHolders asked about.
  holderAsks: [] as unknown[],
  writes: [] as Array<{ op: string; args: Record<string, unknown> }>,
  writeAudit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: h.writeAudit,
}));
vi.mock('@/lib/db', () => {
  const rec = (op: string, value: unknown) => async (args: Record<string, unknown>) => {
    h.writes.push({ op, args });
    return value;
  };
  const customer = (id: string) => ({
    id,
    legalName: `Shop ${id}`,
    deletedAt: null,
    temixSyncState: 'SYNCED',
    lastTemixUploadAt: null,
    crPhotoId: null,
    branches: [{ id: `br-${id}`, regionId: 'R1', routeId: 'RT1' }],
    ...h.ids[id],
  });
  const inTx = (id: string) =>
    id === 'L' && h.loserCodeInTx !== undefined ? { ...customer(id), temixCode: h.loserCodeInTx } : customer(id);
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.locks.push({ sql: strings.join('?'), values });
      return [];
    },
    customer: {
      findUnique: async ({ where }: { where: { id: string } }) => inTx(where.id),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => inTx(where.id),
      findMany: async ({ where }: { where: { temixCode: string; id: { not: string } } }) => {
        h.holderAsks.push(where.temixCode);
        return Object.entries({ ...h.ids, ...h.others })
          .filter(([id, c]) => c.temixCode === where.temixCode && id !== where.id.not)
          .map(([, c]) => ({ nmwcCode: c.nmwcCode }))
          .sort((a, b) => a.nmwcCode.localeCompare(b.nmwcCode));
      },
      update: rec('customer.update', {}),
      updateMany: rec('customer.updateMany', { count: 1 }),
    },
    // No open shop moves (owner decision 7's reopening on a merge: tests/integration/customer-status-follows.test.ts).
    branch: { count: async () => 0, updateMany: rec('branch.updateMany', { count: 1 }) },
    // No open request on the loser: the auto-close matches nothing, so its
    // read-back (launch fix 2026-10-07: settle and tell) finds nothing either.
    customerEdit: { updateMany: rec('customerEdit.updateMany', { count: 0 }), findMany: async () => [] },
    attachment: { updateMany: rec('attachment.updateMany', { count: 0 }) },
  };
  return {
    prisma: {
      customer: { findFirst: async ({ where }: { where: { id: string } }) => customer(where.id) },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  };
});

import { mergeCustomersAction } from '@/services/duplicates';

function merge(winner: Ident, loser: Ident) {
  h.ids = { W: winner, L: loser };
  const fd = new FormData();
  fd.set('winnerId', 'W');
  fd.set('loserId', 'L');
  return mergeCustomersAction(fd);
}
const loserClaim = () =>
  h.writes.find(
    (w) =>
      w.op === 'customer.updateMany' &&
      (w.args.where as { id?: string }).id === 'L' &&
      'deletedAt' in (w.args.data as object)
  )!;

beforeEach(() => {
  vi.clearAllMocks();
  h.writes = [];
  h.locks = [];
  h.holderAsks = [];
  h.others = {};
  h.loserCodeInTx = undefined;
  h.writeAudit.mockResolvedValue(undefined);
});

describe('mergeCustomersAction — F11', () => {
  it('the same Temix code on both: the loser is parked SYNCED, not deactivated, and the audit says so', async () => {
    const res = await merge({ nmwcCode: 'N1', temixCode: 'T1' }, { nmwcCode: 'N2', temixCode: 'T1' });
    expect(res.ok).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'SYNCED', temixSyncPendingSince: null });
    // The winner still goes to the next batch, as the one UPSERT for T1.
    expect(
      h.writes.some(
        (w) =>
          w.op === 'customer.updateMany' &&
          (w.args.where as { id?: string }).id === 'W' &&
          (w.args.data as { temixSyncState?: string }).temixSyncState === 'PENDING_UPLOAD'
      )
    ).toBe(true);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0][2]).toMatchObject({ action: 'MERGE' });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: ['N1'],
    });
  });

  it("a third live customer holds the loser's code: the loser is parked too, and the audit names the holder", async () => {
    h.others = { C3: { nmwcCode: 'N3', temixCode: 'T1' } };
    const res = await merge({ nmwcCode: 'N1', temixCode: 'T9' }, { nmwcCode: 'N2', temixCode: 'T1' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'SYNCED', temixSyncPendingSince: null });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: ['N3'],
    });
  });

  it("locks the pair together with the loser code's live holders, in one id order", async () => {
    await merge({ nmwcCode: 'N1', temixCode: 'T9' }, { nmwcCode: 'N2', temixCode: 'T1' });
    expect(h.locks).toHaveLength(1);
    expect(h.locks[0].sql).toMatch(/"temixCode" = \? AND "deletedAt" IS NULL\) ORDER BY "id" COLLATE "C" FOR UPDATE/);
    expect(h.locks[0].values).toContain('T1');
  });

  it("the loser's Temix code moved after the pre-read (so the lock covered the wrong holders): refused, nothing written", async () => {
    h.loserCodeInTx = 'T1';
    const res = await merge({ nmwcCode: 'N1', temixCode: 'T1' }, { nmwcCode: 'N2', temixCode: null });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.fields?._form).toMatch(/Temix code just changed/);
    expect(h.writes).toEqual([]);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('under the migrated convention too (nmwcCode == temixCode on the winner)', async () => {
    const res = await merge({ nmwcCode: 'N1', temixCode: 'N1' }, { nmwcCode: 'N2', temixCode: 'N1' });
    expect(res.ok).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'SYNCED' });
  });

  it.each([
    ["the loser's Temix code is the winner's customer code", { nmwcCode: 'N1', temixCode: null }, { nmwcCode: 'N2', temixCode: 'N1' }],
    ["the winner's Temix code is the loser's customer code", { nmwcCode: 'N1', temixCode: 'N2' }, { nmwcCode: 'N2', temixCode: null }],
  ])('%s: refused for Steward review before anything is written', async (_l, winner, loser) => {
    const res = await merge(winner, loser);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.fields?._form).toMatch(/could deactivate the surviving customer in Temix/);
    expect(h.writes).toEqual([]);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('different codes: the loser is queued for deactivation exactly as before, no skip noted', async () => {
    const res = await merge({ nmwcCode: 'N1', temixCode: 'T1' }, { nmwcCode: 'N2', temixCode: 'T2' });
    expect(res.ok).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING' });
    expect(h.writeAudit.mock.calls[0][2].after).toBeUndefined();
  });

  // Review of 8cb2509: an uncoded row's deactivation goes out keyed on its
  // customer code, and Generate holds it back while a live customer holds that
  // code as its Temix code. The merge asked only about the Temix code, so it
  // queued such a loser for a deactivation held back on every run, for good.
  it("an uncoded loser Temix knows, whose customer code a third live customer holds as its Temix code: parked, and the audit names the holder", async () => {
    h.others = { C3: { nmwcCode: 'N3', temixCode: 'N2' } };
    const res = await merge(
      { nmwcCode: 'N1', temixCode: 'T9' },
      { nmwcCode: 'N2', temixCode: null, temixSyncState: 'SYNCED', lastTemixUploadAt: new Date('2026-09-01') }
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'SYNCED', temixSyncPendingSince: null });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: ['N3'],
    });
    // Its customer code's holders are locked with the pair, and asked about.
    expect(h.locks[0].sql).toMatch(/"temixCode" = \? AND "deletedAt" IS NULL/);
    expect(h.locks[0].values).toContain('N2');
    expect(h.holderAsks).toEqual(['N2']);
  });

  it('an uncoded loser Temix knows, whose customer code nobody holds: queued for deactivation as before', async () => {
    const res = await merge({ nmwcCode: 'N1', temixCode: 'T9' }, { nmwcCode: 'N2', temixCode: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING' });
    expect(h.writeAudit.mock.calls[0][2].after).toBeUndefined();
  });

  it('an uncoded loser Temix never heard of: leaves the queue as before, holders not asked, no skip noted', async () => {
    h.others = { C3: { nmwcCode: 'N3', temixCode: 'N2' } };
    const res = await merge(
      { nmwcCode: 'N1', temixCode: 'T9' },
      { nmwcCode: 'N2', temixCode: null, temixSyncState: 'PENDING_UPLOAD', lastTemixUploadAt: null }
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(loserClaim().args.data).toMatchObject({ temixSyncState: 'SYNCED', temixSyncPendingSince: null });
    expect(h.holderAsks).toEqual([]);
    expect(h.writeAudit.mock.calls[0][2].after).toBeUndefined();
  });
});

// Every resolveArchiveTemixState caller asking who else holds the code is pinned
// across the codebase in tests/unit/temix-deactivation-guard.test.ts.
describe('structural: the loser is never resolved without the winner-identity comparison', () => {
  const code = stripComments(readFileSync('services/duplicates.ts', 'utf8'), 'services/duplicates.ts');
  const merge = code.slice(code.indexOf('async function mergeCustomersCore'), code.indexOf('export async function dismissDuplicateAction'));

  it('compares the identities read under the locks, and refuses a crossed pair before the first write', () => {
    const lock = merge.search(
      /await lockCustomersAndTemixCodeHolders\(tx, \[winner\.id, loser\.id\], deactivationCode\(loser\)\);/
    );
    const read = merge.search(/select: identity/);
    const clash = merge.search(/const temixClash = mergeTemixClash\(loserLive, winnerLive\);/);
    const refuse = merge.search(/if \(temixClash === 'CROSSED'\)/);
    const firstWrite = merge.search(/await tx\.branch\.updateMany\(/);
    expect(merge).toMatch(
      /const identity = \{\s*deletedAt: true,\s*nmwcCode: true,\s*temixCode: true,\s*lastTemixUploadAt: true,\s*temixSyncState: true,\s*\} as const;/
    );
    for (const i of [lock, read, clash, refuse, firstWrite]) expect(i).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(clash);
    expect(clash).toBeLessThan(refuse);
    expect(refuse).toBeLessThan(firstWrite);
  });
});
