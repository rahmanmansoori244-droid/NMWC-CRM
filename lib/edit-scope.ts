/**
 * Auditor recheck 2026-09-27, F05: which branches a salesman's customer edit is
 * gated on — at submit, and again at approval.
 *
 * The mandatory-field gate (services/edits.ts collectMissingMandatory) scanned
 * EVERY live branch of the customer. On a chain split across routes, salesman A
 * could not submit because of a missing GPS point on salesman B's branch — a
 * branch his page does not show him (lib/access.ts filterBranchesByScope) and his
 * submit may not write ('You can only edit branches on your route.'). Neither
 * could ever submit until both had finished, and the approval re-check had the
 * same blind spot.
 *
 * Now the submit gates the branches on the salesman's own route — salesmanBranches,
 * the same function that decides what his page shows — and freezes their ids on
 * the request (CustomerEdit.submitGate = { v: 1, branchIds }). The approval
 * re-checks exactly that set under the gate rule in force at approval
 * (lib/submit-gate.ts, unchanged), so a route handover, or a branch created or
 * imported after submit, cannot change the answer. The branch ids come from the
 * server's own read of his route, never from the client.
 *
 * Pure: no database access. lib/access.ts imports salesmanBranches from here
 * (not the other way round), because lib/access.ts imports the database client.
 */
import { z } from 'zod';
import { Role, type Customer } from '@prisma/client';
import { isFieldLocked } from './permissions';
import { parseFieldPath } from './edit-values';
import type { FieldChange } from './gps-manual';

/**
 * The branches a SALESMAN works: the live ones on his route. What his edit page
 * shows him, what he may write, and what his submit is gated on are all this.
 * No route, no branches. Callers pass live branches (deletedAt null) only.
 */
export function salesmanBranches<B extends { routeId: string }>(
  liveBranches: readonly B[],
  ownedRouteId: string | null | undefined
): B[] {
  if (!ownedRouteId) return [];
  return liveBranches.filter((b) => b.routeId === ownedRouteId);
}

/** CustomerEdit.submitGate as stored. Only the branch set is frozen, not the gate rule. */
export type SubmitGateRecord = { v: 1; branchIds: string[] };

const submitGateSchema = z
  .object({ v: z.literal(1), branchIds: z.array(z.string().min(1)) })
  .strict();

/** The value to store on a salesman's SUBMITTED row: his gated branches' ids, each once. */
export function submitGateRecord(branchIds: readonly string[]): SubmitGateRecord {
  return { v: 1, branchIds: [...new Set(branchIds)] };
}

/** The stored value, read defensively (it is JSON): null when absent or malformed. */
export function parseSubmitGate(raw: unknown): SubmitGateRecord | null {
  const parsed = submitGateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function branchIdsNamedIn(fieldChanges: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(fieldChanges)) return ids;
  for (const c of fieldChanges) {
    const field = (c as { field?: unknown } | null)?.field;
    if (typeof field !== 'string') continue;
    const p = parseFieldPath(field);
    if (p?.scope === 'branch') ids.add(p.branchId);
  }
  return ids;
}

export type ApprovalGate<B> = {
  /**
   * The branches to run the mandatory-field gate on at approval, or null when the
   * request is not gated. The approval passes THIS to collectMissingMandatory —
   * never the customer's whole `.branches` (ruling 6).
   */
  gateBranches: B[] | null;
  /** frozen: the ids stored at submit. fallback: a row without a readable record. */
  source: 'frozen' | 'fallback' | 'none';
  /** submitGate held something that is not a record — the caller logs it (no values). */
  unreadable: boolean;
};

/**
 * The branch set the approval re-checks (EL-04), from the customer's live
 * branches read under its row lock.
 *
 *   - A readable record: the live branches whose id it holds, whatever the
 *     submitter's role or route is now. One archived or moved to another customer
 *     is simply not live here any more; one created after submit is not in it.
 *   - No record, and the submitter is a SALESMAN now (a request submitted before
 *     the record existed): the live branches the request names, plus the live
 *     branches on his current route. Never stricter than the every-branch check
 *     those rows passed at submit.
 *   - An unreadable record: the same fallback, whatever his role now — the row
 *     was written for a salesman's submit, so it is gated rather than waved through.
 *   - Otherwise (a Steward or Manager's row, or a submitter who is no longer a
 *     salesman on a row written before the record): not gated, as before.
 */
export function gateBranchesForApproval<B extends { id: string; routeId: string }>(input: {
  submitGate: unknown;
  liveBranches: readonly B[];
  fieldChanges: unknown;
  submitter: { role: Role | null | undefined; ownedRouteId: string | null | undefined };
}): ApprovalGate<B> {
  const { submitGate, liveBranches, fieldChanges, submitter } = input;
  const record = parseSubmitGate(submitGate);
  if (record) {
    const ids = new Set(record.branchIds);
    return {
      gateBranches: liveBranches.filter((b) => ids.has(b.id)),
      source: 'frozen',
      unreadable: false,
    };
  }
  const unreadable = submitGate !== null && submitGate !== undefined;
  const isSalesman = submitter.role === Role.SALESMAN;
  if (!unreadable && !isSalesman) return { gateBranches: null, source: 'none', unreadable };
  const named = branchIdsNamedIn(fieldChanges);
  const onRoute = new Set(
    salesmanBranches(liveBranches, isSalesman ? submitter.ownedRouteId : null).map((b) => b.id)
  );
  return {
    gateBranches: liveBranches.filter((b) => named.has(b.id) || onRoute.has(b.id)),
    source: 'fallback',
    unreadable,
  };
}

/**
 * QA-013 at approval, shared by approveEditCore and the approval page (ruling 8):
 * a SALESMAN submitter's changes to fields he may not edit on the customer AS IT
 * IS NOW are dropped — legal name always, the CR number once the customer is on
 * CREDIT terms (lib/permissions.ts isFieldLocked). Everything else passes through.
 */
export function withoutSubmitterLockedFields<C extends Pick<FieldChange, 'field'>>(
  changes: readonly C[],
  submitterRole: Role | null | undefined,
  liveCustomer: Pick<Customer, 'paymentTerms'>
): C[] {
  if (submitterRole !== Role.SALESMAN) return [...changes];
  const shape = { id: '', role: Role.SALESMAN, username: '' };
  const locked = new Set(
    (['legalName', 'crNumber'] as const)
      .filter((f) => isFieldLocked(f, shape, liveCustomer))
      .map((f) => `customer.${f}`)
  );
  return changes.filter((c) => !locked.has(c.field));
}
