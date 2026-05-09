'use server';

import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';

async function requireManager() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.MANAGER) {
    throw new ForbiddenError('Only Managers can manage users.');
  }
  return session.user;
}

const usernameRule = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-z0-9._-]+$/, 'lowercase letters, digits, dot, underscore, hyphen only');

const passwordRule = z
  .string()
  .min(12, 'Password must be at least 12 characters');

const createUserSchema = z.object({
  username: usernameRule,
  fullName: z.string().min(2).max(200),
  role: z.nativeEnum(Role),
  email: z.string().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().max(50).optional().or(z.literal('').transform(() => undefined)),
  password: passwordRule,
  supervisorId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),
  ownedRouteId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),
});

export async function createUserAction(formData: FormData) {
  const me = await requireManager();
  const parsed = createUserSchema.safeParse({
    username: formData.get('username'),
    fullName: formData.get('fullName'),
    role: formData.get('role'),
    email: formData.get('email') ?? undefined,
    phone: formData.get('phone') ?? undefined,
    password: formData.get('password'),
    supervisorId: formData.get('supervisorId') ?? undefined,
    ownedRouteId: formData.get('ownedRouteId') ?? undefined,
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError(fields);
  }
  const data = parsed.data;

  if (data.role === Role.SALESMAN && !data.ownedRouteId) {
    throw new ValidationError({ ownedRouteId: 'A salesman must be assigned to a route.' });
  }

  // Route uniqueness (1 salesman per route)
  if (data.ownedRouteId) {
    const existing = await prisma.user.findUnique({ where: { ownedRouteId: data.ownedRouteId } });
    if (existing) {
      throw new ValidationError({ ownedRouteId: 'That route is already assigned to another salesman.' });
    }
  }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({
    data: {
      username: data.username,
      passwordHash,
      fullName: data.fullName,
      role: data.role,
      email: data.email ?? null,
      phone: data.phone ?? null,
      supervisorId: data.supervisorId ?? null,
      ownedRouteId: data.ownedRouteId ?? null,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: me.id,
      action: 'CREATE',
      entityType: 'User',
      entityId: user.id,
      after: { username: user.username, role: user.role },
    },
  });
  logger.info({ actorId: me.id, userId: user.id, role: user.role }, 'user.create');

  revalidatePath('/users');
}

export async function toggleUserActiveAction(formData: FormData) {
  const me = await requireManager();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new ValidationError({ userId: 'required' });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ValidationError({ userId: 'not found' });
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { isActive: !user.isActive },
  });
  await prisma.auditLog.create({
    data: {
      actorId: me.id,
      action: 'UPDATE',
      entityType: 'User',
      entityId: userId,
      before: { isActive: user.isActive },
      after: { isActive: updated.isActive },
    },
  });
  revalidatePath('/users');
}

export async function resetPasswordAction(formData: FormData) {
  const me = await requireManager();
  const userId = String(formData.get('userId') ?? '');
  const newPassword = String(formData.get('password') ?? '');
  const parsed = passwordRule.safeParse(newPassword);
  if (!parsed.success) {
    throw new ValidationError({ password: parsed.error.issues[0]?.message ?? 'Invalid password' });
  }
  const passwordHash = await bcrypt.hash(parsed.data, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.auditLog.create({
    data: {
      actorId: me.id,
      action: 'UPDATE',
      entityType: 'User',
      entityId: userId,
      reason: 'password_reset',
    },
  });
  revalidatePath('/users');
}
