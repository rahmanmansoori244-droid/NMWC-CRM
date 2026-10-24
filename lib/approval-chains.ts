/**
 * Approval-chain matrix for the unified CRM (Phase 1b).
 *
 * Config-in-code, NOT a DB table: the three chains are owner-locked business
 * decisions with near-zero churn, and a code matrix gets exhaustive Role-enum
 * type-checking + unit tests for free. The resolved chain is SNAPSHOTTED onto
 * each CustomerEdit at submit (`approvalChain` Json) so an in-flight request is
 * deterministic even if this matrix later changes — step advancement always
 * reads the row's snapshot, never this constant. Since gap 37 close and
 * reactivation freeze theirs too, and the snapshot can be `{ v, calendar,
 * steps }` (freezeChain; written only once CHAIN_OBJECT_FORM_ENABLED is on); the
 * bare array reads as version 0 (readFrozenChain). parseChain fails closed on a
 * stored value that is not a chain.
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
import { slaDeadline, STAGE_SLA_MINUTES, DEFAULT_STAGE_SLA_MIN, workingCalendar } from './working-hours';
import { AppError } from './errors';
import { logger } from './logger';

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
 * Gap 37 (data audit 2026-10-10): what is frozen onto a request when it is sent.
 * The steps alone did not let a past deadline be explained again: the working
 * calendar it was computed on (WORK_* settings, lib/working-hours.ts) moved
 * with the environment. So the chain can be stored as `{ v, calendar, steps }`:
 * the matrix version, the calendar in force at the freeze, and the steps with
 * their budgets. Deadlines are still computed on the live calendar (no SLA
 * behaviour changes); the frozen one is the record of what it was. A change to
 * a WORK_* or SLA_* setting is a dated entry in the private operations log
 * (docs/OPERATIONS.md section 3).
 *
 * Rows frozen as the bare array read as version 0: no calendar.
 */
export type WorkingCalendar = ReturnType<typeof workingCalendar>;

export type FrozenChain = { v: number; calendar: WorkingCalendar | null; steps: ApprovalStep[] };

/** What is written to `approvalChain`: the bare array (version 0), or the object. */
export type StoredChain = ApprovalStep[] | FrozenChain;

/**
 * The object form is a two-step change (review of gap 37, 2026-10-25). The build
 * production rolls back to before this one (a454239) reads only the bare array:
 * there an object reads as ONE Supervisor step, so a cash create would finalize
 * on the Supervisor's approval (no Accountant), a credit create would skip the
 * Sales Director, the signed form, the Finance Manager and the GM, and a request
 * past its first step would have no step at all and could not be decided. So
 * this build READS both forms and still WRITES the bare array. A one-line
 * follow-up commit turns this on once a build that reads the object is
 * production's rollback target (docs/OPERATIONS.md section 4, "The approval
 * chain's stored form"). Once it is on: never Instant-Rollback past a build that
 * reads the object, and a revert of the writer keeps the reader.
 */
export const CHAIN_OBJECT_FORM_ENABLED = false;

/** What a person is told when the step budgets cannot be frozen (an SLA_* value that is not a number). */
export const SLA_SETTINGS_INVALID_MESSAGE =
  'The approval deadline settings of this system are not valid, so nothing was saved. Tell the system operator.';

/** What a person is told when a request's stored approval steps cannot be read. */
export const CHAIN_UNREADABLE_MESSAGE =
  "This request's stored approval steps cannot be read, so nothing was done. Tell the system operator: it has to be repaired before anyone can act on it.";

/** A budget a deadline can be computed on: a finite number of hours, not negative. */
const isBudget = (h: unknown): h is number => typeof h === 'number' && Number.isFinite(h) && h >= 0;

/**
 * The chain to store on a request as it is sent (or saved as a draft): the bare
 * array while CHAIN_OBJECT_FORM_ENABLED is off, `{ v, calendar, steps }` after.
 *
 * Refuses a chain with no step, and one whose budget is not a number: an SLA_*
 * value that is not a number (lib/working-hours.ts reads `Number(env)`, so
 * '16h' is NaN) would be stored as null and every deadline computed on it would
 * be meaningless. Nothing is saved, and the operator corrects the setting.
 */
export function freezeChain(steps: ApprovalStep[], objectForm: boolean = CHAIN_OBJECT_FORM_ENABLED): StoredChain {
  if (steps.length === 0) throw new Error('freezeChain: an approval chain has at least one step');
  const bad = steps.filter((s) => !isBudget(s.slaHours));
  if (bad.length > 0) {
    logger.error({ roles: bad.map((s) => s.role) }, 'approval_chain.budget_invalid');
    throw new AppError('SLA_SETTINGS_INVALID', SLA_SETTINGS_INVALID_MESSAGE, 500);
  }
  return objectForm ? { v: CHAIN_VERSION, calendar: workingCalendar(), steps } : steps;
}

const STEP_SCOPES: ReadonlySet<string> = new Set<StepScope>(['SUPERVISOR_OF_SUBMITTER', 'REGION_OVERLAP', 'GLOBAL', 'SUBMITTER']);

/**
 * The structure who may act depends on: a role and a known scope. The budget is
 * NOT part of it: a budget that is not a number is "no frozen budget" for the
 * SLA sweep (frozenStepBudgetMin), never a reason to read the chain differently.
 */
