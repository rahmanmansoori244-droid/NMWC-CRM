// @vitest-environment node
/**
 * Owner decision 7 (2026-10-07): a customer's status follows its shops
 * (lib/customer-status.ts, the rule in lib/customer-status-rule.ts). The last
 * open branch closed, or a closure leaving every shop closed, closes the customer;
 * a branch reopened opens it; nothing else moves it; an archived customer is never
 * touched; every move is audited, once, from the status before the caller's own
 * writes. statusDrift reads existing data by the same rule
 * (scripts/ops/customer-status-drift.ts). The paths that call it — an approved close,
 * a direct write, a reactivation, an import — are exercised on Postgres in
 * tests/integration/customer-status-follows.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerStatus, type Prisma } from '@prisma/client';

const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('@/lib/audit', () => audit);

import {
  NO_STATUS_EVENTS,
  branchStatusEvents,
  customerStatusFollowing,
  followBranchStatus,
  statusEvents,
} from '@/lib/customer-status';
import { statusDrift } from '@/lib/customer-status-rule';

const { ACTIVE, CLOSED, SUSPENDED } = CustomerStatus;
const ENV = { actorId: 'u1', ip: null, userAgent: null };
const CLOSED_OPEN = { closed: true, closedOpen: true, reopened: false };
const CLOSED_OTHER = { closed: true, closedOpen: false, reopened: false };
const REOPENED = { closed: false, closedOpen: false, reopened: true };

describe('statusEvents / branchStatusEvents', () => {
  it('a branch moving to CLOSED closes; to ACTIVE reopens; a new branch counts from nothing', () => {
    // An open shop closed is told apart from a suspended (or new) one closed.
    expect(statusEvents(ACTIVE, CLOSED)).toEqual(CLOSED_OPEN);
    expect(statusEvents(SUSPENDED, CLOSED)).toEqual(CLOSED_OTHER);
    expect(statusEvents(CLOSED, ACTIVE)).toEqual(REOPENED);
    expect(statusEvents(SUSPENDED, ACTIVE)).toEqual(REOPENED);
    expect(statusEvents(ACTIVE, SUSPENDED)).toEqual(NO_STATUS_EVENTS);
    expect(statusEvents(CLOSED, SUSPENDED)).toEqual(NO_STATUS_EVENTS);
    expect(statusEvents(null, ACTIVE)).toEqual(REOPENED);
    expect(statusEvents(null, CLOSED)).toEqual(CLOSED_OTHER);
  });

  it('between two reads: only the branches whose status changed, or that are new', () => {
    const before = new Map([
      ['b1', ACTIVE],
      ['b2', CLOSED],
    ]);
    expect(branchStatusEvents(before, new Map(before))).toEqual(NO_STATUS_EVENTS);
    expect(branchStatusEvents(before, new Map([['b1', CLOSED], ['b2', CLOSED]]))).toEqual(CLOSED_OPEN);
    expect(branchStatusEvents(before, new Map([['b1', ACTIVE], ['b2', ACTIVE]]))).toEqual(REOPENED);
    expect(branchStatusEvents(before, new Map([...before, ['b3', ACTIVE]]))).toEqual(REOPENED);
    expect(branchStatusEvents(new Map(), new Map([['b1', CLOSED]]))).toEqual(CLOSED_OTHER);
    // One shop closed and another reopened in the same change: both.
    expect(branchStatusEvents(before, new Map([['b1', CLOSED], ['b2', ACTIVE]]))).toEqual({
      closed: true,
      closedOpen: true,
      reopened: true,
    });
  });
});

describe('customerStatusFollowing', () => {
  const closed = CLOSED_OPEN;
  const reopened = REOPENED;

  it('the last open branch closed closes the customer — ACTIVE or SUSPENDED', () => {
    expect(customerStatusFollowing(ACTIVE, [CLOSED], closed)).toBe(CLOSED);
    expect(customerStatusFollowing(ACTIVE, [CLOSED, CLOSED], closed)).toBe(CLOSED);
    expect(customerStatusFollowing(ACTIVE, [CLOSED, SUSPENDED], closed)).toBe(CLOSED);
    expect(customerStatusFollowing(SUSPENDED, [CLOSED], closed)).toBe(CLOSED);
  });

  it('a suspended shop closed: the customer closes only once every shop is closed (fixer review)', () => {
    // [SUSPENDED, SUSPENDED], one closed: no open shop closed, and a suspended one stands.
    expect(customerStatusFollowing(SUSPENDED, [CLOSED, SUSPENDED], CLOSED_OTHER)).toBe(SUSPENDED);
    expect(customerStatusFollowing(ACTIVE, [CLOSED, SUSPENDED], CLOSED_OTHER)).toBe(ACTIVE);
    // ...the other one closed too: every shop is closed.
    expect(customerStatusFollowing(SUSPENDED, [CLOSED, CLOSED], CLOSED_OTHER)).toBe(CLOSED);
    expect(customerStatusFollowing(ACTIVE, [CLOSED], CLOSED_OTHER)).toBe(CLOSED);
  });

  it('closing one of several shops leaves the customer as it was while another is open', () => {
    expect(customerStatusFollowing(ACTIVE, [CLOSED, ACTIVE], closed)).toBe(ACTIVE);
    // A hold a person set is not lifted by a closure.
    expect(customerStatusFollowing(SUSPENDED, [CLOSED, ACTIVE], closed)).toBe(SUSPENDED);
  });

  it('a branch reopened makes the customer ACTIVE: one ACTIVE branch is enough', () => {
    expect(customerStatusFollowing(CLOSED, [ACTIVE], reopened)).toBe(ACTIVE);
    expect(customerStatusFollowing(CLOSED, [ACTIVE, CLOSED], reopened)).toBe(ACTIVE);
    expect(customerStatusFollowing(SUSPENDED, [ACTIVE, CLOSED], reopened)).toBe(ACTIVE);
    expect(customerStatusFollowing(ACTIVE, [ACTIVE], reopened)).toBe(ACTIVE);
  });

  it('no event, or no live branch, moves nothing', () => {
    for (const current of [ACTIVE, CLOSED, SUSPENDED]) {
      expect(customerStatusFollowing(current, [CLOSED], NO_STATUS_EVENTS)).toBe(current);
      expect(customerStatusFollowing(current, [ACTIVE], NO_STATUS_EVENTS)).toBe(current);
      expect(customerStatusFollowing(current, [], { closed: true, closedOpen: true, reopened: true })).toBe(current);
    }
    // A branch suspended is not a closure: the customer is left alone.
    expect(customerStatusFollowing(ACTIVE, [SUSPENDED], NO_STATUS_EVENTS)).toBe(ACTIVE);
  });
});

describe('followBranchStatus', () => {
  const tx = {
    customer: { findUnique: vi.fn(), update: vi.fn() },
  };
  const txc = tx as unknown as Prisma.TransactionClient;
  const stored = (status: CustomerStatus, branches: CustomerStatus[], deletedAt: Date | null = null) =>
    tx.customer.findUnique.mockResolvedValue({ status, deletedAt, branches: branches.map((s) => ({ status: s })) });

  beforeEach(() => {
    tx.customer.findUnique.mockReset();
    tx.customer.update.mockReset();
    audit.writeAudit.mockReset();
  });

  it('moves the status, bumps the version, and writes a CLOSE audit row on the customer', async () => {
    stored(ACTIVE, [CLOSED]);
    const moved = await followBranchStatus(txc, ENV, 'c1', CLOSED_OPEN, { actorId: 'u1', via: 'approved request e1' });
    expect(moved).toEqual({ from: ACTIVE, to: CLOSED });
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: CLOSED, lastEditedById: 'u1', version: { increment: 1 } },
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(txc, ENV, {
      action: 'CLOSE',
      entityType: 'Customer',
      entityId: 'c1',
      before: { status: ACTIVE },
      after: { status: CLOSED },
      reason: 'customer status follows its branches: approved request e1',
    });
  });

  it('a reopening is a REACTIVATE audit row', async () => {
    stored(CLOSED, [ACTIVE, CLOSED]);
    expect(await followBranchStatus(txc, ENV, 'c1', REOPENED, { actorId: 'u1', via: 'x' })).toEqual({
      from: CLOSED,
      to: ACTIVE,
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(txc, ENV, expect.objectContaining({ action: 'REACTIVATE', after: { status: ACTIVE } }));
  });

  it('an archived customer is never touched', async () => {
    stored(ACTIVE, [CLOSED], new Date());
    expect(await followBranchStatus(txc, ENV, 'c1', CLOSED_OPEN, { actorId: 'u1', via: 'x' })).toBeNull();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('nothing to do writes nothing: no event (nothing read), or the status already right', async () => {
    expect(await followBranchStatus(txc, ENV, 'c1', NO_STATUS_EVENTS, { actorId: 'u1', via: 'x' })).toBeNull();
    expect(tx.customer.findUnique).not.toHaveBeenCalled();
    stored(ACTIVE, [CLOSED, ACTIVE]);
    expect(await followBranchStatus(txc, ENV, 'c1', CLOSED_OPEN, { actorId: 'u1', via: 'x' })).toBeNull();
    tx.customer.findUnique.mockResolvedValue(null);
    expect(await followBranchStatus(txc, ENV, 'gone', CLOSED_OPEN, { actorId: 'u1', via: 'x' })).toBeNull();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });
});

describe('followBranchStatus: a caller that wrote the status itself (the import, item 20)', () => {
  const tx = { customer: { findUnique: vi.fn(), update: vi.fn() } };
  const txc = tx as unknown as Prisma.TransactionClient;
  const stored = (status: CustomerStatus, branches: CustomerStatus[]) =>
    tx.customer.findUnique.mockResolvedValue({ status, deletedAt: null, branches: branches.map((st) => ({ status: st })) });

  beforeEach(() => {
    tx.customer.findUnique.mockReset();
    tx.customer.update.mockReset();
    audit.writeAudit.mockReset();
  });

  it('the whole move is one audit row from the status before its writes — the file said SUSPENDED, the rule then closed it', async () => {
    stored(SUSPENDED, [CLOSED]);
    expect(
      await followBranchStatus(txc, ENV, 'c1', CLOSED_OPEN, { actorId: 'u1', via: 'import b1', statusBefore: ACTIVE })
    ).toEqual({ from: ACTIVE, to: CLOSED });
    expect(tx.customer.update).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      txc,
      ENV,
      expect.objectContaining({ action: 'CLOSE', before: { status: ACTIVE }, after: { status: CLOSED } })
    );
  });

  it('the file’s own move, with no branch event, is audited too; a move back to where it began is not', async () => {
    stored(CLOSED, [CLOSED]);
    expect(
      await followBranchStatus(txc, ENV, 'c1', NO_STATUS_EVENTS, { actorId: 'u1', via: 'import b1', statusBefore: ACTIVE })
    ).toEqual({ from: ACTIVE, to: CLOSED });
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).toHaveBeenCalledWith(txc, ENV, expect.objectContaining({ action: 'CLOSE', before: { status: ACTIVE } }));
    // A hold the file stated is an UPDATE row.
    audit.writeAudit.mockReset();
    stored(SUSPENDED, [ACTIVE]);
    expect(
      await followBranchStatus(txc, ENV, 'c1', NO_STATUS_EVENTS, { actorId: 'u1', via: 'x', statusBefore: ACTIVE })
    ).toEqual({ from: ACTIVE, to: SUSPENDED });
    expect(audit.writeAudit).toHaveBeenCalledWith(txc, ENV, expect.objectContaining({ action: 'UPDATE', after: { status: SUSPENDED } }));
    audit.writeAudit.mockReset();
    stored(ACTIVE, [ACTIVE]);
    expect(await followBranchStatus(txc, ENV, 'c1', NO_STATUS_EVENTS, { actorId: 'u1', via: 'x', statusBefore: ACTIVE })).toBeNull();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });
});

describe('statusDrift: existing data read by the same rule (scripts/ops/customer-status-drift.ts)', () => {
  const STATUSES = [ACTIVE, CLOSED, SUSPENDED];
  // Every multiset of up to three live branch statuses.
  const sets: CustomerStatus[][] = [[]];
  for (const a of STATUSES) {
    sets.push([a]);
    for (const b of STATUSES) {
      sets.push([a, b]);
      for (const c of STATUSES) sets.push([a, b, c]);
    }
  }

  it('names the contradictions the rule would have fixed, and only those', () => {
    expect(statusDrift(ACTIVE, [CLOSED, CLOSED])).toEqual({ kind: 'close', to: CLOSED });
    expect(statusDrift(SUSPENDED, [CLOSED])).toEqual({ kind: 'close', to: CLOSED });
    expect(statusDrift(CLOSED, [ACTIVE, CLOSED])).toEqual({ kind: 'reopen', to: ACTIVE });
    // Whether its last open shop closed or was suspended is not in the data.
    expect(statusDrift(ACTIVE, [SUSPENDED, CLOSED])).toEqual({ kind: 'review' });
    // A hold a person set; consistent ones; no live branch.
    expect(statusDrift(SUSPENDED, [ACTIVE])).toBeNull();
    expect(statusDrift(ACTIVE, [ACTIVE, CLOSED])).toBeNull();
    expect(statusDrift(CLOSED, [CLOSED, SUSPENDED])).toBeNull();
    expect(statusDrift(ACTIVE, [])).toBeNull();
  });

  it('every move it proposes is the move the rule makes on the matching change, and none leaves a closed customer with an open shop', () => {
    for (const current of STATUSES) {
      for (const live of sets) {
        const d = statusDrift(current, live);
        const at = `${current} [${live.join(', ')}]`;
        if (d?.kind === 'close') expect(customerStatusFollowing(current, live, CLOSED_OTHER), at).toBe(CLOSED);
        if (d?.kind === 'reopen') expect(customerStatusFollowing(current, live, REOPENED), at).toBe(ACTIVE);
        if (!d) expect(current === CLOSED && live.includes(ACTIVE), at).toBe(false);
      }
    }
  });
});
