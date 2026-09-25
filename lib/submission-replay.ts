/**
 * Server half of benchmark item 22 (lib/submission.ts has the owner's decisions).
 *
 * Every field submit may carry a submission id, stored on the CustomerEdit it
 * writes, unique per submitter. When the same id arrives again the request has
 * already landed — the reply to the first attempt was lost — so the submit
 * writes NOTHING and answers with a receipt for the request as it stands now.
 *
 * Two places ask: at the start of the submit (the common retry, long after the
 * first finished), and when the submit FAILS (`answerIfLanded`): a retry that
 * overlapped the first attempt is refused by whatever the first one changed — a
 * unique index the database held it on, a lock, a now-empty diff — and if its
 * own id has landed by then, the receipt is the true answer. Only an id match is
 * a replay. A different payload is a different id, and gets the conflict it
 * always got — never "any open request of mine".
 */
import { EditState, EditTarget, type EditProcess, type Prisma, type PrismaClient } from '@prisma/client';
import { ConflictError } from '@/lib/errors';
import { omanWhen, type SubmitReceipt } from '@/lib/submission';

type Db = Pick<PrismaClient, 'customerEdit'> | Prisma.TransactionClient;

/** What the earlier request must have been, for its receipt to answer this one. */
export type ReplayExpect = {
  process: EditProcess;
  target?: EditTarget;
  customerId?: string;
  branchId?: string;
  isReactivation?: boolean;
  /** A resumed new-customer request names its own row. */
  editId?: string;
};

export async function findReceipt(
  db: Db,
  submittedById: string,
  submissionId: string | undefined,
  expect: ReplayExpect
): Promise<SubmitReceipt | null> {
  if (!submissionId) return null;
  const e = await db.customerEdit.findUnique({
    where: { submittedById_submissionId: { submittedById, submissionId } },
    select: {
      id: true,
      state: true,
      process: true,
      target: true,
      customerId: true,
      branchId: true,
      isReactivation: true,
      submittedAt: true,
      updatedAt: true,
    },
  });
  if (!e) return null;
  const same =
    e.process === expect.process &&
    (expect.target === undefined || e.target === expect.target) &&
    (expect.customerId === undefined || e.customerId === expect.customerId) &&
    (expect.branchId === undefined || e.branchId === expect.branchId) &&
    (expect.isReactivation === undefined || e.isReactivation === expect.isReactivation) &&
    (expect.editId === undefined || e.id === expect.editId);
  if (!same) {
    // A phone mints a fresh id per payload; the same id for another request is a
    // client bug. Refuse it rather than hand back a receipt for the wrong thing.
    throw new ConflictError(
      'SUBMISSION_ID_REUSED',
      'This submit was confused with another request. Reload the page and submit again.'
    );
  }
  return { editId: e.id, state: e.state, submittedAt: shownTime(e).toISOString(), replayed: true };
}

/**
 * When a request was sent, as the salesman should read it. A draft shows when it
 * was saved: a draft resumed from a sent-back request still carries the previous
 * round's submittedAt, which is not this save.
 */
export function shownTime(e: { state: EditState; submittedAt: Date | null; updatedAt: Date }): Date {
  return e.state === EditState.DRAFT ? e.updatedAt : (e.submittedAt ?? e.updatedAt);
}

/**
 * Run a submit; if it fails after its own id has landed, answer with the receipt.
 * Whatever refused it — the one-open-edit index, the identity lock, "No changes
 * to submit" because the first attempt already applied them — was the first
 * attempt, so the first attempt's receipt is what happened. A failed lookup
 * (the database still down) leaves the original error standing.
 */
export async function answerIfLanded(
  work: () => Promise<SubmitReceipt>,
  receipt: () => Promise<SubmitReceipt | null>
): Promise<SubmitReceipt> {
  try {
    return await work();
  } catch (err) {
    const landed = await receipt().catch(() => null);
    if (landed) return landed;
    throw err;
  }
}

/** A unique violation, however Prisma surfaced it (see services/edits.ts EL-09). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : '';
  return code === 'P2002' || /Unique constraint failed/i.test(message);
}

/** The kind of field request a CustomerEdit on an existing customer is. */
export type RequestKind = 'update' | 'close' | 'reactivate';
export function requestKindOf(e: { target: EditTarget; isReactivation: boolean }): RequestKind {
  if (e.target === EditTarget.BRANCH) return e.isReactivation ? 'reactivate' : 'close';
  return 'update';
}

const KIND_PHRASE: Record<RequestKind, string> = {
  update: 'changes to this customer',
  close: 'request to mark a branch closed',
  reactivate: 'request to reactivate a branch',
};

/**
 * The refusal when a customer's one open request is the salesman's OWN. When it
 * is the same request — same kind, same branch — it is almost certainly this
 * submit's earlier attempt, whose reply was lost and which he has changed since
 * (a new id): say that it arrived. When it is a different request, say what is
 * waiting and that THIS one was not sent — never "yours arrived" for something
 * he did not send (the post-review fix: a pending close read as "your changes
 * already arrived" to a salesman whose update was refused).
 */
export function ownOpenRequestMessage(
  open: { target: EditTarget; isReactivation: boolean; branchId: string | null; submittedAt: Date | null },
  sending: { kind: RequestKind; branchId?: string }
): string {
  const at = open.submittedAt ? ` at ${omanWhen(open.submittedAt)}` : '';
  const openKind = requestKindOf(open);
  const sameRequest = openKind === sending.kind && (openKind === 'update' || open.branchId === sending.branchId);
  if (sameRequest) {
    return openKind === 'update'
      ? `Your changes sent${at} already arrived and are waiting for approval. Anything you changed since was not sent — send it once they are decided.`
      : `Your ${KIND_PHRASE[openKind]}, sent${at}, already arrived and is waiting for review. It must be decided before you can send another.`;
  }
  const waiting = openKind === 'update' ? 'are still waiting for approval' : 'is still waiting for review';
  const notSent = sending.kind === 'update' ? 'these changes were NOT sent' : 'this request was NOT sent';
  return `Your ${KIND_PHRASE[openKind]}, sent${at}, ${waiting}, so ${notSent}. Send ${sending.kind === 'update' ? 'them' : 'it'} once that is decided.`;
}

/**
 * The edit page's banner when the customer's open request is the salesman's own
 * — after a lost reply, reloading the page is how he learns his submit landed.
 * It names what is waiting: a pending close is not "your changes".
 */
export function ownPendingBanner(open: {
  target: EditTarget;
  isReactivation: boolean;
  submittedAt: Date | null;
}): string {
  const at = open.submittedAt ? ` at ${omanWhen(open.submittedAt)}` : '';
  const kind = requestKindOf(open);
  return kind === 'update'
    ? `Your changes sent${at} arrived and are waiting for approval. You can save a draft, but cannot submit again until they are decided.`
    : `Your ${KIND_PHRASE[kind]}, sent${at}, is waiting for review. You can save a draft, but cannot submit changes until it is decided.`;
}
