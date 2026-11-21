'use server';

/**
 * The daily Temix import, stage 4: the route map (TemixRouteMap). A Temix
 * route code that is not exactly a CRM Route.code reaches a CRM route only
 * through an entry here. The map STARTS EMPTY: the Data Steward enters each
 * entry from the owner's route master and its written rules for variant codes
 * (C10 beside C10MA). Nothing here makes an entry by itself, derives one from
 * a code's shape, or suggests a route.
 *
 * Append-only, as the table is: an entry is added (ADD), and later retired by a
 * new RETIRE row naming it; nothing is updated or deleted. A code has at most
 * one live entry (the database's temixroutemap_live_guard, under its advisory
 * lock, READ COMMITTED). Each write is one transaction under its own change
 * context with one AuditLog row (codes and ids; the reason stays on the entry,
 * which never changes).
 *
 * Writes nothing else: no route, shop, customer, staged row or file. The Check
 * reads the live entries the next time the preview is opened.
 */

import { revalidatePath } from 'next/cache';
import { AuditAction, Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { ForbiddenError, RateLimitError, ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { checkLimit } from '@/lib/rate-limit';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { src, withChangeContext } from '@/lib/change-context';
import { routeMapEntryRefusal, routeMapReasonRefusal } from '@/lib/temix-daily-route-map';
import { normalizeTemixCode } from '@/lib/temix-code';

async function requireSteward() {
  const user = await requireActor();
  if (user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can change the Temix route map.');
  }
  return user;
}

async function limit(userId: string) {
  const lim = await checkLimit(`temix-route-map:${userId}`, { capacity: 20, refillPerSec: 0.2 });
  if (!lim.ok) throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another change to the route map.`);
}

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

/**
 * The lock the database's guard takes for a code (nmwc_temix_route_map_guard),
 * taken first, so the check below reads the latest committed entry and a
 * second writer of the same code waits for the first.
 */
const lockKey = (code: string) => `TemixRouteMap:${code}`;

export async function addTemixRouteMapAction(formData: FormData): SafeAction<{ id: string; code: string }> {
  return runAction(async () => {
    const me = await requireSteward();
    await limit(me.id);
    const code = normalizeTemixCode(str(formData.get('code')));
    const routeId = str(formData.get('routeId')).trim();
    const reason = str(formData.get('reason')).trim();
    const reasonRefusal = routeMapReasonRefusal(reason);
    if (reasonRefusal) throw new ValidationError({ reason: reasonRefusal });
    const env = await getAuditEnvelope(me.id);

    const out = await withChangeContext(prisma, { actorId: me.id, source: src.temixRouteMap('add', code || '-') }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(code)}, 0))`;
      const routes = await tx.route.findMany({ select: { id: true, code: true, isActive: true } });
      const live = await tx.temixRouteMap.findFirst({
        where: { temixRouteCode: code, action: 'ADD', retiredBy: { is: null } },
        select: { id: true },
      });
      const refusal = routeMapEntryRefusal({ code, routeId, routes, hasLiveEntry: !!live });
      if (refusal) throw new ValidationError(refusal);
      const row = await tx.temixRouteMap.create({
        data: { temixRouteCode: code, action: 'ADD', routeId, reason, byId: me.id },
        select: { id: true },
      });
      await writeAudit(tx, env, {
        action: AuditAction.CREATE,
        entityType: 'TemixRouteMap',
        entityId: row.id.toString(),
        after: { kind: 'TEMIX_ROUTE_MAP_ADD', temixRouteCode: code, routeId },
      });
      return { id: row.id.toString(), code };
    });
    revalidatePath('/temix-daily/routes');
    return out;
  });
}

export async function retireTemixRouteMapAction(formData: FormData): SafeAction<{ id: string; code: string }> {
  return runAction(async () => {
    const me = await requireSteward();
    await limit(me.id);
    const idText = str(formData.get('id')).trim();
    if (!/^\d{1,18}$/.test(idText)) throw new ValidationError({ id: 'No route-map entry named.' });
    const reason = str(formData.get('reason')).trim();
    const reasonRefusal = routeMapReasonRefusal(reason);
    if (reasonRefusal) throw new ValidationError({ reason: reasonRefusal });
    const entryId = BigInt(idText);
    const entry = await prisma.temixRouteMap.findUnique({
      where: { id: entryId },
      select: { id: true, action: true, temixRouteCode: true, routeId: true },
    });
    if (!entry || entry.action !== 'ADD') throw new ValidationError({ id: 'That is not a route-map entry that can be retired.' });
    const code = entry.temixRouteCode;
    const env = await getAuditEnvelope(me.id);

    const out = await withChangeContext(prisma, { actorId: me.id, source: src.temixRouteMap('retire', code) }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(code)}, 0))`;
      const already = await tx.temixRouteMap.findFirst({ where: { retiresId: entryId }, select: { id: true } });
      if (already) throw new ValidationError({ id: `The entry for ${code} is already retired.` });
      const row = await tx.temixRouteMap.create({
        data: { temixRouteCode: code, action: 'RETIRE', retiresId: entryId, reason, byId: me.id },
        select: { id: true },
      });
      await writeAudit(tx, env, {
        action: AuditAction.CREATE,
        entityType: 'TemixRouteMap',
        entityId: row.id.toString(),
        after: { kind: 'TEMIX_ROUTE_MAP_RETIRE', temixRouteCode: code, retiresId: entryId.toString(), routeId: entry.routeId },
      });
      return { id: row.id.toString(), code };
    });
    revalidatePath('/temix-daily/routes');
    return out;
  });
}
