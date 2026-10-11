// @vitest-environment node
/**
 * Owner decisions 2026-10-11: a credit request waiting at the salesman's own
 * signed-application step can be withdrawn by him (the customer may refuse to
 * sign). Any other request in review still cannot (services/creates.ts
 * withdrawCreateCore). The claim pins the step, so a signed form confirmed first
 * wins; and nothing waits on anyone after: the print rows and his own alerts are
 * settled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditProcess, PaymentTerms } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';

const h = vi.hoisted(() => ({
  edit: null as Record<string, unknown> | null,
  claimCount: 1,
  calls: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/session', () => ({
  requireActor: async () => ({ id: 'sal1', role: 'SALESMAN', username: 'mct-01' }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }), FORM_LIMIT: {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async () => ({}),
  writeAudit: async (_tx: unknown, _env: unknown, row: unknown) => {
    h.calls.push(['writeAudit', row]);
  },
}));
vi.mock('@/lib/notifications', () => ({
  resolveStepAudience: async () => [],
  notifyUsers: async () => {},
  settleRequestAlerts: async (_tx: unknown, arg: unknown) => {
    h.calls.push(['settle', arg]);
    return 1;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const tx = {
  customerEdit: {
    updateMany: async (args: unknown) => {
      h.calls.push(['claim', args]);
      return { count: h.claimCount };
    },
  },
  notification: {
    updateMany: async (args: unknown) => {
      h.calls.push(['ownAlertsRead', args]);
      return { count: 1 };
    },
  },
};
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findUnique: async () => h.edit },
    $transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
  },
}));

import { withdrawCreateAction } from '@/services/creates';

const CREDIT = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  process: 'CREATE',
  state: 'SUBMITTED',
  submittedById: 'sal1',
  cycle: 1,
  approvalChain: CREDIT,
  currentStepIndex: 2,
  ...over,
});
const called = (name: string) => h.calls.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  h.edit = row();
  h.claimCount = 1;
  h.calls = [];
});

describe('withdraw at the signed-application step', () => {
  it('closes it for good, claimed on its step, and settles every alert about it', async () => {
    expect(await withdrawCreateAction({ editId: 'e1' })).toEqual({ ok: true, data: { editId: 'e1' } });
    const [claim] = called('claim') as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
    expect(claim!.where).toEqual({ id: 'e1', state: 'SUBMITTED', cycle: 1, submittedById: 'sal1', currentStepIndex: 2 });
    expect(claim!.data).toMatchObject({ state: 'REJECTED', pendingRole: null, slaDueAt: null, decisionCategory: 'withdrawn' });
    expect(called('writeAudit')).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        reason: 'withdrawn by the salesman',
        after: { process: 'CREATE', state: 'REJECTED', from: 'SUBMITTED', cycle: 1, atStep: 2 },
      }),
    ]);
    expect(called('settle')).toEqual([{ editId: 'e1', submittedById: 'sal1' }]);
    expect(called('ownAlertsRead')).toEqual([
      {
        where: { editId: 'e1', userId: 'sal1', readAt: null, kind: { in: ['SIGNED_FORM_REQUESTED', 'SLA_BREACH'] } },
        data: { readAt: expect.any(Date) },
      },
    ]);
  });

  it('a signed form confirmed first wins: the claim misses and nothing is written', async () => {
    h.claimCount = 0;
    expect(await withdrawCreateAction({ editId: 'e1' })).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
    expect(called('writeAudit')).toEqual([]);
  });

  it('in review at any other step: still refused, as before', async () => {
    for (const currentStepIndex of [0, 1, 3, 4, 5]) {
      h.edit = row({ currentStepIndex });
      expect(await withdrawCreateAction({ editId: 'e1' }), String(currentStepIndex)).toMatchObject({
        ok: false,
        code: 'EDIT_LOCKED',
      });
    }
    // A cash request in review, and a credit request frozen before the change, have no such step.
    h.edit = row({ approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CASH), currentStepIndex: 1 });
    expect(await withdrawCreateAction({ editId: 'e1' })).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
    expect(called('claim')).toEqual([]);
  });

  it('a draft or a sent-back request is withdrawn as before, without the step pin or the alert sweep', async () => {
    h.edit = row({ state: 'NEEDS_CORRECTION', currentStepIndex: 0 });
    expect((await withdrawCreateAction({ editId: 'e1' })).ok).toBe(true);
    const [claim] = called('claim') as Array<{ where: Record<string, unknown> }>;
    expect(claim!.where).toEqual({ id: 'e1', state: 'NEEDS_CORRECTION', cycle: 1, submittedById: 'sal1' });
    expect(called('settle')).toEqual([]);
    expect(called('ownAlertsRead')).toEqual([]);
  });

  it('someone else’s request reads as not found', async () => {
    h.edit = row({ submittedById: 'sal2' });
    expect(await withdrawCreateAction({ editId: 'e1' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
