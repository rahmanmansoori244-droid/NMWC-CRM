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
 *
 * Gap 37: the request-in-review check runs AFTER the lock (so it serialises with
 * a submit that takes the same lock), the customer's unsent drafts are closed
 * with a row each, its sent-back requests are left as they are, and the
 * SOFT_DELETE row lists both (openRequests). The real race is
 * tests/integration/archive-open-requests.test.ts.
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
  // Gap 37: the customer's open requests as the archive reads them.
  open: [] as Array<{ id: string; state: string; cycle: number; process: string }>,
  inReview: null as { id: string } | null,
  claimCount: 1,
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
    // Gap 24: the change context each transaction sets first (lib/change-context.ts).
    $executeRaw: async () => 1,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.calls.push({ op: '$queryRaw', args: { sql: strings.join('?'), values } });
      return [];
    },
    customerEdit: {
      findFirst: async (args: unknown) => {
        h.calls.push({ op: 'customerEdit.findFirst', args });
        return h.inReview;
      },
      findMany: async (args: unknown) => {
        h.calls.push({ op: 'customerEdit.findMany', args });
        return h.open;
      },
      updateMany: async (args: unknown) => {
        h.calls.push({ op: 'customerEdit.updateMany', args });
        return { count: h.claimCount };
      },
    },
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
  h.open = [];
  h.inReview = null;
  h.claimCount = 1;
});

/** Gap 37: what the SOFT_DELETE row says when the customer had no open request. */
const NONE = { closedDrafts: [], closedDraftCount: 0, sentBack: [], sentBackCount: 0 };

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
      openRequests: NONE,
    });
  });

  it('the last live holder (the other one already archived): queued for deactivation as before, no skip noted', async () => {
    h.rows = { C1: { ...live('N1', 'T1'), deletedAt: new Date('2026-01-01') }, C2: live('N2', 'T1') };
    const res = await archive('C2');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claim().args.data).toMatchObject({ temixSyncState: 'DEACTIVATE_PENDING' });
    expect(claim().args.data.temixSyncPendingSince).toBeInstanceOf(Date);
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({ temixSyncState: 'DEACTIVATE_PENDING', openRequests: NONE });
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
      openRequests: NONE,
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
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({ temixSyncState: 'DEACTIVATE_PENDING', openRequests: NONE });
    const holders = h.calls.find((c) => c.op === 'customer.findMany') as { args: { where: unknown } };
    expect(holders.args.where).toEqual({ temixCode: 'N3', deletedAt: null, id: { not: 'C3' } });
  });

  it('no Temix code and never uploaded: leaves the queue as before, holders not asked, no skip noted, whoever holds its customer code', async () => {
    h.rows = { C1: live('N1', 'N4'), C4: live('N4', null, 'PENDING_UPLOAD') };
    expect((await archive('C4')).ok).toBe(true);
    // Never uploaded, no code: nothing for Temix to deactivate.
    expect(claim().args.data).toMatchObject({ temixSyncState: 'SYNCED' });
    expect(h.writeAudit.mock.calls[0][2].after).toEqual({ temixSyncState: 'SYNCED', openRequests: NONE });
    expect(at('customer.findMany')).toBe(-1);
  });
});

describe('archiveCustomerAction — gap 37, the customer’s open requests', () => {
  it('checks for a request in review only AFTER the lock, and a request in review still refuses the archive', async () => {
    h.rows = { C1: live('N1', 'T1') };
    h.inReview = { id: 'E-REVIEW' };
    const res = await archive('C1');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('EDIT_OPEN');
    expect(at('$queryRaw')).toBeLessThan(at('customerEdit.findFirst'));
    expect(h.calls.filter((c) => c.op.endsWith('updateMany'))).toEqual([]);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('closes his unsent drafts with a row each, leaves the sent-back ones, and the SOFT_DELETE row lists both', async () => {
    h.rows = { C1: live('N1', 'T1') };
    h.open = [
      { id: 'E-D2', state: 'DRAFT', cycle: 1, process: 'UPDATE' },
      { id: 'E-N1', state: 'NEEDS_CORRECTION', cycle: 1, process: 'UPDATE' },
      { id: 'E-D1', state: 'DRAFT', cycle: 1, process: 'UPDATE' },
    ];
    const res = await archive('C1');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const read = h.calls.find((c) => c.op === 'customerEdit.findMany') as { args: { where: unknown } };
    expect(read.args.where).toEqual({ customerId: 'C1', state: { in: ['DRAFT', 'NEEDS_CORRECTION'] } });
    const claims = h.calls.filter((c) => c.op === 'customerEdit.updateMany') as Array<{ args: { where: Record<string, unknown>; data: Record<string, unknown> } }>;
    // The drafts only, each claimed on its state and cycle; the sent-back one is not touched.
    expect(claims.map((c) => c.args.where.id)).toEqual(['E-D2', 'E-D1']);
    for (const c of claims) {
      expect(c.args.where).toMatchObject({ customerId: 'C1', state: 'DRAFT', cycle: 1 });
      expect(c.args.data).toMatchObject({
        state: 'REJECTED',
        decisionCategory: 'withdrawn',
        reviewedById: 'stew',
        pendingRole: null,
        slaDueAt: null,
        escalationLevel: 0,
      });
      expect(c.args.data.reviewedAt).toBeInstanceOf(Date);
      expect(String(c.args.data.decisionReason)).toMatch(/archived/);
    }
    // One UPDATE row per closed draft, then the SOFT_DELETE row listing them.
    const rows = h.writeAudit.mock.calls.map((c) => c[2]);
    expect(rows.map((r) => [r.action, r.entityId])).toEqual([
      ['UPDATE', 'E-D2'],
      ['UPDATE', 'E-D1'],
      ['SOFT_DELETE', 'C1'],
    ]);
    expect(rows[0].after).toMatchObject({ state: 'REJECTED', from: 'DRAFT', closedBy: 'archive', customerId: 'C1' });
    expect(rows[2].after.openRequests).toEqual({ closedDrafts: ['E-D1', 'E-D2'], closedDraftCount: 2, sentBack: ['E-N1'], sentBackCount: 1 });
    // After the customer's own claim, inside the same transaction.
    expect(at('customer.updateMany')).toBeLessThan(at('customerEdit.findMany'));
  });

  it('a draft that moved meanwhile is left, and not listed as closed', async () => {
    h.rows = { C1: live('N1', 'T1') };
    h.open = [{ id: 'E-D1', state: 'DRAFT', cycle: 1, process: 'UPDATE' }];
    h.claimCount = 0;
    expect((await archive('C1')).ok).toBe(true);
    const rows = h.writeAudit.mock.calls.map((c) => c[2]);
    expect(rows.map((r) => r.action)).toEqual(['SOFT_DELETE']);
    expect(rows[0].after.openRequests).toEqual(NONE);
  });
});
