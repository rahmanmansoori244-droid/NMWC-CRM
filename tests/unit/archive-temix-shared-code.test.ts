// @vitest-environment node
/**
 * F11, the archive path. Archiving a customer asked only resolveArchiveTemixState,
 * which answers DEACTIVATE_PENDING for any coded customer, so archiving one of
 * two live customers that share a Temix code queued the code's deactivation
 * while the other still held it. Generate then held that row back on every run,
 * for good: nothing in the app changes an archived row's Temix code.
 *
 * Now the archive locks the customer and every other live holder of its code
 * (lib/locks.ts lockCustomersAndTemixCodeHolders), re-reads it, and parks it
 * SYNCED when another live customer still holds the code, recording
 * temixDeactivation 'skipped-shared-code' in the SOFT_DELETE row. The last live
 * holder archived deactivates the code. Persistence is mocked here; the real
 * archive (and a two-connection race) against Postgres is
 * tests/integration/archive-temix-shared-code.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = {
  nmwcCode: string;
  temixCode: string | null;
  deletedAt: Date | null;
  temixSyncState: string;
  lastTemixUploadAt: Date | null;
};

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Row>,
  // What the transaction's fresh read sees, when it differs from the pre-read.
  freshTemixCode: undefined as string | null | undefined,
  calls: [] as Array<{ op: string; args: unknown }>,
  writeAudit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ managedRegionIds: [] }),
  assertCanEditCustomer: () => {},
}));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async (...args: unknown[]) => {
    h.calls.push({ op: 'writeAudit', args: args[2] });
    return h.writeAudit(...args);
  },
}));
vi.mock('@/lib/db', () => {
  const rec = (op: string, value: unknown) => async (args: unknown) => {
    h.calls.push({ op, args });
    return value;
  };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.calls.push({ op: '$queryRaw', args: { sql: strings.join('?'), values } });
      return [];
    },
    customerEdit: { findFirst: async () => null },
    customer: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        h.calls.push({ op: 'customer.findUniqueOrThrow', args: where });
        const r = h.rows[where.id];
        return h.freshTemixCode === undefined ? r : { ...r, temixCode: h.freshTemixCode };
      },
      findMany: async (args: {
        where: { temixCode: string; deletedAt: null; id: { not: string } };
      }) => {
        h.calls.push({ op: 'customer.findMany', args });
        const { where } = args;
        return Object.entries(h.rows)
          .filter(([id, r]) => r.temixCode === where.temixCode && !r.deletedAt && id !== where.id.not)
          .map(([, r]) => ({ nmwcCode: r.nmwcCode }))
          .sort((a, b) => a.nmwcCode.localeCompare(b.nmwcCode));
      },
      updateMany: rec('customer.updateMany', { count: 1 }),
    },
    branch: { updateMany: rec('branch.updateMany', { count: 1 }) },
  };
  return {
    prisma: {
      customer: {
        findFirst: async ({ where }: { where: { id: string } }) => {
          const r = h.rows[where.id];
          if (!r || r.deletedAt) return null;
          return { id: where.id, legalName: `Shop ${where.id}`, ...r, branches: [] };
        },
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  };
});

import { archiveCustomerAction } from '@/services/customers';

const live = (nmwcCode: string, temixCode: string | null, temixSyncState = 'SYNCED'): Row => ({
  nmwcCode,
  temixCode,
  deletedAt: null,
  temixSyncState,
  lastTemixUploadAt: null,
});

function archive(id: string) {
  const fd = new FormData();
  fd.set('customerId', id);
  fd.set('reason', 'Closed for good');
  return archiveCustomerAction(fd);
}
const claim = () => h.calls.find((c) => c.op === 'customer.updateMany') as { args: { data: Record<string, unknown> } };
const at = (op: string) => h.calls.findIndex((c) => c.op === op);

beforeEach(() => {
  h.calls = [];
  h.freshTemixCode = undefined;
  h.writeAudit.mockReset();
  h.writeAudit.mockResolvedValue(undefined);
});

describe('archiveCustomerAction — F11', () => {
  it('another live customer holds the same Temix code: parked SYNCED, not queued for deactivation, and the SOFT_DELETE row says so', async () => {
    h.rows = { C1: live('N1', 'T1'), C2: live('N2', 'T1') };
    const res = await archive('C2');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claim().args.data).toMatchObject({ temixSyncState: 'SYNCED', temixSyncPendingSince: null });
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.writeAudit.mock.calls[0][2]).toMatchObject({ action: 'SOFT_DELETE', entityId: 'C2' });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({
      temixSyncState: 'SYNCED',
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: ['N1'],
    });
  });

  it('the last live holder (the other one already archived): queued for deactivation as before, no skip noted', async () => {
    h.rows = { C1: { ...live('N1', 'T1'), deletedAt: new Date('2026-01-01') }, C2: live('N2', 'T1') };
    const res = await archive('C2');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claim().args.data).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING' });
    expect(claim().args.data.temixSyncPendingSince).toBeInstanceOf(Date);
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({ temixSyncState: 'DEACTIVATE_PENDING' });
  });

  it("locks the customer and the code's live holders before the fresh read, and asks who holds the code before the claim", async () => {
    h.rows = { C1: live('N1', 'T1'), C2: live('N2', 'T1') };
    await archive('C2');
    const lock = h.calls.find((c) => c.op === '$queryRaw') as { args: { sql: string; values: unknown[] } };
    expect(lock.args.sql).toMatch(/"temixCode" = \?/);
    expect(lock.args.sql).toMatch(/"deletedAt" IS NULL/);
    expect(lock.args.sql).toMatch(/ORDER BY "id" COLLATE "C" FOR UPDATE/);
    expect(lock.args.values).toContain('T1');
    const holders = h.calls.find((c) => c.op === 'customer.findMany') as { args: { where: unknown } };
    expect(holders.args.where).toEqual({ temixCode: 'T1', deletedAt: null, id: { not: 'C2' } });
    expect(at('$queryRaw')).toBeLessThan(at('customer.findUniqueOrThrow'));
    expect(at('customer.findUniqueOrThrow')).toBeLessThan(at('customer.findMany'));
    expect(at('customer.findMany')).toBeLessThan(at('customer.updateMany'));
  });

  it('a Temix code that moved after the pre-read (so the lock covered the wrong holders): refused, nothing written', async () => {
    h.rows = { C1: live('N1', 'T1'), C2: live('N2', null) };
    h.freshTemixCode = 'T1';
    const res = await archive('C2');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('STATE_CHANGED');
    expect(h.calls.filter((c) => c.op.endsWith('updateMany'))).toEqual([]);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  // Review of 8cb2509: an uncoded row's deactivation goes out keyed on its
  // customer code (cust_code), and Generate holds it back, and names it, while a
  // live customer holds that code as its Temix code. The archive asked only about
  // the Temix code, so it queued such a row for a deactivation that nothing in the
  // app could ever release: an archived row's code cannot change, and there is no
  // restore.
  it("no Temix code, known to Temix, and a live customer holds its customer code as its Temix code: parked SYNCED, and the SOFT_DELETE row names the holder", async () => {
    h.rows = {
      C0100: live('C0100', 'C0900'),
      C0900: { ...live('C0900', null, 'SYNCED'), lastTemixUploadAt: new Date('2026-09-01') },
    };
    const res = await archive('C0900');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claim().args.data).toMatchObject({ temixSyncState: 'SYNCED', temixSyncPendingSince: null });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({
      temixSyncState: 'SYNCED',
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: ['C0100'],
    });
    // The holders of its customer code are locked first, then asked about.
    const lock = h.calls.find((c) => c.op === '$queryRaw') as { args: { sql: string; values: unknown[] } };
    expect(lock.args.sql).toMatch(/"temixCode" = \? AND "deletedAt" IS NULL/);
    expect(lock.args.values).toContain('C0900');
    const holders = h.calls.find((c) => c.op === 'customer.findMany') as { args: { where: unknown } };
    expect(holders.args.where).toEqual({ temixCode: 'C0900', deletedAt: null, id: { not: 'C0900' } });
    expect(at('$queryRaw')).toBeLessThan(at('customer.findUniqueOrThrow'));
    expect(at('customer.findUniqueOrThrow')).toBeLessThan(at('customer.findMany'));
  });

  it('no Temix code, known to Temix, and nobody holds its customer code: queued for deactivation as before, no skip noted', async () => {
    h.rows = { C1: live('N1', 'T1'), C3: live('N3', null, 'SYNCED') };
    expect((await archive('C3')).ok).toBe(true);
    // A migrated (SYNCED) row is known to Temix even without a code.
    expect(claim().args.data).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING' });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({ temixSyncState: 'DEACTIVATE_PENDING' });
    const holders = h.calls.find((c) => c.op === 'customer.findMany') as { args: { where: unknown } };
    expect(holders.args.where).toEqual({ temixCode: 'N3', deletedAt: null, id: { not: 'C3' } });
  });

  it('no Temix code and never uploaded: leaves the queue as before, holders not asked, no skip noted, whoever holds its customer code', async () => {
    h.rows = { C1: live('N1', 'N4'), C4: live('N4', null, 'PENDING_UPLOAD') };
    expect((await archive('C4')).ok).toBe(true);
    // Never uploaded, no code: nothing for Temix to deactivate.
    expect(claim().args.data).toMatchObject({ temixSyncState: 'SYNCED' });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({ temixSyncState: 'SYNCED' });
    expect(at('customer.findMany')).toBe(-1);
  });
});
