'use server';

import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';

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

export async function createRegionAction(formData: FormData) {
  await requireManager();
  const parsed = regionSchema.safeParse({
    code: String(formData.get('code') ?? '').toUpperCase().trim(),
    name: String(formData.get('name') ?? '').trim(),
  });
  if (!parsed.success) {
    throw new ValidationError(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
  }
  await prisma.region.create({ data: parsed.data });
  revalidatePath('/routes');
}

export async function createRouteAction(formData: FormData) {
  await requireManager();
  const parsed = routeSchema.safeParse({
    code: String(formData.get('code') ?? '').toUpperCase().trim(),
    name: String(formData.get('name') ?? '').trim(),
    regionId: String(formData.get('regionId') ?? ''),
  });
  if (!parsed.success) {
    throw new ValidationError(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
  }
  await prisma.route.create({ data: parsed.data });
  revalidatePath('/routes');
}

export async function toggleRegionActiveAction(formData: FormData) {
  await requireManager();
  const id = String(formData.get('id') ?? '');
  const r = await prisma.region.findUnique({ where: { id } });
  if (!r) throw new ValidationError({ id: 'not found' });
  await prisma.region.update({ where: { id }, data: { isActive: !r.isActive } });
  revalidatePath('/routes');
}

export async function toggleRouteActiveAction(formData: FormData) {
  await requireManager();
  const id = String(formData.get('id') ?? '');
  const r = await prisma.route.findUnique({ where: { id } });
  if (!r) throw new ValidationError({ id: 'not found' });
  await prisma.route.update({ where: { id }, data: { isActive: !r.isActive } });
  revalidatePath('/routes');
}
