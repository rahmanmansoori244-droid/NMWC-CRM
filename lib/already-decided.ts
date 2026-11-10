/**
 * Code review 2026-11-10, finding 21: an approver whose decision already
 * arrived, or whose colleague decided first, is told so — not "You are not
 * authorized to act on this step", and not a raw state name.
 *
 * Two people met that sentence by design:
 *   - a Manager whose approval was saved but whose reply was lost on a weak
 *     signal: he taps again, the request is now at the next step, his own
 *     approval counts as "another step" for separation of duty, and the
 *     authorization gate refused him in words that say nothing about whether
 *     his approval counted;
 *   - a second Manager of the same region (four share one queue in Muscat)
 *     deciding from a page a colleague had just made stale.
 * A final approval or a send-back answered `Edit is in state APPROVED.` or
 * `Edit is in state NEEDS_CORRECTION.`.
 *
 * Nothing about the refusals changes: the decision tokens are compared exactly
 * as before, every authorization check runs exactly as before, and nothing is
 * written. This only chooses the words of a refusal that was coming anyway,
 * from the decision ledger (EditApproval) — the decision recorded for the visit
 * to the step the page showed (the token's cycle, step and stage entry time):
 *   - his own: "Your decision already arrived". It reveals only what he did.
 *   - someone else's: "Already decided by a colleague", naming who and what —
 *     but only to a viewer who could have decided that step himself (the same
 *     stepAuthority rule the gate uses: region, role, separation of duty),
 *     so who decided it is told to no one the request's page would not show it
 *     to. Anyone else keeps the refusal he had.
 */
import type { EditState, Prisma, PrismaClient, Role } from '@prisma/client';
import { ConflictError, type ConflictMeta } from './errors';
import { parseChainOrNull, stepName, type ApprovalStep } from './approval-chains';
import { ROLE_LABELS } from './account-edit';

/** The refusal code when the viewer's own decision is already recorded. Not a lost race: not recorded as a CONFLICT. */
export const ALREADY_DECIDED_CODE = 'ALREADY_DECIDED';

/** One visit to one step of a request: what a decision token names (lib/decision-token.ts). */
export type StepVisit = { cycle: number; stepIndex: number; stageEnteredAt: Date | null };

/** What a decision row says the decider did, as a phrase with its object. */
export type DecisionWords = Partial<Record<string, string>>;

/** The approval chain's decisions (EditApproval.decision), in words. */
export const REQUEST_DECISION_WORDS: DecisionWords = {
  APPROVED: 'approved this request',
  REJECTED: 'sent this request back',
  FORM_UPLOADED: 'sent the signed application for this request',
};

/** A close-shop request is refused for good, not sent back (services/edits.ts rejectEditCore). */
export const CLOSE_REQUEST_DECISION_WORDS: DecisionWords = {
  ...REQUEST_DECISION_WORDS,
  REJECTED: 'refused this request',
};

/** A reactivation's two answers on /reactivations: Approve and Keep closed. */
export const REACTIVATION_DECISION_WORDS: DecisionWords = {
  APPROVED: 'approved this reopening',
  REJECTED: 'kept this shop closed',
};

const AFTERWARDS = 'Nothing more was saved. Reload to see where it is now.';

export function yourDecisionArrivedMessage(did: string, stepRole: Role | string): string {
  return `Your decision already arrived: you ${did} at the ${stepName(stepRole)} step. ${AFTERWARDS}`;
}

export function colleagueDecidedMessage(
  did: string,
  stepRole: Role | string,
  who: { fullName: string; role: Role | null }
): string {
  const as = who.role ? ` (${ROLE_LABELS[who.role]})` : '';
  return `Already decided by a colleague: ${who.fullName}${as} ${did} at the ${stepName(stepRole)} step. ${AFTERWARDS}`;
}

/** Where a request that is no longer waiting stands, in words (never the enum). */
const STATE_WORDS: Record<EditState, string> = {
  APPROVED: 'it has already been approved',
  REJECTED: 'it has already been turned down or closed',
  NEEDS_CORRECTION: 'it has been sent back to the salesman to correct',
  DRAFT: 'it is with the salesman and has not been sent',
  SUBMITTED: 'it is waiting at another step',
};

/** The refusal of a decision on a request that is not waiting for one: `Edit is in state X.` in plain words. */
export function notPendingMessage(state: EditState | string): string {
  const words = STATE_WORDS[state as EditState] ?? 'it is not waiting for a decision';
  return `This request is no longer waiting for a decision: ${words}. Reload to see where it is now.`;
}

type Db = Pick<PrismaClient, 'editApproval'> | Pick<Prisma.TransactionClient, 'editApproval'>;

export type AlreadyDecidedArgs = {
  editId: string;
  viewerId: string;
  /** The visit the viewer's page showed; null = the request's latest decision (a reactivation has one step and no token). */
  visit: StepVisit | null;
  /** The request's stored chain (CustomerEdit.approvalChain), for the step's name and the colleague rule. */
  approvalChain: unknown;
  words: DecisionWords;
  /**
   * Whether the viewer could have decided that step himself — the gate's own rule
   * (stepAuthority) on the decided step, with the actors of the round's OTHER steps.
   * Only then is he told who decided it.
   */
  couldDecide: (step: ApprovalStep, priorStepActorIds: string[]) => Promise<boolean> | boolean;
  /** Who lost and on what, for the colleague answer (a lost race, recorded as before). */
  lost: ConflictMeta;
};

/**
 * The refusal to give instead of the one coming, or null to keep that one.
 * Reads only; writes nothing. Called on a path that refuses either way.
 */
export async function alreadyDecidedRefusal(db: Db, args: AlreadyDecidedArgs): Promise<ConflictError | null> {
  const chain = parseChainOrNull(args.approvalChain);
  const where: Prisma.EditApprovalWhereInput = args.visit
    ? {
        editId: args.editId,
        cycle: args.visit.cycle,
        stepIndex: args.visit.stepIndex,
        // A step-back and a re-advance return to the same step in the same round:
        // the entry time tells the visits apart. A token from before the stage
        // columns has none, and then the step's latest decision of the round counts.
        ...(args.visit.stageEnteredAt ? { stageEnteredAt: args.visit.stageEnteredAt } : {}),
      }
    : { editId: args.editId };
  const [row] = await db.editApproval.findMany({
    where,
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      cycle: true,
      stepIndex: true,
      role: true,
      decision: true,
      actorId: true,
      actorRole: true,
      actor: { select: { fullName: true, role: true } },
    },
  });
  if (!row) return null;
  const did = args.words[row.decision];
  if (!did) return null;
  if (row.actorId === args.viewerId) {
    return new ConflictError(ALREADY_DECIDED_CODE, yourDecisionArrivedMessage(did, row.role));
  }
  const step = chain?.[row.stepIndex] ?? null;
  if (!step) return null;
  const others = await db.editApproval.findMany({
    where: { editId: args.editId, cycle: row.cycle, stepIndex: { not: row.stepIndex } },
    select: { actorId: true },
  });
  if (!(await args.couldDecide(step, others.map((o) => o.actorId)))) return null;
  return new ConflictError(
    'NOT_PENDING',
    colleagueDecidedMessage(did, row.role, { fullName: row.actor.fullName, role: row.actorRole ?? row.actor.role }),
    args.lost
  );
}
