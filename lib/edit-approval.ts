/**
 * Auditor recheck 2026-09-27, phase 2 (F06): the final approval of a customer
 * UPDATE judges each stored change against the customer as it is NOW.
 *
 * A request stores, per field, the value it was made against (`before`) and the
 * new one (`after`). Between submit and approval an import, a Manager's direct
 * write or another approved request can change the same field; the approval
 * used to write `after` regardless, putting an older value back over the newer
 * one without a word. Now, under the customer's row lock (services/edits.ts
 * approveEditCore), through lib/edit-values.ts classifyChanges:
 *   - a change whose field still holds `before` is applied;
 *   - one whose field already holds `after` is left alone (CONVERGED);
 *   - one whose field holds anything else refuses the whole approval
 *     (STALE_BEFORE): nothing is written, and Reject sends it back.
 *
 * The approval page lists the same stale fields before anyone clicks (ruling 8)
 * through the same planApproval — after the same QA-013 lock re-check — so the
 * page cannot warn about a field the server would drop, or miss one it would
 * refuse. The server's refusal stays the authority: the data can move between
 * the page and the click.
 */
import { EditProcess, EditTarget, Role, type Customer, type PrismaClient } from '@prisma/client';
import {
  BRANCH_EDIT_SELECT,
  CUSTOMER_EDIT_SELECT,
  classifyChanges,
  fieldLabel,
  liveSnapshotOf,
  type ClassifiedChanges,
} from './edit-values';
import { withoutSubmitterLockedFields } from './edit-scope';
import type { FieldChange } from './gps-manual';

/** CustomerEdit.fieldChanges as stored — unvalidated JSON, so read defensively. */
export function storedFieldChanges(raw: unknown): FieldChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is FieldChange =>
      typeof c === 'object' && c !== null && typeof (c as { field?: unknown }).field === 'string'
  );
}

export type ApprovalPlan = {
  /** The stored changes the approval acts on: all of them, less QA-013's locked fields. */
  considered: FieldChange[];
  /** `considered` against the live customer: apply, converged, stale, dropped branches. */
  classified: ClassifiedChanges<FieldChange>;
};

/**
 * What approving this request now would do. `customer` is the live customer row
 * (its edit fields and payment terms), `liveBranches` its live branches
 * (deletedAt null); `submitterRole` is the submitter's role NOW, as QA-013 has
 * always read it.
 */
export function planApproval(input: {
  fieldChanges: unknown;
  submitterRole: Role | null | undefined;
  customer: Pick<Customer, 'paymentTerms'>;
  liveBranches: ReadonlyArray<{ readonly id: string }>;
}): ApprovalPlan {
  const considered = withoutSubmitterLockedFields(
    storedFieldChanges(input.fieldChanges),
    input.submitterRole,
    input.customer
  );
  return {
    considered,
    classified: classifyChanges(considered, liveSnapshotOf(input.customer, input.liveBranches)),
  };
}

/** The stale fields as a person reads them, each label once, in the request's order. */
export function staleFieldLabels(stale: ReadonlyArray<{ field: string }>): string[] {
  return [...new Set(stale.map((s) => fieldLabel(s.field)))];
}

const LABELS_IN_MESSAGE = 3;

/** STALE_BEFORE: labels only, never values — the approver may not see every branch. */
export function staleBeforeMessage(labels: readonly string[]): string {
  const shown = labels
    .slice(0, LABELS_IN_MESSAGE)
    .map((l) => l.toLowerCase())
    .join(', ');
  const more = labels.length > LABELS_IN_MESSAGE ? ' …' : '';
  return `Changed on the customer after this request was sent: ${shown}${more}. Approving would overwrite the newer values, so nothing was approved. Reject it so the salesman can check and send it again.`;
}

/** F16 at approval: the sub-channel the request leaves on the customer no longer fits or is retired. */
export const CHANNEL_PAIR_INVALID_MESSAGE =
  "The sub-channel in this request no longer fits the customer's channel, or is no longer offered. Nothing was approved. Reject it so the salesman can pick again.";

/**
 * Ruling 2: a pending enrichment request sent by the form before patch v2 carried
 * every field the form had loaded, not only what the salesman changed — so a row
 * of it may put back a value that was already newer when he sent it, which
 * STALE_BEFORE cannot see (it compares with `before`, and that was recorded
 * correctly). Every salesman's enrichment request this build sends stores its
 * gated branches (CustomerEdit.submitGate), so one without them came from the
 * old form, and the approval page says to check each row.
 */
export function sentByPreviousForm(
  edit: { process: EditProcess; target: EditTarget; isReactivation: boolean; submitGate: unknown },
  submitterRole: Role | null | undefined
): boolean {
  return (
    edit.process === EditProcess.UPDATE &&
    edit.target === EditTarget.CUSTOMER &&
    !edit.isReactivation &&
    (edit.submitGate === null || edit.submitGate === undefined) &&
    submitterRole === Role.SALESMAN
  );
}

/**
 * The approval page's list of stale fields (ruling 8): the live customer and the
 * submitter's current role read the way approveEditCore reads them, then
 * planApproval. Empty for a customer that is gone — the approval answers that
 * with its own refusal.
 */
export async function staleLabelsForPendingEdit(
  db: Pick<PrismaClient, 'customer' | 'user'>,
  edit: { customerId: string | null; submittedById: string; fieldChanges: unknown }
): Promise<string[]> {
  if (!edit.customerId) return [];
  const [customer, submitter] = await Promise.all([
    db.customer.findUnique({
      where: { id: edit.customerId },
      select: {
        ...CUSTOMER_EDIT_SELECT,
        deletedAt: true,
        branches: { where: { deletedAt: null }, select: { id: true, ...BRANCH_EDIT_SELECT } },
      },
    }),
    db.user.findUnique({ where: { id: edit.submittedById }, select: { role: true } }),
  ]);
  if (!customer || customer.deletedAt) return [];
  const { classified } = planApproval({
    fieldChanges: edit.fieldChanges,
    submitterRole: submitter?.role,
    customer,
    liveBranches: customer.branches,
  });
  return staleFieldLabels(classified.stale);
}
