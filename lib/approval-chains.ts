/**
 * Approval-chain matrix for the unified CRM (Phase 1b).
 *
 * Config-in-code, NOT a DB table: the three chains are owner-locked business
 * decisions with near-zero churn, and a code matrix gets exhaustive Role-enum
 * type-checking + unit tests for free. The resolved chain is SNAPSHOTTED onto
 * each CustomerEdit at submit (`approvalChain` Json) so an in-flight request is
 * deterministic even if this matrix later changes — step advancement always
 * reads the row's snapshot, never this constant.
 *
 * Owner-confirmed (2026-07-15):
 *   - UPDATE:        Salesman → Supervisor
 *   - CASH create:   Salesman → Supervisor → Accountant
 *   - Finance Manager + GM are ORG-WIDE; Accountant is REGION-SCOPED.
 *   - GM is ALWAYS required for credit (no credit-limit threshold skip).
 *
 * Owner decisions 2026-10-11 (CHAIN_VERSION 2) — the CREDIT create chain:
 *   Salesman → Supervisor → Sales Director → signed application (the submitting
 *   salesman) → Finance Manager → GM → Accountant.
 *   - The Sales Director is one for every region in Oman: GLOBAL, like the GM.
 *   - The signed-application step belongs to the salesman who submitted: the
 *     credit application is printed, he has the customer sign and stamp it, and
 *     he uploads it (services/signed-form.ts), within 3 working days. Its scope
 *     is SUBMITTER. Nobody APPROVES it — canActOnStep refuses every actor on it,
 *     so it can never be decided through approve/reject, and "the submitter never
 *     approves" stays literally true; the salesman's own upload completes it.
 *   - Send-backs are the existing one-step-back cascade, index-based: a Sales
 *     Director send-back returns to the Supervisor, a Finance Manager send-back
 *     to the signed-application step (he uploads it again), a GM send-back to the
 *     Finance Manager, an Accountant send-back to the GM.
 *   - A request frozen with the 4-step chain before these decisions keeps it:
 *     every reader goes through parseChain(row.approvalChain).
 *
 * The arrays list only the steps that FOLLOW the salesman's submit (the submit
 * itself is "step -1"). So CASH create has 2 steps and CREDIT has 6;
 * `CustomerEdit.currentStepIndex` indexes into this array.
 */
import { Role, PaymentTerms, EditProcess } from '@prisma/client';
import { slaDeadline, STAGE_SLA_MINUTES, DEFAULT_STAGE_SLA_MIN } from './working-hours';

/**
 * Bump when the shape/meaning of a chain changes; frozen per-edit at submit.
 * 2: owner decisions 2026-10-11 — the Sales Director and signed-application
 * steps in the CREDIT create chain.
 */
export const CHAIN_VERSION = 2;

/** Stage budget in hours, env-overridable via lib/working-hours STAGE_SLA_MINUTES. */
function stageHours(role: Role): number {
  return (STAGE_SLA_MINUTES[role] ?? DEFAULT_STAGE_SLA_MIN) / 60;
}

/**
 * How a step's authorized actor is scoped to the customer under review.
 * SUBMITTER (owner decisions 2026-10-11): the step is the submitting salesman's
 * own errand — the signed credit application — and no approver acts on it
 * (lib/permissions.ts canActOnStep refuses everyone).
 */
export type StepScope = 'SUPERVISOR_OF_SUBMITTER' | 'REGION_OVERLAP' | 'GLOBAL' | 'SUBMITTER';

export interface ApprovalStep {
  role: Role;
  scope: StepScope;
  /**
   * Working-hours SLA budget for this step (frozen per-edit at submit).
   * SUPERVISOR/ACCOUNTANT are OLD-parity; FM/GM are placeholders (Q-sla open).
   * Env-overridable via SLA_*_MIN — see lib/working-hours.ts.
   */
  slaHours: number;
}

const SUPERVISOR_STEP: ApprovalStep = {
  role: Role.SUPERVISOR,
  scope: 'SUPERVISOR_OF_SUBMITTER',
  slaHours: stageHours(Role.SUPERVISOR),
};
// Accountant is the final approver on BOTH create chains and is region-scoped.
const ACCOUNTANT_STEP: ApprovalStep = {
  role: Role.ACCOUNTANT,
  scope: 'REGION_OVERLAP',
  slaHours: stageHours(Role.ACCOUNTANT),
};

/**
 * Resolve the ordered approver chain for an edit. Called ONCE at submit; the
 * result is frozen onto the edit row.
 */
export function resolveChain(process: EditProcess, paymentTerms: PaymentTerms): ApprovalStep[] {
  if (process === EditProcess.UPDATE) {
    return [SUPERVISOR_STEP];
  }
  // CREATE
  if (paymentTerms === PaymentTerms.CASH) {
    return [SUPERVISOR_STEP, ACCOUNTANT_STEP];
  }
  // CREATE + CREDIT — GM always required (owner-confirmed, no threshold skip).
  // Owner decisions 2026-10-11: the Sales Director after the Supervisor, then the
  // salesman's signed application, before the Finance Manager.
  return [
    SUPERVISOR_STEP,
    { role: Role.SALES_DIRECTOR, scope: 'GLOBAL', slaHours: stageHours(Role.SALES_DIRECTOR) },
    SIGNED_FORM_STEP,
    { role: Role.FINANCE_MANAGER, scope: 'GLOBAL', slaHours: stageHours(Role.FINANCE_MANAGER) },
    { role: Role.GM, scope: 'GLOBAL', slaHours: stageHours(Role.GM) },
    ACCOUNTANT_STEP,
  ];
}

