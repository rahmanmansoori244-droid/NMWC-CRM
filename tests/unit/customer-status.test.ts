// @vitest-environment node
/**
 * Owner decision 7 (2026-10-07): a customer's status follows its shops
 * (lib/customer-status.ts). The last open branch closed closes the customer; a
 * branch reopened opens it; nothing else moves it; an archived customer is never
 * touched; every move is audited. The paths that call it — an approved close,
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

const { ACTIVE, CLOSED, SUSPENDED } = CustomerStatus;
const ENV = { actorId: 'u1', ip: null, userAgent: null };

describe('statusEvents / branchStatusEvents', () => {
  it('a branch moving to CLOSED closes; to ACTIVE reopens; a new branch counts from nothing', () => {
    expect(statusEvents(ACTIVE, CLOSED)).toEqual({ closed: true, reopened: false });
    expect(statusEvents(SUSPENDED, CLOSED)).toEqual({ closed: true, reopened: false });
    expect(statusEvents(CLOSED, ACTIVE)).toEqual({ closed: false, reopened: true });
    expect(statusEvents(SUSPENDED, ACTIVE)).toEqual({ closed: false, reopened: true });
    expect(statusEvents(ACTIVE, SUSPENDED)).toEqual(NO_STATUS_EVENTS);
    expect(statusEvents(CLOSED, SUSPENDED)).toEqual(NO_STATUS_EVENTS);
    expect(statusEvents(null, ACTIVE)).toEqual({ closed: false, reopened: true });
    expect(statusEvents(null, CLOSED)).toEqual({ closed: true, reopened: false });
  });

  it('between two reads: only the branches whose status changed, or that are new', () => {
    const before = new Map([
      ['b1', ACTIVE],
      ['b2', CLOSED],
    ]);
    expect(branchStatusEvents(before, new Map(before))).toEqual(NO_STATUS_EVENTS);
    expect(branchStatusEvents(before, new Map([['b1', CLOSED], ['b2', CLOSED]]))).toEqual({ closed: true, reopened: false });
    expect(branchStatusEvents(before, new Map([['b1', ACTIVE], ['b2', ACTIVE]]))).toEqual({ closed: false, reopened: true });
    expect(branchStatusEvents(before, new Map([...before, ['b3', ACTIVE]]))).toEqual({ closed: false, reopened: true });
    expect(branchStatusEvents(new Map(), new Map([['b1', CLOSED]]))).toEqual({ closed: true, reopened: false });
  });
});

describe('customerStatusFollowing', () => {
  const closed = { closed: true, reopened: false };
  const reopened = { closed: false, reopened: true };

  it('the last open branch closed closes the customer — ACTIVE or SUSPENDED', () => {
    expect(customerStatusFollowing(ACTIVE, [CLOSED], closed)).toBe(CLOSED);
    expect(customerStatusFollowing(ACTIVE, [CLOSED, CLOSED], closed)).toBe(CLOSED);
    expect(customerStatusFollowing(ACTIVE, [CLOSED, SUSPENDED], closed)).toBe(CLOSED);
    expect(customerStatusFollowing(SUSPENDED, [CLOSED], closed)).toBe(CLOSED);
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
      expect(customerStatusFollowing(current, [], { closed: true, reopened: true })).toBe(current);
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
    const moved = await followBranchStatus(txc, ENV, 'c1', { closed: true, reopened: false }, { actorId: 'u1', via: 'approved request e1' });
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
    expect(await followBranchStatus(txc, ENV, 'c1', { closed: false, reopened: true }, { actorId: 'u1', via: 'x' })).toEqual({
      from: CLOSED,
      to: ACTIVE,
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(txc, ENV, expect.objectContaining({ action: 'REACTIVATE', after: { status: ACTIVE } }));
  });

  it('an archived customer is never touched', async () => {
    stored(ACTIVE, [CLOSED], new Date());
    expect(await followBranchStatus(txc, ENV, 'c1', { closed: true, reopened: false }, { actorId: 'u1', via: 'x' })).toBeNull();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('nothing to do writes nothing: no event (nothing read), or the status already right', async () => {
    expect(await followBranchStatus(txc, ENV, 'c1', NO_STATUS_EVENTS, { actorId: 'u1', via: 'x' })).toBeNull();
    expect(tx.customer.findUnique).not.toHaveBeenCalled();
    stored(ACTIVE, [CLOSED, ACTIVE]);
    expect(await followBranchStatus(txc, ENV, 'c1', { closed: true, reopened: false }, { actorId: 'u1', via: 'x' })).toBeNull();
    tx.customer.findUnique.mockResolvedValue(null);
    expect(await followBranchStatus(txc, ENV, 'gone', { closed: true, reopened: false }, { actorId: 'u1', via: 'x' })).toBeNull();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });
});
