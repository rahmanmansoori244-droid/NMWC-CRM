'use server';

import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { z } from 'zod';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

async function requireManager() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.MANAGER) {
    throw new ForbiddenError('Only Managers can manage routes.');
  }
  return session.user;
}

const codeRule = z.string().min(2).max(20).regex(/^[A-Z0-9_-]+$/, 'uppercase + digits + - or _');

const regionSchema = z.object({
  code: codeRule,
  name: z.string().min(2).max(100),
});
const routeSchema = z.object({
  code: codeRule,
  name: z.string().min(2).max(100),
  regionId: z.string().cuid(),
});

/**
 * B-17: every public Server Action goes through `runAction(...)` so a
 * thrown AppError is converted into a `{ ok: false, ... }` payload the
 * client form can render — instead of being stripped to "An error
 * occurred in the Server Components render…" by Next.js's RSC
 * serializer (see lib/errors.ts for the full rationale).
 *
 * Each mutating action now also writes a single AuditLog row via the
 * shared `writeAudit` helper, capturing actor + IP + UA. Previously
 * route/region mutations were silent in the audit trail.
 */

export async function createRegionAction(formData: FormData): SafeAction<void> {
  return runAction(() => createRegionCore(formData));
}

async function createRegionCore(formData: FormData) {
  const me = await requireManager();
  const parsed = regionSchema.safeParse({
    code: String(formData.get('code') ?? '').toUpperCase().trim(),
    name: String(formData.get('name') ?? '').trim(),
  });
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const region = await prisma.region.create({ data: parsed.data });
  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'CREATE',
    entityType: 'Region',
    entityId: region.id,
    after: { code: region.code, name: region.name },
  });
  revalidatePath('/routes');
}

export async function createRouteAction(formData: FormData): SafeAction<void> {
  return runAction(() => createRouteCore(formData));
}

async function createRouteCore(formData: FormData) {
  const me = await requireManager();
  const parsed = routeSchema.safeParse({
    code: String(formData.get('code') ?? '').toUpperCase().trim(),
    name: String(formData.get('name') ?? '').trim(),
    regionId: String(formData.get('regionId') ?? ''),
  });
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const route = await prisma.route.create({ data: parsed.data });
  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'CREATE',
    entityType: 'Route',
    entityId: route.id,
    after: { code: route.code, name: route.name, regionId: route.regionId },
  });
  revalidatePath('/routes');
}

export async function toggleRegionActiveAction(formData: FormData): SafeAction<void> {
  return runAction(() => toggleRegionActiveCore(formData));
}

async function toggleRegionActiveCore(formData: FormData) {
  const me = await requireManager();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new ValidationError({ id: 'required' });
  const r = await prisma.region.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Region not found.');
  const updated = await prisma.region.update({
    where: { id },
    data: { isActive: !r.isActive },
  });
  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'UPDATE',
    entityType: 'Region',
    entityId: id,
    before: { isActive: r.isActive },
    after: { isActive: updated.isActive },
    reason: updated.isActive ? 'enabled' : 'disabled',
  });
  revalidatePath('/routes');
}

export async function toggleRouteActiveAction(formData: FormData): SafeAction<void> {
  return runAction(() => toggleRouteActiveCore(formData));
}

async function toggleRouteActiveCore(formData: FormData) {
  const me = await requireManager();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new ValidationError({ id: 'required' });
  const r = await prisma.route.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Route not found.');
  const updated = await prisma.route.update({
    where: { id },
    data: { isActive: !r.isActive },
  });
  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'UPDATE',
    entityType: 'Route',
    entityId: id,
    before: { isActive: r.isActive },
    after: { isActive: updated.isActive },
    reason: updated.isActive ? 'enabled' : 'disabled',
  });
  revalidatePath('/routes');
}
