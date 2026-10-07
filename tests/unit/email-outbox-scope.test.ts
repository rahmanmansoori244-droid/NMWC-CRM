// @vitest-environment node
/**
 * Owner decision 3 (2026-10-07): the e-mail drain asks "can he decide it?" with
 * the decision's own rule (lib/email/eligibility.ts waitsOn → canActOnStep), so
 * the request's scope regions it reads (lib/email/outbox-store.ts loadRequests)
 * must be the decision's too: the regions of the branches the request is about
 * (lib/permissions.ts requestScopeBranches), not every region of the customer.
 * With the customer's every region, a Manager of the changed branch's region
 * would no longer be e-mailed (he does not manage the other region), and the
 * other region's Manager could not decide what he was asked to.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { prismaOutboxStore } from '@/lib/email/outbox-store';

const b = (id: string, regionId: string, routeId: string) => ({ id, regionId, routeId, deletedAt: null });
const row = (over: Record<string, unknown>) => ({
  id: 'e1',
  state: 'SUBMITTED',
  process: 'UPDATE',
  target: 'CUSTOMER',
  isReactivation: false,
  approvalChain: null,
  currentStepIndex: 0,
  pendingRole: 'SUPERVISOR',
  cycle: 1,
  submittedById: 's1',
  submittedBy: { supervisorId: 'm1', ownedRouteId: 't1' },
  branchId: null,
  branch: null,
  fieldChanges: [],
  submitGate: { v: 1, branchIds: ['b1'] },
  customer: { deletedAt: null, branches: [b('b1', 'g1', 't1'), b('b2', 'g2', 't2')] },
  branchDrafts: [],
  ...over,
});
const store = (rows: unknown[]) =>
  prismaOutboxStore({
    customerEdit: { findMany: vi.fn(async () => rows) },
    editApproval: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient);

describe('loadRequests: an update’s scope regions are its own branches’', () => {
  it('a change to the g1 branch of a g1+g2 customer: g1 only', async () => {
    const [r] = await store([row({ fieldChanges: [{ field: 'branch.b1.openingHours', before: null, after: '8-20' }] })]).loadRequests(['e1']);
    expect(r!.scopeRegionIds).toEqual(['g1']);
  });

  it('a change to the g2 branch: g2 only; a customer-level change: its home’s region', async () => {
    const [onB2] = await store([
      row({ fieldChanges: [{ field: 'branch.b2.openingHours', before: null, after: '8-20' }], submitGate: { v: 1, branchIds: ['b2'] } }),
    ]).loadRequests(['e1']);
    expect(onB2!.scopeRegionIds).toEqual(['g2']);
    const [notes] = await store([row({ fieldChanges: [{ field: 'customer.notes', before: null, after: 'x' }] })]).loadRequests(['e1']);
    expect(notes!.scopeRegionIds).toEqual(['g1']);
  });

  it('a reactivation and a new customer are read as before', async () => {
    const [react] = await store([row({ isReactivation: true, branch: { regionId: 'g2' } })]).loadRequests(['e1']);
    expect(react!.scopeRegionIds).toEqual(['g2']);
    const [create] = await store([
      row({ process: 'CREATE', customer: null, branchDrafts: [{ route: { regionId: 'g1' } }] }),
    ]).loadRequests(['e1']);
    expect(create!.scopeRegionIds).toEqual(['g1']);
  });
});
