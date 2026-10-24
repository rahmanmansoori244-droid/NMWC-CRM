/**
 * Gap 19 (data audit 2026-10-10, lossless paths): a request's evidence in the
 * append-only ledger.
 *
 * What a request asked for, who sent it, when, and what it was gated on lived only
 * in CustomerEdit, a table the application can still update. The evidence guard
 * (migration 20261014100000) now freezes those columns once a request is sent;
 * this is the second copy, in AuditLog, written in the same transaction as the
 * request: a CustomerEdit CREATE row for every update, close-shop and
 * reactivation submit. It holds the request's own values, as an approval's
 * APPROVE row always has (fieldChanges carries full values).
 *
 * PURE: tested on its own (tests/unit/request-evidence.test.ts).
 */
import type { Prisma } from '@prisma/client';

type SentRequest = {
  process: string;
  target: string;
  state: string;
  customerId: string | null;
  branchId: string | null;
  isReactivation: boolean;
  fieldChanges: Prisma.JsonValue;
  attachmentChanges: Prisma.JsonValue;
  submitGate?: Prisma.JsonValue | null;
  submittedAt: Date | null;
  approvalChain?: Prisma.JsonValue | null;
  pendingRole?: string | null;
  cycle: number;
  submissionId?: string | null;
  decisionReason?: string | null;
  /** Gap 18: where it was raised (lib/scope-at-submit.ts). */
  routeIdAtSubmit?: string | null;
  regionIdsAtSubmit?: string[] | null;
};

/** The `after` of a sent request's CREATE audit row: the request as it was sent. */
export function sentRequestAudit(e: SentRequest): Prisma.InputJsonObject {
  return {
    process: e.process,
    target: e.target,
    state: e.state,
    customerId: e.customerId,
    branchId: e.branchId,
    isReactivation: e.isReactivation,
    fieldChanges: (e.fieldChanges ?? []) as Prisma.InputJsonValue,
    attachmentChanges: (e.attachmentChanges ?? []) as Prisma.InputJsonValue,
    submitGate: (e.submitGate ?? null) as Prisma.InputJsonValue,
    submittedAt: e.submittedAt ? e.submittedAt.toISOString() : null,
    approvalChain: (e.approvalChain ?? null) as Prisma.InputJsonValue,
    pendingRole: e.pendingRole ?? null,
    cycle: e.cycle,
    submissionId: e.submissionId ?? null,
    // Gap 18: where it was raised, sealed with the rest of what was sent.
    routeIdAtSubmit: e.routeIdAtSubmit ?? null,
    regionIdsAtSubmit: [...(e.regionIdsAtSubmit ?? [])],
    // A close or reactivation request's reason is the salesman's, typed with it.
    ...(e.decisionReason ? { requestReason: e.decisionReason } : {}),
  } as Prisma.InputJsonObject;
}

/** Gap 19: what an approval actually wrote, beside what the request asked for. */
export function approvalOutcome(input: {
  requested: ReadonlyArray<{ field: string }>;
  considered: ReadonlyArray<{ field: string }>;
  apply: ReadonlyArray<{ field: string }>;
  converged: readonly string[];
  gateBranchIds: readonly string[] | null;
}): { applied: string[]; alreadyLive: string[]; lockedOut: string[]; gateBranchIds: string[] | null } {
  const considered = new Set(input.considered.map((c) => c.field));
  return {
    applied: input.apply.map((c) => c.field),
    alreadyLive: [...input.converged],
    lockedOut: input.requested.map((c) => c.field).filter((f) => !considered.has(f)),
    gateBranchIds: input.gateBranchIds ? [...input.gateBranchIds] : null,
  };
}

/**
 * Gap 20: what a reactivation's evidence was checked against at request time —
 * the branch's last status change (its closure) and the photo's capture time —
 * stored in the request's attachmentChanges entry, which the evidence guard
 * then freezes.
 */
export function evidenceEntry(att: { id: string; kind: string; capturedAt: Date }, branchLastStatusChangeAt: Date | null) {
  return {
    kind: att.kind,
    attachmentId: att.id,
    action: 'EVIDENCE',
    evidenceCapturedAt: att.capturedAt.toISOString(),
    branchLastStatusChangeAt: branchLastStatusChangeAt ? branchLastStatusChangeAt.toISOString() : null,
  };
}

/** The evidence entry's request-time facts, read back defensively (older requests have none). */
export function readEvidenceEntry(attachmentChanges: unknown): {
  attachmentId: string | null;
  evidenceCapturedAt: string | null;
  branchLastStatusChangeAt: string | null | undefined;
} {
  const entries = Array.isArray(attachmentChanges) ? attachmentChanges : [];
  const e = entries.find(
    (x) => !!x && typeof x === 'object' && (x as { action?: unknown }).action === 'EVIDENCE'
  ) as Record<string, unknown> | undefined;
  if (!e) return { attachmentId: null, evidenceCapturedAt: null, branchLastStatusChangeAt: undefined };
  return {
    attachmentId: typeof e.attachmentId === 'string' ? e.attachmentId : null,
    evidenceCapturedAt: typeof e.evidenceCapturedAt === 'string' ? e.evidenceCapturedAt : null,
    // undefined: written before gap 20 (not recorded); null: recorded as none.
    branchLastStatusChangeAt:
      'branchLastStatusChangeAt' in e
        ? typeof e.branchLastStatusChangeAt === 'string'
          ? e.branchLastStatusChangeAt
          : null
        : undefined,
  };
}

/**
 * Gap 20: from a shop's dated history, newest first, when its current CLOSED
 * stretch began — the row that moved it to CLOSED. Null when the stretch begins
 * on the history's first page (BASELINE: closed before history began, closure
 * time unknown) or the shop is not closed.
 */
export function closureFromHistory(
  rowsNewestFirst: ReadonlyArray<{ status: string; changeKind: string; validFrom: Date }>
): Date | null {
  let start: { changeKind: string; validFrom: Date } | null = null;
  for (const r of rowsNewestFirst) {
    if (r.changeKind === 'DELETE') continue;
    if (r.status !== 'CLOSED') break;
    start = r;
  }
  if (!start || start.changeKind === 'BASELINE') return null;
  return start.validFrom;
}
