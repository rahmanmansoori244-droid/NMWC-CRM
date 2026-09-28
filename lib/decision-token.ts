/**
 * N01 (auditor recheck, 2026-09-27): an approval or a rejection is bound to the
 * request as the reviewer saw it, not as the server finds it.
 *
 * Approve and reject used to send only the edit id. The server reloaded the row
 * and built its compare-and-set claim from that fresh row, so the claim guarded
 * only the milliseconds between the reload and the write. A Finance Manager's
 * tab opened on a cycle-1 request for OMR 400 approved the cycle-2 correction for
 * OMR 10,000 / 90 days that it had never displayed.
 *
 * Every page that offers a decision now renders this token from the same row it
 * renders, and every decision sends it back. The server refuses a token that
 * does not match the row (STALE_VIEW), and builds the claim's WHERE from the
 * token rather than from the row it reloaded, so the check and the write are
 * one statement (services/edits.ts; pinned by tests/unit/cron-run-history.test.ts).
 *
 * What it binds, and why that is the whole payload:
 *   cycle            A CREATE request's drafts and credit figures are rewritten
 *                    only while it is NOT submitted (services/creates.ts refuses
 *                    a SUBMITTED row), and every return to SUBMITTED bumps the
 *                    cycle (resolveCycleOnSubmit). An UPDATE row's fieldChanges
 *                    never change once submitted. So the cycle is the payload
 *                    revision.
 *   stepIndex +      The visit to the step: a step-back and a re-advance return
 *   stageEnteredAt   to the same index in the same cycle, with a new entry time.
 *                    Null on rows older than the stage columns, and bound as null.
 *   creditLimit +    The requested figures, as the bulk queue card shows them
 *   paymentTermDays  (X-APPR-1). Bound explicitly as well, so a finance decision
 *                    is tied to the numbers on screen even if the invariant above
 *                    is ever broken.
 *   guarantees       A CREATE request only (null on an UPDATE): a digest of the
 *                    sorted ids of its live GUARANTEE documents as the page
 *                    rendered them. They are attachments, not columns, and the
 *                    salesman can still Remove one while the request is SUBMITTED,
 *                    which changes neither the cycle nor the row — so a decision
 *                    made on a page showing two could land on a request with one.
 *                    The claim cannot compare them; assertGuaranteesAsViewed
 *                    re-reads them inside the decision transaction instead.
 *
 * Not bound: live photo slots of an UPDATE's customer (EL-04 re-checks those at
 * approval), and the CREATE drafts' photos (finalize re-checks those).
 *
 * It is not signed. It is the reviewer's own statement of what they looked at;
 * a hand-made token that matches the row is exactly what reloading the page
 * gives, and the authorization gate runs before it is compared.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ConflictError, ValidationError } from './errors';

export const STALE_VIEW_CODE = 'STALE_VIEW';
export const STALE_VIEW_MESSAGE =
  'This request changed since you opened it. Reload the page and review it again.';
/** No token, or not one this build wrote: a page rendered before the change, or a hand-made call. */
export const MISSING_TOKEN_MESSAGE =
  'This page is out of date. Reload it and review the request again.';

/** What the reviewer was shown, as the claim compares it. */
export type DecisionView = {
  cycle: number;
  stepIndex: number;
  stageEnteredAt: Date | null;
  /** OMR with three decimals, exactly as the approval screens print it. */
  creditLimit: string | null;
  paymentTermDays: number | null;
  /** CREATE: guaranteeDigest of the live GUARANTEE ids the page rendered. UPDATE: null. */
  guarantees: string | null;
};

/** The columns of a CustomerEdit row the token is made from. */
export type DecisionRow = {
  /** EditProcess: only a CREATE request carries guarantee documents. */
  process: string;
  cycle: number;
  currentStepIndex: number;
  stageEnteredAt: Date | null;
  /** Prisma.Decimal on a real row; a number is accepted too. Both have toFixed. */
  requestedCreditLimit: { toFixed(dp: number): string } | null;
  requestedPaymentTermDays: number | null;
};

/**
 * The live guarantee documents of a request, as one value: order-free (sorted
 * here, so a page and the server need not agree on an ORDER BY), and short
 * enough for a token whatever the count.
 */
export function guaranteeDigest(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

/**
 * The requested credit limit as the approval screens show it, and as the token
 * carries it: one formatter for both, so what is bound is what was printed.
 * Decimal(14,3) never needs an exponent, and toFixed never uses one for it.
 */
export function formatRequestedLimit(v: { toFixed(dp: number): string } | null): string | null {
  return v == null ? null : v.toFixed(3);
}

const isCreate = (row: Pick<DecisionRow, 'process'>) => row.process === 'CREATE';

/**
 * The view a page shows: the row, and for a CREATE request the ids of the live
 * guarantee documents it rendered (ignored for an UPDATE, which has none).
 */
export function decisionView(row: DecisionRow, guaranteeIds: readonly string[]): DecisionView {
  return {
    cycle: row.cycle,
    stepIndex: row.currentStepIndex,
    stageEnteredAt: row.stageEnteredAt,
    creditLimit: formatRequestedLimit(row.requestedCreditLimit),
    paymentTermDays: row.requestedPaymentTermDays,
    guarantees: isCreate(row) ? guaranteeDigest(guaranteeIds) : null,
  };
}

export function serializeDecisionToken(v: DecisionView): string {
  return JSON.stringify({
    // 2: the guarantees were added. A page rendered before that has no way to
    // state them, so its token is refused as out of date and the page reloaded.
    v: 2,
    cycle: v.cycle,
    step: v.stepIndex,
    // Milliseconds: timestamp(3) and a JS Date agree exactly; a string would not.
    stage: v.stageEnteredAt ? v.stageEnteredAt.getTime() : null,
    limit: v.creditLimit,
    days: v.paymentTermDays,
    g: v.guarantees,
  });
}

/** The token a page renders for the row it is showing and the guarantees it rendered. */
export function decisionTokenFor(row: DecisionRow, guaranteeIds: readonly string[]): string {
  return serializeDecisionToken(decisionView(row, guaranteeIds));
}

const int = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);
// Decimal(14,3): up to eleven integer digits, and always three decimals from toFixed(3).
const LIMIT = /^-?\d{1,11}\.\d{3}$/;
// guaranteeDigest: SHA-256, lower-case hex.
const DIGEST = /^[0-9a-f]{64}$/;

