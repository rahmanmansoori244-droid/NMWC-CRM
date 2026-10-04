/**
 * F1 (2026-10-05): the e-mail outbox is the Notification table — every row is
 * written in the transaction of the change that caused it, so a committed row is
 * a change that happened. This module is the drain's only access to it.
 *
 * It never selects Notification.title or .body: the digest is built from kind
 * and editId, so a customer's name has no path into an e-mail. Every statement
 * autocommits on its own; nothing here runs inside a transaction that also
 * sends, and no e-mail is ever sent inside a transaction.
 *
 * Claiming is a lease (FOR UPDATE SKIP LOCKED, then emailLeaseUntil = now +
 * 5 minutes, longer than the 60 s function limit): two overlapping runs — a
 * Vercel retry, a manual bearer call — claim disjoint rows, and a run killed
 * mid-send leaves its rows to a later run once the lease lapses (at-least-once:
 * a duplicate is possible only if a run dies between a send and its mark).
 *
 * `scope` limits every statement to some users' rows. Production passes none;
 * tests/integration/email-drain.test.ts passes its synthetic users, so a run of
 * the suite against a shared database never touches a row it did not create.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { EmailStatus, OutboxRow, Recipient, RequestNow, SkipStatus } from './eligibility';

export interface OutboxStore {
  /** Rows past the maximum age, never claimed again: SKIPPED_STALE. Bounded per call. */
  markStale(cutoff: Date, now: Date, limit: number): Promise<number>;
  /** Rows that reached the attempt cap without a send: FAILED. */
  markExhausted(maxAttempts: number, now: Date, limit: number): Promise<number>;
  claim(args: { now: Date; cutoff: Date; leaseUntil: Date; limit: number; maxAttempts: number }): Promise<OutboxRow[]>;
  loadRecipients(userIds: string[]): Promise<Recipient[]>;
  loadRequests(editIds: string[]): Promise<RequestNow[]>;
  /** Of these users, who was sent a digest at or after `since`. */
  recentlySent(userIds: string[], since: Date): Promise<Set<string>>;
  /** Digests sent at or after `since` (one per recipient and send time). */
  sentDigestsSince(since: Date): Promise<number>;
  finish(ids: string[], status: Exclude<EmailStatus, 'PRE_FEATURE'>, at: Date): Promise<void>;
  /** Hand claimed rows back unsent; the claim does not count as an attempt. */
  release(ids: string[]): Promise<void>;
}

