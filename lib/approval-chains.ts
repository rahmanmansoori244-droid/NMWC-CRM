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
 *   - CREDIT create: Salesman → Supervisor → Finance Manager → GM → Accountant
 *   - Finance Manager + GM are ORG-WIDE; Accountant is REGION-SCOPED.
 *   - GM is ALWAYS required for credit (no credit-limit threshold skip).
 *
 * The arrays list only the APPROVER steps that FOLLOW the salesman's submit (the
 * submit itself is "step -1"). So CASH create has 2 approver steps and CREDIT
 * has 4; `CustomerEdit.currentStepIndex` indexes into this array.
 */
import { Role, PaymentTerms, EditProcess } from '@prisma/client';

/** Bump when the shape/meaning of a chain changes; frozen per-edit at submit. */
export const CHAIN_VERSION = 1;

/** How a step's authorized actor is scoped to the customer under review. */
export type StepScope = 'SUPERVISOR_OF_SUBMITTER' | 'REGION_OVERLAP' | 'GLOBAL';

export interface ApprovalStep {
  role: Role;
  scope: StepScope;
  /** Working-hours SLA budget for this step. Placeholder values — Q-sla open. */
  slaHours: number;
}

const SUPERVISOR_STEP: ApprovalStep = {
  role: Role.SUPERVISOR,
  scope: 'SUPERVISOR_OF_SUBMITTER',
  slaHours: 8,
};
// Accountant is the final approver on BOTH create chains and is region-scoped.
const ACCOUNTANT_STEP: ApprovalStep = {
  role: Role.ACCOUNTANT,
  scope: 'REGION_OVERLAP',
  slaHours: 9,
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
  return [
    SUPERVISOR_STEP,
    { role: Role.FINANCE_MANAGER, scope: 'GLOBAL', slaHours: 16 },
    { role: Role.GM, scope: 'GLOBAL', slaHours: 24 },
    ACCOUNTANT_STEP,
  ];
}

/** True when `stepIndex` is the last approver step in the chain. */
export function isFinalStep(chain: ApprovalStep[], stepIndex: number): boolean {
  return stepIndex >= chain.length - 1;
}

/**
 * Wall-clock step deadline. NOTE: the working-hours (Asia/Muscat) SLA calendar
 * and the escalation sweep are the SLA/notifications increment; this is a
 * placeholder so the engine populates `slaDueAt` meaningfully in the meantime.
 */
export function stepDeadline(from: Date, slaHours: number): Date {
  return new Date(from.getTime() + slaHours * 3_600_000);
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