const isStep = (s: unknown): s is ApprovalStep =>
  !!s &&
  typeof s === 'object' &&
  typeof (s as ApprovalStep).role === 'string' &&
  (s as ApprovalStep).role.length > 0 &&
  STEP_SCOPES.has((s as ApprovalStep).scope);

type ChainRead = { kind: 'none' } | { kind: 'frozen'; chain: FrozenChain } | { kind: 'malformed'; why: string };

/**
 * Read the stored value: nothing stored (null: a request sent before chains
 * were frozen, or a close or reactivation sent before gap 37); the bare array
 * (version 0, taken as it is, as every build has taken it); or the object,
 * which is checked: a whole version from 1 and at least one step, each with a
 * role and a known scope. A calendar that is not an object reads as none (it is
 * a record; nothing is decided on it). Anything else is malformed.
 */
function readStoredChain(approvalChain: unknown): ChainRead {
  if (approvalChain === null || approvalChain === undefined) return { kind: 'none' };
  if (Array.isArray(approvalChain)) {
    return { kind: 'frozen', chain: { v: 0, calendar: null, steps: approvalChain as ApprovalStep[] } };
  }
  if (typeof approvalChain !== 'object') return { kind: 'malformed', why: `a ${typeof approvalChain}` };
  const o = approvalChain as Record<string, unknown>;
  if (typeof o.v !== 'number' || !Number.isInteger(o.v) || o.v < 1) return { kind: 'malformed', why: 'no version' };
  if (!Array.isArray(o.steps) || o.steps.length === 0) return { kind: 'malformed', why: 'no steps' };
  const at = o.steps.findIndex((s) => !isStep(s));
  if (at >= 0) return { kind: 'malformed', why: `step ${at} has no role or no known scope` };
  const cal = o.calendar;
  const calendar = cal && typeof cal === 'object' && !Array.isArray(cal) ? (cal as WorkingCalendar) : null;
  return { kind: 'frozen', chain: { v: o.v, calendar, steps: o.steps as ApprovalStep[] } };
}

/**
 * The stored chain in either form, or null when there is none to read (nothing
 * stored, or a value that is not a chain). For records and budgets only: who
 * may act is read through parseChain, which refuses a value that is not a chain.
 */
export function readFrozenChain(approvalChain: unknown): FrozenChain | null {
  const r = readStoredChain(approvalChain);
  return r.kind === 'frozen' ? r.chain : null;
}

/**
 * The budget, in working minutes, of one step of the chain frozen on a request
 * (either stored form), or null when the row froze none, or none that is a
 * number: the SLA sweep then falls back to the live policy for its pendingRole
 * (app/api/cron/sla-escalate).
 */
export function frozenStepBudgetMin(approvalChain: unknown, stepIndex: number): number | null {
  const step: unknown = readFrozenChain(approvalChain)?.steps[stepIndex];
  const hours = step && typeof step === 'object' ? (step as { slaHours?: unknown }).slaHours : undefined;
  return isBudget(hours) ? Math.round(hours * 60) : null;
}

/**
 * The chain a close-shop request rides: the Supervisor step, as it always did
 * (pendingRole SUPERVISOR, the Supervisor's budget). Frozen since gap 37 so the
 * request records it; before, its chain was empty and read as this fallback.
 */
export function closeRequestChain(): ApprovalStep[] {
  return [SUPERVISOR_STEP];
}

/**
 * The chain a reactivation rides: one Manager step, region-scoped, on the
 * Manager's budget: what it always was (pendingRole MANAGER, decided by a
 * Manager of the shop's region). Frozen since gap 37; before, its empty chain
 * read as the Supervisor fallback, so a reactivation's page named the wrong step.
 */
export function reactivationChain(): ApprovalStep[] {
  return [{ role: Role.MANAGER, scope: 'REGION_OVERLAP', slaHours: stageHours(Role.MANAGER) }];
}

/**
 * Read the frozen chain JSON off a CustomerEdit, in either stored form. Nothing
 * stored (null), or the bare array empty, reads as the single-Supervisor chain:
 * the pre-Phase-1b default, also the migration backfill value, so a legacy row
 * without a frozen chain still advances correctly.
 *
 * FAILS CLOSED on anything else (review of gap 37, 2026-10-25): a value that is
 * present but is not a chain is refused (CHAIN_UNREADABLE) and logged, never
 * read as one Supervisor step. That fallback would let the Supervisor's
 * approval finalize a cash create without the Accountant, or a credit create
 * without the Sales Director, the Finance Manager and the GM.
 */
export function parseChain(approvalChain: unknown): ApprovalStep[] {
  const steps = parseChainOrNull(approvalChain);
  if (!steps) throw new AppError('CHAIN_UNREADABLE', CHAIN_UNREADABLE_MESSAGE, 409);
  return steps;
}

/**
 * parseChain for a reader that must not stop on one bad row (the approvals list,
 * the e-mail drain): null, logged, where parseChain refuses. The caller treats
 * that request as one nobody can act on.
 */
export function parseChainOrNull(approvalChain: unknown): ApprovalStep[] | null {
  const r = readStoredChain(approvalChain);
  if (r.kind === 'malformed') {
    logger.error({ why: r.why }, 'approval_chain.unreadable');
    return null;
  }
  if (r.kind === 'frozen' && r.chain.steps.length > 0) return r.chain.steps;
  return [SUPERVISOR_STEP];
}
