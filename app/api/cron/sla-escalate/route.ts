/**
 * SLA escalation sweep — Phase 1 SLA/notifications increment.
 *
 * GET handler (deliberately: the OLD system's sla-check cron was POST-only
 * while the scheduler sends GET, so it never fired once — BUG-03). Invoked by
 * .github/workflows/sla-escalate.yml every 30 minutes inside the Oman working
 * window (Vercel Hobby rejects sub-daily schedules; the keep-warm workflow set
 * the pattern). Bearer-authed with CRON_SECRET (lib/cron-auth.ts).
 *
 * Sweeps (all idempotent-claim guarded — a racing decision always wins):
 *  1. Level-1: SUBMITTED past slaDueAt at escalationLevel 0 → mark breached,
 *     ESCALATE audit, SLA_BREACH notifications to the escalation plan
 *     (lib/escalation.ts). Notifies only — never touches workflow state.
 *  2. Level-2: escalationLevel 1 rows past 2× the stage budget (working-hours
 *     calendar) → escalate one tier further.
 *  3. TEMIX_UPLOAD_READY debounce: queue non-empty ⇒ each Steward gets at
 *     most ONE unread ping per 24h — never one per approval.
 *  4. Notification GC: read rows older than 90 days, capped batch.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Role, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';
import { escalationPlan } from '@/lib/escalation';
import { parseChain } from '@/lib/approval-chains';
import {
  slaDeadline,
  STAGE_SLA_MINUTES,
  DEFAULT_STAGE_SLA_MIN,
  ESCALATION_MULTIPLIER,
} from '@/lib/working-hours';
import { TEMIX_QUEUE_WHERE } from '@/lib/temix';
import { notifyUsers } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BATCH = 200; // photo-gc batching precedent
const NOTIFICATION_GC_DAYS = 90;
const NOTIFICATION_GC_CAP = 500;

type DueEdit = Prisma.CustomerEditGetPayload<{
  include: {
    submittedBy: { select: { id: true } };
    customer: {
      select: {
        id: true;
        nmwcCode: true;
        legalName: true;
        branches: { select: { regionId: true } };
      };
    };
    customerDraft: { select: { legalName: true } };
    branchDrafts: { select: { route: { select: { regionId: true } } } };
  };
}>;

const DUE_INCLUDE = {
  submittedBy: { select: { id: true } },
  customer: {
    select: {
      id: true,
      nmwcCode: true,
      legalName: true,
      branches: { where: { deletedAt: null }, select: { regionId: true } },
    },
  },
  customerDraft: { select: { legalName: true } },
  branchDrafts: { select: { route: { select: { regionId: true } } } },
} as const;

function editRegionIds(e: DueEdit): string[] {
  const ids =
    e.process === 'CREATE'
      ? e.branchDrafts.map((b) => b.route.regionId)
      : (e.customer?.branches.map((b) => b.regionId) ?? []);
  return [...new Set(ids)];
}

function editName(e: DueEdit): string {
  return e.customer?.legalName ?? e.customerDraft?.legalName ?? '—';
}

/** Resolve the escalation plan to concrete user ids. */
async function resolveEscalationAudience(
  tx: Prisma.TransactionClient,
  e: DueEdit,
  level: 1 | 2
): Promise<string[]> {
  const plan = escalationPlan(e.pendingRole, level);
  const ids = new Set<string>();
  if (plan.regionScopedRoles.length > 0) {
    const regionIds = editRegionIds(e);
    const scoped = regionIds.length
      ? await tx.user.findMany({
          where: {
            role: { in: plan.regionScopedRoles },
            isActive: true,
            managedRegions: { some: { id: { in: regionIds } } },
          },
          select: { id: true },
        })
      : [];
    if (scoped.length > 0) {
      scoped.forEach((u) => ids.add(u.id));
    } else {
      // Fallback: no region manager exists — hand the breach to the GM (org
      // apex) rather than broadcasting the customer's name to every Manager
      // org-wide (which would cut against the RBAC-05-012 fail-closed
      // posture for unscoped Managers). A breach is still never unowned.
      // [Open — owner to confirm the escalation chain.]
      const gms = await tx.user.findMany({
        where: { role: Role.GM, isActive: true },
        select: { id: true },
      });
      gms.forEach((u) => ids.add(u.id));
    }
  }
  if (plan.globalRoles.length > 0) {
    const global = await tx.user.findMany({
      where: { role: { in: plan.globalRoles }, isActive: true },
      select: { id: true },
    });
    global.forEach((u) => ids.add(u.id));
  }
  return [...ids];
}

