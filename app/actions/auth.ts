'use server';

import { signIn, signOut } from '@/lib/auth';
import { AuthError } from 'next-auth';
import { z } from 'zod';

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
