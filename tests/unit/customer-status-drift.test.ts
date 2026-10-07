// @vitest-environment node
/**
 * Owner decision 7 (2026-10-07): scripts/ops/customer-status-drift.ts finds the
 * customers whose status already contradicted their shops when the rule shipped
 * (it runs on a change, and never re-reads them), and with --apply moves the
 * unambiguous ones, each under its row lock with its own audit row. The fakes
 * here pin the read and the write; the same functions run on Postgres in
 * tests/integration/customer-status-follows.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { CustomerStatus, type PrismaClient } from '@prisma/client';
import { applyDrift, driftCounts, readDrift } from '../../scripts/ops/customer-status-drift';

const { ACTIVE, CLOSED, SUSPENDED } = CustomerStatus;
type Stored = { id: string; nmwcCode: string; status: CustomerStatus; deletedAt: Date | null; branches: CustomerStatus[] };

function fakeDb(rows: Stored[]) {
  const log: string[] = [];
  const shape = (c: Stored) => ({ ...c, branches: c.branches.map((status) => ({ status })) });
  const tx = {
    $queryRaw: vi.fn(async () => {
      log.push('lock');
      return [];
    }),
    customer: {
      findMany: vi.fn(async () => rows.filter((c) => !c.deletedAt).map(shape)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        log.push('read');
        const c = rows.find((x) => x.id === where.id);
        return c ? shape(c) : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: CustomerStatus } }) => {
        log.push('write');
        rows.find((x) => x.id === where.id)!.status = data.status;
        return {};
      }),
    },
    auditLog: { create: vi.fn(async () => (log.push('audit'), {})) },
  };
  const prisma = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { tx, prisma: prisma as unknown as PrismaClient, log };
}

describe('readDrift', () => {
  it('lists live customers whose status contradicts their live shops, and what each needs', async () => {
    const { prisma } = fakeDb([
      { id: 'c1', nmwcCode: 'N1', status: ACTIVE, deletedAt: null, branches: [CLOSED, CLOSED] },
      { id: 'c2', nmwcCode: 'N2', status: CLOSED, deletedAt: null, branches: [ACTIVE, CLOSED] },
      { id: 'c3', nmwcCode: 'N3', status: ACTIVE, deletedAt: null, branches: [SUSPENDED, CLOSED] },
      { id: 'c4', nmwcCode: 'N4', status: SUSPENDED, deletedAt: null, branches: [ACTIVE] },
      { id: 'c5', nmwcCode: 'N5', status: ACTIVE, deletedAt: null, branches: [ACTIVE, CLOSED] },
      { id: 'c6', nmwcCode: 'N6', status: ACTIVE, deletedAt: new Date(), branches: [CLOSED] },
      { id: 'c7', nmwcCode: 'N7', status: ACTIVE, deletedAt: null, branches: [] },
    ]);
    const rows = await readDrift(prisma);
    expect(rows.map((r) => [r.nmwcCode, r.drift])).toEqual([
      ['N1', { kind: 'close', to: CLOSED }],
      ['N2', { kind: 'reopen', to: ACTIVE }],
      ['N3', { kind: 'review' }],
    ]);
    expect(driftCounts(rows)).toEqual({ close: 1, reopen: 1, review: 1 });
  });
});

describe('applyDrift', () => {
  it('locks, re-reads, writes the status and one CLOSE row on the customer, in that order', async () => {
    const { prisma, tx, log } = fakeDb([{ id: 'c1', nmwcCode: 'N1', status: ACTIVE, deletedAt: null, branches: [CLOSED] }]);
    expect(await applyDrift(prisma, 'c1', 'stew', 'db.example')).toEqual({ from: ACTIVE, to: CLOSED });
    expect(log).toEqual(['lock', 'read', 'write', 'audit']);
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: CLOSED, lastEditedById: 'stew', version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'stew',
        action: 'CLOSE',
        entityType: 'Customer',
        entityId: 'c1',
        before: { status: ACTIVE },
        after: { status: CLOSED },
      }),
    });
  });

  it('a reopening is a REACTIVATE row', async () => {
    const { prisma, tx } = fakeDb([{ id: 'c2', nmwcCode: 'N2', status: CLOSED, deletedAt: null, branches: [ACTIVE] }]);
    expect(await applyDrift(prisma, 'c2', 'stew', 'db.example')).toEqual({ from: CLOSED, to: ACTIVE });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'REACTIVATE' }) });
  });

  it('writes nothing for a customer that changed since the scan, was archived, or is for a person to review', async () => {
    for (const c of [
      { id: 'x', nmwcCode: 'X', status: ACTIVE, deletedAt: null, branches: [ACTIVE, CLOSED] },
      { id: 'x', nmwcCode: 'X', status: ACTIVE, deletedAt: new Date(), branches: [CLOSED] },
      { id: 'x', nmwcCode: 'X', status: ACTIVE, deletedAt: null, branches: [SUSPENDED, CLOSED] },
    ]) {
      const { prisma, tx } = fakeDb([c]);
      expect(await applyDrift(prisma, 'x', 'stew', 'db.example')).toBeNull();
      expect(tx.customer.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    }
    const { prisma } = fakeDb([]);
    expect(await applyDrift(prisma, 'gone', 'stew', 'db.example')).toBeNull();
  });
});
