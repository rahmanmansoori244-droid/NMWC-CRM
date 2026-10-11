// @vitest-environment node
/**
 * Owner decisions 2026-10-11 — the salesman's signed-application step
 * (services/signed-form.ts), with the database mocked:
 *   - only the submitting salesman, only his own new-customer request, only while
 *     it waits at the signed-application step, only on the route it was started
 *     on, only on the view his page showed (the decision token);
 *   - every page is his own capture, taken as a signed-application page, on no
 *     record and no other request;
 *   - the claim is the token; the pages are claimed and an earlier upload's
 *     dropped pages released; the completion is a FORM_UPLOADED decision row and
 *     an UPDATE audit row (never STEP_APPROVE); his alerts and the print rows are
 *     settled; the Finance Manager is told;
 *   - a retry of a confirm that landed is answered as landed, never refused.
 * The same against Postgres: tests/integration/signed-form-step.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditProcess, PaymentTerms, Prisma } from '@prisma/client';
import { resolveChain, stepDeadline } from '@/lib/approval-chains';
import { decisionTokenFor, MISSING_TOKEN_MESSAGE, STALE_VIEW_MESSAGE } from '@/lib/decision-token';
import { MAX_SIGNED_FORM_PAGES } from '@/lib/credit-documents';
import { ROUTE_INACTIVE_MESSAGE } from '@/lib/errors';

const h = vi.hoisted(() => ({
  user: { id: 'sal1', role: 'SALESMAN', username: 'mct-01' } as { id: string; role: string; username: string },
  edit: null as Record<string, unknown> | null,
  me: { ownedRoute: { id: 'rt1', code: 'MCT-01', isActive: true } } as { ownedRoute: { id: string; code: string; isActive: boolean } | null },
  pages: [] as Array<Record<string, unknown>>,
  /** Live decision-bound attachment ids of the request, as the FOR SHARE read returns them. */
  bound: [] as string[],
  claimCount: 1,
  pageClaimCount: null as number | null,
  landedRow: null as { id: string } | null,
  calls: [] as Array<[string, unknown]>,
  rolledBack: false,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async () => ({ ok: true, retryAfterSec: 0 }),
  FORM_LIMIT: { capacity: 60, refillPerSec: 1 },
}));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async (_tx: unknown, _env: unknown, row: unknown) => {
    h.calls.push(['writeAudit', row]);
  },
}));
vi.mock('@/lib/notifications', () => ({
  resolveStepAudience: async (_tx: unknown, step: { role: string }) => {
    h.calls.push(['resolveStepAudience', step.role]);
    return ['fm1'];
  },
  notifyUsers: async (_tx: unknown, ids: string[], data: unknown) => {
    h.calls.push(['notifyUsers', { ids, data }]);
  },
  settleRequestAlerts: async (_tx: unknown, arg: unknown) => {
    h.calls.push(['settleRequestAlerts', arg]);
    return 0;
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const tx = {
  customerEdit: {
    updateMany: async (args: unknown) => {
      h.calls.push(['claim', args]);
      return { count: h.claimCount };
    },
  },
  attachment: {
    updateMany: async (args: { data: Record<string, unknown> }) => {
      h.calls.push([args.data.editId ? 'claimPages' : 'releasePages', args]);
      return { count: args.data.editId ? (h.pageClaimCount ?? h.pages.length) : 1 };
    },
  },
  editApproval: {
    create: async (args: unknown) => {
      h.calls.push(['decisionRow', args]);
      return {};
    },
  },
  notification: {
    updateMany: async (args: unknown) => {
      h.calls.push(['ownAlertsRead', args]);
      return { count: 1 };
    },
  },
  $queryRaw: async () => h.bound.map((id) => ({ id })),
};
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findUnique: async () => h.edit },
    user: { findUniqueOrThrow: async () => h.me },
    attachment: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        h.pages.filter((p) => where.id.in.includes(p.id as string)),
      count: async () => h.pages.length,
    },
    editApproval: { findFirst: async () => h.landedRow },
    $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
      try {
        return await cb(tx);
      } catch (err) {
        h.rolledBack = true;
        throw err;
      }
    },
  },
}));

import { submitSignedFormAction } from '@/services/signed-form';

const CHAIN = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
const STAGE = new Date('2026-10-11T06:00:00.123Z');
const P1 = 'ckpage00000000000000000001';
const P2 = 'ckpage00000000000000000002';
const KEPT = 'ckpage00000000000000000009';
const EDIT = 'ckedit00000000000000000001';

