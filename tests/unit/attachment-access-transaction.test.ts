// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Role, type Prisma } from '@prisma/client';
import { assertCanAccessAttachment } from '@/lib/access';

const pool = vi.hoisted(() => ({
  branch: { findUnique: vi.fn() },
  customer: { findFirst: vi.fn() },
  customerEdit: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: pool }));

const manager = { id: 'manager', username: 'synthetic-manager', role: Role.MANAGER };
const scope = { ownedRouteId: 'route-a', teamRouteIds: [], managedRegionIds: ['region-a'] };
const photo = { id: 'photo', capturedById: 'uploader', customerId: null, branchId: null, branchExtraId: null, editId: null };
const branch = { routeId: 'route-a', regionId: 'region-a', deletedAt: null };
const draft = (regionId: string) => ({ customerId: null, branchDrafts: [{ routeId: 'route-a', route: { regionId } }] });
const tx = {
  branch: { findUnique: vi.fn() },
  customer: { findFirst: vi.fn() },
  customerEdit: { findUnique: vi.fn() },
};
const reader = tx as unknown as Pick<Prisma.TransactionClient, 'branch' | 'customer' | 'customerEdit'>;

beforeEach(() => {
  for (const group of Object.values(pool)) {
    for (const fn of Object.values(group)) fn.mockReset().mockRejectedValue(new Error('Pooled reader must not be used'));
  }
  tx.branch.findUnique.mockReset().mockResolvedValue({ customerId: 'customer' });
  tx.customer.findFirst.mockReset().mockResolvedValue({ branches: [branch] });
  tx.customerEdit.findUnique.mockReset().mockResolvedValue({ customerId: 'customer', branchDrafts: [] });
});

describe('attachment access uses the supplied transaction without changing scope policy', () => {
  it.each(['customerId', 'branchId', 'branchExtraId', 'editId'] as const)('%s resolves and reads live branches through the transaction', async (key) => {
    const attachment = { ...photo, [key]: key === 'customerId' ? 'customer' : 'owner' };
    await expect(assertCanAccessAttachment(manager, attachment, scope, reader)).resolves.toBeUndefined();
    expect(tx.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'customer', deletedAt: null },
      select: { branches: { select: { routeId: true, regionId: true, deletedAt: true } } },
    });
    if (key === 'branchId' || key === 'branchExtraId') expect(tx.branch.findUnique).toHaveBeenCalled();
    if (key === 'editId') expect(tx.customerEdit.findUnique).toHaveBeenCalled();
    for (const group of Object.values(pool)) for (const fn of Object.values(group)) expect(fn).not.toHaveBeenCalled();
    tx.customer.findFirst.mockResolvedValue({ branches: [{ ...branch, regionId: 'region-b' }] });
    await expect(assertCanAccessAttachment(manager, attachment, scope, reader)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('existing three-argument callers keep the pooled reader', async () => {
    pool.customer.findFirst.mockResolvedValue({ branches: [branch] });
    await expect(assertCanAccessAttachment(manager, { ...photo, customerId: 'customer' }, scope)).resolves.toBeUndefined();
    expect(pool.customer.findFirst).toHaveBeenCalledOnce();
    expect(tx.customer.findFirst).not.toHaveBeenCalled();
  });

  it('a CREATE photo captured by someone else follows the draft routes current regions', async () => {
    tx.customerEdit.findUnique.mockResolvedValue(draft('region-a'));
    await expect(assertCanAccessAttachment(manager, { ...photo, editId: 'draft' }, scope, reader)).resolves.toBeUndefined();
    tx.customerEdit.findUnique.mockResolvedValue(draft('region-b'));
    await expect(assertCanAccessAttachment(manager, { ...photo, editId: 'draft' }, scope, reader)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tx.customer.findFirst).not.toHaveBeenCalled();
    expect(pool.customerEdit.findUnique).not.toHaveBeenCalled();
  });

  it.each([Role.SALESMAN, Role.MANAGER])('%s keeps the existing uploader bypass for an edit-only CREATE photo', async (role) => {
    await expect(assertCanAccessAttachment(
      { ...manager, role }, { ...photo, capturedById: manager.id, editId: 'draft' },
      { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] }, reader
    )).resolves.toBeUndefined();
    expect(tx.customerEdit.findUnique).not.toHaveBeenCalled();
    expect(pool.customerEdit.findUnique).not.toHaveBeenCalled();
  });
});
