// @vitest-environment node
/**
 * Owner decisions 2026-10-11 (review, Q-signed-form-stranded) — lib/stranded-creates.ts:
 * a credit request waiting at its salesman's signed-application step can be
 * moved on or closed by him alone, so the account changes that would strand it
 * (a route or role change on /users or in the account import, a disable) count
 * it beside his drafts and sent-back requests, and withdraw it only when told to.
 *
 *   - which requests count, as one `where`;
 *   - the withdraw: claimed on the request as read (and on the step, for one at
 *     the signed-application step), its audit row, and — at that step — the
 *     alerts that asked for it answered; a request that changed since is
 *     withdrawn not at all, and nothing else is written;
 *   - every guard uses them (the account edit, the account import's guard 4, the
 *     disable, the Manager's role action).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STRANDED_CREATE_SELECT,
  atSignedFormStep,
  atSignedFormStepWhere,
  onlyHisToCloseWhere,
  withdrawWithAccountChange,
  type StrandedCreate,
} from '@/lib/stranded-creates';
import { stripComments } from '../support/strip-comments';

const ENV = { actorId: 'stw', ip: null, userAgent: null };
const AT = new Date('2026-10-11T08:00:00Z');

function fakeTx(claimCount = 1) {
  const calls: Array<[string, unknown]> = [];
  const tx = {
    customerEdit: {
      updateMany: async (args: unknown) => {
        calls.push(['claim', args]);
        return { count: claimCount };
      },
    },
    auditLog: {
      create: async (args: unknown) => {
        calls.push(['audit', args]);
        return {};
      },
    },
    notification: {
      updateMany: async (args: unknown) => {
        calls.push(['alerts', args]);
        return { count: 1 };
      },
    },
  };
  return { tx: tx as never, calls };
}

const atStep: StrandedCreate = { id: 'e1', state: 'SUBMITTED', cycle: 2, currentStepIndex: 2, pendingRole: 'SALESMAN' };
const draft: StrandedCreate = { id: 'e2', state: 'DRAFT', cycle: 1, currentStepIndex: 0, pendingRole: null };
const withdraw = (tx: never, e: StrandedCreate) =>
  withdrawWithAccountChange(tx, ENV, e, {
    submittedById: 'sal1',
    byId: 'stw',
    at: AT,
    decisionReason: 'Withdrawn for a test.',
    auditReason: 'withdrawn with an account edit',
    auditAfter: { route: 'C5' },
  });

describe('which requests only he can close', () => {
  it('his drafts, his sent-back requests, and one waiting at his signed-application step', () => {
    expect(onlyHisToCloseWhere()).toEqual({
      process: 'CREATE',
      OR: [
        { state: { in: ['DRAFT', 'NEEDS_CORRECTION'] } },
        { state: 'SUBMITTED', pendingRole: 'SALESMAN' },
      ],
    });
    expect(atSignedFormStepWhere()).toEqual({ process: 'CREATE', state: 'SUBMITTED', pendingRole: 'SALESMAN' });
    // A fresh object each time: a caller spreading it cannot change the next one.
    expect(onlyHisToCloseWhere()).not.toBe(onlyHisToCloseWhere());
    expect(STRANDED_CREATE_SELECT).toEqual({ id: true, state: true, cycle: true, currentStepIndex: true, pendingRole: true });
  });

  it('at the step: SUBMITTED and held by SALESMAN, which only that step ever is', () => {
    expect(atSignedFormStep(atStep)).toBe(true);
    expect(atSignedFormStep(draft)).toBe(false);
    expect(atSignedFormStep({ state: 'SUBMITTED', pendingRole: 'FINANCE_MANAGER' })).toBe(false);
    expect(atSignedFormStep({ state: 'NEEDS_CORRECTION', pendingRole: 'SALESMAN' })).toBe(false);
  });
});

describe('withdrawn with an account change', () => {
  it('at the signed-application step: claimed on the step too, recorded, and the alerts that asked for it answered', async () => {
    const { tx, calls } = fakeTx();
    expect(await withdraw(tx, atStep)).toBe(true);
    expect(calls.map(([n]) => n)).toEqual(['claim', 'audit', 'alerts', 'alerts']);
    expect(calls[0]![1]).toEqual({
      where: { id: 'e1', state: 'SUBMITTED', cycle: 2, submittedById: 'sal1', currentStepIndex: 2, pendingRole: 'SALESMAN' },
      data: {
        state: 'REJECTED',
        pendingRole: null,
        slaDueAt: null,
        slaBreachedAt: null,
        lastEscalatedAt: null,
        escalationLevel: 0,
        reviewedById: 'stw',
        reviewedAt: AT,
        decisionReason: 'Withdrawn for a test.',
        decisionCategory: 'withdrawn',
      },
    });
    expect(calls[1]![1]).toMatchObject({
      data: {
        actorId: 'stw',
        action: 'UPDATE',
        entityType: 'CustomerEdit',
        entityId: 'e1',
        reason: 'withdrawn with an account edit',
        after: { process: 'CREATE', state: 'REJECTED', from: 'SUBMITTED', cycle: 2, atStep: 2, route: 'C5' },
      },
    });
    // Everyone else's rows (the print alert, the late pings), then his own.
    expect(calls[2]![1]).toMatchObject({ where: { editId: 'e1', readAt: null, userId: { not: 'sal1' } } });
    expect(calls[3]![1]).toEqual({
      where: { editId: 'e1', userId: 'sal1', readAt: null, kind: { in: ['SIGNED_FORM_REQUESTED', 'SLA_BREACH'] } },
      data: { readAt: AT },
    });
  });

  it('a draft: claimed on its state and cycle only, and no alert touched', async () => {
    const { tx, calls } = fakeTx();
    expect(await withdraw(tx, draft)).toBe(true);
    expect(calls.map(([n]) => n)).toEqual(['claim', 'audit']);
    expect((calls[0]![1] as { where: unknown }).where).toEqual({ id: 'e2', state: 'DRAFT', cycle: 1, submittedById: 'sal1' });
    expect((calls[1]![1] as { data: { after: unknown } }).data.after).toEqual({
      process: 'CREATE',
      state: 'REJECTED',
      from: 'DRAFT',
      cycle: 1,
      route: 'C5',
    });
  });

  it('changed since it was read (an upload landed first): false, and nothing else written', async () => {
    const { tx, calls } = fakeTx(0);
    expect(await withdraw(tx, atStep)).toBe(false);
    expect(calls.map(([n]) => n)).toEqual(['claim']);
  });
});

describe('every account change that could strand one counts it', () => {
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
  const users = src('services/users.ts');
  const between = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

  it('the Steward’s account edit: its stranded requests, and their withdraw', () => {
    const edit = between(users, 'async function updateUserAccountCore(', 'export async function updateUserEmailAction(');
    expect(edit).toMatch(/const strandedCreates =[\s\S]*?\.\.\.onlyHisToCloseWhere\(\)/);
    expect(edit).toMatch(/atSignedForm: strandedCreates\.filter\(atSignedFormStep\)\.length/);
    expect(edit).toMatch(/for \(const e of strandedCreates\) \{\s*const done = await withdrawWithAccountChange\(tx, env, e,/);
    // The old hand-rolled claim on DRAFT / NEEDS_CORRECTION only is gone.
    expect(edit).not.toMatch(/state: \{ in: \[EditState\.DRAFT, EditState\.NEEDS_CORRECTION\] \}/);
  });

  it('the disable: refused unless withdrawn, and withdrawn in the disable’s transaction', () => {
    const toggle = between(users, 'async function toggleUserActiveCore(', 'export async function resetPasswordAction(');
    expect(toggle).toMatch(/where: \{ submittedById: userId, \.\.\.atSignedFormStepWhere\(\) \}/);
    expect(toggle).toMatch(/signedFormDisableIssue\(/);
    const tx = toggle.slice(toggle.indexOf('withChangeContext(prisma,'));
    expect(tx.indexOf('withdrawWithAccountChange(')).toBeGreaterThan(-1);
    expect(tx.indexOf('withdrawWithAccountChange(')).toBeLessThan(tx.indexOf('tx.user.update('));
  });

  it('the Manager’s role action refuses one it would strand', () => {
    const role = between(users, 'async function updateUserRoleCore(', 'const editAccountSchema');
    expect(role).toMatch(/\.\.\.atSignedFormStepWhere\(\)/);
  });

  it('the account import’s guard 4', () => {
    const imports = src('services/imports.ts');
    expect(imports).toMatch(/const stranded = await prisma\.customerEdit\.count\(\{\s*where: \{\s*submittedById: existing\.id,\s*\.\.\.onlyHisToCloseWhere\(\),/);
  });
});
