// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — what a close-shop and a reactivation
 * SUBMIT write about the salesman's reason (services/reactivations.ts), with the
 * database mocked and the real services.
 *
 * His reason used to be written to CustomerEdit.decisionReason, the column every
 * decision also wrote: a merge's auto-close replaced it, and (before 2026-10-07)
 * so did a refusal. It now goes to requestReason — a column no decision writes
 * and the database freezes once the request is sent — and the request's sealed
 * CREATE audit row is read from that column.
 *
 * The copy still written to decisionReason is the rollback bridge
 * (REQUEST_REASON_LEGACY_COPY): the build before this one reads the reason there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REQUEST_REASON_LEGACY_COPY } from '@/lib/request-reasons';

const SALES = 'u-sales';
const REASON = 'The owner has left the country';

const db = vi.hoisted(() => ({
  branch: { findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  attachment: { findFirst: vi.fn() },
  customerEdit: { findUnique: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(async () => 1),
  $queryRaw: vi.fn(async () => []),
  customer: { findUnique: vi.fn() },
  attachment: { updateMany: vi.fn() },
  customerEdit: { create: vi.fn() },
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u-sales', role: 'SALESMAN', username: 'mct01' } }),
}));
vi.mock('@/lib/audit', () => audit);
vi.mock('@/lib/notifications', () => ({ notifyUsers: vi.fn(), settleRequestAlerts: vi.fn() }));
vi.mock('@/lib/notify-hierarchy', () => ({ notifySalesmanRequest: vi.fn(async () => ({ mustAct: [], fyi: [] })) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { markBranchClosedAction, requestReactivationAction } from '@/services/reactivations';

const form = (reason: string) => {
  const f = new FormData();
  f.set('branchId', 'b1');
  f.set('reason', reason);
  f.set('attachmentId', 'att-1');
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  db.customerEdit.findUnique.mockResolvedValue(null); // no receipt: a first submit
  db.user.findUniqueOrThrow.mockResolvedValue({
    ownedRouteId: 'r1',
    supervisorId: 'u-sup',
    ownedRoute: { isActive: true, regionId: 'g1' },
  });
  // A fresh photo of his own, on no slot yet: wired to the branch with the request.
  db.attachment.findFirst.mockResolvedValue({
    id: 'att-1',
    kind: 'FREE',
    capturedById: SALES,
    capturedAt: new Date(Date.now() - 60_000),
    customerId: null,
    branchId: null,
    branchExtraId: null,
    editId: null,
    deletedAt: null,
  });
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  tx.customer.findUnique.mockResolvedValue({ deletedAt: null });
  tx.attachment.updateMany.mockResolvedValue({ count: 1 });
  // The row comes back as the database would return it: what was written, plus its defaults.
  tx.customerEdit.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'e-new',
    process: 'UPDATE',
    cycle: 1,
    submitGate: null,
    isReactivation: false,
    decisionReason: null,
    requestReason: null,
    ...args.data,
  }));
  audit.writeAudit.mockResolvedValue(undefined);
  audit.getAuditEnvelope.mockResolvedValue({ actorId: SALES, ip: null, userAgent: null });
});

describe.each([
  ['a close-shop request', markBranchClosedAction, 'ACTIVE', false, 'close-shop requested'],
  ['a reactivation request', requestReactivationAction, 'CLOSED', true, 'reactivation requested'],
] as const)('%s', (_name, action, status, isReactivation, auditReason) => {
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

  const created = () => {
    expect(tx.customerEdit.create).toHaveBeenCalledTimes(1);
    return tx.customerEdit.create.mock.calls[0]![0].data as Record<string, unknown>;
  };

  it('writes the salesman’s reason to requestReason, trimmed, with the request', async () => {
    const res = await action(form(`  ${REASON}  `));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { editId: 'e-new', state: 'SUBMITTED' } });
    const data = created();
    expect(data.requestReason).toBe(REASON);
    expect(data).toMatchObject({ target: 'BRANCH', state: 'SUBMITTED', branchId: 'b1', submittedById: SALES });
    expect(Boolean(data.isReactivation)).toBe(isReactivation);
  });

  it('the rollback bridge: the same text is still copied to decisionReason, and nowhere else', async () => {
    expect(REQUEST_REASON_LEGACY_COPY).toBe(true);
    await action(form(REASON));
    const data = created();
    expect(data.decisionReason).toBe(REASON);
    // The reason is in exactly these two columns of the request.
    const holders = Object.entries(data)
      .filter(([, v]) => JSON.stringify(v ?? null).includes(REASON))
      .map(([k]) => k)
      .sort();
    expect(holders).toEqual(['decisionReason', 'requestReason']);
    // Not a decision: no category, no reviewer.
    expect(data).not.toHaveProperty('decisionCategory');
    expect(data).not.toHaveProperty('reviewedById');
  });

  it('the sealed CREATE audit row carries it as requestReason — read from his own column', async () => {
    // A row whose decisionReason held something else would still seal HIS reason.
    tx.customerEdit.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'e-new',
      process: 'UPDATE',
      cycle: 1,
      submitGate: null,
      isReactivation: false,
      ...args.data,
      decisionReason: 'not the request’s reason',
    }));
    await action(form(REASON));
    const row = audit.writeAudit.mock.calls
      .map((c) => c[2] as { action: string; entityType: string; reason?: string; after: Record<string, unknown> })
      .find((r) => r.action === 'CREATE' && r.entityType === 'CustomerEdit')!;
    expect(row.reason).toBe(auditReason);
    expect(row.after.requestReason).toBe(REASON);
    expect(row.after).not.toHaveProperty('decisionReason');
  });

  it('a reason under five characters is refused before anything is read or written', async () => {
    expect(await action(form(' no '))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', fields: { reason: 'Tell us why (5+ chars).' } });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.customerEdit.create).not.toHaveBeenCalled();
  });
});
