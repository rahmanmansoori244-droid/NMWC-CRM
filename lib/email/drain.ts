/**
 * F1 (2026-10-05): one run of the e-mail outbox drain. Called only by
 * app/api/cron/email-drain/route.ts (tests/unit/email-structure-guard.test.ts):
 * never from a request path and never inside a transaction, so nothing is
 * e-mailed about a change that rolled back, was replayed, or lost a race — the
 * rows it reads exist only because their change committed.
 *
 * Takes its store, transport and clock as parameters, so the whole run is tested
 * with an in-memory store and a fake transport (tests/unit/email-drain.test.ts)
 * and against real Postgres (tests/integration/email-drain.test.ts).
 *
 * A run: mark rows past the maximum age and rows out of attempts; claim a batch
 * under a lease; read the recipients and the requests as they are now; plan
 * (lib/email/eligibility.ts); mark the refused rows; release the held-back ones;
 * then send one digest per recipient until the budget is spent. On a sent digest
 * its rows are SENT with one send time. A permanent refusal marks them FAILED. A
 * transient one leaves them leased for a later run. A refused login stops the run
 * and hands every unsent row back.
 *
 * It returns counts only. The route's JSON is CronHeartbeat.lastDetail, kept
 * until the next run, and served to the monitor: no address, no subject, no
 * error text.
 */
import { EMAIL_DELIVERY, EMAIL_KINDS, EMAIL_ROLES, type EmailDeliveryPolicy } from '../notify-policy';
import type { SendConfig } from './config';
import { renderDigest } from './digest';
import { planRun, type SkipStatus } from './eligibility';
import type { OutboxStore } from './outbox-store';
import type { EmailErrorLabel, MailTransport, SendResult } from './transport';

export type DrainResult = {
  claimed: number;
  sent: number;
  skipped: number;
  skippedBy: Partial<Record<SkipStatus, number>>;
  failed: number;
  deferred: number;
  capped: boolean;
  staleMarked: number;
  exhaustedMarked: number;
  budgetStopped: boolean;
  sendErrors: number;
  authErrors: number;
  /** The kinds of send failure seen, by constrained label. */
  errorLabels: Partial<Record<EmailErrorLabel, number>>;
};

/** Rows marked stale or exhausted per run: bounded, so a long-off switch catches up over runs. */
const HOUSEKEEPING_LIMIT = 2_000;

/**
 * A send that has not answered by the run's hard stop is given up on: a transient
 * failure, so its rows stay leased and a later run retries them. (If the server
 * did accept it, that retry is the rare at-least-once duplicate.)
 */