/**
 * Owner decisions 2026-10-11: the signed-application step. Held by the
 * submitting salesman (pendingRole SALESMAN — a role no approval queue selects),
 * with a 3-working-day budget (lib/working-hours.ts SLA_SIGNED_FORM_MIN).
 */
const SIGNED_FORM_STEP: ApprovalStep = {
  role: Role.SALESMAN,
  scope: 'SUBMITTER',
  slaHours: stageHours(Role.SALESMAN),
};

/** Whether this step is the salesman's signed-application step. */
export function isSignedFormStep(step: Pick<ApprovalStep, 'scope'> | null | undefined): boolean {
  return step?.scope === 'SUBMITTER';
}

/** The index of the signed-application step in a chain, or -1 (a cash, update or pre-2026-10-11 chain). */
export function signedFormStepIndex(chain: ReadonlyArray<Pick<ApprovalStep, 'scope'>>): number {
  return chain.findIndex((s) => isSignedFormStep(s));
}

/** Whether a chain has the signed-application step: frozen with CHAIN_VERSION 2 or later, CREDIT. */
export function hasSignedFormStep(chain: ReadonlyArray<Pick<ApprovalStep, 'scope'>>): boolean {
  return signedFormStepIndex(chain) >= 0;
}

/**
 * The words a step is called by on every screen, notification and printout —
 * never the enum (`FINANCE_MANAGER`, or `SALESMAN` for a step that is an errand,
 * not an approval). A bare role is read as the step it holds: SALESMAN is only
 * ever pending at the signed-application step, and a null pendingRole is a
 * deploy-gap Supervisor row.
 */
export function stepName(step: Pick<ApprovalStep, 'role'> | Role | string | null | undefined): string {
  const role = typeof step === 'string' ? step : (step?.role ?? Role.SUPERVISOR);
  return STEP_NAMES[role] ?? role.replace(/_/g, ' ');
}

const STEP_NAMES: Record<string, string> = {
  SUPERVISOR: 'Supervisor',
  SALES_DIRECTOR: 'Sales Director',
  SALESMAN: 'Signed application',
  FINANCE_MANAGER: 'Finance Manager',
  GM: 'GM',
  ACCOUNTANT: 'Accountant',
  MANAGER: 'Manager',
};

/**
 * What an EditApproval row records (its `decision` column). FORM_UPLOADED (owner
 * decisions 2026-10-11): the salesman uploaded the customer's signed credit
 * application and the request moved on — his completion of the
 * signed-application step, which is not an approval. Written by
 * services/signed-form.ts only.
 */
export const DECISION_APPROVED = 'APPROVED';
export const DECISION_REJECTED = 'REJECTED';
export const DECISION_FORM_UPLOADED = 'FORM_UPLOADED';

/** True when `stepIndex` is the last approver step in the chain. */
export function isFinalStep(chain: ApprovalStep[], stepIndex: number): boolean {
  return stepIndex >= chain.length - 1;
}

/**
 * Working-hours step deadline (Asia/Muscat calendar, lib/working-hours.ts) —
 * replaces the Phase-1b wall-clock placeholder. `slaHours` of WORKING time
 * after `from`: nights and Fridays never count against a reviewer.
 */
export function stepDeadline(from: Date, slaHours: number): Date {
  return slaDeadline(from, Math.round(slaHours * 60));
}

/** Where a rejection at `stepIndex` sends the request (owner-confirmed cascade). */
export type RejectTarget = { kind: 'STEP_BACK'; toStepIndex: number } | { kind: 'TO_SALESMAN' };

/**
 * Owner-confirmed step-back cascade (2026-07-15): a rejection at step N returns
 * the request to the previous approver (N-1); a rejection at the first step
 * returns it to the salesman (NEEDS_CORRECTION).
 *
 * Loop guard (Q-pingpong): if the same step has already rejected this request
 * once in the current cycle, the cascade stops and the request goes to the
 * salesman — so an approve/reject ping-pong between two adjacent steps cannot
 * loop forever on unchanged data.
 */
export function resolveRejectTarget(
  stepIndex: number,
  priorRejectsAtThisStepThisCycle: number
): RejectTarget {
  if (priorRejectsAtThisStepThisCycle >= 1) return { kind: 'TO_SALESMAN' };
  if (stepIndex <= 0) return { kind: 'TO_SALESMAN' };
  return { kind: 'STEP_BACK', toStepIndex: stepIndex - 1 };
}

/**
 * Safely read the frozen chain JSON off a CustomerEdit. Falls back to the
 * single-Supervisor chain (the pre-Phase-1b default, also the migration
 * backfill value) if the column is null/malformed — so a legacy row without a
 * frozen chain still advances correctly.
 */
export function parseChain(approvalChain: unknown): ApprovalStep[] {
  if (Array.isArray(approvalChain) && approvalChain.length > 0) {
    return approvalChain as ApprovalStep[];
  }
  return [SUPERVISOR_STEP];
}
