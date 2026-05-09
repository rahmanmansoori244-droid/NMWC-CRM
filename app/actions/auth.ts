'use server';

import { auth, signIn, signOut } from '@/lib/auth';
import { AuthError } from 'next-auth';
import { z } from 'zod';
import { headers } from 'next/headers';
import { checkLimit, LOGIN_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';

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

  // AUTH-11: canonicalize username to lowercase before keying the rate-limit
  // bucket and the DB lookup so an attacker can't spread attempts across
  // case variants of the same account.
  const username = parsed.data.username.toLowerCase();

  // Rate-limit by username (auth-stuffing guard) and by IP if available.
  // AUTH-19: distinguish per-user vs per-IP exhaustion in the message — a
  // legitimate user whose account is being targeted from elsewhere should
  // see "account locked", not "too many attempts" (which they didn't make).
  const hdrs = await headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? hdrs.get('x-real-ip') ?? 'unknown';
  const userLim = await checkLimit(`login:user:${username}`, LOGIN_LIMIT);
  if (!userLim.ok) {
    logger.warn({ scope: 'user', retryAfterSec: userLim.retryAfterSec }, 'rate-limit.login');
    return {
      ok: false,
      error: 'Account temporarily locked due to repeated attempts. Try again in a minute.',
    };
  }
  const ipLim = await checkLimit(`login:ip:${ip}`, LOGIN_LIMIT);
  if (!ipLim.ok) {
    logger.warn({ scope: 'ip', retryAfterSec: ipLim.retryAfterSec }, 'rate-limit.login');
    return {
      ok: false,
      error: `Too many attempts from your network. Try again in ${ipLim.retryAfterSec}s.`,
    };
  }

  try {
    await signIn('credentials', {
      username,
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
  // AUTH-12: bump sessionsRevokedAt BEFORE clearing the cookie so a stolen
  // cookie cannot be replayed after logout. The JWT freshness loop in
  // lib/auth.ts compares each token's iat against this marker and rejects
  // anything older. The cookie clear is best-effort UX.
  try {
    const session = await auth();
    if (session?.user) {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { sessionsRevokedAt: new Date() },
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'logout.revoke_failed');
  }
  await signOut({ redirectTo: '/login' });
}