async function escalate(e: DueEdit, level: 1 | 2, now: Date): Promise<boolean> {
  // One transaction per row: the claim, the audit and the notifications
  // commit together — a transient failure rolls the claim back so the next
  // sweep retries, and a breach can never be marked escalated with zero
  // alerts written (adversarial-review fix).
  return prisma.$transaction(async (tx) => {
    // Idempotent claim (PROD-001 pattern), pinned on the SNAPSHOT's stage
    // identity AND a live breach re-check: an approve-advance/step-back
    // racing the sweep keeps state SUBMITTED but resets escalationLevel with
    // a fresh FUTURE slaDueAt — without these pins the claim would falsely
    // mark the brand-new stage breached and permanently skip its genuine
    // level-1 escalation (adversarial-review CONFIRMED fix).
    const claimed = await tx.customerEdit.updateMany({
      where: {
        id: e.id,
        state: 'SUBMITTED',
        escalationLevel: level - 1,
        currentStepIndex: e.currentStepIndex,
        cycle: e.cycle,
        slaDueAt: { lt: now },
      },
      data: {
        escalationLevel: level,
        lastEscalatedAt: now,
        ...(level === 1 ? { slaBreachedAt: now } : {}),
      },
    });
    if (claimed.count === 0) return false;
    const audience = await resolveEscalationAudience(tx, e, level);
    const stepLabel = (e.pendingRole ?? Role.SUPERVISOR).replace('_', ' ');
    await tx.auditLog.create({
      data: {
        // System sweep — no human actor exists; attributed to the submitter
        // with an explicit system reason so the audit record cannot read as
        // an action the salesman took. [Open — a dedicated system-actor user
        // is the cleaner long-term fix.]
        actorId: e.submittedById,
        action: 'ESCALATE',
        entityType: 'CustomerEdit',
        entityId: e.id,
        reason: 'system: sla-escalate sweep',
        after: {
          level,
          pendingRole: e.pendingRole,
          slaDueAt: e.slaDueAt?.toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await notifyUsers(tx, audience, {
      kind: 'SLA_BREACH',
      title: level === 1 ? 'SLA breached' : 'SLA breached — second escalation',
      body: `${editName(e)} — waiting on the ${stepLabel} step past its SLA${level === 2 ? ` (over ${ESCALATION_MULTIPLIER}× the budget)` : ''}.`,
      editId: e.id,
      customerId: e.customerId ?? undefined,
    });
    return true;
  });
}

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const now = new Date();

  // ── 1. Level-1 sweep ──
  let escalated = 0;
  let sweepErrors = 0;
  const due = await prisma.customerEdit.findMany({
    where: { state: 'SUBMITTED', slaDueAt: { lt: now }, escalationLevel: 0 },
    take: BATCH,
    orderBy: { slaDueAt: 'asc' },
    include: DUE_INCLUDE,
  });
  for (const e of due) {
    try {
      if (await escalate(e, 1, now)) escalated += 1;
    } catch (err) {
      // One row's transient failure must not abort the rest of the sweep —
      // its transaction rolled back, so the next run retries it.
      sweepErrors += 1;
      logger.warn({ editId: e.id, err: (err as Error).message?.slice(0, 120) }, 'cron.sla.row_failed');
    }
  }

  // ── 2. Level-2 sweep: past ESCALATION_MULTIPLIER × the stage budget.
  //       Budget comes from the row's FROZEN chain snapshot (same source that
  //       stamped slaDueAt) so an env override never retimes in-flight edits;
  //       rows without a chain (reactivations, deploy-gap) fall back to the
  //       env policy for their pendingRole. ──
  let level2 = 0;
  const l1 = await prisma.customerEdit.findMany({
    where: { state: 'SUBMITTED', escalationLevel: 1, stageEnteredAt: { not: null } },
    take: BATCH,
    orderBy: { slaDueAt: 'asc' },
    include: DUE_INCLUDE,
  });
  for (const e of l1) {
    const frozenStep = Array.isArray(e.approvalChain)
      ? parseChain(e.approvalChain)[e.currentStepIndex]
      : undefined;
    const budgetMin = frozenStep
      ? Math.round(frozenStep.slaHours * 60)
      : (STAGE_SLA_MINUTES[e.pendingRole ?? Role.SUPERVISOR] ?? DEFAULT_STAGE_SLA_MIN);
    const dueAt2 = slaDeadline(e.stageEnteredAt!, ESCALATION_MULTIPLIER * budgetMin);
    if (now <= dueAt2) continue;
    try {
      if (await escalate(e, 2, now)) level2 += 1;
    } catch (err) {
      sweepErrors += 1;
      logger.warn({ editId: e.id, err: (err as Error).message?.slice(0, 120) }, 'cron.sla.row_failed');
    }
  }

  // ── 3. Debounced TEMIX_UPLOAD_READY: each Steward gets at most one unread
  //       ping per 24h while the queue is non-empty. Check-and-insert runs
  //       under a per-steward advisory xact lock so two overlapping sweep
  //       invocations (GH Actions can double-fire) cannot double-ping. ──
  let temixPinged = 0;
  const queueCount = await prisma.customer.count({ where: TEMIX_QUEUE_WHERE });
  if (queueCount > 0) {
    const stewards = await prisma.user.findMany({
      where: { role: Role.STEWARD, isActive: true },
      select: { id: true },
    });
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    for (const s of stewards) {
      const pinged = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'nmwc:temix-ping:' + s.id}, 42))`;
        const recent = await tx.notification.findFirst({
          where: {
            userId: s.id,
            kind: 'TEMIX_UPLOAD_READY',
            OR: [{ readAt: null }, { createdAt: { gt: dayAgo } }],
          },
          select: { id: true },
        });
        if (recent) return false;
        await notifyUsers(tx, [s.id], {
          kind: 'TEMIX_UPLOAD_READY',
          title: 'Temix upload queue is waiting',
          body: `${queueCount} customer${queueCount === 1 ? ' is' : 's are'} queued for the next Temix batch.`,
        });
        return true;
      });
      if (pinged) temixPinged += 1;
    }
  }

  // ── 4. Notification GC: read rows older than 90 days, capped. ──
  const gcCutoff = new Date(now.getTime() - NOTIFICATION_GC_DAYS * 24 * 60 * 60 * 1000);
  const gcCandidates = await prisma.notification.findMany({
    where: { readAt: { not: null, lt: gcCutoff } },
    select: { id: true },
    take: NOTIFICATION_GC_CAP,
  });
  const gcDeleted = gcCandidates.length
    ? (await prisma.notification.deleteMany({
        where: { id: { in: gcCandidates.map((n) => n.id) } },
      })).count
    : 0;

  logger.info({ escalated, level2, temixPinged, gcDeleted, sweepErrors }, 'cron.sla_escalate');
  return NextResponse.json({ escalated, level2, temixPinged, gcDeleted, sweepErrors });
}

// B5: every finished run is recorded as a heartbeat (lib/heartbeat.ts); the
// bearer /api/health probe alarms when this job goes stale or never runs.
export const GET = withHeartbeat('sla-escalate', handle, (body) => Number(body?.sweepErrors ?? 0) === 0);
