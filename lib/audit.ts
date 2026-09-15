/**
 * B-03: Centralised audit-log writer.
 *
 * Before this module, every `prisma.auditLog.create({...})` call across the
 * service layer left `ip` and `userAgent` as dead columns — the schema kept
 * the fields, but no caller populated them. Forensics couldn't tell which
 * device or which network produced any given action.
 *
 * `getAuditEnvelope(actorId)` reads the request headers exactly once per
 * server-action invocation (cheap — `headers()` is a request-scoped lookup)
 * and produces the `{ actorId, ip, userAgent }` envelope. `writeAudit(...)`
 * accepts a Prisma transaction client OR the top-level `prisma` so callers
 * inside `prisma.$transaction(...)` and outside both compose cleanly.
 *
 * userAgent is hard-capped at 500 chars so a pathological client that sends
 * megabytes in `User-Agent` cannot blow out the row size.
 */
import { headers } from 'next/headers';
import { prisma as defaultPrisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';

/** First IPv4/IPv6 from x-forwarded-for, fallback x-real-ip, else null. */
function pickIp(h: Headers): string | null {
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = h.get('x-real-ip');
  if (real && real.trim()) return real.trim();
  return null;
}

const UA_MAX = 500;

export type AuditEnvelope = {
  actorId: string;
  ip: string | null;
  userAgent: string | null;
};

/**
 * Read the current request's IP + userAgent and bundle them with `actorId`
 * into an envelope you can pass to `writeAudit(...)`. Returns null fields
 * when called outside a request scope (cron, tests).
 */
export async function getAuditEnvelope(actorId: string): Promise<AuditEnvelope> {
  try {
    const h = await headers();
    const ua = h.get('user-agent');
    return {
      actorId,
      ip: pickIp(h),
      userAgent: ua ? ua.slice(0, UA_MAX) : null,
    };
  } catch {
    // headers() throws when invoked outside a request (e.g. instrumentation,
    // background jobs). The audit write should still succeed with null
    // forensic fields rather than blow up the calling action.
    return { actorId, ip: null, userAgent: null };
  }
}

/**
 * Envelope for writes a background job makes on nobody's behalf (the SLA
 * escalation sweep). ip and userAgent are null BY CONSTRUCTION, not because a
 * header read failed.
 *
 * Do NOT use getAuditEnvelope here. A cron route handler IS a request scope, so
 * headers() succeeds and returns the scheduler's IP and user-agent — which
 * would be stamped onto a row whose actorId is the human submitter. A
 * fabricated forensic field is worse than an absent one.
 *
 * AuditLog.actorId is an FK to User, so a system write still has to name a real
 * accountable user; pair it with an explicit `reason: 'system: ...'` so the row
 * cannot be misread as an action that person took.
 *
 * Synchronous deliberately: with no headers() call this is the one envelope
 * that is safe to construct anywhere, including inside a transaction callback.
 */
export function systemAuditEnvelope(actorId: string): AuditEnvelope {
  return { actorId, ip: null, userAgent: null };
}

type AuditWriter = Prisma.TransactionClient | typeof defaultPrisma;

export type AuditParams = {
  action: Prisma.AuditLogCreateInput['action'];
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
};

/**
 * Write a single AuditLog row using the supplied envelope. Pass a Prisma
 * `tx` when called inside `prisma.$transaction(...)`, or the top-level
 * `prisma` (or omit, defaulting to it) for stand-alone writes.
 */
export async function writeAudit(
  tx: AuditWriter | null | undefined,
  env: AuditEnvelope,
  params: AuditParams
): Promise<void> {
  const client = tx ?? defaultPrisma;
  await client.auditLog.create({
    data: {
      actorId: env.actorId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before,
      after: params.after,
      reason: params.reason,
      ip: env.ip,
      userAgent: env.userAgent,
    },
  });
}