/** The view a token states, or null for anything this module did not write. */
export function parseDecisionToken(raw: unknown): DecisionView | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const t = o as Record<string, unknown>;
  if (t.v !== 2 || !int(t.cycle) || !int(t.step)) return null;
  if (t.stage !== null && !int(t.stage)) return null;
  if (t.limit !== null && !(typeof t.limit === 'string' && LIMIT.test(t.limit))) return null;
  if (t.days !== null && !int(t.days)) return null;
  if (t.g !== null && !(typeof t.g === 'string' && DIGEST.test(t.g))) return null;
  const stage = t.stage === null ? null : new Date(t.stage as number);
  // A safe integer can still lie outside the Date range; an Invalid Date in a
  // Prisma WHERE is a thrown error, not a refusal.
  if (stage && Number.isNaN(stage.getTime())) return null;
  return {
    cycle: t.cycle,
    stepIndex: t.step,
    stageEnteredAt: stage,
    creditLimit: t.limit as string | null,
    paymentTermDays: t.days as number | null,
    guarantees: t.g as string | null,
  };
}

/** The parts of two views the request row itself carries. */
function sameColumns(a: DecisionView, b: DecisionView): boolean {
  return (
    a.cycle === b.cycle &&
    a.stepIndex === b.stepIndex &&
    (a.stageEnteredAt?.getTime() ?? null) === (b.stageEnteredAt?.getTime() ?? null) &&
    a.creditLimit === b.creditLimit &&
    a.paymentTermDays === b.paymentTermDays
  );
}

export function sameDecisionView(a: DecisionView, b: DecisionView): boolean {
  return sameColumns(a, b) && a.guarantees === b.guarantees;
}

/** Every decision entry point reads its token through this: none means reload. */
export function readDecisionToken(formData: FormData): DecisionView {
  const view = parseDecisionToken(formData.get('decisionToken'));
  if (!view) throw new ValidationError({ decisionToken: MISSING_TOKEN_MESSAGE }, MISSING_TOKEN_MESSAGE);
  return view;
}

/** A token states guarantees exactly when the request is a CREATE. */
const guaranteesStatedRight = (expected: DecisionView, row: Pick<DecisionRow, 'process'>) =>
  (expected.guarantees !== null) === isCreate(row);

/**
 * Refuse a decision made on a view of the request that is no longer current.
 * Call it AFTER the authorization gate: before it, a caller with no right to the
 * request could tell STALE_VIEW from FORBIDDEN and so test guesses of its cycle,
 * step and requested credit figures one call at a time.
 *
 * This compares the row. The guarantees are compared by assertGuaranteesAsViewed,
 * inside the decision transaction; here only their presence is: a CREATE token
 * that states none, or an UPDATE token that states some, is refused now.
 */
export function assertDecisionView(expected: DecisionView, row: DecisionRow): void {
  if (!sameColumns(expected, decisionView(row, [])) || !guaranteesStatedRight(expected, row)) {
    throw new ConflictError(STALE_VIEW_CODE, STALE_VIEW_MESSAGE);
  }
}

/**
 * Refuse a decision on a CREATE request whose live guarantee documents are not
 * the ones the reviewer's page rendered. Nothing to read for an UPDATE.
 *
 * Call it inside the decision transaction, straight after the claim. There, the
 * claim holds the request's row lock, so no other decision on this request can
 * be reading these rows at the same time; and FOR SHARE locks the live guarantee
 * rows until the transaction ends. Remove soft-deletes one with an UPDATE, which
 * needs that row's lock: a Remove that committed first is seen here, one still
 * in flight is waited for and then seen (the row no longer matches), and one
 * that starts later waits until this decision has committed. So the decision
 * lands on exactly the guarantees it was made on, or on nothing. The request row
 * first, then its attachments: the order finalize (binding these same rows) and
 * the salesman's resubmit already take. A refusal throws, and the transaction —
 * the claim with it — rolls back.
 */
export async function assertGuaranteesAsViewed(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  edit: { id: string; process: string },
  expected: DecisionView
): Promise<void> {
  if (!guaranteesStatedRight(expected, edit)) {
    throw new ConflictError(STALE_VIEW_CODE, STALE_VIEW_MESSAGE);
  }
  if (!isCreate(edit)) return;
  const live = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "Attachment" WHERE "editId" = ${edit.id} AND "kind" = 'GUARANTEE' AND "deletedAt" IS NULL FOR SHARE`;
  if (guaranteeDigest(live.map((r) => r.id)) !== expected.guarantees) {
    throw new ConflictError(STALE_VIEW_CODE, STALE_VIEW_MESSAGE);
  }
}
