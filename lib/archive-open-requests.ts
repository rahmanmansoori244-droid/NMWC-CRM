/**
 * Gap 37 (data audit 2026-10-10): what happens to a customer's open requests
 * when it is archived (services/customers.ts archiveCustomerCore).
 *
 *   - SUBMITTED (in review): still blocks the archive, as before — a reviewer
 *     must decide it first. The check runs under the customer's row lock, and
 *     every transaction that writes a SUBMITTED request on a customer takes the
 *     same lock and re-reads deletedAt first (services/edits.ts, the UPDATE
 *     submit; services/reactivations.ts, close and reactivation), so a request
 *     can no longer land on a customer archived a moment earlier.
 *   - DRAFT (his unsent draft): closed inside the archive transaction, the way an
 *     account change withdraws one (lib/stranded-creates.ts
 *     withdrawWithAccountChange): REJECTED, decisionCategory 'withdrawn', the
 *     decision fields naming who archived and why, the clock stopped, and one
 *     UPDATE audit row each. It could otherwise never be sent: the customer is
 *     gone from every form.
 *   - NEEDS_CORRECTION (sent back to him): left as it is. It is the record of the
 *     send-back (lib/returned-work.ts, A1.7), and returned work already leaves
 *     archived customers out. Listed on the archive's SOFT_DELETE row.
 *
 * Requests left open on customers archived before this (prod SQL 10 counts them)
 * are not touched here: closing them is a one-off audited script, an open owner
 * question (04-PENDING-WORK).
 *
 * Server only: it writes through the caller's transaction, under its lock.
 */
import { EditState, type Prisma } from '@prisma/client';
import { writeAudit, type AuditEnvelope } from './audit';

/** At most this many ids per list on the SOFT_DELETE row; the counts are whole. */
export const ARCHIVE_REQUEST_LIST_CAP = 200;

/** What the salesman reads on a draft the archive closed. */
export const ARCHIVED_DRAFT_REASON = 'Closed: the customer was archived, so this draft can no longer be sent.';

export type OpenRequestsRecord = {
  closedDrafts: string[];
  closedDraftCount: number;
  sentBack: string[];
  sentBackCount: number;
};

/** The SOFT_DELETE row's openRequests: sorted, each id once, each list capped, with whole counts. */
export function openRequestsRecord(closedDrafts: readonly string[], sentBack: readonly string[], cap = ARCHIVE_REQUEST_LIST_CAP): OpenRequestsRecord {
  const tidy = (ids: readonly string[]) => [...new Set(ids)].sort();
  const a = tidy(closedDrafts);
  const b = tidy(sentBack).filter((id) => !a.includes(id));
  return { closedDrafts: a.slice(0, cap), closedDraftCount: a.length, sentBack: b.slice(0, cap), sentBackCount: b.length };
}

/**
 * Close the customer's drafts and list its sent-back requests, inside the
 * archive's transaction and after its claim. Each draft is claimed on its state
 * and cycle as read; one that moved meanwhile is left (none can: a draft save
 * takes the same customer lock).
 */
export async function closeOpenRequestsOnArchive(
  tx: Prisma.TransactionClient,
  env: AuditEnvelope,
  p: { customerId: string; byId: string; at: Date }
): Promise<OpenRequestsRecord> {
  const open = await tx.customerEdit.findMany({
    where: { customerId: p.customerId, state: { in: [EditState.DRAFT, EditState.NEEDS_CORRECTION] } },
    select: { id: true, state: true, cycle: true, process: true },
    orderBy: { id: 'asc' },
  });
  const closed: string[] = [];
  for (const e of open.filter((x) => x.state === EditState.DRAFT)) {
    const claim = await tx.customerEdit.updateMany({
      where: { id: e.id, customerId: p.customerId, state: EditState.DRAFT, cycle: e.cycle },
      data: {
        state: EditState.REJECTED,
        pendingRole: null,
        slaDueAt: null,
        slaBreachedAt: null,
        lastEscalatedAt: null,
        escalationLevel: 0,
        reviewedById: p.byId,
        reviewedAt: p.at,
        decisionReason: ARCHIVED_DRAFT_REASON,
        decisionCategory: 'withdrawn',
      },
    });
    if (claim.count !== 1) continue;
    closed.push(e.id);
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'CustomerEdit',
      entityId: e.id,
      // The archive's own typed reason stays on its SOFT_DELETE row only.
      reason: 'closed: the customer was archived',
      after: {
        state: EditState.REJECTED,
        from: EditState.DRAFT,
        closedBy: 'archive',
        process: e.process,
        cycle: e.cycle,
        customerId: p.customerId,
      } as unknown as Prisma.InputJsonValue,
    });
  }
  const sentBack = open.filter((x) => x.state === EditState.NEEDS_CORRECTION).map((x) => x.id);
  return openRequestsRecord(closed, sentBack);
}
