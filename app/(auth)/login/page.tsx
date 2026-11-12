import { cookies } from 'next/headers';
import { LoginForm } from '@/components/nmwc/LoginForm';
import { SIGN_IN_ENDS_COOKIE, SIGN_IN_LIMIT_MESSAGE, signedOutByLimit } from '@/lib/sign-in-limit';

export const metadata = { title: 'Sign in · NMWC Customer Master' };

/**
 * A6: someone the 8-hour limit signed out lands here (every page sends a
 * signed-out person to /login) and is told why, in one sentence. The page knows
 * from the hint the last sign-in left (lib/sign-in-limit.ts SIGN_IN_ENDS_COOKIE):
 * its moment has passed. Sign out removes the hint, and a new sign-in replaces it.
 */
async function limitNotice(): Promise<string | null> {
  try {
    const hint = (await cookies()).get(SIGN_IN_ENDS_COOKIE)?.value;
    return signedOutByLimit(hint) ? SIGN_IN_LIMIT_MESSAGE : null;
  } catch {
    return null;
  }
}

export default async function LoginPage() {
  const notice = await limitNotice();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-brand-900">NMWC</h1>
          <p className="mt-1 text-sm text-slate-600">Customer Master</p>
        </div>
        <LoginForm notice={notice} />
      </div>
    </main>
  );
}