export function prismaOutboxStore(db: PrismaClient, scope?: { userIds: string[] }): OutboxStore {
  const scoped = scope
    ? Prisma.sql`AND n."userId" IN (${Prisma.join(scope.userIds.length ? scope.userIds : ['__none__'])})`
    : Prisma.empty;
  const userWhere = scope ? { userId: { in: scope.userIds } } : {};

  return {
    async markStale(cutoff, now, limit) {
      return db.$executeRaw`
        UPDATE "Notification" SET "emailStatus" = 'SKIPPED_STALE', "emailedAt" = ${now}, "emailLeaseUntil" = NULL
        WHERE id IN (
          SELECT n.id FROM "Notification" n
          WHERE n."emailedAt" IS NULL AND n."createdAt" < ${cutoff}
            AND (n."emailLeaseUntil" IS NULL OR n."emailLeaseUntil" < ${now}) ${scoped}
          LIMIT ${limit}
        )`;
    },

    async markExhausted(maxAttempts, now, limit) {
      return db.$executeRaw`
        UPDATE "Notification" SET "emailStatus" = 'FAILED', "emailedAt" = ${now}, "emailLeaseUntil" = NULL
        WHERE id IN (
          SELECT n.id FROM "Notification" n
          WHERE n."emailedAt" IS NULL AND n."emailAttempts" >= ${maxAttempts}
            AND (n."emailLeaseUntil" IS NULL OR n."emailLeaseUntil" < ${now}) ${scoped}
          LIMIT ${limit}
        )`;
    },

    async claim({ now, cutoff, leaseUntil, limit, maxAttempts }) {
      // One autocommitted statement: pick, lock (skipping rows another run holds),
      // lease and count the attempt. The (emailedAt, createdAt) index serves it.
      const rows = await db.$queryRaw<Array<OutboxRow>>`
        WITH picked AS (
          SELECT n.id FROM "Notification" n
          WHERE n."emailedAt" IS NULL
            AND n."createdAt" >= ${cutoff}
            AND (n."emailLeaseUntil" IS NULL OR n."emailLeaseUntil" < ${now})
            AND n."emailAttempts" < ${maxAttempts} ${scoped}
          ORDER BY n."createdAt"
          LIMIT ${limit}
          FOR UPDATE OF n SKIP LOCKED
        )
        UPDATE "Notification" n
        SET "emailLeaseUntil" = ${leaseUntil}, "emailAttempts" = n."emailAttempts" + 1
        FROM picked
        WHERE n.id = picked.id
        RETURNING n.id, n."userId", n.kind::text AS kind, n."editId", n."createdAt", n."readAt"`;
      return rows;
    },

    async loadRecipients(userIds) {
      if (userIds.length === 0) return [];
      return db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true, isActive: true, email: true, username: true },
      });
    },

    async loadRequests(editIds) {
      if (editIds.length === 0) return [];
      const edits = await db.customerEdit.findMany({
        where: { id: { in: editIds } },
        select: {
          id: true,
          state: true,
          process: true,
          target: true,
          isReactivation: true,
          approvalChain: true,
          currentStepIndex: true,
          pendingRole: true,
          cycle: true,
          submittedById: true,
          submittedBy: { select: { supervisorId: true } },
        },
      });
      const steps = await db.editApproval.findMany({
        where: { editId: { in: edits.map((e) => e.id) } },
        select: { editId: true, cycle: true, stepIndex: true, actorId: true },
      });
      return edits.map((e) => ({
        id: e.id,
        state: e.state,
        process: e.process,
        target: e.target,
        isReactivation: e.isReactivation,
        approvalChain: e.approvalChain,
        currentStepIndex: e.currentStepIndex,
        pendingRole: e.pendingRole,
        submittedById: e.submittedById,
        submitterSupervisorId: e.submittedBy.supervisorId,
        otherStepActorIds: steps
          .filter((s) => s.editId === e.id && s.cycle === e.cycle && s.stepIndex !== e.currentStepIndex)
          .map((s) => s.actorId),
      }));
    },

    async recentlySent(userIds, since) {
      if (userIds.length === 0) return new Set();
      const rows = await db.notification.findMany({
        where: { userId: { in: userIds }, emailStatus: 'SENT', emailedAt: { gte: since } },
        select: { userId: true },
        distinct: ['userId'],
      });
      return new Set(rows.map((r) => r.userId));
    },

    async sentDigestsSince(since) {
      const [row] = await db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM (
          SELECT DISTINCT n."userId", n."emailedAt" FROM "Notification" n
          WHERE n."emailStatus" = 'SENT' AND n."emailedAt" >= ${since} ${scoped}
        ) d`;
      return row?.n ?? 0;
    },

    async finish(ids, status, at) {
      if (ids.length === 0) return;
      // Only rows still in the outbox: a row another run finished is left alone.
      await db.notification.updateMany({
        where: { id: { in: ids }, emailedAt: null, ...userWhere },
        data: { emailStatus: status, emailedAt: at, emailLeaseUntil: null },
      });
    },

    async release(ids) {
      if (ids.length === 0) return;
      await db.$executeRaw`
        UPDATE "Notification" n
        SET "emailLeaseUntil" = NULL, "emailAttempts" = GREATEST(n."emailAttempts" - 1, 0)
        WHERE n.id IN (${Prisma.join(ids)}) AND n."emailedAt" IS NULL ${scoped}`;
    },
  };
}

/** The skip statuses as the drain counts them. */
export type SkipCounts = Partial<Record<SkipStatus, number>>;
