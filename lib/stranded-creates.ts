/**
 * The new-customer requests that only their own salesman can move on or close,
 * and how an account change closes them (services/users.ts, services/imports.ts).
 *
 *   - Drafts and requests sent back to him (DRAFT, NEEDS_CORRECTION): only he
 *     sends one again, and only from the route it was started on
 *     (services/creates.ts).
 *   - Owner decisions 2026-10-11 (review, Q-signed-form-stranded): a credit
 *     request waiting at his signed-application step (SUBMITTED, pendingRole
 *     SALESMAN, which only that step ever holds — lib/approval-chains.ts
 *     stepName). Nobody approves or sends back that step (lib/permissions.ts
 *     canActOnStep refuses every actor on a SUBMITTER step), and only he uploads
 *     the form, as a salesman, from the route it was started on
 *     (services/signed-form.ts). Moved, re-roled or disabled while one waits
 *     there, nobody can move it or close it, and a request in review holds its
 *     CR number and shop for every salesman (lib/create-guards.ts). Until the
 *     owner decides who else may send it back or close it, an account change
 *     that would strand one is refused unless it withdraws it, as the account
 *     edit already did for drafts and sent-back requests — the existing way to
 *     close one (withdrawCreateCore). [Default — Q-signed-form-stranded, 04-PENDING A8.]
 *
 * Server only: it writes through the caller's transaction.
 */
import { EditProcess, EditState, Role, type Prisma } from '@prisma/client';
import { writeAudit, type AuditEnvelope } from './audit';
import { settleRequestAlerts } from './notifications';

/** A request waiting at its salesman's signed-application step. */
export function atSignedFormStepWhere(): Prisma.CustomerEditWhereInput {
  return { process: EditProcess.CREATE, state: EditState.SUBMITTED, pendingRole: Role.SALESMAN };
}

/** Every new-customer request only its own salesman can move on or close (see above). */
export function onlyHisToCloseWhere(): Prisma.CustomerEditWhereInput {
  return {
    process: EditProcess.CREATE,
    OR: [
      { state: { in: [EditState.DRAFT, EditState.NEEDS_CORRECTION] } },
      { state: EditState.SUBMITTED, pendingRole: Role.SALESMAN },
    ],
  };
}

/** What a withdraw claims on: the request as it was read. */
export const STRANDED_CREATE_SELECT = {
  id: true,
  state: true,
  cycle: true,
  currentStepIndex: true,
  pendingRole: true,
} as const satisfies Prisma.CustomerEditSelect;

export type StrandedCreate = {
  id: string;
  state: EditState;
  cycle: number;
  currentStepIndex: number;
  pendingRole: Role | null;
};

export function atSignedFormStep(e: Pick<StrandedCreate, 'state' | 'pendingRole'>): boolean {
  return e.state === EditState.SUBMITTED && e.pendingRole === Role.SALESMAN;
}

/**
 * Withdraws one with an account change, as withdrawCreateCore (services/creates.ts)
 * withdraws one: closed for good (REJECTED), the clock stopped, the decision
 * fields saying who closed it and why, an UPDATE audit row in the same
 * transaction. Claimed on the state and cycle read before the transaction — and,
 * at the signed-application step, on the step: an upload that landed first
 * wins. At that step the alerts that asked for it are answered too: the print
 * rows held by his supervisor or Managers, and his own must-act and late alerts.
 *
 * False when the request changed since it was read; the caller refuses the whole
 * change, and its transaction rolls this back with it.
 */
export async function withdrawWithAccountChange(
  tx: Prisma.TransactionClient,
  env: AuditEnvelope,
  e: StrandedCreate,
  p: {
    submittedById: string;
    /** Who made the account change: the decision fields name him. */
    byId: string;
    at: Date;
    /** What the salesman reads on the closed request. */
    decisionReason: string;
    auditReason: string;
    /** Added to the audit row's `after` (ids and codes only). */
    auditAfter?: Record<string, string | number | null>;
  }
): Promise<boolean> {
  const atStep = atSignedFormStep(e);
  const claim = await tx.customerEdit.updateMany({
    where: {
      id: e.id,
      state: e.state,
      cycle: e.cycle,
      submittedById: p.submittedById,
      ...(atStep ? { currentStepIndex: e.currentStepIndex, pendingRole: Role.SALESMAN } : {}),
    },
    data: {
      state: EditState.REJECTED,
      pendingRole: null,
      slaDueAt: null,
      slaBreachedAt: null,
      lastEscalatedAt: null,
      escalationLevel: 0,
      reviewedById: p.byId,
      reviewedAt: p.at,
      decisionReason: p.decisionReason,
      decisionCategory: 'withdrawn',
    },
  });
  if (claim.count === 0) return false;
  await writeAudit(tx, env, {
    action: 'UPDATE',
    entityType: 'CustomerEdit',
    entityId: e.id,
    reason: p.auditReason,
    after: {
      process: 'CREATE',
      state: EditState.REJECTED,
      from: e.state,
      cycle: e.cycle,
      ...(atStep ? { atStep: e.currentStepIndex } : {}),
      ...p.auditAfter,
    } as unknown as Prisma.InputJsonValue,
  });
  if (atStep) {
    await settleRequestAlerts(tx, { editId: e.id, submittedById: p.submittedById });
    await tx.notification.updateMany({
      where: {
        editId: e.id,
        userId: p.submittedById,
        readAt: null,
        kind: { in: ['SIGNED_FORM_REQUESTED', 'SLA_BREACH'] },
      },
      data: { readAt: p.at },
    });
  }
  return true;
}
