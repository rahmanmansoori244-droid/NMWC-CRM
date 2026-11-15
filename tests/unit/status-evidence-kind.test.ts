// @vitest-environment node
/**
 * Follow-up 1, H7 (bug hunt round 2, F5): the photo a close or reopen request
 * takes as evidence is re-filed as a FREE photo of the shop. A hand-made request
 * naming an unattached CR copy, ID card, guarantee or credit document of the
 * salesman's own would have turned it into an ordinary "Other photo" on a live
 * shop, without its confidential handling. Only a picture of a shop (FREE, SHOP,
 * SIGNBOARD) is taken now, as the FREE slot's attach already insists
 * (services/photos.ts); anything else is refused before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PHOTO_OTHER_SLOT_MESSAGE } from '@/lib/photo-attach';

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
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn(async () => ({})) }));
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
/** His own upload, taken a minute ago, on no slot and claimed by no request. */
const upload = (kind: string) => ({
  id: 'att-1',
  kind,
  capturedById: 'u-sales',
  capturedAt: new Date(Date.now() - 60_000),
  deletedAt: null,
  customerId: null,
  branchId: null,
  branchExtraId: null,
  editId: null,
});

beforeEach(() => {
  for (const f of [db.branch.findFirst, db.user.findUniqueOrThrow, db.attachment.findFirst, db.$transaction]) {
    f.mockReset();
  }
  db.user.findUniqueOrThrow.mockResolvedValue({
    ownedRouteId: 'r1',
    supervisorId: 'u-sup',
    ownedRoute: { isActive: true },
  });
  // Past the photo checks the request opens its transaction: stopped there.
  db.$transaction.mockRejectedValue(new Error('reached the transaction'));
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

  it.each(['CR', 'GUARANTEE', 'ID_CARD', 'MEMBERSHIP_CERT', 'VAT_CERT', 'TAX_CARD', 'CREDIT_FORM'])(
    'refuses an unattached %s document as evidence, and writes nothing',
    async (kind) => {
      db.attachment.findFirst.mockResolvedValue(upload(kind));
      expect(await action(form())).toMatchObject({
        ok: false,
        code: 'VALIDATION_FAILED',
        fields: { attachmentId: PHOTO_OTHER_SLOT_MESSAGE },
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(['FREE', 'SHOP', 'SIGNBOARD'])('takes an unattached %s photo, as before', async (kind) => {
    db.attachment.findFirst.mockResolvedValue(upload(kind));
    await action(form()).catch(() => undefined);
    expect(db.$transaction).toHaveBeenCalled();
  });
});
