// @vitest-environment node
/**
 * Launch fix (P2, a route switched off mid-week): New customer refused on it
 * (services/creates.ts), but a close and a reactivation request went through.
 * Both are refused now, in the same words, before the evidence photo is read
 * or anything is written. A Manager still decides the requests already open on
 * the route: tests/integration/reactivation-authz.test.ts proves that, and these
 * refusals, on Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROUTE_INACTIVE_MESSAGE } from '@/lib/errors';

const db = vi.hoisted(() => ({
  branch: { findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  attachment: { findFirst: vi.fn() },
  customerEdit: { findUnique: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u-sales', role: 'SALESMAN', username: 'mct01' } }),
}));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));
vi.mock('@/lib/notifications', () => ({ notifyUsers: vi.fn(), settleRequestAlerts: vi.fn() }));
vi.mock('@/lib/notify-hierarchy', () => ({ notifySalesmanRequest: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { markBranchClosedAction, requestReactivationAction } from '@/services/reactivations';

const form = () => {
  const f = new FormData();
  f.set('branchId', 'b1');
  f.set('reason', 'The shop is shut for good');
  f.set('attachmentId', 'att-1');
  return f;
};
const routeIs = (isActive: boolean) =>
  db.user.findUniqueOrThrow.mockResolvedValue({
    ownedRouteId: 'r1',
    supervisorId: 'u-sup',
    ownedRoute: { isActive },
  });

beforeEach(() => {
  for (const f of [
    db.branch.findFirst,
    db.user.findUniqueOrThrow,
    db.attachment.findFirst,
    db.customerEdit.findUnique,
    db.customerEdit.findFirst,
    db.$transaction,
  ]) {
    f.mockReset();
  }
  db.attachment.findFirst.mockResolvedValue(null);
});

describe.each([
  ['a close request', markBranchClosedAction, 'ACTIVE'],
  ['a reactivation request', requestReactivationAction, 'CLOSED'],
] as const)('%s', (_name, action, status) => {
  beforeEach(() => {
    db.branch.findFirst.mockResolvedValue({
      id: 'b1',
      routeId: 'r1',
      regionId: 'g1',
      customerId: 'c1',
      status,
      lastStatusChangeAt: null,
      customer: { legalName: 'Al Noor Grocery', nmwcCode: 'NMWC-000001' },
    });
  });

  it('on a switched-off route is refused in the words New customer uses, and nothing is read or written', async () => {
    routeIs(false);
    expect(await action(form())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: ROUTE_INACTIVE_MESSAGE,
    });
    expect(db.attachment.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('on a live route goes on to check the photo, as before', async () => {
    routeIs(true);
    expect(await action(form())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fields: { attachmentId: 'Photo not found.' },
    });
    expect(db.attachment.findFirst).toHaveBeenCalledTimes(1);
  });
});