async function withDeadline(send: Promise<SendResult>, ms: number): Promise<SendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, label: 'DEADLINE', kind: 'transient' }), Math.max(0, ms));
  });
  try {
    return await Promise.race([send, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runEmailDrain(deps: {
  store: OutboxStore;
  transport: MailTransport;
  config: Pick<SendConfig, 'linkOrigin' | 'redirectTo' | 'subjectPrefix'>;
  now?: () => Date;
  policy?: EmailDeliveryPolicy;
}): Promise<DrainResult> {
  const now = deps.now ?? (() => new Date());
  const policy = deps.policy ?? EMAIL_DELIVERY;
  const { store, transport, config } = deps;
  const started = now();
  const result: DrainResult = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    skippedBy: {},
    failed: 0,
    deferred: 0,
    capped: false,
    staleMarked: 0,
    exhaustedMarked: 0,
    budgetStopped: false,
    sendErrors: 0,
    authErrors: 0,
    errorLabels: {},
  };

  try {
    const cutoff = new Date(started.getTime() - policy.maxAgeMs);
    result.staleMarked = await store.markStale(cutoff, started, HOUSEKEEPING_LIMIT);
    result.exhaustedMarked = await store.markExhausted(policy.maxAttempts, started, HOUSEKEEPING_LIMIT);
    const never = await store.markIneligible({
      kinds: EMAIL_KINDS,
      roles: EMAIL_ROLES,
      now: started,
      limit: HOUSEKEEPING_LIMIT,
    });
    if (never.kind > 0) result.skippedBy.SKIPPED_KIND = never.kind;
    if (never.role > 0) result.skippedBy.SKIPPED_ROLE = never.role;
    result.skipped += never.kind + never.role;

    const rows = await store.claim({
      now: started,
      cutoff,
      leaseUntil: new Date(started.getTime() + policy.leaseMs),
      limit: policy.claimLimit,
      maxAttempts: policy.maxAttempts,
    });
    result.claimed = rows.length;
    if (rows.length === 0) return result;

    const userIds = [...new Set(rows.map((r) => r.userId))];
    const editIds = [...new Set(rows.map((r) => r.editId).filter((id): id is string => !!id))];
    const [recipients, requests, recentlySent, sentLast24h] = await Promise.all([
      store.loadRecipients(userIds),
      store.loadRequests(editIds),
      store.recentlySent(userIds, new Date(started.getTime() - policy.recipientGapMs)),
      store.sentDigestsSince(new Date(started.getTime() - 24 * 60 * 60_000)),
    ]);
    const plan = planRun({
      rows,
      recipients: new Map(recipients.map((r) => [r.id, r])),
      edits: new Map(requests.map((e) => [e.id, e])),
      now: started,
      recentlySent,
      sentLast24h,
      policy,
    });

    const byStatus = new Map<SkipStatus, string[]>();
    for (const s of plan.skips) byStatus.set(s.status, [...(byStatus.get(s.status) ?? []), s.id]);
    await Promise.all([
      ...[...byStatus].map(([status, ids]) => store.finish(ids, status, started)),
      store.release(plan.deferred),
    ]);
    for (const [status, ids] of byStatus) {
      result.skippedBy[status] = (result.skippedBy[status] ?? 0) + ids.length;
      result.skipped += ids.length;
    }
    result.deferred = plan.deferred.length;
    result.capped = plan.capped;

    for (let i = 0; i < plan.digests.length; i += 1) {
      const digest = plan.digests[i]!;
      const rest = () => plan.digests.slice(i).flatMap((d) => d.rowIds);
      if (now().getTime() - started.getTime() > policy.sendBudgetMs) {
        // Too close to the function limit to start another SMTP exchange.
        await store.release(rest());
        result.deferred += rest().length;
        result.budgetStopped = true;
        break;
      }
      const mail = renderDigest({
        items: digest.items,
        role: digest.role,
        linkOrigin: config.linkOrigin,
        subjectPrefix: config.subjectPrefix,
        maxItems: policy.maxItemsPerDigest,
      });
      const outcome = await withDeadline(
        transport.send({ to: config.redirectTo ?? digest.address, ...mail }),
        started.getTime() + policy.hardStopMs - now().getTime()
      );
      if (outcome.ok) {
        await store.finish(digest.rowIds, 'SENT', now());
        result.sent += 1;
        continue;
      }
      result.errorLabels[outcome.label] = (result.errorLabels[outcome.label] ?? 0) + 1;
      if (outcome.kind === 'auth') {
        // Every later send would be refused the same way. Hand everything back:
        // when the password is fixed, a later run sends them inside the max age.
        result.authErrors += 1;
        await store.release(rest());
        result.deferred += rest().length;
        break;
      }
      result.sendErrors += 1;
      if (outcome.kind === 'permanent') {
        await store.finish(digest.rowIds, 'FAILED', now());
        result.failed += digest.rowIds.length;
      }
      // transient: the rows stay leased; a run after the lease lapses retries them.
      if (outcome.label === 'DEADLINE') {
        // The run is out of time: the rest goes back for the next run.
        const after = plan.digests.slice(i + 1).flatMap((d) => d.rowIds);
        await store.release(after);
        result.deferred += after.length;
        result.budgetStopped = true;
        break;
      }
    }
    return result;
  } finally {
    transport.close();
  }
}