function row(over: Record<string, unknown> = {}) {
  return {
    id: EDIT,
    process: 'CREATE',
    state: 'SUBMITTED',
    submittedById: 'sal1',
    approvalChain: CHAIN,
    currentStepIndex: 2,
    cycle: 1,
    stageEnteredAt: STAGE,
    slaDueAt: new Date(STAGE.getTime() + 3 * 24 * 3600_000),
    submittedAt: new Date('2026-10-10T06:00:00.000Z'),
    requestedCreditLimit: new Prisma.Decimal('500'),
    requestedPaymentTermDays: 30,
    customerDraft: { legalName: 'Al Noor Trading' },
    branchDrafts: [{ routeId: 'rt1', route: { code: 'MCT-01', regionId: 'g1' } }],
    submittedBy: { supervisorId: 'mgr1' },
    ...over,
  };
}
const page = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'CREDIT_FORM',
  deletedAt: null,
  capturedById: 'sal1',
  customerId: null,
  branchId: null,
  branchExtraId: null,
  editId: null,
  ...over,
});
const tokenOf = (r = row(), bound = h.bound) => decisionTokenFor(r as never, bound);
const send = (attachmentIds: string[], decisionToken: string | undefined = tokenOf()) =>
  submitSignedFormAction({ editId: EDIT, attachmentIds, decisionToken });
const called = (name: string) => h.calls.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  h.user = { id: 'sal1', role: 'SALESMAN', username: 'mct-01' };
  h.edit = row();
  h.me = { ownedRoute: { id: 'rt1', code: 'MCT-01', isActive: true } };
  h.pages = [page(P1), page(P2)];
  h.bound = ['doc-id', 'doc-mem', 'doc-vat', 'doc-tax'];
  h.claimCount = 1;
  h.pageClaimCount = null;
  h.landedRow = null;
  h.calls = [];
  h.rolledBack = false;
});

describe('who and when', () => {
  it('only a salesman', async () => {
    for (const role of ['SUPERVISOR', 'MANAGER', 'SALES_DIRECTOR', 'FINANCE_MANAGER', 'GM', 'ACCOUNTANT', 'STEWARD', 'VIEWER']) {
      h.user = { id: 'x', role, username: 'x' };
      expect(await send([P1]), role).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    expect(h.calls).toEqual([]);
  });

  it('only the salesman who sent it, only a new-customer request: anyone else reads not found', async () => {
    h.edit = row({ submittedById: 'sal2' });
    expect(await send([P1])).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    h.edit = row({ process: 'UPDATE' });
    expect(await send([P1])).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    h.edit = null;
    expect(await send([P1])).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.calls).toEqual([]);
  });

  it('only at the signed-application step: before it, after it, or on a cash or legacy chain, NOT_PENDING', async () => {
    for (const over of [
      { currentStepIndex: 1 },
      { currentStepIndex: 3 },
      { state: 'NEEDS_CORRECTION' },
      { state: 'APPROVED' },
      { approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CASH), currentStepIndex: 1 },
    ]) {
      h.edit = row(over);
      expect(await send([P1], tokenOf(row(over))), JSON.stringify(over)).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    }
    expect(called('claim')).toEqual([]);
  });

  it('not from a route he has left, and not while his route is off', async () => {
    h.edit = row({ branchDrafts: [{ routeId: 'rt9', route: { code: 'MCT-09', regionId: 'g1' } }] });
    const moved = await send([P1]);
    expect(moved).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
    expect(!moved.ok && moved.message).toMatch(/started on route MCT-09, and you now work route MCT-01/);
    h.edit = row();
    h.me = { ownedRoute: { id: 'rt1', code: 'MCT-01', isActive: false } };
    expect(await send([P1])).toMatchObject({ ok: false, code: 'FORBIDDEN', message: ROUTE_INACTIVE_MESSAGE });
    expect(called('claim')).toEqual([]);
  });
});

describe('the view his page showed (N01)', () => {
  it('no token: reload', async () => {
    expect(await submitSignedFormAction({ editId: EDIT, attachmentIds: [P1] })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: MISSING_TOKEN_MESSAGE,
    });
    expect(await send([P1], 'not a token')).toMatchObject({ ok: false, message: MISSING_TOKEN_MESSAGE });
    expect(called('claim')).toEqual([]);
  });

  it('a page opened before a send-back, or before a document was removed, decides nothing', async () => {
    // Another visit to the step: a Finance Manager send-back since.
    const earlier = tokenOf(row({ stageEnteredAt: new Date(STAGE.getTime() - 86_400_000) }));
    expect(await send([P1], earlier)).toEqual({ ok: false, code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE });
    expect(called('claim')).toEqual([]);
    // A credit document removed by a Manager while his page was open: refused
    // inside the transaction, after the claim — which rolls back.
    const shown = tokenOf();
    h.bound = ['doc-id', 'doc-mem', 'doc-vat'];
    expect(await send([P1], shown)).toEqual({ ok: false, code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE });
    expect(h.rolledBack).toBe(true);
    expect(called('decisionRow')).toEqual([]);
    expect(called('writeAudit')).toEqual([]);
  });
});

