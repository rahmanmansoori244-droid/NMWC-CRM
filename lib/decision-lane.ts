/**
 * F1 (2026-10-05): what the viewer of /approvals/[id] can do with the request
 * on screen, said on the page instead of discovered at the click.
 *
 * The page has always shown Approve and Reject to every approver role in scope
 * of the request, and the action decided: `approveEditCore` / `rejectEditCore`
 * refuse anyone who cannot act on the CURRENT step (`canActOnStep`) and refuse a
 * reactivation outright (WRONG_LANE: it is decided on /reactivations). Two kinds
 * of visitor now arrive by design and would only learn that at the click:
 *
 *   - an Accountant told "for your information" (REQUEST_FYI) of a request still
 *     at the Supervisor step (challenges note: "the FYI landing page should be
 *     read-only or carry a banner");
 *   - a GM or Accountant who opens a reactivation from an SLA breach or an FYI.
 *
 * The page carries a banner for both. The buttons stay: the action is the
 * authority, existing reviewers are not second-guessed by the page, and a banner
 * that is wrong can only mislead where a hidden button could strand a request.
 *
 * The inputs are exactly what `approveEditCore` passes `canActOnStep`, so the
 * page and the action answer the same question: the frozen chain's current
 * step, the scope branches (a new-customer request's DRAFT routes, otherwise the
 * customer's live branches), the viewer's managed regions, and the actors of the
 * OTHER steps in the current cycle (separation of duty).
 */
import type { Role } from '@prisma/client';
import { parseChain } from './approval-chains';
import { canActOnStep } from './permissions';

export type DecisionLane =
  /** The viewer can decide the current step. No banner. */
  | { kind: 'decide' }
  /** Pending, but the current step belongs to someone else: read-only for this viewer. */
  | { kind: 'inform'; waitingOn: Role }
  /** A reactivation: decided only on /reactivations, by a Manager of the branch's region. */
  | { kind: 'reactivation' }
  /** Not pending any more: the page's decision banner says what happened. */
  | { kind: 'closed' };

export function decisionLaneFor(
  viewer: { id: string; role: Role; username: string },
  edit: {
    state: string;
    isReactivation: boolean;
    approvalChain: unknown;
    currentStepIndex: number;
    cycle: number;
    submittedBy: { id: string; supervisorId: string | null };
    steps: ReadonlyArray<{ cycle: number; stepIndex: number; actorId?: string | null }>;
  },
  scope: {
    branches: ReadonlyArray<{ regionId: string; deletedAt: Date | null }>;
    managedRegionIds: string[];
  }
): DecisionLane {
  if (edit.state !== 'SUBMITTED') return { kind: 'closed' };
  if (edit.isReactivation) return { kind: 'reactivation' };
  const chain = parseChain(edit.approvalChain);
  const step = chain[edit.currentStepIndex];
  // A pending request with no current step is refused by the action as
  // NOT_PENDING; nothing useful to say here beyond the action's own answer.
  if (!step) return { kind: 'decide' };
  const priorStepActorIds = edit.steps
    .filter((s) => s.cycle === edit.cycle && s.stepIndex !== edit.currentStepIndex)
    .map((s) => s.actorId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const can = canActOnStep(viewer, step, edit.submittedBy, {
    customerBranches: [...scope.branches],
    managedRegionIds: scope.managedRegionIds,
    priorStepActorIds,
  });
  return can ? { kind: 'decide' } : { kind: 'inform', waitingOn: step.role };
}
