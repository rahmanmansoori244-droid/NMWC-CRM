'use server';

import { signIn, signOut } from '@/lib/auth';
import { AuthError } from 'next-auth';
import { z } from 'zod';
import { headers } from 'next/headers';
import { checkLimit, LOGIN_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const loginSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(1).max(200),
});

export type LoginResult = { ok: false; error: string };

export async function loginAction(formData: FormData): Promise<LoginResult | void> {
  const parsed = loginSchema.safeParse({
    username: formData.get('username'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Please enter your username and password.' };
  }

  // Rate-limit by username (auth-stuffing guard) and by IP if available
  const hdrs = await headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? hdrs.get('x-real-ip') ?? 'unknown';
  for (const key of [`login:user:${parsed.data.username}`, `login:ip:${ip}`]) {
    const lim = await checkLimit(key, LOGIN_LIMIT);
    if (!lim.ok) {
      logger.warn({ key, retryAfterSec: lim.retryAfterSec }, 'rate-limit.login');
      return {
        ok: false,
        error: `Too many attempts. Try again in ${lim.retryAfterSec}s.`,
      };
    }
  }

  try {
    await signIn('credentials', {
      username: parsed.data.username,
      password: parsed.data.password,
      redirectTo: '/home',
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, error: 'Invalid username or password.' };
    }
    // NEXT_REDIRECT must bubble up so Next.js performs the redirect.
    throw error;
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: '/login' });
}