describe('the pages', () => {
  it('at least one, at most the limit, no page twice', async () => {
    expect(await send([])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', fields: { signedForm: expect.stringMatching(/Add a photo/) } });
    const many = Array.from({ length: MAX_SIGNED_FORM_PAGES + 1 }, (_, i) => `ckpage0000000000000000001${i}`);
    expect(await send(many)).toMatchObject({ ok: false, fields: { signedForm: `At most ${MAX_SIGNED_FORM_PAGES} pages.` } });
    expect(await send([P1, P1])).toMatchObject({ ok: false, fields: { signedForm: expect.stringMatching(/twice/) } });
    expect(called('claim')).toEqual([]);
  });

  it('each his own capture, a signed-application page, live, on no record and no other request', async () => {
    const cases: Array<[Record<string, unknown>, RegExp | string]> = [
      [{ capturedById: 'sal2' }, 'FORBIDDEN'],
      [{ kind: 'SHOP' }, /taken for another slot/],
      [{ kind: 'ID_CARD' }, /taken for another slot/],
      [{ deletedAt: new Date() }, /was removed/],
      [{ customerId: 'c1' }, /already on another record/],
      [{ editId: 'ckedit00000000000000000099' }, /already on another record/],
    ];
    for (const [over, expected] of cases) {
      h.pages = [page(P1, over)];
      const res = await send([P1]);
      expect(res.ok, JSON.stringify(over)).toBe(false);
      if (typeof expected === 'string') expect(res).toMatchObject({ code: expected });
      else expect(!res.ok && res.fields?.signedForm, JSON.stringify(over)).toMatch(expected);
    }
    h.pages = [];
    expect(await send([P1])).toMatchObject({ ok: false, fields: { signedForm: expect.stringMatching(/was removed/) } });
    expect(called('claim')).toEqual([]);
  });

  it('a page this request already holds (kept after a send-back) is accepted', async () => {
    h.pages = [page(KEPT, { editId: EDIT }), page(P1)];
    h.bound = [...h.bound, KEPT];
    expect((await send([KEPT, P1])).ok).toBe(true);
  });

  it('a page taken elsewhere between the check and the claim: refused, and everything rolls back', async () => {
    h.pageClaimCount = 1;
    expect(await send([P1, P2])).toMatchObject({ ok: false, code: 'PHOTO_CONFLICT' });
    expect(h.rolledBack).toBe(true);
    expect(called('decisionRow')).toEqual([]);
  });
});

describe('a confirm that lands', () => {
  it('moves the request to the Finance Manager on the claim his token makes, and records what he did', async () => {
    const before = Date.now();
    const res = await send([P1, P2]);
    expect(res).toEqual({ ok: true, data: { editId: EDIT, pages: 2, replayed: false } });

    const [claim] = called('claim') as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
    expect(claim!.where).toEqual({
      id: EDIT,
      submittedById: 'sal1',
      state: 'SUBMITTED',
      currentStepIndex: 2,
      cycle: 1,
      stageEnteredAt: STAGE,
      requestedCreditLimit: '500.000',
      requestedPaymentTermDays: 30,
    });
    const enteredAt = claim!.data.stageEnteredAt as Date;
    expect(enteredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(claim!.data).toEqual({
      currentStepIndex: 3,
      pendingRole: 'FINANCE_MANAGER',
      stageEnteredAt: enteredAt,
      slaDueAt: stepDeadline(enteredAt, CHAIN[3]!.slaHours),
      escalationLevel: 0,
      slaBreachedAt: null,
      lastEscalatedAt: null,
    });

    // His pages claimed by this request; the pages of an earlier upload he dropped, released.
    const [claimPages] = called('claimPages') as Array<{ where: Record<string, unknown>; data: unknown }>;
    expect(claimPages!.where).toMatchObject({
      id: { in: [P1, P2] },
      deletedAt: null,
      customerId: null,
      branchId: null,
      branchExtraId: null,
      capturedById: 'sal1',
      kind: 'CREDIT_FORM',
      OR: [{ editId: null }, { editId: EDIT }],
    });
    expect(claimPages!.data).toEqual({ editId: EDIT });
    const [release] = called('releasePages') as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
    expect(release!.where).toEqual({ editId: EDIT, kind: 'CREDIT_FORM', deletedAt: null, id: { notIn: [P1, P2] } });
    expect(release!.data).toMatchObject({ hash: null });

    // A FORM_UPLOADED decision row with the stage as it was; an UPDATE audit row — never a self-approval.
    const [decision] = called('decisionRow') as Array<{ data: Record<string, unknown> }>;
    expect(decision!.data).toMatchObject({
      editId: EDIT,
      cycle: 1,
      stepIndex: 2,
      role: 'SALESMAN',
      decision: 'FORM_UPLOADED',
      actorId: 'sal1',
      stageEnteredAt: STAGE,
    });
    expect(called('writeAudit')).toEqual([
      {
        action: 'UPDATE',
        entityType: 'CustomerEdit',
        entityId: EDIT,
        reason: 'signed credit application uploaded by the salesman',
        after: { stepIndex: 2, cycle: 1, pages: 2, attachmentIds: [P1, P2] },
      },
    ]);
    expect(JSON.stringify(h.calls)).not.toContain('STEP_APPROVE');

    // The rows that asked for it are settled — his own alerts too — then the FM is told.
    expect(called('settleRequestAlerts')).toEqual([{ editId: EDIT, submittedById: 'sal1' }]);
    expect(called('ownAlertsRead')).toEqual([
      {
        where: { editId: EDIT, userId: 'sal1', readAt: null, kind: { in: ['SIGNED_FORM_REQUESTED', 'SLA_BREACH'] } },
        data: { readAt: expect.any(Date) },
      },
    ]);
    expect(called('resolveStepAudience')).toEqual(['FINANCE_MANAGER']);
    expect(called('notifyUsers')).toEqual([
      {
        ids: ['fm1'],
        data: {
          kind: 'EDIT_STAGE_ADVANCED',
          title: 'Approval waiting on you',
          body: 'Al Noor Trading — signed credit application uploaded; request advanced to the Finance Manager step.',
          editId: EDIT,
        },
      },
    ]);
    const order = h.calls.map(([n]) => n);
    expect(order.indexOf('claim')).toBeLessThan(order.indexOf('claimPages'));
    expect(order.indexOf('settleRequestAlerts')).toBeLessThan(order.indexOf('notifyUsers'));
  });

  it('a retry whose first try landed is answered as landed — whether the claim missed or the request moved on', async () => {
    const token = tokenOf();
    h.claimCount = 0;
    h.landedRow = { id: 'ea1' };
    expect(await send([P1, P2], token)).toEqual({ ok: true, data: { editId: EDIT, pages: 2, replayed: true } });
    h.claimCount = 1;
    h.edit = row({ currentStepIndex: 3, pendingRole: 'FINANCE_MANAGER', stageEnteredAt: new Date() });
    expect(await send([P1, P2], token)).toEqual({ ok: true, data: { editId: EDIT, pages: 2, replayed: true } });
    // Without its row, the same misses are refusals.
    h.landedRow = null;
    expect(await send([P1, P2], token)).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    h.edit = row();
    h.claimCount = 0;
    expect(await send([P1, P2], token)).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });
});

describe('structure', () => {
  it('reached through the field-form route, as the other field forms are', async () => {
    const { readFileSync } = await import('node:fs');
    const route = readFileSync('app/api/forms/[form]/route.ts', 'utf8');
    expect(route).toMatch(/'credit-form': \(body\) => submitSignedFormAction\(/);
    const client = readFileSync('lib/submit-client.ts', 'utf8');
    expect(client).toMatch(/\| 'credit-form'/);
    const form = readFileSync('app/(app)/customers/new/SignedFormUpload.tsx', 'utf8');
    expect(form).toMatch(/postForm<[^>]+>\('credit-form'/);
    expect(form).not.toMatch(/from '@\/services\//);
  });
});

describe('the salesman’s alert (owner decisions 2026-10-11)', () => {
  it('is red in his bell, is never e-mailed, and is not settled by an approver’s decision — his upload settles it', async () => {
    const policy = await import('@/lib/notify-policy');
    expect(policy.bellInformationKinds('SALESMAN')).not.toContain('SIGNED_FORM_REQUESTED');
    expect(policy.bellInformationKinds('SALESMAN')).not.toContain('SLA_BREACH');
    expect(policy.EMAIL_KINDS).not.toContain('SIGNED_FORM_REQUESTED');
    // settleRequestAlerts never marks the submitter's own rows; the upload and the
    // withdraw mark his SIGNED_FORM_REQUESTED and SLA_BREACH rows read themselves.
    expect(policy.SETTLED_ON_DECISION_KINDS).not.toContain('SIGNED_FORM_REQUESTED');
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('../support/strip-comments');
    for (const file of ['services/signed-form.ts', 'services/creates.ts']) {
      const src = stripComments(readFileSync(file, 'utf8'), file);
      expect(src, file).toMatch(/kind: \{ in: \['SIGNED_FORM_REQUESTED', 'SLA_BREACH'\] \}/);
    }
  });
});
