'use server';

import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';

/**
 * P2.2 (2026-05-10) — saved /customers filter views.
 *
 * A SavedView is a per-user named snapshot of the URL search params used on
 * the customers list (e.g. "region=…&channel=…&minScore=70"). Recall a view
 * by selecting it from the dropdown to navigate to `/customers?<urlParams>`.
 *
 * No sharing model yet — every view belongs to exactly one user, and the
 * delete check enforces caller-owns-the-view.
 */

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  return session.user;
}

const NAME_MIN = 2;
const NAME_MAX = 60;
// 4kB is plenty for any realistic filter URL but caps the column at a sane size.
const URL_PARAMS_MAX = 4000;
// Per-user cap so a careless click-spammer cannot fill the table.
const PER_USER_LIMIT = 50;

export type SavedViewRow = {
  id: string;
  name: string;
  urlParams: string;
  createdAt: Date;
};

/**
 * Server function (NOT a server action — must not be called from a form).
 * Returns the caller's saved views, newest first.
 */
export async function listSavedViewsForCurrentUser(): Promise<SavedViewRow[]> {
  const me = await requireUser();
  const rows = await prisma.savedView.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, urlParams: true, createdAt: true },
    take: PER_USER_LIMIT,
  });
  return rows;
}

export async function createSavedViewAction(
  formData: FormData
): SafeAction<{ id: string }> {
  return runAction(() => createSavedViewCore(formData));
}

async function createSavedViewCore(formData: FormData): Promise<{ id: string }> {
  const me = await requireUser();
  const name = String(formData.get('name') ?? '').trim();
  // Strip any leading "?" so callers can pass either the raw search part or
  // the prefixed form. Stored canonically without "?".
  const urlParamsRaw = String(formData.get('urlParams') ?? '').trim();
  const urlParams = urlParamsRaw.startsWith('?') ? urlParamsRaw.slice(1) : urlParamsRaw;

  const errors: Record<string, string> = {};
  if (name.length < NAME_MIN) errors.name = `Name must be at least ${NAME_MIN} characters.`;
  else if (name.length > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer.`;
  if (urlParams.length > URL_PARAMS_MAX) {
    errors.urlParams = 'Filter URL is too long.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  // Per-user cap: refuse to add when at the limit so the dropdown doesn't
  // become unmanageable.
  const existingCount = await prisma.savedView.count({ where: { userId: me.id } });
  if (existingCount >= PER_USER_LIMIT) {
    throw new ValidationError({
      _form: `You already have ${PER_USER_LIMIT} saved views. Delete one before saving another.`,
    });
  }

  const created = await prisma.savedView.create({
    data: { userId: me.id, name, urlParams },
    select: { id: true },
  });
  logger.info({ id: created.id, by: me.id }, 'savedView.create');
  revalidatePath('/customers');
  return { id: created.id };
}

export async function deleteSavedViewAction(formData: FormData): SafeAction<void> {
  return runAction(() => deleteSavedViewCore(formData));
}

async function deleteSavedViewCore(formData: FormData): Promise<void> {
  const me = await requireUser();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new ValidationError({ id: 'required' });

  const view = await prisma.savedView.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!view) throw new NotFoundError('Saved view not found.');
  // Caller-owns-the-view check. Stewards do NOT get a god-mode override here:
  // saved views are personal preferences, not master data.
  if (view.userId !== me.id) {
    throw new ForbiddenError('You can only delete your own saved views.');
  }
  await prisma.savedView.delete({ where: { id } });
  logger.info({ id, by: me.id }, 'savedView.delete');
  revalidatePath('/customers');
}
